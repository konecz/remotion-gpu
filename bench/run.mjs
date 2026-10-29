// Benchmark harness: runs the matrix path x video x resolution with N repetitions, in a shuffled order each
// repetition, after a discarded warm-up round, waiting for the machine to be quiet before each measured run. Records
// the raw JSON of every run, the environment at the start and the end, and the quality of each output against the
// video's reference. Ends with the analysis (analyze.mjs) and a submission.json to share.
//
// Usage:
//   node bench/run.mjs --smoke       N=1, 4 s, 1080p, every video and path (a check that everything runs)
//   node bench/run.mjs --quick       N=3, 15 s, 1080p, without P3 on A and D (every frame changes there)
//   node bench/run.mjs --full        N=5, 30 s, 1080p and 4K (hours: run it overnight)
//   node bench/run.mjs --videos B,E --paths P1,P2 --res 1080p --n 3 --seconds 10
//   node bench/run.mjs --quality-of <results dir>      redo only the quality of a run
// Device: --device nvidia|cpu (cpu: no GPU, P2/P3 not applicable), --gpu <CUDA index>, --vulkan-device <index>.
// External project (video "X"): --external <dir> --external-comp <id> [--external-entry src/index.ts]
//   [--external-start 0] [--external-layers "<command with {output} {from} {to} {work}>"]
// Quiet-machine wait: --load-max (1-minute load, default threads/2), --busy-max 0.35 (busy CPU 0..1), --wait-max (s).
// Output: bench/results/<date>-<label>/ (runs.jsonl, quality.jsonl, environment-*.json, outputs/, analysis.md,
// chart.html, submission.json), or --out <dir>.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CORES, contained } from "../src/contain.mjs";
import { bundleProject } from "../src/layers/pipeline.mjs";
import { environment, measureRun, openDmons, redact, waitForQuiet } from "../src/measure.mjs";
import { FLOOR_ENCODERS, compareVideos, reencode, vmafAvailable } from "../src/quality.mjs";
import { projectArgs } from "../src/remotion-gpu.mjs";
import { makeFootage } from "../examples/presenter/scripts/make-footage.mjs";
import { analyze } from "./analyze.mjs";
import { HERE, NotApplicable, PATHS, RESOLUTIONS, VIDEOS, deviceEnv, externalVideo, referenceCommand } from "./matrix.mjs";
import { N_TAKES_FOOTAGE, TAKE_SECONDS_FOOTAGE } from "./footage.mjs";
import { seeded, shuffle } from "./stats.mjs";

const ROOT = resolve(HERE, "..");
const { values: o } = parseArgs({
  options: {
    smoke: { type: "boolean", default: false },
    quick: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    skip: { type: "string" },
    n: { type: "string" },
    seconds: { type: "string" },
    "warmup-seconds": { type: "string" },
    videos: { type: "string" },
    paths: { type: "string" },
    res: { type: "string" },
    seed: { type: "string", default: "20261029" },
    label: { type: "string" },
    out: { type: "string" },
    "load-max": { type: "string", default: String(Math.max(2, availableParallelism() / 2)) },
    "busy-max": { type: "string", default: "0.35" },
    "wait-max": { type: "string" },
    "no-warmup": { type: "boolean", default: false },
    "no-quality": { type: "boolean", default: false },
    "quality-of": { type: "string" },
    device: { type: "string", default: "nvidia" },
    gpu: { type: "string" },
    "vulkan-device": { type: "string" },
    external: { type: "string" },
    "external-comp": { type: "string" },
    "external-entry": { type: "string", default: "src/index.ts" },
    "external-start": { type: "string", default: "0" },
    "external-layers": { type: "string" },
  },
});

const previous = o["quality-of"] ? JSON.parse(readFileSync(join(o["quality-of"], "config.json"), "utf8")) : null;
// Presets. The quick one skips P3 on A and D (every frame changes, nothing to skip) and leaves 4K for the full one.
const PRESET = o.smoke
  ? { n: 1, seconds: 4, res: "1080p", warmup: 2, waitMax: 15, label: "smoke" }
  : o.quick
    ? { n: 3, seconds: 15, res: "1080p", skip: "A-1080p-P3,D-1080p-P3", warmup: 4, waitMax: 1200, label: "quick" }
    : o.full
      ? { n: 5, seconds: 30, warmup: 4, waitMax: 1200, label: "full" }
      : { n: 3, seconds: 15, warmup: 4, waitMax: 1200, label: "custom" };
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : null);
const N = Number(o.n ?? PRESET.n);
const SECONDS = previous?.seconds ?? Number(o.seconds ?? PRESET.seconds);
const wantVideos = list(o.videos);
const wantPaths = list(o.paths);
const wantRes = list(o.res ?? PRESET.res);
const skip = list(o.skip ?? PRESET.skip) ?? [];
const DEVICE = o.device;
const GPU = o.gpu != null ? Number(o.gpu) : null;
const ENV = deviceEnv(DEVICE, GPU);

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const dir = resolve(o["quality-of"] ?? o.out ?? join(HERE, "results", `${stamp}-${o.label ?? PRESET.label}`));
const OUTPUTS = join(dir, "outputs");
const WORK = join(dir, "work");
mkdirSync(OUTPUTS, { recursive: true });
const log = (...a) => {
  const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(l);
  appendFileSync(join(dir, "log.txt"), `${redact(l)}\n`);
};
const record = (file, obj) => appendFileSync(join(dir, file), `${JSON.stringify(obj)}\n`);

