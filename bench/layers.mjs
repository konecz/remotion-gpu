// P2/P3 for the synthetic compositions: plan (src/plan.ts) -> graphics (the composition in "none" mode, PNG with
// alpha) -> ffmpeg on the GPU (src/layers/render-layers.mjs). Records wall time and CPU per step (from the cgroup
// when run inside a measured scope), to separate the graphics cost from the ffmpeg cost.
//
// Usage: node bench/layers.mjs B-Presenter --bundle dir --width 1920 --height 1080 --seconds 30 --work dir \
//          --output video.mp4 [--steps steps.json] [--dedup] [--vulkan-device N]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderLayered } from "../src/layers/pipeline.mjs";
import { CONFIG, HERE } from "./matrix.mjs";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bundle: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    seconds: { type: "string" },
    work: { type: "string" },
    output: { type: "string" },
    steps: { type: "string" },
    dedup: { type: "boolean", default: false },
    "vulkan-device": { type: "string" },
  },
});
const comp = positionals[0];
const width = Number(o.width);
const height = Number(o.height);
const seconds = Number(o.seconds);
const frames = Math.round(seconds * 30);

const { steps } = await renderLayered({
  cwd: HERE,
  planEntry: join(HERE, "src", "plan.ts"),
  planInput: { comp, width, height, frames, publicDir: join(HERE, "public") },
  serveUrl: o.bundle,
  composition: comp,
  graphicsProps: { width, height, seconds, video: "none" },
  workDir: o.work,
  output: o.output,
  dedup: o.dedup,
  remotionArgs: ["--gl=vulkan", `--config=${CONFIG}`],
  vulkanDevice: o["vulkan-device"],
});
if (o.steps) writeFileSync(o.steps, JSON.stringify(steps));
