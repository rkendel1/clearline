// Schedules for saved queries, and the creation of runs (manual or per occurrence).
//
// Validation happens server-side when a schedule is created or changed: the recurrence
// (src/analytics/recurrence.ts), the time zone, the parameter values (resolved for the next
// occurrence), the execution identity and its delegated role, the destinations, and the SQL
// itself, validated under the run role and the current policy. Passing validation grants
// nothing: every run re-checks the identity and re-validates the SQL.

import { randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '../platform/db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../platform/errors.js';
import { can, DELEGABLE_ROLES, ROLE_PERMISSIONS, type Principal, type Role } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { validateFor } from '../query/service.js';
import { loadQuery, loadVersion } from './saved.js';
import { resolveValues } from './params.js';
import { compileRule, describe, formatRule, nextOccurrence, parseRule, RecurrenceError, upcoming, validateRecurrence, type Recurrence, type RecurrenceInput } from './recurrence.js';
import { appClock, type Clock } from './clock.js';

export const recurrenceOf = (s: Record<string, any>): Recurrence =>
  ({ rule: parseRule(s.rrule), startLocal: s.start_local, timezone: s.timezone, untilLocal: s.until_local });

function readRecurrence(b: Record<string, unknown>, base?: Record<string, any>): Recurrence & { rrule: string | null } {
  try {
    let rrule: string | null = base?.rrule ?? null;
    if (b.recurrence !== undefined) rrule = compileRule(b.recurrence as RecurrenceInput);
    else if (b.rrule !== undefined) rrule = (b.rrule as string | null) || null;
    const rule = parseRule(rrule);
    const r: Recurrence = {
      rule, startLocal: (b.start_local as string) ?? base?.start_local, timezone: (b.timezone as string) ?? base?.timezone ?? 'UTC',
      untilLocal: b.until_local !== undefined ? ((b.until_local as string | null) || null) : base?.until_local ?? null,
    };
    if (typeof r.startLocal !== 'string') throw new RecurrenceError('start_local', 'start_local (YYYY-MM-DDTHH:MM, local to the time zone) is required.');
    validateRecurrence(r);
    return { ...r, rrule: formatRule(rule) };
  } catch (err) {
    if (err instanceof RecurrenceError) throw badRequest('invalid_schedule', err.message, { field: err.field });
    throw err;
  }
}

async function destinations(tx: Tx, tenant: string, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10 || raw.some((x) => typeof x !== 'string')) throw badRequest('invalid_destinations', 'destination_ids must be up to 10 ids.');
  const ids = [...new Set(raw as string[])];
  if (!ids.length) return [];
  const found = (await tx.query(`SELECT id, enabled FROM core.delivery_destinations WHERE tenant_id = $1 AND id::text = ANY($2)`, [tenant, ids])).rows;
  const missing = ids.filter((i) => !found.some((f) => f.id === i));
  if (missing.length) throw unprocessable('unknown_destination', `Unknown destination ${missing[0]}.`);
  const off = found.filter((f) => !f.enabled);
  if (off.length) throw unprocessable('destination_disabled', `Destination ${off[0].id} is disabled.`);
  return ids;
}

function runRole(p: Principal, raw: unknown): Role {
  if (typeof raw !== 'string') throw badRequest('run_as_role_required', `Choose the role this schedule runs as (run_as_role); your role ${p.role} may delegate: ${DELEGABLE_ROLES[p.role].join(', ')}.`);
  const role = raw as Role;
  if (!DELEGABLE_ROLES[p.role].includes(role)) throw new AppError(403, 'role_not_delegable', `Role ${p.role} may not create schedules that run as ${role}.`);
  if (!ROLE_PERMISSIONS[role].has('query:run')) throw new AppError(403, 'role_not_delegable', `Role ${role} cannot run queries.`);
  return role;
}

