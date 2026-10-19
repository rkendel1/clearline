// Queue worker over core.batches (PostgreSQL as a durable queue).
// Delivery is at-least-once: a batch whose worker dies is re-queued after its
// lease expires and processed again from scratch. Effects are idempotent
// because a processing attempt either commits completely or not at all.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSystem, withTenant } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';
import { metrics } from '../platform/metrics.js';
import { audit } from '../control/audit.js';
import { processBatch, InterruptedError, LostLeaseError } from './processor.js';
import { runDatasetChecks } from '../reconciliation/dataset.js';

export interface Claimed { id: string; tenant_id: string; attempt_count: number; correlation_id: string }

export async function claimNext(workerId: string): Promise<Claimed | null> {
  const cfg = loadConfig();
  return withSystem(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE core.batches SET status = 'processing', attempt_count = attempt_count + 1, lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $2), started_at = coalesce(started_at, now())
        WHERE id = (SELECT id FROM core.batches WHERE status = 'queued' ORDER BY arrival_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, tenant_id, attempt_count, correlation_id`, [workerId, cfg.leaseSeconds]);
    if (!rows[0]) return null;
    await tx.query(`INSERT INTO core.batch_attempts (tenant_id, batch_id, attempt, worker_id) VALUES ($1,$2,$3,$4)`, [rows[0].tenant_id, rows[0].id, rows[0].attempt_count, workerId]);
    return rows[0] as Claimed;
  });
}

/**
 * Re-queue batches whose worker vanished. A live worker holds a row lock on its
 * batch for the whole processing transaction, so SKIP LOCKED guarantees we only
 * touch batches whose processing transaction no longer exists.
 */
export async function recoverExpiredLeases(): Promise<{ id: string; status: string }[]> {
  return withSystem(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE core.batches b SET
          status = CASE WHEN b.attempt_count >= b.max_attempts THEN 'failed' ELSE 'queued' END,
          failed_at = CASE WHEN b.attempt_count >= b.max_attempts THEN now() END,
          failure = CASE WHEN b.attempt_count >= b.max_attempts
                    THEN jsonb_build_object('reason','max_attempts_exceeded','message','processing was interrupted on every attempt','attempts', b.attempt_count)
                    ELSE b.failure END,
          lease_owner = NULL, lease_expires_at = NULL
        WHERE b.id IN (SELECT id FROM core.batches WHERE status = 'processing' AND lease_expires_at < now() FOR UPDATE SKIP LOCKED)
        RETURNING b.id, b.status, b.tenant_id, b.attempt_count`);
    for (const r of rows) {
      await tx.query(`UPDATE core.batch_attempts SET outcome = 'interrupted', ended_at = now(),
          error = jsonb_build_object('reason','lease_expired','message','worker stopped before committing; no partial results were persisted')
        WHERE batch_id = $1 AND attempt = $2 AND outcome = 'running'`, [r.id, r.attempt_count]);
      await tx.query(`INSERT INTO core.audit_events (tenant_id, actor, role, action, resource, outcome, details) VALUES ($1,'system:lease-recovery','system','batch.recover',$2,'succeeded',$3)`,
        [r.tenant_id, `batch:${r.id}`, JSON.stringify({ attempt: r.attempt_count, new_status: r.status })]);
    }
    return rows.map((r) => ({ id: r.id, status: r.status }));
  });
}

async function recordFailure(c: Claimed, workerId: string, err: Error, requeue: boolean) {
  await withSystem(async (tx) => {
    const failure = { reason: err.name, message: err.message.slice(0, 2000), attempt: c.attempt_count, worker: workerId };
    // An interruption re-queues the batch unless it has used up its attempts (repeated shutdowns must not loop forever).
    const { rows } = await tx.query(`UPDATE core.batches SET
        status = CASE WHEN $2 AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
        failure = $3, failed_at = CASE WHEN $2 AND attempt_count < max_attempts THEN NULL ELSE now() END,
        lease_owner = NULL, lease_expires_at = NULL,
        trust_status = CASE WHEN $2 AND attempt_count < max_attempts THEN trust_status ELSE 'untrusted' END,
        trust_reasons = CASE WHEN $2 AND attempt_count < max_attempts THEN trust_reasons ELSE '["processing failed; no results were published"]'::jsonb END
      WHERE id = $1 AND status = 'processing' AND lease_owner = $4 RETURNING status`, [c.id, requeue, JSON.stringify(failure), workerId]);
    requeue = rows[0]?.status === 'queued';
    await tx.query(`UPDATE core.batch_attempts SET outcome = $3, ended_at = now(), error = $4 WHERE batch_id = $1 AND attempt = $2`,
      [c.id, c.attempt_count, requeue ? 'interrupted' : 'failed', JSON.stringify(failure)]);
  });
  await audit({ tenantId: c.tenant_id, actor: `worker:${workerId}`, role: 'system', action: 'batch.process', resource: `batch:${c.id}`, outcome: 'failed', details: { attempt: c.attempt_count, error: err.message.slice(0, 500), requeued: requeue }, correlationId: c.correlation_id });
}

