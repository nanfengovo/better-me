import type { ResumeLayout } from "@better-me/core";
import { JSONRESUME_COMMUNITY_TEMPLATES } from "./templates/jsonresume-community-catalog";
import { BEST_RESUME_TEMPLATES } from "./templates/best-resume-catalog";
import { COMMUNITY_TEMPLATES } from "./templates/community-catalog";
import { JSONRESUME_EXTRA_TEMPLATES } from "./templates/jsonresume-extra-catalog";
import { EXTRA_RENDERCV_TEMPLATES } from "./templates/rendercv-extra-catalog";
import { DEEDY_TEMPLATES } from "./templates/deedy-catalog";
import { NEWFUTURE_EXTRA_TEMPLATES } from "./templates/newfuture-extra-catalog";
import { RICKOSBORNE_TEMPLATES } from "./templates/rickosborne-catalog";

export const TEMPLATE_SOURCES = [
  { id: "original", name: "BetterMe", zh: "自研", en: "Originals" },
  { id: "rendercv", name: "RenderCV", zh: "RenderCV", en: "RenderCV" },
  { id: "jsonresume", name: "JSON Resume", zh: "JSON Resume", en: "JSON Resume" },
  { id: "newfuture", name: "NewFuture", zh: "NewFuture", en: "NewFuture" },
  { id: "community", name: "Community", zh: "开源社区", en: "Community" },
] as const;
export type TemplateSourceId = (typeof TEMPLATE_SOURCES)[number]["id"];
type UiMetadata = { name: string; description: string; tag: string };
type TemplateDefinition = UiMetadata & {
  id: string;
  label: string;
  source: TemplateSourceId;
  en: UiMetadata;
  recommended: Pick<ResumeLayout, "accentColor" | "fontFamily">;
  upstreamUrl?: string;
  licensePath?: string;
  licenseLabel?: string;
  usageRestriction?: { zh: string; en: string };
  attribution?: { text: string; url: string; license: string; licenseUrl: string };
};

/** Native layouts share the same factual renderer; upstream adaptations have
 * individually reviewed licenses in templates/licenses, with pinned sources. */
