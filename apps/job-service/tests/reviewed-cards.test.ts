import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry, type ToolHandlerContext, type TrustedToolContext } from "@better-me/opportunities";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters";
import { createReviewedCardsTools, reviewedCardsPage, reviewedCardsSource } from "../src/reviewed-cards.ts";
import { emptyDelta, projectSourcePage } from "../src/projection.ts";
import { openJobRepository, type JobRepository } from "../src/repository.ts";

const at = "2026-10-19T00:00:00.000Z";
function capture(id = "123456789"): ReviewedCardsCapture {
  const url = `https://www.liepin.com/job/${id}.shtml?tracking=synthetic`;
  const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23&city=020";
  return ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl, capturedAt: at, cards: [{
    platform: "猎聘", url, title: "合成 C# 工程师", company: "合成工具测试企业", locationText: "上海·浦东", salaryText: "20–30k·13薪", publicationText: "3天前发布",
    cardText: "合成 C# 工程师 合成工具测试企业 上海·浦东 20–30k·13薪 3天前发布",
    evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
      { field: "url", selector: "a[href]", text: url }, { field: "title", selector: ".title", text: "合成 C# 工程师" },
      { field: "company", selector: ".company", text: "合成工具测试企业" }, { field: "locationText", selector: ".location", text: "上海·浦东" },
      { field: "salaryText", selector: ".salary", text: "20–30k·13薪" }, { field: "publicationText", selector: ".publication", text: "3天前发布" },
    ] },
  }] });
}
function context(key = "review-1", signal = new AbortController().signal): ToolHandlerContext {
  return { requestId: `request-${key}`, actorScope: "local-ui:synthetic-review", idempotencyKey: key, signal,
    budget: { requests: 0, bytes: 2_000_000, timeoutMs: 30_000 },
    consumeRequests() { throw new Error("No external reads are authorized."); }, consumeBytes() {},
    throwIfCancelled() { if (signal.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" }); } };
}
const hasCode = (code: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
const makeTools = (repository: JobRepository) => createReviewedCardsTools({ repository, now: () => at });
async function preview(repository: JobRepository, input = capture()) {
  const expectedRevision = (await repository.readSnapshot()).revision;
  const tools = makeTools(repository);
  const result = await tools[0].execute({ ...input, expectedRevision }, context());
  return { tools, result, command: { ...input, expectedRevision, previewFingerprint: result.previewFingerprint, reviewed: true as const } };
}

test("preview is read-only; confirmed import adds real indexed excerpt and leaves unknown facts unknown", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const initial = await repo.readSnapshot();
    const { tools, result, command } = await preview(repo);
    assert.deepEqual(await repo.readSnapshot(), initial);
    assert.equal(result.cards.length, 1); assert.equal(result.cards[0]!.existing, false);
    assert.equal(result.completeness, "excerpt"); assert.equal(result.availability, "unknown");
    const receipt = await tools[1].execute(command, context());
    const saved = await repo.readSnapshot();
    assert.equal(receipt.counts.newJobs, 1); assert.equal(saved.jobs[0]!.id, result.cards[0]!.jobId);
    assert.equal(saved.jobs[0]!.title.method, "parser"); assert.equal(saved.jobs[0]!.title.verification, "unverified");
    assert.equal(saved.jobs[0]!.status, "unknown"); assert.equal(saved.jobs[0]!.workMode, "unknown");
    assert.equal(saved.snapshots[0]!.extractionMethod, "browser"); assert.equal(saved.snapshots[0]!.completeness, "excerpt");
    assert.equal(saved.snapshots[0]!.text, command.cards[0]!.cardText);
    assert.equal(saved.observations[0]!.result, "partial"); assert.equal(saved.observations[0]!.availability, "unknown");
    assert.equal(saved.observations[0]!.sourcePublishedRaw, "3天前发布"); assert.equal(saved.observations[0]!.sourcePublishedAt, undefined);
    assert.equal(saved.observations[0]!.availabilityVerifiedAt, undefined);
    assert.equal(saved.locations[0]!.raw, "上海·浦东"); assert.equal(saved.locations[0]!.kind, "unknown");
    assert.equal(saved.locations[0]!.coordinates, undefined); assert.equal(saved.locations[0]!.countryCode, undefined); assert.equal(saved.locations[0]!.precision, "unknown");
    assert.equal(saved.compensations[0]!.raw, "20–30k·13薪"); assert.equal(saved.compensations[0]!.min, undefined); assert.equal(saved.compensations[0]!.currency, undefined);
    assert.equal(saved.companies[0]!.ultimateControllers.verification, "unknown");
    assert.equal(saved.sources[0]!.sourceId, "reviewed-platform-liepin"); assert.equal(saved.sources[0]!.enabled, false);
    assert.deepEqual(saved.sources[0]!.capabilities, []); assert.equal(saved.sources[0]!.attribution.label, "猎聘");
    assert.equal(saved.jobs[0]!.title.evidence[0]!.sourceUrl, command.pageUrl);
    assert.equal(saved.jobs[0]!.title.evidence[0]!.observedAt, command.capturedAt);
    assert.ok((await repo.candidateIds({ search: "C#" })).jobIds.includes(saved.jobs[0]!.id));
    assert.deepEqual(await repo.listRuns(), []);
  } finally { repo.close(); }
});

test("an import receipt survives SQLite close/reopen and newer index revisions without duplicate observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "better-me-reviewed-cards-"));
  const path = join(dir, "synthetic.sqlite");
  let repo = openJobRepository(path, { now: () => at });
  try {
    const { tools, command } = await preview(repo);
    const first = await tools[1].execute(command, context("durable"));
    const secondInput = await preview(repo, capture("987654321"));
    await secondInput.tools[1].execute(secondInput.command, context("another"));
    const beforeReopen = await repo.readSnapshot();
    repo.close(); repo = openJobRepository(path, { now: () => at });
    const recovered = await makeTools(repo)[1].execute(command, context("durable"));
    assert.deepEqual(recovered, first); assert.deepEqual(await repo.readSnapshot(), beforeReopen);
    const changed = capture("456789123");
    const changedPreview = await makeTools(repo)[0].execute({ ...changed, expectedRevision: beforeReopen.revision }, context("changed-preview"));
    await assert.rejects(makeTools(repo)[1].execute({ ...changed, expectedRevision: beforeReopen.revision, previewFingerprint: changedPreview.previewFingerprint, reviewed: true }, context("durable")), hasCode("idempotency-conflict"));
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test("changed request content, stale preview, reserved-source replacement and future capture never write", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const { tools, command } = await preview(repo);
    const initial = await repo.readSnapshot();
    await assert.rejects(tools[1].execute({ ...command, capturedAt: "2026-10-18T23:59:00.000Z" }, context()), hasCode("stale-version"));
    await assert.rejects(tools[0].execute({ ...capture(), capturedAt: "2026-10-19T00:05:00.001Z", expectedRevision: 0 }, context()), hasCode("invalid-input"));
    assert.deepEqual(await repo.readSnapshot(), initial);
    await repo.registerSource({ ...reviewedCardsSource("liepin"), name: "已有自定义来源不得覆盖" }, { actorScope: "synthetic-owner", idempotencyKey: "occupied" });
    const occupied = await repo.readSnapshot();
    await assert.rejects(tools[1].execute(command, context()), hasCode("stale-version"));
    await assert.rejects(tools[0].execute({ ...capture(), expectedRevision: occupied.revision }, context()), hasCode("source-changed"));
    assert.deepEqual(await repo.readSnapshot(), occupied);
  } finally { repo.close(); }
});

test("raw-only fields stay absent when undisclosed and explicit timezone publication is preserved", () => {
  const input = capture();
  const card = input.cards[0]!;
  const { locationText: _location, salaryText: _salary, publicationText: _publication, ...minimal } = card;
  const absent = reviewedCardsPage({ ...input, cards: [{ ...minimal, evidence: { ...minimal.evidence, fields: minimal.evidence.fields.slice(0, 3) } }] });
  assert.deepEqual(absent.records[0]!.locations, []); assert.deepEqual(absent.records[0]!.compensations, []);
  assert.equal(absent.records[0]!.sourcePublishedAt, undefined); assert.equal(absent.records[0]!.sourcePublishedRaw, undefined);
  const exact = reviewedCardsPage({ ...input, cards: [{ ...card, publicationText: "2026-09-01T08:30:00+08:00" }] });
  assert.equal(exact.records[0]!.sourcePublishedAt, "2026-09-01T08:30:00+08:00");
});

test("re-previewing the exact same capture at a newer index version does not append another source observation", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const first = await preview(repo);
    await first.tools[1].execute(first.command, context("original-capture"));
    const original = await repo.readSnapshot();
    const repeated = await preview(repo);
    assert.notEqual(repeated.result.previewFingerprint, first.result.previewFingerprint);
    assert.equal(repeated.result.cards[0]!.existing, true);
    const receipt = await repeated.tools[1].execute(repeated.command, context("new-command-same-capture"));
    assert.equal(receipt.counts.newObservations, 0); assert.equal(receipt.counts.newJobs, 0);
    assert.deepEqual((await repo.readSnapshot()).observations, original.observations);
    assert.deepEqual((await repo.readSnapshot()).snapshots, original.snapshots);
    assert.deepEqual((await repo.readSnapshot()).jobs, original.jobs);
  } finally { repo.close(); }
});

