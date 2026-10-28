import assert from "node:assert/strict";
import test from "node:test";
import type { ToolHandlerContext } from "@better-me/opportunities";
import { openJobRepository } from "../../job-service/src/repository";
import { createReviewedCardsTools, reviewedCardsSource } from "../../job-service/src/reviewed-cards";
import { emptyDelta } from "../../job-service/src/projection";
import { OpportunityHarvestChainedClientPipeline } from "../src/components/atlas/harvest-pipeline";
import { AtlasSourceServiceError, type createAtlasSourceClient } from "../src/components/atlas/service-client";
import type { LiveBatchSearchReceipt } from "../src/lib/platform-search-client";

type Client = ReturnType<typeof createAtlasSourceClient>;
const AT = "2026-10-26T00:00:00.000Z";

function liveReceipt(count = 1): LiveBatchSearchReceipt {
  const cards = Array.from({ length: count }, (_, index) => {
    const url = `https://www.liepin.com/job/${100001 + index}.shtml`;
    const title = `Rust engineer ${index + 1}`;
    const company = "Synthetic CAS Company";
    const pageUrl = `https://www.liepin.com/zhaopin/?key=Rust&curPage=${index}`;
    return { platform: "猎聘" as const, url, title, company, cardText: `${title} ${company}`,
      evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
        { field: "url" as const, selector: "a", text: url },
        { field: "title" as const, selector: ".title", text: title },
        { field: "company" as const, selector: ".company", text: company },
      ] } };
  });
  return { capturedAt: AT, results: [{
    provider: "liepin", platform: "猎聘", pageUrl: cards[0]!.evidence.pageUrl,
    status: "ready", cards, rawCardCount: cards.length, warnings: [],
    coverage: { pagesVisited: count, pageLimit: 5, scrollSteps: 0, scrollLimit: 0,
      cardLimit: 500, stopReason: "exhausted", partial: false },
  }] };
}

async function withLiveReceipt<T>(work: () => Promise<T>, count = 1): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(body.action === "live-batch-search" ? liveReceipt(count) : { results: {} });
  };
  try { return await work(); } finally { globalThis.fetch = originalFetch; }
}

test("stage 3 refreshes an obsolete initial snapshot before the first preview", async () => {
  let revision = 8;
  let previews = 0;
  const client = {
    snapshot: async () => emptyDelta(revision),
    previewReviewedCards: async (input: { expectedRevision: number }) => {
      previews++;
      if (input.expectedRevision !== revision) throw new AtlasSourceServiceError("stale-version", "stale-version");
      return { expectedRevision: revision, previewFingerprint: "synthetic" };
    },
    importReviewedCards: async () => ({ revision: ++revision, jobIds: ["synthetic-job"], counts: { newJobs: 1, updatedJobs: 0 } }),
  } as unknown as Client;
  const summary = await withLiveReceipt(() => new OpportunityHarvestChainedClientPipeline({
    client, keyword: "Rust", initialSnapshot: emptyDelta(7), depth: "quick",
  }).execute());
  assert.equal(previews, 1);
  assert.equal(summary.totalAdded, 1);
  assert.equal(summary.importFailures.length, 0);
  assert.equal(summary.snapshot?.revision, 9);
});

function context(key: string): ToolHandlerContext {
  return { requestId: key, actorScope: "synthetic-cas-race", idempotencyKey: key,
    signal: new AbortController().signal,
    budget: { requests: 0, bytes: 2_000_000, timeoutMs: 10_000 },
    consumeRequests() { throw new Error("No external reads allowed."); }, consumeBytes() {}, throwIfCancelled() {},
  };
}

