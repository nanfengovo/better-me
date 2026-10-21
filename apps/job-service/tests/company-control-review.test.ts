import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { classifyCompany, queryJobs, type AtlasDataset, type CompanyControlReviewProposal, type PreviewCompanyControlReviewInput, type SourceDefinition, type TrustedToolContext } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";

const AT = "2026-10-21T00:00:00.000Z", LATER = "2026-10-22T00:00:00.000Z";
const RAW = "Synthetic Employer Ltd is the legal employer. Its parent is Example Parent. Ultimate control is held by Example State Fund, a state entity originating in Norway (NO). The employer has a single ultimate controller.";
const source: SourceDefinition = { sourceId: "control-source", name: "Synthetic source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
const opts = (idempotencyKey: string, expectedRevision: number, actorScope = "owner") => ({ actorScope, idempotencyKey, expectedRevision });
const code = (value: string) => (error: unknown) => error instanceof RepositoryError && error.code === value;
function record(id = "42", companyName = "Synthetic Employer"): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://careers.example.test/jobs/${id}`, title: "Synthetic backend engineer", companyName,
    description: "A retained synthetic job description.", locations: [{ raw: "Shanghai, China", countryCode: "CN", city: "Shanghai" }], compensations: [],
    workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };
}
async function ingest(repo: JobRepository, key: string, records = [record("42"), record("43")]) {
  const before = await repo.readProjectionSnapshot(), projected = await projectSourcePage(before, source, { records, observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, key);
  return repo.importSnapshot(projected.delta, opts(key, before.revision));
}
function input(data: AtlasDataset): PreviewCompanyControlReviewInput {
  const job = data.jobs[0]!;
  const proposal: CompanyControlReviewProposal = { basis: "manual-evidence-review", documents: [{ sourceUrl: "https://example.test/annual-report", retrievedAt: AT, rawText: RAW }],
    legalEntityName: "Synthetic Employer Ltd", parentCompanyName: "Example Parent", status: "resolved", controlMode: "single", controllers: [{ name: "Example State Fund", kind: "state", jurisdictionCode: "NO" }],
    supports: ["legalEntityName", "parentCompanyName", "status", "controlMode", "controllerName", "controllerKind", "controllerControl", "controllerJurisdiction"].map(field => ({ field: field as CompanyControlReviewProposal["supports"][number]["field"], documentIndex: 0, quote: RAW, ...(field.startsWith("controller") ? { controllerIndex: 0 } : {}) })) };
  return { jobId: job.id, companyId: job.companyId, expectedRevision: data.revision, proposal, reason: "Review explicit synthetic controller citations" };
}
async function command(repo: JobRepository, specified?: PreviewCompanyControlReviewInput) {
  const value = specified ?? input(await repo.readProjectionSnapshot());
  return { ...value, reviewed: true as const, previewFingerprint: (await repo.previewCompanyControlReview(value)).previewFingerprint };
}
async function confirm(repo: JobRepository, key = "confirm", specified?: PreviewCompanyControlReviewInput) {
  const value = await command(repo, specified); return repo.confirmCompanyControlReview(value, opts(key, value.expectedRevision));
}
async function fixture(work: (repo: JobRepository, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-company-test-")), path = join(directory, "jobs.sqlite"), repo = openJobRepository(path, { now: () => LATER });
  try { await ingest(repo, "seed"); await work(repo, path); } finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
}

test("company read/preview do not write; confirmation drives same-company query and revisions without changing source job facts", async () => fixture(async repo => {
  const before = await repo.backup(), value = input(before.dataset), preview = await repo.previewCompanyControlReview(value);
  const reading = await repo.readCompanyControlReview({ jobId: value.jobId, companyId: value.companyId, expectedRevision: value.expectedRevision });
  assert.deepEqual(reading.current, reading.sourceCompany); assert.deepEqual(reading.history, []); assert.deepEqual(await repo.backup(), before);
  assert.equal(classifyCompany(preview.proposed).ownership, "state");
  assert.equal((await queryJobs(before.dataset, { controllerJurisdictions: ["NO"], ownershipKinds: ["state"] })).totalJobs, 0);
  const saved = await confirm(repo), after = await repo.backup();
  assert.equal(saved.revision, before.dataset.revision + 1); assert.equal(saved.activeDecisionId, saved.decisionId); assert.equal(saved.affectedJobIds.length, 2);
  const result = await queryJobs(after.dataset, { controllerJurisdictions: ["NO"], ownershipKinds: ["state"] });
  assert.equal(result.totalJobs, 2); assert.deepEqual(result.facets.controllerJurisdictions, { NO: 2 });
  assert.deepEqual(after.baseCompanies, before.baseCompanies); assert.deepEqual(await repo.readProjectionSnapshot(), { ...before.dataset, revision: saved.revision });
  for (const table of ["locations", "compensations", "snapshots"] as const) assert.deepEqual(after.dataset[table], before.dataset[table]);
  for (const job of after.dataset.jobs) { const prior = before.dataset.jobs.find(value => value.id === job.id)!; assert.ok(job.revision > prior.revision); assert.equal(job.description, prior.description); assert.equal(job.selectedSnapshotId, prior.selectedSnapshotId); }
  const material = after.dataset.sources.find(value => value.entityType === "company-directory")!;
  assert.equal(material.enabled, false); assert.deepEqual(material.capabilities, []); assert.equal(after.dataset.jobs.length, before.dataset.jobs.length);
  assert.deepEqual(after.dataset.observations.filter(value => !value.id.startsWith("company-control-review-")), before.dataset.observations);
  await assert.rejects(repo.importSnapshot(after.dataset, opts("reject-effective-import", saved.revision)), code("conflict"));
}));

test("restart, durable confirm/revoke retries and actor authorization preserve immutable history", async () => fixture(async (repo, path) => {
  const value = await command(repo), saved = await repo.confirmCompanyControlReview(value, opts("stable", value.expectedRevision));
  const reopened = openJobRepository(path, { now: () => LATER });
  try {
    assert.deepEqual(await reopened.confirmCompanyControlReview(value, opts("stable", value.expectedRevision)), saved);
    assert.deepEqual(await reopened.findCompanyControlReviewReceipt("companies.confirm-control-review", value, opts("stable", value.expectedRevision)), saved);
    await assert.rejects(reopened.confirmCompanyControlReview({ ...value, reason: "Other reason" }, opts("stable", value.expectedRevision)), code("idempotency-conflict"));
    const revoke = { jobId: value.jobId, companyId: value.companyId, expectedRevision: saved.revision, decisionId: saved.decisionId, reason: "Undo synthetic citations", reviewed: true };
    await assert.rejects(reopened.revokeCompanyControlReview(revoke, opts("foreign", saved.revision, "foreign")), code("not-authorized"));
    const undone = await reopened.revokeCompanyControlReview(revoke, opts("undo", saved.revision));
    assert.equal(undone.activeDecisionId, undefined); assert.equal(classifyCompany(undone.company).ownership, "unknown");
    assert.deepEqual(await reopened.revokeCompanyControlReview(revoke, opts("undo", saved.revision)), undone);
    await assert.rejects(reopened.revokeCompanyControlReview({ ...revoke, expectedRevision: undone.revision }, opts("undo-twice", undone.revision)), code("conflict"));
    const inspector = new DatabaseSync(path); try { assert.throws(() => inspector.exec("DELETE FROM company_control_decisions"), /immutable-company-control-decision/); assert.throws(() => inspector.exec("UPDATE company_control_decisions SET document=document"), /immutable-company-control-decision/); } finally { inspector.close(); }
  } finally { reopened.close(); }
}));

test("new same-company jobs and alias additions preserve review; source company identity changes permanently invalidate it", async () => fixture(async repo => {
  const saved = await confirm(repo); await ingest(repo, "third-job", [record("44")]);
  let data = await repo.readProjectionSnapshot(); data.companies[0]!.names.push("Another spelling");
  await repo.importSnapshot(data, opts("alias-growth", data.revision));
  let current = await repo.readSnapshot(); assert.equal(current.companies[0]!.controlReview!.decisionId, saved.decisionId); assert.equal((await queryJobs(current, { controllerJurisdictions: ["NO"] })).totalJobs, 3);
  data = await repo.readProjectionSnapshot(); const original = structuredClone(data.companies[0]!.ultimateControllers);
  data.companies[0]!.ultimateControllers = { ...original, revision: original.revision + 1 };
  const changed = await repo.importSnapshot(data, opts("company-source-change", data.revision)), middle = await repo.backup();
  assert.equal(middle.companyControlDecisions.at(-1)!.kind, "invalidate"); assert.equal(middle.companyControlDecisions.at(-1)!.revision, changed.revision);
  current = await repo.readSnapshot(); assert.equal(current.companies[0]!.controlReview, undefined);
  data = await repo.readProjectionSnapshot(); data.companies[0]!.ultimateControllers = { ...original, revision: original.revision + 2 };
  await repo.importSnapshot(data, opts("company-source-return", data.revision)); assert.equal((await repo.readSnapshot()).companies[0]!.controlReview, undefined);
  const value = input(await repo.readProjectionSnapshot()); assert.equal((await repo.readCompanyControlReview({ jobId: value.jobId, companyId: value.companyId, expectedRevision: value.expectedRevision })).history.length, 2);
  const restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(await repo.backup(), opts("restore-invalidation", 0)); assert.equal((await restored.readSnapshot()).companies[0]!.controlReview, undefined); } finally { restored.close(); }
}));

test("multiple reviews revoke to preceding active citations and full history restores after later source changes", async () => fixture(async repo => {
  const first = await confirm(repo, "first"), second = await confirm(repo, "second");
  const base = await repo.readProjectionSnapshot(), value = input(base);
  const undone = await repo.revokeCompanyControlReview({ jobId: value.jobId, companyId: value.companyId, expectedRevision: base.revision, decisionId: second.decisionId, reason: "Restore preceding reading", reviewed: true }, opts("undo-second", base.revision));
  assert.equal(undone.activeDecisionId, first.decisionId);
  await ingest(repo, "fourth-job", [record("45")]);
  const changed = await repo.readProjectionSnapshot(); changed.companies[0]!.ultimateControllers.revision++;
  await repo.importSnapshot(changed, opts("change-after-revoke", changed.revision));
  const target = openJobRepository(":memory:", { now: () => LATER }); try { await target.restore(await repo.backup(), opts("restore-history", 0)); assert.equal((await target.backup()).companyControlDecisions.length, 4); } finally { target.close(); }
}));

test("invalid fingerprint, missing exact citations, future evidence and cancellation leave the complete transaction untouched", async () => fixture(async repo => {
  const value = await command(repo), before = await repo.backup();
  await assert.rejects(repo.confirmCompanyControlReview({ ...value, previewFingerprint: "0".repeat(64) }, opts("forged", value.expectedRevision)), code("stale-version"));
  await assert.rejects(repo.confirmCompanyControlReview({ ...value, reviewed: false }, opts("unreviewed", value.expectedRevision)), code("invalid-data"));
  const missing = structuredClone(value); missing.proposal.supports[0]!.quote = "not in document";
  await assert.rejects(repo.previewCompanyControlReview(missing), code("invalid-data"));
  const future = structuredClone(value); future.proposal.documents[0]!.retrievedAt = "2026-10-23T00:00:00.000Z";
  await assert.rejects(repo.confirmCompanyControlReview(future, opts("future", value.expectedRevision)), code("invalid-data"));
  let checks = 0;
  await assert.rejects(repo.confirmCompanyControlReview(value, { ...opts("cancel-last", value.expectedRevision), throwIfCancelled: () => { if (++checks >= 3) throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), before);
}));

test("V7 backup reconstructs exact evidence, effective companies, material records and command receipts; tampering never writes", async () => fixture(async repo => {
  await confirm(repo); const backup = await repo.backup();
  const target = openJobRepository(":memory:", { now: () => LATER });
  try { await target.restore(backup, opts("restore", 0)); assert.deepEqual((await target.readSnapshot()).companies, backup.dataset.companies); assert.deepEqual((await target.backup()).companyControlDecisions, backup.companyControlDecisions); } finally { target.close(); }
  const corruptions: Array<(copy: typeof backup) => void> = [
    copy => { const entry = copy.companyControlDecisions[0]!; if (entry.kind === "confirm") entry.materials[0]!.contentHash = "0".repeat(64); },
    copy => { const entry = copy.companyControlDecisions[0]!; if (entry.kind === "confirm") entry.materials[0]!.rawText += " altered"; },
    copy => { copy.dataset.companies[0]!.controlReview!.controlMode = "joint"; },
    copy => { copy.dataset.observations.find(value => value.id.startsWith("company-control-review-"))!.rawText += " forged"; },
    copy => { copy.dataset.sources.find(value => value.entityType === "company-directory")!.enabled = true; },
    copy => { copy.receipts = copy.receipts.filter(value => value.tool !== "companies.confirm-control-review"); },
    copy => { copy.receipts.find(value => value.tool === "companies.confirm-control-review")!.signature = "0".repeat(64); },
    copy => { const entry = copy.companyControlDecisions[0]!; if (entry.kind === "confirm") entry.sourceBinding.job.companyId = "wrong-company"; },
    copy => { copy.dataset.companies[0]!.ultimateControllers.value![0]!.jurisdictionCode = "US"; },
    copy => { copy.companyControlDecisions[0]!.at = "2026-10-23T00:00:00.000Z"; },
  ];
  for (const mutate of corruptions) {
    const copy = structuredClone(backup); mutate(copy); const rejected = openJobRepository(":memory:", { now: () => LATER });
    try { const before = await rejected.backup(); await assert.rejects(rejected.restore(copy, opts("tamper", 0)), code("invalid-backup")); assert.deepEqual(await rejected.backup(), before); } finally { rejected.close(); }
  }
  await assert.rejects(repo.restore({ ...backup, companyControlDecisions: [], baseCompanies: backup.baseCompanies, dataset: await repo.readProjectionSnapshot(), receipts: backup.receipts.filter(value => !value.tool.startsWith("companies.")) }, opts("discard-history", backup.dataset.revision)), code("conflict"));
}));

test("all company HTTP endpoints use authenticated shared tool contracts and durable write keys", async () => fixture(async repo => {
  const app = createJobApplication({ repository: repo, now: () => LATER }), token = "synthetic-control-token-only-123456789", server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: ["http://localhost:5173"], port: 0 });
  const { url } = await server.listen(), value = input(await repo.readSnapshot()), headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = { jobId: value.jobId, companyId: value.companyId, expectedRevision: value.expectedRevision };
  const post = (path: string, body: unknown, key?: string) => fetch(`${url}/api/v1/companies/control-review/${path}`, { method: "POST", headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${url}/api/v1/companies/control-review/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(read) })).status, 401);
    assert.equal((await post("read", read)).status, 200);
    const previewResponse = await post("preview", value); assert.equal(previewResponse.status, 200); const preview = (await previewResponse.json() as { value: { previewFingerprint: string } }).value;
    const cmd = { ...value, previewFingerprint: preview.previewFingerprint, reviewed: true };
    assert.equal((await post("confirm", cmd)).status, 400);
    const saved = await post("confirm", cmd, "http-confirm"); assert.equal(saved.status, 200); const receipt = (await saved.json() as { value: { decisionId: string; revision: number } }).value;
    assert.equal((await post("confirm", cmd, "http-confirm")).status, 200);
    const revoke = { ...read, expectedRevision: receipt.revision, decisionId: receipt.decisionId, reason: "Undo HTTP control review", reviewed: true };
    assert.equal((await post("revoke", revoke)).status, 400); assert.equal((await post("revoke", revoke, "http-revoke")).status, 200);
  } finally { await server.close(); await app.shutdown(); }
}));

