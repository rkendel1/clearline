// Evaluation of the contract condition language with SQL-style three-valued
// logic: a comparison involving a null operand is "unknown" (null). A rule
// fails only when its assertion is definitely false; requiredness is enforced
// separately by nullable/required, so nulls never produce surprise failures.

import type { Condition, EntityDef } from '../contracts/types.js';
import { compareCanonical, parseCanonical, type Canonical } from './coerce.js';

export type Tri = boolean | null;
export interface EvalContext { arrivalDate: string; arrivalTs: string }

function cmp(op: string, c: number): boolean {
  switch (op) {
    case 'eq': return c === 0; case 'ne': return c !== 0;
    case 'lt': return c < 0; case 'lte': return c <= 0;
    case 'gt': return c > 0; case 'gte': return c >= 0;
  }
  throw new Error(`unknown operator ${op}`);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function evaluate(cond: Condition, e: EntityDef, row: Record<string, Canonical>, ctx: EvalContext): Tri {
  if ('all' in cond) {
    let unknown = false;
    for (const c of cond.all) { const r = evaluate(c, e, row, ctx); if (r === false) return false; if (r === null) unknown = true; }
    return unknown ? null : true;
  }
  if ('any' in cond) {
    let unknown = false;
    for (const c of cond.any) { const r = evaluate(c, e, row, ctx); if (r === true) return true; if (r === null) unknown = true; }
    return unknown ? null : false;
  }
  if ('not' in cond) { const r = evaluate(cond.not, e, row, ctx); return r === null ? null : !r; }

  const f = e.fields[cond.field];
  const v = row[cond.field] ?? null;
  if (cond.op === 'is_null') return v === null;
  if (cond.op === 'not_null') return v !== null;
  if (v === null) return null;
  if (cond.op === 'not_after_arrival') {
    return f.type === 'date' ? String(v) <= ctx.arrivalDate : compareCanonical('timestamp', v, ctx.arrivalTs) <= 0;
  }
  if ('other_field' in cond) {
    const o = row[cond.other_field] ?? null;
    if (o === null) return null;
    if (cond.op === 'within_days_of') return daysBetween(String(v), String(o)) <= cond.days;
    const t = f.type === 'integer' && e.fields[cond.other_field].type === 'decimal' ? 'decimal' : f.type;
    return cmp(cond.op, compareCanonical(t, v, o));
  }
  if ('values' in cond) {
    const set = cond.values.map((x) => { const p = parseCanonical(f, x); return p.ok ? p.value : x; });
    const hit = set.some((x) => compareCanonical(f.type, v, x as Canonical) === 0);
    return cond.op === 'in' ? hit : !hit;
  }
  const lit = parseCanonical(f, (cond as { value: string | number | boolean }).value);
  if (!lit.ok || lit.value === null) return null;
  return cmp(cond.op, compareCanonical(f.type, v, lit.value));
}

/** Fields referenced by a condition (used for lineage/documentation and migration impact). */
export function conditionFields(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(conditionFields);
  if ('any' in cond) return cond.any.flatMap(conditionFields);
  if ('not' in cond) return conditionFields(cond.not);
  return 'other_field' in cond ? [cond.field, cond.other_field] : [cond.field];
}
