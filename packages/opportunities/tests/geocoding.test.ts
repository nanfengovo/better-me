import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptGeocodingCandidate, GazetteerManifestSchema, GeocodingRequestSchema, GeocodingResultSchema,
  type GeocodingResult,
} from "../src/geocoding.js";

function result(): GeocodingResult {
  return GeocodingResultSchema.parse({
    schemaVersion: 1, providerId: "synthetic-gazetteer", request: { raw: "真实原地名", kind: "office", countryCodes: ["CN"] },
    status: "candidates", reason: "single-exact-city", totalCandidates: 1, truncated: false, requiresConfirmation: true,
    searchedCountryCodes: ["CN"], datasetVersion: "synthetic-v1", warnings: ["Synthetic approximate city point."],
    candidates: [{ id: "candidate.1", providerId: "synthetic-gazetteer", matchedName: "真实原地名", match: "exact-alias", countryBiasMatched: false,
      precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified",
      place: { id: "place.1", name: "Original source name", aliases: ["真实原地名"], sourceRecordUrl: "https://places.example.test/1", countryCode: "CN", alternateCountryCodes: [],
        administrativeCodes: { admin1: "original-code" }, coordinates: { latitude: 30, longitude: 120, coordinateSystem: "WGS84" }, featureCode: "PPL", population: 20_000, sourceModifiedDate: "2026-10-17" },
      evidence: { shardSha256: "b".repeat(64), sourceRecordUrl: "https://places.example.test/1",
        provenance: { datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.test/data.zip", sourceArchiveSha256: "a".repeat(64), retrievedAt: "2026-10-18T12:00:00.000Z", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic", coordinateSystem: "WGS84", coverage: "Finite synthetic city points." } },
    }],
  });
}

test("explicit city candidate selection preserves original facts and never certifies an employer address", () => {
  const input = result();
  const selection = acceptGeocodingCandidate(input, "candidate.1");
  assert.equal(selection.raw, input.request.raw); assert.equal(selection.selection, "explicit-candidate-selection");
  assert.equal(selection.candidate.precision, "city"); assert.equal(selection.candidate.estimated, true); assert.equal(selection.verification, "unverified");
  selection.candidate.place.aliases.push("Caller edit");
  assert.deepEqual(input.candidates[0]!.place.aliases, ["真实原地名"]);
  assert.throws(() => acceptGeocodingCandidate(input, "candidate.foreign"));
});

test("wire results reject fake precision, non-WGS84, omitted ambiguity, unrelated scopes and automatic confirmation", () => {
  for (const change of [
    (value: any) => { value.candidates[0].estimated = false; },
    (value: any) => { value.candidates[0].precision = "address"; },
    (value: any) => { value.candidates[0].place.coordinates.coordinateSystem = "GCJ02"; },
    (value: any) => { value.candidates[0].place.coordinates.coordinateSystem = "BD09"; },
    (value: any) => { value.totalCandidates = 2; },
    (value: any) => { value.request.countryCodes = ["US"]; },
    (value: any) => { value.request.bounds = [-10, -10, 10, 10]; },
    (value: any) => { value.request.administrativeCodes = { admin1: "invented-code" }; },
    (value: any) => { value.candidates[0].matchedName = "invented-alias"; },
    (value: any) => { value.request.kind = "remote-region"; },
    (value: any) => { value.requiresConfirmation = false; },
    (value: any) => { value.reason = "not-an-office"; },
  ]) {
    const value = structuredClone(result()); change(value);
    assert.equal(GeocodingResultSchema.safeParse(value).success, false);
  }
  const ambiguous = result(); ambiguous.totalCandidates = 3; ambiguous.truncated = true; ambiguous.reason = "ambiguous-place-name";
  assert.equal(GeocodingResultSchema.safeParse(ambiguous).success, true);
});

test("dataset and query contracts reject arbitrary file paths, foreign coordinate systems and hidden private inputs", () => {
  const base = result().candidates[0]!.evidence.provenance;
  const shard = { countryCode: "CN", alternateCountryCodes: [], file: "CN.json.gz", encoding: "gzip", sha256: "b".repeat(64), bytes: 100, decodedBytes: 1000, count: 1 };
  const manifest = { schemaVersion: 1, provenance: base, recordCount: 1, shards: [shard] };
  assert.equal(GazetteerManifestSchema.safeParse(manifest).success, true);
  for (const file of ["../private.json", "https://example.test/CN.json", "US.json.gz", "CＮ.json.gz"]) {
    assert.equal(GazetteerManifestSchema.safeParse({ ...manifest, shards: [{ ...shard, file }] }).success, false);
  }
  assert.equal(GazetteerManifestSchema.safeParse({ ...manifest, recordCount: 2 }).success, false);
  assert.equal(GeocodingRequestSchema.safeParse({ raw: "Shanghai", kind: "office", homeAddress: "private" }).success, false);
  assert.equal(GeocodingRequestSchema.safeParse({ raw: "!!!", kind: "office" }).success, false);
});
