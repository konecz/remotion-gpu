<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/hero-dark.svg">
  <img alt="remotion-gpu by Konecz: 4.1 times less CPU to export a 75 s production video than Remotion's own GPU path" src="figures/hero-light.svg">
</picture>

**Export Remotion videos on an NVIDIA GPU and leave the CPU free.** On a 75 s production video with a presenter and motion graphics, the layered render used **112 s of CPU instead of 460 s** (4.1× less) and finished in 49 s instead of 111 s. The comparison is Remotion's own GPU path, `<Video>` + NVENC, on the same machine.

Português: [LEIAME.md](LEIAME.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/r-steps-dark.svg">
  <img alt="Exporting video R step by step, CPU seconds per second of video. 15 s segment: starting point 23.1, Video plus NVENC 8.1. Whole video: Video plus NVENC 6.2, layers 1.7, layers plus dedup 1.5." src="figures/r-steps-light.svg">
</picture>

## How it works

In a Remotion render with footage, React is not the problem. Almost all of the CPU goes to decoding the footage and taking a screenshot of every frame.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/cpu-breakdown-dark.svg">
  <img alt="Where the CPU goes: footage decode 99.3 s (54%), frame capture 76.3 s (42%), React and layout 8.0 s (4%). Graphics only: 27.7 s." src="figures/cpu-breakdown-light.svg">
</picture>

So the footage leaves the browser. The same React code that frames the presenter (box, crop, slow zoom, punch-in, spring into a card) writes a **framing plan**. Chrome renders only the graphics, as PNG with alpha. ffmpeg does the rest on the GPU.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/pipeline-dark.svg">
  <img alt="Pipeline: React composition to framing plan JSON and graphics PNG with alpha; footage decoded by NVDEC through Vulkan Video; libplacebo crops, positions and blends; NVENC encodes to MP4." src="figures/pipeline-light.svg">
</picture>

- The plan is compiled to piecewise-linear `libplacebo` expressions, with at most 0.05 px of error.
- `libplacebo` blends in linear light and Chrome blends in gamma. The inputs are tagged so that the blend matches Chrome's.
- 25 fps footage is mapped to 30 fps output the way Remotion picks frames (`fps=30:round=up`).
- **Dedup** (optional) hashes the page state before each capture. A frame whose state was already captured becomes a link to that PNG. On video R, 29% of the frames were reused, and every reused frame matched a fresh capture byte for byte.

## Which path to use

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/decision-dark.svg">
  <img alt="Decision guide: no footage, use P1. One rectangular take at a time, use layers with dedup. Several takes at once, masks or rotation, use P1." src="figures/decision-light.svg">
</picture>

## Quick start

Requirements:

- Linux;
- an NVIDIA GPU with NVENC;
- ffmpeg 7 or newer, built with libplacebo and Vulkan;
- Node 20 or newer;
- Remotion 4.0.536.

```sh
npm install
npm run doctor            # checks ffmpeg, the NVIDIA driver, Vulkan and Remotion, path by path
npm run example:p1        # the example video through Remotion + <Video> + NVENC
npm run example:layers    # the same video through the layered render
npm test
```

The example makes its own synthetic footage on first use, so no media is downloaded. Outputs go to `examples/presenter/out/`.

## Using it with Claude Code

This project was built with [Claude Code](https://claude.com/claude-code), and it ships a skill for people who edit video with Claude.

- `.claude/skills/remotion-gpu/SKILL.md` teaches Claude to pick the path, write compositions that the layered render accepts, and measure before and after.
- [docs/claude-code.md](docs/claude-code.md) explains how to install the skill in your own Remotion project and what to ask for.

## Benchmark, and how to send your results

Synthetic videos A to E cover typography, a presenter, several videos at once, heavy effects and a slide. The pilot below has **N=1 and 4 s per cell, so it is indicative only**. The quick run that followed was stopped halfway, and it ranks the paths the same way.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/pilot-dark.svg">
  <img alt="Pilot, CPU seconds per second of video. P1 wins on A, D, E and C; layers win on B, B in 4K and R." src="figures/pilot-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/quality-dark.svg">
  <img alt="SSIM of each GPU path next to the encoder noise floor; every path within 0.008 of its floor, most within 0.002." src="figures/quality-light.svg">
</picture>

```sh
npm run bench:smoke       # N=1, 4 s: checks that every path runs on your machine
npm run bench:quick       # N=3, 15 s, 1080p
npm run bench:full        # N=5, 30 s, 1080p and 4K (hours; run it overnight)
```

Every run writes `bench/results/<run>/` with the raw rounds, the environment, an analysis and a `submission.json`, the one file to attach to a benchmark-result issue. Read it before you send it. **We only have numbers from one RTX 5090 on a busy server.** Results from other cards, from AMD or Intel, from laptops and from idle machines are the most useful contribution. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to send them.

## What did not work

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/negative-dark.svg">
  <img alt="What did not work: hardware decode inside headless Chrome; capturing only the changed area; Remotion's Experimental.Clipper; shared memory with NVENC for the graphics; ProRes or VP9 alpha; several ffmpeg segments at once." src="figures/negative-light.svg">
</picture>

## What is new and what is not

Much of this was done before, and the paper cites it:

- Remotion itself recommends `<Video>` from `@remotion/media` and supports NVENC output.
- HyperFrames already composites video outside the browser, in layers and on the CPU. It also skips repeated frames, by default.
- CasparCG composites HTML graphics over video on the GPU, in real time.
- Remotion's `Experimental.Clipper` tried partial capture and was removed because it made renders slower.

What we add:

- the framing written in the React component becomes a plan that runs from end to end on the GPU (NVDEC, libplacebo, NVENC);
- the result is measured against Chrome's render, next to the encoder's noise floor;
- the CPU numbers and the benchmark are published as open data.

## Paper

[paper/paper.md](paper/paper.md) (English) and [paper/artigo.md](paper/artigo.md) (Portuguese) cover the method, the results, the threats to validity and the references. Every number comes from [data/](data), and [data/README.md](data/README.md) gives the source, run count, clip length and machine load for each one.

## Notices

- **Remotion has its own license.** Companies above a certain size need a paid license; see [remotion.dev/license](https://www.remotion.dev/license). This project does not change that.
- **Konecz is not affiliated with Remotion.**
- **Dedup uses an internal part of Remotion** (`takeFrame` in `@remotion/renderer`). It works only with version 4.0.536 and refuses to run on any other. The rest works without it.
- **The numbers come from one machine**: Ryzen 7 7700X, RTX 5090, with production sites and a resident LLM server sharing it, capped at 8 of 16 threads. Your ratios will differ.

## License

MIT, see [LICENSE](LICENSE). The fonts embedded in the figures (Schibsted Grotesk and IBM Plex Mono) are under the SIL Open Font License; see `figures/build/fonts/`.

Made by [Konecz](https://konecz.com) with Claude Code.
