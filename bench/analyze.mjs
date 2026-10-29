// Analysis of a run of run.mjs: median, IQR and 95% bootstrap CI of the median per cell; speedup ratios against P0
// (or P1 where there is no P0) with CI; CPU per second of video; layered render steps; quality and noise floor; a
// static chart (chart.html); and submission.json, the single file to attach to a benchmark-result issue.
//
// Usage: node bench/analyze.mjs [results dir]   (no dir: the latest in bench/results/)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESAMPLES, iqr, median, medianCI, ratioCI } from "./stats.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIDEO_ORDER = ["A", "B", "C", "D", "E", "X"];
const PATH_ORDER = ["P0", "P1", "P2", "P3"];
const VIDEO_NAMES = { A: "A typography", B: "B presenter", C: "C multivideo", D: "D effects", E: "E slide", X: "X external" };

const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const fmtCI = (ci, d = 1) => (ci ? `[${fmt(ci[0], d)}; ${fmt(ci[1], d)}]` : "-");
const summary = (xs, d = 1) => `${fmt(median(xs), d)} (IQR ${fmt(iqr(xs), d)}; CI ${fmtCI(medianCI(xs), d)})`;

/** Latest results folder that has runs. */
export const latestRun = (base = join(HERE, "results")) =>
  readdirSync(base)
    .map((d) => join(base, d))
    .filter((d) => existsSync(join(d, "runs.jsonl")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

/**
 * Writes analysis.md, chart.html and submission.json into `dir`.
 * @returns {{ summary: string }} the analysis as Markdown
 */
export const analyze = (dir) => {
  const jsonl = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const readJson = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null);
  const config = readJson("config.json");
  const runs = jsonl("runs.jsonl");
  const quality = jsonl("quality.jsonl");

  const valid = runs.filter((l) => !l.warmup && !l.error && !l.notApplicable && l.cpu != null);
  const groups = new Map();
  for (const l of valid) {
    const k = `${l.video}|${l.res}|${l.path}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const keys = [...groups.keys()].sort((x, y) => {
    const [va, ra, ca] = x.split("|");
    const [vb, rb, cb] = y.split("|");
    return VIDEO_ORDER.indexOf(va) - VIDEO_ORDER.indexOf(vb) || ra.localeCompare(rb) || PATH_ORDER.indexOf(ca) - PATH_ORDER.indexOf(cb);
  });

  const md = [];
  md.push(`# Analysis: ${dir.split("/").at(-1)}`, "");
  md.push(
    `N = ${config.N} repetitions per cell, ${config.seconds} s of video (${config.seconds * 30} frames, 30 fps), ${config.warmupSeconds} s warm-up discarded, shuffled order (seed ${config.seed}), device ${config.device}, CPU ceiling ${config.cores} cores. ` +
      `CI = 95% percentile bootstrap interval of the median (${RESAMPLES} resamples); with N < 5 it is coarse and with N = 1 it does not exist.`,
    "",
  );

  md.push("## Cost per cell (median, IQR and 95% CI)", "");
  md.push("| Video | Res. | Path | n | CPU (s) | CPU per video second | Wall (s) | fps | Anon peak (GB) | sm / enc / dec mean (%) | VRAM peak (MB) | Mb/s |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const table = [];
  for (const k of keys) {
    const [v, res, c] = k.split("|");
    const g = groups.get(k);
    const col = (fn) => g.map(fn).filter((x) => x != null && Number.isFinite(x));
    const cps = col((l) => l.cpuPerSecond);
    const wall = col((l) => l.wall);
    table.push({ v, res, c, cps, wall, ciCps: medianCI(cps), ciWall: medianCI(wall) });
    md.push(
      `| ${VIDEO_NAMES[v] ?? v} | ${res} | ${c} | ${g.length} | ${summary(col((l) => l.cpu))} | ${summary(cps, 2)} | ${summary(wall)} | ${fmt(median(col((l) => l.fps)))} | ${fmt(median(col((l) => l.anonPeakGB)), 2)} | ` +
        `${fmt(median(col((l) => l.gpu?.sm?.mean)), 0)} / ${fmt(median(col((l) => l.gpu?.enc?.mean)), 0)} / ${fmt(median(col((l) => l.gpu?.dec?.mean)), 0)} | ${fmt(median(col((l) => l.gpu?.fbMB?.peak)), 0)} | ${fmt(median(col((l) => l.output?.bitrateKbps / 1000)), 1)} |`,
    );
  }
  md.push("", "VRAM and sm/enc/dec are for the whole GPU, including other resident processes (see environment). Anon = anonymous memory of the cgroup (no page cache).", "");

  md.push("## Ratios against the baseline (baseline median / path median; > 1 = the path spends less)", "");
  md.push("| Video | Res. | Base | Path | CPU: ratio [95% CI] | Wall: ratio [95% CI] |", "|---|---|---|---|---|---|");
  const resolutions = [...new Set(valid.map((l) => l.res))];
  for (const v of VIDEO_ORDER)
    for (const res of resolutions) {
      const base = ["P0", "P1"].find((c) => groups.has(`${v}|${res}|${c}`));
      if (!base) continue;
      const gb = groups.get(`${v}|${res}|${base}`);
      for (const c of PATH_ORDER) {
        if (c === base || !groups.has(`${v}|${res}|${c}`)) continue;
        const g = groups.get(`${v}|${res}|${c}`);
        const rc = ratioCI(gb.map((l) => l.cpu), g.map((l) => l.cpu));
        const rw = ratioCI(gb.map((l) => l.wall), g.map((l) => l.wall));
        md.push(`| ${VIDEO_NAMES[v] ?? v} | ${res} | ${base} | ${c} | ${fmt(rc.value, 2)} ${fmtCI(rc.ci, 2)} | ${fmt(rw.value, 2)} ${fmtCI(rw.ci, 2)} |`);
      }
    }
  md.push("");

  const scaling = PATH_ORDER.filter((c) => groups.has(`B|1080p|${c}`) && groups.has(`B|4k|${c}`));
  if (scaling.length) {
    md.push("## Scaling from 1080p to 4K (B, 4x the pixels)", "", "| Path | CPU 4K / 1080p [CI] | Wall 4K / 1080p [CI] |", "|---|---|---|");
    for (const c of scaling) {
      const a = groups.get(`B|4k|${c}`);
      const b = groups.get(`B|1080p|${c}`);
      const rc = ratioCI(a.map((l) => l.cpu), b.map((l) => l.cpu));
      const rw = ratioCI(a.map((l) => l.wall), b.map((l) => l.wall));
      md.push(`| ${c} | ${fmt(rc.value, 2)} ${fmtCI(rc.ci, 2)} | ${fmt(rw.value, 2)} ${fmtCI(rw.ci, 2)} |`);
    }
    md.push("");
  }

  const withSteps = valid.filter((l) => l.steps?.length);
  if (withSteps.length) {
    md.push("## Layers by step (median)", "");
    md.push("| Video | Res. | Path | Plan CPU / wall (s) | Graphics CPU / wall (s) | ffmpeg CPU / wall (s) | Graphics, % of CPU | Frames reused |", "|---|---|---|---|---|---|---|---|");
    for (const k of keys.filter((k) => /\|P[23]$/.test(k))) {
      const all = groups.get(k);
      const g = all.filter((l) => l.steps);
      const [v, res, c] = k.split("|");
      // remotion-dedup.cjs prints "N frames, C captured, R reused (X%)" at the end of the log.
      const reuse = all.map((l) => Number(l.log?.match(/reused \(([\d.]+)%\)/)?.[1])).filter(Number.isFinite);
      if (!g.length && !reuse.length) continue;
      const st = (n, field) => median(g.map((l) => l.steps.find((e) => e.step === n)?.[field]).filter((x) => x != null));
      md.push(
        `| ${VIDEO_NAMES[v] ?? v} | ${res} | ${c} | ${fmt(st("plan", "cpu"))} / ${fmt(st("plan", "wall"))} | ${fmt(st("graphics", "cpu"))} / ${fmt(st("graphics", "wall"))} | ${fmt(st("ffmpeg", "cpu"))} / ${fmt(st("ffmpeg", "wall"))} | ` +
          `${g.length ? `${fmt((100 * st("graphics", "cpu")) / median(g.map((l) => l.cpu)), 0)}%` : "-"} | ${reuse.length ? `${fmt(median(reuse), 0)}%` : "-"} |`,
      );
    }
    md.push("");
  }

  if (quality.length) {
    md.push("## Quality against the reference (PNG capture + ProRes 4444 XQ, P0 path)", "");
    md.push("| Video | Res. | Output | Frames | SSIM mean | SSIM worst frame | SSIM 1st pct. | PSNR (dB) | VMAF |", "|---|---|---|---|---|---|---|---|---|");
    const ord = (q) => [VIDEO_ORDER.indexOf(q.video), q.res, q.kind === "floor" ? 0 : 1, q.path ?? q.encoder];
    for (const q of [...quality].sort((a, b) => {
      const x = ord(a);
      const y = ord(b);
      return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2] || String(x[3]).localeCompare(String(y[3]));
    }))
      md.push(
        `| ${VIDEO_NAMES[q.video] ?? q.video} | ${q.res} | ${q.kind === "floor" ? `floor: ${q.encoder}` : q.path} | ${q.frames} | ${fmt(q.ssim, 4)} | ${fmt(q.ssimMin, 4)} | ${fmt(q.ssimP01, 4)} | ${fmt(q.psnr, 2)} | ${q.vmaf == null ? "-" : fmt(q.vmaf, 2)} |`,
      );
    md.push("", "Floor = the reference itself re-encoded by each path's encoder: the loss that comes from the encoder alone.", "");
  }

  const na = runs.filter((l) => l.notApplicable);
  if (na.length) md.push("## Not applicable", "", ...[...new Map(na.map((l) => [l.cell, l])).values()].map((l) => `- ${l.cell}: ${l.notApplicable}`), "");
  const errors = runs.filter((l) => l.error);
  md.push("## Failures and waiting", "");
  md.push(`- Valid measured runs: ${valid.length}; failed: ${errors.filter((l) => !l.warmup).length}; failed warm-ups: ${errors.filter((l) => l.warmup).length}.`);
  for (const e of errors) md.push(`  - ${e.cell}${e.warmup ? " (warm-up)" : ` r${e.repetition}`}: ${e.error}`);
  const waits = valid.map((l) => l.wait).filter(Boolean);
  if (waits.length) {
    md.push(
      `- Waiting for a quiet machine: median ${fmt(median(waits.map((e) => e.waitS)))} s, max ${fmt(Math.max(...waits.map((e) => e.waitS)))} s; ` +
        `${waits.filter((e) => e.timedOut).length} runs started after the wait timed out (machine not quiet). 1-minute load at the start of runs: median ${fmt(median(valid.map((l) => l.loadBefore[0])), 2)}, max ${fmt(Math.max(...valid.map((l) => l.loadBefore[0])), 2)}.`,
    );
  }
  const throttled = valid.filter((l) => l.cpuThrottledS > 0);
  md.push(`- Runs that hit the cgroup CPU ceiling (throttled > 0): ${throttled.length} of ${valid.length}.`);
  const others = valid.flatMap((l) => l.gpuBefore?.apps ?? []).map((a) => a.name.split("/").at(-1));
  if (others.length) md.push(`- Other GPU processes seen before runs: ${[...new Set(others)].join(", ")}.`);
  md.push("");
  const text = md.join("\n");
  writeFileSync(join(dir, "analysis.md"), text);

  // ---------- chart ----------
  const COLORS = { P0: ["#2a78d6", "#3987e5"], P1: ["#eb6834", "#d95926"], P2: ["#1baf7a", "#199e70"], P3: ["#eda100", "#c98500"] };
  const panel = (title, field, ciField, unit) => {
    const rows = table.filter((t) => t[field].length);
    if (!rows.length) return "";
    const max = Math.max(...rows.flatMap((t) => [median(t[field]), ...(t[ciField] ?? [])])) * 1.08;
    const W = 760;
    const left = 250;
    const step = 22;
    const H = rows.length * step + 50;
    const x = (v) => left + (v / max) * (W - left - 20);
    const ticks = Array.from({ length: 6 }, (_, i) => (max / 5) * i);
    let y = 20;
    let last = "";
    const marks = rows
      .map((t) => {
        const yy = (y += step);
        const group = `${VIDEO_NAMES[t.v] ?? t.v} ${t.res}`;
        const label = group !== last ? `<text x="${left - 50}" y="${yy + 4}" text-anchor="end" class="lbl">${group}</text>` : "";
        last = group;
        const m = median(t[field]);
        const ci = t[ciField];
        const tip = `${group} ${t.c}: median ${fmt(m, 2)} ${unit}${ci ? `, 95% CI ${fmtCI(ci, 2)}` : ""}, n=${t[field].length}`;
        return (
          `${label}<text x="${left - 10}" y="${yy + 4}" text-anchor="end" class="path">${t.c}</text>` +
          (ci ? `<line x1="${x(ci[0])}" x2="${x(ci[1])}" y1="${yy}" y2="${yy}" stroke="var(--${t.c})" stroke-width="2"/>` : "") +
          `<rect x="${left}" y="${yy - 5}" width="${Math.max(2, x(m) - left)}" height="10" rx="4" fill="var(--${t.c})" opacity="0.35"/>` +
          `<circle cx="${x(m)}" cy="${yy}" r="5" fill="var(--${t.c})" stroke="var(--bg)" stroke-width="2"><title>${tip}</title></circle>` +
          `<rect x="0" y="${yy - step / 2}" width="${W}" height="${step}" fill="transparent"><title>${tip}</title></rect>`
        );
      })
      .join("");
    const axis = ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="25" y2="${H - 20}" class="grid"/><text x="${x(t)}" y="${H - 5}" text-anchor="middle" class="axis">${fmt(t, 1)}</text>`).join("");
    return `<figure><figcaption>${title}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${axis}${marks}</svg></figure>`;
  };
  const vars = (i) => Object.entries(COLORS).map(([k, v]) => `--${k}:${v[i]};`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Render benchmark</title><style>
:root{--bg:#fcfcfb;--fg:#1f1f1e;--fg2:#5f5e5a;--grid:#e4e3de;${vars(0)}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--grid:#3a3a38;${vars(1)}}}
:root[data-theme="dark"]{--bg:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--grid:#3a3a38;${vars(1)}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:820px;padding:16px}
svg{width:100%;height:auto}.lbl{fill:var(--fg);font-size:12px;font-weight:600}.path,.axis{fill:var(--fg2);font-size:11px}
.grid{stroke:var(--grid);stroke-width:1}figure{margin:24px 0}figcaption{font-weight:600;margin-bottom:6px}
.legend span{display:inline-flex;align-items:center;gap:6px;margin-right:16px;color:var(--fg2)}.legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
</style></head><body><h1>Render benchmark: ${dir.split("/").at(-1)}</h1>
<p>N = ${config.N}, ${config.seconds} s per video. Dot = median; thin bar = 95% bootstrap CI (only with N &ge; 2). Hover for values. Full tables in analysis.md.</p>
<p class="legend">${Object.keys(COLORS).filter((c) => table.some((t) => t.c === c)).map((c) => `<span><i style="background:var(--${c})"></i>${c}</span>`).join("")}</p>
${panel("CPU seconds per second of video", "cps", "ciCps", "s/s")}
${panel("Wall time (s)", "wall", "ciWall", "s")}
</body></html>`;
  writeFileSync(join(dir, "chart.html"), html);

  // ---------- submission ----------
  // One file to attach to a benchmark-result issue: config, environment and raw numbers, without command logs.
  const submission = {
    format: "remotion-gpu-bench/1",
    config,
    environment: { start: readJson("environment-start.json"), end: readJson("environment-end.json") },
    runs: runs.map(({ log: _log, errorOutput: _e, ...r }) => r),
    quality,
  };
  writeFileSync(join(dir, "submission.json"), `${JSON.stringify(submission, null, 2)}\n`);
  return { summary: text };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? latestRun());
  console.log(analyze(dir).summary);
}