async function loadSchedule(tx: Tx, p: Principal, id: string, write = false) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('schedule');
  const s = (await tx.query(`SELECT * FROM core.schedules WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId])).rows[0];
  if (!s) throw notFound('schedule');
  await loadQuery(tx, p, s.query_id);   // visibility follows the saved query
  if (write && s.created_by !== p.actor && !can(p, 'saved_query:admin')) throw new AppError(403, 'forbidden', 'Only the schedule\'s creator (or an administrator) can change it.');
  return s;
}

/** Validate that the run identity could run the query now, with these parameters at the next occurrence. */
async function precheck(p: Principal, role: Role, sql: string, params: any[], values: Record<string, unknown>, nextAt: number | null, tz: string) {
  const runAs: Principal = { ...p, role };
  const { validation } = await validateFor(runAs, sql, params);
  if (!validation.ok) throw new AppError(422, 'query_not_permitted', `The saved query is not permitted for role ${role}: ${validation.issues[0]?.message}`, { issues: validation.issues });
  resolveValues(params, values, nextAt ?? Date.now(), tz);
}

export function serializeSchedule(s: Record<string, any>) {
  const rec = recurrenceOf(s);
  return {
    id: s.id, query_id: s.query_id, name: s.name, status: s.status, rrule: s.rrule, start_local: s.start_local, timezone: s.timezone, until_local: s.until_local,
    description: describe(rec), parameters: s.parameters, pinned_version: s.pinned_version, run_as: { actor: s.run_as_actor, role: s.run_as_role },
    destination_ids: s.destination_ids, next_run_at: s.next_run_at, last_run_id: s.last_run_id, attention: s.attention, max_attempts: s.max_attempts,
    version: s.version, created_by: s.created_by, created_at: s.created_at, updated_by: s.updated_by, updated_at: s.updated_at,
  };
}

export async function createSchedule(p: Principal, b: Record<string, unknown>, clock: Clock = appClock) {
  if (typeof b.query_id !== 'string') throw badRequest('missing_query', 'query_id is required.');
  const rec = readRecurrence(b);
  const role = runRole(p, b.run_as_role);
  const now = clock.now();
  const next = nextOccurrence(rec, now);
  if (next === null) throw badRequest('invalid_schedule', 'The schedule has no future occurrence (the start, or the until bound, is in the past).', { field: 'start_local' });
  const maxAttempts = b.max_attempts === undefined ? 3 : Number(b.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw badRequest('invalid_field', 'max_attempts must be 1-10.');
  const values = (b.parameters ?? {}) as Record<string, unknown>;
  const { q, v, dest } = await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, b.query_id as string);
    if (q.status !== 'active') throw conflict('not_active', `The saved query is ${q.status}.`);
    const pinned = b.pinned_version === undefined || b.pinned_version === null ? null : Number(b.pinned_version);
    const v = await loadVersion(tx, q.id, pinned ?? q.current_version);
    return { q, v, dest: await destinations(tx, p.tenantId!, b.destination_ids), pinned };
  });
  await precheck(p, role, v.sql, v.parameters, values, next, rec.timezone);
  const id = randomUUID();
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : `${q.name}: ${describe(rec)}`;
  await withTenant(p.tenantId!, async (tx) => {
    await tx.query(`INSERT INTO core.schedules (id, tenant_id, query_id, name, pinned_version, rrule, start_local, timezone, until_local, parameters, run_as_actor, run_as_role,
        next_run_at, max_attempts, destination_ids, created_by, created_role, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$11,$16,$11)`,
      [id, p.tenantId, q.id, name, b.pinned_version ?? null, rec.rrule, rec.startLocal, rec.timezone, rec.untilLocal, JSON.stringify(values), p.actor, role, new Date(next), maxAttempts, dest, p.role]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'schedule.create', resource: `schedule:${id}`, outcome: 'succeeded',
      details: { query_id: q.id, rrule: rec.rrule, start_local: rec.startLocal, timezone: rec.timezone, until_local: rec.untilLocal, run_as: { actor: p.actor, role }, destinations: dest,
        parameters: Object.keys(values), next_run_at: new Date(next).toISOString(), pinned_version: b.pinned_version ?? null }, correlationId: p.correlationId });
  });
  return getSchedule(p, id);
}

export async function updateSchedule(p: Principal, id: string, b: Record<string, unknown>, clock: Clock = appClock) {
  const s = await withTenant(p.tenantId!, (tx) => loadSchedule(tx, p, id, true));
  if (s.status === 'cancelled' || s.status === 'completed') throw conflict('schedule_ended', `The schedule is ${s.status}.`);
  const rec = readRecurrence(b, s);
  const role = b.run_as_role !== undefined ? runRole(p, b.run_as_role) : (s.run_as_role as Role);
  // Changing the schedule re-binds it to the caller's identity (the person now responsible for it).
  if (b.run_as_role === undefined && !DELEGABLE_ROLES[p.role].includes(role)) throw new AppError(403, 'role_not_delegable', `Role ${p.role} may not maintain a schedule that runs as ${role}.`);
  const values = (b.parameters ?? s.parameters) as Record<string, unknown>;
  const next = s.status === 'active' ? nextOccurrence(rec, clock.now()) : null;
  if (s.status === 'active' && next === null) throw badRequest('invalid_schedule', 'The schedule would have no future occurrence.');
  const { v, dest } = await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, s.query_id);
    const pinned = b.pinned_version !== undefined ? (b.pinned_version === null ? null : Number(b.pinned_version)) : s.pinned_version;
    return { v: await loadVersion(tx, q.id, pinned ?? q.current_version), dest: b.destination_ids !== undefined ? await destinations(tx, p.tenantId!, b.destination_ids) : s.destination_ids };
  });
  await precheck(p, role, v.sql, v.parameters, values, next, rec.timezone);
  await withTenant(p.tenantId!, async (tx) => {
    const upd = await tx.query(`UPDATE core.schedules SET name = $3, rrule = $4, start_local = $5, timezone = $6, until_local = $7, parameters = $8, run_as_actor = $9, run_as_role = $10,
        next_run_at = $11, destination_ids = $12, pinned_version = $13, max_attempts = $14, attention = NULL, version = version + 1, updated_by = $9, updated_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2 AND version = $15`,
      [id, p.tenantId, typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : s.name, rec.rrule, rec.startLocal, rec.timezone, rec.untilLocal, JSON.stringify(values),
        p.actor, role, next === null ? null : new Date(next), dest, b.pinned_version !== undefined ? b.pinned_version : s.pinned_version, b.max_attempts ?? s.max_attempts, s.version]);
    if (!upd.rowCount) throw conflict('version_conflict', 'The schedule changed meanwhile; reload and try again.');
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'schedule.update', resource: `schedule:${id}`, outcome: 'succeeded',
      details: { version: s.version + 1, rrule: rec.rrule, timezone: rec.timezone, run_as: { actor: p.actor, role }, previous_run_as: { actor: s.run_as_actor, role: s.run_as_role }, destinations: dest },
      correlationId: p.correlationId });
  });
  return getSchedule(p, id);
}

export async function setScheduleState(p: Principal, id: string, action: 'pause' | 'resume' | 'cancel', clock: Clock = appClock) {
  await withTenant(p.tenantId!, async (tx) => {
    const s = await loadSchedule(tx, p, id, true);
    if (s.status === 'cancelled' || s.status === 'completed') throw conflict('schedule_ended', `The schedule is ${s.status}.`);
    let status = s.status; let next: number | null = s.next_run_at ? new Date(s.next_run_at).getTime() : null;
    if (action === 'pause') { status = 'paused'; next = null; }
    if (action === 'cancel') { status = 'cancelled'; next = null; }
    if (action === 'resume') {
      if (s.status !== 'paused') throw conflict('not_paused', 'The schedule is not paused.');
      const q = await loadQuery(tx, p, s.query_id);
      if (q.status !== 'active') throw conflict('not_active', `The saved query is ${q.status}.`);
      // Occurrences while paused are not run: resume from the next future occurrence.
      next = nextOccurrence(recurrenceOf(s), clock.now());
      status = next === null ? 'completed' : 'active';
    }
    await tx.query(`UPDATE core.schedules SET status = $3, next_run_at = $4, attention = CASE WHEN $3 = 'active' THEN NULL ELSE attention END, version = version + 1, updated_by = $5, updated_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId, status, next === null ? null : new Date(next), p.actor]);
    // Cancelling also cancels runs that have not started yet.
    const cancelled = action === 'cancel' ? (await tx.query(`UPDATE core.analytics_runs SET status = 'cancelled', query_status = 'skipped', analysis_status = 'skipped', delivery_status = 'none', finished_at = clock_timestamp()
      WHERE schedule_id = $1 AND status = 'queued' RETURNING id`, [id])).rows.map((r) => r.id) : [];
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: `schedule.${action}`, resource: `schedule:${id}`, outcome: 'succeeded',
      details: { from: s.status, to: status, next_run_at: next === null ? null : new Date(next).toISOString(), runs_cancelled: cancelled }, correlationId: p.correlationId });
  });
  return getSchedule(p, id);
}

