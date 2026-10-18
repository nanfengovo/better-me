import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDefinition } from "@better-me/opportunities";
import {
  SourceJobRecordSchema, SourcePageSchema, SourceRegistryError, SourceScopeSchema,
  type SourceAdapter, type SourceAdapterContext, type SourceAdapterRequest, type SourceJobRecord,
  type SourcePage, type SourceRegistryErrorCode,
} from "../src/contracts.js";
import { createSourceRegistry } from "../src/registry.js";

const at = "2026-10-18T12:00:00.000Z";
const emptyScope = { roles: [], regions: [], companyNames: [] };
function source(overrides: Partial<SourceDefinition> = {}): SourceDefinition {
  return {
    sourceId: "synthetic-source", name: "Synthetic source", adapterId: "synthetic-json", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 }, ...overrides,
  };
}
function record(overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return {
    entityType: "job-posting", sourceRecordId: "role-1", url: "https://example.test/jobs/1", title: "Synthetic engineer",
    companyName: "Synthetic company", description: "Synthetic source description", locations: [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [],
    availability: "unknown", completeness: "detail", evidence: [{ field: "title", selector: "$.title", sourceUrl: "https://example.test/jobs/1" }], warnings: [], ...overrides,
  };
}
function page(overrides: Partial<SourcePage> = {}): SourcePage {
  return { records: [record()], observedAt: at, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [], ...overrides };
}
function adapter(handler: SourceAdapter["list"] = async () => page()): SourceAdapter {
  return { adapterId: "synthetic-json", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"], list: handler };
}
function context(): SourceAdapterContext {
  return {
    requestId: "synthetic-request", actorScope: "local", signal: new AbortController().signal, budget: { requests: 10, bytes: 100_000, timeoutMs: 1000 },
    observedAt: at, consumeRequests() {}, consumeBytes() {}, throwIfCancelled() {},
  };
}
function request(overrides: Partial<SourceAdapterRequest> = {}): SourceAdapterRequest {
  return { source: source(), scope: emptyScope, context: context(), transport: { async request() { throw new Error("A synthetic registry test must not perform network requests."); } }, ...overrides };
}
const hasCode = (code: SourceRegistryErrorCode) => (error: unknown) => error instanceof SourceRegistryError && error.code === code;

test("registry lists only explicitly registered adapter identities and versions", () => {
  const registry = createSourceRegistry([adapter()]);
  assert.deepEqual(registry.describe(), [{ adapterId: "synthetic-json", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"] }]);
  assert.equal(registry.resolve(source()).adapter.adapterId, "synthetic-json");
  assert.throws(() => registry.resolve(source({ adapterId: "uninstalled-module" })), hasCode("adapter-not-found"));
  assert.throws(() => registry.resolve(source({ adapterVersion: "2" })), hasCode("unsupported-version"));
  assert.throws(() => registry.register(adapter()), hasCode("duplicate-adapter"));
});

test("registry metadata cannot be mutated through caller-owned adapter arrays or descriptions", () => {
  const original = adapter();
  const registry = createSourceRegistry([original]);
  original.capabilities.push("search-remote");
  const description = registry.describe();
  description[0]!.capabilities.push("read-detail");
  registry.resolve(source()).adapter.capabilities.push("verify-status");
  assert.deepEqual(registry.describe()[0]!.capabilities, ["list-jobs"]);
});

test("discovery candidates and disabled sources cannot execute", async () => {
  let calls = 0;
  const registry = createSourceRegistry([adapter(async () => { calls++; return page(); })]);
  for (const config of [source({ enabled: false }), source({ status: "needs-review" }), source({ status: "disabled" }), source({ status: "unavailable" })]) {
    await assert.rejects(registry.list(request({ source: config })), hasCode("source-disabled"));
  }
  assert.equal(calls, 0);
});

test("registry capability and runtime checks use the source-adapter intersection", () => {
  const registry = createSourceRegistry([adapter()]);
  assert.throws(() => registry.resolve(source({ capabilities: ["list-jobs", "search-remote"] }), "search-remote"), hasCode("unsupported-capability"));
  assert.throws(() => registry.resolve(source(), "list-jobs", "server"), hasCode("unsupported-capability"));
  assert.throws(() => registry.resolve(source({ capabilities: [] })), hasCode("unsupported-capability"));
  assert.throws(() => registry.resolve(source({ entityType: "recruitment-campaign" })), hasCode("unsupported-capability"));
});

test("unsupported scope filters remain explicit rather than being claimed as upstream search", async () => {
  const scope = { roles: ["engineer"], regions: ["Shanghai"], companyNames: ["Synthetic company"] };
  const expected = page({ coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: ["roles", "regions", "companyNames"] } });
  const registry = createSourceRegistry([adapter(async (input) => { assert.deepEqual(input.scope, scope); return expected; })]);
  assert.deepEqual(await registry.list(request({ scope })), expected);
  const dishonest = createSourceRegistry([adapter(async () => page({ coverage: { ...expected.coverage, appliedFilters: ["roles"], ignoredFilters: ["regions", "companyNames"] } }))]);
  await assert.rejects(dishonest.list(request({ scope })), hasCode("invalid-output"));
  const omitted = createSourceRegistry([adapter()]);
  await assert.rejects(omitted.list(request({ scope })), hasCode("invalid-output"));
});

test("a declared upstream filter requires both adapter and source capability declarations", async () => {
  const supported = { ...adapter(async () => page({ coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: ["regions"], ignoredFilters: ["roles"] } })), remoteFilters: ["regions" as const] };
  const registry = createSourceRegistry([supported]);
  const input = request({ source: source({ remoteFilters: ["regions"] }), scope: { roles: ["engineer"], regions: ["CN"], companyNames: [] } });
  assert.equal((await registry.list(input)).coverage.appliedFilters[0], "regions");
  await assert.rejects(registry.list({ ...input, source: source() }), hasCode("invalid-output"));
});

test("registry validates page record limits, timestamp ownership and malformed output", async () => {
  const excessive = createSourceRegistry([adapter(async () => page({ records: [record(), record({ sourceRecordId: "role-2" })], coverage: { complete: true, partial: false, fetchedRecords: 2, appliedFilters: [], ignoredFilters: [] } }))]);
  await assert.rejects(excessive.list(request({ source: source({ refreshPolicy: { ...source().refreshPolicy, maxRecords: 1 } }) })), hasCode("invalid-output"));
  const wrongTime = createSourceRegistry([adapter(async () => page({ observedAt: "2026-10-19T12:00:00.000Z" }))]);
  await assert.rejects(wrongTime.list(request()), hasCode("invalid-output"));
  const malformed = createSourceRegistry([adapter(async () => ({ ...page(), unknownSecret: "must not pass" } as SourcePage))]);
  await assert.rejects(malformed.list(request()), hasCode("invalid-output"));
});

test("registry returns parsed copies and checks cancellation before and after adapter execution", async () => {
  const output = page();
  const registry = createSourceRegistry([adapter(async () => output)]);
  const ctx = context();
  let checks = 0;
  ctx.throwIfCancelled = () => { checks++; };
  const result = await registry.list(request({ context: ctx }));
  assert.equal(checks, 2);
  result.records[0]!.title = "Changed result";
  assert.equal(output.records[0]!.title, "Synthetic engineer");
  const cancelled = context();
  cancelled.throwIfCancelled = () => { throw new Error("Synthetic cancellation"); };
  await assert.rejects(registry.list(request({ context: cancelled })), /Synthetic cancellation/);
});

test("record schemas keep campaigns and leads separate from exact jobs", () => {
  assert.equal(SourceJobRecordSchema.safeParse(record({ entityType: "recruitment-campaign", completeness: "detail" })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse(record({ entityType: "discovery-lead", completeness: "lead" })).success, true);
  assert.equal(SourceJobRecordSchema.safeParse(record({ description: undefined, completeness: "detail" })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse(record({ url: undefined, sourceRecordId: undefined })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse(record({ availability: "open" })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse(record({ availability: "open", availabilityBasis: "source-explicit" })).success, true);
});

test("record schemas preserve original times and reject ambiguous or invented numeric fields", () => {
  const parsed = SourceJobRecordSchema.parse(record({ sourceUpdatedRaw: "2026年10月更新，日期未给出", locations: [{ raw: "Europe" }] }));
  assert.equal(parsed.sourceUpdatedAt, undefined);
  assert.equal(parsed.locations[0]!.countryCode, undefined);
  assert.equal(SourceJobRecordSchema.safeParse(record({ evidence: [{ field: "title", sourceUrl: "https://example.test/jobs/1" }] })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse(record({ compensations: [{ raw: "20–10", min: 20, max: 10, currency: "CNY", period: "year", tax: "unknown", kind: "unknown" }] })).success, false);
  assert.equal(SourceJobRecordSchema.safeParse({ ...record(), rawApiKey: "not-allowed" }).success, false);
});

test("page completeness cannot hide continuation, budget stops or missing records", () => {
  assert.equal(SourcePageSchema.safeParse(page({ nextCursor: "page-2" })).success, false);
  assert.equal(SourcePageSchema.safeParse(page({ stopReason: "record-limit" })).success, false);
  assert.equal(SourcePageSchema.safeParse(page({ coverage: { ...page().coverage, fetchedRecords: 0 } })).success, false);
  assert.equal(SourcePageSchema.safeParse(page({ coverage: { ...page().coverage, complete: false } })).success, false);
  assert.equal(SourcePageSchema.safeParse(page({ nextCursor: "page-2", coverage: { ...page().coverage, complete: false } })).success, true);
  assert.equal(SourcePageSchema.safeParse(page({ stopReason: "record-limit", coverage: { ...page().coverage, complete: false, partial: true } })).success, true);
});

test("scope and registry errors remain bounded and never disclose source contents", async () => {
  assert.equal(SourceScopeSchema.safeParse({ ...emptyScope, arbitraryScript: "run" }).success, false);
  assert.equal(SourceScopeSchema.safeParse({ ...emptyScope, roles: Array(101).fill("x") }).success, false);
  const registry = createSourceRegistry([adapter()]);
  const unsafe = source({ entryUrl: "https://synthetic-secret-value@example.test/" });
  await assert.rejects(registry.list(request({ source: unsafe })), (error: unknown) => {
    assert.ok(error instanceof SourceRegistryError);
    assert.equal(error.code, "invalid-source");
    assert.equal(error.message.includes("synthetic-secret-value"), false);
    return true;
  });
});
