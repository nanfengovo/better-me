import { LlmConfigSchema, type ChatCompletionResult, type LlmConfig, type fetchChatCompletionResult } from "@better-me/core";
import { buildCoachMessages, validateCoachRequest, parseCoachPayload } from "@better-me/agent-contracts/career-coach-protocol";
import { coachOutputSchema } from "./output-schema";
import type { CoachGenerate } from "./types";
export { validateCoachRequest, parseCoachPayload };

type CoachMessages = Parameters<typeof fetchChatCompletionResult>[1];
export type CoachTransport = (config: LlmConfig, messages: CoachMessages, options?: Parameters<typeof fetchChatCompletionResult>[2]) => Promise<ChatCompletionResult>;
function fail(message: string): never { throw new Error(message); }
function throwIfCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("本次顾问生成已取消，未采纳迟到结果。", "AbortError"); }

function validateConfig(config: LlmConfig): LlmConfig {
  const parsed = LlmConfigSchema.safeParse(config);
  if (!parsed.success || !config?.baseUrl?.trim() || !config?.model?.trim()) {
    fail("请打开现有模型配置，填写有效的服务地址和模型名称后重试。");
  }
  const value = parsed.data;
  const address = new URL(value.baseUrl);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) {
    fail("请打开现有模型配置，使用不含用户名或密码的 HTTP(S) 模型服务地址。");
  }
  if (value.provider !== "ollama" && !value.apiKey.trim()) {
    fail("请打开现有模型配置并填写 API Key；Ollama 本地模型允许留空。");
  }
  return { ...value, model: value.model.trim(), baseUrl: value.baseUrl.trim() };
}


/** Explicit transport seam for isolated protocol tests; production uses CoachGuidanceTaskClient. */
async function requestCompletion(
  transport: CoachTransport,
  config: LlmConfig,
  messages: CoachMessages,
  signal?: AbortSignal,
  options: Parameters<typeof fetchChatCompletionResult>[2] = {},
): Promise<ChatCompletionResult> {
  throwIfCancelled(signal);
  if (!signal) return transport(config, messages, options);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("本次顾问生成已取消，未采纳迟到结果。", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([transport(config, messages, { ...options, signal }), aborted]);
    throwIfCancelled(signal);
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Injection changes only the model transport; all request/result guards remain mandatory. */
export function createCoachGenerator(transport: CoachTransport): CoachGenerate {
  return async (request, config, signal) => {
    throwIfCancelled(signal);
    const safeRequest = validateCoachRequest(request);
    const safeConfig = validateConfig(config);
    // Ollama documents schema decoding for local models, not its cloud models.
    // Do not assume arbitrary compatible gateways support the optional field.
    const localSchema = safeConfig.provider === "ollama" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(safeConfig.baseUrl).hostname) &&
      !/(?:-cloud|:cloud)$/i.test(safeConfig.model);
    const options: Parameters<typeof fetchChatCompletionResult>[2] = localSchema ? {
      responseFormat: { type: "json_schema", json_schema: { name: `better_me_${safeRequest.mode}`, strict: true, schema: coachOutputSchema(safeRequest) } },
    } : {};
    const result = await requestCompletion(transport, safeConfig, buildCoachMessages(safeRequest), signal, options);
    throwIfCancelled(signal);
    if (result.finishReason && !["stop", "end_turn", "eos", "complete", "completed"].includes(result.finishReason.toLowerCase())) {
      fail("模型输出被截断、过滤或未正常结束，未采用本轮结果；请缩小任务范围、重试或检查模型配置。");
    }
    const payload = parseCoachPayload(result.content, safeRequest);
    throwIfCancelled(signal);
    return {
      payload,
      model: { provider: safeConfig.provider, name: safeConfig.model, generatedAt: new Date().toISOString() },
    };
  };
}
