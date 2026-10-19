// Route table. Each route declares its permission; tenant-scoped routes are
// authorized against the :tenant path parameter before the handler runs.
// docs/api.md is generated from this table (npm run docs:api).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission, type Principal } from '../control/auth.js';
import { badRequest, notFound } from '../platform/errors.js';
import { withTenant } from '../platform/db.js';
import { createTenant, getTenant, issueToken, listTokens, revokeToken } from '../control/tenants.js';
import { approveMigration, getActiveContract, publishContract, rejectMigration, rollbackMigration } from '../contracts/registry.js';
import { validateContract } from '../contracts/validate.js';
import { planMigration } from '../contracts/diff.js';
import { submitBatch } from '../ingestion/intake.js';
import { replayBatch } from '../ingestion/worker.js';
import { businessSummary, defaultWindow, exceptionReport, operationsReport } from '../reporting/reports.js';
import { extractSchema, runExtract } from '../reporting/extracts.js';
import { listRecords, recordLineage } from '../reporting/lineage.js';
import { runDatasetChecks } from '../reconciliation/dataset.js';
import { eraseSubject, runRetention } from '../control/retention.js';
import { PLATFORM_METRIC_DEFINITIONS } from '../reporting/definitions.js';
import { auditTx, audit } from '../control/audit.js';
import { CONTRACT_SCHEMA } from '../contracts/validate.js';
import { loadConfig } from '../platform/config.js';

export interface RouteDef {
  method: 'GET' | 'POST';
  url: string;
  perm: Permission | 'authenticated' | null;   // null = public
  summary: string;
  tenantScoped: boolean;
  handler: (req: FastifyRequest, reply: FastifyReply, p: Principal) => Promise<unknown>;
}

type Q = Record<string, string | undefined>;
const params = (r: FastifyRequest) => r.params as Record<string, string>;
const query = (r: FastifyRequest) => r.query as Q;
const body = (r: FastifyRequest) => (r.body ?? {}) as Record<string, unknown>;
const T = (r: FastifyRequest) => params(r).tenant;
const int = (v: string | undefined, d: number, max: number) => { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < 0) throw badRequest('invalid_parameter', `expected a non-negative integer, got ${v}`); return Math.min(n, max); };
const bool = (v: string | undefined) => v === 'true' || v === '1';

const R: RouteDef[] = [];
const route = (method: RouteDef['method'], url: string, perm: RouteDef['perm'], summary: string, handler: RouteDef['handler']) =>
  R.push({ method, url, perm, summary, tenantScoped: url.includes(':tenant'), handler });

// ---- identity & platform administration
route('GET', '/api/v1/me', 'authenticated', 'Describe the calling principal (tenant, role, permissions).', async (_r, _rep, p) => ({ actor: p.actor, tenant_id: p.tenantId, role: p.role }));
route('GET', '/api/v1/contract-schema', null, 'The formal JSON Schema (2020-12) for tenant contracts.', async () => CONTRACT_SCHEMA);
route('POST', '/api/v1/tenants', 'tenant:create', 'Create a tenant (schema, reporting role, retention policy). Body: {id, name, retention?}.', async (r, rep, p) => {
  const b = body(r);
  rep.code(201);
  return createTenant(p, { id: String(b.id ?? ''), name: String(b.name ?? ''), retention: b.retention as never });
});
route('POST', '/api/v1/tenants/:tenant/tokens', 'token:issue', 'Issue an API token (admin|operator|reporter by tenant admins; first admin and approver tokens by the platform admin). Token is returned once.', async (r, rep, p) => {
  const b = body(r);
  rep.code(201);
  return issueToken(p, T(r), String(b.name ?? ''), String(b.role ?? '') as never);
});
route('GET', '/api/v1/tenants/:tenant/tokens', 'token:issue', 'List the tenant\'s API tokens (names, roles, revocation state; never secrets).', async (r) => listTokens(T(r)));
route('POST', '/api/v1/tenants/:tenant/tokens/:name/revoke', 'token:issue', 'Revoke a token by name; effective on the next request.', async (r, _rep, p) => revokeToken(p, T(r), params(r).name));

