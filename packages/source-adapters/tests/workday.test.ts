import assert from "node:assert/strict";
import test from "node:test";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext, SourceAdapterRequest } from "../src/contracts.js";
import { WorkdaySourceOptionsSchema } from "../src/workday-contracts.js";
import { workdayAdapter } from "../src/adapters/workday.js";
import { createSourceRegistry } from "../src/registry.js";
import { SourceTransportError } from "../src/transport.js";

const ORIGIN = "https://jll.wd1.myworkdayjobs.com";
const SITE = "jllcareerschina";
const BASE = `${ORIGIN}/wday/cxs/jll/${SITE}`;
function source(overrides: Partial<SourceDefinition> = {}): SourceDefinition {
  return { sourceId: "reviewed-jll-china-workday", name: "JLL China careers · Workday", adapterId: "workday-cxs", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service", "server"], entityType: "job-posting", enabled: true, status: "active",
    entryUrl: `${ORIGIN}/${SITE}`, options: { tenant: "jll", site: SITE, pageSize: 2, maxDetailRequestsPerPage: 1 }, remoteFilters: ["roles"],
    endpointPolicy: { allowedHosts: [new URL(ORIGIN).hostname], allowedPathPrefixes: [`/wday/cxs/jll/${SITE}`], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "JLL China careers · Workday", homepageUrl: `${ORIGIN}/zh-CN/jllcareerschina`, usage: "unknown", requiresAttribution: true, notes: "Unreviewed use scope. Local personal reads only; do not redistribute records." },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 3600, maxRecords: 2, maxPages: 2, requestsPerMinute: 5 }, ...overrides };
}
function row(id: string, index: number) { return { title: `Engineer ${index}`, externalPath: `/job/Beijing/Engineer-${index}_${id}`, locationsText: "Beijing, CN", postedOn: "Posted Yesterday", bulletFields: [id] }; }
function detail(id: string, index: number) {
  const externalUrl = `${ORIGIN}/${SITE}/job/Beijing/Engineer-${index}_${id}`;
  return { jobPostingInfo: { title: `Engineer ${index}`, jobReqId: id, jobPostingId: `Engineer-${index}_${id}`, jobPostingSiteId: SITE, externalUrl, posted: true, canApply: true, startDate: "2026-10-23", postedOn: "Posted Yesterday", location: "Beijing, CN", country: { alpha2Code: "CN", descriptor: "China (Mainland)" }, remoteType: "On-site", jobDescription: "<p>Build <b>reliable systems</b>.</p>" }, hiringOrganization: { name: "JLL Example Beijing Ltd" } };
}
function fixture(options: { roles?: string[]; rows?: unknown[]; details?: Map<string, unknown>; maxDetail?: number } = {}) {
  const definition = source({ options: { tenant: "jll", site: SITE, pageSize: 2, maxDetailRequestsPerPage: options.maxDetail ?? 1 } });
  const context: SourceAdapterContext = { requestId: "workday-synthetic", actorScope: "synthetic-owner", observedAt: "2026-10-24T00:00:00Z", signal: new AbortController().signal, budget: { requests: 10, bytes: 100_000, timeoutMs: 5000 }, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {} };
  const sent: Array<{ url: string; method?: string; jsonBody?: string }> = [];
  const rows = options.rows ?? [row("REQ123", 0), row("REQ456", 1)];
  const transport = { async request(request: { url: string; method?: "GET" | "POST"; jsonBody?: string }) {
    sent.push(request);
    return { url: request.url, status: 200, headers: {}, text: request.method === "POST" ? JSON.stringify({ total: 75, jobPostings: rows }) : JSON.stringify(options.details?.get(request.url) ?? {}) };
  } };
  return { request: { source: definition, scope: { roles: options.roles ?? [], regions: [], companyNames: [] }, context, transport } as SourceAdapterRequest, sent };
}

