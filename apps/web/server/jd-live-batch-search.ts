import {
  buildPlatformSearchRequest,
  PlatformSearchProviderSchema,
  resolvePlatformSearchRegion,
  ReviewedSearchCardSchema,
  reviewedCardIdentity,
  reviewedCardsSearchPage,
  type PlatformSearchProvider,
  type ReviewedSearchCard,
} from "@better-me/source-adapters";
import { z } from "zod";
import { checkCdpRunning, launchRealChromeCdp, focusRealChromeWindow } from "./jd-real-chrome-launcher";
import { connectNativeCdp, type NativeCdp, type NativeTargetList } from "./jd-native-cdp";
import { NATIVE_ROOT_SCROLL_STYLES, projectNativeDomSnapshot } from "./jd-cdp-dom-snapshot";
import { extractJobSearchCards, type JobSearchCard } from "./jd-search-capture";
import { getNetworkFetch } from "./network-proxy";
import type { JobPlatform } from "../src/lib/jd-source";

export const LiveBatchSearchInputSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  regionId: z.string().trim().min(1).max(64)
    .refine((value) => resolvePlatformSearchRegion(value) !== undefined, "未找到该地区的明确映射；请重新选择搜索地区。")
    .optional(),
  districtCode: z.string().regex(/^\d{6}$/).optional(),
  providers: z.array(PlatformSearchProviderSchema).min(1).max(7).optional(),
  interactiveWaitMs: z.number().int().min(0).max(120_000).optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
});
export type LiveBatchSearchInput = z.infer<typeof LiveBatchSearchInputSchema>;

export type LiveBatchStopReason = "exhausted" | "page_limit" | "scroll_limit" | "card_limit" | "no_progress" | "gate" | "error" | "cancelled";
export type LiveBatchCoverage = {
  pagesVisited: number;
  scrollSteps: number;
  scrollLimit: number;
  pageLimit: number;
  cardLimit: number;
  stopReason: LiveBatchStopReason;
  partial: boolean;
};

export function createLiveBatchCoverage(options: {
  pagesVisited?: number;
  scrollSteps?: number;
  scrollLimit?: number;
  pageLimit: number;
  cardLimit: number;
  stopReason: LiveBatchStopReason;
}): LiveBatchCoverage {
  return {
    pagesVisited: options.pagesVisited ?? 0,
    scrollSteps: options.scrollSteps ?? 0,
    scrollLimit: options.scrollLimit ?? 0,
    pageLimit: options.pageLimit,
    cardLimit: options.cardLimit,
    stopReason: options.stopReason,
    partial: options.stopReason !== "exhausted",
  };
}

export function liveBatchPageBudget(depth: "quick" | "standard" | "deep" = "standard", requested?: number): number {
  return Math.max(1, Math.min(50, Math.trunc(requested ?? (depth === "deep" ? 50 : depth === "standard" ? 20 : 5))));
}

export function liveBatchCardBudget(depth: "quick" | "standard" | "deep" = "standard"): number {
  return depth === "deep" ? 3000 : depth === "standard" ? 1500 : 500;
}

export function liveBatchProviderPageBudget(
  provider: PlatformSearchProvider,
  depth: "quick" | "standard" | "deep" = "standard",
  requested?: number,
): number {
  return provider === "boss" ? 1 : liveBatchPageBudget(depth, requested);
}

/**
 * BOSS renders one virtual result list instead of numbered search pages. Its
 * coverage must therefore be expressed as scroll batches, independently from
 * the page budget used by numbered providers.
 */
export function liveBatchScrollBudget(
  provider: PlatformSearchProvider,
  depth: "quick" | "standard" | "deep" = "standard",
): number {
  if (provider !== "boss") return 0;
  return depth === "deep" ? 300 : depth === "standard" ? 80 : 20;
}

/** Run independent providers concurrently without creating unbounded CDP tabs. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Concurrency must be a positive integer.");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function areAllLinkedInPagesExplicitlyEmpty(statuses: readonly string[], failedPages: number): boolean {
  return statuses.length > 0 && failedPages === 0 && statuses.every((status) => status === "empty");
}

export function isCompleteLinkedInEmptyResult(
  statuses: readonly string[],
  failedPages: number,
  pagesVisited: number,
  pageLimit: number,
): boolean {
  return pagesVisited < pageLimit && areAllLinkedInPagesExplicitlyEmpty(statuses, failedPages);
}

export function isFirstPlatformPage(pageUrl: string, provider: PlatformSearchProvider): boolean {
  try {
    const url = new URL(pageUrl);
    const firstPageValues: Partial<Record<PlatformSearchProvider, Record<string, string>>> = {
      "51job": { pageNum: "1" },
      // Liepin's currentPage is zero-based; `0` is the first result page.
      liepin: { currentPage: "0" },
      boss: { page: "1" },
      linkedin: { start: "0" },
      seek: { page: "1" },
      indeed: { start: "0" },
      gradconnection: { page: "1" },
    };
    return Object.entries(firstPageValues[provider] ?? {}).every(([key, firstValue]) => {
      const value = url.searchParams.get(key);
      return value === null || value === "" || value === firstValue;
    });
  } catch {
    return false;
  }
}

export type LiveBatchProviderResult = {
  provider: PlatformSearchProvider;
  platform: JobPlatform;
  pageUrl: string;
  status: "ready" | "empty" | "login_required" | "verification_required" | "unknown_layout" | "oversized" | "unsupported_page" | "error";
  cards: ReviewedSearchCard[];
  rawCardCount: number;
  warnings: string[];
  coverage: LiveBatchCoverage;
  error?: string;
};

export type LiveBatchProviderProgress = {
  provider: PlatformSearchProvider;
  platform: JobPlatform;
  pagesVisited: number;
  scrollSteps: number;
  cardsCaptured: number;
  /** Newly captured cards only, after source and evidence validation. */
  cards?: ReviewedSearchCard[];
};

export type LiveBatchSearchCallbacks = {
  onProviderQueued?: (provider: PlatformSearchProvider, platform: JobPlatform) => void | Promise<void>;
  onProviderStart?: (provider: PlatformSearchProvider, platform: JobPlatform) => void | Promise<void>;
  onProviderProgress?: (progress: LiveBatchProviderProgress) => void | Promise<void>;
  onProviderResult?: (result: LiveBatchProviderResult) => void | Promise<void>;
};

async function safelyReport(callback: (() => void | Promise<void>) | undefined) {
  if (!callback) return;
  try { await callback(); } catch { /* Progress listeners must not change collection outcomes. */ }
}

export type LiveBatchSearchResult = {
  capturedAt: string;
  results: LiveBatchProviderResult[];
};

