import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry, type AtlasDataset, type ToolHandlerContext, type TrustedToolContext } from "@better-me/opportunities";
import { PlatformDetailLocationsSchema, parsePlatformJobLocations, parsePlatformVisibleOfficeLocations, type PreviewDetailLocationsInput, type ImportDetailLocationsInput } from "@better-me/source-adapters";
import { reviewedCardsPage, reviewedCardsSource } from "../src/reviewed-cards.ts";
import { projectSourcePage } from "../src/projection.ts";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.ts";
import { createReviewedDetailLocationsTools } from "../src/reviewed-detail-locations.ts";
import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";

const AT = "2026-10-19T00:00:00.000Z", CAPTURED = "2026-10-19T00:10:00.000Z", NOW = "2026-10-19T01:00:00.000Z";
const ACTOR = "synthetic:detail-locations";
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
function context(key = "detail-1", signal = new AbortController().signal): ToolHandlerContext {
  return { requestId: key, actorScope: ACTOR, idempotencyKey: key, signal, budget: { requests: 0, bytes: 2_000_000, timeoutMs: 30_000 },
    consumeRequests() { throw new Error("No network authorized"); }, consumeBytes() {},
    throwIfCancelled() { if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" }); } };
}
const trusted = (key: string): TrustedToolContext => ({ ...context(key), allowedEffects: ["read-index", "local-write"] });
const makeTools = (repository: JobRepository) => createReviewedDetailLocationsTools({ repository, now: () => NOW });
async function seed(repo: JobRepository, id = "123456789") {
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23", url = `https://www.liepin.com/job/${id}.shtml?synthetic=original`;
  const capture = { provider: "liepin" as const, pageUrl, capturedAt: AT, cards: [{ platform: "猎聘" as const, url,
    title: "合成 C# 工程师", company: "合成企业", locationText: "上海", salaryText: "20–30k", publicationText: "2026-10-01",
    cardText: "合成 C# 工程师 合成企业 上海 20–30k 2026-10-01", evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
      { field: "url" as const, selector: "a", text: url }, { field: "title" as const, selector: ".title", text: "合成 C# 工程师" },
      { field: "company" as const, selector: ".company", text: "合成企业" }, { field: "locationText" as const, selector: ".location", text: "上海" },
      { field: "salaryText" as const, selector: ".salary", text: "20–30k" }, { field: "publicationText" as const, selector: ".date", text: "2026-10-01" },
    ] } }] };
  const page = reviewedCardsPage(capture);
  page.records[0] = { ...page.records[0]!, completeness: "detail", description: "Synthetic complete JD with duties and requirements; this must remain byte-for-byte unchanged." };
  const before = await repo.readProjectionSnapshot();
  const projected = await projectSourcePage(before, reviewedCardsSource("liepin"), page, `seed-${id}`, { mode: "user-reviewed-browser" });
  for (const location of projected.delta.locations) location.kind = "unknown";
  await repo.importSnapshot(projected.delta, { actorScope: ACTOR, idempotencyKey: `seed-${id}`, expectedRevision: before.revision });
  const data = await repo.readSnapshot(); const listing = data.listings.find(entry => entry.sourceRecordId === id)!;
  return { jobId: listing.canonicalJobId!, listingId: listing.id };
}
function disclosure(url = "https://m.liepin.com/job/123456789.shtml?synthetic=detail", street = "Synthetic Road 10", capturedAt = CAPTURED, remote = false) {
  const parsed = parsePlatformJobLocations({ jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: street,
    addressLocality: "Shanghai", addressRegion: "Shanghai", addressCountry: "CN", postalCode: "020000" } }, ...(remote ? { jobLocationType: "TELECOMMUTE" } : {}) })!;
  return PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url, capturedAt, ...parsed });
}
const VISIBLE_STREET = "上海市浦东新区合成路100号 2号楼";
function visibleDisclosure(raw = VISIBLE_STREET) {
  return PlatformDetailLocationsSchema.parse({ version: 2, provider: "liepin", url: "https://m.liepin.com/job/123456789.shtml?synthetic=visible-detail", capturedAt: CAPTURED,
    ...parsePlatformVisibleOfficeLocations([{ selector: "liepin-work-address", label: "工作地址", text: raw }]) });
}
async function prepare(repo: JobRepository, target?: { jobId: string; listingId: string }, capture = disclosure()) {
  const before = await repo.readSnapshot(); const listing = before.listings.find(entry => entry.sourceRecordId === "123456789")!;
  const input: PreviewDetailLocationsInput = { ...(target ?? { jobId: listing.canonicalJobId!, listingId: listing.id }), expectedRevision: before.revision, capture };
  const tools = makeTools(repo); const preview = await tools[0].execute(input, context());
  const command: ImportDetailLocationsInput = { ...input, previewFingerprint: preview.previewFingerprint, reviewed: true };
  return { tools, input, preview, command };
}
async function commit(repo: JobRepository, key = "detail-1", capture = disclosure()) {
  const next = await prepare(repo, undefined, capture); return next.tools[1].execute(next.command, context(key));
}

