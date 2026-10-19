// Scenario A — Normal ingestion: ingest a valid batch, transform it, reconcile
// it, and produce a dashboard metric and a CSV extract. Expected values come
// from the generator's own rows, not from the platform.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, centsOf, fromCents } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

test('Scenario A: valid batch flows from source row to metric and extract', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const members = nwMembers(200, 101);
  const claims = nwClaims(1000, members.map((m) => m.MBR_ID), 102);
  const paidCents = claims.filter((c) => c.CLM_STATUS === 'P').reduce((s, c) => s + centsOf(c.PAID_AMT), 0);
  const totalPaidMetricCents = paidCents; // generator emits no reversals
  const billedCents = claims.reduce((s, c) => s + centsOf(c.BILLED_AMT), 0);

  assert.equal((await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never))).status, 202);
  assert.equal((await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS), { control: { record_count: 200 } })).status, 202);
  const sub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS), {
    reportedAt: '2026-10-01T06:00:00Z', control: { record_count: 1000, sums: { paid_amount: fromCents(paidCents), billed_amount: fromCents(billedCents) } } });
  assert.equal(sub.status, 202);
  assert.equal(sub.body.status, 'queued');
  assert.equal(await ctx.worker.drain(), 3);

  const batch = (await op.get(`/api/v1/tenants/northwind/batches/${sub.body.batch_id}`)).body;
  assert.equal(batch.status, 'completed');
  assert.equal(batch.trust_status, 'trusted');
  assert.equal(batch.reconciliation_status, 'passed');
  assert.equal(batch.quality_status, 'passed');
  assert.deepEqual([batch.received_count, batch.accepted_count, batch.quarantined_count, batch.duplicate_count], [1000, 1000, 0, 0]);
  assert.match(batch.payload_digest, /^[0-9a-f]{64}$/);
  assert.equal(batch.contract_version, '1.0.0');
  assert.match(batch.transform_version, /^engine@1\.0\.0\+contract@1\.0\.0#[0-9a-f]{12}$/);
  assert.equal(batch.source_reported_at, '2026-10-01T06:00:00.000Z');
  assert.ok(batch.started_at && batch.completed_at);
  assert.ok(batch.reconciliation.length >= 7 && batch.reconciliation.every((r: { status: string }) => r.status === 'passed'));
  assert.ok(batch.quality_results.every((q: { failed_count: number; severity: string }) => q.failed_count === 0));

  // Dashboard metric (the dashboard renders this API response verbatim).
  const biz = (await rep.get('/api/v1/tenants/northwind/reports/business')).body;
  const m = Object.fromEntries(biz.metrics.map((x: { id: string }) => [x.id, x]));
  assert.equal(m.claims_total.value, '1000');
  assert.equal(m.paid_claims.value, String(claims.filter((c) => c.CLM_STATUS === 'P').length));
  assert.equal(m.total_paid.value, fromCents(totalPaidMetricCents));
  assert.equal(m.total_billed.value, fromCents(billedCents));
  assert.equal(m.members_total.value, '200');
  assert.equal(m.active_members.value, String(members.filter((x) => x.MBR_STATUS === 'A').length));

  // CSV extract with explicit schema.
  const x = await rep.get('/api/v1/tenants/northwind/extracts/claims/csv');
  assert.equal(x.status, 200);
  const rows = parse(x.text, { columns: true }) as Record<string, string>[];
  assert.equal(rows.length, 1000);
  assert.equal(x.headers['x-clearline-row-count'], '1000');
  assert.match(String(x.headers['x-clearline-sha256']), /^[0-9a-f]{64}$/);
  assert.equal(rows.reduce((s, r) => s + centsOf(r.billed_amount), 0), billedCents);
  assert.ok(rows.every((r) => r.diagnosis_code === 'REDACTED'), 'PHI redacted by default');
  const schema = (await rep.get('/api/v1/tenants/northwind/extracts/claims/schema')).body;
  assert.deepEqual(schema.columns.map((c: { name: string }) => c.name), Object.keys(rows[0]));

  // Lineage: one source row -> canonical version -> reconciliation -> metric -> extract.
  const target = claims.find((c) => c.CLM_STATUS === 'P')!;
  const lin = (await op.get(`/api/v1/tenants/northwind/lineage/claim/${target.CLM_ID}`)).body;
  const v = lin.versions[0];
  assert.equal(v.is_current, true);
  assert.equal(v.batch.id, sub.body.batch_id);
  assert.equal(v.source_row.row_number, claims.indexOf(target) + 1);
  assert.equal(v.source_row.mapped_columns.PAID_AMT, target.PAID_AMT);
  assert.equal(v.source_row.mapped_columns.DX_CD, '[redacted]', 'operators do not see PHI in lineage');
  assert.equal(v.values.paid_amount, target.PAID_AMT);
  assert.equal(v.contract_version, '1.0.0');
  assert.ok(v.batch_reconciliation.every((r: { status: string }) => r.status === 'passed'));
  assert.deepEqual(v.metric_contribution.find((c: { metric_id: string }) => c.metric_id === 'total_paid'), { metric_id: 'total_paid', included: true, reason: 'included' });
  assert.equal(v.exports.length, 1);
  assert.equal(v.exports[0].content_sha256, x.headers['x-clearline-sha256']);

  // Every persisted record carries source and version provenance.
  const unprov = await sql(`SELECT count(*)::int AS n FROM t_northwind.claim WHERE "_raw_record_id" IS NULL OR "_batch_id" IS NULL OR "_contract_version_id" IS NULL OR "_transform_version" IS NULL`);
  assert.equal(unprov[0].n, 0);

  evidence('Scenario A — Normal ingestion', [
    `Submitted 3 plans, 200 members, 1000 claims (CSV, control totals record_count=1000, paid=${fromCents(paidCents)}, billed=${fromCents(billedCents)}).`,
    `Claims batch ${sub.body.batch_id}: status=${batch.status}, trust=${batch.trust_status}, quality=${batch.quality_status}, reconciliation=${batch.reconciliation_status}; ${batch.reconciliation.length} reconciliation checks all passed.`,
    `Business metric total_paid=${m.total_paid.value} (generator truth ${fromCents(totalPaidMetricCents)}), claims_total=${m.claims_total.value}.`,
    `Extract claims: ${rows.length} rows, sha256 ${String(x.headers['x-clearline-sha256']).slice(0, 16)}…, diagnosis_code redacted; billed sum matches truth.`,
    `Lineage for ${target.CLM_ID}: source row ${v.source_row.row_number} -> record ${v.record_id} -> metric total_paid (included) -> export ${v.exports[0].id}.`,
  ]);
});
