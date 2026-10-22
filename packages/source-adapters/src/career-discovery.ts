import { SourceDefinitionSchema, TimestampSchema, ToolError, deriveEntityId, type SourceDefinition } from "@better-me/opportunities";
import { plainText, publicUrl } from "./adapters/common.js";
import { discoveryPolicyAdapter } from "./adapters/discovery-policy.js";
import type { SourceAdapterContext, SourceTransport } from "./contracts.js";
import type { SourceDiscoveryExecution } from "./discovery.js";
import { SourceCandidateSchema, SourceRegistrationProposalSchema, type SourceRegistrationProposal } from "./discovery-contracts.js";
import {
  CareerWebSearchResultSchema, CompanyCareerDiscoveryResultSchema, DiscoverCompanyCareersInputSchema,
  type CareerDiscoveryEvidence, type CareerEntryKind, type CareerSourceCandidate,
  CareerWebSearchProviderMetadataSchema,
  type CompanyCareerDiscoveryResult, type DiscoverCompanyCareersInput, type CareerWebSearchProviderMetadata,
} from "./career-discovery-contracts.js";

/** A host-installed provider, never executable code or an endpoint supplied by a tool caller. */
export type CareerWebSearchProvider = {
  readonly metadata?: CareerWebSearchProviderMetadata;
  search(input: {
    query: string; companyName: string; limit: number; source: SourceDefinition;
    context: SourceAdapterContext; transport: SourceTransport;
  }): Promise<unknown>;
};
export type CompanyCareerDiscoveryExecution = SourceDiscoveryExecution & {
  registeredSources?: readonly SourceDefinition[];
  /** Trusted configuration keyed by sourceId; aliases are matches, not verification evidence. */
  companyAliases?: Readonly<Record<string, readonly string[]>>;
  searchProvider?: CareerWebSearchProvider;
};

type RecognizedEntry = { kind: Exclude<CareerEntryKind, "html">; homeUrl: string; apiUrl: string; boardToken?: string; companyIdentifier?: string };
const slug = "([A-Za-z0-9][A-Za-z0-9_-]{0,99})";
const sharedCareerHosts = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "careers.smartrecruiters.com", "jobs.smartrecruiters.com", "api.smartrecruiters.com"]);
const careerWords = /(?:\b(?:careers?|jobs?|recruit(?:ment|ing)?|vacanc(?:y|ies)|join[\s_-]*us|work[\s_-]*(?:with|for)[\s_-]*us|opportunities)\b|招聘|职位|岗位|加入我们|人才招聘)/i;
const associationWarning = "Company affiliation and website ownership remain unverified; review the original evidence before registration. This is a source lead, not a verified current job.";

