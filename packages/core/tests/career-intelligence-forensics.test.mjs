import assert from "node:assert/strict";
import test from "node:test";
import { createJobForensicsSnapshot, analyzeJobForensics, validateJobForensicsSnapshot,
  createForensicsReconciliationState, applyForensicsMerge, restoreForensicsGrouping, JobForensicsObservationSchema } from "../src/career-intelligence/job-forensics.ts";
import { intelligenceHash } from "../src/career-intelligence/snapshots.ts";

const asOf = "2026-11-09T00:00:00.000Z";
async function makeSnapshot(change = () => {}) {
  const sources = await Promise.all(["source-a", "source-b", "source-public"].map(async id => ({ id, hash: await intelligenceHash(`synthetic:${id}`), capturedAt: asOf })));
  const salary = (sourceId, min, max) => ({ status: "comparable", min, max, currency: "CNY", period: "annual", tax: "gross", kind: "base", sourceId, disclosedAt: asOf });
  const observation = (id, platform, sourceId) => ({ id, revision: "v1", platform, platformJobId: `platform-job-${id}`, sourceId,
    title: "Synthetic AI engineer", companyId: "company-a", roleKey: "ai-engineer", locationKey: "office-shanghai", departmentKey: "team-a",
    availability: "active", observedAt: asOf, publishedAt: null, firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: asOf,
    refreshTimes: ["2026-11-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "2026-11-07T00:00:00.000Z"],
    salary: salary(sourceId, 100000, 250000), declaredSkillIds: ["agent"] });
  const input = { binding: { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "session-1", factRevision: "facts-v1", rulesVersion: "rules-v1" },
    authorization: { grantId: "synthetic-grant", expiresAt: "2099-01-01T00:00:00.000Z", sourceIds: sources.map(item => item.id), purpose: "job_forensics" },
    asOf, sources, observations: [observation("observation-a", "board-a", "source-a"), { ...observation("observation-b", "board-b", "source-b"), availability: "closed", salary: salary("source-b", 350000, 400000) }],
    publicTechnicalObservations: [{ id: "public-a", companyId: "company-a", departmentKey: null, sourceId: "source-public", observedAt: asOf, skillIds: ["java"], scope: "company", activity: "observed" }],
    rules: { version: "rules-v1", longLivedDays: 90, refreshWindowDays: 14, frequentRefreshCount: 3, wideSalaryRatio: 2, maxSourceAgeDays: 30 } };
  change(input);
  return createJobForensicsSnapshot(input);
}
const current = { isCurrent: () => true };

test("timestamped forensic signals retain source hashes and alternative explanations, not company motives", async () => {
  const snapshot = await makeSnapshot(), before = structuredClone(snapshot);
  const report = await analyzeJobForensics(snapshot, current);
  assert.deepEqual(snapshot, before);
  assert.equal(report.status, "completed");
  const codes = report.signals.map(signal => signal.code);
  for (const code of ["long_observed_listing", "frequent_refresh", "wide_salary_range", "salary_conflict", "availability_conflict", "public_stack_not_corroborated"]) assert.ok(codes.includes(code), code);
  for (const signal of report.signals) {
    assert.ok(signal.sourceRefs.length > 0);
    assert.ok(signal.uncertainty.length > 0);
    assert.ok(signal.sourceRefs.every(source => /^[a-f0-9]{64}$/.test(source.hash) && source.capturedAt === asOf));
    assert.ok(["low", "medium"].includes(signal.strength));
  }
  assert.match(report.limitations.join(" "), /not proof of a ghost job/);
  assert.match(report.signals.find(signal => signal.code === "public_stack_not_corroborated").uncertainty.join(" "), /cannot establish this department/);
  assert.equal(report.mergeProposals.length, 1);
  assert.equal(report.mergeProposals[0].status, "pending_review");
  assert.ok(!("ghostProbability" in report));
  assert.ok(!("workHours" in report));
});

test("missing history/availability/salary/public data remain unknown with no synthetic defaults", async () => {
  const snapshot = await makeSnapshot(input => {
    input.observations = [{ ...input.observations[0], availability: "unknown", firstSeenAt: null, lastSeenAt: null, refreshTimes: [], salary: { status: "unknown", reason: "No disclosure." } }];
    input.publicTechnicalObservations = [];
  });
  const report = await analyzeJobForensics(snapshot, current);
  assert.deepEqual(report.signals, []);
  assert.ok(report.unknowns.includes("salary_unknown:observation-a"));
  assert.ok(report.unknowns.includes("availability_unknown:observation-a"));
  assert.ok(report.unknowns.includes("listing_duration_unknown:observation-a"));
  assert.ok(report.unknowns.includes("public_technical_evidence_unknown:observation-a"));
  assert.doesNotMatch(JSON.stringify(report), /45h|compliant|合规核验通过|社区已交叉核验/);
});

test("same title/company text cannot auto-reconcile unresolved or different role/location bindings", async () => {
  for (const change of [observation => { observation.companyId = null; }, observation => { observation.companyId = "company-b"; }, observation => { observation.roleKey = null; }, observation => { observation.locationKey = "office-beijing"; }]) {
    const snapshot = await makeSnapshot(input => change(input.observations[1]));
    const report = await analyzeJobForensics(snapshot, current);
    assert.deepEqual(report.mergeProposals, []);
    assert.ok(!report.signals.some(signal => ["salary_conflict", "availability_conflict"].includes(signal.code)));
  }
});

test("future/conflicting timestamps suppress history conclusions; stale does not mean closed", async () => {
  const conflicting = await makeSnapshot(input => { input.observations = [input.observations[0]]; input.observations[0].refreshTimes.push("2099-01-01T00:00:00.000Z"); });
  const report = await analyzeJobForensics(conflicting, current);
  assert.ok(report.signals.some(signal => signal.code === "observation_time_conflict"));
  assert.ok(!report.signals.some(signal => ["long_observed_listing", "frequent_refresh"].includes(signal.code)));
  const stale = await makeSnapshot(input => { input.sources[0].capturedAt = "2020-01-01T00:00:00.000Z"; });
  const result = await analyzeJobForensics(stale, current);
  assert.ok(result.signals.some(signal => signal.code === "observation_stale"));
  assert.match(result.signals.find(signal => signal.code === "observation_stale").uncertainty.join(" "), /does not establish that a job is closed/);
});

test("unknown or differing salary currencies are not silently converted into a conflict or high offer", async () => {
  const snapshot = await makeSnapshot(input => { input.observations[1].salary.currency = "USD"; });
  const report = await analyzeJobForensics(snapshot, current);
  assert.ok(!report.signals.some(signal => signal.code === "salary_conflict"));
  assert.ok(report.unknowns.includes("salary_currency_incomparable:observation-a:observation-b"));
});

test("unobserved public activity and unrelated departments do not prove absence of a technology", async () => {
  for (const change of [item => { item.activity = "not_observed"; }, item => { item.departmentKey = "different-team"; }, item => { item.observedAt = "2020-01-01T00:00:00.000Z"; }]) {
    const snapshot = await makeSnapshot(input => change(input.publicTechnicalObservations[0]));
    const report = await analyzeJobForensics(snapshot, current);
    assert.ok(!report.signals.some(signal => signal.code === "public_stack_not_corroborated"));
    assert.ok(report.unknowns.includes("public_technical_evidence_unknown:observation-a"));
  }
});

test("merge sidecars retain all original observations and restore mistaken reconciliation with CAS and history", async () => {
  const snapshot = await makeSnapshot(), report = await analyzeJobForensics(snapshot, current);
  const initial = await createForensicsReconciliationState(snapshot), before = structuredClone(initial);
  const merged = await applyForensicsMerge(initial, report.mergeProposals[0], { expectedRevision: 0, decisionId: "merge-decision", confirmed: true });
  assert.deepEqual(initial, before);
  assert.equal(merged.revision, 1);
  assert.equal(merged.groups.length, 1);
  assert.deepEqual(merged.observationIds, initial.observationIds);
  const restored = await restoreForensicsGrouping(merged, "merge-decision", { expectedRevision: 1, decisionId: "restore-decision", confirmed: true });
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.groups, initial.groups);
  assert.deepEqual(restored.observationIds, initial.observationIds);
  assert.equal(restored.history.length, 2);
  assert.deepEqual(snapshot.observations.map(item => item.id), initial.observationIds);
});

