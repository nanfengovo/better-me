import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Check, ScanLine } from "lucide-react";
import type { ProjectedResume } from "@better-me/core";
import { ResumeTemplate, resolveResumeTemplate } from "./ResumeTemplate";
import {
  compileLayoutProposals, measureDomLayout, sameLayoutScope, inspectFinalLayoutArtifact, captureFinalLayoutExpectedDocument,
  layoutCandidateFingerprint,
  type LayoutCandidate, type LayoutCompileResult, type LayoutCompilerAdapters, type LayoutDiagnosis,
  type LayoutInput, type LayoutParameters, type LayoutScope, type ProtectedTextSpan,
  type FinalLayoutExportArtifact, type FinalLayoutExportContext, type FinalLayoutInspectionResult, type FinalLayoutFormat, type FinalPdfParser, type FinalLayoutArtifactBytes,
} from "../lib/layout-compiler";
import {
  CAREER_LAYOUT_PARAMETER_BOUNDS, CAREER_LAYOUT_PARAMETER_LABELS, adoptCareerLayoutSelection,
  applyCareerLayoutCandidate, buildCareerLayoutInput, careerLayoutChanges, careerLayoutPage, careerLayoutSourceFingerprint,
  reviewCareerLayoutSelection, selectedCareerLayoutCandidate, defaultCareerLayoutCandidates,
  type CareerLayoutAdoptionContext, type CareerLayoutAdoptionReceipt, type CareerLayoutModelAdapter, type CareerLayoutSelectionReview,
} from "../lib/career-studio-layout";
import "./resume-paper.css";
import "./CareerLayoutPanel.css";

export interface CareerLayoutFinalExportRequest extends FinalLayoutExportContext {
  resume: ProjectedResume;
  /** Absent means the original source. Present is the independently reviewed,
   * selected subset, still a proposal and not an automatic Workspace write. */
  candidate?: LayoutCandidate;
  signal: AbortSignal;
}
export interface CareerLayoutPanelProps {
  resume: ProjectedResume;
  scope: LayoutScope;
  /** 宿主应核对当前lease；缺省只能观察props版本，不能替代Host撤权检查。 */
  getCurrentScope?(): LayoutScope;
  model?: CareerLayoutModelAdapter;
  protectedSpansByAnchor?: Readonly<Record<string, readonly ProtectedTextSpan[]>>;
  onAdopt?(candidate: LayoutCandidate, context: CareerLayoutAdoptionContext): Promise<CareerLayoutAdoptionReceipt | void>;
  onLocateAnchor?(anchor: string): void;
  operationTimeoutMs?: number;
  exportFinalArtifact?(request: CareerLayoutFinalExportRequest): Promise<FinalLayoutExportArtifact>;
  /** Trusted parser/test seam only. Production defaults to actual PDF.js bytes. */
  finalPdfParser?: FinalPdfParser;
  finalOperationTimeoutMs?: number;
}

