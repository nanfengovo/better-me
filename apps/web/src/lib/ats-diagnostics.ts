/**
 * Deterministic, zero-LLM, 100% local ATS & Writing Craft Diagnostic Engine.
 * Inspired by Resume-Matcher's deterministic ats.py + writing_quality.py,
 * adapted for bilingual (Chinese & English) resumes with zero network calls.
 */

export type DiagnosticSeverity = "pass" | "warn" | "critical";

export interface BilingualText {
  zh: string;
  en: string;
}

export interface AtsDimension {
  id: "sections" | "dates" | "impact" | "writing" | "parsability" | "keywords";
  label: BilingualText;
  score: number;
  weight: number;
  summary: BilingualText;
}

export interface AtsFinding {
  id: string;
  severity: DiagnosticSeverity;
  category: AtsDimension["id"];
  title: BilingualText;
  detail: BilingualText;
}

export interface AtsDiagnosticReport {
  overallScore: number;
  verdict: BilingualText;
  wordCount: number;
  charCount: number;
  bulletCount: number;
  quantifiedBulletCount: number;
  dimensions: AtsDimension[];
  findings: AtsFinding[];
  matchedKeywords: string[];
  missingKeywords: string[];
  titleAlignment: number | null;
  dateFormatsFound: string[];
}

export interface AtsDiagnosticInput {
  resumeText: string;
  jdText?: string;
  targetRole?: string;
}

