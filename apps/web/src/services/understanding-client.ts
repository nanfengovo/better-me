import type { LlmConfig } from "@better-me/core";
import {
  UnderstandingCreateSchema, UnderstandingSessionSchema,
  type UnderstandingCapability, type UnderstandingSession, type UnderstandingTurnInput,
} from "@better-me/agent-contracts";
import { z } from "zod";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { agentOrigin, ownedFetch, IdentityBoundaryError } from "../lib/identity";

const SessionResponse = UnderstandingSessionSchema;
const CapabilitiesResponse = z.object({ runtimes: z.array(z.object({ id: z.string(), name: z.string(), available: z.boolean(), supported: z.boolean(), reason: z.string().optional(),
  code: z.enum(["ready", "needs_authorization", "needs_verification", "authorization_pending", "not_installed", "adapter_missing", "sandbox_unavailable", "protocol_incompatible", "managed_policy_unavailable", "runtime_terminated"]).optional(),
  authMethods: z.array(z.enum(["device", "browser", "api-key"])).optional(), authorized: z.boolean().optional(), model: z.string().optional(), verifiedAt: z.string().optional(), authorizationMode: z.enum(["native", "api-key"]).optional(),
})) });
const NativeLoginResponse = z.object({ state: z.enum(["pending", "complete", "failed"]),
  verificationUrl: z.string().max(6000).refine(value => { const url = new URL(value); return /^https:\/\/auth\.openai\.com\/(?:codex\/)?device$/.test(value) || url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port && (url.hostname === "claude.ai" && url.pathname === "/oauth/authorize" || url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize"); }).optional(),
  userCode: z.string().regex(/^[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/).optional(), expiresAt: z.number().optional(),
  runtimeId: z.enum(["codex", "claude-code"]).optional(), acceptsCode: z.boolean().optional(),
});
export type NativeLoginState = z.infer<typeof NativeLoginResponse>;
export type NativeApiAuthorization = { mode: "api-key"; apiKey: string; model: string; endpoint?: string; consent: true };

export type UnderstandingRuntime = { kind: "model"; modelSettings: {
  provider: LlmConfig["provider"]; model: string; baseUrl: string; apiKey?: string; temperature?: number;
  thinkingMode?: "enabled" | "disabled"; reasoningEffort?: "low" | "high" | "max"; maxTokens?: number;
} } | { kind: "native"; runtimeId: string } | { kind: "chatgpt"; profileId: string; model: string } | { kind: "unified"; expectedRevision: number };
export type UnderstandingCreateInput = z.infer<typeof UnderstandingCreateSchema>;
export type UnderstandingTurnRequest = UnderstandingTurnInput & { runtime: UnderstandingRuntime };
export class UnderstandingClientError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = "UnderstandingClientError"; }
}
export interface UnderstandingClient {
  createSession(input: UnderstandingCreateInput, signal?: AbortSignal): Promise<UnderstandingSession>;
  getSession(id: string, signal?: AbortSignal): Promise<UnderstandingSession>;
  updateSource(id: string, input: { expectedRevision: number; sourceText: string }, signal?: AbortSignal): Promise<UnderstandingSession>;
  addGrant(id: string, path: string, signal?: AbortSignal): Promise<UnderstandingSession>;
  revokeGrant(id: string, grantId: string, signal?: AbortSignal): Promise<UnderstandingSession>;
  startTurn(id: string, input: UnderstandingTurnRequest, signal?: AbortSignal): Promise<UnderstandingSession>;
  confirm(id: string, input: { expectedRevision: number; summaryHash: string }, signal?: AbortSignal): Promise<UnderstandingSession>;
  cancel(id: string, expectedTurnCount: number, signal?: AbortSignal): Promise<UnderstandingSession>;
  getCapabilities(signal?: AbortSignal): Promise<UnderstandingCapability[]>;
  authorizeNative?(id: string, input: NativeApiAuthorization, signal?: AbortSignal): Promise<unknown>;
  disconnectNative?(id: string, signal?: AbortSignal): Promise<unknown>;
  startNativeLogin?(signal?: AbortSignal, id?: "codex" | "claude-code"): Promise<NativeLoginState>;
  getNativeLogin?(signal?: AbortSignal, id?: "codex" | "claude-code"): Promise<NativeLoginState>;
  cancelNativeLogin?(signal?: AbortSignal, id?: "codex" | "claude-code"): Promise<unknown>;
  submitNativeCode?(code: string, signal?: AbortSignal): Promise<unknown>;
}

/** Resolve the connection per request; neither credentials nor model settings enter local history. */
export function createUnderstandingClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}): UnderstandingClient {
  const request = async <Schema extends z.ZodTypeAny>(path: string, schema: Schema, method = "GET", body?: unknown, signal?: AbortSignal): Promise<z.output<Schema>> => {
    const connection = readRuntimeConnection();
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await ownedFetch(`${options.baseUrl ?? agentOrigin()}/api/v1/agent/understanding${path}`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection?.agentToken ?? "better-me-agent-token"}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined,
      }, options.fetch ?? fetch);
    } catch (error) {
      if (signal?.aborted || error instanceof IdentityBoundaryError) throw error;
      throw new UnderstandingClientError(timeout.aborted
        ? "本机 Agent 请求等待超时；状态尚未确认，输入已保留。请刷新状态后再决定是否重试。"
        : "暂时无法连接本机 Agent；输入已保留。请确认配套服务已启动，再刷新状态。", undefined, timeout.aborted ? "timeout" : "unavailable");
    }
    const payload: unknown = await response.json().catch((error: unknown) => { if (error instanceof IdentityBoundaryError) throw error; return undefined; });
    if (!response.ok) {
      const statusMessages: Record<number, string> = {
        400: "本次输入未被接受，请检查内容或授权目录；原有记录未被覆盖。",
        401: "本机 Agent 的连接授权已失效，请重新连接服务。",
        403: "本次目录或操作没有授权，请检查授权范围。",
        404: "这段项目对话未找到；本地草稿仍保留，可以重新建立对话。",
        409: "记录已变化或任务仍在运行，请先刷新最新理解，再核对后提交。",
        413: "本次资料超出服务限制，请缩小范围；输入仍保留。",
        422: "当前运行方式不支持本次请求，请检查模型或原生运行时能力。",
      };
      const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : undefined;
      const nativeMessages: Record<string, string> = {
        authorization_required: "所选工具尚未获得本 BetterMe 账号授权，请在模型与工具中连接。",
        sandbox_unavailable: "操作系统强制隔离未通过检查，工具没有启动，也不会降级运行。",
        protocol_incompatible: "当前 CLI 版本未通过受控协议检查，未启动工具。",
        managed_policy_unavailable: "Codex 在隔离中无法同步 macOS 管理策略。未忽略管理员限制，需要兼容版本或系统支持。",
        runtime_terminated: "CLI 在隔离启动时被系统终止；不是未登录，未取消隔离重试。",
        authorization_changed: "本账号的工具授权已变化，本轮没有继续执行。",
        authorization_in_progress: "本账号已有另一个窗口正在授权；未接管该窗口的登录流程。",
      };
      throw new UnderstandingClientError(code && nativeMessages[code] || statusMessages[response.status] || "本次 Agent 操作未完成；输入已保留，可刷新状态后重试。", response.status, code);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new UnderstandingClientError("Agent 返回的记录格式不完整，未采用；请刷新状态，当前输入仍保留。", response.status, "invalid_response");
    return parsed.data;
  };
  const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  return {
    createSession: (input, signal) => request("/sessions", SessionResponse, "POST", UnderstandingCreateSchema.parse(input), signal),
    getSession: (id, signal) => request(sessionPath(id), SessionResponse, "GET", undefined, signal),
    updateSource: (id, input, signal) => request(`${sessionPath(id)}/source`, SessionResponse, "POST", input, signal),
    addGrant: (id, path, signal) => request(`${sessionPath(id)}/grants`, SessionResponse, "POST", { path }, signal),
    revokeGrant: (id, grantId, signal) => request(`${sessionPath(id)}/grants/${encodeURIComponent(grantId)}`, SessionResponse, "DELETE", undefined, signal),
    startTurn: (id, input, signal) => request(`${sessionPath(id)}/turns`, SessionResponse, "POST", input, signal),
    confirm: (id, input, signal) => request(`${sessionPath(id)}/confirm`, SessionResponse, "POST", input, signal),
    cancel: (id, expectedTurnCount, signal) => request(`${sessionPath(id)}/cancel`, SessionResponse, "POST", { expectedTurnCount }, signal),
    getCapabilities: async signal => (await request("/capabilities", CapabilitiesResponse, "GET", undefined, signal)).runtimes,
    authorizeNative: (id, input, signal) => request(`/native/${encodeURIComponent(id)}/authorization`, z.object({ saved: z.literal(true) }), "POST", input, signal),
    disconnectNative: (id, signal) => request(`/native/${encodeURIComponent(id)}/authorization`, z.object({ disconnected: z.literal(true) }), "DELETE", undefined, signal),
    startNativeLogin: (signal, id = "codex") => request(`/native/${id}/login`, NativeLoginResponse, "POST", { consent: true }, signal),
    getNativeLogin: (signal, id = "codex") => request(`/native/${id}/login`, NativeLoginResponse, "GET", undefined, signal),
    cancelNativeLogin: (signal, id = "codex") => request(`/native/${id}/login`, z.object({ cancelled: z.literal(true) }), "DELETE", undefined, signal),
    submitNativeCode: (code, signal) => request("/native/claude-code/login-code", z.object({ submitted: z.literal(true) }), "POST", { code }, signal),
  };
}
export const defaultUnderstandingClient = createUnderstandingClient();
export function understandingModelRuntime(config: LlmConfig): UnderstandingRuntime {
  return { kind: "model", modelSettings: {
    provider: config.provider, model: config.model, baseUrl: config.baseUrl, ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    temperature: config.temperature, thinkingMode: config.thinkingMode, reasoningEffort: config.reasoningEffort, maxTokens: config.maxTokens,
  } };
}
