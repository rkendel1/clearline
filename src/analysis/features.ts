// Feature preparation shared by every algorithm: resolve configured columns against the
// actual result, parse values, build regular time series and numeric matrices. Inputs are
// the run identity's redacted, bounded result rows; nothing else enters the subsystem.

import { AnalysisError, type Grain, type InputColumn, type Missing } from './types.js';
import { num } from './stats.js';

export function columnIndex(columns: InputColumn[], name: string): number {
  const i = columns.findIndex((c) => c.name === name);
  if (i < 0) throw new AnalysisError('stale_schema', `Column "${name}" is not in the query output.`);
  return i;
}

/** Period start (UTC) of a date/timestamp value at the given grain, as an ISO date or date-hour string. */
export function bucket(v: unknown, grain: Grain): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  switch (grain) {
    case 'hour': return d.toISOString().slice(0, 13) + ':00:00Z';
    case 'day': return d.toISOString().slice(0, 10);
    case 'week': { // ISO week, starting Monday
      const day = (d.getUTCDay() + 6) % 7;
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
      return m.toISOString().slice(0, 10);
    }
    case 'month': return d.toISOString().slice(0, 7) + '-01';
  }
}

function step(key: string, grain: Grain): string {
  const d = new Date(grain === 'hour' ? key : `${key}T00:00:00Z`);
  if (grain === 'hour') d.setUTCHours(d.getUTCHours() + 1);
  else if (grain === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return grain === 'hour' ? d.toISOString().slice(0, 13) + ':00:00Z' : d.toISOString().slice(0, 10);
}

/** The next n period keys after `key` (forecast horizon labels). */
export function nextPeriods(key: string, grain: Grain, n: number): string[] {
  const out: string[] = [];
  let k = key;
  for (let i = 0; i < n; i++) { k = step(k, grain); out.push(k); }
  return out;
}

export interface Series {
  t: string[];
  y: (number | null)[];
  /** Periods with no row in the result (before missing-value handling). */
  missing: number;
  /** Rows dropped because the time or metric value was null or unparseable. */
  dropped: number;
}

/**
 * One value per period, gaps filled in. The query must already aggregate to the grain:
 * two rows for the same period are refused (silently summing could double count).
 */
export function timeSeries(rows: unknown[][], timeIdx: number, valueIdx: number, grain: Grain, missing: Missing, maxPoints: number): Series {
  const byKey = new Map<string, number>();
  let dropped = 0;
  for (const r of rows) {
    const k = bucket(r[timeIdx], grain);
    const v = num(r[valueIdx]);
    if (k === null || v === null) { dropped++; continue; }
    if (byKey.has(k)) throw new AnalysisError('unsupported_input', `More than one row falls in the ${grain} starting ${k}; aggregate the query to one row per ${grain}.`);
    byKey.set(k, v);
  }
  const keys = [...byKey.keys()].sort();
  if (!keys.length) return { t: [], y: [], missing: 0, dropped };
  const t: string[] = [];
  const y: (number | null)[] = [];
  let gaps = 0;
  for (let k = keys[0]; k <= keys[keys.length - 1]; k = step(k, grain)) {
    if (t.length >= maxPoints) throw new AnalysisError('unsupported_input', `The series spans more than ${maxPoints} ${grain}s (ANALYSIS_MAX_POINTS); narrow the query's time range.`);
    t.push(k);
    if (byKey.has(k)) y.push(byKey.get(k)!);
    else { gaps++; y.push(missing === 'zero' ? 0 : null); }
  }
  if (missing === 'interpolate') interpolate(y);
  return { t, y, missing: gaps, dropped };
}

/** Linear interpolation of interior gaps in place; leading/trailing gaps stay null. */
function interpolate(y: (number | null)[]) {
  let last = -1;
  for (let i = 0; i < y.length; i++) {
    if (y[i] === null) continue;
    if (last >= 0 && i - last > 1) for (let j = last + 1; j < i; j++) y[j] = y[last]! + ((y[i]! - y[last]!) * (j - last)) / (i - last);
    last = i;
  }
}

export interface Matrix {
  /** Kept rows: feature values (complete cases only). */
  x: number[][];
  /** Original row index of each kept row. */
  rowIndex: number[];
  /** Rows dropped for a missing or non-numeric feature value. */
  dropped: number;
}

export function matrix(rows: unknown[][], featureIdx: number[]): Matrix {
  const x: number[][] = [];
  const rowIndex: number[] = [];
  let dropped = 0;
  rows.forEach((r, i) => {
    const v = featureIdx.map((j) => num(r[j]));
    if (v.some((n) => n === null)) { dropped++; return; }
    x.push(v as number[]);
    rowIndex.push(i);
  });
  return { x, rowIndex, dropped };
}

/** Stable presentation value of an identifier cell. */
export const idText = (v: unknown) => (v === null || v === undefined ? null : String(v));
