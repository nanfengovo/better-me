import { ResumeThemeIdSchema, ResumeThemeOverridesSchema, type Experience, type FactClaim, type Profile, type ResumeImportSource, type ResumeLayout, type ResumeProfileField, type ResumeSectionId, type ResumeThemeOverrides, type ResumeView, type TextStyleRange } from "@better-me/core";
import type { BetterMeDocument } from "./types.js";

type ExperienceField = "type" | "org" | "title" | "projectName" | "start" | "end" | "url" | "techStack";
type ClaimField = "text" | "kind" | "tags" | "metric";
type ViewField = "name" | "locale" | "templateId" | "themeId" | "targetJdId" | "sectionOrder";
type ThemeTokenTarget = { [Group in keyof ResumeThemeOverrides]-?: {
  scope: "theme-token"; viewId: string; group: Group; field: keyof NonNullable<ResumeThemeOverrides[Group]>;
} }[keyof ResumeThemeOverrides];
export type DocumentFieldTarget =
  | { scope: "profile"; field: keyof Profile; locale?: "zh" | "en" }
  | { scope: "source"; field: keyof ResumeImportSource }
  | { scope: "source-item" }
  | { scope: "experience"; experienceId: string; field: ExperienceField; locale?: "zh" | "en" }
  | { scope: "claim"; experienceId: string; claimId: string; field: ClaimField; locale?: "zh" | "en" }
  | { scope: "experience-item"; experienceId: string }
  | { scope: "claim-item"; experienceId: string; claimId: string }
  | { scope: "view-item"; viewId: string }
  | { scope: "order"; collection: "experiences" | "views"; experienceId?: never }
  | { scope: "order"; collection: "claims"; experienceId: string }
  | { scope: "view"; viewId: string; field: ViewField }
  | { scope: "selection"; viewId: string; field: "experiences" | "claims" }
  | { scope: "layout"; viewId: string; field: keyof ResumeLayout }
  | ThemeTokenTarget
  | { scope: "section-visibility"; viewId: string; field: ResumeSectionId }
  | { scope: "profile-visibility"; viewId: string; field: ResumeProfileField }
  | { scope: "text-style"; viewId: string; key: string }
  | { scope: "active-view" };

export type DocumentFieldChange = {
  readonly id: string;
  readonly target: DocumentFieldTarget;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "changed" | "added" | "removed";
  readonly restore: { readonly available: boolean; readonly reason?: string };
};
export type DocumentFieldRestoreResult =
  | { ok: true; document: BetterMeDocument; adjustments: string[] }
  | { ok: false; reason: "stale" | "unsupported" | "invalid"; message: string };
