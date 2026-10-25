import type { CanonicalJob } from "@better-me/opportunities";

export type AiJobRelevanceResult = {
  /** Whether the job title is a generic title lacking the specific tech keyword */
  isGenericTitle: boolean;
  /** Whether the job's description/requirements implicitly match the technical query */
  isImplicitMatch: boolean;
  /** Whether this job was surfaced via AI Tech-Stack Penetration */
  isPenetrated: boolean;
  /** Confidence score between 0 and 100 */
  confidence: number;
  /** Brief punchy badge label: e.g. "🤖 AI技术栈穿透" */
  badgeLabel: string;
  /** Core extracted skills/requirements: e.g. "核心要求: C# · ASP.NET Core" */
  highlightSkillText: string;
  /** Concise explanation: e.g. "岗位名为开发工程师，但任职要求明确精通 C# / ASP.NET Core" */
  reason: string;
  /** Highlighted sentence quote from the JD */
  highlightSnippet?: string;
  /** Extracted list of technical skills found in the JD */
  extractedTechStack: string[];
  /** Category of match */
  matchKind: "direct-title" | "implicit-tech-penetration" | "domain-expanded" | "none";
};

type DomainDefinition = {
  domain: string;
  aliases: string[];
  keyTokens: string[];
  titleSynonyms: string[];
  extractRegex: RegExp;
};

