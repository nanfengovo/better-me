import { z } from "zod";
import {
  IntelligenceBindingSchema, IntelligenceHashSchema, IntelligenceIdSchema, IntelligenceInputError,
  assertUniqueIds, intelligenceHash,
} from "./snapshots.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonValueSchema), z.record(JsonValueSchema)]));
export const ReplayStepSchema = z.discriminatedUnion("kind", [
  z.object({ id: IntelligenceIdSchema, kind: z.literal("analysis"), operation: IntelligenceIdSchema, input: JsonValueSchema }).strict(),
  z.object({ id: IntelligenceIdSchema, kind: z.literal("effect"), operation: IntelligenceIdSchema, input: JsonValueSchema, effectKey: IntelligenceIdSchema }).strict(),
]);
export type ReplayStep = z.infer<typeof ReplayStepSchema>;
export const ReplayStepResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("analysis"), summary: z.string().min(1).max(4000),
    artifact: z.object({ type: z.enum(["report", "proposal", "evidence_summary"]), data: JsonValueSchema }).strict(),
  }).strict(),
  z.object({ kind: z.literal("effect"), outcome: z.enum(["succeeded", "failed", "unknown"]), receiptId: IntelligenceIdSchema.optional() }).strict(),
]).superRefine((result, context) => {
  if (result.kind === "effect" && result.outcome === "succeeded" && !result.receiptId) context.addIssue({ code: "custom", message: "A successful business effect needs a Host-validated receipt reference." });
});
export type ReplayStepResult = z.infer<typeof ReplayStepResultSchema>;
const AnalysisOutputSchema = z.object({ stepId: IntelligenceIdSchema, stepHash: IntelligenceHashSchema, inputFingerprint: IntelligenceHashSchema,
  originRunId: IntelligenceIdSchema, inherited: z.boolean(), summary: z.string().min(1).max(4000),
  artifact: z.object({ type: z.enum(["report", "proposal", "evidence_summary"]), data: JsonValueSchema }).strict(), hash: IntelligenceHashSchema,
}).strict();
const EffectObservationSchema = z.object({ stepId: IntelligenceIdSchema, stepHash: IntelligenceHashSchema, effectKey: IntelligenceIdSchema,
  originRunId: IntelligenceIdSchema, inherited: z.boolean(), outcome: z.enum(["succeeded", "failed", "unknown"]), receiptId: IntelligenceIdSchema.optional(),
}).strict();
const ActionObservationSchema = z.object({ stepId: IntelligenceIdSchema, stepHash: IntelligenceHashSchema, kind: z.enum(["analysis", "effect"]),
  phase: z.enum(["started", "completed", "failed", "blocked"]), at: z.string().datetime(), inherited: z.boolean(),
  code: IntelligenceIdSchema,
}).strict();
export const ReplayCheckpointSchema = z.object({
  schemaVersion: z.literal(1), id: IntelligenceIdSchema, runId: IntelligenceIdSchema, sequence: z.number().int().nonnegative(),
  parentCheckpointId: IntelligenceIdSchema.nullable(), forkedFromCheckpointId: IntelligenceIdSchema.nullable(),
  binding: IntelligenceBindingSchema, graphVersion: IntelligenceIdSchema, inputFingerprint: IntelligenceHashSchema,
  assumptionPatch: JsonValueSchema.nullable(), lastAuthorityId: IntelligenceIdSchema.nullable(), forbiddenAuthorityIds: z.array(IntelligenceIdSchema).max(2000),
  analysisOutputs: z.array(AnalysisOutputSchema).max(2000), effectHistory: z.array(EffectObservationSchema).max(2000),
  observations: z.array(ActionObservationSchema).max(4000), hash: IntelligenceHashSchema,
}).strict();
export type ReplayCheckpoint = z.infer<typeof ReplayCheckpointSchema>;
export const ReplayAuthoritySchema = z.object({
  id: IntelligenceIdSchema, binding: IntelligenceBindingSchema, purpose: z.literal("checkpoint_replay"), expiresAt: z.string().datetime(),
  inputFingerprint: IntelligenceHashSchema, graphVersion: IntelligenceIdSchema,
  analysisStepIds: z.array(IntelligenceIdSchema).max(2000), approvedNewEffectKeys: z.array(IntelligenceIdSchema).max(2000),
  effectApprovals: z.array(z.object({ effectKey: IntelligenceIdSchema, stepHash: IntelligenceHashSchema }).strict()).max(2000).default([]),
}).strict();
export type ReplayAuthority = z.infer<typeof ReplayAuthoritySchema>;
/** Store implementations must atomically append only, check expected head and reject any reused ID. */
export interface ReplayCheckpointStore {
  read(id: string): Promise<unknown | undefined>;
  head(runId: string): Promise<string | null>;
  append(checkpoint: ReplayCheckpoint, options: { expectedHeadId: string | null; signal?: AbortSignal }): Promise<void>;
}
export type ReplayStepRunner = (step: ReplayStep, context: {
  input: JsonValue; analysisOutputs: ReplayCheckpoint["analysisOutputs"]; authority: ReplayAuthority; signal: AbortSignal;
}) => Promise<ReplayStepResult>;
export type ReplayResult = { status: "completed" | "cancelled" | "stale" | "budget_exhausted" | "storage_conflict" | "partial" | "failed";
  checkpoint: ReplayCheckpoint; executedSteps: string[]; skippedAnalysisSteps: string[]; blockedEffectKeys: string[];
  reason?: string; limitations: string[] };

