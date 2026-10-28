import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { acquireHarvestLease, openHarvestJournal } from "../src/components/atlas/harvest-journal";
import { harvestConnectionScope } from "../src/components/atlas/harvest-journal-idb";
import { createHarvestJournalAdapter, type JournalStorage, type JournalTable, type JournalTransaction } from "../src/components/atlas/harvest-journal-store";
import type { HarvestCapturedBatch, HarvestImportReceipt, HarvestRunInput } from "../src/components/atlas/harvest-checkpoint";

type Tables = Record<JournalTable, Map<string, { id: string }>>;
function memoryDatabase() {
  let tables: Tables = { runs: new Map(), batches: new Map(), providers: new Map() };
  let tail = Promise.resolve();
  let failure: Error | undefined;
  let commitGate: Promise<void> | undefined;
  return {
    failNext(error: Error) { failure = error; },
    holdNextCommit() { let release!: () => void; commitGate = new Promise<void>(done => { release = done; }); return release; },
    corrupt(table: JournalTable, key: string, row: { id: string }) { tables[table].set(key, row); },
    rows(table: JournalTable) { return [...tables[table].values()]; },
    open(): JournalStorage {
      let closed = false;
      return {
        close() { closed = true; },
        transaction<T>(mode: "readonly" | "readwrite", work: (transaction: JournalTransaction) => Promise<T>): Promise<T> {
          if (closed) return Promise.reject(new Error("closed"));
          const next = tail.then(async () => {
            const copy: Tables = structuredClone(tables);
            const result = await work({
              async get(table, id) { return structuredClone(copy[table].get(id)); },
              async list(table, filter) { return structuredClone([...copy[table].values()].filter(row => !filter || Reflect.get(row, filter.index) === filter.value)); },
              async put(table, row) { assert.equal(mode, "readwrite"); copy[table].set(row.id, structuredClone(row)); },
              async delete(table, id) { assert.equal(mode, "readwrite"); copy[table].delete(id); },
            });
            if (commitGate) { await commitGate; commitGate = undefined; }
            if (failure) { const error = failure; failure = undefined; throw error; }
            if (mode === "readwrite") tables = copy;
            return result;
          });
          tail = next.then(() => {}, () => {});
          return next;
        },
      };
    },
  };
}

const runInput: HarvestRunInput = { keyword: "C#", depth: "quick", view: { mode: "global", country: "CN", region: "", regionText: "" } };
function captured(id = "batch-1"): HarvestCapturedBatch {
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23";
  const url = "https://www.liepin.com/job/100001.shtml";
  return { id, provider: "liepin", platform: "猎聘", pageUrl, capturedAt: "2026-10-28T00:00:00.000Z", cards: [
    { platform: "猎聘", url, title: "C# engineer", company: "Synthetic Company", cardText: "C# engineer Synthetic Company", evidence: {
      pageUrl, cardSelector: ".job-card", fields: [
        { field: "url", selector: "a", text: url }, { field: "title", selector: ".title", text: "C# engineer" },
        { field: "company", selector: ".company", text: "Synthetic Company" },
      ],
    } },
  ] };
}
const receipt: HarvestImportReceipt = { ok: true, revision: 11, jobIds: ["job-synthetic"], snapshotIds: ["snapshot-synthetic"],
  counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1 } };

test("connection scopes hash exactly the normalized origin and actual bearer identity without retaining credentials", async () => {
  const scope = await harvestConnectionScope("http://LOCALHOST:80/", " synthetic-private-token ");
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(scope.includes("synthetic"), false);
  assert.equal(scope, await harvestConnectionScope("http://localhost", "synthetic-private-token"));
  assert.notEqual(scope, await harvestConnectionScope("http://localhost:5178", "synthetic-private-token"));
  assert.notEqual(scope, await harvestConnectionScope("http://localhost", "different-token"));
  for (const endpoint of ["https://remote.invalid", "http://localhost/path", "http://user:secret@localhost", "http://localhost/?token=secret"]) {
    await assert.rejects(harvestConnectionScope(endpoint, "synthetic-private-token"));
  }
  await assert.rejects(harvestConnectionScope("http://localhost", "\nsynthetic-private-token"));
});

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
afterEach(() => {
  mock.restoreAll(); mock.timers.reset();
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else Reflect.deleteProperty(globalThis, "navigator");
  if (indexedDBDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDBDescriptor); else Reflect.deleteProperty(globalThis, "indexedDB");
});

