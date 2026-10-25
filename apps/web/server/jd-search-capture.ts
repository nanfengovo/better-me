import { load, type CheerioAPI } from "cheerio";
import { z } from "zod";
import { allowedJobUrl, type JobPlatform } from "../src/lib/jd-source";
import type { JobSearchCard, JobSearchCaptureResult, JobSearchCaptureStatus } from "../src/lib/job-search-types";
import { SearchProjectionDiagnosticsSchema, type BrowserSnapshot } from "./jd-browser-snapshot";

export type { JobSearchCard, JobSearchCaptureResult, JobSearchCaptureStatus, JobSearchField } from "../src/lib/job-search-types";
type DomNode = CheerioAPI["_root"]["children"][number];

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CARDS = 50;
const MAX_CANDIDATES = 500;
const selector = z.string().trim().min(1).max(300);
const selectors = z.array(selector).min(1).max(25);
const optionalSelectors = z.array(selector).max(25).default([]);
export const JobSearchCaptureConfigSchema = z.object({
  platform: z.enum(["51JOB", "BOSS直聘", "猎聘", "LinkedIn"]),
  cardSelectors: selectors,
  titleSelectors: selectors,
  companySelectors: optionalSelectors,
  locationSelectors: optionalSelectors,
  salarySelectors: optionalSelectors,
  /** Select only source fields whose meaning is publication, never activity, refresh or update. */
  publicationSelectors: optionalSelectors,
  emptySelectors: optionalSelectors,
}).strict();
export type JobSearchCaptureConfig = z.infer<typeof JobSearchCaptureConfigSchema>;

export const JOB_SEARCH_CAPTURE_CONFIGS: Readonly<Record<JobPlatform, JobSearchCaptureConfig>> = {
  "51JOB": {
    platform: "51JOB", cardSelectors: [".joblist-item", ".joblistitem", ".job-list-item", ".j_joblist > .e"],
    titleSelectors: [".jobname", ".job-name", ".job-title", ".jname", ".t1 a"],
    companySelectors: [".company-name", ".cname", ".com_name"],
    locationSelectors: [".job-area", ".jobarea", ".workarea", ".work-area"],
    salarySelectors: [".salary", ".job-salary", ".sal"],
    publicationSelectors: [".job-publish-time", ".published-time", "time[itemprop='datePosted']"],
    emptySelectors: [".search-empty", ".joblist-empty", ".no-result", ".table_nolist"],
  },
  BOSS直聘: {
    platform: "BOSS直聘", cardSelectors: [".job-card-wrapper", ".job-list-box > li", ".job-primary"],
    titleSelectors: [".job-name", ".job-title", ".name h3"],
    companySelectors: [".company-name", ".company-text .name"],
    locationSelectors: [".job-area", ".job-location"],
    salarySelectors: [".salary", ".job-salary"],
    publicationSelectors: [".job-publish-time", ".job-published-time", "time[itemprop='datePosted']"],
    emptySelectors: [".job-list-empty", ".search-no-result", ".job-empty", ".no-result"],
  },
  猎聘: {
    platform: "猎聘", cardSelectors: [".jobCardPcContainer", ".job-card-pc-container", ".job-card-wrap", ".sojob-list > li"],
    titleSelectors: [".jobTitleBox > .ellipsis-1", ".job-title", ".job-title-box h3", ".job-info h3", ".job-name"],
    companySelectors: [".companyName", ".company-name", ".company-info .name", ".company-text .name"],
    locationSelectors: [".jobTitleBox > div > span.ellipsis-1", ".job-dq-box", ".job-area", ".job-dq"],
    // The observed current build places this salary scalar after jobTitleBox,
    // sometimes with an intervening urgent badge. Keep the exact field class;
    // an arbitrary following span could be a badge, experience or education.
    salarySelectors: [".jobDetailBox > a > div > .jobTitleBox ~ span._40108qjbMk", ".job-salary", ".salary", ".text-warning"],
    publicationSelectors: [".job-publish-time", ".job-published-time", "time[itemprop='datePosted']"],
    emptySelectors: [".search-empty", ".job-empty", ".no-result", ".empty-result"],
  },
  LinkedIn: {
    platform: "LinkedIn", cardSelectors: [".base-search-card", ".job-search-card", ".job-card-container", ".jobs-search-results__list-item", ".jobs-search__results-list > li"],
    titleSelectors: [".base-search-card__title", ".job-card-list__title--link", ".job-card-list__title", ".job-card-container__link"],
    companySelectors: [".base-search-card__subtitle", ".job-card-container__primary-description"],
    locationSelectors: [".job-search-card__location", ".job-card-container__location"],
    salarySelectors: [".job-search-card__salary-info", ".job-card-container__salary-info", ".salary"],
    publicationSelectors: ["time.job-search-card__listdate", "time.job-search-card__listdate--new", "time[itemprop='datePosted']"],
    emptySelectors: [".jobs-search-no-results-banner", ".jobs-search-no-results", ".no-results"],
  },
};

