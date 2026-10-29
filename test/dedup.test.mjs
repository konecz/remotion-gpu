// The dedup hash criterion, run against a fake DOM: frames whose content the DOM does not describe (canvas, video,
// iframes, loading images or fonts, running animations, shadow DOM, cross-origin CSS) must never be reused.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

process.env.RGPU_DEDUP = "0"; // load the module without patching Remotion in this process
const { pageState, TESTED } = createRequire(import.meta.url)("../src/dedup/remotion-dedup.cjs");

const fakeDocument = ({
  html = "<html><body><div>hello</div></body></html>",
  tags = [],
  fonts = "loaded",
  animations = 0,
  images = [],
  shadow = false,
  rules = ["div { color: red; }"],
  crossOrigin = false,
  inputs = [],
} = {}) => ({
  querySelector: (sel) => (sel.split(",").some((t) => tags.includes(t.trim())) ? {} : null),
  fonts: { status: fonts },
  getAnimations: () => Array.from({ length: animations }, () => ({})),
  images,
  documentElement: { outerHTML: html },
  querySelectorAll: (sel) => (sel === "*" ? [{ shadowRoot: shadow ? {} : null }] : sel.startsWith("input") ? inputs.map((value) => ({ value })) : []),
  styleSheets: [
    crossOrigin
      ? {
          get cssRules() {
            throw new Error("SecurityError");
          },
        }
      : { cssRules: rules.map((cssText) => ({ cssText })) },
  ],
  adoptedStyleSheets: [],
});

const stateOf = async (opts, view = {}) => {
  Object.assign(globalThis, { scrollX: 0, scrollY: 0, innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, ...view });
  globalThis.document = fakeDocument(opts);
  return pageState();
};

test("same DOM, CSS and viewport give the same hash", async () => {
  const a = await stateOf({});
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await stateOf({}), a);
});

test("any change in HTML, CSS, form values or viewport changes the hash", async () => {
  const base = await stateOf({});
  assert.notEqual(await stateOf({ html: "<html><body><div>hellO</div></body></html>" }), base);
  assert.notEqual(await stateOf({ rules: ["div { color: blue; }"] }), base);
  assert.notEqual(await stateOf({ inputs: ["x"] }), base);
  assert.notEqual(await stateOf({}, { scrollY: 1 }), base);
  assert.notEqual(await stateOf({}, { innerWidth: 1080 }), base);
});

test("frames with canvas, video, iframe, object, embed or SVG image are never reused", async () => {
  for (const tag of ["canvas", "video", "iframe", "object", "embed", "image"]) {
    assert.equal(await stateOf({ tags: [tag] }), null, tag);
  }
});

test("frames still loading or animating are never reused", async () => {
  assert.equal(await stateOf({ fonts: "loading" }), null, "fonts loading");
  assert.equal(await stateOf({ animations: 1 }), null, "CSS animation running");
  assert.equal(await stateOf({ images: [{ complete: false, naturalWidth: 0 }] }), null, "image loading");
  assert.equal(await stateOf({ images: [{ complete: true, naturalWidth: 0 }] }), null, "broken image");
  assert.notEqual(await stateOf({ images: [{ complete: true, naturalWidth: 10 }] }), null, "loaded image is fine");
});

test("shadow DOM and cross-origin stylesheets are never reused", async () => {
  assert.equal(await stateOf({ shadow: true }), null);
  assert.equal(await stateOf({ crossOrigin: true }), null);
});

test("the patch is pinned to the tested Remotion version", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(TESTED.includes(pkg.peerDependencies["@remotion/renderer"]), "peer version must be in TESTED");
});
