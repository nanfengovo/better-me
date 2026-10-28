import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDemo } from "../src/components/atlas/demo";
import type { HarvestBatchCheckpoint, HarvestCheckpoint, HarvestCheckpointSnapshot, HarvestImportReceipt, HarvestPreparedImport } from "../src/components/atlas/harvest-checkpoint";
import { LiveCardCommitQueue } from "../src/components/atlas/live-card-commit-queue";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";
import { createHarvestJournalAdapter, type JournalStorage, type JournalTable } from "../src/components/atlas/harvest-journal-store";

type Client = ReturnType<typeof createAtlasSourceClient>;
const capturedAt = "2026-10-28T00:00:00.000Z";

function batch(index = 1): HarvestBatchCheckpoint {
  const url = `https://www.liepin.com/job/${100000 + index}.shtml`;
  const pageUrl = `https://www.liepin.com/zhaopin/?key=Rust&currentPage=${index - 1}`;
  return { id: `captured-${index}`, provider: "liepin", platform: "猎聘", pageUrl, capturedAt, cards: [{
    platform: "猎聘", url, title: `Rust engineer ${index}`, company: "Synthetic Company", cardText: `Rust engineer ${index} Synthetic Company`,
    evidence: { pageUrl, cardSelector: ".job-card", fields: [
      { field: "url", selector: "a", text: url }, { field: "title", selector: ".title", text: `Rust engineer ${index}` },
      { field: "company", selector: ".company", text: "Synthetic Company" },
    ] },
  }] };
}

function receipt(revision = 2): HarvestImportReceipt {
  return { ok: true, revision, jobIds: ["synthetic-job"], snapshotIds: ["synthetic-snapshot"], counts: {
    newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1,
  } };
}

function command(value = batch()): HarvestPreparedImport {
  return { input: { provider: value.provider, pageUrl: value.pageUrl, capturedAt: value.capturedAt, cards: value.cards,
    expectedRevision: 1, previewFingerprint: "synthetic-fingerprint", reviewed: true }, idempotencyKey: "persisted-same-key" };
}

function checkpoint(batches: HarvestBatchCheckpoint[] = []) {
  const state: HarvestCheckpointSnapshot = { run: { schemaVersion: 1, id: "synthetic-run", scope: "synthetic-scope", state: "running",
    input: { keyword: "Rust", depth: "quick", view: { mode: "global", country: "", region: "", regionText: "" } }, createdAt: capturedAt, updatedAt: capturedAt }, batches: structuredClone(batches), providers: [] };
  const events: string[] = [];
  const journal: HarvestCheckpoint = {
    id: state.run.id, read: async () => structuredClone(state), resume: async () => { state.run.state = "running"; },
    initialize: async () => {},
    capture: async value => { events.push("capture"); state.batches.push(structuredClone(value)); },
    prepare: async (id, value) => { events.push("prepare"); state.batches.find(value => value.id === id)!.command = structuredClone(value); },
    confirm: async (id, value) => { events.push("confirm"); state.batches.find(value => value.id === id)!.receipt = structuredClone(value); },
    recordProvider: async () => {}, settle: async () => {},
  };
  return { state, events, journal };
}

