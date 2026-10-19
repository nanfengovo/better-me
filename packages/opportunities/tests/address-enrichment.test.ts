import assert from "node:assert/strict";
import test from "node:test";
import { AddressEnrichmentPlanSchema, PlanAddressEnrichmentInputSchema, type AddressEnrichmentPlan, type JobLocation } from "../src/index.ts";

const source: JobLocation = { id: "location.one", raw: "Synthetic Road 10, Shanghai", countryCode: "CN", city: "Shanghai",
  streetAddress: "Synthetic Road 10", postalCode: "020000", kind: "office", precision: "city", verification: "unverified",
  evidence: [{ observationId: "observation.one", sourceUrl: "https://careers.example.test/jobs/one", observedAt: "2026-10-19T00:00:00Z", quote: "Synthetic Road 10" }] };
function result(): AddressEnrichmentPlan {
  return { schemaVersion: 1, snapshotRevision: 7, requestedJobs: 1, processedJobs: 1, truncated: false, warnings: [], items: [{
    jobId: "job.one", title: "Synthetic engineer", companyId: "company.one", companyName: "Synthetic employer", status: "source-street",
    currentOffice: [], pendingLocationIds: [source.id], sourceStreetTargets: [{ listingId: "listing.one", sourceId: "source.one", locationId: source.id,
      sourceUrl: "https://careers.example.test/jobs/one", sourceLocation: source }], exactPlatformTargets: [], ownedOfficialTargets: [],
    companyLookup: { companyName: "Synthetic employer", association: "unverified", strength: "weak" }, truncated: false, warnings: [],
  }] };
}

test("address planning requires an explicit bounded unique job subset and rejects private or executable configuration", () => {
  assert.deepEqual(PlanAddressEnrichmentInputSchema.parse({ jobIds: [], expectedRevision: 0 }), { jobIds: [], expectedRevision: 0 });
  assert.equal(PlanAddressEnrichmentInputSchema.safeParse({ jobIds: ["job.one", "job.one"], expectedRevision: 0 }).success, false);
  assert.equal(PlanAddressEnrichmentInputSchema.safeParse({ jobIds: Array.from({ length: 51 }, (_, index) => `job.${index}`), expectedRevision: 0 }).success, false);
  for (const extra of [{ query: "all jobs" }, { homeAddress: "PRIVATE_HOME" }, { providerUrl: "https://example.test" }, { script: "CODE" }]) {
    assert.equal(PlanAddressEnrichmentInputSchema.safeParse({ jobIds: ["job.one"], expectedRevision: 0, ...extra }).success, false);
  }
});

test("plan contracts distinguish a source street, user overlay, city coordinates and actual address-level offices", () => {
  const original = result(); assert.equal(AddressEnrichmentPlanSchema.safeParse(original).success, true);
  const mismatched = structuredClone(original); mismatched.items[0]!.sourceStreetTargets[0]!.locationId = "location.other";
  assert.equal(AddressEnrichmentPlanSchema.safeParse(mismatched).success, false);
  const overlay = structuredClone(original); overlay.items[0]!.sourceStreetTargets[0]!.sourceLocation.userResolution = {
    decisionId: "decision.one", method: "explicit-user-confirmation", at: "2026-10-19T00:00:00Z", originalLocationId: source.id, basis: { kind: "manual-area" },
  };
  assert.equal(AddressEnrichmentPlanSchema.safeParse(overlay).success, false);
  const city = structuredClone(original); city.items[0]!.status = "office-ready";
  city.items[0]!.currentOffice = [{ ...source, coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" } }];
  assert.equal(AddressEnrichmentPlanSchema.safeParse(city).success, false);
  city.items[0]!.currentOffice[0]!.precision = "address";
  city.items[0]!.pendingLocationIds = [];
  city.items[0]!.sourceStreetTargets = [];
  assert.equal(AddressEnrichmentPlanSchema.safeParse(city).success, true);
  city.items[0]!.currentOffice[0]!.kind = "unknown";
  assert.equal(AddressEnrichmentPlanSchema.safeParse(city).success, false);
});

test("one usable office never completes a job's other existing unlocated offices", () => {
  const partial = result();
  partial.items[0]!.currentOffice = [{ ...source, id: "location.ready", precision: "address",
    coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" } }];
  assert.equal(AddressEnrichmentPlanSchema.safeParse(partial).success, true);
  for (const change of [
    (value: AddressEnrichmentPlan) => { value.items[0]!.status = "office-ready"; },
    (value: AddressEnrichmentPlan) => { value.items[0]!.pendingLocationIds.push("location.ready"); },
    (value: AddressEnrichmentPlan) => { value.items[0]!.pendingLocationIds.push(source.id); },
    (value: AddressEnrichmentPlan) => { value.items[0]!.pendingLocationIds = []; },
  ]) { const changed = structuredClone(partial); change(changed); assert.equal(AddressEnrichmentPlanSchema.safeParse(changed).success, false); }
  const remote = result(); remote.items[0]!.status = "remote-only"; remote.items[0]!.sourceStreetTargets = [];
  assert.equal(AddressEnrichmentPlanSchema.safeParse(remote).success, false, "remote eligibility has no pending office actions");
  remote.items[0]!.pendingLocationIds = [];
  assert.equal(AddressEnrichmentPlanSchema.safeParse(remote).success, true);
});

test("plan counts, truncation, identity, weak company discovery and status cannot overstate coverage", () => {
  const original = result();
  for (const change of [
    (value: AddressEnrichmentPlan) => { value.processedJobs = 0; },
    (value: AddressEnrichmentPlan) => { value.truncated = true; },
    (value: AddressEnrichmentPlan) => { value.items[0]!.status = "office-ready"; },
    (value: AddressEnrichmentPlan) => { value.items[0]!.status = "remote-only"; },
    (value: AddressEnrichmentPlan) => { value.items[0]!.companyLookup.companyName = "Another employer"; },
  ]) { const changed = structuredClone(original); change(changed); assert.equal(AddressEnrichmentPlanSchema.safeParse(changed).success, false); }
  const verified = structuredClone(original) as unknown as Record<string, unknown>;
  (verified.items as Array<Record<string, unknown>>)[0]!.companyLookup = { companyName: "Synthetic employer", association: "verified", strength: "strong" };
  assert.equal(AddressEnrichmentPlanSchema.safeParse(verified).success, false);
});
