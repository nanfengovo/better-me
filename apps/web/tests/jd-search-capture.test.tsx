import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  buildVisibleJobSearchSnapshot, extractJobSearchCards, JOB_SEARCH_CAPTURE_CONFIGS,
  JobSearchCaptureConfigSchema, VISIBLE_JOB_SEARCH_SNAPSHOT,
  type JobSearchSnapshot,
} from "../server/jd-search-capture";
import type { JobPlatform } from "../src/lib/jd-source";

const fixtures = {
  "51JOB": {
    search: "https://we.51job.com/pc/search?keyword=C%23&jobArea=020000",
    detail: "https://jobs.51job.com/shanghai/123456789.html?from=search",
    card: "joblist-item", title: "jobname", company: "company-name", location: "job-area", salary: "salary", publication: "job-publish-time",
  },
  BOSS直聘: {
    search: "https://www.zhipin.com/web/geek/job?query=C%23&city=101020100",
    detail: "https://www.zhipin.com/job_detail/abc_123-X.html?lid=fixture",
    card: "job-card-wrapper", title: "job-name", company: "company-name", location: "job-area", salary: "salary", publication: "job-publish-time",
  },
  猎聘: {
    search: "https://www.liepin.com/zhaopin/?key=C%23&city=020&dq=020",
    detail: "https://www.liepin.com/job/197654321.shtml?scene=search",
    card: "job-card-pc-container", title: "job-title", company: "company-name", location: "job-dq-box", salary: "job-salary", publication: "job-publish-time",
  },
  LinkedIn: {
    search: "https://www.linkedin.com/jobs/search?keywords=C%23&location=Shanghai",
    detail: "https://www.linkedin.com/jobs/view/csharp-engineer-at-example-4012345678?trackingId=fixture",
    card: "base-search-card", title: "base-search-card__title", company: "base-search-card__subtitle", location: "job-search-card__location", salary: "job-search-card__salary-info", publication: "job-search-card__listdate",
  },
  Seek: {
    search: "https://www.seek.com.au/jobs?keywords=C%23&where=Sydney",
    detail: "https://www.seek.com.au/job/78901234?type=promoted",
    card: "job-card", title: "jobTitle", company: "jobCompany", location: "jobLocation", salary: "jobSalary", publication: "jobListingDate",
  },
  Indeed: {
    search: "https://www.indeed.com/jobs?q=C%23&l=Austin",
    detail: "https://www.indeed.com/viewjob?jk=1234567890abcdef",
    card: "job_seen_beacon", title: "jcs-JobTitle", company: "companyName", location: "companyLocation", salary: "salary-snippet-container", publication: "date",
  },
  GradConnection: {
    search: "https://gradconnection.com/jobs/?q=C%23&location=Sydney",
    detail: "https://gradconnection.com/jobs/acme-corp-software-engineer-graduate/?from=search",
    card: "job-search-result", title: "job-title", company: "employer-name", location: "location-name", salary: "salary", publication: "closing-date",
  },
} satisfies Record<JobPlatform, Record<string, string>>;
const platforms = Object.keys(fixtures) as JobPlatform[];
function escape(value: string) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function card(platform: JobPlatform, options: { href?: string | null; title?: string | null; extra?: string; fields?: boolean } = {}) {
  const spec = fixtures[platform];
  const title = options.title === null ? "" : platform === "Seek"
    ? `<span data-automation="${spec.title}">${escape(options.title ?? "C# / .NET 工程师")}</span>`
    : `<span class="${spec.title}">${escape(options.title ?? "C# / .NET 工程师")}</span>`;
  const link = options.href === null ? title : `<a href="${escape(options.href ?? spec.detail)}">${title}</a>`;
  const fields = options.fields === false ? "" : platform === "Seek"
    ? `<span data-automation="${spec.company}">示例 &amp; Company</span><span data-automation="${spec.location}">上海 · 浦东</span><span data-automation="${spec.salary}">25–40K · 14薪</span><time data-automation="${spec.publication}" datetime="2026-10-17">1 day ago</time>`
    : `<span class="${spec.company}">示例 &amp; Company</span><span class="${spec.location}">上海 · 浦东</span><span class="${spec.salary}">25–40K · 14薪</span><time class="${spec.publication}" datetime="2026-10-17">1 day ago</time>`;
  return `<article class="${spec.card}" ${platform === "Seek" ? 'data-card-type="JobCard"' : ""}>${link}${fields}${options.extra ?? ""}</article>`;
}
function snapshot(platform: JobPlatform, html: string, patch: Partial<JobSearchSnapshot> = {}): JobSearchSnapshot {
  return { url: fixtures[platform].search, title: "合成搜索结果", html: `<html><body>${html}</body></html>`, ...patch };
}

