import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentPersistenceController, LocalDocumentHistory, DRAFT_STORAGE_KEY,
  PREVIOUS_DRAFT_STORAGE_KEY, type DocumentVersion, type VersionRepository,
} from "../src/document-history.ts";
import { createInitialDocument, LocalJsonStore, STORAGE_KEY } from "../src/local-json.ts";
import { getDocumentFieldChanges, type DocumentFieldChange } from "../src/document-diff.ts";
import type { BetterMeDocument } from "../src/types.ts";

class MemoryVersions implements VersionRepository {
  versions: DocumentVersion[] = [];
  async list() { return structuredClone(this.versions); }
  async putAndPrune(version: DocumentVersion, limit: number) {
    this.versions = [structuredClone(version), ...this.versions.filter(item => item.id !== version.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async delete(id: string) { this.versions = this.versions.filter(item => item.id !== id); }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t: any) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const doc = createInitialDocument();
  const store = new LocalJsonStore();
  await store.save(doc);
  const repository = new MemoryVersions();
  const history = new LocalDocumentHistory(repository);
  const controller = new DocumentPersistenceController({ store, history, autoSave: { enabled: false, trigger: "enter", delayMs: 1_000, historyIntervalMs: 15_000 } });
  t.after(() => controller.dispose());
  await controller.load();
  return { data, storage, doc, store, repository, history, controller };
}
function phoneChange(current: BetterMeDocument, value = "historical phone"): DocumentFieldChange {
  const target = structuredClone(current);
  target.factBase.profile.phone = value;
  const change = getDocumentFieldChanges(current, target).find(item => item.label === "电话");
  assert.ok(change, "the fixture must contain a real phone field diff");
  return change;
}

test("single-field restoration merges into the latest current editor and protects a complete undo snapshot", async t => {
  const { doc, store, controller, history } = await setup(t);
  const change = phoneChange(doc);
  const latest = structuredClone(doc);
  latest.factBase.profile.email = "newest@example.com";
  latest.resumeViews[0]!.name = "unrelated new resume name";
  controller.update(latest);
  assert.equal(await controller.restoreField(change, "恢复电话"), true);
  const saved = (await store.load())!;
  assert.equal(saved.factBase.profile.phone, "historical phone");
  assert.equal(saved.factBase.profile.email, "newest@example.com");
  assert.equal(saved.resumeViews[0]!.name, "unrelated new resume name");
  assert.deepEqual(controller.getState().doc, saved);
  const refreshed = new DocumentPersistenceController({ store, history, autoSave: { enabled: false, trigger: "enter", delayMs: 1_000, historyIntervalMs: 15_000 } });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.deepEqual(refreshed.getState().doc, saved, "the completed field restoration must survive a fresh load");
  const versions = await history.list();
  const undo = versions.find(item => item.label === "单项恢复前 · 当前编辑");
  assert.deepEqual(undo?.document, latest);
  assert.ok(versions.some(item => item.label === "恢复电话" && item.kind === "restore" && item.document.factBase.profile.phone === "historical phone"));
  assert.equal(await controller.replace(undo!.document, "撤回单项恢复", "restore"), true);
  assert.deepEqual(controller.getState().doc, latest);
  assert.deepEqual(await store.load(), latest, "undo must also persist the protected pre-restore current editor");
});

test("an incomplete editor restores only the chosen field as a protected draft, preserving invalid fields and NaN", async t => {
  const { data, doc, store, controller, history } = await setup(t);
  const current = structuredClone(doc);
  current.factBase.profile.email = "unfinished@";
  current.factBase.experiences[0]!.start = "";
  current.factBase.experiences[0]!.claims.find(claim => claim.metric)!.metric!.value = Number.NaN;
  controller.update(current);
  const official = data.get(STORAGE_KEY);
  const historyBefore = (await history.list()).length;
  assert.equal(await controller.restoreField(phoneChange(current)), true);
  const result = controller.getState();
  assert.equal(result.doc!.factBase.profile.phone, "historical phone");
  assert.equal(result.doc!.factBase.profile.email, "unfinished@");
  assert.equal(result.doc!.factBase.experiences[0]!.start, "");
  assert.ok(Number.isNaN(result.doc!.factBase.experiences[0]!.claims.find(claim => claim.metric)!.metric!.value));
  assert.equal(result.status.kind, "draft");
  assert.match(result.status.message, /其他未完成字段仍保留/);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.deepEqual(await store.load(), doc);
  assert.equal((await history.list()).length, historyBefore, "invalid drafts must never become complete history versions");
  assert.match(data.get(PREVIOUS_DRAFT_STORAGE_KEY)!, /unfinished@/);
  assert.match(data.get(PREVIOUS_DRAFT_STORAGE_KEY)!, /\$betterMeNumber/);
  const restored = new DocumentPersistenceController({ history, autoSave: { enabled: false, trigger: "enter", delayMs: 1_000, historyIntervalMs: 15_000 } });
  t.after(() => restored.dispose());
  await restored.load();
  assert.equal(restored.getState().doc!.factBase.profile.phone, "historical phone");
  assert.equal(restored.getState().doc!.factBase.profile.email, "unfinished@");
});

test("restoring the last invalid field may create a complete version while protecting its prior draft", async t => {
  const { data, doc, store, controller } = await setup(t);
  const current = structuredClone(doc);
  current.factBase.profile.email = "unfinished@";
  current.factBase.profile.phone = "keep current phone";
  controller.update(current);
  const change = getDocumentFieldChanges(current, doc).find(item => item.label === "邮箱")!;
  assert.equal(await controller.restoreField(change), true);
  assert.equal(controller.getState().status.kind, "saved");
  assert.equal((await store.load())!.factBase.profile.email, doc.factBase.profile.email);
  assert.equal((await store.load())!.factBase.profile.phone, "keep current phone");
  assert.match(data.get(PREVIOUS_DRAFT_STORAGE_KEY)!, /unfinished@/);
});

test("another-window conflict refuses field restore without clearing conflict or adopting its whole document", async t => {
  const { data, doc, store, controller } = await setup(t);
  const change = phoneChange(doc);
  const external = structuredClone(doc);
  external.factBase.profile.email = "other-window@example.com";
  await store.save(external);
  controller.handleStorageChange(STORAGE_KEY, data.get(STORAGE_KEY)!);
  const status = controller.getState().status;
  const official = data.get(STORAGE_KEY);
  const draft = data.get(DRAFT_STORAGE_KEY);
  await assert.rejects(controller.restoreField(change), /窗口.*冲突/);
  assert.equal(controller.getState().status, status);
  assert.equal(controller.getState().status.externalConflict, true);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.equal(data.get(DRAFT_STORAGE_KEY), draft);
  assert.deepEqual(controller.getState().doc, doc);
});

test("a stale selected field is refused without changing unrelated current values or official storage", async t => {
  const { data, doc, controller } = await setup(t);
  const change = phoneChange(doc);
  const latest = structuredClone(doc);
  latest.factBase.profile.phone = "edited after comparison";
  latest.factBase.profile.email = "latest@example.com";
  controller.update(latest);
  const official = data.get(STORAGE_KEY);
  await assert.rejects(controller.restoreField(change), /变化|重新|不同|过期/);
  assert.deepEqual(controller.getState().doc, latest);
  assert.equal(data.get(STORAGE_KEY), official);
});

test("complete pre-restore snapshot failure prevents all current and official changes", async t => {
  const { data, doc, repository, controller } = await setup(t);
  const change = phoneChange(doc);
  t.mock.method(repository, "putAndPrune", async () => { throw new Error("snapshot denied"); });
  const official = data.get(STORAGE_KEY);
  const draft = data.get(DRAFT_STORAGE_KEY);
  await assert.rejects(controller.restoreField(change), /无法保护恢复前/);
  assert.deepEqual(controller.getState().doc, doc);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.equal(data.get(DRAFT_STORAGE_KEY), draft);
  assert.match(controller.getState().status.historyError!, /snapshot denied/);
});

test("incomplete pre-restore draft protection failure prevents the chosen field from changing", async t => {
  const { data, storage, doc, controller } = await setup(t);
  const current = structuredClone(doc);
  current.factBase.profile.email = "unfinished@";
  controller.update(current);
  const setItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === PREVIOUS_DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    setItem(key, value);
  });
  const official = data.get(STORAGE_KEY);
  const draft = data.get(DRAFT_STORAGE_KEY);
  await assert.rejects(controller.restoreField(phoneChange(current)), /无法保护恢复前/);
  assert.deepEqual(controller.getState().doc, current);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.equal(data.get(DRAFT_STORAGE_KEY), draft);
});

