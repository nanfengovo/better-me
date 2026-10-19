import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createToolRegistry, MapReferencesResultSchema, JobQueryResultSchema, type AtlasDataset, type JobLocation, type SourceDefinition, type TrustedToolContext, type ToolResult } from "@better-me/opportunities";
import { createLocalGazetteerProvider, type MapReferenceProvider } from "@better-me/source-adapters";
import { createLocationMapReferencesTool } from "../src/location-map-references.js";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";

function location(id: string, changes: Partial<JobLocation> = {}): JobLocation {
  return { id, raw: "上海市-浦东新区", city: "上海", countryCode: "CN", precision: "city", kind: "unknown", verification: "unverified", evidence: [], ...changes };
}
function dataset(locations: JobLocation[]): AtlasDataset {
  return { schemaVersion: 1, revision: 7, sources: [], companies: [], jobs: [], locations, listings: [], observations: [], compensations: [], snapshots: [] };
}
function context(overrides: Partial<TrustedToolContext> = {}): TrustedToolContext {
  return { requestId: "synthetic-map-reference", actorScope: "local-owner", allowedEffects: ["read-index"], signal: new AbortController().signal, budget: { requests: 0, bytes: 2_000_000, timeoutMs: 5000 }, ...overrides };
}
function localProvider() { return createLocalGazetteerProvider({ manifestPath: fileURLToPath(new URL("../../../config/geography/gazetteer/manifest.json", import.meta.url)) }); }
function fixture(data: AtlasDataset, provider: MapReferenceProvider = localProvider()) {
  let reads = 0;
  const repository = { async readSnapshot() { reads++; return structuredClone(data); } };
  const tool = createLocationMapReferencesTool(repository, provider);
  return { registry: createToolRegistry([tool]), reads: () => reads };
}
function value(result: ToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return MapReferencesResultSchema.parse(result.value); }
function failure(result: ToolResult, code: string) { assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.equal(result.error.code, code); }

test("map reference tool reads one bound snapshot and derives deduplicated cities without modifying source facts", async () => {
  const data = dataset([location("location.b"), location("location.a")]); const before = structuredClone(data); const f = fixture(data);
  const result = value(await f.registry.execute("locations.map-references", { expectedRevision: 7 }, context()));
  assert.equal(f.reads(), 1); assert.equal(result.snapshotRevision, 7); assert.equal(result.references.length, 2); assert.equal(result.places.length, 1);
  assert.deepEqual(result.references.map(row => row.locationId), ["location.a", "location.b"]);
  assert.equal(result.places[0]!.place.id, "geonames.1796236"); assert.equal(result.places[0]!.precision, "city"); assert.equal(result.places[0]!.estimated, true);
  assert.equal(result.provenance!.license, "CC-BY-4.0"); assert.equal(result.truncated, false); assert.deepEqual(data, before);
  assert.equal(data.locations[0]!.coordinates, undefined); assert.equal(data.locations[0]!.kind, "unknown");
});

test("explicit subsets, bounded truncation and missing identities are reported faithfully", async () => {
  const f = fixture(dataset([location("location.b"), location("location.a"), location("location.c", { kind: "remote-region" })]));
  const limited = value(await f.registry.execute("locations.map-references", { expectedRevision: 7, limit: 1 }, context()));
  assert.equal(limited.totalLocations, 3); assert.equal(limited.processedLocations, 1); assert.equal(limited.truncated, true);
  assert.equal(limited.references[0]!.locationId, "location.a");
  const subset = value(await f.registry.execute("locations.map-references", { expectedRevision: 7, locationIds: ["location.c"] }, context()));
  assert.equal(subset.totalLocations, 1); assert.equal(subset.processedLocations, 1); assert.deepEqual(subset.references, []);
  assert.deepEqual(subset.unresolved, [{ locationId: "location.c", reason: "remote-region" }]);
  const empty = value(await f.registry.execute("locations.map-references", { expectedRevision: 7, locationIds: [] }, context()));
  assert.equal(empty.totalLocations, 0); assert.equal(empty.processedLocations, 0); assert.equal(empty.truncated, false);
  failure(await f.registry.execute("locations.map-references", { expectedRevision: 7, locationIds: ["missing"] }, context()), "invalid-input");
});

