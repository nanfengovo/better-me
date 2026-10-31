import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import { createCoachState } from "../src/lib/career-coach/state";
import { CoachStorageConflict, createMemoryCoachRepository, type CoachRepository } from "../src/lib/career-coach/storage";
import type { CoachState } from "../src/lib/career-coach/types";

const dom = new Window({ url: "http://career-coach-hook-fixture.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { useCareerCoach } = await import("../src/lib/career-coach/use-career-coach");
let root: ReturnType<typeof createRoot> | undefined;
let coach: ReturnType<typeof useCareerCoach>;
const cleanupResolvers: Array<() => void> = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  cleanupResolvers.push(() => resolve(fallback));
  return { promise, resolve };
}
function Probe({ workspaceKey, repository }: { workspaceKey: string; repository: CoachRepository }) {
  coach = useCareerCoach(workspaceKey, repository);
  return h("output", { "data-ready": coach.ready }, coach.persistenceError ?? coach.state.settings.goal);
}
async function render(workspaceKey: string, repository: CoachRepository) {
  if (!root) { const container = dom.document.createElement("main"); dom.document.body.append(container); root = createRoot(container as unknown as Element); }
  await act(async () => { root!.render(h(Probe, { workspaceKey, repository })); });
}
async function flushUntil(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  }
  assert.ok(predicate(), message);
}
async function clean() {
  await act(async () => { root?.unmount(); root = undefined; for (const resolve of cleanupResolvers.splice(0)) resolve(); await new Promise<void>(resolve => setImmediate(resolve)); });
  dom.document.body.replaceChildren();
}
afterEach(clean);
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
function goal(value: string) { return (state: CoachState): CoachState => ({ ...state, settings: { ...state.settings, goal: value } }); }
function stored(workspaceKey: string, value: string): CoachState { return { ...goal(value)(createCoachState(workspaceKey)), revision: 1 }; }

test("rapid consecutive edits are saved serially with the previous persisted revision", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined);
  const calls: Array<{ revision: number; expected: number; goal: string }> = [];
  let active = 0, maximum = 0;
  const repository: CoachRepository = { ...memory, async save(state, expected) {
    calls.push({ revision: state.revision, expected, goal: state.settings.goal }); active++; maximum = Math.max(maximum, active);
    if (calls.length === 1) await gate.promise;
    try { await memory.save(state, expected); } finally { active--; }
  } };
  await render("workspace-a", repository); assert.equal(coach.ready, true);
  await act(async () => { coach.update(goal("第一条")); coach.update(goal("第二条")); });
  assert.equal(coach.state.settings.goal, "第二条"); assert.equal(coach.state.revision, 2); assert.equal(calls.length, 1);
  await act(async () => gate.resolve());
  await flushUntil(() => calls.length === 2 && active === 0, "both accepted edits should persist");
  assert.deepEqual(calls, [{ revision: 1, expected: 0, goal: "第一条" }, { revision: 2, expected: 1, goal: "第二条" }]);
  assert.equal(maximum, 1); assert.equal((await memory.load("workspace-a"))?.settings.goal, "第二条");
  assert.equal(coach.persistenceError, undefined);
});

test("reload drains already accepted saves before reading instead of discarding queued edits", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined), events: string[] = [];
  let writes = 0;
  const repository: CoachRepository = {
    async load(key) { events.push(`load:${key}`); return memory.load(key); },
    async save(state, expected) { writes++; events.push(`save:${state.revision}`); if (writes === 1) await gate.promise; await memory.save(state, expected); events.push(`saved:${state.revision}`); },
    clear: memory.clear,
  };
  await render("workspace-a", repository);
  let reloaded: Promise<void> | undefined;
  await act(async () => { coach.update(goal("排队一")); coach.update(goal("排队二")); reloaded = coach.reload(); });
  assert.equal(coach.ready, false);
  assert.throws(() => coach.update(goal("加载中不接受新编辑")), /尚未就绪/);
  await act(async () => { gate.resolve(); await reloaded; });
  assert.equal(coach.ready, true); assert.equal(coach.state.settings.goal, "排队二");
  assert.equal(coach.state.revision, 2);
  assert.deepEqual(events, ["load:workspace-a", "save:1", "saved:1", "save:2", "saved:2", "load:workspace-a"]);
});

