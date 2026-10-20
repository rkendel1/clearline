// Normalize and validate analysis configurations against a query's output schema.
// A configuration is checked when a saved-query version is saved (against the schema
// observed then) and again before every analysis run (against the actual result).

import type { AnalysisConfig, AnomalyConfig, ClusterConfig, ForecastConfig, Grain, InputColumn, Limits, OutlierConfig } from './types.js';

export interface ConfigIssue { code: 'invalid_configuration' | 'stale_schema'; field: string; message: string }

const NUMERIC = new Set(['integer', 'decimal']);
const TIME = new Set(['date', 'timestamp']);
const GRAINS: Grain[] = ['hour', 'day', 'week', 'month'];
const KEY = /^[a-z][a-z0-9_-]{0,62}$/;

type Raw = Record<string, unknown>;

const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isNum = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Fill defaults and validate the shape (no schema). Throws nothing; returns issues.
 * The result is the durable configuration stored on the saved-query version.
 */
export function normalizeConfig(raw: unknown, limits: Limits): { config: AnalysisConfig | null; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const bad = (field: string, message: string) => issues.push({ code: 'invalid_configuration', field, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, issues: [{ code: 'invalid_configuration', field: '', message: 'An analysis configuration must be an object.' }] };
  const r = raw as Raw;
  const key = typeof r.key === 'string' ? r.key : '';
  if (!KEY.test(key)) bad('key', 'key must be 1-63 lowercase letters, digits, "-" or "_", starting with a letter.');
  const label = typeof r.label === 'string' ? r.label.slice(0, 200) : undefined;
  const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length ? (r[k] as string) : null);
  const strs = (k: string): string[] => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const int = (k: string, d: number, lo: number, hi: number): number => {
    const v = r[k] ?? d;
    if (!isInt(v, lo, hi)) { bad(k, `${k} must be an integer between ${lo} and ${hi}.`); return d; }
    return v as number;
  };
  const numb = (k: string, d: number, lo: number, hi: number): number => {
    const v = r[k] ?? d;
    if (!isNum(v, lo, hi)) { bad(k, `${k} must be a number between ${lo} and ${hi}.`); return d; }
    return v as number;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const v = (r[k] ?? d) as T;
    if (!allowed.includes(v)) { bad(k, `${k} must be one of ${allowed.join(', ')}.`); return d; }
    return v;
  };
  const grain = () => oneOf('grain', GRAINS, 'day');
  const period = () => {
    if (r.period === null || r.period === undefined) return null;
    if (!isInt(r.period, 2, 366)) { bad('period', 'period must be an integer between 2 and 366, or null.'); return null; }
    return r.period as number;
  };

  let config: AnalysisConfig | null = null;
  switch (r.type) {
    case 'anomaly': {
      const algorithm = oneOf('algorithm', ['anomaly.rolling_mad', 'anomaly.seasonal_decomposition'] as const, 'anomaly.rolling_mad');
      const time_column = str('time_column');
      const metrics = strs('metrics');
      if (!time_column) bad('time_column', 'Choose the time column.');
      if (!metrics.length) bad('metrics', 'Choose at least one numeric metric.');
      if (metrics.length > limits.maxFeatures) bad('metrics', `At most ${limits.maxFeatures} metrics.`);
      const threshold = numb('threshold', 3.5, 1.5, 20);
      const sev = (r.severity ?? {}) as Raw;
      const medium = isNum(sev.medium, threshold, 50) ? (sev.medium as number) : Math.max(threshold, 5);
      const high = isNum(sev.high, medium, 100) ? (sev.high as number) : Math.max(medium, 8);
      const p = period();
      if (algorithm === 'anomaly.seasonal_decomposition' && !p) bad('period', 'Seasonal decomposition needs a seasonal period (e.g. 7 for weekly patterns in daily data).');
      // With a period, the window counts same-phase observations (8 = the same weekday over 8 weeks).
      const window = int('window', p ? 8 : 28, 3, 365);
      const c: AnomalyConfig = {
        type: 'anomaly', key, label, algorithm, time_column: time_column ?? '', metrics, grain: grain(), window, period: p, threshold, severity: { medium, high },
        mode: oneOf('mode', ['auto', 'additive', 'multiplicative'] as const, 'auto'),
        direction: oneOf('direction', ['both', 'up', 'down'] as const, 'both'),
        recent_points: r.recent_points === null || r.recent_points === undefined ? null : int('recent_points', 1, 1, limits.maxPoints),
        missing: oneOf('missing', ['skip', 'zero'] as const, 'skip'),
        min_history: int('min_history', algorithm === 'anomaly.seasonal_decomposition' ? 3 * (p ?? 7) : Math.min(window, 14), 7, 1000),
      };
      config = c;
      break;
    }
    case 'forecast': {
      const algorithm = oneOf('algorithm', ['forecast.naive', 'forecast.seasonal_naive', 'forecast.drift', 'forecast.holt_linear', 'forecast.auto'] as const, 'forecast.auto');
      const time_column = str('time_column');
      const metric = str('metric');
      if (!time_column) bad('time_column', 'Choose the time column.');
      if (!metric) bad('metric', 'Choose the metric to forecast.');
      const p = period();
      if (algorithm === 'forecast.seasonal_naive' && !p) bad('period', 'A seasonal-naive forecast needs a seasonal period.');
      const horizon = int('horizon', 8, 1, limits.maxHorizon);
      const th = (r.thresholds ?? {}) as Raw;
      const t = (v: unknown, k: string) => (v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : (bad(`thresholds.${k}`, `thresholds.${k} must be a number or null.`), null));
      const interval = r.interval ?? 0.8;
      if (![0.8, 0.9, 0.95].includes(interval as number)) bad('interval', 'interval must be 0.8, 0.9 or 0.95.');
      const c: ForecastConfig = {
        type: 'forecast', key, label, algorithm, time_column: time_column ?? '', metric: metric ?? '', grain: grain(), horizon, period: p,
        interval: ([0.8, 0.9, 0.95].includes(interval as number) ? interval : 0.8) as ForecastConfig['interval'],
        backtest_origins: int('backtest_origins', 8, 3, 52),
        missing: oneOf('missing', ['skip', 'zero', 'interpolate'] as const, 'interpolate'),
        min_history: int('min_history', Math.max(2 * horizon, p ? 2 * p : 0, 12), 6, 2000),
        thresholds: { above: t(th.above, 'above'), below: t(th.below, 'below') },
      };
      config = c;
      break;
    }
    case 'outlier': {
      const features = strs('features');
      if (!features.length) bad('features', 'Select at least one numeric feature explicitly.');
      if (features.length > limits.maxFeatures) bad('features', `At most ${limits.maxFeatures} features.`);
      const c: OutlierConfig = {
        type: 'outlier', key, label, algorithm: oneOf('algorithm', ['outlier.robust_distance'] as const, 'outlier.robust_distance'),
        id_column: str('id_column'), features, group_by: str('group_by'),
        threshold: numb('threshold', 3.5, 1, 50), min_samples: int('min_samples', 30, 10, 100_000), top_n: int('top_n', 25, 1, 500),
      };
      config = c;
      break;
    }
    case 'cluster': {
      const features = strs('features');
      if (features.length < 2) bad('features', 'Select at least two numeric features explicitly.');
      if (features.length > limits.maxFeatures) bad('features', `At most ${limits.maxFeatures} features.`);
      const c: ClusterConfig = {
        type: 'cluster', key, label, algorithm: oneOf('algorithm', ['cluster.kmeans'] as const, 'cluster.kmeans'),
        id_column: str('id_column'), features, k: int('k', 3, 2, 12), scaling: oneOf('scaling', ['zscore', 'robust'] as const, 'zscore'),
        seed: int('seed', 42, 0, 2 ** 31 - 1), n_init: int('n_init', 5, 1, 20), max_iter: int('max_iter', 100, 10, 1000), min_per_cluster: int('min_per_cluster', 5, 2, 10_000),
      };
      config = c;
      break;
    }
    default:
      bad('type', 'type must be one of anomaly, forecast, outlier, cluster.');
  }
  return { config: issues.length ? null : config, issues };
}

