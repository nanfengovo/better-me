import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtlasLiveHarvestResults, liveHarvestStopReasonLabel } from "../src/components/atlas/AtlasLiveHarvestResults";
import { applyLiveBatchStreamEvent, buildLiveHarvestProgressView, buildLiveHarvestView, getLiveHarvestPage, matchesLiveHarvestQuery, mergeLiveHarvestViews, settleLiveHarvestView } from "../src/components/atlas/live-harvest-view";
import type { LiveBatchSearchReceipt } from "../src/lib/platform-search-client";

Object.assign(globalThis, { React });

test("live receipts from another market must not remain active when country changes", () => {
  const domestic = { keyword: "Java", market: "domestic" as const, countryCodes: ["CN", "HK", "MO", "TW"] };
  const overseas = { keyword: "Java", market: "global" as const, countryCodes: ["US"] };
  const view = buildLiveHarvestView(receipt(), domestic);
  assert.equal(matchesLiveHarvestQuery(view, overseas), false);
});

function liveCard(id: number, pageUrl: string) {
  const url = `https://jobs.51job.com/shanghai/${100000000 + id}.html`;
  const title = `实时岗位 ${id}`;
  const company = `实时公司 ${id}`;
  return {
    url,
    platform: "51JOB" as const,
    title,
    company,
    locationText: "上海",
    salaryText: "20-30K",
    cardText: `${title} ${company} 上海`,
    evidence: {
      pageUrl,
      cardSelector: ".joblist-item",
      fields: [{ field: "title" as const, selector: ".jobname", text: title }],
    },
  };
}

