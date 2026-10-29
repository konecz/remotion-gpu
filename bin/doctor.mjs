#!/usr/bin/env node
// Checks ffmpeg, the NVIDIA driver and GPU, Vulkan, Remotion's Chrome and bundled ffmpeg, and the CPU ceiling, then
// says which render paths this machine supports.
//
// Usage: node bin/doctor.mjs [--json] [--no-probes] [--cwd <remotion project>]
// Exit code: 0 if P1 or P2 is supported, 1 if only the CPU path is.
import { parseArgs } from "node:util";
import { formatReport, runDoctor } from "../src/doctor.mjs";

const { values: o } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    "no-probes": { type: "boolean", default: false },
    cwd: { type: "string", default: process.cwd() },
  },
});
const report = await runDoctor({ cwd: o.cwd, probes: !o["no-probes"] });
if (o.json) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report));
process.exitCode = report.paths.P1.ok || report.paths.P2.ok ? 0 : 1;
