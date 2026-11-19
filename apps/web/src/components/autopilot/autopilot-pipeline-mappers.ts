import type { Opportunity } from "../../lib/opportunities";
import type { JobPipelineItem } from "./CyberJobCard3D";

export type Translate = (chinese: string, english: string) => string;

const STUDIO_STAGE_ZH: Record<Opportunity["application"]["stage"], string> = {
  saved: "已收藏",
  evaluating: "待评估",
  preparing: "准备中",
  applied: "已投递",
  interview: "面试中",
  offer: "Offer",
  rejected: "未通过",
  withdrawn: "已撤回",
};

const STUDIO_WORK_MODE_TEXT: Record<Opportunity["workMode"], readonly [string, string]> = {
  remote: ["远程办公", "Remote"],
  hybrid: ["混合办公", "Hybrid"],
  "on-site": ["现场办公", "On-site"],
  unknown: ["办公方式待核", "Work mode unverified"],
};

const STUDIO_EMP_TEXT: Record<Opportunity["employmentType"], readonly [string, string]> = {
  social: ["社招", "Experienced"],
  campus: ["校招", "New grad"],
  internship: ["实习", "Internship"],
  unknown: ["招聘类型待核", "Type unverified"],
};

const CARD_PALETTES = [
  { gradient: "linear-gradient(135deg, #06B6D4 0%, #0284C7 55%, #1E3A8A 100%)", glow: "rgba(34, 211, 238, 0.42)" },
  { gradient: "linear-gradient(135deg, #F59E0B 0%, #EA580C 55%, #9A3412 100%)", glow: "rgba(245, 158, 11, 0.42)" },
  { gradient: "linear-gradient(135deg, #10B981 0%, #059669 55%, #065F46 100%)", glow: "rgba(16, 185, 129, 0.42)" },
  { gradient: "linear-gradient(135deg, #A855F7 0%, #7E22CE 55%, #3B0764 100%)", glow: "rgba(168, 85, 247, 0.42)" },
] as const;

const STAGE_TEXT: Record<string, readonly [string, string]> = {
  "已收藏": ["Saved", "Saved"],
  "待评估": ["Evaluating", "Eval"],
  "准备中": ["Preparing", "Prep"],
  "已投递": ["Applied", "Sent"],
  "面试中": ["Interviewing", "Intv"],
  "Offer": ["Offer", "Offer"],
  "未通过": ["Rejected", "Decl"],
  "已撤回": ["Withdrawn", "Wdr"],
  "简历润色中": ["Polishing resume", "Polish"],
  "ATS 核验通过": ["ATS check passed", "ATS ok"],
  "面试攻防准备": ["Interview prep", "Prep"],
};

function companyMonogram(company: string): string {
  const cleaned = company.trim().replace(/[^\p{L}\p{N}]/gu, "");
  return (cleaned.slice(0, 2) || "BM").toUpperCase();
}

export function stageLabel(stage: string, t: Translate): string {
  return t(stage, STAGE_TEXT[stage]?.[0] ?? stage);
}

export function opportunityToPipelineItem(job: Opportunity, index: number, t: Translate): JobPipelineItem {
  const palette = CARD_PALETTES[index % CARD_PALETTES.length]!;
  const city = [job.location.city, job.location.region, job.location.country].filter(Boolean).join(" · ") || t("地点未披露", "Location not disclosed");
  const modePair = STUDIO_WORK_MODE_TEXT[job.workMode];
  const empPair = STUDIO_EMP_TEXT[job.employmentType];
  const stage3D = STUDIO_STAGE_ZH[job.application.stage];
  return {
    id: job.id,
    queueRank: `#${index + 1}`,
    tier: stageLabel(stage3D, t),
    company: job.company,
    shortName: job.company.slice(0, 12),
    logoText: companyMonogram(job.company),
    logoGradient: palette.gradient,
    glowColor: palette.glow,
    role: job.title,
    city,
    salary: job.salaryText || t("未披露", "Not disclosed"),
    annualTotal: job.sourcePlatform || t("来源待核验", "Source unverified"),
    workHours: t(`${modePair[0]} · ${empPair[0]}`, `${modePair[1]} · ${empPair[1]}`),
    sourcePlatform: job.sourcePlatform || t("手动录入 / 待核验", "Manual / unverified"),
    sourceUrl: job.sourceUrl || "",
    description: job.description || "",
    nextAction: job.application.nextAction || t("下一步：核对岗位原文与申请入口", "Next: review original posting and application link"),
    updatedAt: job.updatedAt,
    materialsCount: job.materials.length,
    communicationsCount: job.application.communications.length,
    collectedIn3D: true,
    isNewMint: index === 0,
    stage3D,
    tags: [
      job.sourcePlatform || t("来源待核验", "Source unverified"),
      t(modePair[0], modePair[1]),
      job.employmentType !== "unknown" ? t(empPair[0], empPair[1]) : "",
    ].filter(Boolean),
    sourceJob: job,
  };
}
