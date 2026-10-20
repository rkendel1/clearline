// Reading runs, results, analyses and insights — re-authorized for the viewer every time.
//
// A run's snapshot was produced (and redacted) for the run identity's role. Before presenting it,
// the saved SQL is re-validated for the VIEWER's role under the CURRENT policy:
//   - the viewer must be able to see the saved query (owner or shared);
//   - if the SQL is not permitted for the viewer now, rows and insights are withheld;
//   - columns redacted for the viewer but not in the snapshot are re-masked with the same
//     redaction function the database uses, and insights computed over them are withheld.

import { withTenant } from '../platform/db.js';
import { AppError, conflict, notFound } from '../platform/errors.js';
import { can, type Principal } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { maskValue, type RedactionStyle } from '../policy/mask.js';
import { validateFor } from '../query/service.js';
import { requiredColumns } from '../analysis/index.js';
import { loadQuery, type StoredAnalysis } from './saved.js';
import { insertRun } from './schedules.js';
import { retryDeliveries } from './scheduler.js';
import { appClock, type Clock } from './clock.js';

async function loadRun(p: Principal, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('run');
  return withTenant(p.tenantId!, async (tx) => {
    const run = (await tx.query(`SELECT * FROM core.analytics_runs WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId])).rows[0];
    if (!run) throw notFound('run');
    const q = await loadQuery(tx, p, run.query_id);
    const v = (await tx.query(`SELECT * FROM core.saved_query_versions WHERE query_id = $1 AND version = $2`, [run.query_id, run.query_version])).rows[0];
    return { run, q, v };
  });
}

export interface ViewerAccess { data: boolean; reason: string | null; remask: Map<number, RedactionStyle>; restricted: Set<string> }

export async function viewerAccess(p: Principal, run: Record<string, any>, v: Record<string, any>): Promise<ViewerAccess> {
  const none = (reason: string): ViewerAccess => ({ data: false, reason, remask: new Map(), restricted: new Set() });
  if (run.query_status !== 'succeeded') return none('The run produced no result.');
  if (!can(p, 'analysis:read')) return none(`Role ${p.role} may not read analysis results.`);
  const { validation } = await validateFor(p, v.sql, v.parameters);
  if (!validation.ok) return none(`The query's results are not available to your role under the current field policy (${validation.issues[0]?.code}).`);
  const cols: { name: string; masked: string | null }[] = run.result_meta?.columns ?? [];
  const remask = new Map<number, RedactionStyle>();
  const restricted = new Set<string>();
  cols.forEach((c, i) => {
    const now = validation.output[i]?.masked as RedactionStyle | null;
    if (now && now !== c.masked) { remask.set(i, now); restricted.add(c.name); }
  });
  return { data: true, reason: null, remask, restricted };
}

function runJson(r: Record<string, any>, showData: boolean) {
  return {
    id: r.id, query_id: r.query_id, query_version: r.query_version, schedule_id: r.schedule_id, occurrence_at: r.occurrence_at, trigger: r.trigger, requested_by: r.requested_by,
    run_as: { actor: r.run_as_actor, role: r.run_as_role }, status: r.status, query_status: r.query_status, analysis_status: r.analysis_status, delivery_status: r.delivery_status,
    failure_class: r.failure_class, error_code: r.error_code, error_message: r.error_message, attempt: r.attempt, max_attempts: r.max_attempts, next_attempt_at: r.next_attempt_at,
    missed_occurrences: r.missed_occurrences, execution_id: r.execution_id, policy_epoch: r.policy_epoch, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
    timings: r.timings, parameters: showData ? r.parameters : null,
    result: r.result_meta ? { columns: r.result_meta.columns, row_count: r.result_meta.row_count, truncated: r.result_meta.truncated, bytes: r.result_meta.bytes, schema_changed: r.result_meta.schema_changed,
      parameters: showData ? r.result_meta.parameters : null } : null,
  };
}

export async function listRuns(p: Principal, f: { query_id?: string; schedule_id?: string; status?: string; limit: number }) {
  return withTenant(p.tenantId!, async (tx) => {
    const { rows } = await tx.query(`SELECT r.*, q.name AS query_name FROM core.analytics_runs r JOIN core.saved_queries q ON q.id = r.query_id
      WHERE r.tenant_id = $1 AND (q.owner_actor = $2 OR q.sharing = 'tenant' OR $7) AND ($3::uuid IS NULL OR r.query_id = $3) AND ($4::uuid IS NULL OR r.schedule_id = $4) AND ($5::text IS NULL OR r.status = $5)
      ORDER BY r.created_at DESC LIMIT $6`, [p.tenantId, p.actor, f.query_id ?? null, f.schedule_id ?? null, f.status ?? null, f.limit, can(p, 'saved_query:admin')]);
    const ids = rows.map((r) => r.id);
    const ds = ids.length ? (await tx.query(`SELECT run_id, status, count(*)::int AS n, max(attempts)::int AS attempts FROM core.deliveries WHERE run_id = ANY($1) GROUP BY 1, 2`, [ids])).rows : [];
    return { items: rows.map((r) => ({ ...runJson(r, false), query_name: r.query_name, deliveries: ds.filter((d) => d.run_id === r.id).map(({ run_id: _r, ...d }) => d) })) };
  });
}

export async function getRun(p: Principal, id: string) {
  const { run, q, v } = await loadRun(p, id);
  const access = await viewerAccess(p, run, v);
  const detail = await withTenant(p.tenantId!, async (tx) => ({
    deliveries: (await tx.query(`SELECT d.id, d.destination_id, dd.name AS destination, d.kind, d.status, d.attempts, d.max_attempts, d.next_attempt_at, d.last_error_code, d.last_error, d.delivered_at, d.created_at,
        (SELECT json_agg(json_build_object('attempt', a.attempt, 'outcome', a.outcome, 'status_code', a.status_code, 'error_code', a.error_code, 'error', a.error, 'duration_ms', a.duration_ms, 'at', a.finished_at) ORDER BY a.attempt)
           FROM core.delivery_attempts a WHERE a.delivery_id = d.id) AS attempts_log
      FROM core.deliveries d JOIN core.delivery_destinations dd ON dd.id = d.destination_id WHERE d.run_id = $1 ORDER BY d.created_at`, [id])).rows,
    analyses: (await tx.query(`SELECT * FROM core.analysis_runs WHERE run_id = $1 ORDER BY analysis_key`, [id])).rows,
    insights: (await tx.query(`SELECT * FROM core.insights WHERE run_id = $1 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, created_at`, [id])).rows,
    exports: (await tx.query(`SELECT id, file_name, bytes, row_count, truncated, expires_at, downloads, content IS NOT NULL AS available FROM core.exports WHERE run_id = $1`, [id])).rows,
  }));
  const blocked = (a: Record<string, any>) => requiredColumns(a.config as StoredAnalysis).some((c) => access.restricted.has(c.name));
  const analyses = detail.analyses.map((a) => {
    const hide = !access.data || blocked(a);
    return { id: a.id, key: a.analysis_key, type: a.analysis_type, algorithm: a.algorithm, algorithm_version: a.algorithm_version, config: a.config, status: a.status, message: a.message,
      quality: hide ? null : a.quality, result: hide ? null : a.result, input_rows: a.input_rows, timings: a.timings, review: a.review, withheld: hide && a.result !== null };
  });
  const hiddenAnalyses = new Set(analyses.filter((a) => a.withheld).map((a) => a.id));
  const insights = detail.insights.filter((i) => i.kind === 'status' || (access.data && !hiddenAnalyses.has(i.analysis_run_id)))
    .map((i) => ({ id: i.id, analysis_run_id: i.analysis_run_id, kind: i.kind, severity: i.severity, metric: i.metric, title: i.title, body: i.body, evidence: i.evidence,
      narrative: i.narrative?.accepted ? { provider: i.narrative.provider, model: i.narrative.model, text: i.narrative.text } : null, created_at: i.created_at }));
  return {
    run: runJson(run, access.data), query: { id: q.id, name: q.name, status: q.status, current_version: q.current_version },
    access: { data: access.data, reason: access.reason, remasked_columns: [...access.restricted] },
    analyses, insights, insights_withheld: detail.insights.length - insights.length, deliveries: detail.deliveries,
    exports: access.data ? detail.exports : [],
  };
}

/** A bounded page of the run's result snapshot, re-masked for the viewer. */
export async function getRunResult(p: Principal, id: string, offset: number, limit: number) {
  const { run, v } = await loadRun(p, id);
  const access = await viewerAccess(p, run, v);
  if (!access.data) throw new AppError(403, 'result_withheld', access.reason ?? 'The result is not available to your role.');
  const snap = await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT columns, row_count, truncated, expires_at,
      (SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements(rows) WITH ORDINALITY AS t(x, o) WHERE o > $2 AND o <= $2 + $3) AS page
    FROM core.run_results WHERE run_id = $1 AND expires_at > $4`, [id, offset, limit, new Date(appClock.now())])).rows[0]);
  if (!snap) throw new AppError(410, 'result_expired', 'The result snapshot has expired; rerun the query.');
  const rows = ((snap.page ?? []) as unknown[][]).map((r) => r.map((x, i) => (access.remask.has(i) ? maskValue(x === null ? null : String(x), access.remask.get(i)!) : x)));
  return {
    run_id: id, columns: snap.columns.map((c: any, i: number) => ({ name: c.name, type: access.remask.has(i) ? 'string' : c.type, masked: access.remask.get(i) ?? c.masked })),
    rows, offset, limit, row_count: snap.row_count, truncated: snap.truncated, expires_at: snap.expires_at,
  };
}

async function loadWritable(p: Principal, id: string) {
  const x = await loadRun(p, id);
  const owner = x.run.schedule_id
    ? await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT created_by FROM core.schedules WHERE id = $1`, [x.run.schedule_id])).rows[0]?.created_by)
    : x.run.requested_by;
  if (owner !== p.actor && x.q.owner_actor !== p.actor && !can(p, 'saved_query:admin')) throw new AppError(403, 'forbidden', 'Only the run\'s owner, the query owner or an administrator can do this.');
  return x;
}

export async function retryRunDeliveries(p: Principal, id: string, ids: string[] | null, clock: Clock = appClock) {
  const { run } = await loadWritable(p, id);
  if (run.query_status === 'succeeded') {
    const snap = await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT 1 FROM core.run_results WHERE run_id = $1 AND expires_at > $2`, [id, new Date(clock.now())])).rows[0]);
    if (!snap) throw conflict('result_expired', 'The run\'s result snapshot has expired; rerun the query instead.');
  }
  const retried = await retryDeliveries(p.tenantId!, id, ids, clock.now());
  if (!retried.length) throw conflict('nothing_to_retry', 'No failed or blocked deliveries to retry.');
  await withTenant(p.tenantId!, (tx) => auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'delivery.retry', resource: `run:${id}`, outcome: 'succeeded',
    details: { deliveries: retried, query_rerun: false }, correlationId: p.correlationId }));
  return { run_id: id, retried };
}

export async function rerun(p: Principal, id: string, clock: Clock = appClock) {
  const { run, q } = await loadWritable(p, id);
  if (q.status !== 'active') throw conflict('not_active', `The saved query is ${q.status}.`);
  return withTenant(p.tenantId!, async (tx) => {
    // A rerun keeps the original identity (a schedule's) or uses the caller's own (a manual run).
    const sameIdentity = !!run.schedule_id;
    const runId = (await insertRun(tx, { tenant: p.tenantId!, queryId: run.query_id, version: run.query_version, scheduleId: run.schedule_id, occurrenceAt: null, trigger: 'manual', requestedBy: p.actor,
      runAsActor: sameIdentity ? run.run_as_actor : p.actor, runAsRole: sameIdentity ? run.run_as_role : p.role, parameters: run.parameters, destinationIds: run.destination_ids, maxAttempts: run.max_attempts, now: clock.now() }))!;
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'run.rerun', resource: `run:${runId}`, outcome: 'succeeded', details: { from_run: id }, correlationId: p.correlationId });
    return { run_id: runId, rerun_of: id, status: 'queued' };
  });
}

export async function cancelRun(p: Principal, id: string) {
  await loadWritable(p, id);
  return withTenant(p.tenantId!, async (tx) => {
    const r = await tx.query(`UPDATE core.analytics_runs SET status = 'cancelled', query_status = 'skipped', analysis_status = 'skipped', delivery_status = 'none', finished_at = clock_timestamp()
      WHERE id = $1 AND status = 'queued' RETURNING id`, [id]);
    if (!r.rowCount) throw conflict('not_cancellable', 'Only runs that have not started can be cancelled.');
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'run.cancel', resource: `run:${id}`, outcome: 'succeeded', details: {}, correlationId: p.correlationId });
    return { run_id: id, status: 'cancelled' };
  });
}

/** Name reviewed clusters (until then they are labelled "unnamed"). */
export async function reviewAnalysis(p: Principal, analysisId: string, b: Record<string, unknown>) {
  if (!/^[0-9a-f-]{36}$/.test(analysisId)) throw notFound('analysis');
  const names = b.cluster_names as Record<string, unknown>;
  if (!names || typeof names !== 'object' || Object.values(names).some((n) => typeof n !== 'string' || !n.trim() || (n as string).length > 80)) {
    throw new AppError(400, 'invalid_review', 'cluster_names maps cluster numbers to names (1-80 characters).');
  }
  return withTenant(p.tenantId!, async (tx) => {
    const a = (await tx.query(`SELECT * FROM core.analysis_runs WHERE id = $1 AND tenant_id = $2`, [analysisId, p.tenantId])).rows[0];
    if (!a) throw notFound('analysis');
    await loadQuery(tx, p, a.query_id, 'write');
    if (a.analysis_type !== 'cluster' || a.status !== 'succeeded') throw conflict('not_reviewable', 'Only successful clustering results can be reviewed.');
    const k = (a.result?.clusters ?? []).length;
    const clean = Object.fromEntries(Object.entries(names).filter(([c]) => Number(c) >= 1 && Number(c) <= k).map(([c, n]) => [c, (n as string).trim()]));
    const review = { names: clean, reviewed_by: p.actor, reviewed_at: new Date().toISOString() };
    await tx.query(`UPDATE core.analysis_runs SET review = $2 WHERE id = $1`, [analysisId, JSON.stringify(review)]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'analysis.review', resource: `analysis:${analysisId}`, outcome: 'succeeded', details: { clusters_named: Object.keys(clean).length }, correlationId: p.correlationId });
    return { id: analysisId, review };
  });
}
