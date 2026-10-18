import { load } from "cheerio";
import type { Page, Request, Response } from "playwright-core";
import type { JdImportResult } from "../src/lib/jd-source";
import type { BrowserSnapshot } from "./jd-browser-snapshot";

export const MAX_BOSS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 120_000;
const ENDPOINT = "/wapi/zpgeek/job/detail.json";
const EXCLUDED = "script,style,template,noscript,iframe,input,textarea,select,button,nav,aside,footer,.recommend,.recommendation,.recommendations,.job-recommend,.job-recommend-list,.related-jobs,[hidden],[aria-hidden='true']";

export type BossDetail = { jobId: string; title: string; description: string; company?: string };
export type BossResponseEvidence = {
  /** The caller must confirm the current main-document Request actually committed. */
  committed: boolean;
  /** Pass gates detected by the existing browser/extractor checks before this fallback. */
  gate?: "login_required" | "verification_required";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, max: number, min = 1): string | undefined {
  if (typeof value !== "string" || value.length > max) return;
  if ([...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  })) return;
  const text = value.replace(/\r\n?/g, "\n").trim();
  // Only the observed plain-text fields are supported; never reinterpret HTML or stringify objects.
  if (text.length < min || /<\/?[a-z][^>]*>/i.test(text)) return;
  return text;
}

/** Strictly parse the observed success shape; no recursive search or invented fallback fields. */
export function parseBossDetailResponse(value: unknown, expectedJobId: string): BossDetail | undefined {
  try {
    if (!/^[a-z\d_-]{1,256}$/i.test(expectedJobId)) return;
    const root = record(value);
    const data = record(root?.zpData);
    const job = record(data?.jobInfo);
    if (root?.code !== 0 || job?.encryptJobId !== expectedJobId) return;
    const title = boundedText(job.jobName, 300);
    const description = boundedText(job.jobDesc, MAX_DESCRIPTION_CHARS, 40);
    if (!title || /[\n\t]/u.test(title) || !description) return;
    const company = boundedText(record(data?.brandComInfo)?.brandName, 500);
    return {
      jobId: expectedJobId, title, description,
      ...(company && !/[\n\t]/u.test(company) ? { company } : {}),
    };
  } catch { return; }
}

export function isBossDetailResponseUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      && ["m.zhipin.com", "www.zhipin.com"].includes(url.hostname)
      && url.pathname === ENDPOINT && !url.hash;
  } catch { return false; }
}

function pageJobId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !["zhipin.com", "m.zhipin.com", "www.zhipin.com"].includes(url.hostname)) return;
    return url.pathname.match(/^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i)?.[1]
      ?? url.pathname.match(/^\/job_detail\/([a-z\d_-]+)\.html\/?$/i)?.[1];
  } catch { return; }
}

const normalized = (text: string) => text.replace(/\s+/gu, " ").trim();

function visibleEvidence(snapshot: BrowserSnapshot, expectedJobId: string): string | undefined {
  if (snapshot.oversized || typeof snapshot.html !== "string" || Buffer.byteLength(snapshot.html, "utf8") > MAX_BOSS_RESPONSE_BYTES) return;
  const $ = load(snapshot.html);
  $(EXCLUDED).remove();
  $("[style]").each((_index, element) => {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0*)?)\s*(?:!important\s*)?(?:;|$)/i.test($(element).attr("style") ?? "")) $(element).remove();
  });
  const canonical = $("link[rel='canonical']").attr("href");
  if (canonical && pageJobId(new URL(canonical, snapshot.url).toString()) !== expectedJobId) return;
  const gatePattern = /^(?:(?:用户|账号|帐号|会员)?登录|请先登录|请登录后查看|登录后查看|安全验证|访问验证|人机验证|验证码|sign[ -]?in|log[ -]?in|security verification|just a moment|access denied|robot check)(?:\s|[|·:：_—-]|$)/i;
  if (gatePattern.test($("title").first().text().trim()) || gatePattern.test($("h1").first().text().trim())) return;
  let visibleGate = false;
  $("[role='dialog'],[aria-modal='true'],dialog[open]").each((_index, element) => {
    if (/(?:请先登录|请登录|登录后查看|安全验证|人机验证|访问验证|请.{0,8}验证码|sign in to continue|verify.{0,15}human)/i.test($(element).text())) visibleGate = true;
  });
  if (visibleGate) return;
  $("br").replaceWith("\n");
  $("p,div,section,article,main,li,ul,ol,h1,h2,h3,h4,h5,h6,dt,dd,table,tr").append("\n");
  return normalized($("body").text());
}

