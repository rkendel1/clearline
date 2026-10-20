// ML analysis subsystem: seeded synthetic data with known structure, deterministic results,
// explicit rejection of insufficient, invalid and incompatible inputs, and grounding of
// optional model summaries in computed evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, runAnalysis, type AnalysisConfig, type InputColumn, type Limits } from '../../src/analysis/index.js';
import { buildInsights } from '../../src/analysis/insights.js';
import { groundingCheck, narrateInsight, type Narrator } from '../../src/analysis/narrate.js';
import { backtest } from '../../src/analysis/forecast.js';
import { prng } from '../../src/analysis/stats.js';
import { bindNamedParameters } from '../../src/query/validate.js';

const LIMITS: Limits = { maxRows: 50_000, maxFeatures: 20, maxPoints: 5000, maxHorizon: 104, timeoutMs: 10_000, maxMemoryMb: 256 };
const col = (name: string, type: string, extra: Partial<InputColumn> = {}): InputColumn => ({ name, type, masked: null, sensitive: false, ...extra });
function cfg(raw: Record<string, unknown>): AnalysisConfig {
  const n = normalizeConfig(raw, LIMITS);
  assert.deepEqual(n.issues, []);
  return n.config!;
}
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** 180 days of claims-like data: weekly seasonality (weekends low), noise, one seeded spike. */
function dailySeries(spikeAt: number | null, spikeFactor = 1.4) {
  const r = prng(7);
  return Array.from({ length: 180 }, (_, i) => {
    const weekday = (new Date(day(i)).getUTCDay() + 6) % 7;
    const base = weekday >= 5 ? 4000 : 10000;
    let v = base * (1 + (r() - 0.5) * 0.08);
    if (i === spikeAt) v *= spikeFactor;
    return [day(i), v.toFixed(2), String(Math.round(v / 250))];
  });
}
const DAILY_COLS = [col('day', 'date'), col('paid', 'decimal'), col('claims', 'integer')];

test('anomaly: a seeded spike is detected, with baseline, range, score and a grounded explanation', () => {
  const c = cfg({ type: 'anomaly', key: 'daily', algorithm: 'anomaly.rolling_mad', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 });
  const o = runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(150), truncated: false }, LIMITS);
  assert.equal(o.status, 'succeeded', o.message ?? '');
  const alerts = (o.result as any).alerts;
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0].t, day(150));
  assert.equal(alerts[0].direction, 'above');
  assert.ok(alerts[0].deviation_pct > 30 && alerts[0].deviation_pct < 50, String(alerts[0].deviation_pct));
  assert.ok(alerts[0].observed > alerts[0].upper);
  const [ins] = buildInsights(c, o);
  assert.equal(ins.kind, 'anomaly');
  assert.match(ins.title, /above its expected range/);
  // The insight's figures are the computed ones.
  assert.ok(ins.body.includes(alerts[0].observed.toLocaleString('en-US', { maximumFractionDigits: 2 })), ins.body);
  assert.equal(groundingCheck(ins.body.replace(/Method: .*$/, ''), ins.evidence).ok, true, groundingCheck(ins.body, ins.evidence).reason ?? '');
});

test('anomaly: ordinary weekly fluctuation is not flagged when seasonality is modelled; it is without it', () => {
  const rows = dailySeries(null);
  const seasonal = runAnalysis(cfg({ type: 'anomaly', key: 's', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 }), { columns: DAILY_COLS, rows, truncated: false }, LIMITS);
  assert.equal((seasonal.result as any).alerts.length, 0);
  const naive = runAnalysis(cfg({ type: 'anomaly', key: 'n', time_column: 'day', metrics: ['paid'], grain: 'day', window: 14 }), { columns: DAILY_COLS, rows, truncated: false }, LIMITS);
  assert.ok((naive.result as any).alerts.length > 0, 'without the weekly period, weekend dips look anomalous (documented limitation)');
});

test('anomaly: seasonal decomposition is a separate algorithm and also finds the spike', () => {
  const c = cfg({ type: 'anomaly', key: 'd', algorithm: 'anomaly.seasonal_decomposition', time_column: 'day', metrics: ['paid', 'claims'], grain: 'day', period: 7 });
  const o = runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(90), truncated: false }, LIMITS);
  assert.equal(o.status, 'succeeded', o.message ?? '');
  assert.equal(o.algorithm, 'anomaly.seasonal_decomposition');
  const paid = (o.result as any).metrics[0].anomalies;
  assert.deepEqual(paid.map((a: any) => a.t), [day(90)]);
});