test("a scope has one cross-tab writer and release is idempotent", async () => {
  const occupied = new Set<string>();
  const calls: Array<{ name: string; options: LockOptions }> = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    async request(name: string, options: LockOptions, callback: (lock: { name: string } | null) => Promise<void>) {
      calls.push({ name, options });
      if (occupied.has(name)) return callback(null);
      occupied.add(name);
      try { return await callback({ name }); } finally { occupied.delete(name); }
    },
  } } });
  const scope = "a".repeat(64);
  const first = await acquireHarvestLease(scope);
  assert.ok(first);
  assert.equal(await acquireHarvestLease(scope), undefined);
  first.release(); first.release();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const second = await acquireHarvestLease(scope);
  assert.ok(second); second.release();
  assert.equal(calls.every(call => call.options.ifAvailable === true && call.options.mode === "exclusive"), true);
  assert.equal(calls[0]!.name.includes(scope), true);
});

test("abortable ifAvailable leases obey native option rules and hold until explicit release after delivery", async () => {
  let released = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    async request(_name: string, options: LockOptions, callback: (lock: object) => Promise<void>) {
      if (options.ifAvailable && options.signal) throw new DOMException("signal with ifAvailable", "NotSupportedError");
      await callback({}); released = true;
    },
  } } });
  const controller = new AbortController();
  const lease = await acquireHarvestLease("a".repeat(64), { signal: controller.signal });
  assert.ok(lease);
  controller.abort();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(released, false, "aborting collection must not unlock its in-flight receipt drain");
  lease.release();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(released, true);
});

test("a captured batch, exact prepared import and confirmed receipt survive close and reopen", async () => {
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  const batch = captured();
  await run.capture(batch);
  const { id: _id, platform: _platform, ...capture } = batch;
  const command = { input: { ...capture, expectedRevision: 10, previewFingerprint: "b".repeat(64), reviewed: true as const }, idempotencyKey: "synthetic-exact-key" };
  await run.prepare(batch.id, command);
  journal.close();
  const reopened = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const resumed = await reopened.findResumable();
  assert.equal(resumed?.id, run.id);
  assert.deepEqual((await resumed!.read()).batches[0]?.command, command);
  await resumed!.confirm(batch.id, receipt);
  assert.deepEqual((await resumed!.read()).batches[0]?.receipt, receipt);
  await resumed!.settle("completed");
  assert.equal(await reopened.findResumable(), undefined);
  const otherIdentity = createHarvestJournalAdapter(database.open(), "c".repeat(64));
  assert.equal(await otherIdentity.findResumable(), undefined);
});

function prepared(batch: HarvestCapturedBatch, revision = 10) {
  const { id: _id, platform: _platform, ...capture } = batch;
  return { input: { ...capture, expectedRevision: revision, previewFingerprint: "b".repeat(64), reviewed: true as const }, idempotencyKey: `synthetic-key-${revision}` };
}

test("new run creation supersedes the previous writer atomically and rollback leaves it resumable", async () => {
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const first = await journal.create(runInput);
  database.failNext(new Error("synthetic quota failure"));
  await assert.rejects(journal.create(runInput), /未能保存/);
  assert.equal((await journal.findResumable())?.id, first.id);
  assert.equal((await first.read()).run.state, "running");
  const second = await journal.create(runInput);
  assert.equal((await first.read()).run.state, "superseded");
  assert.equal((await journal.findResumable())?.id, second.id);
  await assert.rejects(first.initialize(["C#"], ["liepin"]), /已结束/);
  await second.settle("cancelled");
  assert.equal(await journal.findResumable(), undefined);
});