// ---- contracts
route('GET', '/api/v1/tenants/:tenant', 'contract:read', 'Tenant details and retention policy.', async (r) => getTenant(T(r)));
route('GET', '/api/v1/tenants/:tenant/contracts', 'contract:read', 'All contract versions with lifecycle state.', async (r) =>
  withTenant(T(r), async (tx) => (await tx.query(`SELECT id, contract_id, version, lifecycle, document_hash, transform_version, created_by, created_at, activated_at FROM core.contract_versions WHERE tenant_id = $1 ORDER BY id`, [T(r)])).rows));
route('GET', '/api/v1/tenants/:tenant/contracts/active', 'contract:read', 'The active contract document.', async (r) =>
  withTenant(T(r), async (tx) => { const a = await getActiveContract(tx, T(r)); if (!a) throw notFound('no active contract'); return { id: a.id, version: a.version, transform_version: a.transform_version, document: a.document }; }));
route('POST', '/api/v1/tenants/:tenant/contracts/validate', 'contract:read', 'Dry run: validate a contract and show the migration plan without changing anything.', async (r) => {
  const v = validateContract(r.body);
  if (!v.ok) return { valid: false, issues: v.issues };
  const plan = await withTenant(T(r), async (tx) => planMigration(T(r), (await getActiveContract(tx, T(r)))?.document ?? null, v.contract));
  return { valid: true, plan };
});
route('POST', '/api/v1/tenants/:tenant/contracts', 'contract:publish', 'Publish a contract version. 201 = applied; 202 = breaking, awaiting approval; 422 = invalid or rejected.', async (r, rep, p) => {
  const res = await publishContract(p, T(r), r.body);
  rep.code(res.migration_status === 'rejected' ? 422 : res.migration_status === 'planned' ? 202 : 201);
  return res;
});
route('GET', '/api/v1/tenants/:tenant/migrations', 'contract:read', 'Contract migrations with plans and approval state.', async (r) =>
  withTenant(T(r), async (tx) => (await tx.query(`SELECT m.id, m.classification, m.status, m.requested_by, m.requested_at, m.approved_by, m.approved_at, m.applied_at, m.rolled_back_at, m.error,
    fv.version AS from_version, tv.version AS to_version, m.plan FROM core.contract_migrations m LEFT JOIN core.contract_versions fv ON fv.id = m.from_version_id
    JOIN core.contract_versions tv ON tv.id = m.to_version_id WHERE m.tenant_id = $1 ORDER BY m.id DESC`, [T(r)])).rows));
route('POST', '/api/v1/tenants/:tenant/migrations/:id/approve', 'contract:approve', 'Approve and apply a pending breaking migration (approver role). Body: {confirm_version}.', async (r, _rep, p) =>
  approveMigration(p, T(r), Number(params(r).id), String(body(r).confirm_version ?? ''), true));
route('POST', '/api/v1/tenants/:tenant/migrations/:id/reject', 'contract:approve', 'Reject a pending migration. Body: {reason}.', async (r, _rep, p) => rejectMigration(p, T(r), Number(params(r).id), String(body(r).reason ?? 'rejected')));
route('POST', '/api/v1/tenants/:tenant/migrations/:id/rollback', 'contract:approve', 'Roll back an applied migration (only before any batch uses the new version).', async (r, _rep, p) => rollbackMigration(p, T(r), Number(params(r).id)));

