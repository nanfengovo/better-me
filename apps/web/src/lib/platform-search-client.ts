import { z } from "zod";
import { PlatformSearchInputSchema, buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/browser-contracts";
import { allowedJobUrl } from "./jd-source";
import { readJdFailure, JdExtractionError } from "./jd-errors";
import type { JdBrowserSession } from "./jd-import";
import { createJdStartRequestId, isJdStartRequestId } from "./jd-start-request";

const platform = z.enum(["51JOB", "BOSS直聘", "猎聘", "LinkedIn", "Seek", "Indeed", "GradConnection"]);
const card = z.object({
  url: z.string().url().max(8_000), platform, title: z.string().trim().min(1).max(500),
  company: z.string().max(500).optional(), locationText: z.string().max(1_000).optional(),
  salaryText: z.string().max(1_000).optional(), publicationText: z.string().max(1_000).optional(),
  cardText: z.string().max(20_000), evidence: z.object({
    pageUrl: z.string().url().max(8_000), cardSelector: z.string().min(1).max(1_000),
    fields: z.array(z.object({ field: z.enum(["url", "title", "company", "locationText", "salaryText", "publicationText"]),
      selector: z.string().min(1).max(1_000), text: z.string().min(1).max(8_000),
    }).strict()).max(30),
  }).strict(),
});
const result = z.object({
  status: z.enum(["ready", "empty", "login_required", "verification_required", "unknown_layout", "oversized", "unsupported_page"]),
  platform, url: z.string().url().max(8_000), cards: z.array(card).max(50), partial: z.boolean(),
  warnings: z.array(z.string().max(2_000)).max(100), capturedAt: z.string().datetime({ offset: true }),
});
const liveBatchCoverage = z.object({
  pagesVisited: z.number().int().nonnegative(),
  scrollSteps: z.number().int().nonnegative(),
  scrollLimit: z.number().int().nonnegative(),
  pageLimit: z.number().int().positive(),
  cardLimit: z.number().int().positive(),
  stopReason: z.enum(["exhausted", "page_limit", "scroll_limit", "card_limit", "no_progress", "gate", "error", "cancelled"]),
  partial: z.boolean(),
}).strict();
const liveBatchCard = card.extend({ company: z.string().trim().min(1).max(500) });
const platformForProvider: Record<PlatformSearchInput["provider"], z.infer<typeof platform>> = {
  "51job": "51JOB",
  boss: "BOSS直聘",
  liepin: "猎聘",
  linkedin: "LinkedIn",
  seek: "Seek",
  indeed: "Indeed",
  gradconnection: "GradConnection",
};
const liveBatchProviderResult = z.object({
  provider: PlatformSearchInputSchema.shape.provider,
  platform,
  pageUrl: z.string().url().max(8_000),
  status: z.enum(["ready", "empty", "login_required", "verification_required", "unknown_layout", "oversized", "unsupported_page", "error"]),
  cards: z.array(liveBatchCard).max(3000),
  rawCardCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(2_000)).max(100),
  coverage: liveBatchCoverage,
  error: z.string().max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.platform !== platformForProvider[value.provider]) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result platform does not match its provider." });
  }
  if (value.cards.some((item) => item.platform !== value.platform)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result contains a cross-platform card." });
  }
  if ((value.status === "ready") !== (value.cards.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result status does not match its card count." });
  }
  if (value.rawCardCount < value.cards.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result raw count is lower than its reviewed card count." });
  }
  if (value.coverage.pagesVisited > value.coverage.pageLimit || value.coverage.scrollSteps > value.coverage.scrollLimit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result exceeded its declared coverage budget." });
  }
  if (value.coverage.partial !== (value.coverage.stopReason !== "exhausted")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Live result coverage partial flag disagrees with its stop reason." });
  }
});
const liveBatchReceipt = z.object({
  capturedAt: z.string().datetime({ offset: true }),
  results: z.array(liveBatchProviderResult).max(7),
}).strict();
export type PlatformSearchCard = z.infer<typeof card>;
export type PlatformSearchReceipt = z.infer<typeof result>;

const error = (message: string) => new JdExtractionError({ code: "service_unavailable", stage: "service", message });
async function request(body: unknown, signal?: AbortSignal, keepalive = false, maxResponseBytes = 3 * 1024 * 1024) {
  let response: Response;
  try { response = await fetch("/api/jd/search-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, keepalive }); }
  catch (cause) { if (signal?.aborted) throw signal.reason ?? cause; throw error("无法连接本机搜索工具。请在本机开发工作台运行，静态 Pages/Docker 不包含招聘浏览器。"); }
  const text = await response.text();
  if (text.length > maxResponseBytes) throw error("搜索服务返回超出本次采集上限的内容。");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text) as Record<string, unknown>; if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(); }
  catch { throw error("当前网页服务没有提供有效的平台搜索接口，请使用更新后的本机工作台。"); }
  const failure = readJdFailure(payload.failure);
  if (failure) throw new JdExtractionError(failure);
  if (!response.ok) throw error(typeof payload.error === "string" ? payload.error : "平台搜索操作未完成。");
  return payload;
}

