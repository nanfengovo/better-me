import assert from "node:assert/strict";
import test from "node:test";
import {
  AtlasDatasetSchema,
  type AtlasDataset,
  type Company,
  type Compensation,
  type Evidenced,
  type JobLocation,
  type SourceDefinition,
  type SourceObservation,
} from "../src/schema.js";
import { JobQueryError, createJobQueryService, includesSearchText, normalizeSearchText, queryJobs } from "../src/query.js";

const AS_OF = "2026-10-18T12:00:00.000Z";
const EVALUATION_DAY = "2026-10-18T00:00:00.000Z";
const OPTIONS = { now: AS_OF };
const plainField = <T>(value: T): Evidenced<T> => ({ value, evidence: [], method: "manual", verification: "unverified", revision: 0 });
const point = (latitude: number, longitude: number) => ({ latitude, longitude, coordinateSystem: "WGS84" as const });

type JobSpec = {
  id: string;
  title?: string;
  description?: string;
  companyId?: string;
  companyCountry?: string;
  companyVerified?: boolean;
  ownership?: "state" | "private" | "dispersed" | "joint" | "unknown";
  locations?: Array<Partial<JobLocation>>;
  salary?: Partial<Compensation>;
  sourceId?: string;
};

function source(sourceId: string): SourceDefinition {
  return {
    sourceId, name: `Synthetic ${sourceId}`, adapterId: "synthetic-feed", adapterVersion: "1",
    capabilities: ["list-jobs", "read-detail"], runtime: ["local-service"], entityType: "job-posting",
    enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: `Synthetic ${sourceId}`, usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 },
  };
}

/** Every field and coordinate is synthetic. No current browser or private opportunity storage is read. */
function datasetFor(specs: JobSpec[]): AtlasDataset {
  const dataset: AtlasDataset = {
    schemaVersion: 1, revision: 7, sources: [source("source-a"), source("source-b")],
    companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [],
  };
  for (const spec of specs) {
    const companyId = spec.companyId ?? `company-${spec.id}`;
    const listingId = `listing-${spec.id}`;
    const observationId = `observation-${spec.id}`;
    const sourceUrl = `https://careers.example.test/jobs/${spec.id}`;
    const evidence = [{ observationId, sourceUrl, observedAt: AS_OF, quote: `Synthetic source evidence for ${spec.id}` }];
    if (!dataset.companies.some((company) => company.id === companyId)) {
      const controllers: Company["ultimateControllers"] = spec.companyCountry
        ? { value: [{ name: `Synthetic parent ${spec.companyCountry}`, jurisdictionCode: spec.companyCountry, kind: spec.ownership ?? "private" }], evidence, verification: spec.companyVerified === false ? "unverified" : "verified", method: "manual", revision: 0 }
        : plainField([]);
      dataset.companies.push({ id: companyId, names: [`Synthetic ${companyId}`], domains: [], parentCompanyIds: [], ultimateControllers: controllers, manualOverrides: [] });
    }
    const locationIds: string[] = [];
    for (const [index, override] of (spec.locations ?? []).entries()) {
      const id = override.id ?? `location-${spec.id}-${index}`;
      locationIds.push(id);
      dataset.locations.push({ id, raw: `Synthetic office ${spec.id} ${index}`, kind: "office", precision: "address", evidence: [], verification: "unverified", ...override });
    }
    const compensationIds: string[] = [];
    if (spec.salary) {
      const id = `salary-${spec.id}`;
      compensationIds.push(id);
      dataset.compensations.push({ id, raw: "Synthetic annual gross fixed base", currency: "CNY", period: "year", tax: "gross", kind: "base", min: 100_000, max: 120_000, verification: "unverified", evidence, ...spec.salary });
    }
    dataset.jobs.push({
      id: `job-${spec.id}`, companyId, title: plainField(spec.title ?? `Synthetic engineer ${spec.id}`), description: spec.description ?? "Synthetic role description.",
      locationIds, compensationIds, listingIds: [listingId], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "open", revision: 0, updatedAt: AS_OF,
    });
    dataset.listings.push({ id: listingId, sourceId: spec.sourceId ?? "source-a", sourceRecordId: spec.id, canonicalUrl: sourceUrl, canonicalJobId: `job-${spec.id}`, observationIds: [observationId], firstDiscoveredAt: AS_OF });
    dataset.observations.push({ id: observationId, listingId, fetchedAt: AS_OF, result: "read", availability: "unknown", completeness: "detail", warnings: [] });
  }
  return AtlasDatasetSchema.parse(dataset);
}

function ids(result: Awaited<ReturnType<typeof queryJobs>>): string[] {
  return result.items.map((item) => item.job.id);
}

function addObservation(dataset: AtlasDataset, job: string, suffix: string, result: SourceObservation["result"], fetchedAt: string): void {
  const listing = dataset.listings.find((value) => value.id === `listing-${job}`)!;
  const id = `observation-${job}-${suffix}`;
  listing.observationIds.push(id);
  dataset.observations.push({ id, listingId: listing.id, fetchedAt, result, availability: "unknown", completeness: result === "read" ? "detail" : "excerpt", warnings: [] });
}

test("explicit canonical job subsets are shared filters, preserve exact empty selection and use the dataset job-count boundary", async () => {
  const dataset = datasetFor([{ id: "first" }, { id: "second" }, { id: "third" }]);
  assert.deepEqual(ids(await queryJobs(dataset, { jobIds: ["job-second", "job-third", "absent-job"], page: { limit: 1 } }, OPTIONS)), ["job-second"]);
  assert.equal((await queryJobs(dataset, { jobIds: [] }, OPTIONS)).totalJobs, 0);
  const first = await queryJobs(dataset, { jobIds: ["job-second", "job-third"], page: { limit: 1 } }, OPTIONS);
  assert.deepEqual(ids(await queryJobs(dataset, { jobIds: ["job-second", "job-third"], page: { limit: 1, cursor: first.nextCursor } }, OPTIONS)), ["job-third"]);
  assert.equal((await queryJobs(dataset, { jobIds: Array(100_000).fill("job-second") }, OPTIONS)).totalJobs, 1);
  await assert.rejects(queryJobs(dataset, { jobIds: Array(100_001).fill("job-second") }, OPTIONS), (error: unknown) => error instanceof JobQueryError && error.code === "invalid-query");
  await assert.rejects(queryJobs(dataset, { jobIds: ["invalid/job-id"] }, OPTIONS), (error: unknown) => error instanceof JobQueryError && error.code === "invalid-query");
});

