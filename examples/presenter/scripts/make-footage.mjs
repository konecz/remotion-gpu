// Generates SYNTHETIC "presenter" footage with ffmpeg: no real person, no third-party media. A moving color gradient
// (texture across the whole frame), a test pattern (testsrc2) drifting around the point of interest where a face
// would be, a grid, and a two-tone audio track with a slow tremolo. 25 fps on purpose: real takes are often 25 fps and
// the layered render must convert to 30 fps exactly like Remotion does (fps=30:round=up).
//
// Usage: node examples/presenter/scripts/make-footage.mjs [--out file.mp4] [--seconds 12] [--variant 0]
//          [--size 1920x1080] [--fps 25] [--force]
// Encodes with h264_nvenc when available (else libx264), keyframe every second, AAC audio. Runs contained.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { contained } from "../../../src/contain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FOOTAGE = resolve(HERE, "..", "public", "footage", "presenter.mp4");

const PALETTES = [
  ["0x1d4ed8", "0x0f766e", "0xc9a227", "0x7c3aed"],
  ["0xb91c1c", "0xea580c", "0x0e7490", "0x4d7c0f"],
  ["0x334155", "0x9333ea", "0x0891b2", "0xd97706"],
  ["0x065f46", "0x1e40af", "0xbe185d", "0xca8a04"],
];

const hasNvenc = () =>
  spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=256x144:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-"]).status === 0;

/**
 * Writes one synthetic take.
 * @param {{ out?: string, seconds?: number, variant?: number, size?: string, fps?: number, force?: boolean }} [o]
 */
export const makeFootage = ({ out = DEFAULT_FOOTAGE, seconds = 12, variant = 0, size = "1920x1080", fps = 25, force = false } = {}) => {
  if (!force && existsSync(out) && statSync(out).size > 0) return out;
  mkdirSync(dirname(out), { recursive: true });
  const [W, H] = size.split("x").map(Number);
  const u = W / 1920;
  const [c0, c1, c2, c3] = PALETTES[variant % PALETTES.length];
  const pw = Math.round(640 * u / 2) * 2;
  const ph = Math.round(360 * u / 2) * 2;
  // The "subject" (test pattern) drifts slowly around (1060, 560) of a 1920x1080 frame: the framing's focus point.
  const fx = 1060 * u - pw / 2;
  const fy = 560 * u - ph / 2;
  const ph0 = variant * 1.7;
  const graph = [
    `gradients=s=${W}x${H}:r=${fps}:d=${seconds}:speed=0.012:c0=${c0}:c1=${c1}:c2=${c2}:c3=${c3}:nb_colors=4:seed=${7 + variant}[bg]`,
    `testsrc2=s=${pw}x${ph}:r=${fps}:d=${seconds}[subj]`,
    `[bg]drawgrid=w=${Math.round(120 * u)}:h=${Math.round(120 * u)}:t=${Math.max(1, Math.round(2 * u))}:c=white@0.18[grid]`,
    `[grid][subj]overlay=x='${fx.toFixed(1)}+${(60 * u).toFixed(1)}*sin(t*0.9+${ph0})':y='${fy.toFixed(1)}+${(30 * u).toFixed(1)}*sin(t*1.3+${ph0})':shortest=1,` +
      `drawbox=x=${Math.round(fx - 12 * u)}:y=${Math.round(fy - 12 * u)}:w=${pw + Math.round(24 * u)}:h=${ph + Math.round(24 * u)}:color=white@0.5:t=${Math.max(1, Math.round(3 * u))},format=yuv420p[v]`,
    `aevalsrc='0.18*sin(2*PI*${220 + variant * 20}*t)*(0.6+0.4*sin(2*PI*1.5*t))|0.18*sin(2*PI*${330 + variant * 20}*t)*(0.6+0.4*sin(2*PI*1.5*t+1))':s=48000:d=${seconds}[a]`,
  ].join(";");
  const video = hasNvenc()
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
  contained("ffmpeg", [
    "-hide_banner", "-v", "error", "-y", "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
    ...video, "-g", String(fps), "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "160k", "-t", String(seconds), "-movflags", "+faststart", out,
  ]);
  return out;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({
    options: {
      out: { type: "string" },
      seconds: { type: "string", default: "12" },
      variant: { type: "string", default: "0" },
      size: { type: "string", default: "1920x1080" },
      fps: { type: "string", default: "25" },
      force: { type: "boolean", default: false },
    },
  });
  const file = makeFootage({
    out: o.out ? resolve(o.out) : undefined, seconds: Number(o.seconds), variant: Number(o.variant), size: o.size, fps: Number(o.fps), force: o.force,
  });
  console.log(`footage: ${file}`);
}
