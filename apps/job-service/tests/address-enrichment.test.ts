import assert from "node:assert/strict";
import test from "node:test";
import {
  AddressEnrichmentPlanSchema, createToolRegistry, type AddressEnrichmentPlan, type AtlasDataset,
  type SourceDefinition, type ToolResult, type TrustedToolContext,
} from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { reviewedCardsSource } from "../src/reviewed-cards.ts";
import { createAddressEnrichmentTool } from "../src/address-enrichment.ts";
import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";
import { projectSourcePage } from "../src/projection.ts";
import { openJobRepository, type JobRepository } from "../src/repository.ts";

const AT = "2026-10-19T00:00:00.000Z";
const TOOL = "jobs.plan-address-enrichment";
const trusted = (changes: Partial<TrustedToolContext> = {}): TrustedToolContext => ({ requestId: "synthetic-address-plan", actorScope: "local-owner",
  allowedEffects: ["read-index"], signal: new AbortController().signal, budget: { requests: 0, bytes: 2_000_000, timeoutMs: 5000 }, ...changes });
const write = (idempotencyKey: string, expectedRevision: number) => ({ actorScope: "local-owner", idempotencyKey, expectedRevision });
function official(sourceId: string, changes: Partial<SourceDefinition> = {}): SourceDefinition {
  return { sourceId, name: "Synthetic company careers", adapterId: "jobposting-jsonld", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"],
    entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], entryUrl: "https://careers.example.test/jobs/",
    endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic official source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 }, ...changes };
}
function record(id: string, changes: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, title: "Synthetic C# engineer",
    companyName: "Synthetic same-name employer", description: "Synthetic complete job requirements.", locations: [{ raw: "Shanghai, CN", countryCode: "CN", city: "Shanghai" }],
    compensations: [], workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [], ...changes };
}
async function seed(repository: JobRepository, source: SourceDefinition, records: SourceJobRecord[]) {
  const before = await repository.readProjectionSnapshot();
  const projection = await projectSourcePage(before, source, { observedAt: AT, records,
    coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, `seed-${source.sourceId}`);
  const receipt = await repository.importSnapshot(projection.delta, write(`seed-${source.sourceId}`, before.revision));
  return receipt.jobIds;
}
function value(result: ToolResult): AddressEnrichmentPlan {
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code);
  return AddressEnrichmentPlanSchema.parse(result.value);
}
function failure(result: ToolResult, code: string) { assert.equal(result.ok, false, JSON.stringify(result)); if (!result.ok) assert.equal(result.error.code, code); }
async function plan(repository: Pick<JobRepository, "readSnapshot" | "readProjectionSnapshot">, jobIds: string[], expectedRevision: number) {
  // The synthetic host explicitly installs the supported v1 recruiting adapters.
  return value(await createToolRegistry([createAddressEnrichmentTool(repository, { canReadOfficialSource: source => source.adapterVersion === "1" })])
    .execute(TOOL, { jobIds, expectedRevision }, trusted()));
}

test("same-platform targets require the reserved source definition, exact provider ID and owned current listing", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const ids: string[] = [];
    for (const [provider, url, id] of [
      ["51job", "https://jobs.51job.com/shanghai/123456789.html", "123456789"],
      ["boss", "https://www.zhipin.com/job_detail/synthetic-42.html", "synthetic-42"],
      ["liepin", "https://www.liepin.com/job/123456789.shtml", "123456789"],
      ["linkedin", "https://www.linkedin.com/jobs/view/123456789/", "123456789"],
    ] as const) ids.push(...await seed(repository, reviewedCardsSource(provider), [record(id, { url })]));
    const before = await repository.backup(); const result = await plan(repository, ids, before.dataset.revision);
    assert.deepEqual(result.items.map(item => item.jobId), ids); assert.equal(result.truncated, false);
    assert.deepEqual(result.items.map(item => item.exactPlatformTargets[0]!.provider), ["51job", "boss", "liepin", "linkedin"]);
    for (const item of result.items) { assert.equal(item.status, "platform-detail"); assert.equal(item.currentOffice.length, 0); assert.equal(item.sourceStreetTargets.length, 0); }
    assert.deepEqual(await repository.backup(), before);
    const changed = await repository.readSnapshot(); changed.listings[0]!.sourceRecordId = "another-job";
    const raw = await repository.readProjectionSnapshot();
    const mismatched = await plan({ async readSnapshot() { return changed; }, async readProjectionSnapshot() { return raw; } }, [changed.listings[0]!.canonicalJobId!], changed.revision);
    assert.deepEqual(mismatched.items[0]!.exactPlatformTargets, []);
    changed.listings[0]!.sourceRecordId = before.dataset.listings[0]!.sourceRecordId;
    changed.sources.find(source => source.sourceId === changed.listings[0]!.sourceId)!.name = "Reserved ID with changed definition";
    assert.deepEqual((await plan({ async readSnapshot() { return changed; }, async readProjectionSnapshot() { return raw; } }, [changed.listings[0]!.canonicalJobId!], changed.revision)).items[0]!.exactPlatformTargets, []);
  } finally { repository.close(); }
});

