import assert from "node:assert/strict";
import test from "node:test";
import { createOutcomeFeedbackSnapshot, analyzeOutcomeFeedback, validateOutcomeFeedbackSnapshot, OutcomeEventSchema,
  createPersonalRuleSidecar, proposeRuleEvolution, applyRuleEvolution, revertRuleEvolution, validatePersonalRuleSidecar, PERSONAL_RULE_TEXT } from "../src/career-intelligence/outcome-feedback.ts";
import { intelligenceHash } from "../src/career-intelligence/snapshots.ts";
import { hashCommitteeText } from "../src/career-intelligence/contracts.ts";

const asOf = "2026-11-09T00:00:00.000Z", binding = { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "session-1", factRevision: "facts-v1", rulesVersion: "rules-v1" };
const text = "请解释租约恢复中本人负责的边界。", claimText = "实现本机单写者租约。", audioSha = "f".repeat(64);
async function makeSnapshot(change = () => {}) {
  const resumeHash = await intelligenceHash("synthetic-resume-v1"), secondHash = await intelligenceHash("synthetic-resume-v2"), claimHash = await hashCommitteeText(claimText);
  const event = (id, applicationId, kind) => ({ id, applicationId, resumeVersionId: "resume-v1", resumeContentHash: resumeHash, sourceId: "event-source", kind, happenedAt: asOf,
    origin: "self_report", receiptVerification: "unverified", platformReceiptId: null });
  const input = { binding, authorization: { grantId: "synthetic-grant", expiresAt: "2099-01-01T00:00:00.000Z", sourceIds: ["event-source", "note-source", "audio-source"], purpose: "outcome_feedback" }, asOf,
    sources: [{ id: "event-source", hash: await intelligenceHash("synthetic-events"), capturedAt: asOf }, { id: "note-source", hash: await hashCommitteeText(text), capturedAt: asOf }, { id: "audio-source", hash: audioSha, capturedAt: asOf }],
    resumes: [{ resumeId: "resume", versionId: "resume-v1", contentHash: resumeHash, claims: [{ id: "claim-1", text: claimText }] }, { resumeId: "resume", versionId: "resume-v2", contentHash: secondHash, claims: [{ id: "claim-1", text: claimText }] }],
    events: [event("event-1", "application-1", "submitted"), event("event-2", "application-1", "no_response"), event("event-3", "application-2", "submitted"),
      { ...event("event-4", "application-2", "interview_invited"), origin: "platform_receipt", platformReceiptId: "user-uploaded-screenshot", receiptVerification: "unverified" },
      { ...event("event-5", "application-3", "offer"), resumeVersionId: "resume-v2", resumeContentHash: secondHash, origin: "platform_receipt", platformReceiptId: "verified-platform-record", receiptVerification: "host_verified" }],
    notes: [{ id: "note-1", sourceId: "note-source", kind: "audio_transcript", resumeVersionId: "resume-v1", resumeContentHash: resumeHash, applicationId: "application-2", happenedAt: asOf,
      text, verification: "unverified_transcript", originalAudioSourceId: "audio-source", originalAudioSha256: audioSha, originalAudioDurationMs: 3600000, timestampCorrectionMs: 500,
      segments: [{ id: "segment-1", startMs: 1080000, endMs: 1090000, text }],
      claimLinks: [{ segmentId: "segment-1", claimId: "claim-1", claimHash, confirmedByUser: true, kind: "questioned", topic: "contribution" }] }] };
  change(input); return createOutcomeFeedbackSnapshot(input);
}
const current = { isCurrent: () => true };
async function ruleSetup() {
  const snapshot = await makeSnapshot(), report = await analyzeOutcomeFeedback(snapshot, current), state = await createPersonalRuleSidecar({ id: "personal-guideline", binding, target: "guideline", content: "原始个人规则，必须保留历史。" });
  const proposal = await proposeRuleEvolution(report, state, report.evolutionPatches.map(patch => patch.id));
  return { snapshot, report, state, proposal };
}
async function confirmation(operation, payload, expectedRevision, decisionId = "rule-decision") {
  return { decisionId, expectedRevision, confirmed: true, authority: { id: `authority-${decisionId}`, binding, purpose: "personal_rule_update", targetSidecarId: "personal-guideline",
    inputHash: await intelligenceHash(operation === "apply" ? { operation, proposal: payload } : { operation, targetDecisionId: payload }), expectedRevision, expiresAt: "2099-01-01T00:00:00.000Z" } };
}