for (const platform of platforms) {
  test(`${platform}: native retained class and exact anchor produce evidence-backed card fields`, () => {
    const input = snapshot(platform, card(platform));
    const before = structuredClone(input);
    const result = extractJobSearchCards(input, platform);
    assert.equal(result.status, "ready");
    assert.equal(result.partial, true);
    assert.equal(result.cards.length, 1);
    const item = result.cards[0]!;
    assert.equal(item.url, fixtures[platform].detail);
    assert.equal(item.title, "C# / .NET 工程师");
    assert.equal(item.company, "示例 & Company");
    assert.equal(item.locationText, "上海 · 浦东");
    assert.equal(item.salaryText, "25–40K · 14薪");
    assert.equal(item.publicationText, "1 day ago");
    assert.deepEqual(item.evidence.fields.map((field) => field.field), ["url", "title", "company", "locationText", "salaryText", "publicationText"]);
    assert.equal(item.evidence.pageUrl, input.url);
    assert.equal(item.evidence.cardSelector, `.${fixtures[platform].card}`);
    assert.equal("observedAt" in item || "publishedAt" in item, false);
    assert.match(result.warnings.join(" "), /未读取完整 JD/);
    assert.deepEqual(input, before);
  });
}

test("relative single-job links resolve against the actual official page without inventing a URL", () => {
  const result = extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘", { href: "/job_detail/relative_123.html?from=visible#section" })), "BOSS直聘");
  assert.equal(result.cards[0]!.url, "https://www.zhipin.com/job_detail/relative_123.html?from=visible");
});

function currentLiepinCard(options: { title?: string; href?: string; extraLink?: string; salaryMarkup?: string; recruiterState?: string } = {}) {
  const title = options.title ?? '<div class="ellipsis-1">C# 合成平台工程师</div>';
  return `<div class="synthetic-build jobCardPcContainer"><div><div class="jobDetailBox"><a href="${escape(options.href ?? fixtures.猎聘.detail)}"><div><div class="jobTitleBox">${title}<div><span>【</span><span class="ellipsis-1">上海-浦东新区</span><span>】</span></div></div>${options.salaryMarkup ?? '<span class="synthetic-salary-hash">20-30k</span>'}</div><div><span>3年以上</span><span>统招本科</span></div></a><div class="jobCompanyInfoBox"><span class="companyName ellipsis-1">合成设备公司</span></div>${options.extraLink ?? ""}</div></div><div class="jobCardRightBox"><span class="recruiterName ellipsis-1">合成招聘者</span><span>${options.recruiterState ?? "1天前在线"}</span></div></div>`;
}

test("current Liepin card keeps the observed camel-case title, company and location fields distinct", () => {
  const result = extractJobSearchCards(snapshot("猎聘", currentLiepinCard()), "猎聘");
  assert.equal(result.status, "ready");
  assert.equal(result.partial, true);
  assert.equal(result.cards.length, 1);
  const item = result.cards[0];
  assert.equal(item.title, "C# 合成平台工程师");
  assert.equal(item.company, "合成设备公司");
  assert.equal(item.locationText, "上海-浦东新区");
  assert.equal(item.salaryText, undefined);
  assert.equal(item.publicationText, undefined);
  assert.equal(item.evidence.cardSelector, ".jobCardPcContainer");
  assert.deepEqual(item.evidence.fields.map(({ field, selector }) => [field, selector]), [
    ["url", "a[href]"], ["title", ".jobTitleBox > .ellipsis-1"], ["company", ".companyName"], ["locationText", ".jobTitleBox > div > span.ellipsis-1"],
  ]);
});

