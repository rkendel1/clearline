// Contract validation = structural (JSON Schema) + semantic (cross references,
// type compatibility, supported-feature checks). Anything the platform cannot
// execute faithfully is rejected here with a precise path and reason.

import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Condition, Contract, EntityDef, FieldDef, FieldType } from './types.js';
import { parseCanonical } from '../transform/coerce.js';

export interface ContractIssue { path: string; message: string }

const here = path.dirname(fileURLToPath(import.meta.url));
function loadSchema(): object {
  for (const p of [path.resolve(here, '../../contracts/contract.schema.json'), path.resolve(here, '../../../contracts/contract.schema.json'), path.resolve(process.cwd(), 'contracts/contract.schema.json')]) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* next */ }
  }
  throw new Error('contracts/contract.schema.json not found');
}

export const CONTRACT_SCHEMA = loadSchema();
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: true, allowUnionTypes: true });
const validateSchema = ajv.compile(CONTRACT_SCHEMA);

const ORDERED: ReadonlySet<FieldType> = new Set(['integer', 'decimal', 'date', 'timestamp']);
const NUMERIC: ReadonlySet<FieldType> = new Set(['integer', 'decimal']);
const MAX_CONDITION_DEPTH = 6;

export function validateContract(doc: unknown): { ok: true; contract: Contract } | { ok: false; issues: ContractIssue[] } {
  if (!validateSchema(doc)) {
    const issues = (validateSchema.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message}${e.params && 'additionalProperty' in e.params ? `: "${(e.params as { additionalProperty: string }).additionalProperty}" is not a supported property` : ''}${e.params && 'allowedValues' in e.params ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')})` : ''}`,
    }));
    // oneOf failures produce one error per branch; keep the list readable.
    const seen = new Set<string>();
    return { ok: false, issues: issues.filter((i) => { const k = i.path + i.message; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50) };
  }
  const c = doc as Contract;
  const issues: ContractIssue[] = [];
  const add = (p: string, m: string) => issues.push({ path: p, message: m });

  for (const [en, e] of Object.entries(c.entities)) checkEntity(c, en, e, add);

  for (const [sn, s] of Object.entries(c.sources)) {
    const p = `/sources/${sn}`;
    const e = c.entities[s.entity];
    if (!e) { add(`${p}/entity`, `unknown entity "${s.entity}"`); continue; }
    const targets = new Set<string>();
    s.mappings.forEach((m, i) => {
      const mp = `${p}/mappings/${i}`;
      const f = e.fields[m.target];
      if (!f) { add(`${mp}/target`, `entity "${s.entity}" has no field "${m.target}"`); return; }
      if (targets.has(m.target)) add(`${mp}/target`, `field "${m.target}" is mapped more than once`);
      targets.add(m.target);
      const hasFrom = m.from !== undefined, hasConst = m.constant !== undefined;
      if (hasFrom === hasConst) add(mp, 'exactly one of "from" or "constant" is required');
      if (m.separator !== undefined && !Array.isArray(m.from)) add(`${mp}/separator`, '"separator" only applies when "from" lists several columns');
      const ts = m.transforms ?? [];
      const parseIdx = ts.findIndex((t) => t.op.startsWith('parse_'));
      if (parseIdx >= 0) {
        if (parseIdx !== ts.length - 1) add(`${mp}/transforms/${parseIdx}`, 'a parse_* transform must be the last transform in the chain');
        if (ts.filter((t) => t.op.startsWith('parse_')).length > 1) add(`${mp}/transforms`, 'only one parse_* transform is allowed');
        const expected: Record<string, FieldType[]> = {
          parse_date: ['date'], parse_timestamp: ['timestamp'], parse_decimal: ['decimal'], parse_integer: ['integer'], parse_boolean: ['boolean'],
        };
        const op = ts[parseIdx].op;
        if (!expected[op]?.includes(f.type)) add(`${mp}/transforms/${parseIdx}`, `${op} produces a value incompatible with field type "${f.type}"`);
      }
      for (const [ti, t] of ts.entries()) {
        if (t.op === 'default' && f.type !== 'string' && f.type !== 'enum' && parseIdx >= 0 && ti > parseIdx) add(`${mp}/transforms/${ti}`, 'default must come before parsing');
      }
    });
    for (const [fn, f] of Object.entries(e.fields)) {
      if (f.required && !targets.has(fn)) add(`${p}/mappings`, `required field "${s.entity}.${fn}" has no mapping`);
    }
    for (const sf of s.control_totals?.sum_fields ?? []) {
      const f = e.fields[sf];
      if (!f) add(`${p}/control_totals`, `unknown field "${sf}"`);
      else if (!NUMERIC.has(f.type)) add(`${p}/control_totals`, `control total field "${sf}" must be numeric`);
      else if (!targets.has(sf)) add(`${p}/control_totals`, `control total field "${sf}" is not mapped by this source`);
    }
  }

  const metricIds = new Set<string>();
  c.outputs.metrics.forEach((m, i) => {
    const p = `/outputs/metrics/${i}`;
    if (metricIds.has(m.id)) add(`${p}/id`, `duplicate metric id "${m.id}"`);
    metricIds.add(m.id);
    const e = c.entities[m.entity];
    if (!e) { add(`${p}/entity`, `unknown entity "${m.entity}"`); return; }
    if (m.aggregation === 'count') { if (m.field) add(`${p}/field`, 'count does not take a field'); }
    else if (!m.field) add(`${p}/field`, `${m.aggregation} requires a field`);
    else if (!e.fields[m.field]) add(`${p}/field`, `unknown field "${m.field}"`);
    else if ((m.aggregation === 'sum' || m.aggregation === 'avg') && !NUMERIC.has(e.fields[m.field].type)) add(`${p}/field`, `${m.aggregation} requires a numeric field`);
    if (m.filter) checkCondition(e, m.filter, `${p}/filter`, add, 0);
  });

  const extractIds = new Set<string>();
  c.outputs.extracts.forEach((x, i) => {
    const p = `/outputs/extracts/${i}`;
    if (extractIds.has(x.id)) add(`${p}/id`, `duplicate extract id "${x.id}"`);
    extractIds.add(x.id);
    const e = c.entities[x.entity];
    if (!e) { add(`${p}/entity`, `unknown entity "${x.entity}"`); return; }
    for (const f of x.fields) if (!e.fields[f]) add(`${p}/fields`, `unknown field "${f}"`);
    for (const f of x.filterable ?? []) {
      if (!e.fields[f]) add(`${p}/filterable`, `unknown field "${f}"`);
      else if (e.fields[f].type === 'boolean' || e.fields[f].type === 'decimal') add(`${p}/filterable`, `field "${f}" type ${e.fields[f].type} is not filterable`);
    }
  });

  (c.dataset_checks ?? []).forEach((d, i) => {
    const p = `/dataset_checks/${i}`;
    for (const [side, s] of [['left', d.left], ['right', d.right]] as const) {
      if ('value' in s) continue;
      const e = c.entities[s.entity];
      if (!e) { add(`${p}/${side}/entity`, `unknown entity "${s.entity}"`); continue; }
      if (s.aggregation === 'sum') {
        if (!s.field || !e.fields[s.field]) add(`${p}/${side}/field`, 'sum requires an existing field');
        else if (!NUMERIC.has(e.fields[s.field].type)) add(`${p}/${side}/field`, 'sum requires a numeric field');
      } else if (s.field) add(`${p}/${side}/field`, 'count does not take a field');
      if (s.filter) checkCondition(e, s.filter, `${p}/${side}/filter`, add, 0);
    }
  });

  for (const [kind, hints] of Object.entries(c.migration ?? {}) as [string, Record<string, Record<string, unknown>>][]) {
    for (const [en, fields] of Object.entries(hints)) {
      const e = c.entities[en];
      if (!e) { add(`/migration/${kind}/${en}`, `unknown entity "${en}"`); continue; }
      for (const [fn, v] of Object.entries(fields)) {
        const f = e.fields[fn];
        if (!f) { add(`/migration/${kind}/${en}/${fn}`, `unknown field "${fn}"`); continue; }
        if (kind === 'backfill') {
          const r = parseCanonical(f, v as string);
          if (!r.ok) add(`/migration/backfill/${en}/${fn}`, `backfill value invalid: ${r.error}`);
        } else if (kind === 'value_maps') {
          if (f.type !== 'enum' && f.type !== 'string') add(`/migration/value_maps/${en}/${fn}`, 'value maps are supported only for string and enum fields');
          for (const nv of Object.values(v as Record<string, string>)) {
            if (f.type === 'enum' && !f.values!.includes(nv)) add(`/migration/value_maps/${en}/${fn}`, `mapped value "${nv}" is not in the new enum values`);
          }
        }
      }
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, contract: c };
}