test("only active cited company material stays public; pruning and trigger changes roll back together on cancellation", async () => fixture(async (repo, path) => {
  const first = await confirm(repo, "material-first"), secondCommand = await command(repo), before = await repo.backup();
  let checks = 0;
  await assert.rejects(repo.confirmCompanyControlReview(secondCommand, { ...opts("material-cancel", secondCommand.expectedRevision), throwIfCancelled: () => { if (++checks >= 3) throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), before);
  const second = await repo.confirmCompanyControlReview(secondCommand, opts("material-second", secondCommand.expectedRevision));
  let snapshot = await repo.readSnapshot();
  assert.equal(snapshot.observations.filter(value => value.id.startsWith("company-control-review-")).length, 1);
  assert.ok(snapshot.observations.some(value => value.id.includes(second.decisionId))); assert.ok(!snapshot.observations.some(value => value.id.includes(first.decisionId)));
  const undoSecond = { jobId: second.jobId, companyId: second.companyId, decisionId: second.decisionId, expectedRevision: second.revision, reason: "Show previous material", reviewed: true };
  let cancellationChecks = 0; const beforeUndo = await repo.backup();
  await assert.rejects(repo.revokeCompanyControlReview(undoSecond, { ...opts("cancel-revoke", second.revision), throwIfCancelled: () => { if (++cancellationChecks === 2) throw new RepositoryError("cancelled"); } }), code("cancelled"));
  assert.deepEqual(await repo.backup(), beforeUndo);
  const undone = await repo.revokeCompanyControlReview(undoSecond, opts("undo-material-second", second.revision));
  snapshot = await repo.readSnapshot(); assert.ok(snapshot.observations.some(value => value.id.includes(first.decisionId))); assert.ok(!snapshot.observations.some(value => value.id.includes(second.decisionId)));
  await repo.revokeCompanyControlReview({ ...undoSecond, decisionId: first.decisionId, expectedRevision: undone.revision }, opts("undo-material-first", undone.revision));
  const backup = await repo.backup(); assert.equal(backup.dataset.observations.filter(value => value.id.startsWith("company-control-review-")).length, 0);
  assert.equal(backup.companyControlDecisions.filter(value => value.kind === "confirm").length, 2);
  assert.deepEqual(backup.dataset.observations, before.dataset.observations.filter(value => !value.id.startsWith("company-control-review-")));
  const inspector = new DatabaseSync(path);
  try {
    assert.throws(() => inspector.prepare("DELETE FROM observations WHERE id=?").run(backup.dataset.observations[0]!.id), /immutable-observation/);
    assert.throws(() => inspector.exec("UPDATE observations SET document=document"), /immutable-observation/);
    assert.throws(() => inspector.exec("DELETE FROM snapshots"), /immutable-snapshot/);
    const triggers = inspector.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN ('observations_no_update','observations_no_delete','snapshots_no_update','snapshots_no_delete')").all(); assert.equal(triggers.length, 4);
  } finally { inspector.close(); }
  const restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(backup, opts("restore-no-public-material", 0)); assert.equal((await restored.backup()).companyControlDecisions.length, 4); } finally { restored.close(); }
}));

test("new explicit review takes precedence over retained legacy controller override; revocation restores it", async () => fixture(async repo => {
  const data = await repo.readProjectionSnapshot(), company = data.companies[0]!, observation = data.observations[0]!, snapshot = data.snapshots.find(value => value.observationId === observation.id)!;
  company.manualOverrides.push({ id: "legacy-controller", at: AT, reason: "Synthetic legacy source reading", basedOnRevision: company.ultimateControllers.revision, field: "ultimateControllers",
    value: { value: [{ name: "Legacy US controller", kind: "private", jurisdictionCode: "US" }], revision: company.ultimateControllers.revision + 1, method: "manual", verification: "verified", evidence: [{ observationId: observation.id, sourceUrl: snapshot.sourceUrl, observedAt: observation.fetchedAt, quote: snapshot.text }] } });
  await repo.importSnapshot(data, opts("legacy", data.revision)); assert.deepEqual(classifyCompany((await repo.readSnapshot()).companies[0]!).jurisdictions, ["US"]);
  const saved = await confirm(repo); assert.deepEqual(classifyCompany(saved.company).jurisdictions, ["NO"]); assert.deepEqual(saved.company.manualOverrides, company.manualOverrides);
  const undone = await repo.revokeCompanyControlReview({ jobId: saved.jobId, companyId: saved.companyId, decisionId: saved.decisionId, expectedRevision: saved.revision, reason: "Restore legacy source reading", reviewed: true }, opts("undo-legacy-overlay", saved.revision));
  assert.deepEqual(classifyCompany(undone.company).jurisdictions, ["US"]); assert.deepEqual(undone.company.manualOverrides, company.manualOverrides);
  const restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(await repo.backup(), opts("restore-legacy-review", 0)); } finally { restored.close(); }
}));

