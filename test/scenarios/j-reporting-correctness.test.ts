// Scenario J — Reporting correctness: independently query the persisted data
// and verify the reports, SQL reporting views and extracts return the expected
// results. Three independent references are compared with the platform:
//   (a) ground truth computed from the generated rows (synthetic/reference-dataset.ts)
//   (b) hand-written SQL in this file against the base tables (it does NOT use
//       the platform's SQL compiler in src/reporting/sql.ts)
//   (c) a separate database login holding only the tenant's reporting role
// The dashboard renders the same API responses; test/e2e/dashboard.test.ts
// checks the rendered numbers against (a) and (b).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, TEST_DB, ROOT, type Ctx } from '../helpers/harness.js';
import { loadReferenceDataset, type Truth } from '../../synthetic/reference-dataset.js';
import { centsOf, fromCents } from '../../synthetic/generator.js';

let ctx: Ctx;
let truth: Truth;
before(async () => {
  ctx = await setup();
  truth = await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
});
after(async () => { await teardown(ctx); });

const ADMIN_URL = process.env.PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

// (b) Independent SQL, one hand-written statement per declared metric.
const T = (schema: string, entity: string) => `FROM ${schema}.${entity} x JOIN core.batches b ON b.id = x."_batch_id" WHERE x."_is_current" AND b.trust_status = 'trusted'`;
const HAND_SQL: Record<string, Record<string, string>> = {
  northwind: {
    members_total: `SELECT count(*)::text v ${T('t_northwind', 'member')}`,
    active_members: `SELECT count(*)::text v ${T('t_northwind', 'member')} AND x.status = 'ACTIVE'`,
    claims_total: `SELECT count(*)::text v ${T('t_northwind', 'claim')}`,
    paid_claims: `SELECT count(*)::text v ${T('t_northwind', 'claim')} AND x.status = 'PAID'`,
    denied_claims: `SELECT count(*)::text v ${T('t_northwind', 'claim')} AND x.status = 'DENIED'`,
    total_paid: `SELECT to_char(coalesce(sum(x.paid_amount),0), 'FM999999999990.00') v ${T('t_northwind', 'claim')} AND x.status IN ('PAID','REVERSED')`,
    total_billed: `SELECT to_char(coalesce(sum(x.billed_amount),0), 'FM999999999990.00') v ${T('t_northwind', 'claim')}`,
    rx_fills: `SELECT count(*)::text v ${T('t_northwind', 'pharmacy_fill')} AND x.status = 'FILLED'`,
    rx_plan_paid: `SELECT to_char(coalesce(sum(x.plan_paid),0), 'FM999999999990.00') v ${T('t_northwind', 'pharmacy_fill')} AND x.status = 'FILLED'`,
  },
  bluefin: {
    active_enrollees: `SELECT count(*)::text v ${T('t_bluefin', 'enrollee')} AND x.terminated_on IS NULL`,
    approved_rx_claims: `SELECT count(*)::text v ${T('t_bluefin', 'rx_claim')} AND x.claim_state = 'APPROVED'`,
    plan_cost_total: `SELECT to_char(coalesce(sum(x.plan_cost),0), 'FM999999999990.00') v ${T('t_bluefin', 'rx_claim')} AND x.claim_state = 'APPROVED'`,
    avg_copay: `SELECT to_char(avg(x.copay), 'FM999999990.0000') v ${T('t_bluefin', 'rx_claim')} AND x.claim_state = 'APPROVED'`,
    utilizing_enrollees: `SELECT count(DISTINCT x.enrollee_id)::text v ${T('t_bluefin', 'rx_claim')} AND x.claim_state = 'APPROVED'`,
  },
};