// ---- ingestion
route('POST', '/api/v1/tenants/:tenant/batches', 'batch:submit', 'Submit a JSON batch. Body: {source, source_reported_at?, control?: {record_count?, sums?}, records: [...]}.', async (r, rep, p) => {
  const b = body(r);
  if (typeof b.source !== 'string') throw badRequest('missing_source', '"source" is required');
  const res = await submitBatch(p, { tenantId: T(r), sourceId: b.source, format: 'json', body: b.records as unknown[], sourceReportedAt: b.source_reported_at as string, control: b.control as never });
  rep.code(res.duplicate ? 200 : res.status === 'rejected' ? 422 : 202);
  return res;
});
route('POST', '/api/v1/tenants/:tenant/batches/csv', 'batch:submit', 'Submit a CSV file (Content-Type: text/csv). Query: source, source_reported_at?. Header X-Clearline-Control: JSON control totals.', async (r, rep, p) => {
  const q = query(r);
  if (!q.source) throw badRequest('missing_source', 'query parameter "source" is required');
  if (!Buffer.isBuffer(r.body)) throw badRequest('invalid_body', 'send the CSV with Content-Type: text/csv');
  const res = await submitBatch(p, { tenantId: T(r), sourceId: q.source, format: 'csv', body: r.body, sourceReportedAt: q.source_reported_at, control: r.headers['x-clearline-control'] as string | undefined });
  rep.code(res.duplicate ? 200 : res.status === 'rejected' ? 422 : 202);
  return res;
});
route('GET', '/api/v1/tenants/:tenant/batches', 'batch:read', 'List batches (newest first). Query: status?, source?, limit?.', async (r) => {
  const q = query(r);
  return withTenant(T(r), async (tx) => (await tx.query(`SELECT b.id, b.source_id, b.entity, cv.version AS contract_version, b.status, b.trust_status, b.trust_reasons, b.quality_status, b.reconciliation_status,
      b.received_count, b.accepted_count, b.quarantined_count, b.duplicate_count, b.late_record_count, b.correction_count, b.conflict_count, b.attempt_count, b.is_late,
      b.arrival_at, b.source_reported_at, b.completed_at FROM core.batches b JOIN core.contract_versions cv ON cv.id = b.contract_version_id
      WHERE b.tenant_id = $1 AND ($2::text IS NULL OR b.status = $2) AND ($3::text IS NULL OR b.source_id = $3) ORDER BY b.arrival_at DESC, b.id LIMIT $4`,
    [T(r), q.status ?? null, q.source ?? null, int(q.limit, 100, 1000)])).rows);
});
route('GET', '/api/v1/tenants/:tenant/batches/:id', 'batch:read', 'Batch detail: provenance, counts, attempts, submissions, quality results and reconciliation.', async (r) =>
  withTenant(T(r), async (tx) => {
    const id = params(r).id;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('batch');
    const b = (await tx.query(`SELECT b.*, cv.version AS contract_version FROM core.batches b JOIN core.contract_versions cv ON cv.id = b.contract_version_id WHERE b.id = $1 AND b.tenant_id = $2`, [id, T(r)])).rows[0];
    if (!b) throw notFound(`batch ${id}`);
    const attempts = (await tx.query(`SELECT attempt, worker_id, started_at, ended_at, outcome, error FROM core.batch_attempts WHERE batch_id = $1 ORDER BY attempt`, [id])).rows;
    const submissions = (await tx.query(`SELECT outcome, submitted_by, submitted_at, correlation_id FROM core.batch_submissions WHERE batch_id = $1 ORDER BY id`, [id])).rows;
    const quality = (await tx.query(`SELECT q.rule_id, q.rule_kind, q.category, q.severity, q.evaluated_count, q.failed_count, q.description, cv.version AS contract_version, q.attempt
        FROM core.quality_results q JOIN core.contract_versions cv ON cv.id = q.contract_version_id WHERE q.batch_id = $1 ORDER BY q.failed_count DESC, q.rule_id`, [id])).rows;
    const reconciliation = (await tx.query(`SELECT check_id, status, expected, actual, difference, explanation, run_id FROM core.reconciliation_results WHERE batch_id = $1 ORDER BY id`, [id])).rows;
    const { lease_owner: _lo, ...rest } = b;
    return { ...rest, processing_run_id: b.attempt_count ? `${id}#${b.attempt_count}` : null, attempts, submissions, quality_results: quality, reconciliation };
  }));
route('GET', '/api/v1/tenants/:tenant/batches/:id/findings', 'quarantine:read', 'Per-record quality findings for a batch (affected records). Query: rule_id?, limit?.', async (r) => {
  const q = query(r);
  if (!/^[0-9a-f-]{36}$/.test(params(r).id)) throw notFound('batch');
  return withTenant(T(r), async (tx) => (await tx.query(`SELECT f.raw_record_id, rr.row_number AS source_row, f.rule_id, f.severity, f.category, f.field, f.message
      FROM core.quality_findings f JOIN core.raw_records rr ON rr.id = f.raw_record_id WHERE f.batch_id = $1 AND f.tenant_id = $2 AND ($3::text IS NULL OR f.rule_id = $3)
      ORDER BY rr.row_number, f.id LIMIT $4`, [params(r).id, T(r), q.rule_id ?? null, int(q.limit, 1000, 10000)])).rows);
});
route('POST', '/api/v1/tenants/:tenant/batches/:id/replay', 'batch:replay', 'Re-queue a failed batch for processing (safe: failed attempts left no effects).', async (r, _rep, p) => {
  const res = await replayBatch(T(r), params(r).id);
  if (!res) throw badRequest('not_replayable', 'Only failed batches can be replayed');
  await audit({ tenantId: T(r), actor: p.actor, role: p.role, action: 'batch.replay', resource: `batch:${params(r).id}`, outcome: 'succeeded', details: {}, correlationId: p.correlationId });
  return res;
});

