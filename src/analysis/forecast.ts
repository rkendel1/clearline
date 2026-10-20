// Forecasting baselines for small operational series, evaluated by rolling-origin backtesting.
//
//   forecast.naive           y(T+h) = y(T)
//   forecast.seasonal_naive  y(T+h) = y(T+h-P*ceil(h/P))                 (needs period P, >= 2P history)
//   forecast.drift           y(T+h) = y(T) + h*(y(T)-y(1))/(T-1)         (random walk with drift)
//   forecast.holt_linear     Holt's linear-trend exponential smoothing; alpha, beta chosen on a fixed
//                            grid by in-sample one-step squared error of the training data only
//   forecast.auto            the candidate with the lowest backtest MAE (ties: simplest first)
//
// Backtesting: for each origin o (the last `backtest_origins` positions that leave a full horizon),
// the method is fitted on y[0..o) only and forecasts y[o..o+h). No observation at or after the
// origin is used to fit or tune, so the errors are honest out-of-sample errors.
//
// Prediction intervals are empirical: for horizon step h, the quantile of |error| at that step over
// the backtest origins. They are only reported when at least 5 origins exist, and their coverage is
// measured on the same backtest (so it is not an independent out-of-sample coverage estimate).

import type { ForecastConfig } from './types.js';
import { AnalysisError } from './types.js';
import { mean, quantile, round } from './stats.js';
import { nextPeriods } from './features.js';

type Method = 'forecast.naive' | 'forecast.seasonal_naive' | 'forecast.drift' | 'forecast.holt_linear';
const SIMPLICITY: Method[] = ['forecast.naive', 'forecast.seasonal_naive', 'forecast.drift', 'forecast.holt_linear'];

function holtFit(y: number[]): { level: number; trend: number; alpha: number; beta: number } {
  const grid = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  let best = { sse: Infinity, level: y[y.length - 1], trend: 0, alpha: 0.5, beta: 0.1 };
  for (const a of grid) for (const b of grid) {
    let l = y[0];
    let t = y[1] - y[0];
    let sse = 0;
    for (let i = 1; i < y.length; i++) {
      const f = l + t;
      sse += (y[i] - f) ** 2;
      const nl = a * y[i] + (1 - a) * (l + t);
      t = b * (nl - l) + (1 - b) * t;
      l = nl;
    }
    // Strict < keeps the first (smallest) parameters on ties: deterministic.
    if (sse < best.sse) best = { sse, level: l, trend: t, alpha: a, beta: b };
  }
  return { level: best.level, trend: best.trend, alpha: best.alpha, beta: best.beta };
}

/** Forecast h steps from training data y with the given method (no access to later data). */
export function predict(method: Method, y: number[], h: number, period: number | null): { values: number[]; params?: Record<string, number> } {
  const T = y.length;
  switch (method) {
    case 'forecast.naive': return { values: Array.from({ length: h }, () => y[T - 1]) };
    case 'forecast.seasonal_naive': {
      const P = period!;
      return { values: Array.from({ length: h }, (_, i) => y[T - P * Math.ceil((i + 1) / P) + i]) };
    }
    case 'forecast.drift': {
      const slope = T > 1 ? (y[T - 1] - y[0]) / (T - 1) : 0;
      return { values: Array.from({ length: h }, (_, i) => y[T - 1] + (i + 1) * slope), params: { slope } };
    }
    case 'forecast.holt_linear': {
      const f = holtFit(y);
      return { values: Array.from({ length: h }, (_, i) => f.level + (i + 1) * f.trend), params: { alpha: f.alpha, beta: f.beta, level: f.level, trend: f.trend } };
    }
  }
}

function minTrain(method: Method, period: number | null): number {
  if (method === 'forecast.seasonal_naive') return 2 * period!;
  if (method === 'forecast.holt_linear') return 6;
  return 2;
}

export interface Backtest {
  method: Method; origins: number; mae: number; rmse: number; mape: number | null; mase: number | null;
  /** errors[o][h]: actual - forecast at origin o, step h. */
  errors: number[][];
}

