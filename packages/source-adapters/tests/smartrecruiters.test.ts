import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, ToolError, type SourceDefinition } from "@better-me/opportunities";
import { smartRecruitersAdapter } from "../src/adapters/smartrecruiters.js";
import { SmartRecruitersSourceOptionsSchema } from "../src/smartrecruiters-contracts.js";
import { createSourceRegistry } from "../src/registry.js";
import { SourceTransportError } from "../src/transport.js";
import { assessSourceScopeMatch, countSourceScopeMatches } from "../src/local-match.js";
import type { SourceAdapterRequest, SourceAdapterContext } from "../src/contracts.js";

const AT = "2026-10-19T00:00:00.000Z";
const ENDPOINT = "https://api.smartrecruiters.com/v1/companies/SyntheticOrg/postings";
function makeContext(controller = new AbortController()): SourceAdapterContext {
  return { observedAt: AT, requestId: "synthetic-smartrecruiters", actorScope: "synthetic-user", signal: controller.signal,
    budget: { requests: 10, bytes: 200_000, timeoutMs: 5000 }, consumeRequests: () => {}, consumeBytes: () => {},
    throwIfCancelled: () => controller.signal.throwIfAborted() };
}
function makeSource(options: SourceDefinition["options"] = {}): SourceDefinition {
  return SourceDefinitionSchema.parse({ sourceId: "synthetic-smartrecruiters", name: "Synthetic public tenant",
    adapterId: "smartrecruiters", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"],
    entityType: "job-posting", enabled: true, status: "active", remoteFilters: ["roles"], entryUrl: ENDPOINT,
    options: { companyIdentifier: "SyntheticOrg", pageSize: 2, ...options },
    endpointPolicy: { allowedHosts: ["api.smartrecruiters.com"], allowedPathPrefixes: ["/v1/companies/SyntheticOrg/postings"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 10, maxPages: 3, requestsPerMinute: 10 } });
}
function post(id = "123", changes: Record<string, unknown> = {}) {
  return { id, name: "Synthetic systems engineer", company: { identifier: "SyntheticOrg", name: "Synthetic Company" },
    ref: `${ENDPOINT}/${id}`, postingUrl: `https://jobs.smartrecruiters.com/SyntheticOrg/${id}-systems-engineer`,
    location: { city: "Shanghai", region: "Shanghai", country: "cn", fullLocation: "Shanghai, China", latitude: "31.2304", longitude: "121.4737", remote: false, hybrid: false },
    releasedDate: "2026-07-29T03:47:46.915Z", active: true, ...changes };
}
function detail(id = "123", changes: Record<string, unknown> = {}) {
  return { id, name: "Synthetic systems engineer", company: { identifier: "SyntheticOrg", name: "Synthetic Company" },
    ref: `${ENDPOINT}/${id}`, postingUrl: `https://jobs.smartrecruiters.com/SyntheticOrg/${id}-systems-engineer`,
    active: true, jobAd: { sections: {
      companyDescription: { title: "Company", text: "<p>Synthetic company context</p>" },
      jobDescription: { title: "Responsibilities", text: "<p>Build assessment tools</p>" },
      qualifications: { title: "Qualifications", text: "<p>Experience with C# and .NET</p>" },
      additionalInformation: { title: "Additional information", text: "" },
    } }, ...changes };
}
function fixture(posts: unknown[], options: SourceDefinition["options"] = {}, total = posts.length) {
  const urls: string[] = [];
  const input: SourceAdapterRequest = { source: makeSource(options), scope: { roles: ["C#"], regions: [], companyNames: [] }, context: makeContext(),
    transport: { request: async ({ url }) => {
      urls.push(url);
      const parsed = new URL(url), id = parsed.pathname.split("/").at(-1)!;
      const payload = parsed.pathname.endsWith("/postings")
        ? { offset: Number(parsed.searchParams.get("offset")), limit: Number(parsed.searchParams.get("limit")), totalFound: total, content: posts }
        : detail(id);
      return { url, status: 200, headers: {}, text: JSON.stringify(payload) };
    } } };
  return { input, urls };
}
function changeDetails(input: SourceAdapterRequest, value: unknown, status = 200) {
  const original = input.transport;
  input.transport = { request: async (args) => new URL(args.url).pathname.endsWith("/postings") ? original.request(args)
    : { url: args.url, status, headers: {}, text: JSON.stringify(value) } };
}
const code = (expected: string) => (error: unknown) => error instanceof ToolError && error.code === expected;

test("public list sends encoded q and configured country while preserving source dates, identity and geographic limits", async () => {
  const { input, urls } = fixture([post()], { countryCode: "CN" });
  input.scope.regions = ["Shanghai"]; input.scope.companyNames = ["Synthetic"];
  const result = await createSourceRegistry([smartRecruitersAdapter]).list(input);
  const url = new URL(urls[0]!);
  assert.equal(url.origin + url.pathname, ENDPOINT); assert.equal(url.searchParams.get("q"), "C#"); assert.ok(urls[0]!.includes("C%23"));
  assert.equal(url.searchParams.get("country"), "cn"); assert.equal(url.searchParams.has("city"), false);
  assert.deepEqual(result.coverage.appliedFilters, ["roles"]); assert.deepEqual(result.coverage.ignoredFilters, ["regions", "companyNames"]);
  const job = result.records[0]!;
  assert.equal(job.sourceRecordId, "123"); assert.equal(job.url, "https://jobs.smartrecruiters.com/SyntheticOrg/123-systems-engineer");
  assert.equal(job.companyName, "Synthetic Company"); assert.equal(job.completeness, "excerpt");
  assert.deepEqual(job.locations, [{ raw: "Shanghai, China", countryCode: "CN", region: "Shanghai", city: "Shanghai" }]);
  assert.equal(job.sourcePublishedRaw, "2026-07-29T03:47:46.915Z"); assert.equal(job.sourcePublishedAt, job.sourcePublishedRaw);
  assert.equal(job.sourceUpdatedAt, undefined); assert.equal(job.availability, "unknown"); assert.equal(job.workMode, "unknown");
  assert.deepEqual(job.compensations, []); assert.deepEqual(job.remoteEligibleRegions, []);
  for (const selector of ["content[0].id", "content[0].company", "content[0].location", "content[0].releasedDate", "content[0].active"]) assert.ok(job.evidence.some((item) => item.selector === selector));
});

test("broad upstream candidate counts never become confirmed C# matches and unread requirements remain unknown", async () => {
  const { input } = fixture([post("1", { name: "C++ engineer" }), post("2", { name: "C# developer" })]);
  const result = await smartRecruitersAdapter.list(input);
  assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 1, unknown: 1, excluded: 0 });
  assert.ok(result.warnings.some((warning) => warning.includes("broad candidate query")));
  assert.equal(result.coverage.totalAvailable, 2); assert.equal(result.records[0]!.description, undefined);
});