test("address-only preview is read-only and import preserves job, JD, pay, company and original listing metadata", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo); const before = await repo.readSnapshot();
    const { tools, preview, command } = await prepare(repo, target);
    assert.deepEqual(await repo.readSnapshot(), before); assert.deepEqual(preview.previousLocationIds, before.jobs[0]!.locationIds);
    assert.equal(preview.newLocations[0]!.streetAddress, "Synthetic Road 10"); assert.equal(preview.newLocations[0]!.precision, "city");
    assert.equal(preview.newLocations[0]!.kind, "office"); assert.equal(preview.newLocations[0]!.coordinates, undefined);
    const receipt = await tools[1].execute(command, context()); const after = await repo.readSnapshot();
    assert.equal(receipt.counts.newJobs, 0); assert.equal(receipt.counts.newListings, 0); assert.equal(receipt.counts.newSnapshots, 0);
    assert.equal(receipt.counts.newObservations, 1); assert.deepEqual(receipt.jobIds, [target.jobId]); assert.deepEqual(receipt.snapshotIds, []);
    assert.equal(after.jobs.length, 1); assert.equal(after.listings.length, 1); assert.equal(after.jobs[0]!.description, before.jobs[0]!.description);
    const { locationIds: _locationsA, revision: _revisionA, updatedAt: _updatedA, ...jobA } = before.jobs[0]!;
    const { locationIds: _locationsB, revision: _revisionB, updatedAt: _updatedB, ...jobB } = after.jobs[0]!;
    assert.deepEqual(jobB, jobA); assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.compensations, before.compensations);
    assert.deepEqual(after.companies, before.companies); assert.deepEqual(after.sources, before.sources);
    const { locationIds: _lA, recordLastSeenAt: _seenA, observationIds: _oA, ...listingA } = before.listings[0]!;
    const { locationIds: _lB, recordLastSeenAt: _seenB, observationIds: _oB, ...listingB } = after.listings[0]!;
    assert.deepEqual(listingB, listingA); assert.equal(after.listings[0]!.canonicalUrl, before.listings[0]!.canonicalUrl);
    const location = after.locations.find(entry => entry.id === after.jobs[0]!.locationIds[0])!;
    assert.equal(location.verification, "unverified"); assert.equal(location.postalCode, "020000");
    assert.equal(location.evidence[0]!.sourceUrl, command.capture.url); assert.equal(location.evidence[0]!.quote, command.capture.locations[0]!.evidence.quote);
    const observation = after.observations.find(entry => !before.observations.some(old => old.id === entry.id))!;
    assert.equal(observation.snapshotId, undefined); assert.equal(observation.sourcePublishedAt, undefined); assert.equal(observation.sourcePublishedRaw, undefined);
    assert.equal(observation.completeness, "excerpt"); assert.equal(observation.availability, "unknown"); assert.equal(observation.result, "partial");
    assert.equal(JSON.parse(observation.rawText!).url, command.capture.url);
  } finally { repo.close(); }
});

