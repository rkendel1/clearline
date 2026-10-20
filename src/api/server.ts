// HTTP server. Thin layer: authentication, tenant authorization, correlation
// IDs, error mapping, access auditing. Business logic lives in the modules.

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../platform/config.js';
import { getPool, withSystem, requestTenant, TenantScopeViolation } from '../platform/db.js';
import { log } from '../platform/logger.js';
import { metrics, renderMetrics } from '../platform/metrics.js';
import { AppError } from '../platform/errors.js';
import { pendingMigrations } from '../platform/migrate.js';
import { authenticate, authorize, type Principal } from '../control/auth.js';
import { audit } from '../control/audit.js';
import { ROUTES } from './routes.js';

declare module 'fastify' { interface FastifyRequest { principal?: Principal; correlationId: string } }

export async function buildServer(): Promise<FastifyInstance> {
  const cfg = loadConfig();
  const app = Fastify({ logger: false, bodyLimit: cfg.maxUploadBytes, genReqId: () => randomUUID(), requestTimeout: cfg.batchTimeoutMs });

  app.addContentTypeParser(['text/csv', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, b, done) => done(null, b));

  app.addHook('onRequest', async (req, rep) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    rep.header('x-correlation-id', req.correlationId);
  });

  // Hardening headers: the API serves JSON and CSV only (the UI is the native client), so nothing may be framed, sniffed or scripted.
  app.addHook('onSend', async (_req, rep, payload) => {
    rep.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    rep.header('x-content-type-options', 'nosniff');
    rep.header('referrer-policy', 'no-referrer');
    rep.header('x-frame-options', 'DENY');
    if (!rep.hasHeader('cache-control') && rep.request.url.startsWith('/api/')) rep.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, rep) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const secs = rep.elapsedTime / 1000;
    metrics.httpRequests.inc({ method: req.method, route, status: String(rep.statusCode) });
    metrics.httpDuration.observe(secs, { method: req.method, route });
    if (route !== '/healthz' && route !== '/readyz' && route !== '/metrics') {
      log.info('http request', { method: req.method, route, status: rep.statusCode, ms: Math.round(rep.elapsedTime), correlation_id: req.correlationId, actor: req.principal?.actor, tenant: (req.params as Record<string, string>)?.tenant });
    }
    // Access auditing for successful tenant data reads (writes audit themselves with richer detail).
    const tenant = (req.params as Record<string, string>)?.tenant;
    if (req.method === 'GET' && tenant && req.principal && rep.statusCode < 400) {
      await audit({ tenantId: tenant, actor: req.principal.actor, role: req.principal.role, action: 'access.read', resource: route, outcome: 'allowed',
        details: { params: auditParams(req.params as Record<string, string>), query_keys: Object.keys((req.query as object) ?? {}) }, correlationId: req.correlationId }).catch(() => {});
    }
  });

  app.setErrorHandler(async (err, req, rep) => {
    if (err instanceof TenantScopeViolation) {
      // Reaching this means a route skipped or mis-applied authorization: a defect, logged loudly and audited.
      log.error('tenant scope violation blocked at data layer', { route: req.routeOptions.url, correlation_id: req.correlationId, actor: req.principal?.actor, details: err.details });
      const d = err.details as { requested_tenant: string; principal_tenant: string | null };
      await audit({ tenantId: d.requested_tenant, actor: req.principal?.actor ?? 'unknown', role: req.principal?.role ?? null, action: 'authz.scope_violation', resource: req.routeOptions.url ?? null, outcome: 'denied', details: d, correlationId: req.correlationId }).catch(() => {});
    }
    if (err instanceof AppError) return rep.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, correlation_id: req.correlationId });
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return rep.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message }, correlation_id: req.correlationId });
    log.error('unhandled error', { error: e, correlation_id: req.correlationId, route: req.routeOptions.url });
    return rep.code(500).send({ error: { code: 'internal_error', message: 'Internal error; quote the correlation id when reporting' }, correlation_id: req.correlationId });
  });

  // ---- operational endpoints
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, rep) => {
    const checks: Record<string, unknown> = {};
    try { await getPool().query('SELECT 1'); checks.database = 'ok'; } catch (err) { checks.database = (err as Error).message; }
    try { const p = await pendingMigrations(); checks.migrations = p.length ? `pending: ${p.join(', ')}` : 'ok'; } catch (err) { checks.migrations = (err as Error).message; }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return rep.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', async (req, rep) => {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) return rep.code(401).send('unauthorized');
    rep.header('content-type', 'text/plain; version=0.0.4');
    return renderMetrics(await dbGauges());
  });

  // ---- API routes from the route table
  for (const r of ROUTES) {
    app.route({
      method: r.method, url: r.url,
      handler: async (req, rep) => {
        let p: Principal | undefined;
        if (r.perm !== null) {
          p = await authenticate(req.headers.authorization, req.correlationId);
          req.principal = p;
          if (r.perm !== 'authenticated') {
            const tenant = r.tenantScoped ? (req.params as Record<string, string>).tenant : null;
            // Platform admins issue the first tokens for any tenant; they never get tenant data permissions.
            const platformTokenIssue = p.role === 'platform_admin' && r.perm === 'token:issue';
            await authorize(p, r.perm, platformTokenIssue ? null : tenant, `${r.method} ${r.url}`);
          }
        }
        if (!p) return r.handler(req as FastifyRequest, rep, p as unknown as Principal);
        // Bind the principal's tenant for the whole request: the data layer refuses any other tenant (defence in depth).
        return requestTenant.run({ tenantId: p.tenantId, actor: p.actor }, () => r.handler(req as FastifyRequest, rep, p as Principal));
      },
    });
  }

  app.setNotFoundHandler((_req, rep) => rep.code(404).send({ error: { code: 'not_found', message: 'route not found' } }));
  return app;
}