test("observed Liepin salary scalar keeps exact visible text and selector despite an intervening urgent badge", () => {
  for (const badge of ["", '<span class="_40108V9EEZ">急聘</span>']) {
    const result = extractJobSearchCards(snapshot("猎聘", currentLiepinCard({
      salaryMarkup: `${badge}<span class="_40108qjbMk">15-30k</span>`, recruiterState: "2天前在线",
    })), "猎聘");
    assert.equal(result.status, "ready");
    const item = result.cards[0]!;
    assert.equal(item.salaryText, "15-30k");
    assert.equal(item.publicationText, undefined);
    assert.deepEqual(item.evidence.fields.find(({ field }) => field === "salaryText"), {
      field: "salaryText", selector: ".jobDetailBox > a > div > .jobTitleBox ~ span._40108qjbMk", text: "15-30k",
    });
    assert.equal("salary" in item || "currency" in item || "publishedAt" in item, false);
  }
});

test("Liepin salary selector rejects hidden fields, unrelated siblings and unrecognized builds", () => {
  for (const salaryMarkup of [
    '<span class="_40108V9EEZ">急聘</span><span class="_40108qjbMk" hidden>15-30k</span>',
    '<span class="_40108V9EEZ">急聘</span><span class="_40108qjbMk" aria-hidden="true">15-30k</span>',
    '<span class="_40108qjbMk" style="display:none">15-30k</span><span>8年以上</span>',
    '<span class="_40108V9EEZ">急聘</span><span class="unrecognized-build">15-30k</span>',
    '<div><span class="_40108qjbMk">15-30k</span></div>',
  ]) {
    const item = extractJobSearchCards(snapshot("猎聘", currentLiepinCard({ salaryMarkup })), "猎聘").cards[0]!;
    assert.equal(item.salaryText, undefined, salaryMarkup);
    assert.equal(item.evidence.fields.some(({ field }) => field === "salaryText"), false);
  }
});

test("current Liepin roots still require a complete explicit title and one supported single-job identity", () => {
  for (const html of [
    currentLiepinCard({ title: "" }),
    currentLiepinCard({ title: '<div class="ellipsis-1" hidden>隐藏岗位标题</div>' }),
    currentLiepinCard({ href: "https://www.liepin.com/a/12345678.shtml" }),
    currentLiepinCard({ extraLink: '<a href="https://www.liepin.com/job/123456788.shtml">另一岗位</a>' }),
  ]) {
    const result = extractJobSearchCards(snapshot("猎聘", html), "猎聘");
    assert.equal(result.status, "unknown_layout");
    assert.equal(result.cards.length, 0);
  }
});

test("links must identify an official HTTPS single job from the same platform", () => {
  const rejected = [
    fixtures.BOSS直聘.search, "https://www.zhipin.com/gongsi/123.html", fixtures.LinkedIn.detail,
    "http://www.zhipin.com/job_detail/a.html", "https://u:p@www.zhipin.com/job_detail/a.html",
    "https://www.zhipin.com:444/job_detail/a.html", "https://www.zhipin.com.evil.invalid/job_detail/a.html",
    "https://evil.zhipin.com/job_detail/a.html", "javascript:alert(1)", "data:text/html,job", "#job",
  ];
  for (const href of rejected) {
    const result = extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘", { href })), "BOSS直聘");
    assert.equal(result.cards.length, 0, href);
    assert.equal(result.status, "unknown_layout", href);
  }
});

test("a missing detail anchor, missing title or two distinct detail IDs cannot become a record", () => {
  for (const item of [
    card("BOSS直聘", { href: null }), card("BOSS直聘", { title: null }),
    card("BOSS直聘", { extra: '<a href="/job_detail/other_123.html">另一岗位</a>' }),
  ]) {
    const result = extractJobSearchCards(snapshot("BOSS直聘", item), "BOSS直聘");
    assert.equal(result.status, "unknown_layout");
    assert.equal(result.cards.length, 0);
  }
});

test("same detail ID across tracking queries and duplicate anchors is deduplicated, keeping the first observed URL", () => {
  const first = card("LinkedIn", { extra: '<a href="https://www.linkedin.com/jobs/view/4012345678?ref=second">查看</a>' });
  const duplicate = card("LinkedIn", { href: "https://www.linkedin.com/jobs/view/4012345678?ref=third" });
  const result = extractJobSearchCards(snapshot("LinkedIn", first + duplicate), "LinkedIn");
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]!.url, fixtures.LinkedIn.detail);
});

