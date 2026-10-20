// Evidence-backed insights. The title and body are produced by templates from computed values,
// so every figure in them comes from the analysis result; the evidence object carries the exact
// numbers, the window, the method and its limitations. An optional model-written narrative
// (narrate.ts) is stored separately and never replaces these.

import type { AnalysisConfig, AnalysisOutcome } from './types.js';
import type { Anomaly } from './anomaly.js';
import type { ForecastOutput } from './forecast.js';
import type { OutlierOutput } from './outlier.js';
import type { ClusterOutput } from './cluster.js';

export type InsightKind = 'anomaly' | 'forecast' | 'outlier' | 'segment' | 'status';
export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface InsightDraft {
  kind: InsightKind; severity: Severity; metric: string | null; title: string; body: string;
  /** Notification category for delivery filtering. */
  notify: 'anomaly' | 'forecast' | 'threshold' | 'run_succeeded' | 'analysis_failed';
  evidence: Record<string, unknown>;
}

export const fmt = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? 'n/a' : n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });

const method = (o: AnalysisOutcome) => `${o.algorithm} v${o.algorithm_version}`;

function anomalyInsight(cfg: Extract<AnalysisConfig, { type: 'anomaly' }>, o: AnalysisOutcome, a: Anomaly): InsightDraft {
  const pct = a.deviation_pct === null ? '' : ` (${fmt(Math.abs(a.deviation_pct), 1)}% ${a.direction} the baseline)`;
  const baseline = cfg.algorithm === 'anomaly.rolling_mad'
    ? `the median of the previous ${cfg.window} ${cfg.period ? `same-phase observations (period ${cfg.period})` : `${cfg.grain}s`}`
    : `the seasonal decomposition (period ${cfg.period})`;
  return {
    kind: 'anomaly', severity: a.severity, metric: a.metric, notify: 'anomaly',
    title: `${a.metric} for ${a.t} is ${a.direction} its expected range${pct}`,
    body: `Observed ${fmt(a.observed)} against an expected ${fmt(a.expected)} from ${baseline}; expected range ${fmt(a.lower)} to ${fmt(a.upper)}. `
      + `Robust z-score ${fmt(a.score, 2)} (threshold ${fmt(cfg.threshold, 2)}). Method: ${method(o)}. This is a statistical deviation; it does not establish a cause.`,
    evidence: { ...a, threshold: cfg.threshold, window: cfg.window, period: cfg.period, grain: cfg.grain, algorithm: o.algorithm, algorithm_version: o.algorithm_version, limitations: o.limitations },
  };
}

