// The scheduler: durable, in the worker process, independent of any client.
//
// Each tick:
//   1. materialize due schedule occurrences into runs. Schedules are locked with SKIP LOCKED and
//      runs are unique per (schedule, occurrence), so concurrent schedulers create each occurrence
//      exactly once. If the scheduler was down across several occurrences, only the most recent
//      one runs and the others are counted in missed_occurrences (no burst of stale catch-up runs).
//   2. recover runs and deliveries whose worker vanished (expired leases);
//   3. claim and execute queued runs (bounded per process and, under a lock, per tenant);
//   4. send due deliveries (bounded), with retries and backoff;
//   5. purge expired result snapshots and export contents.
// State lives in PostgreSQL only; a timer in a client, or in memory, never drives a schedule.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withSystem, withTenant } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';
import { metrics } from '../platform/metrics.js';
import { nextOccurrence } from './recurrence.js';
import { insertRun, recurrenceOf } from './schedules.js';
import { claimRun, executeRun, LostLease, recoverRuns } from './runner.js';
import { claimDelivery, processDelivery, recoverDeliveries } from '../delivery/deliver.js';
import { appClock, type Clock } from './clock.js';
import type { Resolver } from '../delivery/ssrf.js';

export interface TickReport { materialized: number; missed: number; recovered: number; runs: number; deliveries: number; purged: number }

export class Scheduler {
  readonly id: string;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private log = createLogger({ service: 'clearline-scheduler' });
  private lastPurge = 0;