test("the parser returns at most 50 cards and clearly marks its single-page budget", () => {
  const items = Array.from({ length: 60 }, (_, index) => card("猎聘", { href: `https://www.liepin.com/job/${100000000 + index}.shtml` })).join("");
  const input = snapshot("猎聘", items);
  const all = extractJobSearchCards(input, "猎聘");
  assert.equal(all.cards.length, 50);
  assert.equal(all.partial, true);
  assert.match(all.warnings.join(" "), /最多保留 50/);
  const small = extractJobSearchCards(input, "猎聘", { limit: 3 });
  assert.equal(small.cards.length, 3);
  assert.match(small.warnings.join(" "), /最多保留 3/);
});

test("fields are selected explicitly and never guessed from experience, education or generic card text", () => {
  const input = snapshot("猎聘", card("猎聘", { fields: false, extra: '<div class="job-labels">上海 5–10年 本科 30k</div><div>2026-10-17 发布</div>' }));
  const result = extractJobSearchCards(input, "猎聘");
  const item = result.cards[0]!;
  assert.equal(item.company, undefined);
  assert.equal(item.locationText, undefined);
  assert.equal(item.salaryText, undefined);
  assert.equal(item.publicationText, undefined);
  assert.match(item.cardText, /上海 5–10年 本科 30k/);
  assert.deepEqual(item.evidence.fields.map((field) => field.field), ["url", "title"]);
});

test("publication uses an explicit source field, excluding updates, recruiter activity and hidden/global dates", () => {
  for (const value of ["今日更新", "招聘者 1小时前活跃", "Updated yesterday", "Promoted 2 days ago"]) {
    const input = snapshot("BOSS直聘", card("BOSS直聘", { fields: false, extra: `<time class="job-publish-time">${value}</time>` }));
    assert.equal(extractJobSearchCards(input, "BOSS直聘").cards[0]!.publicationText, undefined, value);
  }
  const input = snapshot("BOSS直聘", card("BOSS直聘", { fields: false, extra: '<time datetime="2026-10-17">2026-10-17</time><span class="boss-active-time">今日在线</span><time class="job-publish-time" datetime="2026-10-17"></time><script type="application/ld+json">{"datePosted":"2026-10-17"}</script>' }) + '<time class="job-publish-time">页面日期 2026-10-17</time>');
  const result = extractJobSearchCards(input, "BOSS直聘");
  assert.equal(result.cards[0]!.publicationText, undefined);
  assert.equal(result.cards[0]!.cardText.includes("datePosted"), false);
});

test("explicit empty results differ from loading, blank, unknown, login and verification", () => {
  const cases = [
    { html: '<div class="job-list-empty">暂无匹配岗位</div>', status: "empty" },
    { html: '<div class="job-list-empty">正在加载岗位</div>', status: "unknown_layout" },
    { html: '<p>暂无匹配岗位</p>', status: "unknown_layout" },
    { html: "", status: "unknown_layout" },
    { html: '<div role="dialog">请登录后查看</div>', status: "login_required" },
    { html: '<div class="verify-wrap">请完成安全验证</div>', status: "verification_required" },
    { html: '<section class="new-unrecognized-layout">C# 岗位</section>', status: "unknown_layout" },
  ];
  for (const { html, status } of cases) {
    const result = extractJobSearchCards(snapshot("BOSS直聘", html), "BOSS直聘");
    assert.equal(result.status, status, html);
    assert.equal(result.cards.length, 0);
    assert.equal(result.partial, status !== "empty");
  }
});

test("unknown layout diagnostics distinguish hidden and excluded roots from invalid links and missing titles", () => {
  const input = snapshot("BOSS直聘", `<section hidden>${card("BOSS直聘", { title: "PRIVATE_HIDDEN_TITLE" })}</section>`
    + `<aside>${card("BOSS直聘", { title: "PRIVATE_RECOMMENDED_TITLE" })}</aside>`
    + card("BOSS直聘", { href: null, title: "PRIVATE_LINKLESS_TITLE" })
    + card("BOSS直聘", { title: null }), { pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 } });
  const result = extractJobSearchCards(input, "BOSS直聘");
  assert.equal(result.status, "unknown_layout");
  assert.equal(result.cards.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[1], /结构诊断（非岗位数/);
  assert.match(result.warnings[1], /解析输入根=4，去隐藏后=3，去排除区域后=2，采用选择器候选=2，单岗链接拒绝=1，标题缺失=1/);
  assert.match(result.warnings[1], /加载=complete，可见框架=0/);
  assert.doesNotMatch(result.warnings.join(" "), /PRIVATE_|https:|abc_123/);
});

