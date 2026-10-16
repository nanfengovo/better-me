import test from "node:test";
import assert from "node:assert/strict";
import { LocalJsonStore, StoredDocumentError, STORAGE_KEY, createInitialDocument, exportDocumentJson, parseDocumentJson } from "../src/index.ts";

function fakeStorage(t: any) {
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

test("new store is empty and full backup roundtrip preserves all views", async (t) => {
  fakeStorage(t);
  const store = new LocalJsonStore();
  assert.equal(await store.load(), null);
  const doc = createInitialDocument();
  doc.resumeViews.push({ ...doc.resumeViews[0]!, id: "en", locale: "en" });
  doc.activeResumeId = "en";
  await store.save(doc);
  assert.deepEqual(await store.load(), doc);
  assert.deepEqual(parseDocumentJson(exportDocumentJson(doc)), doc);
});

test("corrupt or invalid stored data raises recovery error without changing original bytes", async (t) => {
  const { data } = fakeStorage(t);
  const store = new LocalJsonStore();
  for (const raw of ["", "{broken", "{}", JSON.stringify({ ...createInitialDocument(), activeResumeId: "missing" })]) {
    data.set(STORAGE_KEY, raw);
    await assert.rejects(store.load(), StoredDocumentError);
    assert.equal(data.get(STORAGE_KEY), raw);
  }
});

test("unfinished field edit fails validation and preserves last saved document", async (t) => {
  const { data } = fakeStorage(t);
  const store = new LocalJsonStore();
  const doc = createInitialDocument();
  await store.save(doc);
  const saved = data.get(STORAGE_KEY);
  doc.factBase.profile.email = "unfinished@";
  await assert.rejects(store.save(doc));
  assert.equal(data.get(STORAGE_KEY), saved);
  doc.factBase.profile.email = "updated@example.com";
  await store.save(doc);
  assert.equal((await store.load())!.factBase.profile.email, "updated@example.com");
});

test("storage quota error propagates without destroying previous saved data", async (t) => {
  const { data, storage } = fakeStorage(t);
  const store = new LocalJsonStore();
  const doc = createInitialDocument();
  await store.save(doc);
  const saved = data.get(STORAGE_KEY);
  t.mock.method(storage, "setItem", () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  await assert.rejects(store.save(doc), { name: "QuotaExceededError" });
  assert.equal(data.get(STORAGE_KEY), saved);
});

test("backup restore rejects invalid calendar months and reversed experience ranges", () => {
  const doc = createInitialDocument();
  doc.factBase.experiences[0]!.start = "2024-13";
  assert.throws(() => parseDocumentJson(JSON.stringify(doc)), /日期无效/);
  doc.factBase.experiences[0]!.start = "2024-01";
  doc.factBase.experiences[0]!.end = "2023-12";
  assert.throws(() => parseDocumentJson(JSON.stringify(doc)), /日期无效/);
});