test("merge/restore decision IDs are idempotent but cannot be reused for another payload", async () => {
  const snapshot = await makeSnapshot(), report = await analyzeJobForensics(snapshot, current), initial = await createForensicsReconciliationState(snapshot);
  const confirmation = { expectedRevision: 0, decisionId: "decision-1", confirmed: true };
  const merged = await applyForensicsMerge(initial, report.mergeProposals[0], confirmation);
  assert.deepEqual(await applyForensicsMerge(merged, report.mergeProposals[0], confirmation), merged);
  await assert.rejects(applyForensicsMerge(merged, { ...report.mergeProposals[0], id: "different-proposal" }, confirmation), /decision_id_reused/);
  const restored = await restoreForensicsGrouping(merged, "decision-1", { expectedRevision: 1, decisionId: "restore", confirmed: true });
  assert.deepEqual(await restoreForensicsGrouping(restored, "decision-1", { expectedRevision: 1, decisionId: "restore", confirmed: true }), restored);
});

test("CAS, confirmation, snapshot identity, unknown members and drop-original attempts fail closed", async () => {
  const snapshot = await makeSnapshot(), report = await analyzeJobForensics(snapshot, current), initial = await createForensicsReconciliationState(snapshot), proposal = report.mergeProposals[0];
  await assert.rejects(applyForensicsMerge(initial, proposal, { expectedRevision: 99, decisionId: "decision", confirmed: true }), /grouping_revision_conflict/);
  await assert.rejects(applyForensicsMerge(initial, proposal, { expectedRevision: 0, decisionId: "decision", confirmed: false }));
  await assert.rejects(applyForensicsMerge(initial, { ...proposal, snapshotFingerprint: "0".repeat(64) }, { expectedRevision: 0, decisionId: "decision", confirmed: true }), /stale_merge_proposal/);
  await assert.rejects(applyForensicsMerge(initial, { ...proposal, memberObservationIds: ["observation-a", "outside-grant"] }, { expectedRevision: 0, decisionId: "decision", confirmed: true }), /unknown_merge_member/);
  await assert.rejects(applyForensicsMerge({ ...initial, groups: [] }, proposal, { expectedRevision: 0, decisionId: "decision", confirmed: true }), /grouping_drops_original_observation/);
  const merged = await applyForensicsMerge(initial, proposal, { expectedRevision: 0, decisionId: "merge", confirmed: true });
  const changed = { ...merged, groups: [{ ...merged.groups[0], id: "newer-group" }] };
  await assert.rejects(restoreForensicsGrouping(changed, "merge", { expectedRevision: 1, decisionId: "restore", confirmed: true }), /later_grouping_changes_require_review/);
});

