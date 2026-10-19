// Compiles contract conditions and aggregations to parameterised SQL.
// Single implementation used by metrics, extracts and dataset checks, so the
// dashboard, APIs and reconciliation can never disagree about a definition.
// SQL's own three-valued logic matches the row-level evaluator in conditions.ts.

import type { Condition, EntityDef, MetricDef } from '../contracts/types.js';
import { ident } from '../platform/db.js';
import { sqlType, table } from '../contracts/compile.js';

export class Params {
  values: unknown[] = [];
  add(v: unknown, cast?: string): string { this.values.push(v); return `$${this.values.length}${cast ? `::${cast}` : ''}`; }
}

const OPS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

export function conditionSql(c: Condition, e: EntityDef, p: Params, alias = 'r'): string {
  if ('all' in c) return `(${c.all.map((x) => conditionSql(x, e, p, alias)).join(' AND ')})`;
  if ('any' in c) return `(${c.any.map((x) => conditionSql(x, e, p, alias)).join(' OR ')})`;
  if ('not' in c) return `(NOT ${conditionSql(c.not, e, p, alias)})`;
  const f = e.fields[c.field];
  const col = `${alias}.${ident(c.field)}`;
  const cast = sqlType(f);
  switch (c.op) {
    case 'is_null': return `(${col} IS NULL)`;
    case 'not_null': return `(${col} IS NOT NULL)`;
    case 'not_after_arrival': return f.type === 'date' ? `(${col} <= (b.arrival_at AT TIME ZONE 'UTC')::date)` : `(${col} <= b.arrival_at)`;
    case 'within_days_of': return `(abs(${col} - ${alias}.${ident((c as { other_field: string }).other_field)}) <= ${p.add((c as { days: number }).days, 'int')})`;
    case 'in': case 'not_in': {
      const list = (c as { values: (string | number)[] }).values.map((v) => p.add(String(v), cast)).join(', ');
      return `(${col} ${c.op === 'in' ? 'IN' : 'NOT IN'} (${list}))`;
    }
  }
  if ('other_field' in c) return `(${col} ${OPS[c.op]} ${alias}.${ident(c.other_field)})`;
  const v = (c as { value: string | number | boolean }).value;
  return `(${col} ${OPS[c.op]} ${p.add(f.type === 'boolean' ? Boolean(v) : String(v), cast)})`;
}

export function aggregateSql(agg: string, field: string | undefined, alias = 'r', e?: EntityDef): string {
  const scale = field && e?.fields[field]?.type === 'decimal' ? e.fields[field].scale ?? 2 : 0;
  switch (agg) {
    case 'count': return 'count(*)';
    case 'count_distinct': return `count(DISTINCT ${alias}.${ident(field!)})`;
    case 'sum': return `round(coalesce(sum(${alias}.${ident(field!)}), 0)::numeric, ${scale})`;
    case 'avg': return `round(avg(${alias}.${ident(field!)})::numeric, 4)`;
  }
  throw new Error(`unsupported aggregation ${agg}`);
}

export type TrustScope = 'trusted' | 'all' | 'untrusted';

/**
 * FROM/WHERE for an entity's dataset, as alias `r` joined to its batch as `b`.
 *  - 'trusted': for each key, the LATEST non-late version that came from a trusted batch. A newer
 *    version from an untrusted batch therefore never removes or replaces trusted data; trusted
 *    outputs show the last trusted state of every record.
 *  - 'all': the current version of each key, whatever its batch's trust.
 *  - 'untrusted': current versions from batches that are not trusted.
 * With as_of, only versions loaded at or before that instant are considered.
 */
export function currentFrom(tenant: string, entity: string, scope: TrustScope, asOf?: string, p?: Params, extraJoin = ''): string {
  if (scope === 'trusted') {
    const ts = asOf ? ` AND x."_loaded_at" <= ${p!.add(asOf, 'timestamptz')}` : '';
    return `FROM (SELECT DISTINCT ON (x."_key") x.* FROM ${table(tenant, entity)} x JOIN core.batches xb ON xb.id = x."_batch_id"
                WHERE NOT x."_is_late" AND xb.trust_status = 'trusted'${ts} ORDER BY x."_key", x."_record_id" DESC) r
          JOIN core.batches b ON b.id = r."_batch_id" ${extraJoin} WHERE true`;
  }
  const trust = scope === 'untrusted' ? ` AND b.trust_status <> 'trusted'` : '';
  if (!asOf) return `FROM ${table(tenant, entity)} r JOIN core.batches b ON b.id = r."_batch_id" ${extraJoin} WHERE r."_is_current"${trust}`;
  // Point-in-time view: the latest non-late version of each key loaded at or before as_of.
  const ts = p!.add(asOf, 'timestamptz');
  return `FROM (SELECT DISTINCT ON (x."_key") x.* FROM ${table(tenant, entity)} x WHERE x."_loaded_at" <= ${ts} AND NOT x."_is_late"
                ORDER BY x."_key", x."_record_id" DESC) r
          JOIN core.batches b ON b.id = r."_batch_id" ${extraJoin} WHERE true${trust}`;
}

/** Current records whose relationship target has never been received (shared by dataset checks and the exception report). */
export function orphanWhere(tenant: string, entity: string, rel: { field: string; references: { entity: string } }): string {
  return `FROM ${table(tenant, entity)} r WHERE r."_is_current" AND r.${ident(rel.field)} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ${table(tenant, rel.references.entity)} t WHERE t."_key" = r.${ident(rel.field)}::text)`;
}

export function metricSql(tenant: string, m: MetricDef, e: EntityDef, scope: TrustScope): { sql: string; params: unknown[] } {
  const p = new Params();
  const where = m.filter ? ` AND ${conditionSql(m.filter, e, p)}` : '';
  return { sql: `SELECT ${aggregateSql(m.aggregation, m.field, 'r', e)}::text AS value ${currentFrom(tenant, m.entity, scope)}${where}`, params: p.values };
}
