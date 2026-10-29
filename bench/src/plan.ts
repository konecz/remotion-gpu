// Layered render plan for the synthetic compositions, from the same geometry.ts the compositions draw with. Without a
// take (A, D, E): a background-only plan, and the graphics are the whole scene. C has no plan: it shows two to four
// takes at once and the layered render puts one take per segment.
import type { Plan } from "../../src/layers/plan";
import { sampleTake } from "../../src/layers/plan";
import { FPS } from "./common";
import { frameB, segments, take } from "./geometry";

/** Background of each composition in "none" mode (the bottom input of libplacebo). */
export const BACKGROUND: Record<string, string> = {
  "A-Typography": "#0f1b2d",
  "B-Presenter": "#f4f2ee",
  "D-Effects": "#000000",
  "E-Slide": "#f4f2ee",
};

export default ({ comp, width, height, frames, publicDir }: { comp: string; width: number; height: number; frames: number; publicDir: string }): Plan => {
  if (!(comp in BACKGROUND)) throw new Error(`${comp}: no layered plan (more than one take at a time)`);
  const takes =
    comp !== "B-Presenter"
      ? []
      : segments(frames).map((s) =>
          sampleTake({ file: `${publicDir}/${take(s.i)}`, start: s.start, frames: s.frames }, (f) => {
            const q = frameB(s.i, f, width, height);
            return { box: q.box, video: q.video };
          }),
        );
  return { width, height, fps: FPS, frames, background: BACKGROUND[comp], takes, audio: [] };
};
