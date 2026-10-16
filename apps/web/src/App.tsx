import { useEffect, useMemo, useRef, useState } from "react";
import {
  projectResume,
  scanFactBase,
  createDefaultResumeView,
  syncResumeViewsWithFactBase,
  LlmConfigSchema,
  type FactBase,
  type Locale,
  type ResumeView,
  type LlmConfig,
} from "@better-me/core";
import {
  LocalJsonStore,
  createInitialDocument,
  exportDocumentJson,
  parseDocumentJson,
  STORAGE_KEY,
  type BetterMeDocument,
} from "@better-me/storage";
import { FactEditor } from "./components/FactEditor";
import { ResumePreview } from "./components/ResumePreview";
import { IssuesPanel } from "./components/IssuesPanel";
import { AiConfigModal, DEFAULT_LLM_CONFIG } from "./components/AiConfigModal";
import { JdMatchModal } from "./components/JdMatchModal";
import { ResumeImportModal } from "./components/ResumeImportModal";
import {
  Sparkles,
  Download,
  Upload,
  RotateCcw,
  Languages,
  Target,
  Bot,
} from "lucide-react";

const store = new LocalJsonStore();
const LLM_CONFIG_KEY = "better-me:llm-config";

export function App() {
  const [doc, setDoc] = useState<BetterMeDocument | null>(null);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const restoreOperationRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modals
  const [isAiConfigOpen, setIsAiConfigOpen] = useState(false);
  const [isJdMatchOpen, setIsJdMatchOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await store.load();
        const next = loaded ?? createInitialDocument();
        setDoc(next);
        if (!loaded) {
          try { await store.save(next); }
          catch { setSaveError("浏览器无法保存本地数据，请检查存储权限或空间。当前修改仅在页面内。"); }
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "本地存储读取失败，原始数据已保留。");
      }

      // Load LLM Config
      try {
        const savedConfig = localStorage.getItem(LLM_CONFIG_KEY);
        if (savedConfig) {
          const parsed = LlmConfigSchema.safeParse(JSON.parse(savedConfig));
          if (parsed.success) setLlmConfig(parsed.data);
        }
      } catch (e) {
        console.warn("Failed to load llm config from local storage", e);
      }

      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!saveError) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveError]);

  const activeResume: ResumeView | null = useMemo(() => {
    if (!doc) return null;
    return (
      doc.resumeViews.find((r) => r.id === doc.activeResumeId) ??
      doc.resumeViews[0] ??
      null
    );
  }, [doc]);

  const issues = useMemo(
    () => (doc ? scanFactBase(doc.factBase) : []),
    [doc],
  );

  const projected = useMemo(() => {
    if (!doc || !activeResume) return null;
    return projectResume(doc.factBase, activeResume);
  }, [doc, activeResume]);

  async function persist(next: BetterMeDocument, replace = false): Promise<boolean> {
    restoreOperationRef.current += 1;
    setIsRestoring(false);
    if (!replace) setDoc(next);
    try {
      await store.save(next);
      if (replace) setDoc(next);
      setSaveError(null);
      setLoadError(null);
      return true;
    } catch (error) {
      const message = error && typeof error === "object" && "issues" in error
        ? "部分字段尚未填完或格式无效（如姓名、邮箱、起止月份）。请补全后自动保存。"
        : "本地保存失败，请检查浏览器存储权限或空间，或先导出页面草稿。";
      setSaveError(`${message} 当前修改仍保留在页面，刷新会丢失未保存内容。`);
      return false;
    }
  }

  function handleSaveLlmConfig(newConfig: LlmConfig) {
    const validated = LlmConfigSchema.parse(newConfig);
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(validated));
    setLlmConfig(validated);
  }

  async function handleImportResumeSuccess(
    factBase: FactBase,
    rawText: string,
    fileName: string,
  ) {
    if (!doc) return;
    const newResumeView = createDefaultResumeView(factBase);
    const nextDoc: BetterMeDocument = {
      factBase,
      resumeViews: [newResumeView],
      activeResumeId: newResumeView.id,
    };

    if (!(await persist(nextDoc, true))) throw new Error("未能保存导入结果，当前简历未被替换。请检查存储空间或导入字段。");

    // Save record to local document records
    try {
      const recordsRaw = localStorage.getItem("better-me:imported-files");
      const records = recordsRaw ? JSON.parse(recordsRaw) : [];
      records.unshift({
        id: `imported-${Date.now()}`,
        fileName,
        importedAt: new Date().toISOString(),
        charCount: rawText.length,
        displayName:
          factBase.profile.displayName.zh ||
          factBase.profile.displayName.en ||
          "未命名",
      });
      localStorage.setItem(
        "better-me:imported-files",
        JSON.stringify(records.slice(0, 30)),
      );
    } catch (err) {
      console.warn("Failed to save imported file record", err);
    }
  }

  function updateFactBase(factBase: FactBase) {
    if (!doc) return;
    void persist({
      ...doc,
      factBase: { ...factBase, updatedAt: new Date().toISOString() },
      resumeViews: syncResumeViewsWithFactBase(doc.factBase, factBase, doc.resumeViews, doc.activeResumeId),
    });
  }

  function setLocale(locale: Locale) {
    if (!doc || !activeResume) return;
    const resumeViews = doc.resumeViews.map((r) =>
      r.id === activeResume.id
        ? { ...r, locale, updatedAt: new Date().toISOString() }
        : r,
    );
    void persist({ ...doc, resumeViews });
  }

  function setTemplate(templateId: string) {
    if (!doc || !activeResume) return;
    const resumeViews = doc.resumeViews.map((r) =>
      r.id === activeResume.id
        ? { ...r, templateId, updatedAt: new Date().toISOString() }
        : r,
    );
    void persist({ ...doc, resumeViews });
  }

  // Backup & Restore
  function downloadJson(content: string, fileName: string) {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportBackup() {
    if (!doc) return;
    try {
      const jsonStr = exportDocumentJson(doc);
      downloadJson(jsonStr, `better-me-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch {
      downloadJson(JSON.stringify(doc, null, 2), `better-me-draft-${new Date().toISOString().slice(0, 10)}.json`);
      alert("已导出页面草稿，其中包含未完成字段；修正格式后才能作为完整备份恢复。");
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const operation = ++restoreOperationRef.current;
    setIsRestoring(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      if (operation !== restoreOperationRef.current) return;
      try {
        const content = event.target?.result as string;
        const imported = parseDocumentJson(content);
        if (await persist(imported, true)) alert("备份数据恢复成功！");
      } catch {
        alert("导入失败：文件格式不符合 BetterMe 规范。");
      } finally {
        if (operation === restoreOperationRef.current) setIsRestoring(false);
      }
    };
    reader.onerror = () => {
      if (operation !== restoreOperationRef.current) return;
      setIsRestoring(false);
      alert("文件读取失败，请重新选择备份文件。");
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function resetDemo() {
    restoreOperationRef.current += 1;
    setIsRestoring(false);
    if (confirm("确定要重置为初始演示数据吗？当前所做的未备份修改将会丢失。")) {
      const next = createInitialDocument();
      await persist(next, true);
    }
  }

  if (ready && loadError) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-8 text-sm text-slate-700">
        <h1 className="text-lg font-bold">本地数据需要恢复</h1>
        <p role="alert">{loadError}</p>
        {saveError && <p role="alert">{saveError}</p>}
        <input type="file" ref={fileInputRef} accept=".json" onChange={handleFileSelected} className="hidden" />
        <div className="flex flex-wrap gap-3">
          <button className="rounded border p-2" onClick={() => {
            try { downloadJson(localStorage.getItem(STORAGE_KEY) ?? "", "better-me-backup-recovery.json"); }
            catch { alert("浏览器拒绝读取本地存储，请检查权限。"); }
          }}>下载原始数据</button>
          <button className="rounded border p-2" onClick={handleImportClick}>恢复 JSON 备份</button>
          <button className="rounded border p-2 text-rose-700" onClick={() => void resetDemo()}>确认后重置演示</button>
        </div>
      </div>
    );
  }

  if (!ready || !doc || !activeResume || !projected) {
    return (
      <div className="grid h-full place-items-center text-slate-500 font-medium text-sm">
        正在载入本地 Fact 事实库与简历引擎…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-[1720px] flex-col gap-3.5 p-3 sm:p-5">
      {/* Hidden File Input for Backup Import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelected}
        accept=".json"
        className="hidden"
      />

      {/* Top Application Header (Hidden in Print) */}
      <header className="no-print flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--color-line)] bg-white/80 backdrop-blur-md px-5 py-3.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-accent)] text-white shadow-xs">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-base tracking-tight text-slate-900">
                迈向更好 · BetterMe
              </h1>
              <span className="rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-accent)]">
                V1 事实与简历工作台
              </span>
            </div>
            <p className="text-xs text-slate-500">
              事实优先 · 量化待核实 · 中英同源 · 本地简历工作台
            </p>
          </div>
        </div>

        {/* Global Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Resume Import Button */}
          <button
            type="button"
            onClick={() => setIsImportModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-semibold shadow-xs transition"
            title="支持导入 PDF、Word (DOCX/DOC)、HTML、Markdown、TXT 简历并自动结构化"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>导入简历</span>
          </button>

          {/* AI JD Match Button */}
          <button
            type="button"
            onClick={() => setIsJdMatchOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white px-3 py-1.5 text-xs font-semibold shadow-xs transition"
          >
            <Target className="h-3.5 w-3.5" />
            <span>JD 匹配与 AI 诊断</span>
          </button>

          {/* AI Settings Button */}
          <button
            type="button"
            onClick={() => setIsAiConfigOpen(true)}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 transition"
            title="配置云端大模型 API 或本地 Ollama"
          >
            <Bot className="h-3.5 w-3.5 text-slate-500" />
            <span className="hidden sm:inline">AI 配置</span>
          </button>

          <div className="h-4 w-px bg-slate-200 mx-1" />

          {/* Target Language Switcher */}
          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50/80 p-0.5 shadow-2xs">
            {(["zh", "en"] as const).map((locale) => (
              <button
                key={locale}
                type="button"
                onClick={() => setLocale(locale)}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  activeResume.locale === locale
                    ? "bg-[var(--color-accent)] text-white shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Languages className="h-3 w-3" />
                <span>{locale === "zh" ? "输出: 中文" : "Output: EN"}</span>
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-slate-200 mx-1" />

          {/* Backup / Restore */}
          <button
            type="button"
            onClick={handleExportBackup}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
            title="导出全部数据为 JSON 本地备份"
          >
            <Download className="h-3.5 w-3.5 text-slate-500" />
            <span className="hidden sm:inline">备份</span>
          </button>

          <button
            type="button"
            onClick={handleImportClick}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
            title="从本地 JSON 恢复数据"
          >
            <RotateCcw className="h-3.5 w-3.5 text-slate-500" />
            <span className="hidden sm:inline">恢复</span>
          </button>

          <button
            type="button"
            onClick={() => void resetDemo()}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 shadow-2xs hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50/50 transition"
            title="重置为初始 Demo 数据"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">重置</span>
          </button>
        </div>
      </header>

      <div className={`no-print flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs ${saveError ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`} role="status" aria-live="polite">
        <span>{isRestoring ? "正在读取 JSON 备份…继续编辑会取消本次恢复。" : saveError ?? "修改已自动保存到本机浏览器。建议定期导出 JSON 备份。"}</span>
        {saveError && <div className="flex gap-3">
          <button className="underline" onClick={() => void persist(doc)}>重试保存</button>
          <button className="underline" onClick={handleExportBackup}>导出页面草稿</button>
        </div>}
      </div>

      {/* Issues / Quality Guardrails Panel */}
      <IssuesPanel issues={issues} />

      {/* Main Split Workstation */}
      <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <div className="no-print min-h-0 flex flex-col">
          <FactEditor factBase={doc.factBase} onChange={updateFactBase} />
        </div>
        <div className="min-h-0 flex flex-col">
          <ResumePreview
            resume={projected}
            onTemplateChange={setTemplate}
          />
        </div>
      </main>

      {/* AI Configuration Modal */}
      <div className="no-print">
      <AiConfigModal
        isOpen={isAiConfigOpen}
        onClose={() => setIsAiConfigOpen(false)}
        config={llmConfig}
        onSave={handleSaveLlmConfig}
      />

      {/* JD Match Analysis Modal */}
      <JdMatchModal
        isOpen={isJdMatchOpen}
        onClose={() => setIsJdMatchOpen(false)}
        resume={projected}
        llmConfig={llmConfig}
        onOpenConfig={() => {
          setIsJdMatchOpen(false);
          setIsAiConfigOpen(true);
        }}
      />

      {/* Resume Import & Auto-Structuring Modal */}
      <ResumeImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        llmConfig={llmConfig}
        onImportSuccess={handleImportResumeSuccess}
        onOpenAiConfig={() => {
          setIsImportModalOpen(false);
          setIsAiConfigOpen(true);
        }}
      />
      </div>
    </div>
  );
}
