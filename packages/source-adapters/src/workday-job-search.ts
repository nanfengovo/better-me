import { deriveEntityId, includesSearchText, type SourceDefinition } from "@better-me/opportunities";
import { z } from "zod";
import { plainText, publicUrl } from "./adapters/common.js";
import { enumerateJobPostingUrls } from "./jobposting-enumeration.js";
import { discoveryRegion, discoveryRoleScore, matchedOfficialSkills, relatedOfficialSkills } from "./official-discovery-coverage.js";
import { resolveSourceCountryCode } from "./source-country.js";
import { describeJobPreferences } from "./official-job-preferences.js";
import { workdayBoardDirectory } from "./employer-group-evidence.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate, OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";
import type { OfficialJobDiscoveryExecution } from "./official-job-discovery.js";

export function workdayBoard(value: string) {
  if (!URL.canParse(value) || /[\\%](?:2f|2e|5c|25)|\\/i.test(value)) return;
  const url = new URL(value), host = /^([a-z0-9][a-z0-9-]{0,60})\.wd\d+\.myworkdayjobs\.com$/.exec(url.hostname);
  const match = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]{1,80})(?:\/|$)/.exec(url.pathname);
  if (!host || !match || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.search) return;
  const site = match[1]!, home = url.origin + "/" + site;
  return { tenant: host[1]!, site, home, sitemap: home + "/siteMap.xml", cxs: url.origin + "/wday/cxs/" + host[1] + "/" + site, prefix: "/" + site + "/job/" };
}
type Board = NonNullable<ReturnType<typeof workdayBoard>>;
function optionsFor(board: Board) {
  return { enumerationKind: "sitemap-urlset" as const, enumerationUrls: [board.sitemap], postingPathPrefixes: [board.prefix], pageSize: 5 };
}

export async function workdaySource(board: Board, company: string, priorities: string[] = []): Promise<SourceDefinition> {
  const host = new URL(board.home).hostname;
  return {
    sourceId: await deriveEntityId("source", ["workday-sitemap", board.home]), name: (company + " · Workday").slice(0, 240),
    adapterId: "jobposting-jsonld", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting",
    enabled: false, status: "needs-review", entryUrl: board.sitemap, remoteFilters: [],
    options: { ...optionsFor(board), companyName: company, ...(priorities.length ? { priorityPostingUrls: priorities.slice(0, 20) } : {}) },
    endpointPolicy: { allowedHosts: [host], allowedPathPrefixes: [new URL(board.sitemap).pathname, board.prefix], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: (company + " · Workday").slice(0, 240), homepageUrl: board.home, usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxPages: 3, maxRecords: 15, requestsPerMinute: 24 },
  };
}

const detail = z.object({
  jobPostingInfo: z.object({
    title: z.string().trim().min(1).max(1000), jobDescription: z.string().max(400_000), jobReqId: z.string().min(1).max(200),
    jobPostingSiteId: z.string(), externalUrl: z.string().max(4096), location: z.string().nullish(), additionalLocations: z.array(z.string()).nullish(),
    country: z.object({ descriptor: z.string() }).nullish(), canApply: z.boolean(), posted: z.boolean(), endDate: z.string().nullish(),
  }),
  hiringOrganization: z.object({ name: z.string().trim().min(1).max(500), url: z.string().nullish() }),
  similarJobs: z.array(z.object({ externalPath: z.string().max(3000) })).max(100).optional(),
});
const engineeringRole = /软件|开发|后端|全栈|前端|software|developer|back.?end|front.?end|full.?stack|programmer/i;
const techWords = /software|developer|development-engineer|程序员|软件|开发|dotnet|full-stack|automation-engineer/i;
const chinaLocations = /(?:\bChina\b|\bCN\b|中国|Shanghai|Suzhou|Beijing|Shenzhen|Guangzhou|Chengdu|Hangzhou|Wuxi|Nanjing|Wuhan|Xi.an|Chongqing|Tianjin|Dalian|Xiamen)/i;
function urlScore(url: string, input: DiscoverOfficialJobsInput, region: ReturnType<typeof discoveryRegion>) {
  const path = decodeURIComponent(new URL(url).pathname), words = path.replace(/[-_/]/g, " ");
  const near = region.city ? [region.city.name, ...region.city.aliases].some(alias => includesSearchText(words, alias)) : region.country === "CN" && chinaLocations.test(words);
  const role = (engineeringRole.test(input.role) && techWords.test(path)) || (input.role && includesSearchText(words, input.role));
  return (near ? 8 : 0) + (role ? 6 : 0) + (input.skills.some(skill => includesSearchText(words, skill)) ? 4 : 0);
}

