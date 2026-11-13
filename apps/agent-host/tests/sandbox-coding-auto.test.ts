import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodingAutoRuns } from "../src/sandbox/coding-auto.js";
import { CodingTaskService, type CodingTaskLease, type CreateCodingTask } from "../src/sandbox/coding-tasks.js";

const grant: CodingTaskLease = () => true;
const digest = "a".repeat(64);
const spec = (maxAttempts = 3): CreateCodingTask => ({
  goal: "Double synthetic numbers.", model: "fixture:small", consent: true, maxAttempts,
  cases: [{ id: "zero", input: 0, expected: 0 }, { id: "two", input: 2, expected: 4 }],
});
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
type Dependencies = Partial<Pick<ConstructorParameters<typeof CodingTaskService>[0], "generate" | "resolveModel" | "verify">>;
async function fixture(t: TestContext, deps: Dependencies) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-coding-auto-synthetic-"));
  const tasks = new CodingTaskService({ directory, ownerId: "owner-A", resolveModel: async () => digest, ...deps });
  const auto = new CodingAutoRuns(tasks);
  t.after(async () => { await auto.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { tasks, auto, directory };
}

test("one explicit auto grant permits two checked attempts without further UI calls and releases exactly once at review", async t => {
  const first = barrier(), produce = barrier<string>(), settled = barrier();
  let calls = 0, released = 0;
  const { tasks, auto } = await fixture(t, { generate: async () => {
    if (++calls === 1) { first.resolve(); return produce.promise; } return "x => x * 2";
  } });
  const created = await tasks.create(spec(), grant);
  const accepted = await auto.start(created.id, created.revision, grant, () => { released++; settled.resolve(); });
  assert.equal(auto.view(accepted).autoRunning, true);
  await first.promise;
  for (let i = 0; i < 4; i++) assert.equal(auto.view(await tasks.get(created.id, grant)).autoRunning, true);
  assert.equal(calls, 1);
  produce.resolve("x => 0");
  await settled.promise;
  const done = auto.view(await tasks.get(created.id, grant));
  assert.equal(done.status, "review_ready"); assert.equal(done.autoRunning, false);
  assert.equal(done.autoStopReason, "coding_review_ready");
  assert.deepEqual(done.history.map(h => h.passedIds), [["zero"], ["zero", "two"]]);
  assert.equal(calls, 2); assert.equal(released, 1);
});

test("a valid pause in the gap between attempts cancels the next preflight without spending another inference", async t => {
  let calls = 0, hasReport = false, releases = 0;
  const gap = barrier(), delayed = barrier<string>(), stopped = barrier();
  const { tasks, auto } = await fixture(t, {
    resolveModel: async () => { if (!hasReport) return digest; gap.resolve(); return delayed.promise; },
    generate: async () => { calls++; return "x => 0"; },
    verify: async () => { hasReport = true; return [{ id: "zero", passed: true }, { id: "two", passed: false }]; },
  });
  const initial = await tasks.create(spec(), grant);
  await auto.start(initial.id, initial.revision, grant, () => { releases++; stopped.resolve(); });
  await gap.promise;
  const observed = await tasks.get(initial.id, grant);
  assert.equal(observed.status, "ready"); assert.equal(observed.attemptsUsed, 1);
  const paused = await auto.pause(initial.id, observed.revision, grant);
  delayed.resolve(digest); await stopped.promise;
  assert.equal(paused.status, "paused"); assert.equal(releases, 1);
  assert.equal(auto.view(paused).autoStopReason, "coding_manually_paused");
  assert.equal(calls, 1); assert.equal((await tasks.get(initial.id, grant)).attemptsUsed, 1);
});

test("racing starts reserve one owner runner; rejected or stale commands do not own the caller's lease", async t => {
  const entered = barrier(), finish = barrier<string>(), settled = barrier();
  let calls = 0, releases = 0, rejectsOwned = 0;
  const { tasks, auto } = await fixture(t, { generate: async () => { calls++; entered.resolve(); return finish.promise; } });
  const one = await tasks.create(spec(), grant), two = await tasks.create(spec(), grant);
  await assert.rejects(auto.start(one.id, one.revision + 1, grant, () => { rejectsOwned++; }), /revision_conflict/);
  await assert.rejects(auto.start(one.id, one.revision, () => false, () => { rejectsOwned++; }), /lease_invalid/);
  const release = () => { releases++; settled.resolve(); };
  const accepted = await Promise.allSettled([auto.start(one.id, one.revision, grant, release), auto.start(one.id, one.revision, grant, release)]);
  assert.equal(accepted.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(accepted.filter(r => r.status === "rejected").length, 1);
  await entered.promise;
  await assert.rejects(auto.start(two.id, two.revision, grant, () => { rejectsOwned++; }), /owner_busy/);
  await assert.rejects(auto.pause(one.id, one.revision, grant), /revision_conflict/);
  const during = await tasks.get(one.id, grant);
  await assert.rejects(auto.pause(one.id, during.revision, () => false), /lease_invalid/);
  assert.equal(auto.view(during).autoRunning, true); assert.equal(calls, 1);
  finish.resolve("x => x * 2"); await settled.promise;
  const reviewed = await tasks.get(one.id, grant);
  await assert.rejects(auto.start(one.id, reviewed.revision, grant, () => { rejectsOwned++; }), /not_runnable/);
  assert.equal(releases, 1); assert.equal(rejectsOwned, 0); assert.equal(auto.busy(one.id), false);
});

test("a known regression can consume the original budget, but reaching it never schedules a third attempt", async t => {
  let calls = 0;
  const { tasks, auto } = await fixture(t, { generate: async () => ++calls === 1 ? "x => 0" : "x => 4" });
  const initial = await tasks.create(spec(2), grant), finished = barrier();
  await auto.start(initial.id, initial.revision, grant, finished.resolve); await finished.promise;
  const state = auto.view(await tasks.get(initial.id, grant));
  assert.equal(state.status, "budget_exhausted"); assert.equal(state.autoStopReason, "coding_budget_exhausted");
  assert.equal(state.best?.source, "x => 0");
  assert.deepEqual(state.history.map(h => h.outcome), ["accepted", "regression"]);
  let rejectedReleased = false;
  await assert.rejects(auto.start(initial.id, state.revision, grant, () => { rejectedReleased = true; }), /budget_exhausted/);
  assert.equal(calls, 2); assert.equal(rejectedReleased, false);
});

test("a lost or unsafe provider response stops the chain; opening or observing it never guesses a retry", async t => {
  let calls = 0;
  const { tasks, auto } = await fixture(t, { generate: async () => { calls++; throw Error("PRIVATE_RAW_PROVIDER_REPLY"); } });
  const task = await tasks.create(spec(), grant), released = barrier();
  await auto.start(task.id, task.revision, grant, released.resolve); await released.promise;
  for (let i = 0; i < 3; i++) {
    const view = auto.view(await tasks.get(task.id, grant));
    assert.equal(view.autoStopReason, "coding_generation_failed"); assert.equal(view.autoRunning, false);
    assert.equal(view.attemptsUsed, 1); assert.equal(view.best, undefined);
    assert.ok(!JSON.stringify(view).includes("PRIVATE_RAW_PROVIDER_REPLY"));
  }
  assert.equal(calls, 1);
});

test("revocation while generating discards a late candidate, prevents the next step and releases once", async t => {
  let calls = 0, releases = 0, wasAborted = false;
  const entered = barrier(), late = barrier<string>(), finished = barrier(), token = new AbortController();
  const { tasks, auto } = await fixture(t, { generate: async (_r, signal) => {
    calls++; signal.addEventListener("abort", () => { wasAborted = true; }); entered.resolve(); return late.promise;
  } });
  const task = await tasks.create(spec(), grant);
  await auto.start(task.id, task.revision, Object.assign(() => true, { signal: token.signal }), () => { releases++; finished.resolve(); });
  await entered.promise; token.abort(); await finished.promise;
  const stopped = auto.view(await tasks.get(task.id, grant));
  assert.equal(stopped.status, "paused"); assert.equal(stopped.autoStopReason, "coding_lease_invalid");
  assert.equal(stopped.autoRunning, false); assert.equal(stopped.best, undefined); assert.equal(stopped.attemptsUsed, 1);
  late.resolve("x => x * 2"); assert.equal(wasAborted, true); assert.equal(calls, 1); assert.equal(releases, 1);
});

test("Host shutdown drops the scheduling grant; a fresh Host can read the durable attempt but cannot resume it by observation", async t => {
  let calls = 0, releases = 0;
  const entered = barrier(), late = barrier<string>();
  const { tasks, auto, directory } = await fixture(t, { generate: async () => { calls++; entered.resolve(); return late.promise; } });
  const task = await tasks.create(spec(), grant);
  await auto.start(task.id, task.revision, grant, () => { releases++; }); await entered.promise;
  await auto.close(); await tasks.close(); late.resolve("x => x * 2");
  assert.equal(releases, 1); await assert.rejects(auto.start(task.id, task.revision, grant, () => {}), /service_closed/);
  const reopened = new CodingTaskService({ directory, ownerId: "owner-A", resolveModel: async () => digest,
    generate: async () => { calls++; return "x => x * 2"; } }), fresh = new CodingAutoRuns(reopened);
  try {
    const seen = fresh.view(await reopened.get(task.id, grant));
    assert.equal(seen.autoRunning, false); assert.equal(seen.autoStopReason, undefined); assert.equal(seen.attemptsUsed, 1);
    assert.equal(seen.history[0]?.outcome, "interrupted"); assert.equal(calls, 1);
    const finished = barrier(); await fresh.start(seen.id, seen.revision, grant, finished.resolve); await finished.promise;
    assert.equal((await reopened.get(task.id, grant)).status, "review_ready"); assert.equal(calls, 2);
  } finally { await fresh.close(); await reopened.close(); }
});

test("pausing an active attempt persists the human stop and a late reply has no authority over a separately granted restart", async t => {
  const first = barrier(), late = barrier<string>(), released = barrier();
  let calls = 0;
  const { tasks, auto } = await fixture(t, { generate: async () => {
    if (++calls !== 1) return "x => x * 2"; first.resolve(); return late.promise;
  } });
  const task = await tasks.create(spec(), grant);
  await auto.start(task.id, task.revision, grant, released.resolve); await first.promise;
  const running = await tasks.get(task.id, grant);
  const paused = await auto.pause(task.id, running.revision, grant); await released.promise;
  assert.equal(paused.status, "paused"); assert.equal(paused.lastAttempt?.error, "coding_manually_paused");
  assert.equal(auto.busy(task.id), false);
  const complete = barrier(); await auto.start(task.id, paused.revision, grant, complete.resolve);
  await complete.promise; late.resolve("x => 0");
  const reviewed = await tasks.get(task.id, grant);
  assert.equal(reviewed.status, "review_ready"); assert.equal(reviewed.best?.source, "x => x * 2");
  assert.deepEqual(reviewed.history.map(r => r.outcome), ["interrupted", "accepted"]); assert.equal(calls, 2);
});

test("a changed local model between attempts pauses the schedule before any next inference is charged", async t => {
  let reviewedOnce = false, calls = 0;
  const { tasks, auto } = await fixture(t, { resolveModel: async () => reviewedOnce ? "b".repeat(64) : digest,
    generate: async () => { calls++; return "x => 0"; },
    verify: async () => { reviewedOnce = true; return [{ id: "zero", passed: true }, { id: "two", passed: false }]; } });
  const task = await tasks.create(spec(), grant), finished = barrier();
  await auto.start(task.id, task.revision, grant, finished.resolve); await finished.promise;
  const seen = auto.view(await tasks.get(task.id, grant));
  assert.equal(seen.autoRunning, false); assert.equal(seen.autoStopReason, "coding_model_digest_changed");
  assert.equal(seen.attemptsUsed, 1); assert.equal(calls, 1); assert.equal(seen.best?.source, "x => 0");
});
