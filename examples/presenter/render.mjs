// Renders the example by either path, contained (nice 19, CPU ceiling), and compares the two.
//
//   node examples/presenter/render.mjs p1        Remotion + <Video> + NVENC        -> out/presenter-p1.mp4
//   node examples/presenter/render.mjs layers    graphics in Remotion, video on GPU -> out/presenter-layers.mp4
//   node examples/presenter/render.mjs compare   SSIM/PSNR between the two outputs  -> out/compare.json
// Options: --frames 0-149 (a range), --out-dir dir, --no-dedup, --parallel 2, --device cpu (P1 without the GPU),
//          --keep (keep the layered work folder: plan.json and the PNG layer).
// The synthetic footage is generated on first use (scripts/make-footage.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contained, ensureContained } from "../../src/contain.mjs";
import { renderLayered } from "../../src/layers/pipeline.mjs";
import { probeOutput } from "../../src/measure.mjs";
import { compareVideos } from "../../src/quality.mjs";
import { p1Args, projectArgs, remotionCommand } from "../../src/remotion-gpu.mjs";
import { makeFootage } from "./scripts/make-footage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    frames: { type: "string" },
    "out-dir": { type: "string", default: join(HERE, "out") },
    "no-dedup": { type: "boolean", default: false },
    parallel: { type: "string", default: "1" },
    device: { type: "string", default: "nvidia" },
    keep: { type: "boolean", default: false },
  },
});
const mode = positionals[0];
if (!["p1", "layers", "compare"].includes(mode)) {
  console.error("usage: node examples/presenter/render.mjs p1|layers|compare [--frames a-b] [--out-dir dir] [--no-dedup] [--parallel N] [--device nvidia|cpu]");
  process.exit(2);
}
ensureContained();

const outDir = resolve(o["out-dir"]);
mkdirSync(outDir, { recursive: true });
const frames = o.frames ? o.frames.split("-").map(Number) : undefined;
const P1 = join(outDir, "presenter-p1.mp4");
const LAYERS = join(outDir, "presenter-layers.mp4");
const t0 = performance.now();

if (mode === "p1" || mode === "layers") makeFootage();

if (mode === "p1") {
  const { cmd, args } = remotionCommand({ cwd: HERE });
  contained(
    cmd,
    [...args, "render", "src/index.ts", "Presenter", P1, ...projectArgs(HERE), ...p1Args(o.device), ...(frames ? [`--frames=${frames[0]}-${frames[1]}`] : []), "--log=error"],
    { cwd: HERE },
  );
  console.log(`P1 done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${P1}`);
}

if (mode === "layers") {
  const { steps } = await renderLayered({
    cwd: HERE,
    planEntry: join(HERE, "src", "plan.ts"),
    planInput: { publicDir: join(HERE, "public") },
    serveUrl: "src/index.ts",
    composition: "Presenter",
    graphicsProps: { graphicsOnly: true },
    workDir: join(outDir, "work-layers"),
    output: LAYERS,
    frames,
    dedup: !o["no-dedup"],
    remotionArgs: [...projectArgs(HERE), "--gl=vulkan"],
    parallel: Number(o.parallel),
    keepGraphics: o.keep,
  });
  for (const s of steps) console.log(`  ${s.step.padEnd(9)} wall ${s.wall.toFixed(1)} s${s.cpu != null ? `, CPU ${s.cpu.toFixed(1)} s` : ""}`);
  console.log(`layers done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${LAYERS}`);
}

if (mode === "compare") {
  const a = probeOutput(P1);
  const b = probeOutput(LAYERS);
  if (!a || !b) throw new Error("render both paths first (p1 and layers)");
  const q = compareVideos(P1, LAYERS);
  const result = {
    p1: { frames: a.frames, duration: a.duration, codec: a.codec, size: `${a.width}x${a.height}`, color: a.color, audio: a.audio },
    layers: { frames: b.frames, duration: b.duration, codec: b.codec, size: `${b.width}x${b.height}`, color: b.color, audio: b.audio },
    quality: q,
  };
  writeFileSync(join(outDir, "compare.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`P1 ${a.frames} frames ${a.duration?.toFixed(3)} s | layers ${b.frames} frames ${b.duration?.toFixed(3)} s`);
  console.log(`SSIM mean ${q.ssim.toFixed(4)}, worst frame ${q.ssimMin.toFixed(4)}, 1st percentile ${q.ssimP01.toFixed(4)} | PSNR ${q.psnr.toFixed(2)} dB${q.vmaf != null ? ` | VMAF ${q.vmaf.toFixed(2)}` : ""}`);
}