test("list pagination does not page the full query map, facets or coverage counts", async () => {
  const dataset = datasetFor([
    { id: "multi", companyId: "company-shared", locations: [
      { countryCode: "CN", city: "Shanghai", coordinates: point(31.2, 121.5) },
      { countryCode: "CN", city: "Shanghai", coordinates: point(31.3, 121.6) },
    ] },
    { id: "second", companyId: "company-shared", locations: [{ countryCode: "CN", city: "Shanghai", coordinates: point(31.1, 121.4) }] },
    { id: "overseas", sourceId: "source-b", locations: [{ countryCode: "US", city: "Seattle", coordinates: point(47.6, -122.3) }] },
    { id: "unlocated" },
  ]);
  const result = await queryJobs(dataset, { page: { limit: 1 }, mapLevel: "city" }, OPTIONS);
  assert.equal(result.items.length, 1);
  assert.equal(result.totalJobs, 4);
  assert.equal(result.companyCount, 3);
  assert.equal(result.mappedJobs, 3);
  assert.equal(result.unlocatedJobs, 1);
  assert.equal(result.locationPinCount, 4);
  assert.equal(result.facets.countries.CN, 2);
  assert.equal(result.facets.countries.US, 1);
  assert.equal(result.facets.sources["source-a"], 3);
  assert.equal(result.facets.sources["source-b"], 1);
  const shanghai = result.mapBuckets.find((bucket) => bucket.label === "Shanghai")!;
  assert.equal(shanghai.jobCount, 2);
  assert.equal(shanghai.pinCount, 3);
  assert.deepEqual(shanghai.jobIds, ["job-multi", "job-second"]);
  assert.equal(shanghai.categories.reduce((sum, category) => sum + category.jobCount, 0), 2);
  assert.equal(new Set(result.mapBuckets.flatMap((bucket) => bucket.jobIds)).size, result.mappedJobs);
  assert.ok(result.nextCursor);
  assert.equal(result.snapshotVersion, dataset.revision);
  assert.equal(result.asOf, EVALUATION_DAY);
});

test("location map buckets preserve the single source location precision", async () => {
  const dataset = datasetFor([
    { id: "address", locations: [{ id: "address-location", city: "Shanghai", precision: "address", coordinates: point(31.2, 121.5) }] },
    { id: "city", locations: [{ id: "city-location", city: "Shanghai", precision: "city", coordinates: point(31.3, 121.6) }] },
  ]);
  const result = await queryJobs(dataset, { mapLevel: "location", page: { limit: 10 } }, OPTIONS);
  const address = result.mapBuckets.find(bucket => bucket.locationIds.includes("address-location"))!;
  const city = result.mapBuckets.find(bucket => bucket.locationIds.includes("city-location"))!;
  assert.equal(address.precision, "address");
  assert.equal(city.precision, "city");
  assert.equal(address.positionBasis, undefined);
  assert.equal(address.estimated, undefined);
});

test("ten jobs with two locations each remain ten canonical jobs and twenty pins", async () => {
  const dataset = datasetFor(Array.from({ length: 10 }, (_, index) => ({ id: `multi-${index}`, locations: [
    { countryCode: "CN", city: "Shanghai", coordinates: point(31 + index / 100, 121) },
    { countryCode: "US", city: "Seattle", coordinates: point(47 + index / 100, -122) },
  ] })));
  const result = await queryJobs(dataset, { mapLevel: "country", page: { limit: 3 } }, OPTIONS);
  assert.equal(result.totalJobs, 10);
  assert.equal(result.mappedJobs, 10);
  assert.equal(result.locationPinCount, 20);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.mapBuckets.map((bucket) => bucket.jobCount), [10, 10]);
  assert.equal(new Set(result.mapBuckets.flatMap((bucket) => bucket.jobIds)).size, 10);
});

test("domestic and overseas filters use working locations separately from verified controller origin", async () => {
  const dataset = datasetFor([
    { id: "german-shanghai", companyCountry: "DE", locations: [{ countryCode: "CN", city: "Shanghai", coordinates: point(31.2, 121.5) }] },
    { id: "chinese-berlin", companyCountry: "CN", locations: [{ countryCode: "DE", city: "Berlin", coordinates: point(52.5, 13.4) }] },
    { id: "unverified-german", companyCountry: "DE", companyVerified: false, locations: [{ countryCode: "CN", city: "Beijing", coordinates: point(39.9, 116.4) }] },
    { id: "unknown-location", companyCountry: "US" },
  ]);
  assert.deepEqual(ids(await queryJobs(dataset, { market: "domestic", includeUnknownLocations: false }, OPTIONS)), ["job-german-shanghai", "job-unverified-german"]);
  assert.deepEqual(ids(await queryJobs(dataset, { market: "overseas", includeUnknownLocations: false }, OPTIONS)), ["job-chinese-berlin"]);
  const foreignInChina = await queryJobs(dataset, { market: "domestic", controllerJurisdictions: ["DE"], includeUnknownLocations: false }, OPTIONS);
  assert.deepEqual(ids(foreignInChina), ["job-german-shanghai"]);
  assert.equal(foreignInChina.facets.countries.CN, 1);
  assert.equal(foreignInChina.facets.countries.DE, undefined);
  assert.equal(foreignInChina.items[0]!.sources[0]!.label, "Synthetic source-a");
  assert.equal(foreignInChina.items[0]!.sources[0]!.url, "https://careers.example.test/jobs/german-shanghai");
  const unknownOwnership = await queryJobs(dataset, { ownershipKinds: ["unknown"] }, OPTIONS);
  assert.deepEqual(ids(unknownOwnership), ["job-unverified-german"]);
});

test("controller-origin facets and unknown filtering stay independent from work-country facets", async () => {
  const dataset = datasetFor([
    { id: "german-china", companyCountry: "DE", locations: [{ countryCode: "CN" }] },
    { id: "chinese-germany", companyCountry: "CN", locations: [{ countryCode: "DE" }] },
    { id: "unverified-german", companyCountry: "DE", companyVerified: false, locations: [{ countryCode: "CN" }] },
    { id: "unknown-origin", locations: [{ countryCode: "US" }] },
  ]);
  const result = await queryJobs(dataset, {}, OPTIONS);
  assert.deepEqual(result.facets.countries, { CN: 2, DE: 1, US: 1 });
  assert.deepEqual(result.facets.controllerJurisdictions, { CN: 1, DE: 1, unknown: 2 });
  const unknown = await queryJobs(dataset, { controllerJurisdictions: ["unknown"] }, OPTIONS);
  assert.deepEqual(ids(unknown), ["job-unknown-origin", "job-unverified-german"]);
  assert.deepEqual(unknown.facets.controllerJurisdictions, { unknown: 2 });
  assert.deepEqual(unknown.facets.countries, { US: 1, CN: 1 });
  const german = await queryJobs(dataset, { controllerJurisdictions: ["DE"] }, OPTIONS);
  assert.deepEqual(ids(german), ["job-german-china"]);
  assert.equal(german.facets.countries.CN, 1);
  assert.equal(german.facets.controllerJurisdictions.DE, 1);
  const invalid = (error: unknown) => error instanceof JobQueryError && error.code === "invalid-query";
  await assert.rejects(queryJobs(dataset, { controllerJurisdictions: ["de"] }, OPTIONS), invalid);
  await assert.rejects(queryJobs(dataset, { controllerJurisdictions: ["Germany"] }, OPTIONS), invalid);
  await assert.rejects(queryJobs(dataset, { ownershipKinds: ["foreign"] } as Parameters<typeof queryJobs>[1], OPTIONS), invalid);
});

test("a multi-country role appears once and shows only locations matching the work-region filter", async () => {
  const dataset = datasetFor([{ id: "multi", companyCountry: "US", locations: [
    { countryCode: "CN", city: "Shanghai", coordinates: point(31.2, 121.5) },
    { countryCode: "DE", city: "Berlin", coordinates: point(52.5, 13.4) },
  ] }]);
  const result = await queryJobs(dataset, { workRegionIds: ["CN"] }, OPTIONS);
  assert.equal(result.totalJobs, 1);
  assert.equal(result.locationPinCount, 1);
  assert.deepEqual(result.items[0]!.locations.map((location) => location.countryCode), ["CN"]);
  assert.deepEqual(Object.keys(result.facets.countries), ["CN"]);
});

