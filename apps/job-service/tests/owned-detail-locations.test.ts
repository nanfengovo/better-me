import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry, ToolError, type SourceDefinition, type ToolHandlerContext, type TrustedToolContext } from "@better-me/opportunities";
import {
  createSourceRegistry, jobPostingJsonLdAdapter, readJobPostingJsonLd,
  OwnedDetailLocationsCaptureSchema, type SourceJobRecord, type SourceTransport,
  type ImportOwnedDetailLocationsInput, type PreviewOwnedDetailLocationsInput,
} from "@better-me/source-adapters";
import { createOwnedDetailLocationsTools } from "../src/owned-detail-locations.ts";
import { projectSourcePage } from "../src/projection.ts";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.ts";
import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";

const AT = "2026-10-19T00:00:00.000Z", READ = "2026-10-19T00:10:00.000Z", NOW = "2026-10-19T01:00:00.000Z";
const ORIGIN = "https://careers.synthetic-company.com", ACTOR = "synthetic:owned-office";
const url = (id = "job-1") => `${ORIGIN}/jobs/${id}`;
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
function context(key = "synthetic-owned-office", signal = new AbortController().signal): ToolHandlerContext {
  return { requestId: key, actorScope: ACTOR, idempotencyKey: key, signal, budget: { requests: 10, bytes: 8_000_000, timeoutMs: 20_000 },
    consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { if (signal.aborted) throw new ToolError("cancelled"); } };
}
const trusted = (key: string, effects: TrustedToolContext["allowedEffects"] = ["read-index", "external-read", "local-write"]): TrustedToolContext => ({ ...context(key), allowedEffects: effects });
function source(changes: Partial<SourceDefinition> = {}): SourceDefinition {
  return { sourceId: "synthetic-owned-source", name: "Synthetic reviewed company careers", adapterId: "jobposting-jsonld", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    entryUrl: `${ORIGIN}/list.xml`, options: { enumerationKind: "sitemap-urlset", enumerationUrls: [`${ORIGIN}/list.xml`], postingPathPrefixes: ["/jobs/"], pageSize: 2 },
    endpointPolicy: { allowedHosts: ["careers.synthetic-company.com"], allowedPathPrefixes: ["/jobs", "/list.xml"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic official source", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 20, maxPages: 3, requestsPerMinute: 30 }, ...changes };
}
function detail(id = "job-1", changes: Record<string, unknown> = {}) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", url: url(id),
    identifier: { "@type": "PropertyValue", value: id }, title: `Synthetic C# engineer ${id}`, hiringOrganization: { name: "Synthetic same employer" },
    description: "<p>Original complete job responsibilities and requirements.</p>", datePosted: "2026-09-01", baseSalary: "Original unnormalized pay",
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "CN", addressRegion: "Shanghai", addressLocality: "Shanghai", streetAddress: "Synthetic Road 10", postalCode: "020000" } }, ...changes })}</script></head></html>`;
}
const parsedRecord = (id = "job-1", changes: Record<string, unknown> = {}) => readJobPostingJsonLd(detail(id, changes), url(id)).record!;
async function seed(repo: JobRepository, id = "job-1", changes: Partial<SourceJobRecord> = {}, ownedSource = source()) {
  const before = await repo.readProjectionSnapshot();
  const record = { ...parsedRecord(id), locations: [{ raw: "Shanghai, CN", countryCode: "CN" as const, city: "Shanghai" }], ...changes };
  const projection = await projectSourcePage(before, ownedSource, { observedAt: AT, records: [record],
    coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, `seed-${ownedSource.sourceId}-${id}`);
  await repo.importSnapshot(projection.delta, { actorScope: ACTOR, expectedRevision: before.revision, idempotencyKey: `seed-${ownedSource.sourceId}-${id}` });
  const after = await repo.readSnapshot(), listing = after.listings.find(entry => entry.sourceId === ownedSource.sourceId
    && (entry.sourceRecordId === id || entry.canonicalUrl === record.url))!;
  return { jobId: listing.canonicalJobId!, listingId: listing.id };
}
function fixture(repository: JobRepository, changes: Record<string, unknown> = {}) {
  let time = READ, htmlChanges = changes;
  const calls: string[] = [];
  const transport: SourceTransport = { request: async ({ url: requested, context: ctx }) => {
    ctx.throwIfCancelled(); ctx.consumeRequests(); calls.push(requested);
    const html = detail(new URL(requested).pathname.split("/").at(-1), htmlChanges); ctx.consumeBytes(Buffer.byteLength(html));
    return { url: requested, status: 200, headers: {}, text: html };
  } };
  const tools = createOwnedDetailLocationsTools({ repository, sources: createSourceRegistry([jobPostingJsonLdAdapter]), transport, now: () => time });
  return { tools, calls, transport, setTime(value: string) { time = value; }, setDetail(value: Record<string, unknown>) { htmlChanges = value; } };
}
async function prepare(repo: JobRepository, f: ReturnType<typeof fixture>, target?: { jobId: string; listingId: string }) {
  const before = await repo.readSnapshot(), listing = before.listings.find(entry => entry.sourceRecordId === "job-1")!;
  const input = { ...(target ?? { jobId: listing.canonicalJobId!, listingId: listing.id }), expectedRevision: before.revision };
  const capture = await f.tools[0].execute(input, context("read"));
  const previewInput: PreviewOwnedDetailLocationsInput = { ...input, capture };
  const preview = await f.tools[1].execute(previewInput, context("preview"));
  const command: ImportOwnedDetailLocationsInput = { ...previewInput, previewFingerprint: preview.previewFingerprint, reviewed: true };
  return { input, capture, previewInput, preview, command };
}

test("exact source read and preview are read-only, then address-only import preserves every other fact and freshness", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const before = await repo.readSnapshot();
    const f = fixture(repo, { title: "Changed upstream title", description: "<p>Changed upstream JD</p>", baseSalary: "Changed upstream salary", datePosted: "2026-10-19" });
    const p = await prepare(repo, f);
    assert.deepEqual(f.calls, [url()]); assert.deepEqual(await repo.readSnapshot(), before);
    assert.equal(p.preview.newLocations[0]!.streetAddress, "Synthetic Road 10"); assert.equal(p.preview.newLocations[0]!.coordinates, undefined);
    const result = await f.tools[2].execute(p.command, context("save"));
    assert.equal(result.counts.newJobs, 0); assert.equal(result.counts.newListings, 0); assert.equal(result.counts.newSnapshots, 0); assert.equal(result.counts.newObservations, 1);
    const after = await repo.readSnapshot();
    const { locationIds: _la, revision: _ra, updatedAt: _ua, ...jobA } = before.jobs[0]!;
    const { locationIds: _lb, revision: _rb, updatedAt: _ub, ...jobB } = after.jobs[0]!;
    assert.deepEqual(jobB, jobA); assert.deepEqual(after.companies, before.companies); assert.deepEqual(after.compensations, before.compensations);
    assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.sources, before.sources);
    const { locationIds: _ca, observationIds: _oa, ...listingA } = before.listings[0]!;
    const { locationIds: _cb, observationIds: _ob, ...listingB } = after.listings[0]!;
    assert.deepEqual(listingB, listingA, "location-only reading must not advance recordLastSeenAt or replace original URL/publication");
    const added = after.observations.find(entry => !before.observations.some(previous => previous.id === entry.id))!;
    assert.equal(added.detailFetchedAt, READ); assert.equal(added.feedFetchedAt, undefined); assert.equal(added.snapshotId, undefined);
    assert.equal(added.sourcePublishedAt, undefined); assert.equal(added.sourcePublishedRaw, undefined); assert.equal(added.availability, "unknown");
    assert.deepEqual(JSON.parse(added.rawText!), p.capture); assert.equal(f.calls.length, 1, "preview and import never read a source again");
  } finally { repo.close(); }
});

test("a signed capture cannot be altered, invented or copied onto another job/listing, while JSON field order is immaterial", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo), second = await seed(repo, "job-2"), f = fixture(repo), p = await prepare(repo, f, first), saved = await repo.readSnapshot();
    const altered = [
      { ...p.capture, sourceFingerprint: "0".repeat(64) }, { ...p.capture, proof: "0".repeat(64) },
      { ...p.capture, record: { ...p.capture.record, locations: [{ raw: "Invented headquarters", streetAddress: "Invented Road 100" }] } },
      { ...p.capture, record: { ...p.capture.record, evidence: [] } }, { ...p.capture, observedAt: AT },
      { ...p.capture, readSessionId: "0".repeat(32) }, { ...p.capture, readSequence: p.capture.readSequence + 1 },
    ];
    for (const capture of altered) await assert.rejects(f.tools[1].execute({ ...p.previewInput, capture }, context()), hasCode("source-changed"));
    await assert.rejects(f.tools[1].execute({ ...p.previewInput, ...second }, context()), hasCode("invalid-input"));
    assert.equal(OwnedDetailLocationsCaptureSchema.safeParse({ ...p.capture, record: { ...p.capture.record, url: url("other") } }).success, false);
    const reordered = Object.fromEntries(Object.entries(p.capture).reverse());
    assert.deepEqual(await f.tools[1].execute({ ...p.previewInput, capture: reordered } as PreviewOwnedDetailLocationsInput, context()), p.preview);
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("stale or unowned reads fail without network; arbitrary URLs and source selectors are not accepted", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo), second = await seed(repo, "job-2"), f = fixture(repo), revision = (await repo.readSnapshot()).revision;
    for (const [input, code] of [
      [{ ...first, expectedRevision: revision - 1 }, "stale-version"],
      [{ ...first, listingId: second.listingId, expectedRevision: revision }, "invalid-input"],
      [{ ...first, jobId: "missing", expectedRevision: revision }, "invalid-input"],
      [{ ...first, expectedRevision: revision, url: "https://attacker.example/jobs/1" }, "invalid-input"],
      [{ ...first, expectedRevision: revision, sourceId: "another-source" }, "invalid-input"],
    ] as const) await assert.rejects(f.tools[0].execute(input, context()), hasCode(code));
    assert.deepEqual(f.calls, []);
    const registry = createToolRegistry(f.tools);
    const denied = await registry.execute(f.tools[0].name, { ...first, expectedRevision: revision }, trusted("denied", ["read-index"]));
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "not-authorized"); assert.deepEqual(f.calls, []);
  } finally { repo.close(); }
});

test("source configuration, exact identity and revision are checked again after a network read", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo), before = await repo.readSnapshot();
    const sources = createSourceRegistry([jobPostingJsonLdAdapter]);
    const tools = createOwnedDetailLocationsTools({ repository: repo, sources, now: () => READ, transport: { request: async input => {
      await seed(repo, "concurrent-job"); return { url: input.url, status: 200, headers: {}, text: detail() };
    } } });
    await assert.rejects(tools[0].execute({ ...first, expectedRevision: before.revision }, context()), hasCode("stale-version"));
    assert.equal((await repo.readSnapshot()).observations.length, 2, "only the unrelated concurrent seed was written");
    let changed = false;
    const wrapped: JobRepository = { ...repo, readProjectionSnapshot: async () => {
      const data = await repo.readProjectionSnapshot(); if (changed) data.sources[0]!.attribution.label = "Changed source policy"; return data;
    } };
    const changedTools = createOwnedDetailLocationsTools({ repository: wrapped, sources, now: () => READ, transport: { request: async input => {
      changed = true; return { url: input.url, status: 200, headers: {}, text: detail() };
    } } });
    await assert.rejects(changedTools[0].execute({ ...first, expectedRevision: (await repo.readSnapshot()).revision }, context()), hasCode("source-changed"));
  } finally { repo.close(); }
});

test("an empty disclosure cannot delete an address, remote evidence creates no office or work-mode override", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo, "job-1", { workMode: "hybrid" }), f = fixture(repo, { jobLocation: undefined, jobLocationType: "TELECOMMUTE" });
    const before = await repo.readSnapshot(), input = { ...target, expectedRevision: before.revision };
    const empty = await f.tools[0].execute(input, context()); assert.deepEqual(empty.record.locations, []);
    await assert.rejects(f.tools[1].execute({ ...input, capture: empty }, context()), hasCode("invalid-input")); assert.deepEqual(await repo.readSnapshot(), before);
    f.setDetail({ jobLocationType: "TELECOMMUTE" }); const p = await prepare(repo, f, target);
    assert.equal(p.preview.newLocations[0]!.kind, "remote-region"); await f.tools[2].execute(p.command, context("remote"));
    const after = await repo.readSnapshot(); assert.equal(after.jobs[0]!.workMode, "hybrid");
    assert.equal(after.locations.find(entry => entry.id === after.jobs[0]!.locationIds[0])!.kind, "remote-region");
    assert.equal(after.locations.find(entry => entry.id === after.jobs[0]!.locationIds[0])!.coordinates, undefined);
  } finally { repo.close(); }
});

test("a changed source policy invalidates a prepared capture before changed capability or secret checks", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); let change: Partial<SourceDefinition> = {};
    const wrapped: JobRepository = { ...repo, readProjectionSnapshot: async () => {
      const data = await repo.readProjectionSnapshot(); data.sources[0] = { ...data.sources[0]!, ...change }; return data;
    } };
    const f = fixture(wrapped), p = await prepare(repo, f), before = await repo.readSnapshot();
    for (const value of [{ enabled: false }, { adapterVersion: "99" }, { secretRef: "host-private-reference" }]) {
      change = value; await assert.rejects(f.tools[1].execute(p.previewInput, context()), hasCode("source-changed"));
    }
    assert.deepEqual(await repo.readSnapshot(), before); assert.equal(f.calls.length, 1);
  } finally { repo.close(); }
});

test("unsigned records without location evidence and unsupported adapters never become savable location captures", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo), before = await repo.readSnapshot(), f = fixture(repo);
    const noEvidence = { ...jobPostingJsonLdAdapter, async readDetail() { return { ...parsedRecord(), evidence: [] }; } };
    const tools = createOwnedDetailLocationsTools({ repository: repo, sources: createSourceRegistry([noEvidence]), transport: f.transport, now: () => READ });
    const capture = await tools[0].execute({ ...target, expectedRevision: before.revision }, context());
    await assert.rejects(tools[1].execute({ ...target, expectedRevision: before.revision, capture }, context()), hasCode("source-changed"));
    const unsupported = createOwnedDetailLocationsTools({ repository: repo, sources: createSourceRegistry([{ ...jobPostingJsonLdAdapter, readDetail: undefined }]), transport: f.transport, now: () => READ });
    await assert.rejects(unsupported[0].execute({ ...target, expectedRevision: before.revision }, context()), hasCode("unsupported-capability"));
    assert.deepEqual(f.calls, []); assert.deepEqual(await repo.readSnapshot(), before);
  } finally { repo.close(); }
});

test("latest detail observation prevents an older still-uncommitted signed capture from overwriting a later address", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), old = await prepare(repo, f);
    f.setTime("2026-10-19T00:20:00.000Z"); f.setDetail({ jobLocation: { address: { streetAddress: "Synthetic Road 20", addressLocality: "Shanghai", addressCountry: "CN" } } });
    const next = await prepare(repo, f); await f.tools[2].execute(next.command, context("newer"));
    const saved = await repo.readSnapshot();
    await assert.rejects(f.tools[1].execute({ ...old.previewInput, expectedRevision: saved.revision }, context()), hasCode("stale-version"));
    assert.equal(saved.listings[0]!.recordLastSeenAt, AT); assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("a signed capture is reusable after unrelated writes, while a saved replay is a true no-op", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), p = await prepare(repo, f); await seed(repo, "unrelated-job");
    const input = { ...p.previewInput, expectedRevision: (await repo.readSnapshot()).revision };
    const preview = await f.tools[1].execute(input, context()), command = { ...input, reviewed: true as const, previewFingerprint: preview.previewFingerprint };
    const first = await f.tools[2].execute(command, context("first")), saved = await repo.readSnapshot();
    const again = { ...input, expectedRevision: saved.revision }, againPreview = await f.tools[1].execute(again, context());
    const second = await f.tools[2].execute({ ...again, reviewed: true, previewFingerprint: againPreview.previewFingerprint }, context("new-key"));
    assert.equal(second.revision, first.revision); assert.equal(second.counts.newObservations, 0); assert.deepEqual(await repo.readSnapshot(), saved);
    assert.equal(f.calls.length, 1);
  } finally { repo.close(); }
});

test("same-millisecond uncommitted reads cannot be adopted in reverse order to restore an older address", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), older = await prepare(repo, f);
    f.setDetail({ jobLocation: { address: { streetAddress: "Synthetic New Road 20", addressCountry: "CN", addressLocality: "Shanghai" } } });
    const later = await prepare(repo, f); assert.equal(older.capture.observedAt, later.capture.observedAt);
    assert.equal(older.capture.readSessionId, later.capture.readSessionId); assert.ok(later.capture.readSequence > older.capture.readSequence);
    await f.tools[2].execute(later.command, context("later-first")); const saved = await repo.readSnapshot();
    await assert.rejects(f.tools[1].execute({ ...older.previewInput, expectedRevision: saved.revision }, context()), hasCode("stale-version"));
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("durable committed receipts survive reopen and a new transient proof secret; unsaved captures require another read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "betterme-owned-office-")), path = join(dir, "synthetic.sqlite");
  let repo = openJobRepository(path, { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), p = await prepare(repo, f), receipt = await f.tools[2].execute(p.command, context("durable"));
    await seed(repo, "another-job"); const saved = await repo.readSnapshot(); repo.close(); repo = openJobRepository(path, { now: () => NOW });
    const restarted = fixture(repo);
    assert.deepEqual(await restarted.tools[2].execute(p.command, context("durable")), receipt); assert.deepEqual(await repo.readSnapshot(), saved);
    await assert.rejects(restarted.tools[1].execute({ ...p.previewInput, expectedRevision: saved.revision }, context()), hasCode("source-changed"));
    const changed = await prepare(repo, restarted);
    await assert.rejects(restarted.tools[2].execute(changed.command, context("durable")), hasCode("idempotency-conflict"));
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("output loss and post-commit cancellation recover without executing a second write", async () => {
  for (const mode of ["output", "cancel"] as const) {
    const repo = openJobRepository(":memory:", { now: () => NOW });
    try {
      await seed(repo); const f = fixture(repo), p = await prepare(repo, f), write = f.tools[2], controller = new AbortController(); let writes = 0;
      const registry = createToolRegistry([{ ...write, execute: async (input, ctx) => {
        writes++; const value = await write.execute(input, ctx); if (mode === "cancel") controller.abort(); return mode === "output" ? { wrong: true } as never : value;
      } }]);
      const first = await registry.execute(write.name, p.command, { ...trusted(`lost-${mode}`), signal: controller.signal });
      assert.equal(first.ok, false); if (!first.ok) assert.equal(first.error.code, mode === "output" ? "invalid-output" : "cancelled");
      const saved = await repo.readSnapshot(), second = await registry.execute(write.name, p.command, trusted(`lost-${mode}`));
      assert.equal(second.ok, true); assert.equal(writes, 1); assert.deepEqual(await repo.readSnapshot(), saved);
    } finally { repo.close(); }
  }
});

test("concurrent equal saves share one durable receipt, including a CAS winner whose response is lost", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const originalImport = repo.importSnapshot.bind(repo); let writes = 0;
    const wrapped: JobRepository = { ...repo, importSnapshot: async (...args) => { writes++; const receipt = await originalImport(...args); if (writes === 1) throw new RepositoryError("stale-version"); return receipt; } };
    const f = fixture(wrapped), p = await prepare(repo, f);
    const results = await Promise.all(Array.from({ length: 3 }, () => f.tools[2].execute(p.command, context("same-command"))));
    assert.ok(results.every(entry => JSON.stringify(entry) === JSON.stringify(results[0])));
    assert.equal(results[0]!.counts.newObservations, 1); assert.equal((await repo.readSnapshot()).observations.length, 2);
  } finally { repo.close(); }
});

test("merged canonical jobs can update their actual original listing and preserve the other origin", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const first = await seed(repo), second = await seed(repo, "job-2"), before = await repo.readSnapshot();
    await repo.mergeJobs({ targetJobId: second.jobId, sourceJobId: first.jobId, reason: "Synthetic explicitly reviewed same requirement", companyIdentityConfirmed: true },
      { actorScope: ACTOR, idempotencyKey: "merge", expectedRevision: before.revision });
    const canonical = await repo.readSnapshot(), other = canonical.listings.find(entry => entry.id === second.listingId)!;
    const f = fixture(repo); await assert.rejects(prepare(repo, f, first), hasCode("invalid-input"));
    const p = await prepare(repo, f, { jobId: second.jobId, listingId: first.listingId });
    const receipt = await f.tools[2].execute(p.command, context("merged-save")), after = await repo.readSnapshot();
    assert.deepEqual(receipt.jobIds, [second.jobId]); assert.equal(after.jobs.length, 1);
    assert.deepEqual(after.listings.find(entry => entry.id === other.id), other); assert.ok(other.locationIds!.every(id => after.jobs[0]!.locationIds.includes(id)));
    assert.deepEqual(after.snapshots, canonical.snapshots); assert.equal(after.jobs[0]!.description, canonical.jobs[0]!.description);
    assert.equal((await repo.readProjectionSnapshot()).jobs.length, 2);
  } finally { repo.close(); }
});

test("location-scoped compensation cannot be orphaned by an address-only write", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const before = await repo.readProjectionSnapshot(), job = before.jobs[0]!;
    const scoped = { ...before.compensations[0]!, id: "synthetic-scoped-compensation", locationIds: job.locationIds };
    await repo.importSnapshot({ schemaVersion: 1, revision: before.revision, sources: [], companies: [], locations: [], listings: [], observations: [], snapshots: [],
      compensations: [scoped], jobs: [{ ...job, compensationIds: [...job.compensationIds, scoped.id], revision: job.revision + 1 }] },
    { actorScope: ACTOR, idempotencyKey: "scope-pay", expectedRevision: before.revision });
    const saved = await repo.readSnapshot(), f = fixture(repo); await assert.rejects(prepare(repo, f), hasCode("source-changed"));
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("office confirmations remain invalid after A to B to A and repository backup restore", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    const target = await seed(repo), f = fixture(repo), a = await prepare(repo, f); await f.tools[2].execute(a.command, context("address-a"));
    const sourceA = await repo.readSnapshot(), locationId = sourceA.jobs[0]!.locationIds[0]!;
    const input = { jobId: target.jobId, locationId, expectedRevision: sourceA.revision, reason: "Synthetic explicitly reviewed office point",
      proposal: { basis: "manual-user-confirmation" as const, countryCode: "CN", streetAddress: "Synthetic Road 10", formattedAddress: "Shanghai Synthetic Road 10",
        coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, coordinateMeaning: "building" as const, evidenceUrl: url() } };
    const preview = await repo.previewOfficeConfirmation(input);
    const decision = await repo.confirmOfficeAddress({ ...input, reviewed: true, previewFingerprint: preview.previewFingerprint },
      { actorScope: ACTOR, idempotencyKey: "office", expectedRevision: input.expectedRevision });
    f.setTime("2026-10-19T00:20:00.000Z"); f.setDetail({ jobLocation: { address: { streetAddress: "Synthetic Road 20", addressLocality: "Shanghai", addressCountry: "CN" } } });
    const b = await prepare(repo, f); await f.tools[2].execute(b.command, context("address-b"));
    f.setTime("2026-10-19T00:30:00.000Z"); f.setDetail({}); const again = await prepare(repo, f); await f.tools[2].execute(again.command, context("address-a-again"));
    const after = await repo.readSnapshot(); assert.deepEqual(after.jobs[0]!.locationIds, [locationId]);
    assert.equal(after.locations.find(entry => entry.id === locationId)!.coordinates, undefined); assert.equal(after.locations.find(entry => entry.id === locationId)!.officeResolution, undefined);
    const backup = await repo.backup(); assert.ok(backup.officeDecisions.some(entry => entry.kind === "invalidate" && entry.targetDecisionIds.includes(decision.decisionId)));
    const clone = openJobRepository(":memory:", { now: () => NOW });
    try { await clone.restore(backup, { actorScope: ACTOR, idempotencyKey: "restore", expectedRevision: 0 }); assert.equal((await clone.readSnapshot()).locations.find(entry => entry.id === locationId)!.coordinates, undefined); }
    finally { clone.close(); }
  } finally { repo.close(); }
});

test("authenticated HTTP read/preview/import uses the same exact source and refuses unauthorized or missing-key writes", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW }), target = await seed(repo), f = fixture(repo);
  const app = createJobApplication({ repository: repo, transport: f.transport, now: () => READ });
  const token = "synthetic-owned-office-token-0123456789", origin = "http://synthetic-atlas.invalid";
  const server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: [origin], port: 0 }), { url: base } = await server.listen();
  const request = async (path: string, body: unknown, key?: string, authorized = true) => {
    const response = await fetch(`${base}/api/v1/jobs/owned-detail-locations/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { ok: boolean; value: any; error?: { code: string } } };
  };
  try {
    const before = await repo.readSnapshot(), input = { ...target, expectedRevision: before.revision };
    assert.equal((await request("read", input, undefined, false)).status, 401); assert.equal(f.calls.length, 0);
    const read = await request("read", input); assert.equal(read.status, 200); assert.equal(read.body.ok, true); assert.deepEqual(f.calls, [url()]);
    const previewInput = { ...input, capture: read.body.value }, preview = await request("preview", previewInput); assert.equal(preview.status, 200);
    assert.deepEqual(await repo.readSnapshot(), before);
    const command = { ...previewInput, reviewed: true, previewFingerprint: preview.body.value.previewFingerprint };
    const missingKey = await request("import", command); assert.equal(missingKey.body.ok, false); assert.deepEqual(await repo.readSnapshot(), before);
    const first = await request("import", command, "http-owned-detail"); assert.equal(first.status, 200); assert.equal(first.body.value.counts.newObservations, 1);
    assert.deepEqual((await request("import", command, "http-owned-detail")).body.value, first.body.value);
    assert.equal(f.calls.length, 1); assert.deepEqual((await repo.readSnapshot()).snapshots, before.snapshots);
    const plan = await app.registry.execute("jobs.plan-address-enrichment", { jobIds: [target.jobId], expectedRevision: (await repo.readSnapshot()).revision }, trusted("plan"));
    assert.equal(plan.ok, true); if (plan.ok) assert.equal((plan.value as any).items[0].ownedOfficialTargets[0].exactDetail, true);
  } finally { await app.shutdown(); await server.close(); repo.close(); }
});

