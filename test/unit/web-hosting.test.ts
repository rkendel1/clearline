// Web interface hosting: only files inside the build directory are served, client routes fall back
// to the shell document, and API paths never do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { isUiPath, registerWeb } from '../../src/api/static.js';

function app() {
  const dir = mkdtempSync(join(tmpdir(), 'clearline-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, '..', 'clearline-secret.txt'), 'secret');
  const a = Fastify();
  a.get('/healthz', async () => ({ status: 'ok' }));
  registerWeb(a, dir);
  return a;
}

test('serves the shell, hashed assets with long caching, and falls back for client routes', async () => {
  const a = app();
  const root = await a.inject('/');
  assert.equal(root.statusCode, 200);
  assert.match(root.headers['content-type'] as string, /text\/html/);
  assert.equal(root.headers['cache-control'], 'no-cache');
  const js = await a.inject('/assets/app-abc.js');
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'] as string, /javascript/);
  assert.match(js.headers['cache-control'] as string, /immutable/);
  assert.equal((await a.inject('/some/client/route')).statusCode, 200);
});

test('never serves the shell for API paths or missing files, and blocks path traversal', async () => {
  const a = app();
  assert.equal((await a.inject('/api/v1/nothing')).statusCode, 404);
  assert.equal((await a.inject('/assets/missing.js')).statusCode, 404);
  for (const p of ['/..%2fclearline-secret.txt', '/%2e%2e/clearline-secret.txt', '/assets/..%2f..%2fclearline-secret.txt']) {
    const r = await a.inject(p);
    assert.notEqual(r.body, 'secret', p);
    assert.equal(r.statusCode === 404 || r.body.includes('shell'), true, p);
  }
  assert.equal((await a.inject({ method: 'POST', url: '/' })).statusCode, 404);
});

test('classifies UI paths', () => {
  assert.equal(isUiPath('/'), true);
  assert.equal(isUiPath('/assets/x.js'), true);
  assert.equal(isUiPath('/api/v1/me'), false);
  assert.equal(isUiPath('/healthz'), false);
});