test("Workday source options cannot carry arbitrary endpoints or unbounded lists", async () => {
  assert.equal(WorkdaySourceOptionsSchema.safeParse({ tenant: "../other", site: SITE }).success, false);
  assert.equal(WorkdaySourceOptionsSchema.safeParse({ tenant: "jll", site: SITE, pageSize: 101 }).success, false);
  const f = fixture(); f.request.source.options = { tenant: "other", site: SITE };
  await assert.rejects(workdayAdapter.list(f.request), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
  f.request.source.options = { tenant: "jll", site: SITE }; f.request.source.endpointPolicy.allowedHosts = ["attacker.example.com"];
  await assert.rejects(workdayAdapter.list(f.request), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
});

test("Workday lists one bounded page with the installed POST transport and preserves location/date evidence", async () => {
  const f = fixture(); const result = await workdayAdapter.list(f.request);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0]!.method, "POST"); assert.equal(f.sent[0]!.url, `${BASE}/jobs`); assert.equal(f.sent[1]!.url, `${BASE}/job/Beijing/Engineer-0_REQ123`);
  assert.deepEqual(JSON.parse(f.sent[0]!.jsonBody!), { appliedFacets: {}, limit: 2, offset: 0, searchText: "" });
  assert.deepEqual(result.records.map(job => job.sourceRecordId), ["REQ123", "REQ456"]);
  assert.equal(result.records[0]!.locations[0]!.countryCode, undefined); assert.equal(result.records[0]!.locations[0]!.raw, "Beijing, CN");
  assert.equal(result.records[0]!.sourcePublishedRaw, "Posted Yesterday"); assert.equal(result.records[0]!.sourcePublishedAt, undefined);
  assert.ok(result.records[0]!.evidence.some(item => item.field === "sourceRecordId" && item.selector === "jobPostings[0].bulletFields" && item.quote === "REQ123"));
  assert.ok(result.records[0]!.evidence.some(item => item.field === "url" && item.selector === "jobPostings[0].externalPath"));
  assert.equal(result.records[0]!.completeness, "excerpt"); assert.equal(result.records[1]!.completeness, "excerpt");
  assert.equal(result.coverage.totalAvailable, undefined); assert.equal(result.coverage.partial, true);
  assert.ok(result.warnings.some(warning => warning.includes("configured Workday tenant")));
});

test("Workday keyword search sends one term, enforces local page size and binds continuation to source and query", async () => {
  const f = fixture({ roles: ["engineer"], maxDetail: 0 }); const first = await workdayAdapter.list(f.request);
  assert.equal(JSON.parse(f.sent[0]!.jsonBody!).searchText, "engineer"); assert.equal(first.coverage.appliedFilters[0], "roles");
  assert.ok(first.nextCursor); assert.equal(first.coverage.totalAvailable, 75);
  f.request.cursor = first.nextCursor; const next = await workdayAdapter.list(f.request);
  assert.equal(JSON.parse(f.sent[1]!.jsonBody!).offset, 2); assert.equal(next.nextCursor !== undefined, true);
  const changed = fixture({ roles: ["engineer"] }).request; changed.cursor = first.nextCursor; changed.scope.roles = ["analyst"];
  await assert.rejects(workdayAdapter.list(changed), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
  const changedSource = fixture({ roles: ["engineer"] }).request; changedSource.cursor = first.nextCursor; (changedSource.source.options as Record<string, unknown>).site = "other";
  await assert.rejects(workdayAdapter.list(changedSource), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
});

test("Workday continuation survives the job service's shrinking per-run record quota", async () => {
  const f = fixture({ roles: ["engineer"], maxDetail: 0, rows: [row("REQ123", 0), row("REQ456", 1)] });
  f.request.transport = { async request(input) {
    f.sent.push(input);
    const offset = input.jsonBody ? JSON.parse(input.jsonBody).offset : -1;
    return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 3, jobPostings: offset === 0 ? [row("REQ123", 0), row("REQ456", 1)] : [row("REQ789", 2)] }) };
  } };
  const first = await workdayAdapter.list(f.request);
  assert.ok(first.nextCursor);
  f.request.cursor = first.nextCursor;
  f.request.source.refreshPolicy.maxRecords = 1;
  f.request.context.budget.requests = 1;
  const second = await workdayAdapter.list(f.request);
  assert.equal(JSON.parse(f.sent[1]!.jsonBody!).offset, 2);
  assert.equal(JSON.parse(f.sent[1]!.jsonBody!).limit, 1);
  assert.equal(second.records[0]!.sourceRecordId, "REQ789");
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.coverage.partial, true, "the configured zero-detail allowance must remain visible as incomplete detail coverage");
});

test("Workday continuation moves through multiple role terms without combining upstream totals", async () => {
  const f = fixture({ roles: ["engineer", "analyst"], maxDetail: 0, rows: [] });
  f.request.transport = { async request(input) {
    f.sent.push(input);
    const body = JSON.parse(input.jsonBody!);
    return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 0, jobPostings: [], searchText: body.searchText }) };
  } };
  const first = await workdayAdapter.list(f.request);
  assert.ok(first.nextCursor); assert.equal(first.coverage.totalAvailable, undefined);
  f.request.cursor = first.nextCursor;
  const second = await workdayAdapter.list(f.request);
  assert.equal(JSON.parse(f.sent[0]!.jsonBody!).searchText, "engineer");
  assert.equal(JSON.parse(f.sent[1]!.jsonBody!).searchText, "analyst");
  assert.equal(second.nextCursor, undefined); assert.equal(second.coverage.complete, true);
  assert.equal(second.coverage.totalAvailable, undefined);
});

