import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema, queryJobs } from "@better-me/opportunities";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { BrowseDatasetSchema, BrowseResponseSchema, BROWSE_PROTOCOL, projectBrowseRows } from "../../job-service/src/browse-contract.ts";
import { emptyDatasetDeletes, emptyDatasetUpserts } from "../../job-service/src/dataset-sync-contract.ts";
import { createAtlasListingPresenter } from "../src/components/atlas/presentation.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";

test("browse compaction preserves publication conflicts, fact provenance and coverage while leaving complete evidence untouched", async () => {
  const data = syntheticAtlas(2), listing = data.listings[0]!, original = data.observations[0]!;
  data.observations.push({ ...original, id: "historic-diagnostic", warnings: ["old diagnostic history"], result: "failed", availability: "unknown" });
  listing.observationIds.push("historic-diagnostic");
  for (const [index, date] of ["2026-11-15", "2026-11-16"].entries()) {
    const id = `publication-${index}`;
    data.observations.push({ ...original, id, sourcePublishedRaw: date, fetchedAt: "2026-11-17T00:00:00.000Z", warnings: ["diagnostic detail only"] });
    listing.observationIds.push(id);
  }
  const before = structuredClone(data);
  const view = BrowseDatasetSchema.parse({ ...projectBrowseRows(data), schemaVersion: 1, revision: data.revision, view: "browse" });
  assert.deepEqual(data, before, "compaction is not a durable migration");
  assert.equal(view.observations.some(row => row.id === "historic-diagnostic"), false);
  assert.ok(view.observations.every(row => row.warnings.length === 0 && !row.rawText && !row.snapshotId && !row.contentHash));
  assert.deepEqual(view.jobs[0]!.title.evidence.map(({ observationId, sourceUrl, observedAt }) => ({ observationId, sourceUrl, observedAt })), data.jobs[0]!.title.evidence.map(({ observationId, sourceUrl, observedAt }) => ({ observationId, sourceUrl, observedAt })));
  assert.ok(view.jobs[0]!.title.evidence.every(row => !row.quote && !row.selector));
  assert.deepEqual(getAtlasDataCoverage(view), getAtlasDataCoverage(data));
  const items = (await queryJobs(data, {})).items, options = { now: Date.parse("2026-11-17T00:00:00.000Z") };
  assert.deepEqual(items.map(createAtlasListingPresenter(view, options)), items.map(createAtlasListingPresenter(data, options)));
  assert.equal(AtlasDatasetSchema.safeParse(view).success, false, "display projections can never replace full backups");
});

test("browse deltas reject duplicate upserts, duplicate deletes and overlapping deletes before applying any row", () => {
  const upserts = emptyDatasetUpserts(), deletes = emptyDatasetDeletes(), source = syntheticAtlas(1);
  const delta = { protocol: BROWSE_PROTOCOL, kind: "delta", snapshot: "b".repeat(32), base: "a".repeat(32), revision: 2, upserts, deletes };
  upserts.jobs = [source.jobs[0]!, source.jobs[0]!];
  assert.equal(BrowseResponseSchema.safeParse(delta).success, false);
  upserts.jobs = []; deletes.jobs = [source.jobs[0]!.id, source.jobs[0]!.id];
  assert.equal(BrowseResponseSchema.safeParse(delta).success, false);
  upserts.jobs = [source.jobs[0]!]; deletes.jobs = [source.jobs[0]!.id];
  assert.equal(BrowseResponseSchema.safeParse(delta).success, false);
});
