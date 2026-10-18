import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext, SourceTransport } from "../src/contracts.js";
import {
  DiscoverSourceCandidatesInputSchema, SourceCandidateSchema, discoverSourceCandidates,
  inspectSourceCandidate, proposeSourceRegistration, type SourceCandidate, type SourceDiscoveryExecution,
} from "../src/discovery.js";

const at = "2026-10-18T12:00:00.000Z";
function configuredSource(): SourceDefinition {
  return {
    sourceId: "synthetic-discovery", name: "Synthetic discovery", adapterId: "source-discovery", adapterVersion: "1", capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["api.github.com", "raw.githubusercontent.com", "feeds.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic discovery", usage: "link-only", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 10, requestsPerMinute: 10 },
  };
}
function execution(respond: (url: URL) => unknown): SourceDiscoveryExecution & { requests: string[]; chargedBytes: () => number } {
  const requests: string[] = []; let requestCount = 0; let byteCount = 0;
  const context: SourceAdapterContext = {
    requestId: "synthetic-discovery-request", observedAt: at, actorScope: "local", signal: new AbortController().signal, budget: { requests: 10, bytes: 10_000_000, timeoutMs: 1000 },
    consumeRequests(count = 1) { requestCount += count; if (requestCount > 10) throw new ToolError("budget-exceeded"); },
    consumeBytes(bytes) { byteCount += bytes; }, throwIfCancelled() {},
  };
  const transport: SourceTransport = { async request(input) {
    input.context.throwIfCancelled(); const url = new URL(input.url);
    // This mock preserves the controlled transport's policy responsibility. No actual network is used.
    if (url.protocol !== "https:" || !input.source.endpointPolicy.allowedHosts.includes(url.hostname) || !input.source.endpointPolicy.allowedPathPrefixes.some((path) => url.pathname.startsWith(path))) throw new ToolError("not-authorized");
    input.context.consumeRequests(); requests.push(url.toString());
    const payload = respond(url); const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    input.context.consumeBytes(new TextEncoder().encode(body).byteLength);
    return { status: 200, url: url.toString(), headers: {}, text: body };
  } };
  return { source: configuredSource(), context, transport, requests, chargedBytes: () => byteCount };
}
function seed(url = "https://feeds.example.test/jobs.json"): SourceCandidate {
  return { candidateId: "source-candidate-synthetic", provider: "seed-links", homeUrl: url, discoveredAt: at, status: "needs-review", entryHints: [{ url, format: url.endsWith(".csv") ? "csv" : url.endsWith(".md") ? "markdown" : "json" }], evidenceUrls: [url], warnings: [] };
}

test("GitHub repository discovery encodes queries and returns reviewed metadata without conflating activity with jobs", async () => {
  const run = execution(() => ({ total_count: 2, incomplete_results: false, items: [
    { full_name: "synthetic/jobs-2027", default_branch: "main", description: "Synthetic job source", pushed_at: "2026-10-17T00:00:00Z", license: null },
    { full_name: "synthetic/internships", default_branch: "dev", license: { spdx_id: "MIT" } },
  ] }));
  const query = "2027 internships in:name,description & C++";
  const result = await discoverSourceCandidates({ provider: "github-repositories", query, limit: 2 }, run);
  const request = new URL(run.requests[0]!);
  assert.equal(request.hostname, "api.github.com");
  assert.equal(request.pathname, "/search/repositories");
  assert.equal(request.searchParams.get("q"), query);
  assert.equal(request.searchParams.get("per_page"), "2");
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]!.status, "needs-review");
  assert.equal(result.candidates[0]!.repository!.pushedAtRaw, "2026-10-17T00:00:00Z");
  assert.equal(result.candidates[0]!.repository!.licenseSpdx, undefined);
  assert.ok(result.candidates[0]!.warnings.some((warning) => warning.includes("license is unknown")));
  assert.ok(result.candidates[1]!.warnings.some((warning) => warning.includes("does not automatically")));
  assert.equal(result.candidates[0]!.discoveredAt, at);
  assert.ok(run.chargedBytes() > 0);
  assert.equal(JSON.stringify(result).includes("availabilityVerifiedAt"), false);
});

test("GitHub search reports the upstream 1000-result cap, malformed omissions and continuation", async () => {
  const run = execution(() => ({ total_count: 3000, incomplete_results: true, items: [{ full_name: "synthetic/jobs" }, { full_name: "../invalid" }] }));
  const result = await discoverSourceCandidates({ provider: "github-repositories", query: "jobs", limit: 2 }, run);
  assert.equal(result.partial, true);
  assert.equal(result.totalAvailable, 3000);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.nextCursor, "2");
  assert.ok(result.warnings.some((warning) => warning.includes("1000")));
  assert.ok(result.warnings.some((warning) => warning.includes("omitted")));
});

