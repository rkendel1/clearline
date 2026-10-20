// cluster.kmeans (v1): k-means (Lloyd's algorithm) on scaled numeric features.
//
// Features are scaled (z-score, or median / robust scale) so no feature dominates by its units.
// Initialization is k-means++ driven by a seeded PRNG (mulberry32); the best of `n_init` seeded
// runs by inertia (within-cluster sum of squares) is kept. Input rows are put in a canonical
// order first, so the same rows in a different order give the same clusters. Quality is reported
// as the mean silhouette coefficient (on a deterministic sample of at most 2,000 points).
// Clusters are statistical groupings, unnamed until a person reviews and names them.

import type { ClusterConfig } from './types.js';
import { AnalysisError } from './types.js';
import { mean, median, prng, robustScale, round, std } from './stats.js';

export interface ClusterOutput {
  k: number; inertia: number; silhouette: number | null; silhouette_sample: number; iterations: number; converged: boolean; best_init: number;
  scaling: { method: string; center: Record<string, number>; scale: Record<string, number> };
  clusters: { cluster: number; label: string; size: number; centroid: Record<string, number>; summary: Record<string, { mean: number; min: number; max: number }> }[];
  assignments: { id: string | null; row: number; cluster: number }[];
}

const d2 = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };

function kmeansOnce(x: number[][], k: number, seed: number, maxIter: number, deadline: number) {
  const rnd = prng(seed);
  const centers: number[][] = [x[Math.floor(rnd() * x.length)].slice()];
  const dist = x.map((p) => d2(p, centers[0]));
  while (centers.length < k) {
    const total = dist.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    let pick = x.length - 1;
    for (let i = 0; i < x.length; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
    centers.push(x[pick].slice());
    for (let i = 0; i < x.length; i++) dist[i] = Math.min(dist[i], d2(x[i], centers[centers.length - 1]));
  }
  const assign = new Array(x.length).fill(-1);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    if (Date.now() > deadline) throw new AnalysisError('algorithm_failure', 'k-means exceeded the analysis time limit (ANALYSIS_TIMEOUT_MS).');
    let changed = 0;
    for (let i = 0; i < x.length; i++) {
      let best = 0; let bd = Infinity;
      for (let c = 0; c < k; c++) { const d = d2(x[i], centers[c]); if (d < bd) { bd = d; best = c; } }
      if (assign[i] !== best) { assign[i] = best; changed++; }
    }
    const sums = Array.from({ length: k }, () => new Array(x[0].length).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < x.length; i++) { counts[assign[i]]++; x[i].forEach((v, j) => { sums[assign[i]][j] += v; }); }
    for (let c = 0; c < k; c++) if (counts[c]) centers[c] = sums[c].map((s) => s / counts[c]);
    if (!changed) { converged = true; break; }
  }
  const inertia = x.reduce((a, p, i) => a + d2(p, centers[assign[i]]), 0);
  return { centers, assign, inertia, iterations: iterations + (converged ? 1 : 0), converged };
}

function silhouette(x: number[][], assign: number[], k: number): { value: number | null; n: number } {
  const step = Math.max(1, Math.ceil(x.length / 2000));
  const idx = x.map((_, i) => i).filter((i) => i % step === 0);
  const s: number[] = [];
  for (const i of idx) {
    const sums = new Array(k).fill(0); const cnt = new Array(k).fill(0);
    for (const j of idx) { if (j === i) continue; sums[assign[j]] += Math.sqrt(d2(x[i], x[j])); cnt[assign[j]]++; }
    const own = assign[i];
    if (!cnt[own]) { s.push(0); continue; }
    const a = sums[own] / cnt[own];
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnt[c]) b = Math.min(b, sums[c] / cnt[c]);
    s.push(b === Infinity ? 0 : (b - a) / Math.max(a, b));
  }
  return { value: s.length ? mean(s) : null, n: idx.length };
}

