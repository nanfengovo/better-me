import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createReplayRun, intelligenceHash, type PersonalRuleSidecar, type ReplayCheckpoint, type ReplayStepResult } from "@better-me/core/career-intelligence";
import { StudioArtifactStore, StudioError } from "../src/career-studio/storage.js";
import { createReplayFeedback, StudioReplayCheckpointStore, type ReplayFeedbackContext, type StudioReplayLocalRequest } from "../src/career-studio/replay-feedback.js";
import type { StudioAccess } from "../src/career-studio/contracts.js";

const runtime = { model: "synthetic-local-only", modelDigest: "a".repeat(64) };
const step = (index: number) => ({ id: `analysis-${index}`, kind: "analysis" as const, operation: "resume-review", input: { index } });
const local = async (request: StudioReplayLocalRequest): Promise<ReplayStepResult> => ({ kind: "analysis", summary: `公开动作结果 ${request.step.id}`, artifact: { type: "report", data: { stepId: request.step.id } } });
const makeContext = (ownerId = "owner-a"): ReplayFeedbackContext => ({ id: "context-1", ownerId, session: "session-1", workspaceKey: "workspace-1", resumeId: "resume-1", sourceFingerprint: "b".repeat(64),
  claims: [{ id: "claim-1", text: "实现本机单写者租约。", skillIds: ["sqlite"], contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [] }], jobs: [],
  createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", revoked: false });
const access: StudioAccess = { session: "session-1", valid: async () => true };
async function setup(t: test.TestContext, ownerId = "owner-a") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-replay-feedback-")));
  const stores: StudioArtifactStore[] = [];
  const open = () => { const store = new StudioArtifactStore(ownerId, directory); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, open };
}
const createBody = () => ({ contextId: "context-1", consent: true, idempotencyKey: "new-replay-1", runtime, steps: [step(1), step(2), step(3)], assumptions: "原始假设" });
async function payloadFor(helper: ReturnType<typeof createReplayFeedback>) {
  const identity = await helper.feedbackIdentity("context-1", access), sourceHash = await intelligenceHash("synthetic-event-source"), asOf = new Date().toISOString();
  return { asOf, sources: [{ id: "event-source", hash: sourceHash, capturedAt: asOf }, { id: "note-source", hash: await intelligenceHash("synthetic-note"), capturedAt: asOf }],
    events: [{ id: "event-1", applicationId: "application-1", resumeVersionId: identity.versionId, resumeContentHash: identity.contentHash, sourceId: "event-source", kind: "no_response" as const,
      happenedAt: asOf, origin: "platform_receipt" as const, receiptVerification: "host_verified" as const, platformReceiptId: "user-supplied-receipt" }],
    notes: [{ id: "note-1", sourceId: "note-source", kind: "note" as const, resumeVersionId: identity.versionId, resumeContentHash: identity.contentHash, applicationId: "application-1", happenedAt: asOf,
      text: "请解释本人负责的边界。", verification: "user_reviewed" as const, originalAudioSourceId: null, originalAudioSha256: null, originalAudioDurationMs: null, timestampCorrectionMs: 0,
      segments: [{ id: "segment-1", startMs: 1080000, endMs: 1090000, text: "请解释本人负责的边界。" }],
      claimLinks: [{ segmentId: "segment-1", claimId: "claim-1", claimHash: identity.claims[0]!.hash, confirmedByUser: true, kind: "questioned" as const, topic: "contribution" as const }] }] };
}

async function applyReviewedRule(helper: ReturnType<typeof createReplayFeedback>, sidecarId = "reviewed-replay-rule") {
  const saved = await helper.feedbackSave({ contextId: "context-1", consent: true, idempotencyKey: `feedback-${sidecarId}`, payload: await payloadFor(helper) }, access);
  const analyzed = await helper.feedbackAnalyze({ contextId: "context-1", consent: true, feedbackId: saved.id }, access);
  const proposed = await helper.rulePropose({ contextId: "context-1", consent: true, feedbackId: saved.id, ruleSidecarId: sidecarId, target: "skill",
    initialContent: "用户审查的原有规则。", patchIds: analyzed.report.evolutionPatches.map(patch => patch.id) }, access);
  return helper.ruleApply({ contextId: "context-1", consent: true, proposalId: proposed.proposal.id, decisionId: `apply-${sidecarId}`, expectedRevision: 0, confirmed: true }, access);
}

test("a reviewed-rule revert during replay discards the late model result and makes the old run ineligible for continuation", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open();
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const helper = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { calls++; enter(); await released; return local(request); } });
  await applyReviewedRule(helper);
  const pending = helper.replayCreate({ ...createBody(), steps: [step(1)] }, access);
  await entered;
  await helper.ruleRevert({ contextId: selected.id, consent: true, ruleSidecarId: "reviewed-replay-rule", targetDecisionId: "apply-reviewed-replay-rule",
    decisionId: "revert-during-replay", expectedRevision: 1, confirmed: true }, access);
  release();
  const created = await pending; assert.ok("result" in created && created.result);
  assert.equal(created.result.status, "stale");
  assert.deepEqual(created.result.checkpoint.analysisOutputs, []);
  const saved = await helper.replayGet(created.runId, selected.id, access);
  assert.deepEqual(saved.checkpoints.at(-1)!.analysisOutputs, []);
  await assert.rejects(helper.replayContinue({ contextId: selected.id, runId: created.runId, checkpointId: created.result.checkpoint.id, runtime, consent: true }, access), /replay_reviewed_rules_changed/);
  assert.equal(calls, 1);
});