test("each batch mutation acknowledges only a committed transaction and preserves state after commit failure", async () => {
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  const batch = captured();
  const release = database.holdNextCommit();
  let acknowledged = false;
  const capture = run.capture(batch).then(() => { acknowledged = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  release(); await capture;
  const command = prepared(batch);
  database.failNext(new Error("synthetic write abort"));
  await assert.rejects(run.prepare(batch.id, command));
  assert.equal((await run.read()).batches[0]?.command, undefined);
  await run.prepare(batch.id, command);
  database.failNext(new Error("synthetic write abort"));
  await assert.rejects(run.confirm(batch.id, receipt));
  assert.equal((await run.read()).batches[0]?.receipt, undefined);
  assert.deepEqual((await run.read()).batches[0]?.command, command);
  await run.confirm(batch.id, receipt);
  assert.deepEqual((await run.read()).batches[0]?.receipt, receipt);
});

test("frozen plans and captured evidence cannot drift, while an unconfirmed CAS command can be replaced", async () => {
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  await run.initialize(["C#"], ["liepin"]);
  await assert.rejects(run.initialize(["Java"], ["liepin"]), /计划/);
  const batch = captured();
  await run.capture(batch); await run.capture(batch);
  const changed = structuredClone(batch); changed.cards[0]!.cardText += " changed";
  await assert.rejects(run.capture(changed), /不同来源证据/);
  await assert.rejects(run.prepare(batch.id, prepared(changed)), /证据不一致/);
  const first = prepared(batch);
  await run.prepare(batch.id, first);
  const revised = prepared(batch, 15);
  await run.prepare(batch.id, revised);
  assert.deepEqual((await run.read()).batches[0]?.command, revised);
  await assert.rejects(run.settle("completed"), /未确认/);
  await run.confirm(batch.id, receipt);
  await run.confirm(batch.id, receipt);
  await run.prepare(batch.id, revised);
  await assert.rejects(run.prepare(batch.id, first), /不能修改/);
  await assert.rejects(run.confirm(batch.id, { ...receipt, revision: 20 }), /不能替换/);
  assert.equal((await run.read()).batches.length, 1);
});

test("a late committed receipt can be confirmed after cancellation or supersession without reviving the run", async () => {
  for (const terminal of ["cancelled", "superseded", "needs-attention"] as const) {
    const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
    const run = await journal.create(runInput);
    await run.initialize(["C#"], ["liepin"]);
    const batch = captured();
    await run.capture(batch); await run.prepare(batch.id, prepared(batch));
    await run.settle(terminal);
    await run.confirm(batch.id, receipt);
    const saved = await run.read();
    assert.equal(saved.run.state, terminal);
    assert.deepEqual(saved.batches[0]?.receipt, receipt);
    assert.equal(await journal.findResumable(), undefined);
    await assert.rejects(run.capture(captured("new-batch")), /已结束/);
    await assert.rejects(run.prepare(batch.id, prepared(batch)), /已结束/);
  }
});

test("provider checkpoints bind run, term and provider and preserve partial coverage", async () => {
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
  const run = await journal.create(runInput);
  await run.initialize(["C#", ".NET"], ["liepin"]);
  const batch = captured();
  const result = { provider: batch.provider, platform: batch.platform, pageUrl: batch.pageUrl, cards: batch.cards,
    status: "ready" as const, rawCardCount: 2, warnings: ["synthetic limited coverage"],
    coverage: { pagesVisited: 1, pageLimit: 2, scrollSteps: 0, scrollLimit: 0, cardLimit: 50, stopReason: "page_limit" as const, partial: true } };
  const checkpoint = { term: "C#", capturedAt: batch.capturedAt, result };
  await run.recordProvider(checkpoint); await run.recordProvider(checkpoint);
  await run.recordProvider({ ...checkpoint, term: ".NET" });
  assert.equal((await run.read()).providers.length, 2);
  assert.equal((await run.read()).providers[0]?.result.coverage.partial, true);
  await assert.rejects(run.recordProvider({ ...checkpoint, term: "Java" }), /冻结计划/);
  await assert.rejects(run.recordProvider({ ...checkpoint, result: { ...result, warnings: ["different receipt"] } }), /不能被/);
});

test("retryable provider outcomes can be replaced without deleting already confirmed source batches", async () => {
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  const batch = captured();
  await run.capture(batch); await run.prepare(batch.id, prepared(batch)); await run.confirm(batch.id, receipt);
  const base = { provider: batch.provider, platform: batch.platform, pageUrl: batch.pageUrl, cards: batch.cards,
    status: "ready" as const, rawCardCount: 1, warnings: [],
    coverage: { pagesVisited: 1, pageLimit: 2, scrollSteps: 0, scrollLimit: 0, cardLimit: 50, stopReason: "no_progress" as const, partial: true } };
  await run.recordProvider({ term: "C#", capturedAt: batch.capturedAt, result: base });
  const retried = { ...base, coverage: { ...base.coverage, stopReason: "exhausted" as const, partial: false } };
  await run.recordProvider({ term: "C#", capturedAt: "2026-10-28T00:01:00.000Z", result: retried });
  const saved = await run.read();
  assert.equal(saved.providers.length, 1);
  assert.equal(saved.providers[0]?.result.coverage.stopReason, "exhausted");
  assert.deepEqual(saved.batches[0]?.receipt, receipt);
  await assert.rejects(run.recordProvider({ term: "C#", capturedAt: batch.capturedAt, result: base }), /不能被/);
});

test("corrupt and unknown-version records fail closed without initiating a network request", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("network must not start"); });
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const run = await journal.create(runInput);
  const row = database.rows("runs")[0]!;
  database.corrupt("runs", run.id, { ...row, record: { ...Reflect.get(row, "record"), schemaVersion: 99 } });
  await assert.rejects(journal.findResumable(), /损坏或版本/);
  await assert.rejects(run.read(), /损坏或版本/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("run evidence budgets reject oversized new evidence atomically, preserving captured records", async () => {
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64), { runBytes: 2048 });
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  await run.capture(captured());
  const oversized = captured("batch-2"); oversized.cards[0]!.cardText += "x".repeat(3000);
  await assert.rejects(run.capture(oversized), /存储预算/);
  assert.deepEqual((await run.read()).batches.map(batch => batch.id), ["batch-1"]);
});

