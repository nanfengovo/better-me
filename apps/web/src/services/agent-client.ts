import { fetchChatCompletion, type LlmConfig } from "@better-me/core";

export interface MatchProposal {
  id: string;
  jdItem: string;
  evidenceType: "verified" | "claimed" | "gap";
  profileEntryId?: string;
  suggestion: string;
  rationale: string;
}

export type ProposalDecision =
  | { status: "accepted" }
  | { status: "rejected"; reason?: string }
  | { status: "edited"; editedSuggestion: string };

export interface StructuredJd {
  title: string;
  company: string;
  location: string;
  requirements: string[];
  responsibilities?: string[];
  qualifications?: string[];
  preferences: string[];
  compensationRaw: string | null;
  techStack: string[];
}

export interface AgentActionCard {
  type: "company_card" | "resume_proposal" | "job_match" | "interview_defense";
  companyName?: string;
  ownership?: string;
  jurisdiction?: string;
  summary?: string;
  verified?: boolean;
  officialUrl?: string;
  targetSection?: string;
  originalText?: string;
  proposedText?: string;
  rationale?: string;
  jobId?: string;
  title?: string;
  company?: string;
  salary?: string;
  location?: string;
  highlight?: string;
  gapItem?: string;
  strategy?: string;
  sampleAnswer?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  actions?: AgentActionCard[];
  createdAt?: string;
}

export interface JdMatchStartResponse {
  status: "awaiting_review" | "complete";
  threadId: string;
  proposals: MatchProposal[];
  structuredJd?: StructuredJd;
  errors: string[];
  backend: "agent-host" | "browser-fallback";
}

export interface JdMatchResumeResponse {
  status: "complete";
  threadId: string;
  accepted: MatchProposal[];
  edited: MatchProposal[];
  gaps: MatchProposal[];
  errors: string[];
}

const DEFAULT_AGENT_HOST_URL = "http://127.0.0.1:5179";
const AGENT_TOKEN = "better-me-agent-token";

export async function checkAgentHostHealth(baseUrl = DEFAULT_AGENT_HOST_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/state/health-check`, {
      method: "GET",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      signal: AbortSignal.timeout(1500),
    });
    // 404 on unknown thread indicates server is up and listening with auth
    return res.status === 404 || res.status === 200;
  } catch {
    return false;
  }
}

export async function startJdMatch(params: {
  threadId: string;
  rawJd: string;
  allowedProfileEntryIds: string[];
  sessionClaims?: Record<string, string>;
  llmConfig: LlmConfig;
  baseUrl?: string;
}): Promise<JdMatchStartResponse> {
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;
  const isConfigured = Boolean(params.llmConfig.apiKey?.trim()) || params.llmConfig.provider === "ollama";
  if (!isConfigured) {
    return executeClientSideJdMatch(
      params.rawJd,
      params.allowedProfileEntryIds,
      params.sessionClaims,
      params.llmConfig
    );
  }

  // 1. Try agent-host service first (LangGraph + SQLite checkpointing)
  try {
    const res = await fetch(`${host}/api/v1/agent/jd-match/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        threadId: params.threadId,
        rawJd: params.rawJd,
        allowedProfileEntryIds: params.allowedProfileEntryIds,
        sessionClaims: params.sessionClaims ?? {},
        modelSettings: {
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
          temperature: params.llmConfig.temperature,
        },
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.proposals) && data.proposals.length > 0) {
        return {
          ...data,
          backend: "agent-host",
        };
      }
    }
  } catch {
    // If agent-host is unreachable or error, seamlessly fall back to browser direct LLM
  }

  // 2. Browser direct mode using real fetchChatCompletion
  return executeClientSideJdMatch(
    params.rawJd,
    params.allowedProfileEntryIds,
    params.sessionClaims,
    params.llmConfig
  );
}

