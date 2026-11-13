import test from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_STORAGE_KEY,
  PREVIOUS_DRAFT_STORAGE_KEY,
  HISTORY_LIMIT,
  STORAGE_KEY,
  DocumentPersistenceController,
  LocalDocumentHistory,
  LocalJsonStore,
  createInitialDocument,
  getDocumentFieldChanges,
  type DocumentVersion,
  type VersionRepository,
  DEFAULT_AUTO_SAVE_SETTINGS,
  normalizeAutoSaveSettings,
} from "../src/index.ts";

class MemoryVersions implements VersionRepository {
  versions: DocumentVersion[] = [];
  async list() { return structuredClone(this.versions); }
  async putAndPrune(version: DocumentVersion, limit: number) {
    this.versions = [version, ...this.versions.filter((item) => item.id !== version.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async delete(id: string) { this.versions = this.versions.filter((item) => item.id !== id); }
}
function storageFixture(t: any) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return { data, storage };
}
async function setup(t: any) {
  const fixture = storageFixture(t);
  const doc = createInitialDocument();
  const store = new LocalJsonStore();
  await store.save(doc);
  const repository = new MemoryVersions();
  const history = new LocalDocumentHistory(repository);
  const controller = new DocumentPersistenceController({ store, history, commitLock: serialCommitLock(), delayMs: 60_000 });
  t.after(() => controller.dispose());
  await controller.load();
  return { ...fixture, doc, store, repository, history, controller };
}

function serialCommitLock(onRequest = () => {}) {
  let queue = Promise.resolve();
  return (write: () => Promise<boolean>) => {
    onRequest();
    const result = queue.then(write);
    queue = result.then(() => {}, () => {});
    return result;
  };
}
function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
test("two tabs approving different editions from one baseline cannot both write or publish a losing edition", async t => {
  const { store, history } = await setup(t);
  const writing = signal(), releaseFirst = signal(), secondEntered = signal();
  let requests = 0;
  const commitLock = serialCommitLock(() => { if (++requests === 2) secondEntered.release(); });
  const open = async () => {
    const tab = new DocumentPersistenceController({ store, history, commitLock, delayMs: 60_000 });
    t.after(() => tab.dispose()); await tab.load(); return tab;
  };
  const first = await open(), second = await open();
  const beforeA = first.getState().doc!, beforeB = second.getState().doc!;
  const nextA = structuredClone(beforeA), nextB = structuredClone(beforeB);
  nextA.resumeViews[0]!.name = "approved A"; nextB.resumeViews[0]!.name = "approved B";
  const save = store.save.bind(store), writes: string[] = [];
  store.save = async doc => {
    const name = doc.resumeViews[0]!.name; writes.push(name);
    if (name === "approved A") { writing.release(); await releaseFirst.promise; }
    else secondEntered.release(); // unprotected implementation enters here
    await save(doc);
  };
  const a = first.saveReviewedVersion(nextA, beforeA, "task A");
  await writing.promise;
  const b = second.saveReviewedVersion(nextB, beforeB, "task B");
  await secondEntered.promise; releaseFirst.release();
  assert.deepEqual(await Promise.all([a, b]), [true, false]);
  assert.deepEqual(writes, ["approved A"]);
  assert.equal((await store.load())?.resumeViews[0]?.name, "approved A");
  assert.equal(first.getState().doc?.resumeViews[0]?.name, "approved A");
  assert.equal(second.getState().doc, beforeB);
  assert.equal(second.getState().status.externalConflict, true);
});

test("reviewed version uses exact current document and readback before acknowledgement", async (t) => {
  const { controller, store } = await setup(t);
  const expected = controller.getState().doc!;
  const next = structuredClone(expected); next.resumeViews[0]!.name = "Synthetic reviewed edition";
  assert.equal(await controller.saveReviewedVersion(next, expected, "Synthetic task"), true);
  assert.equal((await store.load())?.resumeViews[0]?.name, "Synthetic reviewed edition");
  assert.equal(await controller.saveReviewedVersion(next, expected, "stale source"), false);
});
test("each ordinary official writer respects the same lock as a concurrent approved edition without waiting for a storage event", async t => {
  for (const mode of ["autosave", "manual", "replace", "single-field restore"] as const) await t.test(mode, async t => {
    const { store, history } = await setup(t);
    const entered = signal(), release = signal(), queued = signal();
    let requests = 0;
    const commitLock = serialCommitLock(() => { if (++requests === 2) queued.release(); });
    const a = new DocumentPersistenceController({ store, history, commitLock, delayMs: 60_000 });
    const b = new DocumentPersistenceController({ store, history, commitLock, delayMs: 60_000 });
    t.after(() => { a.dispose(); b.dispose(); }); await Promise.all([a.load(), b.load()]);
    const initial = a.getState().doc!, theirs = b.getState().doc!;
    const approved = structuredClone(initial), stale = structuredClone(theirs);
    approved.factBase.profile.phone = "approved value"; stale.factBase.profile.phone = "stale tab input";
    const save = store.save.bind(store);
    const values: string[] = [];
    store.save = async doc => {
      const value = doc.factBase.profile.phone!; values.push(value);
      if (value === "approved value") { entered.release(); await release.promise; } else queued.release();
      await save(doc);
    };
    const first = a.saveReviewedVersion(approved, initial, "approved");
    await entered.promise;
    const other = (async () => {
      if (mode === "replace") return b.replace(stale, "import");
      if (mode === "single-field restore") {
        const change = getDocumentFieldChanges(theirs, stale).find(item => item.label === "电话")!;
        return b.restoreField(change).catch(() => false);
      }
      b.update(stale); return b.flush(mode === "manual");
    })();
    await queued.promise; release.release();
    assert.deepEqual(await Promise.all([first, other]), [true, false]);
    assert.deepEqual(values, ["approved value"]);
    assert.equal((await store.load())?.factBase.profile.phone, "approved value");
    assert.equal(b.getState().status.externalConflict, true);
  });
});
test("without a cross-tab lock a new review fails closed with an explanation but ordinary explicit saves are still available", async t => {
  const { store, history } = await setup(t);
  const tab = new DocumentPersistenceController({ store, history, delayMs: 60_000 });
  t.after(() => tab.dispose()); await tab.load();
  const before = tab.getState().doc!, next = structuredClone(before);
  next.resumeViews[0]!.name = "ordinary explicit save";
  const save = t.mock.method(store, "save");
  assert.equal(await tab.saveReviewedVersion(next, before, "review"), false);
  assert.equal(await tab.saveReviewedVersion(before, before, "review replay"), false);
  assert.deepEqual(await tab.readOfficialForReview(before), before); // explicitly read-only remains possible
  assert.match(tab.getState().status.message, /跨窗口独占写锁/);
  assert.equal(tab.getState().doc, before);
  assert.equal(save.mock.callCount(), 0);
  tab.update(next);
  assert.equal(await tab.flush(true), true);
  assert.equal((await store.load())?.resumeViews[0]?.name, "ordinary explicit save");
});
test("a denied cross-tab lock is not treated as permission for an unprotected review", async t => {
  const { store, history } = await setup(t);
  const tab = new DocumentPersistenceController({ store, history, commitLock: async () => { throw new Error("synthetic lock denied"); } });
  t.after(() => tab.dispose()); await tab.load();
  const expected = tab.getState().doc!, target = structuredClone(expected);
  target.resumeViews[0]!.name = "not committed";
  const save = t.mock.method(store, "save");
  assert.equal(await tab.saveReviewedVersion(target, expected, "blocked"), false);
  assert.equal(save.mock.callCount(), 0);
  assert.match(tab.getState().status.message, /跨窗口独占写锁/);
  assert.equal(tab.getState().doc, expected);
});
test("receipt inspection reads only official storage; a changed editor or an uncertain read never confirms a pending draft", async t => {
  const { store, history, controller, data } = await setup(t);
  const base = controller.getState().doc!, pending = structuredClone(base);
  pending.resumeViews[0]!.name = "pending only"; controller.update(pending);
  const bytes = [...data], histories = (await history.list()).length;
  const save = t.mock.method(store, "save"), load = store.load.bind(store);
  assert.deepEqual(await controller.readOfficialForReview(pending), base);
  assert.deepEqual([...data], bytes);
  assert.equal(save.mock.callCount(), 0);
  assert.equal((await history.list()).length, histories);
  const entered = signal(), release = signal();
  store.load = async () => { entered.release(); await release.promise; return load(); };
  const reading = controller.readOfficialForReview(pending); await entered.promise;
  controller.update(structuredClone(pending)); release.release();
  await assert.rejects(reading, /已变化/);
  const current = controller.getState().doc!;
  store.load = async () => { throw new Error("synthetic unreadable"); };
  await assert.rejects(controller.readOfficialForReview(current), /synthetic unreadable/);
  store.load = async () => null;
  assert.equal(await controller.readOfficialForReview(current), null);
  assert.equal(save.mock.callCount(), 0);
});
test("reviewed version does not resolve external conflict or acknowledge unknown durable readback", async (t) => {
  const { controller, store } = await setup(t);
  const expected = controller.getState().doc!;
  const incoming = structuredClone(expected); incoming.resumeViews[0]!.name = "Other window";
  controller.handleStorageChange(STORAGE_KEY, JSON.stringify(incoming));
  assert.equal(await controller.saveReviewedVersion(incoming, expected, "must refuse conflict"), false);
  const isolated = new DocumentPersistenceController({ store, history: controller.history, commitLock: serialCommitLock(), delayMs: 60000 });
  t.after(() => isolated.dispose()); await isolated.load();
  const source = isolated.getState().doc!;
  const next = structuredClone(source); next.resumeViews[0]!.name = "Unknown readback";
  let reads = 0;
  const originalLoad = store.load.bind(store);
  store.load = async () => ++reads === 1 ? originalLoad() : null;
  assert.equal(await isolated.saveReviewedVersion(next, source, "readback failure"), false);
  assert.equal(reads, 2);
});

test("reviewed durable save awaits final authorization and does not write after revocation or a local edit", async t => {
  for (const change of ["revoke", "edit", "external"] as const) {
    await t.test(change, async t => {
      const { controller, store } = await setup(t);
      const expected = controller.getState().doc!;
      const proposed = structuredClone(expected); proposed.resumeViews[0]!.name = "Approved proposal";
      let enter!: () => void, resume!: () => void;
      const guardStarted = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const pending = controller.saveReviewedVersion(proposed, expected, "review gate", async () => {
        enter(); await gate;
        if (change === "revoke") throw new Error("consent revoked");
      });
      await Promise.race([guardStarted, pending]);
      const edit = structuredClone(expected); edit.resumeViews[0]!.name = "Independent edit";
      if (change === "edit") controller.update(edit);
      if (change === "external") await store.save(edit); // storage event not received yet
      resume();
      assert.equal(await pending, false);
      assert.equal((await store.load())?.resumeViews[0]?.name, change === "external" ? "Independent edit" : expected.resumeViews[0]!.name);
      assert.equal(controller.getState().doc, change === "edit" ? edit : expected);
    });
  }
});
test("idempotent reviewed readback never rewrites the document or creates another checkpoint", async t => {
  const { controller, store, history } = await setup(t);
  const expected = controller.getState().doc!;
  const save = t.mock.method(store, "save");
  const before = (await history.list()).length;
  assert.equal(await controller.saveReviewedVersion(expected, expected, "existing receipt"), true);
  assert.equal(save.mock.callCount(), 0);
  assert.equal((await history.list()).length, before);
  const external = structuredClone(expected); external.resumeViews[0]!.name = "Changed elsewhere";
  await store.save(external);
  assert.equal(await controller.saveReviewedVersion(expected, expected, "late replay"), false);
  assert.equal(save.mock.callCount(), 1);
  assert.equal((await store.load())?.resumeViews[0]?.name, "Changed elsewhere");
});
test("a reviewed save with an unknown readback preserves intervening editor input and never acknowledges it", async t => {
  const { controller, store } = await setup(t);
  const expected = controller.getState().doc!;
  const proposed = structuredClone(expected); proposed.resumeViews[0]!.name = "Saved edition";
  const newer = structuredClone(expected); newer.resumeViews[0]!.name = "Newer in-flight edit";
  const load = store.load.bind(store);
  let reads = 0;
  store.load = async () => { const value = await load(); if (++reads === 2) controller.update(newer); return value; };
  assert.equal(await controller.saveReviewedVersion(proposed, expected, "readback changed"), false);
  assert.equal(controller.getState().doc, newer);
});

test("approved writing protects an incomplete draft without forcing official save or autosave on", async (t) => {
  const { doc, controller, data } = await setup(t);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  const incomplete = structuredClone(doc); incomplete.factBase.profile.email = "unfinished@";
  controller.update(incomplete);
  const official = data.get(STORAGE_KEY);
  assert.equal(await controller.protectEdit("伴写修改前"), true);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.equal(JSON.parse(data.get(PREVIOUS_DRAFT_STORAGE_KEY)!).document.factBase.profile.email, "unfinished@");
  assert.equal(controller.getState().doc, incomplete);
});
test("writing protection falls back to a separate durable previous-draft slot and fails closed", async (t) => {
  const { doc, store, history, storage } = await setup(t);
  let previous = "";
  const controller = new DocumentPersistenceController({ store, history, previousDraftRepository: { load: async () => previous || null, save: async raw => { previous = raw; } } });
  t.after(() => controller.dispose()); await controller.load();
  const incomplete = structuredClone(doc); incomplete.factBase.profile.email = "unfinished@"; controller.update(incomplete);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => { if (key === PREVIOUS_DRAFT_STORAGE_KEY) throw new Error("quota"); setItem(key, value); };
  assert.equal(await controller.protectEdit("伴写修改前"), true);
  assert.equal(JSON.parse(previous).document.factBase.profile.email, "unfinished@");
  const failing = new DocumentPersistenceController({ store, history, previousDraftRepository: { load: async () => null, save: async () => { throw new Error("also full"); } } });
  t.after(() => failing.dispose()); await failing.load(); failing.update(incomplete);
  assert.equal(await failing.protectEdit("伴写修改前"), false);
});

test("unfinished draft survives immediate refresh without weakening official schema", async (t) => {
  const { data, doc, store, controller, history } = await setup(t);
  const official = data.get(STORAGE_KEY);
  const unfinished = structuredClone(doc);
  unfinished.factBase.profile.email = "unfinished@";
  unfinished.factBase.experiences[0]!.start = "";
  const metric = unfinished.factBase.experiences.flatMap((item) => item.claims).find((item) => item.metric)?.metric;
  assert.ok(metric);
  metric.value = Number.NaN;
  controller.update(unfinished);
  assert.ok(data.get(DRAFT_STORAGE_KEY)?.includes("unfinished@"));
  assert.equal(await controller.flush(), false);
  assert.equal(controller.getState().status.kind, "draft");
  assert.equal(data.get(STORAGE_KEY), official);
  assert.deepEqual(await store.load(), doc);
  const refreshed = new DocumentPersistenceController({ history, delayMs: 60_000 });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.equal(refreshed.getState().doc!.factBase.profile.email, "unfinished@");
  assert.equal(refreshed.getState().doc!.factBase.experiences[0]!.start, "");
  const refreshedMetric = refreshed.getState().doc!.factBase.experiences.flatMap((item) => item.claims).find((item) => item.metric)?.metric;
  assert.ok(Number.isNaN(refreshedMetric?.value));
  assert.equal(refreshed.getState().status.recoveredDraft, true);
});

test("malformed nested draft is retained raw instead of crashing the editor", async (t) => {
  const { data, doc, history } = await setup(t);
  const malformed = structuredClone(doc) as any;
  malformed.factBase.experiences[0].claims = { unexpected: "not an array" };
  const raw = JSON.stringify({ schemaVersion: 1, savedAt: new Date(Date.now() + 10_000).toISOString(), document: malformed });
  data.set(DRAFT_STORAGE_KEY, raw);
  const controller = new DocumentPersistenceController({ history });
  t.after(() => controller.dispose());
  await controller.load();
  assert.deepEqual(controller.getState().doc, doc);
  assert.equal(controller.getState().status.rawDraftRecovery, raw);
  assert.equal(data.get(DRAFT_STORAGE_KEY), raw);
});

test("valid draft recovers a damaged official file and retains damaged bytes for download", async (t) => {
  const { data, doc, controller, history } = await setup(t);
  controller.update({ ...doc, factBase: { ...doc.factBase, profile: { ...doc.factBase.profile, email: "recovered@example.com" } } });
  data.set(STORAGE_KEY, "{broken official");
  const refreshed = new DocumentPersistenceController({ history });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.equal(refreshed.getState().doc!.factBase.profile.email, "recovered@example.com");
  assert.equal(refreshed.getState().status.rawOfficialRecovery, "{broken official");
  assert.equal(data.get(STORAGE_KEY), "{broken official");
});

test("save and restore failures protect previous official version and active editor", async (t) => {
  const { data, doc, storage, controller } = await setup(t);
  const original = data.get(STORAGE_KEY);
  const setItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    setItem(key, value);
  });
  const edit = structuredClone(doc);
  edit.factBase.profile.email = "edit@example.com";
  controller.update(edit);
  assert.equal(await controller.flush(), false);
  assert.equal(data.get(STORAGE_KEY), original);
  assert.equal(controller.getState().status.kind, "error");
  assert.ok(data.get(DRAFT_STORAGE_KEY)?.includes("edit@example.com"));
  const target = structuredClone(doc);
  target.factBase.profile.email = "restore@example.com";
  assert.equal(await controller.replace(target, "failed restore", "restore"), false);
  assert.equal(controller.getState().doc!.factBase.profile.email, "edit@example.com");
  assert.equal(data.get(STORAGE_KEY), original);
});