test("same provider record keeps identity across tracking variants; company replacement and older captures are blocked", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const first = await preview(repo);
    await first.tools[1].execute(first.command, context("first"));
    const input = capture();
    const card = input.cards[0]!;
    const url = "https://m.liepin.com/job/123456789.shtml?different=tracking";
    const changed: ReviewedCardsCapture = { ...input, cards: [{ ...card, url, evidence: { ...card.evidence,
      fields: card.evidence.fields.map((field) => field.field === "url" ? { ...field, text: url } : field) } }] };
    const second = await preview(repo, changed);
    assert.equal(second.result.cards[0]!.existing, true); assert.equal(second.result.cards[0]!.jobId, first.result.cards[0]!.jobId);
    const result = await second.tools[1].execute(second.command, context("second"));
    assert.equal(result.counts.newJobs, 0); assert.equal((await repo.readSnapshot()).jobs.length, 1);
    const before = await repo.readSnapshot();
    await assert.rejects(first.tools[0].execute({ ...input, capturedAt: "2026-10-18T23:59:59.000Z", expectedRevision: before.revision }, context("older")), hasCode("stale-version"));
    const company = "另一家不相关企业";
    const differentCompany: ReviewedCardsCapture = { ...input, cards: [{ ...card, company, cardText: card.cardText.replace(card.company, company), evidence: { ...card.evidence,
      fields: card.evidence.fields.map((field) => field.field === "company" ? { ...field, text: company } : field) } }] };
    await assert.rejects(preview(repo, differentCompany), hasCode("source-changed"));
    assert.deepEqual(await repo.readSnapshot(), before);
  } finally { repo.close(); }
});

