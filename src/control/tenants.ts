// Tenant lifecycle and token issuance. Creating a tenant provisions its schema
// and a NOLOGIN reporting role that BI users can be granted; no code changes.

import { withSystem, withTenant } from '../platform/db.js';
import { AppError, conflict, badRequest } from '../platform/errors.js';
import { audit, auditTx } from './audit.js';
import { hashToken, newToken, type Principal, type Role } from './auth.js';
import { reportingRole, tenantBootstrapDDL } from '../contracts/compile.js';

export interface RetentionPolicy {
  raw_payload_days: number;        // raw source payloads (provenance) are nulled after this many days
  quarantine_days: number;         // quarantined record details
  superseded_version_days: number | null; // non-current canonical versions (null = keep forever)
  audit_days: number;              // audit events; always >= the longest data retention
}

export const DEFAULT_RETENTION: RetentionPolicy = { raw_payload_days: 90, quarantine_days: 180, superseded_version_days: null, audit_days: 2555 };

export function validateRetention(r: Partial<RetentionPolicy>): RetentionPolicy {
  const out = { ...DEFAULT_RETENTION, ...r };
  for (const [k, v] of Object.entries(out)) {
    if (v !== null && (!Number.isInteger(v) || (v as number) < 1)) throw badRequest('invalid_retention', `${k} must be a positive integer number of days`);
  }
  const longest = Math.max(out.raw_payload_days, out.quarantine_days, out.superseded_version_days ?? 0);
  if (out.audit_days < longest) throw badRequest('invalid_retention', 'audit_days must be at least as long as every data retention period');
  return out;
}

export async function createTenant(p: Principal, input: { id: string; name: string; retention?: Partial<RetentionPolicy> }) {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(input.id ?? '')) throw badRequest('invalid_tenant_id', 'tenant id must match ^[a-z][a-z0-9_]{1,30}$');
  if (!input.name) throw badRequest('invalid_tenant', 'name is required');
  const retention = validateRetention(input.retention ?? {});
  return withSystem(async (tx) => {
    const exists = await tx.query(`SELECT 1 FROM core.tenants WHERE id = $1`, [input.id]);
    if (exists.rows.length) throw conflict('tenant_exists', `Tenant ${input.id} already exists`);
    await tx.query(`INSERT INTO core.tenants (id, name, retention, reporting_role, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [input.id, input.name, JSON.stringify(retention), reportingRole(input.id), p.actor]);
    for (const sql of tenantBootstrapDDL(input.id)) await tx.query(sql);
    await tx.query(`INSERT INTO core.reporting_roles (role_name, tenant_id) VALUES ($1,$2)`, [reportingRole(input.id), input.id]);
    await auditTx(tx, { tenantId: input.id, actor: p.actor, role: p.role, action: 'tenant.create', resource: `tenant:${input.id}`, outcome: 'succeeded', details: { retention }, correlationId: p.correlationId });
    return { id: input.id, name: input.name, retention, reporting_role: reportingRole(input.id) };
  });
}

export async function issueToken(p: Principal, tenantId: string, name: string, role: Role, explicitToken?: string) {
  try { return await issueTokenInner(p, tenantId, name, role, explicitToken); }
  catch (err) {
    // Denials are audited in their own transaction (the issuing transaction rolled back).
    if (err instanceof AppError && err.status === 403) await audit({ tenantId, actor: p.actor, role: p.role, action: 'token.issue', resource: `token:${name}`, outcome: 'denied', details: { reason: err.code, requested_role: role }, correlationId: p.correlationId });
    throw err;
  }
}

async function issueTokenInner(p: Principal, tenantId: string, name: string, role: Role, explicitToken?: string) {
  if (!['admin', 'approver', 'operator', 'reporter'].includes(role)) throw badRequest('invalid_role', 'role must be admin, approver, operator or reporter');
  if (role === 'platform_admin') throw badRequest('invalid_role', 'platform_admin tokens cannot be issued through the API');
  if (p.role === 'admin' && p.tenantId !== tenantId) throw badRequest('invalid_tenant', 'admins can only issue tokens for their own tenant');
  if (!/^[a-z0-9][a-z0-9._-]{2,60}$/.test(name)) throw badRequest('invalid_name', 'token name must be 3-61 chars of [a-z0-9._-]');
  const token = explicitToken ?? newToken();
  await withSystem(async (tx) => {
    const t = await tx.query(`SELECT 1 FROM core.tenants WHERE id = $1`, [tenantId]);
    if (!t.rows.length) throw badRequest('unknown_tenant', `Tenant ${tenantId} does not exist`);
    const dup = await tx.query(`SELECT 1 FROM core.api_tokens WHERE name = $1 AND revoked_at IS NULL`, [name]);
    if (dup.rows.length) throw conflict('token_name_exists', `An active token named ${name} exists`);
    if (p.role === 'platform_admin') {
      // Platform administrators bootstrap a tenant: they may issue only its FIRST admin token.
      // After that, tenant admins manage their own tokens, so a platform admin cannot mint
      // itself access to tenant data.
      // They may also issue approver tokens, which carry no data access.
      if (role !== 'admin' && role !== 'approver') throw new AppError(403, 'bootstrap_only', 'Platform administrators can issue only a tenant\'s first admin token and approver tokens');
      if (role === 'admin') {
        const admins = await tx.query(`SELECT 1 FROM core.api_tokens WHERE tenant_id = $1 AND role = 'admin' AND revoked_at IS NULL`, [tenantId]);
        if (admins.rows.length) throw new AppError(403, 'bootstrap_only', 'This tenant already has an active admin token; platform administrators cannot issue further admin tokens');
      }
    } else if (role === 'approver') {
      throw new AppError(403, 'approver_issued_by_platform_only', 'Approver tokens are issued by the platform administrator, so no tenant admin can approve their own changes');
    }
    await tx.query(`INSERT INTO core.api_tokens (token_hash, name, tenant_id, role, issued_by, issued_by_token_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [hashToken(token), name, tenantId, role, p.actor, p.tokenId > 0 ? p.tokenId : null]);
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'token.issue', resource: `token:${name}`, outcome: 'succeeded', details: { role }, correlationId: p.correlationId });
  });
  return { name, role, tenant_id: tenantId, token };
}

