import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry, ToolError, type SourceDefinition, type ToolHandlerContext, type TrustedToolContext } from "@better-me/opportunities";
import {
  createSourceRegistry, jobPostingJsonLdAdapter, OriginalLeadCaptureSchema, readJobPostingJsonLd,
  type DiscoveryLead, type OriginalLeadImportInput, type SourceTransport,
} from "@better-me/source-adapters";
import { createLeadResolutionTools } from "../src/lead-resolution.ts";
import { projectSourcePage } from "../src/projection.ts";
import { openJobRepository, type JobRepository } from "../src/repository.ts";

const AT = "2026-10-23T00:00:00.000Z", READ = "2026-10-23T00:10:00.000Z", NOW = "2026-10-23T01:00:00.000Z";
const ORIGIN = "https://careers.synthetic-leads.com", URL = `${ORIGIN}/jobs/original-1`, ACTOR = "synthetic:lead-resolution";
const hasCode = (...codes: string[]) => (error: unknown) => !!error && typeof error === "object" && "code" in error && codes.includes(String(error.code));
function context(key = "synthetic-lead-command", signal = new AbortController().signal): ToolHandlerContext {
  return { requestId: key, actorScope: ACTOR, idempotencyKey: key, signal, budget: { requests: 10, bytes: 8_000_000, timeoutMs: 20_000 },
    consumeRequests() {}, consumeBytes() {}, throwIfCancelled() { if (signal.aborted) throw new ToolError("cancelled"); } };
}
const trusted = (key: string, effects: TrustedToolContext["allowedEffects"] = ["read-index", "external-read", "local-write"]): TrustedToolContext => ({ ...context(key), allowedEffects: effects });
function originalSource(changes: Partial<SourceDefinition> = {}): SourceDefinition {
  return { sourceId: "original-source", name: "Synthetic original employer", adapterId: "jobposting-jsonld", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    entryUrl: `${ORIGIN}/list.xml`, options: { enumerationKind: "sitemap-urlset", enumerationUrls: [`${ORIGIN}/list.xml`], postingPathPrefixes: ["/jobs/"], pageSize: 2 },
    endpointPolicy: { allowedHosts: ["careers.synthetic-leads.com"], allowedPathPrefixes: ["/jobs", "/list.xml"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic reviewed original", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 20, maxPages: 3, requestsPerMinute: 30 }, ...changes };
}
function discoverySource(index: number): SourceDefinition {
  return { ...originalSource(), sourceId: `discovery-source-${index}`, name: `Synthetic GitHub discovery ${index}`, adapterId: "github-discovery-only",
    capabilities: [], entityType: "company-directory", enabled: true, status: "active", entryUrl: `https://github.com/synthetic-${index}/jobs`, options: undefined,
    endpointPolicy: { allowedHosts: ["github.com"], allowedPathPrefixes: [`/synthetic-${index}/jobs`], requireHttps: true, allowRedirects: false, maxRedirects: 0 } };
}
function lead(index: number, changes: Partial<DiscoveryLead> = {}): DiscoveryLead {
  return { id: `lead-${index}`, sourceId: discoverySource(index).sourceId, observedAt: AT,
    record: { entityType: "discovery-lead", sourceRecordId: `github-entry-${index}`, url: URL, title: `Synthetic C# lead ${index}`,
      description: "A discovery clue only; not the original job description.", locations: [], compensations: [], workMode: "unknown", employmentType: "unknown",
      remoteEligibleRegions: [], availability: "unknown", completeness: "lead", evidence: [], warnings: ["Unverified discovery lead"] }, ...changes };
}
function detail(changes: Record<string, unknown> = {}) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", url: URL,
    identifier: { "@type": "PropertyValue", value: "original-1" }, title: "Synthetic original C# engineer", hiringOrganization: { name: "Synthetic same employer" },
    description: "<p>Complete original responsibilities and qualifications from the synthetic employer.</p>", datePosted: "2026-10-01",
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Synthetic Road 10" } }, ...changes })}</script></head></html>`;
}
async function seed(repository: JobRepository, count = 2) {
  for (const source of [originalSource(), ...Array.from({ length: count }, (_, i) => discoverySource(i + 1))]) {
    await repository.registerSource(source, { actorScope: ACTOR, expectedRevision: (await repository.readSnapshot()).revision, idempotencyKey: `seed-${source.sourceId}` });
  }
  await repository.saveDiscoveryLeads(Array.from({ length: count }, (_, i) => lead(i + 1)), { actorScope: ACTOR, idempotencyKey: "seed-leads" });
}
function fixture(repository: JobRepository) {
  const calls: Array<{ url: string; sourceId: string }> = [];
  let response = detail();
  const transport: SourceTransport = { async request(input) {
    input.context.throwIfCancelled(); input.context.consumeRequests();
    calls.push({ url: input.url, sourceId: input.source.sourceId });
    assert.equal(input.url, URL, "Reading a held original never enumerates the source or follows the discovery source.");
    assert.equal(input.source.sourceId, originalSource().sourceId, "The independently registered original source authorizes this read.");
    input.context.consumeBytes(Buffer.byteLength(response));
    return { url: input.url, status: 200, headers: { "content-type": "text/html" }, text: response };
  } };
  const tools = createLeadResolutionTools({ repository, sources: createSourceRegistry([jobPostingJsonLdAdapter]), transport, now: () => READ });
  return { tools, calls, transport, setHtml(html: string) { response = html; } };
}
async function prepare(repository: JobRepository, f: ReturnType<typeof fixture>, leadId = "lead-1") {
  const read = await f.tools[1].execute({ leadId }, context("read-lead"));
  const input = { leadId, leadDigest: read.leadDigest, originalSourceId: originalSource().sourceId, expectedRevision: read.snapshotRevision };
  const capture = await f.tools[2].execute(input, context("read-original"));
  const previewInput = { capture, expectedRevision: read.snapshotRevision };
  const preview = await f.tools[3].execute(previewInput, context("preview-original"));
  const command: OriginalLeadImportInput = { ...previewInput, reviewed: true, previewFingerprint: preview.previewFingerprint };
  assert.equal((await repository.readSnapshot()).revision, read.snapshotRevision);
  return { input, capture, previewInput, preview, command };
}

test("persistent lead query and read use one SQLite snapshot without source reads or job creation", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const before = await repo.backup(), f = fixture(repo);
    assert.deepEqual(f.tools.map(tool => [tool.name, tool.version, tool.effect]), [["leads.query", 1, "read-index"], ["leads.read", 1, "read-index"],
      ["leads.read-original", 1, "external-read"], ["leads.preview-original", 1, "read-index"], ["leads.import-original", 1, "local-write"]]);
    const query = await f.tools[0].execute({}, context()); assert.equal(query.totalLeads, 2); assert.equal(query.items.length, 2);
    for (const item of query.items) {
      assert.equal(item.source.sourceId, item.lead.sourceId); assert.equal(item.source.enabled, true); assert.deepEqual(item.resolvedJobs, []);
      assert.deepEqual(item.eligibleOriginalSources.map(source => source.sourceId), [originalSource().sourceId]);
      assert.match(item.leadDigest, /^[a-f0-9]{64}$/);
      const read = await f.tools[1].execute({ leadId: item.lead.id, expectedRevision: query.snapshotRevision }, context());
      assert.deepEqual(read, { snapshotRevision: query.snapshotRevision, ...item });
    }
    assert.deepEqual(f.calls, []); assert.deepEqual(await repo.backup(), before); assert.deepEqual((await repo.readSnapshot()).jobs, []);
  } finally { repo.close(); }
});