test("SmartRecruiters retains explicit listing address and postalCode with exact source paths and unchanged raw label", async () => {
  const { input } = fixture([post("1", { location: { city: "Boston", country: "us", fullLocation: "Boston, USA", address: "Source street 10", postalCode: "00123", latitude: 31, longitude: 121 } })]);
  const result = await smartRecruitersAdapter.list(input), job = result.records[0]!;
  assert.deepEqual(job.locations, [{ raw: "Boston, USA · Source street 10", countryCode: "US", city: "Boston", streetAddress: "Source street 10", postalCode: "00123" }]);
  for (const [field, selector, quote] of [["streetAddress", "address", "Source street 10"], ["postalCode", "postalCode", "00123"]]) {
    assert.ok(job.evidence.some(item => item.field === `locations.${field}` && item.selector === `content[0].location.${selector}` && item.quote === quote && new URL(item.sourceUrl).pathname.endsWith("/postings")));
  }
  assert.doesNotMatch(JSON.stringify(job.locations), /coordinates|latitude|longitude/);
});

test("SmartRecruiters same-ID detail can disclose an office address; absent detail location preserves listing fields", async () => {
  const { input } = fixture([post()], { fetchDetails: true });
  changeDetails(input, detail("123", { location: { city: "Boston", country: "us", fullLocation: "Boston, USA", address: "Source street 20", postalCode: "00234" } }));
  const result = await smartRecruitersAdapter.list(input), job = result.records[0]!;
  assert.deepEqual(job.locations, [{ raw: "Boston, USA · Source street 20", countryCode: "US", city: "Boston", streetAddress: "Source street 20", postalCode: "00234" }]);
  assert.ok(job.evidence.some(item => item.field === "locations.streetAddress" && item.selector === "location.address" && item.sourceUrl === `${ENDPOINT}/123`));
  assert.equal(job.completeness, "detail");
  const retained = fixture([post("123", { location: { city: "Boston", country: "us", address: "Source street 30", postalCode: "00345" } })], { fetchDetails: true });
  const retainedJob = (await smartRecruitersAdapter.list(retained.input)).records[0]!;
  assert.equal(retainedJob.locations[0]!.streetAddress, "Source street 30"); assert.equal(retainedJob.locations[0]!.postalCode, "00345");
});

