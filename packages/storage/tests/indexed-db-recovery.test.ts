import test from "node:test";
import assert from "node:assert/strict";
import {
  IndexedDbVersionRepository,
  LocalDocumentHistory,
  type DocumentVersion,
} from "../src/document-history.js";
import { createInitialDocument } from "../src/index.js";

// Mock IndexedDB for testing connection closing and auto-recovery
class MockIDBTransaction {
  error: DOMException | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private listeners: Record<string, (() => void)[]> = {};

  constructor(
    private readonly store: MockIDBObjectStore,
    public readonly mode: IDBTransactionMode
  ) {
    queueMicrotask(() => {
      if (this.oncomplete) this.oncomplete();
      for (const listener of this.listeners["complete"] || []) {
        listener();
      }
    });
  }

  objectStore(_name: string) {
    return this.store;
  }

  addEventListener(event: string, callback: () => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  abort() {
    if (this.onabort) this.onabort();
    for (const listener of this.listeners["abort"] || []) {
      listener();
    }
  }
}

class MockIDBRequest {
  result: unknown = null;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  resolve(value: unknown) {
    this.result = value;
    queueMicrotask(() => {
      if (this.onsuccess) this.onsuccess();
    });
  }

  reject(err: DOMException) {
    this.error = err;
    queueMicrotask(() => {
      if (this.onerror) this.onerror();
    });
  }
}

class MockIDBObjectStore {
  data = new Map<string, unknown>();

  getAll() {
    const req = new MockIDBRequest();
    queueMicrotask(() => {
      req.resolve(Array.from(this.data.values()));
    });
    return req;
  }

  put(value: { id: string }) {
    this.data.set(value.id, value);
    const req = new MockIDBRequest();
    queueMicrotask(() => req.resolve(value.id));
    return req;
  }

  delete(id: string) {
    this.data.delete(id);
    const req = new MockIDBRequest();
    queueMicrotask(() => req.resolve(undefined));
    return req;
  }
}

test("IndexedDbVersionRepository auto-recovers and retries when transaction throws database connection is closing", async () => {
  const store = new MockIDBObjectStore();
  let openCount = 0;
  let shouldFailTransactionOnce = true;

  const mockDb1 = {
    onversionchange: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: () => {},
    transaction: (_name: string, mode: IDBTransactionMode) => {
      if (shouldFailTransactionOnce) {
        shouldFailTransactionOnce = false;
        const domErr = new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.");
        domErr.name = "InvalidStateError";
        throw domErr;
      }
      return new MockIDBTransaction(store, mode);
    },
  };

  const mockDb2 = {
    onversionchange: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: () => {},
    transaction: (_name: string, mode: IDBTransactionMode) => {
      return new MockIDBTransaction(store, mode);
    },
  };

  const fakeIndexedDB = {
    open: (_name: string, _version: number) => {
      openCount++;
      const req = new MockIDBRequest();
      queueMicrotask(() => {
        req.result = openCount === 1 ? mockDb1 : mockDb2;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };

  // Temporarily set global indexedDB
  const originalIndexedDB = globalThis.indexedDB;
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB;

  try {
    const repo = new IndexedDbVersionRepository();

    // Seed one item
    store.data.set("v-1", {
      id: "v-1",
      createdAt: new Date().toISOString(),
      label: "测试检查点",
      kind: "checkpoint",
      document: createInitialDocument(),
    });

    // When list() is called:
    // First connection throws "The database connection is closing."
    // Repository should catch it, reset, open fresh connection, and return list!
    const versions = await repo.list();

    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.id, "v-1");
    // Verify open was called twice (first connection + auto-reconnect)
    assert.equal(openCount, 2);
  } finally {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = originalIndexedDB;
  }
});

test("LocalDocumentHistory reset() invalidates connection so retry reopens database", async () => {
  let openCount = 0;
  const store = new MockIDBObjectStore();

  const fakeIndexedDB = {
    open: () => {
      openCount++;
      const req = new MockIDBRequest();
      const db = {
        onversionchange: null,
        onclose: null,
        onerror: null,
        close: () => {},
        transaction: (_name: string, mode: IDBTransactionMode) => new MockIDBTransaction(store, mode),
      };
      queueMicrotask(() => {
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };

  const originalIndexedDB = globalThis.indexedDB;
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB;

  try {
    const history = new LocalDocumentHistory();
    await history.list();
    assert.equal(openCount, 1);

    // Call list again without reset - reuses connection
    await history.list();
    assert.equal(openCount, 1);

    // Explicitly reset (e.g. user clicked "重新读取")
    history.reset();
    await history.list();
    assert.equal(openCount, 2);
  } finally {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = originalIndexedDB;
  }
});
