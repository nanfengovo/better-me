import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { OpportunityHarvestChainedClientPipeline } from "../src/components/atlas/harvest-pipeline";
import { LiveCardCommitQueue, type LiveCommitStats } from "../src/components/atlas/live-card-commit-queue";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";
import type { LiveBatchProviderResultClient } from "../src/lib/platform-search-client";

type Client = ReturnType<typeof createAtlasSourceClient>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function card(index = 1): LiveBatchProviderResultClient["cards"][number] {
  const url = `https://www.liepin.com/job/${100000 + index}.shtml`;
  const title = `C# engineer ${index}`;
  return { platform: "猎聘", url, title, company: "Synthetic Company", cardText: `${title} Synthetic Company`,
    evidence: { pageUrl: `https://www.liepin.com/zhaopin/?key=C%23&currentPage=${index - 1}`, cardSelector: ".job-card", fields: [
      { field: "url", selector: "a", text: url }, { field: "title", selector: ".title", text: title },
      { field: "company", selector: ".company", text: "Synthetic Company" },
    ] } };
}

function stream(cards: LiveBatchProviderResultClient["cards"]): Response {
  const coverage = { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: "exhausted" as const, partial: false };
  const result: LiveBatchProviderResultClient = { provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=C%23",
    status: cards.length ? "ready" : "empty", cards, rawCardCount: cards.length, warnings: [], coverage };
  return new Response([
    { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 },
    { type: "provider-progress", provider: "liepin", platform: "猎聘", pagesVisited: 1, scrollSteps: 0, cardsCaptured: cards.length, pageLimit: 5, scrollLimit: 0, cardLimit: 500, cards },
    { type: "provider-result", result },
    { type: "complete", capturedAt: "2026-10-27T00:00:00.000Z", providers: ["liepin"] },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

test("commits the first SSE card batch while a later keyword is still harvesting", async () => {
  const originalFetch = globalThis.fetch;
  const heldKeyword = deferred();
  const secondKeywordStarted = deferred();
  const firstCommitted = deferred();
  const data = createAtlasDemo();
  let imports = 0;
  let requests = 0;
  const client = {
    snapshot: async () => ({ ...data, revision: data.revision + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => {
      imports++;
      firstCommitted.resolve();
      return { revision: data.revision + imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } };
    },
  } as unknown as Client;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.action, "live-batch-search-stream");
    if (++requests === 2) {
      secondKeywordStarted.resolve();
      await heldKeyword.promise;
      return stream([]);
    }
    return stream([card()]);
  };
  const running = new OpportunityHarvestChainedClientPipeline({ client, keyword: "C#", depth: "quick", onLiveProgress() {} }).execute();
  try {
    await secondKeywordStarted.promise;
    // A bounded turn drain makes this a deterministic ordering assertion, not
    // a real network or wall-clock performance benchmark.
    await Promise.race([firstCommitted.promise, new Promise<void>((resolve) => setImmediate(resolve))]);
    assert.equal(imports, 1, "first captured batch must commit before the later keyword can finish");
  } finally {
    heldKeyword.resolve();
    await running;
    globalThis.fetch = originalFetch;
  }
  assert.equal(imports, 1, "progress, provider-result and final receipt must not import the same card again");
});

function capture(index: number) {
  return { provider: "liepin" as const, platform: "猎聘" as const, cards: [card(index)], capturedAt: "2026-10-27T00:00:00.000Z", cardLimit: 500 };
}

test("bounded admission waits for the single writer and never overlaps imports", async () => {
  const firstImportStarted = deferred();
  const releaseFirst = deferred();
  const data = createAtlasDemo();
  let imports = 0, active = 0, maxActive = 0;
  const progress: LiveCommitStats[] = [];
  const client = {
    snapshot: async () => ({ ...data, revision: data.revision + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      if (imports === 0) { firstImportStarted.resolve(); await releaseFirst.promise; }
      imports++;
      active--;
      return { revision: data.revision + imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } };
    },
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, maxPendingBatches: 2, onStats: stats => progress.push(stats) });
  await queue.enqueue(capture(1));
  await firstImportStarted.promise;
  await queue.enqueue(capture(2));
  let thirdAdmitted = false;
  const third = queue.enqueue(capture(3)).then(() => { thirdAdmitted = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { assert.equal(thirdAdmitted, false, "a full queue must backpressure the SSE consumer"); }
  finally { releaseFirst.resolve(); await third; }
  const result = await queue.finish();
  assert.equal(imports, 3);
  assert.equal(maxActive, 1);
  assert.ok(progress.every(stats => stats.pendingBatches <= 2));
  assert.equal(result.stats.pendingCards, 0);
  assert.equal(result.stats.committedCards, 3);
});

test("concurrent producers reserve capacity atomically", async () => {
  const firstImportStarted = deferred(), releaseFirst = deferred();
  const data = createAtlasDemo();
  let imports = 0;
  const progress: LiveCommitStats[] = [];
  const client = {
    snapshot: async () => ({ ...data, revision: data.revision + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => {
      if (!imports) { firstImportStarted.resolve(); await releaseFirst.promise; }
      return { revision: data.revision + ++imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } };
    },
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, maxPendingBatches: 2, onStats: stats => progress.push(stats) });
  const producers = Promise.all([queue.enqueue(capture(1)), queue.enqueue(capture(2)), queue.enqueue(capture(3))]);
  await firstImportStarted.promise;
  try { assert.ok(progress.every(stats => stats.pendingBatches <= 2), "simultaneous callers must not reserve the same free slot"); }
  finally { releaseFirst.resolve(); await producers; await queue.finish(); }
  assert.equal(imports, 3);
});

test("many evidence pages publish the first and final snapshots without downloading one per batch", async () => {
  const data = createAtlasDemo();
  let imports = 0, snapshotReads = 0;
  const published: Array<{ revision: number; cards: number }> = [];
  const client = {
    snapshot: async () => { snapshotReads++; return { ...data, revision: data.revision + imports }; },
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => ({ revision: data.revision + ++imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } }),
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, now: () => 1000, onSnapshot: (snapshot, stats) => published.push({ revision: snapshot.revision, cards: stats.committedCards }) });
  for (let index = 1; index <= 30; index++) await queue.enqueue(capture(index));
  const result = await queue.finish();
  assert.equal(imports, 30);
  assert.equal(snapshotReads, 3, "initial CAS snapshot + immediate first publication + authoritative final refresh");
  assert.deepEqual(published.map(value => value.cards), [1, 30]);
  assert.equal(result.snapshot?.revision, data.revision + 30);
});

test("cancelled admission and writer settle without starting pending imports", async () => {
  const abort = new AbortController();
  const firstImportStarted = deferred();
  const releaseFirst = deferred();
  const data = createAtlasDemo();
  let imports = 0;
  const progress: LiveCommitStats[] = [];
  const client = {
    snapshot: async () => data,
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => {
      imports++;
      firstImportStarted.resolve();
      await releaseFirst.promise;
      return { revision: data.revision + 1, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } };
    },
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, signal: abort.signal, maxPendingBatches: 2, onStats: stats => progress.push(stats) });
  await queue.enqueue(capture(1));
  await firstImportStarted.promise;
  await queue.enqueue(capture(2));
  const waitingAdmission = assert.rejects(queue.enqueue(capture(3)), /stop synthetic run/);
  abort.abort(new Error("stop synthetic run"));
  releaseFirst.resolve();
  await waitingAdmission;
  await assert.rejects(queue.finish(), /stop synthetic run/);
  assert.equal(imports, 1, "cancelled queued batches never reach import");
  assert.equal(progress.at(-1)?.committedCards, 1);
  assert.equal(progress.at(-1)?.cancelledCards, 2, "both queued and capacity-waiting cards remain accounted for");
  assert.equal(progress.at(-1)?.pendingCards, 0);
});