test("named checkpoints and restored snapshots preserve newer history", async (t) => {
  const { doc, controller, history } = await setup(t);
  assert.equal(await controller.checkpoint("投递前"), true);
  const first = (await history.list()).find((item) => item.label === "投递前")!;
  const updated = structuredClone(doc);
  updated.factBase.profile.email = "new@example.com";
  controller.update(updated);
  assert.equal(await controller.checkpoint("面试版"), true);
  const newer = (await history.list()).find((item) => item.label === "面试版")!;
  assert.equal(await controller.replace(first.document, "恢复 · 投递前", "restore"), true);
  const versions = await history.list();
  assert.equal(versions[0]!.kind, "restore");
  assert.ok(versions.some((item) => item.id === newer.id));
  assert.equal(versions.find((item) => item.id === newer.id)!.document.factBase.profile.email, "new@example.com");
  assert.equal(controller.getState().doc!.factBase.profile.email, doc.factBase.profile.email);
});

test("automatic snapshots coalesce changed bursts, omit timestamp noise, and obey retention", async () => {
  const history = new LocalDocumentHistory(new MemoryVersions());
  const doc = createInitialDocument();
  await history.append(doc);
  await history.append({ ...doc, factBase: { ...doc.factBase, updatedAt: new Date(Date.now() + 200).toISOString() } });
  assert.equal((await history.list()).length, 1);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "123";
  await history.append(changed);
  assert.equal((await history.list()).length, 1);
  assert.equal((await history.list())[0]!.document.factBase.profile.phone, "123");
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) await history.append(doc, `checkpoint-${i}`, "checkpoint");
  const versions = await history.list();
  assert.equal(versions.length, HISTORY_LIMIT);
  assert.equal(versions[0]!.label, `checkpoint-${HISTORY_LIMIT + 4}`);
});

