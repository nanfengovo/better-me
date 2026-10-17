import { useEffect, useMemo, useRef, useState } from "react";
import {
  projectResume, scanFactBase, createDefaultResumeView, syncResumeViewsWithFactBase,
  LlmConfigSchema, type FactBase, type Locale, type ResumeView, type LlmConfig, type TextStyleRange,
} from "@better-me/core";
import { createInitialDocument, exportDocumentJson, parseDocumentJson, DocumentSchema, STORAGE_KEY, type DocumentVersion } from "@better-me/storage";
import { FactEditor } from "./components/FactEditor";
import { ResumePreview } from "./components/ResumePreview";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { ResumeDesignPanel } from "./components/ResumeDesignPanel";
import { VersionHistoryPanel } from "./components/VersionHistoryPanel";
import { AutoSaveControls } from "./components/AutoSaveControls";
import { IssuesPanel } from "./components/IssuesPanel";
import { AiConfigModal, DEFAULT_LLM_CONFIG } from "./components/AiConfigModal";
import { JdMatchModal } from "./components/JdMatchModal";
import { ResumeImportModal } from "./components/ResumeImportModal";
import { useDocumentPersistence } from "./lib/useDocumentPersistence";
import { rebaseViewTextStyles } from "./lib/text-formatting";
import type { PreviewFollowTarget } from "./lib/preview-follow";
import { ArrowUpRight, Bot, Check, ChevronRight, CloudOff, Download, FileText, GitBranch, History, Languages, Loader2, MoreHorizontal, Palette, RotateCcw, Settings2, ShieldCheck, Target, Upload } from "lucide-react";