test("SmartRecruiters sparse same-place detail retains listing office fields with their original evidence", async () => {
  const { input } = fixture([post("123", { location: { city: "Boston", region: "Massachusetts", country: "us", address: "Source street 30", postalCode: "00345" } })], { fetchDetails: true });
  changeDetails(input, detail("123", { location: { city: "boston", country: "US" } }));
  const result = await createSourceRegistry([smartRecruitersAdapter]).list(input), job = result.records[0]!;
  assert.deepEqual(job.locations, [{ raw: "boston, US", city: "boston", countryCode: "US", streetAddress: "Source street 30", postalCode: "00345" }]);
  assert.equal(job.completeness, "detail"); assert.equal(result.coverage.partial, false);
  for (const [field, selector, quote] of [["streetAddress", "address", "Source street 30"], ["postalCode", "postalCode", "00345"]]) {
    const evidence = job.evidence.filter(item => item.field === `locations.${field}`);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.selector, `content[0].location.${selector}`);
    assert.equal(evidence[0]!.quote, quote);
    assert.equal(new URL(evidence[0]!.sourceUrl).pathname, "/v1/companies/SyntheticOrg/postings");
  }
  const detailLocationEvidence = job.evidence.find(item => item.field === "locations" && item.selector === "location");
  assert.equal(detailLocationEvidence?.quote, "boston, US", "detail evidence must not claim the retained street was in the detail response");
  assert.equal(detailLocationEvidence?.sourceUrl, `${ENDPOINT}/123`);
  assert.doesNotMatch(JSON.stringify(job.locations), /coordinates|latitude|longitude/);
});

test("SmartRecruiters consistent explicit office fields can retain only the omitted counterpart", async () => {
  for (const [supplied, expected] of [
    [{ address: "Source street 30" }, { streetAddress: "Source street 30", postalCode: "00345" }],
    [{ postalCode: "00345" }, { streetAddress: "Source street 30", postalCode: "00345" }],
  ] as const) {
    const { input } = fixture([post("123", { location: { city: "Boston", country: "us", address: "Source street 30", postalCode: "00345" } })], { fetchDetails: true });
    changeDetails(input, detail("123", { location: { city: "Boston", country: "us", ...supplied } }));
    const job = (await smartRecruitersAdapter.list(input)).records[0]!;
    assert.equal(job.locations[0]!.streetAddress, expected.streetAddress); assert.equal(job.locations[0]!.postalCode, expected.postalCode);
    const explicitField = "address" in supplied ? "streetAddress" : "postalCode";
    assert.ok(job.evidence.some(item => item.field === `locations.${explicitField}` && item.selector === `location.${"address" in supplied ? "address" : "postalCode"}` && item.sourceUrl === `${ENDPOINT}/123`));
  }
});

test("SmartRecruiters different or insufficient detail geography never borrows a listing office", async () => {
  const listingLocation = { city: "Boston", region: "Massachusetts", country: "us", address: "Source street 30", postalCode: "00345" };
  for (const location of [
    { city: "Cambridge", country: "us" }, { city: "Boston", country: "gb" },
    { city: "Boston", country: "us", region: "Other region" },
    { city: "Boston" }, { city: "Boston", country: "United States" },
    { country: "us" }, { city: "Boston / Cambridge", country: "us" },
  ]) {
    const { input } = fixture([post("123", { location: listingLocation })], { fetchDetails: true });
    changeDetails(input, detail("123", { location }));
    const job = (await smartRecruitersAdapter.list(input)).records[0]!;
    assert.equal(job.locations[0]!.streetAddress, undefined, JSON.stringify(location));
    assert.equal(job.locations[0]!.postalCode, undefined, JSON.stringify(location));
    assert.equal(job.completeness, "detail");
  }
  for (const location of [{ country: "us", address: "Source street 30", postalCode: "00345" }, { city: "Boston", address: "Source street 30", postalCode: "00345" }]) {
    const { input } = fixture([post("123", { location })], { fetchDetails: true });
    changeDetails(input, detail("123", { location: { city: "Boston", country: "us" } }));
    const job = (await smartRecruitersAdapter.list(input)).records[0]!;
    assert.equal(job.locations[0]!.streetAddress, undefined); assert.equal(job.locations[0]!.postalCode, undefined);
  }
});

test("SmartRecruiters explicit detail office changes never splice in fields from another office in the same city", async () => {
  for (const [supplied, expectedStreet, expectedPostal] of [
    [{ address: "Different street 80" }, "Different street 80", undefined],
    [{ postalCode: "00999" }, undefined, "00999"],
    [{ address: "Different street 80", postalCode: "00999" }, "Different street 80", "00999"],
  ] as const) {
    const { input } = fixture([post("123", { location: { city: "Boston", country: "us", address: "Source street 30", postalCode: "00345" } })], { fetchDetails: true });
    changeDetails(input, detail("123", { location: { city: "Boston", country: "us", ...supplied } }));
    const job = (await smartRecruitersAdapter.list(input)).records[0]!;
    assert.equal(job.locations[0]!.streetAddress, expectedStreet); assert.equal(job.locations[0]!.postalCode, expectedPostal);
    assert.equal(job.completeness, "detail");
    for (const [sourceField, outputField] of [["address", "streetAddress"], ["postalCode", "postalCode"]] as const) if (sourceField in supplied) {
      assert.ok(job.evidence.some(item => item.field === `locations.${outputField}` && item.selector === `location.${sourceField}` && item.sourceUrl === `${ENDPOINT}/123`));
    }
  }
});