test("seed discovery passes every user URL through the configured policy and never bypasses transport", async () => {
  const run = execution(() => []);
  const result = await discoverSourceCandidates({ provider: "seed-links", seedUrls: ["https://feeds.example.test/jobs.json", "https://feeds.example.test/list.csv"], limit: 1 }, run);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.partial, true);
  assert.equal(run.requests.length, 1);
  await assert.rejects(discoverSourceCandidates({ provider: "seed-links", seedUrls: ["https://unconfigured.example.test/jobs.json"] }, run), (error: unknown) => error instanceof ToolError && error.code === "not-authorized");
  assert.equal(run.requests.length, 1);
});

test("JSON inspection prefers a nested job array over unrelated metadata and proposes finite own paths", async () => {
  const payload = { metadata: { tags: [] }, data: { jobs: [
    { id: "1", title: "Synthetic engineer", company: "Synthetic company", description: "Synthetic JD", locations: ["Shanghai"], salary_text: "CNY 10k/month", url: "https://careers.example.test/1", updated_at: "2026年更新", __proto__: "never a field path" },
    { id: "2", title: "Synthetic designer", company: "Synthetic company", url: "https://careers.example.test/2" },
  ] } };
  const run = execution(() => payload);
  const result = await inspectSourceCandidate({ candidate: seed(), maxRecords: 1 }, run);
  const sample = result.samples[0]!;
  assert.equal(sample.format, "json");
  assert.equal(sample.recordsPath, "data.jobs");
  assert.equal(sample.totalRecords, 2);
  assert.equal(sample.sampledRecords, 1);
  assert.equal(sample.truncated, true);
  assert.equal(result.partial, true);
  assert.equal(sample.mappingProposal!.titlePath, "title");
  assert.equal(sample.mappingProposal!.recordsPath, "data.jobs");
  assert.equal(sample.mappingProposal!.discoveryOnly, true);
  assert.equal(sample.coverage.salary, true);
  assert.equal(sample.coverage.recordTime, true);
  assert.equal(sample.fields.some((field) => field.path.includes("__proto__")), false);
  assert.equal(JSON.stringify(sample).includes("Synthetic engineer"), false, "Shape inspection returns field statistics rather than copying record bodies.");
});

test("JSON inspection and mapping retain safe Chinese field names", async () => {
  const result = await inspectSourceCandidate({ candidate: seed() }, execution(() => ({ 岗位列表: [{ 职位: "合成岗位", 公司: "合成公司", 地点: "上海", 薪资: "面议" }] })));
  const sample = result.samples[0]!;
  assert.equal(sample.recordsPath, "岗位列表");
  assert.equal(sample.mappingProposal!.titlePath, "职位");
  assert.equal(sample.mappingProposal!.companyPath, "公司");
  assert.equal(sample.mappingProposal!.locationsPath, "地点");
  assert.equal(sample.mappingProposal!.salaryTextPath, "薪资");
});

test("CSV and Markdown inspection reports shapes without pretending a JSON adapter can parse them", async () => {
  const csvUrl = "https://feeds.example.test/jobs.csv";
  const csv = 'id,title,company,url,description\r\n1,"Engineer, tooling",Synthetic,https://careers.example.test/1,"Line one\nLine two"\r\n2,"Designer ""senior""",Synthetic,https://careers.example.test/2,=HYPERLINK(""unsafe"")';
  const csvResult = await inspectSourceCandidate({ candidate: seed(csvUrl), maxRecords: 1 }, execution(() => csv));
  assert.equal(csvResult.samples[0]!.format, "csv");
  assert.equal(csvResult.samples[0]!.sampledRecords, 1);
  assert.equal(csvResult.samples[0]!.truncated, true);
  assert.equal(csvResult.samples[0]!.coverage.title, true);
  assert.equal(csvResult.samples[0]!.mappingProposal, undefined);
  const mdUrl = "https://feeds.example.test/README.md";
  const markdown = "# Synthetic opportunities\n\n| title | company | url |\n| --- | --- | --- |\n| Engineer | Synthetic | https://careers.example.test/1 |\n| Designer | Synthetic | https://careers.example.test/2 |\n";
  const mdResult = await inspectSourceCandidate({ candidate: seed(mdUrl) }, execution(() => markdown));
  assert.equal(mdResult.samples[0]!.format, "markdown");
  assert.equal(mdResult.samples[0]!.sampledRecords, 2);
  assert.equal(mdResult.samples[0]!.coverage.url, true);
  assert.equal(mdResult.samples[0]!.mappingProposal, undefined);
  assert.ok(mdResult.samples[0]!.warnings.some((warning) => warning.includes("dedicated parser")));
});

