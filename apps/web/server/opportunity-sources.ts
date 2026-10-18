import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { OpportunityInput, WorkMode } from "../src/lib/opportunities";
import { getNetworkFetch } from "./network-proxy";

const MAX_REQUEST_BYTES = 32_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JOBS = 300;
const TIMEOUT_MS = 15_000;
const GREENHOUSE_HOST = "boards-api.greenhouse.io";
const LEVER_HOST = "api.lever.co";
const TENCENT_HOST = "careers.tencent.com";
const TENCENT_PAGE_SIZE = 100;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

export type OpportunitySourceProvider = "greenhouse" | "lever" | "tencent";
export type OpportunitySourceRequest = { provider: OpportunitySourceProvider; company: string; keyword?: string };
export type OpportunitySourceResult = {
  provider: OpportunitySourceProvider;
  company: string;
  sourceUrl: string;
  observedAt: string;
  jobs: OpportunityInput[];
  truncated: boolean;
};
export type OpportunitySourceOptions = { timeoutMs?: number; now?: () => Date };

function validateRequest(value: unknown): OpportunitySourceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("机会来源请求格式不正确。");
  const body = value as Record<string, unknown>;
  if (body.provider !== "greenhouse" && body.provider !== "lever" && body.provider !== "tencent") throw new Error("仅支持 Greenhouse、Lever 或腾讯招聘官网来源。");
  if (body.provider === "tencent") {
    if (body.company !== "tencent") throw new Error("腾讯招聘来源仅允许固定公司 tencent。");
    if (body.keyword !== undefined && (typeof body.keyword !== "string" || body.keyword.trim().length > 80 || Array.from(body.keyword).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new Error("腾讯岗位关键词应为 80 字以内的普通文本。");
    return { provider: "tencent", company: "tencent", keyword: typeof body.keyword === "string" ? body.keyword.trim() : "" };
  }
  if (typeof body.company !== "string" || !SLUG_PATTERN.test(body.company.trim())) {
    throw new Error("公司 board slug 只能包含字母、数字和连字符。");
  }
  return { provider: body.provider, company: body.company.trim().toLowerCase() };
}

function endpoint(input: OpportunitySourceRequest): string {
  if (input.provider === "tencent") {
    const params = new URLSearchParams({ keyword: input.keyword ?? "", pageIndex: "1", pageSize: String(TENCENT_PAGE_SIZE), language: "zh-cn" });
    return `https://${TENCENT_HOST}/tencentcareer/api/post/Query?${params}`;
  }
  const encoded = encodeURIComponent(input.company);
  return input.provider === "greenhouse"
    ? `https://${GREENHOUSE_HOST}/v1/boards/${encoded}/jobs?content=true`
    : `https://${LEVER_HOST}/v0/postings/${encoded}?mode=json`;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•" };
    if (!entity.startsWith("#")) return Object.hasOwn(entities, entity.toLowerCase()) ? entities[entity.toLowerCase()] : original;
    const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
  });
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  // Greenhouse can encode the HTML content before placing it in JSON.
  return decodeEntities(decodeEntities(value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  if (typeof value === "string") {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!parts) return undefined;
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function publicLink(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_000) throw new Error("招聘来源包含无效的岗位链接。");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("招聘来源包含无效的岗位链接。"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(host) || host.endsWith(".home.arpa")) {
    throw new Error("招聘来源的岗位链接必须为公共 HTTPS 地址。");
  }
  return url.toString();
}

function locationText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" ? record.name.trim() : "";
}

function firstText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? "";
}

function baseJob(input: OpportunitySourceRequest, observedAt: string, values: {
  id?: unknown; title?: unknown; description?: unknown; sourceUrl?: unknown; applicationUrl?: unknown;
  sourcePublishedAt?: unknown; sourceUpdatedAt?: unknown; locationText?: unknown; workMode?: WorkMode;
  company?: unknown;
}): OpportunityInput {
  const title = text(values.title);
  const company = text(values.company) || input.company;
  const details = text(values.description);
  const place = text(values.locationText);
  const description = place ? `工作地点（原文）：${place}\n\n${details}`.trim() : details;
  const sourceUrl = publicLink(values.sourceUrl);
  const applicationUrl = publicLink(values.applicationUrl ?? sourceUrl);
  if (!title || title.length > 500 || company.length > 300 || description.length > 120_000) throw new Error("招聘来源包含缺失或过长的职位信息，请打开原页面核对。");
  const sourceJobId = typeof values.id === "string" || typeof values.id === "number" ? String(values.id) : undefined;
  if (sourceJobId && sourceJobId.length > 300) throw new Error("招聘来源岗位编号过长。");
  const job: OpportunityInput = {
    company, title, description, sourceUrl, applicationUrl, discoveryUrl: endpoint(input),
    sourcePlatform: input.provider === "greenhouse" ? "Greenhouse" : input.provider === "lever" ? "Lever" : "腾讯招聘官网",
    publisherType: "company", market: "unknown", workMode: values.workMode ?? "unknown",
    location: { country: "", region: "", city: "" }, remoteEligibleRegions: [], salaryText: "", employmentType: "unknown",
    sourceJobId,
    sourcePublishedAt: isoDate(values.sourcePublishedAt), sourceUpdatedAt: isoDate(values.sourceUpdatedAt),
    sourcePublishedText: typeof values.sourcePublishedAt === "string" && values.sourcePublishedAt.length <= 1_000 ? values.sourcePublishedAt : undefined,
    firstDiscoveredAt: observedAt, collectedAt: observedAt, lastVerifiedAt: observedAt, lastVerificationMethod: "source-read", status: "open",
  };
  return job;
}