test("replay freezes only active reviewed sidecars at exact revision and hash, excluding unapplied initial content", async t => {
  const env = await setup(t), selected = makeContext(), observed: StudioReplayLocalRequest[] = [];
  const helper = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { observed.push(request); return local(request); } });
  const applied = await applyReviewedRule(helper);
  const saved = await helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "unreviewed-feedback", payload: await payloadFor(helper) }, access);
  const analyzed = await helper.feedbackAnalyze({ contextId: selected.id, consent: true, feedbackId: saved.id }, access);
  await helper.rulePropose({ contextId: selected.id, consent: true, feedbackId: saved.id, ruleSidecarId: "unapplied-rule", target: "guideline",
    initialContent: "UNREVIEWED_INITIAL_DO_NOT_CONSUME", patchIds: analyzed.report.evolutionPatches.map(patch => patch.id) }, access);
  const created = await helper.replayCreate({ ...createBody(), steps: [step(1)] }, access); assert.ok("result" in created && created.result);
  assert.equal(created.result.status, "completed");
  const frozen = observed[0]!.reviewedRuntimeRules;
  assert.deepEqual(frozen.rules.map(rule => rule.id), ["reviewed-replay-rule"]);
  assert.deepEqual(frozen.rules[0]!.sidecar.current, applied.sidecar.current);
  assert.equal(JSON.stringify(frozen).includes("UNREVIEWED_INITIAL_DO_NOT_CONSUME"), false);
  assert.equal("history" in frozen.rules[0]!.sidecar, false);
  const loaded = await helper.replayGet(created.runId, selected.id, access);
  assert.deepEqual(loaded.metadata.reviewedRuntimeRules, frozen);
  assert.equal(loaded.metadata.input["reviewedRuntimeRulesFingerprint"], frozen.fingerprint);
});

test("new replay and fork use updated rules while old-run continuation is blocked and inherited outputs keep their original fingerprints", async t => {
  const env = await setup(t), selected = makeContext(), observed: StudioReplayLocalRequest[] = [];
  const helper = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { observed.push(request); return local(request); } });
  const original = await helper.replayCreate({ ...createBody(), steps: [step(1), step(2)] }, access); assert.ok("result" in original && original.result);
  const before = await helper.replayGet(original.runId, selected.id, access), checkpointN = before.checkpoints[2]!;
  assert.deepEqual(observed[0]!.reviewedRuntimeRules.rules, []);
  const applied = await applyReviewedRule(helper, "new-reviewed-rule");
  await assert.rejects(helper.replayContinue({ contextId: selected.id, runId: original.runId, checkpointId: original.result.checkpoint.id, runtime, consent: true }, access), /replay_reviewed_rules_changed/);
  assert.equal(observed.length, 2, "stale continuation never reaches the local model");
  const next = await helper.replayCreate({ ...createBody(), idempotencyKey: "new-rule-run", steps: [step(1)] }, access); assert.ok("result" in next && next.result);
  assert.equal(next.result.status, "completed"); assert.equal(observed.at(-1)!.reviewedRuntimeRules.rules[0]!.sidecar.current.hash, applied.sidecar.current.hash);
  const after = await helper.replayGet(next.runId, selected.id, access);
  assert.notEqual(after.metadata.input["reviewedRuntimeRulesFingerprint"], before.metadata.input["reviewedRuntimeRulesFingerprint"]);
  const fork = await helper.replayFork({ contextId: selected.id, parentCheckpointId: checkpointN.id, idempotencyKey: "fork-new-rules", runtime,
    assumptions: "显式新授权，使用新审阅规则；旧分析不重新认证。", consent: true }, access);
  assert.ok("result" in fork && fork.result); assert.equal(fork.result.status, "completed");
  assert.deepEqual(fork.result.executedSteps, ["analysis-2"]); assert.deepEqual(fork.result.skippedAnalysisSteps, ["analysis-1"]);
  assert.equal(observed.at(-1)!.reviewedRuntimeRules.rules[0]!.sidecar.current.hash, applied.sidecar.current.hash);
  assert.equal(fork.result.checkpoint.analysisOutputs[0]!.hash, checkpointN.analysisOutputs[0]!.hash);
  assert.equal(fork.result.checkpoint.analysisOutputs[0]!.inputFingerprint, checkpointN.analysisOutputs[0]!.inputFingerprint);
  assert.notEqual(fork.result.checkpoint.analysisOutputs[0]!.inputFingerprint, fork.result.checkpoint.inputFingerprint);
  assert.deepEqual(await helper.replayGet(original.runId, selected.id, access), before);
});

