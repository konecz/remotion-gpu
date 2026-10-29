// The dedup patch must fail loudly, not silently render without reuse (or worse, reuse wrong frames), when the
// installed @remotion/renderer is not the tested version or its internals changed. Run against a fake package.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.RGPU_DEDUP = "0"; // load the module without patching the real Remotion in this process
const { install, TESTED } = createRequire(import.meta.url)("../src/dedup/remotion-dedup.cjs");

const tmp = mkdtempSync(join(tmpdir(), "rgpu-dedup-"));
const cwd = process.cwd();
after(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** A project folder with a fake @remotion/renderer of the given version and internals. */
const fakeRenderer = (name, version, { takeFrame = true } = {}) => {
  const root = join(tmp, name);
  const pkg = join(root, "node_modules", "@remotion", "renderer");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@remotion/renderer", version, main: "dist/index.js" }));
  writeFileSync(join(pkg, "dist", "index.js"), "");
  writeFileSync(join(pkg, "dist", "take-frame.js"), takeFrame ? "exports.takeFrame = async () => {};" : "exports.other = 1;");
  writeFileSync(join(pkg, "dist", "puppeteer-evaluate.js"), "exports.puppeteerEvaluateWithCatch = async () => ({});");
  writeFileSync(join(pkg, "dist", "render-frame-with-option-to-reject.js"), "(0, take_frame_1.takeFrame)(");
  return root;
};

test("install refuses an untested @remotion/renderer version, naming the way out", () => {
  process.chdir(fakeRenderer("other-version", "4.0.999"));
  assert.throws(install, (e) => /4\.0\.999 was not tested/.test(e.message) && e.message.includes(TESTED[0]) && /RGPU_DEDUP=0/.test(e.message));
});

test("install refuses the tested version when its internal API changed", () => {
  process.chdir(fakeRenderer("changed-api", TESTED[0], { takeFrame: false }));
  assert.throws(install, /the internal API changed in 4\.0\.536/);
});
