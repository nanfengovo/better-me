import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, ToolError, type SourceDefinition } from "@better-me/opportunities";
import { createSourceRegistry } from "../src/registry.js";
import { jobPostingJsonLdAdapter } from "../src/adapters/jobposting-jsonld.js";
import { smartRecruitersAdapter } from "../src/adapters/smartrecruiters.js";
import { greenhouseAdapter } from "../src/adapters/greenhouse.js";
import { SourceRegistryError, type SourceAdapter, type SourceAdapterContext, type SourceAdapterOriginalRequest,
  type SourceJobRecord, type SourceTransportResponse } from "../src/contracts.js";
import { createControlledSourceTransport, SourceTransportError } from "../src/transport.js";

const AT = "2026-10-23T00:00:00.000Z";
const ORIGIN = "https://careers.synthetic-company.com";
const LIST = `${ORIGIN}/reviewed/list.xml`;
const URL = `${ORIGIN}/jobs/original-987`;
const SR_API = "https://api.smartrecruiters.com/v1/companies/SyntheticOrg/postings";
const SR_URL = "https://jobs.smartrecruiters.com/SyntheticOrg/123-synthetic-role";
function context(controller = new AbortController()): SourceAdapterContext {
  return { observedAt: AT, requestId: "synthetic-original", actorScope: "synthetic-user", signal: controller.signal,
    budget: { requests: 1, bytes: 200_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {},
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
}
function source(adapter = "jobposting-jsonld", changes: Partial<SourceDefinition> = {}): SourceDefinition {
  return SourceDefinitionSchema.parse({ sourceId: "synthetic-original", name: "Synthetic source", adapterId: adapter, adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    entryUrl: adapter === "smartrecruiters" ? SR_API : LIST,
    options: adapter === "smartrecruiters" ? { companyIdentifier: "SyntheticOrg", companyName: "Configured company is not original evidence", fetchDetails: false }
      : { enumerationKind: "sitemap-urlset", enumerationUrls: [LIST], postingPathPrefixes: ["/jobs/"], pageSize: 1, companyName: "Configured company is not original evidence" },
    endpointPolicy: { allowedHosts: [adapter === "smartrecruiters" ? "api.smartrecruiters.com" : "careers.synthetic-company.com"],
      allowedPathPrefixes: adapter === "smartrecruiters" ? ["/v1/companies/SyntheticOrg/postings"] : ["/reviewed", "/jobs"],
      requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 1, maxPages: 1, requestsPerMinute: 10 }, ...changes });
}
function posting(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { "@type": "JobPosting", url: URL, identifier: "original-987", title: "Synthetic role", description: "<p>Build C# tools.</p>",
    hiringOrganization: { name: "Original Synthetic Employer" }, datePosted: "2026-09-01",
    jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Synthetic road 987", postalCode: "00987" },
      geo: { latitude: 31, longitude: 121 } }, ...changes };
}
const script = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
function srDetail(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "123", name: "Synthetic role", company: { identifier: "SyntheticOrg", name: "Original Synthetic Employer" },
    ref: `${SR_API}/123`, postingUrl: SR_URL, releasedDate: "2026-09-01",
    location: { city: "Shanghai", country: "cn", address: "Synthetic road 987", postalCode: "00987", latitude: 31, longitude: 121 },
    jobAd: { sections: { jobDescription: { text: "<p>Build tools.</p>" }, qualifications: { text: "<p>Use C#.</p>" } } }, ...changes };
}
function fixture(adapter = "jobposting-jsonld", response?: Partial<SourceTransportResponse>) {
  const calls: string[] = [];
  const request: SourceAdapterOriginalRequest = { source: source(adapter), url: adapter === "smartrecruiters" ? SR_URL : URL, context: context(),
    transport: { async request(input) { calls.push(input.url); assert.deepEqual(input.source, request.source);
      return { url: input.url, status: 200, headers: {}, text: adapter === "smartrecruiters" ? JSON.stringify(srDetail()) : script(posting()), ...response }; } } };
  return { request, calls };
}
const registry = () => createSourceRegistry([jobPostingJsonLdAdapter, smartRecruitersAdapter]);
const code = (expected: string) => (error: unknown) => (error instanceof SourceRegistryError || error instanceof ToolError || error instanceof SourceTransportError) && error.code === expected;
function syntheticRecord(changes: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "original-987", url: URL, title: "Synthetic role", locations: [], compensations: [],
    workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt", evidence: [], warnings: [], ...changes };
}
function syntheticAdapter(readOriginal: NonNullable<SourceAdapter["readOriginal"]>): SourceAdapter {
  return { adapterId: "jobposting-jsonld", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"], readOriginal,
    async list() { throw new Error("Original reading must not enumerate listings."); } };
}

