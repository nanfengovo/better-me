import assert from "node:assert/strict";
import test from "node:test";
import type { MapBucket } from "@better-me/opportunities";
import { atlasBucketData, atlasCoordinateStacks, prepareAtlasMapGeometry, createAtlasHover, createAtlasMapUpdates, isMappableOfficeBucket, mapBucketPrecisionLabel, mappableOfficeBuckets, positionMapPickMenu, rankAtlasBucketHits } from "../src/components/atlas/prototypes/map-performance.ts";

const bucket = (id: string, jobCount = 1): MapBucket => ({ id, label: `Synthetic ${id}`, latitude: 31, longitude: 121, jobCount,
  jobIds: [`job-${id}`], locationIds: [`location-${id}`], pinCount: jobCount, categories: [{ id: "synthetic", label: "Synthetic", color: "#123456", jobCount }], displayGrade: "address" } as MapBucket);

test("prepared geometry bypasses UI projection and unchanged geometry hashes do not re-index the map", async () => {
  const first = [bucket("one"), bucket("two")], geometry = await prepareAtlasMapGeometry(first);
  const uploads: ReturnType<typeof atlasBucketData>[] = [];
  const update = createAtlasMapUpdates(first, geometry.data, { buckets: data => uploads.push(data), bucketSelection: () => {}, regionSelection: () => {} }, geometry.signature);
  const equal = structuredClone(first);
  // Re-projecting on the renderer thread would read this coordinate and fail.
  Object.defineProperty(equal[0]!, "longitude", { get() { throw new Error("UI re-projected worker geometry"); } });
  update({ buckets: equal, geometry });
  assert.equal(uploads.length, 0);
  const changed = structuredClone(first); changed[0]!.longitude = 120;
  const next = await prepareAtlasMapGeometry(changed);
  assert.notEqual(next.signature, geometry.signature);
  update({ buckets: changed, geometry: next });
  assert.deepEqual(uploads, [next.data]);
  assert.equal(uploads[0], next.data);
});

test("15000 overlapping source addresses preserve every selection and distinct-job count", () => {
  const input = Array.from({ length: 15000 }, (_, index) => bucket(`overlap-${index}`));
  const [stack] = atlasCoordinateStacks(input);
  assert.equal(stack?.locationCount, 15000);
  assert.equal(stack?.jobCount, 15000);
  assert.equal(new Set(stack?.bucketIds).size, 15000);
  assert.deepEqual(input.map(value => [value.longitude, value.latitude]).every(value => value[0] === 121 && value[1] === 31), true);
});

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

test("GeoJSON excludes city references and invalid coordinates from office pins", () => {
  const reference = { ...bucket("reference"), positionBasis: "city-reference", displayGrade: "city", precision: "city", estimated: true } as MapBucket;
  const invalid = { ...bucket("invalid"), latitude: 91 };
  const data = atlasBucketData([reference, invalid]);
  assert.equal(data.features.length, 0, "city estimates are not drawn or hit-tested as office pins");
});

test("exactly co-located office addresses get one countable marker without changing their source coordinates", () => {
  const first = { ...bucket("first"), jobIds: ["job-a", "job-b"], jobCount: 2, pinCount: 1 };
  const second = { ...bucket("second"), jobIds: ["job-c"], jobCount: 1, pinCount: 1 };
  const data = atlasBucketData([first, second]);
  const stack = data.features.filter(feature => feature.properties.kind === "stack");
  assert.equal(stack.length, 1);
  assert.deepEqual(stack[0]!.geometry.coordinates, [121, 31]);
  assert.equal(stack[0]!.properties.stackLocationCount, 2);
  assert.equal(stack[0]!.properties.stackJobCount, 3);
  assert.equal(data.features.filter(feature => feature.properties.kind === "core").length, 2, "the source buckets stay intact for individual selection");
});

