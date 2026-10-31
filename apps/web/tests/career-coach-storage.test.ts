import assert from "node:assert/strict";
import test from "node:test";
import { createCoachState } from "../src/lib/career-coach/state";
import { CoachStorageConflict, createMemoryCoachRepository, IndexedDbCoachRepository, type CoachRepository } from "../src/lib/career-coach/storage";
import type { CoachState } from "../src/lib/career-coach/types";

const AT = "2026-10-29T08:00:00.000Z";
function saved(key = "workspace-a", revision = 1): CoachState { return { ...createCoachState(key, AT), revision }; }

// A deliberately small transaction fixture at the browser IO seam. It stages
// writes until completion and rolls back aborts; it never opens a real database.
function indexedDbFixture() {
  const entries = new Map<string, unknown>();
  const behavior = { failWrites: false, opens: 0 };
  const db = {
    onversionchange: undefined as (() => void) | undefined,
    close() {},
    transaction(_name: string, mode: string) {
      let aborted = false;
      const staged = new Map(entries);
      const transaction = {
        oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
        abort() { if (aborted) return; aborted = true; queueMicrotask(() => transaction.onabort?.()); },
        objectStore() {
          return {
            get(key: string) {
              const request = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined };
              queueMicrotask(() => {
                request.result = structuredClone(entries.get(key)); request.onsuccess?.();
                queueMicrotask(() => {
                  if (aborted) return;
                  if (mode === "readwrite") { entries.clear(); for (const [key, value] of staged) entries.set(key, value); }
                  transaction.oncomplete?.();
                });
              });
              return request;
            },
            put(value: CoachState) { if (behavior.failWrites) { transaction.abort(); return; } staged.set(value.workspaceKey, structuredClone(value)); },
            delete(key: string) { if (behavior.failWrites) { transaction.abort(); return; } staged.delete(key); },
          };
        },
      };
      return transaction;
    },
  };
  const factory = { open() {
    behavior.opens++;
    const request = { result: db, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
      onblocked: undefined as (() => void) | undefined, onupgradeneeded: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } };
  return { entries, behavior, factory };
}
async function withIndexedDb(run: (repository: IndexedDbCoachRepository, fixture: ReturnType<typeof indexedDbFixture>) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const fixture = indexedDbFixture();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: fixture.factory });
  try { await run(new IndexedDbCoachRepository(), fixture); }
  finally { if (previous) Object.defineProperty(globalThis, "indexedDB", previous); else Reflect.deleteProperty(globalThis, "indexedDB"); }
}