test("continuous editing creates periodic versions instead of sliding the coalescing window forever", async (t) => {
  let clock = Date.parse("2026-10-17T10:00:00.000Z");
  t.mock.method(Date, "now", () => clock);
  const history = new LocalDocumentHistory(new MemoryVersions());
  const doc = createInitialDocument();
  await history.append(doc);
  clock += 10_000;
  const second = structuredClone(doc);
  second.factBase.profile.phone = "edit at ten seconds";
  await history.append(second);
  clock += 10_000;
  const third = structuredClone(doc);
  third.factBase.profile.phone = "edit at twenty seconds";
  await history.append(third);
  assert.equal((await history.list()).length, 2);
});

test("session baseline survives the first automatic change", async (t) => {
  const { doc, controller, history } = await setup(t);
  const original = (await history.list()).find((item) => item.label === "会话起点 · 上次完整版本");
  assert.ok(original);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "first session edit";
  controller.update(changed);
  assert.equal(await controller.flush(), true);
  assert.ok((await history.list()).some((item) => item.id === original.id && item.document.factBase.profile.phone === doc.factBase.profile.phone));
});

test("late obsolete save cannot replace the newer editor or final persisted data", async (t) => {
  const { doc, store, history } = await setup(t);
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedStore = new LocalJsonStore();
  let count = 0;
  delayedStore.save = async (next) => {
    if (++count === 1) { started!(); await gate; }
    await store.save(next);
  };
  const controller = new DocumentPersistenceController({ store: delayedStore, history, delayMs: 60_000 });
  t.after(() => controller.dispose());
  await controller.load();
  const older = structuredClone(doc);
  older.factBase.profile.phone = "older";
  const olderSave = controller.replace(older, "older", "restore");
  await start;
  const newer = structuredClone(doc);
  newer.factBase.profile.phone = "newer";
  controller.update(newer);
  const newerSave = controller.flush();
  release!();
  assert.equal(await olderSave, false);
  assert.equal(await newerSave, true);
  assert.equal(controller.getState().doc!.factBase.profile.phone, "newer");
  assert.equal((await store.load())!.factBase.profile.phone, "newer");
  assert.ok(!(await history.list()).some((item) => item.label === "older"));
});

