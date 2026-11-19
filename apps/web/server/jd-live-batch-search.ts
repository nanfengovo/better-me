import {
  buildPlatformSearchRequest,
  resolvePlatformSearchRegion,
  type PlatformSearchProvider,
} from "@better-me/source-adapters";
import { checkCdpRunning, connectRealChromeCdp, launchRealChromeCdp, focusRealChromeWindow } from "./jd-real-chrome-launcher";
import type { NativeCdp, NativeTargetList } from "./jd-native-cdp";
import { extractJobSearchCards, type JobSearchCard } from "./jd-search-capture";
import { getNetworkFetch } from "./network-proxy";
import type { JobPlatform } from "../src/lib/jd-source";
import { classifyHarvestFailure, harvestDiagnosticRetentionLabel, retainHarvestDiagnostic, type HarvestDiagnostic } from "./jd-harvest-diagnostics";
import { idleLiveSearchTabs, liveSearchTabsFor, type LiveSearchTabs } from "./jd-live-search-tabs";
import {
  areAllLinkedInPagesExplicitlyEmpty,
  createLiveBatchCoverage,
  expandLinkedInQueryUrls,
  isCompleteLinkedInEmptyResult,
  LiveBatchSearchInputSchema,
  liveBatchCardBudget,
  liveBatchPageBudget,
  liveBatchProviderPageBudget,
  mapWithConcurrency,
  safelyReport,
  sanitizeProgressCardBatches,
  sanitizeReviewedCards,
  type LiveBatchProviderProgress,
  type LiveBatchProviderResult,
  type LiveBatchSearchCallbacks,
  type LiveBatchSearchResult,
  type LiveBatchStopReason,
} from "./jd-live-search-cards";
import { captureProviderViaNativeCdp } from "./jd-live-cdp-capture";

export * from "./jd-live-search-cards";
export { captureProviderViaNativeCdp } from "./jd-live-cdp-capture";

