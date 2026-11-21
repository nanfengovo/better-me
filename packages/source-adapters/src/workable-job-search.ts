import { includesSearchText, type SourceDefinition } from "@better-me/opportunities";
import { z } from "zod";
import { plainText, publicUrl } from "./adapters/common.js";
import { workableCompanyBoard } from "./adapters/workable.js";
import { describeJobPreferences } from "./official-job-preferences.js";
import { rankOfficialJob, type OfficialJobDiscoveryExecution } from "./official-job-discovery.js";
import { discoveryRegion, interleaveEmployers, mapDiscoveryItems, officialQuerySkills, relatedOfficialSkills } from "./official-discovery-coverage.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";

const endpoint = "https://jobs.workable.com/api/v1/";
const source: SourceDefinition = {
  sourceId: "discovery-workable-public", name: "Jobs by Workable", adapterId: "workable-job-search", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active",
  remoteFilters: ["roles", "regions"], endpointPolicy: { allowedHosts: ["jobs.workable.com"], allowedPathPrefixes: ["/api/v1/jobs", "/api/v1/companies/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Jobs by Workable", homepageUrl: "https://jobs.workable.com/", usage: "unknown", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxPages: 3, maxRecords: 60, requestsPerMinute: 90 },
};
const employer = z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(500), url: z.string().max(2048) });
const posting = z.object({
  id: z.string().regex(/^[a-z0-9-]{10,80}$/i), state: z.string(), title: z.string().trim().min(1).max(1000), company: employer,
  url: z.string().max(2048), description: z.string().max(250_000), requirementsSection: z.string().nullish(),
  location: z.object({ city: z.string().nullish(), subregion: z.string().nullish(), countryName: z.string().nullish() }).nullish(),
  locations: z.array(z.string().max(500)).max(500).optional(), linkoutUrl: z.string().nullable().optional(),
});
type Posting = z.infer<typeof posting>;
const companyPage = employer.extend({ workableUid: z.string().nullish(), website: z.string().nullish(), isHidden: z.boolean().optional() });
const searchPage = z.object({ jobs: z.array(z.unknown()).max(100), totalSize: z.number().int().nonnegative(), nextPageToken: z.string().max(1000).optional() });
const checked = (raw: unknown, pathname: string) => {
  const validated = publicUrl(raw);
  if (!validated) return undefined;
  const url = new URL(validated);
  return url.hostname === "jobs.workable.com" && url.pathname.startsWith(pathname) ? url.href : undefined;
};

function locations(job: Posting): string[] {
  const fields = [job.location?.city, job.location?.subregion, job.location?.countryName].filter((v): v is string => !!v);
  return [...new Set([fields.join(", "), ...(job.locations ?? [])].filter(Boolean))];
}
const engineering = /software engineer|软件(开发)?工程师|后端(开发|工程师)|全栈(开发|工程师)|backend engineer|full.?stack engineer/i;
function queryTerms(input: DiscoverOfficialJobsInput) {
  const role = ({ 软件工程师: "software engineer", 后端工程师: "backend engineer", 全栈工程师: "full stack developer" } as Record<string, string>)[input.role] ?? input.role;
  return [...new Set([...officialQuerySkills(input), role].filter(Boolean))].slice(0, 4);
}
function scopeText(job: Posting) {
  return [plainText(job.description), plainText(job.requirementsSection)].filter(Boolean).join("\n\n").slice(0, 60_000);
}
function matchedSkills(text: string, input: DiscoverOfficialJobsInput) {
  return [...new Set([...input.skills, ...(input.secondarySkills ?? [])])].filter(skill => includesSearchText(text, skill));
}

