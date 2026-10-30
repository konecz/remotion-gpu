---
name: remotion-gpu
description: Render or export a Remotion video on a Linux machine with an NVIDIA GPU while keeping the CPU free. Use whenever a Remotion composition is about to be rendered, exported, re-rendered or benchmarked on Linux + NVIDIA (NVENC, NVDEC, Vulkan, libplacebo), when choosing between rendering with <Video> + NVENC and the layered render, or when a render is too slow or takes every CPU core.
---

# Rendering Remotion on an NVIDIA GPU (remotion-gpu)

This skill drives the `remotion-gpu` toolkit, verified on Remotion **4.0.536** only. Below, `$RGPU` is the folder where
the toolkit is checked out (for example `export RGPU=~/tools/remotion-gpu`) and every command runs from the Remotion
project folder unless said otherwise.

Two paths, plus an option:

- **P1**: Remotion renders straight to MP4 with NVENC. Chrome paints with Vulkan; the composition uses `<Video>` from
  `@remotion/media` instead of `<OffthreadVideo>`. Video is still decoded on the CPU (WebCodecs in software).
- **P2, layers**: Remotion renders only the graphics (PNG sequence with alpha, no video). The system ffmpeg decodes
  the video takes on the GPU (Vulkan Video / NVDEC), crops and places them per frame with libplacebo from a plan,
  puts the graphics on top and encodes with NVENC.
- **P3**: P2 plus the dedup patch, which skips capturing graphics frames whose page state was already captured.

## 1. Run the doctor first

```bash
node $RGPU/bin/doctor.mjs --cwd .          # human report
node $RGPU/bin/doctor.mjs --cwd . --json   # same, as JSON
```

It checks ffmpeg (version, `h264_nvenc`, libplacebo, Vulkan hwaccel), the NVIDIA driver, Vulkan devices and Vulkan
Video extensions, Remotion's version, its Chrome and its bundled ffmpeg, and the CPU ceiling; then it runs short
probes (NVENC encode, Vulkan decode, libplacebo to NVENC). It prints `[ok]`/`[--]` per path and what is missing.
Exit code 0 if P1 or P2 is supported, 1 if only the CPU path is. `--no-probes` skips the probes.

Do not pick a path the doctor marks as unsupported. Read its warnings: a missing NVIDIA Vulkan device means
`--gl=angle` instead of `--gl=vulkan`; a Remotion version other than 4.0.536 means no dedup.

## 2. Choose the path

| The video has | Path |
|---|---|
| Recorded footage (a presenter, a screen recording) that is cropped, positioned and zoomed (springs, slow zoom, punch-in), one take on screen at a time, with graphics on top | **P2 layers**, and **P3** (dedup) when the graphics hold still for stretches (captions, lower thirds) |
| Motion graphics with no video | **P1** |
| Heavy effects on the video itself (filters, masks, blur, 3D transforms), video under other elements | **P1** |
| Several videos on screen at the same time | **P1** |

Why: the layered plan only describes, per frame, a crop of the take and a box on screen; the background is one solid
color and the graphics layer always sits on top. `validate-plan.mjs` rejects overlapping takes. Anything else needs
Chrome to draw the video, which is P1. Without video there is nothing for NVDEC to decode and P1 already encodes on
the GPU.

## 3. Commands

### P1: `<Video>` + NVENC

In the composition:

```tsx
import { Video } from "@remotion/media";
<Video src={staticFile("take.mp4")} disallowFallbackToOffthreadVideo />
```

`disallowFallbackToOffthreadVideo` makes the render fail instead of silently falling back to the CPU-heavy
OffthreadVideo path. Render (these are the flags from `p1Args()` in `$RGPU/src/remotion-gpu.mjs`):

```bash
systemd-run --user --scope --quiet -p CPUQuota=800% nice -n 19 ionice -c 3 \
  npx remotion render src/index.ts MyComp out/video.mp4 \
  --gl=vulkan --codec=h264 --hardware-acceleration=required \
  --video-bitrate=12M --image-format=jpeg --jpeg-quality=95
```