test("source evidence listing identity changes permanently invalidate company review; archived source closure is verified", async () => fixture(async repo => {
  let data = await repo.readProjectionSnapshot(); const observation = data.observations[0]!, snapshot = data.snapshots.find(value => value.observationId === observation.id)!;
  data.companies[0]!.legalEntity = { value: "Synthetic Employer Ltd", revision: 0, method: "source-structured", verification: "verified", evidence: [{ observationId: observation.id, sourceUrl: snapshot.sourceUrl, quote: snapshot.text, observedAt: observation.fetchedAt }] };
  await repo.importSnapshot(data, opts("source-identity", data.revision)); const saved = await confirm(repo), originalUrl = (await repo.readProjectionSnapshot()).listings.find(value => value.id === observation.listingId)!.canonicalUrl;
  data = await repo.readProjectionSnapshot(); data.listings.find(value => value.id === observation.listingId)!.canonicalUrl = "https://careers.example.test/changed-record";
  await repo.importSnapshot(data, opts("evidence-url-change", data.revision)); assert.equal((await repo.readSnapshot()).companies[0]!.controlReview, undefined);
  data = await repo.readProjectionSnapshot(); data.listings.find(value => value.id === observation.listingId)!.canonicalUrl = originalUrl;
  await repo.importSnapshot(data, opts("evidence-url-return", data.revision)); assert.equal((await repo.readSnapshot()).companies[0]!.controlReview, undefined);
  const backup = await repo.backup(), restored = openJobRepository(":memory:", { now: () => LATER });
  try { await restored.restore(backup, opts("restore-source-evidence", 0)); } finally { restored.close(); }
  const forged = structuredClone(backup), entry = forged.companyControlDecisions.find(value => value.id === saved.decisionId)!;
  if (entry.kind === "confirm") entry.sourceBinding.observations[0]!.rawText = "changed archived source";
  const rejected = openJobRepository(":memory:", { now: () => LATER }); try { await assert.rejects(rejected.restore(forged, opts("forged-source-archive", 0)), code("invalid-backup")); } finally { rejected.close(); }
}));

