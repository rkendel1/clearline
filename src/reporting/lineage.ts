// End-to-end lineage for one entity key: every version, the source row and
// batch that produced it, the contract/transform versions, quality findings,
// reconciliation outcome, which declared metrics it contributes to, and which
// extracts exported it.

import { withTenant, ident } from '../platform/db.js';
import { notFound } from '../platform/errors.js';
import { getActiveContract, getContractVersion } from '../contracts/registry.js';
import type { Role } from '../control/auth.js';
import { loadPolicies } from '../policy/fields.js';
import { table } from '../contracts/compile.js';
import { conditionSql, currentFrom, Params } from './sql.js';
import { mappedColumns } from '../transform/engine.js';

export async function recordLineage(tenant: string, entity: string, key: string, role: Role) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) throw notFound('no active contract');
    const c = active.document;
    const e = Object.hasOwn(c.entities, entity) ? c.entities[entity] : undefined;
    if (!e) throw notFound(`entity ${entity}`);
    const viewer = (await loadPolicies(tx, tenant, c)).viewer(role);
    // A key the role may not see (or filter by) cannot be looked up: the same answer as a key that does not exist.
    if (e.key.some((k) => !['full', 'masked', 'filter'].includes(viewer.level(entity, k)))) throw notFound(`no ${entity} with key ${key}`);
    const { rows: versions } = await tx.query(`SELECT * FROM ${table(tenant, entity)} WHERE "_key" = $1 ORDER BY "_record_id"`, [key]);
    const quarantined = (await tx.query(`SELECT q.id, q.batch_id, q.category, q.status, q.errors, r.row_number FROM core.quarantine q JOIN core.raw_records r ON r.id = q.raw_record_id
        WHERE q.tenant_id = $1 AND q.entity = $2 AND q.record_key = $3 ORDER BY q.id`, [tenant, entity, key])).rows;
    if (!versions.length && !quarantined.length) throw notFound(`no ${entity} with key ${key}`);

    const ep = new Params();
    const eff = (await tx.query(`SELECT r."_record_id" AS id ${currentFrom(tenant, entity, 'trusted', undefined, ep)} AND r."_key" = ${ep.add(key)}`, ep.values)).rows[0];
    const effectiveId = eff ? Number(eff.id) : null;
    const out = [];
    for (const v of versions) {
      const id = Number(v._record_id);
      const values: Record<string, unknown> = {};
      for (const f of Object.keys(e.fields)) { const r = viewer.present(entity, f, v[f]); if (r.visible) values[f] = r.value; }
      const batch = (await tx.query(`SELECT b.id, b.source_id, b.format, b.payload_digest, b.arrival_at, b.source_reported_at, b.is_late, b.status, b.trust_status, b.trust_reasons,
          b.quality_status, b.reconciliation_status, b.attempt_count, b.submitted_by FROM core.batches b WHERE b.id = $1`, [v._batch_id])).rows[0];
      const cv = await getContractVersion(tx, Number(v._contract_version_id));
      let source_row: unknown = null;
      if (v._raw_record_id) {
        const raw = (await tx.query(`SELECT id, row_number, payload, row_hash, disposition, purged_at FROM core.raw_records WHERE id = $1`, [v._raw_record_id])).rows[0];
        if (raw) {
          const src = cv.document.sources[batch.source_id];
          const cols = mappedColumns(src);
          // A source column is shown as the most restricted canonical field it maps to (current policy, by field name).
          const colTargets = new Map<string, string[]>();
          for (const m of src.mappings) for (const col of typeof m.from === 'string' ? [m.from] : m.from ?? []) colTargets.set(col, [...(colTargets.get(col) ?? []), m.target]);
          const payload: Record<string, unknown> | null = raw.payload ? {} : null;
          for (const [k, val] of Object.entries((raw.payload ?? {}) as Record<string, unknown>)) {
            if (!cols.has(k)) continue;
            const targets = colTargets.get(k) ?? [];
            const shown = targets.map((t) => viewer.present(src.entity, t, val));
            if (shown.some((x) => !x.visible)) continue;
            const maskedBy = targets.find((t) => viewer.level(src.entity, t) === 'masked');
            payload![k] = maskedBy ? viewer.present(src.entity, maskedBy, val).value : val;
          }
          const findings = (await tx.query(`SELECT rule_id, severity, category, field, message FROM core.quality_findings WHERE raw_record_id = $1 ORDER BY id`, [raw.id])).rows
            .map((f) => ({ ...f, message: viewer.message(src.entity, f.field, f.message) }));
          source_row = { raw_record_id: Number(raw.id), row_number: raw.row_number, row_hash: raw.row_hash, disposition: raw.disposition,
            payload_retained: !!raw.payload, purged_at: raw.purged_at, mapped_columns: payload, unmapped_columns_omitted: true, quality_findings: findings };
        }
      }
      const duplicates = (await tx.query(`SELECT r.batch_id, r.row_number FROM core.raw_records r WHERE r.canonical_record_id = $1 AND r.disposition = 'duplicate' ORDER BY r.id`, [id])).rows;
      const recon = (await tx.query(`SELECT check_id, status, explanation FROM core.reconciliation_results WHERE batch_id = $1 ORDER BY id`, [v._batch_id])).rows;
      // Metric contribution follows the same definition as the metrics themselves (currentFrom 'trusted'):
      // the version counted is the latest one from a trusted batch, which need not be the current one.
      const contributes: { metric_id: string; included: boolean; reason: string }[] = [];
      const isEffective = id === effectiveId;
      if (v._is_current || isEffective) {
        for (const m of c.outputs.metrics.filter((m) => m.entity === entity)) {
          const p = new Params();
          const cond = m.filter ? conditionSql(m.filter, e, p) : 'true';
          const r = (await tx.query(`SELECT coalesce(${cond}, false) AS hit FROM ${table(tenant, entity)} r JOIN core.batches b ON b.id = r."_batch_id" WHERE r."_record_id" = ${p.add(id, 'bigint')}`, p.values)).rows[0];
          contributes.push({ metric_id: m.id, included: r.hit && isEffective, reason: !isEffective ? 'excluded: batch not trusted (trusted metrics use the latest trusted version)' : !r.hit ? 'excluded by metric filter' : 'included' });
        }
      }
      const exports = (await tx.query(`SELECT id, extract_id, requested_by, created_at, as_of, content_sha256 FROM core.export_log
          WHERE tenant_id = $1 AND record_refs @> $2::jsonb ORDER BY created_at`, [tenant, JSON.stringify([[entity, id]])])).rows;
      let migration = null;
      if (v._migration_id) migration = (await tx.query(`SELECT id, classification, approved_by, applied_at FROM core.contract_migrations WHERE id = $1`, [v._migration_id])).rows[0];
      out.push({
        record_id: id, is_current: v._is_current, is_late: v._is_late, loaded_at: v._loaded_at, values,
        contract_version: cv.version, transform_version: v._transform_version, supersedes_record_id: v._supersedes_record_id ? Number(v._supersedes_record_id) : null,
        migration, batch, source_row, duplicate_deliveries: duplicates, batch_reconciliation: recon, metric_contribution: contributes, exports,
      });
    }
    return {
      tenant, entity, key, active_contract_version: active.version,
      current_record_id: out.find((v) => v.is_current)?.record_id ?? null,
      trusted_record_id: effectiveId,
      versions: out,
      quarantined_submissions: quarantined.map((q) => ({ ...q, errors: (q.errors as { rule_id: string; message: string }[]).map((x) => ({ rule_id: x.rule_id, message: x.message })) })),
      ordering: e.correction,
    };
  });
}