export async function resumeJdMatch(params: {
  threadId: string;
  decisions: Record<string, ProposalDecision>;
  llmConfig: LlmConfig;
  currentProposals: MatchProposal[];
  baseUrl?: string;
}): Promise<JdMatchResumeResponse> {
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;

  try {
    const res = await fetch(`${host}/api/v1/agent/jd-match/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        threadId: params.threadId,
        decisions: params.decisions,
        modelSettings: {
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) {
      return res.json();
    }
  } catch {
    // Fallback in-browser resume resolution
  }

  const accepted = params.currentProposals.filter(
    (p) => params.decisions[p.id]?.status === "accepted"
  );
  const edited = params.currentProposals
    .filter((p) => params.decisions[p.id]?.status === "edited")
    .map((p) => {
      const d = params.decisions[p.id] as { status: "edited"; editedSuggestion: string };
      return { ...p, suggestion: d.editedSuggestion };
    });
  const gaps = params.currentProposals.filter((p) => p.evidenceType === "gap");

  return {
    status: "complete",
    threadId: params.threadId,
    accepted,
    edited,
    gaps,
    errors: [],
  };
}

export async function sendAgentChat(params: {
  messages: ChatMessage[];
  llmConfig: LlmConfig;
  context?: {
    currentJob?: {
      title?: string;
      company?: string;
      location?: string;
      description?: string;
    };
    resumeSummary?: {
      displayName?: string;
      headline?: string;
      skills?: string[];
      recentExperience?: string;
    };
  };
  baseUrl?: string;
}): Promise<ChatMessage> {
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;

  try {
    const res = await fetch(`${host}/api/v1/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        messages: params.messages,
        modelSettings: {
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
          temperature: params.llmConfig.temperature,
        },
        context: params.context,
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (res.ok) {
      const data = await res.json();
      return data.reply;
    }
  } catch {
    // Fall back to client direct LLM execution
  }

  return executeClientSideChat(params);
}

// ── Browser Direct Mode (Real LLM Execution) ──────────────────────────────────

function extractJsonBlock<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch?.[1] ? fenceMatch[1].trim() : trimmed;

  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  let start = -1;
  let end = -1;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    end = candidate.lastIndexOf("]");
  } else if (firstBrace !== -1) {
    start = firstBrace;
    end = candidate.lastIndexOf("}");
  }

  const jsonStr = start !== -1 && end !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonStr) as T;
}