test("an apply-revert ABA cannot revive an older empty-rule run, and a new run consumes no reverted content", async t => {
  const env = await setup(t), selected = makeContext(), observed: StudioReplayLocalRequest[] = [];
  const helper = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { observed.push(request); return local(request); } });
  const original = await helper.replayCreate({ ...createBody(), steps: [step(1)] }, access); assert.ok("result" in original && original.result);
  await applyReviewedRule(helper);
  await helper.ruleRevert({ contextId: selected.id, consent: true, ruleSidecarId: "reviewed-replay-rule", targetDecisionId: "apply-reviewed-replay-rule",
    decisionId: "revert-aba", expectedRevision: 1, confirmed: true }, access);
  await assert.rejects(helper.replayContinue({ contextId: selected.id, runId: original.runId, checkpointId: original.result.checkpoint.id, runtime, consent: true }, access), /replay_reviewed_rules_changed/);
  assert.equal(observed.length, 1);
  const next = await helper.replayCreate({ ...createBody(), idempotencyKey: "after-revert", steps: [step(1)] }, access); assert.ok("result" in next && next.result);
  assert.equal(next.result.status, "completed"); assert.deepEqual(observed.at(-1)!.reviewedRuntimeRules.rules, []);
  assert.notEqual(observed.at(-1)!.reviewedRuntimeRules.fingerprint, observed[0]!.reviewedRuntimeRules.fingerprint);
  assert.equal(JSON.stringify(observed.at(-1)!.reviewedRuntimeRules).includes("用户审查的原有规则。"), false);
});

test("reviewed-rule snapshots survive SQLite restart and reject changed content hashes or forged sidecar ownership before dispatch", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open();
  const first = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected, localModel: local });
  await applyReviewedRule(first);
  const created = await first.replayCreate({ ...createBody(), steps: [step(1)] }, access); assert.ok("result" in created && created.result);
  const before = await first.replayGet(created.runId, selected.id, access); store.close();
  const restarted = env.open(); let calls = 0;
  const helper = createReplayFeedback({ store: restarted, ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { calls++; return local(request); } });
  assert.deepEqual(await helper.replayGet(created.runId, selected.id, access), before);
  assert.equal((await helper.replayContinue({ contextId: selected.id, runId: created.runId, checkpointId: created.result.checkpoint.id, runtime, consent: true }, access)).result.status, "completed");
  assert.equal(calls, 0, "completed analysis is not run again after restart");
  type RuleEnvelope = { ownerId: string; workspaceKey: string; sidecar: PersonalRuleSidecar };
  const original = restarted.get<RuleEnvelope>("personal-rule", "reviewed-replay-rule")!;
  const invalidContent = structuredClone(original.value); invalidContent.sidecar.current.content += "unhashed mutation";
  restarted.put("personal-rule", original.id, original.revision, invalidContent);
  const continuation = { contextId: selected.id, runId: created.runId, checkpointId: created.result.checkpoint.id, runtime, consent: true };
  await assert.rejects(helper.replayContinue(continuation, access), /rule_content_hash_changed/);
  const invalidOwner = structuredClone(original.value); invalidOwner.sidecar.binding.ownerId = "owner-b";
  const mutated = restarted.get("personal-rule", original.id)!; restarted.put("personal-rule", original.id, mutated.revision, invalidOwner);
  await assert.rejects(helper.replayContinue(continuation, access), /personal_rule_owner_mismatch/);
  assert.equal(calls, 0); assert.deepEqual(await helper.replayGet(created.runId, selected.id, access), before);
});