export function backtest(method: Method, y: number[], cfg: Pick<ForecastConfig, 'horizon' | 'backtest_origins' | 'period'>): Backtest | null {
  const h = cfg.horizon;
  const lastOrigin = y.length - h;
  const firstOrigin = Math.max(minTrain(method, cfg.period), lastOrigin - cfg.backtest_origins + 1);
  if (lastOrigin < firstOrigin) return null;
  const errors: number[][] = [];
  const abs: number[] = [];
  const pct: number[] = [];
  for (let o = firstOrigin; o <= lastOrigin; o++) {
    const train = y.slice(0, o);
    const f = predict(method, train, h, cfg.period).values;
    const e = f.map((v, i) => y[o + i] - v);
    errors.push(e);
    e.forEach((x, i) => { abs.push(Math.abs(x)); if (y[o + i] !== 0) pct.push(Math.abs(x / y[o + i])); });
  }
  // MASE scale: in-sample one-step naive error on data before the first origin only.
  const pre = y.slice(0, firstOrigin);
  const naiveErr = pre.slice(1).map((v, i) => Math.abs(v - pre[i]));
  const scale = naiveErr.length ? mean(naiveErr) : 0;
  const mae = mean(abs);
  return {
    method, origins: errors.length, mae, rmse: Math.sqrt(mean(abs.map((a) => a * a))),
    mape: pct.length === abs.length && pct.length ? mean(pct) * 100 : null, mase: scale > 0 ? mae / scale : null, errors,
  };
}

export interface ForecastOutput {
  method: Method; params: Record<string, number> | null;
  training: { from: string; to: string; observations: number };
  forecast: { t: string; value: number; lower: number | null; upper: number | null }[];
  backtest: Omit<Backtest, 'errors'> & { interval_coverage: number | null; candidates: { method: Method; mae: number; origins: number }[] };
  history: { t: string; value: number }[];
  interval: number | null;
}

export function forecast(cfg: ForecastConfig, t: string[], yIn: (number | null)[]): ForecastOutput {
  // Leading/trailing gaps cannot be interpolated; trim them, refuse interior gaps (missing: 'skip').
  let a = 0; let b = yIn.length - 1;
  while (a <= b && yIn[a] === null) a++;
  while (b >= a && yIn[b] === null) b--;
  const ys = yIn.slice(a, b + 1);
  if (ys.some((v) => v === null)) throw new AnalysisError('unsupported_input', `The series has ${ys.filter((v) => v === null).length} missing periods; forecasting needs a regular series (use missing: "interpolate" or "zero").`);
  const y = ys as number[];
  const tt = t.slice(a, b + 1);
  const need = Math.max(cfg.min_history, cfg.period && (cfg.algorithm === 'forecast.seasonal_naive') ? 2 * cfg.period : 0, cfg.horizon + 3);
  if (y.length < need) throw new AnalysisError('insufficient_data', `${y.length} observations; this forecast needs at least ${need} (min_history ${cfg.min_history}, horizon ${cfg.horizon}${cfg.period ? `, period ${cfg.period}` : ''}).`);

  const candidates: Method[] = cfg.algorithm === 'forecast.auto'
    ? SIMPLICITY.filter((m) => m !== 'forecast.seasonal_naive' || (cfg.period && y.length >= 2 * cfg.period + cfg.horizon))
    : [cfg.algorithm as Method];
  const tested = candidates.map((m) => backtest(m, y, cfg)).filter((x): x is Backtest => x !== null);
  if (!tested.length) throw new AnalysisError('insufficient_data', `Not enough history to backtest a ${cfg.horizon}-step forecast; at least one origin with a full horizon is required.`);
  // Lowest MAE; ties resolved by the simplicity order above (stable sort).
  const chosen = [...tested].sort((p, q) => p.mae - q.mae)[0];
  const fit = predict(chosen.method, y, cfg.horizon, cfg.period);
  const future = nextPeriods(tt[tt.length - 1], cfg.grain, cfg.horizon);

  let coverage: number | null = null;
  let widths: number[] | null = null;
  if (chosen.origins >= 5) {
    widths = Array.from({ length: cfg.horizon }, (_, h) => quantile(chosen.errors.map((e) => Math.abs(e[h])), cfg.interval));
    let inside = 0; let total = 0;
    for (const e of chosen.errors) e.forEach((x, h) => { total++; if (Math.abs(x) <= widths![h]) inside++; });
    coverage = total ? inside / total : null;
  }
  const { errors: _e, ...bt } = chosen;
  return {
    method: chosen.method, params: fit.params ? Object.fromEntries(Object.entries(fit.params).map(([k, v]) => [k, round(v)])) : null,
    training: { from: tt[0], to: tt[tt.length - 1], observations: y.length },
    forecast: fit.values.map((v, i) => ({ t: future[i], value: round(v), lower: widths ? round(v - widths[i]) : null, upper: widths ? round(v + widths[i]) : null })),
    backtest: { ...bt, mae: round(bt.mae), rmse: round(bt.rmse), mape: bt.mape === null ? null : round(bt.mape, 2), mase: bt.mase === null ? null : round(bt.mase, 3),
      interval_coverage: coverage === null ? null : round(coverage, 3), candidates: tested.map((c) => ({ method: c.method, mae: round(c.mae), origins: c.origins })) },
    history: tt.map((x, i) => ({ t: x, value: round(y[i]) })),
    interval: widths ? cfg.interval : null,
  };
}