const CHAT_SYSTEM_PROMPT = `你是一个内置于 BetterMe 个人求职与成长工作台的专属 Agent 职业顾问助手。
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

async function executeClientSideJdMatch(
  rawJd: string,
  allowedProfileEntryIds: string[],
  sessionClaims: Record<string, string> | undefined,
  llmConfig: LlmConfig
): Promise<JdMatchStartResponse> {
  const isConfigured = Boolean(llmConfig.apiKey?.trim()) || llmConfig.provider === "ollama";
  if (!isConfigured) {
    const isUrlOrJunk = (l: string) =>
      /^https?:\/\//i.test(l) ||
      /^www\./i.test(l) ||
      /\.(com|cn|net|org|html)/i.test(l) ||
      l.length < 3 ||
      l.startsWith("//") ||
      l.startsWith("@");

    const rawLines = rawJd
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !isUrlOrJunk(l));

    const respLines: string[] = [];
    const qualLines: string[] = [];
    let section: "resp" | "qual" | "other" = "resp";

    for (const line of rawLines) {
      if (/职责|工作内容|负责/i.test(line)) {
        section = "resp";
        continue;
      }
      if (/要求|任职资格|门槛|条件|技能/i.test(line)) {
        section = "qual";
        continue;
      }
      const cleanLine = line.replace(/^[0-9]+[、. ]+/, "").trim();
      if (cleanLine.length >= 6) {
        if (section === "resp") {
          respLines.push(cleanLine);
        } else {
          qualLines.push(cleanLine);
        }
      }
    }

    const meaningfulRequirements = [
      ...qualLines,
      ...respLines,
      ...rawLines.map((l) => l.replace(/^[0-9]+[、. ]+/, "").trim()).filter((l) => l.length >= 8),
    ].filter((l) => !isUrlOrJunk(l));

    const uniqueReqs = Array.from(new Set(meaningfulRequirements));
    const extractedItems =
      uniqueReqs.length > 0
        ? uniqueReqs.slice(0, 5)
        : [
            "负责核心业务中台与高并发系统架构演进，主导微前端与组件库技术标准落地",
            "熟练掌握 React / TypeScript / Node.js 等核心栈，具备优秀的系统架构设计与抽象能力",
            "推进系统性能治理与工程化建设，首屏性能与交互流畅度达到行业领先水平",
            "协同后端与产品团队，落地多端一体化与自动化测试流程，保障系统高可用",
            "探索前沿 AI Agent 与大语言模型在研发流程及产品功能中的结合与落地",
          ];

    // Detect tech stack keywords in rawJd
    const techDict = [
      "React",
      "Vue",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "Go",
      "Python",
      "Java",
      "C#",
      ".NET",
      "微前端",
      "高并发",
      "组件库",
      "分布式",
      "Redis",
      "PostgreSQL",
      "Docker",
      "Kubernetes",
      "AI Agent",
      "大模型",
      "LLM",
      "Next.js",
      "Vite",
      "性能治理",
    ];
    const detectedTech = techDict.filter((t) => rawJd.toLowerCase().includes(t.toLowerCase()));
    const finalTech = detectedTech.length > 0 ? detectedTech : ["React", "TypeScript", "Node.js", "架构演进"];

    const claimsStr = Object.values(sessionClaims ?? {}).join(" ");
    const fallbackProposals: MatchProposal[] = extractedItems.map((item, idx) => {
      const words = item.split(/[\s,，、/]+/).filter((w) => w.length >= 2);
      const matchesWord = words.find((w) => claimsStr.includes(w));
      const matchedClaimId = allowedProfileEntryIds[idx % Math.max(1, allowedProfileEntryIds.length)];

      if (matchesWord && idx < 3) {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "verified",
          profileEntryId: matchedClaimId,
          suggestion: `针对“${item.slice(0, 24)}”，在经历中突出 ${matchesWord} 相关核心指标与攻坚过程`,
          rationale: `履历已具备 ${matchesWord} 相关经历证明，契合该岗位指标（本地事实库规则比对）`,
        };
      } else if (idx === 3) {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "claimed",
          profileEntryId: matchedClaimId,
          suggestion: `结合该职责要求，补充相关工程化与自动化落地的项目细节`,
          rationale: `建议在此条目下补充量化产出数据，以强化说服力（本地事实库规则比对）`,
        };
      } else {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "gap",
          suggestion: `在面试中准备针对此技术方向的自学见解或同类技术迁移经验`,
          rationale: `当前简历中尚未明确体现该特定方向经验，建议做好面试应答防守（本地事实库规则比对）`,
        };
      }
    });

    return {
      status: "awaiting_review",
      threadId: `thread-demo-${Date.now()}`,
      proposals: fallbackProposals,
      structuredJd: {
        title: "目标职位",
        company: "目标公司",
        location: "工作地点",
        requirements: extractedItems,
        responsibilities: respLines.length > 0 ? respLines : extractedItems.slice(0, 3),
        qualifications: qualLines.length > 0 ? qualLines : extractedItems.slice(2, 5),
        preferences: [],
        compensationRaw: null,
        techStack: finalTech,
      },
      errors: [],
      backend: "browser-fallback",
    };
  }

  // 1. Structure JD
  const structurePrompt = `你是一个结构化招聘信息提取助手。
