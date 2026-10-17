import { useEffect, useRef, useState } from "react";
import {
  analyzeJdMatch,
  type JdMatchReport,
  type LlmConfig,
  type ProjectedResume,
} from "@better-me/core";
import {
  Target,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Copy,
  Check,
  X,
  Loader2,
  Settings2,
  FileText,
  Link2,
  ImagePlus,
  Upload,
  ExternalLink,
  ShieldCheck,
  Clock3,
} from "lucide-react";
import {
  extractJdLink,
  normalizeJobShare,
  readJdDraft,
  saveJdDraft,
  readScreenshot,
  reserveScreenshotBatch,
  completeScreenshotBatch,
  recognizeJdScreenshots,
  type JdImportResult,
  type JdProvenance,
  type JdScreenshot,
} from "../lib/jd-import";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  resume: ProjectedResume;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
};

const SAMPLE_JD = `【外企/高端智能装备】高级工业软件研发工程师 (.NET / C#)
岗位职责：
1. 负责新一代半导体/新能源自动化物流系统调度平台（RCS / WCS）核心模块架构与研发；
2. 负责异构设备通信协议驱动开发（支持西门子 S7、Modbus TCP、OPC-UA 等工业总线）；
3. 主导多机台/AGV 交通调度算法设计与状态机流转控制，保证 7x24 高并发高可靠运行；
4. 参与设备抽象层与统一 Adapter 接口设计，提升跨工厂项目的标准化复用率。

任职要求：
1. 3 年以上 C# / .NET Core 研发经验，精通 ASP.NET Core、多线程并发与异步 I/O；
2. 熟悉常用工业通讯协议（OPC-UA、Modbus、PLC 通信），有半导体或仓储物流调度系统（RCS/WCS）经验者优先；
3. 具备良好的软件架构设计能力，注重代码质量与单元测试；
4. 英语良好，能阅读英文技术文档与参与国际化团队技术协作。`;

