import assert from "node:assert/strict";
import test from "node:test";
import { createJobQueryIndex } from "../src/query-index.js";
import { queryJobs, JobQueryError, DEFAULT_TECHNICAL_ALIASES, type JobQueryInput, type QueryOptions } from "../src/query.js";
import { getDefaultCompanyColorConfig } from "../src/colors.js";
import { syntheticAtlas } from "../../../apps/job-service/tests/synthetic-atlas.ts";
import type { AtlasDataset } from "../src/schema.js";

const options: QueryOptions = { now: "2026-10-28T01:00:00.000Z", aliases: DEFAULT_TECHNICAL_ALIASES };
const stale = (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor";

function fixture(): AtlasDataset {
  const data = syntheticAtlas(24, "indexed-query");
  for (const [i, job] of data.jobs.entries()) {
    job.status = i % 5 === 0 ? "closed" : i % 3 === 0 ? "open" : "unknown";
    job.workMode = i % 3 === 0 ? "remote" : "on-site";
    job.employmentType = i % 4 === 0 ? "campus" : "social";
    const location = data.locations[i]!;
    location.countryCode = i % 3 === 0 ? "US" : "CN";
    location.city = i % 3 === 0 ? "Seattle" : "上海市";
    location.region = i % 3 === 0 ? "Washington" : "上海市";
    if (i % 2) {
      const id = `salary-${i}`;
      job.compensationIds = [id];
      data.compensations.push({ id, raw: "Synthetic annual salary", min: 100_000 + i * 1000, max: 150_000 + i * 1000,
        currency: i % 3 ? "CNY" : "USD", period: "year", tax: "gross", kind: "base", verification: "unverified", evidence: [], locationIds: [location.id] });
    }
  }
  return data;
}

test("indexed queries equal the reference for search, compound filters, sorting, paging, facets and map facts", async () => {
  const data = fixture(), index = createJobQueryIndex(data);
  const queries: JobQueryInput[] = [
    {}, { search: { text: "C#" } }, { search: { text: "TypeScript", mode: "exact" } },
    { search: { text: "enginer" } }, { search: { text: "上海 c#" } }, { search: { text: "C++" } },
    { market: "domestic", includeUnknownLocations: false }, { market: "overseas" },
    { workCountryCodes: ["CN"], workRegionGroups: [["上海", "Seattle"]] },
    { workCountryCodes: ["US"], workRegionText: "Shanghai" },
    { workRegionIds: ["上海市"] }, { ownershipKinds: ["unknown"], controllerJurisdictions: ["unknown"] },
    { companyIds: [data.companies[1]!.id, data.companies[5]!.id] },
    { jobIds: [] }, { jobIds: [data.jobs[1]!.id, data.jobs[3]!.id, "missing"] },
    { sourceIds: [data.sources[0]!.sourceId] }, { sourceIds: ["missing"] },
    { statuses: ["closed"] }, { statuses: ["open", "unknown"], employmentTypes: ["social"], workModes: ["on-site"] },
    { salary: { range: { min: 110_000 }, includeUnknown: false } },
    { salary: { range: { max: 200_000 }, rangeMode: "contained", metric: "max" }, sort: { field: "salary", direction: "desc" } },
    { sort: { field: "updated", direction: "asc" }, mapLevel: "country" },
    { mapLevel: "location", viewport: { enabled: true, bounds: [120, 30, 123, 33] } },
  ];
  for (const query of queries) {
    const paged = { ...query, page: { limit: 3 } };
    const expected = await queryJobs(data, paged, options);
    const actual = await index.search(paged, options);
    assert.deepEqual(actual, expected, JSON.stringify(query));
    assert.deepEqual(await index.search(paged, options), expected, "cached plan must have identical facts");
    if (expected.nextCursor) assert.deepEqual(
      await index.search({ ...paged, page: { limit: 3, cursor: expected.nextCursor } }, options),
      await queryJobs(data, { ...paged, page: { limit: 3, cursor: expected.nextCursor } }, options),
    );
  }
});

test("same-office constraints are retained rather than independently intersecting country and region postings", async () => {
  const data = fixture();
  data.jobs[1]!.locationIds.push(data.locations[0]!.id);
  const query = { workCountryCodes: ["US"], workRegionGroups: [["上海市"]] };
  assert.equal((await createJobQueryIndex(data).search(query, options)).totalJobs, 0);
  assert.deepEqual(await createJobQueryIndex(data).search(query, options), await queryJobs(data, query, options));
});

test("distance anchors, options, evaluation day and mutable option values invalidate cached plans correctly", async () => {
  const data = fixture(), index = createJobQueryIndex(data);
  const query: JobQueryInput = { distance: { anchorRef: "local-only", includeUnknown: true }, sort: { field: "distance", direction: "asc" } };
  const near: QueryOptions = { ...options, anchor: { ref: "local-only", coordinateSystem: "WGS84", latitude: 31, longitude: 121 } };
  const far: QueryOptions = { ...near, anchor: { ...near.anchor!, latitude: 0 } };
  for (const context of [near, far, near]) assert.deepEqual(await index.search(query, context), await queryJobs(data, query, context));
  const colors = getDefaultCompanyColorConfig();
  const context: QueryOptions = { ...options, colorConfig: colors, fx: { id: "fx", provider: "Synthetic", date: "2026-10-28", ratesToCny: { USD: 7 } } };
  const baseline = await index.search({}, context);
  colors.defaultColor = "#123456"; colors.unverifiedLabel = "Changed synthetic label";
  context.fx!.ratesToCny.USD = 6;
  const changed = await index.search({}, context);
  assert.notEqual(changed.queryId, baseline.queryId);
  assert.deepEqual(changed, await queryJobs(data, {}, context));
  assert.deepEqual(await index.search({}, { ...context, now: "2026-10-29T00:00:00.000Z" }), await queryJobs(data, {}, { ...context, now: "2026-10-29T00:00:00.000Z" }));
  await assert.rejects(index.search(query, options), error => error instanceof JobQueryError && error.code === "anchor-required");
});

test("cursor identity is compatible with the reference and rejects changed versions, days and page sizes", async () => {
  const data = fixture(), index = createJobQueryIndex(data), query = { page: { limit: 1 } };
  const first = await index.search(query, options);
  assert.ok(first.nextCursor);
  assert.deepEqual(await index.search({ page: { limit: 1, cursor: first.nextCursor } }, options), await queryJobs(data, { page: { limit: 1, cursor: first.nextCursor } }, options));
  await assert.rejects(index.search({ page: { limit: 2, cursor: first.nextCursor } }, options), stale);
  await assert.rejects(index.search({ search: { text: "other" }, page: { limit: 1, cursor: first.nextCursor } }, options), stale);
  await assert.rejects(index.search({ page: { limit: 1, cursor: first.nextCursor } }, { ...options, now: "2026-10-29T01:00:00.000Z" }), stale);
  await assert.rejects(createJobQueryIndex({ ...data, revision: data.revision + 1 }).search({ page: { limit: 1, cursor: first.nextCursor } }, options), stale);
});

test("revision changes update company, location, job, salary and source coverage without leaking old map results", async () => {
  const data = fixture(), original = structuredClone(data), before = createJobQueryIndex(data);
  const old = await before.search({}, options);
  const next = structuredClone(data); next.revision++;
  next.companies[1]!.names = ["Renamed Synthetic Enterprise"];
  next.locations[4]!.coordinates = { coordinateSystem: "WGS84", latitude: 40, longitude: 120 };
  next.jobs[1]!.status = "closed";
  next.compensations[0]!.min = 200_000; next.compensations[0]!.max = 210_000;
  next.observations[0]!.result = "partial";
  const after = createJobQueryIndex(next);
  const current = await after.search({}, options);
  assert.deepEqual(current, await queryJobs(next, {}, options));
  assert.notDeepEqual(current.mapBuckets, old.mapBuckets);
  assert.equal(current.sourceCoverage[0]!.partial, true);
  assert.equal((await after.search({ search: { text: "Renamed" } }, options)).totalJobs, 0, "closed role is excluded by default");
  assert.equal((await after.search({ search: { text: "Renamed" }, statuses: ["closed"] }, options)).totalJobs, 1);
  assert.deepEqual(await before.search({}, options), old);
  assert.deepEqual(data, original, "building/querying an index must not mutate its input");
});

test("unchanged entity text is reused across structurally shared revisions and one changed job is re-indexed", async t => {
  const data = syntheticAtlas(100, "shared-text");
  const first = createJobQueryIndex(data);
  await first.search({ search: { text: "engineer" } }, options);
  const normalize = String.prototype.normalize;
  let descriptions = 0;
  String.prototype.normalize = function(form) { if (String(this).length > 100) descriptions++; return normalize.call(this, form); };
  try {
    const jobs = [...data.jobs]; jobs[0] = { ...jobs[0]!, description: `${jobs[0]!.description} changedneedle`, revision: 1 };
    const next = { ...data, revision: 1, jobs };
    const current = createJobQueryIndex(next);
    assert.equal((await current.search({ search: { text: "changedneedle", mode: "exact" } }, options)).totalJobs, 1);
    assert.equal(descriptions, 1, "unchanged full descriptions must not be normalized again");
    t.diagnostic(JSON.stringify({ syntheticJobs: data.jobs.length, changedJobs: 1, normalizedDescriptions: descriptions }));
  } finally { String.prototype.normalize = normalize; }
});

test("independent stores with the same revision do not alias and invalid datasets still fail closed", async () => {
  const left = syntheticAtlas(2, "left"), right = syntheticAtlas(3, "right");
  assert.equal(left.revision, right.revision);
  assert.equal((await createJobQueryIndex(left).search({}, options)).totalJobs, 2);
  assert.equal((await createJobQueryIndex(right).search({}, options)).totalJobs, 3);
  const invalid = structuredClone(left); invalid.jobs[0]!.companyId = "missing";
  assert.throws(() => createJobQueryIndex(invalid));
});

test("bounded plan eviction preserves results, and failed validation does not poison future queries", async () => {
  const data = fixture(), index = createJobQueryIndex(data), first = await index.search({}, options);
  for (let i = 0; i < 12; i++) await index.search({ search: { text: `query${i}` } }, options);
  assert.deepEqual(await index.search({}, options), first);
  await assert.rejects(index.search({ page: { limit: 0 } }, options), error => error instanceof JobQueryError && error.code === "invalid-query");
  assert.deepEqual(await index.search({}, options), first);
});

test("map level, sort and same-UTC-day requests reuse matched text instead of re-running fuzzy search", async () => {
  const data = syntheticAtlas(40, "matched-reuse"), index = createJobQueryIndex(data);
  const base = { search: { text: "enginer" }, page: { limit: 3 } };
  const first = await index.search(base, options);
  const split = String.prototype.split;
  let descriptionSplits = 0;
  String.prototype.split = function(separator: any, limit?: number) {
    if (String(this).length > 100) descriptionSplits++;
    return split.call(this, separator, limit);
  } as typeof String.prototype.split;
  try {
    await index.search({ ...base, mapLevel: "country" }, options);
    await index.search({ ...base, sort: { field: "updated", direction: "asc" } }, options);
    const sameDay = await index.search(base, { ...options, now: "2026-10-29T00:30:00+08:00" });
    assert.equal(sameDay.mapBuckets, first.mapBuckets, "same UTC day retains the aggregate projection");
    assert.equal(descriptionSplits, 0, "sort/map changes must not re-evaluate full-text matches");
  } finally { String.prototype.split = split; }
});

test("initial unfiltered listings prepare no full descriptions until text search is requested", async () => {
  const data = syntheticAtlas(40, "lazy-search"), normalize = String.prototype.normalize;
  let descriptions = 0;
  String.prototype.normalize = function(form) { if (String(this).length > 100) descriptions++; return normalize.call(this, form); };
  try {
    const index = createJobQueryIndex(data);
    assert.equal((await index.search({}, options)).totalJobs, 40);
    assert.equal(descriptions, 0);
    await index.search({ companyIds: [data.companies[0]!.id], search: { text: "engineer" } }, options);
    assert.equal(descriptions, 1, "selective postings prepare only the candidate job");
  } finally { String.prototype.normalize = normalize; }
});
