import {
  getResumeLayout,
  getResumeSectionOrder,
  splitStyledText,
  type Experience,
  type FactClaim,
  type LocalizedString,
  type ResumeView,
  type ResumeSectionId,
  type ResumeProfileField,
} from "@better-me/core";
import type { BetterMeDocument } from "./types.js";

export type DocumentFieldChange = { label: string; before: string; after: string; kind: "changed" | "added" | "removed" };
const SECTION_LABELS: Record<ResumeSectionId, string> = { summary: "个人优势", experience: "工作经历", projects: "项目经历", skills: "技能", education: "教育背景", custom: "其他经历" };
const PROFILE_LABELS: Record<ResumeProfileField, string> = { photo: "照片", headline: "职位", education: "抬头学历", location: "所在地", email: "邮箱", phone: "电话", links: "个人链接", targetRoles: "目标岗位", traits: "个人优势" };
const TEMPLATE_LABELS: Record<string, string> = { "zh-classic": "经典正式", "en-ats": "极简单栏", "clean-modern": "现代专业", editorial: "编辑部", sidebar: "左岸", compact: "精练履历" };
const EXPERIENCE_LABELS = { work: "工作经历", opensource: "开源 / 项目经历", education: "教育经历", other: "其他经历" };
const CLAIM_LABELS = { action: "行动", metric: "量化成果", note: "补充说明", pitfall: "问题复盘", interview: "面试素材" };
const EMPTY = "未设置";
function text(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return EMPTY;
  if (typeof value === "number" && !Number.isFinite(value)) return "未完成";
  return String(value);
}
function localized(value?: LocalizedString): string { return [value?.zh, value?.en].filter(Boolean).join(" / ") || EMPTY; }
function experienceName(item?: Experience): string { return item ? `${localized(item.org)} · ${localized(item.title)}` : "经历"; }
function claimName(item?: FactClaim): string { const value = item?.text.zh || item?.text.en || "未完成要点"; return value.length > 32 ? `${value.slice(0, 32)}…` : value; }
function list(values?: string[]): string { return values?.length ? values.join("\n") : EMPTY; }
function metricSummary(item?: FactClaim): string {
  const metric = item?.metric;
  return metric ? `${text(metric.value)} ${metric.unit || "未填单位"}；${metric.confirmed ? "已核实" : "待核实"}${metric.baseline ? `\n对照：${metric.baseline}` : ""}${metric.causal ? `\n原因：${metric.causal}` : ""}` : "无量化指标";
}
function experienceSummary(item: Experience): string {
  return `${EXPERIENCE_LABELS[item.type]}\n${experienceName(item)}\n${item.start || "未填开始月份"} — ${item.end === null ? "至今" : item.end || "未填结束月份"}${item.projectName ? `\n项目：${localized(item.projectName)}` : ""}${item.url ? `\n${item.url}` : ""}${item.techStack.length ? `\n技术栈：${item.techStack.join("、")}` : ""}`;
}
function claimSummary(item: FactClaim): string { return `${CLAIM_LABELS[item.kind]}\n${localized(item.text)}\n${metricSummary(item)}${item.tags.length ? `\n标签：${item.tags.join("、")}` : ""}`; }
function activeViewName(document: BetterMeDocument): string { return document.resumeViews.find((item) => item.id === document.activeResumeId)?.name || "未命名简历"; }
function selectedExperiences(document: BetterMeDocument, view: ResumeView): string {
  const all = view.experienceSelection === "all" || (!view.experienceSelection && view.includedExperienceIds.length === 0);
  return all ? "全部经历" : view.includedExperienceIds.length ? list(view.includedExperienceIds.map((id) => experienceName(document.factBase.experiences.find((item) => item.id === id)))) : "不展示任何经历";
}
function selectedClaims(document: BetterMeDocument, view: ResumeView): string {
  const all = view.claimSelection === "all" || (!view.claimSelection && view.includedClaimIds.length === 0);
  const claims = document.factBase.experiences.flatMap((item) => item.claims);
  return all ? "全部可展示要点" : view.includedClaimIds.length ? list(view.includedClaimIds.map((id) => localized(claims.find((item) => item.id === id)?.text))) : "不展示任何要点";
}
function selectionSignature(mode: "all" | "selected" | undefined, ids: string[]): string { return mode === "all" || (!mode && !ids.length) ? "all" : [...ids].sort().join("\u0000"); }
function styleTarget(document: BetterMeDocument, key: string): { label: string; text: string } {
  const locale = key.endsWith(":en") ? "en" : "zh";
  const suffix = locale === "en" ? "英文" : "中文";
  if (key.startsWith("profile:displayName:")) return { label: `姓名（${suffix}）`, text: document.factBase.profile.displayName[locale] ?? "" };
  if (key.startsWith("profile:headline:")) return { label: `职位（${suffix}）`, text: document.factBase.profile.headline?.[locale] ?? "" };
  if (key.startsWith("claim:")) {
    const id = key.slice("claim:".length, -(locale.length + 1));
    const claim = document.factBase.experiences.flatMap((item) => item.claims).find((item) => item.id === id);
    return { label: `要点「${claimName(claim)}」（${suffix}）`, text: claim?.text[locale] ?? "" };
  }
  return { label: "正文文本", text: "" };
}
function styleSummary(document: BetterMeDocument, view: ResumeView, key: string): string {
  const target = styleTarget(document, key);
  const parts = splitStyledText(target.text, view.textStyles?.[key] ?? []);
  const formatted = parts.filter((part) => Object.keys(part.style).length > 0).map((part) => {
    const descriptions: string[] = [];
    for (const [flag, label] of [["bold", "加粗"], ["italic", "斜体"], ["underline", "下划线"], ["highlight", "高亮"]] as const) {
      if (part.style[flag] !== undefined) descriptions.push(part.style[flag] ? label : `取消${label}`);
    }
    if (part.style.fontScale !== undefined) descriptions.push(`字号 ${text(part.style.fontScale)} 倍`);
    return `「${part.text}」：${descriptions.join("、")}`;
  });
  return formatted.length ? formatted.join("\n") : "常规文字格式";
}