export type JobSearchSnapshot = Pick<BrowserSnapshot, "html" | "url" | "title" | "gate" | "oversized" | "pageLoad" | "searchDiagnostics"> & { captureTruncated?: boolean };

const EXCLUDED = "script,style,template,noscript,iframe,frame,input,textarea,select,option,nav,aside,footer,.recommend,.recommendation,.recommendations,.job-recommend,.job-recommend-list,.related-jobs";
const GATE_SELECTORS = "[role='dialog'],[aria-modal='true'],dialog[open],.login-mask,.login-panel,.login-page,.verify-wrap,.verify-box,.captcha-container,.geetest_panel,.security-check";
const VERIFICATION = /请.{0,15}(?:安全验证|人机验证|访问验证|验证码)|完成.{0,8}(?:安全验证|人机验证)|拖动.{0,12}滑块|verify.{0,25}(?:human|identity)|checking your browser|security verification|安全中心发现您的.{0,20}(?:账号|帐号|IP)/i;
const LOGIN = /请先登录|请登录后|登录后(?:查看|浏览|继续)|sign in to (?:view|continue|see)|join to (?:view|see)/i;
const EMPTY = /(?:暂无|没有|未找到|暂未找到|未搜索到).{0,15}(?:相关|符合|匹配)?.{0,10}(?:职位|岗位)|no (?:matching |relevant |search )?(?:jobs|results)(?: found)?|we couldn.t find any jobs/i;
const NOT_PUBLICATION = /更新|活跃|在线|上线|回复|刷新|updated?|active|replied|viewed|promoted/i;
const text = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

function detailIdentity(input: string, platform: JobPlatform, base: string): { url: string; id: string } | undefined {
  try {
    const allowed = allowedJobUrl(new URL(input, base).toString());
    if (allowed.platform !== platform) return;
    const url = new URL(allowed.url);
    const patterns: Record<JobPlatform, RegExp[]> = {
      BOSS直聘: [/^\/job_detail\/([a-z\d_-]+)\.html\/?$/i, /^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i],
      猎聘: [/^\/job\/(\d+)\.shtml\/?$/i],
      "51JOB": [/^\/jobs\/(?:[^/]+\/)*(\d+)\.html\/?$/i, ...(url.hostname === "jobs.51job.com" ? [/^\/(?!jobs\/)[^/]+\/(\d+)\.html\/?$/i] : [])],
      LinkedIn: [/^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/i],
    };
    for (const pattern of patterns[platform]) {
      const id = url.pathname.match(pattern)?.[1];
      if (id) return { url: allowed.url, id };
    }
  } catch { /* A card must carry an actual allowed single-job URL. */ }
}

function searchPage(url: URL, platform: JobPlatform): boolean {
  const patterns: Record<JobPlatform, RegExp> = {
    "51JOB": /^\/pc\/search\/?$/i,
    BOSS直聘: /^(?:\/web\/geek\/jobs?\/?|\/c\d{9}\/)$/i,
    猎聘: /^(?:\/zhaopin\/?|\/city-[a-z]+\/)$/i,
    LinkedIn: /^\/jobs\/search\/?$/i,
  };
  return patterns[platform].test(url.pathname);
}