export class Worker {
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private stopping = false;
  private abort = new AbortController();
  private current: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;
  private log = createLogger({ service: 'clearline-worker' }).child({ worker_id: this.id });
  private lastRecovery = 0;

  start() {
    this.loopPromise = this.loop();
    return this;
  }

  private async heartbeat(state: string, batch: string | null) {
    await withSystem((tx) => tx.query(`INSERT INTO core.worker_heartbeats (worker_id, hostname, started_at, last_seen, current_batch, state)
      VALUES ($1,$2,now(),now(),$3,$4) ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), current_batch = $3, state = $4`, [this.id, hostname(), batch, state])).catch(() => {});
  }

  /** Process queued work until none remains (used by tests and the demo). */
  async drain(): Promise<number> {
    let n = 0;
    await recoverExpiredLeases();
    for (;;) {
      const c = await claimNext(this.id);
      if (!c) return n;
      await this.run(c);
      n++;
    }
  }

  private async loop() {
    const cfg = loadConfig();
    this.log.info('worker started', { lease_seconds: cfg.leaseSeconds, batch_timeout_ms: cfg.batchTimeoutMs });
    while (!this.stopping) {
      try {
        if (Date.now() - this.lastRecovery > 5000) {
          this.lastRecovery = Date.now();
          const rec = await recoverExpiredLeases();
          for (const r of rec) this.log.warn('recovered batch with expired lease', { batch_id: r.id, new_status: r.status });
        }
        const c = await claimNext(this.id);
        if (!c) { await this.heartbeat('idle', null); await sleep(cfg.workerPollMs); continue; }
        this.current = this.run(c);
        await this.current;
        this.current = null;
      } catch (err) {
        this.log.error('worker loop error', { error: err as Error });
        await sleep(cfg.workerPollMs * 4);
      }
    }
    await withSystem((tx) => tx.query(`UPDATE core.worker_heartbeats SET state = 'stopped', last_seen = now(), current_batch = NULL WHERE worker_id = $1`, [this.id])).catch(() => {});
    this.log.info('worker stopped');
  }

  private async run(c: Claimed) {
    const log = this.log.child({ batch_id: c.id, tenant: c.tenant_id, attempt: c.attempt_count, correlation_id: c.correlation_id });
    await this.heartbeat('processing', c.id);
    try {
      const out = await processBatch(c.id, c.tenant_id, this.id, this.abort.signal, log);
      metrics.batchesProcessed.inc({ tenant: c.tenant_id, status: out.status, trust: out.trust_status });
      try { await runDatasetChecks(c.tenant_id, `after:${c.id}`); } catch (err) { log.error('dataset checks failed', { error: err as Error }); }
    } catch (err) {
      const e = err as Error;
      if (e instanceof LostLeaseError) { log.warn('lost lease; another worker owns this batch', { error: e }); return; }
      const interrupted = e instanceof InterruptedError;
      log.error(interrupted ? 'batch interrupted; re-queued' : 'batch failed', { error: e });
      metrics.batchesProcessed.inc({ tenant: c.tenant_id, status: interrupted ? 'interrupted' : 'failed', trust: 'untrusted' });
      await recordFailure(c, this.id, e, interrupted);
    }
  }

  /** Graceful shutdown: stop claiming, give the in-flight batch the grace period, then abort it (rolls back and re-queues). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const grace = loadConfig().shutdownGraceMs;
    if (this.current) {
      this.log.info('waiting for in-flight batch', { grace_ms: grace });
      const timer = setTimeout(() => this.abort.abort(), grace);
      await this.current.catch(() => {});
      clearTimeout(timer);
    }
    await this.loopPromise;
  }
}

export async function replayBatch(tenantId: string, batchId: string) {
  return withTenant(tenantId, async (tx) => {
    // Replay always re-processes under the ACTIVE contract (the batch may have failed because its own was superseded).
    const { rows } = await tx.query(`UPDATE core.batches b SET status = 'queued', max_attempts = attempt_count + $3, failure = NULL, failed_at = NULL,
        trust_status = 'pending', trust_reasons = '[]'::jsonb, contract_version_id = cv.id, transform_version = cv.transform_version
        FROM core.contract_versions cv WHERE cv.tenant_id = $2 AND cv.lifecycle = 'active'
          AND b.id = $1 AND b.tenant_id = $2 AND b.status = 'failed' RETURNING b.id, b.status, b.attempt_count, cv.version AS contract_version`, [batchId, tenantId, loadConfig().maxAttempts]);
    return rows[0] ?? null;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