export function JdMatchModal({
  isOpen,
  onClose,
  resume,
  llmConfig,
  onOpenConfig,
}: Props) {
  const [initialDraft] = useState(readJdDraft);
  const [draftEdited, setDraftEdited] = useState(false);
  const [jdText, setJdText] = useState(initialDraft.text);
  const [provenance, setProvenance] = useState<JdProvenance | null>(initialDraft.provenance);
  const [shareInput, setShareInput] = useState(initialDraft.shareInput);
  const [tab, setTab] = useState<"text" | "link" | "screenshot">("text");
  const [screenshots, setScreenshots] = useState<JdScreenshot[]>([]);
  const [pending, setPending] = useState<JdImportResult | null>(null);
  const [acquiring, setAcquiring] = useState<"link" | "ocr" | "images" | null>(null);
  const [draftStatus, setDraftStatus] = useState("JD 文字与来源保存在此浏览器");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<JdMatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestVersion = useRef(0);
  const acquisitionVersion = useRef(0);
  const acquisitionController = useRef<AbortController | null>(null);
  const imageVersion = useRef(0);
  const screenshotsRef = useRef<JdScreenshot[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    setLoading(false);
    setReport(null);
    setError(null);
    setCopied(false);
    return () => { requestVersion.current += 1; };
  }, [isOpen, jdText, resume, llmConfig]);

  useEffect(() => {
    acquisitionVersion.current += 1;
    acquisitionController.current?.abort();
    imageVersion.current += 1;
    screenshotsRef.current = screenshotsRef.current.filter((image) => image.dataUrl);
    setScreenshots(screenshotsRef.current);
    setAcquiring(null);
    setPending(null);
    return () => {
      acquisitionVersion.current += 1;
      acquisitionController.current?.abort();
      imageVersion.current += 1;
    };
  }, [isOpen, llmConfig]);

  useEffect(() => {
    if (initialDraft.recoveryRaw !== undefined && !draftEdited) {
      setDraftStatus("原 JD 草稿部分数据无法读取，已保留原文；编辑后先备份再保存。");
      return;
    }
    setDraftStatus("正在保存 JD 草稿…");
    const persist = () => {
      try {
        saveJdDraft({ text: jdText, shareInput, provenance, recoveryRaw: initialDraft.recoveryRaw });
        setDraftStatus("JD 草稿已自动保存到此浏览器");
      } catch (err) {
        setDraftStatus(err instanceof Error ? `草稿未保存：${err.message}` : "草稿保存失败，请手动复制文字。");
      }
    };
    const timer = setTimeout(persist, 500);
    window.addEventListener("pagehide", persist);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", persist); };
  }, [jdText, shareInput, provenance, initialDraft.recoveryRaw, draftEdited]);

  function invalidateAcquisition(cancelImages = true) {
    acquisitionVersion.current += 1;
    acquisitionController.current?.abort();
    setAcquiring(null);
    setPending(null);
    if (cancelImages) {
      imageVersion.current += 1;
      screenshotsRef.current = screenshotsRef.current.filter((image) => image.dataUrl);
      setScreenshots(screenshotsRef.current);
    }
  }

  function changeJdText(value: string) {
    requestVersion.current += 1;
    invalidateAcquisition();
    setJdText(value);
    setDraftEdited(true);
    setProvenance((current) => current ? { ...current, edited: true } : { kind: "text", observedAt: new Date().toISOString() });
  }

  async function handleExtractLink() {
    invalidateAcquisition();
    const version = acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setAcquiring("link");
    setError(null);
    try {
      const result = await extractJdLink(shareInput, controller.signal);
      if (version !== acquisitionVersion.current) return;
      setPending(result);
    } catch (err) {
      if (version !== acquisitionVersion.current) return;
      setError(controller.signal.aborted ? "岗位读取超时，请打开原链接后截图识别。" : err instanceof Error ? err.message : "读取失败，请改用截图识别。");
    } finally {
      clearTimeout(timeout);
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function addScreenshots(files: File[]) {
    if (!files.length) return;
    invalidateAcquisition(false);
    const version = imageVersion.current;
    let reserved: JdScreenshot[] = [];
    setError(null);
    setAcquiring("images");
    try {
      reserved = reserveScreenshotBatch(files, screenshotsRef.current);
      screenshotsRef.current = [...screenshotsRef.current, ...reserved];
      setScreenshots(screenshotsRef.current);
      const loaded = await Promise.all(files.map(readScreenshot));
      if (version !== imageVersion.current) return;
      screenshotsRef.current = completeScreenshotBatch(screenshotsRef.current, reserved, loaded);
      setScreenshots(screenshotsRef.current);
    } catch (err) {
      if (version === imageVersion.current) {
        const failed = new Set(reserved.map((image) => image.id));
        screenshotsRef.current = screenshotsRef.current.filter((image) => !failed.has(image.id));
        setScreenshots(screenshotsRef.current);
        setError(err instanceof Error ? err.message : "截图读取失败。");
      }
    } finally {
      if (version === imageVersion.current) setAcquiring(screenshotsRef.current.some((image) => !image.dataUrl) ? "images" : null);
    }
  }

  async function handleRecognize() {
    if (!llmConfig.apiKey?.trim() && llmConfig.provider === "gemini") {
      setError("请先配置 Gemini API Key，并选择支持图片输入的模型。");
      onOpenConfig();
      return;
    }
    invalidateAcquisition();
    const version = acquisitionVersion.current;
    setAcquiring("ocr");
    setError(null);
    let sourceUrl: string | undefined;
    try { sourceUrl = normalizeJobShare(shareInput).url; } catch { /* Screenshots can be used without a link. */ }
    try {
      const result = await recognizeJdScreenshots(llmConfig, screenshots, sourceUrl);
      if (version !== acquisitionVersion.current) return;
      setPending(result);
    } catch (err) {
      if (version === acquisitionVersion.current) setError(`${err instanceof Error ? err.message : "截图识别失败。"} 请确认当前模型支持图片输入。`);
    } finally {
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  let originalLink: string | undefined;
  try { originalLink = normalizeJobShare(shareInput).url; } catch { /* Display an original link only when it is recognized. */ }

  if (!isOpen) return null;

  const handleStartAnalysis = async () => {
    if (!jdText.trim()) {
      setError("请先输入岗位正文，或提取链接/截图后确认文字。");
      return;
    }
    if (!llmConfig.apiKey?.trim() && llmConfig.provider === "gemini") {
      setError("请先配置 Gemini API Key。");
      onOpenConfig();
      return;
    }

    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setReport(null);
    setCopied(false);
    try {
      const res = await analyzeJdMatch(llmConfig, resume, jdText);
      if (version !== requestVersion.current) return;
      setReport(res);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : "分析匹配失败，请检查网络或配置。");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  const handleCopyReport = async () => {
    if (!report) return;
    const version = requestVersion.current;
    const text = `# BetterMe 岗位匹配度诊断报告
匹配评分：${report.matchScore} / 100
总体评价：${report.scoreSummary}

## 核心契合亮点
${report.matchingStrengths.map((s) => `- ${s}`).join("\n")}

## 关键短板与差距
${report.missingGaps.map((g) => `- ${g}`).join("\n")}

## 针对性润色建议（防编造原则）
${report.tailoredSuggestions
  .map(
    (t, i) =>
      `### 建议 ${i + 1}
原表述：${t.currentText ?? "无"}
建议修改：${t.suggestedText}
理由：${t.reason}`,
  )
  .join("\n\n")}

## 面试深挖追问预警
${report.interviewDefenseTips.map((tip) => `- ${tip}`).join("\n")}
`;
    try {
      await navigator.clipboard.writeText(text);
      if (version !== requestVersion.current) return;
      setError(null);
      setCopied(true);
      setTimeout(() => {
        if (version === requestVersion.current) setCopied(false);
      }, 2000);
    } catch {
      if (version !== requestVersion.current) return;
      setCopied(false);
      setError("复制失败，请检查浏览器剪贴板权限，或手动选择并复制报告内容。");
    }
  };

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-3 sm:p-5">
      <div role="dialog" aria-modal="true" aria-labelledby="jd-modal-title" onPaste={(event) => {
        if (tab !== "screenshot") return;
        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (files.length) { event.preventDefault(); void addScreenshots(files); }
      }} className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl bg-[#fbfaf7] shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-accent)] text-white shadow-xs">
              <Target className="h-4 w-4" />
            </div>
            <div>
              <h2 id="jd-modal-title" className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span>目标岗位 · 采集与匹配</span>
                <span className="rounded bg-slate-200/70 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                  防编造模式
                </span>
              </h2>
              <p className="text-xs text-slate-500">
                对标岗位要求 · 诊断技能差距 · 建议 STAR 针对性强调 · 面试考点预警
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenConfig}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 transition"
              title="配置 AI 模型"
            >
              <Settings2 className="h-3.5 w-3.5 text-slate-500" />
              <span>{llmConfig.model}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭岗位匹配"
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
          {/* JD Input Area */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">把目标岗位带进来</h3>
                <p className="mt-1 text-xs text-slate-500">文字、分享链接或截图，提取后核对正文再分析。</p>
              </div>
              <div role="tablist" aria-label="岗位采集方式" className="flex rounded-xl bg-[#f1f2ee] p-1">
                {([{ id: "text", label: "粘贴文字", icon: FileText }, { id: "link", label: "分享链接", icon: Link2 }, { id: "screenshot", label: "截图识别", icon: ImagePlus }] as const).map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} aria-controls={`jd-${id}-panel`} onClick={() => { invalidateAcquisition(); setTab(id); setError(null); }} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition ${tab === id ? "bg-white text-[#244e43] shadow-sm" : "text-slate-500 hover:text-slate-800"}`}><Icon className="h-3.5 w-3.5" />{label}</button>
                ))}
              </div>
            </div>

            {tab === "link" && <div id="jd-link-panel" role="tabpanel" className="rounded-xl border border-[#dce5dd] bg-[#f4f7f2] p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#244e43]"><Link2 className="h-4 w-4" />LinkedIn · 猎聘 · 51JOB · BOSS直聘</div>
              <label htmlFor="jd-share" className="block text-xs text-slate-600">粘贴岗位链接或完整分享消息</label>
              <textarea id="jd-share" value={shareInput} onChange={(event) => { invalidateAcquisition(); setShareInput(event.target.value); setDraftEdited(true); setError(null); }} rows={3} placeholder="例如：我发现了这个职位，https://www.zhipin.com/job_detail/..." className="w-full rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-[#244e43]" />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => void handleExtractLink()} disabled={!shareInput.trim() || !!acquiring} className="inline-flex items-center gap-2 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white hover:bg-[#193c32] disabled:opacity-45">{acquiring === "link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}{acquiring === "link" ? "正在读取公开正文…" : "提取岗位正文"}</button>
                {originalLink && <a href={originalLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[#244e43] hover:underline"><ExternalLink className="h-3.5 w-3.5" />打开原岗位</a>}
                <button type="button" onClick={() => { invalidateAcquisition(); setTab("screenshot"); }} className="text-xs text-slate-600 hover:underline">无法复制？用截图识别</button>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">读取公开页面；登录、验证码或仅 App 可见的岗位可能无法提取。可在原页面截图后识别，保留来源链接。</p>
            </div>}

            {tab === "screenshot" && <div id="jd-screenshot-panel" role="tabpanel" className="rounded-xl border border-slate-200 bg-[#faf9f5] p-4 space-y-3">
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { void addScreenshots(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addScreenshots(Array.from(event.dataTransfer.files)); }} className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-[#b9cbbf] bg-white px-4 py-6 text-center hover:bg-[#f4f7f2] transition">
                <Upload className="h-6 w-6 text-[#244e43]" />
                <span className="text-xs font-semibold text-slate-800">选择或拖入岗位截图，也可以 Ctrl + V 粘贴</span>
                <span className="text-[11px] text-slate-500">PNG / JPEG / WebP · 最多 6 张 · 每张 10 MB · 按上传顺序识别</span>
              </button>
              {screenshots.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {screenshots.map((shot, index) => <div key={shot.id} className="relative overflow-hidden rounded-lg border border-slate-200 bg-white">{shot.dataUrl ? <img src={shot.dataUrl} alt={`岗位截图 ${index + 1}`} className="h-28 w-full object-contain bg-slate-50" /> : <div role="status" className="flex h-28 flex-col items-center justify-center gap-2 bg-slate-50 text-[11px] text-slate-500"><Loader2 className="h-5 w-5 animate-spin text-[#244e43]" /><span>正在读取截图…</span></div>}<div className="truncate px-2 py-2 text-[11px] text-slate-600">{index + 1}. {shot.name}</div><button type="button" aria-label={`移除截图 ${index + 1}`} onClick={() => { invalidateAcquisition(false); screenshotsRef.current = screenshotsRef.current.filter((image) => image.id !== shot.id); setScreenshots(screenshotsRef.current); setAcquiring(screenshotsRef.current.some((image) => !image.dataUrl) ? "images" : null); }} className="absolute top-1 right-1 rounded-md bg-white/90 p-1 text-slate-500 hover:text-rose-700"><X className="h-3.5 w-3.5" /></button></div>)}
              </div>}
              <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={!screenshots.length || !!acquiring || screenshots.some((image) => !image.dataUrl)} onClick={() => void handleRecognize()} className="inline-flex items-center gap-2 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white hover:bg-[#193c32] disabled:opacity-45">{acquiring === "ocr" || acquiring === "images" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{acquiring === "ocr" ? "正在识别截图…" : acquiring === "images" ? "正在读取图片…" : "识别截图文字"}</button><span className="text-[11px] text-slate-500">当前模型：{llmConfig.model}，需支持图片输入</span></div>
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />点击识别后才将截图发送给你配置的模型服务。截图仅保留在本次页面中；确认后的文字与来源自动保存。</p>
            </div>}

            {pending && <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-semibold text-amber-900">提取完成，请核对后使用</h4><span className="text-[11px] text-amber-700">{pending.method}</span></div>
              <label htmlFor="jd-extracted" className="sr-only">核对提取的岗位文字</label><textarea id="jd-extracted" rows={7} value={pending.text} onChange={(event) => setPending({ ...pending, text: event.target.value, provenance: { ...pending.provenance, edited: true } })} className="w-full rounded-lg border border-amber-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-[#244e43]" />
              <div className="flex items-center gap-3"><button type="button" disabled={!pending.text.trim()} onClick={() => { requestVersion.current += 1; setJdText(pending.text); setDraftEdited(true); setProvenance(pending.provenance); setPending(null); setTab("text"); }} className="inline-flex items-center gap-1.5 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white disabled:opacity-45"><Check className="h-3.5 w-3.5" />确认并使用正文</button><button type="button" onClick={() => setPending(null)} className="text-xs text-slate-500 hover:underline">放弃本次提取</button></div>
            </div>}

            <div id="jd-text-panel" role={tab === "text" ? "tabpanel" : undefined} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="jd-text" className="flex items-center gap-1.5 text-xs font-semibold text-slate-800"><FileText className="h-3.5 w-3.5 text-slate-500" />用于匹配的岗位正文</label><button type="button" onClick={() => { requestVersion.current += 1; invalidateAcquisition(); setJdText(SAMPLE_JD); setDraftEdited(true); setProvenance({ kind: "text", title: "工业软件工程师范例（演示）", observedAt: new Date().toISOString() }); setTab("text"); }} className="text-[11px] text-[#244e43] hover:underline">填入演示 JD</button></div>
              <textarea id="jd-text" value={jdText} onChange={(event) => changeJdText(event.target.value)} rows={tab === "text" ? 9 : 5} placeholder="粘贴岗位职责与任职要求，或通过上方链接/截图提取。你可以在这里继续修改和核对原文。" className="w-full resize-y rounded-lg border border-slate-200 bg-[#fdfdfb] p-3 text-xs leading-relaxed outline-none focus:border-[#244e43]" />
              {provenance && jdText.trim() && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500"><span>{provenance.platform ?? (provenance.kind === "screenshot" ? "截图识别" : "文字输入")}{provenance.edited ? " · 已编辑" : ""}</span><span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />采集于 {new Date(provenance.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</span>{provenance.url && <a href={provenance.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#244e43] hover:underline"><ExternalLink className="h-3 w-3" />原岗位链接</a>}{provenance.title && <span>{provenance.title}</span>}</div>}
              <p className={`text-[11px] ${draftStatus.includes("未保存") || draftStatus.includes("失败") ? "text-rose-700" : "text-slate-400"}`}>{draftStatus}</p>
              {initialDraft.recoveryRaw !== undefined && <button type="button" onClick={() => {
                const url = URL.createObjectURL(new Blob([initialDraft.recoveryRaw!], { type: "application/json;charset=utf-8" }));
                const link = document.createElement("a"); link.href = url; link.download = "betterme-jd-recovery.json"; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }} className="text-[11px] text-amber-800 underline">下载原始 JD 草稿以便恢复</button>}
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-slate-400">
                当前简历投影条数：{resume.experiences.length} 段经历，语言：
                {resume.locale}
              </span>
              <button
                type="button"
                onClick={() => void handleStartAnalysis()}
                disabled={loading || !!acquiring || !!pending || !jdText.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>AI 深度诊断中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>开始智能匹配与诊断</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error Notice */}
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <div>
                  <p className="font-bold">操作失败</p>
                  <p className="mt-0.5 leading-relaxed text-rose-700">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenConfig}
                className="shrink-0 rounded-lg bg-rose-700 hover:bg-rose-800 text-white px-3 py-1.5 text-xs font-semibold shadow-xs transition"
              >
                配置与重新选择模型
              </button>
            </div>
          )}

          {/* Report Results */}
          {report && (
            <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* Score & Summary Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200/90 bg-emerald-50/70 p-5 shadow-xs">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white font-bold text-xl shadow-xs">
                    {report.matchScore}
                    <span className="text-xs font-normal ml-0.5">%</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-emerald-950">
                      岗位契合度总体评分
                    </h3>
                    <p className="mt-1 text-xs text-emerald-800 leading-relaxed max-w-xl">
                      {report.scoreSummary}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleCopyReport()}
                  className="flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-900 shadow-2xs hover:bg-emerald-50 transition"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      <span>已复制报告</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>复制诊断结果</span>
                    </>
                  )}
                </button>
              </div>

              {/* Two Column Grid: Strengths vs Gaps */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Strengths */}
                <div className="rounded-xl border border-emerald-200/80 bg-white p-4 shadow-2xs space-y-2.5">
                  <h4 className="font-bold text-xs text-emerald-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    核心契合亮点 (Strengths)
                  </h4>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {report.matchingStrengths.map((str, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold shrink-0 mt-0.5">
                          ✓
                        </span>
                        <span>{str}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Missing Gaps */}
                <div className="rounded-xl border border-amber-200/80 bg-white p-4 shadow-2xs space-y-2.5">
                  <h4 className="font-bold text-xs text-amber-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    关键短板与差距 (Gaps)
                  </h4>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {report.missingGaps.map((gap, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-amber-500 font-bold shrink-0 mt-0.5">
                          !
                        </span>
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Targeted Suggestions (Anti-Hallucination) */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <div>
                  <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
                    针对性表达强化建议 (仅优化表述，绝不造假)
                  </h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    基于你已有的真实事实，将表述重点向该 JD 的痛点靠拢。
                  </p>
                </div>

                <div className="space-y-3 pt-1">
                  {report.tailoredSuggestions.map((sug, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 space-y-2 text-xs"
                    >
                      {sug.currentText && (
                        <div>
                          <span className="text-[10px] font-semibold text-slate-400 uppercase">
                            当前简历表述：
                          </span>
                          <p className="text-slate-600 line-through decoration-slate-300">
                            {sug.currentText}
                          </p>
                        </div>
                      )}
                      <div>
                        <span className="text-[10px] font-semibold text-emerald-700 uppercase">
                          建议优化表述 (更突出匹配关键词与因果链)：
                        </span>
                        <p className="text-emerald-950 font-medium bg-emerald-50/70 p-2 rounded border border-emerald-200/60 mt-0.5 leading-relaxed">
                          {sug.suggestedText}
                        </p>
                      </div>
                      <p className="text-[11px] text-slate-500 italic">
                        优化理由：{sug.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Interview Defense Tips */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                  <HelpCircle className="h-4 w-4 text-indigo-600" />
                  面试官深挖考点与刁钻追问预警 (Defense Tips)
                </h4>
                <ul className="space-y-2 text-xs text-slate-700">
                  {report.interviewDefenseTips.map((tip, idx) => (
                    <li
                      key={idx}
                      className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-2.5 flex items-start gap-2"
                    >
                      <span className="font-mono text-[11px] font-bold text-indigo-600 shrink-0">
                        Q{idx + 1}:
                      </span>
                      <span className="font-medium text-slate-800">{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
