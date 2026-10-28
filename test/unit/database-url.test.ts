// DATABASE_URL handling in production: tolerate common paste damage, and never put the value in an error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resetConfigForTests } from '../../src/platform/config.js';

function load(url: string | undefined): { host?: string; db?: string; error?: string } {
  const saved = { ...process.env };
  process.env.NODE_ENV = 'production'; process.env.QUERY_DB_PASSWORD = 'x';
  if (url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url;
  resetConfigForTests();
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as never;
  try { const c = loadConfig(); const u = new URL(c.databaseUrl); return { host: u.hostname, db: u.pathname }; }
  catch (e) { return { error: (e as Error).message }; }
  finally { process.stderr.write = stderr as never; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); resetConfigForTests(); }
}

test('a plain URL, and the usual paste damage around it, yields the same connection', () => {
  for (const v of ['postgres://u:p@db.internal:5432/app', ' "postgres://u:p@db.internal:5432/app" ', 'postgres://u:p@db.internal:5432/app\n', '<postgres://u:p@db.internal:5432/app>',
    'DATABASE_URL=postgres://u:p@db.internal:5432/app', 'export DATABASE_URL="postgres://u:p@db.internal:5432/app"', 'u:p@db.internal:5432/app'])
    assert.deepEqual(load(v), { host: 'db.internal', db: '/app' }, JSON.stringify(v));
});

test('unusable values are rejected with a description that never contains the value', () => {
  assert.match(load(undefined).error!, /DATABASE_URL is required in production/);
  for (const v of ['garbage-secret-value', 'mysql://u:SECRETPW@h/db', 'postgres://u:SECRETPW@h:5432', 'postgres://u:SECRETPW@/db']) {
    const e = load(v).error!;
    assert.ok(e, v); assert.ok(!e.includes('SECRETPW') && !e.includes('garbage-secret-value'), `error leaked the value: ${e}`);
  }
});

test('TRUST_PROXY accepts true, a hop count or nothing', () => {
  const read = (v: string | undefined) => {
    const saved = process.env.TRUST_PROXY;
    if (v === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = v;
    resetConfigForTests();
    try { return loadConfig().trustProxy; } finally { if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved; resetConfigForTests(); }
  };
  assert.equal(read(undefined), false); assert.equal(read('false'), false); assert.equal(read('true'), true); assert.equal(read('1'), 1); assert.equal(read('2'), 2); assert.equal(read('garbage'), false);
});