function safeUrl(value: string, base?: string): string | undefined {
  if (value.length > 4096 || value.includes("\\") || Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return undefined;
  try {
    const url = new URL(value, base);
    if (url.username || url.password || url.hostname.endsWith(".")) return undefined;
    if (sharedCareerHosts.has(url.hostname) && /(?:^|\/)(?:\.|%2e){1,2}(?=\/|[?#]|$)/i.test(value)) return undefined;
    url.hash = "";
    return publicUrl(url.toString());
  } catch { return undefined; }
}
function normalizeName(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"); }
function recognize(value: string): RecognizedEntry | undefined {
  const url = new URL(value);
  const board = url.pathname.match(new RegExp(`^/${slug}(?:/|$)`))?.[1];
  if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) && board) return {
    kind: "greenhouse", boardToken: board, homeUrl: `https://${url.hostname}/${board}`,
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
  };
  if (url.hostname === "jobs.lever.co" && board) return {
    kind: "lever", boardToken: board, homeUrl: `https://jobs.lever.co/${board}`,
    apiUrl: `https://api.lever.co/v0/postings/${board}?mode=json`,
  };
  if (url.hostname === "jobs.ashbyhq.com" && board) return {
    kind: "ashby", boardToken: board, homeUrl: `https://jobs.ashbyhq.com/${board}`,
    apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
  };
  if (url.hostname === "careers.tencent.com") return {
    kind: "tencent", homeUrl: "https://careers.tencent.com/", apiUrl: "https://careers.tencent.com/tencentcareer/api/post/Query",
  };
  if (["careers.smartrecruiters.com", "jobs.smartrecruiters.com"].includes(url.hostname) && board) return {
    kind: "smartrecruiters", companyIdentifier: board, homeUrl: `https://careers.smartrecruiters.com/${board}`,
    apiUrl: `https://api.smartrecruiters.com/v1/companies/${board}/postings`,
  };
  return undefined;
}
function permitted(url: string, source: SourceDefinition): boolean {
  const parsed = new URL(url);
  let path: string;
  try { path = decodeURIComponent(parsed.pathname); } catch { return false; }
  return !/[\\%]/.test(path) && !Array.from(path).some((character) => character.charCodeAt(0) < 32)
    && source.endpointPolicy.allowedHosts.some((host) => host.toLowerCase() === parsed.hostname)
    && source.endpointPolicy.allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}
function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    const key = entity.toLowerCase();
    if (named[key]) return named[key]!;
    const code = key.startsWith("&#x") ? Number.parseInt(key.slice(3, -1), 16) : Number(key.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
function hrefAttribute(attributes: string): string | undefined {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (cursor < attributes.length && /[\s/]/.test(attributes[cursor]!)) cursor++;
    const start = cursor;
    while (cursor < attributes.length && !/[\s=/>]/.test(attributes[cursor]!)) cursor++;
    const name = attributes.slice(start, cursor).toLowerCase();
    if (!name) { cursor++; continue; }
    while (cursor < attributes.length && /\s/.test(attributes[cursor]!)) cursor++;
    let value = "";
    if (attributes[cursor] === "=") {
      cursor++;
      while (cursor < attributes.length && /\s/.test(attributes[cursor]!)) cursor++;
      const quote = attributes[cursor];
      if (quote === '"' || quote === "'") {
        const end = attributes.indexOf(quote, cursor + 1);
        if (end < 0) return undefined;
        value = attributes.slice(cursor + 1, end); cursor = end + 1;
      } else {
        const startValue = cursor;
        while (cursor < attributes.length && !/\s/.test(attributes[cursor]!)) cursor++;
        value = attributes.slice(startValue, cursor);
      }
    }
    if (name === "href") return decodeAttribute(value);
  }
  return undefined;
}
/** A bounded inert anchor reader; no DOM, JS, embedded frames, forms or user selectors execute. */
function anchorLinks(html: string): { links: { href: string; text: string }[]; truncated: boolean } {
  const links: { href: string; text: string }[] = [];
  let pending: { href: string; end: number; text?: string } | undefined;
  let count = 0, cursor = 0;
  const blocked: string[] = [];
  const flush = (end: number) => {
    if (pending) {
      const text = pending.text ?? "";
      links.push({ href: pending.href, text: plainText(text + html.slice(pending.end, Math.min(end, pending.end + 1000 - text.length))).slice(0, 500) });
    }
    pending = undefined;
  };
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    if (++count > 10_000 || links.length >= 2000) { flush(start); return { links, truncated: true }; }
    // Large, inert wizard/configuration metadata can precede all visible navigation.
    // Only an exact opening meta tag gets a 64K UTF-16 code-unit total-length
    // skip budget. Its attributes are never links/text and it introduces no scope.
    // The caller separately enforces the 2 MiB response byte limit.
    const metadata = /^<meta[\t\n\f\r />]/i.test(html.slice(start, start + 6));
    const maxOffset = metadata ? 64 * 1024 - 1 : 8192;
    let end = start + 1, quote = "";
    // Quotes in attributes cannot manufacture nested anchor tags.
    for (; end < html.length && end - start <= maxOffset; end++) {
      const character = html[end]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= html.length || end - start > maxOffset) { flush(start); return { links, truncated: true }; }
    if (metadata) {
      if (pending) {
        const text = pending.text ?? "";
        pending.text = text + html.slice(pending.end, Math.min(start, pending.end + 1000 - text.length));
        pending.end = end + 1;
      }
      cursor = end + 1; continue;
    }
    const token = html.slice(start + 1, end), match = token.match(/^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    cursor = end + 1;
    if (!match) continue;
    const closing = Boolean(match[1]), tag = match[2]!.toLowerCase();
    if (!closing && tag === "plaintext") { flush(start); cursor = html.length; continue; }
    if (!closing && ["script", "style", "textarea", "title", "xmp"].includes(tag)) {
      flush(start);
      const close = new RegExp(`</${tag}\\s*>`, "gi"); close.lastIndex = cursor;
      cursor = close.exec(html) ? close.lastIndex : html.length;
      continue;
    }
    if (["template", "noscript", "iframe", "object"].includes(tag)) {
      flush(start);
      if (!closing) blocked.push(tag);
      else { const index = blocked.lastIndexOf(tag); if (index >= 0) blocked.splice(index); }
      continue;
    }
    if (blocked.length || tag !== "a") continue;
    flush(start);
    if (closing) continue;
    const href = hrefAttribute(token.slice(match[0].length));
    if (href) pending = { href, end: cursor };
  }
  flush(html.length);
  return { links, truncated: false };
}

function existingMatches(options: zOptions, execution: CompanyCareerDiscoveryExecution): CompanyCareerDiscoveryResult["matchedSources"] {
  const name = normalizeName(options.companyName);
  const urls = [options.companyWebsite, ...(options.seedUrls ?? [])].filter((value): value is string => Boolean(value)).map((value) => safeUrl(value)).filter((value): value is string => Boolean(value));
  const result: CompanyCareerDiscoveryResult["matchedSources"] = [];
  for (const supplied of execution.registeredSources ?? []) {
    const parsed = SourceDefinitionSchema.safeParse(supplied);
    if (!parsed.success) throw new ToolError("invalid-context");
    const source = parsed.data;
    // An access policy is permission to inspect a site, never an existing recruiting source.
    if (source.adapterId === discoveryPolicyAdapter.adapterId) continue;
    let matchedBy: CompanyCareerDiscoveryResult["matchedSources"][number]["matchedBy"] | undefined;
    if (typeof source.options?.companyName === "string" && normalizeName(source.options.companyName) === name) matchedBy = "company-name";
    else if (execution.companyAliases && Object.hasOwn(execution.companyAliases, source.sourceId)
      && execution.companyAliases[source.sourceId]!.some((alias) => normalizeName(alias) === name)) matchedBy = "company-alias";
    else if (normalizeName(source.name) === name) matchedBy = "source-name";
    else for (const value of urls) {
      const entry = recognize(value);
      if (value.replace(/\/$/, "") === source.entryUrl?.replace(/\/$/, "")
        || (entry && entry.kind === source.adapterId && (entry.kind === "tencent" || (entry.kind === "smartrecruiters"
          ? entry.companyIdentifier === source.options?.companyIdentifier : entry.boardToken === source.options?.boardToken)))) { matchedBy = "entry-url"; break; }
      const homepage = source.attribution.homepageUrl && safeUrl(source.attribution.homepageUrl);
      // Shared ATS domains cannot establish a company match by host alone.
      if (!entry && homepage && new URL(value).hostname === new URL(homepage).hostname
        && new URL(homepage).pathname === "/" && !sharedCareerHosts.has(new URL(homepage).hostname)) { matchedBy = "company-website"; break; }
    }
    if (matchedBy) result.push({ sourceId: source.sourceId, name: source.name, matchedBy, enabled: source.enabled, status: source.status, ...(source.entryUrl ? { entryUrl: source.entryUrl } : {}) });
    if (result.length === 50) break;
  }
  return result;
}
type zOptions = ReturnType<typeof DiscoverCompanyCareersInputSchema.parse>;

async function proposalFor(item: CareerSourceCandidate, companyName: string): Promise<SourceRegistrationProposal> {
  const entry = recognize(item.candidate.homeUrl);
  const endpoint = new URL(entry?.apiUrl ?? item.candidate.homeUrl);
  const name = `${companyName} · ${item.entryKind} (review required)`.slice(0, 240);
  return SourceRegistrationProposalSchema.parse({
    schemaVersion: 1, candidateId: item.candidate.candidateId,
    source: {
      sourceId: await deriveEntityId("source", ["company-careers", item.candidate.homeUrl]), name,
      adapterId: entry?.kind ?? "review-required-html", adapterVersion: "1", capabilities: entry ? ["list-jobs"] : [],
      runtime: ["local-service"], entityType: entry ? "job-posting" : "company-directory", enabled: false, status: "needs-review", entryUrl: endpoint.toString(),
      ...(entry ? { options: entry.kind === "tencent"
        ? { companyName, apiHost: "careers.tencent.com", language: "zh-cn", pageSize: 20, fetchDetails: false, maxDetailRequestsPerPage: 2 }
        : entry.kind === "smartrecruiters" ? { companyName, companyIdentifier: entry.companyIdentifier, pageSize: 20, fetchDetails: true, maxDetailRequestsPerPage: 2 }
        : { companyName, boardToken: entry.boardToken } } : {}),
      remoteFilters: entry && ["tencent", "smartrecruiters"].includes(entry.kind) ? ["roles"] : [],
      endpointPolicy: { allowedHosts: [endpoint.hostname], allowedPathPrefixes: [endpoint.pathname], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
      attribution: { label: name, homepageUrl: item.candidate.homeUrl, usage: "link-only", requiresAttribution: true, notes: associationWarning },
      refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxRecords: 100, maxPages: 3, requestsPerMinute: 10 },
    },
    reviewRequired: [
      "Verify company affiliation, website ownership, source usage conditions and attribution against the original evidence.",
      "The companyName is a requested label and must be confirmed before enabling this source.",
      ...(entry ? ["Review the recognized ATS endpoint and test bounded collection before enabling; protocol recognition does not verify jobs or availability."]
        : ["This HTML source has no installed generic parser. Review and install a compatible adapter before enabling; no job ingestion is proposed."]),
      "This proposal is disabled and does not register or enable any source.",
    ],
  });
}

/** Discover reviewable career entries without registering sources or turning candidates into jobs. */
export async function discoverCompanyCareers(input: DiscoverCompanyCareersInput, execution: CompanyCareerDiscoveryExecution): Promise<CompanyCareerDiscoveryResult> {
  const parsed = DiscoverCompanyCareersInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolError("invalid-input");
  const options = parsed.data;
  const sourceResult = SourceDefinitionSchema.safeParse(execution.source);
  if (!sourceResult.success || !TimestampSchema.safeParse(execution.context.observedAt).success) throw new ToolError("invalid-context");
  const source = sourceResult.data;
  if (!source.enabled || source.status !== "active") throw new ToolError("not-authorized");
  if (!source.capabilities.includes("discover-sources")) throw new ToolError("unsupported-capability");
  execution.context.throwIfCancelled();
  const matchedSources = existingMatches(options, execution);
  const result: CompanyCareerDiscoveryResult = {
    status: "no-candidates", companyName: options.companyName, observedAt: execution.context.observedAt,
    matchedSources, candidates: [], proposals: [], visitedUrls: [], partial: false,
    warnings: [associationWarning, "Discovery inspects bounded static HTML or supplied links only. JavaScript-rendered careers pages and exhaustive job coverage are not established."],
  };
  // A registered match is only a usable source when it is explicitly enabled
  // and active. Keep inactive matches visible, but do not let stale configuration
  // suppress a separately authorized website or host-installed search fallback.
  const hasUsableMatch = matchedSources.some((match) => match.enabled && match.status === "active");
  if (hasUsableMatch) {
    result.status = "matched-existing";
    result.warnings.push("Existing-source matches come from installed configuration or aliases; they do not verify company affiliation or availability.");
    return CompanyCareerDiscoveryResultSchema.parse(result);
  }
  if (matchedSources.length) {
    result.warnings.push("Existing-source matches are disabled, under review, or unavailable; they remain visible, but this request may continue only through its explicitly authorized discovery policy or trusted host search.");
  }
  const candidates = new Map<string, CareerSourceCandidate>();
  const warn = (message: string) => { if (!result.warnings.includes(message) && result.warnings.length < 30) result.warnings.push(message); };
  const add = async (value: string, matchedBy: CareerSourceCandidate["matchedBy"], evidence: CareerDiscoveryEvidence) => {
    const entry = recognize(value), homeUrl = entry?.homeUrl ?? value;
    const prior = candidates.get(homeUrl);
    if (prior) {
      if (prior.evidence.length < 30 && !prior.evidence.some((item) => item.sourceUrl === evidence.sourceUrl && item.targetUrl === evidence.targetUrl)) prior.evidence.push(evidence);
      prior.candidate.evidenceUrls = [...new Set([...prior.candidate.evidenceUrls, evidence.sourceUrl, evidence.targetUrl])].slice(0, 40);
      return;
    }
    if (candidates.size >= options.limit) { result.partial = true; warn("Candidate limit reached; additional career entries remain unreviewed."); return; }
    candidates.set(homeUrl, {
      candidate: SourceCandidateSchema.parse({
        candidateId: await deriveEntityId("source-candidate", ["company-careers", homeUrl]), provider: "seed-links", homeUrl,
        discoveredAt: execution.context.observedAt, status: "needs-review", entryHints: [{ url: entry?.apiUrl ?? homeUrl, format: entry ? "json" : "unknown" }],
        evidenceUrls: [...new Set([evidence.sourceUrl, evidence.targetUrl])], warnings: [associationWarning, ...(!entry ? ["HTML entry only; no generic job parser or current-job verification is available."] : ["Recognized ATS URL structure only; the endpoint has not been collected or verified."])],
      }), entryKind: entry?.kind ?? "html", matchedBy, companyAssociation: "unverified", evidence: [evidence],
    });
  };
  const roots: { url: string; matchedBy: "company-website" | "seed-link"; kind: "provided-website" | "provided-seed" }[] = [];
  for (const item of [
    ...(options.companyWebsite ? [{ value: options.companyWebsite, matchedBy: "company-website" as const, kind: "provided-website" as const }] : []),
    ...(options.seedUrls ?? []).map((value) => ({ value, matchedBy: "seed-link" as const, kind: "provided-seed" as const })),
  ]) {
    const url = safeUrl(item.value);
    if (!url) throw new ToolError("invalid-input");
    if (!roots.some((root) => root.url === url)) roots.push({ url, matchedBy: item.matchedBy, kind: item.kind });
  }
  if (!roots.length) {
    if (!execution.searchProvider) {
      result.status = "requires-company-website";
      warn("Provide an already-reviewed company website or seed URL, or configure a trusted web-search provider. Company domains are never guessed from names.");
      return CompanyCareerDiscoveryResultSchema.parse(result);
    }
    const metadata = CareerWebSearchProviderMetadataSchema.safeParse(execution.searchProvider.metadata ?? { providerId: "host-installed", label: "Host-installed web search" });
    if (!metadata.success) throw new ToolError("invalid-context");
    const response = await execution.searchProvider.search({
      query: `${options.companyName} official careers 招聘`, companyName: options.companyName, limit: options.limit,
      source, context: execution.context, transport: execution.transport,
    });
    execution.context.throwIfCancelled();
    const search = CareerWebSearchResultSchema.safeParse(response);
    if (!search.success) throw new ToolError("source-changed");
    result.search = { ...metadata.data, query: `${options.companyName} official careers 招聘`, resultCount: search.data.results.length };
    result.partial = search.data.partial;
    for (const item of search.data.results) {
      const url = safeUrl(item.url), evidenceUrl = safeUrl(item.evidenceUrl ?? item.url);
      if (!url || !evidenceUrl) { result.partial = true; warn("Unsafe web-search result URLs were omitted."); continue; }
      await add(url, "search-result", { kind: "search-result", sourceUrl: evidenceUrl, targetUrl: url, ...(item.title || item.snippet ? { quote: [item.title, item.snippet].filter(Boolean).join(" · ").slice(0, 1000) } : {}) });
    }
    warn("Search results are unverified candidates and were not followed or treated as a verified company website.");
  }
  const queue: { url: string; origin: string }[] = [];
  for (const root of roots) {
    const entry = recognize(root.url);
    if (entry || careerWords.test(new URL(root.url).pathname)) await add(root.url, root.matchedBy, { kind: root.kind, sourceUrl: root.url, targetUrl: root.url });
    if (!entry) queue.push({ url: root.url, origin: new URL(root.url).origin });
  }
  const queued = new Set(queue.map((item) => item.url));
  const maxPages = Math.min(options.maxPages, source.refreshPolicy.maxPages);
  while (queue.length && result.visitedUrls.length < maxPages) {
    execution.context.throwIfCancelled();
    const page = queue.shift()!;
    if (!permitted(page.url, source)) throw new ToolError("not-authorized");
    const response = await execution.transport.request({ url: page.url, source, context: execution.context, headers: { accept: "text/html,application/xhtml+xml;q=0.9" } });
    execution.context.throwIfCancelled();
    if (response.status === 429) throw new ToolError("rate-limited");
    if (response.status === 401 || response.status === 403) throw new ToolError("needs-auth");
    if (response.status < 200 || response.status >= 300) throw new ToolError("source-changed");
    const finalUrl = safeUrl(response.url);
    if (!finalUrl || new URL(finalUrl).origin !== page.origin || !permitted(finalUrl, source)) throw new ToolError("not-authorized");
    if (new TextEncoder().encode(response.text).byteLength > 2 * 1024 * 1024) throw new ToolError("budget-exceeded");
    result.visitedUrls.push(finalUrl);
    const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if ((contentType && !["text/html", "application/xhtml+xml"].includes(contentType)) || !/<(?:html|body|a)\b/i.test(response.text)) {
      result.partial = true; warn("A visited entry did not provide readable static HTML; no scripts or embedded APIs were executed."); continue;
    }
    const extracted = anchorLinks(response.text);
    if (extracted.truncated) { result.partial = true; warn("HTML anchor scan limit reached; page discovery is partial."); }
    for (const link of extracted.links) {
      const url = safeUrl(link.href, finalUrl);
      if (!url || url === finalUrl) continue;
      const entry = recognize(url);
      if (!entry && !careerWords.test(`${new URL(url).pathname} ${link.text}`)) continue;
      await add(url, "career-link", { kind: "html-link", sourceUrl: finalUrl, targetUrl: url, ...(link.text ? { quote: link.text } : {}) });
      // Discovered endpoints never widen the configured policy. ATS URLs are only recognized.
      if (!entry && new URL(url).origin === page.origin && !queued.has(url)) {
        if (permitted(url, source) && queued.size < 100) { queued.add(url); queue.push({ url, origin: page.origin }); }
        else if (queued.size >= 100) { result.partial = true; warn("Career-link queue limit reached; additional pages were not queued."); }
        else { result.partial = true; warn("A same-site career link is outside the configured endpoint policy and was not followed."); }
      } else if (!entry && new URL(url).origin !== page.origin) warn("External career links were recorded for review and were not followed; company affiliation is unverified.");
    }
  }
  if (queue.length) { result.partial = true; warn("Page limit reached; additional same-site career pages were not inspected."); }
  result.candidates = [...candidates.values()];
  result.proposals = await Promise.all(result.candidates.map((candidate) => proposalFor(candidate, options.companyName)));
  result.status = result.candidates.length ? "needs-review" : "no-candidates";
  return CompanyCareerDiscoveryResultSchema.parse(result);
}
