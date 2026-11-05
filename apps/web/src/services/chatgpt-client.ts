import { z } from "zod";
import { ChatGptStateSchema, ChatGptModelSchema, ChatGptIssueSchema, type ChatGptIssue, type ChatGptResponseRequest } from "@better-me/agent-contracts";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { agentOrigin, ownedFetch, IdentityBoundaryError } from "../lib/identity";

export type ChatGptChoice = { profileId: string; model: string };
export class ChatGptClientError extends Error {
  constructor(message: string, readonly issue?: ChatGptIssue) { super(message); this.name = "ChatGptClientError"; }
}
export function createChatGptClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  async function request<Schema extends z.ZodTypeAny>(route: string, schema: Schema, body?: unknown, signal?: AbortSignal): Promise<z.output<Schema>> {
    const connection = readRuntimeConnection();
    const timeout = AbortSignal.timeout(route === "/response" ? 185_000 : 30_000);
    try {
      const response = await ownedFetch(`${options.baseUrl ?? agentOrigin()}/api/v1/agent/chatgpt${route}`, {
        method: body === undefined ? "GET" : "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${connection?.agentToken ?? "better-me-agent-token"}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, options.fetch ?? fetch);
      const payload: unknown = await response.json();
      if (!response.ok) {
        const issue = payload && typeof payload === "object" && "issue" in payload ? ChatGptIssueSchema.safeParse(payload.issue) : undefined;
        throw new ChatGptClientError(issue?.success ? issue.data.message : "ChatGPT 本机授权服务未接受请求。请检查连接；未改用 API Key。", issue?.success ? issue.data : undefined);
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ChatGptClientError("ChatGPT 服务返回不完整，未采用结果；不会自动切换提供方。");
      return parsed.data;
    } catch (error) {
      if (signal?.aborted || error instanceof ChatGptClientError || error instanceof IdentityBoundaryError) throw error;
      throw new ChatGptClientError(timeout.aborted ? "ChatGPT 请求等待超时，结果尚未确认；输入已保留，不会自动重发。" : "无法连接本机 ChatGPT 授权服务，输入已保留；未切换付费 API。");
    }
  }
  return {
    state: (signal?: AbortSignal) => request("/state", ChatGptStateSchema, undefined, signal),
    signIn: (profileId?: string, signal?: AbortSignal) => request("/sign-in", z.object({ attemptId: z.string(), authorizationUrl: z.string().url() }), { ...(profileId ? { profileId } : {}) }, signal),
    cancelSignIn: (attemptId: string, signal?: AbortSignal) => request("/cancel-sign-in", ChatGptStateSchema, { attemptId }, signal),
    models: async (profileId: string, signal?: AbortSignal) => (await request("/models", z.object({ models: z.array(ChatGptModelSchema) }), { profileId }, signal)).models,
    signOut: (profileId: string, signal?: AbortSignal) => request("/sign-out", z.object({ remoteRevoked: z.boolean(), state: ChatGptStateSchema }), { profileId }, signal),
    retry: (profileId: string, signal?: AbortSignal) => request("/retry", ChatGptStateSchema, { profileId }, signal),
    respond: async (input: ChatGptResponseRequest, signal?: AbortSignal) => {
      try { return await request("/response", z.object({ text: z.string().min(1), model: z.string(), profileId: z.string() }), input, signal); }
      finally { if (typeof window !== "undefined") window.dispatchEvent(new window.Event("betterme:chatgpt-state")); }
    },
  };
}
export type ChatGptClient = ReturnType<typeof createChatGptClient>;
export const defaultChatGptClient = createChatGptClient();
