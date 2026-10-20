// Delivery of run outcomes to destinations, with retries and re-authorization.
//
// One row in core.deliveries per (run, destination): a delivery is created once and moves
// pending -> sending -> delivered | retrying -> ... | failed | blocked | skipped. Each attempt is
// recorded (append-only). Attempts are claimed with FOR UPDATE SKIP LOCKED and a lease, so two
// workers never send the same delivery at once; a worker that dies mid-send is recovered after
// the lease and the send is retried (at-least-once; receivers deduplicate on the delivery id).
//
// Before anything derived from result data leaves (insights, rows, CSV), access is re-checked:
// the run identity must still be valid, the saved SQL must still validate for the run role
// under the CURRENT policy, and no column may be more restricted now than when the run
// executed. Otherwise the delivery is BLOCKED; nothing is sent. Failure notices carry no data.

import { createHash, randomUUID } from 'node:crypto';
import { stringify } from 'csv-stringify/sync';
import { withSystem, withTenant, type Tx } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { log } from '../platform/logger.js';
import { auditTx } from '../control/audit.js';
import { ROLE_PERMISSIONS, type Role } from '../control/auth.js';
import { validateFor } from '../query/service.js';
import { checkIdentity } from '../analytics/identity.js';
import type { Clock } from '../analytics/clock.js';
import { sendEmail } from './email.js';
import { postWebhook, secretFor } from './webhook.js';
import type { Resolver } from './ssrf.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const PAYLOAD_SCHEMA = 'clearline.analytics.delivery/v1';

export interface Flags { querySucceeded: boolean; failed: boolean; anomaly: boolean }

export function wants(notifyOn: string, f: Flags): boolean {
  switch (notifyOn) {
    case 'always': return true;
    case 'success': return f.querySucceeded && !f.failed;
    case 'failure': return f.failed;
    case 'anomaly': return f.anomaly;
    default: return false;
  }
}

/** Create the run's deliveries (idempotent). Returns how many are pending. */
export async function createDeliveries(tx: Tx, run: Record<string, any>, f: Flags, now: number): Promise<number> {
  if (!run.destination_ids?.length) return 0;
  const dests = (await tx.query(`SELECT * FROM core.delivery_destinations WHERE tenant_id = $1 AND id = ANY($2)`, [run.tenant_id, run.destination_ids])).rows;
  let pending = 0;
  for (const d of dests) {
    const go = d.enabled && wants(d.notify_on, f);
    const r = await tx.query(`INSERT INTO core.deliveries (id, tenant_id, run_id, destination_id, destination_version, kind, status, max_attempts, next_attempt_at, last_error_code, last_error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id, destination_id) DO NOTHING RETURNING status`,
      [randomUUID(), run.tenant_id, run.id, d.id, d.version, d.kind, go ? 'pending' : 'skipped', d.max_attempts, new Date(now),
        go ? null : d.enabled ? 'not_requested' : 'destination_disabled', go ? null : d.enabled ? `This destination is notified on ${d.notify_on}.` : 'The destination is disabled.']);
    if (r.rows[0]?.status === 'pending') pending++;
  }
  return pending;
}

/**
 * Derive the run's delivery_status and overall status from its deliveries. A run whose query
 * succeeded is "succeeded" only when every requested delivery was delivered.
 */
export async function finalizeRun(tx: Tx, runId: string, now: number) {
  const run = (await tx.query(`SELECT * FROM core.analytics_runs WHERE id = $1`, [runId])).rows[0];
  const ds = (await tx.query(`SELECT status FROM core.deliveries WHERE run_id = $1`, [runId])).rows.map((r) => r.status as string);
  const active = ds.filter((s) => s !== 'skipped');
  const pending = active.some((s) => ['pending', 'sending', 'retrying'].includes(s));
  const delivered = active.filter((s) => s === 'delivered').length;
  const failed = active.filter((s) => s === 'failed').length;
  const blocked = active.filter((s) => s === 'blocked').length;
  const delivery = !active.length ? 'none' : pending ? 'pending' : delivered === active.length ? 'delivered' : delivered ? 'partial' : failed ? 'failed' : 'blocked';
  let status = run.status; let failure = run.failure_class; let code = run.error_code; let message = run.error_message;
  if (run.query_status === 'succeeded') {
    if (pending) status = 'delivering';
    else if (run.analysis_status === 'failed') { status = 'failed'; failure = 'analysis'; }
    else if (['failed', 'blocked', 'partial'].includes(delivery)) {
      status = 'failed'; failure = 'delivery';
      code = blocked ? 'delivery_blocked' : 'delivery_failed';
      message = blocked ? 'Delivery was blocked: access to the results changed after the query ran.' : `${failed} of ${active.length} deliveries failed.`;
    } else { status = 'succeeded'; failure = null; code = null; message = null; }
  }
  await tx.query(`UPDATE core.analytics_runs SET status = $2, delivery_status = $3, failure_class = $4, error_code = $5, error_message = $6,
      finished_at = CASE WHEN $2 = 'delivering' THEN NULL ELSE coalesce(finished_at, $7) END WHERE id = $1`,
    [runId, status, delivery, failure, code, message, new Date(now)]);
  return { status, delivery };
}

