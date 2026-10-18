import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { load } from "cheerio";
import { allowedJobUrl, normalizeJobShare, jobPostingPublication, readJdPublicationFields, type JdImportResult, type JdSourcePublication, type JobPlatform } from "../src/lib/jd-source";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors";
import { getNetworkFetch, isTrustedLocalRequest } from "./network-proxy";
import { browserSessionManager } from "./jd-browser-session";
import type { JobSessionBackend } from "./jd-session-router";
import { isJdStartRequestId } from "../src/lib/jd-start-request";
import { isLiepinDescriptionHeading, isLiepinRequirementsHeading } from "./jd-liepin-description";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const BLOCKED_MESSAGE = "平台未公开返回岗位正文，可能需要登录、验证码或页面加载。请打开原岗位页面，截图后用视觉识别，或手动粘贴文字。";

export function cleanJobHtml(html: string): string {
  const $ = load(html, {}, false);
  $("script,style,template,noscript,[hidden],[aria-hidden='true']").remove();
  $("br").replaceWith("\n");
  $("li").prepend("• ");
  $("p,div,li,h1,h2,h3,h4,h5,h6,section,article,tr").append("\n");
  return $.root().text().replace(/\u00a0/g, " ").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

function pageFailure(code: JdFailureCode, message = BLOCKED_MESSAGE): never {
  throw new JdExtractionError({ code, stage: "page", message });
}

function timeoutCause(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (value.name === "TimeoutError" || (typeof value.code === "string" && /TIMEOUT|TIMEDOUT/.test(value.code))) return true;
    current = value.cause;
  }
  return false;
}

function desktop51JobIdentity(url: URL): string | undefined {
  if (url.protocol !== "https:" || url.hostname !== "jobs.51job.com" || url.username || url.password || (url.port && url.port !== "443")) return;
  // Keep the established /jobs/... route family under its existing matcher.
  return url.pathname.match(/^\/(?!jobs\/)[^/]+\/(\d+)\.html\/?$/i)?.[1];
}

/** Known public detail URL shapes; no private API or guessed page state is fetched. */
export function detailIdentity(url: URL, platform: JobPlatform): string | undefined {
  // Public mobile sharing route supplied by the user; keep this URL rather than rewriting it.
  if (platform === "BOSS直聘") {
    const mobileId = url.pathname.match(/^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i)?.[1];
    if (mobileId) return mobileId;
  }
  if (platform === "51JOB") {
    const desktopId = desktop51JobIdentity(url);
    if (desktopId) return desktopId;
  }
  const patterns: Record<JobPlatform, RegExp> = {
    BOSS直聘: /^\/job_detail\/([^/]+)\.html\/?$/i,
    猎聘: /^\/job\/(\d+)\.shtml\/?$/i,
    "51JOB": /^\/jobs\/(?:[^/]+\/)*(\d+)\.html\/?$/i,
    LinkedIn: /^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/i,
  };
  return url.pathname.match(patterns[platform])?.[1];
}

export function matchesJobUrl(candidate: string, source: URL, platform: JobPlatform): boolean {
  let target: URL;
  try {
    const allowed = allowedJobUrl(new URL(candidate, source).toString());
    if (allowed.platform !== platform) return false;
    target = new URL(allowed.url);
  } catch { return false; }
  const sourceId = detailIdentity(source, platform);
  const targetId = detailIdentity(target, platform);
  // The observed desktop page has its own identity. This does not establish a
  // mobile/desktop navigation alias; that still needs paired metadata evidence.
  if (platform === "51JOB" && !!desktop51JobIdentity(source) !== !!desktop51JobIdentity(target)) return false;
  if (sourceId && targetId) return sourceId === targetId;
  const query = (url: URL) => { const parameters = new URLSearchParams(url.searchParams); parameters.sort(); return parameters.toString(); };
  // On unknown detail routes the query may be the job identity, so preserve every parameter.
  return target.host === source.host && target.pathname.replace(/\/$/, "") === source.pathname.replace(/\/$/, "") && query(target) === query(source);
}

/** Observed 51job metadata aliases; never use this for navigation or requests. */
function matches51jobMetadataUrl(candidate: string, source: URL, platform: JobPlatform): boolean {
  if (platform !== "51JOB") return false;
  try {
    if (allowedJobUrl(source.toString()).platform !== "51JOB") return false;
    const sourceId = detailIdentity(source, platform);
    if (!sourceId) return false;
    const allowed = allowedJobUrl(new URL(candidate, source).toString());
    if (allowed.platform !== "51JOB") return false;
    if (matchesJobUrl(allowed.url, source, platform)) return true;
    return new URL(allowed.url).pathname.match(/^\/[^/]+\/(\d+)\.html\/?$/)?.[1] === sourceId;
  } catch { return false; }
}