test("country constraints AND region identifiers on the same office and preserve legacy region-only queries", async () => {
  const dataset = datasetFor([
    { id: "us-springfield", locations: [{ countryCode: "US", city: "Springfield" }] },
    { id: "au-springfield", locations: [{ countryCode: "AU", city: "Springfield" }] },
    { id: "crossed", locations: [{ countryCode: "US", city: "Seattle" }, { countryCode: "AU", city: "Springfield" }] },
    { id: "unknown-country", locations: [{ raw: "Springfield", city: "Springfield" }] },
    { id: "no-office" },
  ]);
  const filtered = await queryJobs(dataset, { workCountryCodes: ["US"], workRegionIds: ["Springfield"], includeUnknownLocations: true }, OPTIONS);
  assert.deepEqual(ids(filtered), ["job-us-springfield"]);
  assert.deepEqual(filtered.items[0]!.locations.map((location) => [location.countryCode, location.city]), [["US", "Springfield"]]);
  const countryOnly = await queryJobs(dataset, { workCountryCodes: ["US"], includeUnknownLocations: true }, OPTIONS);
  assert.deepEqual(ids(countryOnly), ["job-crossed", "job-us-springfield"]);
  assert.ok(countryOnly.items.every((item) => item.locations.every((location) => location.countryCode === "US")));
  const legacy = await queryJobs(dataset, { workRegionIds: ["US"] }, OPTIONS);
  assert.deepEqual(ids(legacy), ids(countryOnly), "existing exact country-in-region callers remain supported");
  assert.deepEqual(ids(await queryJobs(dataset, { workCountryCodes: ["US", "AU"], workRegionIds: ["Springfield"] }, OPTIONS)), ["job-au-springfield", "job-crossed", "job-us-springfield"]);
});

test("region free text is a literal normalized substring of source place text without coordinates or administrative inference", async () => {
  const dataset = datasetFor([
    { id: "beijing", locations: [{ countryCode: "CN", raw: "中国 · 北京市海淀区", precision: "unknown" }] },
    { id: "shenzhen", locations: [{ countryCode: "CN", raw: "China / Shenzhen", city: "Shenzhen", precision: "city" }] },
    { id: "crossed", locations: [{ countryCode: "CN", city: "上海" }, { countryCode: "US", city: "北京" }] },
    { id: "raw-unknown", locations: [{ raw: "北京", city: "北京", precision: "unknown" }] },
    { id: "no-office" },
  ]);
  const local = await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionText: "北京", includeUnknownLocations: true }, OPTIONS);
  assert.deepEqual(ids(local), ["job-beijing"]);
  assert.equal(local.mappedJobs, 0);
  assert.equal(local.unlocatedJobs, 1, "place-text filtering does not manufacture a map point");
  assert.deepEqual(ids(await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionText: "  ＳＨＥＮＺＨＥＮ  " }, OPTIONS)), ["job-shenzhen"]);
  assert.deepEqual(ids(await queryJobs(dataset, { workRegionText: "北京" }, OPTIONS)), ["job-beijing", "job-crossed", "job-raw-unknown"]);
  assert.equal((await queryJobs(dataset, { workRegionText: ".*" }, OPTIONS)).totalJobs, 0, "text is not an executable regular expression");
  assert.equal((await queryJobs(dataset, { workRegionIds: ["北京"] }, OPTIONS)).items.some((item) => item.job.id === "job-beijing"), false, "predefined identifiers retain exact semantics");
  assert.equal((await queryJobs(dataset, { workRegionIds: ["CN-GD"], workCountryCodes: ["CN"] }, OPTIONS)).totalJobs, 0, "city text does not assert its province's identifier");
  assert.equal((await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionIds: ["Shenzhen"], workRegionText: "北京" }, OPTIONS)).totalJobs, 0, "country, exact region and text are separate AND constraints");
});

test("country and region text are validated query fields and participate in cursor identity", async () => {
  const dataset = datasetFor([
    { id: "one", locations: [{ countryCode: "US", city: "Springfield" }] },
    { id: "two", locations: [{ countryCode: "US", city: "Springfield" }] },
  ]);
  const query = { workCountryCodes: ["US"], workRegionText: "Spring", page: { limit: 1 } };
  const first = await queryJobs(dataset, query, OPTIONS);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.normalizedQuery.workCountryCodes, ["US"]);
  assert.equal(first.normalizedQuery.workRegionText, "Spring");
  const second = await queryJobs(dataset, { ...query, page: { limit: 1, cursor: first.nextCursor } }, OPTIONS);
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]!.job.id, first.items[0]!.job.id);
  const stale = (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor";
  await assert.rejects(queryJobs(dataset, { ...query, workCountryCodes: ["AU"], page: { limit: 1, cursor: first.nextCursor } }, OPTIONS), stale);
  await assert.rejects(queryJobs(dataset, { ...query, workRegionText: "Springfield", page: { limit: 1, cursor: first.nextCursor } }, OPTIONS), stale);
  const invalid = (error: unknown) => error instanceof JobQueryError && error.code === "invalid-query";
  for (const input of [{ workCountryCodes: ["us"] }, { workCountryCodes: ["中国"] }, { workRegionText: " " }, { workRegionText: "x".repeat(301) }]) {
    await assert.rejects(queryJobs(dataset, input, OPTIONS), invalid);
  }
});

test("explicit region alias groups OR their terms and AND province, city and district on one office", async () => {
  const dataset = datasetFor([
    { id: "guangzhou-tianhe", locations: [{ countryCode: "CN", region: "广东省", city: "广州市", raw: "天河区体育东路" }] },
    { id: "guangzhou-yuexiu", locations: [{ countryCode: "CN", region: "广东省", city: "Guangzhou", raw: "越秀区" }] },
    { id: "shenzhen", locations: [{ countryCode: "CN", city: "Shenzhen", raw: "南山区" }] },
    { id: "hangzhou", locations: [{ countryCode: "CN", region: "浙江省", city: "杭州市", raw: "西湖区" }] },
  ]);
  const province = ["广东省", "广东", "广州", "Guangzhou", "深圳", "Shenzhen"];
  const city = ["广州", "Guangzhou"];
  const district = ["天河区", "Tianhe"];
  const provinceResult = await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionGroups: [province] }, OPTIONS);
  assert.deepEqual(ids(provinceResult), ["job-guangzhou-tianhe", "job-guangzhou-yuexiu", "job-shenzhen"]);
  assert.deepEqual(ids(await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionGroups: [province, city] }, OPTIONS)), ["job-guangzhou-tianhe", "job-guangzhou-yuexiu"]);
  const precise = await queryJobs(dataset, { workCountryCodes: ["CN"], workRegionGroups: [province, city, district] }, OPTIONS);
  assert.deepEqual(ids(precise), ["job-guangzhou-tianhe"]);
  assert.equal(precise.mappedJobs, 0, "administrative text does not manufacture map points");
  assert.equal(precise.items[0]!.locations[0]!.coordinates, undefined);
});