const PLATFORM_HOST_MATCH: Record<PlatformSearchProvider, (hostname: string) => boolean> = {
  liepin: (h) => h === "www.liepin.com" || h.endsWith(".liepin.com"),
  "51job": (h) => h === "we.51job.com" || h.endsWith(".51job.com"),
  boss: (h) => h === "www.zhipin.com" || h.endsWith(".zhipin.com"),
  linkedin: (h) => h === "www.linkedin.com" || h.endsWith(".linkedin.com"),
  seek: (h) => h === "www.seek.com.au" || h.endsWith(".seek.com.au"),
  indeed: (h) => h === "www.indeed.com" || h.endsWith(".indeed.com"),
  gradconnection: (h) => h === "au.gradconnection.com" || h.endsWith(".gradconnection.com"),
};

export function sanitizeReviewedCards(
  rawCards: JobSearchCard[],
  provider: PlatformSearchProvider,
  _pageUrl: string,
  _keyword?: string,
  maxCards = 3000,
): ReviewedSearchCard[] {
  if (!Number.isInteger(maxCards) || maxCards < 1 || maxCards > 3000) throw new RangeError("Live card limit must be between 1 and 3000.");
  const seen = new Set<string>();
  const valid: ReviewedSearchCard[] = [];
  const normalize = (v: string) => v.replace(/\s+/gu, " ").trim();

  for (const raw of rawCards) {
    if (!raw.company || !raw.company.trim() || !raw.title || !raw.title.trim()) continue;
    const identity = reviewedCardIdentity(raw.url, provider);
    if (!identity || seen.has(identity.id)) continue;
    const canonicalPageUrl = reviewedCardsSearchPage(raw.evidence.pageUrl, provider);
    if (!canonicalPageUrl) continue;

    const title = raw.title.trim();
    const rawCardText = raw.cardText || `${raw.title} ${raw.company} ${raw.salaryText || ""} ${raw.locationText || ""}`;
    const isManualLabor = /^(?:.*?(?:维修技师|机修|修车|焊工|钳工|电工|钣金|油漆工|保洁|保安|保洁员|前台|前台接待|客房服务|服务员|收银|普工|操作工|产线工|组装工|搬运|仓管员|装卸工|外卖员|骑手|司机|跟车|厨师|切配)).*$/i.test(title);
    const hasTechMarker = /(?:c#|\.net|asp\.net|wpf|winform|winforms|上位机|软件|程序|算法|开发|代码|编程|全栈|架构|it|developer|engineer|software|java|python|c\+\+|vue|react)/i.test(`${title} ${rawCardText}`);
    if (isManualLabor && !hasTechMarker) {
      continue; // Filter out completely unrelated manual/labor ads returned by platform search (e.g. 车身设备维修技师)
    }

    // Return compact list evidence, not an unbounded page/detail dump. The exact
    // vacancy URL remains available on the card; limiting excerpts keeps deep
    // 3,000-card batches within a practical local-service response budget.
    const excerptPrefix = `${raw.title} ${raw.company}`;
    const excerptLength = Math.max(0, 1_200 - excerptPrefix.length - 1);
    const cardText = `${excerptPrefix}\n${rawCardText.slice(0, excerptLength)}`;

    const normCard = normalize(cardText);
    const validLoc = raw.locationText && normCard.includes(normalize(raw.locationText)) ? raw.locationText : undefined;
    const validSal = raw.salaryText && normCard.includes(normalize(raw.salaryText)) ? raw.salaryText : undefined;
    const isActivity = raw.publicationText && /更新|活跃|在线|上线|回复|刷新|updated?|active|replied|viewed|promoted/i.test(raw.publicationText);
    const validPub = raw.publicationText && !isActivity && normCard.includes(normalize(raw.publicationText)) ? raw.publicationText : undefined;

    const fields: Array<{ field: "url" | "title" | "company" | "locationText" | "salaryText" | "publicationText"; selector: string; text: string }> = [
      { field: "url", selector: "a", text: identity.url },
      { field: "title", selector: ".jname, .jobTitleBox, h3", text: raw.title },
      { field: "company", selector: ".cname, .companyName, .company", text: raw.company },
    ];
    if (validLoc) fields.push({ field: "locationText", selector: ".dregion, .labels-box, .location", text: validLoc });
    if (validSal) fields.push({ field: "salaryText", selector: ".sal, .salary", text: validSal });
    if (validPub) fields.push({ field: "publicationText", selector: "time, .time", text: validPub });

    const candidate = {
      platform: raw.platform,
      url: identity.url,
      title: raw.title,
      company: raw.company,
      ...(validLoc ? { locationText: validLoc } : {}),
      ...(validSal ? { salaryText: validSal } : {}),
      ...(validPub ? { publicationText: validPub } : {}),
      cardText,
      evidence: {
        pageUrl: canonicalPageUrl,
        cardSelector: raw.evidence?.cardSelector || ".job-card",
        fields,
      },
    };

    const parsed = ReviewedSearchCardSchema.safeParse(candidate);
    if (parsed.success) {
      seen.add(identity.id);
      valid.push(parsed.data);
      if (valid.length >= maxCards) break;
    }
  }

  return valid;
}

export const LIVE_BATCH_PROGRESS_CARD_LIMIT = 50;

/**
 * Progress events are deliberately smaller than final provider receipts. Only
 * cards that pass the same source/evidence checks as ingestion may be exposed,
 * and each SSE frame is capped to keep backpressure bounded.
 */
export function sanitizeProgressCardBatches(
  rawCards: JobSearchCard[],
  provider: PlatformSearchProvider,
  pageUrl: string,
  keyword: string,
  maxCards = 3000,
  previouslyPublished?: Set<string>,
): ReviewedSearchCard[][] {
  const seen = previouslyPublished ?? new Set<string>();
  const reviewed = sanitizeReviewedCards(rawCards, provider, pageUrl, keyword, maxCards)
    .filter((card) => {
      const identity = reviewedCardIdentity(card.url, provider);
      if (!identity || seen.has(identity.id)) return false;
      seen.add(identity.id);
      return true;
    });
  const batches: ReviewedSearchCard[][] = [];
  for (let offset = 0; offset < reviewed.length; offset += LIVE_BATCH_PROGRESS_CARD_LIMIT) {
    batches.push(reviewed.slice(offset, offset + LIVE_BATCH_PROGRESS_CARD_LIMIT));
  }
  return batches;
}

function extractCardsFromRawDomSnapshot(
  raw: any,
  platform: JobPlatform,
  pageUrl: string,
): JobSearchCard[] {
  if (!raw || !raw.documents || !raw.documents[0]) return [];
  const doc = raw.documents[0];
  const nodes = doc.nodes;
  if (!nodes || !nodes.nodeName) return [];
  const strings: string[] = raw.strings || [];
  const s = (idx: number) => (typeof idx === "number" && idx >= 0 ? strings[idx] || "" : "");
  const getAttrs = (idx: number): Record<string, string> => {
    const arr = nodes.attributes?.[idx] || [];
    const out: Record<string, string> = {};
    for (let i = 0; i < arr.length; i += 2) out[s(arr[i])] = s(arr[i + 1]);
    return out;
  };
  const children = new Map<number, number[]>();
  for (let i = 0; i < nodes.parentIndex.length; i++) {
    const p = nodes.parentIndex[i];
    if (p >= 0) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(i);
    }
  }
  const textOf = (idx: number): string => {
    if (nodes.nodeType[idx] === 3) return s(nodes.nodeValue[idx]);
    let out = "";
    for (const c of children.get(idx) || []) out += " " + textOf(c);
    return out.replace(/\s+/g, " ").trim();
  };

  const cards: JobSearchCard[] = [];

  if (platform === "51JOB") {
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const attrs = getAttrs(i);
      const cls = attrs.class || "";
      if (cls.includes("joblist-item") || cls.includes("post-item") || cls.includes("job-item")) {
        let data: any = null;
        if (attrs.sensorsdata) {
          try { data = JSON.parse(attrs.sensorsdata); } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
        }
        let title = String(data?.jobTitle || "").trim();
        let salary = String(data?.jobSalary || "").trim();
        let location = String(data?.jobArea || "").trim();
        const publication = String(data?.jobTime || "").trim();
        const jobId = String(data?.jobId || "");
        let company = "";
        let href = "";

        const queue = [...(children.get(i) || [])];
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const cAttrs = getAttrs(curr);
          const cCls = cAttrs.class || "";
          if (cAttrs.href && (cAttrs.href.includes("jobs.51job.com") || cAttrs.href.includes("/job/"))) {
            href = cAttrs.href.startsWith("http") ? cAttrs.href : `https://jobs.51job.com${cAttrs.href}`;
          }
          if (cCls.includes("jname") || cCls.includes("job-name") || cCls.includes("jobTitle")) {
            if (!title) title = textOf(curr).trim();
          }
          if (cCls.includes("cname") || cCls.includes("company-name") || cCls.includes("companyTitle")) {
            if (!company) company = textOf(curr).trim();
          }
          if (cCls.includes("sal") || cCls.includes("salary")) {
            if (!salary) salary = textOf(curr).trim();
          }
          if (cCls.includes("dregion") || cCls.includes("area") || cCls.includes("location")) {
            if (!location) location = textOf(curr).trim();
          }
          queue.push(...(children.get(curr) || []));
        }

        const url = href || (jobId ? `https://jobs.51job.com/all/${jobId}.html` : "");
        if (title && company && (location || salary || url)) {
          const cardText = textOf(i);
          cards.push({
            platform: "51JOB",
            url: url || `${pageUrl}#${cards.length}`,
            title,
            company,
            ...(location ? { locationText: location } : {}),
            ...(salary ? { salaryText: salary } : {}),
            ...(publication ? { publicationText: publication } : {}),
            cardText: cardText || `${title} ${company} ${salary} ${location}`,
            evidence: {
              pageUrl,
              cardSelector: ".joblist-item",
              fields: [
                { field: "url", selector: "a", text: url },
                { field: "title", selector: ".jname", text: title },
                { field: "company", selector: ".cname", text: company },
                ...(location ? [{ field: "locationText" as const, selector: ".dregion", text: location }] : []),
                ...(salary ? [{ field: "salaryText" as const, selector: ".sal", text: salary }] : []),
              ],
            },
          });
        }
      }
    }
  } else if (platform === "猎聘") {
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const attrs = getAttrs(i);
      const cls = attrs.class || "";
      if (cls.includes("jobCardPcContainer") || cls.includes("job-card-pc-container")) {
        let href = "";
        let title = "";
        let company = "";
        let salary = "";
        let location = "";
        let publication = "";
        const queue = [...(children.get(i) || [])];
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const cAttrs = getAttrs(curr);
          const cCls = cAttrs.class || "";
          if (cAttrs.href && /^\/(?:job|a)\/\d+\.shtml/.test(cAttrs.href)) {
            href = cAttrs.href.startsWith("http") ? cAttrs.href : `https://www.liepin.com${cAttrs.href.split("?")[0]}`;
          }
          if (cCls.includes("jobTitleBox") || cCls.includes("title-box")) {
            title = textOf(curr).replace(/^招聘\s*/, "").trim();
          }
          if (cCls.includes("companyName") || cCls.includes("company-name")) {
            company = textOf(curr).trim();
          }
          if (cCls.includes("salary")) {
            salary = textOf(curr).trim();
          }
          if (cCls.includes("labels-box") || cCls.includes("job-labels-box")) {
            const lblText = textOf(curr);
            const locMatch = lblText.match(/【\s*([^】]+?)\s*】/);
            if (locMatch) location = locMatch[1]!.trim();
          }
          if (cCls.includes("time") || cCls.includes("publish-time")) {
            publication = textOf(curr).trim();
          }
          queue.push(...(children.get(curr) || []));
        }
        if (href && title && company) {
          const cardText = textOf(i);
          cards.push({
            platform: "猎聘",
            url: href,
            title,
            company,
            ...(location ? { locationText: location } : {}),
            ...(salary ? { salaryText: salary } : {}),
            ...(publication ? { publicationText: publication } : {}),
            cardText: cardText || `${title} ${company} ${salary} ${location}`,
            evidence: {
              pageUrl,
              cardSelector: ".jobCardPcContainer",
              fields: [
                { field: "url", selector: "a", text: href },
                { field: "title", selector: ".jobTitleBox", text: title },
                { field: "company", selector: ".companyName", text: company },
                ...(location ? [{ field: "locationText" as const, selector: ".labels-box", text: location }] : []),
                ...(salary ? [{ field: "salaryText" as const, selector: ".salary", text: salary }] : []),
              ],
            },
          });
        }
      }
    }
  } else if (platform === "BOSS直聘") {
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const attrs = getAttrs(i);
      const cls = attrs.class || "";
      if (
        cls.includes("job-card-box") ||
        cls.includes("job-card-wrap") ||
        cls.includes("job-card-wrapper") ||
        cls.includes("job-primary")
      ) {
        let href = "";
        let title = "";
        let company = "";
        let salary = "";
        let location = "";
        let publication = "";
        const queue = [...(children.get(i) || [])];
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const cAttrs = getAttrs(curr);
          const cCls = cAttrs.class || "";
          if (cAttrs.href && /^\/job_detail\/[a-z\d_-]+\.html/i.test(cAttrs.href)) {
            href = cAttrs.href.startsWith("http") ? cAttrs.href : `https://www.zhipin.com${cAttrs.href.split("?")[0]}`;
          }
          if (cCls.includes("job-name") || (cCls.includes("name") && (nodes.nodeName[curr] === "SPAN" || nodes.nodeName[curr] === "A"))) {
            if (!title) title = textOf(curr).trim();
          }
          if (cCls.includes("company-name") || cCls.includes("boss-name") || (cCls.includes("name") && cCls.includes("company"))) {
            if (!company) company = textOf(curr).trim();
          }
          if (cCls.includes("salary") || cCls.includes("job-salary")) {
            if (!salary) salary = textOf(curr).trim();
          }
          if (cCls.includes("company-location") || cCls.includes("job-area") || cCls.includes("job-area-wrapper")) {
            if (!location) location = textOf(curr).trim();
          }
          if (cCls.includes("job-pub-time") || cCls.includes("pub-time")) {
            publication = textOf(curr).trim();
          }
          queue.push(...(children.get(curr) || []));
        }
        if (title && company && (location || salary || href)) {
          const cardText = textOf(i);
          cards.push({
            platform: "BOSS直聘",
            url: href || `${pageUrl}#${cards.length}`,
            title,
            company,
            ...(location ? { locationText: location } : {}),
            ...(salary ? { salaryText: salary } : {}),
            ...(publication ? { publicationText: publication } : {}),
            cardText: cardText.slice(0, 10_000) || `${title} ${company} ${salary} ${location}`,
            evidence: {
              pageUrl,
              cardSelector: ".job-card-box",
              fields: [
                { field: "url", selector: "a", text: href },
                { field: "title", selector: ".job-name", text: title },
                { field: "company", selector: ".boss-name", text: company },
                ...(location ? [{ field: "locationText" as const, selector: ".company-location", text: location }] : []),
                ...(salary ? [{ field: "salaryText" as const, selector: ".job-salary", text: salary }] : []),
              ],
            },
          });
        }
      }
    }
  }

  return cards;
}