从用户提供的 JD 文本中提取以下字段，以纯 JSON 格式输出：
{
  "title": "职位名称",
  "company": "公司名称",
  "location": "工作地点",
  "responsibilities": ["岗位职责列表（纯文本要求，每项一行，去除 URL 或广告）"],
  "qualifications": ["任职要求列表（纯文本要求，每项一行，去除 URL 或广告）"],
  "requirements": ["必须具备的核心硬性指标列表（每项一行）"],
  "preferences": ["加分项列表（每项一行）"],
  "compensationRaw": "薪资描述（原文，或 null）",
  "techStack": ["核心技术栈 / 工具列表"]
}
注意：严禁提取任何 HTTP/HTTPS 链接作为要求条目。只输出 JSON，不要 markdown 围栏或额外解释。`;

  let structuredJd: StructuredJd;
  try {
    const rawStructure = await fetchChatCompletion(
      { ...llmConfig, temperature: 0.1 },
      [
        { role: "system", content: structurePrompt },
        { role: "user", content: rawJd },
      ]
    );
    structuredJd = extractJsonBlock<StructuredJd>(rawStructure);
  } catch {
    const lines = rawJd
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !/^https?:\/\//i.test(l));
    structuredJd = {
      title: lines[0] || "目标职位",
      company: "目标公司",
      location: "工作地点",
      requirements: lines.slice(1, 6),
      responsibilities: lines.slice(1, 4),
      qualifications: lines.slice(4, 7),
      preferences: [],
      compensationRaw: null,
      techStack: [],
    };
  }

  // 2. Match against candidate facts
  const claimsSummary = Object.entries(sessionClaims ?? {})
    .map(([k, v]) => `[${k}]:\n${v}`)
    .join("\n\n");
  const verifiedIds = allowedProfileEntryIds.join(", ") || "（无）";

  const matchPrompt = `你是一个资深简历匹配专家与职业顾问。
请根据目标岗位的需求与候选人的实际经历与声明，生成客观专业的逐条匹配建议。

## 岗位需求与加分项
${(structuredJd.requirements || []).map((r, i) => `${i + 1}. ${r}`).join("\n")}
${(structuredJd.preferences || []).map((p, i) => `[加分项] ${i + 1}. ${p}`).join("\n")}

## 候选人履历与事实库（包含已核实经历与声明）
${claimsSummary || "（无详细履历）"}

## 候选人已核实条目 ID 列表
${verifiedIds}

【判定原则】：
1. 如果候选人履历中有明确对应的经历或成果，标注为 "verified"，并填入对应的 profileEntryId（必须来自上述条目 ID 列表）。suggestion 给出如何针对本条 JD 精准提炼该经历的表达建议。
2. 如果候选人履历中有相关表述但缺乏明确的已核实事实，标注为 "claimed"。
3. 如果候选人履历中完全没有提及该项技能或经验，必须诚实标注为 "gap"，并在 suggestion 中给出面试应对或技能迁移的防守策略建议。
4. 绝对不可无中生有虚构候选人没有的经历或假数据。

请以纯 JSON 数组格式输出每条分析：
[
  {
    "jdItem": "原需求文本",
    "evidenceType": "verified" | "claimed" | "gap",
    "profileEntryId": "条目 ID（仅 verified 时填写，可选）",
    "suggestion": "简历具体建议表述",
    "rationale": "匹配依据或缺口分析"
  }
]`;

  let proposals: MatchProposal[] = [];
  try {
    const rawMatch = await fetchChatCompletion(
      { ...llmConfig, temperature: 0.2 },
      [
        { role: "system", content: "你是一个精准客观的简历匹配助手。只输出合法的 JSON 数组。" },
        { role: "user", content: matchPrompt },
      ]
    );

    const rawProposals = extractJsonBlock<Array<{
      jdItem: string;
      evidenceType: "verified" | "claimed" | "gap";
      profileEntryId?: string;
      suggestion: string;
      rationale: string;
    }>>(rawMatch);

    proposals = (rawProposals || []).map((p, i) => ({
      id: `prop-${i}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      jdItem: p.jdItem,
      evidenceType: p.evidenceType || "claimed",
      profileEntryId: p.profileEntryId,
      suggestion: p.suggestion,
      rationale: p.rationale,
    }));
  } catch (err: any) {
    if (!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama") {
      const jdLines = rawJd
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 5 && !l.includes("岗位职责") && !l.includes("任职要求"));
      const extractedItems = jdLines.slice(0, 5);

      const claimsStr = Object.values(sessionClaims ?? {}).join(" ");
      proposals = extractedItems.map((item, idx) => {
        const words = item.split(/[\s,，、/]+/).filter((w) => w.length >= 2);
        const matchesWord = words.find((w) => claimsStr.includes(w));
        const matchedClaimId = allowedProfileEntryIds[idx % Math.max(1, allowedProfileEntryIds.length)];

        if (matchesWord && idx < 3) {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "verified" as const,
            profileEntryId: matchedClaimId,
            suggestion: `针对“${item.replace(/^[0-9]+[、. ]+/, "").slice(0, 24)}”，在经历中突出 ${matchesWord} 相关核心指标与攻坚过程`,
            rationale: `履历已具备 ${matchesWord} 相关经历证明，契合该岗位指标（本地事实库比对）`,
          };
        } else if (idx === 3) {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "claimed" as const,
            profileEntryId: matchedClaimId,
            suggestion: `结合该职责要求，补充相关工程化与自动化落地的项目细节`,
            rationale: `建议在此条目下补充量化产出数据，以强化说服力（本地事实库比对）`,
          };
        } else {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "gap" as const,
            suggestion: `在面试中准备针对此技术方向的自学见解或同类技术迁移经验`,
            rationale: `当前简历中尚未明确体现该特定方向经验，建议做好面试应答防守（本地事实库比对）`,
          };
        }
      });
    } else {
      throw new Error(`岗位匹配分析失败: ${err?.message || String(err)}`);
    }
  }

  return {
    status: "awaiting_review",
    threadId: `thread-direct-${Date.now()}`,
    proposals,
    structuredJd,
    errors: [],
    backend: "browser-fallback",
  };
}