export async function startPlatformSearch(input: PlatformSearchInput, signal?: AbortSignal, requestId = createJdStartRequestId()): Promise<JdBrowserSession> {
  const parsed = PlatformSearchInputSchema.parse(input), plan = buildPlatformSearchRequest(parsed);
  if (!isJdStartRequestId(requestId)) throw error("搜索启动标识无效，请重新打开搜索工具。");
  const payload = await request({ action: "start", input: parsed, requestId }, signal);
  if (typeof payload.sessionId !== "string" || !/^[a-z\d_-]{16,200}$/i.test(payload.sessionId)
    || payload.platform !== plan.platform || payload.url !== plan.url
    || typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt))) throw error("搜索服务未返回与本次参数一致的会话，请检查专用浏览器窗口。");
  return payload as unknown as JdBrowserSession;
}

/** Cancels exactly one recoverable launch, including a late-acquired page. */
export async function cancelPlatformSearch(input: PlatformSearchInput, requestId: string, keepalive = false): Promise<void> {
  if (!isJdStartRequestId(requestId)) throw error("搜索启动标识无效，未确认本次窗口已结束。");
  const payload = await request({ action: "cancel-start", input: PlatformSearchInputSchema.parse(input), requestId }, AbortSignal.timeout(8_000), keepalive);
  if (payload.cancelled !== true || payload.closed !== true) throw error("本次搜索页尚未确认关闭，请重试结束本次请求。");
}

export async function readPlatformSearch(session: JdBrowserSession, signal?: AbortSignal): Promise<PlatformSearchReceipt> {
  const parsed = result.safeParse(await request({ action: "read", sessionId: session.sessionId }, signal));
  if (!parsed.success || parsed.data.platform !== session.platform) throw error("搜索服务返回的列表格式或平台不一致。");
  const receipt = parsed.data, initial = new URL(session.url), actual = new URL(receipt.url);
  if (actual.origin !== initial.origin || actual.pathname.replace(/\/$/, "") !== initial.pathname.replace(/\/$/, "")
    || [...new Set(initial.searchParams.keys())].some((key) => {
      const before = initial.searchParams.getAll(key), after = actual.searchParams.getAll(key);
      return !(before.length === 1 && before[0] === "" && after.length === 0) && JSON.stringify(after) !== JSON.stringify(before);
    })) throw error("搜索页的关键词或地区已改变，请结束会话后重新搜索。");
  const seen = new Set<string>();
  for (const item of receipt.cards) {
    let source: ReturnType<typeof allowedJobUrl>;
    try { source = allowedJobUrl(item.url); } catch { throw error("搜索列表包含不支持的岗位来源链接。"); }
    if (source.platform !== session.platform || item.platform !== session.platform || seen.has(source.url)) throw error("搜索列表包含重复或跨平台岗位链接。");
    seen.add(source.url);
  }
  if ((receipt.status === "ready" && !receipt.cards.length) || (receipt.status !== "ready" && receipt.cards.length)) throw error("搜索列表状态与实际岗位数量不一致。");
  return receipt;
}

export type LiveBatchProviderResultClient = {
  provider: PlatformSearchInput["provider"];
  platform: z.infer<typeof platform>;
  pageUrl: string;
  status: "ready" | "empty" | "login_required" | "verification_required" | "unknown_layout" | "oversized" | "unsupported_page" | "error";
  cards: Array<PlatformSearchCard & { company: string }>;
  rawCardCount: number;
  warnings: string[];
  coverage: z.infer<typeof liveBatchCoverage>;
  error?: string;
};

export type LiveBatchSearchReceipt = {
  capturedAt: string;
  results: LiveBatchProviderResultClient[];
};

export type LiveBatchProviderProgressClient = {
  provider: PlatformSearchInput["provider"];
  platform: z.infer<typeof platform>;
  pagesVisited: number;
  scrollSteps: number;
  cardsCaptured: number;
  pageLimit: number;
  scrollLimit: number;
  cardLimit: number;
  /** New, source-validated cards only; a batch never exceeds 50 cards. */
  cards?: Array<z.infer<typeof liveBatchCard>>;
};