export function buildInsights(cfg: AnalysisConfig, o: AnalysisOutcome): InsightDraft[] {
  if (o.status !== 'succeeded') {
    return [{
      kind: 'status', severity: o.status === 'algorithm_failure' ? 'medium' : 'low', metric: null, notify: 'analysis_failed',
      title: `${cfg.label ?? cfg.key}: ${o.status.replace(/_/g, ' ')}`, body: `${o.message ?? 'The analysis did not produce a result.'} Method: ${method(o)}.`,
      evidence: { status: o.status, message: o.message, algorithm: o.algorithm, algorithm_version: o.algorithm_version, input_rows: o.input_rows },
    }];
  }
  const r = o.result as Record<string, any>;
  switch (cfg.type) {
    case 'anomaly': {
      const alerts = r.alerts as Anomaly[];
      if (!alerts.length) {
        return [{
          kind: 'anomaly', severity: 'info', metric: cfg.metrics.join(', '), notify: 'run_succeeded',
          title: `No anomalies in ${cfg.metrics.join(', ')}${cfg.recent_points ? ` over the last ${cfg.recent_points} ${cfg.grain}${cfg.recent_points > 1 ? 's' : ''}` : ''}`,
          body: `Every scored point is within ${fmt(cfg.threshold, 2)} robust standard deviations of its baseline (${r.window.from} to ${r.window.to}). Method: ${method(o)}.`,
          evidence: { window: r.window, threshold: cfg.threshold, scored: (o.quality as any)?.scored, algorithm: o.algorithm, algorithm_version: o.algorithm_version },
        }];
      }
      // Most severe first, bounded.
      return [...alerts].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 10).map((a) => anomalyInsight(cfg, o, a));
    }
    case 'forecast': {
      const f = r as ForecastOutput & { threshold_crossings: ForecastOutput['forecast']; thresholds: { above: number | null; below: number | null } };
      const first = f.forecast[0]; const last = f.forecast[f.forecast.length - 1];
      const interval = f.interval ? ` (${Math.round(f.interval * 100)}% empirical interval ${fmt(last.lower)} to ${fmt(last.upper)})` : ' (no interval: fewer than 5 backtest origins)';
      const out: InsightDraft[] = [{
        kind: 'forecast', severity: 'info', metric: cfg.metric, notify: 'forecast',
        title: `${cfg.metric}: ${cfg.horizon}-${cfg.grain} forecast from ${first.t} to ${last.t}`,
        body: `Forecast ${fmt(first.value)} for ${first.t} and ${fmt(last.value)} for ${last.t}${interval}, trained on ${f.training.observations} ${cfg.grain}s (${f.training.from} to ${f.training.to}). `
          + `Backtest over ${f.backtest.origins} rolling origins: MAE ${fmt(f.backtest.mae)}${f.backtest.mape !== null ? `, MAPE ${fmt(f.backtest.mape, 1)}%` : ''}${f.backtest.mase !== null ? `, MASE ${fmt(f.backtest.mase, 2)}` : ''}. Method: ${f.method}${cfg.algorithm === 'forecast.auto' ? ' (selected by backtest MAE)' : ''}. This is a statistical projection, not a prediction of business events.`,
        evidence: { forecast: f.forecast, training: f.training, backtest: f.backtest, method: f.method, interval: f.interval, algorithm: o.algorithm, algorithm_version: o.algorithm_version, limitations: o.limitations },
      }];
      if (f.threshold_crossings.length) {
        const c = f.threshold_crossings[0];
        const which = f.thresholds.above !== null && c.value > f.thresholds.above ? `above ${fmt(f.thresholds.above)}` : `below ${fmt(f.thresholds.below)}`;
        out.push({
          kind: 'forecast', severity: 'medium', metric: cfg.metric, notify: 'threshold',
          title: `${cfg.metric} is forecast ${which} in ${f.threshold_crossings.length} of ${cfg.horizon} ${cfg.grain}s`,
          body: `First crossing: ${c.t}, forecast ${fmt(c.value)}. Backtest MAE ${fmt(f.backtest.mae)} over ${f.backtest.origins} origins. A forecast threshold alert is a projection, not an observed value.`,
          evidence: { crossings: f.threshold_crossings, thresholds: f.thresholds, backtest_mae: f.backtest.mae, algorithm: o.algorithm, algorithm_version: o.algorithm_version },
        });
      }
      return out;
    }
    case 'outlier': {
      const out = r as OutlierOutput;
      const top = out.records.filter((x) => x.flagged).slice(0, 3);
      return [{
        kind: 'outlier', severity: out.flagged ? (top[0]?.score >= cfg.threshold * 2 ? 'medium' : 'low') : 'info', metric: cfg.features.join(', '), notify: out.flagged ? 'anomaly' : 'run_succeeded',
        title: out.flagged ? `${out.flagged} of ${out.scored} records differ substantially from comparable records` : `No outliers among ${out.scored} records`,
        body: (out.flagged
          ? `Highest scores: ${top.map((x) => `${x.id ?? `row ${x.row + 1}`} (score ${fmt(x.score, 2)}, mostly ${x.contributions[0]?.feature})`).join('; ')}. `
          : `No record reaches the threshold of ${fmt(cfg.threshold, 2)}. `)
          + `Features: ${cfg.features.join(', ')}${cfg.group_by ? `, compared within ${cfg.group_by}` : ''}. Method: ${method(o)}. Unusual is not the same as wrong.`,
        evidence: { flagged: out.flagged, scored: out.scored, threshold: cfg.threshold, top: top.map((x) => ({ id: x.id, score: x.score, rank: x.rank, contributions: x.contributions })), algorithm: o.algorithm, algorithm_version: o.algorithm_version },
      }];
    }
    case 'cluster': {
      const c = r as ClusterOutput;
      return [{
        kind: 'segment', severity: 'info', metric: cfg.features.join(', '), notify: 'run_succeeded',
        title: `${c.k} unnamed clusters over ${c.assignments.length} records`,
        body: `Sizes ${c.clusters.map((x) => x.size).join(', ')}; mean silhouette ${fmt(c.silhouette, 3)} (1 = well separated, 0 = overlapping). Features: ${cfg.features.join(', ')} (${c.scaling.method} scaled). `
          + `Method: ${method(o)}, seed ${cfg.seed}. Review and name the clusters before treating them as business segments.`,
        evidence: { sizes: c.clusters.map((x) => x.size), silhouette: c.silhouette, inertia: c.inertia, centroids: c.clusters.map((x) => x.centroid), algorithm: o.algorithm, algorithm_version: o.algorithm_version },
      }];
    }
  }
}