const LLM_CONFIG_KEY = "better-me:llm-config";
function downloadJson(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const { doc, ready, loadError, status, update, replace, checkpoint, flush, history, autoSaveSettings, setAutoSaveSettings, autoSavePreferenceError } = useDocumentPersistence();
  const [workspaceTab, setWorkspaceTab] = useState<"content" | "design">("content");
  const [previewTarget, setPreviewTarget] = useState<PreviewFollowTarget | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isAiConfigOpen, setIsAiConfigOpen] = useState(false);
  const [isJdMatchOpen, setIsJdMatchOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreOperationRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LLM_CONFIG_KEY);
      if (saved) { const parsed = LlmConfigSchema.safeParse(JSON.parse(saved)); if (parsed.success) setLlmConfig(parsed.data); }
    } catch { /* Separate model configuration must not prevent opening the resume. */ }
  }, []);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); if (event.shiftKey) setIsHistoryOpen(true); else void flush();
      }
    };
    window.addEventListener("keydown", save); return () => window.removeEventListener("keydown", save);
  }, [flush]);
  useEffect(() => {
    if (!isMenuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setIsMenuOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [isMenuOpen]);

  const activeResume = useMemo(() => doc?.resumeViews.find((view) => view.id === doc.activeResumeId) ?? doc?.resumeViews[0] ?? null, [doc]);
  const issues = useMemo(() => doc ? scanFactBase(doc.factBase) : [], [doc]);
  const projected = useMemo(() => doc && activeResume ? projectResume(doc.factBase, activeResume) : null, [doc, activeResume]);
  const hasIncompleteDraft = useMemo(() => !!doc && !DocumentSchema.safeParse(doc).success, [doc]);
  function edit(next: NonNullable<typeof doc>) { restoreOperationRef.current += 1; setIsRestoring(false); setActionError(""); docRef.current = next; update(next); }
  function updateFactBase(factBase: FactBase) {
    const current = docRef.current; if (!current) return;
    const next = { ...factBase, updatedAt: new Date().toISOString() };
    const synced = syncResumeViewsWithFactBase(current.factBase, next, current.resumeViews, current.activeResumeId);
    edit({ ...current, factBase: next, resumeViews: rebaseViewTextStyles(current.factBase, next, synced) });
  }
  function updateResume(view: ResumeView) {
    const current = docRef.current; if (!current) return;
    edit({ ...current, resumeViews: current.resumeViews.map((item) => item.id === view.id ? { ...view, updatedAt: new Date().toISOString() } : item) });
  }
  function updateStyles(key: string, ranges: TextStyleRange[]) {
    const current = docRef.current;
    const view = current?.resumeViews.find((item) => item.id === current.activeResumeId);
    if (view) updateResume({ ...view, textStyles: { ...view.textStyles, [key]: ranges } });
  }
  function setLocale(locale: Locale) { if (activeResume) updateResume({ ...activeResume, locale }); }
  function setTemplate(templateId: string) { if (activeResume) updateResume({ ...activeResume, templateId }); }
  function handleSaveLlmConfig(config: LlmConfig) {
    const validated = LlmConfigSchema.parse(config); localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(validated)); setLlmConfig(validated);
  }
  async function handleImportResumeSuccess(factBase: FactBase, _rawText: string, fileName: string) {
    const view = createDefaultResumeView(factBase); view.name = fileName.replace(/\.[^.]+$/, "") || "我的简历";
    restoreOperationRef.current += 1; setIsRestoring(false);
    if (!(await replace({ factBase, resumeViews: [view], activeResumeId: view.id }, `导入 · ${fileName}`, "import"))) throw new Error("导入结果未能保存，当前简历已保留。请检查浏览器空间与字段格式。");
    setWorkspaceTab("content");
  }
  function handleExportBackup() {
    if (!doc) return;
    try { downloadJson(exportDocumentJson(doc), `better-me-backup-${new Date().toISOString().slice(0, 10)}.json`); }
    catch { downloadJson(JSON.stringify(doc, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? null : value, 2), `better-me-draft-${new Date().toISOString().slice(0, 10)}.json`); setActionError("已下载未完成草稿。补齐必填字段后，可以导出可恢复的完整备份。"); }
    setIsMenuOpen(false);
  }
  function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    const operation = ++restoreOperationRef.current; setIsRestoring(true); setActionError("");
    void file.text().then(async (raw) => {
      if (operation !== restoreOperationRef.current) return;
      const restored = parseDocumentJson(raw);
      const saved = await replace(restored, `恢复备份 · ${file.name}`, "import");
      if (operation === restoreOperationRef.current && !saved) setActionError("备份未能保存，当前简历已保留。");
    }).catch((error) => {
      if (operation === restoreOperationRef.current) setActionError(error instanceof Error ? `恢复失败：${error.message}` : "备份读取失败，请选择有效的 BetterMe JSON 文件。");
    }).finally(() => { if (operation === restoreOperationRef.current) setIsRestoring(false); });
    setIsMenuOpen(false);
  }
  async function resetDemo() {
    setIsMenuOpen(false); if (!confirm("恢复演示简历？当前有效文档会先记录到历史版本。未完成草稿建议先下载备份。")) return;
    restoreOperationRef.current += 1; setIsRestoring(false); await replace(createInitialDocument(), "恢复演示简历", "import");
  }
  async function restoreVersion(version: DocumentVersion) {
    restoreOperationRef.current += 1; setIsRestoring(false); setActionError("");
    return replace(version.document, `恢复 · ${version.label}`, "restore");
  }
  if (ready && loadError && !doc) return <div className="recovery-screen"><div className="recovery-card"><ShieldCheck size={28} /><h1>先保护好你的简历</h1><p role="alert">{loadError}</p><p>原始数据已保留。可以下载原文，或从有效备份恢复。</p><input type="file" ref={fileInputRef} accept=".json" onChange={handleFileSelected} className="hidden" /><div className="flex flex-wrap gap-3"><button className="studio-button" onClick={() => { try { downloadJson(localStorage.getItem(STORAGE_KEY) ?? "", "better-me-backup-recovery.json"); } catch { setActionError("浏览器拒绝读取存储。"); } }}>下载原始数据</button><button className="studio-button primary" onClick={() => fileInputRef.current?.click()}>恢复 JSON 备份</button><button className="studio-button" onClick={() => void resetDemo()}>恢复演示</button></div>{actionError && <p role="alert">{actionError}</p>}</div></div>;
  if (!ready || !doc || !activeResume || !projected) return <div className="studio-loading"><Loader2 size={24} className="animate-spin" /><span>正在打开你的简历工作室…</span></div>;
  const statusIcon = status.kind === "pending" ? <Loader2 size={12} className="animate-spin" /> : status.kind === "error" ? <CloudOff size={12} /> : <Check size={12} />;
  const saveLabel = status.kind === "saved" ? "已保存" : status.kind === "draft" ? "草稿已保护" : status.kind === "pending" ? "等待保存" : status.kind === "error" ? "保存需要处理" : "正在载入";
  const autoSaveDescription = !autoSaveSettings.enabled ? "自动保存已关闭" : autoSaveSettings.trigger === "enter" ? "按回车保存" : autoSaveSettings.trigger === "blur" ? "离开编辑项时保存" : `停止输入 ${autoSaveSettings.delayMs / 1000} 秒后保存`;

  return <div className="studio-app">
    <input type="file" ref={fileInputRef} onChange={handleFileSelected} accept=".json" className="hidden" />
    <aside className="studio-rail no-print" aria-label="工作室导航">
      <a className="studio-monogram" href="#" aria-label="BetterMe 简历工作室" onClick={(event) => { event.preventDefault(); setWorkspaceTab("content"); }}>b<span>m</span><i /></a><div className="rail-divider" />
      <button aria-label="内容编辑" aria-pressed={workspaceTab === "content"} className={workspaceTab === "content" ? "active" : ""} onClick={() => setWorkspaceTab("content")}><FileText size={20} /><span>内容</span></button>
      <button aria-label="排版设计" aria-pressed={workspaceTab === "design"} className={workspaceTab === "design" ? "active" : ""} onClick={() => setWorkspaceTab("design")}><Palette size={20} /><span>设计</span></button>
      <button aria-label="查看历史版本" onClick={() => setIsHistoryOpen(true)}><History size={20} /><span>版本</span></button>
      <button aria-label="打开 JD 工作台" onClick={() => setIsJdMatchOpen(true)}><Target size={20} /><span>岗位</span></button>
      <div className="rail-bottom"><span className="rail-local" title="简历与历史版本保存在当前浏览器"><ShieldCheck size={19} /></span><button aria-label="打开 AI 配置" onClick={() => setIsAiConfigOpen(true)}><Settings2 size={19} /><span>设置</span></button></div>
    </aside>
    <div className="studio-workspace">
      <header className="studio-header no-print"><div className="studio-brand"><strong>BetterMe<span> / </span></strong><span>迈向更好</span><ChevronRight size={13} /><span className="header-location">简历工作室</span></div><div className="header-actions"><span className={`save-indicator ${status.kind}`} title={status.message} role="status" aria-live="polite">{statusIcon}<span>{saveLabel}</span></span><button className="studio-button subtle" onClick={() => setIsAiConfigOpen(true)}><Bot size={15} />AI 配置</button><div className="studio-user" title="个人本地工作空间">{doc.factBase.profile.displayName.zh.slice(0, 1) || "我"}</div></div></header>
      <div className="studio-document-bar no-print">
        <div className="document-heading"><div className="studio-eyebrow">YOUR STORY, WELL TOLD</div><div className="document-title-row"><input aria-label="简历名称" value={activeResume.name === "Default" ? "我的简历" : activeResume.name} onChange={(event) => updateResume({ ...activeResume, name: event.target.value })} spellCheck={false} /><span className="document-badge">个人工作空间</span></div><p>把真实的经历，变成有分量的表达。</p></div>
        <div className="document-actions"><AutoSaveControls settings={autoSaveSettings} onChange={setAutoSaveSettings} onSave={() => void flush()} preferenceError={autoSavePreferenceError} /><div className="output-language" aria-label="简历输出语言"><Languages size={14} />{(["zh", "en"] as const).map((locale) => <button key={locale} aria-pressed={activeResume.locale === locale} className={activeResume.locale === locale ? "active" : ""} onClick={() => setLocale(locale)}>{locale === "zh" ? "中文" : "English"}</button>)}</div><button className="studio-button" onClick={() => setIsHistoryOpen(true)}><GitBranch size={14} />历史版本</button><button className="studio-button primary" onClick={() => setIsImportModalOpen(true)}><Upload size={14} />导入简历</button><div className="document-menu" ref={menuRef}><button className="studio-button icon-button" aria-label="更多简历操作" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen(!isMenuOpen)}><MoreHorizontal size={19} /></button>{isMenuOpen && <div className="document-dropdown"><button onClick={handleExportBackup}><Download size={14} />下载 JSON 备份</button><button onClick={() => fileInputRef.current?.click()}><RotateCcw size={14} />从备份恢复</button><button onClick={() => { void flush(); setIsMenuOpen(false); }}><Check size={14} />立即保存<span>Ctrl S</span></button><hr /><button onClick={() => void resetDemo()}><RotateCcw size={14} />恢复演示简历</button></div>}</div></div>
      </div>
      <div className="studio-notices no-print">
        {(status.kind === "error" || (status.kind === "draft" && hasIncompleteDraft) || status.historyError || isRestoring || actionError || status.rawDraftRecovery || status.rawOfficialRecovery || status.rawPreviousDraftRecovery || loadError) && <div className={`persistence-notice ${status.kind === "error" ? "error" : ""}`} role="status" aria-live="polite"><span>{isRestoring ? "正在读取备份，继续编辑会取消本次恢复。" : actionError || loadError || status.message}{status.historyError && ` ${status.historyError}`}</span><div>{status.kind === "error" && <button onClick={() => void flush()}>重试保存</button>}{status.rawDraftRecovery && <button onClick={() => downloadJson(status.rawDraftRecovery!, "better-me-draft-recovery.json")}>下载原始草稿</button>}<button onClick={handleExportBackup}>下载备份</button>{status.rawOfficialRecovery && <button onClick={() => downloadJson(status.rawOfficialRecovery!, "better-me-backup-recovery.json")}>下载原始文档</button>}{status.rawPreviousDraftRecovery && <button onClick={() => downloadJson(status.rawPreviousDraftRecovery!, "better-me-draft-before-switch.json")}>下载切换前草稿</button>}</div></div>}
        <IssuesPanel issues={issues} />
      </div>
      <ResizableWorkspace>
        <div id="resume-editor-panel" className="studio-editor-pane no-print">
          <div className="editor-workspace-tabs" role="tablist" aria-label="简历编辑工作区"><button role="tab" aria-selected={workspaceTab === "content"} aria-controls="content-panel" className={workspaceTab === "content" ? "active" : ""} onClick={() => setWorkspaceTab("content")}><FileText size={15} />内容编辑</button><button role="tab" aria-selected={workspaceTab === "design"} aria-controls="design-panel" className={workspaceTab === "design" ? "active" : ""} onClick={() => setWorkspaceTab("design")}><Palette size={15} />排版与模板</button><span className="workspace-tab-spacer" /><span className="edit-live-dot" title="修改实时反映在右侧预览" /></div>
          <div id="content-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "content"}><FactEditor factBase={doc.factBase} onChange={updateFactBase} textStyles={activeResume.textStyles} onTextStylesChange={updateStyles} onPreviewTargetChange={setPreviewTarget} /></div>
          <div id="design-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "design"}><ResumeDesignPanel view={activeResume} factBase={doc.factBase} onChange={updateResume} /></div>
          <button className="jd-workspace-invite" onClick={() => setIsJdMatchOpen(true)}><span className="jd-invite-icon"><Target size={17} /></span><span><strong>为下一个机会，调整这份简历</strong><small>招聘分享链接 · 截图识别 · JD 匹配</small></span><ArrowUpRight size={17} /></button>
        </div>
        <div id="resume-preview-panel" className="studio-preview-pane"><ResumePreview resume={projected} view={activeResume} onViewChange={updateResume} onTemplateChange={setTemplate} followTarget={workspaceTab === "content" ? previewTarget : null} /></div>
      </ResizableWorkspace>
      <footer className="studio-footer no-print"><span><ShieldCheck size={12} />本地保存 · 真实经历由你核实</span><span>{autoSaveDescription} · Ctrl + S 立即保存</span></footer>
    </div>
    <div className="no-print">
      <AiConfigModal isOpen={isAiConfigOpen} onClose={() => setIsAiConfigOpen(false)} config={llmConfig} onSave={handleSaveLlmConfig} />
      <JdMatchModal isOpen={isJdMatchOpen} onClose={() => setIsJdMatchOpen(false)} resume={projected} llmConfig={llmConfig} onOpenConfig={() => { setIsJdMatchOpen(false); setIsAiConfigOpen(true); }} />
      <ResumeImportModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} llmConfig={llmConfig} onImportSuccess={handleImportResumeSuccess} onOpenAiConfig={() => { setIsImportModalOpen(false); setIsAiConfigOpen(true); }} />
      {isHistoryOpen && <VersionHistoryPanel history={history} currentDocument={doc} onCheckpoint={checkpoint} onRestore={restoreVersion} onClose={() => setIsHistoryOpen(false)} />}
    </div>
  </div>;
}