async function dbGauges(): Promise<string[]> {
  const lines: string[] = [];
  try {
    await withSystem(async (tx) => {
      const q = await tx.query(`SELECT tenant_id, status, count(*)::int AS n FROM core.batches WHERE status IN ('queued','processing') GROUP BY 1,2`);
      lines.push('# HELP clearline_backlog_batches Batches waiting or in progress', '# TYPE clearline_backlog_batches gauge');
      for (const r of q.rows) lines.push(`clearline_backlog_batches{tenant="${r.tenant_id}",status="${r.status}"} ${r.n}`);
      const o = await tx.query(`SELECT tenant_id, EXTRACT(EPOCH FROM now() - min(arrival_at)) AS s FROM core.batches WHERE status = 'queued' GROUP BY 1`);
      lines.push('# HELP clearline_oldest_queued_seconds Age of the oldest queued batch', '# TYPE clearline_oldest_queued_seconds gauge');
      for (const r of o.rows) lines.push(`clearline_oldest_queued_seconds{tenant="${r.tenant_id}"} ${Number(r.s).toFixed(1)}`);
      const f = await tx.query(`SELECT tenant_id, source_id, EXTRACT(EPOCH FROM now() - max(completed_at)) AS s FROM core.batches WHERE trust_status = 'trusted' GROUP BY 1,2`);
      lines.push('# HELP clearline_data_freshness_seconds Seconds since the last trusted batch per source', '# TYPE clearline_data_freshness_seconds gauge');
      for (const r of f.rows) lines.push(`clearline_data_freshness_seconds{tenant="${r.tenant_id}",source="${r.source_id}"} ${Number(r.s).toFixed(1)}`);
      const s = await tx.query(`SELECT tenant_id, status, trust_status, count(*)::int AS n FROM core.batches GROUP BY 1,2,3`);
      lines.push('# HELP clearline_batches Batches by pipeline and trust status (all time)', '# TYPE clearline_batches gauge');
      for (const r of s.rows) lines.push(`clearline_batches{tenant="${r.tenant_id}",status="${r.status}",trust="${r.trust_status}"} ${r.n}`);
      const w = await tx.query(`SELECT count(*) FILTER (WHERE last_seen > now() - interval '60 seconds' AND state <> 'stopped')::int AS live FROM core.worker_heartbeats`);
      lines.push('# HELP clearline_workers_live Workers with a heartbeat in the last 60s', '# TYPE clearline_workers_live gauge', `clearline_workers_live ${w.rows[0].live}`);
      const ar = await tx.query(`SELECT tenant_id, status, count(*)::int AS n, EXTRACT(EPOCH FROM now() - min(next_attempt_at)) FILTER (WHERE status = 'queued') AS oldest
        FROM core.analytics_runs WHERE status IN ('queued','running','delivering') GROUP BY 1,2`);
      lines.push('# HELP clearline_analytics_runs_active Saved-query runs queued, running or delivering', '# TYPE clearline_analytics_runs_active gauge');
      for (const r of ar.rows) lines.push(`clearline_analytics_runs_active{tenant="${r.tenant_id}",status="${r.status}"} ${r.n}`);
      lines.push('# HELP clearline_analytics_oldest_due_seconds Age of the oldest due, unclaimed run', '# TYPE clearline_analytics_oldest_due_seconds gauge');
      for (const r of ar.rows.filter((x) => x.status === 'queued')) lines.push(`clearline_analytics_oldest_due_seconds{tenant="${r.tenant_id}"} ${Math.max(0, Number(r.oldest ?? 0)).toFixed(1)}`);
      const dl = await tx.query(`SELECT tenant_id, kind, status, count(*)::int AS n FROM core.deliveries WHERE status IN ('pending','sending','retrying','failed','blocked') GROUP BY 1,2,3`);
      lines.push('# HELP clearline_deliveries Deliveries pending, retrying or not delivered', '# TYPE clearline_deliveries gauge');
      for (const r of dl.rows) lines.push(`clearline_deliveries{tenant="${r.tenant_id}",kind="${r.kind}",status="${r.status}"} ${r.n}`);
      const at = await tx.query(`SELECT tenant_id, count(*)::int AS n FROM core.schedules WHERE status = 'active' AND attention IS NOT NULL GROUP BY 1`);
      lines.push('# HELP clearline_schedules_needing_attention Active schedules whose last run could not proceed (e.g. lost authorization)', '# TYPE clearline_schedules_needing_attention gauge');
      for (const r of at.rows) lines.push(`clearline_schedules_needing_attention{tenant="${r.tenant_id}"} ${r.n}`);
    });
  } catch (err) {
    lines.push(`# database gauges unavailable: ${(err as Error).message.replace(/\n/g, ' ')}`);
  }
  return lines;
}

/** Subject keys in paths (e.g. /lineage/member/:key) are hashed: the audit trail is append-only and must not retain identifiers erasure removes. */
function auditParams(p: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p ?? {})) out[k] = k === 'key' ? `sha256:${createHash('sha256').update(`${p.tenant}:${p.entity}:${v}`).digest('hex').slice(0, 16)}` : v;
  return out;
}