test("lead paging cursors bind both the snapshot and filters instead of accepting another search", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo, 3); const f = fixture(repo), first = await f.tools[0].execute({ limit: 1, search: "C#" }, context());
    assert.equal(first.items.length, 1); assert.equal(first.totalLeads, 3); assert.ok(first.nextCursor);
    const second = await f.tools[0].execute({ limit: 1, search: "C#", cursor: first.nextCursor }, context());
    assert.equal(second.items.length, 1); assert.notEqual(second.items[0]!.lead.id, first.items[0]!.lead.id);
    await assert.rejects(f.tools[0].execute({ limit: 1, search: "Java", cursor: first.nextCursor }, context()), hasCode("invalid-input", "stale-version"));
    await assert.rejects(f.tools[0].execute({ limit: 1, sourceId: discoverySource(2).sourceId, search: "C#", cursor: first.nextCursor }, context()), hasCode("invalid-input", "stale-version"));
    const scoped = await f.tools[0].execute({ sourceId: discoverySource(2).sourceId, entityType: "discovery-lead", search: "C#" }, context());
    assert.deepEqual(scoped.items.map(item => item.lead.id), ["lead-2"]);
    await repo.registerSource({ ...originalSource(), name: "Reviewed original source update" }, { actorScope: ACTOR, expectedRevision: first.snapshotRevision, idempotencyKey: "advance-revision" });
    await assert.rejects(f.tools[0].execute({ limit: 1, search: "C#", cursor: first.nextCursor }, context()), hasCode("stale-version"));
    assert.deepEqual(f.calls, []);
  } finally { repo.close(); }
});

