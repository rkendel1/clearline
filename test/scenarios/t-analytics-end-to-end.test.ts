// Scenario T — End to end: a saved query for daily paid amounts runs daily on the seeded data,
// detects the known anomaly, persists the insight and delivers a notification. Then the
// execution identity's access is revoked: the next run is denied, and results computed before
// the revocation are not delivered. Also: webhook destinations cannot target private networks,
// tenants cannot see each other's analytics, and the audit trail links every step without values.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { analytics, expectStatus, DAILY_SQL, DAILY_PARAMS, DAILY_ANOMALY } from '../helpers/analytics.js';
import { loadAnalyticsDataset, type AnalyticsTruth } from '../../synthetic/analytics-dataset.js';
import { Scheduler } from '../../src/analytics/scheduler.js';
import { claimRun, executeRun } from '../../src/analytics/runner.js';
import { ManualClock, setAppClock } from '../../src/analytics/clock.js';

let ctx: Ctx;
let truth: AnalyticsTruth;
const clock = new ManualClock(Date.parse('2026-10-01T00:00:00Z'));
const sched = new Scheduler({ workerId: 't-sched' });
before(async () => {
  ctx = await setup();
  truth = await loadAnalyticsDataset(client(ctx, DEV_TOKENS.northwind.operator));
  await ctx.worker.drain();
  setAppClock(clock);
});
after(async () => { setAppClock(undefined); await teardown(ctx); });

const admin = () => client(ctx, DEV_TOKENS.northwind.admin);
const A = () => analytics(admin(), 'northwind');

test('Scenario T1: save -> schedule daily -> detect the known anomaly -> insight -> notification; revoke -> denied, nothing exposed', async () => {
  const lines: string[] = [];
  // A dedicated analyst identity, so revoking it is realistic.
  const tok = expectStatus(await admin().post('/api/v1/tenants/northwind/tokens', { name: 'analyst-dana', role: 'reporter' }), 201);
  const D = analytics(client(ctx, tok.token), 'northwind');
  const q = expectStatus(await D.create({ name: 'Daily paid claims', purpose: 'Alert on unusual payment days', sql: DAILY_SQL, parameters: DAILY_PARAMS,
    analyses: [{ ...DAILY_ANOMALY, recent_points: null }] }), 201);
  const inbox = expectStatus(await A().destination({ name: 'Dana inbox', kind: 'in_app', config: { recipients: ['$owner'] }, notify_on: 'anomaly' }), 201);
  const ops = expectStatus(await A().destination({ name: 'Ops inbox', kind: 'in_app', config: { recipients: ['northwind-operator'] }, notify_on: 'always' }), 201);
  const s = expectStatus(await D.schedule({ query_id: q.id, recurrence: { frequency: 'daily', at: '07:00' }, start_local: '2026-10-01T07:00', timezone: 'America/Chicago',
    run_as_role: 'reporter', destination_ids: [inbox.id] }), 201);
  assert.equal(new Date(s.next_run_at).toISOString(), '2026-10-01T12:00:00.000Z', '07:00 CDT');

  clock.set('2026-10-01T12:00:00Z');
  await sched.tick();
  const [run] = await sql(`SELECT * FROM core.analytics_runs WHERE schedule_id = $1`, [s.id]);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.delivery_status, 'delivered');
  const detail = expectStatus(await D.run(run.id), 200);
  const ins = detail.insights.find((i: any) => i.kind === 'anomaly' && i.title.includes(truth.anomalyDate));
  assert.ok(ins, 'the known anomaly is an insight');
  assert.equal(Math.round(ins.evidence.observed * 100), truth.dailyPaidCents.get(truth.anomalyDate));
  const note = expectStatus(await D.notifications(), 200).items.find((n: any) => n.run_id === run.id);
  assert.equal(note.kind, 'anomaly');
  assert.ok(note.body.includes(truth.anomalyDate));
  assert.match(note.links.run, new RegExp(`/analytics/runs/${run.id}$`));
  lines.push(`daily 07:00 America/Chicago -> run at 12:00Z: anomaly on ${truth.anomalyDate} (observed ${ins.evidence.observed} = ground truth) persisted as an insight and delivered to the analyst's inbox`);

  // A second run completes its query, but its delivery is still pending when access is revoked.
  const pending = expectStatus(await D.runNow(q.id, { destination_ids: [ops.id] }), 202);
  const claimed = await claimRun('t-worker', clock.now());
  assert.equal(claimed!.id, pending.run_id);
  await executeRun(claimed!, { workerId: 't-worker', clock });
  assert.equal((await sql(`SELECT status FROM core.deliveries WHERE run_id = $1`, [pending.run_id]))[0].status, 'pending');
  expectStatus(await admin().post('/api/v1/tenants/northwind/tokens/analyst-dana/revoke', {}), 200);
  await sched.tick();
  const [blocked] = await sql(`SELECT * FROM core.deliveries WHERE run_id = $1`, [pending.run_id]);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.last_error_code, 'identity_revoked');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.notifications WHERE run_id = $1`, [pending.run_id]))[0].n, 0, 'the operator received nothing from it');
  // The next scheduled occurrence is denied before any query runs.
  clock.set('2026-10-02T12:00:00Z');
  await sched.tick();
  const runs = await sql(`SELECT * FROM core.analytics_runs WHERE schedule_id = $1 AND trigger = 'schedule' ORDER BY occurrence_at`, [s.id]);
  assert.equal(runs.length, 2);
  const denied = runs[1];
  assert.deepEqual([denied.status, denied.failure_class, denied.error_code], ['denied', 'authorization', 'identity_revoked']);
  assert.equal(Number((await sql(`SELECT count(*)::int AS n FROM core.query_executions WHERE run_id = $1`, [denied.id]))[0].n), 0);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.run_results WHERE run_id = $1`, [denied.id]))[0].n, 0);
  assert.match(expectStatus(await A().getSchedule(s.id), 200).attention, /no longer has an active token/);
  assert.equal((await D.run(run.id)).status, 401, 'the revoked token can no longer read even its earlier results');
  lines.push('second run executed, then the analyst token was revoked: its pending delivery was BLOCKED (identity_revoked) and nothing reached the operator');
  lines.push('next occurrence (2026-10-02T12:00Z): denied (authorization, identity_revoked), no query executed, no result stored, schedule flagged for attention');

  // The audit trail ties occurrence -> execution -> analysis -> delivery with stable ids, and carries no values.
  const trail = await sql(`SELECT action, outcome, details FROM core.audit_events WHERE correlation_id = $1 OR resource = $2 ORDER BY at, id`, [run.id, `run:${run.id}`]);
  const actions = trail.map((t) => t.action);
  for (const a of ['schedule.occurrence', 'query.execution.requested', 'query.execution', 'analysis.run', 'delivery.attempt', 'run.finish']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  const exec = trail.find((t) => t.action === 'query.execution').details;
  assert.equal(exec.run_id, run.id);
  assert.equal(exec.saved_query_id, q.id);
  assert.equal(exec.via, `schedule:${s.id}`);
  const spikeValue = (truth.dailyPaidCents.get(truth.anomalyDate)! / 100).toFixed(2);
  assert.ok(!JSON.stringify(trail).includes(spikeValue), 'no result values in audit events');
  lines.push(`audit for run ${run.id.slice(0, 8)}: ${[...new Set(actions)].join(' -> ')}; no result values`);
  evidence('Scenario T1 — End to end, then revocation', lines);
});

