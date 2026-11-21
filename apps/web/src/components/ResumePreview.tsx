import { downloadResumeMarkdown } from "../lib/resume-markdown-download";
import { useUiPreferences } from "../lib/ui-preferences";
import { useState, useRef, useLayoutEffect, useEffect, useCallback, useId, useMemo } from "react";
import { projectedResumeToMarkdown, projectedResumeToRenderCvYaml, type ProjectedResume, type ResumeView } from "@better-me/core";
import { getResumePrintCss } from "../lib/resume-print";
import { canExportDocxPhoto, projectedResumeToDocx } from "../lib/docx-export";
import { Printer, FileDown, Copy, Check, Layout, ZoomIn, ZoomOut, User, Maximize2, ScanLine, HelpCircle, FileSearch, Scissors } from "lucide-react";
import "./skill-evidence-atlas.css";
import { Button, SegmentedControl, SplitButton, type SplitButtonMenuEntry } from "../design-system";
import { RESUME_TEMPLATES, resolveResumeTemplate, ResumeTemplate } from "./ResumeTemplate";
import { getTemplateUiMetadata, TEMPLATE_SOURCES } from "./template-catalog";
import { getFitPreviewZoom, getPreviewScrollTop, resolvePreviewAnchor, type PreviewFollowTarget } from "../lib/preview-follow";
import "./resume-design.css";
import { Hand } from "lucide-react";
import { usePreviewPan } from "./usePreviewPan";
import "./preview-pan.css";

type Props = {
  resume: ProjectedResume;
  onTemplateChange?: (templateId: string) => void;
  view?: ResumeView;
  onViewChange?: (view: ResumeView) => void;
  followTarget?: PreviewFollowTarget | null;
  onSelectAnchor?: (anchor: string) => void;
  onOpenAtsDiagnostics?: () => void;
};

const FOLLOW_PREFERENCE_KEY = "betterme.preview.follow.v1";
/** Standard A4 page height in CSS pixels at 96dpi (297mm ≈ 1122.5px). */
const A4_PAGE_HEIGHT_PX = 1122.5;