test("failed draft write after valid replace never recovers an older draft over new official data", async (t) => {
  const { doc, storage, history, controller } = await setup(t);
  const older = structuredClone(doc);
  older.factBase.profile.phone = "old draft";
  controller.update(older);
  const setItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    setItem(key, value);
  });
  const newer = structuredClone(doc);
  newer.factBase.profile.phone = "new official";
  assert.equal(await controller.replace(newer, "new"), true);
  const refreshed = new DocumentPersistenceController({ history });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.equal(refreshed.getState().doc!.factBase.profile.phone, "new official");
});

test("history failure is visible while successful official autosave remains protected", async (t) => {
  const { doc, store } = await setup(t);
  const brokenRepository: VersionRepository = { list: async () => [], putAndPrune: async () => { throw new Error("version quota"); }, delete: async () => {} };
  const controller = new DocumentPersistenceController({ store, history: new LocalDocumentHistory(brokenRepository), delayMs: 60_000 });
  t.after(() => controller.dispose());
  await controller.load();
  const next = structuredClone(doc);
  next.factBase.profile.phone = "saved despite history";
  controller.update(next);
  assert.equal(await controller.flush(), true);
  assert.equal(controller.getState().status.kind, "saved");
  assert.equal(controller.getState().status.historyError, "version quota");
  assert.equal((await store.load())!.factBase.profile.phone, "saved despite history");
});

