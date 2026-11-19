import {
  reviewedCardIdentity,
  reviewedCardsSearchPage,
  type PlatformSearchProvider,
} from "@better-me/source-adapters";
import { focusRealChromeWindow } from "./jd-real-chrome-launcher";
import { type NativeCdp, type NativeTargetList } from "./jd-native-cdp";
import { NATIVE_ROOT_SCROLL_STYLES, projectNativeDomSnapshot } from "./jd-cdp-dom-snapshot";
import { extractJobSearchCards, type JobSearchCard } from "./jd-search-capture";
import type { JobPlatform } from "../src/lib/jd-source";
import {
  classifyHarvestFailure,
  HARVEST_PAGE_OBSERVATION,
  HarvestDiagnosticSchema,
  retainHarvestDiagnostic,
  harvestDiagnosticRetentionLabel,
} from "./jd-harvest-diagnostics";
import { type LiveSearchTabs, type LiveSearchTabLease } from "./jd-live-search-tabs";
import { nativeVisualDriver, type HarvestVisualRecovery } from "./jd-harvest-visual";
import {
  clickPlatformNextPage,
  confirmLiveSearchPageAdvance,
  createLiveBatchCoverage,
  decideBossScrollBoundary,
  decideLiveBatchAdvance,
  extractCardsFromRawDomSnapshot,
  extractCardsViaEvaluate,
  getPlatformExpandedUrls,
  isBOSSListLoading,
  isHarvestBootstrapRequest,
  liveBatchCardBudget,
  liveBatchProviderPageBudget,
  liveBatchScrollBudget,
  pauseLiveSearchReadiness,
  readLiveSearchPageState,
  safelyReport,
  sanitizeProgressCardBatches,
  sanitizeReviewedCards,
  searchCardSignature,
  waitForLiveSearchPageTransition,
  waitForUnseenCardsAfterScroll,
  type LiveBatchCoverage,
  type LiveBatchProviderProgress,
  type LiveBatchProviderResult,
  type LiveBatchStopReason,
  type LiveSearchPageState,
} from "./jd-live-search-cards";

