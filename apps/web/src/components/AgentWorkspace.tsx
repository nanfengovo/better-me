/** @jsxRuntime automatic */
import { useEffect, useLayoutEffect, useRef, useState, useMemo, type ChangeEvent } from "react";
import { useUiPreferences } from "../lib/ui-preferences";
import { readChatImage, chatImageErrorMessage, MAX_CHAT_IMAGES } from "../lib/chat-images";
import { useAgentRouting } from "../lib/agent-routing";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { useAgentTaskRuntime } from "../lib/agent-task-runtime";
import {alignJdWithResume,decomposeJdText,type InterviewDefenseStrategy,type LlmConfig,type ProjectedResume} from "@better-me/core";
import { careerJobSnapshotVersion, careerTrainingRequirements, type ResumeEditContext, type ResumeProposalTarget } from "@better-me/agent-contracts";
import {
  Bot,
  Check,
  CheckCircle2,
  Copy,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Square,
  ShieldCheck,
  Sparkles,
  X,
  GripVertical,
  PanelRightOpen,
  ImagePlus,
} from "lucide-react";
import { triggerAgentGuide } from "../lib/agent-guide";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { localBridgeHeaders } from "../lib/local-bridge-client";
import { isJdLinkOnly } from "../lib/jd-import";
import { applyJdMetadata, extractAndParseJobLink, type ParsedJobInfo } from "../lib/jd-link-parser";
import { defaultJdIntakeTaskClient } from "../services/jd-intake-task-client";
import type { JdIntakeTask } from "@better-me/agent-contracts";
import {
  startJdMatch,
  resumeJdMatch,
  sendAgentChat,
  pauseAgentChatTask,
  chatMessagesForRequest,
  type MatchProposal,
  type ChatMessage,
  type ResumeTextReference,
} from "../services/agent-client";
import { getModelImageCapability, modelImageCapabilityDescription, modelImageCapabilityLabel } from "../lib/model-image-capability";
import type { DrawerJobContext } from "./JdMatchDrawer";
import { AgentMarkdownRenderer } from "./AgentMarkdownRenderer";
import { AgentAutoSpeechToggle, AgentSpeechControl, useAgentSpeech, useSessionAutoSpeech } from "./AgentSpeechControl";
import { AgentReplyMeta } from "./AgentReplyMeta";
import { CareerCoachWorkspace } from "./CareerCoachWorkspace";
import type { TrainingRequirementSelection } from "./CareerTrainingPanel";
import { AgentTaskNavigation, type AgentTaskView } from "./AgentTaskNavigation";
import { AgentExternalHandoff } from "./AgentExternalHandoff";
import { extractJobLink } from "../lib/job-link";
import type { CoachMode } from "../lib/career-coach/types";
import CareerTaskPanel, { type CareerTaskPanelProps } from "./CareerTaskPanel";
import { useAgentSidebar } from "./AgentSidebar";
import { isCareerTailoringRequest } from "../lib/career-task-intent";
import { privateKey } from "../lib/private-storage";
import { useRecoveryField, useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import {
  AdvisorRecoverySchema, BrowserJobSchema, advisorJobDraft, advisorJobKey, advisorMatchKey, captureAdvisorJobDraft,
  emptyAdvisorMatch, initialAdvisorRecovery, switchAdvisorConversation, switchAdvisorJob, type AdvisorMatch,
} from "../lib/advisor-recovery";
import { WorkspaceRecoveryNotice } from "./WorkspaceRecoveryNotice";
import { AgentEmptyPromptCards } from "./agent-workspace/AgentEmptyPromptCards";
import { AgentActiveJobHeader } from "./agent-workspace/AgentActiveJobHeader";
import { findResumeContextSource } from "../lib/resume-agent-context";
import { jdMatchResumeMaterial } from "../services/jd-match-task-client";
import {MockInterviewPanel} from "./MockInterviewPanel";
import {createInterviewSelection,isInterviewSelectionCurrent,InterviewLaunchSchema,InterviewWorkspaceStateSchema,interviewLaunchEvent} from "../lib/mock-interview-launch";
import { AgentReplyActionsCard } from "./agent-workspace/AgentReplyActionsCard";
import { AgentJdDetailsView } from "./agent-workspace/AgentJdDetailsView";
import { AgentProposalListSection } from "./agent-workspace/AgentProposalListSection";
import { AgentApplyModal } from "./agent-workspace/AgentApplyModal";
import { AgentFitAnalyticsHeader } from "./agent-workspace/AgentFitAnalyticsHeader";

import { RequirementEvidencePanel } from "./RequirementEvidencePanel";
import type { EvidenceWorkspace } from "../lib/requirement-evidence";

export interface AgentWorkspaceProps {
  evidenceWorkspace?: EvidenceWorkspace;
  sendChat?:typeof sendAgentChat;
  workspaceKey?: string;
  active?: boolean;
  onActivate?:()=>void;
  navigationRequest?: { view: AgentTaskView; id: number; trainingRequirement?: TrainingRequirementSelection };
  onOpenArea?: (area: "growth" | "studio") => void;
  job: DrawerJobContext | null;
  resume: ProjectedResume | null;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
  onNavigateToResume: () => void;
  onApplyToResume: (payload: {
    acceptedProposals: MatchProposal[];
    customResumeName: string;
    targetJobTitle: string;
    targetCompany: string;
  }) => void;
  onSaveOpportunity?: (job: DrawerJobContext) => void;
  initialReference?: ResumeTextReference | null;
  onReferenceConsumed?: () => void;
  resumeEditContext?: ResumeEditContext;
  onApplyResumeProposal?: (proposal: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }) => Promise<{ ok: boolean; message?: string }>;
  careerTaskConfig?: Omit<CareerTaskPanelProps, "job" | "resumeFields" | "llmConfig" | "initialObjective">;
}

export function AgentWorkspace(props: AgentWorkspaceProps) {
  return <AgentWorkspaceSession key={privateKey(props.workspaceKey ?? "active-resume")} {...props} />;
}