test("version/hash-bound outcomes are observational; self-report, unverified and Host-verified platform sources stay separate", async () => {
  const snapshot = await makeSnapshot(), original = structuredClone(snapshot), report = await analyzeOutcomeFeedback(snapshot, current);
  assert.deepEqual(snapshot, original); assert.equal(report.status, "completed");
  assert.equal(report.versions[0].observedSubmissions, 2); assert.equal(report.versions[0].observedInvitationApplications, 1);
  assert.equal(report.versions[0].unknownOutcomeApplications, 1, "no response must not become rejected");
  assert.equal(report.versions[0].invitationFractionAmongObservedSubmissions, .5);
  assert.deepEqual(report.versions[0].origins, { selfReportedEvents: 3, unverifiedPlatformEvents: 1, hostVerifiedPlatformEvents: 0 });
  assert.equal(report.versions[1].observedOfferApplications, 1); assert.equal(report.versions[1].invitationFractionAmongObservedSubmissions, null);
  assert.match(report.limitations.join(" "), /not causal effects/); assert.match(report.limitations.join(" "), /not rejection/);
  assert.ok(!("reward" in report)); assert.ok(!("trainedPolicy" in report));
});

test("event ingestion is idempotent by eventId+payloadHash and conflicting event ID reuse is rejected", async () => {
  const snapshot = await makeSnapshot(input => input.events.push(structuredClone(input.events[0])));
  const report = await analyzeOutcomeFeedback(snapshot, current);
  assert.equal(report.versions[0].observedSubmissions, 2); assert.equal(report.versions[0].origins.selfReportedEvents, 3);
  await assert.rejects(makeSnapshot(input => input.events.push({ ...input.events[0], kind: "rejected" })), /outcome_event_id_reused/);
});

test("transcript cue preserves original audio/text SHA and timestamp correction without certifying the transcript or inventing facts", async () => {
  const report = await analyzeOutcomeFeedback(await makeSnapshot(), current), patch = report.evolutionPatches[0];
  assert.equal(patch.operation, "request_clarification"); assert.equal(patch.status, "pending_review");
  assert.equal(patch.source.originalAudioSha256, audioSha); assert.equal(patch.source.transcriptHash, await hashCommitteeText(text));
  assert.equal(patch.source.transcriptionVerification, "unverified_transcript");
  assert.equal(patch.source.originalStartMs, 1080000); assert.equal(patch.source.correctedStartMs, 1080500);
  assert.equal(patch.claimHash, await hashCommitteeText(claimText));
  assert.match(patch.question, /请核对/); assert.ok(!("resumeRewrite" in patch)); assert.ok(!("verifiedFact" in patch));
});

test("authorized local text notes work without an STT provider; unconfirmed/positive mappings do not create corrective patches", async () => {
  const note = await makeSnapshot(input => Object.assign(input.notes[0], { kind: "note", originalAudioSourceId: null, originalAudioSha256: null, originalAudioDurationMs: null }));
  assert.equal((await analyzeOutcomeFeedback(note, current)).evolutionPatches.length, 1);
  for (const change of [link => { link.confirmedByUser = false; }, link => { link.kind = "positive"; }]) {
    const report = await analyzeOutcomeFeedback(await makeSnapshot(input => change(input.notes[0].claimLinks[0])), current);
    assert.deepEqual(report.evolutionPatches, []);
  }
  const invalidTime = await makeSnapshot(input => { input.notes[0].timestampCorrectionMs = -2000000; });
  const report = await analyzeOutcomeFeedback(invalidTime, current);
  assert.equal(report.evolutionPatches[0].source.correctedStartMs, null);
  assert.ok(report.unknowns.includes("feedback_time_mapping_unknown:note-1:segment-1"));
});

test("late/future events and revoked or changed snapshots cannot be adopted", async () => {
  const future = await makeSnapshot(input => { input.events[3].happenedAt = "2099-01-01T00:00:00.000Z"; });
  const report = await analyzeOutcomeFeedback(future, current); assert.equal(report.versions[0].observedInvitationApplications, 0); assert.ok(report.unknowns.includes("future_outcome_event:event-4"));
  let calls = 0; const stale = await analyzeOutcomeFeedback(await makeSnapshot(), { isCurrent: () => ++calls === 1 });
  assert.equal(stale.status, "stale"); assert.deepEqual(stale.versions, []); assert.deepEqual(stale.evolutionPatches, []);
});

