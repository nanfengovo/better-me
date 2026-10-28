import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeLiveBatchSearchReceipts,
  OpportunityHarvestChainedClientPipeline,
} from "../src/components/atlas/harvest-pipeline";
import type { LiveBatchSearchReceipt } from "../src/lib/platform-search-client";

function receipt(keyword: string, cards: LiveBatchSearchReceipt["results"][number]["cards"], stopReason: "exhausted" | "page_limit" = "exhausted"): LiveBatchSearchReceipt {
  return {
    capturedAt: `2026-10-26T00:00:0${keyword.length}Z`,
    results: [{
      provider: "51job",
      platform: "51JOB",
      pageUrl: `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword)}`,
      status: "ready",
      cards,
      rawCardCount: cards.length,
      warnings: [],
      coverage: {
        pagesVisited: 2,
        scrollSteps: 0,
        scrollLimit: 0,
        pageLimit: 15,
        cardLimit: 3,
        stopReason,
        partial: stopReason !== "exhausted",
      },
    }],
  };
}

function card(id: string) {
  return {
    url: `https://jobs.51job.com/shanghai/${id}.html`,
    platform: "51JOB" as const,
    title: `C# 岗位 ${id}`,
    company: `公司 ${id}`,
    cardText: `C# 岗位 ${id} 公司 ${id} 上海`,
    evidence: {
      pageUrl: `https://we.51job.com/pc/search?keyword=${id}`,
      cardSelector: ".joblist-item",
      fields: [
        { field: "url" as const, selector: "a", text: `https://jobs.51job.com/shanghai/${id}.html` },
        { field: "title" as const, selector: ".jobname", text: `C# 岗位 ${id}` },
        { field: "company" as const, selector: ".company", text: `公司 ${id}` },
      ],
    },
  };
}

test("merging synonym captures deduplicates cards and sums per-query coverage", () => {
  const merged = mergeLiveBatchSearchReceipts(
    [
      receipt("C#", [card("1"), card("2")]),
      receipt(".NET", [card("2"), card("3")], "page_limit"),
    ],
    ["C#", ".NET"],
  );

  const result = merged.results[0]!;
  assert.equal(result.cards.length, 3);
  assert.equal(result.rawCardCount, 4);
  assert.equal(result.coverage.pagesVisited, 4);
  assert.equal(result.coverage.pageLimit, 30);
  assert.equal(result.coverage.stopReason, "page_limit");
  assert.equal(result.coverage.partial, true);
  assert.ok(result.warnings.some((warning) => warning.includes("C#、.NET")));
});

test("merged card budget is explicit instead of returning an oversized result", () => {
  const merged = mergeLiveBatchSearchReceipts(
    [receipt("C#", [card("1"), card("2"), card("3")]), receipt(".NET", [card("4")])],
    ["C#", ".NET"],
  );
  const result = merged.results[0]!;
  assert.equal(result.cards.length, 3);
  assert.equal(result.coverage.stopReason, "card_limit");
  assert.equal(result.coverage.partial, true);
});

test("pipeline uses the SSE route and publishes platform progress before the next synonym starts", async () => {
  const observed: string[] = [];
  const originalFetch = globalThis.fetch;
  const cardData = card("streamed");
  const result = {
    provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=C%23",
    status: "ready", cards: [{ ...cardData, platform: "猎聘", company: "公司 streamed" }], rawCardCount: 1, warnings: [],
    coverage: { pagesVisited: 1, scrollSteps: 0, scrollLimit: 0, pageLimit: 5, cardLimit: 500, stopReason: "exhausted", partial: false },
  };
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.action, "live-batch-search-stream");
    if (calls === 2) assert.ok(observed.includes("provider-result"), "first platform cards should arrive before the next keyword request");
    const pageLimit = 5, scrollLimit = 0, cardLimit = 500;
    const events = [
      { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit, scrollLimit, cardLimit },
      { type: "provider-start", provider: "liepin", platform: "猎聘", pageLimit, scrollLimit, cardLimit },
      { type: "provider-progress", provider: "liepin", platform: "猎聘", pagesVisited: 1, scrollSteps: 0, cardsCaptured: 1, pageLimit, scrollLimit, cardLimit },
      { type: "provider-result", result },
      { type: "complete", capturedAt: "2026-10-26T00:00:00.000Z", providers: ["liepin"] },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const pipeline = new OpportunityHarvestChainedClientPipeline({
      client: {} as never,
      keyword: "C#",
      depth: "quick",
      onLiveProgress: event => observed.push(event.type),
    });
    await pipeline.stage2_HarvestLivePlatforms();
    assert.equal(calls, 2);
    assert.ok(observed.includes("provider-progress"));
    assert.ok(observed.includes("provider-result"));
  } finally { globalThis.fetch = originalFetch; }
});

