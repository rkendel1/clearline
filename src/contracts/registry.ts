// Contract registry: versioned tenant contracts and their migrations.
//
// Publish flow:   validate -> plan against the active version ->
//   initial/compatible   : applied immediately (DDL + views), new version active
//   requires_approval    : stored as pending; nothing changes until an admin approves
//   rejected             : nothing stored; reasons returned and audited
// Apply runs DDL, data operations and lifecycle changes in ONE transaction,
// holding the tenant's exclusive processing lock so no batch sees a half-migrated schema.

import { withTenant, type Tx, ident } from '../platform/db.js';
import { AppError, conflict, notFound, unprocessable } from '../platform/errors.js';
import type { Principal } from '../control/auth.js';
import { auditTx, audit } from '../control/audit.js';
import { validateContract } from './validate.js';
import { contractHash, table, transformVersion, viewsDDL } from './compile.js';
import { planMigration, type MigrationPlan } from './diff.js';
import type { Contract } from './types.js';
import { recordHash } from '../transform/engine.js';
import type { Canonical } from '../transform/coerce.js';

export interface ContractVersionRow {
  id: number; tenant_id: string; version: string; lifecycle: string; document: Contract; document_hash: string; transform_version: string;
}

const cache = new Map<number, ContractVersionRow>();

export async function getContractVersion(tx: Tx, id: number): Promise<ContractVersionRow> {
  const hit = cache.get(id);
  if (hit) {
    // lifecycle can change; document cannot (immutable per id)
    const { rows } = await tx.query(`SELECT lifecycle FROM core.contract_versions WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound(`contract version ${id}`);
    return { ...hit, lifecycle: rows[0].lifecycle };
  }
  const { rows } = await tx.query(`SELECT id, tenant_id, version, lifecycle, document, document_hash, transform_version FROM core.contract_versions WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`contract version ${id}`);
  const row = { ...rows[0], id: Number(rows[0].id) } as ContractVersionRow;
  cache.set(row.id, row);
  return row;
}

export async function getActiveContract(tx: Tx, tenantId: string): Promise<ContractVersionRow | null> {
  const { rows } = await tx.query(`SELECT id FROM core.contract_versions WHERE tenant_id = $1 AND lifecycle = 'active'`, [tenantId]);
  return rows[0] ? getContractVersion(tx, Number(rows[0].id)) : null;
}

/** Tenant-wide lock: processing takes it shared, migrations take it exclusive. */
export async function lockTenantShared(tx: Tx, tenantId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock_shared(hashtext('clearline.tenant.' || $1))`, [tenantId]);
}
async function lockTenantExclusive(tx: Tx, tenantId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('clearline.tenant.' || $1))`, [tenantId]);
}

async function addImpact(tx: Tx, tenantId: string, plan: MigrationPlan, prev: Contract | null) {
  if (!prev) return;
  plan.impact = {};
  for (const en of Object.keys(prev.entities)) {
    const { rows } = await tx.query(`SELECT count(*)::int AS n FROM ${table(tenantId, en)} WHERE "_is_current"`);
    plan.impact[en] = { current_rows: rows[0].n };
  }
  for (const op of plan.data_ops) {
    if (!prev.entities[op.entity]?.fields[op.field] && op.type === 'value_map') continue;
    const exists = !!prev.entities[op.entity]?.fields[op.field];
    let n = 0;
    if (op.type === 'backfill') {
      n = exists
        ? (await tx.query(`SELECT count(*)::int AS n FROM ${table(tenantId, op.entity)} WHERE "_is_current" AND ${ident(op.field)} IS NULL`)).rows[0].n
        : plan.impact[op.entity]?.current_rows ?? 0;
    } else {
      n = (await tx.query(`SELECT count(*)::int AS n FROM ${table(tenantId, op.entity)} WHERE "_is_current" AND ${ident(op.field)}::text = ANY($1)`, [Object.keys(op.value_map!)])).rows[0].n;
    }
    const cur = plan.impact[op.entity] ?? { current_rows: 0 };
    cur.affected_rows = (cur.affected_rows ?? 0) + n;
    plan.impact[op.entity] = cur;
  }
}

export interface PublishResult {
  contract_version_id: number | null;
  version: string;
  lifecycle: string;
  migration_id: number | null;
  migration_status: string;
  plan: MigrationPlan;
}