test("default host plans distinguish installed exact readers from preserved legacy official clues", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  const app = createJobApplication({ repository: repo, now: () => NOW });
  try {
    const exact = await seed(repo), legacy = await seed(repo, "greenhouse-job", {}, source({ sourceId: "synthetic-greenhouse", adapterId: "greenhouse" }));
    const withoutId = await seed(repo, "url-only", { sourceRecordId: undefined });
    const before = await repo.readSnapshot();
    const result = await app.registry.execute("jobs.plan-address-enrichment", { jobIds: [exact.jobId, legacy.jobId, withoutId.jobId], expectedRevision: before.revision }, trusted("plan-capabilities"));
    assert.equal(result.ok, true); if (!result.ok) throw new Error(result.error.code);
    const items = (result.value as any).items;
    assert.equal(items[0].ownedOfficialTargets[0].exactDetail, true);
    assert.equal(items[1].ownedOfficialTargets[0].exactDetail, undefined, "legacy installed protocol remains an actionable clue, not an exact reader");
    assert.equal(items[1].ownedOfficialTargets[0].adapterId, "greenhouse");
    assert.equal(items[2].ownedOfficialTargets[0].exactDetail, undefined, "URL-only records lack this version's strict source-ID binding but retain their clue");
    assert.deepEqual(await repo.readSnapshot(), before);
  } finally { await app.shutdown(); repo.close(); }
});