test("region groups, exact identifiers, free text and country all constrain the same location", async () => {
  const dataset = datasetFor([
    { id: "matching", locations: [{ countryCode: "CN", regionId: "CN-GD", city: "广州", raw: "广东省广州市天河区珠江新城" }] },
    { id: "groups-crossed", locations: [
      { countryCode: "CN", regionId: "CN-GD", city: "广州", raw: "广东省广州市越秀区珠江新城" },
      { countryCode: "CN", regionId: "CN-GD", city: "深圳", raw: "广东省深圳市天河区珠江新城" },
    ] },
    { id: "country-crossed", locations: [
      { countryCode: "CN", regionId: "CN-GD", city: "广州", raw: "广东省广州市越秀区珠江新城" },
      { countryCode: "US", regionId: "CN-GD", city: "广州", raw: "广东省广州市天河区珠江新城" },
    ] },
    { id: "identifier-crossed", locations: [
      { countryCode: "CN", regionId: "CN-GD", city: "深圳", raw: "珠江新城" },
      { countryCode: "CN", regionId: "other-region", city: "广州", raw: "广东省广州市天河区珠江新城" },
    ] },
    { id: "text-crossed", locations: [
      { countryCode: "CN", regionId: "CN-GD", city: "广州", raw: "广东省广州市天河区" },
      { countryCode: "CN", regionId: "CN-GD", city: "深圳", raw: "珠江新城" },
    ] },
  ]);
  const result = await queryJobs(dataset, {
    workCountryCodes: ["CN"], workRegionIds: ["CN-GD"], workRegionText: "珠江新城",
    workRegionGroups: [["广东", "深圳"], ["广州"], ["天河"]], includeUnknownLocations: true,
  }, OPTIONS);
  assert.deepEqual(ids(result), ["job-matching"]);
  assert.equal(result.items[0]!.locations.length, 1);
  assert.deepEqual(result.facets.countries, { CN: 1 });
});

test("region group terms normalize case, width and whitespace but never join fields or execute regex", async () => {
  const dataset = datasetFor([
    { id: "literal", locations: [{ countryCode: "CN", region: "Guangdong", city: "Guangzhou", regionId: "CN-GD", raw: "Tianhe   District .*" }] },
    { id: "cross-field", locations: [{ countryCode: "CN", region: "Guangdong", city: "Tianhe", raw: "Unrelated office" }] },
    { id: "near-spelling", locations: [{ countryCode: "CN", city: "Guangzhuo", raw: "Tianhe District" }] },
  ]);
  assert.deepEqual(ids(await queryJobs(dataset, { workRegionGroups: [["  ＧＵＡＮＧＺＨＯＵ  "], [" tianhe district "], ["cn-gd"]] }, OPTIONS)), ["job-literal"]);
  assert.deepEqual(ids(await queryJobs(dataset, { workRegionGroups: [[".*"]] }, OPTIONS)), ["job-literal"]);
  assert.deepEqual(ids(await queryJobs(dataset, { workRegionGroups: [["Guangdong Tianhe"]] }, OPTIONS)), [], "a term must fit inside one source field");
  assert.deepEqual(ids(await queryJobs(dataset, { workRegionGroups: [["Guangzhou"]] }, OPTIONS)), ["job-literal"], "groups do not use typo matching");
});

test("missing and empty region groups preserve existing unknown-location behavior without mutating input", async () => {
  const dataset = datasetFor([
    { id: "unknown-country", locations: [{ raw: "广东省广州市天河区", precision: "unknown" }] },
    { id: "no-location" },
    { id: "different", locations: [{ countryCode: "CN", city: "北京" }] },
  ]);
  const before = structuredClone(dataset);
  const query = { workRegionGroups: [[" 广东 ", "广州"], [" 天河区 "]], includeUnknownLocations: true };
  const queryBefore = structuredClone(query);
  const noGroups = await queryJobs(dataset, {}, OPTIONS);
  const emptyGroups = await queryJobs(dataset, { workRegionGroups: [] }, OPTIONS);
  assert.deepEqual(ids(emptyGroups), ids(noGroups));
  const filtered = await queryJobs(dataset, query, OPTIONS);
  assert.deepEqual(ids(filtered), ["job-unknown-country"]);
  assert.deepEqual(filtered.normalizedQuery.workRegionGroups, [["广东", "广州"], ["天河区"]]);
  assert.equal((await queryJobs(dataset, { ...query, workCountryCodes: ["CN"] }, OPTIONS)).totalJobs, 0, "a text match does not infer missing country evidence");
  assert.deepEqual(dataset, before);
  assert.deepEqual(query, queryBefore);
});

test("region groups accept three bounded alias groups and reject malformed or oversized input", async () => {
  const dataset = datasetFor([{ id: "one", locations: [{ countryCode: "CN", city: "广州" }] }]);
  const maximum = Array.from({ length: 3 }, () => Array.from({ length: 500 }, () => "x".repeat(300)));
  assert.equal((await queryJobs(dataset, { workRegionGroups: maximum }, OPTIONS)).totalJobs, 0);
  const invalid = (error: unknown) => error instanceof JobQueryError && error.code === "invalid-query";
  for (const groups of [
    [["a"], ["b"], ["c"], ["d"]], [Array(501).fill("x")], [["x".repeat(301)]],
    [[]], [[" "]], ["广州"], [[123]], null,
  ]) {
    await assert.rejects(queryJobs(dataset, { workRegionGroups: groups } as Parameters<typeof queryJobs>[1], OPTIONS), invalid);
  }
});

test("region group filters participate in cursor identity and unchanged groups preserve pagination", async () => {
  const dataset = datasetFor([
    { id: "one", locations: [{ countryCode: "CN", city: "广州", raw: "广东省广州市天河区" }] },
    { id: "two", locations: [{ countryCode: "CN", city: "广州", raw: "广东省广州市天河区" }] },
  ]);
  const query = { workCountryCodes: ["CN"], workRegionGroups: [["广东", "广州"], ["天河"]], page: { limit: 1 } };
  const first = await queryJobs(dataset, query, OPTIONS);
  assert.ok(first.nextCursor);
  const second = await queryJobs(dataset, { ...query, page: { limit: 1, cursor: first.nextCursor } }, OPTIONS);
  assert.equal(second.totalJobs, 2);
  assert.notEqual(first.items[0]!.job.id, second.items[0]!.job.id);
  const stale = (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor";
  for (const groups of [[["广东", "深圳"], ["天河"]], [["广东", "广州"], ["天河区"]], [["广东", "广州"]], []]) {
    await assert.rejects(queryJobs(dataset, { ...query, workRegionGroups: groups, page: { limit: 1, cursor: first.nextCursor } }, OPTIONS), stale);
  }
  const unrestricted = await queryJobs(dataset, { page: { limit: 1 } }, OPTIONS);
  await assert.rejects(queryJobs(dataset, { ...query, page: { limit: 1, cursor: unrestricted.nextCursor } }, OPTIONS), stale);
});

test("technical keyword normalization preserves C++, C# and .NET and handles bounded typos", async () => {
  const dataset = datasetFor([
    { id: "cpp", title: "C++ Engineer", description: "Modern C++ applications." },
    { id: "dotnet", title: "ASP.NET Core Engineer", description: "C# backend services." },
    { id: "c-only", title: "C developer", description: "Embedded C language work." },
    { id: "unrelated", title: "Accountant", description: "Financial reporting." },
  ]);
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "Ｃ＋＋", mode: "fuzzy" } }, OPTIONS)), ["job-cpp"]);
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: ".NET", mode: "fuzzy" } }, OPTIONS)), ["job-dotnet"]);
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "C#", mode: "fuzzy" } }, OPTIONS)), ["job-dotnet"]);
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "C++ engnieer", mode: "fuzzy" } }, OPTIONS)), ["job-cpp"]);
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "C++ engnieer", mode: "exact" } }, OPTIONS)), []);
  assert.equal(normalizeSearchText("  Ｃ＋＋ / .NET / C# "), "cpp dotnet csharp");
});

