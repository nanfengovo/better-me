import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatRequestBody, ChatMessage, AgentActionCard } from "./types.js";

const SYSTEM_PROMPT = `你是一个内置于 BetterMe 个人求职与成长工作台的专属 Agent 职业顾问助手。
你的任务是协助候选人深入分析目标岗位、调研雇主背景、优化简历表达、制定面试应对策略。

你可以执行以下专业任务，并在回答中按规范输出结构化动作卡片（Action Cards）：
1. 查公司资料：分析其控股背景（民营/国企/外企）、业务方向、稳定性及潜在风险。
2. 优化简历细节：针对目标 JD 将口语化、扁平的经历改写为符合 STAR 原则、量化且突出技术难点的 Bullet Point。
3. 岗位匹配与缺口攻防：分析简历在目标岗位的优势与盲区，提供面试应答防守策略。

【输出规范】：
请用专业、诚恳、富有建设性的语气回答用户。
如果你的建议包含可以直接操作的动作，请在正文最后附带一个 JSON 代码块，格式如下（若无动作卡片可不附带）：
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
    "originalText": "建议替换的原文（可选）",
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
注意：正文可使用常规 Markdown 排版，\`\`\`actions 代码块必须是合法 JSON 数组。`;

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
姓名/代号：${resume.displayName || "候选人"}
个人优势/Headline：${resume.headline || "未填写"}
核心技能栈：${resume.skills?.join(", ") || "未填写"}
近期代表经历：${resume.recentExperience || "未提供"}`);
  }

  const systemContent = contextNotes.length > 0
    ? `${SYSTEM_PROMPT}\n\n当前上下文背景信息：\n${contextNotes.join("\n\n")}`
    : SYSTEM_PROMPT;

  const messages: BaseMessage[] = [
    new SystemMessage(systemContent),
    ...body.messages.map((m) => {
      if (m.role === "assistant") return new AIMessage(m.content);
      return new HumanMessage(m.content);
    }),
  ];

  const response = await model.invoke(messages);
  const rawText = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  // Extract ```actions ... ``` block if present
  let cleanContent = rawText;
  let actions: AgentActionCard[] | undefined;

  const actionMatch = rawText.match(/```actions\s*([\s\S]*?)\s*```/);
  if (actionMatch && actionMatch[1]) {
    try {
      const parsed = JSON.parse(actionMatch[1]);
      if (Array.isArray(parsed)) {
        actions = parsed;
        cleanContent = rawText.replace(/```actions\s*[\s\S]*?\s*```/, "").trim();
      }
    } catch {
      // Ignore JSON parse errors in action block
    }
  }

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: "assistant",
    content: cleanContent,
    actions,
    createdAt: new Date().toISOString(),
  };
}
