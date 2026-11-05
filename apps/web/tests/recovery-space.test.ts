import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { activatePrincipal } from "../src/lib/identity";
import { captureDocumentStorage, documentDatabase } from "../src/lib/private-storage";
import { IDBFactory } from "fake-indexeddb";
import { createInitialDocument } from "@better-me/storage";
import { prepareRecoverySpace } from "../src/lib/recovery";

test("recovered document working copies preserve the default document and pin late writes to the original account and space", () => {
  const dom = new Window(); const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.localStorage });
  try {
    activatePrincipal({ id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Alice" });
    const current = captureDocumentStorage(), recovered = captureDocumentStorage("a".repeat(32) + ".main");
    current.setItem("better-me:document:v1", "current unchanged"); recovered.setItem("better-me:document:v1", "recovered original");
    const database = documentDatabase("draft", "a".repeat(32) + ".main");
    activatePrincipal({ id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Bob" });
    recovered.setItem("late", "Alice only");
    assert.equal(captureDocumentStorage("a".repeat(32) + ".main").getItem("late"), null);
    assert.notEqual(documentDatabase("draft", "a".repeat(32) + ".main"), database);
    assert.equal(current.getItem("better-me:document:v1"), "current unchanged");
    assert.equal(recovered.getItem("better-me:document:v1"), "recovered original");
  } finally { activatePrincipal(undefined); dom.happyDOM.abort(); if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("concurrent recovery opens seed once; reopening never overwrites edits and a late fetch cannot create another owner's draft", async () => {
  const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Alice" };
  const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Bob" };
  const idb = new IDBFactory(), document = createInitialDocument(), space = "a".repeat(32) + ".main";
  const globals = new Map<string, PropertyDescriptor | undefined>();
  let release: ((response: Response) => void) | undefined;
  const payload = () => Response.json({ ownerId: alice.id, document });
  for (const [key, value] of Object.entries({ indexedDB: idb, fetch: async () => payload() })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const request = idb.open(name, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    activatePrincipal(alice); const databaseName = documentDatabase("better-me:document-draft:v1", space);
    await Promise.all(Array.from({ length: 8 }, () => prepareRecoverySpace(space)));
    const database = await open(databaseName);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("drafts", "readwrite"); transaction.objectStore("drafts").put("user-edited-working-copy", "active");
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
      await prepareRecoverySpace(space);
      const value = await new Promise<unknown>((resolve, reject) => { const request = database.transaction("drafts").objectStore("drafts").get("active"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      assert.equal(value, "user-edited-working-copy");
    } finally { database.close(); }
    const before = await idb.databases();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => new Promise<Response>(resolve => { release = resolve; }) });
    const late = prepareRecoverySpace("b".repeat(32) + ".main");
    assert.ok(release); activatePrincipal(bob); release(payload());
    await assert.rejects(late, /身份已失效/);
    assert.deepEqual(await idb.databases(), before, "a response for Alice cannot seed Bob or a new database after identity switches");
  } finally {
    activatePrincipal(undefined);
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
