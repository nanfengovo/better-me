import { z } from "zod";
import { PlatformSearchInputSchema, buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/browser-contracts";
import { allowedJobUrl } from "./jd-source";
import { readJdFailure, JdExtractionError } from "./jd-errors";
import type { JdBrowserSession } from "./jd-import";
import { createJdStartRequestId, isJdStartRequestId } from "./jd-start-request";

const platform = z.enum(["51JOB", "BOSS直聘", "猎聘", "LinkedIn"]);
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
export type PlatformSearchCard = z.infer<typeof card>;
export type PlatformSearchReceipt = z.infer<typeof result>;

// A user may advance the already-open official list to another page. These
// parameters are ignored for scope matching; keyword, region and path remain exact.
const paginationParameters = new Set(["page", "pageno", "page_no", "pagenum", "page_num", "currentpage", "current_page", "start", "offset", "pn"]);
function searchScope(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (paginationParameters.has(key.toLowerCase()) || parsed.searchParams.getAll(key).every((entry) => entry === "")) parsed.searchParams.delete(key);
    }
    return JSON.stringify({ origin: parsed.origin, pathname: parsed.pathname.replace(/\/$/, ""), query: [...parsed.searchParams.entries()].sort() });
  } catch { return undefined; }
}

const error = (message: string) => new JdExtractionError({ code: "service_unavailable", stage: "service", message });
async function request(body: unknown, signal?: AbortSignal, keepalive = false) {
  let response: Response;
  try { response = await fetch("/api/jd/search-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, keepalive }); }
  catch (cause) { if (signal?.aborted) throw signal.reason ?? cause; throw error("无法连接本机搜索工具。请在本机开发工作台运行，静态 Pages/Docker 不包含招聘浏览器。"); }
  const text = await response.text();
  if (text.length > 3 * 1024 * 1024) throw error("搜索服务返回超出单页上限的内容。");
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
  if (actual.origin !== initial.origin || searchScope(receipt.url) === undefined || searchScope(receipt.url) !== searchScope(session.url)) throw error("搜索页的关键词或地区已改变，请结束会话后重新搜索。");
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
