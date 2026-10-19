import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintMapReferenceLocation, MapReferencesInputSchema, MapReferencesResultSchema, type JobLocation, type MapReferencesResult } from "../src/index.js";

const location: JobLocation = { id: "location.one", raw: "Original city", kind: "unknown", countryCode: "US", city: "Example City", precision: "city", verification: "unverified", evidence: [] };
async function result(): Promise<MapReferencesResult> {
  return MapReferencesResultSchema.parse({ schemaVersion: 1, snapshotRevision: 2, providerId: "synthetic", totalLocations: 1, processedLocations: 1, truncated: false, warnings: [], unresolved: [],
    provenance: { datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.test/data.zip", sourceArchiveSha256: "a".repeat(64), retrievedAt: "2026-10-18T12:00:00.000Z", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic", coordinateSystem: "WGS84", coverage: "Finite synthetic points." },
    references: [{ locationId: location.id, locationFingerprint: await fingerprintMapReferenceLocation(location), countryCode: "US", city: "Example City", placeId: "place.one", matchedName: "Example City", match: "exact-name" }],
    places: [{ precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified", shardSha256: "b".repeat(64),
      place: { id: "place.one", name: "Example City", aliases: [], sourceRecordUrl: "https://places.example.test/1", countryCode: "US", alternateCountryCodes: [], administrativeCodes: {}, coordinates: { latitude: 20, longitude: 30, coordinateSystem: "WGS84" }, featureCode: "PPL", population: 1000, sourceModifiedDate: "2026-10-17" } }],
  });
}

test("location fingerprints are stable across object key order and change with source or local decisions", async () => {
  const original = await fingerprintMapReferenceLocation(location);
  const reordered = Object.fromEntries(Object.entries(location).reverse()) as JobLocation;
  assert.equal(await fingerprintMapReferenceLocation(reordered), original);
  for (const change of [{ city: "Another City" }, { raw: "Changed source" }, { kind: "remote-region" as const }, { evidence: [{ observationId: "obs.one", sourceUrl: "https://jobs.example.test/1", observedAt: "2026-10-18T12:00:00.000Z" }] }]) {
    assert.notEqual(await fingerprintMapReferenceLocation({ ...location, ...change }), original);
  }
});

test("map reference contracts reject unrelated names, duplicate IDs, missing evidence and invented office precision", async () => {
  const valid = await result();
  assert.deepEqual(MapReferencesResultSchema.parse(JSON.parse(JSON.stringify(valid))), valid);
  for (const mutate of [
    (v: any) => { v.references[0].countryCode = "CN"; }, (v: any) => { v.references[0].city = "Example"; },
    (v: any) => { v.references[0].matchedName = "Invented"; }, (v: any) => { v.references[0].placeId = "place.missing"; },
    (v: any) => { v.references.push(v.references[0]); v.processedLocations = 2; v.totalLocations = 2; },
    (v: any) => { v.places.push(v.places[0]); }, (v: any) => { delete v.provenance; },
    (v: any) => { v.places[0].precision = "address"; }, (v: any) => { v.places[0].estimated = false; },
    (v: any) => { v.places[0].verification = "verified"; }, (v: any) => { v.truncated = true; },
    (v: any) => { v.references[0].match = "prefix"; }, (v: any) => { v.references[0].locationFingerprint = "not-a-hash"; },
  ]) { const value = structuredClone(valid); mutate(value); assert.equal(MapReferencesResultSchema.safeParse(value).success, false); }
});

test("reference requests are bounded and accept no provider, path, coordinates or private side input", () => {
  assert.equal(MapReferencesInputSchema.parse({ expectedRevision: 1 }).limit, 1000);
  for (const extra of [{ providerId: "foreign" }, { manifestPath: "private/file" }, { homeAddress: "PRIVATE" }, { coordinates: [20, 30] }, { locationIds: ["same", "same"] }, { locationIds: Array.from({ length: 1001 }, (_, i) => `location.${i}`) }, { limit: 1001 }]) {
    assert.equal(MapReferencesInputSchema.safeParse({ expectedRevision: 1, ...extra }).success, false);
  }
});
