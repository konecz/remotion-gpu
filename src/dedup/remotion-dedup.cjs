// Skips capturing repeated frames when Remotion renders an image sequence (`--sequence`). Before a frame is captured,
// it hashes (SHA-256) the page state: the whole HTML, every CSS rule, form values, scroll and viewport. If that state
// was captured before, the frame file becomes a hard link to the file already written, without going through Chrome.
// In a graphics-only layer (captions and lower thirds that hold still), many frames repeat: about 29% on a real
// 75 s video, -17% CPU for the graphics step.
//
// Usage: preload it in the same process as the Remotion CLI (the process that calls renderFrames):
//   node --require ./src/dedup/remotion-dedup.cjs node_modules/@remotion/cli/remotion-cli.js render ... --sequence
// RGPU_DEDUP=0 disables it; RGPU_DEDUP=verify captures everything and checks at the end that frames with the same
// state produced byte-identical files (fails otherwise).
//
// Hash safety: the DOM state does not describe everything that reaches the screen. These frames are never reused
// (always captured): <canvas>, <video>, <iframe>, <object>, <embed> or SVG <image>; an <img> not loaded yet; fonts
// loading; running CSS animations or transitions; shadow DOM; cross-origin stylesheets. A CSS url() background that
// has not loaded is not detected (it would also break a normal render: Remotion only waits for delayRender).
//
// It patches @remotion/renderer internals (there is no public hook before the capture): the `takeFrame` export of
// dist/take-frame.js, which render-frame-with-option-to-reject.js calls through the module object (so replacing the
// export works), and `puppeteerEvaluateWithCatch` from dist/puppeteer-evaluate.js. Tested on 4.0.536 only. Any other
// version makes the render FAIL with an explanation; after checking the points above, add the version to TESTED.
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const TESTED = ["4.0.536"];
const mode = process.env.RGPU_DEDUP ?? "1";

const fail = (msg) => {
  throw new Error(`remotion-dedup: ${msg} (RGPU_DEDUP=0 disables frame reuse)`);
};

/**
 * Page state, evaluated inside Chrome (serialized by Remotion: nothing from outside the function). Returns a hex
 * SHA-256, or null when the frame must not be reused.
 */
const pageState = async () => {
  if (document.querySelector("canvas, video, iframe, object, embed, image")) return null;
  if (document.fonts.status !== "loaded" || document.getAnimations().length) return null;
  for (const img of document.images) if (!img.complete || !img.naturalWidth) return null;
  const parts = [document.documentElement.outerHTML];
  for (const el of document.querySelectorAll("*")) if (el.shadowRoot) return null;
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return null; // cross-origin stylesheet: rules are not readable
    }
    for (const r of rules) parts.push(r.cssText);
  }
  for (const el of document.querySelectorAll("input, textarea, select")) parts.push(el.value);
  parts.push(scrollX, scrollY, innerWidth, innerHeight, devicePixelRatio);
  if (!crypto.subtle) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Finds @remotion/renderer's dist folder from the working directory, or from this file as a fallback. */
const rendererDist = () => {
  for (const base of [process.cwd(), __dirname]) {
    try {
      const req = createRequire(path.join(base, "package.json"));
      return path.dirname(fs.realpathSync(req.resolve("@remotion/renderer")));
    } catch {
      // try the next base
    }
  }
  return null;
};

const install = () => {
  const dist = rendererDist();
  if (!dist) return; // a process without Remotion (a child of the CLI, for example): nothing to do
  const { version } = JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8"));
  if (!TESTED.includes(version)) fail(`@remotion/renderer ${version} was not tested (tested: ${TESTED.join(", ")})`);
  const tf = require(path.join(dist, "take-frame.js"));
  const { puppeteerEvaluateWithCatch } = require(path.join(dist, "puppeteer-evaluate.js"));
  const caller = fs.readFileSync(path.join(dist, "render-frame-with-option-to-reject.js"), "utf8");
  if (typeof tf.takeFrame !== "function" || typeof puppeteerEvaluateWithCatch !== "function" || !caller.includes("(0, take_frame_1.takeFrame)(")) {
    fail(`the internal API changed in ${version}`);
  }

  const original = tf.takeFrame;
  const seen = new Map(); // state -> promise of the captured file
  const toVerify = []; // [state, file] of every frame, in verify mode
  const n = { frames: 0, captured: 0, reused: 0, stateless: 0 };

  tf.takeFrame = async (options) => {
    const { freePage, imageFormat, output, wantsBuffer, remotionSharedMemory, timeoutInMilliseconds } = options;
    if (!freePage || !("imageFormat" in options)) fail("takeFrame called with other options: the internal API changed");
    // Only the file sequence (--sequence): buffers, shared memory and 'none' take the normal path.
    if (imageFormat === "none" || wantsBuffer || remotionSharedMemory || !output) return original(options);
    n.frames++;
    const { value: state } = await puppeteerEvaluateWithCatch({
      pageFunction: pageState, args: [], frame: null, page: freePage, timeoutInMilliseconds,
    });
    if (typeof state !== "string") {
      n.stateless++;
      n.captured++;
      return original(options);
    }
    // The format is part of the key: the same DOM as PNG and as JPEG are different files.
    const key = `${imageFormat}:${state}`;
    if (mode === "verify") toVerify.push([key, output]);
    const previous = mode === "verify" ? undefined : seen.get(key);
    if (previous) {
      const file = await previous;
      fs.rmSync(output, { force: true });
      fs.linkSync(file, output);
      n.reused++;
      return null;
    }
    n.captured++;
    const capture = original(options).then(() => output);
    seen.set(key, capture);
    try {
      await capture;
    } catch (e) {
      seen.delete(key); // Remotion retries; the next attempt captures
      throw e;
    }
    return null;
  };

  process.on("exit", (code) => {
    if (code !== 0) return;
    if (n.frames === 0) {
      console.error("remotion-dedup: no frame went through the patched takeFrame; did the internal API change? (it only acts on --sequence)");
      process.exitCode = 1;
      return;
    }
    const pct = (x) => `${((100 * x) / n.frames).toFixed(1)}%`;
    console.error(
      `remotion-dedup: ${n.frames} frames, ${n.captured} captured, ${n.reused} reused (${pct(n.reused)}), ` +
        `${n.stateless} without state (canvas, video, loading...)`,
    );
    if (mode !== "verify") return;
    const first = new Map();
    let same = 0;
    const different = [];
    for (const [key, file] of toVerify) {
      const h = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (!first.has(key)) first.set(key, [h, file]);
      else if (first.get(key)[0] === h) same++;
      else different.push(`${path.basename(first.get(key)[1])} x ${path.basename(file)}`);
    }
    console.error(`remotion-dedup (verify): ${first.size} states, ${same} repeats with identical files, ${different.length} different`);
    if (different.length) {
      console.error(different.slice(0, 20).join("\n"));
      process.exitCode = 1;
    }
  });
};

module.exports = { pageState, TESTED, install };

if (mode !== "0") install();