export function toAtsPlainText(markdown: string): string {
  return markdown
    // Strip embedded images (including base64 data URIs), which ATS text parsers ignore.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ResumePreview({ resume, onTemplateChange, view, onViewChange, followTarget, onSelectAnchor, onOpenAtsDiagnostics }: Props) {
  const { t, locale } = useUiPreferences();
  const printHint = t("在打印窗口选择「另存为 PDF」。如果预览出现日期、标题或网址，请关闭「页眉和页脚」（Chrome：更多设置），并逐页检查。", "Choose Save as PDF in the print dialog. If a date, title or URL appears, turn off Headers and footers (Chrome: More settings) and check each page.");

  const [previewMode, setPreviewMode] = useState<"visual" | "ats">("visual");
  const [showPageBreaks, setShowPageBreaks] = useState(true);
  const [pageCount, setPageCount] = useState(1);
  const [atsCopied, setAtsCopied] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [exportNotes, setExportNotes] = useState<string[]>([]);
  const [docxExporting, setDocxExporting] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const helpPanelRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const paperRef = useRef<HTMLDivElement>(null);
  const animatedTemplateRef = useRef<string | null>(null);
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
  const template = getTemplateUiMetadata(templateId, locale);
  const isAts = templateId === "en-ats";
  const hasExportablePhoto = useMemo(() => !isAts && showAvatar && canExportDocxPhoto(resume.profile.avatarUrl),
    [isAts, showAvatar, resume.profile.avatarUrl]);
  useLayoutEffect(() => {
    if (previewMode !== "visual") return;
    const measure = () => {
      const sheet = paperRef.current?.querySelector<HTMLElement>(".resume-sheet") ?? paperRef.current;
      if (!sheet) return;
      const height = sheet.scrollHeight || sheet.offsetHeight;
      if (height > 0) {
        setPageCount(Math.max(1, Math.ceil((height - 10) / A4_PAGE_HEIGHT_PX)));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !paperRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(paperRef.current);
    const sheet = paperRef.current.querySelector<HTMLElement>(".resume-sheet");
    if (sheet) observer.observe(sheet);
    return () => observer.disconnect();
  }, [previewMode, resume, templateId, showAvatar]);

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

  useEffect(() => {
    if (!isHelpOpen) return;
    const close = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setIsHelpOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsHelpOpen(false);
      if (helpRef.current?.contains(event.target as Node)) { event.stopPropagation(); helpTriggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [isHelpOpen]);

  useLayoutEffect(() => {
    const panel = isHelpOpen ? helpPanelRef.current : null;
    if (!panel) return;
    const place = () => {
      if (helpTriggerRef.current && helpPanelRef.current) {
        const toolbar = helpTriggerRef.current.closest(".preview-toolbar");
        if (toolbar) helpPanelRef.current.style.top = `${helpTriggerRef.current.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().top + 9}px`;
      }
    };
    place();
    panel.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [isHelpOpen]);

  // Animate only an explicit template change. Typing, zooming and saving keep
  // the same paper DOM and never restart a presentation animation.
  useEffect(() => {
    const previousTemplate = animatedTemplateRef.current;
    animatedTemplateRef.current = templateId;
    if (previousTemplate === null || previousTemplate === templateId) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = paperRef.current?.animate?.(
      [{ opacity: .65, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    // Interrupting a presentation transition is expected when switching again.
    // Consume the platform's rejected finished promise before canceling it.
    void animation?.finished?.catch(() => {});
    return () => animation?.cancel();
  }, [templateId]);

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

  const pan = usePreviewPan(canvasRef, pauseForManualPreview);
  const panHelpId = useId();
  function fitWidth() {
    pauseForManualPreview();
    setFitMode(true);
    updateFitWidth();
    if (canvasRef.current) { canvasRef.current.scrollLeft = 0; canvasRef.current.scrollTop = 0; }
  }
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
      setCopyError(t("复制失败，请使用「下载 MD」保存文件。", "Copy failed. Use Download MD to save the file."));
    }
  }

  function handleDownloadMarkdown() {
    downloadResumeMarkdown(resume, view?.careerTaskReceipt ? view.name : undefined);
  }

  function handleRenderCvExport() {
    try {
      const result = projectedResumeToRenderCvYaml(resume);
      const url = URL.createObjectURL(new Blob([result.yaml], { type: "application/yaml;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `better-me-rendercv-${resume.locale}.yaml`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNotes([t(`已导出 RenderCV ${result.targetVersion} YAML；需在本地 RenderCV 中渲染。`, `Exported RenderCV ${result.targetVersion} YAML; render it with local RenderCV.`), ...(resume.themeId ? [t("RenderCV 使用自身的主题与字体设置；本次 YAML 不复现所选简历主题。保留纸面风格请导出 PDF。", "RenderCV uses its own theme and font settings. This YAML does not reproduce the selected resume theme. Export PDF to keep the paper styling.")] : []), ...result.diagnostics.map((item) => item.message)]);
    } catch (err) { setCopyError(err instanceof Error ? err.message : t("RenderCV 导出失败。", "RenderCV export failed.")); }
  }

  async function handleDocxExport(includePhoto: boolean) {
    if (docxExporting) return;
    setDocxExporting(true);
    setCopyError("");
    try {
      const result = await projectedResumeToDocx(resume, { includePhoto: includePhoto && hasExportablePhoto });
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNotes([t("已生成 DOCX 下载，请在 Word 或兼容编辑器中检查分页和本机字体。", "DOCX download created. Check page breaks and local fonts in Word or a compatible editor."), ...result.diagnostics]);
    } catch (err) {
      setCopyError(err instanceof Error ? t(`DOCX 导出失败：${err.message}`, `DOCX export failed: ${err.message}`) : t("DOCX 导出失败，请重试。", "DOCX export failed. Try again."));
    } finally {
      setDocxExporting(false);
    }
  }

  async function handlePdfExport() {
    const desktopPdf = window.desktopApi?.exportPdf;
    if (!desktopPdf) {
      window.print();
      return;
    }
    if (pdfExporting) return;
    setPdfExporting(true);
    setCopyError("");
    try {
      const candidateName = resume.profile.displayName.trim() || "better-me";
      const result = await desktopPdf(`${candidateName}-resume-${resume.locale}.pdf`);
      if (result.cancelled) return;
      if (result.ok && result.filePath) {
        setExportNotes([t(`已将高保真 A4 PDF 保存至：${result.filePath}`, `Saved A4 PDF to: ${result.filePath}`)]);
      } else {
        setCopyError(result.error ?? t("PDF 导出失败，请重试。", "PDF export failed. Try again."));
      }
    } catch (err) {
      setCopyError(err instanceof Error ? t(`PDF 导出失败：${err.message}`, `PDF export failed: ${err.message}`) : t("PDF 导出失败，请重试。", "PDF export failed. Try again."));
    } finally {
      setPdfExporting(false);
    }
  }

  return (
    <section className="resume-preview flex min-h-0 flex-col overflow-hidden" aria-label={t("简历预览", "Resume preview")}>
      <style media="print">{getResumePrintCss(resume)}</style>
      <div className="preview-toolbar no-print">
        <div className="preview-toolbar-main">
          <div className="preview-template-control">
            <label htmlFor="resume-template"><Layout size={15} aria-hidden="true" />{t("模板", "Template")}</label>
            <select id="resume-template" value={templateId} onChange={(event) => { if (onTemplateChange) onTemplateChange(event.target.value); else if (view && onViewChange) onViewChange({ ...view, templateId: event.target.value, updatedAt: new Date().toISOString() }); }}>
              {TEMPLATE_SOURCES.map((source) => <optgroup key={source.id} label={source[locale]}>{RESUME_TEMPLATES.filter((item) => item.source === source.id).map((item) => <option key={item.id} value={item.id}>{getTemplateUiMetadata(item.id, locale).name}</option>)}</optgroup>)}
            </select>
          </div>
          <div className="preview-export-actions">
            <div className="preview-help" ref={helpRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsHelpOpen(false); }}>
              <Button ref={helpTriggerRef} variant="ghost" size="sm" iconOnly className="preview-icon-button" aria-label={t("预览与导出说明", "Preview and export information")} aria-expanded={isHelpOpen} aria-controls={helpId} onClick={() => setIsHelpOpen((value) => !value)}><HelpCircle size={15} /></Button>
              {isHelpOpen && <div ref={helpPanelRef} id={helpId} className="preview-help-panel" role="region" aria-label={t("预览与导出说明", "Preview and export information")}>
                <strong>{template.name}</strong><p>{template.description}</p>
                <p>{t("缩放仅影响预览。DOCX 为可编辑单栏文档，默认省略照片；预览显示支持的本地照片时，可选择带照片的 DOCX。PDF 保留所选模板。", "Zoom affects preview only. The editable, single-column DOCX omits photos by default. If a supported local photo is visible, you can export a DOCX with it. PDF keeps the selected template.")}</p>
                <p>{printHint}</p>
              </div>}
            </div>
            <SplitButton
              variant="primary"
              size="sm"
              primaryLabel={pdfExporting ? t("正在导出…", "Exporting…") : t("导出", "Export")}
              primaryAriaLabel={t("导出 PDF / 打印", "Export PDF / Print")}
              primaryTitle={printHint}
              primaryIcon={<Printer size={14} aria-hidden="true" />}
              primaryDisabled={pdfExporting}
              primaryBusy={pdfExporting}
              onPrimaryClick={() => { setIsHelpOpen(false); void handlePdfExport(); }}
              menuLabel={t("更多导出格式", "More export formats")}
              menuHeading={t("其他格式", "Other formats")}
              items={[
                {
                  id: "docx",
                  label: docxExporting ? t("正在生成 DOCX…", "Creating DOCX…") : t("下载 DOCX", "Download DOCX"),
                  description: t("可编辑文档 · 无照片", "Editable document · no photo"),
                  badge: ".docx",
                  icon: <FileDown size={15} />,
                  disabled: docxExporting,
                  busy: docxExporting,
                  onSelect: () => { void handleDocxExport(false); },
                },
                ...(hasExportablePhoto ? [{
                  id: "docx-photo",
                  label: t("下载带照片的 DOCX", "Download photo DOCX"),
                  description: t("包含预览中的本地照片", "Includes the local photo shown in preview"),
                  badge: ".docx",
                  icon: <FileDown size={15} />,
                  disabled: docxExporting,
                  onSelect: () => { void handleDocxExport(true); },
                }] : []),
                {
                  id: "copy-md",
                  label: copied ? t("已复制 MD", "MD copied") : t("复制 MD", "Copy MD"),
                  description: t("复制为 Markdown", "Copy as Markdown"),
                  icon: copied ? <Check size={15} /> : <Copy size={15} />,
                  onSelect: () => { void handleCopyMarkdown(); },
                },
                {
                  id: "download-md",
                  label: t("下载 MD", "Download MD"),
                  description: t("纯文本与基本格式", "Text and basic formatting"),
                  badge: ".md",
                  icon: <FileDown size={15} />,
                  onSelect: handleDownloadMarkdown,
                },
                { kind: "divider", id: "rendercv-divider" },
                {
                  id: "rendercv",
                  label: t("导出 RenderCV YAML", "Export RenderCV YAML"),
                  description: t("用于本地 RenderCV", "For local RenderCV"),
                  badge: ".yaml",
                  icon: <FileDown size={15} />,
                  onSelect: handleRenderCvExport,
                },
              ] satisfies SplitButtonMenuEntry[]}
            />
          </div>
        </div>
        <div className="preview-toolbar-secondary">
          <span className="preview-paper-spec"><span className="preview-live-dot" />{t("实时预览", "Live preview")}<span className="preview-spec-divider" />A4</span>
          <div className="preview-zoom-control" role="group" aria-label={t("预览缩放", "Preview zoom controls")}>
            <button type="button" onClick={() => changeZoom(-10)} disabled={!fitMode && zoom <= 20} aria-label={t("缩小预览", "Zoom out")}><ZoomOut size={14} /></button>
            <output aria-label={t("预览缩放比例", "Preview zoom")}>{zoom}%</output>
            <button type="button" onClick={() => changeZoom(10)} disabled={!fitMode && zoom >= 130} aria-label={t("放大预览", "Zoom in")}><ZoomIn size={14} /></button>
            <button type="button" onClick={fitWidth} aria-label={t("适应预览宽度", "Fit preview width")} aria-pressed={fitMode} title={t("适应宽度，拖动分栏时自动调整", "Fit width and resize automatically when dragging the divider")}><Maximize2 size={14} /></button>
          </div>

        </div>
        {copied && !copyError && <p role="status" className="preview-feedback"><Check size={13} />{t("Markdown 已复制", "Markdown copied")}</p>}
        {copyError && <p role="status" className="preview-feedback preview-feedback-error">{copyError}</p>}
        {exportNotes.length > 0 && <details className="preview-export-notes"><summary>{t(`导出说明（${exportNotes.length}）`, `Export notes (${exportNotes.length})`)}</summary><ul role="status">{exportNotes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      </div>
      {previewMode === "ats" ? (
        <div className="bm-ats-view" role="region" aria-label={t("ATS 纯文本解析视角", "ATS plain-text parser view")}>
          {(() => {
            const plain = toAtsPlainText(projectedResumeToMarkdown(resume));
            const charCount = plain.replace(/\s+/g, "").length;
            const expCount = resume.experiences.length;
            const claimCount = resume.experiences.reduce((sum, item) => sum + item.claims.length, 0);
            return (
              <div className="bm-ats-sheet">
                <div className="bm-ats-header">
                  <div className="bm-ats-stats">
                    <strong>{t("ATS 解析器读取视角", "What a parser reads")}</strong>
                    <span>·</span>
                    <span>{t(`${charCount} 字`, `${charCount} chars`)}</span>
                    <span>·</span>
                    <span>{t(`${expCount} 段经历`, `${expCount} roles`)}</span>
                    <span>·</span>
                    <span>{t(`${claimCount} 条已展示要点`, `${claimCount} visible bullets`)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {onOpenAtsDiagnostics && (
                      <Button variant="tinted" size="xs" onClick={onOpenAtsDiagnostics}>
                        <FileSearch size={12} aria-hidden="true" />
                        <span>{t("ATS 评分与 JD 诊断", "ATS & JD Check")}</span>
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(plain);
                          setAtsCopied(true);
                          setTimeout(() => setAtsCopied(false), 1800);
                        } catch {
                          /* Clipboard may be unavailable in restricted contexts. */
                        }
                      }}
                    >
                      {atsCopied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                      <span>{atsCopied ? t("已复制纯文本", "Copied text") : t("复制纯文本", "Copy plain text")}</span>
                    </Button>
                  </div>
                </div>
                <pre className="bm-ats-pre">{plain}</pre>
              </div>
            );
          })()}
        </div>
      ) : (
        <div
          ref={canvasRef}
          className="resume-preview-canvas min-h-0 flex-1"
          data-pan-active={pan.active}
          data-panning={pan.dragging}
          {...pan.handlers}
          tabIndex={0}
          aria-describedby={panHelpId}
          aria-label={t("可滚动简历纸张", "Scrollable resume page")}
          onWheelCapture={pauseForManualPreview}
          onPointerDownCapture={pauseForManualPreview}
          onTouchStartCapture={pauseForManualPreview}
          onClick={(event) => {
            if (!onSelectAnchor || pan.active || pan.dragging) return;
            const sel = window.getSelection?.();
            if (sel && !sel.isCollapsed) return;
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-preview-anchor]") : null;
            const anchor = target?.dataset.previewAnchor;
            if (anchor) onSelectAnchor(anchor);
          }}
          onKeyDownCapture={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseForManualPreview(); }}
        >
          <div ref={stageRef} className="resume-preview-stage" onLoadCapture={followCurrentTarget}>
            <div ref={paperRef} className="resume-preview-scale" style={{ zoom: zoom / 100, position: "relative" }}>
              <ResumeTemplate resume={resume} templateId={templateId} showAvatar={showAvatar} />
              {showPageBreaks && pageCount > 1 && (
                <div className="bm-page-break-overlay no-print" aria-hidden="true">
                  {Array.from({ length: pageCount - 1 }, (_, index) => (
                    <div
                      key={index + 1}
                      className="bm-page-break-line"
                      style={{ top: `${Math.round((index + 1) * A4_PAGE_HEIGHT_PX)}px` }}
                    >
                      <span className="bm-page-break-label">
                        {t(`第 ${index + 1} 页底 · 第 ${index + 2} 页起`, `Page ${index + 1} / ${index + 2}`)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="preview-bottom no-print">
        <div className="preview-display-controls">
          <SegmentedControl
            value={previewMode}
            options={[{ value: "visual", label: t("视觉", "Visual") }, { value: "ats", label: t("ATS 解析", "ATS parser") }]}
            onChange={setPreviewMode}
            ariaLabel={t("预览视角切换", "Preview perspective")}
          />
          {previewMode === "visual" && <>
            <Button variant="ghost" size="xs" className="preview-pan-toggle" aria-pressed={pan.handMode} title={t("抓手拖动；关闭后可选择文字。也可按住空格或鼠标中键拖动。", "Drag to pan; turn off to select text. Hold Space or drag with the middle mouse button for temporary panning.")} onClick={() => { pan.setHandMode(value => !value); canvasRef.current?.focus({ preventScroll: true }); }}><Hand size={13} /><span>{t("抓手", "Pan")}</span></Button>
            <Button variant="ghost" size="xs" className="preview-follow-toggle" onClick={() => { manualPreviewRef.current = false; setFollowEnabled(value => !value); }} aria-pressed={followEnabled} title={t("跟随左侧编辑位置；手动浏览预览后，继续编辑会恢复跟随", "Follow editing; manual browsing pauses following until you edit again")}><ScanLine size={13} /><span>{t("跟随编辑", "Follow editing")}</span></Button>
            <Button variant="ghost" size="xs" aria-pressed={showPageBreaks} onClick={() => setShowPageBreaks((v) => !v)} title={t("显示或隐藏 A4 分页参考线", "Toggle A4 page break guides")}><Scissors size={12} /><span>{t(`共 ${pageCount} 页`, `${pageCount} ${pageCount === 1 ? "page" : "pages"}`)}</span></Button>
            {(view || resume.profile.avatarUrl) && <Button variant="ghost" size="xs" onClick={toggleAvatar} disabled={isAts} aria-pressed={!isAts && showAvatar} title={t("切换并保存照片显示偏好", "Toggle and save photo visibility")}><User size={13} /><span>{isAts ? t("ATS 无照片", "ATS · no photo") : showAvatar ? t("照片：显示", "Photo: shown") : t("照片：隐藏", "Photo: hidden")}</span></Button>}
          </>}
        </div>
        <span id={panHelpId} className="preview-pan-help">{previewMode === "ats" ? t("未核实指标已安全过滤", "Unverified metrics filtered") : t("点击纸张定位 · 空格拖动", "Click to edit · Space + drag")}</span>
      </div>
    </section>
  );
}