test("SmartRecruiters never derives structured address fields from fullLocation, city, HQ, zip aliases or geo", async () => {
  const { input } = fixture([post("1", { location: { fullLocation: "Source street 10, 00123", city: "City street 20, 00234", country: "us", zipCode: "00345", latitude: 31, longitude: 121 },
    company: { identifier: "SyntheticOrg", name: "Synthetic Company", address: "HQ street 99", postalCode: "99999" } })]);
  const result = await smartRecruitersAdapter.list(input), location = result.records[0]!.locations[0]!;
  assert.deepEqual(location, { raw: "Source street 10, 00123", countryCode: "US" });
});

test("SmartRecruiters invalid detail postal fields retain the unchanged listing as a partial excerpt", async () => {
  for (const location of [{ address: "x".repeat(1001) }, { address: "Source street", postalCode: "x".repeat(101) }, { address: "Source\u0000ID" }, { address: "Source street", postalCode: "00\u0000ID" }]) {
    const { input } = fixture([post()], { fetchDetails: true }); changeDetails(input, detail("123", { location }));
    const result = await smartRecruitersAdapter.list(input), job = result.records[0]!;
    assert.deepEqual(job.locations, [{ raw: "Shanghai, China", countryCode: "CN", region: "Shanghai", city: "Shanghai" }]);
    assert.equal(job.completeness, "excerpt"); assert.equal(result.coverage.partial, true);
  }
});

test("bounded same-ID detail recovers C# only in qualifications without truncating long responsibilities", async () => {
  const { input, urls } = fixture([post()], { fetchDetails: true });
  const data = detail();
  data.jobAd.sections.jobDescription.text = `<p>${"Synthetic complete source responsibility. ".repeat(150)}</p><script>UNTRUSTED_SCRIPT</script>`;
  changeDetails(input, data);
  const result = await smartRecruitersAdapter.list(input), job = result.records[0]!;
  assert.equal(urls.length, 1); assert.equal(job.completeness, "detail"); assert.ok(job.description!.length > 6000);
  assert.ok(job.description!.includes("C# and .NET")); assert.ok(!job.description!.includes("UNTRUSTED_SCRIPT"));
  assert.equal(assessSourceScopeMatch(job, input.scope).status, "matched");
  assert.equal(job.url, data.postingUrl); assert.equal(job.availability, "unknown");
  for (const selector of ["id", "jobAd.sections.jobDescription.text", "jobAd.sections.qualifications.text"]) assert.ok(job.evidence.some((entry) => entry.selector === selector && entry.sourceUrl === `${ENDPOINT}/123`));
});

test("a .NET match in duties is checked using the shared local matcher", async () => {
  const { input } = fixture([post()], { fetchDetails: true }); input.scope.roles = [".NET"];
  const data = detail(); data.jobAd.sections.jobDescription.text = "Build .NET services"; data.jobAd.sections.qualifications.text = "Software experience";
  changeDetails(input, data); const result = await smartRecruitersAdapter.list(input);
  assert.equal(assessSourceScopeMatch(result.records[0]!, input.scope).status, "matched");
});

test("wrong tenant, ref identity and duplicate rows are omitted with partial coverage", async () => {
  const { input } = fixture([post("1"), post("1"), post("2", { company: { identifier: "OtherTenant", name: "Wrong" } }), post("3", { ref: `${ENDPOINT}/999` })], { pageSize: 4 });
  const result = await smartRecruitersAdapter.list(input);
  assert.deepEqual(result.records.map((job) => job.sourceRecordId), ["1"]); assert.equal(result.coverage.partial, true);
  assert.ok(result.warnings.some((warning) => warning.startsWith("3 malformed")));
});

test("wrong-ID and wrong-tenant details never inject requirements", async () => {
  for (const changes of [{ id: "999" }, { company: { identifier: "OtherTenant" } }, { ref: `${ENDPOINT}/999` }]) {
    const { input } = fixture([post()], { fetchDetails: true }); changeDetails(input, detail("123", changes));
    const result = await smartRecruitersAdapter.list(input);
    assert.equal(result.records[0]!.description, undefined); assert.equal(result.records[0]!.completeness, "excerpt");
    assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "source-error");
  }
});

test("source public URLs must bind the exact posting and tenant; application endpoints are never followed", async () => {
  for (const postingUrl of ["https://jobs.smartrecruiters.com/Other/123-role", "https://jobs.smartrecruiters.com/SyntheticOrg/1234-role", "https://jobs.smartrecruiters.com/SyntheticOrg/123-role/other", "https://evil.example/SyntheticOrg/123"]) {
    const { input } = fixture([post("123", { postingUrl })]); const result = await smartRecruitersAdapter.list(input);
    assert.equal(result.records.length, 0); assert.equal(result.coverage.partial, true);
  }
  const { input } = fixture([post()], { fetchDetails: true });
  changeDetails(input, detail("123", { applyUrl: "https://evil.example/apply" }));
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records[0]!.applicationUrl, "https://jobs.smartrecruiters.com/SyntheticOrg/123-systems-engineer");
});