type Snapshot = { expected: unknown; value: unknown; guard: unknown; dependencies: unknown; sourceOrder?: string[] };
// These are ephemeral review handles, not persisted patches. Keeping machine
// targets non-enumerable and snapshots private prevents display JSON from
// exposing raw IDs, portraits, or full structured private document values.
const snapshots = new WeakMap<DocumentFieldChange, Snapshot>();
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key) => own(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function uniqueIds(document: BetterMeDocument): boolean {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  return unique(document.factBase.experiences.map((item) => item.id)) && unique(document.resumeViews.map((item) => item.id)) &&
    unique(document.factBase.experiences.flatMap((item) => item.claims.map((claim) => claim.id)));
}
function experience(document: BetterMeDocument, id: string) { return document.factBase.experiences.find((item) => item.id === id); }
function claim(document: BetterMeDocument, experienceId: string, claimId: string) { return experience(document, experienceId)?.claims.find((item) => item.id === claimId); }
function view(document: BetterMeDocument, id: string) { return document.resumeViews.find((item) => item.id === id); }
function styleText(document: BetterMeDocument, key: string): string | undefined {
  const profile = key.match(/^profile:(displayName|headline):(zh|en)$/);
  if (profile) return document.factBase.profile[profile[1] as "displayName" | "headline"]?.[profile[2] as "zh" | "en"] ?? "";
  const match = key.match(/^claim:(.+):(zh|en)$/);
  if (!match) return undefined;
  const item = document.factBase.experiences.flatMap((entry) => entry.claims).find((entry) => entry.id === match[1]);
  return item ? item.text[match[2] as "zh" | "en"] ?? "" : undefined;
}
function localizedValue(object: object, field: string, locale?: "zh" | "en"): unknown {
  const value = (object as Record<string, unknown>)[field];
  return locale ? (value as Record<string, unknown> | undefined)?.[locale] : value;
}
function read(document: BetterMeDocument, target: DocumentFieldTarget): unknown {
  switch (target.scope) {
    case "profile": return localizedValue(document.factBase.profile, target.field, target.locale);
    case "source": return document.factBase.importSource?.[target.field];
    case "source-item": return document.factBase.importSource;
    case "experience": { const item = experience(document, target.experienceId); return item && localizedValue(item, target.field, target.locale); }
    case "claim": { const item = claim(document, target.experienceId, target.claimId); return item && localizedValue(item, target.field, target.locale); }
    case "experience-item": return experience(document, target.experienceId);
    case "claim-item": return claim(document, target.experienceId, target.claimId);
    case "view-item": return view(document, target.viewId);
    case "order": return target.collection === "experiences" ? document.factBase.experiences.map((item) => item.id)
      : target.collection === "views" ? document.resumeViews.map((item) => item.id) : experience(document, target.experienceId!)?.claims.map((item) => item.id);
    case "view": return view(document, target.viewId)?.[target.field];
    case "selection": { const item = view(document, target.viewId); return item && (target.field === "experiences"
      ? { mode: item.experienceSelection, ids: item.includedExperienceIds } : { mode: item.claimSelection, ids: item.includedClaimIds }); }
    case "layout": return view(document, target.viewId)?.layout?.[target.field];
    case "theme-token": return (view(document, target.viewId)?.themeOverrides?.[target.group] as Record<string, unknown> | undefined)?.[target.field];
    case "section-visibility": return view(document, target.viewId)?.sectionVisibility?.[target.field];
    case "profile-visibility": return view(document, target.viewId)?.profileVisibility?.[target.field];
    case "text-style": return view(document, target.viewId)?.textStyles?.[target.key];
    case "active-view": return document.activeResumeId;
  }
}
function structuralGuard(document: BetterMeDocument, target: DocumentFieldTarget): unknown {
  if (target.scope === "text-style") return { text: styleText(document, target.key), exists: !!view(document, target.viewId) };
  if (target.scope === "source") return !!document.factBase.importSource;
  if (target.scope === "experience" || target.scope === "claim") return { experience: !!experience(document, target.experienceId), claim: target.scope === "claim" ? !!claim(document, target.experienceId, target.claimId) : true };
  if (target.scope === "experience-item") return document.factBase.experiences.map((item) => item.id);
  if (target.scope === "claim-item") return experience(document, target.experienceId)?.claims.map((item) => item.id);
  if (target.scope === "view-item") return document.resumeViews.map((item) => item.id);
  if ("viewId" in target) return !!view(document, target.viewId);
  return null;
}
function missingReferences(document: BetterMeDocument, candidate: ResumeView): boolean {
  const experiences = new Set(document.factBase.experiences.map((item) => item.id));
  const claims = new Set(document.factBase.experiences.flatMap((item) => item.claims.map((entry) => entry.id)));
  return candidate.includedExperienceIds.some((id) => !experiences.has(id)) || candidate.includedClaimIds.some((id) => !claims.has(id)) ||
    Object.keys(candidate.textStyles ?? {}).some((key) => styleText(document, key) === undefined);
}
function dependencyGuard(document: BetterMeDocument, target: DocumentFieldTarget, desired: unknown): unknown {
  if (target.scope === "claim" && target.field === "metric" && (desired as FactClaim["metric"])?.confirmed) return claim(document, target.experienceId, target.claimId)?.text;
  if (target.scope === "view-item" && desired) return Object.keys((desired as ResumeView).textStyles ?? {}).map((key) => [key, styleText(document, key)]);
  return null;
}
function invalidDate(document: BetterMeDocument, target: DocumentFieldTarget, desired: unknown): boolean {
  if (target.scope !== "experience" || (target.field !== "start" && target.field !== "end")) return false;
  const item = experience(document, target.experienceId);
  if (!item) return true;
  const start = target.field === "start" ? desired : item.start, end = target.field === "end" ? desired : item.end;
  return typeof start === "string" && typeof end === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(start) && /^\d{4}-(0[1-9]|1[0-2])$/.test(end) && end < start;
}
function unavailable(before: BetterMeDocument, after: BetterMeDocument, target: DocumentFieldTarget): string | undefined {
  if (!uniqueIds(before) || !uniqueIds(after)) return "文档存在重复经历、要点或简历 ID，无法安全定位单项。";
  if (target.scope === "view" && target.field === "themeId" && !ResumeThemeIdSchema.optional().safeParse(read(after, target)).success ||
    target.scope === "theme-token" && !ResumeThemeOverridesSchema.safeParse({ [target.group]: { [target.field]: read(after, target) } }).success) return "主题设置不符合当前支持的颜色、字体或装饰规范，不能恢复此项。";
  if (target.scope === "source" && (!before.factBase.importSource || !after.factBase.importSource)) return "导入来源不存在或需整体移除，请先恢复“导入来源资料（整组）”后重新比较。";
  if (invalidDate(before, target, read(after, target))) return "单独恢复会使结束月份早于开始月份，请先恢复另一日期后重新比较。";
  if ((target.scope === "profile" || target.scope === "experience" || target.scope === "claim") && target.locale) {
    const owner = target.scope === "profile" ? before.factBase.profile : target.scope === "experience" ? experience(before, target.experienceId) : claim(before, target.experienceId, target.claimId);
    const container = owner && localizedValue(owner, target.field) as Record<string, unknown> | undefined;
    if (target.locale === "en" && !container && read(after, target) !== undefined) return "请先恢复该字段的中文内容，再重新比较英文内容。";
    if (target.locale === "zh" && read(after, target) === undefined && container && own(container, "en")) return "中文字段仍有英文内容，不能连带移除；请先核对并恢复英文项。";
  }
  if (target.scope === "claim" || target.scope === "claim-item") {
    if (!experience(before, target.experienceId)) return "请先恢复所属经历，再重新比较要点。";
    if (target.scope === "claim" && !claim(before, target.experienceId, target.claimId)) return "要点已不存在，请先恢复要点。";
    if (target.scope === "claim" && target.field === "metric") {
      const next = claim(after, target.experienceId, target.claimId);
      if (next?.metric?.confirmed && !same(claim(before, target.experienceId, target.claimId)?.text, next.text)) return "已核实指标依赖对应原文，请先恢复要点正文再重新比较。";
    }
  }
  if (target.scope === "text-style" && (styleText(before, target.key) === undefined || styleText(before, target.key) !== styleText(after, target.key))) return "格式对应的文字与当前不同，请先恢复对应文字再重新比较。";
  if (target.scope === "view-item") {
    const desired = view(after, target.viewId);
    if (!desired && before.resumeViews.length <= 1) return "至少需要保留一份简历，不能单独删除最后一份。";
    if (desired && missingReferences(before, desired)) return "该简历引用当前不存在的经历、要点或格式原文，请先恢复这些内容。";
    if (desired && Object.keys(desired.textStyles ?? {}).some((key) => styleText(before, key) !== styleText(after, key))) return "该简历格式依赖不同的原文，请先恢复对应正文。";
  }
  if (target.scope === "selection") {
    const desired = view(after, target.viewId);
    if (desired) {
      const ids = target.field === "experiences" ? desired.includedExperienceIds : desired.includedClaimIds;
      const known = new Set(target.field === "experiences" ? before.factBase.experiences.map((item) => item.id) : before.factBase.experiences.flatMap((item) => item.claims.map((entry) => entry.id)));
      if (ids.some((id) => !known.has(id))) return "所选内容当前不存在，请先恢复相应经历或要点。";
    }
  }
  if (target.scope === "active-view" && !view(before, after.activeResumeId)) return "目标简历当前不存在，请先恢复该简历。";
  return undefined;
}

/** Build an opaque, immutable review handle. Callers never parse display labels. */
export function createDocumentFieldChange(before: BetterMeDocument, after: BetterMeDocument, target: DocumentFieldTarget,
  display: Pick<DocumentFieldChange, "label" | "before" | "after" | "kind">): DocumentFieldChange {
  const reason = unavailable(before, after, target);
  const change = { ...display, restore: Object.freeze({ available: !reason, ...(reason ? { reason } : {}) }) } as DocumentFieldChange;
  Object.defineProperties(change, {
    id: { value: JSON.stringify(target), enumerable: false },
    target: { value: Object.freeze(structuredClone(target)), enumerable: false },
  });
  const sourceOrder = target.scope === "experience-item" ? after.factBase.experiences.map((item) => item.id)
    : target.scope === "claim-item" ? experience(after, target.experienceId)?.claims.map((item) => item.id)
    : target.scope === "view-item" ? after.resumeViews.map((item) => item.id) : undefined;
  snapshots.set(change, structuredClone({ expected: read(before, target), value: read(after, target), guard: structuralGuard(before, target), dependencies: dependencyGuard(before, target, read(after, target)), sourceOrder }));
  return Object.freeze(change);
}

function assign(object: object, field: string, value: unknown) {
  if (value === undefined) delete (object as Record<string, unknown>)[field];
  else Object.defineProperty(object, field, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
}
function setLocalized(object: object, field: string, locale: "zh" | "en" | undefined, value: unknown): boolean {
  if (!locale) { assign(object, field, value); return true; }
  const current = (object as Record<string, unknown>)[field] as Record<string, unknown> | undefined;
  if (locale === "zh" && value === undefined) {
    if (current && own(current, "en")) return false;
    assign(object, field, undefined);
  } else {
    if (!current && locale === "en" && value !== undefined) return false;
    const next = { ...current };
    assign(next, locale, value);
    assign(object, field, next);
  }
  return true;
}
function reordered<T extends { id: string }>(items: T[], ids: string[]): T[] | undefined {
  if (items.length !== ids.length || new Set(ids).size !== ids.length) return undefined;
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.every((id) => byId.has(id)) ? ids.map((id) => byId.get(id)!) : undefined;
}
function putItem<T extends { id: string }>(items: T[], id: string, value: T | undefined, sourceOrder: string[] = []): T[] {
  if (value === undefined) return items.filter((item) => item.id !== id);
  const existing = items.findIndex((item) => item.id === id);
  if (existing >= 0) return items.map((item) => item.id === id ? structuredClone(value) : item);
  const sourceIndex = sourceOrder.indexOf(id);
  const nextId = sourceOrder.slice(sourceIndex + 1).find((candidate) => items.some((item) => item.id === candidate));
  const index = nextId ? items.findIndex((item) => item.id === nextId) : items.length;
  return [...items.slice(0, index), structuredClone(value), ...items.slice(index)];
}
function textFields(document: BetterMeDocument): Map<string, string> {
  const fields = new Map<string, string>();
  for (const locale of ["zh", "en"] as const) {
    fields.set(`profile:displayName:${locale}`, document.factBase.profile.displayName[locale] ?? "");
    fields.set(`profile:headline:${locale}`, document.factBase.profile.headline?.[locale] ?? "");
    for (const item of document.factBase.experiences) for (const entry of item.claims) fields.set(`claim:${entry.id}:${locale}`, entry.text[locale] ?? "");
  }
  return fields;
}
function rebaseRanges(previous: string, next: string, ranges: TextStyleRange[]): TextStyleRange[] {
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const oldEnd = previous.length - suffix, delta = next.length - previous.length;
  return ranges.flatMap((range) => [
    ...(range.start < prefix ? [{ ...range, end: Math.min(range.end, prefix) }] : []),
    ...(range.end > oldEnd ? [{ ...range, start: Math.max(range.start, oldEnd) + delta, end: range.end + delta }] : []),
  ].filter((range) => range.start < range.end));
}
function repairDependencies(before: BetterMeDocument, next: BetterMeDocument, adjustments: string[]) {
  const experienceIds = new Set(next.factBase.experiences.map((item) => item.id));
  const claimIds = new Set(next.factBase.experiences.flatMap((item) => item.claims.map((entry) => entry.id)));
  const removedExperiences = new Set(before.factBase.experiences.filter((item) => !experienceIds.has(item.id)).map((item) => item.id));
  const removedClaims = new Set(before.factBase.experiences.flatMap((item) => item.claims.filter((entry) => !claimIds.has(entry.id)).map((entry) => entry.id)));
  const oldFields = textFields(before), newFields = textFields(next);
  for (const item of next.resumeViews) {
    const oldExperienceLength = item.includedExperienceIds.length, oldClaimLength = item.includedClaimIds.length;
    item.includedExperienceIds = item.includedExperienceIds.filter((id) => !removedExperiences.has(id));
    item.includedClaimIds = item.includedClaimIds.filter((id) => !removedClaims.has(id));
    if (item.includedExperienceIds.length !== oldExperienceLength || item.includedClaimIds.length !== oldClaimLength) {
      // An explicit selected list must stay selected when its last ID disappears.
      if (!item.experienceSelection && oldExperienceLength) item.experienceSelection = "selected";
      if (!item.claimSelection && oldClaimLength) item.claimSelection = "selected";
      adjustments.push(`已清理简历「${item.name}」失效的展示选择，并保留隐藏语义。`);
    }
    for (const [key, ranges] of Object.entries(item.textStyles ?? {})) {
      const prior = oldFields.get(key), current = newFields.get(key);
      if (prior === current) continue;
      const rebased = current === undefined ? [] : rebaseRanges(prior ?? "", current, ranges);
      if (rebased.length) assign(item.textStyles!, key, rebased); else assign(item.textStyles!, key, undefined);
      adjustments.push(`已对简历「${item.name}」对应文字格式作最小重定位；被替换或删除的文字不沿用旧格式。`);
    }
  }
}

/** Restore exactly one reviewed field into the latest document, without I/O. */
export function applyDocumentFieldChange(current: BetterMeDocument, change: DocumentFieldChange, now = new Date().toISOString()): DocumentFieldRestoreResult {
  const snapshot = snapshots.get(change);
  if (!snapshot) return { ok: false, reason: "unsupported", message: "这条差异的比较凭据已失效，请重新比较后再恢复。" };
  if (!change.restore.available) return { ok: false, reason: "unsupported", message: change.restore.reason ?? "此项不能单独恢复。" };
  const target = change.target;
  if (!uniqueIds(current) || !same(read(current, target), snapshot.expected) || !same(structuralGuard(current, target), snapshot.guard) || !same(dependencyGuard(current, target, snapshot.value), snapshot.dependencies)) {
    return { ok: false, reason: "stale", message: "当前字段或所属结构已在比较后变化，请重新比较，避免覆盖新修改。" };
  }
  if (invalidDate(current, target, snapshot.value)) return { ok: false, reason: "invalid", message: "单独恢复会使结束月份早于开始月份，请先恢复另一日期后重新比较。当前文档未修改。" };
  const next = structuredClone(current), adjustments: string[] = [];
  const value = structuredClone(snapshot.value);
  let valid = true;
  switch (target.scope) {
    case "profile": valid = setLocalized(next.factBase.profile, target.field, target.locale, value); break;
    case "source": assign(next.factBase.importSource!, target.field, value); break;
    case "source-item": assign(next.factBase, "importSource", value); break;
    case "experience": valid = setLocalized(experience(next, target.experienceId)!, target.field, target.locale, value); break;
    case "claim": {
      const item = claim(next, target.experienceId, target.claimId)!;
      valid = setLocalized(item, target.field, target.locale, value);
      if (target.field === "text" && item.metric?.confirmed) { item.metric.confirmed = false; adjustments.push("要点正文已变更，关联量化指标恢复为待核实。"); }
      break;
    }
    case "experience-item": next.factBase.experiences = putItem(next.factBase.experiences, target.experienceId, value as Experience | undefined, snapshot.sourceOrder); break;
    case "claim-item": { const item = experience(next, target.experienceId)!; item.claims = putItem(item.claims, target.claimId, value as FactClaim | undefined, snapshot.sourceOrder); break; }
    case "view-item": {
      const candidate = value as ResumeView | undefined;
      if (candidate && missingReferences(next, candidate) || !candidate && next.resumeViews.length <= 1) { valid = false; break; }
      next.resumeViews = putItem(next.resumeViews, target.viewId, candidate, snapshot.sourceOrder);
      if (!next.resumeViews.some((item) => item.id === next.activeResumeId)) { next.activeResumeId = next.resumeViews[0]!.id; adjustments.push("被移除的当前简历已切换为剩余的第一份简历。"); }
      break;
    }
    case "order": {
      if (target.collection === "experiences") { const sorted = reordered(next.factBase.experiences, value as string[]); if (sorted) next.factBase.experiences = sorted; else valid = false; }
      else if (target.collection === "views") { const sorted = reordered(next.resumeViews, value as string[]); if (sorted) next.resumeViews = sorted; else valid = false; }
      else { const item = experience(next, target.experienceId!); const sorted = item && reordered(item.claims, value as string[]); if (item && sorted) item.claims = sorted; else valid = false; }
      break;
    }
    case "view": assign(view(next, target.viewId)!, target.field, value); break;
    case "selection": {
      const item = view(next, target.viewId)!, selection = value as { mode?: "all" | "selected"; ids: string[] };
      const known = new Set(target.field === "experiences" ? next.factBase.experiences.map((entry) => entry.id) : next.factBase.experiences.flatMap((entry) => entry.claims.map((entry) => entry.id)));
      if (selection.ids.some((id) => !known.has(id))) { valid = false; break; }
      assign(item, target.field === "experiences" ? "experienceSelection" : "claimSelection", selection.mode);
      assign(item, target.field === "experiences" ? "includedExperienceIds" : "includedClaimIds", selection.ids);
      break;
    }
    case "layout": { const item = view(next, target.viewId)!; item.layout ??= {}; assign(item.layout, target.field, value); break; }
    case "theme-token": {
      const item = view(next, target.viewId)!;
      item.themeOverrides ??= {};
      item.themeOverrides[target.group] ??= {};
      assign(item.themeOverrides[target.group]!, target.field, value);
      if (!Object.keys(item.themeOverrides[target.group]!).length) delete item.themeOverrides[target.group];
      if (!Object.keys(item.themeOverrides).length) delete item.themeOverrides;
      break;
    }
    case "section-visibility": { const item = view(next, target.viewId)!; item.sectionVisibility ??= {}; assign(item.sectionVisibility, target.field, value); break; }
    case "profile-visibility": { const item = view(next, target.viewId)!; item.profileVisibility ??= {}; assign(item.profileVisibility, target.field, value); break; }
    case "text-style": { const item = view(next, target.viewId)!; item.textStyles ??= {}; assign(item.textStyles, target.key, value); break; }
    case "active-view": if (typeof value === "string" && view(next, value)) next.activeResumeId = value; else valid = false; break;
  }
  if (!valid) return { ok: false, reason: "invalid", message: "此字段仍依赖其他正文或结构，请先恢复对应内容后重新比较。当前文档未修改。" };
  repairDependencies(current, next, adjustments);
  if (!uniqueIds(next)) return { ok: false, reason: "invalid", message: "恢复会产生重复 ID，请先核对对应经历或要点。当前文档未修改。" };
  next.factBase.updatedAt = now;
  if ("viewId" in target && view(next, target.viewId)) view(next, target.viewId)!.updatedAt = now;
  return { ok: true, document: next, adjustments: [...new Set(adjustments)] };
}
