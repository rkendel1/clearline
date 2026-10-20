// Small, exact-where-possible numeric helpers shared by the algorithms. Pure functions.

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(xs: number[], m = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - m)));
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function std(xs: number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated quantile (type 7, as in R and NumPy's default). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/**
 * Robust scale: 1.4826 * MAD (consistent with the standard deviation for normal data).
 * When more than half the values are identical MAD is 0; fall back to the scaled mean
 * absolute deviation (1.2533 * mean |x - median|), and report which estimator was used.
 */
export function robustScale(xs: number[], m = median(xs)): { scale: number; estimator: 'mad' | 'mean_abs_dev' | 'none' } {
  const d = mad(xs, m);
  if (d > 0) return { scale: 1.4826 * d, estimator: 'mad' };
  const meanAbs = mean(xs.map((x) => Math.abs(x - m)));
  if (meanAbs > 0) return { scale: 1.2533 * meanAbs, estimator: 'mean_abs_dev' };
  return { scale: 0, estimator: 'none' };
}

/** Deterministic PRNG (mulberry32) so seeded algorithms are reproducible across runs and machines. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round for presentation and storage; analysis arithmetic itself is unrounded. */
export const round = (x: number, digits = 4) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : x);

/** Parse a result cell as a finite number (numeric columns arrive as strings to keep decimals exact). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