test("reading and previewing one original posting obtains its own ID and leaves SQLite byte-equivalent", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), before = await repo.backup(), p = await prepare(repo, f);
    assert.deepEqual(f.calls, [{ url: URL, sourceId: originalSource().sourceId }]);
    assert.equal(p.capture.discoverySourceId, discoverySource(1).sourceId); assert.equal(p.capture.originalSourceId, originalSource().sourceId);
    assert.equal(p.capture.record.sourceRecordId, "original-1"); assert.notEqual(p.capture.record.sourceRecordId, lead(1).record.sourceRecordId);
    assert.equal(OriginalLeadCaptureSchema.safeParse(p.capture).success, true); assert.match(p.preview.job.description, /Complete original responsibilities/);
    assert.equal(p.preview.listings[0]!.sourceId, originalSource().sourceId); assert.equal(p.preview.locations[0]!.streetAddress, "Synthetic Road 10");
    assert.equal(p.preview.locations[0]!.coordinates, undefined); assert.equal(p.preview.locations[0]!.verification, "unverified");
    assert.deepEqual(await repo.backup(), before);
  } finally { repo.close(); }
});

test("reviewed original import creates one original-owned job and retains immutable discovery evidence", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), p = await prepare(repo, f), receipt = await f.tools[4].execute(p.command, context("adopt-original"));
    assert.equal(receipt.counts.newJobs, 1); assert.equal(receipt.counts.newListings, 1);
    const after = await repo.readSnapshot(); assert.equal(after.jobs.length, 1); assert.equal(after.listings.length, 1);
    assert.equal(after.listings[0]!.sourceId, originalSource().sourceId); assert.equal(after.listings[0]!.sourceRecordId, "original-1");
    assert.ok(after.listings[0]!.discoverySourceIds?.includes(discoverySource(1).sourceId));
    assert.ok(after.listings[0]!.discoveredViaUrls?.includes(discoverySource(1).entryUrl!));
    assert.ok(after.listings[0]!.discoveredViaUrls?.includes(URL));
    assert.ok(after.observations.some(observation => observation.rawText?.includes(p.capture.leadId) && observation.rawText.includes(p.capture.leadDigest)));
    assert.equal((await repo.listDiscoveryLeads()).length, 2); assert.equal(after.locations[0]!.coordinates, undefined);
    assert.equal(after.jobs[0]!.title.verification, "unverified"); assert.deepEqual(f.calls, [{ url: URL, sourceId: originalSource().sourceId }]);
    const read = await f.tools[1].execute({ leadId: "lead-1" }, context());
    assert.deepEqual(read.resolvedJobs.map(job => job.jobId), receipt.jobIds);
  } finally { repo.close(); }
});