function checkEntity(c: Contract, en: string, e: EntityDef, add: (p: string, m: string) => void) {
  const p = `/entities/${en}`;
  for (const [fn, f] of Object.entries(e.fields)) checkField(`${p}/fields/${fn}`, f, add);
  for (const k of e.key) {
    const f = e.fields[k];
    if (!f) { add(`${p}/key`, `key field "${k}" is not defined`); continue; }
    if (!f.required || f.nullable !== false) add(`${p}/key`, `key field "${k}" must be required and nullable: false`);
    if (f.type === 'decimal' || f.type === 'boolean' || f.type === 'timestamp') add(`${p}/key`, `key field "${k}" has unsupported key type ${f.type}`);
  }
  const corr = e.correction;
  if (corr.strategy === 'supersede_by_order') {
    if (!corr.order_by) add(`${p}/correction`, 'supersede_by_order requires order_by');
    else {
      const f = e.fields[corr.order_by];
      if (!f) add(`${p}/correction/order_by`, `unknown field "${corr.order_by}"`);
      else {
        if (!ORDERED.has(f.type) || f.type === 'decimal') add(`${p}/correction/order_by`, 'order_by must be an integer, date or timestamp field');
        if (!f.required || f.nullable !== false) add(`${p}/correction/order_by`, 'order_by field must be required and nullable: false');
      }
    }
  } else if (corr.order_by) add(`${p}/correction/order_by`, `order_by is only valid with supersede_by_order`);

  const relIds = new Set<string>();
  for (const [i, r] of (e.relationships ?? []).entries()) {
    const rp = `${p}/relationships/${i}`;
    if (relIds.has(r.id)) add(`${rp}/id`, `duplicate relationship id "${r.id}"`);
    relIds.add(r.id);
    const f = e.fields[r.field];
    if (!f) { add(`${rp}/field`, `unknown field "${r.field}"`); continue; }
    const target = c.entities[r.references.entity];
    if (!target) { add(`${rp}/references/entity`, `unknown entity "${r.references.entity}"`); continue; }
    if (target.key.length !== 1 || target.key[0] !== r.references.field) add(`${rp}/references/field`, `must reference the single key field of "${r.references.entity}"`);
    const tf = target.fields[r.references.field];
    if (tf && tf.type !== f.type) add(`${rp}`, `type mismatch: ${f.type} references ${tf.type}`);
  }
  const ruleIds = new Set<string>();
  for (const [i, r] of (e.rules ?? []).entries()) {
    const rp = `${p}/rules/${i}`;
    if (ruleIds.has(r.id)) add(`${rp}/id`, `duplicate rule id "${r.id}"`);
    ruleIds.add(r.id);
    if (r.when) checkCondition(e, r.when, `${rp}/when`, add, 0);
    checkCondition(e, r.assert, `${rp}/assert`, add, 0);
  }
}

