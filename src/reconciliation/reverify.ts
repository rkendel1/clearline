// Post-load re-verification: re-check committed batches against what is in the
// target NOW. Detects out-of-band drift (rows deleted or edited outside the
// platform) while accounting for legitimate removals recorded as adjustments.
// A batch that fails re-verification loses trusted status, which removes its
// records from trusted metrics and default extracts.

import type { Tx } from '../platform/db.js';
import { ident } from '../platform/db.js';
import { table } from '../contracts/compile.js';
import { getContractVersion } from '../contracts/registry.js';
import { auditTx } from '../control/audit.js';
import { subDecimal } from '../transform/coerce.js';
import type { ReconResult } from './batch.js';

/** Record legitimate removals (erasure, retention) so re-verification does not flag them as drift. */
export async function recordRemovalAdjustments(tx: Tx, tenant: string, entity: string, where: string, params: unknown[], reason: string) {
  const batches = (await tx.query(`SELECT "_batch_id" AS b, count(*)::int AS n FROM ${table(tenant, entity)} WHERE "_migration_id" IS NULL AND (${where}) GROUP BY 1`, params)).rows;
  for (const row of batches) {
    const b = (await tx.query(`SELECT source_id, contract_version_id FROM core.batches WHERE id = $1`, [row.b])).rows[0];
    const cv = await getContractVersion(tx, Number(b.contract_version_id));
    const fields = cv.document.sources[b.source_id]?.control_totals?.sum_fields ?? [];
    const sums: Record<string, string> = {};
    for (const f of fields) {
      const r = await tx.query(`SELECT coalesce(sum(${ident(f)}),0)::text AS s FROM ${table(tenant, entity)} WHERE "_batch_id" = $${params.length + 1} AND "_migration_id" IS NULL AND (${where})`, [...params, row.b]);
      sums[f] = r.rows[0].s;
    }
    await tx.query(`INSERT INTO core.batch_adjustments (tenant_id, batch_id, reason, rows_removed, sums_removed) VALUES ($1,$2,$3,$4,$5)`, [tenant, row.b, reason, row.n, JSON.stringify(sums)]);
  }
}

