import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, type AtlasDataset, type JobLocation } from "../src/schema.js";
import { MapReferencesResultSchema, fingerprintMapReferenceLocation, type MapReferencesResult } from "../src/map-references.js";
import { queryJobs, JobQueryError } from "../src/query.js";
import { createJobQueryIndex } from "../src/query-index.js";
import { JobQueryResultSchema } from "../src/query-output.js";

const now = "2026-10-19T12:00:00.000Z";
const coordinates = (longitude: number) => ({ latitude: 0, longitude, coordinateSystem: "WGS84" as const });

test("indexed city maps share reference facts, invalidate changed batches and recover after rejected stale references", async () => {
  const dataset = data(), mapReferences = await references(dataset), index = createJobQueryIndex(dataset);
  for (const query of [{}, { page: { limit: 1 } }, { viewport: { enabled: true, bounds: [0.5, -1, 1.5, 1] as [number, number, number, number] } }]) {
    const result = await index.search(query, { now, mapReferences });
    assert.deepEqual(result, await queryJobs(dataset, query, { now, mapReferences }));
    assert.deepEqual(await index.search(query, { now, mapReferences }), result);
  }
  const changed = structuredClone(mapReferences); changed.places[0]!.place.coordinates = coordinates(2);
  assert.deepEqual(await index.search({}, { now, mapReferences: changed }), await queryJobs(dataset, {}, { now, mapReferences: changed }));
  const staleReferences = { ...mapReferences, snapshotRevision: dataset.revision + 1 };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(index.search({}, { now, mapReferences: staleReferences }), error => error instanceof JobQueryError && error.code === "invalid-query");
  assert.deepEqual(await index.search({}, { now, mapReferences }), await queryJobs(dataset, {}, { now, mapReferences }));
});
function data(): AtlasDataset {
  const locations: JobLocation[] = ["a", "b", "c", "d", "e"].map(id => ({
    id: `loc.${id}`, raw: `Synthetic source ${id}`, kind: id === "c" ? "office" : "unknown", countryCode: "CN",
    city: id === "e" ? undefined : "Synthetic City", precision: "city", verification: "unverified", evidence: [],
    ...(id === "c" ? { coordinates: coordinates(10) } : {}),
  }));
  return AtlasDatasetSchema.parse({ schemaVersion: 1, revision: 9, sources: [], locations,
    companies: [{ id: "company.one", names: ["Synthetic Company"], domains: [], parentCompanyIds: [], manualOverrides: [],
      ultimateControllers: { value: [], evidence: [], method: "manual", verification: "unverified", revision: 0 } }],
    jobs: locations.map((location, index) => ({ id: `job.${"abcde"[index]}`, companyId: "company.one",
      title: { value: `Synthetic C# Engineer ${index}`, evidence: [], method: "manual", verification: "unverified", revision: 0 },
      description: "Synthetic C# description", locationIds: [location.id], compensationIds: [], listingIds: [],
      workMode: index === 3 ? "remote" : "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: now })),
    compensations: [], listings: [], observations: [], snapshots: [],
  });
}
async function references(dataset: AtlasDataset): Promise<MapReferencesResult> {
  return MapReferencesResultSchema.parse({ schemaVersion: 1, snapshotRevision: dataset.revision, providerId: "synthetic-cities",
    provenance: { datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.test/data.zip", sourceArchiveSha256: "a".repeat(64),
      retrievedAt: now, license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic place data", coordinateSystem: "WGS84", coverage: "Synthetic test places only." },
    places: [{ place: { id: "place.one", name: "Synthetic City", aliases: [], sourceRecordUrl: "https://places.example.test/1", countryCode: "CN", alternateCountryCodes: [],
      administrativeCodes: {}, coordinates: coordinates(1), featureCode: "PPL", population: 1000, sourceModifiedDate: "2026-10-18" }, shardSha256: "b".repeat(64),
      precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified" }],
    references: await Promise.all(dataset.locations.filter(location => ["loc.a", "loc.b", "loc.d"].includes(location.id)).map(async location => ({ locationId: location.id,
      locationFingerprint: await fingerprintMapReferenceLocation(location), countryCode: "CN", city: "Synthetic City", placeId: "place.one", matchedName: "Synthetic City", match: "exact-name" }))),
    unresolved: [{ locationId: "loc.c", reason: "existing-coordinate" }, { locationId: "loc.e", reason: "missing-city" }],
    totalLocations: 5, processedLocations: 5, truncated: false, warnings: [],
  });
}

test("city distribution adds separate map buckets and full-result counts while preserving source locations and distance", async () => {
  const dataset = data(), original = structuredClone(dataset), mapReferences = await references(dataset);
  const baseline = await queryJobs(dataset, { search: { text: "C#" } }, { now });
  const result = await queryJobs(dataset, { search: { text: "C#" }, page: { limit: 1 } }, { now, mapReferences });
  assert.equal(baseline.totalJobs, 5); assert.equal(result.totalJobs, 5); assert.equal(result.items.length, 1);
  assert.equal(result.mappedJobs, 1); assert.equal(result.unlocatedJobs, 4); assert.equal(result.locationPinCount, 1);
  assert.deepEqual(result.mapReferenceCoverage, { cityReferenceJobs: 2, cityReferencePinCount: 2, mapVisibleJobs: 3, mapPendingJobs: 2, processedLocations: 5, totalLocations: 5, truncated: false });
  assert.equal(result.mapBuckets.length, 2);
  const city = result.mapBuckets.find(bucket => bucket.positionBasis === "city-reference")!;
  assert.deepEqual(city.jobIds, ["job.a", "job.b"]); assert.equal(city.jobCount, 2); assert.equal(city.pinCount, 2);
  assert.equal(city.precision, "city"); assert.equal(city.estimated, true); assert.equal(city.longitude, 1);
  assert.equal(result.mapBuckets.find(bucket => !bucket.positionBasis)!.longitude, 10);
  assert.deepEqual(JobQueryResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
  assert.deepEqual(dataset, original); assert.equal(result.items[0]!.locations[0]!.coordinates, undefined);
  assert.equal(result.items[0]!.mapReferences![0]!.sourceRecordUrl, "https://places.example.test/1");
  const all = await queryJobs(dataset, {}, { now, mapReferences });
  assert.equal(all.items.find(item => item.job.id === "job.d")!.mapReferences, undefined, "A remote job cannot acquire a city-office interpretation.");
  assert.equal(all.items.find(item => item.job.id === "job.c")!.mapReferences, undefined, "Source coordinates take precedence.");
});

test("viewport and same-location region filters use display references without changing country facts", async () => {
  const dataset = data(), mapReferences = await references(dataset);
  const viewport = { enabled: true, bounds: [0.5, -1, 1.5, 1] as [number, number, number, number] };
  const result = await queryJobs(dataset, { viewport, workCountryCodes: ["CN"], workRegionGroups: [["Synthetic City"]] }, { now, mapReferences });
  assert.deepEqual(result.items.map(item => item.job.id), ["job.a", "job.b"]);
  assert.equal(result.totalJobs, 2); assert.equal(result.mapReferenceCoverage!.mapVisibleJobs, 2);
  const mismatch = await queryJobs(dataset, { workCountryCodes: ["US"], workRegionGroups: [["Synthetic City"]] }, { now, mapReferences });
  assert.equal(mismatch.totalJobs, 0); assert.equal(mismatch.mapBuckets.length, 0);
  const onlyOne = await queryJobs(dataset, { jobIds: ["job.b"] }, { now, mapReferences });
  assert.equal(onlyOne.mapBuckets[0]!.jobCount, 1); assert.deepEqual(onlyOne.mapBuckets[0]!.jobIds, ["job.b"]);
});

test("city references never enable distance filtering or sorting even when city estimates are allowed", async () => {
  const dataset = data(), mapReferences = await references(dataset);
  const anchor = { ...coordinates(0), ref: "private-reference" };
  const filtered = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, maxKm: 150, allowCityEstimate: true, includeUnknown: false } }, { now, mapReferences, anchor });
  assert.equal(filtered.totalJobs, 0, "The city reference 111 km away is not an office distance.");
  for (const direction of ["asc", "desc"] as const) {
    const result = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, allowCityEstimate: true, includeUnknown: true }, sort: { field: "distance", direction } }, { now, mapReferences, anchor });
    assert.equal(result.items[0]!.job.id, "job.c"); assert.equal(result.unknownDistanceCount, 4);
    assert.equal(result.items.find(item => item.job.id === "job.a")!.distance, undefined);
    assert.equal(result.normalizedQuery.distance?.anchorRef, anchor.ref);
    assert.equal(Object.hasOwn(result, "anchor"), false);
    assert.equal(Object.hasOwn(result.normalizedQuery.distance ?? {}, "anchor"), false);
    assert.equal(Object.hasOwn(result.normalizedQuery.distance ?? {}, "latitude"), false);
    assert.equal(Object.hasOwn(result.normalizedQuery.distance ?? {}, "longitude"), false);
    assert.equal(JSON.stringify(result).includes(JSON.stringify(anchor)), false);
  }
});

test("reference identity binds index version, full source fingerprint and query pagination", async () => {
  const dataset = data(), mapReferences = await references(dataset);
  const first = await queryJobs(dataset, { page: { limit: 1 } }, { now, mapReferences });
  const next = await queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { now, mapReferences });
  assert.equal(next.queryId, first.queryId); assert.notEqual(next.items[0]!.job.id, first.items[0]!.job.id);
  const changed = structuredClone(mapReferences); changed.providerId = "another-synthetic-provider";
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { now, mapReferences: changed }), error => error instanceof JobQueryError && error.code === "stale-cursor");
  for (const mutate of [(value: AtlasDataset) => { value.revision++; }, (value: AtlasDataset) => { value.locations[0]!.raw = "Changed source"; },
    (value: AtlasDataset) => { value.locations[0]!.city = "Changed City"; }, (value: AtlasDataset) => { value.locations[0]!.kind = "remote-region"; }]) {
    const value = structuredClone(dataset); mutate(value);
    await assert.rejects(queryJobs(value, {}, { now, mapReferences }), error => error instanceof JobQueryError && error.code === "invalid-query");
  }
  await assert.rejects(queryJobs(dataset, { mapCityReferences: true }, { now }), /城市分布参考尚未读取/);
});

test("map output rejects unlabeled estimates and totals that hide unresolved locations", async () => {
  const dataset = data(), result = await queryJobs(dataset, {}, { now, mapReferences: await references(dataset) });
  for (const mutate of [(value: typeof result) => { delete value.mapReferenceCoverage; },
    (value: typeof result) => { value.mapReferenceCoverage!.mapPendingJobs = 0; },
    (value: typeof result) => { value.mapReferenceCoverage!.mapVisibleJobs++; value.mapReferenceCoverage!.mapPendingJobs--; },
    (value: typeof result) => { value.mapReferenceCoverage!.cityReferenceJobs++; },
    (value: typeof result) => { value.mapReferenceCoverage!.cityReferencePinCount = 0; },
    (value: typeof result) => { value.mapBuckets.find(bucket => bucket.positionBasis)!.jobCount++; },
    (value: typeof result) => { delete value.mapBuckets.find(bucket => bucket.positionBasis)!.estimated; }]) {
    const value = structuredClone(result); mutate(value); assert.equal(JobQueryResultSchema.safeParse(value).success, false);
  }
});
