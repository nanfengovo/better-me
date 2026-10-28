import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { OpportunityHarvestChainedClientPipeline, type ClientPipelineProgress } from "../src/components/atlas/harvest-pipeline";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";
import type { LiveBatchSearchReceipt } from "../src/lib/platform-search-client";

const capturedAt = "2026-10-26T00:00:00.000Z";
type SourceClient = ReturnType<typeof createAtlasSourceClient>;

function liveReceipt(): LiveBatchSearchReceipt {
  const cards = [1, 2].map((page) => ({
    platform: "猎聘" as const,
    url: `https://www.liepin.com/job/${100000 + page}.shtml`,
    title: `Rust engineer ${page}`,
    company: "Synthetic Company",
    cardText: `Rust engineer ${page} Synthetic Company`,
    evidence: {
      pageUrl: `https://www.liepin.com/zhaopin/?key=Rust&currentPage=${page - 1}`,
      cardSelector: ".job-card",
      fields: [
        { field: "title" as const, selector: ".title", text: `Rust engineer ${page}` },
        { field: "company" as const, selector: ".company", text: "Synthetic Company" },
        { field: "url" as const, selector: "a", text: `https://www.liepin.com/job/${100000 + page}.shtml` },
      ],
    },
  }));
  return {
    capturedAt,
    results: [{
      provider: "liepin", platform: "猎聘", pageUrl: cards[0]!.evidence.pageUrl,
      status: "ready", cards, rawCardCount: cards.length, warnings: [],
      coverage: { pagesVisited: 2, scrollSteps: 0, scrollLimit: 0, pageLimit: 5,
        cardLimit: 500, stopReason: "page_limit", partial: true },
    }],
  };
}