test("address browser options use the same source-backed precision gate as map pins", () => {
  const building = { ...bucket("building"), label: "上海市浦东新区科苑路 399 号", displayGrade: "building" as const };
  const street = { ...bucket("street"), label: "上海市静安区南京西路", displayGrade: "street" as const, jobCount: 3 };
  const city = { ...bucket("city"), label: "上海市", displayGrade: "city" as const, positionBasis: "city-reference" as const, estimated: true as const };
  const ungraded = { ...bucket("ungraded"), label: "上海（待核实）", displayGrade: undefined };
  assert.deepEqual(mappableOfficeBuckets([city, ungraded, street, building]).map((item) => item.id), ["street", "building"], "the browser exposes every mappable office bucket and no city estimate or ungraded point");
});

test("overlapping marker hit tests are deduplicated, distance-ranked, and keep honest location precision labels", () => {
  const near = bucket("near", 2), overlapping = { ...bucket("overlapping", 5), label: "Shanghai office" }, outside = bucket("outside", 9);
  const hits = [
    { properties: { bucketId: "overlapping" }, layer: { id: "bucket-labels" } },
    { properties: { bucketId: "near" } },
    { properties: { bucketId: "overlapping" } }, // category ring for the same location
    { properties: { bucketId: "outside" } },
    { properties: { bucketId: "unknown" } },
  ];
  const ranked = rankAtlasBucketHits(hits, [near, overlapping, outside], { x: 0, y: 0 }, item => ({
    x: item.id === "near" ? 3 : item.id === "overlapping" ? 80 : 30,
    y: 0,
  }));
  assert.deepEqual(ranked.map(item => item.id), ["overlapping", "near"], "a confirmed text hit remains selectable outside the marker radius and is offered first");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: "building", coordinateMeaning: "building" }), "本人核对 · 楼宇坐标");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: "building", coordinateMeaning: "entrance" }), "本人核对 · 入口坐标");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: "building", coordinateMeaning: "site" }), "本人核对 · 园区位置");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: "address" }), "地址级来源坐标");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: "city" }), "城市级估算 · 非办公地址");
  assert.equal(mapBucketPrecisionLabel({ ...near, displayGrade: undefined }), "来源坐标 · 精度未标明");
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: "building" }), true);
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: "street" }), true);
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: "address" }), true);
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: "city" }), false);
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: "address", positionBasis: "city-reference" }), false);
  assert.equal(isMappableOfficeBucket({ ...near, displayGrade: undefined }), false, "ungraded coordinates are not presented as office addresses");
});

test("projected hit targets remain selectable without rendered features and never include city or ungraded points", () => {
  const office = { ...bucket("office"), label: "上海市浦东新区科苑路 399 号" };
  const nearby = { ...bucket("nearby"), longitude: 150 };
  const city = { ...bucket("city"), displayGrade: "city" };
  const ungraded = { ...bucket("ungraded"), displayGrade: undefined };
  const candidates = rankAtlasBucketHits([], [office, nearby, city, ungraded], { x: 121, y: 31 }, item => ({ x: item.longitude, y: item.latitude }));
  assert.deepEqual(candidates.map(item => item.id), ["office"], "the 44px projected target does not depend on MapLibre returning a feature");
  const labelCandidate = rankAtlasBucketHits([{ properties: { bucketId: "nearby" }, layer: { id: "bucket-detail-labels" } }], [office, nearby, city], { x: 0, y: 0 }, item => ({ x: item.longitude, y: item.latitude }));
  assert.deepEqual(labelCandidate.map(item => item.id), ["nearby"], "a visible detailed address label remains selectable outside its marker target");
});

test("overlap picker stays inside desktop, mobile, and compact map viewports", () => {
  assert.deepEqual(positionMapPickMenu({ x: 380, y: 120 }, { width: 420, height: 500 }), { left: 48, top: 104 });
  assert.deepEqual(positionMapPickMenu({ x: 40, y: 480 }, { width: 420, height: 500 }), { left: 52, top: 128 });
  assert.deepEqual(positionMapPickMenu({ x: 230, y: 190 }, { width: 260, height: 220 }), { left: 12, top: 12 });
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
