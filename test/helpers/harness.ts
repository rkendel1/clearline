// Test harness: fresh database per suite, the real HTTP API in-process
// (fastify.inject), and a real worker. Nothing is mocked.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
export const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'clearline_test';
const host = process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? `${host}/${TEST_DB}`;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.ALLOW_SELF_APPROVAL = 'false';

import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { closePool, getPool } from '../../src/platform/db.js';
import { migrate } from '../../src/platform/migrate.js';
import { seed, DEV_TOKENS } from '../../scripts/seed.js';
import { Worker } from '../../src/ingestion/worker.js';

export { DEV_TOKENS };

export function resetDatabase() {
  execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [TEST_DB], { stdio: 'pipe' });
}

export interface Ctx { app: FastifyInstance; worker: Worker }

export async function setup(opts: { contracts?: boolean } = {}): Promise<Ctx> {
  await closePool();
  resetDatabase();
  await migrate();
  await seed(opts);
  const app = await buildServer();
  return { app, worker: new Worker() };
}

export async function teardown(ctx: Ctx) {
  await ctx.app.close();
  await closePool();
}

export interface Res<T = any> { status: number; body: T; headers: Record<string, string | string[] | undefined>; text: string }

export function client(ctx: Ctx, token: string) {
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const r = await ctx.app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}`, ...headers } });
    let body: unknown = r.body;
    if ((r.headers['content-type'] ?? '').toString().includes('json')) body = JSON.parse(r.body);
    return { status: r.statusCode, body, headers: r.headers as never, text: r.body };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    csv: (tenant: string, source: string, csv: Buffer | string, opts: { reportedAt?: string; control?: unknown } = {}) =>
      call('POST', `/api/v1/tenants/${tenant}/batches/csv?source=${source}${opts.reportedAt ? `&source_reported_at=${encodeURIComponent(opts.reportedAt)}` : ''}`,
        Buffer.isBuffer(csv) ? csv : Buffer.from(csv), { 'content-type': 'text/csv', ...(opts.control ? { 'x-clearline-control': JSON.stringify(opts.control) } : {}) }),
    json: (tenant: string, source: string, records: unknown[], opts: { reportedAt?: string; control?: unknown } = {}) =>
      call('POST', `/api/v1/tenants/${tenant}/batches`, { source, records, source_reported_at: opts.reportedAt, control: opts.control }),
  };
}

export const loadContract = (tenant: string, file: string) => JSON.parse(readFileSync(path.join(ROOT, 'contracts', tenant, file), 'utf8'));

export async function sql<T = any>(text: string, params: unknown[] = [], scope: { tenant?: string } = {}): Promise<T[]> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    if (scope.tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [scope.tenant]);
    else await c.query(`SELECT set_config('app.scope', 'system', true)`);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r.rows as T[];
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { c.release(); }
}

/** Evidence log: every scenario appends what it observed to test-results/evidence.md. */
export function evidence(scenario: string, lines: string[]) {
  mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  appendFileSync(path.join(ROOT, 'test-results/evidence.md'), `\n### ${scenario}\n_${new Date().toISOString()}_\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}