test("a later card preserves full JD selection and prior complete source facts", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const source = reviewedCardsSource("liepin");
    const fullPage = reviewedCardsPage(capture());
    fullPage.records[0] = { ...fullPage.records[0]!, description: "合成完整 JD：研发职责、任职要求与详细项目说明。", completeness: "detail" };
    const full = await projectSourcePage(emptyDelta(), source, fullPage, "synthetic-full-detail");
    await repo.importSnapshot(full.delta, { actorScope: "synthetic-owner", idempotencyKey: "seed-detail" });
    const initial = await repo.readSnapshot();
    const next = await preview(repo);
    await next.tools[1].execute(next.command, context("card-after-full"));
    const saved = await repo.readSnapshot();
    assert.equal(saved.jobs[0]!.description, initial.jobs[0]!.description);
    assert.equal(saved.jobs[0]!.selectedSnapshotId, initial.jobs[0]!.selectedSnapshotId);
    assert.equal(saved.snapshots.length, 2); assert.equal(saved.observations.length, 2);
    assert.equal(saved.snapshots.find((snapshot) => snapshot.id !== initial.snapshots[0]!.id)!.completeness, "excerpt");
  } finally { repo.close(); }
});

test("tool effects forbid unconfirmed writes and cancellation blocks mutation", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const { tools, command } = await preview(repo);
    const registry = createToolRegistry(tools);
    const trusted: TrustedToolContext = { requestId: "synthetic-denied", actorScope: "synthetic-ui", idempotencyKey: "denied",
      signal: new AbortController().signal, budget: { requests: 0, bytes: 2_000_000, timeoutMs: 30_000 }, allowedEffects: ["read-index"] };
    const denied = await registry.execute("jobs.import-reviewed-cards", command, trusted);
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "not-authorized");
    const unconfirmed = await registry.execute("jobs.import-reviewed-cards", { ...command, reviewed: false }, { ...trusted, allowedEffects: ["local-write"], idempotencyKey: "unconfirmed" });
    assert.equal(unconfirmed.ok, false); if (!unconfirmed.ok) assert.equal(unconfirmed.error.code, "invalid-input");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tools[1].execute(command, context("cancelled", controller.signal)), hasCode("cancelled"));
    assert.equal((await repo.readSnapshot()).jobs.length, 0);
  } finally { repo.close(); }
});