test("two persisted discoveries share one original job, and normal refresh plus backup restore retain both chains", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW }), clone = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), first = await prepare(repo, f), a = await f.tools[4].execute(first.command, context("adopt-first"));
    const second = await prepare(repo, f, "lead-2"), b = await f.tools[4].execute(second.command, context("adopt-second"));
    assert.deepEqual(b.jobIds, a.jobIds); assert.equal(b.counts.newJobs, 0);
    const beforeRefresh = await repo.readSnapshot(); assert.equal(beforeRefresh.jobs.length, 1); assert.equal(beforeRefresh.listings.length, 1);
    assert.deepEqual(new Set(beforeRefresh.listings[0]!.discoverySourceIds), new Set([discoverySource(1).sourceId, discoverySource(2).sourceId]));
    for (const p of [first, second]) assert.ok(beforeRefresh.observations.some(observation => observation.rawText?.includes(p.capture.leadId) && observation.rawText.includes(p.capture.leadDigest)));
    const record = readJobPostingJsonLd(detail({ title: "Synthetic refreshed original C# engineer" }), URL).record!;
    const projection = await projectSourcePage(await repo.readProjectionSnapshot(), originalSource(), { observedAt: NOW, records: [record],
      coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "ordinary-refresh");
    await repo.importSnapshot(projection.delta, { actorScope: ACTOR, expectedRevision: beforeRefresh.revision, idempotencyKey: "ordinary-refresh" });
    const refreshed = await repo.readSnapshot(); assert.equal(refreshed.jobs.length, 1);
    assert.deepEqual(new Set(refreshed.listings[0]!.discoverySourceIds), new Set(beforeRefresh.listings[0]!.discoverySourceIds));
    assert.deepEqual(new Set(refreshed.listings[0]!.discoveredViaUrls), new Set(beforeRefresh.listings[0]!.discoveredViaUrls));
    const backup = await repo.backup(); await clone.restore(backup, { actorScope: ACTOR, idempotencyKey: "restore-complete-lead-chain", expectedRevision: 0 });
    assert.deepEqual((await clone.readSnapshot()).listings, refreshed.listings); assert.deepEqual(await clone.listDiscoveryLeads(), await repo.listDiscoveryLeads());
    assert.deepEqual((await clone.readSnapshot()).observations, refreshed.observations);
    const restored = fixture(clone), read = await restored.tools[1].execute({ leadId: "lead-2" }, context()); assert.deepEqual(read.resolvedJobs.map(job => job.jobId), a.jobIds);
    const beforeReplay = await clone.backup();
    assert.ok(beforeReplay.dataset.revision > backup.dataset.revision, "Restore advances the revision while retaining the original command receipts.");
    assert.deepEqual(await restored.tools[4].execute(first.command, context("adopt-first")), a);
    assert.deepEqual(await restored.tools[4].execute(second.command, context("adopt-second")), b);
    await assert.rejects(restored.tools[4].execute({ ...first.command, previewFingerprint: "0".repeat(64) }, context("adopt-first")), hasCode("idempotency-conflict"));
    assert.deepEqual(await clone.backup(), beforeReplay, "Restored receipts return without reimporting or changing the restored dataset.");
    assert.deepEqual(restored.calls, [], "Receipt recovery never rereads the original source after backup restoration.");
  } finally { repo.close(); clone.close(); }
});

