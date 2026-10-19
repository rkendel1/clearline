// Field-level access policy and sensitivity (one model for every read surface).
//
// Two independent dimensions decide what a role gets for a field:
//   1. Role access (authorization): hidden < discover < filter < full
//        hidden   - the field does not exist for the role (catalog, contract view, errors)
//        discover - the role may see that the field exists, but not use it
//        filter   - usable only for relationship joins and IS [NOT] NULL tests; never returned
//        full     - may be returned, grouped, sorted and used in any expression
//      Table-level access is the policy row with field '*'; a field gets the lower of the two.
//   2. Sensitivity (redaction): a sensitive field is returned in its redacted form
//      ("masked") to every role that is not listed in unmask_roles.
// Sensitivity can only lower what a role receives: marking a field sensitive never
// grants anything. Absent a configured row, the policy is derived from the contract
// classification: pii/phi are sensitive, fully redacted, and unmasked only for roles
// holding record:read_sensitive (the platform's pre-existing rule).

import type { Tx } from '../platform/db.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import type { Contract } from '../contracts/types.js';
import { SENSITIVE } from '../contracts/types.js';
import { DATA_ROLES, ROLE_PERMISSIONS, can, type Principal, type Role } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { maskValue, REDACTED_MARKER, REDACTION_STYLES, STYLE_DISCLOSURE, STYLE_TYPES, type RedactionStyle } from './mask.js';

export type RoleAccess = 'hidden' | 'discover' | 'filter' | 'full';
export type AccessLevel = RoleAccess | 'masked';
export const ROLE_ACCESS_LEVELS: readonly RoleAccess[] = ['hidden', 'discover', 'filter', 'full'];
const RANK: Record<AccessLevel, number> = { hidden: 0, discover: 1, filter: 2, masked: 3, full: 4 };
export const atLeast = (l: AccessLevel, min: AccessLevel) => RANK[l] >= RANK[min];
export const viewable = (l: AccessLevel) => l === 'full' || l === 'masked';
const minLevel = (a: RoleAccess, b: RoleAccess): RoleAccess => (RANK[a] <= RANK[b] ? a : b);

export type DataRole = (typeof DATA_ROLES)[number];
export const isDataRole = (r: string): r is DataRole => (DATA_ROLES as readonly string[]).includes(r);

export interface FieldPolicy {
  entity: string;
  field: string;               // '*' = table-level
  sensitive: boolean;
  redaction: RedactionStyle;
  reason: string | null;
  unmask_roles: DataRole[];
  role_access: Partial<Record<DataRole, RoleAccess>>;
  version: number;             // 0 = contract default, never configured
  source: 'contract' | 'configured';
  updated_by: string | null;
  updated_at: string | null;
}

export const DEFAULT_UNMASK_ROLES: DataRole[] = DATA_ROLES.filter((r) => ROLE_PERMISSIONS[r].has('record:read_sensitive'));

export function defaultPolicy(c: Contract, entity: string, field: string): FieldPolicy {
  const sensitive = field !== '*' && SENSITIVE.has(c.entities[entity]?.fields[field]?.sensitivity ?? 'internal');
  return {
    entity, field, sensitive, redaction: 'full',
    reason: sensitive ? `Classified ${c.entities[entity].fields[field].sensitivity} in contract ${c.version}` : null,
    unmask_roles: [...DEFAULT_UNMASK_ROLES], role_access: {}, version: 0, source: 'contract', updated_by: null, updated_at: null,
  };
}

/** All field policies of a tenant, resolved against its active contract. */
export class PolicySet {
  constructor(readonly tenant: string, readonly contract: Contract, private rows: Map<string, FieldPolicy>, readonly epoch: number) {}

  policy(entity: string, field: string): FieldPolicy {
    return this.rows.get(`${entity}.${field}`) ?? defaultPolicy(this.contract, entity, field);
  }

  /** Effective access of a role to one field: role access (field and table), then sensitivity. */
  access(role: Role, entity: string, field: string): AccessLevel {
    if (!isDataRole(role)) return 'hidden';
    if (!Object.hasOwn(this.contract.entities, entity) || !Object.hasOwn(this.contract.entities[entity].fields, field)) return 'hidden';
    const p = this.policy(entity, field);
    const base = minLevel(this.policy(entity, '*').role_access[role] ?? 'full', p.role_access[role] ?? 'full');
    if (base === 'full' && p.sensitive && !p.unmask_roles.includes(role)) return 'masked';
    return base;
  }

