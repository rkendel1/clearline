// Scenario F — Interrupted processing, with real OS processes:
//  1. a worker is SIGKILLed mid-transaction (after writing canonical rows), restarted, and recovers;
//  2. a worker receives SIGTERM mid-batch, aborts cleanly, re-queues, and exits 0.
// In both cases incomplete work is never marked successful and nothing is duplicated.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, ROOT, type Ctx } from '../helpers/harness.js';
import { NW_PLANS, nwMembers, nwClaims, toCsv, NW_MEMBER_COLUMNS, NW_CLAIM_COLUMNS } from '../../synthetic/generator.js';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(ctx); });

function startWorker(env: Record<string, string>): { child: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output: string[] } {
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/worker-main.ts')], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', WORKER_POLL_MS: '100', WORKER_LEASE_SECONDS: '2', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => output.push(String(d)));
  child.stderr!.on('data', (d) => output.push(String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return { child, exited, output };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 60_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const batchRow = async (id: string) => (await sql(`SELECT status, attempt_count, trust_status, accepted_count FROM core.batches WHERE id = $1`, [id]))[0];
const attempts = async (id: string) => sql(`SELECT attempt, outcome FROM core.batch_attempts WHERE batch_id = $1 ORDER BY attempt`, [id]);
const canonicalRows = async (id: string) => (await sql(`SELECT count(*)::int AS n FROM t_northwind.claim WHERE "_batch_id" = $1`, [id]))[0].n;

test('Scenario F1: worker killed mid-transaction recovers safely after restart', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const members = nwMembers(300, 601);
  await op.csv('northwind', 'nw_plans_csv', toCsv(NW_PLANS as never));
  await op.csv('northwind', 'nw_eligibility_csv', toCsv(members as never, NW_MEMBER_COLUMNS));
  await ctx.worker.drain();
  const claims = nwClaims(6000, members.map((m) => m.MBR_ID), 602);
  const sub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS), { control: { record_count: 6000 } });
  const id = sub.body.batch_id;

  const crashing = startWorker({ CLEARLINE_FAULT_INJECTION: 'crash_after_rows=1000' });
  const exit = await crashing.exited;
  assert.equal(exit.signal, 'SIGKILL', `worker should die by SIGKILL, got ${JSON.stringify(exit)}\n${crashing.output.join('')}`);
  assert.ok(crashing.output.join('').includes('FAULT INJECTION'), 'crash happened after canonical rows were written inside the transaction');

  const afterCrash = await batchRow(id);
  assert.equal(afterCrash.status, 'processing', 'never marked successful');
  assert.equal(afterCrash.trust_status, 'pending');
  assert.equal(afterCrash.attempt_count, 1);
  assert.equal(await canonicalRows(id), 0, 'uncommitted canonical rows rolled back');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.quality_results WHERE batch_id = $1`, [id]))[0].n, 0);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM core.reconciliation_results WHERE batch_id = $1`, [id]))[0].n, 0);
  const ops = (await op.get('/api/v1/tenants/northwind/reports/operations')).body;
  assert.equal(ops.recent_batches.find((b: { id: string }) => b.id === id).trust_status, 'pending', 'dashboard shows in-flight, not green');

  await new Promise((r) => setTimeout(r, 2500)); // lease expiry
  const healthy = startWorker({});
  await waitFor(async () => (await batchRow(id)).status === 'completed', 60_000, 'recovered batch to complete');
  healthy.child.kill('SIGTERM');
  const healthyExit = await healthy.exited;
  assert.equal(healthyExit.code, 0);
  assert.ok(healthy.output.join('').includes('recovered batch with expired lease'));

  const done = await batchRow(id);
  assert.equal(done.attempt_count, 2);
  assert.equal(done.trust_status, 'trusted');
  assert.equal(done.accepted_count, 6000);
  assert.deepEqual(await attempts(id), [{ attempt: 1, outcome: 'interrupted' }, { attempt: 2, outcome: 'succeeded' }]);
  assert.equal(await canonicalRows(id), 6000);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM (SELECT "_key" FROM t_northwind.claim GROUP BY 1 HAVING count(*) > 1) d`))[0].n, 0);
  const recovery = await sql(`SELECT actor, details FROM core.audit_events WHERE action = 'batch.recover' AND resource = $1`, [`batch:${id}`]);
  assert.equal(recovery.length, 1);

  evidence('Scenario F1 — Crash and restart (SIGKILL)', [
    `Worker process launched with fault injection crash_after_rows=1000 on a 6000-row batch; it wrote canonical rows inside its transaction, then died by ${exit.signal}.`,
    `After the crash: status=processing (not success), trust=pending, canonical rows for the batch=0, quality/reconciliation rows=0.`,
    `A fresh worker process recovered the expired lease (audited batch.recover), re-processed from scratch and committed: attempts=[1 interrupted, 2 succeeded], accepted=6000, duplicate keys=0, trust=trusted.`,
  ]);
});

test('Scenario F2: SIGTERM mid-batch aborts, re-queues and exits cleanly', async () => {
  const op = client(ctx, DEV_TOKENS.northwind.operator);
  const members = (await sql(`SELECT "_key" AS k FROM t_northwind.member`)).map((r) => r.k as string);
  const claims = nwClaims(25000, members, 603, 100_000);
  const sub = await op.csv('northwind', 'nw_medical_claims_csv', toCsv(claims as never, NW_CLAIM_COLUMNS));
  const id = sub.body.batch_id;

  const w = startWorker({ SHUTDOWN_GRACE_MS: '0' });
  await waitFor(async () => (await batchRow(id)).status === 'processing', 30_000, 'processing to start');
  w.child.kill('SIGTERM');
  const exit = await w.exited;
  assert.equal(exit.code, 0, w.output.join(''));
  const after = await batchRow(id);
  assert.equal(after.status, 'queued', 'interrupted work re-queued immediately, not marked complete or failed');
  assert.equal(await canonicalRows(id), 0);
  assert.deepEqual(await attempts(id), [{ attempt: 1, outcome: 'interrupted' }]);
  assert.ok(w.output.join('').includes('batch interrupted; re-queued'));

  await ctx.worker.drain();
  const done = await batchRow(id);
  assert.deepEqual([done.status, done.attempt_count, done.accepted_count], ['completed', 2, 25000]);
  evidence('Scenario F2 — Graceful shutdown (SIGTERM)', [
    `SIGTERM delivered while a 25,000-row batch was processing (grace 0 ms): worker aborted the transaction, re-queued the batch and exited with code ${exit.code}.`,
    `State after shutdown: status=queued, canonical rows=0, attempts=[1 interrupted]. Next worker completed it: attempt 2, 25000 accepted.`,
  ]);
});