export async function publishContract(p: Principal, tenantId: string, doc: unknown): Promise<PublishResult> {
  const v = validateContract(doc);
  if (!v.ok) {
    await audit({ tenantId, actor: p.actor, role: p.role, action: 'contract.publish', outcome: 'failed', details: { reason: 'invalid_contract', issues: v.issues.slice(0, 20) }, correlationId: p.correlationId });
    throw unprocessable('invalid_contract', 'Contract failed validation', v.issues);
  }
  const contract = v.contract;
  if (contract.tenant !== tenantId) throw unprocessable('tenant_mismatch', `Contract declares tenant "${contract.tenant}" but was published to "${tenantId}"`);

  return withTenant(tenantId, async (tx) => {
    await lockTenantExclusive(tx, tenantId);
    const active = await getActiveContract(tx, tenantId);
    const pending = await tx.query(`SELECT id FROM core.contract_migrations WHERE tenant_id = $1 AND status = 'planned'`, [tenantId]);
    if (pending.rows.length) throw conflict('migration_pending', `Migration ${pending.rows[0].id} is awaiting approval; approve or reject it first`);
    const dupe = await tx.query(`SELECT 1 FROM core.contract_versions WHERE tenant_id = $1 AND version = $2`, [tenantId, contract.version]);
    if (dupe.rows.length) throw conflict('version_exists', `Version ${contract.version} already exists for ${tenantId}; versions are immutable`);

    const plan = planMigration(tenantId, active?.document ?? null, contract);
    await addImpact(tx, tenantId, plan, active?.document ?? null);

    if (plan.classification === 'rejected') {
      await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.publish', resource: `contract:${contract.version}`, outcome: 'failed', details: { reason: 'migration_rejected', rejected_reasons: plan.rejected_reasons }, correlationId: p.correlationId });
      // Commit the audit record, then signal rejection.
      return { contract_version_id: null, version: contract.version, lifecycle: 'rejected', migration_id: null, migration_status: 'rejected', plan };
    }

    const lifecycle = plan.classification === 'requires_approval' ? 'pending_approval' : 'active';
    const ins = await tx.query(
      `INSERT INTO core.contract_versions (tenant_id, contract_id, version, lifecycle, document, document_hash, transform_version, created_by)
       VALUES ($1,$2,$3,'pending_approval',$4,$5,$6,$7) RETURNING id`,
      [tenantId, contract.contract_id, contract.version, JSON.stringify(contract), contractHash(contract), transformVersion(contract), p.actor]);
    const cvId = Number(ins.rows[0].id);
    const mig = await tx.query(
      `INSERT INTO core.contract_migrations (tenant_id, from_version_id, to_version_id, classification, status, plan, requested_by)
       VALUES ($1,$2,$3,$4,'planned',$5,$6) RETURNING id`,
      [tenantId, active?.id ?? null, cvId, plan.classification, JSON.stringify(plan), p.actor]);
    const migId = Number(mig.rows[0].id);
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.publish', resource: `contract:${contract.version}`, outcome: 'succeeded', details: { migration_id: migId, classification: plan.classification, changes: plan.changes.length }, correlationId: p.correlationId });

    if (lifecycle === 'active') {
      await applyInTx(tx, tenantId, migId, p, null);
      return { contract_version_id: cvId, version: contract.version, lifecycle: 'active', migration_id: migId, migration_status: 'applied', plan };
    }
    return { contract_version_id: cvId, version: contract.version, lifecycle, migration_id: migId, migration_status: 'planned', plan };
  });
}

async function applyInTx(tx: Tx, tenantId: string, migId: number, p: Principal, approvedBy: string | null) {
  const { rows } = await tx.query(`SELECT * FROM core.contract_migrations WHERE id = $1 FOR UPDATE`, [migId]);
  const m = rows[0];
  const plan = m.plan as MigrationPlan;
  const next = await getContractVersion(tx, Number(m.to_version_id));
  for (const sql of plan.ddl) await tx.query(sql);
  // Views are regenerated before data operations so they reflect the new contract's column set.
  for (const sql of viewsDDL(tenantId, next.document)) await tx.query(sql);
  const dataCounts: Record<string, number> = {};
  if (plan.data_ops.length) Object.assign(dataCounts, await runDataOps(tx, tenantId, migId, next));
  if (m.from_version_id) await tx.query(`UPDATE core.contract_versions SET lifecycle = 'superseded' WHERE id = $1`, [m.from_version_id]);
  await tx.query(`UPDATE core.contract_versions SET lifecycle = 'active', activated_at = now() WHERE id = $1`, [m.to_version_id]);
  await tx.query(`UPDATE core.contract_migrations SET status = 'applied', applied_at = now(), approved_by = $2, approved_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1`, [migId, approvedBy]);
  await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.migration.apply', resource: `migration:${migId}`, outcome: 'succeeded', details: { to_version: next.version, ddl_statements: plan.ddl.length, data_ops: plan.data_ops.length, new_record_versions: dataCounts }, correlationId: p.correlationId });
}