export async function reverifyBatches(tx: Tx, tenant: string, runId: string, actor: string): Promise<{ batch_id: string; results: ReconResult[] }[]> {
  const batches = (await tx.query(`SELECT id, source_id, entity, contract_version_id, accepted_count, attempt_count, trust_status FROM core.batches
      WHERE tenant_id = $1 AND status IN ('completed','completed_with_exceptions') ORDER BY arrival_at`, [tenant])).rows;
  const out: { batch_id: string; results: ReconResult[] }[] = [];
  for (const b of batches) {
    const cv = await getContractVersion(tx, Number(b.contract_version_id));
    const fields = cv.document.sources[b.source_id]?.control_totals?.sum_fields ?? [];
    const adj = (await tx.query(`SELECT coalesce(sum(rows_removed),0)::int AS n, coalesce(jsonb_agg(sums_removed),'[]'::jsonb) AS s FROM core.batch_adjustments WHERE batch_id = $1`, [b.id])).rows[0];
    const t = table(tenant, b.entity);
    const actual = (await tx.query(`SELECT count(*)::int AS n${fields.map((f, i) => `, coalesce(sum(${ident(f)}),0)::text AS s${i}`).join('')} FROM ${t} WHERE "_batch_id" = $1 AND "_migration_id" IS NULL`, [b.id])).rows[0];
    const results: ReconResult[] = [];
    const expectedRows = b.accepted_count - adj.n;
    results.push({ check_id: 'reverify:target_row_count', status: actual.n === expectedRows ? 'passed' : 'failed', expected: { accepted: b.accepted_count, legitimately_removed: adj.n, expected_now: expectedRows },
      actual: { persisted: actual.n }, difference: { rows: actual.n - expectedRows },
      explanation: actual.n === expectedRows ? `Target still holds the ${expectedRows} expected rows for this batch.`
        : `Target holds ${actual.n} rows for this batch but ${expectedRows} are expected (${b.accepted_count} accepted − ${adj.n} removed by erasure/retention): ${Math.abs(actual.n - expectedRows)} row(s) ${actual.n < expectedRows ? 'missing — deleted outside the platform' : 'unexpected — inserted outside the platform'}.` });
    for (const [i, f] of fields.entries()) {
      const acceptedRow = (await tx.query(`SELECT actual->>'accepted' AS a FROM core.reconciliation_results WHERE batch_id = $1 AND check_id = $2 AND scope = 'batch' ORDER BY id DESC LIMIT 1`, [b.id, `financial_accounting:${f}`])).rows[0];
      if (!acceptedRow) continue;
      let expected = acceptedRow.a as string;
      for (const s of adj.s as Record<string, string>[]) if (s[f]) expected = subDecimal(expected, s[f]);
      const diff = subDecimal(actual[`s${i}`], expected);
      const ok = !/[1-9]/.test(diff);
      results.push({ check_id: `reverify:target_sum:${f}`, status: ok ? 'passed' : 'failed', expected: { expected_now: expected }, actual: { persisted: actual[`s${i}`] }, difference: { amount: diff },
        explanation: ok ? `Persisted ${f} still equals the accepted total net of recorded removals (${expected}).` : `Persisted ${f} is ${actual[`s${i}`]} but ${expected} is expected: difference ${diff} not explained by any recorded erasure or retention.` });
    }
    for (const r of results) {
      await tx.query(`INSERT INTO core.reconciliation_results (tenant_id, batch_id, run_id, scope, check_id, status, expected, actual, difference, explanation, contract_version_id)
        VALUES ($1,$2,$3,'batch',$4,$5,$6,$7,$8,$9,$10)`, [tenant, b.id, runId, r.check_id, r.status, JSON.stringify(r.expected), JSON.stringify(r.actual), JSON.stringify(r.difference), r.explanation, cv.id]);
    }
    const failed = results.filter((r) => r.status === 'failed');
    const reasons = (await tx.query(`SELECT trust_reasons FROM core.batches WHERE id = $1`, [b.id])).rows[0].trust_reasons as string[];
    if (!failed.length && b.trust_status === 'untrusted' && reasons.length > 0 && reasons.every((r) => r.startsWith('post-load drift detected'))) {
      // Drift was the only reason for distrust and the target matches again (e.g. rows restored from backup):
      // restore trust only if the batch's own load-time reconciliation also passed.
      const original = (await tx.query(`SELECT count(*) FILTER (WHERE status = 'failed')::int AS f, count(*)::int AS n FROM core.reconciliation_results WHERE batch_id = $1 AND run_id = $2`, [b.id, `${b.id}#${b.attempt_count}`])).rows[0];
      if (original.n > 0 && original.f === 0) {
        await tx.query(`UPDATE core.batches SET trust_status = 'trusted', reconciliation_status = 'passed', trust_reasons = '[]'::jsonb WHERE id = $1`, [b.id]);
        await auditTx(tx, { tenantId: tenant, actor, role: 'system', action: 'batch.trust_restored', resource: `batch:${b.id}`, outcome: 'succeeded', details: { run_id: runId, previous_reasons: reasons } });
      }
    }
    if (failed.length) {
      await tx.query(`UPDATE core.batches SET reconciliation_status = 'failed', trust_status = 'untrusted',
          trust_reasons = trust_reasons || $2::jsonb WHERE id = $1`, [b.id, JSON.stringify([`post-load drift detected (${runId}): ${failed.map((r) => r.check_id).join(', ')}`])]);
      await auditTx(tx, { tenantId: tenant, actor, role: 'system', action: 'batch.drift_detected', resource: `batch:${b.id}`, outcome: 'failed', details: { run_id: runId, failed: failed.map((r) => ({ check: r.check_id, difference: r.difference })) } });
    }
    out.push({ batch_id: b.id, results });
  }
  return out;
}
