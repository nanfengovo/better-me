import type { ProjectedResume } from "../project/resume-projection.js";
import { getJdMatchReadiness } from "../project/jd-match-readiness.js";
import {
  type LlmConfig,
  type JdMatchReport,
  JdMatchReportSchema,
} from "./types.js";

export type AiRequestOptions = {
  signal?: AbortSignal;
  /** Opt-in only: callers must know their configured endpoint supports this. */
  responseFormat?: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
};

function cancelledRequest(label: string): DOMException {
  return new DOMException(`${label}已取消。`, "AbortError");
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  label: string,
  request: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw cancelledRequest(label);
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const cancel = () => {
    if (controller.signal.aborted) return;
    cancelled = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await request(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (cancelled) throw cancelledRequest(label);
    if (timedOut) {
      // eslint-disable-next-line preserve-caught-error -- Raw fetch causes may contain API keys in URLs.
      throw new Error(`${label}超时（${timeoutMs / 1000} 秒），请检查服务地址、网络或模型状态后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

function redactApiSecrets(text: string, apiKey?: string): string {
  const key = apiKey?.trim();
  let safe = text;
  if (key) {
    for (const secret of new Set([key, encodeURIComponent(key)])) {
      safe = safe.split(secret).join("[已隐藏]");
    }
  }
  return safe.replace(
    /([?&](?:key|api[_-]?key|token|access[_-]?token)=)[^&#\s"'<>]*/gi,
    "$1[已隐藏]",
  );
}

function aiTransportError(
  error: unknown,
  label: string,
  apiKey?: string,
): unknown {
  if (error instanceof TypeError) {
    return new Error(`${label}未收到可读取的服务商响应。可能与网络、代理、API 地址或浏览器跨域限制有关；请检查这些连接条件后重试。目前无法据此判断 API Key 或模型是否有效。`);
  }
  if (error instanceof Error && error.name !== "AbortError") {
    return new Error(redactApiSecrets(error.message, apiKey));
  }
  return error;
}

async function fetchAiEndpoint(
  url: string,
  init: RequestInit,
  label: string,
  apiKey?: string,
): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) { throw aiTransportError(error, label, apiKey); }
}

async function readAiJson(response: Response, label: string, apiKey?: string) {
  try { return await response.json(); }
  catch (error) { throw aiTransportError(error, label, apiKey); }
}

async function providerErrorDetail(response: Response, apiKey?: string): Promise<string> {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string") detail = message;
  } catch {
    // Some services return a plain text HTTP error.
  }
  return redactApiSecrets(detail, apiKey).slice(0, 600);
}

/** Recognize only official Gemini API addresses, preserving the configured host and version. */
function geminiVersionBaseUrl(baseUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { return undefined; }
  if (url.protocol !== "https:" || !["generativelanguage.googleapis.com", "generativelanguage.mtls.googleapis.com"].includes(url.hostname) ||
    url.port || url.username || url.password) return undefined;
  const version = url.pathname.match(/^\/(v1beta|v1alpha)(?:\/(?:openai(?:\/chat\/completions)?|chat\/completions))?\/?$/)?.[1];
  return version ? `${url.origin}/${version}` : undefined;
}

/** Clean markdown json blocks if the model outputs them. */
function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match?.[1]) {
    return match[1].trim();
  }
  return trimmed;
}

export type ChatMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface ChatCompletionResult {
  content: string;
  finishReason?: string;
}

/** Standard OpenAI-compatible Chat Completion fetcher (supports OpenAI, DeepSeek, Gemini, Ollama) */
export async function fetchChatCompletion(
  config: LlmConfig,
  messages: { role: "system" | "user" | "assistant"; content: ChatMessageContent }[],
  options: AiRequestOptions = {},
): Promise<string> {
  return (await fetchChatCompletionResult(config, messages, options)).content;
}

/** Same request contract, preserving the provider's completion reason for callers
 * that need to distinguish a finished answer from a token-limited one. */
export async function fetchChatCompletionResult(
  config: LlmConfig,
  messages: { role: "system" | "user" | "assistant"; content: ChatMessageContent }[],
  options: AiRequestOptions = {},
): Promise<ChatCompletionResult> {
  let url = config.baseUrl.trim().replace(/\/+$/, "");

  const officialGeminiBaseUrl = geminiVersionBaseUrl(config.baseUrl);
  if (officialGeminiBaseUrl) {
    url = `${officialGeminiBaseUrl}/openai/chat/completions`;
  } else if (!url.endsWith("/chat/completions")) {
    url = `${url}/chat/completions`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${config.apiKey.trim()}`;
  }

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.3,
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
  };

  return withRequestTimeout(90_000, "AI 生成请求", async (signal) => {
    const response = await fetchAiEndpoint(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }, "AI 生成请求", config.apiKey);

    if (!response.ok) {
      const detail = await providerErrorDetail(response, config.apiKey);
      throw new Error(
        `AI 接口请求失败 (${response.status}): ${detail}`,
      );
    }

    const json = await readAiJson(response, "AI 生成请求", config.apiKey);
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI 接口未返回有效的 choices 文本。");
    }

    return {
      content,
      ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason.toLowerCase() } : {}),
    };
  }, options.signal);
}

