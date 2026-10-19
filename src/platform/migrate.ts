// Versioned platform migrations. Files in db/migrations are applied in order,
// each in its own transaction, and recorded with a checksum so an edited,
// already-applied migration is detected instead of silently diverging.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './db.js';
import { log } from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../db/migrations').replace(`${path.sep}dist${path.sep}db`, `${path.sep}db`);

async function findDir(): Promise<string> {
  for (const candidate of [MIGRATIONS_DIR, path.resolve(here, '../../../db/migrations'), path.resolve(process.cwd(), 'db/migrations')]) {
    try { await readdir(candidate); return candidate; } catch { /* try next */ }
  }
  throw new Error('db/migrations directory not found');
}

export async function listMigrations(): Promise<{ name: string; sql: string; checksum: string }[]> {
  const dir = await findDir();
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(files.map(async (name) => {
    const sql = await readFile(path.join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrate(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(727274)`); // serialize concurrent migrators
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const m of await listMigrations()) {
      const prior = done.get(m.name);
      if (prior) {
        if (prior !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO public.schema_migrations(name, checksum) VALUES ($1,$2)', [m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.name);
        log.info('migration applied', { migration: m.name });
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727274)`).catch(() => {});
    client.release();
  }
  return applied;
}

export async function pendingMigrations(): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT name FROM public.schema_migrations`).catch(() => ({ rows: [] as { name: string }[] }));
  const done = new Set(rows.map((r) => r.name));
  return (await listMigrations()).map((m) => m.name).filter((n) => !done.has(n));
}
