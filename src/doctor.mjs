// Checks what this machine can do for GPU rendering of Remotion videos, and which paths it supports:
//   P1  Remotion renders and encodes with NVENC (needs the NVIDIA driver, Remotion's bundled ffmpeg with h264_nvenc,
//       its Chrome; Vulkan for --gl=vulkan is recommended);
//   P2  layered render: Remotion renders graphics only, the system ffmpeg decodes with Vulkan Video (NVDEC),
//       composites with libplacebo and encodes with NVENC.
// The parsers are pure and exported for tests; `runDoctor` runs the commands and small functional probes (a few
// frames each, under nice 19).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

// ---------- parsers (pure) ----------

/** "ffmpeg version 8.0.1-3ubuntu2 Copyright ..." -> { version: "8.0.1-3ubuntu2", major: 8 } */
export const parseFfmpegVersion = (text) => {
  const m = String(text).match(/ffmpeg version (\S+)/);
  if (!m) return null;
  const major = Number(m[1].match(/^n?(\d+)/)?.[1]);
  return { version: m[1], major: Number.isFinite(major) ? major : null };
};

/** Names from `ffmpeg -encoders` / `-decoders` (lines like " V....D h264_nvenc   NVIDIA NVENC ..."). */
export const parseCodecList = (text) =>
  new Set(
    String(text)
      .split("\n")
      .map((l) => l.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)/)?.[1])
      .filter(Boolean),
  );

/** Names from `ffmpeg -filters` (lines like " .. libplacebo   N->V  Apply ..."). */
export const parseFilterList = (text) =>
  new Set(
    String(text)
      .split("\n")
      .map((l) => l.match(/^\s*[T.][S.C]?\s+(\S+)\s+\S+->\S+/)?.[1])
      .filter(Boolean),
  );

/** Methods from `ffmpeg -hwaccels`. */
export const parseHwaccels = (text) =>
  String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Hardware acceleration methods/i.test(l));

/** `nvidia-smi --query-gpu=index,name,driver_version,memory.used,memory.total --format=csv,noheader,nounits` */
export const parseNvidiaSmi = (text) =>
  String(text)
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [index, name, driver, used, total] = l.split(",").map((s) => s.trim());
      return { index: Number(index), name, driver, vramUsedMB: Number(used), vramTotalMB: Number(total) };
    });

/** Devices from `vulkaninfo --summary`. */
export const parseVulkanSummary = (text) => {
  const devices = [];
  let cur = null;
  for (const l of String(text).split("\n")) {
    const gpu = l.match(/^GPU(\d+):/);
    if (gpu) devices.push((cur = { index: Number(gpu[1]) }));
    else if (cur) {
      const kv = l.match(/^\s+(\w+)\s*=\s*(.+)$/);
      if (kv) cur[kv[1]] = kv[2].trim();
      else if (l.trim() && !/^\s/.test(l)) cur = null;
    }
  }
  return devices.map((d) => ({
    index: d.index,
    name: d.deviceName,
    type: d.deviceType?.replace("PHYSICAL_DEVICE_TYPE_", "").toLowerCase(),
    driver: d.driverName,
    driverInfo: d.driverInfo,
    apiVersion: d.apiVersion,
    nvidia: d.vendorID === "0x10de" || /NVIDIA/i.test(d.driverName ?? ""),
  }));
};

/** Vulkan Video extensions mentioned anywhere in the full `vulkaninfo` output. */
export const parseVulkanVideoExtensions = (text) => [...new Set(String(text).match(/VK_KHR_video_[a-z0-9_]+/g) ?? [])].sort();

/**
 * Which paths the machine supports, from the collected checks.
 * @returns {{ P1: { ok: boolean, missing: string[], warnings: string[] }, P2: {...}, cpu: {...} }}
 */