test("unknown roots and lost native roots remain distinguishable without promoting either into a zero-jobs result", () => {
  const diagnostic = { schemaVersion: 1 as const, platform: "猎聘" as const, rawRoots: 3,
    hiddenRoots: 1, excludedRoots: 1, incompleteRoots: 1, otherRemovedRoots: 0, projectedRoots: 0, projectedRootsWithText: 0 };
  const result = extractJobSearchCards(snapshot("猎聘", '<section class="unrecognized">PRIVATE_OTHER_LAYOUT</section>', { searchDiagnostics: diagnostic }), "猎聘");
  assert.equal(result.status, "unknown_layout"); assert.equal(result.partial, true);
  assert.match(result.warnings[1], /投影前已知根=3，隐藏移除=1，排除区域移除=1，不完整字段祖先移除=1/);
  assert.match(result.warnings[1], /投影保留=0，有安全文字=0；解析输入根=0/);
  assert.doesNotMatch(result.warnings.join(" "), /PRIVATE_/);
  const noKnownRoots = extractJobSearchCards(snapshot("猎聘", "", { searchDiagnostics: { ...diagnostic, rawRoots: 0, hiddenRoots: 0, excludedRoots: 0, incompleteRoots: 0 } }), "猎聘");
  assert.match(noKnownRoots.warnings[1], /投影前已知根=0/);
});

test("malformed or cross-platform diagnostic metadata contributes no text or claimed root counts", () => {
  const diagnostic = { schemaVersion: 1, platform: "LinkedIn", rawRoots: 99,
    hiddenRoots: 99, excludedRoots: 0, incompleteRoots: 0, otherRemovedRoots: 0, projectedRoots: 0, projectedRootsWithText: 0 };
  for (const value of [diagnostic, { ...diagnostic, platform: "猎聘", rawTitle: "PRIVATE_DIAGNOSTIC_TITLE" }]) {
    const result = extractJobSearchCards(snapshot("猎聘", "", { searchDiagnostics: value as JobSearchSnapshot["searchDiagnostics"] }), "猎聘");
    assert.equal(result.status, "unknown_layout");
    assert.match(result.warnings[1], /投影计数=未提供/);
    assert.doesNotMatch(result.warnings.join(" "), /PRIVATE_|99/);
  }
});

test("count diagnostics are bounded independently of the 500-candidate parsing budget", () => {
  const result = extractJobSearchCards(snapshot("BOSS直聘", '<article class="job-card-wrapper"></article>'.repeat(25_001)), "BOSS直聘");
  assert.equal(result.status, "unknown_layout");
  assert.match(result.warnings[1], /计数上限25000/);
  assert.match(result.warnings[1], /解析输入根=25000.*采用选择器候选=25000，单岗链接拒绝=500/);
  assert.doesNotMatch(result.warnings[1], /25001/);
});

test("diagnostic counts never override gates, explicit emptiness or a successful partial capture", () => {
  for (const [html, expected] of [
    ['<form>请完成安全验证</form>', "verification_required"],
    ['<div role="dialog">请登录后查看</div>', "login_required"],
    ['<div class="job-list-empty">暂无匹配岗位</div>', "empty"],
    [card("BOSS直聘"), "ready"],
  ]) {
    const result = extractJobSearchCards(snapshot("BOSS直聘", html), "BOSS直聘");
    assert.equal(result.status, expected);
    assert.equal(result.warnings.some(value => value.includes("结构诊断")), false);
  }
});

test("explicit gates take precedence over visible cards while hidden gates and recommendations do not count", () => {
  for (const gate of ["login_required", "verification_required"] as const) {
    const result = extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘"), { gate }), "BOSS直聘");
    assert.equal(result.status, gate);
    assert.equal(result.cards.length, 0);
  }
  const hidden = '<div hidden>请完成安全验证</div><div aria-hidden="true">请登录后查看</div><div style="opacity:0">请完成安全验证</div>';
  const input = snapshot("BOSS直聘", hidden + card("BOSS直聘") + `<aside>${card("BOSS直聘", { href: "/job_detail/recommended_123.html" })}</aside>`);
  assert.equal(extractJobSearchCards(input, "BOSS直聘").cards.length, 1);
});