test("an edit while the undo snapshot is pending cancels restoration without emitting old state", async t => {
  const { data, doc, repository, controller } = await setup(t);
  const started = deferred<void>(), release = deferred<void>();
  const put = repository.putAndPrune.bind(repository);
  t.mock.method(repository, "putAndPrune", async (version: DocumentVersion, limit: number) => {
    started.resolve(); await release.promise; await put(version, limit);
  });
  const official = data.get(STORAGE_KEY);
  const pending = controller.restoreField(phoneChange(doc));
  const rejected = assert.rejects(pending, /当前编辑.*变化/);
  await started.promise;
  const latest = structuredClone(doc);
  latest.factBase.profile.email = "during-await@example.com";
  controller.update(latest);
  const status = controller.getState().status;
  release.resolve();
  await rejected;
  assert.deepEqual(controller.getState().doc, latest);
  assert.equal(controller.getState().status, status);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.match(data.get(DRAFT_STORAGE_KEY)!, /during-await@example.com/);
});

test("an external conflict arriving during undo protection cancels restoration and keeps the external official", async t => {
  const { data, doc, store, repository, controller } = await setup(t);
  const started = deferred<void>(), release = deferred<void>();
  const put = repository.putAndPrune.bind(repository);
  t.mock.method(repository, "putAndPrune", async (version: DocumentVersion, limit: number) => {
    started.resolve(); await release.promise; await put(version, limit);
  });
  const pending = controller.restoreField(phoneChange(doc));
  const rejected = assert.rejects(pending, /变化/);
  await started.promise;
  const external = structuredClone(doc);
  external.factBase.profile.email = "external-during-await@example.com";
  await store.save(external);
  controller.handleStorageChange(STORAGE_KEY, data.get(STORAGE_KEY)!);
  const official = data.get(STORAGE_KEY);
  const status = controller.getState().status;
  release.resolve(); await rejected;
  assert.deepEqual(controller.getState().doc, doc);
  assert.equal(controller.getState().status, status);
  assert.equal(controller.getState().status.externalConflict, true);
  assert.equal(data.get(STORAGE_KEY), official);
});

