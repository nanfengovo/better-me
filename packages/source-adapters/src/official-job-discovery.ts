import { includesSearchText, normalizeSourceUrl, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext, SourceTransport } from "./contracts.js";
import { publicUrl } from "./adapters/common.js";
import { companyBoardFromOfficialJob, type CareerWebSearchProvider } from "./career-discovery.js";
import { CareerWebSearchResultSchema } from "./career-discovery-contracts.js";
import { createControlledSourceTransport, SourceTransportError } from "./transport.js";
import { inspectOfficialJobPage } from "./official-job-page.js";
import { discoveryRegion, interleaveEmployers, mapDiscoveryItems, officialQuerySkills } from "./official-discovery-coverage.js";
import { DiscoverOfficialJobsInputSchema, OfficialJobDiscoveryResultSchema, type DiscoverOfficialJobsInput, type OfficialJobDiscoveryCandidate, type OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";

export type OfficialJobDiscoveryExecution = {
  searchProvider?: CareerWebSearchProvider;
  context: SourceAdapterContext;
  transport: SourceTransport;
  /** Dynamic destinations always require a direct, DNS-pinned public-address transport. */
  detailTransport?: SourceTransport;
  registeredSources?: readonly SourceDefinition[];
};
const MAX_SEARCH_RESULTS = 12, MAX_DETAILS = 14;
function pagePolicy(url: URL): SourceDefinition {
  return {
    sourceId: "official-job-discovery", name: "公开职位原文", adapterId: "official-job-discovery", adapterVersion: "1",
    capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active",
    remoteFilters: [], endpointPolicy: { allowedHosts: [url.hostname], allowedPathPrefixes: [decodeURIComponent(url.pathname)], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "公开职位原文", requiresAttribution: true, usage: "link-only" },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: MAX_DETAILS, maxPages: 1, requestsPerMinute: 30 },
  };
}
function resultUrl(value: string): URL | undefined {
  const safe = publicUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (url.username || url.password || url.hostname.endsWith(".") || /\.(?:test|invalid)$/i.test(url.hostname) || /\\|%25|%2f|%5c/i.test(url.pathname)) return;
  try { decodeURIComponent(url.pathname); } catch { return; }
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) if (/^utm_|^gclid$|^fbclid$/i.test(key)) url.searchParams.delete(key);
  return url;
}
function buildQueries(input: DiscoverOfficialJobsInput): string[] {
  const role = input.role || undefined, primary = input.skills[0], secondary = input.secondarySkills?.[0];
  const join = (parts: Array<string | undefined>) => parts.filter(Boolean).join(" ").slice(0, 500);
  const place = discoveryRegion(input.region).english ?? input.region;
  const aliases = officialQuerySkills(input);
  const searchSkill = aliases.find(term => term === ".NET") ?? primary ?? role;
  return [...new Set([
    join([role, primary, input.region, "careers jobs 招聘"]),
    join([primary ?? role, input.region, input.preferForeignEmployer ? "multinational" : undefined, "job description responsibilities careers"]),
    join([role, input.skills[1] ?? secondary, input.region, input.preferLowTravel ? "travel" : undefined, "招聘 职位描述"]),
    join([searchSkill, place, "site:jobs.smartrecruiters.com"]),
    join([searchSkill, place, "site:myworkdayjobs.com"]),
    join([primary ?? role, place, "developer careers apply"]),
  ])];
}
export function rankOfficialJob(candidate: OfficialJobDiscoveryCandidate, input: DiscoverOfficialJobsInput): number {
  const primaryHits = candidate.matchedSkills.filter(skill => input.skills.includes(skill)).length;
  return (candidate.verification === "official-detail" ? 10000 : 0)
    + (candidate.availability === "open" ? 100 : 0)
    + (input.region && candidate.location && includesSearchText(candidate.location, input.region) ? 200 : 0)
    + (input.preferLowTravel ? ({ "not-required": 45, "low-frequency": 15, mentioned: 0, unknown: 0, required: -45 }[candidate.travel]) : 0)
    + (input.preferForeignEmployer && (candidate.employerNature === "foreign-disclosed" || candidate.employerGroup) ? 50 : 0)
    + 20 * primaryHits + candidate.matchedSkills.length;
}

