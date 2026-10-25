import assert from "node:assert/strict";
import test from "node:test";
import type { MapBucket } from "@better-me/opportunities";
import { frameAdminRegion, frameSearchMap } from "../src/components/atlas/map-frame.ts";
import { atlasBucketData } from "../src/components/atlas/prototypes/map-performance.ts";

const bucket = (id: string, latitude: number, longitude: number, grade: MapBucket["displayGrade"], positionBasis?: MapBucket["positionBasis"]): MapBucket => ({
  id, label: id, latitude, longitude, jobIds: [`job-${id}`], locationIds: [`location-${id}`], jobCount: 1, pinCount: 1,
  categories: [{ ruleId: "synthetic", label: "Synthetic", color: "#123456", jobCount: 1 }],
  ...(grade ? { displayGrade: grade } : {}),
  ...(positionBasis === "city-reference" ? { positionBasis, precision: "city" as const, estimated: true as const, displayGrade: "city" as const } : {}),
});

test("search framing follows plotted points and refuses to treat a city estimate as a building", () => {
  assert.equal(frameSearchMap([]), null);
  const city = frameSearchMap([bucket("shanghai", 31.23, 121.47, "city")])!;
  assert.equal(city.maxZoom, 9);
  assert.ok(city.bounds[2] - city.bounds[0] > 0.5);
  assert.ok(city.bounds[0] < 121.47 && city.bounds[2] > 121.47);
  const reference = frameSearchMap([bucket("reference", 31.23, 121.47, "city", "city-reference")])!;
  assert.equal(reference.maxZoom, 9);
  const offices = frameSearchMap([
    bucket("pudong", 31.23, 121.52, "building"),
    bucket("songjiang", 31.03, 121.22, "building"),
  ])!;
  assert.equal(offices.maxZoom, 16);
  assert.ok(offices.bounds[0] < 121.22 && offices.bounds[2] > 121.52);
  assert.ok(offices.bounds[1] < 31.03 && offices.bounds[3] > 31.23);
  const worldwide = frameSearchMap([bucket("west", 47, -122, "city"), bucket("east", -33, 151, "city")]);
  assert.equal(worldwide, null);
});

test("empty domestic results frame the selected province outline, not a continent", () => {
  assert.equal(frameAdminRegion(undefined), null);
  assert.equal(frameAdminRegion("NOPE"), null);
  const shanghai = frameAdminRegion("CN-SH");
  assert.ok(shanghai);
  assert.deepEqual(shanghai.bounds, [120.865, 30.691, 121.987, 31.841]);
  assert.equal(shanghai.maxZoom, 8);
  assert.ok(shanghai.bounds[2] - shanghai.bounds[0] < 2);
});

test("map labels name office, street and city grades without drawing a city reference as an office building", () => {
  const data = atlasBucketData([
    bucket("office", 31.23, 121.5, "building"),
    bucket("street", 31.2, 121.4, "street"),
    bucket("reference", 31.23, 121.47, "city", "city-reference"),
  ]);
  const labels = data.features.filter(feature => feature.properties.kind === "core").map(feature => feature.properties);
  assert.match(labels.find(item => item.bucketId === "office")!.label, /办公楼/);
  assert.equal(labels.find(item => item.bucketId === "office")!.grade, "building");
  assert.match(labels.find(item => item.bucketId === "street")!.label, /街道/);
  assert.match(labels.find(item => item.bucketId === "reference")!.label, /城市估算/);
  assert.equal(labels.find(item => item.bucketId === "reference")!.grade, "city");
  assert.doesNotMatch(labels.find(item => item.bucketId === "reference")!.label, /办公楼/);
});