test("final harvest summary preserves added and updated counts from all committed evidence pages", async () => {
  const initial = createAtlasDemo();
  initial.jobs = initial.jobs.slice(0, 1).map((job) => ({ ...job, workMode: "remote" }));
  const refreshed = createAtlasDemo();
  refreshed.jobs = refreshed.jobs.slice(0, 2).map((job) => ({ ...job, workMode: "remote" }));
  refreshed.revision = initial.revision + 2;
  let commits = 0;
  const progress: ClientPipelineProgress[] = [];
  const client = {
    snapshot: async () => refreshed,
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic-preview" }),
    importReviewedCards: async () => {
      commits++;
      return { revision: initial.revision + commits, jobIds: [commits === 1 ? "demo-1" : "demo-0"],
        counts: { newJobs: commits === 1 ? 1 : 0, updatedJobs: commits === 2 ? 1 : 0 } };
    },
  } as unknown as ReturnType<typeof createAtlasSourceClient>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json(request.action === "live-batch-search" ? liveReceipt() : { results: {} });
  };
  try {
    const summary = await new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", initialSnapshot: initial, depth: "quick" })
      .onProgress(event => progress.push(event)).execute();
    assert.equal(commits, 2);
    assert.equal(summary.totalCardsFetched, 2);
    assert.equal(summary.totalAdded, 1);
    assert.equal(summary.totalUpdated, 1);
    assert.equal(summary.snapshot?.revision, refreshed.revision);
    assert.equal(progress.some(event => event.stage === "enterprise-intelligence"), true);
    assert.equal(progress.at(-1)?.stats?.enrichmentSkipped, undefined, "normal enrichment is not marked skipped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("first and final publications preserve cumulative added and updated counts before enrichment", async () => {
  const initial = createAtlasDemo();
  let commits = 0;
  const published: Array<{ totalAdded: number; totalUpdated: number }> = [];
  const client = {
    snapshot: async () => ({ ...initial, revision: initial.revision + commits }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic-preview" }),
    importReviewedCards: async () => {
      commits++;
      return { revision: initial.revision + commits, jobIds: [],
        counts: { newJobs: commits === 1 ? 1 : 0, updatedJobs: commits === 2 ? 1 : 0 } };
    },
  } as unknown as SourceClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(liveReceipt());
  try {
    const pipeline = new OpportunityHarvestChainedClientPipeline({
      client, keyword: "Rust", initialSnapshot: initial, depth: "quick",
      onCardsCommitted: (_snapshot, stats) => { published.push({ ...stats }); },
    });
    await pipeline.stage2_HarvestLivePlatforms();
    await pipeline.stage3_CommitReviewedCards();
    assert.equal(commits, 2);
    assert.deepEqual(published, [
      { totalAdded: 1, totalUpdated: 0 },
      { totalAdded: 1, totalUpdated: 1 },
    ], "the UI receives a first view and an authoritative final cumulative view before stage 4 starts");
  } finally { globalThis.fetch = originalFetch; }
});

for (const recover of [true, false]) test(recover
  ? "a failed post-commit snapshot is refreshed to the final CAS revision before enrichment"
  : "persistent post-commit snapshot failures preserve committed totals and block enrichment without retrying imports", async () => {
  const initial = createAtlasDemo();
  let commits = 0;
  let snapshotReads = 0;
  const progress: ClientPipelineProgress[] = [];
  const client = {
    snapshot: async () => {
      snapshotReads++;
      if (commits === 2 && (!recover || snapshotReads === 3)) {
        throw new Error("Synthetic snapshot response unavailable after successful commit");
      }
      return { ...initial, revision: initial.revision + commits };
    },
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic-preview" }),
    importReviewedCards: async () => {
      commits++;
      return { revision: initial.revision + commits, jobIds: [`synthetic-refresh-job-${commits}`],
        counts: { newJobs: commits === 1 ? 1 : 0, updatedJobs: commits === 2 ? 1 : 0 } };
    },
  } as unknown as SourceClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json(request.action === "live-batch-search" ? liveReceipt() : { results: {} });
  };
  try {
    const pipeline = new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", initialSnapshot: initial, depth: "quick" })
      .onProgress(event => { progress.push(event); });
    if (recover) {
      const summary = await pipeline.execute();
      assert.equal(summary.snapshot?.revision, initial.revision + 2,
        "enrichment must receive a fresh snapshot covering both successful CAS receipts");
      assert.equal(summary.totalAdded, 1);
      assert.equal(summary.totalUpdated, 1);
      assert.equal(summary.importFailures.length, 0, "a snapshot read failure is not a failed card import");
    } else {
      await assert.rejects(pipeline.execute(), /岗位已提交，但索引快照刷新失败/);
      assert.equal(progress.some(event => event.stage === "enterprise-intelligence" || event.stage === "spatial-geocoding"), false,
        "a stale snapshot must never enter administrative or company enrichment");
    }
    assert.equal(commits, 2, "snapshot recovery never replays a successful import");
    assert.equal(snapshotReads, 4, "the incomplete post-commit snapshot is followed by one authoritative final refresh");
    const committedProgress = progress.filter(event => event.stage === "cas-ingestion" && typeof event.stats?.totalAdded === "number").at(-1);
    assert.equal(committedProgress?.stats?.totalAdded, 1);
    assert.equal(committedProgress?.stats?.totalUpdated, 1,
      "successful receipt totals remain observable even when final snapshot refresh fails");
  } finally { globalThis.fetch = originalFetch; }
});

test("publishes completed keyword cards before waiting for subsequent synonym searches", async () => {
  const published: number[] = [];
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 2) assert.deepEqual(published, [2]);
    return Response.json(liveReceipt());
  };
  try {
    await new OpportunityHarvestChainedClientPipeline({
      client: {} as SourceClient, keyword: "C#", depth: "quick",
      onLiveResults: (receipt) => { published.push(receipt.results[0]!.cards.length); },
    }).stage2_HarvestLivePlatforms();
    assert.equal(requests, 2);
    assert.ok(published.length >= 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("harvest can finish with a current snapshot without starting separate enrichment", async () => {
  const initial = createAtlasDemo();
  let commits = 0, enrichmentRequests = 0;
  const progress: ClientPipelineProgress[] = [];
  const client = {
    snapshot: async () => ({ ...initial, revision: initial.revision + commits }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic-preview" }),
    importReviewedCards: async () => ({ revision: initial.revision + ++commits, jobIds: ["demo-0"], counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0 } }),
  } as unknown as SourceClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.action === "live-batch-search") return Response.json(liveReceipt());
    enrichmentRequests++;
    return Response.json({ results: {} });
  };
  try {
    const summary = await new OpportunityHarvestChainedClientPipeline({ client, keyword: "Rust", depth: "quick", enrichAfterCommit: false })
      .onProgress(event => progress.push(event)).execute();
    assert.equal(enrichmentRequests, 0, "capture completion must not wait for enterprise lookup");
    assert.equal(progress.some(event => event.stage === "enterprise-intelligence" || event.stage === "spatial-geocoding"), false);
    assert.equal(summary.snapshot?.revision, initial.revision + commits);
    assert.equal(summary.totalAdded, 2);
    assert.equal(summary.locationsConfirmed, 0);
    assert.equal(summary.companiesClassified, 0);
    assert.match(progress.at(-1)!.message, /另行补全/);
    assert.equal(progress.at(-1)?.stats?.enrichmentSkipped, 1, "completion must not imply that skipped enrichment ran");
  } finally { globalThis.fetch = originalFetch; }
});
