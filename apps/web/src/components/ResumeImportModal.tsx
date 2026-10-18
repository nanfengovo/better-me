import { useUiPreferences } from "../lib/ui-preferences";
import { useState, useRef, useEffect } from "react";
import {
  type FactBase,
  type LlmConfig,
  type ResumeParseDiagnostics,
  parseResumeWithAiWithDiagnostics,
  parseResumeWithVisionAiWithDiagnostics,
  parseResumeHeuristicallyWithDiagnostics,
} from "@better-me/core";
import { parseResumeImportJson } from "../lib/resume-import-json";
import { createCropTaskRunner } from "../lib/resume-image";
import {
  extractTextFromFile,
  type ExtractedFileResult,
  cropImageRegion,
  cropBboxFromImage,
} from "../lib/file-parsers";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Bot,
  Eye,
  RotateCw,
  X,
  ArrowRight,
  Download,
  FileCode,
  User,
  Camera,
  Crop,
  Check,
} from "lucide-react";

export interface ResumeImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  llmConfig: LlmConfig;
  onImportSuccess: (
    factBase: FactBase,
    rawText: string,
    fileName: string,
  ) => void | Promise<void>;
  onOpenAiConfig: () => void;
}

export function ResumeImportModal({
  isOpen,
  onClose,
  llmConfig,
  onImportSuccess,
  onOpenAiConfig,
}: ResumeImportModalProps) {
  const { t } = useUiPreferences();

  const [dragActive, setDragActive] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedFileResult | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Avatar state
  const [customAvatar, setCustomAvatar] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const [isRegionCropperOpen, setIsRegionCropperOpen] = useState(false);
  const [cropFileOperation, setCropFileOperation] = useState(0);
  const [recognitionImage, setRecognitionImage] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Parsing step
  const [parsedFactBase, setParsedFactBase] = useState<FactBase | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatusMsg, setParseStatusMsg] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [unparsedLines, setUnparsedLines] = useState<string[]>([]);
  const [ocrText, setOcrText] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const operationRef = useRef(0);
  const avatarOperationRef = useRef(0);
  const avatarChoiceRef = useRef<{ value: string | null; changed: boolean }>({ value: null, changed: false });

  function chooseAvatar(value: string | null) {
    avatarOperationRef.current += 1;
    avatarChoiceRef.current = { value, changed: true };
    setCustomAvatar(value);
    setParsedFactBase((current) => current ? {
      ...current, profile: { ...current.profile, avatarUrl: value ?? undefined },
    } : current);
  }

  // Preview tab: text vs images
  const [previewTab, setPreviewTab] = useState<"text" | "images">("text");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state on modal open/close
  useEffect(() => {
    if (!isOpen) {
      operationRef.current += 1;
      avatarOperationRef.current += 1;
      avatarChoiceRef.current = { value: null, changed: false };
      setExtracted(null);
      setParsedFactBase(null);
      setExtractError(null);
      setParseError(null);
      setCustomAvatar(null);
      setIsCropperOpen(false);
      setIsRegionCropperOpen(false);
      setRecognitionImage(null);
      setIsExtracting(false);
      setIsParsing(false);
      setIsImporting(false);
      setParseWarnings([]);
      setUnparsedLines([]);
      setOcrText("");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleFileProcess(file: File) {
    if (isImporting) return;
    const operation = ++operationRef.current;
    avatarOperationRef.current += 1;
    avatarChoiceRef.current = { value: null, changed: false };
    setIsExtracting(true);
    setExtracted(null);
    setIsParsing(false);
    setExtractError(null);
    setParsedFactBase(null);
    setParseError(null);
    setCustomAvatar(null);
    setRecognitionImage(null);
    setIsCropperOpen(false);
    setIsRegionCropperOpen(false);
    setParseWarnings([]);
    setUnparsedLines([]);
    setOcrText("");

    try {
      // Check if it's directly JSON
      if (file.name.toLowerCase().endsWith(".json")) {
        const text = await file.text();
        if (operation !== operationRef.current) return;
        const imported = parseResumeImportJson(text, file.name);
        const fb = imported.factBase;
        setExtracted({ fileName: file.name, fileType: "json", rawText: text,
          isScannedPdf: false, pageImages: [], detectedAvatars: [], charCount: text.length });
        setCustomAvatar(fb.profile.avatarUrl ?? null);
        setParsedFactBase(fb);
        setUnparsedLines(fb.importSource?.unparsedLines ?? []);
        setOcrText(fb.importSource?.ocrText ?? "");
        setParseWarnings([t("JSON 导入保留原有量化核实状态；请确认此文件可信。导入完整备份的事实库会重建默认视图，若要保留模板与视图配置请使用“恢复”。", "JSON import keeps existing metric verification states; ensure this file is trusted. Importing its fact base rebuilds default views. Use Restore to keep template and view settings."), ...imported.warnings]);
        return;
      }

      const res = await extractTextFromFile(file);
      if (operation !== operationRef.current) return;
      setExtracted(res);
      if (res.detectedAvatars && res.detectedAvatars.length > 0 && res.detectedAvatars[0]) {
        setCustomAvatar(res.detectedAvatars[0]);
      }
      if ((res.isScannedPdf || res.fileType === "image") && res.pageImages.length > 0) {
        setPreviewTab("images");
      } else {
        setPreviewTab("text");
      }
    } catch (err) {
      if (operation !== operationRef.current) return;
      setExtractError(
        err instanceof Error ? err.message : t("文件提取失败，请检查文件是否损坏。", "Could not extract this file. Check whether it is damaged."),
      );
    } finally {
      if (operation === operationRef.current) setIsExtracting(false);
    }
  }

  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const operation = operationRef.current;
    const avatarOperation = ++avatarOperationRef.current;
    const reader = new FileReader();
    reader.onload = (event) => {
      if (operation !== operationRef.current || avatarOperation !== avatarOperationRef.current) return;
      const dataUrl = event.target?.result as string;
      chooseAvatar(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleDrag(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void handleFileProcess(e.dataTransfer.files[0]);
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      void handleFileProcess(e.target.files[0]);
    }
    e.target.value = "";
  }

  // Parse with AI
  async function handleAiParse() {
    if (!extracted) return;
    const operation = ++operationRef.current;
    setIsParsing(true);
    setParseError(null);
    setParseWarnings([]);
    setUnparsedLines([]);
    setParseStatusMsg(t("正在调用 AI 分析简历内容并进行事实库结构化提取…", "Asking AI to analyze the resume and extract structured facts…"));

    try {
      let diagnostics: ResumeParseDiagnostics;
      if ((extracted.isScannedPdf || extracted.fileType === "image") && extracted.pageImages.length > 0) {
        setParseStatusMsg(t("正在调用视觉模型读取简历区域；请在结果中核对文字与归属…", "Reading the resume region with a vision model; verify the text and its attribution in the result…"));
        diagnostics = await parseResumeWithVisionAiWithDiagnostics(
          llmConfig,
          recognitionImage ? [recognitionImage] : extracted.pageImages,
          extracted.rawText,
          customAvatar ?? undefined,
        );
      } else {
        diagnostics = await parseResumeWithAiWithDiagnostics(
          llmConfig,
          extracted.rawText,
          customAvatar ?? undefined,
        );
      }
      if (operation !== operationRef.current) return;
      const result = diagnostics.factBase;
      const choice = avatarChoiceRef.current;
      if (choice.changed) {
        result.profile.avatarUrl = choice.value ?? undefined;
      } else if (customAvatar) {
        result.profile.avatarUrl = customAvatar;
      } else if (result.profile.avatarBbox && extracted.pageImages && extracted.pageImages[0]) {
        try {
          const cropped = await cropBboxFromImage(
            recognitionImage ?? extracted.pageImages[0],
            result.profile.avatarBbox,
          );
          if (operation !== operationRef.current) return;
          if (!avatarChoiceRef.current.changed) {
            result.profile.avatarUrl = cropped;
            setCustomAvatar(cropped);
          }
        } catch (e) {
          console.warn("Vision avatar bbox crop failed:", e);
        }
      }
      if (operation !== operationRef.current) return;
      if (avatarChoiceRef.current.changed) result.profile.avatarUrl = avatarChoiceRef.current.value ?? undefined;
      setParsedFactBase(result);
      setParseWarnings([t("AI 提取可能有遗漏或误识别，请逐项对照原文；新解析的量化指标均需你核实后才进入简历输出。", "AI extraction may omit or misread content. Compare each item with the original; newly parsed metrics require your verification before resume output."), ...diagnostics.warnings]);
      setUnparsedLines(diagnostics.unparsedLines);
      setOcrText(diagnostics.ocrText ?? "");
    } catch (err) {
      if (operation !== operationRef.current) return;
      setParseError(
        err instanceof Error ? err.message : t("AI 解析失败，请重试或使用离线规则解析。", "AI parsing failed. Try again or use offline rules."),
      );
    } finally {
      if (operation === operationRef.current) setIsParsing(false);
    }
  }

  // Parse with offline rules
  function handleHeuristicParse() {
    if (!extracted || !extracted.rawText.trim()) return;
    setIsParsing(true);
    setParseError(null);
    setParseStatusMsg(t("正在执行离线启发式规则解析…", "Parsing with offline heuristic rules…"));

    try {
      const diagnostics = parseResumeHeuristicallyWithDiagnostics(extracted.rawText);
      const result = diagnostics.factBase;
      if (customAvatar) {
        result.profile.avatarUrl = customAvatar;
      }
      setParsedFactBase(result);
      setParseWarnings(diagnostics.warnings);
      setUnparsedLines(diagnostics.unparsedLines);
    } catch (err) {
      setParseError(t("离线解析遇到异常：", "Offline parsing error:") + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsParsing(false);
    }
  }

  function preparedImport(): FactBase | null {
    if (!parsedFactBase || !extracted) return null;
    return {
      ...parsedFactBase,
      ...(extracted.fileType !== "json" ? {
        importSource: { fileName: extracted.fileName, importedAt: new Date().toISOString(), rawText: extracted.rawText, ...(ocrText ? { ocrText } : {}), unparsedLines },
      } : {}),
      profile: { ...parsedFactBase.profile, avatarUrl: avatarChoiceRef.current.changed ? avatarChoiceRef.current.value ?? undefined : customAvatar ?? parsedFactBase.profile.avatarUrl },
    };
  }

  // Confirm and replace UI resume
  async function handleConfirmImport() {
    if (!parsedFactBase || !extracted || isImporting) return;
    setIsImporting(true);
    setParseError(null);
    const finalFactBase = preparedImport();
    if (!finalFactBase) { setIsImporting(false); return; }
    try {
      await onImportSuccess(finalFactBase, extracted.rawText, extracted.fileName);
      onClose();
    } catch (error) {
      setParseError(error instanceof Error ? error.message : t("保存导入结果失败，请重试。", "Could not save the imported result. Please try again."));
    } finally { setIsImporting(false); }
  }

  // Download raw extracted text or JSON to computer
  function handleDownloadExtractedText() {
    if (!extracted) return;
    const blob = new Blob([extracted.rawText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${extracted.fileName.replace(/\.[^/.]+$/, "")}-extracted.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadParsedResult() {
    if (!parsedFactBase || !extracted) return;
    const result = { factBase: preparedImport(), unparsedLines, warnings: parseWarnings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${extracted.fileName.replace(/\.[^.]+$/, "")}-解析核对.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const canUseAi = llmConfig.provider !== "gemini" || Boolean(llmConfig.apiKey.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="flex h-[90vh] max-h-[820px] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-xs">
              <UploadCloud className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {t("导入简历与自动结构化", "Import and structure a resume")}
              </h2>
              <p className="text-xs text-slate-500">
                {t("支持 PDF、Word、图片、HTML、MD、TXT · 结构化内容导入，原版式需另保留", "PDF, Word, images, HTML, MD and TXT · Imports structured content; keep the original file for its layout")}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Step 1: Upload Dropzone if no file selected yet */}
          {!extracted && (
            <div className="space-y-4">
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 text-center transition cursor-pointer ${
                  dragActive
                    ? "border-blue-500 bg-blue-50/60"
                    : "border-slate-300 bg-slate-50/50 hover:border-blue-400 hover:bg-blue-50/20"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileInputChange}
                  accept=".pdf,.doc,.docx,.html,.htm,.md,.markdown,.txt,.json,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                />

                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 text-blue-600 mb-3">
                  <UploadCloud className="h-7 w-7" />
                </div>
                <h3 className="text-sm font-bold text-slate-800 mb-1">
                  {t("点击浏览或拖拽简历文件到此处", "Browse or drop a resume file here")}
                </h3>
                <p className="text-xs text-slate-500 max-w-md mb-4">
                  {t("提取文本后可选择离线规则或 AI 解析，核对后保存为结构化事实库（FactBase）。", "Extract text, choose offline or AI parsing, then review it before saving to your structured fact base.")}
                </p>

                {/* Badges */}
                <div className="flex flex-wrap justify-center gap-1.5 text-[11px] font-medium text-slate-600">
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    {t("📄 PDF (文字/扫描)", "📄 PDF (text/scanned)")}
                  </span>
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    📝 Word (DOCX / DOC)
                  </span>
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    🌐 HTML
                  </span>
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    ⚡ Markdown / TXT
                  </span>
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    {t("💾 JSON 备份", "💾 JSON backup")}
                  </span>
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">{t("图片 JPG / PNG / WebP", "Images: JPG / PNG / WebP")}</span>
                </div>
              </div>

              {isExtracting && (
                <div className="flex items-center justify-center gap-2 text-sm text-blue-600 font-medium py-3">
                  <RotateCw className="h-4 w-4 animate-spin" />
                  <span>{t("正在解析文档并提取内容，请稍候…", "Extracting document content. Please wait…")}</span>
                </div>
              )}

              {extractError && (
                <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/80 p-3.5 text-xs text-rose-800">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                  <div>
                    <span className="font-semibold">{t("提取出错：", "Extraction error:")}</span>
                    {extractError}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2 & 3: File Extracted Details & Strategy */}
          {extracted && (
            <div className="space-y-4">
              {/* File Info Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-xs uppercase">
                    {extracted.fileType}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-900 truncate">
                      {extracted.fileName}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {t("提取字数:", "Extracted:")} {extracted.charCount} {t("字", "characters")}
                      {extracted.numPages ? t(` · 共 ${extracted.numPages} 页`, ` · ${extracted.numPages} pages`) : ""}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadExtractedText}
                    className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 transition"
                    title={t("下载提取出的纯文本文件到电脑", "Download the extracted plain text")}
                  >
                    <Download className="h-3 w-3" />
                    <span>{t("另存文本", "Save text")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      operationRef.current += 1;
                      avatarOperationRef.current += 1;
                      avatarChoiceRef.current = { value: null, changed: false };
                      setExtracted(null);
                      setParsedFactBase(null);
                      setIsParsing(false);
                      setCustomAvatar(null);
                      setParseError(null);
                      setParseWarnings([]);
                      setUnparsedLines([]);
                      setIsCropperOpen(false);
                    }}
                    disabled={isImporting}
                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 transition"
                  >
                    {t("重新上传", "Upload another file")}
                  </button>
                </div>
              </div>

              {/* Avatar Detection & Configuration Card */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
                <div className="flex items-center gap-3">
                  <div className="relative shrink-0">
                    {customAvatar ? (
                      <img
                        src={customAvatar}
                        alt="Avatar"
                        className="h-14 w-12 rounded-md object-cover border border-slate-300 shadow-2xs"
                      />
                    ) : (
                      <div className="flex h-14 w-12 flex-col items-center justify-center rounded-md border-2 border-dashed border-slate-200 bg-slate-50 text-slate-400">
                        <User className="h-5 w-5" />
                        <span className="text-[9px] mt-0.5 font-medium">{t("无照片", "No photo")}</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-800">{t("个人证件照 / 头像", "Profile photo")}</span>
                      {extracted.detectedAvatars.length > 0 && customAvatar === extracted.detectedAvatars[0] ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-800">
                          {t("✓ 已从简历文档自动识别", "✓ Detected in the resume document")}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {customAvatar
                        ? t("已就绪，导入后将展示在简历右上角（纯净打印自适应）", "Ready. The photo appears in the resume after import and adapts to print output.")
                        : t("若文档内有证件照，可点击右侧「从简历裁剪头像」直接框选，或本地上传", "Use Crop photo from resume to select a photo in the document, or upload one from this computer.")}
                    </p>
                    {extracted.detectedAvatars && extracted.detectedAvatars.length > 1 && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <span className="text-[10px] text-slate-500 font-medium">{t("识别到的候选照片:", "Detected photo candidates:")}</span>
                        {extracted.detectedAvatars.slice(0, 4).map((avatar, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => chooseAvatar(avatar)}
                            className={`relative h-7 w-6 rounded border overflow-hidden transition cursor-pointer ${
                              customAvatar === avatar
                                ? "border-blue-600 ring-2 ring-blue-500/40"
                                : "border-slate-300 opacity-60 hover:opacity-100"
                            }`}
                            title={t(`切换为候选照片 ${idx + 1}`, `Use candidate photo ${idx + 1}`)}
                          >
                            <img src={avatar} alt={`Candidate ${idx + 1}`} className="h-full w-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {extracted.pageImages && extracted.pageImages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setCropFileOperation(operationRef.current); setIsCropperOpen(true); }}
                      className="flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50/80 px-2.5 py-1 text-xs font-semibold text-blue-700 shadow-2xs hover:bg-blue-100 transition"
                      title={t("直接在简历第 1 页上框选截取证件照", "Select and crop a photo on the resume's first page")}
                    >
                      <Crop className="h-3 w-3 text-blue-600" />
                      <span>{t("从简历裁剪头像", "Crop photo from resume")}</span>
                    </button>
                  )}
                  <input
                    type="file"
                    ref={avatarInputRef}
                    onChange={handleAvatarUpload}
                    accept="image/*"
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
                  >
                    <Camera className="h-3 w-3 text-slate-500" />
                    <span>{customAvatar ? t("更换照片", "Replace photo") : t("上传头像", "Upload photo")}</span>
                  </button>
                  {customAvatar && (
                    <button
                      type="button"
                      onClick={() => chooseAvatar(null)}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 transition"
                    >
                      {t("移除", "Remove")}
                    </button>
                  )}
                </div>
              </div>

              {extracted.fileType === "image" && <div className="rounded-xl border border-blue-200 bg-blue-50 p-3.5 text-xs text-blue-900 space-y-2">
                <p className="font-semibold">{t("图片简历：尚未识别文字，需要支持图片输入的模型。离线文字规则不适用。", "Image resume: text has not been recognized. Use a model that accepts images; offline text rules do not apply.")}</p>
                <p>{t("手机截图请裁剪到简历正文，排除状态栏、登录横幅和工具栏；可放大原图核对清晰度。点击解析才会将所选图像发往当前模型服务商。", "Crop phone screenshots to the resume content, excluding status bars, login banners and toolbars. Zoom in to check clarity. The selected image is sent to your provider only when you start parsing.")}</p>
                <div className="flex flex-wrap gap-2"><button type="button" disabled={isParsing || isImporting} className="rounded border border-blue-300 bg-white px-3 py-1.5" onClick={() => { setCropFileOperation(operationRef.current); setIsRegionCropperOpen(true); }}>{t("裁剪简历识别区域", "Crop recognition area")}</button>{recognitionImage && <button type="button" disabled={isParsing || isImporting} className="rounded border border-blue-300 bg-white px-3 py-1.5" onClick={() => { setRecognitionImage(null); setParsedFactBase(null); setUnparsedLines([]); setParseWarnings([]); }}>{t("恢复整张图片识别", "Use the full image")}</button>}</div>
                {recognitionImage && <p>{t("已选择裁剪区域；本次视觉解析仅发送此区域，原图保留用于核对。", "A crop is selected. Vision parsing sends only this region; the original stays available for review.")}</p>}
              </div>}

              {/* Scanned PDF / OCR Detection Notice */}
              {extracted.isScannedPdf && (
                <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-3.5 text-xs text-amber-900 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-amber-900">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>{t("OCR 辅助检测：该 PDF 疑似为纯图片扫描件（文字层少于 50 字）", "OCR detection: this PDF may be a scanned image (fewer than 50 text characters)")}</span>
                  </div>
                  <p className="text-amber-800 leading-relaxed pl-6">
                    {t("系统已将页面渲染为视觉图像，可调用当前配置且支持图片输入的模型，通过", "The pages are rendered as images. Your configured image capable model can use")}
                    <strong>{t("多模态视觉 OCR", "multimodal OCR")}</strong> {t("识别图片中的文字并构建结构化事实库。", "to recognize text and build a structured fact base.")}
                  </p>
                </div>
              )}

              {/* Extracted Preview Tabs */}
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-3 py-1.5 text-xs">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPreviewTab("text")}
                      className={`flex items-center gap-1 rounded px-2 py-1 font-medium transition ${
                        previewTab === "text"
                          ? "bg-white text-blue-600 shadow-2xs font-semibold"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>{t("提取文本排版预览", "Extracted text preview")}</span>
                    </button>
                    {extracted.pageImages.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setPreviewTab("images")}
                        className={`flex items-center gap-1 rounded px-2 py-1 font-medium transition ${
                          previewTab === "images"
                            ? "bg-white text-blue-600 shadow-2xs font-semibold"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>{t("页面图像渲染 (", "Rendered page images (")}{extracted.pageImages.length})</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400">{extracted.fileType === "image" ? t("图片不按文本解码", "Images are not decoded as text") : t("按文字位置重建阅读顺序，请对照原页", "Reading order reconstructed from text positions; compare with the original page")}</span>
                </div>

                <div className="p-3 max-h-56 overflow-y-auto bg-slate-900/2">
                  {previewTab === "text" ? (
                    <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed select-text">
                      {extracted.rawText || ocrText || t("（图片暂无文字层，请使用视觉解析后逐项核对）", "(No text layer. Use vision parsing and review each item.)")}
                    </pre>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {[
                        ...(recognitionImage ? [{ image: recognitionImage, label: t("本次识别区域", "Selected recognition area") }] : []),
                        ...extracted.pageImages.map((image, i) => ({ image, label: t(`原稿第 ${i + 1} 页`, `Original page ${i + 1}`) })),
                      ].map(({ image, label }) => (
                        <div key={label} className="border border-slate-200 rounded-lg overflow-hidden shadow-2xs bg-white">
                          <img
                            src={image}
                            alt={label}
                            className="w-full h-auto object-contain max-h-48"
                          />
                          <div className="p-1 text-[10px] text-center text-slate-500 font-medium bg-slate-50">
                            {label}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Parsing Action Area (If not parsed yet) */}
              {!parsedFactBase && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                  <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                    <span>{t("选择解析方式转换为标准事实库 (FactBase)", "Choose a parser to create a standard fact base")}</span>
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Strategy A: AI Parsing */}
                    <div className="flex flex-col justify-between rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
                      <div className="space-y-1.5 mb-3">
                        <div className="flex items-center gap-1.5 font-bold text-xs text-blue-900">
                          <Bot className="h-4 w-4 text-blue-600" />
                          <span>{t("AI 智能结构化解析 (推荐)", "AI structured parsing (recommended)")}</span>
                        </div>
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                          {t("调用所选模型提取姓名、经历、项目与要点，保留原文已有的中英文内容。缺失信息留待核对，不补造日期、职位或译文。", "Use the selected model to extract names, experience, projects and claims, preserving existing Chinese and English text. Missing details stay for review; dates, titles and translations are not invented.")}
                        </p>
                        <p className="text-[11px] break-words text-slate-600">{t("识别服务：", "Recognition provider:")}{llmConfig.provider} / {llmConfig.model}{t("。只在点击解析后发送当前文本或选定图像；图中的个人资料也会一并发送。", ". The text or selected images are sent only when parsing starts, including any personal information in those images.")}</p>
                      </div>

                      {canUseAi ? (
                        <button
                          type="button"
                          disabled={isParsing}
                          onClick={() => void handleAiParse()}
                          className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs py-2 shadow-xs transition disabled:opacity-60"
                        >
                          {isParsing ? (
                            <>
                              <RotateCw className="h-3.5 w-3.5 animate-spin" />
                              <span>{t("AI 正在结构化提取…", "AI is extracting structured content…")}</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-3.5 w-3.5" />
                              <span>{t("开始 AI 智能解析", "Start AI parsing")}</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-[11px] text-amber-700 bg-amber-50 p-2 rounded border border-amber-200">
                            {t("尚未配置 AI API Key（支持免费 Gemini 或本地 Ollama）", "No AI API key configured (Gemini or local Ollama supported)")}
                          </p>
                          <button
                            type="button"
                            onClick={onOpenAiConfig}
                            className="w-full rounded-lg border border-blue-300 bg-white hover:bg-blue-50 text-blue-700 font-semibold text-xs py-1.5 transition"
                          >
                            {t("前往配置 AI Key", "Configure AI key")}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Strategy B: Offline Heuristic Parsing */}
                    <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5">
                      <div className="space-y-1.5 mb-3">
                        <div className="flex items-center gap-1.5 font-bold text-xs text-slate-800">
                          <FileCode className="h-4 w-4 text-slate-600" />
                          <span>{t("离线启发式规则解析", "Offline heuristic parsing")}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          {t("纯本地离线运行，无需任何 API Key 与网络请求。基于正则表达式与排版规则智能提取联系方式、履历与项目要点。", "Runs entirely on this computer without an API key or network requests. Uses text patterns and layout rules to extract contact details, experience and project claims.")}
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={isParsing || !extracted.rawText.trim()}
                        onClick={handleHeuristicParse}
                        className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs py-2 shadow-2xs transition disabled:opacity-60"
                      >
                        <FileText className="h-3.5 w-3.5 text-slate-500" />
                        <span>{extracted.rawText.trim() ? t("使用离线规则解析", "Parse with offline rules") : t("图片 / 扫描件需视觉识别", "Images / scans require vision recognition")}</span>
                      </button>
                    </div>
                  </div>

                  {isParsing && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700 font-medium">
                      <RotateCw className="h-4 w-4 animate-spin shrink-0 text-blue-600" />
                      <span>{parseStatusMsg}</span>
                    </div>
                  )}

                  {parseError && (
                    <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">{t("解析遇到问题：", "Parsing issue:")}</span>
                        {parseError}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Step 4: Parsed Result Preview & Confirm */}
              {parsedFactBase && (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50/50 p-4 space-y-3 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-emerald-800 font-bold text-xs" role="status">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>{unparsedLines.length ? t("已解析部分内容，还有待补录原文。请逐项核对：", "Some content was parsed; other source text needs entry. Review each item:") : t("已生成结构化预览，请对照原文核对：", "Structured preview ready. Compare it with the original:")}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setParsedFactBase(null)}
                      className="text-[11px] text-slate-500 hover:text-slate-800 underline"
                    >
                      {t("重新选择方式解析", "Choose another parser")}
                    </button>
                  </div>
                  <p className="text-xs text-slate-600">{t("字段格式校验已通过，不代表内容已核实。请展开每段经历核对正文、时间和归属，再确认导入。", "Field formats are valid; the content is not yet verified. Expand each experience and review its text, dates and attribution before importing.")}</p>
                  <button type="button" onClick={handleDownloadParsedResult} className="rounded border border-emerald-300 bg-white px-3 py-1.5 text-xs text-emerald-800">{t("下载解析结果供核对", "Download parsed result for review")}</button>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-white rounded-lg p-3.5 border border-emerald-200 shadow-2xs">
                    <div className="flex items-center gap-3">
                      {customAvatar || parsedFactBase.profile.avatarUrl ? (
                        <img
                          src={customAvatar || parsedFactBase.profile.avatarUrl}
                          alt="Avatar"
                          className="h-12 w-10 rounded object-cover border border-emerald-300 shadow-2xs shrink-0"
                        />
                      ) : (
                        <div className="flex h-12 w-10 flex-col items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50 text-slate-400 shrink-0">
                          <User className="h-4 w-4" />
                        </div>
                      )}
                      <div>
                        <span className="text-slate-400 block text-[11px]">{t("姓名 / 候选人", "Candidate name")}</span>
                        <span className="font-bold text-slate-800 text-sm">
                          {parsedFactBase.profile.displayName.zh ||
                            parsedFactBase.profile.displayName.en ||
                            t("未命名", "Unnamed")}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">{t("专业头衔", "Professional headline")}</span>
                      <span className="font-medium text-slate-700">
                          {parsedFactBase.profile.headline?.zh || t("未识别，请在编辑器补充", "Not detected; add it in the editor")}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">{t("联系电话 / 邮箱", "Phone / email")}</span>
                      <span className="text-slate-600">
                        {parsedFactBase.profile.phone || t("未识别", "Not detected")} ·{" "}
                        {parsedFactBase.profile.email || t("未识别", "Not detected")}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">{t("解析经历 / 成就条目", "Parsed experience / achievements")}</span>
                      <span className="font-semibold text-emerald-700">
                        {parsedFactBase.experiences.length} {t("段经历 ·", "experiences ·")}{" "}
                        {parsedFactBase.experiences.reduce(
                          (acc, e) => acc + e.claims.length,
                          0,
                        )}{" "}
                        {t("条要点", "claims")}
                      </span>
                    </div>
                  </div>

                  {parseWarnings.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" role="status">
                      <ul className="list-disc space-y-1 pl-4">{parseWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
                    </div>
                  )}
                  {unparsedLines.length > 0 && (
                    <details className="rounded-lg border border-amber-200 bg-white p-3 text-xs">
                      <summary className="cursor-pointer font-semibold text-amber-900">{unparsedLines.length} {t("段待核对 / 补录，请对照原文件", "passages need review / entry; check the original file")}</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-slate-700">{unparsedLines.join("\n")}</pre>
                    </details>
                  )}
                  {parseError && <p className="text-xs text-rose-700" role="alert">{parseError}</p>}

                  {/* Summary list of experiences */}
                  {ocrText && <details className="rounded border border-blue-200 bg-white p-3 text-xs"><summary className="cursor-pointer font-medium">{t("查看 OCR 转录并对照原图（未核实）", "Review OCR transcription against the original (unverified)")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{ocrText}</pre></details>}
                  <details className="rounded border border-emerald-200 bg-white p-3 text-xs"><summary className="cursor-pointer font-medium">{t("目标岗位、技能与个人信息", "Target roles, skills and profile")}</summary><div className="mt-2 space-y-2 break-words">
                    {parsedFactBase.profile.education && <p>{t("学历：", "Education:")}{parsedFactBase.profile.education.zh}</p>}
                    {parsedFactBase.profile.location && <p>{t("地点：", "Location:")}{parsedFactBase.profile.location.zh}</p>}
                    {parsedFactBase.profile.targetRoles.map((role, i) => <p key={`role-${i}`}>{t("目标岗位：", "Target roles:")}{role.zh}{role.en && ` / ${role.en}`}</p>)}
                    <ul className="list-disc space-y-1 pl-4">{parsedFactBase.profile.traits.map((trait, i) => <li key={i}>{trait}</li>)}</ul>
                    {parsedFactBase.profile.constraints.map((constraint, i) => <p key={`constraint-${i}`}>{t("求职约束：", "Job search constraints:")}{constraint}</p>)}
                    {parsedFactBase.profile.links.map((link, i) => <p key={`link-${i}`}>{link.label}：{link.url}</p>)}
                  </div></details>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {parsedFactBase.experiences.map((exp, idx) => (
                      <details
                        key={idx}
                        className="text-xs bg-white/80 px-2.5 py-2 rounded border border-emerald-100"
                      >
                        <summary className="cursor-pointer break-words"><span className="font-semibold text-slate-800">
                          {exp.org.zh || exp.org.en} · {exp.title.zh || exp.title.en}
                        </span>
                        <span className="ml-2 text-slate-500">
                          {exp.start} ~ {exp.end || t("至今", "Present")} ({exp.claims.length} {t("条)", "claims)")}
                        </span></summary>
                        {exp.projectName && <p className="mt-2 whitespace-pre-wrap">{t("项目：", "Project:")}{exp.projectName.zh || exp.projectName.en}</p>}
                        {exp.techStack.length > 0 && <p className="mt-2 break-words">{t("技术：", "Technologies:")}{exp.techStack.join(" · ")}</p>}
                        <ul className="mt-2 list-disc space-y-2 pl-4">{exp.claims.map((claim) => <li key={claim.id} className="whitespace-pre-wrap break-words">{claim.text.zh}{claim.text.en && <p>{claim.text.en}</p>}{claim.metric && <span className="ml-2 text-amber-800">{t("量化待本人核实", "Metrics require your verification")}</span>}</li>)}</ul>
                      </details>
                    ))}
                  </div>

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-emerald-200/60">
                    <p className="text-[11px] text-slate-500">
                      {t("确认后将替换当前事实库和简历视图，请先备份已有内容。提取原文和待补录内容随本地文档及 JSON 备份保存，不进入对外简历；原 PDF / Word 的版式不会随结构化导入保留，请保留原文件。", "Confirmation replaces the current fact base and resume views; back up your work first. Source text and pending passages are kept in local documents and JSON backups, outside the public resume. Structured import does not preserve the original PDF / Word layout; keep that file.")}
                    </p>
                    <button
                      type="button"
                      onClick={handleConfirmImport}
                      disabled={isImporting}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs px-4 py-2 shadow-xs transition"
                    >
                      <span>{isImporting ? t("正在保存…", "Saving…") : t("确认导入并替换当前简历", "Import and replace current resume")}</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 flex items-center justify-between text-xs text-slate-500">
          <span>{t("本地保存 · 离线规则不联网 · AI 解析将文本或页面图片直发所选模型服务商", "Saved locally · Offline rules use no network · AI sends text or page images directly to your selected provider")}</span>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 transition"
          >
            {t("取消", "Cancel")}
          </button>
        </div>
      </div>

      {/* Interactive Page 1 Avatar Cropper Modal */}
      {isCropperOpen && extracted?.pageImages && extracted.pageImages[0] && (
        <PageCropperModal
          key={`avatar-crop-${cropFileOperation}`}
          isOpen={isCropperOpen}
          onClose={() => setIsCropperOpen(false)}
          pageImageUrl={extracted.pageImages[0]}
          onApplyCrop={(croppedUrl) => {
            if (cropFileOperation !== operationRef.current) return;
            chooseAvatar(croppedUrl);
          }}
        />
      )}
      {isRegionCropperOpen && extracted?.pageImages[0] && <PageCropperModal
        key={`document-crop-${cropFileOperation}`}
        isOpen mode="document" pageImageUrl={extracted.pageImages[0]}
        onClose={() => setIsRegionCropperOpen(false)}
        onApplyCrop={(image) => { if (cropFileOperation !== operationRef.current) return; setRecognitionImage(image); setParsedFactBase(null); setUnparsedLines([]); setParseWarnings([]); setParseError(null); setPreviewTab("images"); }}
      />}
    </div>
  );
}

interface PageCropperModalProps {
  isOpen: boolean;
  onClose: () => void;
  pageImageUrl: string;
  onApplyCrop: (croppedDataUrl: string) => void;
  mode?: "avatar" | "document";
}

function PageCropperModal({
  isOpen,
  onClose,
  pageImageUrl,
  onApplyCrop,
  mode = "avatar",
}: PageCropperModalProps) {
  const { t } = useUiPreferences();
  const uiTextRef = useRef(t);
  uiTextRef.current = t;

  const isDocument = mode === "document";
  const [crop, setCrop] = useState<{ x: number; y: number; width: number; height: number }>(isDocument ? { x: 0, y: 0, width: 100, height: 100 } : {
    x: 68,
    y: 2.5,
    width: 22,
    height: 18,
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [aspectLocked, setAspectLocked] = useState(!isDocument);
  const [isApplying, setIsApplying] = useState(false);
  const [cropError, setCropError] = useState("");
  const cropActiveRef = useRef(true);
  const cropTasksRef = useRef(createCropTaskRunner());
  useEffect(() => {
    const tasks = cropTasksRef.current;
    cropActiveRef.current = true;
    return () => { cropActiveRef.current = false; tasks.cancel(); };
  }, [pageImageUrl, isOpen, mode]);
  function closeCrop() {
    cropActiveRef.current = false;
    cropTasksRef.current.cancel();
    onClose();
  }
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize" | null;
    startX: number;
    startY: number;
    startCrop: { x: number; y: number; width: number; height: number };
  }>({ mode: null, startX: 0, startY: 0, startCrop: crop });

  useEffect(() => {
    let active = true;
    void cropImageRegion(pageImageUrl, crop, true, isDocument ? "image/png" : "image/jpeg").then((url) => {
      if (active) { setPreviewUrl(url); setCropError(""); }
    }).catch((error) => {
      if (active) { setPreviewUrl(null); setCropError(error instanceof Error ? error.message : uiTextRef.current("无法预览裁剪区域，请重新框选。", "Could not preview the crop. Select the region again.")); }
    });
    return () => {
      active = false;
    };
  }, [pageImageUrl, crop, isDocument]);

  const handleMouseDown = (e: React.MouseEvent, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    if (isApplying) return;
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current.mode || !imageContainerRef.current) return;
      const rect = imageContainerRef.current.getBoundingClientRect();
      const dxPct = ((moveEvent.clientX - dragRef.current.startX) / rect.width) * 100;
      const dyPct = ((moveEvent.clientY - dragRef.current.startY) / rect.height) * 100;

      const { mode: currentMode, startCrop } = dragRef.current;

      if (currentMode === "move") {
        const nextX = Math.max(0, Math.min(100 - startCrop.width, startCrop.x + dxPct));
        const nextY = Math.max(0, Math.min(100 - startCrop.height, startCrop.y + dyPct));
        setCrop((prev) => ({ ...prev, x: nextX, y: nextY }));
      } else if (currentMode === "resize") {
        let nextW = Math.min(100 - startCrop.x, Math.max(isDocument ? 1 : 6, startCrop.width + dxPct));
        let nextH = Math.min(100 - startCrop.y, Math.max(isDocument ? 1 : 6, startCrop.height + dyPct));
        if (aspectLocked) {
          const imgRatio = rect.width / rect.height;
          nextH = (nextW * imgRatio) / (3 / 4);
          if (startCrop.y + nextH > 100) {
            nextH = 100 - startCrop.y;
            nextW = (nextH * (3 / 4)) / imgRatio;
          }
        }
        setCrop((prev) => ({ ...prev, width: nextW, height: nextH }));
      }
    };

    const handleMouseUp = () => {
      dragRef.current.mode = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleConfirm = async () => {
    if (isApplying) return;
    setIsApplying(true);
    setCropError("");
    try {
      await cropTasksRef.current.run(
        () => cropImageRegion(pageImageUrl, crop, true, isDocument ? "image/png" : "image/jpeg"),
        (cropped) => { onApplyCrop(cropped); closeCrop(); },
      );
    } catch (e) {
      if (cropActiveRef.current) setCropError(e instanceof Error ? e.message : t("裁剪失败，请重新选择区域后重试。", "Cropping failed. Select the region again and retry."));
    } finally {
      if (cropActiveRef.current) setIsApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="flex h-[90vh] max-h-[760px] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-3.5 bg-slate-50">
          <div className="flex items-center gap-2">
            <Crop className="h-4 w-4 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-900">{isDocument ? t("选择简历正文识别区域", "Select resume content for recognition") : t("从简历第 1 页截取/裁剪证件照", "Crop a profile photo from the resume's first page")}</h3>
          </div>
          <button
            onClick={closeCrop}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-auto">
          {/* Left Canvas view */}
          <div className="flex-1 bg-slate-900/90 p-4 flex items-center justify-center overflow-auto">
            <div
              ref={imageContainerRef}
              className="relative inline-block select-none shadow-xl rounded overflow-hidden max-h-[620px]"
            >
              <img
                src={pageImageUrl}
                alt="Page 1"
                className="max-h-[620px] w-auto object-contain block pointer-events-none"
              />

              {/* Crop Box */}
              <div
                style={{
                  left: `${crop.x}%`,
                  top: `${crop.y}%`,
                  width: `${crop.width}%`,
                  height: `${crop.height}%`,
                }}
                className="absolute border-2 border-blue-400 bg-blue-500/15 cursor-move shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-shadow"
                onMouseDown={(e) => handleMouseDown(e, "move")}
              >
                {/* 3x3 Grid Guidelines */}
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                  <div className="border-r border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div />
                </div>

                {/* Resize Handle */}
                <div
                  onMouseDown={(e) => handleMouseDown(e, "resize")}
                  className="absolute bottom-0 right-0 h-4 w-4 bg-white border-2 border-blue-600 rounded-xs cursor-nwse-resize shadow-md translate-x-1/2 translate-y-1/2"
                />
              </div>
            </div>
          </div>

          {/* Right Toolbar & Preview Sidebar */}
          <div className="w-full sm:w-72 shrink-0 border-l border-slate-200 bg-slate-50 p-5 flex flex-col justify-between overflow-y-auto">
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">{isDocument ? t("识别区域预览", "Recognition area preview") : t("头像实时预览", "Live photo preview")}</h4>

              <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl border border-slate-200 shadow-2xs">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Preview"
                    className={isDocument ? "max-h-48 max-w-full object-contain border border-slate-300" : "h-28 w-22 rounded-md object-cover border border-slate-300 shadow-xs"}
                  />
                ) : (
                  <div className="h-28 w-22 rounded-md border-2 border-dashed border-slate-200 flex items-center justify-center text-xs text-slate-400">
                    {t("截图中…", "Cropping…")}
                  </div>
                )}
                <span className="text-[11px] text-slate-400 mt-2 font-medium">{isDocument ? t("排除手机界面，保留全部简历正文", "Exclude phone controls; keep all resume content") : t("标准证件照比例 (3:4)", "Standard portrait ratio (3:4)")}</span>
              </div>

              {isDocument && <div className="grid grid-cols-2 gap-2">
                {([["x", t("左侧", "Left")], ["y", t("顶部", "Top")], ["width", t("宽度", "Width")], ["height", t("高度", "Height")]] as const).map(([key, label]) => <label key={key} className="text-xs text-slate-700">{label} (%)<input aria-label={t(`识别区域${label}百分比`, `Recognition area ${label} percentage`)} type="number" min={key === "width" || key === "height" ? 1 : 0} max={100} value={crop[key]} onChange={(event) => { const value = Number(event.target.value); if (!Number.isFinite(value)) return; setCrop((previous) => { const next = { ...previous, [key]: Math.min(key === "x" || key === "y" ? 99 : 100, Math.max(key === "width" || key === "height" ? 1 : 0, value)) }; if (key === "x") next.width = Math.min(next.width, 100 - next.x); if (key === "y") next.height = Math.min(next.height, 100 - next.y); if (key === "width") next.width = Math.min(next.width, 100 - next.x); if (key === "height") next.height = Math.min(next.height, 100 - next.y); return next; }); }} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5" /></label>)}
              </div>}

              {/* Presets */}
              <div className="space-y-2" hidden={isDocument}>
                <span className="text-xs font-bold text-slate-700">{t("快速定位预设", "Quick position presets")}</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 68, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    {t("右上角 (经典)", "Top right (classic)")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 5, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    {t("左上角 (侧边)", "Top left (sidebar)")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 39, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    {t("顶部居中", "Top center")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAspectLocked((l) => !l)}
                    className={`rounded border px-2 py-1.5 text-xs font-medium transition text-center cursor-pointer ${
                      aspectLocked
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-600"
                    }`}
                  >
                    {aspectLocked ? t("比例: 锁定 3:4", "Ratio: locked to 3:4") : t("比例: 自由自由", "Ratio: free")}
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-blue-50/70 border border-blue-100 p-2.5 text-[11px] text-blue-800 leading-relaxed">
                💡 <strong>{t("使用技巧：", "Tip:")}</strong> {t("在左侧页面中用鼠标", "On the page at left,")}<strong>{t("拖拽蓝色选框", "drag the blue selection")}</strong>{t("移动位置，", "to move it, and")}<strong>{t("拖动右下角白点", "drag the white lower right handle")}</strong>{t("调整缩放大小。", "to resize it.")}
              </div>
            </div>

            {/* Footer Actions */}
            <div className="space-y-2 pt-4 border-t border-slate-200">
              {cropError && <p className="text-xs text-rose-700" role="alert">{cropError}</p>}
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isApplying || !previewUrl}
                className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-blue-700 active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
              >
                {isApplying ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                <span>{isDocument ? t("确认识别区域", "Use recognition area") : t("确认选取此头像", "Use this photo")}</span>
              </button>
              <button
                type="button"
                onClick={closeCrop}
                className="w-full rounded-xl border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                {t("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