test("minimal real SQLite workflow persists partial checkpoints, restarts and continues without replaying earlier analysis", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open(), seen: string[] = [];
  const first = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { seen.push(request.step.id); if (request.step.id === "analysis-2") throw new Error("synthetic model interruption"); return local(request); } });
  const created = await first.replayCreate(createBody(), access);
  assert.ok("result" in created && created.result);
  assert.equal(created.result.status, "partial"); assert.deepEqual(created.result.executedSteps, ["analysis-1", "analysis-2"]);
  const firstCheckpointId = created.result.checkpoint.id, firstRunId = created.runId, oldRun = await first.replayGet(firstRunId, selected.id, access);
  assert.equal(oldRun.checkpoints.length, 4);
  const atN = oldRun.checkpoints.find(checkpoint => checkpoint.sequence === 2)!;
  store.close(); const restarted = env.open();
  const continuedCalls: string[] = [];
  const second = createReplayFeedback({ store: restarted, ownerId: selected.ownerId, getContext: () => selected,
    localModel: async request => { continuedCalls.push(request.step.id); return local(request); } });
  const continued = await second.replayContinue({ contextId: selected.id, runId: firstRunId, checkpointId: firstCheckpointId, runtime, consent: true }, access);
  assert.equal(continued.result.status, "completed"); assert.deepEqual(continuedCalls, ["analysis-2", "analysis-3"]); assert.deepEqual(continued.result.skippedAnalysisSteps, ["analysis-1"]);
  const beforeFork = await second.replayGet(firstRunId, selected.id, access);
  continuedCalls.length = 0;
  const fork = await second.replayFork({ contextId: selected.id, parentCheckpointId: atN.id, idempotencyKey: "fork-1", runtime, assumptions: "修改第N步后的假设", consent: true }, access);
  assert.ok("result" in fork && fork.result); assert.equal(fork.result.status, "completed");
  assert.deepEqual(continuedCalls, ["analysis-2", "analysis-3"]); assert.deepEqual(fork.result.skippedAnalysisSteps, ["analysis-1"]);
  assert.equal(fork.result.checkpoint.analysisOutputs[0]!.inherited, true);
  assert.notEqual(fork.result.checkpoint.analysisOutputs[0]!.inputFingerprint, fork.result.checkpoint.inputFingerprint);
  assert.deepEqual(await second.replayGet(firstRunId, selected.id, access), beforeFork, "SQLite original history remains byte-equivalent after fork");
});