for (const adapter of ["memory", "indexeddb"] as const) {
  async function withRepository(run: (repository: CoachRepository) => Promise<void>) {
    if (adapter === "memory") return run(createMemoryCoachRepository());
    return withIndexedDb(async repository => run(repository));
  }
  test(`${adapter}: roundtrip clones state and keeps workspaces isolated`, async () => withRepository(async repository => {
    const a = saved(), b = saved("workspace-b"); a.settings.goal = "甲目标"; b.settings.goal = "乙目标";
    await repository.save(a, 0); await repository.save(b, 0); a.settings.goal = "调用方未保存的修改";
    const loaded = await repository.load("workspace-a"); assert.equal(loaded?.settings.goal, "甲目标");
    loaded!.settings.goal = "读取方未保存的修改";
    assert.equal((await repository.load("workspace-a"))?.settings.goal, "甲目标");
    assert.equal((await repository.load("workspace-b"))?.settings.goal, "乙目标");
    assert.equal(await repository.load("missing"), undefined);
  }));
  test(`${adapter}: stale saves and clears fail CAS without replacing stored data`, async () => withRepository(async repository => {
    const first = saved(); await repository.save(first, 0);
    const latest = { ...first, revision: 2, settings: { ...first.settings, goal: "另一窗口最新内容" } };
    await repository.save(latest, 1);
    await assert.rejects(repository.save({ ...first, revision: 2 }, 1), CoachStorageConflict);
    await assert.rejects(repository.clear(first.workspaceKey, 1), CoachStorageConflict);
    assert.deepEqual(await repository.load(first.workspaceKey), latest);
  }));
  test(`${adapter}: a successful save advances exactly one revision`, async () => withRepository(async repository => {
    await assert.rejects(repository.save(saved("workspace-a", 5), 0), CoachStorageConflict);
    assert.equal(await repository.load("workspace-a"), undefined);
    await repository.save(saved(), 0);
    await assert.rejects(repository.save(saved("workspace-a", 1), 1), CoachStorageConflict);
    assert.equal((await repository.load("workspace-a"))?.revision, 1);
  }));
  test(`${adapter}: explicit clearing affects only the expected scope`, async () => withRepository(async repository => {
    await repository.save(saved(), 0); const other = saved("workspace-b"); await repository.save(other, 0);
    await repository.clear("workspace-a", 1);
    const empty = (await repository.load("workspace-a"))!;
    assert.equal(empty.revision, 2); assert.deepEqual(empty.records, []); assert.deepEqual(empty.submissions, []);
    assert.equal(empty.settings.goal, ""); assert.equal(empty.activePlan, undefined); assert.equal(empty.interview, undefined);
    assert.deepEqual(await repository.load("workspace-b"), other);
    await repository.save(saved("workspace-a", 3), 2); assert.equal((await repository.load("workspace-a"))?.revision, 3);
  }));
  test(`${adapter}: a pre-clear writer cannot resurrect old content after a new record is saved`, async () => withRepository(async repository => {
    const original = saved(); original.settings.goal = "已明确清除的旧私人内容";
    await repository.save(original, 0);
    const stale = (await repository.load("workspace-a"))!;
    await repository.clear("workspace-a", 1);
    const cleared = await repository.load("workspace-a") ?? createCoachState("workspace-a", AT);
    const fresh = { ...cleared, revision: cleared.revision + 1, settings: { ...cleared.settings, goal: "清除后重新开始的新内容" } };
    await repository.save(fresh, cleared.revision);
    await assert.rejects(repository.save({ ...stale, revision: stale.revision + 1 }, stale.revision), CoachStorageConflict);
    assert.deepEqual(await repository.load("workspace-a"), fresh);
  }));
}

test("IndexedDB adapter reloads the persisted revision through a fresh repository instance", async () => withIndexedDb(async (repository, fixture) => {
  const value = saved(); value.settings.goal = "重新挂载仍能恢复"; await repository.save(value, 0);
  const reopened = new IndexedDbCoachRepository();
  assert.deepEqual(await reopened.load(value.workspaceKey), value); assert.equal(fixture.behavior.opens, 2);
}));

test("corrupt and wrong-scope persisted records reject reads, overwrites, and clears without losing raw data", async () => withIndexedDb(async (repository, fixture) => {
  for (const raw of [{ schemaVersion: 99, valuable: "保留原始证据" }, saved("different-workspace")]) {
    fixture.entries.set("workspace-a", structuredClone(raw));
    await assert.rejects(repository.load("workspace-a"), /不兼容或损坏/);
    await assert.rejects(repository.save(saved(), 0), /不兼容或损坏/);
    await assert.rejects(repository.clear("workspace-a", 0), /不兼容或损坏/);
    assert.deepEqual(fixture.entries.get("workspace-a"), raw);
  }
}));

test("a failed IndexedDB transaction preserves the saved version and reports an actionable error", async () => withIndexedDb(async (repository, fixture) => {
  const first = saved(); await repository.save(first, 0); fixture.behavior.failWrites = true;
  await assert.rejects(repository.save({ ...first, revision: 2 }, 1), /未能保存.*下载备份/);
  assert.deepEqual(await repository.load(first.workspaceKey), first);
  await assert.rejects(repository.clear(first.workspaceKey, 1), /未能保存/);
  assert.deepEqual(await repository.load(first.workspaceKey), first);
}));

test("unavailable IndexedDB reports unsaved state instead of silently creating a replacement store", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "indexedDB");
  try {
    const repository = new IndexedDbCoachRepository();
    await assert.rejects(repository.load("workspace-a"), /未提供 IndexedDB.*下载备份/);
    await assert.rejects(repository.save(saved(), 0), /未提供 IndexedDB/);
  } finally { if (previous) Object.defineProperty(globalThis, "indexedDB", previous); }
});