test("stale digests, stale revisions and arbitrary URL or source overrides fail before transport", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), read = await f.tools[1].execute({ leadId: "lead-1" }, context());
    const input = { leadId: "lead-1", leadDigest: read.leadDigest, originalSourceId: originalSource().sourceId, expectedRevision: read.snapshotRevision };
    for (const [changes, code] of [[{ expectedRevision: read.snapshotRevision - 1 }, "stale-version"], [{ leadDigest: "0".repeat(64) }, "source-changed"],
      [{ leadId: "missing-lead" }, "invalid-input"], [{ originalSourceId: discoverySource(1).sourceId }, "unsupported-capability"]] as const) {
      await assert.rejects(f.tools[2].execute({ ...input, ...changes }, context()), hasCode(code));
    }
    const registry = createToolRegistry(f.tools);
    const extraUrl = await registry.execute("leads.read-original", { ...input, url: "https://unreviewed.invalid/job" }, trusted("extra-url"));
    assert.equal(extraUrl.ok, false); if (!extraUrl.ok) assert.equal(extraUrl.error.code, "invalid-input"); assert.deepEqual(f.calls, []);
    const denied = await registry.execute("leads.read-original", input, trusted("read-index-only", ["read-index"]));
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "not-authorized"); assert.deepEqual(f.calls, []);
    const changed = lead(1, { observedAt: READ, record: { ...lead(1).record, title: "Changed retained discovery evidence" } });
    await repo.saveDiscoveryLeads([changed], { actorScope: ACTOR, idempotencyKey: "changed-lead" });
    await assert.rejects(f.tools[2].execute({ ...input, expectedRevision: (await repo.readSnapshot()).revision }, context()), hasCode("stale-version", "source-changed"));
    assert.deepEqual(f.calls, []);
  } finally { repo.close(); }
});

test("original captures cannot be forged or moved across leads, source fingerprints, record identity or description", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), p = await prepare(repo, f), before = await repo.backup();
    for (const capture of [{ ...p.capture, proof: "0".repeat(64) }, { ...p.capture, leadId: "lead-2" }, { ...p.capture, leadDigest: "0".repeat(64) },
      { ...p.capture, discoverySourceFingerprint: "0".repeat(64) }, { ...p.capture, originalSourceFingerprint: "0".repeat(64) },
      { ...p.capture, record: { ...p.capture.record, sourceRecordId: "forged-original" } }, { ...p.capture, record: { ...p.capture.record, description: "Invented JD" } },
      { ...p.capture, readSequence: p.capture.readSequence + 1 }, { ...p.capture, readSessionId: "0".repeat(32) }]) {
      await assert.rejects(f.tools[3].execute({ ...p.previewInput, capture }, context()), hasCode("source-changed", "stale-version", "invalid-input"));
    }
    assert.deepEqual(await repo.backup(), before); assert.equal(f.calls.length, 1);
  } finally { repo.close(); }
});

test("both original and discovery source edits invalidate a prepared capture even when a caller supplies the new revision", async () => {
  for (const sourceId of [originalSource().sourceId, discoverySource(1).sourceId]) {
    const repo = openJobRepository(":memory:", { now: () => NOW });
    try {
      await seed(repo); const f = fixture(repo), p = await prepare(repo, f), source = (await repo.readSnapshot()).sources.find(entry => entry.sourceId === sourceId)!;
      await repo.registerSource({ ...source, attribution: { ...source.attribution, label: "Changed reviewed source policy" } }, { actorScope: ACTOR, expectedRevision: p.input.expectedRevision, idempotencyKey: `change-${sourceId}` });
      const before = await repo.backup();
      await assert.rejects(f.tools[3].execute({ ...p.previewInput, expectedRevision: before.dataset.revision }, context()), hasCode("source-changed"));
      assert.deepEqual(await repo.backup(), before); assert.equal(f.calls.length, 1);
    } finally { repo.close(); }
  }
});

test("a revision change during original I/O rejects the late read without importing it", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const read = await fixture(repo).tools[1].execute({ leadId: "lead-1" }, context()); let calls = 0;
    const tools = createLeadResolutionTools({ repository: repo, sources: createSourceRegistry([jobPostingJsonLdAdapter]), now: () => READ,
      transport: { async request(input) {
        calls++; await repo.saveDiscoveryLeads([lead(2, { observedAt: READ, record: { ...lead(2).record, title: "Concurrent discovery update" } })], { actorScope: ACTOR, idempotencyKey: "concurrent-change" });
        return { url: input.url, status: 200, headers: {}, text: detail() };
      } } });
    await assert.rejects(tools[2].execute({ leadId: "lead-1", leadDigest: read.leadDigest, originalSourceId: originalSource().sourceId, expectedRevision: read.snapshotRevision }, context()), hasCode("stale-version"));
    assert.equal(calls, 1); assert.equal((await repo.readSnapshot()).jobs.length, 0); assert.equal((await repo.listDiscoveryLeads()).length, 2);
  } finally { repo.close(); }
});

