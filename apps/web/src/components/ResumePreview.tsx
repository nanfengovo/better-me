import { useState } from "react";
import { projectedResumeToMarkdown, type ProjectedResume } from "@better-me/core";
import { Printer, FileDown, Copy, Check, Layout, ZoomIn, ZoomOut, User } from "lucide-react";
import { RESUME_TEMPLATES, resolveResumeTemplate, ResumeTemplate } from "./ResumeTemplate";

type Props = {
  resume: ProjectedResume;
  onTemplateChange?: (templateId: string) => void;
};

export function ResumePreview({ resume, onTemplateChange }: Props) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [showAvatar, setShowAvatar] = useState(true);
  const templateId = resolveResumeTemplate(resume.templateId);
  const template = RESUME_TEMPLATES.find((item) => item.id === templateId)!;
  const isAts = templateId === "en-ats";

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
      <div className="no-print border-b border-[var(--color-line)] bg-white px-4 py-3 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layout className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <label htmlFor="resume-template" className="text-xs font-bold text-slate-700">模板</label>
            <select id="resume-template" value={templateId} onChange={(event) => onTemplateChange?.(event.target.value)} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 outline-none focus:border-[var(--color-accent)]">
              {RESUME_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="mr-1 flex items-center gap-1 border-r border-slate-200 pr-2">
              <button type="button" onClick={() => setZoom((value) => Math.max(70, value - 10))} disabled={zoom === 70} className="rounded p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30" aria-label="缩小预览"><ZoomOut className="h-3.5 w-3.5" /></button>
              <output className="w-9 text-center font-mono text-[11px] text-slate-500" aria-label="预览缩放比例">{zoom}%</output>
              <button type="button" onClick={() => setZoom((value) => Math.min(120, value + 10))} disabled={zoom === 120} className="rounded p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30" aria-label="放大预览"><ZoomIn className="h-3.5 w-3.5" /></button>
            </div>
            {resume.profile.avatarUrl && (
              <button type="button" onClick={() => setShowAvatar((value) => !value)} disabled={isAts} aria-pressed={!isAts && showAvatar} title={isAts ? "简洁 ATS 模板固定不显示照片" : "切换预览和打印中的照片"} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50">
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
      <div className="resume-preview-canvas min-h-0 flex-1" tabIndex={0} aria-label="可滚动简历纸张">
        <div className="resume-preview-stage">
          <div className="resume-preview-scale" style={{ zoom: zoom / 100 }}>
            <ResumeTemplate resume={resume} templateId={templateId} showAvatar={showAvatar} />
          </div>
        </div>
      </div>
    </section>
  );
}
