// Path P2 end to end, for any Remotion project that exports its framing as a plan:
//   1. plan: bundle a small TS entry with esbuild (it imports the same framing code the composition uses) and write
//      plan.json;
//   2. graphics: Remotion renders the composition in graphics-only mode (no video, transparent background) as a PNG
//      sequence with alpha, optionally skipping repeated frames (dedup);
//   3. ffmpeg on the GPU (render-layers.mjs): decode, crop, position, composite, encode.
// Each step records wall time and, inside a cgroup (measure.mjs), the CPU it spent.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contained } from "../contain.mjs";
import { remotionCommand } from "../remotion-gpu.mjs";
import { renderLayers } from "./render-layers.mjs";
import { assertPlan } from "./validate-plan.mjs";

/** CPU seconds spent so far by this process's cgroup (null outside cgroup v2). */
export const cgroupCpu = () => {
  try {
    const cg = `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").trim().split(":")[2]}`;
    const s = readFileSync(join(cg, "cpu.stat"), "utf8");
    const field = (n) => Number(s.match(new RegExp(`^${n} (\\d+)`, "m"))[1]);
    return (field("user_usec") + field("system_usec")) / 1e6;
  } catch {
    return null;
  }
};

/**
 * Runs `fn` and records its wall time and cgroup CPU in `steps`.
 * @param {{ step: string, wall: number, cpu: number|null }[]} steps
 */
export const timed = async (steps, step, fn) => {
  const c0 = cgroupCpu();
  const t0 = performance.now();
  const r = await fn();
  const c1 = cgroupCpu();
  steps.push({ step, wall: (performance.now() - t0) / 1000, cpu: c0 == null || c1 == null ? null : c1 - c0 });
  return r;
};

/**
 * Bundles a TS/JS entry for Node with esbuild (it ships with Remotion) and returns its default export. The entry
 * can import the composition's framing code, and Remotion's spring/interpolate, but not React components that
 * need a browser.
 * @param {string} entry absolute path of the entry file
 */
export const importForNode = async (entry) => {
  const { build } = await import("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "rgpu-plan-"));
  const js = join(dir, "entry.mjs");
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: js, logLevel: "error" });
    return (await import(pathToFileURL(js).href)).default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Writes the plan from an entry whose default export is a plan, or a function (input) => plan.
 * @returns {Promise<object>} the validated plan
 */
export const exportPlan = async ({ entry, input = {}, output }) => {
  const def = await importForNode(entry);
  const plan = assertPlan(typeof def === "function" ? await def(input) : def);
  if (output) writeFileSync(output, JSON.stringify(plan));
  return plan;
};

/**
 * Renders the graphics layer: a PNG sequence with alpha, one file per frame, numbered by timeline frame.
 * @param {{ cwd: string, serveUrl: string, composition: string, outDir: string, props?: object,
 *           frames?: [number, number], dedup?: boolean, extraArgs?: string[], env?: object }} o
 */
export const renderGraphics = ({ cwd, serveUrl, composition, outDir, props = {}, frames, dedup = true, extraArgs = [], env = {} }) => {
  rmSync(outDir, { recursive: true, force: true });
  const { cmd, args } = remotionCommand({ cwd, dedup });
  contained(
    cmd,
    [
      ...args, "render", serveUrl, composition, outDir, "--sequence", "--image-format=png",
      `--props=${JSON.stringify(props)}`, ...(frames ? [`--frames=${frames[0]}-${frames[1]}`] : []), ...extraArgs, "--log=error",
    ],
    { cwd, env: { ...process.env, RGPU_DEDUP: dedup ? (process.env.RGPU_DEDUP ?? "1") : "0", ...env } },
  );
};

/**
 * The whole layered render.
 * @param {{ cwd: string, planEntry: string, planInput?: object, serveUrl: string, composition: string,
 *           graphicsProps?: object, workDir: string, output: string, frames?: [number, number], dedup?: boolean,
 *           remotionArgs?: string[], parallel?: number, cq?: number, codec?: "h264"|"hevc", vulkanDevice?: string,
 *           keepGraphics?: boolean }} o
 * @returns {Promise<{ steps: { step: string, wall: number, cpu: number|null }[], plan: object }>}
 */
export const renderLayered = async (o) => {
  mkdirSync(o.workDir, { recursive: true });
  const planFile = join(o.workDir, "plan.json");
  const graphics = join(o.workDir, "graphics");
  const steps = [];
  const plan = await timed(steps, "plan", () => exportPlan({ entry: o.planEntry, input: o.planInput, output: planFile }));
  await timed(steps, "graphics", () =>
    renderGraphics({
      cwd: o.cwd, serveUrl: o.serveUrl, composition: o.composition, outDir: graphics, props: o.graphicsProps,
      frames: o.frames, dedup: o.dedup, extraArgs: o.remotionArgs,
    }),
  );
  await timed(steps, "ffmpeg", () =>
    renderLayers(planFile, {
      graphics, output: o.output, from: o.frames?.[0], to: o.frames?.[1], parallel: o.parallel, cq: o.cq, codec: o.codec,
      vulkanDevice: o.vulkanDevice,
    }),
  );
  if (!o.keepGraphics) rmSync(graphics, { recursive: true, force: true });
  return { steps, plan };
};

/** Bundles a Remotion entry once (`remotion bundle`), so several renders skip webpack. Returns the bundle dir. */
export const bundleProject = ({ cwd, entry, outDir }) => {
  const { cmd, args } = remotionCommand({ cwd });
  contained(cmd, [...args, "bundle", entry, `--out-dir=${outDir}`, "--log=error"], { cwd });
  return outDir;
};
