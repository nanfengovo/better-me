import assert from "node:assert/strict";
import test from "node:test";
import { IndexedDbAgentRepository, createMemoryAgentRepository, emptyAgentState, AgentStorageConflict } from "../src/lib/betterme-agent/storage";
import { BetterMeAgent } from "../src/lib/betterme-agent/kernel";
import { agentStorageIssue } from "../src/lib/betterme-agent/storage-issue";

// Only the connection/transaction seam is substituted. No user database is opened.
function fixture() {
  const state = { opens: 0, failOpen: false, closed: false };
  const factory = { open() {
    state.opens++;
    const db = { close() { state.closed = true; }, onversionchange: undefined as (() => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      transaction() {
        if (state.closed) throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "InvalidStateError");
        const tx = { oncomplete: undefined as (() => void) | undefined, objectStore() { return { get() { queueMicrotask(() => tx.oncomplete?.()); return { result: undefined }; } }; } };
        return tx;
      },
    };
    const request = { result: db, error: new DOMException("test open failure", "UnknownError"), onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined };
    queueMicrotask(() => { if (state.failOpen) request.onerror?.(); else { state.closed = false; request.onsuccess?.(); } });
    return request;
  } };
  return { state, factory };
}
async function withFixture(run: (repo: IndexedDbAgentRepository, state: ReturnType<typeof fixture>["state"]) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB"), f = fixture();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: f.factory });
  try { await run(new IndexedDbAgentRepository(), f.state); }
  finally { if (original) Object.defineProperty(globalThis, "indexedDB", original); else Reflect.deleteProperty(globalThis, "indexedDB"); }
}
test("a closing cached connection is reopened before starting a transaction", async () => withFixture(async (repo, state) => {
  await repo.load("isolated"); state.closed = true;
  assert.equal(await repo.load("isolated"), undefined);
  assert.equal(state.opens, 2);
}));
test("an unsuccessful database open is not cached forever", async () => withFixture(async (repo, state) => {
  state.failOpen = true; await assert.rejects(repo.load("isolated"));
  state.failOpen = false; assert.equal(await repo.load("isolated"), undefined);
  assert.equal(state.opens, 2);
}));

test("explicit storage recovery preserves queued local history without calling a model", async () => {
  const saved = createMemoryAgentRepository(); let fail = true, writes = 0;
  const repo = { load: saved.load, save: async (...args: Parameters<typeof saved.save>) => { writes++; if (fail) throw new DOMException("test", "QuotaExceededError"); await saved.save(...args); } };
  const agent = new BetterMeAgent("recovery", repo, async () => { throw new Error("must not call model/host"); }); await agent.ready;
  agent.record({ id: "one", origin: "companion", role: "user", text: "未保存但必须保留" });
  agent.setGoal("队列中后续的目标");
  await assert.rejects(agent.flush());
  assert.equal(agent.getSnapshot().storageIssue?.kind, "quota");
  fail = false; await Promise.all([agent.recoverStorage(), agent.recoverStorage()]);
  assert.equal(writes, 2, "only one explicit recovery write, not each queued stale snapshot");
  assert.equal((await saved.load("recovery"))?.messages[0]?.text, "未保存但必须保留");
  assert.equal((await saved.load("recovery"))?.goal, "队列中后续的目标");
  assert.equal(agent.getSnapshot().error, "");
  agent.setGoal("恢复后继续"); await agent.flush();
  assert.equal((await saved.load("recovery"))?.revision, 2);
});
test("recovery never overwrites a newer window and keeps both versions accessible", async () => {
  const repo = createMemoryAgentRepository();
  const agent = new BetterMeAgent("conflict", repo, async () => { throw new Error("no calls"); }); await agent.ready;
  const other = { ...emptyAgentState("conflict"), revision: 1, goal: "其他窗口" }; await repo.save(other, 0);
  agent.setGoal("本页未保存目标"); await assert.rejects(agent.flush());
  await assert.rejects(agent.recoverStorage(), AgentStorageConflict);
  assert.equal((await repo.load("conflict"))?.goal, "其他窗口");
  assert.equal(agent.getSnapshot().data.goal, "本页未保存目标");
  assert.equal(agent.getSnapshot().storageIssue?.retryable, false);
});
test("initial read recovery loads existing data instead of saving an empty state", async () => {
  const repo = createMemoryAgentRepository(); await repo.save({ ...emptyAgentState("read"), revision: 1, goal: "已有记录" }, 0);
  let fail = true, writes = 0;
  const agent = new BetterMeAgent("read", { load: async key => { if (fail) throw new DOMException("closing", "InvalidStateError"); return repo.load(key); }, save: async () => { writes++; } }, async () => { throw new Error("no calls"); });
  await agent.ready; fail = false; await agent.recoverStorage();
  assert.equal(agent.getSnapshot().data.goal, "已有记录"); assert.equal(writes, 0);
});
test("storage error presentation hides browser internals and classifies actionable failures", () => {
  const closed = agentStorageIssue(new DOMException("Failed to execute transaction: database connection is closing private-path", "InvalidStateError"));
  assert.equal(closed.kind, "connection"); assert.doesNotMatch(closed.message, /transaction|private-path|IDBDatabase/);
  assert.equal(agentStorageIssue(new DOMException("test", "QuotaExceededError")).kind, "quota");
  assert.equal(agentStorageIssue(new DOMException("test", "VersionError")).kind, "blocked");
});
