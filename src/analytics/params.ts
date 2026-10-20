// Saved-query parameters: declarations stored on each version, values validated and converted
// before execution. Values are bound by the PostgreSQL driver as typed $n parameters
// (src/query/validate.ts rewrites :name); they are never interpolated into SQL text.
//
// A declaration: { name, type, label?, required?, default?, min?, max?, allowed?, max_length? }.
// Date and timestamp defaults may be relative to the run: { relative_days: -180 } or
// { relative_months: -1, start_of: "month" }, resolved in the schedule's time zone at the
// scheduled occurrence (or now, in UTC, for a manual run).

import { badRequest } from '../platform/errors.js';
import type { ParamDecl, ParamType } from '../query/validate.js';
import { localParts } from './recurrence.js';

export interface ParamDeclaration extends ParamDecl {
  label?: string;
  required: boolean;
  default?: unknown;
  min?: number | string;
  max?: number | string;
  allowed?: (string | number)[];
  max_length?: number;
}

const TYPES: ParamType[] = ['integer', 'decimal', 'date', 'timestamp', 'text', 'boolean'];
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PARAMS = 20;

export interface ParamIssue { name: string; message: string }

const isRelative = (v: unknown): v is { relative_days?: number; relative_months?: number; start_of?: 'month' | 'week' } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && ('relative_days' in v || 'relative_months' in v);

/** Validate declarations (shape, names, types, bounds, defaults). */
export function normalizeDeclarations(raw: unknown): { decls: ParamDeclaration[]; issues: ParamIssue[] } {
  const issues: ParamIssue[] = [];
  if (raw === undefined || raw === null) return { decls: [], issues };
  if (!Array.isArray(raw)) return { decls: [], issues: [{ name: '', message: 'parameters must be an array.' }] };
  if (raw.length > MAX_PARAMS) issues.push({ name: '', message: `At most ${MAX_PARAMS} parameters.` });
  const decls: ParamDeclaration[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const name = typeof r?.name === 'string' ? r.name : '';
    if (!NAME.test(name)) { issues.push({ name, message: 'Parameter names are lowercase letters, digits and _ (starting with a letter).' }); continue; }
    if (seen.has(name)) { issues.push({ name, message: 'Duplicate parameter name.' }); continue; }
    seen.add(name);
    const type = r.type as ParamType;
    if (!TYPES.includes(type)) { issues.push({ name, message: `type must be one of ${TYPES.join(', ')}.` }); continue; }
    const d: ParamDeclaration = { name, type, required: r.required !== false };
    if (typeof r.label === 'string') d.label = r.label.slice(0, 120);
    if (r.min !== undefined) d.min = r.min as number | string;
    if (r.max !== undefined) d.max = r.max as number | string;
    if (Array.isArray(r.allowed)) d.allowed = (r.allowed as unknown[]).filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').slice(0, 100);
    if (type === 'text') d.max_length = Number.isInteger(r.max_length) && (r.max_length as number) > 0 && (r.max_length as number) <= 1000 ? (r.max_length as number) : 200;
    if (r.default !== undefined) {
      if (isRelative(r.default)) {
        if (type !== 'date' && type !== 'timestamp') issues.push({ name, message: 'Relative defaults apply to date and timestamp parameters only.' });
        d.default = r.default;
      } else {
        const v = convert(d, r.default);
        if ('error' in v) issues.push({ name, message: `default: ${v.error}` }); else d.default = r.default;
      }
    }
    for (const k of ['min', 'max'] as const) if (d[k] !== undefined && (type === 'text' || type === 'boolean' || 'error' in convert({ ...d, min: undefined, max: undefined, allowed: undefined }, d[k]))) {
      issues.push({ name, message: `${k} is not valid for a ${type} parameter.` });
    }
    decls.push(d);
  }
  return { decls, issues };
}