`--hardware-acceleration=required` fails the render instead of falling back to libx264. `--codec=h265` also works.
From Node, build the same flags with `p1Args("nvidia", { bitrate, codec })` and the CLI command with
`remotionCommand({ cwd })`, both exported by `$RGPU/src/remotion-gpu.mjs`.

### P2 / P3: layers

The project needs three things (see `$RGPU/examples/presenter`):

1. **One framing function** per take, frame -> `{ box, video }` (written with Remotion's `spring`/`interpolate`), used
   both by the composition and by the plan, so both paths agree frame by frame. `$RGPU/src/presenter/` has a ready
   `Presenter` component and `presenterTake()` for the common presenter-in-a-card case.
2. **A graphics-only mode** in the composition (a prop such as `graphicsOnly`): draw everything except the video,
   with a transparent background.
3. **A plan entry**, a TS file whose default export is a `Plan` (type in `$RGPU/src/layers/plan.ts`) or a function
   `(input) => Plan`. It is bundled for Node with esbuild, so it may import the framing code and `remotion`, but no
   React component that needs a browser. Schema: `$RGPU/src/layers/plan.schema.json`.

Then a render script, which contains itself and runs plan -> graphics -> ffmpeg (write the real path of the toolkit
in place of `$RGPU` in the imports):

```js
import { ensureContained } from "$RGPU/src/contain.mjs";
import { renderLayered } from "$RGPU/src/layers/pipeline.mjs";

ensureContained(); // re-runs this script under nice 19, idle I/O and a CPU ceiling
const { steps } = await renderLayered({
  cwd: process.cwd(),                 // the Remotion project (its @remotion/cli is used)
  planEntry: "src/plan.ts",           // absolute path is safest
  planInput: { publicDir: "public" }, // passed to the plan function
  serveUrl: "src/index.ts",
  composition: "MyComp",
  graphicsProps: { graphicsOnly: true },
  workDir: "out/work-layers",
  output: "out/video.mp4",
  dedup: true,                        // P3; false = P2
  remotionArgs: ["--gl=vulkan"],
  // frames: [0, 449], parallel: 1, cq: 19, codec: "h264" | "hevc", keepGraphics: false
});
console.log(steps); // wall time and cgroup CPU of the plan, graphics and ffmpeg steps
```

The same steps by hand:

```bash
# graphics layer, with the dedup patch preloaded into the Remotion CLI process
node --require $RGPU/src/dedup/remotion-dedup.cjs node_modules/@remotion/cli/remotion-cli.js \
  render src/index.ts MyComp out/work/graphics --sequence --image-format=png \
  --props='{"graphicsOnly":true}' --gl=vulkan
# GPU half: decode, crop, place, composite, encode (it contains itself)
node $RGPU/src/layers/render-layers.mjs out/work/plan.json --graphics out/work/graphics --output out/video.mp4
#   [--from 600 --to 1049] [--audio mix.wav] [--parallel 2] [--cq 19] [--codec h264|hevc] [--vulkan-device 0] [--dry-run]
```

The dedup patch must be preloaded with `node --require` into the process that runs the Remotion CLI; `npx remotion`
does not load it. It only acts on `--sequence`. `RGPU_DEDUP=0` disables it; `RGPU_DEDUP=verify` captures every frame
and fails if two frames with the same state produced different files.

To try both paths on the bundled example (from `$RGPU`): `npm run example:p1`, `npm run example:layers`,
`npm run example:compare` (SSIM/PSNR between the two outputs).

## 4. Pitfalls

- **The dedup patch only accepts Remotion 4.0.536.** It patches `@remotion/renderer` internals (`takeFrame`), so any
  other version makes the render fail loudly with an explanation. Do not silence it: render with `RGPU_DEDUP=0`
  (plain P2), or pin Remotion to 4.0.536.
- **With NVENC, `--crf` does not apply.** Remotion refuses `--crf` together with hardware acceleration; set quality
  with `--video-bitrate` (default `12M`, `RGPU_BITRATE` overrides it in the toolkit). In P2, ffmpeg uses NVENC's
  `-cq` (`--cq`, default 19).
- **PNG with alpha and PNG without alpha split a segment.** Chrome writes a fully opaque frame as RGB and the others
  as RGBA. Switching mid-stream makes ffmpeg rebuild the filter graph, which fails with Vulkan frames
  (`Function not implemented`). `render-layers.mjs` already cuts a segment where the PNG color type changes and feeds
  each segment only its own PNG files; keep that if you change the ffmpeg side.
- **Use `fps=30:round=up:start_time=0`** (with the timeline's fps) on the take before libplacebo. libplacebo's default
  nearest-frame pick disagrees with Remotion on 2 of every 6 frames when converting 25 to 30 fps; `round=up` matches
  it, and `start_time=0` repeats the first frame when the seek lands between two frames of the take (otherwise the
  first frame of the segment has no video).
- **The blend is in linear light.** libplacebo blends and scales in linear light; Chrome blends gamma-encoded values.
  With the true transfer curve, semi-transparent graphics come out washed out. The toolkit tags video, graphics and
  output as `color_trc=linear` (so nothing is converted and the blend matches Chrome) and re-tags BT.709 at the
  output. Do not "fix" those tags.
- **VA-API in headless Chrome does not work.** Do not try to make `<Video>` decode on NVDEC through
  `nvidia-vaapi-driver`: the decoder opens, but the GPU process of headless Chrome crashes when the
  frame arrives. For GPU decode, use P2.
- **Capturing only the area that changed is slower.** A dirty-rectangle capture (`clip` on the screenshot plus
  recomposing the patches) costs more CPU than it saves and is not pixel-identical (Chrome rasterizes differently with
  a clip). Remotion removed its own `Experimental.Clipper` for the same reason. Use the dedup patch instead.
- `--parallel N` in P2 lowers wall time but raises CPU (about +20% with 2) and VRAM (about 1.3 GB per extra ffmpeg).
  The default is 1 because the goal is a free CPU.

## 5. Measure

Compare paths or changes with `measure.mjs`, which runs the command contained in its own cgroup and records CPU time
(including every Chrome child), wall time, fps, memory peaks, GPU use (sm, enc, dec, VRAM) and the output's size:

```bash
node $RGPU/src/measure.mjs --runs 2 --frames 450 --label p1 --json results.jsonl -- \
  npx remotion render src/index.ts MyComp out/video.mp4 --gl=vulkan --codec=h264 \
  --hardware-acceleration=required --video-bitrate=12M --image-format=jpeg --jpeg-quality=95
```

Options: `--runs N` (default 2), `--frames N` (for fps), `--label`, `--json file.jsonl` (one line per run, local paths
redacted), `--gpu <index>`, `--output <file>`. Do not add the `systemd-run` prefix here: `measure.mjs` contains the
command itself. Report the mean and the spread it prints; a single run is not a result. GPU numbers are for the whole
GPU, so note other GPU processes (a resident model server, another render).

For the full matrix on synthetic compositions, from `$RGPU`: `npm run bench:smoke` (a check that everything runs),
`npm run bench:quick`, `npm run bench:full`.

## 6. Always render contained

Never start a render without the containment: lowest priority (`nice -n 19`), idle I/O (`ionice -c 3`) and a CPU
ceiling (a transient systemd user scope with `CPUQuota`, default 8 cores or fewer if the machine has fewer;
`RGPU_CORES` changes it). Otherwise Remotion and ffmpeg take every core and starve whatever else runs on the machine.

- From the shell: prefix the command with `systemd-run --user --scope --quiet -p CPUQuota=800% nice -n 19 ionice -c 3`.
- From Node: call `ensureContained()` first, or run commands with `contained(cmd, args)`, both from
  `$RGPU/src/contain.mjs`. Without a systemd user session they fall back to `taskset`, then to priority only; the
  doctor says which one applies.
- `measure.mjs`, `render-layers.mjs`, the example and the benchmark already contain themselves.