test("unmount and remount restore the saved workspace revision without a model call", async () => {
  const repository = createMemoryCoachRepository();
  await render("workspace-a", repository);
  await act(async () => { coach.update(goal("重新打开应保留")); });
  assert.equal((await repository.load("workspace-a"))?.settings.goal, "重新打开应保留");
  await act(async () => { root!.unmount(); root = undefined; });
  await render("workspace-a", repository);
  assert.equal(coach.state.settings.goal, "重新打开应保留"); assert.equal(coach.state.revision, 1); assert.equal(coach.ready, true);
});

test("a late load from an old workspace cannot replace the newly selected workspace", async () => {
  const oldLoad = deferred<CoachState | undefined>(stored("workspace-a", "甲旧内容"));
  const memory = createMemoryCoachRepository(); await memory.save(stored("workspace-b", "乙当前内容"), 0);
  const repository: CoachRepository = { ...memory, load: key => key === "workspace-a" ? oldLoad.promise : memory.load(key) };
  await render("workspace-a", repository); assert.equal(coach.ready, false);
  await render("workspace-b", repository);
  assert.equal(coach.ready, true); assert.equal(coach.state.workspaceKey, "workspace-b");
  await act(async () => oldLoad.resolve(stored("workspace-a", "迟到的甲内容")));
  assert.equal(coach.state.workspaceKey, "workspace-b"); assert.equal(coach.state.settings.goal, "乙当前内容");
  assert.equal(coach.persistenceError, undefined);
});

test("a failed old-scope save does not leak errors or disable persistence for the new scope", async () => {
  const gate = deferred<void>(undefined), memory = createMemoryCoachRepository();
  let oldStarted = false;
  const repository: CoachRepository = { ...memory, async save(state, expected) {
    if (state.workspaceKey === "workspace-a") { oldStarted = true; await gate.promise; throw new Error("甲旧保存失败"); }
    return memory.save(state, expected);
  } };
  await render("workspace-a", repository);
  await act(async () => { coach.update(goal("甲待保存")); coach.update(goal("甲最后排队的完整草稿")); });
  assert.equal(oldStarted, true);
  await render("workspace-b", repository);
  await act(async () => gate.resolve());
  await flushUntil(() => coach.ready, "new workspace should load once the old save settles");
  assert.equal(coach.state.workspaceKey, "workspace-b"); assert.equal(coach.persistenceError, undefined);
  await act(async () => coach.update(goal("乙自己的记录")));
  assert.equal((await memory.load("workspace-b"))?.settings.goal, "乙自己的记录");
  await render("workspace-a", repository);
  assert.equal(coach.state.settings.goal, "甲最后排队的完整草稿");
  assert.match(coach.persistenceError ?? "", /甲旧保存失败/);
  assert.match(coach.persistenceError ?? "", /备份/);
  assert.equal(await memory.load("workspace-a"), undefined, "returning to a failed draft must not silently write it");
  await act(async () => { await assert.rejects(coach.clear(), /确认已保存记录|重新读取/); });
  await act(async () => coach.update(goal("恢复后继续补充的甲本地草稿")));
  await render("workspace-b", repository); await render("workspace-a", repository);
  assert.equal(coach.state.settings.goal, "恢复后继续补充的甲本地草稿");
  await act(async () => coach.reload());
  assert.equal(coach.state.settings.goal, ""); assert.equal(coach.persistenceError, undefined);
});

test("a save that fails after unmount retains the complete draft for a later mount", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined);
  let calls = 0;
  const repository: CoachRepository = { ...memory, async save() { calls++; await gate.promise; throw new Error("卸载后写入失败，请下载备份"); } };
  await render("workspace-a", repository);
  await act(async () => { coach.update(goal("第一条待保存")); coach.update(goal("最后一条未保存完整草稿")); });
  await act(async () => { root!.unmount(); root = undefined; });
  await act(async () => { gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); });
  await render("workspace-a", repository);
  assert.equal(coach.state.settings.goal, "最后一条未保存完整草稿"); assert.equal(coach.state.revision, 2);
  assert.match(coach.persistenceError ?? "", /卸载后写入失败/); assert.equal(calls, 1);
  assert.equal(await memory.load("workspace-a"), undefined);
});

