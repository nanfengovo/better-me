import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, ToolError, type SourceDefinition } from "@better-me/opportunities";
import { jobPostingJsonLdAdapter } from "../src/adapters/jobposting-jsonld.js";
import { createSourceRegistry } from "../src/registry.js";
import { SourceTransportError } from "../src/transport.js";
import { countSourceScopeMatches } from "../src/local-match.js";
import type { SourceAdapterContext, SourceAdapterRequest, SourceTransportResponse } from "../src/contracts.js";

const AT = "2026-10-19T00:00:00.000Z";
const ORIGIN = "https://careers.synthetic-company.com";
const LIST = `${ORIGIN}/reviewed/list.xml`;
const LIST2 = `${ORIGIN}/reviewed/second.xml`;
const posting = (id: string | number) => `${ORIGIN}/jobs/${id}`;
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const manifest = (urls: string[]) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeXml(url)}</loc></url>`).join("")}</urlset>`;

function context(controller = new AbortController()): SourceAdapterContext {
  return { observedAt: AT, requestId: "synthetic-jsonld", actorScope: "synthetic-user", signal: controller.signal,
    budget: { requests: 100, bytes: 2_000_000, timeoutMs: 5000 }, consumeRequests: () => {}, consumeBytes: () => {},
    throwIfCancelled: () => { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
}
function source(options: SourceDefinition["options"] = {}): SourceDefinition {
  return SourceDefinitionSchema.parse({ sourceId: "synthetic-jsonld", name: "Synthetic reviewed company",
    adapterId: "jobposting-jsonld", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"],
    entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], entryUrl: LIST,
    options: { enumerationKind: "sitemap-urlset", enumerationUrls: [LIST], postingPathPrefixes: ["/jobs/"], pageSize: 2, ...options },
    endpointPolicy: { allowedHosts: ["careers.synthetic-company.com"], allowedPathPrefixes: ["/reviewed", "/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic official source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 10, maxPages: 10, requestsPerMinute: 100 } });
}
function detail(url: string, changes: Record<string, unknown> = {}): string {
  const id = new URL(url).pathname.split("/").at(-1)!;
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting",
    title: `Synthetic systems engineer ${id}`, url, identifier: { "@type": "PropertyValue", value: id },
    hiringOrganization: { "@type": "Organization", name: "Synthetic Organization" },
    description: "<p>Build C# and .NET services with source evidence.</p>", datePosted: "2026-10-01",
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "CN", addressLocality: "Shanghai" } }, ...changes })}</script></head></html>`;
}
function fixture(ids: Array<string | number> = [1, 2], options: SourceDefinition["options"] = {}) {
  const calls: Array<{ url: string; headers?: Readonly<Record<string, string>> }> = [];
  const input: SourceAdapterRequest = { source: source(options), scope: { roles: ["C#"], regions: ["Shanghai"], companyNames: ["Synthetic"] },
    context: context(), transport: { request: async ({ url, headers, source: passedSource, context: passedContext }) => {
      assert.deepEqual(passedSource, input.source); assert.equal(passedContext, input.context);
      calls.push({ url, ...(headers ? { headers } : {}) });
      return { url, status: 200, headers: {}, text: url === LIST ? manifest(ids.map(posting)) : detail(url) };
    } } };
  return { input, calls };
}
function replace(input: SourceAdapterRequest, handler: (url: string) => Partial<SourceTransportResponse> | undefined) {
  const previous = input.transport;
  input.transport = { request: async (args) => {
    const response = await previous.request(args), override = handler(args.url);
    return override ? { ...response, ...override } : response;
  } };
}
const toolCode = (expected: string) => (error: unknown) => error instanceof ToolError && error.code === expected;

test("metadata implements only list-jobs and complete pages count actual detail attempts, not manifest links", async () => {
  const { input, calls } = fixture(); input.scope.countryCodes = ["CN"];
  const registry = createSourceRegistry([jobPostingJsonLdAdapter]);
  assert.deepEqual(registry.describe()[0], { adapterId: "jobposting-jsonld", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"] });
  assert.throws(() => registry.resolve(input.source, "read-detail"), /支持/);
  const result = await registry.list(input);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1), posting(2)]);
  assert.ok(calls[0]!.headers!.accept!.includes("application/xml"));
  assert.ok(calls[1]!.headers!.accept!.includes("text/html"));
  assert.equal(result.records.length, 2); assert.equal(result.coverage.fetchedRecords, 2);
  assert.equal(result.coverage.totalAvailable, undefined); assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.partial, false); assert.equal(result.nextCursor, undefined);
  assert.deepEqual(result.coverage.appliedFilters, []); assert.deepEqual(result.coverage.ignoredFilters, ["roles", "regions", "companyNames"]);
  assert.ok(result.warnings.some((warning) => warning.includes("whole market")));
  assert.ok(result.warnings.some((warning) => warning.includes("Country-code constraints")));
  assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 2, unknown: 0, excluded: 0 });
  const job = result.records[0]!;
  assert.equal(job.url, posting(1)); assert.equal(job.sourcePublishedRaw, "2026-10-01"); assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(job.companyName, "Synthetic Organization"); assert.equal(job.availability, "unknown");
  assert.equal(job.completeness, "detail"); assert.ok(job.description!.includes("C#"));
  assert.equal((job.locations[0] as unknown as Record<string, unknown>).coordinates, undefined);
});

test("cursor re-reads manifests and resumes correctly as remaining maxRecords decreases", async () => {
  const { input, calls } = fixture([1, 2, 3, 4, 5]);
  const first = await jobPostingJsonLdAdapter.list(input);
  assert.equal(first.coverage.fetchedRecords, 2); assert.ok(first.nextCursor); assert.equal(first.coverage.partial, false);
  assert.equal(first.coverage.complete, false);
  input.cursor = first.nextCursor; input.source.refreshPolicy.maxRecords = 1;
  const second = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(second.records.map((record) => record.url), [posting(3)]); assert.ok(second.nextCursor);
  input.cursor = second.nextCursor; input.source.refreshPolicy.maxRecords = 2;
  const third = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(third.records.map((record) => record.url), [posting(4), posting(5)]);
  assert.equal(third.coverage.complete, true); assert.equal(third.nextCursor, undefined);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1), posting(2), LIST, posting(3), LIST, posting(4), posting(5)]);
});

test("multiple manifests are deduplicated and only actually listed reviewed priority URLs move to the front", async () => {
  const { input, calls } = fixture([1, 2], { enumerationUrls: [LIST, LIST2], pageSize: 5,
    priorityPostingUrls: [posting(3), posting("absent")] });
  replace(input, (url) => url === LIST2 ? { text: manifest([posting(2), posting(3)]) } : undefined);
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(calls.map((call) => call.url), [LIST, LIST2, posting(3), posting(1), posting(2)]);
  assert.deepEqual(result.records.map((record) => record.url), [posting(3), posting(1), posting(2)]);
  assert.equal(result.coverage.fetchedRecords, 3); assert.equal(result.coverage.complete, true);
  assert.ok(result.warnings.some((warning) => warning.includes("Priority URLs absent")));
});

test("html-list uses static links, preserves posting query identity and never follows pagination or sitemap indices", async () => {
  const queried = `${posting(1)}?locale=en&track=reviewed`;
  const { input, calls } = fixture([], { enumerationKind: "html-list" });
  replace(input, (url) => url === LIST ? { text: `<a href="${queried.replaceAll("&", "&amp;")}">Job</a><a href="/reviewed/page2">Next</a><a href="https://other.example.com/jobs/2">Other</a><a href="/jobs-fake/3">Bad prefix</a>` } : undefined);
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(calls.map((call) => call.url), [LIST, queried]);
  assert.equal(result.records[0]!.url, queried); assert.equal(result.coverage.fetchedRecords, 1);
  assert.ok(calls[0]!.headers!.accept!.includes("text/html"));
});

test("empty or dynamic-only reviewed lists remain partial instead of claiming no vacancies", async () => {
  for (const kind of ["sitemap-urlset", "html-list"]) {
    const { input, calls } = fixture([], { enumerationKind: kind });
    if (kind === "html-list") replace(input, (url) => url === LIST ? { text: "<html><main>Loading jobs</main><script>fetch('/api/jobs')</script></html>" } : undefined);
    const result = await jobPostingJsonLdAdapter.list(input);
    assert.equal(calls.length, 1); assert.equal(result.records.length, 0); assert.equal(result.coverage.fetchedRecords, 0);
    assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false); assert.equal(result.stopReason, "source-error");
    assert.ok(result.warnings.some((warning) => warning.includes("no vacancies")));
  }
});

test("a missing JSON-LD final detail is partial and attempted once, not an empty complete page", async () => {
  const { input, calls } = fixture([1]); replace(input, (url) => url === posting(1) ? { text: "<h1>A job-like heading without structured data</h1>" } : undefined);
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.equal(result.records.length, 0); assert.equal(result.coverage.fetchedRecords, 1);
  assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false); assert.equal(result.nextCursor, undefined);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1)]);
});

test("ordinary detail errors and changed structured identity retain other records and continue within the allowance", async () => {
  for (const failedDetail of [
    { status: 404, text: "Not found" },
    { text: detail(posting(2), { url: posting("different-job") }) },
    { url: posting("different-page") },
    { text: "<script type=\"application/ld+json\">{not json}</script>" },
  ]) {
    const { input, calls } = fixture([1, 2, 3], { pageSize: 3 });
    replace(input, (url) => url === posting(2) ? failedDetail : undefined);
    const result = await jobPostingJsonLdAdapter.list(input);
    assert.deepEqual(result.records.map((record) => record.url), [posting(1), posting(3)]);
    assert.equal(result.coverage.fetchedRecords, 3); assert.equal(result.coverage.partial, true); assert.equal(result.coverage.complete, false);
    assert.equal(result.nextCursor, undefined); assert.equal(calls.length, 4);
  }
});

test("recoverable transport detail failures keep earlier records and preserve a continuation over attempted URLs", async () => {
  for (const error of [new SourceTransportError("http-error", 500), new SourceTransportError("response-too-large"), new SourceTransportError("invalid-response")]) {
    const { input } = fixture([1, 2, 3]); const transport = input.transport;
    input.transport = { request: async (args) => { if (args.url === posting(2)) throw error; return transport.request(args); } };
    const result = await jobPostingJsonLdAdapter.list(input);
    assert.deepEqual(result.records.map((record) => record.url), [posting(1)]); assert.equal(result.coverage.fetchedRecords, 2);
    assert.equal(result.coverage.partial, true); assert.ok(result.nextCursor);
    assert.equal(result.retryCurrentPage, undefined);
    input.cursor = result.nextCursor;
    const next = await jobPostingJsonLdAdapter.list(input);
    assert.deepEqual(next.records.map((record) => record.url), [posting(3)]); assert.equal(next.coverage.complete, true);
  }
});

test("detail timeout stops further requests and pagination while retaining downloaded records", async () => {
  const { input, calls } = fixture([1, 2, 3, 4], { pageSize: 3 }); const transport = input.transport;
  input.transport = { request: async (args) => { if (args.url === posting(2)) { calls.push({ url: args.url }); throw new SourceTransportError("timeout"); } return transport.request(args); } };
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(result.records.map((record) => record.url), [posting(1)]); assert.equal(result.coverage.fetchedRecords, 2);
  assert.equal(result.nextCursor, undefined); assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "source-error");
  assert.equal(result.retryCurrentPage, true);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1), posting(2)]);
  assert.ok(result.warnings.some((warning) => warning.includes("timed out")));
});

test("permissions, rate limits, unsafe endpoints, cancellation and budget failures are never softened into success", async () => {
  const errors = [new SourceTransportError("http-error", 401), new SourceTransportError("http-error", 403),
    new SourceTransportError("rate-limited", 429, 120), new SourceTransportError("unsafe-endpoint"),
    new SourceTransportError("cancelled"), new ToolError("cancelled"), new ToolError("budget-exceeded")];
  for (const failure of errors) {
    const { input } = fixture(); const transport = input.transport;
    input.transport = { request: async (args) => { if (args.url === posting(2)) throw failure; return transport.request(args); } };
    await assert.rejects(jobPostingJsonLdAdapter.list(input), (error: unknown) => error === failure);
  }
});

test("non-throwing transport HTTP errors still preserve permission and rate-limit boundaries", async () => {
  for (const status of [401, 403, 429]) {
    const { input } = fixture(); replace(input, (url) => url === posting(1) ? { status } : undefined);
    await assert.rejects(jobPostingJsonLdAdapter.list(input), (error: unknown) => error instanceof SourceTransportError
      && error.status === status && error.code === (status === 429 ? "rate-limited" : "http-error"));
  }
});

test("manifest response identity, format and HTTP failures stop before any details", async () => {
  for (const change of [
    { url: LIST2 }, { text: "<sitemapindex><sitemap><loc>https://careers.synthetic-company.com/reviewed/child.xml</loc></sitemap></sitemapindex>" },
    { text: "<urlset><url>" }, { status: 404 },
  ]) {
    const { input, calls } = fixture(); replace(input, (url) => url === LIST ? change : undefined);
    await assert.rejects(jobPostingJsonLdAdapter.list(input));
    assert.deepEqual(calls.map((call) => call.url), [LIST]);
  }
});

test("changed manifest queue rejects a prior cursor before downloading any further job pages", async () => {
  const { input, calls } = fixture([1, 2, 3]); input.cursor = (await jobPostingJsonLdAdapter.list(input)).nextCursor;
  calls.length = 0; replace(input, (url) => url === LIST ? { text: manifest([posting(1), posting(2), posting(4)]) } : undefined);
  await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("source-changed"));
  assert.deepEqual(calls.map((call) => call.url), [LIST]);
});

test("config and all scope identities bind cursors before any new request", async () => {
  const alterations: Array<(input: SourceAdapterRequest) => void> = [
    (input) => { input.source.sourceId = "other-source"; },
    (input) => { input.source.options!.pageSize = 1; },
    (input) => { input.source.options!.priorityPostingUrls = [posting(3)]; },
    (input) => { input.source.entryUrl = LIST2; },
    (input) => { input.source.endpointPolicy.allowedPathPrefixes.push("/another-reviewed"); },
    (input) => { input.scope.roles = ["Python"]; },
    (input) => { input.scope.regions = ["Beijing"]; },
    (input) => { input.scope.companyNames = ["Another"]; },
    (input) => { input.scope.countryCodes = ["US"]; },
  ];
  for (const alter of alterations) {
    const { input, calls } = fixture([1, 2, 3]); input.cursor = (await jobPostingJsonLdAdapter.list(input)).nextCursor;
    calls.length = 0; alter(input);
    await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("invalid-input")); assert.equal(calls.length, 0);
  }
});

test("malformed and tampered cursors fail before any network work", async () => {
  const { input, calls } = fixture([1, 2, 3]);
  const result = await jobPostingJsonLdAdapter.list(input), valid = JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString("utf8"));
  for (const cursor of ["", "=bad=", "x".repeat(2001), Buffer.from("not-json").toString("base64url"),
    ...[{ ...valid, offset: -1 }, { ...valid, offset: 0 }, { ...valid, offset: 10001 }, { ...valid, extra: true },
      { ...valid, version: 2 }, { ...valid, fingerprint: "0".repeat(64) }].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))]) {
    input.cursor = cursor; calls.length = 0;
    await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("invalid-input")); assert.equal(calls.length, 0);
  }
});

test("cursor past the refreshed manifest queue is rejected rather than reporting a complete empty page", async () => {
  const { input, calls } = fixture([1, 2, 3]);
  const first = await jobPostingJsonLdAdapter.list(input), cursor = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  input.cursor = Buffer.from(JSON.stringify({ ...cursor, offset: 3 })).toString("base64url"); calls.length = 0;
  await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("source-changed")); assert.deepEqual(calls.map((call) => call.url), [LIST]);
});

test("cancelled contexts stop before manifests and cancellation after a successful fetch stops before parsing or the next request", async () => {
  const { input, calls } = fixture(); const controller = new AbortController(); input.context = context(controller);
  controller.abort(); await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("cancelled")); assert.equal(calls.length, 0);
  const second = fixture(); const secondController = new AbortController(); second.input.context = context(secondController);
  const transport = second.input.transport;
  second.input.transport = { request: async (args) => { const result = await transport.request(args); if (args.url === posting(1)) secondController.abort(); return result; } };
  await assert.rejects(jobPostingJsonLdAdapter.list(second.input), toolCode("cancelled"));
  assert.deepEqual(second.calls.map((call) => call.url), [LIST, posting(1)]);
});

test("a manifest parser byte-budget failure is propagated before any candidate detail request", async () => {
  const { input, calls } = fixture(); replace(input, (url) => url === LIST ? { text: " ".repeat(2 * 1024 * 1024 + 1) } : undefined);
  await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("budget-exceeded")); assert.deepEqual(calls.map((call) => call.url), [LIST]);
});

test("a detail reader byte-budget failure is propagated even after an earlier record succeeded", async () => {
  const { input } = fixture(); replace(input, (url) => url === posting(2) ? { text: " ".repeat(2 * 1024 * 1024 + 1) } : undefined);
  await assert.rejects(jobPostingJsonLdAdapter.list(input), toolCode("budget-exceeded"));
});

test("per-document enumeration truncation remains partial and counts only the bounded detail reads", async () => {
  const { input, calls } = fixture(Array.from({ length: 10_001 }, (_value, index) => index + 1), { pageSize: 1 });
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.equal(result.records.length, 1); assert.equal(result.coverage.fetchedRecords, 1);
  assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "record-limit"); assert.ok(result.nextCursor);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1)]);
  assert.ok(result.warnings.some((warning) => warning.includes("bound")));
});

test("combined manifest queues are bounded independently of each document and absent tail priorities are never invented", async () => {
  const { input, calls } = fixture(Array.from({ length: 6000 }, (_value, index) => index + 1), {
    enumerationUrls: [LIST, LIST2], pageSize: 1, priorityPostingUrls: [posting(11_000)],
  });
  replace(input, (url) => url === LIST2 ? { text: manifest(Array.from({ length: 6000 }, (_value, index) => posting(index + 6001))) } : undefined);
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(calls.map((call) => call.url), [LIST, LIST2, posting(1)]);
  assert.equal(result.coverage.fetchedRecords, 1); assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "record-limit");
  assert.ok(result.warnings.some((warning) => warning.includes("10000 unique candidate URLs")));
  assert.ok(result.warnings.some((warning) => warning.includes("Priority URLs absent")));
});

test("equivalent URL syntax is canonicalized before requests while structured page identity remains exact", async () => {
  const { input, calls } = fixture([1]);
  const configured = "https://CAREERS.SYNTHETIC-COMPANY.COM/reviewed/list.xml";
  input.source.entryUrl = configured; input.source.options!.enumerationUrls = [configured];
  input.source.options!.priorityPostingUrls = ["https://CAREERS.SYNTHETIC-COMPANY.COM/jobs/1"];
  const result = await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual(calls.map((call) => call.url), [LIST, posting(1)]); assert.equal(result.coverage.complete, true);
  assert.equal(result.records[0]!.url, posting(1));
});

test("source scope and source configuration are not mutated during enumeration or continuation", async () => {
  const { input } = fixture([1, 2, 3]); const before = structuredClone({ source: input.source, scope: input.scope });
  const result = await jobPostingJsonLdAdapter.list(input); input.cursor = result.nextCursor;
  await jobPostingJsonLdAdapter.list(input);
  assert.deepEqual({ source: input.source, scope: input.scope }, before);
});