test("revocation or input changes discard forensic results before they can be presented for adoption", async () => {
  let checks = 0;
  const report = await analyzeJobForensics(await makeSnapshot(), { isCurrent: () => ++checks === 1 });
  assert.equal(report.status, "stale"); assert.deepEqual(report.signals, []); assert.deepEqual(report.mergeProposals, []);
  const expired = await makeSnapshot(input => { input.authorization.expiresAt = "2000-01-01T00:00:00.000Z"; });
  assert.equal((await analyzeJobForensics(expired, current)).status, "stale");
});

test("external unknown input is strictly parsed and source identity/hash authorization cannot be widened", async () => {
  await assert.rejects(makeSnapshot(input => { input.authorization.sourceIds = ["source-a"]; }), /source_not_authorized/);
  await assert.rejects(makeSnapshot(input => { input.observations[0].sourceId = "not-selected"; }), /missing_source_reference/);
  await assert.rejects(makeSnapshot(input => { input.observations.push(structuredClone(input.observations[0])); }), /duplicate_observation_id/);
  const changed = structuredClone(await makeSnapshot()); changed.observations[0].title = "Different";
  await assert.rejects(validateJobForensicsSnapshot(changed), /snapshot_fingerprint_changed/);
  assert.throws(() => JobForensicsObservationSchema.parse({ title: "Missing all source fields" }));
});