function sanitize($: CheerioAPI): void {
  $("script,style,template,noscript,[hidden],[aria-hidden='true']").remove();
  $("[style]").each((_, node) => {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\s|;|$)|content-visibility\s*:\s*hidden)/i.test($(node).attr("style") ?? "")) $(node).remove();
  });
}

function field($: CheerioAPI, card: DomNode, candidates: readonly string[], max: number): { text: string; selector: string } | undefined {
  for (const candidate of candidates) {
    const root = $(card);
    const nodes = root.is(candidate) ? root : root.find(candidate);
    for (const node of nodes.toArray()) {
      const value = text($(node).text());
      if (value && value.length <= max) return { text: value, selector: candidate };
    }
  }
}

type SearchParserCounts = { beforeSanitize?: number; afterSanitize?: number; afterExclusion?: number; selected: number; rejectedLink: number; rejectedTitle: number; rejectedSelector: number };
const boundedCount = (value: number) => Math.min(25_000, value);
function configuredRootCount($: CheerioAPI, config: JobSearchCaptureConfig): number | undefined {
  const roots = new Set<DomNode>();
  try {
    for (const selector of [".betterme-visible-search-card", ...config.cardSelectors]) {
      for (const node of $(selector).toArray()) if (node.type === "tag") roots.add(node);
    }
    return boundedCount(roots.size);
  } catch { return undefined; }
}
function searchDiagnosticWarning(snapshot: JobSearchSnapshot, platform: JobPlatform, counts: SearchParserCounts): string {
  const diagnostic = SearchProjectionDiagnosticsSchema.safeParse(snapshot.searchDiagnostics);
  const projection = diagnostic.success && diagnostic.data.platform === platform ? diagnostic.data : undefined;
  const count = (value: number | undefined) => value === undefined ? "未计数" : String(boundedCount(value));
  const load = snapshot.pageLoad;
  const ready = load && ["loading", "interactive", "complete", "unknown"].includes(load.readyState) ? load.readyState : "unknown";
  const frames = load && Number.isInteger(load.visibleFrames) && load.visibleFrames >= 0 && load.visibleFrames <= 1000 ? String(load.visibleFrames) : "未知";
  const visibleLinks = projection?.visibleSingleJobLinks === undefined ? "未计数" : String(projection.visibleSingleJobLinks);
  const native = projection ? `投影前已知根=${projection.rawRoots}，隐藏移除=${projection.hiddenRoots}，排除区域移除=${projection.excludedRoots}，不完整字段祖先移除=${projection.incompleteRoots}，其他移除=${projection.otherRemovedRoots}，投影保留=${projection.projectedRoots}，有安全文字=${projection.projectedRootsWithText}，可见官方单岗链接线索=${visibleLinks}（非岗位数）；` : "投影计数=未提供；";
  return `结构诊断（非岗位数，计数上限25000）：${native}解析输入根=${count(counts.beforeSanitize)}，去隐藏后=${count(counts.afterSanitize)}，去排除区域后=${count(counts.afterExclusion)}，采用选择器候选=${count(counts.selected)}，单岗链接拒绝=${count(counts.rejectedLink)}，标题缺失=${count(counts.rejectedTitle)}，字段选择器拒绝=${count(counts.rejectedSelector)}；加载=${ready}，可见框架=${frames}。`;
}

/** Caller supplies rendered, visibility-filtered HTML (native projection or the evaluation below).
 * Raw HTML can only be filtered for explicit hidden attributes/inline styles; CSS visibility is a capture responsibility. */