function checkField(p: string, f: FieldDef, add: (p: string, m: string) => void) {
  if (f.type === 'decimal') {
    if (f.precision === undefined || f.scale === undefined) add(p, 'decimal fields require precision and scale');
    else if (f.scale > f.precision) add(p, 'scale cannot exceed precision');
  } else if (f.precision !== undefined || f.scale !== undefined) add(p, 'precision/scale apply only to decimal fields');
  if (f.type === 'enum' && !f.values) add(p, 'enum fields require values');
  if (f.type !== 'enum' && f.values) add(p, 'values apply only to enum fields');
  if (f.max_length !== undefined && f.type !== 'string') add(p, 'max_length applies only to string fields');
  if (f.format !== undefined && f.type !== 'string') add(p, 'format applies only to string fields');
  for (const b of ['min', 'max'] as const) {
    const v = f[b];
    if (v === undefined) continue;
    if (NUMERIC.has(f.type)) { if (typeof v !== 'number') add(`${p}/${b}`, `${b} must be a number`); }
    else if (f.type === 'date' || f.type === 'timestamp') {
      if (typeof v !== 'string' || !parseCanonical({ type: f.type }, v).ok) add(`${p}/${b}`, `${b} must be an ISO ${f.type}`);
    } else add(`${p}/${b}`, `${b} is not supported for ${f.type} fields`);
  }
  if (f.required === false && f.nullable === false) add(p, 'an optional field cannot be non-nullable');
}