  viewer(role: Role): FieldViewer { return new FieldViewer(role, this); }

  /** Every configured or derived policy for the active contract, for the management UI. */
  list(): FieldPolicy[] {
    const out: FieldPolicy[] = [];
    for (const [en, e] of Object.entries(this.contract.entities)) {
      out.push(this.policy(en, '*'));
      for (const f of Object.keys(e.fields)) out.push(this.policy(en, f));
    }
    return out;
  }
}

/** What one role sees of each field, for read surfaces that return stored values. */
export class FieldViewer {
  constructor(readonly role: Role, readonly set: PolicySet) {}
  level(entity: string, field: string): AccessLevel { return this.set.access(this.role, entity, field); }
  style(entity: string, field: string): RedactionStyle { return this.set.policy(entity, field).redaction; }

  /**
   * The value as this role may see it: original (full), redacted (masked), or not at all.
   * `marker` is the surface's full-redaction token ('[redacted]' in JSON, 'REDACTED' in CSV).
   */
  present(entity: string, field: string, value: unknown, marker = REDACTED_MARKER): { visible: boolean; value: unknown } {
    const l = this.level(entity, field);
    if (l === 'full') return { visible: true, value: value instanceof Date ? value.toISOString() : value };
    if (l !== 'masked') return { visible: false, value: undefined };
    if (value === null || value === undefined) return { visible: true, value: null };
    const s = value instanceof Date ? value.toISOString() : String(value);
    return { visible: true, value: maskValue(s, this.style(entity, field), marker) };
  }

  /** Values of a record restricted to what the role may see; invisible fields are omitted. */
  record(entity: string, values: Record<string, unknown>, marker = REDACTED_MARKER): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (!Object.hasOwn(this.set.contract.entities[entity]?.fields ?? {}, k)) { out[k] = v instanceof Date ? v.toISOString() : v; continue; }
      const r = this.present(entity, k, v, marker);
      if (r.visible) out[k] = r.value;
    }
    return out;
  }

  /** The composite record key ("_key") as this role may see it: original only when every key field is fully visible. */
  key(entity: string, keyFields: string[], value: unknown, marker = REDACTED_MARKER): unknown {
    const levels = keyFields.map((k) => this.level(entity, k));
    if (levels.every((l) => l === 'full')) return value;
    if (keyFields.length === 1 && levels[0] === 'masked') return this.present(entity, keyFields[0], value, marker).value;
    return marker;
  }

  /**
   * Quality messages embed offending values only for fields classified non-sensitive at
   * ingestion time. A field restricted or redacted for this role since then must not leak
   * through an old message, so the value part is removed.
   */
  message(entity: string, field: string | null | undefined, msg: string): string {
    if (!field || this.level(entity, field) === 'full') return msg;
    return msg.replace(/\s*\(got [^)]*\)\s*$/, '').replace(/\s*\("[^"]*"\)\s*$/, '');
  }
}

export async function policyEpoch(tx: Tx, tenant: string): Promise<number> {
  return Number((await tx.query(`SELECT coalesce(max(id), 0) AS e FROM core.field_policy_versions WHERE tenant_id = $1`, [tenant])).rows[0].e);
}

