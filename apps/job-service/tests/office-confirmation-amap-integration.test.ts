import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SourceTransport, SourceTransportRequest, SourceTransportResponse, SourceJobRecord } from "@better-me/source-adapters";
import { openJobRepository, type JobRepository } from "../src/repository.js";
import { createJobApplication } from "../src/application.js";
import { createAmapOfficeProvider } from "../src/office-address-provider.js";
import { projectSourcePage } from "../src/projection.js";
import { queryJobs, type SourceDefinition } from "@better-me/opportunities";

const AT = "2026-10-19T00:00:00.000Z";

const source: SourceDefinition = {
  sourceId: "office-amap-source",
  name: "AMap source",
  adapterId: "synthetic",
  adapterVersion: "1",
  capabilities: ["list-jobs"],
  runtime: ["local-service"],
  entityType: "job-posting",
  enabled: true,
  status: "active",
  remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "AMapTest", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 },
};

function record(streetAddress: string): SourceJobRecord {
  return {
    entityType: "job-posting",
    sourceRecordId: "job-sh-dotnet",
    url: "https://careers.example.test/jobs/job-sh-dotnet",
    title: ".NET 高级架构师",
    companyName: "未来科技",
    description: "Synthetic full JD with office street",
    locations: [{ raw: `上海市浦东新区${streetAddress}`, countryCode: "CN", city: "上海", streetAddress }],
    compensations: [],
    workMode: "on-site",
    employmentType: "unknown",
    remoteEligibleRegions: [],
    availability: "unknown",
    completeness: "detail",
    evidence: [],
    warnings: [],
  };
}

async function ingestJobWithStreet(repo: JobRepository, streetAddress: string) {
  const before = await repo.readProjectionSnapshot();
  const projection = await projectSourcePage(before, source, {
    records: [record(streetAddress)],
    observedAt: AT,
    coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] },
    warnings: [],
  }, "seed-amap-job");
  return repo.importSnapshot(projection.delta, { actorScope: "test", idempotencyKey: "seed-amap-job", expectedRevision: before.revision });
}

test("AMap provider candidate -> preview -> confirm workflow marks office location as building grade on map", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-amap-integration-"));
  const dbPath = join(dir, "jobs.sqlite");
  const repo = openJobRepository(dbPath, { now: () => AT });

  try {
    await ingestJobWithStreet(repo, "博云路2号");
    const initialSnapshot = await repo.readSnapshot();
    const targetJob = initialSnapshot.jobs[0]!;
    const targetLocationId = targetJob.locationIds[0]!;

    const syntheticTransport: SourceTransport = {
      request: async (req: SourceTransportRequest): Promise<SourceTransportResponse> => ({
        status: 200,
        url: req.url,
        text: JSON.stringify({
          status: "1",
          info: "OK",
          count: "1",
          geocodes: [{
            formatted_address: "上海市浦东新区张江高科技园区博云路2号",
            country: "中国",
            province: "上海市",
            city: "上海市",
            district: "浦东新区",
            street: "博云路",
            number: "2号",
            location: "121.603306,31.200155",
            level: "门牌号",
          }],
        }),
        headers: { "content-type": "application/json" },
      }),
    };

    const amapProvider = createAmapOfficeProvider(syntheticTransport, { key: "test-amap-key" });
    const app = createJobApplication({ repository: repo, officeAddressProvider: amapProvider });

    const readContext = {
      requestId: "amap-integ-read",
      actorScope: "owner",
      signal: new AbortController().signal,
      allowedEffects: ["read-index", "external-read"] as any,
      budget: { requests: 10, bytes: 1000000, timeoutMs: 5000 },
    };

    // 1. Query candidates
    const candExec = await app.registry.execute("locations.office-address-candidates", {
      jobId: targetJob.id,
      locationId: targetLocationId,
      expectedRevision: initialSnapshot.revision,
      query: "博云路2号",
      locality: "上海",
    }, readContext);
    assert.equal(candExec.ok, true);
    const candidatesResult = candExec.value as any;

    assert.equal(candidatesResult.status, "candidates");
    assert.equal(candidatesResult.candidates.length, 1);
    const candidate = candidatesResult.candidates[0]!;
    assert.equal(candidate.providerId, "amap");

    // 2. Preview office confirmation
    const prevExec = await app.registry.execute("locations.preview-office-confirmation", {
      jobId: targetJob.id,
      locationId: targetLocationId,
      expectedRevision: initialSnapshot.revision,
      proposal: candidate.proposal,
      reason: "核对高德门牌号点位",
    }, readContext);
    assert.equal(prevExec.ok, true);
    const previewResult = prevExec.value as any;

    assert.ok(previewResult.previewFingerprint);

    // 3. Confirm office address
    const writeContext = {
      requestId: "amap-integ-write",
      actorScope: "owner",
      idempotencyKey: "confirm-test-1",
      signal: new AbortController().signal,
      allowedEffects: ["local-write", "read-index"] as any,
      budget: { requests: 10, bytes: 1000000, timeoutMs: 5000 },
    };
    const confExec = await app.registry.execute("locations.confirm-office-address", {
      jobId: targetJob.id,
      locationId: targetLocationId,
      expectedRevision: initialSnapshot.revision,
      proposal: candidate.proposal,
      previewFingerprint: previewResult.previewFingerprint,
      reason: "核对高德门牌号点位",
      reviewed: true,
    }, writeContext);
    assert.equal(confExec.ok, true);
    const confirmResult = confExec.value as any;

    assert.equal(confirmResult.revision, initialSnapshot.revision + 1);
    assert.equal(confirmResult.location.officeResolution?.formattedAddress, "上海市浦东新区张江高科技园区博云路2号");

    // 4. Verify map displayGrade is 'building'
    const snapshot = await repo.readSnapshot();
    const queryResult = await queryJobs(snapshot, { mapLevel: "location" });
    assert.equal(queryResult.totalJobs, 1);
    assert.equal(queryResult.mapBuckets.length, 1);
    const bucket = queryResult.mapBuckets[0]!;
    assert.equal(bucket.displayGrade, "building");
    assert.equal(bucket.label, "上海市浦东新区张江高科技园区博云路2号");
    assert.ok(bucket.latitude > 31 && bucket.latitude < 32);
    assert.ok(bucket.longitude > 121 && bucket.longitude < 122);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
