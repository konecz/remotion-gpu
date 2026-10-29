import assert from "node:assert/strict";
import { test } from "node:test";
import { iqr, median, medianCI, quantile, ratioCI, seeded, shuffle } from "../bench/stats.mjs";

test("quantiles interpolate like R type 7", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantile([10, 20], 0.1), 11);
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
});

test("seeded generator and shuffle are reproducible permutations", () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], seeded(42));
  const b = shuffle([1, 2, 3, 4, 5, 6], seeded(42));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6]);
  const r = seeded(7);
  for (let i = 0; i < 1000; i++) {
    const x = r();
    assert.ok(x >= 0 && x < 1);
  }
});

test("bootstrap CI of the median contains the median and is bounded by the data", () => {
  const xs = [118, 121, 115, 119, 130];
  const ci = medianCI(xs);
  assert.ok(ci[0] <= median(xs) && median(xs) <= ci[1]);
  assert.ok(ci[0] >= Math.min(...xs) && ci[1] <= Math.max(...xs));
  assert.deepEqual(medianCI(xs), ci, "same seed, same interval");
  assert.equal(medianCI([5]), null, "no interval with N = 1");
  assert.deepEqual(medianCI([7, 7, 7]), [7, 7], "no spread, no width");
});

test("bootstrap CI of a ratio of medians covers the true ratio on synthetic data", () => {
  // Path A costs ~3x path B, with noise. The 95% interval should contain 3 and exclude 1.
  const r = seeded(99);
  const noise = () => 1 + (r() - 0.5) * 0.1;
  const a = Array.from({ length: 5 }, () => 300 * noise());
  const b = Array.from({ length: 5 }, () => 100 * noise());
  const { value, ci } = ratioCI(a, b);
  assert.ok(Math.abs(value - 3) < 0.3);
  assert.ok(ci[0] <= value && value <= ci[1], `ci ${ci}`);
  assert.ok(ci[0] > 2.5 && ci[1] < 3.5, `ci ${ci}`);
  assert.equal(ratioCI([1], [2]).ci, null);
});