test("detail-page recommendations, wrong platforms, unsafe pages and platform login pages are not search results", () => {
  assert.equal(extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘"), { url: fixtures.BOSS直聘.detail }), "BOSS直聘").status, "unsupported_page");
  assert.equal(extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘"), { url: fixtures.LinkedIn.search }), "BOSS直聘").status, "unsupported_page");
  assert.equal(extractJobSearchCards(snapshot("BOSS直聘", card("BOSS直聘"), { url: "http://www.zhipin.com/web/geek/job" }), "BOSS直聘").status, "unsupported_page");
  assert.equal(extractJobSearchCards(snapshot("LinkedIn", "Sign in", { url: "https://www.linkedin.com/login" }), "LinkedIn").status, "login_required");
});

test("known alternative single-job identities and supported regional list routes stay finite", () => {
  const examples = [
    { platform: "51JOB", href: "https://we.51job.com/jobs/123456789.html", url: "https://we.51job.com/pc/search" },
    { platform: "BOSS直聘", href: "https://www.zhipin.com/mpa/html/weijd/weijd-job/abc_123", url: "https://www.zhipin.com/c101020100/" },
    { platform: "猎聘", href: fixtures.猎聘.detail, url: "https://www.liepin.com/city-shanghai/" },
    { platform: "LinkedIn", href: "https://hk.linkedin.com/jobs/view/4012345678/", url: "https://hk.linkedin.com/jobs/search/" },
  ] as const;
  for (const { platform, href, url } of examples) assert.equal(extractJobSearchCards(snapshot(platform, card(platform, { href }), { url }), platform).cards.length, 1, href);
});

test("oversized HTML, invalid limits and bad finite selector configuration cannot silently bypass budgets", () => {
  assert.equal(extractJobSearchCards(snapshot("51JOB", "x".repeat(2 * 1024 * 1024 + 1)), "51JOB").status, "oversized");
  assert.equal(extractJobSearchCards(snapshot("51JOB", "", { oversized: true }), "51JOB").status, "oversized");
  for (const limit of [0, -1, 1.5, 51, Infinity, NaN]) assert.throws(() => extractJobSearchCards(snapshot("51JOB", ""), "51JOB", { limit }));
  const config = { ...JOB_SEARCH_CAPTURE_CONFIGS["51JOB"], cardSelectors: ["["] };
  assert.equal(extractJobSearchCards(snapshot("51JOB", ""), "51JOB", { config }).status, "unknown_layout");
  assert.equal(JobSearchCaptureConfigSchema.safeParse({ ...config, injectedCss: "body{}" }).success, false);
  assert.throws(() => extractJobSearchCards(snapshot("51JOB", ""), "51JOB", { config: JOB_SEARCH_CAPTURE_CONFIGS.LinkedIn }));
  assert.equal(JobSearchCaptureConfigSchema.safeParse({ ...config, cardSelectors: Array(26).fill(".card") }).success, false);
});

test("card excerpts and caller capture truncation remain explicit without losing a usable card", () => {
  const result = extractJobSearchCards(snapshot("51JOB", card("51JOB", { extra: `<p>${"可见正文".repeat(4000)}</p>` }), { captureTruncated: true }), "51JOB");
  assert.equal(result.cards[0]!.cardText.length, 10000);
  assert.match(result.warnings.join(" "), /截断/);
});

async function evaluate(html: string, url = fixtures.BOSS直聘.search, script = VISIBLE_JOB_SEARCH_SNAPSHOT) {
  const dom = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
  try {
    dom.document.body.innerHTML = html;
    for (const node of dom.document.querySelectorAll("*")) Object.defineProperty(node, "getBoundingClientRect", { value() { return { width: 200, height: 40 }; } });
    for (const field of ["localStorage", "sessionStorage"] as const) Object.defineProperty(dom, field, { get() { throw new Error("capture cannot read storage"); } });
    Object.defineProperty(dom.document, "cookie", { get() { throw new Error("capture cannot read cookies"); } });
    dom.fetch = async () => { throw new Error("capture cannot perform network requests"); };
    dom.XMLHttpRequest = class { constructor() { throw new Error("capture cannot perform XHR"); } } as typeof dom.XMLHttpRequest;
    return dom.eval(script) as JobSearchSnapshot;
  } finally { await dom.happyDOM.abort(); }
}

test("browser snapshot roundtrip reads visible card nodes and anchors without storage, hidden JSON or form data", async () => {
  const extra = '<span class="secret" hidden>hidden-secret</span><span style="opacity:0">opacity-secret</span><span aria-hidden="true">aria-secret</span><span class="css-secret">css-secret</span><form><input value="input-secret"><textarea>textarea-secret</textarea><button>button-secret</button></form><script type="application/ld+json">{"secret":"script-secret"}</script><span data-token="attribute-secret">可见证据</span><img src="https://fixture.invalid/image" alt="image-secret">';
  const html = `<style>.css-secret{display:none}</style><div hidden>请完成安全验证</div><div style="opacity:0">请完成安全验证</div>${card("BOSS直聘", { extra })}<aside>${card("BOSS直聘", { href: "/job_detail/recommended_123.html" })}</aside>`;
  const captured = await evaluate(html);
  assert.equal(captured.gate, undefined);
  for (const value of ["hidden-secret", "opacity-secret", "aria-secret", "css-secret", "input-secret", "textarea-secret", "button-secret", "script-secret", "attribute-secret", "image-secret", "recommended_123"]) assert.equal(captured.html.includes(value), false, value);
  assert.match(captured.html, /href=/);
  assert.match(captured.html, /datetime="2026-10-17"/);
  assert.equal(captured.html.includes("data-token"), false);
  const result = extractJobSearchCards(captured, "BOSS直聘");
  assert.equal(result.status, "ready");
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]!.url, fixtures.BOSS直聘.detail);
  assert.match(result.cards[0]!.cardText, /可见证据/);
});

