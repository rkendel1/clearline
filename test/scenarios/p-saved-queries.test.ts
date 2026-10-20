// Scenario P — Saved queries: a validated query becomes a versioned, reusable asset.
// Create (from SQL and from a workspace proposal), parameterize with safely bound values,
// version, duplicate, share, archive; runs keep the exact version that produced them; a
// query change invalidates incompatible analyses; a saved query is not an authorization grant.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { analytics, expectStatus, DAILY_SQL, DAILY_PARAMS, DAILY_ANOMALY } from '../helpers/analytics.js';
import { loadAnalyticsDataset, type AnalyticsTruth } from '../../synthetic/analytics-dataset.js';
import { Scheduler } from '../../src/analytics/scheduler.js';
import { queries } from '../helpers/query.js';

let ctx: Ctx;
let truth: AnalyticsTruth;
before(async () => {
  ctx = await setup();
  truth = await loadAnalyticsDataset(client(ctx, DEV_TOKENS.northwind.operator));
  await ctx.worker.drain();
});
after(async () => { await teardown(ctx); });

const reporter = () => analytics(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
const operator = () => analytics(client(ctx, DEV_TOKENS.northwind.operator), 'northwind');
const admin = () => analytics(client(ctx, DEV_TOKENS.northwind.admin), 'northwind');

test('Scenario P: create, parameterize, execute, version, duplicate, share and archive a saved query', async () => {
  const lines: string[] = [];
  const r = reporter();
  // 1. Create from SQL with typed parameters and an analysis.
  const created = expectStatus(await r.create({ name: 'Daily paid claims', description: 'Paid amount and count per service day', purpose: 'Spot unusual payment days',
    category: 'finance', tags: ['Claims', 'daily'], sql: DAILY_SQL, parameters: DAILY_PARAMS, analyses: [DAILY_ANOMALY] }), 201);
  assert.equal(created.version, 1);
  assert.deepEqual(created.current.output_schema.map((c: any) => [c.name, c.type, c.masked]), [['day', 'date', null], ['paid', 'decimal', null], ['claims', 'integer', null]]);
  assert.deepEqual(created.tags, ['claims', 'daily']);
  assert.equal(created.current.analyses[0].state, 'active');
  const id = created.id;

  // 2. Execute with bound parameters: equal to independent SQL and to ground truth.
  const ex = expectStatus(await r.execute(id, { mode: 'run', parameters: { start: truth.from, end: truth.to } }), 200);
  assert.equal(ex.row_count, 180);
  assert.equal(ex.version, 1);
  const indep = await sql(`SELECT x.service_date::text AS d, sum(x.paid_amount)::text AS p FROM t_northwind.claim x JOIN core.batches b ON b.id = x."_batch_id"
    WHERE x."_is_current" AND b.trust_status = 'trusted' GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(ex.rows.map((row: any[]) => [row[0], row[1]]), indep.map((x) => [x.d, x.p]));
  const spike = ex.rows.find((row: any[]) => row[0] === truth.anomalyDate);
  assert.equal(Math.round(Number(spike[1]) * 100), truth.dailyPaidCents.get(truth.anomalyDate));
  lines.push(`saved query v1 executed with bound parameters: ${ex.row_count} days, equal to independent SQL; ${truth.anomalyDate} paid ${spike[1]} = ground truth`);

  // 3. Parameter values are validated and bound, never interpolated.
  for (const [bad, code] of [[{ start: 'yesterday' }, 'invalid_parameter'], [{ start: "2026-01-01' OR '1'='1" }, 'invalid_parameter'], [{ nope: 1 }, 'unknown_parameter']] as const) {
    const res = await r.execute(id, { mode: 'preview', parameters: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, code);
  }
  const proc = expectStatus(await r.create({ name: 'Claims for a procedure', sql: 'SELECT count(*) AS n FROM claim WHERE procedure_code = :proc AND paid_amount >= :min_paid',
    parameters: [{ name: 'proc', type: 'text', max_length: 40 }, { name: 'min_paid', type: 'decimal', default: '0', min: 0 }] }), 201);
  const normal = expectStatus(await r.execute(proc.id, { mode: 'run', parameters: { proc: '99223' } }), 200);
  const injected = expectStatus(await r.execute(proc.id, { mode: 'run', parameters: { proc: "99223' OR '1'='1" } }), 200);
  assert.ok(Number(normal.rows[0][0]) > 100);
  assert.equal(Number(injected.rows[0][0]), 0, 'an injection attempt is just a value that matches nothing');
  assert.equal((await r.execute(proc.id, { parameters: { proc: '99223', min_paid: -5 } })).status, 400, 'below the declared minimum');
  assert.match(normal.executed_sql, /CAST\(\$1 AS text\)/);
  lines.push(`text parameter "99223' OR '1'='1" bound as a value: 0 rows (vs ${normal.rows[0][0]} for 99223); executed SQL binds CAST($1 AS text)`);
  for (const [s, p, code] of [['SELECT count(*) FROM claim WHERE status = $1', [], 'positional_parameter'], ['SELECT count(*) FROM claim WHERE status = :s', [], 'unknown_parameter'],
    ['SELECT count(*) FROM claim', [{ name: 'unused', type: 'text' }], 'unused_parameter']] as const) {
    const res = await r.create({ name: `bad ${code}`, sql: s, parameters: p });
    assert.equal(res.status, 422, res.text);
    assert.equal(res.body.error.details.issues[0].code, code);
  }

  // 4. A saved query must validate for the saver: no route to restricted fields.
  const restricted = await r.create({ name: 'SSN prefix count', sql: "SELECT count(*) AS n FROM member WHERE ssn LIKE '9%'" });
  assert.equal(restricted.status, 422);
  assert.equal(restricted.body.error.code, 'query_not_permitted');

  // 5. New version: SQL change; runs keep their version; analyses that no longer fit are flagged.
  const sched = new Scheduler({ workerId: 'p-scheduler' });
  const run1 = expectStatus(await r.runNow(id, { parameters: { start: truth.from, end: truth.to } }), 202);
  await sched.drain();
  const v2 = expectStatus(await r.version(id, { sql: DAILY_SQL.replace('count(*) AS claims', 'count(*) AS claims, avg(paid_amount) AS avg_paid'), change_note: 'add average payment' }), 201);
  assert.equal(v2.version, 2);
  assert.equal(v2.current.analyses[0].state, 'active', 'adding a column keeps the analysis valid');
  const v3 = expectStatus(await r.version(id, { sql: DAILY_SQL.replace('sum(paid_amount) AS paid', 'sum(paid_amount) AS total_paid'), change_note: 'rename paid' }), 201);
  assert.equal(v3.current.analyses[0].state, 'needs_revalidation');
  assert.match(v3.current.analyses[0].state_reason, /"paid" is not in the query output/);
  const run3 = expectStatus(await r.runNow(id, { parameters: { start: truth.from, end: truth.to } }), 202);
  await sched.drain();
  const d1 = expectStatus(await r.run(run1.run_id), 200);
  const d3 = expectStatus(await r.run(run3.run_id), 200);
  assert.equal(d1.run.query_version, 1);
  assert.equal(d1.analyses[0].status, 'succeeded');
  assert.equal(d3.run.query_version, 3);
  assert.equal(d3.analyses[0].status, 'stale_schema', 'the stale analysis is not reinterpreted by position or name');
  const execs = await sql(`SELECT run_id, saved_query_version FROM core.query_executions WHERE saved_query_id = $1 AND run_id IS NOT NULL ORDER BY started_at`, [id]);
  assert.deepEqual(execs.map((e) => e.saved_query_version), [1, 3]);
  assert.equal((await sql(`SELECT sql FROM core.saved_query_versions WHERE query_id = $1 AND version = 1`, [id]))[0].sql, DAILY_SQL, 'versions are immutable');
  await assert.rejects(sql(`UPDATE core.saved_query_versions SET sql = 'x' WHERE query_id = $1`, [id]), /append-only/);
  assert.equal(expectStatus(await r.getVersion(id, 1), 200).sql, DAILY_SQL);
  assert.equal((await r.version(id, { sql: v3.current.sql })).status, 409, 'no-op versions are refused');
  lines.push('v1 -> v2 (column added: analysis stays active) -> v3 (column renamed: analysis needs_revalidation, run records stale_schema); runs keep versions 1 and 3');

  // 6. From a workspace proposal (natural language), keeping the question.
  const q = queries(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
  const prop = await q.ask('Show the total paid amount by tenant for the last month.');
  const fromProp = expectStatus(await r.create({ name: 'Last month paid', proposal_id: prop.body.id }), 201);
  assert.equal(fromProp.current.source_proposal_id, prop.body.id);
  assert.equal(fromProp.current.question, 'Show the total paid amount by tenant for the last month.');

  // 7. Library: search, filters, favorites, sharing scope, duplicate, archive.
  expectStatus(await r.favorite(id, true), 200);
  assert.deepEqual(expectStatus(await r.list('?favorite=true'), 200).items.map((x: any) => x.id), [id]);
  assert.deepEqual(expectStatus(await r.list('?q=procedure'), 200).items.map((x: any) => x.name), ['Claims for a procedure']);
  assert.deepEqual(expectStatus(await r.list('?tag=daily'), 200).items.map((x: any) => x.id), [id]);
  assert.equal((await r.meta(id, { sharing: 'tenant' })).status, 403, 'reporters may not share (saved_query:share)');
  assert.equal((await operator().get(id)).status, 404, 'private queries are invisible to others');
  assert.ok(!expectStatus(await operator().list(), 200).items.some((x: any) => x.id === id), 'and absent from their library');
  assert.ok(expectStatus(await admin().list(), 200).items.some((x: any) => x.id === id), 'saved_query:admin lists every query in the tenant (governance)');
  const opQuery = expectStatus(await operator().create({ name: 'Weekly paid (operator)', sql: "SELECT date_trunc('week', service_date)::date AS week, sum(paid_amount) AS paid FROM claim GROUP BY 1 ORDER BY 1", sharing: 'tenant' }), 201);
  const shared = expectStatus(await r.list('?scope=shared'), 200).items;
  assert.deepEqual(shared.map((x: any) => x.id), [opQuery.id]);
  assert.equal((await r.version(opQuery.id, { sql: 'SELECT 1 AS x' })).status, 403, 'only the owner (or an admin) edits');
  const dup = expectStatus(await r.duplicate(opQuery.id, { name: 'My weekly paid' }), 201);
  assert.equal(dup.owner, 'northwind-reporter');
  assert.equal(dup.sharing, 'private');
  assert.equal(dup.duplicated_from, opQuery.id);
  expectStatus(await r.status(dup.id, 'archived'), 200);
  assert.equal((await r.version(dup.id, { sql: 'SELECT 1 AS x' })).status, 409);
  assert.ok(!expectStatus(await r.list(), 200).items.some((x: any) => x.id === dup.id), 'archived queries leave the default list');
  assert.ok(expectStatus(await r.list('?status=archived'), 200).items.some((x: any) => x.id === dup.id));

  // 8. Not an authorization grant: an admin's shared query over a sensitive field is withheld from a reporter and cannot run as one.
  const adminQ = expectStatus(await admin().create({ name: 'SSN prefix count (admin)', sql: "SELECT count(*) AS n FROM member WHERE ssn LIKE '9%'", sharing: 'tenant' }), 201);
  const seen = expectStatus(await r.get(adminQ.id), 200);
  assert.equal(seen.withheld, true);
  assert.equal(seen.current.sql, null);
  assert.equal(seen.executable_now, false);
  const denied = await r.execute(adminQ.id, { mode: 'preview' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'query_not_permitted');
  assert.ok(!JSON.stringify(seen).toLowerCase().includes('ssn like'), 'the SQL is not disclosed');
  lines.push("an admin's shared query filtering on member.ssn: the reporter sees its name only (SQL withheld) and execution is refused (403 query_not_permitted)");

  const actions = (await sql(`SELECT action, count(*)::int AS n FROM core.audit_events WHERE action LIKE 'saved_query.%' GROUP BY 1 ORDER BY 1`)).map((x) => `${x.action}:${x.n}`);
  for (const a of ['saved_query.create', 'saved_query.version', 'saved_query.duplicate', 'saved_query.archive']) assert.ok(actions.some((x) => x.startsWith(a)), a);
  lines.push(`audit: ${actions.join(', ')}`);
  evidence('Scenario P — Saved queries', lines);
});
