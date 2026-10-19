// Field policy management API: list, change (with database grant regeneration
// in the same transaction), and version history.

import { withTenant } from '../platform/db.js';
import { AppError, notFound } from '../platform/errors.js';
import { DATA_ROLES, type Principal } from '../control/auth.js';
import { audit } from '../control/audit.js';
import { getActiveContract, regenerateViews } from '../contracts/registry.js';
import { STYLE_TYPES } from './mask.js';
import { loadPolicies, updateFieldPolicy, type PolicyPatch } from './fields.js';

export async function listFieldPolicies(p: Principal) {
  return withTenant(p.tenantId!, async (tx) => {
    const active = await getActiveContract(tx, p.tenantId!);
    if (!active) throw notFound('no active contract');
    const set = await loadPolicies(tx, p.tenantId!, active.document);
    const viewer = set.viewer(p.role);
    const entities = Object.entries(active.document.entities).map(([en, e]) => ({
      entity: en, description: e.description ?? null, table_policy: set.policy(en, '*'),
      fields: Object.entries(e.fields).filter(([f]) => viewer.level(en, f) !== 'hidden').map(([f, def]) => ({
        field: f, type: def.type, description: def.description ?? null, contract_sensitivity: def.sensitivity ?? 'internal',
        allowed_redactions: ['full', ...Object.entries(STYLE_TYPES).filter(([, types]) => types.includes(def.type)).map(([s]) => s)],
        policy: set.policy(en, f),
        effective_access: Object.fromEntries(DATA_ROLES.map((r) => [r, set.access(r, en, f)])),
      })),
    }));
    return { tenant: p.tenantId, contract_version: active.version, policy_epoch: set.epoch, roles: DATA_ROLES, entities };
  });
}

export async function changeFieldPolicy(p: Principal, entity: string, field: string, patch: PolicyPatch) {
  try {
    return await withTenant(p.tenantId!, async (tx) => {
      const active = await getActiveContract(tx, p.tenantId!);
      if (!active) throw notFound('no active contract');
      const set = await loadPolicies(tx, p.tenantId!, active.document);
      const res = await updateFieldPolicy(tx, p, set, entity, field, patch);
      // BI views, query views and database grants follow the new policy before the change commits.
      await regenerateViews(tx, p.tenantId!);
      const after = await loadPolicies(tx, p.tenantId!, active.document);
      return { ...res, policy_epoch: after.epoch, effective_access: field === '*' ? null : Object.fromEntries(DATA_ROLES.map((r) => [r, after.access(r, entity, field)])) };
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 403) {
      await audit({ tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'policy.field.update', resource: `field:${entity}.${field}`, outcome: 'denied',
        details: { reason: err.code, requested: patch }, correlationId: p.correlationId });
    }
    throw err;
  }
}

export async function fieldPolicyHistory(p: Principal, opts: { entity?: string; field?: string; limit: number }) {
  return withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT id, entity, field, version, policy, previous, change_kind, changed_by, changed_role, changed_at
      FROM core.field_policy_versions WHERE tenant_id = $1 AND ($2::text IS NULL OR entity = $2) AND ($3::text IS NULL OR field = $3) ORDER BY id DESC LIMIT $4`,
    [p.tenantId, opts.entity ?? null, opts.field ?? null, opts.limit])).rows);
}