export async function discoverWorkableJobs(input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const { context, transport } = execution;
  const result: OfficialJobDiscoveryResult = { observedAt: context.observedAt, status: "partial", queries: [], candidates: [], warnings: [] };
  const region = discoveryRegion(input.region).english;
  const regionTokens = (region ?? "").split(/[,，]/u).map(term => term.trim().toLowerCase()).filter(Boolean);
  const inRegion = (row: Posting) => !regionTokens.length || locations(row).some(value => {
    const parts = value.toLowerCase().split(/[,，]/u).map(part => part.trim());
    return regionTokens.every(token => parts.includes(token));
  });
  async function fetchJson(url: URL) {
    const response = await transport.request({ url: url.href, source, context, headers: { accept: "application/json" } });
    context.throwIfCancelled();
    if (response.status !== 200 || response.url !== url.href || !response.headers["content-type"]?.includes("application/json")) throw new Error("unavailable");
    return JSON.parse(response.text) as unknown;
  }
  const shortlist = new Map<string, { job: Posting; score: number }>();
  let received = 0, readsFailed = 0, agencyLeads = 0;
  const terms = queryTerms(input);
  const lists = await mapDiscoveryItems(terms, 3, async term => {
    const url = new URL("jobs", endpoint);
    url.searchParams.set("query", term);
    if (region) url.searchParams.set("location", region);
    url.searchParams.set("limit", "20");
    const jobs: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      try {
        const page = searchPage.parse(await fetchJson(url));
        received++;
        jobs.push(...page.jobs);
        if (!page.nextPageToken || url.searchParams.has("pageToken")) break;
        url.searchParams.set("pageToken", page.nextPageToken);
      } catch { context.throwIfCancelled(); readsFailed++; break; }
    }
    return { jobs, term };
  });
  for (const { jobs, term } of lists) {
    result.queries.push(`Workable · ${term}${region ? " · " + region : ""}`);
    for (const item of jobs) {
      const raw = posting.safeParse(item);
      if (!raw.success) continue;
      const job = raw.data;
      if (shortlist.has(job.id) || job.state !== "published" || !checked(job.url, "/view/") || !inRegion(job)) continue;
      const relevant = job.title + "\n" + scopeText(job);
      const skills = matchedSkills(relevant, input);
      const roleMatches = includesSearchText(job.title, input.role) || engineering.test(input.role) && /engineer|developer|programmer|工程师|开发/i.test(job.title);
      if (input.skills.length ? !skills.some(skill => input.skills.includes(skill)) && !relatedOfficialSkills(relevant, input).length : !roleMatches && !includesSearchText(relevant, term)) continue;
      if (engineering.test(input.role) && !roleMatches) continue;
      const score = (roleMatches ? 8 : 0) + skills.reduce((n, skill) => n + (input.skills.includes(skill) ? 10 : 1) + (includesSearchText(job.title, skill) ? 3 : 0), 0);
      shortlist.set(job.id, { job, score });
    }
  }
  if (!received) return { ...result, status: "provider-unavailable", warnings: ["Workable 的公开跨公司职位搜索未能返回可读结果。"] };

  // Review several employers before a second opening at the same employer consumes the detail budget.
  const ranked = [...shortlist.values()].sort((a, b) => b.score - a.score);
  const positions = interleaveEmployers(ranked, ({ job }) => job.company.id);
  const organizations = new Map<string, Promise<z.infer<typeof companyPage>>>();
  await mapDiscoveryItems(positions.slice(0, 10), 4, async ({ job }) => {
    try {
      const item = posting.parse(await fetchJson(new URL("jobs/" + job.id, endpoint)));
      if (item.id !== job.id || item.state !== "published" || item.company.id !== job.company.id || item.url !== job.url || !inRegion(item)) return;
      const text = scopeText(item);
      const skills = matchedSkills(item.title + "\n" + text, input);
      const relatedSkills = relatedOfficialSkills(item.title + "\n" + text, input);
      if (input.skills.length && !skills.some(s => input.skills.includes(s)) && !relatedSkills.length) return;
      const brief = { title: item.title, company: item.company.title, jobId: item.id, location: locations(item).join(" / ").slice(0, 5000),
        matchedSkills: skills, ...(relatedSkills.length ? { relatedSkills } : {}), travel: "unknown" as const, availability: "unknown" as const };
      const agency = /\b(?:recruitment|recruiting agency|staffing|executive search|headhunters?)\b|人力资源服务|猎头/i.test(item.company.title)
        || /\b(?:our|a) client (?:is (?:seeking|looking for|hiring)|seeks)\b|on behalf of our client|为客户招聘|代客户招|受客户委托/i.test(text);
      if (agency) {
        agencyLeads++;
        result.candidates.push({ ...brief, url: item.url, verification: "unverified-lead", verificationEvidence: "招聘机构或代招线索，实际用人企业待核实。" });
        return;
      }
      if (item.linkoutUrl !== null || !checked(item.company.url, "/company/") || !z.uuid().safeParse(item.company.id).success) {
        result.candidates.push({ ...brief, url: publicUrl(item.linkoutUrl) ?? item.url, verification: "unverified-lead" });
        return;
      }
      let organization = organizations.get(item.company.id);
      if (!organization) {
        organization = fetchJson(new URL("companies/" + item.company.id, endpoint)).then(data => companyPage.parse(data));
        organizations.set(item.company.id, organization);
      }
      const org = await organization;
      if (org.isHidden || org.id !== item.company.id || org.workableUid !== org.id || org.url !== item.company.url || org.title !== item.company.title || !text) {
        result.candidates.push({ ...brief, url: item.url, verification: "unverified-lead" }); return;
      }
      const extra = await workableCompanyBoard(org.id, org.title, org.url, execution.registeredSources ?? []);
      const companyWebsite = publicUrl(org.website);
      result.candidates.push({ ...brief, ...extra, ...(companyWebsite ? { companyWebsite } : {}), ...describeJobPreferences(text, item.company.title), url: item.url, description: text,
        verification: "official-detail", availability: "open", detailEvidenceUrl: new URL("jobs/" + item.id, endpoint).href, verificationEvidence: "已读取 Workable 职位详情与同一发布主体的招聘专页，招聘系统将该职位列为 published。" });
    } catch { context.throwIfCancelled(); readsFailed++; }
  });
  result.candidates.sort((a, b) => rankOfficialJob(b, input) - rankOfficialJob(a, input) || a.url.localeCompare(b.url));
  result.warnings.push(`Workable 本次按 ${terms.length} 项查询各读取最多 2 页，每页 20 条，按公司轮流核对最多 10 个职位详情。`);
  if (agencyLeads) result.warnings.push(`${agencyLeads} 条招聘机构或代招线索的实际用人企业待核实。`);
  if (readsFailed) result.warnings.push(`Workable 有 ${readsFailed} 次读取失败，覆盖不完整。`);
  return result;
}
