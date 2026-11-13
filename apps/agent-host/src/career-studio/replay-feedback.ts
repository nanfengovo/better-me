import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ReplayStepSchema, ReplayStepResultSchema, createReplayRun, forkReplayCheckpoint, runReplaySteps, validateReplayCheckpoint,
  OutcomeFeedbackSnapshotInputSchema, createOutcomeFeedbackSnapshot, analyzeOutcomeFeedback, validateOutcomeFeedbackSnapshot,
  createPersonalRuleSidecar, validatePersonalRuleSidecar, proposeRuleEvolution, applyRuleEvolution, revertRuleEvolution,
  intelligenceHash, hashCommitteeText, PERSONAL_RULE_TEXT,
  type ReplayCheckpoint, type ReplayCheckpointStore, type ReplayStep, type ReplayStepResult, type ReplayAuthority,
  type PersonalRuleSidecar, type RuleEvolutionProposal, type OutcomeFeedbackReport, type OutcomeFeedbackSnapshot,
} from "@better-me/core/career-intelligence";
import { StudioIdSchema, StudioLocalRuntimeSchema, type StudioAccess, type StudioContext, type StudioLocalRuntime } from "./contracts.js";
import { StudioArtifactStore, StudioError, studioHash } from "./storage.js";

const KIND_RUN = "replay-run", KIND_FEEDBACK = "outcome-feedback", KIND_RULE = "personal-rule", KIND_PROPOSAL = "rule-proposal";
const AnalysisStepSchema = ReplayStepSchema.refine(step => step.kind === "analysis", "Studio replay only permits analysis steps; business effects require their separate command workflow.");
const BaseRequest = z.object({ contextId: StudioIdSchema, consent: z.literal(true) }).strict();
const CreateRequest = BaseRequest.extend({ idempotencyKey: StudioIdSchema, runtime: StudioLocalRuntimeSchema,
  steps: z.array(AnalysisStepSchema).min(1).max(40), assumptions: z.string().max(8000).default("") }).strict();
const ContinueRequest = BaseRequest.extend({ runId: StudioIdSchema, checkpointId: StudioIdSchema, runtime: StudioLocalRuntimeSchema }).strict();
const ForkRequest = BaseRequest.extend({ parentCheckpointId: StudioIdSchema, idempotencyKey: StudioIdSchema, runtime: StudioLocalRuntimeSchema, assumptions: z.string().max(8000) }).strict();
const FeedbackPayloadSchema = OutcomeFeedbackSnapshotInputSchema.pick({ asOf: true, sources: true, events: true, notes: true });
const FeedbackSaveRequest = BaseRequest.extend({ idempotencyKey: StudioIdSchema, payload: FeedbackPayloadSchema }).strict();
const FeedbackAnalyzeRequest = BaseRequest.extend({ feedbackId: StudioIdSchema }).strict();
const RuleProposeRequest = FeedbackAnalyzeRequest.extend({ ruleSidecarId: StudioIdSchema, target: z.enum(["guideline", "skill"]),
  initialContent: z.string().max(64000).default(""), patchIds: z.array(StudioIdSchema).min(1).max(200) }).strict();