const DOMAIN_DEFINITIONS: DomainDefinition[] = [
  {
    domain: "csharp",
    aliases: ["c#", "csharp", ".net", "dotnet", "asp.net", "wpf", "winform", "winforms", "上位机", "工控上位机"],
    keyTokens: [
      "c#", ".net", "csharp", "dotnet", "asp.net", "asp.net core", ".net core", ".net 6+", ".net 6", ".net 7", ".net 8",
      "wpf", "winforms", "winform", "上位机", "工控上位机", "工控软件", "avalonia", "prism", "mvvm", "xaml",
      "blazor", "entity framework", "ef core", "unity", "unity3d",
    ],
    titleSynonyms: ["c#", ".net", "dotnet", "csharp", "asp.net"],
    extractRegex: /(?:(?<![a-zA-Z0-9_])C#(?![a-zA-Z0-9_])|(?<![a-zA-Z0-9_])\.NET(?:\s*Core)?(?![a-zA-Z0-9_])|\b(?:ASP\.NET(?:\s*Core)?|\.NET\s*[678]\+?|WPF|WinForms?|Avalonia|Prism|MVVM|XAML|Blazor|Entity\s*Framework|EF\s*Core|Unity(?:3D)?)\b)/gi,
  },
  {
    domain: "java",
    aliases: ["java", "spring", "springboot", "spring boot", "springcloud", "spring cloud"],
    keyTokens: ["java", "spring", "spring boot", "springboot", "spring cloud", "mybatis", "jvm", "netty", "dubbo", "hibernate"],
    titleSynonyms: ["java", "spring", "springboot", "jvm"],
    extractRegex: /\b(?:Java|Spring(?:\s*Boot|\s*Cloud)?|MyBatis|JVM|Netty|Dubbo|Hibernate)\b/gi,
  },
  {
    domain: "python",
    aliases: ["python", "django", "flask", "fastapi", "pytorch", "tensorflow", "ai算法", "大模型"],
    keyTokens: ["python", "django", "flask", "fastapi", "pytorch", "tensorflow", "keras", "pandas", "numpy", "langchain", "llm", "大模型", "rag", "agent"],
    titleSynonyms: ["python", "django", "fastapi", "pytorch", "大模型"],
    extractRegex: /\b(?:Python|Django|Flask|FastAPI|PyTorch|TensorFlow|Keras|Pandas|NumPy|LangChain|LLM|RAG|Agent)\b|大模型/gi,
  },
  {
    domain: "cpp",
    aliases: ["c++", "cpp", "qt", "嵌入式"],
    keyTokens: ["c++", "cpp", "qt", "stl", "boost", "linux c++", "音视频", "cuda", "opengl", "嵌入式"],
    titleSynonyms: ["c++", "cpp", "qt", "嵌入式"],
    extractRegex: /(?:(?<![a-zA-Z0-9_])C\+\+(?![a-zA-Z0-9_])|\b(?:CPP|Qt|STL|Boost|CUDA|OpenGL)\b|音视频|嵌入式)/gi,
  },
  {
    domain: "go",
    aliases: ["go", "golang", "k8s", "kubernetes", "云原生"],
    keyTokens: ["go", "golang", "gin", "gorm", "k8s", "kubernetes", "docker", "grpc", "云原生", "微服务"],
    titleSynonyms: ["go", "golang", "k8s", "云原生"],
    extractRegex: /\b(?:Golang|Go语言|Gin|GORM|K8s|Kubernetes|Docker|gRPC)\b|云原生|微服务/gi,
  },
  {
    domain: "frontend",
    aliases: ["前端", "frontend", "react", "vue", "typescript", "javascript"],
    keyTokens: ["react", "vue", "vue3", "typescript", "javascript", "next.js", "nuxt", "tailwind", "webpack", "vite", "h5", "uniapp"],
    titleSynonyms: ["前端", "frontend", "react", "vue", "h5"],
    extractRegex: /\b(?:React|Vue(?:3)?|TypeScript|JavaScript|Next\.js|Nuxt|Vite|Webpack)\b|前端/gi,
  },
];

/**
 * Strips cohort prefixes (2026届, 校招, 0-2年经验等) and department/location suffixes
 * (e.g. "，上海（Manufacturing & Engineering Applications）", "（智能制造团队）")
 * to cleanly evaluate the core professional job title.
 */
export function normalizeCoreJobTitle(rawTitle: string): string {
  let title = (rawTitle || "").trim();
  // Strip bracketed text: e.g. [上海], (智能制造), 【校招】, (Manufacturing & Engineering Applications)
  title = title.replace(/[\[【（(][^\]】）)]*[\]】）)]/gu, " ");
  // Strip trailing locations or department tags after commas, dashes or middots
  title = title.replace(/(?:，|,|·|——|-)\s*[\u4e00-\u9fa5A-Za-z0-9\s/&]+$/gu, "");
  // Strip recruitment & cohort prefixes: e.g. 2026届, 2026届校园招聘-, 校招-, 社招-, 应届生-, 0-2年经验-, 0-2年毕业生-
  title = title.replace(
    /^\s*(?:202[4-9]届(?:[秋春夏季]?校园招聘|校招|毕业生)?|校园招聘|校招|社招|实习生(?:招聘)?|应届生(?:招聘)?|\d+[-~至到]\d+年(?:毕业生|应届生|经验)?)\s*[-_—]?\s*/iu,
    "",
  );
  return title.replace(/\s+/gu, " ").trim();
}

/**
 * Universal evaluation: whether a job title is a broad/generic role name
 * lacking explicit programming language or stack qualifiers.
 */
export function isGenericJobTitle(title: string): boolean {
  const normalized = normalizeCoreJobTitle(title);
  if (!normalized) return true;

  // Broad generic patterns without specific tech qualifiers
  const genericBasePattern =
    /^(?:软件|开发|研发|后台|后端|前端|全栈|应用|系统|算法|数据|AI|人工智能|初级|中级|高级|资深|专家|助理|管培生|核心|业务|平台|项目|测试)?(?:开发|软件|研发|工程|算法)?(?:工程师|专家|骨干|开发员|程序员|专员|技术员|架构师|主管|顾问|Developer|Engineer|Architect)$/i;
  if (genericBasePattern.test(normalized)) {
    return true;
  }

  // Engineering / Developer titles that lack explicit language markers
  if (
    /(?:开发工程师|软件工程师|研发工程师|系统工程师|应用工程师|后端工程师|算法工程师|数据工程师|程序员|Software Engineer|Developer)/i.test(
      normalized,
    )
  ) {
    const hasSpecificTech =
      /(?:c#|\.net|java|python|c\+\+|golang|go语言|rust|vue|react|ios|android|flutter|unity|php)/i.test(
        normalized,
      );
    if (!hasSpecificTech) return true;
  }

  return false;
}

