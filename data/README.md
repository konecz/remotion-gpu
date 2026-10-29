# Data

Every number in the README, the paper and the figures comes from a file in this folder. This page says where each file came from, how many runs it holds, how long the video was and how loaded the machine was.

All measurements were taken on 2026-10-29 on one machine (`environment.json`): AMD Ryzen 7 7700X (16 threads), RTX 5090 (driver 595.99.02), Ubuntu 26.04, Remotion 4.0.536, its Chrome headless shell 157, ffmpeg 8.0.1 with libplacebo.

## Conditions that apply to everything

- **Shared, loaded machine.** The server was running production web sites, 5 CI virtual machines and other coding agents at the same time. One-minute load average at the start of a round was usually 3 to 5 and sometimes up to 9.
- **Shared GPU.** A resident LLM inference server (llama-server) held about 21 GB of the 32 GB of VRAM. It was idle in the sample taken before each benchmark round, but GPU columns (`sm`, `enc`, `dec`, VRAM) are for the whole card.
- **Same containment for every path:** `systemd-run --user --scope -p CPUQuota=800% nice -n 19 ionice -c 3`, so at most 8 of the 16 threads.
- **CPU metric:** `user_usec + system_usec` from the `cpu.stat` of that cgroup scope. It counts every child (Chrome, the Remotion compositor, ffmpeg, Node). An earlier tool (`/usr/bin/time`) missed Chrome's children and under-counted by more than half; no number here comes from it, except the first feasibility test (see below).
- **Wall clock:** monotonic clock from spawn to exit.
- **Quality:** SSIM in RGB, each video decoded with its own colour tags, frame by frame. VMAF was not available in this ffmpeg build.

## Video R

R is a 75 s production video with a presenter and motion graphics, rendered at 1080×1920 and at 1920×1080 (2241 frames at 30 fps, 74.7 s). The presenter footage is 1920×1080 H.264 at 25 fps, six takes. No frame of it is published.

## Files

| File | What | N | Video length | Source |
|---|---|---|---|---|
| `environment.json` | Hardware, software, containment, background load | — | — | Environment snapshot at the start of the benchmark pilot |
| `experiments/cpu-breakdown.json` | Where the CPU goes: footage decode, frame capture, React and layout | 1 per mode | 15 s of R (frames 375–824, 1080×1920) | Same frames rendered with `renderFrames()` in different modes (JPEG, no capture, graphics only) and subtracted. Concurrency 4, `--gl=vulkan`, `<OffthreadVideo>` |
| `experiments/r-steps.json` | CPU and wall time of each optimization step on R | 2 (segment), 1 (whole video, `<Video>` + NVENC), 4 (whole video, layers and layers + dedup) | 15 s segment for the first steps; whole video (74.7 s) for the last three | Measurement harness runs; layers with and without dedup were alternated round by round because the load moved a lot |
| `experiments/layers-segment.json` | Layered render by stage against a full Remotion render, plus the cost of a Remotion WAV pass | 3 (2 for the plan and the WAV) | 15 s of R (frames 600–1049, 1080×1920); WAV: whole video | Measurement harness runs at load 3–4; one ffmpeg round at load 16 was left out and is noted in the file |
| `experiments/alpha-formats.json` | PNG sequence vs ProRes 4444 vs VP9 with alpha for the graphics layer | 2 | 450 frames | Measurement harness runs |
| `experiments/improvements.json` | Dedup of repeated frames, capture of only the changed area, parallel ffmpeg segments, shared memory + NVENC | 2 to 6, per row | Whole video R (1080×1920); shared memory: 15 s | Measurement harness runs, alternated before/after; load 4–9, so a single round can be off by about 15% |
| `experiments/quality-r.json` | SSIM of the layered render against Remotion's render of R, by block, and the fixes that got it there | 1 | 15 s segment and whole video | Frame-by-frame SSIM |
| `experiments/first-test.json` | First feasibility test: ffmpeg in software, CUDA and libplacebo on one 12.4 s take | 1 | 12.4 s | Internal write-up; raw logs not kept; CPU from `/usr/bin/time`, which is correct here because ffmpeg is a single process |
| `negative-results.json` | What did not work, with the reason | — | — | Internal write-ups and the files above |
| `benchmark/pilot-runs.csv` | Every round of the benchmark pilot, warm-up included | 1 per cell (+1 warm-up) | 4 s (120 frames) per cell | Benchmark harness, random order with a fixed seed (20261029), wait for a quiet machine before each round (5 of 20 rounds started with the wait timed out) |
| `benchmark/pilot-summary.json` | Medians per cell of the pilot, and cells that do not apply | 1 | 4 s | Derived from `pilot-runs.csv` |
| `benchmark/pilot-quality.csv` | SSIM and PSNR of each path and of the encoder noise floor | 1 | 120 frames | Reference: the P0 path (P1 for R) captured as PNG and encoded as ProRes 4444 XQ. Noise floor: that reference re-encoded by each path's encoder with nothing else changed |
| `benchmark/quick-partial-runs.csv` | Rounds of the quick run that finished before it was stopped | mostly 1, some 2 | 15 s (450 frames) | Planned N=3 and 76 rounds; stopped after 45 (19 warm-up, 23 measured, 3 not applicable). No quality pass |
| `benchmark/quick-partial-summary.json` | Medians per cell of the partial quick run | 1–2 | 15 s | Derived from `quick-partial-runs.csv` |

## Synthetic benchmark videos

| Id | Content | Footage |
|---|---|---|
| A | Kinetic typography, 14 moving shapes, counter, word-by-word captions | none |
| B | Presenter take full screen or in a card, spring between them, slow zoom, punch-in, captions, lower third | one take at a time |
| C | 2×2 grid, then full screen with picture-in-picture | 2 to 4 takes at once |
| D | Rotating conic and radial gradients, `blur(70px)`, `backdrop-filter`, animated SVG wave and `feTurbulence` | none |
| E | Slide with bullets that fade in one by one and a progress bar | none |
| R | Segment of video R (1920×1080 version, from frame 375) | one take at a time |
| S | Segment of a second production video; P0 only | one take at a time |

Paths: **P0** Remotion default (`<OffthreadVideo>`, JPEG 80, libx264 CRF 18, no `--gl`), **P1** Remotion on the GPU (`<Video>` from `@remotion/media`, `--gl=vulkan`, MP4 straight to `h264_nvenc` at 12 Mb/s), **P2** layers (graphics as PNG with alpha + ffmpeg with Vulkan Video, libplacebo and `h264_nvenc` CQ 19), **P3** layers + dedup.

## How to read these numbers

- **The pilot is indicative.** N=1 and 4 s per cell: there is no confidence interval, and start-up costs weigh more than in a real video.
- **The quick run is incomplete.** Most cells have one round; read it as a second pilot with longer clips.
- **Do not divide numbers across measurement windows.** `r-steps.json` mixes a 15 s segment and the whole video on purpose and labels each step.
- **Early estimates are not data.** Projections made before the cgroup measurement existed (for example about 1100 s of CPU for the whole of R) are not used anywhere.
- **What was left out of the published files:** process lists, process ids, file paths and command lines of the server, and every video frame.
