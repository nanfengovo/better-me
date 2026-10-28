import assert from "node:assert/strict";
import test from "node:test";
import { createJobQueryIndex, queryJobs, DEFAULT_TECHNICAL_ALIASES, type JobQueryInput } from "@better-me/opportunities";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";

const options = { now: "2026-10-28T01:00:00.000Z", aliases: DEFAULT_TECHNICAL_ALIASES };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rounded = (value: number) => Math.round(value * 100) / 100;

for (const size of [5000, 15000]) test(`${size} job indexed search/filter/page/map and revision comparison`, {
  skip: process.env.BETTER_ME_SCALE_BENCH !== "1", timeout: 180_000,
}, async t => {
  const data = syntheticAtlas(size, `query-scale-${size}`);
  const original = JSON.stringify(data);
  const baseQuery = { search: { text: "C#" }, page: { limit: 30 } };
  const coldStarted = performance.now();
  const index = createJobQueryIndex(data);
  const initial = await index.search(baseQuery, options);
  const coldIndexAndFirstQueryMs = performance.now() - coldStarted;
  assert.equal(initial.totalJobs, size / 2);
  assert.equal(initial.mappedJobs, size / 4);
  assert.equal(initial.items.length, 30);
  assert.ok(initial.nextCursor);
  const cases: Array<{ name: string; query: JobQueryInput }> = [
    { name: "different-keyword", query: { search: { text: "TypeScript" }, page: { limit: 30 } } },
    { name: "compound-filter", query: { ...baseQuery, workCountryCodes: ["CN"], includeUnknownLocations: false } },
    { name: "next-page", query: { ...baseQuery, page: { limit: 30, cursor: initial.nextCursor } } },
    { name: "map-level", query: { ...baseQuery, mapLevel: "country" } },
  ];
  const measurements: Array<Record<string, number | string>> = [];
  for (const { name, query } of cases) {
    const conditionStarted = performance.now();
    const actual = await index.search(query, options);
    const firstConditionMs = performance.now() - conditionStarted;
    assert.deepEqual(actual, await queryJobs(data, query, options), `${name}: all results, cursors, facets and map facts must match`);
    const reference: number[] = [], indexed: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      // Paired samples in one process; never run concurrently with a build.
      const referenceStarted = performance.now(); await queryJobs(data, query, options); reference.push(performance.now() - referenceStarted);
      const indexedStarted = performance.now(); await index.search(query, options); indexed.push(performance.now() - indexedStarted);
    }
    const referenceMs = median(reference), indexedMs = median(indexed);
    assert.ok(indexedMs < referenceMs * 0.3, `${name}: warm index should remove most repeated work (${indexedMs} vs ${referenceMs}ms)`);
    measurements.push({ scenario: name, referenceMedianMs: rounded(referenceMs), indexedFirstConditionMs: rounded(firstConditionMs), indexedWarmMedianMs: rounded(indexedMs), speedup: rounded(referenceMs / indexedMs) });
  }
  const changedJobs = [...data.jobs]; changedJobs[0] = { ...changedJobs[0]!, title: { ...changedJobs[0]!.title, value: "C# updated engineer" }, revision: 1 };
  const changedLocations = [...data.locations]; changedLocations[0] = { ...changedLocations[0]!, coordinates: { coordinateSystem: "WGS84", latitude: 32, longitude: 122 } };
  const next = { ...data, revision: 1, jobs: changedJobs, locations: changedLocations };
  const normalize = String.prototype.normalize;
  let normalizedDescriptions = 0;
  String.prototype.normalize = function(form) { if (String(this).length > 100) normalizedDescriptions++; return normalize.call(this, form); };
  const revisionStarted = performance.now();
  let revisionResult;
  try { revisionResult = await createJobQueryIndex(next).search(baseQuery, options); }
  finally { String.prototype.normalize = normalize; }
  const revisionIndexAndQueryMs = performance.now() - revisionStarted;
  assert.equal(normalizedDescriptions, 1);
  const referenceStarted = performance.now(); const revisionReference = await queryJobs(next, baseQuery, options);
  const revisionReferenceMs = performance.now() - referenceStarted;
  assert.deepEqual(revisionResult, revisionReference);
  assert.notDeepEqual(revisionResult.mapBuckets, initial.mapBuckets);
  assert.equal(JSON.stringify(data), original, "synthetic baseline was never mutated");
  t.diagnostic(JSON.stringify({ syntheticJobs: size, coldIndexAndFirstQueryMs: rounded(coldIndexAndFirstQueryMs), pairedSamples: 3, measurements,
    revision: { changedJobs: 1, changedLocations: 1, normalizedDescriptions, indexAndQueryMs: rounded(revisionIndexAndQueryMs), referenceQueryMs: rounded(revisionReferenceMs) } }));
});
