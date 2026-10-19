// The database side of the analytical query boundary.
//
// For each tenant:
//   schema q_<tenant>               one view per contract entity (current versions) and per
//                                   platform table, each pinned to the tenant
//   role clearline_q_<tenant>_<r>   NOLOGIN, one per data role (admin, steward, operator, reporter),
//                                   mapped to the tenant in core.reporting_roles, so row-level
//                                   security on core.* resolves it to that tenant and nothing else
//   column grants                   SELECT only on columns the role may at least filter by;
//                                   hidden and discover-only columns are not granted at all
// Queries run under SET LOCAL ROLE to that role inside a READ ONLY transaction
// (src/query/execute.ts). The role has no privileges on core tables, t_<tenant>
// schemas, other tenants' q_ schemas or the reporting views.
//
// The surface is regenerated whenever the active contract or any field policy changes.

import { ident, type Tx } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { DATA_ROLES, type Role } from '../control/auth.js';
import { getActiveContract } from '../contracts/registry.js';
import { table } from '../contracts/compile.js';
import type { Contract } from '../contracts/types.js';
import { loadPolicies, type PolicySet } from '../policy/fields.js';
import { ENTITY_SYSTEM_COLUMNS, entityColumnLevels, platformTablesFor, querySchemaName } from './catalog.js';

export const queryRole = (tenant: string, role: Role) => `clearline_q_${tenant}_${role}`;

/** Drop the query views (they depend on tenant table columns, so contract DDL must run without them). */
export async function dropQueryViews(tx: Tx, tenant: string) {
  await tx.query(`DROP SCHEMA IF EXISTS ${ident(querySchemaName(tenant))} CASCADE`);
}

function viewDDL(tenant: string, c: Contract): string[] {
  const q = ident(querySchemaName(tenant));
  const lit = `'${tenant.replace(/'/g, "''")}'`;
  const out: string[] = [];
  for (const [en, e] of Object.entries(c.entities)) {
    const cols = [...Object.keys(e.fields).map((f) => `r.${ident(f)}`), ...ENTITY_SYSTEM_COLUMNS.map((s) => `${s.sql} AS ${ident(s.name)}`)];
    out.push(`CREATE VIEW ${q}.${ident(en)} AS SELECT ${cols.join(', ')} FROM ${table(tenant, en)} r JOIN core.batches b ON b.id = r."_batch_id"
      WHERE r."_is_current" AND b.tenant_id = ${lit}`);
  }
  for (const t of platformTablesFor(c)) {
    out.push(`CREATE VIEW ${q}.${ident(t.name)} AS SELECT ${t.columns.map((col) => `${col.sql} AS ${ident(col.name)}`).join(', ')} FROM ${t.from} WHERE ${t.tenantSql} = ${lit}`);
  }
  return out;
}

/** The query login: owns nothing, may only SET ROLE to query roles. Provisioned here unless configured externally. */
async function ensureQueryLogin(tx: Tx): Promise<string> {
  const cfg = loadConfig();
  const login = cfg.queryLoginRole;
  if (!process.env.QUERY_DATABASE_URL) {
    const password = decodeURIComponent(new URL(cfg.queryDatabaseUrl).password);
    const lit = `'${password.replace(/'/g, "''")}'`;
    const exists = (await tx.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [login])).rows.length > 0;
    // CREATE ROLE grants nothing beyond LOGIN by default; on ALTER only the password is set (PostgreSQL 16 refuses
    // attribute changes such as NOCREATEDB from a role that lacks the attribute itself).
    await tx.query(exists ? `ALTER ROLE ${ident(login)} PASSWORD ${lit}` : `CREATE ROLE ${ident(login)} LOGIN NOINHERIT PASSWORD ${lit}`);
  }
  return login;
}

