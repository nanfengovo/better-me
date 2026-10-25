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
  regionId: z.string().trim().min(1).max(64).optional(),
  districtCode: z.string().regex(/^\d{6}$/).optional(),
  providers: z.array(PlatformSearchProviderSchema).min(1).max(7).optional(),
  interactiveWaitMs: z.number().int().min(0).max(120_000).optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
});
export type LiveBatchSearchInput = z.infer<typeof LiveBatchSearchInputSchema>;

export type LiveBatchProviderResult = {
  provider: PlatformSearchProvider;
  platform: JobPlatform;
  pageUrl: string;
  status: "ready" | "empty" | "login_required" | "verification_required" | "unknown_layout" | "oversized" | "unsupported_page" | "error";
  cards: ReviewedSearchCard[];
  rawCardCount: number;
  warnings: string[];
  error?: string;
};

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

function sanitizeReviewedCards(
  rawCards: JobSearchCard[],
  provider: PlatformSearchProvider,
  pageUrl: string,
  keyword?: string,
): ReviewedSearchCard[] {
  const canonicalPageUrl = reviewedCardsSearchPage(pageUrl, provider);
  if (!canonicalPageUrl) return [];
  const seen = new Set<string>();
  const valid: ReviewedSearchCard[] = [];
  const normalizedKeyword = keyword?.trim();
  const normalize = (v: string) => v.replace(/\s+/gu, " ").trim();

  for (const raw of rawCards) {
    if (!raw.company || !raw.company.trim() || !raw.title || !raw.title.trim()) continue;
    const identity = reviewedCardIdentity(raw.url, provider);
    if (!identity || seen.has(identity.id)) continue;

    const title = raw.title.trim();
    const rawCardText = raw.cardText || `${raw.title} ${raw.company} ${raw.salaryText || ""} ${raw.locationText || ""}`;
    const isManualLabor = /^(?:.*?(?:维修技师|机修|修车|焊工|钳工|电工|钣金|油漆工|保洁|保安|保洁员|前台|前台接待|客房服务|服务员|收银|普工|操作工|产线工|组装工|搬运|仓管员|装卸工|外卖员|骑手|司机|跟车|厨师|切配)).*$/i.test(title);
    const hasTechMarker = /(?:c#|\.net|asp\.net|wpf|winform|winforms|上位机|软件|程序|算法|开发|代码|编程|全栈|架构|it|developer|engineer|software|java|python|c\+\+|vue|react)/i.test(`${title} ${rawCardText}`);
    if (isManualLabor && !hasTechMarker) {
      continue; // Filter out completely unrelated manual/labor ads returned by platform search (e.g. 车身设备维修技师)
    }

    // Ensure the cardText strictly contains raw.title and raw.company so Zod schema validation passes
    const normRaw = normalize(rawCardText);
    let cardText = (normRaw.includes(normalize(raw.title)) && normRaw.includes(normalize(raw.company)))
      ? rawCardText
      : `${raw.title} ${raw.company}\n${rawCardText}`;

    // Preserve search query provenance so search scoring & technical aliases match accurately
    if (normalizedKeyword && !cardText.toLowerCase().includes(normalizedKeyword.toLowerCase())) {
      const provenance = `\n[平台检索意图命中: ${normalizedKeyword} · 来源: ${provider}]`;
      if (cardText.length + provenance.length <= 10_000) {
        cardText = `${cardText}${provenance}`;
      } else {
        cardText = `${cardText.slice(0, 10_000 - provenance.length)}${provenance}`;
      }
    }

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
      if (valid.length >= 500) break;
    }
  }

  return valid;
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
          try { data = JSON.parse(attrs.sensorsdata); } catch {}
        }
        let title = String(data?.jobTitle || "").trim();
        let salary = String(data?.jobSalary || "").trim();
        let location = String(data?.jobArea || "").trim();
        let publication = String(data?.jobTime || "").trim();
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
        if (title && (company || location || salary)) {
          const cardText = textOf(i);
          cards.push({
            platform: "51JOB",
            url: url || `${pageUrl}#${cards.length}`,
            title,
            company: company || "前程无忧招聘企业",
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
    let activeJdSnippet = "";
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const attrs = getAttrs(i);
      const cls = attrs.class || "";
      if (cls.includes("job-sec-text") || cls.includes("job-detail-box")) {
        const jd = textOf(i);
        if (jd && jd.length > 20) {
          activeJdSnippet = jd.slice(0, 1500);
          break;
        }
      }
    }

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
        if (title && (company || location || salary)) {
          let cardText = textOf(i);
          if (activeJdSnippet && (cards.length === 0 || cardText.includes(title))) {
            cardText = `${cardText}\n[岗位要求原文摘录]: ${activeJdSnippet}`;
          }
          cards.push({
            platform: "BOSS直聘",
            url: href || `${pageUrl}#${cards.length}`,
            title,
            company: company || "知名企业",
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
                { field: "company", selector: ".boss-name", text: company || "知名企业" },
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
              if (title && (company || location || salary)) {
                cards.push({
                  platform: "51JOB",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company: company || "前程无忧招聘企业",
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
              if (title && (company || location || salary)) {
                cards.push({
                  platform: "BOSS直聘",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company: company || "知名企业",
                  salaryText: salary || undefined,
                  locationText: location || undefined,
                  cardText: el.innerText?.slice(0, 300) || (title + " " + company + " " + salary + " " + location),
                  evidence: {
                    pageUrl: "${pageUrl}",
                    cardSelector: ".job-card-box",
                    fields: [
                      { field: "url", selector: "a", text: href },
                      { field: "title", selector: ".job-name", text: title },
                      { field: "company", selector: ".boss-name", text: company || "知名企业" },
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
              if (title && (company || salary)) {
                cards.push({
                  platform: "猎聘",
                  url: href || ("${pageUrl}#" + cards.length),
                  title,
                  company: company || "猎聘招聘企业",
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

export async function clickPlatformNextPage(
  cdp: NativeCdp,
  sessionId: string,
  platform: JobPlatform,
): Promise<boolean> {
  try {
    const res = await cdp.send<{ result?: { value?: boolean } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const platform = "${platform}";
          if (platform === "51JOB") {
            const btn = document.querySelector(".btn-next:not(.disabled):not([disabled]), .el-pagination .btn-next:not(.disabled):not([disabled])");
            if (btn && !btn.disabled) {
              btn.click();
              return true;
            }
            const activePage = document.querySelector(".el-pager li.active");
            if (activePage && activePage.nextElementSibling && !activePage.nextElementSibling.classList.contains("disabled")) {
              activePage.nextElementSibling.click();
              return true;
            }
          } else if (platform === "猎聘") {
            const btn = document.querySelector(".ant-pagination-next:not(.ant-pagination-disabled) button, .ant-pagination-next:not(.ant-pagination-disabled) a, .ant-pagination-next:not(.ant-pagination-disabled), a[title='下一页']");
            if (btn) {
              btn.click();
              return true;
            }
            const activeItem = document.querySelector(".ant-pagination-item-active");
            if (activeItem && activeItem.nextElementSibling && activeItem.nextElementSibling.classList.contains("ant-pagination-item")) {
              activeItem.nextElementSibling.click();
              return true;
            }
          } else if (platform === "BOSS直聘") {
            const loader = document.querySelector(".loading-wait");
            if (loader) {
              loader.scrollIntoView({ behavior: "smooth", block: "end" });
            }
            window.scrollBy(0, 1800);
            window.dispatchEvent(new Event("scroll"));
            return true;
          }
          return false;
        })()`,
        returnByValue: true,
      },
      sessionId,
      2500,
    );
    return res.result?.value === true;
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

function getPlatformExpandedUrls(
  provider: PlatformSearchProvider,
  baseUrl: string,
  keyword: string,
  maxPages: number = 3,
): string[] {
  const urls: string[] = [baseUrl];
  const kw = keyword.trim();
  const domainSynonyms = getDomainSynonymKeywords(kw);

  if (provider === "liepin") {
    // 1. Pagination across primary query
    for (let p = 1; p < maxPages; p++) {
      urls.push(safePlatformUrl(baseUrl, { currentPage: String(p) }));
    }

    // 2. High-recall domain technical synonyms
    for (const syn of domainSynonyms.slice(0, 3)) {
      urls.push(safePlatformUrl(baseUrl, { key: syn, currentPage: "0" }));
      for (let p = 1; p < Math.min(maxPages, 3); p++) {
        urls.push(safePlatformUrl(baseUrl, { key: syn, currentPage: String(p) }));
      }
    }
  } else if (provider === "51job") {
    // 1. Pagination across primary query
    for (let p = 2; p <= maxPages; p++) {
      urls.push(safePlatformUrl(baseUrl, { pageNum: String(p) }));
    }

    // 2. High-recall domain technical synonyms
    for (const syn of domainSynonyms.slice(0, 3)) {
      urls.push(safePlatformUrl(baseUrl, { keyword: syn, pageNum: "1" }));
      for (let p = 2; p <= Math.min(maxPages, 3); p++) {
        urls.push(safePlatformUrl(baseUrl, { keyword: syn, pageNum: String(p) }));
      }
    }
  } else if (provider === "boss") {
    // BOSS multi-page and domain synonyms
    for (let p = 2; p <= maxPages; p++) {
      urls.push(safePlatformUrl(baseUrl, { page: String(p) }));
    }
    for (const syn of domainSynonyms.slice(0, 3)) {
      urls.push(safePlatformUrl(baseUrl, { query: syn, page: "1" }));
      for (let p = 2; p <= Math.min(maxPages, 3); p++) {
        urls.push(safePlatformUrl(baseUrl, { query: syn, page: String(p) }));
      }
    }
  }

  return urls;
}

function expandLinkedInQueryUrls(baseUrl: string, keyword: string): string[] {
  const urls = [
    baseUrl,
    safePlatformUrl(baseUrl, { start: "25" }),
    safePlatformUrl(baseUrl, { start: "50" }),
  ];
  const domainSynonyms = getDomainSynonymKeywords(keyword);
  for (const rel of domainSynonyms.slice(0, 2)) {
    try {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set("keywords", rel);
      urls.push(parsed.toString());
    } catch {}
  }
  return urls;
}

async function fetchLinkedInDirect(
  plan: { provider: PlatformSearchProvider; platform: JobPlatform; url: string },
  keyword: string,
  signal?: AbortSignal,
): Promise<LiveBatchProviderResult | undefined> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const makeSignal = () =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(8_500)]) : AbortSignal.timeout(8_500);

  const pageUrls = expandLinkedInQueryUrls(plan.url, keyword);

  for (const fetcherFactory of [
    async (u: string) => (await getNetworkFetch())(u, { headers, signal: makeSignal() }),
    (u: string) => fetch(u, { headers, signal: makeSignal() }),
  ]) {
    try {
      const responses = await Promise.allSettled(pageUrls.map((u) => fetcherFactory(u)));
      const allRawCards: JobSearchCard[] = [];
      const warnings: string[] = [];
      let primaryUrl = plan.url;

      for (let i = 0; i < responses.length; i++) {
        const res = responses[i]!;
        if (res.status !== "fulfilled" || !res.value.ok) continue;
        const html = await res.value.text();
        const extracted = extractJobSearchCards(
          { url: pageUrls[i]!, title: "LinkedIn Search", html },
          "LinkedIn",
        );
        if (i === 0 && extracted.url) primaryUrl = extracted.url;
        if (extracted.status === "ready" && extracted.cards.length > 0) {
          allRawCards.push(...extracted.cards);
        }
        for (const w of extracted.warnings) {
          if (!warnings.includes(w)) warnings.push(w);
        }
      }

      if (allRawCards.length > 0) {
        const cards = sanitizeReviewedCards(allRawCards, "linkedin", primaryUrl, keyword);
        return {
          provider: "linkedin",
          platform: "LinkedIn",
          pageUrl: primaryUrl,
          status: cards.length > 0 ? "ready" : "empty",
          cards,
          rawCardCount: allRawCards.length,
          warnings,
        };
      }
    } catch {
      // try next fetcher
    }
  }
  return undefined;
}

async function captureProviderViaNativeCdp(
  cdp: NativeCdp,
  plan: { provider: PlatformSearchProvider; platform: JobPlatform; url: string },
  existingTargets: NativeTargetList["targetInfos"],
  keyword: string,
  signal?: AbortSignal,
  interactiveWaitMs?: number,
  depth: "quick" | "standard" | "deep" = "quick",
  maxPages?: number,
): Promise<LiveBatchProviderResult> {
  const hostMatch = PLATFORM_HOST_MATCH[plan.provider];
  const matchingTabs = existingTargets.filter((t) => {
    if (t.type !== "page" || !t.url) return false;
    try {
      return hostMatch(new URL(t.url).hostname);
    } catch {
      return false;
    }
  });
  const existing =
    matchingTabs.find(
      (t) =>
        t.url.includes("/web/geek/job") ||
        t.url.includes("/zhaopin") ||
        t.url.includes("/pc/search") ||
        t.url.includes("/search"),
    ) || matchingTabs[0];

  let targetId: string | undefined = existing?.targetId;
  let sessionId: string | undefined;

  try {
    if (!targetId) {
      const created = await cdp.send<{ targetId?: string }>(
        "Target.createTarget",
        { url: plan.url },
        undefined,
        4000,
      );
      targetId = created.targetId;
    }
    if (!targetId) {
      return {
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "error",
        cards: [],
        rawCardCount: 0,
        warnings: [],
        error: "无法创建平台搜索标签页",
      };
    }

    // Always activate tab so Chrome avoids background throttling for layout/scripts
    await cdp.send("Target.activateTarget", { targetId }, undefined, 2500).catch(() => {});

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
        error: "无法附着到平台搜索标签页",
      };
    }

    await cdp.send("Page.enable", {}, sessionId, 3000).catch(() => {});

    const pageLimit = maxPages ?? (depth === "deep" ? 30 : depth === "standard" ? 15 : 5);
    const pageUrls = getPlatformExpandedUrls(plan.provider, plan.url, keyword, pageLimit);
    const allRawCards: JobSearchCard[] = [];
    const seenCardKeys = new Set<string>();
    const allWarnings: string[] = [];
    let lastStatus: LiveBatchProviderResult["status"] = "unknown_layout";
    let lastPageUrl = plan.url;

    const maxCardCap = depth === "deep" ? 3000 : depth === "standard" ? 1500 : 500;

    const addCards = (cards: JobSearchCard[]) => {
      for (const c of cards) {
        const key = c.url && !c.url.includes("#") ? c.url : `${c.title}__${c.company}`;
        if (!seenCardKeys.has(key)) {
          seenCardKeys.add(key);
          allRawCards.push(c);
        }
      }
    };

    // Activate target and check if initial navigation is needed
    await cdp.send("Target.activateTarget", { targetId }, undefined, 2500).catch(() => {});
    const curTargets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000).catch(() => ({ targetInfos: [] }));
    const thisTarget = curTargets.targetInfos?.find((t) => t.targetId === targetId);
    const currentTabUrl = thisTarget?.url || "";

    const needsInitialNav =
      !currentTabUrl ||
      currentTabUrl === "about:blank" ||
      !PLATFORM_HOST_MATCH[plan.provider](new URL(currentTabUrl.startsWith("http") ? currentTabUrl : "http://localhost").hostname);

    if (needsInitialNav) {
      await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
      await cdp.send("Page.navigate", { url: plan.url }, sessionId, 8000).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      lastPageUrl = plan.url;
    } else {
      lastPageUrl = currentTabUrl;
    }

    for (let page = 1; page <= pageLimit; page++) {
      if (signal?.aborted) break;
      if (allRawCards.length >= maxCardCap) break;

      try {
        await cdp.send("Target.activateTarget", { targetId }, undefined, 2000).catch(() => {});

        // Scroll down to trigger lazy loading of image and job elements
        if (plan.provider === "boss") {
          await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              window.scrollTo(0, document.body.scrollHeight);
              const loader = document.querySelector(".loading-wait");
              if (loader) loader.scrollIntoView();
              window.dispatchEvent(new Event("scroll"));
            })()`
          }, sessionId).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          await cdp.send("Runtime.evaluate", { expression: "window.scrollBy(0, 1200)" }, sessionId).catch(() => {});
          await new Promise((r) => setTimeout(r, 350));
          await cdp.send("Runtime.evaluate", { expression: "window.scrollBy(0, 1200)" }, sessionId).catch(() => {});
          await new Promise((r) => setTimeout(r, 450));
        }

        // 1. High-fidelity in-browser extraction via evaluate
        const evalCards = await extractCardsViaEvaluate(cdp, sessionId, plan.platform, lastPageUrl);
        addCards(evalCards);

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
          addCards(rawCards);

          const projected = projectNativeDomSnapshot(
            rawSnapshot,
            { id: targetId, url: lastPageUrl },
            { readyState: "complete" },
            { purpose: "search", detect51JobWaf: plan.platform === "51JOB" },
          );
          const extracted = extractJobSearchCards(projected, plan.platform);
          addCards(extracted.cards);
          if (extracted.status !== "unknown_layout") lastStatus = extracted.status;
          for (const w of extracted.warnings) {
            if (!allWarnings.includes(w)) allWarnings.push(w);
          }

          const isLoginRedirect =
            /\/web\/user\/|\/login|passport\.|security-check|verify/i.test(projected.url || lastPageUrl);
          if (isLoginRedirect) {
            const maxPauseMs = typeof interactiveWaitMs === "number" ? interactiveWaitMs : 0;
            let userResolved = false;

            if (maxPauseMs > 0) {
              await focusRealChromeWindow(9222).catch(() => {});
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
                } catch {}

                let leftGate = false;
                try {
                  const tg = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000);
                  const curUrl = tg.targetInfos?.find((t) => t.targetId === targetId)?.url || "";
                  if (curUrl && !/\/web\/user\/|passport\.liepin|security-check|verify/i.test(curUrl) && !curUrl.includes("blank")) {
                    leftGate = true;
                  }
                } catch {}

                if (hasAuthCookie || leftGate) {
                  userResolved = true;
                  allWarnings.push(`${plan.platform} 登录或人机验证已通过人机协同接续完成`);
                  break;
                }
              }
            }

            if (userResolved) {
              await cdp.send("Target.activateTarget", { targetId }, undefined, 2500).catch(() => {});
              await cdp.send("Page.navigate", { url: plan.url }, sessionId, 5000).catch(() => {});
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }

            lastStatus = /security-check|verify/i.test(projected.url || lastPageUrl)
              ? "verification_required"
              : "login_required";
            break;
          }
        } catch {}

        if (allRawCards.length > 0) {
          lastStatus = "ready";
        }

        // Advance to next page if not on final page
        if (page < pageLimit) {
          const clicked = await clickPlatformNextPage(cdp, sessionId, plan.platform);
          if (clicked) {
            // In-page AJAX load: wait 1500ms for DOM update
            await new Promise((r) => setTimeout(r, 1600));
          } else {
            // In-page next button not found or reached end; try next expanded URL if available
            const nextUrl = pageUrls[page];
            if (nextUrl && nextUrl !== lastPageUrl) {
              lastPageUrl = nextUrl;
              if (plan.provider === "boss") {
                await cdp.send("Runtime.evaluate", {
                  expression: `window.location.href = ${JSON.stringify(nextUrl)}`
                }, sessionId, 5000).catch(() => {});
                await new Promise((r) => setTimeout(r, 2200));
              } else {
                await cdp.send("Page.stopLoading", {}, sessionId).catch(() => {});
                await cdp.send("Page.navigate", { url: nextUrl }, sessionId, 7000).catch(() => {});
                await new Promise((r) => setTimeout(r, 1800));
              }
            } else {
              break;
            }
          }
        }
      } catch {
        // Page loop error, proceed
      }
    }

    const cards = sanitizeReviewedCards(
      allRawCards,
      plan.provider,
      plan.url,
      keyword,
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
      };
    }

    return {
      provider: plan.provider,
      platform: plan.platform,
      pageUrl: reviewedCardsSearchPage(lastPageUrl, plan.provider) ? lastPageUrl : plan.url,
      status: lastStatus,
      cards: [],
      rawCardCount: 0,
      warnings: allWarnings,
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
      error: error instanceof Error ? error.message : "平台页面读取异常",
    };
  } finally {
    if (sessionId) {
      await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 1500).catch(() => {});
    }
  }
}

export async function runLiveBatchSearch(
  rawInput: unknown,
  signal?: AbortSignal,
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
  const linkedinPlan = plans.find((p) => p.provider === "linkedin");
  const browserPlans = plans.filter((p) => p.provider !== "linkedin");

  const linkedinPromise = linkedinPlan
    ? fetchLinkedInDirect(linkedinPlan, input.keyword, signal)
    : Promise.resolve(undefined);

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
      // Sequentially query browser platforms with dedicated active foreground focus to avoid tab competition
      for (const plan of browserPlans) {
        if (signal?.aborted) break;
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
          );
          browserResults.push(res);
        } catch (error) {
          browserResults.push({
            provider: plan.provider,
            platform: plan.platform,
            pageUrl: plan.url,
            status: "error" as const,
            cards: [],
            rawCardCount: 0,
            warnings: [],
            error: error instanceof Error ? error.message : "未能读取平台数据",
          });
        }
      }
    } catch (error) {
      browserResults = browserPlans.map((plan) => ({
        provider: plan.provider,
        platform: plan.platform,
        pageUrl: plan.url,
        status: "error" as const,
        cards: [],
        rawCardCount: 0,
        warnings: [],
        error: error instanceof Error ? error.message : "未能连接真实 Chrome 调试端口 9222",
      }));
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
      } else {
        results.push({
          provider: "linkedin",
          platform: "LinkedIn",
          pageUrl: plan.url,
          status: "empty",
          cards: [],
          rawCardCount: 0,
          warnings: [],
        });
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