test("a missing public posting link is not manufactured from the API ID", async () => {
  const { input, urls } = fixture([post("123", { postingUrl: undefined })]);
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records.length, 0);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.warnings.some((warning) => warning.includes("malformed")), true);
  assert.equal(urls.length, 1);
});

test("a list without public links recovers only source-supplied URLs from bounded same-ID details", async () => {
  for (const postingUrl of [undefined, ""]) {
    const { input, urls } = fixture([post("123", { postingUrl })], { fetchDetails: true, maxDetailRequestsPerPage: 1 });
    const result = await createSourceRegistry([smartRecruitersAdapter]).list(input);
    assert.equal(urls.length, 2, "one list and exactly one configured detail request");
    assert.equal(urls[1], `${ENDPOINT}/123`);
    assert.equal(new URL(urls[0]!).searchParams.get("q"), "C#");
    assert.equal(result.records.length, 1);
    const job = result.records[0]!;
    assert.equal(job.sourceRecordId, "123");
    assert.equal(job.url, detail().postingUrl);
    assert.equal(job.applicationUrl, detail().postingUrl);
    assert.equal(job.completeness, "detail");
    assert.ok(job.description?.includes("C# and .NET"));
    assert.equal(job.sourcePublishedAt, "2026-07-29T03:47:46.915Z");
    assert.equal(job.locations[0]?.city, "Shanghai");
    assert.equal(job.availability, "unknown");
    assert.deepEqual(countSourceScopeMatches(result.records, input.scope), { matched: 1, unknown: 0, excluded: 0 });
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.partial, false);
    assert.ok(!urls.some((url) => url.startsWith("https://jobs.smartrecruiters.com/")), "public and application links are never fetched");
  }
});

test("unlinked keyword title matches receive the limited detail allowance before unrelated or already linked rows", async () => {
  const { input, urls } = fixture([
    post("1", { name: "C++ engineer", postingUrl: undefined }),
    post("2", { name: "C# developer", postingUrl: undefined }),
    post("3", { name: "C# platform developer" }),
  ], { pageSize: 3, fetchDetails: true, maxDetailRequestsPerPage: 1 });
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], `${ENDPOINT}/2`, "a title match must recover its missing source URL before unrelated requirements consume the allowance");
  assert.deepEqual(result.records.map((job) => job.sourceRecordId), ["2", "3"], "returned linked records preserve original list order");
  assert.deepEqual(result.records.map((job) => job.completeness), ["detail", "excerpt"]);
  assert.equal(result.records[0]!.url, detail("2").postingUrl);
  assert.equal(result.coverage.fetchedRecords, 3, "omitted unlinked metadata remains part of fetched coverage");
  assert.equal(result.coverage.partial, true);
  assert.equal(result.stopReason, "record-limit");
  assert.ok(result.warnings.some((warning) => warning.includes("unlinked records were omitted")));
});

test("unlinked list rows cannot acquire a public route from missing, malformed or mismatched detail links", async () => {
  for (const changes of [
    { postingUrl: undefined }, { postingUrl: "" }, { postingUrl: null },
    { postingUrl: "https://jobs.smartrecruiters.com/Other/123-role" },
    { postingUrl: "https://jobs.smartrecruiters.com/SyntheticOrg/999-role" },
    { postingUrl: "https://evil.example/SyntheticOrg/123" },
    { id: "999" }, { company: { identifier: "OtherTenant", name: "Other company" } },
    { ref: `${ENDPOINT}/999` },
  ]) {
    const { input } = fixture([post("123", { postingUrl: undefined })], { fetchDetails: true, maxDetailRequestsPerPage: 1 });
    changeDetails(input, detail("123", changes));
    const result = await smartRecruitersAdapter.list(input);
    assert.deepEqual(result.records, [], `unverified detail cannot restore a source link: ${JSON.stringify(changes)}`);
    assert.equal(result.coverage.fetchedRecords, 1);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.partial, true);
    assert.equal(result.stopReason, "source-error");
  }
});

test("failed link recovery omits only its unresolved row and retains other validated list links", async () => {
  const { input, urls } = fixture([
    post("1", { name: "C# developer", postingUrl: undefined }),
    post("2", { name: "C# platform developer" }),
  ], { fetchDetails: true, maxDetailRequestsPerPage: 1 });
  const original = input.transport;
  input.transport = { request: async (args) => {
    if (args.url === `${ENDPOINT}/1`) {
      urls.push(args.url);
      return { url: args.url, status: 404, headers: {}, text: "{}" };
    }
    return original.request(args);
  } };
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], `${ENDPOINT}/1`);
  assert.deepEqual(result.records.map((job) => job.sourceRecordId), ["2"]);
  assert.equal(result.records[0]!.url, post("2").postingUrl);
  assert.equal(result.records[0]!.completeness, "excerpt");
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.fetchedRecords, 2);
});

