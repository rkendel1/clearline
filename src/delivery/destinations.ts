// Delivery destinations (tenant-wide; managed with delivery:manage).
//
//   in_app   { recipients: ["$owner" | token name, ...] }           notifications in Clearline
//   email    { to: ["a@example.org", ...] }                          via EMAIL_PROVIDER
//   webhook  { url, secret_ref, auth_ref?, include_rows? }          signed JSON; https; SSRF-checked
//   export   { recipients: [...], expires_hours? }                   expiring, authorized CSV download
//
// Secrets are never stored: secret_ref / auth_ref name environment variables
// (WEBHOOK_SECRET_<REF>, WEBHOOK_AUTH_<REF>) provisioned like every other server secret.

import { randomUUID } from 'node:crypto';
import { withTenant } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { badRequest, conflict, notFound, unprocessable } from '../platform/errors.js';
import type { Principal } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { recipientIssue, sendEmail } from './email.js';
import { postWebhook, secretFor } from './webhook.js';
import { resolveTarget, DestinationError, type Resolver } from './ssrf.js';
import { PAYLOAD_SCHEMA } from './deliver.js';

const KINDS = ['in_app', 'email', 'webhook', 'export'] as const;
const REF = /^[A-Z0-9_]{1,64}$/;

async function validateConfig(kind: string, raw: unknown, resolver?: Resolver): Promise<Record<string, unknown>> {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c !== 'object' || Array.isArray(c)) throw badRequest('invalid_config', 'config must be an object.');
  const names = (k: string) => {
    const v = c[k] ?? ['$owner'];
    if (!Array.isArray(v) || !v.length || v.length > 50 || v.some((x) => typeof x !== 'string' || !/^(\$owner|[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(x))) throw badRequest('invalid_config', `${k} must list "$owner" or token names.`);
    return [...new Set(v as string[])];
  };
  switch (kind) {
    case 'in_app': return { recipients: names('recipients') };
    case 'export': {
      const h = c.expires_hours;
      if (h !== undefined && !(Number.isInteger(h) && (h as number) >= 1 && (h as number) <= 720)) throw badRequest('invalid_config', 'expires_hours must be 1-720.');
      return { recipients: names('recipients'), ...(h !== undefined ? { expires_hours: h } : {}) };
    }
    case 'email': {
      const to = c.to;
      if (!Array.isArray(to) || !to.length || to.length > 20) throw badRequest('invalid_config', 'to must list 1-20 email addresses.');
      for (const a of to) { const why = typeof a === 'string' ? recipientIssue(a) : 'not text'; if (why) throw unprocessable('invalid_recipient', why); }
      return { to: [...new Set((to as string[]).map((a) => a.trim()))] };
    }
    case 'webhook': {
      if (typeof c.url !== 'string') throw badRequest('invalid_config', 'url is required.');
      if (typeof c.secret_ref !== 'string' || !REF.test(c.secret_ref)) throw badRequest('invalid_config', 'secret_ref must name the signing secret (WEBHOOK_SECRET_<REF>; uppercase letters, digits, _). Webhooks are always signed.');
      if (c.auth_ref !== undefined && (typeof c.auth_ref !== 'string' || !REF.test(c.auth_ref))) throw badRequest('invalid_config', 'auth_ref must be uppercase letters, digits and _.');
      try { await resolveTarget(c.url, { allowPrivate: loadConfig().webhookAllowPrivate, resolver }); }
      catch (err) {
        if (err instanceof DestinationError && err.code !== 'dns_failure') throw unprocessable(err.code, err.message);
        if (!(err instanceof DestinationError)) throw err;
        // An unresolvable host is accepted now and re-checked at every send.
      }
      return { url: c.url, secret_ref: c.secret_ref, ...(c.auth_ref ? { auth_ref: c.auth_ref } : {}), include_rows: c.include_rows === true };
    }
  }
  throw badRequest('invalid_kind', `kind must be one of ${KINDS.join(', ')}.`);
}

function json(d: Record<string, any>) {
  const cfg = d.config ?? {};
  return {
    id: d.id, name: d.name, kind: d.kind, config: cfg, content: d.content, notify_on: d.notify_on, enabled: d.enabled, max_attempts: d.max_attempts, version: d.version,
    created_by: d.created_by, created_at: d.created_at, updated_by: d.updated_by, updated_at: d.updated_at,
    // Whether the referenced secrets exist on this server (never their values).
    secrets: d.kind === 'webhook' ? { signing: !!secretFor(cfg.secret_ref, 'SECRET'), auth: cfg.auth_ref ? !!secretFor(cfg.auth_ref, 'AUTH') : null } : undefined,
  };
}

function common(b: Record<string, unknown>, base?: Record<string, any>) {
  const content = (b.content ?? base?.content ?? 'summary') as string;
  const notifyOn = (b.notify_on ?? base?.notify_on ?? 'always') as string;
  if (!['summary', 'summary_with_csv'].includes(content)) throw badRequest('invalid_field', 'content must be summary or summary_with_csv.');
  if (!['always', 'success', 'failure', 'anomaly'].includes(notifyOn)) throw badRequest('invalid_field', 'notify_on must be always, success, failure or anomaly.');
  const max = b.max_attempts ?? base?.max_attempts ?? 5;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 20) throw badRequest('invalid_field', 'max_attempts must be 1-20.');
  return { content, notifyOn, max: max as number, enabled: b.enabled === undefined ? base?.enabled ?? true : b.enabled === true };
}