function knownListingUrl(url: URL): boolean {
  return /^(?:\/|\/jobs\/?|\/jobs\/search\/?|\/web\/geek\/job\/?|\/search\/?|\/zhaopin\/?|\/zhaopin\/[^/]+\/?|\/jobs\/all\/?)$/i.test(url.pathname);
}

function hasPrimaryTitleEvidence(posting: Record<string, unknown>, heading: string, pageTitle: string): boolean {
  if (typeof posting.title !== "string") return false;
  const title = cleanJobHtml(posting.title).replace(/\s+/g, " ").trim();
  if (title.length < 2 || /^(?:职位详情|岗位详情|职位搜索|岗位搜索|招聘|job details?|jobs?)$/i.test(title)) return false;
  const primary = (heading || pageTitle).replace(/\s+/g, " ").trim();
  return primary === title || primary.startsWith(`${title} - `) || primary.startsWith(`${title} | `) || primary.startsWith(`${title} · `);
}

function hasConflictingPrimaryHeading(posting: Record<string, unknown>, heading: string): boolean {
  if (typeof posting.title !== "string") return false;
  const normalize = (text: string) => cleanJobHtml(text).replace(/\s+/g, " ").trim().toLowerCase();
  const title = normalize(posting.title);
  const primary = normalize(heading);
  const generic = /^(?:职位详情|岗位详情|职位搜索|岗位搜索|岗位职责|工作职责|职位描述|任职要求|职位要求|招聘|job details?|jobs?)(?:\s*(?:[|·:：_—-]|$))/i;
  if (!title || !primary || generic.test(title) || generic.test(primary)) return false;
  const hasSuffix = (longer: string, shorter: string) => longer.startsWith(shorter) && /^\s*[|·:：_—-]/.test(longer.slice(shorter.length));
  return title !== primary && !hasSuffix(primary, title) && !hasSuffix(title, primary);
}

function postingUrls(posting: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof posting.url === "string") urls.push(posting.url);
  const main = posting.mainEntityOfPage;
  if (typeof main === "string") urls.push(main);
  else if (main && typeof main === "object") {
    const value = main as Record<string, unknown>;
    for (const key of ["@id", "url"]) if (typeof value[key] === "string") urls.push(value[key]);
  }
  return urls;
}

