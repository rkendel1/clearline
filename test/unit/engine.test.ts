// Unit tests: row transformation, three-valued rule logic, sensitive-data
// detection, source adapters, batch reconciliation and log safety.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformRow, recordHash, canonicalKey } from '../../src/transform/engine.js';
import { evaluate } from '../../src/transform/conditions.js';
import { detectSensitiveValue, isSuspiciousColumnName } from '../../src/quality/sensitive.js';
import { parseCsv, parseJsonRecords, StructuralError } from '../../src/ingestion/adapters/index.js';
import { reconcileBatch } from '../../src/reconciliation/batch.js';
import { createLogger } from '../../src/platform/logger.js';
import type { Contract } from '../../src/contracts/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NW: Contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts/northwind/v1.json'), 'utf8'));
const BF: Contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts/bluefin/v1.json'), 'utf8'));
const ctx = { arrivalDate: '2026-10-01', arrivalTs: '2026-10-01T12:00:00.000Z' };
const claim = { CLM_ID: ' c1 ', MBR_ID: 'NW0000001', RENDERING_NPI: '1234567890', SVC_DT: '2026-09-01', RCVD_DT: '2026-09-05', DX_CD: 'E11.9', PROC_CD: '99213',
  BILLED_AMT: '100.00', ALLOWED_AMT: '80.00', PAID_AMT: '60.00', CLM_STATUS: 'P', ADJ_SEQ: '1' };
const run = (c: Contract, src: string, row: Record<string, string | null>) => transformRow(c, src, row, ctx, new Set(Object.keys(row)));

test('a valid row is canonicalised deterministically', () => {
  const a = run(NW, 'nw_medical_claims_csv', claim);
  assert.deepEqual(a.errors, []);
  assert.equal(a.key, 'C1');
  assert.equal(a.values.paid_amount, '60.00');
  assert.equal(a.values.status, 'PAID');
  assert.equal(a.values.adjudication_seq, 1);
  const b = run(NW, 'nw_medical_claims_csv', { ...claim });
  assert.equal(a.hash, b.hash, 'same input + contract => same hash');
  assert.notEqual(run(NW, 'nw_medical_claims_csv', { ...claim, PAID_AMT: '60.01' }).hash, a.hash);
});

test('structural errors suppress business rules; business rules name the rule', () => {
  const s = run(NW, 'nw_medical_claims_csv', { ...claim, SVC_DT: '2026-02-30', PAID_AMT: '999.00' });
  assert.ok(s.errors.some((e) => e.rule_id === 'type:service_date' && e.category === 'structural'));
  assert.ok(!s.errors.some((e) => e.category === 'business_rule'), 'no rule noise on structurally broken rows');
  assert.equal(s.hash, null);
  const b = run(NW, 'nw_medical_claims_csv', { ...claim, PAID_AMT: '150.00' });
  assert.deepEqual(b.errors.map((e) => e.rule_id), ['rule:paid_le_billed']);
  assert.ok(b.findings.some((f) => f.rule_id === 'rule:allowed_le_billed') === false);
  const future = run(NW, 'nw_medical_claims_csv', { ...claim, SVC_DT: '2026-10-02', RCVD_DT: '2026-10-03' });
  assert.ok(future.errors.some((e) => e.rule_id === 'rule:service_not_future'), 'not_after_arrival is relative to batch arrival, not wall clock');
});

test('PHI values are not echoed in error messages', () => {
  const r = run(NW, 'nw_medical_claims_csv', { ...claim, DX_CD: 'not-a-code!!' });
  const msg = r.errors.map((e) => e.message).join(' ');
  assert.ok(msg.includes('diagnosis_code'));
  assert.ok(!msg.includes('not-a-code!!'), msg);
});

test('sensitive data in unmapped columns is detected', () => {
  const r = run(NW, 'nw_medical_claims_csv', { ...claim, MEMO: 'call re 912-34-5678' });
  assert.ok(r.findings.some((f) => f.rule_id === 'privacy:unmapped_sensitive' && /MEMO/.test(f.message) && !/912-34-5678/.test(f.message)));
  assert.equal(detectSensitiveValue('a.b@example.test'), 'email');
  assert.equal(detectSensitiveValue('(555) 123-4567'), 'phone');
  assert.equal(detectSensitiveValue('E11.9'), null);
  assert.ok(isSuspiciousColumnName('Patient_Name'));
  assert.ok(!isSuspiciousColumnName('PLAN_CD'));
});

test('bluefin semantics: concatenated key, implied cents, YYYYMMDD', () => {
  const r = run(BF, 'bf_rx_claims_csv', { CLAIM_NO: 'bx1', SUB_ID: '500001', DEP_SEQ: '2', NDC: '1234-5678-9', FILL_DT: '20260915', DAYS: '30',
    ING_COST_C: '1250', DISP_FEE_C: '150', TOTAL_C: '1400', COPAY_C: '500', PLAN_C: '900', STATE: 'A', ADJ_TS: '2026-09-16T10:30:00Z', PHARM_ID: 'PH000001', NOTES: null });
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(r.values.enrollee_id, '500001-2');
  assert.equal(r.values.ndc, '00123456789');
  assert.equal(r.values.plan_cost, '9.00');
  assert.equal(r.values.fill_date, '2026-09-15');
});