function convert(d: ParamDeclaration, v: unknown): { value: unknown } | { error: string } {
  if (v === null || v === undefined || v === '') return { error: 'a value is required' };
  let out: unknown;
  switch (d.type) {
    case 'integer': {
      const s = typeof v === 'number' ? String(v) : String(v).trim();
      if (!/^-?\d{1,18}$/.test(s)) return { error: 'expected an integer' };
      out = s; break;
    }
    case 'decimal': {
      const s = typeof v === 'number' ? String(v) : String(v).trim();
      if (!/^-?\d{1,18}(\.\d{1,10})?$/.test(s)) return { error: 'expected a decimal number' };
      out = s; break;
    }
    case 'date': {
      const s = String(v);
      if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) return { error: 'expected a date YYYY-MM-DD' };
      out = s; break;
    }
    case 'timestamp': {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) return { error: 'expected an ISO timestamp with a zone' };
      out = new Date(s).toISOString(); break;
    }
    case 'text': {
      if (typeof v !== 'string') return { error: 'expected text' };
      if (v.length > (d.max_length ?? 200)) return { error: `at most ${d.max_length ?? 200} characters` };
      if (/[\u0000]/.test(v)) return { error: 'contains a NUL character' };
      out = v; break;
    }
    case 'boolean': {
      if (typeof v === 'boolean') out = v;
      else if (v === 'true' || v === 'false') out = v === 'true';
      else return { error: 'expected true or false' };
      break;
    }
  }
  const cmp = (a: unknown, b: unknown) => (d.type === 'integer' || d.type === 'decimal' ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  if (d.min !== undefined && cmp(out, d.type === 'timestamp' ? new Date(String(d.min)).toISOString() : d.min) < 0) return { error: `must be at least ${d.min}` };
  if (d.max !== undefined && cmp(out, d.type === 'timestamp' ? new Date(String(d.max)).toISOString() : d.max) > 0) return { error: `must be at most ${d.max}` };
  if (d.allowed?.length && !d.allowed.map(String).includes(String(out))) return { error: `must be one of ${d.allowed.join(', ')}` };
  return { value: out };
}

function relativeDate(rel: { relative_days?: number; relative_months?: number; start_of?: 'month' | 'week' }, nowMs: number, tz: string, type: ParamType): string {
  const l = localParts(nowMs, tz);
  const d = new Date(Date.UTC(l.y, l.mo - 1, l.d));
  if (rel.relative_months) d.setUTCMonth(d.getUTCMonth() + rel.relative_months);
  if (rel.relative_days) d.setUTCDate(d.getUTCDate() + rel.relative_days);
  if (rel.start_of === 'month') d.setUTCDate(1);
  if (rel.start_of === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const day = d.toISOString().slice(0, 10);
  return type === 'date' ? day : `${day}T00:00:00.000Z`;
}

/**
 * Effective values for a run: provided value, else default (relative defaults resolved at `nowMs`
 * in `tz`), else an error for required parameters. Returns values in declaration order (= $n order).
 */
export function resolveValues(decls: ParamDeclaration[], provided: Record<string, unknown> | undefined, nowMs: number, tz = 'UTC'):
  { values: unknown[]; effective: Record<string, unknown> } {
  const given = provided ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw badRequest('invalid_parameters', 'parameters must be an object of name -> value.');
  const unknown = Object.keys(given).filter((k) => !decls.some((d) => d.name === k));
  if (unknown.length) throw badRequest('unknown_parameter', `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, { parameters: unknown });
  const issues: ParamIssue[] = [];
  const values: unknown[] = [];
  const effective: Record<string, unknown> = {};
  for (const d of decls) {
    let raw = given[d.name];
    if (raw === undefined || raw === null || raw === '') raw = isRelative(d.default) ? relativeDate(d.default, nowMs, tz, d.type) : d.default;
    if (raw === undefined || raw === null || raw === '') {
      if (d.required) issues.push({ name: d.name, message: 'a value is required' });
      values.push(null); effective[d.name] = null; continue;
    }
    const c = convert(d, raw);
    if ('error' in c) { issues.push({ name: d.name, message: c.error }); continue; }
    values.push(c.value); effective[d.name] = c.value;
  }
  if (issues.length) throw badRequest('invalid_parameter', issues.map((i) => `${i.name}: ${i.message}`).join('; '), { issues });
  return { values, effective };
}