/** Match stable IDs; reordered arrays cannot turn an edit into a fabricated deletion/addition. */
export function getDocumentFieldChanges(before: BetterMeDocument, after: BetterMeDocument): DocumentFieldChange[] {
  const changes: DocumentFieldChange[] = [];
  const add = (label: string, previous: string, next: string, kind: DocumentFieldChange["kind"] = "changed") => {
    if (previous !== next) changes.push({ label, before: previous, after: next, kind });
  };
  const localizedFields = (label: string, previous?: LocalizedString, next?: LocalizedString) => {
    add(`${label}（中文）`, text(previous?.zh), text(next?.zh));
    add(`${label}（英文）`, text(previous?.en), text(next?.en));
  };
  const oldProfile = before.factBase.profile;
  const newProfile = after.factBase.profile;
  for (const [key, label] of [["displayName", "姓名"], ["headline", "职位"], ["education", "学历"], ["location", "所在地"]] as const) localizedFields(label, oldProfile[key], newProfile[key]);
  for (const [key, label] of [["email", "邮箱"], ["phone", "电话"], ["yearsOfExperience", "工作年限"]] as const) add(label, text(oldProfile[key]), text(newProfile[key]));
  if (oldProfile.avatarUrl !== newProfile.avatarUrl) add("个人照片", oldProfile.avatarUrl ? "已设置照片" : "无照片", newProfile.avatarUrl ? oldProfile.avatarUrl ? "已更换照片" : "已设置照片" : "无照片");
  if (JSON.stringify(oldProfile.avatarBbox) !== JSON.stringify(newProfile.avatarBbox)) add("照片裁剪", oldProfile.avatarBbox ? "已设置裁剪范围" : "未设置裁剪", newProfile.avatarBbox ? oldProfile.avatarBbox ? "已调整裁剪范围" : "已设置裁剪范围" : "未设置裁剪");
  add("个人链接", list(oldProfile.links.map((item) => `${item.label || "链接"} · ${item.url}`)), list(newProfile.links.map((item) => `${item.label || "链接"} · ${item.url}`)));
  add("个人优势", list(oldProfile.traits), list(newProfile.traits));
  add("目标岗位", list(oldProfile.targetRoles.map(localized)), list(newProfile.targetRoles.map(localized)));
  add("求职约束", list(oldProfile.constraints), list(newProfile.constraints));
  const salary = (profile: typeof oldProfile) => profile.salaryRange ? `${profile.salaryRange.currency} ${text(profile.salaryRange.minK)}–${text(profile.salaryRange.maxK)} K` : EMPTY;
  add("期望薪资", salary(oldProfile), salary(newProfile));

  const oldExperiences = new Map(before.factBase.experiences.map((item) => [item.id, item]));
  const newExperiences = new Map(after.factBase.experiences.map((item) => [item.id, item]));
  for (const id of new Set([...oldExperiences.keys(), ...newExperiences.keys()])) {
    const previous = oldExperiences.get(id);
    const next = newExperiences.get(id);
    const name = experienceName(next ?? previous);
    if (!previous && next) add(`新增经历 · ${name}`, "不存在", experienceSummary(next), "added");
    else if (previous && !next) add(`删除经历 · ${name}`, experienceSummary(previous), "不存在", "removed");
    else if (previous && next) {
      const prefix = `经历 · ${name} · `;
      add(`${prefix}类型`, EXPERIENCE_LABELS[previous.type], EXPERIENCE_LABELS[next.type]);
      localizedFields(`${prefix}单位 / 学校`, previous.org, next.org);
      localizedFields(`${prefix}职位 / 专业`, previous.title, next.title);
      localizedFields(`${prefix}项目名称`, previous.projectName, next.projectName);
      add(`${prefix}开始月份`, text(previous.start), text(next.start));
      add(`${prefix}结束月份`, previous.end === null ? "至今" : text(previous.end), next.end === null ? "至今" : text(next.end));
      add(`${prefix}链接`, text(previous.url), text(next.url));
      add(`${prefix}技术栈`, list(previous.techStack), list(next.techStack));
      const priorOrder = previous.claims.map((item) => item.id);
      const nextOrder = next.claims.map((item) => item.id);
      if (JSON.stringify(priorOrder) !== JSON.stringify(nextOrder) && priorOrder.length === nextOrder.length && priorOrder.every((claimId) => nextOrder.includes(claimId))) add(`${prefix}要点顺序`, list(previous.claims.map(claimName)), list(next.claims.map(claimName)));
    }
    const oldClaims = new Map((previous?.claims ?? []).map((item) => [item.id, item]));
    const newClaims = new Map((next?.claims ?? []).map((item) => [item.id, item]));
    for (const claimId of new Set([...oldClaims.keys(), ...newClaims.keys()])) {
      const oldClaim = oldClaims.get(claimId);
      const newClaim = newClaims.get(claimId);
      const prefix = `${name} · 要点「${claimName(newClaim ?? oldClaim)}」`;
      if (!oldClaim && newClaim) add(`新增要点 · ${prefix}`, "不存在", claimSummary(newClaim), "added");
      else if (oldClaim && !newClaim) add(`删除要点 · ${prefix}`, claimSummary(oldClaim), "不存在", "removed");
      else if (oldClaim && newClaim) {
        localizedFields(`${prefix} · 正文`, oldClaim.text, newClaim.text);
        add(`${prefix} · 类型`, CLAIM_LABELS[oldClaim.kind], CLAIM_LABELS[newClaim.kind]);
        add(`${prefix} · 标签`, list(oldClaim.tags), list(newClaim.tags));
        add(`${prefix} · 量化指标`, metricSummary(oldClaim), metricSummary(newClaim));
      }
    }
  }
  const priorExperienceIds = before.factBase.experiences.map((item) => item.id);
  const nextExperienceIds = after.factBase.experiences.map((item) => item.id);
  if (JSON.stringify(priorExperienceIds) !== JSON.stringify(nextExperienceIds) && priorExperienceIds.length === nextExperienceIds.length && priorExperienceIds.every((id) => nextExperienceIds.includes(id))) add("经历排列顺序", list(before.factBase.experiences.map(experienceName)), list(after.factBase.experiences.map(experienceName)));

  const oldViews = new Map(before.resumeViews.map((item) => [item.id, item]));
  const newViews = new Map(after.resumeViews.map((item) => [item.id, item]));
  for (const id of new Set([...oldViews.keys(), ...newViews.keys()])) {
    const previous = oldViews.get(id);
    const next = newViews.get(id);
    const name = next?.name || previous?.name || "未命名简历";
    if (!previous && next) { add(`新增简历 · ${name}`, "不存在", `${name}\n${TEMPLATE_LABELS[next.templateId] ?? "自定义模板"}`, "added"); continue; }
    if (previous && !next) { add(`删除简历 · ${name}`, `${name}\n${TEMPLATE_LABELS[previous.templateId] ?? "自定义模板"}`, "不存在", "removed"); continue; }
    if (!previous || !next) continue;
    const prefix = `简历「${name}」· `;
    add(`${prefix}名称`, text(previous.name), text(next.name));
    add(`${prefix}输出语言`, previous.locale === "zh" ? "中文" : "英文", next.locale === "zh" ? "中文" : "英文");
    if (previous.targetJdId !== next.targetJdId) add(`${prefix}关联目标岗位`, previous.targetJdId ? "已关联目标岗位" : "未关联目标岗位", next.targetJdId ? previous.targetJdId ? "已更换关联岗位" : "已关联目标岗位" : "未关联目标岗位");
    if (previous.templateId !== next.templateId) add(`${prefix}模板`, TEMPLATE_LABELS[previous.templateId] ?? "当前自定义模板", TEMPLATE_LABELS[next.templateId] ?? "所选自定义模板");
    add(`${prefix}区块顺序`, getResumeSectionOrder(previous.sectionOrder).map((section) => SECTION_LABELS[section]).join(" → "), getResumeSectionOrder(next.sectionOrder).map((section) => SECTION_LABELS[section]).join(" → "));
    for (const section of Object.keys(SECTION_LABELS) as ResumeSectionId[]) add(`${prefix}${SECTION_LABELS[section]}展示`, previous.sectionVisibility?.[section] === false ? "隐藏" : "显示", next.sectionVisibility?.[section] === false ? "隐藏" : "显示");
    for (const field of Object.keys(PROFILE_LABELS) as ResumeProfileField[]) add(`${prefix}${PROFILE_LABELS[field]}展示`, previous.profileVisibility?.[field] === false ? "隐藏" : "显示", next.profileVisibility?.[field] === false ? "隐藏" : "显示");
    if (selectionSignature(previous.experienceSelection, previous.includedExperienceIds) !== selectionSignature(next.experienceSelection, next.includedExperienceIds)) add(`${prefix}所选经历`, selectedExperiences(before, previous), selectedExperiences(after, next));
    if (selectionSignature(previous.claimSelection, previous.includedClaimIds) !== selectionSignature(next.claimSelection, next.includedClaimIds)) add(`${prefix}所选要点`, selectedClaims(before, previous), selectedClaims(after, next));
    const oldLayout = getResumeLayout(previous.layout);
    const newLayout = getResumeLayout(next.layout);
    for (const [key, label, unit] of [["bodyFontSize", "正文字号", "pt"], ["nameFontSize", "姓名字号", "pt"], ["headingFontSize", "标题字号", "pt"], ["lineHeight", "行高", "倍"], ["sectionSpacing", "区块间距", "px"], ["pageMargin", "页边距", "mm"]] as const) add(`${prefix}${label}`, `${text(oldLayout[key])} ${unit}`, `${text(newLayout[key])} ${unit}`);
    add(`${prefix}主题颜色`, oldLayout.accentColor, newLayout.accentColor);
    const fontNames = { sans: "无衬线字体", serif: "衬线字体", mono: "等宽字体" };
    add(`${prefix}字体`, fontNames[oldLayout.fontFamily], fontNames[newLayout.fontFamily]);
    for (const key of new Set([...Object.keys(previous.textStyles ?? {}), ...Object.keys(next.textStyles ?? {})])) {
      const oldRanges = previous.textStyles?.[key] ?? [];
      const newRanges = next.textStyles?.[key] ?? [];
      const target = styleTarget(after, key);
      if (JSON.stringify(oldRanges) !== JSON.stringify(newRanges)) add(`${prefix}文字格式 · ${target.text ? target.label : styleTarget(before, key).label}`, styleSummary(before, previous, key), styleSummary(after, next, key));
    }
  }
  if (before.activeResumeId !== after.activeResumeId) add("当前简历", `${activeViewName(before)}（当前激活）`, `${activeViewName(after)}（所选版本激活）`);
  return changes;
}