export async function captureProviderViaNativeCdp(
  cdp: NativeCdp,
  plan: { provider: PlatformSearchProvider; platform: JobPlatform; url: string },
  _existingTargets: NativeTargetList["targetInfos"],
  keyword: string,
  signal?: AbortSignal,
  interactiveWaitMs?: number,
  depth: "quick" | "standard" | "deep" = "quick",
  maxPages?: number,
  focusForInteractiveWait: (port: number) => Promise<boolean> = focusRealChromeWindow,
  onProviderProgress?: (progress: LiveBatchProviderProgress) => void | Promise<void>,
  retainDiagnostic: typeof retainHarvestDiagnostic = retainHarvestDiagnostic,
  tabs?: LiveSearchTabs,
  visualRecovery?: HarvestVisualRecovery,
): Promise<LiveBatchProviderResult> {
  let targetId: string | undefined;
  let ownsTarget = false;
  let preserveTargetForInteractiveLogin = false;
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const pendingRequests = new Set<string>();
  const pendingBootstrapRequests = new Set<string>();
  const requestTypes = new Map<string, string>();
  let failedRequests = 0;
  let failedDocuments = 0, failedScripts = 0, failedDataRequests = 0, limitedDataResponses = 0;
  let documentStatus: number | undefined;
  let lease: LiveSearchTabLease | undefined;
  let reusable = false;

  try {
    // Never attach to an arbitrary platform tab. Even a matching query can be
    // scrolled by the virtual-list reader; stale queries would also be navigated.
    lease = tabs ? await tabs.acquire(cdp, plan.provider, plan.url) : undefined;
    const created = lease ?? await cdp.send<{ targetId?: string }>(
      "Target.createTarget",
      // Attach Network/Page observers before navigation. Creating at the real
      // URL then stopping an apparently blank target races Chrome's first load.
      { url: "about:blank", background: true },
      undefined,
      4000,
    );
    targetId = created.targetId;
    ownsTarget = Boolean(targetId);
    if (!targetId) {
      return {
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "error",
        cards: [],
        rawCardCount: 0,
        warnings: [],
        coverage: createLiveBatchCoverage({ pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: liveBatchCardBudget(depth), stopReason: "error" }),
        error: "无法创建平台搜索标签页",
      };
    }

    const attached = await cdp.send<{ sessionId?: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
      undefined,
      4000,
    );
    sessionId = attached.sessionId;
    if (!sessionId) {
      return {
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "error",
        cards: [],
        rawCardCount: 0,
        warnings: [],
        coverage: createLiveBatchCoverage({ pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: liveBatchCardBudget(depth), stopReason: "error" }),
        error: "无法附着到平台搜索标签页",
      };
    }

    await cdp.send("Page.enable", {}, sessionId, 3000).catch(() => {});
    unsubscribe = cdp.on(event => {
      if (event.sessionId !== sessionId) return;
      const params = event.params ?? {};
      const id = typeof params.requestId === "string" ? params.requestId : "";
      if (event.method === "Network.requestWillBeSent" && ["Document", "XHR", "Fetch", "Script"].includes(String(params.type)) && pendingRequests.size < 10000) {
        pendingRequests.add(id); requestTypes.set(id, String(params.type));
        if (isHarvestBootstrapRequest(plan.provider, String(params.type), (params.request as { url?: unknown } | undefined)?.url)) pendingBootstrapRequests.add(id);
      }
      if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") {
        if (event.method === "Network.loadingFailed" && pendingRequests.has(id)) {
          failedRequests = Math.min(10000, failedRequests + 1);
          const type = requestTypes.get(id);
          if (type === "Document") failedDocuments = Math.min(10000, failedDocuments + 1);
          if (type === "Script") failedScripts = Math.min(10000, failedScripts + 1);
          if (type === "XHR" || type === "Fetch") failedDataRequests = Math.min(10000, failedDataRequests + 1);
        }
        pendingRequests.delete(id); pendingBootstrapRequests.delete(id); requestTypes.delete(id);
      }
      // A restricted ad/analytics XHR alone is not a blocked jobs API.
      if (event.method === "Network.responseReceived" && ["XHR", "Fetch"].includes(String(params.type))
        && [401, 403, 429, 999].includes(Number((params.response as { status?: unknown } | undefined)?.status))) limitedDataResponses = Math.min(10000, limitedDataResponses + 1);
      if (event.method === "Network.responseReceived" && params.type === "Document") {
        const status = (params.response as { status?: unknown } | undefined)?.status;
        if (typeof status === "number" && status >= 100 && status <= 999) documentStatus = status;
      }
    });
    await cdp.send("Network.enable", {}, sessionId, 3000).catch(() => {});

    const pageLimit = liveBatchProviderPageBudget(plan.provider, depth, maxPages);
    const pageUrls = getPlatformExpandedUrls(plan.provider, plan.url, keyword, pageLimit);
    const allRawCards: JobSearchCard[] = [];
    const seenCardKeys = new Set<string>();
    const allWarnings: string[] = [];
    let lastStatus: LiveBatchProviderResult["status"] = "unknown_layout";
    let lastPageUrl = plan.url;

    const maxCardCap = liveBatchCardBudget(depth);
    const maxScrollSteps = liveBatchScrollBudget(plan.provider, depth);
    let pagesVisited = 0;
    let lastVisitedPage = 0;
    let scrollSteps = 0;
    let noProgressScrolls = 0;
    let noProgressPages = 0;
    let stopReason: LiveBatchStopReason = "page_limit";
    let operationTimedOut = false;
    let pageScrolled = false;
    let lastPageState: LiveSearchPageState | undefined;
    let attemptedPage = 1;
    const publishedCardIds = new Set<string>();
    const reportProgress = async (newCards: JobSearchCard[] = []) => {
      const batches = sanitizeProgressCardBatches(newCards, plan.provider, lastPageUrl, keyword, maxCardCap, publishedCardIds);
      const progressBase = {
        provider: plan.provider,
        platform: plan.platform,
        pagesVisited,
        scrollSteps,
        cardsCaptured: allRawCards.length,
      };
      if (!batches.length) {
        await safelyReport(() => onProviderProgress?.(progressBase));
        return;
      }
      for (const cards of batches) {
        await safelyReport(() => onProviderProgress?.({ ...progressBase, cards }));
      }
    };

    const addCards = (cards: JobSearchCard[]) => {
      const added: JobSearchCard[] = [];
      for (const c of cards) {
        const identity = reviewedCardIdentity(c.url, plan.provider);
        const key = identity?.id ?? `${c.title}__${c.company}`;
        if (!seenCardKeys.has(key)) {
          seenCardKeys.add(key);
          allRawCards.push(c);
          added.push(c);
        }
      }
      return added;
    };

    let pageReadinessDeadline = Date.now() + 8_000;
    let pageReadinessBudgetMs = 8_000;
    let readinessExtended = false;
    let blankRecoveryUsed = false;
    let navigationCommandFailed = false;
    let pageFailedScriptsBaseline = 0;
    const reloadObservations = new Map<number, Record<string, unknown>>();
    const navigationTimeoutObservations: Record<string, unknown>[] = [];
    const readPageEvidence = async (): Promise<Record<string, unknown>> => {
      try {
        const result = await cdp.send<{ result?: { value?: Record<string, unknown> } }>("Runtime.evaluate", { expression: HARVEST_PAGE_OBSERVATION, returnByValue: true }, sessionId, 2000);
        const value = result.result?.value;
        return value && typeof value === "object" ? value : {};
      } catch { return {}; }
    };
    const stillLoading = async () => {
      const evidence = await readPageEvidence();
      return evidence.readyState === "loading" || Number(evidence.loadingIndicators) > 0;
    };
    const recoverScriptShell = async (pageNumber: number, url: string, baseline: number) => {
      const evidence = await readPageEvidence();
      // Retry only our current Liepin search page, once. A script failure is
      // supporting evidence, not permission to reload a login/rate-limit gate.
      if (signal?.aborted || plan.provider !== "liepin" || reloadObservations.has(pageNumber)
        || !reviewedCardsSearchPage(url, plan.provider) || failedScripts <= baseline
        || documentStatus && documentStatus >= 400
        || ["login", "verification", "platform_limit"].includes(String(evidence.failure))
        || evidence.route !== "search"
        || !(evidence.readyState === "loading" || Number(evidence.loadingIndicators) > 0)) return false;
      reloadObservations.set(pageNumber, {
        ...evidence, page: Math.min(50, pageNumber), phase: pageNumber > 1 ? "pagination" : "initial",
        failure: "timeout", verifiedCards: allRawCards.length, pendingRequests: pendingRequests.size,
        failedRequests, failedDocuments, failedScripts, failedDataRequests, limitedDataResponses,
        navigationAttempts: 2, navigationCommandFailed, ...(documentStatus ? { httpStatus: documentStatus } : {}),
      });
      await cdp.send("Page.navigate", { url }, sessionId, 5000).catch(() => { navigationCommandFailed = true; });
      return !signal?.aborted;
    };
    // A CDP response timeout is not a navigation cancellation: inspect the
    // document within the readiness budget before deciding it failed.
    if (!signal?.aborted) {
      try {
        const navigation = await cdp.send<{ errorText?: string }>("Page.navigate", { url: plan.url }, sessionId, 8000);
        navigationCommandFailed = Boolean(navigation.errorText);
      } catch { navigationCommandFailed = true; }
    }
    const navigationStartedAt = Date.now();
    pageReadinessDeadline = navigationStartedAt + 8_000;

    let page = 1;
    let pageHasCards = false;
    while (page <= pageLimit) {
      if (signal?.aborted) { stopReason = "cancelled"; break; }
      if (allRawCards.length >= maxCardCap) { stopReason = "card_limit"; break; }
      if (lastVisitedPage !== page) {
        if (lastVisitedPage > 0) { pageReadinessDeadline = Date.now() + 8_000; pageReadinessBudgetMs = 8_000; readinessExtended = false; }
        pagesVisited++;
        lastVisitedPage = page;
        pageHasCards = false;
        await reportProgress();
      }

      try {
        const cardsBeforeCapture = allRawCards.length;
        let captureStatus: LiveBatchProviderResult["status"] = "unknown_layout";
        // Give lazy lists one bounded chance to append cards without a pair of
        // unconditional 350/450ms sleeps on every numbered result page.
        if (plan.provider !== "boss" && !pageScrolled) {
          await cdp.send("Runtime.evaluate", { expression: "window.scrollBy(0, 1200)" }, sessionId).catch(() => {});
          await cdp.send("Runtime.evaluate", { expression: "window.scrollBy(0, 1200)" }, sessionId).catch(() => {});
          pageScrolled = true;
          const scrolledCards = await waitForUnseenCardsAfterScroll(
            cdp, sessionId, plan.platform, plan.provider, lastPageUrl, seenCardKeys, signal,
          );
          await reportProgress(addCards(scrolledCards));
        }

        // 1. High-fidelity in-browser extraction via evaluate
        const evalCards = await extractCardsViaEvaluate(cdp, sessionId, plan.platform, lastPageUrl);
        await reportProgress(addCards(evalCards));
        if (evalCards.length) pageHasCards = true;
        const pageStateBeforeAdvance = await readLiveSearchPageState(cdp, sessionId, plan.provider);
        lastPageState = pageStateBeforeAdvance;
        const cardsSignatureBeforeAdvance = searchCardSignature(evalCards, plan.provider);

        // 2. Structural DOM snapshot extraction
        try {
          const rawSnapshot = await cdp.send(
            "DOMSnapshot.captureSnapshot",
            {
              computedStyles: [...NATIVE_ROOT_SCROLL_STYLES],
              includeDOMRects: true,
              includeTextColorOpacities: true,
            },
            sessionId,
            4000,
          );

          const rawCards = extractCardsFromRawDomSnapshot(rawSnapshot, plan.platform, lastPageUrl);
          const newlyAddedRawCards = addCards(rawCards);
          await reportProgress(newlyAddedRawCards);
          if (rawCards.length) pageHasCards = true;

          const projected = projectNativeDomSnapshot(
            rawSnapshot,
            { id: targetId, url: pageStateBeforeAdvance?.url || lastPageUrl },
            { readyState: "complete" },
            { purpose: "search", detect51JobWaf: plan.platform === "51JOB" },
          );
          const extracted = extractJobSearchCards(projected, plan.platform);
          await reportProgress(addCards(extracted.cards));
          if (extracted.cards.length) pageHasCards = true;
          captureStatus = extracted.status;
          if (extracted.status !== "unknown_layout") lastStatus = extracted.status;
          for (const w of extracted.warnings) {
            if (!allWarnings.includes(w)) allWarnings.push(w);
          }

          const gateStatus = extracted.status === "login_required" || extracted.status === "verification_required"
            ? extracted.status
            : undefined;
          const isLoginRedirect =
            /\/web\/user\/|\/login|passport\.|security-check|verify/i.test(projected.url || lastPageUrl);
          if (isLoginRedirect || gateStatus) {
            const maxPauseMs = typeof interactiveWaitMs === "number" ? interactiveWaitMs : 0;
            let userResolved = false;

            if (maxPauseMs > 0) {
              preserveTargetForInteractiveLogin = true;
              await focusForInteractiveWait(9222).catch(() => false);
              const pauseStart = Date.now();
              while (Date.now() - pauseStart < maxPauseMs) {
                if (signal?.aborted) break;
                await new Promise((r) => setTimeout(r, 1200));

                let hasAuthCookie = false;
                try {
                  if (plan.provider === "boss") {
                    const cRes = await cdp.send<{ cookies?: Array<{ name: string; value: string }> }>(
                      "Network.getCookies",
                      { urls: ["https://www.zhipin.com"] },
                      sessionId,
                      2000,
                    );
                    hasAuthCookie = (cRes.cookies || []).some((c) => c.name === "wt2" && c.value.trim().length > 5);
                  } else if (plan.provider === "liepin") {
                    const cRes = await cdp.send<{ cookies?: Array<{ name: string; value: string }> }>(
                      "Network.getCookies",
                      { urls: ["https://www.liepin.com"] },
                      sessionId,
                      2000,
                    );
                    hasAuthCookie = (cRes.cookies || []).some(
                      (c) => (c.name === "lt_token" || c.name === "user_id") && c.value.trim().length > 3,
                    );
                  }
                } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }

                let leftGate = false;
                try {
                  const tg = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000);
                  const curUrl = tg.targetInfos?.find((t) => t.targetId === targetId)?.url || "";
                  if (curUrl && !/\/web\/user\/|passport\.liepin|security-check|verify/i.test(curUrl) && !curUrl.includes("blank")) {
                    leftGate = true;
                  }
                } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }

                if (hasAuthCookie || leftGate) {
                  userResolved = true;
                  allWarnings.push(`${plan.platform} 登录或人机验证已通过人机协同接续完成`);
                  break;
                }
              }
            }

            if (userResolved) {
              await cdp.send("Page.navigate", { url: plan.url }, sessionId, 5000).catch(() => {});
              pageReadinessDeadline = Date.now() + 8_000;
              pageReadinessBudgetMs = 8_000;
              readinessExtended = false;
              pageHasCards = false;
              pageScrolled = false;
              continue;
            }

            lastStatus = gateStatus ?? (/security-check|verify/i.test(projected.url || lastPageUrl)
              ? "verification_required"
              : "login_required");
            stopReason = "gate";
            break;
          }
        } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }

        if (signal?.aborted) { stopReason = "cancelled"; break; }
        if (!pageHasCards) {
          const evidence = await readPageEvidence();
          // The projection may reject a redirected document URL; a bounded,
          // allowlisted DOM probe must still distinguish a gate from no jobs.
          if (evidence.failure === "verification" || evidence.failure === "login" || evidence.failure === "platform_limit") {
            lastStatus = evidence.failure === "login" ? "login_required" : evidence.failure === "verification" ? "verification_required" : "error";
            stopReason = "gate";
            break;
          }
          // Recover only an inert owned blank target, never reload a loading
          // search SPA or a login/verification page. Keep the absolute deadline.
          if (page === 1 && evidence.route === "blank" && !blankRecoveryUsed
            && !documentStatus && pendingRequests.size === 0 && Date.now() - navigationStartedAt >= 2_000) {
            blankRecoveryUsed = true;
            await cdp.send("Page.navigate", { url: plan.url }, sessionId, 5000).catch(() => { navigationCommandFailed = true; });
            continue;
          }
          if (captureStatus === "empty") { lastStatus = "empty"; stopReason = "exhausted"; break; }
          if (captureStatus !== "unknown_layout") { lastStatus = captureStatus; stopReason = "error"; break; }
          // A loading SPA shell is not an empty result page. Keep reading this
          // page within one absolute grace period before any pagination input.
          if (Date.now() >= pageReadinessDeadline && !readinessExtended && (evidence.readyState === "loading" || Number(evidence.loadingIndicators) > 0 || page === 1 && pendingBootstrapRequests.size > 0)) {
            // Real 51JOB dictionary initialization can take ~30s while the
            // document reports complete and has no visible loading indicator.
            const extra = page === 1 && pendingBootstrapRequests.size > 0 ? 32_000 : 12_000;
            pageReadinessDeadline += extra;
            pageReadinessBudgetMs += extra;
            readinessExtended = true;
            if (extra === 32_000) allWarnings.push("平台初始化资源尚在返回，已在后台有界延长首次读取至最多 40 秒；未刷新页面或跳过登录验证。");
          }
          if (Date.now() < pageReadinessDeadline) {
            await pauseLiveSearchReadiness(Math.min(250, pageReadinessDeadline - Date.now()), signal);
            continue;
          }
          if (await recoverScriptShell(page, lastPageUrl, pageFailedScriptsBaseline)) {
            pageReadinessDeadline = Date.now() + 8_000;
            pageReadinessBudgetMs = 8_000;
            readinessExtended = false;
            pageScrolled = false;
            continue;
          }
          if (visualRecovery) {
            const visual = await visualRecovery.recover(nativeVisualDriver(cdp, sessionId!, signal), plan.url, plan.provider, signal);
            const usage = visualRecovery.usage;
            allWarnings.push(`本轮视觉预算：已分配 ${usage.reservedCalls}/${usage.maxCalls} 次模型调用；已返回用量 ${usage.inputTokens} 输入 / ${usage.outputTokens} 输出 token。超时调用的服务端计费可能尚未返回。`);
            if (visual.gate) {
              lastStatus = visual.gate === "login" ? "login_required" : visual.gate === "verification" ? "verification_required" : "error";
              stopReason = "gate";
              allWarnings.push("视觉检查发现登录、验证或访问限制，已停止自动操作；请在平台登录态入口处理后继续。");
              break;
            }
            if (visual.changed) {
              allWarnings.push("视觉兜底已执行一次受限后台操作，正在重新核验结构化岗位证据；操作回执不代表采集成功。");
              pageReadinessDeadline = Date.now() + 4_000;
              pageReadinessBudgetMs = 4_000;
              readinessExtended = true;
              pageScrolled = false;
              continue;
            }
            allWarnings.push(`视觉兜底未继续操作（${visual.reason}）；未生成或补造岗位。`);
          }
          lastStatus = "unknown_layout";
          stopReason = "no_progress";
          allWarnings.push(`搜索页面在 ${pageReadinessBudgetMs / 1000} 秒内仍未出现可核对的岗位卡片或明确空结果；未跳过当前页或将其计为零岗位，已停止本平台采集。`);
          break;
        }
        if (allRawCards.length > 0) {
          lastStatus = "ready";
        }
        const recoveredObservation = reloadObservations.get(page);
        if (recoveredObservation) recoveredObservation.recovered = true;
        const cardsAddedThisCapture = allRawCards.length - cardsBeforeCapture;
        if (plan.provider === "boss" && cardsAddedThisCapture > 0) noProgressScrolls = 0;
        if (plan.provider !== "boss" && page > 1 && cardsAddedThisCapture === 0) noProgressPages++;
        else if (cardsAddedThisCapture > 0) noProgressPages = 0;
        if (noProgressPages >= 2) {
          stopReason = "no_progress";
          break;
        }

        // Advance to next page if not on final page
        if (allRawCards.length >= maxCardCap) { stopReason = "card_limit"; break; }
        // BOSS has one virtual page; its continuation is governed by the
        // independent scroll budget below rather than the numbered-page cap.
        if (plan.provider !== "boss" && page >= pageLimit) { stopReason = "page_limit"; break; }
        if (signal?.aborted) { stopReason = "cancelled"; break; }

        const nextPageFailedScriptsBaseline = failedScripts;
        const advance = await clickPlatformNextPage(cdp, sessionId, plan.platform);
        if (advance.kind === "scroll" && advance.advanced) {
          scrollSteps++;
          const newlyLoaded = await waitForUnseenCardsAfterScroll(
            cdp, sessionId, plan.platform, plan.provider, lastPageUrl, seenCardKeys, signal,
          );
          await reportProgress(addCards(newlyLoaded));
          // BOSS exposes the whole loaded batch before its bottom is visible.
          // Moving through those already captured cards is genuine progress:
          // only stalled bottom checks may consume the no-progress tolerance.
          noProgressScrolls = 0;
          if (scrollSteps >= maxScrollSteps) { stopReason = "scroll_limit"; break; }
          continue;
        }

        const nextUrl = pageUrls[page];
        if (plan.provider === "boss" && advance.kind === "scroll" && advance.exhausted) {
          // Reaching scrollHeight does not prove that an infinite list is done:
          // BOSS may append the next batch after the scroll event settles.
          await new Promise((resolve) => setTimeout(resolve, 350));
          const delayedCards = await waitForUnseenCardsAfterScroll(
            cdp, sessionId, plan.platform, plan.provider, lastPageUrl, seenCardKeys, signal,
          );
          const delayedCount = addCards(delayedCards).length;
          await reportProgress(delayedCards);
          if (delayedCount > 0) {
            noProgressScrolls = 0;
            continue;
          }
          const loading = await isBOSSListLoading(cdp, sessionId);
          const boundary = decideBossScrollBoundary({
            addedCards: delayedCount,
            loading,
            noProgressAttempts: noProgressScrolls,
          });
          if (boundary === "continue") {
            noProgressScrolls++;
            await new Promise((resolve) => setTimeout(resolve, 350));
            continue;
          }
          stopReason = boundary === "no_progress" ? "no_progress" : "exhausted";
          break;
        }
        const decision = decideLiveBatchAdvance({
          advance,
          provider: plan.provider,
          currentPage: page,
          pageLimit,
          nextPageUrl: nextUrl,
          currentPageUrl: lastPageUrl,
          cancelled: signal?.aborted,
          cardLimitReached: allRawCards.length >= maxCardCap,
        });
        if (decision.action === "stop") { stopReason = decision.stopReason; break; }
        if (decision.action === "continue-page") {
          attemptedPage = page + 1;
          const waitForTransition = (expectedPageUrl?: string, timeoutMs?: number) => pageStateBeforeAdvance
            ? waitForLiveSearchPageTransition({
                before: pageStateBeforeAdvance,
                beforeCardsSignature: cardsSignatureBeforeAdvance,
                ...(expectedPageUrl ? { expectedPageUrl } : {}),
                provider: plan.provider,
                readState: () => readLiveSearchPageState(cdp, sessionId!, plan.provider),
                readCards: (url) => extractCardsViaEvaluate(cdp, sessionId!, plan.platform, url),
                signal,
                ...(expectedPageUrl ? { isLoading: stillLoading } : {}),
                ...(timeoutMs ? { timeoutMs } : {}),
              })
            : Promise.resolve({ advanced: false as const });
          let transition = await confirmLiveSearchPageAdvance({
            provider: plan.provider,
            ...(nextUrl ? { expectedPageUrl: nextUrl } : {}),
            waitForTransition,
            navigateTo: async (pageUrl) => {
              await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
              await cdp.send("Page.navigate", { url: pageUrl }, sessionId, 7000);
            },
          });
          if (!transition.advanced && nextUrl && await recoverScriptShell(page + 1, nextUrl, nextPageFailedScriptsBaseline)) {
            transition = await waitForTransition(nextUrl);
          }
          if (!transition.advanced) {
            stopReason = signal?.aborted ? "cancelled" : "no_progress";
            allWarnings.push("平台翻页控件已触发，但未能确认下一页 URL、页码与岗位卡片列表均已更新；已尝试打开受限的下一页 URL，仍无法核实，因此停止本平台采集。");
            break;
          }
          lastPageUrl = transition.pageUrl;
          page++;
          pageFailedScriptsBaseline = nextPageFailedScriptsBaseline;
          pageScrolled = false;
          continue;
        }
        if (decision.action === "navigate-page") {
          attemptedPage = page + 1;
          await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
          try {
            await cdp.send("Page.navigate", { url: decision.pageUrl }, sessionId, 7000);
          } catch (error) {
            if (classifyHarvestFailure(error) !== "timeout") throw error;
            // A protocol reply timeout does not prove the document failed to
            // navigate. Observe this same owned target within the existing
            // transition budget, without replaying an uncertain navigation.
            navigationCommandFailed = true;
            operationTimedOut = true;
          }
          let transition = pageStateBeforeAdvance
            ? await waitForLiveSearchPageTransition({
                before: pageStateBeforeAdvance,
                beforeCardsSignature: cardsSignatureBeforeAdvance,
                expectedPageUrl: decision.pageUrl,
                provider: plan.provider,
                readState: () => readLiveSearchPageState(cdp, sessionId!, plan.provider),
                readCards: (url) => extractCardsViaEvaluate(cdp, sessionId!, plan.platform, url),
                signal,
                isLoading: stillLoading,
              })
            : { advanced: false as const };
          if (!transition.advanced && pageStateBeforeAdvance && await recoverScriptShell(page + 1, decision.pageUrl, nextPageFailedScriptsBaseline)) {
            transition = await waitForLiveSearchPageTransition({
              before: pageStateBeforeAdvance, beforeCardsSignature: cardsSignatureBeforeAdvance,
              expectedPageUrl: decision.pageUrl, provider: plan.provider,
              readState: () => readLiveSearchPageState(cdp, sessionId!, plan.provider),
              readCards: (url) => extractCardsViaEvaluate(cdp, sessionId!, plan.platform, url),
              signal, isLoading: stillLoading,
            });
          }
          if (!transition.advanced) {
            stopReason = signal?.aborted ? "cancelled" : operationTimedOut ? "error" : "no_progress";
            allWarnings.push("目标分页 URL 已打开，但未能确认新页面及其岗位卡片更新；为避免将旧页数据归到新页，已停止本平台采集。");
            break;
          }
          if (operationTimedOut) {
            navigationTimeoutObservations.push({
              ...await readPageEvidence(), page: Math.min(50, attemptedPage), phase: "pagination", failure: "timeout",
              verifiedCards: allRawCards.length, pendingRequests: pendingRequests.size, failedRequests, failedDocuments,
              failedScripts, failedDataRequests, limitedDataResponses, navigationAttempts: reloadObservations.has(attemptedPage) ? 2 : 1,
              navigationCommandFailed: true, recovered: true, ...(documentStatus ? { httpStatus: documentStatus } : {}),
            });
            operationTimedOut = false;
          }
          lastPageUrl = transition.pageUrl;
          page++;
          pageFailedScriptsBaseline = nextPageFailedScriptsBaseline;
          pageScrolled = false;
          continue;
        }
      } catch (error) {
        stopReason = "error";
        operationTimedOut = classifyHarvestFailure(error) === "timeout";
        allWarnings.push(error instanceof Error ? error.message : "读取搜索页时遇到异常。");
        break;
      }
    }

    if (signal?.aborted) stopReason = "cancelled";

    const cards = sanitizeReviewedCards(
      allRawCards,
      plan.provider,
      plan.url,
      keyword,
      maxCardCap,
    );
    let failureKind: LiveBatchCoverage["failureKind"];

    const diagnosticObservations = [...reloadObservations.values(), ...navigationTimeoutObservations];
    if (["no_progress", "gate", "error"].includes(stopReason)) {
      let pageEvidence: Record<string, unknown> = {};
      try {
        const observation = await cdp.send<{ result?: { value?: Record<string, unknown> } }>("Runtime.evaluate", { expression: HARVEST_PAGE_OBSERVATION, returnByValue: true }, sessionId, 2000);
        pageEvidence = observation.result?.value ?? {};
      } catch { /* unavailable is itself useful; never retain the error text */ }
      const failure = ["login", "verification", "platform_limit"].includes(String(pageEvidence.failure)) ? pageEvidence.failure
        : documentStatus && documentStatus >= 400 ? classifyHarvestFailure(undefined, documentStatus)
        : operationTimedOut ? "timeout"
        : pageEvidence.route === "browser_error" ? "network"
        : pageEvidence.route === "blank" ? failedRequests > 0 ? "network" : "unknown"
        : pageEvidence.readyState === "loading" || Number(pageEvidence.loadingIndicators) > 0 ? "timeout"
        : !pageEvidence.readyState ? "unknown"
        : page > 1 || cards.length > 0 ? (plan.provider === "boss" ? "layout" : "pagination")
        : failedRequests > 0 ? "network" : "layout";
      const finalPageState = await readLiveSearchPageState(cdp, sessionId, plan.provider);
      diagnosticObservations.push({ ...pageEvidence, page: Math.min(50, attemptedPage), phase: cards.length ? plan.provider === "boss" ? "scroll" : "pagination" : "initial", failure, verifiedCards: cards.length, pendingRequests: pendingRequests.size, failedRequests, failedDocuments, failedScripts, failedDataRequests, limitedDataResponses, navigationAttempts: blankRecoveryUsed || reloadObservations.has(attemptedPage) ? 2 : 1, navigationCommandFailed, ...(documentStatus ? { httpStatus: documentStatus } : {}), ...(lastPageState && finalPageState ? { pageUrlChanged: lastPageState.url !== finalPageState.url, pageMarkerChanged: lastPageState.marker !== finalPageState.marker } : {}) });
      failureKind = "unknown"; // replace with the allowlist-validated terminal observation below
    }
    if (diagnosticObservations.length) {
      const parsed = HarvestDiagnosticSchema.safeParse({ provider: plan.provider, observations: diagnosticObservations });
      const id = parsed.success ? await retainDiagnostic(parsed.data) : undefined;
      if (failureKind) failureKind = parsed.success ? parsed.data.observations.at(-1)?.failure : "unknown";
      allWarnings.push(`脱敏诊断${harvestDiagnosticRetentionLabel(id)}：${failureKind ?? "加载中断后已恢复"}；仅保留加载、限制与翻页结构证据，不保存页面正文或身份信息。`);
    }
    reusable = !signal?.aborted && !["gate", "error", "cancelled", "no_progress"].includes(stopReason)
      && (cards.length > 0 || lastStatus === "empty");

    if (cards.length > 0) {
      return {
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "ready",
        cards,
        rawCardCount: allRawCards.length,
        warnings: allWarnings,
        coverage: createLiveBatchCoverage({ pagesVisited, scrollSteps, scrollLimit: maxScrollSteps, pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: maxCardCap, stopReason, failureKind }),
      };
    }

    if (allRawCards.length > 0 && cards.length === 0) {
      lastStatus = "unknown_layout";
      allWarnings.push("页面检测到岗位候选，但没有任何卡片通过来源链接与字段证据校验；不将其记为零岗位。");
    }

    return {
      provider: plan.provider,
      platform: plan.platform,
      pageUrl: reviewedCardsSearchPage(lastPageUrl, plan.provider) ? lastPageUrl : plan.url,
      status: lastStatus,
      cards: [],
      rawCardCount: allRawCards.length,
      warnings: allWarnings,
      coverage: createLiveBatchCoverage({ pagesVisited, scrollSteps, scrollLimit: maxScrollSteps, pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: maxCardCap, stopReason, failureKind }),
    };
  } catch (error) {
    return {
      provider: plan.provider,
      platform: plan.platform,
      pageUrl: plan.url,
      status: "error",
      cards: [],
      rawCardCount: 0,
      warnings: [],
      coverage: createLiveBatchCoverage({ pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: liveBatchCardBudget(depth), stopReason: "error" }),
      error: error instanceof Error ? error.message : "平台页面读取异常",
    };
  } finally {
    unsubscribe?.();
    if (sessionId) {
      await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 1500).catch(() => { reusable = false; });
    }
    if (lease) {
      await lease.release(reusable, preserveTargetForInteractiveLogin).catch(() => {});
    } else if (ownsTarget && targetId && !preserveTargetForInteractiveLogin) {
      await cdp.send("Target.closeTarget", { targetId }, undefined, 1500).catch(() => {});
    }
  }
}
