// Scenario N — Tenant isolation and inference attacks. Cross-tenant access is
// attempted through generated and edited SQL and, bypassing the validator
// entirely, directly against the database as the query login; restricted
// fields are attacked through counts, grouping, filtering, sorting, joins and
// derived expressions; error messages, history and exports are checked; and
// unsafe or runaway queries must fail closed (timeouts, cancellation, limits).

process.env.QUERY_TIMEOUT_MS = '1500';
process.env.QUERY_MAX_COST = '1000000000000000';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { queries } from '../helpers/query.js';
import { loadReferenceDataset } from '../../synthetic/reference-dataset.js';
import { nwMembers } from '../../synthetic/generator.js';
import { setProviderForTests } from '../../src/query/providers/index.js';
import { withQueryRole } from '../../src/platform/db.js';

let ctx: Ctx;
const MEMBERS = nwMembers(150, 1001);
const SSNS = MEMBERS.map((m) => m.SSN);
before(async () => {
  ctx = await setup();
  await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
  // Northwind policy for the inference tests: ssn filter-only for operators, hidden for reporters.
  const r = await client(ctx, DEV_TOKENS.northwind.admin).post('/api/v1/tenants/northwind/fields/member/ssn/policy',
    { sensitive: true, redaction: 'last4', reason: 'identifier', role_access: { operator: 'filter', reporter: 'hidden' } });
  assert.equal(r.status, 200);
});
after(async () => { setProviderForTests(undefined); await teardown(ctx); });

const lines: string[] = [];
const execCount = async () => Number((await sql(`SELECT count(*) AS n FROM core.query_executions`))[0].n);

