// Scenario I — Reconciliation failure: deliberately create source-to-target
// discrepancies and show the system flags the affected dataset and explains
// the difference. Three independent causes:
//   1. In transit: the sender's control totals disagree with what arrived.
//   2. After load: rows deleted / edited outside the platform (drift).
//   3. Missing reference data: claims for members that were never delivered.
// Expected differences are computed from the generator, never from the platform.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, centsOf, fromCents } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

const NW = '/api/v1/tenants/northwind';
const metricMap = (b: { metrics: { id: string }[] }) => Object.fromEntries(b.metrics.map((m) => [m.id, m])) as unknown as Record<string, { value: string; value_including_untrusted: string; untrusted_records_excluded: number; trusted: boolean }>;
const paidCents = (cs: { CLM_STATUS: string; PAID_AMT: string }[]) => cs.filter((c) => c.CLM_STATUS === 'P').reduce((s, c) => s + centsOf(c.PAID_AMT), 0);
const sumCents = (cs: { PAID_AMT: string }[]) => cs.reduce((s, c) => s + centsOf(c.PAID_AMT), 0);

test('Scenario I: discrepancies are detected, explained, and removed from trusted outputs', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const members = nwMembers(100, 901);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));

  // A clean batch first, so we can show trusted outputs are unaffected by the bad one.
  const good = nwClaims(200, members.map((m) => m.MBR_ID), 902, 1);
  const goodSub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(good as never, NW_CLAIM_COLUMNS),
    { control: { record_count: 200, sums: { paid_amount: fromCents(sumCents(good)) } } });

  // ---- 1. In transit: the sender's file had 250 rows; 3 were lost before delivery.
  const sent = nwClaims(250, members.map((m) => m.MBR_ID), 903, 10_001);
  const lost = [sent[17], sent[120], sent[201]];
  const delivered = sent.filter((c) => !lost.includes(c));
  const lostPaid = sumCents(lost);
  const transit = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(delivered as never, NW_CLAIM_COLUMNS),
    { control: { record_count: 250, sums: { paid_amount: fromCents(sumCents(sent)) } } });
  await ctx.worker.drain();

  const tb = (await op.get(`${NW}/batches/${transit.body.batch_id}`)).body;
  assert.equal(tb.status, 'completed', 'the pipeline ran successfully…');
  assert.equal(tb.quality_status, 'passed', '…every row is individually valid…');
  assert.equal(tb.reconciliation_status, 'failed', '…but the dataset does not reconcile');
  assert.equal(tb.trust_status, 'untrusted');
  assert.ok(tb.trust_reasons.some((r: string) => /reconciliation failed: .*source_control_count/.test(r)));
  const rc = Object.fromEntries(tb.reconciliation.map((r: { check_id: string }) => [r.check_id, r]));
  assert.equal(rc.source_control_count.status, 'failed');
  assert.deepEqual(rc.source_control_count.difference, { rows: -3 });
  assert.match(rc.source_control_count.explanation, /declared 250 rows but 247 arrived: 3 row\(s\) missing/);
  assert.equal(rc['source_control_sum:paid_amount'].status, 'failed');
  assert.equal(rc['source_control_sum:paid_amount'].difference.amount, fromCents(-lostPaid), 'difference equals exactly the paid amount of the lost rows');
  assert.match(rc['source_control_sum:paid_amount'].explanation, /missing relative to the control total/);
  for (const k of ['row_accounting', 'target_row_count', 'target_sum:paid_amount', 'financial_accounting:paid_amount']) assert.equal(rc[k].status, 'passed', k);

  // Trusted outputs exclude the untrusted batch; the "including untrusted" figure shows what was held back.
  let m = metricMap((await rep.get(`${NW}/reports/business`)).body);
  assert.equal(m.claims_total.value, '200');
  assert.equal(m.claims_total.value_including_untrusted, '447');
  assert.equal(m.claims_total.untrusted_records_excluded, 247);
  assert.equal(m.claims_total.trusted, false, 'metric is flagged as not covering all received data');
  assert.equal(m.total_paid.value, fromCents(paidCents(good)));
  assert.equal(m.total_paid.value_including_untrusted, fromCents(paidCents(good) + paidCents(delivered)));
  const xTrusted = parse((await rep.get(`${NW}/extracts/claims/csv`)).text, { columns: true }) as unknown[];
  assert.equal(xTrusted.length, 200, 'default extract is trusted-only');
  const xAll = await rep.get(`${NW}/extracts/claims/csv?include_untrusted=true`);
  assert.equal(parse(xAll.text, { columns: true }).length, 447);
  assert.equal(xAll.headers['x-clearline-trust-scope'], 'all');
  const ops = (await rep.get(`${NW}/reports/operations`)).body;
  assert.equal(ops.totals.succeeded, 4);
  assert.equal(ops.totals.untrusted, 1, 'operations report separates succeeded from trusted');
  assert.equal(ops.reconciliation.batches_failed, 1);
  const exc = (await rep.get(`${NW}/reports/exceptions`)).body;
  assert.ok(exc.batches_requiring_review.some((b: { id: string }) => b.id === transit.body.batch_id));

  // ---- 2. After load: someone deletes 2 rows and edits one amount directly in the database.
  const victims = [good[3].CLM_ID, good[4].CLM_ID];
  const victimPaid = centsOf(good[3].PAID_AMT) + centsOf(good[4].PAID_AMT);
  const edited = good.find((c, i) => i > 10 && c.CLM_STATUS === 'P')!;
  // Keep a copy to play the role of a backup for the recovery step below.
  await sql(`CREATE TABLE public.claim_backup AS SELECT * FROM t_northwind.claim WHERE "_key" = ANY($1)`, [[...victims, edited.CLM_ID]]);
  await sql(`DELETE FROM t_northwind.claim WHERE "_key" = ANY($1)`, [victims]);
  await sql(`UPDATE t_northwind.claim SET paid_amount = paid_amount + 1000.00 WHERE "_key" = $1`, [edited.CLM_ID]);
  const run = (await op.post(`${NW}/reconciliation/run`)).body;
  const drift = run.batch_reverification_failures.filter((f: { batch_id: string }) => f.batch_id === goodSub.body.batch_id);
  const byCheck = Object.fromEntries(drift.map((d: { check_id: string }) => [d.check_id, d]));
  assert.deepEqual(byCheck['reverify:target_row_count'].difference, { rows: -2 });
  assert.match(byCheck['reverify:target_row_count'].explanation, /2 row\(s\) missing — deleted outside the platform/);
  assert.equal(byCheck['reverify:target_sum:paid_amount'].difference.amount, fromCents(100_000 - victimPaid));
  assert.match(byCheck['reverify:target_sum:paid_amount'].explanation, /not explained by any recorded erasure or retention/);
  const gb = (await op.get(`${NW}/batches/${goodSub.body.batch_id}`)).body;
  assert.equal(gb.trust_status, 'untrusted', 'drifted batch loses trusted status');
  assert.ok(gb.trust_reasons.some((r: string) => /post-load drift detected/.test(r)));
  const driftAudit = (await client(ctx, DEV_TOKENS.northwind.admin).get(`${NW}/audit?action=batch.drift`)).body;
  assert.equal(driftAudit.length, 1);
  m = metricMap((await rep.get(`${NW}/reports/business`)).body);
  assert.equal(m.claims_total.value, '0', 'no claims data is published as trusted while both batches are in question');
  assert.equal(m.claims_total.trusted, false);

  // Recovery: restore the rows from the backup copy, re-run reconciliation; trust returns (audited)
  // because drift was the only reason and the batch's own load-time checks had passed.
  await sql(`DELETE FROM t_northwind.claim WHERE "_key" = $1`, [edited.CLM_ID]);
  await sql(`INSERT INTO t_northwind.claim SELECT * FROM public.claim_backup`);
  await sql(`DROP TABLE public.claim_backup`);
  const rerun = (await op.post(`${NW}/reconciliation/run`)).body;
  assert.equal(rerun.batch_reverification_failures.filter((f: { batch_id: string }) => f.batch_id === goodSub.body.batch_id).length, 0);
  const restoredBatch = (await op.get(`${NW}/batches/${goodSub.body.batch_id}`)).body;
  assert.equal(restoredBatch.trust_status, 'trusted');
  assert.deepEqual(restoredBatch.trust_reasons, []);
  assert.equal((await client(ctx, DEV_TOKENS.northwind.admin).get(`${NW}/audit?action=batch.trust_restored`)).body.length, 1);
  assert.equal((await op.get(`${NW}/batches/${transit.body.batch_id}`)).body.trust_status, 'untrusted', 'a batch that failed its own load-time reconciliation is never re-trusted');
  m = metricMap((await rep.get(`${NW}/reports/business`)).body);
  assert.equal(m.claims_total.value, '200');
  assert.equal(m.total_paid.value, fromCents(paidCents(good)));

  // ---- 3. Missing references: claims arrive for members who have not been delivered yet.
  const lateMembers = nwMembers(5, 904, 9001);
  const orphanClaims = nwClaims(12, lateMembers.map((x) => x.MBR_ID), 905, 50_001);
  const orphanSub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(orphanClaims as never, NW_CLAIM_COLUMNS), { control: { record_count: 12 } });
  await ctx.worker.drain();
  const ob = (await op.get(`${NW}/batches/${orphanSub.body.batch_id}`)).body;
  assert.equal(ob.trust_status, 'trusted', 'reference is "warn": records are admitted but flagged');
  assert.equal(ob.warning_count, 12);
  let ds = (await rep.get(`${NW}/reconciliation`)).body.dataset;
  const orph = ds.find((d: { check_id: string }) => d.check_id === 'dataset:orphans:claim.claim_member');
  assert.equal(orph.status, 'failed');
  assert.deepEqual(orph.actual, { orphans: 12 });
  assert.match(orph.explanation, /12 current claim record\(s\) reference a member that has not been received/);
  const exc2 = (await rep.get(`${NW}/reports/exceptions`)).body;
  assert.equal(exc2.orphaned_references.length, 12);
  assert.deepEqual([...new Set(exc2.orphaned_references.map((o: { missing_reference: string }) => o.missing_reference))].sort(), [...new Set(orphanClaims.map((c) => c.MBR_ID))].sort());
  // The late eligibility file arrives; the next reconciliation run clears the finding.
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(lateMembers as never, NW_MEMBER_COLUMNS));
  await ctx.worker.drain();
  ds = (await rep.get(`${NW}/reconciliation`)).body.dataset;
  assert.equal(ds.find((d: { check_id: string }) => d.check_id === 'dataset:orphans:claim.claim_member').status, 'passed');

  // Persisted reconciliation history is queryable and tied to runs and contract versions.
  const hist = await sql(`SELECT count(*)::int AS n FROM core.reconciliation_results WHERE status = 'failed' AND tenant_id = 'northwind' AND contract_version_id IS NOT NULL AND run_id IS NOT NULL`);
  assert.ok(hist[0].n >= 5);

  evidence('Scenario I — Reconciliation failure', [
    `In transit: sender declared 250 rows / paid ${fromCents(sumCents(sent))}; 247 arrived. Batch ${transit.body.batch_id}: pipeline=completed, quality=passed, reconciliation=failed, trust=untrusted.`,
    `Explanation: "${rc.source_control_count.explanation}" and paid difference ${rc['source_control_sum:paid_amount'].difference.amount} (= the 3 lost rows' paid total, from the generator).`,
    `Trusted outputs held it back: claims_total 200 (447 including untrusted, 247 excluded, metric flagged trusted=false); default extract 200 rows, include_untrusted extract 447; operations report succeeded=4 vs untrusted=1.`,
    `Drift: 2 rows deleted and 1 paid_amount edited (+1000.00) directly in SQL. Re-verification: rows ${byCheck['reverify:target_row_count'].difference.rows}, paid difference ${byCheck['reverify:target_sum:paid_amount'].difference.amount} (expected ${fromCents(100_000 - victimPaid)}); batch ${goodSub.body.batch_id} became untrusted, batch.drift_detected audited. After restoring the rows from a backup copy, re-verification passed and trust was restored (batch.trust_restored audited); claims_total back to 200, total_paid back to truth. The in-transit batch stayed untrusted.`,
    `Missing references: 12 claims for 5 undelivered members admitted with warnings; dataset check orphans=12 failed with explanation and all 12 listed in the exception report; after the late eligibility file the check passed.`,
  ]);
});