function greenhouseJobs(input: OpportunitySourceRequest, payload: unknown, observedAt: string): OpportunityInput[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as Record<string, unknown>).jobs)) throw new Error("Greenhouse 返回格式不正确。");
  return ((payload as { jobs: unknown[] }).jobs).slice(0, MAX_JOBS).map((value) => {
    const job = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const location = locationText(job.location);
    const departments = Array.isArray(job.departments) ? job.departments.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).name : "").filter((item): item is string => typeof item === "string" && Boolean(item)).join(", ") : "";
    const description = departments ? `${departments}\n\n${typeof job.content === "string" ? job.content : ""}` : job.content;
    return baseJob(input, observedAt, { id: job.id, title: job.title, company: job.company_name, description, sourceUrl: job.absolute_url, applicationUrl: job.absolute_url, sourcePublishedAt: job.first_published, sourceUpdatedAt: job.updated_at, locationText: location });
  });
}

function leverJobs(input: OpportunitySourceRequest, payload: unknown, observedAt: string): OpportunityInput[] {
  if (!Array.isArray(payload)) throw new Error("Lever 返回格式不正确。");
  return payload.slice(0, MAX_JOBS).map((value) => {
    const job = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const categories = job.categories && typeof job.categories === "object" && !Array.isArray(job.categories) ? job.categories as Record<string, unknown> : {};
    const allLocations = Array.isArray(categories.allLocations) ? categories.allLocations.filter((item): item is string => typeof item === "string") : [];
    const location = allLocations.length ? allLocations.join(", ") : locationText(categories.location);
    const workplace = typeof job.workplaceType === "string" ? job.workplaceType.toLowerCase() : "";
    const workType: WorkMode = workplace === "remote" ? "remote" : workplace === "hybrid" ? "hybrid" : ["onsite", "on-site"].includes(workplace) ? "on-site" : "unknown";
    const sections = [firstText(job.descriptionPlain, job.openingPlain, job.description, job.opening), ...(Array.isArray(job.lists) ? job.lists.map((item) => item && typeof item === "object" ? `${firstText((item as Record<string, unknown>).text)}\n${firstText((item as Record<string, unknown>).content)}` : "") : []), firstText(job.additionalPlain, job.additional)].filter((item) => item.trim()).join("\n\n");
    return baseJob(input, observedAt, { id: job.id, title: job.text, description: sections, sourceUrl: job.hostedUrl, applicationUrl: job.applyUrl ?? job.hostedUrl, sourcePublishedAt: job.createdAt, locationText: location, workMode: workType });
  });
}

function tencentData(payload: unknown): { Posts: unknown[]; Count: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("腾讯招聘返回格式不正确。");
  const response = payload as Record<string, unknown>;
  if (response.Code !== 200) throw new Error("腾讯招聘暂未返回成功结果，请打开官网核对。");
  const data = response.Data && typeof response.Data === "object" && !Array.isArray(response.Data) ? response.Data as Record<string, unknown> : {};
  if (!Array.isArray(data.Posts) || typeof data.Count !== "number" || !Number.isSafeInteger(data.Count) || data.Count < 0 || data.Count < data.Posts.length) throw new Error("腾讯招聘返回格式不正确。");
  return { Posts: data.Posts, Count: data.Count };
}

function tencentPostUrl(post: Record<string, unknown>): string {
  // Use the posting ID, not RecruitPostId (which can cover several postings).
  if (typeof post.PostId !== "string" || !/^\d{1,30}$/.test(post.PostId)) throw new Error("腾讯招聘岗位编号格式不正确。");
  if (post.PostURL !== undefined && post.PostURL !== "") {
    let original: URL;
    try { original = new URL(String(post.PostURL)); } catch { throw new Error("腾讯招聘岗位链接格式不正确。"); }
    // A current official search result delegates its detail/application to this
    // Tencent Workday tenant. Preserve that exact HTTPS link without fetching it.
    if (original.hostname === "tencent.wd1.myworkdayjobs.com" && original.pathname.startsWith("/Tencent_Careers/job/")) return publicLink(original.toString());
    if (!["http:", "https:"].includes(original.protocol) || original.hostname !== TENCENT_HOST || original.port || original.username || original.password || original.pathname !== "/jobdesc.html" || original.searchParams.get("postId") !== post.PostId) throw new Error("腾讯招聘岗位链接必须来自固定官方岗位页。");
  }
  // The official API currently supplies HTTP links; the same official page supports HTTPS.
  return `https://${TENCENT_HOST}/jobdesc.html?postId=${post.PostId}`;
}

