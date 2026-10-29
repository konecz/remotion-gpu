import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import {
  decidePaths, grayPng, parseCodecList, parseFfmpegVersion, parseFilterList, parseHwaccels, parseNvidiaSmi, parseVulkanSummary,
  parseVulkanVideoExtensions,
} from "../src/doctor.mjs";
import { parseDmon, parseTimes } from "../src/measure.mjs";

// Samples copied from real tool output (ffmpeg 8.0.1, driver 595, vulkaninfo 1.4).
const ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vulkan          H.264/AVC (Vulkan) (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)`;
const FILTERS = `Filters:
  T.. = Timeline support
 TS apsnr             AA->A      Measure Audio Peak Signal-to-Noise Ratio.
 .. libplacebo        N->V       Apply various GPU filters from libplacebo
 TS ssim              VV->V      Calculate the SSIM between two video streams.
 .. scale_cuda        V->V       GPU accelerated video resizer`;
const HWACCELS = "Hardware acceleration methods:\nvdpau\ncuda\nvaapi\nqsv\ndrm\nopencl\nvulkan\n\n";
const SUMMARY = `==========
VULKANINFO
==========

Devices:
========
GPU0:
	apiVersion         = 1.4.329
	vendorID           = 0x10de
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = NVIDIA GeForce RTX 5090
	driverName         = NVIDIA
	driverInfo         = 595.99.02
GPU1:
	apiVersion         = 1.4.335
	vendorID           = 0x10005
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 21.1.8, 256 bits)
	driverName         = llvmpipe
`;

test("ffmpeg version, encoders, filters and hwaccels", () => {
  assert.deepEqual(parseFfmpegVersion("ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025 the FFmpeg developers"), { version: "8.0.1-3ubuntu2", major: 8 });
  assert.deepEqual(parseFfmpegVersion("ffmpeg version n7.1 Copyright"), { version: "n7.1", major: 7 });
  assert.equal(parseFfmpegVersion("ffmpeg version N-118000-gabc Copyright").major, null);
  assert.equal(parseFfmpegVersion("bash: ffmpeg: not found"), null);
  const enc = parseCodecList(ENCODERS);
  assert.ok(enc.has("h264_nvenc") && enc.has("hevc_nvenc") && enc.has("aac"));
  assert.ok(!enc.has("V.....") && !enc.has("------"));
  const f = parseFilterList(FILTERS);
  assert.ok(f.has("libplacebo") && f.has("ssim") && f.has("scale_cuda"));
  assert.ok(!f.has("T.."));
  assert.deepEqual(parseHwaccels(HWACCELS), ["vdpau", "cuda", "vaapi", "qsv", "drm", "opencl", "vulkan"]);
});

test("nvidia-smi, vulkaninfo and dmon", () => {
  assert.deepEqual(parseNvidiaSmi("0, NVIDIA GeForce RTX 5090, 595.99.02, 21369, 32607\n"), [
    { index: 0, name: "NVIDIA GeForce RTX 5090", driver: "595.99.02", vramUsedMB: 21369, vramTotalMB: 32607 },
  ]);
  const devs = parseVulkanSummary(SUMMARY);
  assert.equal(devs.length, 2);
  assert.deepEqual(devs[0], { index: 0, name: "NVIDIA GeForce RTX 5090", type: "discrete_gpu", driver: "NVIDIA", driverInfo: "595.99.02", apiVersion: "1.4.329", nvidia: true });
  assert.equal(devs[1].nvidia, false);
  assert.deepEqual(parseVulkanVideoExtensions("x VK_KHR_video_decode_h264 y VK_KHR_video_queue VK_KHR_video_decode_h264"), ["VK_KHR_video_decode_h264", "VK_KHR_video_queue"]);
  const s = parseDmon("# gpu    sm   mem   enc   dec   jpg   ofa    fb  bar1  ccpm\n# Idx     %     %     %     %     %     %    MB    MB    MB\n    0    12     3     8     -     0     0 21500    10     0\n");
  assert.deepEqual(s[0], { gpu: 0, sm: 12, mem: 3, enc: 8, dec: null, jpg: 0, ofa: 0, fb: 21500, bar1: 10, ccpm: 0 });
  assert.deepEqual(parseTimes("0m0.010s 0m0.002s\n1m2.500s 0m3.250s\n"), { user: 62.5, sys: 3.25 });
});

const full = () => ({
  ffmpeg: { found: true, version: { major: 8 }, encoders: ["h264_nvenc", "hevc_nvenc"], filters: ["libplacebo"], hwaccels: ["cuda", "vulkan"] },
  nvidia: { gpus: [{ index: 0 }] },
  vulkan: { devices: [{ nvidia: true }], videoExtensions: ["VK_KHR_video_decode_h264"] },
  remotion: { installed: true, version: "4.0.536", chrome: { found: true }, compositorNvenc: { ok: true } },
  probes: { nvenc: { ok: true }, vulkanDecode: { ok: true }, libplacebo: { ok: true } },
  containment: { ceiling: "cgroup" },
});

test("path decision: a full NVIDIA machine supports P1 and P2", () => {
  const p = decidePaths(full());
  assert.equal(p.P1.ok, true);
  assert.equal(p.P2.ok, true);
  assert.deepEqual(p.P1.warnings, []);
  assert.deepEqual(p.P2.warnings, []);
});

test("path decision: what each missing piece takes away", () => {
  const cases = [
    [(c) => (c.ffmpeg.filters = []), { P1: true, P2: false }, /libplacebo/],
    [(c) => (c.probes.vulkanDecode.ok = false), { P1: true, P2: false }, /fall back to the CPU/],
    [(c) => (c.ffmpeg.version.major = 6), { P1: true, P2: false }, /ffmpeg 7/],
    [(c) => (c.remotion.compositorNvenc.ok = false), { P1: false, P2: true }, /bundled ffmpeg/],
    [(c) => ((c.nvidia.gpus = []), (c.probes.nvenc.ok = false)), { P1: false, P2: false }, /NVIDIA/],
  ];
  for (const [mutate, expected, why] of cases) {
    const c = full();
    mutate(c);
    const p = decidePaths(c);
    assert.equal(p.P1.ok, expected.P1, String(why));
    assert.equal(p.P2.ok, expected.P2, String(why));
    assert.ok([...p.P1.missing, ...p.P2.missing].some((m) => why.test(m)), String(why));
  }
  const c = full();
  c.remotion.version = "4.0.999";
  assert.ok(decidePaths(c).P2.warnings.some((w) => /dedup/.test(w)));
});

test("the in-memory PNG used to probe Remotion's ffmpeg is valid", () => {
  const png = grayPng(4, 2, 200);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 2);
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 2 * (1 + 4 * 3));
  assert.equal(raw[1], 200);
});