const SECTION_PATTERNS: Record<"experience" | "education" | "skills" | "summary", RegExp> = {
  summary: /(?:^|\n)\s*(?:#{1,4}\s*)?(?:summary|profile|objective|about|个人简介|个人概况|自我评价|核心优势|职业定位)\b/i,
  experience: /(?:^|\n)\s*(?:#{1,4}\s*)?(?:experience|work\s+history|employment|projects?|工作经历|工作经验|实习经历|项目经历|项目与作品)/i,
  education: /(?:^|\n)\s*(?:#{1,4}\s*)?(?:education|academic|degree|教育背景|教育经历|学历)/i,
  skills: /(?:^|\n)\s*(?:#{1,4}\s*)?(?:skills?|technologies|tech\s+stack|competencies|专业技能|技术栈|核心技能)/i,
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?(?:1[3-9]\d{9}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/;
const URL_RE = /https?:\/\/[^\s)]+|github\.com\/[A-Za-z0-9_.-]+|linkedin\.com\/in\/[A-Za-z0-9_.-]+/i;

const DATE_PATTERNS: Array<{ id: string; label: string; regex: RegExp }> = [
  { id: "iso-ym", label: "YYYY-MM", regex: /\b(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])\b/g },
  { id: "dot-ym", label: "YYYY.MM", regex: /\b(?:19|20)\d{2}\.(?:0?[1-9]|1[0-2])\b/g },
  { id: "slash-ym", label: "YYYY/MM", regex: /\b(?:19|20)\d{2}\/(?:0?[1-9]|1[0-2])\b/g },
  { id: "zh-ym", label: "YYYY年MM月", regex: /(?:19|20)\d{2}\s*年\s*(?:0?[1-9]|1[0-2])\s*月/g },
  {
    id: "en-mon-y",
    label: "Mon YYYY",
    regex: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+(?:19|20)\d{2}\b/gi,
  },
];

const WEAK_OPENER_EN_RE =
  /^\s*(?:[-*•·]\s*)?(?:responsible for|helped with|helped to|helped|assisted with|assisted in|assisted|involved in|participated in|worked on|tasked with|duties included|in charge of)\b/i;

const WEAK_OPENER_ZH_RE =
  /^\s*(?:[-*•·]\s*)?(?:主要负责|负责日常|参与了|参与|协助完成|协助|配合完成|配合|帮忙)/;

const AI_BUZZWORDS_EN = [
  "leveraged",
  "spearheaded",
  "synergy",
  "cutting-edge",
  "results-driven",
  "passionate about",
  "dynamic professional",
  "best-in-class",
  "game-changing",
  "thought leader",
];

const AI_BUZZWORDS_ZH = [
  "深度赋能",
  "全面赋能",
  "重要抓手",
  "打造闭环",
  "极大提升",
  "显著赋能",
  "高度负责",
];

const FIRST_PERSON_EN_RE = /\b(?:I|me|my|mine|myself)\b/g;
const FIRST_PERSON_ZH_RE = /(?:本人|我负责|我主导|我参与)/g;

const QUANT_METRIC_RE =
  /(?:\d+(?:\.\d+)?\s*(?:%|倍|x|X|ms|s|秒|分钟|小时|天|万|千|亿|k|K|M|B|GB|MB|TB|QPS|TPS|RPS|人|台|套|条|个|项|次|元|\+))|(?:(?:降低|提升|缩短|减少|增长|提高|优化|节省|支撑|覆盖|服务)\D{0,6}\d+)/;

const EN_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "will", "have", "are", "you", "our",
  "all", "not", "can", "into", "more", "than", "over", "also", "other", "such", "about", "using",
  "work", "working", "team", "teams", "role", "position", "experience", "years", "year", "strong",
  "good", "ability", "skills", "skill", "requirements", "responsibilities", "preferred", "required",
  "including", "across", "build", "building", "develop", "developing", "design", "designing",
  "system", "systems", "software", "engineer", "engineering", "senior", "junior", "staff", "lead",
  "company", "product", "products", "business", "services", "service", "platform", "platforms",
  "must", "plus", "bonus", "nice", "high", "large", "scale", "code", "quality", "best", "practices",
  "communication", "collaboration", "problem", "solving", "degree", "computer", "science", "related",
  "field", "equivalent", "based", "location", "remote", "hybrid", "full", "time", "salary", "benefits",
]);

const ZH_STOPWORDS = new Set([
  "岗位职责", "任职要求", "职位描述", "工作内容", "加分项", "优先考虑", "本科及以上", "大专及以上",
  "计算机相关", "相关专业", "年以上", "工作经验", "开发经验", "具备良好", "良好的", "沟通能力",
  "团队协作", "责任心", "抗压能力", "学习能力", "熟练掌握", "熟悉常用", "精通至少", "独立完成",
  "负责公司", "参与系统", "能够独立", "具有较强", "有良好的", "优先录用", "薪资面议", "五险一金",
]);

const KNOWN_TECH_TERMS = [
  "TypeScript", "JavaScript", "React", "Next.js", "Vue", "Angular", "Svelte", "Node.js", "Deno",
  "Python", "FastAPI", "Django", "Flask", "Go", "Golang", "Rust", "Java", "Spring Boot", "Kotlin",
  "C#", ".NET", "ASP.NET Core", "EF Core", "C++", "SQL", "PostgreSQL", "MySQL", "SQLite", "MongoDB",
  "Redis", "Kafka", "RabbitMQ", "Elasticsearch", "ClickHouse", "GraphQL", "gRPC", "REST", "WebSocket",
  "Docker", "Kubernetes", "K8s", "Terraform", "CI/CD", "GitHub Actions", "Linux", "Nginx",
  "AWS", "GCP", "Azure", "Cloudflare", "Playwright", "Vitest", "Jest", "Pytest", "Tailwind",
  "Electron", "WebAssembly", "Three.js", "WebGL", "WebGPU", "PyTorch", "TensorFlow", "LLM", "RAG",
  "Agent", "MCP", "LangChain", "OpenTelemetry", "Prometheus", "Grafana", "Prisma", "Drizzle",
  "Microservices", "Distributed Systems", "Event-Driven", "RBAC", "OAuth", "OIDC", "JWT",
  "Modbus", "OPC UA", "PLC", "MES", "WMS", "WCS", "RCS", "AGV", "AMR", "ROS", "ROS2",
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(haystackLower: string, keyword: string): boolean {
  const kwLower = keyword.toLowerCase();
  if (/[\u4e00-\u9fa5]/.test(kwLower)) {
    return haystackLower.includes(kwLower);
  }
  // For short or symbol-heavy tech names like C#, .NET, Go, K8s
  const boundaryPattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(kwLower)}(?![a-z0-9])`, "i");
  return boundaryPattern.test(haystackLower);
}

function extractJdKeywords(jdText: string): string[] {
  const found: string[] = [];
  const seenLower = new Set<string>();
  const jdLower = jdText.toLowerCase();

  const push = (term: string) => {
    const clean = term.trim();
    const key = clean.toLowerCase();
    if (!clean || clean.length < 2 || seenLower.has(key)) return;
    if (EN_STOPWORDS.has(key) || ZH_STOPWORDS.has(clean)) return;
    seenLower.add(key);
    found.push(clean);
  };

  // 1. Canonical multi-word & symbol-heavy tech stack terms
  for (const term of KNOWN_TECH_TERMS) {
    if (containsKeyword(jdLower, term)) push(term);
  }

  // 2. Remaining capitalized / technical English tokens (e.g. Kubernetes, GraphQL, Airflow)
  const enTokens = jdText.match(/\b[A-Za-z][A-Za-z0-9+#.-]{2,24}\b/g) ?? [];
  const enFreq = new Map<string, { display: string; count: number }>();
  for (const raw of enTokens) {
    const clean = raw.replace(/[.,;:]+$/, "");
    const lower = clean.toLowerCase();
    if (clean.length < 3 || EN_STOPWORDS.has(lower) || /^\d+$/.test(clean)) continue;
    const isLikelyTech = /[A-Z0-9+#.]/.test(clean.slice(1)) || /^[A-Z]{2,}$/.test(clean);
    const prev = enFreq.get(lower);
    enFreq.set(lower, { display: prev?.display ?? clean, count: (prev?.count ?? 0) + (isLikelyTech ? 2 : 1) });
  }
  for (const [, entry] of [...enFreq.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (found.length >= 22) break;
    if (entry.count >= 2) push(entry.display);
  }

  // 3. Domain Chinese nouns (2-6 chars) excluding leading particles/prepositions
  const zhChunks = jdText.match(/[^\s，。、；：（）()与和及的为在对等并将把被向从\da-zA-Z]{2,5}(?:架构|引擎|调度|算法|平台|安全|优化|并发|分布式|微服务|可视化|测试|自动化|数据库|中间件|大模型|智能体|提示词|向量|检索|协议|通信)/g) ?? [];
  for (const chunk of zhChunks) {
    if (found.length >= 26) break;
    const cleaned = chunk.replace(/^[与和及的为在对等并将把被向从]+/, "");
    if (cleaned.length >= 3 && cleaned.length <= 7 && /^[\u4e00-\u9fa5]+$/.test(cleaned)) push(cleaned);
  }

  return found.slice(0, 24);
}

function extractBullets(resumeText: string): string[] {
  const lines = resumeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicitBullets = lines.filter((line) => /^(?:[-*•·▪▸]|\d+[.)、])\s*\S/.test(line));
  if (explicitBullets.length >= 3) return explicitBullets;
  // Fallback: sentences longer than 18 chars that are not headings/contacts
  return lines.filter(
    (line) =>
      line.length >= 18 &&
      !/^#{1,6}\s/.test(line) &&
      !EMAIL_RE.test(line) &&
      !PHONE_RE.test(line),
  );
}

function computeTitleAlignment(resumeText: string, targetRole?: string): number | null {
  const role = targetRole?.trim();
  if (!role) return null;
  const lines = resumeText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const topLines = lines.slice(0, 6).join(" ").toLowerCase();
  const fullLower = resumeText.toLowerCase();
  const roleLower = role.toLowerCase();

  if (topLines.includes(roleLower)) return 100;
  if (fullLower.includes(roleLower)) return 75;

  const tokens = roleLower
    .split(/[\s/·,，、()（）-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !EN_STOPWORDS.has(t));
  if (!tokens.length) return null;
  const matched = tokens.filter((t) => fullLower.includes(t)).length;
  return Math.round((matched / tokens.length) * 60);
}

export function diagnoseAtsResume(input: AtsDiagnosticInput): AtsDiagnosticReport {
  const raw = input.resumeText ?? "";
  const trimmed = raw.trim();
  const jdTrimmed = (input.jdText ?? "").trim();

  if (!trimmed) {
    return {
      overallScore: 0,
      verdict: { zh: "粘贴简历文本以开始本地诊断", en: "Paste resume text to run local diagnostics" },
      wordCount: 0,
      charCount: 0,
      bulletCount: 0,
      quantifiedBulletCount: 0,
      dimensions: [],
      findings: [],
      matchedKeywords: [],
      missingKeywords: [],
      titleAlignment: null,
      dateFormatsFound: [],
    };
  }

  const findings: AtsFinding[] = [];
  const charCount = trimmed.replace(/\s+/g, "").length;
  const enWords = (trimmed.match(/[A-Za-z0-9+#.-]+/g) ?? []).length;
  const zhChars = (trimmed.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const wordCount = enWords + zhChars;

  // ── 1. Section Completeness ──
  const hasEmail = EMAIL_RE.test(trimmed);
  const hasPhoneOrLink = PHONE_RE.test(trimmed) || URL_RE.test(trimmed);
  const hasExperience = SECTION_PATTERNS.experience.test(trimmed);
  const hasSkills = SECTION_PATTERNS.skills.test(trimmed);
  const hasEducation = SECTION_PATTERNS.education.test(trimmed);
  const hasSummary = SECTION_PATTERNS.summary.test(trimmed);

  const sectionChecks = [
    { ok: hasEmail, weight: 20, zh: "电子邮箱", en: "Email address" },
    { ok: hasPhoneOrLink, weight: 15, zh: "电话或个人主页链接", en: "Phone or portfolio link" },
    { ok: hasExperience, weight: 25, zh: "工作 / 项目经历分节", en: "Experience / Projects heading" },
    { ok: hasSkills, weight: 20, zh: "专业技能分节", en: "Skills heading" },
    { ok: hasEducation, weight: 15, zh: "教育背景分节", en: "Education heading" },
    { ok: hasSummary, weight: 5, zh: "个人简介 / 核心优势", en: "Summary / Profile heading" },
  ];
  const sectionsScore = sectionChecks.reduce((acc, item) => acc + (item.ok ? item.weight : 0), 0);
  const missingSections = sectionChecks.filter((c) => !c.ok);

  if (missingSections.length === 0) {
    findings.push({
      id: "sections-complete",
      severity: "pass",
      category: "sections",
      title: { zh: "核心结构完整，ATS 可直接识别分节", en: "Core resume sections are complete" },
      detail: {
        zh: "已检测到联系方式、工作/项目经历、专业技能、教育背景与概况标题。",
        en: "Detected contact info, experience/projects, skills, education, and summary headings.",
      },
    });
  } else {
    findings.push({
      id: "sections-missing",
      severity: !hasEmail || !hasExperience ? "critical" : "warn",
      category: "sections",
      title: {
        zh: `缺少 ${missingSections.length} 项标准分节或联系信息`,
        en: `Missing ${missingSections.length} standard section or contact field(s)`,
      },
      detail: {
        zh: `建议补齐：${missingSections.map((m) => m.zh).join("、")}，使用标准标题名称方便 ATS 抽取。`,
        en: `Consider adding: ${missingSections.map((m) => m.en).join(", ")} using standard headings.`,
      },
    });
  }

  // ── 2. Date Consistency ──
  const dateCounts = new Map<string, number>();
  let totalDates = 0;
  for (const style of DATE_PATTERNS) {
    const matches = trimmed.match(style.regex);
    if (matches && matches.length > 0) {
      dateCounts.set(style.label, matches.length);
      totalDates += matches.length;
    }
  }
  const dateFormatsFound = [...dateCounts.keys()];
  let datesScore: number;
  if (totalDates < 2) {
    datesScore = 70;
    findings.push({
      id: "dates-sparse",
      severity: "warn",
      category: "dates",
      title: { zh: "未检测到足够的起止时间", en: "Too few date ranges detected" },
      detail: {
        zh: "ATS 通常依据任职起止时间计算工作年限，建议使用统一的 YYYY-MM 格式标明每段经历时间。",
        en: "ATS parsers compute tenure from dates. Include consistent start/end dates (e.g. YYYY-MM or Mon YYYY).",
      },
    });
  } else if (dateFormatsFound.length === 1) {
    datesScore = 100;
    findings.push({
      id: "dates-consistent",
      severity: "pass",
      category: "dates",
      title: { zh: `日期格式完全统一（${dateFormatsFound[0]}）`, en: `Consistent date format (${dateFormatsFound[0]})` },
      detail: {
        zh: `共检测到 ${totalDates} 处日期，全部采用同一格式，解析器可准确计算工龄。`,
        en: `All ${totalDates} detected dates use the same format for reliable tenure parsing.`,
      },
    });
  } else {
    const dominant = Math.max(...dateCounts.values());
    datesScore = Math.round((dominant / totalDates) * 100);
    findings.push({
      id: "dates-mixed",
      severity: "warn",
      category: "dates",
      title: {
        zh: `检测到 ${dateFormatsFound.length} 种混用日期格式`,
        en: `Mixed date formats detected (${dateFormatsFound.join(", ")})`,
      },
      detail: {
        zh: `当前混用了 ${dateFormatsFound.join(" / ")}，建议全文统一为一种格式（推荐 YYYY-MM）。`,
        en: `Found ${dateFormatsFound.join(" and ")}. Standardize on a single format across every role.`,
      },
    });
  }

  // ── 3. Quantified Impact ──
  const bullets = extractBullets(trimmed);
  const quantifiedBullets = bullets.filter((b) => QUANT_METRIC_RE.test(b));
  const quantRatio = bullets.length > 0 ? quantifiedBullets.length / bullets.length : 0;
  const impactScore =
    bullets.length === 0
      ? 35
      : Math.min(100, Math.round(Math.min(quantRatio / 0.5, 1) * 80 + (quantifiedBullets.length >= 3 ? 20 : quantifiedBullets.length * 6)));

  if (bullets.length === 0) {
    findings.push({
      id: "impact-no-bullets",
      severity: "warn",
      category: "impact",
      title: { zh: "未识别到分条要点（Bullet points）", en: "No bullet points detected" },
      detail: {
        zh: "建议使用 `- ` 分条罗列关键产出与结果，避免整段大文本堆积。",
        en: "Use concise bullet points (`- `) rather than dense paragraphs for faster recruiter scanning.",
      },
    });
  } else if (quantRatio >= 0.4) {
    findings.push({
      id: "impact-strong",
      severity: "pass",
      category: "impact",
      title: {
        zh: `量化成果占比良好（${quantifiedBullets.length} / ${bullets.length} 条）`,
        en: `Strong quantified impact (${quantifiedBullets.length} of ${bullets.length} bullets)`,
      },
      detail: {
        zh: "要点中包含具体的数字、比例或规模指标；请确保所有数字均有真实基线支撑。",
        en: "Bullets include concrete numbers and scale. Verify each metric has a real baseline.",
      },
    });
  } else {
    findings.push({
      id: "impact-low",
      severity: "warn",
      category: "impact",
      title: {
        zh: `量化成果偏少（${quantifiedBullets.length} / ${bullets.length} 条含具体数字）`,
        en: `Low quantified evidence (${quantifiedBullets.length} of ${bullets.length} bullets have numbers)`,
      },
      detail: {
        zh: "优先为最核心的 3–5 条经历补齐真实规模、耗时变化或对比基线（绝不虚构）。",
        en: "Add verified scale, latency, or before/after baselines to your top 3–5 bullets without fabricating.",
      },
    });
  }

  // ── 4. Writing Craft (Resume-Matcher writing_quality.py inspired) ──
  const weakOpeners = bullets.filter((b) => WEAK_OPENER_EN_RE.test(b) || WEAK_OPENER_ZH_RE.test(b));
  const lowerFull = trimmed.toLowerCase();
  const buzzwordsFound = [
    ...AI_BUZZWORDS_EN.filter((phrase) => lowerFull.includes(phrase)),
    ...AI_BUZZWORDS_ZH.filter((phrase) => trimmed.includes(phrase)),
  ];
  const firstPersonCount =
    (trimmed.match(FIRST_PERSON_EN_RE) ?? []).length + (trimmed.match(FIRST_PERSON_ZH_RE) ?? []).length;
  const longBullets = bullets.filter((b) => {
    const zhLen = (b.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const enLen = (b.match(/[A-Za-z0-9]+/g) ?? []).length;
    return zhLen > 95 || enLen > 38;
  });

  let writingScore = 100;
  writingScore -= Math.min(35, weakOpeners.length * 10);
  writingScore -= Math.min(30, buzzwordsFound.length * 12);
  writingScore -= Math.min(20, firstPersonCount * 6);
  writingScore -= Math.min(20, longBullets.length * 6);
  writingScore = Math.max(15, writingScore);

  if (weakOpeners.length > 0) {
    findings.push({
      id: "writing-weak-openers",
      severity: "warn",
      category: "writing",
      title: {
        zh: `${weakOpeners.length} 条要点以被动/泛化动词开头`,
        en: `${weakOpeners.length} bullet(s) start with passive or vague openers`,
      },
      detail: {
        zh: "如「负责 / 参与 / 协助 / Responsible for / Worked on」，建议改为「设计 / 重构 / 交付 / Built / Reduced」等具体动作。",
        en: "Replace openers like 'Responsible for' or 'Worked on' with concrete ownership verbs (Built, Designed, Reduced).",
      },
    });
  }
  if (buzzwordsFound.length > 0) {
    findings.push({
      id: "writing-buzzwords",
      severity: "warn",
      category: "writing",
      title: {
        zh: `检测到 ${buzzwordsFound.length} 处空泛套话 / AI 腔高频词`,
        en: `Detected ${buzzwordsFound.length} hollow buzzword(s) / AI clichés`,
      },
      detail: {
        zh: `命中词：${buzzwordsFound.slice(0, 5).join("、")}。建议直接换成可核验的系统动作与业务结果。`,
        en: `Found: ${buzzwordsFound.slice(0, 5).join(", ")}. Replace with concrete technical actions and outcomes.`,
      },
    });
  }
  if (firstPersonCount > 0) {
    findings.push({
      id: "writing-first-person",
      severity: "warn",
      category: "writing",
      title: {
        zh: `出现 ${firstPersonCount} 处第一人称代词（本人 / I / my）`,
        en: `Found ${firstPersonCount} first-person pronoun(s) (I / my)`,
      },
      detail: {
        zh: "简历正文通常省略主语，直接以动词开头更精炼专业。",
        en: "Omit first-person pronouns and lead directly with action verbs.",
      },
    });
  }
  if (longBullets.length > 0) {
    findings.push({
      id: "writing-long-bullets",
      severity: "warn",
      category: "writing",
      title: {
        zh: `${longBullets.length} 条要点偏长，快速扫读负担重`,
        en: `${longBullets.length} bullet(s) are overly long for quick scanning`,
      },
      detail: {
        zh: "单条建议控制在 1–2 行（中文 ≤ 90 字 / 英文 ≤ 35 词），拆清动作与结果。",
        en: "Keep each bullet to 1–2 lines (≤ 35 words) focusing on one clear outcome.",
      },
    });
  }
  if (weakOpeners.length === 0 && buzzwordsFound.length === 0 && firstPersonCount === 0 && longBullets.length === 0) {
    findings.push({
      id: "writing-clean",
      severity: "pass",
      category: "writing",
      title: { zh: "写作表达克制有力，无明显 AI 套话", en: "Crisp, action-oriented writing with no AI clichés" },
      detail: {
        zh: "未检测到弱动词开头、第一人称代词或空泛套话。",
        en: "No weak openers, first-person pronouns, or hollow buzzwords detected.",
      },
    });
  }

  // ── 5. ATS Parsability ──
  const hasEmbeddedImage = /data:image\/|!\[[^\]]*\]\([^)]+\)/i.test(trimmed);
  const hasTablePipes = /^\s*\|.*\|.*\|\s*$/m.test(trimmed);
  const tooShort = charCount < 180;
  const tooLong = charCount > 5500;
  let parsabilityScore = 100;
  if (hasEmbeddedImage) parsabilityScore -= 30;
  if (hasTablePipes) parsabilityScore -= 20;
  if (tooShort) parsabilityScore -= 25;
  if (tooLong) parsabilityScore -= 15;
  parsabilityScore = Math.max(20, parsabilityScore);

  if (hasEmbeddedImage) {
    findings.push({
      id: "parse-image",
      severity: "critical",
      category: "parsability",
      title: { zh: "正文中混入图片或 Base64 图像串", en: "Embedded image or base64 URI found in text" },
      detail: {
        zh: "ATS 解析器无法读取图片中的信息，且 Base64 会污染纯文本索引；请改用纯文本表达关键内容。",
        en: "ATS parsers ignore images and base64 strings pollute plain-text indexing.",
      },
    });
  }
  if (hasTablePipes) {
    findings.push({
      id: "parse-table",
      severity: "warn",
      category: "parsability",
      title: { zh: "检测到表格结构（| 列分隔 |）", en: "Markdown table structure detected" },
      detail: {
        zh: "部分老旧 ATS 解析多列表格时会打乱阅读顺序，关键经历优先使用单栏线性结构。",
        en: "Legacy ATS parsers can scramble multi-column tables; prefer single-column linear lists.",
      },
    });
  }
  if (tooShort) {
    findings.push({
      id: "parse-short",
      severity: "warn",
      category: "parsability",
      title: { zh: `文本总字数偏少（${charCount} 字符）`, en: `Resume text looks sparse (${charCount} chars)` },
      detail: {
        zh: "如果这是从 PDF 复制出的文本，请检查是否存在图片文字或无法选中提取的图层。",
        en: "If copied from a PDF, check whether text was rasterized or trapped inside graphics.",
      },
    });
  } else if (tooLong) {
    findings.push({
      id: "parse-long",
      severity: "warn",
      category: "parsability",
      title: { zh: `正文篇幅较长（${charCount} 字符）`, en: `Resume text is long (${charCount} chars)` },
      detail: {
        zh: "建议聚焦最近 5–8 年最相关的经历，控制在一至两页高信噪比篇幅。",
        en: "Focus on the most relevant 5–8 years to keep signal-to-noise high across 1–2 pages.",
      },
    });
  } else if (!hasEmbeddedImage && !hasTablePipes) {
    findings.push({
      id: "parse-clean",
      severity: "pass",
      category: "parsability",
      title: { zh: "纯文本顺序清晰，无 ATS 解析阻碍", en: "Clean linear plain text for ATS parsers" },
      detail: {
        zh: `共 ${charCount} 字符，无图片污染或复杂表格结构，阅读顺序友好。`,
        en: `${charCount} non-whitespace characters with clean linear reading order.`,
      },
    });
  }

  // ── 6. JD Keyword Match (optional) ──
  let matchedKeywords: string[] = [];
  let missingKeywords: string[] = [];
  let keywordsScore: number | null = null;
  const titleAlignment = computeTitleAlignment(trimmed, input.targetRole);

  if (jdTrimmed.length > 0) {
    const jdKeywords = extractJdKeywords(jdTrimmed);
    const resumeLower = trimmed.toLowerCase();
    matchedKeywords = jdKeywords.filter((kw) => containsKeyword(resumeLower, kw));
    missingKeywords = jdKeywords.filter((kw) => !containsKeyword(resumeLower, kw));
    keywordsScore = jdKeywords.length > 0 ? Math.round((matchedKeywords.length / jdKeywords.length) * 100) : 70;

    if (jdKeywords.length > 0) {
      findings.push({
        id: "keywords-summary",
        severity: keywordsScore >= 65 ? "pass" : keywordsScore >= 40 ? "warn" : "critical",
        category: "keywords",
        title: {
          zh: `JD 核心词覆盖 ${matchedKeywords.length} / ${jdKeywords.length}（${keywordsScore}%）`,
          en: `JD keyword coverage: ${matchedKeywords.length} / ${jdKeywords.length} (${keywordsScore}%)`,
        },
        detail:
          missingKeywords.length > 0
            ? {
                zh: `未命中词项：${missingKeywords.slice(0, 6).join("、")}。仅补充你真实掌握的技能，缺失项请保留为真实 Gap。`,
                en: `Not yet present: ${missingKeywords.slice(0, 6).join(", ")}. Only add skills you genuinely have; keep real gaps honest.`,
              }
            : {
                zh: "已提取的 JD 关键技术与领域词汇全部在简历中有所体现。",
                en: "All extracted JD technical and domain keywords appear in your resume.",
              },
      });
    }
  }

  const dimensions: AtsDimension[] =
    keywordsScore !== null
      ? [
          {
            id: "keywords",
            label: { zh: "JD 关键词覆盖", en: "JD Keyword Match" },
            score: keywordsScore,
            weight: 0.35,
            summary: { zh: `${matchedKeywords.length}/${matchedKeywords.length + missingKeywords.length} 项命中`, en: `${matchedKeywords.length}/${matchedKeywords.length + missingKeywords.length} matched` },
          },
          {
            id: "sections",
            label: { zh: "核心结构完整性", en: "Section Completeness" },
            score: sectionsScore,
            weight: 0.2,
            summary: { zh: missingSections.length === 0 ? "结构完整" : `缺 ${missingSections.length} 项`, en: missingSections.length === 0 ? "Complete" : `${missingSections.length} missing` },
          },
          {
            id: "impact",
            label: { zh: "量化成果密度", en: "Quantified Impact" },
            score: impactScore,
            weight: 0.15,
            summary: { zh: `${quantifiedBullets.length}/${bullets.length} 条量化`, en: `${quantifiedBullets.length}/${bullets.length} quantified` },
          },
          {
            id: "writing",
            label: { zh: "表达力度与规范", en: "Writing Craft" },
            score: writingScore,
            weight: 0.15,
            summary: { zh: weakOpeners.length + buzzwordsFound.length === 0 ? "克制有力" : `${weakOpeners.length + buzzwordsFound.length} 处可精炼`, en: weakOpeners.length + buzzwordsFound.length === 0 ? "Crisp" : `${weakOpeners.length + buzzwordsFound.length} notes` },
          },
          {
            id: "parsability",
            label: { zh: "ATS 纯文本可读性", en: "ATS Parsability" },
            score: parsabilityScore,
            weight: 0.1,
            summary: { zh: `${charCount} 字符`, en: `${charCount} chars` },
          },
          {
            id: "dates",
            label: { zh: "日期格式一致性", en: "Date Consistency" },
            score: datesScore,
            weight: 0.05,
            summary: { zh: dateFormatsFound.length <= 1 ? "格式统一" : `${dateFormatsFound.length} 种混用`, en: dateFormatsFound.length <= 1 ? "Consistent" : `${dateFormatsFound.length} styles` },
          },
        ]
      : [
          {
            id: "sections",
            label: { zh: "核心结构完整性", en: "Section Completeness" },
            score: sectionsScore,
            weight: 0.3,
            summary: { zh: missingSections.length === 0 ? "结构完整" : `缺 ${missingSections.length} 项`, en: missingSections.length === 0 ? "Complete" : `${missingSections.length} missing` },
          },
          {
            id: "impact",
            label: { zh: "量化成果密度", en: "Quantified Impact" },
            score: impactScore,
            weight: 0.25,
            summary: { zh: `${quantifiedBullets.length}/${bullets.length} 条量化`, en: `${quantifiedBullets.length}/${bullets.length} quantified` },
          },
          {
            id: "writing",
            label: { zh: "表达力度与规范", en: "Writing Craft" },
            score: writingScore,
            weight: 0.2,
            summary: { zh: weakOpeners.length + buzzwordsFound.length === 0 ? "克制有力" : `${weakOpeners.length + buzzwordsFound.length} 处可精炼`, en: weakOpeners.length + buzzwordsFound.length === 0 ? "Crisp" : `${weakOpeners.length + buzzwordsFound.length} notes` },
          },
          {
            id: "parsability",
            label: { zh: "ATS 纯文本可读性", en: "ATS Parsability" },
            score: parsabilityScore,
            weight: 0.15,
            summary: { zh: `${charCount} 字符`, en: `${charCount} chars` },
          },
          {
            id: "dates",
            label: { zh: "日期格式一致性", en: "Date Consistency" },
            score: datesScore,
            weight: 0.1,
            summary: { zh: dateFormatsFound.length <= 1 ? "格式统一" : `${dateFormatsFound.length} 种混用`, en: dateFormatsFound.length <= 1 ? "Consistent" : `${dateFormatsFound.length} styles` },
          },
        ];

  const overallScore = Math.round(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
  const severityOrder: Record<DiagnosticSeverity, number> = { critical: 0, warn: 1, pass: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const verdict: BilingualText =
    overallScore >= 82
      ? { zh: "ATS 就绪度优秀，可直接投递", en: "ATS-ready and cleanly structured" }
      : overallScore >= 65
        ? { zh: "基础扎实，修复几处细节即可明显提升", en: "Solid baseline with a few high-leverage fixes" }
        : { zh: "建议先补齐结构、量化或关键词覆盖", en: "Needs structure, evidence, or keyword improvements" };

  return {
    overallScore,
    verdict,
    wordCount,
    charCount,
    bulletCount: bullets.length,
    quantifiedBulletCount: quantifiedBullets.length,
    dimensions,
    findings,
    matchedKeywords,
    missingKeywords,
    titleAlignment,
    dateFormatsFound,
  };
}

export const DEMO_ATS_SAMPLE = {
  zh: {
    resumeText: `陈明远
高级全栈工程师 · 上海 | alex.demo@example.com | 13800138000 | https://github.com/alex-demo

个人简介
5 年分布式 Web 与工业软件研发经验，专注于 TypeScript、React、Node.js 与 PostgreSQL 高可用系统建设。

工作经历
北星智能科技 · 高级全栈工程师 (2023-04 ~ 至今)
- 设计并交付设备调度控制台与事件流引擎，支撑 120+ 台移动机器人并发调度，平均响应延迟从 420ms 降至 95ms。
- 重构核心订单查询与 PostgreSQL 复合索引策略，将高峰期 P99 接口耗时缩短 62%。
- 负责日常团队代码评审与部署维护工作。
- 建立 Playwright 端到端回归与 GitHub Actions 自动化发布流水线，将发版回滚率降低 70%。

云帆数据 · 前端工程师 (2021-07 ~ 2023-03)
- 主导实时监控工作台从 Vue 2 迁移至 React + TypeScript，首屏加载时间缩短 45%。
- 构建可复用表单与表格设计系统，覆盖 18 个业务模块并减少重复样式代码 38%。

专业技能
TypeScript, React, Node.js, PostgreSQL, Redis, Docker, Playwright, GitHub Actions, REST, WebSocket

教育背景
华东示例大学 · 软件工程 本科 (2017-09 ~ 2021-06)`,
    jdText: `高级全栈工程师（AI 工具与自动化方向）
岗位职责：
- 负责本地优先 Web 工作台与桌面端核心架构设计（React、TypeScript、Node.js）
- 设计高可靠数据同步、PostgreSQL 存储与 Redis 缓存链路
- 推动 Docker / Kubernetes 容器化部署与 CI/CD 质量门禁
- 集成 LLM / RAG / MCP 工具调用能力，提升用户工作流效率`,
  },
  en: {
    resumeText: `Alex Chen
Senior Full-Stack Engineer · Remote | alex.demo@example.com | https://github.com/alex-demo

Summary
Full-stack engineer with 5 years of experience building local-first TypeScript, React, Node.js, and PostgreSQL applications.

Experience
Northstar Systems · Senior Full-Stack Engineer (2023-04 - Present)
- Designed an event-driven fleet console coordinating 120+ devices, cutting median dispatch latency from 420ms to 95ms.
- Rebuilt PostgreSQL indexing and query batching for order pipelines, reducing peak P99 latency by 62%.
- Responsible for routine code reviews and release coordination.
- Built Playwright E2E regression suites and GitHub Actions pipelines, lowering release rollback rate by 70%.

CloudSail Data · Software Engineer (2021-07 - 2023-03)
- Led migration of real-time analytics workspace to React and TypeScript, reducing initial load time by 45%.
- Shipped a shared component system across 18 product modules, cutting duplicate UI styles by 38%.

Skills
TypeScript, React, Node.js, PostgreSQL, Redis, Docker, Playwright, GitHub Actions, REST, WebSocket

Education
Example Institute of Technology · B.S. in Software Engineering (2017-09 - 2021-06)`,
    jdText: `Senior Full-Stack Engineer (AI Workflows)
Requirements:
- Strong experience with React, TypeScript, and Node.js applications
- Hands-on PostgreSQL data modeling and Redis caching
- Experience with Docker, Kubernetes, and CI/CD automation
- Familiarity with LLM, RAG, and MCP tool integration is a strong plus`,
  },
} as const;