test("only actually owned enabled official listings are targets, not another company-name match or a GitHub aggregator", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const platform = (await seed(repository, reviewedCardsSource("liepin"), [record("123456789", { url: "https://www.liepin.com/job/123456789.shtml" })]))[0]!;
    const own = (await seed(repository, official("official-own"), [record("own")]))[0]!;
    const disabled = (await seed(repository, official("official-disabled", { enabled: false }), [record("disabled")]))[0]!;
    const review = (await seed(repository, official("official-review", { status: "needs-review" }), [record("review")]))[0]!;
    const aggregator = (await seed(repository, official("github", { adapterId: "github-json" }), [record("aggregator")]))[0]!;
    const unsupported = (await seed(repository, official("official-unsupported", { adapterVersion: "99" }), [record("unsupported")]))[0]!;
    const before = await repository.backup(); const result = await plan(repository, [platform, own, disabled, review, aggregator, unsupported], before.dataset.revision);
    assert.deepEqual(result.items.map(item => item.ownedOfficialTargets.map(target => target.sourceId)), [[], ["official-own"], [], [], [], []]);
    assert.equal(result.items[1]!.status, "official-source"); assert.equal(result.items[2]!.status, "company-discovery");
    for (const item of result.items) assert.deepEqual(item.companyLookup, { companyName: "Synthetic same-name employer", association: "unverified", strength: "weak" });
    const unavailable = value(await createToolRegistry([createAddressEnrichmentTool(repository, { canReadOfficialSource: () => false })])
      .execute(TOOL, { jobIds: [own], expectedRevision: before.dataset.revision }, trusted()));
    assert.deepEqual(unavailable.items[0]!.ownedOfficialTargets, [], "host-uninstalled adapters cannot become actionable official targets");
    assert.deepEqual(await repository.backup(), before);
  } finally { repository.close(); }
});

test("a standalone planner cannot infer installed official code from a source's version field", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [id] = await seed(repository, official("no-installed-host"), [record("not-installed")]);
    const before = await repository.backup();
    const result = value(await createToolRegistry([createAddressEnrichmentTool(repository)])
      .execute(TOOL, { jobIds: [id], expectedRevision: before.dataset.revision }, trusted()));
    assert.deepEqual(result.items[0]!.ownedOfficialTargets, []);
    assert.equal(result.items[0]!.status, "company-discovery");
    assert.deepEqual(await repository.backup(), before);
  } finally { repository.close(); }
});