test("cross-company merge and split do not transfer reviewed control to the other employer", async () => fixture(async repo => {
  await ingest(repo, "other-company", [record("88", "Distinct Employer")]);
  let data = await repo.readProjectionSnapshot(); const original = data.jobs.find(value => data.companies.find(company => company.id === value.companyId)!.names.includes("Synthetic Employer"))!, other = data.jobs.find(value => value.companyId !== original.companyId)!;
  const draft = { ...input(data), jobId: original.id, companyId: original.companyId }, saved = await confirm(repo, "before-merge", draft);
  const merged = await repo.mergeJobs({ targetJobId: other.id, sourceJobId: original.id, reason: "Synthetic duplicate employer review", companyIdentityConfirmed: true }, opts("merge", saved.revision));
  data = await repo.readSnapshot(); assert.equal(classifyCompany(data.companies.find(value => value.id === other.companyId)!).ownership, "unknown");
  const reading = await repo.readCompanyControlReview({ jobId: original.id, companyId: original.companyId, expectedRevision: merged.revision }); assert.equal(reading.activeDecisionId, saved.decisionId);
  await assert.rejects(repo.readCompanyControlReview({ jobId: original.id, companyId: other.companyId, expectedRevision: merged.revision }), code("not-found"));
  const split = await repo.revokeMerge({ decisionId: merged.decision.id, reason: "Undo synthetic merge" }, opts("split", merged.revision));
  assert.equal((await queryJobs(await repo.readSnapshot(), { controllerJurisdictions: ["NO"] })).totalJobs, 2);
  await repo.revokeCompanyControlReview({ jobId: original.id, companyId: original.companyId, expectedRevision: split.revision, decisionId: saved.decisionId, reason: "Undo original employer review", reviewed: true }, opts("undo-after-split", split.revision));
  const restored = openJobRepository(":memory:", { now: () => LATER }); try { await restored.restore(await repo.backup(), opts("restore-merge-split", 0)); } finally { restored.close(); }
}));