test("a committed receipt survives SQLite reopen and a new proof secret while changed commands conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-lead-resolution-")), path = join(directory, "synthetic.sqlite");
  let repo = openJobRepository(path, { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), p = await prepare(repo, f), receipt = await f.tools[4].execute(p.command, context("durable-original"));
    const before = await repo.backup(); repo.close(); repo = openJobRepository(path, { now: () => NOW });
    const restarted = fixture(repo);
    assert.deepEqual(await restarted.tools[4].execute(p.command, context("durable-original")), receipt);
    assert.deepEqual(await repo.backup(), before); assert.deepEqual(restarted.calls, []);
    const next = await prepare(repo, restarted, "lead-2");
    await assert.rejects(restarted.tools[4].execute(next.command, context("durable-original")), hasCode("idempotency-conflict"));
    await assert.rejects(restarted.tools[3].execute({ ...p.previewInput, expectedRevision: before.dataset.revision }, context()), hasCode("source-changed"));
  } finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an original posting already merged into another canonical job keeps its actual owner and discovery association", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), first = await prepare(repo, f); await f.tools[4].execute(first.command, context("original-before-merge"));
    const secondUrl = `${ORIGIN}/jobs/original-2`, record = readJobPostingJsonLd(detail({ url: secondUrl, identifier: { value: "original-2" }, title: "Synthetic other original posting" }), secondUrl).record!;
    const projection = await projectSourcePage(await repo.readProjectionSnapshot(), originalSource(), { observedAt: AT, records: [record],
      coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "seed-merge-target");
    await repo.importSnapshot(projection.delta, { actorScope: ACTOR, expectedRevision: (await repo.readSnapshot()).revision, idempotencyKey: "seed-merge-target" });
    const before = await repo.readSnapshot(), oldId = before.listings.find(listing => listing.canonicalUrl === URL)!.canonicalJobId!, targetId = before.listings.find(listing => listing.canonicalUrl === secondUrl)!.canonicalJobId!;
    await repo.mergeJobs({ targetJobId: targetId, sourceJobId: oldId, reason: "Synthetic user-confirmed same requirement", companyIdentityConfirmed: true },
      { actorScope: ACTOR, expectedRevision: before.revision, idempotencyKey: "merge-original-owners" });
    const next = await prepare(repo, f, "lead-2");
    assert.equal(next.preview.job.id, oldId, "The preview retains the original source contribution for review.");
    assert.equal(next.preview.canonicalJobId, targetId, "The preview names the current effective owner separately.");
    const receipt = await f.tools[4].execute(next.command, context("adopt-after-merge"));
    assert.deepEqual(receipt.jobIds, [targetId]); assert.equal((await repo.readSnapshot()).jobs.length, 1);
    const resolved = await f.tools[1].execute({ leadId: "lead-2" }, context()); assert.deepEqual(resolved.resolvedJobs.map(job => job.jobId), [targetId]);
    const listing = (await repo.readSnapshot()).listings.find(entry => entry.canonicalUrl === URL)!;
    assert.equal(listing.canonicalJobId, targetId); assert.ok(listing.discoverySourceIds?.includes(discoverySource(2).sourceId));
  } finally { repo.close(); }
});

