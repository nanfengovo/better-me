import type { DocumentFieldChange, DocumentFieldTarget } from "@better-me/storage";
import type { UiTranslator } from "./ui-preferences";

type TargetField<Scope extends DocumentFieldTarget["scope"]> = Extract<DocumentFieldTarget, { scope: Scope }> extends { field: infer Field extends string } ? Field : never;

const PROFILE_FIELDS: Record<TargetField<"profile">, string> = {
  displayName: "Name", headline: "Headline", education: "Education", location: "Location",
  email: "Email", phone: "Phone", yearsOfExperience: "Years of experience",
  avatarUrl: "Photo", avatarBbox: "Photo crop", links: "Links", traits: "Strengths",
  targetRoles: "Target roles", constraints: "Job search constraints", salaryRange: "Salary expectations",
};
const SOURCE_FIELDS: Record<TargetField<"source">, string> = {
  fileName: "Source filename", importedAt: "Import time", rawText: "Original imported text",
  ocrText: "Visual transcription (unverified)", unparsedLines: "Original text awaiting review",
};
const EXPERIENCE_FIELDS: Record<TargetField<"experience">, string> = {
  type: "Type", org: "Organization / school", title: "Role / major", projectName: "Project name",
  start: "Start month", end: "End month", url: "Link", techStack: "Technology stack",
};
const CLAIM_FIELDS: Record<TargetField<"claim">, string> = {
  text: "Text", kind: "Type", tags: "Tags", metric: "Quantified metric",
};
const VIEW_FIELDS: Record<TargetField<"view">, string> = {
  name: "Name", locale: "Output language", templateId: "Template", targetJdId: "Linked target job",
  sectionOrder: "Section order", themeId: "Theme",
};
const LAYOUT_FIELDS: Record<TargetField<"layout">, string> = {
  bodyFontSize: "Body font size", nameFontSize: "Name font size", headingFontSize: "Heading font size",
  lineHeight: "Line height", sectionSpacing: "Section spacing", pageMargin: "Page margin",
  accentColor: "Accent color", fontFamily: "Font family",
};
const SECTION_FIELDS: Record<TargetField<"section-visibility">, string> = {
  summary: "Goals & strengths", experience: "Work experience", projects: "Projects",
  skills: "Skills", education: "Education", custom: "Other experience",
};
const VISIBLE_PROFILE_FIELDS: Record<TargetField<"profile-visibility">, string> = {
  photo: "Photo", headline: "Headline", education: "Header education", location: "Location",
  email: "Email", phone: "Phone", links: "Links", targetRoles: "Target roles", traits: "Strengths",
};

function languageSuffix(locale: "zh" | "en" | undefined): string {
  return locale === "zh" ? " (Chinese)" : locale === "en" ? " (English)" : "";
}
function itemLabel(noun: string, kind: DocumentFieldChange["kind"]): string {
  return kind === "added" ? `Add ${noun}` : kind === "removed" ? `Remove ${noun}` : noun;
}
function englishFieldLabel(change: DocumentFieldChange): string {
  const target = change.target;
  switch (target.scope) {
    case "profile": return `${PROFILE_FIELDS[target.field]}${languageSuffix(target.locale)}`;
    case "source": return SOURCE_FIELDS[target.field];
    case "source-item": return "Imported source material (group)";
    case "experience": return `Experience · ${EXPERIENCE_FIELDS[target.field]}${languageSuffix(target.locale)}`;
    case "claim": return `Entry · ${CLAIM_FIELDS[target.field]}${languageSuffix(target.locale)}`;
    case "experience-item": return itemLabel("experience", change.kind);
    case "claim-item": return itemLabel("entry", change.kind);
    case "view-item": return itemLabel("resume", change.kind);
    case "order": return target.collection === "experiences" ? "Experience order" : target.collection === "claims" ? "Entry order" : "Resume order";
    case "view": return `Resume · ${VIEW_FIELDS[target.field]}`;
    case "selection": return target.field === "experiences" ? "Resume · Selected experiences" : "Resume · Selected entries";
    case "layout": return `Resume · ${LAYOUT_FIELDS[target.field]}`;
    case "theme-token": return `Resume · Theme · ${{ paper: "Paper", text: "Body text", muted: "Secondary text", accent: "Accent", accentSoft: "Soft accent", rule: "Divider", bodyFamily: "Body font", headingFamily: "Heading font", nameFamily: "Name font", sectionHeading: "Section heading", keywordStyle: "Keyword style", dividerStyle: "Divider style" }[target.field]}`;
    case "section-visibility": return `Resume · ${SECTION_FIELDS[target.field]} visibility`;
    case "profile-visibility": return `Resume · ${VISIBLE_PROFILE_FIELDS[target.field]} visibility`;
    case "text-style": return "Resume · Text formatting";
    case "active-view": return "Active resume";
  }
}

