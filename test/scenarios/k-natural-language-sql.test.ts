// Scenario K — Natural-language SQL proposal: an analyst asks a question in
// plain English, gets a structurally valid SQL proposal with an explanation,
// generation does not execute anything, and an explicit run returns results
// that match independent SQL written in this file against the base tables.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { queries } from '../helpers/query.js';
import { loadReferenceDataset } from '../../synthetic/reference-dataset.js';
import { setProviderForTests, ProviderUnavailable, type SqlProvider } from '../../src/query/providers/index.js';

let ctx: Ctx;
before(async () => {
  ctx = await setup();
  await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
});
after(async () => { setProviderForTests(undefined); await teardown(ctx); });

const executions = async () => Number((await sql(`SELECT count(*) AS n FROM core.query_executions`))[0].n);
const TRUSTED_CLAIMS = `FROM t_northwind.claim x JOIN core.batches b ON b.id = x."_batch_id" WHERE x."_is_current" AND b.trust_status = 'trusted'`;

test('Scenario K: question -> inspectable proposal -> explicit execution -> results equal independent SQL', async () => {
  const q = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  const lines: string[] = [];

  // 1. The catalog the provider sees: permitted metadata only.
  const cat = await q.catalog();
  assert.equal(cat.status, 200);
  assert.equal(cat.body.provider.id, 'deterministic');
  assert.ok(cat.body.tables.some((t: { name: string }) => t.name === 'claim'));

  // 2. Generate. Nothing runs.
  const before = await executions();
  const p = await q.ask('Show the total paid amount by tenant for the last month.');
  assert.equal(p.status, 201);
  assert.equal(p.body.source, 'generated');
  assert.equal(p.body.executed, false);
  assert.ok(p.body.validation.ok, JSON.stringify(p.body.validation.issues));
  assert.match(p.body.proposed_sql, /sum\(c\.paid_amount\)/);
  assert.ok(p.body.model_explanation.length > 20);
  assert.ok(p.body.validation.summary.some((s: string) => s.startsWith('Reads claim')));
  assert.deepEqual(p.body.validation.tables, ['claim']);
  assert.ok(p.body.validation.columns.some((c: { column: string; usages: string[] }) => c.column === 'paid_amount' && c.usages.includes('aggregate')));
  assert.match(p.body.validated_sql, /FROM q_northwind\.claim AS c/);
  assert.ok(p.body.estimate.cost > 0, 'estimated with EXPLAIN, not executed');
  assert.equal(await executions(), before, 'generation does not execute the query');
  const auditNow = await sql(`SELECT action FROM core.audit_events WHERE tenant_id = 'northwind' AND action LIKE 'query.%' ORDER BY id`);
  assert.deepEqual(auditNow.map((a) => a.action), ['query.request', 'query.proposal.generated', 'query.validation']);
  lines.push(`Question "Show the total paid amount by tenant for the last month." -> proposal ${p.body.id} (provider deterministic), valid, estimated cost ${Math.round(p.body.estimate.cost)}; 0 executions after generation`);

  // 3. Explicit execution; compare with hand-written SQL on the base tables.
  const r = await q.run(p.body.id, 'run');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'succeeded');
  assert.deepEqual(r.body.columns.map((c: { name: string }) => c.name), ['tenant', 'claims', 'total_paid']);
  const [truth] = await sql(`SELECT count(*)::text AS n, coalesce(sum(x.paid_amount), 0)::text AS s ${TRUSTED_CLAIMS}
    AND x.service_date >= date_trunc('month', current_date) - interval '1 month' AND x.service_date < date_trunc('month', current_date)`);
  assert.equal(r.body.rows[0][0], 'northwind');
  assert.equal(String(r.body.rows[0][1]), truth.n);
  assert.equal(String(r.body.rows[0][2] ?? '0'), truth.s === '0' ? '0' : truth.s);
  assert.ok(Number(truth.n) > 0, 'the reference data covers last month');
  assert.equal(await executions(), before + 1);
  lines.push(`Run: ${r.body.rows[0][1]} claims, total paid ${r.body.rows[0][2]} = independent SQL (${truth.n}, ${truth.s}); executed SQL sha256 ${r.body.executed_sql_sha256.slice(0, 12)}`);

  // 4. The remaining example questions, each checked against independent SQL.
  const periods = await q.ask('Compare paid amounts across the last three reporting periods.');
  assert.ok(periods.body.validation.ok);
  const pr = (await q.run(periods.body.id)).body;
  const pTruth = await sql(`SELECT to_char(date_trunc('month', x.service_date), 'YYYY-MM') AS period, count(*)::text AS n, sum(x.paid_amount)::text AS s ${TRUSTED_CLAIMS}
    AND x.service_date >= date_trunc('month', current_date) - interval '3 months' AND x.service_date < date_trunc('month', current_date) GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(pr.rows.map((x: unknown[]) => [x[0], String(x[1]), String(x[2])]), pTruth.map((t) => [t.period, t.n, t.s]));
  assert.equal(pTruth.length, 3);
  lines.push(`"Compare paid amounts across the last three reporting periods." -> ${pr.rows.map((x: unknown[]) => `${x[0]}: ${x[2]}`).join(', ')} (= independent SQL)`);

  const orphans = await q.ask('Find claims that reference members who have not arrived.');
  assert.ok(orphans.body.validation.ok, JSON.stringify(orphans.body.validation.issues));
  const or = (await q.run(orphans.body.id)).body;
  const oTruth = await sql(`SELECT x.claim_id FROM t_northwind.claim x WHERE x."_is_current" AND x.member_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM t_northwind.member m WHERE m."_is_current" AND m.member_id = x.member_id) ORDER BY x.claim_id`);
  assert.deepEqual(or.rows.map((x: unknown[]) => x[0]), oTruth.map((t) => t.claim_id));
  lines.push(`"Find claims that reference members who have not arrived." -> ${or.row_count} claims (= independent SQL)`);

  const recon = await q.ask('Show me batches with reconciliation failures.');
  assert.ok(recon.body.validation.ok);
  const rr = (await q.run(recon.body.id)).body;
  const rTruth = await sql(`SELECT DISTINCT batch_id::text AS id FROM core.reconciliation_results WHERE tenant_id = 'northwind' AND scope = 'batch' AND status = 'failed' ORDER BY 1`);
  assert.deepEqual(rr.rows.map((x: unknown[]) => x[0]).sort(), rTruth.map((t) => t.id));
  assert.ok(rTruth.length >= 1, 'the reference data has a non-reconciling batch');
  lines.push(`"Show me batches with reconciliation failures." -> ${rr.row_count} batch(es) (= independent SQL)`);

  const big = await q.ask('List claims with amounts above $2,000, excluding sensitive member information.');
  assert.ok(big.body.validation.ok);
  assert.ok(!/diagnosis_code|member\b/.test(big.body.proposed_sql.split('FROM')[0]), 'no sensitive or member columns selected');
  const br = (await q.run(big.body.id)).body;
  const bTruth = await sql(`SELECT count(*)::int AS n FROM t_northwind.claim x WHERE x."_is_current" AND x.billed_amount > 2000`);
  assert.match(big.body.proposed_sql, /WHERE billed_amount > 2000/);
  assert.equal(br.row_count, bTruth[0].n);
  assert.ok(!br.columns.some((c: { name: string }) => c.name === 'diagnosis_code'));
  lines.push(`"List claims with amounts above $2,000, excluding sensitive member information." -> ${br.row_count} claims, columns ${br.columns.map((c: { name: string }) => c.name).join(', ')}`);

  // 5. Preview is bounded.
  const all = await q.sql('SELECT claim_id, paid_amount FROM claim ORDER BY claim_id');
  const prev = (await q.run(all.body.id, 'preview')).body;
  assert.equal(prev.row_count, 20);
  assert.equal(prev.truncated, true);
  assert.match(prev.executed_sql, /LIMIT 21/);

  // 6. Edit the proposal: a new proposal linked to its parent, fully re-validated.
  const edited = await q.sql(p.body.proposed_sql.replace("AND c._trust_status = 'trusted'", "AND c._trust_status = 'trusted' AND c.status = 'PAID'"), p.body.id);
  assert.equal(edited.body.source, 'edited');
  assert.equal(edited.body.parent_id, p.body.id);
  assert.ok(edited.body.validation.ok);
  const er = (await q.run(edited.body.id)).body;
  const [eTruth] = await sql(`SELECT count(*)::text AS n ${TRUSTED_CLAIMS} AND x.status = 'PAID'
    AND x.service_date >= date_trunc('month', current_date) - interval '1 month' AND x.service_date < date_trunc('month', current_date)`);
  assert.equal(String(er.rows[0][1]), eTruth.n);
  const badEdit = await q.sql(p.body.proposed_sql + '; DELETE FROM claim', p.body.id);
  assert.equal(badEdit.body.validation.ok, false);
  assert.equal(badEdit.body.validation.issues[0].code, 'multiple_statements');
  assert.equal((await q.run(badEdit.body.id)).status, 403);
  lines.push(`Edited proposal ${edited.body.id} (parent ${p.body.id}) re-validated and run: ${er.rows[0][1]} paid claims (= independent SQL); an edit appending DELETE was rejected (multiple_statements) and refused at execute (403)`);

  // 7. History shows the proposal lifecycle, SQL proposed vs SQL that ran.
  const h = (await q.history()).body.items;
  const hp = h.find((x: { id: string }) => x.id === p.body.id);
  assert.equal(hp.executions[0].status, 'succeeded');
  assert.notEqual(hp.executions[0].executed_sql, hp.proposed_sql, 'executed SQL is the rewritten form, recorded separately');
  const ex = await sql(`SELECT e.executed_sql_sha256, p.validated_sql_sha256 FROM core.query_executions e JOIN core.query_proposals p ON p.id = e.proposal_id WHERE e.proposal_id = $1`, [p.body.id]);
  assert.ok(ex[0].executed_sql_sha256 && ex[0].validated_sql_sha256);
  evidence('Scenario K — Natural-language SQL proposal', lines);
});

test('Scenario K: an unavailable provider fails clearly and recoverably; hostile model output is never executed', async () => {
  const q = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  const down: SqlProvider = { id: 'test-down', model: 'x', generate: async () => { throw new ProviderUnavailable('test-down', 'The model provider could not be reached.', true); } };
  setProviderForTests(down);
  const r = await q.ask('Show the total paid amount by tenant for the last month.');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'provider_unavailable');
  assert.equal(r.body.error.details.retryable, true);
  assert.match(r.body.error.details.hint, /write or paste SQL/);
  // Recoverable: hand-written SQL still works with the provider down.
  const manual = await q.rows('SELECT count(*) AS n FROM claim');
  assert.ok(Number(manual.objects[0].n) > 0);

  const before = await executions();
  for (const hostile of ['DROP TABLE t_northwind.claim', 'SELECT * FROM t_bluefin.rx_claim', 'SELECT ssn FROM member; UPDATE core.batches SET trust_status = \'trusted\'',
    'SELECT token_hash FROM core.api_tokens', `SELECT pg_read_file('/etc/passwd')`]) {
    setProviderForTests({ id: 'test-hostile', model: 'x', generate: async () => ({ kind: 'proposal', sql: hostile, explanation: 'trust me', assumptions: [] }) });
    const h = await q.ask('anything');
    assert.equal(h.status, 201);
    assert.equal(h.body.validation.ok, false, hostile);
    assert.equal(h.body.executable, false);
    assert.equal((await q.run(h.body.id)).status, 403);
  }
  assert.equal(await executions(), before, 'no hostile proposal reached the database');
  setProviderForTests(undefined);
  const [n] = await sql(`SELECT count(*)::int AS n FROM core.query_proposals WHERE status = 'generation_failed'`);
  assert.equal(n.n, 1);
  evidence('Scenario K — provider failure and hostile proposals', [
    'Provider unavailable -> HTTP 503 provider_unavailable (retryable, with a hint to write SQL); a hand-written query still ran',
    '5 hostile model proposals (DROP, cross-tenant table, stacked UPDATE, token table, file read) -> all rejected by validation, refused at execute, 0 executions',
  ]);
});