test("V2 visible same-job street imports without inferred country or wire-only kind and preserves the merged job's JD, pay and other listing", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo), second = await seed(repo, "987654321"); const seeded = await repo.readSnapshot();
    await repo.mergeJobs({ targetJobId: second.jobId, sourceJobId: first.jobId, reason: "Synthetic reviewed shared requirement", companyIdentityConfirmed: true },
      { actorScope: ACTOR, idempotencyKey: "merge-before-visible", expectedRevision: seeded.revision });
    const before = await repo.readSnapshot(), originalOtherListing = before.listings.find(entry => entry.id === second.listingId)!;
    const prepared = await prepare(repo, { jobId: second.jobId, listingId: first.listingId }, visibleDisclosure());
    assert.deepEqual(await repo.readSnapshot(), before);
    const location = prepared.preview.newLocations[0]!;
    assert.equal(location.raw, VISIBLE_STREET); assert.equal(location.streetAddress, VISIBLE_STREET);
    assert.equal(location.countryCode, undefined); assert.equal(location.region, undefined); assert.equal(location.city, undefined); assert.equal(location.postalCode, undefined);
    assert.equal(location.precision, "unknown"); assert.equal(location.kind, "office"); assert.equal(location.verification, "unverified"); assert.equal(location.coordinates, undefined);
    assert.deepEqual(location.evidence[0], { observationId: location.evidence[0]!.observationId, sourceUrl: prepared.input.capture.url, observedAt: CAPTURED,
      selector: "liepin-work-address[0]", quote: prepared.input.capture.locations[0]!.evidence.quote });
    assert.equal("kind" in location.evidence[0]!, false);
    const receipt = await prepared.tools[1].execute(prepared.command, context("visible-merged")); const after = await repo.readSnapshot();
    assert.equal(receipt.counts.newJobs, 0); assert.equal(receipt.counts.newListings, 0); assert.equal(receipt.counts.newSnapshots, 0); assert.equal(receipt.counts.newObservations, 1);
    const { locationIds: _beforeLocations, revision: _beforeRevision, updatedAt: _beforeTime, ...beforeJob } = before.jobs[0]!;
    const { locationIds: _afterLocations, revision: _afterRevision, updatedAt: _afterTime, ...afterJob } = after.jobs[0]!;
    assert.deepEqual(afterJob, beforeJob); assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.compensations, before.compensations);
    assert.deepEqual(after.companies, before.companies); assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.listings.find(entry => entry.id === second.listingId), originalOtherListing);
    assert.ok(originalOtherListing.locationIds!.every(id => after.jobs[0]!.locationIds.includes(id)));
    assert.deepEqual(after.locations.find(entry => entry.id === location.id), location);
    const observation = after.observations.find(entry => !before.observations.some(prior => prior.id === entry.id))!;
    assert.deepEqual(JSON.parse(observation.rawText!), prepared.input.capture);
    assert.equal(JSON.parse(observation.rawText!).locations[0].evidence.kind, "visible-labelled-address");
    assert.equal(observation.sourcePublishedAt, undefined); assert.equal(observation.snapshotId, undefined);
    const repeated = await prepare(repo, { jobId: second.jobId, listingId: first.listingId }, visibleDisclosure());
    const replayReceipt = await repeated.tools[1].execute(repeated.command, context("visible-new-key"));
    assert.equal(replayReceipt.revision, receipt.revision); assert.equal(replayReceipt.counts.newObservations, 0); assert.deepEqual(await repo.readSnapshot(), after);
  } finally { repo.close(); }
});

