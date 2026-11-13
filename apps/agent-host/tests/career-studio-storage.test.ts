import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StudioArtifactStore } from "../src/career-studio/storage.js";

async function setup(t: test.TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-kind-guard-"))), a = new StudioArtifactStore("synthetic-owner", directory), b = new StudioArtifactStore("synthetic-owner", directory);
  t.after(async () => { a.close(); b.close(); await fs.rm(directory, { recursive: true, force: true }); }); return { a, b };
}
test("publication kind guard rejects a capsule write after another SQLite connection advances the source revision", async t => {
  const { a, b } = await setup(t); a.put("publication-review", "review-1", 0, { statement: "冻结的本人自述" });
  const expected = a.kindRevision("publication-review"); assert.equal(expected, 1);
  b.put("publication-review", "review-2", 0, { statement: "另一个已审阅来源版本" });
  assert.throws(() => a.put("candidate-capsule", "capsule-stale", 0, { frozenStatement: "冻结的本人自述" }, [{ kind: "publication-review", revision: expected }]), /studio_guard_revision_conflict/);
  assert.equal(a.get("candidate-capsule", "capsule-stale"), undefined); assert.equal(b.get("candidate-capsule", "capsule-stale"), undefined);
  const fresh = a.put("candidate-capsule", "capsule-fresh", 0, { frozenStatement: "冻结的本人自述", sourceRevision: 2 }, [{ kind: "publication-review", revision: 2 }]);
  assert.equal(fresh.revision, 1); assert.deepEqual(b.get("candidate-capsule", "capsule-fresh")?.value, { frozenStatement: "冻结的本人自述", sourceRevision: 2 });
  b.put("publication-review", "review-1", 1, { statement: "来源审阅修订" });
  assert.throws(() => a.put("candidate-capsule", "capsule-fresh", 1, { changed: true }, [{ kind: "publication-review", revision: 2 }]), /studio_guard_revision_conflict/);
  assert.equal(b.get("candidate-capsule", "capsule-fresh")?.revision, 1, "failed guard rolls back the target update as well");
});
test("kind revision includes more than the display listing limit and increments on edits as well as inserts", async t => {
  const { a, b } = await setup(t);
  for (let index = 0; index < 1001; index++) a.put("publication-review", `review-${index}`, 0, { syntheticIndex: index });
  assert.equal(a.list("publication-review", 1000).length, 1000); assert.equal(b.kindRevision("publication-review"), 1001);
  b.put("publication-review", "review-0", 1, { syntheticIndex: 0, reviewed: true }); assert.equal(a.kindRevision("publication-review"), 1002);
  assert.throws(() => a.put("candidate-capsule", "truncated-revision", 0, {}, [{ kind: "publication-review", revision: 1000 }]), /studio_guard_revision_conflict/);
  assert.equal(a.get("candidate-capsule", "truncated-revision"), undefined);
  assert.throws(() => a.put("candidate-capsule", "bad-guard", 0, {}, [{ kind: "publication-review", revision: -1 }]), /invalid_studio_write_guard/);
});