export async function getSchedule(p: Principal, id: string) {
  return withTenant(p.tenantId!, async (tx) => {
    const s = await loadSchedule(tx, p, id);
    const runs = (await tx.query(`SELECT id, status, query_status, analysis_status, delivery_status, failure_class, error_code, occurrence_at, created_at, finished_at, attempt
      FROM core.analytics_runs WHERE schedule_id = $1 ORDER BY created_at DESC LIMIT 20`, [id])).rows;
    return { ...serializeSchedule(s), recent_runs: runs, upcoming: s.status === 'active' ? upcoming(recurrenceOf(s), appClock.now(), 5).map((t) => new Date(t).toISOString()) : [] };
  });
}

export async function listSchedules(p: Principal, f: { query_id?: string; status?: string }) {
  return withTenant(p.tenantId!, async (tx) => {
    const { rows } = await tx.query(`SELECT s.* FROM core.schedules s JOIN core.saved_queries q ON q.id = s.query_id
      WHERE s.tenant_id = $1 AND (q.owner_actor = $2 OR q.sharing = 'tenant' OR $5) AND ($3::uuid IS NULL OR s.query_id = $3) AND ($4::text IS NULL OR s.status = $4)
      ORDER BY s.next_run_at NULLS LAST, s.created_at`, [p.tenantId, p.actor, f.query_id ?? null, f.status ?? null, can(p, 'saved_query:admin')]);
    return { items: rows.map(serializeSchedule) };
  });
}

