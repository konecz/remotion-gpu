import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// No GPU, no ffmpeg run: render-layers is driven with --dry-run, and ffprobe (asked for the take's size) is a stub.
const tmp = mkdtempSync(join(tmpdir(), "rgpu-layers-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const ffprobe = join(tmp, "ffprobe");
writeFileSync(ffprobe, "#!/bin/sh\necho 1280,720\n");
chmodSync(ffprobe, 0o755);
process.env.RGPU_FFPROBE = ffprobe;
const { geometry, pngColorType, planSegments, renderLayers } = await import("../src/layers/render-layers.mjs");

const RGBA = 6;
const RGB = 2;
/** Just enough of a PNG for pngColorType: signature and IHDR. */
const pngHeader = (colorType) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(1920, 16);
  b.writeUInt32BE(1080, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
};

test("geometry: a take inside its box is not cropped", () => {
  const g = geometry([100, 50, 800, 600], [0, 0, 800, 600], { w: 1600, h: 1200 });
  assert.deepEqual(g, { crop_x: 0, crop_y: 0, crop_w: 1600, crop_h: 1200, pos_x: 100, pos_y: 50, pos_w: 800, pos_h: 600 });
});

test("geometry: only what falls inside the box is cropped and placed", () => {
  // Take scaled 1.5x (1920 wide from a 1280 source), shifted 300 px left and 100 px up inside an 800x600 box.
  const g = geometry([100, 50, 800, 600], [-300, -100, 1920, 1080], { w: 1280, h: 720 });
  assert.deepEqual(g, { crop_x: 200, crop_y: 100 / 1.5, crop_w: 800 / 1.5, crop_h: 400, pos_x: 100, pos_y: 50, pos_w: 800, pos_h: 600 });
  // Smaller than the box and off-center: the position follows the take, the crop is the whole source.
  const h = geometry([0, 0, 1000, 1000], [200, 300, 640, 360], { w: 1280, h: 720 });
  assert.deepEqual(h, { crop_x: 0, crop_y: 0, crop_w: 1280, crop_h: 720, pos_x: 200, pos_y: 300, pos_w: 640, pos_h: 360 });
});

test("pngColorType reads the color type from the IHDR", () => {
  writeFileSync(join(tmp, "rgba.png"), pngHeader(RGBA));
  writeFileSync(join(tmp, "rgb.png"), pngHeader(RGB));
  assert.equal(pngColorType(join(tmp, "rgba.png")), RGBA);
  assert.equal(pngColorType(join(tmp, "rgb.png")), RGB);
});

test("planSegments: takes, gaps and the clip to the frame range", () => {
  const same = () => RGBA;
  const takes = [
    { file: "b.mp4", start: 50, frames: 20 },
    { file: "a.mp4", start: 10, frames: 20 },
    { file: "late.mp4", start: 200, frames: 10 },
  ];
  const segs = planSegments(takes, 0, 99, same).map((s) => [s.start, s.n, s.take?.file ?? null]);
  assert.deepEqual(segs, [[0, 10, null], [10, 20, "a.mp4"], [30, 20, null], [50, 20, "b.mp4"], [70, 30, null]]);
  // A range that starts and ends inside takes: both are clipped, the one outside the range is skipped.
  const clipped = planSegments(takes, 20, 59, same).map((s) => [s.start, s.n, s.take?.file ?? null]);
  assert.deepEqual(clipped, [[20, 10, "a.mp4"], [30, 20, null], [50, 10, "b.mp4"]]);
  // No takes: one background segment.
  assert.deepEqual(planSegments([], 5, 9, same).map((s) => [s.start, s.n]), [[5, 5]]);
});

test("planSegments: a change between PNG with and without alpha cuts the segment", () => {
  // Frames 0-3 RGBA, 4-5 RGB (fully opaque, written by Chrome without alpha), 6-9 RGBA again.
  const colorType = (q) => (q >= 4 && q <= 5 ? RGB : RGBA);
  const takes = [{ file: "a.mp4", start: 2, frames: 6 }];
  const segs = planSegments(takes, 0, 9, colorType).map((s) => [s.start, s.n, s.take?.file ?? null]);
  assert.deepEqual(segs, [[0, 2, null], [2, 2, "a.mp4"], [4, 2, "a.mp4"], [6, 2, "a.mp4"], [8, 2, null]]);
  for (const s of planSegments(takes, 0, 9, colorType)) {
    for (let q = s.start; q < s.start + s.n; q++) assert.equal(colorType(q), colorType(s.start), "one color type per segment");
  }
  // Frames cover the range with no gap or overlap.
  assert.equal(segs.reduce((n, [, k]) => n + k, 0), 10);
});

/** A plan on disk with 10 PNG frames: frames 0-3 RGBA, 4-9 RGB; one take on frames 2-6 that slides left. */
const fixture = (name, planExtra = {}, pngs = [0, 9]) => {
  const dir = join(tmp, name);
  const graphics = join(dir, "graphics");
  mkdirSync(graphics, { recursive: true });
  for (let q = pngs[0]; q <= pngs[1]; q++) writeFileSync(join(graphics, `element-${String(q).padStart(4, "0")}.png`), pngHeader(q < 4 ? RGBA : RGB));
  const plan = {
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 10,
    background: "#f4f2ee",
    takes: [
      {
        file: "footage/a.mp4",
        start: 2,
        frames: 5,
        from: 1,
        box: Array(5).fill([100, 50, 800, 600]),
        video: Array.from({ length: 5 }, (_, j) => [-10 * j, 0, 1920, 1080]),
      },
    ],
    ...planExtra,
  };
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  return { dir, graphics, planPath: join(dir, "plan.json"), output: join(dir, "out.mp4") };
};

const dryRun = async (f, extra = {}) => {
  const lines = [];
  const segments = await renderLayers(f.planPath, { graphics: f.graphics, output: f.output, dryRun: true, log: (s) => lines.push(s), ...extra });
  // Segments run longest first, so the log is not in timeline order: index the commands by segment file.
  const all = lines.filter((l) => l.startsWith("ffmpeg "));
  const commands = all.slice(0, -1).sort((a, b) => a.match(/(\d{3})\.mp4$/)[1].localeCompare(b.match(/(\d{3})\.mp4$/)[1]));
  commands.push(all.at(-1));
  const graph = (i) => readFileSync(join(`${f.output}.segments`, `${String(i).padStart(3, "0")}.mp4.graph.txt`), "utf8");
  return { segments, commands, graph };
};

test("render-layers dry run: segments cut at the alpha change and at the take", async () => {
  const f = fixture("segments");
  const { segments, commands } = await dryRun(f);
  const take = join(f.dir, "footage/a.mp4");
  assert.deepEqual(segments, [
    { start: 0, frames: 2, take: null },
    { start: 2, frames: 2, take },
    { start: 4, frames: 3, take },
    { start: 7, frames: 3, take: null },
  ]);
  // One ffmpeg per segment and one join.
  assert.equal(commands.length, 5);
  segments.forEach((s, i) => assert.match(commands[i], new RegExp(`-frames:v ${s.frames} `)));
  // Each segment's PNG list holds exactly its frames, in order.
  const pngList = readFileSync(join(`${f.output}.segments`, "002.mp4.png.txt"), "utf8");
  assert.deepEqual([...pngList.matchAll(/element-(\d+)\.png/g)].map((m) => Number(m[1])), [4, 5, 6]);
  assert.match(pngList, /^ffconcat version 1\.0/);
});

test("render-layers dry run: the take is seeked to its own frame and converted with fps=30:round=up", async () => {
  const f = fixture("take");
  const { commands, graph } = await dryRun(f);
  // Segment 1 starts at the take's first frame, segment 2 two frames later: from + k0 / fps.
  assert.match(commands[1], / -ss 1 -hwaccel vulkan -hwaccel_output_format vulkan -i \S+a\.mp4 /);
  assert.match(commands[2], new RegExp(` -ss ${1 + 2 / 30} -hwaccel vulkan `));
  for (const i of [1, 2]) {
    const g = graph(i);
    assert.match(g, /\[1:v\]setparams=[^,]*,tpad=stop_mode=clone:stop_duration=[\d.]+,fps=30:round=up:start_time=0\[c1\]/);
    assert.match(g, /libplacebo=inputs=3:w=1920:h=1080:fps=30:/);
  }
  // Without a take: background and graphics only, no frame-rate conversion.
  for (const i of [0, 3]) {
    assert.doesNotMatch(graph(i), /round=up/);
    assert.match(graph(i), /libplacebo=inputs=2:/);
    assert.doesNotMatch(commands[i], /-hwaccel vulkan/);
  }
  // Graphics (the last input) are never cropped: the fallback of every expression is the whole frame.
  assert.match(graph(1), /crop_w='if\(eq\(idx,1\),[^']*,iw\)'/);
  // Per-frame crop of segment 2 starts where the take is at its frame 2 (x = -20 px, scale 1.5): 20 / 1.5 = 13.333.
  assert.match(graph(1), /crop_x='if\(eq\(idx,1\),0\+6\.667\*\(floor\(ot\*30\+0\.5\)-0\)\/1,0\)'/);
  assert.match(graph(2), /crop_x='if\(eq\(idx,1\),13\.333\+/);
  assert.match(graph(1), /pos_x='if\(eq\(idx,1\),100\+0\*\(floor\(ot\*30\+0\.5\)-0\)\/1,0\)'/);
});

test("render-layers dry run: blending in linear light, output tagged BT.709", async () => {
  const f = fixture("color");
  const { commands, graph } = await dryRun(f);
  const g = graph(1);
  // Background, take and graphics are all tagged linear, so libplacebo blends without converting (like Chrome).
  assert.match(g, /\[0:v\]format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=linear:range=tv,hwupload\[c0\]/);
  assert.match(g, /\[1:v\]setparams=colorspace=bt709:color_primaries=bt709:color_trc=linear:range=tv,/);
  assert.match(g, /\[2:v\]format=rgba,setparams=colorspace=gbr:color_primaries=bt709:color_trc=linear:range=pc,hwupload\[c2\]/);
  assert.match(g, /libplacebo=[^;]*:format=yuv420p:colorspace=bt709:color_primaries=bt709:color_trc=linear:range=tv:/);
  // Re-tagged BT.709 after the blend, and the encoder writes BT.709 too.
  assert.match(g, /,setparams=color_trc=bt709,hwupload=derive_device=cuda\[v\]$/);
  assert.match(commands[1], /-c:v h264_nvenc .*-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv /);
  assert.match(commands[1], /-init_hw_device vulkan=vk -filter_hw_device vk /);
});

test("render-layers dry run: codec, Vulkan device and frame range options", async () => {
  const f = fixture("options", {}, [3, 5]);
  const { segments, commands } = await dryRun(f, { codec: "hevc", vulkanDevice: "1", cq: 23, from: 3, to: 5 });
  // 3 RGBA, then 4-5 RGB: the alpha change still cuts inside the range.
  assert.deepEqual(segments.map((s) => [s.start, s.frames]), [[3, 1], [4, 2]]);
  assert.match(commands[0], /-init_hw_device vulkan=vk:1 /);
  assert.match(commands[0], /-c:v hevc_nvenc -preset p7 -tune hq -rc vbr -cq 23 -b:v 0 /);
  assert.match(commands.at(-1), / -t 0\.1 /);
});

test("render-layers: the PNG folder must match the frame range", async () => {
  const f = fixture("mismatch");
  await assert.rejects(() => dryRun(f, { to: 8 }), /10 PNG files .* expected 9/);
  const g = fixture("first", {}, [0, 8]);
  await assert.rejects(() => dryRun(g, { from: 1 }), /the first PNG is element-0000\.png, expected frame 1/);
});

test("render-layers dry run: the plan's audio is mixed at its frames; a ready file is mapped as is", async () => {
  const f = fixture("audio", { audio: [{ file: "music.wav", start: 3, frames: 6, from: 0.5, volume: 0.8, fadeOut: [4, 6] }] });
  const { commands } = await dryRun(f);
  const audio = readFileSync(join(`${f.output}.segments`, "audio.txt"), "utf8");
  assert.match(audio, /\[1:a\]aresample=48000,atrim=start=0\.500000:end=0\.700000,asetpts=PTS-STARTPTS,/);
  assert.match(audio, /volume='0\.8\*clip\(\(0\.200000-t\)\/0\.066667,0,1\)':eval=frame/);
  assert.match(audio, /adelay=4800S:all=1\[a0\]/);
  assert.match(audio, /amix=inputs=1:normalize=0:duration=longest,apad,atrim=0\.000000:0\.333333,asetpts=PTS-STARTPTS\[a\]$/);
  assert.match(commands.at(-1), /-map 0:v -map \[a\] -c:v copy -c:a aac -b:a 192k -t 0\.3333333333333333 /);

  // --audio wins over the plan's entries, seeked to the start of the range.
  const ready = await dryRun(f, { audio: "/x/mix.wav" });
  assert.match(ready.commands.at(-1), / -ss 0 -i \/x\/mix\.wav -map 0:v -map 1:a -c:v copy -c:a aac /);
  assert.doesNotMatch(ready.commands.at(-1), /filter_complex/);
});