export async function fetchLinkedInDirect(
  plan: { provider: PlatformSearchProvider; platform: JobPlatform; url: string },
  _keyword: string,
  signal?: AbortSignal,
  depth: "quick" | "standard" | "deep" = "quick",
  maxPages?: number,
  onProgress?: (progress: LiveBatchProviderProgress) => void | Promise<void>,
  fetchers?: ReadonlyArray<(url: string) => Promise<Response>>,
): Promise<LiveBatchProviderResult> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const makeSignal = () =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(8_500)]) : AbortSignal.timeout(8_500);

  const pageLimit = liveBatchPageBudget(depth, maxPages);
  const cardLimit = liveBatchCardBudget(depth);
  const pageUrls = expandLinkedInQueryUrls(plan.url, pageLimit);
  let pagesVisited = 0;
  let cardsCaptured = 0;
  const publishedCardIds = new Set<string>();
  let platformLimited = false;
  const reportProgress = async (newCards: JobSearchCard[] = []) => {
    const remainingCardBudget = cardLimit - publishedCardIds.size;
    const batches = remainingCardBudget > 0
      ? sanitizeProgressCardBatches(newCards, "linkedin", plan.url, _keyword, remainingCardBudget, publishedCardIds)
      : [];
    const progressBase = {
      provider: "linkedin" as const,
      platform: "LinkedIn" as const,
      pagesVisited,
      scrollSteps: 0,
      cardsCaptured,
    };
    if (!batches.length) {
      await safelyReport(() => onProgress?.(progressBase));
      return;
    }
    for (const cards of batches) {
      await safelyReport(() => onProgress?.({ ...progressBase, cards }));
    }
  };
  const output: Array<PromiseSettledResult<ReturnType<typeof extractJobSearchCards>>> = Array(pageUrls.length);
  const failures = new Map<number, { failure: HarvestDiagnostic["observations"][number]["failure"]; httpStatus?: number }>();
  const fetchPages = async (fetcher: (url: string) => Promise<Response>) => {
    const indices = pageUrls.map((_, i) => i).filter(i => !output[i] || (output[i]?.status === "rejected" && ["network", "timeout"].includes(failures.get(i)?.failure ?? "")));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, indices.length) }, async () => {
      while (cursor < indices.length && !signal?.aborted && !platformLimited) {
        const index = indices[cursor++]!;
        try {
          const response = await fetcher(pageUrls[index]!);
          if (!response.ok) {
            failures.set(index, { failure: classifyHarvestFailure(undefined, response.status), httpStatus: response.status });
            if ([401, 403, 429, 999].includes(response.status)) platformLimited = true;
            await response.body?.cancel().catch(() => {});
            throw new Error("HTTP failure");
          }
          const value = extractJobSearchCards(
            { url: pageUrls[index]!, title: "LinkedIn Search", html: await response.text() },
            "LinkedIn",
          );
          if (value.status === "login_required" || value.status === "verification_required") platformLimited = true;
          pagesVisited++;
          output[index] = { status: "fulfilled", value };
          // Parse and publish at page completion, not after every response has
          // arrived. The indexed result still gives the final receipt stable
          // page ordering when concurrent requests finish out of order.
          if (value.status === "ready") cardsCaptured += value.cards.length;
          await reportProgress(value.status === "ready" ? value.cards : []);
        }
        catch (reason) {
          if (!failures.has(index) || ["network", "timeout"].includes(failures.get(index)!.failure)) failures.set(index, { failure: classifyHarvestFailure(reason) });
          await reportProgress(); output[index] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    return output;
  };

  let finalPagesVisited = 0;
  let finalFailedPages = 0;
  const warnings: string[] = [];
  const transports = fetchers ?? [
    async (u: string) => (await getNetworkFetch())(u, { headers, signal: makeSignal() }),
    (u: string) => fetch(u, { headers, signal: makeSignal() }),
  ];
  for (const [transportIndex, fetcherFactory] of transports.entries()) {
    let failedPages = 0;
    try {
      const responses = await fetchPages(fetcherFactory);
      const recoverable = responses.some((response, index) => response?.status === "rejected" && ["network", "timeout"].includes(failures.get(index)?.failure ?? ""));
      if (!signal?.aborted && !platformLimited && recoverable && transportIndex < transports.length - 1) continue;
      const observations: HarvestDiagnostic["observations"] = pageUrls.flatMap((_, index) => {
        const res = responses[index];
        const failure = failures.get(index);
        if (!failure && res?.status === "fulfilled" && ["ready", "empty"].includes(res.value.status)) return [];
        const status = res?.status === "fulfilled" ? res.value.status : undefined;
        return [{ page: index + 1, phase: "request" as const,
          ...(failure ?? { failure: status === "login_required" ? "login" as const : status === "verification_required" ? "verification" as const : platformLimited ? "platform_limit" as const : "layout" as const }),
          attempted: !!res, recovered: !!failure && res?.status === "fulfilled" }];
      });
      if (observations.length) {
        const id = await retainHarvestDiagnostic({ provider: "linkedin", observations });
        warnings.push(`脱敏诊断${harvestDiagnosticRetentionLabel(id)}：${[...new Set(observations.map(o => o.failure))].join("、")}；未保存页面正文或身份信息。`);
      }
      const allRawCards: JobSearchCard[] = [];
      let primaryUrl = plan.url;
      const pageStatuses: string[] = [];

      for (let i = 0; i < responses.length; i++) {
        const res = responses[i];
        if (!res || res.status !== "fulfilled") { failedPages++; continue; }
        const extracted = res.value;
        pageStatuses.push(extracted.status);
        if (i === 0 && extracted.url) primaryUrl = extracted.url;
        if (extracted.status === "ready" && extracted.cards.length > 0) {
          allRawCards.push(...extracted.cards);
        }
        for (const w of extracted.warnings) {
          if (!warnings.includes(w)) warnings.push(w);
        }
      }

      if (allRawCards.length > 0) {
        const cards = sanitizeReviewedCards(allRawCards, "linkedin", primaryUrl, _keyword, cardLimit);
        if (failedPages > 0) {
          warnings.push(`LinkedIn 有 ${failedPages}/${pageLimit} 个分页请求未成功；当前保留成功页面核验到的 ${cards.length} 条岗位，结果为部分覆盖。`);
        }
        const stopReason: LiveBatchStopReason = signal?.aborted
          ? "cancelled"
          : platformLimited ? "gate"
          : failedPages > 0
          ? "error"
          : allRawCards.length >= cardLimit
            ? "card_limit"
            : pagesVisited >= pageLimit
              ? "page_limit"
              : "exhausted";
        const failureKind = [...failures.values()].find(f => ["platform_limit", "login", "verification"].includes(f.failure))?.failure
          ?? observations.find(o => !o.recovered)?.failure;
        return {
          provider: "linkedin",
          platform: "LinkedIn",
          pageUrl: primaryUrl,
          status: cards.length > 0 ? "ready" : "unknown_layout",
          cards,
          rawCardCount: allRawCards.length,
          warnings: cards.length > 0 ? warnings : [...warnings, "平台返回岗位候选，但没有卡片通过来源身份与字段证据校验；不将其判为零岗位。"],
          coverage: createLiveBatchCoverage({ pagesVisited, pageLimit, cardLimit, stopReason, failureKind }),
        };
      }
      if (!signal?.aborted && areAllLinkedInPagesExplicitlyEmpty(pageStatuses, failedPages)) {
        const completeEmpty = isCompleteLinkedInEmptyResult(pageStatuses, failedPages, pagesVisited, pageLimit);
        const reachedBudget = !completeEmpty;
        return {
          provider: "linkedin", platform: "LinkedIn", pageUrl: primaryUrl, status: "empty", cards: [], rawCardCount: 0,
          warnings: reachedBudget
            ? [...warnings, "预算内读取的 LinkedIn 搜索页均为空；已达到页数上限，不能据此证明网站全量无岗位。"]
            : warnings,
          coverage: createLiveBatchCoverage({ pagesVisited, pageLimit, cardLimit, stopReason: completeEmpty ? "exhausted" : "page_limit" }),
        };
      }
      finalPagesVisited = pagesVisited;
      finalFailedPages = failedPages;
    } catch {
      // try next fetcher
    }
    if (signal?.aborted || platformLimited) break;
  }
  const stopReason: LiveBatchStopReason = signal?.aborted ? "cancelled" : platformLimited ? "gate" : finalPagesVisited === 0 || finalFailedPages > 0 ? "error" : "no_progress";
  return {
    provider: "linkedin", platform: "LinkedIn", pageUrl: plan.url,
    status: "error", cards: [], rawCardCount: 0,
    warnings: [...warnings, "未能从 LinkedIn 实时读取到可验证的搜索列表响应；不将连接失败或平台限制当作零岗位。"],
    coverage: createLiveBatchCoverage({ pagesVisited: finalPagesVisited, pageLimit, cardLimit, stopReason, failureKind: platformLimited ? [...failures.values()].find(f => ["platform_limit", "login", "verification"].includes(f.failure))?.failure ?? "verification" : [...failures.values()][0]?.failure ?? "layout" }),
    error: "LinkedIn 搜索列表当前不可读取。",
  };
}

export function buildLiveBatchSearchPlans(rawInput: unknown) {
  const input = LiveBatchSearchInputSchema.parse(rawInput);
  const resolvedRegion = input.regionId ? resolvePlatformSearchRegion(input.regionId) : undefined;
  const providers: PlatformSearchProvider[] = input.providers ?? ["liepin", "51job", "boss", "linkedin"];
  const plans = providers.map((provider) => {
    const plan = buildPlatformSearchRequest({
      provider,
      keyword: input.keyword,
      districtCode: input.districtCode,
      ...(resolvedRegion && resolvedRegion.platforms[provider] !== undefined
        ? { regionId: resolvedRegion.id }
        : {}),
    });
    const sortedPlan = provider === "linkedin"
      ? (() => {
          const url = new URL(plan.url);
          url.searchParams.set("sortBy", "DD");
          return { ...plan, url: url.toString() };
        })()
      : plan;
    return input.regionId && (!resolvedRegion || resolvedRegion.platforms[provider] === undefined)
      ? { ...sortedPlan, warnings: [...sortedPlan.warnings, `请求地区“${input.regionId}”没有该平台的已配置映射；使用平台默认地区读取，返回卡片必须按披露地点复核，不代表已覆盖请求地区。`] }
      : sortedPlan;
  });
  return plans;
}

export async function runLiveBatchSearch(
  rawInput: unknown,
  signal?: AbortSignal,
  callbacks: LiveBatchSearchCallbacks = {},
  owner = "internal",
): Promise<LiveBatchSearchResult> {
  const input = LiveBatchSearchInputSchema.parse(rawInput);
  const plans = buildLiveBatchSearchPlans(input);

  const capturedAt = new Date().toISOString();
  if (signal?.aborted) return { capturedAt, results: [] };
  const reportedProviders = new Set<PlatformSearchProvider>();
  const reportResult = async (result: LiveBatchProviderResult) => {
    if (reportedProviders.has(result.provider)) return;
    reportedProviders.add(result.provider);
    await safelyReport(() => callbacks.onProviderResult?.(result));
  };
  const linkedinPlan = plans.find((p) => p.provider === "linkedin");
  const browserPlans = plans.filter((p) => p.provider !== "linkedin");

  for (const plan of plans) {
    await safelyReport(() => callbacks.onProviderQueued?.(plan.provider, plan.platform));
  }

  const linkedinPromise = (async () => {
    if (!linkedinPlan) return undefined;
    await safelyReport(() => callbacks.onProviderStart?.(linkedinPlan.provider, linkedinPlan.platform));
    try {
      const result = await fetchLinkedInDirect(linkedinPlan, input.keyword, signal, input.depth, input.maxPages, callbacks.onProviderProgress);
      await reportResult(result);
      return result;
    } catch (error) {
      const result: LiveBatchProviderResult = {
        provider: linkedinPlan.provider,
        platform: linkedinPlan.platform,
        pageUrl: linkedinPlan.url,
        status: "error",
        cards: [],
        rawCardCount: 0,
        warnings: [],
        coverage: createLiveBatchCoverage({
          pageLimit: liveBatchProviderPageBudget(linkedinPlan.provider, input.depth, input.maxPages),
          cardLimit: liveBatchCardBudget(input.depth),
          stopReason: signal?.aborted ? "cancelled" : "error",
        }),
        error: error instanceof Error ? error.message : "未能读取 LinkedIn 数据",
      };
      await reportResult(result);
      return result;
    }
  })();

  let browserResults: LiveBatchProviderResult[] = [];
  if (browserPlans.length > 0) {
    const isRunning = await checkCdpRunning(9222);
    if (!isRunning) {
      // The launch page is a neutral keep-alive, never a duplicate search.
      await launchRealChromeCdp(9222, "about:blank");
    }
    let cdp: NativeCdp | undefined;
    let tabs: LiveSearchTabs | undefined;
    try {
      tabs = input.collectionSessionId ? liveSearchTabsFor(input.collectionSessionId, owner, input.visualFallback === true) : undefined;
      cdp = await connectRealChromeCdp();
      const targets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 3000);
      // Each provider gets an owned background target. A small concurrency cap
      // reduces additive cross-platform latency without opening an unbounded
      // number of tabs or making per-provider pagination less strict.
      browserResults = await mapWithConcurrency(browserPlans, 2, async (plan) => {
        if (signal?.aborted) return undefined;
        await safelyReport(() => callbacks.onProviderStart?.(plan.provider, plan.platform));
        try {
          const res = await captureProviderViaNativeCdp(
            cdp!,
            plan,
            targets.targetInfos,
            input.keyword,
            signal,
            input.interactiveWaitMs,
            input.depth,
            input.maxPages,
            focusRealChromeWindow,
            callbacks.onProviderProgress,
            undefined,
            tabs,
            input.visualFallback ? tabs?.visualRecovery : undefined,
          );
          await reportResult(res);
          return res;
        } catch (error) {
          const failed: LiveBatchProviderResult = {
            provider: plan.provider,
            platform: plan.platform,
            pageUrl: plan.url,
            status: "error" as const,
            cards: [],
            rawCardCount: 0,
            warnings: [],
            coverage: createLiveBatchCoverage({ pageLimit: liveBatchProviderPageBudget(plan.provider, input.depth, input.maxPages), cardLimit: liveBatchCardBudget(input.depth), stopReason: "error" }),
            error: error instanceof Error ? error.message : "未能读取平台数据",
          };
          await reportResult(failed);
          return failed;
        }
      }).then((results) => results.filter((result): result is LiveBatchProviderResult => result !== undefined));
    } catch (error) {
      browserResults = browserPlans.map((plan) => ({
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "error" as const,
        cards: [],
        rawCardCount: 0,
        warnings: [],
        coverage: createLiveBatchCoverage({ pageLimit: liveBatchProviderPageBudget(plan.provider, input.depth, input.maxPages), cardLimit: liveBatchCardBudget(input.depth), stopReason: "error" }),
        error: error instanceof Error ? error.message : "未能连接真实 Chrome 调试端口 9222",
      }));
      for (const result of browserResults) {
        await safelyReport(() => callbacks.onProviderStart?.(result.provider, result.platform));
        await reportResult(result);
      }
    } finally {
      if (signal?.aborted && cdp) await tabs?.close(cdp);
      cdp?.close();
      if (input.collectionSessionId) idleLiveSearchTabs(input.collectionSessionId, owner);
    }
  }

  const results: LiveBatchProviderResult[] = [];
  const linkedinDirectResult = await linkedinPromise;

  for (const plan of plans) {
    if (plan.provider === "linkedin") {
      if (linkedinDirectResult) {
        results.push(linkedinDirectResult);
        await reportResult(linkedinDirectResult);
      }
    } else {
      const found = browserResults.find((r) => r.provider === plan.provider);
      if (found) results.push(found);
    }
  }

  return {
    capturedAt,
    results,
    ...(input.collectionSessionId ? { collectionSessionId: input.collectionSessionId } : {}),
  };
}
