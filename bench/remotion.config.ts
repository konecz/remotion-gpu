// Almost empty on purpose: each benchmark path passes its own options on the command line (matrix.mjs), so P0 is
// Remotion's factory defaults (no --gl, JPEG 80, libx264 CRF 18, default concurrency).
import { Config } from "@remotion/cli/config";

Config.setOverwriteOutput(true);
