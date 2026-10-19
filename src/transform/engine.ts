// Row-level transformation and validation. Pure and deterministic: the same
// raw row, contract and engine version always yield the same outcome and hash.
// Stateful checks (keys, corrections, referential integrity) happen in the
// batch processor, which has database context.

import { createHash } from 'node:crypto';
import type { Contract, EntityDef, FieldDef, SourceDef } from '../contracts/types.js';
import { SENSITIVE } from '../contracts/types.js';
import { checkConstraints, parseCanonical, type Canonical } from './coerce.js';
import { evaluate, type EvalContext } from './conditions.js';
import { applyTransform, TransformError } from './transforms.js';
import { detectSensitiveValue, isSuspiciousColumnName } from '../quality/sensitive.js';

export type Category = 'structural' | 'business_rule' | 'referential' | 'conflict' | 'privacy';

export interface Finding {
  rule_id: string;          // stable identifier, e.g. "type:dob", "rule:paid_le_billed", "required:member_id"
  rule_kind: 'required' | 'nullability' | 'type' | 'constraint' | 'transform' | 'rule' | 'relationship' | 'privacy' | 'parse' | 'conflict';
  category: Category;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
}

export type RawRow = Record<string, string | null>;

export interface RowResult {
  values: Record<string, Canonical>;   // canonical values (fields that failed to coerce are null)
  findings: Finding[];
  errors: Finding[];                   // findings with severity error
  key: string | null;                  // canonical key, when all key fields are valid
  hash: string | null;                 // content hash of canonical values, when there are no structural errors
}

export const CATEGORY_PRIORITY: Category[] = ['structural', 'privacy', 'business_rule', 'referential', 'conflict'];

export function primaryCategory(errors: Finding[]): Category {
  for (const c of CATEGORY_PRIORITY) if (errors.some((e) => e.category === c)) return c;
  return 'business_rule';
}

/** Display a value in an error message only when the field is not sensitive. */
function show(f: FieldDef | undefined, v: unknown): string {
  if (!f || SENSITIVE.has(f.sensitivity ?? 'internal')) return '[redacted]';
  const s = String(v);
  return `"${s.length > 40 ? s.slice(0, 40) + '…' : s}"`;
}

export function canonicalKey(entity: EntityDef, values: Record<string, Canonical>): string | null {
  const parts = entity.key.map((k) => values[k]);
  if (parts.some((p) => p === null || p === undefined)) return null;
  return parts.length === 1 ? String(parts[0]) : JSON.stringify(parts);
}

