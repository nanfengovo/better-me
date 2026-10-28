import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAdminBoundaryHighlight } from "../src/components/atlas/admin-boundary-service";
import { normalizeBoundaryGeometry, type GeoJsonFeatureCollection } from "../src/components/atlas/boundary-geometry-normalization";
import type { ChinaRegionSelection } from "../src/components/atlas/china-regions";

function asset(name: string): GeoJsonFeatureCollection {
  return JSON.parse(readFileSync(new URL(`../src/components/atlas/geo/${name}`, import.meta.url), "utf8"));
}

test("Shanghai DataV boundary is normalized before it is overlaid on WGS84 map data", async () => {
  const result = await resolveAdminBoundaryHighlight({ provinceCode: "31" }, "light");
  assert.ok(result);
  assert.equal(result.geoJson.type, "FeatureCollection");
  if (result.geoJson.type !== "FeatureCollection") return;
  const first = result.geoJson.features[0]!.geometry.coordinates[0][0][0] as [number, number];
  // The bundled first vertex is DataV GCJ-02 [121.153743, 31.276646].
  // Primary DataV docs identify the coordinate system and link coordtransform.
  // This pinned numerical conversion reference is not a surveyed control point.
  // Its loose tolerance rejects the hundreds-of-metres datum mismatch without
  // claiming geographic accuracy for the public approximation or source shape.
  const expected: [number, number] = [121.14917894727922, 31.278521729243856];
  assert.ok(Math.abs(first[0] - expected[0]) < 0.00005 && Math.abs(first[1] - expected[1]) < 0.00005,
    `boundary vertex is not aligned with WGS84: ${JSON.stringify(first)}`);
});

const bundledCases: { file: string; selection: ChinaRegionSelection }[] = [
  { file: "shanghai-official-boundary.geojson", selection: { provinceCode: "31" } },
  { file: "beijing-official-boundary.geojson", selection: { provinceCode: "11" } },
  { file: "tianjin-official-boundary.geojson", selection: { provinceCode: "12" } },
  { file: "chongqing-official-boundary.geojson", selection: { provinceCode: "50" } },
  { file: "shanghai-districts.geojson", selection: { provinceCode: "31", cityCode: "3101", districtCode: "310101" } },
  { file: "beijing-districts.geojson", selection: { provinceCode: "11", cityCode: "1101", districtCode: "110101" } },
  { file: "guangdong-cities.geojson", selection: { provinceCode: "44", cityCode: "4401" } },
  { file: "jiangsu-cities.geojson", selection: { provinceCode: "32", cityCode: "3201" } },
  { file: "zhejiang-cities.geojson", selection: { provinceCode: "33", cityCode: "3301" } },
];

for (const { file, selection } of bundledCases) {
  test(`${file} is normalized at its loader and cached without a second shift`, async () => {
    const raw = asset(file);
    const expected = normalizeBoundaryGeometry({ geoJson: raw.features[0]!, coordinateSystem: "GCJ-02" }).geoJson;
    const first = await resolveAdminBoundaryHighlight(selection, "light");
    const cached = await resolveAdminBoundaryHighlight(selection, "dark");
    assert.equal(first?.geoJson.type, "FeatureCollection");
    assert.equal(cached?.geoJson.type, "FeatureCollection");
    if (first?.geoJson.type !== "FeatureCollection" || cached?.geoJson.type !== "FeatureCollection") return;
    const feature = first.geoJson.features[0]!;
    assert.notDeepEqual(feature.geometry.coordinates, raw.features[0]!.geometry.coordinates);
    assert.deepEqual(feature.geometry, expected.geometry);
    assert.deepEqual(feature.properties?.center, expected.properties?.center);
    assert.deepEqual(cached.geoJson.features[0]!.geometry, feature.geometry);
  });
}

test("Natural Earth WGS84 fallback retains its original coordinates", async () => {
  const controller = new AbortController();
  controller.abort(); // Deterministically skip the online provider, without network.
  const result = await resolveAdminBoundaryHighlight({ provinceCode: "32" }, "light", controller.signal);
  assert.equal(result?.geoJson.type, "FeatureCollection");
  if (result?.geoJson.type !== "FeatureCollection") return;
  const feature = result.geoJson.features[0]!;
  const original = asset("china-provinces-10m.geojson").features.find((candidate) => candidate.id === feature.id);
  assert.ok(original);
  assert.deepEqual(feature.geometry, original.geometry);
});

test("remote DataV response is normalized before caching and does not refetch or reconvert", async (t) => {
  const raw = asset("shanghai-districts.geojson").features[0]!;
  const expected = normalizeBoundaryGeometry({ geoJson: raw, coordinateSystem: "GCJ-02" }).geoJson;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ type: "FeatureCollection", features: [raw] }), { status: 200 });
  });
  const selection = { provinceCode: "51", cityCode: "5101", districtCode: "510104" };
  const first = await resolveAdminBoundaryHighlight(selection);
  const cached = await resolveAdminBoundaryHighlight(selection);
  assert.deepEqual(requests, ["https://geo.datav.aliyun.com/areas_v3/bound/510104.json"]);
  assert.equal(first?.geoJson.type, "FeatureCollection");
  assert.equal(cached?.geoJson.type, "FeatureCollection");
  if (first?.geoJson.type !== "FeatureCollection" || cached?.geoJson.type !== "FeatureCollection") return;
  assert.deepEqual(first.geoJson.features[0]!.geometry, expected.geometry);
  assert.deepEqual(cached.geoJson.features[0]!.geometry, expected.geometry);
});
