// Measures a render command the same way every time, so paths and changes can be compared.
//
// One run executes the command contained (contain.mjs) in its own transient systemd user scope and records:
//   - CPU time: user+sys from the scope's cgroup cpu.stat. This counts every descendant, including the Chrome
//     processes Remotion spawns (`/usr/bin/time` misses them and reports less than half). Without a systemd user
//     session it falls back to the shell's `times` (children only; may miss detached processes: flagged in the result);
//   - wall time and frames per second;
//   - memory: cgroup memory.peak (includes page cache of written files) and the peak of anonymous memory sampled
//     every 0.5 s (closest to "summed RSS" without double counting shared memory);
//   - GPU: `nvidia-smi dmon -s um` (1 sample/s) averages and peaks of sm, mem bandwidth, enc, dec and used VRAM. These
//     are for the WHOLE GPU: other GPU processes (an LLM server, other renders) are recorded separately;
//   - size, duration and bitrate of the output.
//
// CLI:
//   node src/measure.mjs [--runs 2] [--frames 450] [--label base] [--json out.jsonl] [--gpu 0] -- <command...>
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CORES, ceilingKind, containPrefix } from "./contain.mjs";

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const attempt = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const out = (cmd, args, options = {}) =>
  attempt(() => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, ...options }).trim());

/** Replaces the home directory with "~" so results can be shared without local paths. */
export const redact = (s) => (typeof s === "string" ? s.split(homedir()).join("~") : s);

// ---------- processes and load ----------

const readProc = (pid) => {
  const stat = attempt(() => readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (!stat) return null;
  const end = stat.lastIndexOf(")");
  const f = stat.slice(end + 2).split(" ");
  return {
    pid: Number(pid),
    comm: stat.slice(stat.indexOf("(") + 1, end),
    state: f[0],
    ppid: Number(f[1]),
    ticks: Number(f[11]) + Number(f[12]),
    args: attempt(() => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "), ""),
  };
};
const allProcs = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(readProc).filter(Boolean);

/** Render processes: Remotion, its Chrome and compositor, the layered renderer or ffmpeg. */
const isRender = (p) =>
  p.state !== "Z" &&
  (/chrome-headless-shell|compositor-linux|remotion-cli\.js|\bremotion (render|still|bundle|benchmark)\b|render-layers\.mjs/.test(p.args) ||
    p.comm === "ffmpeg");

const ancestors = () => {
  const s = new Set();
  for (let p = readProc(process.pid); p && p.pid > 1; p = readProc(p.ppid)) s.add(p.pid);
  return s;
};

/** CPU per process over a short window, and the busy fraction of the whole machine (0..1). */
export const sampleCpu = async (windowMs = 2000) => {
  const total = () => readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1).map(Number);
  const t0 = total();
  const a = new Map(allProcs().map((p) => [p.pid, p]));
  await sleep(windowMs);
  const t1 = total();
  const b = allProcs();
  const busy = (t) => t.reduce((x, y) => x + y, 0) - t[3] - t[4];
  const sum = (t) => t.reduce((x, y) => x + y, 0);
  const machineBusy = (busy(t1) - busy(t0)) / (sum(t1) - sum(t0));
  const procs = b
    .filter((p) => a.has(p.pid))
    .map((p) => ({ pid: p.pid, comm: p.comm, cpu: ((p.ticks - a.get(p.pid).ticks) / 100 / (windowMs / 1000)) * 100 }))
    .filter((p) => p.cpu > 0)
    .sort((x, y) => y.cpu - x.cpu);
  return { machineBusy, procs };
};

/** Render processes that are not ours (not our ancestors nor descendants of them). */
export const otherRenders = () => {
  const mine = ancestors();
  return allProcs()
    .filter((p) => !mine.has(p.pid) && isRender(p))
    .map((p) => ({ pid: p.pid, comm: p.comm }));
};

/**
 * Waits until the machine is quiet: no other render running and, for `stable` checks in a row (every ~5 s), 1-minute
 * load average below `loadMax` and instantaneous busy CPU below `busyMax`. Gives up after `maxS` seconds and goes on,
 * marking `timedOut`.
 */
export const waitForQuiet = async ({ loadMax = 8, busyMax = 0.35, stable = 2, maxS = 1200, log = console.log } = {}) => {
  const t0 = Date.now();
  let streak = 0;
  const seen = new Map();
  let last = null;
  for (;;) {
    const others = otherRenders();
    for (const o of others) seen.set(o.pid, o);
    const cpu = await sampleCpu(2000);
    const load1 = loadavg()[0];
    last = { load1, machineBusy: cpu.machineBusy, otherRenders: others.length };
    const quiet = others.length === 0 && load1 < loadMax && cpu.machineBusy < busyMax;
    streak = quiet ? streak + 1 : 0;
    const waited = (Date.now() - t0) / 1000;
    if (streak >= stable) return { waitS: waited, timedOut: false, otherRendersSeen: seen.size, before: last };
    if (waited > maxS) return { waitS: waited, timedOut: true, otherRendersSeen: seen.size, before: last };
    if (!quiet && Math.round(waited) % 60 < 7)
      log(`  waiting: load1 ${load1.toFixed(2)}, CPU ${(cpu.machineBusy * 100).toFixed(0)}%, other renders ${others.length}`);
    await sleep(3000);
  }
};

// ---------- GPU ----------

/** Parses `nvidia-smi dmon` output lines into samples ({gpu, sm, mem, enc, dec, fb, ...}). Pure, for tests. */
export const parseDmon = (text) => {
  let header = null;
  const samples = [];
  for (const l of text.split("\n")) {
    if (l.startsWith("# gpu")) header = l.slice(1).trim().split(/\s+/);
    else if (!l.startsWith("#") && l.trim() && header) {
      const v = l.trim().split(/\s+/);
      samples.push(Object.fromEntries(header.map((k, i) => [k, v[i] === "-" ? null : Number(v[i])])));
    }
  }
  return samples;
};

/** Open dmon processes, so a caller can kill them on SIGINT. */
export const openDmons = new Set();

const startDmon = (gpu) => {
  const p = spawn("nvidia-smi", ["dmon", "-s", "um", "-d", "1", ...(gpu != null ? ["-i", String(gpu)] : [])], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let text = "";
  p.on("error", () => {}); // no nvidia-smi: no samples
  p.stdout?.on("data", (d) => {
    text += d;
  });
  openDmons.add(p);
  return {
    stop: () => {
      p.kill();
      openDmons.delete(p);
      return parseDmon(text);
    },
  };
};

const gpuSummary = (samples) => {
  const st = (k) => {
    const v = samples.map((a) => a[k]).filter((x) => Number.isFinite(x));
    return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, peak: Math.max(...v) } : { mean: null, peak: null };
  };
  return { samples: samples.length, sm: st("sm"), mem: st("mem"), enc: st("enc"), dec: st("dec"), fbMB: st("fb") };
};

/** Compute processes on the GPU (name and VRAM): a resident LLM server or another render is a confounder. */
export const gpuApps = (gpu) =>
  (out("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits", ...(gpu != null ? ["-i", String(gpu)] : [])]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, name, mem] = l.split(",").map((s) => s.trim());
      return { pid: Number(pid), name: redact(name), memMB: Number(mem) };
    });