/** Searches for positions before employer names are known. This operation registers no sources or jobs. */
export async function discoverOfficialJobs(raw: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const input = DiscoverOfficialJobsInputSchema.parse(raw), { context, searchProvider, transport } = execution;
  const result: OfficialJobDiscoveryResult = { observedAt: context.observedAt, queries: [], candidates: [], status: "complete", warnings: [] };
  context.throwIfCancelled();
  if (!searchProvider) return { ...result, status: "provider-unavailable", warnings: ["网页搜索未配置，尚未查询公开职位。"] };
  const details = execution.detailTransport ?? createControlledSourceTransport({ allowFakeIp: false });
  let searchFailures = 0;
  result.queries = buildQueries(input);
  const searchResults = await mapDiscoveryItems(result.queries, 3, async query => {
    context.throwIfCancelled();
    try {
      const supplied = await searchProvider.search({ query, companyName: "", limit: MAX_SEARCH_RESULTS, context, transport,
        source: pagePolicy(new URL("https://html.duckduckgo.com/html/")) });
      const response = CareerWebSearchResultSchema.parse(supplied);
      const hits = response.results.flatMap(item => {
        const url = resultUrl(item.url);
        return url ? [{ url, title: item.title?.trim() || url.hostname }] : [];
      });
      if (response.partial) result.status = "partial";
      return hits;
    } catch {
      context.throwIfCancelled();
      searchFailures++;
      return [];
    }
  });
  if (searchFailures) {
    result.status = searchFailures === result.queries.length ? "provider-unavailable" : "partial";
    result.warnings.push(`${searchFailures} 次网页搜索未完成，无法据此判断是否有岗位。`);
  }
  const unique = new Map<string, { url: URL; title: string }>();
  // Interleave queries so a single search's first page cannot consume all detail reads.
  for (let i = 0; i < MAX_SEARCH_RESULTS; i++) for (const hits of searchResults) {
    const hit = hits[i]; if (!hit) continue;
    const key = normalizeSourceUrl(hit.url.href);
    if (!unique.has(key)) unique.set(key, hit);
  }
  const hits = interleaveEmployers(Array.from(unique.values()), hit => {
    const host = hit.url.hostname;
    // Several employers can share an ATS hostname; their first path segment identifies the board.
    return /(?:smartrecruiters\.com|greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(host) ? host + "/" + hit.url.pathname.split("/")[1] : host;
  });
  let unavailable = 0;
  if (hits.length > MAX_DETAILS) { result.status = "partial"; result.warnings.push(`本次最多核对 ${MAX_DETAILS} 个不同的详情地址。`); }
  const candidates = new Map<string, OfficialJobDiscoveryCandidate>();
  let unrelated = 0, regionConflicts = 0;
  const inspected = await mapDiscoveryItems(hits.slice(0, MAX_DETAILS), 4, async ({ url, title }) => {
    context.throwIfCancelled();
    let candidate: OfficialJobDiscoveryCandidate | undefined;
    try {
      const response = await details.request({ url: url.href, source: pagePolicy(url), context, headers: { accept: "text/html,application/xhtml+xml" } });
      if ([404, 410].includes(response.status)) { unavailable++; return; }
      const mime = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (response.status !== 200 || response.url !== url.href || (mime && !["text/html","application/xhtml+xml"].includes(mime)) || Buffer.byteLength(response.text) > 2 * 1024 * 1024) throw new Error("unverified");
      const record = inspectOfficialJobPage(response.text, url, input, execution.registeredSources ?? [], result.observedAt);
      if (record === "closed") { unavailable++; return; }
      if (record === "different-region") { regionConflicts++; return; }
      candidate = record;
    } catch (error) {
      context.throwIfCancelled();
      if (error instanceof SourceTransportError) {
        if (error.status === 404 || error.status === 410) { unavailable++; return; }
        if (error.code === "unsafe-endpoint") { result.status = "partial"; return; }
      }
    }
    if (!candidate) candidate = { url: url.href, title: title.slice(0, 1000), verification: "unverified-lead", matchedSkills: [], travel: "unknown", availability: "unknown" };
    if (candidate.verification === "official-detail" && (input.skills.length
      ? !candidate.matchedSkills.some(skill => input.skills.includes(skill)) && !candidate.relatedSkills?.length
      : !input.role || !includesSearchText(candidate.title + " " + (candidate.description ?? ""), input.role))) {
      unrelated++; return;
    }
    Object.assign(candidate, await companyBoardFromOfficialJob(candidate, execution.registeredSources));
    return candidate;
  });
  for (const candidate of inspected) {
    if (!candidate) continue;
    const identity = candidate.company && candidate.jobId ? JSON.stringify([candidate.company.toLowerCase(), candidate.jobId]) : normalizeSourceUrl(candidate.url);
    const prior = candidates.get(identity);
    if (!prior || rankOfficialJob(candidate, input) > rankOfficialJob(prior, input)) candidates.set(identity, candidate);
    else if (!prior.sourceId && !prior.sourceProposal && candidate.verification === "official-detail") {
      if (candidate.sourceId) prior.sourceId = candidate.sourceId;
      else if (candidate.sourceProposal) prior.sourceProposal = candidate.sourceProposal;
    }
  }
  context.throwIfCancelled();
  result.candidates = [...candidates.values()];
  const unresolved = result.candidates.filter(item => item.verification === "unverified-lead").length;
  if (regionConflicts) result.warnings.push(`${regionConflicts} 个职位明确披露的工作地点与目标地区不符，已排除。`);
  if (unrelated) result.warnings.push(`${unrelated} 个职位原文未命中岗位方向或技能，已排除。`);
  if (input.preferForeignEmployer && result.candidates.length) result.warnings.push("企业性质仅按招聘方原文自述标注，实际控股方仍需核实。");
  if (unavailable) result.warnings.push(`${unavailable} 个结果已过期、关闭或详情不存在，已排除。`);
  if (unresolved) { result.status = "partial"; result.warnings.push(`${unresolved} 个页面仍待核对招聘方归属或职位原文。`); }
  result.candidates.sort((a,b) => rankOfficialJob(b,input) - rankOfficialJob(a,input));
  return OfficialJobDiscoveryResultSchema.parse(result);
}