// ------------------------------------------------------------------ claiming and recovery

export async function recoverDeliveries(now: number): Promise<number> {
  return withSystem(async (tx) => {
    const { rows } = await tx.query(`UPDATE core.deliveries SET status = 'retrying', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = $1,
        last_error_code = 'interrupted', last_error = 'The worker stopped while sending; the delivery will be retried.', updated_at = $1
      WHERE id IN (SELECT id FROM core.deliveries WHERE status = 'sending' AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, run_id, attempts`, [new Date(now)]);
    for (const d of rows) {
      await tx.query(`INSERT INTO core.audit_events (tenant_id, actor, role, action, resource, outcome, details, correlation_id) VALUES ($1,'system:delivery-recovery','system','delivery.recover',$2,'succeeded',$3,$4)`,
        [d.tenant_id, `delivery:${d.id}`, JSON.stringify({ attempts: d.attempts, new_status: 'retrying' }), d.run_id]);
    }
    return rows.length;
  });
}

export async function claimDelivery(workerId: string, now: number): Promise<Record<string, any> | null> {
  const lease = loadConfig().deliveryLeaseSeconds;
  return withSystem(async (tx) => (await tx.query(`UPDATE core.deliveries SET status = 'sending', attempts = attempts + 1, lease_owner = $1,
      lease_expires_at = $2::timestamptz + make_interval(secs => $3), updated_at = $2
    WHERE id = (SELECT id FROM core.deliveries WHERE status IN ('pending','retrying') AND next_attempt_at <= $2 ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [workerId, new Date(now), lease])).rows[0] ?? null);
}

// ------------------------------------------------------------------ authorization before delivery

export interface Access { ok: boolean; code: string | null; message: string | null }

/** Re-check the run identity and that no result column is more restricted now than at execution. */
export async function authorizeResults(run: Record<string, any>, query: Record<string, any>, version: Record<string, any>, snapshotColumns: { name: string; masked: string | null }[] | null): Promise<Access> {
  const id = await checkIdentity(run.tenant_id, run.run_as_actor, run.run_as_role as Role, query, run.id);
  if (!id.ok) return { ok: false, code: id.code, message: id.message };
  const { validation } = await validateFor(id.principal, version.sql, version.parameters);
  if (!validation.ok) return { ok: false, code: 'access_changed', message: `The query is no longer permitted for ${run.run_as_role} under the current field policy: ${validation.issues[0]?.message}` };
  const cols = snapshotColumns ?? run.result_meta?.columns ?? [];
  for (const [i, c] of cols.entries()) {
    const now = validation.output[i];
    if (!now || now.name !== c.name) return { ok: false, code: 'access_changed', message: 'The query output changed after the run; the results are not delivered.' };
    if (now.masked && now.masked !== c.masked) return { ok: false, code: 'access_changed', message: `Column ${c.name} became redacted (${now.masked}) after the query ran; results computed before the change are not delivered.` };
  }
  return { ok: true, code: null, message: null };
}

// ------------------------------------------------------------------ payloads

const fmtTime = (t: unknown) => (t ? new Date(t as string).toISOString() : null);

export function summary(ctx: { run: Record<string, any>; query: Record<string, any>; insights: Record<string, any>[]; links: Record<string, string> }) {
  const r = ctx.run;
  const event = r.query_status === 'succeeded' ? (ctx.insights.some((i) => i.kind === 'anomaly' && i.severity !== 'info') ? 'run.anomaly' : 'run.succeeded') : r.status === 'denied' ? 'run.denied' : 'run.failed';
  const status = r.query_status === 'succeeded' ? `Query succeeded: ${r.result_meta?.row_count ?? 0} rows${r.result_meta?.truncated ? ' (truncated)' : ''}.` : `Query ${r.query_status}: ${r.error_message ?? r.error_code ?? 'see the run history'}.`;
  const lines = [
    `${ctx.query.name} (version ${r.query_version}) — ${r.trigger === 'schedule' ? 'scheduled' : 'manual'} run ${r.id}`,
    r.occurrence_at ? `Scheduled for ${fmtTime(r.occurrence_at)}; ran as ${r.run_as_actor} (${r.run_as_role}).` : `Ran as ${r.run_as_actor} (${r.run_as_role}).`,
    status, '',
    ...(ctx.insights.length ? ['Findings (computed by the listed methods; statistical, not explanations):', ...ctx.insights.map((i) => `- [${i.severity}] ${i.title}. ${i.body}`), ''] : []),
    `Results: ${ctx.links.run}`,
  ];
  return {
    event,
    subject: `[Clearline] ${ctx.query.name}: ${event === 'run.anomaly' ? 'anomaly detected' : event.replace('run.', '')}`,
    text: lines.join('\n'),
    json: {
      schema: PAYLOAD_SCHEMA, event, tenant: r.tenant_id,
      run: { id: r.id, trigger: r.trigger, status: r.status, query_status: r.query_status, analysis_status: r.analysis_status, failure_class: r.failure_class, error_code: r.error_code,
        error_message: r.error_message, occurrence_at: fmtTime(r.occurrence_at), started_at: fmtTime(r.started_at), row_count: r.result_meta?.row_count ?? null, truncated: r.result_meta?.truncated ?? null,
        run_as: { actor: r.run_as_actor, role: r.run_as_role } },
      query: { id: ctx.query.id, name: ctx.query.name, version: r.query_version },
      insights: ctx.insights.map((i) => ({ kind: i.kind, severity: i.severity, metric: i.metric, title: i.title, body: i.body })),
      links: ctx.links,
    } as Record<string, unknown>,
  };
}

export function csvOf(snap: { columns: { name: string }[]; rows: unknown[][] }): string {
  return stringify([snap.columns.map((c) => c.name), ...snap.rows.map((row) => row.map((x) => (x === null ? '' : String(x))))]);
}

// ------------------------------------------------------------------ processing

export interface DeliveryContext { workerId: string; clock: Clock; resolver?: Resolver }

interface Outcome { kind: 'delivered' | 'transient_failure' | 'permanent_failure' | 'blocked'; status_code?: number | null; code?: string | null; message?: string | null }

const backoff = (attempt: number, base: number, max: number) => Math.min(max, base * 2 ** Math.max(0, attempt - 1));

export async function processDelivery(d: Record<string, any>, ctx: DeliveryContext): Promise<Outcome> {
  const cfg = loadConfig();
  const started = ctx.clock.now();
  const t0 = performance.now();
  const data = await withTenant(d.tenant_id, async (tx) => {
    const run = (await tx.query(`SELECT * FROM core.analytics_runs WHERE id = $1`, [d.run_id])).rows[0];
    const dest = (await tx.query(`SELECT * FROM core.delivery_destinations WHERE id = $1`, [d.destination_id])).rows[0];
    const query = (await tx.query(`SELECT * FROM core.saved_queries WHERE id = $1`, [run.query_id])).rows[0];
    const version = (await tx.query(`SELECT * FROM core.saved_query_versions WHERE query_id = $1 AND version = $2`, [run.query_id, run.query_version])).rows[0];
    const insights = (await tx.query(`SELECT * FROM core.insights WHERE run_id = $1 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, created_at`, [run.id])).rows;
    const snap = (await tx.query(`SELECT * FROM core.run_results WHERE run_id = $1 AND expires_at > $2`, [run.id, new Date(started)])).rows[0] ?? null;
    const schedule = run.schedule_id ? (await tx.query(`SELECT created_by FROM core.schedules WHERE id = $1`, [run.schedule_id])).rows[0] : null;
    return { run, dest, query, version, insights, snap, owner: schedule?.created_by ?? run.requested_by };
  });
  const { run, dest, query, version, snap } = data;
  let outcome: Outcome;
  try {
    outcome = await attempt();
  } catch (err) {
    log.error('delivery attempt failed unexpectedly', { delivery: d.id, error: err as Error });
    outcome = { kind: 'transient_failure', code: 'internal_error', message: 'Internal error while delivering; it will be retried.' };
  }

  async function attempt(): Promise<Outcome> {
    if (!dest.enabled) return { kind: 'permanent_failure', code: 'destination_disabled', message: 'The destination was disabled.' };
    const dataBearing = run.query_status === 'succeeded';
    let insights = data.insights;
    if (dataBearing) {
      const access = await authorizeResults(run, query, version, snap?.columns ?? null);
      if (!access.ok) return { kind: 'blocked', code: access.code, message: access.message };
    } else insights = [];
    const links = { run: `${cfg.publicUrl}/api/v1/tenants/${run.tenant_id}/analytics/runs/${run.id}`, query: `${cfg.publicUrl}/api/v1/tenants/${run.tenant_id}/saved-queries/${query.id}` };
    const s = summary({ run, query, insights, links });
    const needsRows = dataBearing && (dest.content === 'summary_with_csv' || dest.kind === 'export' || (dest.kind === 'webhook' && dest.config.include_rows));
    if (needsRows && !snap) return { kind: 'permanent_failure', code: 'result_expired', message: 'The run\'s result snapshot has expired; rerun the query to deliver its results.' };
    switch (dest.kind) {
      case 'in_app': return deliverInApp(d, run, query, version, dest, s, data.owner, insights, links);
      case 'export': return deliverExport(d, run, query, dest, s, snap!, data.owner, links, started);
      case 'email': {
        const to = (dest.config.to ?? []) as string[];
        let attachment;
        let text = s.text;
        if (needsRows) {
          const csv = csvOf(snap!);
          if (Buffer.byteLength(csv) <= cfg.deliveryMaxBytes) attachment = { filename: `${query.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}-${run.id.slice(0, 8)}.csv`, contentType: 'text/csv', content: csv };
          else text += `\n\nThe CSV (${Buffer.byteLength(csv)} bytes) exceeds DELIVERY_MAX_BYTES and was not attached; download it from Clearline.`;
          if (snap!.truncated) text += `\nThe result was truncated at ${snap!.row_count} rows.`;
        }
        const r = await sendEmail({ from: cfg.emailFrom, to, subject: s.subject, text, messageId: `${d.id}@clearline`, attachment,
          headers: { 'X-Clearline-Delivery': d.id, 'X-Clearline-Run': run.id } });
        return r.ok ? { kind: 'delivered', status_code: r.reply } : { kind: r.transient ? 'transient_failure' : 'permanent_failure', status_code: r.reply, code: r.code, message: r.message };
      }
      case 'webhook': {
        const secret = secretFor(dest.config.secret_ref, 'SECRET');
        if (!secret) return { kind: 'permanent_failure', code: 'secret_unavailable', message: `The signing secret WEBHOOK_SECRET_${dest.config.secret_ref} is not configured on the server.` };
        const payload: Record<string, unknown> = { ...s.json, delivery_id: d.id };
        if (needsRows) {
          const rows = snap!.rows.slice(0, cfg.deliveryMaxRows);
          payload.result = { columns: snap!.columns.map((c: any) => ({ name: c.name, type: c.type, redacted: c.masked })), rows, rows_included: rows.length, rows_total: snap!.row_count, truncated: snap!.truncated || rows.length < snap!.row_count };
        }
        let body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > cfg.deliveryMaxBytes) { delete payload.result; payload.result_omitted = 'payload exceeded DELIVERY_MAX_BYTES'; body = JSON.stringify(payload); }
        const auth = dest.config.auth_ref ? secretFor(dest.config.auth_ref, 'AUTH') : null;
        if (dest.config.auth_ref && !auth) return { kind: 'permanent_failure', code: 'secret_unavailable', message: `The credential WEBHOOK_AUTH_${dest.config.auth_ref} is not configured on the server.` };
        const r = await postWebhook({ url: dest.config.url, body, deliveryId: d.id, event: s.event, secret, authHeader: auth, timeoutMs: cfg.deliveryTimeoutMs, allowPrivate: cfg.webhookAllowPrivate, resolver: ctx.resolver });
        return r.ok ? { kind: 'delivered', status_code: r.status } : { kind: r.transient ? 'transient_failure' : r.code === 'private_address' ? 'blocked' : 'permanent_failure', status_code: r.status, code: r.code, message: r.message };
      }
      default: return { kind: 'permanent_failure', code: 'unsupported_destination', message: `Unsupported destination kind ${dest.kind}.` };
    }
  }

  const duration = Math.round(performance.now() - t0);
  const now = ctx.clock.now();
  await withTenant(d.tenant_id, async (tx) => {
    const attemptNo = d.attempts;
    await tx.query(`INSERT INTO core.delivery_attempts (tenant_id, delivery_id, attempt, outcome, status_code, error_code, error, duration_ms, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (delivery_id, attempt) DO NOTHING`, [d.tenant_id, d.id, attemptNo, outcome.kind, outcome.status_code ?? null, outcome.code ?? null, outcome.message?.slice(0, 500) ?? null, duration, new Date(started)]);
    let status: string; let next: Date | null = null;
    if (outcome.kind === 'delivered') status = 'delivered';
    else if (outcome.kind === 'blocked') status = 'blocked';
    else if (outcome.kind === 'transient_failure' && attemptNo < d.max_attempts) { status = 'retrying'; next = new Date(now + backoff(attemptNo, cfg.deliveryRetryBaseMs, cfg.deliveryRetryMaxMs)); }
    else status = 'failed';
    // Only the lease holder records the outcome (a recovered, re-claimed delivery is not overwritten).
    const upd = await tx.query(`UPDATE core.deliveries SET status = $3, next_attempt_at = $4, lease_owner = NULL, lease_expires_at = NULL, last_error_code = $5, last_error = $6,
        delivered_at = CASE WHEN $3 = 'delivered' THEN $7 ELSE delivered_at END, updated_at = $7 WHERE id = $1 AND lease_owner = $2`,
      [d.id, ctx.workerId, status, next, outcome.code ?? null, outcome.message?.slice(0, 500) ?? null, new Date(now)]);
    if (!upd.rowCount) return;
    await auditTx(tx, { tenantId: d.tenant_id, actor: `scheduler:${ctx.workerId}`, role: 'system', action: 'delivery.attempt', resource: `delivery:${d.id}`,
      outcome: outcome.kind === 'delivered' ? 'succeeded' : outcome.kind === 'blocked' ? 'denied' : 'failed',
      details: { run_id: d.run_id, destination_id: d.destination_id, kind: d.kind, attempt: attemptNo, result: outcome.kind, status: status, status_code: outcome.status_code ?? null,
        error_code: outcome.code ?? null, duration_ms: duration, next_attempt_at: next?.toISOString() ?? null }, correlationId: d.run_id });
    const timings = { ...(run.timings ?? {}), delivery_ms: (run.timings?.delivery_ms ?? 0) + duration };
    await tx.query(`UPDATE core.analytics_runs SET timings = $2 WHERE id = $1`, [run.id, JSON.stringify(timings)]);
    await finalizeRun(tx, run.id, now);
  });
  return outcome;
}

// ------------------------------------------------------------------ in-app and export

async function recipientsOf(_tx: Tx, tenant: string, list: unknown, owner: string) {
  const names = [...new Set(((Array.isArray(list) && list.length ? list : ['$owner']) as string[]).map((n) => (n === '$owner' ? owner : n)))];
  // Tokens are platform-scoped (like authentication); filtered to the delivery's tenant.
  const rows = await withSystem(async (s) => (await s.query(`SELECT DISTINCT ON (name) name, role FROM core.api_tokens WHERE tenant_id = $1 AND name = ANY($2) AND revoked_at IS NULL ORDER BY name, id DESC`, [tenant, names])).rows);
  return { valid: rows.filter((r) => ROLE_PERMISSIONS[r.role as Role]?.has('notification:read')), unknown: names.filter((n) => !rows.some((r) => r.name === n)) };
}

function notificationKind(run: Record<string, any>, insights: Record<string, any>[]): { kind: string; severity: string } {
  if (run.status === 'denied') return { kind: 'authorization', severity: 'high' };
  if (run.query_status !== 'succeeded') return { kind: 'query_failed', severity: 'medium' };
  const top = insights.find((i) => i.kind === 'anomaly' && i.severity !== 'info') ?? insights.find((i) => i.evidence?.crossings);
  if (top) return { kind: top.evidence?.crossings ? 'threshold' : 'anomaly', severity: top.severity };
  if (insights.some((i) => i.kind === 'forecast')) return { kind: 'forecast', severity: 'info' };
  if (insights.some((i) => i.kind === 'status')) return { kind: 'analysis_failed', severity: 'low' };
  return { kind: 'run_succeeded', severity: 'info' };
}

async function deliverInApp(d: Record<string, any>, run: Record<string, any>, query: Record<string, any>, version: Record<string, any>, dest: Record<string, any>,
  s: ReturnType<typeof summary>, owner: string, insights: Record<string, any>[], links: Record<string, string>): Promise<Outcome> {
  return withTenant(d.tenant_id, async (tx) => {
    const { valid, unknown } = await recipientsOf(tx, d.tenant_id, dest.config.recipients, owner);
    if (!valid.length) return { kind: 'permanent_failure', code: 'no_recipients', message: `No active recipient${unknown.length ? ` (unknown or revoked: ${unknown.join(', ')})` : ''}.` } as Outcome;
    const k = notificationKind(run, insights);
    let withheld = 0;
    for (const r of valid) {
      // A recipient sees findings only if they could see the query and its output at the same redaction.
      let full = query.owner_actor === r.name || query.sharing === 'tenant';
      if (full && run.query_status === 'succeeded') {
        const { validation } = await validateFor({ actor: r.name, tokenId: 0, tenantId: d.tenant_id, role: r.role, correlationId: run.id }, version.sql, version.parameters);
        const cols = run.result_meta?.columns ?? [];
        full = validation.ok && cols.every((c: any, i: number) => !validation.output[i]?.masked || validation.output[i]?.masked === c.masked);
      }
      if (!full) withheld++;
      const body = full ? s.text : `A ${run.trigger} run of a saved query completed (${run.status}). Its results are not available to your role.`;
      await tx.query(`INSERT INTO core.notifications (id, tenant_id, recipient, run_id, delivery_id, query_id, kind, severity, title, body, links) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (delivery_id, recipient) DO NOTHING`, [randomUUID(), d.tenant_id, r.name, run.id, d.id, query.id, k.kind, k.severity, full ? s.subject.replace('[Clearline] ', '') : 'Saved query run completed', body,
        JSON.stringify(full ? links : {})]);
    }
    return { kind: 'delivered', code: withheld ? 'partially_withheld' : null, message: withheld ? `${withheld} recipient(s) received a status-only notice.` : null } as Outcome;
  });
}

async function deliverExport(d: Record<string, any>, run: Record<string, any>, query: Record<string, any>, dest: Record<string, any>, s: ReturnType<typeof summary>,
  snap: Record<string, any>, owner: string, links: Record<string, string>, now: number): Promise<Outcome> {
  const cfg = loadConfig();
  if (run.query_status !== 'succeeded') return { kind: 'permanent_failure', code: 'nothing_to_export', message: 'The run produced no result to export.' };
  const csv = csvOf(snap as never);
  if (Buffer.byteLength(csv) > cfg.queryMaxResultBytes * 2) return { kind: 'permanent_failure', code: 'export_too_large', message: 'The export exceeds the size limit.' };
  const hours = Number.isInteger(dest.config.expires_hours) ? Math.min(dest.config.expires_hours, 24 * 30) : cfg.exportExpiryHours;
  return withTenant(d.tenant_id, async (tx) => {
    // One export per delivery: a retried delivery reuses it.
    let exp = (await tx.query(`SELECT id FROM core.exports WHERE delivery_id = $1`, [d.id])).rows[0];
    if (!exp) {
      exp = { id: randomUUID() };
      await tx.query(`INSERT INTO core.exports (id, tenant_id, run_id, delivery_id, query_id, role, file_name, content, bytes, row_count, truncated, sha256, redacted_columns, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [exp.id, d.tenant_id, run.id, d.id, query.id, run.run_as_role,
        `${query.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}-${run.id.slice(0, 8)}.csv`, Buffer.from(csv), Buffer.byteLength(csv), snap.row_count, snap.truncated, sha(csv),
        JSON.stringify(snap.columns.filter((c: any) => c.masked).map((c: any) => ({ column: c.name, redaction: c.masked }))), new Date(now + hours * 3600_000)]);
    }
    const link = `${cfg.publicUrl}/api/v1/tenants/${d.tenant_id}/analytics/exports/${exp.id}/download`;
    const { valid } = await recipientsOf(tx, d.tenant_id, dest.config.recipients, owner);
    for (const r of valid) {
      await tx.query(`INSERT INTO core.notifications (id, tenant_id, recipient, run_id, delivery_id, query_id, kind, severity, title, body, links) VALUES ($1,$2,$3,$4,$5,$6,'run_succeeded','info',$7,$8,$9)
        ON CONFLICT (delivery_id, recipient) DO NOTHING`, [randomUUID(), d.tenant_id, r.name, run.id, d.id, query.id, `Export ready: ${query.name}`,
        `${snap.row_count} rows${snap.truncated ? ' (truncated)' : ''}; available until ${new Date(now + hours * 3600_000).toISOString()}. Downloads are authorized for your role and audited.`, JSON.stringify({ ...links, export: link })]);
    }
    return { kind: 'delivered' } as Outcome;
  });
}
