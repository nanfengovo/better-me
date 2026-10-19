import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { GeocodingCandidateSchema, queryJobs, type JobSearchItem } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { createMapReferenceFixture } from "./fixtures/atlas-map-references.ts";
import { activeMapFocus, createJobMapFocus, createMapFocusMarker, mapFocusCameraOptions, mapFocusPrecisionLabel, validMapFocus } from "../src/components/atlas/map-focus.ts";

async function item(): Promise<JobSearchItem> {
  const data = createAtlasDemo();
  return (await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, { now: "2026-10-19T00:00:00Z" })).items[0]!;
}

function candidate() {
  return GeocodingCandidateSchema.parse({
    id: "candidate.synthetic", providerId: "synthetic-gazetteer", matchedName: "Shanghai", match: "exact-name", countryBiasMatched: true,
    precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified",
    place: { id: "place.synthetic", name: "Shanghai", aliases: [], sourceRecordUrl: "https://places.example.invalid/1", countryCode: "CN", alternateCountryCodes: [],
      administrativeCodes: { admin1: "synthetic" }, coordinates: { latitude: 31.23, longitude: 121.47, coordinateSystem: "WGS84" }, featureCode: "PPL", population: 20000, sourceModifiedDate: "2026-10-18" },
    evidence: { shardSha256: "b".repeat(64), sourceRecordUrl: "https://places.example.invalid/1", provenance: {
      datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.invalid/data.zip", sourceArchiveSha256: "a".repeat(64),
      retrievedAt: "2026-10-19T00:00:00Z", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic test fixture",
      coordinateSystem: "WGS84", coverage: "Finite synthetic city point.",
    } },
  });
}

test("job focus preserves source precision and never mutates the job or its location", async () => {
  const input = await item(); const before = structuredClone(input);
  const target = createJobMapFocus(input, "request-one")!;
  assert.equal(target.jobId, input.job.id);
  assert.equal(target.requestId, "request-one");
  assert.equal(target.locationId, input.locations[0]!.id);
  assert.equal(target.latitude, input.locations[0]!.coordinates!.latitude);
  assert.equal(target.precision, "city"); assert.equal(target.estimated, true);
  assert.match(mapFocusPrecisionLabel(target), /城市级估算.*非办公地址.*待核实/);
  assert.deepEqual(input, before);
});

test("each explicit location can be focused without using another office's coordinates", async () => {
  const input = await item();
  input.locations.push({ ...structuredClone(input.locations[0]!), id: "second-office", raw: "Synthetic verified street", precision: "address", verification: "verified", coordinates: { coordinateSystem: "WGS84", latitude: 40, longitude: 116 } });
  const target = createJobMapFocus(input, "second", { locationId: "second-office" })!;
  assert.equal(target.locationId, "second-office"); assert.equal(target.longitude, 116); assert.equal(target.precision, "address");
  assert.equal(target.estimated, false); assert.equal(mapFocusPrecisionLabel(target), "地址级坐标");
  assert.equal(createJobMapFocus(input, "missing", { locationId: "missing-office" }), null);
});

test("snapshot-derived city references focus directly without office coordinates or building zoom, while source coordinates win", async () => {
  const data = createAtlasDemo(); delete data.locations[0]!.coordinates; data.locations[0]!.precision = "unknown"; data.locations[0]!.kind = "unknown";
  const batch = await createMapReferenceFixture(data), before = structuredClone(data);
  const result = await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, { now: "2026-10-19T00:00:00Z", mapReferences: batch });
  const input = result.items[0]!, original = structuredClone(input), target = createJobMapFocus(input, "reference")!;
  assert.equal(target.positionBasis, "city-reference"); assert.equal(target.precision, "city"); assert.equal(target.estimated, true);
  assert.equal(target.verification, "unverified"); assert.equal(target.zoom, 9); assert.equal(target.latitude, 31);
  assert.match(mapFocusPrecisionLabel(target), /城市分布参考.*城市级估算.*非办公地址/);
  assert.equal(mapFocusCameraOptions({ ...target, zoom: 22 }, 22, false)!.zoom, 9);
  assert.equal(createJobMapFocus(input, "wrong-location", { locationId: "another-office" }), null);
  assert.deepEqual(input, original); assert.deepEqual(data, before);
  input.locations[0]!.coordinates = { latitude: 40, longitude: 116, coordinateSystem: "WGS84" }; input.locations[0]!.precision = "address";
  const direct = createJobMapFocus(input, "source-coordinate")!;
  assert.equal(direct.latitude, 40); assert.equal(direct.positionBasis, undefined); assert.equal(direct.precision, "address");
  delete input.locations[0]!.coordinates; input.job.workMode = "remote"; assert.equal(createJobMapFocus(input, "remote"), null);
  input.job.workMode = "unknown"; input.locations[0]!.kind = "remote-region"; assert.equal(createJobMapFocus(input, "remote-region"), null);
});

test("missing, invalid, remote eligibility and unspecified precision do not create an office marker", async () => {
  const input = await item();
  for (const change of [
    (value: JobSearchItem) => { delete value.locations[0]!.coordinates; },
    (value: JobSearchItem) => { value.locations[0]!.coordinates!.latitude = Number.NaN; },
    (value: JobSearchItem) => { value.locations[0]!.coordinates!.longitude = 181; },
    (value: JobSearchItem) => { value.locations[0]!.kind = "remote-region"; },
    (value: JobSearchItem) => { value.locations[0]!.precision = "unknown"; },
  ]) {
    const value = structuredClone(input); change(value);
    assert.equal(createJobMapFocus(value, "invalid"), null);
  }
});