export type LiveBatchSearchStreamEvent =
  | { type: "provider-queued" | "provider-start"; provider: PlatformSearchInput["provider"]; platform: z.infer<typeof platform>; pageLimit: number; scrollLimit: number; cardLimit: number }
  | ({ type: "provider-progress" } & LiveBatchProviderProgressClient)
  | { type: "provider-result"; result: LiveBatchProviderResultClient };

export type LiveBatchSearchCallbacks = {
  /** Async consumers may apply bounded queue backpressure without blocking rendering. */
  onEvent?: (event: LiveBatchSearchStreamEvent) => void | Promise<void>;
};

const LIVE_BATCH_STREAM_MAX_BYTES = 24 * 1024 * 1024;

async function runLivePlatformBatchSearchStream(
  input: Parameters<typeof runLivePlatformBatchSearch>[0],
  signal: AbortSignal | undefined,
  callbacks: LiveBatchSearchCallbacks,
): Promise<LiveBatchSearchReceipt> {
  const requestedProviders = input.providers ? new Set(input.providers) : undefined;
  if (requestedProviders && (!requestedProviders.size || requestedProviders.size !== input.providers!.length)) throw error("实时搜索平台范围无效。");
  const checkRequestedProvider = (provider: PlatformSearchInput["provider"]) => {
    if (requestedProviders && !requestedProviders.has(provider)) throw error("实时搜索返回了本次未请求的平台，已停止接收其结果。");
  };
  let response: Response;
  try {
    response = await fetch("/api/jd/search-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ action: "live-batch-search-stream", input }),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    throw error("无法连接本机搜索工具。请在本机开发工作台运行，静态 Pages/Docker 不包含招聘浏览器。");
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* preserve a useful generic error */ }
    const failure = readJdFailure(payload.failure);
    if (failure) throw new JdExtractionError(failure);
    throw error(typeof payload.error === "string" ? payload.error : "实时搜索进度流未能启动。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: LiveBatchSearchReceipt | undefined;
  let totalBytes = 0;
  const queuedProviders = new Set<PlatformSearchInput["provider"]>();
  const results = new Map<PlatformSearchInput["provider"], z.infer<typeof liveBatchProviderResult>>();
  const dispatch = async (block: string) => {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { throw error("实时搜索进度流包含无效事件，不能将其视为空结果。"); }
    if (!payload || typeof payload !== "object" || !("type" in payload) || typeof payload.type !== "string") throw error("实时搜索进度流事件格式无效。");
    if (payload.type === "provider-queued" || payload.type === "provider-start") {
      const event = z.object({ type: z.enum(["provider-queued", "provider-start"]), provider: PlatformSearchInputSchema.shape.provider, platform,
        pageLimit: z.number().int().positive(), scrollLimit: z.number().int().nonnegative(), cardLimit: z.number().int().positive() }).strict().safeParse(payload);
      if (!event.success) throw error("实时搜索平台状态无效。");
      checkRequestedProvider(event.data.provider);
      if (event.data.type === "provider-queued") {
        if (queuedProviders.has(event.data.provider)) throw error("实时搜索进度流重复排入了同一平台。");
        queuedProviders.add(event.data.provider);
      } else if (!queuedProviders.has(event.data.provider)) throw error("实时搜索平台尚未排队就进入运行状态。");
      await callbacks.onEvent?.(event.data);
    } else if (payload.type === "provider-progress") {
      const event = z.object({ type: z.literal("provider-progress"), provider: PlatformSearchInputSchema.shape.provider, platform,
        pagesVisited: z.number().int().nonnegative(), scrollSteps: z.number().int().nonnegative(), cardsCaptured: z.number().int().nonnegative(),
        pageLimit: z.number().int().positive(), scrollLimit: z.number().int().nonnegative(), cardLimit: z.number().int().positive(),
        cards: z.array(liveBatchCard).max(50).optional() }).strict().superRefine((value, context) => {
          if (value.platform !== platformForProvider[value.provider]) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Live progress platform does not match its provider." });
          }
          if (value.cards?.some((item) => item.platform !== value.platform)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Live progress contains a cross-platform card." });
          }
          if ((value.cards?.length ?? 0) > value.cardsCaptured) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Live progress batch exceeds its captured card count." });
          }
        }).safeParse(payload);
      if (!event.success) throw error("实时搜索平台进度无效。");
      checkRequestedProvider(event.data.provider);
      await callbacks.onEvent?.(event.data);
    } else if (payload.type === "provider-result") {
      const event = z.object({ type: z.literal("provider-result"), result: liveBatchProviderResult }).safeParse(payload);
      if (!event.success) throw error("实时搜索平台回执无效，不能将其当作空结果。");
      checkRequestedProvider(event.data.result.provider);
      if (results.has(event.data.result.provider)) throw error("实时搜索进度流重复返回了同一平台回执。");
      results.set(event.data.result.provider, event.data.result);
      await callbacks.onEvent?.(event.data);
    } else if (payload.type === "complete") {
      const event = z.object({ type: z.literal("complete"), capturedAt: z.string().datetime({ offset: true }), providers: z.array(PlatformSearchInputSchema.shape.provider).max(7) }).strict().safeParse(payload);
      if (!event.success || new Set(event.data?.providers ?? []).size !== (event.data?.providers.length ?? 0)) throw error("实时搜索最终回执无效，不能将其当作空结果。");
      if (completed) throw error("实时搜索进度流重复返回结束回执。");
      const expected = requestedProviders ? [...requestedProviders] : event.data.providers;
      // A resumed subset has an authoritative requested scope. Queue/start
      // status events may be absent, but every requested terminal result and
      // the final declaration must still agree exactly with that scope.
      if ((!requestedProviders && (expected.length !== queuedProviders.size || expected.some(provider => !queuedProviders.has(provider))))
        || expected.length !== event.data.providers.length || expected.some(provider => !event.data.providers.includes(provider))
        || expected.length !== results.size || expected.some((provider) => !results.has(provider))) {
        throw error("实时搜索结束时缺少平台最终回执，不能将其当作空结果。");
      }
      completed = liveBatchReceipt.parse({ capturedAt: event.data.capturedAt, results: expected.map((provider) => results.get(provider)) });
    } else if (payload.type === "error") {
      const event = z.object({ type: z.literal("error"), message: z.string().max(2_000) }).safeParse(payload);
      if (!event.success) throw error("实时搜索失败回执格式无效。");
      throw error(event.data.message);
    } else throw error("实时搜索进度流包含不支持的事件类型。");
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > LIVE_BATCH_STREAM_MAX_BYTES) throw error("实时搜索进度流超过 24 MiB 安全上限，不能将其当作空结果。");
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0].length ?? 2;
        buffer = buffer.slice(boundary + separator);
        signal?.throwIfAborted();
        await dispatch(block);
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
      if (done) {
        signal?.throwIfAborted();
        if (buffer.trim()) await dispatch(buffer);
        buffer = "";
        break;
      }
      if (new TextEncoder().encode(buffer).byteLength > LIVE_BATCH_STREAM_MAX_BYTES) throw error("实时搜索进度事件超过安全大小上限。");
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!completed) throw error("实时搜索连接结束但没有最终回执；不能把断流解释为零岗位。");
  return completed;
}

