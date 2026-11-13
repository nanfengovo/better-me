import { getResumeLayout, resolveResumeTheme, type ProjectedResume } from "@better-me/core";
import {
  diagnoseLayout, isAcceptableLayoutSemanticVerdict, layoutCandidateFingerprint, mmToCssPx, sameLayoutScope, validateLayoutCandidate,
  type LayoutCandidate, type LayoutCompilerAdapters, type LayoutDiagnosis, type LayoutInput, type LayoutParameters,
  type LayoutRenderBinding, type LayoutScope, type LayoutSemanticVerdict, type PrintPageSpec, type ProtectedTextSpan,
} from "./layout-compiler";

export type CareerLayoutModelAdapter = Pick<LayoutCompilerAdapters, "rewrite"> & {
  verifySemantics: NonNullable<LayoutCompilerAdapters["verifySemantics"]>;
  label?: string;
  location?: "local" | "cloud" | "unknown";
  runtimeBinding?: string;
};
export interface CareerLayoutAdoptionContext { operationId: string; baseScope: LayoutScope; candidateFingerprint: string; signal: AbortSignal }
export interface CareerLayoutAdoptionReceipt {
  versionId: string;
  receiptId?: string;
  baseScope: LayoutScope;
  candidateFingerprint: string;
  /** 仅由业务CAS后正式回读的新投影产生；模型不得填写。 */
  resultScope?: LayoutScope;
}
export const CAREER_LAYOUT_PARAMETER_LABELS: Record<Exclude<keyof LayoutParameters, "bulletGapMm">, string> = {
  marginMm: "页边距（毫米）", bodyFontPt: "正文字号（磅）", lineHeight: "正文行距", sectionGapMm: "分节间距（毫米）",
};
export const CAREER_LAYOUT_PARAMETER_BOUNDS = { marginMm: [12, 28, 0.5], bodyFontPt: [9, 14, 0.25], lineHeight: [1.2, 2, 0.05], sectionGapMm: [12 * 25.4 / 96, 36 * 25.4 / 96, 0.1] } as const;
export function careerLayoutSourceFingerprint(resume: ProjectedResume): string { return JSON.stringify(resume); }
export function careerLayoutParameters(resume: ProjectedResume): LayoutParameters {
  const layout = resume.themeId ? resolveResumeTheme(resume).layout : getResumeLayout(resume.layout);
  return { marginMm: layout.pageMargin, bodyFontPt: layout.bodyFontSize, lineHeight: layout.lineHeight, sectionGapMm: layout.sectionSpacing * 25.4 / 96 };
}
export function careerLayoutPage(resume: ProjectedResume): PrintPageSpec {
  const margin = careerLayoutParameters(resume).marginMm!;
  return { widthMm: 210, heightMm: 297, marginMm: { top: margin, right: margin, bottom: margin, left: margin } };
}

export function buildCareerLayoutInput(resume: ProjectedResume, scope: LayoutScope,
  protectedSpansByAnchor: Readonly<Record<string, readonly ProtectedTextSpan[]>> = {}): LayoutInput {
  const entityNames = [...new Set([resume.profile.displayName, ...resume.profile.targetRoles, ...(resume.skills ?? []),
    ...resume.experiences.flatMap(experience => [experience.org, experience.title, experience.projectName ?? "", ...experience.techStack])].filter(value => value.trim()))];
  const texts = resume.experiences.flatMap(experience => experience.claims.filter(claim => claim.text.trim()).map(claim => ({ anchor: `claim:${claim.id}`, text: claim.text })));
  if (resume.profile.headline?.trim()) texts.unshift({ anchor: "profile:headline", text: resume.profile.headline });
  if (new Set(texts.map(text => text.anchor)).size !== texts.length) throw new Error("简历存在重复Claim定位，不能安全应用排版提案。");
  return { scope: { ...scope }, parameters: careerLayoutParameters(resume), texts: texts.map(text => ({ ...text,
    protectedSpans: [...entityNames.map(name => ({ text: name, kind: "entity" as const })), ...(protectedSpansByAnchor[text.anchor] ?? []).map(span => ({ ...span }))] })) };
}

