// Authentication (bearer API tokens, stored hashed) and role-based authorization.
// Tenant scoping is enforced here, before any data access, and again by RLS.

import { createHash, randomBytes } from 'node:crypto';
import { withSystem } from '../platform/db.js';
import { AppError, unauthorized } from '../platform/errors.js';
import { metrics } from '../platform/metrics.js';
import { audit } from './audit.js';

export type Role = 'platform_admin' | 'admin' | 'approver' | 'steward' | 'operator' | 'reporter';
export const DATA_ROLES = ['admin', 'steward', 'operator', 'reporter'] as const satisfies readonly Role[];

export type Permission =
  | 'tenant:create' | 'token:issue'
  | 'contract:read' | 'contract:publish' | 'contract:approve'
  | 'batch:submit' | 'batch:read' | 'batch:replay'
  | 'quarantine:read' | 'quarantine:resolve'
  | 'record:read' | 'record:read_sensitive' | 'lineage:read'
  | 'report:read' | 'extract:run' | 'extract:sensitive'
  | 'audit:read' | 'retention:run' | 'subject:erase'
  // Analytical query workspace and field-level policy (docs/query-workspace.md).
  | 'query:discover' | 'query:propose' | 'query:run' | 'query:export' | 'query:history' | 'query:history_all'
  | 'policy:read' | 'policy:manage' | 'policy:grant'
  // Saved analytics (docs/saved-analytics.md). saved_query:admin manages other users' queries and schedules.
  | 'saved_query:read' | 'saved_query:write' | 'saved_query:share' | 'saved_query:admin'
  | 'schedule:manage' | 'delivery:manage' | 'analysis:run' | 'analysis:read' | 'notification:read';

const ANALYTICS_USER: Permission[] = ['saved_query:read', 'saved_query:write', 'schedule:manage', 'analysis:run', 'analysis:read', 'notification:read'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  platform_admin: new Set(['tenant:create', 'token:issue']),
  admin: new Set(['token:issue', 'contract:read', 'contract:publish', 'batch:submit', 'batch:read', 'batch:replay',
    'quarantine:read', 'quarantine:resolve', 'record:read', 'record:read_sensitive', 'lineage:read', 'report:read', 'extract:run',
    'extract:sensitive', 'audit:read', 'retention:run', 'subject:erase',
    'query:discover', 'query:propose', 'query:run', 'query:export', 'query:history', 'query:history_all', 'policy:read', 'policy:manage', 'policy:grant',
    ...ANALYTICS_USER, 'saved_query:share', 'saved_query:admin', 'delivery:manage']),
  // Separation of duties: approvers only decide on contract migrations and see no tenant data.
  // Their tokens are issued by the platform administrator, never by tenant admins.
  approver: new Set(['contract:read', 'contract:approve']),
  // Data stewards classify fields and can only make policies stricter (policy:grant loosens; admins only).
  // They see original sensitive values only where a field policy lists them in unmask_roles.
  steward: new Set(['contract:read', 'report:read', 'audit:read', 'query:discover', 'query:propose', 'query:run', 'query:export', 'query:history', 'query:history_all',
    'policy:read', 'policy:manage', ...ANALYTICS_USER, 'saved_query:share', 'delivery:manage']),
  operator: new Set(['contract:read', 'batch:submit', 'batch:read', 'batch:replay', 'quarantine:read', 'quarantine:resolve',
    'record:read', 'lineage:read', 'report:read', 'extract:run', 'query:discover', 'query:propose', 'query:run', 'query:export', 'query:history', 'policy:read',
    ...ANALYTICS_USER, 'saved_query:share']),
  reporter: new Set(['contract:read', 'batch:read', 'report:read', 'extract:run', 'query:discover', 'query:propose', 'query:run', 'query:export', 'query:history',
    ...ANALYTICS_USER]),
};

/**
 * Execution identities for schedules: a token holding `role` may let its schedules run as one of
 * these roles. A schedule never runs with more than the role it names, and that role is re-checked
 * against the token's CURRENT role on every run (an admin can choose to run a schedule as a reporter).
 */
export const DELEGABLE_ROLES: Record<Role, readonly Role[]> = {
  platform_admin: [], approver: [],
  admin: ['admin', 'steward', 'operator', 'reporter'],
  steward: ['steward', 'reporter'],
  operator: ['operator', 'reporter'],
  reporter: ['reporter'],
};

export interface Principal {
  actor: string;          // token name, e.g. "acme-operator-1"
  tokenId: number;
  tenantId: string | null;
  role: Role;
  correlationId: string;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const newToken = () => `cl_${randomBytes(24).toString('base64url')}`;

export async function authenticate(header: string | undefined, correlationId: string): Promise<Principal> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) throw unauthorized();
  const row = await withSystem(async (c) => (await c.query(
    `SELECT id, name, tenant_id, role FROM core.api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(m[1])])).rows[0]);
  if (!row) {
    metrics.authDenials.inc({ reason: 'invalid_token' });
    throw unauthorized('Invalid or revoked token');
  }
  return { actor: row.name, tokenId: Number(row.id), tenantId: row.tenant_id, role: row.role, correlationId };
}

/** Throws 403 and records an audit event when the principal lacks the permission or targets another tenant. */
export async function authorize(p: Principal, perm: Permission, tenantId: string | null, resource?: string): Promise<void> {
  let reason: string | null = null;
  if (!ROLE_PERMISSIONS[p.role].has(perm)) reason = 'missing_permission';
  else if (tenantId !== null && p.tenantId !== tenantId) reason = 'cross_tenant';
  if (!reason) return;
  metrics.authDenials.inc({ reason });
  await audit({
    tenantId: tenantId ?? p.tenantId, actor: p.actor, role: p.role, action: `authz.${perm}`, resource: resource ?? null,
    outcome: 'denied', details: { reason, principal_tenant: p.tenantId, target_tenant: tenantId }, correlationId: p.correlationId,
  });
  // Also record the attempt against the caller's own tenant so its admins see it.
  if (reason === 'cross_tenant' && p.tenantId && p.tenantId !== tenantId) {
    await audit({ tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'authz.cross_tenant_attempt', resource: resource ?? null,
      outcome: 'denied', details: { target_tenant: tenantId, permission: perm }, correlationId: p.correlationId });
  }
  throw new AppError(403, reason === 'cross_tenant' ? 'cross_tenant_denied' : 'forbidden',
    reason === 'cross_tenant' ? 'Access to another tenant is not permitted' : `Role ${p.role} lacks permission ${perm}`);
}

export const can = (p: Principal, perm: Permission) => ROLE_PERMISSIONS[p.role].has(perm);
