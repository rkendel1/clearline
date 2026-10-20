// Time-series anomaly detection. Two separately identified algorithms:
//
// anomaly.rolling_mad (v1) — for each point, the expected value is the median of the previous
//   `window` observations (or, with a seasonal period P, the median of the previous `window`
//   observations at the same phase: t-P, t-2P, ...). The scale is pooled over the whole trailing
//   block (window x P observations): 1.4826 x MAD of each observation's leave-one-out deviation
//   from the median of the other observations at its phase, so it rests on many points rather than
//   on `window` alone and is not shrunk by the median itself. In multiplicative mode (the default
//   when every baseline value is positive) deviations are relative to the phase median, so a quiet
//   phase (weekends) and a busy one (weekdays) are each judged on their own scale. The robust
//   z-score is compared with `threshold`. Only past observations are used, so a point is judged
//   exactly as it would have been when it arrived.
//
// anomaly.seasonal_decomposition (v1) — robust additive decomposition over the whole series:
//   trend = centred moving MEDIAN of length P (P+1 for even P; a moving median, unlike the
//   classical moving average, is not dragged by the anomaly it should reveal), seasonal = per-phase
//   median of the detrended values (centred to sum to zero), residual = observed - trend - seasonal.
//   Residuals are scored with their median and 1.4826 x MAD. Retrospective: a point's trend uses
//   later observations, so recent points are less reliable than interior ones.

import type { AnomalyConfig } from './types.js';
import { AnalysisError } from './types.js';
import { median, robustScale, round } from './stats.js';

export interface AnomalyPoint { t: string; observed: number | null; expected: number | null; lower: number | null; upper: number | null; score: number | null }
export interface Anomaly {
  t: string; metric: string; observed: number; expected: number; lower: number; upper: number;
  score: number; deviation: number; deviation_pct: number | null; direction: 'above' | 'below'; severity: 'low' | 'medium' | 'high';
}
export interface MetricResult {
  metric: string; points: AnomalyPoint[]; anomalies: Anomaly[]; scored: number; observations: number;
  scale_estimators: Record<string, number>;
}

const MAX_SCORE = 1000;

function judge(cfg: AnomalyConfig, metric: string, t: string, y: number, center: number, scale: number): { point: AnomalyPoint; anomaly: Anomaly | null } {
  const k = cfg.threshold;
  const dev = y - center;
  // A constant baseline (scale 0): any deviation is unbounded; report the capped score.
  const score = scale > 0 ? dev / scale : dev === 0 ? 0 : Math.sign(dev) * MAX_SCORE;
  const capped = Math.max(-MAX_SCORE, Math.min(MAX_SCORE, score));
  const point: AnomalyPoint = { t, observed: round(y), expected: round(center), lower: round(center - k * scale), upper: round(center + k * scale), score: round(capped, 3) };
  const a = Math.abs(capped);
  const hit = a >= k && (cfg.direction === 'both' || (cfg.direction === 'up' && dev > 0) || (cfg.direction === 'down' && dev < 0));
  if (!hit) return { point, anomaly: null };
  return {
    point,
    anomaly: {
      t, metric, observed: round(y), expected: round(center), lower: round(center - k * scale), upper: round(center + k * scale), score: round(capped, 3),
      deviation: round(dev), deviation_pct: center !== 0 ? round((dev / Math.abs(center)) * 100, 1) : null, direction: dev > 0 ? 'above' : 'below',
      severity: a >= cfg.severity.high ? 'high' : a >= cfg.severity.medium ? 'medium' : 'low',
    },
  };
}

