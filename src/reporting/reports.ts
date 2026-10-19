// Stakeholder reports: data operations, business summary, exceptions.
// Every number here comes from a query documented in docs/metrics.md; the
// dashboard renders these API results and computes nothing itself.

import { withTenant, type Tx } from '../platform/db.js';
import type { Contract } from '../contracts/types.js';
import { notFound } from '../platform/errors.js';
import { getActiveContract } from '../contracts/registry.js';
import type { Role } from '../control/auth.js';
import { loadPolicies } from '../policy/fields.js';
import { table } from '../contracts/compile.js';
import { metricSql, orphanWhere } from './sql.js';
import { ident } from '../platform/db.js';

export interface Window { from: string; to: string }

/**
 * Failing checks of the latest dataset reconciliation run, mapped to the entities they involve.
 * A failing dataset check qualifies every trusted figure over those entities (spec §6: a failed
 * reconciliation must not publish an unqualified result as trusted).
 */
export interface FailingCheck { check_id: string; explanation: string }
export async function failingDatasetChecks(tx: Tx, tenant: string, c: Contract): Promise<Map<string, FailingCheck[]>> {
  const { rows } = await tx.query(`SELECT check_id, explanation FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'dataset' AND status = 'failed'
      AND run_id = (SELECT run_id FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'dataset' ORDER BY created_at DESC, id DESC LIMIT 1)`, [tenant]);
  const byEntity = new Map<string, FailingCheck[]>();
  const add = (en: string, explanation: string) => byEntity.set(en, [...(byEntity.get(en) ?? []), { check_id: current, explanation }]);
  let current = '';
  for (const r of rows) {
    const id = String(r.check_id);
    current = id;
    const orphan = /^dataset:orphans:([^.]+)\./.exec(id);
    if (orphan) { add(orphan[1], r.explanation); continue; }
    const d = (c.dataset_checks ?? []).find((x) => `dataset:${x.id}` === id);
    if (d) for (const en of new Set([d.left.entity, 'entity' in d.right ? d.right.entity : d.left.entity])) add(en, r.explanation);
  }
  return byEntity;
}

