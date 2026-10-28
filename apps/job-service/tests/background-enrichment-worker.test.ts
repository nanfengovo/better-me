import assert from "node:assert/strict";
import test from "node:test";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";
import { emptyDelta, projectSourcePage } from "../src/projection.js";
import { reviewedCardsPage, reviewedCardsSource } from "../src/reviewed-cards.js";
import type { TrustedToolContext } from "@better-me/opportunities";
import { startBackgroundEnrichmentWorker } from "../src/background-enrichment-worker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const context = (signal = new AbortController().signal): TrustedToolContext => ({
  requestId: "synthetic-background-read", actorScope: "local-owner", allowedEffects: ["read-index"], signal,
  budget: { requests: 0, bytes: 1_000_000, timeoutMs: 5000 },
});

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let sequence = 0;
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      const id = ++sequence;
      timers.set(id, { at: now + delayMs, callback });
      return () => { timers.delete(id); };
    },
    async next() {
      const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) return false;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await new Promise<void>(resolve => setImmediate(resolve));
      return true;
    },
    pending: () => timers.size,
  };
}

test("slow background enrichment starts independently and does not block imports or queries", async () => {
  const repository = openJobRepository(":memory:");
  const release = deferred();
  let batches = 0;
  let workerSignal: AbortSignal | undefined;
  Object.assign(repository, {
    processEnrichmentBatch: async (options: { signal?: AbortSignal }) => {
      batches++;
      workerSignal = options.signal;
      await release.promise;
      return { processed: 0, completed: 0, failed: 0, changedJobs: 0, revision: 0,
        status: { revision: 0, pending: 0, running: 0, completed: 0, failed: 0 } };
    },
  });
  const application = createJobApplication({ repository });
  const searchAbort = new AbortController();
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(batches, 1, "service startup should consume pending work without a browser search request");
    searchAbort.abort();
    const cancelledSearch = await application.registry.execute("jobs.search", {}, context(searchAbort.signal));
    assert.equal(cancelledSearch.ok, false);
    assert.equal(workerSignal?.aborted, false, "search cancellation is not background cancellation");
    const query = await application.registry.execute("jobs.search", {}, context());
    assert.equal(query.ok, true, "a held background batch must not hold the query interface");
    const imported = await repository.importSnapshot(emptyDelta(), { actorScope: "local-owner", idempotencyKey: "synthetic-during-background" });
    assert.equal(imported.ok, true, "a held background batch must not hold ingestion");
  } finally {
    release.resolve();
    await application.shutdown();
    repository.close();
  }
});

test("starting twice for the same repository has one bounded writer", async () => {
  const clock = fakeClock(), release = deferred();
  let batches = 0;
  const repository = { processEnrichmentBatch: async () => {
    batches++;
    await release.promise;
    return { processed: 0, status: {} };
  } };
  const first = startBackgroundEnrichmentWorker(repository, clock);
  const second = startBackgroundEnrichmentWorker(repository, clock);
  try {
    await clock.next();
    await clock.next();
    assert.equal(batches, 1, "duplicate startup must not run a second batch beside the active one");
  } finally { release.resolve(); await Promise.all([first.stop(), second.stop()]); }
  assert.equal(clock.pending(), 0);
});

test("a busy queue yields between bounded batches and close waits for the active batch", async () => {
  const clock = fakeClock(), release = deferred();
  let batches = 0;
  let signal: AbortSignal | undefined;
  const worker = startBackgroundEnrichmentWorker({ processEnrichmentBatch: async options => {
    batches++;
    assert.equal(options?.limit, 3);
    signal = options?.signal;
    if (batches === 2) await release.promise;
    return { processed: 3, status: {} };
  } }, { ...clock, batchSize: 3 });
  await clock.next();
  assert.equal(batches, 1, "the next batch must wait for another scheduled turn");
  await clock.next();
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, "service shutdown cannot close storage before its current batch settles");
    assert.equal(signal?.aborted, true);
  } finally { release.resolve(); await stopping; }
  assert.equal(clock.pending(), 0);
  assert.deepEqual(worker.status(), { workerState: "stopped" });
});

test("worker failures are observable without private error text and retry on a later turn", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const worker = startBackgroundEnrichmentWorker({ processEnrichmentBatch() {
    if (++attempts === 1) throw new Error("private-path/synthetic.sqlite credential=never-expose");
    return Promise.resolve({ processed: 0, status: { nextRetryAt: new Date(5000).toISOString() } });
  } }, clock);
  try {
    await clock.next();
    assert.equal(worker.status().workerState, "error");
    assert.equal(worker.status().workerError, "后台补全暂不可用，将自动重试。");
    assert.equal(JSON.stringify(worker.status()).includes("synthetic.sqlite"), false);
    assert.equal(attempts, 1);
    await clock.next();
    assert.equal(clock.now(), 1000);
    assert.equal(worker.status().workerState, "idle");
    await clock.next();
    assert.equal(clock.now(), 5000, "a stored retry deadline avoids an immediate retry loop");
  } finally { await worker.stop(); }
});

test("a worker started after import drains the real SQLite outbox once without office coordinates", async () => {
  const at = "2026-10-28T00:00:00.000Z";
  const repository = openJobRepository(":memory:", { now: () => at });
  const pageUrl = "https://www.liepin.com/zhaopin/?key=Rust";
  const cardUrl = "https://www.liepin.com/job/1234567890.shtml";
  const capture: Parameters<typeof reviewedCardsPage>[0] = { provider: "liepin", pageUrl, capturedAt: at,
    cards: [{ platform: "猎聘", url: cardUrl, title: "Synthetic engineer", company: "Synthetic company", locationText: "上海",
      cardText: "Synthetic engineer Synthetic company 上海", evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
        { field: "url", selector: "a", text: cardUrl }, { field: "title", selector: ".title", text: "Synthetic engineer" },
        { field: "company", selector: ".company", text: "Synthetic company" }, { field: "locationText", selector: ".location", text: "上海" },
      ] } }],
  };
  const projection = await projectSourcePage(emptyDelta(), reviewedCardsSource("liepin"), reviewedCardsPage(capture), "synthetic-background-page");
  const receipt = await repository.importSnapshot(projection.delta, { actorScope: "local-owner", idempotencyKey: "synthetic-background-import" });
  assert.equal((await repository.getEnrichmentStatus()).pending, 1);
  const clock = fakeClock();
  const worker = startBackgroundEnrichmentWorker(repository, clock);
  try {
    await clock.next();
    const status = await repository.getEnrichmentStatus();
    assert.equal(status.pending, 0);
    assert.equal(status.completed, 1);
    assert.equal(status.revision, receipt.revision + 1);
    const snapshot = await repository.readSnapshot();
    assert.equal(snapshot.locations[0]?.raw, "上海");
    assert.equal(snapshot.locations[0]?.countryCode, "CN");
    assert.equal(snapshot.locations[0]?.city, "上海市");
    assert.equal(snapshot.locations[0]?.coordinates, undefined);
    assert.equal(snapshot.locations[0]?.userResolution, undefined);
    await clock.next();
    assert.equal((await repository.getEnrichmentStatus()).revision, status.revision, "finished work is not replayed at the next wake");
  } finally { await worker.stop(); repository.close(); }
});
