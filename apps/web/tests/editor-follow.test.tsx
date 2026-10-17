import assert from "node:assert/strict";
import { test } from "node:test";
import { selectEditorFollowTarget } from "../src/lib/editor-follow";

test("editor scroll chooses the claim at the reading line over its enclosing experience", () => {
  assert.deepEqual(selectEditorFollowTarget({ top: 100, height: 400 }, [
    { anchor: "experience:work", top: 0, bottom: 1100, depth: 1 },
    { anchor: "claim:first", fallbackAnchors: ["experience:work"], top: 150, bottom: 270, depth: 2 },
    { anchor: "claim:second", top: 300, bottom: 480, depth: 2 },
  ]), { anchor: "claim:first", fallbackAnchors: ["experience:work"], progress: 0, source: "scroll" });
});

test("editor scroll tracks a tall block even after focus remains on a previous field", () => {
  const target = selectEditorFollowTarget({ top: 300, height: 400 }, [
    { anchor: "claim:previous", top: -100, bottom: 100, depth: 2 },
    { anchor: "claim:long", top: 200, bottom: 1000, depth: 2 },
  ]);
  assert.equal(target?.anchor, "claim:long");
  assert.equal(target?.progress, 0.25);
});

test("gaps pick the nearest visible anchor and ignore collapsed or outside blocks", () => {
  const target = selectEditorFollowTarget({ top: 100, height: 400 }, [
    { anchor: "profile:email", top: 120, bottom: 150, depth: 2 },
    { anchor: "profile:phone", top: 220, bottom: 260, depth: 2 },
    { anchor: "collapsed", top: 200, bottom: 200, depth: 4 },
    { anchor: "outside", top: 800, bottom: 1000, depth: 4 },
  ]);
  assert.equal(target?.anchor, "profile:phone");
});

test("hidden editors and empty visible content produce no follow target", () => {
  assert.equal(selectEditorFollowTarget({ top: 0, height: 0 }, [{ anchor: "profile", top: 0, bottom: 500, depth: 1 }]), undefined);
  assert.equal(selectEditorFollowTarget({ top: 0, height: 300 }, [{ anchor: "offscreen", top: 400, bottom: 500, depth: 1 }]), undefined);
});