function receipt(): LiveBatchSearchReceipt {
  const page1 = "https://we.51job.com/pc/search?keyword=Java&pageNum=1";
  const page2 = "https://we.51job.com/pc/search?keyword=Java&pageNum=2";
  const duplicate = liveCard(1, page2);
  duplicate.url += "#tracking-fragment";
  const coverage = {
    pagesVisited: 2,
    scrollSteps: 0,
    scrollLimit: 0,
    pageLimit: 15,
    cardLimit: 1500,
    stopReason: "page_limit" as const,
    partial: true,
  };
  return {
    capturedAt: "2026-10-25T12:00:00.000Z",
    results: [
      { provider: "51job", platform: "51JOB", pageUrl: page1, status: "ready", cards: [liveCard(1, page1), liveCard(2, page2), duplicate], rawCardCount: 3, warnings: [], coverage: { ...coverage } },
      { provider: "boss", platform: "BOSS直聘", pageUrl: "https://www.zhipin.com/web/geek/job?query=Java", status: "login_required", cards: [], rawCardCount: 0, warnings: [], coverage: { ...coverage } },
      { provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=Java", status: "error", cards: [], rawCardCount: 0, warnings: [], coverage: { ...coverage }, error: "synthetic platform failure" },
    ],
  };
}

test("platform job identity deduplicates tracking URLs through receipt, stream and synonym merge", () => {
  const batch = receipt();
  const first = { ...liveCard(1, "https://www.linkedin.com/jobs/search?keywords=C%23"), platform: "LinkedIn" as const,
    url: "https://cn.linkedin.com/jobs/view/csharp-engineer-4483096821?trackingId=first&position=1" };
  const duplicate = { ...first, url: "https://www.linkedin.com/jobs/view/different-slug-4483096821?trackingId=second&position=8" };
  const other = { ...first, url: "https://www.linkedin.com/jobs/view/4483096822?trackingId=first" };
  batch.results = [{ ...batch.results[0]!, provider: "linkedin", platform: "LinkedIn", cards: [first, duplicate, other], rawCardCount: 3 }];
  const original = structuredClone(batch);
  const view = buildLiveHarvestView(batch, { keyword: "C#" });
  assert.equal(view.totalCards, 2);
  assert.equal(view.providers[0]!.cardCount, 2);
  const progressed = buildLiveHarvestProgressView(view, view.query, {
    provider: "linkedin", platform: "LinkedIn", status: "running", cardsCaptured: 3,
    pagesVisited: 2, scrollSteps: 0, pageLimit: 5, scrollLimit: 0, cardLimit: 500,
    cards: [{ provider: "linkedin", platform: "LinkedIn", card: duplicate }],
  });
  assert.equal(progressed.totalCards, 2);
  assert.equal(mergeLiveHarvestViews(progressed, buildLiveHarvestView({ ...batch,
    results: [{ ...batch.results[0]!, cards: [duplicate] }] }, view.query)).totalCards, 2);
  assert.deepEqual(batch, original, "raw source receipt and tracking evidence must remain untouched");
});

test("live harvest view presents this crawl's verified cards directly, independent of any saved-index snapshot", () => {
  const view = buildLiveHarvestView(receipt(), { keyword: "Java" });

  assert.equal(view.query.keyword, "Java");
  assert.equal(view.totalCards, 2);
  assert.deepEqual(view.cards.map(({ card }) => card.title), ["实时岗位 1", "实时岗位 2"]);
  assert.deepEqual(view.cards.map(({ card }) => card.evidence.pageUrl), [
    "https://we.51job.com/pc/search?keyword=Java&pageNum=1",
    "https://we.51job.com/pc/search?keyword=Java&pageNum=2",
  ]);
  assert.deepEqual(view.providers.map(({ platform, status, cardCount }) => [platform, status, cardCount]), [
    ["51JOB", "ready", 2],
    ["BOSS直聘", "login_required", 0],
    ["猎聘", "error", 0],
  ]);
});

test("live harvest view does not treat failed or empty providers as zero-result proof", () => {
  const batch = receipt();
  batch.results[0]!.status = "empty";
  batch.results[0]!.cards = [];
  const view = buildLiveHarvestView(batch, { keyword: "Java" });

  assert.equal(view.totalCards, 0);
  assert.equal(view.providers.find(({ platform }) => platform === "猎聘")?.error, "synthetic platform failure");
  assert.equal(view.providers.find(({ platform }) => platform === "BOSS直聘")?.status, "login_required");
});

test("live harvest receipts are only active for the exact keyword and location query that produced them", () => {
  const view = buildLiveHarvestView(receipt(), { keyword: " Java ", region: "上海", districtCode: "310115" });
  assert.equal(matchesLiveHarvestQuery(view, { keyword: "java", region: " 上海 ", districtCode: "310115" }), true);
  assert.equal(matchesLiveHarvestQuery(view, { keyword: "Java", region: "上海", districtCode: "310101" }), false);
  assert.equal(matchesLiveHarvestQuery(view, { keyword: "Python", region: "上海", districtCode: "310115" }), false);
});

test("metadata label changes retain a live scope only for the same configured region", () => {
  const query = { keyword: "C#", region: "上海市", market: "global" as const, countryCodes: ["CN"] };
  const view = buildLiveHarvestView(receipt(), query);
  for (const region of ["CN-SH", "上海", "Shanghai", "cn-shanghai"]) {
    assert.equal(matchesLiveHarvestQuery(view, { ...query, region }), true, region);
  }
  for (const region of ["北京", "CN-BJ", "上海浦东", "Shanghai, USA", ""]) {
    assert.equal(matchesLiveHarvestQuery(view, { ...query, region }), false, region);
  }
  assert.equal(matchesLiveHarvestQuery(view, { ...query, region: "CN-SH", countryCodes: ["US"] }), false);
  assert.equal(matchesLiveHarvestQuery(view, { ...query, region: "CN-SH", market: "domestic" }), false);
});

test("stream progress keeps completed provider cards while replacing only the current provider state", () => {
  const previous = buildLiveHarvestView(receipt(), { keyword: "Java" });
  const running = buildLiveHarvestProgressView(previous, { keyword: "Java" }, {
    provider: "boss", platform: "BOSS直聘", status: "running", cardsCaptured: 18,
    pagesVisited: 0, scrollSteps: 12, pageLimit: 1, scrollLimit: 80, cardLimit: 500,
  });
  assert.equal(running.totalCards, previous.totalCards);
  assert.equal(running.providers.find(provider => provider.provider === "boss")?.status, "running");
  assert.equal(running.providers.find(provider => provider.provider === "boss")?.cardCount, 0, "unfinalized candidates are not added to the distinct card total");
  assert.equal(running.providers.find(provider => provider.provider === "boss")?.progressCardsCaptured, 18);
  assert.equal(running.providers.find(provider => provider.provider === "boss")?.coverage.scrollSteps, 12);
  assert.equal(running.providers.find(provider => provider.provider === "51job")?.cardCount, 2);
});

test("100 metadata-only progress events keep 5,000 cards without rereading their URLs", () => {
  let urlReads = 0;
  const batch = receipt();
  batch.results[0]!.cards = Array.from({ length: 5_000 }, (_, index) => {
    const card = liveCard(index, "https://we.51job.com/pc/search?keyword=Java");
    const url = card.url;
    Object.defineProperty(card, "url", { enumerable: true, get() { urlReads++; return url; } });
    return card;
  });
  const previous = buildLiveHarvestView(batch, { keyword: "Java" });
  let current = previous;
  urlReads = 0;

  for (let index = 0; index < 100; index++) {
    current = buildLiveHarvestProgressView(current, { keyword: "Java" }, {
      provider: "boss", platform: "BOSS直聘", status: "running", cardsCaptured: index,
      pagesVisited: 0, scrollSteps: index, pageLimit: 1, scrollLimit: 100, cardLimit: 500,
    });
  }

  assert.equal(urlReads, 0, "progress metadata must not rescan previously verified card URLs");
  assert.strictEqual(current.cards, previous.cards, "stable data must retain its reference for downstream render memoization");
  assert.equal(current.totalCards, 5_000);
  assert.equal(current.providers.find(provider => provider.provider === "boss")?.progressCardsCaptured, 99);
});

test("stream event adapter does not rebuild cumulative receipt cards for numeric progress", () => {
  const batch = receipt();
  const previous = buildLiveHarvestView(batch, { keyword: "Java" });
  let receiptCardReads = 0;
  const cards = batch.results[0]!.cards;
  Object.defineProperty(batch.results[0], "cards", { get() { receiptCardReads++; return cards; } });
  const next = applyLiveBatchStreamEvent(previous, batch, { keyword: "Java" }, {
    type: "provider-progress", provider: "boss", platform: "BOSS直聘", cardsCaptured: 12,
    pagesVisited: 0, scrollSteps: 5, pageLimit: 1, scrollLimit: 80, cardLimit: 500,
  });
  assert.strictEqual(next.cards, previous.cards);
  assert.equal(receiptCardReads, 0);
  assert.equal(next.providers.find(provider => provider.provider === "boss")?.progressCardsCaptured, 12);
});

test("provider completion uses cumulative multi-keyword receipt coverage rather than the last keyword only", () => {
  const batch = receipt();
  const previous = buildLiveHarvestView(batch, { keyword: "Java" });
  const currentKeywordResult = { ...batch.results[0]!, coverage: { ...batch.results[0]!.coverage, pagesVisited: 1, pageLimit: 5 } };
  batch.results[0]!.coverage = { ...batch.results[0]!.coverage, pagesVisited: 7, pageLimit: 15 };
  const next = applyLiveBatchStreamEvent(previous, batch, { keyword: "Java" }, { type: "provider-result", result: currentKeywordResult });
  assert.equal(next.providers[0]?.coverage.pagesVisited, 7);
  assert.equal(next.providers[0]?.coverage.pageLimit, 15);
  assert.equal(next.providers[0]?.status, "ready");
});

test("a failed or cancelled stream settles queued/running providers and preserves verified cards", () => {
  const previous = buildLiveHarvestView(receipt(), { keyword: "Java" });
  const queued = buildLiveHarvestProgressView(previous, { keyword: "Java" }, {
    provider: "linkedin", platform: "LinkedIn", status: "queued", cardsCaptured: 0,
    pagesVisited: 0, scrollSteps: 0, pageLimit: 10, scrollLimit: 0, cardLimit: 1500,
  });
  const inFlight = buildLiveHarvestProgressView(queued, { keyword: "Java" }, {
    provider: "boss", platform: "BOSS直聘", status: "running", cardsCaptured: 1,
    pagesVisited: 0, scrollSteps: 4, pageLimit: 1, scrollLimit: 80, cardLimit: 500,
  });
  const failed = settleLiveHarvestView(inFlight, { outcome: "error", message: "Synthetic stream failure before final receipt." });

  assert.equal(failed?.totalCards, previous.totalCards, "already verified cards remain available after transport failure");
  assert.equal(failed?.providers.find(provider => provider.provider === "boss")?.status, "error");
  assert.match(failed?.providers.find(provider => provider.provider === "boss")?.error ?? "", /Synthetic stream failure/);
  assert.equal(failed?.providers.find(provider => provider.provider === "boss")?.coverage.stopReason, "error");
  assert.equal(failed?.providers.some(provider => provider.status === "running" || provider.status === "queued"), false, "no platform may remain stuck after the run ends");
  const failedMarkup = renderToStaticMarkup(createElement(AtlasLiveHarvestResults, { view: failed!, busy: false }));
  assert.match(failedMarkup, /Synthetic stream failure/);
  assert.doesNotMatch(failedMarkup, /继续读取/);

  const cancelled = settleLiveHarvestView(inFlight, { outcome: "cancelled" });
  assert.equal(cancelled?.totalCards, previous.totalCards);
  assert.equal(cancelled?.providers.find(provider => provider.provider === "boss")?.status, "cancelled");
  assert.equal(cancelled?.providers.find(provider => provider.provider === "linkedin")?.status, "cancelled");
  assert.equal(cancelled?.providers.find(provider => provider.provider === "boss")?.coverage.stopReason, "cancelled");
  assert.match(cancelled?.providers.find(provider => provider.provider === "boss")?.error ?? "", /未返回最终回执/);
});

test("a later synonym receipt does not discard cards captured before a failed stream", () => {
  const first = buildLiveHarvestProgressView(null, { keyword: "C#" }, {
    provider: "51job", platform: "51JOB", status: "running", cardsCaptured: 1,
    pagesVisited: 1, scrollSteps: 0, pageLimit: 5, scrollLimit: 0, cardLimit: 500,
    cards: [{ provider: "51job", platform: "51JOB", card: liveCard(1, "https://we.51job.com/pc/search?keyword=C%23") }],
  });
  const secondReceipt = receipt();
  secondReceipt.results[0]!.cards = [liveCard(2, "https://we.51job.com/pc/search?keyword=.NET")];
  secondReceipt.results[0]!.coverage.stopReason = "exhausted";
  secondReceipt.results[0]!.coverage.partial = false;
  const merged = mergeLiveHarvestViews(first, buildLiveHarvestView(secondReceipt, { keyword: "C#" }));
  assert.equal(merged.totalCards, 2);
  assert.deepEqual(merged.cards.map(({ card }) => card.title), ["实时岗位 1", "实时岗位 2"]);
  assert.equal(merged.providers.find(provider => provider.provider === "liepin")?.coverage.partial, true);
});

test("stream progress merges newly verified cards immediately and deduplicates normalized URLs", () => {
  const previous = buildLiveHarvestView(receipt(), { keyword: "Java" });
  const first = liveCard(3, "https://we.51job.com/pc/search?keyword=Java&pageNum=3");
  const duplicate = { ...first, url: `${first.url}#tracking-fragment` };
  const running = buildLiveHarvestProgressView(previous, { keyword: "Java" }, {
    provider: "51job", platform: "51JOB", status: "running", cardsCaptured: 2,
    pagesVisited: 3, scrollSteps: 0, pageLimit: 15, scrollLimit: 0, cardLimit: 1500,
    cards: [first, duplicate].map(card => ({ provider: "51job" as const, platform: "51JOB" as const, card })),
  });

  assert.equal(running.totalCards, 3);
  assert.deepEqual(running.cards.map(({ card }) => card.title), ["实时岗位 1", "实时岗位 2", "实时岗位 3"]);
  assert.equal(running.providers.find(provider => provider.provider === "51job")?.cardCount, 3);
  assert.equal(running.providers.find(provider => provider.provider === "51job")?.progressCardsCaptured, 2);
});

test("duplicate stream cards keep the array and append-only updates leave previous provider counts untouched", () => {
  const previous = buildLiveHarvestView(receipt(), { keyword: "Java" });
  for (const provider of previous.providers) Object.freeze(provider);
  const progress = { provider: "51job" as const, platform: "51JOB" as const, status: "running" as const, cardsCaptured: 3, pagesVisited: 3, scrollSteps: 0, pageLimit: 15, scrollLimit: 0, cardLimit: 1_500 };
  const duplicate = buildLiveHarvestProgressView(previous, { keyword: "Java" }, { ...progress, cards: [previous.cards[0]!] });
  assert.strictEqual(duplicate.cards, previous.cards);
  const appended = buildLiveHarvestProgressView(previous, { keyword: "Java" }, { ...progress, cards: [{ provider: "51job", platform: "51JOB", card: liveCard(3, "https://we.51job.com/pc/search?keyword=Java&pageNum=3") }] });
  assert.deepEqual(appended.cards.slice(0, 2), previous.cards);
  assert.equal(previous.providers[0]?.cardCount, 2);
  assert.equal(appended.providers[0]?.cardCount, 3);
});

test("live result UI pagination bounds each render to 50 cards without dropping the total", () => {
  const cards = Array.from({ length: 3_000 }, (_, index) => index);
  const first = getLiveHarvestPage(cards, 0);
  const last = getLiveHarvestPage(cards, 100);
  assert.equal(first.items.length, 50);
  assert.equal(first.firstItem, 1);
  assert.equal(first.lastItem, 50);
  assert.equal(last.pageIndex, 59);
  assert.equal(last.items.length, 50);
  assert.equal(last.items[0], 2_950);
  assert.equal(last.lastItem, 3_000);
});

test("live result UI distinguishes no-progress causes and points to provider error details", () => {
  const batch = receipt();
  batch.results[0]!.coverage.stopReason = "no_progress";
  batch.results[0]!.coverage.partial = true;
  batch.results[1]!.status = "unknown_layout";
  batch.results[1]!.coverage.stopReason = "no_progress";
  batch.results[1]!.coverage.partial = true;
  batch.results[2]!.coverage.stopReason = "error";
  batch.results[2]!.coverage.partial = true;

  const markup = renderToStaticMarkup(createElement(AtlasLiveHarvestResults, { view: buildLiveHarvestView(batch, { keyword: "Java" }) }));

  assert.match(markup, /页码或列表未确认变化/);
  assert.match(markup, /页面未识别或加载超时/);
  assert.match(markup, /读取异常（展开查看原因）/);
  assert.match(markup, /synthetic platform failure/, "expanded details remain available below the summary to diagnose the platform error");
});

test("a provider with valid cards and failed pages is described as partial rather than an empty hard failure", () => {
  assert.equal(liveHarvestStopReasonLabel("ready", "error"), "部分分页读取失败");
  assert.equal(liveHarvestStopReasonLabel("error", "error"), "读取异常（展开查看原因）");
});

test("source summaries distinguish rate limits from login and verification without hiding captured cards", () => {
  const batch = receipt();
  batch.results[0]!.coverage = { ...batch.results[0]!.coverage, stopReason: "gate", failureKind: "platform_limit" };
  batch.results[1]!.coverage = { ...batch.results[1]!.coverage, stopReason: "gate", failureKind: "login" };
  batch.results[2]!.status = "verification_required";
  batch.results[2]!.coverage = { ...batch.results[2]!.coverage, stopReason: "gate", failureKind: "verification" };
  const view = buildLiveHarvestView(batch, { keyword: "C#" });
  assert.equal(view.totalCards, 2, "a later platform limit must not discard previously verified cards");
  assert.deepEqual(view.providers.map(provider => provider.coverage.failureKind), ["platform_limit", "login", "verification"]);
  const merged = mergeLiveHarvestViews(view, buildLiveHarvestView(structuredClone(batch), view.query));
  assert.deepEqual(merged.providers.map(provider => provider.coverage.failureKind), ["platform_limit", "login", "verification"]);
  const markup = renderToStaticMarkup(createElement(AtlasLiveHarvestResults, { view: merged }));
  assert.match(markup, /部分：平台访问受限（限流或拒绝访问）/);
  assert.match(markup, /部分：需要登录/);
  assert.match(markup, /部分：需要安全验证/);
  assert.doesNotMatch(markup, /登录或安全验证阻断/);
  assert.equal(liveHarvestStopReasonLabel("ready", "gate"), "登录或安全验证阻断", "old receipts without a failure kind remain explicitly unspecific");
  assert.equal(liveHarvestStopReasonLabel("cancelled", "cancelled", "platform_limit"), "已取消", "a historic failure kind must not override cancellation");
});

test("source coverage is collapsed and labels page limits as budgets, not website totals", () => {
  const markup = renderToStaticMarkup(createElement(AtlasLiveHarvestResults, { view: buildLiveHarvestView(receipt(), { keyword: "Java" }) }));
  assert.match(markup, /<details class="atlas-live-harvest-sources">/);
  assert.doesNotMatch(markup, /<details[^>]+open/);
  assert.match(markup, /已读 2 页 · 预算 15 页/);
  assert.doesNotMatch(markup, /2\/15 页/);
});