export const RESUME_TEMPLATES = [
  { id: "zh-classic", source: "original", name: "经典正式", label: "CLASSIC", description: "居中抬头、衬线标题与细线分节，正式而克制。", tag: "正式投递", en: { name: "Classic", description: "Centered header, serif headings and fine section rules for a formal, restrained layout.", tag: "Formal applications" }, recommended: { accentColor: "#1b5147", fontFamily: "sans" } },
  { id: "en-ats", source: "original", name: "极简单栏", label: "ATS", description: "自然阅读顺序、纯文本信息、固定无照片；实际 ATS 解析仍需验证。", tag: "海外 / ATS", en: { name: "Minimal single column", description: "Natural reading order and plain text, always without a photo. Actual ATS parsing still needs verification.", tag: "International / ATS" }, recommended: { accentColor: "#292929", fontFamily: "sans" } },
  { id: "clean-modern", source: "original", name: "现代专业", label: "MODERN", description: "信息块抬头与时间线经历，用清晰层次突出技术成果。", tag: "技术岗位", en: { name: "Modern professional", description: "A structured header and experience timeline highlight technical results with clear hierarchy.", tag: "Technical roles" }, recommended: { accentColor: "#1b5147", fontFamily: "sans" } },
  { id: "editorial", source: "original", name: "编辑部", label: "EDITORIAL", description: "大字抬头、侧标分节与宽松留白，像一份精心编辑的作品。", tag: "高级质感", en: { name: "Editorial", description: "A large name, side labels and generous spacing give the resume an editorial feel.", tag: "Refined presentation" }, recommended: { accentColor: "#69424c", fontFamily: "serif" } },
  { id: "sidebar", source: "original", name: "左岸", label: "SIDEBAR", description: "个人资料置于独立窄栏，正文聚焦经历；适合信息丰富的中文简历。", tag: "双栏布局", en: { name: "Left bank", description: "Personal details sit in a narrow sidebar while the main column focuses on experience. Suits detailed Chinese resumes.", tag: "Two columns" }, recommended: { accentColor: "#1b5147", fontFamily: "sans" } },
  { id: "compact", source: "original", name: "精练履历", label: "COMPACT", description: "窄行距、横向信息带与紧凑分节，让重点更集中。", tag: "高密度", en: { name: "Compact", description: "Tighter line spacing, a horizontal information bar and compact sections concentrate the key points.", tag: "High density" }, recommended: { accentColor: "#293c58", fontFamily: "sans" } },
  { id: "rendercv-classic", source: "rendercv", name: "RenderCV · Classic", label: "CLASSIC", description: "原生适配 RenderCV Classic：居中身份、延伸节线与清楚的日期对齐；不依赖 Typst。", tag: "居中经典", en: { name: "RenderCV · Classic", description: "Native adaptation of RenderCV Classic: centered identity, extended section rules and aligned dates. No Typst runtime required.", tag: "Centered classic" }, recommended: { accentColor: "#004f90", fontFamily: "sans" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv" },
  { id: "rendercv-engineeringresumes", source: "rendercv", name: "RenderCV · Engineering", label: "ENGINEERING", description: "原生适配 EngineeringResumes：职位优先、衬线层次、完整链接地址与细线分节。", tag: "工程师单栏", en: { name: "RenderCV · Engineering", description: "Native EngineeringResumes adaptation with role-first headings, serif hierarchy, visible link destinations and fine rules.", tag: "Engineering single column" }, recommended: { accentColor: "#111111", fontFamily: "serif" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv" },
  { id: "rendercv-moderncv", source: "rendercv", name: "RenderCV · ModernCV", label: "MODERNCV", description: "原生适配 ModernCV：左侧日期轨、左对齐大字姓名与明确的章节横线。", tag: "日期侧轨", en: { name: "RenderCV · ModernCV", description: "Native ModernCV adaptation with a date rail, left-aligned name and pronounced section rules.", tag: "Date rail" }, recommended: { accentColor: "#004f90", fontFamily: "serif" }, upstreamUrl: "https://github.com/rendercv/rendercv", licensePath: "rendercv" },
  ...EXTRA_RENDERCV_TEMPLATES,
  { id: "jsonresume-stackoverflow", source: "jsonresume", name: "JSON Resume · Stack Overflow", label: "STACK OVERFLOW", description: "适配 Stack Overflow 主题的横线分节、浅蓝关键词与清晰字级，直接使用当前简历内容。", tag: "清晰技术履历", en: { name: "JSON Resume · Stack Overflow", description: "Adapts the Stack Overflow theme's ruled sections, blue keywords and clear hierarchy to your current resume.", tag: "Technical clarity" }, recommended: { accentColor: "#315c7b", fontFamily: "sans" }, upstreamUrl: "https://github.com/phoinixi/jsonresume-theme-stackoverflow", licensePath: "jsonresume-stackoverflow" },
  { id: "jsonresume-kendall", source: "jsonresume", name: "JSON Resume · Kendall", label: "KENDALL", description: "居中身份、灰底经历抬头和青色技能标签；适配为顺序单栏，保留自由分节排序。", tag: "顺序单栏适配", en: { name: "JSON Resume · Kendall", description: "Centered identity, shaded experience headings and teal skill tags. Adapted to one column to preserve your section order.", tag: "Sequential adaptation" }, recommended: { accentColor: "#257d87", fontFamily: "sans" }, upstreamUrl: "https://github.com/LinuxBozo/jsonresume-theme-kendall", licensePath: "jsonresume-kendall" },
  ...JSONRESUME_COMMUNITY_TEMPLATES,
  ...JSONRESUME_EXTRA_TEMPLATES,
  ...RICKOSBORNE_TEMPLATES,
  { id: "newfuture", source: "newfuture", name: "NewFuture · 中文履历", label: "NEWFUTURE", description: "适配 NewFuture/CV 的中文侧标、蓝色线条与轻框日期，保留正文的完整阅读顺序。", tag: "中文侧标", en: { name: "NewFuture · CV", description: "Adapts NewFuture/CV's marginal section labels, blue rules and outlined dates while preserving content order.", tag: "Chinese side labels" }, recommended: { accentColor: "#66aaee", fontFamily: "serif" }, upstreamUrl: "https://github.com/NewFuture/CV", licensePath: "newfuture" },
  { id: "billryan", source: "community", name: "billryan · 经典技术履历", label: "BILLRYAN", description: "从 awesome-resume-for-chinese 索引选入，适配 billryan/resume 的单栏、衬线标题与清晰分节。", tag: "中文技术单栏", en: { name: "billryan · Technical CV", description: "Selected via awesome-resume-for-chinese. A native adaptation of billryan/resume's single column, serif headings and clear sections.", tag: "Chinese technical CV" }, recommended: { accentColor: "#222222", fontFamily: "serif" }, upstreamUrl: "https://github.com/billryan/resume", licensePath: "billryan" },
  ...NEWFUTURE_EXTRA_TEMPLATES,
  ...BEST_RESUME_TEMPLATES,
  ...COMMUNITY_TEMPLATES,
  ...DEEDY_TEMPLATES,
] as const satisfies readonly TemplateDefinition[];

export type ResumeTemplateId = (typeof RESUME_TEMPLATES)[number]["id"];
export function resolveResumeTemplate(id: string): ResumeTemplateId {
  return RESUME_TEMPLATES.some((template) => template.id === id) ? id as ResumeTemplateId : "zh-classic";
}
export function getResumeTemplate(id: ResumeTemplateId): TemplateDefinition {
  return RESUME_TEMPLATES.find((template) => template.id === id)!;
}
/** UI locale is independent from the resume's output locale. */
export function getTemplateUiMetadata(id: ResumeTemplateId, locale: "zh" | "en"): UiMetadata {
  const template = getResumeTemplate(id);
  return locale === "en" ? template.en : template;
}