test("retention never silently deletes unconfirmed evidence and refuses a new run when safe pruning is impossible", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:00:00Z") });
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64), { terminalRuns: 1 });
  const pending = await journal.create(runInput);
  await pending.initialize(["C#"], ["liepin"]); await pending.capture(captured());
  mock.timers.tick(10);
  const latest = await journal.create(runInput);
  mock.timers.tick(10); await latest.settle("completed");
  mock.timers.tick(10);
  await assert.rejects(journal.create(runInput), /未确认入库证据/);
  assert.equal((await pending.read()).batches.length, 1);
  assert.equal((await latest.read()).run.state, "completed");
});

test("only old fully confirmed terminal records are pruned; the three newest remain readable", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:00:00Z") });
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
  const runs = [];
  for (let index = 0; index < 4; index++) { mock.timers.tick(10); const run = await journal.create(runInput); await run.settle("completed"); runs.push(run); }
  mock.timers.tick(10); await journal.create(runInput);
  await assert.rejects(runs[0]!.read());
  for (const run of runs.slice(1)) assert.equal((await run.read()).run.state, "completed");
});

test("credential-shaped fields are rejected rather than persisted, and closing never settles the run", async () => {
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  assert.throws(() => journal.create({ ...runInput, token: "synthetic-private-token" } as HarvestRunInput), /损坏/);
  const run = await journal.create(runInput);
  await run.initialize(["C#"], ["liepin"]);
  assert.throws(() => run.capture({ ...captured(), headers: { Authorization: "Bearer synthetic-private-token" } } as HarvestCapturedBatch), /损坏/);
  const saved = await run.read(); saved.run.input.keyword = "mutated read";
  assert.equal((await run.read()).run.input.keyword, "C#");
  journal.close(); journal.close();
  await assert.rejects(run.read(), /已关闭/);
  const reopened = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  assert.equal((await (await reopened.findResumable())!.read()).run.state, "running");
  assert.equal(JSON.stringify(database.rows("runs")).includes("synthetic-private-token"), false);
});

test("unsupported IndexedDB and Web Locks are explicit errors rather than in-memory fallback", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  await assert.rejects(acquireHarvestLease("a".repeat(64)), /Web Locks/);
  await assert.rejects(openHarvestJournal({ endpoint: "http://localhost", token: "synthetic-private-token" }), /IndexedDB/);
});