test("single-record head/checkpoint append is atomic CAS, immutable and hash-verified across SQLite instances", async t => {
  const env = await setup(t), storeA = env.open(), storeB = env.open(), adapterA = new StudioReplayCheckpointStore(storeA, "owner-a"), adapterB = new StudioReplayCheckpointStore(storeB, "owner-a");
  const selected = makeContext(), binding = { ownerId: "owner-a", workspaceId: selected.workspaceKey, sessionGeneration: selected.session, factRevision: selected.sourceFingerprint, rulesVersion: "rules-v1" };
  adapterA.register("run-cas", { contextId: selected.id, contextFingerprint: "synthetic", workspaceKey: selected.workspaceKey, resumeId: selected.resumeId, input: {}, steps: [step(1)], runtime });
  const initial = await createReplayRun({ runId: "run-cas", binding, graphVersion: "graph-v1", input: {} }, adapterA);
  async function candidate(id: string): Promise<ReplayCheckpoint> {
    const { hash: _old, ...unsigned } = { ...initial, id, sequence: 1, parentCheckpointId: initial.id };
    return { ...unsigned, hash: await intelligenceHash(unsigned) };
  }
  const outcomes = await Promise.allSettled([adapterA.append(await candidate("candidate-a"), { expectedHeadId: initial.id }), adapterB.append(await candidate("candidate-b"), { expectedHeadId: initial.id })]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  const envelope = adapterA.envelope("run-cas"); assert.equal(envelope.checkpoints.length, 2); assert.equal(envelope.headId, envelope.checkpoints[1]!.id);
  await assert.rejects(adapterA.append(envelope.checkpoints[1]!, { expectedHeadId: envelope.headId }), /replay_checkpoint_immutable/);
  const bad = structuredClone(envelope.checkpoints[1]!); bad.inputFingerprint = "0".repeat(64);
  await assert.rejects(adapterA.append(bad, { expectedHeadId: envelope.headId }), /checkpoint_hash_changed/);
});

test("two-owner/context/session boundaries and current runtime reject unauthorized or stale execution", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open();
  assert.throws(() => new StudioArtifactStore("owner-b", env.directory), /studio_owner_mismatch/);
  assert.throws(() => createReplayFeedback({ store, ownerId: "owner-b", getContext: () => makeContext("owner-b"), localModel: local }), /replay_feedback_owner_mismatch/);
  const helper = createReplayFeedback({ store, ownerId: "owner-a", getContext: () => selected, localModel: local });
  await assert.rejects(helper.replayCreate(createBody(), { ...access, session: "other-session" }), /studio_context_stale/);
  await assert.rejects(helper.replayCreate({ ...createBody(), steps: [{ id: "effect", kind: "effect", operation: "save-rule", input: {}, effectKey: "write" }] }, access));
  const created = await helper.replayCreate(createBody(), access); assert.ok("result" in created && created.result);
  await assert.rejects(helper.replayContinue({ contextId: selected.id, runId: created.runId, checkpointId: created.result.checkpoint.id, runtime: { ...runtime, modelDigest: "c".repeat(64) }, consent: true }, access), /replay_runtime_changed_requires_fork/);
  selected.ownerId = "owner-b";
  await assert.rejects(helper.replayGet(created.runId, selected.id, access), /studio_context_stale/);
});

test("idempotent create never reruns a model, while changed idempotent inputs conflict", async t => {
  const env = await setup(t), selected = makeContext(); let calls = 0;
  const helper = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected, localModel: async request => { calls++; return local(request); } });
  await helper.replayCreate(createBody(), access); assert.equal(calls, 3);
  const repeated = await helper.replayCreate(createBody(), access); assert.equal(repeated.repeated, true); assert.equal(repeated.requiresExplicitContinue, true); assert.equal(calls, 3);
  await assert.rejects(helper.replayCreate({ ...createBody(), assumptions: "changed" }, access), /replay_idempotency_conflict/);
});

test("late model results after revocation never persist a completed analysis artifact", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open();
  const helper = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected, localModel: async request => { selected.revoked = true; return local(request); } });
  await applyReviewedRule(helper);
  const created = await helper.replayCreate({ ...createBody(), steps: [step(1)] }, access); assert.ok("result" in created && created.result);
  assert.equal(created.result.status, "stale"); assert.deepEqual(created.result.checkpoint.analysisOutputs, []);
  const saved = helper.replayStore.envelope(created.runId); assert.equal(saved.checkpoints.at(-1)!.analysisOutputs.length, 0);
  assert.equal(saved.checkpoints.at(-1)!.observations.at(-1)!.code, "dispatch_intent_persisted");
});

