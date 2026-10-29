// Path P1: Remotion renders straight to MP4 with the GPU encoder (NVENC), Chrome paints with Vulkan, and the
// composition uses <Video> from @remotion/media instead of <OffthreadVideo>.
//
// Measured on a 15 s clip with a presenter video (see the paper in this repo): against <OffthreadVideo> + a JPEG
// sequence + a separate ffmpeg pass, CPU went from 346 s to ~118 s. Split by cause: <Video> -39%, no JPEG on disk and
// no separate audio pass -16%, NVENC instead of libx264 -35%.
//
// In the composition, use:
//   import { Video } from "@remotion/media";
//   <Video src={staticFile("take.mp4")} disallowFallbackToOffthreadVideo />
// `disallowFallbackToOffthreadVideo` makes the render fail instead of silently falling back to the CPU-heavy
// OffthreadVideo compositor. Note: <Video> still decodes on the CPU (WebCodecs in software inside headless Chrome);
// only path P2 (layers) decodes on the GPU.
import { createRequire } from "node:module";
import { join } from "node:path";

/** Default bitrate for NVENC. With hardware acceleration Remotion rejects --crf, so quality goes by bitrate. */
export const DEFAULT_BITRATE = process.env.RGPU_BITRATE ?? "12M";

/**
 * Remotion CLI flags for an MP4 encoded by NVENC. "required" makes the render fail instead of silently falling back
 * to libx264. Do not add --crf: Remotion refuses it together with hardware acceleration.
 * @param {{ bitrate?: string, codec?: "h264" | "h265" }} [o]
 */
export const nvencArgs = ({ bitrate = DEFAULT_BITRATE, codec = "h264" } = {}) => [
  `--codec=${codec}`,
  "--hardware-acceleration=required",
  `--video-bitrate=${bitrate}`,
  "--image-format=jpeg",
  "--jpeg-quality=95",
];

/** Chrome paints with Vulkan on the GPU (without it, it may fall back to SwiftShader on the CPU). */
export const gpuChromeArgs = () => ["--gl=vulkan"];

/** CPU-only counterpart of P1: same <Video>, software GL, Remotion's default libx264. */
export const cpuArgs = ({ crf = 18 } = {}) => ["--gl=swangle", "--codec=h264", `--crf=${crf}`, "--image-format=jpeg", "--jpeg-quality=95"];

/**
 * All P1 flags for a device.
 * @param {"nvidia" | "cpu"} [device]
 */
export const p1Args = (device = "nvidia", o = {}) => (device === "cpu" ? cpuArgs(o) : [...gpuChromeArgs(), ...nvencArgs(o)]);

/**
 * Path of the Remotion CLI entry (remotion-cli.js) as resolved from `fromDir`, to run it under `node --require`
 * (the dedup patch must load in the same process as the CLI).
 * @param {string} fromDir
 */
export const remotionCliPath = (fromDir) => {
  const req = createRequire(join(fromDir, "package.json"));
  return join(req.resolve("@remotion/cli/package.json"), "..", "remotion-cli.js");
};

/**
 * Flags that point Remotion at a project folder that has no package.json of its own (as in this repo's examples):
 * Remotion otherwise takes the nearest package.json as the project root and looks for public/ and the config there.
 * @param {string} dir project folder with public/ and remotion.config.ts
 */
export const projectArgs = (dir) => [`--public-dir=${join(dir, "public")}`, `--config=${join(dir, "remotion.config.ts")}`];

/** Absolute path of the dedup patch (src/dedup/remotion-dedup.cjs). */
export const DEDUP_PATCH = new URL("./dedup/remotion-dedup.cjs", import.meta.url).pathname;

/**
 * Command to run the Remotion CLI, optionally with the dedup patch preloaded.
 * @param {{ cwd: string, dedup?: boolean }} o
 * @returns {{ cmd: string, args: string[] }} prepend to the CLI arguments ("render", entry, ...)
 */
export const remotionCommand = ({ cwd, dedup = false }) => ({
  cmd: process.execPath,
  args: [...(dedup ? ["--require", DEDUP_PATCH] : []), remotionCliPath(cwd)],
});
