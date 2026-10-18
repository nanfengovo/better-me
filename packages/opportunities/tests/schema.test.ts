import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  AtlasDatasetSchema,
  CanonicalJobSchema,
  CompanySchema,
  CompensationSchema,
  CoordinatesSchema,
  EvidenceRefSchema,
  HttpUrlSchema,
  JobLocationSchema,
  JdSnapshotSchema,
  SourceDefinitionSchema,
  SourceListingSchema,
  SourceObservationSchema,
  createEvidencedSchema,
  validateAtlasDatasetReferences,
  type AtlasDataset,
  type Evidenced,
  type SourceDefinition,
} from "../src/schema.js";
import { deriveEntityId, normalizeSourceUrl } from "../src/identity.js";

const at = "2026-10-18T08:00:00Z";
const url = "https://careers.example.com/jobs/42";
const evidence = { observationId: "observation-1", sourceUrl: url, observedAt: at, quote: "Synthetic engineer role" };
const field = <T>(value: T): Evidenced<T> => ({ value, evidence: [], method: "manual", verification: "unverified", revision: 0 });

function source(): SourceDefinition {
  return {
    sourceId: "source-1", name: "Synthetic company careers", adapterId: "json-feed", adapterVersion: "1",
    capabilities: ["list-jobs", "read-detail"], runtime: ["local-service"], entityType: "job-posting",
    enabled: true, status: "active", entryUrl: "https://careers.example.com/",
    options: { board: "synthetic", pageSize: 20 }, remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.example.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Company careers", usage: "metadata", requiresAttribution: true, homepageUrl: "https://careers.example.com/" },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 },
  };
}

function fixture(): AtlasDataset {
  return {
    schemaVersion: 1, revision: 0, sources: [source()],
    companies: [{ id: "company-1", names: ["Synthetic Industries"], domains: ["example.com"], parentCompanyIds: [], ultimateControllers: field([]), manualOverrides: [] }],
    jobs: [{ id: "job-1", companyId: "company-1", title: field("Synthetic engineer"), description: "Synthetic role for contract tests.", locationIds: ["location-1"], compensationIds: ["salary-1"], listingIds: ["listing-1"], selectedSnapshotId: "snapshot-1", workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: at }],
    locations: [{ id: "location-1", raw: "Shanghai", kind: "office", countryCode: "CN", city: "Shanghai", precision: "city", verification: "unverified", evidence: [] }],
    compensations: [{ id: "salary-1", raw: "CNY 20k–30k/month, 13 months", currency: "CNY", min: 20_000, max: 30_000, period: "month", tax: "gross", kind: "base", monthsPerYear: 13, verification: "unverified", evidence: [] }],
    listings: [{ id: "listing-1", sourceId: "source-1", sourceRecordId: "42", canonicalUrl: url, canonicalJobId: "job-1", observationIds: ["observation-1"], firstDiscoveredAt: at }],
    observations: [{ id: "observation-1", listingId: "listing-1", fetchedAt: at, result: "read", availability: "unknown", completeness: "detail", warnings: [], snapshotId: "snapshot-1", contentHash: "a".repeat(64) }],
    snapshots: [{ id: "snapshot-1", listingId: "listing-1", observationId: "observation-1", text: "Synthetic role for contract tests.", contentHash: "a".repeat(64), createdAt: at, sourceUrl: url, extractionMethod: "manual", completeness: "detail" }],
  };
}

test("strict domain dataset parses without supplying unknown values", () => {
  const dataset = fixture();
  assert.deepEqual(AtlasDatasetSchema.parse(dataset), dataset);
  assert.equal(dataset.locations[0]?.coordinates, undefined);
  assert.equal(dataset.companies[0]?.ultimateControllers.value.length, 0);
  assert.deepEqual(validateAtlasDatasetReferences(dataset), []);
});

test("verified fields require evidence and model proposals cannot self-verify", () => {
  const schema = createEvidencedSchema(z.string());
  assert.equal(schema.safeParse({ ...field("value"), verification: "verified" }).success, false);
  assert.equal(schema.safeParse({ ...field("value"), evidence: [evidence], verification: "verified", method: "model-proposal" }).success, false);
  assert.equal(schema.safeParse({ ...field("value"), evidence: [evidence], verification: "verified", method: "source-structured" }).success, true);
  assert.equal(schema.safeParse({ ...field("value"), verification: "unknown" }).success, true);
  assert.equal(schema.safeParse({ evidence: [], method: "manual", verification: "unknown", revision: 0 }).success, false);
});

