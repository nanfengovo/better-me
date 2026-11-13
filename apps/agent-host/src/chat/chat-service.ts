import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AgentActionCardSchema, type ChatRequestBody, type ChatMessage, type AgentActionCard } from "./types.js";
import { vorkService } from "../vork/service.js";
import { AGENT_CHAT_INSTRUCTIONS } from "./instructions.js";

const SYSTEM_PROMPT = `${AGENT_CHAT_INSTRUCTIONS}

【输出规范】：
请用专业、诚恳、富有建设性的语气回答用户。不要为了凑格式重复正文，也不要返回示例占位数据。
只有当确实有可执行的结构化建议时，才在正文末尾附一个 JSON 数组代码块；每个对象必须字段完整且符合实际上下文，来源未核实的公司卡片必须将 verified 设为 false。无可操作建议时省略动作卡片：
\`\`\`actions
[
  {
    "type": "company_card",
    "companyName": "公司名称",
    "ownership": "企业性质，如外商独资/民营高科技",
    "jurisdiction": "注册属地代码，如 CN/US",
    "summary": "企业背景及实控人简析",
    "verified": true,
    "officialUrl": "https://..."
  },
  {
    "type": "resume_proposal",
    "targetSection": "目标模块，如 工作经历/个人优势/技术栈",
    "targetRef": {"kind": "claim_text", "experienceId": "只可复制授权上下文中的 ID", "claimId": "只可复制授权上下文中的 ID", "locale": "zh"},
    "originalText": "必须与该授权字段原文完全一致",
    "proposedText": "优化后的专业表述",
    "rationale": "优化理由及契合的 JD 核心点"
  },
  {
    "type": "interview_defense",
    "gapItem": "潜在缺口或面试官高频质疑点",
    "strategy": "防守策略与经验迁移逻辑",
    "sampleAnswer": "高情商/高专业度的面试参考话术"
  },
  {
    "type": "job_match",
    "title": "岗位名称",
    "company": "推荐公司",
    "salary": "薪资范围",
    "location": "城市",
    "highlight": "与候选人画像契合的亮点"
  },
  {
    "type": "badge_3d",
    "title": "项目突破名称，如：高并发分布式中台架构重构",
    "highlight": "核心架构难点与指标，如：千万级 TPS 削峰 · 毫秒级事务一致性",
    "style": "quantum_prism（量子色散棱镜）/ cyber_neon（赛博黑曜石）/ sunset_solitude（深渊浮岛）",
    "rationale": "选用该物理光追特质代表该项目的工程特质理由"
  }
]
\`\`\`
注意：正文可使用常规 Markdown 排版，\`\`\`actions 代码块必须是合法 JSON 数组，不要在 JSON 代码块之后再添加正文。`;

const MAX_CONTINUATIONS = 2;
const MIN_CONTINUATION_OVERLAP = 8;

function appendContinuation(current: string, addition: string): string {
  const scanLength = Math.min(current.length, addition.length, 4_000);
  for (let overlap = scanLength; overlap >= MIN_CONTINUATION_OVERLAP; overlap -= 1) {
    if (current.slice(-overlap) === addition.slice(0, overlap)) return current + addition.slice(overlap);
  }
  return current + addition;
}

function responseText(response: { content: unknown }): string {
  if (typeof response.content === "string") return response.content;
  if (!Array.isArray(response.content)) return "";
  return response.content.flatMap((block) => {
    if (typeof block === "string") return [block];
    if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") return [block.text];
    return [];
  }).join("");
}

function responseFinishReason(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null || !("response_metadata" in response)) return undefined;
  const metadata = response.response_metadata;
  if (typeof metadata !== "object" || metadata === null || !("finish_reason" in metadata)) return undefined;
  return typeof metadata.finish_reason === "string" ? metadata.finish_reason.toLowerCase() : undefined;
}

function wasLengthLimited(finishReason: string | undefined): boolean {
  return Boolean(finishReason && ["length", "max_tokens", "max_output_tokens", "token_limit"].includes(finishReason));
}

function parseActionCards(rawText: string): { content: string; actions?: AgentActionCard[]; warning?: string } {
  let content = rawText;
  const cards: AgentActionCard[] = [];
  let warning: string | undefined;
  const actionPattern = /```(?:actions|json)\s*([\s\S]*?)\s*```/gi;

  for (const match of rawText.matchAll(actionPattern)) {
    const block = match[1]?.trim();
    if (!block) continue;
    try {
      const parsed: unknown = JSON.parse(block);
      const candidates = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && "actions" in parsed && Array.isArray(parsed.actions)
          ? parsed.actions
          : undefined;
      if (!candidates) continue;
      const validCards = candidates.flatMap((candidate) => {
        const result = AgentActionCardSchema.safeParse(candidate);
        return result.success ? [result.data] : [];
      });
      if (validCards.length > 0) {
        cards.push(...validCards);
      }
      if (validCards.length === candidates.length && candidates.length > 0) content = content.replace(match[0], "");
      if (validCards.length !== candidates.length) warning = "部分结构化动作卡片字段不完整，未展示无效卡片；请查看正文并补充信息。";
    } catch {
      // Keep malformed fenced text visible so content is never silently lost.
      warning = "模型返回的动作卡片格式不正确，已保留原始文本。";
    }
  }

  const uniqueCards = cards.filter((card, index) => cards.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(card)) === index);
  return {
    content: content.trim(),
    ...(uniqueCards.length > 0 ? { actions: uniqueCards } : {}),
    ...(warning ? { warning } : {}),
  };
}