/** One `nvidia-smi pmon` sample: GPU use per process. */
export const pmon = (gpu) =>
  (out("nvidia-smi", ["pmon", "-s", "u", "-c", "1", ...(gpu != null ? ["-i", String(gpu)] : [])]) ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const v = l.trim().split(/\s+/);
      const n = (x) => (x === "-" ? 0 : Number(x));
      return { pid: Number(v[1]), sm: n(v[3]), enc: n(v[5]), dec: n(v[6]), name: v.at(-1) };
    });

// ---------- output ----------

/** ffprobe summary of a media file (size, duration, bitrate, codec, size, pixel format, color tags, frames, audio). */
export const probeOutput = (file) => {
  if (!file || !existsSync(file)) return null;
  const j = attempt(() =>
    JSON.parse(
      out("ffprobe", [
        "-v", "error", "-show_entries",
        "format=duration,bit_rate:stream=codec_name,codec_type,width,height,pix_fmt,color_space,color_transfer,color_range,nb_frames,avg_frame_rate",
        "-of", "json", file,
      ]),
    ),
  );
  const v = j?.streams?.find((s) => s.codec_type === "video");
  const bytes = statSync(file).size;
  const duration = Number(j?.format?.duration);
  return {
    bytes,
    duration,
    bitrateKbps: duration ? (bytes * 8) / duration / 1000 : null,
    codec: v?.codec_name,
    width: v?.width,
    height: v?.height,
    pixFmt: v?.pix_fmt,
    fps: v?.avg_frame_rate,
    color: { space: v?.color_space, transfer: v?.color_transfer, range: v?.color_range },
    frames: Number(v?.nb_frames) || null,
    audio: !!j?.streams?.some((s) => s.codec_type === "audio"),
  };
};

// ---------- one run ----------

/**
 * Runs `cmd args` contained and measured. Throws if the command fails, with the tail of its output in `e.output`.
 * @param {{ cmd: string, args: string[], cwd?: string, env?: object, frames?: number|null, output?: string|null,
 *           gpu?: number|null, echo?: boolean }} o
 */
