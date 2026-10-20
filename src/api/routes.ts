// Route table. Each route declares its permission; tenant-scoped routes are
// authorized against the :tenant path parameter before the handler runs.
// docs/api.md is generated from this table (npm run docs:api).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, ROLE_PERMISSIONS, type Permission, type Principal } from '../control/auth.js';
import { cancel as cancelQuery, execute as executeQuery, exportCsv as exportQuery, getCatalog, getProposal, history as queryHistory, propose } from '../query/service.js';
import { changeFieldPolicy, fieldPolicyHistory, listFieldPolicies } from '../policy/service.js';
import { createSavedQuery, duplicateSavedQuery, executeSaved, getSavedQuery, getVersion, listSavedQueries, newVersion, setFavorite, setStatus, updateMetadata, validateAnalysis } from '../analytics/saved.js';
import { createSchedule, getSchedule, listSchedules, previewRecurrence, runSavedNow, runScheduleNow, setScheduleState, updateSchedule } from '../analytics/schedules.js';
import { cancelRun, getRun, getRunResult, listRuns, rerun, retryRunDeliveries, reviewAnalysis } from '../analytics/runs.js';
import { createDestination, listDestinations, testDestination, updateDestination } from '../delivery/destinations.js';
import { downloadExport, listNotifications, markRead } from '../delivery/inbox.js';
import { contractForViewer, loadPolicies, type FieldViewer } from '../policy/fields.js';
import type { Tx } from '../platform/db.js';

async function viewerFor(tx: Tx, tenant: string, p: Principal): Promise<FieldViewer | null> {
  const a = await getActiveContract(tx, tenant);
  return a ? (await loadPolicies(tx, tenant, a.document)).viewer(p.role) : null;
}
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
import { assistantHandlers } from '../assistant/routes.js';

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

// ---- public: architecture content and the grounded assistant (no account needed; see src/assistant/routes.ts)
route('GET', '/api/public/content', null, 'The architecture content model: components, diagram, capabilities with evidence-based status, decisions, actors and limitations.', async () => assistantHandlers.content());
route('GET', '/api/public/assistant/status', null, 'Assistant status: retrieval index (embedder, model, corpus version), answer mode (model or extractive) and limits.', async () => assistantHandlers.status());
route('GET', '/api/public/source', null, 'An approved source document for a citation. Query: path. Documents classified for signed-in users need an Authorization header.', async (r) => assistantHandlers.source(r));
route('GET', '/api/public/assistant/evidence', null, 'The recorded computation behind a data answer. Query: id. Anonymous answers are readable by their id; signed-in answers only by the identity that asked.', async (r) => assistantHandlers.evidence(r));
route('POST', '/api/public/assistant/ask', null, 'Ask the grounded assistant. Body: {message, history?, context?}. Retrieval over approved documents; an Authorization header widens it to documents for signed-in users. Rate limited.', async (r, rep) => assistantHandlers.ask(r, rep));

// ---- identity & platform administration
route('GET', '/api/v1/me', 'authenticated', 'Describe the calling principal (tenant, role, permissions).', async (_r, _rep, p) => ({ actor: p.actor, tenant_id: p.tenantId, role: p.role, permissions: [...ROLE_PERMISSIONS[p.role]].sort() }));
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
route('GET', '/api/v1/tenants/:tenant/contracts/active', 'contract:read', 'The active contract document (fields hidden from your role by field policy are omitted).', async (r, _rep, p) =>
  withTenant(T(r), async (tx) => {
    const a = await getActiveContract(tx, T(r));
    if (!a) throw notFound('no active contract');
    // Fields hidden from the role by policy are removed from the document it is shown.
    const viewer = (await loadPolicies(tx, T(r), a.document)).viewer(p.role);
    return { id: a.id, version: a.version, transform_version: a.transform_version, document: contractForViewer(a.document, viewer) };
  }));
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
route('GET', '/api/v1/tenants/:tenant/batches/:id/findings', 'quarantine:read', 'Per-record quality findings for a batch (affected records). Query: rule_id?, limit?.', async (r, _rep, p) => {
  const q = query(r);
  if (!/^[0-9a-f-]{36}$/.test(params(r).id)) throw notFound('batch');
  return withTenant(T(r), async (tx) => {
    const viewer = await viewerFor(tx, T(r), p);
    const { rows } = await tx.query(`SELECT f.raw_record_id, rr.row_number AS source_row, f.rule_id, f.severity, f.category, f.field, f.message, b.entity
      FROM core.quality_findings f JOIN core.raw_records rr ON rr.id = f.raw_record_id JOIN core.batches b ON b.id = f.batch_id WHERE f.batch_id = $1 AND f.tenant_id = $2 AND ($3::text IS NULL OR f.rule_id = $3)
      ORDER BY rr.row_number, f.id LIMIT $4`, [params(r).id, T(r), q.rule_id ?? null, int(q.limit, 1000, 10000)]);
    return rows.map(({ entity, ...f }) => ({ ...f, field: f.field && viewer?.level(entity, f.field) === 'hidden' ? null : f.field, message: viewer ? viewer.message(entity, f.field, f.message) : f.message }));
  });
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
  const rep = await exceptionReport(T(r), { status: (q.status as never) ?? 'open', limit: int(q.limit, 500, 5000), batchId: q.batch_id, role: p.role });
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
  return listRecords(T(r), params(r).entity, { limit: int(q.limit, 100, 1000), offset: int(q.offset, 0, 10_000_000), role: p.role });
});
route('GET', '/api/v1/tenants/:tenant/lineage/:entity/:key', 'lineage:read', 'Full lineage for one record key: source row, batch, contract/transform versions, quality, reconciliation, metrics, exports.', async (r, _rep, p) =>
  recordLineage(T(r), params(r).entity, params(r).key, p.role));