export function rollingMad(cfg: AnomalyConfig, metric: string, t: string[], y: (number | null)[]): MetricResult {
  const observations = y.filter((v) => v !== null).length;
  if (observations < cfg.min_history + 1) throw new AnalysisError('insufficient_data', `${metric}: ${observations} observations; at least ${cfg.min_history + 1} are needed (min_history ${cfg.min_history} plus one to score).`);
  const points: AnomalyPoint[] = [];
  const anomalies: Anomaly[] = [];
  const est: Record<string, number> = {};
  const modes = { additive: 0, multiplicative: 0 };
  const P = cfg.period ?? 1;
  let scored = 0;
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    // Expected value: median of previous observations at the same phase (every observation when there is no period).
    const base: number[] = [];
    for (let j = i - P; j >= 0 && base.length < cfg.window; j -= P) if (y[j] !== null) base.push(y[j]!);
    const enough = base.length >= Math.min(cfg.window, cfg.period ? Math.max(3, Math.floor(cfg.min_history / P)) : cfg.min_history);
    if (v === null || !enough) { points.push({ t: t[i], observed: v === null ? null : round(v), expected: null, lower: null, upper: null, score: null }); continue; }
    const m = median(base);
    // Pooled scale over the trailing block: leave-one-out deviations from each phase's median.
    const start = Math.max(0, i - cfg.window * P);
    const byPhase = new Map<number, number[]>();
    for (let j = start; j < i; j++) if (y[j] !== null) { const ph = (i - j) % P; const a = byPhase.get(ph) ?? []; a.push(y[j]!); byPhase.set(ph, a); }
    const all = [...byPhase.values()].flat();
    const mult = cfg.mode === 'multiplicative' || (cfg.mode === 'auto' && m > 0 && all.every((x) => x > 0));
    modes[mult ? 'multiplicative' : 'additive']++;
    const resid: number[] = [];
    for (const vals of byPhase.values()) {
      if (vals.length < 2) continue;
      vals.forEach((x, k) => { const pm = median(vals.filter((_, q) => q !== k)); resid.push(mult ? (x - pm) / pm : x - pm); });
    }
    const rs = robustScale(resid, 0);
    const scale = mult ? rs.scale * m : rs.scale;
    const estimator = rs.estimator;
    est[estimator] = (est[estimator] ?? 0) + 1;
    const r = judge(cfg, metric, t[i], v, m, scale);
    points.push(r.point);
    scored++;
    if (r.anomaly) anomalies.push(r.anomaly);
  }
  if (!scored) throw new AnalysisError('insufficient_data', `${metric}: no point has a full baseline of ${cfg.window} earlier observations${cfg.period ? ` at the same phase of a ${cfg.period}-period cycle` : ''}.`);
  return { metric, points, anomalies, scored, observations, scale_estimators: { ...est, ...Object.fromEntries(Object.entries(modes).filter(([, n]) => n).map(([k, n]) => [`mode_${k}`, n])) } };
}

/** Centred moving median of length P (P+1 when P is even), null where the window is incomplete. */
function centredMedian(y: number[], P: number): (number | null)[] {
  const out: (number | null)[] = new Array(y.length).fill(null);
  const half = Math.floor(P / 2);
  for (let i = half; i < y.length - half; i++) out[i] = median(y.slice(i - half, i + half + 1));
  return out;
}

export function seasonalDecomposition(cfg: AnomalyConfig, metric: string, t: string[], yIn: (number | null)[]): MetricResult {
  const P = cfg.period!;
  if (yIn.some((v) => v === null)) throw new AnalysisError('unsupported_input', `${metric}: seasonal decomposition needs a complete series; ${yIn.filter((v) => v === null).length} periods are missing (use missing: "zero" if absence means zero, or anomaly.rolling_mad).`);
  const y = yIn as number[];
  if (y.length < Math.max(cfg.min_history, 3 * P)) throw new AnalysisError('insufficient_data', `${metric}: ${y.length} observations; seasonal decomposition with period ${P} needs at least ${Math.max(cfg.min_history, 3 * P)} (three full cycles).`);
  const trend = centredMedian(y, P);
  // Extend the trend flat at both ends (documented limitation: edge points are less reliable).
  const first = trend.findIndex((v) => v !== null);
  let lastIdx = -1;
  for (let i = trend.length - 1; i >= 0; i--) if (trend[i] !== null) { lastIdx = i; break; }
  const tr = trend.map((v, i) => (v !== null ? v : i < first ? trend[first]! : trend[lastIdx]!));
  const phase: number[][] = Array.from({ length: P }, () => []);
  for (let i = 0; i < y.length; i++) if (trend[i] !== null) phase[i % P].push(y[i] - tr[i]);
  const raw = phase.map((d) => (d.length ? median(d) : 0));
  const adj = raw.reduce((a, b) => a + b, 0) / P;
  const seasonal = raw.map((s) => s - adj);
  const resid = y.map((v, i) => v - tr[i] - seasonal[i % P]);
  const rm = median(resid);
  const { scale, estimator } = robustScale(resid, rm);
  const points: AnomalyPoint[] = [];
  const anomalies: Anomaly[] = [];
  for (let i = 0; i < y.length; i++) {
    const center = tr[i] + seasonal[i % P] + rm;
    const r = judge(cfg, metric, t[i], y[i], center, scale);
    points.push(r.point);
    if (r.anomaly) anomalies.push(r.anomaly);
  }
  return { metric, points, anomalies, scored: y.length, observations: y.length, scale_estimators: { [estimator]: y.length } };
}

/** Restrict alerts to the last `recent_points` periods (the whole series is still scored and charted). */
export function alertable(cfg: AnomalyConfig, r: MetricResult): Anomaly[] {
  if (cfg.recent_points === null) return r.anomalies;
  const recent = new Set(r.points.slice(-cfg.recent_points).map((p) => p.t));
  return r.anomalies.filter((a) => recent.has(a.t));
}