test("an in-flight publication does not block the writer or move CAS revision backwards", async () => {
  const snapshotStarted = deferred(), releaseSnapshot = deferred(), secondCommitted = deferred();
  const data = createAtlasDemo();
  let imports = 0, snapshotReads = 0, activeReads = 0, maxActiveReads = 0;
  const previews: number[] = [], published: number[] = [];
  const client = {
    snapshot: async () => {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      const revision = data.revision + imports;
      if (++snapshotReads === 2) { snapshotStarted.resolve(); await releaseSnapshot.promise; }
      activeReads--;
      return { ...data, revision };
    },
    previewReviewedCards: async (input: { expectedRevision: number }) => {
      previews.push(input.expectedRevision);
      return { expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" };
    },
    importReviewedCards: async () => {
      imports++;
      if (imports === 2) secondCommitted.resolve();
      return { revision: data.revision + imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } };
    },
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, onSnapshot: snapshot => published.push(snapshot.revision) });
  await queue.enqueue(capture(1));
  await snapshotStarted.promise;
  await queue.enqueue(capture(2));
  try {
    await Promise.race([secondCommitted.promise, new Promise<void>(resolve => setImmediate(resolve))]);
    assert.equal(imports, 2, "a slow full snapshot must not serialize the next import");
  } finally { releaseSnapshot.resolve(); await queue.finish(); }
  assert.deepEqual(previews, [data.revision, data.revision + 1]);
  assert.equal(maxActiveReads, 1);
  assert.deepEqual(published, [data.revision + 1, data.revision + 2]);
});