export function extractPublicJobHtml(html: string, platform: JobPlatform, sourceUrl?: string, options: { requireVisibleDescription?: boolean; allowValidatedBossShareDescription?: boolean; allowValidatedLiepinDescription?: boolean } = {}): { text: string; title?: string; method: string } & JdSourcePublication {
  const $ = load(html);
  // Observed public 51job response identifies its JavaScript challenge with these meta names.
  // Inspect the marker only; never execute challenge code or persist its content/cookies.
  if ($("meta[name]").toArray().some((element) => /^aliyun_waf(?:_|$)/i.test($(element).attr("name") ?? ""))) {
    pageFailure("verification_required", "平台返回了阿里云 WAF 的 JavaScript 访问验证页，尚未取得岗位正文。请打开原岗位核对，再提供可见正文或截图。");
  }
  const pageTitle = $("title").first().text().trim();
  const titleBoundary = "(?:\\s*(?:[|·:：_—-]|$))";
  const loginTitle = new RegExp(`^(?:(?:用户|账号|帐号|会员)?登录|sign[ -]?in|log[ -]?in)${titleBoundary}`, "i");
  const verificationTitle = /^(?:安全验证|访问验证|人机验证|验证码|security verification|just a moment|access denied|robot check)(?:\s|[|·:：_—-]|$)/i;
  if (loginTitle.test(pageTitle)) pageFailure("login_required");
  if (verificationTitle.test(pageTitle)) pageFailure("verification_required");
  const postings: Array<Record<string, unknown>> = [];
  $("script").each((_index, element) => {
    if ($(element).attr("type")?.trim().toLowerCase() !== "application/ld+json") return;
    let parsed: unknown;
    try { parsed = JSON.parse($(element).text().trim()); } catch { return; }
    postings.push(...findPostings(parsed));
  });
  $("script,style,template,noscript,[hidden],[aria-hidden='true']").remove();
  const visibleText = cleanJobHtml($("body").html() ?? "");
  const primaryHeading = $("h1").first().text().trim();
  if (loginTitle.test(primaryHeading) || /^(?:请先登录|请登录后查看|登录后查看|sign in to continue)/i.test(visibleText)) pageFailure("login_required");
  if (verificationTitle.test(primaryHeading) || /^(?:请完成(?:安全|访问|人机)验证|请(?:输入|填写)验证码|verify (?:that )?you are human|checking your browser)/i.test(visibleText)) pageFailure("verification_required");
  if (/^(?:职位|岗位)(?:已(?:下线|关闭|过期)|不存在)|^(?:job (?:not found|no longer available|has expired))/i.test(primaryHeading || pageTitle)) pageFailure("unavailable", "岗位已下线、失效或不存在，请打开原页面核对。");
  const source = sourceUrl ? new URL(sourceUrl) : undefined;
  if (source && knownListingUrl(source)) pageFailure("unsupported_page", "链接尚不能确认是具体岗位详情；搜索页或推荐列表不会作为 JD，请打开具体岗位后复制链接，或截图识别。");
  const canonical = $("link[rel='canonical']").attr("href");
  // New aliases require both canonical and every source field of one posting
  // to independently identify the original job. Existing URL matches stay valid.
  const pairedMetadata = !!source && !!canonical && matches51jobMetadataUrl(canonical, source, platform)
    && postings.some((posting) => {
      const urls = postingUrls(posting);
      return urls.length > 0 && urls.every((url) => matches51jobMetadataUrl(url, source, platform));
    });
  const matchesMetadataUrl = (candidate: string) => !!source && (matchesJobUrl(candidate, source, platform)
    || (pairedMetadata && matches51jobMetadataUrl(candidate, source, platform)));
  if (source && canonical && !matchesMetadataUrl(canonical)) pageFailure("job_mismatch", "网页声明的岗位来源与当前链接不匹配，请打开原岗位核对。");
  const postingKey = (posting: Record<string, unknown>) => JSON.stringify([posting.title, posting.description, postingUrls(posting)]);
  const unique = [...new Map(postings.map((posting) => [postingKey(posting), posting])).values()]
    .filter((posting) => !source || !detailIdentity(source, platform) || postingUrls(posting).length > 0 || !hasConflictingPrimaryHeading(posting, primaryHeading));
  const matching = source ? unique.filter((posting) => { const urls = postingUrls(posting); return urls.length > 0 && urls.every(matchesMetadataUrl); }) : [];
  if (matching.length > 1 || (!matching.length && unique.length > 1)) pageFailure("ambiguous_jobs", "链接包含多个岗位，请打开一个具体岗位详情后复制链接，或截图识别。");
  const selected = matching.length ? matching : unique;
  if (source && selected.length === 1 && postingUrls(selected[0]!).some((url) => !matchesMetadataUrl(url))) pageFailure("job_mismatch", "网页中的岗位正文属于其他链接，请打开原岗位核对；不会用推荐岗位替代。");
  if (source && !detailIdentity(source, platform) && (selected.length !== 1 || !matching.length || !hasPrimaryTitleEvidence(selected[0]!, primaryHeading, pageTitle))) pageFailure("unsupported_page", "页面路径尚未适配，且缺少能确认当前岗位来源及主标题的公开证据，请打开具体岗位后核对，或截图识别。");
  // Only the strict native projector establishes full CSS/text-range evidence.
  // Standard browser snapshots also request visible corroboration, so that flag
  // alone must never enable the mobile container's potentially folded suffix.
  const validatedBossShare = options.requireVisibleDescription && options.allowValidatedBossShareDescription
    && source?.protocol === "https:" && source.hostname === "m.zhipin.com" && !source.username && !source.password && (!source.port || source.port === "443")
    && /^\/mpa\/html\/weijd\/weijd-job\/[a-z\d_-]+\/?$/i.test(source.pathname);
  const validatedLiepinDescription = options.requireVisibleDescription === true && options.allowValidatedLiepinDescription === true
    && platform === "猎聘" && source?.protocol === "https:" && ["liepin.com", "m.liepin.com", "www.liepin.com"].includes(source.hostname)
    && !source.username && !source.password && (!source.port || source.port === "443") && /^\/job\/\d+\.shtml\/?$/.test(source.pathname);
  const selectors: Record<JobPlatform, string> = {
    LinkedIn: ".show-more-less-html__markup",
    猎聘: ".job-intro-content,.job-description,.job-desc-content",
    "51JOB": ".job_msg,.job-description,.job-detail",
    // The mobile share DOM contains collapsed text in its original HTML. Only
    // the browser's validated visible projection may opt into that container.
    BOSS直聘: validatedBossShare ? ".job-sec-text,.share-position .rec-detail > div.detail-text" : ".job-sec-text",
  };
  const excludedRegions = "nav,aside,footer,.recommend,.recommendation,.recommendations,.job-recommend,.job-recommend-list,.related-jobs";
  const descriptionBody = $("body").clone();
  descriptionBody.find(excludedRegions).remove();
  const visibleDescriptionText = descriptionBody.is(excludedRegions) ? "" : cleanJobHtml(descriptionBody.html() ?? "");
  const candidateTexts: string[] = [];
  const candidates = new Set<string>();
  const composedDescriptions: Array<{ ancestors: Set<unknown>[]; text: string }> = [];
  const addCandidate = (text: string) => { candidateTexts.push(text); if (text.length >= 40) candidates.add(text); };
  const checkDescriptionGate = (text: string) => {
    if (/(?:请先登录|登录后查看|完成安全验证|enable javascript|sign in to continue)/i.test(text)) pageFailure(/登录|sign in/i.test(text) ? "login_required" : "verification_required");
  };
  let descriptionElements = $(selectors[platform]);
  if (validatedLiepinDescription) {
    // Only the native projection establishes CSS and complete text-box evidence.
    // Preserve every existing candidate and every matching DD; sibling address
    // paragraphs and unrelated headings never establish a description here.
    const nativeDescriptions = $("section.job-intro-container > dl.paragraph > dd").filter((_index, element) => $(element).parent().children("dt").toArray().some(heading => {
      if ($(heading).closest(excludedRegions).length) return false;
      const label = $(heading).clone(); label.find(excludedRegions).remove();
      return isLiepinDescriptionHeading(cleanJobHtml(label.html() ?? ""));
    }));
    descriptionElements = descriptionElements.add(nativeDescriptions);
    const composedParagraphs = new Set<unknown>();
    $("section.job-intro-container").each((_index, section) => {
      if ($(section).closest(excludedRegions).length) return;
      const paragraphs = $(section).children("dl.paragraph").toArray().filter(element => !$(element).closest(excludedRegions).length);
      const hasHeading = (element: typeof paragraphs[number], matches: (text: string) => boolean) => $(element).children("dt").toArray().some(heading => {
        if ($(heading).closest(excludedRegions).length) return false;
        const label = $(heading).clone(); label.find(excludedRegions).remove();
        return matches(cleanJobHtml(label.html() ?? ""));
      });
      const duties = paragraphs.filter(element => hasHeading(element, isLiepinDescriptionHeading));
      const requirements = paragraphs.filter(element => !duties.includes(element) && hasHeading(element, isLiepinRequirementsHeading));
      if (!requirements.length || !duties.length) return;
      if (duties.length !== 1) pageFailure("ambiguous_jobs", "同一岗位区域包含多份职责，无法确认任职要求归属，请打开原岗位核对。");
      const group = paragraphs.filter(element => duties.includes(element) || requirements.includes(element));
      for (const element of requirements) {
        const content = $(element).children("dd").toArray().filter(child => !$(child).closest(excludedRegions).length);
        if (!content.length || content.some(child => !cleanJobHtml($(child).html() ?? ""))) pageFailure("unsupported_page");
      }
      // Only a split description gets local DT/DD boundaries. Existing single
      // DD and legacy output stays byte-for-byte on its original path.
      const text = group.map(element => $(element).children("dt,dd").toArray().map(child => {
        if ($(child).closest(excludedRegions).length) return "";
        const part = $(child).clone(); part.find(excludedRegions).remove();
        return cleanJobHtml(part.html() ?? "");
      }).filter(Boolean).join("\n")).join("\n");
      addCandidate(text);
      composedDescriptions.push({ ancestors: group.map(paragraph => new Set<unknown>($(paragraph).parents().toArray())), text });
      for (const element of group) composedParagraphs.add(element);
    });
    descriptionElements = descriptionElements.filter((_index, element) => !composedParagraphs.has(element) && !$(element).parents().toArray().some(parent => composedParagraphs.has(parent)));
  }
  for (const element of descriptionElements.toArray()) {
    if ($(element).closest(excludedRegions).length) continue;
    const candidate = $(element).clone();
    candidate.find(excludedRegions).remove();
    const text = cleanJobHtml(candidate.html() ?? "");
    // A legacy wrapper can cover this exact same DOM group but omit DL/DT/DD
    // separators. Deduplicate only a proven enclosing wrapper with no extra
    // meaningful text, never two independent jobs that merely look alike.
    if (composedDescriptions.some(group => group.ancestors.every(ancestors => ancestors.has(element))
        && text.replace(/\s+/g, "") === group.text.replace(/\s+/g, ""))) {
      checkDescriptionGate(text);
      continue;
    }
    candidateTexts.push(text);
    if (text.length < 40) continue;
    // A broad 51job wrapper can contain lists/navigation; length alone is not evidence of duties.
    if (platform === "51JOB" && candidate.hasClass("job-detail") && !/(?:岗位职责|工作职责|职位描述|职位要求|任职要求|responsibilit|requirements?)/i.test(text)) continue;
    candidates.add(text);
  }
  const independent = [...candidates].filter((text, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.includes(text) && other.length > text.length));
  const compact = (text: string) => text.replace(/\s+/g, "");
  for (const posting of selected) {
    const description = cleanJobHtml(posting.description as string);
    if (description.length < 40) continue;
    if (options.requireVisibleDescription && !compact(visibleDescriptionText).includes(compact(description))) continue;
    checkDescriptionGate(description);
    // A public structured description can be an SEO summary of the full job body.
    // Only extend it with a detail container that actually contains that summary.
    const containing = independent.filter((text) => compact(text).includes(compact(description)));
    if (containing.length > 1) pageFailure("ambiguous_jobs", "多份不同岗位正文包含相同摘要，请打开原岗位核对，或截图识别。");
    const fullDescription = containing[0] ?? description;
    checkDescriptionGate(fullDescription);
    const title = typeof posting.title === "string" ? cleanJobHtml(posting.title) : undefined;
    const organization = posting.hiringOrganization as { name?: unknown } | undefined;
    const company = organization && typeof organization.name === "string" ? cleanJobHtml(organization.name) : undefined;
    // Publication belongs only to this accepted posting with current-job URL or primary-title evidence.
    // Duplicate metadata may omit dates, but contradictory disclosures must not select an arbitrary date.
    const boundPublication = source && (postingUrls(posting).length > 0 || hasPrimaryTitleEvidence(posting, primaryHeading, pageTitle));
    const disclosures = boundPublication ? postings.filter((candidate) => postingKey(candidate) === postingKey(posting))
      .map((candidate) => jobPostingPublication(candidate.datePosted)).filter((value) => value.sourcePublishedText) : [];
    const publicationKeys = new Set(disclosures.map((value) => value.sourcePublishedAt ? `instant:${Date.parse(value.sourcePublishedAt)}` : `raw:${value.sourcePublishedText}`));
    const publication = publicationKeys.size === 1 ? disclosures[0] : {};
    return { text: [title, company, fullDescription].filter(Boolean).join("\n\n"), title, method: fullDescription === description ? "JobPosting 结构化正文" : "结构化信息 + 公开岗位详情正文", ...publication };
  }
  for (const text of candidateTexts) checkDescriptionGate(text);
  if (independent.length > 1) pageFailure("ambiguous_jobs", "页面包含多份不同岗位正文，请打开一个具体岗位详情后复制链接，或截图识别。");
  if (independent[0]) return { text: [pageTitle, independent[0]].filter(Boolean).join("\n\n"), title: pageTitle || undefined, method: "公开岗位详情正文" };
  pageFailure("unsupported_page");
}