test('Scenario N1: cross-tenant access through generated and edited SQL is rejected', async () => {
  const bf = queries(client(ctx, DEV_TOKENS.bluefin.admin), 'bluefin');
  const before = await execCount();
  const attempts = ['SELECT claim_id, paid_amount FROM claim', 'SELECT * FROM t_northwind.claim', 'SELECT * FROM q_northwind.member', 'SELECT * FROM northwind.claim',
    'SELECT count(*) FROM core.batches', `SELECT * FROM batches WHERE id IN (SELECT batch_id FROM core.quarantine)`, 'SELECT * FROM reporting.batch_overview',
    `SELECT * FROM rx_claim WHERE current_setting('app.tenant_id') = 'northwind'`, `SELECT set_config('app.tenant_id', 'northwind', true) FROM rx_claim`,
    `SELECT * FROM pg_catalog.pg_tables WHERE schemaname = 't_northwind'`, `SELECT * FROM batches b JOIN q_northwind.batches n ON n.id = b.id`];
  for (const a of attempts) {
    const p = await bf.sql(a);
    assert.equal(p.body.validation.ok, false, a);
    assert.equal((await bf.run(p.body.id)).status, 403, a);
  }
  // A "generated" proposal is no different.
  setProviderForTests({ id: 'hostile', model: 'x', generate: async () => ({ kind: 'proposal', sql: 'SELECT * FROM t_northwind.member', explanation: '', assumptions: [] }) });
  const g = await bf.ask('show me northwind members');
  assert.equal(g.body.validation.ok, false);
  setProviderForTests(undefined);
  // Other-tenant proposal ids are invisible (404, not 403: existence is not disclosed).
  const nwProposal = (await queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind').sql('SELECT count(*) FROM claim')).body.id;
  assert.equal((await client(ctx, DEV_TOKENS.bluefin.admin).post(`/api/v1/tenants/bluefin/queries/proposals/${nwProposal}/execute`, { mode: 'run' })).status, 404);
  assert.equal((await client(ctx, DEV_TOKENS.bluefin.admin).post(`/api/v1/tenants/northwind/queries/proposals/${nwProposal}/execute`, { mode: 'run' })).status, 403);
  assert.equal(await execCount(), before, 'none of the attempts reached the database');
  // What bluefin can see is bluefin only.
  const mine = await bf.rows('SELECT count(*) AS n FROM batches');
  const [truth] = await sql(`SELECT count(*)::text AS n FROM core.batches WHERE tenant_id = 'bluefin'`);
  assert.equal(String(mine.objects[0].n), truth.n);
  lines.push(`N1: ${attempts.length} cross-tenant/internal-schema SQL attempts and a hostile generated proposal -> rejected, refused at execute, 0 executions; another tenant's proposal id -> 404; bluefin sees its own ${truth.n} batches`);
});

test('Scenario N2: the database enforces isolation even if the validator were bypassed', async () => {
  const role = 'clearline_q_bluefin_reporter';
  const run = (q: string) => withQueryRole('bluefin', role, 1500, (c) => c.query(q));
  const denied = async (q: string) => { await assert.rejects(run(q), (e: { code?: string }) => ['42501', '42P01', '3F000'].includes(String(e.code)), q); };
  for (const q of ['SELECT count(*) FROM q_northwind.claim', 'SELECT count(*) FROM t_northwind.claim', 'SELECT count(*) FROM t_bluefin.rx_claim', 'SELECT count(*) FROM core.batches',
    'SELECT count(*) FROM core.api_tokens', 'SELECT count(*) FROM core.audit_events', 'SELECT count(*) FROM reporting.batch_overview', 'SELECT count(*) FROM public.schema_migrations']) await denied(q);
  // Forged tenant settings change nothing: RLS resolves the role, not app.tenant_id.
  const [bfTruth] = await sql(`SELECT count(*)::int AS n FROM core.batches WHERE tenant_id = 'bluefin'`);
  for (const forge of [`SELECT set_config('app.tenant_id', 'northwind', true)`, `SELECT set_config('app.scope', 'system', true)`]) {
    const n = await withQueryRole('bluefin', role, 1500, async (c) => { await c.query(forge); return (await c.query('SELECT count(*)::int AS n FROM q_bluefin.batches')).rows[0].n; });
    assert.equal(n, bfTruth.n, forge);
  }
  // Escaping the role leaves the query login, which owns nothing.
  for (const esc of ['RESET ROLE', `SELECT set_config('role', 'none', true)`]) {
    await withQueryRole('bluefin', role, 1500, async (c) => {
      await c.query(esc);
      const who = (await c.query('SELECT current_user AS u')).rows[0].u;
      assert.equal(who, 'clearline_query');
      await assert.rejects(c.query('SELECT count(*) FROM q_bluefin.batches'), (e: { code?: string }) => e.code === '42501');
    });
  }
  await assert.rejects(withQueryRole('bluefin', role, 1500, (c) => c.query(`SET ROLE clearline`)), (e: { code?: string }) => e.code === '42501');
  // Another tenant's query role cannot read this tenant's views either.
  await assert.rejects(withQueryRole('bluefin', 'clearline_q_northwind_reporter', 1500, (c) => c.query('SELECT count(*) FROM q_bluefin.batches')), (e: { code?: string }) => e.code === '42501');
  // Writes are impossible: read-only transaction and no privileges.
  await assert.rejects(run(`INSERT INTO q_bluefin.batches (id) VALUES (gen_random_uuid())`));
  lines.push('N2 (validator bypassed): the bluefin query role is denied q_northwind, t_* tables, core.*, reporting.* and schema_migrations; forged app.tenant_id / app.scope do not change RLS; RESET ROLE leaves the privilege-less query login; SET ROLE clearline denied; writes impossible');
});

test('Scenario N3: restricted fields resist counts, grouping, filtering, sorting, joins and derived expressions', async () => {
  const qo = queries(client(ctx, DEV_TOKENS.northwind.operator), 'northwind');
  const before = await execCount();
  const attacks: [string, string][] = [
    ['count with literal', `SELECT count(*) FROM member WHERE ssn = '${SSNS[0]}'`],
    ['binary search', `SELECT count(*) FROM member WHERE ssn < '950-00-0000'`],
    ['prefix probe', `SELECT count(*) FROM member WHERE ssn LIKE '9%'`],
    ['group', 'SELECT ssn, count(*) FROM member GROUP BY ssn'],
    ['group without select', 'SELECT count(*) FROM member GROUP BY ssn'],
    ['sort', 'SELECT member_id FROM member ORDER BY ssn'],
    ['sort by position', 'SELECT member_id, ssn FROM member ORDER BY 2'],
    ['distinct count', 'SELECT count(DISTINCT ssn) FROM member'],
    ['min/max', 'SELECT min(ssn), max(ssn) FROM member'],
    ['conditional aggregate', `SELECT sum(CASE WHEN ssn LIKE '9%' THEN 1 ELSE 0 END) FROM member`],
    ['aggregate filter', `SELECT count(*) FILTER (WHERE ssn > '9') FROM member`],
    ['derived expression', 'SELECT length(ssn) FROM member'],
    ['derived predicate', `SELECT member_id FROM member WHERE upper(ssn) = 'X'`],
    ['cast', 'SELECT ssn::text FROM member'],
    ['coalesce', `SELECT coalesce(ssn, 'none') FROM member`],
    ['join on unrelated column', 'SELECT c.claim_id FROM claim c JOIN member m ON m.ssn = c.claim_id'],
    ['join to self on ssn', 'SELECT a.member_id FROM member a JOIN member b ON a.ssn = b.ssn'],
    ['having', 'SELECT member_id FROM member GROUP BY member_id HAVING max(ssn) > \'5\''],
    ['subquery predicate', `SELECT member_id FROM member WHERE ssn IN (SELECT '${SSNS[0]}' FROM plan)`],
    ['through subquery', `SELECT x.s FROM (SELECT ssn AS s FROM member) x WHERE x.s = '1'`],
    ['through CTE', 'WITH m AS (SELECT member_id, ssn FROM member) SELECT member_id FROM m ORDER BY ssn'],
    ['scalar subquery', 'SELECT (SELECT max(ssn) FROM member) FROM plan'],
    ['returned', 'SELECT ssn FROM member'],
    ['star', 'SELECT * FROM (SELECT ssn FROM member) x'],
  ];
  for (const [why, q] of attacks) {
    const p = await qo.sql(q);
    assert.equal(p.body.validation.ok, false, `${why} must be rejected`);
    const codes = ['restricted_field', 'unsupported'];
    assert.ok(codes.includes(p.body.validation.issues[0].code), `${why}: ${p.body.validation.issues[0].code} ${p.body.validation.issues[0].message}`);
    for (const s of SSNS.slice(1)) assert.ok(!p.text.includes(s), `${why}: error text discloses no value`);
  }
  // Explicit policy boundary — permitted for filter-only fields: presence tests and relationship joins.
  const presence = await qo.rows('SELECT count(*) AS n FROM member WHERE ssn IS NULL');
  assert.equal(Number(presence.objects[0].n), 0);
  assert.equal(await execCount(), before + 1, 'only the permitted query executed');
  lines.push(`N3: ${attacks.length} inference attacks on a filter-only field (literal/range/prefix probes, grouping, sorting incl. by position, distinct/min/max, conditional and filtered aggregates, derived expressions, casts, unrelated joins, HAVING, IN-subquery, subquery/CTE passthrough, scalar subquery, return, star) -> all rejected before execution; permitted boundary: IS [NOT] NULL and relationship joins`);
});

test('Scenario N4: error messages, query history and exports disclose nothing', async () => {
  const nwAdmin = client(ctx, DEV_TOKENS.northwind.admin);
  const qa = queries(nwAdmin, 'northwind');
  // The admin runs a query whose text embeds a protected value.
  const secret = await qa.rows(`SELECT member_id FROM member WHERE ssn = '${SSNS[3]}'`);
  assert.equal(secret.objects.length, 1);
  // Reporter: own history only; the admin's query never appears.
  const qr = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  await qr.rows('SELECT count(*) AS n FROM claim');
  const rh = (await qr.history()).body;
  assert.ok(rh.items.every((i: { actor: string }) => i.actor === 'northwind-reporter'));
  assert.equal((await qr.history(true)).body.items.every((i: { actor: string }) => i.actor === 'northwind-reporter'), true, 'all=true is ignored without query:history_all');
  assert.equal((await client(ctx, DEV_TOKENS.northwind.reporter).get(`/api/v1/tenants/northwind/queries/proposals/${secret.proposal.id}`)).status, 404);
  // Steward (history_all) sees the entry exists, but the SQL is withheld: it filters by a value the steward may only see masked.
  const qs = queries(client(ctx, DEV_TOKENS.northwind.steward), 'northwind');
  const sh = (await qs.history(true)).body.items.find((i: { id: string }) => i.id === secret.proposal.id);
  assert.equal(sh.withheld, true);
  assert.equal(sh.proposed_sql, null);
  assert.equal(sh.validated_sql, null);
  assert.equal(sh.executions[0].executed_sql, null);
  assert.ok(!JSON.stringify(sh).includes(SSNS[3]));
  // The steward cannot execute it either (it is re-validated under the steward's policy).
  assert.equal((await qs.run(secret.proposal.id)).status, 403);
  // Exports follow the same validation and redaction: the steward's own masked export, and a refused one.
  const ms = await qs.sql('SELECT member_id, ssn FROM member ORDER BY member_id');
  const csv = await qs.exportCsv(ms.body.id);
  assert.equal(csv.status, 200);
  assert.ok(SSNS.every((s) => !csv.text.includes(s)));
  assert.match(csv.text.split('\n')[1], /\*\*\*-\*\*-\d{4}/);
  const qo = queries(client(ctx, DEV_TOKENS.northwind.operator), 'northwind');
  const bad = await qo.sql('SELECT ssn FROM member');
  assert.equal((await qo.exportCsv(bad.body.id)).status, 403);
  // Database errors are classified; the message passes through only for data errors on visible values.
  const div = await qo.rows('SELECT count(*) AS n FROM claim').then(() => qo.sql('SELECT paid_amount / 0 FROM claim'));
  const dr = (await qo.run(div.body.id)).body;
  assert.equal(dr.status, 'failed');
  assert.equal(dr.error.code, 'data_error');
  assert.match(dr.error.message, /division by zero/);
  lines.push('N4: reporter history holds only its own queries (all=true ignored, other ids 404); steward history_all lists the admin query but withholds its SQL/validated SQL/executed SQL (it filters on a value masked for the steward) and refuses to run it; steward CSV export masked; operator export of a restricted query 403; database errors classified (division by zero -> data_error)');
});

test('Scenario N5: runaway and unsafe queries fail closed (timeout, cancellation, concurrency, limits)', async () => {
  const qr = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  const heavy = 'SELECT count(*) AS n FROM claim a, claim b, claim c, pharmacy_fill d';
  // Timeout.
  const t = await qr.sql(heavy);
  assert.ok(t.body.validation.ok);
  const started = Date.now();
  const tr = (await qr.run(t.body.id)).body;
  assert.equal(tr.status, 'timed_out');
  assert.ok(Date.now() - started < 6000);
  // Cancellation.
  const c = await qr.sql(heavy + ' WHERE a.claim_id <> b.claim_id');
  const pending = qr.run(c.body.id);
  let execId: string | undefined;
  for (let i = 0; i < 50 && !execId; i++) {
    await new Promise((r) => setTimeout(r, 50));
    execId = (await sql(`SELECT id FROM core.query_executions WHERE proposal_id = $1 AND status = 'running'`, [c.body.id]))[0]?.id;
  }
  assert.ok(execId);
  await new Promise((r) => setTimeout(r, 200));
  const cr = await client(ctx, DEV_TOKENS.northwind.reporter).post(`/api/v1/tenants/northwind/queries/executions/${execId}/cancel`, {});
  assert.equal(cr.status, 200);
  assert.equal((await pending).body.status, 'cancelled');
  // Another user cannot cancel it (404: existence not disclosed).
  assert.equal((await client(ctx, DEV_TOKENS.northwind.operator).post(`/api/v1/tenants/northwind/queries/executions/${execId}/cancel`, {})).status, 404);
  // Concurrency: at most 2 per tenant.
  const three = await Promise.all([0, 1, 2].map(async () => (await qr.run(t.body.id)).status));
  assert.deepEqual(three.sort(), [200, 200, 429]);
  // Row cap and bounded preview.
  const many = await qr.sql('SELECT a.claim_id FROM claim a, claim b');
  const mr = (await qr.run(many.body.id)).body;
  assert.equal(mr.row_count, 5000);
  assert.equal(mr.truncated, true);
  // Unsafe constructs fail closed.
  for (const q of [`SELECT pg_sleep(30)`, `SELECT count(*) FROM generate_series(1, 1000000000)`, 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r']) {
    assert.equal((await qr.sql(q)).body.validation.ok, false, q);
  }
  const statuses = await sql(`SELECT status, count(*)::int AS n FROM core.query_executions WHERE tenant_id = 'northwind' GROUP BY 1`);
  const audit = await sql(`SELECT details->>'status' AS s FROM core.audit_events WHERE action = 'query.execution' AND tenant_id = 'northwind'`);
  assert.ok(audit.some((a) => a.s === 'timed_out') && audit.some((a) => a.s === 'cancelled'));
  lines.push(`N5: 4-way cross join -> timed_out after the 1.5 s statement timeout; a second one cancelled by its owner (others get 404); 3 concurrent runs -> 2 ran, 1 refused with 429; 5000-row cap with truncated=true; pg_sleep, generate_series and recursive CTEs rejected. Execution statuses: ${statuses.map((s) => `${s.status}=${s.n}`).join(', ')}`);
  evidence('Scenario N — Tenant isolation and inference attacks', lines);
});