test("pipeline ends with explicit partial coverage when platforms return failures or login gates", async () => {
  const originalFetch = globalThis.fetch;
  const providers = [
    { provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=C%23", status: "error", stopReason: "error", error: "Synthetic Liepin failure" },
    { provider: "51job", platform: "51JOB", pageUrl: "https://we.51job.com/pc/search?keyword=C%23", status: "error", stopReason: "error", error: "Synthetic 51JOB failure" },
    { provider: "boss", platform: "BOSS直聘", pageUrl: "https://www.zhipin.com/web/geek/job?query=C%23", status: "login_required", stopReason: "gate" },
    { provider: "linkedin", platform: "LinkedIn", pageUrl: "https://www.linkedin.com/jobs/search/?keywords=C%23", status: "error", stopReason: "error", error: "Synthetic LinkedIn failure" },
  ] as const;
  const progress: Array<{ message: string; stats?: Record<string, number | string> }> = [];
  globalThis.fetch = async () => {
    const events: Array<Record<string, unknown>> = [];
    for (const entry of providers) {
      const pageLimit = 5, scrollLimit = entry.provider === "boss" ? 80 : 0, cardLimit = 500;
      events.push({ type: "provider-queued", provider: entry.provider, platform: entry.platform, pageLimit, scrollLimit, cardLimit });
      events.push({ type: "provider-start", provider: entry.provider, platform: entry.platform, pageLimit, scrollLimit, cardLimit });
    }
    for (const entry of providers) {
      events.push({ type: "provider-result", result: {
        provider: entry.provider, platform: entry.platform, pageUrl: entry.pageUrl, status: entry.status,
        cards: [], rawCardCount: 0, warnings: [], ...(entry.error ? { error: entry.error } : {}),
        coverage: { pagesVisited: 0, pageLimit: entry.provider === "boss" ? 1 : 5, scrollSteps: 0, scrollLimit: entry.provider === "boss" ? 80 : 0, cardLimit: 500, stopReason: entry.stopReason, partial: true },
      } });
    }
    events.push({ type: "complete", capturedAt: "2026-10-26T00:00:00.000Z", providers: providers.map(entry => entry.provider) });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const pipeline = new OpportunityHarvestChainedClientPipeline({ client: {} as never, keyword: "C#", depth: "quick", onLiveProgress() {} });
    pipeline.onProgress(({ stage, message, stats }) => { if (stage === "platform-harvest") progress.push({ message, stats }); });
    await pipeline.stage2_HarvestLivePlatforms();
    const final = progress.at(-1)!;
    assert.match(final.message, /本轮平台读取已结束（部分覆盖/);
    assert.match(final.message, /3 个失败、1 个需登录\/验证/);
    assert.equal(final.stats?.failedPlatforms, 3);
    assert.equal(final.stats?.blockedPlatforms, 1);
    assert.equal(final.stats?.partialPlatforms, 4);
    assert.doesNotMatch(final.message, /全网实时抓取完成/);
  } finally { globalThis.fetch = originalFetch; }
});
