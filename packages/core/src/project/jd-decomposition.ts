import { z } from "zod";
import type { ProjectedResume } from "./resume-projection.js";

export const DecomposedJdItemCategorySchema = z.enum([
  "experience",
  "tech_stack",
  "education",
  "domain",
  "other",
]);
export type DecomposedJdItemCategory = z.infer<typeof DecomposedJdItemCategorySchema>;

export const DecomposedJdSectionSchema = z.enum([
  "responsibility",
  "requirement",
  "preference",
  "constraint",
  "other",
]);
export type DecomposedJdSection = z.infer<typeof DecomposedJdSectionSchema>;

export const DecomposedJdItemSchema = z.object({
  id: z.string(),
  section: DecomposedJdSectionSchema,
  originalQuote: z.string().min(1),
  summary: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  category: DecomposedJdItemCategorySchema.default("other"),
  required: z.boolean().default(true),
});
export type DecomposedJdItem = z.infer<typeof DecomposedJdItemSchema>;

export const DecomposedJdSchema = z.object({
  title: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default(""),
  rawText: z.string(),
  responsibilities: z.array(DecomposedJdItemSchema).default([]),
  hardRequirements: z.array(DecomposedJdItemSchema).default([]),
  preferredQualifications: z.array(DecomposedJdItemSchema).default([]),
  constraints: z.array(DecomposedJdItemSchema).default([]),
  detectedTechStack: z.array(z.string()).default([]),
});
export type DecomposedJd = z.infer<typeof DecomposedJdSchema>;

export const EvidenceMatchStatusSchema = z.enum([
  "verified_match",
  "weak_expression",
  "gap",
]);
export type EvidenceMatchStatus = z.infer<typeof EvidenceMatchStatusSchema>;

