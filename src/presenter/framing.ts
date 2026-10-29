// Where a presenter take sits in each frame: fullscreen or a card, a spring between the two, a slow zoom and
// punch-ins on emphasis. No React: the same function draws <Presenter> (path P1) and is sampled into the layered
// render plan (path P2, see presenterTake), so both paths frame the take identically.
import { interpolate, spring } from "remotion";
import { sampleTake, type PlanTake, type Rect } from "../layers/plan";

export type Box = Rect & { radius: number };
/** Seconds, relative to the presenter's first frame. */
export type Emphasis = { from: number; to: number };

export type FramingProps = {
  /** Source video size in pixels (default 1920x1080). */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Point of interest in source pixels, kept framed (default: center). */
  focus?: { x: number; y: number };
  /** Focus x while in the card, if it should differ (e.g. to hide a logo at the edge). */
  cardFocusX?: number;
  /** Vertical placement of the focus inside the box, 0..1 (default 0.45: a little above the middle). */
  focusLine?: number;
  /** Final card. Without it, the presenter stays fullscreen. */
  card?: Box;
  /** Second when it moves from fullscreen into the card (absent or 0: starts in the card). */
  shrinkAt?: number;
  /** Frames of the spring into the card (default 22). */
  shrinkFrames?: number;
  /** Punch-in intervals. */
  emphases?: Emphasis[];
  /** Zoom on top of "cover" (default 1). */
  baseZoom?: number;
  /** Slow zoom from 1 to this factor over the whole duration (default 1.06; 1 disables it). */
  slowZoom?: number;
  /** Extra zoom during an emphasis (default 0.12). */
  punch?: number;
};

export type Framing = {
  /** Visible box on screen. */
  box: Box;
  /** 0 fullscreen, 1 in the card (the spring of the transition). */
  e: number;
  /** The whole take, relative to the box (may go past the edges; what does is hidden). */
  video: Rect;
};

export type VideoConfigLike = { fps: number; width: number; height: number; durationInFrames: number };

const mix = (a: Box, b: Box, e: number): Box => ({
  x: a.x + (b.x - a.x) * e,
  y: a.y + (b.y - a.y) * e,
  w: a.w + (b.w - a.w) * e,
  h: a.h + (b.h - a.h) * e,
  radius: a.radius + (b.radius - a.radius) * e,
});

/**
 * Framing at frame `f` (relative to the presenter's first frame).
 * @param config width/height of the composition, fps, and the presenter's duration in frames
 */
export const framePresenter = (p: FramingProps, f: number, { fps, width, height, durationInFrames }: VideoConfigLike): Framing => {
  const sw = p.sourceWidth ?? 1920;
  const sh = p.sourceHeight ?? 1080;
  const focus = p.focus ?? { x: sw / 2, y: sh / 2 };
  const full: Box = { x: 0, y: 0, w: width, h: height, radius: 0 };
  const e = p.card
    ? p.shrinkAt
      ? spring({ frame: f - p.shrinkAt * fps, fps, config: { damping: 200 }, durationInFrames: p.shrinkFrames ?? 22 })
      : 1
    : 0;
  const box = p.card ? mix(full, p.card, e) : full;

  const slow = (p.baseZoom ?? 1) * interpolate(f, [0, Math.max(1, durationInFrames)], [1, p.slowZoom ?? 1.06]);
  const punch = (p.emphases ?? []).reduce((z, em) => {
    const enter = spring({ frame: f - em.from * fps, fps, config: { damping: 18 } });
    const exit = spring({ frame: f - em.to * fps, fps, config: { damping: 18 } });
    return z + (p.punch ?? 0.12) * (enter - exit);
  }, 0);
  // "cover": the take always fills the box, then zoom.
  const scale = Math.max(box.w / sw, box.h / sh) * (slow + punch);
  const fx = focus.x + ((p.cardFocusX ?? focus.x) - focus.x) * e;
  const left = box.w / 2 - fx * scale;
  const top = box.h * (p.focusLine ?? 0.45) - focus.y * scale;
  // Never show past the edge of the take.
  const clamp = (v: number, min: number) => Math.min(0, Math.max(min, v));
  return {
    box,
    e,
    video: { x: clamp(left, box.w - sw * scale), y: clamp(top, box.h - sh * scale), w: sw * scale, h: sh * scale },
  };
};

/**
 * The take of the layered render plan for one presenter, sampled from the same framing.
 * @param at where the presenter sits on the timeline: first frame, frames, file and seconds into the file
 */
export const presenterTake = (
  p: FramingProps,
  config: { fps: number; width: number; height: number },
  at: { file: string; start: number; frames: number; from?: number },
): PlanTake =>
  sampleTake(at, (f) => {
    const q = framePresenter(p, f, { ...config, durationInFrames: at.frames });
    return { box: q.box, video: q.video };
  });