test("Workday rejects a queryless result when the source reports a different search term", async () => {
  const f = fixture({ rows: [] });
  f.request.transport = { async request(input) { return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 0, jobPostings: [], searchText: "unexpected" }) }; } };
  await assert.rejects(workdayAdapter.list(f.request), (error: unknown) => error instanceof ToolError && error.code === "source-changed");
});

test("Workday short inconsistent and overfull pages stop without issuing an unsafe offset", async () => {
  const short = fixture({ roles: ["engineer"], rows: [row("REQ123", 0)], maxDetail: 0 });
  short.request.transport = { async request(input) { short.sent.push(input); return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 75, jobPostings: [row("REQ123", 0)] }) }; } };
  const shortPage = await workdayAdapter.list(short.request);
  assert.equal(shortPage.nextCursor, undefined); assert.equal(shortPage.coverage.partial, true);
  assert.ok(shortPage.warnings.some(warning => warning.includes("fewer records than its requested page")));

  const overfull = fixture({ roles: ["engineer"], maxDetail: 0 });
  overfull.request.transport = { async request(input) { overfull.sent.push(input); return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 75, jobPostings: [row("REQ123", 0), row("REQ456", 1), row("REQ789", 2)] }) }; } };
  const overfullPage = await workdayAdapter.list(overfull.request);
  assert.deepEqual(overfullPage.records.map(job => job.sourceRecordId), ["REQ123", "REQ456"]);
  assert.equal(overfullPage.nextCursor, undefined); assert.equal(overfullPage.coverage.partial, true);
  assert.ok(overfullPage.warnings.some(warning => warning.includes("more records than the requested page limit")));
});

test("Workday details validate the original tenant ID and keep disclosed fields evidence based", async () => {
  const exact = row("REQ123", 0), detailUrl = `${BASE}/job/Beijing/Engineer-0_REQ123`;
  const f = fixture({ roles: ["Build"], rows: [exact], details: new Map([[detailUrl, detail("REQ123", 0)]]), maxDetail: 1 });
  const result = await workdayAdapter.list(f.request);
  const job = result.records[0]!;
  assert.equal(job.completeness, "detail"); assert.equal(job.availability, "open"); assert.equal(job.availabilityBasis, "detail-explicit"); assert.deepEqual(f.sent.map(item => item.url), [`${BASE}/jobs`, `${BASE}/job/Beijing/Engineer-0_REQ123`]);
  assert.equal(job.companyName, "JLL Example Beijing Ltd"); assert.equal(job.workMode, "on-site");
  assert.equal(job.locations[0]!.countryCode, "CN"); assert.equal(job.description, "Build reliable systems.");
  assert.equal(job.compensations.length, 0); assert.equal(job.locations[0]!.streetAddress, undefined);
  assert.ok(job.evidence.some(item => item.field === "source.canApply")); assert.ok(job.evidence.some(item => item.field === "sourcePublishedRaw" && item.quote === "Posted Yesterday"));
  assert.ok(job.evidence.some(item => item.field === "sourceRecordId" && item.selector === "jobPostingInfo.jobReqId" && item.quote === "REQ123"));
  assert.ok(job.evidence.some(item => item.field === "url" && item.selector === "jobPostingInfo.externalUrl" && item.quote === job.url));
  const registry = createSourceRegistry([workdayAdapter]);
  const exactResult = await registry.readDetail({ source: f.request.source, sourceRecordId: "REQ123", url: job.url!, context: f.request.context, transport: f.request.transport });
  assert.equal(exactResult.sourceRecordId, "REQ123");
  await assert.rejects(registry.readDetail({ source: f.request.source, sourceRecordId: "REQ999", url: job.url!, context: f.request.context, transport: f.request.transport }));
});

test("Workday detail budget enriches rows with undisclosed company and city before local scope matching", async () => {
  const detailUrl = "https://jll.wd1.myworkdayjobs.com/wday/cxs/jll/jllcareerschina/job/Beijing/Engineer-0_REQ123";
  const f = fixture({ roles: ["reliable systems"], rows: [{ title: "Engineer", externalPath: "/job/Beijing/Engineer-0_REQ123", bulletFields: ["REQ123"] }], details: new Map([[detailUrl, detail("REQ123", 0)]]), maxDetail: 1 });
  f.request.scope.companyNames = ["JLL Example Beijing"]; f.request.scope.regions = ["Beijing"];
  const result = await workdayAdapter.list(f.request);
  assert.deepEqual(f.sent.map(item => item.url), ["https://jll.wd1.myworkdayjobs.com/wday/cxs/jll/jllcareerschina/jobs", detailUrl]);
  assert.equal(result.records[0]!.companyName, "JLL Example Beijing Ltd");
  assert.equal(result.records[0]!.locations[0]!.raw, "Beijing, CN");
  assert.equal(result.records[0]!.completeness, "detail");
});