export async function readLimitedJobPage(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await response.body?.cancel();
    pageFailure("unsupported_page", "岗位页面过大，请改用截图识别。");
  }
  if (!response.body) pageFailure("unsupported_page");
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
      if (total > MAX_PAGE_BYTES) { await reader.cancel(); pageFailure("unsupported_page", "岗位页面超过 2 MB，请改用截图识别。"); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted || error instanceof JdExtractionError) throw error;
    throw new JdExtractionError({ code: timeoutCause(error) ? "timeout" : "network", stage: "page", status: response.status, message: "岗位正文读取中断，请稍后重试，或打开原页面后截图识别。" }, { cause: error });
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const headerCharset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const metadata = load(new TextDecoder("latin1").decode(bytes.slice(0, 4096)));
  const metaCharset = metadata("meta[charset]").first().attr("charset") ?? metadata("meta[http-equiv]").toArray().map((element) => metadata(element).attr("content")?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]).find(Boolean);
  const bomCharset = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : undefined;
  // Invalid labels or malformed byte sequences must not suppress a valid meta/BOM encoding.
  for (const charset of [...new Set([bomCharset, headerCharset, metaCharset, "utf-8"].filter((value): value is string => !!value))]) {
    try { return new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { /* Try the next explicit encoding. */ }
  }
  pageFailure("unsupported_page", "岗位页面编码无法可靠读取，请打开原页面核对文字，或使用截图识别。");
}