test("V2 visible region-only disclosures do not acquire street or country precision during preview/import", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const prepared = await prepare(repo, undefined, visibleDisclosure("上海 浦东新区 合成园区"));
    const location = prepared.preview.newLocations[0]!;
    assert.equal(location.raw, "上海 浦东新区 合成园区"); assert.equal(location.streetAddress, undefined); assert.equal(location.countryCode, undefined);
    assert.equal(location.city, undefined); assert.equal(location.region, undefined); assert.equal(location.precision, "unknown"); assert.equal(location.coordinates, undefined);
    await prepared.tools[1].execute(prepared.command, context("visible-region"));
    assert.deepEqual((await repo.readSnapshot()).locations.find(entry => entry.id === location.id), location);
  } finally { repo.close(); }
});

test("V2 altered visible evidence, injected administration, V1 visible and wrong provider fail before any write", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const prepared = await prepare(repo, undefined, visibleDisclosure()), saved = await repo.readSnapshot();
    const capture = prepared.input.capture, location = capture.locations[0]!;
    const changedLocations = [
      { ...location, raw: "其他路200号" }, { ...location, streetAddress: "其他路200号" }, { ...location, countryCode: "CN" }, { ...location, city: "Shanghai" },
      { ...location, evidence: { ...location.evidence, selector: "liepin-work-address[1]" } },
      { ...location, evidence: { ...location.evidence, quote: JSON.stringify({ selector: "liepin-work-address", label: "公司地址", text: VISIBLE_STREET }) } },
      { ...location, evidence: { ...location.evidence, quote: "{}" } },
    ];
    for (const changed of [...changedLocations.map(location => ({ ...capture, locations: [location] })), { ...capture, version: 1 },
      { ...capture, provider: "boss", url: "https://www.zhipin.com/job_detail/synthetic123.html" }]) {
      await assert.rejects(prepared.tools[0].execute({ ...prepared.input, capture: changed } as PreviewDetailLocationsInput, context("invalid-visible-preview")), hasCode("invalid-input"));
      await assert.rejects(prepared.tools[1].execute({ ...prepared.command, capture: changed } as ImportDetailLocationsInput, context("invalid-visible-import")), hasCode("invalid-input"));
      assert.deepEqual(await repo.readSnapshot(), saved);
    }
  } finally { repo.close(); }
});

test("replaying a capture with a new preview/key makes no duplicate job, evidence or revision", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const first = await commit(repo); const saved = await repo.readSnapshot();
    const repeated = await commit(repo, "new-key-same-capture");
    assert.equal(repeated.revision, first.revision); assert.equal(repeated.counts.newObservations, 0); assert.deepEqual(repeated.jobIds, first.jobIds); assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("a historical same-instant capture cannot preview a change that would be silently ignored", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); await commit(repo); await commit(repo, "same-instant-b", disclosure(undefined, "Synthetic Road 20"));
    const saved = await repo.readSnapshot();
    await assert.rejects(prepare(repo, undefined, disclosure()), hasCode("stale-version"));
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("same-platform identity, exact target, stale input, source definition and captured time are enforced before any write", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo); const second = await seed(repo, "987654321"); const { tools, input, command } = await prepare(repo, first);
    const before = await repo.readSnapshot();
    for (const changed of [
      { ...input, jobId: second.jobId }, { ...input, listingId: second.listingId },
      { ...input, capture: disclosure("https://www.liepin.com/job/987654321.shtml") },
    ]) await assert.rejects(tools[0].execute(changed, context("wrong")), hasCode("invalid-input"));
    await assert.rejects(tools[0].execute({ ...input, expectedRevision: before.revision - 1 }, context()), hasCode("stale-version"));
    await assert.rejects(tools[0].execute({ ...input, capture: disclosure(undefined, undefined, "2026-10-19T01:05:00.001Z") }, context()), hasCode("invalid-input"));
    await assert.rejects(tools[0].execute({ ...input, capture: disclosure(undefined, undefined, "2026-10-18T23:59:59.000Z") }, context()), hasCode("stale-version"));
    await assert.rejects(tools[1].execute({ ...command, capture: disclosure(undefined, "Different Road 5") }, context()), hasCode("stale-version"));
    assert.deepEqual(await repo.readSnapshot(), before);
    await repo.registerSource({ ...reviewedCardsSource("liepin"), name: "Changed reserved policy" }, { actorScope: ACTOR, idempotencyKey: "change-policy", expectedRevision: before.revision });
    const occupied = await repo.readSnapshot();
    await assert.rejects(tools[0].execute({ ...input, expectedRevision: occupied.revision }, context()), hasCode("source-changed"));
  } finally { repo.close(); }
});