export async function validateReplayCheckpoint(input: unknown): Promise<ReplayCheckpoint> {
  const checkpoint = ReplayCheckpointSchema.parse(input);
  if (JSON.stringify(checkpoint).length > 4_000_000) throw new IntelligenceInputError("checkpoint_size_exceeded");
  const { hash, ...unsigned } = checkpoint;
  if (hash !== await intelligenceHash(unsigned)) throw new IntelligenceInputError("checkpoint_hash_changed");
  assertUniqueIds(checkpoint.analysisOutputs.map(output => output.stepId), "duplicate_completed_analysis_step");
  assertUniqueIds(checkpoint.effectHistory.map(output => output.effectKey), "duplicate_effect_key");
  assertUniqueIds(checkpoint.forbiddenAuthorityIds, "duplicate_authority_id");
  for (const output of checkpoint.analysisOutputs) {
    const { hash: outputHash, inherited: _inherited, ...payload } = output;
    if (outputHash !== await intelligenceHash(payload)) throw new IntelligenceInputError("analysis_output_hash_changed");
  }
  return checkpoint;
}
async function signedCheckpoint(input: Omit<ReplayCheckpoint, "hash">): Promise<ReplayCheckpoint> {
  const { hash: _previousHash, ...unsigned } = input as ReplayCheckpoint;
  return validateReplayCheckpoint({ ...unsigned, hash: await intelligenceHash(unsigned) });
}
const checkpointId = async (runId: string, sequence: number) => `checkpoint-${(await intelligenceHash([runId, sequence])).slice(0, 48)}`;
function parseInput(input: unknown): JsonValue {
  try { if (JSON.stringify(input).length > 2_000_000) throw new Error("too_large"); }
  catch { throw new IntelligenceInputError("replay_input_not_bounded_json"); }
  return JsonValueSchema.parse(input);
}
async function appendVerified(store: ReplayCheckpointStore, checkpoint: ReplayCheckpoint, expectedHeadId: string | null, signal?: AbortSignal): Promise<void> {
  await store.append(checkpoint, { expectedHeadId, signal });
  const saved = await validateReplayCheckpoint(await store.read(checkpoint.id));
  if (saved.id !== checkpoint.id || saved.hash !== checkpoint.hash) throw new IntelligenceInputError("checkpoint_store_integrity_failure");
}
export async function createReplayRun(input: {
  runId: string; binding: z.infer<typeof IntelligenceBindingSchema>; graphVersion: string; input: JsonValue;
}, store: ReplayCheckpointStore): Promise<ReplayCheckpoint> {
  const checkpoint = await signedCheckpoint({ schemaVersion: 1, id: await checkpointId(input.runId, 0), runId: input.runId, sequence: 0,
    parentCheckpointId: null, forkedFromCheckpointId: null, binding: input.binding, graphVersion: input.graphVersion,
    inputFingerprint: await intelligenceHash(parseInput(input.input)), assumptionPatch: null, lastAuthorityId: null, forbiddenAuthorityIds: [],
    analysisOutputs: [], effectHistory: [], observations: [] });
  await appendVerified(store, checkpoint, null);
  return checkpoint;
}
function sameOwner(left: ReplayCheckpoint["binding"], right: ReplayCheckpoint["binding"]): boolean {
  return left.ownerId === right.ownerId && left.workspaceId === right.workspaceId;
}
/** Parent is exactly the selected Nth checkpoint. Later history is neither copied nor rewritten. */
export async function forkReplayCheckpoint(parentId: string, input: {
  newRunId: string; binding: ReplayCheckpoint["binding"]; input: JsonValue; assumptionPatch: JsonValue; freshAuthority: ReplayAuthority;
}, store: ReplayCheckpointStore, isCurrent: (binding: ReplayCheckpoint["binding"], authority: ReplayAuthority) => boolean | Promise<boolean>): Promise<ReplayCheckpoint> {
  const parent = await validateReplayCheckpoint(await store.read(parentId)), authority = ReplayAuthoritySchema.parse(input.freshAuthority);
  const forbidden = [...new Set([...parent.forbiddenAuthorityIds, ...(parent.lastAuthorityId ? [parent.lastAuthorityId] : [])])];
  if (!sameOwner(parent.binding, input.binding) || !sameOwner(input.binding, authority.binding)) throw new IntelligenceInputError("fork_owner_mismatch");
  if (forbidden.includes(authority.id) || authority.binding.sessionGeneration !== input.binding.sessionGeneration
    || authority.inputFingerprint !== await intelligenceHash(parseInput(input.input)) || authority.graphVersion !== parent.graphVersion
    || Date.parse(authority.expiresAt) <= Date.now() || !await isCurrent(input.binding, authority)) throw new IntelligenceInputError("fresh_fork_authority_required");
  if (input.newRunId === parent.runId) throw new IntelligenceInputError("fork_requires_new_run_id");
  const checkpoint = await signedCheckpoint({ ...parent, id: await checkpointId(input.newRunId, 0), runId: input.newRunId, sequence: 0,
    parentCheckpointId: parent.id, forkedFromCheckpointId: parent.id, binding: input.binding,
    inputFingerprint: await intelligenceHash(parseInput(input.input)), assumptionPatch: parseInput(input.assumptionPatch), lastAuthorityId: null, forbiddenAuthorityIds: forbidden,
    analysisOutputs: parent.analysisOutputs.map(output => ({ ...output, inherited: true })),
    // Historical successes/unknowns are display-only references, never execution records for the new run.
    effectHistory: parent.effectHistory.map(effect => ({ ...effect, inherited: true })), observations: parent.observations.map(observation => ({ ...observation, inherited: true })),
  });
  if (Date.parse(authority.expiresAt) <= Date.now() || !await isCurrent(input.binding, authority)) throw new IntelligenceInputError("fresh_fork_authority_required");
  await appendVerified(store, checkpoint, null);
  return checkpoint;
}