export function defaultWindow(q: { from?: string; to?: string }): Window {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw notFound('invalid window');
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function operationsReport(tenant: string, w: Window) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    const totals = (await tx.query(
      `SELECT count(*)::int AS batches,
              count(*) FILTER (WHERE status IN ('completed','completed_with_exceptions'))::int AS succeeded,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE status IN ('queued','processing'))::int AS in_flight,
              count(*) FILTER (WHERE trust_status = 'trusted')::int AS trusted,
              count(*) FILTER (WHERE trust_status = 'untrusted')::int AS untrusted,
              coalesce(sum(received_count),0)::int AS rows_received,
              coalesce(sum(accepted_count),0)::int AS rows_accepted,
              coalesce(sum(quarantined_count),0)::int AS rows_quarantined,
              coalesce(sum(duplicate_count),0)::int AS rows_duplicate,
              (SELECT count(*)::int FROM core.batch_submissions s WHERE s.tenant_id = $1 AND s.outcome = 'duplicate' AND s.submitted_at BETWEEN $2 AND $3) AS duplicate_submissions,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - arrival_at)) FILTER (WHERE completed_at IS NOT NULL AND status <> 'rejected') AS latency_p50_s,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - arrival_at)) FILTER (WHERE completed_at IS NOT NULL AND status <> 'rejected') AS latency_p95_s
         FROM core.batches WHERE tenant_id = $1 AND arrival_at BETWEEN $2 AND $3`, [tenant, w.from, w.to])).rows[0];
    const daily = (await tx.query(
      `SELECT to_char(date_trunc('day', arrival_at), 'YYYY-MM-DD') AS day, count(*)::int AS batches,
              coalesce(sum(received_count),0)::int AS rows_received, coalesce(sum(quarantined_count),0)::int AS rows_quarantined,
              count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE trust_status = 'untrusted')::int AS untrusted
         FROM core.batches WHERE tenant_id = $1 AND arrival_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [tenant, w.from, w.to])).rows;
    const qualityByCategory = (await tx.query(
      `SELECT category, count(*)::int AS findings, count(DISTINCT raw_record_id)::int AS records
         FROM core.quality_findings f JOIN core.batches b ON b.id = f.batch_id
        WHERE f.tenant_id = $1 AND b.arrival_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [tenant, w.from, w.to])).rows;
    const queue = (await tx.query(`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'processing')::int AS processing,
        EXTRACT(EPOCH FROM now() - min(arrival_at) FILTER (WHERE status = 'queued')) AS oldest_queued_age_s FROM core.batches WHERE tenant_id = $1`, [tenant])).rows[0];
    const freshness: unknown[] = [];
    for (const [sid, s] of Object.entries(active?.document.sources ?? {})) {
      if (!active) break;
      const r = (await tx.query(`SELECT max(arrival_at) AS last_arrival, max(completed_at) FILTER (WHERE status IN ('completed','completed_with_exceptions')) AS last_success,
              max(completed_at) FILTER (WHERE trust_status = 'trusted') AS last_trusted FROM core.batches WHERE tenant_id = $1 AND source_id = $2`, [tenant, sid])).rows[0];
      const maxAge = active.document.entities[s.entity].freshness?.max_age_hours ?? null;
      const ageH = r.last_trusted ? (Date.now() - new Date(r.last_trusted).getTime()) / 3_600_000 : null;
      freshness.push({ source_id: sid, entity: s.entity, last_arrival: r.last_arrival, last_success: r.last_success, last_trusted: r.last_trusted,
        age_hours: ageH === null ? null : Number(ageH.toFixed(2)), max_age_hours: maxAge,
        status: ageH === null ? 'no_trusted_data' : maxAge !== null && ageH > maxAge ? 'stale' : 'fresh' });
    }
    const recentBatches = (await tx.query(
      `SELECT id, source_id, entity, status, trust_status, trust_reasons, quality_status, reconciliation_status, received_count, accepted_count, quarantined_count,
              duplicate_count, late_record_count, correction_count, conflict_count, attempt_count, is_late, arrival_at, completed_at,
              EXTRACT(EPOCH FROM completed_at - arrival_at) AS latency_s
         FROM core.batches WHERE tenant_id = $1 ORDER BY arrival_at DESC, id LIMIT 50`, [tenant])).rows;
    const latestDataset = (await tx.query(
      `SELECT check_id, status, explanation, created_at FROM core.reconciliation_results
        WHERE tenant_id = $1 AND scope = 'dataset' AND run_id = (SELECT run_id FROM core.reconciliation_results WHERE tenant_id = $1 AND scope = 'dataset' ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY check_id`, [tenant])).rows;
    // The verdict is computed here, not in the dashboard, so every consumer gets the same answer.
    const stale = (freshness as { status: string }[]).filter((f) => f.status === 'stale').length;
    const datasetFailing = latestDataset.filter((r) => r.status === 'failed').length;
    const problems = [
      totals.untrusted ? `${totals.untrusted} batch${totals.untrusted > 1 ? 'es are' : ' is'} not trusted` : null,
      totals.failed ? `${totals.failed} batch${totals.failed > 1 ? 'es' : ''} failed` : null,
      stale ? `${stale} source${stale > 1 ? 's are' : ' is'} stale` : null,
      datasetFailing ? `${datasetFailing} dataset check${datasetFailing > 1 ? 's are' : ' is'} failing` : null,
    ].filter((x): x is string => !!x);
    const inFlight = queue.queued + queue.processing;
    const verdict = problems.length
      ? { status: 'needs_review', summary: `${problems.join('; ')}. Trusted figures exclude untrusted batches and are qualified where dataset checks fail.`, problems }
      : inFlight
        ? { status: 'in_progress', summary: `${inFlight} batch${inFlight > 1 ? 'es are' : ' is'} still queued or processing; figures will change when they commit.`, problems }
        : { status: 'trusted', summary: 'Every batch in the window ran, reconciled and is trusted, and every dataset check passes.', problems };
    return { tenant, window: w, contract_version: active?.version ?? null, verdict, totals, daily, quality_by_category: qualityByCategory, queue, freshness,
      reconciliation: { batches_failed: recentBatches.filter((b) => b.reconciliation_status === 'failed').length, latest_dataset_run: latestDataset },
      recent_batches: recentBatches };
  });
}

export async function businessSummary(tenant: string, role: Role) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) throw notFound('no active contract');
    const c = active.document;
    const failing = await failingDatasetChecks(tx, tenant, c);
    const viewer = (await loadPolicies(tx, tenant, c)).viewer(role);
    const metrics = [];
    for (const m of c.outputs.metrics) {
      // A declared metric is an approved aggregate, but one computed over a field the role may not see in full is withheld
      // (the same boundary the query workspace applies to aggregates over restricted fields).
      const used = new Set<string>(m.field ? [m.field] : []);
      JSON.stringify(m.filter ?? {}, (k, v) => { if ((k === 'field' || k === 'other_field') && typeof v === 'string') used.add(v); return v; });
      if ([...used].some((f) => viewer.level(m.entity, f) === 'hidden')) continue;
      if ([...used].some((f) => viewer.level(m.entity, f) !== 'full')) {
        metrics.push({ id: m.id, title: m.title, description: m.description, unit: m.unit ?? 'count', entity: m.entity, aggregation: m.aggregation, field: m.field ?? null,
          filter: m.filter ?? null, value: null, value_including_untrusted: null, untrusted_records_excluded: null, dataset_checks_failing: [], trusted: false, withheld: 'computed over a field your role may not see in full' });
        continue;
      }
      const e = c.entities[m.entity];
      const trusted = metricSql(tenant, m, e, 'trusted');
      const all = metricSql(tenant, m, e, 'all');
      const tv = (await tx.query(trusted.sql, trusted.params)).rows[0].value;
      const av = (await tx.query(all.sql, all.params)).rows[0].value;
      const excluded = (await tx.query(`SELECT count(*)::int AS n FROM ${table(tenant, m.entity)} r JOIN core.batches b ON b.id = r."_batch_id" WHERE r."_is_current" AND b.trust_status <> 'trusted'`)).rows[0].n;
      const qualifications = failing.get(m.entity) ?? [];
      metrics.push({ id: m.id, title: m.title, description: m.description, unit: m.unit ?? 'count', entity: m.entity, aggregation: m.aggregation, field: m.field ?? null,
        filter: m.filter ?? null, value: tv, value_including_untrusted: av, untrusted_records_excluded: excluded, dataset_checks_failing: qualifications,
        trusted: tv === av && excluded === 0 && qualifications.length === 0 });
    }
    const ex = (await tx.query(`SELECT coalesce(sum(received_count),0)::int AS received, coalesce(sum(quarantined_count),0)::int AS quarantined
        FROM core.batches WHERE tenant_id = $1 AND status IN ('completed','completed_with_exceptions')`, [tenant])).rows[0];
    return {
      tenant, contract_version: active.version, generated_at: new Date().toISOString(), metrics,
      exception_rate: { received: ex.received, quarantined: ex.quarantined, rate: ex.received ? Number((ex.quarantined / ex.received).toFixed(6)) : 0 },
    };
  });
}

