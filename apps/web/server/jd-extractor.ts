import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { allowedJobUrl, normalizeJobShare, type JdImportResult, type JobPlatform } from "../src/lib/jd-source";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const BLOCKED_MESSAGE = "平台未公开返回岗位正文，可能需要登录、验证码或页面加载。请打开原岗位页面，截图后用视觉识别，或手动粘贴文字。";

export function cleanJobHtml(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•", middot: "·" };
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ").replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
      if (!entity.startsWith("#")) return Object.hasOwn(entities, entity.toLowerCase()) ? entities[entity.toLowerCase()] : original;
      const point = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
    }).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function findPostings(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 20 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((child) => findPostings(child, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const type = obj["@type"];
  if ((type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) && typeof obj.description === "string") return [obj];
  return Object.values(obj).flatMap((child) => findPostings(child, depth + 1));
}

/** Read a known description element while preserving nested divs and paragraph order. */
function descriptionElement(html: string, classPattern: RegExp): string | null {
  const tags = /<([a-z][\w-]*)\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    if (!classPattern.test(match[2] ?? "")) continue;
    const tag = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const closing = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    closing.lastIndex = start;
    let depth = 1;
    let next: RegExpExecArray | null;
    while ((next = closing.exec(html))) {
      depth += next[0].startsWith("</") ? -1 : /\/>$/.test(next[0]) ? 0 : 1;
      if (depth === 0) return html.slice(start, next.index);
    }
  }
  return null;
}

export function extractPublicJobHtml(html: string, platform: JobPlatform): { text: string; title?: string; method: string } {
  const pageTitle = cleanJobHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  // A generic login / challenge page is never treated as a job description.
  if (/(?:安全验证|访问验证|人机验证|验证码|登录|\blogin\b|\bsign[ -]?in\b|security verification|just a moment|access denied|robot check)/i.test(pageTitle)) throw new Error(BLOCKED_MESSAGE);
  const postings: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try { parsed = JSON.parse((match[1] ?? "").trim()); } catch { continue; }
    postings.push(...findPostings(parsed));
  }
  const unique = [...new Map(postings.map((posting) => [`${posting.title ?? ""}:${posting.description}`, posting])).values()];
  if (unique.length > 1) throw new Error("链接包含多个岗位，请打开一个具体岗位详情后复制链接，或截图识别。");
  for (const posting of unique) {
    const description = cleanJobHtml(posting.description as string);
    if (description.length < 40) continue;
    const title = typeof posting.title === "string" ? cleanJobHtml(posting.title) : undefined;
    const organization = posting.hiringOrganization as { name?: unknown } | undefined;
    const company = organization && typeof organization.name === "string" ? cleanJobHtml(organization.name) : undefined;
    return { text: [title, company, description].filter(Boolean).join("\n\n"), title, method: "JobPosting 结构化正文" };
  }
  const selectors: Record<JobPlatform, RegExp> = {
    LinkedIn: /(?:^|\s)show-more-less-html__markup(?:\s|$)/,
    猎聘: /(?:^|\s)(?:job-intro-content|job-description|job-desc-content)(?:\s|$)/,
    "51JOB": /(?:^|\s)(?:job_msg|job-detail|job-description)(?:\s|$)/,
    BOSS直聘: /(?:^|\s)job-sec-text(?:\s|$)/,
  };
  const description = descriptionElement(html, selectors[platform]);
  if (description) {
    const text = cleanJobHtml(description);
    if (text.length >= 40 && !/(?:请先登录|登录后查看|完成安全验证|enable javascript|sign in to continue)/i.test(text)) {
      return { text: [pageTitle, text].filter(Boolean).join("\n\n"), title: pageTitle || undefined, method: "公开岗位详情正文" };
    }
  }
  throw new Error(BLOCKED_MESSAGE);
}

export async function readLimitedJobPage(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("岗位页面过大，请改用截图识别。");
  }
  if (!response.body) throw new Error(BLOCKED_MESSAGE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error("岗位页面超过 2 MB，请改用截图识别。"); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const headerCharset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const metaCharset = new TextDecoder("latin1").decode(bytes.slice(0, 4096)).match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const charset = headerCharset ?? metaCharset ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

export async function fetchPublicJd(input: string, request: typeof fetch = fetch): Promise<JdImportResult> {
  const initial = normalizeJobShare(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let target = initial.url;
  try {
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      const source = allowedJobUrl(target);
      const response = await request(source.url, {
        redirect: "manual", signal: controller.signal,
        headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "BetterMe/0.1 (user-requested public job preview)" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error(BLOCKED_MESSAGE);
        target = allowedJobUrl(new URL(location, source.url).toString()).url;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`平台返回 HTTP ${response.status}。${BLOCKED_MESSAGE}`); }
      if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new Error("平台返回的不是可读取的岗位网页，请打开原页面后截图识别。");
      }
      const result = extractPublicJobHtml(await readLimitedJobPage(response, controller.signal), source.platform);
      if (result.text.length > 120_000) throw new Error("提取的岗位正文超过 12 万字，请确认链接是否为具体岗位，或使用截图选取职责与要求。");
      return { ...result, provenance: { kind: "link", platform: source.platform, url: source.url, observedAt: new Date().toISOString(), title: result.title } };
    }
    throw new Error("平台分享链接跳转过多，请打开后复制最终岗位链接，或使用截图识别。");
  } catch (error) {
    if (controller.signal.aborted) throw new Error("岗位页面读取超过 15 秒，请稍后重试或使用截图识别。", { cause: error });
    if (error instanceof TypeError && error.message === "fetch failed") throw new Error("无法连接招聘平台，请检查网络，或打开原岗位后截图识别。", { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function middleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
  if (request.url?.split("?")[0] !== "/api/jd/extract") { next(); return; }
  if (request.method !== "POST") { sendJson(response, 405, { error: "请使用 POST 提交岗位分享链接。" }); return; }
  if (!request.headers["content-type"]?.includes("application/json")) { sendJson(response, 415, { error: "仅接受 JSON 格式的岗位链接。" }); return; }
  if (request.headers.origin) {
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) { sendJson(response, 403, { error: "岗位提取仅允许当前工作台访问。" }); return; }
    } catch { sendJson(response, 403, { error: "来源地址无效。" }); return; }
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32_000) { sendJson(response, 413, { error: "分享内容过长，请只保留岗位链接。" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { input?: unknown };
    if (typeof body.input !== "string") { sendJson(response, 400, { error: "请提供岗位分享链接。" }); return; }
    sendJson(response, 200, await fetchPublicJd(body.input));
  } catch (error) { sendJson(response, 422, { error: error instanceof Error ? error.message : "岗位正文读取失败，请使用截图识别。" }); }
}

export function jdExtractorPlugin(): Plugin {
  return {
    name: "betterme-public-jd-extractor",
    configureServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void middleware(request, response, next); }); },
  };
}