export async function getTenant(tenantId: string) {
  return withTenant(tenantId, async (tx) => (await tx.query(`SELECT id, name, status, retention, reporting_role, created_at FROM core.tenants WHERE id = $1`, [tenantId])).rows[0]);
}

export async function listTokens(tenantId: string) {
  return withSystem(async (tx) => (await tx.query(`SELECT name, role, issued_by, created_at, revoked_at FROM core.api_tokens WHERE tenant_id = $1 ORDER BY created_at, name`, [tenantId])).rows);
}

/** Revocation takes effect on the next request: authentication rejects revoked tokens. */
export async function revokeToken(p: Principal, tenantId: string, name: string) {
  return revokeTokenInner(p, tenantId, name).catch(async (err) => {
    if (err instanceof AppError && err.status === 403) await audit({ tenantId, actor: p.actor, role: p.role, action: 'token.revoke', resource: `token:${name}`, outcome: 'denied', details: { reason: err.code }, correlationId: p.correlationId });
    throw err;
  });
}

async function revokeTokenInner(p: Principal, tenantId: string, name: string) {
  return withSystem(async (tx) => {
    if (p.role === 'platform_admin') {
      // Otherwise a platform admin could revoke a tenant's admins and then "bootstrap" a new one for itself.
      const t = (await tx.query(`SELECT role FROM core.api_tokens WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL`, [tenantId, name])).rows[0];
      if (t && t.role !== 'approver') throw new AppError(403, 'bootstrap_only', 'Platform administrators can revoke only approver tokens; tenant admins manage their own tokens');
    }
    const { rows } = await tx.query(`UPDATE core.api_tokens SET revoked_at = now() WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL RETURNING name, role, revoked_at`, [tenantId, name]);
    if (!rows[0]) throw badRequest('unknown_token', `No active token named ${name} in tenant ${tenantId}`);
    await auditTx(tx, { tenantId, actor: p.actor, role: p.role, action: 'token.revoke', resource: `token:${name}`, outcome: 'succeeded', details: { role: rows[0].role }, correlationId: p.correlationId });
    return rows[0];
  });
}