test("a real repository CAS race re-previews the same chunk and counts its successful commit once", async () => {
  const repo = openJobRepository(":memory:", { now: () => AT });
  const tools = createReviewedCardsTools({ repository: repo, now: () => AT });
  let importAttempts = 0;
  const previewRevisions: number[] = [];
  const importKeys: string[] = [];
  const client = {
    snapshot: () => repo.readSnapshot(),
    previewReviewedCards: async (input: Parameters<Client["previewReviewedCards"]>[0]) => {
      previewRevisions.push(input.expectedRevision);
      return tools[0].execute(input, context(`preview-${previewRevisions.length}`));
    },
    importReviewedCards: async (input: Parameters<Client["importReviewedCards"]>[0], options: { idempotencyKey: string }) => {
      importAttempts++;
      importKeys.push(options.idempotencyKey);
      if (importAttempts === 1) await repo.registerSource(reviewedCardsSource("boss"), { actorScope: "synthetic-concurrent-sync", idempotencyKey: "other-source-sync" });
      return tools[1].execute(input, context(options.idempotencyKey));
    },
  } as unknown as Client;
  try {
    const summary = await withLiveReceipt(() => new OpportunityHarvestChainedClientPipeline({
      client, keyword: "Rust", initialSnapshot: emptyDelta(), depth: "quick",
    }).execute());
    assert.deepEqual(previewRevisions, [0, 1]);
    assert.equal(importAttempts, 2);
    assert.equal(new Set(importKeys).size, 2, "a changed preview/revision gets a fresh idempotency key");
    assert.equal(summary.totalAdded, 1);
    assert.equal(summary.totalUpdated, 0);
    assert.equal(summary.importFailures.length, 0);
    const saved = await repo.readSnapshot();
    assert.equal(saved.jobs.length, 1);
    assert.equal(saved.listings.length, 1);
    assert.equal(saved.observations.length, 1);
  } finally { repo.close(); }
});

test("stale-version retries are bounded to three attempts and preserve the failed chunk receipt", async () => {
  const attempts = [0, 0];
  let revision = 0;
  const client = {
    snapshot: async () => emptyDelta(revision),
    previewReviewedCards: async (input: { pageUrl: string; expectedRevision: number }) => {
      const index = input.pageUrl.endsWith("curPage=0") ? 0 : 1;
      attempts[index]!++;
      if (index === 0) { revision++; throw new AtlasSourceServiceError("stale-version", "concurrent write: stale-version"); }
      return { expectedRevision: revision, previewFingerprint: "synthetic" };
    },
    importReviewedCards: async () => ({ revision: ++revision, jobIds: ["synthetic-second-job"], counts: { newJobs: 1, updatedJobs: 0 } }),
  } as unknown as Client;
  const summary = await withLiveReceipt(() => new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", depth: "quick" }).execute(), 2);
  assert.deepEqual(attempts, [3, 1]);
  assert.equal(summary.totalAdded, 1);
  assert.equal(summary.importFailures.length, 1);
  assert.equal(summary.importFailures[0]!.cards, 1);
  assert.match(summary.importFailures[0]!.pageUrl, /curPage=0$/);
  assert.match(summary.importFailures[0]!.error, /stale-version/);
});

test("non-CAS errors are not retried and remain explicit import failures", async () => {
  let previews = 0;
  const client = {
    snapshot: async () => emptyDelta(),
    previewReviewedCards: async () => { previews++; throw new AtlasSourceServiceError("invalid-input", "invalid-input: evidence missing"); },
  } as unknown as Client;
  const summary = await withLiveReceipt(() => new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", depth: "quick" }).execute());
  assert.equal(previews, 1);
  assert.equal(summary.totalAdded, 0);
  assert.equal(summary.importFailures.length, 1);
  assert.match(summary.importFailures[0]!.error, /evidence missing/);
});

test("failed synonym warnings retain the real error without changing queried-term counts", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let finalReceipt: LiveBatchSearchReceipt | undefined;
  globalThis.fetch = async () => ++requests === 1
    ? Response.json({ error: "HTTP 422: invalid-search-scope" }, { status: 422 })
    : Response.json(liveReceipt());
  try {
    await new OpportunityHarvestChainedClientPipeline({ client: {} as Client, keyword: "C#", depth: "quick",
      onLiveResults: receipt => { finalReceipt = receipt; },
    }).stage2_HarvestLivePlatforms();
    assert.equal(requests, 2);
    const warnings = finalReceipt!.results[0]!.warnings.join("\n");
    assert.match(warnings, /2 个技术词/);
    assert.match(warnings, /未完成实时读取：C#/);
    assert.match(warnings, /C#.*HTTP 422: invalid-search-scope/);
  } finally { globalThis.fetch = originalFetch; }
});

test("all failed synonym searches expose their individual error details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ error: `${body.input.keyword}: synthetic provider unavailable` }, { status: 503 });
  };
  try {
    await assert.rejects(new OpportunityHarvestChainedClientPipeline({ client: {} as Client, keyword: "C#", depth: "quick" }).stage2_HarvestLivePlatforms(),
      /C#.*synthetic provider unavailable.*\.NET.*synthetic provider unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});