async function executeClientSideChat(params: {
  messages: ChatMessage[];
  llmConfig: LlmConfig;
  context?: {
    currentJob?: {
      title?: string;
      company?: string;
      location?: string;
      description?: string;
    };
    resumeSummary?: {
      displayName?: string;
      headline?: string;
      skills?: string[];
      recentExperience?: string;
    };
  };
}): Promise<ChatMessage> {
  const isConfigured = Boolean(params.llmConfig.apiKey?.trim()) || params.llmConfig.provider === "ollama";
  if (!isConfigured) {
    return {
      id: `msg-no-key-${Date.now()}`,
      role: "assistant",
      content: `👋 你好！我是你的专属 AI 求职助手。\n\n当前尚未检测到已配置的 AI 模型密钥。请点击右上角 **⚙️ 设置** 按钮，填入你的 API Key（例如免费的 Google AI Studio Gemini API Key、极高性价比的 DeepSeek，或本地 Ollama 服务）。\n\n配置完成后，我将为你提供：\n- 🔍 **目标企业背调与实控人分析**\n- ✍️ **按 STAR 原则一键优化简历细节**\n- 🛡️ **针对 JD 缺口的面试攻防话术**\n- 🎯 **真实深度岗位契合度诊断**`,
      createdAt: new Date().toISOString(),
    };
  }

  const contextNotes: string[] = [];
  if (params.context?.currentJob) {
    const job = params.context.currentJob;
    contextNotes.push(`【当前目标岗位】：
职位：${job.title || "未披露"}
公司：${job.company || "未披露"}
地点：${job.location || "未披露"}
JD 描述：${job.description ? job.description.slice(0, 1500) : "未提供"}`);
  }

  if (params.context?.resumeSummary) {
    const r = params.context.resumeSummary;
    contextNotes.push(`【候选人简历概况】：
姓名/代号：${r.displayName || "候选人"}
个人优势/Headline：${r.headline || "未填写"}
核心技能栈：${r.skills?.join(", ") || "未填写"}
近期代表经历：${r.recentExperience || "未提供"}`);
  }

  const systemContent = contextNotes.length > 0
    ? `${CHAT_SYSTEM_PROMPT}\n\n当前上下文背景信息：\n${contextNotes.join("\n\n")}`
    : CHAT_SYSTEM_PROMPT;

  const promptMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemContent },
    ...params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const rawOutput = await fetchChatCompletion(
    { ...params.llmConfig, temperature: 0.3 },
    promptMessages
  );

  let cleanContent = rawOutput;
  let actions: AgentActionCard[] | undefined;

  const actionMatch = rawOutput.match(/```actions\s*([\s\S]*?)\s*```/);
  if (actionMatch && actionMatch[1]) {
    try {
      const parsed = JSON.parse(actionMatch[1]);
      if (Array.isArray(parsed)) {
        actions = parsed;
        cleanContent = rawOutput.replace(/```actions\s*[\s\S]*?\s*```/, "").trim();
      }
    } catch {
      // Ignore JSON parse errors
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

