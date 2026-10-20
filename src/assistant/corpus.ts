// The approved retrieval corpus: an explicit allow-list, never a directory crawl. Every chunk carries its
// source, heading, content hash, access class and a destination a visitor can open. Secrets, environment
// files, source code and generated data dictionaries are not eligible.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent, repoRoot, type Content } from './content.js';

export type Access = 'public' | 'authenticated';
export type Dest =
  | { kind: 'component' | 'decision' | 'capability' | 'actor'; id: string }
  | { kind: 'section'; id: string }
  | { kind: 'source'; path: string };
export interface Chunk {
  id: string; source: string; source_type: 'content' | 'adr' | 'doc'; title: string; heading: string; text: string; hash: string; access: Access; dest: Dest; refs: string[];
}

/** Markdown sources approved for the assistant. `authenticated` documents are only retrieved for signed-in users. */
/** `indexed: false` documents can be opened from a link but are not retrieved (the evaluation page quotes the evaluation questions; indexing it would contaminate the measurement). */
export const DOC_ALLOWLIST: { path: string; access: Access; type: 'adr' | 'doc'; indexed?: boolean }[] = [
  { path: 'README.md', access: 'public', type: 'doc' },
  { path: 'docs/architecture.md', access: 'public', type: 'doc' },
  { path: 'docs/architecture-inventory.md', access: 'public', type: 'doc' },
  { path: 'docs/contracts.md', access: 'public', type: 'doc' },
  { path: 'docs/metrics.md', access: 'public', type: 'doc' },
  { path: 'docs/query-workspace.md', access: 'public', type: 'doc' },
  { path: 'docs/saved-analytics.md', access: 'public', type: 'doc' },
  { path: 'docs/scale-out.md', access: 'public', type: 'doc' },
  { path: 'docs/threat-model.md', access: 'public', type: 'doc' },
  { path: 'docs/production-readiness.md', access: 'public', type: 'doc' },
  { path: 'docs/test-results.md', access: 'public', type: 'doc' },
  { path: 'docs/benchmark.md', access: 'public', type: 'doc' },
  { path: 'docs/assistant-evaluation.md', access: 'public', type: 'doc', indexed: false },
  { path: 'docs/adr/README.md', access: 'public', type: 'adr' },
  ...Array.from({ length: 18 }, (_, i) => `docs/adr/${String(i + 1).padStart(4, '0')}-`).map((p) => ({ path: p, access: 'public' as Access, type: 'adr' as const })),
  { path: 'docs/runbook.md', access: 'authenticated', type: 'doc' },
  { path: 'docs/deployment.md', access: 'authenticated', type: 'doc' },
];

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';
const MAX = 1400;

function resolveAllowed(): { path: string; access: Access; type: 'adr' | 'doc'; indexed?: boolean }[] {
  const root = repoRoot();
  const out: { path: string; access: Access; type: 'adr' | 'doc'; indexed?: boolean }[] = [];
  for (const e of DOC_ALLOWLIST) {
    if (e.path.endsWith('-')) {                       // ADR numbers: resolve the file by prefix
      const dir = join(root, 'docs', 'adr');
      if (!existsSync(dir)) continue;
      const f = readdirSync(dir).find((n) => n.startsWith(e.path.split('/').pop()!) && n.endsWith('.md'));
      if (f) out.push({ ...e, path: `docs/adr/${f}` });
    } else if (existsSync(join(root, e.path))) out.push(e);
  }
  return out;
}

export function isApprovedSource(path: string): { access: Access } | null {
  const hit = resolveAllowed().find((e) => e.path === path);
  return hit ? { access: hit.access } : null;
}
export function readApprovedSource(path: string): string | null {
  return isApprovedSource(path) ? readFileSync(join(repoRoot(), path), 'utf8') : null;
}