test("restore protects valid pending edits that have not reached their debounce", async (t) => {
  const { doc, controller, history } = await setup(t);
  const pending = structuredClone(doc);
  pending.factBase.profile.phone = "unsaved newest editing";
  controller.update(pending);
  assert.equal(await controller.replace(doc, "恢复旧版", "restore"), true);
  const preserved = (await history.list()).find((item) => item.label === "切换前 · 当前编辑");
  assert.ok(preserved);
  assert.equal(preserved.document.factBase.profile.phone, "unsaved newest editing");
});

test("restore protects incomplete prior draft separately without relaxing version schema", async (t) => {
  const { data, doc, controller, history } = await setup(t);
  const unfinished = structuredClone(doc);
  unfinished.factBase.profile.email = "unfinished@";
  controller.update(unfinished);
  assert.equal(await controller.replace(doc, "restore", "restore"), true);
  assert.ok(data.get(PREVIOUS_DRAFT_STORAGE_KEY)?.includes("unfinished@"));
  assert.ok(controller.getState().status.rawPreviousDraftRecovery?.includes("unfinished@"));
  assert.ok((await history.list()).every((item) => item.document.factBase.profile.email !== "unfinished@"));
  const refreshed = new DocumentPersistenceController({ history });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.ok(refreshed.getState().status.rawPreviousDraftRecovery?.includes("unfinished@"));
});

test("pre-switch protection failure aborts restoration before official or active data changes", async (t) => {
  const { data, doc, store } = await setup(t);
  const repository: VersionRepository = { list: async () => [], putAndPrune: async () => { throw new Error("snapshot denied"); }, delete: async () => {} };
  const controller = new DocumentPersistenceController({ store, history: new LocalDocumentHistory(repository) });
  t.after(() => controller.dispose());
  await controller.load();
  const official = data.get(STORAGE_KEY);
  const target = structuredClone(doc);
  target.factBase.profile.phone = "restore target";
  assert.equal(await controller.replace(target, "restore", "restore"), false);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.deepEqual(controller.getState().doc, doc);
  assert.match(controller.getState().status.message, /当前简历未被替换/);
});

test("API configuration cannot enter official documents, drafts, or version snapshots", async (t) => {
  const { data, doc, controller, history } = await setup(t);
  const injected = { ...doc, llmConfig: { apiKey: "do-not-save-secret" } };
  controller.update(injected);
  assert.equal(await controller.checkpoint("safe"), true);
  assert.ok(!data.get(STORAGE_KEY)!.includes("do-not-save-secret"));
  assert.ok(!data.get(DRAFT_STORAGE_KEY)!.includes("do-not-save-secret"));
  assert.ok(!JSON.stringify(await history.list()).includes("do-not-save-secret"));
});

test("another tab's save pauses lifecycle autosave and protects both branches", async (t) => {
  const { data, doc, controller, store, history } = await setup(t);
  const localEdit = structuredClone(doc);
  localEdit.factBase.profile.phone = "local unfinished work";
  controller.update(localEdit);
  const external = structuredClone(doc);
  external.factBase.profile.phone = "other window";
  await store.save(external);
  const otherWindowBytes = data.get(STORAGE_KEY);
  controller.handleStorageChange(STORAGE_KEY, otherWindowBytes!);
  assert.equal(controller.getState().status.externalConflict, true);
  assert.equal(controller.getState().doc!.factBase.profile.phone, "local unfinished work");
  assert.ok(data.get(PREVIOUS_DRAFT_STORAGE_KEY)?.includes("local unfinished work"));
  assert.equal(await controller.flush(), false);
  assert.equal(data.get(STORAGE_KEY), otherWindowBytes);
  assert.equal(await controller.flush(true), true);
  assert.equal(controller.getState().status.externalConflict, false);
  assert.equal((await store.load())!.factBase.profile.phone, "local unfinished work");
  assert.ok((await history.list()).some((item) => item.document.factBase.profile.phone === "other window"));
});