const RuleApplyRequest = BaseRequest.extend({ proposalId: StudioIdSchema, decisionId: StudioIdSchema, expectedRevision: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict();
const RuleRevertRequest = BaseRequest.extend({ ruleSidecarId: StudioIdSchema, targetDecisionId: StudioIdSchema, decisionId: StudioIdSchema,
  expectedRevision: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict();
const RuleExportRequest = BaseRequest.extend({ ruleSidecarId: StudioIdSchema, expectedRevision: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict();
export type ReplayFeedbackContext = StudioContext & { resumeVersionId?: string; resumeContentHash?: string };
/** Frozen user task data, not instructions or a grant. Only sidecars with an
 * active, explicitly reviewed apply are included; their history stays private. */
export type StudioReviewedRuntimeRules = { runtimeOnly: true; fingerprint: string;
  versions: Array<{ id: string; revision: number; hash: string; active: boolean }>;
  rules: Array<{ id: string; sidecar: Pick<PersonalRuleSidecar, "schemaVersion" | "id" | "target" | "current"> }> };
type RunMetadata = { contextId: string; contextFingerprint: string; workspaceKey: string; resumeId: string; input: Record<string, string>; steps: ReplayStep[]; runtime: StudioLocalRuntime;
  reviewedRuntimeRules?: StudioReviewedRuntimeRules };
type RunEnvelope = { schemaVersion: 1; ownerId: string; metadata: RunMetadata; headId: string; checkpoints: ReplayCheckpoint[]; lastResult?: unknown };
type FeedbackEnvelope = { schemaVersion: 1; ownerId: string; contextId: string; contextFingerprint: string; inputHash: string; versionBinding: "trusted_workspace_version" | "content_addressed_context";
  snapshot: OutcomeFeedbackSnapshot; report?: OutcomeFeedbackReport };
type RuleEnvelope = { ownerId: string; workspaceKey: string; sidecar: PersonalRuleSidecar };
type ProposalEnvelope = { ownerId: string; contextId: string; contextFingerprint: string; feedbackId: string; proposal: RuleEvolutionProposal; preview: string };

/** One SQLite artifact is the aggregate: head and immutable checkpoint history change in one atomic store.put CAS. */
export class StudioReplayCheckpointStore implements ReplayCheckpointStore {
  private pending = new Map<string, RunMetadata>();
  constructor(private readonly store: StudioArtifactStore, readonly ownerId: string,
    private readonly reviewedRulesGuard?: (metadata: RunMetadata) => Promise<number>) {
    if (ownerId !== store.ownerId) throw new StudioError("replay_store_owner_mismatch", 403);
  }
  register(runId: string, metadata: RunMetadata): void { StudioIdSchema.parse(runId); this.pending.set(runId, structuredClone(metadata)); }
  private readRun(runId: string) {
    const record = this.store.get<RunEnvelope>(KIND_RUN, runId);
    if (record && (record.value.ownerId !== this.ownerId || record.value.schemaVersion !== 1)) throw new StudioError("replay_run_owner_mismatch", 403);
    return record;
  }
  metadata(runId: string): RunMetadata {
    const run = this.readRun(runId); if (!run) throw new StudioError("replay_run_not_found", 404);
    return structuredClone(run.value.metadata);
  }
  envelope(runId: string): RunEnvelope {
    const run = this.readRun(runId); if (!run) throw new StudioError("replay_run_not_found", 404);
    return structuredClone(run.value);
  }
  async read(id: string): Promise<unknown | undefined> {
    StudioIdSchema.parse(id);
    for (const record of this.store.list<RunEnvelope>(KIND_RUN, 1000)) {
      if (record.value.ownerId !== this.ownerId) throw new StudioError("replay_run_owner_mismatch", 403);
      const checkpoint = record.value.checkpoints.find(item => item.id === id);
      if (checkpoint) return validateReplayCheckpoint(checkpoint);
    }
    return undefined;
  }
  async head(runId: string): Promise<string | null> { return this.readRun(runId)?.value.headId ?? null; }
  async append(input: ReplayCheckpoint, options: { expectedHeadId: string | null; signal?: AbortSignal }): Promise<void> {
    if (options.signal?.aborted) throw new StudioError("replay_append_cancelled");
    const checkpoint = await validateReplayCheckpoint(input);
    if (checkpoint.binding.ownerId !== this.ownerId) throw new StudioError("replay_checkpoint_owner_mismatch", 403);
    const previous = this.readRun(checkpoint.runId);
    if ((previous?.value.headId ?? null) !== options.expectedHeadId) throw new StudioError("replay_head_conflict");
    if (previous?.value.checkpoints.some(item => item.id === checkpoint.id)) throw new StudioError("replay_checkpoint_immutable");
    if (previous && (checkpoint.sequence !== previous.value.checkpoints.at(-1)!.sequence + 1 || checkpoint.parentCheckpointId !== previous.value.headId)) throw new StudioError("replay_checkpoint_lineage_conflict");
    if (!previous && checkpoint.sequence !== 0) throw new StudioError("replay_initial_checkpoint_sequence");
    if (!previous && this.store.list(KIND_RUN, 1000).length >= 1000) throw new StudioError("replay_run_capacity", 413);
    const metadata = previous?.value.metadata ?? this.pending.get(checkpoint.runId);
    if (!metadata) throw new StudioError("replay_run_metadata_missing");
    const ruleRevision = await this.reviewedRulesGuard?.(metadata);
    const value: RunEnvelope = { schemaVersion: 1, ownerId: this.ownerId, metadata, headId: checkpoint.id,
      checkpoints: [...(previous?.value.checkpoints ?? []), checkpoint] };
    if (options.signal?.aborted) throw new StudioError("replay_append_cancelled");
    this.store.put(KIND_RUN, checkpoint.runId, previous?.revision ?? 0, value,
      ruleRevision === undefined ? [] : [{ kind: KIND_RULE, revision: ruleRevision }]);
    this.pending.delete(checkpoint.runId);
  }
}
export type StudioReplayLocalRequest = { context: ReplayFeedbackContext; runtime: StudioLocalRuntime; step: ReplayStep;
  input: unknown; analysisOutputs: ReplayCheckpoint["analysisOutputs"]; reviewedRuntimeRules: StudioReviewedRuntimeRules; signal: AbortSignal };
export type ReplayFeedbackOptions = {
  store: StudioArtifactStore; ownerId: string;
  getContext: (contextId: string, access: StudioAccess) => ReplayFeedbackContext | Promise<ReplayFeedbackContext>;
  localModel?: (request: StudioReplayLocalRequest) => Promise<ReplayStepResult>;
};

/** All persistence is owner-private derived state. No Fact/Resume/outcome business command or global Skill file is written here. */
export function createReplayFeedback(options: ReplayFeedbackOptions) {
  if (options.store.ownerId !== options.ownerId) throw new StudioError("replay_feedback_owner_mismatch", 403);
  const replayStore = new StudioReplayCheckpointStore(options.store, options.ownerId, assertReviewedRules);
  async function context(contextId: string, access: StudioAccess): Promise<ReplayFeedbackContext> {
    if (!await access.valid()) throw new StudioError("studio_access_stale", 403);
    const selected = await options.getContext(contextId, access);
    if (selected.ownerId !== options.ownerId || selected.session !== access.session || selected.revoked || Date.parse(selected.expiresAt) <= Date.now()) throw new StudioError("studio_context_stale", 403);
    return structuredClone(selected);
  }
  const fingerprint = (selected: ReplayFeedbackContext) => studioHash({ workspaceKey: selected.workspaceKey, resumeId: selected.resumeId,
    sourceFingerprint: selected.sourceFingerprint, claims: selected.claims, jobs: selected.jobs });
  const binding = (selected: ReplayFeedbackContext) => ({ ownerId: options.ownerId, workspaceId: selected.workspaceKey, sessionGeneration: selected.session,
    factRevision: selected.sourceFingerprint, rulesVersion: "studio-career-intelligence-v1" });
  const inputFor = (selected: ReplayFeedbackContext, assumptions: string, rules: StudioReviewedRuntimeRules) => ({ contextFingerprint: fingerprint(selected), assumptions,
    reviewedRuntimeRulesFingerprint: rules.fingerprint });
  const resumeVersion = (selected: ReplayFeedbackContext) => ({ versionId: selected.resumeVersionId ?? `content-${studioHash([selected.resumeId, selected.sourceFingerprint]).slice(0, 48)}`,
    contentHash: selected.resumeContentHash ?? selected.sourceFingerprint,
    versionBinding: selected.resumeVersionId && selected.resumeContentHash ? "trusted_workspace_version" as const : "content_addressed_context" as const });
  async function current(selected: ReplayFeedbackContext, access: StudioAccess): Promise<boolean> {
    try { return fingerprint(await context(selected.id, access)) === fingerprint(selected); } catch { return false; }
  }
  async function requireCurrent(selected: ReplayFeedbackContext, access: StudioAccess) { if (!await current(selected, access)) throw new StudioError("studio_late_result_discarded", 409); }
  /** Follow explicit revert targets back to the reviewed state they restored.
   * Revision zero and a fully reverted sidecar are never a reviewed rule. */
  function hasActiveApply(sidecar: PersonalRuleSidecar): boolean {
    const reviewedByRevision = new Map<number, boolean>([[0, false]]);
    for (const entry of sidecar.history) {
      if (entry.operation === "apply") reviewedByRevision.set(entry.after.revision, true);
      else {
        const target = sidecar.history.find(candidate => candidate.operation === "apply" && candidate.decisionId === entry.targetDecisionId
          && candidate.after.revision <= entry.before.revision);
        if (!target || entry.after.hash !== target.before.hash) throw new StudioError("personal_rule_revert_history_invalid");
        reviewedByRevision.set(entry.after.revision, reviewedByRevision.get(target.before.revision) ?? false);
      }
    }
    return reviewedByRevision.get(sidecar.current.revision) === true;
  }
  async function readReviewedRules(workspaceKey: string) {
    const revision = options.store.kindRevision(KIND_RULE), records = options.store.list<RuleEnvelope>(KIND_RULE, 1000);
    if (records.length === 1000) throw new StudioError("replay_reviewed_rules_capacity", 413);
    const rules: StudioReviewedRuntimeRules["rules"] = [], versions: StudioReviewedRuntimeRules["versions"] = [];
    for (const record of records) {
      if (record.value.ownerId !== options.ownerId || record.value.workspaceKey !== workspaceKey) continue;
      const sidecar = await validatePersonalRuleSidecar(record.value.sidecar);
      if (sidecar.id !== record.id || sidecar.binding.ownerId !== options.ownerId || sidecar.binding.workspaceId !== workspaceKey) throw new StudioError("personal_rule_owner_mismatch", 403);
      const active = hasActiveApply(sidecar);
      if (sidecar.history.length) versions.push({ id: record.id, revision: sidecar.current.revision, hash: sidecar.current.hash, active });
      if (active) rules.push({ id: record.id, sidecar: { schemaVersion: sidecar.schemaVersion, id: sidecar.id, target: sidecar.target, current: sidecar.current } });
    }
    rules.sort((left, right) => left.id.localeCompare(right.id));
    versions.sort((left, right) => left.id.localeCompare(right.id));
    if (revision !== options.store.kindRevision(KIND_RULE)) throw new StudioError("replay_reviewed_rules_changed");
    const snapshot: StudioReviewedRuntimeRules = { runtimeOnly: true, versions, rules, fingerprint: studioHash({ runtimeOnly: true, versions, rules }) };
    return { snapshot, revision };
  }
  async function captureReviewedRules(selected: ReplayFeedbackContext, access: StudioAccess) {
    const { snapshot } = await readReviewedRules(selected.workspaceKey);
    await requireCurrent(selected, access); return snapshot;
  }
  async function assertReviewedRules(metadata: RunMetadata): Promise<number> {
    const frozen = metadata.reviewedRuntimeRules;
    if (!frozen || frozen.fingerprint !== studioHash({ runtimeOnly: true, versions: frozen.versions, rules: frozen.rules })
      || metadata.input["reviewedRuntimeRulesFingerprint"] !== frozen.fingerprint) throw new StudioError("replay_reviewed_rules_snapshot_missing_or_changed");
    const current = await readReviewedRules(metadata.workspaceKey);
    if (current.snapshot.fingerprint !== frozen.fingerprint) throw new StudioError("replay_reviewed_rules_changed");
    return current.revision;
  }
  const authority = async (selected: ReplayFeedbackContext, input: RunMetadata["input"]): Promise<ReplayAuthority> => ({ id: `replay-authority-${randomUUID()}`, binding: binding(selected),
    purpose: "checkpoint_replay", expiresAt: selected.expiresAt, inputFingerprint: await intelligenceHash(input), graphVersion: "studio-typed-analysis-v1",
    analysisStepIds: [], approvedNewEffectKeys: [], effectApprovals: [] });
  async function execute(runId: string, checkpointId: string, selected: ReplayFeedbackContext, access: StudioAccess, runtime: StudioLocalRuntime) {
    if (!options.localModel) throw new StudioError("studio_replay_local_model_unavailable", 503);
    const metadata = replayStore.metadata(runId);
    if (metadata.contextFingerprint !== fingerprint(selected) || metadata.workspaceKey !== selected.workspaceKey || metadata.resumeId !== selected.resumeId) throw new StudioError("replay_context_changed");
    if (studioHash(metadata.runtime) !== studioHash(runtime)) throw new StudioError("replay_runtime_changed_requires_fork");
    await assertReviewedRules(metadata);
    const reviewedRuntimeRules = structuredClone(metadata.reviewedRuntimeRules!);
    const grant = await authority(selected, metadata.input); grant.analysisStepIds = metadata.steps.map(step => step.id);
    return runReplaySteps(checkpointId, metadata.input, metadata.steps, grant, { store: replayStore,
      isCurrent: async () => { if (!await current(selected, access)) return false; try { await assertReviewedRules(metadata); return await current(selected, access); } catch { return false; } },
      budget: { maxSteps: 40, maxDurationMs: 120000 }, runner: async (step, execution) => {
        if (step.kind !== "analysis") throw new StudioError("studio_replay_effect_not_allowed", 403);
        const result = ReplayStepResultSchema.parse(await options.localModel!({ context: structuredClone(selected), runtime,
          step, input: execution.input, analysisOutputs: execution.analysisOutputs, reviewedRuntimeRules: structuredClone(reviewedRuntimeRules), signal: execution.signal }));
        if (result.kind !== "analysis") throw new StudioError("studio_replay_effect_result_not_allowed", 403);
        return result;
      } });
  }
  function feedbackRecord(id: string, selected: ReplayFeedbackContext) {
    const record = options.store.get<FeedbackEnvelope>(KIND_FEEDBACK, id);
    if (!record) throw new StudioError("feedback_not_found", 404);
    if (record.value.ownerId !== options.ownerId || record.value.contextFingerprint !== fingerprint(selected)) throw new StudioError("feedback_context_mismatch", 403);
    return record;
  }
  function ruleRecord(id: string, selected: ReplayFeedbackContext) {
    const record = options.store.get<RuleEnvelope>(KIND_RULE, id);
    if (!record) throw new StudioError("personal_rule_not_found", 404);
    if (record.value.ownerId !== options.ownerId || record.value.workspaceKey !== selected.workspaceKey) throw new StudioError("personal_rule_owner_mismatch", 403);
    return record;
  }
  async function ruleConfirmation(selected: ReplayFeedbackContext, sidecar: PersonalRuleSidecar, expectedRevision: number, decisionId: string, operation: "apply" | "revert", payload: unknown) {
    return { decisionId, expectedRevision, confirmed: true as const, authority: { id: `rule-authority-${randomUUID()}`, binding: binding(selected), purpose: "personal_rule_update" as const,
      targetSidecarId: sidecar.id, inputHash: await intelligenceHash(operation === "apply" ? { operation, proposal: payload } : { operation, targetDecisionId: payload }), expectedRevision, expiresAt: selected.expiresAt } };
  }
  return {
    replayStore,
    async replayCreate(body: unknown, access: StudioAccess) {
      const request = CreateRequest.parse(body), selected = await context(request.contextId, access);
      if (!options.localModel) throw new StudioError("studio_replay_local_model_unavailable", 503);
      const reviewedRuntimeRules = await captureReviewedRules(selected, access);
      const runId = `replay-${studioHash([selected.workspaceKey, request.idempotencyKey]).slice(0, 32)}`, input = inputFor(selected, request.assumptions, reviewedRuntimeRules);
      const metadata: RunMetadata = { contextId: selected.id, contextFingerprint: fingerprint(selected), workspaceKey: selected.workspaceKey, resumeId: selected.resumeId, input, steps: request.steps, runtime: request.runtime, reviewedRuntimeRules };
      const existing = options.store.get<RunEnvelope>(KIND_RUN, runId);
      if (existing) {
        if (studioHash(existing.value.metadata) !== studioHash(metadata)) throw new StudioError("replay_idempotency_conflict");
        return { runId, checkpoint: await replayStore.read(existing.value.headId), repeated: true, requiresExplicitContinue: true };
      }
      replayStore.register(runId, metadata);
      await requireCurrent(selected, access);
      const initial = await createReplayRun({ runId, binding: binding(selected), graphVersion: "studio-typed-analysis-v1", input }, replayStore);
      return { runId, result: await execute(runId, initial.id, selected, access, request.runtime) };
    },
    async replayContinue(body: unknown, access: StudioAccess) {
      const request = ContinueRequest.parse(body), selected = await context(request.contextId, access), checkpoint = await validateReplayCheckpoint(await replayStore.read(request.checkpointId));
      if (checkpoint.runId !== request.runId) throw new StudioError("replay_checkpoint_run_mismatch");
      return { runId: request.runId, result: await execute(request.runId, request.checkpointId, selected, access, request.runtime) };
    },
    async replayFork(body: unknown, access: StudioAccess) {
      const request = ForkRequest.parse(body), selected = await context(request.contextId, access), parent = await validateReplayCheckpoint(await replayStore.read(request.parentCheckpointId));
      const original = replayStore.metadata(parent.runId);
      if (original.workspaceKey !== selected.workspaceKey || original.resumeId !== selected.resumeId || original.contextFingerprint !== fingerprint(selected)) throw new StudioError("replay_fork_context_mismatch");
      const reviewedRuntimeRules = await captureReviewedRules(selected, access);
      const input = inputFor(selected, request.assumptions, reviewedRuntimeRules), runId = `fork-${studioHash([request.parentCheckpointId, request.idempotencyKey]).slice(0, 32)}`;
      const metadata: RunMetadata = { ...original, contextId: selected.id, runtime: request.runtime, input, reviewedRuntimeRules };
      const existing = options.store.get<RunEnvelope>(KIND_RUN, runId);
      if (existing) { if (studioHash(existing.value.metadata) !== studioHash(metadata)) throw new StudioError("replay_idempotency_conflict"); return { runId, checkpoint: await replayStore.read(existing.value.headId), repeated: true, requiresExplicitContinue: true }; }
      replayStore.register(runId, metadata);
      const grant = await authority(selected, input); grant.analysisStepIds = original.steps.map(step => step.id);
      const fork = await forkReplayCheckpoint(parent.id, { newRunId: runId, binding: binding(selected), input,
        assumptionPatch: { assumptions: request.assumptions }, freshAuthority: grant }, replayStore, () => current(selected, access));
      return { runId, result: await execute(runId, fork.id, selected, access, request.runtime) };
    },
    async replayGet(runId: string, contextId: string, access: StudioAccess) {
      const selected = await context(contextId, access), envelope = replayStore.envelope(StudioIdSchema.parse(runId));
      if (envelope.metadata.workspaceKey !== selected.workspaceKey || envelope.metadata.contextFingerprint !== fingerprint(selected)) throw new StudioError("replay_context_changed", 403);
      await requireCurrent(selected, access); return envelope;
    },
    async feedbackSave(body: unknown, access: StudioAccess) {
      const request = FeedbackSaveRequest.parse(body), selected = await context(request.contextId, access);
      const { versionId, contentHash, versionBinding } = resumeVersion(selected);
      if ([...request.payload.events, ...request.payload.notes].some(item => item.resumeVersionId !== versionId || item.resumeContentHash !== contentHash)) throw new StudioError("feedback_selected_resume_version_mismatch");
      const snapshot = await createOutcomeFeedbackSnapshot({ ...request.payload, binding: binding(selected), authorization: { grantId: `feedback-grant-${randomUUID()}`,
        expiresAt: selected.expiresAt, sourceIds: request.payload.sources.map(source => source.id), purpose: "outcome_feedback" },
        resumes: [{ resumeId: selected.resumeId, versionId, contentHash, claims: selected.claims.map(claim => ({ id: claim.id, text: claim.text })) }],
        events: request.payload.events.map(event => ({ ...event, resumeVersionId: versionId, resumeContentHash: contentHash,
          // HTTP input never self-certifies a platform receipt. A separate trusted source adapter may add verification later.
          receiptVerification: "unverified" as const })),
        notes: request.payload.notes.map(note => ({ ...note, resumeVersionId: versionId, resumeContentHash: contentHash })) });
      const id = `feedback-${studioHash([selected.workspaceKey, request.idempotencyKey]).slice(0, 32)}`, inputHash = studioHash(request.payload), existing = options.store.get<FeedbackEnvelope>(KIND_FEEDBACK, id);
      if (existing) { if (existing.value.ownerId !== options.ownerId || existing.value.inputHash !== inputHash || existing.value.contextFingerprint !== fingerprint(selected)) throw new StudioError("feedback_idempotency_conflict"); await requireCurrent(selected, access); return { id, revision: existing.revision, snapshot: existing.value.snapshot, repeated: true }; }
      await requireCurrent(selected, access);
      const value: FeedbackEnvelope = { schemaVersion: 1, ownerId: options.ownerId, contextId: selected.id, contextFingerprint: fingerprint(selected), inputHash,
        versionBinding, snapshot };
      const record = options.store.put(KIND_FEEDBACK, id, 0, value); return { id, revision: record.revision, snapshot, versionBinding: value.versionBinding };
    },
    async feedbackIdentity(contextId: string, access: StudioAccess) {
      const selected = await context(contextId, access), version = resumeVersion(selected);
      const claims = await Promise.all(selected.claims.map(async claim => ({ id: claim.id, text: claim.text, hash: await hashCommitteeText(claim.text) })));
      await requireCurrent(selected, access); return { workspaceKey: selected.workspaceKey, resumeId: selected.resumeId, ...version, claims };
    },
    async feedbackAnalyze(body: unknown, access: StudioAccess) {
      const request = FeedbackAnalyzeRequest.parse(body), selected = await context(request.contextId, access), record = feedbackRecord(request.feedbackId, selected);
      const snapshot = await validateOutcomeFeedbackSnapshot(record.value.snapshot);
      const report = await analyzeOutcomeFeedback(snapshot, { isCurrent: () => current(selected, access) });
      if (report.status !== "completed") return { id: request.feedbackId, revision: record.revision, report };
      await requireCurrent(selected, access);
      const saved = options.store.put(KIND_FEEDBACK, record.id, record.revision, { ...record.value, report });
      return { id: saved.id, revision: saved.revision, report, versionBinding: record.value.versionBinding };
    },
    async rulePropose(body: unknown, access: StudioAccess) {
      const request = RuleProposeRequest.parse(body), selected = await context(request.contextId, access), feedback = feedbackRecord(request.feedbackId, selected);
      if (!feedback.value.report) throw new StudioError("feedback_analysis_required");
      const rule = options.store.get<RuleEnvelope>(KIND_RULE, request.ruleSidecarId);
      if (!rule) {
        const sidecar = await createPersonalRuleSidecar({ id: request.ruleSidecarId, binding: binding(selected), target: request.target, content: request.initialContent });
        await requireCurrent(selected, access); options.store.put(KIND_RULE, request.ruleSidecarId, 0, { ownerId: options.ownerId, workspaceKey: selected.workspaceKey, sidecar });
      }
      const checked = ruleRecord(request.ruleSidecarId, selected);
      if (checked.value.sidecar.target !== request.target) throw new StudioError("personal_rule_target_mismatch");
      const proposal = await proposeRuleEvolution(feedback.value.report, checked.value.sidecar, request.patchIds), preview = [checked.value.sidecar.current.content, ...proposal.ruleCodes.map(code => PERSONAL_RULE_TEXT[code])].filter(Boolean).join("\n");
      await requireCurrent(selected, access);
      const existing = options.store.get<ProposalEnvelope>(KIND_PROPOSAL, proposal.id);
      if (!existing) options.store.put(KIND_PROPOSAL, proposal.id, 0, { ownerId: options.ownerId, contextId: selected.id, contextFingerprint: fingerprint(selected), feedbackId: feedback.id, proposal, preview });
      return { proposal, preview, sidecar: checked.value.sidecar, requiresExplicitConfirmation: true };
    },
    async ruleApply(body: unknown, access: StudioAccess) {
      const request = RuleApplyRequest.parse(body), selected = await context(request.contextId, access), record = options.store.get<ProposalEnvelope>(KIND_PROPOSAL, request.proposalId);
      if (!record || record.value.ownerId !== options.ownerId || record.value.contextFingerprint !== fingerprint(selected)) throw new StudioError("rule_proposal_not_found", 404);
      feedbackRecord(record.value.feedbackId, selected);
      const rule = ruleRecord(record.value.proposal.targetSidecarId, selected), approval = await ruleConfirmation(selected, rule.value.sidecar, request.expectedRevision, request.decisionId, "apply", record.value.proposal);
      const sidecar = await applyRuleEvolution(rule.value.sidecar, record.value.proposal, approval, { isCurrent: () => current(selected, access) });
      await requireCurrent(selected, access);
      if (studioHash(sidecar) === studioHash(rule.value.sidecar)) return { sidecar, revision: rule.revision, repeated: true, runtimeOnly: true };
      const saved = options.store.put(KIND_RULE, rule.id, rule.revision, { ...rule.value, sidecar }); return { sidecar, revision: saved.revision, runtimeOnly: true };
    },
    async ruleRevert(body: unknown, access: StudioAccess) {
      const request = RuleRevertRequest.parse(body), selected = await context(request.contextId, access), rule = ruleRecord(request.ruleSidecarId, selected);
      const approval = await ruleConfirmation(selected, rule.value.sidecar, request.expectedRevision, request.decisionId, "revert", request.targetDecisionId);
      const sidecar = await revertRuleEvolution(rule.value.sidecar, request.targetDecisionId, approval, { isCurrent: () => current(selected, access) });
      await requireCurrent(selected, access);
      if (studioHash(sidecar) === studioHash(rule.value.sidecar)) return { sidecar, revision: rule.revision, repeated: true, runtimeOnly: true };
      const saved = options.store.put(KIND_RULE, rule.id, rule.revision, { ...rule.value, sidecar }); return { sidecar, revision: saved.revision, runtimeOnly: true };
    },
    async runtimeRules(contextId: string, access: StudioAccess) {
      const selected = await context(contextId, access);
      const rules = await Promise.all(options.store.list<RuleEnvelope>(KIND_RULE, 1000).filter(record => record.value.ownerId === options.ownerId && record.value.workspaceKey === selected.workspaceKey)
        .map(async record => ({ id: record.id, sidecar: await validatePersonalRuleSidecar(record.value.sidecar) })));
      await requireCurrent(selected, access); return { runtimeOnly: true, rules };
    },
    async ruleExport(body: unknown, access: StudioAccess) {
      const request = RuleExportRequest.parse(body), selected = await context(request.contextId, access), record = ruleRecord(request.ruleSidecarId, selected), sidecar = await validatePersonalRuleSidecar(record.value.sidecar);
      if (sidecar.current.revision !== request.expectedRevision) throw new StudioError("rule_export_revision_conflict");
      await requireCurrent(selected, access);
      return { filename: sidecar.target === "skill" ? "betterme-career-SKILL.patch.md" : "betterme-resume-guidelines.patch.md", content: sidecar.current.content,
        sha256: await hashCommitteeText(sidecar.current.content), revision: sidecar.current.revision, exported: true, installed: false, runtimeOnly: true,
        limitation: "This is an explicitly reviewed export; no global Skill, .agent-memory or user file was installed or overwritten." };
    },
  };
}