  constructor(private opts: { clock?: Clock; workerId?: string; resolver?: Resolver } = {}) {
    this.id = opts.workerId ?? `sched-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  get clock(): Clock { return this.opts.clock ?? appClock; }

  /** Turn due occurrences into queued runs. */
  async materialize(): Promise<{ created: number; missed: number }> {
    const now = this.clock.now();
    let created = 0; let missed = 0;
    for (;;) {
      const batch = await withSystem(async (tx) => {
        const due = (await tx.query(`SELECT s.*, q.current_version, q.status AS query_status FROM core.schedules s JOIN core.saved_queries q ON q.id = s.query_id
          WHERE s.status = 'active' AND s.next_run_at <= $1 ORDER BY s.next_run_at LIMIT 25 FOR UPDATE OF s SKIP LOCKED`, [new Date(now)])).rows;
        for (const s of due) {
          const rec = recurrenceOf(s);
          // Latest occurrence that is due; earlier due ones are counted as missed.
          let occ = new Date(s.next_run_at).getTime();
          let skipped = 0;
          let next = nextOccurrence(rec, occ);
          for (let guard = 0; next !== null && next <= now && guard < 100_000; guard++) { occ = next; skipped++; next = nextOccurrence(rec, occ); }
          let runId: string | null = null;
          if (s.query_status === 'active') {
            runId = await insertRun(tx, { tenant: s.tenant_id, queryId: s.query_id, version: s.pinned_version ?? s.current_version, scheduleId: s.id, occurrenceAt: new Date(occ), trigger: 'schedule',
              requestedBy: `schedule:${s.id}`, runAsActor: s.run_as_actor, runAsRole: s.run_as_role, parameters: s.parameters, destinationIds: s.destination_ids, maxAttempts: s.max_attempts, missed: skipped, now });
          }
          await tx.query(`UPDATE core.schedules SET next_run_at = $2, status = CASE WHEN $2::timestamptz IS NULL THEN 'completed' ELSE status END WHERE id = $1`, [s.id, next === null ? null : new Date(next)]);
          await tx.query(`INSERT INTO core.audit_events (tenant_id, actor, role, action, resource, outcome, details, correlation_id) VALUES ($1,$2,'system','schedule.occurrence',$3,$4,$5,$6)`,
            [s.tenant_id, `scheduler:${this.id}`, `schedule:${s.id}`, runId ? 'succeeded' : 'failed',
              JSON.stringify({ occurrence_at: new Date(occ).toISOString(), run_id: runId, missed_occurrences: skipped, next_run_at: next === null ? null : new Date(next).toISOString(),
                reason: s.query_status !== 'active' ? `saved query ${s.query_status}` : runId ? null : 'occurrence already has a run' }), runId]);
          if (runId) created++;
          missed += skipped;
        }
        return due.length;
      });
      if (batch < 25) break;
    }
    return { created, missed };
  }

  async purge(): Promise<number> {
    const now = new Date(this.clock.now());
    return withSystem(async (tx) => {
      const a = await tx.query(`DELETE FROM core.run_results WHERE expires_at <= $1`, [now]);
      const b = await tx.query(`UPDATE core.exports SET content = NULL WHERE expires_at <= $1 AND content IS NOT NULL`, [now]);
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
  }

  /** One full pass. Tests call this directly with a ManualClock; the loop calls it on an interval. */
  async tick(): Promise<TickReport> {
    const cfg = loadConfig();
    const ctx = { workerId: this.id, clock: this.clock };
    const m = await this.materialize();
    const recovered = (await recoverRuns(this.clock.now())).length + (await recoverDeliveries(this.clock.now()));
    // Runs: up to SCHEDULER_MAX_CONCURRENT at once in this process.
    let runs = 0;
    const workers = Array.from({ length: Math.max(1, cfg.schedulerMaxConcurrent) }, async () => {
      for (;;) {
        if (this.stopping) return;
        const run = await claimRun(this.id, this.clock.now());
        if (!run) return;
        runs++;
        const started = performance.now();
        try { await executeRun(run, ctx); }
        catch (err) {
          if (err instanceof LostLease) this.log.warn('lost run lease; another worker owns it', { run: run.id });
          else this.log.error('run execution failed', { run: run.id, error: err as Error });
        }
        metrics.analyticsRunSeconds.observe((performance.now() - started) / 1000);
      }
    });
    await Promise.all(workers);
    // Deliveries: up to DELIVERY_CONCURRENCY at once.
    let deliveries = 0;
    const senders = Array.from({ length: Math.max(1, cfg.deliveryConcurrency) }, async () => {
      for (;;) {
        if (this.stopping) return;
        const d = await claimDelivery(this.id, this.clock.now());
        if (!d) return;
        deliveries++;
        try { const o = await processDelivery(d, { ...ctx, resolver: this.opts.resolver }); metrics.deliveryAttempts.inc({ kind: d.kind, result: o.kind }); }
        catch (err) { this.log.error('delivery processing failed', { delivery: d.id, error: err as Error }); }
      }
    });
    await Promise.all(senders);
    let purged = 0;
    if (this.clock.now() - this.lastPurge > 60_000) { this.lastPurge = this.clock.now(); purged = await this.purge(); }
    return { materialized: m.created, missed: m.missed, recovered, runs, deliveries, purged };
  }

  /** Tick until nothing is left to do now (tests, demo). */
  async drain(maxTicks = 20): Promise<TickReport[]> {
    const out: TickReport[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const r = await this.tick();
      out.push(r);
      if (!r.materialized && !r.runs && !r.deliveries && !r.recovered) break;
    }
    return out;
  }

  start() {
    const cfg = loadConfig();
    this.log.info('scheduler started', { scheduler_id: this.id, tick_ms: cfg.schedulerTickMs, max_concurrent: cfg.schedulerMaxConcurrent, per_tenant: cfg.schedulerMaxPerTenant });
    this.loopPromise = (async () => {
      while (!this.stopping) {
        try { await this.tick(); }
        catch (err) { this.log.error('scheduler tick failed', { error: err as Error }); }
        await new Promise((r) => setTimeout(r, cfg.schedulerTickMs));
      }
      this.log.info('scheduler stopped', { scheduler_id: this.id });
    })();
    return this;
  }

  /** Stop claiming new work; in-flight runs and deliveries finish (or are recovered after their lease). */
  async stop() { this.stopping = true; await this.loopPromise; }
}

/** Manual retry of eligible deliveries of a run, without re-running the query. */
export async function retryDeliveries(tenant: string, runId: string, deliveryIds: string[] | null, now: number) {
  return withTenant(tenant, async (tx) => {
    const { rows } = await tx.query(`UPDATE core.deliveries SET status = 'retrying', next_attempt_at = $3, max_attempts = attempts + greatest(1, (SELECT max_attempts FROM core.delivery_destinations WHERE id = destination_id)),
        last_error_code = 'manual_retry', updated_at = $3
      WHERE run_id = $1 AND status IN ('failed','blocked') AND ($2::uuid[] IS NULL OR id = ANY($2)) RETURNING id`, [runId, deliveryIds, new Date(now)]);
    if (rows.length) await tx.query(`UPDATE core.analytics_runs SET status = CASE WHEN query_status = 'succeeded' THEN 'delivering' ELSE status END, delivery_status = 'pending', finished_at = CASE WHEN query_status = 'succeeded' THEN NULL ELSE finished_at END WHERE id = $1`, [runId]);
    return rows.map((r) => r.id as string);
  });
}
