// Execution of one analytics run (scheduled occurrence or manual request):
//
//   identity check -> parameters -> query (runSql: re-validation under the run role and the
//   CURRENT policy, read-only query role) -> bounded result snapshot -> analyses -> insights ->
//   deliveries -> run outcome.
//
// Phases are recorded separately (query_status, analysis_status, delivery_status, timings), so a
// query failure, an analysis failure and a delivery failure are never confused. Transient
// failures are retried with exponential backoff up to max_attempts; everything else is final.
// Every write checks the lease, so a run recovered by another worker is never written twice.
// Re-running a run (after recovery) is idempotent: the snapshot and analysis results are
// replaced, insights rebuilt, and deliveries are unique per (run, destination).

import { createHash, randomUUID } from 'node:crypto';
import { withSystem, withTenant, type Tx } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { AppError } from '../platform/errors.js';
import { createLogger } from '../platform/logger.js';
import { auditTx } from '../control/audit.js';
import type { Role } from '../control/auth.js';
import { runSql, type RunSqlResult } from '../query/service.js';
import { runAnalysis, type AnalysisOutcome, type InputColumn } from '../analysis/index.js';
import { buildInsights, type InsightDraft } from '../analysis/insights.js';
import { getNarrator, narrateInsight } from '../analysis/narrate.js';
import { createDeliveries, finalizeRun } from '../delivery/deliver.js';
import { checkIdentity } from './identity.js';
import { resolveValues } from './params.js';
import { analysisLimits, type StoredAnalysis } from './saved.js';
import type { Clock } from './clock.js';