test("original reads expose an installed method without creating a new declared source capability or metadata function", async () => {
  const installed = registry(), { request } = fixture();
  assert.equal(typeof installed.resolve(request.source, "list-jobs", "local-service").adapter.readOriginal, "function");
  assert.ok(installed.describe().every(item => !Object.hasOwn(item, "readOriginal") && !Object.hasOwn(item, "matchesOriginalUrl") && !Object.hasOwn(item, "readDetail") && !Object.hasOwn(item, "list")));
  assert.deepEqual(installed.describe().map(item => item.capabilities), [["list-jobs"], ["list-jobs"]]);
  assert.throws(() => installed.resolve(request.source, "read-original" as never), code("unsupported-capability"));
  const bound = syntheticAdapter(async function () { assert.equal(this.adapterId, "jobposting-jsonld"); return syntheticRecord(); });
  assert.equal((await createSourceRegistry([bound]).readOriginal(request)).sourceRecordId, "original-987");
  assert.throws(() => createSourceRegistry([{ ...bound, readOriginal: true } as unknown as SourceAdapter]), code("invalid-source"));
  assert.throws(() => createSourceRegistry([{ ...bound, matchesOriginalUrl: true } as unknown as SourceAdapter]), code("invalid-source"));
});

test("original eligibility uses pure installed URL validators and rejects another origin, path or tenant without reading", () => {
  const installed = registry();
  for (const adapter of ["jobposting-jsonld", "smartrecruiters"]) {
    const { request, calls } = fixture(adapter);
    assert.equal(installed.matchesOriginalUrl(request.source, request.url), true);
    for (const url of [request.url.replace("https://", "http://"), request.url.replace("https://", "https://user:pass@"),
      `${request.url}#other`, request.url.replace("original-987", "%2foriginal-987").replace("/123-", "/%31%32%33-"),
      request.url.replace("careers.synthetic-company.com", "other.example.com").replace("jobs.smartrecruiters.com", "other.example.com"),
      request.url.replace("/jobs/", "/not-jobs/").replace("/SyntheticOrg/", "/OtherOrg/")]) {
      assert.equal(installed.matchesOriginalUrl(request.source, url), false, url);
    }
    for (const changes of [{ enabled: false }, { status: "needs-review" as const }, { entityType: "discovery-lead" as const },
      { runtime: ["server"] as SourceDefinition["runtime"] }, { capabilities: [] }, { adapterVersion: "not-installed" },
      { entryUrl: "https://other.example.com/list" }]) {
      assert.equal(installed.matchesOriginalUrl({ ...request.source, ...changes }, request.url), false);
    }
    assert.equal(installed.matchesOriginalUrl(request.source, "file:///bad"), false);
    assert.equal(installed.matchesOriginalUrl(null as unknown as SourceDefinition, request.url), false);
    assert.deepEqual(calls, []);
  }
});

test("original eligibility binds the installed hook and defaults to false for missing, throwing or nonboolean hooks", () => {
  const { request } = fixture();
  for (const hook of [undefined, () => { throw new Error("synthetic validator failure"); }, (() => "yes") as never, (() => Promise.resolve(true)) as never]) {
    const adapter = { ...syntheticAdapter(async () => { throw new Error("must not read"); }), ...(hook ? { matchesOriginalUrl: hook } : {}) };
    assert.equal(createSourceRegistry([adapter]).matchesOriginalUrl(request.source, request.url), false);
  }
  let checks = 0;
  const adapter: SourceAdapter = { ...syntheticAdapter(async () => { throw new Error("must not read"); }), matchesOriginalUrl(input) {
    assert.equal(this.adapterId, "jobposting-jsonld"); assert.deepEqual(input, { source: request.source, url: request.url }); checks++; return true;
  } };
  assert.equal(createSourceRegistry([adapter]).matchesOriginalUrl(request.source, request.url), true); assert.equal(checks, 1);
  assert.equal(createSourceRegistry([{ ...adapter, readOriginal: undefined }]).matchesOriginalUrl(request.source, request.url), false); assert.equal(checks, 1);
});

