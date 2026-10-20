// Scenario R — Delivery: in-app notifications, email over a real SMTP conversation, signed
// webhooks to a local receiver and expiring exports. Retries with backoff, timeouts, permanent
// failure, exhausted attempts, duplicate protection, manual retry without re-running the query,
// and re-authorization: data that became restricted after the query ran is never delivered.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, type Ctx } from '../helpers/harness.js';
import { analytics, expectStatus, webhookReceiver, smtpReceiver, mailText, DAILY_SQL, DAILY_PARAMS, DAILY_ANOMALY } from '../helpers/analytics.js';
import { loadAnalyticsDataset, type AnalyticsTruth } from '../../synthetic/analytics-dataset.js';
import { Scheduler } from '../../src/analytics/scheduler.js';
import { claimRun, executeRun } from '../../src/analytics/runner.js';
import { claimDelivery } from '../../src/delivery/deliver.js';
import { ManualClock, setAppClock } from '../../src/analytics/clock.js';

const SECRET = 'r-scenario-signing-secret';
const smtp = await smtpReceiver();
const hook = await webhookReceiver(SECRET);
Object.assign(process.env, {
  WEBHOOK_ALLOW_PRIVATE: 'true', WEBHOOK_SECRET_HOOK: SECRET, EMAIL_PROVIDER: 'smtp', SMTP_URL: smtp.url, EMAIL_FROM: 'clearline@example.org',
  DELIVERY_TIMEOUT_MS: '500', DELIVERY_RETRY_BASE_MS: '1000', EXPORT_EXPIRY_HOURS: '24',
});

let ctx: Ctx;
let truth: AnalyticsTruth;
const clock = new ManualClock(Date.parse('2026-10-01T05:00:00Z'));
const sched = new Scheduler({ workerId: 'r-sched' });
before(async () => {
  ctx = await setup();
  truth = await loadAnalyticsDataset(client(ctx, DEV_TOKENS.northwind.operator));
  await ctx.worker.drain();
  setAppClock(clock);
});
after(async () => { setAppClock(undefined); await teardown(ctx); await hook.close(); await smtp.close(); });

const R = () => analytics(client(ctx, DEV_TOKENS.northwind.reporter), 'northwind');
const O = () => analytics(client(ctx, DEV_TOKENS.northwind.operator), 'northwind');
const A = () => analytics(client(ctx, DEV_TOKENS.northwind.admin), 'northwind');
const deliveries = (runId: string) => sql(`SELECT d.*, dd.name FROM core.deliveries d JOIN core.delivery_destinations dd ON dd.id = d.destination_id WHERE run_id = $1 ORDER BY dd.name`, [runId]);
const execs = async (runId: string) => Number((await sql(`SELECT count(*)::int AS n FROM core.query_executions WHERE run_id = $1`, [runId]))[0].n);
async function tickUntilSettled(maxSteps = 10) {
  for (let i = 0; i < maxSteps; i++) { await sched.tick(); clock.advance(5_000); }
}