test("DOM capture supports each platform and a caller's finite custom selectors", async () => {
  for (const platform of platforms) {
    const captured = await evaluate(card(platform), fixtures[platform].search);
    assert.equal(extractJobSearchCards(captured, platform).cards[0]!.url, fixtures[platform].detail);
  }
  const config = { ...JOB_SEARCH_CAPTURE_CONFIGS.BOSS直聘, cardSelectors: [".configured-card"], titleSelectors: [".configured-title"] };
  const captured = await evaluate('<div class="configured-card"><a href="/job_detail/config_123.html"><strong class="configured-title">配置驱动岗位</strong></a></div>', fixtures.BOSS直聘.search, buildVisibleJobSearchSnapshot(config));
  assert.equal(extractJobSearchCards(captured, "BOSS直聘", { config }).cards[0]!.title, "配置驱动岗位");
});

test("current Liepin visible DOM roundtrip isolates salary from badges and CSS-hidden siblings", async () => {
  for (const hidden of [false, true]) {
    const html = '<style>.hidden-salary{display:none}</style>' + currentLiepinCard({
      salaryMarkup: `<span class="_40108V9EEZ">急聘</span><span class="_40108qjbMk${hidden ? " hidden-salary" : ""}">15-30k</span><span>8年以上</span>`,
      recruiterState: "2天前在线",
    });
    const captured = await evaluate(html, fixtures.猎聘.search);
    const item = extractJobSearchCards(captured, "猎聘").cards[0]!;
    assert.equal(item.salaryText, hidden ? undefined : "15-30k");
    assert.equal(item.publicationText, undefined);
    assert.equal(captured.html.includes("15-30k"), !hidden);
    assert.match(item.cardText, /急聘/);
  }
});

test("DOM capture distinguishes visible gates and explicit empty state; unsupported pages cannot become records", async () => {
  for (const [html, status] of [
    ['<div role="dialog">请登录后查看</div>', "login_required"],
    ['<div class="verify-wrap">请完成安全验证</div>', "verification_required"],
    ['<div class="job-list-empty">暂无匹配岗位</div>', "empty"],
    ['<div class="job-list-empty">正在加载岗位</div>', "unknown_layout"],
  ] as const) {
    const captured = await evaluate(html);
    assert.equal(extractJobSearchCards(captured, "BOSS直聘").status, status);
  }
  const unknown = await evaluate(card("BOSS直聘"), "https://example.invalid/search");
  assert.equal(unknown.html, "");
  assert.equal(extractJobSearchCards(unknown, "BOSS直聘").status, "unsupported_page");
});
