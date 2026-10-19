import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { JobLocationSchema, ToolError, deriveEntityId, type SourceDefinition } from "@better-me/opportunities";
import { SourceRecordLocationSchema, type SourceJobRecord, type SourcePage } from "@better-me/source-adapters";
import { emptyDelta, projectSourcePage } from "../src/projection.ts";

const source: SourceDefinition = {
  sourceId: "synthetic-source-address", name: "Synthetic address source", adapterId: "synthetic", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 1, requestsPerMinute: 10 },
};
const at = "2026-10-19T00:00:00.000Z", nextAt = "2026-10-19T01:00:00.000Z";
const core = { raw: "Original source office label", countryCode: "US" as const, region: "Massachusetts", city: "Boston" };
function record(location: SourceJobRecord["locations"][number] = core): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "synthetic-address-record", url: "https://careers.example.test/jobs/synthetic-address-record", title: "Synthetic engineer", companyName: "Synthetic employer",
    locations: [location], compensations: [], workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt",
    evidence: [{ field: "locations", selector: "job.location", quote: JSON.stringify(location), sourceUrl: "https://careers.example.test/jobs/synthetic-address-record" }], warnings: [] };
}
function page(value: SourceJobRecord, observedAt = at): SourcePage {
  return { records: [value], observedAt, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] };
}
const changed = (error: unknown) => error instanceof ToolError && error.code === "source-changed";

test("source address fields survive projection under the original legacy location ID without establishing an office point", async () => {
  const location = { ...core, streetAddress: "Source street 10", postalCode: "00123" };
  const result = await projectSourcePage(emptyDelta(), source, page(record(location)), "synthetic-initial-run");
  const listingId = await deriveEntityId("listing", [source.sourceId, "synthetic-address-record"]);
  // This is the original pre-address digest, sorted exactly as stableValue sorted the old four keys.
  const legacyHash = createHash("sha256").update(JSON.stringify({ city: core.city, countryCode: core.countryCode, raw: core.raw, region: core.region })).digest("hex");
  const legacyId = await deriveEntityId("location", [listingId, "office", legacyHash]);
  const projected = result.delta.locations[0]!;
  assert.equal(projected.id, legacyId); assert.equal(projected.streetAddress, "Source street 10"); assert.equal(projected.postalCode, "00123");
  assert.equal(projected.precision, "city"); assert.equal(projected.verification, "unverified");
  assert.equal(projected.coordinates, undefined); assert.equal(projected.officeResolution, undefined); assert.equal(projected.userResolution, undefined);
  assert.deepEqual(JobLocationSchema.parse(projected), projected);
  assert.deepEqual(result.delta.jobs[0]!.locationIds, [legacyId]); assert.deepEqual(result.delta.listings[0]!.locationIds, [legacyId]);
});

test("later disclosure enriches the same location ID, preserves original evidence and does not clear fields on a sparse refresh", async () => {
  const initial = (await projectSourcePage(emptyDelta(), source, page(record()), "synthetic-legacy-run")).delta;
  const before = structuredClone(initial), old = initial.locations[0]!;
  const enriched = await projectSourcePage(initial, source, page(record({ ...core, streetAddress: "Source street 10", postalCode: "00123" }), nextAt), "synthetic-enriched-run");
  const location = enriched.delta.locations[0]!;
  assert.equal(location.id, old.id); assert.deepEqual(location.evidence.slice(0, old.evidence.length), old.evidence);
  assert.ok(location.evidence.some(evidence => evidence.observedAt === nextAt));
  assert.equal(location.streetAddress, "Source street 10"); assert.equal(location.postalCode, "00123"); assert.equal(location.coordinates, undefined);
  assert.deepEqual(initial, before);
  const upgraded = { ...initial, locations: [location], observations: [...initial.observations, ...enriched.delta.observations] };
  const sparse = await projectSourcePage(upgraded, source, page(record(), "2026-10-19T02:00:00.000Z"), "synthetic-sparse-run");
  assert.deepEqual(sparse.delta.locations, []); assert.equal(upgraded.locations[0]!.streetAddress, "Source street 10");
  assert.deepEqual(sparse.delta.listings[0]!.locationIds, [old.id]);
});

test("location enrichment within one source page deduplicates the legacy ID while preserving address values", async () => {
  const entry = record(); entry.locations.push({ ...core, streetAddress: "Source street 10", postalCode: "00123" });
  const result = await projectSourcePage(emptyDelta(), source, page(entry), "synthetic-overlapping-locations");
  assert.equal(result.delta.locations.length, 1); assert.equal(result.delta.locations[0]!.streetAddress, "Source street 10");
  assert.equal(result.delta.jobs[0]!.locationIds.length, 1); assert.equal(result.delta.listings[0]!.locationIds.length, 1);
});

