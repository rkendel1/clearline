// outlier.robust_distance (v1): robust standardized distance.
//
// Each selected feature is standardized within its comparison group (all records, or records
// with the same `group_by` value) by its median and robust scale (1.4826 x MAD, falling back to
// the scaled mean absolute deviation). A record's score is the root mean square of its robust
// z-scores, sqrt(mean(z_i^2)); a feature's contribution is z_i^2 / sum(z^2). Records scoring at or
// above `threshold` are flagged. The method treats features independently: it does not model
// correlation between them (a Mahalanobis distance would), so two individually ordinary values
// that are jointly unusual are not detected.

import type { OutlierConfig } from './types.js';
import { AnalysisError } from './types.js';
import { median, robustScale, round } from './stats.js';

export interface OutlierRecord {
  id: string | null; row: number; group: string | null; score: number; rank: number; flagged: boolean;
  values: Record<string, number>; baseline: Record<string, number>; z: Record<string, number>; contributions: { feature: string; share: number }[];
}

export interface OutlierOutput {
  records: OutlierRecord[]; flagged: number; scored: number; groups: { group: string | null; n: number; scored: boolean }[];
  excluded_features: { feature: string; reason: string }[];
}

export function robustDistance(cfg: OutlierConfig, x: number[][], ids: (string | null)[], groups: (string | null)[], rowIndex: number[]): OutlierOutput {
  const byGroup = new Map<string | null, number[]>();
  groups.forEach((g, i) => { const a = byGroup.get(g) ?? []; a.push(i); byGroup.set(g, a); });
  const groupInfo = [...byGroup.entries()].map(([g, idx]) => ({ group: g, n: idx.length, scored: idx.length >= cfg.min_samples }));
  if (!groupInfo.some((g) => g.scored)) {
    throw new AnalysisError('insufficient_data', `${x.length} complete records${cfg.group_by ? ` in ${byGroup.size} groups` : ''}; at least ${cfg.min_samples} per comparison group are required (min_samples).`);
  }
  const all: OutlierRecord[] = [];
  const excluded = new Map<string, string>();
  for (const [g, idx] of byGroup) {
    if (idx.length < cfg.min_samples) continue;
    const stats = cfg.features.map((_, f) => {
      const col = idx.map((i) => x[i][f]);
      const m = median(col);
      return { m, ...robustScale(col, m) };
    });
    stats.forEach((s, f) => { if (s.scale === 0) excluded.set(cfg.features[f], 'constant within its comparison group'); });
    const usable = stats.map((s) => s.scale > 0);
    if (!usable.some(Boolean)) continue;
    for (const i of idx) {
      const z: Record<string, number> = {};
      const sq: number[] = [];
      cfg.features.forEach((f, k) => { if (usable[k]) { const v = (x[i][k] - stats[k].m) / stats[k].scale; z[f] = round(v, 3); sq.push(v * v); } });
      const sum = sq.reduce((a, b) => a + b, 0);
      const score = Math.sqrt(sum / sq.length);
      const contributions = cfg.features.filter((_, k) => usable[k]).map((f, j) => ({ feature: f, share: sum > 0 ? round(sq[j] / sum, 3) : 0 })).sort((a, b) => b.share - a.share);
      all.push({
        id: ids[i], row: rowIndex[i], group: g, score: round(score, 3), rank: 0, flagged: score >= cfg.threshold,
        values: Object.fromEntries(cfg.features.map((f, k) => [f, round(x[i][k])])), baseline: Object.fromEntries(cfg.features.map((f, k) => [f, round(stats[k].m)])),
        z, contributions,
      });
    }
  }
  if (!all.length) throw new AnalysisError('unsupported_input', 'Every selected feature is constant within its comparison group; nothing can be scored.');
  // Highest score first; ties by identifier then input row, so the ranking is reproducible.
  all.sort((a, b) => b.score - a.score || String(a.id ?? '').localeCompare(String(b.id ?? '')) || a.row - b.row);
  all.forEach((r, i) => { r.rank = i + 1; });
  return {
    records: all.slice(0, cfg.top_n), flagged: all.filter((r) => r.flagged).length, scored: all.length, groups: groupInfo,
    excluded_features: [...excluded.entries()].map(([feature, reason]) => ({ feature, reason })),
  };
}