test("long-running collection publishes a throttled snapshot before queue finish", async () => {
  const firstPublished = deferred(), laterPublished = deferred();
  const data = createAtlasDemo();
  let imports = 0, snapshotReads = 0, now = 1000;
  const publications: number[] = [];
  const client = {
    snapshot: async () => { snapshotReads++; return { ...data, revision: data.revision + imports }; },
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => ({ revision: data.revision + ++imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } }),
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, now: () => now, onSnapshot: (_snapshot, stats) => {
    publications.push(stats.committedCards);
    if (stats.committedCards === 1) firstPublished.resolve();
    if (stats.committedCards === 3) laterPublished.resolve();
  } });
  await queue.enqueue(capture(1));
  await firstPublished.promise;
  now = 1200;
  await queue.enqueue(capture(2));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(snapshotReads, 2, "nearby commits share the throttle window");
  now = 3000;
  await queue.enqueue(capture(3));
  await laterPublished.promise;
  assert.deepEqual(publications, [1, 3], "map receives ongoing updates without waiting for completion");
  await queue.finish();
  assert.equal(snapshotReads, 3);
});

test("oversized or invalid evidence is an explicit failure rather than unbounded buffering", async () => {
  let imports = 0;
  const client = { importReviewedCards: async () => { imports++; } } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client, maxPendingBytes: 1 });
  await queue.enqueue(capture(1));
  await queue.enqueue(capture(1));
  const result = await queue.finish();
  assert.equal(imports, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.stats.failedCards, 1);
  assert.match(result.failures[0]!.error, /字节上限/);
});

test("a broken SSE tail preserves committed page cards and still reports incomplete harvesting", async () => {
  const originalFetch = globalThis.fetch;
  const data = createAtlasDemo();
  let imports = 0;
  const published: number[] = [];
  const client = {
    snapshot: async () => ({ ...data, revision: data.revision + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => ({ revision: data.revision + ++imports, jobIds: [], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } }),
  } as unknown as Client;
  globalThis.fetch = async () => {
    const complete = await stream([card(1), card(2)]).text();
    return new Response(complete.slice(0, complete.indexOf('data: {"type":"provider-result"')), { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    await assert.rejects(new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", depth: "quick", onLiveProgress() {},
      onCardsCommitted: (_snapshot, stats) => published.push(stats.totalAdded),
    }).execute(), /没有最终回执/);
    assert.equal(imports, 2);
    assert.deepEqual(published, [1, 2], "failure terminal drains already accepted pages and publishes their final authoritative view");
  } finally { globalThis.fetch = originalFetch; }
});

test("failed batches remain accounted for without replaying an ambiguous import", async () => {
  const data = createAtlasDemo();
  let attempts = 0;
  const client = {
    snapshot: async () => data,
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic" }),
    importReviewedCards: async () => { attempts++; throw new Error("synthetic connection lost after sending import"); },
  } as unknown as Client;
  const queue = new LiveCardCommitQueue({ client });
  await queue.enqueue(capture(1));
  await queue.enqueue(capture(1));
  const result = await queue.finish();
  assert.equal(attempts, 1, "transport ambiguity is not authority to replay with a new key");
  assert.equal(result.stats.failedCards, 1);
  assert.equal(result.stats.committedCards, 0);
  assert.equal(result.stats.pendingCards, 0);
  assert.equal(result.stats.cancelledCards, 0);
  assert.match(result.failures[0]!.error, /connection lost/);
});
