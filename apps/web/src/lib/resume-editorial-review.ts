import type { ProjectedResume } from "@better-me/core";

/** Read-only observations about this rendered edition, not facts, writable fields or model input. */
export type EditorialFinding = {
  kind: "opening" | "full-stack" | "ai-evidence" | "education";
  title: string; advice: string; previewAnchor?: string;
};
type Experience = ProjectedResume["experiences"][number];
const fullStack = /全栈|前后端全链路|\bfull[ -]?stack\b/i;
const ai = /人工智能|大(?:语言)?模型|智能体|向量检索|检索增强生成|模型工具调用|\b(?:AI|GenAI|RAG|LLMs?|tool[ -]calling|retrieval[ -]augmented)\b/i;
const specificAi = [
  /向量检索|检索增强|\b(?:RAG|retrieval[ -]augmented)\b/i,
  /智能体|模型工具调用|\b(?:agents?|tool[ -]calling)\b/i,
  /大(?:语言)?模型|\b(?:LLMs?|language models?)\b/i,
];
const production = /上线|投产|客户现场|生产环境|\b(?:production|deployed to customers?)\b/i;
const prototypeOnly = /仅.{0,6}原型|(?:尚未|未)(?:在生产|上线|投产|交付)|\b(?:prototype only|not in production)\b/i;
const front = /页面|表单|仪表[盘板]|交互界面|前端(?:页面|组件|交互)|可视化看板|\b(?:front[ -]?end|UI|user interfaces?|web (?:console|client)|dashboards?|pages?|forms?)\b/i;
const back = /接口|服务端|后端(?:模块|服务)|数据模型|数据库|\b(?:APIs?|back[ -]?end|endpoints?|database)\b/i;
const action = /编写|实现|开发|设计|搭建|构建|接入|封装|修复|维护|联调|评估|验证|测试|部署|上线|\b(?:built|implemented|wrote|designed|created|integrated|developed|tested|evaluated|maintained|deployed|fixed)\b/i;
const background = /^(?:项目背景|项目介绍|项目名称|核心项目|技术栈|开发工具|(?:我们(?:的)?|本项目)?团队|公司|项目组|计划|拟|尚未|未曾|未参与|未实现|没有|未负责|仅旁观|\b(?:we|our team|the team|planned|not yet|did not|didn't)\b)/i;
const aspirations = /(?:期望|目标(?:方向|岗位)?|希望(?:转型|成为|学习)|计划|拟学习|正在学习|学习中|感兴趣|未曾|没有|尚未|并未|不涉及|非全栈|求职意向)|\b(?:aspiring|seeking|learning|not yet|no experience|interested in)\b/i;
const notDelivered = /未(?:曾|能|参与|实现|负责|完[成工]|设计|交付|接入|开发|验证)|没有(?:参与|实现|负责|设计|接入)|(?:计划|打算)(?:开发|实现|接入|部署|上线)|\b(?:did(?: not|n't)|planned to|not yet|would like to)\b/i;
const student = /实习|在校|应届|实训|\b(?:intern(?:ship)?|student|new grad(?:uate)?)\b/i;
const degree = /(?:教育(?:背景|经历)|学历)\s*(?:[:：]|$)|毕业于|学士|硕士|博士|本科|大专|\b(?:bachelor(?:'s)?|master(?:'s)?|ph\.?d|[bm]\.?sc)\b|\b[bm]\.s\.(?:\s|$)|\beducation\s*(?::|$)/i;
const splitStatements = (text: string) => text.split(/[\n。；;！？!?]+|(?<=\.)\s+/u).map(s => s.trim()).filter(Boolean);

/** A term in a role, tech-stack tag, project heading or plan isn't an action in a bullet. */
function actionsIn(experiences: Experience[]) {
  return experiences.flatMap(exp => exp.claims.flatMap(claim => splitStatements(claim.text)
    .filter(statement => !background.test(statement))
    .flatMap(statement => statement.split(/[，,]/).map(s => s.trim()))
    .filter(clause => !background.test(clause) && !notDelivered.test(clause) && action.test(clause))));
}
function asserted(text: string, capability: RegExp) {
  return splitStatements(text).some(statement => statement.split(/[，,]/).some(part =>
    capability.test(part) && !aspirations.test(part)));
}
function lacksAiEvidence(statement: string, actions: string[]) {
  // Different AI work is not interchangeable. A prototype can support a prototype statement,
  // not an assertion of production use. These are prompts for review, not attribution decisions.
  const relevant = production.test(statement) && !prototypeOnly.test(statement)
    ? actions.filter(s => production.test(s) && !prototypeOnly.test(s)) : actions;
  const named = specificAi.filter(term => term.test(statement));
  return named.length ? named.some(term => !relevant.some(s => term.test(s))) : !relevant.some(s => ai.test(s));
}
function supportedFullStack(experiences: Experience[]) {
  const actions = actionsIn(experiences);
  return actions.some(s => front.test(s)) && actions.some(s => back.test(s));
}
function crowdedOpening(resume: ProjectedResume, work: Experience[]) {
  if (!work.some(exp => !student.test(exp.title)) || [resume.profile.headline, ...resume.profile.targetRoles].some(s => s && student.test(s))) return false;
  const order = resume.sectionOrder ?? ["summary", "experience"];
  if (order.indexOf("experience") >= 0 && order.indexOf("summary") > order.indexOf("experience")) return false;
  const lines = resume.profile.traits.flatMap(splitStatements);
  if (lines.length < 4 || lines.join(" ").length < 120) return false;
  // Count named technologies repeated across statements, not English function words or substrings.
  const named = new Set([...(resume.skills ?? []), ...work.flatMap(exp => exp.techStack)].map(s => s.toLowerCase()));
  const counts = new Map<string, number>();
  for (const line of lines) {
    const tokens = line.match(/\.NET\b|[A-Za-z][A-Za-z\d.+#-]*/gi) ?? [];
    const recognized = new Set(tokens.map(t => t.replace(/[.-]+$/, "")).filter(t =>
      named.has(t.toLowerCase()) || /^[A-Z][A-Z\d]{1,}$/.test(t) || /[.#\d+]/.test(t)).map(t => t.toLowerCase()));
    for (const term of recognized) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const separatelyListed = new Set((resume.skills ?? []).map(s => s.toLowerCase()));
  return [...counts].filter(([term, n]) => n > 1 || separatelyListed.has(term)).length >= 2;
}

export function reviewResumeEdition(resume: ProjectedResume): EditorialFinding[] {
  const en = resume.locale === "en";
  const say = (zh: string, english: string) => en ? english : zh;
  const findings: EditorialFinding[] = [];
  // Only projectResume's current, visible material. Do not follow references to the fact base or other views.
  const work = resume.experiences.filter(exp => exp.type === "work");
  const contributions = resume.experiences.filter(exp => exp.type !== "education");
  if (crowdedOpening(resume, work)) findings.push({
    kind: "opening", previewAnchor: "profile:traits",
    title: say("让代表经历早点出现", "Bring representative experience forward"),
    advice: say("概述在工作经历前多次列出相同技术。可以留下目标岗位、交付对象和一项强项，把其余技能归组；用最相关的工作项目展示细节。", "Several technologies appear repeatedly before your work history. Keep the role, what you delivered and one strength up front; group the remaining skills and show the detail in a relevant work entry."),
  });
  const profile = [resume.profile.headline ?? "", ...resume.profile.traits];
  // Test a role against its own bullets, not against accomplishments in another job.
  const unresolvedRole = work.find(exp => asserted(exp.title, fullStack) && !supportedFullStack([exp]));
  const profileSource = (capability: RegExp) => asserted(profile[0]!, capability) ? "profile:headline" : "profile:traits";
  if (unresolvedRole || (profile.some(s => asserted(s, fullStack)) && !supportedFullStack(contributions))) findings.push({
    kind: "full-stack", previewAnchor: unresolvedRole ? `experience:${unresolvedRole.id}` : profileSource(fullStack),
    title: say("给「全栈」配一项具体交付", "Show both sides of a full-stack claim"),
    advice: say("在对应经历里，读者能找到你亲自完成的哪个页面或交互，以及它对接的哪个接口？只补实际做过的一侧也可以；保留正式职称，说明自己的职责范围。", "In the relevant entry, which screen or interaction did you build, and which endpoint did it use? If you owned just one side, keep your official title and describe that scope."),
  });
  const aiClaims = profile.flatMap((field, index) => splitStatements(field).flatMap(s => s.split(/[，,]/))
    .filter(s => asserted(s, ai)).map(statement => ({ statement, anchor: index === 0 ? "profile:headline" : "profile:traits" })));
  const visibleActions = aiClaims.length ? actionsIn(contributions) : [];
  const unmatchedAi = aiClaims.find(({ statement }) => lacksAiEvidence(statement, visibleActions));
  if (unmatchedAi) findings.push({
    kind: "ai-evidence", previewAnchor: unmatchedAi.anchor,
    title: say("把 AI 能力连到一个具体项目", "Connect AI experience to a project"),
    advice: say("本版概述中有 AI 表述，在可见经历里未识别到与其方向或使用阶段对应的动作。你实际设计、实现或验证了什么？个人项目可以作为依据；原型、学习与生产使用应分开说。", "Part of the AI summary has no recognized project action matching its topic or stage in this edition. What did you design, implement or evaluate? A personal project is useful; distinguish study, prototypes and production use."),
  });
  const educationVisible = [resume.educationSummary, resume.profile.education].some(s => s?.trim()) ||
    resume.experiences.some(exp => (exp.type === "education" && [exp.org, exp.title, ...exp.claims.map(c => c.text)].some(s => s.trim())) ||
      [exp.title, exp.projectName ?? "", ...exp.claims.map(c => c.text)].some(s => degree.test(s))) || profile.some(s => degree.test(s));
  if (work.length && resume.sectionVisibility?.education !== false && !educationVisible) findings.push({
    kind: "education", title: say("确认这版是否需要列出教育经历", "Decide whether this edition needs education"),
    advice: say("在当前可见内容中未识别到教育信息，并不代表你没有学历。岗位需要时，在「个人信息 → 学历」或教育经历中补本人确认、愿意展示的学校、专业、学历与时间；不适用就保留现状。", "No education information was recognized in this visible edition. If the role requires it, add the school, field, qualification and dates you can confirm under Personal information → Education or an education entry. Otherwise leave the edition as it is."),
  });
  return findings;
}
