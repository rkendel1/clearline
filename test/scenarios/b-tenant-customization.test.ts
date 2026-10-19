// Scenario B — Tenant customization: different canonical contracts for two
// tenants processed by the same code, plus a THIRD tenant configured entirely
// through the API at runtime (no code change, no restart).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, loadContract, ROOT, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS, BF_PLANS, bfEnrollees, bfClaims, BF_ENROLLEE_COLUMNS, BF_CLAIM_COLUMNS } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

test('Scenario B: two tenants, two canonical models, one codebase', async () => {
  const nw = client(ctx, DEV_TOKENS.northwind.operator);
  const bf = client(ctx, DEV_TOKENS.bluefin.operator);
  const members = nwMembers(50, 201);
  await nw.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await nw.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  await nw.csv('northwind', 'nw_medical_claims_csv', toCsv(nwClaims(120, members.map((m) => m.MBR_ID), 202) as never, NW_CLAIM_COLUMNS));
  const enrollees = bfEnrollees(40, 211);
  const bfc = bfClaims(150, enrollees as never, 212);
  assert.equal((await bf.json('bluefin', 'bf_plans_api', BF_PLANS)).status, 202);
  await bf.csv('bluefin', 'bf_enrollment_csv', toCsv(enrollees as never, BF_ENROLLEE_COLUMNS));
  await bf.csv('bluefin', 'bf_rx_claims_csv', toCsv(bfc as never, BF_CLAIM_COLUMNS));
  await ctx.worker.drain();

  for (const t of ['northwind', 'bluefin']) {
    const batches = (await client(ctx, DEV_TOKENS[t as "northwind" | "bluefin"].operator).get(`/api/v1/tenants/${t}/batches`)).body;
    assert.ok(batches.every((b: { status: string; trust_status: string }) => b.status === 'completed' && b.trust_status === 'trusted'), `${t} batches trusted`);
  }

  // Storage generated from each contract differs.
  const cols = async (schema: string) => (await sql(`SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS c FROM information_schema.columns c WHERE table_schema = $1 AND column_name NOT LIKE '\\_%'
    AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE') GROUP BY 1 ORDER BY 1`, [schema]));
  const nwCols = await cols('t_northwind'), bfCols = await cols('t_bluefin');
  assert.deepEqual(nwCols.map((r) => r.table_name), ['claim', 'member', 'pharmacy_fill', 'plan']);
  assert.deepEqual(bfCols.map((r) => r.table_name), ['benefit_plan', 'enrollee', 'rx_claim']);
  const types = await sql(`SELECT table_schema, column_name, data_type FROM information_schema.columns WHERE (table_schema, table_name, column_name) IN (('t_bluefin','rx_claim','plan_cost'),('t_bluefin','benefit_plan','plan_id'),('t_northwind','plan','plan_code'))`);
  assert.deepEqual(Object.fromEntries(types.map((t) => [t.column_name, t.data_type])), { plan_cost: 'numeric', plan_id: 'bigint', plan_code: 'text' });

  // Bluefin semantics applied: implied-cents amounts, YYYYMMDD dates, concatenated enrollee key.
  const sample = bfc[0];
  const lin = (await bf.get(`/api/v1/tenants/bluefin/lineage/rx_claim/${sample.CLAIM_NO}`)).body.versions[0];
  assert.equal(lin.values.total_cost, (Number(sample.TOTAL_C) / 100).toFixed(2));
  assert.equal(lin.values.fill_date, `${String(sample.FILL_DT).slice(0, 4)}-${String(sample.FILL_DT).slice(4, 6)}-${String(sample.FILL_DT).slice(6)}`);
  assert.equal(lin.values.enrollee_id, `${sample.SUB_ID}-${sample.DEP_SEQ}`);

  // Each tenant sees its own declared metrics.
  const nwBiz = (await client(ctx, DEV_TOKENS.northwind.reporter).get('/api/v1/tenants/northwind/reports/business')).body;
  const bfBiz = (await client(ctx, DEV_TOKENS.bluefin.reporter).get('/api/v1/tenants/bluefin/reports/business')).body;
  assert.ok(nwBiz.metrics.some((m: { id: string }) => m.id === 'total_paid'));
  assert.ok(bfBiz.metrics.some((m: { id: string }) => m.id === 'plan_cost_total'));
  assert.equal(bfBiz.metrics.find((m: { id: string }) => m.id === 'approved_rx_claims').value, String(bfc.filter((c) => c.STATE === 'A').length));

  // A third tenant, configured at runtime purely through the API.
  const platform = client(ctx, DEV_TOKENS.platform);
  assert.equal((await platform.post('/api/v1/tenants', { id: 'coral', name: 'Coral Benefits (synthetic)', retention: { raw_payload_days: 30 } })).status, 201);
  const tok = await platform.post('/api/v1/tenants/coral/tokens', { name: 'coral-admin', role: 'admin' });
  assert.equal(tok.status, 201);
  const coral = client(ctx, tok.body.token);
  const doc = loadContract('bluefin', 'v1.json');
  doc.tenant = 'coral'; doc.contract_id = 'coral.rx';
  doc.entities.rx_claim.rules.push({ id: 'short_fill_only', description: 'Coral covers at most 30 days per fill', severity: 'error', assert: { field: 'days_supply', op: 'lte', value: 30 } });
  const pub = await coral.post('/api/v1/tenants/coral/contracts', doc);
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  await coral.json('coral', 'bf_plans_api', BF_PLANS);
  await coral.csv('coral', 'bf_enrollment_csv', toCsv(enrollees as never, BF_ENROLLEE_COLUMNS));
  const cb = await coral.csv('coral', 'bf_rx_claims_csv', toCsv(bfc as never, BF_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const coralBatch = (await coral.get(`/api/v1/tenants/coral/batches/${cb.body.batch_id}`)).body;
  const over30 = bfc.filter((c) => Number(c.DAYS) > 30).length;
  assert.equal(coralBatch.quarantined_count, over30, 'tenant-specific rule enforced without code');
  assert.equal(coralBatch.quality_results.find((q: { rule_id: string }) => q.rule_id === 'rule:short_fill_only').failed_count, over30);

  // No tenant-specific branches anywhere in application code.
  const hits = walk(path.join(ROOT, 'src')).filter((f) => /northwind|bluefin|coral/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);

  evidence('Scenario B — Tenant customization', [
    `northwind tables: ${nwCols.map((r) => `${r.table_name}(${r.c})`).join('; ')}`,
    `bluefin tables: ${bfCols.map((r) => `${r.table_name}(${r.c})`).join('; ')}`,
    `bluefin implied-cents/YYYYMMDD/concatenated-key semantics verified on ${sample.CLAIM_NO}.`,
    `Third tenant "coral" created via POST /tenants, token issued, contract published (with an extra 30-day rule) and data processed at runtime: ${coralBatch.quarantined_count} of ${coralBatch.received_count} claims quarantined by the tenant-only rule (expected ${over30}).`,
    'grep of src/ for tenant names: 0 files.',
  ]);
});