test("all wire objects reject unrecognized payload fields", () => {
  const dataset = fixture();
  const cases = [
    [AtlasDatasetSchema, dataset], [CompanySchema, dataset.companies[0]], [CanonicalJobSchema, dataset.jobs[0]],
    [JobLocationSchema, dataset.locations[0]], [CompensationSchema, dataset.compensations[0]],
    [SourceDefinitionSchema, dataset.sources[0]], [SourceListingSchema, dataset.listings[0]],
    [SourceObservationSchema, dataset.observations[0]], [JdSnapshotSchema, dataset.snapshots[0]],
    [EvidenceRefSchema, evidence],
  ] as const;
  for (const [schema, value] of cases) {
    assert.equal(schema.safeParse({ ...value, unexpectedPersonalData: "must not cross the boundary" }).success, false);
  }
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), endpointPolicy: { ...source().endpointPolicy, arbitraryCode: "x" } }).success, false);
});

test("salary bounds are finite, nonnegative, ordered and preserve incomplete disclosures", () => {
  const base = fixture().compensations[0]!;
  for (const invalid of [{ min: -1 }, { max: Infinity }, { min: NaN }, { min: 31_000 }, { monthsPerYear: 0 }, { hoursPerYear: 9000 }, { currency: "usd" }]) {
    assert.equal(CompensationSchema.safeParse({ ...base, ...invalid }).success, false);
  }
  assert.equal(CompensationSchema.safeParse({ ...base, min: 0, max: 0 }).success, true);
  const partial = CompensationSchema.parse({ id: "salary-unknown", raw: "Negotiable", period: "unknown", tax: "unknown", kind: "unknown", verification: "unknown", evidence: [] });
  assert.equal(partial.currency, undefined);
  assert.equal(partial.min, undefined);
  assert.equal(partial.monthsPerYear, undefined);
  assert.equal(CompensationSchema.safeParse({ ...base, verification: "verified" }).success, false);
});

