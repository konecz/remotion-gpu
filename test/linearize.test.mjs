import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolate, spring } from "remotion";
import { DEFAULT_TOLERANCE, evalSegments, frameExpression, linearize, maxError, toExpression } from "../src/layers/linearize.mjs";
import { framePresenter, presenterTake } from "./helpers/presenter.mjs";

// Evaluates an ffmpeg expression of the subset we generate (if, lt, + - * /, numbers, K) in JS.
const evalFfmpeg = (expr, K) => new Function("K", "iff", "lt", `return ${expr.replaceAll("if(", "iff(")};`)(K, (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0));

const curves = {
  springIn: Array.from({ length: 120 }, (_, f) => 1000 * spring({ frame: f - 20, fps: 30, config: { damping: 200 }, durationInFrames: 22 })),
  punchIn: Array.from({ length: 150 }, (_, f) => 1920 * (1 + 0.12 * (spring({ frame: f - 30, fps: 30, config: { damping: 18 } }) - spring({ frame: f - 90, fps: 30, config: { damping: 18 } })))),
  slowZoom: Array.from({ length: 900 }, (_, f) => 1920 * interpolate(f, [0, 900], [1, 1.06])),
  constant: Array.from({ length: 40 }, () => 512.25),
  single: [42],
};

test("segments stay within the tolerance on every frame", () => {
  for (const [name, values] of Object.entries(curves)) {
    const segs = linearize(values, DEFAULT_TOLERANCE);
    // Values are rounded to 3 decimals and slopes to 4 before evaluation: allow that on top of the tolerance.
    assert.ok(maxError(values, segs) <= DEFAULT_TOLERANCE + 1e-3, `${name}: error ${maxError(values, segs)}`);
    assert.equal(segs[0].from, 0);
    assert.equal(segs.at(-1).to, values.length - 1);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1, `${name}: gap between segments`);
  }
});

test("a linear ramp is one segment and a spring needs several", () => {
  assert.equal(linearize(curves.slowZoom).length, 1);
  assert.equal(linearize(curves.constant).length, 1);
  const n = linearize(curves.springIn).length;
  assert.ok(n > 3 && n < 40, `spring took ${n} segments`);
});

test("a looser tolerance never needs more segments", () => {
  for (const values of Object.values(curves)) {
    assert.ok(linearize(values, 0.5).length <= linearize(values, 0.05).length);
    assert.ok(linearize(values, 0.05).length <= linearize(values, 0.005).length);
  }
});

test("the ffmpeg expression evaluates to the segmented curve", () => {
  for (const values of Object.values(curves)) {
    const segs = linearize(values);
    const expr = toExpression(segs);
    for (let k = 0; k < values.length; k++) {
      assert.ok(Math.abs(evalFfmpeg(expr, k) - evalSegments(segs, k)) < 1e-9);
      assert.ok(Math.abs(evalFfmpeg(expr, k) - values[k]) <= DEFAULT_TOLERANCE + 1e-3);
    }
  }
  assert.match(frameExpression(curves.springIn, 30).expr, /floor\(ot\*30\+0\.5\)/);
});

test("presenter framing sampled into a plan take linearizes within the tolerance", () => {
  const props = { card: { x: 1000, y: 100, w: 800, h: 860, radius: 28 }, shrinkAt: 1, emphases: [{ from: 0.2, to: 0.8 }], focus: { x: 1060, y: 560 } };
  const config = { fps: 30, width: 1920, height: 1080 };
  const take = presenterTake(props, config, { file: "take.mp4", start: 0, frames: 90 });
  assert.equal(take.box.length, 90);
  assert.equal(take.video.length, 90);
  // Same function as the component: frame 45 of the take equals framePresenter at 45.
  const q = framePresenter(props, 45, { ...config, durationInFrames: 90 });
  assert.deepEqual(take.box[45], [q.box.x, q.box.y, q.box.w, q.box.h]);
  for (let i = 0; i < 4; i++) {
    const values = take.video.map((r) => r[i]);
    assert.ok(maxError(values, linearize(values)) <= DEFAULT_TOLERANCE + 1e-3);
  }
  // The card is reached and the take covers it (cover: never smaller than the box).
  const last = take.box.at(-1);
  assert.deepEqual(last.map(Math.round), [1000, 100, 800, 860]);
  assert.ok(take.video.at(-1)[2] >= last[2] && take.video.at(-1)[3] >= last[3]);
});
