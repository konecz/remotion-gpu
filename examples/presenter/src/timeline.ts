// The timeline of the example, with no React: the composition (Video.tsx) draws from it, and plan.ts exports the same
// blocks as the layered render plan. One synthetic take, cut into three blocks (each starts further into the file),
// then an opaque outro card with no video.
import type { PresenterProps } from "../../../src/presenter";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const BACKGROUND = "#f4f2ee";
export const INK = "#0f1b2d";
export const ACCENT = "#c9a227";
/** Footage made by scripts/make-footage.mjs (public/footage/, git-ignored). */
export const FOOTAGE = "footage/presenter.mp4";

export const f = (s: number) => Math.round(s * FPS);

export type Block = {
  /** First frame on the timeline. */
  start: number;
  frames: number;
  /** Presenter in this block (null: no video). */
  presenter: Omit<PresenterProps, "src" | "graphicsOnly" | "background"> | null;
};

/** The card next to the chart in block 2. */
export const CARD = { x: 1050, y: 90, w: 780, h: 900, radius: 32 };
/** Where the chart goes, beside the card. */
export const CHART = { x: 110, y: 170, w: 840, h: 640 };

const FOCUS = { x: 1060, y: 560 };

export const BLOCKS: Block[] = [
  // 1. Fullscreen, slow zoom, a punch-in on emphasis.
  { start: 0, frames: f(3.5), presenter: { focus: FOCUS, emphases: [{ from: 1.0, to: 2.4 }] } },
  // 2. Springs from fullscreen into a card at 0.6 s; a chart appears beside it.
  { start: f(3.5), frames: f(4), presenter: { focus: FOCUS, card: CARD, shrinkAt: 0.6, cardFocusX: 1000 } },
  // 3. Fullscreen again, tighter (base zoom 1.1), another punch-in.
  { start: f(7.5), frames: f(2.5), presenter: { focus: FOCUS, baseZoom: 1.1, emphases: [{ from: 0.8, to: 1.8 }] } },
  // 4. Outro: an opaque card, no video (Chrome writes these PNG frames without alpha).
  { start: f(10), frames: f(1.5), presenter: null },
];

export const TOTAL_FRAMES = BLOCKS.reduce((t, b) => t + b.frames, 0);

/** Captions, word by word: one word every WORD_SECONDS, phrases of up to PHRASE words, during blocks 1-3. */
export const WORDS = (
  "this presenter is a synthetic test pattern; the video is decoded, cropped and placed on the GPU while " +
  "Remotion draws only the captions, the lower third and the chart, with the processor left free for everything else"
).split(/\s+/);
export const WORD_SECONDS = 0.3;
export const PHRASE = 5;
export const CAPTIONS_END = f(10);