// ---- exceptions & quarantine
route('GET', '/api/v1/tenants/:tenant/quarantine', 'quarantine:read', 'Quarantined records with actionable reasons. Query: status=open|resolved|all, batch_id?.', async (r, _rep, p) => {
  const q = query(r);
  if (q.batch_id && !/^[0-9a-f-]{36}$/.test(q.batch_id)) throw badRequest('invalid_parameter', 'batch_id must be a UUID');
  const rep = await exceptionReport(T(r), { status: (q.status as never) ?? 'open', limit: int(q.limit, 500, 5000), batchId: q.batch_id, canSeeSensitive: can(p, 'record:read_sensitive') });
  return rep.quarantined;
});
route('POST', '/api/v1/tenants/:tenant/quarantine/:id/resolve', 'quarantine:resolve', 'Mark a quarantined record resolved. Body: {resolution}. The record is not admitted; resubmit corrected data.', async (r, _rep, p) =>
  withTenant(T(r), async (tx) => {
    const res = String(body(r).resolution ?? '');
    if (!res) throw badRequest('missing_resolution', 'resolution is required');
    const { rows } = await tx.query(`UPDATE core.quarantine SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution = $4 WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING id, status`, [Number(params(r).id), T(r), p.actor, res]);
    if (!rows[0]) throw notFound('open quarantine item');
    await auditTx(tx, { tenantId: T(r), actor: p.actor, role: p.role, action: 'quarantine.resolve', resource: `quarantine:${params(r).id}`, outcome: 'succeeded', details: { resolution: res }, correlationId: p.correlationId });
    return rows[0];
  }));

// ---- records & lineage
route('GET', '/api/v1/tenants/:tenant/entities/:entity/records', 'record:read', 'Current canonical records (sensitive fields redacted unless permitted). Query: limit?, offset?.', async (r, _rep, p) => {
  const q = query(r);
  return listRecords(T(r), params(r).entity, { limit: int(q.limit, 100, 1000), offset: int(q.offset, 0, 10_000_000), canSeeSensitive: can(p, 'record:read_sensitive') });
});
route('GET', '/api/v1/tenants/:tenant/lineage/:entity/:key', 'lineage:read', 'Full lineage for one record key: source row, batch, contract/transform versions, quality, reconciliation, metrics, exports.', async (r, _rep, p) =>
  recordLineage(T(r), params(r).entity, params(r).key, can(p, 'record:read_sensitive')));

// ---- reporting
route('GET', '/api/v1/tenants/:tenant/reports/operations', 'report:read', 'Data operations report: volumes, failures, freshness, quality trend, reconciliation, latency, queue. Query: from?, to?.', async (r) => operationsReport(T(r), defaultWindow(query(r))));
route('GET', '/api/v1/tenants/:tenant/reports/business', 'report:read', 'Business summary: contract-declared metrics over trusted data, plus exception rate.', async (r) => businessSummary(T(r)));
route('GET', '/api/v1/tenants/:tenant/reports/exceptions', 'report:read', 'Exception report: quarantined records, conflicts, late arrivals, orphaned references, batches needing review.', async (r, _rep, p) =>
  exceptionReport(T(r), { status: (query(r).status as never) ?? 'open', canSeeSensitive: can(p, 'record:read_sensitive') }));
route('GET', '/api/v1/tenants/:tenant/metrics/definitions', 'report:read', 'Definitions of every reported metric (declared by contract and platform-defined).', async (r) =>
  withTenant(T(r), async (tx) => {
    const a = await getActiveContract(tx, T(r));
    return { contract_version: a?.version ?? null, declared: a?.document.outputs.metrics.map((m) => ({ ...m, source: `${m.entity} current versions joined to batches`, trust_scope: 'trusted batches only (value); all batches (value_including_untrusted)', refresh: 'computed at query time from committed data' })) ?? [], platform: PLATFORM_METRIC_DEFINITIONS };
  }));
