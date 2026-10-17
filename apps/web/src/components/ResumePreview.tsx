import { useState, useRef, useLayoutEffect, useEffect, useCallback } from "react";
import { getResumeLayout, projectedResumeToMarkdown, type ProjectedResume, type ResumeView } from "@better-me/core";
import { Printer, FileDown, Copy, Check, Layout, ZoomIn, ZoomOut, User, Maximize2, ScanLine } from "lucide-react";
import { RESUME_TEMPLATES, resolveResumeTemplate, ResumeTemplate } from "./ResumeTemplate";
import { getFitPreviewZoom, getPreviewScrollTop, resolvePreviewAnchor, type PreviewFollowTarget } from "../lib/preview-follow";
import "./resume-design.css";

type Props = {
  resume: ProjectedResume;
  onTemplateChange?: (templateId: string) => void;
  view?: ResumeView;
  onViewChange?: (view: ResumeView) => void;
  followTarget?: PreviewFollowTarget | null;
};

const FOLLOW_PREFERENCE_KEY = "betterme.preview.follow.v1";

export function ResumePreview({ resume, onTemplateChange, view, onViewChange, followTarget }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [zoom, setZoom] = useState(80);
  const [fitMode, setFitMode] = useState(true);
  const [followEnabled, setFollowEnabled] = useState(() => {
    try { return localStorage.getItem(FOLLOW_PREFERENCE_KEY) !== "false"; }
    catch { return true; }
  });
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<HTMLElement | null>(null);
  const previousTargetRef = useRef<PreviewFollowTarget | null | undefined>(null);
  const manualPreviewRef = useRef(false);
  const [localShowAvatar, setLocalShowAvatar] = useState(true);
  const showAvatar = view ? view.profileVisibility?.photo !== false : localShowAvatar;
  function toggleAvatar() {
    if (view && onViewChange) onViewChange({ ...view, profileVisibility: { ...view.profileVisibility, photo: !showAvatar }, updatedAt: new Date().toISOString() });
    else setLocalShowAvatar((value) => !value);
  }
  const templateId = resolveResumeTemplate(resume.templateId);
  const template = RESUME_TEMPLATES.find((item) => item.id === templateId)!;
  const isAts = templateId === "en-ats";
  const pageMargin = Math.max(12, Math.min(28, getResumeLayout(resume.layout).pageMargin));
  const updateFitWidth = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const style = getComputedStyle(stage);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    setZoom(getFitPreviewZoom(canvas.clientWidth, padding));
  }, []);

  const followCurrentTarget = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || manualPreviewRef.current) return;
    if (!followEnabled || !followTarget) {
      highlightedRef.current?.removeAttribute("data-preview-followed");
      highlightedRef.current = null;
      return;
    }
    const anchor = resolvePreviewAnchor(canvas.querySelectorAll<HTMLElement>("[data-preview-anchor]"), followTarget);
    highlightedRef.current?.removeAttribute("data-preview-followed");
    highlightedRef.current = anchor ?? null;
    if (!anchor) return;
    anchor.setAttribute("data-preview-followed", "true");
    const anchorRect = anchor.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const top = getPreviewScrollTop({
      anchorTop: anchorRect.top, anchorHeight: anchorRect.height,
      canvasTop: canvasRect.top, canvasBorderTop: canvas.clientTop,
      scrollTop: canvas.scrollTop, viewportHeight: canvas.clientHeight, scrollHeight: canvas.scrollHeight,
    }, followTarget);
    // This assignment deliberately affects only our canvas, never the editor or page.
    if (Math.abs(canvas.scrollTop - top) > .5) canvas.scrollTop = top;
  }, [followEnabled, followTarget]);

  useLayoutEffect(() => {
    if (previousTargetRef.current !== followTarget) {
      previousTargetRef.current = followTarget;
      manualPreviewRef.current = false;
    }
    followCurrentTarget();
  }, [followTarget, followCurrentTarget, resume, zoom, showAvatar]);

  useEffect(() => {
    if (!followEnabled) {
      highlightedRef.current?.removeAttribute("data-preview-followed");
      highlightedRef.current = null;
    }
    try { localStorage.setItem(FOLLOW_PREFERENCE_KEY, String(followEnabled)); }
    catch { /* A UI preference must not interfere with document saving. */ }
  }, [followEnabled]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (fitMode) updateFitWidth();
        followCurrentTarget();
      });
    };
    if (fitMode) updateFitWidth();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(canvas);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, [fitMode, updateFitWidth, followCurrentTarget]);

  function fitWidth() { setFitMode(true); updateFitWidth(); }
  function changeZoom(delta: number) { setFitMode(false); setZoom((value) => Math.max(20, Math.min(130, value + delta))); }
  function pauseForManualPreview() {
    manualPreviewRef.current = true;
    highlightedRef.current?.removeAttribute("data-preview-followed");
    highlightedRef.current = null;
  }

  async function handleCopyMarkdown() {
    try {
      await navigator.clipboard.writeText(projectedResumeToMarkdown(resume));
      setCopied(true);
      setCopyError("");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("复制失败，请使用「下载 MD」保存文件。");
    }
  }

  function handleDownloadMarkdown() {
    const blob = new Blob([projectedResumeToMarkdown(resume)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // eslint-disable-next-line no-control-regex -- Windows filenames must exclude ASCII control characters.
    link.download = `resume-${resume.locale}-${resume.profile.displayName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="resume-preview flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-slate-100/70 shadow-sm" aria-label="简历预览">
      <style media="print">{`@page { size: A4; margin: ${pageMargin}mm; }`}</style>
      <div className="no-print border-b border-[var(--color-line)] bg-white px-4 py-3 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layout className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <label htmlFor="resume-template" className="text-xs font-bold text-slate-700">模板</label>
            <select id="resume-template" value={templateId} onChange={(event) => { if (onTemplateChange) onTemplateChange(event.target.value); else if (view && onViewChange) onViewChange({ ...view, templateId: event.target.value, updatedAt: new Date().toISOString() }); }} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 outline-none focus:border-[var(--color-accent)]">
              {RESUME_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 flex items-center gap-1 border-r border-slate-200 pr-2">
              <button type="button" onClick={() => changeZoom(-10)} disabled={!fitMode && zoom <= 20} className="rounded p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30" aria-label="缩小预览"><ZoomOut className="h-3.5 w-3.5" /></button>
              <output className="w-9 text-center font-mono text-[11px] text-slate-500" aria-label="预览缩放比例">{zoom}%</output>
              <button type="button" onClick={() => changeZoom(10)} disabled={!fitMode && zoom >= 130} className="rounded p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30" aria-label="放大预览"><ZoomIn className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={fitWidth} className={`rounded p-1 ${fitMode ? "bg-emerald-50 text-emerald-800" : "text-slate-500 hover:text-slate-900"}`} aria-label="适应预览宽度" aria-pressed={fitMode} title="适应宽度，拖动分栏时自动调整"><Maximize2 className="h-3.5 w-3.5" /></button>
            </div>
            <button type="button" onClick={() => { manualPreviewRef.current = false; setFollowEnabled((value) => !value); }} aria-pressed={followEnabled} title="跟随左侧编辑位置；手动浏览预览后，继续编辑会恢复跟随" className={`preview-follow-toggle inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${followEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-600"}`}>
              <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /><span>跟随编辑</span>
            </button>
            {(view || resume.profile.avatarUrl) && (
              <button type="button" onClick={toggleAvatar} disabled={isAts} aria-pressed={!isAts && showAvatar} title={isAts ? "简洁 ATS 模板固定不显示照片" : "切换并保存照片显示偏好"} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50">
                <User className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAts ? "ATS 无照片" : showAvatar ? "照片：显示" : "照片：隐藏"}</span>
              </button>
            )}
            <button type="button" onClick={() => void handleCopyMarkdown()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}<span>{copied ? "已复制 MD" : "复制 MD"}</span>
            </button>
            <button type="button" onClick={handleDownloadMarkdown} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"><FileDown className="h-3.5 w-3.5" /><span>下载 MD</span></button>
            <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]"><Printer className="h-3.5 w-3.5" /><span>导出 PDF / 打印</span></button>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{template.description} 缩放仅影响预览。</p>
        {copyError && <p role="status" className="mt-1 text-xs text-amber-800">{copyError}</p>}
      </div>
      <div ref={canvasRef} className="resume-preview-canvas min-h-0 flex-1" tabIndex={0} aria-label="可滚动简历纸张" onWheelCapture={pauseForManualPreview} onPointerDownCapture={pauseForManualPreview} onTouchStartCapture={pauseForManualPreview} onKeyDownCapture={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseForManualPreview(); }}>
        <div ref={stageRef} className="resume-preview-stage" onLoadCapture={followCurrentTarget}>
          <div className="resume-preview-scale" style={{ zoom: zoom / 100 }}>
            <ResumeTemplate resume={resume} templateId={templateId} showAvatar={showAvatar} />
          </div>
        </div>
      </div>
    </section>
  );
}
