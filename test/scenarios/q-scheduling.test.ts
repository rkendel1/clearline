// Scenario Q — Durable scheduling: due runs execute exactly once, races and crashes are safe,
// pause/resume/cancel behave, time zones and daylight saving are explicit, lost authorization
// stops the next run, a failed query is never reported as delivered, and the scheduler runs in
// the worker process with no client attached. Time is driven by a controllable clock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, ROOT, type Ctx } from '../helpers/harness.js';
import { analytics, expectStatus, DAILY_SQL, DAILY_PARAMS, DAILY_ANOMALY } from '../helpers/analytics.js';
import { loadAnalyticsDataset } from '../../synthetic/analytics-dataset.js';
import { Scheduler } from '../../src/analytics/scheduler.js';
import { claimRun } from '../../src/analytics/runner.js';
import { ManualClock, setAppClock } from '../../src/analytics/clock.js';

process.env.RUN_LEASE_SECONDS = '60';
process.env.RUN_RETRY_BASE_MS = '1000';

let ctx: Ctx;
const clock = new ManualClock(Date.parse('2026-10-01T05:00:00Z'));
before(async () => {
  ctx = await setup();
  await loadAnalyticsDataset(client(ctx, DEV_TOKENS.northwind.operator));
  await ctx.worker.drain();
  setAppClock(clock);
});
after(async () => { setAppClock(undefined); await teardown(ctx); });

