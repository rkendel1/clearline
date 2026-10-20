// Analysis entry point: validate the configuration against the actual result, prepare
// features, run the algorithm within limits, and return a typed outcome. Separated stages:
//   1. query execution         (src/query/service.ts — not here)
//   2. feature preparation     (features.ts)
//   3. algorithm execution     (anomaly.ts, forecast.ts, outlier.ts, cluster.ts)
//   4. result validation       (finite numbers, bounded sizes — below)
//   5. insight persistence     (src/analytics/runner.ts with insights.ts)
//   6. delivery / presentation (src/delivery, the native client)

import { checkAgainstSchema } from './config.js';
import { columnIndex, idText, matrix, timeSeries } from './features.js';
import { alertable, rollingMad, seasonalDecomposition, type MetricResult } from './anomaly.js';
import { forecast } from './forecast.js';
import { robustDistance } from './outlier.js';
import { kmeans } from './cluster.js';
import { ALGORITHM_VERSIONS, AnalysisError, type AnalysisConfig, type AnalysisInput, type AnalysisOutcome, type Limits } from './types.js';

export * from './types.js';
export { normalizeConfig, checkAgainstSchema, requiredColumns } from './config.js';

const LIMITATIONS: Record<string, string[]> = {
  'anomaly.rolling_mad': [
    'Each point is compared with earlier observations only; a level shift is flagged at first and then becomes the new baseline.',
    'Without a seasonal period, regular weekly or monthly patterns can be flagged as anomalies.',
    'An anomaly is a statistical deviation, not evidence of an error, fraud or a cause.',
  ],
  'anomaly.seasonal_decomposition': [
    'Retrospective: the trend at a point uses later observations, so the most recent half-period is less reliable.',
    'Assumes one additive seasonal pattern of a fixed period; changing seasonality is not modelled.',
    'An anomaly is a statistical deviation, not evidence of an error, fraud or a cause.',
  ],
  forecast: [
    'Baseline statistical forecast; it does not know about holidays, policy changes or known future events.',
    'Intervals are empirical, from backtest errors on the same series; their coverage is not independently validated.',
    'Accuracy is only as reported by the backtest; it was not measured beyond the available history.',
  ],
  'outlier.robust_distance': [
    'Features are standardized independently; correlation between features is not modelled.',
    'Records are compared with their group only; an unusual group as a whole is not flagged.',
    'An outlier is unusual relative to comparable records, not evidence of an error or misconduct.',
  ],
  'cluster.kmeans': [
    'k-means assumes roughly spherical groups of similar size in the scaled feature space.',
    'The number of clusters is chosen by the user; a low silhouette means the groups are not well separated.',
    'Clusters are statistical groupings; they are unnamed until a person reviews them.',
  ],
};

function assertFinite(x: unknown, path = 'result'): void {
  if (typeof x === 'number' && !Number.isFinite(x)) throw new AnalysisError('algorithm_failure', `Non-finite number in ${path}.`);
  if (Array.isArray(x)) x.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) assertFinite(v, `${path}.${k}`);
}

