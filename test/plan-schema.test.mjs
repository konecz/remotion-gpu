import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_SCHEMA, validatePlan, validateSchema } from "../src/layers/validate-plan.mjs";
import { presenterTake } from "./helpers/presenter.mjs";

const rect = [0, 0, 1920, 1080];
const valid = () => ({
  width: 1920,
  height: 1080,
  fps: 30,
  frames: 120,
  background: "#f4f2ee",
  takes: [
    { file: "footage/a.mp4", start: 0, frames: 60, from: 1.5, box: Array(60).fill(rect), video: Array(60).fill(rect) },
    { file: "footage/b.mp4", start: 60, frames: 40, box: Array(40).fill(rect), video: Array(40).fill(rect) },
  ],
  audio: [{ file: "footage/a.mp4", start: 0, frames: 60, from: 1.5, volume: 0.8, fadeOut: [55, 60] }],
});

test("a well-formed plan is valid", () => {
  assert.deepEqual(validatePlan(valid()), []);
});

test("a plan written from the presenter framing is valid", () => {
  const take = presenterTake({ card: { x: 100, y: 100, w: 700, h: 900, radius: 24 }, shrinkAt: 0.5 }, { fps: 30, width: 1920, height: 1080 }, { file: "x.mp4", start: 10, frames: 50 });
  const plan = { width: 1920, height: 1080, fps: 30, frames: 60, background: "#000000", takes: [take] };
  assert.deepEqual(validatePlan(plan), []);
});

test("schema errors: missing fields, wrong types, bad color, unknown keys", () => {
  const cases = [
    [(p) => delete p.fps, /missing fps/],
    [(p) => (p.width = "1920"), /\$\.width: expected integer/],
    [(p) => (p.background = "white"), /background: does not match/],
    [(p) => (p.extra = 1), /unknown property extra/],
    [(p) => (p.takes[0].box[3] = [0, 0, 10]), /box\[3\]: fewer than 4 items/],
    [(p) => (p.takes[0].video[0] = [0, 0, -1, 10]), /video\[0\]\[2\]: below minimum 0/],
    [(p) => (p.audio[0].fadeOut = [1, 2, 3]), /fadeOut: more than 2 items/],
    [(p) => (p.takes[1].start = -1), /start: below minimum 0/],
  ];
  for (const [mutate, pattern] of cases) {
    const p = valid();
    mutate(p);
    const errors = validatePlan(p);
    assert.ok(errors.some((e) => pattern.test(e)), `${pattern}: got ${JSON.stringify(errors)}`);
  }
});

test("timeline rules: one rect per frame, inside the timeline, no overlap, even size", () => {
  const cases = [
    [(p) => p.takes[0].box.pop(), /box has 59 entries/],
    [(p) => (p.takes[1].start = 90), /after the timeline/],
    [(p) => (p.takes[1].start = 50), /overlaps the previous take/],
    [(p) => (p.width = 1921), /must be even/],
  ];
  for (const [mutate, pattern] of cases) {
    const p = valid();
    mutate(p);
    assert.ok(validatePlan(p).some((e) => pattern.test(e)), String(pattern));
  }
});

test("the schema file is the source of truth: every rect uses the shared definition", () => {
  assert.equal(PLAN_SCHEMA.properties.takes.items.properties.box.items.$ref, "#/$defs/rect");
  assert.deepEqual(validateSchema(PLAN_SCHEMA.$defs.rect, [1, 2, 3, 4]), []);
  assert.ok(validateSchema(PLAN_SCHEMA.$defs.rect, [1, 2, 3, 4, 5]).length > 0);
});
