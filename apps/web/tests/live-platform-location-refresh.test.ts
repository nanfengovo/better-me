import assert from "node:assert/strict";
import test from "node:test";
import { queryJobs, type ToolHandlerContext } from "@better-me/opportunities";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters";
import { openJobRepository, type JobRepository } from "../../job-service/src/repository";
import { createReviewedCardsTools } from "../../job-service/src/reviewed-cards";
import { enrichSnapshotCompaniesAndOffices } from "../src/components/atlas/live-platform-auto-import";
import { groupLiveCardsForReviewedImport } from "../src/components/atlas/live-platform-import-utils";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";

const NOW = "2026-10-26T00:02:00.000Z";
const PAGE = "https://www.liepin.com/zhaopin/?key=C%23&city=020&curPage=4&pageSize=40";
const URL = "https://www.liepin.com/job/123456789.shtml";
const TITLE = ".NET开发工程师（上海-闵行区）";
const COMPANY = "上海大阈信息技术有限公司";

function capture(capturedAt: string): ReviewedCardsCapture {
  // Synthetic reproduction of the missing structured field, not a live capture.
  return ReviewedCardsCaptureSchema.parse({
    provider: "liepin", pageUrl: PAGE, capturedAt, cards: [{
      platform: "猎聘", url: URL, title: TITLE, company: COMPANY,
      cardText: `${TITLE} ${COMPANY} 20-30k`,
      evidence: { pageUrl: PAGE, cardSelector: ".synthetic-card", fields: [
        { field: "url", selector: "a", text: URL },
        { field: "title", selector: ".title", text: TITLE },
        { field: "company", selector: ".company", text: COMPANY },
      ] },
    }],
  });
}

function context(key: string): ToolHandlerContext {
  return {
    requestId: key, actorScope: "synthetic-location-refresh", idempotencyKey: key,
    signal: new AbortController().signal,
    budget: { requests: 0, bytes: 2_000_000, timeoutMs: 10_000 },
    consumeRequests() { throw new Error("External reads are not allowed in this test."); },
    consumeBytes() {}, throwIfCancelled() {},
  };
}

async function importCapture(repo: JobRepository, input: ReviewedCardsCapture, key: string) {
  const tools = createReviewedCardsTools({ repository: repo, now: () => NOW });
  const expectedRevision = (await repo.readSnapshot()).revision;
  const preview = await tools[0].execute({ ...input, expectedRevision }, context(`${key}-preview`));
  return tools[1].execute({
    ...input, expectedRevision, previewFingerprint: preview.previewFingerprint, reviewed: true,
  }, context(key));
}

test("re-capturing an existing Minhang .NET card repairs its source location without adding a duplicate job or inventing a map point", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: {} });
  try {
    await importCapture(repo, capture("2026-10-26T00:00:00.000Z"), "legacy-import");
    const before = await repo.readSnapshot();
    const jobId = before.jobs[0]!.id;
    assert.deepEqual(before.jobs[0]!.locationIds, []);
    assert.deepEqual(before.listings[0]!.locationIds, []);
    const query = { search: { text: ".NET" }, market: "domestic" as const,
      workCountryCodes: ["CN"], workRegionGroups: [["上海市", "上海"], ["闵行区"]] };
    assert.equal((await queryJobs(before, query)).totalJobs, 0);

    const nextCapture = capture("2026-10-26T00:01:00.000Z");
    const chunk = groupLiveCardsForReviewedImport(nextCapture.cards, "liepin")[0]!;
    const refreshedCapture = ReviewedCardsCaptureSchema.parse({ ...nextCapture, ...chunk });
    assert.equal(refreshedCapture.cards[0]!.locationText, "上海-闵行区");
    const receipt = await importCapture(repo, refreshedCapture, "source-refresh");
    assert.equal(receipt.counts.newJobs, 0);
    assert.equal(receipt.counts.updatedJobs, 1);
    const refreshed = await repo.readSnapshot();
    assert.equal(refreshed.jobs.length, 1);
    assert.equal(refreshed.jobs[0]!.id, jobId);
    assert.equal(refreshed.jobs[0]!.locationIds.length, 1);
    assert.deepEqual(refreshed.listings[0]!.locationIds, refreshed.jobs[0]!.locationIds);
    const sourceLocation = refreshed.locations[0]!;
    assert.equal(sourceLocation.raw, "上海-闵行区");
    assert.equal(sourceLocation.kind, "unknown");
    assert.equal(sourceLocation.coordinates, undefined);
    assert.equal(sourceLocation.evidence[0]!.sourceUrl, PAGE);
    assert.equal(sourceLocation.evidence[0]!.quote, "上海-闵行区");

    const client = {
      snapshot: () => repo.readSnapshot(),
      previewLocationConfirmation: (input: Parameters<JobRepository["previewLocationConfirmation"]>[0]) => repo.previewLocationConfirmation(input),
      confirmLocation: (input: Parameters<JobRepository["confirmLocation"]>[0], options: { idempotencyKey: string }) => repo.confirmLocation(input, {
        actorScope: "synthetic-location-refresh", idempotencyKey: options.idempotencyKey,
        expectedRevision: input.expectedRevision,
      }),
      previewCompanyControllerOverride: async () => { throw new Error("Company classification is outside this test."); },
    } as unknown as ReturnType<typeof createAtlasSourceClient>;
    const enriched = await enrichSnapshotCompaniesAndOffices({ client, snapshot: refreshed, jobIds: [jobId] });
    assert.equal(enriched.locationsConfirmed, 1);
    assert.equal(enriched.officeAddressesConfirmed, 0);
    const location = enriched.snapshot.locations[0]!;
    assert.equal(location.countryCode, "CN");
    assert.equal(location.city, "上海市");
    assert.equal(location.district, "闵行区");
    assert.equal(location.coordinates, undefined);
    assert.equal(location.streetAddress, undefined);
    assert.equal(location.officeResolution, undefined);
    const result = await queryJobs(enriched.snapshot, query);
    assert.equal(result.totalJobs, 1);
    assert.equal(result.items[0]!.job.id, jobId);
    assert.equal(result.mapBuckets.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    repo.close();
  }
});