test('anomaly: insufficient history, missing periods and duplicate periods are explicit outcomes', () => {
  const c = cfg({ type: 'anomaly', key: 'x', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 });
  assert.equal(runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(null).slice(0, 10), truncated: false }, LIMITS).status, 'insufficient_data');
  const dup = [...dailySeries(null).slice(0, 60), dailySeries(null)[5]];
  const d = runAnalysis(c, { columns: DAILY_COLS, rows: dup, truncated: false }, LIMITS);
  assert.equal(d.status, 'unsupported_input');
  assert.match(d.message!, /More than one row/);
  const dec = cfg({ type: 'anomaly', key: 'y', algorithm: 'anomaly.seasonal_decomposition', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 });
  const gaps = dailySeries(null).filter((_, i) => i % 10 !== 3);
  assert.equal(runAnalysis(dec, { columns: DAILY_COLS, rows: gaps, truncated: false }, LIMITS).status, 'unsupported_input');
  assert.equal(runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(null), truncated: true }, LIMITS).status, 'unsupported_input');
});

test('forecast: a known trend is forecast within tolerance of held-out observations, evaluated without leakage', () => {
  const r = prng(11);
  const weeks = Array.from({ length: 60 }, (_, i) => [day(4 + i * 7), (20000 + 350 * i + (r() - 0.5) * 600).toFixed(2)]);
  const train = weeks.slice(0, 52); const held = weeks.slice(52);
  const c = cfg({ type: 'forecast', key: 'weekly', time_column: 'week', metric: 'paid', grain: 'week', horizon: 8, algorithm: 'forecast.auto' });
  const o = runAnalysis(c, { columns: [col('week', 'date'), col('paid', 'decimal')], rows: train, truncated: false }, LIMITS);
  assert.equal(o.status, 'succeeded', o.message ?? '');
  const f = o.result as any;
  assert.ok(['forecast.drift', 'forecast.holt_linear'].includes(f.method), f.method);
  assert.equal(f.forecast.length, 8);
  assert.equal(f.forecast[0].t, held[0][0]);
  const mae = f.forecast.reduce((a: number, p: any, i: number) => a + Math.abs(p.value - Number(held[i][1])), 0) / 8;
  assert.ok(mae < 800, `held-out MAE ${mae}`);
  assert.ok(f.backtest.origins >= 5 && f.backtest.mae > 0);
  assert.ok(f.forecast.every((p: any) => p.lower < p.value && p.value < p.upper), 'empirical intervals present');
  // Naive is measurably worse on a trend, and the backtest says so.
  const naive = f.backtest.candidates.find((x: any) => x.method === 'forecast.naive');
  assert.ok(naive.mae > f.backtest.mae);
  const [ins] = buildInsights(c, o);
  assert.match(ins.body, /Backtest over \d+ rolling origins: MAE/);
});

test('forecast: backtest errors at an origin do not depend on later observations', () => {
  const y = Array.from({ length: 40 }, (_, i) => 100 + i * 2 + (i % 3));
  const y2 = [...y]; y2[39] = 10_000;
  const a = backtest('forecast.holt_linear', y, { horizon: 4, backtest_origins: 8, period: null })!;
  const b = backtest('forecast.holt_linear', y2, { horizon: 4, backtest_origins: 8, period: null })!;
  // Every origin's forecast was fitted only on data before it, so only errors measured AT index 39 differ.
  for (let o = 0; o < a.errors.length; o++) for (let h = 0; h < 4; h++) {
    const idx = 40 - 4 - (a.errors.length - 1) + o + h;
    if (idx !== 39) assert.equal(a.errors[o][h], b.errors[o][h]);
  }
});

test('forecast: seasonal series selects seasonal-naive; short history is refused, not extrapolated', () => {
  const pattern = [100, 140, 90, 200];
  const rows = Array.from({ length: 32 }, (_, i) => [day(4 + i * 7), String(pattern[i % 4] + i)]);
  const o = runAnalysis(cfg({ type: 'forecast', key: 's', time_column: 'w', metric: 'v', grain: 'week', horizon: 4, period: 4 }), { columns: [col('w', 'date'), col('v', 'integer')], rows, truncated: false }, LIMITS);
  assert.equal((o.result as any).method, 'forecast.seasonal_naive');
  const short = runAnalysis(cfg({ type: 'forecast', key: 't', time_column: 'w', metric: 'v', grain: 'week', horizon: 8 }), { columns: [col('w', 'date'), col('v', 'integer')], rows: rows.slice(0, 9), truncated: false }, LIMITS);
  assert.equal(short.status, 'insufficient_data');
  assert.equal(buildInsights(cfg({ type: 'forecast', key: 't', time_column: 'w', metric: 'v', grain: 'week', horizon: 8 }), short)[0].kind, 'status');
});