test("symbol-bearing technology terms remain exact semantic tokens even when ordinary words use fuzzy matching", async () => {
  const dataset = datasetFor([
    { id: "csharp", title: "精通Ｃ＃后端工程师", description: "开发服务" },
    { id: "csharp-name", title: "CSharp engineer", description: "Build services" },
    { id: "cpp", title: "熟悉C++17开发", description: "开发服务" },
    { id: "dotnet", title: "ASP.NET Core Engineer", description: "开发服务" },
    { id: "dotnet-version", title: ".NET8后端开发", description: "开发服务" },
    { id: "c-product", title: "C端产品经理", description: "面向消费者的产品" },
    { id: "c-only", title: "C developer", description: "Embedded language" },
    { id: "sharp", title: "Sharp designer", description: "Visual design" },
    { id: "csharpener", title: "CSharpener operator", description: "Operations" },
    { id: "cppcheck", title: "Cppcheck maintainer", description: "Static analyzer" },
    { id: "dotne", title: "Dotne specialist", description: "Synthetic near spelling" },
    { id: "domain", title: "Network operator", description: "Operate example.net website" },
  ]);
  for (const mode of ["fuzzy", "exact"] as const) {
    assert.deepEqual(new Set(ids(await queryJobs(dataset, { search: { text: "C#", mode } }, OPTIONS))), new Set(["job-csharp", "job-csharp-name"]));
    assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "Ｃ＋＋", mode } }, OPTIONS)), ["job-cpp"]);
    assert.deepEqual(new Set(ids(await queryJobs(dataset, { search: { text: ".NET", mode } }, OPTIONS))), new Set(["job-dotnet", "job-dotnet-version"]));
  }
  assert.deepEqual(ids(await queryJobs(dataset, { search: { text: "C# engnieer", mode: "fuzzy" } }, OPTIONS)), ["job-csharp-name"]);
  assert.equal(includesSearchText("C# / .NET8 developer", "C#"), true);
  assert.equal(includesSearchText("熟悉C++17开发", "C++"), true);
  assert.equal(includesSearchText("VB.NET developer", ".NET"), true);
  for (const [haystack, term] of [["C端产品经理", "C#"], ["C developer", "C#"], ["CSharpener", "C#"], ["Cppcheck", "C++"], ["sharp", "C#"], ["dotne", ".NET"], ["example.net", ".NET"], ["C#", "sharp"], ["C++", "C"]]) {
    assert.equal(includesSearchText(haystack!, term!), false, `${term} must not match ${haystack}`);
  }
  assert.equal(includesSearchText("上海自动化开发工程师", "自动化"), true);
  assert.equal(includesSearchText("Industrial automation engineer", "automation"), true);
  assert.equal(includesSearchText("C# services and CSharpener", "C# services"), true);
  assert.equal(includesSearchText("CSharpener services", "C# services"), false);
  assert.equal(normalizeSearchText("ABC# ABC++ example.net ASP.NET8 Ｃ＃ Ｃ＋＋"), "abc abc example net asp dotnet 8 csharp cpp");
  const ordinary = datasetFor([
    { id: "chinese", title: "工业自动化工程师", description: "设备研发" },
    { id: "english", title: "Industrial automation engineer", description: "Factory systems" },
  ]);
  assert.deepEqual(ids(await queryJobs(ordinary, { search: { text: "自动化开", mode: "fuzzy" } }, OPTIONS)), ["job-chinese"]);
  assert.deepEqual(ids(await queryJobs(ordinary, { search: { text: "automtaion", mode: "fuzzy" } }, OPTIONS)), ["job-english"]);
});

test("query aliases can find a role without changing its original text", async () => {
  const dataset = datasetFor([{ id: "automation", title: "Industrial automation engineer" }]);
  const input = { search: { text: "自动化", mode: "fuzzy" as const } };
  assert.equal((await queryJobs(dataset, input, OPTIONS)).totalJobs, 0);
  const result = await queryJobs(dataset, input, { ...OPTIONS, aliases: { 自动化: ["automation"] } });
  assert.deepEqual(ids(result), ["job-automation"]);
  assert.equal(result.items[0]!.job.title.value, "Industrial automation engineer");
  assert.ok(result.items[0]!.matchedFields.includes("title"));
});

test("salary ascending and descending use CNY annual fixed cash and leave unknowns last", async () => {
  const dataset = datasetFor([
    { id: "low", salary: { min: 100_000, max: 150_000 } },
    { id: "high", salary: { min: 200_000, max: 300_000 } },
    { id: "usd", salary: { currency: "USD", min: 10_000, max: 20_000 } },
    { id: "unknown" },
    { id: "net", salary: { tax: "net", min: 900_000, max: 1_000_000 } },
  ]);
  const options = { ...OPTIONS, fx: { id: "synthetic-fx", provider: "Synthetic rate fixture", date: "2026-10-18", ratesToCny: { USD: 7, CNY: 1 } } };
  const asc = await queryJobs(dataset, { sort: { field: "salary", direction: "asc" } }, options);
  const desc = await queryJobs(dataset, { sort: { field: "salary", direction: "desc" } }, options);
  assert.deepEqual(ids(asc).slice(0, 3), ["job-usd", "job-low", "job-high"]);
  assert.deepEqual(ids(desc).slice(0, 3), ["job-high", "job-low", "job-usd"]);
  assert.deepEqual(new Set(ids(asc).slice(3)), new Set(["job-net", "job-unknown"]));
  assert.deepEqual(ids(asc).slice(3), ids(desc).slice(3));
  assert.equal(asc.unknownSalaryCount, 2);
  assert.equal(desc.items.find((item) => item.job.id === "job-usd")!.salaryCny, 70_000);
  assert.equal(desc.items.find((item) => item.job.id === "job-usd")!.salary!.originalAnnual!.currency, "USD");
  const knownOnly = await queryJobs(dataset, { salary: { includeUnknown: false } }, options);
  assert.equal(knownOnly.totalJobs, 3);
});

test("salary ranges and explicit annualization estimates are independently configurable", async () => {
  const dataset = datasetFor([
    { id: "monthly", salary: { period: "month", min: 10_000, max: 15_000 } },
    { id: "thirteen", salary: { period: "month", min: 10_000, max: 15_000, monthsPerYear: 13 } },
    { id: "outside", salary: { min: 300_000, max: 400_000 } },
    { id: "unknown" },
  ]);
  const range = { min: 125_000, max: 160_000 };
  const estimates = await queryJobs(dataset, { salary: { range, rangeMode: "overlap", includeEstimates: true, includeUnknown: false } }, OPTIONS);
  assert.deepEqual(ids(estimates), ["job-monthly", "job-thirteen"]);
  assert.equal(estimates.items.find((item) => item.job.id === "job-monthly")!.salary!.estimated, true);
  assert.deepEqual(estimates.items.find((item) => item.job.id === "job-monthly")!.salary!.assumptions, ["monthly-base-times-12"]);
  const disclosedOnly = await queryJobs(dataset, { salary: { range, rangeMode: "overlap", includeEstimates: false, includeUnknown: false } }, OPTIONS);
  assert.deepEqual(ids(disclosedOnly), ["job-thirteen"]);
});