function client(events: string[] = []) {
  const snapshot = createAtlasDemo();
  let imports = 0;
  const service = {
    snapshot: async () => ({ ...snapshot, revision: 2 + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => { events.push("preview"); return { expectedRevision: input.expectedRevision, previewFingerprint: "new-preview" }; },
    importReviewedCards: async () => { events.push("import"); imports++; return receipt(2 + imports); },
  } as unknown as Client;
  return { service, imports: () => imports };
}

test("captured batches resume preview and persist the exact command before import", async () => {
  const stored = checkpoint([batch()]);
  const service = client(stored.events);
  const queue = new LiveCardCommitQueue({ client: service.service, checkpoint: stored.journal });
  await queue.restore(stored.state.batches);
  const result = await queue.finish();
  assert.deepEqual(stored.events.filter(value => value !== "snapshot"), ["preview", "prepare", "import", "confirm"]);
  assert.equal(stored.state.batches.length, 1, "recovery must not recapture the same evidence");
  assert.deepEqual(stored.state.batches[0]!.command!.input.cards, batch().cards);
  assert.equal(result.stats.committedCards, 1);
});

test("receipt-lost prepared commands replay the identical key/body before any preview", async () => {
  const prepared = { ...batch(), command: command() };
  const stored = checkpoint([prepared]);
  let previews = 0, imports = 0;
  const service = client().service;
  service.previewReviewedCards = async () => { previews++; throw new Error("must not re-preview an ambiguous command"); };
  service.importReviewedCards = async (input, options) => {
    imports++;
    assert.deepEqual(input, prepared.command.input);
    assert.equal(options.idempotencyKey, prepared.command.idempotencyKey);
    return receipt(); // Server cached success, even though current CAS has moved.
  };
  const queue = new LiveCardCommitQueue({ client: service, checkpoint: stored.journal });
  await queue.restore(stored.state.batches);
  const result = await queue.finish();
  assert.equal(previews, 0);
  assert.equal(imports, 1);
  assert.equal(result.stats.totalAdded, 1);
  assert.deepEqual(stored.state.batches[0]!.receipt, receipt());
});

test("confirmed batches seed counters and identities but never replay HTTP writes", async () => {
  const confirmed = { ...batch(), command: command(), receipt: receipt() };
  const stored = checkpoint([confirmed]);
  const service = client(stored.events);
  const queue = new LiveCardCommitQueue({ client: service.service, checkpoint: stored.journal });
  await queue.restore(stored.state.batches);
  await queue.enqueue({ ...batch(), cardLimit: 500 });
  const result = await queue.finish();
  assert.equal(service.imports(), 0);
  assert.deepEqual(stored.events, []);
  assert.equal(result.stats.committedCards, 1);
  assert.equal(result.stats.totalAdded, 1);
  assert.equal(result.touchedJobIds.has("synthetic-job"), true);
  assert.ok(result.snapshot && result.snapshot.revision >= 2);
});

test("capture and prepare durability precede network writes and confirmation", async () => {
  const stored = checkpoint();
  const service = client(stored.events);
  const queue = new LiveCardCommitQueue({ client: service.service, checkpoint: stored.journal });
  await queue.enqueue({ ...batch(), cardLimit: 500 });
  await queue.finish();
  assert.deepEqual(stored.events, ["capture", "preview", "prepare", "import", "confirm"]);
});

test("checkpoint prepare failure stops this writer before import and rejects its drain", async () => {
  const stored = checkpoint();
  stored.journal.prepare = async () => { throw new Error("synthetic quota exhausted"); };
  const service = client();
  const queue = new LiveCardCommitQueue({ client: service.service, checkpoint: stored.journal });
  await queue.enqueue({ ...batch(), cardLimit: 500 });
  await assert.rejects(queue.finish(), /检查点.*synthetic quota exhausted/);
  assert.equal(service.imports(), 0);
  await assert.rejects(queue.enqueue({ ...batch(2), cardLimit: 500 }), /检查点/);
});

test("transport ambiguity preserves its prepared command and is not retried in this run", async () => {
  const prepared = { ...batch(), command: command() };
  const stored = checkpoint([prepared]);
  const service = client().service;
  let imports = 0, previews = 0;
  service.previewReviewedCards = async () => { previews++; throw new Error("no preview"); };
  service.importReviewedCards = async () => { imports++; throw new Error("synthetic response lost"); };
  const queue = new LiveCardCommitQueue({ client: service, checkpoint: stored.journal });
  await queue.restore(stored.state.batches);
  const result = await queue.finish();
  assert.equal(imports, 1);
  assert.equal(previews, 0);
  assert.deepEqual(stored.state.batches[0]!.command, prepared.command);
  assert.equal(stored.state.batches[0]!.receipt, undefined);
  assert.equal(result.failures.length, 1);
  assert.equal(result.stats.failedCards, 1);
});

test("only definite stale-version permits replacing a prepared key and preview", async () => {
  const prepared = { ...batch(), command: command() };
  const stored = checkpoint([prepared]);
  const service = client(stored.events).service;
  const keys: string[] = [];
  service.snapshot = async () => ({ ...createAtlasDemo(), revision: keys.length > 1 ? 3 : 2 });
  service.importReviewedCards = async (input, options) => {
    keys.push(options.idempotencyKey);
    if (keys.length === 1) throw Object.assign(new Error("synthetic stale"), { code: "stale-version" });
    assert.equal(input.previewFingerprint, "new-preview");
    assert.deepEqual(input.cards, prepared.command.input.cards);
    return receipt(3);
  };
  const queue = new LiveCardCommitQueue({ client: service, checkpoint: stored.journal });
  await queue.restore(stored.state.batches);
  await queue.finish();
  assert.equal(keys[0], prepared.command.idempotencyKey);
  assert.notEqual(keys[1], keys[0]);
  assert.deepEqual(stored.events, ["preview", "prepare", "confirm"]);
});

test("a failed durable confirmation leaves the same command recoverable after service success", async () => {
  const stored = checkpoint();
  const originalConfirm = stored.journal.confirm;
  stored.journal.confirm = async () => { throw new Error("synthetic confirmation quota"); };
  const service = client().service;
  const commands: HarvestPreparedImport[] = [];
  let physicalWrites = 0;
  const receipts = new Map<string, HarvestImportReceipt>();
  service.importReviewedCards = async (input, options) => {
    commands.push(structuredClone({ input, idempotencyKey: options.idempotencyKey }));
    if (!receipts.has(options.idempotencyKey)) { physicalWrites++; receipts.set(options.idempotencyKey, receipt()); }
    return receipts.get(options.idempotencyKey)!;
  };
  const original = new LiveCardCommitQueue({ client: service, checkpoint: stored.journal });
  await original.enqueue({ ...batch(), cardLimit: 500 });
  await assert.rejects(original.finish(), /检查点.*synthetic confirmation quota/);
  assert.equal(stored.state.batches[0]!.receipt, undefined);
  stored.journal.confirm = originalConfirm;
  const recovered = new LiveCardCommitQueue({ client: service, checkpoint: stored.journal });
  await recovered.restore(stored.state.batches);
  const result = await recovered.finish();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(physicalWrites, 1);
  assert.equal(result.stats.committedCards, 1);
});

test("the production journal accepts canonical queue commands and confirmed batches survive reopen", async () => {
  let tables: Record<JournalTable, Map<string, { id: string }>> = { runs: new Map(), batches: new Map(), providers: new Map() };
  let tail = Promise.resolve();
  const open = (): JournalStorage => ({ close() {}, transaction(mode, work) {
    const task = tail.then(async () => {
      const copy = structuredClone(tables);
      const result = await work({
        async get(table, id) { return structuredClone(copy[table].get(id)); },
        async list(table, filter) { return structuredClone([...copy[table].values()].filter(row => !filter || Reflect.get(row, filter.index) === filter.value)); },
        async put(table, row) { copy[table].set(row.id, structuredClone(row)); },
        async delete(table, id) { copy[table].delete(id); },
      });
      if (mode === "readwrite") tables = copy;
      return result;
    });
    tail = task.then(() => {}, () => {});
    return task;
  } });
  const journal = createHarvestJournalAdapter(open(), "a".repeat(64));
  const checkpoint = await journal.create({ keyword: "Rust", depth: "quick", view: { mode: "global", country: "", region: "", regionText: "" } });
  await checkpoint.initialize(["Rust"], ["liepin"]);
  const service = client();
  service.service.previewReviewedCards = async input => ({ expectedRevision: input.expectedRevision, previewFingerprint: "b".repeat(64) }) as Awaited<ReturnType<Client["previewReviewedCards"]>>;
  const queue = new LiveCardCommitQueue({ client: service.service, checkpoint });
  await queue.enqueue({ ...batch(), cardLimit: 500 });
  await queue.finish();
  const persisted = await checkpoint.read();
  assert.equal(persisted.batches.length, 1);
  assert.equal(persisted.batches[0]!.receipt?.counts.newJobs, 1);
  journal.close();
  const reopened = createHarvestJournalAdapter(open(), "a".repeat(64));
  const resumed = await reopened.findResumable();
  assert.ok(resumed);
  const restored = new LiveCardCommitQueue({ client: service.service, checkpoint: resumed });
  await restored.restore((await resumed.read()).batches);
  assert.equal((await restored.finish()).stats.committedCards, 1);
  assert.equal(service.imports(), 1);
});