route('GET', '/api/v1/tenants/:tenant/reconciliation', 'report:read', 'Latest dataset-level reconciliation run and recent batch reconciliation failures.', async (r) =>
  withTenant(T(r), async (tx) => ({
    dataset: (await tx.query(`SELECT check_id, status, expected, actual, difference, explanation, run_id, created_at FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'dataset'
      AND run_id = (SELECT run_id FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'dataset' ORDER BY created_at DESC, id DESC LIMIT 1) ORDER BY check_id`, [T(r)])).rows,
    failed_batch_checks: (await tx.query(`SELECT batch_id, check_id, explanation, difference, created_at FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'batch' AND status = 'failed' ORDER BY created_at DESC LIMIT 100`, [T(r)])).rows,
  })));
route('POST', '/api/v1/tenants/:tenant/reconciliation/run', 'batch:replay', 'Run dataset reconciliation now and re-verify every committed batch against the target (drift detection).', async (r, _rep, p) => {
  const res = await runDatasetChecks(T(r), `manual:${p.correlationId}`, { reverify: true, actor: p.actor });
  const drift = await withTenant(T(r), async (tx) => (await tx.query(`SELECT batch_id, check_id, explanation, difference FROM core.reconciliation_results WHERE tenant_id = $1 AND run_id = $2 AND status = 'failed' ORDER BY id`, [T(r), `reverify:manual:${p.correlationId}`])).rows);
  return { run_id: `manual:${p.correlationId}`, dataset: res, batch_reverification_failures: drift };
});

// ---- extracts
route('GET', '/api/v1/tenants/:tenant/extracts', 'extract:run', 'Declared extracts with their explicit schemas.', async (r) =>
  withTenant(T(r), async (tx) => { const a = await getActiveContract(tx, T(r)); return a ? a.document.outputs.extracts.map((x) => extractSchema(a.document, x)) : []; }));
route('GET', '/api/v1/tenants/:tenant/extracts/:id/schema', 'extract:run', 'Explicit schema of one extract.', async (r) =>
  withTenant(T(r), async (tx) => { const a = await getActiveContract(tx, T(r)); const x = a?.document.outputs.extracts.find((e) => e.id === params(r).id); if (!a || !x) throw notFound('extract'); return extractSchema(a.document, x); }));
route('GET', '/api/v1/tenants/:tenant/extracts/:id/csv', 'extract:run', 'Run an extract as CSV. Query: as_of?, filters? (JSON), include_untrusted?, include_sensitive? (admin only). Metadata in X-Clearline-* headers.', async (r, rep, p) => {
  const q = query(r);
  let filters: Record<string, unknown> | undefined;
  if (q.filters) { try { filters = JSON.parse(q.filters); } catch { throw badRequest('invalid_filters', 'filters must be JSON'); } }
  const { csv, meta } = await runExtract(p, T(r), params(r).id, { filters, as_of: q.as_of, include_sensitive: bool(q.include_sensitive), include_untrusted: bool(q.include_untrusted) });
  rep.header('content-type', 'text/csv; charset=utf-8');
  rep.header('content-disposition', `attachment; filename="${meta.extract_id}_${meta.as_of.replace(/[:.]/g, '')}.csv"`);
  for (const [k, v] of Object.entries(meta)) rep.header(`x-clearline-${k.replace(/_/g, '-')}`, Array.isArray(v) ? v.join(',') : String(v));
  return csv;
});

// ---- governance
route('GET', '/api/v1/tenants/:tenant/audit', 'audit:read', 'Audit trail (append-only). Query: action?, limit?.', async (r) => {
  const q = query(r);
  // audit_events is not RLS-protected (it must accept writes before a tenant is known), so filter explicitly.
  return withTenant(T(r), async (tx) => (await tx.query(`SELECT id, at, actor, role, action, resource, outcome, details, correlation_id FROM core.audit_events
      WHERE tenant_id = $1 AND ($2::text IS NULL OR action LIKE $2 || '%') ORDER BY id DESC LIMIT $3`, [T(r), q.action ?? null, int(q.limit, 200, 5000)])).rows);
});
route('POST', '/api/v1/tenants/:tenant/retention/run', 'retention:run', 'Apply the tenant retention policy now.', async (r, _rep, p) => runRetention(p, T(r)));
route('POST', '/api/v1/tenants/:tenant/subjects/:entity/:key/erase', 'subject:erase', 'Erase one subject (all versions, raw payloads, quarantine) and log affected exports.', async (r, _rep, p) =>
  eraseSubject(p, T(r), params(r).entity, params(r).key));

export const ROUTES: readonly RouteDef[] = R;