test('Scenario R1: one run delivered to in-app, email (with CSV), a signed webhook (after transient failures) and an export', async () => {
  const lines: string[] = [];
  // Destinations are configured by delivery managers; secrets are references, never values.
  assert.equal((await R().destination({ name: 'x', kind: 'in_app', config: {} })).status, 403, 'reporters cannot manage destinations');
  const inApp = expectStatus(await A().destination({ name: 'Analyst inbox', kind: 'in_app', config: { recipients: ['$owner', 'northwind-operator'] } }), 201);
  const email = expectStatus(await A().destination({ name: 'Finance email', kind: 'email', config: { to: ['finance@example.org'] }, content: 'summary_with_csv', notify_on: 'anomaly' }), 201);
  const web = expectStatus(await A().destination({ name: 'Ops webhook', kind: 'webhook', config: { url: hook.url, secret_ref: 'HOOK', include_rows: true }, max_attempts: 5 }), 201);
  const exp = expectStatus(await A().destination({ name: 'Export', kind: 'export', config: { recipients: ['$owner'] } }), 201);
  assert.deepEqual(web.secrets, { signing: true, auth: null });
  assert.ok(!JSON.stringify(expectStatus(await A().destinations(), 200)).includes(SECRET), 'the secret value is never returned');

  const q = expectStatus(await R().create({ name: 'Daily paid', sql: DAILY_SQL, parameters: DAILY_PARAMS, analyses: [DAILY_ANOMALY] }), 201);
  const s = expectStatus(await R().schedule({ query_id: q.id, recurrence: { frequency: 'daily', at: '06:00' }, start_local: '2026-10-01T06:00', timezone: 'UTC', run_as_role: 'reporter',
    destination_ids: [inApp.id, email.id, web.id, exp.id] }), 201);
  hook.plan.push(503, 503);   // the webhook endpoint is briefly unavailable
  clock.set('2026-10-01T06:00:00Z');
  await sched.tick();
  let [run] = await sql(`SELECT * FROM core.analytics_runs WHERE schedule_id = $1`, [s.id]);
  assert.equal(run.query_status, 'succeeded');
  assert.equal(run.status, 'delivering', 'not reported as complete while a delivery is pending');
  await tickUntilSettled();
  [run] = await sql(`SELECT * FROM core.analytics_runs WHERE id = $1`, [run.id]);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.delivery_status, 'delivered');
  const ds = await deliveries(run.id);
  assert.deepEqual(ds.map((d) => [d.name, d.status, d.attempts]), [['Analyst inbox', 'delivered', 1], ['Export', 'delivered', 1], ['Finance email', 'delivered', 1], ['Ops webhook', 'delivered', 3]]);
  const attempts = await sql(`SELECT outcome, status_code FROM core.delivery_attempts WHERE delivery_id = $1 ORDER BY attempt`, [ds.find((d) => d.name === 'Ops webhook').id]);
  assert.deepEqual(attempts.map((a) => [a.outcome, a.status_code]), [['transient_failure', 503], ['transient_failure', 503], ['delivered', 200]]);

  // Webhook: same delivery id on every attempt (receivers deduplicate), valid signature, versioned payload with bounded rows.
  assert.equal(hook.received.length, 3);
  assert.equal(new Set(hook.received.map((h) => h.headers['clearline-delivery'])).size, 1);
  assert.ok(hook.received.every((h) => h.signatureValid));
  const body = hook.received[2].json;
  assert.equal(body.schema, 'clearline.analytics.delivery/v1');
  assert.equal(body.event, 'run.anomaly');
  assert.equal(body.result.rows_total, 180);
  assert.equal(body.result.rows_included, 100, 'DELIVERY_MAX_ROWS bounds the rows sent');
  assert.ok(body.insights.some((i: any) => i.title.includes(truth.anomalyDate)));
  assert.ok(!hook.received[2].body.includes(SECRET));

  // Email: a real SMTP conversation, summary text, CSV attachment, stable Message-ID.
  assert.equal(smtp.messages.length, 1);
  const m = smtp.messages[0];
  assert.deepEqual(m.to, ['finance@example.org']);
  assert.match(m.data, /Subject: \[Clearline\] Daily paid: anomaly detected/);
  assert.match(m.data, new RegExp(`Message-ID: <${ds.find((d) => d.name === 'Finance email').id}@clearline>`));
  assert.match(m.data, /Content-Disposition: attachment; filename="Daily_paid-[0-9a-f]{8}\.csv"/);
  assert.match(mailText(m.data), new RegExp(`paid for ${truth.anomalyDate} is above its expected range`));

  // In-app: both recipients, scoped to them.
  const mine = expectStatus(await R().notifications(), 200).items.filter((n: any) => n.run_id === run.id);
  const theirs = expectStatus(await O().notifications(), 200).items.filter((n: any) => n.run_id === run.id && n.kind === 'anomaly');
  assert.equal(mine.filter((n: any) => n.kind === 'anomaly').length, 1);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].query_id, null, 'the operator cannot see the private query: content withheld');
  assert.match(theirs[0].body, /no longer have access/);
  assert.equal(expectStatus(await analytics(client(ctx, DEV_TOKENS.bluefin.admin), 'bluefin').notifications(), 200).items.length, 0, 'tenant-scoped');

  // Export: expiring, authorized, audited.
  const exportNote = mine.find((n: any) => n.links?.export);
  const exportId = exportNote.links.export.split('/exports/')[1].split('/')[0];
  const dl = await R().download(exportId);
  assert.equal(dl.status, 200);
  assert.equal(dl.text.split('\n')[0], 'day,paid,claims');
  assert.equal(dl.text.trim().split('\n').length, 181);
  assert.equal((await O().download(exportId)).status, 404, 'not visible to someone who cannot see the query');
  clock.advance(25 * 3600_000);
  assert.equal((await R().download(exportId)).status, 410, 'expired');
  const audits = await sql(`SELECT outcome FROM core.audit_events WHERE action = 'export.download' AND resource = $1 ORDER BY at`, [`export:${exportId}`]);
  assert.deepEqual(audits.map((a) => a.outcome), ['succeeded', 'denied']);
  lines.push(`one scheduled run -> in-app (2 recipients; operator got a status-only notice), email via SMTP with CSV, webhook delivered on attempt 3 after two 503s (same Clearline-Delivery id, valid HMAC signatures), expiring export (downloaded, then 410 after expiry; both audited)`);
  evidence('Scenario R1 — Delivery to every destination', lines);
  expectStatus(await R().scheduleAction(s.id, 'cancel'), 200);   // later tests advance the clock
  (globalThis as any).__r = { q: q.id, web: web.id, inApp: inApp.id };
});