test("interrupted company tools recover committed receipts without reissuing writes and enforce effects", async () => fixture(async repo => {
  let confirmations = 0, revocations = 0;
  const wrapped: JobRepository = { ...repo, confirmCompanyControlReview: async (...args) => { confirmations++; await repo.confirmCompanyControlReview(...args); throw new Error("Synthetic lost confirm response"); },
    revokeCompanyControlReview: async (...args) => { revocations++; await repo.revokeCompanyControlReview(...args); throw new Error("Synthetic lost revoke response"); } };
  const app = createJobApplication({ repository: wrapped, now: () => LATER }), cmd = await command(repo);
  const context: TrustedToolContext = { requestId: "company-tools", actorScope: "owner", idempotencyKey: "recover-confirm", signal: new AbortController().signal, allowedEffects: ["read-index", "local-write"], budget: { requests: 0, bytes: 1000000, timeoutMs: 5000 } };
  try {
    assert.equal((await app.registry.execute("companies.confirm-control-review", cmd, { ...context, idempotencyKey: "denied", allowedEffects: ["read-index"] })).ok, false); assert.equal(confirmations, 0);
    assert.equal((await app.registry.execute("companies.confirm-control-review", cmd, context)).ok, false);
    assert.equal((await app.registry.execute("companies.confirm-control-review", cmd, context)).ok, true); assert.equal(confirmations, 1);
    const backup = await repo.backup(), decision = backup.companyControlDecisions[0]!;
    const revoke = { jobId: cmd.jobId, companyId: cmd.companyId, decisionId: decision.id, expectedRevision: backup.dataset.revision, reason: "Undo interrupted company review", reviewed: true };
    const revokeContext = { ...context, idempotencyKey: "recover-revoke" };
    assert.equal((await app.registry.execute("companies.revoke-control-review", revoke, revokeContext)).ok, false);
    assert.equal((await app.registry.execute("companies.revoke-control-review", revoke, revokeContext)).ok, true); assert.equal(revocations, 1);
    assert.equal((await repo.backup()).companyControlDecisions.length, 2);
  } finally { await app.shutdown(); }
}));