test("another tab's draft update cannot be silently overwritten on pagehide", async (t) => {
  const { data, doc, controller } = await setup(t);
  const otherDraft = structuredClone(doc);
  otherDraft.factBase.profile.email = "unfinished-from-other-tab@";
  const raw = JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), document: otherDraft });
  data.set(DRAFT_STORAGE_KEY, raw);
  controller.handleStorageChange(DRAFT_STORAGE_KEY, raw);
  assert.equal(controller.getState().status.externalConflict, true);
  assert.equal(await controller.flush(), false);
  assert.equal(data.get(DRAFT_STORAGE_KEY), raw);
});

test("metadata-only saves and unrelated configuration updates do not trigger conflicts", async (t) => {
  const { data, doc, controller, store } = await setup(t);
  await store.save({ ...doc, factBase: { ...doc.factBase, updatedAt: new Date(Date.now() + 20_000).toISOString() } });
  controller.handleStorageChange(STORAGE_KEY, data.get(STORAGE_KEY)!);
  controller.handleStorageChange("better-me:llm-config", "{}");
  assert.notEqual(controller.getState().status.externalConflict, true);
});

test("damaged official without renderable draft can be reset while retaining raw recovery", async (t) => {
  const { data, doc, history } = await setup(t);
  data.set(STORAGE_KEY, "{corrupt");
  data.set(DRAFT_STORAGE_KEY, "{damaged draft");
  const controller = new DocumentPersistenceController({ history });
  t.after(() => controller.dispose());
  await controller.load();
  assert.equal(controller.getState().ready, true);
  assert.equal(controller.getState().doc, null);
  assert.ok(controller.getState().loadError);
  assert.equal(await controller.replace(doc, "重置演示", "import"), true);
  assert.deepEqual(controller.getState().doc, doc);
  assert.equal(controller.getState().loadError, null);
  assert.equal(controller.getState().status.rawOfficialRecovery, "{corrupt");
});

test("autosave preferences tolerate damaged data and enforce supported bounds", () => {
  assert.deepEqual(normalizeAutoSaveSettings(null), DEFAULT_AUTO_SAVE_SETTINGS);
  assert.deepEqual(normalizeAutoSaveSettings({ enabled: "false", trigger: "keypress", delayMs: Number.NaN, historyIntervalMs: "15" }), DEFAULT_AUTO_SAVE_SETTINGS);
  assert.deepEqual(normalizeAutoSaveSettings({ enabled: false, trigger: "blur", delayMs: 0, historyIntervalMs: 1_000_000 }), {
    enabled: false, trigger: "blur", delayMs: 1_000, historyIntervalMs: 600_000,
  });
  assert.equal(normalizeAutoSaveSettings({ delayMs: 999_999 }).delayMs, 300_000);
  assert.equal(normalizeAutoSaveSettings({ historyIntervalMs: 1 }).historyIntervalMs, 15_000);
});

test("default Enter autosave protects drafts without allowing lifecycle flush or wrong triggers", async (t) => {
  const { data, doc, store, history } = await setup(t);
  const controller = new DocumentPersistenceController({ store, history });
  t.after(() => controller.dispose());
  await controller.load();
  const official = data.get(STORAGE_KEY);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "wait for enter";
  controller.update(changed);
  assert.equal(controller.getState().status.kind, "draft");
  assert.equal(controller.getState().status.hasPendingChanges, true);
  assert.match(controller.getState().status.message, /按回车/);
  assert.equal(await controller.flush(), false);
  assert.equal(await controller.notifyAutoSaveTrigger("blur"), false);
  assert.equal(data.get(STORAGE_KEY), official);
  assert.ok(data.get(DRAFT_STORAGE_KEY)?.includes("wait for enter"));
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), true);
  assert.equal(controller.getState().status.hasPendingChanges, false);
  assert.match(controller.getState().status.message, /自动保存/);
  const count = (await history.list()).length;
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), false);
  assert.equal((await history.list()).length, count);
});

test("disabled and field-exit modes respect triggers while manual save remains available", async (t) => {
  const { data, doc, controller, history } = await setup(t);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  const versions = (await history.list()).length;
  const official = data.get(STORAGE_KEY);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "manual only";
  controller.update(changed);
  assert.match(controller.getState().status.message, /已关闭/);
  assert.equal(await controller.flush(), false);
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), false);
  assert.equal(data.get(STORAGE_KEY), official);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, trigger: "blur" });
  assert.equal((await history.list()).length, versions);
  assert.match(controller.getState().status.message, /离开编辑字段/);
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), false);
  assert.equal(await controller.flush(), false);
  assert.equal(await controller.notifyAutoSaveTrigger("blur"), true);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  controller.update({ ...changed, factBase: { ...changed.factBase, profile: { ...changed.factBase.profile, phone: "manual saved" } } });
  assert.equal(await controller.flush(true), true);
  assert.match(controller.getState().status.message, /手动保存/);
  assert.equal(controller.getState().status.hasPendingChanges, false);
});

test("changing autosave settings cancels old timers and reschedules only enabled idle work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { doc, store, controller } = await setup(t);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "delayed";
  controller.update(changed);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  t.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load())!.factBase.profile.phone, doc.factBase.profile.phone);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, trigger: "idle", delayMs: 1_000 });
  t.mock.timers.tick(999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load())!.factBase.profile.phone, doc.factBase.profile.phone);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load())!.factBase.profile.phone, "delayed");
  assert.equal(controller.getState().status.hasPendingChanges, false);
});