const R = () => analytics(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
const A = () => analytics(client(ctx, DEV_TOKENS.northwind.admin), 'northwind');
const runsOf = async (scheduleId: string) => sql(`SELECT * FROM core.analytics_runs WHERE schedule_id = $1 ORDER BY created_at`, [scheduleId]);
const execsOf = async (runId: string) => Number((await sql(`SELECT count(*)::int AS n FROM core.query_executions WHERE run_id = $1`, [runId]))[0].n);
let queryId = '';

test('Scenario Q1: a daily schedule runs at its due time, exactly once per occurrence, also when schedulers race', async () => {
  const lines: string[] = [];
  queryId = expectStatus(await R().create({ name: 'Daily paid', sql: DAILY_SQL, parameters: DAILY_PARAMS, analyses: [DAILY_ANOMALY] }), 201).id;
  // run_as_role is required: a schedule never silently inherits its creator's full role.
  assert.equal((await R().schedule({ query_id: queryId, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-01T06:00', timezone: 'America/New_York' })).status, 400);
  const s = expectStatus(await R().schedule({ query_id: queryId, name: 'Daily at 06:00 New York', recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-01T06:00',
    timezone: 'America/New_York', run_as_role: 'reporter', parameters: { start: '2026-04-04', end: '2026-09-30' } }), 201);
  assert.equal(s.rrule, 'FREQ=DAILY;BYHOUR=6;BYMINUTE=0');
  assert.equal(s.description, 'Daily at 06:00 (America/New_York)');
  assert.equal(new Date(s.next_run_at).toISOString(), '2026-10-01T10:00:00.000Z', '06:00 EDT');
  assert.deepEqual(s.run_as, { actor: 'northwind-reporter', role: 'reporter' });

  const a = new Scheduler({ workerId: 'sched-a' });
  const b = new Scheduler({ workerId: 'sched-b' });
  clock.set('2026-10-01T09:59:00Z');
  assert.equal((await a.tick()).materialized, 0, 'not due yet');
  clock.set('2026-10-01T10:00:00Z');
  // Two schedulers race for the same occurrence and for its run.
  const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
  assert.equal(ra.materialized + rb.materialized, 1, 'the occurrence is materialized once');
  assert.equal(ra.runs + rb.runs, 1, 'and executed once');
  let runs = await runsOf(s.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].trigger, 'schedule');
  assert.equal(new Date(runs[0].occurrence_at).toISOString(), '2026-10-01T10:00:00.000Z');
  assert.equal(await execsOf(runs[0].id), 1);
  assert.equal(runs[0].analysis_status, 'succeeded');
  // Ticking again at the same time creates nothing.
  await Promise.all([a.tick(), b.tick()]);
  assert.equal((await runsOf(s.id)).length, 1);
  // A database-level guarantee too: a second run for the same occurrence is refused.
  await assert.rejects(sql(`INSERT INTO core.analytics_runs (id, tenant_id, query_id, query_version, schedule_id, occurrence_at, trigger, requested_by, run_as_actor, run_as_role)
    SELECT gen_random_uuid(), tenant_id, query_id, query_version, schedule_id, occurrence_at, trigger, requested_by, run_as_actor, run_as_role FROM core.analytics_runs WHERE id = $1`, [runs[0].id]), /duplicate key/);
  const sch = expectStatus(await R().getSchedule(s.id), 200);
  assert.equal(new Date(sch.next_run_at).toISOString(), '2026-10-02T10:00:00.000Z');
  assert.equal(sch.last_run_id, runs[0].id);
  // Next day: one more run.
  clock.set('2026-10-02T10:00:30Z');
  await Promise.all([a.tick(), b.tick()]);
  runs = await runsOf(s.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].query_version, 1);
  lines.push(`daily 06:00 America/New_York -> occurrences 2026-10-01T10:00Z and 2026-10-02T10:00Z; two racing schedulers created and executed each exactly once (unique (schedule, occurrence))`);
  const t = runs[0].timings;
  lines.push(`run timings: queue ${t.queue_wait_ms} ms, identity ${t.identity_ms} ms, query ${t.query_ms} ms, snapshot ${t.snapshot_ms} ms, analysis ${t.analysis_ms} ms`);
  evidence('Scenario Q1 — Due runs, exactly once', lines);
  (globalThis as any).__daily = s.id;
});

test('Scenario Q2: an interrupted run is recovered by another scheduler and completes; missed occurrences do not burst', async () => {
  const lines: string[] = [];
  const s = expectStatus(await R().schedule({ query_id: queryId, recurrence: { frequency: 'hourly' }, start_local: '2026-10-02T11:00', timezone: 'UTC', run_as_role: 'reporter',
    parameters: { start: '2026-04-04', end: '2026-09-30' } }), 201);
  const a = new Scheduler({ workerId: 'sched-dead' });
  clock.set('2026-10-02T11:00:00Z');
  await a.materialize();
  const claimed = await claimRun('sched-dead', clock.now());   // the worker claims it and dies
  assert.ok(claimed);
  const b = new Scheduler({ workerId: 'sched-alive' });
  assert.equal((await b.tick()).runs, 0, 'a live lease is respected');
  clock.advance(61_000);                                         // lease expires
  const rep = await b.tick();
  assert.equal(rep.recovered, 1);
  const [run] = await sql(`SELECT * FROM core.analytics_runs WHERE id = $1`, [claimed!.id]);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.attempt, 2);
  assert.equal(await execsOf(run.id), 1, 'the dead worker never executed it; the query ran once');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.audit_events WHERE action = 'run.recover' AND resource = $1`, [`run:${run.id}`]))[0].n, 1);
  // The scheduler is down for 5 hours: one catch-up run for the latest occurrence, four counted as missed.
  clock.set('2026-10-02T16:30:00Z');
  await b.tick();
  const runs = await runsOf(s.id);
  assert.equal(runs.length, 2);
  assert.equal(new Date(runs[1].occurrence_at).toISOString(), '2026-10-02T16:00:00.000Z');
  assert.equal(runs[1].missed_occurrences, 4);
  lines.push('claimed run abandoned by sched-dead -> lease expired -> recovered and completed by sched-alive (attempt 2, one query execution)');
  lines.push('scheduler down 12:00-16:00 UTC -> one run for 16:00, missed_occurrences = 4');
  expectStatus(await R().scheduleAction(s.id, 'cancel'), 200);
  evidence('Scenario Q2 — Recovery and missed occurrences', lines);
});

test('Scenario Q3: pause, resume and cancel; time zones and daylight saving are explicit', async () => {
  const id = (globalThis as any).__daily as string;
  const sched = new Scheduler({ workerId: 'sched-c' });
  expectStatus(await R().scheduleAction(id, 'pause'), 200);
  clock.set('2026-10-03T10:00:00Z');
  await sched.tick();
  assert.equal((await runsOf(id)).length, 2, 'no run while paused');
  clock.set('2026-10-04T08:00:00Z');
  const resumed = expectStatus(await R().scheduleAction(id, 'resume'), 200);
  assert.equal(new Date(resumed.next_run_at).toISOString(), '2026-10-04T10:00:00.000Z', 'resumes at the next future occurrence; paused ones are not run');
  // Run now: a manual run under the schedule's identity.
  const now = expectStatus(await R().scheduleAction(id, 'run'), 202);
  await sched.tick();
  const [manual] = await sql(`SELECT * FROM core.analytics_runs WHERE id = $1`, [now.run_id]);
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.run_as_role, 'reporter');
  assert.equal(manual.status, 'succeeded');
  // Cancel: final; queued runs are cancelled; resume is refused.
  clock.set('2026-10-04T10:00:00Z');
  await sched.materialize();
  expectStatus(await R().scheduleAction(id, 'cancel'), 200);
  const runs = await runsOf(id);
  assert.equal(runs.at(-1).status, 'cancelled');
  assert.equal((await R().scheduleAction(id, 'resume')).status, 409);
  // DST: the preview shows the spring-forward gap (02:30 runs at 03:30 EDT = 07:30Z) and the fall-back overlap (01:30 runs once).
  const spring = expectStatus(await R().preview({ recurrence: { frequency: 'daily', at: '02:30' }, start_local: '2027-03-13T02:30', timezone: 'America/New_York', count: 3 }), 200);
  assert.deepEqual(spring.next, ['2027-03-13T07:30:00.000Z', '2027-03-14T07:30:00.000Z', '2027-03-15T06:30:00.000Z']);
  const fall = expectStatus(await R().preview({ recurrence: { frequency: 'daily', at: '01:30' }, start_local: '2026-10-31T01:30', timezone: 'America/New_York', count: 3 }), 200);
  assert.deepEqual(fall.next, ['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  // Invalid schedules are rejected server-side with the field at fault.
  for (const [b, field] of [[{ rrule: 'FREQ=YEARLY', recurrence: undefined }, 'rrule'], [{ timezone: 'Nowhere/City' }, 'timezone'], [{ start_local: '2026-02-30T06:00' }, 'start_local'], [{ start_local: '2025-01-01T06:00', recurrence: { frequency: 'once' } }, 'start_local']] as const) {
    const res = await R().schedule({ query_id: queryId, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-11-01T06:00', timezone: 'UTC', run_as_role: 'reporter', parameters: { start: '2026-04-04', end: '2026-09-30' }, ...b });
    assert.equal(res.status, 400, JSON.stringify(b));
    assert.equal(res.body.error.details?.field, field);
  }
  evidence('Scenario Q3 — Pause, resume, cancel, DST', [
    'paused across an occurrence: no run; resumed at the next future occurrence; run-now used the schedule identity (reporter); cancel cancelled the queued run and is final',
    `DST preview America/New_York: daily 02:30 -> ${spring.next.join(', ')} (gap shifts forward); daily 01:30 -> ${fall.next.join(', ')} (overlap runs once)`,
  ]);
});

test('Scenario Q4: lost authorization blocks the next run; a failed query is never reported as delivered', async () => {
  const lines: string[] = [];
  const sched = new Scheduler({ workerId: 'sched-d' });
  // An administrator's schedule that runs as a reporter (delegation is explicit).
  const adminQ = expectStatus(await A().create({ name: 'Paid by status', sql: 'SELECT status, sum(paid_amount) AS paid FROM claim GROUP BY status ORDER BY status' }), 201);
  assert.equal((await R().schedule({ query_id: queryId, recurrence: { frequency: 'daily' }, start_local: '2026-10-05T06:00', timezone: 'UTC', run_as_role: 'admin', parameters: {} })).status, 403, 'a reporter cannot delegate admin');
  const s = expectStatus(await A().schedule({ query_id: adminQ.id, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-05T06:00', timezone: 'UTC', run_as_role: 'reporter' }), 201);
  assert.deepEqual(s.run_as, { actor: 'northwind-admin', role: 'reporter' });
  clock.set('2026-10-05T06:00:00Z');
  await sched.tick();
  assert.equal((await runsOf(s.id))[0].status, 'succeeded');
  // The policy changes: status becomes hidden for reporters. The next run is denied before any query runs.
  const steward = client(ctx, DEV_TOKENS.northwind.admin);
  expectStatus(await steward.post('/api/v1/tenants/northwind/fields/claim/status/policy', { role_access: { reporter: 'hidden' } }), 200);
  clock.set('2026-10-06T06:00:00Z');
  await sched.tick();
  let [, denied] = await runsOf(s.id);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.query_status, 'denied');
  assert.equal(denied.failure_class, 'authorization');
  assert.equal(await execsOf(denied.id), 0, 'nothing ran');
  assert.match(expectStatus(await A().getSchedule(s.id), 200).attention, /authorization needs attention/i);
  // Revoking the identity's token also stops the schedule.
  expectStatus(await steward.post('/api/v1/tenants/northwind/fields/claim/status/policy', { role_access: { reporter: 'full' } }), 200);
  const tok = expectStatus(await steward.post('/api/v1/tenants/northwind/tokens', { name: 'scheduler-bot', role: 'operator' }), 201);
  const bot = analytics(client(ctx, tok.token), 'northwind');
  const botQ = expectStatus(await bot.create({ name: 'Bot daily paid', sql: DAILY_SQL, parameters: DAILY_PARAMS }), 201);
  const bs = expectStatus(await bot.schedule({ query_id: botQ.id, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-07T06:00', timezone: 'UTC', run_as_role: 'operator' }), 201);
  expectStatus(await steward.post('/api/v1/tenants/northwind/tokens/scheduler-bot/revoke', {}), 200);
  clock.set('2026-10-07T06:00:00Z');
  await sched.tick();
  [denied] = await runsOf(bs.id);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error_code, 'identity_revoked');
  lines.push(`admin schedule delegated to reporter: ran; after claim.status became hidden for reporters the next run was denied (${denied.failure_class}), no query executed, schedule flagged for attention`);
  lines.push('token "scheduler-bot" revoked -> its schedule\'s next run denied: identity_revoked');

  // A query failure is a failure, and its notice is not "delivered results".
  const dest = expectStatus(await A().destination({ name: 'Owner inbox', kind: 'in_app', config: { recipients: ['$owner'] }, notify_on: 'always' }), 201);
  const bad = expectStatus(await R().create({ name: 'Divide by zero', sql: 'SELECT sum(paid_amount) / (count(*) - count(*)) AS ratio FROM claim' }), 201);
  const fs = expectStatus(await R().schedule({ query_id: bad.id, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-08T06:00', timezone: 'UTC', run_as_role: 'reporter', destination_ids: [dest.id] }), 201);
  clock.set('2026-10-08T06:00:00Z');
  await sched.tick();
  const [f] = await runsOf(fs.id);
  assert.equal(f.status, 'failed');
  assert.equal(f.query_status, 'failed');
  assert.equal(f.failure_class, 'query');
  assert.equal(f.error_code, 'data_error');
  assert.equal(f.delivery_status, 'delivered', 'the failure notice reached the inbox');
  const notes = expectStatus(await R().notifications(), 200).items.filter((n: any) => n.run_id === f.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'query_failed');
  assert.doesNotMatch(notes[0].body, /Findings/);
  lines.push(`division by zero: run failed (query, data_error); delivery_status delivered refers to the failure notice; run status stays failed`);
  evidence('Scenario Q4 — Authorization loss and failure reporting', lines);
});

test('Scenario Q5: the scheduler runs in the worker process without any client, and survives a restart', async () => {
  const worker = (extra: Record<string, string> = {}) => {
    const out: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/worker-main.ts')], {
      cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', SCHEDULER_TICK_MS: '200', WORKER_POLL_MS: '200', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => out.push(String(d)));
    child.stderr!.on('data', (d) => out.push(String(d)));
    return { child, out, exited: new Promise<number | null>((r) => child.on('exit', (c) => r(c))) };
  };
  setAppClock(undefined);   // real time from here: the worker process uses the system clock
  const waitFor = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 150; i++) {
      const [r] = await sql(`SELECT status FROM core.analytics_runs WHERE id = $1`, [id]);
      if (statuses.includes(r.status)) return r.status;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`run ${id} did not reach ${statuses}`);
  };
  const w1 = worker();
  const r1 = expectStatus(await R().runNow(queryId, { parameters: { start: '2026-04-04', end: '2026-09-30' } }), 202);
  assert.equal(await waitFor(r1.run_id, ['succeeded', 'failed', 'denied']), 'succeeded');
  w1.child.kill('SIGTERM');
  assert.equal(await w1.exited, 0, 'graceful shutdown');
  // While no worker runs, a request is queued durably; a restarted worker picks it up.
  const r2 = expectStatus(await R().runNow(queryId, { parameters: { start: '2026-04-04', end: '2026-09-30' } }), 202);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal((await sql(`SELECT status FROM core.analytics_runs WHERE id = $1`, [r2.run_id]))[0].status, 'queued');
  const w2 = worker();
  assert.equal(await waitFor(r2.run_id, ['succeeded', 'failed', 'denied']), 'succeeded');
  w2.child.kill('SIGTERM');
  assert.equal(await w2.exited, 0);
  assert.ok(w1.out.join('').includes('scheduler started'));
  evidence('Scenario Q5 — Scheduler in the worker process', [
    'worker process (no API client, no GPUI) executed a queued run; SIGTERM -> exit 0',
    'run queued while no worker was running stayed queued, and the restarted worker completed it',
  ]);
});