test("stale revision, forbidden effects, private side inputs and exhausted output budget cannot invoke a hidden lookup", async () => {
  let calls = 0;
  const provider: MapReferenceProvider = { providerId: "synthetic", offline: true, resolveMapReferences: async locations => {
    calls++; return { providerId: "synthetic", places: [], references: [], unresolved: locations.map(row => ({ locationId: row.id, reason: "no-exact-match" })), warnings: [] };
  } };
  const f = fixture(dataset([location("one")]), provider);
  failure(await f.registry.execute("locations.map-references", { expectedRevision: 6 }, context()), "stale-version");
  failure(await f.registry.execute("locations.map-references", { expectedRevision: 7 }, context({ allowedEffects: [] })), "not-authorized");
  for (const extra of [{ homeAddress: "PRIVATE_HOME" }, { manifestPath: "PRIVATE_FILE" }, { providerId: "PRIVATE_PROVIDER" }]) {
    const result = await f.registry.execute("locations.map-references", { expectedRevision: 7, ...extra }, context());
    failure(result, "invalid-input"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
  assert.equal(calls, 0);
  const result = await f.registry.execute("locations.map-references", { expectedRevision: 7 }, context({ budget: { requests: 0, bytes: 80, timeoutMs: 5000 } }));
  failure(result, "budget-exceeded"); assert.equal(calls, 1);
});

test("tool refuses a provider with wrong identity, location fingerprint or remote eligibility references", async () => {
  const data = dataset([location("one")]); const actual = localProvider();
  for (const mode of ["provider", "fingerprint", "remote"] as const) {
    const provider: MapReferenceProvider = { providerId: actual.providerId, offline: true, resolveMapReferences: async (locations, context) => {
      const projection = await actual.resolveMapReferences(locations, context);
      if (mode === "provider") projection.providerId = "foreign-provider";
      else if (mode === "fingerprint") projection.references[0]!.locationFingerprint = "a".repeat(64);
      return projection;
    } };
    // A false office result for a remote location is independently rejected by source binding.
    const current = mode === "remote" ? dataset([location("one", { kind: "remote-region" })]) : structuredClone(data);
    if (mode === "remote") provider.resolveMapReferences = async (_locations, context) => actual.resolveMapReferences([location("one")], context);
    const f = fixture(current, provider);
    failure(await f.registry.execute("locations.map-references", { expectedRevision: 7 }, context()), "invalid-output");
  }
});

test("authenticated map-reference HTTP and jobs.search reuse the bound projection without database writes", async () => {
  const at = "2026-10-19T00:00:00.000Z";
  const source: SourceDefinition = { sourceId: "synthetic-city-map-source", name: "Synthetic map source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 10 } };
  const repository = openJobRepository(":memory:", { now: () => at }); const application = createJobApplication({ repository, now: () => at });
  const token = "synthetic-map-http-token-1234567890", origin = "http://localhost:5173";
  const http = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [origin], port: 0 });
  try {
    const projection = await projectSourcePage(await repository.readSnapshot(), source, { observedAt: at,
      records: [{ entityType: "job-posting", sourceRecordId: "one", url: "https://careers.example.test/jobs/one", title: "Synthetic C# engineer", companyName: "Synthetic company", description: "Synthetic C# job requirements.", locations: [{ raw: "上海", city: "上海", countryCode: "CN" }], compensations: [], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] }],
      coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "synthetic-seed");
    await repository.importSnapshot(projection.delta, { actorScope: "local-owner", idempotencyKey: "synthetic-seed", expectedRevision: 0 });
    const before = await repository.backup(); const revision = before.dataset.revision;
    const expected = value(await application.registry.execute("locations.map-references", { expectedRevision: revision }, context()));
    const { url } = await http.listen(); const route = `${url}/api/v1/locations/map-references`;
    assert.equal((await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: revision }) })).status, 401);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: origin };
    const response = await fetch(route, { method: "POST", headers, body: JSON.stringify({ expectedRevision: revision }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(value(await response.json() as ToolResult), expected);
    const query = await application.registry.execute("jobs.search", { search: { text: "C#" }, market: "domestic", mapCityReferences: true }, context());
    assert.equal(query.ok, true, JSON.stringify(query));
    if (query.ok) {
      const result = JobQueryResultSchema.parse(query.value); assert.equal(result.totalJobs, 1); assert.equal(result.mappedJobs, 0);
      assert.equal(result.items[0]!.mapReferences?.length, 1); assert.equal(result.items[0]!.locations[0]!.coordinates, undefined);
      assert.equal(result.items[0]!.distance, undefined); assert.equal(result.mapBuckets[0]!.positionBasis, "city-reference");
    }
    assert.deepEqual(await repository.backup(), before);
    const stale = await fetch(route, { method: "POST", headers, body: JSON.stringify({ expectedRevision: revision - 1 }) });
    failure(await stale.json() as ToolResult, "stale-version");
  } finally { await http.close(); await application.shutdown(); repository.close(); }
});

test("cancellation discards late provider results and leaves the source snapshot unchanged", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  const data = dataset([location("one")]); const before = structuredClone(data); const controller = new AbortController();
  const f = fixture(data, { providerId: "synthetic", offline: true, resolveMapReferences: async locations => {
    enter(); await blocked;
    return { providerId: "synthetic", places: [], references: [], unresolved: locations.map(row => ({ locationId: row.id, reason: "no-exact-match" })), warnings: [] };
  } });
  const running = f.registry.execute("locations.map-references", { expectedRevision: 7 }, context({ signal: controller.signal }));
  await entered; controller.abort(); release(); failure(await running, "cancelled"); assert.deepEqual(data, before);
});
