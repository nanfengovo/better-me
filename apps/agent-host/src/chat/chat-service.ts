import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AgentActionCardSchema, type ChatRequestBody, type ChatMessage, type AgentActionCard } from "./types.js";

const SYSTEM_PROMPT = `你是一个内置于 BetterMe 个人求职与成长工作台的专属 Agent 职业顾问助手。
你的任务是协助候选人深入分析目标岗位、调研雇主背景、优化简历表达、制定面试应对策略。回答要直接回应问题，给出可执行且有上下文的结论，不要只复述用户的问题或输出空泛模板。

【真实性与完整性】
- 如果没有联网检索或用户没有提供来源，不得声称“已经查询/核实”公司、岗位、薪资或招聘状态；明确区分已知事实、推断和待核实项。
- 改写简历时只调整表达，不补造项目、技术、职责、百分比或业务结果。缺少事实时用问题标出需要用户补充的内容。
- 先给结论，再说明依据、限制和下一步；涉及多个对象时逐项覆盖，不要只给一个例子后省略其余内容。
- 输出尽可能完整；若确实受上下文或模型输出长度限制，明确说明缺失部分并给出续问建议，不要用省略号伪装完整结论。

你可以执行以下专业任务，并在回答中按规范输出结构化动作卡片（Action Cards）：
1. 查公司资料：分析其控股背景（民营/国企/外企）、业务方向、稳定性及潜在风险。
2. 优化简历细节：针对目标 JD 将口语化、扁平的经历改写为符合 STAR 原则、量化且突出技术难点的 Bullet Point。
3. 岗位匹配与缺口攻防：分析简历在目标岗位的优势与盲区，提供面试应答防守策略。

【简历定点修改协议】
- 仅当当前请求提供了“用户明确授权的可编辑简历字段”时，才可提出简历修改卡；普通聊天、简历概况、引用摘录都不授权写回。
- 只针对输入字段中的一个现有目标提出修改；targetRef 必须逐字复制该字段的 targetRef，targetSection 写清个人简介或公司/职位/经历要点。
- originalText 必须与该目标字段原文完全一致；不得自造目标、id、原文或新经历。 proposedText 只调整措辞，不新增原文没有的事实、技术、数字、责任或结果。
- 字段缺少可证实内容时，不要给可写回卡片，改为向用户提问。建议卡仅供审阅，绝不表示自动修改。
- 卡片格式增加 targetRef，例如 {"kind":"claim_text","experienceId":"...","claimId":"...","locale":"zh"} 或 {"kind":"profile_headline","locale":"zh"}。

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
  body: ChatRequestBody
): Promise<ChatMessage> {
  const contextNotes: string[] = [];

  if (body.context?.currentJob) {
    const job = body.context.currentJob;
    contextNotes.push(`【当前选中岗位】：
职位：${job.title || "未披露"}
公司：${job.company || "未披露"}
地点：${job.location || "未披露"}
JD 描述：${job.description ? job.description.slice(0, 1500) : "未提供"}`);
  }

  if (body.context?.resumeSummary) {
    const resume = body.context.resumeSummary;
    contextNotes.push(`【候选人当前简历概况】：
个人优势/Headline：${resume.headline || "未填写"}
核心技能栈：${resume.skills?.join(", ") || "未填写"}
可见经历要点：${resume.recentExperience || "未提供"}`);
  }

  if (body.context?.selectedText?.trim()) {
    contextNotes.push(`【用户选中的文本】：\n${body.context.selectedText.slice(0, 12_000)}`);
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

  const response = await model.invoke(messages);
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
      ]);
    } catch {
      continuationFailed = true;
      break;
    }
    const addition = responseText(continuation);
    if (!addition.trim() || addition.trim() === rawText.trim()) break;
    rawText = appendContinuation(rawText, addition);
    finishReason = responseFinishReason(continuation);
    continuationCount += 1;
    if (rawText.length === previousLength) break;
  }

  const parsed = parseActionCards(rawText);
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