export async function exceptionReport(tenant: string, opts: { status?: 'open' | 'resolved' | 'all'; limit?: number; batchId?: string; role: Role }) {
  return withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) throw notFound('no active contract');
    const c = active.document;
    const viewer = (await loadPolicies(tx, tenant, c)).viewer(opts.role);
    const showKey = (en: string, k: unknown) => (k === null || k === undefined ? k : c.entities[en] ? viewer.key(en, c.entities[en].key, k) : k);
    const ruleField = (ruleId: string) => /^(?:type|required|not_null|constraint|privacy|rel|ref):(.+)$/.exec(ruleId)?.[1];
    const status = opts.status ?? 'open';
    const limit = Math.min(opts.limit ?? 500, 5000);
    const q = (await tx.query(
      `SELECT q.id, q.batch_id, b.source_id, q.entity, q.record_key, q.category, q.status, r.row_number AS source_row, q.errors, q.created_at, q.resolution
         FROM core.quarantine q JOIN core.batches b ON b.id = q.batch_id JOIN core.raw_records r ON r.id = q.raw_record_id
        WHERE q.tenant_id = $1 AND ($3::text IS NULL OR q.status = $3) AND ($4::uuid IS NULL OR q.batch_id = $4) ORDER BY q.created_at DESC, q.id LIMIT $2`,
      [tenant, limit, status === 'all' ? null : status, opts.batchId ?? null])).rows.map((r) => ({
        ...r, record_key: showKey(r.entity, r.record_key),
        reasons: (r.errors as { message: string; rule_id: string; field?: string }[]).map((e) => ({ rule_id: e.rule_id, message: viewer.message(r.entity, e.field ?? ruleField(e.rule_id), e.message) })), errors: undefined,
      }));
    const summary = (await tx.query(`SELECT category, status, count(*)::int AS n FROM core.quarantine WHERE tenant_id = $1 GROUP BY 1,2 ORDER BY 1,2`, [tenant])).rows;
    const late: unknown[] = [];
    const orphans: unknown[] = [];
    for (const [en, e] of Object.entries(c.entities)) {
      const rows = (await tx.query(`SELECT r."_record_id" AS record_id, r."_key" AS key, r."_batch_id" AS batch_id, r."_loaded_at" AS loaded_at
          FROM ${table(tenant, en)} r WHERE r."_is_late" ORDER BY r."_record_id" DESC LIMIT 200`)).rows;
      late.push(...rows.map((r) => ({ entity: en, ...r, key: showKey(en, r.key) })));
      for (const rel of e.relationships ?? []) {
        if (viewer.level(en, rel.field) === 'hidden') continue;
        const o = (await tx.query(`SELECT r."_record_id" AS record_id, r."_key" AS key, r.${ident(rel.field)}::text AS missing_reference, r."_batch_id" AS batch_id
            ${orphanWhere(tenant, en, rel)} ORDER BY r."_record_id" LIMIT 200`)).rows;
        orphans.push(...o.map((r) => ({ entity: en, relationship: rel.id, references: rel.references.entity, ...r,
          key: showKey(en, r.key),
          missing_reference: viewer.level(en, rel.field) === 'full' ? r.missing_reference : viewer.level(en, rel.field) === 'masked' ? viewer.present(en, rel.field, r.missing_reference).value : '[redacted]' })));
      }
    }
    const lateBatches = (await tx.query(`SELECT id, source_id, source_reported_at, arrival_at FROM core.batches WHERE tenant_id = $1 AND is_late ORDER BY arrival_at DESC LIMIT 100`, [tenant])).rows;
    const review = (await tx.query(`SELECT id, source_id, status, trust_status, trust_reasons, arrival_at FROM core.batches
        WHERE tenant_id = $1 AND (trust_status = 'untrusted' OR status = 'failed') ORDER BY arrival_at DESC LIMIT 100`, [tenant])).rows;
    return { tenant, generated_at: new Date().toISOString(), summary, quarantined: q, late_records: late, late_batches: lateBatches, orphaned_references: orphans, batches_requiring_review: review };
  });
}