test('Scenario J: reports, SQL views and extracts agree with independent queries and ground truth', async () => {
  const comparison: string[] = [];
  const table: { tenant: string; metric: string; api: string; hand_sql: string; truth: string; match: boolean }[] = [];

  for (const tenant of ['northwind', 'bluefin'] as const) {
    const rep = client(ctx, DEV_TOKENS[tenant].reporter);
    const biz = (await rep.get(`/api/v1/tenants/${tenant}/reports/business`)).body;
    const declared = biz.metrics.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(declared, Object.keys(HAND_SQL[tenant]).sort(), `every ${tenant} metric has an independent query`);
    for (const m of biz.metrics as { id: string; value: string }[]) {
      const hand = (await sql(HAND_SQL[tenant][m.id]))[0].v as string;
      const t = truth[tenant][m.id];
      const match = m.value === hand && m.value === t;
      table.push({ tenant, metric: m.id, api: m.value, hand_sql: hand, truth: t, match });
      assert.equal(m.value, hand, `${tenant}.${m.id}: API vs hand-written SQL`);
      assert.equal(m.value, t, `${tenant}.${m.id}: API vs generator ground truth`);
    }
    // Exception rate = quarantined / received over processed batches.
    const ex = (await sql(`SELECT sum(quarantined_count)::int q, sum(received_count)::int r FROM core.batches WHERE tenant_id = $1 AND status IN ('completed','completed_with_exceptions')`, [tenant]))[0];
    assert.equal(biz.exception_rate.quarantined, ex.q);
    assert.equal(biz.exception_rate.received, ex.r);
    assert.equal(biz.exception_rate.rate, Number((ex.q / ex.r).toFixed(6)));
  }
  assert.equal(truth.northwind.claims_total, '397');
  comparison.push(`${table.length} declared metrics across 2 tenants: API = hand-written SQL = generator truth for all ${table.filter((r) => r.match).length}.`);
  writeFileSync(path.join(ROOT, 'test-results/scenario-j-metric-comparison.json'), JSON.stringify(table, null, 2));

  // ---- Operations report vs. core.batches.
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const ops = (await op.get('/api/v1/tenants/northwind/reports/operations')).body;
  const b = (await sql(`SELECT count(*)::int batches,
      count(*) FILTER (WHERE status IN ('completed','completed_with_exceptions'))::int succeeded,
      count(*) FILTER (WHERE trust_status = 'trusted')::int trusted, count(*) FILTER (WHERE trust_status = 'untrusted')::int untrusted,
      sum(received_count)::int rows_received, sum(accepted_count)::int rows_accepted, sum(quarantined_count)::int rows_quarantined, sum(duplicate_count)::int rows_duplicate
      FROM core.batches WHERE tenant_id = 'northwind'`))[0];
  for (const k of Object.keys(b)) assert.equal(ops.totals[k], b[k], `operations.totals.${k}`);
  assert.equal(b.batches, truth.batches.northwind);
  assert.equal(b.untrusted, 1);
  assert.equal(ops.totals.duplicate_submissions, truth.duplicateSubmissions);
  assert.equal(b.rows_quarantined, truth.quarantinedClaimRows);
  comparison.push(`Operations report totals (${Object.keys(b).length} fields) equal direct aggregates over core.batches: ${b.batches} batches, ${b.succeeded} succeeded, ${b.trusted} trusted, ${b.untrusted} untrusted, ${b.rows_quarantined} rows quarantined, ${ops.totals.duplicate_submissions} duplicate submission.`);

  // ---- Extract: rows, keys and sums vs. truth; checksum and reproducibility.
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const x = await rep.get('/api/v1/tenants/northwind/extracts/claims/csv');
  const rows = parse(x.text, { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((r) => r.claim_id), truth.trustedClaimIds, 'exactly the trusted current claims, ordered by key');
  assert.equal(fromCents(rows.reduce((s, r) => s + centsOf(r.billed_amount), 0)), truth.northwind.total_billed);
  assert.equal(fromCents(rows.filter((r) => ['PAID', 'REVERSED'].includes(r.status)).reduce((s, r) => s + centsOf(r.paid_amount), 0)), truth.northwind.total_paid);
  assert.ok(rows.every((r) => r._trust_status === 'trusted' && r._contract_version === '1.0.0'));
  assert.equal(createHash('sha256').update(x.text).digest('hex'), x.headers['x-clearline-sha256'], 'published checksum matches the bytes');
  const asOf = String(x.headers['x-clearline-as-of']);
  const filt = encodeURIComponent(JSON.stringify({ status: 'PAID', service_date: { gte: '2026-06-01', lte: '2026-08-31' } }));
  const f1 = await rep.get(`/api/v1/tenants/northwind/extracts/claims/csv?as_of=${encodeURIComponent(asOf)}&filters=${filt}`);
  const f2 = await rep.get(`/api/v1/tenants/northwind/extracts/claims/csv?as_of=${encodeURIComponent(asOf)}&filters=${filt}`);
  assert.equal(f1.status, 200, f1.text);
  assert.equal(f1.headers['x-clearline-sha256'], f2.headers['x-clearline-sha256'], 'same filters + as_of reproduce identical bytes');
  const handFiltered = (await sql(`SELECT count(*)::int n ${T('t_northwind', 'claim')} AND x.status = 'PAID' AND x.service_date BETWEEN '2026-06-01' AND '2026-08-31'`))[0].n;
  assert.equal(Number(f1.headers['x-clearline-row-count']), handFiltered);
  const logged = (await sql(`SELECT row_count, content_sha256 FROM core.export_log WHERE id = $1`, [x.headers['x-clearline-export-id']]))[0];
  assert.deepEqual(logged, { row_count: rows.length, content_sha256: x.headers['x-clearline-sha256'] });
  comparison.push(`Claims extract: ${rows.length} rows whose claim_ids equal the ${truth.trustedClaimIds.length} ground-truth trusted claims; billed and paid sums equal truth; sha256 recomputed from bytes matches header and export_log.`);
  comparison.push(`Filtered extract (status=PAID, service_date Jun–Aug) at fixed as_of returned ${handFiltered} rows (hand SQL ${handFiltered}); two runs produced identical sha256.`);

  // ---- (c) Reporting views through a BI login with only the reporting role.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS bi_nw_j`);
  await admin.query(`CREATE ROLE bi_nw_j LOGIN PASSWORD 'bi-j' IN ROLE clearline_rpt_northwind`);
  const bi = new pg.Client({ connectionString: `postgres://bi_nw_j:bi-j@localhost:5432/${TEST_DB}` });
  await bi.connect();
  try {
    const v = (await bi.query(`SELECT count(*)::text n, to_char(sum(paid_amount) FILTER (WHERE status IN ('PAID','REVERSED')), 'FM999999999990.00') paid,
        to_char(sum(billed_amount), 'FM999999999990.00') billed FROM t_northwind.rpt_trusted_claim`)).rows[0];
    assert.deepEqual(v, { n: truth.northwind.claims_total, paid: truth.northwind.total_paid, billed: truth.northwind.total_billed });
    const ov = (await bi.query(`SELECT count(*)::int n FROM reporting.batch_overview`)).rows[0].n;
    assert.equal(ov, truth.batches.northwind);
    comparison.push(`BI login with only clearline_rpt_northwind: rpt_trusted_claim count/paid/billed = ${v.n}/${v.paid}/${v.billed} (= truth); reporting.batch_overview shows ${ov} batches.`);
  } finally {
    await bi.end();
    await admin.query(`DROP OWNED BY bi_nw_j; DROP ROLE bi_nw_j`).catch(() => {});
    await admin.end();
  }

  // ---- Untrusted data is visible but cannot inflate trusted figures.
  const biz = (await rep.get('/api/v1/tenants/northwind/reports/business')).body;
  const ct = biz.metrics.find((m: { id: string }) => m.id === 'claims_total');
  assert.equal(Number(ct.value_including_untrusted) - Number(ct.value), truth.untrustedClaimRows);
  comparison.push(`claims_total ${ct.value} trusted vs ${ct.value_including_untrusted} including the untrusted batch (difference ${truth.untrustedClaimRows} = rows of the non-reconciling batch).`);

  evidence('Scenario J — Reporting correctness', [...comparison, 'Per-metric table: test-results/scenario-j-metric-comparison.json.']);
});