test("equivalent salary disclosures are reproducible while conflicting candidates remain visible and unsorted", async () => {
  const dataset = datasetFor([{ id: "one", salary: { min: 100_000, max: 120_000 } }]);
  const duplicate = { ...structuredClone(dataset.compensations[0]!), id: "salary-one-second" };
  dataset.compensations.push(duplicate);
  dataset.jobs[0]!.compensationIds.push(duplicate.id);
  const equivalent = (await queryJobs(dataset, {}, OPTIONS)).items[0]!;
  assert.equal(equivalent.salarySelection, "equivalent");
  assert.equal(equivalent.salaryCny, 100_000);
  assert.equal(equivalent.salaryCandidates.length, 2);
  dataset.jobs[0]!.compensationIds.reverse();
  const reversed = (await queryJobs(dataset, {}, OPTIONS)).items[0]!;
  assert.equal(reversed.salary!.compensationId, equivalent.salary!.compensationId);
  assert.equal(reversed.salaryCny, equivalent.salaryCny);
  duplicate.min = 200_000;
  duplicate.max = 240_000;
  const conflicted = await queryJobs(dataset, {}, OPTIONS);
  assert.equal(conflicted.items[0]!.salarySelection, "ambiguous");
  assert.equal(conflicted.items[0]!.salaryCandidates.length, 2);
  assert.equal(conflicted.items[0]!.salary, undefined);
  assert.equal(conflicted.items[0]!.salaryCny, undefined);
  assert.equal(conflicted.unknownSalaryCount, 1);
  assert.equal((await queryJobs(dataset, { salary: { includeUnknown: false } }, OPTIONS)).totalJobs, 0);
});

test("salary candidates preserve unsupported compensation instead of adding bonus into fixed cash", async () => {
  const dataset = datasetFor([{ id: "one", salary: { min: 100_000, max: 120_000 } }]);
  const bonus = { ...structuredClone(dataset.compensations[0]!), id: "salary-bonus", kind: "bonus" as const, min: 900_000, max: 1_000_000 };
  dataset.compensations.push(bonus);
  dataset.jobs[0]!.compensationIds.push(bonus.id);
  const item = (await queryJobs(dataset, {}, OPTIONS)).items[0]!;
  assert.equal(item.salarySelection, "single");
  assert.equal(item.salaryCny, 100_000);
  assert.equal(item.salaryCandidates.length, 2);
  assert.equal(item.salaryCandidates.find((candidate) => candidate.compensationId === bonus.id)!.reason, "not-base-salary");
});

test("work-region filtering selects only salaries explicitly bound to matching job offices", async () => {
  const dataset = datasetFor([{ id: "multi", locations: [
    { id: "office-cn", countryCode: "CN", city: "Shanghai", coordinates: point(31.2, 121.5) },
    { id: "office-de", countryCode: "DE", city: "Berlin", coordinates: point(52.5, 13.4) },
  ], salary: { min: 100_000, max: 120_000, locationIds: ["office-cn"] } }]);
  const germanSalary = { ...structuredClone(dataset.compensations[0]!), id: "salary-germany", currency: "EUR", min: 50_000, max: 60_000, locationIds: ["office-de"] };
  dataset.compensations.push(germanSalary);
  dataset.jobs[0]!.compensationIds.push(germanSalary.id);
  const options = { ...OPTIONS, fx: { id: "fx-eur", provider: "Synthetic FX", date: "2026-10-18", ratesToCny: { EUR: 8 } } };
  const all = (await queryJobs(dataset, {}, options)).items[0]!;
  assert.equal(all.salarySelection, "ambiguous");
  assert.equal(all.salaryCny, undefined);
  const china = (await queryJobs(dataset, { workRegionIds: ["CN"] }, options)).items[0]!;
  assert.equal(china.salarySelection, "single");
  assert.equal(china.salaryLocationScope, "bound");
  assert.equal(china.salaryCny, 100_000);
  assert.equal(china.salaryCandidates.length, 1);
  assert.deepEqual(china.salaryCandidates[0]!.locationIds, ["office-cn"]);
  const germany = (await queryJobs(dataset, { workRegionIds: ["DE"] }, options)).items[0]!;
  assert.equal(germany.salaryCny, 400_000);
  assert.deepEqual(germany.salaryCandidates[0]!.locationIds, ["office-de"]);
  delete dataset.compensations[0]!.locationIds;
  const unscoped = (await queryJobs(dataset, { workRegionIds: ["DE"] }, options)).items[0]!;
  assert.equal(unscoped.salaryLocationScope, "unscoped");
  assert.equal(unscoped.salarySelection, "ambiguous");
});

test("salary-office bindings cannot refer to an office outside the associated job", async () => {
  const dataset = datasetFor([
    { id: "one", locations: [{ id: "office-one", countryCode: "CN" }], salary: { locationIds: ["office-one"] } },
    { id: "two", locations: [{ id: "office-two", countryCode: "DE" }] },
  ]);
  dataset.compensations[0]!.locationIds = ["office-two"];
  assert.equal(AtlasDatasetSchema.safeParse(dataset).success, false);
  await assert.rejects(queryJobs(dataset, {}, OPTIONS));
});

test("one-sided salary overlap separates proven matches, proven exclusions and unknown comparisons", async () => {
  const dataset = datasetFor([
    { id: "upper-inside", salary: { min: undefined, max: 150_000 } },
    { id: "lower-inside", salary: { min: 150_000, max: undefined } },
    { id: "lower-above", salary: { min: 250_000, max: undefined } },
    { id: "upper-below", salary: { min: undefined, max: 50_000 } },
    { id: "lower-below", salary: { min: 50_000, max: undefined } },
    { id: "upper-above", salary: { min: undefined, max: 250_000 } },
  ]);
  const range = { min: 100_000, max: 200_000 };
  const proven = await queryJobs(dataset, { salary: { range, rangeMode: "overlap", includeUnknown: false } }, OPTIONS);
  assert.deepEqual(ids(proven), ["job-lower-inside", "job-upper-inside"]);
  const unknownAllowed = await queryJobs(dataset, { salary: { range, rangeMode: "overlap", includeUnknown: true } }, OPTIONS);
  assert.deepEqual(ids(unknownAllowed), ["job-lower-below", "job-lower-inside", "job-upper-above", "job-upper-inside"]);
  assert.equal(unknownAllowed.items.find((item) => item.job.id === "job-upper-inside")!.salaryCny, undefined, "An upper-only disclosure does not manufacture a lower sorting value.");
});