/** Translate UI metadata from the typed target. Historical values and names are never rewritten. */
export function localizeFieldChangeLabel(change: DocumentFieldChange, t: UiTranslator): string {
  return t(change.label, englishFieldLabel(change));
}

const RESTORE_REASONS = new Map<string, string>([
  ["主题设置不符合当前支持的颜色、字体或装饰规范，不能恢复此项。", "These theme settings use unsupported colors, fonts or decorations and cannot be restored."],
  ["文档存在重复经历、要点或简历 ID，无法安全定位单项。", "The document contains duplicate experience, entry or resume IDs. This item cannot be located safely."],
  ["导入来源不存在或需整体移除，请先恢复“导入来源资料（整组）”后重新比较。", "The import source is missing or must be removed as a group. Restore “Imported source material (group)” first, then compare again."],
  ["单独恢复会使结束月份早于开始月份，请先恢复另一日期后重新比较。", "Restoring this date alone would put the end month before the start month. Restore the other date first, then compare again."],
  ["请先恢复该字段的中文内容，再重新比较英文内容。", "Restore this field’s Chinese content first, then compare the English content again."],
  ["中文字段仍有英文内容，不能连带移除；请先核对并恢复英文项。", "This Chinese field still has English content, which cannot be removed as a side effect. Review and restore the English item first."],
  ["请先恢复所属经历，再重新比较要点。", "Restore the parent experience first, then compare its entries again."],
  ["要点已不存在，请先恢复要点。", "This entry no longer exists. Restore the entry first."],
  ["已核实指标依赖对应原文，请先恢复要点正文再重新比较。", "The confirmed metric depends on matching source text. Restore the entry text first, then compare again."],
  ["格式对应的文字与当前不同，请先恢复对应文字再重新比较。", "The text associated with this formatting differs from the current text. Restore the corresponding text first, then compare again."],
  ["至少需要保留一份简历，不能单独删除最后一份。", "At least one resume must remain. The last resume cannot be removed separately."],
  ["该简历引用当前不存在的经历、要点或格式原文，请先恢复这些内容。", "This resume references experiences, entries or formatted text that are currently missing. Restore those items first."],
  ["该简历格式依赖不同的原文，请先恢复对应正文。", "This resume’s formatting depends on different source text. Restore the corresponding text first."],
  ["所选内容当前不存在，请先恢复相应经历或要点。", "The selected content is currently missing. Restore the corresponding experiences or entries first."],
  ["目标简历当前不存在，请先恢复该简历。", "The target resume is currently missing. Restore that resume first."],
]);

/** Unknown reasons stay intact; this is an exact UI dictionary, not a translator for user data. */
export function localizeFieldRestoreReason(change: DocumentFieldChange, t: UiTranslator): string | undefined {
  const reason = change.restore.reason;
  return reason === undefined ? undefined : t(reason, RESTORE_REASONS.get(reason) ?? reason);
}

const DOCUMENT_SUMMARIES = new Map<string, string>([
  ["姓名", "Name"], ["职位", "Headline"], ["邮箱", "Email"], ["电话", "Phone"],
  ["照片", "Photo"], ["学历", "Education"], ["所在地", "Location"], ["个人链接", "Links"],
  ["优势", "Strengths"], ["目标岗位", "Target roles"], ["个人信息", "Profile information"],
  ["简历模板、布局或展示设置", "Resume template, layout or display settings"], ["当前简历", "Active resume"],
]);

/** Only the internal describeDocumentChanges vocabulary and its exact count format are recognized. */
export function localizeDocumentSummary(summary: string, t: UiTranslator): string {
  const exact = DOCUMENT_SUMMARIES.get(summary);
  if (exact !== undefined) return t(summary, exact);
  const counts = /^经历 \/ 要点（([0-9]+) → ([0-9]+) 段，([0-9]+) → ([0-9]+) 条）$/.exec(summary);
  return counts ? t(summary, `Experiences / entries (${counts[1]} → ${counts[2]} experiences, ${counts[3]} → ${counts[4]} entries)`) : summary;
}