test("remount waits for detached pending writes and restores their failed draft before becoming ready", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined);
  const repository: CoachRepository = { ...memory, async save() { await gate.promise; throw new CoachStorageConflict(); } };
  await render("workspace-a", repository); await act(async () => coach.update(goal("重挂载仍要能导出的冲突草稿")));
  await act(async () => { root!.unmount(); root = undefined; });
  await render("workspace-a", repository);
  assert.equal(coach.ready, false, "an earlier mount still owns an unsettled write");
  await act(async () => gate.resolve());
  await flushUntil(() => coach.ready, "the remount should expose the retained failure");
  assert.equal(coach.state.settings.goal, "重挂载仍要能导出的冲突草稿"); assert.equal(coach.conflict, true);
  assert.match(coach.persistenceError ?? "", /另一窗口/);
  assert.throws(() => coach.update(goal("不能自动覆盖")), CoachStorageConflict);
  await act(async () => coach.reload());
  assert.equal(coach.state.settings.goal, ""); assert.equal(coach.conflict, false); assert.equal(coach.persistenceError, undefined);
});

test("save failure preserves current-page edits, exposes the error, and refuses unsafe clearing", async () => {
  let saves = 0, clears = 0;
  const repository: CoachRepository = { async load() { return undefined; }, async save() { saves++; throw new Error("空间不足，请下载备份"); }, async clear() { clears++; } };
  await render("workspace-a", repository);
  await act(async () => coach.update(goal("不能丢失的本页草稿")));
  assert.equal(coach.state.settings.goal, "不能丢失的本页草稿"); assert.match(coach.persistenceError ?? "", /空间不足.*备份/);
  assert.equal(coach.conflict, false); assert.match(dom.document.body.textContent ?? "", /空间不足/);
  await act(async () => coach.update(goal("继续编辑仍保留本页")));
  assert.equal(coach.state.settings.goal, "继续编辑仍保留本页"); assert.equal(saves, 1);
  await act(async () => { await assert.rejects(coach.clear(), /确认已保存记录|重新读取/); }); assert.equal(clears, 0);
});

test("failed loading permits local-only work but never overwrites or deletes unknown stored data", async () => {
  let saves = 0, clears = 0;
  const repository: CoachRepository = { async load() { throw new Error("记录损坏，原始数据未覆盖"); }, async save() { saves++; }, async clear() { clears++; } };
  await render("workspace-a", repository);
  assert.equal(coach.ready, true); assert.match(coach.persistenceError ?? "", /损坏/);
  await act(async () => coach.update(goal("仅留在当前页面")));
  assert.equal(coach.state.settings.goal, "仅留在当前页面"); assert.equal(saves, 0);
  await act(async () => { await assert.rejects(coach.clear(), /确认已保存记录|重新读取/); }); assert.equal(clears, 0);
});

test("a revision conflict retains the local draft and blocks more writes until explicit reload", async () => {
  const repository = createMemoryCoachRepository(); await repository.save(stored("workspace-a", "原始记录"), 0);
  await render("workspace-a", repository);
  const newer = { ...stored("workspace-a", "另一窗口记录"), revision: 2 }; await repository.save(newer, 1);
  await act(async () => coach.update(goal("本页冲突草稿")));
  assert.equal(coach.conflict, true); assert.equal(coach.state.settings.goal, "本页冲突草稿");
  assert.match(coach.persistenceError ?? "", /另一窗口/);
  assert.throws(() => coach.update(goal("不能继续覆盖")), CoachStorageConflict);
  await act(async () => { await assert.rejects(coach.clear(), CoachStorageConflict); });
  assert.equal((await repository.load("workspace-a"))?.settings.goal, "另一窗口记录");
  await act(async () => coach.reload());
  assert.equal(coach.state.settings.goal, "另一窗口记录"); assert.equal(coach.state.revision, 2);
  assert.equal(coach.conflict, false); assert.equal(coach.persistenceError, undefined);
});

