import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { deriveEntityId, includesSearchText, normalizeSourceUrl, type SourceDefinition } from "@better-me/opportunities";
import { publicUrl } from "./adapters/common.js";
import { CareerWebSearchResultSchema } from "./career-discovery-contracts.js";
import { companyBoardFromOfficialJob } from "./career-discovery.js";
import { discoveryRegion, discoveryRoleScore, interleaveEmployers, mapDiscoveryItems, officialQuerySkills } from "./official-discovery-coverage.js";
import type { OfficialJobDiscoveryExecution } from "./official-job-discovery.js";
import { rankOfficialJob } from "./official-job-discovery.js";
import { inspectOfficialJobPage } from "./official-job-page.js";
import { readJobPostingJsonLd } from "./jobposting-jsonld-reader.js";
import { validateJobPostingJsonLdSource } from "./jobposting-jsonld-contracts.js";
import { enumerateJobPostingUrls } from "./jobposting-enumeration.js";
import { inspectDiscoveredWorkdayJob, workdayBoard } from "./workday-job-search.js";
import { discoverEmployerBackground } from "./discovered-employer-background.js";
import { withEmployerGroupEvidence } from "./employer-group-evidence.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate, OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";

const maxPages = 28;
const maxQueued = 240;
const maxVisited = 360;
const maxRounds = 16;
const directoryOrigin = "https://jobseveryhour.com";

type Link = { url: string; label: string; id?: string; company?: string };
type Lead = { url: string; label: string; depth: number; priority: number; evidenceUrl?: string; company?: string };
type Listing = { url: string; links: string[]; kind: "html-list" | "sitemap-urlset" };
export type WebJobDiscoveryState = {
  round: number;
  queued: Lead[];
  visited: Set<string>;
  knownCompanies: Set<string>;
  knownJobs: Map<string, OfficialJobDiscoveryCandidate>;
  structuredJobs: Set<string>;
  listings: Map<string, Listing>;
  searched: Set<string>;
  backgroundChecked: Set<string>;
  searchUnavailableUntil?: number;
  searchOffset?: number;
  /** Explicit closure observed in the latest batch; timeouts and unreadable pages never imply closure. */
  closedUrls?: string[];
};
const identity = (job: OfficialJobDiscoveryCandidate) => normalizeSourceUrl(job.url);
const companyKey = (company?: string) => company?.normalize("NFKC").trim().toLowerCase() ?? "";
const employerKey = (lead: Lead) => lead.company ? companyKey(lead.company) : new URL(lead.url).origin;
const isDirectory = (url: string) => new URL(url).origin === directoryOrigin;

