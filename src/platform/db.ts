// Database access. All application queries run inside one of two helpers:
//  - withTenant(tenantId, fn): transaction whose row-level security scope is a single tenant
//  - withSystem(fn): transaction in platform scope (worker claiming, auth lookup, migrations)
// A query issued outside these helpers sees no tenant rows (RLS fails closed).

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadConfig } from './config.js';
import { AppError } from './errors.js';

/**
 * The tenant an authenticated HTTP request is allowed to touch, bound by the
 * API layer for the lifetime of the request. withTenant() refuses any other
 * tenant, so a missing or wrong authorization check in a route cannot open a
 * transaction (and therefore an RLS scope) for another tenant. Outside a
 * request (worker, CLI, tests) no binding exists and the check does not apply.
 */
export const requestTenant = new AsyncLocalStorage<{ tenantId: string | null; actor: string }>();
export class TenantScopeViolation extends AppError {
  constructor(requested: string, bound: string | null) {
    super(403, 'cross_tenant_denied', 'Access to another tenant is not permitted', { requested_tenant: requested, principal_tenant: bound });
  }
}

// Return NUMERIC as string (exact decimals), BIGINT as string, DATE as 'YYYY-MM-DD'.
pg.types.setTypeParser(1082, (v) => v);

export type Tx = pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = loadConfig();
    pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.dbPoolSize,
      statement_timeout: cfg.statementTimeoutMs,
      application_name: 'clearline',
    });
    pool.on('error', () => { /* idle client errors are surfaced on next use */ });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { const p = pool; pool = undefined; await p.end(); }
}

async function inTx<T>(setup: (c: Tx) => Promise<void>, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export function withTenant<T>(tenantId: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  const bound = requestTenant.getStore();
  if (bound && bound.tenantId !== tenantId) return Promise.reject(new TenantScopeViolation(tenantId, bound.tenantId));
  return inTx(async (c) => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)`, [tenantId]);
  }, fn);
}

export function withSystem<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query(`SELECT set_config('app.scope', 'system', true), set_config('app.tenant_id', '', true)`);
  }, fn);
}

/** Quote a SQL identifier. Identifiers reaching here are already validated by the contract validator. */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

export function tenantSchema(tenantId: string): string {
  return ident(`t_${tenantId}`);
}
