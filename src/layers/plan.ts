// Turns the animated framing of a video take (any function frame -> where the take sits, written with Remotion's
// spring/interpolate) into the plan the layered render consumes (plan.schema.json). The SAME function draws the take
// in the composition (path P1) and is sampled here for ffmpeg (path P2), so both paths agree frame by frame.
//
// No React here: the plan is exported in Node by bundling a small entry with esbuild (see examples/presenter).
import { DEFAULT_TOLERANCE, frameExpression, linearize, maxError } from "./linearize.mjs";

export { DEFAULT_TOLERANCE, linearize, maxError };

/** [x, y, w, h] in output pixels. */
export type Rect4 = [number, number, number, number];
export type Rect = { x: number; y: number; w: number; h: number };

/** Where a take sits in one frame: the visible box on screen, and the whole take relative to that box. */
export type TakeFrame = { box: Rect; video: Rect };

export type PlanTake = {
  /** Video file (absolute path, or relative to the plan file). */
  file: string;
  /** First frame on the timeline. */
  start: number;
  /** Number of frames on the timeline. */
  frames: number;
  /** Seconds into the file where the take starts (default 0). */
  from?: number;
  /** One box per frame: where the take is visible on screen. */
  box: Rect4[];
  /** One rect per frame: the whole take, relative to the box (what falls outside the box is hidden). */
  video: Rect4[];
};

export type PlanAudio = {
  file: string;
  start: number;
  frames: number;
  /** Seconds into the file (default 0). */
  from?: number;
  volume?: number;
  /** Volume falls linearly to 0 between these frames (relative to `start`). */
  fadeOut?: [number, number];
};

export type Plan = {
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Solid color under everything ("#rrggbb"). */
  background: string;
  takes: PlanTake[];
  audio?: PlanAudio[];
};

const r4 = ({ x, y, w, h }: Rect): Rect4 => [x, y, w, h];

/**
 * Samples a framing function for every frame of a take.
 * @param frameAt framing at frame `f` relative to the take's first frame
 */
export const sampleTake = (
  { file, start, frames, from }: { file: string; start: number; frames: number; from?: number },
  frameAt: (f: number) => TakeFrame,
): PlanTake => {
  const qs = Array.from({ length: frames }, (_, f) => frameAt(f));
  return { file, start, frames, ...(from ? { from } : {}), box: qs.map((q) => r4(q.box)), video: qs.map((q) => r4(q.video)) };
};

/**
 * The part of the take that falls inside the box, as libplacebo crop (source pixels) and pos (output pixels).
 * Same math as render-layers.mjs.
 */
export const cropAndPosition = ([cx, cy, cw, ch]: Rect4, [vx, vy, vw, vh]: Rect4, source: { w: number; h: number }) => {
  const x0 = Math.max(0, vx);
  const y0 = Math.max(0, vy);
  const x1 = Math.min(cw, vx + vw);
  const y1 = Math.min(ch, vy + vh);
  const sx = vw / source.w;
  const sy = vh / source.h;
  return {
    crop_x: (x0 - vx) / sx,
    crop_y: (y0 - vy) / sy,
    crop_w: (x1 - x0) / sx,
    crop_h: (y1 - y0) / sy,
    pos_x: cx + x0,
    pos_y: cy + y0,
    pos_w: x1 - x0,
    pos_h: y1 - y0,
  };
};

/**
 * How many straight segments each libplacebo parameter of a take needs, and the worst error, for a tolerance.
 * Useful to check a plan before rendering.
 */
export const linearizationReport = (take: PlanTake, fps: number, source: { w: number; h: number }, tolerance = DEFAULT_TOLERANCE) => {
  const g = take.box.map((b, i) => cropAndPosition(b, take.video[i], source));
  const keys = Object.keys(g[0]) as (keyof (typeof g)[0])[];
  return Object.fromEntries(
    keys.map((k) => {
      const values = g.map((q) => q[k]);
      const segs = linearize(values, tolerance);
      return [k, { segments: frameExpression(values, fps, tolerance).segments, maxError: maxError(values, segs) }];
    }),
  );
};
