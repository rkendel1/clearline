// Integration tests: the HTTP API against a real database and worker.
// Covers operational endpoints, the role matrix, structural rejection,
// failure + replay, quarantine resolution, retention and subject erasure.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, sql, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS } from '../../synthetic/generator.js';
import { resetConfigForTests } from '../../src/platform/config.js';
import { runRetention } from '../../src/control/retention.js';
import { requestTenant, withTenant } from '../../src/platform/db.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

const NW = '/api/v1/tenants/northwind';

test('operational endpoints: liveness, readiness, metrics, correlation ids', async () => {
  const live = await ctx.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(live.statusCode, 200);
  const ready = await ctx.app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(JSON.parse(ready.body).checks, { database: 'ok', migrations: 'ok' });
  const m = await ctx.app.inject({ method: 'GET', url: '/metrics' });
  for (const name of ['clearline_http_requests_total', 'clearline_backlog_batches', 'clearline_data_freshness_seconds', 'clearline_batch_processing_seconds', 'clearline_workers_live']) {
    assert.ok(m.body.includes(name), name);
  }
  const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${DEV_TOKENS.northwind.reporter}`, 'x-correlation-id': 'test-corr-1' } });
  assert.equal(r.headers['x-correlation-id'], 'test-corr-1');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'.*frame-ancestors 'none'/, 'the API serves no browser content at all');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'no-store', 'API responses are never cached');
  const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-correlation-id': 'evil\nheader' } });
  assert.equal(bad.statusCode, 401);
  assert.notEqual(bad.headers['x-correlation-id'], 'evil\nheader');
});

test('role matrix is enforced by the backend', async () => {
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const expectations: [ReturnType<typeof client>, 'GET' | 'POST', string, number][] = [
    [rep, 'POST', `${NW}/batches`, 403],              // reporters cannot submit
    [rep, 'GET', `${NW}/quarantine`, 403],            // nor see quarantined records
    [rep, 'GET', `${NW}/lineage/claim/X`, 403],
    [rep, 'GET', `${NW}/audit`, 403],
    [op, 'POST', `${NW}/contracts`, 403],             // operators cannot publish contracts
    [op, 'GET', `${NW}/audit`, 403],
    [op, 'POST', `${NW}/subjects/member/NW1/erase`, 403],
    [op, 'POST', `${NW}/retention/run`, 403],
    [client(ctx, DEV_TOKENS.platform), 'POST', `${NW}/batches`, 403],
    [client(ctx, 'cl_not_a_token'), 'GET', `${NW}/reports/business`, 401],
  ];
  for (const [c, method, url, status] of expectations) {
    const r = method === 'GET' ? await c.get(url) : await c.post(url, { source: 'nw_pharmacy_api', records: [{}] });
    assert.equal(r.status, status, `${method} ${url}`);
  }
  const denials = await sql(`SELECT count(*)::int n FROM core.audit_events WHERE outcome = 'denied' AND tenant_id = 'northwind'`);
  assert.ok(denials[0].n >= 9, 'every denial is audited');
});

test('platform admin can provision a tenant; ids are validated', async () => {
  const pa = client(ctx, DEV_TOKENS.platform);
  assert.equal((await pa.post('/api/v1/tenants', { id: 'x"; drop', name: 'bad' })).status, 400);
  assert.equal((await pa.post('/api/v1/tenants', { id: 'okay_t', name: 'ok', retention: { audit_days: 10 } })).status, 400, 'audit must outlive data');
  const ok = await pa.post('/api/v1/tenants', { id: 'okay_t', name: 'Okay' });
  assert.equal(ok.status, 201);
  assert.equal((await pa.post('/api/v1/tenants', { id: 'okay_t', name: 'Okay' })).status, 409);
  const tok = await pa.post('/api/v1/tenants/okay_t/tokens', { name: 'okay-admin', role: 'admin' });
  assert.equal(tok.status, 201);
  assert.match(tok.body.token, /^cl_/);
  const stored = await sql(`SELECT token_hash FROM core.api_tokens WHERE name = 'okay-admin'`);
  assert.notEqual(stored[0].token_hash, tok.body.token, 'tokens are stored hashed');
  assert.equal((await client(ctx, tok.body.token).get('/api/v1/tenants/okay_t/batches')).status, 200);
  // Revocation is immediate, audited, and never exposes secrets.
  const okAdmin = client(ctx, tok.body.token);
  assert.equal((await okAdmin.post('/api/v1/tenants/okay_t/tokens', { name: 'okay-rep', role: 'reporter' })).status, 201);
  const list = (await okAdmin.get('/api/v1/tenants/okay_t/tokens')).body;
  assert.deepEqual(list.map((t: { name: string }) => t.name).sort(), ['okay-admin', 'okay-rep']);
  assert.ok(!JSON.stringify(list).includes('cl_'), 'listing never returns token values');
  assert.equal((await okAdmin.post('/api/v1/tenants/okay_t/tokens/okay-rep/revoke')).status, 200);
  assert.equal((await client(ctx, DEV_TOKENS.northwind.admin).post('/api/v1/tenants/okay_t/tokens/okay-admin/revoke')).status, 403, 'cross-tenant revoke denied');
  assert.equal((await okAdmin.post('/api/v1/tenants/okay_t/tokens/okay-admin/revoke')).status, 200);
  assert.equal((await okAdmin.get('/api/v1/tenants/okay_t/batches')).status, 401, 'revoked token rejected on next request');
});

test('structurally invalid payloads are rejected and recorded, never processed', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const dup = await op.csv('northwind', 'nw_plans_csv', 'PLAN_CD,PLAN_CD\nA,B\n');
  assert.equal(dup.status, 422);
  assert.equal(dup.body.status, 'rejected');
  assert.equal(dup.body.structural_rejection.reason, 'invalid_header');
  const missing = await op.csv('northwind', 'nw_medical_claims_csv', 'CLM_ID\nC1\n');
  assert.equal(missing.status, 422);
  assert.equal(missing.body.structural_rejection.reason, 'missing_required_columns');
  assert.equal((await op.csv('northwind', 'not_a_source', 'A\n1\n')).status, 400);
  assert.equal((await op.json('northwind', 'nw_plans_csv', [{}])).status, 400, 'format not declared for source');
  assert.equal((await op.csv('northwind', 'nw_plans_csv', 'A\n1\n', { control: { record_count: -1 } })).status, 400);
  const b = (await op.get(`${NW}/batches/${dup.body.batch_id}`)).body;
  assert.equal(b.trust_status, 'untrusted');
  assert.equal((await sql(`SELECT count(*)::int n FROM core.raw_records WHERE batch_id = $1`, [dup.body.batch_id]))[0].n, 0);
});

test('a failed batch leaves no effects, is inspectable, and replays safely', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  const members = nwMembers(40, 1101);
  process.env.CLEARLINE_FAULT_INJECTION = 'fail_source=nw_eligibility_csv';
  resetConfigForTests();
  const sub = await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  await ctx.worker.drain();
  const failed = (await op.get(`${NW}/batches/${sub.body.batch_id}`)).body;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.trust_status, 'untrusted');
  assert.equal(failed.failure.reason, 'InjectedFaultError');
  assert.equal(failed.attempts[0].outcome, 'failed');
  assert.equal((await sql(`SELECT count(*)::int n FROM t_northwind.member WHERE "_batch_id" = $1`, [sub.body.batch_id]))[0].n, 0, 'rolled back');
  assert.equal((await sql(`SELECT count(*)::int n FROM core.quality_results WHERE batch_id = $1`, [sub.body.batch_id]))[0].n, 0);
  const exc = (await op.get(`${NW}/reports/exceptions`)).body;
  assert.ok(exc.batches_requiring_review.some((x: { id: string }) => x.id === sub.body.batch_id));
  assert.equal((await op.post(`${NW}/batches/${sub.body.batch_id}/replay`)).status, 200, 'replay re-queues');

  delete process.env.CLEARLINE_FAULT_INJECTION;
  resetConfigForTests();
  await ctx.worker.drain();
  const done = (await op.get(`${NW}/batches/${sub.body.batch_id}`)).body;
  assert.equal(done.status, 'completed');
  assert.equal(done.trust_status, 'trusted');
  assert.deepEqual(done.attempts.map((a: { outcome: string }) => a.outcome), ['failed', 'succeeded']);
  assert.equal(done.accepted_count, 40);
  assert.equal((await op.post(`${NW}/batches/${sub.body.batch_id}/replay`)).status, 400, 'completed batches cannot be replayed');
});

test('quarantine items can be resolved (audited) without being admitted', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const claims = nwClaims(10, nwMembers(40, 1101).map((m) => m.MBR_ID), 1102);
  claims[0] = { ...claims[0], SVC_DT: 'yesterday' };
  await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const q = (await op.get(`${NW}/quarantine`)).body;
  const item = q.find((x: { record_key: string }) => x.record_key === claims[0].CLM_ID);
  assert.ok(item, 'quarantined');
  assert.ok(item.reasons.some((r: { rule_id: string }) => r.rule_id === 'type:service_date'));
  assert.equal(item.source_row, 1);
  assert.equal((await op.post(`${NW}/quarantine/${item.id}/resolve`, {})).status, 400, 'resolution text required');
  const res = await op.post(`${NW}/quarantine/${item.id}/resolve`, { resolution: 'sender will resend corrected row' });
  assert.equal(res.status, 200);
  assert.equal((await op.post(`${NW}/quarantine/${item.id}/resolve`, { resolution: 'again' })).status, 404);
  assert.equal((await sql(`SELECT count(*)::int n FROM t_northwind.claim WHERE "_key" = $1`, [claims[0].CLM_ID]))[0].n, 0);
});

test('subject erasure removes all versions, records the removal, and keeps reconciliation honest', async () => {
  const admin = client(ctx, DEV_TOKENS.northwind.admin);
  const rep = client(ctx, DEV_TOKENS.northwind.reporter);
  const target = nwMembers(40, 1101)[5].MBR_ID;
  const x = await rep.get(`${NW}/extracts/eligibility/csv`);
  assert.ok(x.text.includes(target));
  const before = (await rep.get(`${NW}/reports/business`)).body.metrics.find((m: { id: string }) => m.id === 'members_total').value;
  const er = await admin.post(`${NW}/subjects/member/${target}/erase`);
  assert.equal(er.status, 200);
  assert.equal(er.body.counts.canonical_versions_deleted, 1);
  assert.ok(er.body.affected_exports.some((e: { id: string }) => e.id === x.headers['x-clearline-export-id']), 'prior export flagged for follow-up');
  assert.equal((await sql(`SELECT count(*)::int n FROM t_northwind.member WHERE "_key" = $1`, [target]))[0].n, 0);
  assert.equal((await sql(`SELECT count(*)::int n FROM core.raw_records WHERE payload::text LIKE $1`, [`%${target}%`]))[0].n, 0, 'raw payload purged');
  const erasureLog = await sql(`SELECT key_sha256 FROM core.erasure_log`);
  assert.ok(!JSON.stringify(erasureLog).includes(target), 'erasure log stores only a hash of the key');
  const after = (await rep.get(`${NW}/reports/business`)).body.metrics.find((m: { id: string }) => m.id === 'members_total').value;
  assert.equal(Number(after), Number(before) - 1);
  const recon = (await client(ctx, DEV_TOKENS.northwind.operator).post(`${NW}/reconciliation/run`)).body;
  assert.deepEqual(recon.batch_reverification_failures, [], 'a recorded erasure is not drift');
});

test('retention purges raw payloads and resolved quarantine but keeps provenance', async () => {
  const future = new Date(Date.now() + 400 * 86_400_000);
  const res = await runRetention({ actor: 'test', role: 'admin', correlationId: 'ret' } as never, 'northwind', future);
  assert.ok(res.counts.raw_payloads_purged > 0);
  assert.equal(res.counts.resolved_quarantine_deleted, 1);
  assert.equal(res.counts.audit_events_deleted, 0, 'audit retention (7y default) outlives data');
  const raw = await sql(`SELECT count(*) FILTER (WHERE payload IS NOT NULL)::int live, count(*) FILTER (WHERE row_hash IS NULL)::int nohash FROM core.raw_records WHERE tenant_id = 'northwind'`);
  assert.deepEqual(raw[0], { live: 0, nohash: 0 });
  const lin = (await client(ctx, DEV_TOKENS.northwind.admin).get(`${NW}/lineage/member/${nwMembers(40, 1101)[0].MBR_ID}`)).body;
  assert.ok(lin.versions[0].batch.payload_digest || lin.versions[0].batch.id, 'batch provenance remains after payload purge');
});

test('data layer refuses a tenant transaction that does not match the request principal (independent of route checks)', async () => {
  // Simulates a route that forgot to authorize: the request is bound to bluefin but code asks for northwind.
  await assert.rejects(requestTenant.run({ tenantId: 'bluefin', actor: 'bug' }, () => withTenant('northwind', async (tx) => (await tx.query('SELECT 1')).rows)),
    (e: Error & { code?: string }) => e.code === 'cross_tenant_denied');
  await assert.rejects(requestTenant.run({ tenantId: null, actor: 'platform' }, () => withTenant('northwind', async () => 1)),
    (e: Error & { code?: string }) => e.code === 'cross_tenant_denied', 'platform admins can never open a tenant scope');
  assert.equal(await requestTenant.run({ tenantId: 'northwind', actor: 'ok' }, () => withTenant('northwind', async () => 'ok')), 'ok');
  assert.equal(await withTenant('northwind', async () => 'worker'), 'worker', 'no binding outside requests (worker, CLI)');
});

test('platform admin cannot escalate into tenant data: bootstrap-only token issuance and revocation', async () => {
  const pa = client(ctx, DEV_TOKENS.platform);
  const asAdmin = await pa.post('/api/v1/tenants/northwind/tokens', { name: 'pa-escalation', role: 'admin' });
  assert.equal(asAdmin.status, 403);
  assert.equal(asAdmin.body.error.code, 'bootstrap_only', 'northwind already has an admin');
  assert.equal((await pa.post('/api/v1/tenants/northwind/tokens', { name: 'pa-rep', role: 'reporter' })).status, 403);
  assert.equal((await pa.post('/api/v1/tenants/northwind/tokens/northwind-admin/revoke')).status, 403, 'cannot revoke admins to re-bootstrap');
  const appr = await pa.post('/api/v1/tenants/northwind/tokens', { name: 'northwind-approver-2', role: 'approver' });
  assert.equal(appr.status, 201, 'approver tokens (no data access) are issued by the platform admin');
  assert.equal((await client(ctx, appr.body.token).get('/api/v1/tenants/northwind/reports/business')).status, 403);
  assert.equal((await pa.post('/api/v1/tenants/northwind/tokens/northwind-approver-2/revoke')).status, 200);
  const ev = (await client(ctx, DEV_TOKENS.northwind.admin).get('/api/v1/tenants/northwind/audit?action=token')).body.map((e: { action: string; outcome: string }) => `${e.action}:${e.outcome}`);
  for (const want of ['token.issue:denied', 'token.revoke:denied', 'token.issue:succeeded', 'token.revoke:succeeded']) assert.ok(ev.includes(want), want);
});

test('audit trail records reads (subject keys hashed), resolutions, retention and erasure; the database enforces its retention floor', async () => {
  const admin = client(ctx, DEV_TOKENS.northwind.admin);
  const key = nwMembers(40, 1101)[7].MBR_ID;
  assert.equal((await admin.get(`${NW}/lineage/member/${key}`)).status, 200);
  const reads = (await admin.get(`${NW}/audit?action=access.read`)).body;
  const lin = reads.find((e: { resource: string }) => e.resource === '/api/v1/tenants/:tenant/lineage/:entity/:key');
  assert.ok(lin, 'lineage read audited');
  assert.match(lin.details.params.key, /^sha256:[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(reads).includes(key), 'raw subject key never stored in the append-only audit trail');
  const actions = new Set((await admin.get(`${NW}/audit?limit=5000`)).body.map((e: { action: string }) => e.action));
  for (const a of ['quarantine.resolve', 'retention.run', 'subject.erase', 'extract.run', 'batch.submit', 'batch.process', 'batch.replay']) assert.ok(actions.has(a), `audited: ${a}`);
  // Even in a retention session, young audit rows cannot be deleted.
  await assert.rejects(sql(`SELECT set_config('app.audit_retention_purge', 'on', true); DELETE FROM core.audit_events WHERE tenant_id = 'northwind'`), /younger than the retention period/);
});

test('sensitive-looking values in non-sensitive fields are never echoed and are scrubbed from raw payloads', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const claims = nwClaims(3, nwMembers(40, 1101).map((m) => m.MBR_ID), 1103, 70_001);
  claims[0] = { ...claims[0], PROC_CD: '912-34-5678' };   // an SSN in a mapped, internal, free-text field
  const sub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS));
  await ctx.worker.drain();
  const msgs = JSON.stringify(await sql(`SELECT message FROM core.quality_findings WHERE batch_id = $1`, [sub.body.batch_id]));
  assert.ok(msgs.includes('procedure_code'), msgs);
  assert.ok(!msgs.includes('912-34-5678'), 'value redacted in findings');
  assert.ok(!JSON.stringify(await sql(`SELECT errors FROM core.quarantine WHERE batch_id = $1`, [sub.body.batch_id])).includes('912-34-5678'));
  const raw = await sql(`SELECT payload FROM core.raw_records WHERE batch_id = $1 AND row_number = 1`, [sub.body.batch_id]);
  assert.equal(raw[0].payload.PROC_CD, '[scrubbed: sensitive value detected]');
});

test('input edge cases return 4xx, never 500', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  assert.equal((await op.get(`${NW}/batches/not-a-uuid/findings`)).status, 404);
  assert.equal((await op.get(`${NW}/quarantine?batch_id=nope`)).status, 400);
  assert.equal((await op.get(`${NW}/lineage/__proto__/x`)).status, 404);
  assert.equal((await op.get(`${NW}/entities/constructor/records`)).status, 404);
  assert.equal((await op.csv('northwind', '__proto__', 'A\n1\n')).status, 400);
});