test("mixed-location plans honor the current reviewed location kind before proposing source-street office work", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [id] = await seed(repository, official("mixed-location-kinds"), [record("mixed", { workMode: "hybrid", locations: [
      { raw: "Synthetic Remote Street 10, Shanghai", streetAddress: "Synthetic Remote Street 10", countryCode: "CN", city: "Shanghai" },
      { raw: "Synthetic Office Street 20, Shanghai", streetAddress: "Synthetic Office Street 20", countryCode: "CN", city: "Shanghai" },
    ] })]);
    const first = await repository.readSnapshot(), reviewedId = first.jobs[0]!.locationIds[0]!;
    for (const locationKind of ["remote-region", "unknown"] as const) {
      const before = await repository.readSnapshot();
      const input = { jobId: id!, locationId: reviewedId, expectedRevision: before.revision,
        proposal: { locationKind, countryCode: "CN", area: { kind: "manual-area" as const, city: "Shanghai" } },
        reason: "Synthetic explicit correction of location nature" };
      const preview = await repository.previewLocationConfirmation(input);
      await repository.confirmLocation({ ...input, reviewed: true, previewFingerprint: preview.previewFingerprint }, write(`review-${locationKind}`, before.revision));
      const saved = await repository.backup(), result = await plan(repository, [id!], saved.dataset.revision);
      assert.equal(result.items[0]!.status, "source-street");
      assert.deepEqual(result.items[0]!.sourceStreetTargets.map(target => target.locationId), [first.jobs[0]!.locationIds[1]],
        "the original street remains auditable but a current non-office location cannot become an office-enrichment action");
      assert.deepEqual(result.items[0]!.currentOffice, []);
      assert.deepEqual(await repository.backup(), saved);
    }
  } finally { repository.close(); }
});

test("original source streets remain distinct from confirmed office overlays and city-only coordinates", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [withStreet, cityOnly] = await seed(repository, official("source-addresses"), [
      record("street", { locations: [{ raw: "Source Street 10, Shanghai", streetAddress: "Source Street 10", countryCode: "CN", city: "Shanghai", postalCode: "020000" }] }), record("city"),
    ]);
    const before = await repository.readSnapshot();
    const streetLocation = before.jobs.find(job => job.id === withStreet)!.locationIds[0]!, cityLocation = before.jobs.find(job => job.id === cityOnly)!.locationIds[0]!;
    const first = await plan(repository, [withStreet!, cityOnly!], before.revision);
    assert.equal(first.items[0]!.status, "source-street"); assert.equal(first.items[0]!.sourceStreetTargets[0]!.sourceLocation.postalCode, "020000");
    const proposal = { basis: "manual-user-confirmation" as const, countryCode: "CN", streetAddress: "User Office 99", formattedAddress: "Synthetic user office 99, Shanghai",
      coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, coordinateMeaning: "building" as const, evidenceUrl: "https://careers.example.test/jobs/city" };
    const command = { jobId: cityOnly!, locationId: cityLocation, expectedRevision: before.revision, proposal, reason: "Synthetic explicitly reviewed office" };
    const preview = await repository.previewOfficeConfirmation(command);
    await repository.confirmOfficeAddress({ ...command, previewFingerprint: preview.previewFingerprint, reviewed: true }, write("office-city", before.revision));
    const saved = await repository.backup(), result = await plan(repository, [withStreet!, cityOnly!], saved.dataset.revision);
    assert.equal(result.items[1]!.status, "office-ready"); assert.equal(result.items[1]!.currentOffice[0]!.streetAddress, "User Office 99");
    assert.deepEqual(result.items[1]!.sourceStreetTargets, [], "a confirmed overlay street is never a source disclosure");
    assert.equal(result.items[0]!.sourceStreetTargets[0]!.locationId, streetLocation);
    assert.equal(result.items[0]!.sourceStreetTargets[0]!.sourceLocation.streetAddress, "Source Street 10");
    assert.deepEqual(await repository.backup(), saved);
    const cityCoordinates = structuredClone(saved.dataset); const actual = cityCoordinates.locations.find(location => location.id === streetLocation)!;
    actual.coordinates = proposal.coordinates; actual.precision = "city";
    const cityPlan = await plan({ async readSnapshot() { return cityCoordinates; }, readProjectionSnapshot: () => repository.readProjectionSnapshot() }, [withStreet!], saved.dataset.revision);
    assert.deepEqual(cityPlan.items[0]!.currentOffice, []);
  } finally { repository.close(); }
});

