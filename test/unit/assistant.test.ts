// Assistant building blocks that need no database or model: routing, chunking, the corpus allow-list,
// request validation, the rate limiter and destination validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../src/assistant/router.js';
import { RateLimiter } from '../../src/assistant/limiter.js';
import { buildCorpus, chunkMarkdown, DOC_ALLOWLIST, isApprovedSource, readApprovedSource } from '../../src/assistant/corpus.js';
import { parseAsk } from '../../src/assistant/routes.js';
import { retrievalQuery, validDest } from '../../src/assistant/answer.js';
import { loadContent } from '../../src/assistant/content.js';
import { getEmbedder, resetEmbedder } from '../../src/assistant/embed.js';

test('routing: design questions go to retrieval, number questions to the (planned) data path, specific results to interpretation', () => {
  const cases: [string, string][] = [
    ['Why does Clearline use PostgreSQL?', 'architecture'], ['Where is authorization enforced?', 'architecture'], ['How does reconciliation decide trust?', 'architecture'],
    ['What can I do in the demo?', 'capability'], ['Which scenarios are working?', 'capability'], ['Is scheduling implemented?', 'capability'],
    ['What was the rejection rate last week?', 'data'], ['How many claims were quarantined last month?', 'data'], ['What is the total paid amount?', 'data'],
    ['Is this change unusual?', 'interpretation'], ['What evidence supports this anomaly?', 'interpretation'],
    ['How does the anomaly algorithm work?', 'architecture'], ['', 'unsupported'],
  ];
  for (const [q, want] of cases) assert.equal(classify(q), want, q);
});

test('rate limiter: per-client and global windows, with retry hints', () => {
  const l = new RateLimiter(3, 5, 1000);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(l.check('a', t0 + i).ok, true);
  const r = l.check('a', t0 + 10); assert.equal(r.ok, false); assert.ok(!r.ok && r.scope === 'client' && r.retryAfterS >= 1);
  assert.equal(l.check('b', t0 + 20).ok, true); assert.equal(l.check('b', t0 + 21).ok, true);
  const g = l.check('c', t0 + 22); assert.ok(!g.ok && g.scope === 'global');
  assert.equal(l.check('a', t0 + 1500).ok, true, 'window slides');
});

test('markdown chunking keeps headings and source ids, drops diagram fences and respects the size budget', () => {
  const md = '# Title\n\nintro text that is long enough to keep as its own chunk in the index.\n\n## Part A\n\n```mermaid\nflowchart LR\n A-->B\n```\n\nAlpha paragraph with enough words to be retained by the chunker.\n\n## Part A\n\nDuplicate heading with other text that is also long enough to retain.\n\n### Deep\n\n' + 'word '.repeat(900);
  const chunks = chunkMarkdown('docs/x.md', md, 'public', 'doc');
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.source === 'docs/x.md' && c.title === 'Title' && c.hash.length === 16 && c.text.length <= 2300));
  assert.ok(!chunks.some((c) => c.text.includes('flowchart')));
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length, 'ids are unique even for repeated headings');
  assert.ok(chunks.some((c) => c.heading === 'Part A › Deep' || c.heading.endsWith('Deep')));
});