function checkCondition(e: EntityDef, cond: Condition, p: string, add: (p: string, m: string) => void, depth: number) {
  if (depth > MAX_CONDITION_DEPTH) { add(p, `conditions nest deeper than ${MAX_CONDITION_DEPTH}`); return; }
  if ('all' in cond) { cond.all.forEach((c, i) => checkCondition(e, c, `${p}/all/${i}`, add, depth + 1)); return; }
  if ('any' in cond) { cond.any.forEach((c, i) => checkCondition(e, c, `${p}/any/${i}`, add, depth + 1)); return; }
  if ('not' in cond) { checkCondition(e, cond.not, `${p}/not`, add, depth + 1); return; }
  const f = e.fields[cond.field];
  if (!f) { add(`${p}/field`, `unknown field "${cond.field}"`); return; }
  const ordered = (op: string) => ['lt', 'lte', 'gt', 'gte'].includes(op);
  if ('other_field' in cond) {
    const o = e.fields[cond.other_field];
    if (!o) { add(`${p}/other_field`, `unknown field "${cond.other_field}"`); return; }
    if (cond.op === 'within_days_of') {
      if (f.type !== 'date' || o.type !== 'date') add(p, 'within_days_of compares two date fields');
    } else {
      const compatible = f.type === o.type || (NUMERIC.has(f.type) && NUMERIC.has(o.type));
      if (!compatible) add(p, `cannot compare ${f.type} with ${o.type}`);
      if (ordered(cond.op) && !ORDERED.has(f.type)) add(p, `operator ${cond.op} is not valid for ${f.type}`);
    }
    return;
  }
  if ('value' in cond) {
    if (ordered(cond.op) && !ORDERED.has(f.type)) add(p, `operator ${cond.op} is not valid for ${f.type}`);
    const r = parseCanonical(f, cond.value);
    if (!r.ok) add(`${p}/value`, `literal is not a valid ${f.type}: ${r.error}`);
    return;
  }
  if ('values' in cond) {
    for (const v of cond.values) { const r = parseCanonical(f, v); if (!r.ok) add(`${p}/values`, `"${v}" is not a valid ${f.type}: ${r.error}`); }
    return;
  }
  if (cond.op === 'not_after_arrival' && f.type !== 'date' && f.type !== 'timestamp') add(p, 'not_after_arrival requires a date or timestamp field');
}
