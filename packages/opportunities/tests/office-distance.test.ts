import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, type AtlasDataset } from "../src/schema.js";
import { applyOfficeAddressConfirmation } from "../src/office-address.js";
import { queryJobs, createJobQueryService, type JobQueryInput } from "../src/query.js";
import { JobQueryResultSchema } from "../src/query-output.js";
import { LocationDistanceSchema } from "../src/geo.js";
import { createJobsSearchTool } from "../src/services.js";
import { createToolRegistry } from "../src/tools.js";

const AT = "2026-10-19T00:00:00.000Z";
const URL = "https://careers.example.test/jobs/synthetic-office";
const evidence = [{ observationId: "synthetic-observation", sourceUrl: URL, observedAt: AT, quote: "Synthetic office location disclosure" }];
const point = (latitude: number) => ({ latitude, longitude: 0, coordinateSystem: "WGS84" as const });
const options = { now: AT, anchor: { ref: "opaque-office-distance-anchor", ...point(0) } };
const query: JobQueryInput = { distance: { anchorRef: options.anchor.ref, maxKm: 10, includeUnknown: false }, sort: { field: "distance", direction: "asc" }, mapLevel: "location" };

/** All addresses and points are synthetic; this fixture uses the actual confirmation projection and query. */
function dataset(): AtlasDataset {
  const base = AtlasDatasetSchema.parse({ schemaVersion: 1, revision: 2,
    sources: [{ sourceId: "synthetic-source", name: "Synthetic", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"],
      entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
      attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 10, maxPages: 1, requestsPerMinute: 1 } }],
    companies: [{ id: "synthetic-company", names: ["Synthetic employer"], domains: [], parentCompanyIds: [], manualOverrides: [],
      ultimateControllers: { value: [], evidence: [], verification: "unknown", method: "manual", revision: 0 } }],
    jobs: [{ id: "synthetic-job", companyId: "synthetic-company", title: { value: "Synthetic engineer", evidence, verification: "unverified", method: "source-structured", revision: 0 },
      description: "Synthetic office role", locationIds: ["synthetic-office", "synthetic-far-office"], compensationIds: [], listingIds: ["synthetic-listing"],
      workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: AT }],
    locations: [
      { id: "synthetic-office", raw: "Synthetic city, China", countryCode: "CN", city: "Synthetic city", kind: "office", precision: "city", verification: "unverified", evidence },
      { id: "synthetic-far-office", raw: "Synthetic far address", countryCode: "CN", kind: "office", precision: "address", coordinates: point(10), verification: "verified", evidence },
    ], compensations: [],
    listings: [{ id: "synthetic-listing", sourceId: "synthetic-source", sourceRecordId: "synthetic-office", canonicalUrl: URL, canonicalJobId: "synthetic-job", observationIds: ["synthetic-observation"], firstDiscoveredAt: AT }],
    observations: [{ id: "synthetic-observation", listingId: "synthetic-listing", fetchedAt: AT, availability: "unknown", result: "read", completeness: "excerpt", warnings: [] }], snapshots: [],
  });
  const source = base.locations[0]!;
  base.locations[0] = applyOfficeAddressConfirmation(source, { id: "synthetic-office-decision", kind: "confirm", jobId: "synthetic-job", listingId: "synthetic-listing", locationId: source.id,
    actorScope: "synthetic-owner", at: AT, revision: 2, reason: "Synthetic explicit address and WGS84 confirmation", sourceLocation: source,
    proposal: { basis: "manual-user-confirmation", countryCode: "CN", streetAddress: "Synthetic Road 10", formattedAddress: "Synthetic Road 10, Synthetic city",
      coordinates: point(0.01), coordinateMeaning: "building", evidenceUrl: URL } });
  return AtlasDatasetSchema.parse(base);
}

test("actual saved office distance remains estimated in strict nested query output and JSON transport", async () => {
  const data = dataset(), before = structuredClone(data), result = await queryJobs(data, query, options);
  assert.equal(result.totalJobs, 1); assert.equal(result.items[0]!.distance?.locationId, "synthetic-office");
  assert.equal(result.items[0]!.distance?.precision, "address"); assert.equal(result.items[0]!.distance?.estimated, true);
  assert.ok(result.items[0]!.distance!.km > 1 && result.items[0]!.distance!.km < 2);
  assert.equal(result.items[0]!.locations.find(location => location.id === "synthetic-office")!.verification, "unverified");
  const output = JobQueryResultSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(output.items[0]!.distance?.estimated, true); assert.deepEqual(data, before);
  assert.equal(JSON.stringify(output).includes('"latitude":0,"longitude":0'), false, "home coordinates stay private");
});

test("verified source address stays exact while coarse city or street distance can never claim exactness", async () => {
  const data = dataset(); data.jobs[0]!.locationIds = ["synthetic-far-office"];
  data.locations[1]!.coordinates = point(0.01);
  const result = await queryJobs(data, query, options);
  assert.equal(result.items[0]!.distance?.estimated, false); assert.equal(JobQueryResultSchema.safeParse(result).success, true);
  const fine = result.items[0]!.distance!;
  for (const precision of ["city", "street"] as const) {
    assert.equal(LocationDistanceSchema.safeParse({ ...fine, precision, estimated: false }).success, false);
    assert.equal(LocationDistanceSchema.safeParse({ ...fine, precision, estimated: true }).success, true);
  }
});

test("actual office distance tool output survives registry validation without leaking the home anchor", async () => {
  const registry = createToolRegistry([createJobsSearchTool(createJobQueryService({ readSnapshot: async () => dataset() }), () => options)]);
  const response = await registry.execute("jobs.search", query, { requestId: "synthetic-office-request", actorScope: "synthetic-owner", signal: new AbortController().signal,
    allowedEffects: ["read-index"], budget: { requests: 0, bytes: 1_000_000, timeoutMs: 5000 } });
  assert.equal(response.ok, true, JSON.stringify(response)); if (!response.ok) return;
  const result = JobQueryResultSchema.parse(response.value);
  assert.equal(result.items[0]!.distance?.estimated, true); assert.equal(Object.hasOwn(result, "anchor"), false);
  assert.equal(Object.hasOwn(result.normalizedQuery, "anchor"), false);
});

test("distance restrictions exclude unknown and remote eligibility points even when they have near coordinates", async () => {
  for (const kind of ["unknown", "remote-region"] as const) {
    const data = dataset(), location = data.locations[0]!;
    delete location.officeResolution; location.kind = kind; data.jobs[0]!.locationIds = [location.id];
    if (kind === "remote-region") {
      await assert.rejects(queryJobs(data, query, options), /A remote eligibility region is not an office point/);
      delete location.coordinates;
    }
    const result = await queryJobs(data, query, options);
    assert.equal(result.totalJobs, 0); assert.equal(JobQueryResultSchema.safeParse(result).success, true);
  }
});