/** Generate detailed JD Match Report & Gap Analysis based on projected resume */
export async function analyzeJdMatch(
  config: LlmConfig,
  resume: ProjectedResume,
  jdText: string,
): Promise<JdMatchReport> {
  const readiness = getJdMatchReadiness(resume);
  if (!readiness.ready) throw new Error(readiness.message);

  // Snapshot only the claims actually sent with this request. A duplicate ID is
  // ambiguous even when both claims happen to contain the same words.
  const sourceClaims = new Map<string, string | null>();
  for (const experience of resume.experiences) {
    for (const claim of experience.claims) {
      sourceClaims.set(claim.id, sourceClaims.has(claim.id) ? null : claim.text);
    }
  }
  const normalizeQuote = (text: string) => text.replace(/\s+/gu, " ").trim();

  const systemPrompt = `你是一个资深技术招聘专家与工业/软件架构师面试官。
你的任务是比较当前选择的简历文本与用户提供的【目标岗位招聘需求 (JD)】，输出文字层面的参考报告。简历内容由用户提供，未经独立核实；结构校验不能证明事实真实。你无法判断用户未在本次材料中展示的实际能力。

【报告约束】：
1. 不得添加材料未提供的项目经历、技术栈、责任范围、业务场景、成果或量化数字，也不得把 JD 要求改写为用户已具备的事实。
2. 未提及不等于不会。对没有依据的技能或条件，只能写“当前材料未提供相关依据，需本人确认”，不能断言用户不会、能力不足或没有经验。隐藏或未选择的简历内容同样属于未知。
3. 亮点只列材料中有依据的内容，可以为空；missingGaps 中的材料缺失项必须明确标为待确认，不能冒充已经证实的能力缺口。评分仅是本次文本的 AI 参考评分，不是能力认证或录用概率。
4. 每条表达建议必须引用本次输入中唯一的 claimId，currentText 必须逐字引用该条完整原文，不得概括、拼接或虚构。只能在原文信息范围内调整表达；不得加入新技能、经历、场景或数字。没有可引用的合适条目时，tailoredSuggestions 返回空数组。引用存在也不代表建议内容已经通过真实性核验。
5. 必须输出纯 JSON，符合以下 TypeScript 格式：
{
  "matchScore": number (0-100),
  "scoreSummary": string (说明当前文本依据及判断局限),
  "matchingStrengths": string[] (当前材料有依据的契合点，可以为空),
  "missingGaps": string[] (区分有明确依据的冲突与当前材料未提供依据的待确认项),
  "tailoredSuggestions": [
    {
      "claimId": string (本次输入中唯一的原文条目ID，必须提供),
      "currentText": string (该条完整原文，必须提供),
      "suggestedText": string (信息范围不变的待核实候选表达),
      "reason": string (说明表达调整目的与需要本人核对的内容)
    }
  ],
  "interviewDefenseTips": string[] (面试官极可能针对此JD对候选人进行深挖的3-4个刁钻技术追问或考点)
}`;

  const userContent = `【候选人当前投影简历】：
${JSON.stringify(resume, null, 2)}

【目标岗位 JD 文本】：
${jdText.trim()}`;

  const rawOutput = await fetchChatCompletion(config, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]);

  try {
    const cleaned = extractJsonString(rawOutput);
    // The provider cannot choose the local exclusion count, including through a
    // malformed value. It is always derived from the suggestions below.
    const parsed = JdMatchReportSchema.parse({ ...JSON.parse(cleaned), unverifiedSuggestionCount: 0 });
    const tailoredSuggestions = parsed.tailoredSuggestions.flatMap((suggestion) => {
      if (!suggestion.claimId?.trim() || suggestion.currentText === undefined) return [];
      const original = sourceClaims.get(suggestion.claimId);
      if (typeof original !== "string" || !normalizeQuote(original) ||
        normalizeQuote(suggestion.currentText) !== normalizeQuote(original)) return [];
      return [{ ...suggestion, currentText: original }];
    });
    return {
      ...parsed,
      tailoredSuggestions,
      unverifiedSuggestionCount: parsed.tailoredSuggestions.length - tailoredSuggestions.length,
    };
  } catch {
    throw new Error(
      "AI 返回内容未能成功解析为标准诊断报告，请重试或更换模型。",
    );
  }
}

