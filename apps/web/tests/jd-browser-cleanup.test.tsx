import assert from "node:assert/strict";
import test from "node:test";
import { createJdBrowserCleanupTracker } from "../src/lib/jd-browser-cleanup.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test("snapshot在无状态变化时稳定，重复可信key只执行原精确清理", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const initial = tracker.getSnapshot();
  assert.deepEqual(initial, { pending: 0, retrying: false });
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(tracker.getSnapshot(), initial);
  const calls: string[] = [];
  tracker.record("request:a", async () => { calls.push("original request a"); });
  const recorded = tracker.getSnapshot();
  assert.notEqual(recorded, initial);
  tracker.record("request:a", async () => { calls.push("replacement must not run"); });
  assert.equal(tracker.getSnapshot(), recorded);
  await tracker.retry();
  assert.deepEqual(calls, ["original request a"]);
  const completed = tracker.getSnapshot();
  assert.deepEqual(completed, { pending: 0, retrying: false });
  await tracker.retry();
  assert.equal(tracker.getSnapshot(), completed);
});

test("混合成功和失败逐项确认，失败不阻止后项且保留到再次精确恢复", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const calls: string[] = [];
  let failB = true;
  tracker.record("request:a", async () => { calls.push("a"); });
  tracker.record("session:b", async () => { calls.push("b"); if (failB) throw new Error("b release unconfirmed"); });
  tracker.record("request:c", async () => { calls.push("c"); });
  await tracker.retry();
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(tracker.getSnapshot(), { pending: 1, retrying: false });
  failB = false;
  await tracker.retry();
  assert.deepEqual(calls, ["a", "b", "c", "b"]);
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
});

test("retry只处理开始时的项，晚到的新失败保留供下一次重试", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const entered = deferred(), gate = deferred();
  const calls: string[] = [];
  tracker.record("request:a", async () => { calls.push("a"); entered.resolve(); await gate.promise; });
  tracker.record("session:b", async () => { calls.push("b"); });
  const retry = tracker.retry();
  await entered.promise;
  tracker.record("request:c", async () => { calls.push("c"); });
  gate.resolve(); await retry;
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(tracker.getSnapshot(), { pending: 1, retrying: false });
  await tracker.retry();
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
});

test("精确确认后晚到的旧失败不能重新入账，也不能影响其他资源", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const lateFailure = deferred();
  let oldCleanupCalls = 0, otherCalls = 0;
  const oldOutcome = lateFailure.promise.then(() => tracker.record("request:old", async () => { oldCleanupCalls += 1; }));
  tracker.confirm("request:old");
  tracker.record("session:new", async () => { otherCalls += 1; });
  const beforeLateFailure = tracker.getSnapshot();
  lateFailure.resolve(); await oldOutcome;
  assert.equal(tracker.getSnapshot(), beforeLateFailure);
  assert.deepEqual(beforeLateFailure, { pending: 1, retrying: false });
  await tracker.retry();
  assert.equal(oldCleanupCalls, 0); assert.equal(otherCalls, 1);
});

test("并发retry返回同一promise，不重复请求且重试状态覆盖整个批次", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const entered = deferred(), gate = deferred();
  let calls = 0;
  tracker.record("request:a", async () => { calls += 1; entered.resolve(); await gate.promise; });
  const first = tracker.retry(), second = tracker.retry();
  assert.equal(second, first);
  assert.deepEqual(tracker.getSnapshot(), { pending: 1, retrying: true });
  await entered.promise;
  assert.equal(tracker.retry(), first); assert.equal(calls, 1);
  gate.resolve(); await first;
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
  assert.equal(calls, 1);
});

test("外部精确确认不会被在途重试的迟到失败撤销", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const entered = deferred(), gate = deferred();
  let calls = 0;
  tracker.record("session:a", async () => { calls += 1; entered.resolve(); await gate.promise; });
  const work = tracker.retry();
  await entered.promise;
  tracker.confirm("session:a");
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: true });
  gate.reject(new Error("old retry failed after independent exact confirmation")); await work;
  tracker.record("session:a", async () => { calls += 100; });
  await tracker.retry();
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
  assert.equal(calls, 1);
});

test("subscribe只在snapshot变化时通知，unsubscribe后异步完成不再通知", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const entered = deferred(), gate = deferred();
  const observed: unknown[] = [];
  const unsubscribe = tracker.subscribe(() => { observed.push(tracker.getSnapshot()); });
  tracker.record("request:a", async () => { entered.resolve(); await gate.promise; });
  tracker.record("request:a", async () => undefined);
  assert.deepEqual(observed, [{ pending: 1, retrying: false }]);
  const work = tracker.retry(); await entered.promise;
  assert.deepEqual(observed, [{ pending: 1, retrying: false }, { pending: 1, retrying: true }]);
  unsubscribe(); unsubscribe();
  gate.resolve(); await work;
  tracker.record("session:b", async () => undefined);
  tracker.confirm("session:b");
  assert.equal(observed.length, 2);
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
});

test("批次中已由其他精确结果确认的后项不再重复清理", async () => {
  const tracker = createJdBrowserCleanupTracker();
  const entered = deferred(), gate = deferred();
  const calls: string[] = [];
  tracker.record("request:a", async () => { calls.push("a"); entered.resolve(); await gate.promise; });
  tracker.record("session:b", async () => { calls.push("b"); });
  const work = tracker.retry(); await entered.promise;
  tracker.confirm("session:b"); gate.resolve(); await work;
  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(tracker.getSnapshot(), { pending: 0, retrying: false });
});