test("refresh recovers valid unsaved drafts without promoting them in Enter or disabled modes", async (t) => {
  const { data, doc, controller, store, history } = await setup(t);
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "recovered pending";
  controller.update(changed);
  const official = data.get(STORAGE_KEY);
  const count = (await history.list()).length;
  for (const enabled of [true, false]) {
    const refreshed = new DocumentPersistenceController({ store, history, autoSave: { ...DEFAULT_AUTO_SAVE_SETTINGS, enabled } });
    t.after(() => refreshed.dispose());
    await refreshed.load();
    assert.equal(refreshed.getState().doc!.factBase.profile.phone, "recovered pending");
    assert.equal(refreshed.getState().status.kind, "draft");
    assert.equal(refreshed.getState().status.hasPendingChanges, true);
    assert.equal(await refreshed.flush(), false);
    assert.equal(data.get(STORAGE_KEY), official);
    assert.equal((await history.list()).length, count);
  }
});

test("first launch with default Enter mode creates a draft but no history before a trigger", async (t) => {
  const { data } = storageFixture(t);
  const history = new LocalDocumentHistory(new MemoryVersions());
  const controller = new DocumentPersistenceController({ history });
  t.after(() => controller.dispose());
  await controller.load();
  assert.ok(data.has(DRAFT_STORAGE_KEY));
  assert.equal(data.has(STORAGE_KEY), false);
  assert.equal((await history.list()).length, 0);
  assert.equal(controller.getState().status.hasPendingChanges, true);
  assert.equal(await controller.flush(), false);
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), true);
  assert.equal(data.has(STORAGE_KEY), true);
  assert.equal((await history.list()).length, 1);
});

test("localStorage quota overflow protects the latest complete edit in IndexedDB and restores it on reload", async (t) => {
  const { doc, storage, store } = await setup(t);
  let indexedDraft: string | null = null;
  const draftRepository = {
    async load() { return indexedDraft; },
    async save(raw: string) { indexedDraft = raw; },
  };
  const history = new LocalDocumentHistory(new MemoryVersions());
  const controller = new DocumentPersistenceController({ history, draftRepository, autoSave: { ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false } });
  t.after(() => controller.dispose());
  await controller.load();
  const originalSetItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    originalSetItem(key, value);
  });

  const edit = structuredClone(doc);
  edit.factBase.profile.email = "quota-recovered@example.com";
  controller.update(edit);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(indexedDraft?.includes("quota-recovered@example.com"));
  assert.equal(controller.getState().status.kind, "draft");
  assert.ok(controller.getState().status.draftSavedAt);
  assert.equal((await store.load())!.factBase.profile.email, doc.factBase.profile.email);

  const refreshed = new DocumentPersistenceController({ history, draftRepository });
  t.after(() => refreshed.dispose());
  await refreshed.load();
  assert.equal(refreshed.getState().doc!.factBase.profile.email, "quota-recovered@example.com");
  assert.equal(refreshed.getState().status.recoveredDraft, true);
});

test("successful complete save clears the draft-protection warning after IndexedDB fallback succeeds", async (t) => {
  const { doc, storage, store } = await setup(t);
  let indexedDraft: string | null = null;
  const draftRepository = {
    async load() { return indexedDraft; },
    async save(raw: string) { indexedDraft = raw; },
  };
  const history = new LocalDocumentHistory(new MemoryVersions());
  const controller = new DocumentPersistenceController({ store, history, draftRepository, autoSave: { ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false } });
  t.after(() => controller.dispose());
  await controller.load();
  const originalSetItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    originalSetItem(key, value);
  });

  const edit = structuredClone(doc);
  edit.factBase.profile.email = "official-saved@example.com";
  controller.update(edit);
  assert.equal(await controller.flush(true), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal((await store.load())!.factBase.profile.email, "official-saved@example.com");
  assert.ok(indexedDraft?.includes("official-saved@example.com"));
  assert.equal(controller.getState().status.kind, "saved");
  assert.equal(controller.getState().status.hasPendingChanges, false);
  assert.equal(controller.getState().status.historyError, undefined);
});

