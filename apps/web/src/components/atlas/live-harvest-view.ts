import type { LiveBatchProviderResultClient, LiveBatchSearchReceipt, LiveBatchSearchStreamEvent } from "../../lib/platform-search-client";

export type LiveHarvestQuery = {
  keyword: string;
  region?: string;
  districtCode?: string;
};

export type LiveHarvestCard = {
  provider: LiveBatchProviderResultClient["provider"];
  platform: LiveBatchProviderResultClient["platform"];
  card: LiveBatchProviderResultClient["cards"][number];
};

export type LiveHarvestProvider = {
  provider: LiveBatchProviderResultClient["provider"];
  platform: LiveBatchProviderResultClient["platform"];
  status: LiveBatchProviderResultClient["status"] | "running" | "queued" | "cancelled";
  cardCount: number;
  progressCardsCaptured?: number;
  coverage: LiveBatchProviderResultClient["coverage"];
  warnings: string[];
  error?: string;
  pagesVisited: number;
  scrollSteps: number;
};

export type LiveHarvestView = {
  capturedAt: string;
  query: LiveHarvestQuery;
  cards: LiveHarvestCard[];
  providers: LiveHarvestProvider[];
  totalCards: number;
};

export type LiveHarvestProgress = {
  provider: LiveHarvestProvider["provider"];
  platform: LiveHarvestProvider["platform"];
  status: "running" | "queued";
  cardsCaptured: number;
  pagesVisited: number;
  scrollSteps: number;
  pageLimit: number;
  scrollLimit: number;
  cardLimit: number;
  /** Source-validated new cards in this progress event, not all candidates. */
  cards?: LiveHarvestCard[];
};

const stopReasonLabel: Record<LiveHarvestProvider["coverage"]["stopReason"], string> = {
  exhausted: "列表读取结束",
  page_limit: "达到页数预算",
  scroll_limit: "达到滚动预算",
  card_limit: "达到岗位预算",
  no_progress: "读取未取得进展",
  gate: "登录或安全验证阻断",
  error: "读取异常（展开查看原因）",
  cancelled: "已取消",
};

export function liveHarvestStopReasonLabel(
  status: LiveHarvestProvider["status"],
  stopReason: LiveHarvestProvider["coverage"]["stopReason"],
): string {
  if (stopReason === "no_progress") {
    if (status === "unknown_layout") return "页面未识别或加载超时";
    if (status === "ready") return "页码或列表未确认变化";
  }
  if (stopReason === "error" && status === "ready") return "部分分页读取失败";
  return stopReasonLabel[stopReason];
}

export function getLiveHarvestPage<T>(items: readonly T[], requestedPage: number, pageSize = 50) {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 50;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const pageIndex = Number.isFinite(requestedPage)
    ? Math.max(0, Math.min(pageCount - 1, Math.floor(requestedPage)))
    : 0;
  const start = pageIndex * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    pageIndex,
    pageCount,
    firstItem: items.length === 0 ? 0 : start + 1,
    lastItem: Math.min(start + safePageSize, items.length),
  };
}

function normalizeCardUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}