export async function listRecords(tenant: string, entity: string, opts: { limit: number; offset: number; role: Role }) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) throw notFound('no active contract');
    const e = Object.hasOwn(active.document.entities, entity) ? active.document.entities[entity] : undefined;
    if (!e) throw notFound(`entity ${entity}`);
    const viewer = (await loadPolicies(tx, tenant, active.document)).viewer(opts.role);
    // Fields the role may not see are not even read.
    const fields = Object.keys(e.fields).filter((f) => viewer.present(entity, f, null).visible);
    const { rows } = await tx.query(`SELECT r."_record_id", r."_key", r."_batch_id", b.trust_status AS "_trust_status", ${fields.map((f) => `r.${ident(f)}`).join(', ')}
        FROM ${table(tenant, entity)} r JOIN core.batches b ON b.id = r."_batch_id" WHERE r."_is_current" ORDER BY r."_key" LIMIT $1 OFFSET $2`, [opts.limit, opts.offset]);
    const total = (await tx.query(`SELECT count(*)::int AS n FROM ${table(tenant, entity)} WHERE "_is_current"`)).rows[0].n;
    return { entity, total, limit: opts.limit, offset: opts.offset,
      fields, records: rows.map((r) => ({ ...viewer.record(entity, r), _key: viewer.key(entity, e.key, r._key) })) };
  });
}