export const decidePaths = (c) => {
  const P1 = { ok: true, missing: [], warnings: [] };
  const P2 = { ok: true, missing: [], warnings: [] };
  const need = (p, cond, msg) => {
    if (!cond) {
      p.ok = false;
      p.missing.push(msg);
    }
  };
  const warn = (p, cond, msg) => {
    if (!cond) p.warnings.push(msg);
  };
  // P1
  need(P1, c.remotion?.installed, "Remotion is not installed here (npm install)");
  need(P1, c.nvidia?.gpus?.length > 0, "no NVIDIA GPU/driver (nvidia-smi)");
  need(P1, c.remotion?.compositorNvenc?.ok, "Remotion's bundled ffmpeg cannot encode with h264_nvenc");
  warn(P1, c.remotion?.chrome?.found, "Remotion's Chrome is not downloaded yet: `npx remotion browser ensure` (or it downloads on the first render)");
  warn(P1, c.vulkan?.devices?.some((d) => d.nvidia), "no NVIDIA Vulkan device: use --gl=angle instead of --gl=vulkan");
  warn(P1, c.remotion?.version === "4.0.536", `Remotion ${c.remotion?.version ?? "?"}: flags verified on 4.0.536 only`);
  // P2
  need(P2, c.ffmpeg?.found, "no ffmpeg in PATH");
  need(P2, (c.ffmpeg?.version?.major ?? 0) >= 7, "ffmpeg 7 or newer is needed (libplacebo expressions, Vulkan Video)");
  need(P2, c.ffmpeg?.encoders?.includes("h264_nvenc"), "ffmpeg has no h264_nvenc");
  need(P2, c.ffmpeg?.filters?.includes("libplacebo"), "ffmpeg was built without libplacebo");
  need(P2, c.ffmpeg?.hwaccels?.includes("vulkan"), "ffmpeg has no Vulkan hwaccel");
  need(P2, c.vulkan?.devices?.some((d) => d.nvidia), "no NVIDIA Vulkan device (vulkaninfo)");
  need(P2, c.vulkan?.videoExtensions?.includes("VK_KHR_video_decode_h264"), "Vulkan Video H.264 decode (NVDEC) not exposed");
  need(P2, c.probes?.nvenc?.ok, "NVENC encode probe failed");
  need(P2, c.probes?.vulkanDecode?.ok, "Vulkan Video decode probe failed (decode would fall back to the CPU)");
  need(P2, c.probes?.libplacebo?.ok, "libplacebo -> CUDA -> NVENC probe failed");
  need(P2, c.remotion?.installed, "Remotion is not installed here (npm install)");
  warn(P2, c.remotion?.version === "4.0.536", "the dedup patch only runs on Remotion 4.0.536 (set RGPU_DEDUP=0 on other versions)");
  warn(P2, c.ffmpeg?.encoders?.includes("hevc_nvenc"), "ffmpeg has no hevc_nvenc (only h264 output)");
  for (const p of [P1, P2]) warn(p, c.containment?.ceiling !== "none", "no CPU ceiling available (no systemd user scope, no taskset): renders can take every core");
  return { P1, P2, cpu: { ok: true, missing: [], warnings: [] } };
};

// ---------- running the checks ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A solid gray RGB PNG, built in memory (Remotion's ffmpeg has no lavfi sources to make test frames). */
export const grayPng = (w, h, v = 128) => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, v)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

const run = (cmd, args, { timeout = 30_000, env, input } = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024, input });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.code };
};
const niced = (cmd, args, o) => run("nice", ["-n", "19", cmd, ...args], o);
const tail = (s, n = 300) => String(s).trim().split("\n").slice(-3).join(" | ").slice(-n);

/** Finds a package directory from `dir` upward. */
const findUp = (dir, rel) => {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, rel))) return join(d, rel);
    if (dirname(d) === d) return null;
  }
};

/**
 * Collects every check. `cwd` is the Remotion project (where node_modules is).
 * @param {{ cwd?: string, ffmpeg?: string, probes?: boolean }} [o]
 */