export const EvidenceAlignmentItemSchema = z.object({
  id: z.string(),
  status: EvidenceMatchStatusSchema,
  jdItem: DecomposedJdItemSchema,
  matchedClaimId: z.string().optional(),
  matchedExperienceId: z.string().optional(),
  matchedExperienceOrg: z.string().optional(),
  matchedExperienceTitle: z.string().optional(),
  currentResumeText: z.string().optional(),
  suggestedText: z.string().optional(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type EvidenceAlignmentItem = z.infer<typeof EvidenceAlignmentItemSchema>;

export const InterviewDefenseCategorySchema = z.enum([
  "education_gap",
  "experience_gap",
  "deep_tech_dive",
  "scenario_troubleshooting",
]);
export type InterviewDefenseCategory = z.infer<typeof InterviewDefenseCategorySchema>;

export const InterviewDefenseStrategySchema = z.object({
  id: z.string(),
  targetTopic: z.string(),
  question: z.string(),
  category: InterviewDefenseCategorySchema,
  riskLevel: z.enum(["high", "medium", "low"]),
  coreDefenseStrategy: z.string(),
  suggestedAnswerFramework: z.array(z.string()).default([]),
});
export type InterviewDefenseStrategy = z.infer<typeof InterviewDefenseStrategySchema>;

export const JdEvidenceAlignmentReportSchema = z.object({
  decomposedJd: DecomposedJdSchema,
  alignments: z.array(EvidenceAlignmentItemSchema).default([]),
  metrics: z.object({
    matchScore: z.number().min(0).max(100),
    verifiedCount: z.number().int().nonnegative(),
    weakCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    coverageRate: z.number().min(0).max(1),
  }),
  summary: z.string(),
  defenseQuestions: z.array(z.string()).default([]),
  interviewDefenses: z.array(InterviewDefenseStrategySchema).default([]),
});
export type JdEvidenceAlignmentReport = z.infer<typeof JdEvidenceAlignmentReportSchema>;

const TECH_KEYWORDS = [
  "C#", ".NET", "ASP.NET", "WPF", "WinForms", "Java", "Spring", "Spring Boot", "Go", "Golang",
  "Python", "Django", "FastAPI", "Rust", "C++", "TypeScript", "JavaScript", "React",
  "Vue", "Node.js", "Next.js", "Redis", "Kafka", "RabbitMQ", "RocketMQ", "MySQL",
  "PostgreSQL", "SQL Server", "MongoDB", "Elasticsearch", "Docker", "Kubernetes", "K8s",
  "Linux", "CI/CD", "Git", "Microservices", "微服务", "分布式", "高并发", "RPC", "gRPC",
  "DDD", "领域驱动", "架构设计", "性能优化", "RESTful", "WebSocket", "GraphQL",
  "ClickHouse", "TiDB", "Flink", "Spark", "Hadoop", "Hive", "OpenTelemetry", "Prometheus",
  // 工业自动化与制造物联
  "MES", "PLC", "上位机", "工控", "嵌入式", "传感器", "Modbus", "S7", "OPC", "OPC UA",
  "WMS", "WCS", "RCS", "AGV", "AMR", "SCADA", "CAN", "RS485", "串口", "Dapper", "EF Core",
  "ABP", "AI Agent", "RAG", "LLM"
];

function extractKeywords(text: string): string[] {
  const found: string[] = [];
  for (const kw of TECH_KEYWORDS) {
    const kwLower = kw.toLowerCase();
    // exact word boundary or chinese text inclusion
    const regex = new RegExp(`(^|[^a-zA-Z0-9#+])${kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9#+]|$)`, "i");
    if (regex.test(text) || (/[一-龥]/.test(kw) && text.includes(kw))) {
      if (!found.includes(kw)) found.push(kw);
    }
  }
  return found;
}

function cleanBullet(text: string): string {
  return text.replace(/^(\d+[.、)]|[-•*★◆◇■□○●—]\s*)/, "").trim();
}

/**
 * Deterministically parse raw JD text into categorized items with original quotes.
 */
export function decomposeJdText(
  rawText: string,
  metadata?: { title?: string; company?: string; location?: string }
): DecomposedJd {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let currentSection: DecomposedJdSection = "requirement";
  const responsibilities: DecomposedJdItem[] = [];
  const hardRequirements: DecomposedJdItem[] = [];
  const preferredQualifications: DecomposedJdItem[] = [];
  const constraints: DecomposedJdItem[] = [];

  let respIndex = 1;
  let reqIndex = 1;
  let prefIndex = 1;
  let constrIndex = 1;

  for (const line of lines) {
    const isHeading =
      /^(【|\[)?\s*(岗位职责|工作职责|职位职责|主要职责|职责描述|Responsibilities|What you'll do)/i.test(line);
    const isRequirement =
      /^(【|\[)?\s*(任职要求|任职资格|职位要求|基本要求|岗位要求|Qualifications|Requirements|What you'll need)/i.test(line);
    const isPreferenceHeading =
      /^(【|\[)?\s*(加分项|优先条件|优先考虑|优选条件|Preferred|Bonus)/i.test(line);
    const isConstraintHeading =
      /^(【|\[)?\s*(工作地点|工作时间|薪资待遇|福利待遇|学历要求|经验要求|Constraints|Location)/i.test(line);

    if (isHeading) {
      currentSection = "responsibility";
      continue;
    } else if (isRequirement) {
      currentSection = "requirement";
      continue;
    } else if (isPreferenceHeading) {
      currentSection = "preference";
      continue;
    } else if (isConstraintHeading) {
      currentSection = "constraint";
      continue;
    }

    const summary = cleanBullet(line);
    if (!summary || summary.length < 3) continue;

    // Filter out common sub-headers that do not contain actual criteria
    const isSubHeader =
      /^(岗位\d+|教育背景|技术要求.*|专业技能|工作经历|其它说明|公司介绍)[：:]?$/i.test(summary);
    if (isSubHeader) continue;

    const keywords = extractKeywords(line);

    let category: DecomposedJdItemCategory = "other";
    if (/(\d+年|工作经验|项目经验|年限|开发经验)/i.test(line)) {
      category = "experience";
    } else if (keywords.length > 0 || /(语言|框架|数据库|中间件|架构|代码|系统|服务)/i.test(line)) {
      category = "tech_stack";
    } else if (/(本科|硕士|博士|大专|学历|计算机相关专业|毕业)/i.test(line)) {
      category = "education";
    } else if (/(金融|电商|游戏|音视频|医疗|制造|工控|仓储|物流|云原生|安全|供应链|领域)/i.test(line)) {
      category = "domain";
    }

    // Determine actual section: check inline priority/preference
    let itemSection = currentSection;
    if (
      currentSection === "requirement" &&
      (/(优先考虑|者优先|优先录取|有.*优先)/.test(line) || line.endsWith("优先"))
    ) {
      itemSection = "preference";
    }

    const item: DecomposedJdItem = {
      id: "",
      section: itemSection,
      originalQuote: line,
      summary,
      keywords,
      category,
      required: itemSection !== "preference",
    };

    if (itemSection === "responsibility") {
      item.id = `resp-${respIndex++}`;
      responsibilities.push(item);
    } else if (itemSection === "preference") {
      item.id = `pref-${prefIndex++}`;
      preferredQualifications.push(item);
    } else if (itemSection === "constraint") {
      item.id = `constr-${constrIndex++}`;
      constraints.push(item);
    } else {
      item.id = `req-${reqIndex++}`;
      hardRequirements.push(item);
    }
  }

  const allTechStack = Array.from(
    new Set([
      ...responsibilities.flatMap((r) => r.keywords),
      ...hardRequirements.flatMap((r) => r.keywords),
      ...preferredQualifications.flatMap((r) => r.keywords),
    ])
  );

  return {
    title: metadata?.title || "",
    company: metadata?.company || "",
    location: metadata?.location || "",
    rawText,
    responsibilities,
    hardRequirements,
    preferredQualifications,
    constraints,
    detectedTechStack: allTechStack,
  };
}

/**
 * Align decomposed JD items with a projected resume to produce an evidence-backed gap and match report.
 */
export function alignJdWithResume(
  decomposedJd: DecomposedJd,
  resume: ProjectedResume
): JdEvidenceAlignmentReport {
  const alignments: EvidenceAlignmentItem[] = [];

  const allJdItems = [
    ...decomposedJd.hardRequirements,
    ...decomposedJd.responsibilities,
    ...decomposedJd.preferredQualifications,
  ];

  const COMMON_ACTION_TERMS = [
    "单元测试", "需求分析", "技术手册", "接口文档", "现场调试", "试运行",
    "工艺控制", "数据采集", "生产联动", "新技术", "排障", "故障", "稳定性",
    "重连", "上位机", "传感器", "工控机", "死锁", "高并发", "避障", "心跳",
    "性能优化", "软硬件", "落地", "架构", "通讯", "调度", "异常"
  ];

  const allResumeSkills = (resume.skills || []).map((s) => s.toLowerCase());

  const resumeClaims: Array<{
    claimId: string;
    text: string;
    expId: string;
    expOrg: string;
    expTitle: string;
    keywords: string[];
    techStack: string[];
    isQuantified: boolean;
  }> = [];

  for (const exp of resume.experiences) {
    const expTech = (exp.techStack || []).map((t) => t.toLowerCase());
    for (const claim of exp.claims) {
      const claimText = claim.text || "";
      const claimKeywords = extractKeywords(claimText);
      const isQuantified = /\d+(%|倍|万|ms|TPS|QPS|次|个|台|人)/i.test(claimText);
      resumeClaims.push({
        claimId: claim.id,
        text: claimText,
        expId: exp.id,
        expOrg: exp.org || "",
        expTitle: exp.title || "",
        keywords: claimKeywords,
        techStack: expTech,
        isQuantified,
      });
    }
  }

  let verifiedCount = 0;
  let weakCount = 0;
  let gapCount = 0;

  for (const jdItem of allJdItems) {
    // 1. Education specific alignment
    if (jdItem.category === "education") {
      const eduStr = resume.educationSummary || resume.profile?.education || "";
      const reqRequiresDegree = /(本科|硕士|研究生)/.test(jdItem.originalQuote);
      const isJuniorCollege = /(大专|专科)/.test(eduStr);
      if (reqRequiresDegree && isJuniorCollege) {
        gapCount++;
        alignments.push({
          id: `align-${jdItem.id}`,
          status: "gap",
          jdItem,
          rationale: `JD明确要求本科及以上学历，候选人当前学历为大专（${eduStr || "大专"}）。防编造铁律：严禁在简历中篡改学历。建议在求职沟通与面试中，通过强调3年一线核心上位机/MES系统复杂项目落地成果与技术深度来建立信任。`,
          confidence: 0.95,
        });
        continue;
      } else if (eduStr) {
        verifiedCount++;
        alignments.push({
          id: `align-${jdItem.id}`,
          status: "verified_match",
          jdItem,
          rationale: `候选人教育背景（${eduStr}）与职位专业大类契合。`,
          confidence: 0.85,
        });
        continue;
      }
    }

    const itemKeywords = jdItem.keywords;
    let bestMatch: (typeof resumeClaims)[0] | null = null;
    let maxOverlap = 0;

    for (const claim of resumeClaims) {
      let overlap = 0;
      for (const kw of itemKeywords) {
        const kwLower = kw.toLowerCase();
        if (claim.text.toLowerCase().includes(kwLower)) {
          overlap += 2;
        } else if (claim.techStack.includes(kwLower)) {
          overlap += 1.5;
        } else if (allResumeSkills.includes(kwLower)) {
          overlap += 1;
        }
      }

      // Match common engineering action/domain terms
      for (const term of COMMON_ACTION_TERMS) {
        if (jdItem.summary.includes(term) && claim.text.includes(term)) {
          overlap += 1.5;
        }
      }

      // Sentence segment / punctuation token matching
      const summaryTokens = jdItem.summary
        .split(/[\s,，;；、]/)
        .filter((t) => t.length >= 3 && t.length <= 12);
      for (const token of summaryTokens) {
        if (claim.text.includes(token)) overlap += 1;
      }

      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestMatch = claim;
      }
    }

    if (maxOverlap >= 3 && bestMatch) {
      if (bestMatch.isQuantified || maxOverlap >= 4) {
        verifiedCount++;
        alignments.push({
          id: `align-${jdItem.id}`,
          status: "verified_match",
          jdItem,
          matchedClaimId: bestMatch.claimId,
          matchedExperienceId: bestMatch.expId,
          matchedExperienceOrg: bestMatch.expOrg,
          matchedExperienceTitle: bestMatch.expTitle,
          currentResumeText: bestMatch.text,
          rationale: `在经历「${bestMatch.expOrg} · ${bestMatch.expTitle}」中有充分对应的实践证明（匹配度良好）。`,
          confidence: Math.min(1, 0.6 + maxOverlap * 0.08),
        });
      } else {
        weakCount++;
        const suggested = bestMatch.text.includes("。")
          ? `${bestMatch.text}（建议结合 JD 关键要求补充量化产出或架构职责）`
          : `${bestMatch.text}，深度覆盖相关核心机制。`;

        alignments.push({
          id: `align-${jdItem.id}`,
          status: "weak_expression",
          jdItem,
          matchedClaimId: bestMatch.claimId,
          matchedExperienceId: bestMatch.expId,
          matchedExperienceOrg: bestMatch.expOrg,
          matchedExperienceTitle: bestMatch.expTitle,
          currentResumeText: bestMatch.text,
          suggestedText: suggested,
          rationale: `经历库中虽有涉及「${itemKeywords.join(", ") || jdItem.summary.slice(0, 15)}」，但成果呈现较平淡，建议强化关键产出或贴合 JD 语境。`,
          confidence: Math.min(1, 0.5 + maxOverlap * 0.06),
        });
      }
    } else if (maxOverlap >= 1.5 && bestMatch) {
      // Partial match: Candidate has relevant tech or task, but expression in resume is weak
      weakCount++;
      const suggested = `基于${itemKeywords.slice(0, 2).join("/") || "相关工控/系统"}技术，在${bestMatch.expOrg}项目中负责${jdItem.summary.slice(0, 25)}，实现稳定上线与指标提升。`;
      alignments.push({
        id: `align-${jdItem.id}`,
        status: "weak_expression",
        jdItem,
        matchedClaimId: bestMatch.claimId,
        matchedExperienceId: bestMatch.expId,
        matchedExperienceOrg: bestMatch.expOrg,
        matchedExperienceTitle: bestMatch.expTitle,
        currentResumeText: bestMatch.text,
        suggestedText: suggested,
        rationale: `候选人在「${bestMatch.expOrg}」中有相关技术与业务交集，但当前简历描述未明确聚焦该项核心要求，建议一键采纳增强表达。`,
        confidence: 0.65,
      });
    } else {
      gapCount++;
      alignments.push({
        id: `align-${jdItem.id}`,
        status: "gap",
        jdItem,
        rationale: `当前简历经历中未发现对应「${itemKeywords.join(", ") || jdItem.summary.slice(0, 20)}」的明确事实证据。防编造原则：请勿在事实库编造无此经历，可在面试沟通时作为待学习项说明。`,
        confidence: 0.8,
      });
    }
  }

  const total = allJdItems.length || 1;
  const matchScore = Math.round(
    Math.min(100, Math.max(0, ((verifiedCount * 1.0 + weakCount * 0.6) / total) * 100))
  );
  const coverageRate = Math.round(((verifiedCount + weakCount) / total) * 100) / 100;

  const interviewDefenses: InterviewDefenseStrategy[] = [];
  let defenseIdx = 1;

  // 1. Check for education gap (High risk)
  const eduGap = alignments.find(
    (a) => a.jdItem.category === "education" && a.status === "gap"
  );
  if (eduGap) {
    interviewDefenses.push({
      id: `defense-${defenseIdx++}`,
      targetTopic: "学历门槛与工程规范素养",
      question: `岗位明确要求${eduGap.jdItem.summary.includes("本科") ? "统招本科及以上学历" : "更高学历门槛"}，你的履历为大专，如何证明能达到高要求的研发与规范标准？`,
      category: "education_gap",
      riskLevel: "high",
      coreDefenseStrategy: "坦诚交代学历背景不闪烁其词，主打“毕业即深耕工业自动化与上位机一线研发、具备 3 年 0 到 1 复杂调度与 PLC 联调实战交付能力”。以规范的技术设计文档、接口定义习惯与零致命故障交付记录，打消对工程素养与文档规范的疑虑。",
      suggestedAnswerFramework: [
        "1. 坦诚事实：明确承认大专学历背景，展现坦荡与诚信品质；",
        "2. 实操战绩：强调 3 年专注智能制造/上位机一线，独立交付多款核心系统，到岗立即可接手设备通讯与调试；",
        "3. 规范交付：列举主导编写的架构说明书、PLC接口协议与严格单元测试习惯，证明个人工程严谨度完全不输统招本科；",
        "4. 持续学习：说明平时对新技术（如工业AI Agent、现代.NET 8、分布式锁）的主动钻研与自驱力。"
      ]
    });
  }

  // 2. Check for technical gap or weak expression items
  const weakOrGapItems = alignments.filter((a) => a.status !== "verified_match");
  for (const item of weakOrGapItems) {
    if (interviewDefenses.length >= 4) break;
    const keywords = item.jdItem.keywords;
    const isIndustrial = keywords.some((k) =>
      ["PLC", "Modbus", "S7", "MES", "WCS", "RCS", "上位机", "传感器", "工控机"].includes(k)
    );
    const isBackend = keywords.some((k) =>
      ["Redis", "高并发", "SQL Server", "MySQL", "性能优化", "分布式", "微服务"].includes(k)
    );

    if (isIndustrial) {
      interviewDefenses.push({
        id: `defense-${defenseIdx++}`,
        targetTopic: `${keywords.slice(0, 2).join("/") || "工控通讯与排障"} 实战落地`,
        question: `在车间或生产现场上位机与底层设备（如 ${keywords.slice(0, 2).join("/") || "PLC"}）通讯发生偶发性丢包、通信延迟或PLC无响应时，你通常如何排查并设计容错机制？`,
        category: "scenario_troubleshooting",
        riskLevel: "medium",
        coreDefenseStrategy: "物理层、传输层到应用层的分层排障法 + 心跳重连、指数退避、独立采集线程与环形缓存队列防丢包设计。",
        suggestedAnswerFramework: [
          "1. 物理层定界：排查屏蔽层接地、网线/485干扰与终端电阻；",
          "2. 传输与协议层：利用抓包或协议测试工具查看丢包率，采用心跳检测 + 指数退避重试防打崩 PLC；",
          "3. 应用层防御：通信线程与 UI/计算逻辑完全解耦，引入环形队列缓存状态，防止通信阻塞影响实时控制。"
        ]
      });
    } else if (isBackend) {
      interviewDefenses.push({
        id: `defense-${defenseIdx++}`,
        targetTopic: "高并发与系统性能保障",
        question: `在设备高频上传或多任务并发调度时，如何保障系统数据一致性与数据库/缓存的稳定性？`,
        category: "deep_tech_dive",
        riskLevel: "medium",
        coreDefenseStrategy: "削峰缓冲 + 分布式锁消解死锁 + 异步状态机调度 + 数据库索引与执行计划专项优化。",
        suggestedAnswerFramework: [
          "1. 削峰缓冲：高频数据先入内存/Redis缓冲队列，批量定时刷盘；",
          "2. 竞态处理：利用分布式锁或乐观锁确保关键资源调度唯一性；",
          "3. 慢查询优化：分析执行计划，合理设计复合索引，避免全表扫描。"
        ]
      });
    } else if (keywords.length > 0 || item.jdItem.summary.length > 6) {
      interviewDefenses.push({
        id: `defense-${defenseIdx++}`,
        targetTopic: `${keywords.join("/") || item.jdItem.summary.slice(0, 12)} 业务实操`,
        question: `针对岗位要求的「${item.jdItem.summary.slice(0, 28)}」，你在过往项目中是如何落地的？遇到过什么挑战？`,
        category: "deep_tech_dive",
        riskLevel: "low",
        coreDefenseStrategy: "遵循 STAR 法则：阐明背景情境、明确核心挑战、展示具体技术动作与量化业务收益。",
        suggestedAnswerFramework: [
          "1. 明确背景与业务目标；",
          "2. 突出技术难点与个人关键决策；",
          "3. 给出可验证的量化上线成效。"
        ]
      });
    }
  }

  const defenseQuestions = interviewDefenses.map((d) => d.question);

  return {
    decomposedJd,
    alignments,
    metrics: {
      matchScore,
      verifiedCount,
      weakCount,
      gapCount,
      coverageRate,
    },
    summary: `本次分析共拆解 ${allJdItems.length} 项 JD 核心要求。已核实有力证据 ${verifiedCount} 项，表达待增强 ${weakCount} 项，暂未覆盖缺口 ${gapCount} 项。`,
    defenseQuestions,
    interviewDefenses,
  };
}