function AgentWorkspaceSession({
  workspaceKey = "active-resume",
  evidenceWorkspace,
  sendChat=sendAgentChat,
  active = true,
  onActivate,
  navigationRequest,
  onOpenArea,
  job,
  resume,
  llmConfig,
  onOpenConfig,
  onNavigateToResume,
  onApplyToResume,
  onSaveOpportunity,
  initialReference,
  onReferenceConsumed,
  resumeEditContext,
  onApplyResumeProposal,
  careerTaskConfig,
}: AgentWorkspaceProps) {
  const { t, theme } = useUiPreferences();
  const {agent}=useBetterMeAgent();
  const taskRuntime=useAgentTaskRuntime(llmConfig);
  const sidebar=useAgentSidebar();
  const isDark = theme === "dark";
  const recovery = useWorkspaceRecovery(`advisor:${workspaceKey}`, AdvisorRecoverySchema, () => initialAdvisorRecovery(job));
  const interviewWorkspaceKey=agent?.workspaceKey??workspaceKey;
  const interviewRecovery=useWorkspaceRecovery(`interview-index:${interviewWorkspaceKey}`,InterviewWorkspaceStateSchema,()=>({open:false}));
  const { set: saveInterview, field: saveInterviewField, error: interviewStorageError } = interviewRecovery;
  const { set: saveAdvisor } = recovery;
  const [showCareerCoach, setShowCareerCoach] = useRecoveryField(recovery, "showCareerCoach");
  const [showCareerTask, setShowCareerTask] = useState(false);
  const [taskObjective, setTaskObjective] = useState<string>();
  const [taskView, setTaskView] = useRecoveryField(recovery, "taskView");
  const speech = useAgentSpeech(`advisor:${privateKey(workspaceKey)}`, active && !showCareerCoach && taskView !== "handoff" && !showCareerTask);
  const [coachRequest, setCoachRequest] = useState<{ mode: CoachMode; id: number; trainingRequirement?: TrainingRequirementSelection }>();
  function selectTask(view: AgentTaskView, trainingRequirement?: TrainingRequirementSelection) {
    interviewRecovery.field("open",false);
    setShowCareerTask(false);
    setTaskView(view);
    const mode: CoachMode | undefined = view === "resume" ? "resume" : view === "career" ? "analysis" : view === "learning" ? "plan" : view === "practice" ? "interview" : undefined;
    setShowCareerCoach(Boolean(mode));
    if (mode) setCoachRequest(previous => ({ mode, id: (previous?.id ?? 0) + 1, trainingRequirement }));
  }
  const selectTaskRef = useRef(selectTask);
  selectTaskRef.current = selectTask;
  useEffect(() => { if (navigationRequest) selectTaskRef.current(navigationRequest.view, navigationRequest.trainingRequirement); }, [navigationRequest]);
  const [careerCoachInitialized, setCareerCoachInitialized] = useState(false);
  useEffect(() => { if (showCareerCoach) setCareerCoachInitialized(true); }, [showCareerCoach]);
  useEffect(() => { const open = () => { setTaskView("career"); setShowCareerCoach(true); }; window.addEventListener("betterme:open-growth", open); return () => window.removeEventListener("betterme:open-growth", open); }, [setTaskView, setShowCareerCoach]);

  // Current Target Job state
  const { currentJob, browserJob, beforeBrowserImport } = recovery.value;
  const currentJobView: DrawerJobContext = currentJob ?? {
    title: t("简历讨论", "Resume discussion"),
    company: "",
    description: "",
  };
  const [isEditingJob, setIsEditingJob] = useRecoveryField(recovery, "isEditingJob");
  const isSetupMode = !currentJob?.description || isEditingJob;
  const [inputTitle, setInputTitle] = useRecoveryField(recovery, "inputTitle");
  const [inputCompany, setInputCompany] = useRecoveryField(recovery, "inputCompany");
  const [inputSalary, setInputSalary] = useRecoveryField(recovery, "inputSalary");
  const [inputLocation, setInputLocation] = useRecoveryField(recovery, "inputLocation");
  const [inputDescription, setInputDescription] = useRecoveryField(recovery, "inputDescription");

  // Link import state
  const [isLinkInputOpen, setIsLinkInputOpen] = useState(true);
  const [linkInputValue, setLinkInputValue] = useRecoveryField(recovery, "linkInputValue");
  const [isExtractingLink, setIsExtractingLink] = useState(false);
  const intakeObserver=useRef<AbortController|undefined>(undefined);
  const intakeVersion=useRef(0);
  const [intakeTask,setIntakeTask]=useState<JdIntakeTask>();
  const [intakeBase,setIntakeBase]=useState<ParsedJobInfo>();
  const [intakeResumeConsent,setIntakeResumeConsent]=useState(false);
  useEffect(()=>{intakeVersion.current++;intakeObserver.current?.abort();setIntakeTask(undefined);setIntakeBase(undefined);setIntakeResumeConsent(false);setIsExtractingLink(false);
    // The cleanup invalidates the latest request generation, not a mounted DOM ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return ()=>{intakeVersion.current++;intakeObserver.current?.abort();};
  },[taskRuntime.key]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSuccessNotice, setLinkSuccessNotice] = useState<string | null>(null);
  const { sourceUrl, sourcePlatform } = recovery.value;

  const [leftViewMode, setLeftViewMode] = useState<"jd" | "chat">("chat");
  const [pageMotion, setPageMotion] = useState<"forward" | "back" | "none">("none");
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const [setupSummaryOpen, setSetupSummaryOpen] = useState(false);
  const showRightPane = isSetupMode ? setupSummaryOpen : rightPaneOpen;
  const [mobilePane, setMobilePane] = useState<"material" | "result">("material");

  function showLeftPage(next: "jd" | "chat") {
    if (next === leftViewMode) return;
    setPageMotion(next === "chat" ? "forward" : "back");
    setLeftViewMode(next);
  }

  // Draggable Split Pane State (Left-Right Pane Resize)
  const AGENT_SPLIT_KEY = "betterme-agent-workspace-split";
  const DEFAULT_SPLIT_PERCENT = 46;
  const [splitPercent, setSplitPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(AGENT_SPLIT_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 25 && parsed <= 75) return parsed;
      }
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
    return DEFAULT_SPLIT_PERCENT;
  });
  const [splitAdjusted, setSplitAdjusted] = useState(() => {
    try { const value = Number(localStorage.getItem(AGENT_SPLIT_KEY)); return value >= 25 && value <= 75; } catch { return false; }
  });
  const displaySplitPercent = splitAdjusted ? splitPercent : isSetupMode ? 65 : DEFAULT_SPLIT_PERCENT;
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ pointerId: number; percent: number } | null>(null);

  const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSplitPercent(displaySplitPercent);
    setSplitAdjusted(true);
    splitDragRef.current = { pointerId: e.pointerId, percent: displaySplitPercent };
    setIsDraggingSplitter(true);
  };

  const handleSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!splitDragRef.current || splitDragRef.current.pointerId !== e.pointerId) return;
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const totalWidth = rect.width;
    if (totalWidth <= 0) return;
    const nextPercent = Math.min(75, Math.max(25, (rawX / totalWidth) * 100));
    setSplitPercent(nextPercent);
  };

  const handleSplitPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!splitDragRef.current || splitDragRef.current.pointerId !== e.pointerId) return;
    try {
      localStorage.setItem(AGENT_SPLIT_KEY, String(splitPercent));
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    splitDragRef.current = null;
    setIsDraggingSplitter(false);
  };

  const handleSplitReset = () => {
    setSplitAdjusted(false);
    setSplitPercent(DEFAULT_SPLIT_PERCENT);
    try {
      localStorage.removeItem(AGENT_SPLIT_KEY);
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
  };

  // Foldable sections state
  const [isJobSpecFolded, setIsJobSpecFolded] = useState(false);

  const documentKey = careerTaskConfig?.workspaceKey;
  const jobKey = useMemo(() => advisorJobKey(currentJob), [currentJob]);
  const matchKey = useMemo(() => advisorMatchKey(currentJob, resume, documentKey), [currentJob, resume, documentKey]);
  const liveContext = useRef({ jobKey, matchKey, mounted: true });
  useLayoutEffect(() => {
    liveContext.current = { jobKey, matchKey, mounted: true };
    return () => { liveContext.current.mounted = false; };
  }, [jobKey, matchKey, active]);
  const { threadId, structuredJd, proposals, decisions, editingProposalId, editedText } =
    (matchKey ? recovery.value.matches[matchKey] : undefined) ?? emptyAdvisorMatch;
  const pendingMatches = useRef(new Map<string, AbortController>());
  const [loadingMatches, setLoadingMatches] = useState<Record<string, boolean>>({});
  const [matchErrors, setMatchErrors] = useState<Record<string, string>>({});
  const loading = Boolean(matchKey && loadingMatches[matchKey]);
  const errorNotice = (matchKey ? matchErrors[matchKey] : undefined) || null;
  const setErrorNotice = (error: string) => {
    if (matchKey) setMatchErrors(previous => ({ ...previous, [matchKey]: error }));
  };

  function updateMatch(key: string | undefined, update: (previous: AdvisorMatch) => AdvisorMatch) {
    if (!key) return;
    saveAdvisor(previous => ({
      ...previous,
      matches: { ...previous.matches, [key]: update(previous.matches[key] ?? emptyAdvisorMatch) },
    }));
  }
  useEffect(() => {
    const requests = pendingMatches.current;
    return () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, []);

  // Proposal filter & detail view
  const [proposalFilter, setProposalFilter] = useState<"all" | "accepted" | "pending" | "rejected">("all");
  const [activeDiffProposalId, setActiveDiffProposalId] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useRecoveryField(recovery, "messages");
  const autoSpeech = useSessionAutoSpeech(messages, speech, active && !showCareerCoach && taskView !== "handoff" && !showCareerTask, `${workspaceKey}:${jobKey}`);
  const [shareResumeForEditing, setShareResumeForEditing] = useState(false);
  const [resumeProposalStates, setResumeProposalStates] = useState<Record<string, { status: "saving" | "approved" | "rejected" | "conflict" | "error"; message?: string }>>({});
  const lastAssistantMessageId = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const [inputMessage, setInputMessage] = useRecoveryField(recovery, "inputMessage");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const chatAbortRef = useRef<AbortController | null>(null);
  const kernelChatId=useRef<string|undefined>(undefined);
  const chatRouting=useAgentRouting();
  const pendingChatRef = useRef<ChatMessage | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useRecoveryField(recovery, "pendingAttachments");
  const [pendingReferences, setPendingReferences] = useRecoveryField(recovery, "pendingReferences");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const imageCapability = getModelImageCapability(llmConfig);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const chatImageRead = useRef(false);
  const [readingChatImages, setReadingChatImages] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => chatAbortRef.current?.abort(), []);

  function leaveJobConversation() {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    pendingChatRef.current = null;
    kernelChatId.current = undefined;
    setChatLoading(false);
    setChatNotice("");
    setAttachmentError(null);
    setShareResumeForEditing(false);
    setResumeProposalStates({});
  }

  const decideResumeProposal = async (key: string, action: NonNullable<ChatMessage["actions"]>[number], approve: boolean) => {
    if (!approve) {
      setResumeProposalStates((previous) => ({ ...previous, [key]: { status: "rejected", message: t("已拒绝；简历未修改。", "Rejected. The resume was not changed.") } }));
      return;
    }
    if (action.type !== "resume_proposal" || !shareResumeForEditing || !action.sourceVerified || !action.targetRef || !action.originalText || !action.proposedText || !onApplyResumeProposal
      || !resumeEditContext || findResumeContextSource(resumeEditContext, action.targetRef) !== action.originalText) {
      setResumeProposalStates((previous) => ({ ...previous, [key]: { status: "error", message: t("缺少已核验的原文目标，无法批准写回。请开启简历字段共享后重新生成建议。", "No verified source field. Enable resume-field sharing and regenerate the proposal.") } }));
      return;
    }
    setResumeProposalStates((previous) => ({ ...previous, [key]: { status: "saving" } }));
    try {
      const result = await onApplyResumeProposal({ targetRef: action.targetRef, originalText: action.originalText, proposedText: action.proposedText });
      setResumeProposalStates((previous) => ({
        ...previous,
        [key]: result.ok
          ? { status: "approved", message: result.message ?? t("已批准并提交到简历保存流程。", "Approved and submitted to the resume save flow.") }
          : { status: "conflict", message: result.message ?? t("原文已变化，未写入。请重新读取后生成建议。", "The source changed; nothing was written. Refresh the context and regenerate.") },
      }));
      if (result.ok) triggerAgentGuide({ section: action.targetRef.kind === "profile_headline" ? "headline" : "experience", text: action.proposedText, label: t("已批准 Agent 简历修改", "Approved Agent resume edit"), actionType: "applied" });
    } catch (error) {
      setResumeProposalStates((previous) => ({ ...previous, [key]: { status: "error", message: error instanceof Error ? error.message : t("简历修改未能保存。", "Could not save the resume edit.") } }));
    }
  };

  const onReferenceConsumedRef = useRef(onReferenceConsumed);
  useEffect(() => { onReferenceConsumedRef.current = onReferenceConsumed; }, [onReferenceConsumed]);
  useEffect(() => {
    if (!initialReference) return;
    setPendingReferences((previous) => [...previous.filter((entry) => entry.text !== initialReference.text), initialReference]);
    onReferenceConsumedRef.current?.();
  }, [initialReference, setPendingReferences]);

  // View state
  const [showGapsSummary, setShowGapsSummary] = useState(false);

  // Guided application milestone modal state
  const [applyingMatchKey, setApplyingMatchKey] = useState<string>();
  const isApplying = Boolean(applyingMatchKey && applyingMatchKey === matchKey);
  const pendingReviews = useRef(new Set<string>());
  const applyTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const timers = applyTimers.current;
    return () => { for (const timer of timers) clearTimeout(timer); timers.length = 0; };
  }, []);
  const [applyStep, setApplyStep] = useState<1 | 2 | 3>(1);
  const [extractingStepMessage, setExtractingStepMessage] = useState<string | null>(null);

  function cancelIntake() {
    intakeVersion.current++;
    intakeObserver.current?.abort();
    setIntakeTask(undefined);
    setIntakeBase(undefined);
    setIntakeResumeConsent(false);
    setIsExtractingLink(false);
    setExtractingStepMessage(null);
    setLinkError(null);
    setLinkSuccessNotice(null);
  }

  const lastBrowserSync = useRef(Math.max(Date.now(), recovery.value.lastBrowserSyncAt ?? 0));
  const jobPaneActive = active && !showCareerCoach && !showCareerTask && taskView === "job" && !interviewRecovery.value.open;
  useEffect(() => {
    // Docker does not attach the host browser/profile.
    if (!jobPaneActive || readRuntimeConnection()?.mode === "docker") return;
    let request: AbortController | undefined;
    const isVisible = () => document.visibilityState !== "hidden";
    const checkSync = async () => {
      if (request || !isVisible()) return;
      const controller = new AbortController();
      request = controller;
      try {
        const resp = await fetch("/api/jd/sync-extension", { headers: localBridgeHeaders, signal: controller.signal });
        if (!resp.ok) return;
        const data = await resp.json() as { latest?: unknown };
        const parsed = BrowserJobSchema.safeParse(data.latest);
        if (controller.signal.aborted || !isVisible() || !parsed.success || parsed.data.syncedAt <= lastBrowserSync.current) return;
        const latest = parsed.data;
        lastBrowserSync.current = latest.syncedAt;
        saveAdvisor(previous => ({ ...previous, browserJob: latest, lastBrowserSyncAt: latest.syncedAt }));
      } catch { /* A missed poll can be retried on the next refresh. */ }
      finally { if (request === controller) request = undefined; }
    };
    const poll = () => { void checkSync(); };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") {
        request?.abort();
        request = undefined;
      } else poll();
    };
    poll();
    const interval = setInterval(poll, 1200);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      request?.abort();
      clearInterval(interval);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [jobPaneActive, saveAdvisor]);

  function importBrowserJob() {
    if (!browserJob) return;
    cancelIntake();
    saveAdvisor(previous => ({
      ...previous, ...advisorJobDraft(browserJob), beforeBrowserImport: previous.beforeBrowserImport ?? captureAdvisorJobDraft(previous),
      isEditingJob: Boolean(previous.currentJob?.description), browserJob: undefined,
    }));
    setIsLinkInputOpen(false);
    showLeftPage("jd");
    setMobilePane("material");
  }

  function restoreBrowserDraft() {
    cancelIntake();
    saveAdvisor(previous => previous.beforeBrowserImport
      ? {
        ...previous, ...previous.beforeBrowserImport, beforeBrowserImport: undefined,
        isEditingJob: Boolean(previous.currentJob?.description) || previous.beforeBrowserImport.isEditingJob,
      } : previous);
    setIsLinkInputOpen(true);
    showLeftPage("jd");
    setMobilePane("material");
  }

  const hasUnassignedDraft = Boolean(currentJob && recovery.value.jobDrafts[advisorJobKey(null)]);

  function restoreUnassignedDraft() {
    cancelIntake();
    leaveJobConversation();
    saveAdvisor(previous => ({ ...switchAdvisorJob(previous, null), jobSeed: previous.jobSeed }));
    setIsLinkInputOpen(true);
    showLeftPage("jd");
    setMobilePane("material");
  }

  // Journal the outgoing draft and select the incoming job together, before paint.
  const initialJobSeed = useRef(recovery.value.jobSeed);
  const previousJobProp = useRef<DrawerJobContext | null | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousJobProp.current;
    previousJobProp.current = job;
    if (!job || previous === job) return;
    const nextJobKey = advisorJobKey(job);
    if (previous === undefined && advisorJobKey(initialJobSeed.current) === nextJobKey) return;
    cancelIntake();
    if (nextJobKey !== liveContext.current.jobKey) {
      leaveJobConversation();
      saveInterviewField("open", false);
      setLeftViewMode("chat");
    }
    saveAdvisor(state => switchAdvisorJob(state, job));
    setActiveDiffProposalId(null);
    setShowGapsSummary(false);
    setProposalFilter("all");
  }, [job, saveAdvisor, saveInterviewField]);

  const extractUrlFromText = extractJobLink;

  type SampleJobPreset = {
    id: string;
    chip: string;
    title: string;
    company: string;
    salary: string;
    location: string;
    description: string;
  };

  const SAMPLE_JOBS: SampleJobPreset[] = [
    {
      id: "frontend",
      chip: t("前端 / 全栈", "Frontend / Full-stack"),
      title: "资深前端/全栈架构师",
      company: "某知名高科技企业",
      salary: "35k-50k · 16薪",
      location: "上海 / 远程",
      description: `岗位职责：\n1. 负责核心业务中台与高并发系统架构演进，主导微前端与组件库技术标准落地；\n2. 推进系统性能治理与工程化建设，首屏性能与交互流畅度达到行业领先水平；\n3. 协同后端与产品团队，落地多端一体化与自动化测试流程，保障系统 99.99% 高可用；\n4. 深度探索前沿 AI Agent 与大语言模型在研发流程及产品功能中的结合与落地。\n\n任职要求：\n1. 本科及以上学历，5年以上现代前端或全栈工程经验，有大型分布式/高流量系统经验；\n2. 熟练掌握 React / TypeScript / Node.js 等核心栈，具备优秀的系统架构设计与抽象能力；\n3. 具备扎实的工程化与性能调优功底，有实际性能指标量化突破经验者优先；\n4. 优秀的沟通协调、跨团队推动能力与自驱攻坚精神。`,
    },
    {
      id: "backend",
      chip: t("后端 / 云原生", "Backend / Cloud"),
      title: "资深后端开发工程师",
      company: "某互联网平台",
      salary: "30k-45k · 15薪",
      location: "北京 / 深圳",
      description: `岗位职责：\n1. 负责核心交易与中台服务设计与演进，保障高可用与可观测；\n2. 主导 Go / 云原生技术栈落地，优化容量与延迟；\n3. 协同前端与 SRE 完善发布与故障演练。\n\n任职要求：\n1. 本科及以上，5 年及以上后端经验；\n2. 熟练掌握 Go 或 Java，熟悉 Kubernetes 与微服务；\n3. 有高并发或分布式系统落地经验优先。`,
    },
    {
      id: "ai",
      chip: t("AI 应用全栈", "AI Full-stack"),
      title: "AI 应用全栈工程师",
      company: "某 AI 产品公司",
      salary: "40k-65k · 16薪",
      location: "杭州 / 远程",
      description: `岗位职责：\n1. 将 Agent / LLM 能力接入产品与内部工具；\n2. 负责前后端一体交付与评测链路；\n3. 跟进模型成本、延迟与质量指标。\n\n任职要求：\n1. 熟悉 TypeScript 与至少一种后端语言；\n2. 有 Prompt / Agent 或 RAG 落地经验；\n3. 关注事实核验与可追溯输出。`,
    },
  ];

  function loadSampleJob(preset: SampleJobPreset) {
    setMobilePane("material");
    cancelIntake();
    saveAdvisor(previous => ({
      ...previous, ...advisorJobDraft(preset), isEditingJob: previous.isEditingJob,
      beforeBrowserImport: previous.beforeBrowserImport,
    }));
  }

  const commitParsedFields = (parsed: ParsedJobInfo, fallbackUrl?: string) => {
    saveAdvisor(previous => ({
      ...previous, ...advisorJobDraft({ ...parsed, sourceUrl: parsed.sourceUrl || fallbackUrl }),
      linkInputValue: previous.linkInputValue, isEditingJob: previous.isEditingJob,
      beforeBrowserImport: previous.beforeBrowserImport,
    }));
  };

  const handleExtractLink = async (overrideInput?: string, forceMode?: "static" | "browser" | "auto-browser", authorizeModel=false) => {
    const raw = overrideInput ?? linkInputValue;
    if (!raw.trim()) {
      setLinkError(t("请输入或粘贴岗位链接 / 招聘分享文字", "Please enter a job link or share message"));
      return;
    }

    setIsExtractingLink(true);
    setExtractingStepMessage(null);
    setLinkError(null);
    setLinkSuccessNotice(null);

    // If input is a short relative path like job/..., normalize it
    const normalizedUrl = extractUrlFromText(raw);
    const inputToProcess = raw.length < 300 && normalizedUrl ? normalizedUrl : raw;

    const controller = new AbortController();
    intakeObserver.current?.abort();intakeObserver.current=controller;const version=++intakeVersion.current;
    setIntakeTask(undefined);setIntakeBase(undefined);setIntakeResumeConsent(false);
    try {
      let parsed: ParsedJobInfo;
      if (forceMode === "auto-browser") {
        setExtractingStepMessage(t("🤖 正在启动自动化浏览器加载岗位...若遇安全验证请协助滑动，系统将自动读取！", "Automated browser active... If captcha appears, complete it and system will auto-read!"));
        parsed = await extractAndParseJobLink(inputToProcess, {
          signal: controller.signal,
          mode: "auto-browser",
        });
      } else {
        try {
          parsed = await extractAndParseJobLink(inputToProcess, {
            signal: controller.signal,
            mode: "static",
          });
        } catch {
          if (version !== intakeVersion.current || controller.signal.aborted) return;
          // If static extraction encounters network/anti-bot errors, auto-fallback to local automated browser engine
          setExtractingStepMessage(t("🤖 已启动自动化浏览器接续抓取...若出现滑块验证，请在浏览器中拖动完成，系统将自动继续！", "Automated browser active... If captcha slider appears, please complete it; system will auto-resume!"));
          parsed = await extractAndParseJobLink(inputToProcess, {
            signal: controller.signal,
            mode: "auto-browser",
          });
        }
      }

      if(version!==intakeVersion.current)return;
      if(authorizeModel){
        taskRuntime.assertSelected();setIntakeBase(parsed);
        const task=await defaultJdIntakeTaskClient.generate({workspaceKey:`metadata:${workspaceKey}`,rootScopeKey:agent?.workspaceKey??workspaceKey,
          request:{mode:"metadata",text:parsed.sourceText??parsed.description,...(parsed.sourceUrl?{sourceUrl:parsed.sourceUrl}:{})},
          runtime:taskRuntime.runtime,preferredRuntimeId:taskRuntime.preferredRuntimeId,consent:true,signal:controller.signal,
          onTask:next=>{if(version===intakeVersion.current)setIntakeTask(next);},
        });
        taskRuntime.assertSelected();if(version!==intakeVersion.current)return;
        parsed=applyJdMetadata(parsed,task.result!);
      }

      commitParsedFields(parsed, normalizedUrl || undefined);

      setLinkSuccessNotice(
        t(
          `已成功提取并填入：${parsed.company} · ${parsed.title}`,
          `Extracted and filled: ${parsed.company} · ${parsed.title}`
        )
      );

      triggerAgentGuide({
        actionType: "focus",
        label: `已自动填入目标岗位「${parsed.title}」信息`,
        text: parsed.title,
      });

      if(!authorizeModel)setTimeout(() => {
        if(version!==intakeVersion.current)return;
        setIsLinkInputOpen(false);setLinkSuccessNotice(null);
      }, 2500);
    } catch (err) {
      if(version!==intakeVersion.current||controller.signal.aborted)return;
      const msg =
        err instanceof Error
          ? err.message
          : t("未能成功读取岗位链接，请检查网络或直接粘贴 JD 正文", "Failed to extract job link");
      setLinkError(msg);
    } finally {
      if(version===intakeVersion.current){setIsExtractingLink(false);setExtractingStepMessage(null);}
    }
  };

  const resumeMetadata=async()=>{
    if(!intakeTask||!intakeBase||!intakeResumeConsent)return;
    const original=intakeTask,base=intakeBase,version=++intakeVersion.current,controller=new AbortController();intakeObserver.current?.abort();intakeObserver.current=controller;
    setIntakeResumeConsent(false);setIsExtractingLink(true);setLinkError(null);
    try{
      taskRuntime.assertSelected();
      const task=await defaultJdIntakeTaskClient.generate({workspaceKey:`metadata:${workspaceKey}`,rootScopeKey:agent?.workspaceKey??workspaceKey,request:original.request,
        runtime:taskRuntime.runtime,preferredRuntimeId:taskRuntime.preferredRuntimeId,consent:true,resumeTaskId:original.id,signal:controller.signal,
        onTask:next=>{if(version===intakeVersion.current)setIntakeTask(next);},
      });
      taskRuntime.assertSelected();if(version!==intakeVersion.current)return;
      commitParsedFields(applyJdMetadata(base,task.result!));setLinkSuccessNotice(t("原任务已返回可核对字段，请审阅表单。", "The original task returned source-backed fields. Review the form."));
    }catch(failure){if(version===intakeVersion.current&&!controller.signal.aborted)setLinkError(failure instanceof Error?failure.message:"模型提取未完成，原任务保留。");}
    finally{if(version===intakeVersion.current)setIsExtractingLink(false);}
  };

  const handlePasteClipboard = async () => {
    const version = intakeVersion.current;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text && version === intakeVersion.current) {
          cancelIntake();
          setLinkInputValue(text);
        }
      }
    } catch {
      // Ignore clipboard permission or support error
    }
  };

  const handlePasteClipboardAndExtract = async () => {
    const version = intakeVersion.current;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text?.trim() && version === intakeVersion.current) {
          setLinkInputValue(text.slice(0, 300));
          await handleExtractLink(text);
        }
      }
    } catch {
      // Ignore clipboard permission or support error
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    if (leftViewMode !== "jd") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, leftViewMode]);

  // Only an explicitly labeled user action grants this frozen JD + resume projection.
  // Mount, navigation and history restoration never dispatch analysis.
  const runMatching = async (targetJob: DrawerJobContext) => {
    const scope = advisorMatchKey(targetJob, resume, documentKey);
    if (!active || !scope || pendingMatches.current.has(scope)) return;
    const controller = new AbortController();
    pendingMatches.current.set(scope, controller);
    setLoadingMatches(previous => ({ ...previous, [scope]: true }));
    setMatchErrors(previous => ({ ...previous, [scope]: "" }));
    try {
      if (chatRouting?.blocked) throw new Error("底座状态尚未确认；未使用旧 API 配置补发。");
      taskRuntime.assertSelected();
      const rootScopeKey = agent?.workspaceKey ?? workspaceKey;
      const result = await startJdMatch({
        threadId: "explicit-jd-analysis", workspaceKey: `${rootScopeKey}:advisor:${scope}`, rootScopeKey,
        rawJd: targetJob.description, ...jdMatchResumeMaterial(resume), llmConfig, consent: true,
        runtime: taskRuntime.runtime, preferredRuntimeId: taskRuntime.preferredRuntimeId, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      taskRuntime.assertSelected();
      updateMatch(scope, previous => ({
        ...emptyAdvisorMatch, threadId: result.threadId, proposals: result.proposals, structuredJd: result.structuredJd ?? null,
        ...(previous.threadId === result.threadId ? {
          decisions: previous.decisions, editedText: previous.editedText, editingProposalId: previous.editingProposalId,
        } : {}),
      }));
    } catch (error) {
      if (!controller.signal.aborted) {
        const notice = error instanceof Error ? error.message : t("岗位分析未完成，原任务记录与用量保留。", "Analysis not completed; task history and usage retained.");
        setMatchErrors(previous => ({ ...previous, [scope]: notice }));
      }
    } finally {
      if (pendingMatches.current.get(scope) === controller) {
        pendingMatches.current.delete(scope);
        setLoadingMatches(previous => ({ ...previous, [scope]: false }));
      }
    }
  };

  const handleDecision = (proposalId: string, status: "accepted" | "rejected") => {
    updateMatch(matchKey, previous => ({
      ...previous, decisions: { ...previous.decisions, [proposalId]: { status } },
    }));

    if (status === "accepted") {
      const prop = proposals.find((p) => p.id === proposalId);
      if (prop) {
        triggerAgentGuide({
          claimId: prop.profileEntryId,
          text: prop.suggestion,
          label: t("✨ 已采纳此条建议", "✨ Accepted suggestion"),
          actionType: "applied",
        });
      }
    }
  };

  const handleSubmitJobSetup = () => {
    if (!inputDescription.trim() || loading) return;
    if (isJdLinkOnly(inputDescription)) {
      setIsLinkInputOpen(true); setLinkInputValue(inputDescription);
      void handleExtractLink(inputDescription); return;
    }
    const newJob: DrawerJobContext = {
      title: inputTitle.trim() || t("目标职位", "Target Position"),
      company: inputCompany.trim() || t("目标企业", "Target Company"),
      salary: inputSalary.trim() || undefined,
      location: inputLocation.trim() || undefined,
      description: inputDescription.trim(),
      sourceUrl,
      sourcePlatform,
    };
    cancelIntake();
    if (advisorJobKey(newJob) !== jobKey) leaveJobConversation();
    saveAdvisor(previous => ({
      ...switchAdvisorConversation(previous, newJob), ...advisorJobDraft(newJob),
      currentJob: newJob, beforeBrowserImport: previous.beforeBrowserImport,
    }));
    void runMatching(newJob);
  };

  const handleCancelJobEdit = () => {
    cancelIntake();
    saveAdvisor(previous => ({ ...previous, ...advisorJobDraft(previous.currentJob), beforeBrowserImport: previous.beforeBrowserImport }));
    setIsLinkInputOpen(false);
  };

  const handleOpenJobEdit = () => {
    setIsEditingJob(true);
    showLeftPage("jd");
  };

  const startEdit = (proposal: MatchProposal) => {
    const current = decisions[proposal.id];
    updateMatch(matchKey, previous => ({
      ...previous, editingProposalId: proposal.id,
      editedText: current && current.status === "edited" ? current.editedSuggestion : proposal.suggestion,
    }));
  };

  const saveEdit = (proposalId: string) => {
    if (!editedText.trim()) return;
    updateMatch(matchKey, previous => ({
      ...previous, decisions: { ...previous.decisions, [proposalId]: { status: "edited", editedSuggestion: editedText.trim() } },
      editingProposalId: null,
    }));

    const prop = proposals.find((p) => p.id === proposalId);
    triggerAgentGuide({
      claimId: prop?.profileEntryId,
      text: editedText.trim(),
      label: t("✏️ 已保存自定义修改", "✏️ Saved custom edit"),
      actionType: "applied",
    });
  };

  const cancelEdit = () => {
    updateMatch(matchKey, previous => ({ ...previous, editingProposalId: null }));
  };

  const handleChatImageSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (chatImageRead.current) {
      setAttachmentError(t("正在读取上一批图片；本批未附加，请稍后重新选择。", "The previous images are still being read. This batch was not attached; choose it again shortly."));
      return;
    }
    setAttachmentError(null);
    const room = Math.max(0, MAX_CHAT_IMAGES - pendingAttachments.length);
    if (files.length > room) {
      setAttachmentError(t("一条消息最多附加 3 张图片；本批未附加，请重新选择。", "Up to 3 images per message. This batch was not attached; choose it again."));
      return;
    }
    chatImageRead.current = true;
    setReadingChatImages(true);
    try {
      const prepared = await Promise.all(files.map(readChatImage));
      if (liveContext.current.mounted && liveContext.current.jobKey === jobKey) setPendingAttachments((previous) => [...previous, ...prepared]);
    } catch (error) {
      if (liveContext.current.mounted && liveContext.current.jobKey === jobKey) setAttachmentError(chatImageErrorMessage(error, t));
    } finally { chatImageRead.current = false; setReadingChatImages(false); }
  };

  // Chat message submission
  const handleSendMessage = async (customText?: string) => {
    if (chatImageRead.current) { setAttachmentError(t("图片尚未读取完成，本轮未发送。", "Images are still being read. Nothing was sent.")); return; }
    const selectedAttachments = customText ? [] : pendingAttachments;
    if (selectedAttachments.length && taskRuntime.runtime.kind === "chatgpt") {
      setAttachmentError("当前 ChatGPT 账号任务只支持文字；图片仍保留，本轮未发送。"); return;
    }
    if (selectedAttachments.length && imageCapability === "unsupported") {
      setAttachmentError(modelImageCapabilityDescription(imageCapability, t));
      return;
    }
    const selectedReferences = pendingReferences;
    const typedText = customText ?? inputMessage;
    const textToSend = typedText.trim() ? typedText : (selectedAttachments.length ? t("请帮我分析这张图片。", "Please analyze the attached image.") : selectedReferences.length ? t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text.") : "");
    if ((!textToSend && selectedAttachments.length === 0 && selectedReferences.length === 0) || chatLoading || chatAbortRef.current) return;

    if (leftViewMode === "jd") {
      showLeftPage("chat");
    }

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content: textToSend,
      ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
      ...(selectedReferences.length ? { references: selectedReferences } : {}),
      createdAt: new Date().toISOString(),
    };

    if (careerTaskConfig && isCareerTailoringRequest(textToSend)) {
      openCareerTask(textToSend);
      setMessages(prev => [...prev, userMsg, { id: `task-consent-${Date.now()}`, role: "assistant", content: t("已打开岗位定制任务。请先确认底座、材料范围和预算；尚未发送模型请求，也未保存或投递。", "The tailoring task is ready for your runtime, material and budget consent. No model request, save or submission has occurred.") }]);
      if (!customText) setInputMessage("");
      return;
    }

    const controller = new AbortController();
    chatAbortRef.current = controller;
    kernelChatId.current=undefined;
    pendingChatRef.current = userMsg;
    recovery.field("pendingChatId", userMsg.id);
    setMessages((prev) => [...prev, userMsg]);
    if (!customText) {
      setInputMessage("");
      setPendingAttachments([]);
      setPendingReferences([]);
      setAttachmentError(null);
    }
    setChatLoading(true);
    setChatNotice("");

    try {
      if(chatRouting?.blocked)throw new Error("底座状态尚未确认；未使用旧 API 配置补发。");
      taskRuntime.assertSelected();
      const reply = await sendChat({
        workspaceKey:`advisor:${workspaceKey}:${jobKey}`,
        rootScopeKey:agent?.workspaceKey??workspaceKey,
        runtime:taskRuntime.runtime,preferredRuntimeId:taskRuntime.preferredRuntimeId,
        onTask: task => { if (chatAbortRef.current === controller) kernelChatId.current = task.id; },
        messages: chatMessagesForRequest([...messages, userMsg]),
        llmConfig,
        signal: controller.signal,
        context: {
          currentJob: currentJob
            ? {
                title: currentJob.title,
                company: currentJob.company,
                location: currentJob.location,
                description: currentJob.description,
              }
            : undefined,
          resumeEditContext: shareResumeForEditing ? resumeEditContext : undefined,
        },
      });
      if (controller.signal.aborted || chatAbortRef.current !== controller) return;
      taskRuntime.assertSelected();
      setMessages((prev) => [...prev, reply]);
      pendingChatRef.current = null;
      recovery.field("pendingChatId", undefined);
    } catch (err) {
      if (controller.signal.aborted || chatAbortRef.current !== controller) return;
      const errorMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: "assistant",
        content: err instanceof Error ? `⚠️ ${err.message}` : t("抱歉，对话服务出现异常，请检查 AI 配置。", "Sorry, chat service failed. Check AI configuration."),
      };
      setMessages((prev) => [...prev, errorMsg]);
      pendingChatRef.current = null;
      recovery.field("pendingChatId", undefined);
    } finally {
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
        setChatLoading(false);
      }
    }
  };

  const handleStopChat = () => {
    const controller = chatAbortRef.current;
    if (!controller) return;
    chatAbortRef.current = null;
    controller.abort();
    if(kernelChatId.current)void pauseAgentChatTask(kernelChatId.current).catch(error=>setChatNotice(error instanceof Error?error.message:"停止结果尚未确认，请读取任务。"));
    const pending = pendingChatRef.current;
    pendingChatRef.current = null;
    recovery.field("pendingChatId", undefined);
    if (pending) {
      setMessages((current) => current.filter((message) => message.id !== pending.id));
      setInputMessage((current) => current.trim() ? current : pending.content);
      setPendingReferences((current) => current.length ? current : pending.references ?? []);
      setPendingAttachments((current) => current.length ? current : pending.attachments ?? []);
    }
    setChatNotice(t("已停止。修改问题后可以重新发送。", "Stopped. Edit your question and send it again."));
    setChatLoading(false);
    queueMicrotask(() => chatComposerRef.current?.focus());
  };

  // Copy helper
  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Multi-step Guided Application Flow
  const handleApply = async () => {
    if (!active || !matchKey || isApplying || loading || pendingReviews.current.has(matchKey)) return;
    const reviewedContext = liveContext.current;
    if (careerTaskConfig) {
      openCareerTask(t("针对当前岗位准备定制简历，先查证再提交逐句差异与待确认项。", "Prepare a tailored resume for this job with evidence, per-sentence changes and unknowns."));
      return;
    }
    const acceptedList: MatchProposal[] = proposals
      .filter((p) => {
        const d = decisions[p.id];
        return d?.status === "accepted" || d?.status === "edited";
      })
      .map((p) => {
        const d = decisions[p.id];
        if (d?.status === "edited") {
          return { ...p, suggestion: d.editedSuggestion };
        }
        return p;
      });

    if (acceptedList.length === 0) return;

    const company = currentJob?.company || job?.company || t("目标公司", "Target Company");
    const title = currentJob?.title || job?.title || t("岗位", "Job");
    const customResumeName = `${company} · ${title} 定制版`;

    if(/^ct_[a-f0-9]{32}$/.test(threadId)){
      pendingReviews.current.add(matchKey);
      setApplyingMatchKey(matchKey);
      try{await resumeJdMatch({threadId,decisions,currentProposals:proposals,llmConfig,matching:{rawJd:currentJob?.description??"",...jdMatchResumeMaterial(resume)}});}
      catch(error){
        if (liveContext.current.mounted) {
          setErrorNotice(error instanceof Error ? error.message : "任务选择未确认，未应用。");
          setApplyingMatchKey(current => current === matchKey ? undefined : current);
        }
        return;
      } finally {
        pendingReviews.current.delete(matchKey);
      }
    }
    if (!liveContext.current.mounted) return;
    if (liveContext.current !== reviewedContext) {
      setApplyingMatchKey(current => current === matchKey ? undefined : current);
      return;
    }
    // Workspace owns the business write, after the exact source and review gate.
    onApplyToResume({
      acceptedProposals: acceptedList,
      customResumeName,
      targetJobTitle: title,
      targetCompany: company,
    });

    setApplyingMatchKey(matchKey);
    setApplyStep(1);
    for (const timer of applyTimers.current) clearTimeout(timer);
    applyTimers.current.push(setTimeout(() => { if (liveContext.current.matchKey === matchKey) setApplyStep(2); }, 400),
      setTimeout(() => { if (liveContext.current.matchKey === matchKey) setApplyStep(3); }, 800),
      setTimeout(() => {
      applyTimers.current.length = 0;
      setApplyingMatchKey(current => current === matchKey ? undefined : current);
      if (liveContext.current.matchKey !== matchKey) return;
      const firstEntryId = acceptedList.find((p) => p.profileEntryId)?.profileEntryId;
      if (firstEntryId) {
        triggerAgentGuide({
          claimId: firstEntryId,
          label: t("🎯 已基于岗位 JD 完成定制更新", "🎯 Customized based on target JD"),
          actionType: "applied",
        });
      }
    }, 1200));
  };

  // Counts and metrics
  const stats = useMemo(() => {
    const list = Array.isArray(proposals) ? proposals : [];
    const verified = list.filter((p) => p.evidenceType === "verified").length;
    const claimed = list.filter((p) => p.evidenceType === "claimed").length;
    const gaps = list.filter((p) => p.evidenceType === "gap").length;
    const total = list.length;
    const score = total > 0 ? Math.round(((verified * 1.0 + claimed * 0.7) / total) * 100) : 0;

    const acceptedCount = list.filter((p) => {
      const d = decisions[p.id];
      return d?.status === "accepted" || d?.status === "edited";
    }).length;

    const pendingCount = list.filter((p) => {
      const s = decisions[p.id]?.status;
      return s !== "accepted" && s !== "edited" && s !== "rejected";
    }).length;
    const rejectedCount = list.filter((p) => decisions[p.id]?.status === "rejected").length;

    return { verified, claimed, gaps, total, score, acceptedCount, pendingCount, rejectedCount };
  }, [proposals, decisions]);

  const gapProposals = useMemo(() => (Array.isArray(proposals) ? proposals : []).filter((p) => p.evidenceType === "gap"), [proposals]);

  const filteredProposals = useMemo(() => {
    if (proposalFilter === "all") return proposals;
    if (proposalFilter === "accepted") {
      return proposals.filter((p) => decisions[p.id]?.status === "accepted" || decisions[p.id]?.status === "edited");
    }
    if (proposalFilter === "pending") {
      return proposals.filter((p) => {
        const s = decisions[p.id]?.status;
        return s !== "accepted" && s !== "edited" && s !== "rejected";
      });
    }
    if (proposalFilter === "rejected") {
      return proposals.filter((p) => decisions[p.id]?.status === "rejected");
    }
    return proposals;
  }, [proposals, decisions, proposalFilter]);

  // Find claim text helper for diff preview
  const getClaimText = (claimId?: string) => {
    if (!claimId || !resume) return null;
    for (const exp of resume.experiences) {
      const found = exp.claims.find((c) => c.id === claimId);
      if (found) return found.text;
    }
    return null;
  };

  // Structured JD sections
  const displayResponsibilities = useMemo(() => {
    if (structuredJd?.responsibilities && structuredJd.responsibilities.length > 0) {
      return structuredJd.responsibilities;
    }
    if (!currentJob?.description) return [];
    const lines = currentJob.description.split("\n").map((l) => l.trim()).filter(Boolean);
    const inResp = lines.filter((l) => /职责|工作内容|主导|负责|推进/i.test(l) && !/^https?:\/\//i.test(l));
    return inResp.length > 0 ? inResp.slice(0, 5) : lines.slice(0, 4);
  }, [structuredJd, currentJob?.description]);

  const displayQualifications = useMemo(() => {
    if (structuredJd?.qualifications && structuredJd.qualifications.length > 0) {
      return structuredJd.qualifications;
    }
    if (!currentJob?.description) return [];
    const lines = currentJob.description.split("\n").map((l) => l.trim()).filter(Boolean);
    const inQual = lines.filter((l) => /要求|任职资格|技能|学历|经验|具备/i.test(l) && !/^https?:\/\//i.test(l));
    return inQual.length > 0 ? inQual.slice(0, 5) : lines.slice(3, 8);
  }, [structuredJd, currentJob?.description]);

  // Opening growth is not a submission to the legacy matching flow. Make the
  // user's JD draft available there, still behind its separate sharing consent.
  const careerCoachJob = useMemo<DrawerJobContext | null>(() => {
    if (!isSetupMode) return currentJob;
    const description = inputDescription.trim();
    if (!description || isJdLinkOnly(description)) return null;
    return {
      title: inputTitle.trim() || t("目标职位", "Target Position"),
      company: inputCompany.trim() || t("目标企业", "Target Company"),
      description,
      salary: inputSalary.trim() || undefined,
      location: inputLocation.trim() || undefined,
      sourceUrl, sourcePlatform,
    };
  }, [currentJob, isSetupMode, inputDescription, inputTitle, inputCompany, inputSalary, inputLocation, sourceUrl, sourcePlatform, t]);
  const linkableRequirements = useMemo(() => {
    const byQuote = new Map<string, string | undefined>();
    if (careerCoachJob?.description && careerCoachJob.description.length <= 30_000) {
      for (const item of careerTrainingRequirements(careerCoachJob)) {
        byQuote.set(item.originalQuote, byQuote.has(item.originalQuote) ? undefined : item.id);
      }
    }
    return byQuote;
  }, [careerCoachJob]);
  function linkRequirement(quote: string, itemId?: string) {
    if (!careerCoachJob || !linkableRequirements.has(quote)) return;
    interviewRecovery.field("open", false);
    setShowCareerTask(false);
    setTaskView("learning");
    setShowCareerCoach(true);
    setCoachRequest(previous => ({
      mode: "plan", id: (previous?.id ?? 0) + 1,
      trainingRequirement: { quote, itemId: itemId ?? linkableRequirements.get(quote), snapshotVersion: careerJobSnapshotVersion(careerCoachJob) },
    }));
  }

  const evidencePanel = evidenceWorkspace && careerCoachJob && linkableRequirements.size > 0
    ? <RequirementEvidencePanel job={careerCoachJob} workspace={evidenceWorkspace} onTrain={linkRequirement}/> : null;

  function openCareerTask(objective?:string){
    if(sidebar){sidebar.requestTask({job:careerCoachJob,objective});return;}
    if(objective)setTaskObjective(objective);setShowCareerTask(true);setShowCareerCoach(false);
  }

  // Circumference for radial progress gauge

  const defenseOptions=useMemo(()=>currentJob?.description&&resume?alignJdWithResume(decomposeJdText(currentJob.description,{title:currentJob.title,company:currentJob.company,location:currentJob.location}),resume).interviewDefenses:[],[currentJob,resume]);
  const startDefense=async(defense:InterviewDefenseStrategy)=>{
    if(!currentJob?.description||!resume)return;
    try{
      const selection=await createInterviewSelection({matching:{rawJd:currentJob.description,...jdMatchResumeMaterial(resume)},focus:{question:defense.question,gapItem:defense.targetTopic,corePoints:[defense.coreDefenseStrategy,...defense.suggestedAnswerFramework]}});
      if (liveContext.current.mounted && liveContext.current.matchKey === matchKey) interviewRecovery.set({selection,open:true});
    }catch(error){setErrorNotice(error instanceof Error?error.message:"无法打开对练，未发送资料。");}
  };
  useEffect(()=>{
    const openInterview=(event:Event)=>{
      const request=InterviewLaunchSchema.safeParse((event as CustomEvent).detail);
      if(!request.success||request.data.workspaceKey!==interviewWorkspaceKey||interviewStorageError)return;
      if(!isInterviewSelectionCurrent(request.data.selection,resume))return;
      saveInterview({selection:request.data.selection,open:true});event.preventDefault();onActivate?.();
    };
    window.addEventListener(interviewLaunchEvent,openInterview);
    return ()=>window.removeEventListener(interviewLaunchEvent,openInterview);
  },[interviewWorkspaceKey,interviewStorageError,saveInterview,resume,onActivate]);

  const careerCoachPanel = (showCareerCoach || careerCoachInitialized) && (
    <section className="career-coach-shell" hidden={!showCareerCoach} style={{ display: showCareerCoach ? undefined : "none" }}>
      {<CareerCoachWorkspace embedded onOpenResume={onNavigateToResume} key={workspaceKey} modeRequest={coachRequest} onModeChange={mode => { if (showCareerCoach) setTaskView(mode === "resume" ? "resume" : mode === "analysis" ? "career" : mode === "plan" || mode === "review" ? "learning" : "practice"); }} workspaceKey={workspaceKey} job={careerCoachJob}
        resumeEditContext={resumeEditContext} llmConfig={llmConfig} onOpenConfig={onOpenConfig}
        onApplyResumeProposal={onApplyResumeProposal} />}
    </section>
  );

  return (
    <div className="advisor-workspace">
    {interviewRecovery.value.open&&interviewRecovery.value.selection&&<MockInterviewPanel key={privateKey(interviewRecovery.value.selection.id)} workspaceKey={interviewWorkspaceKey} selection={interviewRecovery.value.selection} resume={resume} llmConfig={llmConfig} blockingError={interviewRecovery.error} onClose={()=>interviewRecovery.field("open",false)} onOpenConfig={onOpenConfig}/>}
    <div hidden={interviewRecovery.value.open} style={{display:interviewRecovery.value.open?"none":"contents"}}>
    {interviewRecovery.error&&<WorkspaceRecoveryNotice {...interviewRecovery}/>}
    {(recovery.error || (!showCareerCoach && taskView !== "handoff")) && <WorkspaceRecoveryNotice {...recovery} />}
    <AgentTaskNavigation onOpenArea={onOpenArea} onTailor={careerTaskConfig ? () => openCareerTask() : undefined} tailoring={sidebar ? sidebar.open && sidebar.conversation === "task" : showCareerTask} onBack={onNavigateToResume} onEdit={currentJob?.description && !isEditingJob ? handleOpenJobEdit : undefined} needsConfig={!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama"} onConfig={onOpenConfig} active={showCareerCoach ? (taskView === "job" ? "career" : taskView) : taskView} onSelect={selectTask} jobTitle={currentJob ? `${currentJob.company} · ${currentJob.title}` : undefined} />
    {taskView === "job" && !showCareerTask && (browserJob || beforeBrowserImport || hasUnassignedDraft) && (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs" aria-live="polite">
        {browserJob && <>
          <span>{t("浏览器推送", "From browser")} · {browserJob.company} · {browserJob.title}</span>
          <button type="button" className="studio-button" onClick={importBrowserJob}>{t("导入岗位", "Import job")}</button>
        </>}
        {beforeBrowserImport && <button type="button" className="studio-button" onClick={restoreBrowserDraft}>{t("恢复导入前草稿", "Restore pre-import draft")}</button>}
        {hasUnassignedDraft && <button type="button" className="studio-button" onClick={restoreUnassignedDraft}>{t("恢复未关联草稿", "Return to unassigned draft")}</button>}
      </div>
    )}
    {interviewRecovery.value.selection&&<button type="button" className="studio-button" onClick={()=>interviewRecovery.field("open",true)}>{t("回到对练会话", "Return to interview practice")}</button>}
    {defenseOptions.length>0&&!showCareerCoach&&<details className="mock-interview-topics"><summary>{t("面试攻防 · 选择题目开始对练", "Interview practice · Choose a question")}</summary>{defenseOptions.map(defense=><article key={defense.id}><strong>{defense.targetTopic}</strong><p>{defense.question}</p><button type="button" disabled={Boolean(interviewRecovery.error)} onClick={()=>void startDefense(defense)}>{t("与 AI 顾问对练这道题", "Practice this question with the AI advisor")}</button></article>)}</details>}
    <div hidden={showCareerTask} style={{ display: showCareerTask ? "none" : "contents" }}>{careerCoachPanel}</div>
    {careerTaskConfig && showCareerTask && <CareerTaskPanel {...careerTaskConfig} job={careerCoachJob ?? undefined} resumeFields={resumeEditContext} llmConfig={llmConfig} initialObjective={taskObjective} />}
    <div hidden={taskView !== "handoff" || showCareerTask} style={{ display: taskView === "handoff" && !showCareerTask ? "flex" : "none", flex: 1, minHeight: 0 }}><AgentExternalHandoff workspaceKey={workspaceKey} job={currentJob} /></div>
    <section
      style={{ display: showCareerTask || showCareerCoach || taskView === "handoff" ? "none" : undefined }}
      className={`advisor-job-panel w-full h-full flex flex-col min-h-0 overflow-hidden font-sans transition-colors duration-200 ${
        isDark ? "bg-[var(--ui-canvas,#1a1a1f)] text-[var(--ui-text,#edeef4)]" : "bg-slate-100/90 text-slate-900"
      }`}
    >
      {/* ── Top Workspace Bar ────────────────────────────────────────────── */}

      {showRightPane && <nav className="advisor-pane-switch" aria-label={t("内容视图", "Content view")}><button type="button" aria-pressed={mobilePane === "material"} onClick={() => setMobilePane("material")}>{t("材料与对话", "Materials & chat")}</button><button type="button" aria-pressed={mobilePane === "result"} onClick={() => setMobilePane("result")}>{isSetupMode ? t("来源与摘要", "Source & summary") : t("分析结果", "Analysis results")}</button></nav>}
      {/* ── Main Dual-Pane Content Area (With Draggable Splitter) ── */}
      <div
        ref={splitContainerRef}
        data-pane={mobilePane}
        data-dual={showRightPane}
        style={{ "--advisor-left": `${displaySplitPercent}%` } as React.CSSProperties}
        className={`advisor-panes flex-1 w-full min-h-0 p-4 md:p-5 flex flex-col lg:flex-row gap-0 overflow-hidden relative ${
          isDraggingSplitter ? "select-none cursor-col-resize" : ""
        }`}
      >
        {/* ── LEFT PANE: Complete Job Profile (JD) & Copilot ── */}
        <div
          style={{ width: typeof window !== "undefined" && window.innerWidth >= 1024 && showRightPane ? `calc(${splitPercent}% - 8px)` : "100%" }}
          className={`flex-1 lg:flex-none flex flex-col min-h-0 min-w-[340px] rounded-3xl border shadow-md overflow-hidden ${isDraggingSplitter ? "" : "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"} ${
            isDark
              ? "bg-[var(--ui-surface,#27282f)] border-[var(--ui-border,#484b58)] shadow-xl"
              : "bg-white border-slate-200/90 shadow-sm"
          }`}
        >
          {(isEditingJob || (!currentJob?.description && !(leftViewMode === "chat" && (pendingReferences.length > 0 || messages.length > 0)))) ? (
            /* ── VIEW 1: Dedicated Job Setup & Link Extraction Screen (Full Left Pane Height) ── */
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {/* Setup View Top Header */}
              <div
                className={`px-4 py-3 border-b shrink-0 flex items-center justify-between gap-3 ${
                  isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-200"
                }`}
              >
                <div className="min-w-0">
                  <h3 className={`text-sm font-semibold truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                    {isEditingJob ? t("编辑目标岗位", "Edit target role") : t("目标岗位", "Target role")}
                  </h3>
                  <p className={`text-[11px] mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {t("粘贴招聘链接或 JD 原文", "Paste a job link or description")}
                  </p>
                </div>
                {isEditingJob && currentJob?.description ? (
                  <button
                    type="button"
                    onClick={handleCancelJobEdit}
                    className={`text-[11px] px-2.5 py-1.5 rounded-lg border cursor-pointer transition shrink-0 ${
                      isDark
                        ? "text-[var(--ui-text-muted,#a7adbd)] hover:text-white border-[var(--ui-border,#484b58)]"
                        : "text-slate-600 hover:text-slate-900 border-slate-200 bg-white"
                    }`}
                  >
                    {t("取消修改", "Cancel")}
                  </button>
                ) : null}
              </div>

              {/* Scrollable Form Body */}
              <div className="flex-1 min-h-0 overflow-y-auto agent-custom-scrollbar p-5 space-y-4">
                {/* Full JD Textarea */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                      {t("岗位完整 JD 文本 (必填)", "Job Description (Required)")}
                    </label>
                    <div className="flex items-center gap-2 text-[10px]">
                      {inputDescription.trim().length > 0 && (
                        <span className={isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}>
                          {inputDescription.trim().length} {t("字符", "chars")}
                        </span>
                      )}
                      {sourcePlatform && (
                        <span className={`font-medium px-2 py-0.5 rounded border ${
                          isDark ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" : "bg-emerald-50 text-emerald-700 border-emerald-200"
                        }`}>
                          {sourcePlatform} {sourceUrl ? "· 已关联链接" : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  {isJdLinkOnly(inputDescription) && (
                    <div className={`flex items-center justify-between p-3 rounded-2xl text-xs border mb-2.5 shadow-xs ${
                      isDark ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    }`}>
                      <span className="flex items-center gap-2">
                        <Sparkles size={14} className="text-emerald-500 shrink-0" />
                        <span className="font-medium">{t("检测到您粘贴了招聘链接，是否一键解析所有字段？", "Detected a job link. Extract all fields?")}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setLinkInputValue(inputDescription);
                          setIsLinkInputOpen(true);
                          void handleExtractLink(inputDescription);
                        }}
                        disabled={isExtractingLink}
                        className="agent-btn-press px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition cursor-pointer shadow-xs"
                      >
                        {isExtractingLink ? t("解析中...", "Extracting...") : t("一键解析填入", "Auto-Extract Now")}
                      </button>
                    </div>
                  )}

                  <textarea
                    value={inputDescription}
                    onChange={(e) => {
                      cancelIntake();
                      setInputDescription(e.target.value);
                    }}
                    onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        handleSubmitJobSetup();
                      }
                    }}
                    aria-label={t("岗位链接或 JD 原文", "Job link or description")}
                    rows={4}
                    placeholder={t("请在此粘贴招聘 JD 的职责描述、任职要求与福利待遇... (支持快捷键 ⌘+Enter 快速开始分析)", "Paste job description, requirements and responsibilities here... (⌘+Enter to submit)")}
                    className={`w-full p-3.5 rounded-2xl border text-xs font-mono leading-relaxed focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 resize-y transition ${
                      isDark
                        ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                        : "border-slate-200 bg-white text-slate-800 placeholder-slate-400 shadow-2xs"
                    }`}
                  />
                </div>
                {evidencePanel}
                <details open={isExtractingLink || Boolean(linkError) || undefined} className="advisor-job-options">
                  <summary>{t("岗位字段与来源导入", "Job fields and source import")}</summary>
                  <button type="button" className="studio-button" aria-expanded={setupSummaryOpen}
                    onClick={() => { setSetupSummaryOpen(!setupSummaryOpen); setMobilePane(setupSummaryOpen ? "material" : "result"); }}>
                    {t("岗位摘要与范例", "Job summary and examples")}
                  </button>
                {/* ── Link Import Panel ── */}
                {isLinkInputOpen && (
                  <div
                    className={`p-3.5 rounded-xl border space-y-2.5 ${
                      isDark
                        ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]"
                        : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className={`text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("岗位链接或分享文字", "Job link or share text")}
                      </label>
                      <button
                        type="button"
                        onClick={() => void handlePasteClipboard()}
                        className={`text-[11px] px-2 py-0.5 rounded-md border cursor-pointer ${
                          isDark
                            ? "border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)] hover:text-white"
                            : "border-slate-200 text-slate-600 hover:text-slate-900 bg-white"
                        }`}
                      >
                        {t("粘贴", "Paste")}
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={linkInputValue}
                      onChange={(e) => {
                        cancelIntake();
                        setLinkInputValue(e.target.value);
                      }}
                      onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                        if (e.key === "Enter" && !e.shiftKey && !isExtractingLink) {
                          e.preventDefault();
                          void handleExtractLink();
                        }
                      }}
                      placeholder={t("粘贴 BOSS直聘 / 猎聘 / 51JOB / LinkedIn 岗位链接，或微信/APP分享的完整文字...", "Paste job link or share message...")}
                      className={`w-full p-2.5 rounded-lg border text-xs focus:outline-none transition resize-none leading-relaxed font-mono ${
                        isDark
                          ? "bg-[var(--ui-input,#22232a)] border-[var(--ui-border,#484b58)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)] focus:border-emerald-500"
                          : "bg-white border-slate-200 text-slate-900 placeholder-slate-400 focus:border-emerald-600"
                      }`}
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <button
                        type="button"
                        disabled={isExtractingLink || !linkInputValue.trim()}
                        onClick={() => void handleExtractLink()}
                        className="agent-btn-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition disabled:opacity-40 cursor-pointer"
                      >
                        {isExtractingLink ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        <span>
                          {isExtractingLink
                            ? extractingStepMessage
                              ? t("读取中...", "Reading...")
                              : t("解析中...", "Extracting...")
                            : t("读取并自动填入", "Extract & Fill")}
                        </span>
                      </button>
                      <button type="button" disabled={isExtractingLink||!linkInputValue.trim()} onClick={()=>void handleExtractLink(undefined,undefined,true)}
                        className="agent-btn-press inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/40 px-3 py-2 text-xs font-medium disabled:opacity-40">
                        {t("授权模型提取并填入", "Authorize model extraction & fill")}
                      </button>
                      <button
                        type="button"
                        disabled={isExtractingLink || !linkInputValue.trim()}
                        onClick={() => void handleExtractLink(undefined, "auto-browser")}
                        className={`text-[11px] underline-offset-2 hover:underline disabled:opacity-40 cursor-pointer bg-transparent border-0 p-0 ${
                          isDark ? "text-[var(--ui-text-muted,#a7adbd)] hover:text-emerald-300" : "text-slate-500 hover:text-emerald-700"
                        }`}
                      >
                        {t("用浏览器读取（验证码）", "Use browser (captcha)")}
                      </button>
                    </div>

                    {intakeTask&&<section aria-label={t("岗位字段提取任务", "Job field extraction task")} className="space-y-2 rounded-lg border border-emerald-600/25 p-3 text-xs">
                      <p>{intakeTask.id} · {intakeTask.status} · {taskRuntime.label} · {t("根累计模型调用", "Root model calls")} {intakeTask.rootLedger?.usage.modelCalls??intakeTask.usage.modelCalls}</p>
                      <details><summary>{t("完整来源、字段坐标与已有输出", "Complete source, field coordinates and output")}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({request:intakeTask.request,result:intakeTask.result,partialOutput:intakeTask.partialOutput,outputArtifacts:intakeTask.outputArtifacts},null,2)}</pre></details>
                      {["paused","interrupted","budget_exhausted","failed"].includes(intakeTask.status)&&<>
                        <label className="flex items-start gap-2"><input type="checkbox" checked={intakeResumeConsent} disabled={isExtractingLink} onChange={event=>setIntakeResumeConsent(event.target.checked)}/>{t("我已核对完整来源和当前底座，授权恢复原提取任务", "I reviewed the complete source and runtime and authorize resuming the original task")}</label>
                        <button type="button" disabled={isExtractingLink||!intakeResumeConsent} onClick={()=>void resumeMetadata()} className="rounded-lg border px-3 py-2 disabled:opacity-40">{t("恢复原字段提取任务", "Resume original extraction task")}</button>
                      </>}
                      {intakeTask.status==="running"&&<button type="button" onClick={()=>{
                        const version=++intakeVersion.current;intakeObserver.current?.abort();setIsExtractingLink(false);
                        void defaultJdIntakeTaskClient.pause(intakeTask.id).then(task=>{if(version===intakeVersion.current)setIntakeTask(task);}).catch(failure=>{if(version===intakeVersion.current)setLinkError(failure instanceof Error?failure.message:"停止结果尚未确认，请核对原任务。");});
                      }} className="rounded-lg border px-3 py-2">{t("停止字段提取", "Pause field extraction")}</button>}
                    </section>}

                    {isExtractingLink && extractingStepMessage && (
                      <p className={`text-[11px] flex items-center gap-1.5 ${isDark ? "text-emerald-300" : "text-emerald-800"}`}>
                        <Loader2 size={12} className="animate-spin shrink-0" />
                        <span>{extractingStepMessage}</span>
                      </p>
                    )}

                    {linkError && (
                      <div
                        className={`rounded-lg border px-3 py-2 text-[11px] space-y-2 ${
                          isDark ? "border-rose-500/30 bg-rose-950/20 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-800"
                        }`}
                      >
                        <p className="leading-relaxed">{linkError}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleExtractLink(undefined, "auto-browser")}
                            className="agent-btn-press px-2 py-1 rounded-md bg-emerald-600 text-white text-[11px] font-semibold cursor-pointer"
                          >
                            {t("重试（浏览器）", "Retry in browser")}
                          </button>
                          {extractUrlFromText(linkInputValue) && (
                            <a
                              href={extractUrlFromText(linkInputValue)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`px-2 py-1 rounded-md border text-[11px] cursor-pointer ${
                                isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-200 bg-white"
                              }`}
                            >
                              {t("打开原页", "Open page")}
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => void handlePasteClipboardAndExtract()}
                            className={`px-2 py-1 rounded-md border text-[11px] cursor-pointer ${
                              isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-200 bg-white"
                            }`}
                          >
                            {t("读取剪贴板文字并提取", "Extract from clipboard")}
                          </button>
                        </div>
                      </div>
                    )}

                    {linkSuccessNotice && (
                      <p className={`text-[11px] flex items-center gap-1.5 ${isDark ? "text-emerald-300" : "text-emerald-800"}`}>
                        <CheckCircle2 size={13} className="shrink-0" />
                        <span>{linkSuccessNotice}</span>
                      </p>
                    )}
                  </div>
                )}

                {/* 2-column Metadata Grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("职位名称", "Job Title")}
                      </label>
                    </div>
                    <input
                      type="text"
                      value={inputTitle}
                      onChange={(e) => {
                        cancelIntake();
                        setInputTitle(e.target.value);
                      }}
                      placeholder={t("例如：资深前端工程师 / 架构师", "e.g. Senior Frontend Engineer")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        isDark
                          ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 shadow-2xs"
                      }`}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("目标公司", "Company")}
                      </label>
                    </div>
                    <input
                      type="text"
                      value={inputCompany}
                      onChange={(e) => {
                        cancelIntake();
                        setInputCompany(e.target.value);
                      }}
                      placeholder={t("例如：字节跳动 / 腾讯 / 创新企业", "e.g. Acme Inc.")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        isDark
                          ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 shadow-2xs"
                      }`}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("薪资范围 (选填)", "Salary (Optional)")}
                      </label>
                    </div>
                    <input
                      type="text"
                      value={inputSalary}
                      onChange={(e) => {
                        cancelIntake();
                        setInputSalary(e.target.value);
                      }}
                      placeholder={t("例如：35k-50k · 16薪", "e.g. 35k-50k")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        isDark
                          ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 shadow-2xs"
                      }`}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("工作地点 (选填)", "Location (Optional)")}
                      </label>
                    </div>
                    <input
                      type="text"
                      value={inputLocation}
                      onChange={(e) => {
                        cancelIntake();
                        setInputLocation(e.target.value);
                      }}
                      placeholder={t("例如：上海 / 远程", "e.g. Shanghai / Remote")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        isDark
                          ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 shadow-2xs"
                      }`}
                    />
                  </div>
                </div>


                </details>

              </div>

              {/* Bottom Sticky Action Footer */}
              <div
                className={`advisor-setup-footer p-4 border-t shrink-0 flex items-center justify-between ${
                  isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-slate-50/90 border-slate-200"
                }`}
              >
                <div className={`text-[11px] flex items-center gap-1.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                  <Sparkles size={13} className="text-emerald-500" />
                  <span>{t("按 ⌘+Enter (Ctrl+Enter) 快速提交分析", "Press ⌘+Enter to start")}</span>
                </div>

                <div className="flex items-center gap-2">
                  {isEditingJob && (
                    <button
                      type="button"
                      onClick={handleCancelJobEdit}
                      className={`agent-btn-press px-3.5 py-2 rounded-xl border text-xs font-semibold cursor-pointer transition ${
                        isDark
                          ? "text-[var(--ui-text-secondary,#c5c8d6)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#363842)]"
                          : "text-slate-700 hover:text-slate-900 border-slate-200 bg-white hover:bg-slate-50 shadow-2xs"
                      }`}
                    >
                      {t("取消修改", "Cancel")}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={loading || !inputDescription.trim()}
                    onClick={handleSubmitJobSetup}
                    className="agent-btn-press inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-emerald-950/20 cursor-pointer"
                  >
                    {loading ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>{t("拆解中…", "Analyzing…")}</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        <span>
                          {isEditingJob
                            ? t("授权当前简历并重新分析", "Share current resume & re-analyze")
                            : isJdLinkOnly(inputDescription) ? t("读取岗位链接", "Read job link") : t("授权当前简历并开始拆解", "Share current resume & analyze")}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ── VIEW 2: Active Job Profile Banner + Full Height Dynamic JD & Copilot ── */
            <>
              <div
                className={`px-3.5 py-3 border-b shrink-0 space-y-2.5 ${
                  isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200"
                }`}
              >
                {evidencePanel}
                <AgentActiveJobHeader
                  isDark={isDark}
                  t={t}
                  jobView={currentJobView}
                  canEdit={Boolean(currentJob)}
                  onEdit={handleOpenJobEdit}
                  onSave={onSaveOpportunity && currentJob ? () => onSaveOpportunity(currentJob) : undefined}
                />

                <div
                  className={`relative grid grid-cols-2 p-0.5 rounded-lg ${isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-slate-100"}`}
                  role="tablist"
                >
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-md shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                      isDark ? "bg-[var(--ui-surface-soft,#363842)]" : "bg-white"
                    } ${leftViewMode === "chat" ? "translate-x-full" : "translate-x-0"}`}
                  />
                  {(
                    [
                      ["jd", t("岗位画像", "Job profile"), FileText],
                      ["chat", t("助理对话", "Advisor chat"), Bot],
                    ] as const
                  ).map(([mode, label, Icon]) => {
                    const active = leftViewMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => showLeftPage(mode)}
                        className={`relative z-10 agent-btn-press inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[12px] font-medium cursor-pointer ${
                          active
                            ? isDark
                              ? "text-[var(--ui-text,#edeef4)]"
                              : "text-slate-900"
                            : isDark
                              ? "text-[var(--ui-text-muted,#a7adbd)]"
                              : "text-slate-500"
                        }`}
                      >
                        <Icon size={13} />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div
                key={leftViewMode}
                className={`flex-1 flex flex-col min-h-0 overflow-hidden ${
                  pageMotion === "forward" ? "agent-page-forward" : pageMotion === "back" ? "agent-page-back" : ""
                }`}
              >
            {leftViewMode === "jd" && (
              <AgentJdDetailsView
                isDark={isDark}
                t={t}
                currentJob={currentJob}
                currentJobView={currentJobView}
                resume={resume}
                structuredJd={structuredJd}
                proposals={proposals}
                displayResponsibilities={displayResponsibilities}
                displayQualifications={displayQualifications}
                isJobSpecFolded={isJobSpecFolded}
                onToggleFold={() => setIsJobSpecFolded(!isJobSpecFolded)}
                copiedId={copiedId}
                onCopy={handleCopy}
              />
            )}

            {/* Section B: Career Copilot Interactive Chat Stream */}
            {leftViewMode === "chat" && (
              <div
                className={`flex flex-col min-h-0 flex-1 ${isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-white"}`}
              >
                {/* Header with Title and Mode Toggle */}
                <div
                  className={`px-4 py-2 border-b flex items-center justify-between shrink-0 ${
                    isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-slate-50/70 border-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <MessageSquare size={14} className="text-emerald-500" />
                    <h3 className={`text-xs font-bold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                      {t("助理协同对话 (Career Copilot)", "Career Copilot Chat")}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <AgentAutoSpeechToggle enabled={autoSpeech.enabled} onToggle={autoSpeech.toggle} />
                    {resumeEditContext && <button
                      type="button"
                      aria-pressed={shareResumeForEditing}
                      disabled={chatLoading}
                      onClick={() => setShareResumeForEditing((value) => !value)}
                      title={t("开启后仅向所选模型发送当前简历视图中的个人简介、技能和经历要点；不会发送姓名、联系方式、头像或简历全文。", "When enabled, only the current resume view’s headline, skills and experience claims are sent to the selected model. Name, contact details, photo and the full resume are excluded.")}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:opacity-50 ${shareResumeForEditing
                        ? isDark ? "border-emerald-400/45 bg-emerald-500/15 text-emerald-200" : "border-emerald-300 bg-emerald-50 text-emerald-800"
                        : isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-emerald-500/40" : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300"
                      }`}
                    >
                      <ShieldCheck size={12} />
                      <span>{shareResumeForEditing ? t("简历字段已授权", "Resume fields shared") : t("允许 Agent 读取简历字段", "Allow resume fields")}</span>
                    </button>}
                    <span className={`text-[10px] hidden sm:inline ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                      {t("支持查企业 · 优化经历 · 答辩攻略", "Company check · Polish resume · Interview tips")}
                    </span>
                  </div>
                </div>

                {/* Message List */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3.5 min-h-0 agent-custom-scrollbar">
                  {messages.length === 0 && (
                    <AgentEmptyPromptCards
                      isDark={isDark}
                      t={t}
                      company={currentJob?.company}
                      onSendMessage={handleSendMessage}
                      onTriggerGuide={triggerAgentGuide}
                    />
                  )}

                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} space-y-2`}
                    >
                      <div
                        className={`rounded-2xl px-4 py-3 text-xs leading-relaxed group relative transition-colors ${
                          msg.role === "user"
                            ? "max-w-[85%] bg-emerald-600 text-white rounded-br-xs shadow-md shadow-emerald-950/30"
                            : isDark
                              ? "w-full max-w-[96%] bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text,#edeef4)] border border-[var(--ui-border,#484b58)] shadow-md rounded-bl-xs"
                              : "w-full max-w-[96%] bg-white text-slate-800 border border-slate-200 shadow-2xs rounded-bl-xs"
                        }`}
                      >
                        {msg.role === "user" ? (
                          <>
                            {msg.content && <p className="whitespace-pre-wrap text-xs leading-relaxed">{msg.content}</p>}
                            {msg.references?.map((reference, index) => (
                              <div key={`${msg.id}-reference-${index}`} className="mt-2 max-w-full rounded-xl border border-white/20 bg-black/10 p-2.5 text-[11px]">
                                <div className="mb-1 flex items-center gap-1.5 font-semibold opacity-85"><FileText size={12} />{reference.sourceLabel}</div>
                                <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap border-l-2 border-white/50 pl-2 opacity-90">{reference.text}</blockquote>
                              </div>
                            ))}
                            {!!msg.attachments?.length && <div className="mt-2 grid max-w-[320px] grid-cols-2 gap-2">
                              {msg.attachments.map((attachment, index) => <figure key={`${msg.id}-image-${index}`} className="overflow-hidden rounded-lg border border-white/25 bg-black/10">
                                <img src={attachment.dataUrl} alt={attachment.name} className="max-h-48 w-full object-contain" />
                                <figcaption className="truncate px-2 py-1 text-[10px] opacity-80">{attachment.name}</figcaption>
                              </figure>)}
                            </div>}
                          </>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-2 pb-2 mb-2 border-b border-white/10 dark:border-white/5">
                              <div className="flex items-center gap-1.5 font-bold text-[11px] text-emerald-500 dark:text-emerald-400">
                                <Bot size={13} />
                                <span>{t("Career Copilot", "Career Copilot")}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleCopy(msg.content, msg.id)}
                                className={`opacity-70 hover:opacity-100 p-1 rounded-md text-[10px] flex items-center gap-1 transition cursor-pointer ${
                                  isDark ? "hover:bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-muted,#a7adbd)] hover:text-white" : "hover:bg-slate-100 text-slate-500 hover:text-slate-800"
                                }`}
                                title={t("复制此回答", "Copy response")}
                              >
                                {copiedId === msg.id ? (
                                  <>
                                    <Check size={11} className="text-emerald-500" />
                                    <span className="text-emerald-500 font-medium">{t("已复制", "Copied")}</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy size={11} />
                                    <span>{t("复制", "Copy")}</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <AgentSpeechControl message={msg} speech={speech} />
                            <AgentReplyMeta meta={msg.meta} compact isDark={isDark} />
                            {msg.id === lastAssistantMessageId && msg.meta?.status === "truncated" && (
                              <button type="button" className={`agent-continue-reply ${isDark ? "is-dark" : ""}`} onClick={() => void handleSendMessage(t("请从上一条不完整回复的结束处继续，避免重复已写内容，并补完尚未回答的部分。", "Continue from the end of the previous incomplete reply, avoid repeating completed text, and finish any unanswered parts."))} disabled={chatLoading}>
                                {chatLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                <span>{chatLoading ? t("正在补全…", "Continuing…") : t("继续补完", "Continue reply")}</span>
                              </button>
                            )}
                            <AgentMarkdownRenderer content={msg.content} isDark={isDark} />
                          </>
                        )}
                      </div>

                      {/* Action Cards attached to Assistant reply */}
                      {msg.actions && msg.actions.length > 0 && (
                        <AgentReplyActionsCard
                          msgId={msg.id}
                          actions={msg.actions}
                          isDark={isDark}
                          t={t}
                          copiedId={copiedId}
                          onCopy={handleCopy}
                          resumeProposalStates={resumeProposalStates}
                          onDecideResumeProposal={decideResumeProposal}
                        />
                      )}
                    </div>
                  ))}

                  {chatLoading && (
                    <div className="flex items-center gap-2 text-xs text-emerald-500 py-2 pl-2">
                      <Loader2 size={14} className="animate-spin text-emerald-500" />
                      <span>{t("Agent 正在结合当前岗位与本次授权内容思考…", "Agent is considering the current job and the context you shared…")}</span>
                    </div>
                  )}
                  {(chatNotice || (!chatLoading && recovery.value.pendingChatId)) && <p role="status" className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-300">{chatNotice || t("上次对话请求已中断，问题与已完成记录已保留。请核对后手动重试；未自动重发。", "The previous request was interrupted. Your question and history are still here. Review them before retrying.")}</p>}

                  <div ref={chatEndRef} />
                </div>

                {/* Slender Quick Prompts Ribbon */}
                <div
                  className={`px-4 py-2 border-t flex items-center gap-1.5 overflow-x-auto agent-custom-scrollbar text-[11px] shrink-0 ${
                    isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <span className={`shrink-0 font-medium ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>{t("快捷指令:", "Quick prompts:")}</span>
                  {([{ id: "plan", zh: "引导规划", en: "Guided plan", promptZh: "请先问我职业目标和约束，再一起制定分步规划；等我反馈后调整下一步。", promptEn: "Ask about my career goal and constraints, then build a step-by-step plan with me and adjust after my feedback." }, { id: "interview", zh: "逐题面试", en: "One-question interview", promptZh: "请先确认目标岗位与级别，然后一次问一道模拟面试题，等我回答后给反馈和下一题。", promptEn: "Confirm my target role and level, ask one mock interview question at a time, then give feedback after I answer." }] as const).map((guide) => <button key={guide.id} type="button" data-testid={`workspace-guide-${guide.id}`} disabled={chatLoading} onClick={() => { setInputMessage((current) => current.trim() ? `${current.trim()}\n\n${t(guide.promptZh, guide.promptEn)}` : t(guide.promptZh, guide.promptEn)); chatComposerRef.current?.focus(); }} className="shrink-0 rounded-full border border-emerald-300 px-3 py-1 text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/30">{t(guide.zh, guide.en)}</button>)}
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("帮我深入调研这家公司的控股背景、实控人与业务稳定性", "Inspect company ownership, background and stability"))}
                    disabled={chatLoading}
                    className={`agent-btn-press shrink-0 px-3 py-1 rounded-full border transition disabled:opacity-50 cursor-pointer shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#41434e)] hover:text-emerald-300 hover:border-emerald-500/40 border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)]"
                        : "bg-white hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200 border-slate-200 text-slate-700 shadow-2xs"
                    }`}
                  >
                    🔍 {t("调研实控人与背景", "Inspect company background")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("对照目标岗位，找一条最有依据的经历，写清交付对象和本人动作；缺少关键细节就先问我。", "Help me refine one supported contribution for the target role. Ask me for missing details before suggesting a rewrite."))}
                    disabled={chatLoading}
                    className={`agent-btn-press shrink-0 px-3 py-1 rounded-full border transition disabled:opacity-50 cursor-pointer shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#41434e)] hover:text-emerald-300 hover:border-emerald-500/40 border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)]"
                        : "bg-white hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200 border-slate-200 text-slate-700 shadow-2xs"
                    }`}
                  >
                    ✍️ {t("打磨一条核心经历", "Refine a key contribution")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("分析这个岗位面试官最可能深挖的技术考点，并为我提供高情商防守话术", "Analyze tricky interview questions and provide defense script"))}
                    disabled={chatLoading}
                    className={`agent-btn-press shrink-0 px-3 py-1 rounded-full border transition disabled:opacity-50 cursor-pointer shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#41434e)] hover:text-emerald-300 hover:border-emerald-500/40 border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)]"
                        : "bg-white hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200 border-slate-200 text-slate-700 shadow-2xs"
                    }`}
                  >
                    🛡️ {t("面试考点与防守策略", "Interview defense tips")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("针对目标岗位，分析我目前最大的技能或经历缺口，给出短期攻坚建议", "Diagnose skill gaps and suggest learning roadmap"))}
                    disabled={chatLoading}
                    className={`agent-btn-press shrink-0 px-3 py-1 rounded-full border transition disabled:opacity-50 cursor-pointer shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#41434e)] hover:text-emerald-300 hover:border-emerald-500/40 border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)]"
                        : "bg-white hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200 border-slate-200 text-slate-700 shadow-2xs"
                    }`}
                  >
                    🎯 {t("技能缺口诊断建议", "Skill gap diagnosis")}
                  </button>
                </div>

                {/* Modern AI Chat Composer Deck */}
                <div
                  className={`p-3 border-t shrink-0 ${
                    isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)]" : "border-slate-200/80 bg-slate-50/50"
                  }`}
                >
                  <div
                    className={`agent-composer-deck rounded-2xl border p-2.5 space-y-2 transition-all shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#22232a)] border-[var(--ui-border,#484b58)]"
                        : "bg-white border-slate-200"
                    }`}
                  >
                    <input ref={chatImageInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" aria-label={t("上传图片给 Agent", "Upload images for Agent")} onChange={(event) => { void handleChatImageSelection(event); }} />
                    <textarea
                      ref={chatComposerRef}
                      rows={2}
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder={t(
                        "向 AI 顾问提问（例如：这条经历里，读者能看出哪一步是我做的吗？）…",
                        "Ask the copilot (e.g. can a reader tell what I personally delivered here?)…"
                      )}
                      className={`agent-chat-textarea w-full px-2 py-1 text-xs sm:text-[13px] font-sans outline-none resize-none ${
                        isDark
                          ? "text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "text-slate-900 placeholder:text-slate-400"
                      }`}
                    />

                    {(pendingReferences.length > 0 || pendingAttachments.length > 0) && <div className="flex flex-wrap gap-2 px-1" aria-label={t("待发送的上下文附件", "Pending context attachments")}>
                      {pendingReferences.map((reference, index) => <div key={`${reference.sourceLabel}-${index}`} className={`flex max-w-full items-start gap-2 rounded-xl border px-2.5 py-2 text-[11px] ${isDark ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
                        <FileText size={13} className="mt-0.5 shrink-0" />
                        <span className="min-w-0"><strong className="block">{reference.sourceLabel}</strong><span className="block max-w-[360px] truncate opacity-80">{reference.text}</span></span>
                        <button type="button" className="shrink-0 opacity-70 hover:opacity-100" aria-label={t("移除引用", "Remove quote")} onClick={() => setPendingReferences((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button>
                      </div>)}
                      {pendingAttachments.map((attachment, index) => <div key={`${attachment.name}-${index}`} className={`relative h-20 w-24 overflow-hidden rounded-xl border ${isDark ? "border-[var(--ui-border,#484b58)] bg-black/20" : "border-slate-200 bg-slate-50"}`}>
                        <img src={attachment.dataUrl} alt={attachment.name} className="h-full w-full object-contain" />
                        <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-1 text-[9px] text-white">{attachment.name}</span>
                        <button type="button" className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5 text-white" aria-label={t(`移除图片 ${index + 1}`, `Remove image ${index + 1}`)} onClick={() => setPendingAttachments((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}><X size={11} /></button>
                      </div>)}
                    </div>}
                    {attachmentError && <p role="alert" className="px-1 text-[11px] text-rose-500">{attachmentError}</p>}
                    {pendingAttachments.length > 0 && <div className={`px-1 text-[10px] leading-4 ${imageCapability === "unsupported" ? "text-rose-500" : imageCapability === "supported" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-300"}`} role="status">
                      <strong>{modelImageCapabilityLabel(imageCapability, t)}</strong> · {modelImageCapabilityDescription(imageCapability, t)}
                      {imageCapability === "unsupported" && <button type="button" className="ml-1 underline underline-offset-2" onClick={onOpenConfig}>{t("更换模型", "Change model")}</button>}
                    </div>}

                    {/* Composer Footer Actions */}
                    <div className="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800/80">
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] select-none">
                        <button type="button" disabled={chatLoading || readingChatImages || pendingAttachments.length >= MAX_CHAT_IMAGES} onClick={() => chatImageInputRef.current?.click()} title={t("添加原始图片（最多 3 张，单张不超过 2 MB，不压缩）", "Attach original images (up to 3, at most 2 MB each, no compression)")} className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition disabled:opacity-40 ${isDark ? "border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-emerald-500/40 hover:text-emerald-300" : "border-slate-200 text-slate-600 hover:border-emerald-300 hover:text-emerald-700"}`} aria-label={t("上传图片", "Upload image")}><ImagePlus size={15} /></button>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981] animate-pulse" />
                            <span className="truncate font-semibold text-emerald-600 dark:text-emerald-400">{t("AI 顾问随时待命", "AI Copilot Online")}</span>
                            <span className="text-slate-300 dark:text-slate-600 hidden sm:inline">|</span>
                            <span className="text-slate-400 dark:text-slate-400 text-[10px] hidden sm:inline">{t("Enter 发送 · Shift+Enter 换行", "Enter to send, Shift+Enter for newline")}</span>
                          </div>
                          <span className="mt-0.5 block max-w-[38rem] text-[10px] leading-4 text-slate-400">{shareResumeForEditing
                            ? t("本次还会发送当前简历视图中可见的个人简介、技能与经历要点，以生成可核验的修改建议；不发送姓名、邮箱、电话、头像或全文。", "This request also shares the visible headline, skills and experience claims from the current resume view for grounded edits. Name, email, phone, photo and the full resume are excluded.")
                            : t("发送时会将对话内容、当前岗位，以及对话中的引用/图片发送给所选模型服务商；简历字段默认不共享，除非你明确开启上方开关或附加选中文字。", "Sending shares this conversation, current job and quoted text/images with the selected model provider. Resume fields are excluded unless you enable the switch above or attach selected text.")}</span>
                        </div>
                      </div>

                      {chatLoading ? <button type="button" onClick={handleStopChat} aria-label={t("停止生成并编辑问题", "Stop generating and edit question")} className="agent-btn-press flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-500"><Square size={13} /><span>{t("停止", "Stop")}</span></button> : <button
                        type="button"
                        onClick={() => void handleSendMessage()}
                        disabled={readingChatImages || (!inputMessage.trim() && !pendingAttachments.length && !pendingReferences.length) || (pendingAttachments.length > 0 && imageCapability === "unsupported")}
                        className={`agent-btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer select-none ${
                          (inputMessage.trim() || pendingAttachments.length || pendingReferences.length) && !chatLoading
                            ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-500/25 active:scale-95"
                            : "bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-400 disabled:opacity-40 cursor-not-allowed"
                        }`}
                      >
                        <Send size={13} />
                        <span>{t("发送", "Send")}</span>
                      </button>}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>

        {!isSetupMode && !showRightPane && (
          <button
            type="button"
            onClick={() => setRightPaneOpen(true)}
            className={`hidden lg:flex w-9 shrink-0 my-4 ml-2 flex-col items-center justify-center gap-1 rounded-2xl border text-[11px] font-medium cursor-pointer ${
              isDark
                ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-secondary,#c7cad4)] hover:text-white"
                : "border-slate-200 bg-white text-slate-600 hover:text-slate-900 shadow-sm"
            }`}
            title={t("展开匹配结果", "Show match results")}
          >
            <PanelRightOpen size={14} />
            <span className="[writing-mode:vertical-rl] tracking-widest">{t("匹配", "Match")}</span>
          </button>
        )}

        {showRightPane && (
        <div
          className="hidden lg:flex w-4 shrink-0 items-center justify-center cursor-col-resize select-none touch-none group relative z-20 py-4"
          role="separator"
          tabIndex={0}
          aria-label={t("左右拖拽调整分栏宽度，双击重置默认", "Drag to resize split panels; double-click to reset")}
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(displaySplitPercent)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 25 : event.key === "End" ? 75 : Math.min(75, Math.max(25, displaySplitPercent + (event.key === "ArrowLeft" ? -2 : 2)));
            setSplitAdjusted(true);
            setSplitPercent(next);
            try { localStorage.setItem(AGENT_SPLIT_KEY, String(next)); } catch { /* Keep resizing usable when preference storage is unavailable. */ }
          }}
          title={t("拖动或使用方向键调整宽度；双击恢复当前阶段默认布局", "Drag or use arrow keys to resize; double-click to reset")}
          onPointerDown={handleSplitPointerDown}
          onPointerMove={handleSplitPointerMove}
          onPointerUp={handleSplitPointerUp}
          onPointerCancel={handleSplitPointerUp}
          onDoubleClick={handleSplitReset}
        >
          {/* Center line */}
          <div
            className={`h-[calc(100%-20px)] rounded-full transition-all duration-150 ${
              isDraggingSplitter
                ? "w-[3px] bg-emerald-500 shadow-sm shadow-emerald-500/50"
                : "w-[2px] bg-[var(--ui-border,#484b58)] group-hover:w-[3px] group-hover:bg-emerald-500/80"
            }`}
          />
          {/* Grip pill button */}
          <div
            className={`absolute h-10 w-4 rounded-md border flex items-center justify-center transition-all duration-150 shadow-xs ${
              isDraggingSplitter
                ? "bg-[var(--ui-surface-raised,#2e3038)] border-emerald-500 text-emerald-400 scale-110 shadow-md"
                : "bg-[var(--ui-surface,#27282f)] border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)] group-hover:border-emerald-500/60 group-hover:text-emerald-400"
            }`}
          >
            <GripVertical size={12} />
          </div>
          {/* Live percentage tooltip */}
          <div
            className={`absolute top-4 left-1/2 -translate-x-1/2 text-[10px] font-mono px-2 py-0.5 rounded-full border shadow-md transition-opacity pointer-events-none whitespace-nowrap bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)] ${
              isDraggingSplitter ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {Math.round(displaySplitPercent)}% / {Math.round(100 - displaySplitPercent)}%
          </div>
        </div>
        )}

        {showRightPane && (
        <div
          style={{ width: typeof window !== "undefined" && window.innerWidth >= 1024 ? `calc(${100 - splitPercent}% - 8px)` : "100%" }}
          className={`flex-1 lg:flex-none flex flex-col min-h-0 min-w-[340px] rounded-3xl border shadow-md overflow-hidden ${isDraggingSplitter ? "" : "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"} ${
            isDark
              ? "bg-[var(--ui-surface,#27282f)] border-[var(--ui-border,#484b58)] shadow-xl"
              : "bg-white border-slate-200/90 shadow-sm"
          }`}
        >
          {isSetupMode ? (
            /* ── SETUP RIGHT PANE: Quiet job summary + sample chips ── */
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div
                className={`px-4 py-3 border-b shrink-0 flex items-center justify-between gap-3 ${
                  isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-slate-50/70 border-slate-200"
                }`}
              >
                <div>
                  <h3 className={`text-xs font-semibold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                    {inputDescription.trim() ? t("岗位摘要", "Job summary") : t("从一份真实岗位开始", "Start with a real opportunity")}
                  </h3>
                  <p className={`text-[11px] mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {inputDescription.trim() ? t("确认左侧字段后开始拆解", "Confirm fields on the left, then start") : t("保留完整正文，分析更有依据", "Keep the full description for grounded analysis")}
                  </p>
                </div>
                {isEditingJob && currentJob?.description && (
                  <button
                    type="button"
                    onClick={handleCancelJobEdit}
                    className={`agent-btn-press text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition cursor-pointer shrink-0 ${
                      isDark
                        ? "text-[var(--ui-text-muted,#a7adbd)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]"
                        : "text-slate-700 hover:text-slate-900 border-slate-200 bg-white"
                    }`}
                  >
                    {t("放弃修改", "Discard")}
                  </button>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto agent-custom-scrollbar p-4 space-y-5">
                {!inputDescription.trim() && <div className="advisor-import-guide"><FileText size={22} aria-hidden="true" /><h4>{t("添加岗位原文", "Add a job description")}</h4><p>{t("粘贴招聘链接或 JD 文本后，这里会显示岗位摘要。", "Paste a job link or description to see its summary here.")}</p></div>}
                <div hidden={!inputDescription.trim()} className="space-y-3 text-xs">
                  {(
                    [
                      { label: t("职位", "Title"), value: inputTitle.trim() },
                      { label: t("公司", "Company"), value: inputCompany.trim() },
                      { label: t("薪资", "Salary"), value: inputSalary.trim() },
                      { label: t("地点", "Location"), value: inputLocation.trim() },
                    ] as const
                  ).map((row) => (
                    <div key={row.label} className="flex items-baseline gap-3">
                      <span className={`w-10 shrink-0 text-[11px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                        {row.label}
                      </span>
                      <span
                        className={`min-w-0 truncate font-medium ${
                          row.value
                            ? isDark
                              ? "text-[var(--ui-text,#edeef4)]"
                              : "text-slate-900"
                            : isDark
                              ? "text-[var(--ui-text-muted,#a7adbd)] font-normal"
                              : "text-slate-400 font-normal"
                        }`}
                      >
                        {row.value || "—"}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-baseline gap-3">
                    <span className={`w-10 shrink-0 text-[11px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                      JD
                    </span>
                    <span className={`text-[11px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                      {inputDescription.trim().length > 0
                        ? t(`${inputDescription.trim().length} 字`, `${inputDescription.trim().length} chars`)
                        : t("尚未粘贴", "Not pasted yet")}
                    </span>
                  </div>

                  {inputDescription.trim().length > 0 ? (
                    <p className={`flex items-center gap-1.5 text-[11px] pt-1 ${isDark ? "text-emerald-400" : "text-emerald-700"}`}>
                      <CheckCircle2 size={13} className="shrink-0" />
                      {t("可开始拆解", "Ready to match")}
                    </p>
                  ) : (
                    <p className={`text-[11px] pt-1 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                      {t("粘贴招聘链接或 JD，或点选下方范例", "Paste a job link / JD, or pick a sample")}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <p className={`text-[11px] font-medium ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {t("范例岗位", "Sample roles")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SAMPLE_JOBS.map((preset) => {
                      const active = inputTitle === preset.title;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => loadSampleJob(preset)}
                          className={`agent-btn-press text-[11px] px-2.5 py-1.5 rounded-lg border transition cursor-pointer ${
                            active
                              ? isDark
                                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                                : "bg-emerald-50 border-emerald-300 text-emerald-800"
                              : isDark
                                ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-[var(--ui-border-strong,#656877)]"
                                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          {preset.chip}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ── ACTIVE RIGHT PANE: Fit instrument + proposal list ── */
            <AgentFitAnalyticsHeader
              isDark={isDark}
              t={t}
              loading={loading}
              isApplying={isApplying}
              stats={stats}
              jobTitle={currentJob?.title}
              company={currentJob?.company ? currentJobView.company : undefined}
              errorNotice={errorNotice}
              proposalFilter={proposalFilter}
              onChangeFilter={setProposalFilter}
              onHideRightPane={() => setRightPaneOpen(false)}
              onRunMatching={() => {
                if (currentJob?.description) {
                  void runMatching(currentJob);
                } else {
                  setIsEditingJob(true);
                }
              }}
              onApply={handleApply}
            >
              <AgentProposalListSection
                isDark={isDark}
                t={t}
                loading={loading}
                proposals={proposals}
                gapProposals={gapProposals}
                filteredProposals={filteredProposals}
                proposalFilter={proposalFilter}
                decisions={decisions}
                editingProposalId={editingProposalId}
                editedText={editedText}
                activeDiffProposalId={activeDiffProposalId}
                showGapsSummary={showGapsSummary}
                onToggleGapsSummary={() => setShowGapsSummary((open) => !open)}
                onAskGap={(jdItem) => {
                  if (leftViewMode === "jd") showLeftPage("chat");
                  void handleSendMessage(`针对这个岗位的缺口项“${jdItem}”，帮我制定一套高情商的面试应答与能力迁移策略`);
                }}
                linkableRequirements={linkableRequirements}
                onLinkRequirement={linkRequirement}
                onSetActiveDiffProposalId={setActiveDiffProposalId}
                onDecision={handleDecision}
                onStartEdit={startEdit}
                onSaveEdit={saveEdit}
                onCancelEdit={cancelEdit}
                onChangeEditedText={text => updateMatch(matchKey, previous => ({ ...previous, editedText: text }))}
                getClaimText={getClaimText}
              />
            </AgentFitAnalyticsHeader>
          )}
    </div>
        )}
  </div>

      {/* ── Guided Application Multi-Step Transition Overlay Modal ──── */}
      {isApplying && (
        <AgentApplyModal
          isDark={isDark}
          t={t}
          applyStep={applyStep}
          acceptedCount={stats.acceptedCount}
          company={currentJob?.company}
          title={currentJob?.title}
        />
      )}
    </section></div></div>
  );
}
