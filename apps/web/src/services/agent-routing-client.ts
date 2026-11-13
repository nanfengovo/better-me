import { z } from "zod";
import { AgentRoutingPolicySchema, AgentRoutingTraceSchema, AgentRoutingResultSchema, type AgentRoutingPolicy, type AgentRoutingTrace } from "@better-me/agent-contracts";
import { agentOrigin, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

export class AgentRoutingClientError extends Error {
  constructor(readonly code: string, readonly trace?: AgentRoutingTrace) {
    const messages: Record<string, string> = {
      no_approved_runtime: "没有检查通过的已批准底座；请独立登录或调整备用列表。未改用付费 API。",
      selected_runtime_unavailable: "手动选择的底座不可用；未切换到其他工具。",
      routing_revision_conflict: "底座选择已变化，本轮已停止；请核对新选择后重新发送。",
      routing_result_unknown: "这次请求已有执行标记，结果未确认；为避免重复计费，没有重放。",
      cancelled: "本轮已停止，没有自动重放或切换底座。",
      routing_response_moved_to_tasks: "旧底座推理入口已退役，请使用统一任务；未发送资料或切换底座。",
    };
    super(`${messages[code] ?? "底座请求未完成，可能已消耗额度；没有自动重放或切换 API。"}${trace?.attempts.filter(item => item.status === "skipped").map(item => ` ${item.runtimeId}：${item.reason}`).join("") ?? ""}`);
    this.name = "AgentRoutingClientError";
  }
}
export interface AgentRoutingClient {
  status(signal?: AbortSignal): Promise<{ policy: AgentRoutingPolicy; trace?: AgentRoutingTrace }>;
  update(policy: AgentRoutingPolicy, signal?: AbortSignal): Promise<AgentRoutingPolicy>;
  respond(input: { id: string; expectedRevision: number; instructions: string; messages: { role: "user" | "assistant"; content: string }[] }, signal: AbortSignal): Promise<z.infer<typeof AgentRoutingResultSchema>>;
}
export function createAgentRoutingClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}): AgentRoutingClient {
  const request = async <S extends z.ZodTypeAny>(suffix: string, schema: S, method: string, body?: unknown, signal?: AbortSignal): Promise<z.output<S>> => {
    const response = await ownedFetch(`${options.baseUrl ?? agentOrigin()}/api/v1/agent/routing${suffix}`, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, options.fetch ?? fetch);
    const value: unknown = await response.json();
    if (!response.ok) { const error = z.object({ error: z.string(), trace: AgentRoutingTraceSchema.optional() }).safeParse(value); throw new AgentRoutingClientError(error.success ? error.data.error : "routing_unavailable", error.success ? error.data.trace : undefined); }
    return schema.parse(value);
  };
  return {
    status: signal => request("", z.object({ policy: AgentRoutingPolicySchema, trace: AgentRoutingTraceSchema.optional() }), "GET", undefined, signal),
    update: async (policy, signal) => (await request("", z.object({ policy: AgentRoutingPolicySchema }), "PUT", { expectedRevision: policy.revision, mode: policy.mode, preferred: policy.preferred, backups: policy.backups, allowApiBackups: policy.allowApiBackups, consent: true }, signal)).policy,
    respond: async () => { throw new AgentRoutingClientError("routing_response_moved_to_tasks"); },
  };
}
export const defaultAgentRoutingClient = createAgentRoutingClient();