function safeLink(value: string, base?: string): string | undefined {
  if (!value || value.length > 4096 || /[\\\s\p{Cc}]/u.test(value) || /%(?:25|2e|2f|5c)/i.test(value.split(/[?#]/, 1)[0]!)) return;
  try {
    const url = new URL(value, base);
    url.hash = "";
    if (url.username || url.password || url.hostname.endsWith(".") || /\.(?:test|invalid)$/i.test(url.hostname)) return;
    // Collect and navigate to public vacancy pages only. Do not visit application
    // forms, sign-in routes, arbitrary downloads or executable URL schemes.
    if (/\/(?:login|signin|sign-in|register|apply|application|account|unsubscribe)(?:\/|$)/i.test(url.pathname)
      || /\.(?:zip|exe|dmg|pdf|docx|xlsx|png|jpg|js|css)$/i.test(url.pathname)) return;
    return publicUrl(normalizeSourceUrl(url.href));
  } catch { return undefined; }
}

function policy(url: string): SourceDefinition {
  const target = new URL(url);
  return {
    sourceId: "agent-public-careers", name: "公开招聘网页", adapterId: "agent-public-careers", adapterVersion: "1",
    capabilities: ["discover-sources"], entityType: "company-directory", runtime: ["local-service"], status: "active", enabled: true,
    remoteFilters: [], endpointPolicy: { allowedHosts: [target.hostname], allowedPathPrefixes: [decodeURIComponent(target.pathname)], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: target.hostname, usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 1, requestsPerMinute: 30 },
  };
}

export function readCareerLinks(html: string, pageUrl: string): Link[] {
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) return [];
  const root = parse(html, { scriptingEnabled: true });
  const skip = new Set(["script", "style", "template", "noscript", "svg", "iframe", "object", "textarea"]);
  type Node = DefaultTreeAdapterTypes.Node;
  type Element = DefaultTreeAdapterTypes.Element;
  const attr = (el: Element, name: string) => el.attrs.find(a => a.name === name)?.value;
  const ignored = (node: Node) => "tagName" in node && (skip.has(node.tagName) || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true");
  const content = (root: Node) => {
    const pending = [root], parts: string[] = [];
    for (let count = 0; pending.length && count < 300; count++) {
      const node = pending.pop()!;
      if (ignored(node)) continue;
      if ("value" in node && node.nodeName === "#text") parts.push(node.value);
      else if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 1200);
  };
  const result: Link[] = [], pending = [root as Node], seen = new Set<string>();
  for (let count = 0; pending.length && count < 50_000 && result.length < 1600; count++) {
    const node = pending.pop()!;
    if (ignored(node)) continue;
    if ("tagName" in node && node.tagName === "link" && attr(node, "rel")?.toLowerCase() === "sitemap") {
      const href = attr(node, "href"), url = href && safeLink(href, pageUrl);
      if (url && !seen.has(url)) { seen.add(url); result.push({ url, label: "sitemap" }); }
    } else if ("tagName" in node && node.tagName === "a") {
      const href = attr(node, "href"), url = href && safeLink(href, pageUrl);
      if (url && !seen.has(url)) {
        seen.add(url);
        const label = content(node), id = attr(node, "id");
        // The public directory supplies its employer in a separate visible span.
        const company = isDirectory(pageUrl) && node.childNodes.flatMap(child => "childNodes" in child ? child.childNodes : [])
          .find(child => "tagName" in child && attr(child, "class")?.split(/\s+/).includes("js"));
        result.push({ url, label, ...(id ? { id } : {}), ...(company ? { company: content(company).split("·")[0]?.trim() } : {}) });
      }
    } else if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  return result;
}

const careerWords = /careers?|\bjobs?\b|vacanc|openings|opportunit|recruit|招聘|岗位|职位|加入我们/i;
const agencyWords = /\b(?:recruitment agency|staffing agency|headhunter)\b|代客户招聘|猎头/i;
function queue(state: WebJobDiscoveryState, leads: Lead[]) {
  const known = new Set([...state.visited, ...state.queued.map(item => item.url)]);
  for (const lead of leads) {
    if (state.queued.length >= maxQueued || lead.depth > 4 || known.has(lead.url)) continue;
    state.queued.push(lead); known.add(lead.url);
  }
}
function countryDirectory(input: DiscoverOfficialJobsInput) {
  const { country } = discoveryRegion(input.region);
  if (!country) return undefined;
  const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
  const slug = name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? directoryOrigin + "/locations/" + slug + "/" : undefined;
}

export function createWebJobDiscoveryState(input: DiscoverOfficialJobsInput, seed: OfficialJobDiscoveryResult): WebJobDiscoveryState {
  const state: WebJobDiscoveryState = { round: 0, queued: [], searched: new Set(seed.queries), visited: new Set(), knownCompanies: new Set(),
    knownJobs: new Map(), structuredJobs: new Set(), listings: new Map(), backgroundChecked: new Set() };
  for (const job of seed.candidates) {
    if (job.verification === "official-detail") {
      state.knownJobs.set(identity(job), job);
      state.knownCompanies.add(companyKey(job.company));
      if (job.sourceId || job.sourceProposal) state.visited.add(identity(job));
      else {
        const url = safeLink(job.url);
        const website = job.companyWebsite && safeLink(job.companyWebsite);
        if (url) queue(state, [{ url, label: job.title, depth: 0, priority: 40, company: job.company }]);
        if (website) queue(state, [{ url: website, label: job.company ?? "", depth: 0, priority: 15, company: job.company }]);
      }
    } else {
      const url = safeLink(job.url);
      if (url) queue(state, [{ url, label: job.title, depth: 0, priority: 1 }]);
    }
  }
  const directory = countryDirectory(input);
  if (directory) queue(state, [{ url: directory, label: "Public job directory", depth: 0, priority: 1000 }]);
  return state;
}
export function canExpandWebDiscovery(state: WebJobDiscoveryState) {
  return state.round < maxRounds && state.visited.size < maxVisited;
}

/** Resume-derived phrases only; higher rounds change primary terms and job families and revisit more search pages. */
function searchPlan(input: DiscoverOfficialJobsInput, state: WebJobDiscoveryState) {
  const aliases = officialQuerySkills(input);
  const softwareRole = discoveryRoleScore("software engineer", input) > 0;
  const roles = [...new Set([input.role, ...(softwareRole ? ["software engineer", "software developer", "backend engineer", "full stack developer", "application engineer", "automation software engineer"] : [])].filter(Boolean))];
  const place = discoveryRegion(input.region).english ?? input.region;
  const needsBoard = [...state.knownJobs.values()].find(job => job.verification === "official-detail" && job.company && !job.sourceId && !job.sourceProposal
    && !state.searched.has([job.company, place, "official careers"].filter(Boolean).join(" ").slice(0, 500)));
  if (needsBoard) return { query: [needsBoard.company, place, "official careers"].filter(Boolean).join(" ").slice(0, 500), page: 1 };
  const terms = aliases.length ? aliases : [undefined];
  const titles = roles.length ? roles : [undefined];
  // Reduce repeat hits from previously examined unrelated domains. Do not
  // exclude shared recruitment hosts that still contain unexplored employers.
  const successfulHosts = new Set([...state.knownJobs.values()].filter(job => job.verification === "official-detail").map(job => new URL(job.url).hostname));
  const counts = new Map<string, number>();
  for (const visited of state.visited) {
    const url = new URL(visited);
    if (url.origin !== directoryOrigin && !successfulHosts.has(url.hostname) && !workdayBoard(visited)
      && !/(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/.test(url.hostname))
      counts.set(url.hostname, (counts.get(url.hostname) ?? 0) + 1);
  }
  const excluded = [...counts].filter(([, count]) => count >= 3).sort((a,b) => b[1] - a[1]).slice(0, 4).map(([host]) => "-site:" + host);
  const plans = titles.flatMap(role => terms.flatMap(skill => [
    [skill, role, place, "careers job openings"], [role, skill, input.region, "招聘 职位 官网"],
    [role, skill, place, input.preferForeignEmployer ? "international company official careers" : "careers apply online"],
  ].map(parts => [...parts, ...excluded].filter(Boolean).join(" ").slice(0, 500))));
  const offset = (state.searchOffset ?? 0) % Math.max(1, plans.length);
  const orderedPlans = [...plans.slice(offset), ...plans.slice(0, offset)];
  const query = orderedPlans.find(value => value && !state.searched.has(value));
  if (!query) {
    const next = orderedPlans[(state.round - 1) % plans.length];
    return next ? { query: next, page: Math.min(20, 2 + Math.floor(state.round / Math.max(1, plans.length))) } : undefined;
  }
  return { query, page: 1 };
}

function priority(label: string, input: DiscoverOfficialJobsInput) {
  const skills = officialQuerySkills(input), region = discoveryRegion(input.region);
  const local = region.city && [region.city.name, ...region.city.aliases].some(alias => includesSearchText(label, alias));
  return (local ? 20 : 0) + skills.filter(skill => includesSearchText(label, skill)).length * 40 + discoveryRoleScore(label, input) * 2;
}

async function readPage(lead: Lead, execution: OfficialJobDiscoveryExecution) {
  const { context } = execution;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(6500)]);
  const scoped = { ...context, signal, throwIfCancelled() { context.throwIfCancelled(); signal.throwIfAborted(); } };
  // Known public directory requests use the configured network transport. Any newly
  // discovered web server uses the same DNS-pinned public detail transport as official discovery.
  const transport = isDirectory(lead.url) ? execution.transport : execution.detailTransport;
  if (!transport) throw new Error("public detail transport unavailable");
  const sitemap = /\.xml$/i.test(new URL(lead.url).pathname);
  const response = await transport.request({ url: lead.url, source: policy(lead.url), context: scoped, headers: { accept: sitemap ? "application/xml,text/xml" : "text/html,application/xhtml+xml" } });
  context.throwIfCancelled();
  const mime = response.headers["content-type"]?.split(";")[0]?.trim();
  if (response.status !== 200 || response.url !== lead.url || Buffer.byteLength(response.text) > 2 * 1024 * 1024
    || (mime && !(sitemap ? ["application/xml", "text/xml"] : ["text/html", "application/xhtml+xml"]).includes(mime))) throw new Error("unavailable");
  return response.text;
}

function directoryLeads(lead: Lead, links: Link[], input: DiscoverOfficialJobsInput): Lead[] {
  const path = new URL(lead.url).pathname;
  if (path.startsWith("/locations/")) {
    // Follow the directory's actual role/location intersections, never synthesize employer names.
    const suffix = path.split("/").filter(Boolean).at(-1);
    const selected = links.filter(link => isDirectory(link.url) && new URL(link.url).pathname.startsWith("/roles/")
      && new URL(link.url).pathname.endsWith("/" + suffix + "/"))
      .map(link => ({ link, score: priority(link.label, input) + priority(new URL(link.url).pathname.split("/")[2]!.replace(/-/g, " "), input) }))
      .filter(item => item.score > 0).sort((a,b) => b.score - a.score).slice(0, 6);
    return selected.map(({ link, score }) => ({ ...link, depth: lead.depth + 1, priority: 80 + score, evidenceUrl: lead.url }));
  }
  if (path.startsWith("/roles/")) {
    const hits = links.filter(link => isDirectory(link.url) && new URL(link.url).pathname.startsWith("/job/"))
      .map(link => ({ ...link, depth: lead.depth + 1, priority: priority(link.label, input), evidenceUrl: lead.url }))
      .filter(link => link.priority > 0).sort((a,b) => b.priority - a.priority);
    return interleaveEmployers(hits, employerKey).slice(0, 40).map(link => ({ ...link, priority: 130 + link.priority }));
  }
  if (path.startsWith("/job/")) {
    // This is a lead index, not origin evidence. Read only the employer's own URL
    // explicitly published as the destination of its "Apply on company site" link.
    return links.filter(link => !isDirectory(link.url) && (link.id === "apply" || /^apply on company site$/i.test(link.label)))
      .slice(0, 1).map(link => ({ ...link, company: lead.company, depth: lead.depth + 1, priority: lead.priority + 150, evidenceUrl: lead.url }));
  }
  return [];
}

function linkedCareers(lead: Lead, links: Link[], input: DiscoverOfficialJobsInput) {
  const origin = new URL(lead.url).origin;
  return links.filter(link => link.url !== lead.url && (careerWords.test(link.label + " " + new URL(link.url).pathname)
    || new URL(link.url).origin === origin && /sitemap.*\.xml$/i.test(new URL(link.url).pathname))
    && (new URL(link.url).origin === origin || !!workdayBoard(link.url) || /^(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|jobs\.smartrecruiters\.com)$/.test(new URL(link.url).hostname)
      || /^(?:careers?|jobs?|招聘|职位|查看.*岗位|join us)$/i.test(link.label)))
    .map(link => ({ ...link, depth: lead.depth + 1, priority: priority(link.label, input) + 8, evidenceUrl: lead.evidenceUrl ?? lead.url }))
    .sort((a,b) => b.priority - a.priority).slice(0, 24);
}

async function collectionProposal(candidate: OfficialJobDiscoveryCandidate, state: WebJobDiscoveryState, execution: OfficialJobDiscoveryExecution) {
  if (candidate.sourceId || candidate.sourceProposal || candidate.verification !== "official-detail") return;
  // Generic recurring collection is possible when a public career directory really
  // enumerates this JSON-LD posting and the adapter can read that same URL again.
  const posting = new URL(candidate.url), prefix = decodeURIComponent(posting.pathname.slice(0, posting.pathname.lastIndexOf("/") + 1));
  if (!prefix || prefix === "/") return;
  for (const listing of state.listings.values()) {
    if (new URL(listing.url).origin !== posting.origin || !listing.links.includes(candidate.url)) continue;
    const existing = execution.registeredSources?.find(source => source.adapterId === "jobposting-jsonld" && source.entryUrl === listing.url);
    if (existing) { candidate.sourceId = existing.sourceId; return; }
    const label = (candidate.company + " · 官网招聘").slice(0, 240);
    const source: SourceDefinition = {
      sourceId: await deriveEntityId("source", ["public-careers", listing.url]), name: label, adapterId: "jobposting-jsonld",
      adapterVersion: "1", capabilities: ["list-jobs"], entityType: "job-posting", runtime: ["local-service"], enabled: false, status: "needs-review", remoteFilters: [],
      entryUrl: listing.url, options: { companyName: candidate.company!, enumerationKind: listing.kind, enumerationUrls: [listing.url], postingPathPrefixes: [prefix], pageSize: 5, priorityPostingUrls: [candidate.url] },
      endpointPolicy: { allowedHosts: [posting.hostname], allowedPathPrefixes: [decodeURIComponent(new URL(listing.url).pathname), prefix], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
      attribution: { label, homepageUrl: listing.url, requiresAttribution: true, usage: "link-only" },
      refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxPages: 4, maxRecords: 20, requestsPerMinute: 15 },
    };
    try { validateJobPostingJsonLdSource(source); candidate.sourceProposal = source; return; } catch { /* An unsupported directory remains a link. */ }
  }
}

export async function expandWebJobDiscovery(input: DiscoverOfficialJobsInput, state: WebJobDiscoveryState, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const { context } = execution;
  state.round++;
  state.closedUrls = [];
  const result: OfficialJobDiscoveryResult = { observedAt: context.observedAt, status: "partial", candidates: [], queries: [], warnings: [] };
  let pages = 0, failures = 0;
  const newJobs = new Map<string, OfficialJobDiscoveryCandidate>();
  const planned = searchPlan(input, state);
  if (planned && execution.searchProvider && (!state.searchUnavailableUntil || state.searchUnavailableUntil <= Date.parse(context.observedAt))) {
    state.searched.add(planned.query);
    result.queries.push(planned.query + (planned.page > 1 ? " · 第 " + planned.page + " 页" : ""));
    try {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(6500)]);
      const response = CareerWebSearchResultSchema.parse(await execution.searchProvider.search({ ...planned, limit: 15, companyName: "",
        source: policy("https://html.duckduckgo.com/html/"), transport: execution.transport,
        context: { ...context, signal, throwIfCancelled() { context.throwIfCancelled(); signal.throwIfAborted(); } } }));
      queue(state, response.results.flatMap(item => {
        const url = safeLink(item.url);
        return url ? [{ url, label: item.title ?? "", depth: 0, priority: priority(item.title ?? "", input) + 20, evidenceUrl: item.evidenceUrl }] : [];
      }));
    } catch {
      context.throwIfCancelled();
      state.searchUnavailableUntil = Date.parse(context.observedAt) + 60_000;
      result.warnings.push("通用网页搜索本轮未完成，Agent 继续核对已发现的公开招聘链接。");
    }
  }

  while (state.queued.length && pages < maxPages && state.visited.size < maxVisited) {
    context.throwIfCancelled();
    const ordered = interleaveEmployers([...state.queued].sort((a,b) => b.priority - a.priority), employerKey);
    const batch = ordered.slice(0, Math.min(5, maxPages - pages, maxVisited - state.visited.size));
    if (!batch.length) break;
    const ids = new Set(batch.map(item => item.url));
    state.queued = state.queued.filter(item => !ids.has(item.url));
    for (const item of batch) state.visited.add(item.url);
    pages += batch.length;
    const read = await mapDiscoveryItems(batch, 4, async lead => {
      try {
        // Resolve workday links from any discovered tenant using the actual job detail.
        if (workdayBoard(lead.url) && new URL(lead.url).pathname.includes("/job/")) {
          const record = await inspectDiscoveredWorkdayJob(lead.url, input, execution);
          if (record) {
            const related = record.related.flatMap(url => {
              const safe = safeLink(url);
              return safe ? [{ url: safe, label: "", depth: lead.depth + 1, priority: 4, evidenceUrl: lead.url }] : [];
            });
            return { candidate: record.candidate, related };
          }
        }
        const html = await readPage(lead, execution);
        if (/\.xml$/i.test(new URL(lead.url).pathname)) {
          const enumeration = enumerateJobPostingUrls(html, lead.url, { enumerationKind: "sitemap-urlset", enumerationUrls: [lead.url], postingPathPrefixes: ["/"], pageSize: 5 });
          const urls = enumeration.urls.filter(url => careerWords.test(new URL(url).pathname));
          const related = urls.map(url => ({ url, label: new URL(url).pathname, depth: lead.depth + 1, priority: priority(new URL(url).pathname, input) + 8, evidenceUrl: lead.url }))
            .sort((a,b) => b.priority - a.priority).slice(0, 30);
          return { related, listing: { url: lead.url, kind: "sitemap-urlset" as const, links: urls } };
        }
        const links = readCareerLinks(html, lead.url);
        if (isDirectory(lead.url)) {
          if (new URL(lead.url).pathname.startsWith("/roles/")) result.queries.push("公开岗位索引 · " + lead.url);
          return { related: directoryLeads(lead, links, input) };
        }
        const parsed = inspectOfficialJobPage(html, new URL(lead.url), input, execution.registeredSources ?? [], context.observedAt);
        const related = linkedCareers(lead, links, input);
        if (parsed === "closed") return { related, closed: true };
        if (parsed === "different-region") return { related };
        if (!parsed) {
          if (related.length && careerWords.test(new URL(lead.url).pathname)) {
            const enumeration = enumerateJobPostingUrls(html, lead.url, { enumerationKind: "html-list", enumerationUrls: [lead.url], postingPathPrefixes: ["/"], pageSize: 5 });
            if (enumeration.urls.length) return { related, listing: { url: lead.url, kind: "html-list" as const, links: enumeration.urls } };
          }
          return { related };
        }
        const relevant = input.skills.length ? parsed.matchedSkills.some(skill => input.skills.includes(skill)) || parsed.relatedSkills?.length
          : discoveryRoleScore(parsed.title, input) > 0;
        if (!relevant || agencyWords.test(parsed.company ?? "")) return { related };
        if (parsed.verification === "official-detail") {
          const proposal = await companyBoardFromOfficialJob(parsed, execution.registeredSources);
          Object.assign(parsed, proposal);
          // The generic source only accepts actual structured posting details, not
          // an HTML list or employment aggregator's copied description.
          const structured = !!readJobPostingJsonLd(html, lead.url).record;
          return { candidate: parsed, related, structured };
        }
        return { related, candidate: parsed };
      } catch {
        context.throwIfCancelled(); failures++;
        return { related: [] as Lead[] };
      }
    });
    for (let index = 0; index < read.length; index++) {
      const item = read[index]!, lead = batch[index]!;
      queue(state, item.related);
      if (item.listing) state.listings.set(item.listing.url, item.listing);
      if (item.closed) { state.closedUrls.push(lead.url); state.knownJobs.delete(lead.url); }
      const candidate = item.candidate;
      if (!candidate) continue;
      if (lead.evidenceUrl && safeLink(lead.evidenceUrl)) candidate.discoveryEvidenceUrl = lead.evidenceUrl;
      const key = identity(candidate);
      if (item.structured) {
        state.structuredJobs.add(key);
        await collectionProposal(candidate, state, execution);
      }
      const prior = state.knownJobs.get(key);
      if (prior && (candidate.verification !== "official-detail" || prior.verification === "official-detail" &&
        (prior.sourceId || prior.sourceProposal || !candidate.sourceId && !candidate.sourceProposal))) continue;
      if (prior?.employerGroup && !candidate.employerGroup) candidate.employerGroup = prior.employerGroup;
      if (!prior) candidate.discoveryRound = state.round;
      else if (prior.discoveryRound) candidate.discoveryRound = prior.discoveryRound;
      state.knownJobs.set(key, candidate); newJobs.set(key, candidate);
      if (candidate.verification === "official-detail") state.knownCompanies.add(companyKey(candidate.company));
    }
  }
  for (const key of state.structuredJobs) {
    const candidate = state.knownJobs.get(key);
    if (candidate && !candidate.sourceId && !candidate.sourceProposal) {
      await collectionProposal(candidate, state, execution);
      if (candidate.sourceId || candidate.sourceProposal) newJobs.set(key, candidate);
    }
  }
  // Apply public group evidence to the newly encountered employers, independently
  // of the initial source directory. Keep this bounded and share evidence within a group.
  const companies = new Map<string, OfficialJobDiscoveryCandidate[]>();
  for (const [key, raw] of newJobs) {
    const job = withEmployerGroupEvidence(raw);
    newJobs.set(key, job); state.knownJobs.set(key, job);
    if (job.verification !== "official-detail" || !job.company) continue;
    const company = companyKey(job.company);
    const group = companies.get(company) ?? [];
    group.push(job); companies.set(company, group);
  }
  if (input.preferForeignEmployer) {
    await mapDiscoveryItems([...companies.values()].filter(group => !state.backgroundChecked.has(companyKey(group[0]!.company))).slice(0, 4), 2, async group => {
      const first = group[0]!, company = companyKey(first.company);
      state.backgroundChecked.add(company);
      const prior = [...state.knownJobs.values()].find(job => companyKey(job.company) === company && job.employerGroup);
      const background = prior?.employerGroup ? { group: prior.employerGroup, website: prior.companyWebsite } : await discoverEmployerBackground(first, execution);
      if (background) for (const job of group) {
        job.employerGroup = background.group;
        if (!job.companyWebsite && background.website) job.companyWebsite = background.website;
      }
    });
    for (const group of companies.values()) {
      const prior = [...state.knownJobs.values()].find(job => companyKey(job.company) === companyKey(group[0]!.company) && job.employerGroup);
      if (prior?.employerGroup) for (const job of group) { job.employerGroup ??= prior.employerGroup; job.companyWebsite ??= prior.companyWebsite; }
    }
  }
  result.candidates = interleaveEmployers([...newJobs.values()].sort((a,b) => rankOfficialJob(b,input) - rankOfficialJob(a,input)), item => item.company ?? new URL(item.url).origin).slice(0, 36);
  result.queries = [...new Set(result.queries)].slice(0, 48);
  result.warnings.push("本轮新增读取 " + pages + " 个公开网页线索，" + state.queued.length + " 个链接可供继续探索。");
  if (failures) result.warnings.push(failures + " 个链接暂时无法读取或结构不适用。");
  return result;
}