test("a browser policy refusing IndexedDB produces an actionable error without falling back to memory", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() { throw new DOMException("synthetic denied storage", "SecurityError"); },
  } });
  await assert.rejects(openHarvestJournal({ endpoint: "http://localhost", token: "synthetic-private-token" }), /存储权限/);
});

test("aborting before a delayed grant never delivers a writer lease", async () => {
  let grant!: () => Promise<void>, released = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    async request(_name: string, _options: LockOptions, callback: (lock: object) => Promise<void>) {
      await new Promise<void>(resolve => { grant = async () => { await callback({}); released = true; resolve(); }; });
    },
  } } });
  const abort = new AbortController();
  const pending = acquireHarvestLease("a".repeat(64), { signal: abort.signal });
  await new Promise<void>(resolve => queueMicrotask(resolve));
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await grant();
  assert.equal(released, true);
});

test("explicit continuation reopens attention or cancelled work with the exact saved plan, commands and receipts", async () => {
  for (const terminal of ["needs-attention", "cancelled"] as const) {
    const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
    const run = await journal.create(runInput);
    await run.initialize(["C#", ".NET"], ["liepin"]);
    const first = captured(), pending = captured("pending-batch");
    await run.capture(first); await run.prepare(first.id, prepared(first)); await run.confirm(first.id, receipt);
    await run.capture(pending); await run.prepare(pending.id, prepared(pending));
    await run.settle(terminal);
    const before = await run.read();
    assert.equal(await journal.findResumable(), undefined, "explicit continuation never changes automatic-resume eligibility");
    const offered = await journal.findRecoverable();
    assert.equal(offered?.id, run.id);
    await offered!.resume();
    const after = await offered!.read();
    assert.equal(after.run.state, "running");
    assert.deepEqual(after.run.input, before.run.input);
    assert.deepEqual(after.run.queryTerms, before.run.queryTerms);
    assert.deepEqual(after.run.providers, before.run.providers);
    assert.deepEqual(after.batches, before.batches);
    assert.deepEqual(after.providers, before.providers);
    assert.equal((await journal.findResumable())?.id, run.id);
  }
});

test("recovery offers only the latest created run and never falls back past completed or superseded work", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:00:00Z") });
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const older = await journal.create(runInput); await older.settle("cancelled");
  mock.timers.tick(10);
  const latest = await journal.create({ ...runInput, keyword: ".NET" });
  assert.equal((await journal.findRecoverable())?.id, latest.id);
  await latest.settle("completed");
  assert.equal(await journal.findRecoverable(), undefined);
  await assert.rejects(latest.resume(), /不能继续/);
  mock.timers.tick(10);
  const superseded = await journal.create(runInput); await superseded.settle("superseded");
  assert.equal(await journal.findRecoverable(), undefined);
  await assert.rejects(superseded.resume(), /不能继续/);
  assert.equal(await createHarvestJournalAdapter(database.open(), "c".repeat(64)).findRecoverable(), undefined);
});

test("continuation is atomic, refuses a different running writer, and remains terminal after a failed transaction", async () => {
  const database = memoryDatabase();
  const journal = createHarvestJournalAdapter(database.open(), "a".repeat(64));
  const previous = await journal.create(runInput); await previous.settle("cancelled");
  const current = await journal.create(runInput);
  await assert.rejects(previous.resume(), /另一轮/);
  assert.equal((await previous.read()).run.state, "cancelled");
  await current.settle("needs-attention");
  database.failNext(new Error("synthetic resume transaction failure"));
  await assert.rejects(current.resume(), /未能保存/);
  assert.equal((await current.read()).run.state, "needs-attention");
  assert.equal(await journal.findResumable(), undefined);
  await current.resume(); await current.resume();
  assert.equal((await current.read()).run.state, "running");
});

test("equal wall-clock timestamps cannot make recovery fall back to an older cancelled run", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-28T00:00:00Z") });
  const ids: ReturnType<Crypto["randomUUID"]>[] = ["ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000000"];
  mock.method(globalThis.crypto, "randomUUID", () => ids.shift()!);
  const journal = createHarvestJournalAdapter(memoryDatabase().open(), "a".repeat(64));
  const older = await journal.create(runInput); await older.settle("cancelled");
  const latest = await journal.create(runInput); await latest.settle("completed");
  assert.equal(await journal.findRecoverable(), undefined);
});