export async function extractCardsViaEvaluate(
  cdp: NativeCdp,
  sessionId: string,
  platform: JobPlatform,
  pageUrl: string,
): Promise<JobSearchCard[]> {
  try {
    const res = await cdp.send<{ result?: { value?: any } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const platform = "${platform}";
          const cards = [];

          if (platform === "51JOB") {
            const items = document.querySelectorAll(".joblist-item, .post-item, .job-item");
            for (const el of items) {
              let title = "", company = "", salary = "", location = "", href = "", publication = "";
              try {
                const sEl = el.hasAttribute("sensorsdata") ? el : el.querySelector("[sensorsdata]");
                const d = JSON.parse(sEl?.getAttribute("sensorsdata") || "null");
                if (d) {
                  title = d.jobTitle || "";
                  salary = d.jobSalary || "";
                  location = d.jobArea || "";
                  publication = d.jobTime || "";
                  if (d.jobId) href = "https://jobs.51job.com/all/" + d.jobId + ".html";
                }
              } catch {}
              if (!title) title = el.querySelector(".jname, .job-name, .jobTitle, .title")?.textContent?.trim() || "";
              if (!company) company = el.querySelector(".cname, .company-name, .companyTitle, .com-name")?.textContent?.trim() || "";
              if (!salary) salary = el.querySelector(".sal, .salary, .job-salary")?.textContent?.trim() || "";
              if (!location) location = el.querySelector(".dregion, .area, .location, .job-area")?.textContent?.trim() || "";
              if (!href) {
                const a = el.querySelector("a[href*='jobs.51job.com']") || el.querySelector("a[href*='/job/']") || el.querySelector("a");
                href = a?.getAttribute("href") || a?.href || "";
              }
              if (title && company && (location || salary || href)) {
                cards.push({
                  platform: "51JOB",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company,
                  salaryText: salary || undefined,
                  locationText: location || undefined,
                  publicationText: publication || undefined,
                  cardText: el.innerText?.slice(0, 300) || (title + " " + company + " " + salary + " " + location),
                  evidence: {
                    pageUrl: "${pageUrl}",
                    cardSelector: ".joblist-item",
                    fields: [
                      { field: "url", selector: "a", text: href },
                      { field: "title", selector: ".jname", text: title },
                      { field: "company", selector: ".cname", text: company },
                      ...(location ? [{ field: "locationText", selector: ".dregion", text: location }] : []),
                      ...(salary ? [{ field: "salaryText", selector: ".sal", text: salary }] : [])
                    ]
                  }
                });
              }
            }
          } else if (platform === "BOSS直聘") {
            const items = document.querySelectorAll(".job-card-wrap, .job-card-box, .rec-job-list > li");
            const seenDedup = new Set();
            for (const el of items) {
              const a = el.querySelector("a.job-name, a[href*='/job_detail/']") || el.querySelector("a");
              const title = el.querySelector(".job-name, .title")?.textContent?.trim() || a?.textContent?.trim() || "";
              const company = el.querySelector(".boss-name, .company-name, .company-text .name, .company-info .name")?.textContent?.trim() || "";
              const salary = el.querySelector(".job-salary, .salary")?.textContent?.trim() || "";
              const location = el.querySelector(".company-location, .job-area")?.textContent?.trim() || "";
              let href = a?.getAttribute("href") || a?.href || "";
              if (href && !href.startsWith("http")) href = "https://www.zhipin.com" + href.split("?")[0];
              const dedupKey = href || (title + "__" + company);
              if (seenDedup.has(dedupKey)) continue;
              seenDedup.add(dedupKey);
              if (title && company && (location || salary || href)) {
                cards.push({
                  platform: "BOSS直聘",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company,
                  salaryText: salary || undefined,
                  locationText: location || undefined,
                  cardText: el.innerText?.slice(0, 300) || (title + " " + company + " " + salary + " " + location),
                  evidence: {
                    pageUrl: "${pageUrl}",
                    cardSelector: ".job-card-box",
                    fields: [
                      { field: "url", selector: "a", text: href },
                      { field: "title", selector: ".job-name", text: title },
                      { field: "company", selector: ".boss-name", text: company },
                      ...(location ? [{ field: "locationText", selector: ".company-location", text: location }] : []),
                      ...(salary ? [{ field: "salaryText", selector: ".job-salary", text: salary }] : [])
                    ]
                  }
                });
              }
            }
          } else if (platform === "猎聘") {
            const items = document.querySelectorAll(".jobCardPcContainer, .job-card-pc-container");
            for (const el of items) {
              const a = el.querySelector("a[href*='/job/'], a[href*='/a/']") || el.querySelector("a");
              const title = el.querySelector("[class*='jobTitleBox'], [class*='title-box'], [class*='job-title']")?.textContent?.replace(/^招聘\\s*/, "")?.trim() || a?.textContent?.trim() || "";
              const company = el.querySelector("[class*='companyName'], [class*='company-name']")?.textContent?.trim() || "";
              const salary = el.querySelector("[class*='salary']")?.textContent?.trim() || "";
              const location = el.querySelector("[class*='labels-box'], [class*='job-labels-box'], [class*='area'], [class*='city']")?.textContent?.trim() || "";
              let href = a?.getAttribute("href") || a?.href || "";
              if (href && !href.startsWith("http")) href = "https://www.liepin.com" + href.split("?")[0];
              if (title && company && (salary || href)) {
                cards.push({
                  platform: "猎聘",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company,
                  salaryText: salary || undefined,
                  locationText: location || undefined,
                  cardText: el.innerText?.slice(0, 300) || (title + " " + company + " " + salary + " " + location),
                  evidence: {
                    pageUrl: "${pageUrl}",
                    cardSelector: ".jobCardPcContainer",
                    fields: [
                      { field: "url", selector: "a", text: href },
                      { field: "title", selector: ".title-box", text: title },
                      { field: "company", selector: ".companyName", text: company },
                      ...(location ? [{ field: "locationText", selector: ".labels-box", text: location }] : []),
                      ...(salary ? [{ field: "salaryText", selector: ".salary", text: salary }] : [])
                    ]
                  }
                });
              }
            }
          }

          return cards;
        })()`,
        returnByValue: true,
      },
      sessionId,
      3500,
    );

    return (res.result?.value as JobSearchCard[]) || [];
  } catch {
    return [];
  }
}

async function waitForUnseenCardsAfterScroll(
  cdp: NativeCdp,
  sessionId: string,
  platform: JobPlatform,
  provider: PlatformSearchProvider,
  pageUrl: string,
  seenCardKeys: Set<string>,
  signal?: AbortSignal,
): Promise<JobSearchCard[]> {
  const accumulated = new Map<string, JobSearchCard>();
  let previousSignature: string | undefined;
  let stableReads = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) return [];
    const cards = await extractCardsViaEvaluate(cdp, sessionId, platform, pageUrl);
    const unseen = cards.filter((card) => {
      const identity = reviewedCardIdentity(card.url, provider);
      return identity !== undefined && !seenCardKeys.has(identity.id);
    });
    for (const card of unseen) {
      const identity = reviewedCardIdentity(card.url, provider);
      if (identity) accumulated.set(identity.id, card);
    }
    const signature = searchCardSignature(cards, provider);
    if (previousSignature !== undefined && signature === previousSignature) stableReads++;
    else {
      previousSignature = signature;
      stableReads = 0;
    }
    if (stableReads >= 2) break;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  // The caller's next capture performs the slower structural snapshot once,
  // so a virtual-list selector change is still covered without taking a full
  // page snapshot on every scroll poll.
  return [...accumulated.values()];
}

export type PlatformSearchAdvance = {
  advanced: boolean;
  kind: "page" | "scroll";
  exhausted: boolean;
};

export type LiveBatchAdvanceDecision =
  | { action: "continue-scroll"; stopReason?: undefined }
  | { action: "continue-page"; stopReason?: undefined }
  | { action: "navigate-page"; pageUrl: string; stopReason?: undefined }
  | { action: "stop"; stopReason: LiveBatchStopReason };

/** Pure pagination/virtual-list transition used by the CDP collector and regression tests. */
export function decideLiveBatchAdvance(options: {
  advance: PlatformSearchAdvance;
  provider: PlatformSearchProvider;
  currentPage: number;
  pageLimit: number;
  nextPageUrl?: string;
  currentPageUrl: string;
  cancelled?: boolean;
  cardLimitReached?: boolean;
}): LiveBatchAdvanceDecision {
  if (options.cancelled) return { action: "stop", stopReason: "cancelled" };
  if (options.cardLimitReached) return { action: "stop", stopReason: "card_limit" };
  if (options.provider !== "boss" && options.currentPage >= options.pageLimit) {
    return { action: "stop", stopReason: "page_limit" };
  }
  if (options.advance.advanced) {
    return options.advance.kind === "scroll"
      ? { action: "continue-scroll" }
      : { action: "continue-page" };
  }
  if (options.advance.exhausted) {
    return { action: "stop", stopReason: "exhausted" };
  }
  // BOSS is virtual/infinite-scroll in the supported search flow. Do not invent
  // a `page=2` route when the current scroll root is exhausted; only follow an
  // explicit page control that clickPlatformNextPage actually observed.
  if (options.provider === "boss") return { action: "stop", stopReason: "no_progress" };
  if (options.nextPageUrl && options.nextPageUrl !== options.currentPageUrl) {
    return { action: "navigate-page", pageUrl: options.nextPageUrl };
  }
  return {
    action: "stop",
    stopReason: options.advance.exhausted ? "exhausted" : "no_progress",
  };
}

export type LiveSearchPageState = { url: string; marker: string };

export type LiveSearchPageTransition =
  | { advanced: true; pageUrl: string; cards: JobSearchCard[] }
  | { advanced: false };

/**
 * A platform click can fire without updating a detectable page marker. When a
 * provider-specific next-page URL is known, retry that exact bounded URL and
 * verify its URL and cards before counting the page. BOSS virtual scroll has no
 * synthesized page URL and never uses this fallback.
 */
export async function confirmLiveSearchPageAdvance(options: {
  provider: PlatformSearchProvider;
  expectedPageUrl?: string;
  waitForTransition: (expectedPageUrl?: string, timeoutMs?: number) => Promise<LiveSearchPageTransition>;
  navigateTo: (pageUrl: string) => Promise<void>;
}): Promise<LiveSearchPageTransition> {
  const clicked = await options.waitForTransition(undefined, 2_500);
  if (clicked.advanced || !options.expectedPageUrl || options.provider === "boss") return clicked;
  await options.navigateTo(options.expectedPageUrl);
  return options.waitForTransition(options.expectedPageUrl, 6_000);
}

/** Classify a BOSS scroll boundary only after delayed list changes were checked. */
export function decideBossScrollBoundary(options: {
  addedCards: number;
  loading: boolean;
  noProgressAttempts: number;
  maxNoProgressAttempts?: number;
}): "continue" | "exhausted" | "no_progress" {
  if (options.addedCards > 0) return "continue";
  const maxAttempts = options.maxNoProgressAttempts ?? 3;
  if (options.noProgressAttempts + 1 < maxAttempts) return "continue";
  return options.loading ? "no_progress" : "exhausted";
}

export function hasSearchPageAdvanced(before: LiveSearchPageState, after: LiveSearchPageState): boolean {
  return before.url !== after.url || before.marker !== after.marker;
}

export function searchCardSignature(cards: JobSearchCard[], provider: PlatformSearchProvider): string {
  return cards.map((card) => {
    const identity = reviewedCardIdentity(card.url, provider);
    return `${identity?.id ?? card.url}|${card.title.trim()}|${(card.company ?? "").trim()}`;
  }).sort().join("\n");
}

function pageUrlEquals(actual: string, expected: string): boolean {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    const normalize = (url: URL) => JSON.stringify({
      origin: url.origin,
      pathname: url.pathname.replace(/\/$/, ""),
      params: [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)),
    });
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

/** Wait for both the pagination indicator and the card collection to update. */
export async function waitForLiveSearchPageTransition(options: {
  before: LiveSearchPageState;
  beforeCardsSignature: string;
  expectedPageUrl?: string;
  provider: PlatformSearchProvider;
  readState: () => Promise<LiveSearchPageState | undefined>;
  readCards: (pageUrl: string) => Promise<JobSearchCard[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<LiveSearchPageTransition> {
  const deadline = Date.now() + (options.timeoutMs ?? 6_000);
  const interval = options.intervalMs ?? 250;
  let previousSignature = "";
  while (Date.now() <= deadline) {
    if (options.signal?.aborted) return { advanced: false };
    const state = await options.readState().catch(() => undefined);
    if (state && (!options.expectedPageUrl || pageUrlEquals(state.url, options.expectedPageUrl))
      && hasSearchPageAdvanced(options.before, state)
      && reviewedCardsSearchPage(state.url, options.provider)) {
      const cards = await options.readCards(state.url).catch(() => []);
      const signature = searchCardSignature(cards, options.provider);
      // The page URL/active marker plus a changed, evidence-bearing card list
      // is sufficient. Requiring three identical reads adds ~500ms per page
      // without improving the source identity guarantee.
      if (signature && signature !== options.beforeCardsSignature && signature !== previousSignature) {
        return { advanced: true, pageUrl: state.url, cards };
      }
      previousSignature = signature;
    }
    if (Date.now() + interval > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { advanced: false };
}

function pauseLiveSearchReadiness(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function readLiveSearchPageState(
  cdp: NativeCdp,
  sessionId: string,
  provider: PlatformSearchProvider,
): Promise<LiveSearchPageState | undefined> {
  try {
    const expression = `(() => {
      const provider = ${JSON.stringify(provider)};
      const active = provider === '51job'
        ? document.querySelector('.el-pager li.active, .el-pager li[aria-current="page"], [aria-current="page"]')
        : provider === 'liepin'
          ? document.querySelector('.ant-pagination-item-active, [aria-current="page"]')
          : document.querySelector('[aria-current="page"], .pagination-active, .page-item.active');
      return {url: location.href, marker: (active?.textContent || active?.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim()};
    })()`;
    const response = await cdp.send<{ result?: { value?: LiveSearchPageState } }>(
      "Runtime.evaluate", { expression, returnByValue: true }, sessionId, 2000,
    );
    return response.result?.value;
  } catch {
    return undefined;
  }
}

export async function clickPlatformNextPage(
  cdp: NativeCdp,
  sessionId: string,
  platform: JobPlatform,
): Promise<PlatformSearchAdvance> {
  try {
    const res = await cdp.send<{ result?: { value?: PlatformSearchAdvance } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const platform = "${platform}";
          if (platform === "51JOB") {
            const btn = document.querySelector(".btn-next:not(.disabled):not([disabled]), .el-pagination .btn-next:not(.disabled):not([disabled])");
            if (btn && !btn.disabled) {
              btn.click();
              return {advanced:true,kind:'page',exhausted:false};
            }
            const activePage = document.querySelector(".el-pager li.active");
            if (activePage && activePage.nextElementSibling && !activePage.nextElementSibling.classList.contains("disabled")) {
              activePage.nextElementSibling.click();
              return {advanced:true,kind:'page',exhausted:false};
            }
            if (document.querySelector(".btn-next.disabled, .el-pagination .btn-next.disabled, .btn-next[disabled], .el-pagination .btn-next[disabled]")) return {advanced:false,kind:'page',exhausted:true};
          } else if (platform === "猎聘") {
            const btn = document.querySelector(".ant-pagination-next:not(.ant-pagination-disabled) button, .ant-pagination-next:not(.ant-pagination-disabled) a, .ant-pagination-next:not(.ant-pagination-disabled), a[title='下一页']");
            if (btn) {
              btn.click();
              return {advanced:true,kind:'page',exhausted:false};
            }
            const activeItem = document.querySelector(".ant-pagination-item-active");
            if (activeItem && activeItem.nextElementSibling && activeItem.nextElementSibling.classList.contains("ant-pagination-item")) {
              activeItem.nextElementSibling.click();
              return {advanced:true,kind:'page',exhausted:false};
            }
            if (document.querySelector(".ant-pagination-next.ant-pagination-disabled")) return {advanced:false,kind:'page',exhausted:true};
          } else if (platform === "BOSS直聘") {
            const next = document.querySelector(".pagination-next:not(.disabled):not([disabled]), .btn-next:not(.disabled):not([disabled]), a[aria-label='下一页']");
            if (next && !next.disabled) {
              next.click();
              return {advanced:true,kind:'page',exhausted:false};
            }
            const card = document.querySelector('.job-card-wrapper,.job-card-wrap,.job-card-box,.job-list-box > li,.job-primary,.rec-job-list > li');
            const scrollable = [];
            for (let node = card; node && node !== document.body; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (node.scrollHeight > node.clientHeight + 24 && /auto|scroll|overlay/.test(style.overflowY)) scrollable.push(node);
            }
            const root = scrollable[0] || document.scrollingElement || document.documentElement;
            const isWindow = root === document.scrollingElement || root === document.documentElement || root === document.body;
            const top = isWindow ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
            const height = isWindow ? Math.max(root.scrollHeight, document.body.scrollHeight) : root.scrollHeight;
            const viewport = isWindow ? window.innerHeight : root.clientHeight;
            const max = Math.max(0, height - viewport);
            if (max - top <= 4) return {advanced:false,kind:'scroll',exhausted:true};
            const nextTop = Math.min(max, top + Math.max(320, Math.floor(viewport * 0.72)));
            if (isWindow) window.scrollTo({top:nextTop,behavior:'instant'});
            else root.scrollTop = nextTop;
            (isWindow ? window : root).dispatchEvent(new Event('scroll'));
            const actualTop = isWindow ? (window.scrollY || root.scrollTop || 0) : root.scrollTop;
            return {advanced:actualTop>top,kind:'scroll',exhausted:false};
          }
          return {advanced:false,kind:platform==='BOSS直聘'?'scroll':'page',exhausted:false};
        })()`,
        returnByValue: true,
      },
      sessionId,
      2500,
    );
    return res.result?.value ?? { advanced: false, kind: platform === "BOSS直聘" ? "scroll" : "page", exhausted: false };
  } catch {
    return { advanced: false, kind: platform === "BOSS直聘" ? "scroll" : "page", exhausted: false };
  }
}