export async function runLivePlatformBatchSearch(
  input: {
    keyword: string;
    regionId?: string;
    districtCode?: string;
    providers?: PlatformSearchInput["provider"][];
    depth?: "quick" | "standard" | "deep";
    maxPages?: number;
  },
  signal?: AbortSignal,
  callbacks?: LiveBatchSearchCallbacks,
): Promise<LiveBatchSearchReceipt> {
  if (callbacks?.onEvent) return runLivePlatformBatchSearchStream(input, signal, callbacks);
  const payload = await request({ action: "live-batch-search", input }, signal, false, 24 * 1024 * 1024);
  const parsed = liveBatchReceipt.safeParse(payload);
  if (!parsed.success) throw error("实时采集响应缺少有效结果或覆盖信息；不能把无效响应当成空岗位。");
  return parsed.data;
}

export type DynamicCompanyIntelligenceItem = {
  companyId?: string;
  companyName: string;
  cityHint?: string;
  rawLocation?: string;
  jobTexts?: string[];
  locationTexts?: string[];
};

export type DynamicCompanyIntelligenceResult = {
  companyName: string;
  controllers: Array<{
    name: string;
    jurisdictionCode?: string;
    kind: "state" | "private" | "dispersed" | "joint" | "unknown";
  }>;
  categoryLabel: string;
  reason: string;
  resolvedOffice?: {
    district: string;
    streetAddress: string;
    formattedAddress: string;
    latitude: number;
    longitude: number;
  };
  sourceMethod: "cache" | "live-web-search" | "structured-card" | "catalog-heuristic";
};

export async function lookupCompanyIntelligenceBatchClient(
  items: DynamicCompanyIntelligenceItem[],
  signal?: AbortSignal,
  enableWebSearch = true,
): Promise<Record<string, DynamicCompanyIntelligenceResult>> {
  if (items.length === 0) return {};
  try {
    const payload = await request(
      {
        action: "company-intelligence-batch",
        input: { items: items.slice(0, 100), enableWebSearch },
      },
      signal,
    );
    if (payload.results && typeof payload.results === "object" && !Array.isArray(payload.results)) {
      return payload.results as Record<string, DynamicCompanyIntelligenceResult>;
    }
    return {};
  } catch {
    return {};
  }
}
