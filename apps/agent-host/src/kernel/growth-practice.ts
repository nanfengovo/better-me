import { isDeepStrictEqual } from "node:util";
import {
  GROWTH_PRACTICE_SOURCE_ID,
  GrowthPracticeDecisionSchema,
  GrowthPracticeTaskSchema,
  type GrowthPracticeCheckpoint,
  type GrowthPracticeDecision,
  type GrowthPracticeDecisionInput,
  type GrowthPracticeTask,
  type GrowthPracticeVerification,
} from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { digest } from "../tasks/evidence.js";

export const GROWTH_PRACTICE_VERIFIER = "growth-practice-quickjs-v1";

export async function runGrowthPracticeDecision(source: string, input: GrowthPracticeDecisionInput, signal?: AbortSignal): Promise<GrowthPracticeDecision> {
  return GrowthPracticeDecisionSchema.parse(await executeTransform(source, input, signal));
}

export function growthPracticeInput(task: GrowthPracticeTask, checkpoint: GrowthPracticeCheckpoint | null, sourceId: string = task.request.sourceId): GrowthPracticeDecisionInput {
  return { sourceId, answer: task.request.answer, explanation: task.request.explanation,
    checkpoint: checkpoint ? { noteId: checkpoint.noteId, result: checkpoint.result, resultHash: checkpoint.resultHash } : null };
}

export function lookupGrowthPracticeSource(task: GrowthPracticeTask, noteId: string) {
  if (noteId !== GROWTH_PRACTICE_SOURCE_ID || noteId !== task.request.sourceId) throw new Error("growth_practice_source_not_allowed");
  if (digest(task.request.sourceText) !== task.request.sourceHash) throw new Error("growth_practice_source_changed");
  return task.request.sourceText;
}

type Execute = (input: GrowthPracticeDecisionInput, label: string) => Promise<GrowthPracticeDecision>;
const controlCodes = new Set(["tool_call_budget", "model_call_budget", "active_time_budget", "interaction_lease_invalid", "root_task_revoked"]);
function rethrowControlFailure(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && controlCodes.has(error.code)) throw error;
}
export async function verifyGrowthPractice(taskValue: GrowthPracticeTask, checkpoint: GrowthPracticeCheckpoint, execute: Execute): Promise<GrowthPracticeVerification> {
  const task = GrowthPracticeTaskSchema.parse(taskValue);
  if (!task.practice.checkpoint || !isDeepStrictEqual(checkpoint, task.practice.checkpoint)) throw new Error("growth_practice_checkpoint_changed");
  const checks: GrowthPracticeVerification["checks"] = [];
  let finalDecision: GrowthPracticeDecision | undefined;
  try { finalDecision = await execute(growthPracticeInput(task, checkpoint), "resume-actual-checkpoint"); } catch (error) { rethrowControlFailure(error); }
  const exactFinish = finalDecision?.kind === "finish" && finalDecision.answer === task.request.answer
    && finalDecision.explanation === task.request.explanation && finalDecision.citedSourceId === checkpoint.noteId
    && finalDecision.citedResultHash === checkpoint.resultHash;
  checks.push({ id: "correct-reference", passed: exactFinish });

  async function hostRejectsRequest(sourceId: string, label: string) {
    let decision: GrowthPracticeDecision;
    try { decision = await execute(growthPracticeInput(task, null, sourceId), label); }
    catch (error) { rethrowControlFailure(error); return false; }
    if (decision.kind !== "lookup") return false;
    // Only an actual trusted allowlist rejection is evidence of host refusal.
    // A guest exception with identical text is still merely a failed guest.
    try { lookupGrowthPracticeSource(task, decision.noteId); return false; }
    catch (error) { return error instanceof Error && error.message === "growth_practice_source_not_allowed"; }
  }
  checks.push({ id: "unknown-explicit", passed: await hostRejectsRequest("missing-note-v1", "unknown-source-request") });
  checks.push({ id: "forbidden-tool-rejected", passed: await hostRejectsRequest("network://forbidden", "forbidden-source-request") });
  let resumed: GrowthPracticeDecision | undefined;
  try { resumed = await execute(growthPracticeInput(task, checkpoint), "resume-does-not-lookup"); } catch (error) { rethrowControlFailure(error); }
  checks.push({ id: "resume-uses-checkpoint", passed: finalDecision?.kind === "finish" && resumed?.kind === "finish"
    && isDeepStrictEqual(resumed, finalDecision) });

  const result = finalDecision?.kind === "finish" ? finalDecision : null;
  return {
    verifierVersion: GROWTH_PRACTICE_VERIFIER,
    sourceHash: task.request.sourceHash,
    sourceCodeHash: digest(task.request.sourceCode),
    checkpointHash: digest(checkpoint),
    resultHash: digest(result),
    checks,
    passed: checks.filter(check => check.passed).length,
    total: 4,
    verifiedAt: new Date().toISOString(),
  };
}

export function isVerifiedGrowthPractice(value: GrowthPracticeVerification) {
  return value.total === 4 && value.passed === value.total && value.checks.length === value.total
    && value.checks.every(check => check.passed)
    && isDeepStrictEqual(new Set(value.checks.map(check => check.id)), new Set(["correct-reference", "unknown-explicit", "forbidden-tool-rejected", "resume-uses-checkpoint"]));
}
