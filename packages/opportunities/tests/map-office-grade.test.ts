import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, type AtlasDataset, type JobLocation } from "../src/schema.js";
import { queryJobs } from "../src/query.js";
import { JobQueryResultSchema } from "../src/query-output.js";

const now = "2026-10-19T12:00:00.000Z";
const point = (latitude: number, longitude: number) => ({ latitude, longitude, coordinateSystem: "WGS84" as const });

function office(id: string, latitude: number, longitude: number, street: string): JobLocation {
  return {
    id, raw: `Synthetic source ${street}`, kind: "office", countryCode: "CN", city: "Shanghai",
    streetAddress: street, precision: "address", verification: "unverified", provider: "manual-user-confirmation",
    coordinates: point(latitude, longitude), resolvedAt: now, evidence: [],
    officeResolution: {
      decisionId: `decision-${id}`, method: "manual-user-confirmation", at: now, originalLocationId: id,
      formattedAddress: `${street}, Shanghai`, streetAddress: street, coordinateMeaning: "building",
      evidenceUrl: "https://careers.example.test/office",
    },
  };
}

function dataset(locations: JobLocation[]): AtlasDataset {
  return AtlasDatasetSchema.parse({
    schemaVersion: 1, revision: 3, sources: [], compensations: [], listings: [], observations: [], snapshots: [],
    companies: [{ id: "company.one", names: ["Synthetic Company"], domains: [], parentCompanyIds: [], manualOverrides: [],
      ultimateControllers: { value: [], evidence: [], method: "manual", verification: "unverified", revision: 0 } }],
    locations,
    jobs: locations.map((location, index) => ({
      id: `job.${index}`, companyId: "company.one",
      title: { value: `Synthetic engineer ${index}`, evidence: [], method: "manual", verification: "unverified", revision: 0 },
      description: "Synthetic description", locationIds: [location.id], compensationIds: [], listingIds: [],
      workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "open", revision: 0, updatedAt: now,
    })),
  });
}

test("confirmed office coordinates stay separate building pins and a city centroid is not an office", async () => {
  const locations: JobLocation[] = [
    office("office.a", 31.23, 121.47, "Synthetic Road 10"),
    office("office.b", 31.11, 121.38, "Synthetic Road 80"),
    { id: "city.only", raw: "Shanghai", kind: "office", countryCode: "CN", city: "Shanghai", precision: "city", verification: "unverified", evidence: [], coordinates: point(31.2, 121.5) },
    { id: "street.text", raw: "Synthetic published street 4", kind: "office", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic published street 4", precision: "city", verification: "unverified", evidence: [] },
    { id: "street.point", raw: "Synthetic Street 2", kind: "office", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic Street 2", precision: "street", verification: "unverified", evidence: [], coordinates: point(31.18, 121.42) },
  ];
  const result = JobQueryResultSchema.parse(await queryJobs(dataset(locations), { mapLevel: "city" }, { now }));
  const buildings = result.mapBuckets.filter(bucket => bucket.displayGrade === "building");
  assert.equal(buildings.length, 2);
  assert.deepEqual(buildings.map(bucket => bucket.pinCount), [1, 1]);
  assert.ok(Math.abs(buildings[0]!.longitude - buildings[1]!.longitude) > 0.05);
  assert.ok(buildings.every(bucket => bucket.positionBasis === undefined && bucket.label.includes("Synthetic Road")));
  const street = result.mapBuckets.find(bucket => bucket.displayGrade === "street")!;
  assert.equal(street.pinCount, 1); assert.equal(street.latitude, 31.18);
  const city = result.mapBuckets.find(bucket => bucket.displayGrade === "city")!;
  assert.equal(city.label, "Shanghai"); assert.equal(city.pinCount, 1); assert.equal(city.positionBasis, undefined);
  assert.equal(result.locationPinCount, 4, "street text without coordinates does not invent a map point");
  assert.equal(result.mapBuckets.some(bucket => bucket.displayGrade === "building" && bucket.locationIds.includes("street.text")), false);
  assert.equal(result.mapBuckets.some(bucket => bucket.displayGrade === "building" && bucket.locationIds.includes("city.only")), false);
});

test("address coordinates stay distinct and keep their real address at every map aggregation level", async () => {
  const locations: JobLocation[] = [0, 1].map(index => ({
    id: `address.${index}`, raw: `Synthetic address ${index + 1}`, kind: "office" as const, countryCode: "CN", city: "Shanghai",
    streetAddress: `Synthetic Road ${10 + index * 10}`,
    precision: "address" as const, verification: "unverified" as const, evidence: [], coordinates: point(31.2 + index / 100, 121.4 + index / 100),
  })).concat([{ id: "city-coordinate", raw: "Shanghai", kind: "office", countryCode: "CN", city: "Shanghai", precision: "city", verification: "unverified", evidence: [], coordinates: point(31.25, 121.45) }]);
  const result = await queryJobs(dataset(locations), { mapLevel: "city" }, { now });
  const addressBuckets = result.mapBuckets.filter(bucket => bucket.displayGrade === "address");
  assert.equal(addressBuckets.length, 2);
  assert.ok(addressBuckets.every(bucket => bucket.pinCount === 1));
  assert.deepEqual(addressBuckets.map(bucket => bucket.label), ["Synthetic Road 10", "Synthetic Road 20"]);
  assert.equal(result.mapBuckets.filter(bucket => bucket.displayGrade === "city").length, 1, "a city coordinate cannot merge into or shift an address pin");
  assert.equal(result.mapBuckets.find(bucket => bucket.displayGrade === "city")!.label, "Shanghai");
  assert.ok(Math.abs(addressBuckets[0]!.longitude - addressBuckets[1]!.longitude) > 0.005);
  assert.ok(Math.abs(result.mapBuckets[0]!.longitude - result.mapBuckets[1]!.longitude) > 0.005);
  const located = await queryJobs(dataset(locations), { mapLevel: "location" }, { now });
  assert.equal(located.mapBuckets.length, 3);
  assert.deepEqual(located.mapBuckets.filter(bucket => bucket.displayGrade === "address").map(bucket => bucket.label), ["Synthetic Road 10", "Synthetic Road 20"]);
});

test("office confirmation meaning reaches map buckets without being generalized to a building", async () => {
  const locations: JobLocation[] = ["building", "entrance", "site"].map((coordinateMeaning, index) => ({
    ...office(`confirmed.${coordinateMeaning}`, 31.2 + index / 100, 121.4 + index / 100, `Synthetic address ${index}`),
    officeResolution: {
      ...office(`confirmed.${coordinateMeaning}`, 31.2 + index / 100, 121.4 + index / 100, `Synthetic address ${index}`).officeResolution!,
      coordinateMeaning: coordinateMeaning as "building" | "entrance" | "site",
    },
  }));
  const result = JobQueryResultSchema.parse(await queryJobs(dataset(locations), { mapLevel: "city" }, { now }));
  assert.deepEqual(result.mapBuckets.map(bucket => bucket.coordinateMeaning), ["building", "entrance", "site"]);
});