test("actual V6 databases and V1-V6 source backups migrate without changing facts, revision, or existing decisions", async () => fixture(async (repo, path) => {
  const before = await repo.backup(); repo.close();
  const inspector = new DatabaseSync(path); try { inspector.exec("DROP TRIGGER company_control_decisions_no_update; DROP TRIGGER company_control_decisions_no_delete; DROP TABLE company_control_decisions; DROP TABLE base_companies; PRAGMA user_version=6;"); } finally { inspector.close(); }
  const migrated = openJobRepository(path, { now: () => LATER });
  try {
    assert.deepEqual(await migrated.readSnapshot(), before.dataset); const current = await migrated.backup(); assert.equal(current.schemaVersion, 7); assert.deepEqual(current.baseCompanies, before.dataset.companies);
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const legacy: Record<string, unknown> = structuredClone(current); legacy.schemaVersion = version; delete legacy.baseCompanies; delete legacy.companyControlDecisions;
      if (version < 6) { delete legacy.fxSnapshots; delete legacy.fxActivations; }
      if (version < 5) { delete legacy.baseCompensations; delete legacy.compensationDecisions; }
      if (version < 4) delete legacy.officeDecisions;
      if (version < 3) { delete legacy.baseLocations; delete legacy.locationDecisions; }
      if (version < 2) for (const field of ["baseJobs", "mergeDecisions", "aliasHistory", "jobVersions"]) delete legacy[field];
      const restored = openJobRepository(":memory:", { now: () => LATER });
      try { await restored.restore(legacy, opts(`legacy-${version}`, 0)); assert.deepEqual((await restored.readProjectionSnapshot()).companies, before.dataset.companies); await confirm(restored, `review-after-v${version}`); }
      finally { restored.close(); }
    }
  } finally { migrated.close(); }
}));

