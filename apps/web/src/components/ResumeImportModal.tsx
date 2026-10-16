import { useState, useRef, useEffect } from "react";
import {
  type FactBase,
  type LlmConfig,
  parseResumeWithAi,
  parseResumeWithVisionAi,
  parseResumeHeuristicallyWithDiagnostics,
  FactBaseSchema,
} from "@better-me/core";
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
  const [dragActive, setDragActive] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedFileResult | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // Avatar state
  const [customAvatar, setCustomAvatar] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Parsing step
  const [parsedFactBase, setParsedFactBase] = useState<FactBase | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatusMsg, setParseStatusMsg] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [unparsedLines, setUnparsedLines] = useState<string[]>([]);
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
      setIsExtracting(false);
      setIsParsing(false);
      setIsImporting(false);
      setParseWarnings([]);
      setUnparsedLines([]);
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
    setParseWarnings([]);
    setUnparsedLines([]);

    try {
      // Check if it's directly JSON
      if (file.name.toLowerCase().endsWith(".json")) {
        const text = await file.text();
        if (operation !== operationRef.current) return;
        const parsed = JSON.parse(text);
        const candidate: unknown = parsed && typeof parsed === "object" && "factBase" in parsed ? parsed.factBase : parsed;
        const validated = FactBaseSchema.safeParse(candidate);
        if (!validated.success) throw new Error("JSON 不符合 FactBase 规范，请检查 schemaVersion 和字段。完整备份请用首页“恢复”入口保留所有视图。");
        const fb = validated.data;
        setExtracted({ fileName: file.name, fileType: "json", rawText: text,
          isScannedPdf: false, pageImages: [], detectedAvatars: [], charCount: text.length });
        setCustomAvatar(fb.profile.avatarUrl ?? null);
        setParsedFactBase(fb);
        setParseWarnings(["JSON 导入保留原有量化核实状态；请确认此文件可信。导入完整备份的事实库会重建默认视图，若要保留模板与视图配置请使用“恢复”。"]);
        return;
      }

      const res = await extractTextFromFile(file);
      if (operation !== operationRef.current) return;
      setExtracted(res);
      if (res.detectedAvatars && res.detectedAvatars.length > 0 && res.detectedAvatars[0]) {
        setCustomAvatar(res.detectedAvatars[0]);
      }
      if (res.isScannedPdf && res.pageImages.length > 0) {
        setPreviewTab("images");
      } else {
        setPreviewTab("text");
      }
    } catch (err) {
      if (operation !== operationRef.current) return;
      setExtractError(
        err instanceof Error ? err.message : "文件提取失败，请检查文件是否损坏。",
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
    setParseStatusMsg("正在调用 AI 分析简历内容并进行事实库结构化提取…");

    try {
      let result: FactBase;
      if (extracted.isScannedPdf && extracted.pageImages.length > 0) {
        setParseStatusMsg("检测到扫描件图片，正在调用多模态视觉 OCR 识别…");
        result = await parseResumeWithVisionAi(
          llmConfig,
          extracted.pageImages,
          extracted.rawText,
          customAvatar ?? undefined,
        );
      } else {
        result = await parseResumeWithAi(
          llmConfig,
          extracted.rawText,
          customAvatar ?? undefined,
        );
      }
      if (operation !== operationRef.current) return;
      const choice = avatarChoiceRef.current;
      if (choice.changed) {
        result.profile.avatarUrl = choice.value ?? undefined;
      } else if (customAvatar) {
        result.profile.avatarUrl = customAvatar;
      } else if (result.profile.avatarBbox && extracted.pageImages && extracted.pageImages[0]) {
        try {
          const cropped = await cropBboxFromImage(
            extracted.pageImages[0],
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
      setParseWarnings(["AI 提取可能有遗漏或误识别，请逐项对照原文；新解析的量化指标均需你核实后才进入简历输出。"]);
    } catch (err) {
      if (operation !== operationRef.current) return;
      setParseError(
        err instanceof Error ? err.message : "AI 解析失败，请重试或使用离线规则解析。",
      );
    } finally {
      if (operation === operationRef.current) setIsParsing(false);
    }
  }

  // Parse with offline rules
  function handleHeuristicParse() {
    if (!extracted) return;
    setIsParsing(true);
    setParseError(null);
    setParseStatusMsg("正在执行离线启发式规则解析…");

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
      setParseError("离线解析遇到异常：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsParsing(false);
    }
  }

  // Confirm and replace UI resume
  async function handleConfirmImport() {
    if (!parsedFactBase || !extracted || isImporting) return;
    setIsImporting(true);
    setParseError(null);
    const finalFactBase = {
      ...parsedFactBase,
      profile: {
        ...parsedFactBase.profile,
        avatarUrl: avatarChoiceRef.current.changed ? avatarChoiceRef.current.value ?? undefined : customAvatar ?? parsedFactBase.profile.avatarUrl,
      },
    };
    try {
      await onImportSuccess(finalFactBase, extracted.rawText, extracted.fileName);
      onClose();
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "保存导入结果失败，请重试。");
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
                导入简历与自动结构化
              </h2>
              <p className="text-xs text-slate-500">
                支持 PDF、DOCX、DOC、HTML、MD、TXT 等常见格式 · 智能排版规整 · 本地存储
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
                  accept=".pdf,.doc,.docx,.html,.htm,.md,.markdown,.txt,.json"
                  className="hidden"
                />

                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 text-blue-600 mb-3">
                  <UploadCloud className="h-7 w-7" />
                </div>
                <h3 className="text-sm font-bold text-slate-800 mb-1">
                  点击浏览或拖拽简历文件到此处
                </h3>
                <p className="text-xs text-slate-500 max-w-md mb-4">
                  提取文本后可选择离线规则或 AI 解析，核对后保存为结构化事实库（FactBase）。
                </p>

                {/* Badges */}
                <div className="flex flex-wrap justify-center gap-1.5 text-[11px] font-medium text-slate-600">
                  <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5">
                    📄 PDF (文字/扫描)
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
                    💾 JSON 备份
                  </span>
                </div>
              </div>

              {isExtracting && (
                <div className="flex items-center justify-center gap-2 text-sm text-blue-600 font-medium py-3">
                  <RotateCw className="h-4 w-4 animate-spin" />
                  <span>正在解析文档并提取内容，请稍候…</span>
                </div>
              )}

              {extractError && (
                <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/80 p-3.5 text-xs text-rose-800">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                  <div>
                    <span className="font-semibold">提取出错：</span>
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
                      提取字数: {extracted.charCount} 字
                      {extracted.numPages ? ` · 共 ${extracted.numPages} 页` : ""}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadExtractedText}
                    className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 transition"
                    title="下载提取出的纯文本文件到电脑"
                  >
                    <Download className="h-3 w-3" />
                    <span>另存文本</span>
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
                    重新上传
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
                        <span className="text-[9px] mt-0.5 font-medium">无照片</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-800">个人证件照 / 头像</span>
                      {extracted.detectedAvatars.length > 0 && customAvatar === extracted.detectedAvatars[0] ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-800">
                          ✓ 已从简历文档自动识别
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {customAvatar
                        ? "已就绪，导入后将展示在简历右上角（纯净打印自适应）"
                        : "若文档内有证件照，可点击右侧「从简历裁剪头像」直接框选，或本地上传"}
                    </p>
                    {extracted.detectedAvatars && extracted.detectedAvatars.length > 1 && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <span className="text-[10px] text-slate-500 font-medium">识别到的候选照片:</span>
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
                            title={`切换为候选照片 ${idx + 1}`}
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
                      onClick={() => setIsCropperOpen(true)}
                      className="flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50/80 px-2.5 py-1 text-xs font-semibold text-blue-700 shadow-2xs hover:bg-blue-100 transition"
                      title="直接在简历第 1 页上框选截取证件照"
                    >
                      <Crop className="h-3 w-3 text-blue-600" />
                      <span>从简历裁剪头像</span>
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
                    <span>{customAvatar ? "更换照片" : "上传头像"}</span>
                  </button>
                  {customAvatar && (
                    <button
                      type="button"
                      onClick={() => chooseAvatar(null)}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 transition"
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>

              {/* Scanned PDF / OCR Detection Notice */}
              {extracted.isScannedPdf && (
                <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-3.5 text-xs text-amber-900 space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-amber-900">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>OCR 辅助检测：该 PDF 疑似为纯图片扫描件（文字层少于 50 字）</span>
                  </div>
                  <p className="text-amber-800 leading-relaxed pl-6">
                    系统已自动将页面渲染为视觉图像，支持调用配置的大模型（推荐 Google Gemini 1.5/2.0 Flash）通过
                    <strong>多模态视觉 OCR</strong> 识别图片中的文字并构建结构化事实库。
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
                      <span>提取文本排版预览</span>
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
                        <span>页面图像渲染 ({extracted.pageImages.length})</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400">已保留行首尾与换行结构</span>
                </div>

                <div className="p-3 max-h-56 overflow-y-auto bg-slate-900/2">
                  {previewTab === "text" ? (
                    <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed select-text">
                      {extracted.rawText || "（未能提取出文本内容）"}
                    </pre>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {extracted.pageImages.map((img, i) => (
                        <div key={i} className="border border-slate-200 rounded-lg overflow-hidden shadow-2xs bg-white">
                          <img
                            src={img}
                            alt={`Page ${i + 1}`}
                            className="w-full h-auto object-contain max-h-48"
                          />
                          <div className="p-1 text-[10px] text-center text-slate-500 font-medium bg-slate-50">
                            第 {i + 1} 页
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
                    <span>选择解析方式转换为标准事实库 (FactBase)</span>
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Strategy A: AI Parsing */}
                    <div className="flex flex-col justify-between rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
                      <div className="space-y-1.5 mb-3">
                        <div className="flex items-center gap-1.5 font-bold text-xs text-blue-900">
                          <Bot className="h-4 w-4 text-blue-600" />
                          <span>AI 智能结构化解析 (推荐)</span>
                        </div>
                        <p className="text-[11px] text-slate-600 leading-relaxed">
                          调用 AI（如 Gemini 或 DeepSeek）精准提取姓名、经历、项目与战绩，自动补全中英翻译，并智能识别量化数据与防编造核实。
                        </p>
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
                              <span>AI 正在结构化提取…</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-3.5 w-3.5" />
                              <span>开始 AI 智能解析</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-[11px] text-amber-700 bg-amber-50 p-2 rounded border border-amber-200">
                            尚未配置 AI API Key（支持免费 Gemini 或本地 Ollama）
                          </p>
                          <button
                            type="button"
                            onClick={onOpenAiConfig}
                            className="w-full rounded-lg border border-blue-300 bg-white hover:bg-blue-50 text-blue-700 font-semibold text-xs py-1.5 transition"
                          >
                            前往配置 AI Key
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Strategy B: Offline Heuristic Parsing */}
                    <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5">
                      <div className="space-y-1.5 mb-3">
                        <div className="flex items-center gap-1.5 font-bold text-xs text-slate-800">
                          <FileCode className="h-4 w-4 text-slate-600" />
                          <span>离线启发式规则解析</span>
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          纯本地离线运行，无需任何 API Key 与网络请求。基于正则表达式与排版规则智能提取联系方式、履历与项目要点。
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={isParsing}
                        onClick={handleHeuristicParse}
                        className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs py-2 shadow-2xs transition disabled:opacity-60"
                      >
                        <FileText className="h-3.5 w-3.5 text-slate-500" />
                        <span>使用离线规则解析</span>
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
                        <span className="font-semibold">解析遇到问题：</span>
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
                    <div className="flex items-center gap-2 text-emerald-800 font-bold text-xs">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>事实库解析成功！请预览核对提取结果：</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setParsedFactBase(null)}
                      className="text-[11px] text-slate-500 hover:text-slate-800 underline"
                    >
                      重新选择方式解析
                    </button>
                  </div>

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
                        <span className="text-slate-400 block text-[11px]">姓名 / 候选人</span>
                        <span className="font-bold text-slate-800 text-sm">
                          {parsedFactBase.profile.displayName.zh ||
                            parsedFactBase.profile.displayName.en ||
                            "未命名"}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">专业头衔</span>
                      <span className="font-medium text-slate-700">
                          {parsedFactBase.profile.headline?.zh || "未识别，请在编辑器补充"}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">联系电话 / 邮箱</span>
                      <span className="text-slate-600">
                        {parsedFactBase.profile.phone || "未识别"} ·{" "}
                        {parsedFactBase.profile.email || "未识别"}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">解析经历 / 成就条目</span>
                      <span className="font-semibold text-emerald-700">
                        {parsedFactBase.experiences.length} 段经历 ·{" "}
                        {parsedFactBase.experiences.reduce(
                          (acc, e) => acc + e.claims.length,
                          0,
                        )}{" "}
                        条战绩 (Claim)
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
                      <summary className="cursor-pointer font-semibold text-amber-900">{unparsedLines.length} 行尚未结构化，请对照原文补录</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-slate-700">{unparsedLines.join("\n")}</pre>
                    </details>
                  )}
                  {parseError && <p className="text-xs text-rose-700" role="alert">{parseError}</p>}

                  {/* Summary list of experiences */}
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {parsedFactBase.experiences.map((exp, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-[11px] bg-white/80 px-2.5 py-1.5 rounded border border-emerald-100"
                      >
                        <span className="font-semibold text-slate-800 truncate">
                          {exp.org.zh || exp.org.en} · {exp.title.zh || exp.title.en}
                        </span>
                        <span className="text-slate-400 shrink-0">
                          {exp.start} ~ {exp.end || "至今"} ({exp.claims.length} 条)
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-emerald-200/60">
                    <p className="text-[11px] text-slate-500">
                      确认后将替换当前事实库和简历视图，请先备份已有内容；保存成功后才会生效。原文可下载留存。
                    </p>
                    <button
                      type="button"
                      onClick={handleConfirmImport}
                      disabled={isImporting}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs px-4 py-2 shadow-xs transition"
                    >
                      <span>{isImporting ? "正在保存…" : "确认导入并替换当前简历"}</span>
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
          <span>本地保存 · 离线规则不联网 · AI 解析将文本或页面图片直发所选模型服务商</span>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 transition"
          >
            取消
          </button>
        </div>
      </div>

      {/* Interactive Page 1 Avatar Cropper Modal */}
      {isCropperOpen && extracted?.pageImages && extracted.pageImages[0] && (
        <PageCropperModal
          isOpen={isCropperOpen}
          onClose={() => setIsCropperOpen(false)}
          pageImageUrl={extracted.pageImages[0]}
          onApplyCrop={(croppedUrl) => {
            chooseAvatar(croppedUrl);
          }}
        />
      )}
    </div>
  );
}

interface PageCropperModalProps {
  isOpen: boolean;
  onClose: () => void;
  pageImageUrl: string;
  onApplyCrop: (croppedDataUrl: string) => void;
}

function PageCropperModal({
  isOpen,
  onClose,
  pageImageUrl,
  onApplyCrop,
}: PageCropperModalProps) {
  const [crop, setCrop] = useState<{ x: number; y: number; width: number; height: number }>({
    x: 68,
    y: 2.5,
    width: 22,
    height: 18,
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize" | null;
    startX: number;
    startY: number;
    startCrop: { x: number; y: number; width: number; height: number };
  }>({ mode: null, startX: 0, startY: 0, startCrop: crop });

  useEffect(() => {
    let active = true;
    void cropImageRegion(pageImageUrl, crop).then((url) => {
      if (active) setPreviewUrl(url);
    });
    return () => {
      active = false;
    };
  }, [pageImageUrl, crop]);

  const handleMouseDown = (e: React.MouseEvent, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
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
        let nextW = Math.max(6, Math.min(100 - startCrop.x, startCrop.width + dxPct));
        let nextH = Math.max(6, Math.min(100 - startCrop.y, startCrop.height + dyPct));
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
    setIsApplying(true);
    try {
      const cropped = await cropImageRegion(pageImageUrl, crop);
      onApplyCrop(cropped);
      onClose();
    } catch (e) {
      console.error("Crop error:", e);
    } finally {
      setIsApplying(false);
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
            <h3 className="text-sm font-bold text-slate-900">从简历第 1 页截取/裁剪证件照</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
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
          <div className="w-72 border-l border-slate-200 bg-slate-50 p-5 flex flex-col justify-between">
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">头像实时预览</h4>

              <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl border border-slate-200 shadow-2xs">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Preview"
                    className="h-28 w-22 rounded-md object-cover border border-slate-300 shadow-xs"
                  />
                ) : (
                  <div className="h-28 w-22 rounded-md border-2 border-dashed border-slate-200 flex items-center justify-center text-xs text-slate-400">
                    截图中…
                  </div>
                )}
                <span className="text-[11px] text-slate-400 mt-2 font-medium">标准证件照比例 (3:4)</span>
              </div>

              {/* Presets */}
              <div className="space-y-2">
                <span className="text-xs font-bold text-slate-700">快速定位预设</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 68, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    右上角 (经典)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 5, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    左上角 (侧边)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCrop({ x: 39, y: 2.5, width: 22, height: 18 })}
                    className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition text-center cursor-pointer"
                  >
                    顶部居中
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
                    {aspectLocked ? "比例: 锁定 3:4" : "比例: 自由自由"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-blue-50/70 border border-blue-100 p-2.5 text-[11px] text-blue-800 leading-relaxed">
                💡 <strong>使用技巧：</strong> 在左侧页面中用鼠标<strong>拖拽蓝色选框</strong>移动位置，<strong>拖动右下角白点</strong>调整缩放大小。
              </div>
            </div>

            {/* Footer Actions */}
            <div className="space-y-2 pt-4 border-t border-slate-200">
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isApplying}
                className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-blue-700 active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
              >
                {isApplying ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                <span>确认选取此头像</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-xl border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