/** Next occurrences for a recurrence the user is editing (nothing is stored). */
export function previewRecurrence(b: Record<string, unknown>, clock: Clock = appClock) {
  const rec = readRecurrence(b);
  return { rrule: rec.rrule, description: describe(rec), next: upcoming(rec, clock.now(), Math.min(Number(b.count ?? 5) || 5, 20)).map((t) => new Date(t).toISOString()) };
}

// ------------------------------------------------------------------ runs

export interface NewRun {
  tenant: string; queryId: string; version: number; scheduleId: string | null; occurrenceAt: Date | null; trigger: 'schedule' | 'manual';
  requestedBy: string; runAsActor: string; runAsRole: string; parameters: Record<string, unknown>; destinationIds: string[]; maxAttempts: number; missed?: number; now: number;
}

/** Insert a run (idempotent per schedule occurrence). Returns the run id, or null if that occurrence already has one. */
export async function insertRun(tx: Tx, r: NewRun): Promise<string | null> {
  const id = randomUUID();
  const res = await tx.query(`INSERT INTO core.analytics_runs (id, tenant_id, query_id, query_version, schedule_id, occurrence_at, trigger, requested_by, run_as_actor, run_as_role, parameters,
      destination_ids, max_attempts, next_attempt_at, missed_occurrences, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (schedule_id, occurrence_at) DO NOTHING RETURNING id`,
    [id, r.tenant, r.queryId, r.version, r.scheduleId, r.occurrenceAt, r.trigger, r.requestedBy, r.runAsActor, r.runAsRole, JSON.stringify(r.parameters), r.destinationIds, r.maxAttempts,
      new Date(r.now), r.missed ?? 0, id]);
  return res.rows[0]?.id ?? null;
}

/** "Run now" for a schedule: a manual run under the schedule's identity and destinations. */
export async function runScheduleNow(p: Principal, id: string, clock: Clock = appClock) {
  return withTenant(p.tenantId!, async (tx) => {
    const s = await loadSchedule(tx, p, id, true);
    if (s.status === 'cancelled') throw conflict('schedule_ended', 'The schedule is cancelled.');
    const q = await loadQuery(tx, p, s.query_id);
    if (q.status !== 'active') throw conflict('not_active', `The saved query is ${q.status}.`);
    const runId = (await insertRun(tx, { tenant: p.tenantId!, queryId: q.id, version: s.pinned_version ?? q.current_version, scheduleId: id, occurrenceAt: null, trigger: 'manual',
      requestedBy: p.actor, runAsActor: s.run_as_actor, runAsRole: s.run_as_role, parameters: s.parameters, destinationIds: s.destination_ids, maxAttempts: s.max_attempts, now: clock.now() }))!;
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'schedule.run_now', resource: `schedule:${id}`, outcome: 'succeeded',
      details: { run_id: runId, run_as: { actor: s.run_as_actor, role: s.run_as_role } }, correlationId: p.correlationId });
    return { run_id: runId, status: 'queued' };
  });
}

/** Manual run of a saved query by the caller, as the caller (their own current role), optionally delivered. */
export async function runSavedNow(p: Principal, queryId: string, b: Record<string, unknown>, clock: Clock = appClock) {
  return withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, queryId);
    if (q.status !== 'active') throw conflict('not_active', `The saved query is ${q.status}.`);
    const version = typeof b.version === 'number' ? b.version : q.current_version;
    const v = await loadVersion(tx, q.id, version);
    resolveValues(v.parameters, (b.parameters ?? {}) as Record<string, unknown>, clock.now());   // reject bad values now
    const dest = b.destination_ids !== undefined && !can(p, 'schedule:manage') ? (() => { throw new AppError(403, 'forbidden', 'Delivering a run needs schedule:manage.'); })() : await destinations(tx, p.tenantId!, b.destination_ids);
    const runId = (await insertRun(tx, { tenant: p.tenantId!, queryId: q.id, version, scheduleId: null, occurrenceAt: null, trigger: 'manual', requestedBy: p.actor,
      runAsActor: p.actor, runAsRole: p.role, parameters: (b.parameters ?? {}) as Record<string, unknown>, destinationIds: dest, maxAttempts: 3, now: clock.now() }))!;
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'run.request', resource: `run:${runId}`, outcome: 'succeeded',
      details: { query_id: q.id, version, destinations: dest, parameters: Object.keys((b.parameters ?? {}) as object) }, correlationId: p.correlationId });
    return { run_id: runId, status: 'queued' };
  });
}