export async function processAgentChat(
  model: BaseChatModel,
  body: ChatRequestBody,
  signal?: AbortSignal,
): Promise<ChatMessage> {
  signal?.throwIfAborted();
  const contextNotes: string[] = [];

  if (body.context?.currentJob) {
    const job = body.context.currentJob;
    contextNotes.push(`【当前选中岗位】：
职位：${job.title || "未披露"}
公司：${job.company || "未披露"}
地点：${job.location || "未披露"}
JD 描述：${job.description || "未提供"}`);
  }

  if (body.context?.resumeSummary) {
    const resume = body.context.resumeSummary;
    contextNotes.push(`【候选人当前简历概况】：
个人优势/Headline：${resume.headline || "未填写"}
核心技能栈：${resume.skills?.join(", ") || "未填写"}
可见经历要点：${resume.recentExperience || "未提供"}`);
  }

  if (body.context?.selectedText?.trim()) {
    contextNotes.push(`【用户选中的文本】：\n${body.context.selectedText}`);
  }

  if (body.context?.resumeEditContext) {
    contextNotes.push(`【用户本次明确授权用于提出修改建议的简历字段】（只读提案，仍需用户逐条批准）：\n${JSON.stringify(body.context.resumeEditContext)}`);
  }

  const systemContent = contextNotes.length > 0
    ? `${SYSTEM_PROMPT}\n\n当前上下文背景信息：\n${contextNotes.join("\n\n")}`
    : SYSTEM_PROMPT;

  const messages: BaseMessage[] = [
    new SystemMessage(systemContent),
    ...body.messages.map((m) => {
      if (m.role === "assistant") return new AIMessage(m.content);
      const quotedResumeText = (m.references ?? []).map((reference) => `[简历原文引用 · ${reference.sourceLabel}]\n${reference.text}`);
      const userText = [m.content, ...quotedResumeText].filter(Boolean).join("\n\n");
      if (m.attachments?.length) {
        return new HumanMessage([
          { type: "text", text: userText || "请分析上传的图片。" },
          ...m.attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl } })),
        ]);
      }
      return new HumanMessage(userText);
    }),
  ];

  const response = await model.invoke(messages, { signal });
  signal?.throwIfAborted();
  let rawText = responseText(response);
  let finishReason = responseFinishReason(response);
  let continuationCount = 0;
  let continuationFailed = false;
  while (wasLengthLimited(finishReason) && continuationCount < MAX_CONTINUATIONS && rawText.trim()) {
    const previousLength = rawText.length;
    let continuation: BaseMessage;
    try {
      continuation = await model.invoke([
        ...messages,
        new AIMessage(rawText),
        new HumanMessage("请从上一条回复准确结束的位置继续，不要重复已输出内容。补完所有尚未完成的段落与 JSON 结构化动作卡片；如果不能确认某项信息，请明确标注待核实。"),
      ], { signal });
    } catch {
      signal?.throwIfAborted();
      continuationFailed = true;
      break;
    }
    signal?.throwIfAborted();
    const addition = responseText(continuation);
    if (!addition.trim() || addition.trim() === rawText.trim()) break;
    rawText = appendContinuation(rawText, addition);
    finishReason = responseFinishReason(continuation);
    continuationCount += 1;
    if (rawText.length === previousLength) break;
  }

  signal?.throwIfAborted();
  const parsed = parseActionCards(rawText);

  // ── vork 3D 物理光追徽章生成 (Metal GPU Hardware Acceleration) ─────────────
  if (parsed.actions) {
    for (const card of parsed.actions) {
      if (card.type === "badge_3d" && !card.imageUrl) {
        try {
          const style = card.style || "quantum_prism";
          const res = await vorkService.render({
            presetId: style,
            resolution: [1280, 720],
            profile: "std/draft",
          });
          card.imageUrl = res.dataUrl;
          card.renderDurationMs = res.durationMs;
        } catch (vorkErr) {
          console.warn("[vork-tool] 渲染 3D 徽章失败:", vorkErr);
        }
      }
    }
  }

  // A text response (including a clarification) is not a tool request. Never
  // manufacture actions or project achievements from keywords in user data.
  const lengthLimited = wasLengthLimited(finishReason);
  const empty = !parsed.content && !parsed.actions?.length;
  const warning = [
    parsed.warning,
    lengthLimited ? "模型输出仍触及长度上限，回复可能不完整；可让 Agent 继续补完。" : undefined,
    continuationFailed ? "自动续答请求失败，已保留当前内容；可手动继续补完。" : undefined,
    empty ? "模型返回空内容，请重试或检查服务商配置。" : undefined,
  ].filter(Boolean).join(" ") || undefined;

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: "assistant",
    content: parsed.content || (parsed.actions?.length ? "已整理出以下结构化建议：" : "模型返回空内容，请重试。"),
    actions: parsed.actions,
    meta: {
      provider: body.modelSettings.provider ?? "openai-compatible",
      model: body.modelSettings.model,
      source: "agent-host",
      status: empty ? "error" : lengthLimited ? "truncated" : "ready",
      completeness: empty ? "empty" : lengthLimited ? "truncated" : "complete",
      observedAt: new Date().toISOString(),
      ...(finishReason ? { finishReason } : {}),
      ...(warning ? { warning } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}