/** Data operations write NEW record versions; prior versions remain unchanged with their original contract version. */
async function runDataOps(tx: Tx, tenantId: string, migId: number, next: ContractVersionRow): Promise<Record<string, number>> {
  const plan = (await tx.query(`SELECT plan FROM core.contract_migrations WHERE id = $1`, [migId])).rows[0].plan as MigrationPlan;
  const opsByEntity = new Map<string, MigrationPlan['data_ops']>();
  for (const op of plan.data_ops) opsByEntity.set(op.entity, [...(opsByEntity.get(op.entity) ?? []), op]);
  const counts: Record<string, number> = {};
  for (const [en, ops] of opsByEntity) {
    const t = table(tenantId, en);
    const entity = next.document.entities[en];
    const cols = (await tx.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name NOT LIKE '\\_%' ORDER BY ordinal_position`, [`t_${tenantId}`, en])).rows.map((r) => r.column_name as string);
    const { rows } = await tx.query(`SELECT * FROM ${t} WHERE "_is_current" ORDER BY "_record_id" FOR UPDATE`);
    let n = 0;
    for (const row of rows) {
      const values: Record<string, Canonical> = {};
      for (const c of cols) values[c] = row[c] === undefined ? null : normalizeDb(entity.fields[c]?.type, row[c]);
      let changed = false;
      for (const op of ops) {
        if (op.type === 'backfill' && values[op.field] === null) { values[op.field] = op.backfill_value!; changed = true; }
        if (op.type === 'value_map' && values[op.field] !== null && Object.prototype.hasOwnProperty.call(op.value_map!, String(values[op.field]))) { values[op.field] = op.value_map![String(values[op.field])]; changed = true; }
      }
      if (!changed) continue;
      const hash = recordHash(entity, values);
      await tx.query(`UPDATE ${t} SET "_is_current" = false WHERE "_record_id" = $1`, [row._record_id]);
      const colList = cols.map(ident).join(', ');
      const ph = cols.map((_, i) => `$${i + 9}`).join(', ');
      await tx.query(
        `INSERT INTO ${t} ("_key","_record_hash","_is_current","_is_late","_batch_id","_raw_record_id","_contract_version_id","_transform_version","_migration_id","_supersedes_record_id", ${colList})
         VALUES ($1,$2,true,false,$3,$4,$5,$6,$7,$8, ${ph})`,
        [row._key, hash, row._batch_id, row._raw_record_id, next.id, `migration#${migId}`, migId, row._record_id, ...cols.map((c) => values[c])]);
      n++;
    }
    counts[en] = n;
  }
  return counts;
}

function normalizeDb(type: string | undefined, v: unknown): Canonical {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (type === 'integer') return Number(v);
  return v as Canonical;
}

export async function approveMigration(p: Principal, tenantId: string, migId: number, confirmVersion: string, requireDistinctApprover: boolean) {
  return withTenant(tenantId, async (tx) => {
    await lockTenantExclusive(tx, tenantId);
    const { rows } = await tx.query(`SELECT m.*, v.version AS to_version FROM core.contract_migrations m JOIN core.contract_versions v ON v.id = m.to_version_id WHERE m.id = $1 AND m.tenant_id = $2 FOR UPDATE OF m`, [migId, tenantId]);
    const m = rows[0];
    if (!m) throw notFound(`migration ${migId}`);
    if (m.status !== 'planned') throw conflict('migration_not_pending', `Migration ${migId} is ${m.status}`);
    if (confirmVersion !== m.to_version) throw unprocessable('confirmation_mismatch', `Approval must confirm the target version "${m.to_version}"`);
    if (requireDistinctApprover && m.requested_by === p.actor) {
      await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.migration.approve', resource: `migration:${migId}`, outcome: 'denied', details: { reason: 'requester_cannot_approve' }, correlationId: p.correlationId });
      throw new AppError(403, 'requester_cannot_approve', 'A breaking migration must be approved by a different administrator than the one who requested it');
    }
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.migration.approve', resource: `migration:${migId}`, outcome: 'allowed', details: { to_version: m.to_version }, correlationId: p.correlationId });
    await applyInTx(tx, tenantId, migId, p, p.actor);
    return (await tx.query(`SELECT id, status, classification, approved_by, applied_at FROM core.contract_migrations WHERE id = $1`, [migId])).rows[0];
  }).catch(async (err) => {
    if (err instanceof AppError) {
      // Denials recorded via auditTx were rolled back with the transaction; persist them.
      if (err.code === 'requester_cannot_approve') await audit({ tenantId, actor: p.actor, role: p.role, action: 'contract.migration.approve', resource: `migration:${migId}`, outcome: 'denied', details: { reason: 'requester_cannot_approve' }, correlationId: p.correlationId });
      throw err;
    }
    await withTenant(tenantId, (tx) => tx.query(`UPDATE core.contract_migrations SET status = 'failed', error = $2 WHERE id = $1 AND status = 'planned'`, [migId, (err as Error).message]));
    await withTenant(tenantId, (tx) => tx.query(`UPDATE core.contract_versions SET lifecycle = 'rejected' WHERE id = (SELECT to_version_id FROM core.contract_migrations WHERE id = $1)`, [migId]));
    await audit({ tenantId, actor: p.actor, role: p.role, action: 'contract.migration.apply', resource: `migration:${migId}`, outcome: 'failed', details: { error: (err as Error).message }, correlationId: p.correlationId });
    throw err;
  });
}