async function isBOSSListLoading(cdp: NativeCdp, sessionId: string): Promise<boolean> {
  try {
    const response = await cdp.send<{ result?: { value?: boolean } }>(
      "Runtime.evaluate",
      {
        expression: `(() => [...document.querySelectorAll('[aria-busy="true"], [class*="loading"], [class*="Loading"], [class*="load-more"], [class*="loadMore"]')].some((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
          const signal = (el.getAttribute('aria-busy') === 'true') || /loading|load.?more|加载中|正在加载|加载更多/i.test((typeof el.className === 'string' ? el.className : '') + ' ' + (el.textContent || ''));
          return visible && signal;
        }))()`,
        returnByValue: true,
      },
      sessionId,
      2_000,
    );
    return response.result?.value === true;
  } catch {
    return false;
  }
}

function safePlatformUrl(base: string, params: Record<string, string>): string {
  try {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(k, v);
    }
    return u.toString().replace(/\+/g, "%20");
  } catch {
    return base;
  }
}

export function getDomainSynonymKeywords(keyword: string): string[] {
  const kw = keyword.trim().toLowerCase();
  const synonyms: string[] = [];

  // C# / .NET / Industrial Automation / Upper Machine
  if (kw === "c#" || kw === "csharp" || kw === ".net" || kw === "dotnet" || kw.includes("上位机") || kw === "wpf" || kw === "winform") {
    synonyms.push("C#", ".NET", "C#开发", "上位机", "上位机 C#", "WPF", "Winform", "WinForms", "工控上位机", ".NET Core", "ASP.NET Core", "C#软件工程师", "上位机软件工程师", "上位机开发");
  }
  // C / C++ Systems & Embedded Stack
  else if (kw === "c++" || kw === "cpp" || kw === "c/c++") {
    synonyms.push("Qt C++", "C++后台", "嵌入式软件", "底层开发", "Linux C++");
  }
  // Java Enterprise Stack
  else if (kw === "java" || kw === "spring") {
    synonyms.push("Spring Boot", "Java后端", "Java架构", "微服务");
  }
  // Python & AI / Data Stack
  else if (kw === "python" || kw === "django" || kw === "fastapi") {
    synonyms.push("Python后端", "FastAPI", "数据开发", "AI工程");
  }
  // Go / Cloud Native Stack
  else if (kw === "go" || kw === "golang") {
    synonyms.push("Golang", "Go后端", "云原生", "K8s");
  }
  // Frontend & Web
  else if (kw === "frontend" || kw === "前端" || kw === "react" || kw === "vue") {
    synonyms.push("前端开发", "React", "Vue3", "TypeScript");
  }
  // Rust
  else if (kw === "rust") {
    synonyms.push("Rust开发", "高性能系统");
  }

  return synonyms.filter((s) => s.toLowerCase() !== kw);
}