function fromRow(r: Record<string, any>): FieldPolicy {
  return {
    entity: r.entity, field: r.field, sensitive: r.sensitive, redaction: r.redaction, reason: r.reason,
    unmask_roles: (r.unmask_roles as string[]).filter(isDataRole), role_access: r.role_access ?? {}, version: r.version,
    source: 'configured', updated_by: r.updated_by, updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

export async function loadPolicies(tx: Tx, tenant: string, contract: Contract): Promise<PolicySet> {
  const { rows } = await tx.query(`SELECT * FROM core.field_policies WHERE tenant_id = $1`, [tenant]);
  return new PolicySet(tenant, contract, new Map(rows.map((r) => [`${r.entity}.${r.field}`, fromRow(r)])), await policyEpoch(tx, tenant));
}

export interface PolicyPatch {
  sensitive?: boolean;
  redaction?: RedactionStyle;
  reason?: string | null;
  unmask_roles?: string[];
  role_access?: Record<string, string>;
}

type ChangeKind = 'tighten' | 'loosen' | 'mixed' | 'none';

/** Which parts of a change grant more than before. Anything that is not strictly narrowing counts as loosening. */
export function classifyChange(before: FieldPolicy, after: FieldPolicy): { kind: ChangeKind; loosening: string[]; tightening: string[] } {
  const loosening: string[] = [];
  const tightening: string[] = [];
  if (before.sensitive !== after.sensitive) (after.sensitive ? tightening : loosening).push(after.sensitive ? 'marked sensitive' : 'sensitivity removed');
  if (before.sensitive && after.sensitive && before.redaction !== after.redaction) {
    (STYLE_DISCLOSURE[after.redaction] > STYLE_DISCLOSURE[before.redaction] || (STYLE_DISCLOSURE[after.redaction] === STYLE_DISCLOSURE[before.redaction]) ? loosening : tightening)
      .push(`redaction ${before.redaction} -> ${after.redaction}`);
  }
  // Unmask roles only matter while a field is sensitive; a non-sensitive field is unmasked for everyone.
  const unmasked = (x: FieldPolicy, r: DataRole) => !x.sensitive || x.unmask_roles.includes(r);
  for (const r of DATA_ROLES) {
    const was = unmasked(before, r), now = unmasked(after, r);
    if (was !== now && before.sensitive === after.sensitive) (now ? loosening : tightening).push(`${now ? 'may now' : 'may no longer'} view original values: ${r}`);
    const a = before.role_access[r] ?? 'full', b = after.role_access[r] ?? 'full';
    if (a !== b) (RANK[b] > RANK[a] ? loosening : tightening).push(`${r} access ${a} -> ${b}`);
  }
  const kind: ChangeKind = loosening.length && tightening.length ? 'mixed' : loosening.length ? 'loosen' : tightening.length ? 'tighten' : 'none';
  return { kind, loosening, tightening };
}

/**
 * Apply a policy change for one field (or '*' for the table). policy:manage may only narrow;
 * any part that widens access requires policy:grant. Runs inside the caller's transaction,
 * which also regenerates the database query grants (see src/query/surface.ts).
 */
export async function updateFieldPolicy(tx: Tx, p: Principal, set: PolicySet, entity: string, field: string, patch: PolicyPatch): Promise<{ policy: FieldPolicy; change: ReturnType<typeof classifyChange> }> {
  const c = set.contract;
  const e = Object.hasOwn(c.entities, entity) ? c.entities[entity] : undefined;
  if (!e || (field !== '*' && !Object.hasOwn(e.fields, field))) throw notFound(`field ${entity}.${field}`);
  const before = set.policy(entity, field);
  const after: FieldPolicy = { ...before, unmask_roles: [...before.unmask_roles], role_access: { ...before.role_access } };

  if (patch.sensitive !== undefined) {
    if (typeof patch.sensitive !== 'boolean') throw badRequest('invalid_policy', 'sensitive must be a boolean');
    if (field === '*' && patch.sensitive) throw badRequest('invalid_policy', 'sensitivity is set per field, not per table');
    after.sensitive = patch.sensitive;
  }
  if (patch.redaction !== undefined) {
    if (!REDACTION_STYLES.includes(patch.redaction)) throw badRequest('invalid_policy', `redaction must be one of ${REDACTION_STYLES.join(', ')}`);
    if (patch.redaction !== 'full' && !STYLE_TYPES[patch.redaction].includes(e.fields[field]?.type ?? '')) {
      throw badRequest('invalid_policy', `${patch.redaction} masking is not supported for ${e.fields[field]?.type ?? 'table'} fields`);
    }
    after.redaction = patch.redaction;
  }
  if (patch.reason !== undefined) after.reason = patch.reason === null ? null : String(patch.reason).slice(0, 500).trim() || null;
  if (patch.unmask_roles !== undefined) {
    if (!Array.isArray(patch.unmask_roles) || !patch.unmask_roles.every(isDataRole)) throw badRequest('invalid_policy', `unmask_roles must list roles among ${DATA_ROLES.join(', ')}`);
    after.unmask_roles = [...new Set(patch.unmask_roles)] as DataRole[];
  }
  if (patch.role_access !== undefined) {
    if (typeof patch.role_access !== 'object' || patch.role_access === null) throw badRequest('invalid_policy', 'role_access must be an object');
    for (const [r, l] of Object.entries(patch.role_access)) {
      if (!isDataRole(r) || !ROLE_ACCESS_LEVELS.includes(l as RoleAccess)) throw badRequest('invalid_policy', `role_access maps ${DATA_ROLES.join('|')} to ${ROLE_ACCESS_LEVELS.join('|')}`);
      if (l === 'full') delete after.role_access[r]; else after.role_access[r] = l as RoleAccess;
    }
  }
  if (after.sensitive && field !== '*' && !after.reason) throw badRequest('invalid_policy', 'a reason is required for a sensitive field');

  const change = classifyChange(before, after);
  if ((change.kind === 'loosen' || change.kind === 'mixed') && !can(p, 'policy:grant')) {
    throw new AppError(403, 'policy_widening_not_permitted', `Role ${p.role} may only make field policies stricter; widening (${change.loosening.join('; ')}) requires policy:grant`);
  }
  after.version = before.version + 1;
  after.source = 'configured';
  after.updated_by = p.actor;
  const { rows } = await tx.query(
    `INSERT INTO core.field_policies (tenant_id, entity, field, sensitive, redaction, reason, unmask_roles, role_access, version, updated_by, updated_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, entity, field) DO UPDATE SET sensitive = EXCLUDED.sensitive, redaction = EXCLUDED.redaction, reason = EXCLUDED.reason,
       unmask_roles = EXCLUDED.unmask_roles, role_access = EXCLUDED.role_access, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by,
       updated_role = EXCLUDED.updated_role, updated_at = clock_timestamp()
     WHERE core.field_policies.version = $9 - 1
     RETURNING updated_at`,
    [set.tenant, entity, field, after.sensitive, after.redaction, after.reason, after.unmask_roles, JSON.stringify(after.role_access), after.version, p.actor, p.role]);
  if (!rows[0]) throw new AppError(409, 'policy_changed_concurrently', 'The field policy changed while you were editing it; reload and retry');
  after.updated_at = rows[0].updated_at.toISOString();
  const snapshot = (x: FieldPolicy) => ({ sensitive: x.sensitive, redaction: x.redaction, reason: x.reason, unmask_roles: x.unmask_roles, role_access: x.role_access, version: x.version, source: x.source });
  const v = await tx.query(`INSERT INTO core.field_policy_versions (tenant_id, entity, field, version, policy, previous, change_kind, changed_by, changed_role, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [set.tenant, entity, field, after.version, JSON.stringify(snapshot(after)), JSON.stringify(snapshot(before)), change.kind, p.actor, p.role, p.correlationId]);
  await auditTx(tx, { tenantId: set.tenant, actor: p.actor, role: p.role, action: 'policy.field.update', resource: `field:${entity}.${field}`, outcome: 'succeeded',
    details: { version: after.version, policy_epoch: Number(v.rows[0].id), change_kind: change.kind, loosening: change.loosening, tightening: change.tightening, before: snapshot(before), after: snapshot(after) },
    correlationId: p.correlationId });
  return { policy: after, change };
}

/** Contract document filtered for a viewer: hidden fields (and everything that names them) are removed. */
export function contractForViewer(c: Contract, viewer: FieldViewer): Contract {
  const hidden = (en: string, f: string) => viewer.level(en, f) === 'hidden';
  const mentions = (x: unknown, en: string): boolean => {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    if (typeof o.field === 'string' && hidden(en, o.field)) return true;
    if (typeof o.other_field === 'string' && hidden(en, o.other_field)) return true;
    return Object.values(o).some((v) => (Array.isArray(v) ? v.some((i) => mentions(i, en)) : mentions(v, en)));
  };
  const out: Contract = JSON.parse(JSON.stringify(c));
  for (const [en, e] of Object.entries(out.entities)) {
    for (const f of Object.keys(e.fields)) if (hidden(en, f)) delete e.fields[f];
    e.relationships = e.relationships?.filter((r) => !hidden(en, r.field) && !hidden(r.references.entity, r.references.field));
    e.rules = e.rules?.filter((r) => !mentions(r.when, en) && !mentions(r.assert, en));
    if (e.correction.order_by && hidden(en, e.correction.order_by)) delete e.correction.order_by;
  }
  for (const s of Object.values(out.sources)) s.mappings = s.mappings.filter((m) => !hidden(s.entity, m.target));
  out.outputs.metrics = out.outputs.metrics.filter((m) => !(m.field && hidden(m.entity, m.field)) && !mentions(m.filter, m.entity));
  out.outputs.extracts = out.outputs.extracts.map((x) => ({ ...x, fields: x.fields.filter((f) => !hidden(x.entity, f)), filterable: x.filterable?.filter((f) => !hidden(x.entity, f)) }));
  out.dataset_checks = out.dataset_checks?.filter((d) => !mentions(d.left, d.left.entity) && !('entity' in d.right && mentions(d.right, d.right.entity)));
  return out;
}