export function recordHash(entity: EntityDef, values: Record<string, Canonical>): string {
  const ordered = Object.keys(entity.fields).sort().map((k) => [k, values[k] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function mappedColumns(source: SourceDef): Set<string> {
  const cols = new Set<string>();
  for (const m of source.mappings) {
    if (typeof m.from === 'string') cols.add(m.from);
    else if (Array.isArray(m.from)) m.from.forEach((c) => cols.add(c));
  }
  return cols;
}

export function transformRow(contract: Contract, sourceId: string, raw: RawRow, ctx: EvalContext, presentColumns: Set<string>): RowResult {
  const source = contract.sources[sourceId];
  const entity = contract.entities[source.entity];
  const findings: Finding[] = [];
  const values: Record<string, Canonical> = {};
  const structurallyBad = new Set<string>();
  const scan = source.sensitive_scan ?? { unmapped_columns: 'quarantine', classified_fields: 'quarantine' };

  for (const m of source.mappings) {
    const f = entity.fields[m.target];
    let v: string | null;
    if (m.constant !== undefined) v = m.constant;
    else if (Array.isArray(m.from)) {
      const parts = m.from.map((c) => raw[c] ?? null);
      v = parts.every((p) => p === null || p === '') ? null : parts.map((p) => p ?? '').join(m.separator ?? '');
    } else {
      const col = m.from as string;
      if (!presentColumns.has(col)) {
        if (f.required) { findings.push({ rule_id: `required:${m.target}`, rule_kind: 'required', category: 'structural', severity: 'error', field: m.target, message: `required source column "${col}" is missing` }); structurallyBad.add(m.target); }
        values[m.target] = null;
        continue;
      }
      v = raw[col] ?? null;
    }
    if (v === '') v = null;
    try {
      for (const t of m.transforms ?? []) v = applyTransform(t, v);
    } catch (err) {
      if (!(err instanceof TransformError)) throw err;
      findings.push({ rule_id: `type:${m.target}`, rule_kind: 'transform', category: 'structural', severity: 'error', field: m.target, message: `${m.target}: ${err.message}${f && !SENSITIVE.has(f.sensitivity ?? 'internal') ? ` (got ${show(f, v)})` : ''}` });
      values[m.target] = null; structurallyBad.add(m.target);
      continue;
    }
    if (v === '') v = null;
    const parsed = parseCanonical(f, v);
    if (!parsed.ok) {
      findings.push({ rule_id: `type:${m.target}`, rule_kind: 'type', category: 'structural', severity: 'error', field: m.target, message: `${m.target}: ${parsed.error} (got ${show(f, v)})` });
      values[m.target] = null; structurallyBad.add(m.target);
      continue;
    }
    values[m.target] = parsed.value;
  }

  for (const [fn, f] of Object.entries(entity.fields)) {
    if (!(fn in values)) values[fn] = null;
    if (structurallyBad.has(fn)) continue;
    if (values[fn] === null && f.nullable === false) {
      findings.push({ rule_id: `not_null:${fn}`, rule_kind: 'nullability', category: 'structural', severity: 'error', field: fn, message: `${fn} must not be empty` });
      structurallyBad.add(fn);
      continue;
    }
    const c = checkConstraints(f, values[fn]);
    if (c) { findings.push({ rule_id: `constraint:${fn}`, rule_kind: 'constraint', category: 'structural', severity: 'error', field: fn, message: `${fn}: ${c} (got ${show(f, values[fn])})` }); structurallyBad.add(fn); }
  }

  // Sensitive data where it is not expected.
  const mapped = mappedColumns(source);
  for (const col of presentColumns) {
    if (mapped.has(col)) continue;
    const v = raw[col];
    if (v === null || v === undefined || v === '') continue;
    const kind = detectSensitiveValue(v) ?? (isSuspiciousColumnName(col) ? 'suspicious column name' : null);
    if (kind) findings.push({ rule_id: 'privacy:unmapped_sensitive', rule_kind: 'privacy', category: 'privacy', severity: scan.unmapped_columns === 'quarantine' ? 'error' : 'warning', field: undefined, message: `unmapped source column "${col}" appears to contain sensitive data (${kind}); value not stored in canonical data` });
  }
  for (const [fn, f] of Object.entries(entity.fields)) {
    const v = values[fn];
    if (typeof v !== 'string' || f.type !== 'string' || SENSITIVE.has(f.sensitivity ?? 'internal')) continue;
    const kind = detectSensitiveValue(v);
    if (kind) findings.push({ rule_id: `privacy:${fn}`, rule_kind: 'privacy', category: 'privacy', severity: scan.classified_fields === 'quarantine' ? 'error' : 'warning', field: fn, message: `${fn} is classified ${f.sensitivity ?? 'internal'} but contains data resembling ${kind}` });
  }

  // Business rules only run on structurally valid rows: rules over garbage values produce noise, not signal.
  if (structurallyBad.size === 0) {
    for (const r of entity.rules ?? []) {
      if (r.when && evaluate(r.when, entity, values, ctx) !== true) continue;
      if (evaluate(r.assert, entity, values, ctx) === false) {
        findings.push({ rule_id: `rule:${r.id}`, rule_kind: 'rule', category: 'business_rule', severity: r.severity, message: r.description });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const keyBad = entity.key.some((k) => structurallyBad.has(k));
  return {
    values,
    findings,
    errors,
    key: keyBad ? null : canonicalKey(entity, values),
    hash: structurallyBad.size === 0 ? recordHash(entity, values) : null,
  };
}
