import {
  PlatformSearchProviderSchema,
  resolvePlatformSearchRegion,
  ReviewedSearchCardSchema,
  reviewedCardIdentity,
  reviewedCardsSearchPage,
  type PlatformSearchProvider,
  type ReviewedSearchCard,
} from "@better-me/source-adapters";
import { z } from "zod";
import type { NativeCdp } from "./jd-native-cdp";
import type { JobSearchCard } from "./jd-search-capture";
import type { JobPlatform } from "../src/lib/jd-source";
import { type HarvestDiagnostic } from "./jd-harvest-diagnostics";

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
  collectionSessionId: z.string().uuid().optional(),
  visualFallback: z.boolean().optional(),
}).refine(input => !input.visualFallback || Boolean(input.collectionSessionId), {
  path: ["collectionSessionId"], message: "视觉兜底需要本轮后台采集会话，不能独立操作其他页面。",
});
export type LiveBatchSearchInput = z.infer<typeof LiveBatchSearchInputSchema>;

/** A bounded initialization grace, never a retry or a way around a platform gate. */
export function isHarvestBootstrapRequest(provider: PlatformSearchProvider, type: string, value: unknown): boolean {
  if (!["Document", "Script", "XHR", "Fetch"].includes(type) || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (provider === "51job") return ["we.51job.com", "oauth.51job.com", "cupid.51job.com", "vapi.51job.com", "fccdn.51jobcdn.com", "fecdn.51jobcdn.com"].includes(url.hostname);
    if (provider === "boss") return ["www.zhipin.com", "static.zhipin.com", "img.bosszhipin.com"].includes(url.hostname);
    return false;
  } catch { return false; }
}

export type LiveBatchStopReason = "exhausted" | "page_limit" | "scroll_limit" | "card_limit" | "no_progress" | "gate" | "error" | "cancelled";
export type LiveBatchCoverage = {
  pagesVisited: number;
  scrollSteps: number;
  scrollLimit: number;
  pageLimit: number;
  cardLimit: number;
  stopReason: LiveBatchStopReason;
  partial: boolean;
  failureKind?: HarvestDiagnostic["observations"][number]["failure"];
};

export function createLiveBatchCoverage(options: {
  pagesVisited?: number;
  scrollSteps?: number;
  scrollLimit?: number;
  pageLimit: number;
  cardLimit: number;
  stopReason: LiveBatchStopReason;
  failureKind?: LiveBatchCoverage["failureKind"];
}): LiveBatchCoverage {
  return {
    pagesVisited: options.pagesVisited ?? 0,
    scrollSteps: options.scrollSteps ?? 0,
    scrollLimit: options.scrollLimit ?? 0,
    pageLimit: options.pageLimit,
    cardLimit: options.cardLimit,
    stopReason: options.stopReason,
    partial: options.stopReason !== "exhausted",
    ...(options.failureKind ? { failureKind: options.failureKind } : {}),
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

export async function safelyReport(callback: (() => void | Promise<void>) | undefined) {
  if (!callback) return;
  try { await callback(); } catch { /* Progress listeners must not change collection outcomes. */ }
}

export type LiveBatchSearchResult = {
  collectionSessionId?: string;
  capturedAt: string;
  results: LiveBatchProviderResult[];
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

export function extractCardsFromRawDomSnapshot(
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

export async function waitForUnseenCardsAfterScroll(
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
  isLoading?: () => Promise<boolean>;
}): Promise<LiveSearchPageTransition> {
  let deadline = Date.now() + (options.timeoutMs ?? 6_000);
  const loadingDeadline = Date.now() + 20_000;
  let extended = false;
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
    if (Date.now() + interval > deadline) {
      if (!extended && options.isLoading && await options.isLoading().catch(() => false)) {
        deadline = Math.max(deadline, loadingDeadline);
        extended = true;
      } else break;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { advanced: false };
}

export function pauseLiveSearchReadiness(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function readLiveSearchPageState(
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

export async function isBOSSListLoading(cdp: NativeCdp, sessionId: string): Promise<boolean> {
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

export function safePlatformUrl(base: string, params: Record<string, string>): string {
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
