// Unit tests: contract validation (structural + semantic), migration planning,
// and deterministic storage generation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../../src/contracts/validate.js';
import { planMigration } from '../../src/contracts/diff.js';
import { contractHash, createEntityTableDDL, transformVersion, viewsDDL } from '../../src/contracts/compile.js';
import type { Contract } from '../../src/contracts/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (t: string, f: string): Contract => JSON.parse(readFileSync(path.join(ROOT, 'contracts', t, f), 'utf8'));
const issues = (doc: unknown) => { const r = validateContract(doc); return r.ok ? [] : r.issues.map((i) => `${i.path} ${i.message}`); };
const mutate = (fn: (c: any) => void) => { const c = structuredClone(load('bluefin', 'v1.json')) as any; fn(c); return c; };

test('every shipped contract is valid', () => {
  for (const [t, f] of [['northwind', 'v1.json'], ['northwind', 'v2.json'], ['northwind', 'v2-unsafe.json'], ['bluefin', 'v1.json']]) {
    assert.deepEqual(issues(load(t, f)), [], `${t}/${f}`);
  }
});

test('structural validation rejects unknown properties and unsupported declarations', () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ['arbitrary code transform', (c) => { c.sources.bf_rx_claims_csv.mappings[0].transforms = [{ op: 'javascript', code: 'x' }]; }, /transforms/],
    ['regex transform', (c) => { c.sources.bf_rx_claims_csv.mappings[0].transforms = [{ op: 'regex_replace', pattern: '.*' }]; }, /transforms/],
    ['unsupported field type', (c) => { c.entities.rx_claim.fields.ndc.type = 'json'; }, /type/],
    ['raw SQL in a filter', (c) => { c.outputs.metrics[0].filter = { sql: '1=1' }; }, /filter/],
    ['unknown top-level property', (c) => { c.hooks = { on_load: 'curl evil' }; }, /"hooks" is not a supported property/],
    ['identifier injection in entity name', (c) => { c.entities['x"; DROP TABLE y; --'] = c.entities.rx_claim; }, /entities/],
    ['bad semver', (c) => { c.version = 'v2'; }, /version/],
  ];
  for (const [name, fn, re] of cases) {
    const got = issues(mutate(fn));
    assert.ok(got.length > 0, `${name} must be rejected`);
    assert.ok(got.some((g) => re.test(g)), `${name}: ${got.join(' | ')}`);
  }
});

test('semantic validation catches cross-reference and type errors with precise paths', () => {
  const cases: [string, (c: any) => void, string][] = [
    ['mapping to unknown field', (c) => { c.sources.bf_rx_claims_csv.mappings[0].target = 'nope'; }, '/sources/bf_rx_claims_csv/mappings/0/target entity "rx_claim" has no field "nope"'],
    ['parse not last', (c) => { c.sources.bf_rx_claims_csv.mappings.find((m: any) => m.target === 'fill_date').transforms.push({ op: 'trim' }); }, 'must be the last transform'],
    ['parse/type mismatch', (c) => { c.sources.bf_rx_claims_csv.mappings.find((m: any) => m.target === 'fill_date').transforms = [{ op: 'parse_decimal' }]; }, 'incompatible with field type "date"'],
    ['sum over text', (c) => { c.outputs.metrics.find((m: any) => m.aggregation === 'sum').field = 'ndc'; }, 'requires a numeric field'],
    ['ordered op on enum', (c) => { c.outputs.metrics[1].filter = { field: 'claim_state', op: 'gt', value: 'APPROVED' }; }, 'operator gt is not valid for enum'],
    ['bad enum literal', (c) => { c.outputs.metrics[1].filter = { field: 'claim_state', op: 'eq', value: 'APPROVD' }; }, 'literal is not a valid enum'],
    ['nullable key', (c) => { c.entities.rx_claim.fields.claim_number.nullable = true; }, 'must be required and nullable: false'],
    ['relationship to non-key', (c) => { c.entities.rx_claim.relationships[0].references.field = 'plan_id'; }, 'must reference the single key field'],
    ['control total not numeric', (c) => { c.sources.bf_rx_claims_csv.control_totals.sum_fields = ['ndc']; }, 'must be numeric'],
    ['required field unmapped', (c) => { c.sources.bf_rx_claims_csv.mappings = c.sources.bf_rx_claims_csv.mappings.filter((m: any) => m.target !== 'claim_number'); }, 'required field "rx_claim.claim_number" has no mapping'],
    ['decimal filterable', (c) => { c.outputs.extracts[0].filterable = ['plan_cost']; }, 'is not filterable'],
    ['order_by on decimal', (c) => { c.entities.rx_claim.correction = { strategy: 'supersede_by_order', order_by: 'plan_cost' }; }, 'order_by must be an integer, date or timestamp field'],
  ];
  for (const [name, fn, want] of cases) {
    const got = issues(mutate(fn));
    assert.ok(got.some((g) => g.includes(want)), `${name}: expected "${want}" in ${JSON.stringify(got)}`);
  }
});