test('outliers: seeded unusual claims rank first, with contributing features', () => {
  const r = prng(3);
  const rows: unknown[][] = Array.from({ length: 300 }, (_, i) => [`C${String(i).padStart(4, '0')}`, (1000 + (r() - 0.5) * 300).toFixed(2), String(5 + Math.floor(r() * 4)), String(Math.floor(r() * 2))]);
  rows[17][1] = '9800.00';             // amount
  rows[120][2] = '60';                 // processing days
  rows[250][3] = '9';                  // corrections
  const c = cfg({ type: 'outlier', key: 'o', id_column: 'claim_id', features: ['amount', 'days', 'corrections'], threshold: 3.5 });
  const o = runAnalysis(c, { columns: [col('claim_id', 'string'), col('amount', 'decimal'), col('days', 'integer'), col('corrections', 'integer')], rows, truncated: false }, LIMITS);
  assert.equal(o.status, 'succeeded', o.message ?? '');
  const res = o.result as any;
  assert.deepEqual(res.records.slice(0, 3).map((x: any) => x.id).sort(), ['C0017', 'C0120', 'C0250']);
  assert.equal(res.records.find((x: any) => x.id === 'C0017').contributions[0].feature, 'amount');
  assert.equal(res.records.find((x: any) => x.id === 'C0120').contributions[0].feature, 'days');
  assert.equal(runAnalysis(c, { columns: [col('claim_id', 'string'), col('amount', 'decimal'), col('days', 'integer'), col('corrections', 'integer')], rows: rows.slice(0, 12), truncated: false }, LIMITS).status, 'insufficient_data');
});

function blobs(order = 0) {
  const r = prng(5);
  const centers = [[10, 0.05, 30], [60, 0.20, 90], [120, 0.02, 15]];
  const rows: unknown[][] = [];
  centers.forEach((c, g) => { for (let i = 0; i < 30; i++) rows.push([`B${g}-${i}`, (c[0] + (r() - 0.5) * 6).toFixed(2), (c[1] + (r() - 0.5) * 0.02).toFixed(4), (c[2] + (r() - 0.5) * 8).toFixed(1)]); });
  if (order) rows.reverse();
  return rows;
}
const BLOB_COLS = [col('batch', 'string'), col('volume', 'decimal'), col('exception_rate', 'decimal'), col('minutes', 'decimal')];

test('clustering: known structure is recovered, deterministically, independent of row order', () => {
  const c = cfg({ type: 'cluster', key: 'seg', id_column: 'batch', features: ['volume', 'exception_rate', 'minutes'], k: 3, seed: 42 });
  const a = runAnalysis(c, { columns: BLOB_COLS, rows: blobs(), truncated: false }, LIMITS);
  assert.equal(a.status, 'succeeded', a.message ?? '');
  const res = a.result as any;
  // Purity: every generated blob maps to exactly one cluster.
  for (const g of [0, 1, 2]) assert.equal(new Set(res.assignments.filter((x: any) => x.id.startsWith(`B${g}-`)).map((x: any) => x.cluster)).size, 1);
  assert.deepEqual(res.clusters.map((x: any) => x.size), [30, 30, 30]);
  assert.ok(res.silhouette > 0.7, String(res.silhouette));
  assert.ok(res.clusters.every((x: any) => /unnamed/.test(x.label)));
  const b = runAnalysis(c, { columns: BLOB_COLS, rows: blobs(1), truncated: false }, LIMITS);
  // Same rows in a different order: same clusters (only the input row positions differ).
  const strip = (x: any) => ({ ...x, assignments: x.assignments.map(({ row: _r, ...rest }: any) => rest) });
  assert.deepEqual(strip(b.result), strip(a.result), 'same rows in a different order give the same clusters');
  assert.deepEqual(runAnalysis(c, { columns: BLOB_COLS, rows: blobs(), truncated: false }, LIMITS).result, a.result);
});

test('clustering: incompatible or insufficient datasets are rejected rather than clustered', () => {
  const rows = blobs().map((r) => [r[0], r[1], '0.1', r[3]]);
  const c = cfg({ type: 'cluster', key: 'seg', id_column: 'batch', features: ['volume', 'exception_rate', 'minutes'], k: 3 });
  assert.equal(runAnalysis(c, { columns: BLOB_COLS, rows, truncated: false }, LIMITS).status, 'unsupported_input');
  const big = cfg({ type: 'cluster', key: 'seg', features: ['volume', 'minutes'], k: 12, min_per_cluster: 10 });
  assert.equal(runAnalysis(big, { columns: BLOB_COLS, rows: blobs(), truncated: false }, LIMITS).status, 'insufficient_data');
  const one = normalizeConfig({ type: 'cluster', key: 'seg', features: ['volume'], k: 3 }, LIMITS);
  assert.equal(one.config, null);
  assert.match(one.issues[0].message, /at least two numeric features/);
});

