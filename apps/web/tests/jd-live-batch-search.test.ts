import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import {
  clickPlatformNextPage,
  captureProviderViaNativeCdp,
  confirmLiveSearchPageAdvance,
  createLiveBatchCoverage,
  decideBossScrollBoundary,
  decideLiveBatchAdvance,
  isCompleteLinkedInEmptyResult,
  isFirstPlatformPage,
  liveBatchCardBudget,
  liveBatchPageBudget,
  liveBatchProviderPageBudget,
  liveBatchScrollBudget,
  mapWithConcurrency,
  LiveBatchSearchInputSchema,
  getPlatformExpandedUrls,
  sanitizeProgressCardBatches,
  sanitizeReviewedCards,
} from "../server/jd-live-batch-search";
import type { NativeCdp } from "../server/jd-native-cdp";
import type { JobSearchCard } from "../server/jd-search-capture";

function cdpReturning(value: unknown, shouldThrow = false): NativeCdp {
  return {
    async send<T>() {
      if (shouldThrow) throw new Error("synthetic CDP failure");
      return { result: { value } } as T;
    },
    on() { return () => {}; },
    close() {},
    connected: true,
  };
}

function card(index: number, pageUrl: string): JobSearchCard {
  const url = `https://jobs.51job.com/shanghai/${100000000 + index}.html`;
  const title = `Java 工程师 ${index}`;
  const company = `公司 ${index}`;
  const cardText = `${title} ${company} 上海`;
  return {
    platform: "51JOB", url, title, company, locationText: "上海", cardText,
    evidence: {
      pageUrl,
      cardSelector: ".joblist-item",
      fields: [
        { field: "url", selector: "a", text: url },
        { field: "title", selector: ".jobname", text: title },
        { field: "company", selector: ".company-name", text: company },
        { field: "locationText", selector: ".job-area", text: "上海" },
      ],
    },
  };
}

test("live batch accepts the actual standard and deep page budgets", () => {
  for (const maxPages of [15, 30, 50]) {
    assert.equal(LiveBatchSearchInputSchema.safeParse({ keyword: "Java", depth: "deep", maxPages }).success, true);
  }
  assert.equal(LiveBatchSearchInputSchema.safeParse({ keyword: "Java", maxPages: 51 }).success, false);
});
test("live batch rejects unknown region identifiers instead of silently removing the location filter", () => {
  assert.equal(LiveBatchSearchInputSchema.safeParse({ keyword: "C#", regionId: "cn-shanghai" }).success, true);
  assert.equal(LiveBatchSearchInputSchema.safeParse({ keyword: "C#", regionId: "上海" }).success, true);
  const invalid = LiveBatchSearchInputSchema.safeParse({ keyword: "C#", regionId: "020" });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.deepEqual(invalid.error.issues[0]?.path, ["regionId"]);
});

test("page and card budgets match the UI modes and deep defaults are not silently reduced", () => {
  assert.deepEqual(["quick", "standard", "deep"].map((depth) => liveBatchPageBudget(depth as "quick" | "standard" | "deep")), [5, 20, 50]);
  assert.deepEqual(["quick", "standard", "deep"].map((depth) => liveBatchCardBudget(depth as "quick" | "standard" | "deep")), [500, 1500, 3000]);
  assert.equal(liveBatchPageBudget("deep", 35), 35);
  assert.equal(liveBatchPageBudget("deep", 80), 50);
  assert.equal(liveBatchProviderPageBudget("boss", "deep"), 1, "BOSS uses virtual scroll rather than a numbered-page budget");
  assert.equal(liveBatchProviderPageBudget("liepin", "deep"), 50);
  assert.deepEqual(
    ["quick", "standard", "deep"].map((depth) => liveBatchScrollBudget("boss", depth as "quick" | "standard" | "deep")),
    [20, 80, 300],
  );
  assert.equal(liveBatchScrollBudget("51job", "deep"), 0, "numbered-page providers do not use a virtual scroll budget");
});