test("original reads require active local-service list-jobs authorization on a job-posting source", async () => {
  let calls = 0;
  const installed = createSourceRegistry([syntheticAdapter(async () => { calls++; return syntheticRecord(); })]);
  const { request } = fixture();
  for (const changes of [{ enabled: false }, { status: "needs-review" as const }, { status: "disabled" as const }]) {
    await assert.rejects(installed.readOriginal({ ...request, source: source("jobposting-jsonld", changes) }), code("source-disabled"));
  }
  for (const changes of [{ runtime: ["server"] as SourceDefinition["runtime"] }, { capabilities: [] }, { entityType: "recruitment-campaign" as const }]) {
    await assert.rejects(installed.readOriginal({ ...request, source: source("jobposting-jsonld", changes) }), code("unsupported-capability"));
  }
  await assert.rejects(createSourceRegistry([greenhouseAdapter]).readOriginal({ ...request, source: source("greenhouse") }), code("unsupported-capability"));
  assert.equal(calls, 0);
});

test("original request validation rejects a lead ID, scope, cursor, malformed URL/time or missing execution functions", async () => {
  const { request, calls } = fixture(), installed = registry();
  for (const changes of [{ sourceRecordId: "discovery-lead-id" }, { scope: { roles: [], regions: [], companyNames: [] } }, { cursor: "1" },
    { url: "file:///bad" }, { context: { ...context(), observedAt: "yesterday" } },
    { context: { ...context(), throwIfCancelled: true } }, { transport: { request: true } }]) {
    await assert.rejects(installed.readOriginal({ ...request, ...changes } as SourceAdapterOriginalRequest), code("invalid-source"));
  }
  await assert.rejects(installed.readOriginal(null as unknown as SourceAdapterOriginalRequest), code("invalid-source"));
  assert.equal(calls.length, 0);
});

test("original registry validates returned URL, job entity, explicit record identity and unchanged observation time", async () => {
  const { request } = fixture();
  for (const output of [syntheticRecord({ url: `${ORIGIN}/jobs/other` }), syntheticRecord({ sourceRecordId: undefined }),
    syntheticRecord({ sourceRecordId: " " }), syntheticRecord({ sourceRecordId: "bad\nID" }),
    syntheticRecord({ entityType: "discovery-lead", completeness: "lead" }), { ...syntheticRecord(), secret: "forbidden" }]) {
    await assert.rejects(createSourceRegistry([syntheticAdapter(async () => output)]).readOriginal(request), code("invalid-output"));
  }
  const installed = createSourceRegistry([syntheticAdapter(async ({ context }) => { context.observedAt = "2026-10-24T00:00:00.000Z"; return syntheticRecord(); })]);
  await assert.rejects(installed.readOriginal({ ...request, context: context() }), code("invalid-output"));
});

test("original registry returns parsed copies and checks cancellation before and after adapter execution", async () => {
  const { request } = fixture(), original = syntheticRecord(); let calls = 0;
  const installed = createSourceRegistry([syntheticAdapter(async () => { calls++; return original; })]);
  const result = await installed.readOriginal(request); result.title = "Changed by caller"; assert.equal(original.title, "Synthetic role");
  const early = new AbortController(); early.abort();
  await assert.rejects(installed.readOriginal({ ...request, context: context(early) }), code("cancelled")); assert.equal(calls, 1);
  const late = new AbortController();
  const cancelled = createSourceRegistry([syntheticAdapter(async () => { late.abort(); return original; })]);
  await assert.rejects(cancelled.readOriginal({ ...request, context: context(late) }), code("cancelled"));
});