test("empty disclosures cannot delete old locations, unknown mode never inherits remote, and explicit remote stays non-office", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const before = await repo.readProjectionSnapshot(); const tools = makeTools(repo); const listing = before.listings[0]!;
    const remoteEmpty = PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url: listing.canonicalUrl!, capturedAt: CAPTURED,
      locations: [], workMode: "remote", workModeEvidence: { selector: "jobLocationType", quote: '"TELECOMMUTE"' } });
    await assert.rejects(tools[0].execute({ jobId: before.jobs[0]!.id, listingId: listing.id, expectedRevision: before.revision, capture: remoteEmpty }, context()), hasCode("invalid-input"));
    assert.deepEqual(await repo.readProjectionSnapshot(), before);
    const delta: AtlasDataset = { schemaVersion: 1, revision: before.revision, sources: [], companies: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [],
      jobs: [{ ...before.jobs[0]!, workMode: "remote", revision: before.jobs[0]!.revision + 1, updatedAt: AT }] };
    await repo.importSnapshot(delta, { actorScope: ACTOR, idempotencyKey: "seed-remote", expectedRevision: before.revision });
    const unknown = await prepare(repo); assert.equal(unknown.preview.newLocations[0]!.kind, "office");
    await unknown.tools[1].execute(unknown.command, context("unknown-mode")); assert.equal((await repo.readSnapshot()).jobs[0]!.workMode, "remote");
    const remote = await prepare(repo, undefined, disclosure(undefined, "Remote disclosed region", "2026-10-19T00:20:00.000Z", true));
    assert.equal(remote.preview.newLocations[0]!.kind, "remote-region"); assert.equal(remote.preview.newLocations[0]!.coordinates, undefined);
  } finally { repo.close(); }
});

test("only the selected listing contribution is replaced; other source locations and all selected facts survive", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo); const before = await repo.readProjectionSnapshot(); const original = before.jobs[0]!, listing = before.listings[0]!;
    const otherLocation = { ...before.locations[0]!, id: "synthetic-other-location", raw: "Other source location" };
    const otherListing = { ...listing, id: "synthetic-other-listing", sourceRecordId: "other", canonicalUrl: "https://www.liepin.com/job/555555555.shtml", locationIds: [otherLocation.id], observationIds: [] };
    const delta = { schemaVersion: 1 as const, revision: before.revision, sources: [], companies: [], locations: [otherLocation], compensations: [], observations: [], snapshots: [],
      listings: [otherListing], jobs: [{ ...original, locationIds: [...original.locationIds, otherLocation.id], listingIds: [...original.listingIds, otherListing.id], revision: original.revision + 1 }] };
    await repo.importSnapshot(delta, { actorScope: ACTOR, idempotencyKey: "other-contribution", expectedRevision: before.revision });
    await commit(repo); const after = await repo.readSnapshot();
    assert.ok(after.jobs[0]!.locationIds.includes(otherLocation.id)); assert.ok(!after.jobs[0]!.locationIds.includes(original.locationIds[0]!));
    assert.deepEqual(after.listings.find(entry => entry.id === otherListing.id), otherListing);
    assert.equal(after.listings.find(entry => entry.id === target.listingId)!.locationIds!.length, 1);
  } finally { repo.close(); }
});