test("platform work can run concurrently within a bounded worker limit while preserving result order", async () => {
  let active = 0;
  let maximumActive = 0;
  const output = await mapWithConcurrency([40, 10, 30, 20], 2, async (value) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return value;
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(output, [40, 10, 30, 20]);
});

test("a reused browser tab must start at its first search page before page coverage is counted", () => {
  assert.equal(isFirstPlatformPage("https://we.51job.com/pc/search?keyword=Java", "51job"), true);
  assert.equal(isFirstPlatformPage("https://we.51job.com/pc/search?keyword=Java&pageNum=1", "51job"), true);
  assert.equal(isFirstPlatformPage("https://we.51job.com/pc/search?keyword=Java&pageNum=8", "51job"), false);
  assert.equal(isFirstPlatformPage("https://www.liepin.com/zhaopin/?key=Java&currentPage=0", "liepin"), true);
  assert.equal(isFirstPlatformPage("https://www.liepin.com/zhaopin/?key=Java&currentPage=1", "liepin"), false);
  assert.equal(isFirstPlatformPage("https://www.zhipin.com/web/geek/job?query=Java", "boss"), true);
});

test("LinkedIn is explicitly empty only when every fetched page proves empty", () => {
  assert.equal(isCompleteLinkedInEmptyResult(["empty", "empty"], 0, 2, 5), true);
  assert.equal(isCompleteLinkedInEmptyResult(["empty", "empty"], 0, 5, 5), false, "a page-budget stop is partial, even if all fetched pages were empty");
  assert.equal(isCompleteLinkedInEmptyResult(["empty", "unknown_layout"], 0, 2, 5), false);
  assert.equal(isCompleteLinkedInEmptyResult(["empty", "empty"], 1, 2, 5), false);
  assert.equal(isCompleteLinkedInEmptyResult([], 0, 0, 5), false);
});

test("page URL expansion contains only the requested keyword and exactly the bounded primary pages", () => {
  const base = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
  const pages = getPlatformExpandedUrls("51job", base, "Java", 20);
  assert.equal(pages.length, 20);
  assert.ok(pages.every((url) => new URL(url).searchParams.get("keyword") === "Java"));
  assert.deepEqual(pages.slice(0, 4).map((url) => new URL(url).searchParams.get("pageNum")), [null, "2", "3", "4"]);

  const liepinPages = getPlatformExpandedUrls("liepin", "https://www.liepin.com/zhaopin/?key=Java", "Java", 4);
  assert.equal(liepinPages.length, 4);
  assert.deepEqual(liepinPages.map((url) => new URL(url).searchParams.get("currentPage")), [null, "1", "2", "3"]);
});

test("deep live sanitization does not silently stop at 500 cards and keeps each card's real page provenance", () => {
  const firstPage = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2&pageNum=1";
  const secondPage = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2&pageNum=2";
  const input = Array.from({ length: 620 }, (_, index) => card(index, index < 50 ? firstPage : secondPage));
  const results = sanitizeReviewedCards(input, "51job", "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2", "Java");
  assert.equal(results.length, 620);
  assert.equal(results[0]!.evidence.pageUrl, firstPage);
  assert.equal(results[50]!.evidence.pageUrl, secondPage);
  assert.ok(results.every((result) => !result.cardText.includes("平台检索意图命中")));
});

test("progress card batches contain only reviewed cards, preserve source pages, and cap each batch at 50", () => {
  const firstPage = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2&pageNum=1";
  const secondPage = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2&pageNum=2";
  const raw = Array.from({ length: 102 }, (_, index) => card(index, index < 51 ? firstPage : secondPage));
  raw[100]!.url = "https://example.invalid/job/123";
  const published = new Set<string>();
  const batches = sanitizeProgressCardBatches(raw, "51job", firstPage, "Java", 3000, published);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 1]);
  assert.equal(batches.flat().length, 101, "invalid cross-origin card is never sent in progress");
  assert.equal(batches[0]![0]!.evidence.pageUrl, firstPage);
  assert.equal(batches[1]![0]!.evidence.pageUrl, firstPage);
  assert.equal(batches[1]![1]!.evidence.pageUrl, secondPage);
  assert.deepEqual(sanitizeProgressCardBatches([raw[0]!, card(103, secondPage)], "51job", secondPage, "Java", 3000, published).flat().map((item) => item.evidence.pageUrl), [secondPage], "already published cards are not sent twice");
});

test("deep live cards keep excerpts bounded while preserving the card's verified key fields", () => {
  const pageUrl = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
  const input = card(999, pageUrl);
  input.cardText = `${input.title} ${input.company} 上海 20-30K ${"长描述".repeat(4_000)}`;
  const [result] = sanitizeReviewedCards([input], "51job", pageUrl, "Java");
  assert.ok(result);
  assert.ok(result.cardText.length <= 1_200);
  assert.ok(result.cardText.includes(result.title));
  assert.ok(result.cardText.includes(result.company));
  assert.ok(result.cardText.includes("上海"));
  assert.equal(result.locationText, "上海");
});

test("pagination decisions distinguish no-advance objects from a successful page advance", () => {
  const currentPageUrl = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
  const nextPageUrl = `${currentPageUrl}&pageNum=2`;
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "page", exhausted: false }, provider: "51job", currentPage: 1,
    pageLimit: 15, nextPageUrl, currentPageUrl,
  }), { action: "navigate-page", pageUrl: nextPageUrl });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: true, kind: "page", exhausted: false }, provider: "51job", currentPage: 1,
    pageLimit: 15, nextPageUrl, currentPageUrl,
  }), { action: "continue-page" });
});

test("CDP page advance preserves exhausted and no-advance results instead of treating result objects as truthy success", async () => {
  const exhausted = await clickPlatformNextPage(
    cdpReturning({ advanced: false, kind: "page", exhausted: true }), "session", "51JOB",
  );
  assert.deepEqual(exhausted, { advanced: false, kind: "page", exhausted: true });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: exhausted,
    provider: "51job",
    currentPage: 2,
    pageLimit: 15,
    currentPageUrl: "https://we.51job.com/pc/search?keyword=Java&pageNum=2",
    nextPageUrl: "https://we.51job.com/pc/search?keyword=Java&pageNum=3",
  }), { action: "stop", stopReason: "exhausted" });

  const noAdvance = await clickPlatformNextPage(
    cdpReturning({ advanced: false, kind: "page", exhausted: false }), "session", "51JOB",
  );
  assert.deepEqual(noAdvance, { advanced: false, kind: "page", exhausted: false });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: noAdvance,
    provider: "51job",
    currentPage: 2,
    pageLimit: 15,
    currentPageUrl: "https://we.51job.com/pc/search?keyword=Java&pageNum=2",
    nextPageUrl: "https://we.51job.com/pc/search?keyword=Java&pageNum=3",
  }), { action: "navigate-page", pageUrl: "https://we.51job.com/pc/search?keyword=Java&pageNum=3" });

  const failedRead = await clickPlatformNextPage(cdpReturning(undefined, true), "session", "51JOB");
  assert.deepEqual(failedRead, { advanced: false, kind: "page", exhausted: false });
});

test("virtual-list scroll advances, stops at exhaustion, and does not invent BOSS pagination on no progress", async () => {
  const currentPageUrl = "https://www.zhipin.com/web/geek/job?query=Java&city=101020100";
  const scrolled = await clickPlatformNextPage(
    cdpReturning({ advanced: true, kind: "scroll", exhausted: false }), "session", "BOSS直聘",
  );
  assert.deepEqual(scrolled, { advanced: true, kind: "scroll", exhausted: false });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: scrolled, provider: "boss", currentPage: 1,
    pageLimit: 15, currentPageUrl,
  }), { action: "continue-scroll" });

  const atEnd = await clickPlatformNextPage(
    cdpReturning({ advanced: false, kind: "scroll", exhausted: true }), "session", "BOSS直聘",
  );
  assert.deepEqual(atEnd, { advanced: false, kind: "scroll", exhausted: true });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: atEnd, provider: "boss", currentPage: 1, pageLimit: 15,
    currentPageUrl,
    nextPageUrl: "https://www.zhipin.com/web/geek/job?query=Java&city=101020100&page=2",
  }), { action: "stop", stopReason: "exhausted" });

  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "scroll", exhausted: false }, provider: "boss", currentPage: 1,
    pageLimit: 15, currentPageUrl,
    nextPageUrl: "https://www.zhipin.com/web/geek/job?query=Java&city=101020100&page=2",
  }), { action: "stop", stopReason: "no_progress" });
});