function findMatchingDomain(queryText?: string): DomainDefinition | undefined {
  if (!queryText) return undefined;
  const lower = queryText.trim().toLowerCase();
  for (const def of DOMAIN_DEFINITIONS) {
    if (def.aliases.some((a) => lower === a.toLowerCase() || lower.includes(a.toLowerCase()))) {
      return def;
    }
  }
  return undefined;
}

function extractKeyRequirementSnippet(
  description: string,
  domain: DomainDefinition,
): { snippet?: string; extractedSkills: string[] } {
  if (!description) return { extractedSkills: [] };

  const rawMatches = description.match(domain.extractRegex) || [];
  const normalizedSet = new Set<string>();
  for (const m of rawMatches) {
    const trimmed = m.trim();
    if (trimmed) {
      // Standardize casing
      if (/^c#$/i.test(trimmed)) normalizedSet.add("C#");
      else if (/^\.net$/i.test(trimmed)) normalizedSet.add(".NET");
      else if (/^\.net\s*core$/i.test(trimmed)) normalizedSet.add(".NET Core");
      else if (/^asp\.net(?:\s*core)?$/i.test(trimmed)) normalizedSet.add("ASP.NET Core");
      else if (/^wpf$/i.test(trimmed)) normalizedSet.add("WPF");
      else if (/^winforms?$/i.test(trimmed)) normalizedSet.add("WinForms");
      else normalizedSet.add(trimmed);
    }
  }

  // Also check database & other tech keywords mentioned alongside
  if (/(?:mysql|sql server|postgresql|redis|mongodb)/i.test(description)) {
    const dbs = description.match(/\b(?:MySQL|SQL\s*Server|PostgreSQL|Redis|MongoDB)\b/gi) || [];
    for (const db of dbs) normalizedSet.add(db.trim());
  }

  // Sort skills so core programming languages and frameworks appear first
  const extractedSkills = [...normalizedSet]
    .sort((a, b) => {
      const isCoreA = /^(?:C#|\.NET|\.NET Core|ASP\.NET Core|Java|Python|C\+\+|Go|Golang|React|Vue|TypeScript)$/i.test(a);
      const isCoreB = /^(?:C#|\.NET|\.NET Core|ASP\.NET Core|Java|Python|C\+\+|Go|Golang|React|Vue|TypeScript)$/i.test(b);
      if (isCoreA && !isCoreB) return -1;
      if (!isCoreA && isCoreB) return 1;
      return 0;
    })
    .slice(0, 6);

  // Find the most descriptive sentence containing the tech requirement
  const sentences = description.split(/[\n\r]+|[；;。]/);
  const testPattern = new RegExp(domain.extractRegex.source, "i");
  let bestSentence = "";
  for (const s of sentences) {
    const trimmed = s.trim().replace(/^[•·\-\d.\s]+/, "");
    if (!trimmed) continue;
    const hasDomainTech = testPattern.test(trimmed);
    if (hasDomainTech) {
      if (
        /熟练|精通|熟悉|掌握|经验|职责|要求|负责|使用|基础|深入|规范|框架|语言|平台/i.test(
          trimmed,
        )
      ) {
        bestSentence = trimmed;
        break;
      }
      if (!bestSentence || trimmed.length > bestSentence.length) {
        bestSentence = trimmed;
      }
    }
  }

  let snippet: string | undefined;
  if (bestSentence) {
    snippet = bestSentence.length > 120 ? `${bestSentence.slice(0, 118)}…` : bestSentence;
  }

  return { snippet, extractedSkills };
}

/**
 * AI Agent Semantic Job Relevance & Tech-Stack Penetration Analyzer
 */
export function analyzeAiJobRelevance(
  job: CanonicalJob,
  queryKeyword?: string,
  companyName?: string,
): AiJobRelevanceResult {
  const title = job.title?.value || "";
  const desc = job.description || "";
  const effectiveQuery = (queryKeyword || "").trim();

  const domain = findMatchingDomain(effectiveQuery);

  if (!domain) {
    // If no technical domain recognized, standard pass-through
    const hasTitle = effectiveQuery && title.toLowerCase().includes(effectiveQuery.toLowerCase());
    return {
      isGenericTitle: false,
      isImplicitMatch: false,
      isPenetrated: false,
      confidence: hasTitle ? 95 : 70,
      badgeLabel: "标准匹配",
      highlightSkillText: effectiveQuery,
      reason: hasTitle ? "职位标题直接匹配检索词" : "常规岗位检索",
      extractedTechStack: [],
      matchKind: hasTitle ? "direct-title" : "none",
    };
  }

  // 1. Direct Title Match
  const titleHasDomain = domain.titleSynonyms.some((syn) => {
    const re = new RegExp(`(?:^|[^a-zA-Z0-9_])${syn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-zA-Z0-9_])`, "i");
    return re.test(title);
  });

  if (titleHasDomain) {
    const { extractedSkills } = extractKeyRequirementSnippet(desc, domain);
    return {
      isGenericTitle: false,
      isImplicitMatch: false,
      isPenetrated: false,
      confidence: 99,
      badgeLabel: "显式标题命中",
      highlightSkillText: `标题直属 ${domain.domain.toUpperCase()}`,
      reason: `岗位标题【${title}】已直接标明 ${domain.domain.toUpperCase()} 技术栈。`,
      extractedTechStack: extractedSkills,
      matchKind: "direct-title",
    };
  }

  // 2. Implicit Match (Generic Title + Deep JD Requirement)
  const isGeneric = isGenericJobTitle(title);
  const { snippet, extractedSkills } = extractKeyRequirementSnippet(desc, domain);

  if (extractedSkills.length > 0 || (snippet && snippet.length > 0)) {
    const topSkillsText = extractedSkills.slice(0, 3).join(" · ") || domain.domain.toUpperCase();
    const companyDisplay = companyName ? `${companyName}的` : "";
    const reason = `${companyDisplay}职位名称虽为【${title}】，但任职要求明确指出需熟练运用 ${topSkillsText}，经 AI Agent 技术栈语义穿透识别为强相关岗位。`;

    return {
      isGenericTitle: isGeneric,
      isImplicitMatch: true,
      isPenetrated: true,
      confidence: 96,
      badgeLabel: "🤖 AI 技术栈穿透",
      highlightSkillText: `核心要求: ${topSkillsText}`,
      reason,
      highlightSnippet: snippet ? `“${snippet}”` : undefined,
      extractedTechStack: extractedSkills,
      matchKind: "implicit-tech-penetration",
    };
  }

  // 3. Platform Provenance Match
  const hasProvenance = desc.includes("平台检索意图命中") || desc.includes("检索意图");
  if (hasProvenance) {
    return {
      isGenericTitle: isGeneric,
      isImplicitMatch: true,
      isPenetrated: true,
      confidence: 90,
      badgeLabel: "🤖 AI 意图命中",
      highlightSkillText: `检索意图: ${effectiveQuery}`,
      reason: `原站搜索命中 ${effectiveQuery}，职位原名【${title}】。`,
      extractedTechStack: [effectiveQuery],
      matchKind: "domain-expanded",
    };
  }

  return {
    isGenericTitle: isGeneric,
    isImplicitMatch: false,
    isPenetrated: false,
    confidence: 60,
    badgeLabel: "通用匹配",
    highlightSkillText: effectiveQuery,
    reason: `职位未明确展示 ${effectiveQuery} 专属技术栈。`,
    extractedTechStack: [],
    matchKind: "none",
  };
}
