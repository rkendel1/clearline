// Canonical value representation and type coercion.
// Canonical JS representations (stable, so record hashes are deterministic):
//   string/enum -> string, integer -> number (safe range), decimal -> fixed-scale string ("12.50"),
//   date -> "YYYY-MM-DD", timestamp -> ISO-8601 UTC "YYYY-MM-DDTHH:mm:ss.sssZ", boolean -> boolean.

import { NAMED_FORMATS, type FieldDef, type FieldType } from '../contracts/types.js';

export type Canonical = string | number | boolean | null;
export type ParseResult = { ok: true; value: Canonical } | { ok: false; error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1800 || y > 2200) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

export function normalizeDecimal(raw: string, scale: number, precision?: number): ParseResult {
  const m = DECIMAL_RE.exec(raw.trim());
  if (!m) return { ok: false, error: 'not a decimal number' };
  const [, sign, intPartRaw, fracRaw = ''] = m;
  if (fracRaw.length > scale && /[1-9]/.test(fracRaw.slice(scale))) return { ok: false, error: `more than ${scale} decimal places` };
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '');
  if (precision !== undefined && intPart.length > precision - scale) return { ok: false, error: `exceeds precision ${precision},${scale}` };
  const frac = fracRaw.slice(0, scale).padEnd(scale, '0');
  const isZero = /^0+$/.test(intPart) && !/[1-9]/.test(frac);
  return { ok: true, value: `${sign === '-' && !isZero ? '-' : ''}${intPart}${scale > 0 ? '.' + frac : ''}` };
}

/** Parse a value already in canonical textual form (what parse_* transforms emit, or ISO input). */
export function parseCanonical(f: Pick<FieldDef, 'type'> & Partial<FieldDef>, v: unknown): ParseResult {
  if (v === null || v === undefined) return { ok: true, value: null };
  const t: FieldType = f.type;
  switch (t) {
    case 'string':
      if (typeof v !== 'string') return typeof v === 'number' ? { ok: true, value: String(v) } : { ok: false, error: 'expected text' };
      return { ok: true, value: v };
    case 'enum':
      if (typeof v !== 'string') return { ok: false, error: 'expected text' };
      if (f.values && !f.values.includes(v)) return { ok: false, error: `not one of [${f.values.join(', ')}]` };
      return { ok: true, value: v };
    case 'integer': {
      const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
      if (!/^[+-]?\d+$/.test(s)) return { ok: false, error: 'not an integer' };
      const n = Number(s);
      if (!Number.isSafeInteger(n)) return { ok: false, error: 'integer out of range' };
      return { ok: true, value: n };
    }
    case 'decimal': {
      const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
      if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, error: 'not a finite number' };
      return normalizeDecimal(s, f.scale ?? 2, f.precision);
    }
    case 'date': {
      if (typeof v !== 'string') return { ok: false, error: 'expected YYYY-MM-DD' };
      const m = DATE_RE.exec(v);
      if (!m || !isValidDate(+m[1], +m[2], +m[3])) return { ok: false, error: 'not a valid calendar date (YYYY-MM-DD)' };
      return { ok: true, value: v };
    }
    case 'timestamp': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return { ok: false, error: 'expected ISO-8601 timestamp with zone' };
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'invalid timestamp' };
      return { ok: true, value: d.toISOString() };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (v === 'true') return { ok: true, value: true };
      if (v === 'false') return { ok: true, value: false };
      return { ok: false, error: 'expected true/false' };
  }
}

/** Field-level constraints beyond type: max_length, format, min/max. Returns an error message or null. */
export function checkConstraints(f: FieldDef, v: Canonical): string | null {
  if (v === null) return null;
  if (typeof v === 'string' && f.max_length !== undefined && v.length > f.max_length) return `longer than ${f.max_length} characters`;
  if (typeof v === 'string' && f.format && !NAMED_FORMATS[f.format].test(v)) return `does not match format ${f.format}`;
  if (f.min !== undefined && compareCanonical(f.type, v, f.type === 'decimal' ? String(f.min) : f.min) < 0) return `below minimum ${f.min}`;
  if (f.max !== undefined && compareCanonical(f.type, v, f.type === 'decimal' ? String(f.max) : f.max) > 0) return `above maximum ${f.max}`;
  return null;
}

function decimalCompare(a: string, b: string): number {
  // exact comparison of decimal strings via scaled BigInt
  const split = (s: string) => { const neg = s.startsWith('-'); const [i, fr = ''] = s.replace(/^[+-]/, '').split('.'); return { neg, i, fr }; };
  const A = split(a), B = split(b);
  const scale = Math.max(A.fr.length, B.fr.length);
  const big = (x: { neg: boolean; i: string; fr: string }) => BigInt((x.neg ? '-' : '') + x.i + x.fr.padEnd(scale, '0'));
  const da = big(A), db = big(B);
  return da < db ? -1 : da > db ? 1 : 0;
}

/** Total order for canonical values of the same field type. */
export function compareCanonical(t: FieldType, a: Canonical, b: Canonical | number | string): number {
  if (t === 'decimal') return decimalCompare(String(a), String(b));
  if (t === 'integer') return Number(a) - Number(b);
  if (t === 'timestamp') return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0; // dates (ISO) and strings
}

/** Exact decimal addition on canonical strings, used for financial totals. */
export function addDecimal(a: string, b: string): string {
  const scale = Math.max((a.split('.')[1] ?? '').length, (b.split('.')[1] ?? '').length);
  const toBig = (s: string) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace(/^[+-]/, '').split('.'); return BigInt((neg ? '-' : '') + i + f.padEnd(scale, '0')); };
  return fromScaled(toBig(a) + toBig(b), scale);
}

export function subDecimal(a: string, b: string): string {
  return addDecimal(a, b.startsWith('-') ? b.slice(1) : '-' + b);
}

function fromScaled(n: bigint, scale: number): string {
  const neg = n < 0n; let s = (neg ? -n : n).toString();
  if (scale === 0) return (neg ? '-' : '') + s;
  s = s.padStart(scale + 1, '0');
  const out = `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return (neg && /[1-9]/.test(out) ? '-' : '') + out;
}