async function ensureRoles(tx: Tx, tenant: string) {
  const login = await ensureQueryLogin(tx);
  for (const r of DATA_ROLES) {
    const name = queryRole(tenant, r);
    const exists = (await tx.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name])).rows.length > 0;
    if (!exists) await tx.query(`CREATE ROLE ${ident(name)} NOLOGIN NOINHERIT`);
    // Only the query login may SET ROLE to it, and inherits nothing from it.
    const member = (await tx.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE r.rolname = $1 AND u.rolname = $2 AND m.set_option`, [name, login])).rows.length > 0;
    if (!member) await tx.query(`GRANT ${ident(name)} TO ${ident(login)} WITH INHERIT FALSE, SET TRUE`);
    await tx.query(`INSERT INTO core.reporting_roles (role_name, tenant_id) VALUES ($1, $2) ON CONFLICT (role_name) DO NOTHING`, [name, tenant]);
    const mapped = (await tx.query(`SELECT tenant_id FROM core.reporting_roles WHERE role_name = $1`, [name])).rows[0];
    if (mapped?.tenant_id !== tenant) throw new Error(`query role ${name} is mapped to another tenant`);
    await tx.query(`GRANT USAGE ON SCHEMA core TO ${ident(name)}`);
    await tx.query(`GRANT EXECUTE ON FUNCTION core.can_see_tenant(text), core.reporting_tenant(name), core.mask_value(text, text) TO ${ident(name)}`);
  }
}

async function grantColumns(tx: Tx, tenant: string, set: PolicySet) {
  const q = ident(querySchemaName(tenant));
  for (const r of DATA_ROLES) {
    const role = ident(queryRole(tenant, r));
    await tx.query(`GRANT USAGE ON SCHEMA ${q} TO ${role}`);
    for (const en of Object.keys(set.contract.entities)) {
      const cols = entityColumnLevels(set, r, en).filter((c) => c.level !== 'hidden' && c.level !== 'discover').map((c) => ident(c.name));
      await tx.query(`REVOKE ALL ON ${q}.${ident(en)} FROM ${role}`);
      if (cols.length) await tx.query(`GRANT SELECT (${cols.join(', ')}) ON ${q}.${ident(en)} TO ${role}`);
    }
    for (const t of platformTablesFor(set.contract)) await tx.query(`GRANT SELECT ON ${q}.${ident(t.name)} TO ${role}`);
  }
}

/**
 * (Re)generate the tenant's query schema, roles and grants for the active contract and current
 * policies. Serialised per tenant; runs in the caller's transaction so it commits atomically with
 * the contract or policy change that required it.
 */
export async function syncQuerySurface(tx: Tx, tenant: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('clearline.query_surface.' || $1))`, [tenant]);
  const active = await getActiveContract(tx, tenant);
  if (!active) return;
  const set = await loadPolicies(tx, tenant, active.document);
  await ensureRoles(tx, tenant);
  await dropQueryViews(tx, tenant);
  await tx.query(`CREATE SCHEMA ${ident(querySchemaName(tenant))}`);
  for (const sql of viewDDL(tenant, active.document)) await tx.query(sql);
  await grantColumns(tx, tenant, set);
  await tx.query(`INSERT INTO core.query_surfaces (tenant_id, contract_version_id, policy_epoch) VALUES ($1,$2,$3)
    ON CONFLICT (tenant_id) DO UPDATE SET contract_version_id = EXCLUDED.contract_version_id, policy_epoch = EXCLUDED.policy_epoch, generated_at = clock_timestamp()`,
    [tenant, active.id, set.epoch]);
}

/** True when the surface matches the active contract and policy epoch (cheap check on every query). */
export async function querySurfaceCurrent(tx: Tx, tenant: string, contractVersionId: number, epoch: number): Promise<boolean> {
  const r = (await tx.query(`SELECT contract_version_id, policy_epoch FROM core.query_surfaces WHERE tenant_id = $1`, [tenant])).rows[0];
  return !!r && Number(r.contract_version_id) === contractVersionId && Number(r.policy_epoch) === epoch;
}