async function workdayReader(board: Board, execution: OfficialJobDiscoveryExecution) {
  const { context, transport } = execution;
  const source = await workdaySource(board, board.tenant);
  const policy = { ...source, endpointPolicy: { ...source.endpointPolicy, allowedPathPrefixes: [...source.endpointPolicy.allowedPathPrefixes, new URL(board.cxs).pathname + "/job/"] } };
  return async (url: string, accept: string) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(6500)]);
    const response = await transport.request({ url, source: policy,
      context: { ...context, signal, throwIfCancelled() { context.throwIfCancelled(); signal.throwIfAborted(); } }, headers: { accept } });
    context.throwIfCancelled();
    if (response.url !== url || response.status !== 200 || response.text.length > 2 * 1024 * 1024) throw new Error("unavailable");
    return response.text;
  };
}

async function readWorkdayPosting(board: Board, url: string, input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution, read: Awaited<ReturnType<typeof workdayReader>>) {
  const path = new URL(url).pathname;
  if (!url.startsWith(board.home + "/job/") || !path.startsWith(board.prefix)) return { related: [] };
  const api = board.cxs + path.slice(board.site.length + 1);
  const data = detail.parse(JSON.parse(await read(api, "application/json"))), job = data.jobPostingInfo;
  if (job.jobPostingSiteId !== board.site || job.externalUrl !== url || !job.posted || !job.canApply
    || (job.endDate && Date.parse(job.endDate.slice(0, 10) + "T23:59:59Z") < Date.parse(execution.context.observedAt))) return { related: [] };
  const location = [job.location, ...(job.additionalLocations ?? [])].filter(Boolean).join(" / ");
  const description = plainText(job.jobDescription).slice(0, 60_000), company = data.hiringOrganization.name;
  const text = job.title + "\n" + description, region = discoveryRegion(input.region);
  const matchedSkills = matchedOfficialSkills(text, input), relatedSkills = relatedOfficialSkills(text, input);
  const roleHit = discoveryRoleScore(job.title, input) > 0;
  let candidate: OfficialJobDiscoveryCandidate | undefined;
  if (description && region.matches({ city: location, country: resolveSourceCountryCode(job.country?.descriptor ?? "") })
    && (input.skills.length ? input.skills.some(skill => matchedSkills.includes(skill)) || relatedSkills.length > 0 : roleHit)
    && (!engineeringRole.test(input.role) || roleHit)) {
    const companyWebsite = publicUrl(data.hiringOrganization.url);
    candidate = { url, title: job.title, company, jobId: job.jobReqId, description, location: location.slice(0, 5000), matchedSkills, relatedSkills,
      ...(companyWebsite ? { companyWebsite } : {}), verification: "official-detail", verificationEvidence: "企业招聘系统返回同一职位、招聘主体、正文，并明确接受申请。", detailEvidenceUrl: api,
      availability: "open", ...describeJobPreferences(description, company) };
  }
  const related = (data.similarJobs ?? []).flatMap(item => {
    if (!/^\/job\/(?:[\p{L}\p{N}_.~%-]+\/)*[\p{L}\p{N}_.~%-]+$/u.test(item.externalPath) || /(?:^|\/)\.{1,2}(?:\/|$)|%(?:25|2e|2f|5c)/i.test(item.externalPath)) return [];
    const href = board.home + item.externalPath;
    return urlScore(href, input, region) > 0 ? [href] : [];
  });
  return { candidate, related };
}

