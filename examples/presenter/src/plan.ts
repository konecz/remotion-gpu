// The layered render plan of the example, from the SAME timeline and framing the composition uses. Bundled for Node
// by render.mjs (src/layers/pipeline.mjs, exportPlan) and written as plan.json for ffmpeg.
import type { Plan } from "../../../src/layers/plan";
import { presenterTake } from "../../../src/presenter/framing";
import { BACKGROUND, BLOCKS, FOOTAGE, FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./timeline";

export default ({ publicDir }: { publicDir: string }): Plan => {
  const file = `${publicDir}/${FOOTAGE}`;
  const config = { fps: FPS, width: WIDTH, height: HEIGHT };
  const withVideo = BLOCKS.filter((b) => b.presenter);
  return {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    frames: TOTAL_FRAMES,
    background: BACKGROUND,
    takes: withVideo.map((b) => presenterTake(b.presenter!, config, { file, start: b.start, frames: b.frames, from: b.start / FPS })),
    // The presenter's own audio, block by block (in P1 it comes from the same <Video>).
    audio: withVideo.map((b) => ({ file, start: b.start, frames: b.frames, from: b.start / FPS })),
  };
};