test("JSON-LD original reading gets one reviewed page and derives identity from its literal JobPosting without enumerating manifests", async () => {
  const { request, calls } = fixture();
  const result = await registry().readOriginal(request);
  assert.deepEqual(calls, [URL]); assert.equal(result.sourceRecordId, "original-987"); assert.equal(result.url, URL);
  assert.equal(result.companyName, "Original Synthetic Employer"); assert.equal(result.description, "Build C# tools.");
  assert.equal(result.sourcePublishedRaw, "2026-09-01"); assert.equal(result.sourcePublishedAt, undefined);
  assert.deepEqual(result.locations, [{ raw: "Synthetic road 987, Shanghai, 00987, CN", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic road 987", postalCode: "00987" }]);
  assert.doesNotMatch(JSON.stringify(result.locations), /coordinates|latitude|longitude/);
  assert.ok(result.evidence.some(item => item.field === "sourceRecordId" && item.quote === "original-987" && item.sourceUrl === URL));
});

test("JSON-LD original reading keeps the reviewed source origin, posting path and enumeration configuration constraints", async () => {
  for (const url of [`${ORIGIN}/jobs-fake/original-987`, "https://other.example.com/jobs/original-987", `${ORIGIN}/jobs/../admin`,
    `${ORIGIN}/jobs/%2e%2e/admin`, `${ORIGIN}/jobs/a%2fb`, `${ORIGIN}/jobs/bad%zz`, `${URL}#other`, `${ORIGIN}/jobs/a\\b`,
    `${ORIGIN.replace("https://", "https://user:pass@")}/jobs/original-987`]) {
    const { request, calls } = fixture();
    await assert.rejects(registry().readOriginal({ ...request, url }), error => code("invalid-input")(error) || code("invalid-source")(error)); assert.equal(calls.length, 0);
  }
  const { request, calls } = fixture(); request.source.options = { ...request.source.options, enumerationUrls: [`${ORIGIN}/other/list.xml`] };
  await assert.rejects(registry().readOriginal(request), code("invalid-input")); assert.equal(calls.length, 0);
});

test("JSON-LD original reading rejects another response page, conflicting or missing identities and multiple distinct postings", async () => {
  for (const response of [{ url: `${ORIGIN}/jobs/other` }, { text: script(posting({ identifier: undefined })) },
    { text: script(posting({ url: `${ORIGIN}/jobs/other` })) }, { text: script(posting({ identifier: ["one", "two"] })) },
    { text: script([posting(), posting({ identifier: "other", title: "Other role" })]) },
    { text: script({ "@graph": [posting(), posting({ identifier: "other", title: "Other role" })] }) }, { text: "<main>No JobPosting</main>" }]) {
    const { request, calls } = fixture("jobposting-jsonld", response);
    await assert.rejects(registry().readOriginal(request), code("source-changed")); assert.deepEqual(calls, [URL]);
  }
});

test("JSON-LD original reading never fills an employer or description from source configuration", async () => {
  const { request } = fixture("jobposting-jsonld", { text: script(posting({ hiringOrganization: undefined, description: undefined, jobLocationType: "TELECOMMUTE" })) });
  const result = await registry().readOriginal(request);
  assert.equal(result.companyName, undefined); assert.equal(result.description, undefined); assert.equal(result.completeness, "excerpt"); assert.equal(result.workMode, "remote");
  assert.doesNotMatch(JSON.stringify(result.locations), /coordinates|officeResolution/);
});

test("SmartRecruiters original reading extracts a literal same-tenant posting ID and requests its exact API once", async () => {
  const { request, calls } = fixture("smartrecruiters");
  const result = await registry().readOriginal(request);
  assert.deepEqual(calls, [`${SR_API}/123`]); assert.equal(result.sourceRecordId, "123"); assert.equal(result.url, SR_URL);
  assert.equal(result.completeness, "detail"); assert.match(result.description!, /Build tools[\s\S]*Use C#/); assert.equal(result.companyName, "Original Synthetic Employer");
  assert.doesNotMatch(JSON.stringify(result.locations), /coordinates|latitude|longitude/);
  const noSlug = fixture("smartrecruiters", { text: JSON.stringify(srDetail({ postingUrl: SR_URL.replace("-synthetic-role", "") })) });
  noSlug.request.url = SR_URL.replace("-synthetic-role", "");
  assert.equal((await registry().readOriginal(noSlug.request)).sourceRecordId, "123");
});

test("SmartRecruiters original reading rejects tenant, host, route, encoded identity and query ambiguity before transport", async () => {
  for (const url of [SR_URL.replace("SyntheticOrg", "Other"), SR_URL.replace("jobs.smartrecruiters.com", "api.smartrecruiters.com"),
    SR_URL.replace("123-synthetic-role", "synthetic-role"), SR_URL.replace("123-synthetic-role", "123a-synthetic-role"), `${SR_URL}/apply`,
    `${SR_URL}?jobId=456`, `${SR_URL}#other`, SR_URL.replace("/123", "/%31%32%33"), SR_URL.replace("/123", "/../123"),
    SR_URL.replace("https://", "http://"), SR_URL.replace("https://", "https://user:pass@")]) {
    const { request, calls } = fixture("smartrecruiters");
    await assert.rejects(registry().readOriginal({ ...request, url }), error => code("invalid-input")(error) || code("invalid-source")(error)); assert.equal(calls.length, 0);
  }
  const { request, calls } = fixture("smartrecruiters"); request.source.entryUrl = `${SR_API}/other`;
  await assert.rejects(registry().readOriginal(request), code("invalid-input")); assert.equal(calls.length, 0);
});

test("SmartRecruiters original reading requires the API's identical tenant, ID, reference and public posting URL", async () => {
  for (const changes of [{ id: "124" }, { company: { identifier: "Other", name: "Other company" } }, { ref: `${SR_API}/124` },
    { postingUrl: undefined }, { postingUrl: SR_URL.replace("synthetic-role", "changed-role") }, { postingUrl: SR_URL.replace("123", "124") }]) {
    const { request, calls } = fixture("smartrecruiters", { text: JSON.stringify(srDetail(changes)) });
    await assert.rejects(registry().readOriginal(request), code("source-changed")); assert.deepEqual(calls, [`${SR_API}/123`]);
  }
  const moved = fixture("smartrecruiters", { url: `${SR_API}/124` });
  await assert.rejects(registry().readOriginal(moved.request), code("source-changed"));
});

test("SmartRecruiters original reading does not fill missing source employer from configured companyName", async () => {
  const { request } = fixture("smartrecruiters", { text: JSON.stringify(srDetail({ company: { identifier: "SyntheticOrg" } })) });
  const original = await registry().readOriginal(request); assert.equal(original.companyName, undefined);
  const held = await registry().readDetail({ ...request, sourceRecordId: "123" });
  assert.equal(held.companyName, "Configured company is not original evidence", "held detail legacy behavior remains separate");
});

test("original authentication, rate limit, timeout, budget and cancellation failures never become empty success", async () => {
  for (const adapter of ["jobposting-jsonld", "smartrecruiters"]) {
    for (const status of [401, 403, 404, 429]) {
      const { request, calls } = fixture(adapter, { status });
      await assert.rejects(registry().readOriginal(request), code(status === 429 ? "rate-limited" : "http-error")); assert.equal(calls.length, 1);
    }
    for (const error of [new SourceTransportError("timeout"), new ToolError("budget-exceeded"), new ToolError("cancelled")]) {
      const { request } = fixture(adapter); request.transport = { async request() { throw error; } };
      await assert.rejects(registry().readOriginal(request), actual => actual === error);
    }
    const { request } = fixture(adapter), late = new AbortController(), transport = request.transport;
    request.context = context(late); request.transport = { async request(input) { const response = await transport.request(input); late.abort(); return response; } };
    await assert.rejects(registry().readOriginal(request), code("cancelled"));
  }
});

test("original reads preserve the source endpoint policy and trusted GET DNS/request/byte accounting", async () => {
  for (const adapter of ["jobposting-jsonld", "smartrecruiters"]) {
    const { request } = fixture(adapter); let dns = 0, sends = 0, chargedRequests = 0, chargedBytes = 0;
    request.context.consumeRequests = count => { chargedRequests += count ?? 1; }; request.context.consumeBytes = count => { chargedBytes += count; };
    request.transport = createControlledSourceTransport({
      resolve: async () => { dns++; return [{ address: "1.1.1.1", family: 4 }]; },
      send: async input => { sends++; assert.equal(input.url.toString(), adapter === "smartrecruiters" ? `${SR_API}/123` : URL);
        return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(adapter === "smartrecruiters" ? JSON.stringify(srDetail()) : script(posting())); })(), close() {} }; },
    });
    const policy = structuredClone(request.source.endpointPolicy);
    request.source.endpointPolicy.allowedPathPrefixes = ["/unrelated-reviewed-path"];
    await assert.rejects(registry().readOriginal(request), code("unsafe-endpoint")); assert.equal(dns, 0); assert.equal(sends, 0);
    request.source.endpointPolicy = policy;
    await registry().readOriginal(request);
    assert.equal(dns, 1); assert.equal(sends, 1); assert.equal(chargedRequests, 1); assert.ok(chargedBytes > 0);
    assert.deepEqual(request.source.endpointPolicy, policy);
  }
});
