// Scenario E — Late data and corrections. Documented handling (docs/architecture.md §Corrections):
//  * a version with a HIGHER ordering value supersedes the current version (correction)
//  * a version with a LOWER ordering value is kept as history, flagged late, and does NOT change current results
//  * the SAME ordering value with different content is an unresolved conflict and is quarantined
//  * point-in-time extracts (as_of) reproduce what was current at that moment

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Scenario E: corrections supersede, late versions become history, conflicts are quarantined', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  const [m1, m2, m3] = nwMembers(3, 501);
  const v1 = { ...m1, MBR_STATUS: 'A', COV_END: '', LAST_UPD_TS: '2026-09-10T08:00:00Z' };
  const b1 = await op.csv('northwind', 'nw_eligibility_csv', toCsv([v1, m2] as never, NW_MEMBER_COLUMNS), { reportedAt: '2026-09-10T09:00:00Z' });
  await ctx.worker.drain();
  await pause(20);
  const t1 = new Date().toISOString();
  await pause(20);

  // Correction: newer updated_at terminates the member.
  const v2 = { ...m1, MBR_STATUS: 'T', COV_END: '09/30/2026', LAST_UPD_TS: '2026-09-20T08:00:00Z' };
  const b2 = await op.csv('northwind', 'nw_eligibility_csv', toCsv([v2] as never, NW_MEMBER_COLUMNS), { reportedAt: '2026-09-20T09:00:00Z' });
  await ctx.worker.drain();

  // Late file: reported 09-15 (earlier than the 09-20 file already processed) with an intermediate version + a new member.
  const vLate = { ...m1, MBR_STATUS: 'P', COV_END: '', LAST_UPD_TS: '2026-09-15T08:00:00Z' };
  const b3 = await op.csv('northwind', 'nw_eligibility_csv', toCsv([vLate, m3] as never, NW_MEMBER_COLUMNS), { reportedAt: '2026-09-15T09:00:00Z' });
  // Conflict: same updated_at as the current version, different content.
  const vConflict = { ...m1, MBR_STATUS: 'A', COV_END: '', LAST_UPD_TS: '2026-09-20T08:00:00Z' };
  const b4 = await op.csv('northwind', 'nw_eligibility_csv', toCsv([vConflict] as never, NW_MEMBER_COLUMNS), { reportedAt: '2026-09-21T09:00:00Z' });
  await ctx.worker.drain();

  const batch = async (id: string) => (await op.get(`/api/v1/tenants/northwind/batches/${id}`)).body;
  const B2 = await batch(b2.body.batch_id), B3 = await batch(b3.body.batch_id), B4 = await batch(b4.body.batch_id);
  assert.equal(B2.correction_count, 1);
  assert.equal(B3.is_late, true, 'batch flagged late by source_reported_at');
  assert.equal(B3.late_record_count, 1);
  assert.equal(B3.accepted_count, 2);
  assert.equal(B4.conflict_count, 1);
  assert.equal(B4.quarantined_count, 1);

  const lin = (await op.get(`/api/v1/tenants/northwind/lineage/member/${m1.MBR_ID}`)).body;
  const shape = lin.versions.map((v: { values: { status: string }; is_current: boolean; is_late: boolean; batch: { id: string } }) => [v.values.status, v.is_current, v.is_late, v.batch.id]);
  assert.deepEqual(shape, [
    ['ACTIVE', false, false, b1.body.batch_id],
    ['TERMINATED', true, false, b2.body.batch_id],
    ['PENDING', false, true, b3.body.batch_id],
  ]);
  assert.equal(lin.quarantined_submissions.length, 1);
  assert.equal(lin.quarantined_submissions[0].category, 'conflict');
  assert.match(lin.quarantined_submissions[0].errors[0].message, /same updated_at exists with different content/);

  // Current results reflect the correction only.
  const biz = Object.fromEntries((await rep.get('/api/v1/tenants/northwind/reports/business')).body.metrics.map((m: { id: string; value: string }) => [m.id, m.value]));
  const activeExpected = [m2, m3].filter((m) => m.MBR_STATUS === 'A').length;
  assert.equal(biz.active_members, String(activeExpected));
  assert.equal(biz.members_total, '3');

  // Historical results: an as-of extract reproduces what was current at t1.
  const asOf = parse((await rep.get(`/api/v1/tenants/northwind/extracts/eligibility/csv?as_of=${encodeURIComponent(t1)}`)).text, { columns: true }) as Record<string, string>[];
  const now = parse((await rep.get('/api/v1/tenants/northwind/extracts/eligibility/csv')).text, { columns: true }) as Record<string, string>[];
  assert.equal(asOf.find((r) => r.member_id === m1.MBR_ID)!.status, 'ACTIVE');
  assert.equal(asOf.length, 2, 'm3 had not arrived at t1');
  assert.equal(now.find((r) => r.member_id === m1.MBR_ID)!.status, 'TERMINATED');
  assert.equal(now.length, 3);

  // Claims: re-adjudication supersedes; re-sending the original is a no-op.
  const [c] = nwClaims(1, [m2.MBR_ID], 502);
  const orig = { ...c, CLM_STATUS: 'P', BILLED_AMT: '200.00', ALLOWED_AMT: '150.00', PAID_AMT: '100.00', ADJ_SEQ: '1' };
  const readj = { ...orig, PAID_AMT: '80.00', ADJ_SEQ: '2' };
  await op.csv('northwind', 'nw_medical_claims_csv', toCsv([orig] as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  await op.csv('northwind', 'nw_medical_claims_csv', toCsv([readj] as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const resend = await op.csv('northwind', 'nw_medical_claims_csv', toCsv([orig, { ...c, CLM_ID: 'C777777777' }] as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const R = await batch(resend.body.batch_id);
  assert.equal(R.duplicate_count, 1, 'original adjudication re-sent: exact duplicate of a historical version, no effect');
  const claimLin = (await op.get(`/api/v1/tenants/northwind/lineage/claim/${orig.CLM_ID}`)).body;
  assert.deepEqual(claimLin.versions.map((v: { values: { paid_amount: string }; is_current: boolean }) => [v.values.paid_amount, v.is_current]), [['100.00', false], ['80.00', true]]);
  assert.equal(claimLin.versions[0].duplicate_deliveries.length, 1);

  const ex = (await op.get('/api/v1/tenants/northwind/reports/exceptions')).body;
  assert.ok(ex.late_records.some((r: { key: string }) => r.key === m1.MBR_ID));
  assert.ok(ex.late_batches.some((b: { id: string }) => b.id === b3.body.batch_id));
  assert.ok(ex.quarantined.some((q: { category: string; record_key: string }) => q.category === 'conflict' && q.record_key === m1.MBR_ID));

  evidence('Scenario E — Late data and corrections', [
    `Member ${m1.MBR_ID}: v1 ACTIVE (updated 09-10) -> correction TERMINATED (updated 09-20) superseded it; late file (reported 09-15, after the 09-20 file) carried PENDING (updated 09-15) -> stored as history with is_late=true, current unchanged.`,
    `Conflicting version (same updated_at 09-20, different content) quarantined as 'conflict' and listed in the exception report.`,
    `as_of=${t1} extract returns status ACTIVE and 2 members; current extract returns TERMINATED and 3 members.`,
    `Claim ${orig.CLM_ID}: seq1 paid 100.00 superseded by seq2 paid 80.00; re-sending seq1 counted as duplicate with no effect.`,
  ]);
});