/** Split markdown by headings, then by paragraphs to a size budget. Diagram fences are dropped. */
export function chunkMarkdown(source: string, md: string, access: Access, type: 'adr' | 'doc'): Chunk[] {
  const text = md.replace(/```mermaid[\s\S]*?```/g, '');
  const lines = text.split('\n');
  const title = (lines.find((l) => /^# /.test(l)) ?? `# ${source}`).replace(/^# /, '').trim();
  const sections: { heading: string; body: string[] }[] = [{ heading: title, body: [] }];
  const path: string[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^```/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{2,4}) (.+)/.exec(l);
    if (m) { path.length = m[1].length - 2; path[m[1].length - 2] = m[2].trim(); sections.push({ heading: path.filter(Boolean).join(' › '), body: [] }); }
    else sections[sections.length - 1].body.push(l);
  }
  const out: Chunk[] = [];
  for (const s of sections) {
    const body = s.body.join('\n').trim();
    if (body.length < 40) continue;
    const parts: string[] = [];
    let cur = '';
    for (const para of body.split(/\n{2,}/)) {
      if (cur && cur.length + para.length > MAX) { parts.push(cur); cur = ''; }
      cur += (cur ? '\n\n' : '') + para;
    }
    if (cur) parts.push(cur);
    parts.forEach((p, i) => {
      const t = p.length > MAX * 1.6 ? p.slice(0, Math.floor(MAX * 1.6)) : p;
      out.push({ id: `${source}#${slug(s.heading)}${parts.length > 1 ? `-${i + 1}` : ''}`, source, source_type: type, title, heading: s.heading, text: t, hash: sha(t), access, dest: { kind: 'source', path: source }, refs: [] });
    });
  }
  // Disambiguate repeated headings.
  const seen = new Map<string, number>();
  for (const c of out) { const n = (seen.get(c.id) ?? 0) + 1; seen.set(c.id, n); if (n > 1) c.id = `${c.id}~${n}`; }
  return out;
}

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** Chunks derived from the structured content, so landing page and assistant share one source of truth. */
export function contentChunks(c: Content): Chunk[] {
  const mk = (id: string, title: string, heading: string, text: string, dest: Dest, refs: string[] = []): Chunk =>
    ({ id: `content/${id}`, source: `content/${id.split('/')[0]}`, source_type: 'content', title, heading, text, hash: sha(text), access: 'public', dest, refs });
  const out: Chunk[] = [];
  for (const k of c.components) {
    out.push(mk(`components/${k.id}`, `Component: ${k.name}`, k.name,
      `${k.name} (${k.layer}; status: ${k.status}). ${k.summary}\nResponsibility: ${k.responsibility}\nInputs: ${k.inputs.join('; ') || 'none'}. Outputs: ${k.outputs.join('; ') || 'none'}.\nData: ${k.data}\nSecurity boundary: ${k.security}\nFailure modes:\n${list(k.failure_modes)}\nWhy it exists: ${k.why}`,
      { kind: 'component', id: k.id }, [k.id, ...k.decisions]));
  }
  for (const k of c.capabilities) {
    out.push(mk(`capabilities/${k.id}`, `Capability: ${k.name}`, k.name,
      `${k.name}. Status: ${k.status}. ${k.description}\nWhy it matters: ${k.business_value}\nExample: ${k.use_case}\nEvidence: scenarios ${k.scenarios.join(', ') || 'none'}; tests ${k.evidence.map((e) => e.path).join(', ') || 'none'}. ${k.verification.note}\nLimitations:\n${list(k.limitations)}`,
      { kind: 'capability', id: k.id }, [k.id]));
  }
  for (const d of c.decisions) {
    out.push(mk(`decisions/${d.id}`, `Decision ${d.letter}: ${d.title}`, `${d.title}: decision and context`,
      `${d.title}. ${d.rationale_note}\nContext: ${d.context}\nChosen approach: ${d.decision}\nAlternatives considered: ${d.alternatives.join('; ')}.`, { kind: 'decision', id: d.id }, [d.id, ...d.components]));
    out.push(mk(`decisions/${d.id}/tradeoffs`, `Decision ${d.letter}: ${d.title}`, `${d.title}: tradeoffs`,
      `${d.title}: advantages:\n${list(d.advantages)}\nCosts and disadvantages:\n${list(d.costs)}\nRisks and mitigations:\n${list(d.risks)}\nRevisit when: ${d.revisit_when}\nEvidence: ${d.implementation_evidence.join('; ')}.`, { kind: 'decision', id: d.id }, [d.id, ...d.components]));
  }
  for (const a of c.actors) out.push(mk(`actors/${a.id}`, `Actor: ${a.name}`, a.name, `${a.name}. Goal: ${a.goal}\nTypical questions:\n${list(a.questions)}`, { kind: 'actor', id: a.id }, [a.id]));
  out.push(mk('site/problems', 'Why this matters', 'Problems the architecture addresses', c.site.problems.map((p) => `${p.title}: ${p.body}`).join('\n'), { kind: 'section', id: 'why' }));
  out.push(mk('site/limitations', 'Limitations', 'Known limitations and production considerations', `${list(c.site.limitations)}`, { kind: 'section', id: 'limits' }));
  out.push(mk('site/scenarios', 'Demonstration scenarios', 'Recorded demonstration scenarios',
    c.site.scenarios.map(([l, n, d]) => `Scenario ${l}, ${n}: ${d}`).join('\n') + `\nThese were recorded from one clean clone at commit ${c.site.recorded_commit}.`, { kind: 'section', id: 'scenarios' }));
  return out;
}

export function buildCorpus(): { chunks: Chunk[]; version: string } {
  const chunks = [...contentChunks(loadContent())];
  for (const e of resolveAllowed().filter((x) => x.indexed !== false)) chunks.push(...chunkMarkdown(e.path, readFileSync(join(repoRoot(), e.path), 'utf8'), e.access, e.type));
  const ids = new Set<string>();
  for (const c of chunks) { if (ids.has(c.id)) throw new Error(`duplicate chunk id ${c.id}`); ids.add(c.id); }
  return { chunks, version: sha(chunks.map((c) => `${c.id}:${c.hash}`).sort().join('|')) };
}
