import assert from "node:assert/strict";
import test from "node:test";
import {
  allocatePaneSizes, defaultWorkbenchLayout, moveWorkbenchPane, parseWorkbenchLayout,
  resizePanePair, weightsFromSizes, WORKBENCH_LAYOUT_KEY,
} from "../src/components/atlas/workbench-layout";

test("layout preferences accept only the versioned UI schema and never carry job or resume state", () => {
  const defaults = defaultWorkbenchLayout();
  assert.match(WORKBENCH_LAYOUT_KEY, /^better-me:atlas-workbench:/);
  assert.deepEqual(parseWorkbenchLayout(null), defaults);
  for (const value of ["oops", "null", "[]", '{"version":2}', '{"version":1,"order":["map","map","detail"]}']) {
    assert.deepEqual(parseWorkbenchLayout(value), defaults);
  }
  const restored = parseWorkbenchLayout(JSON.stringify({ ...defaults, order: ["detail", "map", "jobs"], height: 99999,
    weights: { map: 0, jobs: NaN, detail: 1 }, rowHeights: { map: 5, jobs: 900, detail: 99999 }, resume: "private" }));
  assert.deepEqual(restored.order, ["detail", "map", "jobs"]);
  assert.equal(restored.height, 1400);
  assert.deepEqual(restored.weights, defaults.weights);
  assert.deepEqual(restored.rowHeights, { map: 500, jobs: 900, detail: 1400 });
  assert.equal("resume" in restored, false);
  assert.notEqual(defaultWorkbenchLayout().order, defaultWorkbenchLayout().order);
});

test("pane allocation preserves usable minimums, finite widths and all available space", () => {
  for (const width of [980, 1200, 1500, 2400]) {
    for (const weights of [{map:44,jobs:26,detail:30},{map:64,jobs:18,detail:18},{map:24,jobs:20,detail:56}]) {
      const sizes = allocatePaneSizes(["map","jobs","detail"], weights, width);
      assert.ok(sizes[0]! >= 300 && sizes[1]! >= 280 && sizes[2]! >= 320);
      assert.ok(Math.abs(sizes.reduce((a,b)=>a+b,0) + 28 - width) < 0.01);
    }
  }
  const two = allocatePaneSizes(["map","jobs"], defaultWorkbenchLayout().weights, 1000);
  assert.ok(Math.abs(two[0]! + two[1]! - 986) < 0.01);
});

test("pair resize clamps only its neighbours and cannot consume another pane", () => {
  const sizes = [450, 350, 400];
  assert.deepEqual(resizePanePair(sizes, ["map","jobs","detail"], 0, 10000), [520,280,400]);
  assert.deepEqual(resizePanePair(sizes, ["map","jobs","detail"], 1, -10000), [450,280,470]);
  assert.deepEqual(sizes, [450,350,400]);
  const previous = {map:44,jobs:26,detail:30};
  const next = weightsFromSizes(["map","jobs"], [600,400], previous);
  assert.equal(next.detail, 30);
  assert.equal(next.map, 42);
  assert.equal(next.jobs, 28);
});

test("reordering preserves stable identities and hidden detail preference", () => {
  assert.deepEqual(moveWorkbenchPane(["map","jobs","detail"],"map","detail"), ["jobs","detail","map"]);
  assert.deepEqual(moveWorkbenchPane(["map","jobs","detail"],"detail","map"), ["detail","map","jobs"]);
  assert.deepEqual(moveWorkbenchPane(["map","jobs","detail"],"jobs","jobs"), ["map","jobs","detail"]);
});