export async function listDestinations(p: Principal) {
  return withTenant(p.tenantId!, async (tx) => ({ items: (await tx.query(`SELECT * FROM core.delivery_destinations WHERE tenant_id = $1 ORDER BY lower(name)`, [p.tenantId])).rows.map(json) }));
}

export async function createDestination(p: Principal, b: Record<string, unknown>, resolver?: Resolver) {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 200) throw badRequest('invalid_field', 'name is required (at most 200 characters).');
  const kind = String(b.kind ?? '');
  const config = await validateConfig(kind, b.config, resolver);
  const c = common(b);
  const id = randomUUID();
  return withTenant(p.tenantId!, async (tx) => {
    try {
      await tx.query(`INSERT INTO core.delivery_destinations (id, tenant_id, name, kind, config, content, notify_on, enabled, max_attempts, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, p.tenantId, name, kind, JSON.stringify(config), c.content, c.notifyOn, c.enabled, c.max, p.actor]);
    } catch (err) { if ((err as { code?: string }).code === '23505') throw conflict('name_exists', `A destination named "${name}" exists.`); throw err; }
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'destination.create', resource: `destination:${id}`, outcome: 'succeeded',
      details: { kind, name, notify_on: c.notifyOn, content: c.content, target: kind === 'webhook' ? new URL(config.url as string).host : kind === 'email' ? (config.to as string[]).length : config.recipients }, correlationId: p.correlationId });
    return json((await tx.query(`SELECT * FROM core.delivery_destinations WHERE id = $1`, [id])).rows[0]);
  });
}

export async function updateDestination(p: Principal, id: string, b: Record<string, unknown>, resolver?: Resolver) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('destination');
  const base = await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT * FROM core.delivery_destinations WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId])).rows[0]);
  if (!base) throw notFound('destination');
  const config = b.config !== undefined ? await validateConfig(base.kind, b.config, resolver) : base.config;
  const c = common(b, base);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : base.name;
  return withTenant(p.tenantId!, async (tx) => {
    await tx.query(`UPDATE core.delivery_destinations SET name = $3, config = $4, content = $5, notify_on = $6, enabled = $7, max_attempts = $8, version = version + 1, updated_by = $9, updated_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId, name, JSON.stringify(config), c.content, c.notifyOn, c.enabled, c.max, p.actor]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'destination.update', resource: `destination:${id}`, outcome: 'succeeded',
      details: { version: base.version + 1, config_changed: b.config !== undefined, enabled: c.enabled, notify_on: c.notifyOn, content: c.content }, correlationId: p.correlationId });
    return json((await tx.query(`SELECT * FROM core.delivery_destinations WHERE id = $1`, [id])).rows[0]);
  });
}

/** Send a test message (no query data) and report exactly what happened. */
export async function testDestination(p: Principal, id: string, resolver?: Resolver) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('destination');
  const cfg = loadConfig();
  const d = await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT * FROM core.delivery_destinations WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId])).rows[0]);
  if (!d) throw notFound('destination');
  const testId = randomUUID();
  const text = `Test message from Clearline for destination "${d.name}", requested by ${p.actor}. It contains no query data.`;
  let result: { ok: boolean; code: string | null; message: string | null; status: number | null; duration_ms?: number };
  if (d.kind === 'email') {
    const t0 = performance.now();
    const r = await sendEmail({ from: cfg.emailFrom, to: d.config.to, subject: `[Clearline] Test delivery: ${d.name}`, text, messageId: `${testId}@clearline` });
    result = { ok: r.ok, code: r.code, message: r.message, status: r.reply, duration_ms: Math.round(performance.now() - t0) };
  } else if (d.kind === 'webhook') {
    const secret = secretFor(d.config.secret_ref, 'SECRET');
    if (!secret) result = { ok: false, code: 'secret_unavailable', message: `WEBHOOK_SECRET_${d.config.secret_ref} is not configured on the server.`, status: null };
    else {
      const r = await postWebhook({ url: d.config.url, body: JSON.stringify({ schema: PAYLOAD_SCHEMA, event: 'test', delivery_id: testId, tenant: p.tenantId, message: text }), deliveryId: testId, event: 'test',
        secret, authHeader: d.config.auth_ref ? secretFor(d.config.auth_ref, 'AUTH') : null, timeoutMs: cfg.deliveryTimeoutMs, allowPrivate: cfg.webhookAllowPrivate, resolver });
      result = { ok: r.ok, code: r.code, message: r.message, status: r.status, duration_ms: r.duration_ms };
    }
  } else {
    // In-app and export destinations: deliver a test notification to the caller only.
    await withTenant(p.tenantId!, (tx) => tx.query(`INSERT INTO core.notifications (id, tenant_id, recipient, kind, severity, title, body) VALUES ($1,$2,$3,'test','info',$4,$5)`,
      [testId, p.tenantId, p.actor, `Test delivery: ${d.name}`, text]));
    result = { ok: true, code: null, message: 'A test notification was added to your notifications.', status: null };
  }
  await withTenant(p.tenantId!, (tx) => auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'destination.test', resource: `destination:${id}`, outcome: result.ok ? 'succeeded' : 'failed',
    details: { kind: d.kind, code: result.code, status: result.status }, correlationId: p.correlationId }));
  return { destination_id: id, kind: d.kind, ...result };
}