test("restore rejects a foreign-company affected job even when both the decision and its durable receipt are changed together", async () => fixture(async repo => {
  await ingest(repo, "scope-other-employer", [record("99", "Foreign synthetic employer")]);
  const saved = await confirm(repo), backup = await repo.backup(), foreign = backup.baseJobs!.find(job => job.companyId !== saved.companyId)!;
  const entry = backup.companyControlDecisions.find(value => value.id === saved.decisionId)!;
  if (entry.kind === "invalidate") assert.fail("Expected archived confirmation");
  entry.affectedJobIds.push(foreign.id);
  const stored = backup.receipts.find(value => value.tool === "companies.confirm-control-review")!;
  if (!("companyId" in stored.response)) assert.fail("Expected company receipt");
  stored.response.affectedJobIds.push(foreign.id);
  const target = openJobRepository(":memory:", { now: () => LATER });
  try { await ingest(target, "existing-target"); const before = await target.backup(); await assert.rejects(target.restore(backup, opts("foreign-affected-scope", before.dataset.revision)), code("invalid-backup")); assert.deepEqual(await target.backup(), before); }
  finally { target.close(); }
}));

test("preview and confirm reject future source read, snapshot, and citation timestamps so every successful review remains restorable", async () => fixture(async repo => {
  const original = await repo.readProjectionSnapshot(), future = "2026-10-23T00:00:00.000Z";
  const variants: Array<(data: AtlasDataset) => void> = [
    data => { data.observations[0]!.fetchedAt = future; },
    data => { data.observations[0]!.feedFetchedAt = future; },
    data => { data.observations[0]!.detailFetchedAt = future; },
    data => { data.snapshots.find(value => value.observationId === data.observations[0]!.id)!.createdAt = future; },
    data => { data.companies[0]!.legalEntity!.evidence[0]!.observedAt = future; },
    data => { const company = data.companies[0]!; company.manualOverrides.push({ id: "future-source-override", field: "legalEntity", value: company.legalEntity!, at: future, basedOnRevision: 0, reason: "Future source override must not be archived" }); },
  ];
  for (const [index, mutate] of variants.entries()) {
    const data = structuredClone(original), observation = data.observations[0]!, snapshot = data.snapshots.find(value => value.observationId === observation.id)!;
    data.companies[0]!.legalEntity = { value: "Source employer", method: "source-structured", verification: "verified", revision: 0,
      evidence: [{ observationId: observation.id, sourceUrl: snapshot.sourceUrl!, quote: snapshot.text, observedAt: AT }] };
    mutate(data);
    const target = openJobRepository(":memory:", { now: () => LATER });
    try {
      await target.importSnapshot(data, opts(`future-source-seed-${index}`, 0)); const before = await target.backup(), draft = input(await target.readProjectionSnapshot());
      await assert.rejects(target.previewCompanyControlReview(draft), code("invalid-data"));
      await assert.rejects(target.confirmCompanyControlReview({ ...draft, reviewed: true, previewFingerprint: "0".repeat(64) }, opts(`future-source-confirm-${index}`, draft.expectedRevision)), code("invalid-data"));
      assert.deepEqual(await target.backup(), before);
    } finally { target.close(); }
  }
  await confirm(repo); const complete = await repo.backup(), restored = openJobRepository(":memory:", { now: () => LATER });
  try { await restored.restore(complete, opts("valid-source-still-roundtrips", 0)); assert.deepEqual((await restored.readSnapshot()).companies, complete.dataset.companies); } finally { restored.close(); }
}));

