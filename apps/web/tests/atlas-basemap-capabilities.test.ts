import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDetailLayers, openFreeMapTileJsonUrls, readAtlasVectorCapabilities } from "../src/components/atlas/prototypes/basemap-capabilities.ts";

const styleUrl = "https://tiles.openfreemap.org/styles/dark";
const tileJsonUrl = "https://tiles.openfreemap.org/planet";
const style = {
  version: 8,
  sources: { openmaptiles: { type: "vector", url: tileJsonUrl } },
  layers: [
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", minzoom: 12 },
    { id: "place-labels", type: "symbol", source: "openmaptiles", "source-layer": "place", minzoom: 4 },
  ],
};
const tileJson = {
  vector_layers: [
    { id: "building", minzoom: 13, maxzoom: 14, fields: { render_height: "Number", render_min_height: "Number", colour: "String" } },
    { id: "housenumber", minzoom: 14, maxzoom: 14, fields: { housenumber: "String" } },
  ],
};

test("OpenFreeMap capabilities require matching vector source and advertised building and housenumber fields", () => {
  assert.deepEqual(openFreeMapTileJsonUrls(style, styleUrl), [tileJsonUrl]);
  assert.deepEqual(readAtlasVectorCapabilities(style, tileJson, tileJsonUrl), {
    building: { sourceId: "openmaptiles", sourceLayer: "building", heightField: "render_height", baseField: "render_min_height", minZoom: 13 },
    houseNumbers: { sourceId: "openmaptiles", sourceLayer: "housenumber", numberField: "housenumber", minZoom: 14 },
  });
});

test("untrusted, mismatched or incomplete style metadata does not enable optional detail layers", () => {
  assert.deepEqual(openFreeMapTileJsonUrls(style, "https://example.com/style.json"), []);
  assert.deepEqual(openFreeMapTileJsonUrls(style, "https://user@tiles.openfreemap.org/styles/dark"), []);
  assert.deepEqual(openFreeMapTileJsonUrls({ ...style, sources: { openmaptiles: { type: "vector", url: "http://tiles.openfreemap.org/planet" } } }, styleUrl), []);
  assert.deepEqual(openFreeMapTileJsonUrls({ ...style, sources: { openmaptiles: { type: "vector", url: `${tileJsonUrl}?token=unreviewed` } } }, styleUrl), []);
  assert.deepEqual(readAtlasVectorCapabilities(style, tileJson, "https://tiles.openfreemap.org/other"), null);
  assert.deepEqual(readAtlasVectorCapabilities({ ...style, layers: [] }, tileJson, tileJsonUrl), {
    building: { sourceId: "openmaptiles", sourceLayer: "building", heightField: "render_height", baseField: "render_min_height", minZoom: 13 },
    houseNumbers: { sourceId: "openmaptiles", sourceLayer: "housenumber", numberField: "housenumber", minZoom: 14 },
  }, "validated TileJSON fields remain sufficient even when the style omits enhancement layers");
  assert.deepEqual(readAtlasVectorCapabilities(style, { vector_layers: [{ id: "building", fields: { render_height: "String" } }] }, tileJsonUrl), null);
  assert.deepEqual(readAtlasVectorCapabilities(style, { vector_layers: [{ id: "building", fields: { render_height: "Number" } }, { id: "housenumber", fields: { housenumber: "Number" } }] }, tileJsonUrl), {
    building: { sourceId: "openmaptiles", sourceLayer: "building", heightField: "render_height", minZoom: 13 },
  }, "a valid building capability can remain enabled when only the house-number field is malformed");
  assert.deepEqual(readAtlasVectorCapabilities(style, { vector_layers: "invalid" }, tileJsonUrl), null);
  for (const minzoom of [-1, 23, Infinity, "14"] as const) {
    const malformed = { vector_layers: [{ id: "building", minzoom, fields: { render_height: "Number" } }, { id: "housenumber", minzoom, fields: { housenumber: "String" } }] };
    assert.equal(readAtlasVectorCapabilities(style, malformed, tileJsonUrl), null, `invalid minzoom ${String(minzoom)} must not install detail layers`);
  }
});

test("detail layers use advertised geometry fields, close zooms, contrasting labels and preserve marker-ready source IDs", () => {
  const capabilities = readAtlasVectorCapabilities(style, tileJson, tileJsonUrl)!;
  const layers = createAtlasDetailLayers(capabilities, false);
  assert.deepEqual(layers.map(layer => layer.id), ["atlas-buildings-3d", "atlas-house-numbers"]);
  const [building, house] = layers as Array<Record<string, unknown>>;
  assert.equal(building.source, "basemap:openmaptiles"); assert.equal(building["source-layer"], "building"); assert.equal(building.minzoom, 13);
  assert.deepEqual((building.paint as Record<string, unknown>)["fill-extrusion-height"], ["coalesce", ["get", "render_height"], 0]);
  assert.deepEqual((building.paint as Record<string, unknown>)["fill-extrusion-base"], ["coalesce", ["get", "render_min_height"], 0]);
  assert.equal(house.source, "basemap:openmaptiles"); assert.equal(house["source-layer"], "housenumber"); assert.equal(house.minzoom, 14);
  assert.deepEqual((house.layout as Record<string, unknown>)["text-field"], ["get", "housenumber"]);
  assert.deepEqual(createAtlasDetailLayers(capabilities, true).map(layer => layer.id), ["atlas-buildings-3d", "atlas-house-numbers"]);
  assert.notEqual(((layers[1]!.paint as Record<string, unknown>)["text-halo-color"]), ((createAtlasDetailLayers(capabilities, true)[1]!.paint as Record<string, unknown>)["text-halo-color"]));
});