/**
 * Observe only this page's naturally returned response. No requests, page scripts,
 * Cookie access or replay are used. Two MiB is an adoption limit: Playwright's
 * response.body() buffers a response that the browser has already downloaded.
 * Attach before navigation. Pass a validated visibility-filtered snapshot only
 * after the caller's source, gate and current-Request commit checks.
 */
export function createBossResponseObserver(page: Page, options: {
  expectedJobId: string;
  sourceUrl: string;
  signal?: AbortSignal;
  now?: () => number;
}) {
  let closed = false;
  let generation = 0;
  let latestRequest: Request | undefined;
  let detail: { generation: number; request: Request; value: BossDetail } | undefined;
  const requests = new WeakMap<Request, number>();
  const enabled = pageJobId(options.sourceUrl) === options.expectedJobId && /^[a-z\d_-]{1,256}$/i.test(options.expectedJobId);
  const reset = () => { generation += 1; latestRequest = undefined; detail = undefined; };
  const mainFrameRequest = (request: Request) => {
    try { return request.frame() === page.mainFrame(); } catch { return false; }
  };
  const requestStarted = (request: Request) => {
    if (closed || !enabled || !mainFrameRequest(request)) return;
    if (request.isNavigationRequest() && request.resourceType() === "document") { reset(); return; }
    if (!["xhr", "fetch"].includes(request.resourceType()) || request.method() !== "GET" || !isBossDetailResponseUrl(request.url())) return;
    latestRequest = request;
    detail = undefined;
    requests.set(request, generation);
  };
  const navigated = (frame: ReturnType<Page["mainFrame"]>) => { if (frame === page.mainFrame()) reset(); };
  const responseReturned = (response: Response) => {
    void (async () => {
      if (closed || !enabled || options.signal?.aborted || response.status() !== 200 || !isBossDetailResponseUrl(response.url())) return;
      const request = response.request();
      const requestGeneration = requests.get(request);
      if (request !== latestRequest || requestGeneration !== generation || !mainFrameRequest(request)) return;
      const isCurrent = () => !closed && !options.signal?.aborted && generation === requestGeneration && latestRequest === request;
      const contentType = await response.headerValue("content-type");
      if (!isCurrent() || !contentType || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType)) return;
      const length = await response.headerValue("content-length");
      if (!isCurrent() || (length !== null && (!/^\d+$/.test(length.trim()) || Number(length) > MAX_BOSS_RESPONSE_BYTES))) return;
      const body = await response.body();
      if (!isCurrent() || body.byteLength > MAX_BOSS_RESPONSE_BYTES) return;
      const value = parseBossDetailResponse(JSON.parse(body.toString("utf8")), options.expectedJobId);
      if (value && isCurrent()) detail = { generation, request, value };
    })().catch(() => undefined);
  };
  const requestFailed = (request: Request) => {
    if (request === latestRequest) { latestRequest = undefined; detail = undefined; }
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    reset();
    page.off("request", requestStarted);
    page.off("response", responseReturned);
    page.off("requestfailed", requestFailed);
    page.off("framenavigated", navigated);
    page.off("close", dispose);
    options.signal?.removeEventListener("abort", dispose);
  };
  const candidate = (snapshot: BrowserSnapshot, evidence: BossResponseEvidence): JdImportResult | undefined => {
    try {
      if (closed || !enabled || options.signal?.aborted || !evidence.committed || evidence.gate || snapshot.gate || !detail
        || detail.generation !== generation || detail.request !== latestRequest || page.isClosed()
        || snapshot.url !== page.url() || pageJobId(snapshot.url) !== options.expectedJobId) return;
      const text = visibleEvidence(snapshot, options.expectedJobId);
      const value = detail.value;
      if (!text || !text.includes(normalized(value.title)) || !text.includes(normalized(value.description))) return;
      const company = value.company && text.includes(normalized(value.company)) ? value.company : undefined;
      return {
        text: [value.title, company, value.description].filter(Boolean).join("\n\n"),
        method: "BOSS 自然响应 + 当前可见岗位正文核对",
        provenance: { kind: "link", platform: "BOSS直聘", url: options.sourceUrl, title: value.title, observedAt: new Date((options.now ?? Date.now)()).toISOString() },
      };
    } catch { return; }
  };
  if (options.signal?.aborted) closed = true;
  else {
    page.on("request", requestStarted);
    page.on("response", responseReturned);
    page.on("requestfailed", requestFailed);
    page.on("framenavigated", navigated);
    page.on("close", dispose);
    options.signal?.addEventListener("abort", dispose, { once: true });
  }
  return { candidate, reset, dispose };
}