test('the corpus is an allow-list: no secrets, no code, no generated data dictionary, restricted docs flagged', () => {
  const { chunks, version } = buildCorpus();
  assert.ok(chunks.length > 150 && version.length === 16);
  const sources = new Set(chunks.map((c) => c.source));
  for (const bad of ['.env', '.env.local', 'docs/data-dictionary.md', 'src/api/server.ts', 'docker-compose.yml']) assert.ok(!sources.has(bad), bad);
  assert.ok(![...sources].some((s) => /^(src|test|native|scripts|db)\//.test(s)));
  for (const c of chunks) assert.ok(!/sk-ant-[A-Za-z0-9_-]{10,}/.test(c.text) && !/ANTHROPIC_API_KEY\s*=\s*[A-Za-z0-9_-]{8,}/.test(c.text) && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c.text), `secret-like text in ${c.id}`);
  const restricted = chunks.filter((c) => c.access === 'authenticated');
  assert.ok(restricted.length > 0 && restricted.every((c) => c.source === 'docs/runbook.md' || c.source === 'docs/deployment.md'));
  assert.ok(chunks.filter((c) => c.source_type === 'content').every((c) => c.access === 'public'));
  assert.deepEqual(DOC_ALLOWLIST.filter((e) => e.access === 'authenticated').map((e) => e.path).sort(), ['docs/deployment.md', 'docs/runbook.md']);
});

test('approved sources: only allow-listed paths can be read; traversal and unknown paths are refused', () => {
  assert.ok(isApprovedSource('docs/architecture.md'));
  assert.equal(isApprovedSource('docs/runbook.md')!.access, 'authenticated');
  for (const p of ['.env.local', '../etc/passwd', 'docs/../.env', 'src/api/server.ts', 'docs/data-dictionary.md', 'docs/adr/', '']) { assert.equal(isApprovedSource(p), null, p); assert.equal(readApprovedSource(p), null, p); }
  assert.match(readApprovedSource('docs/adr/0002-postgres-as-queue.md')!, /durable work queue/);
});

test('request validation: bounded, typed, and unknown context ids are dropped rather than echoed', () => {
  const ok = parseAsk({ message: ' Why PostgreSQL? ', history: [{ role: 'user', text: 'hi' }], context: { component: 'postgres', capability: 'nope', view: 'query', page: 'landing' } });
  assert.equal(ok.message, 'Why PostgreSQL?'); assert.equal(ok.context.component, 'postgres'); assert.equal(ok.context.capability, undefined); assert.equal(ok.context.view, 'query');
  for (const bad of [{}, { message: '' }, { message: 5 }, { message: 'x'.repeat(1001) }, { message: 'x', history: 'no' }, { message: 'x', history: Array(13).fill({ role: 'user', text: 'a' }) }, { message: 'x', history: [{ role: 'system', text: 'a' }] }, { message: 'x', history: [{ role: 'user', text: 'a'.repeat(2001) }] }])
    assert.throws(() => parseAsk(bad), /invalid_parameter|must|required|longer|history/i, JSON.stringify(bad).slice(0, 40));
  assert.equal(parseAsk({ message: 'x', context: { view: 'javascript:alert(1)', component: '../x' } }).context.view, undefined);
});

test('destinations are validated against the content model: no arbitrary URLs or paths', () => {
  const c = loadContent();
  assert.ok(validDest({ kind: 'component', id: 'api' }, c)); assert.ok(validDest({ kind: 'section', id: 'decisions' }, c)); assert.ok(validDest({ kind: 'source', path: 'docs/architecture.md' }, c));
  for (const d of [{ kind: 'component', id: 'nope' }, { kind: 'section', id: 'admin' }, { kind: 'source', path: '../.env' }, { kind: 'source', path: 'https://evil.example/x.md' }, { kind: 'source', path: 'docs/../../x.md' }, { kind: 'url', href: 'https://evil.example' }] as never[])
    assert.equal(validDest(d, c), false, JSON.stringify(d));
});

test('follow-up questions borrow the previous turn and page context', () => {
  const c = loadContent();
  const q = retrievalQuery({ message: 'and why?', history: [{ role: 'user', text: 'Explain the scheduler' }, { role: 'assistant', text: '...' }], context: { component: 'analytics' }, audience: 'public' }, c);
  assert.match(q, /scheduler/i); assert.match(q, /Analytics and scheduler/);
  assert.equal(retrievalQuery({ message: 'Why does the database hold the queue and the reports together?', history: [{ role: 'user', text: 'earlier' }], context: {}, audience: 'public' }, c).includes('earlier'), false);
});

test('the hash embedder is deterministic, normalised and lexically related; the index never silently mixes providers', async () => {
  process.env.EMBEDDING_PROVIDER = 'hash'; resetEmbedder();
  const e = getEmbedder();
  const [a, b, c] = await e.embed(['PostgreSQL work queue lease', 'the queue in PostgreSQL uses a lease', 'cluster centroid silhouette']);
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-6); assert.ok(dot(a, b) > dot(a, c));
  assert.deepEqual((await e.embed(['PostgreSQL work queue lease']))[0], a);
  assert.equal(e.id, 'hash'); assert.equal(e.dim, 384);
  delete process.env.EMBEDDING_PROVIDER; resetEmbedder();
});
