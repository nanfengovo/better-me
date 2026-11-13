import { z } from "zod";
import { StudioAnalysisRequestSchema, StudioAnalysisTaskCreateSchema, StudioAnalysisTaskSchema, careerRuntimeBinding, studioAnalysisRuntime,
  type StudioAnalysisTask, type StudioAnalysisRequest } from "@better-me/agent-contracts";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError, createTaskTransport, taskIssueText, type TaskClientOptions } from "./agent-task-transport";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function createStudioAnalysisTaskClient(options: TaskClientOptions = {}) {
  const transport = createTaskTransport(StudioAnalysisTaskSchema, options);
  async function generate(raw: StudioAnalysisRequest, rootScopeKey: string, signal?: AbortSignal, resumeTaskId?: string) {
    const lease = captureIdentityLease(); lease.assert(); signal?.throwIfAborted();
    const request = StudioAnalysisRequestSchema.parse(raw), runtime = studioAnalysisRuntime(request.runtime.model), binding = careerRuntimeBinding(runtime);
    const workspaceKey = `studio-analysis:${rootScopeKey}`;
    const rows = z.object({ tasks: z.array(z.object({ ownerId: z.string() }).passthrough()) }).parse((await transport.request("", undefined, signal)).raw); lease.assert();
    if (rows.tasks.some(task => task.ownerId !== lease.ownerId)) throw new IdentityBoundaryError();
    const matches = rows.tasks.filter(task => task.kind === "studio_analysis" && task.workspaceKey === workspaceKey).map(task => StudioAnalysisTaskSchema.parse(task))
      .filter(task => task.request.contextId === request.contextId && task.request.purpose === request.purpose && task.request.idempotencyKey === request.idempotencyKey);
    if (matches.length > 1) throw new AgentTaskClientError("原分析任务无法唯一核对，未派送或另建账本。", "studio_task_unresolved");
    let task: StudioAnalysisTask | undefined = matches[0];
    if (task && !same(task.request, request)) throw new AgentTaskClientError("该操作编号已绑定另一份完整资料，未覆盖或重跑。", "idempotency_conflict", task.id);
    if (resumeTaskId && task?.id !== resumeTaskId) throw new AgentTaskClientError("原任务或资料不一致，未恢复或创建另一任务。", "studio_source_changed", resumeTaskId);
    if (!task) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([rootScopeKey, request.contextId, request.purpose, request.idempotencyKey])));
      const key = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
      task = z.object({ task: StudioAnalysisTaskSchema }).parse((await transport.request("", taskCreatePayload(StudioAnalysisTaskCreateSchema.parse({
        kind: "studio_analysis", workspaceKey, rootScopeKey, objective: `有界职业分析：${request.purpose}；保留完整资料，产物须人工核对。`, request,
        runtimeBinding: binding, consent: true, idempotencyKey: `studio-analysis:${key}`,
      })), signal)).raw).task;
    }
    lease.assert(); if (task.ownerId !== lease.ownerId) throw new IdentityBoundaryError(); assertTaskScope(task, rootScopeKey);
    if (!same(task.request, request) || !same(task.runtimeBinding, binding)) throw new AgentTaskClientError("原任务资料或模型不一致，未换用其他执行器。", "runtime_binding_changed", task.id);
    if (task.status === "ready" || resumeTaskId && ["paused", "interrupted", "failed", "budget_exhausted"].includes(task.status)) {
      task = await transport.read(task.id, signal, { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding: binding, consent: true, runtime }, task.status === "ready" ? "/start" : "/resume");
    }
    while (task.status === "running") {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Observer stopped", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, options.pollMs ?? 400);
        signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      });
      lease.assert(); task = await transport.read(task.id, signal);
    }
    lease.assert(); signal?.throwIfAborted();
    if (task.status !== "completed" || !task.result) throw new AgentTaskClientError(taskIssueText[task.error ?? ""] ?? `分析任务处于 ${task.status}；完整记录与原额度保留，请核对原任务后明确恢复。`, task.error ?? "studio_analysis_not_ready", task.id);
    task = await transport.read(task.id, signal, undefined, "/analysis/current"); lease.assert();
    if (task.status !== "completed" || !task.result) throw new AgentTaskClientError("原结果已不处于可核对的完成状态，未采用。", "studio_analysis_not_ready", task.id);
    if (task.result.contextId !== request.contextId || !same(task.result.runtime, request.runtime)) throw new AgentTaskClientError("分析回执归属或模型不一致，未采用。", "invalid_response", task.id);
    return task.result;
  }
  return { generate, get: transport.read, pause: transport.pause };
}