test("feedback saves exact content-addressed version/claim hashes, downgrades HTTP receipt claims and restarts through review/apply/revert", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open();
  const helper = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected, localModel: local }), payload = await payloadFor(helper);
  const identity = await helper.feedbackIdentity(selected.id, access); assert.equal(identity.versionBinding, "content_addressed_context");
  const saved = await helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "feedback-1", payload }, access);
  assert.equal(saved.snapshot.events[0]!.receiptVerification, "unverified"); assert.equal(saved.snapshot.resumes[0]!.contentHash, selected.sourceFingerprint);
  assert.equal(saved.snapshot.resumes[0]!.versionId, identity.versionId);
  const repeated = await helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "feedback-1", payload }, access); assert.equal(repeated.repeated, true);
  const analyzed = await helper.feedbackAnalyze({ contextId: selected.id, consent: true, feedbackId: saved.id }, access);
  assert.equal(analyzed.report.evolutionPatches.length, 1); assert.equal(analyzed.report.versions[0]!.unknownOutcomeApplications, 1);
  const proposed = await helper.rulePropose({ contextId: selected.id, consent: true, feedbackId: saved.id, ruleSidecarId: "private-career-skill", target: "skill",
    initialContent: "原有用户确认规则。", patchIds: analyzed.report.evolutionPatches.map(patch => patch.id) }, access);
  assert.equal(proposed.requiresExplicitConfirmation, true); assert.equal(proposed.sidecar.current.revision, 0);
  const applied = await helper.ruleApply({ contextId: selected.id, consent: true, proposalId: proposed.proposal.id, decisionId: "apply-1", expectedRevision: 0, confirmed: true }, access);
  assert.equal(applied.runtimeOnly, true); assert.equal(applied.sidecar.current.revision, 1);
  const sameApply = await helper.ruleApply({ contextId: selected.id, consent: true, proposalId: proposed.proposal.id, decisionId: "apply-1", expectedRevision: 0, confirmed: true }, access);
  assert.equal(sameApply.repeated, true); assert.equal(sameApply.revision, applied.revision);
  store.close(); const reopened = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected, localModel: local });
  const runtimeRules = await reopened.runtimeRules(selected.id, access); assert.equal(runtimeRules.rules[0]!.sidecar.current.hash, applied.sidecar.current.hash);
  const exported = await reopened.ruleExport({ contextId: selected.id, consent: true, ruleSidecarId: "private-career-skill", expectedRevision: 1, confirmed: true }, access);
  assert.equal(exported.installed, false); assert.equal(exported.sha256, applied.sidecar.current.hash); assert.equal(exported.content, applied.sidecar.current.content);
  const restored = await reopened.ruleRevert({ contextId: selected.id, consent: true, ruleSidecarId: "private-career-skill", targetDecisionId: "apply-1", decisionId: "revert-1", expectedRevision: 1, confirmed: true }, access);
  assert.equal(restored.sidecar.current.content, "原有用户确认规则。"); assert.equal(restored.sidecar.current.revision, 2); assert.equal(restored.sidecar.history.length, 2);
});

test("wrong version/claim/audio hashes, rule CAS and no-confirmation exports fail closed", async t => {
  const env = await setup(t), selected = makeContext(), helper = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected, localModel: local });
  const payload = await payloadFor(helper), wrongVersion = structuredClone(payload); wrongVersion.events[0]!.resumeContentHash = "0".repeat(64);
  await assert.rejects(helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "wrong-version", payload: wrongVersion }, access), /feedback_selected_resume_version_mismatch/);
  const wrongClaim = structuredClone(payload); wrongClaim.notes[0]!.claimLinks[0]!.claimHash = "0".repeat(64);
  await assert.rejects(helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "wrong-claim", payload: wrongClaim }, access), /feedback_claim_mapping_mismatch/);
  const saved = await helper.feedbackSave({ contextId: selected.id, consent: true, idempotencyKey: "valid", payload }, access), report = await helper.feedbackAnalyze({ contextId: selected.id, consent: true, feedbackId: saved.id }, access);
  const proposal = await helper.rulePropose({ contextId: selected.id, consent: true, feedbackId: saved.id, ruleSidecarId: "rules", target: "guideline", initialContent: "", patchIds: report.report.evolutionPatches.map(patch => patch.id) }, access);
  await assert.rejects(helper.ruleApply({ contextId: selected.id, consent: true, proposalId: proposal.proposal.id, decisionId: "decision", expectedRevision: 99, confirmed: true }, access), /rule_revision_conflict/);
  await assert.rejects(helper.ruleExport({ contextId: selected.id, consent: true, ruleSidecarId: "rules", expectedRevision: 0, confirmed: false }, access));
  selected.claims[0]!.text = "changed input";
  await assert.rejects(helper.feedbackAnalyze({ contextId: selected.id, consent: true, feedbackId: saved.id }, access), /feedback_context_mismatch/);
});

test("SQLite payload corruption is detected after process-style restart without an in-memory fallback", async t => {
  const env = await setup(t), selected = makeContext(), store = env.open(), helper = createReplayFeedback({ store, ownerId: selected.ownerId, getContext: () => selected, localModel: local });
  const created = await helper.replayCreate({ ...createBody(), steps: [step(1)] }, access); store.close();
  const raw = new DatabaseSync(path.join(env.directory, "artifacts.sqlite"));
  raw.prepare("UPDATE artifacts SET payload=? WHERE kind=? AND id=?").run(JSON.stringify({ ownerId: "tampered" }), "replay-run", created.runId); raw.close();
  const reopened = createReplayFeedback({ store: env.open(), ownerId: selected.ownerId, getContext: () => selected, localModel: local });
  await assert.rejects(reopened.replayGet(created.runId, selected.id, access), (error: unknown) => error instanceof StudioError && error.code === "studio_artifact_hash_mismatch");
});
