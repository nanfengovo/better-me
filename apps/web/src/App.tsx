import { lazy, Suspense, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { captureIdentityLease, privateStorage as localStorage } from "./lib/identity";
import { useWorkspaceNavigation } from "./lib/workspace-navigation";
import { WorkspaceRecoveryNotice } from "./components/WorkspaceRecoveryNotice";
import {
  projectResume, projectedResumeToMarkdown, scanFactBase, createDefaultResumeView, syncResumeViewsWithFactBase, getJdMatchReadiness,
  LlmConfigSchema, resolveResumeFactBase, careerTaskSourceFingerprint, careerTaskCommandFingerprint, createCareerTaskResume,
  factBaseToJsonResume, isJsonResumePayload, jsonResumeToFactBase,
  type CareerTaskResumeCommand, type CareerTaskResumeReceipt, type FactBase, type Locale, type ResumeView, type LlmConfig, type TextStyleRange, type ClaimIssue,
} from "@better-me/core";
import { createInitialDocument, exportDocumentJson, parseDocumentJson, DocumentSchema, documentFingerprint, type BetterMeDocument, type DocumentVersion, type DocumentFieldChange } from "@better-me/storage";
import { ResumeReplacementEditor, type EditionReadbackNotice } from "./components/ResumeReplacementEditor";
import { FactEditor } from "./components/FactEditor";
import { ResumePreview, toAtsPlainText } from "./components/ResumePreview";
import { BookOpenCheck, Radar, Search } from "lucide-react";
import { BackgroundJobWatchCenter, type BackgroundWatchTarget } from "./components/BackgroundJobWatch";
import { resumeDiscoveryCriteria } from "./lib/resume-discovery-criteria";
import type { ResumeDiscoverySelection } from "./components/ResumeJobDiscoveryDialog";
const ResumeJobDiscoveryDialog = lazy(() => import("./components/ResumeJobDiscoveryDialog").then(module => ({ default: module.ResumeJobDiscoveryDialog })));
import { inventorySource } from "./lib/inventory-source";
import { inventoryClient } from "./services/inventory-client";
import { careerJobSnapshotVersion, inventoryKey, type InventoryView } from "@better-me/agent-contracts";
import "./components/career-inventory.css";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { AutoSaveControls } from "./components/AutoSaveControls";
import { DocumentSaveStatus } from "./components/DocumentSaveStatus";
import { showResumeEditor } from "./lib/agent-navigation";
import { IssuesPanel } from "./components/IssuesPanel";
const ResumeDesignPanel = lazy(() => import("./components/ResumeDesignPanel").then(module => ({ default: module.ResumeDesignPanel })));
const ImportSourceReview = lazy(() => import("./components/ImportSourceReview").then(module => ({ default: module.ImportSourceReview })));
import { DEFAULT_LLM_CONFIG } from "./lib/llm-config";
import type { DrawerJobContext } from "./components/JdMatchDrawer";
import type { TrainingRequirementSelection } from "./components/CareerTrainingPanel";
import { AgentTaskNavigation, type AgentTaskView } from "./components/AgentTaskNavigation";
import { openSystemSettings } from "./lib/settings-navigation";
import type { MatchProposal, ResumeTextReference } from "./services/agent-client";
import type { CareerTask, ResumeProposalTarget } from "@better-me/agent-contracts";
import { applyResumeProposal, createResumeAgentContext, type ResumeProposalWrite } from "./lib/resume-agent-context";
import { approveCareerTaskStatement } from "./lib/career-task-facts";
import { inspectCareerTaskWorkspace, resumeSaveCommand, type WorkspaceReceiptRequest, type WorkspaceReceiptInspection } from "./lib/career-task-reconciliation";
import { defaultCareerTaskClient } from "./services/career-task-client";
import { createCareerStudioClient } from "./services/career-studio-client";
import { buildCareerLayoutDocument } from "./lib/career-studio-adoption";
import { buildCareerEvidenceStatement, CareerEvidenceEntrySchema } from "./lib/career-studio-evidence";
import type { CareerLayoutAdoptionContext, CareerLayoutAdoptionReceipt } from "./lib/career-studio-layout";
import type { LayoutCandidate } from "./lib/layout-compiler";
import "./components/CareerStudioWorkspace.css";
import "./components/agent-guide.css";
import "./components/workspace-refinements.css";
import "./components/resume-paper.css";
import "./components/templates/rendercv-themes.css";
import "./components/templates/jsonresume-themes.css";
import "./components/templates/jsonresume-community-themes.css";
import "./components/templates/jsonresume-extra-themes.css";
import "./components/templates/newfuture-theme.css";
import "./components/templates/billryan-theme.css";
import "./components/templates/best-resume-themes.css";
import "./components/templates/community-themes.css";
import "./components/templates/lppl-community-themes.css";
import "./components/templates/cc-community-themes.css";
import "./components/templates/deedy-theme.css";
import "./components/templates/rickosborne-theme.css";
import "./components/preview-toolbar.css";
import "./components/template-gallery.css";
import "./components/resume-themes.css";
import { NetworkSettingsModal } from "./components/NetworkSettingsModal";
import { LazyResumeImportModal } from "./components/LazyResumeImportModal";
import { useConfirm } from "./components/ConfirmationDialog";
import type { OpportunitySeed } from "./components/OpportunityWorkspace";
import { addResumeView, duplicateResumeView, removeResumeView, resumeNamesByOpportunity } from "./lib/resume-views";
import { opportunityDecisionCareerJob, type Opportunity } from "./lib/opportunities";
import { currentOpportunityResumeMaterial, opportunityDecisionEvidence } from "./lib/opportunity-decision-source";
import { isRequirementTraining, preserveRequirementReviews, requirementRetest, withRequirementEvidence, type EvidenceWorkspace } from "./lib/requirement-evidence";
import { defaultLearningClient } from "./services/learning-client";
import { useDocumentPersistence } from "./lib/useDocumentPersistence";
import { isStaticPublicPreview } from "./lib/runtime-mode";
import { useUiPreferences } from "./lib/ui-preferences";
import { WorkspacePreferences } from "./components/WorkspacePreferences";
import { WorkspaceMenu } from "./components/WorkspaceMenu";
import { rebaseViewTextStyles } from "./lib/text-formatting";
import type { PreviewFollowTarget } from "./lib/preview-follow";
import { createIssueNavigation, type IssueNavigationRequest } from "./lib/issue-navigation";
import { Maximize2, Check, Download, FileSearch, FileText, GitBranch, Globe, Loader2, MessageSquare, MoreHorizontal, Plug, RotateCcw, ShieldCheck, Sparkles, Upload, X, Keyboard, Layout, Compass, Bot, Zap, Undo2, Redo2, SlidersHorizontal } from "lucide-react";
import { exportInteractivePortfolioHtml } from "./lib/interactive-portfolio-export";
import { Button, CommandPalette, SegmentedControl, SelectMenu, type CommandItem } from "./design-system";
import { formatShortcut, formatShortcutTokens, isMacPlatform, matchesShortcut, useShortcuts } from "./lib/shortcuts";
import { useDocumentUndo } from "./lib/useDocumentUndo";
import { AgentTopBarStatus } from "./components/AgentTopBarStatus";
const AgentCompanion = lazy(() => import("./components/AgentCompanion").then(module => ({ default: module.AgentCompanion })));
import { LocalAgentRuntimeProvider } from "./lib/local-agent-runtime";
import { ResumeWritingCopilot, type InventoryWritingControl } from "./components/ResumeWritingCopilot";
import { FirstRunGuide } from "./components/FirstRunGuide";
import { writingSources, writingTargetKey, writingProjectSourceKey } from "./lib/resume-copilot";
import { reviewResumeEdition } from "./lib/resume-editorial-review";
import { AgentSourceBridge, BetterMeAgentProvider } from "./lib/betterme-agent/react";
import { BetterMeAgentCenter } from "./components/BetterMeAgentCenter";
import { AgentSidebarProvider } from "./components/AgentSidebar";
import { UnifiedCareerTaskSurface } from "./components/UnifiedCareerTaskSurface";
import { DesktopShell } from "./components/desktop/DesktopShell";
import "./components/desktop/desktop.css";

import { RecoverableModule } from "./components/atlas/RecoverableModule";
import type { ComponentProps } from "react";
const loadAtlasWorkspace = () => import("./components/AtlasWorkspace");
function AtlasWorkspace(props: ComponentProps<typeof import("./components/AtlasWorkspace").default>) {
  return <RecoverableModule load={loadAtlasWorkspace} componentProps={props} label="岗位地图" onExit={props.onOpenOpportunitySources} />;
}
const ResumeJobRecommendations = lazy(() => import("./components/ResumeJobRecommendations"));
const CareerInventory = lazy(() => import("./components/CareerInventory").then(m => ({ default: m.CareerInventory })));
const CareerStudioWorkspace = lazy(() => import("./components/CareerStudioWorkspace").then(module => ({ default: module.CareerStudioWorkspace })));
const GrowthJourneyWorkspace = lazy(() => import("./components/GrowthWorkspace").then(module => ({ default: module.GrowthWorkspace })));
const AgentWorkspace = lazy(() => import("./components/AgentWorkspace").then(module => ({ default: module.AgentWorkspace })));
const OpportunityWorkspace = lazy(() => import("./components/OpportunityWorkspace").then(module => ({ default: module.OpportunityWorkspace })));
const ResourceLibrary = lazy(() => import("./components/ResourceLibrary").then(module => ({ default: module.ResourceLibrary })));
const AutopilotStudioWorkspace = lazy(() => import("./components/AutopilotStudioWorkspace").then(module => ({ default: module.AutopilotStudioWorkspace })));
const VersionHistoryPanel = lazy(() => import("./components/VersionHistoryPanel").then(module => ({ default: module.VersionHistoryPanel })));
const AiConfigModal = lazy(() => import("./components/AiConfigModal").then(module => ({ default: module.AiConfigModal })));
const JdMatchModal = lazy(() => import("./components/JdMatchModal").then(module => ({ default: module.JdMatchModal })));
const JdMatchDrawer = lazy(() => import("./components/JdMatchDrawer").then(module => ({ default: module.JdMatchDrawer })));
const AtsDiagnosticTool = lazy(() => import("./components/AtsDiagnosticTool").then(module => ({ default: module.AtsDiagnosticTool })));
const SkillEvidenceAtlas = lazy(() => import("./components/SkillEvidenceAtlas").then(module => ({ default: module.SkillEvidenceAtlas })));
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
  const { doc, ready, loadError, status, update, replace, restoreField, checkpoint, protectEdit, saveReviewedVersion, readOfficialForReview, flush, history, autoSaveSettings, setAutoSaveSettings, autoSavePreferenceError } = useDocumentPersistence();
  const { shortcuts } = useShortcuts();
  const docUndo = useDocumentUndo<NonNullable<typeof doc>>(50);
  const [undoFeedback, setUndoFeedback] = useState<string | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const showUndoFeedback = (label: string) => {
    setUndoFeedback(label);
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => { setUndoFeedback(null); undoTimerRef.current = null; }, 1800);
  };
  const { page, setPage, workspaceTab, setWorkspaceTab, agentMode, setAgentMode, recovery: navigationRecovery } = useWorkspaceNavigation();
  const [studioInitialized, setStudioInitialized] = useState(agentMode === "studio");
  const [agentNavigation, setAgentNavigation] = useState<{ view: AgentTaskView; id: number; trainingRequirement?: TrainingRequirementSelection }>();
  function openAgentArea(area: "growth" | "studio") {
    if (area === "studio") setStudioInitialized(true);
    setAgentMode(area);
  }
  const [focused, setFocused] = useState(false);
  const [resumeDiscovery, setResumeDiscovery] = useState<ResumeDiscoverySelection>();
  const [backgroundWatch, setBackgroundWatch] = useState<BackgroundWatchTarget>();
  const [atlasInitialized, setAtlasInitialized] = useState(page === "atlas");
  const [opportunitiesInitialized, setOpportunitiesInitialized] = useState(page === "opportunities");
  const [resourcesInitialized, setResourcesInitialized] = useState(page === "resources");
  const [agentAdvisorInitialized, setAgentAdvisorInitialized] = useState(page === "agent" && agentMode === "advisor");
  const [autopilotInitialized, setAutopilotInitialized] = useState(page === "autopilot");
  useEffect(() => {
    if (page === "atlas") setAtlasInitialized(true);
    if (page === "opportunities") setOpportunitiesInitialized(true);
    if (page === "resources") setResourcesInitialized(true);
    if (page === "agent" && agentMode === "advisor") setAgentAdvisorInitialized(true);
    if (page === "autopilot") setAutopilotInitialized(true);
  }, [page, agentMode]);
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
  const [replacementSelection, setReplacementSelection] = useState<{ viewId: string; job: DrawerJobContext }>();
  const [editionReadback, setEditionReadback] = useState<EditionReadbackNotice & {
    receipt: CareerTaskResumeReceipt; workspaceKey: string; identitySignal: AbortSignal;
  }>();
  const [agentCompanionReference, setAgentCompanionReference] = useState<ResumeTextReference | null>(null);
  const [agentCompanionPrompt, setAgentCompanionPrompt] = useState<string | null>(null);
  const [resumeSelectionReference, setResumeSelectionReference] = useState<ResumeTextReference | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [inventoryInvite, setInventoryInvite] = useState<string>();
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [inventoryReview, setInventoryReview] = useState<InventoryView | null>(null);
  const inventoryWriting = useRef<InventoryWritingControl>(null);
  const [jobRecommendation, setJobRecommendation] = useState<{ documentId: string; factBase: FactBase; requestId: number } | null>(null);
  const recommendationRequestRef = useRef(0);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isAtsDiagnosticsOpen, setIsAtsDiagnosticsOpen] = useState(false);
  const [isSkillAtlasOpen, setIsSkillAtlasOpen] = useState(false);
  const [editorFocusAnchor, setEditorFocusAnchor] = useState<{ anchor: string; requestId: number } | null>(null);
  const [actionError, setActionError] = useState("");
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreOperationRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const [careerSourceFingerprint, setCareerSourceFingerprint] = useState<string>();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LLM_CONFIG_KEY);
      if (saved) { const parsed = LlmConfigSchema.safeParse(JSON.parse(saved)); if (parsed.success) setLlmConfig(parsed.data); }
    } catch { /* Separate model configuration must not prevent opening the resume. */ }
  }, []);
  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && (event.target.closest(".confirmation-dialog") || event.target.closest('[data-recording="true"]'))) return;
      const modalOpen = isJdMatchOpen || isAgentDrawerOpen || isImportModalOpen || isAiConfigOpen || isNetworkSettingsOpen || isHistoryOpen || isAtsDiagnosticsOpen || isSkillAtlasOpen || inventoryOpen;

      if (matchesShortcut(event, shortcuts.commandPalette, mac)) {
        event.preventDefault();
        setIsCommandPaletteOpen((open) => !open);
        return;
      }
      if (isCommandPaletteOpen) return;

      if (matchesShortcut(event, shortcuts.openSettings, mac)) {
        event.preventDefault();
        openSystemSettings("shortcuts");
        return;
      }
      if (matchesShortcut(event, shortcuts.switchResume, mac)) { event.preventDefault(); setPage("resume"); return; }
      if (matchesShortcut(event, shortcuts.switchOpportunities, mac)) { event.preventDefault(); setPage("opportunities"); return; }
      if (matchesShortcut(event, shortcuts.switchAtlas, mac)) { event.preventDefault(); setPage("atlas"); return; }
      if (matchesShortcut(event, shortcuts.switchAgent, mac)) { event.preventDefault(); setPage("agent"); return; }

      if (page !== "resume" || modalOpen) return;

      if (matchesShortcut(event, shortcuts.redo, mac) || (!mac && shortcuts.redo === "mod+shift+z" && matchesShortcut(event, "ctrl+y", false))) {
        const current = docRef.current;
        if (current) {
          const next = docUndo.redo(current);
          if (next) {
            event.preventDefault();
            restoreOperationRef.current += 1;
            setIsRestoring(false);
            setActionError("");
            docRef.current = next;
            update(next);
            showUndoFeedback(t("已重做修改", "Redone"));
          }
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.undo, mac)) {
        const current = docRef.current;
        if (current) {
          const prev = docUndo.undo(current);
          if (prev) {
            event.preventDefault();
            restoreOperationRef.current += 1;
            setIsRestoring(false);
            setActionError("");
            docRef.current = prev;
            update(prev);
            showUndoFeedback(t("已撤销修改", "Undone"));
          }
        }
        return;
      }
      if (matchesShortcut(event, shortcuts.history, mac)) { event.preventDefault(); setIsHistoryOpen(true); return; }
      if (matchesShortcut(event, shortcuts.save, mac)) { event.preventDefault(); void flush(); return; }
      if (matchesShortcut(event, shortcuts.focusMode, mac)) { event.preventDefault(); setFocused((v) => !v); return; }
      if (matchesShortcut(event, shortcuts.toggleDesign, mac)) { event.preventDefault(); setWorkspaceTab((tab) => (tab === "content" ? "design" : "content")); return; }
      if (matchesShortcut(event, shortcuts.findJobs, mac)) { event.preventDefault(); openResumeDiscovery(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, flush, page, isCommandPaletteOpen, isJdMatchOpen, isAgentDrawerOpen, isImportModalOpen, isAiConfigOpen, isNetworkSettingsOpen, docUndo, update, setPage, setWorkspaceTab, t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isMenuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setIsMenuOpen(false); menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [isMenuOpen]);

  const activeResume = useMemo(() => doc?.resumeViews.find((view) => view.id === doc.activeResumeId) ?? doc?.resumeViews[0] ?? null, [doc]);
  useEffect(() => {
    setResumeDiscovery(current => current && (page !== "resume" || current.viewId !== activeResume?.id || current.documentId !== doc?.documentId) ? undefined : current);
  }, [page, activeResume?.id, doc?.documentId]);
  const editorJob = activeResume && replacementSelection?.viewId === activeResume.id ? replacementSelection.job
    : activeResume && !activeResume.careerTaskReceipt && (!activeResume.targetJdId || activeResume.targetJdId === agentDrawerJob?.id) ? agentDrawerJob ?? undefined : undefined;
  const effectiveFactBase = useMemo(() => doc && activeResume ? resolveResumeFactBase(doc.factBase, activeResume) : doc?.factBase, [doc, activeResume]);
  const inventoryMaterial = useMemo(() => {
    if (!doc?.documentId || !activeResume || !effectiveFactBase) return null;
    try { return inventorySource(doc.documentId, activeResume.id, effectiveFactBase); } catch { return null; }
  }, [doc?.documentId, activeResume?.id, effectiveFactBase]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentInventory = inventoryReview?.session.source.fingerprint === inventoryMaterial?.fingerprint ? inventoryReview : null;
  function assertInventorySource() {
    const cur = docRef.current, view = cur?.resumeViews.find(r => r.id === cur.activeResumeId);
    if (!cur?.documentId || !view || !inventoryMaterial || status.externalConflict ||
      inventorySource(cur.documentId, view.id, resolveResumeFactBase(cur.factBase, view)).fingerprint !== inventoryMaterial.fingerprint)
      throw Error("底稿已变化，请重新核对最新版本。");
  }
  function openInventory() {
    if (doc && !doc.documentId) { setActionError("这份早期文档没有可绑定的标识，尚未开始盘点。可从更多简历操作下载 JSON 备份，再使用「从备份恢复」保留内容和视图并生成新标识。"); return; }
    if (!inventoryMaterial || status.externalConflict) { setActionError("底稿标识、材料大小或内容无法安全核对；请保存有效版本并处理窗口冲突后再盘点。"); return; }
    setInventoryOpen(true); setInventoryInvite(undefined);
  }
  const inventoryRecordKey = inventoryMaterial ? inventoryKey(inventoryMaterial) : undefined;
  useEffect(() => {
    if (!isAtsDiagnosticsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setIsAtsDiagnosticsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAtsDiagnosticsOpen]);

  useEffect(() => {
    if (!inventoryRecordKey || page !== "resume" || isStaticPublicPreview()) return;
    let alive = true;
    void inventoryClient.get(inventoryRecordKey).then(v => { if (alive) setInventoryReview(v?.session.phase === "confirmed" ? v : null); }, () => { if (alive) setInventoryReview(null); });
    return () => { alive = false; };
  }, [inventoryRecordKey, page, inventoryOpen]);
  const issues = useMemo(() => effectiveFactBase ? scanFactBase(effectiveFactBase) : [], [effectiveFactBase]);
  useEffect(() => {
    let current = true; setCareerSourceFingerprint(undefined);
    if (doc && activeResume) void careerTaskSourceFingerprint(doc, activeResume.id).then(value => { if (current) setCareerSourceFingerprint(value); }).catch(() => {});
    return () => { current = false; };
  }, [doc, activeResume]);
  const projected = useMemo(() => doc && activeResume ? projectResume(doc.factBase, activeResume) : null, [doc, activeResume]);
  const editorialFindings = useMemo(() => projected ? reviewResumeEdition(projected) : undefined, [projected]);
  const matchReadiness = useMemo(() => projected ? getJdMatchReadiness(projected) : null, [projected]);
  const resumeEditContext = useMemo(() => doc && activeResume ? createResumeAgentContext(doc.factBase, activeResume) : undefined, [doc, activeResume]);
  const inventoryFields = useMemo(() => resumeEditContext ? writingSources(resumeEditContext) : [], [resumeEditContext]);
  const writingContext = useMemo(() => {
    if (!doc || !activeResume) return [];
    const locales = activeResume.locale === "en" ? ["en", "zh"] as const : ["zh", "en"] as const;
    const sources = locales.flatMap(locale => writingSources(createResumeAgentContext(doc.factBase, { ...activeResume, locale })));
    return [...new Map(sources.map(source => [writingTargetKey(source.targetRef), source])).values()];
  }, [doc, activeResume]);
  const hasIncompleteDraft = useMemo(() => !!doc && !DocumentSchema.safeParse(doc).success, [doc]);
  const agentSources = useMemo(() => {
    if (!doc) return [];
    const values = doc.resumeViews.flatMap(view => (["zh", "en"] as const).flatMap(locale => writingSources(createResumeAgentContext(doc.factBase, { ...view, locale })).map(source => ({
      key: writingProjectSourceKey(source.targetRef, view.isolatedFactBase ? view.id : undefined), text: source.text,
    }))));
    return [...new Map(values.map(source => [source.key, source])).values()];
  }, [doc]);
  const linkedResumeNames = useMemo(() => doc ? resumeNamesByOpportunity(doc) : Object.create(null) as Record<string, string[]>, [doc]);
  function edit(next: NonNullable<typeof doc>) {
    if (docRef.current) docUndo.record(docRef.current);
    restoreOperationRef.current += 1; setIsRestoring(false); setActionError(""); docRef.current = next; update(next);
  }
  function updateFactBase(factBase: FactBase) {
    const current = docRef.current; if (!current) return;
    const next = { ...factBase, updatedAt: new Date().toISOString() };
    const view = current.resumeViews.find(item => item.id === current.activeResumeId);
    const previous = view ? resolveResumeFactBase(current.factBase, view) : current.factBase;
    const isolated = Boolean(view?.isolatedFactBase);
    const synced = syncResumeViewsWithFactBase(previous, next, current.resumeViews, current.activeResumeId, isolated ? "isolated" : "shared");
    edit({ ...current, factBase: isolated ? current.factBase : next, resumeViews: rebaseViewTextStyles(previous, next, synced, isolated ? view!.id : undefined) });
  }
  function updateResume(view: ResumeView) {
    const current = docRef.current; if (!current) return;
    edit({ ...current, resumeViews: current.resumeViews.map((item) => item.id === view.id ? { ...view, updatedAt: new Date().toISOString() } : item) });
  }
  async function handleApplyResumeProposal(proposal: ResumeProposalWrite) {
    if (status.externalConflict) return { ok: false, message: t("另一窗口有尚未处理的简历修改；为保护双方内容，本次未写入。请先处理窗口冲突后重新生成建议。", "Another window has resume edits. Nothing was written; resolve the window conflict and regenerate the proposal.") };
    const current = docRef.current;
    if (!current) return { ok: false, message: t("简历尚未就绪，未写入。", "The resume is not ready. Nothing was written.") };
    const applied = applyResumeProposal(current, proposal);
    if (!applied.ok) return { ok: false, message: applied.reason === "novel_numbers"
      ? t(`事实保真守卫已拦截：检测到原文未出现的新增数字（${applied.novelNumbers.join("、")}），请先核实或删除后再提交。`, `Blocked by Fact-Preservation Guard: novel number(s) not in source (${applied.novelNumbers.join(", ")}). Verify or remove before applying.`)
      : applied.reason === "conflict"
        ? t("建议生成后原文已变化或目标已删除；未写入。请重新读取简历并生成建议。", "The source changed or target was removed after this proposal was generated. Nothing was written; regenerate it from the current resume.")
        : t("建议内容无效，未写入。", "The proposed text is invalid. Nothing was written.") };
    const view = current.resumeViews.find(item => item.id === current.activeResumeId)!;
    const nextView = applied.document.resumeViews.find(item => item.id === current.activeResumeId)!;
    const previous = resolveResumeFactBase(current.factBase, view);
    const next = resolveResumeFactBase(applied.document.factBase, nextView);
    const isolated = Boolean(nextView.isolatedFactBase);
    const synced = syncResumeViewsWithFactBase(previous, next, applied.document.resumeViews, current.activeResumeId, isolated ? "isolated" : "shared");
    edit({ ...applied.document, resumeViews: rebaseViewTextStyles(previous, next, synced, isolated ? view.id : undefined) });
    return { ok: true, message: t("已批准并提交到简历保存流程。草稿立即受保护；完整版本按当前自动保存设置保存，可在历史版本中恢复。", "Approved and submitted to the resume save flow. The draft is protected immediately; the complete version follows your autosave setting and can be restored from history.") };
  }
  async function handleApplyWritingProposal(proposal: ResumeProposalWrite) {
    const before = docRef.current;
    if (status.externalConflict || !await protectEdit(t("伴写修改前", "Before writing suggestion"))) return { ok: false, message: t("未能保护修改前的版本，本次没有写入；请先保存或下载备份。", "Could not protect the previous version. Nothing was written; save or download a backup first.") };
    if (docRef.current !== before) return { ok: false, message: t("简历已切换或原文有新修改，本次没有写入，请重新核对。", "Resume changed. Nothing was written; review the suggestion again.") };
    return handleApplyResumeProposal(proposal);
  }
  async function studioSavedVersion(next: BetterMeDocument): Promise<string> {
    const stored = (await history.list()).find(version => documentFingerprint(version.document) === documentFingerprint(next));
    if (!stored) throw new Error("正式内容已写入，但历史版本回执尚未核对；请先查看版本历史，勿重复采用。");
    return stored.id;
  }
  async function handleStudioLayout(candidate: LayoutCandidate, context: CareerLayoutAdoptionContext): Promise<CareerLayoutAdoptionReceipt> {
    const identity = captureIdentityLease(); identity.assert(); context.signal.throwIfAborted();
    const current = docRef.current, view = current?.resumeViews.find(v => v.id === current.activeResumeId);
    if (!current || !view || status.externalConflict || identity.ownerId !== context.baseScope.ownerId || view.id !== context.baseScope.documentId
      || await careerTaskSourceFingerprint(current, view.id) !== context.baseScope.contentHash) throw new Error("排版审阅原稿、账号或正式版本已变化，未写入。");
    const next = buildCareerLayoutDocument(current, projectResume(current.factBase, view), context.baseScope, candidate);
    const verify = () => { identity.assert(); context.signal.throwIfAborted(); const latest = docRef.current;
      if (!latest || (latest !== current && documentFingerprint(latest) !== documentFingerprint(next))) throw new Error("排版保存期间有其他编辑，未覆盖新内容。"); };
    if (!await saveReviewedVersion(next, current, `排版复测采用 · ${context.operationId}`, verify)) throw new Error("正式排版版本的保存与回读未确认，请先查看历史，不会自动重试。");
    verify(); const versionId = await studioSavedVersion(next); verify();
    const contentHash = await careerTaskSourceFingerprint(next, view.id);
    return { versionId, baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint, resultScope: { ...context.baseScope, revision: contentHash, contentHash } };
  }
  async function handleStudioWording(proposal: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }) {
    const identity = captureIdentityLease(); identity.assert(); const current = docRef.current;
    if (!current || status.externalConflict) return { ok: false, message: "当前文档有冲突，未采用旧措辞。" };
    const result = applyResumeProposal(current, proposal); if (!result.ok) return { ok: false, message: "原句已变化，未采用旧提案。" };
    const verify = () => { identity.assert(); const latest = docRef.current;
      if (!latest || latest !== current && documentFingerprint(latest) !== documentFingerprint(result.document)) throw new Error("保存期间文档有新编辑，未覆盖。"); };
    if (!await saveReviewedVersion(result.document, current, "委员会措辞 · 逐句确认", verify)) return { ok: false, message: "正式版本尚未回读确认，请先查看历史；没有自动重试。" };
    verify(); const versionId = await studioSavedVersion(result.document); return { ok: true, message: `已保存并回读正式版本 ${versionId}；只改变当前简历的措辞，不改变共享事实库。` };
  }
  async function handleStudioEvidence(entryId: string, expectedReviewHash: string) {
    const identity = captureIdentityLease(); identity.assert(); const current = docRef.current; if (!current || status.externalConflict) throw new Error("当前文档不可采用，请先处理冲突。");
    const client = createCareerStudioClient();
    const loadEntry = async () => { const payload = await client.request("/harvest/inbox", {}); identity.assert();
      if (!payload || typeof payload !== "object" || !("entries" in payload) || !Array.isArray(payload.entries)) throw new Error("高光收件箱回执无效。");
      const raw: unknown = payload.entries.find((entry: unknown) => entry && typeof entry === "object" && "id" in entry && entry.id === entryId); return CareerEvidenceEntrySchema.parse(raw); };
    const entry = await loadEntry(), result = await buildCareerEvidenceStatement(current.factBase, entry, expectedReviewHash);
    if (!await confirm(`单独保存以下本人陈述？\n\n${entry.review && "action" in entry.review ? entry.review.action : ""}\n\n这不是独立认证，不采用模型摘要，不自动修改经历或任何简历。`, { title: "审阅Git高光本人陈述", confirmLabel: "批准这句本人原话" })) throw new Error("未批准，未写入长期资料。");
    const next = result.factBase === current.factBase ? current : { ...current, factBase: result.factBase };
    const verify = async () => { identity.assert(); const latest = await loadEntry();
      if (JSON.stringify(latest) !== JSON.stringify(entry) || !docRef.current || docRef.current !== current && documentFingerprint(docRef.current) !== documentFingerprint(next)) throw new Error("审阅期间原稿、来源或本人陈述已变化，未覆盖。"); };
    await verify(); if (!await saveReviewedVersion(next, current, `Git本人陈述 · ${entryId}`, verify)) throw new Error("长期本人陈述的正式保存尚未回读确认，请先对账。");
    identity.assert(); return { versionId: await studioSavedVersion(next), statementId: result.statementId };
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
    const view = current?.resumeViews.find(item => item.id === current.activeResumeId);
    const request = current && view && createIssueNavigation(resolveResumeFactBase(current.factBase, view), issue, ++issueRequestIdRef.current);
    if (!request) { setActionError(t("这条要点已删除或不在当前文档中，请重新查看内容检查。", "This item is no longer in this document. Reopen the content checks.")); return; }
    setPage("resume");
    setWorkspaceTab("content");
    setIssueNavigation(request);
    showResumeEditor();
  }
  function handleSaveLlmConfig(config: LlmConfig) {
    const validated = LlmConfigSchema.parse(config);
    try { localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(validated)); }
    catch { throw new Error(t("配置未保存，表单仍在。请检查本机存储空间以及浏览器是否允许此站点保存数据，再点「保存配置」。","The settings were not saved. Your form is still here. Check available storage and this site's storage permissions, then choose Save configuration again.")); }
    setLlmConfig(validated);
  }
  async function handleImportResumeSuccess(factBase: FactBase, _rawText: string, fileName: string) {
    const view = createDefaultResumeView(factBase); view.name = fileName.replace(/\.[^.]+$/, "") || t("我的简历", "My resume");
    restoreOperationRef.current += 1; setIsRestoring(false);
    const documentId = crypto.randomUUID();
    if (!(await replace({ documentId, factBase, resumeViews: [view], activeResumeId: view.id }, t(`导入 · ${fileName}`, `Import · ${fileName}`), "import"))) throw new Error(t("导入结果未能保存，当前简历已保留。请检查浏览器空间与字段格式。", "Could not save the import. Your current resume is preserved. Check local storage space and field values."));
    setJobRecommendation({ documentId, factBase, requestId: ++recommendationRequestRef.current });
    setInventoryReview(null); setInventoryOpen(false); setInventoryInvite(documentId);
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
  function handleExportJsonResume() {
    if (!doc || !activeResume) return;
    const facts = resolveResumeFactBase(doc.factBase, activeResume);
    const jsonResume = factBaseToJsonResume(facts, activeResume.locale);
    downloadJson(`${JSON.stringify(jsonResume, null, 2)}\n`, `resume-jsonresume-${new Date().toISOString().slice(0, 10)}.json`);
    setIsMenuOpen(false);
  }
  function handleExportInteractivePortfolio() {
    if (!doc || !activeResume) return;
    const facts = resolveResumeFactBase(doc.factBase, activeResume);
    const html = exportInteractivePortfolioHtml({ factBase: facts, view: activeResume, locale: activeResume.locale, includeContact: false });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `better-me-portfolio-${new Date().toISOString().slice(0, 10)}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    setIsMenuOpen(false);
  }
  function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    const operation = ++restoreOperationRef.current; setIsRestoring(true); setActionError("");
    void file.text().then(async (raw) => {
      if (operation !== restoreOperationRef.current) return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { /* fall through to parseDocumentJson error */ }
      if (isJsonResumePayload(parsed)) {
        const importedFacts = jsonResumeToFactBase(parsed);
        const view = createDefaultResumeView(importedFacts);
        view.name = file.name.replace(/\.[^.]+$/, "") || t("JSON Resume 导入", "Imported JSON Resume");
        const documentId = crypto.randomUUID();
        const saved = await replace({ documentId, factBase: importedFacts, resumeViews: [view], activeResumeId: view.id }, t(`导入 JSON Resume · ${file.name}`, `Import JSON Resume · ${file.name}`), "import");
        if (saved) setIssueNavigation(null);
        if (operation === restoreOperationRef.current && !saved) setActionError(t("JSON Resume 导入未能保存，当前简历已保留。", "Could not save the JSON Resume import. Your current resume is preserved."));
        return;
      }
      const restored = parseDocumentJson(raw);
      restored.documentId ??= crypto.randomUUID();
      const saved = await replace(preserveRequirementReviews(restored, docRef.current), t(`恢复备份 · ${file.name}`, `Restore backup · ${file.name}`), "import");
      if (saved) setIssueNavigation(null);
      if (operation === restoreOperationRef.current && !saved) setActionError(t("备份未能保存，当前简历已保留。", "Could not save the backup. Your current resume is preserved."));
    }).catch((error) => {
      if (operation === restoreOperationRef.current) setActionError(error instanceof Error ? t(`恢复失败：${error.message}`, `Restore failed: ${error.message}`) : t("备份读取失败，请选择有效的 BetterMe 或 JSON Resume 文件。", "Could not read the file. Select a valid BetterMe backup or JSON Resume file."));
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
    const restored = preserveRequirementReviews(version.document, docRef.current);
    const saved = await replace(restored, t(`恢复 · ${version.label}`, `Restore · ${version.label}`), "restore");
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
  async function readOpportunityResumeContext(job?: Opportunity) {
    const identity = captureIdentityLease();
    identity.assert();
    const current = docRef.current;
    if (!current || status.externalConflict) throw new Error("当前简历有冲突或尚未就绪。");
    const assertCurrent = () => {
      identity.assert();
      if (docRef.current !== current) throw new Error("核对期间简历已变化，请重新选择。");
    };
    const material = await currentOpportunityResumeMaterial(current, {
      read: () => readOfficialForReview(current), listVersions: () => history.list(), assertCurrent,
    });
    assertCurrent();
    return { material, evidence: job ? opportunityDecisionEvidence(current, job) : undefined };
  }
  async function currentResumeMaterial() {
    return (await readOpportunityResumeContext()).material;
  }
  async function currentOpportunityDecisionContext(job: Opportunity) {
    const { material, evidence } = await readOpportunityResumeContext(job);
    if (!evidence) throw new Error("岗位要求未能核对。");
    return { evidence, officialVersion: material.officialVersion };
  }
  function currentOpportunityDecisionEvidence(job: Opportunity) {
    const identity = captureIdentityLease();
    identity.assert();
    const current = docRef.current;
    if (!current || status.externalConflict) throw new Error("当前简历有冲突或尚未就绪。");
    return opportunityDecisionEvidence(current, job);
  }
  function openAgentWorkspace(job?: DrawerJobContext) {
    if (job) {
      setAgentDrawerJob(job);
      setAgentMode("advisor");
      setAgentNavigation(previous => ({ view: "job", id: (previous?.id ?? 0) + 1 }));
    }
    setPage("agent");
  }
  function openGrowthRequirement(job: DrawerJobContext, quote: string, itemId: string) {
    setIsJdMatchOpen(false);
    setJdSelection(null);
    openAgentWorkspace(job);
    setAgentNavigation(previous => ({
      view: "learning", id: (previous?.id ?? 0) + 1,
      trainingRequirement: { quote, itemId, snapshotVersion: careerJobSnapshotVersion(job) },
    }));
  }
  function openBackgroundWatch(selection?: ResumeDiscoverySelection) {
    if (!doc || !activeResume || !projected || !effectiveFactBase) return;
    const defaults = selection ? resumeDiscoveryCriteria(selection.resume, selection.facts, selection.direction) : resumeDiscoveryCriteria(projected, effectiveFactBase);
    setResumeDiscovery(undefined);
    setBackgroundWatch({ scopeKey: JSON.stringify([selection?.documentId ?? doc.documentId ?? "legacy", selection?.viewId ?? activeResume.id]),
      name: selection?.name ?? (activeResume.name === "Default" ? t("我的简历", "My resume") : activeResume.name), defaults });
  }
  function openResumeDiscovery(direction?: string) {
    if (!doc || !activeResume || !projected || !effectiveFactBase) return;
    setResumeDiscovery({ documentId: doc.documentId, viewId: activeResume.id,
      name: activeResume.name === "Default" ? t("我的简历", "My resume") : activeResume.name,
      facts: effectiveFactBase, resume: projected, direction });
  }
  function refreshJobRecommendations() {
    const current = docRef.current;
    const view = current?.resumeViews.find(item => item.id === current.activeResumeId);
    if (current && view) setJobRecommendation({ documentId: current.documentId!, factBase: resolveResumeFactBase(current.factBase, view), requestId: ++recommendationRequestRef.current });
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
      text,
    });
  }
  function handleApplyCustomResume(payload: {
    acceptedProposals: MatchProposal[];
    customResumeName: string;
    targetJobTitle: string;
    targetCompany: string;
  }) {
    // Legacy JD suggestions have no exact original-text/evidence receipt.
    // They cannot mutate the shared FactBase or claim a successful save.
    setActionError(t(`“${payload.customResumeName}”尚未保存。请在岗位定制任务中重新取证并逐句审阅。`, `“${payload.customResumeName}” is not saved. Use the evidence-backed tailoring task and review each change.`));
    setPage("agent");
  }
  async function saveReplacementEdition(command: CareerTaskResumeCommand, assertSelection: () => void) {
    const identity = captureIdentityLease();
    identity.assert();
    const current = docRef.current;
    if (!current || !identity.ownerId || status.externalConflict || current.activeResumeId !== command.sourceResumeId)
      throw new Error(t("简历或账号已切换，请重新比较。", "The resume or account changed. Review the comparison again."));
    assertSelection();
    const id = await careerTaskCommandFingerprint({ ...command, taskId: "replace-one" });
    const result = await createCareerTaskResume(current, { ...command, taskId: "replace-one-" + id });
    if (result.editionState !== "as_saved")
      throw new Error(t("这份岗位版已保存，之后又有编辑。请在简历列表中打开核对。", "This job edition was saved and subsequently edited. Open it from the resume list."));
    const next = result.document.activeResumeId === result.receipt.resumeId ? result.document
      : { ...result.document, activeResumeId: result.receipt.resumeId };
    // The store emits the schema-normalized document. Compare the same representation
    // if React has already switched the editor to the saved edition during readback.
    const expectedSaved = JSON.stringify(DocumentSchema.parse(next));
    const verify = () => {
      identity.assert();
      const latest = docRef.current;
      if (latest === current) assertSelection();
      else if (!latest || JSON.stringify(latest) !== expectedSaved)
        throw new Error(t("保存期间原稿已变化，请重新比较。", "The source changed during save. Review it again."));
    };
    verify();
    const receipt = result.receipt;
    setEditionReadback({ phase:"saving", message:t("正在保存并核对岗位版…", "Saving and checking the job edition…"),
      workspaceKey:current.documentId ?? "default", identitySignal:identity.signal, editionId:receipt.resumeId, receipt });
    try {
      if (!await saveReviewedVersion(next, current, `岗位选材 · ${command.job.title}`, verify))
        throw new Error(t("尚未确认岗位版是否保存。可以重新核对正式记录。", "The save could not be confirmed. Check the saved record."));
      setEditionReadback(previous => previous?.receipt === receipt ? undefined : previous);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("岗位版保存结果待核对。", "The save needs verification.");
      setEditionReadback(previous => previous?.receipt === receipt ? { ...previous, phase:"unknown", message } : previous);
      throw err;
    }
  }
  async function checkReplacementReadback() {
    const pending = editionReadback, current = docRef.current;
    if (pending?.phase !== "unknown" || pending.identitySignal.aborted || !current || (current.documentId ?? "default") !== pending.workspaceKey) return;
    const identity = captureIdentityLease();
    const updateNotice = (patch: Partial<EditionReadbackNotice>) => setEditionReadback(previous =>
      previous?.receipt === pending.receipt && !pending.identitySignal.aborted ? { ...previous, ...patch } : previous);
    updateNotice({ phase:"checking", message:t("正在读取岗位版保存记录…", "Reading the saved edition…") });
    try {
      const official = await readOfficialForReview(current);
      identity.assert();
      const edition = official?.resumeViews.find(v => v.id === pending.receipt.resumeId);
      if (!official || !edition) {
        updateNotice({ phase:"absent", message:t("正式记录中没有这份岗位版。请核对原稿后再决定是否采用。", "This edition is absent from the saved record. Review the source before deciding whether to accept.") });
        return;
      }
      const receipt = edition.careerTaskReceipt;
      if (receipt?.id !== pending.receipt.id || receipt.contentHash !== pending.receipt.contentHash
        || await careerTaskSourceFingerprint(official, edition.id) !== pending.receipt.snapshotHash) {
        updateNotice({ phase:"changed", message:t("找到了岗位版，但与本次批准稿不同。请在版本历史中核对。", "A different revision is saved. Compare it with the approved version in history.") });
        return;
      }
      identity.assert();
      updateNotice({ phase:"confirmed", message:t("已从正式记录核对本次批准的岗位版。", "The approved edition was verified in the saved record."),
        verifiedFile:{ projected:projectResume(official.factBase, edition), name:edition.name } });
    } catch {
      updateNotice({ phase:"unknown", message:t("暂时无法读取正式记录，请处理存储或窗口冲突后重新核对。", "The record could not be read. Resolve any storage or window conflict and check again.") });
    }
  }
  async function handleSaveCareerTask(task: CareerTask, approvedPatchIds: string[]) {
    const identity = captureIdentityLease(); identity.assert();
    if (!identity.ownerId || identity.ownerId !== task.ownerId) throw new Error("任务账号已变化，未保存。");
    const current = docRef.current;
    if (!current || (current.documentId ?? "default") !== task.workspaceKey || status.externalConflict || task.status !== "awaiting_review" || !task.draft) throw new Error("当前任务不可保存，请刷新任务并解决文档冲突。");
    const command = resumeSaveCommand(task, approvedPatchIds);
    const verify = async () => {
      identity.assert(); const latest = await defaultCareerTaskClient.get(task.id); identity.assert();
      if (latest.revision !== task.revision || latest.status !== "awaiting_review" || latest.draft?.hash !== task.draft!.hash) throw new Error("任务在批准期间有变化或授权已撤销，请重新审阅。");
    };
    await verify();
    const result = await createCareerTaskResume(current, command);
    identity.assert();
    if (docRef.current !== current) throw new Error("保存前简历有新编辑，未覆盖，请刷新后重新核对。");
    if (result.editionState === "edited_since_save") throw new Error("此任务的岗位版本此前已保存，之后又有编辑。本次未覆盖，也未把现稿冒充原批准稿；请先核对版本历史和回执。");
    if (!await saveReviewedVersion(result.document, current, `岗位定制 · ${task.job.title} · ${task.id}`, verify)) throw new Error("版本保存或回读未确认；未记为完成。请保留任务并检查保存状态后重试。");
    identity.assert();
    return { versionId: result.receipt.resumeId, receiptId: result.receipt.id };
  }
  async function handleCommitCareerFact(task: CareerTask, proposal: CareerTask["facts"][number]) {
    const identity = captureIdentityLease(); identity.assert();
    if (!identity.ownerId || identity.ownerId !== task.ownerId) throw new Error("任务账号已变化，未写入。");
    const before = docRef.current;
    if (!before || (before.documentId ?? "default") !== task.workspaceKey) throw new Error("该事实提案不属于当前文档，未写入。");
    if (!await confirm(`将以下内容单独保存为长期“本人陈述”？\n\n${proposal.text}\n\n这不是独立验证。会保留任务和来源，不自动修改共享经历、其他简历或已保存岗位版本；旧版本仍需重新核对。`, { title: "审阅长期个人事实提案", confirmLabel: "批准此本人陈述" })) throw new Error("未批准长期事实更新，当前任务中的回答仍保留。");
    identity.assert();
    const verify = async () => {
      identity.assert(); const latest = await defaultCareerTaskClient.get(task.id); identity.assert();
      if (latest.revision !== task.revision || latest.status === "revoked" || !latest.facts.some(f => f.id === proposal.id && f.status === "proposed" && f.text === proposal.text)) throw new Error("事实提案在审阅期间已变化或被撤销，未写入。");
    };
    await verify();
    const current = docRef.current;
    if (!current || current !== before || status.externalConflict) throw new Error("审阅期间文档已变化或有冲突，请重新审阅长期事实。");
    const base = approveCareerTaskStatement(current.factBase, task, proposal.id);
    const next = base === current.factBase ? current : { ...current, factBase: base };
    if (!await saveReviewedVersion(next, current, `本人陈述 · ${task.id} · ${proposal.id}`, verify)) throw new Error("长期事实保存未确认，提案未标为已写入。");
    identity.assert();
  }
  async function reconcileCareerWorkspace(task: CareerTask, request: WorkspaceReceiptRequest): Promise<WorkspaceReceiptInspection> {
    const identity = captureIdentityLease(); identity.assert();
    const current = docRef.current;
    if (!identity.ownerId || identity.ownerId !== task.ownerId || !current || (current.documentId ?? "default") !== task.workspaceKey)
      throw new Error("任务账号或职业文档不一致，未核对回执。");
    const official = await readOfficialForReview(current); identity.assert();
    const [stored, editing] = await Promise.all([inspectCareerTaskWorkspace(official, task, request), inspectCareerTaskWorkspace(current, task, request)]);
    identity.assert();
    if (docRef.current !== current) throw new Error("核对期间工作区发生变化；未补写回执。");
    if (stored.state !== "current") return stored;
    if (editing.state !== "current") return editing;
    return JSON.stringify(stored.receipt) === JSON.stringify(editing.receipt) ? stored : { state: "conflict" };
  }
  if (ready && loadError && !doc) {
    const { rawOfficialRecovery, rawDraftRecovery, rawPreviousDraftRecovery } = status;
    const hasRecoveryBytes = [rawOfficialRecovery, rawDraftRecovery, rawPreviousDraftRecovery].some(raw => raw !== undefined);
    return (
      <div className="recovery-screen">
        <WorkspacePreferences />
        <div className="recovery-card">
          <ShieldCheck size={28} />
          <h1>{t("先保护好你的简历", "Protect your resume first")}</h1>
          <p role="alert">{loadError}</p>
          <p>{hasRecoveryBytes
            ? t("可以下载此工作区的原始记录，或从有效备份恢复。", "Download the original records from this workspace or restore a valid backup.")
            : t("此工作区暂未读到可下载的原始数据。可以从有效备份恢复。", "No original data is available to download from this workspace. You can restore a valid backup.")}</p>
          <input type="file" ref={fileInputRef} accept=".json" onChange={handleFileSelected} className="hidden" />
          <div className="flex flex-wrap gap-3">
            {rawOfficialRecovery !== undefined && <button className="studio-button" onClick={() => downloadJson(rawOfficialRecovery, "better-me-backup-recovery.json")}>{t("下载原始数据", "Download original data")}</button>}
            {rawDraftRecovery !== undefined && <button className="studio-button" onClick={() => downloadJson(rawDraftRecovery, "better-me-draft-recovery.json")}>{t("下载原始草稿", "Download original draft")}</button>}
            {rawPreviousDraftRecovery !== undefined && <button className="studio-button" onClick={() => downloadJson(rawPreviousDraftRecovery, "better-me-draft-before-switch.json")}>{t("下载切换前草稿", "Download pre-switch draft")}</button>}
            <button className="studio-button primary" onClick={() => fileInputRef.current?.click()}>{t("恢复 JSON 备份", "Restore a JSON backup")}</button>
            <button className="studio-button" onClick={() => void resetDemo()}>{t("恢复演示", "Reset demo")}</button>
          </div>
          {actionError && <p role="alert">{actionError}</p>}
        </div>
      </div>
    );
  }
  if (!ready || !doc || !activeResume || !projected) return <div className="studio-loading"><Loader2 size={24} className="animate-spin" /><span>{t("正在打开你的简历工作室…", "Opening your resume studio…")}</span></div>;
  const visibleFacts = resolveResumeFactBase(doc.factBase, activeResume);
  const trainingWorkspaces = [doc.documentId ?? "default", ...doc.resumeViews.map(view => view.id)];
  const evidenceWorkspace: EvidenceWorkspace = {
    facts: visibleFacts, links: doc.requirementEvidence ?? [],
    async loadRetests(job, item, signal) {
      const client = defaultLearningClient.training;
      const summaries = (await client.list(signal)).filter(kit => isRequirementTraining(kit, trainingWorkspaces, job, item));
      const results = await Promise.allSettled(summaries.map(async ({ id }) => {
        const kit = await client.get(id, signal);
        return isRequirementTraining(kit, trainingWorkspaces, job, item) ? requirementRetest(kit) : undefined;
      }));
      signal.throwIfAborted();
      if (results.some(result => result.status === "rejected"))
        throw new Error(t("部分复测记录暂时无法读取，请重试。", "Some retest records could not be checked. Try again."));
      return results.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
    },
    async save(command) {
      const identity = captureIdentityLease();
      identity.assert();
      const kit = command.sourceKind === "independent-retest" && command.assessment !== "withdrawn"
        ? await defaultLearningClient.training.get(command.kitId, identity.signal) : undefined;
      identity.assert();
      if (docRef.current !== doc || status.externalConflict) throw new Error(t("当前文档已变化，请重新核对材料。", "The document changed. Review the source again."));
      const next = withRequirementEvidence(doc, visibleFacts, command, new Date().toISOString(), kit, trainingWorkspaces);
      if (!await saveReviewedVersion(next, doc, t("核对岗位要求的依据", "Review job requirement evidence"), identity.assert))
        throw new Error(t("未能确认保存，请检查文档保存状态后重试。", "Could not confirm the save. Check the document status before retrying."));
    },
  };
  const autoSaveDescription = !autoSaveSettings.enabled ? t("自动保存已关闭", "Autosave is off") : autoSaveSettings.trigger === "enter" ? t("按回车保存", "Press Enter to save") : autoSaveSettings.trigger === "blur" ? t("离开编辑项时保存", "Save when leaving a field") : t(`停止输入 ${autoSaveSettings.delayMs / 1000} 秒后保存`, `Save after ${autoSaveSettings.delayMs / 1000} seconds of inactivity`);
  const saveShortcutLabel = formatShortcut(shortcuts.save);
  const cmdShortcutLabel = formatShortcut(shortcuts.commandPalette);
  const mac = isMacPlatform();
  const quickTemplates = [
    { id: "zh-classic", zh: "经典正式", en: "Classic", keywords: "classic 经典 正式" },
    { id: "en-ats", zh: "极简单栏 · ATS", en: "Minimal ATS", keywords: "ats plain minimal 极简 单栏" },
    { id: "clean-modern", zh: "现代专业", en: "Modern professional", keywords: "modern 现代 技术" },
    { id: "editorial", zh: "编辑部", en: "Editorial", keywords: "editorial 编辑 衬线" },
    { id: "rendercv-engineeringresumes", zh: "RenderCV · Engineering", en: "RenderCV · Engineering", keywords: "rendercv engineering 工程师" },
  ] as const;
  const commandItems: CommandItem[] = isCommandPaletteOpen
    ? [
        {
          id: "action-find-jobs",
          group: t("常用操作", "Actions"),
          label: t("按简历找岗位", "Find jobs with this resume"),
          keywords: "jobs search discovery 找岗位 招聘",
          icon: <Search size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.findJobs, mac),
          onSelect: () => { setPage("resume"); openResumeDiscovery(); },
        },
        {
          id: "action-save",
          group: t("常用操作", "Actions"),
          label: t("立即保存当前简历", "Save resume now"),
          keywords: "save persist flush 保存",
          icon: <Check size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.save, mac),
          onSelect: () => { void flush(); },
        },
        {
          id: "action-undo",
          group: t("常用操作", "Actions"),
          label: t("撤销修改", "Undo edit"),
          keywords: "undo revert 撤销",
          icon: <Undo2 size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.undo, mac),
          disabled: !docUndo.canUndo,
          onSelect: () => {
            const current = docRef.current;
            if (!current) return;
            const prev = docUndo.undo(current);
            if (!prev) return;
            restoreOperationRef.current += 1;
            setIsRestoring(false);
            setActionError("");
            docRef.current = prev;
            update(prev);
            showUndoFeedback(t("已撤销修改", "Undone"));
          },
        },
        {
          id: "action-redo",
          group: t("常用操作", "Actions"),
          label: t("重做修改", "Redo edit"),
          keywords: "redo 重做",
          icon: <Redo2 size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.redo, mac),
          disabled: !docUndo.canRedo,
          onSelect: () => {
            const current = docRef.current;
            if (!current) return;
            const next = docUndo.redo(current);
            if (!next) return;
            restoreOperationRef.current += 1;
            setIsRestoring(false);
            setActionError("");
            docRef.current = next;
            update(next);
            showUndoFeedback(t("已重做修改", "Redone"));
          },
        },
        {
          id: "action-history",
          group: t("常用操作", "Actions"),
          label: t("打开历史版本", "Open version history"),
          keywords: "history versions rollback 历史 版本",
          icon: <GitBranch size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.history, mac),
          onSelect: () => { setPage("resume"); setIsHistoryOpen(true); },
        },
        {
          id: "action-toggle-design",
          group: t("常用操作", "Actions"),
          label: workspaceTab === "content" ? t("切换到版式设计", "Switch to Design") : t("切换到内容编辑", "Switch to Content"),
          keywords: "design layout content 设计 版式 内容",
          icon: <SlidersHorizontal size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.toggleDesign, mac),
          onSelect: () => { setPage("resume"); setWorkspaceTab((tab) => (tab === "content" ? "design" : "content")); },
        },
        {
          id: "action-focus-mode",
          group: t("常用操作", "Actions"),
          label: focused ? t("退出专注模式", "Exit focus mode") : t("进入专注模式", "Enter focus mode"),
          keywords: "focus zen maximize 专注 全屏",
          icon: <Maximize2 size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.focusMode, mac),
          onSelect: () => { setPage("resume"); setFocused((v) => !v); },
        },
        {
          id: "action-inventory",
          group: t("常用操作", "Actions"),
          label: t("盘点履历与最近变化", "Career inventory"),
          keywords: "inventory career review 盘点 履历",
          icon: <BookOpenCheck size={14} />,
          onSelect: () => { setPage("resume"); openInventory(); },
        },
        {
          id: "action-import",
          group: t("常用操作", "Actions"),
          label: t("导入简历 (PDF / DOCX / Markdown)", "Import resume"),
          keywords: "import pdf docx markdown 导入",
          icon: <Upload size={14} />,
          onSelect: () => { setPage("resume"); setIsImportModalOpen(true); },
        },
        {
          id: "action-skill-atlas",
          group: t("常用操作", "Actions"),
          label: t("打开个人职业能力与证据图谱", "Open Career Skill & Evidence Atlas"),
          keywords: "skills keycaps atlas graph evidence 能力 图谱 技能 证据",
          icon: <Compass size={14} />,
          onSelect: () => { setPage("resume"); setIsSkillAtlasOpen(true); },
        },
        {
          id: "action-export-portfolio-html",
          group: t("常用操作", "Actions"),
          label: t("导出双模式交互式职业主页 (.html)", "Export Dual-Mode Interactive Portfolio (.html)"),
          keywords: "portfolio html export share interactive 交互 主页 导出",
          icon: <Globe size={14} />,
          onSelect: handleExportInteractivePortfolio,
        },
        {
          id: "action-mcp-settings",
          group: t("常用操作", "Actions"),
          label: t("配置 MCP 本地连接 (Claude / Cursor / Antigravity)", "Configure Local MCP Connector (Claude / Cursor / Antigravity)"),
          keywords: "mcp claude cursor antigravity connector stdio 连接",
          icon: <Plug size={14} />,
          onSelect: () => openSystemSettings("mcp"),
        },
        {
          id: "action-export-jsonresume",
          group: t("常用操作", "Actions"),
          label: t("导出 JSON Resume (jsonresume.org 标准)", "Export JSON Resume (jsonresume.org)"),
          keywords: "jsonresume export standard json 导出",
          icon: <Download size={14} />,
          onSelect: handleExportJsonResume,
        },
        {
          id: "action-ats-diagnostics",
          group: t("常用操作", "Actions"),
          label: t("ATS 纯文本与 JD 深度诊断（本地零 LLM）", "ATS & JD Diagnostics (Local, Zero-LLM)"),
          keywords: "ats score diagnostic checker keywords writing quality 诊断 评分 体检",
          icon: <FileSearch size={14} />,
          onSelect: () => setIsAtsDiagnosticsOpen(true),
        },
        {
          id: "action-public-landing",
          group: t("常用操作", "Actions"),
          label: t("打开公开产品主页 (Landing Page)", "Open Public Landing Page"),
          keywords: "landing home showcase product tour 主页 官网 展示",
          icon: <Globe size={14} />,
          onSelect: () => window.dispatchEvent(new CustomEvent("betterme:open-public-view", { detail: "landing" })),
        },
        {
          id: "action-shortcuts",
          group: t("常用操作", "Actions"),
          label: t("自定义全局快捷键", "Customize keyboard shortcuts"),
          keywords: "settings shortcuts hotkeys keybindings 设置 快捷键",
          icon: <Keyboard size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.openSettings, mac),
          onSelect: () => openSystemSettings("shortcuts"),
        },
        {
          id: "nav-resume",
          group: t("工作台", "Workspaces"),
          label: t("简历工作室", "Resume Studio"),
          keywords: "resume editor studio 简历",
          icon: <FileText size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.switchResume, mac),
          onSelect: () => { setPage("resume"); setWorkspaceTab("content"); },
        },
        {
          id: "nav-opportunities",
          group: t("工作台", "Workspaces"),
          label: t("机会与投递", "Opportunities"),
          keywords: "opportunities jobs tracker 机会 投递",
          icon: <Radar size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.switchOpportunities, mac),
          onSelect: () => setPage("opportunities"),
        },
        {
          id: "nav-atlas",
          group: t("工作台", "Workspaces"),
          label: t("岗位地图", "Opportunity Atlas"),
          keywords: "atlas map 岗位 地图",
          icon: <Compass size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.switchAtlas, mac),
          onSelect: () => setPage("atlas"),
        },
        {
          id: "nav-agent",
          group: t("工作台", "Workspaces"),
          label: t("AI 职业顾问", "AI Career Workspace"),
          keywords: "agent advisor ai 职业顾问",
          icon: <Bot size={14} />,
          shortcutTokens: formatShortcutTokens(shortcuts.switchAgent, mac),
          onSelect: () => setPage("agent"),
        },
        {
          id: "nav-autopilot",
          group: t("工作台", "Workspaces"),
          label: t("Autopilot 工坊", "Autopilot Studio"),
          keywords: "autopilot automation 自动 投递",
          icon: <Zap size={14} />,
          onSelect: () => setPage("autopilot"),
        },
        ...quickTemplates.map((tpl) => ({
          id: `tpl-${tpl.id}`,
          group: t("版式快切", "Quick Templates"),
          label: t(`切换模板 · ${tpl.zh}`, `Template · ${tpl.en}`),
          keywords: `template theme ${tpl.keywords}`,
          icon: <Layout size={14} />,
          onSelect: () => { setPage("resume"); setTemplate(tpl.id); },
        })),
      ]
    : [];

  return <LocalAgentRuntimeProvider><BetterMeAgentProvider workspaceKey={doc.documentId ?? activeResume.id}><AgentSidebarProvider><DesktopShell jobWatchControls={<BackgroundJobWatchCenter target={backgroundWatch} onCloseTarget={() => setBackgroundWatch(undefined)} onOpenMap={() => { setBackgroundWatch(undefined); setPage("atlas"); }} />} page={page} resumeTab={workspaceTab} focused={focused} onContent={() => setWorkspaceTab("content")} accountControls={<FirstRunGuide eligible={page === "resume" && workspaceTab === "content" && !isAiConfigOpen && !isNetworkSettingsOpen && !isJdMatchOpen && !isAgentDrawerOpen && !isImportModalOpen && !isHistoryOpen && !isRestoring} onPrepare={() => { setPage("resume"); setWorkspaceTab("content"); setIsMenuOpen(false); }} renderTrigger={start => <WorkspaceMenu initial={doc.factBase.profile.displayName.zh.slice(0, 1) || "我"} onGuide={start} onAiConfig={() => openSystemSettings("connections")} />} />} onNavigate={next => { if (next === "resume") setWorkspaceTab("content"); setPage(next); }} onDesign={() => { setPage("resume"); setWorkspaceTab("design"); }} onHistory={() => setIsHistoryOpen(true)} onAiConfig={() => setIsAiConfigOpen(true)} onNetwork={() => setIsNetworkSettingsOpen(true)}><div className="studio-app compact-chrome">
    <AgentSourceBridge sources={agentSources} />
    <UnifiedCareerTaskSurface workspaceKey={doc.documentId ?? "default"} sourceResumeId={activeResume.id} sourceResumeName={activeResume.name} sourceFingerprint={careerSourceFingerprint} resumeFields={resumeEditContext} llmConfig={llmConfig} onSave={handleSaveCareerTask} onCommitFact={handleCommitCareerFact} onReconcile={reconcileCareerWorkspace} />
    <input type="file" ref={fileInputRef} onChange={handleFileSelected} accept=".json" className="hidden" />
    <div className="studio-workspace">
      {page !== "resume" && page !== "agent" && page !== "atlas" && page !== "autopilot" && page !== "opportunities" && page !== "resources" && <header className="studio-header no-print"><AgentTopBarStatus config={llmConfig} active={false} onNavigateToAgent={() => setPage("agent")} onOpenAiConfig={() => openSystemSettings("connections")} /></header>}
      <div className="resume-workspace-body" hidden={page !== "resume"} onMouseUpCapture={captureResumeTextSelection} onKeyUpCapture={captureResumeTextSelection}>
      {resumeSelectionReference && <div className="no-print flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-[11px] text-emerald-950">
        <MessageSquare size={14} className="shrink-0 text-emerald-700" />
        <span className="min-w-0 flex-1 truncate" title={resumeSelectionReference.text}>{t("已选中简历预览文字：", "Selected resume text: ")}{resumeSelectionReference.text}</span>
        <button type="button" className="rounded-lg bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-800" onClick={() => { setAgentCompanionReference(resumeSelectionReference); setResumeSelectionReference(null); }}>{t("向 Agent 提问", "Ask Agent")}</button>
        <button type="button" aria-label={t("关闭引用工具", "Dismiss quote action")} onClick={() => setResumeSelectionReference(null)} className="rounded p-1 text-emerald-700 hover:bg-emerald-100"><X size={13} /></button>
      </div>}
      <div className="studio-document-bar no-print">
        <div className="document-heading">
          <div className="document-title-row">
            <div className="resume-view-picker">
              <SelectMenu
                appearance="title"
                ariaLabel={t("切换简历", "Switch resume")}
                value={activeResume.id}
                options={doc.resumeViews.map((view) => ({
                  value: view.id,
                  label: view.name === "Default" ? t("我的简历", "My resume") : view.name,
                }))}
                onChange={(nextId) => { const current = docRef.current; if (current) edit({ ...current, activeResumeId: nextId }); }}
              />
            </div>
            <div data-onboarding="save"><AutoSaveControls settings={autoSaveSettings} onChange={setAutoSaveSettings} onSave={() => void flush()} saving={status.kind === "pending"} preferenceError={autoSavePreferenceError} compactStatus={<DocumentSaveStatus status={status} autoSaveEnabled={autoSaveSettings.enabled} />} /></div>
            <span className="document-badge">{matchReadiness?.reason === "demo" || matchReadiness?.reason === "mixed-demo" ? t("含示例内容", "Includes demo content") : t("个人工作空间", "Personal workspace")}</span>
          </div>
        </div>
        <div className="document-actions">
          <Button variant="tinted" size="sm" aria-haspopup="dialog"
            title={t("用当前简历的岗位方向、技能和城市搜索招聘官网", "Search employer sites using the role, skills and city in this resume")}
            onClick={() => openResumeDiscovery()}><Search size={14} aria-hidden="true" />{t("按简历找岗位", "Find jobs with this resume")}</Button>
          <Button variant="secondary" size="sm" aria-haspopup="dialog" onClick={() => openBackgroundWatch()}><Radar size={14} aria-hidden="true" />{t("后台寻岗", "Background job discovery")}</Button>
          <IssuesPanel
            compact
            issues={issues}
            factBase={visibleFacts}
            onNavigate={navigateToIssue}
            activeIssue={issueNavigation?.issue}
            onConfirmMetric={(experienceId, claimId) => {
              updateFactBase({
                ...visibleFacts,
                experiences: visibleFacts.experiences.map((exp) =>
                  exp.id === experienceId
                    ? {
                        ...exp,
                        claims: exp.claims.map((c) =>
                          c.id === claimId && c.metric ? { ...c, metric: { ...c.metric, confirmed: true } } : c
                        ),
                      }
                    : exp
                ),
              });
            }}
            onConfirmAllMetrics={() => {
              updateFactBase({
                ...visibleFacts,
                experiences: visibleFacts.experiences.map((exp) => ({
                  ...exp,
                  claims: exp.claims.map((c) => (c.metric ? { ...c, metric: { ...c.metric, confirmed: true } } : c)),
                })),
              });
            }}
          />
          <Button variant="ghost" size="sm" className="studio-focus-button" aria-pressed={focused} onClick={() => setFocused(value => !value)}><Maximize2 size={13} />{focused ? t("退出专注", "Exit focus") : t("专注", "Focus")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setIsSkillAtlasOpen(true)}><Compass size={14} />{t("能力图谱", "Skill atlas")}</Button>
          <Button variant="ghost" size="sm" onClick={openInventory}><BookOpenCheck size={14} />{t("盘点履历", "Career inventory")}</Button>
          <SegmentedControl
            value={activeResume.locale}
            options={[{ value: "zh", label: "中文" }, { value: "en", label: "English" }]}
            onChange={setResumeLocale}
            ariaLabel={t("简历输出语言", "Resume output language")}
            title={t("只影响这份简历的预览与导出，不改变界面语言", "Only changes this resume’s preview and exports, independently of the interface language")}
          />
          {!autoSaveSettings.enabled && <Button variant="ghost" size="sm" disabled={status.kind === "pending"} onClick={() => void flush()}><Check size={14} />{t("立即保存", "Save now")}</Button>}

          <div className="document-menu" ref={menuRef}><Button variant="ghost" size="sm" iconOnly aria-label={t("更多简历操作", "More resume actions")} aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen(!isMenuOpen)}><MoreHorizontal size={16} /></Button>{isMenuOpen && <div className="document-dropdown">
            <label className="document-rename">{t("简历名称", "Resume name")}<input aria-label={t("简历名称", "Resume name")} value={activeResume.name === "Default" ? t("我的简历", "My resume") : activeResume.name} onChange={event => updateResume({ ...activeResume, name: event.target.value })} /></label>
            <button onClick={() => { if (docRef.current) edit(addResumeView(docRef.current)); setIsMenuOpen(false); }}><FileText size={14} />{t("新建简历", "New resume")}</button>
            <button onClick={() => { if (docRef.current) edit(duplicateResumeView(docRef.current, activeResume.id)); setIsMenuOpen(false); }}><FileText size={14} />{t("复制当前简历", "Duplicate resume")}</button>
            <button onClick={() => { setIsHistoryOpen(true); setIsMenuOpen(false); }}><GitBranch size={14} />{t("历史版本", "Version history")}</button>
            <AgentTopBarStatus config={llmConfig} active={false} onNavigateToAgent={() => { setPage("agent"); setIsMenuOpen(false); }} onOpenAiConfig={() => { openSystemSettings("connections"); setIsMenuOpen(false); }} />
            <button onClick={() => { setIsImportModalOpen(true); setIsMenuOpen(false); }}><Upload size={14} />{t("导入简历", "Import resume")}</button>
            <button onClick={() => { refreshJobRecommendations(); setIsMenuOpen(false); }}><Sparkles size={14} />{t("寻找匹配岗位", "Find matching roles")}</button>
            <hr /><button onClick={handleExportBackup}><Download size={14} />{t("下载 JSON 备份", "Download JSON backup")}</button><button onClick={handleExportJsonResume}><Download size={14} />{t("导出 JSON Resume", "Export JSON Resume")}</button><button onClick={handleExportInteractivePortfolio}><Globe size={14} />{t("导出交互式职业主页 (.html)", "Export Interactive Portfolio (.html)")}</button><button onClick={() => fileInputRef.current?.click()}><RotateCcw size={14} />{t("从备份 / JSON Resume 恢复", "Restore backup / JSON Resume")}</button>
            <hr /><span className="document-danger-label">{t("谨慎操作", "Use with care")}</span><button className="document-danger-action" disabled={doc.resumeViews.length <= 1} onClick={() => void deleteResumeView(activeResume.id)}>{t("删除当前简历版本", "Delete current resume")}</button><button className="document-danger-action" onClick={() => void resetDemo()}><RotateCcw size={14} />{t("恢复演示简历", "Reset demo resume")}</button></div>}</div>
        </div>
      </div>
      <div className="studio-notices no-print">
        {(status.kind === "error" || (status.kind === "draft" && hasIncompleteDraft) || status.historyError || isRestoring || actionError || status.rawDraftRecovery || status.rawOfficialRecovery || status.rawPreviousDraftRecovery || loadError) && <div className={`persistence-notice ${status.kind === "error" ? "error" : ""}`} role="status" aria-live="polite"><span>{isRestoring ? t("正在读取备份，继续编辑会取消本次恢复。", "Reading backup. Continuing to edit will cancel this restoration.") : actionError || loadError || status.message}{status.historyError && ` ${status.historyError}`}</span><div>{status.kind === "error" && <button onClick={() => void flush()}>{t("重试保存", "Retry save")}</button>}{status.rawDraftRecovery && <button onClick={() => downloadJson(status.rawDraftRecovery!, "better-me-draft-recovery.json")}>{t("下载原始草稿", "Download original draft")}</button>}<button onClick={handleExportBackup}>{t("下载备份", "Download backup")}</button>{status.rawOfficialRecovery && <button onClick={() => downloadJson(status.rawOfficialRecovery!, "better-me-backup-recovery.json")}>{t("下载原始文档", "Download original document")}</button>}{status.rawPreviousDraftRecovery && <button onClick={() => downloadJson(status.rawPreviousDraftRecovery!, "better-me-draft-before-switch.json")}>{t("下载切换前草稿", "Download pre-switch draft")}</button>}</div></div>}
        {inventoryInvite && inventoryInvite === doc.documentId && <section className="iv-invite" aria-label={t("导入后的下一步", "Next step after import")}><strong>{t("旧稿导入好了。这之后，有哪些变化？", "Your resume draft is imported. What has changed since then?")}</strong><button className="iv-primary" onClick={openInventory}>{t("一起盘点最近的变化", "Review recent changes")}</button><button onClick={() => { setInventoryInvite(undefined); setWorkspaceTab("content"); showResumeEditor(); }}>{t("直接进入编辑", "Go to editor")}</button></section>}
        {visibleFacts.importSource && <Suspense fallback={null}><ImportSourceReview source={visibleFacts.importSource} factBase={visibleFacts} onUpdateFactBase={updateFactBase} /></Suspense>}
        {jobRecommendation && jobRecommendation.documentId === doc.documentId && <Suspense fallback={<div className="persistence-notice" role="status">{t("正在打开岗位推荐…", "Opening job recommendations…")}</div>}><ResumeJobRecommendations evidenceLinks={doc.requirementEvidence} key={jobRecommendation.documentId} factBase={jobRecommendation.factBase} currentFactBase={visibleFacts} requestId={jobRecommendation.requestId} onRefresh={refreshJobRecommendations} onClose={() => setJobRecommendation(null)} onOpenAtlas={() => setPage("atlas")} onDiscoverOfficialJobs={openResumeDiscovery} onAnalyze={openAgentWorkspace} onSelectForResume={job => {
          setReplacementSelection({ viewId: activeResume.id, job }); setJobRecommendation(null); setWorkspaceTab("content"); showResumeEditor();
        }} onEditResume={() => {
          setWorkspaceTab("content");
          requestAnimationFrame(() => {
            const panel = document.getElementById("resume-editor-panel");
            panel?.scrollIntoView({ block: "start", behavior: "instant" });
            panel?.focus({ preventScroll: true });
          });
        }} /></Suspense>}
      </div>
      <ResizableWorkspace>
        <div id="resume-editor-panel" tabIndex={-1} data-onboarding="editor" className="studio-editor-pane no-print">
          <div id="content-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "content"}>{page === "resume" && workspaceTab === "content" && <ResumeReplacementEditor
            key={JSON.stringify([doc.documentId, activeResume.id, editorJob && careerJobSnapshotVersion(editorJob)])}
            facts={visibleFacts} view={activeResume} projected={projected} fingerprint={careerSourceFingerprint}
            initialJob={editorJob} onCheckReadback={() => void checkReplacementReadback()}
            readback={editionReadback && !editionReadback.identitySignal.aborted && editionReadback.workspaceKey === (doc.documentId ?? "default")
              && (activeResume.id === editionReadback.editionId || activeResume.id === editionReadback.receipt.sourceResumeId) ? editionReadback : undefined}
            workspaceKey={doc.documentId ?? "default"} config={llmConfig} onSave={saveReplacementEdition} />}
            <FactEditor writingFocus={writingFocus} focusAnchor={editorFocusAnchor} factBase={visibleFacts} onChange={updateFactBase} onAskAgentReference={(reference) => setAgentCompanionReference(reference)} textStyles={activeResume.textStyles} onTextStylesChange={updateStyles} onPreviewTargetChange={setPreviewTarget} issueNavigation={issueNavigation} onDismissIssue={() => setIssueNavigation(null)} /></div>
          <div id="design-panel" role="tabpanel" className="studio-panel-slot" hidden={workspaceTab !== "design"}><Suspense fallback={null}><ResumeDesignPanel view={activeResume} factBase={visibleFacts} onChange={updateResume} /></Suspense></div>

        </div>
        <div id="resume-preview-panel" className="studio-preview-pane"><ResumeWritingCopilot key={`${doc.documentId ?? "legacy"}:${activeResume.id}:${activeResume.targetJdId ?? ""}`} sessionKey={`${doc.documentId ?? "legacy"}:${activeResume.id}:${activeResume.targetJdId ?? ""}`} isolatedResumeId={activeResume.isolatedFactBase ? activeResume.id : undefined} sources={writingContext} inventorySession={currentInventory?.session} inventoryControl={inventoryWriting} editorialFindings={editorialFindings} config={llmConfig} careerTask={{sourceResumeId:activeResume.id,sourceFingerprint:careerSourceFingerprint,job:agentDrawerJob}} active={page === "resume" && !inventoryOpen && !(inventoryInvite && inventoryInvite === doc.documentId) && workspaceTab === "content" && !isHistoryOpen && !isJdMatchOpen && !isImportModalOpen && !isAiConfigOpen && !isNetworkSettingsOpen && !isAgentDrawerOpen} onApply={handleApplyWritingProposal} onFocus={(source) => {
          const target = source.targetRef;
          setPage("resume"); setWorkspaceTab("content");
          setWritingFocus({ key: writingTargetKey(target), locale: target.locale, experienceId: target.kind === "claim_text" ? target.experienceId : undefined, requestId: ++issueRequestIdRef.current });
          setPreviewTarget({ anchor: target.kind === "claim_text" ? `claim:${target.claimId}` : "profile:headline", source: "focus" });
        }}><ResumePreview resume={projected} view={activeResume} onViewChange={updateResume} onTemplateChange={setTemplate} followTarget={workspaceTab === "content" ? previewTarget : null} onSelectAnchor={(anchor) => { setWorkspaceTab("content"); setEditorFocusAnchor({ anchor, requestId: ++issueRequestIdRef.current }); }} onOpenAtsDiagnostics={() => setIsAtsDiagnosticsOpen(true)} /></ResumeWritingCopilot></div>
      </ResizableWorkspace>
      </div>
      {opportunitiesInitialized && <div className="secondary-workspace no-print" hidden={page !== "opportunities"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载机会工作区…", "Loading opportunity workspace…")}</div>}><OpportunityWorkspace seed={opportunitySeed} onSeedConsumed={() => setOpportunitySeed(null)} linkedResumeNames={linkedResumeNames} getCurrentResumeMaterial={currentResumeMaterial} getDecisionEvidence={currentOpportunityDecisionEvidence} getDecisionContext={currentOpportunityDecisionContext} onOpenJd={() => setIsJdMatchOpen(true)} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onCreateResume={createJobResume} onAnalyze={(job) => { openAgentWorkspace({ ...opportunityDecisionCareerJob(job), location: [job.location.city, job.location.region].filter(Boolean).join(" · ") || undefined, salary: job.salaryText || undefined }); }} /></Suspense></div>}
      {atlasInitialized && <div className="secondary-workspace no-print" hidden={page !== "atlas"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载岗位地图…", "Loading opportunity atlas…")}</div>}><AtlasWorkspace resume={projected} factBase={visibleFacts}
        resumeIdentity={JSON.stringify([doc.documentId, activeResume.id])}
        agentConfig={llmConfig} onAskAgentAboutHarvest={setAgentCompanionPrompt} onOpenOpportunitySources={() => setPage("opportunities")} active={page === "atlas"} onSaveOpportunity={(seed) => { setOpportunitySeed(seed); setPage("opportunities"); }} onAnalyze={(item) => { openAgentWorkspace({ title: item.jobTitle, company: item.company, description: item.text, sourceUrl: item.url, sourcePlatform: item.platform }); }} /></Suspense></div>}
      {resourcesInitialized && <div className="secondary-workspace no-print" hidden={page !== "resources"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载资源库…", "Loading resource library…")}</div>}><ResourceLibrary /></Suspense></div>}
      <div className="secondary-workspace no-print" hidden={page !== "agent"}>
        {agentMode !== "advisor" && <AgentTaskNavigation active={agentMode} onOpenArea={openAgentArea} onSelect={view => { setAgentNavigation(previous => ({ view, id: (previous?.id ?? 0) + 1 })); setAgentMode("advisor"); }} onBack={() => { setPage("resume"); setWorkspaceTab("content"); }} />}
        {agentAdvisorInitialized && <div className="cs-advisor-slot" hidden={agentMode !== "advisor"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载 AI 职业顾问…", "Loading AI career advisor…")}</div>}><AgentWorkspace evidenceWorkspace={evidenceWorkspace} navigationRequest={agentNavigation} onOpenArea={openAgentArea} workspaceKey={activeResume?.id ?? "default"} active={page === "agent" && agentMode === "advisor"} onActivate={() => { setPage("agent"); setAgentMode("advisor"); setIsAgentDrawerOpen(false); }} job={agentDrawerJob} resume={projected} resumeEditContext={resumeEditContext} careerTaskConfig={{ workspaceKey: doc.documentId ?? "default", sourceResumeId: activeResume.id, sourceResumeName: activeResume.name, sourceFingerprint: careerSourceFingerprint, onSave: handleSaveCareerTask, onCommitFact: handleCommitCareerFact, onReconcile: reconcileCareerWorkspace }} onApplyResumeProposal={handleApplyResumeProposal} llmConfig={llmConfig} onOpenConfig={() => openSystemSettings("connections")} onNavigateToResume={() => { setPage("resume"); setWorkspaceTab("content"); }} onApplyToResume={handleApplyCustomResume} onSaveOpportunity={(job) => { setOpportunitySeed({ token: crypto.randomUUID(), title: job.title, company: job.company, description: job.description, sourceJobId: job.id, sourceUrl: job.sourceUrl, sourcePlatform: job.sourcePlatform }); setPage("opportunities"); }} /></Suspense></div>}
        <div className="cs-growth-slot" hidden={agentMode !== "growth"}>{page === "agent" && agentMode === "growth" && <Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在读取成长记录…", "Loading learning records…")}</div>}><GrowthJourneyWorkspace cloudConfig={llmConfig} /></Suspense>}</div>
        {studioInitialized && <div className="cs-studio-slot" hidden={agentMode !== "studio"}><Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载证据工作台…", "Loading the evidence workspace…")}</div>}><CareerStudioWorkspace active={page === "agent" && agentMode === "studio"} workspaceKey={doc.documentId ?? "default"} resumeId={activeResume.id} sourceFingerprint={careerSourceFingerprint ?? ""} resume={projected} resumeEditContext={resumeEditContext} onApplyWording={handleStudioWording} onAdoptLayout={handleStudioLayout} onAdoptEvidence={handleStudioEvidence} /></Suspense></div>}
      </div>
      {autopilotInitialized && <div className="secondary-workspace no-print" hidden={page !== "autopilot"}>
        <Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在加载 Autopilot 工坊…", "Loading Autopilot Studio…")}</div>}>
          <AutopilotStudioWorkspace
            active={page === "autopilot"}
            factBase={visibleFacts}
            resume={projected}
            onOpenMicroApp={app => window.dispatchEvent(new window.CustomEvent("betterme:open-micro-app", { detail: app }))}
            onOpenOpportunitySources={() => setPage("opportunities")}
            onOpenOpportunity={() => setPage("opportunities")}
            onAnalyzeOpportunity={(job) => openAgentWorkspace({
              id: job.id,
              title: job.title,
              company: job.company,
              location: [job.location.city, job.location.region].filter(Boolean).join(" · ") || undefined,
              salary: job.salaryText || undefined,
              description: job.description,
              sourceUrl: job.sourceUrl || undefined,
              sourcePlatform: job.sourcePlatform,
            })}
          />
        </Suspense>
      </div>}
      <footer className="studio-footer no-print"><span><ShieldCheck size={12} />{t("本地优先存储", "Local-first storage")}{undoFeedback && <span className="bm-undo-feedback"> · {undoFeedback}</span>}</span><span>{page === "resume" ? t(`${autoSaveDescription} · ${saveShortcutLabel} 保存 · ${cmdShortcutLabel} 命令面板`, `${autoSaveDescription} · ${saveShortcutLabel} save · ${cmdShortcutLabel} commands`) : page === "opportunities" ? t(`变更需点击保存 · ${cmdShortcutLabel} 命令面板`, `Save to apply changes · ${cmdShortcutLabel} commands`) : page === "atlas" ? t(`实时索引与地图同步 · ${cmdShortcutLabel} 命令面板`, `Map & index synced · ${cmdShortcutLabel} commands`) : page === "agent" ? t(`AI 职业顾问工作台 · ${cmdShortcutLabel} 命令面板`, `AI Career Workspace · ${cmdShortcutLabel} commands`) : page === "autopilot" ? t(`投递自动化工作台 · ${cmdShortcutLabel} 命令面板`, `Autopilot Studio · ${cmdShortcutLabel} commands`) : t(`精选外部求职资源 · ${cmdShortcutLabel} 命令面板`, `Curated career resources · ${cmdShortcutLabel} commands`)}</span></footer>
    </div></div></DesktopShell>
    <div className="no-print">
      <NetworkSettingsModal isOpen={isNetworkSettingsOpen} onClose={() => setIsNetworkSettingsOpen(false)} />
      {inventoryOpen && inventoryMaterial && page === "resume" && <Suspense fallback={null}><CareerInventory key={inventoryMaterial.fingerprint} source={inventoryMaterial} fields={inventoryFields} config={llmConfig} assertSource={assertInventorySource}
        onPickSource={(field, review) => {
          assertInventorySource();
          const cur = docRef.current, view = cur?.resumeViews.find(r => r.id === cur.activeResumeId);
          const live = cur && view ? writingSources(createResumeAgentContext(cur.factBase, view)).filter(f => writingTargetKey(f.targetRef) === writingTargetKey(field.targetRef)) : [];
          if (!live[0] || live.length !== 1 || live[0].text !== field.text || !inventoryWriting.current) throw Error("当前版本已无法定位这条原句，请重新核对。");
          inventoryWriting.current.openField(live[0]); setInventoryReview(review); setInventoryOpen(false); showResumeEditor();
        }}
        onClose={() => setInventoryOpen(false)} onConfirmed={setInventoryReview} onRefine={() => { setInventoryOpen(false); setWorkspaceTab("content"); showResumeEditor(); }} /></Suspense>}
      {isAiConfigOpen && <Suspense fallback={null}><AiConfigModal isOpen={isAiConfigOpen} onClose={() => setIsAiConfigOpen(false)} config={llmConfig} onSave={handleSaveLlmConfig} onChooseAgentSource={() => openSystemSettings("tools")} rootScopeKey={doc.documentId ?? activeResume.id} /></Suspense>}
      {page === "resume" && resumeDiscovery && resumeDiscovery.documentId === doc.documentId && resumeDiscovery.viewId === activeResume.id &&
        <Suspense fallback={<p className="persistence-notice" role="status">{t("正在打开岗位搜索…", "Opening job search…")}</p>}>
          <ResumeJobDiscoveryDialog selection={resumeDiscovery} onOpenBackgroundWatch={() => openBackgroundWatch(resumeDiscovery)} onClose={() => setResumeDiscovery(undefined)}
            onCollected={() => { if (jobRecommendation?.documentId === doc.documentId) refreshJobRecommendations(); }}
            onOpenMap={() => { setResumeDiscovery(undefined); setPage("atlas"); }} />
        </Suspense>}
      {isJdMatchOpen && !jdSelection && <Suspense fallback={null}><JdMatchModal evidenceWorkspace={evidenceWorkspace} onGrowthRequirement={openGrowthRequirement} workspaceKey={doc.documentId ?? activeResume.id} onImportResume={() => setIsImportModalOpen(true)} onEditResume={editResumeForMatching} onSaveOpportunity={({ text, provenance, job }) => { setOpportunitySeed({ token: crypto.randomUUID(), description: text, title: job?.title ?? provenance?.title, company: job?.company, sourceUrl: job?.sourceUrl ?? provenance?.url, sourcePlatform: job?.sourcePlatform ?? provenance?.platform, collectedAt: provenance?.observedAt, sourcePublishedAt: provenance?.sourcePublishedAt, sourcePublishedText: provenance?.sourcePublishedText }); setIsJdMatchOpen(false); setPage("opportunities"); }} isOpen={isJdMatchOpen && !jdSelection} onClose={() => setIsJdMatchOpen(false)} resume={projected} llmConfig={llmConfig} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onOpenConfig={() => { setIsJdMatchOpen(false); openSystemSettings("connections"); }} /></Suspense>}
      {jdSelection && isJdMatchOpen && <Suspense fallback={null}><JdMatchModal evidenceWorkspace={evidenceWorkspace} onGrowthRequirement={openGrowthRequirement} workspaceKey={doc.documentId ?? activeResume.id} onImportResume={() => setIsImportModalOpen(true)} onEditResume={editResumeForMatching} key={jdSelection.token} initialText={jdSelection.text} initialSource={jdSelection.source} isOpen={isJdMatchOpen} onClose={() => { setIsJdMatchOpen(false); setJdSelection(null); }} resume={projected} llmConfig={llmConfig} onOpenNetworkSettings={() => setIsNetworkSettingsOpen(true)} onOpenConfig={() => { setIsJdMatchOpen(false); setJdSelection(null); openSystemSettings("connections"); }} /></Suspense>}
      <LazyResumeImportModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} llmConfig={llmConfig} onImportSuccess={handleImportResumeSuccess} onOpenAiConfig={() => { setIsImportModalOpen(false); openSystemSettings("connections"); }} />
      {isHistoryOpen && <Suspense fallback={null}><VersionHistoryPanel history={history} currentDocument={doc} persistenceStatus={status} onCheckpoint={checkpoint} onRestore={restoreVersion} onRestoreField={restoreVersionField} onClose={() => setIsHistoryOpen(false)} /></Suspense>}
      {isAgentDrawerOpen && <Suspense fallback={null}><JdMatchDrawer
        workspaceKey={activeResume.id}
        isOpen={isAgentDrawerOpen}
        onClose={() => setIsAgentDrawerOpen(false)}
        job={agentDrawerJob}
        resume={projected}
        llmConfig={llmConfig}
        onOpenConfig={() => {
          setIsAgentDrawerOpen(false);
          openSystemSettings("connections");
        }}
        onApplyToResume={handleApplyCustomResume}
        onSaveOpportunity={(job) => {
          setOpportunitySeed({
            token: crypto.randomUUID(),
            title: job.title,
            company: job.company,
            description: job.description,
            sourceJobId: job.id,
            sourceUrl: job.sourceUrl,
            sourcePlatform: job.sourcePlatform,
          });
          setIsAgentDrawerOpen(false);
          setPage("opportunities");
        }}
      /></Suspense>}
      {navigationRecovery.error && <WorkspaceRecoveryNotice {...navigationRecovery} />}
      <Suspense fallback={null}><AgentCompanion
        workspaceKey={activeResume.id}
        onOpenWorkspace={() => setPage("agent")}
        llmConfig={llmConfig}
        resume={projected}
        initialReference={agentCompanionReference}
        onReferenceConsumed={() => setAgentCompanionReference(null)}
        initialPrompt={agentCompanionPrompt}
        onPromptConsumed={() => setAgentCompanionPrompt(null)}
        onOpenAiConfig={() => openSystemSettings("connections")}
      /></Suspense>
      <BetterMeAgentCenter onNavigate={origin => {
        if (origin === "growth") { setPage("agent"); window.dispatchEvent(new CustomEvent("betterme:open-growth")); }
        else if (origin === "companion") window.dispatchEvent(new CustomEvent("betterme:open-companion"));
        else { setPage("resume"); setWorkspaceTab("content"); }
      }} />
      <CommandPalette
        open={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        items={commandItems}
        placeholder={t("搜索命令、工作台或版式模板…", "Search actions, workspaces, or templates…")}
        emptyLabel={t("未找到匹配的命令", "No matching commands")}
        ariaLabel={t("全局命令面板", "Command palette")}
      />
      {isAtsDiagnosticsOpen && (
        <div
          className="bm-ats-modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setIsAtsDiagnosticsOpen(false);
          }}
        >
          <div className="bm-ats-modal-dialog" role="dialog" aria-modal="true" aria-label={t("ATS 纯文本与 JD 匹配诊断", "ATS & JD Diagnostics")}>
            <Suspense fallback={<div className="studio-loading"><Loader2 className="animate-spin" />{t("正在打开 ATS 诊断…", "Opening ATS diagnostics…")}</div>}>
              <AtsDiagnosticTool
                initialResumeText={toAtsPlainText(projectedResumeToMarkdown(projected))}
                onClose={() => setIsAtsDiagnosticsOpen(false)}
              />
            </Suspense>
          </div>
        </div>
      )}
      {isSkillAtlasOpen && (
        <Suspense fallback={null}>
          <SkillEvidenceAtlas
            factBase={visibleFacts}
            view={activeResume}
            onViewChange={updateResume}
            onExportInteractiveHtml={handleExportInteractivePortfolio}
            onJumpToAnchor={(anchor) => {
              setPage("resume");
              setWorkspaceTab("content");
              setEditorFocusAnchor({ anchor, requestId: ++issueRequestIdRef.current });
            }}
            onClose={() => setIsSkillAtlasOpen(false)}
          />
        </Suspense>
      )}
    </div>
  </AgentSidebarProvider></BetterMeAgentProvider></LocalAgentRuntimeProvider>;
}