test("BOSS scroll confirms actual movement and dispatches the event to the list root", async () => {
  for (const allowsScroll of [true, false]) {
    let top = 0;
    let listEvents = 0;
    let windowEvents = 0;
    const body = {};
    const root = {
      parentElement: body, scrollHeight: 1800, clientHeight: 600,
      get scrollTop() { return top; },
      set scrollTop(value: number) { if (allowsScroll) top = value; },
      dispatchEvent() { listEvents++; },
    };
    const card = { parentElement: root, scrollHeight: 120, clientHeight: 120 };
    const cdp: NativeCdp = {
      ...cdpReturning(undefined),
      async send<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
        const value = runInNewContext(String(params?.expression), {
          document: {
            body, scrollingElement: {}, documentElement: {},
            querySelector: (selector: string) => selector.includes("job-card-wrapper") ? card : null,
          },
          window: { dispatchEvent() { windowEvents++; } },
          getComputedStyle: () => ({ overflowY: "auto" }),
          Event,
        });
        return { result: { value } } as T;
      },
    };
    const result = await clickPlatformNextPage(cdp, "session", "BOSS直聘");
    assert.equal(result.advanced, allowsScroll, "a requested scroll must not count when scrollTop did not move");
    assert.equal(result.kind, "scroll");
    assert.equal(listEvents, 1);
    assert.equal(windowEvents, 0, "the detail/document scroll listener must not replace the list-root listener");
  }
});

test("BOSS bottom waits through loading and only calls the list exhausted after a stable boundary", () => {
  assert.equal(decideBossScrollBoundary({ addedCards: 4, loading: true, noProgressAttempts: 0 }), "continue");
  assert.equal(decideBossScrollBoundary({ addedCards: 0, loading: true, noProgressAttempts: 0 }), "continue");
  assert.equal(decideBossScrollBoundary({ addedCards: 0, loading: true, noProgressAttempts: 2 }), "no_progress");
  assert.equal(decideBossScrollBoundary({ addedCards: 0, loading: false, noProgressAttempts: 0 }), "continue");
  assert.equal(decideBossScrollBoundary({ addedCards: 0, loading: false, noProgressAttempts: 1 }), "continue");
  assert.equal(decideBossScrollBoundary({ addedCards: 0, loading: false, noProgressAttempts: 2 }), "exhausted");
});

test("BOSS collector reaches the next batch after scrolling through already captured cards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pageUrl = "https://www.zhipin.com/web/geek/jobs?query=C%23&city=101020100";
  const target = { targetId: "boss-list", type: "page", url: pageUrl };
  let scrolls = 0;
  let domSnapshotReads = 0;
  const activatedTargets: string[] = [];
  const reportedProgress: Array<{ pagesVisited: number; scrollSteps: number; cardsCaptured: number }> = [];
  const cards = Array.from({ length: 30 }, (_, index): JobSearchCard => {
    const source = card(index, pageUrl);
    const url = `https://www.zhipin.com/job_detail/boss_${index}.html`;
    return {
      ...source,
      platform: "BOSS直聘",
      url,
      evidence: { ...source.evidence, fields: source.evidence.fields.map((field) => field.field === "url" ? { ...field, text: url } : field) },
    };
  });
  const cdp: NativeCdp = {
    connected: true,
    on() { return () => {}; },
    close() {},
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.createTarget") return { targetId: target.targetId } as T;
      if (method === "Target.attachToTarget") return { sessionId: "boss-session" } as T;
      if (method === "Target.activateTarget") { activatedTargets.push(String(params?.targetId)); return {} as T; }
      if (method === "Target.getTargets") return { targetInfos: [target] } as T;
      if (method === "DOMSnapshot.captureSnapshot") { domSnapshotReads++; throw new Error("Fixture uses the primary card extractor"); }
      if (method !== "Runtime.evaluate") return {} as T;
      const expression = String(params?.expression);
      let value: unknown;
      if (expression.includes("const next = document.querySelector")) {
        // Fifteen cards are already in the DOM. Several viewport scrolls must
        // cross those cards before BOSS appends the second batch at the bottom.
        const advanced = scrolls < 8;
        if (advanced) scrolls++;
        value = { advanced, kind: "scroll", exhausted: !advanced };
      } else if (expression.includes("return cards;")) {
        value = cards.slice(0, scrolls >= 5 ? 30 : 15);
      } else if (expression.includes("marker:")) {
        value = { url: pageUrl, marker: "" };
      } else {
        value = false;
      }
      return { result: { value } } as T;
    },
  };
  let settled = false;
  const pending = captureProviderViaNativeCdp(cdp, {
    provider: "boss", platform: "BOSS直聘", url: pageUrl,
  }, [target], "C#", undefined, 0, "quick", undefined, async () => true, (progress) => {
    reportedProgress.push({ pagesVisited: progress.pagesVisited, scrollSteps: progress.scrollSteps, cardsCaptured: progress.cardsCaptured });
  }).finally(() => { settled = true; });
  for (let turn = 0; turn < 100 && !settled; turn++) {
    t.mock.timers.tick(10_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(settled, true, "the bounded collector must settle");
  const result = await pending;
  assert.equal(result.rawCardCount, 30, "scrolling through an existing batch must not hide the next batch");
  assert.equal(result.cards.length, 30);
  assert.equal(result.coverage?.scrollSteps, 8);
  assert.equal(result.coverage?.stopReason, "exhausted");
  assert.ok(domSnapshotReads <= scrolls + 3, `${domSnapshotReads} full DOM snapshots for ${scrolls} scrolls; a failed lightweight poll must not trigger repeated snapshots`);
  assert.deepEqual(activatedTargets, [], "background collection must not activate the user's Chrome tab");
  assert.ok(reportedProgress.some((progress) => progress.pagesVisited === 1 && progress.cardsCaptured === 15));
  assert.ok(reportedProgress.some((progress) => progress.pagesVisited === 1 && progress.scrollSteps > 0 && progress.cardsCaptured === 30));
});

