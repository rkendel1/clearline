// Scenario G — Privacy violations: cross-tenant access and unauthorized
// sensitive-field export are denied and audited, at the API and at the SQL
// layer (database roles + row-level security). Default outputs are redacted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, TEST_DB, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, toCsv, NW_MEMBER_COLUMNS, BF_PLANS, bfEnrollees, BF_ENROLLEE_COLUMNS } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

const ADMIN_URL = process.env.PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

test('Scenario G: cross-tenant and sensitive-export attempts are denied and audited', async () => {
  const nwOp = client(ctx, DEV_TOKENS.northwind.operator);
  const bfOp = client(ctx, DEV_TOKENS.bluefin.operator);
  const members = nwMembers(30, 701);
  const enrollees = bfEnrollees(10, 711);
  await nwOp.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await nwOp.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  await bfOp.json('bluefin', 'bf_plans_api', BF_PLANS);
  await bfOp.csv('bluefin', 'bf_enrollment_csv', toCsv(enrollees as never, BF_ENROLLEE_COLUMNS));
  await ctx.worker.drain();

  // --- API: cross-tenant reads with valid credentials for another tenant
  const bfReporter = client(ctx, DEV_TOKENS.bluefin.reporter);
  const bfAdmin = client(ctx, DEV_TOKENS.bluefin.admin);
  const attempts = [
    await bfReporter.get('/api/v1/tenants/northwind/reports/business'),
    await bfAdmin.get('/api/v1/tenants/northwind/extracts/eligibility/csv'),
    await bfAdmin.get(`/api/v1/tenants/northwind/lineage/member/${members[0].MBR_ID}`),
    await bfAdmin.post('/api/v1/tenants/northwind/batches', { source: 'nw_pharmacy_api', records: [{}] }),
  ];
  for (const a of attempts) { assert.equal(a.status, 403); assert.equal(a.body.error.code, 'cross_tenant_denied'); }
  const platform = await client(ctx, DEV_TOKENS.platform).get('/api/v1/tenants/northwind/reports/business');
  assert.equal(platform.status, 403, 'platform admins have no tenant data access');
  assert.equal((await client(ctx, 'cl_not_a_real_token').get('/api/v1/me')).status, 401);
  assert.equal((await bfReporter.post('/api/v1/tenants/bluefin/contracts', {})).status, 403, 'reporters cannot publish contracts');

  // --- API: unauthorized sensitive-field export
  const nwReporter = client(ctx, DEV_TOKENS.northwind.reporter);
  const denied = await nwReporter.get('/api/v1/tenants/northwind/extracts/eligibility/csv?include_sensitive=true');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'sensitive_export_denied');
  const opDenied = await nwOp.get('/api/v1/tenants/northwind/extracts/eligibility/csv?include_sensitive=true');
  assert.equal(opDenied.status, 403);

  // Default extract: sensitive columns redacted, no leakage of any real value.
  const redacted = await nwReporter.get('/api/v1/tenants/northwind/extracts/eligibility/csv');
  assert.equal(redacted.status, 200);
  const rows = parse(redacted.text, { columns: true }) as Record<string, string>[];
  assert.equal(rows.length, 30);
  for (const col of ['first_name', 'last_name', 'date_of_birth', 'gender']) assert.ok(rows.every((r) => r[col] === 'REDACTED'), col);
  for (const m of members) for (const v of [m.FIRST_NM + ',', m.SSN]) assert.ok(!redacted.text.includes(v), 'no sensitive value leaked');
  assert.equal(redacted.headers['x-clearline-redacted-fields'], 'first_name,last_name,date_of_birth,gender');

  // Admin may export sensitive fields; that is audited too.
  const nwAdmin = client(ctx, DEV_TOKENS.northwind.admin);
  const full = await nwAdmin.get('/api/v1/tenants/northwind/extracts/eligibility/csv?include_sensitive=true');
  assert.equal(full.status, 200);
  assert.ok(full.text.includes(members[0].LAST_NM));

  // Reads by operators are redacted in records and lineage.
  const recs = (await nwOp.get('/api/v1/tenants/northwind/entities/member/records')).body.records;
  assert.ok(recs.every((r: Record<string, unknown>) => r.ssn === '[redacted]' && r.date_of_birth === '[redacted]'));
  const lin = (await nwOp.get(`/api/v1/tenants/northwind/lineage/member/${members[0].MBR_ID}`)).body.versions[0];
  assert.equal(lin.source_row.mapped_columns.SSN, '[redacted]');
  assert.equal(lin.values.first_name, '[redacted]');

  // --- Audit trail recorded every denial in the targeted tenant (and attempts in the caller's tenant).
  const audit = (await nwAdmin.get('/api/v1/tenants/northwind/audit?limit=500')).body;
  const deniedEvents = audit.filter((e: { outcome: string }) => e.outcome === 'denied');
  assert.ok(deniedEvents.filter((e: { details: { reason: string } }) => e.details.reason === 'cross_tenant').length >= 4);
  assert.ok(deniedEvents.some((e: { action: string; actor: string; details: { reason: string } }) => e.action === 'extract.run' && e.actor === 'northwind-reporter' && e.details.reason === 'sensitive_fields_not_permitted'));
  assert.ok(audit.some((e: { action: string; outcome: string; details: { sensitive_included: boolean } }) => e.action === 'extract.run' && e.outcome === 'succeeded' && e.details.sensitive_included === true));
  const bfAudit = (await bfAdmin.get('/api/v1/tenants/bluefin/audit?action=authz.cross_tenant_attempt')).body;
  assert.ok(bfAudit.length >= 4, 'attempts also visible to the attacker-side tenant admins');
  const auditJson = JSON.stringify(audit);
  assert.ok(!members.some((m) => auditJson.includes(m.SSN) || auditJson.includes(m.LAST_NM + '"')), 'audit details never contain record values');

  // Audit is append-only even for the service role.
  await assert.rejects(sql(`UPDATE core.audit_events SET outcome = 'allowed' WHERE outcome = 'denied'`), /append-only/);
  await assert.rejects(sql(`DELETE FROM core.audit_events`), /append-only/);

  // --- SQL layer: a BI login granted the bluefin reporting role
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS bi_bluefin_user`);
  await admin.query(`CREATE ROLE bi_bluefin_user LOGIN PASSWORD 'bi-test' IN ROLE clearline_rpt_bluefin`);
  const bi = new pg.Client({ connectionString: `postgres://bi_bluefin_user:bi-test@localhost:5432/${TEST_DB}` });
  await bi.connect();
  try {
    const tenantsSeen = (await bi.query(`SELECT DISTINCT tenant_id FROM reporting.batch_overview`)).rows.map((r) => r.tenant_id);
    assert.deepEqual(tenantsSeen, ['bluefin']);
    await bi.query(`SELECT set_config('app.tenant_id', 'northwind', false)`);
    const spoof = (await bi.query(`SELECT DISTINCT tenant_id FROM reporting.batch_overview`)).rows.map((r) => r.tenant_id);
    assert.deepEqual(spoof, ['bluefin'], 'setting app.tenant_id does not widen a BI role');
    await assert.rejects(bi.query(`SELECT * FROM t_northwind.rpt_member`), /permission denied/);
    await assert.rejects(bi.query(`SELECT * FROM t_bluefin.enrollee`), /permission denied/, 'base tables not granted');
    await assert.rejects(bi.query(`SELECT * FROM core.raw_records`), /permission denied/);
    const cols = (await bi.query(`SELECT * FROM t_bluefin.rpt_enrollee LIMIT 1`)).fields.map((f) => f.name);
    assert.ok(!cols.includes('full_name') && !cols.includes('birth_date') && !cols.includes('email'), 'sensitive columns excluded from reporting views');
    assert.equal((await bi.query(`SELECT count(*)::int AS n FROM t_bluefin.rpt_enrollee`)).rows[0].n, enrollees.length);
  } finally {
    await bi.end();
    await admin.query(`DROP OWNED BY bi_bluefin_user; DROP ROLE bi_bluefin_user`).catch(() => {});
    await admin.end();
  }

  evidence('Scenario G — Privacy violation', [
    'bluefin reporter/admin tokens against 4 northwind endpoints (report, extract, lineage, submit): all HTTP 403 cross_tenant_denied; platform admin denied tenant data; invalid token 401.',
    'northwind reporter and operator requesting include_sensitive=true: HTTP 403 sensitive_export_denied, audited as extract.run/denied.',
    `Default eligibility extract: first_name/last_name/date_of_birth/gender = REDACTED in all ${rows.length} rows; no generated name or SSN appears in the payload.`,
    'Audit: denials recorded in the targeted tenant and attempts in the caller tenant; UPDATE/DELETE on audit_events rejected by trigger.',
    'SQL: BI login in clearline_rpt_bluefin sees only bluefin rows in reporting views (even after setting app.tenant_id=northwind), is denied t_northwind views, base tables and raw records, and reporting views omit pii/phi columns.',
  ]);
});
