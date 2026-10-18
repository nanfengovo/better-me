import { createDemoFactBase } from "../seed/demo-fact-base.js";
import type { ProjectedExperience, ProjectedResume } from "./resume-projection.js";

export type JdMatchReadiness = {
  ready: boolean;
  reason: "demo" | "mixed-demo" | "insufficient" | null;
  message: string;
};

function normalized(text: string | undefined): string {
  return (text ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, "");
}

function localizedValues(text: { zh: string; en?: string } | undefined): string[] {
  return text ? [text.zh, text.en ?? ""].map(normalized).filter(Boolean) : [];
}

// Content signatures recognize the bundled demonstration, independent of IDs,
// timestamps, the chosen language or cosmetic edits. They do not certify truth.
const demo = createDemoFactBase("2000-01-01T00:00:00.000Z");
const demoClaims = new Set(demo.experiences.flatMap((experience) =>
  experience.claims.flatMap((claim) => localizedValues(claim.text))));
const demoProjects = new Set(demo.experiences.flatMap((experience) => localizedValues(experience.projectName)));
const demoOrgs = new Set(demo.experiences.flatMap((experience) =>
  localizedValues(experience.org).filter((org) => org.includes("示例") || org.includes("sampletech"))));
const demoEducation = new Set(localizedValues(demo.profile.education));
const placeholders = new Set([
  "待填写", "待补充", "待确认", "请输入", "公司名称", "单位名称", "职位名称", "项目名称", "工作内容", "示例", "暂无",
  "your company", "company name", "your role", "job title", "project name", "todo", "tbd", "n/a",
].map(normalized));

function meaningful(text: string | undefined): boolean {
  const value = normalized(text);
  return Boolean(value) && !placeholders.has(value);
}

function substantiveClaim(text: string): boolean {
  // A short statement is enough; a blank/placeholder or isolated label is not.
  return meaningful(text) && [...normalized(text).replace(/[^\p{L}\p{N}]/gu, "")].length >= 4;
}

function containsDemo(experience: ProjectedExperience): boolean {
  return demoOrgs.has(normalized(experience.org)) ||
    demoProjects.has(normalized(experience.projectName)) ||
    experience.claims.some((claim) => demoClaims.has(normalized(claim.text)));
}

function hasEvidence(experience: ProjectedExperience): boolean {
  const hasAnchor = (meaningful(experience.org) && meaningful(experience.title)) || meaningful(experience.projectName);
  if (!hasAnchor) return false;
  if (experience.claims.some((claim) => substantiveClaim(claim.text))) return true;
  // An actual education record is evidence even without work history or metrics.
  if (experience.type === "education" && meaningful(experience.org) && meaningful(experience.title)) return true;
  // A dated role with technologies is useful context even when its imported
  // description is incomplete. Standalone skills and empty experiences are not.
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(experience.start) &&
    meaningful(experience.org) && meaningful(experience.title) && experience.techStack.some(meaningful);
}

function hasPersonalEvidence(experience: ProjectedExperience): boolean {
  if (!containsDemo(experience)) return hasEvidence(experience);
  const personalAnchor = (meaningful(experience.org) && !demoOrgs.has(normalized(experience.org)) && meaningful(experience.title)) ||
    (meaningful(experience.projectName) && !demoProjects.has(normalized(experience.projectName)));
  return personalAnchor && experience.claims.some((claim) =>
    substantiveClaim(claim.text) && !demoClaims.has(normalized(claim.text)));
}

/**
 * Check only the resume actually submitted for JD analysis. This detects known
 * demo content and missing evidence; readiness never verifies personal facts.
 */
export function getJdMatchReadiness(resume: ProjectedResume): JdMatchReadiness {
  const hasDemo = resume.experiences.some(containsDemo) ||
    demoEducation.has(normalized(resume.educationSummary)) ||
    demoEducation.has(normalized(resume.profile.education));
  const hasPersonal = resume.experiences.some(hasPersonalEvidence);
  if (hasDemo) {
    return {
      ready: false,
      reason: hasPersonal ? "mixed-demo" : "demo",
      message: hasPersonal
        ? "当前简历仍混有演示经历、原句或示例学校。请替换或隐藏这些示例内容，再分析你的岗位匹配情况。"
        : "当前简历包含演示内容，不能据此评价你的岗位匹配情况。请先导入本人简历，或将示例替换为自己的经历与成果。",
    };
  }
  if (!hasPersonal) {
    return {
      ready: false,
      reason: "insufficient",
      message: "当前视图缺少可分析的经历依据。请先导入或补充本人工作、项目或教育记录及相关内容；仅姓名、联系方式、目标岗位或技能列表不足以生成个人匹配结论。",
    };
  }
  return {
    ready: true,
    reason: null,
    message: "当前视图已有可分析的经历内容；这只表示输入具备分析条件，不代表事实已核实或个人能力已验证。",
  };
}