test("a concurrent index write between preview projection and commit is rejected rather than silently reprojected", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const { command } = await preview(repo);
    const original = repo.readProjectionSnapshot.bind(repo);
    repo.readProjectionSnapshot = async () => {
      const snapshot = await original();
      await repo.registerSource({ ...reviewedCardsSource("linkedin"), sourceId: "synthetic-concurrent-source" }, { actorScope: "synthetic-owner", idempotencyKey: "race" });
      return snapshot;
    };
    await assert.rejects(makeTools(repo)[1].execute(command, context("cas-race")), hasCode("stale-version"));
    const saved = await repo.readSnapshot();
    assert.equal(saved.jobs.length, 0); assert.equal(saved.sources.length, 1); assert.equal(saved.sources[0]!.sourceId, "synthetic-concurrent-source");
  } finally { repo.close(); }
});

test("a cancellation delivered after reading the index prevents a late local write", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const { command } = await preview(repo);
    const original = repo.readProjectionSnapshot.bind(repo);
    const controller = new AbortController();
    repo.readProjectionSnapshot = async () => {
      const snapshot = await original(); controller.abort(); return snapshot;
    };
    await assert.rejects(makeTools(repo)[1].execute(command, context("cancel-after-read", controller.signal)), hasCode("cancelled"));
    assert.deepEqual(await repo.readSnapshot(), emptyDelta());
  } finally { repo.close(); }
});

test("a reviewed two-card batch commits one revision; conflicting employer identity makes the entire batch read-only", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const firstCapture = capture();
    const batch = { ...firstCapture, cards: [firstCapture.cards[0]!, capture("987654321").cards[0]!] };
    const first = await preview(repo, batch);
    const receipt = await first.tools[1].execute(first.command, context("batch"));
    const saved = await repo.readSnapshot();
    assert.equal(receipt.revision, 1); assert.equal(receipt.counts.newJobs, 2); assert.equal(saved.jobs.length, 2);
    assert.equal(saved.sources.length, 1); assert.equal(saved.companies.length, 1);
    const unrelated = capture("333444555").cards[0]!;
    const old = firstCapture.cards[0]!;
    const company = "已换成另一雇主";
    const conflict = { ...old, company, cardText: old.cardText.replace(old.company, company), evidence: { ...old.evidence,
      fields: old.evidence.fields.map((field) => field.field === "company" ? { ...field, text: company } : field) } };
    await assert.rejects(preview(repo, { ...firstCapture, cards: [unrelated, conflict] }), hasCode("source-changed"));
    assert.deepEqual(await repo.readSnapshot(), saved);
  } finally { repo.close(); }
});