test("when both draft stores reject writes, the complete version remains saved and the user gets a recovery warning", async (t) => {
  const { doc, storage, store } = await setup(t);
  const draftRepository = {
    async load() { return null; },
    async save() { throw new DOMException("quota", "QuotaExceededError"); },
  };
  const history = new LocalDocumentHistory(new MemoryVersions());
  const controller = new DocumentPersistenceController({ store, history, draftRepository, autoSave: { ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false } });
  t.after(() => controller.dispose());
  await controller.load();
  const originalSetItem = storage.setItem;
  t.mock.method(storage, "setItem", (key: string, value: string) => {
    if (key === DRAFT_STORAGE_KEY) throw new DOMException("quota", "QuotaExceededError");
    originalSetItem(key, value);
  });

  const edit = structuredClone(doc);
  edit.factBase.profile.email = "backup-needed@example.com";
  controller.update(edit);
  assert.equal(await controller.flush(true), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal((await store.load())!.factBase.profile.email, "backup-needed@example.com");
  assert.equal(controller.getState().doc!.factBase.profile.email, "backup-needed@example.com");
  assert.equal(controller.getState().status.kind, "error");
  assert.equal(controller.getState().status.hasPendingChanges, false);
  assert.match(controller.getState().status.message, /仅在页面内，离开会丢失/);
  assert.match(controller.getState().status.message, /请立即下载备份/);
  assert.match(controller.getState().status.historyError!, /草稿保护失败/);
});

test("default Enter first launch reports a failed draft write without claiming local protection", async (t) => {
  const { data, storage } = storageFixture(t);
  t.mock.method(storage, "setItem", () => { throw new DOMException("quota", "QuotaExceededError"); });
  const history = new LocalDocumentHistory(new MemoryVersions());
  const controller = new DocumentPersistenceController({ history });
  t.after(() => controller.dispose());
  await controller.load();
  const state = controller.getState();
  assert.equal(state.ready, true);
  assert.ok(state.doc);
  assert.equal(state.status.kind, "error");
  assert.equal(state.status.hasPendingChanges, true);
  assert.equal(state.status.draftSavedAt, undefined);
  assert.match(state.status.message, /存储空间不足/);
  assert.match(state.status.message, /正在尝试使用 IndexedDB/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status.kind, "error");
  assert.match(controller.getState().status.message, /仅在页面内.*离开会丢失/);
  assert.match(controller.getState().status.message, /请立即下载备份/);
  assert.equal(data.has(DRAFT_STORAGE_KEY), false);
  assert.equal(data.has(STORAGE_KEY), false);
  assert.equal((await history.list()).length, 0);
  assert.equal(await controller.flush(), false);
});

test("switching autosave off lets an already started manual save finish consistently", async (t) => {
  const { doc, store, history } = await setup(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start = new Promise<void>((resolve) => { started = resolve; });
  const delayedStore = new LocalJsonStore();
  delayedStore.save = async (next) => { started(); await gate; await store.save(next); };
  const controller = new DocumentPersistenceController({ store: delayedStore, history });
  t.after(() => controller.dispose());
  await controller.load();
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "save already started";
  controller.update(changed);
  const saving = controller.flush(true);
  await start;
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  release();
  assert.equal(await saving, true);
  assert.equal(controller.getState().status.kind, "saved");
  assert.equal(controller.getState().status.hasPendingChanges, false);
  assert.match(controller.getState().status.message, /手动保存/);
  assert.equal((await store.load())!.factBase.profile.phone, "save already started");
  controller.update({ ...changed, factBase: { ...changed.factBase, profile: { ...changed.factBase.profile, phone: "later manual only" } } });
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), false);
  assert.match(controller.getState().status.message, /已关闭/);
});

test("switching autosave off cancels an automatic write still waiting behind another save", async (t) => {
  const { doc, store, history } = await setup(t);
  let release!: () => void;
  let started!: () => void;
  let writes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start = new Promise<void>((resolve) => { started = resolve; });
  const delayedStore = new LocalJsonStore();
  delayedStore.save = async (next) => { ++writes; started(); await gate; await store.save(next); };
  const controller = new DocumentPersistenceController({ store: delayedStore, history });
  t.after(() => controller.dispose());
  await controller.load();
  const initialSave = controller.flush(true);
  await start;
  controller.update({ ...doc, factBase: { ...doc.factBase, profile: { ...doc.factBase.profile, phone: "queued automatic" } } });
  const queued = controller.notifyAutoSaveTrigger("enter");
  await Promise.resolve();
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false });
  release();
  await initialSave;
  assert.equal(await queued, false);
  assert.equal(writes, 1);
  assert.equal((await store.load())!.factBase.profile.phone, doc.factBase.profile.phone);
  assert.equal(controller.getState().status.hasPendingChanges, true);
  assert.match(controller.getState().status.message, /已关闭/);
});

test("configurable snapshot intervals retain fixed windows and explicit versions", async (t) => {
  let clock = Date.parse("2026-10-17T10:00:00.000Z");
  t.mock.method(Date, "now", () => clock);
  const { doc, controller, history } = await setup(t);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS, historyIntervalMs: 60_000 });
  for (const [elapsed, phone] of [[0, "one"], [30_000, "two"], [30_001, "three"]] as const) {
    clock += elapsed;
    controller.update({ ...doc, factBase: { ...doc.factBase, profile: { ...doc.factBase.profile, phone } } });
    assert.equal(await controller.notifyAutoSaveTrigger("enter"), true);
  }
  const automatic = (await history.list()).filter((item) => item.kind === "automatic");
  assert.equal(automatic.length, 2);
  assert.ok(automatic.some((item) => item.document.factBase.profile.phone === "two"));
  assert.ok(automatic.some((item) => item.document.factBase.profile.phone === "three"));
  assert.equal(await controller.checkpoint("explicit"), true);
  assert.equal((await history.list())[0]!.kind, "checkpoint");
});

test("Enter autosave stays paused after conflicting external changes and further local editing", async (t) => {
  const { doc, data, controller, store } = await setup(t);
  controller.setAutoSaveSettings({ ...DEFAULT_AUTO_SAVE_SETTINGS });
  const changed = structuredClone(doc);
  changed.factBase.profile.phone = "local";
  controller.update(changed);
  await store.save({ ...doc, factBase: { ...doc.factBase, profile: { ...doc.factBase.profile, phone: "external" } } });
  controller.handleStorageChange(STORAGE_KEY, data.get(STORAGE_KEY)!);
  controller.update({ ...changed, factBase: { ...changed.factBase, profile: { ...changed.factBase.profile, phone: "local later" } } });
  assert.equal(await controller.notifyAutoSaveTrigger("enter"), false);
  assert.equal(controller.getState().status.externalConflict, true);
  assert.equal((await store.load())!.factBase.profile.phone, "external");
  assert.equal(await controller.flush(true), true);
  assert.equal((await store.load())!.factBase.profile.phone, "local later");
});
