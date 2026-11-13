import { z } from "zod";
import { StudioCommitteeTaskCreateSchema, StudioCommitteeTaskSchema, careerRuntimeBinding, studioAnalysisRuntime, studioCommitteeOperation,
  type StudioCommitteeTask } from "@better-me/agent-contracts";
import { StudioCommitteeRequestSchema, type StudioContext } from "@better-me/agent-contracts/career-studio";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import { assertTaskScope, taskCreatePayload } from "./agent-task-scope";
import { AgentTaskClientError, createTaskTransport, type TaskClientOptions } from "./agent-task-transport";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function createStudioCommitteeTaskClient(options: TaskClientOptions = {}) {
  const transport = createTaskTransport(StudioCommitteeTaskSchema, options);
  const check = (task: StudioCommitteeTask, context: StudioContext) => {
    const lease = captureIdentityLease(); lease.assert();
    if (context.ownerId !== lease.ownerId || task.ownerId !== lease.ownerId) throw new IdentityBoundaryError();
    assertTaskScope(task, context.workspaceKey);
    if (context.revoked || Date.parse(context.expiresAt) <= Date.now() || task.request.contextId !== context.id || task.workspaceKey !== `studio-committee:${context.workspaceKey}`)
      throw new AgentTaskClientError("原审查不属于当前资料授权，未采用或另建任务。", "studio_context_stale", task.id);
    return task;
  };
  async function get(id: string, context: StudioContext, signal?: AbortSignal) {
    let task = check(await transport.read(id, signal), context);
    if (task.status === "completed") task = check(await transport.read(id, signal, undefined, "/committee/current"), context);
    return task;
  }
  async function dispatch(task: StudioCommitteeTask, context: StudioContext, resume: boolean, signal?: AbortSignal) {
    check(task, context);
    if (task.status === "ready" || resume && ["paused", "interrupted", "failed", "budget_exhausted"].includes(task.status)) {
      const runtime = studioAnalysisRuntime(task.request.runtime.model), binding = careerRuntimeBinding(runtime);
      if (!same(binding, task.runtimeBinding)) throw new AgentTaskClientError("原模型绑定不一致，未恢复。", "runtime_binding_changed", task.id);
      task = check(await transport.read(task.id, signal, { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint,
        runtimeBinding: binding, consent: true, runtime }, task.status === "ready" ? "/start" : "/resume"), context);
    }
    return studioCommitteeOperation(task);
  }
  return {
    async start(raw: unknown, context: StudioContext, signal?: AbortSignal) {
      const lease = captureIdentityLease(); lease.assert(); signal?.throwIfAborted();
      const request = StudioCommitteeRequestSchema.parse(raw), workspaceKey = `studio-committee:${context.workspaceKey}`;
      if (request.contextId !== context.id || context.ownerId !== lease.ownerId || context.revoked || Date.parse(context.expiresAt) <= Date.now()) throw new AgentTaskClientError("请重新核对本次资料授权。", "studio_context_stale");
      const rows = z.object({ tasks: z.array(z.object({ ownerId: z.string() }).passthrough()) }).parse((await transport.request("", undefined, signal)).raw); lease.assert();
      if (rows.tasks.some(task => task.ownerId !== lease.ownerId)) throw new IdentityBoundaryError();
      const matches = rows.tasks.filter(task => task.kind === "studio_committee" && task.workspaceKey === workspaceKey).map(task => StudioCommitteeTaskSchema.parse(task))
        .filter(task => task.request.contextId === context.id && task.request.idempotencyKey === request.idempotencyKey);
      if (matches.length > 1) throw new AgentTaskClientError("原审查无法唯一核对，未派送。", "studio_task_unresolved");
      let task = matches[0];
      if (task && !same(task.request, request)) throw new AgentTaskClientError("同一操作编号对应另一份完整资料，未覆盖。", "idempotency_conflict", task.id);
      const runtimeBinding = careerRuntimeBinding(studioAnalysisRuntime(request.runtime.model));
      if (!task) {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([context.workspaceKey, context.id, request.idempotencyKey]))); lease.assert();
        const key = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
        task = z.object({ task: StudioCommitteeTaskSchema }).parse((await transport.request("", taskCreatePayload(StudioCommitteeTaskCreateSchema.parse({
          kind: "studio_committee", workspaceKey, rootScopeKey: context.workspaceKey, objective: "委员会审查所选完整资料；每个角色、修复与证据读取使用原根账，结果待人工核对。",
          request, runtimeBinding, consent: true, idempotencyKey: `studio-committee:${key}`,
        })), signal)).raw).task;
      }
      lease.assert(); check(task, context);
      if (!same(task.request, request) || !same(task.runtimeBinding, runtimeBinding)) throw new AgentTaskClientError("回执资料或模型绑定不一致，未启动。", "runtime_binding_changed", task.id);
      // Reconciliation never resumes a paused/failed task. Only the separate
      // explicit resume action can do so, and it retains the original ID/ledger.
      if (task.status === "completed") return studioCommitteeOperation(await get(task.id, context, signal));
      return dispatch(task, context, false, signal);
    },
    async get(id: string, context: StudioContext, signal?: AbortSignal) { return studioCommitteeOperation(await get(id, context, signal)); },
    async pause(id: string, context: StudioContext) { check(await transport.read(id), context); return studioCommitteeOperation(check(await transport.pause(id), context)); },
    async resume(id: string, context: StudioContext, selected: unknown, signal?: AbortSignal) {
      const task = check(await transport.read(id, signal), context);
      if (!same(task.request.runtime, selected)) throw new AgentTaskClientError("当前选定模型与原审查不同，未恢复或换模型。", "runtime_binding_changed", id);
      return dispatch(task, context, true, signal);
    },
  };
}