test("location-scoped pay cannot be silently orphaned or rewritten by an address-only update", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const before = await repo.readProjectionSnapshot(); const pay = { ...before.compensations[0]!, id: "synthetic-scoped-pay", locationIds: before.jobs[0]!.locationIds };
    const delta = { schemaVersion: 1 as const, revision: before.revision, sources: [], companies: [], locations: [], observations: [], snapshots: [], listings: [], compensations: [pay],
      jobs: [{ ...before.jobs[0]!, compensationIds: [...before.jobs[0]!.compensationIds, pay.id], revision: before.jobs[0]!.revision + 1 }] };
    await repo.importSnapshot(delta, { actorScope: ACTOR, idempotencyKey: "scoped-pay", expectedRevision: before.revision });
    const saved = await repo.readSnapshot(); await assert.rejects(prepare(repo), hasCode("source-changed")); assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("durable receipt is recovered before stale projection after close/reopen, and changed request cannot reuse its key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "betterme-detail-locations-")), path = join(dir, "synthetic.sqlite");
  let repo = openJobRepository(path, { now: () => NOW });
  try {
    await seed(repo); const { tools, command } = await prepare(repo); const receipt = await tools[1].execute(command, context("durable"));
    await seed(repo, "987654321"); const saved = await repo.readSnapshot(); repo.close(); repo = openJobRepository(path, { now: () => NOW });
    assert.deepEqual(await makeTools(repo)[1].execute(command, context("durable")), receipt); assert.deepEqual(await repo.readSnapshot(), saved);
    const changed = await prepare(repo, undefined, disclosure(undefined, "Different street", "2026-10-19T00:20:00.000Z"));
    await assert.rejects(changed.tools[1].execute(changed.command, context("durable")), hasCode("idempotency-conflict"));
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("registry output failure recovers exactly the committed receipt without rerunning the mutation", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const { tools, command } = await prepare(repo); let writes = 0;
    const write = tools[1]; const registry = createToolRegistry([{ ...write, execute: async (input, ctx) => { writes++; await write.execute(input, ctx); return { wrong: true } as never; } }]);
    const first = await registry.execute(write.name, command, trusted("lost-output")); assert.equal(first.ok, false); if (!first.ok) assert.equal(first.error.code, "invalid-output");
    const saved = await repo.readSnapshot(); const second = await registry.execute(write.name, command, trusted("lost-output"));
    assert.equal(second.ok, true); assert.equal(writes, 1); assert.deepEqual(await repo.readSnapshot(), saved);
    assert.equal(await write.recoverInterrupted!({ ...command, expectedRevision: command.expectedRevision + 1 }, context("absent")), undefined);
  } finally { repo.close(); }
});

test("a concurrent identical CAS winner is recovered under the original request, not reprojected", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const prepared = await prepare(repo); const originalImport = repo.importSnapshot.bind(repo); let imports = 0;
    const wrapped: JobRepository = { ...repo, importSnapshot: async (...args) => { imports++; await originalImport(...args); throw new RepositoryError("stale-version"); } };
    const result = await makeTools(wrapped)[1].execute(prepared.command, context("concurrent-winner"));
    assert.equal(imports, 1); assert.equal(result.counts.newObservations, 1); assert.equal(result.counts.newJobs, 0);
    assert.equal((await repo.readSnapshot()).jobs.length, 1);
  } finally { repo.close(); }
});

test("concurrent equal commands return one receipt and append one observation", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const prepared = await prepare(repo);
    const results = await Promise.all(Array.from({ length: 3 }, () => prepared.tools[1].execute(prepared.command, context("equal-command"))));
    assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
    assert.equal(results[0]!.counts.newObservations, 1); assert.equal((await repo.readSnapshot()).observations.length, 2);
  } finally { repo.close(); }
});

