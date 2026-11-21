import { includesSearchText, type SourceDefinition } from "@better-me/opportunities";
import { z } from "zod";
import { plainText } from "./adapters/common.js";
import { companyBoardFromOfficialJob } from "./career-discovery.js";
import { discoveryRegion, discoveryRoleScore, interleaveEmployers, mapDiscoveryItems, matchedOfficialSkills, officialQuerySkills, relatedOfficialSkills } from "./official-discovery-coverage.js";
import type { OfficialJobDiscoveryExecution } from "./official-job-discovery.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate, OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";
import { describeJobPreferences } from "./official-job-preferences.js";

const searchUrl = "https://jobs.smartrecruiters.com/sr-jobs/search";
const api = "https://api.smartrecruiters.com/v1/companies/";
const globalSource: SourceDefinition = {
  sourceId: "discovery-smartrecruiters-public", adapterId: "smartrecruiters-search", adapterVersion: "1", name: "SmartRecruiters",
  entityType: "job-posting", capabilities: ["discover-sources"], runtime: ["local-service"], enabled: true, status: "active", remoteFilters: ["roles"],
  endpointPolicy: { allowedHosts: ["jobs.smartrecruiters.com", "api.smartrecruiters.com"], allowedPathPrefixes: ["/sr-jobs/search", "/v1/companies/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "SmartRecruiters", homepageUrl: "https://jobs.smartrecruiters.com/", requiresAttribution: true, usage: "link-only" },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxPages: 25, maxRecords: 100, requestsPerMinute: 100 },
};
const listing = z.object({
  id: z.string().regex(/^\d{1,30}$/), name: z.string().trim().min(1).max(1000),
  company: z.object({ identifier: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i), name: z.string().trim().min(1).max(500) }),
  location: z.object({ country: z.string().optional(), city: z.string().optional(), region: z.string().optional(), fullLocation: z.string().optional() }),
});
type Listing = z.infer<typeof listing>;
const page = z.object({ content: z.array(z.unknown()).max(100) });
const section = z.object({ text: z.string().max(160_000).optional() }).optional();
const detail = listing.extend({ postingUrl: z.string(), active: z.literal(true), visibility: z.literal("PUBLIC"), jobAd: z.object({
  sections: z.object({ companyDescription: section, jobDescription: section, qualifications: section, additionalInformation: section }),
}) });

/** Discover employer IDs from the public cross-company board, then query those employers' published lists and verify the same employer/ID in the detail. */
export async function discoverSmartRecruitersJobs(input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const { context, transport } = execution;
  const result: OfficialJobDiscoveryResult = { observedAt: context.observedAt, status: "partial", candidates: [], queries: [], warnings: [] };
  const region = discoveryRegion(input.region);
  const skills = officialQuerySkills(input);
  const searchLocale = region.city?.platforms.linkedin?.split(",")[0]?.trim() ?? region.english;
  const boardKeywords = [...new Set([searchLocale, input.role || skills[0], skills[0]].filter((value): value is string => !!value))].slice(0, 3);
  const tenantTerms = [...new Set([...(skills.includes(".NET") ? [".NET"] : []), ...skills, input.role].filter(Boolean))].slice(0, 2);
  const suffix = input.region ? " · " + input.region : "";
  result.queries.push(...boardKeywords.map(term => "SmartRecruiters · " + term), ...tenantTerms.map(term => "SmartRecruiters 企业职位 · " + term + suffix));
  let failures = 0, loaded = 0;
  async function json(url: URL): Promise<unknown> {
    context.throwIfCancelled();
    const res = await transport.request({ url: url.href, context, source: globalSource, headers: { accept: "application/json" } });
    if (res.status !== 200 || res.url !== url.href || !res.headers["content-type"]?.includes("application/json")) throw new Error("unavailable");
    return JSON.parse(res.text);
  }
  async function list(url: URL, tenant?: string) {
    try {
      const records = page.parse(await json(url)).content;
      loaded++;
      return records.flatMap(raw => {
        const item = listing.safeParse(raw);
        return item.success && (!tenant || item.data.company.identifier === tenant) && region.matches(item.data.location) ? [item.data] : [];
      });
    } catch { context.throwIfCancelled(); failures++; return []; }
  }
  const publicLists = await mapDiscoveryItems(boardKeywords, 3, term => {
    const url = new URL(searchUrl);
    url.searchParams.set("keyword", term);
    url.searchParams.set("limit", "100");
    return list(url);
  });
  if (!loaded) return { ...result, status: "provider-unavailable", warnings: ["SmartRecruiters 跨企业公开搜索暂时不可用。"] };
  const titleScore = (job: Listing) => discoveryRoleScore(job.name, input) + (skills.some(skill => includesSearchText(job.name, skill)) ? 16 : 0);
  const indexed = publicLists.flat().sort((a, b) => titleScore(b) - titleScore(a));
  const tenants = [...new Set(indexed.map(job => job.company.identifier))].slice(0, 8);
  const scoped = await mapDiscoveryItems(tenants.flatMap(tenant => tenantTerms.map(term => ({ tenant, term }))), 5, ({ tenant, term }) => {
    const url = new URL(tenant + "/postings", api);
    url.searchParams.set("q", term);
    url.searchParams.set("limit", "30");
    if (region.country) url.searchParams.set("country", region.country.toLowerCase());
    return list(url, tenant);
  });
  const byId = new Map<string, { job: Listing; weight: number }>();
  // A keyword on the global board can match a location or employer name. A scoped hit is a better detail candidate.
  for (const [list, bonus] of [[indexed, 0], [scoped.flat(), 5]] as const) for (const job of list) {
    const key = job.company.identifier + "/" + job.id;
    const weight = titleScore(job) + bonus;
    if (weight && (!byId.has(key) || weight > byId.get(key)!.weight)) byId.set(key, { job, weight });
  }
  const ranked = [...byId.values()].sort((a, b) => b.weight - a.weight);
  // Reserve a place for actual target-role candidates before scanning incidental matches in other departments.
  const first = interleaveEmployers(ranked.filter(({ job }) => titleScore(job) >= 6), item => item.job.company.identifier);
  const positions = [...new Set([...first.slice(0, 7), ...interleaveEmployers(ranked, item => item.job.company.identifier)])].slice(0, 14);
  const checked = await mapDiscoveryItems(positions, 5, async ({ job }): Promise<OfficialJobDiscoveryCandidate | undefined> => {
    const tenant = job.company.identifier;
    const url = new URL(tenant + "/postings/" + job.id, api);
    try {
      const parsed = detail.safeParse(await json(url));
      if (!parsed.success) return;
      const record = parsed.data;
      if (record.id !== job.id || record.company.identifier !== tenant || record.company.name !== job.company.name || !region.matches(record.location)) return;
      const posting = new URL(record.postingUrl), path = "/" + tenant + "/" + job.id;
      if (posting.origin !== "https://jobs.smartrecruiters.com" || posting.username || posting.password || posting.hash
        || !(posting.pathname === path || posting.pathname.startsWith(path + "-")) || posting.pathname.slice(path.length).includes("/")) return;
      const sections = record.jobAd.sections;
      const duties = plainText(sections.jobDescription?.text), requirements = plainText(sections.qualifications?.text);
      if (!duties && !requirements) return;
      const relevant = [record.name, duties, requirements].join("\n");
      const matched = matchedOfficialSkills(relevant, input);
      const relatedSkills = relatedOfficialSkills(relevant, input);
      if (input.skills.length ? !matched.some(item => input.skills.includes(item)) && !relatedSkills.length : !discoveryRoleScore(record.name, input)) return;
      if (/\b(?:on behalf of our client|our client is (?:seeking|hiring)|staffing agency)\b|代客户招|为客户招聘/i.test(relevant)) return;
      const description = [plainText(sections.companyDescription?.text), duties, requirements, plainText(sections.additionalInformation?.text)].filter(Boolean).join("\n\n").slice(0, 60_000);
      const company = record.company.name;
      const board = await companyBoardFromOfficialJob({ verification: "official-detail", url: posting.href, company }, execution.registeredSources);
      const located = record.location;
      return { url: posting.href, company, jobId: record.id, title: record.name, description, matchedSkills: matched, ...(relatedSkills.length ? { relatedSkills } : {}), ...board,
        location: (located.fullLocation || [located.city, located.region, located.country].filter(Boolean).join(", ")).slice(0, 5000),
        ...describeJobPreferences(description, company), verification: "official-detail", availability: "open", detailEvidenceUrl: url.href,
        verificationEvidence: "SmartRecruiters 企业租户与岗位编号一致，招聘系统的职位详情目前标为 active、PUBLIC。" };
    } catch { context.throwIfCancelled(); failures++; return; }
  });
  result.candidates = checked.filter((candidate): candidate is OfficialJobDiscoveryCandidate => !!candidate);
  result.warnings.push("SmartRecruiters 本次从公开索引发现 " + tenants.length + " 家公司并查询其招聘目录，抽查 " + positions.length + " 个职位详情。");
  if (failures) result.warnings.push("SmartRecruiters 有 " + failures + " 次读取失败，覆盖不完整。");
  return result;
}