export function buildLiveHarvestView(
  receipt: LiveBatchSearchReceipt,
  query: LiveHarvestQuery,
): LiveHarvestView {
  const cards: LiveHarvestCard[] = [];
  const seen = new Set<string>();
  const providers = receipt.results.map((result) => {
    const readyCards = result.status === "ready" ? result.cards : [];
    let cardCount = 0;
    for (const card of readyCards) {
      const normalizedUrl = normalizeCardUrl(card.url);
      const identity = `${result.provider}\u0000${normalizedUrl}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      cards.push({ provider: result.provider, platform: result.platform, card });
      cardCount++;
    }
    return {
      provider: result.provider,
      platform: result.platform,
      status: result.status,
      cardCount,
      coverage: result.coverage,
      warnings: result.warnings,
      pagesVisited: result.coverage.pagesVisited,
      scrollSteps: result.coverage.scrollSteps,
      ...(result.error ? { error: result.error } : {}),
    };
  });

  return {
    capturedAt: receipt.capturedAt,
    query: {
      keyword: query.keyword.trim(),
      ...(query.region?.trim() ? { region: query.region.trim() } : {}),
      ...(query.districtCode ? { districtCode: query.districtCode } : {}),
    },
    cards,
    providers,
    totalCards: cards.length,
  };
}

/** Keep verified stream cards when a later keyword receipt arrives. */
export function mergeLiveHarvestViews(
  previous: LiveHarvestView | null,
  next: LiveHarvestView,
): LiveHarvestView {
  if (!previous || !matchesLiveHarvestQuery(previous, next.query)) return next;
  const cardsByIdentity = new Map(previous.cards.map((entry) => [
    `${entry.provider}\u0000${normalizeCardUrl(entry.card.url)}`,
    entry,
  ]));
  for (const entry of next.cards) {
    cardsByIdentity.set(`${entry.provider}\u0000${normalizeCardUrl(entry.card.url)}`, entry);
  }

  const providersById = new Map(previous.providers.map((provider) => [provider.provider, provider]));
  for (const provider of next.providers) {
    const earlier = providersById.get(provider.provider);
    if (!earlier) {
      providersById.set(provider.provider, provider);
      continue;
    }
    const earlierFailure = earlier.coverage.stopReason === "error" || earlier.status === "error";
    const progressCardCount = provider.status === "running" ? earlier.progressCardsCaptured : undefined;
    providersById.set(provider.provider, {
      ...provider,
      coverage: {
        ...provider.coverage,
        pagesVisited: Math.max(provider.coverage.pagesVisited, earlier.pagesVisited),
        scrollSteps: Math.max(provider.coverage.scrollSteps, earlier.scrollSteps),
        stopReason: earlierFailure && provider.coverage.stopReason === "exhausted"
          ? "error"
          : provider.coverage.stopReason,
        partial: provider.coverage.partial || earlier.coverage.partial || earlierFailure,
      },
      warnings: [...new Set([...earlier.warnings, ...provider.warnings])],
      ...((provider.error ?? earlier.error) ? { error: [earlier.error, provider.error].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index).join("；") } : {}),
      ...(progressCardCount === undefined ? {} : { progressCardsCaptured: progressCardCount }),
    });
  }

  const cards = [...cardsByIdentity.values()];
  const providers = [...providersById.values()].map((provider) => ({
    ...provider,
    cardCount: cards.filter((entry) => entry.provider === provider.provider).length,
  }));
  return { ...next, cards, providers, totalCards: cards.length };
}

export function buildLiveHarvestProgressView(
  previous: LiveHarvestView | null,
  query: LiveHarvestQuery,
  progress: LiveHarvestProgress,
  result?: LiveBatchProviderResultClient,
  capturedAt = new Date().toISOString(),
): LiveHarvestView {
  const results = new Map((previous?.providers ?? []).map((provider) => [provider.provider, provider]));
  if (result) {
    const current = results.get(result.provider);
    results.set(result.provider, {
      provider: result.provider,
      platform: result.platform,
      status: result.status,
      cardCount: current?.cardCount ?? 0,
      progressCardsCaptured: result.cards.length,
      coverage: result.coverage,
      warnings: [...new Set([...(current?.warnings ?? []), ...result.warnings])],
      pagesVisited: current?.pagesVisited ?? result.coverage.pagesVisited,
      scrollSteps: current?.scrollSteps ?? result.coverage.scrollSteps,
      ...((result.error ?? current?.error) ? { error: result.error ?? current?.error } : {}),
    });
  } else {
    const current = results.get(progress.provider);
    results.set(progress.provider, {
      provider: progress.provider,
      platform: progress.platform,
      status: progress.status,
      cardCount: current?.cardCount ?? 0,
      progressCardsCaptured: progress.cardsCaptured,
      coverage: {
        pagesVisited: progress.pagesVisited,
        pageLimit: progress.pageLimit,
        scrollSteps: progress.scrollSteps,
        scrollLimit: progress.scrollLimit,
        cardLimit: progress.cardLimit,
        stopReason: current?.coverage.stopReason ?? "page_limit",
        partial: true,
      },
      warnings: current?.warnings ?? [],
      pagesVisited: progress.pagesVisited,
      scrollSteps: progress.scrollSteps,
    });
  }
  let cards = previous?.cards ?? [];
  const incoming = [
    ...(result?.status === "ready" ? result.cards.map((card) => ({ provider: result.provider, platform: result.platform, card })) : []),
    ...(progress.cards ?? []),
  ];
  // Metadata arrives much more often than cards. Keep this path independent of
  // the accumulated card count and retain the reference used by list consumers.
  if (incoming.length > 0) {
    const seen = new Set(cards.map((entry) => `${entry.provider}\u0000${normalizeCardUrl(entry.card.url)}`));
    const appended: LiveHarvestCard[] = [];
    for (const entry of incoming) {
      const identity = `${entry.provider}\u0000${normalizeCardUrl(entry.card.url)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      appended.push(entry);
      const provider = results.get(entry.provider);
      if (provider) results.set(entry.provider, { ...provider, cardCount: provider.cardCount + 1 });
    }
    if (appended.length > 0) cards = [...cards, ...appended];
  }
  const providers = [...results.values()];
  return {
    capturedAt,
    query: previous?.query ?? {
      keyword: query.keyword.trim(),
      ...(query.region?.trim() ? { region: query.region.trim() } : {}),
      ...(query.districtCode ? { districtCode: query.districtCode } : {}),
    },
    cards,
    providers,
    totalCards: cards.length,
  };
}

/** Apply cheap stream metadata separately from the cumulative provider receipt. */
export function applyLiveBatchStreamEvent(
  previous: LiveHarvestView | null,
  receipt: LiveBatchSearchReceipt,
  query: LiveHarvestQuery,
  event: LiveBatchSearchStreamEvent,
): LiveHarvestView {
  if (event.type === "provider-result") {
    // The pipeline receipt includes all completed keywords. Replacing its
    // coverage with event.result would reduce it to the last keyword only.
    const cumulative = receipt.results.some((result) => result.provider === event.result.provider)
      ? receipt
      : { ...receipt, results: [...receipt.results, event.result] };
    return mergeLiveHarvestViews(previous, buildLiveHarvestView(cumulative, query));
  }

  return buildLiveHarvestProgressView(previous, query, {
    provider: event.provider,
    platform: event.platform,
    status: event.type === "provider-queued" ? "queued" : "running",
    cardsCaptured: event.type === "provider-progress" ? event.cardsCaptured : 0,
    pagesVisited: event.type === "provider-progress" ? event.pagesVisited : 0,
    scrollSteps: event.type === "provider-progress" ? event.scrollSteps : 0,
    pageLimit: event.pageLimit,
    scrollLimit: event.scrollLimit,
    cardLimit: event.cardLimit,
    ...(event.type === "provider-progress" && event.cards?.length
      ? { cards: event.cards.map((card) => ({ provider: event.provider, platform: event.platform, card })) }
      : {}),
  }, undefined, receipt.capturedAt);
}

/** Resolve transient provider states when the SSE request ends without receipts. */
export function settleLiveHarvestView(
  view: LiveHarvestView | null,
  settlement: { outcome: "cancelled" } | { outcome: "error"; message: string },
): LiveHarvestView | null {
  if (!view) return null;
  const cancelled = settlement.outcome === "cancelled";
  const providers = view.providers.map((provider) => {
    if (provider.status !== "queued" && provider.status !== "running") return provider;
    const wasQueued = provider.status === "queued";
    const reason = cancelled ? "cancelled" as const : "error" as const;
    const message = cancelled
      ? wasQueued
        ? "本轮已请求停止，此平台尚未开始读取，没有最终回执。"
        : "本轮已请求停止，此平台未返回最终回执；已验证卡片仍保留。"
      : wasQueued
        ? "实时搜索在此平台开始前中断，未收到该平台最终回执。"
        : `${settlement.message}；未收到该平台最终回执，已验证卡片仍保留。`;
    return {
      ...provider,
      status: cancelled ? "cancelled" as const : "error" as const,
      coverage: { ...provider.coverage, stopReason: reason, partial: true },
      warnings: [...new Set([...provider.warnings, message])],
      error: message,
    };
  });
  return { ...view, providers };
}

function normalizeSearchValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function matchesLiveHarvestQuery(
  view: LiveHarvestView,
  query: LiveHarvestQuery,
): boolean {
  return normalizeSearchValue(view.query.keyword) === normalizeSearchValue(query.keyword)
    && normalizeSearchValue(view.query.region) === normalizeSearchValue(query.region)
    && (view.query.districtCode ?? "") === (query.districtCode ?? "");
}