test("an explicit city candidate is transient, estimated and bound to its office and country", async () => {
  const input = await item(); delete input.locations[0]!.coordinates;
  const before = structuredClone(input); const city = candidate();
  const target = createJobMapFocus(input, "candidate", { cityCandidate: { locationId: input.locations[0]!.id, candidate: city } })!;
  assert.equal(target.precision, "city"); assert.equal(target.verification, "unverified"); assert.equal(target.estimated, true);
  assert.match(target.locationLabel!, /Shanghai/); assert.equal(target.zoom, 10.5);
  assert.deepEqual(input, before);
  assert.equal(createJobMapFocus(input, "wrong-id", { cityCandidate: { locationId: "foreign-office", candidate: city } }), null);
  input.locations[0]!.countryCode = "US";
  assert.equal(createJobMapFocus(input, "wrong-country", { cityCandidate: { locationId: input.locations[0]!.id, candidate: city } }), null);
  input.locations[0]!.countryCode = "CN"; input.locations[0]!.kind = "remote-region";
  assert.equal(createJobMapFocus(input, "remote", { cityCandidate: { locationId: input.locations[0]!.id, candidate: city } }), null);
  input.locations[0]!.kind = "unknown";
  assert.equal(createJobMapFocus(input, "unknown-kind", { cityCandidate: { locationId: input.locations[0]!.id, candidate: city } }), null);
});

test("an explicitly chosen city candidate does not inherit another office's precise coordinate", async () => {
  const input = await item(); const original = input.locations[0]!;
  original.coordinates = { coordinateSystem: "WGS84", latitude: 40, longitude: 116 }; original.precision = "address";
  input.locations.push({ ...structuredClone(original), id: "candidate-office", coordinates: undefined, raw: "Synthetic Shanghai office", precision: "unknown" });
  const target = createJobMapFocus(input, "candidate-office", { cityCandidate: { locationId: "candidate-office", candidate: candidate() } })!;
  assert.equal(target.locationId, "candidate-office"); assert.equal(target.precision, "city"); assert.equal(target.latitude, 31.23);
});

test("the previous job highlight disappears for another selection or explicit deselection", () => {
  const target = { longitude: 120, latitude: 30, jobId: "job.one" };
  assert.equal(activeMapFocus(target, "job.one"), target);
  assert.equal(activeMapFocus(target, "job.two"), undefined);
  assert.equal(activeMapFocus(target, ""), undefined);
  assert.equal(activeMapFocus(undefined, "job.one"), undefined);
  assert.equal(activeMapFocus(target), target, "legacy callers can omit selection metadata");
  assert.equal(activeMapFocus({ longitude: 120, latitude: 30 }, "job.one")?.longitude, 120);
});

test("city and country camera requests cannot imply a building-level location", () => {
  assert.equal(mapFocusCameraOptions({ longitude: 120, latitude: 30, precision: "city", zoom: 22 }, 22, false)!.zoom, 10.5);
  assert.equal(mapFocusCameraOptions({ longitude: 120, latitude: 30, precision: "country", zoom: 22 }, 22, false)!.zoom, 4.5);
  assert.equal(mapFocusCameraOptions({ longitude: 120, latitude: 30, precision: "address" }, 14, false)!.zoom, 14);
  assert.equal(mapFocusCameraOptions({ longitude: 120, latitude: 30, zoom: Number.NaN }, 22, false)!.zoom, 16);
});

test("reduced motion reaches the same target immediately and never declares animation essential", () => {
  const target = { longitude: -122, latitude: 47, precision: "address" as const };
  const normal = mapFocusCameraOptions(target, 22, false)!;
  const reduced = mapFocusCameraOptions(target, 22, true)!;
  assert.equal(normal.duration, 1600); assert.equal(reduced.duration, 0);
  assert.equal(normal.essential, false); assert.equal(reduced.essential, false);
  assert.deepEqual(normal.center, reduced.center); assert.equal(normal.zoom, reduced.zoom);
  assert.equal(mapFocusCameraOptions({ ...target, latitude: Infinity }, 22, false), null);
  assert.equal(validMapFocus({ longitude: -181, latitude: 0 }), false);
});

test("marker content is safe text with precision and configurable validated company color", () => {
  const dom = new Window();
  const marker = createMapFocusMarker(dom.document as unknown as Document, {
    longitude: 120, latitude: 30, jobId: "job.one", label: '<img src=x onerror="bad()">', locationLabel: "<script>bad()</script>",
    precision: "city", estimated: true, color: "#008844",
  }, true);
  assert.equal(marker.querySelector("img,script"), null);
  assert.match(marker.textContent!, /<img src=x/); assert.match(marker.textContent!, /非办公地址/);
  assert.equal(marker.style.getPropertyValue("--atlas-focus-color"), "#008844");
  assert.equal(marker.classList.contains("estimated"), true); assert.equal(marker.classList.contains("light"), true);
  assert.equal(marker.getAttribute("aria-hidden"), "true");
  const invalid = createMapFocusMarker(dom.document as unknown as Document, { longitude: 120, latitude: 30, color: "red;position:fixed" }, false);
  assert.equal(invalid.style.getPropertyValue("--atlas-focus-color"), "#b6f1da");
  assert.match(invalid.textContent!, /位置精度未说明.*待核实/);
  dom.happyDOM.abort();
});