test("same-timestamp reads cannot be saved in reverse order to replace a newer original record", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), older = await prepare(repo, f);
    f.setHtml(detail({ description: "<p>Newer synthetic original requirements.</p>" })); const newer = await prepare(repo, f);
    assert.equal(older.capture.observedAt, newer.capture.observedAt); assert.equal(older.capture.readSessionId, newer.capture.readSessionId);
    assert.ok(newer.capture.readSequence > older.capture.readSequence);
    await f.tools[4].execute(newer.command, context("newest-original-first")); const before = await repo.backup();
    await assert.rejects(f.tools[3].execute({ ...older.previewInput, expectedRevision: before.dataset.revision }, context()), hasCode("stale-version"));
    assert.deepEqual(await repo.backup(), before); assert.match(before.dataset.jobs[0]!.description, /Newer synthetic original/);
  } finally { repo.close(); }
});

test("lost output and post-commit cancellation recover the original durable receipt without a second import", async () => {
  for (const mode of ["output", "cancel"] as const) {
    const repo = openJobRepository(":memory:", { now: () => NOW });
    try {
      await seed(repo); const f = fixture(repo), p = await prepare(repo, f), write = f.tools[4], controller = new AbortController(); let writes = 0;
      const registry = createToolRegistry([{ ...write, execute: async (input, ctx) => {
        writes++; const receipt = await write.execute(input, ctx); if (mode === "cancel") controller.abort(); return mode === "output" ? { wrong: true } as never : receipt;
      } }]);
      const first = await registry.execute(write.name, p.command, { ...trusted(`lost-original-${mode}`), signal: controller.signal });
      assert.equal(first.ok, false); if (!first.ok) assert.equal(first.error.code, mode === "output" ? "invalid-output" : "cancelled");
      const before = await repo.backup(), second = await registry.execute(write.name, p.command, trusted(`lost-original-${mode}`));
      assert.equal(second.ok, true); assert.equal(writes, 1); assert.deepEqual(await repo.backup(), before);
      assert.equal((await repo.readSnapshot()).jobs.length, 1); assert.equal(f.calls.length, 1);
    } finally { repo.close(); }
  }
});

test("an application URL alone never authorizes a replacement for the retained original lead URL", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), edited = lead(1, { observedAt: READ, record: { ...lead(1).record, url: discoverySource(1).entryUrl, applicationUrl: URL } });
    await repo.saveDiscoveryLeads([edited], { actorScope: ACTOR, idempotencyKey: "application-only" });
    const read = await f.tools[1].execute({ leadId: edited.id }, context()); assert.deepEqual(read.eligibleOriginalSources, []);
    await assert.rejects(f.tools[2].execute({ leadId: edited.id, leadDigest: read.leadDigest, expectedRevision: read.snapshotRevision, originalSourceId: originalSource().sourceId }, context()), hasCode("not-authorized", "unsupported-capability", "invalid-input"));
    assert.deepEqual(f.calls, []); assert.equal((await repo.readSnapshot()).jobs.length, 0);
  } finally { repo.close(); }
});

test("cancellation and non-job original pages cannot produce a savable canonical preview", async () => {
  const repo = openJobRepository(":memory:", { now: () => NOW });
  try {
    await seed(repo); const f = fixture(repo), read = await f.tools[1].execute({ leadId: "lead-1" }, context());
    const input = { leadId: "lead-1", leadDigest: read.leadDigest, originalSourceId: originalSource().sourceId, expectedRevision: read.snapshotRevision };
    const controller = new AbortController(); controller.abort(); await assert.rejects(f.tools[2].execute(input, context("cancel-before-read", controller.signal)), hasCode("cancelled")); assert.deepEqual(f.calls, []);
    for (const html of ["<html><body>Recruitment campaign only</body></html>", detail({ hiringOrganization: undefined }), detail({ identifier: undefined }),
      `<html><script type="application/ld+json">${JSON.stringify([JSON.parse(detail().match(/<script[^>]*>(.*?)<\/script>/)![1]!), { "@type": "JobPosting", title: "Another job", url: `${URL}-other` }])}</script></html>`]) {
      f.setHtml(html); await assert.rejects(f.tools[2].execute(input, context()), hasCode("source-changed", "invalid-output"));
    }
    assert.equal((await repo.readSnapshot()).jobs.length, 0);
  } finally { repo.close(); }
});
