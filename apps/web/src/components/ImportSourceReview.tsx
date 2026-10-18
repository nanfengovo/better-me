/** @jsxRuntime automatic */
import { useUiPreferences } from "../lib/ui-preferences";
import type { ResumeImportSource } from "@better-me/core";

/** Kept with the local document; source evidence never enters the printed resume. */
export function ImportSourceReview({ source }: { source?: ResumeImportSource }) {
  const { t } = useUiPreferences();

  if (!source) return null;
  function downloadSource() {
    if (!source) return;
    const content = [source.rawText, ...(source.ocrText ? [t("\n视觉模型转录（需对照原图核实）\n", "\nVisual model transcription (verify against the original image)\n"), source.ocrText] : [])].join("");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    const safeName = Array.from(source.fileName.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "_"), (character) => character.charCodeAt(0) < 32 ? "_" : character).join("");
    anchor.download = `${safeName}-${t("原文", "source")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="no-print rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700">
    <summary className="cursor-pointer font-semibold break-words">{t("导入原文与待补录 · ", "Imported source & items to review · ")}{source.unparsedLines.length ? t(`${source.unparsedLines.length} 段待核对`, `${source.unparsedLines.length} ${source.unparsedLines.length === 1 ? "section" : "sections"} to review`) : t("查看原文", "View source")}</summary>
    <div className="mt-3 space-y-3">
      <p className="break-words">{t("来源：", "Source: ")}{source.fileName}{t("。以下是导入时的提取文本快照，随本地文档和 JSON 备份保存，不进入对外简历。原文件、原版式及后续修改未包含在此快照中，请保留原 PDF / Word。", ". This extracted text snapshot is saved with the local document and JSON backup and is excluded from the resume. It does not include the original file, layout or later edits. Keep the original PDF / Word file.")}</p>
      {source.unparsedLines.length > 0 && <section aria-label={t("待补录原文", "Source text to review")}>
        <p className="font-semibold text-amber-800">{t("以下内容尚未成为结构化事实，请对照原文件核对后补录；标有“AI 部分提取”的片段是模型输出，需要另行核实。", "This content is not yet structured into facts. Check the original file before adding it. Segments marked AI partial extraction are model output and require separate verification.")}</p>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-200 bg-amber-50 p-3">{source.unparsedLines.join("\n")}</pre>
      </section>}
      <details><summary className="cursor-pointer">{t("展开完整提取原文", "Expand all extracted source text")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3">{source.rawText}</pre></details>
      {source.ocrText && <details><summary className="cursor-pointer">{t("视觉模型转录（未核实，请对照原图）", "Visual model transcription (unverified; compare with the original image)")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3">{source.ocrText}</pre></details>}
      <button type="button" onClick={downloadSource} className="rounded border border-slate-200 px-3 py-1.5 font-medium">{t("下载导入原文", "Download imported source text")}</button>
    </div>
  </details>;
}