test("cancelled response after commit recovers by key without another write", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const { tools, command } = await prepare(repo); const controller = new AbortController(); let writes = 0;
    const write = tools[1]; const registry = createToolRegistry([{ ...write, execute: async (input, ctx) => { writes++; const value = await write.execute(input, ctx); controller.abort(); return value; } }]);
    const first = await registry.execute(write.name, command, { ...trusted("cancelled-output"), signal: controller.signal });
    assert.equal(first.ok, false); if (!first.ok) assert.equal(first.error.code, "cancelled");
    const saved = await repo.readSnapshot(); const second = await registry.execute(write.name, command, trusted("cancelled-output"));
    assert.equal(second.ok, true); assert.equal(writes, 1); assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("merged canonical job can target its actual original platform listing without replacing another origin", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo); const second = await seed(repo, "987654321"); const before = await repo.readSnapshot();
    await repo.mergeJobs({ targetJobId: second.jobId, sourceJobId: first.jobId, reason: "Synthetic explicitly reviewed same requirement", companyIdentityConfirmed: true },
      { actorScope: ACTOR, idempotencyKey: "merge-before-detail", expectedRevision: before.revision });
    const canonical = await repo.readSnapshot(), otherLocationIds = canonical.listings.find(entry => entry.id === second.listingId)!.locationIds!;
    const prepared = await prepare(repo, { jobId: second.jobId, listingId: first.listingId });
    await assert.rejects(prepare(repo, { jobId: first.jobId, listingId: first.listingId }), hasCode("invalid-input"));
    const receipt = await prepared.tools[1].execute(prepared.command, context("merged-detail")); assert.deepEqual(receipt.jobIds, [second.jobId]);
    const after = await repo.readSnapshot(); assert.equal(after.jobs.length, 1); assert.ok(otherLocationIds.every(id => after.jobs[0]!.locationIds.includes(id)));
    assert.deepEqual(after.snapshots, canonical.snapshots); assert.equal(after.jobs[0]!.description, canonical.jobs[0]!.description);
    const origins = await repo.readProjectionSnapshot(); assert.equal(origins.jobs.length, 2);
    assert.equal(origins.jobs.find(entry => entry.id === first.jobId)!.locationIds.length, 1);
    assert.deepEqual(origins.jobs.find(entry => entry.id === second.jobId)!.locationIds, otherLocationIds);
  } finally { repo.close(); }
});