test('Scenario T2: webhook destinations cannot target private, loopback, link-local or credentialed endpoints', async () => {
  const bad = [
    ['http://example.org/hook', 'https_required'], ['https://127.0.0.1/hook', 'private_address'], ['https://10.1.2.3/hook', 'private_address'], ['https://[::1]/hook', 'private_address'],
    ['https://169.254.169.254/latest/meta-data/', 'private_address'], ['https://[::ffff:192.168.1.10]/x', 'private_address'], ['https://user:pw@example.org/hook', 'credentials_in_url'],
    ['https://example.org:22/hook', 'port_not_allowed'], ['https://localhost/hook', 'private_address'],
  ] as const;
  for (const [url, code] of bad) {
    const r = await A().destination({ name: `bad ${url}`, kind: 'webhook', config: { url, secret_ref: 'X' } });
    assert.ok([400, 422].includes(r.status), `${url}: ${r.status}`);
    assert.equal(r.body.error.code, code, url);
  }
  evidence('Scenario T2 — SSRF', [`refused at configuration: ${bad.map(([u, c]) => `${u} (${c})`).join('; ')}. Send-time DNS checks and connection pinning: test/unit/delivery.test.ts`]);
});

test('Scenario T3: tenants cannot see each other\'s saved queries, schedules, runs, notifications or exports', async () => {
  const bf = analytics(client(ctx, DEV_TOKENS.bluefin.admin), 'bluefin');
  const nwAsBf = analytics(client(ctx, DEV_TOKENS.bluefin.admin), 'northwind');
  const [q] = await sql(`SELECT id FROM core.saved_queries LIMIT 1`);
  for (const r of [await nwAsBf.list(), await nwAsBf.get(q.id), await nwAsBf.runs(), await nwAsBf.notifications()]) assert.equal(r.status, 403);
  assert.equal((await bf.get(q.id)).status, 404, 'a northwind id under bluefin does not exist');
  assert.equal(expectStatus(await bf.list(), 200).items.length, 0);
  assert.equal(expectStatus(await bf.runs(), 200).items.length, 0);
  // Database layer: row-level security scopes every analytics table.
  for (const t of ['saved_queries', 'saved_query_versions', 'schedules', 'analytics_runs', 'run_results', 'analysis_runs', 'insights', 'deliveries', 'notifications', 'exports']) {
    const rows = await sql(`SELECT count(*)::int AS n FROM core.${t} WHERE tenant_id = 'northwind'`, [], { tenant: 'bluefin' });
    assert.equal(rows[0].n, 0, t);
  }
  evidence('Scenario T3 — Tenant isolation', ['bluefin admin: 403 on every northwind analytics route; northwind ids are 404 under bluefin; RLS hides northwind rows of all 10 analytics tables in a bluefin-scoped transaction']);
});