export async function fetchPublicJd(input: string, request: typeof fetch = fetch, externalSignal?: AbortSignal): Promise<JdImportResult> {
  let initial: ReturnType<typeof normalizeJobShare>;
  try { initial = normalizeJobShare(input); }
  catch (error) { throw new JdExtractionError({ code: "invalid_link", stage: "link", message: error instanceof Error ? error.message : "岗位链接格式不正确。" }, { cause: error }); }
  const controller = new AbortController();
  const cancelRequest = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", cancelRequest, { once: true });
  if (externalSignal?.aborted) cancelRequest();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let target = initial.url;
  try {
    controller.signal.throwIfAborted();
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      const source = allowedJobUrl(target);
      let response: Response;
      try {
        response = await request(source.url, {
          redirect: "manual", signal: controller.signal,
          headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "BetterMe/0.1 (user-requested public job preview)" },
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new JdExtractionError({ code: timeoutCause(error) ? "timeout" : "network", stage: "connect", message: error instanceof Error && error.message !== "fetch failed" ? error.message : "无法连接招聘平台，请检查网络，或打开原岗位后截图识别。" }, { cause: error });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) pageFailure("unsupported_page");
        let redirected: URL;
        try { redirected = new URL(location, source.url); }
        catch (error) { throw new JdExtractionError({ code: "invalid_link", stage: "link", message: "岗位链接跳转地址格式无效。" }, { cause: error }); }
        // Observed Liepin script transit, identified without fetching the non-job subdomain.
        if (source.platform === "猎聘" && redirected.protocol === "https:" && redirected.hostname === "wow.liepin.com" && !redirected.username && !redirected.password && !redirected.port && /^\/t\d+\/transit\.html$/.test(redirected.pathname)) {
          throw new JdExtractionError({ code: "unsupported_page", stage: "http", status: response.status, message: "猎聘将岗位请求跳转到脚本中转页，尚未取得岗位正文。请打开原岗位核对，再提供可见正文或截图。" });
        }
        try { target = allowedJobUrl(redirected.toString()).url; }
        catch (error) { throw new JdExtractionError({ code: "invalid_link", stage: "link", message: error instanceof Error ? error.message : "岗位链接跳转到了不支持的地址。" }, { cause: error }); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const code: JdFailureCode = response.status === 401 ? "login_required" : response.status === 403 ? "access_denied" : response.status === 429 ? "rate_limited" : "unavailable";
        const retry = response.headers.get("retry-after");
        const retryAfterSeconds = retry && response.status === 429 ? (/^\d+$/.test(retry) ? Number(retry) : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))) : undefined;
        throw new JdExtractionError({ code, stage: "http", status: response.status, message: `平台返回 HTTP ${response.status}。${BLOCKED_MESSAGE}`, ...(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds: Math.min(retryAfterSeconds, 86400) } : {}) });
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); pageFailure("unsupported_page", "平台返回的不是可读取的岗位网页，请打开原页面后截图识别。");
      }
      if (source.platform !== initial.platform || (detailIdentity(new URL(initial.url), initial.platform) && !matchesJobUrl(source.url, new URL(initial.url), initial.platform))) {
        await response.body?.cancel();
        pageFailure("job_mismatch", "跳转后的岗位与原始分享链接不一致，请打开原岗位核对。");
      }
      const result = extractPublicJobHtml(await readLimitedJobPage(response, controller.signal), source.platform, source.url);
      if (result.text.length > 120_000) throw new Error("提取的岗位正文超过 12 万字，请确认链接是否为具体岗位，或使用截图选取职责与要求。");
      return { ...result, provenance: { kind: "link", platform: source.platform, url: source.url, observedAt: new Date().toISOString(), title: result.title, ...readJdPublicationFields(result) } };
    }
    return pageFailure("unsupported_page", "平台分享链接跳转过多，请打开后复制最终岗位链接，或使用截图识别。");
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error;
    if (controller.signal.aborted) throw new JdExtractionError({ code: "timeout", stage: "connect", message: "岗位页面读取超过 15 秒，请稍后重试或使用截图识别。" }, { cause: error });
    if (error instanceof TypeError && error.message === "fetch failed") throw new JdExtractionError({ code: "network", stage: "connect", message: "无法连接招聘平台，请检查网络，或打开原岗位后截图识别。" }, { cause: error });
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", cancelRequest); }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function jdExtractionMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void, sessions: Pick<typeof browserSessionManager, "readOnce"> = browserSessionManager) {
  if (request.url?.split("?")[0] === "/api/jd/search-session") { const { jobSearchMiddleware } = await import("./jd-search-api"); await jobSearchMiddleware(request, response, browserSessionManager); return; }
  if (request.url?.split("?")[0] === "/api/jd/browser-session") { await browserSessionMiddleware(request, response); return; }
  if (request.url?.split("?")[0] !== "/api/jd/extract") { next(); return; }
  if (request.method !== "POST") { sendJson(response, 405, { error: "请使用 POST 提交岗位分享链接。" }); return; }
  if (!request.headers["content-type"]?.includes("application/json")) { sendJson(response, 415, { error: "仅接受 JSON 格式的岗位链接。" }); return; }
  if (request.headers.origin) {
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) { sendJson(response, 403, { error: "岗位提取仅允许当前工作台访问。" }); return; }
    } catch { sendJson(response, 403, { error: "来源地址无效。" }); return; }
  }
  const operation = new AbortController();
  const abortOperation = () => operation.abort(new DOMException("岗位请求已取消。", "AbortError"));
  const closeOperation = () => { if (!response.writableEnded) abortOperation(); };
  request.once("aborted", abortOperation);
  response.once("close", closeOperation);
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32_000) { sendJson(response, 413, { error: "分享内容过长，请只保留岗位链接。" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { input?: unknown; mode?: unknown };
    if (typeof body.input !== "string") { sendJson(response, 400, { error: "请提供岗位分享链接。" }); return; }
    if (body.mode !== undefined && body.mode !== "static" && body.mode !== "browser") { sendJson(response, 400, { error: "请选择公开页面或浏览器读取。" }); return; }
    if (request.aborted || response.destroyed) abortOperation();
    if (body.mode === "browser") {
      if (!isTrustedLocalRequest(request) || !request.headers.origin || !request.headers.host) { sendJson(response, 403, { error: "浏览器读取仅允许本机工作台同源访问。" }); return; }
      const owner = `${request.headers.origin}\n${request.headers.host}`;
      sendJson(response, 200, await sessions.readOnce(owner, body.input, operation.signal));
    } else sendJson(response, 200, await fetchPublicJd(body.input, await getNetworkFetch(), operation.signal));
  } catch (error) {
    const failure = error instanceof JdExtractionError ? error.failure : { code: "service_unavailable", stage: "service", message: error instanceof Error ? error.message : "岗位正文读取失败，请使用截图识别。" };
    sendJson(response, 422, { error: failure.message, failure });
  } finally { request.removeListener("aborted", abortOperation); response.removeListener("close", closeOperation); }
}

export async function browserSessionMiddleware(request: IncomingMessage, response: ServerResponse, sessions: JobSessionBackend = browserSessionManager, stopBrowser?: () => Promise<void>) {
  if (!isTrustedLocalRequest(request) || !request.headers.origin || !request.headers.host) { sendJson(response, 403, { error: "人工接续仅允许本机工作台同源访问。" }); return; }
  if (request.method !== "POST") { sendJson(response, 405, { error: "请使用 POST 操作人工接续会话。" }); return; }
  const operation = new AbortController();
  const abort = () => operation.abort(new DOMException("人工接续请求已取消。", "AbortError"));
  const closed = () => { if (!response.writableEnded) abort(); };
  request.on("aborted", abort); response.on("close", closed);
  const timer = setTimeout(() => { abort(); request.destroy(); }, 5_000);
  const owner = `${request.headers.origin}\n${request.headers.host}`;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      operation.signal.throwIfAborted();
      size += chunk.length;
      if (size > 32_000) { sendJson(response, 413, { error: "请求过大，请只提供岗位链接或会话标识。" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    clearTimeout(timer);
    operation.signal.throwIfAborted();
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value as Record<string, unknown>;
    } catch { sendJson(response, 400, { error: "人工接续请求必须是有效 JSON。" }); return; }
    if (body.action === "stop-browser") {
      if (stopBrowser) { await sessions.closeAll().catch(() => undefined); await stopBrowser(); }
      else await sessions.stopBrowser();
      sendJson(response, 200, { closed: true });
    }
    else if (body.action === "start" && typeof body.input === "string") {
      if (Object.hasOwn(body, "requestId")) {
        if (!isJdStartRequestId(body.requestId)) { sendJson(response, 400, { error: "岗位启动请求标识无效，请重新打开。" }); return; }
        if (!sessions.startRequest) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "岗位服务尚不支持可恢复启动，请更新本地服务。" });
        sendJson(response, 200, await sessions.startRequest(owner, body.input, body.requestId, operation.signal));
      } else sendJson(response, 200, await sessions.start(owner, body.input, operation.signal));
    }
    else if (body.action === "cancel-start" && typeof body.input === "string") {
      if (!isJdStartRequestId(body.requestId)) { sendJson(response, 400, { error: "岗位启动请求标识无效，无法确认本次清理。" }); return; }
      if (!sessions.cancelStart) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "岗位服务尚不支持按启动请求清理，未确认本次岗位页已结束。" });
      sendJson(response, 200, await sessions.cancelStart(owner, body.input, body.requestId));
    }
    else if (body.action === "extend" && typeof body.sessionId === "string" && /^[a-z\d_-]{16,200}$/i.test(body.sessionId)) {
      if (!sessions.extend) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "岗位服务尚不支持延长当前会话，请更新本地服务。" });
      sendJson(response, 200, await sessions.extend(owner, body.sessionId, operation.signal));
    }
    else if ((body.action === "read" || body.action === "inspect" || body.action === "focus" || body.action === "close") && typeof body.sessionId === "string" && /^[a-z\d_-]{16,200}$/i.test(body.sessionId)) {
      const result = body.action === "read" ? await sessions.read(owner, body.sessionId, operation.signal)
        : body.action === "inspect" ? await sessions.inspect(owner, body.sessionId, operation.signal)
          : body.action === "focus" ? await sessions.focus(owner, body.sessionId, operation.signal) : await sessions.close(owner, body.sessionId);
      sendJson(response, 200, result);
    } else sendJson(response, 400, { error: "请选择有效会话操作，并提供原岗位链接或会话标识。" });
  } catch (error) {
    const failure = error instanceof JdExtractionError ? error.failure : { code: "browser_unavailable", stage: "service", message: "人工接续操作未完成，请重新打开岗位后再试。" };
    sendJson(response, 422, { error: failure.message, failure });
  } finally { clearTimeout(timer); request.off("aborted", abort); response.off("close", closed); }
}