// Kill open nvidia-smi dmon processes if interrupted.
const cleanup = () => {
  for (const p of openDmons) p.kill();
};
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => (cleanup(), process.exit(130)));

const videos = VIDEOS.filter((v) => !wantVideos || wantVideos.includes(v.id));
if (o.external) {
  if (!o["external-comp"]) throw new Error("--external needs --external-comp <composition id>");
  const x = externalVideo({ dir: resolve(o.external), entry: o["external-entry"], comp: o["external-comp"], start: Number(o["external-start"]), layersCmd: o["external-layers"] ?? null });
  if (!wantVideos || wantVideos.includes("X")) videos.push(x);
}
const paths = PATHS.filter((p) => !wantPaths || wantPaths.includes(p.id));
const name = (c) => `${c.v.id}-${c.res}-${c.path.id}`;

// Synthetic footage for B and C, and the synthetic project bundled once per run (outside the measurement).
const BUNDLE = join(dir, "bundle");
const prepare = () => {
  if (videos.some((v) => !v.external && v.hasVideo)) {
    for (let k = 0; k < N_TAKES_FOOTAGE; k++) makeFootage({ out: join(HERE, "public", "footage", `take-${k + 1}.mp4`), seconds: TAKE_SECONDS_FOOTAGE, variant: k });
  }
  if (videos.some((v) => !v.external) && !existsSync(join(BUNDLE, "index.html"))) {
    log("bundling the synthetic project");
    bundleProject({ cwd: HERE, entry: "src/index.ts", outDir: BUNDLE, extraArgs: projectArgs(HERE) });
  }
};

const ctxFor = (cell, seconds, suffix) => ({
  v: cell.v,
  res: cell.res,
  seconds,
  bundle: BUNDLE,
  output: join(OUTPUTS, `${name(cell)}-${suffix}.mp4`),
  work: join(WORK, `${name(cell)}-${suffix}`),
  device: DEVICE,
  vulkanDevice: o["vulkan-device"],
});

const execute = async (cell, seconds, suffix, extra) => {
  const ctx = ctxFor(cell, seconds, suffix);
  rmSync(ctx.work, { recursive: true, force: true });
  mkdirSync(ctx.work, { recursive: true });
  const c = cell.path.command(ctx);
  const frames = Math.round(seconds * 30);
  const r = await measureRun({ cmd: c.cmd, args: c.args, cwd: c.cwd, env: { ...ENV, ...c.env }, frames, output: ctx.output, gpu: GPU });
  const steps = c.steps && existsSync(c.steps) ? JSON.parse(readFileSync(c.steps, "utf8")) : null;
  rmSync(ctx.work, { recursive: true, force: true });
  return {
    cell: name(cell),
    video: cell.v.id,
    comp: cell.v.comp,
    res: cell.res,
    path: cell.path.id,
    device: DEVICE,
    seconds,
    frames,
    ...extra,
    ...r,
    cpuPerSecond: r.cpu / seconds,
    steps,
    command: redact([c.cmd, ...c.args].join(" ")),
    file: redact(ctx.output),
  };
};

// ---------- quality ----------

const quality = async (cells) => {
  mkdirSync(WORK, { recursive: true });
  const byVideo = new Map();
  for (const c of cells) {
    const k = `${c.v.id}-${c.res}`;
    if (!byVideo.has(k)) byVideo.set(k, { v: c.v, res: c.res, cells: [] });
    byVideo.get(k).cells.push(c);
  }
  for (const [k, { v, res, cells: cs }] of byVideo) {
    const ref = join(OUTPUTS, `${k}-reference.mov`);
    if (!existsSync(ref)) {
      log(`reference ${k}`);
      const c = referenceCommand({ v, res, seconds: SECONDS, bundle: BUNDLE, output: ref });
      contained(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...ENV } });
    }
    for (const [enc, args] of Object.entries(FLOOR_ENCODERS)) {
      if (DEVICE === "cpu" && /nvenc/.test(enc)) continue;
      const tmp = join(WORK, `${k}-floor.mp4`);
      reencode(ref, tmp, args);
      const q = compareVideos(ref, tmp);
      record("quality.jsonl", { kind: "floor", video: v.id, res, encoder: enc, ...q });
      log(`  floor ${k} ${enc}: SSIM ${q.ssim.toFixed(4)} PSNR ${q.psnr.toFixed(2)}`);
      rmSync(tmp, { force: true });
    }
    for (const c of cs) {
      const file = join(OUTPUTS, `${name(c)}-r1.mp4`);
      if (!existsSync(file)) continue;
      const q = compareVideos(ref, file);
      record("quality.jsonl", { kind: "path", video: v.id, res, path: c.path.id, cell: name(c), ...q });
      log(`  ${name(c)}: SSIM ${q.ssim.toFixed(4)} (worst ${q.ssimMin.toFixed(4)}) PSNR ${q.psnr.toFixed(2)} dB, ${q.frames} frames`);
    }
  }
};

