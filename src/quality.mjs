// Quality of an output against a reference: both are converted to RGB (gbrp), each by its own color tags (untagged
// video is read as BT.601, Remotion's default), and compared frame by frame: SSIM (mean, worst frame, 1st percentile)
// and PSNR (from the mean MSE). VMAF only if the ffmpeg build has libvmaf. Frames are paired by index (setpts), so
// two outputs with different timestamps but the same frame count still line up.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containPrefix } from "./contain.mjs";

const FFMPEG = process.env.RGPU_FFMPEG ?? "ffmpeg";

export const vmafAvailable = (() => {
  try {
    return execFileSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("libvmaf");
  } catch {
    return false;
  }
})();

const run = (args, options = {}) => {
  const p = containPrefix();
  return execFileSync(p[0] ?? FFMPEG, p.length ? [...p.slice(1), FFMPEG, ...args] : args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", ...options });
};

/**
 * Compares `dist` with `ref`.
 * @param {{ fps?: number }} [o] frame rate used to pair frames by index
 * @returns {{ frames: number, ssim: number, ssimMin: number, ssimP01: number, psnr: number, psnrMin: number, vmaf: number|null }}
 */
export const compareVideos = (ref, dist, { fps = 30 } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "rgpu-quality-"));
  try {
    const s = join(dir, "ssim.log");
    const p = join(dir, "psnr.log");
    const graph = [
      `[0:v]setpts=N/(${fps}*TB),format=gbrp,split=2[r1][r2]`,
      `[1:v]setpts=N/(${fps}*TB),format=gbrp,split=2[d1][d2]`,
      `[d1][r1]ssim=stats_file=${s}`,
      `[d2][r2]psnr=stats_file=${p}`,
    ];
    run(["-hide_banner", "-v", "error", "-i", ref, "-i", dist, "-filter_complex", graph.join(";"), "-f", "null", "-"]);
    const ssims = readFileSync(s, "utf8").trim().split("\n").map((l) => Number(l.match(/All:([\d.]+)/)[1]));
    const mses = readFileSync(p, "utf8").trim().split("\n").map((l) => Number(l.match(/mse_avg:([\d.]+)/)[1]));
    const psnr = (mse) => (mse === 0 ? 100 : 10 * Math.log10((255 * 255) / mse));
    const sorted = [...ssims].sort((a, b) => a - b);
    let vmaf = null;
    if (vmafAvailable) {
      const out = run(["-hide_banner", "-i", dist, "-i", ref, "-lavfi", `[0:v]setpts=N/(${fps}*TB)[d];[1:v]setpts=N/(${fps}*TB)[r];[d][r]libvmaf`, "-f", "null", "-"]);
      vmaf = Number(out.match(/VMAF score: ([\d.]+)/)?.[1] ?? Number.NaN);
    }
    return {
      frames: ssims.length,
      ssim: ssims.reduce((a, b) => a + b, 0) / ssims.length,
      ssimMin: sorted[0],
      ssimP01: sorted[Math.floor(sorted.length * 0.01)],
      psnr: psnr(mses.reduce((a, b) => a + b, 0) / mses.length),
      psnrMin: Math.min(...mses.map(psnr)),
      vmaf,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Noise floor: the reference re-encoded by each path's encoder, nothing else changed. Separates the encoder's loss
 * from the path's (choice of source frame, scaling, blending).
 */
export const FLOOR_ENCODERS = {
  "libx264 CRF 18 (P0)": ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"],
  "h264_nvenc 12M (P1)": ["-c:v", "h264_nvenc", "-b:v", "12M", "-pix_fmt", "yuv420p"],
  "h264_nvenc CQ 19 p7 (P2)": ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p"],
};

/** Re-encodes `ref` with `args` (for the noise floor). */
export const reencode = (ref, output, args) => run(["-hide_banner", "-v", "error", "-y", "-i", ref, "-an", "-fps_mode", "passthrough", ...args, output]);
