// Kept almost empty on purpose: render.mjs passes every option on the command line (P1 flags from
// src/remotion-gpu.mjs, graphics-only flags for the layered path), so both paths are explicit.
import { Config } from "@remotion/cli/config";

Config.setOverwriteOutput(true);