/** Resolve an actual search/link result on any public Workday tenant. */
export async function inspectDiscoveredWorkdayJob(value: string, input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution) {
  const board = workdayBoard(value);
  if (!board) return;
  const path = new URL(value).pathname.replace(/^\/[a-z]{2}-[A-Z]{2}\//, "/");
  if (!path.startsWith(board.prefix)) return;
  const url = new URL(board.home).origin + path;
  const read = await workdayReader(board, execution);
  const result = await readWorkdayPosting(board, url, input, execution, read);
  if (!result.candidate) return result;
  const existing = execution.registeredSources?.find(source => source.adapterId === "jobposting-jsonld" && source.entryUrl === board.sitemap);
  if (existing) result.candidate.sourceId = existing.sourceId;
  else {
    try {
      const manifest = enumerateJobPostingUrls(await read(board.sitemap, "application/xml, text/xml"), board.sitemap, optionsFor(board));
      if (manifest.urls.length) result.candidate.sourceProposal = await workdaySource(board, result.candidate.company!, manifest.urls.includes(url) ? [url] : []);
    } catch { execution.context.throwIfCancelled(); }
  }
  return result;
}

async function searchBoard(board: Board, input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution) {
  const { context } = execution;
  const read = await workdayReader(board, execution);
  const manifest = enumerateJobPostingUrls(await read(board.sitemap, "application/xml, text/xml"), board.sitemap, optionsFor(board));
  const region = discoveryRegion(input.region);
  const score = (url: string) => urlScore(url, input, region);
  const queue = manifest.urls.map(url => ({ url, score: score(url) })).filter(hit => hit.score > 0);
  queue.sort((a,b) => b.score - a.score);
  const listed = new Set(manifest.urls);
  const attempted = new Set<string>(), found: OfficialJobDiscoveryCandidate[] = [];
  let failures = 0;
  async function inspect(url: string) {
    const result = await readWorkdayPosting(board, url, input, execution, read);
    if (result.candidate) found.push(result.candidate);
    return result.related;
  }
  async function wave(urls: string[]) {
    const batch = [...new Set(urls)].filter(url => !attempted.has(url)).slice(0, 4);
    batch.forEach(url => attempted.add(url));
    const responses = await Promise.allSettled(batch.map(inspect));
    context.throwIfCancelled();
    failures += responses.filter(item => item.status === "rejected").length;
    return responses.flatMap(item => item.status === "fulfilled" ? item.value : []);
  }
  const related = await wave(queue.slice(0, 4).map(item => item.url));
  await wave([...new Set([...related, ...queue.slice(4, 8).map(item => item.url)])].sort((a,b) => score(b) - score(a)));
  const prior = execution.registeredSources?.find(source => source.adapterId === "jobposting-jsonld" && source.entryUrl === board.sitemap);
  const proposals = new Map<string, SourceDefinition>();
  for (const job of found) {
    if (prior) { job.sourceId = prior.sourceId; continue; }
    const company = job.company!;
    let proposal = proposals.get(company);
    if (!proposal) {
      proposal = await workdaySource(board, company, found.filter(hit => hit.company === company && listed.has(hit.url)).map(hit => hit.url).sort());
      proposals.set(company, proposal);
    }
    job.sourceProposal = proposal;
  }
  return { found, failures };
}

export async function discoverWorkdayJobs(input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const stored = (execution.registeredSources ?? []).map(source => source.entryUrl ?? "").flatMap(url => workdayBoard(url)?.home ?? []);
  const boards = [...new Set([...stored.slice(0, 3), ...workdayBoardDirectory])].map(url => workdayBoard(url)!);
  const responses = await Promise.allSettled(boards.map(board => searchBoard(board, input, execution)));
  execution.context.throwIfCancelled();
  const completed = responses.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
  const missing = boards.length - completed.length, failed = completed.reduce((n, board) => n + board.failures, 0);
  return { observedAt: execution.context.observedAt, status: completed.length ? "partial" : "provider-unavailable",
    queries: [`Workday · ${boards.length} 个企业招聘站 · ${[input.role, ...input.skills, input.region].filter(Boolean).join(" ").slice(0, 400)}`],
    candidates: completed.flatMap(board => board.found),
    warnings: [`Workday 按当前站点索引及职位关联链接，每站最多核对 8 个详情。${missing ? "有 " + missing + " 个站点未返回索引。" : ""}${failed ? failed + " 个职位详情未能读取。" : ""}`] };
}
