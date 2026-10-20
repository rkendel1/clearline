// The content model behind the landing page, the diagram and the assistant: references resolve, statuses are
// backed by evidence, and a status cannot be upgraded without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent, validateContent, STATUS_LABELS, resetContent, type Content } from '../../src/assistant/content.js';

const fresh = (): Content => { resetContent(); return structuredClone(loadContent()); };

test('the shipped content is internally consistent and every reference and evidence path exists', () => {
  assert.deepEqual(validateContent(loadContent()), []);
});

test('the diagram reflects the discovered components, not an aspirational set', () => {
  const c = loadContent();
  const ids = c.components.map((x) => x.id);
  for (const must of ['api', 'pipeline', 'query', 'analytics', 'postgres', 'reporting', 'evidence', 'delivery', 'retrieval', 'assistant', 'datatools']) assert.ok(ids.includes(must), must);
  // Things the specification's logical diagram has that the repository does not: no separate ML service, warehouse, queue or vector database.
  for (const absent of ['ml-service', 'warehouse', 'queue', 'vector-db', 'orchestrator']) assert.ok(!ids.includes(absent), absent);
  assert.equal(c.components.find((x) => x.id === 'datatools')!.status, 'planned');
  assert.ok(c.diagram.edges.some((e) => e.kind === 'retrieval') && c.diagram.edges.some((e) => e.kind === 'async'));
  assert.ok(c.diagram.boundaries.length >= 2);
});

test('capability statuses use only the four labels, and verified ones carry test evidence and a recorded result', () => {
  const c = loadContent();
  for (const k of c.capabilities) {
    assert.ok((STATUS_LABELS as readonly string[]).includes(k.status), k.id);
    if (k.status === 'Implemented and verified') { assert.ok(k.evidence.length > 0, k.id); assert.ok(k.verification.commit, k.id); }
    if (k.status === 'Planned') assert.equal(k.evidence.length, 0, k.id);
  }
  // Honest about what is not verified: the web client and the assistant are not "verified" by the recorded scenario run.
  assert.notEqual(c.capabilities.find((k) => k.id === 'web-client')!.status, 'Implemented and verified');
  assert.equal(c.capabilities.find((k) => k.id === 'assistant-data-tools')!.status, 'Planned');
});

test('validation rejects an upgraded status, a missing evidence file and a dangling reference', () => {
  const a = fresh(); a.capabilities.find((k) => k.id === 'assistant-data-tools')!.status = 'Implemented and verified';
  assert.ok(validateContent(a).some((p) => p.includes('assistant-data-tools')));
  const b = fresh(); b.capabilities[0].evidence.push({ type: 'test', path: 'test/does-not-exist.test.ts' });
  assert.ok(validateContent(b).some((p) => p.includes('missing evidence')));
  const c = fresh(); c.components[0].dependencies.push('nope');
  assert.ok(validateContent(c).some((p) => p.includes('unknown dependency')));
  const d = fresh(); d.decisions[0].alternatives = [];
  assert.ok(validateContent(d).some((p) => p.includes('incomplete')));
  const e = fresh(); e.capabilities[0].status = 'Verified!' as never;
  assert.ok(validateContent(e).some((p) => p.includes('invalid status')));
});

test('every required decision topic exists with alternatives, costs and a revisit condition, and never invents a history', () => {
  const c = loadContent();
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].filter((l) => !c.decisions.some((d) => d.letter === l)), []);
  for (const d of c.decisions) { assert.match(d.rationale_note, /Current rationale/); assert.ok(d.alternatives.length && d.costs.length && d.revisit_when); }
});

test('every actor group from the specification is present', () => {
  const c = loadContent();
  assert.deepEqual(c.actors.map((a) => a.id).sort(), ['analyst', 'architect', 'data-engineer', 'leader', 'ml-engineer', 'ops']);
});