test("cancellation during missing-link recovery does not return restored rows or request later details", async () => {
  const { input, urls } = fixture([
    post("1", { name: "C# developer", postingUrl: undefined }),
    post("2", { name: "C# platform developer", postingUrl: undefined }),
  ], { fetchDetails: true, maxDetailRequestsPerPage: 2 });
  const controller = new AbortController();
  input.context = makeContext(controller);
  const original = input.transport;
  input.transport = { request: async (args) => {
    const response = await original.request(args);
    if (args.url === `${ENDPOINT}/1`) controller.abort();
    return response;
  } };
  await assert.rejects(smartRecruitersAdapter.list(input), { name: "AbortError" });
  assert.equal(urls.length, 2);
  assert.equal(urls[1], `${ENDPOINT}/1`);
  assert.equal(urls.includes(`${ENDPOINT}/2`), false);
});

test("a detail may omit its public URL and keeps the exact validated listing link", async () => {
  const { input } = fixture([post()]);
  input.source.options = { companyIdentifier: "SyntheticOrg", pageSize: 2, fetchDetails: true, maxDetailRequestsPerPage: 1 };
  changeDetails(input, detail("123", { postingUrl: undefined }));
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records[0]?.url, "https://jobs.smartrecruiters.com/SyntheticOrg/123-systems-engineer");
  assert.equal(result.records[0]?.applicationUrl, result.records[0]?.url);
  assert.equal(result.records[0]?.completeness, "detail");
});

test("detail allowance prioritizes eligible unread requirements and keeps original result order", async () => {
  const { input, urls } = fixture([post("1", { name: "C# developer" }), post("2"), post("3", { location: { city: "Paris", country: "fr" } })], { pageSize: 3, fetchDetails: true, maxDetailRequestsPerPage: 1 });
  input.scope.countryCodes = ["CN"];
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(urls.length, 2); assert.equal(urls[1], `${ENDPOINT}/2`);
  assert.deepEqual(result.records.map((job) => job.sourceRecordId), ["1", "2", "3"]);
  assert.deepEqual(result.records.map((job) => job.completeness), ["excerpt", "detail", "excerpt"]);
  assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "record-limit");
});

test("different country and region constraints do not combine across locations or spend detail budget", async () => {
  const { input, urls } = fixture([post("1", { location: { country: "fr", city: "Shanghai" } })], { fetchDetails: true });
  input.scope.countryCodes = ["CN"]; input.scope.regions = ["Shanghai"];
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(urls.length, 1); assert.equal(assessSourceScopeMatch(result.records[0]!, input.scope).status, "excluded");
});

test("fixed offset/page size cursor survives a smaller output allowance while reporting omitted records", async () => {
  const first = fixture([post("1"), post("2")], {}, 5);
  const result = await smartRecruitersAdapter.list(first.input); assert.ok(result.nextCursor);
  const next = fixture([post("3"), post("4")], {}, 5); next.input.cursor = result.nextCursor; next.input.source.refreshPolicy.maxRecords = 1;
  const value = await smartRecruitersAdapter.list(next.input);
  assert.equal(new URL(next.urls[0]!).searchParams.get("offset"), "2"); assert.equal(new URL(next.urls[0]!).searchParams.get("limit"), "2");
  assert.equal(value.records.length, 1); assert.equal(value.coverage.fetchedRecords, 2); assert.equal(value.stopReason, "record-limit"); assert.equal(value.nextCursor, undefined);
});

test("OR keywords continue separately and overlapping query totals are not summed", async () => {
  const { input, urls } = fixture([post()]); input.scope.roles = ["C#", ".NET", "C#"];
  const first = await smartRecruitersAdapter.list(input); assert.ok(first.nextCursor); assert.equal(first.coverage.totalAvailable, undefined);
  input.cursor = first.nextCursor; const second = await smartRecruitersAdapter.list(input);
  assert.equal(new URL(urls[0]!).searchParams.get("q"), "C#"); assert.equal(new URL(urls[1]!).searchParams.get("q"), ".NET");
  assert.equal(new URL(urls[1]!).searchParams.get("offset"), "0"); assert.equal(second.nextCursor, undefined); assert.equal(second.coverage.complete, true);
});

test("cursor is bound to source options, keywords and local filters", async () => {
  const initial = fixture([post("1"), post("2")], {}, 4); const first = await smartRecruitersAdapter.list(initial.input);
  for (const change of [(r: SourceAdapterRequest) => { r.scope.roles = [".NET"]; }, (r: SourceAdapterRequest) => { r.scope.regions = ["Paris"]; },
    (r: SourceAdapterRequest) => { r.source.options = { ...r.source.options, countryCode: "CN" }; }, (r: SourceAdapterRequest) => { r.source.sourceId = "different-source"; }]) {
    const { input, urls } = fixture([]); input.cursor = first.nextCursor; change(input);
    await assert.rejects(smartRecruitersAdapter.list(input), code("invalid-input")); assert.equal(urls.length, 0);
  }
  const { input } = fixture([]); input.cursor = "../bad"; await assert.rejects(smartRecruitersAdapter.list(input), code("invalid-input"));
});

