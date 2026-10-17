import test from "node:test";
import assert from "node:assert/strict";
import { clampWorkspaceSplit, getWorkspaceSplitBounds, parseWorkspaceSplit, workspaceSplitFromPointer } from "../src/lib/workspace-split";

test("drag coordinates account for container offset and handle width", () => {
  assert.equal(workspaceSplitFromPointer(510, 100, 1000), 40);
  assert.ok(Math.abs(workspaceSplitFromPointer(1010, 100, 1000) - 66) < 0.00001);
  assert.equal(workspaceSplitFromPointer(-200, 100, 1000), 30);
});

test("desktop bounds preserve usable panes and re-clamp when available width shrinks", () => {
  const narrow = getWorkspaceSplitBounds(760);
  assert.ok(narrow.min * 760 / 100 >= 299.99);
  assert.ok((100 - narrow.max) * 760 / 100 >= 339.99);
  assert.equal(clampWorkspaceSplit(65, 1200), 65);
  assert.equal(clampWorkspaceSplit(65, 760), narrow.max);
  assert.equal(clampWorkspaceSplit(Number.NaN, 1200), 38);
});

test("damaged or out-of-range layout preferences use the default", () => {
  for (const saved of [null, "", " ", "null", "NaN", "Infinity", "0", "-10", "99", '{"key":"x"}']) assert.equal(parseWorkspaceSplit(saved), 38);
  assert.equal(parseWorkspaceSplit("45.5"), 45.5);
});
