import type { ProjectedResume } from "../project/resume-projection.js";
import {
  type LlmConfig,
  type JdMatchReport,
  JdMatchReportSchema,
} from "./types.js";

async function withRequestTimeout<T>(
  timeoutMs: number,
  label: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label}超时（${timeoutMs / 1000} 秒），请检查服务地址、网络或模型状态后重试。`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

/** Standard OpenAI-compatible Chat Completion fetcher (supports OpenAI, DeepSeek, Gemini, Ollama) */
export async function fetchChatCompletion(
  config: LlmConfig,
  messages: { role: "system" | "user" | "assistant"; content: ChatMessageContent }[],
): Promise<string> {
  let url = config.baseUrl.trim().replace(/\/+$/, "");

  // Normalize Gemini OpenAI-compatible URL from Google AI Studio
  // (https://generativelanguage.googleapis.com/v1beta/openai/chat/completions)
  if (
    config.provider === "gemini" ||
    url.includes("generativelanguage.googleapis.com")
  ) {
    if (!url.includes("/openai")) {
      url = `${url}/openai`;
    }
  }

  if (!url.endsWith("/chat/completions")) {
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
  };

  return withRequestTimeout(90_000, "AI 生成请求", async (signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      let detail = errorText;
      try {
        const errJson = JSON.parse(errorText);
        detail = errJson.error?.message || errJson.message || errorText;
      } catch {
        // not json
      }
      throw new Error(
        `AI 接口请求失败 (${response.status}): ${detail.slice(0, 300)}`,
      );
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI 接口未返回有效的 choices 文本。");
    }

    return content;
  });
}

/** Generate detailed JD Match Report & Gap Analysis based on projected resume */
export async function analyzeJdMatch(
  config: LlmConfig,
  resume: ProjectedResume,
  jdText: string,
): Promise<JdMatchReport> {
  const systemPrompt = `你是一个资深技术招聘专家与工业/软件架构师面试官。
你的任务是将候选人当前的真实简历（已通过事实库校验）与用户提供的【目标岗位招聘需求 (JD)】进行精确比对，输出客观、犀利的匹配度诊断报告。

【绝对守则与防编造原则】：
1. 严禁捏造事实！严禁凭空为候选人添加未在简历中出现过的项目经历、未掌握的技术栈或未经核实的量化数字。
2. 润色建议必须基于候选人既有的真实经历，仅允许进行关键词对齐、语序重构、STAR 因果逻辑强化，绝不篡改事实。
3. 请以严格、理性的工业研发视角审视，指出真实的短板（如缺乏某协议经验、学历硬伤、年限差距等）。
4. 必须输出纯 JSON，符合以下 TypeScript 格式：
{
  "matchScore": number (0-100),
  "scoreSummary": string (1-2句中肯的总体评分评价),
  "matchingStrengths": string[] (候选人与该JD高度契合的3-5个硬核亮点),
  "missingGaps": string[] (该JD要求但候选人简历中明显缺失或偏弱的技术/业务项),
  "tailoredSuggestions": [
    {
      "claimId": string (对应简历中的事实条目ID，若有),
      "currentText": string (候选人原文字),
      "suggestedText": string (在不造假的前提下，更对齐该JD痛点的优化表述),
      "reason": string (为什么这样微调能更好地打动面试官)
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
    const parsed = JSON.parse(cleaned);
    return JdMatchReportSchema.parse(parsed);
  } catch {
    throw new Error(
      "AI 返回内容未能成功解析为标准诊断报告，请重试或更换模型。",
    );
  }
}

/** Fetch list of available models for a given provider/config */
export async function fetchAvailableModels(config: LlmConfig): Promise<string[]> {
  return withRequestTimeout(20_000, "获取模型列表", async (signal) => {
    const isGemini =
      config.provider === "gemini" ||
      config.baseUrl.includes("generativelanguage.googleapis.com");

    if (isGemini) {
      if (!config.apiKey?.trim()) {
        throw new Error("请先填写 Google Gemini API Key 以获取可用模型列表。");
      }

      // Try Google AI Studio native models endpoint
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
        config.apiKey.trim(),
      )}`;

      const res = await fetch(url, { signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let msg = errText;
        try {
          const j = JSON.parse(errText);
          msg = j.error?.message || errText;
        } catch {
          // ignore
        }
        throw new Error(`Google API 获取模型失败 (${res.status}): ${msg}`);
      }

      const data = await res.json();
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

    const res = await fetch(modelsUrl, { headers, signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        msg = j.error?.message || j.message || errText;
      } catch {
        // ignore
      }
      throw new Error(`获取模型列表失败 (${res.status}): ${msg}`);
    }

    const data = await res.json();
    if (Array.isArray(data.data)) {
      return data.data.map((m: { id?: string }) => m.id).filter((id: unknown) => typeof id === "string" && Boolean(id.trim()));
    }
    if (Array.isArray(data.models)) {
      return data.models.map((m: { name?: string; id?: string }) => m.name || m.id).filter((id: unknown) => typeof id === "string" && Boolean(id.trim()));
    }

    return [];
  });
}

/** Read the models endpoint; this does not validate a generation request. */
export async function testLlmConnection(
  config: LlmConfig,
): Promise<{ success: boolean; message: string; models: string[] }> {
  try {
    const models = await fetchAvailableModels(config);
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
      message: (err as Error).message || "获取模型列表失败",
      models: [],
    };
  }
}
