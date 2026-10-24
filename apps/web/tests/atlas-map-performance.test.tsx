import assert from "node:assert/strict";
import test from "node:test";
import type { MapBucket } from "@better-me/opportunities";
import { atlasBucketData, atlasBucketFactSignature, createAtlasHover, createAtlasMapUpdates } from "../src/components/atlas/prototypes/map-performance.ts";
import { selectAtlasBuckets } from "../src/components/atlas/prototypes/bucket-selection.ts";

const bucket = (id: string, jobCount = 1): MapBucket => ({ id, label: `Synthetic ${id}`, latitude: 31, longitude: 121, jobCount,
  jobIds: [`job-${id}`], categories: [{ id: "synthetic", label: "Synthetic", color: "#123456", jobCount }], precision: "city", estimated: true } as MapBucket);

test("120 camera or UI renders cause no unchanged source uploads or style writes; selection remains independent of point geometry", () => {
  const buckets = Array.from({ length: 2000 }, (_, i) => bucket(`point-${i}`, i + 1));
  const data = atlasBucketData(buckets), writes = { source: 0, bucket: [] as string[], region: [] as string[] };
  const update = createAtlasMapUpdates(buckets, data, { buckets: () => { writes.source++; }, bucketSelection: id => writes.bucket.push(id), regionSelection: id => writes.region.push(id) });
  for (let index = 0; index < 120; index++) update({ buckets });
  assert.deepEqual(writes, { source: 0, bucket: [], region: [] });
  update({ buckets, selectedBucketId: "point-100", selectedRegionId: "CN" });
  for (let index = 0; index < 120; index++) update({ buckets, selectedBucketId: "point-100", selectedRegionId: "CN" });
  assert.deepEqual(writes, { source: 0, bucket: ["point-100"], region: ["CN"] });
  update({ buckets });
  assert.deepEqual(writes, { source: 0, bucket: ["point-100", ""], region: ["CN", ""] });
  assert.equal(data.features.filter(feature => feature.properties.kind === "core").length, 2000);
  assert.equal(data.features.filter(feature => feature.properties.labelVisible).length, 6);
});

test("equal query projections do not re-index points, while changed salary colors, counts, addresses or locations reach the source", () => {
  const first = [bucket("city")], uploads: ReturnType<typeof atlasBucketData>[] = [];
  const update = createAtlasMapUpdates(first, atlasBucketData(first), { buckets: data => uploads.push(data), bucketSelection: () => {}, regionSelection: () => {} });
  for (let index = 0; index < 40; index++) update({ buckets: structuredClone(first) });
  assert.equal(uploads.length, 0);
  const changed = structuredClone(first); changed[0]!.longitude = 120.123456; changed[0]!.label = "Synthetic specific office"; changed[0]!.jobCount = 2; changed[0]!.categories[0]!.color = "#abcdef";
  update({ buckets: changed });
  assert.equal(uploads.length, 1); assert.deepEqual(uploads[0]!.features[0]!.geometry.coordinates, [120.123456, 31]);
  assert.equal(uploads[0]!.features[0]!.properties.color, "#abcdef"); assert.match(uploads[0]!.features[0]!.properties.label, /Synthetic specific office · 2/);
  update({ buckets: [] }); assert.equal(uploads.length, 2); assert.deepEqual(uploads[1]!.features, []);
});

test("bucket source signatures ignore query object recreation and ordering while retaining coordinate facts", () => {
  const first = [bucket("a", 2), bucket("b", 1)], reordered = [structuredClone(first[1]!), structuredClone(first[0]!)];
  assert.equal(atlasBucketFactSignature(first), atlasBucketFactSignature(reordered));
  const uploads: ReturnType<typeof atlasBucketData>[] = [];
  const update = createAtlasMapUpdates(first, atlasBucketData(first), { buckets: data => uploads.push(data), bucketSelection: () => {}, regionSelection: () => {} });
  update({ buckets: reordered });
  assert.equal(uploads.length, 0, "recreated/reordered query buckets do not upload identical map geometry");
  const moved = structuredClone(reordered); moved[0]!.longitude = 121.0001;
  update({ buckets: moved });
  assert.equal(uploads.length, 1, "a real coordinate change still reaches the map source");
});

test("GeoJSON keeps city-reference precision labels, excludes invalid coordinates, and supports all selected labels through a separate filter", () => {
  const reference = { ...bucket("reference"), positionBasis: "city-reference" } as MapBucket;
  const invalid = { ...bucket("invalid"), latitude: 91 };
  const data = atlasBucketData([reference, invalid]);
  assert.equal(data.features.filter(feature => feature.properties.kind === "core").length, 1);
  assert.match(data.features[0]!.properties.label, /城市估算/);
  assert.deepEqual(data.features[0]!.geometry.coordinates, [121, 31]);
});

test("100 high-frequency mouse moves trigger one hit test using the latest pointer and none during zoom/drag or disposal", () => {
  const callbacks = new Map<number, () => void>(), hits: number[] = []; let sequence = 0, moving = false;
  const hover = createAtlasHover<number>({ requestFrame: callback => { callbacks.set(++sequence, callback); return sequence; }, cancelFrame: id => { callbacks.delete(id); }, moving: () => moving, hit: value => hits.push(value) });
  const flush = () => { const current = [...callbacks.values()]; callbacks.clear(); current.forEach(callback => callback()); };
  for (let point = 0; point < 100; point++) hover.queue(point);
  assert.equal(callbacks.size, 1); flush(); assert.deepEqual(hits, [99]);
  moving = true;
  for (let point = 0; point < 100; point++) hover.queue(point);
  assert.equal(callbacks.size, 0); assert.deepEqual(hits, [99]);
  moving = false; hover.queue(101); moving = true; flush(); assert.deepEqual(hits, [99]);
  moving = false; hover.queue(102); hover.cancel(); flush(); assert.deepEqual(hits, [99]);
  hover.queue(103); flush(); assert.deepEqual(hits, [99, 103]);
});

test("overlapping list selection deduplicates jobs, retains all original members, and never combines their coordinates or category facts", () => {
  const a = { ...bucket("a"), jobIds: ["same", "one"], jobCount: 2 }, b = { ...bucket("b"), jobIds: ["two", "same"], jobCount: 2, positionBasis: "city-reference" as const };
  const saved = structuredClone([a, b]);
  const selected = selectAtlasBuckets([b, a, b])!;
  assert.deepEqual(selected.jobIds, ["one", "same", "two"]); assert.equal(selected.jobCount, 3); assert.deepEqual(selected.memberBucketIds, [a.id, b.id]);
  assert.equal(selected.positionBasis, "city-reference", "any reference member makes the selection expire with reference refresh");
  assert.equal("longitude" in selected, false); assert.equal("categories" in selected, false); assert.deepEqual([a, b], saved);
  assert.equal(selectAtlasBuckets([a, a]), a); assert.equal(selectAtlasBuckets([]), null);
});
