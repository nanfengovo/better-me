import type { StudioCommitteeTask } from "./agent-task.js";
import type { StudioOperation } from "./career-studio.js";

/** A read-only view, never a second execution record or adoption authority. */
export function studioCommitteeOperation(task: StudioCommitteeTask): StudioOperation {
  const status: StudioOperation["status"] = task.status === "running" || task.status === "ready" ? "running"
    : task.status === "completed" && task.result?.status === "completed" ? "completed"
    : task.status === "revoked" ? "cancelled" : task.status === "interrupted" ? "interrupted" : task.status === "failed" ? "failed" : "partial";
  return { id: task.id, contextId: task.request.contextId, kind: "committee", inputHash: task.sourceFingerprint, status,
    taskStatus: task.status, startedAt: task.createdAt, updatedAt: task.updatedAt,
    ...(task.result ? { output: task.result } : {}), ...(task.error ? { errorCode: task.error } : {}),
    usage: { modelCalls: task.usage.modelCalls, toolCalls: task.usage.toolCalls, elapsedMs: task.usage.activeMs } };
}