test("stale prepared command, absent target and cancelled command never create a job or source", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const tools = makeTools(repo); const capture = disclosure();
    await assert.rejects(tools[0].execute({ jobId: "missing-job", listingId: "missing-listing", expectedRevision: 0, capture }, context()), hasCode("source-changed"));
    assert.equal((await repo.readSnapshot()).jobs.length, 0); assert.equal((await repo.readSnapshot()).sources.length, 0);
    await seed(repo); const { command } = await prepare(repo); await seed(repo, "987654321"); const saved = await repo.readSnapshot();
    await assert.rejects(tools[1].execute(command, context()), hasCode("stale-version"));
    const fresh = await prepare(repo); const controller = new AbortController(); controller.abort();
    await assert.rejects(tools[1].execute(fresh.command, context("cancelled", controller.signal)), hasCode("cancelled"));
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("office confirmation is permanently invalidated on address A to B to A and does not revive after backup restore", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo); await commit(repo); const sourceA = await repo.readSnapshot(); const locationA = sourceA.jobs[0]!.locationIds[0]!;
    const value = { jobId: target.jobId, locationId: locationA, expectedRevision: sourceA.revision,
      reason: "Synthetic explicit office review", proposal: { basis: "manual-user-confirmation" as const, countryCode: "CN", streetAddress: "Synthetic Road 10", formattedAddress: "Shanghai Synthetic Road 10",
        coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, coordinateMeaning: "building" as const, evidenceUrl: "https://www.liepin.com/job/123456789.shtml" } };
    const preview = await repo.previewOfficeConfirmation(value);
    const confirmation = await repo.confirmOfficeAddress({ ...value, previewFingerprint: preview.previewFingerprint, reviewed: true }, { actorScope: ACTOR, idempotencyKey: "confirm-office", expectedRevision: value.expectedRevision });
    assert.ok(confirmation.location.officeResolution); assert.ok((await repo.readSnapshot()).locations.find(entry => entry.id === locationA)!.coordinates);
    await commit(repo, "address-b", disclosure(undefined, "Synthetic Road 20", "2026-10-19T00:20:00.000Z"));
    const sourceB = await repo.readSnapshot(); assert.ok(!sourceB.jobs[0]!.locationIds.includes(locationA));
    await commit(repo, "address-a-again", disclosure(undefined, "Synthetic Road 10", "2026-10-19T00:30:00.000Z"));
    const restored = await repo.readSnapshot(); assert.deepEqual(restored.jobs[0]!.locationIds, [locationA]);
    assert.equal(restored.locations.find(entry => entry.id === locationA)!.coordinates, undefined); assert.equal(restored.locations.find(entry => entry.id === locationA)!.officeResolution, undefined);
    const backup = await repo.backup(); assert.ok(backup.officeDecisions.some(entry => entry.kind === "invalidate" && entry.targetDecisionIds.includes(confirmation.decisionId)));
    const clone = openJobRepository(":memory:", { now: () => NOW });
    try { await clone.restore(backup, { actorScope: ACTOR, idempotencyKey: "restore", expectedRevision: 0 }); assert.equal((await clone.readSnapshot()).locations.find(entry => entry.id === locationA)!.coordinates, undefined); }
    finally { clone.close(); }
  } finally { repo.close(); }
});

for (const [version, makeCapture] of [["V1 JSON-LD", disclosure], ["V2 visible", visibleDisclosure]] as const) test(`authenticated HTTP preview/import exposes the ${version} same-index address flow and preserves JD`, async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW }); const target = await seed(repo);
  const app = createJobApplication({ repository: repo, now: () => NOW });
  const token = "synthetic-detail-locations-token-0123456789", origin = "http://synthetic-atlas.invalid";
  const server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: [origin], port: 0 }); const { url } = await server.listen();
  const request = async (path: string, value: unknown, key?: string, authorized = true) => {
    const response = await fetch(`${url}/api/v1/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(value) });
    return { status: response.status, data: await response.json() as { ok: boolean; value: any } };
  };
  try {
    const before = await repo.readSnapshot(); const input = { ...target, expectedRevision: before.revision, capture: makeCapture() };
    assert.equal((await request("jobs/detail-locations/preview", input, undefined, false)).status, 401);
    const preview = await request("jobs/detail-locations/preview", input); assert.equal(preview.status, 200); assert.equal(preview.data.ok, true);
    assert.deepEqual(await repo.readSnapshot(), before);
    const command = { ...input, reviewed: true, previewFingerprint: preview.data.value.previewFingerprint };
    const first = await request("jobs/detail-locations/import", command, "http-detail"); assert.equal(first.status, 200); assert.equal(first.data.value.counts.newJobs, 0);
    assert.deepEqual((await request("jobs/detail-locations/import", command, "http-detail")).data.value, first.data.value);
    const after = await repo.readSnapshot(); assert.equal(after.jobs[0]!.description, before.jobs[0]!.description);
    const storedLocation = after.locations.find(entry => entry.id === after.jobs[0]!.locationIds[0])!;
    assert.equal(storedLocation.streetAddress, input.capture.locations[0]!.streetAddress);
    assert.equal(storedLocation.evidence[0]!.selector, input.capture.locations[0]!.evidence.selector);
    assert.equal(storedLocation.evidence[0]!.quote, input.capture.locations[0]!.evidence.quote);
    assert.equal("kind" in storedLocation.evidence[0]!, false);
  } finally { await app.shutdown(); await server.close(); repo.close(); }
});