const log = createLogger({ service: 'clearline-scheduler' });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Stable UUID from a string (idempotent rows written on retries). */
const stableId = (s: string) => { const h = sha(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export class LostLease extends Error {}

export interface RunContext { workerId: string; clock: Clock }

type FailureClass = 'authorization' | 'validation' | 'query' | 'timeout' | 'resource_limit' | 'result_persistence' | 'analysis' | 'delivery' | 'interrupted' | 'internal';
interface Failure { status: 'failed' | 'denied' | 'cancelled'; query_status: 'failed' | 'denied' | 'timed_out' | 'skipped'; failure_class: FailureClass | null; code: string; message: string; retryable: boolean; requeueWithoutAttempt?: boolean }

export async function claimRun(workerId: string, now: number): Promise<Record<string, any> | null> {
  const cfg = loadConfig();
  return withSystem(async (tx) => {
    const candidates = (await tx.query(`SELECT id, tenant_id FROM core.analytics_runs WHERE status = 'queued' AND next_attempt_at <= $1 ORDER BY next_attempt_at, created_at
      FOR UPDATE SKIP LOCKED LIMIT 20`, [new Date(now)])).rows;
    for (const c of candidates) {
      // The per-tenant bound is decided under a tenant advisory lock, so concurrent workers cannot both exceed it.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('clearline.analytics.' || $1))`, [c.tenant_id]);
      const running = Number((await tx.query(`SELECT count(*) AS n FROM core.analytics_runs WHERE tenant_id = $1 AND status = 'running' AND lease_expires_at > $2`, [c.tenant_id, new Date(now)])).rows[0].n);
      if (running >= cfg.schedulerMaxPerTenant) continue;
      const r = await tx.query(`UPDATE core.analytics_runs SET status = 'running', attempt = attempt + 1, lease_owner = $2, lease_expires_at = $3::timestamptz + make_interval(secs => $4),
          started_at = coalesce(started_at, $3) WHERE id = $1 RETURNING *`, [c.id, workerId, new Date(now), cfg.runLeaseSeconds]);
      return r.rows[0];
    }
    return null;
  });
}

/** Runs whose worker vanished: re-queue (counts as an attempt) or fail as interrupted after max_attempts. */
export async function recoverRuns(now: number): Promise<{ id: string; status: string }[]> {
  return withSystem(async (tx) => {
    const { rows } = await tx.query(`UPDATE core.analytics_runs r SET
        status = CASE WHEN r.attempt >= r.max_attempts THEN 'failed' ELSE 'queued' END,
        query_status = CASE WHEN r.attempt >= r.max_attempts AND r.query_status = 'pending' THEN 'failed' ELSE r.query_status END,
        failure_class = CASE WHEN r.attempt >= r.max_attempts THEN 'interrupted' ELSE r.failure_class END,
        error_code = 'interrupted', error_message = 'The worker stopped before the run finished; ' || CASE WHEN r.attempt >= r.max_attempts THEN 'no attempts remain.' ELSE 'it will be retried.' END,
        next_attempt_at = $1, lease_owner = NULL, lease_expires_at = NULL, finished_at = CASE WHEN r.attempt >= r.max_attempts THEN $1 ELSE NULL END
      WHERE r.id IN (SELECT id FROM core.analytics_runs WHERE status = 'running' AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.status, r.tenant_id, r.attempt`, [new Date(now)]);
    for (const r of rows) {
      await tx.query(`INSERT INTO core.audit_events (tenant_id, actor, role, action, resource, outcome, details, correlation_id) VALUES ($1,'system:run-recovery','system','run.recover',$2,'succeeded',$3,$4)`,
        [r.tenant_id, `run:${r.id}`, JSON.stringify({ attempt: r.attempt, new_status: r.status }), r.id]);
    }
    return rows.map((r) => ({ id: r.id, status: r.status }));
  });
}

async function owned(tx: Tx, runId: string, ctx: RunContext) {
  const r = await tx.query(`UPDATE core.analytics_runs SET lease_expires_at = $3::timestamptz + make_interval(secs => $4) WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING id`,
    [runId, ctx.workerId, new Date(ctx.clock.now()), loadConfig().runLeaseSeconds]);
  if (!r.rowCount) throw new LostLease(`run ${runId} is no longer leased by ${ctx.workerId}`);
}

function classifyThrown(err: unknown): Failure {
  if (err instanceof AppError) {
    if (err.status === 403) return { status: 'denied', query_status: 'denied', failure_class: 'authorization', code: err.code, message: `${err.message} The run identity may not run this query under the current field policy; authorization needs attention.`, retryable: false };
    if (err.status === 429) return { status: 'failed', query_status: 'failed', failure_class: 'resource_limit', code: err.code, message: err.message, retryable: true, requeueWithoutAttempt: true };
    if (err.code === 'too_expensive') return { status: 'failed', query_status: 'failed', failure_class: 'resource_limit', code: err.code, message: err.message, retryable: false };
    if (err.status === 400) return { status: 'failed', query_status: 'failed', failure_class: 'validation', code: err.code, message: err.message, retryable: false };
    return { status: 'failed', query_status: 'failed', failure_class: 'query', code: err.code, message: err.message, retryable: false };
  }
  return { status: 'failed', query_status: 'failed', failure_class: 'internal', code: 'internal_error', message: 'The run failed unexpectedly; it will be retried if attempts remain.', retryable: true };
}

function classifyResult(r: RunSqlResult): Failure {
  const code = r.error?.code ?? 'execution_failed';
  if (r.status === 'timed_out') return { status: 'failed', query_status: 'timed_out', failure_class: 'timeout', code, message: r.error?.message ?? 'Timed out.', retryable: false };
  if (r.status === 'cancelled') return { status: 'cancelled', query_status: 'skipped', failure_class: null, code, message: r.error?.message ?? 'Cancelled.', retryable: false };
  if (code === 'denied_by_database') return { status: 'denied', query_status: 'denied', failure_class: 'authorization', code, message: r.error!.message, retryable: false };
  if (code === 'resource_limit') return { status: 'failed', query_status: 'failed', failure_class: 'resource_limit', code, message: r.error!.message, retryable: true };
  if (code === 'execution_failed') return { status: 'failed', query_status: 'failed', failure_class: 'internal', code, message: r.error!.message, retryable: true };
  return { status: 'failed', query_status: 'failed', failure_class: 'query', code, message: r.error?.message ?? 'The query failed.', retryable: false };
}

/** Notify the schedule's creator in-app when authorization needs attention (no result data). */
async function attentionNotice(tx: Tx, run: Record<string, any>, query: Record<string, any>, message: string) {
  const recipient = run.schedule_id ? (await tx.query(`SELECT created_by FROM core.schedules WHERE id = $1`, [run.schedule_id])).rows[0]?.created_by : run.requested_by;
  if (!recipient) return;
  await tx.query(`INSERT INTO core.notifications (id, tenant_id, recipient, run_id, query_id, kind, severity, title, body, links) VALUES ($1,$2,$3,$4,$5,'authorization','high',$6,$7,'{}')
    ON CONFLICT (id) DO NOTHING`, [stableId(`attention:${run.id}:${run.attempt}`), run.tenant_id, recipient, run.id, query.id, `Authorization needs attention: ${query.name}`, message]);
}

async function fail(run: Record<string, any>, query: Record<string, any>, f: Failure, ctx: RunContext, timings: Record<string, unknown>) {
  const cfg = loadConfig();
  const now = ctx.clock.now();
  await withTenant(run.tenant_id, async (tx) => {
    await owned(tx, run.id, ctx);
    if (f.retryable && (f.requeueWithoutAttempt || run.attempt < run.max_attempts)) {
      const delay = f.requeueWithoutAttempt ? 2_000 : Math.min(cfg.runRetryMaxMs, cfg.runRetryBaseMs * 2 ** (run.attempt - 1));
      await tx.query(`UPDATE core.analytics_runs SET status = 'queued', attempt = attempt - $7::int, next_attempt_at = $2, lease_owner = NULL, lease_expires_at = NULL,
          failure_class = $3, error_code = $4, error_message = $5, timings = $6 WHERE id = $1`,
        [run.id, new Date(now + delay), f.failure_class, f.code, f.message, JSON.stringify(timings), f.requeueWithoutAttempt ? 1 : 0]);
      await auditTx(tx, { tenantId: run.tenant_id, actor: run.run_as_actor, role: run.run_as_role, action: 'run.retry_scheduled', resource: `run:${run.id}`, outcome: 'failed',
        details: { attempt: run.attempt, max_attempts: run.max_attempts, failure_class: f.failure_class, error_code: f.code, retry_in_ms: delay }, correlationId: run.id });
      return;
    }
    await tx.query(`UPDATE core.analytics_runs SET status = $2, query_status = $3, analysis_status = 'skipped', failure_class = $4, error_code = $5, error_message = $6,
        lease_owner = NULL, lease_expires_at = NULL, finished_at = $7, timings = $8 WHERE id = $1`,
      [run.id, f.status, f.query_status, f.failure_class, f.code, f.message, new Date(now), JSON.stringify(timings)]);
    if (run.schedule_id) {
      await tx.query(`UPDATE core.schedules SET last_run_id = $2, attention = CASE WHEN $3 THEN $4 ELSE attention END WHERE id = $1`, [run.schedule_id, run.id, f.status === 'denied', f.message]);
    }
    if (f.status === 'denied') await attentionNotice(tx, run, query, f.message);
    await auditTx(tx, { tenantId: run.tenant_id, actor: run.run_as_actor, role: run.run_as_role, action: f.status === 'denied' ? 'run.denied' : 'run.finish', resource: `run:${run.id}`,
      outcome: f.status === 'denied' ? 'denied' : 'failed',
      details: { query_id: run.query_id, version: run.query_version, schedule_id: run.schedule_id, trigger: run.trigger, status: f.status, failure_class: f.failure_class, error_code: f.code,
        attempt: run.attempt, timings }, correlationId: run.id });
    // Failure notices carry no result data.
    const fresh = (await tx.query(`SELECT * FROM core.analytics_runs WHERE id = $1`, [run.id])).rows[0];
    await createDeliveries(tx, fresh, { querySucceeded: false, failed: true, anomaly: false }, now);
    await finalizeRun(tx, run.id, now);
  });
}

function sameSchema(saved: { name: string; type: string; masked: string | null }[] | null, now: { name: string; type: string; masked: string | null }[]): string | null {
  if (!saved) return null;
  const diffs: string[] = [];
  const names = new Set([...saved.map((c) => c.name), ...now.map((c) => c.name)]);
  for (const n of names) {
    const a = saved.find((c) => c.name === n); const b = now.find((c) => c.name === n);
    if (!a) diffs.push(`new column ${n}`);
    else if (!b) diffs.push(`column ${n} removed`);
    else if (a.type !== b.type) diffs.push(`${n} changed from ${a.type} to ${b.type}`);
    else if (a.masked !== b.masked) diffs.push(`${n} redaction changed (${a.masked ?? 'none'} -> ${b.masked ?? 'none'})`);
  }
  if (!diffs.length && saved.map((c) => c.name).join() !== now.map((c) => c.name).join()) diffs.push('column order changed');
  return diffs.length ? diffs.join('; ') : null;
}

export async function executeRun(run: Record<string, any>, ctx: RunContext): Promise<void> {
  const cfg = loadConfig();
  const t = { queue_wait_ms: Math.max(0, ctx.clock.now() - new Date(run.next_attempt_at ?? run.created_at).getTime()) } as Record<string, any>;
  const phase = async <T>(name: string, f: () => Promise<T>): Promise<T> => { const s = performance.now(); try { return await f(); } finally { t[`${name}_ms`] = Math.round(performance.now() - s); } };
  const { q, v, tz } = await withTenant(run.tenant_id, async (tx) => {
    const q = (await tx.query(`SELECT * FROM core.saved_queries WHERE id = $1`, [run.query_id])).rows[0];
    const v = (await tx.query(`SELECT * FROM core.saved_query_versions WHERE query_id = $1 AND version = $2`, [run.query_id, run.query_version])).rows[0];
    const s = run.schedule_id ? (await tx.query(`SELECT timezone FROM core.schedules WHERE id = $1`, [run.schedule_id])).rows[0] : null;
    return { q, v, tz: s?.timezone ?? 'UTC' };
  });
  if (q.status !== 'active') return fail(run, q, { status: 'cancelled', query_status: 'skipped', failure_class: null, code: 'query_inactive', message: `The saved query is ${q.status}.`, retryable: false }, ctx, t);

  // 1. Identity: the run executes as the schedule's identity, never more.
  const id = await phase('identity', () => checkIdentity(run.tenant_id, run.run_as_actor, run.run_as_role as Role, q, run.id));
  if (!id.ok) return fail(run, q, { status: 'denied', query_status: 'denied', failure_class: 'authorization', code: id.code, message: id.message, retryable: false }, ctx, t);

  // 2. Parameters, resolved for the scheduled occurrence in the schedule's time zone.
  let values: unknown[]; let effective: Record<string, unknown>;
  try { ({ values, effective } = resolveValues(v.parameters, run.parameters, run.occurrence_at ? new Date(run.occurrence_at).getTime() : ctx.clock.now(), tz)); }
  catch (err) { return fail(run, q, { ...classifyThrown(err), failure_class: 'validation' }, ctx, t); }

  // 3. Query, through the one execution path (re-validation under the CURRENT policy, query role, limits).
  let r: RunSqlResult;
  try {
    r = await phase('query', () => runSql({ principal: id.principal, sql: v.sql, params: v.parameters, values, mode: 'run',
      origin: { savedQueryId: q.id, savedQueryVersion: v.version, runId: run.id, resource: `saved_query:${q.id}`, via: run.schedule_id ? `schedule:${run.schedule_id}` : `run:${run.id}` } }));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('run query failed unexpectedly', { run: run.id, error: err as Error });
    return fail(run, q, classifyThrown(err), ctx, t);
  }
  if (r.status !== 'succeeded') return fail(run, q, classifyResult(r), ctx, t);

  // 4. Bounded snapshot (already redacted for the run role) + result metadata, in one transaction.
  const columns = r.columns.map((c, i) => ({ name: c.name, type: c.type, masked: c.masked, sensitive: r.validation.output[i]?.sensitive ?? false, sources: r.validation.output[i]?.sources ?? [] }));
  const body = JSON.stringify(r.rows);
  const drift = sameSchema(v.output_schema, columns);
  const meta = { columns: columns.map(({ sources: _s, ...c }) => c), row_count: r.row_count, truncated: r.truncated, bytes: body.length, execution_id: r.execution_id, executed_sql_sha256: r.executed_sql_sha256,
    schema_changed: drift, parameters: effective };
  try {
    await phase('snapshot', () => withTenant(run.tenant_id, async (tx) => {
      await owned(tx, run.id, ctx);
      await tx.query(`INSERT INTO core.run_results (run_id, tenant_id, columns, rows, row_count, truncated, bytes, sha256, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (run_id) DO UPDATE SET columns = EXCLUDED.columns, rows = EXCLUDED.rows, row_count = EXCLUDED.row_count, truncated = EXCLUDED.truncated, bytes = EXCLUDED.bytes,
          sha256 = EXCLUDED.sha256, expires_at = EXCLUDED.expires_at, created_at = clock_timestamp()`,
        [run.id, run.tenant_id, JSON.stringify(columns), body, r.row_count, r.truncated, body.length, sha(body), new Date(ctx.clock.now() + cfg.runResultRetentionHours * 3600_000)]);
      await tx.query(`UPDATE core.analytics_runs SET query_status = 'succeeded', execution_id = $2, result_meta = $3, policy_epoch = $4, error_code = NULL, error_message = NULL, failure_class = NULL WHERE id = $1`,
        [run.id, r.execution_id, JSON.stringify(meta), r.policy_epoch]);
      if (drift) await tx.query(`UPDATE core.saved_queries SET needs_revalidation = $2 WHERE id = $1`, [q.id, `Run ${run.id} saw a different output than version ${v.version} was saved with: ${drift}. Dependent analyses need revalidation.`]);
    }));
  } catch (err) {
    if (err instanceof LostLease) throw err;
    // The result cannot be kept safely: report it rather than pretending it is recoverable.
    log.error('result snapshot could not be persisted', { run: run.id, error: err as Error });
    return fail(run, q, { status: 'failed', query_status: 'failed', failure_class: 'result_persistence', code: 'result_not_persisted', message: 'The query succeeded but its result could not be stored safely; the run will be retried.', retryable: true }, ctx, t);
  }

  // 5. Analyses on the authorized, bounded result (stale configurations are not reinterpreted).
  const limits = analysisLimits();
  const results: { cfg: StoredAnalysis; outcome: AnalysisOutcome; insights: InsightDraft[] }[] = [];
  const narrator = getNarrator();
  await phase('analysis', async () => {
    for (const a of (v.analyses ?? []) as StoredAnalysis[]) {
      const { state: _s, state_reason, ...cfgOnly } = a;
      const outcome: AnalysisOutcome = a.state === 'needs_revalidation'
        ? { status: 'stale_schema', message: state_reason ?? 'The configuration no longer matches the query output.', algorithm: a.algorithm, algorithm_version: '', result: null, quality: null, limitations: [], input_rows: r.row_count, timings: { prepare_ms: 0, algorithm_ms: 0 } }
        : runAnalysis(cfgOnly as never, { columns: columns as InputColumn[], rows: r.rows, truncated: r.truncated }, limits);
      const insights = buildInsights(cfgOnly as never, outcome);
      for (const ins of insights) (ins as InsightDraft & { narrative?: unknown }).narrative = await narrateInsight(narrator, ins);
      results.push({ cfg: a, outcome, insights });
    }
  });
  const failedAnalyses = results.filter((x) => x.outcome.status === 'algorithm_failure').length;
  const analysisStatus = !results.length ? 'not_configured' : failedAnalyses === results.length ? 'failed' : results.every((x) => x.outcome.status === 'succeeded') ? 'succeeded' : 'partial';
  const anomaly = results.some((x) => x.insights.some((i) => i.notify === 'anomaly' || i.notify === 'threshold'));

  // 6. Persist analyses and insights, create deliveries, record the outcome — atomically.
  const now = ctx.clock.now();
  await withTenant(run.tenant_id, async (tx) => {
    await owned(tx, run.id, ctx);
    await tx.query(`DELETE FROM core.insights WHERE run_id = $1`, [run.id]);
    for (const { cfg: a, outcome: o, insights } of results) {
      const arId = stableId(`analysis:${run.id}:${a.key}`);
      await tx.query(`INSERT INTO core.analysis_runs (id, tenant_id, run_id, query_id, query_version, analysis_key, analysis_type, algorithm, algorithm_version, config, status, message, result, quality, input_rows, timings)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (run_id, analysis_key) DO UPDATE SET status = EXCLUDED.status, message = EXCLUDED.message, result = EXCLUDED.result, quality = EXCLUDED.quality, timings = EXCLUDED.timings,
          algorithm_version = EXCLUDED.algorithm_version, config = EXCLUDED.config, input_rows = EXCLUDED.input_rows`,
        [arId, run.tenant_id, run.id, q.id, v.version, a.key, a.type, o.algorithm, o.algorithm_version, JSON.stringify(a), o.status, o.message,
          o.result ? JSON.stringify({ ...o.result, limitations: o.limitations }) : null, o.quality ? JSON.stringify(o.quality) : null, o.input_rows, JSON.stringify(o.timings)]);
      for (const ins of insights) {
        await tx.query(`INSERT INTO core.insights (id, tenant_id, run_id, analysis_run_id, query_id, kind, severity, metric, title, body, narrative, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [randomUUID(), run.tenant_id, run.id, arId, q.id, ins.kind, ins.severity, ins.metric, ins.title, ins.body, JSON.stringify((ins as any).narrative ?? null), JSON.stringify(ins.evidence)]);
      }
      const { backtest, ...qual } = (o.quality ?? {}) as Record<string, any>;
      await auditTx(tx, { tenantId: run.tenant_id, actor: run.run_as_actor, role: run.run_as_role, action: 'analysis.run', resource: `analysis:${arId}`, outcome: o.status === 'succeeded' ? 'succeeded' : 'failed',
        details: { run_id: run.id, key: a.key, type: a.type, algorithm: o.algorithm, algorithm_version: o.algorithm_version, config_sha256: sha(JSON.stringify(a)), status: o.status, input_rows: o.input_rows,
          timings: o.timings, quality: { ...Object.fromEntries(Object.entries(qual).filter(([, x]) => typeof x !== 'object')), ...(backtest ? { backtest_mae: backtest.mae, backtest_mape: backtest.mape, backtest_origins: backtest.origins, method: backtest.method } : {}) },
          insights: insights.length }, correlationId: run.id });
    }
    t.analyses = Object.fromEntries(results.map((x) => [x.cfg.key, x.outcome.timings]));
    await tx.query(`UPDATE core.analytics_runs SET analysis_status = $2, timings = $3, lease_owner = NULL, lease_expires_at = NULL, status = 'delivering' WHERE id = $1`,
      [run.id, analysisStatus, JSON.stringify(t)]);
    const fresh = (await tx.query(`SELECT * FROM core.analytics_runs WHERE id = $1`, [run.id])).rows[0];
    await createDeliveries(tx, fresh, { querySucceeded: true, failed: analysisStatus === 'failed', anomaly }, now);
    const out = await finalizeRun(tx, run.id, now);
    if (run.schedule_id) await tx.query(`UPDATE core.schedules SET last_run_id = $2, attention = NULL WHERE id = $1`, [run.schedule_id, run.id]);
    await auditTx(tx, { tenantId: run.tenant_id, actor: run.run_as_actor, role: run.run_as_role, action: 'run.finish', resource: `run:${run.id}`, outcome: 'succeeded',
      details: { query_id: q.id, version: v.version, schedule_id: run.schedule_id, trigger: run.trigger, execution_id: r.execution_id, row_count: r.row_count, truncated: r.truncated,
        analysis_status: analysisStatus, status: out.status, delivery_status: out.delivery, schema_changed: !!drift, timings: t, attempt: run.attempt }, correlationId: run.id });
  });
}
