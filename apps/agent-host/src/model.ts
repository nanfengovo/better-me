/**
 * model.ts — Build a ChatOpenAI-compatible model from the AI settings
 * that the browser passes in per-request.
 *
 * Supports any OpenAI-compatible endpoint (OpenAI, DeepSeek, local Ollama,
 * Gemini OpenAI-compat shim) without importing Vercel AI SDK or any second
 * model runtime.  Only @langchain/openai is needed.
 */

import { ChatOpenAI, ChatOpenAICompletions, convertMessagesToCompletionsMessageParams, convertCompletionsMessageToBaseMessage } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { isAIMessage } from "@langchain/core/messages";
import { z } from "zod";

export const ModelSettingsSchema = z.object({
  provider: z.enum(["openai-compatible", "gemini", "ollama", "custom"]).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).max(100),
  apiKey: z.string().optional().default("ollama-key"),
  temperature: z.number().min(0).max(2).optional(),
  thinkingMode: z.enum(["enabled", "disabled"]).optional(),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  maxTokens: z.number().int().min(1).max(393216).optional(),
});

export interface ModelSettings {
  /** Provider identity is passed through for response provenance; transport remains OpenAI-compatible. */
  provider?: "openai-compatible" | "gemini" | "ollama" | "custom";
  /** OpenAI-compatible base URL. Omit for official OpenAI. */
  baseUrl?: string;
  /** Model name, e.g. "gpt-4o", "deepseek-chat", "gemini-1.5-pro" */
  model: string;
  /** API key – never persisted, passed in per-request from browser. */
  apiKey: string;
  /** Temperature for generation (default: 0). */
  temperature?: number;
  thinkingMode?: "enabled" | "disabled";
  reasoningEffort?: "low" | "high" | "max";
  maxTokens?: number;
}

export class DeepSeekApiError extends Error {
  constructor(readonly status: number) {
    const reasons: Record<number, string> = {
      400: "请求格式不正确，请核对消息格式与模型。", 401: "API Key 无效或已失效，请重新配置 DeepSeek Key。",
      402: "账户余额不足，请在 DeepSeek 平台检查余额。", 403: "当前 Key 无访问权限。",
      404: "模型或 API 地址不存在，请刷新列表并检查配置。", 422: "请求参数不受支持，请核对模型、思考模式与输出格式；不是本地令牌或 Origin 故障。",
      429: "请求过于频繁或并发已满，请稍后重试。", 500: "服务暂时故障，请稍后重试。", 503: "服务繁忙，请稍后重试。",
    };
    super(`DeepSeek (${status})：${reasons[status] ?? "未收到可用答复，请检查网络、服务地址与账户配置。"}`);
    this.name = "DeepSeekApiError";
  }
}

/** Non-streaming graph adapter. Retains DeepSeek tool-loop reasoning on the wire,
 * never in the visible answer. Generic ChatOpenAI drops this provider-specific field. */
class DeepSeekChatModel extends ChatOpenAICompletions {
  override async _generate(...[messages, options]: Parameters<ChatOpenAICompletions["_generate"]>) {
    options.signal?.throwIfAborted();
    const params = this.invocationParams(options);
    if (params.response_format?.type === "json_schema") throw new Error("DeepSeek 请使用 json_object 并在本地校验，不支持 json_schema。");
    const mapped = convertMessagesToCompletionsMessageParams({ messages, model: this.model });
    // Converter preserves message order; replay reasoning only for tool-enabled requests.
    const replayMessages = mapped.map((message, index) => {
      const reasoning = messages[index]?.additional_kwargs.reasoning_content;
      return message.role === "assistant" && params.tools?.length && typeof reasoning === "string"
        ? { ...message, reasoning_content: reasoning } : message;
    });
    const data = await this.completionWithRetry({ ...params, stream: false, messages: replayMessages }, { signal: options.signal, ...options.options }).catch((error: unknown) => {
      if (options.signal?.aborted) throw error;
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 502;
      // Provider errors can contain API keys and request content; do not retain them in server logs.
      throw new DeepSeekApiError(status);
    });
    const generations = data.choices.map(choice => {
      const message = convertCompletionsMessageToBaseMessage({ message: choice.message, rawResponse: data });
      if ("reasoning_content" in choice.message && typeof choice.message.reasoning_content === "string") {
        message.additional_kwargs.reasoning_content = choice.message.reasoning_content;
      }
      message.response_metadata = { ...message.response_metadata, finish_reason: choice.finish_reason, model_name: data.model };
      if (isAIMessage(message) && data.usage) message.usage_metadata = {
        input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens, total_tokens: data.usage.total_tokens,
      };
      return { text: choice.message.content ?? "", message, generationInfo: { finish_reason: choice.finish_reason } };
    });
    return { generations };
  }
}

export function buildModel(settings: ModelSettings): BaseChatModel {
  let baseURL = settings.baseUrl?.trim();
  if (baseURL) {
    baseURL = baseURL.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
    // Match the browser transport when an official endpoint was pasted instead of its base.
    if (/^https:\/\/api\.deepseek\.com(?:\/(?:v1|beta))?\/models$/.test(baseURL)) baseURL = baseURL.replace(/\/models$/, "");
  }

  if (baseURL && /^https:\/\/api\.deepseek\.com(?:\/(?:v1|beta))?$/.test(baseURL)) {
    if (!settings.apiKey?.trim()) throw new Error("请先填写 DeepSeek API Key。");
    const thinking = settings.model === "deepseek-reasoner" || settings.thinkingMode !== "disabled";
    return new DeepSeekChatModel({
      model: settings.model, apiKey: settings.apiKey.trim(), configuration: { baseURL },
      modelKwargs: { thinking: { type: thinking ? "enabled" : "disabled" }, ...(thinking ? { reasoning_effort: settings.reasoningEffort ?? "high" } : {}) },
      temperature: thinking ? undefined : settings.temperature ?? 0.3,
      maxTokens: settings.maxTokens ?? (thinking ? 16384 : 8192),
      streaming: false, maxRetries: 0, timeout: 90_000,
    });
  }

  return new ChatOpenAI({
    model: settings.model,
    apiKey: settings.apiKey || "mock-key",
    configuration: baseURL
      ? { baseURL }
      : undefined,
    temperature: settings.temperature ?? 0,
    // Do not stream inside graph nodes — the HTTP layer handles SSE framing.
    streaming: false,
  });
}
