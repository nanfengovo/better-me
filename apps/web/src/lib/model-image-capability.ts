import type { LlmConfig } from "@better-me/core";

export type ModelImageCapability = "supported" | "unsupported" | "unknown";

function safeHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Only claims support where the selected provider and model family are known.
 * OpenAI-compatible endpoints, local models and custom gateways otherwise stay
 * explicitly unverified instead of guessing from a model label alone.
 */
export function getModelImageCapability(config: Pick<LlmConfig, "provider" | "baseUrl" | "model">): ModelImageCapability {
  const model = config.model.trim().toLowerCase();
  if (!model) return "unknown";

  if (config.provider === "gemini") {
    if (/^(?:text-)?embedding(?:-|$)|^gemini-embedding\b|^aqa\b/.test(model)) return "unsupported";
    if (/^gemini-(?:1\.|2\.|2-|2\.5-|3-|pro|flash)/.test(model)) return "supported";
    return "unknown";
  }

  const host = safeHostname(config.baseUrl);
  if (config.provider === "openai-compatible" && host === "api.openai.com") {
    if (/^gpt-(?:4o|4\.1|4\.5|5)(?:$|[-:])/.test(model)) return "supported";
    if (/^gpt-3\.5(?:$|[-:])/.test(model)) return "unsupported";
  }

  if (config.provider === "openai-compatible" && host === "api.deepseek.com") {
    if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model)) return "supported";
    if (model === "deepseek-v4-pro") return "unsupported";
    if (/^deepseek-(?:chat|reasoner|coder)(?:$|[-:])/.test(model)) return "unsupported";
  }

  if (config.provider === "ollama") {
    if (/(?:^|[-_:])(?:llava|llava-llama3|qwen2-vl|qwen2\.5-vl|qwen2\.5vl|qwen3-vl|minicpm-v|moondream|gemma3|granite3\.2-vision|llama3\.2-vision)(?:$|[-_:])/i.test(model)) {
      return "supported";
    }
  }

  return "unknown";
}

export function modelImageCapabilityLabel(
  capability: ModelImageCapability,
  t: (zh: string, en: string) => string,
): string {
  if (capability === "supported") return t("当前模型支持图片输入", "Image input supported");
  if (capability === "unsupported") return t("当前模型不支持图片输入", "Image input unsupported");
  return t("当前模型图片能力未验证", "Image support unverified");
}

export function modelImageCapabilityDescription(
  capability: ModelImageCapability,
  t: (zh: string, en: string) => string,
): string {
  if (capability === "supported") return t("图片会随本条消息发送给当前模型。", "Images will be sent to the current model with this message.");
  if (capability === "unsupported") return t("移除图片或切换到支持视觉输入的模型后再发送。", "Remove the image or switch to a model with vision input before sending.");
  return t("服务商和模型列表没有提供可验证的视觉能力；发送可能被拒绝，请先确认模型支持图像输入。", "The provider and model list do not confirm vision support. The request may be rejected; verify image input support before sending.");
}