test("a partial multi-office job keeps unlocated identities actionable until every existing office has a point", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [jobId] = await seed(repository, official("multiple-office-points"), [record("offices", { locations: [
      { raw: "Synthetic Office Street 10, Shanghai", streetAddress: "Synthetic Office Street 10", countryCode: "CN", city: "Shanghai" },
      { raw: "Synthetic Beijing office", countryCode: "CN", city: "Beijing" },
    ] })]);
    const initial = await repository.readSnapshot(), locationIds = initial.jobs[0]!.locationIds;
    const first = (await plan(repository, [jobId!], initial.revision)).items[0]!;
    assert.deepEqual(first.pendingLocationIds, locationIds); assert.equal(first.status, "source-street");
    for (const [index, locationId] of locationIds.entries()) {
      const before = await repository.readSnapshot();
      const input = { jobId: jobId!, locationId, expectedRevision: before.revision,
        proposal: { basis: "manual-user-confirmation" as const, countryCode: "CN", streetAddress: `Synthetic Reviewed Street ${index + 1}`,
          formattedAddress: `Synthetic Reviewed Street ${index + 1}, CN`, coordinates: { latitude: 31.2 + index, longitude: 121.5 + index, coordinateSystem: "WGS84" as const },
          coordinateMeaning: "building" as const, evidenceUrl: "https://careers.example.test/jobs/offices" }, reason: "Synthetic reviewed specific office" };
      const preview = await repository.previewOfficeConfirmation(input);
      await repository.confirmOfficeAddress({ ...input, reviewed: true, previewFingerprint: preview.previewFingerprint }, write(`confirm-office-${index}`, before.revision));
      const saved = await repository.backup(), item = (await plan(repository, [jobId!], saved.dataset.revision)).items[0]!;
      assert.equal(item.currentOffice.length, index + 1);
      assert.deepEqual(item.pendingLocationIds, locationIds.slice(index + 1));
      assert.deepEqual(item.sourceStreetTargets, [], "the first source street has already been explicitly located");
      assert.equal(item.status, index === 0 ? "official-source" : "office-ready");
      assert.ok(item.warnings.some(warning => warning.includes("其他来源未披露的地点")));
      assert.deepEqual(await repository.backup(), saved);
    }
  } finally { repository.close(); }
});

test("merged canonical jobs retain owned origin targets while a stale alias cannot expand the scope", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const platform = (await seed(repository, reviewedCardsSource("liepin"), [record("123456789", { url: "https://www.liepin.com/job/123456789.shtml" })]))[0]!;
    const officialJob = (await seed(repository, official("official-owned"), [record("official")]))[0]!;
    const before = await repository.readSnapshot();
    await repository.mergeJobs({ targetJobId: platform, sourceJobId: officialJob, companyIdentityConfirmed: true, reason: "Synthetic same-job explicit review" }, write("merge", before.revision));
    const saved = await repository.backup(); const result = await plan(repository, [platform], saved.dataset.revision);
    assert.equal(result.items[0]!.exactPlatformTargets.length, 1); assert.equal(result.items[0]!.ownedOfficialTargets.length, 1);
    failure(await createToolRegistry([createAddressEnrichmentTool(repository)]).execute(TOOL, { jobIds: [officialJob], expectedRevision: saved.dataset.revision }, trusted()), "invalid-input");
    assert.deepEqual(await repository.backup(), saved);
  } finally { repository.close(); }
});

test("remote eligibility does not become an office even when a remote source supplies street text", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [id] = await seed(repository, official("remote-source"), [record("remote", { workMode: "remote", locations: [{ raw: "Remote eligibility Shanghai", countryCode: "CN", city: "Shanghai", streetAddress: "Not an office street" }] })]);
    const data = await repository.readSnapshot(), result = await plan(repository, [id!], data.revision), item = result.items[0]!;
    assert.equal(item.status, "remote-only"); assert.deepEqual(item.currentOffice, []); assert.deepEqual(item.sourceStreetTargets, []);
    assert.deepEqual(item.ownedOfficialTargets, []); assert.deepEqual(item.exactPlatformTargets, []);
  } finally { repository.close(); }
});