// ---------- run ----------

const cells = [];
for (const v of videos)
  for (const res of v.resolutions.filter((r) => r === "native" || !wantRes || wantRes.includes(r)))
    for (const path of paths) {
      const c = { v, res, path };
      if (skip.includes(name(c))) {
        log(`left out of this run: ${name(c)}`);
        continue;
      }
      try {
        path.command({ ...ctxFor(c, SECONDS, "probe"), output: "/dev/null" });
        cells.push(c);
      } catch (e) {
        if (!(e instanceof NotApplicable)) throw e;
        if (!o["quality-of"]) record("runs.jsonl", { cell: name(c), video: v.id, res, path: path.id, notApplicable: e.message });
        log(`not applicable: ${name(c)}: ${e.message}`);
      }
    }

if (o["quality-of"]) {
  await quality(cells);
  process.exit(0);
}

const config = {
  N,
  seconds: SECONDS,
  warmupSeconds: Number(o["warmup-seconds"] ?? PRESET.warmup),
  seed: Number(o.seed),
  wait: { loadMax: Number(o["load-max"]), busyMax: Number(o["busy-max"]), maxS: Number(o["wait-max"] ?? PRESET.waitMax) },
  cells: cells.map(name),
  paths: PATHS.map(({ id, name: n, description }) => ({ id, name: n, description })),
  resolutions: RESOLUTIONS,
  vmaf: vmafAvailable,
  device: DEVICE,
  gpu: GPU,
  cores: CORES,
  skip,
  preset: PRESET.label,
};
writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
log(`results in ${dir}`);
log(`${cells.length} cells x ${N} repetitions, ${SECONDS} s each, device ${DEVICE}, CPU ceiling ${CORES} cores`);
writeFileSync(join(dir, "environment-start.json"), JSON.stringify(await environment({ projectDir: ROOT, gpu: GPU }), null, 2));
prepare();

const rand = seeded(config.seed);
if (!o["no-warmup"]) {
  log(`warm-up (${config.warmupSeconds} s per cell, discarded)`);
  for (const c of shuffle(cells, rand)) {
    try {
      const x = await execute(c, config.warmupSeconds, "warmup", { warmup: true });
      record("runs.jsonl", x);
      rmSync(join(OUTPUTS, `${name(c)}-warmup.mp4`), { force: true });
      log(`  warm-up ${name(c)}: ${x.wall.toFixed(1)} s`);
    } catch (e) {
      log(`  warm-up ${name(c)} FAILED: ${e.message}\n${e.output ?? ""}`);
      record("runs.jsonl", { cell: name(c), warmup: true, error: e.message, errorOutput: redact(e.output) });
    }
  }
}

for (let rep = 1; rep <= N; rep++) {
  const order = shuffle(cells, rand);
  log(`repetition ${rep}/${N}: ${order.map(name).join(" ")}`);
  for (const [pos, c] of order.entries()) {
    const wait = await waitForQuiet({ ...config.wait, log });
    try {
      const x = await execute(c, SECONDS, `r${rep}`, { repetition: rep, position: pos, wait });
      record("runs.jsonl", x);
      // Only the 1st repetition's output stays (for quality); from the others, only the numbers.
      if (rep > 1) rmSync(join(OUTPUTS, `${name(c)}-r${rep}.mp4`), { force: true });
      const g = x.gpu;
      log(
        `  ${name(c)} r${rep}: CPU ${x.cpu.toFixed(1)} s, wall ${x.wall.toFixed(1)} s, ${x.fps.toFixed(1)} fps, ` +
          `anon ${(x.anonPeakGB ?? 0).toFixed(2)} GB, sm ${g.sm.mean?.toFixed(0)}% enc ${g.enc.mean?.toFixed(0)}% dec ${g.dec.mean?.toFixed(0)}%` +
          `${wait.waitS > 10 ? `, waited ${wait.waitS.toFixed(0)} s` : ""}${wait.timedOut ? " (WAIT TIMED OUT)" : ""}`,
      );
    } catch (e) {
      log(`  ${name(c)} r${rep} FAILED: ${e.message}\n${e.output ?? ""}`);
      record("runs.jsonl", { cell: name(c), video: c.v.id, res: c.res, path: c.path.id, repetition: rep, wait, error: e.message, errorOutput: redact(e.output) });
    }
  }
}
writeFileSync(join(dir, "environment-end.json"), JSON.stringify(await environment({ projectDir: ROOT, gpu: GPU }), null, 2));
rmSync(WORK, { recursive: true, force: true });

if (!o["no-quality"]) {
  log("quality");
  await quality(cells);
  rmSync(WORK, { recursive: true, force: true });
}
const { summary } = analyze(dir);
log(`analysis: ${join(dir, "analysis.md")}`);
log(`to share: ${join(dir, "submission.json")}`);
console.log(summary);
log("end");