test("restore retains exact existing company receipt identities instead of duplicating a decision under a replacement key", async () => fixture(async repo => {
  const saved = await confirm(repo, "durable-original"), original = await repo.backup(), changedKey = structuredClone(original);
  changedKey.receipts.find(value => value.tool === "companies.confirm-control-review")!.idempotencyKey = "replacement-key";
  await assert.rejects(repo.restore(changedKey, opts("reject-rekeyed-receipt", saved.revision)), code("conflict"));
  assert.deepEqual(await repo.backup(), original);
  const duplicated = structuredClone(original), duplicate = structuredClone(duplicated.receipts.find(value => value.tool === "companies.confirm-control-review")!);
  duplicate.idempotencyKey = "duplicate-key"; duplicated.receipts.push(duplicate);
  await assert.rejects(repo.restore(duplicated, opts("reject-duplicated-decision-receipt", saved.revision)), code("invalid-backup"));
  assert.deepEqual(await repo.backup(), original);
  await repo.restore(original, opts("restore-exact-receipts", saved.revision));
  const after = await repo.backup(), target = openJobRepository(":memory:", { now: () => LATER });
  try { await target.restore(after, opts("restored-file-roundtrips", 0)); assert.equal((await target.backup()).receipts.filter(value => value.tool === "companies.confirm-control-review").length, 1); }
  finally { target.close(); }
}));
