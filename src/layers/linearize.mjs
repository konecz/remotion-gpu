// Per-frame curves -> straight segments with a bounded error, and the ffmpeg expression that evaluates them.
//
// The framing of a video take (spring into a card, slow zoom, punch-in) is computed per frame in JS. ffmpeg's
// libplacebo takes per-frame expressions for crop_* and pos_*, so each curve becomes a chain of straight segments
// (greedy: each segment grows while every frame in it stays within `tolerance` px of the line), written as nested
// if(lt(K,end),line,rest). A slow zoom is one segment; a spring takes 5 to 25.
// Pure functions, shared by src/layers/plan.ts (Remotion side) and src/layers/render-layers.mjs (ffmpeg side).

/** Default maximum position error, in output pixels. */
export const DEFAULT_TOLERANCE = 0.05;

const round = (x, d) => +x.toFixed(d);

/**
 * Splits a per-frame series into straight segments whose interpolation stays within `tolerance` of every value.
 * Values are first rounded to 3 decimals (what ffmpeg receives).
 * @param {number[]} values one value per frame
 * @param {number} [tolerance]
 * @returns {{ from: number, to: number, a: number, b: number }[]} inclusive frame ranges with end values
 */
export const linearize = (values, tolerance = DEFAULT_TOLERANCE) => {
  if (!values.length) return [];
  const v = values.map((x) => round(x, 3));
  const fits = (a, b) => {
    for (let i = a; i <= b; i++) if (Math.abs(v[a] + ((v[b] - v[a]) * (i - a)) / (b - a) - v[i]) > tolerance) return false;
    return true;
  };
  const segments = [];
  for (let a = 0; a < v.length; ) {
    let b = a + 1;
    while (b < v.length && fits(a, b)) b++;
    segments.push({ from: a, to: b - 1, a: v[a], b: v[b - 1] });
    a = b;
  }
  return segments;
};

/** Value of the segmented curve at frame k (what the ffmpeg expression computes). */
export const evalSegments = (segments, k) => {
  const s = segments.find((x) => k <= x.to) ?? segments.at(-1);
  if (s.to === s.from) return s.a;
  return s.a + (round(s.b - s.a, 4) * (k - s.from)) / (s.to - s.from);
};

/** Largest absolute difference between a series and its segmented version. */
export const maxError = (values, segments) => values.reduce((m, x, k) => Math.max(m, Math.abs(evalSegments(segments, k) - x)), 0);

const line = ({ from, to, a, b }, K) => (to === from ? `${a}` : `${a}+${round(b - a, 4)}*(${K}-${from})/${to - from}`);

/**
 * ffmpeg expression for a segmented curve, in the variable `K` (frame index inside the segment).
 * @param {{ from: number, to: number, a: number, b: number }[]} segments
 * @param {string} [K] variable or sub-expression for the frame index
 */
export const toExpression = (segments, K = "K") =>
  segments.reduceRight((rest, s) => (rest === null ? line(s, K) : `if(lt(${K},${s.to + 1}),${line(s, K)},${rest})`), null);

/**
 * Expression for libplacebo: frame index from the output timestamp `ot`, rounded to the nearest frame.
 * @param {number[]} values
 * @param {number} fps
 * @param {number} [tolerance]
 */
export const frameExpression = (values, fps, tolerance = DEFAULT_TOLERANCE) => {
  const segments = linearize(values, tolerance);
  return { expr: toExpression(segments, `floor(ot*${fps}+0.5)`), segments: segments.length };
};