test("coordinates enforce WGS84 ranges and do not turn remote regions into offices", () => {
  assert.equal(CoordinatesSchema.safeParse({ latitude: 91, longitude: 0, coordinateSystem: "WGS84" }).success, false);
  assert.equal(CoordinatesSchema.safeParse({ latitude: 0, longitude: 181, coordinateSystem: "WGS84" }).success, false);
  assert.equal(CoordinatesSchema.safeParse({ latitude: 31.2, longitude: 121.5, coordinateSystem: "GCJ02" }).success, false);
  const base = fixture().locations[0]!;
  const coordinates = { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" };
  assert.equal(JobLocationSchema.safeParse({ ...base, coordinates, originalCoordinates: { ...coordinates, coordinateSystem: "GCJ02" } }).success, true);
  assert.equal(JobLocationSchema.safeParse({ ...base, coordinates, precision: "unknown" }).success, false);
  assert.equal(JobLocationSchema.safeParse({ ...base, coordinates, kind: "remote-region" }).success, false);
  assert.equal(JobLocationSchema.safeParse({ ...base, verification: "verified" }).success, false);
});

test("company ownership has evidence and typed manual overrides", () => {
  const base = fixture().companies[0]!;
  assert.equal(CompanySchema.safeParse({ ...base, parentCompanyIds: [base.id] }).success, false);
  assert.equal(CompanySchema.safeParse({ ...base, domains: ["https://example.com/path"] }).success, false);
  assert.equal(CompanySchema.safeParse({ ...base, ultimateControllers: { ...field([{ name: "Synthetic parent", kind: "private", jurisdictionCode: "DE" }]), verification: "verified" } }).success, false);
  assert.equal(CompanySchema.safeParse({ ...base, manualOverrides: [{ id: "correction-1", field: "arbitrary-css", value: "red", reason: "not a company field", at, basedOnRevision: 0 }] }).success, false);
  assert.equal(CompanySchema.safeParse({ ...base, manualOverrides: [{ id: "correction-1", field: "ultimateControllers", value: { ...field([{ name: "Synthetic parent", kind: "private", jurisdictionCode: "DE" }]), evidence: [evidence], verification: "verified" }, reason: "Synthetic registry statement", at, basedOnRevision: 0 }] }).success, true);
});

test("manual listings can lack a URL but must retain stable source identity", () => {
  const listing = fixture().listings[0]!;
  const { canonicalUrl: omitted, ...manual } = listing;
  assert.ok(omitted);
  assert.equal(SourceListingSchema.safeParse(manual).success, true);
  const { sourceRecordId: ignored, ...anonymous } = manual;
  assert.ok(ignored);
  assert.equal(SourceListingSchema.safeParse(anonymous).success, false);
});

test("fetch time is separate from source and availability times", () => {
  const observation = fixture().observations[0]!;
  const parsed = SourceObservationSchema.parse(observation);
  assert.equal(parsed.sourcePublishedAt, undefined);
  assert.equal(parsed.sourceUpdatedAt, undefined);
  assert.equal(parsed.availabilityVerifiedAt, undefined);
  assert.equal(SourceObservationSchema.safeParse({ ...observation, availabilityVerifiedAt: at }).success, false);
  assert.equal(SourceObservationSchema.safeParse({ ...observation, availability: "open", availabilityVerifiedAt: at, availabilityMethod: "detail-explicit" }).success, true);
  assert.equal(SourceObservationSchema.safeParse({ ...observation, fetchedAt: "2026-10-18" }).success, false);
});

test("failed or blocked reads cannot manufacture open or closed status", () => {
  const observation = fixture().observations[0]!;
  for (const result of ["failed", "needs-human"]) {
    for (const availability of ["open", "closed"]) {
      assert.equal(SourceObservationSchema.safeParse({ ...observation, result, availability }).success, false);
    }
    assert.equal(SourceObservationSchema.safeParse({ ...observation, result, availability: "unknown" }).success, true);
  }
});

test("source configuration is bounded and does not accept executable or nested options", () => {
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), options: { board: { nested: "unsupported" } } }).success, false);
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), runtime: [] }).success, false);
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), capabilities: ["list-jobs", "list-jobs"] }).success, false);
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), endpointPolicy: { ...source().endpointPolicy, allowedHosts: ["https://example.com"] } }).success, false);
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), endpointPolicy: { ...source().endpointPolicy, maxRedirects: 3 } }).success, false);
  for (const key of ["apiKey", "password", "Authorization", "access_token", "client-secret"]) {
    assert.equal(SourceDefinitionSchema.safeParse({ ...source(), options: { [key]: "synthetic-value" } }).success, false);
  }
  assert.equal(SourceDefinitionSchema.safeParse({ ...source(), options: { boardToken: "public-board-slug" }, secretRef: "credential-reference" }).success, true);
});

test("dataset detects missing and duplicate IDs at the corresponding path", () => {
  const missing = fixture();
  missing.jobs[0]!.companyId = "company-missing";
  assert.equal(AtlasDatasetSchema.safeParse(missing).success, false);
  assert.deepEqual(validateAtlasDatasetReferences(missing)[0]?.path, ["jobs", 0, "companyId"]);
  const duplicate = fixture();
  duplicate.locations.push(duplicate.locations[0]!);
  assert.ok(validateAtlasDatasetReferences(duplicate).some((issue) => issue.code === "duplicate-id"));
  assert.equal(AtlasDatasetSchema.safeParse(duplicate).success, false);
});

test("dataset evidence cannot cite a nonexistent observation", () => {
  const dataset = fixture();
  dataset.jobs[0]!.title = { ...field("Synthetic engineer"), evidence: [{ ...evidence, observationId: "missing-observation" }], verification: "verified" };
  assert.equal(AtlasDatasetSchema.safeParse(dataset).success, false);
  assert.ok(validateAtlasDatasetReferences(dataset).some((issue) => issue.path.join(".") === "jobs.0.title.evidence.0.observationId"));
});