export function getPlatformExpandedUrls(
  provider: PlatformSearchProvider,
  baseUrl: string,
  _keyword: string,
  maxPages: number = 3,
): string[] {
  const pageLimit = Math.max(1, Math.min(50, Math.trunc(maxPages)));
  const urls: string[] = [baseUrl];

  if (provider === "liepin") {
    for (let p = 1; p < pageLimit; p++) {
      urls.push(safePlatformUrl(baseUrl, { currentPage: String(p) }));
    }
  } else if (provider === "51job") {
    for (let p = 2; p <= pageLimit; p++) {
      urls.push(safePlatformUrl(baseUrl, { pageNum: String(p) }));
    }
  }

  return urls;
}

export function expandLinkedInQueryUrls(baseUrl: string, maxPages: number): string[] {
  const pageLimit = Math.max(1, Math.min(50, Math.trunc(maxPages)));
  return Array.from({ length: pageLimit }, (_, page) =>
    page === 0 ? baseUrl : safePlatformUrl(baseUrl, { start: String(page * 25) }));
}

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
  const fetchPages = async (fetcher: (url: string) => Promise<Response>) => {
    const output: Array<PromiseSettledResult<ReturnType<typeof extractJobSearchCards>>> = Array(pageUrls.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, pageUrls.length) }, async () => {
      while (cursor < pageUrls.length && !signal?.aborted) {
        const index = cursor++;
        try {
          const response = await fetcher(pageUrls[index]!);
          if (!response.ok) throw new Error(`LinkedIn page returned HTTP ${response.status}.`);
          const value = extractJobSearchCards(
            { url: pageUrls[index]!, title: "LinkedIn Search", html: await response.text() },
            "LinkedIn",
          );
          pagesVisited++;
          output[index] = { status: "fulfilled", value };
          // Parse and publish at page completion, not after every response has
          // arrived. The indexed result still gives the final receipt stable
          // page ordering when concurrent requests finish out of order.
          if (value.status === "ready") cardsCaptured += value.cards.length;
          await reportProgress(value.status === "ready" ? value.cards : []);
        }
        catch (reason) { await reportProgress(); output[index] = { status: "rejected", reason }; }
      }
    });
    await Promise.all(workers);
    return output;
  };

  let finalPagesVisited = 0;
  let finalFailedPages = 0;
  const warnings: string[] = [];
  for (const fetcherFactory of fetchers ?? [
    async (u: string) => (await getNetworkFetch())(u, { headers, signal: makeSignal() }),
    (u: string) => fetch(u, { headers, signal: makeSignal() }),
  ]) {
    pagesVisited = 0;
    cardsCaptured = 0;
    let failedPages = 0;
    try {
      const responses = await fetchPages(fetcherFactory);
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
          : failedPages > 0
          ? "error"
          : allRawCards.length >= cardLimit
            ? "card_limit"
            : pagesVisited >= pageLimit
              ? "page_limit"
              : "exhausted";
        return {
          provider: "linkedin",
          platform: "LinkedIn",
          pageUrl: primaryUrl,
          status: cards.length > 0 ? "ready" : "unknown_layout",
          cards,
          rawCardCount: allRawCards.length,
          warnings: cards.length > 0 ? warnings : [...warnings, "平台返回岗位候选，但没有卡片通过来源身份与字段证据校验；不将其判为零岗位。"],
          coverage: createLiveBatchCoverage({ pagesVisited, pageLimit, cardLimit, stopReason }),
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
    if (signal?.aborted) break;
  }
  const stopReason: LiveBatchStopReason = signal?.aborted ? "cancelled" : finalPagesVisited === 0 || finalFailedPages > 0 ? "error" : "no_progress";
  return {
    provider: "linkedin", platform: "LinkedIn", pageUrl: plan.url,
    status: "error", cards: [], rawCardCount: 0,
    warnings: ["未能从 LinkedIn 实时读取到可验证的搜索列表响应；不将连接失败当作零岗位。"],
    coverage: createLiveBatchCoverage({ pagesVisited: finalPagesVisited, pageLimit, cardLimit, stopReason }),
    error: "LinkedIn 搜索列表当前不可读取。",
  };
}

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
): Promise<LiveBatchProviderResult> {
  let targetId: string | undefined;
  let ownsTarget = false;
  let preserveTargetForInteractiveLogin = false;
  let sessionId: string | undefined;

  try {
    // Never attach to an arbitrary platform tab. Even a matching query can be
    // scrolled by the virtual-list reader; stale queries would also be navigated.
    const created = await cdp.send<{ targetId?: string }>(
      "Target.createTarget",
      { url: plan.url, background: true },
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
    let pageScrolled = false;
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

    // Read the owned page through CDP without selecting the user's visible tab.
    const curTargets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000).catch(() => ({ targetInfos: [] }));
    const thisTarget = curTargets.targetInfos?.find((t) => t.targetId === targetId);
    const currentTabUrl = thisTarget?.url || "";

    const needsInitialNav =
      !currentTabUrl ||
      currentTabUrl === "about:blank" ||
      !PLATFORM_HOST_MATCH[plan.provider](new URL(currentTabUrl.startsWith("http") ? currentTabUrl : "http://localhost").hostname) ||
      !samePlatformSearchQuery(currentTabUrl, plan.url) ||
      !isFirstPlatformPage(currentTabUrl, plan.provider);

    let pageReadinessDeadline = Date.now() + 8_000;
    if (needsInitialNav) {
      await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
      await cdp.send("Page.navigate", { url: plan.url }, sessionId, 8000);
      pageReadinessDeadline = Date.now() + 8_000;
      lastPageUrl = plan.url;
    } else {
      lastPageUrl = currentTabUrl;
    }

    let page = 1;
    let pageHasCards = false;
    while (page <= pageLimit) {
      if (signal?.aborted) { stopReason = "cancelled"; break; }
      if (allRawCards.length >= maxCardCap) { stopReason = "card_limit"; break; }
      if (lastVisitedPage !== page) {
        if (lastVisitedPage > 0) pageReadinessDeadline = Date.now() + 8_000;
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
            { id: targetId, url: lastPageUrl },
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
          if (captureStatus === "empty") { lastStatus = "empty"; stopReason = "exhausted"; break; }
          if (captureStatus !== "unknown_layout") { lastStatus = captureStatus; stopReason = "error"; break; }
          // A loading SPA shell is not an empty result page. Keep reading this
          // page within one absolute grace period before any pagination input.
          if (Date.now() < pageReadinessDeadline) {
            await pauseLiveSearchReadiness(Math.min(250, pageReadinessDeadline - Date.now()), signal);
            continue;
          }
          lastStatus = "unknown_layout";
          stopReason = "no_progress";
          allWarnings.push("搜索页面在 8 秒内仍未出现可核对的岗位卡片或明确空结果；未跳过当前页或将其计为零岗位，已停止本平台采集。");
          break;
        }
        if (allRawCards.length > 0) {
          lastStatus = "ready";
        }
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
          const waitForTransition = (expectedPageUrl?: string, timeoutMs?: number) => pageStateBeforeAdvance
            ? waitForLiveSearchPageTransition({
                before: pageStateBeforeAdvance,
                beforeCardsSignature: cardsSignatureBeforeAdvance,
                ...(expectedPageUrl ? { expectedPageUrl } : {}),
                provider: plan.provider,
                readState: () => readLiveSearchPageState(cdp, sessionId!, plan.provider),
                readCards: (url) => extractCardsViaEvaluate(cdp, sessionId!, plan.platform, url),
                signal,
                ...(timeoutMs ? { timeoutMs } : {}),
              })
            : Promise.resolve({ advanced: false as const });
          const transition = await confirmLiveSearchPageAdvance({
            provider: plan.provider,
            ...(nextUrl ? { expectedPageUrl: nextUrl } : {}),
            waitForTransition,
            navigateTo: async (pageUrl) => {
              await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
              await cdp.send("Page.navigate", { url: pageUrl }, sessionId, 7000);
            },
          });
          if (!transition.advanced) {
            stopReason = signal?.aborted ? "cancelled" : "no_progress";
            allWarnings.push("平台翻页控件已触发，但未能确认下一页 URL、页码与岗位卡片列表均已更新；已尝试打开受限的下一页 URL，仍无法核实，因此停止本平台采集。");
            break;
          }
          lastPageUrl = transition.pageUrl;
          page++;
          pageScrolled = false;
          continue;
        }
        if (decision.action === "navigate-page") {
          await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
          await cdp.send("Page.navigate", { url: decision.pageUrl }, sessionId, 7000);
          const transition = pageStateBeforeAdvance
            ? await waitForLiveSearchPageTransition({
                before: pageStateBeforeAdvance,
                beforeCardsSignature: cardsSignatureBeforeAdvance,
                expectedPageUrl: decision.pageUrl,
                provider: plan.provider,
                readState: () => readLiveSearchPageState(cdp, sessionId!, plan.provider),
                readCards: (url) => extractCardsViaEvaluate(cdp, sessionId!, plan.platform, url),
                signal,
              })
            : { advanced: false as const };
          if (!transition.advanced) {
            stopReason = signal?.aborted ? "cancelled" : "no_progress";
            allWarnings.push("目标分页 URL 已打开，但未能确认新页面及其岗位卡片更新；为避免将旧页数据归到新页，已停止本平台采集。");
            break;
          }
          lastPageUrl = transition.pageUrl;
          page++;
          pageScrolled = false;
          continue;
        }
      } catch (error) {
        stopReason = "error";
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

    if (cards.length > 0) {
      return {
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "ready",
        cards,
        rawCardCount: allRawCards.length,
        warnings: allWarnings,
        coverage: createLiveBatchCoverage({ pagesVisited, scrollSteps, scrollLimit: maxScrollSteps, pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: maxCardCap, stopReason }),
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
      coverage: createLiveBatchCoverage({ pagesVisited, scrollSteps, scrollLimit: maxScrollSteps, pageLimit: liveBatchProviderPageBudget(plan.provider, depth, maxPages), cardLimit: maxCardCap, stopReason }),
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
    if (sessionId) {
      await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 1500).catch(() => {});
    }
    if (ownsTarget && targetId && !preserveTargetForInteractiveLogin) {
      await cdp.send("Target.closeTarget", { targetId }, undefined, 1500).catch(() => {});
    }
  }
}

function samePlatformSearchQuery(current: string, expected: string): boolean {
  try {
    const actual = new URL(current);
    const wanted = new URL(expected);
    if (actual.origin !== wanted.origin || actual.pathname.replace(/\/$/, "") !== wanted.pathname.replace(/\/$/, "")) return false;
    const ignoredPagination = new Set(["page", "pageNum", "currentPage", "start", "offset"]);
    const entries = (url: URL) => [...url.searchParams.entries()]
      .filter(([key]) => !ignoredPagination.has(key))
      .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    return JSON.stringify(entries(actual)) === JSON.stringify(entries(wanted));
  } catch {
    return false;
  }
}

export async function runLiveBatchSearch(
  rawInput: unknown,
  signal?: AbortSignal,
  callbacks: LiveBatchSearchCallbacks = {},
): Promise<LiveBatchSearchResult> {
  const input = LiveBatchSearchInputSchema.parse(rawInput);
  const resolvedRegion = input.regionId ? resolvePlatformSearchRegion(input.regionId) : undefined;
  const providers: PlatformSearchProvider[] = input.providers ?? ["liepin", "51job", "boss", "linkedin"];
  const plans = providers.map((provider) =>
    buildPlatformSearchRequest({
      provider,
      keyword: input.keyword,
      districtCode: input.districtCode,
      ...(resolvedRegion && resolvedRegion.platforms[provider] !== undefined
        ? { regionId: resolvedRegion.id }
        : {}),
    }),
  );

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
      await launchRealChromeCdp(9222, browserPlans[0]!.url);
    }
    let cdp: NativeCdp | undefined;
    try {
      cdp = await connectNativeCdp(9222);
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
      cdp?.close();
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
  };
}