export function extractJobSearchCards(
  snapshot: JobSearchSnapshot,
  platform: JobPlatform,
  options: { limit?: number; config?: JobSearchCaptureConfig } = {},
): JobSearchCaptureResult {
  const base = { platform, url: typeof snapshot?.url === "string" ? snapshot.url : "", cards: [] as JobSearchCard[] };
  const diagnostic: { parserCounts?: SearchParserCounts } = {};
  const stopped = (status: JobSearchCaptureStatus, warning: string): JobSearchCaptureResult => ({ ...base, status, partial: status !== "empty", warnings: [warning,
    ...(status === "unknown_layout" && diagnostic.parserCounts ? [searchDiagnosticWarning(snapshot, platform, diagnostic.parserCounts)] : [])] });
  if (!snapshot || typeof snapshot.html !== "string" || typeof snapshot.title !== "string") return stopped("unknown_layout", "搜索快照格式无效，未确认结果数量。");
  if (snapshot.oversized || new TextEncoder().encode(snapshot.html).byteLength > MAX_HTML_BYTES) return stopped("oversized", "搜索快照超出单页读取上限，未确认结果数量。");
  let page: URL;
  try {
    const allowed = allowedJobUrl(snapshot.url);
    if (allowed.platform !== platform) return stopped("unsupported_page", "当前页面与所选岗位平台不一致。");
    base.url = allowed.url; page = new URL(allowed.url);
  } catch { return stopped("unsupported_page", "当前页面不是允许的官方 HTTPS 平台页面。"); }
  const config = JobSearchCaptureConfigSchema.parse(options.config ?? JOB_SEARCH_CAPTURE_CONFIGS[platform]);
  if (config.platform !== platform || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_CARDS)) throw new Error("搜索卡片配置或数量上限无效。");
  const limit = options.limit ?? MAX_CARDS;
  const $ = load(snapshot.html);
  const parserCounts: SearchParserCounts = { beforeSanitize: configuredRootCount($, config), selected: 0, rejectedLink: 0, rejectedTitle: 0, rejectedSelector: 0 };
  diagnostic.parserCounts = parserCounts;
  sanitize($);
  parserCounts.afterSanitize = configuredRootCount($, config);
  const visibleText = text($("body").text() || $.root().text());
  if (snapshot.gate === "verification_required" || VERIFICATION.test(visibleText)) return stopped("verification_required", "原站要求人工完成访问验证，尚未确认搜索结果数量。");
  if (snapshot.gate === "login_required") return stopped("login_required", "原站要求登录后查看，尚未确认搜索结果数量。");
  for (const node of $(GATE_SELECTORS).toArray()) {
    if (LOGIN.test(text($(node).text()))) return stopped("login_required", "原站显示登录阻断，尚未确认搜索结果数量。");
  }
  if (!searchPage(page, platform)) {
    if (LOGIN.test(visibleText) || /\/(?:login|checkpoint|authwall|uas\/login)(?:\/|$)/i.test(page.pathname) && /登录|sign in|log in/i.test(visibleText)) return stopped("login_required", "当前为原站登录页面，尚未确认搜索结果数量。");
    return stopped("unsupported_page", "当前页面不是已支持的岗位搜索列表，未读取详情页推荐岗位。");
  }
  $(EXCLUDED).remove();
  parserCounts.afterExclusion = configuredRootCount($, config);
  let selected = "";
  let candidates: DomNode[] = [];
  try {
    for (const candidate of [".betterme-visible-search-card", ...config.cardSelectors]) {
      const matched = $(candidate).toArray().filter((node) => node.type === "tag");
      if (matched.length) { selected = candidate; candidates = matched; break; }
    }
  } catch { return stopped("unknown_layout", "搜索卡片选择器不适用于当前页面，未确认结果数量。"); }
  parserCounts.selected = boundedCount(candidates.length);
  const cards: JobSearchCard[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let truncated = Boolean(snapshot.captureTruncated) || candidates.length > MAX_CANDIDATES;
  for (const card of candidates.slice(0, MAX_CANDIDATES)) {
    if (cards.length >= limit) { truncated = true; break; }
    const targets = new Map<string, { url: string; id: string }>();
    const anchors = $(card).is("a[href]") ? [card, ...$(card).find("a[href]").toArray()] : $(card).find("a[href]").toArray();
    for (const anchor of anchors) {
      const href = $(anchor).attr("href");
      if (!href || href.length > 4096) continue;
      const target = detailIdentity(href, platform, base.url);
      if (target) targets.set(target.id, targets.get(target.id) ?? target);
    }
    if (targets.size !== 1) { rejected++; parserCounts.rejectedLink++; continue; }
    const target = [...targets.values()][0]!;
    if (seen.has(target.id)) continue;
    let title: ReturnType<typeof field>;
    let company: ReturnType<typeof field>;
    let location: ReturnType<typeof field>;
    let salary: ReturnType<typeof field>;
    let publication: ReturnType<typeof field>;
    try {
      title = field($, card, config.titleSelectors, 500);
      company = field($, card, config.companySelectors, 500);
      location = field($, card, config.locationSelectors, 1000);
      salary = field($, card, config.salarySelectors, 1000);
      publication = field($, card, config.publicationSelectors, 1000);
    } catch { rejected++; parserCounts.rejectedSelector++; continue; }
    if (!title || !text($(card).text())) { rejected++; parserCounts.rejectedTitle++; continue; }
    if (publication && NOT_PUBLICATION.test(publication.text)) publication = undefined;
    const fields: JobSearchCard["evidence"]["fields"] = [{ field: "url", selector: "a[href]", text: target.url }, { field: "title", ...title }];
    for (const [name, value] of [["company", company], ["locationText", location], ["salaryText", salary], ["publicationText", publication]] as const) {
      if (value) fields.push({ field: name, ...value });
    }
    const raw = text($(card).text());
    if (raw.length > 10_000) truncated = true;
    cards.push({ platform, url: target.url, title: title.text, ...(company ? { company: company.text } : {}),
      ...(location ? { locationText: location.text } : {}), ...(salary ? { salaryText: salary.text } : {}),
      ...(publication ? { publicationText: publication.text } : {}), cardText: raw.slice(0, 10_000),
      evidence: { pageUrl: base.url, cardSelector: selected, fields } });
    seen.add(target.id);
  }
  if (!cards.length) {
    if (LOGIN.test(visibleText)) return stopped("login_required", "原站提示登录后查看，尚未确认搜索结果数量。");
    let explicitEmpty = false;
    try { explicitEmpty = [".betterme-search-empty", ...config.emptySelectors].some((candidate) => $(candidate).toArray().some((node) => EMPTY.test(text($(node).text())))); }
    catch { /* An invalid empty selector is not evidence of zero matches. */ }
    if (!candidates.length && explicitEmpty) return stopped("empty", "原站当前可见搜索列表明确显示没有匹配岗位；未查询其他页。");
    return stopped("unknown_layout", candidates.length ? "可见卡片未提供可核对的唯一单岗链接与标题，未确认结果数量。" : "当前可见页面尚未识别到支持的搜索卡片，可能仍在加载或布局已变化；未确认结果数量。");
  }
  const warnings = ["仅读取当前已渲染搜索卡片；未读取完整 JD、核实在招状态或遍历其他页面。"];
  if (truncated) warnings.push(`本页读取达到预算或内容被截断，最多保留 ${limit} 张卡片。`);
  if (rejected) warnings.push(`${rejected} 张候选缺少唯一单岗链接或标题，已跳过，不能据此推断完整结果数。`);
  if (LOGIN.test(visibleText)) warnings.push("页面另有登录后查看更多的提示，当前已读取卡片不代表全部结果。");
  return { ...base, status: "ready", cards, partial: true, warnings };
}

