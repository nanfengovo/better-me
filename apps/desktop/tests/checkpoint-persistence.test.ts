import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckpointer } from "../../agent-host/src/checkpointer.js";

test("Node-API SQLite preserves LangGraph checkpoints and pending writes across reopen", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "betterme-checkpoint-")), "checkpoints.sqlite");
  const saver = createCheckpointer(file);
  assert.ok(saver.db, "A memory fallback is not persistent storage.");
  const config = { configurable: { thread_id: "synthetic-release-test", checkpoint_ns: "" } };
  const saved = await saver.put(config, {
    v: 4, id: "checkpoint-001", ts: new Date().toISOString(), channel_values: { count: 7 },
    channel_versions: { count: 1 }, versions_seen: {},
  }, { source: "input", step: 0, parents: {} }, { count: 1 });
  await saver.putWrites(saved, [["result", "verified"]], "task-001");
  saver.db.exec("CREATE TABLE rollback_probe (value INTEGER)");
  assert.throws(() => saver.db.transaction(() => {
    saver.db.prepare("INSERT INTO rollback_probe VALUES (?)").run(1);
    throw new Error("synthetic rollback");
  })(), /synthetic rollback/);
  assert.equal((saver.db.prepare("SELECT count(*) AS total FROM rollback_probe").get() as { total: number }).total, 0);
  saver.db.close();
  const reopened = createCheckpointer(file);
  assert.ok(reopened.db);
  try {
    const tuple = await reopened.getTuple(saved);
    assert.equal(tuple?.checkpoint.channel_values.count, 7);
    assert.deepEqual(tuple?.pendingWrites, [["task-001", "result", "verified"]]);
    const entries = [];
    for await (const entry of reopened.list(config)) entries.push(entry);
    assert.equal(entries.length, 1);
    await reopened.deleteThread("synthetic-release-test");
    assert.equal(await reopened.getTuple(saved), undefined);
  } finally { reopened.db.close(); }
});
