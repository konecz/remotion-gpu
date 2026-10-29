// Path P2, the GPU half: composes a layered render on the GPU, driven by a plan (plan.schema.json).
//   - video takes are decoded on the GPU (Vulkan Video, which uses NVDEC), cropped and positioned per frame by
//     libplacebo from the positions in the plan;
//   - the graphics layer (a PNG sequence with alpha that Remotion rendered without the video) goes on top, same pass;
//   - audio: the plan's audio files mixed by ffmpeg, each at its frame, or a ready WAV/AAC (--audio);
// and encodes with NVENC. It knows nothing about the project: everything comes from the plan.
//
// CLI:
//   node src/layers/render-layers.mjs plan.json --graphics dir --output video.mp4
//     [--from 600 --to 1049]   frame range of the timeline (inclusive)
//     [--audio mix.wav]        ready audio instead of the plan's audio entries
//     [--parallel 2]           segments at the same time (or RGPU_PARALLEL): less wall time, more CPU
//     [--cq 19] [--codec h264|hevc] [--tolerance 0.05] [--vulkan-device 0] [--dry-run]
// The graphics folder holds one PNG per frame of the range, numbered by timeline frame (Remotion's `--sequence`
// names them element-0600.png, ...).
//
// One ffmpeg per segment (one take, or a stretch with no take), then a join without re-encoding: each Vulkan decoder
// has its own frame context, and ffmpeg's concat does not accept frames from different contexts.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ensureContained } from "../contain.mjs";
import { DEFAULT_TOLERANCE, frameExpression } from "./linearize.mjs";
import { assertPlan } from "./validate-plan.mjs";

const FFMPEG = process.env.RGPU_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.RGPU_FFPROBE ?? "ffprobe";

/** Crop of the take (source px) and position on screen (output px) for one frame: only what falls inside the box. */
export const geometry = ([cx, cy, cw, ch], [vx, vy, vw, vh], source) => {
  const x0 = Math.max(0, vx);
  const y0 = Math.max(0, vy);
  const x1 = Math.min(cw, vx + vw);
  const y1 = Math.min(ch, vy + vh);
  const sx = vw / source.w;
  const sy = vh / source.h;
  return {
    crop_x: (x0 - vx) / sx, crop_y: (y0 - vy) / sy, crop_w: (x1 - x0) / sx, crop_h: (y1 - y0) / sy,
    pos_x: cx + x0, pos_y: cy + y0, pos_w: x1 - x0, pos_h: y1 - y0,
  };
};
// For the graphics layer: the whole frame, no crop.
const WHOLE = { crop_x: "0", crop_y: "0", crop_w: "iw", crop_h: "ih", pos_x: "0", pos_y: "0", pos_w: "ow", pos_h: "oh" };

/** PNG color type (byte 25 of the file): 6 = RGBA, 2 = RGB. */
export const pngColorType = (file) => {
  const b = Buffer.alloc(26);
  const fd = openSync(file, "r");
  readSync(fd, b, 0, 26, 0);
  closeSync(fd);
  return b[25];
};

/**
 * Splits the frame range into segments: each take clipped to [from, to] and the gaps between takes (background and
 * graphics only), also split where the PNG color type changes. Chrome writes a fully opaque frame as RGB (no alpha);
 * switching RGBA <-> RGB mid-stream makes ffmpeg rebuild the filter graph, which fails with Vulkan frames.
 * @param {(frame: number) => number} colorType PNG color type of a timeline frame
 */
