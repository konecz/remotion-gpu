# Contributing

The most useful contribution right now is a **benchmark result from your machine**: the numbers in this repository
come from one machine, and other GPUs, drivers, CPUs and ffmpeg builds tell us where each path holds up. Bug reports
and pull requests are welcome too.

## Send a benchmark result

Requirements: Linux, Node 20 or newer, an NVIDIA GPU with its driver, and ffmpeg 7 or newer built with libplacebo,
Vulkan and NVENC (the doctor tells you what is missing). The CPU-only device also runs, for comparison.

```bash
git clone https://github.com/konecz/remotion-gpu.git
cd remotion-gpu
npm install
npm run doctor          # check which paths this machine supports
npm run bench:smoke     # optional: a few minutes, checks that every path runs
npm run bench:quick     # N=3, 15 s clips at 1080p
```

`bench:quick` renders synthetic compositions by every path, three times each in a shuffled order, after a discarded
warm-up, waiting for the machine to be quiet before each run. It takes a while: leave the machine alone while it
runs (other renders, games or a busy model server on the GPU skew the numbers; they are recorded, not removed). Every
render is contained (nice 19, idle I/O, a CPU ceiling of 8 cores by default; `RGPU_CORES` changes it).

At the end it prints the folder with the results, `bench/results/<date>-quick/`, and the file to share:
`submission.json`. Then:

1. Open a new issue with the **Benchmark result** template.
2. Attach `submission.json` (drag it into the issue; zip it if GitHub refuses the size).
3. Fill in the few lines the template asks for (anything unusual about the machine or the run).

Other options: `npm run bench:full` (also 4K, N=5; hours, run it overnight), `--gpu <index>` and
`--vulkan-device <index>` on machines with more than one GPU, `--device cpu` for the CPU-only baseline. See the header
of `bench/run.mjs`.

### What the result contains

`submission.json` holds the run configuration, the raw numbers of every run, the quality of each output against its
reference (SSIM, PSNR, VMAF when available), and a snapshot of the environment taken at the start and at the end:

- OS name and kernel version; CPU model, thread count and frequency governor; total and free memory;
- GPU name, driver version, VRAM, clocks, power and temperature; the compute processes on the GPU (process name and
  VRAM) and a per-process GPU use sample;
- versions of Node, Remotion, Remotion's Chrome, the system ffmpeg, esbuild, and whether libplacebo and libvmaf are
  present;
- the containment in use (cores, kind of ceiling), the load average and the names of the busiest processes (command
  name and CPU share only, no arguments), and how many other renders were running;
- the git commit of this repository and whether the working tree had changes.

Nothing personal is collected: no host name, user name, IP address, files or rendered videos (outputs stay on your
disk). Paths under your home directory are replaced with `~`, and command logs are left out of `submission.json`.
It is plain JSON: read it before you post it, and remove anything you do not want to share.

## Report a bug

1. Update to the latest commit and run `npm install`.
2. Run `node bin/doctor.mjs --json` (add `--cwd <your Remotion project>` if the bug is in your project) and keep the
   output.
3. Open an issue with the **Bug report** template: what you ran (the exact command), what you expected, what happened
   (the error output), the doctor's JSON, and, if you can, the smallest composition or plan that reproduces it.

Before posting, remove anything private from logs and paths (project names, client names, file names).

Problems with Remotion itself, or with a Remotion version other than 4.0.536, belong upstream unless this toolkit makes
them worse. The dedup patch failing on another version is expected: it refuses to run on versions it was not tested
on.

## Questions and ideas

Use [Discussions](https://github.com/konecz/remotion-gpu/discussions): how to use it, a render setup you want to
share, an idea you want to test before writing code. Issues are for bugs and benchmark results.

## Security

Never report a vulnerability in a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

- Open an issue or a discussion first for anything beyond a small fix.
- `main` is protected: changes land through a pull request with the `test` checks green and a maintainer review.
  CI runs on GitHub-hosted runners; workflows from first-time contributors wait for a maintainer to approve them.
- Run `npm test` and `npm run typecheck` before sending.
- A change that claims to make rendering faster needs numbers: `src/measure.mjs` (or the benchmark) before and after,
  at least two runs each, and the quality of the output (`src/quality.mjs`).
- Everything in the repository is in English.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).