/** Fetch list of available models for a given provider/config */
export async function fetchAvailableModels(config: LlmConfig, options: AiRequestOptions = {}): Promise<string[]> {
  return withRequestTimeout(20_000, "获取模型列表", async (signal) => {
    const officialGeminiBaseUrl = geminiVersionBaseUrl(config.baseUrl);
    const nativeModelsUrl = officialGeminiBaseUrl ? `${officialGeminiBaseUrl}/models` : undefined;

    if (nativeModelsUrl) {
      if (!config.apiKey?.trim()) {
        throw new Error("请先填写 Google Gemini API Key 以获取可用模型列表。");
      }

      const res = await fetchAiEndpoint(nativeModelsUrl, {
        signal,
        headers: { "x-goog-api-key": config.apiKey.trim() },
      }, "获取模型列表", config.apiKey);
      if (!res.ok) {
        const msg = await providerErrorDetail(res, config.apiKey);
        throw new Error(`Google API 获取模型失败 (${res.status}): ${msg}`);
      }

      const data = await readAiJson(res, "获取模型列表", config.apiKey);
      if (Array.isArray(data.models)) {
        const models = data.models
          .filter((m: { supportedGenerationMethods?: string[] }) => {
            const methods = m.supportedGenerationMethods || [];
            return methods.includes("generateContent");
          })
          .map((m: { name?: string }) => {
            const rawName: string = m.name || "";
            return rawName.replace(/^models\//, "");
          })
          .filter(Boolean);

        if (models.length > 0) {
          return models;
        }
      }
    }

    // Standard OpenAI-compatible models endpoint
    let modelsUrl = config.baseUrl.trim().replace(/\/+$/, "");
    if (modelsUrl.endsWith("/chat/completions")) {
      modelsUrl = modelsUrl.replace(/\/chat\/completions$/, "/models");
    } else if (!modelsUrl.endsWith("/models")) {
      modelsUrl = `${modelsUrl}/models`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey?.trim()) {
      headers["Authorization"] = `Bearer ${config.apiKey.trim()}`;
    }

    const res = await fetchAiEndpoint(modelsUrl, { headers, signal }, "获取模型列表", config.apiKey);
    if (!res.ok) {
      const msg = await providerErrorDetail(res, config.apiKey);
      throw new Error(`获取模型列表失败 (${res.status}): ${msg}`);
    }

    const data = await readAiJson(res, "获取模型列表", config.apiKey);
    if (Array.isArray(data.data)) {
      return data.data.map((m: { id?: string }) => m.id).filter((id: unknown) => typeof id === "string" && Boolean(id.trim()));
    }
    if (Array.isArray(data.models)) {
      return data.models.map((m: { name?: string; id?: string }) => m.name || m.id).filter((id: unknown) => typeof id === "string" && Boolean(id.trim()));
    }

    return [];
  }, options.signal);
}

/** Read the models endpoint; this does not validate a generation request. */
export async function testLlmConnection(
  config: LlmConfig,
  options: AiRequestOptions = {},
): Promise<{ success: boolean; message: string; models: string[] }> {
  try {
    const models = await fetchAvailableModels(config, options);
    if (models.length === 0) {
      return {
        success: false,
        message: "已连接模型列表接口，但未返回模型标识。实际生成请求尚未验证；可核对服务文档后手动填写模型名称。",
        models: [],
      };
    }
    return {
      success: true,
      message: `已获取 ${models.length} 个模型标识。实际生成请求尚未验证，模型权限、额度与文本/视觉能力需在调用时确认。`,
      models,
    };
  } catch (err) {
    return {
      success: false,
      message: redactApiSecrets(err instanceof Error ? err.message : "获取模型列表失败", config.apiKey),
      models: [],
    };
  }
}