export function kmeans(cfg: ClusterConfig, xIn: number[][], idsIn: (string | null)[], rowsIn: number[], deadline: number): ClusterOutput {
  const n = xIn.length;
  if (n < cfg.k * cfg.min_per_cluster) throw new AnalysisError('insufficient_data', `${n} complete records; k = ${cfg.k} needs at least ${cfg.k * cfg.min_per_cluster} (min_per_cluster ${cfg.min_per_cluster}).`);
  // Canonical order: by identifier when there is one, else by feature values.
  const order = xIn.map((_, i) => i).sort((a, b) => {
    if (idsIn[a] !== null && idsIn[b] !== null && idsIn[a] !== idsIn[b]) return idsIn[a]! < idsIn[b]! ? -1 : 1;
    for (let j = 0; j < xIn[a].length; j++) if (xIn[a][j] !== xIn[b][j]) return xIn[a][j] - xIn[b][j];
    return rowsIn[a] - rowsIn[b];
  });
  const raw = order.map((i) => xIn[i]);
  const ids = order.map((i) => idsIn[i]);
  const rows = order.map((i) => rowsIn[i]);
  const center: number[] = []; const scale: number[] = [];
  cfg.features.forEach((f, j) => {
    const col = raw.map((r) => r[j]);
    const c = cfg.scaling === 'robust' ? median(col) : mean(col);
    const s = cfg.scaling === 'robust' ? robustScale(col, c).scale : std(col, c);
    if (!(s > 1e-9 * Math.max(1, Math.abs(c)))) throw new AnalysisError('unsupported_input', `Feature "${f}" is constant across the records; remove it before clustering.`);
    center.push(c); scale.push(s);
  });
  const x = raw.map((r) => r.map((v, j) => (v - center[j]) / scale[j]));
  const distinct = new Set(x.map((p) => p.join(','))).size;
  if (distinct < cfg.k) throw new AnalysisError('unsupported_input', `Only ${distinct} distinct records; cannot form ${cfg.k} clusters.`);
  let best: ReturnType<typeof kmeansOnce> | null = null;
  let bestInit = 0;
  for (let r = 0; r < cfg.n_init; r++) {
    const run = kmeansOnce(x, cfg.k, cfg.seed + r, cfg.max_iter, deadline);
    if (!best || run.inertia < best.inertia - 1e-12) { best = run; bestInit = r; }
  }
  const sizes = new Array(cfg.k).fill(0);
  best!.assign.forEach((c) => sizes[c]++);
  if (sizes.some((s) => s === 0)) throw new AnalysisError('algorithm_failure', 'k-means produced an empty cluster; try a smaller k.');
  // Relabel clusters by size (largest first), ties by centroid, so labels are stable.
  const relabel = sizes.map((s, c) => ({ s, c, key: best!.centers[c].join(',') })).sort((a, b) => b.s - a.s || (a.key < b.key ? -1 : 1)).map((o) => o.c);
  const newOf = new Map(relabel.map((c, i) => [c, i]));
  const assign = best!.assign.map((c) => newOf.get(c)!);
  const sil = silhouette(x, assign, cfg.k);
  const clusters = relabel.map((c, i) => {
    const members = raw.filter((_, p) => assign[p] === i);
    return {
      cluster: i + 1, label: `Cluster ${String.fromCharCode(65 + i)} (unnamed)`, size: members.length,
      centroid: Object.fromEntries(cfg.features.map((f, j) => [f, round(best!.centers[c][j] * scale[j] + center[j])])),
      summary: Object.fromEntries(cfg.features.map((f, j) => {
        const col = members.map((m) => m[j]);
        return [f, { mean: round(mean(col)), min: round(Math.min(...col)), max: round(Math.max(...col)) }];
      })),
    };
  });
  return {
    k: cfg.k, inertia: round(best!.inertia), silhouette: sil.value === null ? null : round(sil.value, 3), silhouette_sample: sil.n, iterations: best!.iterations, converged: best!.converged, best_init: bestInit,
    scaling: { method: cfg.scaling, center: Object.fromEntries(cfg.features.map((f, j) => [f, round(center[j])])), scale: Object.fromEntries(cfg.features.map((f, j) => [f, round(scale[j])])) },
    clusters, assignments: assign.map((c, p) => ({ id: ids[p], row: rows[p], cluster: c + 1 })),
  };
}