test('rule conditions use SQL three-valued logic', () => {
  const e = NW.entities.claim;
  const row = { paid_amount: null, billed_amount: '10.00' } as never;
  assert.equal(evaluate({ field: 'paid_amount', op: 'lte', other_field: 'billed_amount' }, e, row, ctx), null);
  assert.equal(evaluate({ not: { field: 'paid_amount', op: 'lte', other_field: 'billed_amount' } }, e, row, ctx), null);
  assert.equal(evaluate({ any: [{ field: 'paid_amount', op: 'is_null' }, { field: 'paid_amount', op: 'gt', value: 0 }] }, e, row, ctx), true);
  assert.equal(evaluate({ all: [{ field: 'billed_amount', op: 'gt', value: 100 }, { field: 'paid_amount', op: 'gt', value: 0 }] }, e, row, ctx), false);
});

test('record identity ignores field order', () => {
  const e = NW.entities.claim;
  const v = run(NW, 'nw_medical_claims_csv', claim).values;
  const reversed = Object.fromEntries(Object.entries(v).reverse());
  assert.equal(recordHash(e, v), recordHash(e, reversed));
  assert.equal(canonicalKey(e, v), 'C1');
});

test('CSV adapter: structural problems are explicit', () => {
  const ok = parseCsv(Buffer.from('﻿A,B\n1,\n2,3,4\n'), 10);
  assert.deepEqual(ok.columns, ['A', 'B']);
  assert.deepEqual(ok.rows[0], { row_number: 1, payload: { A: '1', B: null }, parse_error: null });
  assert.equal(ok.rows[1].parse_error, 'expected 2 columns, found 3');
  const reason = (f: () => unknown) => { try { f(); return 'none'; } catch (e) { return (e as StructuralError).reason; } };
  assert.equal(reason(() => parseCsv(Buffer.from(''), 10)), 'empty_payload');
  assert.equal(reason(() => parseCsv(Buffer.from('A,B\n'), 10)), 'empty_payload');
  assert.equal(reason(() => parseCsv(Buffer.from('A,A\n1,2\n'), 10)), 'invalid_header');
  assert.equal(reason(() => parseCsv(Buffer.from('A\n1\n2\n3\n'), 2)), 'too_many_rows');
  assert.equal(reason(() => parseCsv(Buffer.from('A,B\n"unterminated,1\n'), 10)), 'unparseable_csv');
});

test('JSON adapter: scalars only', () => {
  const p = parseJsonRecords([{ a: 1, b: true, c: '' }, { a: { nested: 1 } }, 'x'], 10);
  assert.deepEqual(p.rows[0].payload, { a: '1', b: 'true', c: null });
  assert.match(p.rows[1].parse_error!, /nested object/);
  assert.equal(p.rows[2].parse_error, 'record is not a JSON object');
  assert.throws(() => parseJsonRecords({}, 10), /must be an array/);
});

test('batch reconciliation explains each discrepancy', () => {
  const base = { received: 10, accepted: 8, quarantined: 1, duplicates: 1, control: { record_count: 10, sums: { paid: '100.00' } },
    sums: { paid: { received: '100.00', unparseable_rows: 0, accepted: '90.00', quarantined: '5.00', duplicate: '5.00' } }, target: { rows: 8, sums: { paid: '90.00' } } };
  assert.ok(reconcileBatch(base).every((r) => r.status === 'passed'));
  const short = reconcileBatch({ ...base, control: { record_count: 12, sums: { paid: '130.00' } } });
  const byId = Object.fromEntries(short.map((r) => [r.check_id, r]));
  assert.equal(byId.source_control_count.status, 'failed');
  assert.match(byId.source_control_count.explanation, /2 row\(s\) missing/);
  assert.deepEqual(byId['source_control_sum:paid'].difference, { amount: '-30.00' });
  const lostWrite = reconcileBatch({ ...base, target: { rows: 7, sums: { paid: '80.00' } } });
  assert.equal(lostWrite.find((r) => r.check_id === 'target_row_count')!.status, 'failed');
  assert.equal(lostWrite.find((r) => r.check_id === 'target_sum:paid')!.difference && (lostWrite.find((r) => r.check_id === 'target_sum:paid')!.difference as { amount: string }).amount, '-10.00');
  const unread = reconcileBatch({ ...base, sums: { paid: { ...base.sums.paid, unparseable_rows: 1 } } });
  assert.match(unread.find((r) => r.check_id === 'source_control_sum:paid')!.explanation, /1 row\(s\) had an unreadable paid/);
});

test('logger never writes payload-like fields', () => {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { lines.push(s); return true; }) as never;
  const prev = process.env.LOG_LEVEL;
  try {
    createLogger({ svc: 't' }).error === undefined; // touch
    const l = createLogger({ svc: 't' });
    l.info('x', { payload: { SSN: '912-34-5678' }, authorization: 'Bearer secret', batch_id: 'b1' });
  } finally { process.stdout.write = orig; process.env.LOG_LEVEL = prev; }
  const out = lines.join('');
  if (out) {
    assert.ok(!out.includes('912-34-5678') && !out.includes('secret'));
    assert.ok(out.includes('"batch_id":"b1"'));
  }
});
