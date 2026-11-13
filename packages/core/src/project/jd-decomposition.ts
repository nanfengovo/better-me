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
          rationale: `岗位学历原句为「${jdItem.originalQuote}」，当前教育自述为「${eduStr}」。请本人核对门槛与真实学历；不篡改学历，也不补写未提供的年限、领域或交付成果。`,
          confidence: 0.95,
        });
        continue;
      } else if (eduStr) {
        verifiedCount++;
        alignments.push({
          id: `align-${jdItem.id}`,
          status: "verified_match",
          jdItem,
          rationale: `已提供教育自述「${eduStr}」，仍需本人逐项核对「${jdItem.originalQuote}」的学历、专业与其他限定；文字存在不等同于资格已核实。`,
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
          rationale: `经历「${bestMatch.expOrg} · ${bestMatch.expTitle}」的自述与该要求有较多文字关联；这不是独立核实的实践证明，仍需本人核对实际参与范围。`,
          confidence: Math.min(1, 0.6 + maxOverlap * 0.08),
        });
      } else {
        weakCount++;
        const suggested = bestMatch.text;

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
          rationale: `自述与「${itemKeywords.join(", ") || jdItem.originalQuote}」有文字关联；原句保持不变。请先确认本人动作、实际验证结果与未覆盖范围，再决定是否改写，不强行补数字或架构职责。`,
          confidence: Math.min(1, 0.5 + maxOverlap * 0.06),
        });
      }
    } else if (maxOverlap >= 1.5 && bestMatch) {
      // Partial match: Candidate has relevant tech or task, but expression in resume is weak
      weakCount++;
      const suggested = bestMatch.text;
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
        rationale: `「${bestMatch.expOrg}」的自述仅有部分文字关联，不能据此认定承担过该岗位职责。保留完整原句，请先补充真实参与范围、观察结果与尚未核实之处。`,
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
      question: `岗位学历要求为「${eduGap.jdItem.originalQuote}」。请先说明你已确认的学历与是否满足门槛；若不满足或尚未核实，你会如何如实说明？`,
      category: "education_gap",
      riskLevel: "high",
      coreDefenseStrategy: "先核对本人学历与岗位门槛，不从资料缺失推断学历不足。仅讨论已确认的实践、学习或材料；不承诺未做过的交付、年限或故障指标。",
      suggestedAnswerFramework: [
        "1. 说明已确认的学历事实，未提供或尚待核实的信息保持未知；",
        "2. 如有相关实践，说明个人参与边界和能够提供的原始材料；没有则坦诚说明；",
        "3. 将已完成的学习与未来计划分开，不把计划写成既有能力。"
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
        coreDefenseStrategy: "先区分真实现场经历与假设题。依据已知协议、现场条件和观察证据提出排查顺序；未实践的机制只能作为待验证方案。",
        suggestedAnswerFramework: [
          "1. 说明实际遇到的症状、现场条件和个人负责范围；没有现场经验时明确按假设讨论；",
          "2. 根据实际协议与可用日志说明排查证据，不预设已经使用某个工具或实现某种机制；",
          "3. 将已验证结果、未覆盖风险与下一步验证计划分开。"
        ]
      });
    } else if (isBackend) {
      interviewDefenses.push({
        id: `defense-${defenseIdx++}`,
        targetTopic: "高并发与系统性能保障",
        question: `在设备高频上传或多任务并发调度时，如何保障系统数据一致性与数据库/缓存的稳定性？`,
        category: "deep_tech_dive",
        riskLevel: "medium",
        coreDefenseStrategy: "先说明实际并发场景与个人动作，再依据可引用证据讨论一致性约束、失败情况和方案取舍；没有经验时明确按假设方案讨论。",
        suggestedAnswerFramework: [
          "1. 明确场景、约束和本人实际负责范围，不假设已达到高并发规模；",
          "2. 解释实际方案的取舍与观察证据，未采用的工具只作备选，不写成用过；",
          "3. 说明验证方法、失败样本与尚未覆盖的风险；无可信数字时保留定性结果。"
        ]
      });
    } else if (keywords.length > 0 || item.jdItem.summary.length > 6) {
      interviewDefenses.push({
        id: `defense-${defenseIdx++}`,
        targetTopic: `${keywords.join("/") || item.jdItem.summary.slice(0, 12)} 业务实操`,
        question: `针对岗位要求的「${item.jdItem.originalQuote}」，你是否有相关经历？如有，请说明本人动作与可核对的结果；如无，请明确按假设讨论。`,
        category: "deep_tech_dive",
        riskLevel: "low",
        coreDefenseStrategy: "按背景、任务、本人动作与实际结果组织作答；结果可以是有依据的定性观察，不强制量化，也不把测试或计划升级为生产交付。",
        suggestedAnswerFramework: [
          "1. 明确背景与业务目标；",
          "2. 突出技术难点与个人关键决策；",
          "3. 说明可核对的实际结果与未覆盖范围；没有可信数字或上线证据时不要补写。"
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
    summary: `本次本地分析共拆解 ${allJdItems.length} 项 JD 核心要求。自述文字关联较强 ${verifiedCount} 项，待进一步核对 ${weakCount} 项，暂未发现对应原句 ${gapCount} 项；这些关联不代表独立核实的经历或能力。`,
    defenseQuestions,
    interviewDefenses,
  };
}