function tencentJobs(input: OpportunitySourceRequest, payload: unknown, observedAt: string): OpportunityInput[] {
  return tencentData(payload).Posts.slice(0, TENCENT_PAGE_SIZE).map((value) => {
    const post = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const country = text(post.CountryName), city = text(post.LocationName);
    const details = [
      "【官网搜索结果摘录】以下为搜索接口提供的岗位职责，可能不含完整任职要求；请打开原岗位核对后再用于匹配。",
      text(post.BGName) && `事业群（原文）：${text(post.BGName)}`,
      text(post.CategoryName) && `类别（原文）：${text(post.CategoryName)}`,
      text(post.RequireWorkYearsName) && `经验（原文）：${text(post.RequireWorkYearsName)}`,
      typeof post.RecruitPostId === "number" && Number.isSafeInteger(post.RecruitPostId) && `招聘编号（非唯一岗位编号）：${post.RecruitPostId}`,
      text(post.LastUpdateTime) && `来源最后更新日期（原文）：${text(post.LastUpdateTime)}。来源未给出时分秒和时区，未补造精确时间；此日期不是原始发布日期。`,
      text(post.Responsibility),
    ].filter(Boolean).join("\n\n");
    const job = baseJob(input, observedAt, { id: post.PostId, title: post.RecruitPostName, company: "腾讯", description: details, sourceUrl: tencentPostUrl(post), locationText: [country, city].filter(Boolean).join(" · ") });
    job.location = { country, region: "", city: /[,，、/;；\n]/.test(city) ? "" : city };
    // Only this exact source country value has a defined domestic interpretation here.
    // Other country/region labels remain available verbatim for the user to classify.
    job.market = country === "中国" ? "domestic" : "unknown";
    job.status = post.IsValid === true ? "open" : post.IsValid === false ? "closed" : "unknown";
    return job;
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error("招聘来源响应超过 8 MB，已停止读取。"); }
  if (!response.body) throw new Error("招聘来源没有返回内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("招聘来源响应超过 8 MB，已停止读取。"); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("招聘来源返回的不是有效 JSON。"); }
}

export async function fetchOpportunitySource(inputValue: unknown, request: typeof fetch = fetch, options: OpportunitySourceOptions = {}): Promise<OpportunitySourceResult> {
  const input = validateRequest(inputValue);
  const sourceUrl = endpoint(input);
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(sourceUrl, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "BetterMe/0.1 (user-requested public opportunity source)" } });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("招聘来源发生了跳转，已拒绝读取非固定官方接口。"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`招聘来源返回 HTTP ${response.status}。请核对公司 board slug。`); }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await response.body?.cancel(); throw new Error("招聘来源返回的不是 JSON。"); }
    const payload = await readJson(response, controller.signal);
    if (input.provider === "tencent") {
      const data = tencentData(payload);
      const jobs = tencentJobs(input, payload, observedAt);
      return { provider: input.provider, company: input.company, sourceUrl, observedAt, jobs, truncated: data.Count > jobs.length || data.Posts.length > TENCENT_PAGE_SIZE };
    }
    const rawJobs = input.provider === "greenhouse" ? (payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray((payload as Record<string, unknown>).jobs) ? (payload as { jobs: unknown[] }).jobs : []) : Array.isArray(payload) ? payload : [];
    const jobs = input.provider === "greenhouse" ? greenhouseJobs(input, payload, observedAt) : leverJobs(input, payload, observedAt);
    return { provider: input.provider, company: input.company, sourceUrl, observedAt, jobs, truncated: rawJobs.length > MAX_JOBS };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`招聘来源读取超时（${timeoutMs / 1_000} 秒），请稍后重试。`, { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createOpportunitySourceMiddleware(fetcher?: typeof fetch) {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
  if (request.url?.split("?")[0] !== "/api/opportunities/source") { next(); return; }
  if (request.method !== "POST") { sendJson(response, 405, { error: "请使用 POST 获取机会来源。" }); return; }
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") { sendJson(response, 415, { error: "仅接受 JSON 格式的机会来源请求。" }); return; }
  try {
    if (!request.headers.origin || !request.headers.host) throw new Error("missing origin");
    const origin = new URL(request.headers.origin);
    const secure = "encrypted" in request.socket && request.socket.encrypted;
    if (origin.origin !== request.headers.origin || origin.origin !== `${secure ? "https" : "http"}://${request.headers.host}`) throw new Error("origin mismatch");
    if (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))) throw new Error("cross-site");
  } catch { sendJson(response, 403, { error: "机会来源仅允许当前工作台的同源请求访问。" }); return; }
  try {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > MAX_REQUEST_BYTES) { sendJson(response, 413, { error: "请求内容过长。" }); return; } chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    sendJson(response, 200, await fetchOpportunitySource(body, fetcher ?? await getNetworkFetch()));
  } catch (error) { sendJson(response, 422, { error: error instanceof Error ? error.message : "招聘来源读取失败。" }); }
  };
}

export function opportunitySourcesPlugin(): Plugin {
  const middleware = createOpportunitySourceMiddleware();
  return {
    name: "betterme-opportunity-sources",
    configureServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
  };
}