test("collector creates a new platform tab in the background and never activates it", async () => {
  const pageUrl = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
  const controller = new AbortController();
  let createParams: Record<string, unknown> | undefined;
  const activatedTargets: string[] = [];
  const target = { targetId: "new-background-search", type: "page", url: pageUrl };
  const cdp: NativeCdp = {
    connected: true,
    on() { return () => {}; },
    close() {},
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.createTarget") { createParams = params; return { targetId: target.targetId } as T; }
      if (method === "Target.attachToTarget") { controller.abort(); return { sessionId: "background-session" } as T; }
      if (method === "Target.activateTarget") { activatedTargets.push(String(params?.targetId)); return {} as T; }
      if (method === "Target.getTargets") return { targetInfos: [target] } as T;
      return { result: { value: undefined } } as T;
    },
  };

  await captureProviderViaNativeCdp(cdp, { provider: "51job", platform: "51JOB", url: pageUrl }, [], "Java", controller.signal, 0, "quick");
  assert.equal(createParams?.url, "about:blank");
  assert.equal(createParams?.background, true, "a newly created search target should not become the selected tab");
  assert.deepEqual(activatedTargets, []);
});

test("collector never navigates a pre-existing platform tab when its search query differs", async () => {
  const pageUrl = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
  const existingUrl = "https://we.51job.com/pc/search?keyword=Rust&jobArea=020000&searchType=2";
  const target = { targetId: "user-visible-51job", type: "page", url: existingUrl };
  const ownedTarget = { targetId: "owned-background-search", type: "page", url: pageUrl };
  const controller = new AbortController();
  const targets = [target];
  const attachedTargets = new Map<string, string>();
  const navigations: Array<{ sessionId?: string; url: string }> = [];
  const createdTargets: Array<Record<string, unknown>> = [];
  const cdp: NativeCdp = {
    connected: true,
    on() { return () => {}; },
    close() {},
    async send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
      if (method === "Target.createTarget") {
        createdTargets.push(params ?? {});
        targets.push(ownedTarget);
        return { targetId: ownedTarget.targetId } as T;
      }
      if (method === "Target.attachToTarget") {
        controller.abort();
        const sessionId = `${String(params?.targetId)}-session`;
        attachedTargets.set(sessionId, String(params?.targetId));
        return { sessionId } as T;
      }
      if (method === "Target.getTargets") return { targetInfos: targets } as T;
      if (method === "Page.navigate") {
        navigations.push({ sessionId, url: String(params?.url) });
        controller.abort();
        return {} as T;
      }
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("No DOM snapshot needed for navigation-safety assertion");
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression);
        const value = expression.includes("return cards;") ? []
          : expression.includes("marker:") ? { url: existingUrl, marker: "" }
          : { advanced: false, kind: "page", exhausted: false };
        return { result: { value } } as T;
      }
      return {} as T;
    },
  };

  await captureProviderViaNativeCdp(
    cdp,
    { provider: "51job", platform: "51JOB", url: pageUrl },
    [target],
    "Java",
    controller.signal,
    0,
    "quick",
  );

  assert.equal(attachedTargets.has("user-visible-51job-session"), false, "collection must not attach to the user's existing platform tab");
  assert.ok(navigations.every(({ sessionId }) => attachedTargets.get(sessionId ?? "") !== target.targetId), "any navigation must stay on an owned background target");
  assert.deepEqual(createdTargets, [{ url: "about:blank", background: true }], "a mismatched existing page requires an owned background target before navigation");
});