test('configuration: redacted, sensitive, non-numeric and missing columns are refused; schema drift is stale', () => {
  const c = cfg({ type: 'outlier', key: 'o', features: ['amount'] });
  const run = (cols: InputColumn[]) => runAnalysis(c, { columns: cols, rows: [], truncated: false }, LIMITS);
  assert.equal(run([col('amount', 'string', { masked: 'full' })]).status, 'invalid_configuration', 'redacted (arrives as text): an access issue, not drift');
  assert.equal(run([col('amount', 'string')]).status, 'stale_schema');
  const masked = run([col('amount', 'decimal', { masked: 'last4' })]);
  assert.equal(masked.status, 'invalid_configuration');
  assert.match(masked.message!, /redacted/);
  const sensitive = run([col('amount', 'decimal', { sensitive: true })]);
  assert.equal(sensitive.status, 'invalid_configuration');
  assert.match(sensitive.message!, /sensitive/);
  assert.equal(run([col('other', 'decimal')]).status, 'stale_schema');
  assert.ok(normalizeConfig({ type: 'forecast', key: 'f', time_column: 't', metric: 'v', horizon: 1000 }, LIMITS).issues.some((i) => i.field === 'horizon'));
  assert.ok(normalizeConfig({ type: 'nope', key: 'f' }, LIMITS).issues.length);
});

test('model summaries cannot override computed metrics: ungrounded numbers and causal claims are rejected', async () => {
  const c = cfg({ type: 'anomaly', key: 'daily', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 });
  const o = runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(150), truncated: false }, LIMITS);
  const [ins] = buildInsights(c, o);
  const before = JSON.stringify(ins);
  const a = ins.evidence as any;
  const liar: Narrator = { id: 'test', model: 'fake', narrate: async () => `Paid claims were ${(a.observed * 3).toFixed(2)}, triple the baseline.` };
  const n1 = await narrateInsight(liar, ins);
  assert.equal(n1!.accepted, false);
  assert.equal(n1!.text, null);
  assert.match(n1!.reason!, /not in the computed evidence/);
  const blame: Narrator = { id: 'test', model: 'fake', narrate: async () => `This spike is likely fraud by a provider.` };
  assert.match((await narrateInsight(blame, ins))!.reason!, /cause, misconduct or certainty/);
  const honest: Narrator = { id: 'test', model: 'fake', narrate: async () => `${a.metric} on ${a.t} was ${a.observed.toLocaleString('en-US')} against an expected ${a.expected.toLocaleString('en-US')}.` };
  const n3 = await narrateInsight(honest, ins);
  assert.equal(n3!.accepted, true, n3!.reason ?? '');
  assert.equal(JSON.stringify(ins), before, 'the computed insight itself is never modified');
});

test('named parameters: bound positionally, never interpolated; literals, comments and casts untouched', () => {
  const names = ['start', 'min_amount'];
  const r = bindNamedParameters(`SELECT ':start' AS s, x::date FROM t -- :min_amount\nWHERE d >= :start AND a > :min_amount /* :nope */ AND "c:start" = 1 AND y = $$:start$$`, names);
  assert.ok('sql' in r);
  assert.equal((r as { sql: string }).sql, `SELECT ':start' AS s, x::date FROM t -- :min_amount\nWHERE d >= $1 AND a > $2 /* :nope */ AND "c:start" = 1 AND y = $$:start$$`);
  assert.equal((bindNamedParameters('SELECT 1 WHERE a = :missing', names) as any).code, 'unknown_parameter');
  assert.equal((bindNamedParameters('SELECT 1 WHERE a = $1', names) as any).code, 'positional_parameter');
  assert.ok('sql' in bindNamedParameters(`SELECT E'it\\'s :start' AS s`, names));
});

test('limits: a result produced after ANALYSIS_TIMEOUT_MS is discarded as algorithm_failure, never reported', () => {
  const c = cfg({ type: 'anomaly', key: 'a', time_column: 'day', metrics: ['paid'], grain: 'day', period: 7 });
  const o = runAnalysis(c, { columns: DAILY_COLS, rows: dailySeries(150), truncated: false }, { ...LIMITS, timeoutMs: -1 });
  assert.equal(o.status, 'algorithm_failure');
  assert.equal(o.result, null);
  assert.match(o.message!, /ANALYSIS_TIMEOUT_MS/);
});
