import type { ChatGptIssue } from "@better-me/agent-contracts";

export class ChatGptError extends Error {
  constructor(readonly issue: ChatGptIssue) { super(issue.message); this.name = "ChatGptError"; }
}
export function failure(kind: ChatGptIssue["kind"], code: string, message: string, status?: number): ChatGptError {
  return new ChatGptError({ kind, code, message, ...(status ? { status } : {}) });
}
export function providerFailure(status: number, body: unknown, requestId?: string): ChatGptError {
  const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z0-9_]{1,160}$/.test(error.code)
    ? error.code : `http_${status}`;
  let result: ChatGptError;
  if (code === "subscription_sharing_usage_limit_exceeded") result = failure("limit", code, "ChatGPT 套餐或本应用额度达到限制。请查看用量设置，确认恢复后再重试；未切换付费 API。", status);
  else if (code === "subscription_sharing_user_not_eligible") result = failure("eligibility", code, "当前账号、工作区或策略不支持本应用使用 ChatGPT 套餐。请核实接入资格；不会反复登录或改用付费 API。", status);
  else if (code === "subscription_sharing_unsupported_capability" || code === "subscription_sharing_route_not_supported") result = failure("protocol", code, "ChatGPT 套餐通道不支持本次模型、请求或能力。请检查兼容性；不会用其他计费通道重发。", status);
  else if (status === 401) result = failure("auth", code, "ChatGPT 授权未被接受。请重新授权所选账号；对话和输入已保留。", status);
  else if (status === 403) result = failure("permission", code, "ChatGPT 拒绝了本次权限或访问地区。请核实账号与授权范围；不会绕过限制或更换计费。", status);
  else if (status === 404) result = failure("model", code, "所选 ChatGPT 模型当前不可用。请刷新该账号的模型列表并主动重新选择。", status);
  else result = failure("unavailable", code, "ChatGPT 请求暂未完成，可能是服务繁忙、限流或网络异常。输入已保留；不会自动重发或更换提供方。", status);
  if (requestId && /^[A-Za-z0-9_-]{1,160}$/.test(requestId)) result.issue.requestId = requestId;
  return result;
}
export function safeFailure(error: unknown): ChatGptError {
  return error instanceof ChatGptError ? error : failure("unavailable", "connection_unavailable", "ChatGPT 连接暂不可用，已有记录已保留；未自动重试或切换付费 API。");
}