for (const [provider, delay, failedScript = false] of [["liepin", 4000], ["51job", 4000], ["liepin", 12000], ["51job", 12000], ["liepin", 4000, true]] as const) {
  test(`${provider} collector waits ${delay}ms for loading cards before navigating away${failedScript ? " and recovers a failed-script second page" : ""}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const platform = provider === "liepin" ? "猎聘" : "51JOB";
    const pageUrl = provider === "liepin"
      ? "https://www.liepin.com/zhaopin/?key=Java&dq=020"
      : "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
    const dom = new Window({ url: pageUrl });
    let currentUrl = pageUrl.replace("Java", "Previous");
    let navigationAt = Date.now();
    let renderedPage = 0;
    let lazyScrollProbes = 0;
    const visited: Array<{ url: string; capturedBeforeLeaving: boolean }> = [];
    const capturedPages = new Set<number>();
    let listener: Parameters<NativeCdp["on"]>[0] | undefined;
    let secondPageNavigations = 0;
    const diagnostics: unknown[] = [];
    const pageNumber = () => Number(new URL(currentUrl).searchParams.get(provider === "liepin" ? "currentPage" : "pageNum") ?? (provider === "liepin" ? 0 : 1)) + (provider === "liepin" ? 1 : 0);
    const navigate = (url: string) => {
      if (currentUrl.includes("Java")) visited.push({ url: currentUrl, capturedBeforeLeaving: capturedPages.has(pageNumber()) });
      currentUrl = url;
      navigationAt = Date.now();
      renderedPage = 0;
      dom.document.body.innerHTML = '<main aria-busy="true">正在加载岗位</main>';
      if (failedScript && pageNumber() === 2) {
        secondPageNavigations++;
        listener?.({ method: "Network.requestWillBeSent", sessionId: "slow-page-session", params: { requestId: "failed-second-page-script", type: "Script" } });
        listener?.({ method: "Network.loadingFailed", sessionId: "slow-page-session", params: { requestId: "failed-second-page-script" } });
      }
    };
    const renderWhenReady = () => {
      const page = pageNumber();
      if (failedScript && page === 2 && secondPageNavigations < 2) return;
      if (renderedPage === page || Date.now() - navigationAt < delay) return;
      renderedPage = page;
      dom.document.body.innerHTML = provider === "liepin"
        ? `<article class="jobCardPcContainer"><a href="https://www.liepin.com/job/${100000000 + page}.shtml"><span class="jobTitleBox">Java 工程师 ${page}</span></a><span class="companyName">合成公司 ${page}</span><span class="labels-box">上海</span></article><ul class="ant-pagination"><li class="ant-pagination-item-active">${page}</li><li class="ant-pagination-next"><button>下一页</button></li></ul>`
        : `<article class="joblist-item"><a href="https://jobs.51job.com/shanghai/${100000000 + page}.html"><span class="jname">Java 工程师 ${page}</span></a><span class="cname">合成公司 ${page}</span><span class="dregion">上海</span></article><div class="el-pagination"><ul class="el-pager"><li class="active">${page}</li></ul><button class="btn-next">下一页</button></div>`;
      dom.document.querySelector("button")!.addEventListener("click", () => {
        const next = new URL(pageUrl);
        next.searchParams.set(provider === "liepin" ? "currentPage" : "pageNum", String(page + (provider === "liepin" ? 0 : 1)));
        navigate(next.toString());
      });
    };
    const cdp: NativeCdp = {
      connected: true,
      on(callback) { listener = callback; return () => { listener = undefined; }; },
      close() {},
      async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === "Target.createTarget") return { targetId: "slow-page" } as T;
        if (method === "Target.attachToTarget") return { sessionId: "slow-page-session" } as T;
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "slow-page", type: "page", url: currentUrl }] } as T;
        if (method === "Page.navigate") { navigate(String(params!.url)); return {} as T; }
        if (method === "DOMSnapshot.captureSnapshot") throw new Error("Synthetic fixture exercises the live DOM extractor");
        if (method !== "Runtime.evaluate") return {} as T;
        renderWhenReady();
        const expression = String(params?.expression);
        if (expression.includes("window.scrollBy(0, 1200)")) lazyScrollProbes++;
        const value = runInNewContext(expression, {
          document: dom.document,
          getComputedStyle: dom.getComputedStyle.bind(dom),
          location: new URL(currentUrl),
          window: { scrollBy() {} },
        });
        if (expression.includes("return cards;") && Array.isArray(value) && value.length) capturedPages.add(pageNumber());
        return { result: { value } } as T;
      },
    };
    let settled = false;
    const pending = captureProviderViaNativeCdp(cdp, { provider, platform, url: pageUrl },
      [{ targetId: "slow-page", type: "page", url: currentUrl }], "Java", undefined, 0, "quick", 2,
      undefined, undefined, async diagnostic => { diagnostics.push(diagnostic); return undefined; })
      .finally(() => { settled = true; });
    try {
      for (let turn = 0; turn < (failedScript ? 300 : 160) && !settled; turn++) {
        t.mock.timers.tick(250);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(settled, true, "the collector must obey a bounded readiness deadline");
      const result = await pending;
      assert.equal(visited.find(page => page.url === pageUrl)?.capturedBeforeLeaving, true, "a loading first page must not be skipped as if it were empty");
      assert.equal(result.cards.length, 2, "both pages must contribute their own cards after delayed rendering");
      assert.equal(result.coverage?.pagesVisited, 2);
      assert.ok(result.cards.some(item => item.evidence.pageUrl === pageUrl), "the first-page card must retain first-page provenance");
      assert.equal(lazyScrollProbes, 4, "each numbered page gets one bounded two-step lazy-load probe");
      if (failedScript) {
        assert.equal(secondPageNavigations, 2, "the failed second-page navigation gets only one script-shell recovery");
        assert.equal(result.coverage.failureKind, undefined);
        assert.equal((diagnostics[0] as { observations: Array<{ page: number; recovered: boolean }> }).observations[0]?.page, 2);
        assert.equal((diagnostics[0] as { observations: Array<{ recovered: boolean }> }).observations[0]?.recovered, true);
      }
    } finally {
      await dom.happyDOM.abort();
    }
  });
}

function readinessSnapshot(pageUrl: string, message: string) {
  const strings: string[] = [];
  const str = (value: string) => { strings.push(value); return strings.length - 1; };
  const styles = ["block", "visible", "1", "visible", "visible", "visible", "clip", "none", "auto", "none", "none", "none", "none", "none", "rgb(0, 0, 0)"].map(str);
  return {
    strings,
    documents: [{
      frameId: str("readiness-target"), documentURL: str(pageUrl), title: str("Synthetic search"),
      nodes: {
        nodeType: [9, 1, 1, 1, 1, 3], parentIndex: [-1, 0, 1, 1, 3, 4],
        nodeName: ["#document", "HTML", "HEAD", "BODY", "DIV", "#text"].map(str),
        nodeValue: [-1, -1, -1, -1, -1, str(message)], backendNodeId: [1, 2, 3, 4, 5, 6],
        attributes: [[], [], [], [], [str("class"), str("search-empty")], []],
      },
      layout: {
        nodeIndex: [1, 3, 4, 5], styles: [styles, styles, styles, []],
        bounds: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [0, 0, 600, 20], [0, 0, 600, 20]],
        text: [-1, -1, -1, str(message)], textColorOpacities: [1, 1, 1, 1],
      },
      textBoxes: { layoutIndex: [3], bounds: [[0, 0, 600, 20]], start: [0], length: [message.length] },
    }],
  };
}

for (const recovers of [false, true]) test(`Liepin pagination operation timeout ${recovers ? "observes the document that loaded despite the command timeout" : "retains verified cards and a typed timeout when the final probe is unavailable"}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const url = "https://www.liepin.com/zhaopin/?key=C%23&dq=020";
  const dom = new Window({ url });
  dom.document.body.innerHTML = '<article class="jobCardPcContainer"><a href="https://www.liepin.com/job/123456789.shtml"><span class="jobTitleBox">C# 工程师</span></a><span class="companyName">合成公司</span><span class="labels-box">上海</span></article>';
  let navigations = 0, currentUrl = url;
  const diagnostics: unknown[] = [];
  const cdp: NativeCdp = {
    ...cdpReturning(undefined),
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.createTarget") return { targetId: "owned-timeout" } as T;
      if (method === "Target.attachToTarget") return { sessionId: "owned-session" } as T;
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "owned-timeout", type: "page", url: currentUrl }] } as T;
      if (method === "Page.navigate") {
        if (++navigations > 1) {
          if (recovers) {
            currentUrl = String(params?.url);
            dom.document.body.innerHTML = '<article class="jobCardPcContainer"><a href="https://www.liepin.com/job/123456790.shtml"><span class="jobTitleBox">C# 第二页工程师</span></a><span class="companyName">合成公司</span><span class="labels-box">上海</span></article>';
          }
          throw new Error("浏览器操作超时，尚未确认操作结果。");
        }
        return {} as T;
      }
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("fixture uses visible DOM");
      if (method !== "Runtime.evaluate") return {} as T;
      if (navigations > 1 && !recovers) throw new Error("final probe unavailable");
      return { result: { value: runInNewContext(String(params?.expression), {
        document: dom.document, getComputedStyle: dom.getComputedStyle.bind(dom), location: new URL(currentUrl), window: { scrollBy() {} },
      }) } } as T;
    },
  };
  let settled = false;
  const pending = captureProviderViaNativeCdp(cdp, { provider: "liepin", platform: "猎聘", url }, [], "C#", undefined, 0, "quick", 2,
    undefined, undefined, async diagnostic => { diagnostics.push(diagnostic); return undefined; }).finally(() => { settled = true; });
  for (let i = 0; i < 160 && !settled; i++) { t.mock.timers.tick(250); await new Promise<void>(resolve => setImmediate(resolve)); }
  try {
    assert.equal(settled, true);
    const result = await pending;
    assert.equal(result.cards.length, recovers ? 2 : 1);
    assert.equal(result.coverage.stopReason, recovers ? "page_limit" : "error");
    assert.equal(result.coverage.failureKind, recovers ? undefined : "timeout");
    assert.equal(navigations, 2, "an unconfirmed navigation is not blindly retried");
    if (recovers) {
      assert.equal(result.coverage.pagesVisited, 2);
      assert.equal(result.cards[0]!.evidence.pageUrl, url);
      assert.equal(result.cards[1]!.evidence.pageUrl, currentUrl, "the recovered second-page card keeps its actual page provenance");
    }
    assert.equal((diagnostics[0] as { observations: Array<{ failure: string }> }).observations.at(-1)?.failure, "timeout");
    assert.equal((diagnostics[0] as { observations: Array<{ recovered: boolean }> }).observations.at(-1)?.recovered, recovers);
  } finally { await dom.happyDOM.abort(); }
});

