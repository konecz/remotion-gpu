// Statistics for the benchmark analysis: quantiles, median, and percentile bootstrap confidence intervals of the
// median and of a ratio of medians. Seeded, so the same results give the same intervals. Pure, for tests.

/** mulberry32: small, fast, deterministic. */
export const seeded = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher-Yates shuffle with a seeded generator. */
export const shuffle = (xs, rand) => {
  const v = [...xs];
  for (let i = v.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [v[i], v[j]] = [v[j], v[i]];
  }
  return v;
};

/** Quantile with linear interpolation (type 7, as R's default). */
export const quantile = (xs, q) => {
  const v = [...xs].sort((a, b) => a - b);
  const p = (v.length - 1) * q;
  const i = Math.floor(p);
  return v[i] + (v[Math.min(i + 1, v.length - 1)] - v[i]) * (p - i);
};
export const median = (xs) => quantile(xs, 0.5);
export const iqr = (xs) => quantile(xs, 0.75) - quantile(xs, 0.25);

/** Default number of bootstrap resamples. */
export const RESAMPLES = 10000;
const resample = (xs, rand) => xs.map(() => xs[Math.floor(rand() * xs.length)]);

/**
 * 95% percentile bootstrap CI of the median. With small N the interval is coarse (bounded by the values seen);
 * with N = 1 it does not exist (null).
 */
export const medianCI = (xs, { seed = 1, resamples = RESAMPLES, level = 0.95 } = {}) => {
  if (xs.length < 2) return null;
  const rand = seeded(seed);
  const ms = Array.from({ length: resamples }, () => median(resample(xs, rand)));
  return [quantile(ms, (1 - level) / 2), quantile(ms, 1 - (1 - level) / 2)];
};

/** Ratio of medians a/b with a 95% bootstrap CI (both groups resampled independently). */
export const ratioCI = (a, b, { seed = 2, resamples = RESAMPLES, level = 0.95 } = {}) => {
  const value = median(a) / median(b);
  if (a.length < 2 || b.length < 2) return { value, ci: null };
  const rand = seeded(seed);
  const rs = Array.from({ length: resamples }, () => median(resample(a, rand)) / median(resample(b, rand)));
  return { value, ci: [quantile(rs, (1 - level) / 2), quantile(rs, 1 - (1 - level) / 2)] };
};