export async function rejectMigration(p: Principal, tenantId: string, migId: number, reason: string) {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query(`UPDATE core.contract_migrations SET status = 'rejected', error = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'planned' RETURNING to_version_id`, [migId, tenantId, reason]);
    if (!rows[0]) throw conflict('migration_not_pending', `Migration ${migId} is not awaiting approval`);
    await tx.query(`UPDATE core.contract_versions SET lifecycle = 'rejected' WHERE id = $1`, [rows[0].to_version_id]);
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.migration.reject', resource: `migration:${migId}`, outcome: 'succeeded', details: { reason }, correlationId: p.correlationId });
    return { id: migId, status: 'rejected' };
  });
}

export async function rollbackMigration(p: Principal, tenantId: string, migId: number) {
  return withTenant(tenantId, async (tx) => {
    await lockTenantExclusive(tx, tenantId);
    const { rows } = await tx.query(`SELECT * FROM core.contract_migrations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [migId, tenantId]);
    const m = rows[0];
    if (!m) throw notFound(`migration ${migId}`);
    if (m.status !== 'applied') throw conflict('not_applied', `Migration ${migId} is ${m.status}`);
    if (!m.from_version_id) throw conflict('initial_migration', 'The initial contract version cannot be rolled back');
    const active = await getActiveContract(tx, tenantId);
    if (active?.id !== Number(m.to_version_id)) throw conflict('not_latest', 'Only the migration that produced the active version can be rolled back');
    const used = await tx.query(`SELECT count(*)::int AS n FROM core.batches WHERE contract_version_id = $1`, [m.to_version_id]);
    if (used.rows[0].n > 0) throw conflict('rollback_window_closed', `${used.rows[0].n} batch(es) were submitted under the new version; roll forward with a new contract version instead`);
    const plan = m.plan as MigrationPlan;
    const restored: Record<string, number> = {};
    for (const en of new Set(plan.data_ops.map((o) => o.entity))) {
      const t = table(tenantId, en);
      const del = await tx.query(`DELETE FROM ${t} WHERE "_migration_id" = $1 RETURNING "_supersedes_record_id"`, [migId]);
      const ids = del.rows.map((r) => r._supersedes_record_id);
      if (ids.length) await tx.query(`UPDATE ${t} SET "_is_current" = true WHERE "_record_id" = ANY($1)`, [ids]);
      restored[en] = ids.length;
    }
    await tx.query(`UPDATE core.contract_versions SET lifecycle = 'rolled_back' WHERE id = $1`, [m.to_version_id]);
    await tx.query(`UPDATE core.contract_versions SET lifecycle = 'active' WHERE id = $1`, [m.from_version_id]);
    const prev = await getContractVersion(tx, Number(m.from_version_id));
    for (const sql of viewsDDL(tenantId, prev.document)) await tx.query(sql);
    await tx.query(`UPDATE core.contract_migrations SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`, [migId]);
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'contract.migration.rollback', resource: `migration:${migId}`, outcome: 'succeeded', details: { restored_versions: restored }, correlationId: p.correlationId });
    return { id: migId, status: 'rolled_back', restored_versions: restored, active_version: prev.version };
  });
}
