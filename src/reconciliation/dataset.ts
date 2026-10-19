// Dataset-level reconciliation over the trusted current dataset of a tenant:
// declared invariants (dataset_checks), orphaned references, and freshness.

import { withTenant, type Tx } from '../platform/db.js';
import { getActiveContract } from '../contracts/registry.js';
import { table } from '../contracts/compile.js';
import type { Contract, DatasetCheckDef } from '../contracts/types.js';
import { aggregateSql, conditionSql, currentFrom, orphanWhere, Params } from '../reporting/sql.js';
import { compareCanonical, subDecimal } from '../transform/coerce.js';
import type { ReconResult } from './batch.js';
import { reverifyBatches } from './reverify.js';

async function sideValue(tx: Tx, tenant: string, c: Contract, side: DatasetCheckDef['left']): Promise<string> {
  const e = c.entities[side.entity];
  const p = new Params();
  const where = side.filter ? ` AND ${conditionSql(side.filter, e, p)}` : '';
  const { rows } = await tx.query(`SELECT ${aggregateSql(side.aggregation, side.field, 'r', e)}::text AS v ${currentFrom(tenant, side.entity, 'trusted')}${where}`, p.values);
  return rows[0].v;
}

const OPS: Record<string, (c: number) => boolean> = { eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, lte: (c) => c <= 0, gt: (c) => c > 0, gte: (c) => c >= 0 };

export async function evaluateDatasetChecks(tx: Tx, tenant: string, c: Contract): Promise<ReconResult[]> {
  const out: ReconResult[] = [];
  for (const d of c.dataset_checks ?? []) {
    const left = await sideValue(tx, tenant, c, d.left);
    const right = 'value' in d.right ? String(d.right.value) : await sideValue(tx, tenant, c, d.right);
    const diff = subDecimal(left, right);
    const tol = String(d.tolerance ?? 0);
    let cmp = compareCanonical('decimal', left, right);
    if (cmp !== 0 && compareCanonical('decimal', diff.replace('-', ''), tol) <= 0) cmp = 0;
    const ok = OPS[d.op](cmp);
    out.push({ check_id: `dataset:${d.id}`, status: ok ? 'passed' : 'failed', expected: { op: d.op, right, tolerance: d.tolerance ?? 0 }, actual: { left }, difference: { amount: diff },
      explanation: ok ? `${d.description}: holds (${left} ${d.op} ${right}).` : `${d.description}: violated — left side ${left}, right side ${right}, difference ${diff}.` });
  }
  for (const [en, e] of Object.entries(c.entities)) {
    for (const rel of e.relationships ?? []) {
      const { rows } = await tx.query(`SELECT count(*)::int AS n ${orphanWhere(tenant, en, rel)}`);
      const n = rows[0].n;
      out.push({ check_id: `dataset:orphans:${en}.${rel.id}`, status: n === 0 ? 'passed' : 'failed', expected: { orphans: 0 }, actual: { orphans: n }, difference: { rows: n },
        explanation: n === 0 ? `Every current ${en} references an existing ${rel.references.entity}.` : `${n} current ${en} record(s) reference a ${rel.references.entity} that has not been received (late or missing reference data); see the exception report.` });
    }
  }
  return out;
}

export async function runDatasetChecks(tenant: string, runId: string, opts: { reverify?: boolean; actor?: string } = {}): Promise<ReconResult[]> {
  return withTenant(tenant, async (tx) => {
    if (opts.reverify) await reverifyBatches(tx, tenant, `reverify:${runId}`, opts.actor ?? 'system');
    const active = await getActiveContract(tx, tenant);
    if (!active) return [];
    const results = await evaluateDatasetChecks(tx, tenant, active.document);
    for (const r of results) {
      await tx.query(`INSERT INTO core.reconciliation_results (tenant_id, batch_id, run_id, scope, check_id, status, expected, actual, difference, explanation, contract_version_id)
        VALUES ($1, NULL, $2, 'dataset', $3, $4, $5, $6, $7, $8, $9)`,
        [tenant, runId, r.check_id, r.status, JSON.stringify(r.expected), JSON.stringify(r.actual), JSON.stringify(r.difference), r.explanation, active.id]);
    }
    return results;
  });
}