test("clear waits for accepted saves and removes only the current scope", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined), events: string[] = [];
  await memory.save(stored("workspace-b", "乙记录应保留"), 0);
  const repository: CoachRepository = { ...memory,
    async save(state, expected) { events.push("save"); await gate.promise; await memory.save(state, expected); events.push("saved"); },
    async clear(key, expected) { events.push(`clear:${key}:${expected}`); await memory.clear(key, expected); },
  };
  await render("workspace-a", repository); await act(async () => coach.update(goal("即将明确清除")));
  let cleared: Promise<void> | undefined;
  await act(async () => { cleared = coach.clear(); }); assert.deepEqual(events, ["save"]);
  await act(async () => { gate.resolve(); await cleared; });
  assert.deepEqual(events, ["save", "saved", "clear:workspace-a:1"]);
  assert.equal((await memory.load("workspace-a"))?.revision, 2); assert.equal((await memory.load("workspace-b"))?.settings.goal, "乙记录应保留");
  assert.equal(coach.state.revision, 2); assert.equal(coach.state.settings.goal, "");
  await act(async () => coach.update(goal("清除后新内容")));
  assert.equal((await memory.load("workspace-a"))?.revision, 3);
  assert.equal(coach.state.revision, 3);
});

test("a clear finishing after a scope switch does not reset the newly active workspace", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined);
  await memory.save(stored("workspace-a", "甲记录"), 0); await memory.save(stored("workspace-b", "乙记录"), 0);
  let clearing = false;
  const repository: CoachRepository = { ...memory, async clear(key, expected) { clearing = true; await gate.promise; await memory.clear(key, expected); } };
  await render("workspace-a", repository);
  let cleared: Promise<void> | undefined;
  await act(async () => { cleared = coach.clear(); }); assert.equal(clearing, true);
  await render("workspace-b", repository);
  await act(async () => { gate.resolve(); await cleared; });
  await flushUntil(() => coach.ready, "new workspace remains ready after a stale clear settles");
  assert.equal(coach.state.workspaceKey, "workspace-b"); assert.equal(coach.state.settings.goal, "乙记录");
  assert.equal((await memory.load("workspace-b"))?.settings.goal, "乙记录");
});

test("retained drafts do not cross repository identities even when the new store fails to load the same key", async () => {
  const firstMemory = createMemoryCoachRepository();
  const first: CoachRepository = { ...firstMemory, async save() { throw new Error("甲存储失败"); } };
  const second: CoachRepository = { ...createMemoryCoachRepository(), async load() { throw new Error("乙存储读取失败"); } };
  await render("shared-key", first); await act(async () => coach.update(goal("仅属于甲存储的私人草稿")));
  await render("shared-key", second);
  assert.equal(coach.state.settings.goal, ""); assert.match(coach.persistenceError ?? "", /乙存储/);
  assert.doesNotMatch(coach.persistenceError ?? "", /甲存储/);
  await render("shared-key", first);
  assert.equal(coach.state.settings.goal, "仅属于甲存储的私人草稿"); assert.match(coach.persistenceError ?? "", /甲存储/);
});

test("a failed explicit reload does not discard the retained unsaved draft", async () => {
  const memory = createMemoryCoachRepository(); let failLoad = false;
  const repository: CoachRepository = { ...memory,
    async load(key) { if (failLoad) throw new Error("重读失败，请保留备份"); return memory.load(key); },
    async save() { throw new Error("写入失败，请下载备份"); },
  };
  await render("workspace-a", repository); await act(async () => coach.update(goal("重读失败不能丢失的草稿")));
  failLoad = true;
  await act(async () => coach.reload());
  assert.equal(coach.state.settings.goal, "重读失败不能丢失的草稿"); assert.match(coach.persistenceError ?? "", /重读失败/);
  await act(async () => { root!.unmount(); root = undefined; });
  await render("workspace-a", repository);
  assert.equal(coach.state.settings.goal, "重读失败不能丢失的草稿"); assert.match(coach.persistenceError ?? "", /备份/);
});

test("reload requested before a queued save fails first exposes that newly failed draft", async () => {
  const memory = createMemoryCoachRepository(), gate = deferred<void>(undefined);
  const repository: CoachRepository = { ...memory, async save() { await gate.promise; throw new Error("排队写入失败，请下载备份"); } };
  await render("workspace-a", repository);
  let reloaded: Promise<void> | undefined;
  await act(async () => { coach.update(goal("尚未知道保存失败的草稿")); reloaded = coach.reload(); });
  await act(async () => { gate.resolve(); await reloaded; });
  assert.equal(coach.state.settings.goal, "尚未知道保存失败的草稿");
  assert.match(coach.persistenceError ?? "", /排队写入失败/);
  await act(async () => coach.reload());
  assert.equal(coach.state.settings.goal, ""); assert.equal(coach.persistenceError, undefined);
});