for (const outcome of ["delayed-navigation", "blank-recovery", "navigation-timeout", "persistent-blank", "script-recovery", "persistent-script", "script-gate", "script-http-limit"] as const) {
  test(`owned Liepin initial navigation handles ${outcome} without interrupting an in-flight load`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const url = "https://www.liepin.com/zhaopin/?key=C%23&dq=020";
    let currentUrl = "about:blank", navigations = 0, stops = 0, createdUrl = "";
    const started = Date.now();
    const diagnostics: unknown[] = [];
    let listener: Parameters<NativeCdp["on"]>[0] | undefined;
    const dom = new Window({ url });
    const cdp: NativeCdp = {
      ...cdpReturning(undefined),
      on(callback) { listener = callback; return () => { listener = undefined; }; },
      async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === "Target.createTarget") { createdUrl = String(params?.url); return { targetId: "owned-navigation" } as T; }
        if (method === "Target.attachToTarget") return { sessionId: "owned-session" } as T;
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "owned-navigation", type: "page", url: currentUrl }] } as T;
        if (method === "Page.stopLoading") { stops++; return {} as T; }
        if (method === "Page.navigate") {
          navigations++;
          if (outcome.includes("script")) {
            currentUrl = url;
            listener?.({ method: "Network.requestWillBeSent", sessionId: "owned-session", params: { requestId: "synthetic-script", type: "Script" } });
            listener?.({ method: "Network.loadingFailed", sessionId: "owned-session", params: { requestId: "synthetic-script" } });
            if (outcome === "script-http-limit") listener?.({ method: "Network.responseReceived", sessionId: "owned-session", params: { type: "Document", response: { status: 429 } } });
          }
          if (outcome === "navigation-timeout") { currentUrl = url; throw new Error("CDP command timeout"); }
          if (outcome === "blank-recovery" && navigations > 1) currentUrl = url;
          return {} as T;
        }
        if (method === "DOMSnapshot.captureSnapshot") throw new Error("synthetic live DOM only");
        if (method !== "Runtime.evaluate") return {} as T;
        if (outcome === "delayed-navigation" && Date.now() - started >= 1500) currentUrl = url;
        const scriptStuck = outcome === "persistent-script" || outcome === "script-http-limit" || outcome === "script-recovery" && navigations < 2;
        dom.document.body.innerHTML = outcome === "script-gate" ? '<main aria-busy="true">请先登录</main>' : scriptStuck ? '<main aria-busy="true">正在加载</main>' : currentUrl === url
          ? '<article class="jobCardPcContainer"><a href="https://www.liepin.com/job/123456789.shtml"><span class="jobTitleBox">C# 工程师</span></a><span class="companyName">合成公司</span><span class="labels-box">上海</span></article>' : "";
        return { result: { value: runInNewContext(String(params?.expression), {
          document: dom.document, getComputedStyle: dom.getComputedStyle.bind(dom), location: new URL(currentUrl), window: { scrollBy() {} },
        }) } } as T;
      },
    };
    let settled = false;
    const pending = captureProviderViaNativeCdp(cdp, { provider: "liepin", platform: "猎聘", url }, [], "C#", undefined, 0, "quick", 1,
      undefined, undefined, async diagnostic => { diagnostics.push(diagnostic); return undefined; }).finally(() => { settled = true; });
    for (let i = 0; i < 180 && !settled; i++) { t.mock.timers.tick(250); await new Promise<void>(resolve => setImmediate(resolve)); }
    try {
      assert.equal(settled, true);
      const result = await pending;
      assert.equal(createdUrl, "about:blank", "attach observers before starting exactly one owned navigation");
      assert.equal(stops, 0, "do not cancel Chrome's initial document load");
      assert.equal(navigations, ["persistent-blank", "blank-recovery", "script-recovery", "persistent-script"].includes(outcome) ? 2 : 1, "only an inert blank or unrestricted failed-script loading shell gets one bounded recovery");
      if (outcome === "script-gate" || outcome === "script-http-limit") {
        assert.equal(result.cards.length, 0);
        assert.equal(result.coverage.failureKind, outcome === "script-gate" ? "login" : "platform_limit");
      } else if (outcome === "persistent-blank") {
        assert.equal(result.cards.length, 0);
        assert.equal(result.coverage.failureKind, "unknown", "blank without failed requests is not proven network failure");
        assert.equal(diagnostics.length, 1);
      } else if (outcome === "persistent-script") {
        assert.equal(result.cards.length, 0);
        assert.equal(result.coverage.failureKind, "timeout");
        assert.equal(diagnostics.length, 1);
        assert.ok(Date.now() - started < 45_000, "failed scripts cannot cause unlimited refreshes");
      } else {
        assert.equal(result.cards.length, 1, "a navigation command timeout does not cancel a successfully loading document");
        assert.equal(result.status, "ready");
        if (outcome === "script-recovery") {
          assert.equal(diagnostics.length, 1, "keep the failed-page observation even after recovery");
          assert.equal((diagnostics[0] as { observations: Array<{ recovered: boolean }> }).observations[0]?.recovered, true);
          assert.equal(result.coverage.failureKind, undefined);
        }
      }
    } finally { await dom.happyDOM.abort(); }
  });
}