test("official save failure retains the current editor and protected undo snapshot", async t => {
  const { data, doc, store, controller, history } = await setup(t);
  t.mock.method(store, "save", async () => { throw new DOMException("quota", "QuotaExceededError"); });
  const official = data.get(STORAGE_KEY);
  await assert.rejects(controller.restoreField(phoneChange(doc)), /该项尚未恢复/);
  assert.deepEqual(controller.getState().doc, doc);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.ok((await history.list()).some(item => item.label === "单项恢复前 · 当前编辑"));
});

test("result history failure reports that restoration succeeded and retains the pre-restore undo snapshot", async t => {
  const { doc, store, repository, controller, history } = await setup(t);
  const put = repository.putAndPrune.bind(repository);
  t.mock.method(repository, "putAndPrune", async (version: DocumentVersion, limit: number) => {
    if (version.kind === "restore") throw new Error("new snapshot denied");
    await put(version, limit);
  });
  assert.equal(await controller.restoreField(phoneChange(doc)), true);
  assert.equal(controller.getState().doc!.factBase.profile.phone, "historical phone");
  assert.equal((await store.load())!.factBase.profile.phone, "historical phone");
  assert.match(controller.getState().status.historyError!, /该项已保存.*恢复结果快照未保存/);
  const undo = (await history.list()).find(item => item.label === "单项恢复前 · 当前编辑");
  assert.deepEqual(undo?.document, doc);
});

test("new edits during the result snapshot await are not overwritten by restoration completion or its history error", async t => {
  const { data, doc, repository, controller } = await setup(t);
  const started = deferred<void>(), release = deferred<void>();
  const put = repository.putAndPrune.bind(repository);
  t.mock.method(repository, "putAndPrune", async (version: DocumentVersion, limit: number) => {
    if (version.kind === "restore") {
      started.resolve(); await release.promise;
      throw new Error("late result snapshot failure");
    }
    await put(version, limit);
  });
  const pending = controller.restoreField(phoneChange(doc));
  await started.promise;
  assert.equal(controller.getState().doc!.factBase.profile.phone, "historical phone");
  const latest = structuredClone(controller.getState().doc!);
  latest.factBase.profile.email = "after-restoration@example.com";
  controller.update(latest);
  const status = controller.getState().status;
  release.resolve();
  assert.equal(await pending, true, "the field was saved before the subsequent edit");
  assert.deepEqual(controller.getState().doc, latest);
  assert.equal(controller.getState().status, status);
  assert.match(data.get(DRAFT_STORAGE_KEY)!, /after-restoration@example.com/);
  assert.equal(controller.getState().status.historyError, undefined);
});

test("failed protected draft write does not install a partially restored incomplete editor", async t => {
  const { data, storage, doc, controller } = await setup(t);
  const current = structuredClone(doc);
  current.factBase.profile.email = "unfinished@";
  controller.update(current);
  const setItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    setItem(key, value);
  });
  const official = data.get(STORAGE_KEY);
  await assert.rejects(controller.restoreField(phoneChange(current)), /该项尚未恢复/);
  assert.deepEqual(controller.getState().doc, current);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.match(data.get(PREVIOUS_DRAFT_STORAGE_KEY)!, /unfinished@/);
});