test("resume versions, claim mappings, source grants, original audio and transcript hashes fail closed", async () => {
  await assert.rejects(makeSnapshot(input => { input.events[0].resumeContentHash = "0".repeat(64); }), /feedback_resume_version_mismatch/);
  await assert.rejects(makeSnapshot(input => { input.notes[0].claimLinks[0].claimHash = "0".repeat(64); }), /feedback_claim_mapping_mismatch/);
  await assert.rejects(makeSnapshot(input => { input.notes[0].originalAudioSha256 = "0".repeat(64); }), /original_audio_hash_mismatch/);
  await assert.rejects(makeSnapshot(input => { input.authorization.sourceIds = ["event-source"]; }), /source_not_authorized/);
  const tampered = structuredClone(await makeSnapshot()); tampered.notes[0].text += "new";
  await assert.rejects(validateOutcomeFeedbackSnapshot(tampered), /snapshot_fingerprint_changed/);
  assert.throws(() => OutcomeEventSchema.parse({ ...tampered.events[0], receiptVerification: "host_verified", platformReceiptId: "manual" }));
});

test("personal guideline/Skill patch is an explicitly confirmed CAS sidecar effect and reversion appends history", async () => {
  const { state, proposal } = await ruleSetup(), before = structuredClone(state), approval = await confirmation("apply", proposal, 0);
  const applied = await applyRuleEvolution(state, proposal, approval, current);
  assert.deepEqual(state, before); assert.equal(applied.current.revision, 1); assert.equal(applied.history.length, 1);
  assert.ok(applied.current.content.includes(PERSONAL_RULE_TEXT.clarify_contribution)); assert.ok(applied.current.content.startsWith(state.current.content));
  assert.deepEqual(await applyRuleEvolution(applied, proposal, approval, current), applied, "same confirmed action is idempotent");
  const undo = await confirmation("revert", approval.decisionId, 1, "revert-decision"), restored = await revertRuleEvolution(applied, approval.decisionId, undo, current);
  assert.equal(restored.current.content, state.current.content); assert.equal(restored.current.hash, state.current.hash); assert.equal(restored.current.revision, 2); assert.equal(restored.history.length, 2);
  assert.deepEqual(await revertRuleEvolution(restored, approval.decisionId, undo, current), restored);
  assert.ok(!("filePath" in applied)); assert.ok(!("businessReceipt" in applied));
});

test("rule patches cannot smuggle arbitrary new facts, reuse authority for another action, bypass CAS or cross owners", async () => {
  const { state, proposal, report } = await ruleSetup(), approval = await confirmation("apply", proposal, 0);
  await assert.rejects(applyRuleEvolution(state, { ...proposal, ruleCodes: ["claim-invented-throughput"] }, approval, current));
  await assert.rejects(applyRuleEvolution(state, { ...proposal, id: "another-proposal" }, approval, current), /rule_write_action_mismatch/);
  await assert.rejects(applyRuleEvolution(state, proposal, { ...approval, confirmed: false }, current));
  await assert.rejects(applyRuleEvolution(state, proposal, { ...approval, authority: { ...approval.authority, binding: { ...binding, ownerId: "another-owner" } } }, current), /rule_write_authority_stale/);
  await assert.rejects(applyRuleEvolution(state, proposal, approval, { isCurrent: () => false }), /rule_write_authority_stale/);
  await assert.rejects(proposeRuleEvolution({ ...report, binding: { ...binding, ownerId: "other" } }, state, report.evolutionPatches.map(patch => patch.id)), /feedback_rule_owner_mismatch/);
  const applied = await applyRuleEvolution(state, proposal, approval, current);
  await assert.rejects(applyRuleEvolution(applied, proposal, await confirmation("apply", proposal, 1, "another-decision"), current), /rule_revision_conflict/);
  const tampered = structuredClone(applied); tampered.current.content += "unexpected";
  await assert.rejects(validatePersonalRuleSidecar(tampered), /rule_content_hash_changed/);
});

test("reverting an older patch never overwrites later personal rule changes", async () => {
  const { state, proposal, report } = await ruleSetup(), approval = await confirmation("apply", proposal, 0), applied = await applyRuleEvolution(state, proposal, approval, current);
  const second = await proposeRuleEvolution(report, applied, report.evolutionPatches.map(patch => patch.id)), secondApproval = await confirmation("apply", second, 1, "second-decision");
  const latest = await applyRuleEvolution(applied, second, secondApproval, current);
  await assert.rejects(revertRuleEvolution(latest, approval.decisionId, await confirmation("revert", approval.decisionId, 2, "unsafe-revert"), current), /later_rule_changes_require_review/);
});
