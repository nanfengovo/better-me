import { lazy, Suspense, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import {
  projectResume, projectedResumeToMarkdown, scanFactBase, createDefaultResumeView, syncResumeViewsWithFactBase, getJdMatchReadiness,
  LlmConfigSchema, type FactBase, type Locale, type ResumeView, type LlmConfig, type TextStyleRange, type ClaimIssue,
} from "@better-me/core";
import { createInitialDocument, exportDocumentJson, parseDocumentJson, DocumentSchema, STORAGE_KEY, type DocumentVersion, type DocumentFieldChange } from "@better-me/storage";
import { FactEditor } from "./components/FactEditor";
import { ResumePreview } from "./components/ResumePreview";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { ResumeDesignPanel } from "./components/ResumeDesignPanel";
import { VersionHistoryPanel } from "./components/VersionHistoryPanel";
import { AutoSaveControls } from "./components/AutoSaveControls";
import { IssuesPanel } from "./components/IssuesPanel";
import { ImportSourceReview } from "./components/ImportSourceReview";
import { AiConfigModal, DEFAULT_LLM_CONFIG } from "./components/AiConfigModal";
import { JdMatchModal } from "./components/JdMatchModal";
import { JdMatchDrawer, type DrawerJobContext } from "./components/JdMatchDrawer";
import { AgentWorkspace } from "./components/AgentWorkspace";
import type { MatchProposal, ResumeTextReference } from "./services/agent-client";
import type { ResumeProposalTarget } from "@better-me/agent-contracts";
import { applyResumeProposal, createResumeAgentContext } from "./lib/resume-agent-context";
import { triggerAgentGuide } from "./lib/agent-guide";
import "./components/agent-guide.css";
import { NetworkSettingsModal } from "./components/NetworkSettingsModal";
import { LazyResumeImportModal } from "./components/LazyResumeImportModal";
import { useConfirm } from "./components/ConfirmationDialog";
import { OpportunityWorkspace, type OpportunitySeed } from "./components/OpportunityWorkspace";
import { ResourceLibrary } from "./components/ResourceLibrary";
import { addResumeView, duplicateResumeView, removeResumeView, resumeNamesByOpportunity } from "./lib/resume-views";
import type { Opportunity, OpportunityMaterial } from "./lib/opportunities";
import { useDocumentPersistence } from "./lib/useDocumentPersistence";
import { useUiPreferences } from "./lib/ui-preferences";
import { WorkspacePreferences } from "./components/WorkspacePreferences";
import { rebaseViewTextStyles } from "./lib/text-formatting";
import type { PreviewFollowTarget } from "./lib/preview-follow";
import { createIssueNavigation, type IssueNavigationRequest } from "./lib/issue-navigation";
import { ArrowUpRight, BookOpen, Bot, BriefcaseBusiness, Check, ChevronRight, CloudOff, Download, FileText, GitBranch, Globe, History, Languages, Loader2, MessageSquare, MoreHorizontal, Palette, RotateCcw, Settings2, ShieldCheck, Sparkles, Upload, X } from "lucide-react";
import { AgentTopBarStatus } from "./components/AgentTopBarStatus";
import { AgentCompanion } from "./components/AgentCompanion";
import { ResumeWritingCopilot } from "./components/ResumeWritingCopilot";
import { FirstRunGuide } from "./components/FirstRunGuide";
import { writingSources, writingTargetKey } from "./lib/resume-copilot";

const AtlasWorkspace = lazy(() => import("./components/AtlasWorkspace"));
const ResumeJobRecommendations = lazy(() => import("./components/ResumeJobRecommendations"));
const LLM_CONFIG_KEY = "better-me:llm-config";
function downloadJson(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const { t } = useUiPreferences();
  const confirm = useConfirm();
  const { doc, ready, loadError, status, update, replace, restoreField, checkpoint, protectEdit, flush, history, autoSaveSettings, setAutoSaveSettings, autoSavePreferenceError } = useDocumentPersistence();
  const [workspaceTab, setWorkspaceTab] = useState<"content" | "design">("content");
  const [page, setPage] = useState<"resume" | "opportunities" | "resources" | "atlas" | "agent">(() => {
    const ws = new URLSearchParams(window.location.search).get("workspace");
    return ws === "atlas" ? "atlas" : ws === "agent" ? "agent" : "resume";
  });
  const [atlasInitialized, setAtlasInitialized] = useState(page === "atlas");
  const [opportunitySeed, setOpportunitySeed] = useState<OpportunitySeed | null>(null);
  const [jdSelection, setJdSelection] = useState<{ token: string; text: string; source: { title: string; url?: string; platform: string; observedAt?: string; sourcePublishedAt?: string; sourcePublishedText?: string } } | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewFollowTarget | null>(null);
  const [writingFocus, setWritingFocus] = useState<{ key: string; experienceId?: string; locale: "zh" | "en"; requestId: number } | null>(null);
  const [issueNavigation, setIssueNavigation] = useState<IssueNavigationRequest | null>(null);
  const issueRequestIdRef = useRef(0);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isAiConfigOpen, setIsAiConfigOpen] = useState(false);
  const [isNetworkSettingsOpen, setIsNetworkSettingsOpen] = useState(false);
  const [isJdMatchOpen, setIsJdMatchOpen] = useState(false);
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false);
  const [agentDrawerJob, setAgentDrawerJob] = useState<DrawerJobContext | null>(null);
  const [agentCompanionReference, setAgentCompanionReference] = useState<ResumeTextReference | null>(null);
  const [resumeSelectionReference, setResumeSelectionReference] = useState<ResumeTextReference | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [jobRecommendation, setJobRecommendation] = useState<{ documentId: string; factBase: FactBase; requestId: number } | null>(null);
  const recommendationRequestRef = useRef(0);
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
      if (event.target instanceof Element && event.target.closest(".confirmation-dialog")) return;
      if (page === "resume" && !isJdMatchOpen && !isAgentDrawerOpen && !isImportModalOpen && !isAiConfigOpen && !isNetworkSettingsOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); if (event.shiftKey) setIsHistoryOpen(true); else void flush();
      }
    };
    window.addEventListener("keydown", save); return () => window.removeEventListener("keydown", save);
  }, [flush, page, isJdMatchOpen, isAgentDrawerOpen, isImportModalOpen, isAiConfigOpen, isNetworkSettingsOpen]);
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
  const matchReadiness = useMemo(() => projected ? getJdMatchReadiness(projected) : null, [projected]);
  const resumeEditContext = useMemo(() => doc && activeResume ? createResumeAgentContext(doc.factBase, activeResume) : undefined, [doc, activeResume]);
  const writingContext = useMemo(() => {
    if (!doc || !activeResume) return [];
    const locales = activeResume.locale === "en" ? ["en", "zh"] as const : ["zh", "en"] as const;
    const sources = locales.flatMap(locale => writingSources(createResumeAgentContext(doc.factBase, { ...activeResume, locale })));
    return [...new Map(sources.map(source => [writingTargetKey(source.targetRef), source])).values()];
  }, [doc, activeResume]);
  const hasIncompleteDraft = useMemo(() => !!doc && !DocumentSchema.safeParse(doc).success, [doc]);
  const linkedResumeNames = useMemo(() => doc ? resumeNamesByOpportunity(doc) : Object.create(null) as Record<string, string[]>, [doc]);
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
  async function handleApplyResumeProposal(proposal: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }) {
    if (status.externalConflict) return { ok: false, message: t("另一窗口有尚未处理的简历修改；为保护双方内容，本次未写入。请先处理窗口冲突后重新生成建议。", "Another window has resume edits. Nothing was written; resolve the window conflict and regenerate the proposal.") };
    const current = docRef.current;
    if (!current) return { ok: false, message: t("简历尚未就绪，未写入。", "The resume is not ready. Nothing was written.") };
    const applied = applyResumeProposal(current, proposal);
    if (!applied.ok) return { ok: false, message: applied.reason === "conflict"
      ? t("建议生成后原文已变化或目标已删除；未写入。请重新读取简历并生成建议。", "The source changed or target was removed after this proposal was generated. Nothing was written; regenerate it from the current resume.")
      : t("建议内容无效，未写入。", "The proposed text is invalid. Nothing was written.") };
    const synced = syncResumeViewsWithFactBase(current.factBase, applied.document.factBase, current.resumeViews, current.activeResumeId);
    edit({ ...applied.document, resumeViews: rebaseViewTextStyles(current.factBase, applied.document.factBase, synced) });
    return { ok: true, message: t("已批准并提交到简历保存流程。草稿立即受保护；完整版本按当前自动保存设置保存，可在历史版本中恢复。", "Approved and submitted to the resume save flow. The draft is protected immediately; the complete version follows your autosave setting and can be restored from history.") };
  }
  async function handleApplyWritingProposal(proposal: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }) {
    const before = docRef.current;
    if (status.externalConflict || !await protectEdit(t("伴写修改前", "Before writing suggestion"))) return { ok: false, message: t("未能保护修改前的版本，本次没有写入；请先保存或下载备份。", "Could not protect the previous version. Nothing was written; save or download a backup first.") };
    if (docRef.current?.activeResumeId !== before?.activeResumeId || docRef.current?.factBase !== before?.factBase) return { ok: false, message: t("简历已切换或原文有新修改，本次没有写入，请重新核对。", "Resume changed. Nothing was written; review the suggestion again.") };
    return handleApplyResumeProposal(proposal);
  }
  function updateStyles(key: string, ranges: TextStyleRange[]) {
    const current = docRef.current;
    const view = current?.resumeViews.find((item) => item.id === current.activeResumeId);
    if (view) updateResume({ ...view, textStyles: { ...view.textStyles, [key]: ranges } });
  }
  function setResumeLocale(locale: Locale) { if (activeResume) updateResume({ ...activeResume, locale }); }
  function setTemplate(templateId: string) { if (activeResume) updateResume({ ...activeResume, templateId }); }
  function editResumeForMatching() {
    setIsJdMatchOpen(false);
    setPage("resume");
    setWorkspaceTab("content");
  }
  function navigateToIssue(issue: ClaimIssue) {
    const current = docRef.current;
    const request = current && createIssueNavigation(current.factBase, issue, ++issueRequestIdRef.current);
    if (!request) { setActionError(t("这条要点已删除或不在当前文档中，请重新查看内容检查。", "This item is no longer in this document. Reopen the content checks.")); return; }
    setPage("resume");
    setWorkspaceTab("content");
    setIssueNavigation(request);
  }
  function handleSaveLlmConfig(config: LlmConfig) {
    const validated = LlmConfigSchema.parse(config); localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(validated)); setLlmConfig(validated);
  }
  async function handleImportResumeSuccess(factBase: FactBase, _rawText: string, fileName: string) {
    const view = createDefaultResumeView(factBase); view.name = fileName.replace(/\.[^.]+$/, "") || t("我的简历", "My resume");
    restoreOperationRef.current += 1; setIsRestoring(false);
    const documentId = crypto.randomUUID();
    if (!(await replace({ documentId, factBase, resumeViews: [view], activeResumeId: view.id }, t(`导入 · ${fileName}`, `Import · ${fileName}`), "import"))) throw new Error(t("导入结果未能保存，当前简历已保留。请检查浏览器空间与字段格式。", "Could not save the import. Your current resume is preserved. Check local storage space and field values."));
    setJobRecommendation({ documentId, factBase, requestId: ++recommendationRequestRef.current });
    setIssueNavigation(null);
    setWorkspaceTab("content");
    setPage("resume");
  }
  function handleExportBackup() {
    if (!doc) return;
    try { downloadJson(exportDocumentJson(doc), `better-me-backup-${new Date().toISOString().slice(0, 10)}.json`); }
    catch { downloadJson(JSON.stringify(doc, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? null : value, 2), `better-me-draft-${new Date().toISOString().slice(0, 10)}.json`); setActionError(t("已下载未完成草稿。补齐必填字段后，可以导出可恢复的完整备份。", "Downloaded the incomplete draft. Complete required fields to export a full, restorable backup.")); }
    setIsMenuOpen(false);
  }
  function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    const operation = ++restoreOperationRef.current; setIsRestoring(true); setActionError("");
    void file.text().then(async (raw) => {
      if (operation !== restoreOperationRef.current) return;
      const restored = parseDocumentJson(raw);
      restored.documentId ??= crypto.randomUUID();
      const saved = await replace(restored, t(`恢复备份 · ${file.name}`, `Restore backup · ${file.name}`), "import");
      if (saved) setIssueNavigation(null);
      if (operation === restoreOperationRef.current && !saved) setActionError(t("备份未能保存，当前简历已保留。", "Could not save the backup. Your current resume is preserved."));
    }).catch((error) => {
      if (operation === restoreOperationRef.current) setActionError(error instanceof Error ? t(`恢复失败：${error.message}`, `Restore failed: ${error.message}`) : t("备份读取失败，请选择有效的 BetterMe JSON 文件。", "Could not read the backup. Select a valid BetterMe JSON file."));
    }).finally(() => { if (operation === restoreOperationRef.current) setIsRestoring(false); });
    setIsMenuOpen(false);
  }
  async function resetDemo() {
    setIsMenuOpen(false); if (!(await confirm(t("恢复演示简历？当前有效文档会先记录到历史版本。未完成草稿建议先下载备份。", "Reset to the demo resume? The current complete document will be saved to history first. Download a backup of any incomplete draft."), { title: t("恢复演示", "Reset demo"), confirmLabel: t("恢复演示", "Reset demo"), danger: true }))) return;
    restoreOperationRef.current += 1; setIsRestoring(false); if (await replace(createInitialDocument(), t("恢复演示简历", "Reset demo resume"), "import")) setIssueNavigation(null);
  }
  async function deleteResumeView(id: string) {
    if (!(await confirm(t("删除这份简历视图？真实经历保留，其他简历不受影响。", "Delete this resume view? Your experience and other resumes will be kept."), { title: t("删除简历视图", "Delete resume view"), confirmLabel: t("删除视图", "Delete view"), danger: true }))) return;
    const current = docRef.current;
    if (!current || !current.resumeViews.some((view) => view.id === id)) return;
    try { edit(removeResumeView(current, id)); }
    catch (error) { setActionError(error instanceof Error ? error.message : t("简历视图删除失败。", "Could not delete the resume view.")); }
  }
  async function restoreVersion(version: DocumentVersion) {
    restoreOperationRef.current += 1; setIsRestoring(false); setActionError("");
    const saved = await replace(version.document, t(`恢复 · ${version.label}`, `Restore · ${version.label}`), "restore");
    if (saved) setIssueNavigation(null);
    return saved;
  }
  async function restoreVersionField(version: DocumentVersion, change: DocumentFieldChange) {
    restoreOperationRef.current += 1;
    setIsRestoring(false);
    setActionError("");
    const saved = await restoreField(change, t(`单项恢复 · ${change.label} · ${version.label}`, `Restore field · ${change.label} · ${version.label}`));
    if (saved) {
      setIssueNavigation(null);
      setPreviewTarget(null);
    }
    return saved;
  }
  function createJobResume(job: Opportunity) {
    const current = docRef.current;
    if (!current) return;
    edit(duplicateResumeView(current, current.activeResumeId, { name: `${job.company} · ${job.title}`, targetJdId: job.id }));
    setPage("resume"); setWorkspaceTab("content");
  }
  function currentResumeMaterial(): Omit<OpportunityMaterial, "id" | "createdAt"> {
    const current = docRef.current;
    const view = current?.resumeViews.find((item) => item.id === current.activeResumeId);
    if (!current || !view || !DocumentSchema.safeParse(current).success) throw new Error(t("请先补齐并核对简历必填字段，再记录材料快照。", "Complete and review the required resume fields before saving a material snapshot."));
    return { resumeViewId: view.id, resumeName: view.name, resumeUpdatedAt: current.factBase.updatedAt > view.updatedAt ? current.factBase.updatedAt : view.updatedAt, locale: view.locale, markdown: projectedResumeToMarkdown(projectResume(current.factBase, view)) };
  }
  function openAgentWorkspace(job?: DrawerJobContext) {
    if (job) {
      setAgentDrawerJob(job);
    }
    setPage("agent");
  }
  function refreshJobRecommendations() {
    const current = docRef.current;
    if (current) setJobRecommendation({ documentId: current.documentId!, factBase: current.factBase, requestId: ++recommendationRequestRef.current });
  }
  function captureResumeTextSelection(event: SyntheticEvent) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".resume-workspace-body")) return;
    if (target.closest("textarea, input, button, select")) return;
    const text = window.getSelection()?.toString().trim();
    if (!text) { setResumeSelectionReference(null); return; }
    const anchor = target.closest<HTMLElement>("[data-editor-anchor]")?.dataset.editorAnchor
      ?? target.closest<HTMLElement>("[data-preview-anchor]")?.dataset.previewAnchor;
    const anchorLabels: Record<string, string> = {
      profile: "个人信息",
      "profile:displayName": "姓名",
      "profile:headline": "个人简介",
      "profile:photo": "头像照片",
      "profile:education": "教育背景",
      "profile:location": "所在地",
      "profile:email": "邮箱",
      "profile:phone": "电话",
      "profile:links": "相关链接",
      "profile:targetRoles": "目标岗位",
      "profile:traits": "核心优势",
      "section:summary": "个人概况",
      "section:skills": "专业技能",
      "section:experience": "工作经历",
      "section:education": "教育背景",
      "section:opensource": "项目与作品",
      "section:other": "其他经历",
    };
    const label = anchor ? anchorLabels[anchor]
      ?? (anchor.startsWith("claim:") ? "经历要点" : anchor.startsWith("experience:") ? "工作经历" : undefined) : undefined;
    setResumeSelectionReference({
      type: "resume_text",
      sourceLabel: `简历 · ${label ?? (target.closest(".resume-preview-canvas") ? "预览内容" : "简历内容")}`,
      text: text.slice(0, 12_000),
    });
  }
  function handleApplyCustomResume(payload: {
    acceptedProposals: MatchProposal[];
    customResumeName: string;
    targetJobTitle: string;
    targetCompany: string;
  }) {
    const current = docRef.current;
    if (!current) return;

    const duplicatedDoc = duplicateResumeView(current, current.activeResumeId, {
      name: payload.customResumeName || `${payload.targetCompany} · ${payload.targetJobTitle} 定制版`,
    });

    let updatedFactBase = duplicatedDoc.factBase;
    if (payload.acceptedProposals.length > 0 && updatedFactBase.experiences.length > 0) {
      const newClaims = payload.acceptedProposals.map((p) => ({
        id: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "action" as const,
        text: {
          zh: p.suggestion,
          en: p.suggestion,
        },
        tags: [t("AI定制", "AI tailored"), payload.targetCompany, payload.targetJobTitle].filter(Boolean),
      }));

      const updatedExperiences = updatedFactBase.experiences.map((exp, idx) => {
        if (idx === 0) {
          return {
            ...exp,
            claims: [...exp.claims, ...newClaims],
          };
        }
        return exp;
      });

      updatedFactBase = {
        ...updatedFactBase,
        experiences: updatedExperiences,
        updatedAt: new Date().toISOString(),
      };
    }

    const synced = syncResumeViewsWithFactBase(
      duplicatedDoc.factBase,
      updatedFactBase,
      duplicatedDoc.resumeViews,
      duplicatedDoc.activeResumeId
    );

    edit({
      ...duplicatedDoc,
      factBase: updatedFactBase,
      resumeViews: rebaseViewTextStyles(duplicatedDoc.factBase, updatedFactBase, synced),
    });

    setPage("resume");
    setWorkspaceTab("content");

    if (payload.acceptedProposals.length > 0) {
      setTimeout(() => {
        triggerAgentGuide({
          section: "experience",
          label: t(`✨ 已同步采纳 ${payload.acceptedProposals.length} 条定制建议至此经历`, `✨ Applied ${payload.acceptedProposals.length} tailored proposals here`),
          actionType: "applied",
        });
      }, 300);
    }
  }
  if (ready && loadError && !doc) return <div className="recovery-screen"><WorkspacePreferences /><div className="recovery-card"><ShieldCheck size={28} /><h1>{t("先保护好你的简历", "Protect your resume first")}</h1><p role="alert">{loadError}</p><p>{t("原始数据已保留。可以下载原文，或从有效备份恢复。", "The original data is preserved. Download it or restore a valid backup.")}</p><input type="file" ref={fileInputRef} accept=".json" onChange={handleFileSelected} className="hidden" /><div className="flex flex-wrap gap-3"><button className="studio-button" onClick={() => { try { downloadJson(localStorage.getItem(STORAGE_KEY) ?? "", "better-me-backup-recovery.json"); } catch { setActionError(t("浏览器拒绝读取存储。", "The browser blocked access to local storage.")); } }}>{t("下载原始数据", "Download original data")}</button><button className="studio-button primary" onClick={() => fileInputRef.current?.click()}>{t("恢复 JSON 备份", "Restore a JSON backup")}</button><button className="studio-button" onClick={() => void resetDemo()}>{t("恢复演示", "Reset demo")}</button></div>{actionError && <p role="alert">{actionError}</p>}</div></div>;
  if (!ready || !doc || !activeResume || !projected) return <div className="studio-loading"><Loader2 size={24} className="animate-spin" /><span>{t("正在打开你的简历工作室…", "Opening your resume studio…")}</span></div>;
  const statusIcon = status.kind === "pending" ? <Loader2 size={12} className="animate-spin" /> : status.kind === "error" ? <CloudOff size={12} /> : <Check size={12} />;
  const saveLabel = status.kind === "saved" ? t("已保存", "Saved") : status.kind === "draft" ? t("草稿已保护", "Draft protected") : status.kind === "pending" ? t("等待保存", "Save pending") : status.kind === "error" ? t("保存需要处理", "Save needs attention") : t("正在载入", "Loading");
  const autoSaveDescription = !autoSaveSettings.enabled ? t("自动保存已关闭", "Autosave is off") : autoSaveSettings.trigger === "enter" ? t("按回车保存", "Press Enter to save") : autoSaveSettings.trigger === "blur" ? t("离开编辑项时保存", "Save when leaving a field") : t(`停止输入 ${autoSaveSettings.delayMs / 1000} 秒后保存`, `Save after ${autoSaveSettings.delayMs / 1000} seconds of inactivity`);

  return <div className="studio-app">
    <input type="file" ref={fileInputRef} onChange={handleFileSelected} accept=".json" className="hidden" />
    <aside className="studio-rail no-print" aria-label={t("工作室导航", "Workspace navigation")}>
      <a className="studio-monogram" href="#" aria-label={t("BetterMe 简历工作室", "BetterMe resume studio")} onClick={(event) => { event.preventDefault(); setPage("resume"); setWorkspaceTab("content"); }}>b<span>m</span><i /></a><div className="rail-divider" />
      <button aria-label={t("内容编辑", "Content editor")} aria-pressed={page === "resume" && workspaceTab === "content"} className={page === "resume" && workspaceTab === "content" ? "active" : ""} onClick={() => { setPage("resume"); setWorkspaceTab("content"); }}><FileText size={20} /><span>{t("内容", "Content")}</span></button>
      <button aria-label={t("排版设计", "Resume design")} aria-pressed={page === "resume" && workspaceTab === "design"} className={page === "resume" && workspaceTab === "design" ? "active" : ""} onClick={() => { setPage("resume"); setWorkspaceTab("design"); }}><Palette size={20} /><span>{t("设计", "Design")}</span></button>
      <button aria-label={t("查看历史版本", "View version history")} onClick={() => setIsHistoryOpen(true)}><History size={20} /><span>{t("版本", "History")}</span></button>
      <button aria-label={t("AI 顾问工作台", "AI Agent Workspace")} aria-pressed={page === "agent"} className={page === "agent" ? "active" : ""} onClick={() => setPage("agent")}><Bot size={20} /><span>{t("顾问", "Agent")}</span></button>
      <button aria-label={t("机会与投递", "Opportunities & applications")} aria-pressed={page === "opportunities"} className={page === "opportunities" ? "active" : ""} onClick={() => setPage("opportunities")}><BriefcaseBusiness size={20} /><span>{t("机会", "Jobs")}</span></button>
      <button data-onboarding="atlas" aria-label={t("岗位地图", "Opportunity atlas")} aria-pressed={page === "atlas"} className={page === "atlas" ? "active" : ""} onClick={() => { setAtlasInitialized(true); setPage("atlas"); }}><Globe size={20} /><span>{t("地图", "Atlas")}</span></button>
      <button aria-label={t("求职资料库", "Career resources")} aria-pressed={page === "resources"} className={page === "resources" ? "active" : ""} onClick={() => setPage("resources")}><BookOpen size={20} /><span>{t("资料", "Resources")}</span></button>
      <div className="rail-bottom"><button aria-label={t("网络与代理设置", "Network & proxy settings")} onClick={() => setIsNetworkSettingsOpen(true)}><Globe size={19} /><span>{t("网络", "Network")}</span></button><span className="rail-local" title={t("简历与历史版本保存在当前浏览器", "Your resume and version history are stored in this browser")}><ShieldCheck size={19} /></span><button aria-label={t("打开 AI 配置", "Open AI configuration")} onClick={() => setIsAiConfigOpen(true)}><Settings2 size={19} /><span>{t("设置", "Settings")}</span></button></div>
    </aside>
    <div className="studio-workspace">
      <header className="studio-header no-print"><div className="studio-brand"><strong>BetterMe<span> / </span></strong><span>{t("迈向更好", "Your next chapter")}</span><ChevronRight size={13} /><span className="header-location">{page === "resume" ? t("简历工作室", "Resume studio") : page === "opportunities" ? t("机会与投递", "Opportunities & applications") : page === "atlas" ? t("岗位地图", "Opportunity atlas") : page === "agent" ? t("AI 顾问工作台", "AI Agent Workspace") : t("求职资料库", "Career resources")}</span></div><div className="header-actions"><WorkspacePreferences /><span className={`save-indicator ${status.kind}`} title={status.message} role="status" aria-live="polite">{statusIcon}<span>{page === "resume" ? saveLabel : t("简历：", "Resume: ") + saveLabel}</span></span><AgentTopBarStatus config={llmConfig} active={page === "agent"} onNavigateToAgent={() => setPage("agent")} onOpenAiConfig={() => setIsAiConfigOpen(true)} />
        <FirstRunGuide eligible={page === "resume" && workspaceTab === "content" && !isAiConfigOpen && !isNetworkSettingsOpen && !isJdMatchOpen && !isAgentDrawerOpen && !isImportModalOpen && !isHistoryOpen && !isRestoring} onPrepare={() => { setPage("resume"); setWorkspaceTab("content"); setIsMenuOpen(false); }} />
        <button data-onboarding="ai" className="studio-button subtle" onClick={() => setIsAiConfigOpen(true)}><Settings2 size={14} />{t("AI 配置", "AI settings")}</button><div className="studio-user" title={t("个人本地工作空间", "Personal local workspace")}>{doc.factBase.profile.displayName.zh.slice(0, 1) || "我"}</div></div></header>
      <div className="resume-workspace-body" hidden={page !== "resume"} onMouseUpCapture={captureResumeTextSelection} onKeyUpCapture={captureResumeTextSelection}>
      {resumeSelectionReference && <div className="no-print flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-[11px] text-emerald-950">
        <MessageSquare size={14} className="shrink-0 text-emerald-700" />
        <span className="min-w-0 flex-1 truncate" title={resumeSelectionReference.text}>{t("已选中简历预览文字：", "Selected resume text: ")}{resumeSelectionReference.text}</span>
        <button type="button" className="rounded-lg bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-800" onClick={() => { setAgentCompanionReference(resumeSelectionReference); setResumeSelectionReference(null); }}>{t("在 Agent 伴侣中提问", "Ask in Agent Companion")}</button>
        <button type="button" aria-label={t("关闭引用工具", "Dismiss quote action")} onClick={() => setResumeSelectionReference(null)} className="rounded p-1 text-emerald-700 hover:bg-emerald-100"><X size={13} /></button>
      </div>}
      <div className="studio-document-bar no-print">
        <div className="document-heading">
          <div className="document-title-row">
            <input aria-label={t("简历名称", "Resume name")} title={activeResume.name === "Default" ? t("我的简历", "My resume") : activeResume.name} value={activeResume.name === "Default" ? t("我的简历", "My resume") : activeResume.name} onChange={(event) => updateResume({ ...activeResume, name: event.target.value })} spellCheck={false} />
            <div className="resume-view-picker">
              <select aria-label={t("切换简历", "Switch resume")} value={activeResume.id} onChange={(event) => { const current = docRef.current; if (current) edit({ ...current, activeResumeId: event.target.value }); }}>
                {doc.resumeViews.map((view) => <option key={view.id} value={view.id}>{view.name === "Default" ? t("我的简历", "My resume") : view.name}</option>)}
              </select>
              <button onClick={() => { if (docRef.current) edit(addResumeView(docRef.current)); }} title={t("新建一份简历副本", "Create a new resume")}>{t("新建", "New")}</button>
              <button onClick={() => { if (docRef.current) edit(duplicateResumeView(docRef.current, activeResume.id)); }} title={t("复制当前简历配置", "Duplicate current resume")}>{t("复制", "Duplicate")}</button>
              <button disabled={doc.resumeViews.length <= 1} onClick={() => void deleteResumeView(activeResume.id)} title={t("删除当前简历版本", "Delete current resume")}>{t("删除", "Delete")}</button>
            </div>
            <span className="document-badge">{matchReadiness?.reason === "demo" || matchReadiness?.reason === "mixed-demo" ? t("含示例内容", "Includes demo content") : t("个人工作空间", "Personal workspace")}</span>
          </div>
        </div>
        <div className="document-actions">
          <div data-onboarding="save"><AutoSaveControls settings={autoSaveSettings} onChange={setAutoSaveSettings} onSave={() => void flush()} preferenceError={autoSavePreferenceError} /></div>
          <div className="output-language" role="group" aria-label={t("简历输出语言", "Resume output language")} title={t("只影响这份简历的预览与导出，不改变界面语言", "Only changes this resume’s preview and exports, independently of the interface language")}>
            <Languages size={14} /><span className="output-language-label">{t("简历语言", "Resume")}</span>
            {(["zh", "en"] as const).map((locale) => <button key={locale} aria-pressed={activeResume.locale === locale} className={activeResume.locale === locale ? "active" : ""} onClick={() => setResumeLocale(locale)}>{locale === "zh" ? "中文" : "English"}</button>)}
          </div>
          <button className="studio-button" onClick={() => setIsHistoryOpen(true)}><GitBranch size={14} />{t("历史版本", "Version history")}</button>
          <button className="studio-button" onClick={refreshJobRecommendations}><Sparkles size={14} />{t("推荐岗位", "Recommend jobs")}</button>
          <button className="studio-button primary" onClick={() => setIsImportModalOpen(true)}><Upload size={14} />{t("导入简历", "Import resume")}</button>
          <div className="document-menu" ref={menuRef}><button className="studio-button icon-button" aria-label={t("更多简历操作", "More resume actions")} aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen(!isMenuOpen)}><MoreHorizontal size={19} /></button>{isMenuOpen && <div className="document-dropdown"><button onClick={handleExportBackup}><Download size={14} />{t("下载 JSON 备份", "Download JSON backup")}</button><button onClick={() => fileInputRef.current?.click()}><RotateCcw size={14} />{t("从备份恢复", "Restore backup")}</button><button onClick={() => { void flush(); setIsMenuOpen(false); }}><Check size={14} />{t("立即保存", "Save now")}<span>Ctrl S</span></button><hr /><button onClick={() => void resetDemo()}><RotateCcw size={14} />{t("恢复演示简历", "Reset demo resume")}</button></div>}</div>
        </div>
      </div>
      <div className="studio-notices no-print">
        {(status.kind === "error" || (status.kind === "draft" && hasIncompleteDraft) || status.historyError || isRestoring || actionError || status.rawDraftRecovery || status.rawOfficialRecovery || status.rawPreviousDraftRecovery || loadError) && <div className={`persistence-notice ${status.kind === "error" ? "error" : ""}`} role="status" aria-live="polite"><span>{isRestoring ? t("正在读取备份，继续编辑会取消本次恢复。", "Reading backup. Continuing to edit will cancel this restoration.") : actionError || loadError || status.message}{status.historyError && ` ${status.historyError}`}</span><div>{status.kind === "error" && <button onClick={() => void flush()}>{t("重试保存", "Retry save")}</button>}{status.rawDraftRecovery && <button onClick={() => downloadJson(status.rawDraftRecovery!, "better-me-draft-recovery.json")}>{t("下载原始草稿", "Download original draft")}</button>}<button onClick={handleExportBackup}>{t("下载备份", "Download backup")}</button>{status.rawOfficialRecovery && <button onClick={() => downloadJson(status.rawOfficialRecovery!, "better-me-backup-recovery.json")}>{t("下载原始文档", "Download original document")}</button>}{status.rawPreviousDraftRecovery && <button onClick={() => downloadJson(status.rawPreviousDraftRecovery!, "better-me-draft-before-switch.json")}>{t("下载切换前草稿", "Download pre-switch draft")}</button>}</div></div>}
        <IssuesPanel issues={issues} factBase={doc.factBase} onNavigate={navigateToIssue} activeIssue={issueNavigation?.issue} />
        <ImportSourceReview source={doc.factBase.importSource} />
        {jobRecommendation && jobRecommendation.documentId === doc.documentId && <Suspense fallback={<div className="persistence-notice" role="status">{t("正在打开岗位推荐…", "Opening job recommendations…")}</div>}><ResumeJobRecommendations key={jobRecommendation.documentId} factBase={jobRecommendation.factBase} currentFactBase={doc.factBase} requestId={jobRecommendation.requestId} onRefresh={refreshJobRecommendations} onClose={() => setJobRecommendation(null)} onOpenAtlas={() => setPage("atlas")} onAnalyze={openAgentWorkspace} /></Suspense>}
      </div>
      <ResizableWorkspace>
        <div id="resume-editor-panel" data-onboarding="editor" className="studio-editor-pane no-print">
          <div id="content-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "content"}><FactEditor writingFocus={writingFocus} factBase={doc.factBase} onChange={updateFactBase} onAskAgentReference={(reference) => setAgentCompanionReference(reference)} textStyles={activeResume.textStyles} onTextStylesChange={updateStyles} onPreviewTargetChange={setPreviewTarget} issueNavigation={issueNavigation} onDismissIssue={() => setIssueNavigation(null)} /></div>
          <div id="design-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "design"}><ResumeDesignPanel view={activeResume} factBase={doc.factBase} onChange={updateResume} /></div>
          <button className="jd-workspace-invite" onClick={() => setPage("agent")}><span className="jd-invite-icon"><Sparkles size={17} /></span><span><strong>{t("AI Agent 岗位匹配与定制", "AI Agent Job Matching & Customization")}</strong><small>{t("多 Agent 协同 · 查企业 · 优化履历 · 答辩建议", "Multi-Agent · Employer research · Polish resume · Interview defense")}</small></span><ArrowUpRight size={17} /></button>
        </div>
        <div id="resume-preview-panel" className="studio-preview-pane"><ResumeWritingCopilot key={`${doc.documentId ?? "legacy"}:${activeResume.id}:${activeResume.targetJdId ?? ""}`} sessionKey={`${doc.documentId ?? "legacy"}:${activeResume.id}:${activeResume.targetJdId ?? ""}`} sources={writingContext} config={llmConfig} active={page === "resume" && workspaceTab === "content"} onApply={handleApplyWritingProposal} onFocus={(source) => {
          const target = source.targetRef;
          setWritingFocus({ key: writingTargetKey(target), locale: target.locale, experienceId: target.kind === "claim_text" ? target.experienceId : undefined, requestId: ++issueRequestIdRef.current });
          setPreviewTarget({ anchor: target.kind === "claim_text" ? `claim:${target.claimId}` : "profile:headline", source: "focus" });
        }}><ResumePreview resume={projected} view={activeResume} onViewChange={updateResume} onTemplateChange={setTemplate} followTarget={workspaceTab === "content" ? previewTarget : null} /></ResumeWritingCopilot></div>
      </ResizableWorkspace>
      </div>
      <div className="secondary-workspace no-print" hidden={page !== "opportunities"}><OpportunityWorkspace seed={opportunitySeed} onSeedConsumed={() => setOpportunitySeed(null)} linkedResumeNames={linkedResumeNames} getCurrentResumeMaterial={currentResumeMaterial} onOpenJd={() => setIsJdMatchOpen(true)} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onCreateResume={createJobResume} onAnalyze={(job) => { openAgentWorkspace({ id: job.id, title: job.title, company: job.company, location: [job.location.city, job.location.region].filter(Boolean).join(" · ") || undefined, salary: job.salaryText || undefined, description: job.description, sourceUrl: job.sourceUrl || undefined, sourcePlatform: job.sourcePlatform }); }} /></div>
      {atlasInitialized && <div className="secondary-workspace no-print" hidden={page !== "atlas"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载岗位地图…", "Loading opportunity atlas…")}</div>}><AtlasWorkspace resume={projected} factBase={doc.factBase} onOpenOpportunitySources={() => setPage("opportunities")} active={page === "atlas"} onSaveOpportunity={(seed) => { setOpportunitySeed(seed); setPage("opportunities"); }} onAnalyze={(item) => { const parts = item.title.split(" · "); const company = (parts.length > 1 && parts[0]) ? parts[0] : ""; const title = parts.length > 1 ? parts.slice(1).join(" · ") : item.title; openAgentWorkspace({ title: title || "目标岗位", company: company || "目标企业", description: item.text ?? "", sourceUrl: item.url, sourcePlatform: item.platform }); }} /></Suspense></div>}
      <div className="secondary-workspace no-print" hidden={page !== "resources"}><ResourceLibrary /></div>
      <div className="secondary-workspace no-print" hidden={page !== "agent"}><AgentWorkspace job={agentDrawerJob} resume={projected} resumeEditContext={resumeEditContext} onApplyResumeProposal={handleApplyResumeProposal} llmConfig={llmConfig} onOpenConfig={() => setIsAiConfigOpen(true)} onNavigateToResume={() => { setPage("resume"); setWorkspaceTab("content"); }} onApplyToResume={handleApplyCustomResume} onSaveOpportunity={(job) => { setOpportunitySeed({ token: crypto.randomUUID(), title: job.title, description: job.description, sourceUrl: job.sourceUrl, sourcePlatform: job.sourcePlatform }); setPage("opportunities"); }} /></div>
      <footer className="studio-footer no-print"><span><ShieldCheck size={12} />{t("本地保存 · 真实经历由你核实", "Saved locally · You verify your experience")}</span><span>{page === "resume" ? t(`${autoSaveDescription} · Ctrl + S 立即保存`, `${autoSaveDescription} · Ctrl + S to save now`) : page === "opportunities" ? t("岗位信息与跟进需点击保存", "Click Save to keep job details and follow-ups") : page === "atlas" ? t("地图、列表与统计使用同一查询 · 来源与事实需核实", "Map, list and statistics share one query · Verify source facts") : page === "agent" ? t("本地 Agent 编排 · 逐条核实履历 · 真实推理由你掌控", "Local Agent orchestration · Verify claims item-by-item · Full user control") : t("查看原始出处，按需使用资料", "Visit original sources and use resources as needed")}</span></footer>
    </div>
    <div className="no-print">
      <NetworkSettingsModal isOpen={isNetworkSettingsOpen} onClose={() => setIsNetworkSettingsOpen(false)} />
      <AiConfigModal isOpen={isAiConfigOpen} onClose={() => setIsAiConfigOpen(false)} config={llmConfig} onSave={handleSaveLlmConfig} />
      <JdMatchModal onImportResume={() => setIsImportModalOpen(true)} onEditResume={editResumeForMatching} onSaveOpportunity={({ text, provenance }) => { setOpportunitySeed({ token: crypto.randomUUID(), description: text, title: provenance?.title, sourceUrl: provenance?.url, sourcePlatform: provenance?.platform, collectedAt: provenance?.observedAt, sourcePublishedAt: provenance?.sourcePublishedAt, sourcePublishedText: provenance?.sourcePublishedText }); setIsJdMatchOpen(false); setPage("opportunities"); }} isOpen={isJdMatchOpen && !jdSelection} onClose={() => setIsJdMatchOpen(false)} resume={projected} llmConfig={llmConfig} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onOpenConfig={() => { setIsJdMatchOpen(false); setIsAiConfigOpen(true); }} />
      {jdSelection && <JdMatchModal onImportResume={() => setIsImportModalOpen(true)} onEditResume={editResumeForMatching} key={jdSelection.token} initialText={jdSelection.text} initialSource={jdSelection.source} isOpen={isJdMatchOpen} onClose={() => { setIsJdMatchOpen(false); setJdSelection(null); }} resume={projected} llmConfig={llmConfig} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onOpenConfig={() => { setIsJdMatchOpen(false); setJdSelection(null); setIsAiConfigOpen(true); }} />}
      <LazyResumeImportModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} llmConfig={llmConfig} onImportSuccess={handleImportResumeSuccess} onOpenAiConfig={() => { setIsImportModalOpen(false); setIsAiConfigOpen(true); }} />
      {isHistoryOpen && <VersionHistoryPanel history={history} currentDocument={doc} persistenceStatus={status} onCheckpoint={checkpoint} onRestore={restoreVersion} onRestoreField={restoreVersionField} onClose={() => setIsHistoryOpen(false)} />}
      <JdMatchDrawer
        isOpen={isAgentDrawerOpen}
        onClose={() => setIsAgentDrawerOpen(false)}
        job={agentDrawerJob}
        resume={projected}
        llmConfig={llmConfig}
        onOpenConfig={() => {
          setIsAgentDrawerOpen(false);
          setIsAiConfigOpen(true);
        }}
        onApplyToResume={handleApplyCustomResume}
        onSaveOpportunity={(job) => {
          setOpportunitySeed({
            token: crypto.randomUUID(),
            title: job.title,
            description: job.description,
            sourceUrl: job.sourceUrl,
            sourcePlatform: job.sourcePlatform,
          });
          setIsAgentDrawerOpen(false);
          setPage("opportunities");
        }}
      />
      <AgentCompanion
        onOpenWorkspace={() => setPage("agent")}
        llmConfig={llmConfig}
        resume={projected}
        initialReference={agentCompanionReference}
        onReferenceConsumed={() => setAgentCompanionReference(null)}
        onOpenAiConfig={() => setIsAiConfigOpen(true)}
      />
    </div>
  </div>;
}
