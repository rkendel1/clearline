// CSV extracts with explicit schemas, captured as-of timestamps and canonical
// filters, so re-running an extract with the same parameters reproduces the
// same bytes (verified by content hash in core.export_log).

import { createHash, randomUUID } from 'node:crypto';
import { stringify } from 'csv-stringify/sync';
import { withTenant, ident } from '../platform/db.js';
import { badRequest, forbidden, notFound } from '../platform/errors.js';
import { getActiveContract } from '../contracts/registry.js';
import { SENSITIVE, type Condition, type Contract, type ExtractDef } from '../contracts/types.js';
import { stableStringify } from '../contracts/compile.js';
import { audit, auditTx } from '../control/audit.js';
import { can, type Principal } from '../control/auth.js';
import { conditionSql, currentFrom, Params } from './sql.js';
import { parseCanonical } from '../transform/coerce.js';
import { failingDatasetChecks } from './reports.js';

export const LINEAGE_COLUMNS = ['_record_id', '_key', '_batch_id', '_contract_version', '_trust_status'] as const;
export const REDACTED = 'REDACTED';

export function extractSchema(c: Contract, x: ExtractDef) {
  const e = c.entities[x.entity];
  return {
    extract_id: x.id, title: x.title, entity: x.entity, contract_version: c.version, format: 'text/csv; header=present; charset=utf-8',
    columns: [
      { name: '_record_id', type: 'integer', description: 'canonical record version id (lineage)' },
      { name: '_key', type: 'string', description: 'entity key' },
      { name: '_batch_id', type: 'string', description: 'batch that produced this version' },
      { name: '_contract_version', type: 'string', description: 'contract version that produced this version' },
      { name: '_trust_status', type: 'string', description: 'trusted | untrusted (batch reconciliation/quality outcome)' },
      ...x.fields.map((f) => ({ name: f, type: e.fields[f].type, description: e.fields[f].description ?? null, sensitivity: e.fields[f].sensitivity ?? 'internal',
        nullable: e.fields[f].nullable ?? true, redacted_by_default: SENSITIVE.has(e.fields[f].sensitivity ?? 'internal'),
        ...(e.fields[f].type === 'decimal' ? { precision: e.fields[f].precision, scale: e.fields[f].scale } : {}),
        ...(e.fields[f].values ? { values: e.fields[f].values } : {}) })),
    ],
    filterable: x.filterable ?? [],
    ordering: '_key ascending',
  };
}

export interface ExtractRequest {
  filters?: Record<string, unknown>;
  as_of?: string;
  include_sensitive?: boolean;
  include_untrusted?: boolean;
}

function toCondition(x: ExtractDef, c: Contract, filters: Record<string, unknown>): Condition[] {
  const e = c.entities[x.entity];
  const out: Condition[] = [];
  for (const [field, spec] of Object.entries(filters)) {
    if (!(x.filterable ?? []).includes(field)) throw badRequest('invalid_filter', `"${field}" is not filterable for extract ${x.id} (allowed: ${(x.filterable ?? []).join(', ') || 'none'})`);
    const f = e.fields[field];
    const check = (v: unknown) => { const r = parseCanonical(f, v); if (!r.ok) throw badRequest('invalid_filter', `${field}: ${r.error}`); return r.value as string | number; };
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        if (!['eq', 'gte', 'lte', 'gt', 'lt'].includes(op)) throw badRequest('invalid_filter', `unsupported operator ${op}`);
        out.push({ field, op: op as 'eq', value: check(v) });
      }
    } else if (Array.isArray(spec)) out.push({ field, op: 'in', values: spec.map(check) });
    else out.push({ field, op: 'eq', value: check(spec) });
  }
  return out;
}

export async function runExtract(p: Principal, tenant: string, extractId: string, req: ExtractRequest) {
  const asOf = req.as_of ? new Date(req.as_of) : new Date();
  if (Number.isNaN(asOf.getTime())) throw badRequest('invalid_as_of', 'as_of must be an ISO-8601 timestamp');
  const filters = req.filters ?? {};
  const params = { filters, as_of: asOf.toISOString(), include_sensitive: !!req.include_sensitive, include_untrusted: !!req.include_untrusted };

  if (req.include_sensitive && !can(p, 'extract:sensitive')) {
    await audit({ tenantId: tenant, actor: p.actor, role: p.role, action: 'extract.run', resource: `extract:${extractId}`, outcome: 'denied',
      details: { reason: 'sensitive_fields_not_permitted', params }, correlationId: p.correlationId });
    throw forbidden('sensitive_export_denied', `Role ${p.role} may not export sensitive fields; request without include_sensitive to receive redacted values`);
  }

  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) throw notFound('no active contract');
    const c = active.document;
    const x = c.outputs.extracts.find((e) => e.id === extractId);
    if (!x) throw notFound(`extract ${extractId}`);
    const failing = (await failingDatasetChecks(tx, tenant, c)).get(x.entity) ?? [];
    const e = c.entities[x.entity];
    const pr = new Params();
    const from = currentFrom(tenant, x.entity, req.include_untrusted ? 'all' : 'trusted', params.as_of, pr, 'JOIN core.contract_versions cv ON cv.id = r."_contract_version_id"');
    const conds = toCondition(x, c, filters).map((cd) => conditionSql(cd, e, pr));
    const sql = `SELECT r."_record_id", r."_key", r."_batch_id", cv.version AS "_contract_version", b.trust_status AS "_trust_status", ${x.fields.map((f) => `r.${ident(f)}`).join(', ')}
      ${from}${conds.length ? ' AND ' + conds.join(' AND ') : ''}
      ORDER BY r."_key", r."_record_id"`;
    const { rows } = await tx.query(sql, pr.values);
    const sensitive = new Set(x.fields.filter((f) => SENSITIVE.has(e.fields[f].sensitivity ?? 'internal')));
    const header = [...LINEAGE_COLUMNS, ...x.fields];
    const fmt = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));
    const body = rows.map((r) => header.map((h) => (sensitive.has(h) && !req.include_sensitive ? REDACTED : fmt(r[h]))));
    const csv = stringify([header, ...body]);
    const sha = createHash('sha256').update(csv).digest('hex');
    const exportId = randomUUID();
    await tx.query(`INSERT INTO core.export_log (id, tenant_id, extract_id, contract_version_id, requested_by, role, params, as_of, row_count, content_sha256, record_refs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [exportId, tenant, x.id, active.id, p.actor, p.role, stableStringify(params), params.as_of, rows.length, sha, JSON.stringify(rows.map((r) => [x.entity, Number(r._record_id)]))]);
    await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'extract.run', resource: `extract:${x.id}`, outcome: 'succeeded',
      details: { export_id: exportId, rows: rows.length, sha256: sha, params, sensitive_fields: [...sensitive], sensitive_included: !!req.include_sensitive }, correlationId: p.correlationId });
    return { csv, meta: { export_id: exportId, extract_id: x.id, contract_version: active.version, as_of: params.as_of, filters: stableStringify(filters),
      row_count: rows.length, sha256: sha, redacted_fields: req.include_sensitive ? [] : [...sensitive], trust_scope: req.include_untrusted ? 'all' : 'trusted',
      dataset_checks_failing: failing.map((f) => f.check_id) } };
  });
}
