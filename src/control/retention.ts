// Retention and deletion.
//
// Retention (scheduled or on demand), per tenant policy:
//   raw payloads       -> payload set to NULL after raw_payload_days; digest, row hash and row number remain as provenance
//   quarantine         -> RESOLVED items deleted after quarantine_days; open items stay until someone resolves them
//   superseded versions-> deleted after superseded_version_days when configured (narrows point-in-time history)
//   audit events       -> deleted only after audit_days (>= every data retention period)
// Erasure of one subject (entity key): all canonical versions, the raw payloads
// that produced them, and quarantine entries for that key are removed. Aggregates
// are computed live, so derived metrics change on the next query. Previously
// produced extracts cannot be recalled; they are listed in the erasure log.

import { createHash } from 'node:crypto';
import { withTenant } from '../platform/db.js';
import { notFound } from '../platform/errors.js';
import { getActiveContract } from '../contracts/registry.js';
import { table } from '../contracts/compile.js';
import { auditTx } from './audit.js';
import type { Principal } from './auth.js';
import { DEFAULT_RETENTION, type RetentionPolicy } from './tenants.js';
import { recordRemovalAdjustments } from '../reconciliation/reverify.js';

export async function runRetention(actor: Pick<Principal, 'actor' | 'role' | 'correlationId'>, tenant: string, now = new Date()) {
  return withTenant(tenant, async (tx) => {
    const t = (await tx.query(`SELECT retention FROM core.tenants WHERE id = $1`, [tenant])).rows[0];
    if (!t) throw notFound(`tenant ${tenant}`);
    const pol: RetentionPolicy = { ...DEFAULT_RETENTION, ...t.retention };
    const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const raw = await tx.query(`UPDATE core.raw_records r SET payload = NULL, purged_at = $3 FROM core.batches b
        WHERE r.batch_id = b.id AND r.tenant_id = $1 AND b.arrival_at < $2 AND r.payload IS NOT NULL`, [tenant, cutoff(pol.raw_payload_days), now.toISOString()]);
    const q = await tx.query(`DELETE FROM core.quarantine WHERE tenant_id = $1 AND status = 'resolved' AND created_at < $2`, [tenant, cutoff(pol.quarantine_days)]);
    let superseded = 0;
    if (pol.superseded_version_days) {
      const active = await getActiveContract(tx, tenant);
      for (const en of Object.keys(active?.document.entities ?? {})) {
        await recordRemovalAdjustments(tx, tenant, en, `NOT "_is_current" AND "_loaded_at" < $1`, [cutoff(pol.superseded_version_days)], 'retention:superseded_versions');
        const r = await tx.query(`DELETE FROM ${table(tenant, en)} WHERE NOT "_is_current" AND "_loaded_at" < $1`, [cutoff(pol.superseded_version_days)]);
        superseded += r.rowCount ?? 0;
      }
    }
    await tx.query(`SELECT set_config('app.audit_retention_purge', 'on', true)`);
    const a = await tx.query(`DELETE FROM core.audit_events WHERE tenant_id = $1 AND at < $2`, [tenant, cutoff(pol.audit_days)]);
    await tx.query(`SELECT set_config('app.audit_retention_purge', 'off', true)`);
    const counts = { raw_payloads_purged: raw.rowCount ?? 0, resolved_quarantine_deleted: q.rowCount ?? 0, superseded_versions_deleted: superseded, audit_events_deleted: a.rowCount ?? 0 };
    await auditTx(tx, { tenantId: tenant, actor: actor.actor, role: actor.role, action: 'retention.run', outcome: 'succeeded', details: { policy: pol, counts, as_of: now.toISOString() }, correlationId: actor.correlationId });
    return { tenant, policy: pol, counts };
  });
}

export async function eraseSubject(p: Principal, tenant: string, entity: string, key: string) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    const e = active?.document.entities[entity];
    if (!active || !e) throw notFound(`entity ${entity}`);
    const t = table(tenant, entity);
    const versions = (await tx.query(`SELECT "_record_id", "_raw_record_id" FROM ${t} WHERE "_key" = $1`, [key])).rows;
    const ids = versions.map((v) => Number(v._record_id));
    const exports = ids.length ? (await tx.query(`SELECT id, extract_id, created_at FROM core.export_log WHERE tenant_id = $1 AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(record_refs) ref WHERE ref->>0 = $2 AND (ref->>1)::bigint = ANY($3))`, [tenant, entity, ids])).rows : [];
    const dependents: Record<string, number> = {};
    for (const [en, other] of Object.entries(active.document.entities)) {
      for (const rel of other.relationships ?? []) {
        if (rel.references.entity !== entity) continue;
        dependents[`${en}.${rel.field}`] = (await tx.query(`SELECT count(*)::int AS n FROM ${table(tenant, en)} WHERE "_is_current" AND "${rel.field}"::text = $1`, [key])).rows[0].n;
      }
    }
    const rawIds = versions.map((v) => v._raw_record_id).filter(Boolean);
    const rawPurged = ids.length ? await tx.query(`UPDATE core.raw_records SET payload = NULL, purged_at = now() WHERE tenant_id = $1 AND (id = ANY($2) OR canonical_record_id = ANY($3))`, [tenant, rawIds, ids]) : { rowCount: 0 };
    const qRows = (await tx.query(`SELECT raw_record_id FROM core.quarantine WHERE tenant_id = $1 AND entity = $2 AND record_key = $3`, [tenant, entity, key])).rows;
    if (qRows.length) await tx.query(`UPDATE core.raw_records SET payload = NULL, purged_at = now() WHERE id = ANY($1)`, [qRows.map((r) => r.raw_record_id)]);
    const qDel = await tx.query(`DELETE FROM core.quarantine WHERE tenant_id = $1 AND entity = $2 AND record_key = $3`, [tenant, entity, key]);
    await recordRemovalAdjustments(tx, tenant, entity, `"_key" = $1`, [key], 'subject_erasure');
    const del = await tx.query(`DELETE FROM ${t} WHERE "_key" = $1`, [key]);
    const keyHash = createHash('sha256').update(`${tenant}:${entity}:${key}`).digest('hex');
    const counts = { canonical_versions_deleted: del.rowCount ?? 0, raw_payloads_purged: (rawPurged.rowCount ?? 0) + qRows.length, quarantine_deleted: qDel.rowCount ?? 0, dependents_retained: dependents };
    await tx.query(`INSERT INTO core.erasure_log (tenant_id, entity, key_sha256, requested_by, counts, affected_exports) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenant, entity, keyHash, p.actor, JSON.stringify(counts), JSON.stringify(exports)]);
    await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'subject.erase', resource: `${entity}:sha256:${keyHash.slice(0, 16)}`, outcome: 'succeeded', details: { counts, affected_exports: exports.length }, correlationId: p.correlationId });
    return { entity, key_sha256: keyHash, counts, affected_exports: exports,
      notes: ['Aggregates are computed from live data and no longer include this subject.', 'Extracts already delivered cannot be recalled; affected exports are listed for follow-up with recipients.',
        Object.values(dependents).some((n) => n > 0) ? 'Dependent records referencing this key were retained and now appear as orphaned references; erase them separately if required.' : 'No dependent records reference this key.'] };
  });
}
