import type { LlmConfig } from "./types.js";

export const DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;

/** Never infer a provider from a substring or a model name on a third-party gateway. */
export function isOfficialDeepSeek(config: Pick<LlmConfig, "baseUrl">): boolean {
  try {
    const url = new URL(config.baseUrl.trim());
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/(?:v1\/?|beta\/?|(?:v1\/|beta\/)?(?:chat\/completions|models)\/?)?$/.test(url.pathname);
  } catch { return false; }
}

export function deepSeekRequestParameters(config: LlmConfig) {
  // Legacy configs have no toggle: preserve the provider default (thinking enabled).
  const enabled = config.model === "deepseek-reasoner" || config.thinkingMode !== "disabled";
  return {
    thinking: { type: enabled ? "enabled" : "disabled" },
    ...(enabled ? { reasoning_effort: config.reasoningEffort ?? "high" } : { temperature: config.temperature ?? 0.3 }),
    max_tokens: config.maxTokens ?? (enabled ? 16384 : 8192),
  };
}

/** Use only for prompts requesting a JSON object, not top-level arrays or ordinary chat. */
export function jsonObjectOptions(config: LlmConfig) {
  return isOfficialDeepSeek(config) ? { responseFormat: { type: "json_object" as const } } : {};
}

export function deepSeekErrorMessage(status: number): string {
  const messages: Record<number, string> = {
    400: "请求格式不正确，请检查模型名称与消息格式。",
    401: "API Key 无效或已失效，请在 AI 配置中重新填写 DeepSeek Key。",
    402: "账户余额不足，请前往 DeepSeek 平台检查余额；不是连接故障。",
    403: "当前 Key 无权访问，请检查账户权限与访问限制。",
    404: "模型或 API 地址不存在，请刷新模型列表并检查 Base URL。",
    422: "请求参数不受支持，请核对思考模式、模型名称与输出格式；不是本地服务令牌或 Origin 问题。",
    429: "请求过于频繁或并发已满，请稍后重试；不会自动反复发送付费请求。",
    500: "服务暂时故障，请稍后重试。",
    503: "服务繁忙，请稍后重试。",
  };
  return `DeepSeek (${status})：${messages[status] ?? "请求失败，请检查服务状态和账户配置。"}`;
}