/** 只生成候选投影，不修改原稿、Fact、view或持久化。 */
export function applyCareerLayoutCandidate(resume: ProjectedResume, input: LayoutInput, candidate: LayoutCandidate): ProjectedResume {
  const error = validateLayoutCandidate(input, candidate);
  if (error) throw new Error(error);
  if (candidate.parameters?.bulletGapMm !== undefined) throw new Error("当前视图没有可持久化的Bullet间距字段，不能假称此候选可采用。");
  const projection = JSON.parse(JSON.stringify(resume)) as ProjectedResume;
  const replacements = new Map(candidate.replacements.map(replacement => [replacement.anchor, replacement]));
  for (const experience of projection.experiences) for (const claim of experience.claims) {
    const replacement = replacements.get(`claim:${claim.id}`);
    if (!replacement) continue;
    if (claim.text !== replacement.before) throw new Error("Claim原句已变化，提案失效。");
    claim.text = replacement.after;
    if (replacement.after !== replacement.before && projection.textStyles) delete projection.textStyles[`claim:${claim.id}:${projection.locale}`];
  }
  const headline = replacements.get("profile:headline");
  if (headline) {
    if (projection.profile.headline !== headline.before) throw new Error("个人标题原句已变化，提案失效。");
    projection.profile.headline = headline.after;
    if (headline.after !== headline.before && projection.textStyles) delete projection.textStyles[`profile:headline:${projection.locale}`];
  }
  const parameters = candidate.parameters ?? {};
  const layout = { ...projection.layout };
  if (parameters.marginMm !== undefined) layout.pageMargin = parameters.marginMm;
  if (parameters.bodyFontPt !== undefined) layout.bodyFontSize = parameters.bodyFontPt;
  if (parameters.lineHeight !== undefined) {
    if (parameters.lineHeight < 1.2) throw new Error("当前视图行距不能低于1.2。");
    layout.lineHeight = parameters.lineHeight;
  }
  if (parameters.sectionGapMm !== undefined) {
    const pixels = mmToCssPx(parameters.sectionGapMm);
    if (pixels < 12 - 0.001 || pixels > 36 + 0.001) throw new Error("分节间距不在现有视图支持的范围内。");
    layout.sectionSpacing = Math.max(12, Math.min(36, pixels));
  }
  projection.layout = layout;
  return projection;
}

export function careerLayoutChanges(input: LayoutInput, candidate: LayoutCandidate) {
  return Object.entries(candidate.parameters ?? {}).filter(([key, value]) => value !== input.parameters?.[key as keyof LayoutParameters])
    .map(([key, after]) => ({ key: key as keyof LayoutParameters, before: input.parameters?.[key as keyof LayoutParameters], after }));
}
export function selectedCareerLayoutCandidate(input: LayoutInput, candidate: LayoutCandidate, selectedAnchors: readonly string[], selectedLayout: boolean): LayoutCandidate {
  const selected = new Set(selectedAnchors);
  const result: LayoutCandidate = { id: `${candidate.id.slice(0, 130)}-selected`, baseScope: { ...candidate.baseScope },
    replacements: candidate.replacements.filter(item => selected.has(item.anchor) && item.before !== item.after).map(item => ({ ...item })),
    parameters: selectedLayout ? { ...candidate.parameters } : undefined, explanation: "用户逐条勾选的待复测差异" };
  if (!result.replacements.length && !careerLayoutChanges(input, result).length) throw new Error("请至少选择一项实际变化。");
  const error = validateLayoutCandidate(input, result); if (error) throw new Error(error);
  return result;
}

/** 默认候选取决于真实诊断：溢出/孤页尝试压缩，纯留白尝试温和扩展。 */
export function defaultCareerLayoutCandidates(input: LayoutInput, current: LayoutCandidate, report: LayoutDiagnosis,
  desired: LayoutParameters, iteration: number, maximum: number): LayoutCandidate[] {
  const base = { ...input.parameters, ...current.parameters };
  const candidates: LayoutCandidate[] = [];
  const changed = (parameters: LayoutParameters) => Object.entries(parameters).some(([key, value]) => value !== base[key as keyof LayoutParameters]);
  const add = (suffix: string, parameters: LayoutParameters, explanation: string) => {
    if (changed(parameters)) candidates.push({ id: `layout-${iteration}-${suffix}`, baseScope: { ...input.scope }, replacements: current.replacements.map(item => ({ ...item })), parameters: { ...base, ...parameters }, explanation });
  };
  if (iteration === 1) add("manual", desired, "用户指定的布局参数；不会改写正文。");
  const compact = report.issues.some(issue => issue.kind !== "trailing-whitespace");
  const direction = compact ? -1 : 1;
  const limit = (key: keyof typeof CAREER_LAYOUT_PARAMETER_BOUNDS, value: number) => {
    const [minimum, maximum] = CAREER_LAYOUT_PARAMETER_BOUNDS[key]; return Math.min(maximum, Math.max(minimum, value));
  };
  add("spacing", { lineHeight: limit("lineHeight", (base.lineHeight ?? 1.6) + direction * 0.05),
    sectionGapMm: limit("sectionGapMm", (base.sectionGapMm ?? 22 * 25.4 / 96) + direction * 0.4) }, compact ? "尝试略收紧行距和分节间距。" : "针对实际页尾留白尝试适度放宽间距。");
  if (compact) {
    add("margin", { marginMm: limit("marginMm", (base.marginMm ?? 16) - 1) }, "在现有视图允许范围内尝试略减页边距。");
    if ((base.bodyFontPt ?? 10) > 9) add("font", { bodyFontPt: limit("bodyFontPt", (base.bodyFontPt ?? 10) - 0.25) }, "尝试小幅减小正文字号，不低于9磅。");
  }
  return candidates.slice(0, Math.max(0, maximum));
}