test("explicit empty scopes, bounded target truncation and missing IDs never imply all-search coverage", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  try {
    const [id] = await seed(repository, official("many-offices"), [record("many", { locations: Array.from({ length: 25 }, (_, index) => ({ raw: `Synthetic Road ${index}, Shanghai`, streetAddress: `Synthetic Road ${index}`, city: "Shanghai", countryCode: "CN" })) })]);
    const before = await repository.backup(), empty = await plan(repository, [], before.dataset.revision);
    assert.equal(empty.requestedJobs, 0); assert.deepEqual(empty.items, []);
    const result = await plan(repository, [id!], before.dataset.revision);
    assert.equal(result.requestedJobs, 1); assert.equal(result.processedJobs, 1); assert.equal(result.truncated, true);
    assert.equal(result.items[0]!.truncated, true); assert.equal(result.items[0]!.sourceStreetTargets.length, 20);
    failure(await createToolRegistry([createAddressEnrichmentTool(repository)]).execute(TOOL, { jobIds: [id!, "missing"], expectedRevision: before.dataset.revision }, trusted()), "invalid-input");
    assert.deepEqual(await repository.backup(), before);
  } finally { repository.close(); }
});

test("stale projections, aborted requests, private side inputs, wrong effects and output budgets fail without a lookup", async () => {
  let reads = 0;
  const dataset: AtlasDataset = { schemaVersion: 1, revision: 7, sources: [], companies: [], jobs: [], locations: [], listings: [], observations: [], snapshots: [], compensations: [] };
  const repository = { async readSnapshot() { reads++; return structuredClone(dataset); }, async readProjectionSnapshot() { reads++; return { ...structuredClone(dataset), revision: 8 }; } };
  const registry = createToolRegistry([createAddressEnrichmentTool(repository)]);
  failure(await registry.execute(TOOL, { jobIds: [], expectedRevision: 6 }, trusted()), "stale-version"); assert.equal(reads, 1);
  failure(await registry.execute(TOOL, { jobIds: [], expectedRevision: 7 }, trusted()), "stale-version"); assert.equal(reads, 3);
  const controller = new AbortController(); controller.abort();
  failure(await registry.execute(TOOL, { jobIds: [], expectedRevision: 7 }, trusted({ signal: controller.signal })), "cancelled");
  failure(await registry.execute(TOOL, { jobIds: [], expectedRevision: 7, homeAddress: "PRIVATE_ADDRESS" }, trusted()), "invalid-input");
  failure(await registry.execute(TOOL, { jobIds: [], expectedRevision: 7 }, trusted({ allowedEffects: [] })), "not-authorized"); assert.equal(reads, 3);
  const consistent = createToolRegistry([createAddressEnrichmentTool({ async readSnapshot() { return dataset; }, async readProjectionSnapshot() { return dataset; } })]);
  failure(await consistent.execute(TOOL, { jobIds: [], expectedRevision: 7 }, trusted({ budget: { requests: 0, bytes: 16, timeoutMs: 5000 } })), "budget-exceeded");
});

test("authenticated HTTP exposes the read-only plan, without idempotency key, network calls or database changes", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT }); let transportCalls = 0, officeCalls = 0, careerCalls = 0;
  const application = createJobApplication({ repository, now: () => AT,
    transport: { async request() { transportCalls++; throw new Error("No source transport authorized"); } },
    officeAddressProvider: { providerId: "synthetic", async search() { officeCalls++; throw new Error("No address lookup authorized"); } },
    careerWebSearchProvider: { async search() { careerCalls++; throw new Error("No discovery lookup authorized"); } },
  });
  const token = "synthetic-address-plan-token-0123456789", origin = "http://synthetic-atlas.invalid";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [origin], port: 0 });
  try {
    const [id] = await seed(repository, official("http-plan"), [record("http")]); const before = await repository.backup();
    const { url } = await server.listen(), route = `${url}/api/v1/jobs/address-enrichment/plan`, body = JSON.stringify({ jobIds: [id], expectedRevision: before.dataset.revision });
    assert.equal((await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401);
    const response = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" }, body });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = value(await response.json() as ToolResult); assert.equal(result.items[0]!.status, "official-source");
    assert.deepEqual([transportCalls, officeCalls, careerCalls], [0, 0, 0]); assert.deepEqual(await repository.backup(), before);
  } finally { await application.shutdown(); await server.close(); repository.close(); }
});
