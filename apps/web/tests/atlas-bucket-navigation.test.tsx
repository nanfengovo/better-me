import assert from "node:assert/strict";
import test from "node:test";
import type { MapBucket } from "@better-me/opportunities";
import { bucketNavigationCamera } from "../src/components/atlas/prototypes/bucket-navigation.ts";

const bucket: MapBucket = { id: "opaque-bucket", label: "Synthetic city", longitude: 121, latitude: 31, jobCount: 2, pinCount: 2,
  jobIds: ["job-one", "job-two"], locationIds: ["location-one", "location-two"], categories: [] };
const options = { currentZoom: 1.5, maxZoom: 22, reducedMotion: false };

test("explicit query levels navigate to bounded overview scales without parsing opaque IDs or inventing an office", () => {
  const before = structuredClone(bucket);
  for (const [level, zoom] of [["country", 4.5], ["region", 7.5], ["city", 10.5], ["location", 10.5]] as const) {
    const navigation = bucketNavigationCamera(bucket, { ...options, level })!;
    assert.deepEqual(navigation.center, [121, 31]); assert.equal(navigation.zoom, zoom); assert.equal(navigation.duration, 900);
    assert.equal("precision" in navigation, false); assert.equal("jobId" in navigation, false);
  }
  assert.deepEqual(bucket, before);
});

test("city references remain at city scale, provider limits win, and reduced motion has zero duration", () => {
  const reference = { ...bucket, positionBasis: "city-reference" as const, precision: "city" as const, estimated: true as const };
  assert.equal(bucketNavigationCamera(reference, { ...options, level: "location" })!.zoom, 9);
  assert.equal(bucketNavigationCamera(reference, { ...options, level: "country" })!.zoom, 4.5);
  assert.equal(bucketNavigationCamera(reference, { ...options, level: "region" })!.zoom, 7.5);
  assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", maxZoom: 7, reducedMotion: true })!.zoom, 7);
  assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", reducedMotion: true })!.duration, 0);
});

test("location buckets honour source precision without promoting city estimates", () => {
  assert.equal(bucketNavigationCamera({ ...bucket, precision: "address" }, { ...options, level: "location" })!.zoom, 16.5);
  assert.equal(bucketNavigationCamera({ ...bucket, precision: "street" }, { ...options, level: "location" })!.zoom, 14);
  assert.equal(bucketNavigationCamera({ ...bucket, precision: "city" }, { ...options, level: "location" })!.zoom, 10.5);
  assert.equal(bucketNavigationCamera({ ...bucket, precision: "address", positionBasis: "city-reference", estimated: true }, { ...options, level: "location" })!.zoom, 9);
});

test("a centered bucket can zoom in, but completed or higher zooms never loop or zoom back out", () => {
  assert.ok(bucketNavigationCamera(bucket, { ...options, level: "city", currentZoom: 2 }));
  for (const currentZoom of [10.46, 10.5, 16, 22]) assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", currentZoom }), null);
  assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", currentZoom: 7, maxZoom: 7 }), null);
});

test("invalid representative coordinates or camera values cannot create a flight", () => {
  for (const invalid of [{ ...bucket, latitude: 91 }, { ...bucket, longitude: Number.NaN }, { ...bucket, jobCount: 0 }]) {
    assert.equal(bucketNavigationCamera(invalid, { ...options, level: "city" }), null);
  }
  assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", currentZoom: Infinity }), null);
  assert.equal(bucketNavigationCamera(bucket, { ...options, level: "city", maxZoom: Number.NaN }), null);
});