export function jdExtractorPlugin(options: { useNativeLiepin?: boolean; useNativeBoss?: boolean; useNative51Job?: boolean } = {}): Plugin {
  browserSessionManager.configure({ useNativeLiepin: options.useNativeLiepin ?? false, useNativeBoss: options.useNativeBoss ?? false, useNative51Job: options.useNative51Job ?? false });
  let cleanup: (() => void) | undefined;
  const shutdown = async () => {
    await browserSessionManager.stopBrowser("owned-only");
  };
  const attachCleanup = (server: { httpServer?: { once: (event: string, callback: () => void) => unknown } | null; watcher?: { on: (event: string, callback: (file: string) => void) => unknown; off: (event: string, callback: (file: string) => void) => unknown } }) => {
    const reportShutdownFailure = () => { console.warn("未能确认专用招聘浏览器已关闭，请检查工具窗口。"); };
    const stop = () => { void shutdown().catch(reportShutdownFailure); };
    // Source reloads release active job tabs; the dedicated browser belongs to
    // the running service and survives ordinary page/session cleanup.
    const change = (file: string) => { if (/[/\\]server[/\\]jd-(?:browser(?:-session|-snapshot)?|extractor|session-router|native-[\w-]+|cdp-dom-snapshot|persistent-browser)\.ts$/.test(file)) void browserSessionManager.closeAll().catch(reportShutdownFailure); };
    const interrupt = () => { void shutdown().catch(reportShutdownFailure).finally(() => { process.off("SIGINT", interrupt); process.kill(process.pid, "SIGINT"); }); };
    const terminate = () => { void shutdown().catch(reportShutdownFailure).finally(() => { process.off("SIGTERM", terminate); process.kill(process.pid, "SIGTERM"); }); };
    process.once("beforeExit", stop); process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
    server.watcher?.on("change", change);
    cleanup = () => { stop(); process.off("beforeExit", stop); process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); server.watcher?.off("change", change); };
    server.httpServer?.once("close", cleanup);
  };
  return {
    name: "betterme-public-jd-extractor",
    configureServer(server) { server.middlewares.use((request, response, next) => { void jdExtractionMiddleware(request, response, next); }); attachCleanup(server); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void jdExtractionMiddleware(request, response, next); }); attachCleanup(server); },
    closeBundle() { cleanup?.(); return shutdown(); },
  };
}