test("verification redirect is a gate even when structural snapshot projection fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const url = "https://www.zhipin.com/web/geek/job?query=C%23&city=101020100";
  const cdp: NativeCdp = {
    ...cdpReturning(undefined),
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.createTarget") return { targetId: "owned-gate" } as T;
      if (method === "Target.attachToTarget") return { sessionId: "owned-session" } as T;
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "owned-gate", type: "page", url }] } as T;
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("redirect changed document URL");
      if (method !== "Runtime.evaluate") return {} as T;
      const expression = String(params?.expression);
      const value = expression.includes("return cards;") ? [] : expression.includes("marker:")
        ? { url: "https://www.zhipin.com/web/user/safe/verify", marker: "" }
        : expression.includes("candidateLinks:") ? { readyState: "complete", route: "verification", failure: "verification", candidateLinks: 0, listRoots: 0, loadingIndicators: 0 }
        : { advanced: false, kind: "scroll", exhausted: false };
      return { result: { value } } as T;
    },
  };
  let settled = false;
  const pending = captureProviderViaNativeCdp(cdp, { provider: "boss", platform: "BOSS直聘", url }, [], "C#")
    .finally(() => { settled = true; });
  for (let i = 0; i < 80 && !settled; i++) {
    t.mock.timers.tick(250);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const result = await pending;
  assert.equal(result.status, "verification_required");
  assert.equal(result.coverage.stopReason, "gate");
  assert.equal(result.coverage.partial, true);
});

for (const outcome of ["loading-timeout", "loading-stuck", "cancelled", "empty", "gate"] as const) {
  test(`initial page readiness handles ${outcome} without advancing to another page`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const pageUrl = "https://we.51job.com/pc/search?keyword=Java&jobArea=020000&searchType=2";
    const target = { targetId: "readiness-target", type: "page", url: pageUrl };
    const message = outcome === "empty" ? "暂无匹配岗位" : outcome === "gate" ? "请完成人机验证" : "正在加载岗位";
    const controller = new AbortController();
    let snapshotReads = 0;
    let paginationInputs = 0;
    let focusRequests = 0;
    const startedAt = Date.now();
    const cdp: NativeCdp = {
      ...cdpReturning(undefined),
      async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === "Target.createTarget") return { targetId: target.targetId } as T;
        if (method === "Target.attachToTarget") return { sessionId: "readiness-session" } as T;
        if (method === "Target.getTargets") return { targetInfos: [target] } as T;
        if (method === "Page.navigate") { if (params?.url !== pageUrl) paginationInputs++; return {} as T; }
        if (method === "DOMSnapshot.captureSnapshot") { snapshotReads++; return readinessSnapshot(pageUrl, message) as T; }
        if (method !== "Runtime.evaluate") return {} as T;
        const expression = String(params?.expression);
        if (expression.includes("btn.click()")) paginationInputs++;
        const value = expression.includes("candidateLinks:") && outcome === "loading-stuck" ? { readyState: "interactive", route: "search", failure: "unknown", loadingIndicators: 1 }
          : expression.includes("return cards;") ? [] : expression.includes("marker:")
          ? { url: pageUrl, marker: "" } : { advanced: false, kind: "page", exhausted: false };
        return { result: { value } } as T;
      },
    };
    let settled = false;
    const pending = captureProviderViaNativeCdp(cdp, { provider: "51job", platform: "51JOB", url: pageUrl },
      [target], "Java", controller.signal, outcome === "gate" ? 2_500 : 0, "quick", 2,
      async () => { focusRequests++; if (outcome === "gate") controller.abort(); return true; }, undefined, async () => undefined).finally(() => { settled = true; });
    for (let turn = 0; turn < 110 && !settled; turn++) {
      t.mock.timers.tick(250);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === "cancelled" && snapshotReads > 0) controller.abort();
    }
    assert.equal(settled, true, "unknown page markup must not extend the absolute readiness deadline");
    const result = await pending;
    assert.equal(paginationInputs, 0, "readiness failures and terminal results must never trigger a pagination action");
    assert.equal(result.cards.length, 0);
    assert.equal(result.coverage?.pagesVisited, 1, "readiness retries do not count as additional pages");
    assert.equal(result.status, outcome === "empty" ? "empty" : outcome === "gate" ? "verification_required" : "unknown_layout");
    assert.equal(result.coverage?.stopReason, outcome.startsWith("loading") ? "no_progress" : outcome === "empty" ? "exhausted" : outcome === "gate" ? "cancelled" : outcome);
    assert.equal(result.coverage?.partial, outcome !== "empty");
    assert.equal(focusRequests, outcome === "gate" ? 1 : 0, "only an explicitly enabled interactive gate may request browser focus");
    if (outcome.startsWith("loading")) {
      assert.ok(snapshotReads > 1, "an unknown loading shell must be re-read");
      const deadline = outcome === "loading-stuck" ? 20_000 : 8_000;
      assert.ok(Date.now() - startedAt >= deadline && Date.now() - startedAt <= deadline + 2_000, "readiness waits are bounded even if the shell never changes");
    } else {
      assert.equal(snapshotReads, 1, "cancellation, explicit empty results and gates do not repeat the readiness wait");
      assert.ok(Date.now() - startedAt < 4_000);
    }
  });
}

