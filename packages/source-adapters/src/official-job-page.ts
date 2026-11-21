import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { includesSearchText, type SourceDefinition } from "@better-me/opportunities";
import { publicUrl } from "./adapters/common.js";
import { discoveryRegion, relatedOfficialSkills } from "./official-discovery-coverage.js";
import { describeJobPreferences } from "./official-job-preferences.js";
import { readJobPostingJsonLd } from "./jobposting-jsonld-reader.js";
import { workdayBoard } from "./workday-job-search.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate } from "./official-job-discovery-contracts.js";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const skip = new Set(["script", "style", "template", "noscript", "svg", "iframe", "nav", "footer", "aside", "head"]);
function ignored(element: Element): boolean {
  return skip.has(element.tagName) || attribute(element, "hidden") !== undefined || attribute(element, "aria-hidden") === "true";
}
function elementText(node: Node): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("childNodes" in node) || ("tagName" in node && ignored(node))) return "";
  const text = node.childNodes.map(elementText).join("");
  return "tagName" in node && ["p", "div", "li", "br", "section", "h1", "h2", "h3", "h4"].includes(node.tagName) ? "\n" + text + "\n" : text;
}
function readable(html: string) {
  const root = parse(html);
  const nodes: Element[] = [];
  const queue = [{ node: root as Node, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++count > 50_000 || depth > 200) throw new Error("page-limit");
    if ("tagName" in node) {
      if (node.tagName !== "head" && ignored(node)) continue;
      nodes.push(node);
    }
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) queue.push({ node: node.childNodes[i]!, depth: depth + 1 });
  }
  const main = nodes.find(node => node.tagName === "main") ?? nodes.find(node => node.tagName === "article") ?? nodes.find(node => node.tagName === "body");
  const text = main ? elementText(main).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim() : "";
  const headings = nodes.filter(node => node.tagName === "h1").map(node => elementText(node).trim()).filter(Boolean);
  const apply = nodes.some(node => node.tagName === "a" && /^\s*(?:apply(?: now| for (?:this|the) (?:job|position|role))?|立即申请|申请职位|申请岗位)\s*$/i.test(elementText(node)) && Boolean(attribute(node, "href")?.match(/^(?:https?:\/\/|\/[^/]|\.\/|#[\w-]+)/i)));
  const siteName = nodes.find(node => node.tagName === "meta" && attribute(node, "property") === "og:site_name");
  const company = siteName && attribute(siteName, "content")?.replace(/(?:\s*[-|–]\s*)?(?:\s+careers|\s+jobs|招聘官网)$/i, "").trim();
  return { text, title: headings.length === 1 ? headings[0] : undefined, company, apply };
}

const closed = /(?:this (?:position|job|role|vacancy|posting)(?: is| has been| was) (?:closed|filled|expired|no longer (?:open|available))|this (?:position|job|role|vacancy|posting) has (?:now )?expired|no longer accepting applications|(?:本[职岗][位务]|该职位|该岗位|此职位)(?:已经?|现已)?(?:下线|关闭|停止招聘|招满)|招聘已结束|岗位已过期)/i;
function companyKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\d]+/gu, "");
}
function brandMatches(label: string, company: string): boolean {
  const brand = companyKey(label).replace(/(?:group|careers|jobs)$/, "");
  const words: string[] = company.normalize("NFKC").toLowerCase().match(/[a-z0-9]{3,}|[\p{Script=Han}]{2,}/gu) ?? [];
  return brand.length >= 3 && (companyKey(company) === brand || words.includes(brand) || companyKey(company).startsWith(brand) && brand.length >= 5);
}
function atsTenant(url: URL): string | undefined {
  const path = url.pathname.split("/").filter(Boolean);
  const board = workdayBoard(url.href);
  if (board && url.pathname.includes("/" + board.site + "/job/")) return board.tenant;
  if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) && path[1] === "jobs" && /^\d+$/.test(path[2] ?? "")) return path[0];
  if (["jobs.lever.co", "jobs.eu.lever.co", "jobs.ashbyhq.com"].includes(url.hostname) && /^[\da-f-]{36}$/i.test(path[1] ?? "")) return path[0];
  if (url.hostname === "jobs.smartrecruiters.com" && /^\d{6,}(?:-|$)/.test(path[1] ?? "")) return path[0];
  if (/^[a-z\d-]+\.wd\d+\.myworkdayjobs\.com$/.test(url.hostname) && path.includes("job")) return url.hostname.split(".")[0];
  return undefined;
}
function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}
function officialEvidence(url: URL, company: string, orgWebsite: string | undefined, siteName: string | undefined, sources: readonly SourceDefinition[]) {
  const tenant = atsTenant(url);
  if (tenant && brandMatches(tenant, company)) return { verificationEvidence: `企业招聘系统租户 ${tenant} 的职位详情列出招聘方 ${company}。` };
  for (const source of sources) {
    if (!source.enabled || source.status !== "active" || !source.capabilities.includes("list-jobs")) continue;
    const named = source.options?.companyName;
    if (typeof named !== "string" || companyKey(named) !== companyKey(company)) continue;
    const website = source.attribution.homepageUrl;
    if (!website) continue;
    const known = new URL(website);
    const samePageScope = known.hostname === url.hostname && (known.pathname === "/" || url.pathname.startsWith(known.pathname.replace(/\/$/, "") + "/"));
    if (samePageScope && (!tenant || brandMatches(tenant, named)))
      return { verificationEvidence: `已登记企业招聘入口 ${known.hostname} 与职位页招聘方 ${company} 一致。`, sourceId: source.sourceId };
  }
  const identity = orgWebsite && URL.canParse(orgWebsite) ? new URL(orgWebsite) : undefined;
  const domain = identity?.protocol === "https:" ? identity.hostname.replace(/^www\./, "") : undefined;
  // The employer name must corroborate a distinct site/organization identity on the same domain.
  const employerDomain = url.hostname.replace(/^(?:(?:www|jobs|careers|recruiting|recruitment|talent)\.)+/, "");
  const brand = employerDomain.match(/^([a-z0-9-]+)\.(?:[a-z]{2,24}|(?:co|com|org|net)\.[a-z]{2})$/)?.[1];
  if (brand && brandMatches(brand, company) && ((domain && hostWithin(url.hostname, domain)) || (siteName && companyKey(siteName) === companyKey(company))))
    return { verificationEvidence: `职位发布域名 ${url.hostname}、站点或组织标识与招聘方 ${company} 相符。` };
  return undefined;
}

