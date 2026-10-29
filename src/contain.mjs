// Containment for any render: lowest priority (nice 19, idle I/O class) and a CPU ceiling, so a render never starves
// the other services on the machine. The ceiling comes from a transient systemd user scope (CPUQuota). Without a
// systemd user session it falls back to pinning the process to the first N cores with taskset, and without taskset
// only the priority is applied.
//
// A process that is already contained (RGPU_CONTAINED=1, set by measure.mjs) does not open another scope: a new scope
// would leave the measured cgroup and its ceiling.
import { execFileSync, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

/** CPU ceiling in cores. Default 8, or all cores if the machine has fewer; RGPU_CORES overrides. */
export const CORES = Number(process.env.RGPU_CORES ?? Math.min(8, availableParallelism()));

const has = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return !r.error && r.status === 0;
};

let cache;
/** What this machine offers for containment (probed once). */
export const containmentSupport = () =>
  (cache ??= {
    systemdUserScope: has("systemd-run", ["--user", "--scope", "--quiet", "true"]),
    taskset: has("taskset", ["--version"]),
    ionice: has("ionice", ["-c", "3", "true"]),
    nice: has("nice", ["-n", "19", "true"]),
  });

/**
 * Command prefix that applies the containment.
 * @param {number} [cores] CPU ceiling in cores.
 * @returns {string[]} e.g. ["systemd-run", "--user", "--scope", "--quiet", "-p", "CPUQuota=800%", "nice", "-n", "19", "ionice", "-c", "3"]
 */
export const containPrefix = (cores = CORES) => {
  const s = containmentSupport();
  const ceiling = process.env.RGPU_CONTAINED
    ? []
    : s.systemdUserScope
      ? ["systemd-run", "--user", "--scope", "--quiet", "-p", `CPUQuota=${Math.round(cores * 100)}%`]
      : s.taskset
        ? ["taskset", "-c", `0-${Math.max(0, Math.ceil(cores) - 1)}`]
        : [];
  return [...ceiling, ...(s.nice ? ["nice", "-n", "19"] : []), ...(s.ionice ? ["ionice", "-c", "3"] : [])];
};

/** Which kind of ceiling the prefix applies: "cgroup", "taskset", "inherited" or "none". */
export const ceilingKind = () => {
  if (process.env.RGPU_CONTAINED) return "inherited";
  const s = containmentSupport();
  return s.systemdUserScope ? "cgroup" : s.taskset ? "taskset" : "none";
};

/**
 * Re-runs the current CLI inside the containment, unless it already is (RGPU_CONTAINED=1) or RGPU_NO_CONTAIN=1.
 * Call it first thing in a CLI's main: when it re-runs, it exits with the child's code and never returns.
 */
export const ensureContained = () => {
  if (process.env.RGPU_CONTAINED || process.env.RGPU_NO_CONTAIN) return;
  const p = containPrefix();
  const env = { ...process.env, RGPU_CONTAINED: "1" };
  if (!p.length) {
    process.env.RGPU_CONTAINED = "1";
    return;
  }
  const r = spawnSync(p[0], [...p.slice(1), process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
};

let prefix;
/**
 * Runs a command contained, with its output on the terminal. Throws if it fails.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export const contained = (cmd, args, options = {}) => {
  prefix ??= containPrefix();
  const all = [...prefix, cmd, ...args];
  return execFileSync(all[0], all.slice(1), { stdio: "inherit", ...options });
};
