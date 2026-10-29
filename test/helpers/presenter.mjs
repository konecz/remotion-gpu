// Loads the TypeScript framing code for Node tests by bundling it with esbuild (the same way plans are exported).
import { importForNode } from "../../src/layers/pipeline.mjs";

const entry = new URL("./presenter-entry.ts", import.meta.url).pathname;
const mod = await importForNode(entry);
export const { framePresenter, presenterTake, cropAndPosition, linearizationReport } = mod;
