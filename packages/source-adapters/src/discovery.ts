import { z } from "zod";
import { SourceDefinitionSchema, TimestampSchema, ToolError, deriveEntityId, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext, SourceTransport } from "./contracts.js";
import { JsonFieldMappingSchema, type JsonFieldMapping } from "./mapping-contracts.js";
import { plainText } from "./adapters/common.js";

import { type SourceSampleFormat, SourceCandidateSchema, type SourceCandidate, DiscoverSourceCandidatesInputSchema, type DiscoverSourceCandidatesInput, SourceDiscoveryPageSchema, type SourceDiscoveryPage, SourceSampleInspectionSchema, type SourceSampleInspection, InspectSourceCandidateInputSchema, type InspectSourceCandidateInput, SourceCandidateInspectionSchema, type SourceCandidateInspection, ProposeSourceRegistrationInputSchema, type ProposeSourceRegistrationInput, SourceRegistrationProposalSchema, type SourceRegistrationProposal } from "./discovery-contracts.js";
export * from "./discovery-contracts.js";

const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
export type SourceDiscoveryExecution = { source: SourceDefinition; context: SourceAdapterContext; transport: SourceTransport };

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max = 3000): string | undefined { return typeof value === "string" && value.trim() ? plainText(value).slice(0, max) : undefined; }
function formatFor(url: string): SourceSampleFormat {
  const path = new URL(url).pathname.toLowerCase();
  return path.endsWith(".json") ? "json" : path.endsWith(".csv") ? "csv" : /\.(?:md|markdown)$/.test(path) ? "markdown" : "unknown";
}
function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input); if (!result.success) throw new ToolError("invalid-input"); return result.data;
}
async function fetchText(url: string, execution: SourceDiscoveryExecution): Promise<{ url: string; body: string }> {
  execution.context.throwIfCancelled();
  const response = await execution.transport.request({ url, source: execution.source, context: execution.context, headers: { accept: "application/json,text/csv,text/markdown,text/plain;q=0.9" } });
  execution.context.throwIfCancelled();
  if (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0") throw new ToolError("rate-limited");
  if (response.status === 401 || response.status === 403) throw new ToolError("needs-auth");
  if (response.status === 429) throw new ToolError("rate-limited");
  if (response.status < 200 || response.status >= 300) throw new ToolError("source-changed");
  if (new TextEncoder().encode(response.text).byteLength > MAX_SAMPLE_BYTES) throw new ToolError("budget-exceeded");
  return { url: response.url, body: response.text };
}
function json(body: string): unknown { try { return JSON.parse(body); } catch { throw new ToolError("source-changed"); } }

/** Discover metadata only. Repository stars, activity and feed presence do not verify a job. */
export async function discoverSourceCandidates(input: DiscoverSourceCandidatesInput, execution: SourceDiscoveryExecution): Promise<SourceDiscoveryPage> {
  const options = parseInput(DiscoverSourceCandidatesInputSchema, input);
  parseInput(SourceDefinitionSchema, execution.source);
  parseInput(TimestampSchema, execution.context.observedAt);
  if (options.provider === "seed-links") {
    const urls = [...new Set(options.seedUrls!)].slice(0, options.limit);
    const candidates: SourceCandidate[] = [];
    // The controlled transport checks every user-provided seed against the configured endpoint policy.
    for (const url of urls) {
      const response = await fetchText(url, execution);
      candidates.push(SourceCandidateSchema.parse({
        candidateId: await deriveEntityId("source-candidate", ["seed-links", response.url]), provider: "seed-links", homeUrl: response.url,
        discoveredAt: execution.context.observedAt, status: "needs-review", entryHints: [{ url: response.url, format: formatFor(response.url) }], evidenceUrls: [response.url],
        warnings: ["Seed is a source candidate only. Usage rights, record identity and availability require review."],
      }));
    }
    return SourceDiscoveryPageSchema.parse({ candidates, observedAt: execution.context.observedAt, totalAvailable: options.seedUrls!.length, partial: options.seedUrls!.length > urls.length, warnings: [] });
  }
  const page = Number(options.cursor ?? "1");
  const api = new URL("https://api.github.com/search/repositories");
  api.searchParams.set("q", options.query!); api.searchParams.set("sort", "updated"); api.searchParams.set("order", "desc"); api.searchParams.set("per_page", String(options.limit)); api.searchParams.set("page", String(page));
  const response = await fetchText(api.toString(), execution);
  const data = object(json(response.body));
  if (!Array.isArray(data.items) || typeof data.total_count !== "number" || !Number.isSafeInteger(data.total_count) || data.total_count < 0) throw new ToolError("source-changed");
  const candidates: SourceCandidate[] = [];
  let invalid = 0;
  for (const row of data.items.slice(0, options.limit)) {
    const item = object(row); const name = text(item.full_name, 240);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { invalid++; continue; }
    const license = text(object(item.license).spdx_id, 100);
    candidates.push(SourceCandidateSchema.parse({
      candidateId: await deriveEntityId("source-candidate", ["github-repositories", name.toLowerCase()]), provider: "github-repositories", homeUrl: `https://github.com/${name}`,
      discoveredAt: execution.context.observedAt, status: "needs-review", repository: { fullName: name,
        ...(text(item.default_branch, 240) ? { defaultBranch: text(item.default_branch, 240) } : {}),
        ...(text(item.description) ? { description: text(item.description) } : {}),
        ...(text(item.pushed_at, 100) ? { pushedAtRaw: text(item.pushed_at, 100) } : {}),
        ...(license && license !== "NOASSERTION" ? { licenseSpdx: license } : {}),
      }, entryHints: [], evidenceUrls: [response.url, `https://github.com/${name}`],
      warnings: ["Repository activity is not a record update or availability check.", ...(!license || license === "NOASSERTION" ? ["Repository license is unknown; do not assume redistribution rights."] : ["Repository license does not automatically license linked employers' job content."])],
    }));
  }
  const capped = Math.min(data.total_count, 1000);
  return SourceDiscoveryPageSchema.parse({ candidates, observedAt: execution.context.observedAt, totalAvailable: data.total_count,
    ...(page * options.limit < capped && data.items.length >= options.limit ? { nextCursor: String(page + 1) } : {}),
    partial: Boolean(data.incomplete_results) || invalid > 0 || data.items.length > options.limit || data.total_count > 1000,
    warnings: [...(data.total_count > 1000 ? ["GitHub repository search exposes at most 1000 matches; narrow the query."] : []), ...(invalid ? ["Some repository metadata failed validation and was omitted."] : [])],
  });
}

const aliases = {
  idPath: ["id", "jobid", "job_id", "requisitionid", "requisition_id"], titlePath: ["title", "jobtitle", "job_title", "position", "role", "岗位", "职位"],
  urlPath: ["url", "joburl", "job_url", "absolute_url", "apply_url", "applyurl", "link"], applicationUrlPath: ["applyurl", "apply_url", "applicationurl", "application_url"],
  companyPath: ["company", "companyname", "company_name", "employer", "公司"], descriptionPath: ["description", "descriptionplain", "descriptionplaintext", "content", "jd", "岗位描述"],
  locationsPath: ["locations", "location", "city", "cities", "地区", "地点"], salaryTextPath: ["salary", "salarytext", "salary_text", "compensation", "薪资"],
  publishedPath: ["date_posted", "publishedat", "published_at", "dateposted", "postedat"], updatedPath: ["date_updated", "updatedat", "updated_at", "last_seen"],
} as const;
function shapes(rows: unknown[]): SourceSampleInspection["fields"] {
  const fields = new Map<string, { types: Set<"string" | "number" | "boolean" | "null" | "array" | "object">; count: number }>();
  for (const row of rows) {
    const seen = new Set<string>();
    const visit = (value: unknown, prefix: string, depth: number) => {
      if (depth > 3 || fields.size >= 100) return;
      for (const [key, item] of Object.entries(object(value))) {
        if (!/^[\p{L}\p{N}_-]{1,100}$/u.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item === "object" ? "object" : typeof item;
        if (!["string", "number", "boolean", "null", "array", "object"].includes(type)) continue;
        const shape = fields.get(path) ?? { types: new Set(), count: 0 };
        shape.types.add(type as SourceSampleInspection["fields"][number]["types"][number]);
        if (!seen.has(path)) { shape.count++; seen.add(path); }
        fields.set(path, shape);
        if (type === "object") visit(item, path, depth + 1);
      }
    };
    visit(row, "", 0);
  }
  return [...fields.entries()].map(([path, value]) => ({ path, types: [...value.types].sort(), present: value.count })).sort((a, b) => a.path.localeCompare(b.path));
}
function inferMapping(fields: SourceSampleInspection["fields"], recordsPath: string): JsonFieldMapping | undefined {
  const result: Record<string, unknown> = { recordsPath, discoveryOnly: true };
  for (const [target, names] of Object.entries(aliases)) {
    const field = fields.find((item) => (names as readonly string[]).includes(item.path.toLowerCase())) ?? fields.find((item) => (names as readonly string[]).includes(item.path.split(".").at(-1)!.toLowerCase()));
    if (field && field.types.some((type) => target === "locationsPath" ? type === "array" || type === "string" : type === "string" || (target === "idPath" && type === "number"))) result[target] = field.path;
  }
  const parsed = JsonFieldMappingSchema.safeParse(result); return parsed.success ? parsed.data : undefined;
}
function coverage(mapping?: Partial<JsonFieldMapping>) {
  return { identity: Boolean(mapping?.idPath || mapping?.urlPath), title: Boolean(mapping?.titlePath), url: Boolean(mapping?.urlPath), description: Boolean(mapping?.descriptionPath), locations: Boolean(mapping?.locationsPath), salary: Boolean(mapping?.salaryTextPath), recordTime: Boolean(mapping?.publishedPath || mapping?.updatedPath) };
}
function jsonRows(value: unknown): { rows: unknown[]; path: string } | undefined {
  const queue = [{ value, path: "", depth: 0 }];
  const candidates: Array<{ rows: unknown[]; path: string; score: number }> = [];
  let visited = 0;
  while (queue.length && ++visited <= 1000) {
    const node = queue.shift()!;
    if (Array.isArray(node.value)) {
      const sample = node.value.slice(0, 5);
      const keys = sample.flatMap((row) => Object.keys(object(row))).map((key) => key.toLowerCase());
      const score = Number(sample.some((row) => Object.keys(object(row)).length > 0)) * 10 + Number(/(?:^|\.)(?:jobs|listings|items|results|positions)$/i.test(node.path)) * 5 + Number(keys.some((key) => (aliases.titlePath as readonly string[]).includes(key))) * 5 + Number(node.value.length > 0);
      candidates.push({ rows: node.value, path: node.path, score });
      continue;
    }
    if (node.depth >= 4) continue;
    const entries = Object.entries(object(node.value)).filter(([key]) => /^[\p{L}\p{N}_-]{1,100}$/u.test(key) && !["__proto__", "prototype", "constructor"].includes(key));
    entries.sort(([a], [b]) => Number(!/^(?:jobs|listings|items|results|data|positions)$/i.test(a)) - Number(!/^(?:jobs|listings|items|results|data|positions)$/i.test(b)));
    for (const [key, item] of entries.slice(0, 100)) queue.push({ value: item, path: node.path ? `${node.path}.${key}` : key, depth: node.depth + 1 });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return candidates[0];
}

/** Bounded RFC4180-style reader; cells stay inert text, including spreadsheet formula prefixes. */
function csvRows(body: string, maxRecords: number): { rows: Record<string, string>[]; truncated: boolean } {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index <= body.length; index++) {
    const char = body[index];
    if (quoted) { if (char === '"' && body[index + 1] === '"') { cell += '"'; index++; } else if (char === '"') quoted = false; else if (char === undefined) throw new ToolError("source-changed"); else cell += char; }
    else if (char === '"' && !cell) quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r" || char === undefined) {
      row.push(cell); cell = "";
      if (row.some((item) => item.length)) rows.push(row);
      row = [];
      if (char === "\r" && body[index + 1] === "\n") index++;
      if (rows.length > maxRecords + 1) break;
    } else cell += char;
    if (cell.length > 20_000 || row.length > 100) throw new ToolError("budget-exceeded");
  }
  const header = rows.shift(); if (!header || !header.length || header.length > 100 || new Set(header).size !== header.length) throw new ToolError("source-changed");
  return { rows: rows.slice(0, maxRecords).map((values) => Object.fromEntries(header.map((key, index) => [key.trim(), values[index] ?? ""]))), truncated: rows.length > maxRecords };
}
function markdownRows(body: string, maxRecords: number): { rows: Record<string, string>[]; truncated: boolean } {
  const lines = body.split(/\r?\n/).slice(0, 20_000); let header: string[] | undefined; const rows: Record<string, string>[] = [];
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!lines[index]!.includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1]!)) continue;
    header = cells(lines[index]!); index += 2;
    for (; index < lines.length && lines[index]!.includes("|") && rows.length <= maxRecords; index++) {
      const values = cells(lines[index]!); rows.push(Object.fromEntries(header.map((key, cell) => [key, values[cell] ?? ""])));
    }
    break;
  }
  return { rows: rows.slice(0, maxRecords), truncated: rows.length > maxRecords };
}
function inspectBody(url: string, body: string, maxRecords: number): SourceSampleInspection {
  let format = formatFor(url); if (format === "unknown" && /^[\s\uFEFF]*[[{]/.test(body)) format = "json";
  let rows: unknown[] = []; let totalRecords: number | undefined; let truncated = false; let recordsPath: string | undefined;
  if (format === "json") {
    const found = jsonRows(json(body));
    if (found) { totalRecords = found.rows.length; rows = found.rows.slice(0, maxRecords); recordsPath = found.path; truncated = found.rows.length > maxRecords; }
  } else if (format === "csv") { const parsed = csvRows(body.replace(/^\uFEFF/, ""), maxRecords); rows = parsed.rows; truncated = parsed.truncated; }
  else if (format === "markdown") { const parsed = markdownRows(body, maxRecords); rows = parsed.rows; truncated = parsed.truncated; }
  const fields = shapes(rows); const inferred = inferMapping(fields, recordsPath ?? "");
  return SourceSampleInspectionSchema.parse({ url, format, sampledRecords: rows.length, ...(totalRecords !== undefined ? { totalRecords } : {}), truncated,
    ...(recordsPath !== undefined ? { recordsPath } : {}), fields, ...(format === "json" && inferred ? { mappingProposal: inferred } : {}), coverage: coverage(inferred),
    warnings: ["Structure inspection does not verify current availability, employer ownership, or permission to redistribute.", ...(!rows.length ? ["No supported record array or recruitment table was found."] : []), ...(format === "csv" || format === "markdown" ? ["This format is inspectable; a dedicated parser adapter must be reviewed before registration."] : [])],
  });
}

/** Read at most three bounded samples. All URLs still pass through the configured controlled transport. */
export async function inspectSourceCandidate(input: InspectSourceCandidateInput, execution: SourceDiscoveryExecution): Promise<SourceCandidateInspection> {
  const options = parseInput(InspectSourceCandidateInputSchema, input); parseInput(SourceDefinitionSchema, execution.source);
  let entries: Array<{ url: string; format: SourceSampleFormat }> = options.sampleUrls?.map((url) => ({ url, format: formatFor(url) })) ?? options.candidate.entryHints;
  let partial = false; const warnings: string[] = [];
  if (!entries.length && options.candidate.repository) {
    const repo = options.candidate.repository;
    const branch = repo.defaultBranch;
    if (!branch) throw new ToolError("invalid-input");
    const api = `https://api.github.com/repos/${repo.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const response = await fetchText(api, execution); const tree = object(json(response.body));
    if (!Array.isArray(tree.tree)) throw new ToolError("source-changed");
    partial = tree.truncated === true || tree.tree.length > 20_000;
    const paths = tree.tree.slice(0, 20_000).map(object).filter((item) => item.type === "blob" && typeof item.path === "string" && /\.(?:json|csv|md|markdown)$/i.test(item.path) &&
      !/(?:^|\/)(?:node_modules|vendor|package(?:-lock)?\.json|pnpm-lock|tsconfig)/i.test(item.path as string) && !String(item.path).split("/").some((part) => !part || part === "." || part === ".."));
    paths.sort((a, b) => {
      const rank = (path: unknown) => /(?:jobs|listings|positions|internships|recruit)/i.test(String(path)) ? 0 : /readme\.(?:md|markdown)$/i.test(String(path)) ? 1 : 2;
      return rank(a.path) - rank(b.path) || String(a.path).localeCompare(String(b.path));
    });
    entries = paths.slice(0, 30).map((item) => ({ url: `https://raw.githubusercontent.com/${repo.fullName}/${encodeURIComponent(branch)}/${String(item.path).split("/").map(encodeURIComponent).join("/")}`, format: formatFor(String(`https://example.test/${item.path}`)) }));
    if (partial) warnings.push("Repository tree is truncated; the inspected entries do not cover all files.");
  }
  if (!entries.length) entries = [{ url: options.candidate.homeUrl, format: formatFor(options.candidate.homeUrl) }];
  entries = [...new Map(entries.map((entry) => [entry.url, entry])).values()];
  const selected = entries.slice(0, 3); const samples: SourceSampleInspection[] = [];
  if (entries.length > selected.length) warnings.push("Only three candidate files were sampled; additional discovered entries remain uninspected.");
  for (const entry of selected) { const response = await fetchText(entry.url, execution); samples.push(inspectBody(response.url, response.body, options.maxRecords)); }
  return SourceCandidateInspectionSchema.parse({ candidateId: options.candidate.candidateId, inspectedAt: execution.context.observedAt, samples, discoveredEntries: entries.slice(0, 30), partial: partial || entries.length > selected.length || samples.some((sample) => sample.truncated), warnings });
}

/** No network or enable action. The caller may stage this proposal but must review it separately. */
export async function proposeSourceRegistration(input: ProposeSourceRegistrationInput): Promise<SourceRegistrationProposal> {
  const options = parseInput(ProposeSourceRegistrationInputSchema, input); const url = new URL(options.sample.url);
  if (url.protocol !== "https:") throw new ToolError("invalid-input");
  const mapping = options.sample.mappingProposal;
  const supported = options.sample.format === "json" && mapping !== undefined;
  const source = SourceDefinitionSchema.parse({
    sourceId: await deriveEntityId("source", [options.candidate.candidateId, options.sample.url]), name: options.name,
    adapterId: supported ? url.hostname === "raw.githubusercontent.com" ? "github-json" : "mapped-json" : `review-required-${options.sample.format}`,
    adapterVersion: "1", capabilities: supported ? ["list-jobs"] : [], runtime: ["local-service"], entityType: "company-directory", enabled: false, status: "needs-review", entryUrl: options.sample.url,
    ...(supported ? { options: { ...mapping, discoveryOnly: true } } : {}), remoteFilters: [],
    endpointPolicy: { allowedHosts: [url.hostname], allowedPathPrefixes: [url.pathname], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: options.name, homepageUrl: options.candidate.homeUrl, ...(options.candidate.repository?.licenseSpdx ? { license: options.candidate.repository.licenseSpdx } : {}), usage: "link-only", requiresAttribution: true,
      notes: "Candidate metadata only. Repository code licensing does not establish redistribution rights for job records or linked employer content." },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxRecords: options.maxRecords, maxPages: 1, requestsPerMinute: 10 },
  });
  return SourceRegistrationProposalSchema.parse({ schemaVersion: 1, candidateId: options.candidate.candidateId, source, reviewRequired: ["Review source ownership, usage conditions and attribution.", "Confirm mapping and stable job identity against the original source.", "Discovery leads and campaign directions are not verified current jobs.", ...(!supported ? ["Install and review a compatible parser adapter before enabling this format."] : []), ...(options.sample.truncated ? ["Review the sampling or enumeration limit before claiming coverage."] : [])] });
}
