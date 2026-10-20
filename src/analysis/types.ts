// Typed contracts of the analysis subsystem (docs/saved-analytics.md#analyses).
//
// An analysis turns the authorized, already-redacted, bounded result of one saved-query
// execution into a reproducible output. It is not a query engine and not an authority:
// it only sees the rows the run identity was allowed to see, and it refuses columns that
// are redacted or derived from sensitive fields.

export type AnalysisType = 'anomaly' | 'forecast' | 'outlier' | 'cluster';

export type AnalysisStatus =
  | 'succeeded'
  | 'insufficient_data'       // valid configuration, but not enough usable observations
  | 'unsupported_input'       // the data cannot be analysed this way (e.g. truncated, duplicate periods)
  | 'invalid_configuration'   // the configuration does not fit the query output
  | 'algorithm_failure'       // the algorithm could not complete (time limit, numerical failure)
  | 'cancelled'
  | 'stale_schema';           // the query output no longer matches what the configuration was built for

export type Grain = 'hour' | 'day' | 'week' | 'month';
export type Missing = 'skip' | 'zero' | 'interpolate';

interface Base {
  /** Stable key of the analysis within a saved query (e.g. "daily-anomalies"). */
  key: string;
  label?: string;
}

export interface AnomalyConfig extends Base {
  type: 'anomaly';
  algorithm: 'anomaly.rolling_mad' | 'anomaly.seasonal_decomposition';
  time_column: string;
  metrics: string[];
  grain: Grain;
  /** rolling_mad: baseline observations before each point; decomposition: unused. */
  window: number;
  /** Seasonal period in grains (e.g. 7 for weekly seasonality in daily data); null = none. */
  period: number | null;
  /** Robust z-score above which a point is anomalous. */
  threshold: number;
  /** rolling_mad: compare relative deviations (multiplicative) or absolute ones; auto = multiplicative for positive baselines. */
  mode: 'auto' | 'additive' | 'multiplicative';
  severity: { medium: number; high: number };
  direction: 'both' | 'up' | 'down';
  /** Only the last N points can raise alerts (null = every scored point). */
  recent_points: number | null;
  missing: 'skip' | 'zero';
  min_history: number;
}

export interface ForecastConfig extends Base {
  type: 'forecast';
  algorithm: 'forecast.naive' | 'forecast.seasonal_naive' | 'forecast.drift' | 'forecast.holt_linear' | 'forecast.auto';
  time_column: string;
  metric: string;
  grain: Grain;
  horizon: number;
  period: number | null;
  /** Central coverage of the empirical prediction interval. */
  interval: 0.8 | 0.9 | 0.95;
  backtest_origins: number;
  missing: Missing;
  min_history: number;
  /** Optional alert thresholds on forecast values. */
  thresholds: { above: number | null; below: number | null };
}

export interface OutlierConfig extends Base {
  type: 'outlier';
  algorithm: 'outlier.robust_distance';
  id_column: string | null;
  features: string[];
  /** Compare each record only with records of the same group (e.g. status). */
  group_by: string | null;
  threshold: number;
  min_samples: number;
  top_n: number;
}

export interface ClusterConfig extends Base {
  type: 'cluster';
  algorithm: 'cluster.kmeans';
  id_column: string | null;
  features: string[];
  k: number;
  scaling: 'zscore' | 'robust';
  seed: number;
  n_init: number;
  max_iter: number;
  min_per_cluster: number;
}

export type AnalysisConfig = AnomalyConfig | ForecastConfig | OutlierConfig | ClusterConfig;

/** A column of the query output as the analysis sees it. */
export interface InputColumn { name: string; type: string; masked: string | null; sensitive: boolean }

export interface AnalysisInput {
  columns: InputColumn[];
  rows: unknown[][];
  truncated: boolean;
}

export interface Timings { prepare_ms: number; algorithm_ms: number }

export interface AnalysisOutcome {
  status: AnalysisStatus;
  message: string | null;
  algorithm: string;
  algorithm_version: string;
  /** Bounded, presentation-ready output (series points, anomalies, forecasts, rankings, clusters). */
  result: Record<string, unknown> | null;
  /** Quality / evaluation metrics (backtest errors, silhouette, sample sizes). */
  quality: Record<string, unknown> | null;
  /** Documented limitations of the method as applied. */
  limitations: string[];
  input_rows: number;
  timings: Timings;
}

export class AnalysisError extends Error {
  constructor(readonly status: Exclude<AnalysisStatus, 'succeeded'>, message: string) { super(message); }
}

export interface Limits { maxRows: number; maxFeatures: number; maxPoints: number; maxHorizon: number; timeoutMs: number; maxMemoryMb: number }

/** Algorithm versions: bump when a change can alter results for the same input and configuration. */
export const ALGORITHM_VERSIONS: Record<string, string> = {
  'anomaly.rolling_mad': '1.0.0',
  'anomaly.seasonal_decomposition': '1.0.0',
  'forecast.naive': '1.0.0',
  'forecast.seasonal_naive': '1.0.0',
  'forecast.drift': '1.0.0',
  'forecast.holt_linear': '1.0.0',
  'forecast.auto': '1.0.0',
  'outlier.robust_distance': '1.0.0',
  'cluster.kmeans': '1.0.0',
};
