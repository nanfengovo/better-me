import assert from "node:assert/strict";
import test from "node:test";
import type { MapBucket } from "@better-me/opportunities";
import { createSceneReconciler, sceneMarkers } from "../src/components/atlas/map3d/scene-model";
import { describeSceneFailure, heightToZoom, SCENE_QUALITY, validateSceneSource, zoomToHeight } from "../src/components/atlas/map3d/config";
import { boundaryRings } from "../src/components/atlas/map3d/boundary-lines";

test("ground boundary lines preserve WGS84 outer rings, holes and island geometry without snapping", () => {
  const exterior = [[121,31],[122,31],[122,32],[121,31]], hole = [[121.1,31.1],[121.2,31.1],[121.2,31.2],[121.1,31.1]];
  const data = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[exterior, hole], [exterior]] } }] };
  const before = structuredClone(data);
  assert.deepEqual(boundaryRings(data), [exterior.flat(), hole.flat(), exterior.flat()]);
  assert.deepEqual(data, before);
  assert.deepEqual(boundaryRings({ type:"Polygon", coordinates:[[[999, 0], [1, 1], [2, 1], [999, 0]]] }), []);
});

function bucket(index: number, overrides: Partial<MapBucket> = {}): MapBucket {
  return { id: `synthetic-office-${index}`, label: `Synthetic office ${index}`, longitude: 120 + index / 100_000, latitude: 31,
    jobCount: 1, pinCount: 1, locationIds: [`location-${index}`], jobIds: [`job-${index}`], displayGrade: "address", categories: [], ...overrides };
}
test("3D source admission requires explicit key or authorized HTTPS/local tileset; errors never echo credentials", () => {
  assert.deepEqual(validateSceneSource({ kind: "globe" }), { kind: "globe" });
  assert.throws(() => validateSceneSource({ kind: "google", apiKey: " " }), /API Key/);
  for (const url of ["file:///private/index.json", "javascript:alert(1)", "http://external.invalid/tileset.json", "https://user:password@external.invalid/tileset.json"]) {
    assert.throws(() => validateSceneSource({ kind: "tileset", url, attribution: "Own licensed data" }));
  }
  assert.equal(validateSceneSource({ kind: "tileset", url: "http://127.0.0.1:1234/tileset.json", attribution: "Own licensed data" }).kind, "tileset");
  assert.throws(() => validateSceneSource({ kind: "tileset", url: "https://synthetic.invalid/tileset.json", attribution: "" }));
  for (const status of [400, 401, 403, 429, 500]) {
    const result = describeSceneFailure({ statusCode: status, message: "https://tile.invalid?key=DO_NOT_LEAK_CANARY" });
    assert.ok(!JSON.stringify(result).includes("CANARY"));
    assert.equal(result.kind, status === 429 ? "quota" : status < 500 ? "credentials" : "unknown");
  }
  assert.equal(describeSceneFailure(new Error("Received status code 403 for SECRET")).kind, "credentials");
  assert.equal(describeSceneFailure(new Error("network timeout")).kind, "network");
  assert.equal(describeSceneFailure(new Error("WebGL context lost")).kind, "gpu");
  assert.match(describeSceneFailure(new Error("network timeout")).detail, /不代表/);
});
test("3D grouping preserves exact WGS84 coordinates, excludes city references, keeps all co-located choices", () => {
  const input = [bucket(0), bucket(1, { longitude: 120, jobIds: ["job-0", "job-1"], jobCount: 2 }), bucket(2, { displayGrade: "city", positionBasis: "city-reference", estimated: true, precision: "city" }), bucket(3, { latitude: NaN }), bucket(4, { displayGrade: undefined })];
  const before = structuredClone(input);
  const output = sceneMarkers(input);
  assert.equal(output.size, 1);
  const marker = output.get("120,31")!;
  assert.deepEqual(marker.bucketIds, ["synthetic-office-0", "synthetic-office-1"]);
  assert.equal(marker.jobCount, 2); assert.equal(marker.longitude, 120); assert.equal(marker.latitude, 31);
  assert.deepEqual(input, before, "presentation must not modify jobs or source coordinates");
});
test("quality profiles are bounded and native camera conversion is explicit rather than using zoom as metres", () => {
  assert.ok(SCENE_QUALITY.economy.cacheBytes < SCENE_QUALITY.balanced.cacheBytes);
  assert.ok(SCENE_QUALITY.sharp.cacheBytes + SCENE_QUALITY.sharp.maximumCacheOverflowBytes <= 384 * 1024 ** 2);
  for (const zoom of [2, 4, 8, 12, 16]) assert.ok(Math.abs(heightToZoom(zoomToHeight(zoom, 31), 31) - zoom) < .00001);
});
for (const size of [5000, 15000]) test(`3D incremental reconciliation: ${size} synthetic jobs, ${size} exact-coordinate markers`, t => {
  const input = Array.from({ length: size }, (_, i) => bucket(i));
  let uploads = 0, removes = 0, selections = 0, renders = 0;
  const sync = createSceneReconciler({ upsert() { uploads++; }, remove() { removes++; }, select() { selections++; }, render() { renders++; } });
  const begin = performance.now(); const first = sync(input); const initialMs = performance.now() - begin;
  assert.equal(first.size, size); assert.equal(uploads, size);
  const unchanged = performance.now(); for (let i = 0; i < 120; i++) sync(input); const unchangedMs = performance.now() - unchanged;
  assert.equal(uploads, size); assert.equal(renders, 1); assert.equal(selections, 1);
  sync(input, input[0]!.id); assert.equal(uploads, size); assert.equal(renders, 2);
  const next = input.slice(); next[0] = { ...input[0]!, jobCount: 2, jobIds: ["job-0", "job-added"] };
  const update = performance.now(); sync(next, input[0]!.id); const updateMs = performance.now() - update;
  assert.equal(uploads, size + 1, "one changed coordinate group produces one upload");
  sync(next.slice(1)); assert.equal(removes, 1);
  t.diagnostic(JSON.stringify({ jobs: size, markers: first.size, initialMs, unchanged120Ms: unchangedMs, oneChangedGroupMs: updateMs, changedGroupUploads: 1 }));
  assert.ok(initialMs < 2000 && updateMs < 2000, "generous CPU correctness guard, not a browser FPS claim");
});