test("empty response is complete but a premature short page is partial and does not advance", async () => {
  const empty = await smartRecruitersAdapter.list(fixture([]).input); assert.equal(empty.coverage.complete, true); assert.equal(empty.records.length, 0);
  const short = await smartRecruitersAdapter.list(fixture([post()], {}, 12).input);
  assert.equal(short.coverage.partial, true); assert.equal(short.coverage.complete, false); assert.equal(short.nextCursor, undefined);
});

test("malformed list, count and paging echoes fail instead of claiming empty success", async () => {
  for (const payload of [{ content: [] }, { content: {}, offset: 0, limit: 2, totalFound: 0 },
    { content: [], offset: 0, limit: 2, totalFound: -1 }, { content: [], offset: 4, limit: 2, totalFound: 0 },
    { content: [], offset: 0, limit: 3, totalFound: 0 }, { content: [post()], offset: 0, limit: 2, totalFound: 0 }]) {
    const { input } = fixture([]); input.transport = { request: async ({ url }) => ({ url, status: 200, headers: {}, text: JSON.stringify(payload) }) };
    await assert.rejects(smartRecruitersAdapter.list(input), code("source-changed"));
  }
  const { input } = fixture([]); input.transport = { request: async ({ url }) => ({ url, status: 200, headers: {}, text: "<html>verification required</html>" }) };
  await assert.rejects(smartRecruitersAdapter.list(input), code("source-changed"));
});

test("cancellation before collection prevents every request", async () => {
  const { input, urls } = fixture([]); const controller = new AbortController(); controller.abort(); input.context = makeContext(controller);
  await assert.rejects(smartRecruitersAdapter.list(input), { name: "AbortError" }); assert.equal(urls.length, 0);
});

test("cancellation after a returned list does not request details or return success", async () => {
  const { input, urls } = fixture([post()], { fetchDetails: true }); const controller = new AbortController(); input.context = makeContext(controller);
  const original = input.transport; input.transport = { request: async (args) => { const response = await original.request(args); controller.abort(); return response; } };
  await assert.rejects(smartRecruitersAdapter.list(input), { name: "AbortError" }); assert.equal(urls.length, 1);
});

test("cancellation during detail does not swallow AbortError or request later details", async () => {
  const { input, urls } = fixture([post("1"), post("2")], { fetchDetails: true }); const controller = new AbortController(); input.context = makeContext(controller);
  const original = input.transport; input.transport = { request: async (args) => { const response = await original.request(args); if (args.url === `${ENDPOINT}/1`) controller.abort(); return response; } };
  await assert.rejects(smartRecruitersAdapter.list(input), { name: "AbortError" }); assert.equal(urls.length, 2);
});

test("429 on list and detail remains explicit, including transport retry-after evidence", async () => {
  const { input } = fixture([]); input.transport = { request: async ({ url }) => ({ url, status: 429, headers: {}, text: "" }) };
  await assert.rejects(smartRecruitersAdapter.list(input), (error: unknown) => error instanceof SourceTransportError && error.code === "rate-limited" && error.status === 429);
  const detailed = fixture([post()], { fetchDetails: true }); const original = detailed.input.transport;
  const failure = new SourceTransportError("rate-limited", 429, 90);
  detailed.input.transport = { request: async (args) => { if (!args.url.includes("?")) throw failure; return original.request(args); } };
  await assert.rejects(smartRecruitersAdapter.list(detailed.input), (error: unknown) => error === failure); assert.equal(failure.retryAfterSeconds, 90);
});

test("authentication failures are not turned into an ordinary partial detail", async () => {
  for (const status of [401, 403]) {
    const { input } = fixture([post()], { fetchDetails: true }); changeDetails(input, {}, status);
    await assert.rejects(smartRecruitersAdapter.list(input), (error: unknown) => error instanceof SourceTransportError && error.status === status);
  }
});

test("detail timeout retains downloaded listings and stops later requests and pagination", async () => {
  const { input, urls } = fixture([post("1"), post("2")], { fetchDetails: true }, 5); const original = input.transport;
  input.transport = { request: async (args) => { if (!args.url.includes("?")) { urls.push(args.url); throw new SourceTransportError("timeout"); } return original.request(args); } };
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(urls.length, 2); assert.equal(result.records.length, 2); assert.equal(result.nextCursor, undefined);
  assert.equal(result.coverage.partial, true); assert.equal(result.stopReason, "source-error");
  assert.ok(result.warnings.some((warning) => warning.includes("timeout stopped")));
});

