import assert from "node:assert/strict";
import test from "node:test";
import { ATLAS_CONNECTION_SESSION_KEY, clearAtlasConnectionSession, parseAtlasConnectionSession, readAtlasConnectionSession, writeAtlasConnectionSession } from "../src/components/atlas/connection-session.ts";

const live = { schemaVersion: 1 as const, dataMode: "live" as const, endpoint: "http://127.0.0.1:5178", token: "synthetic-test-token" };
function store() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("connection sessions accept only known modes/version and loopback roots with nonempty bounded credentials", () => {
  for (const endpoint of ["http://127.0.0.1:5178", "https://localhost:5178/", "http://[::1]:5178"]) assert.deepEqual(parseAtlasConnectionSession({ ...live, endpoint }), { ...live, endpoint });
  assert.deepEqual(parseAtlasConnectionSession({ schemaVersion: 1, dataMode: "demo" }), { schemaVersion: 1, dataMode: "demo" });
  assert.deepEqual(parseAtlasConnectionSession({ schemaVersion: 1, dataMode: "local" }), { schemaVersion: 1, dataMode: "local" });
  for (const invalid of [null, [], {}, { ...live, schemaVersion: 2 }, { ...live, dataMode: "unknown" }, { ...live, extra: true },
    { schemaVersion: 1, dataMode: "local", token: live.token }, { ...live, token: " " }, { ...live, token: "x".repeat(4097) }, { ...live, token: "x\r\ny" },
    ...["https://jobs.example.invalid", "http://localhost.example.invalid", "file:///localhost", "http://user:pass@localhost", "http://localhost/path", "http://localhost/?token=x", "http://localhost/#x"].map(endpoint => ({ ...live, endpoint }))]) {
    assert.equal(parseAtlasConnectionSession(invalid), undefined);
  }
});

test("changing to a nonlive view removes credentials, while malformed and future records are discarded", () => {
  const storage = store();
  assert.equal(writeAtlasConnectionSession(live, storage), true);
  assert.deepEqual(readAtlasConnectionSession(storage), live);
  assert.equal(writeAtlasConnectionSession({ schemaVersion: 1, dataMode: "local" }, storage), true);
  assert.doesNotMatch(storage.values.get(ATLAS_CONNECTION_SESSION_KEY)!, /token|endpoint|synthetic/);
  for (const raw of ["{", "x".repeat(5001), JSON.stringify({ ...live, schemaVersion: 99 })]) {
    storage.values.set(ATLAS_CONNECTION_SESSION_KEY, raw);
    assert.equal(readAtlasConnectionSession(storage), undefined);
    assert.equal(storage.values.has(ATLAS_CONNECTION_SESSION_KEY), false);
  }
});

test("blocked or full session storage does not break page-memory connections", () => {
  const storage = { getItem() { throw new Error("storage blocked"); }, setItem() { throw new Error("storage full"); }, removeItem() { throw new Error("storage blocked"); } };
  assert.equal(readAtlasConnectionSession(storage), undefined);
  assert.equal(writeAtlasConnectionSession(live, storage), false);
  assert.doesNotThrow(() => clearAtlasConnectionSession(storage));
});