test("an explicit street or postal change creates a new identity without inheriting the old office's missing fields", async () => {
  const initial = (await projectSourcePage(emptyDelta(), source, page(record({ ...core, streetAddress: "Source street 10", postalCode: "00123" })), "synthetic-initial-run")).delta;
  const locations: SourceJobRecord["locations"] = [{ ...core, streetAddress: "Different source street" }, { ...core, postalCode: "00999" }];
  for (const location of locations) {
    const moved = await projectSourcePage(initial, source, page(record(location), nextAt), "synthetic-conflicting-run");
    const current = moved.delta.locations[0]!;
    assert.notEqual(current.id, initial.locations[0]!.id);
    assert.equal(current.streetAddress, location.streetAddress); assert.equal(current.postalCode, location.postalCode);
    assert.deepEqual(moved.delta.jobs[0]!.locationIds, [current.id]);
    assert.deepEqual(moved.delta.listings[0]!.locationIds, [current.id]);
    assert.equal(current.coordinates, undefined); assert.equal(current.officeResolution, undefined);
  }
  const changedRaw = await projectSourcePage(initial, source, page(record({ ...core, raw: "New original source office label", streetAddress: "Different source street" }), nextAt), "synthetic-new-location-run");
  assert.notEqual(changedRaw.delta.locations[0]!.id, initial.locations[0]!.id);
});

test("a sparse refresh follows the current moved office rather than the historical legacy address", async () => {
  const initial = (await projectSourcePage(emptyDelta(), source, page(record({ ...core, streetAddress: "Source street 10", postalCode: "00123" })), "synthetic-first-office")).delta;
  const moved = (await projectSourcePage(initial, source, page(record({ ...core, streetAddress: "New source street 20" }), nextAt), "synthetic-moved-office")).delta;
  const current = { ...initial, ...moved, locations: [...initial.locations, ...moved.locations], observations: [...initial.observations, ...moved.observations] };
  const sparse = await projectSourcePage(current, source, page(record(), "2026-10-19T02:00:00.000Z"), "synthetic-sparse-after-move");
  assert.deepEqual(sparse.delta.listings[0]!.locationIds, moved.listings[0]!.locationIds);
  assert.deepEqual(sparse.delta.jobs[0]!.locationIds, moved.jobs[0]!.locationIds);
  assert.deepEqual(sparse.delta.locations, []);
  assert.equal(moved.locations[0]!.postalCode, undefined);
  const postal = await projectSourcePage(current, source, page(record({ ...core, streetAddress: "New source street 20", postalCode: "00456" }), "2026-10-19T03:00:00.000Z"), "synthetic-new-office-postal");
  assert.notEqual(postal.delta.locations[0]!.id, moved.locations[0]!.id);
  assert.equal(postal.delta.locations[0]!.streetAddress, "New source street 20");
  assert.equal(postal.delta.locations[0]!.postalCode, "00456");
});

test("two explicitly different offices with the same source label remain distinct and sparse evidence cannot choose one", async () => {
  const entry = record({ ...core, streetAddress: "Source street 10", postalCode: "00123" });
  entry.locations.push({ ...core, streetAddress: "Second source street 20", postalCode: "00456" });
  const initial = (await projectSourcePage(emptyDelta(), source, page(entry), "synthetic-two-offices")).delta;
  assert.equal(initial.locations.length, 2); assert.equal(initial.jobs[0]!.locationIds.length, 2);
  assert.deepEqual(initial.locations.map(location => location.streetAddress), ["Source street 10", "Second source street 20"]);
  const sparse = await projectSourcePage(initial, source, page(record(), nextAt), "synthetic-two-office-sparse");
  assert.deepEqual(sparse.delta.listings[0]!.locationIds, initial.listings[0]!.locationIds);
  assert.deepEqual(sparse.delta.jobs[0]!.locationIds, initial.jobs[0]!.locationIds);
  assert.deepEqual(sparse.delta.locations, []);
});

test("source address enrichment rejects visible administrative overlays and requires the repository base snapshot", async () => {
  const initial = (await projectSourcePage(emptyDelta(), source, page(record()), "synthetic-initial-run")).delta;
  initial.locations[0]!.userResolution = { decisionId: "synthetic-area-decision", method: "explicit-user-confirmation", at,
    originalLocationId: initial.locations[0]!.id };
  await assert.rejects(projectSourcePage(initial, source, page(record({ ...core, streetAddress: "Source street 10" }), nextAt), "synthetic-visible-overlay-run"), changed);
});

test("address schemas reject control characters, empty fields and excess lengths while retaining leading zero postal text", () => {
  assert.equal(SourceRecordLocationSchema.parse({ raw: "Original label", postalCode: " 00123 " }).postalCode, "00123");
  for (const fields of [{ streetAddress: "" }, { postalCode: " " }, { streetAddress: "x".repeat(1001) }, { postalCode: "x".repeat(101) },
    { streetAddress: "Source\u0000ID" }, { postalCode: "00\u007fID" }, { streetAddress: "Source\ud800ID" }]) {
    assert.equal(SourceRecordLocationSchema.safeParse({ raw: "Original label", ...fields }).success, false);
    assert.equal(JobLocationSchema.safeParse({ id: "synthetic-location", raw: "Original label", kind: "office", precision: "unknown", evidence: [], verification: "unverified", ...fields }).success, false);
  }
});