test("one-sided salary containment never admits a known endpoint outside the requested interval", async () => {
  const dataset = datasetFor([
    { id: "upper-inside", salary: { min: undefined, max: 150_000 } },
    { id: "lower-inside", salary: { min: 150_000, max: undefined } },
    { id: "lower-above", salary: { min: 250_000, max: undefined } },
    { id: "upper-below", salary: { min: undefined, max: 50_000 } },
    { id: "lower-below", salary: { min: 50_000, max: undefined } },
    { id: "upper-above", salary: { min: undefined, max: 250_000 } },
    { id: "complete", salary: { min: 120_000, max: 180_000 } },
  ]);
  const range = { min: 100_000, max: 200_000 };
  const proven = await queryJobs(dataset, { salary: { range, rangeMode: "contained", includeUnknown: false } }, OPTIONS);
  assert.deepEqual(ids(proven), ["job-complete"]);
  const unknownAllowed = await queryJobs(dataset, { salary: { range, rangeMode: "contained", includeUnknown: true } }, OPTIONS);
  assert.deepEqual(ids(unknownAllowed), ["job-complete", "job-lower-inside", "job-upper-inside"]);
  const onlyLowerBound = await queryJobs(dataset, { salary: { range: { min: 100_000 }, rangeMode: "contained", includeUnknown: false } }, OPTIONS);
  assert.deepEqual(ids(onlyLowerBound), ["job-complete", "job-lower-above", "job-lower-inside"]);
});

test("city-level distance requires explicit estimates and radius filters use nearest usable office", async () => {
  const dataset = datasetFor([
    { id: "near", locations: [{ countryCode: "CN", coordinates: point(11.1, 22.1) }, { countryCode: "CN", coordinates: point(11.1, 26) }] },
    { id: "city", locations: [{ countryCode: "CN", city: "Synthetic city", coordinates: point(11.1, 22.5), precision: "city" }] },
    { id: "far", locations: [{ countryCode: "CN", coordinates: point(11.1, 25) }] },
    { id: "unknown" },
  ]);
  const anchor = { ref: "private-anchor-v1", ...point(11.123456789, 21.987654321) };
  const opts = { ...OPTIONS, anchor };
  const base = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, includeUnknown: true }, sort: { field: "distance", direction: "asc" } }, opts);
  assert.equal(base.items.find((item) => item.job.id === "job-city")!.distance, undefined);
  assert.equal(base.items.find((item) => item.job.id === "job-near")!.distance!.estimated, false);
  assert.ok(base.items.find((item) => item.job.id === "job-near")!.distance!.km < 20);
  const exactOnly = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, maxKm: 150, includeUnknown: false } }, opts);
  assert.deepEqual(ids(exactOnly), ["job-near"]);
  const withEstimates = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, maxKm: 150, allowCityEstimate: true, includeUnknown: false }, sort: { field: "distance", direction: "asc" } }, opts);
  assert.deepEqual(ids(withEstimates), ["job-near", "job-city"]);
  assert.equal(withEstimates.items[1]!.distance!.estimated, true);
  const serialized = JSON.stringify(withEstimates);
  assert.equal(serialized.includes(String(anchor.latitude)), false);
  assert.equal(serialized.includes(String(anchor.longitude)), false);
  assert.equal(serialized.includes('"anchor":'), false);
  assert.equal(withEstimates.normalizedQuery.distance!.anchorRef, anchor.ref);
});

test("radius filters job locations, map pins and office-bound salary candidates together", async () => {
  const dataset = datasetFor([
    { id: "multi", locations: [
      { id: "office-near", countryCode: "CN", city: "Synthetic near office", coordinates: point(0, 0.01) },
      { id: "office-far", countryCode: "US", city: "Synthetic far office", coordinates: point(0, 10) },
    ], salary: { min: 100_000, max: 120_000, locationIds: ["office-near"] } },
    { id: "far-only", locations: [{ coordinates: point(0, 10), countryCode: "US" }] },
  ]);
  const farSalary = { ...structuredClone(dataset.compensations[0]!), id: "salary-far-office", min: 1_000_000, max: 1_200_000, locationIds: ["office-far"] };
  dataset.compensations.push(farSalary);
  dataset.jobs[0]!.compensationIds.push(farSalary.id);
  const unrestricted = await queryJobs(dataset, {}, OPTIONS);
  assert.equal(unrestricted.items.find((item) => item.job.id === "job-multi")!.salarySelection, "ambiguous");
  const anchor = { ref: "synthetic-radius-anchor", ...point(0, 0) };
  const result = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, maxKm: 10, includeUnknown: false }, mapLevel: "location" }, { ...OPTIONS, anchor });
  assert.deepEqual(ids(result), ["job-multi"]);
  assert.equal(result.totalJobs, 1);
  assert.equal(result.mappedJobs, 1);
  assert.equal(result.locationPinCount, 1);
  assert.deepEqual(result.items[0]!.locations.map((location) => location.id), ["office-near"]);
  assert.deepEqual(result.mapBuckets.flatMap((bucket) => bucket.locationIds), ["office-near"]);
  assert.deepEqual(result.facets.countries, { CN: 1 });
  assert.equal(result.items[0]!.salarySelection, "single");
  assert.equal(result.items[0]!.salaryLocationScope, "bound");
  assert.equal(result.items[0]!.salaryCny, 100_000);
  assert.deepEqual(result.items[0]!.salaryCandidates.map((candidate) => candidate.compensationId), ["salary-multi"]);
});

test("distance unknowns stay last in both directions and missing or stale anchors are rejected", async () => {
  const dataset = datasetFor([
    { id: "near", locations: [{ coordinates: point(0, 1), countryCode: "CN" }] },
    { id: "far", locations: [{ coordinates: point(0, 3), countryCode: "CN" }] },
    { id: "unknown" },
  ]);
  const anchor = { ref: "private-reference-v1", ...point(0, 0) };
  for (const [direction, expected] of [["asc", ["job-near", "job-far", "job-unknown"]], ["desc", ["job-far", "job-near", "job-unknown"]]] as const) {
    const result = await queryJobs(dataset, { distance: { anchorRef: anchor.ref, includeUnknown: true }, sort: { field: "distance", direction } }, { ...OPTIONS, anchor });
    assert.deepEqual(ids(result), [...expected]);
    assert.equal(result.unknownDistanceCount, 1);
  }
  const isAnchorError = (error: unknown) => error instanceof JobQueryError && error.code === "anchor-required";
  await assert.rejects(queryJobs(dataset, { distance: { anchorRef: anchor.ref } }, OPTIONS), isAnchorError);
  await assert.rejects(queryJobs(dataset, { distance: { anchorRef: "stale-ref" } }, { ...OPTIONS, anchor }), isAnchorError);
});

test("viewport filtering is explicit and handles bounding boxes across the date line", async () => {
  const dataset = datasetFor([
    { id: "east", locations: [{ countryCode: "FJ", coordinates: point(0, 179) }] },
    { id: "west", locations: [{ countryCode: "FJ", coordinates: point(0, -179) }] },
    { id: "east-edge", locations: [{ countryCode: "FJ", coordinates: point(0, 170) }] },
    { id: "west-edge", locations: [{ countryCode: "FJ", coordinates: point(0, -170) }] },
    { id: "middle", locations: [{ countryCode: "GB", coordinates: point(0, 0) }] },
    { id: "latitude-outside", locations: [{ countryCode: "FJ", coordinates: point(40, 179) }] },
    { id: "unlocated" },
  ]);
  const bounds: [number, number, number, number] = [170, -20, -170, 20];
  const inactive = await queryJobs(dataset, { viewport: { enabled: false, bounds } }, OPTIONS);
  assert.equal(inactive.totalJobs, 7);
  const active = await queryJobs(dataset, { viewport: { enabled: true, bounds }, mapLevel: "country" }, OPTIONS);
  assert.deepEqual(ids(active), ["job-east", "job-east-edge", "job-west", "job-west-edge"]);
  assert.equal(active.totalJobs, 4);
  assert.equal(active.locationPinCount, 4);
  assert.ok(Math.abs(active.mapBuckets[0]!.longitude) > 170, "A dateline cluster must not be centered on Greenwich.");
});