export const runDoctor = async ({ cwd = process.cwd(), ffmpeg = process.env.RGPU_FFMPEG ?? "ffmpeg", probes = true } = {}) => {
  const c = { cwd };

  // ffmpeg (system): used by path P2
  const v = run(ffmpeg, ["-hide_banner", "-version"]);
  c.ffmpeg = { found: v.ok, path: ffmpeg };
  if (v.ok) {
    c.ffmpeg.version = parseFfmpegVersion(v.stdout);
    c.ffmpeg.encoders = [...parseCodecList(run(ffmpeg, ["-hide_banner", "-encoders"]).stdout)].filter((e) => /nvenc|vulkan|vaapi|qsv|amf/.test(e));
    c.ffmpeg.filters = [...parseFilterList(run(ffmpeg, ["-hide_banner", "-filters"]).stdout)].filter((f) => /libplacebo|_cuda|_vulkan|libvmaf|^ssim$|^psnr$/.test(f));
    c.ffmpeg.hwaccels = parseHwaccels(run(ffmpeg, ["-hide_banner", "-hwaccels"]).stdout);
  }

  // NVIDIA driver and GPU
  const smi = run("nvidia-smi", ["--query-gpu=index,name,driver_version,memory.used,memory.total", "--format=csv,noheader,nounits"]);
  c.nvidia = { found: smi.ok, gpus: smi.ok ? parseNvidiaSmi(smi.stdout) : [] };
  if (smi.ok) {
    const apps = run("nvidia-smi", ["--query-compute-apps=process_name,used_memory", "--format=csv,noheader,nounits"]);
    c.nvidia.otherProcesses = apps.stdout.trim().split("\n").filter(Boolean).map((l) => {
      const [name, mem] = l.split(",").map((s) => s.trim());
      return { name: name.split("/").at(-1), memMB: Number(mem) };
    });
  }

  // Vulkan
  const vs = run("vulkaninfo", ["--summary"]);
  c.vulkan = { found: vs.ok, devices: vs.ok ? parseVulkanSummary(vs.stdout) : [] };
  if (vs.ok) c.vulkan.videoExtensions = parseVulkanVideoExtensions(run("vulkaninfo", []).stdout);

  // Remotion: version, its Chrome and its bundled ffmpeg (used by path P1)
  const pkg = findUp(cwd, "node_modules/remotion/package.json");
  c.remotion = { installed: !!pkg, version: pkg ? JSON.parse(readFileSync(pkg, "utf8")).version : null };
  if (pkg) {
    const nm = dirname(dirname(pkg));
    const chromeDir = join(nm, ".remotion", "chrome-headless-shell");
    const bin = [
      join(chromeDir, "linux64", "chrome-headless-shell-linux64", "chrome-headless-shell"),
      join(chromeDir, "linux-arm64", "chrome-headless-shell-linux-arm64", "chrome-headless-shell"),
    ].find(existsSync);
    c.remotion.chrome = { found: !!bin, version: bin ? run(bin, ["--version"]).stdout.trim() || null : null };
    const comp = ["compositor-linux-x64-gnu", "compositor-linux-arm64-gnu", "compositor-linux-x64-musl"]
      .map((d) => join(nm, "@remotion", d, "ffmpeg"))
      .find(existsSync);
    c.remotion.compositor = comp ? comp.replace(nm, "node_modules") : null;
    if (comp) {
      const enc = parseCodecList(run(comp, ["-hide_banner", "-encoders"]).stdout);
      c.remotion.compositorNvenc = { listed: enc.has("h264_nvenc"), ok: false };
      if (enc.has("h264_nvenc") && probes) {
        // Remotion's ffmpeg has no lavfi sources: pipe 6 PNG frames, as Remotion itself pipes captured frames.
        const png = grayPng(256, 144);
        const p = niced(comp, ["-hide_banner", "-v", "error", "-f", "image2pipe", "-framerate", "30", "-c:v", "png", "-i", "-", "-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", "-f", "null", "-"], {
          input: Buffer.concat(Array(6).fill(png)),
        });
        c.remotion.compositorNvenc = { listed: true, ok: p.ok, error: p.ok ? undefined : tail(p.stderr) };
      }
    }
  }

  // Containment
  const scope = run("systemd-run", ["--user", "--scope", "--quiet", "true"]);
  const taskset = run("taskset", ["--version"]);
  c.containment = {
    systemdUserScope: scope.ok,
    taskset: taskset.ok,
    ceiling: scope.ok ? "cgroup (systemd-run --user --scope -p CPUQuota)" : taskset.ok ? "taskset (core pinning)" : "none",
  };

  // Functional probes for P2: the exact operations of render-layers.mjs, a few frames each.
  c.probes = {};
  if (probes && c.ffmpeg.found) {
    const dir = mkdtempSync(join(tmpdir(), "rgpu-doctor-"));
    try {
      const tiny = join(dir, "tiny.mp4");
      const nvenc = niced(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=0.4", "-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", tiny]);
      c.probes.nvenc = { ok: nvenc.ok, error: nvenc.ok ? undefined : tail(nvenc.stderr) };
      if (!nvenc.ok) niced(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", tiny]);
      // Strict: hwdownload fails if the decoder silently fell back to software frames.
      const dec = niced(ffmpeg, ["-hide_banner", "-v", "error", "-init_hw_device", "vulkan=vk", "-hwaccel", "vulkan", "-hwaccel_output_format", "vulkan", "-i", tiny, "-vf", "hwdownload,format=nv12", "-f", "null", "-"]);
      c.probes.vulkanDecode = { ok: dec.ok, error: dec.ok ? undefined : tail(dec.stderr) };
      const pl = niced(ffmpeg, [
        "-hide_banner", "-v", "error", "-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=0.2",
        "-vf", "format=yuv420p,hwupload,libplacebo=w=320:h=180:format=yuv420p,hwupload=derive_device=cuda", "-c:v", "h264_nvenc", "-f", "null", "-",
      ]);
      c.probes.libplacebo = { ok: pl.ok, error: pl.ok ? undefined : tail(pl.stderr) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  c.paths = decidePaths(c);
  return c;
};

/** Human-readable report. */
export const formatReport = (c) => {
  const L = [];
  const mark = (ok) => (ok ? "[ok]" : "[--]");
  const ff = c.ffmpeg;
  L.push("ffmpeg (system, used by P2)");
  L.push(`  ${mark(ff.found)} ${ff.found ? `version ${ff.version?.version}` : "not found in PATH"}`);
  if (ff.found) {
    for (const e of ["h264_nvenc", "hevc_nvenc"]) L.push(`  ${mark(ff.encoders.includes(e))} encoder ${e}`);
    L.push(`  ${mark(ff.filters.includes("libplacebo"))} filter libplacebo`);
    L.push(`  ${mark(ff.hwaccels.includes("vulkan"))} hwaccel vulkan   ${mark(ff.hwaccels.includes("cuda"))} hwaccel cuda`);
    L.push(`  ${ff.filters.includes("libvmaf") ? "[ok]" : "[..]"} filter libvmaf (optional, for VMAF in the benchmark)`);
  }
  L.push("NVIDIA");
  if (!c.nvidia.gpus.length) L.push("  [--] no NVIDIA GPU or driver (nvidia-smi)");
  for (const g of c.nvidia.gpus) L.push(`  [ok] GPU ${g.index}: ${g.name}, driver ${g.driver}, VRAM ${g.vramUsedMB}/${g.vramTotalMB} MB used`);
  for (const p of c.nvidia.otherProcesses ?? []) L.push(`  [..] other GPU process: ${p.name} (${p.memMB} MB)`);
  L.push("Vulkan");
  if (!c.vulkan.found) L.push("  [--] vulkaninfo not found (install vulkan-tools)");
  for (const d of c.vulkan.devices) L.push(`  ${d.nvidia ? "[ok]" : "[..]"} device ${d.index}: ${d.name} (${d.type}, ${d.driver})`);
  if (c.vulkan.found) L.push(`  ${mark(c.vulkan.videoExtensions?.includes("VK_KHR_video_decode_h264"))} Vulkan Video decode H.264 (NVDEC)`);
  L.push("Remotion");
  L.push(`  ${mark(c.remotion.installed)} ${c.remotion.installed ? `remotion ${c.remotion.version}${c.remotion.version === "4.0.536" ? "" : " (tested: 4.0.536)"}` : "not installed (npm install)"}`);
  if (c.remotion.installed) {
    L.push(`  ${c.remotion.chrome.found ? "[ok]" : "[..]"} Chrome: ${c.remotion.chrome.version ?? "not downloaded yet (npx remotion browser ensure)"}`);
    L.push(`  ${mark(c.remotion.compositorNvenc?.ok)} bundled ffmpeg encodes with h264_nvenc${c.remotion.compositorNvenc?.error ? `: ${c.remotion.compositorNvenc.error}` : ""}`);
  }
  L.push("Probes (a few frames each)");
  for (const [k, label] of [["nvenc", "NVENC encode"], ["vulkanDecode", "Vulkan Video decode (no CPU fallback)"], ["libplacebo", "libplacebo -> CUDA -> NVENC"]]) {
    const p = c.probes[k];
    L.push(`  ${p ? mark(p.ok) : "[..]"} ${label}${p?.error ? `: ${p.error}` : p ? "" : " (skipped)"}`);
  }
  L.push("Containment");
  L.push(`  ${c.containment.ceiling === "none" ? "[--]" : "[ok]"} CPU ceiling: ${c.containment.ceiling}`);
  L.push("");
  const desc = { P1: "P1  Remotion + NVENC (<Video>, --gl=vulkan)", P2: "P2  layers (graphics in Remotion, video on the GPU)" };
  for (const k of ["P1", "P2"]) {
    const p = c.paths[k];
    L.push(`${p.ok ? "SUPPORTED    " : "NOT SUPPORTED"} ${desc[k]}`);
    for (const m of p.missing) L.push(`    missing: ${m}`);
    for (const w of p.warnings) L.push(`    note: ${w}`);
  }
  L.push("SUPPORTED     CPU only (Remotion defaults)");
  return L.join("\n");
};