test("GitHub inspection uses repository tree data and reads only bounded data samples", async () => {
  const candidate: SourceCandidate = { ...seed(), provider: "github-repositories", homeUrl: "https://github.com/synthetic/jobs", repository: { fullName: "synthetic/jobs", defaultBranch: "main" }, entryHints: [] };
  const run = execution((url) => url.hostname === "api.github.com" ? { truncated: true, tree: [
    { type: "blob", path: "jobs.json" }, { type: "blob", path: "README.md" }, { type: "blob", path: "data/listings.csv" },
    { type: "blob", path: "scripts/collect.ts" }, { type: "blob", path: "package.json" }, { type: "blob", path: "node_modules/evil/jobs.json" }, { type: "blob", path: "../outside.json" },
  ] } : url.pathname.endsWith(".json") ? [{ title: "Synthetic job", id: "1" }] : url.pathname.endsWith(".csv") ? "title,id\nSynthetic,1" : "# README\n");
  const result = await inspectSourceCandidate({ candidate }, run);
  assert.equal(run.requests.length, 4);
  assert.equal(result.samples.length, 3);
  assert.equal(result.partial, true);
  assert.ok(run.requests[0]!.includes("/repos/synthetic/jobs/git/trees/main?recursive=1"));
  assert.ok(run.requests.slice(1).every((url) => new URL(url).hostname === "raw.githubusercontent.com"));
  assert.equal(run.requests.some((url) => url.includes("collect.ts") || url.includes("package.json") || url.includes("node_modules") || url.includes("outside.json")), false);
});

test("registration proposals remain disabled leads with conservative usage even for MIT repositories", async () => {
  const candidate = { ...seed(), repository: { fullName: "synthetic/jobs", licenseSpdx: "MIT" } };
  const inspection = await inspectSourceCandidate({ candidate }, execution(() => [{ id: "1", title: "Engineer", url: "https://careers.example.test/1" }]));
  const proposal = await proposeSourceRegistration({ candidate, sample: inspection.samples[0]!, name: "Synthetic discovered feed" });
  assert.equal(proposal.source.enabled, false);
  assert.equal(proposal.source.status, "needs-review");
  assert.equal(proposal.source.adapterId, "mapped-json");
  assert.equal(proposal.source.entityType, "company-directory");
  assert.equal(proposal.source.options!.discoveryOnly, true);
  assert.equal(proposal.source.attribution.usage, "link-only");
  assert.equal(proposal.source.attribution.license, "MIT");
  assert.equal(proposal.source.refreshPolicy.mode, "manual");
  assert.deepEqual(proposal.source.endpointPolicy.allowedHosts, ["feeds.example.test"]);
  assert.deepEqual(proposal.source.endpointPolicy.allowedPathPrefixes, ["/jobs.json"]);
  const noLicense = await proposeSourceRegistration({ candidate: seed(), sample: inspection.samples[0]!, name: "Unlicensed synthetic feed" });
  assert.equal(noLicense.source.attribution.license, undefined);
  assert.equal(noLicense.source.attribution.usage, "link-only");
});

test("unsupported formats produce review-only proposals without executable capabilities", async () => {
  const candidate = seed("https://feeds.example.test/jobs.csv");
  const inspection = await inspectSourceCandidate({ candidate }, execution(() => "title,id\nEngineer,1"));
  const proposal = await proposeSourceRegistration({ candidate, sample: inspection.samples[0]!, name: "Synthetic CSV" });
  assert.equal(proposal.source.adapterId, "review-required-csv");
  assert.deepEqual(proposal.source.capabilities, []);
  assert.equal(proposal.source.enabled, false);
  assert.ok(proposal.reviewRequired.some((step) => step.includes("parser adapter")));
});

test("inspection cannot execute scripts, access prototype paths, or silently consume malformed inputs", async () => {
  assert.equal(DiscoverSourceCandidatesInputSchema.safeParse({ provider: "github-repositories", seedUrls: ["https://feeds.example.test/jobs.json"] }).success, false);
  assert.equal(DiscoverSourceCandidatesInputSchema.safeParse({ provider: "seed-links", seedUrls: ["file:///C:/private"] }).success, false);
  assert.equal(SourceCandidateSchema.safeParse({ ...seed(), run: "powershell.exe" }).success, false);
  const payload = '{"jobs":[{"id":"1","title":"Synthetic","__proto__":{"command":"never"},"constructor":{"script":"never"}}]}';
  const result = await inspectSourceCandidate({ candidate: seed() }, execution(() => payload));
  assert.equal(result.samples[0]!.fields.some((field) => /__proto__|constructor/.test(field.path)), false);
  await assert.rejects(inspectSourceCandidate({ candidate: seed() }, execution(() => "not JSON")), (error: unknown) => error instanceof ToolError && error.code === "source-changed");
  await assert.rejects(inspectSourceCandidate({ candidate: seed("https://feeds.example.test/jobs.csv") }, execution(() => 'title,id\n"unterminated,1')), (error: unknown) => error instanceof ToolError && error.code === "source-changed");
});

test("discovery and inspection preserve transport cancellation and budget failures", async () => {
  const cancelled = execution(() => []);
  cancelled.context.throwIfCancelled = () => { throw new ToolError("cancelled"); };
  await assert.rejects(discoverSourceCandidates({ provider: "seed-links", seedUrls: ["https://feeds.example.test/jobs.json"] }, cancelled), (error: unknown) => error instanceof ToolError && error.code === "cancelled");
  assert.equal(cancelled.requests.length, 0);
  await assert.rejects(inspectSourceCandidate({ candidate: seed() }, execution(() => " ".repeat(2 * 1024 * 1024 + 1))), (error: unknown) => error instanceof ToolError && error.code === "budget-exceeded");
});