test('migration plan classifies changes and refuses unsafe ones', () => {
  const v1 = load('northwind', 'v1.json'), v2 = load('northwind', 'v2.json'), bad = load('northwind', 'v2-unsafe.json');
  const p = planMigration('northwind', v1, v2);
  assert.equal(p.classification, 'requires_approval');
  assert.equal(planMigration('northwind', v1, bad).classification, 'rejected');

  const minor = structuredClone(v1); minor.version = '1.1.0';
  minor.entities.claim.fields.note = { type: 'string', sensitivity: 'internal' };
  const pm = planMigration('northwind', v1, minor);
  assert.equal(pm.classification, 'compatible');
  assert.deepEqual(pm.ddl, ['ALTER TABLE "t_northwind"."claim" ADD COLUMN IF NOT EXISTS "note" text']);

  const sameMajor = structuredClone(v2); sameMajor.version = '1.5.0';
  assert.ok(planMigration('northwind', v1, sameMajor).rejected_reasons.some((r) => /major version increment/.test(r)));
  const older = structuredClone(minor); older.version = '0.9.0';
  assert.ok(planMigration('northwind', v1, older).rejected_reasons.some((r) => /must be greater/.test(r)));

  const keyChange = structuredClone(v1); keyChange.version = '2.0.0'; keyChange.entities.claim.key = ['claim_id', 'member_id'];
  assert.equal(planMigration('northwind', v1, keyChange).classification, 'rejected');

  const narrow = structuredClone(v1); narrow.version = '2.0.0'; narrow.entities.claim.fields.paid_amount.scale = 1;
  assert.equal(planMigration('northwind', v1, narrow).classification, 'rejected');

  const widen = structuredClone(v1); widen.version = '1.2.0'; widen.entities.claim.fields.paid_amount.precision = 16;
  assert.equal(planMigration('northwind', v1, widen).classification, 'compatible');

  const unhide = structuredClone(v1); unhide.version = '2.0.0'; unhide.entities.member.fields.ssn.sensitivity = 'internal';
  const pu = planMigration('northwind', v1, unhide);
  assert.ok(pu.changes.some((c) => c.kind === 'sensitivity_lowered' && c.classification === 'breaking'), 'lowering sensitivity always needs review');
});

test('storage generation is deterministic and quotes every identifier', () => {
  const c = load('bluefin', 'v1.json');
  assert.equal(contractHash(c), contractHash(structuredClone(c)));
  const rev = (v: unknown): unknown => Array.isArray(v) ? v.map(rev) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, rev((v as Record<string, unknown>)[k])])) : v;
  const reordered = rev(c) as Contract;
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(c));
  assert.equal(contractHash(reordered), contractHash(c), 'key order does not change identity');
  assert.match(transformVersion(c), /^engine@1\.0\.0\+contract@1\.0\.0#[0-9a-f]{12}$/);
  const ddl = createEntityTableDDL('bluefin', 'rx_claim', c.entities.rx_claim).join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS "t_bluefin"\."rx_claim"/);
  assert.match(ddl, /"plan_cost" numeric\(11,2\)/);
  const views = viewsDDL('bluefin', c).join('\n');
  assert.ok(views.includes('"rpt_enrollee"'));
  const rpt = viewsDDL('bluefin', c).find((s) => s.startsWith('CREATE VIEW "t_bluefin"."rpt_enrollee"'))!;
  for (const f of ['full_name', 'birth_date', 'email']) assert.ok(!rpt.includes(`"${f}"`), `${f} excluded from reporting view`);
});