export const measureRun = async ({ cmd, args, cwd = process.cwd(), env = {}, frames = null, output = null, gpu = null, echo = false }) => {
  const prefix = containPrefix();
  const cgroup = prefix[0] === "systemd-run";
  const dir = mkdtempSync(join(tmpdir(), "rgpu-run-"));
  // The shell runs inside the scope: after the command, it reads its own cgroup's cpu.stat and memory.peak.
  const sh = cgroup
    ? `cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo "$cg" > "${dir}/cg"; "$@"; s=$?; ` +
      `cat "$cg/cpu.stat" > "${dir}/cpu"; cat "$cg/memory.peak" > "${dir}/peak" 2>/dev/null; cat "$cg/memory.stat" > "${dir}/memstat"; exit $s`
    : `"$@"; s=$?; times > "${dir}/times"; exit $s`;
  const gpuBefore = { apps: gpuApps(gpu), pmon: pmon(gpu) };
  const dmon = startDmon(gpu);
  let anonPeak = 0;
  let cg = null;
  const sampler = setInterval(() => {
    cg ??= attempt(() => readFileSync(join(dir, "cg"), "utf8").trim());
    if (!cg) return;
    const anon = attempt(() => Number(readFileSync(join(cg, "memory.stat"), "utf8").match(/^anon (\d+)/m)[1]), 0);
    anonPeak = Math.max(anonPeak, anon);
  }, 500);
  const loadBefore = loadavg();
  const t0 = process.hrtime.bigint();
  const child = spawn(prefix[0], [...prefix.slice(1), "sh", "-c", sh, "sh", cmd, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RGPU_CONTAINED: "1", ...env },
  });
  let text = "";
  const collect = (d) => {
    text = (text + d).slice(-20000);
    if (echo) process.stderr.write(d);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise((ok) => child.on("close", ok));
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  clearInterval(sampler);
  const samples = dmon.stop();
  const loadAfter = loadavg();
  try {
    if (code !== 0) {
      const e = new Error(`command exited with ${code}`);
      e.output = text.slice(-4000);
      throw e;
    }
    let cpu;
    let mem = {};
    if (cgroup) {
      const st = readFileSync(join(dir, "cpu"), "utf8");
      const field = (n) => Number(st.match(new RegExp(`^${n} (\\d+)`, "m"))?.[1] ?? 0) / 1e6;
      const memstat = attempt(() => readFileSync(join(dir, "memstat"), "utf8"), "");
      const anonEnd = Number(memstat.match(/^anon (\d+)/m)?.[1] ?? 0);
      cpu = { cpuUser: field("user_usec"), cpuSys: field("system_usec"), cpuThrottledS: field("throttled_usec"), cpuSource: "cgroup" };
      mem = {
        memPeakGB: attempt(() => Number(readFileSync(join(dir, "peak"), "utf8")) / 2 ** 30),
        anonPeakGB: Math.max(anonPeak, anonEnd) / 2 ** 30,
      };
    } else {
      const t = parseTimes(readFileSync(join(dir, "times"), "utf8"));
      cpu = { cpuUser: t.user, cpuSys: t.sys, cpuThrottledS: null, cpuSource: "rusage (children only; detached processes may be missed)" };
    }
    return {
      ...cpu,
      cpu: cpu.cpuUser + cpu.cpuSys,
      wall,
      fps: frames ? frames / wall : null,
      ...mem,
      gpu: gpuSummary(samples),
      gpuBefore,
      loadBefore,
      loadAfter,
      output: probeOutput(output),
      log: redact(text.slice(-1500)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Parses the POSIX `times` builtin output; the second line is the children's user and sys time. Pure, for tests. */
export const parseTimes = (text) => {
  const lines = text.trim().split("\n");
  const secs = (s) => {
    const m = s.match(/(?:(\d+)m)?([\d.]+)s/);
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : 0;
  };
  const [user, sys] = (lines[1] ?? lines[0]).trim().split(/\s+/).map(secs);
  return { user, sys };
};

// ---------- environment ----------

/** Snapshot of the machine and software, for the raw results. Local paths and the host name are left out. */
export const environment = async ({ projectDir = process.cwd(), gpu = null } = {}) => {
  const req = (p) => attempt(() => JSON.parse(readFileSync(join(projectDir, "node_modules", p, "package.json"), "utf8")).version);
  const cpu = await sampleCpu(3000);
  const filters = out("ffmpeg", ["-hide_banner", "-filters"]) ?? "";
  const q = (f) => out("nvidia-smi", [`--query-gpu=${f}`, "--format=csv,noheader,nounits", ...(gpu != null ? ["-i", String(gpu)] : [])]);
  const chromeDir = join(projectDir, "node_modules/.remotion/chrome-headless-shell");
  return {
    when: new Date().toISOString(),
    kernel: out("uname", ["-r"]),
    os: attempt(() => readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)/m)[1]),
    cpu: {
      model: cpus()[0]?.model,
      threads: cpus().length,
      governor: attempt(() => readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "utf8").trim()),
    },
    memoryGB: { total: totalmem() / 2 ** 30, free: freemem() / 2 ** 30 },
    containment: { cores: CORES, ceiling: ceilingKind(), prefix: containPrefix() },
    gpu: {
      index: gpu,
      name: q("name"),
      driver: q("driver_version"),
      vramTotalMB: Number(q("memory.total")) || null,
      vramUsedMB: Number(q("memory.used")) || null,
      clocks: q("clocks.sm,clocks.mem,clocks.max.sm,pstate,temperature.gpu,power.draw"),
      apps: gpuApps(gpu),
      pmon: pmon(gpu),
    },
    versions: {
      node: process.version,
      remotion: req("remotion"),
      remotionCli: req("@remotion/cli"),
      remotionRenderer: req("@remotion/renderer"),
      remotionMedia: req("@remotion/media"),
      chromeHeadlessShell: attempt(() => readFileSync(join(chromeDir, "VERSION"), "utf8").trim()),
      ffmpegSystem: out("ffmpeg", ["-hide_banner", "-version"])?.split("\n")[0],
      libplacebo: /\slibplacebo\s/.test(filters),
      libvmaf: /\slibvmaf\s/.test(filters),
      esbuild: req("esbuild"),
    },
    git: {
      commit: out("git", ["rev-parse", "HEAD"], { cwd: projectDir }),
      dirty: (out("git", ["status", "--porcelain", "."], { cwd: projectDir }) ?? "").length > 0,
    },
    load: { loadavg: loadavg(), machineBusy: cpu.machineBusy, top: cpu.procs.slice(0, 12).map(({ comm, cpu: c }) => ({ comm, cpu: c })) },
    otherRenders: otherRenders().length,
  };
};

// ---------- CLI ----------

const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const line = (r) =>
  `cpu ${fmt(r.cpu)} s | wall ${fmt(r.wall)} s | ${fmt(r.fps)} fps | anon ${fmt(r.anonPeakGB, 2)} GB | ` +
  `sm ${fmt(r.gpu?.sm?.mean)}% enc ${fmt(r.gpu?.enc?.mean)}% dec ${fmt(r.gpu?.dec?.mean)}%`;

const main = async () => {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) {
    console.error("usage: node src/measure.mjs [--runs N] [--frames N] [--label x] [--json file.jsonl] [--gpu i] [--output file] -- <command...>");
    process.exit(2);
  }
  const { values: o } = parseArgs({
    args: argv.slice(0, sep),
    options: {
      runs: { type: "string", default: "2" },
      frames: { type: "string" },
      label: { type: "string", default: "run" },
      json: { type: "string" },
      gpu: { type: "string" },
      output: { type: "string" },
    },
  });
  const [cmd, ...args] = argv.slice(sep + 1);
  const rs = [];
  const stop = () => {
    for (const p of openDmons) p.kill();
  };
  process.on("SIGINT", () => (stop(), process.exit(130)));
  for (let i = 1; i <= Number(o.runs); i++) {
    const r = await measureRun({
      cmd, args, frames: o.frames ? Number(o.frames) : null, gpu: o.gpu ?? null, output: o.output ?? null, echo: true,
    });
    rs.push(r);
    console.log(`[${o.label}] run ${i}: ${line(r)}${r.cpuSource !== "cgroup" ? ` (CPU from ${r.cpuSource})` : ""}`);
    if (o.json) appendFileSync(o.json, `${JSON.stringify({ label: o.label, run: i, command: redact([cmd, ...args].join(" ")), ...r })}\n`);
  }
  const mean = (k) => rs.reduce((t, r) => t + (r[k] ?? 0), 0) / rs.length;
  const spread = (k) => {
    const v = rs.map((r) => r[k]);
    return mean(k) ? ((Math.max(...v) - Math.min(...v)) / mean(k)) * 100 : 0;
  };
  console.log(`[${o.label}] mean of ${rs.length}: cpu ${fmt(mean("cpu"))} s | wall ${fmt(mean("wall"))} s`);
  console.log(`[${o.label}] spread (max-min)/mean: cpu ${fmt(spread("cpu"))}% | wall ${fmt(spread("wall"))}%`);
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