export type CareerLayoutSelectionReview = { status: "reviewed"; candidate: LayoutCandidate; report: LayoutDiagnosis; semanticVerdict?: LayoutSemanticVerdict; requiresConfirmation: true }
  | { status: "cancelled" | "stale" | "timeout" | "unavailable" | "rejected"; detail: string };

/** 子集选择必须复测，不能沿用整组提案的几何与语义结果。 */
export async function reviewCareerLayoutSelection(input: LayoutInput, candidate: LayoutCandidate,
  adapters: Pick<LayoutCompilerAdapters, "render" | "verifySemantics" | "getCurrentScope">,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CareerLayoutSelectionReview> {
  const error = validateLayoutCandidate(input, candidate); if (error) return { status: "rejected", detail: error };
  const controller = new AbortController();
  const snapshotInput = JSON.parse(JSON.stringify(input)) as LayoutInput;
  const snapshotCandidate = JSON.parse(JSON.stringify(candidate)) as LayoutCandidate;
  const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30000, options.timeoutMs!)) : 12000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interruptAbort: (() => void) | undefined;
  const cancel = () => controller.abort(); options.signal?.addEventListener("abort", cancel, { once: true });
  const interrupted = (): CareerLayoutSelectionReview | undefined => {
    if (options.signal?.aborted) return { status: "cancelled", detail: "已取消所选差异复测。" };
    if (!sameLayoutScope(input.scope, adapters.getCurrentScope())) return { status: "stale", detail: "原稿、账号或会话已变化，复测结果失效。" };
    return undefined;
  };
  try {
    const early = interrupted(); if (early) return early;
    const work = async (): Promise<CareerLayoutSelectionReview> => {
      const beforeDispatch = interrupted(); if (beforeDispatch) return beforeDispatch;
      if (controller.signal.aborted) return { status: "cancelled", detail: "复测已中止。" };
      let semanticVerdict: LayoutSemanticVerdict | undefined;
      if (candidate.replacements.some(item => item.before !== item.after)) {
        if (!adapters.verifySemantics) return { status: "rejected", detail: "所选文案需要独立等义审查，模型自评不够。" };
        semanticVerdict = await adapters.verifySemantics({ input: JSON.parse(JSON.stringify(snapshotInput)) as LayoutInput, candidate: JSON.parse(JSON.stringify(snapshotCandidate)) as LayoutCandidate }, controller.signal);
        const stop = interrupted(); if (stop) return stop;
        if (controller.signal.aborted) return { status: "timeout", detail: "复测已中止。" };
        if (!isAcceptableLayoutSemanticVerdict(semanticVerdict, snapshotInput, snapshotCandidate)) return { status: "rejected", detail: "独立等义审查未知、否定、缺项或未绑定所选差异。" };
      }
      const binding: LayoutRenderBinding = { candidateId: snapshotCandidate.id, fingerprint: layoutCandidateFingerprint(snapshotCandidate) };
      const measurement = await adapters.render(JSON.parse(JSON.stringify(snapshotCandidate)) as LayoutCandidate, controller.signal, { ...binding });
      const stop = interrupted(); if (stop) return stop;
      if (controller.signal.aborted) return { status: "timeout", detail: "复测已中止。" };
      if (!sameLayoutScope(measurement.scope, input.scope)) return { status: "stale", detail: "测量返回了其他原稿版本。" };
      const report = diagnoseLayout(measurement);
      if (report.status !== "diagnosed") return { status: "unavailable", detail: report.detail };
      if (measurement.status !== "measured" || measurement.source !== "dom-estimate"
        || measurement.renderBinding?.candidateId !== binding.candidateId || measurement.renderBinding?.fingerprint !== binding.fingerprint) {
        return { status: "rejected", detail: "测量没有绑定当前所选候选的真实DOM；未推断其排版结果。" };
      }
      return { status: "reviewed", candidate: snapshotCandidate, report, semanticVerdict, requiresConfirmation: true };
    };
    const result = await new Promise<CareerLayoutSelectionReview>(resolve => {
      let done = false;
      const finish = (result: CareerLayoutSelectionReview) => { if (!done) { done = true; resolve(result); } };
      const abort = () => finish({ status: "cancelled", detail: "已取消所选差异复测。" });
      interruptAbort = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); finish({ status: "timeout", detail: "所选差异复测达到时间上限，没有自动采用。" }); }, timeout);
      Promise.resolve().then(work).then(result => finish(result), () => finish({ status: "unavailable", detail: "复测Adapter失败，没有推断几何或等义。" })).finally(() => options.signal?.removeEventListener("abort", abort));
      if (options.signal?.aborted) abort();
    });
    return interrupted() ?? result;
  } catch { return { status: "stale", detail: "当前版本或授权无法复核，结果未采用。" }; }
  finally { controller.abort(); if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); if (interruptAbort) options.signal?.removeEventListener("abort", interruptAbort); }
}

