// Scenario M — Field sensitivity and redaction. A data steward marks a seeded,
// previously public field (claim.provider_npi) sensitive with last-4 masking.
// Every surface that shows it must then return the redacted form to roles that
// may not see the original, the original must stay available only where the
// policy permits it, and the change must be durable and audited.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { queries } from '../helpers/query.js';
import { loadReferenceDataset, type Truth } from '../../synthetic/reference-dataset.js';
import { maskValue } from '../../src/policy/mask.js';
import { buildServer } from '../../src/api/server.js';
import { closePool } from '../../src/platform/db.js';

let ctx: Ctx;
let truth: Truth;
before(async () => {
  ctx = await setup();
  truth = await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
});
after(async () => { await teardown(ctx); });

const POLICY = '/api/v1/tenants/northwind/fields/claim/provider_npi/policy';

test('Scenario M: marking a field sensitive redacts it everywhere, durably, with an audit trail', async () => {
  const lines: string[] = [];
  const npis = new Map((await sql(`SELECT claim_id, provider_npi FROM t_northwind.claim WHERE "_is_current"`)).map((r) => [r.claim_id as string, r.provider_npi as string]));
  const allNpis = [...new Set(npis.values())];
  const leaks = (text: string) => allNpis.filter((n) => text.includes(n));
  const claimId = truth.trustedClaimIds[100];

  // Before: a reporter sees the original (field is public in the contract), and runs a query that is kept in history.
  const reporter = client(ctx, DEV_TOKENS.northwind.reporter);
  const qr = queries(reporter, 'northwind');
  const beforeRun = await qr.rows(`SELECT claim_id, provider_npi FROM claim WHERE claim_id = '${claimId}'`);
  assert.equal(beforeRun.objects[0].provider_npi, npis.get(claimId));

  // 1. The steward marks it sensitive (a tightening change: allowed for policy:manage).
  const steward = client(ctx, DEV_TOKENS.northwind.steward);
  const listed = (await steward.get('/api/v1/tenants/northwind/fields/policies')).body;
  const f0 = listed.entities.find((e: { entity: string }) => e.entity === 'claim').fields.find((f: { field: string }) => f.field === 'provider_npi');
  assert.equal(f0.policy.sensitive, false);
  assert.ok(f0.allowed_redactions.includes('last4'));
  const marked = await steward.post(POLICY, { sensitive: true, redaction: 'last4', reason: 'Provider identifiers are restricted by the network contract' });
  assert.equal(marked.status, 200, marked.text);
  assert.equal(marked.body.change.kind, 'tighten');
  assert.deepEqual(marked.body.effective_access, { admin: 'full', steward: 'masked', operator: 'masked', reporter: 'masked' });
  lines.push(`steward marked claim.provider_npi sensitive (last4); version ${marked.body.policy.version}, policy epoch ${marked.body.policy_epoch}; effective: admin=full, others=masked`);

  // 2. Query workspace: redacted form, computed in the database.
  const after1 = await qr.rows(`SELECT claim_id, provider_npi FROM claim WHERE claim_id = '${claimId}'`);
  assert.equal(after1.objects[0].provider_npi, maskValue(npis.get(claimId)!, 'last4'));
  assert.match(String(after1.objects[0].provider_npi), /^\*{6}\d{4}$/);
  assert.equal(after1.result.columns[1].masked, 'last4');
  const bulk = await qr.rows('SELECT claim_id, provider_npi FROM claim ORDER BY claim_id');
  for (const r of bulk.objects) assert.equal(r.provider_npi, maskValue(npis.get(String(r.claim_id))!, 'last4'));
  // A query that would recover more than the mask (probing, sorting, grouping, deriving) is rejected.
  for (const q of [`SELECT count(*) FROM claim WHERE provider_npi LIKE '1%'`, 'SELECT claim_id FROM claim ORDER BY provider_npi', 'SELECT provider_npi, count(*) FROM claim GROUP BY provider_npi',
    `SELECT substr(provider_npi, 1, 6) FROM claim`, 'SELECT upper(provider_npi) FROM claim', `SELECT count(*) FROM claim WHERE provider_npi = '${npis.get(claimId)}'`]) {
    assert.equal((await qr.sql(q)).body.validation.ok, false, q);
  }
  // History: the earlier execution is flagged as run under an older policy; no result rows were ever stored.
  const hist = (await qr.history()).body;
  const old = hist.items.find((i: { id: string }) => i.id === beforeRun.proposal.id);
  assert.equal(old.stale_policy, true);
  assert.equal(old.executions[0].policy_epoch < hist.policy_epoch, true);
  assert.ok(!('rows' in old.executions[0]));
  lines.push(`query workspace: reporter now receives ${after1.objects[0].provider_npi} (mask applied by core.mask_value); probing/sorting/grouping/derivation over the field rejected; the pre-change execution is flagged stale (no rows stored)`);

  // 3. Every other surface, for an operator (masked) and the reporter.
  const operator = client(ctx, DEV_TOKENS.northwind.operator);
  const recs = (await operator.get('/api/v1/tenants/northwind/entities/claim/records?limit=1000')).body;
  for (const r of recs.records) assert.equal(r.provider_npi, maskValue(npis.get(String(r.claim_id))!, 'last4'));
  const lin = (await operator.get(`/api/v1/tenants/northwind/lineage/claim/${claimId}`)).body;
  for (const v of lin.versions) {
    assert.equal(v.values.provider_npi, maskValue(npis.get(claimId)!, 'last4'));
    if (v.source_row?.mapped_columns) assert.match(String(v.source_row.mapped_columns.RENDERING_NPI), /^\*{6}\d{4}$/, 'raw source column masked too');
  }
  const opCsv = await operator.get('/api/v1/tenants/northwind/extracts/claims/csv');
  const opRows = parse(opCsv.text, { columns: true }) as Record<string, string>[];
  assert.ok(opRows.length > 0 && opRows.every((r) => /^\*{6}\d{4}$/.test(r.provider_npi)));
  assert.match(String(opCsv.headers['x-clearline-redacted-fields']), /provider_npi/);
  const repCsv = await reporter.get('/api/v1/tenants/northwind/extracts/claims/csv');
  const qExport = await qr.exportCsv(bulk.proposal.id);
  assert.equal(qExport.status, 200);
  assert.match(String(qExport.headers['x-clearline-redacted-columns']), /provider_npi/);
  const exc = (await operator.get('/api/v1/tenants/northwind/reports/exceptions')).body;
  for (const [what, text] of [['records', JSON.stringify(recs)], ['lineage', JSON.stringify(lin)], ['operator extract', opCsv.text], ['reporter extract', repCsv.text],
    ['query export', qExport.text], ['query results', JSON.stringify(bulk.result)], ['exception report', JSON.stringify(exc)]] as const) {
    assert.deepEqual(leaks(text), [], `${what}: an original NPI leaked`);
  }
  // BI reporting views no longer expose the column at all.
  const bi = await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 't_northwind' AND table_name IN ('rpt_claim', 'rpt_trusted_claim') AND column_name = 'provider_npi'`);
  assert.equal(bi.length, 0);
  lines.push(`records (${recs.records.length}), lineage (values and raw RENDERING_NPI), claims extract (operator and reporter), query CSV export, exception report: masked, 0 original NPIs; BI views rpt_claim / rpt_trusted_claim dropped the column`);

  // 4. Authorized access to the original, only when policy permits.
  const admin = client(ctx, DEV_TOKENS.northwind.admin);
  const qa = queries(admin, 'northwind');
  assert.equal((await qa.rows(`SELECT provider_npi FROM claim WHERE claim_id = '${claimId}'`)).objects[0].provider_npi, npis.get(claimId));
  const adminDefault = parse((await admin.get('/api/v1/tenants/northwind/extracts/claims/csv')).text, { columns: true }) as Record<string, string>[];
  assert.ok(adminDefault.every((r) => r.provider_npi === 'REDACTED'), 'sensitive values are redacted in extracts unless explicitly requested');
  const adminFull = parse((await admin.get('/api/v1/tenants/northwind/extracts/claims/csv?include_sensitive=true')).text, { columns: true }) as Record<string, string>[];
  assert.ok(adminFull.every((r) => r.provider_npi === npis.get(r.claim_id)));
  assert.equal((await operator.get('/api/v1/tenants/northwind/extracts/claims/csv?include_sensitive=true')).status, 403);

  // The steward can tighten further (even for admins) but cannot widen.
  const tighten = await steward.post(POLICY, { unmask_roles: [] });
  assert.equal(tighten.status, 200);
  assert.equal(tighten.body.effective_access.admin, 'masked');
  assert.equal((await qa.rows(`SELECT provider_npi FROM claim WHERE claim_id = '${claimId}'`)).objects[0].provider_npi, maskValue(npis.get(claimId)!, 'last4'));
  for (const widen of [{ unmask_roles: ['steward'] }, { sensitive: false }, { redaction: 'full', unmask_roles: ['admin'] }]) {
    const w = await steward.post(POLICY, widen);
    assert.equal(w.status, 403, JSON.stringify(widen));
    assert.equal(w.body.error.code, 'policy_widening_not_permitted');
  }
  assert.equal((await reporter.post(POLICY, { sensitive: false })).status, 403, 'reporters cannot change policy at all');
  const restore = await admin.post(POLICY, { unmask_roles: ['admin'] });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.change.kind, 'loosen');
  lines.push('admin: original in queries and in extracts only with include_sensitive; steward removed admin from unmask_roles -> admin masked; steward widening attempts (3) -> 403 policy_widening_not_permitted; admin (policy:grant) restored admin');

  // 5. Durable: a fresh server process state (new pool, rebuilt app) enforces the same policy.
  await ctx.app.close();
  await closePool();
  ctx.app = await buildServer();
  const qr2 = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  assert.equal((await qr2.rows(`SELECT provider_npi FROM claim WHERE claim_id = '${claimId}'`)).objects[0].provider_npi, maskValue(npis.get(claimId)!, 'last4'));

  // 6. Audited, without values.
  const versions = (await steward.get('/api/v1/tenants/northwind/fields/policies/history?entity=claim&field=provider_npi')).body;
  assert.deepEqual(versions.map((v: { version: number; change_kind: string; changed_by: string }) => [v.version, v.change_kind, v.changed_by]),
    [[3, 'loosen', 'northwind-admin'], [2, 'tighten', 'northwind-steward'], [1, 'tighten', 'northwind-steward']]);
  const audit = await sql(`SELECT outcome, actor, details::text AS d FROM core.audit_events WHERE tenant_id = 'northwind' AND action = 'policy.field.update' ORDER BY id`);
  assert.deepEqual(audit.map((a) => a.outcome), ['succeeded', 'succeeded', 'denied', 'denied', 'denied', 'succeeded']);
  // The reporter never reached the policy service: route authorization denied and audited it.
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.audit_events WHERE tenant_id = 'northwind' AND action = 'authz.policy:manage' AND actor = 'northwind-reporter' AND outcome = 'denied'`))[0].n, 1);
  const allAudit = (await sql(`SELECT details::text AS d FROM core.audit_events WHERE tenant_id = 'northwind' AND at > now() - interval '1 hour'`)).map((a) => a.d).join('\n');
  assert.deepEqual(leaks(allAudit.replace(npis.get(claimId)!, '')), [], 'no NPI value in audit payloads (the one claim id literal aside)');
  const exec = await sql(`SELECT masked_columns FROM core.query_executions WHERE masked_columns::text LIKE '%provider_npi%' LIMIT 1`);
  assert.deepEqual(exec[0].masked_columns[0], { column: 'provider_npi', field: 'claim.provider_npi', redaction: 'last4' });
  // The database mask (query results) and the TypeScript mask (other surfaces) are the same function.
  const samples = [...allNpis.slice(0, 50), '912-34-5678', 'ab', '', 'Zoë', '1980-02-03', '2026-10-01T12:00:00.000Z', 'x-1-y-2-z-3', '1234'];
  for (const style of ['full', 'last4', 'first_initial', 'year_only'] as const) {
    const db = await sql(`SELECT v, core.mask_value(v, $1) AS m FROM unnest($2::text[]) AS v`, [style, samples]);
    for (const r of db) assert.equal(r.m, maskValue(r.v, style), `${style}(${r.v})`);
  }
  lines.push('durable: rebuilt server and new connection pool still return the masked value; history: 3 versions (tighten, tighten, loosen) with actors; audit: 3 succeeded + 3 denied policy changes, the reporter attempt denied at authorization, executions record which columns were redacted; no NPI value in audit');
  evidence('Scenario M — Field sensitivity and redaction', lines);
});