test("Workday malformed links, duplicate requisition IDs and unresolved role evidence never become confirmed matches", async () => {
  const f = fixture({ roles: ["principal architect"], rows: [row("REQ123", 0), { ...row("REQ123", 1), externalPath: "https://evil.example/job/REQ123" }], maxDetail: 0 });
  const result = await workdayAdapter.list(f.request);
  assert.equal(result.records.length, 1); assert.equal(result.records[0]!.completeness, "excerpt");
  assert.equal(result.coverage.partial, true); assert.ok(result.warnings.some(warning => warning.includes("omitted")));
  const next = fixture({ roles: ["a".repeat(81)] }).request;
  await assert.rejects(workdayAdapter.list(next), (error: unknown) => error instanceof ToolError && error.code === "invalid-input");
});

test("Workday posting URLs reject credentials, explicit ports and encoded path delimiters", async () => {
  const invalidPaths = [
    `https://user@jll.wd1.myworkdayjobs.com/${SITE}/job/Beijing/Engineer_REQ123`,
    `https://jll.wd1.myworkdayjobs.com:443/${SITE}/job/Beijing/Engineer_REQ123`,
    `/${SITE}/job/Beijing/Engineer%2FREQ123`,
  ];
  const f = fixture({ roles: ["engineer"], rows: invalidPaths.map((externalPath, index) => ({ title: `Engineer ${index}`, externalPath, bulletFields: ["REQ123"] })), maxDetail: 0 });
  const result = await workdayAdapter.list(f.request);
  assert.equal(result.records.length, 0);
  assert.equal(result.coverage.partial, true);
  for (const url of invalidPaths.slice(0, 2)) {
    await assert.rejects(workdayAdapter.readDetail!({ source: f.request.source, sourceRecordId: "REQ123", url, context: f.request.context, transport: f.request.transport }));
  }
});

test("Workday detail timeout retains listing data but stops pagination", async () => {
  const f = fixture({ roles: ["principal architect"], maxDetail: 1 });
  let calls = 0; f.request.transport = { async request(input) { calls++; if (calls > 1) throw new SourceTransportError("timeout"); return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 75, jobPostings: [row("REQ123", 0), row("REQ456", 1)] }) }; } };
  const result = await workdayAdapter.list(f.request);
  assert.equal(result.records.length, 2); assert.equal(result.records[0]!.completeness, "excerpt"); assert.equal(result.nextCursor, undefined); assert.equal(result.coverage.partial, true);
});

test("Workday authorization failures stop immediately and do not become ordinary missing-detail partials", async () => {
  const f = fixture({ roles: ["engineer"], maxDetail: 2 });
  let calls = 0;
  f.request.transport = { async request(input) {
    calls++; f.sent.push(input);
    if (calls === 1) return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 75, jobPostings: [row("REQ123", 0), row("REQ456", 1)] }) };
    return { url: input.url, status: 403, headers: {}, text: "restricted" };
  } };
  await assert.rejects(workdayAdapter.list(f.request), (error: unknown) => error instanceof SourceTransportError && error.status === 403);
  assert.equal(calls, 2, "authorization failure stops subsequent detail reads and pagination");
});

test("Workday explicit detail ID read accepts only the exact tenant site and external URL", async () => {
  const url = `${ORIGIN}/${SITE}/job/Beijing/Engineer-0_REQ123`;
  const f = fixture({ details: new Map([[`${BASE}/job/Beijing/Engineer-0_REQ123`, detail("REQ123", 0)]]) });
  const exact = await workdayAdapter.readDetail!({ source: f.request.source, sourceRecordId: "REQ123", url, context: f.request.context, transport: f.request.transport });
  assert.equal(exact.sourceRecordId, "REQ123"); assert.equal(exact.url, url);
  for (const changed of [
    { sourceRecordId: "REQ999", url },
    { sourceRecordId: "REQ123", url: `${ORIGIN}/other/job/Beijing/Engineer-0_REQ123` },
    { sourceRecordId: "REQ123", url: `${ORIGIN}/${SITE}/job/Beijing/Other_REQ123` },
  ]) await assert.rejects(workdayAdapter.readDetail!({ source: f.request.source, ...changed, context: f.request.context, transport: f.request.transport }));
});

test("Workday source IDs support observed tenant prefixes beyond REQ", async () => {
  for (const id of ["JR-123", "R108057-2", "_REQ123"]) {
    const externalPath = `/job/Beijing/Engineer_${id}`;
    const f = fixture({ roles: ["engineer"], rows: [{ title: "Engineer", externalPath, bulletFields: [id] }], maxDetail: 0 });
    const result = await workdayAdapter.list(f.request);
    assert.equal(result.records[0]!.sourceRecordId, id);
  }
});