test("dataset rejects mismatched listing, observation and selected snapshot ownership", () => {
  const changed = fixture();
  changed.listings.push({ ...changed.listings[0]!, id: "listing-2", sourceRecordId: "43", observationIds: [] });
  changed.snapshots[0]!.listingId = "listing-2";
  assert.ok(validateAtlasDatasetReferences(changed).some((issue) => issue.code === "inconsistent-reference"));
  assert.equal(AtlasDatasetSchema.safeParse(changed).success, false);
  const crossed = fixture();
  crossed.jobs.push({ ...crossed.jobs[0]!, id: "job-2", listingIds: ["listing-1"] });
  assert.equal(AtlasDatasetSchema.safeParse(crossed).success, false);
});

test("a later observation can reuse the same immutable content snapshot", () => {
  const dataset = fixture();
  dataset.observations.push({ ...dataset.observations[0]!, id: "observation-2", fetchedAt: "2026-10-19T08:00:00Z" });
  dataset.listings[0]!.observationIds.push("observation-2");
  assert.equal(AtlasDatasetSchema.safeParse(dataset).success, true);
  assert.equal(dataset.snapshots.length, 1);
  assert.equal(dataset.snapshots[0]!.observationId, "observation-1");
});

test("each listing has one canonical owner and complete observation back-references", () => {
  const shared = fixture();
  delete shared.listings[0]!.canonicalJobId;
  shared.jobs.push({ ...shared.jobs[0]!, id: "job-2" });
  assert.equal(AtlasDatasetSchema.safeParse(shared).success, false);
  const missingJobBackReference = fixture();
  missingJobBackReference.jobs[0]!.listingIds = [];
  delete missingJobBackReference.jobs[0]!.selectedSnapshotId;
  assert.equal(AtlasDatasetSchema.safeParse(missingJobBackReference).success, false);
  const missingObservationBackReference = fixture();
  missingObservationBackReference.listings[0]!.observationIds = [];
  assert.equal(AtlasDatasetSchema.safeParse(missingObservationBackReference).success, false);
});

test("HTTP URL syntax rejects credentials and unsafe protocols", () => {
  for (const candidate of ["file:///C:/secret", "javascript:alert(1)", "https://user:pass@example.com/jobs", "https://user@example.com", " https://example.com/", "https://example.com/\npath", "not-a-url"]) {
    assert.equal(HttpUrlSchema.safeParse(candidate).success, false);
    assert.throws(() => normalizeSourceUrl(candidate), TypeError);
  }
  assert.equal(HttpUrlSchema.safeParse("https://example.com/jobs?id=42").success, true);
});

test("URL normalization removes only recognized tracking keys and preserves identity", () => {
  const normalized = new URL(normalizeSourceUrl("https://EXAMPLE.com:443/jobs?jobId=42&utm_source=test&source=board&ref=internal&gclid=track&step=1&step=2#/role/42"));
  assert.equal(normalized.hostname, "example.com");
  assert.equal(normalized.port, "");
  assert.equal(normalized.searchParams.get("jobId"), "42");
  assert.equal(normalized.searchParams.get("source"), "board");
  assert.equal(normalized.searchParams.get("ref"), "internal");
  assert.deepEqual(normalized.searchParams.getAll("step"), ["1", "2"]);
  assert.equal(normalized.searchParams.has("utm_source"), false);
  assert.equal(normalized.searchParams.has("gclid"), false);
  assert.equal(normalized.hash, "#/role/42");
  assert.equal(normalizeSourceUrl(normalized.toString()), normalized.toString());
});

test("entity IDs are stable and structured parts cannot collide through delimiters", async () => {
  const id = await deriveEntityId("listing", ["source-1", "42"]);
  assert.match(id, /^listing_[a-f0-9]{64}$/);
  assert.equal(id, await deriveEntityId("listing", ["source-1", "42"]));
  assert.notEqual(await deriveEntityId("listing", ["a|b", "c"]), await deriveEntityId("listing", ["a", "b|c"]));
  assert.notEqual(await deriveEntityId("listing", ["a", "b"]), await deriveEntityId("job", ["a", "b"]));
  assert.notEqual(await deriveEntityId("company", ["合成公司"]), await deriveEntityId("company", ["合成公司 "]));
  await assert.rejects(deriveEntityId("../invalid", ["value"]), TypeError);
  await assert.rejects(deriveEntityId("job", []), TypeError);
});
