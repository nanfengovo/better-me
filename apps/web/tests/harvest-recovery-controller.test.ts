import assert from "node:assert/strict";
import test from "node:test";
import type { HarvestCheckpoint, HarvestJournal, HarvestRunInput, HarvestRunState } from "../src/components/atlas/harvest-checkpoint.ts";
import { HarvestRecoveryController } from "../src/components/atlas/harvest-recovery-controller.ts";

const input: HarvestRunInput = { keyword: "合成工程师", depth: "quick", view: { mode: "domestic", country: "CN", region: "", regionText: "" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(state: HarvestRunState = "running") {
  let closed = 0, created = 0, acquired = 0, released = 0;
  const states: HarvestRunState[] = [];
  const run = { schemaVersion: 1 as const, id: "synthetic-run", scope: "synthetic-scope", input, state,
    createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" };
  const checkpoint: HarvestCheckpoint = {
    id: run.id, read: async () => ({ run, batches: [], providers: [] }), resume: async () => { run.state = "running"; }, initialize: async () => {},
    capture: async () => {}, prepare: async () => {}, confirm: async () => {}, recordProvider: async () => {},
    settle: async next => { run.state = next; states.push(next); },
  };
  const journal: HarvestJournal = {
    scope: run.scope, findResumable: async () => run.state === "running" ? checkpoint : undefined,
    findRecoverable: async () => ["running", "cancelled", "needs-attention"].includes(run.state) ? checkpoint : undefined,
    create: async () => { created++; return checkpoint; }, close: () => { closed++; },
  };
  const controller = new HarvestRecoveryController({ endpoint: "http://127.0.0.1:5178", token: "synthetic-secret" }, {
    open: async () => journal,
    acquire: async () => { acquired++; return { release: () => { released++; } }; },
  });
  return { controller, checkpoint, journal, run, states, counts: () => ({ closed, created, acquired, released }) };
}

test("a refresh resumes the existing run without creating a second journal", async () => {
  const f = fixture(); let calls = 0;
  await f.controller.resume(async (saved, checkpoint, signal) => {
    calls++; assert.deepEqual(saved, input); assert.equal(checkpoint, f.checkpoint); assert.equal(signal.aborted, false);
  });
  assert.equal(calls, 1);
  assert.deepEqual(f.counts(), { closed: 0, created: 0, acquired: 1, released: 1 });
  await f.controller.dispose();
  assert.equal(f.counts().closed, 1);
});

test("unmount aborts capture, drains ownership, and leaves a recoverable run", async () => {
  const f = fixture(); const started = deferred<AbortSignal>(); const drain = deferred<void>();
  const running = f.controller.resume(async (_input, _checkpoint, signal) => { started.resolve(signal); await drain.promise; });
  const signal = await started.promise;
  const disposed = f.controller.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(f.counts().released, 0, "the cross-tab lock is held until the writer drains");
  assert.equal(f.counts().closed, 0, "in-flight confirmations may still need the journal");
  drain.resolve(); await running; await disposed;
  assert.equal(f.run.state, "running"); assert.deepEqual(f.states, []);
  assert.deepEqual(f.counts(), { closed: 1, created: 0, acquired: 1, released: 1 });
});

test("explicit cancellation persists a terminal state and will not auto-resume", async () => {
  const f = fixture(); const started = deferred<AbortSignal>(); const drain = deferred<void>();
  const running = f.controller.start(input, async (_checkpoint, signal) => { started.resolve(signal); await drain.promise; });
  const signal = await started.promise;
  await f.controller.cancel();
  assert.equal(signal.aborted, true); assert.equal(f.run.state, "cancelled");
  drain.resolve(); await running;
  let resumed = false;
  await f.controller.resume(async () => { resumed = true; });
  assert.equal(resumed, false); assert.deepEqual(f.states, ["cancelled"]);
  await f.controller.dispose();
});

test("an execution failure becomes needs-attention rather than an infinite auto-resume loop", async () => {
  const f = fixture();
  await assert.rejects(f.controller.start(input, async () => { throw new Error("synthetic failure"); }), /synthetic failure/);
  assert.equal(f.run.state, "needs-attention");
  let resumed = false; await f.controller.resume(async () => { resumed = true; }); assert.equal(resumed, false);
  assert.equal(f.counts().released, 2); await f.controller.dispose();
});

test("a lock owned by another tab does not create, resume or cancel its task", async () => {
  const f = fixture(); let ran = false;
  const controller = new HarvestRecoveryController({ endpoint: "http://127.0.0.1:5178", token: "synthetic-secret" }, {
    open: async () => f.journal, acquire: async () => undefined,
  });
  await controller.resume(async () => { ran = true; });
  await assert.rejects(controller.start(input, async () => { ran = true; }), /另一个标签页/);
  assert.equal(ran, false); assert.equal(f.counts().created, 0); assert.deepEqual(f.states, []);
  await controller.dispose();
});

test("an explicit continuation reuses the original stopped run without automatically restarting it", async () => {
  const f = fixture("cancelled"); let executions = 0;
  await f.controller.resume(async () => { executions++; });
  assert.equal(executions, 0);
  await f.controller.continue(async (saved, checkpoint) => {
    executions++; assert.deepEqual(saved, input); assert.equal(checkpoint.id, f.checkpoint.id);
    assert.equal(f.run.state, "running"); await checkpoint.settle("completed");
  });
  assert.equal(executions, 1); assert.equal(f.counts().created, 0);
  await f.controller.continue(async () => { executions++; });
  assert.equal(executions, 1, "completed work cannot be reopened");
  await f.controller.dispose();
});

test("disposing during database open closes the late handle without running a request", async () => {
  const f = fixture(); const opened = deferred<HarvestJournal>(); let ran = false;
  const controller = new HarvestRecoveryController({ endpoint: "http://127.0.0.1:5178", token: "synthetic-secret" }, {
    open: () => opened.promise, acquire: async () => ({ release() {} }),
  });
  const resumed = controller.resume(async () => { ran = true; });
  const disposed = controller.dispose(); opened.resolve(f.journal); await resumed; await disposed;
  assert.equal(ran, false); assert.equal(f.counts().closed, 1);
});