export async function adoptCareerLayoutSelection(input: LayoutInput, review: Extract<CareerLayoutSelectionReview, { status: "reviewed" }>,
  onAdopt: (candidate: LayoutCandidate, context: CareerLayoutAdoptionContext) => Promise<CareerLayoutAdoptionReceipt | void>,
  options: { getCurrentScope(): LayoutScope; signal?: AbortSignal; operationId: string; timeoutMs?: number }): Promise<
    { status: "saved"; receipt: CareerLayoutAdoptionReceipt } | { status: "unknown" | "stale" | "cancelled"; detail: string }> {
  const controller = new AbortController();
  const candidate = JSON.parse(JSON.stringify(review.candidate)) as LayoutCandidate, fingerprint = layoutCandidateFingerprint(candidate);
  const valid = () => sameLayoutScope(input.scope, options.getCurrentScope());
  const cancel = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined, interrupt: (() => void) | undefined;
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) return { status: "cancelled", detail: "采用请求已取消，未自动重试。" };
    if (!valid() || !sameLayoutScope(review.report.scope, input.scope) || validateLayoutCandidate(input, candidate)
      || (candidate.replacements.some(item => item.before !== item.after) && (!review.semanticVerdict || !isAcceptableLayoutSemanticVerdict(review.semanticVerdict, input, candidate)))) return { status: "stale", detail: "所选复测、独立等义审查与当前原稿不匹配，未派送采用。" };
    const result = await new Promise<CareerLayoutAdoptionReceipt | undefined>(resolve => {
      let done = false; const finish = (receipt?: CareerLayoutAdoptionReceipt) => { if (!done) { done = true; resolve(receipt); } };
      interrupt = () => { controller.abort(); finish(); }; options.signal?.addEventListener("abort", interrupt, { once: true });
      timer = setTimeout(() => { controller.abort(); finish(); }, Math.min(30000, Math.max(1, options.timeoutMs ?? 12000)));
      Promise.resolve().then(() => {
        if (controller.signal.aborted || !valid()) return undefined;
        return onAdopt(candidate, { operationId: options.operationId, baseScope: { ...input.scope }, candidateFingerprint: fingerprint, signal: controller.signal });
      }).then(receipt => finish(receipt || undefined), () => finish());
      if (options.signal?.aborted) interrupt();
    });
    const currentScope = options.getCurrentScope();
    const exactReceipt = !!result && !!result.versionId?.trim() && sameLayoutScope(result.baseScope, input.scope) && result.candidateFingerprint === fingerprint;
    const trustedAdvance = exactReceipt && result.resultScope
      && result.resultScope.ownerId === input.scope.ownerId && result.resultScope.sessionGeneration === input.scope.sessionGeneration
      && result.resultScope.documentId === input.scope.documentId && sameLayoutScope(result.resultScope, currentScope);
    if (!sameLayoutScope(input.scope, currentScope) && !trustedAdvance) return { status: "stale", detail: "原稿、账号或会话已变化；没有匹配的自身CAS前进回执，晚结果未采用，请在工作区对账。" };
    if (options.signal?.aborted) return { status: "cancelled", detail: "采用请求已取消；已派送结果可能未知，请先对账，不会自动重试。" };
    if (!result || !exactReceipt) {
      return { status: "unknown", detail: "未取得绑定所选差异的版本回执。保存结果可能未知，请先到工作区对账，不会自动重试。" };
    }
    return { status: "saved", receipt: result };
  } catch { return { status: "unknown", detail: "采用结果无法核对，请先在工作区对账，不会自动重试。" }; }
  finally { controller.abort(); if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); if (interrupt) options.signal?.removeEventListener("abort", interrupt); }
}
