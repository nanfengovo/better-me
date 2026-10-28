import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBoundaryGeometry,
  type GeoJsonFeatureCollection,
} from "../src/components/atlas/boundary-geometry-normalization";

const sourcePoint = [121.153743, 31.276646, 18];
const referencePoint = [121.14917894727922, 31.278521729243856, 18];

function fixture(): GeoJsonFeatureCollection {
  const ring = [sourcePoint, [121.8, 31.3, 20], [121.3, 31.8, 30], sourcePoint];
  const hole = [[121.4, 31.4, 21], [121.5, 31.4, 22], [121.4, 31.5, 23], [121.4, 31.4, 21]];
  return {
    type: "FeatureCollection",
    bbox: [121, 31, 0, 122, 32, 40],
    features: [{
      type: "Feature",
      id: "test-boundary",
      bbox: [121, 31, 0, 122, 32, 40],
      properties: {
        adcode: 310000,
        name: "Fixture only",
        center: sourcePoint,
        centroid: sourcePoint,
        parent: { adcode: 100000 },
        acroutes: [100000, 310000],
      },
      geometry: {
        type: "MultiPolygon",
        coordinates: [[ring, hole], [ring]],
        bbox: [121, 31, 0, 122, 32, 40],
      },
    }],
  };
}

function deepFreeze(value: unknown) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
}

test("known GCJ-02 normalization follows the pinned public reference formula", () => {
  const normalized = normalizeBoundaryGeometry({ geoJson: fixture(), coordinateSystem: "GCJ-02" });
  const position = normalized.geoJson.features[0]!.geometry.coordinates[0][0][0];
  assert.equal(normalized.coordinateSystem, "WGS84");
  assert.ok(Math.abs(position[0] - referencePoint[0]!) < 1e-10);
  assert.ok(Math.abs(position[1] - referencePoint[1]!) < 1e-10);
  assert.equal(position[2], 18);
});

test("normalization preserves holes, islands, ring closure and metadata without mutating raw data", () => {
  const raw = fixture();
  const before = JSON.stringify(raw);
  deepFreeze(raw);
  const normalized = normalizeBoundaryGeometry({ geoJson: raw, coordinateSystem: "GCJ-02" }).geoJson;
  const feature = normalized.features[0]!;
  const coordinates = feature.geometry.coordinates;
  assert.equal(JSON.stringify(raw), before);
  assert.equal(coordinates.length, 2);
  assert.equal(coordinates[0].length, 2);
  assert.equal(coordinates[1].length, 1);
  assert.deepEqual(coordinates[0][0][0], coordinates[0][0].at(-1));
  assert.deepEqual(coordinates[0][1][0], coordinates[0][1].at(-1));
  assert.equal(feature.id, "test-boundary");
  assert.equal(feature.properties?.adcode, 310000);
  assert.equal(feature.properties?.name, "Fixture only");
  assert.deepEqual(feature.properties?.parent, { adcode: 100000 });
  assert.deepEqual(feature.properties?.acroutes, [100000, 310000]);
  assert.deepEqual(feature.properties?.center, coordinates[0][0][0]);
  assert.deepEqual(feature.properties?.centroid, coordinates[0][0][0]);
});

test("derived bounding boxes are recomputed in the output CRS including altitude", () => {
  const normalized = normalizeBoundaryGeometry({ geoJson: fixture(), coordinateSystem: "GCJ-02" }).geoJson;
  const feature = normalized.features[0]!;
  const positions = feature.geometry.coordinates.flat(2) as number[][];
  const expected = [0, 1, 2].map((dimension) => Math.min(...positions.map((position) => position[dimension]!)))
    .concat([0, 1, 2].map((dimension) => Math.max(...positions.map((position) => position[dimension]!))));
  assert.deepEqual(normalized.bbox, expected);
  assert.deepEqual(feature.bbox, expected);
  assert.deepEqual(feature.geometry.bbox, expected);
});

test("a normalized envelope and already-WGS84 source cannot be shifted twice", () => {
  const rawWgs84 = fixture();
  assert.equal(normalizeBoundaryGeometry({ geoJson: rawWgs84, coordinateSystem: "WGS84" }).geoJson, rawWgs84);
  const normalized = normalizeBoundaryGeometry({ geoJson: fixture(), coordinateSystem: "GCJ-02" });
  assert.equal(normalizeBoundaryGeometry(normalized).geoJson, normalized.geoJson);
});

test("the public conversion model leaves coordinates outside its applicability rectangle unchanged", () => {
  const feature = fixture().features[0]!;
  feature.geometry = { type: "Point", coordinates: [-0.1276, 51.5072] };
  const normalized = normalizeBoundaryGeometry({ geoJson: feature, coordinateSystem: "GCJ-02" });
  assert.deepEqual(normalized.geoJson.geometry.coordinates, [-0.1276, 51.5072]);
});