test("stable cursors exhaust a snapshot without repeats while map and counts remain unchanged", async () => {
  const dataset = datasetFor(Array.from({ length: 7 }, (_, index) => ({ id: `role-${index}`, locations: [{ countryCode: "CN", city: "Synthetic city", coordinates: point(30, 120 + index / 100) }] })));
  const first = await queryJobs(dataset, { page: { limit: 2 } }, OPTIONS);
  const collected = [...ids(first)];
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const next = await queryJobs(dataset, { page: { limit: 2, cursor } }, OPTIONS);
    assert.equal(next.queryId, first.queryId);
    assert.equal(next.asOf, EVALUATION_DAY);
    assert.equal(next.totalJobs, first.totalJobs);
    assert.deepEqual(next.mapBuckets, first.mapBuckets);
    collected.push(...ids(next));
    cursor = next.nextCursor;
    assert.ok(++pages <= 4, "Pagination must terminate.");
  }
  assert.equal(pages, 4);
  assert.equal(collected.length, 7);
  assert.equal(new Set(collected).size, 7);
  assert.deepEqual(collected, [...collected].sort());
});

test("cursor reuse rejects changed query, page size, dataset version and malformed cursors", async () => {
  const dataset = datasetFor([{ id: "one" }, { id: "two" }, { id: "three" }]);
  const first = await queryJobs(dataset, { page: { limit: 1 } }, OPTIONS);
  assert.ok(first.nextCursor);
  const isStale = (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor";
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor }, search: { text: "one" } }, OPTIONS), isStale);
  await assert.rejects(queryJobs(dataset, { page: { limit: 2, cursor: first.nextCursor } }, OPTIONS), isStale);
  await assert.rejects(queryJobs({ ...dataset, revision: dataset.revision + 1 }, { page: { limit: 1, cursor: first.nextCursor } }, OPTIONS), isStale);
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: "malformed-cursor" } }, OPTIONS), isStale);
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: `${first.queryId}:not-a-number` } }, OPTIONS), isStale);
});

test("query identity tracks comparison inputs and the explicit evaluation date", async () => {
  const dataset = datasetFor([{ id: "one" }, { id: "two" }]);
  const fx = { id: "synthetic-fx", provider: "Synthetic FX", date: "2026-10-18", ratesToCny: { USD: 7 } };
  const first = await queryJobs(dataset, { page: { limit: 1 } }, { ...OPTIONS, fx });
  const isStale = (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor";
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { ...OPTIONS, fx: { ...fx, ratesToCny: { USD: 6 } } }), isStale);
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { now: "2026-10-19T12:00:00.000Z", fx }), isStale);
});

test("evaluation days normalize timestamp offsets to UTC and preserve same-day cursor reuse", async () => {
  const dataset = datasetFor([{ id: "one" }, { id: "two" }]);
  const first = await queryJobs(dataset, { page: { limit: 1 } }, OPTIONS);
  const sameUtcDay = await queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { now: "2026-10-19T00:30:00+08:00" });
  assert.equal(sameUtcDay.asOf, EVALUATION_DAY);
  assert.equal(sameUtcDay.queryId, first.queryId);
  assert.equal(sameUtcDay.items.length, 1);
  assert.notEqual(sameUtcDay.items[0]!.job.id, first.items[0]!.job.id);
  const nextUtcDay = await queryJobs(dataset, { page: { limit: 1 } }, { now: "2026-10-18T23:30:00-04:00" });
  assert.equal(nextUtcDay.asOf, "2026-10-19T00:00:00.000Z");
  assert.notEqual(nextUtcDay.queryId, first.queryId);
  await assert.rejects(queryJobs(dataset, { page: { limit: 1, cursor: first.nextCursor } }, { now: "2026-10-18T23:30:00-04:00" }), (error: unknown) => error instanceof JobQueryError && error.code === "stale-cursor");
});

test("source coverage uses the latest observation per listing, allowing recovery after failure", async () => {
  const dataset = datasetFor([{ id: "one" }, { id: "two" }]);
  addObservation(dataset, "one", "old-failure", "failed", "2026-10-17T12:00:00.000Z");
  addObservation(dataset, "two", "old-partial", "partial", "2026-10-17T13:00:00.000Z");
  dataset.observations.reverse();
  const recovered = (await queryJobs(dataset, {}, OPTIONS)).sourceCoverage.find((value) => value.sourceId === "source-a")!;
  assert.equal(recovered.listings, 2);
  assert.equal(recovered.failed, false);
  assert.equal(recovered.partial, false);
  assert.equal(recovered.lastObservedAt, AS_OF);
  addObservation(dataset, "two", "latest-partial", "partial", "2026-10-19T11:00:00.000Z");
  const partial = (await queryJobs(dataset, {}, { now: "2026-10-19T11:30:00.000Z" })).sourceCoverage.find((value) => value.sourceId === "source-a")!;
  assert.equal(partial.partial, true);
  assert.equal(partial.failed, false);
  addObservation(dataset, "one", "latest-failure", "failed", "2026-10-19T12:00:00.000Z");
  addObservation(dataset, "two", "newer-success", "read", "2026-10-19T13:00:00.000Z");
  const partlyFailed = (await queryJobs(dataset, {}, { now: "2026-10-19T14:00:00.000Z" })).sourceCoverage.find((value) => value.sourceId === "source-a")!;
  assert.equal(partlyFailed.failed, true, "A newer successful listing must not hide a different listing's latest failure.");
  assert.equal(partlyFailed.partial, false);
  assert.equal(partlyFailed.lastObservedAt, "2026-10-19T13:00:00.000Z");
  addObservation(dataset, "one", "recovered", "read", "2026-10-20T12:00:00.000Z");
  const fullyRecovered = (await queryJobs(dataset, {}, { now: "2026-10-20T13:00:00.000Z" })).sourceCoverage.find((value) => value.sourceId === "source-a")!;
  assert.equal(fullyRecovered.failed, false);
  assert.equal(fullyRecovered.partial, false);
  addObservation(dataset, "one", "human-needed", "needs-human", "2026-10-20T14:00:00.000Z");
  const blocked = (await queryJobs(dataset, {}, { now: "2026-10-20T15:00:00.000Z" })).sourceCoverage.find((value) => value.sourceId === "source-a")!;
  assert.equal(blocked.needsHuman, true);
  assert.equal(blocked.failed, false);
});

test("query service and direct domain calls share the same authoritative result", async () => {
  const dataset = datasetFor([{ id: "one" }, { id: "two" }]);
  let reads = 0;
  const service = createJobQueryService({ readSnapshot: async () => { reads++; return structuredClone(dataset); } });
  const query = { page: { limit: 1 } };
  assert.deepEqual(await service.search(query, OPTIONS), await queryJobs(dataset, query, OPTIONS));
  assert.equal(reads, 1);
});