export const planSegments = (takes, from, to, colorType) => {
  const segments = [];
  const push = (start, n, take) => {
    for (let a = start, q = start + 1; q <= start + n; q++) {
      if (q === start + n || colorType(q) !== colorType(a)) {
        segments.push({ start: a, n: q - a, take });
        a = q;
      }
    }
  };
  let cursor = from;
  for (const take of [...takes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(take.start, from, cursor);
    const end = Math.min(take.start + take.frames - 1, to);
    if (end < start) continue;
    if (start > cursor) push(cursor, start - cursor);
    push(start, end - start + 1, take);
    cursor = end + 1;
  }
  if (cursor <= to) push(cursor, to + 1 - cursor);
  return segments;
};

/**
 * Renders a plan. Returns the list of segments rendered.
 * @param {string} planPath
 * @param {{ graphics: string, output: string, from?: number, to?: number, audio?: string, tolerance?: number,
 *           cq?: string|number, codec?: "h264"|"hevc", parallel?: number, vulkanDevice?: string, dryRun?: boolean,
 *           log?: (s: string) => void }} o
 */
export const renderLayers = async (planPath, o) => {
  const log = o.log ?? console.log;
  const plan = assertPlan(JSON.parse(readFileSync(planPath, "utf8")));
  const base = dirname(resolve(planPath));
  const abs = (f) => (isAbsolute(f) ? f : join(base, f));
  const { width: W, height: H, fps: FPS } = plan;
  const from = Number(o.from ?? 0);
  const to = Number(o.to ?? plan.frames - 1);
  const total = to - from + 1;
  const TOL = Number(o.tolerance ?? DEFAULT_TOLERANCE);
  const dry = !!o.dryRun;

  // With a time ceiling and one retry: on a long render, ffmpeg hung once (all threads waiting, no CPU) and the same
  // command line, repeated, finished in 2 s. The cause was not found.
  const ffmpegAsync = async (args, ceilingMs) => {
    if (dry) return log([FFMPEG, ...args].join(" "));
    for (let attempt = 1; ; attempt++) {
      const p = spawn(FFMPEG, args, { stdio: "inherit" });
      const timer = setTimeout(() => p.kill("SIGKILL"), ceilingMs);
      const [code, signal] = await new Promise((ok, err) => {
        p.on("error", err);
        p.on("close", (c, s) => ok([c, s]));
      });
      clearTimeout(timer);
      if (code === 0) return;
      if (attempt >= 2 || signal !== "SIGKILL") throw new Error(`ffmpeg exited with ${code ?? signal}`);
      log(`ffmpeg passed ${ceilingMs / 1000} s: trying again`);
    }
  };
  const sizeOf = (file) => {
    const [w, h] = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])
      .toString().trim().split(",").map(Number);
    return { w, h };
  };

  // Graphics: one PNG per frame of the range, numbered by timeline frame.
  const pngs = readdirSync(o.graphics).filter((f) => f.endsWith(".png")).sort();
  if (pngs.length !== total) throw new Error(`${pngs.length} PNG files in ${o.graphics}, expected ${total} (frames ${from}-${to})`);
  const firstNumber = Number(pngs[0].match(/(\d+)\.png$/)?.[1]);
  if (firstNumber !== from) throw new Error(`the first PNG is ${pngs[0]}, expected frame ${from}`);
  const colorType = (q) => pngColorType(join(o.graphics, pngs[q - from]));

  const segments = planSegments(plan.takes.map((t) => ({ ...t, file: abs(t.file) })), from, to, colorType);

  const bg = plan.background.replace("#", "0x");
  // Everything is tagged "linear" (and re-tagged BT.709 at the output): libplacebo blends and scales in linear light,
  // Chrome blends gamma-encoded values. Saying the values are already linear, libplacebo converts nothing and blends
  // like Chrome; with the true curve, semi-transparent graphics came out washed out (SSIM 0.944 vs 0.958). Video and
  // graphics share the same space (BT.709 / sRGB primaries).
  const color = "colorspace=bt709:color_primaries=bt709:color_trc=linear:range=tv";
  const colorGraphics = "colorspace=gbr:color_primaries=bt709:color_trc=linear:range=pc";
  const encoder = o.codec === "hevc" ? "hevc_nvenc" : "h264_nvenc";
  const videoOut = [
    "-c:v", encoder, "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", String(o.cq ?? 19), "-b:v", "0",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  ];
  const vk = o.vulkanDevice != null && o.vulkanDevice !== "" ? `vulkan=vk:${o.vulkanDevice}` : "vulkan=vk";

  const dir = `${o.output}.segments`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = [];
  const jobs = [];
  segments.forEach((s, i) => {
    const file = join(dir, `${String(i).padStart(3, "0")}.mp4`);
    list.push(`file '${file}'`);
    // libplacebo inputs, bottom to top: the solid background (covers the whole frame, so libplacebo never has to clear
    // the target, which fails with Vulkan frames), the take (if any) and the graphics.
    const inputs = ["-f", "lavfi", "-i", `color=c=${bg}:s=${W}x${H}:r=${FPS}`];
    const graph = [`[0:v]format=yuv420p,setparams=${color},hwupload[c0]`];
    let expr = WHOLE;
    if (s.take) {
      const k0 = s.start - s.take.start;
      const source = sizeOf(s.take.file);
      const g = s.take.box.slice(k0, k0 + s.n).map((b, j) => geometry(b, s.take.video[k0 + j], source));
      const ex = Object.fromEntries(Object.keys(g[0]).map((k) => [k, frameExpression(g.map((q) => q[k]), FPS, TOL)]));
      expr = Object.fromEntries(Object.entries(ex).map(([k, { expr: e }]) => [k, `if(eq(idx,1),${e},${WHOLE[k]})`]));
      log(`segment ${i}: ${s.take.file.split("/").at(-1)}, frames ${s.start}-${s.start + s.n - 1}, ${Math.max(...Object.values(ex).map((x) => x.segments))} straight segments`);
      inputs.push("-threads", "1", "-ss", String((s.take.from ?? 0) + k0 / FPS), "-hwaccel", "vulkan", "-hwaccel_output_format", "vulkan", "-i", s.take.file);
      // The take may be shorter than the segment: the last frame holds (tpad). Convert the take's frame rate to the
      // output's BEFORE libplacebo, rounding up: that picks the same source frame as Remotion's video components (the
      // default, nearest, was wrong on 2 of every 6 frames going 25 -> 30 fps). start_time=0 repeats the first frame
      // if the -ss cut falls between two source frames (otherwise the first output frame has no take).
      graph.push(`[1:v]setparams=${color},tpad=stop_mode=clone:stop_duration=${s.n / FPS + 1},fps=${FPS}:round=up:start_time=0[c1]`);
    } else log(`segment ${i}: background only, frames ${s.start}-${s.start + s.n - 1}`);
    const gi = inputs.filter((a) => a === "-i").length;
    // A concat list with exactly this segment's PNG files: with a numbered pattern, ffmpeg read ahead into the next one.
    const pngList = `${file}.png.txt`;
    writeFileSync(
      pngList,
      ["ffconcat version 1.0", ...pngs.slice(s.start - from, s.start - from + s.n).map((f) => `file '${resolve(o.graphics, f)}'\nduration ${1 / FPS}`)].join("\n"),
    );
    inputs.push("-threads", "1", "-f", "concat", "-safe", "0", "-i", pngList);
    graph.push(
      `[${gi}:v]format=rgba,setparams=${colorGraphics},hwupload[c${gi}]`,
      `${Array.from({ length: gi + 1 }, (_, k) => `[c${k}]`).join("")}libplacebo=inputs=${gi + 1}:w=${W}:h=${H}:fps=${FPS}:format=yuv420p:${color}:` +
        Object.entries(expr).map(([k, e]) => `${k}='${e}'`).join(":") +
        `,setparams=color_trc=bt709,hwupload=derive_device=cuda[v]`,
    );
    writeFileSync(`${file}.graph.txt`, graph.join(";\n"));
    jobs.push({
      n: s.n,
      run: () =>
        ffmpegAsync(
          ["-hide_banner", "-v", "error", "-y", "-init_hw_device", vk, "-filter_hw_device", "vk",
            ...inputs, "-/filter_complex", `${file}.graph.txt`, "-map", "[v]", "-frames:v", String(s.n), ...videoOut, file],
          Math.max(60_000, s.n * 200), // 0.2 s per frame is a hang: normal is well above 100 fps
        ),
    });
  });
  // Segments in parallel, at most `parallel` at a time, longest first (wall time ends with the longest one). Only
  // wall time drops; CPU goes up (the ffmpeg processes contend). Each extra ffmpeg holds ~1.3 GB of VRAM.
  const queue = [...jobs].sort((a, b) => b.n - a.n);
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) await j.run();
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(o.parallel ?? 1)) }, worker));

  // Audio of the range: a ready file (--audio) or the mix of the plan's audio entries, with silence up to the end of
  // the range (apad). Mixing here costs a fraction of a second; rendering a WAV with Remotion renders the whole
  // composition again just to sum the audio.
  const audioIn = [];
  let audioGraph = null;
  if (o.audio) audioIn.push("-ss", String(from / FPS), "-i", o.audio);
  else if (plan.audio?.length) {
    const t = (q) => (q / FPS).toFixed(6);
    const parts = plan.audio.map((a, i) => {
      audioIn.push("-i", abs(a.file));
      const vol = a.fadeOut
        ? `volume='${a.volume ?? 1}*clip((${t(a.fadeOut[1])}-t)/${t(Math.max(1, a.fadeOut[1] - a.fadeOut[0]))},0,1)':eval=frame`
        : `volume=${a.volume ?? 1}`;
      const start = a.from ?? 0;
      return (
        `[${i + 1}:a]aresample=48000,atrim=start=${start.toFixed(6)}:end=${(start + a.frames / FPS).toFixed(6)},asetpts=PTS-STARTPTS,` +
        `${vol},adelay=${Math.round((a.start / FPS) * 48000)}S:all=1[a${i}]`
      );
    });
    audioGraph = [
      ...parts,
      `${plan.audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${plan.audio.length}:normalize=0:duration=longest,apad,` +
        `atrim=${(from / FPS).toFixed(6)}:${((to + 1) / FPS).toFixed(6)},asetpts=PTS-STARTPTS[a]`,
    ].join(";\n");
    writeFileSync(join(dir, "audio.txt"), audioGraph);
  }

  // Join without re-encoding, with the audio of the range.
  writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\n`);
  const joinArgs = [
    "-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), ...audioIn,
    ...(audioGraph ? ["-/filter_complex", join(dir, "audio.txt"), "-map", "0:v", "-map", "[a]"] : audioIn.length ? ["-map", "0:v", "-map", "1:a"] : []),
    "-c:v", "copy", ...(audioIn.length ? ["-c:a", "aac", "-b:a", "192k"] : []), "-t", String(total / FPS), "-movflags", "+faststart", o.output,
  ];
  if (dry) log([FFMPEG, ...joinArgs].join(" "));
  else {
    execFileSync(FFMPEG, joinArgs, { stdio: "inherit" });
    rmSync(dir, { recursive: true, force: true });
  }
  return segments.map(({ start, n, take }) => ({ start, frames: n, take: take?.file ?? null }));
};

const main = async () => {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      graphics: { type: "string" },
      audio: { type: "string" },
      output: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      tolerance: { type: "string", default: String(DEFAULT_TOLERANCE) },
      cq: { type: "string", default: "19" },
      codec: { type: "string", default: "h264" },
      // Default 1: measured on a 75 s video, 2 at a time cut 28% of the ffmpeg wall time but cost 20% more CPU.
      parallel: { type: "string", default: process.env.RGPU_PARALLEL ?? "1" },
      "vulkan-device": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!positionals[0] || !o.graphics || !o.output) {
    console.error("usage: node src/layers/render-layers.mjs plan.json --graphics dir --output video.mp4 [--from N --to N] [--audio file] [--parallel N]");
    process.exit(2);
  }
  ensureContained();
  await renderLayers(positionals[0], {
    graphics: o.graphics, output: o.output, from: o.from, to: o.to, audio: o.audio, tolerance: o.tolerance, cq: o.cq,
    codec: o.codec, parallel: o.parallel, vulkanDevice: o["vulkan-device"], dryRun: o["dry-run"],
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