/** Columns a configuration needs, with the kind of column each must be. */
export function requiredColumns(c: AnalysisConfig): { name: string; role: 'time' | 'numeric' | 'id' | 'group'; field: string }[] {
  switch (c.type) {
    case 'anomaly': return [{ name: c.time_column, role: 'time', field: 'time_column' }, ...c.metrics.map((m) => ({ name: m, role: 'numeric' as const, field: 'metrics' }))];
    case 'forecast': return [{ name: c.time_column, role: 'time', field: 'time_column' }, { name: c.metric, role: 'numeric', field: 'metric' }];
    case 'outlier':
    case 'cluster': return [
      ...(c.id_column ? [{ name: c.id_column, role: 'id' as const, field: 'id_column' }] : []),
      ...(c.type === 'outlier' && c.group_by ? [{ name: c.group_by, role: 'group' as const, field: 'group_by' }] : []),
      ...c.features.map((f) => ({ name: f, role: 'numeric' as const, field: 'features' })),
    ];
  }
}

/**
 * Check a configuration against an output schema. `stale` = true reports schema mismatches as
 * stale_schema (the query changed under a saved configuration) rather than invalid_configuration.
 * Redacted columns and columns derived from sensitive fields can never be features or metrics;
 * they may serve as record identifiers only when they are not redacted.
 */
export function checkAgainstSchema(c: AnalysisConfig, schema: InputColumn[], stale = false): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const code = stale ? 'stale_schema' : 'invalid_configuration';
  for (const req of requiredColumns(c)) {
    const col = schema.find((s) => s.name === req.name);
    if (!col) { issues.push({ code, field: req.field, message: `Column "${req.name}" is not in the query output.` }); continue; }
    if (req.role === 'numeric') {
      // Redaction and sensitivity first: a redacted numeric column arrives as text, and the reason is access, not schema drift.
      if (col.masked) issues.push({ code: 'invalid_configuration', field: req.field, message: `Column "${req.name}" is redacted for the run identity and cannot be analysed.` });
      else if (col.sensitive) issues.push({ code: 'invalid_configuration', field: req.field, message: `Column "${req.name}" is derived from a sensitive field; sensitive fields are not used as analysis inputs.` });
      else if (!NUMERIC.has(col.type)) issues.push({ code, field: req.field, message: `Column "${req.name}" is ${col.type}; a numeric column is required.` });
    } else if (req.role === 'time') {
      if (!TIME.has(col.type)) issues.push({ code, field: req.field, message: `Column "${req.name}" is ${col.type}; a date or timestamp column is required.` });
    } else if (col.masked) {
      issues.push({ code: 'invalid_configuration', field: req.field, message: `Column "${req.name}" is redacted for the run identity and cannot identify records.` });
    }
  }
  return issues;
}