test("a fired pagination click is verified, then falls back only to the bounded next-page URL", async () => {
  const events: string[] = [];
  const transition = await confirmLiveSearchPageAdvance({
    provider: "liepin",
    expectedPageUrl: "https://www.liepin.com/zhaopin/?key=Java&currentPage=2",
    waitForTransition: async (expectedUrl, timeout) => {
      events.push(`wait:${expectedUrl ?? "click"}:${timeout}`);
      return expectedUrl ? { advanced: true, pageUrl: expectedUrl, cards: [card(2, expectedUrl)] } : { advanced: false };
    },
    navigateTo: async (pageUrl) => { events.push(`navigate:${pageUrl}`); },
  });
  assert.equal(transition.advanced, true);
  assert.deepEqual(events, [
    "wait:click:2500",
    "navigate:https://www.liepin.com/zhaopin/?key=Java&currentPage=2",
    "wait:https://www.liepin.com/zhaopin/?key=Java&currentPage=2:6000",
  ]);
});

test("BOSS never synthesizes a paginated route when click and virtual scroll do not advance", async () => {
  const events: string[] = [];
  const transition = await confirmLiveSearchPageAdvance({
    provider: "boss",
    expectedPageUrl: "https://www.zhipin.com/web/geek/job?query=Java&page=2",
    waitForTransition: async (expectedUrl, timeout) => { events.push(`wait:${expectedUrl ?? "undefined"}:${timeout}`); return { advanced: false }; },
    navigateTo: async (pageUrl) => { events.push(`navigate:${pageUrl}`); },
  });
  assert.equal(transition.advanced, false);
  assert.deepEqual(events, ["wait:undefined:2500"]);
});

test("page, card, scroll, and cancellation budgets stop with explicit partial coverage", () => {
  const currentPageUrl = "https://we.51job.com/pc/search?keyword=Java&pageNum=15";
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: true, kind: "page", exhausted: false }, provider: "51job", currentPage: 15,
    pageLimit: 15, currentPageUrl,
  }), { action: "stop", stopReason: "page_limit" });

  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: true, kind: "scroll", exhausted: false }, provider: "boss", currentPage: 1,
    pageLimit: 15, currentPageUrl: "https://www.zhipin.com/web/geek/job?query=Java",
    cardLimitReached: true,
  }), { action: "stop", stopReason: "card_limit" });

  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: true, kind: "page", exhausted: false }, provider: "51job", currentPage: 1,
    pageLimit: 15, currentPageUrl, cancelled: true,
  }), { action: "stop", stopReason: "cancelled" });

  const scrollBudgetCoverage = createLiveBatchCoverage({
    pagesVisited: 1, scrollSteps: 20, scrollLimit: 20, pageLimit: 1, cardLimit: 3000, stopReason: "scroll_limit",
  });
  assert.equal(scrollBudgetCoverage.partial, true);
  assert.equal(scrollBudgetCoverage.stopReason, "scroll_limit");
  assert.equal(scrollBudgetCoverage.scrollSteps, scrollBudgetCoverage.scrollLimit);
});

test("coverage is complete only after verified exhaustion; budget, gate, and errors remain partial", () => {
  const exhausted = createLiveBatchCoverage({ pagesVisited: 4, pageLimit: 15, cardLimit: 1500, stopReason: "exhausted" });
  assert.equal(exhausted.partial, false);
  assert.equal(exhausted.stopReason, "exhausted");

  for (const stopReason of ["page_limit", "scroll_limit", "card_limit", "no_progress", "gate", "error", "cancelled"] as const) {
    const coverage = createLiveBatchCoverage({ pagesVisited: 15, scrollSteps: 20, scrollLimit: 20, pageLimit: 15, cardLimit: 1500, stopReason });
    assert.equal(coverage.partial, true, stopReason);
    assert.equal(coverage.stopReason, stopReason);
  }

  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "page", exhausted: true }, provider: "liepin", currentPage: 2,
    pageLimit: 15, currentPageUrl: "https://www.liepin.com/zhaopin/?key=Java", cancelled: true,
  }), { action: "stop", stopReason: "cancelled" }, "cancellation wins over a stale exhausted-page observation");
});

test("page-limit takes precedence over a final numbered page result", () => {
  const currentPageUrl = "https://we.51job.com/pc/search?keyword=Java&pageNum=15";
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "page", exhausted: true }, provider: "51job", currentPage: 15,
    pageLimit: 15, currentPageUrl,
  }), { action: "stop", stopReason: "page_limit" });
});

test("BOSS virtual-list exhaustion is not mislabeled as a numbered-page limit", () => {
  const currentPageUrl = "https://www.zhipin.com/web/geek/job?query=Java&city=101020100";
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "scroll", exhausted: true }, provider: "boss", currentPage: 1,
    pageLimit: 1, currentPageUrl,
  }), { action: "stop", stopReason: "exhausted" });
  assert.deepEqual(decideLiveBatchAdvance({
    advance: { advanced: false, kind: "scroll", exhausted: false }, provider: "boss", currentPage: 1,
    pageLimit: 1, currentPageUrl,
  }), { action: "stop", stopReason: "no_progress" });
});