test('Scenario R2: permanent failure, timeout, exhausted attempts and manual retry without re-running the query', async () => {
  const lines: string[] = [];
  const { q } = (globalThis as any).__r;
  const strict = expectStatus(await A().destination({ name: 'Strict webhook', kind: 'webhook', config: { url: hook.url, secret_ref: 'HOOK' }, max_attempts: 2 }), 201);
  const before = hook.received.length;
  hook.plan.push(400);
  const run = expectStatus(await R().runNow(q, { destination_ids: [strict.id] }), 202);
  await tickUntilSettled(3);
  let [r] = await sql(`SELECT * FROM core.analytics_runs WHERE id = $1`, [run.run_id]);
  assert.equal(r.query_status, 'succeeded');
  assert.equal(r.status, 'failed');
  assert.equal(r.failure_class, 'delivery', 'the query succeeded; the delivery failed — reported as such');
  let [d] = await deliveries(r.id);
  assert.deepEqual([d.status, d.attempts, d.last_error_code], ['failed', 1, 'endpoint_rejected'], '4xx is permanent: no retry');
  // Fix the endpoint and retry the delivery only.
  const retried = expectStatus(await R().retry(r.id), 200);
  assert.deepEqual(retried.retried, [d.id]);
  await tickUntilSettled(2);
  [r] = await sql(`SELECT * FROM core.analytics_runs WHERE id = $1`, [r.id]);
  [d] = await deliveries(r.id);
  assert.equal(d.status, 'delivered');
  assert.equal(r.status, 'succeeded');
  assert.equal(await execs(r.id), 1, 'the query was not re-run');
  assert.equal(hook.received.length - before, 2);
  lines.push('webhook answered 400 -> delivery failed after 1 attempt, run failed (failure_class delivery, query succeeded) -> manual retry delivered it; the query ran once');

  // Timeout (endpoint never answers), then success; and attempts exhausted.
  hook.plan.push('hang');
  const t = expectStatus(await R().runNow(q, { destination_ids: [strict.id] }), 202);
  await tickUntilSettled(3);
  [d] = await deliveries(t.run_id);
  const ta = await sql(`SELECT outcome, error_code FROM core.delivery_attempts WHERE delivery_id = $1 ORDER BY attempt`, [d.id]);
  assert.deepEqual(ta.map((a) => [a.outcome, a.error_code]), [['transient_failure', 'timeout'], ['delivered', null]]);
  hook.plan.push(503, 503);
  const x = expectStatus(await R().runNow(q, { destination_ids: [strict.id] }), 202);
  await tickUntilSettled(4);
  [d] = await deliveries(x.run_id);
  assert.deepEqual([d.status, d.attempts], ['failed', 2], 'max_attempts 2 exhausted');
  lines.push('no answer within 500 ms -> timeout (transient) -> retried and delivered; 503 twice with max_attempts 2 -> failed');

  // Duplicate protection: two schedulers process the same due delivery; it is sent once.
  const dup = expectStatus(await R().runNow(q, { destination_ids: [strict.id] }), 202);
  const other = new Scheduler({ workerId: 'r-sched-2' });
  const n0 = hook.received.length;
  await Promise.all([sched.tick(), other.tick()]);
  [d] = await deliveries(dup.run_id);
  assert.equal(d.status, 'delivered');
  assert.equal(hook.received.length - n0, 1, 'sent exactly once');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.notifications WHERE run_id = $1`, [dup.run_id]))[0].n, 0);
  lines.push('two schedulers racing on one due delivery: one webhook request');
  evidence('Scenario R2 — Failures, retries and duplicates', lines);
});

test('Scenario R3: redacted fields stay redacted, and results that became restricted are never delivered', async () => {
  const lines: string[] = [];
  const { web } = (globalThis as any).__r;
  // The reporter's own result: diagnosis_code is redacted (full) for reporters; raw codes must not appear in the payload.
  const q = expectStatus(await R().create({ name: 'Recent claims', sql: 'SELECT claim_id, diagnosis_code, paid_amount FROM claim ORDER BY claim_id LIMIT 20' }), 201);
  assert.equal(q.current.output_schema[1].masked, 'full');
  const n0 = hook.received.length;
  const run = expectStatus(await R().runNow(q.id, { destination_ids: [web] }), 202);
  await tickUntilSettled(2);
  const payload = hook.received[n0];
  assert.ok(payload, 'delivered');
  assert.deepEqual(payload.json.result.columns.map((c: any) => [c.name, c.redacted]), [['claim_id', null], ['diagnosis_code', 'full'], ['paid_amount', null]]);
  assert.ok(payload.json.result.rows.every((row: any[]) => row[1] === '[redacted]'));
  assert.ok(!payload.body.includes('E11.9'), 'raw diagnosis codes never leave');
  lines.push(`webhook rows for the reporter: diagnosis_code arrived as "[redacted]" in all ${payload.json.result.rows.length} rows; raw code absent from the body`);

  // Results computed before a policy change are not delivered after it.
  hook.plan.push(503);
  const r2 = expectStatus(await R().runNow(q.id, { destination_ids: [web] }), 202);
  await sched.tick();   // query runs, first attempt fails (503) while still authorized
  const sent = hook.received.length;
  expectStatus(await client(ctx, DEV_TOKENS.northwind.admin).post('/api/v1/tenants/northwind/fields/claim/paid_amount/policy', { sensitive: true, redaction: 'full', reason: 'scenario R' }), 200);
  await tickUntilSettled(3);
  const [d] = await deliveries(r2.run_id);
  assert.equal(d.status, 'blocked');
  assert.equal(d.last_error_code, 'access_changed');
  assert.match(d.last_error, /paid_amount became redacted/);
  assert.equal(hook.received.length, sent, 'nothing was sent after the change');
  const [rr] = await sql(`SELECT status, failure_class, error_code FROM core.analytics_runs WHERE id = $1`, [r2.run_id]);
  assert.deepEqual([rr.status, rr.failure_class, rr.error_code], ['failed', 'delivery', 'delivery_blocked']);
  // The run detail re-masks the snapshot for the viewer too.
  const page = expectStatus(await R().result(r2.run_id), 200);
  assert.equal(page.columns[2].masked, 'full');
  assert.ok(page.rows.every((row: any[]) => row[2] === '[redacted]'));
  assert.equal(expectStatus(await R().retry(r2.run_id), 200).retried.length, 1);
  await tickUntilSettled(2);
  assert.equal((await deliveries(r2.run_id))[0].status, 'blocked', 'a manual retry is re-authorized too');
  lines.push('run executed, then claim.paid_amount was marked sensitive before delivery -> delivery BLOCKED (access_changed), no request sent, run failed (delivery_blocked); run result page re-masked paid_amount; manual retry blocked again');
  evidence('Scenario R3 — Redaction and re-authorization at delivery', lines);
});

test('Scenario R4: test deliveries report exactly what happened', async () => {
  const { web, inApp } = (globalThis as any).__r;
  const t1 = expectStatus(await A().testDestination(web), 200);
  assert.equal(t1.ok, true);
  assert.equal(hook.received.at(-1)!.json.event, 'test');
  const em = expectStatus(await A().destination({ name: 'Ops email', kind: 'email', config: { to: ['ops@example.org'] } }), 201);
  smtp.deferNext(1);
  const t2 = expectStatus(await A().testDestination(em.id), 200);
  assert.deepEqual([t2.ok, t2.code, t2.status], [false, 'relay_deferred', 451], 'a deferral is reported, not hidden');
  assert.equal(expectStatus(await A().testDestination(em.id), 200).ok, true);
  const noSecret = expectStatus(await A().destination({ name: 'Unconfigured', kind: 'webhook', config: { url: hook.url, secret_ref: 'MISSING' } }), 201);
  const t3 = expectStatus(await A().testDestination(noSecret.id), 200);
  assert.deepEqual([t3.ok, t3.code], [false, 'secret_unavailable']);
  assert.equal(expectStatus(await A().testDestination(inApp), 200).ok, true);
  assert.equal((await A().destination({ name: 'Bad email', kind: 'email', config: { to: ['not-an-address'] } })).status, 422);
  evidence('Scenario R4 — Test deliveries', ['webhook test delivered (event "test"); email test reported a 451 deferral, then succeeded; webhook with a missing secret reported secret_unavailable; invalid address refused at configuration']);
});

test('Scenario R5: a worker that dies while sending: the delivery is recovered after its lease, sent once, and audited', async () => {
  const web = expectStatus(await A().destination({ name: 'Recovery webhook', kind: 'webhook', config: { url: hook.url, secret_ref: 'HOOK' } }), 201);
  // R3 made paid_amount sensitive for reporters; an administrator owns this one.
  const q = expectStatus(await A().create({ name: 'Daily paid (recovery)', sql: DAILY_SQL, parameters: DAILY_PARAMS }), 201);
  const queued = expectStatus(await A().runNow(q.id, { destination_ids: [web.id] }), 202);
  const run = await claimRun('r-worker', clock.now());
  assert.equal(run!.id, queued.run_id);
  await executeRun(run!, { workerId: 'r-worker', clock });
  // A second worker claims the delivery and dies before sending (its lease is never released).
  let claimed: Record<string, any> | null;
  do { claimed = await claimDelivery('r-dead-worker', clock.now()); } while (claimed && claimed.run_id !== queued.run_id);
  assert.ok(claimed, 'the delivery was claimed');
  const before = hook.received.length;
  await sched.tick();
  assert.equal((await deliveries(queued.run_id))[0].status, 'sending', 'not touched while the lease is valid');
  clock.advance(121_000);   // DELIVERY_LEASE_SECONDS (120) has passed
  await tickUntilSettled(3);
  const [d] = await deliveries(queued.run_id);
  assert.equal(d.status, 'delivered');
  assert.equal(d.attempts, 2, 'the interrupted claim counts as an attempt');
  const sent = hook.received.slice(before).filter((r) => r.headers['clearline-delivery'] === d.id);
  assert.equal(sent.length, 1, 'sent exactly once');
  const [r] = await sql(`SELECT status, delivery_status FROM core.analytics_runs WHERE id = $1`, [queued.run_id]);
  assert.deepEqual([r.status, r.delivery_status], ['succeeded', 'delivered']);
  // Every event of the run is retrievable by its correlation id through the audit API.
  const trail = expectStatus(await client(ctx, DEV_TOKENS.northwind.admin).get(`/api/v1/tenants/northwind/audit?correlation_id=${queued.run_id}`), 200);
  const actions = trail.map((e: any) => e.action);
  for (const a of ['query.execution', 'run.finish', 'delivery.recover', 'delivery.attempt']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  assert.ok(trail.every((e: any) => e.correlation_id === queued.run_id));
  evidence('Scenario R5 — Interrupted delivery recovered', [`delivery ${d.id.slice(0, 8)} claimed by a worker that died: left alone while its lease was valid, then recovered (delivery.recover), sent once (Clearline-Delivery ${d.id.slice(0, 8)}), attempts 2; run succeeded/delivered; audit by correlation id: ${[...new Set(actions)].join(', ')}`]);
});