/** DOM-only capture for an explicitly owned search page. It reads rendered nodes and anchor
 * attributes, never storage, cookies, form values, hidden JSON or application globals. */
export function buildVisibleJobSearchSnapshot(config?: JobSearchCaptureConfig): string {
  const configs = config ? [JobSearchCaptureConfigSchema.parse(config)] : Object.values(JOB_SEARCH_CAPTURE_CONFIGS);
  return `(() => {
    const configs=${JSON.stringify(configs)};
    const url=document.URL,title=document.title;
    const base={url,title,html:''};
    const all=document.querySelectorAll('*');
    if(all.length>25000) return {...base,oversized:true};
    const host=new URL(url).hostname;
    const platform=host==='linkedin.com'||host.endsWith('.linkedin.com')?'LinkedIn':host==='liepin.com'||host.endsWith('.liepin.com')?'猎聘':host==='zhipin.com'||host.endsWith('.zhipin.com')?'BOSS直聘':host==='51job.com'||host.endsWith('.51job.com')?'51JOB':undefined;
    const config=configs.find(c=>c.platform===platform);
    if(!config||!document.body) return base;
    const visible=element=>{
      for(let node=element;node;node=node.parentElement){
        const style=getComputedStyle(node);
        if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0'||style.contentVisibility==='hidden')return false;
      }
      const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0;
    };
    const excluded=${JSON.stringify(EXCLUDED + ",form,button,img,svg,canvas,video,audio,object,embed,link,meta")};
    const renderedText=root=>{
      const walker=document.createTreeWalker(root,4);let value='',count=0,node;
      while((node=walker.nextNode())&&count++<100000&&value.length<200000){
        const parent=node.parentElement;
        if(parent&&!parent.closest(excluded)&&visible(parent))value+=' '+(node.nodeValue||'');
      }
      return value;
    };
    const verification=${VERIFICATION.toString()},login=${LOGIN.toString()},empty=${EMPTY.toString()};
    const bodyText=renderedText(document.body);
    for(const dialog of document.querySelectorAll(${JSON.stringify(GATE_SELECTORS)})){
      if(!visible(dialog))continue;const value=renderedText(dialog);
      if(verification.test(value))return {...base,gate:'verification_required'};
      if(login.test(value))return {...base,gate:'login_required'};
    }
    if(verification.test(bodyText))return {...base,gate:'verification_required'};
    let roots=[];
    for(const selector of config.cardSelectors){
      try{roots=[...document.querySelectorAll(selector)].filter(node=>visible(node)&&!node.closest(excluded));}catch{return base;}
      if(roots.length)break;
    }
    if(!roots.length&&login.test(bodyText))return {...base,gate:'login_required'};
    const output=document.implementation.createHTMLDocument(title),result=output.documentElement,body=output.body;
    const copyVisible=root=>{
      const fragment=output.createDocumentFragment(),pending=[{source:root,parent:fragment}];
      while(pending.length){
        const {source,parent}=pending.pop();
        if(source.nodeType===3){parent.append(output.createTextNode(source.nodeValue||''));continue;}
        if(source.nodeType!==1||source.matches(excluded)||!visible(source))continue;
        const copy=output.createElement(source.localName);
        for(const name of ['class','id','role','aria-modal','open',...(source.tagName==='A'?['href']:[]),...(source.tagName==='TIME'?['datetime']:[])]){
          const value=source.getAttribute(name);if(value!==null)copy.setAttribute(name,value);
        }
        parent.append(copy);
        for(let i=source.childNodes.length-1;i>=0;i--)pending.push({source:source.childNodes[i],parent:copy});
      }
      return fragment;
    };
    for(const root of roots.slice(0,${MAX_CANDIDATES})){
      const wrapper=output.createElement('article');wrapper.className='betterme-visible-search-card';wrapper.append(copyVisible(root));body.append(wrapper);
    }
    for(const selector of config.emptySelectors){
      try{for(const node of document.querySelectorAll(selector)){if(visible(node)){const value=renderedText(node);if(empty.test(value)){const p=output.createElement('p');p.className='betterme-search-empty';p.textContent=value.slice(0,2000);body.append(p);}}}}catch{}
    }
    const html=result.outerHTML;
    if(new TextEncoder().encode(html).byteLength>${MAX_HTML_BYTES})return {...base,oversized:true};
    return {...base,html,captureTruncated:roots.length>${MAX_CANDIDATES}};
  })()`;
}

export const VISIBLE_JOB_SEARCH_SNAPSHOT = buildVisibleJobSearchSnapshot();