export function inspectOfficialJobPage(html: string, url: URL, input: DiscoverOfficialJobsInput, sources: readonly SourceDefinition[], now: string): OfficialJobDiscoveryCandidate | "closed" | "different-region" | undefined {
  const rendered = readable(html);
  if (closed.test(rendered.text)) return "closed";
  const job = readJobPostingJsonLd(html, url.href).record;
  const expiry = job?.evidence.find(item => item.field === "source.validThrough")?.quote;
  const deadline = expiry && Date.parse(/^\d{4}-\d\d-\d\d$/.test(expiry) ? expiry + "T23:59:59.999Z" : expiry);
  if (typeof deadline === "number" && Number.isFinite(deadline) && deadline < Date.parse(now)) return "closed";
  if (job?.description && closed.test(job.description)) return "closed";
  // Exclude a location conflict only when all disclosed offices have sufficient structured evidence.
  if (input.region && job?.locations.length && job.workMode !== "remote") {
    const { city, country } = discoveryRegion(input.region);
    if (country && job.locations.every(place => place.countryCode && place.countryCode !== country)) return "different-region";
    if (city && job.locations.every(place => place.city && ![city.name, ...city.aliases].some(name => includesSearchText(place.city!, name)))) return "different-region";
  }
  const plainJob = !job && rendered.title && rendered.apply && /responsibilit(?:y|ies)|job description|岗位职责|职位描述/i.test(rendered.text)
    && /qualifications|requirements|任职要求|职位要求/i.test(rendered.text) && /(?:job[s]?|career[s]?|position|posting|vacanc|招聘|职位)/i.test(url.pathname);
  const title = job?.title ?? (plainJob ? rendered.title : undefined);
  const company = job?.companyName ?? (plainJob ? rendered.company : undefined);
  const description = job?.description ?? (plainJob ? rendered.text : undefined);
  if (!title || !company || !description || company.length > 500 || title.length > 1000) return undefined;
  const org = job?.evidence.find(item => item.field === "companyName")?.quote;
  let orgWebsite: string | undefined;
  if (org?.startsWith("{")) {
    try {
      const value = JSON.parse(org) as { url?: unknown; sameAs?: unknown };
      orgWebsite = [value.url, value.sameAs].flat().find((entry): entry is string => {
        const url = publicUrl(entry);
        return Boolean(url && !/(^|\.)(?:linkedin\.com|wikipedia\.org|wikidata\.org|facebook\.com|x\.com|twitter\.com)$/i.test(new URL(url).hostname));
      });
    } catch { /* The reader can truncate long evidence. */ }
  }
  const organizationUrl = orgWebsite && publicUrl(orgWebsite);
  const companyWebsite = organizationUrl && !/[?#]/.test(organizationUrl) && !new URL(organizationUrl).username && !new URL(organizationUrl).password
    && !/(?:\.(?:invalid|test)|\.)$/.test(new URL(organizationUrl).hostname) ? organizationUrl : undefined;
  const evidence = officialEvidence(url, company, orgWebsite, rendered.company, sources);
  const skills = [...new Set([...input.skills, ...(input.secondarySkills ?? [])])];
  const matchedSkills = skills.filter(skill => includesSearchText(title + " " + description, skill));
  const relatedSkills = relatedOfficialSkills(title + " " + description, input);
  const location = job?.locations.map(item => item.raw).join(" / ").slice(0, 5000);
  return {
    url: url.href, title, company, ...(companyWebsite ? { companyWebsite } : {}), description: description.slice(0, 60_000), ...(location ? { location } : {}),
    ...(job?.sourceRecordId ? { jobId: job.sourceRecordId } : {}), matchedSkills, ...(relatedSkills.length ? { relatedSkills } : {}), ...describeJobPreferences(description, company),
    verification: evidence ? "official-detail" : "unverified-lead", ...evidence,
    availability: rendered.apply && /(?:applications? (?:are )?(?:now )?open|currently (?:hiring|accepting applications)|正在招聘|正在招募)/i.test(rendered.text) ? "open" : "unknown",
  };
}