test("a bad detail response preserves the list and does not poison another same-page detail", async () => {
  const { input, urls } = fixture([post("1"), post("2")], { fetchDetails: true }); const original = input.transport;
  input.transport = { request: async (args) => args.url === `${ENDPOINT}/1` ? { url: args.url, status: 200, headers: {}, text: "not-json" } : original.request(args) };
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records[0]!.description, undefined); assert.equal(result.records[1]!.completeness, "detail");
  assert.equal(result.coverage.partial, true); assert.equal(urls.length, 2);
});

test("host budgets and unsafe-endpoint failures are never swallowed by detail enrichment", async () => {
  for (const failure of [new ToolError("budget-exceeded"), new SourceTransportError("unsafe-endpoint")]) {
    const { input, urls } = fixture([post("1"), post("2")], { fetchDetails: true }); const original = input.transport;
    input.transport = { request: async (args) => { if (!args.url.includes("?")) throw failure; return original.request(args); } };
    await assert.rejects(smartRecruitersAdapter.list(input), (error: unknown) => error === failure); assert.equal(urls.length, 1);
  }
});

test("inert option schema rejects executable endpoints, ambiguous tenant paths and invalid countries", async () => {
  assert.equal(SmartRecruitersSourceOptionsSchema.safeParse({ companyIdentifier: "SyntheticOrg" }).success, true);
  for (const options of [{ companyIdentifier: "../Other" }, { companyIdentifier: "SyntheticOrg", endpoint: "https://evil.example" },
    { companyIdentifier: "SyntheticOrg", countryCode: "China" }, { companyIdentifier: "SyntheticOrg", pageSize: 101 }, { companyIdentifier: "SyntheticOrg", maxDetailRequestsPerPage: 11 }]) assert.equal(SmartRecruitersSourceOptionsSchema.safeParse(options).success, false);
  for (const entryUrl of ["http://api.smartrecruiters.com/v1/companies/SyntheticOrg/postings", "https://api.smartrecruiters.com/v1/companies/Other/postings", `${ENDPOINT}?q=wrong`]) {
    const { input, urls } = fixture([]); input.source.entryUrl = entryUrl;
    await assert.rejects(smartRecruitersAdapter.list(input), code("invalid-input")); assert.equal(urls.length, 0);
  }
});

test("unsupported and control-character queries are rejected before network activity", async () => {
  for (const term of ["x".repeat(81), "C#\nsecret", " "]) {
    const { input, urls } = fixture([]); input.scope.roles = [term];
    await assert.rejects(smartRecruitersAdapter.list(input), code("invalid-input")); assert.equal(urls.length, 0);
  }
});

test("source release strings do not acquire invented timezones or update times", async () => {
  for (const releasedDate of ["2026-07-29", "2026-07-29T03:47:46", "2026-02-30T00:00:00Z"]) {
    const { input } = fixture([post("123", { releasedDate, createdOn: "2026-01-01T00:00:00Z" })]);
    const result = await smartRecruitersAdapter.list(input); assert.equal(result.records[0]!.sourcePublishedRaw, releasedDate);
    assert.equal(result.records[0]!.sourcePublishedAt, undefined); assert.equal(result.records[0]!.sourceUpdatedAt, undefined);
  }
});

test("remote flags and multi-city strings do not invent office precision or remote eligibility", async () => {
  const { input } = fixture([post("1", { location: { country: "cn", city: "Shanghai / Suzhou", remote: true } }), post("2", { location: { country: "cn", city: "Shanghai", remote: true, hybrid: true } })]);
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records[0]!.locations[0]!.city, undefined); assert.equal(result.records[0]!.workMode, "remote");
  assert.deepEqual(result.records[0]!.remoteEligibleRegions, []); assert.equal(result.records[1]!.workMode, "unknown");
});

test("missing qualifications and unsupported source sections remain excerpts", async () => {
  const { input } = fixture([post()], { fetchDetails: true });
  changeDetails(input, detail("123", { jobAd: { sections: { jobDescription: { title: "Duties", text: "Use C#" } } } }));
  const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records[0]!.completeness, "excerpt"); assert.ok(result.records[0]!.description!.includes("Use C#")); assert.equal(result.coverage.partial, true);
  const second = fixture([post()], { fetchDetails: true }); const value = detail();
  (value.jobAd.sections as Record<string, unknown>).unsupported = { text: "Additional source requirements" };
  changeDetails(second.input, value); const other = await smartRecruitersAdapter.list(second.input);
  assert.equal(other.records[0]!.completeness, "excerpt"); assert.equal(other.coverage.partial, true);
});

test("an altered response URL is rejected and never grants a new endpoint", async () => {
  const { input } = fixture([]); const original = input.transport;
  input.transport = { request: async (args) => ({ ...await original.request(args), url: "https://evil.example/postings" }) };
  await assert.rejects(smartRecruitersAdapter.list(input), code("source-changed"));
});

test("malformed source titles are omitted as partial rather than an empty verified result", async () => {
  const { input } = fixture([post("1", { name: "x".repeat(1001) })]); const result = await smartRecruitersAdapter.list(input);
  assert.equal(result.records.length, 0); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.partial, true);
});