type ParameterKey = keyof typeof CAREER_LAYOUT_PARAMETER_BOUNDS;
type ReviewedSelection = Extract<CareerLayoutSelectionReview, { status: "reviewed" }>;
type FinalCheckState = { status: "not-run" } | { status: "running" } | FinalLayoutInspectionResult;
const emptyFinalChecks = (): Record<FinalLayoutFormat, FinalCheckState> => ({ pdf: { status: "not-run" }, docx: { status: "not-run" } });
const issueLabels = { "trailing-whitespace": "页尾留白较多", "orphan-page": "末页行数过少", "stranded-heading": "标题跨页或与正文分离", "short-last-line": "末行短词", overflow: "内容溢出或裁切" } as const;
const statusLabels = { proposed: "已有待确认候选", unchanged: "未需改变", nonconvergent: "未全部收敛", unavailable: "观测不可用", cancelled: "已取消", stale: "版本失效", failed: "本次失败" } as const;
const eventLabels = { rendered: "已实际渲染", rejected: "未通过保护门", selected: "发现实测改善", unavailable: "无法观测", duplicate: "重复候选已跳过" } as const;
const parameterKeys = Object.keys(CAREER_LAYOUT_PARAMETER_BOUNDS) as ParameterKey[];
const numberText = (value: number | undefined) => value === undefined ? "原默认值" : Number(value.toFixed(3)).toString();
const localOperationId = () => `layout-adoption-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

export default function CareerLayoutPanel(props: CareerLayoutPanelProps) {
  // 来源变更直接销毁旧候选与测量，不依赖模型自报新版本。
  return <LayoutSession key={`${JSON.stringify(props.scope)}:${careerLayoutSourceFingerprint(props.resume)}:${props.model?.runtimeBinding ?? "no-model-binding"}`} {...props} />;
}
export { CareerLayoutPanel };

function LayoutSession(props: CareerLayoutPanelProps) {
  const [source] = useState(() => JSON.parse(JSON.stringify(props.resume)) as ProjectedResume);
  const [setup] = useState<{ input?: LayoutInput; error: string }>(() => {
    try { return { input: buildCareerLayoutInput(source, props.scope, props.protectedSpansByAnchor), error: "" }; }
    catch (error) { return { error: error instanceof Error ? error.message : "原稿无法建立安全定位。" }; }
  });
  const input = setup.input;
  const [parameterDrafts, setParameterDrafts] = useState<Record<ParameterKey, string>>(() => Object.fromEntries(parameterKeys.map(key => [key, numberText(input?.parameters?.[key])])) as Record<ParameterKey, string>);
  const [mode, setMode] = useState<"layout" | "wording">("layout");
  const [modelConsent, setModelConsent] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState(setup.error), [notice, setNotice] = useState("");
  const [result, setResult] = useState<LayoutCompileResult>();
  const [candidate, setCandidate] = useState<LayoutCandidate>();
  const [candidateReport, setCandidateReport] = useState<LayoutDiagnosis>();
  const [selectedAnchors, setSelectedAnchors] = useState<string[]>([]), [selectedLayout, setSelectedLayout] = useState(false);
  const [selectionReview, setSelectionReview] = useState<ReviewedSelection>();
  const [adoptionConsent, setAdoptionConsent] = useState(false);
  const [adoptionAttempted, setAdoptionAttempted] = useState(false);
  const [adoptionReceipt, setAdoptionReceipt] = useState<CareerLayoutAdoptionReceipt>();
  const [finalChecks, setFinalChecks] = useState(emptyFinalChecks), [finalTarget, setFinalTarget] = useState<"source" | "selection">("source");
  const [finalExportConsent, setFinalExportConsent] = useState(false);
  const [renderProjection, setRenderProjection] = useState<ProjectedResume>();
  const [showPreview, setShowPreview] = useState(false);
  const stage = useRef<HTMLDivElement>(null), active = useRef<AbortController | null>(null), alive = useRef(true), adopted = useRef(false);
  const scopeRef = useRef(props.scope); scopeRef.current = props.scope;
  const [renderCount, setRenderCount] = useState(0);
  const titleId = useId();
  const busy = !!working;
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  const getScope = () => props.getCurrentScope?.() ?? scopeRef.current;
  const isCurrent = () => {
    try {
      const current = getScope(), advanced = adoptionReceipt?.resultScope;
      return alive.current && !!props.scope.ownerId && (sameLayoutScope(props.scope, current)
        || (!!advanced && advanced.ownerId === props.scope.ownerId && advanced.sessionGeneration === props.scope.sessionGeneration
          && advanced.documentId === props.scope.documentId && sameLayoutScope(advanced, current)));
    } catch { return false; }
  };
  const changedTexts = candidate?.replacements.filter(item => item.before !== item.after) ?? [];
  const changedParameters = candidate && input ? careerLayoutChanges(input, candidate) : [];
  function invalidateSelection() { setSelectionReview(undefined); setAdoptionConsent(false); setFinalChecks(emptyFinalChecks()); setFinalExportConsent(false); }
  function begin(label: string) {
    if (active.current || adopted.current || !input || !isCurrent()) { if (!isCurrent()) setError("当前原稿、账号或会话不可用，请重新打开排版核对。"); return undefined; }
    const controller = new AbortController(); active.current = controller; setWorking(label); setError(""); setNotice(""); return controller;
  }
  function end(controller: AbortController) { if (active.current === controller) active.current = null; if (alive.current) setWorking(""); }
  function parseDesired(): LayoutParameters {
    const desired: LayoutParameters = {};
    for (const key of parameterKeys) {
      const text = parameterDrafts[key].trim(), value = Number(text), [minimum, maximum] = CAREER_LAYOUT_PARAMETER_BOUNDS[key];
      const original = input?.parameters?.[key];
      if (!text || !Number.isFinite(value) || (value < minimum && !(key === "bodyFontPt" && value === 8 && original === 8)) || value > maximum) throw new Error(`${CAREER_LAYOUT_PARAMETER_LABELS[key]}必须在${numberText(minimum)}到${maximum}之间。`);
      desired[key] = original !== undefined && Math.abs(value - original) < 0.005 ? original : value;
    }
    return desired;
  }
  const render: LayoutCompilerAdapters["render"] = async (proposed, signal, binding) => {
    if (!input || !isCurrent() || signal.aborted) throw new Error("测量开始前已取消或失效。");
    const projection = applyCareerLayoutCandidate(source, input, proposed);
    flushSync(() => { setRenderProjection(projection); setRenderCount(count => count + 1); });
    const paper = stage.current?.querySelector<HTMLElement>(".resume-sheet");
    if (!paper) throw new Error("没有渲染出可观测的真实简历纸张。");
    return measureDomLayout(paper, { scope: props.scope, renderBinding: binding, page: careerLayoutPage(projection), signal,
      isCurrent, timeoutMs: Math.min(5000, props.operationTimeoutMs ?? 4000) });
  };
  function adoptCandidate(proposed: LayoutCandidate | undefined, report?: LayoutDiagnosis) {
    setCandidate(proposed); setCandidateReport(report); setSelectedAnchors([]); setSelectedLayout(false); invalidateSelection(); setShowPreview(false);
  }
  async function runCompiler() {
    if (!input || (mode === "wording" && (!props.model || !modelConsent))) return;
    let desired: LayoutParameters;
    try { desired = parseDesired(); } catch (cause) { setError(cause instanceof Error ? cause.message : "布局参数无效。"); return; }
    const controller = begin("正在测量原稿与有界候选"); if (!controller) return;
    setResult(undefined); adoptCandidate(undefined); setRenderCount(0); setModelConsent(false);
    const compiled = await compileLayoutProposals(input, {
      render, getCurrentScope: getScope,
      rewrite: async (request, signal) => {
        const layouts = defaultCareerLayoutCandidates(request.input, request.current, request.report, desired, request.iteration, request.maxCandidates);
        if (mode !== "wording" || !props.model) return layouts;
        const wordings = await props.model.rewrite(request, signal);
        return [...wordings, ...layouts].slice(0, request.maxCandidates);
      }, verifySemantics: props.model?.verifySemantics,
    }, { signal: controller.signal, maxIterations: 3, maxCandidatesPerIteration: 3, maxTotalCandidates: 9,
      maxDurationMs: props.operationTimeoutMs ?? 20000, requiredSource: "dom-estimate" });
    end(controller); if (!alive.current) return;
    setResult(compiled); adoptCandidate(compiled.proposal?.candidate, compiled.proposal?.report);
    if (compiled.status === "cancelled" || compiled.status === "stale" || compiled.status === "failed" || compiled.status === "unavailable") setError(compiled.reason);
    else setNotice(compiled.status === "nonconvergent" ? "有界迭代未全部收敛。可审阅已测改善，但不会自动改稿。" : compiled.status === "unchanged" ? "未测到配置内的问题；不代表PDF、DOCX或事实已验证。" : "已生成待审阅候选；原稿未改变。");
  }
  function createManualCandidate() {
    if (!input || !isCurrent() || adopted.current) return;
    try {
      const proposed: LayoutCandidate = { id: "manual-layout", baseScope: { ...props.scope }, replacements: [], parameters: parseDesired(), explanation: "用户明确指定的布局参数，尚未采用。" };
      if (!careerLayoutChanges(input, proposed).length) throw new Error("手动参数与原稿相同，没有需要确认的差异。");
      applyCareerLayoutCandidate(source, input, proposed);
      setResult(undefined); adoptCandidate(proposed); setNotice("已生成手动布局提案。先勾选布局差异，再复测；尚未采用。"); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "手动候选无效。"); }
  }
  async function reviewSelection() {
    if (!input || !candidate) return;
    let proposed: LayoutCandidate;
    try { proposed = selectedCareerLayoutCandidate(input, candidate, selectedAnchors, selectedLayout); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "没有选中的差异。"); return; }
    const controller = begin("正在复测已勾选差异"); if (!controller) return;
    invalidateSelection();
    const reviewed = await reviewCareerLayoutSelection(input, proposed, { render, getCurrentScope: getScope, verifySemantics: props.model?.verifySemantics }, { signal: controller.signal, timeoutMs: props.operationTimeoutMs ?? 12000 });
    end(controller); if (!alive.current) return;
    if (reviewed.status !== "reviewed") { setError(reviewed.detail); return; }
    setSelectionReview(reviewed); setShowPreview(false); setNotice("已勾选的子集已独立复测。请阅读其DOM估算结果后，再确认是否采用。");
  }
  async function adoptSelection() {
    if (!input || !selectionReview || !props.onAdopt || !adoptionConsent || adopted.current) return;
    const controller = begin("正在提交明确确认的差异"); if (!controller) return;
    adopted.current = true; setAdoptionAttempted(true);
    const outcome = await adoptCareerLayoutSelection(input, selectionReview, props.onAdopt, { getCurrentScope: getScope, signal: controller.signal,
      operationId: localOperationId(), timeoutMs: props.operationTimeoutMs ?? 12000 });
    end(controller); if (!alive.current) return;
    if (outcome.status === "saved") { setAdoptionReceipt(outcome.receipt); setNotice("已收到绑定所选差异的业务版本回执。PDF与DOCX仍需分别核对最终文件。"); }
    else setError(outcome.detail);
  }
  async function checkFinalFile(format: FinalLayoutFormat) {
    if (!input || !props.exportFinalArtifact || !finalExportConsent || adoptionAttempted || (finalTarget === "selection" && !selectionReview)) return;
    const controller = begin(`正在生成并独立检查最终${format.toUpperCase()}文件`); if (!controller) return;
    setFinalExportConsent(false); setFinalChecks(previous => ({ ...previous, [format]: { status: "running" } }));
    try {
      const proposed = finalTarget === "selection" ? selectionReview!.candidate : undefined;
      const projection = proposed ? applyCareerLayoutCandidate(source, input, proposed) : JSON.parse(JSON.stringify(source)) as ProjectedResume;
      flushSync(() => { setRenderProjection(projection); setRenderCount(count => count + 1); });
      const paper = stage.current?.querySelector<HTMLElement>(".resume-sheet"); if (!paper) throw new Error("没有可建立正文基准的真实源模板。");
      const expected = captureFinalLayoutExpectedDocument(paper, careerLayoutPage(projection));
      const context: FinalLayoutExportContext = { operationId: `final-${format}-${localOperationId()}`, format, scope: { ...props.scope },
        renderBinding: proposed ? { candidateId: proposed.id, fingerprint: layoutCandidateFingerprint(proposed) }
          : { candidateId: "original-source", fingerprint: careerLayoutSourceFingerprint(source) } };
      const checked = await inspectFinalLayoutArtifact({ context, expected, getCurrentScope: getScope, signal: controller.signal,
        parser: props.finalPdfParser, timeoutMs: props.finalOperationTimeoutMs ?? 60_000,
        exportArtifact: (request, signal) => props.exportFinalArtifact!({ ...request, resume: JSON.parse(JSON.stringify(projection)) as ProjectedResume,
          ...(proposed ? { candidate: JSON.parse(JSON.stringify(proposed)) as LayoutCandidate } : {}), signal }) });
      if (alive.current) setFinalChecks(previous => ({ ...previous, [format]: checked }));
    } catch (cause) {
      if (alive.current) {
        setFinalChecks(previous => ({ ...previous, [format]: { status: "not-run" } }));
        setError(cause instanceof Error ? cause.message : "源模板基准不可用，未将最终文件检查记为通过。");
      }
    } finally { end(controller); }
  }
  function downloadFinalFile(artifact: FinalLayoutArtifactBytes, format: FinalLayoutFormat) {
    if (!isCurrent() || adoptionAttempted) { setError("当前来源已失效，请重新授权后下载对应版本。"); return; }
    try {
      const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.bytes)], { type: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      const link = document.createElement("a"); link.href = url; link.download = artifact.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { setError("浏览器未完成文件下载，请重新生成该格式后再试；没有将下载误记为保存回执。"); }
  }
  let previewProjection: ProjectedResume | undefined;
  if (selectionReview && input && showPreview) {
    try { previewProjection = applyCareerLayoutCandidate(source, input, selectionReview.candidate); } catch { /* 失效不显示候选。 */ }
  }
  if (!isCurrent()) return <section className="career-layout-panel" aria-label="排版核对"><p role="alert">当前原稿、账号或会话不可用。旧候选未展示，不会继续测量或采用。</p></section>;
  if (!input) return <section className="career-layout-panel" aria-label="排版核对"><p role="alert">{setup.error || "无法建立当前原稿的安全定位。"}</p></section>;

  return <section className="career-layout-panel" aria-labelledby={titleId}>
    <header className="clp-header"><div><p className="clp-eyebrow">事实不变 · 排版候选编译</p><h2 id={titleId}>排版核对与有界自愈</h2><p>实际渲染当前简历，测量DOM盒与文字行；每一条文案变化仍需独立审查和你的明确确认。</p></div><span>原稿版本 {props.scope.revision}</span></header>
    <p className="clp-boundary">DOM估算不等于打印分页。最终PDF：{finalCheckSummary(finalChecks.pdf)}；最终DOCX：{finalCheckSummary(finalChecks.docx)}。不会为了凑单页删事实、改数字或默认采用。</p>
    <fieldset className="clp-settings"><legend>候选预算与布局边界</legend><div className="clp-parameter-grid">{parameterKeys.map(key => <label key={key}>{CAREER_LAYOUT_PARAMETER_LABELS[key]}<input type="number" value={parameterDrafts[key]} min={key === "bodyFontPt" && input?.parameters?.bodyFontPt === 8 ? 8 : CAREER_LAYOUT_PARAMETER_BOUNDS[key][0]} max={CAREER_LAYOUT_PARAMETER_BOUNDS[key][1]} step={CAREER_LAYOUT_PARAMETER_BOUNDS[key][2]} disabled={busy} onChange={event => setParameterDrafts(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div><p>最多3轮、9个候选；每个候选重新渲染。字号不新降到9磅以下，原有8磅可保留。模板、字段、经历、数字单位和引用不由模型随意更换。</p><label>建议模式<select value={mode} disabled={busy} onChange={event => { setMode(event.target.value as "layout" | "wording"); setModelConsent(false); }}><option value="layout">仅调整布局，不调用改写模型</option><option value="wording">布局与措辞（需固定模型及独立等义审查）</option></select></label>
      {mode === "wording" && <><p>{props.model ? `固定模型：${props.model.label ?? "宿主授权的改写与独立审查Adapter"} · ${props.model.location === "local" ? "本地推理" : props.model.location === "cloud" ? "云端推理" : "推理位置未证实，可能发送云端"}` : "未接入授权的改写与独立等义审查；不会调用其他付费通道或伪造模型结果。"}</p><label className="clp-checkbox"><input type="checkbox" checked={modelConsent} disabled={!props.model || busy} onChange={event => setModelConsent(event.target.checked)} />允许本次将简历原句、保护实体与排版诊断发送给上述固定Adapter，用于有界改写及独立等义审查</label></>}
      <div className="clp-actions"><button type="button" onClick={runCompiler} disabled={busy || adoptionAttempted || !input || (mode === "wording" && (!props.model || !modelConsent))}><ScanLine size={15} aria-hidden="true" />测量并生成建议</button><button type="button" onClick={createManualCandidate} disabled={busy || adoptionAttempted || !input}>生成手动布局提案</button>{busy && <button type="button" onClick={() => active.current?.abort()}>取消本次操作</button>}</div>
    </fieldset>
    <div className="clp-messages" aria-live="polite">{working && <p role="status">{working}… 已启动 {renderCount} 次实际DOM渲染</p>}{error && <p role="alert" className="clp-error">{error}</p>}{notice && <p role="status">{notice}</p>}{adoptionReceipt && <p className="clp-receipt"><Check size={14} aria-hidden="true" />版本回执：{adoptionReceipt.versionId}{adoptionReceipt.receiptId ? ` · ${adoptionReceipt.receiptId}` : ""}</p>}</div>
    {result?.baseline?.status === "diagnosed" && <LayoutReportView title="原稿测量" report={result.baseline} onLocateAnchor={props.onLocateAnchor} />}
    {result && <details className="clp-events"><summary>有界执行记录 · {result.iterations}轮 / {result.renderedCandidates}次渲染 / {statusLabels[result.status]}</summary><p>下列是Adapter的原始执行记录，不是事实或最终文件的认证。</p><p>{result.reason}</p><ol>{result.events.map((event, index) => <li key={index}>第{event.iteration}轮 · {eventLabels[event.kind]} · {event.candidateId ?? "候选预算"}：{event.reason}</li>)}</ol></details>}
    {candidate && input && <section className="clp-proposal" aria-label="候选差异确认"><h3>待确认差异</h3><p>未勾选的差异不会提交。改写会清除原句按字符位置保存的局部样式，避免新文字继承错误偏移；原稿和历史不会在此处修改。</p>
      {changedParameters.length > 0 && <div className="clp-layout-diff"><label className="clp-checkbox"><input type="checkbox" checked={selectedLayout} disabled={busy || adoptionAttempted} onChange={event => { setSelectedLayout(event.target.checked); invalidateSelection(); }} />确认这组布局参数差异</label><dl>{changedParameters.map(change => <div key={change.key}><dt>{change.key === "bulletGapMm" ? "Bullet间距（当前不支持采用）" : CAREER_LAYOUT_PARAMETER_LABELS[change.key]}</dt><dd>{numberText(change.before)} → {numberText(change.after)}</dd></div>)}</dl></div>}
      {changedTexts.map((replacement, index) => <article key={replacement.anchor} className="clp-text-diff"><label className="clp-checkbox"><input type="checkbox" checked={selectedAnchors.includes(replacement.anchor)} disabled={busy || adoptionAttempted} onChange={event => { setSelectedAnchors(previous => event.target.checked ? [...previous, replacement.anchor] : previous.filter(anchor => anchor !== replacement.anchor)); invalidateSelection(); }} />确认第{index + 1}条文案差异 <code>{replacement.anchor}</code></label><div><strong>原句</strong><p>{replacement.before}</p></div><div><strong>候选</strong><p>{replacement.after}</p></div>{props.onLocateAnchor && <button type="button" onClick={() => props.onLocateAnchor!(replacement.anchor)}>定位原文</button>}</article>)}
      {!changedParameters.length && !changedTexts.length && <p>候选没有实际变化，不能创建空采用请求。</p>}
      {candidateReport && <LayoutReportView title="整组候选的DOM估算（不是所选子集）" report={candidateReport} onLocateAnchor={props.onLocateAnchor} />}
      <button type="button" onClick={reviewSelection} disabled={busy || adoptionAttempted || (!selectedLayout && !selectedAnchors.length)}>复测已勾选差异</button>
      {selectionReview && <div className="clp-selection-review"><LayoutReportView title="已勾选差异的独立复测" report={selectionReview.report} onLocateAnchor={props.onLocateAnchor} /><button type="button" onClick={() => setShowPreview(value => !value)}>{showPreview ? "收起" : "查看"}所选候选纸张预览</button>{previewProjection && <div className="clp-preview-viewport" aria-label="只读候选纸张预览"><ResumeTemplate resume={previewProjection} templateId={resolveResumeTemplate(previewProjection.templateId)} /></div>}<p>剩余 {selectionReview.report.issues.length} 项测量提示。留白可能是设计选择；未收敛不代表事实错误，也不自动授予采用权限。</p><label className="clp-checkbox"><input type="checkbox" checked={adoptionConsent} disabled={busy || adoptionAttempted || !props.onAdopt} onChange={event => setAdoptionConsent(event.target.checked)} />我已阅读所选差异与这次复测结果，仅确认采用这些变化；仍需分别核对最终PDF和DOCX</label><button type="button" onClick={adoptSelection} disabled={busy || adoptionAttempted || !props.onAdopt || !adoptionConsent}>确认采用所选差异</button>{!props.onAdopt && <p>尚未接入工作区业务版本命令，不会把本地投影假称为已保存。</p>}{adoptionAttempted && !adoptionReceipt && <p>本原稿已发出过采用请求；请先到工作区核对结果，禁止在此自动重试。</p>}</div>}
    </section>}
    <section className="clp-final-files" aria-label="最终导出文件独立诊断"><h3>最终文件独立诊断</h3><p>这里生成实际导出文件并解析其真实页数、文字放置和链接，不接受用户或模型填写的页级指标。PDF与DOCX分别保留结果，绝不把DOM估算改名为最终文件通过。</p>
      <label>最终文件检查对象<select value={finalTarget} disabled={busy || adoptionAttempted} onChange={event => { setFinalTarget(event.target.value as "source" | "selection"); setFinalChecks(emptyFinalChecks()); setFinalExportConsent(false); }}><option value="source">本授权版本的原稿</option><option value="selection" disabled={!selectionReview}>已独立复测的所选候选（尚未采用）</option></select></label>
      <label className="clp-checkbox"><input type="checkbox" checked={finalExportConsent} disabled={busy || adoptionAttempted || !props.exportFinalArtifact || (finalTarget === "selection" && !selectionReview)} onChange={event => setFinalExportConsent(event.target.checked)} />允许本次调用接入的受信导出器生成所选版本的实际文件；不授权改写事实、采用候选或公开发布</label>
      <div className="clp-actions">{(["pdf", "docx"] as const).map(format => <button key={format} type="button" disabled={busy || adoptionAttempted || !props.exportFinalArtifact || !finalExportConsent || (finalTarget === "selection" && !selectionReview)} onClick={() => void checkFinalFile(format)}>生成并检查{format.toUpperCase()}</button>)}</div>
      {!props.exportFinalArtifact && <p>尚未接入本机受信最终文件导出Adapter；PDF与DOCX保持“未核对”，不会用DOM、mammoth正文或自报指标伪造分页。</p>}
      {adoptionAttempted && <p>本授权版本已发出采用请求；请在工作区核对并重新授权新版本，再生成其最终文件。</p>}
      <div className="clp-final-grid">{(["pdf", "docx"] as const).map(format => { const state = finalChecks[format]; return <section key={format} className="clp-final-result" aria-label={`最终${format.toUpperCase()}诊断`}><h4>{format.toUpperCase()} · {finalCheckSummary(state)}</h4>{state.status === "diagnosed" ? <><p>对象：{state.context.renderBinding.candidateId === "original-source" ? "本授权原稿" : "已复测候选（未因此采用）"} · 实际{state.report.pages.length}页。逐页视觉：尚未核对。</p><p>正文：{integrityLabel(state.bodyTextCheck.status)}；链接：{integrityLabel(state.linkCheck.status)}（缺失{state.linkCheck.missingCount} / 额外{state.linkCheck.unexpectedCount}）。</p><dl><div><dt>实际文件SHA-256</dt><dd><code>{state.artifact.sha256}</code></dd></div>{state.renderedPdf && <div><dt>DOCX分页PDF SHA-256</dt><dd><code>{state.renderedPdf.sha256}</code></dd></div>}<div><dt>受信渲染器与回执</dt><dd>{state.receipt.renderer.name} {state.receipt.renderer.version} · {state.receipt.id}</dd></div></dl><div className="clp-actions"><button type="button" disabled={busy || adoptionAttempted} onClick={() => downloadFinalFile(state.artifact, format)}>下载本次实际{format.toUpperCase()}文件</button>{state.renderedPdf && <button type="button" disabled={busy || adoptionAttempted} onClick={() => downloadFinalFile(state.renderedPdf!, "pdf")}>下载本次DOCX分页PDF</button>}</div><LayoutReportView title={`最终${format.toUpperCase()}页级观察`} report={state.report} onLocateAnchor={props.onLocateAnchor} /><details><summary>文件核对边界与正文方法</summary><p>{state.bodyTextCheck.method}</p><p>{state.linkCheck.method}</p><ul>{state.limitations.map(item => <li key={item}>{item}</li>)}</ul></details></> : state.status === "not-run" ? <p>未执行该格式的最终文件检查。</p> : state.status === "running" ? <p role="status">正在生成并读取实际文件；尚无通过结论。</p> : <p role="status">{state.detail}</p>}</section>; })}</div>
    </section>
    <div ref={stage} className="career-layout-measurement" aria-hidden="true" inert>{renderProjection && <ResumeTemplate resume={renderProjection} templateId={resolveResumeTemplate(renderProjection.templateId)} />}</div>
  </section>;
}

function integrityLabel(status: "verified" | "mismatch" | "unknown") { return status === "verified" ? "字符/链接核对一致" : status === "mismatch" ? "发现不一致，未通过完整性核对" : "未知，不能判定通过"; }
function finalCheckSummary(state: FinalCheckState): string {
  return state.status === "not-run" ? "尚未核对" : state.status === "running" ? "正在读取实际文件" : state.status === "diagnosed" ? `已取得${state.report.pages.length}页观察，视觉未核对`
    : state.status === "stale" ? "版本失效" : state.status === "cancelled" ? "已取消，未通过" : state.status === "timeout" ? "超时，未通过" : "观察不可用";
}
function LayoutReportView({ title, report, onLocateAnchor }: { title: string; report: LayoutDiagnosis; onLocateAnchor?: (anchor: string) => void }) {
  const final = report.source !== "dom-estimate", pageLabel = final ? "实际" : "估算", sourceLabel = final ? `最终${report.source === "pdf-final" ? "PDF" : "DOCX分页文件"}观察` : "DOM估算";
  return <section className="clp-report" aria-label={title}><h3>{title}</h3><p>{sourceLabel}：{report.pages.length}页 · {report.issues.length}项提示 · 问题罚分 {report.penalty}（不是简历质量或录用概率）</p><div className="clp-page-summary">{report.pages.map(page => <span key={page.pageNumber}>{pageLabel}第{page.pageNumber}页：{page.lineCount}行 / 页尾留白 {Math.round(page.trailingWhitespaceRatio * 100)}%</span>)}</div>{report.issues.length ? <ul>{report.issues.map(issue => <li key={issue.id} className={`clp-issue-${issue.severity}`}><strong>{issueLabels[issue.kind]} · {pageLabel}第{issue.pageNumber}页</strong><p>{issue.kind === "trailing-whitespace" ? "测量到较大页尾空白，也可能是有意设计，不自动填充或删除经历。" : issue.kind === "orphan-page" ? final ? "实际分页文件的末页仅有少量文字，需结合逐页图像核对。" : "估算末页仅有少量正文，需最终文件确认分页。" : issue.kind === "short-last-line" ? "实际文字末行相对前行很短，可考虑不改变事实的布局或措辞候选。" : issue.kind === "stranded-heading" ? final ? "实际页级文字显示标题与同栏后续内容可能分离，需视觉复核。" : "标题可能跨页，或与同栏后续内容分离；需最终文件复核。" : "实际盒或文字行超出当前可打印区域，或被容器裁切。"}</p>{issue.anchor && <code>{issue.anchor}</code>}{issue.anchor && onLocateAnchor && <button type="button" onClick={() => onLocateAnchor(issue.anchor!)}>定位此处</button>}</li>)}</ul> : <p>未测到配置内问题；{final ? "这不等于逐页视觉、事实或语义验收通过。" : "这不是最终文件、事实或语义认证。"}</p>}<details><summary>本次观测的边界</summary><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details></section>;
}