/** A bounded typed runner stores public actions/results, not model-private chain of thought. */
export async function runReplaySteps(checkpointId: string, inputValue: JsonValue, stepInputs: readonly unknown[], authorityInput: unknown, options: {
  store: ReplayCheckpointStore; runner: ReplayStepRunner;
  isCurrent: (checkpoint: ReplayCheckpoint, authority: ReplayAuthority) => boolean | Promise<boolean>;
  signal?: AbortSignal; budget?: { maxSteps?: number; maxDurationMs?: number; maxOutputCharacters?: number }; now?: () => number;
}): Promise<ReplayResult> {
  let checkpoint = await validateReplayCheckpoint(await options.store.read(checkpointId));
  const input = parseInput(inputValue);
  const authority = ReplayAuthoritySchema.parse(authorityInput), steps = stepInputs.map(step => ReplayStepSchema.parse(step));
  assertUniqueIds(steps.map(step => step.id), "duplicate_step_id");
  assertUniqueIds(steps.filter((step): step is Extract<ReplayStep, { kind: "effect" }> => step.kind === "effect").map(step => step.effectKey), "duplicate_effect_key");
  if (await intelligenceHash(input) !== checkpoint.inputFingerprint) throw new IntelligenceInputError("replay_input_fingerprint_changed");
  const budget = z.object({ maxSteps: z.number().int().min(1).max(1000).default(50), maxDurationMs: z.number().int().min(1).max(3_600_000).default(60_000),
    maxOutputCharacters: z.number().int().min(1).max(4_000_000).default(200_000) }).strict().parse(options.budget ?? {});
  const now = options.now ?? Date.now, startedAt = now(), controller = new AbortController();
  let timedOut = false;
  const abortExternal = () => controller.abort();
  options.signal?.addEventListener("abort", abortExternal, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget.maxDurationMs);
  const executedSteps: string[] = [], skippedAnalysisSteps: string[] = [], blockedEffectKeys: string[] = [];
  let outputCharacters = 0, status: ReplayResult["status"] = "completed", reason: string | undefined;
  class Stop extends Error { constructor(readonly status: ReplayResult["status"], message: string) { super(message); } }
  const interrupted = () => new Stop(timedOut ? "budget_exhausted" : "cancelled", timedOut ? "duration_budget_exhausted" : "cancelled");
  async function active<T>(work: () => T | Promise<T>): Promise<T> {
    let onAbort: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_resolve, reject) => { onAbort = () => reject(interrupted()); controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
      return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw interrupted(); return work(); }), abort]);
    } finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  }
  async function current() {
    if (controller.signal.aborted) throw interrupted();
    if (now() - startedAt >= budget.maxDurationMs) throw new Stop("budget_exhausted", "duration_budget_exhausted");
    if (!sameOwner(checkpoint.binding, authority.binding) || JSON.stringify(checkpoint.binding) !== JSON.stringify(authority.binding)
      || authority.inputFingerprint !== checkpoint.inputFingerprint || authority.graphVersion !== checkpoint.graphVersion
      || Date.parse(authority.expiresAt) <= now() || !await active(() => options.isCurrent(checkpoint, authority))) throw new Stop("stale", "authority_or_input_changed");
  }
  async function save(patch: Partial<ReplayCheckpoint>) {
    const previous = checkpoint;
    const next = await signedCheckpoint({ ...checkpoint, ...patch, id: `checkpoint-${(await intelligenceHash([checkpoint.runId, checkpoint.sequence + 1])).slice(0, 48)}`, sequence: checkpoint.sequence + 1,
      parentCheckpointId: checkpoint.id, lastAuthorityId: authority.id,
      forbiddenAuthorityIds: [...new Set([...checkpoint.forbiddenAuthorityIds, ...(checkpoint.lastAuthorityId && checkpoint.lastAuthorityId !== authority.id ? [checkpoint.lastAuthorityId] : [])])] });
    try { await active(() => appendVerified(options.store, next, previous.id, controller.signal)); }
    catch (error) { if (error instanceof Stop) throw error; throw new Stop("storage_conflict", "checkpoint_append_failed_or_conflicted"); }
    checkpoint = next;
  }
  try {
    await current();
    if (checkpoint.lastAuthorityId === authority.id || checkpoint.forbiddenAuthorityIds.includes(authority.id)) throw new Stop("stale", "fresh_resume_authority_required");
    if (await active(() => options.store.head(checkpoint.runId)) !== checkpoint.id) throw new Stop("storage_conflict", "checkpoint_is_not_current_head");
    for (const step of steps) {
      await current();
      const stepHash = await intelligenceHash(step);
      const completed = checkpoint.analysisOutputs.find(output => output.stepId === step.id);
      if (completed) {
        if (step.kind !== "analysis" || completed.stepHash !== stepHash) throw new Stop("stale", "completed_step_definition_changed");
        skippedAnalysisSteps.push(step.id); continue;
      }
      if (executedSteps.length >= budget.maxSteps) throw new Stop("budget_exhausted", "step_budget_exhausted");
      if (step.kind === "effect") {
        if (checkpoint.effectHistory.some(effect => effect.effectKey === step.effectKey)) { blockedEffectKeys.push(step.effectKey); continue; }
        if (!authority.approvedNewEffectKeys.includes(step.effectKey) || !authority.effectApprovals.some(approval => approval.effectKey === step.effectKey && approval.stepHash === stepHash)) { blockedEffectKeys.push(step.effectKey); continue; }
      } else if (!authority.analysisStepIds.includes(step.id)) throw new Stop("stale", "analysis_step_not_authorized");
      const observation = { stepId: step.id, stepHash, kind: step.kind, phase: "started" as const, at: new Date(now()).toISOString(), inherited: false, code: "dispatch_intent_persisted" };
      await save({ observations: [...checkpoint.observations, observation], ...(step.kind === "effect" ? { effectHistory: [...checkpoint.effectHistory,
        { stepId: step.id, stepHash, effectKey: step.effectKey, originRunId: checkpoint.runId, inherited: false, outcome: "unknown" as const }] } : {}) });
      await current();
      executedSteps.push(step.id);
      let result: ReplayStepResult;
      try { result = ReplayStepResultSchema.parse(await active(() => options.runner(step, { input: structuredClone(input),
        analysisOutputs: structuredClone(checkpoint.analysisOutputs), authority: structuredClone(authority), signal: controller.signal }))); }
      catch (error) { if (error instanceof Stop) throw error; throw new Stop("partial", "step_failed_or_invalid_result"); }
      await current();
      if (result.kind !== step.kind) throw new Stop("partial", "step_result_kind_mismatch");
      outputCharacters += JSON.stringify(result).length;
      if (outputCharacters > budget.maxOutputCharacters) throw new Stop("budget_exhausted", "output_budget_exhausted");
      const finished = { ...observation, phase: "completed" as const, at: new Date(now()).toISOString(), code: result.kind === "effect" ? `effect_${result.outcome}` : "analysis_completed" };
      if (result.kind === "analysis") {
        const payload = { stepId: step.id, stepHash, inputFingerprint: checkpoint.inputFingerprint, originRunId: checkpoint.runId, summary: result.summary, artifact: result.artifact };
        await save({ analysisOutputs: [...checkpoint.analysisOutputs, { ...payload, inherited: false, hash: await intelligenceHash(payload) }], observations: [...checkpoint.observations, finished] });
      } else if (step.kind === "effect") {
        await save({ effectHistory: checkpoint.effectHistory.map(effect => effect.effectKey === step.effectKey ? { ...effect, outcome: result.outcome, ...(result.receiptId ? { receiptId: result.receiptId } : {}) } : effect), observations: [...checkpoint.observations, finished] });
        if (result.outcome !== "succeeded") throw new Stop("partial", `effect_${result.outcome}_no_automatic_retry`);
      }
    }
    await current();
    if (blockedEffectKeys.length) { status = "partial"; reason = "historical_or_unapproved_effects_not_dispatched"; }
  } catch (error) { if (error instanceof Stop) { status = error.status; reason = error.message; } else { status = "failed"; reason = "replay_failed"; } }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abortExternal); controller.abort(); }
  return { status, checkpoint, executedSteps, skippedAnalysisSteps, blockedEffectKeys, ...(reason ? { reason } : {}), limitations: [
    "Checkpoints store typed public actions, artifacts and observations, not model-private chain of thought.",
    "A fork inherits analysis history, never an execution grant. Historical effect references are display-only and cannot be dispatched again.",
    "A crash, lost receipt, cancellation or post-dispatch storage failure leaves an effect unknown; it is never automatically retried.",
    "The Host must implement an immutable atomic CAS store, fresh identity/grant validation and separately confirmed business effects.",
    "Inherited outputs retain their original input fingerprint; an assumption change does not silently re-certify them for the new input.",
  ] };
}