test("concurrent equal commands recover one durable receipt and one source observation", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const { command } = await preview(repo);
    const results = await Promise.all([
      makeTools(repo)[1].execute(command, context("same-concurrent-command")),
      makeTools(repo)[1].execute(command, context("same-concurrent-command")),
    ]);
    assert.deepEqual(results[0], results[1]);
    const saved = await repo.readSnapshot();
    assert.equal(saved.revision, 1); assert.equal(saved.jobs.length, 1); assert.equal(saved.observations.length, 1);
    assert.equal(saved.snapshots.length, 1);
  } finally { repo.close(); }
});

test("reviewing A then A+B then B+A from the same capture observes each distinct card once", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const a = capture();
    const b = capture("987654321");
    const first = await preview(repo, a);
    await first.tools[1].execute(first.command, context("subset-a"));
    const afterA = await repo.readSnapshot();
    const batch = await preview(repo, { ...a, cards: [a.cards[0]!, b.cards[0]!] });
    const added = await batch.tools[1].execute(batch.command, context("subset-a-b"));
    const afterBatch = await repo.readSnapshot();
    assert.equal(added.counts.newJobs, 1); assert.equal(added.counts.newObservations, 1);
    assert.equal(afterBatch.jobs.length, 2); assert.equal(afterBatch.observations.length, 2);
    assert.deepEqual(afterBatch.observations.find((item) => item.id === afterA.observations[0]!.id), afterA.observations[0]);
    const reordered = await preview(repo, { ...a, cards: [b.cards[0]!, a.cards[0]!] });
    const unchanged = await reordered.tools[1].execute(reordered.command, context("subset-b-a"));
    const final = await repo.readSnapshot();
    assert.equal(unchanged.counts.newJobs, 0); assert.equal(unchanged.counts.newObservations, 0);
    assert.deepEqual(final.jobs, afterBatch.jobs); assert.deepEqual(final.observations, afterBatch.observations);
    assert.deepEqual(final.snapshots, afterBatch.snapshots);
  } finally { repo.close(); }
});

test("changed card text under the same capture header appends a distinct immutable observation", async () => {
  const repo = openJobRepository(":memory:", { now: () => at });
  try {
    const input = capture();
    const first = await preview(repo, input);
    await first.tools[1].execute(first.command, context("same-header-first"));
    const before = await repo.readSnapshot();
    const card = input.cards[0]!;
    const changed = { ...input, cards: [{ ...card, cardText: `${card.cardText} 新增来源卡片文字：需要自动化测试经验。` }] };
    const next = await preview(repo, changed);
    const receipt = await next.tools[1].execute(next.command, context("same-header-changed"));
    const after = await repo.readSnapshot();
    assert.equal(receipt.counts.newJobs, 0); assert.equal(receipt.counts.newObservations, 1); assert.equal(receipt.counts.newSnapshots, 1);
    assert.equal(after.jobs.length, 1); assert.equal(after.observations.length, 2); assert.equal(after.snapshots.length, 2);
    assert.deepEqual(after.observations.find((item) => item.id === before.observations[0]!.id), before.observations[0]);
    assert.deepEqual(after.snapshots.find((item) => item.id === before.snapshots[0]!.id), before.snapshots[0]);
    assert.notEqual(after.jobs[0]!.selectedSnapshotId, before.jobs[0]!.selectedSnapshotId);
    assert.equal(after.jobs[0]!.description, changed.cards[0]!.cardText);
  } finally { repo.close(); }
});