export function runAnalysis(cfg: AnalysisConfig, input: AnalysisInput, limits: Limits): AnalysisOutcome {
  const algorithm = cfg.algorithm;
  const version = ALGORITHM_VERSIONS[algorithm];
  const t0 = performance.now();
  let t1 = t0;
  const base = { algorithm, algorithm_version: version, input_rows: input.rows.length, limitations: (LIMITATIONS[cfg.type === 'forecast' ? 'forecast' : algorithm] ?? [])
    // The seasonal-period caveat applies only when no period was configured.
    .filter((l) => !(l.startsWith('Without a seasonal period') && (cfg as { period?: number | null }).period)) };
  let deadline = Infinity;
  const done = (o: Partial<AnalysisOutcome> & Pick<AnalysisOutcome, 'status'>): AnalysisOutcome => {
    // k-means checks the deadline between iterations; the other algorithms are bounded by the
    // input caps, and a result produced after the limit is discarded rather than reported.
    if (o.status === 'succeeded' && Date.now() > deadline) o = { status: 'algorithm_failure', message: `The analysis exceeded ANALYSIS_TIMEOUT_MS (${limits.timeoutMs} ms); its result was discarded.` };
    return { message: null, result: null, quality: null, ...base, ...o,
      timings: { prepare_ms: Math.round((t1 - t0) * 100) / 100, algorithm_ms: Math.round((performance.now() - t1) * 100) / 100 } };
  };
  try {
    const schemaIssues = checkAgainstSchema(cfg, input.columns, true);
    if (schemaIssues.length) {
      const stale = schemaIssues.find((i) => i.code === 'stale_schema');
      return done({ status: stale ? 'stale_schema' : 'invalid_configuration', message: (stale ?? schemaIssues[0]).message });
    }
    if (input.truncated) throw new AnalysisError('unsupported_input', `The query result was truncated at ${input.rows.length} rows; the analysis needs the complete result (aggregate further or narrow the query).`);
    if (input.rows.length > limits.maxRows) throw new AnalysisError('unsupported_input', `${input.rows.length} rows exceed ANALYSIS_MAX_ROWS (${limits.maxRows}).`);
    const width = cfg.type === 'anomaly' ? cfg.metrics.length : cfg.type === 'forecast' ? 1 : cfg.features.length;
    const estimateMb = (input.rows.length * (width + 2) * 8 * 4) / 1e6;
    if (estimateMb > limits.maxMemoryMb) throw new AnalysisError('unsupported_input', `Estimated working memory ${estimateMb.toFixed(1)} MB exceeds ANALYSIS_MAX_MEMORY_MB (${limits.maxMemoryMb}).`);
    deadline = Date.now() + limits.timeoutMs;

    switch (cfg.type) {
      case 'anomaly': {
        const ti = columnIndex(input.columns, cfg.time_column);
        const series = cfg.metrics.map((m) => ({ m, s: timeSeries(input.rows, ti, columnIndex(input.columns, m), cfg.grain, cfg.missing, limits.maxPoints) }));
        t1 = performance.now();
        const results: MetricResult[] = series.map(({ m, s }) => (cfg.algorithm === 'anomaly.seasonal_decomposition' ? seasonalDecomposition(cfg, m, s.t, s.y) : rollingMad(cfg, m, s.t, s.y)));
        const alerts = results.flatMap((r) => alertable(cfg, r));
        const result = {
          metrics: results.map((r) => ({ metric: r.metric, points: r.points, anomalies: r.anomalies, scored: r.scored, observations: r.observations })),
          alerts, window: { from: series[0].s.t[0], to: series[0].s.t[series[0].s.t.length - 1], grain: cfg.grain },
        };
        assertFinite(result);
        return done({ status: 'succeeded', result, quality: {
          observations: Object.fromEntries(results.map((r) => [r.metric, r.observations])), scored: Object.fromEntries(results.map((r) => [r.metric, r.scored])),
          missing_periods: Object.fromEntries(series.map(({ m, s }) => [m, s.missing])), dropped_rows: Object.fromEntries(series.map(({ m, s }) => [m, s.dropped])),
          anomalies: results.reduce((a, r) => a + r.anomalies.length, 0), alerts: alerts.length,
          scale_estimators: Object.fromEntries(results.map((r) => [r.metric, r.scale_estimators])),
        } });
      }
      case 'forecast': {
        const s = timeSeries(input.rows, columnIndex(input.columns, cfg.time_column), columnIndex(input.columns, cfg.metric), cfg.grain, cfg.missing, limits.maxPoints);
        t1 = performance.now();
        const f = forecast(cfg, s.t, s.y);
        const crossings = f.forecast.filter((p) => (cfg.thresholds.above !== null && p.value > cfg.thresholds.above) || (cfg.thresholds.below !== null && p.value < cfg.thresholds.below));
        const result = { ...f, thresholds: cfg.thresholds, threshold_crossings: crossings };
        assertFinite(result);
        return done({ status: 'succeeded', result, quality: { backtest: f.backtest, missing_periods: s.missing, interpolated: cfg.missing === 'interpolate' ? s.missing : 0, dropped_rows: s.dropped } });
      }
      case 'outlier': {
        const fi = cfg.features.map((f) => columnIndex(input.columns, f));
        const m = matrix(input.rows, fi);
        const ii = cfg.id_column ? columnIndex(input.columns, cfg.id_column) : -1;
        const gi = cfg.group_by ? columnIndex(input.columns, cfg.group_by) : -1;
        const ids = m.rowIndex.map((r) => (ii >= 0 ? idText(input.rows[r][ii]) : null));
        const groups = m.rowIndex.map((r) => (gi >= 0 ? idText(input.rows[r][gi]) : null));
        t1 = performance.now();
        const o = robustDistance(cfg, m.x, ids, groups, m.rowIndex);
        assertFinite(o);
        return done({ status: 'succeeded', result: { ...o, features: cfg.features, group_by: cfg.group_by }, quality: { complete_records: m.x.length, dropped_rows: m.dropped, scored: o.scored, flagged: o.flagged } });
      }
      case 'cluster': {
        const fi = cfg.features.map((f) => columnIndex(input.columns, f));
        const m = matrix(input.rows, fi);
        const ii = cfg.id_column ? columnIndex(input.columns, cfg.id_column) : -1;
        t1 = performance.now();
        const c = kmeans(cfg, m.x, m.rowIndex.map((r) => (ii >= 0 ? idText(input.rows[r][ii]) : null)), m.rowIndex, deadline);
        assertFinite(c);
        return done({ status: 'succeeded', result: { ...c, features: cfg.features }, quality: { complete_records: m.x.length, dropped_rows: m.dropped, silhouette: c.silhouette, inertia: c.inertia, converged: c.converged } });
      }
    }
  } catch (err) {
    if (err instanceof AnalysisError) return done({ status: err.status, message: err.message });
    return done({ status: 'algorithm_failure', message: `The algorithm failed: ${(err as Error).message.slice(0, 300)}` });
  }
}