// ---- reporting
route('GET', '/api/v1/tenants/:tenant/reports/operations', 'report:read', 'Data operations report: volumes, failures, freshness, quality trend, reconciliation, latency, queue. Query: from?, to?.', async (r) => operationsReport(T(r), defaultWindow(query(r))));
route('GET', '/api/v1/tenants/:tenant/reports/business', 'report:read', 'Business summary: contract-declared metrics over trusted data, plus exception rate.', async (r, _rep, p) => businessSummary(T(r), p.role));
route('GET', '/api/v1/tenants/:tenant/reports/exceptions', 'report:read', 'Exception report: quarantined records, conflicts, late arrivals, orphaned references, batches needing review.', async (r, _rep, p) =>
  exceptionReport(T(r), { status: (query(r).status as never) ?? 'open', role: p.role }));
route('GET', '/api/v1/tenants/:tenant/metrics/definitions', 'report:read', 'Definitions of every reported metric (declared by contract and platform-defined).', async (r, _rep, p) =>
  withTenant(T(r), async (tx) => {
    const a = await getActiveContract(tx, T(r));
    const doc = a ? contractForViewer(a.document, (await loadPolicies(tx, T(r), a.document)).viewer(p.role)) : null;
    return { contract_version: a?.version ?? null, declared: doc?.outputs.metrics.map((m) => ({ ...m, source: `${m.entity} current versions joined to batches`, trust_scope: 'trusted batches only (value); all batches (value_including_untrusted)', refresh: 'computed at query time from committed data' })) ?? [], platform: PLATFORM_METRIC_DEFINITIONS };
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
route('GET', '/api/v1/tenants/:tenant/extracts', 'extract:run', 'Declared extracts with their explicit schemas (as your role receives them).', async (r, _rep, p) =>
  withTenant(T(r), async (tx) => {
    const a = await getActiveContract(tx, T(r));
    if (!a) return [];
    const viewer = (await loadPolicies(tx, T(r), a.document)).viewer(p.role);
    return a.document.outputs.extracts.map((x) => extractSchema(a.document, x, viewer));
  }));
route('GET', '/api/v1/tenants/:tenant/extracts/:id/schema', 'extract:run', 'Explicit schema of one extract (as your role receives it).', async (r, _rep, p) =>
  withTenant(T(r), async (tx) => {
    const a = await getActiveContract(tx, T(r));
    const x = a?.document.outputs.extracts.find((e) => e.id === params(r).id);
    if (!a || !x) throw notFound('extract');
    return extractSchema(a.document, x, (await loadPolicies(tx, T(r), a.document)).viewer(p.role));
  }));
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
route('GET', '/api/v1/tenants/:tenant/audit', 'audit:read', 'Audit trail (append-only). Query: action? (prefix), correlation_id? (e.g. a run id: every event of that run), limit?.', async (r) => {
  const q = query(r);
  // audit_events is not RLS-protected (it must accept writes before a tenant is known), so filter explicitly.
  return withTenant(T(r), async (tx) => (await tx.query(`SELECT id, at, actor, role, action, resource, outcome, details, correlation_id FROM core.audit_events
      WHERE tenant_id = $1 AND ($2::text IS NULL OR action LIKE $2 || '%') AND ($4::text IS NULL OR correlation_id = $4) ORDER BY id DESC LIMIT $3`,
    [T(r), q.action ?? null, int(q.limit, 200, 5000), q.correlation_id ?? null])).rows);
});
route('POST', '/api/v1/tenants/:tenant/retention/run', 'retention:run', 'Apply the tenant retention policy now.', async (r, _rep, p) => runRetention(p, T(r)));
route('POST', '/api/v1/tenants/:tenant/subjects/:entity/:key/erase', 'subject:erase', 'Erase one subject (all versions, raw payloads, quarantine) and log affected exports.', async (r, _rep, p) =>
  eraseSubject(p, T(r), params(r).entity, params(r).key));

// ---- analytical query workspace (docs/query-workspace.md). Generation never executes; execution needs an explicit call.
route('GET', '/api/v1/tenants/:tenant/queries/catalog', 'query:discover', 'Tables and columns this role may query, with access levels, relationships and metric definitions (metadata only).', async (_r, _rep, p) => getCatalog(p));
route('POST', '/api/v1/tenants/:tenant/queries/proposals', 'query:propose', 'Create a query proposal from {question} (generated by the configured provider) or {sql, parent_id?} (hand-written or edited). Validates and estimates; never executes.', async (r, rep, p) => {
  rep.code(201);
  return propose(p, body(r));
});
route('GET', '/api/v1/tenants/:tenant/queries/proposals/:id', 'query:history', 'One proposal with its validation and executions (re-evaluated against your current access).', async (r, _rep, p) => getProposal(p, params(r).id));
route('POST', '/api/v1/tenants/:tenant/queries/proposals/:id/execute', 'query:run', 'Run a proposal after re-validating it under the current policy. Body: {mode: preview|run, execution_id?: uuid (lets the client cancel it while it runs)}. Returns permitted, redacted rows; rows are not stored.', async (r, _rep, p) => {
  const mode = String(body(r).mode ?? 'preview');
  if (mode !== 'preview' && mode !== 'run') throw badRequest('invalid_mode', 'mode must be preview or run');
  const eid = body(r).execution_id;
  return executeQuery(p, params(r).id, mode, typeof eid === 'string' ? eid : undefined);
});
route('POST', '/api/v1/tenants/:tenant/queries/proposals/:id/export', 'query:export', 'Run a proposal and return CSV (same validation and redaction as execute).', async (r, rep, p) => {
  const { csv, meta } = await exportQuery(p, params(r).id);
  rep.header('content-type', 'text/csv; charset=utf-8');
  rep.header('content-disposition', `attachment; filename="query_${params(r).id}.csv"`);
  for (const [k, v] of Object.entries(meta)) rep.header(`x-clearline-${k.replace(/_/g, '-')}`, Array.isArray(v) ? v.join(',') : String(v));
  return csv;
});
route('POST', '/api/v1/tenants/:tenant/queries/executions/:id/cancel', 'query:run', 'Cancel a running query execution.', async (r, _rep, p) => cancelQuery(p, params(r).id));
route('GET', '/api/v1/tenants/:tenant/queries/history', 'query:history', 'Your query history (all=true for the whole tenant with query:history_all). Query: limit?.', async (r, _rep, p) =>
  queryHistory(p, { limit: int(query(r).limit, 50, 200), all: bool(query(r).all) }));

// ---- field sensitivity and redaction policy
route('GET', '/api/v1/tenants/:tenant/fields/policies', 'policy:read', 'Field policies (sensitivity, redaction, unmask roles, role access) with the effective access of every role.', async (_r, _rep, p) => listFieldPolicies(p));
route('POST', '/api/v1/tenants/:tenant/fields/:entity/:field/policy', 'policy:manage', 'Change one field policy (field "*" = table). Body: {sensitive?, redaction?, reason?, unmask_roles?, role_access?}. Widening requires policy:grant.', async (r, _rep, p) =>
  changeFieldPolicy(p, params(r).entity, params(r).field, body(r)));
route('GET', '/api/v1/tenants/:tenant/fields/policies/history', 'policy:read', 'Append-only version history of field policy changes. Query: entity?, field?, limit?.', async (r, _rep, p) =>
  fieldPolicyHistory(p, { entity: query(r).entity, field: query(r).field, limit: int(query(r).limit, 200, 2000) }));

// ---- saved analytics: saved queries, schedules, runs, analyses, delivery (docs/saved-analytics.md)
const SQ = '/api/v1/tenants/:tenant/saved-queries';
const AN = '/api/v1/tenants/:tenant/analytics';
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
route('GET', SQ, 'saved_query:read', 'Saved queries you own or that are shared with the tenant. Query: q?, scope=all|mine|shared, tag?, category?, status?, favorite?, sort=updated|recent|name|created|last_run, limit?, offset?.', async (r, _rep, p) => {
  const x = query(r);
  return listSavedQueries(p, { scope: x.scope, q: x.q, tag: x.tag, category: x.category, status: x.status, favorite: bool(x.favorite), sort: x.sort, limit: int(x.limit, 50, 500), offset: int(x.offset, 0, 100_000) });
});
route('POST', SQ, 'saved_query:write', 'Save a query: {name, sql | proposal_id, question?, description?, purpose?, category?, business_owner?, tags?, sharing?, parameters?, analyses?, change_note?}. The SQL is validated for your role; saving grants nothing.', async (r, rep, p) => {
  rep.code(201);
  return createSavedQuery(p, body(r));
});
route('GET', `${SQ}/:id`, 'saved_query:read', 'Saved query detail: metadata, current version (SQL withheld if your role may not use it), versions, schedules, recent runs, latest analyses.', async (r, _rep, p) => getSavedQuery(p, params(r).id));
route('POST', `${SQ}/:id`, 'saved_query:write', 'Update metadata (name, description, purpose, category, business_owner, tags, sharing). Changing SQL, parameters or analyses creates a version instead.', async (r, _rep, p) => updateMetadata(p, params(r).id, body(r)));
route('POST', `${SQ}/:id/versions`, 'saved_query:write', 'Create a new version: {sql?, parameters?, analyses?, change_note?}. Analyses that no longer fit the output are flagged needs_revalidation.', async (r, rep, p) => {
  rep.code(201);
  return newVersion(p, params(r).id, body(r));
});
route('GET', `${SQ}/:id/versions/:version`, 'saved_query:read', 'One immutable version of a saved query.', async (r, _rep, p) => getVersion(p, params(r).id, int(params(r).version, 1, 1_000_000)));
route('POST', `${SQ}/:id/duplicate`, 'saved_query:write', 'Duplicate into a new private saved query you own: {name?}. Re-validated for your role.', async (r, rep, p) => {
  rep.code(201);
  return duplicateSavedQuery(p, params(r).id, body(r));
});
route('POST', `${SQ}/:id/status`, 'saved_query:write', 'Set status: {status: active|disabled|archived}. Disabling or archiving pauses its schedules.', async (r, _rep, p) => setStatus(p, params(r).id, String(body(r).status ?? '') as never));
route('POST', `${SQ}/:id/favorite`, 'saved_query:read', 'Mark or unmark as a favorite: {favorite: true|false}.', async (r, _rep, p) => setFavorite(p, params(r).id, body(r).favorite !== false));
route('POST', `${SQ}/:id/execute`, 'query:run', 'Run the saved query now as yourself (your role, current policy): {parameters?, mode: preview|run, version?, execution_id?}. Returns rows; nothing is stored, no analyses or deliveries.', async (r, _rep, p) => executeSaved(p, params(r).id, body(r)));
route('POST', `${SQ}/:id/runs`, 'analysis:run', 'Queue a manual analytics run as yourself: {parameters?, version?, destination_ids?}. The scheduler executes it (query, analyses, deliveries).', async (r, rep, p) => {
  rep.code(202);
  return runSavedNow(p, params(r).id, body(r));
});
route('POST', `${SQ}/:id/analyses/validate`, 'analysis:read', 'Check an analysis configuration against the current output schema: {config}. Returns the normalized configuration or issues.', async (r, _rep, p) => validateAnalysis(p, params(r).id, body(r)));

route('GET', `${AN}/schedules`, 'saved_query:read', 'Schedules of saved queries visible to you. Query: query_id?, status?.', async (r, _rep, p) => listSchedules(p, { query_id: query(r).query_id, status: query(r).status }));
route('POST', `${AN}/schedules`, 'schedule:manage', 'Create a schedule: {query_id, recurrence {frequency, interval?, at?, weekdays?, month_day?} | rrule, start_local, timezone, until_local?, parameters?, run_as_role, destination_ids?, pinned_version?, max_attempts?}. It runs as you, with the role you name.', async (r, rep, p) => {
  rep.code(201);
  return createSchedule(p, body(r));
});
route('POST', `${AN}/schedules/preview`, 'schedule:manage', 'Preview a recurrence: {recurrence | rrule, start_local, timezone, until_local?, count?} -> RRULE, description and the next occurrences (UTC).', async (r) => previewRecurrence(body(r)));
route('GET', `${AN}/schedules/:id`, 'saved_query:read', 'Schedule detail with recent runs and upcoming occurrences.', async (r, _rep, p) => getSchedule(p, params(r).id));
route('POST', `${AN}/schedules/:id`, 'schedule:manage', 'Change a schedule (same fields as create). It is re-bound to your identity.', async (r, _rep, p) => updateSchedule(p, params(r).id, body(r)));
for (const action of ['pause', 'resume', 'cancel'] as const) {
  route('POST', `${AN}/schedules/:id/${action}`, 'schedule:manage', `${action[0].toUpperCase()}${action.slice(1)} a schedule${action === 'resume' ? ' (from its next future occurrence)' : action === 'cancel' ? ' (final; queued runs are cancelled)' : ''}.`, async (r, _rep, p) => setScheduleState(p, params(r).id, action));
}
route('POST', `${AN}/schedules/:id/run`, 'schedule:manage', 'Run a schedule now (manual run under the schedule\'s identity and destinations).', async (r, rep, p) => {
  rep.code(202);
  return runScheduleNow(p, params(r).id);
});

route('GET', `${AN}/runs`, 'saved_query:read', 'Run history. Query: query_id?, schedule_id?, status?, limit?.', async (r, _rep, p) => listRuns(p, { query_id: query(r).query_id, schedule_id: query(r).schedule_id, status: query(r).status, limit: int(query(r).limit, 50, 500) }));
route('GET', `${AN}/runs/:id`, 'saved_query:read', 'Run detail: phases, timings, analyses, insights and deliveries, re-authorized for your role (data withheld or re-masked where your access is narrower).', async (r, _rep, p) => getRun(p, params(r).id));
route('GET', `${AN}/runs/:id/result`, 'analysis:read', 'A page of the run\'s bounded result snapshot, re-masked for your role. Query: offset?, limit? (max 1000).', async (r, _rep, p) => getRunResult(p, params(r).id, int(query(r).offset, 0, 1_000_000), Math.max(1, int(query(r).limit, 200, 1000))));
route('POST', `${AN}/runs/:id/retry-deliveries`, 'schedule:manage', 'Retry failed or blocked deliveries of a run without re-running the query: {delivery_ids?}.', async (r, _rep, p) => retryRunDeliveries(p, params(r).id, strs(body(r).delivery_ids)));
route('POST', `${AN}/runs/:id/rerun`, 'analysis:run', 'Queue a new run with the same version and parameters.', async (r, rep, p) => {
  rep.code(202);
  return rerun(p, params(r).id);
});
route('POST', `${AN}/runs/:id/cancel`, 'analysis:run', 'Cancel a run that has not started.', async (r, _rep, p) => cancelRun(p, params(r).id));
route('POST', `${AN}/analyses/:id/review`, 'analysis:run', 'Name reviewed clusters: {cluster_names: {"1": "High volume", ...}}. Until reviewed, clusters are unnamed.', async (r, _rep, p) => reviewAnalysis(p, params(r).id, body(r)));

route('GET', `${AN}/destinations`, 'schedule:manage', 'Delivery destinations of the tenant (secrets are references; only their presence is shown).', async (_r, _rep, p) => listDestinations(p));
route('POST', `${AN}/destinations`, 'delivery:manage', 'Create a destination: {name, kind: in_app|email|webhook|export, config, content?: summary|summary_with_csv, notify_on?: always|success|failure|anomaly, enabled?, max_attempts?}.', async (r, rep, p) => {
  rep.code(201);
  return createDestination(p, body(r));
});
route('POST', `${AN}/destinations/:id`, 'delivery:manage', 'Change a destination (same fields as create; kind cannot change).', async (r, _rep, p) => updateDestination(p, params(r).id, body(r)));
route('POST', `${AN}/destinations/:id/test`, 'delivery:manage', 'Send a test message (no query data) and report the outcome.', async (r, _rep, p) => testDestination(p, params(r).id));
route('GET', `${AN}/exports/:id/download`, 'query:export', 'Download an exported CSV (expiring; re-authorized for your role; audited).', async (r, rep, p) => {
  const f = await downloadExport(p, params(r).id);
  rep.header('content-type', 'text/csv; charset=utf-8');
  rep.header('content-disposition', `attachment; filename="${f.file_name}"`);
  rep.header('x-clearline-sha256', f.sha256);
  return f.content;
});

route('GET', '/api/v1/tenants/:tenant/notifications', 'notification:read', 'Your in-app notifications (newest first). Query: unread?, limit?.', async (r, _rep, p) => listNotifications(p, { unread: bool(query(r).unread), limit: int(query(r).limit, 50, 500) }));
route('POST', '/api/v1/tenants/:tenant/notifications/:id/read', 'notification:read', 'Mark a notification read (id "all" marks every one).', async (r, _rep, p) => markRead(p, params(r).id));

export const ROUTES: readonly RouteDef[] = R;
