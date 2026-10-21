import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, ToolError, type SourceDefinition } from "@better-me/opportunities";
import { createSourceRegistry } from "../src/registry.js";
import { jobPostingJsonLdAdapter } from "../src/adapters/jobposting-jsonld.js";
import { smartRecruitersAdapter } from "../src/adapters/smartrecruiters.js";
import { greenhouseAdapter } from "../src/adapters/greenhouse.js";
import { leverAdapter } from "../src/adapters/lever.js";
import { ashbyAdapter } from "../src/adapters/ashby.js";
import { tencentAdapter } from "../src/adapters/tencent.js";
import { SourceRegistryError, type SourceAdapter, type SourceAdapterContext, type SourceAdapterDetailRequest, type SourceJobRecord, type SourceTransportResponse } from "../src/contracts.js";
import { createControlledSourceTransport, SourceTransportError } from "../src/transport.js";

const AT = "2026-10-19T00:00:00.000Z";
const ORIGIN = "https://careers.synthetic-company.com";
const LIST = `${ORIGIN}/reviewed/list.xml`;
const URL = `${ORIGIN}/jobs/held-job-987`;
const SR_API = "https://api.smartrecruiters.com/v1/companies/SyntheticOrg/postings";
const SR_URL = "https://jobs.smartrecruiters.com/SyntheticOrg/123-synthetic-role";
function context(controller = new AbortController()): SourceAdapterContext {
  return { observedAt: AT, requestId: "synthetic-exact-detail", actorScope: "synthetic-user", signal: controller.signal,
    budget: { requests: 1, bytes: 200_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {},
    throwIfCancelled() { if (controller.signal.aborted) throw new ToolError("cancelled"); } };
}
function source(adapter = "jobposting-jsonld", changes: Partial<SourceDefinition> = {}): SourceDefinition {
  return SourceDefinitionSchema.parse({ sourceId: "synthetic-exact", name: "Synthetic source", adapterId: adapter, adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    entryUrl: adapter === "smartrecruiters" ? SR_API : LIST,
    options: adapter === "smartrecruiters" ? { companyIdentifier: "SyntheticOrg", fetchDetails: false, maxDetailRequestsPerPage: 1 }
      : { enumerationKind: "sitemap-urlset", enumerationUrls: [LIST], postingPathPrefixes: ["/jobs/"], pageSize: 1 },
    endpointPolicy: { allowedHosts: [adapter === "smartrecruiters" ? "api.smartrecruiters.com" : "careers.synthetic-company.com"],
      allowedPathPrefixes: adapter === "smartrecruiters" ? ["/v1/companies/SyntheticOrg/postings"] : ["/reviewed", "/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 1, maxPages: 1, requestsPerMinute: 10 }, ...changes });
}
function jsonld(changes: Record<string, unknown> = {}): string {
  return `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", url: URL, identifier: "held-job-987", title: "Synthetic role",
    description: "<p>Build C# tools.</p>", hiringOrganization: { name: "Synthetic Company" }, datePosted: "2026-09-01",
    jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Synthetic road 987", postalCode: "20987" } }, ...changes })}</script>`;
}
function srDetail(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "123", name: "Synthetic role", company: { identifier: "SyntheticOrg", name: "Synthetic Company" }, ref: `${SR_API}/123`, postingUrl: SR_URL,
    releasedDate: "2026-09-01", active: true,
    location: { city: "Shanghai", country: "cn", address: "Synthetic road 987", postalCode: "20987", latitude: 31, longitude: 121 },
    jobAd: { sections: { jobDescription: { text: "<p>Build tools.</p>" }, qualifications: { text: "<p>Use C#.</p>" } } }, ...changes };
}
function fixture(adapter = "jobposting-jsonld", response?: Partial<SourceTransportResponse>) {
  const calls: string[] = [];
  const request: SourceAdapterDetailRequest = { source: source(adapter), sourceRecordId: adapter === "smartrecruiters" ? "123" : "held-job-987",
    url: adapter === "smartrecruiters" ? SR_URL : URL, context: context(),
    transport: { async request(input) {
      calls.push(input.url);
      assert.deepEqual(input.source, request.source, "an exact read must keep the original source endpoint policy");
      return { url: input.url, status: 200, headers: {}, text: adapter === "smartrecruiters" ? JSON.stringify(srDetail()) : jsonld(), ...response };
    } } };
  return { request, calls };
}
const registry = () => createSourceRegistry([jobPostingJsonLdAdapter, smartRecruitersAdapter]);
const code = (expected: string) => (error: unknown) => (error instanceof ToolError || error instanceof SourceRegistryError || error instanceof SourceTransportError) && error.code === expected;

function syntheticRecord(changes: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "held-job-987", url: URL, title: "Synthetic role", locations: [], compensations: [],
    workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt", evidence: [], warnings: [], ...changes };
}
function syntheticAdapter(readDetail: NonNullable<SourceAdapter["readDetail"]>): SourceAdapter {
  return { adapterId: "jobposting-jsonld", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"], readDetail,
    async list() { throw new Error("An exact read must never enumerate listings."); } };
}

test("exact reads keep list-jobs authorization and never expose executable methods in metadata", async () => {
  const { request } = fixture();
  const installed = registry();
  assert.equal(typeof installed.resolve(request.source, "list-jobs", "local-service").adapter.readDetail, "function");
  const descriptions = installed.describe();
  assert.ok(descriptions.every(item => !Object.hasOwn(item, "list") && !Object.hasOwn(item, "readDetail")));
  assert.deepEqual(descriptions.map(item => item.capabilities), [["list-jobs"], ["list-jobs"]]);
  assert.throws(() => installed.resolve(request.source, "read-detail"), code("unsupported-capability"));
  descriptions[0]!.capabilities.push("read-detail");
  assert.deepEqual(installed.describe()[0]!.capabilities, ["list-jobs"]);
  assert.equal((await installed.readDetail(request)).sourceRecordId, "held-job-987");
});

test("exact reads require an active local-service job-posting source with installed implementation", async () => {
  let calls = 0;
  const installed = createSourceRegistry([syntheticAdapter(async () => { calls++; return syntheticRecord(); })]);
  const { request } = fixture();
  for (const changes of [{ enabled: false }, { status: "needs-review" as const }, { status: "disabled" as const }]) {
    await assert.rejects(installed.readDetail({ ...request, source: source("jobposting-jsonld", changes) }), code("source-disabled"));
  }
  for (const changes of [{ runtime: ["server"] as SourceDefinition["runtime"] }, { capabilities: [] }, { entityType: "recruitment-campaign" as const }]) {
    await assert.rejects(installed.readDetail({ ...request, source: source("jobposting-jsonld", changes) }), code("unsupported-capability"));
  }
  for (const adapter of [greenhouseAdapter, leverAdapter, ashbyAdapter, tencentAdapter]) {
    const configured = source(adapter.adapterId);
    await assert.rejects(createSourceRegistry([adapter]).readDetail({ ...request, source: configured }), code("unsupported-capability"));
  }
  assert.equal(calls, 0);
});

test("exact registry rejects malformed target, time, scope/cursor widening and non-function implementations before execution", async () => {
  const installed = registry(), { request, calls } = fixture();
  for (const changes of [{ sourceRecordId: "" }, { sourceRecordId: "bad\nID" }, { sourceRecordId: "x".repeat(1001) }, { url: "file:///bad" },
    { context: { ...context(), observedAt: "yesterday" } }, { scope: { roles: [], regions: [], companyNames: [] } }, { cursor: "1" }]) {
    await assert.rejects(installed.readDetail({ ...request, ...changes } as SourceAdapterDetailRequest), code("invalid-source"));
  }
  assert.equal(calls.length, 0);
  assert.throws(() => createSourceRegistry([{ ...syntheticAdapter(async () => syntheticRecord()), readDetail: true } as unknown as SourceAdapter]), code("invalid-source"));
});

test("exact registry rejects wrong ID/URL/entity, malformed output and observation-time mutation", async () => {
  const { request } = fixture();
  for (const output of [syntheticRecord({ sourceRecordId: "other" }), syntheticRecord({ url: `${ORIGIN}/jobs/other` }),
    syntheticRecord({ entityType: "discovery-lead", completeness: "lead" }), { ...syntheticRecord(), extraSecret: "forbidden" }]) {
    const installed = createSourceRegistry([syntheticAdapter(async () => output)]);
    await assert.rejects(installed.readDetail(request), code("invalid-output"));
  }
  const installed = createSourceRegistry([syntheticAdapter(async ({ context }) => { context.observedAt = "2026-10-20T00:00:00.000Z"; return syntheticRecord(); })]);
  await assert.rejects(installed.readDetail({ ...request, context: context() }), code("invalid-output"));
});

test("exact registry returns parsed copies and checks cancellation before and after execution", async () => {
  const original = syntheticRecord(), { request } = fixture();
  let calls = 0;
  const controller = new AbortController();
  const installed = createSourceRegistry([syntheticAdapter(async () => { calls++; return original; })]);
  const result = await installed.readDetail(request); result.title = "Caller changed";
  assert.equal(original.title, "Synthetic role");
  controller.abort();
  await assert.rejects(installed.readDetail({ ...request, context: context(controller) }), code("cancelled"));
  assert.equal(calls, 1);
  const late = new AbortController();
  const cancelled = createSourceRegistry([syntheticAdapter(async () => { late.abort(); return original; })]);
  await assert.rejects(cancelled.readDetail({ ...request, context: context(late) }), code("cancelled"));
});

test("JSON-LD exact read downloads only the held URL without manifests, page quota or keyword scope", async () => {
  const { request, calls } = fixture();
  const result = await registry().readDetail(request);
  assert.deepEqual(calls, [URL]); assert.equal(result.completeness, "detail");
  assert.equal(result.sourcePublishedRaw, "2026-09-01"); assert.equal(result.sourcePublishedAt, undefined);
  assert.deepEqual(result.locations, [{ raw: "Synthetic road 987, Shanghai, 20987, CN", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic road 987", postalCode: "20987" }]);
  assert.ok(result.evidence.some(item => item.field === "locations" && item.sourceUrl === URL && item.quote?.includes("Synthetic road 987")));
  assert.doesNotMatch(JSON.stringify(result.locations), /coordinates|latitude|longitude/);
});

test("JSON-LD exact read rejects origin/path/config/ambiguous URLs before requesting", async () => {
  for (const url of ["https://other.example.com/jobs/held-job-987", `${ORIGIN}/jobs-fake/held-job-987`, `${ORIGIN}/jobs/%2e%2e/admin`,
    `${ORIGIN}/jobs/a%2fb`, `${ORIGIN}/jobs/bad%zz`, `${URL}#other`, `${ORIGIN}/jobs/a\\b`]) {
    const { request, calls } = fixture(); request.url = url;
    await assert.rejects(registry().readDetail(request), error => code("invalid-input")(error) || code("invalid-source")(error));
    assert.equal(calls.length, 0);
  }
  const { request, calls } = fixture(); request.source.options = { ...request.source.options, enumerationUrls: [`${ORIGIN}/different/list.xml`] };
  await assert.rejects(registry().readDetail(request), code("invalid-input")); assert.equal(calls.length, 0);
});

test("JSON-LD exact read requires same response page and literal posting identifier", async () => {
  for (const response of [{ url: `${ORIGIN}/jobs/other` }, { text: jsonld({ identifier: "other" }) }, { text: jsonld({ identifier: undefined }) },
    { text: jsonld({ url: `${ORIGIN}/jobs/other` }) }, { text: "<main>No structured job</main>" }]) {
    const { request, calls } = fixture("jobposting-jsonld", response);
    await assert.rejects(registry().readDetail(request), code("source-changed")); assert.deepEqual(calls, [URL]);
  }
});

test("JSON-LD exact read preserves missing address and remote evidence without inventing office fields", async () => {
  const { request } = fixture("jobposting-jsonld", { text: jsonld({ jobLocation: undefined, jobLocationType: "TELECOMMUTE" }) });
  const result = await registry().readDetail(request);
  assert.deepEqual(result.locations, []); assert.equal(result.workMode, "remote");
});

test("SmartRecruiters exact read uses only same-tenant same-ID API despite list detail enrichment being disabled", async () => {
  const { request, calls } = fixture("smartrecruiters");
  const result = await registry().readDetail(request);
  assert.deepEqual(calls, [`${SR_API}/123`]); assert.equal(result.url, SR_URL); assert.equal(result.sourceRecordId, "123");
  assert.equal(result.completeness, "detail"); assert.match(result.description!, /Build tools[\s\S]*Use C#/);
  assert.equal(result.sourcePublishedRaw, "2026-09-01"); assert.equal(result.sourcePublishedAt, undefined);
  assert.deepEqual(result.locations, [{ raw: "Shanghai, cn · Synthetic road 987", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic road 987", postalCode: "20987" }]);
  assert.ok(result.evidence.some(item => item.field === "locations.streetAddress" && item.selector === "location.address" && item.sourceUrl === `${SR_API}/123`));
  assert.doesNotMatch(JSON.stringify(result.locations), /coordinates|latitude|longitude/);
});

test("SmartRecruiters exact read rejects target tenant, ID, route or source configuration mismatch before requesting", async () => {
  for (const changes of [{ sourceRecordId: "123/other" }, { url: SR_URL.replace("SyntheticOrg", "Other") },
    { url: SR_URL.replace("123-synthetic", "124-synthetic") }, { url: `${SR_URL}/apply` }, { url: `${SR_URL}#other` }]) {
    const { request, calls } = fixture("smartrecruiters");
    await assert.rejects(registry().readDetail({ ...request, ...changes }), code("invalid-input")); assert.equal(calls.length, 0);
  }
  const { request, calls } = fixture("smartrecruiters"); request.source.entryUrl = `${SR_API}/wrong`;
  await assert.rejects(registry().readDetail(request), code("invalid-input")); assert.equal(calls.length, 0);
});

test("SmartRecruiters exact read rejects response tenant, ID, ref, slug or response URL drift", async () => {
  for (const changes of [{ id: "124" }, { company: { identifier: "Other" } }, { ref: `${SR_API}/124` },
    { postingUrl: SR_URL.replace("synthetic-role", "changed-role") }, { postingUrl: undefined }, { name: "" }]) {
    const { request, calls } = fixture("smartrecruiters", { text: JSON.stringify(srDetail(changes)) });
    await assert.rejects(registry().readDetail(request), code("source-changed")); assert.deepEqual(calls, [`${SR_API}/123`]);
  }
  const { request } = fixture("smartrecruiters", { url: `${SR_API}/124` });
  await assert.rejects(registry().readDetail(request), code("source-changed"));
});

test("SmartRecruiters exact missing location stays empty and missing sections remain excerpt or reject", async () => {
  const { request } = fixture("smartrecruiters", { text: JSON.stringify(srDetail({ location: undefined })) });
  assert.deepEqual((await registry().readDetail(request)).locations, []);
  const partial = fixture("smartrecruiters", { text: JSON.stringify(srDetail({ location: { city: "Shanghai", country: "cn" }, jobAd: { sections: { jobDescription: { text: "Responsibilities only" } } } })) });
  const result = await registry().readDetail(partial.request); assert.equal(result.completeness, "excerpt");
  assert.equal(result.locations[0]!.streetAddress, undefined); assert.equal(result.locations[0]!.postalCode, undefined);
  const empty = fixture("smartrecruiters", { text: JSON.stringify(srDetail({ jobAd: {} })) });
  await assert.rejects(registry().readDetail(empty.request), code("source-changed"));
});

test("exact HTTP authentication, rate limits, timeout, budget and cancellation errors never become empty successful records", async () => {
  for (const adapter of ["jobposting-jsonld", "smartrecruiters"]) {
    for (const status of [401, 403, 404, 429]) {
      const { request, calls } = fixture(adapter, { status });
      await assert.rejects(registry().readDetail(request), code(status === 429 ? "rate-limited" : "http-error")); assert.equal(calls.length, 1);
    }
    for (const error of [new SourceTransportError("timeout"), new ToolError("budget-exceeded"), new ToolError("cancelled")]) {
      const { request } = fixture(adapter); request.transport = { async request() { throw error; } };
      await assert.rejects(registry().readDetail(request), actual => actual === error);
    }
    const late = new AbortController(), { request } = fixture(adapter), transport = request.transport;
    request.context = context(late);
    request.transport = { async request(args) { const response = await transport.request(args); late.abort(); return response; } };
    await assert.rejects(registry().readDetail(request), code("cancelled"));
  }
});

test("exact reads cannot widen the existing endpoint policy and use trusted GET accounting", async () => {
  for (const adapter of ["jobposting-jsonld", "smartrecruiters"]) {
    const { request } = fixture(adapter);
    let dns = 0, sends = 0, chargedRequests = 0, chargedBytes = 0;
    request.context.consumeRequests = count => { chargedRequests += count ?? 1; };
    request.context.consumeBytes = count => { chargedBytes += count; };
    request.transport = createControlledSourceTransport({
      resolve: async () => { dns++; return [{ address: "1.1.1.1", family: 4 }]; },
      send: async input => {
        sends++;
        assert.equal(input.url.toString(), adapter === "smartrecruiters" ? `${SR_API}/123` : URL);
        return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode(adapter === "smartrecruiters" ? JSON.stringify(srDetail()) : jsonld()); })(), close() {} };
      },
    });
    const originalPolicy = structuredClone(request.source.endpointPolicy);
    request.source.endpointPolicy.allowedPathPrefixes = ["/reviewed-only"];
    await assert.rejects(registry().readDetail(request), code("unsafe-endpoint"));
    assert.equal(dns, 0); assert.equal(sends, 0);
    request.source.endpointPolicy = originalPolicy;
    await registry().readDetail(request);
    assert.equal(dns, 1); assert.equal(sends, 1); assert.equal(chargedRequests, 1); assert.ok(chargedBytes > 0);
    assert.deepEqual(request.source.endpointPolicy, originalPolicy);
  }
});
