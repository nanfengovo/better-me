/** @jsxRuntime automatic */
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useUiPreferences } from "../lib/ui-preferences";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { useAgentRouting } from "../lib/agent-routing";
import { jdMatchResumeMaterial } from "../services/jd-match-task-client";
import {
  type LlmConfig,
  type ProjectedResume,
  decomposeJdText,
  alignJdWithResume,
  type DecomposedJd,
  type JdEvidenceAlignmentReport,
} from "@better-me/core";
import {
  Bot,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Crosshair,
  Edit3,
  ExternalLink,
  FileCheck2,
  FileText,
  Layers,
  Lightbulb,
  Loader2,
  MapPin,
  Maximize2,
  MessageSquare,
  Minimize2,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  X,
  AlertTriangle,
} from "lucide-react";
import { triggerAgentGuide } from "../lib/agent-guide";
import {
  startJdMatch,
  resumeJdMatch,
  sendAgentChat,
  checkAgentHostHealth,
  type MatchProposal,
  type ChatMessage,
} from "../services/agent-client";
import { AgentMarkdownRenderer } from "./AgentMarkdownRenderer";
import { AgentReplyMeta } from "./AgentReplyMeta";
import { useRecoveryField, useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import { AdvisorRecoverySchema, initialAdvisorRecovery } from "../lib/advisor-recovery";
import { privateKey } from "../lib/private-storage";
import { contextFingerprint } from "../lib/career-coach/state";
import { WorkspaceRecoveryNotice } from "./WorkspaceRecoveryNotice";
import {createInterviewSelection,requestMockInterview} from "../lib/mock-interview-launch";

export interface DrawerJobContext {
  id?: string;
  title: string;
  company: string;
  location?: string;
  salary?: string;
  description: string;
  sourceUrl?: string;
  sourcePlatform?: string;
}

export interface JdMatchDrawerProps {
  workspaceKey?: string;
  isOpen: boolean;
  onClose: () => void;
  job: DrawerJobContext | null;
  resume: ProjectedResume | null;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
  onApplyToResume: (payload: {
    acceptedProposals: MatchProposal[];
    customResumeName: string;
    targetJobTitle: string;
    targetCompany: string;
  }) => void;
  onSaveOpportunity?: (job: DrawerJobContext) => void;
}

export function JdMatchDrawer(props: JdMatchDrawerProps) {
  const scope = JSON.stringify([props.workspaceKey ?? "active-resume", props.job?.id ?? contextFingerprint({ job: props.job ?? undefined })]);
  return <JdMatchDrawerSession key={privateKey(scope)} recoveryKey={scope} {...props} />;
}

function JdMatchDrawerSession({
  workspaceKey="active-resume",
  recoveryKey,
  isOpen,
  onClose,
  job,
  resume,
  llmConfig,
  onOpenConfig,
  onApplyToResume,
  onSaveOpportunity,
}: JdMatchDrawerProps & { recoveryKey: string }) {
  const { t } = useUiPreferences();
  const {agent}=useBetterMeAgent();
  const routing=useAgentRouting();
  const recovery = useWorkspaceRecovery(`jd-drawer:${recoveryKey}`, AdvisorRecoverySchema, () => initialAdvisorRecovery(job));
  const [activeTab, setActiveTab] = useState<"proposals" | "decomposition" | "defenses" | "chat">("proposals");

  // Current Target Job state
  const [currentJob, setCurrentJob] = useRecoveryField(recovery, "currentJob");
  const [isEditingJob, setIsEditingJob] = useRecoveryField(recovery, "isEditingJob");
  const [inputTitle, setInputTitle] = useRecoveryField(recovery, "inputTitle");
  const [inputCompany, setInputCompany] = useRecoveryField(recovery, "inputCompany");
  const [inputSalary, setInputSalary] = useRecoveryField(recovery, "inputSalary");
  const [inputLocation, setInputLocation] = useRecoveryField(recovery, "inputLocation");
  const [inputDescription, setInputDescription] = useRecoveryField(recovery, "inputDescription");

  // Deterministic JD Decomposition & Evidence Alignment
  const decomposedJd = useMemo<DecomposedJd | null>(() => {
    const desc = currentJob?.description || inputDescription;
    if (!desc || desc.trim().length < 5) return null;
    return decomposeJdText(desc, {
      title: currentJob?.title || inputTitle,
      company: currentJob?.company || inputCompany,
      location: currentJob?.location || inputLocation,
    });
  }, [currentJob?.description, currentJob?.title, currentJob?.company, currentJob?.location, inputDescription, inputTitle, inputCompany, inputLocation]);

  const alignmentReport = useMemo<JdEvidenceAlignmentReport | null>(() => {
    if (!decomposedJd || !resume) return null;
    return alignJdWithResume(decomposedJd, resume);
  }, [decomposedJd, resume]);

  // Matching state
  const [threadId, setThreadId] = useRecoveryField(recovery, "threadId");
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [structuredJd, setStructuredJd] = useRecoveryField(recovery, "structuredJd");
  const [proposals, setProposals] = useRecoveryField(recovery, "proposals");
  const [decisions, setDecisions] = useRecoveryField(recovery, "decisions");
  const [editingProposalId, setEditingProposalId] = useRecoveryField(recovery, "editingProposalId");
  const [editedText, setEditedText] = useRecoveryField(recovery, "editedText");
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [agentHostOnline, setAgentHostOnline] = useState<boolean | null>(null);

  // Initialize deterministic alignment proposals when no async proposals have loaded
  useEffect(() => {
    if (alignmentReport && proposals.length === 0 && !loading) {
      const generatedProposals: MatchProposal[] = alignmentReport.alignments.map((a) => ({
        id: a.id,
        jdItem: a.jdItem.originalQuote,
        evidenceType: a.status === "gap" ? "gap" : "claimed",
        profileEntryId: a.matchedClaimId,
        suggestion: a.suggestedText || a.currentResumeText || a.jdItem.summary,
        rationale: a.rationale,
      }));
      setProposals(generatedProposals);
      setDecisions({});
    }
  }, [alignmentReport, proposals.length, loading, setDecisions, setProposals]);

  // Chat state
  const [messages, setMessages] = useRecoveryField(recovery, "messages");
  const lastAssistantMessageId = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const [inputMessage, setInputMessage] = useRecoveryField(recovery, "inputMessage");
  const [chatLoading, setChatLoading] = useState(false);
  const chatAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => chatAbort.current?.abort(), []);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // View state
  const [drawerWidth, setDrawerWidth] = useState<"standard" | "wide">("standard");
  const [showRawJd, setShowRawJd] = useState(false);
  const [showGapsSummary, setShowGapsSummary] = useState(true);

  // Sync prop job changes to local currentJob
  const previousJob = useRef(job);
  useEffect(() => {
    if (previousJob.current === job) return;
    previousJob.current = job;
    if (job) {
      setCurrentJob(job);
      setInputTitle(job.title || "");
      setInputCompany(job.company || "");
      setInputSalary(job.salary || "");
      setInputLocation(job.location || "");
      setInputDescription(job.description || "");
      setIsEditingJob(false);
    }
  }, [job, setCurrentJob, setInputCompany, setInputDescription, setInputLocation, setInputSalary, setInputTitle, setIsEditingJob]);

  // Check agent host health on open
  useEffect(() => {
    if (isOpen) {
      void checkAgentHostHealth().then(setAgentHostOnline);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Auto scroll chat
  useEffect(() => {
    if (activeTab === "chat") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeTab]);

  // Only an explicitly labeled user action grants this frozen JD + resume projection.
  // Mount, navigation and history restoration never dispatch analysis.
  const runMatching = useCallback(async (jdText: string) => {
    if(loading)return;
    setLoading(true);setErrorNotice(null);setProposals([]);setDecisions({});setStructuredJd(null);setThreadId("");
    try {
      if(routing?.blocked)throw new Error("底座状态尚未确认；未使用旧 API 配置补发。");
      routing?.assertSelected();
      const result=await startJdMatch({threadId:"explicit-jd-analysis",workspaceKey:agent?.workspaceKey??workspaceKey,rootScopeKey:agent?.workspaceKey??workspaceKey,
        rawJd:jdText,...jdMatchResumeMaterial(resume),llmConfig,consent:true,
        ...(routing?.enabled&&routing.policy?{runtime:{kind:"unified" as const,expectedRevision:routing.policy.revision},preferredRuntimeId:routing.policy.preferred}:{}),
        onTask:task=>setThreadId(task.id),
      });
      setThreadId(result.threadId);setProposals(result.proposals);if(result.structuredJd)setStructuredJd(result.structuredJd);setDecisions({});
    } catch(error) {
      setErrorNotice(error instanceof Error?error.message:t("岗位分析未完成，原任务记录与用量保留。","Analysis not completed; task history and usage retained."));
    } finally {setLoading(false);}
  },[loading,routing,agent?.workspaceKey,workspaceKey,resume,llmConfig,t,setDecisions,setProposals,setStructuredJd,setThreadId]);

  const handleDecision = (proposalId: string, status: "accepted" | "rejected") => {
    setDecisions((prev) => ({
      ...prev,
      [proposalId]: { status },
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

  const startEdit = (proposal: MatchProposal) => {
    setEditingProposalId(proposal.id);
    const current = decisions[proposal.id];
    setEditedText(current && current.status === "edited" ? current.editedSuggestion : proposal.suggestion);
  };

  const saveEdit = (proposalId: string) => {
    if (!editedText.trim()) return;
    setDecisions((prev) => ({
      ...prev,
      [proposalId]: { status: "edited", editedSuggestion: editedText.trim() },
    }));
    setEditingProposalId(null);

    const prop = proposals.find((p) => p.id === proposalId);
    triggerAgentGuide({
      claimId: prop?.profileEntryId,
      text: editedText.trim(),
      label: t("✏️ 已保存自定义修改", "✏️ Saved custom edit"),
      actionType: "applied",
    });
  };

  const cancelEdit = () => {
    setEditingProposalId(null);
  };

  // Chat message submission
  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText ?? inputMessage;
    if (!textToSend.trim() || chatLoading) return;

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content: textToSend.trim(),
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!customText) setInputMessage("");
    setChatLoading(true);
    const controller = new AbortController(); chatAbort.current = controller;

    try {
      const reply = await sendAgentChat({
        signal: controller.signal,
        messages: [...messages, userMsg],
        llmConfig,
        context: {
          currentJob: currentJob
            ? {
                title: currentJob.title,
                company: currentJob.company,
                location: currentJob.location,
                description: currentJob.description,
              }
            : undefined,
          resumeSummary: resume
            ? {
                displayName: resume.profile.displayName,
                headline: resume.profile.headline,
                skills: resume.skills,
                recentExperience: resume.experiences[0]?.title
                  ? `${resume.experiences[0].org || ""}: ${resume.experiences[0].title}`
                  : undefined,
              }
            : undefined,
        },
      });
      if (!controller.signal.aborted) setMessages((prev) => [...prev, reply]);
    } catch (err) {
      if (controller.signal.aborted) return;
      const errorMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: "assistant",
        content: err instanceof Error ? `⚠️ ${err.message}` : t("抱歉，对话服务出现异常，请检查 AI 配置。", "Sorry, chat service failed. Check AI configuration."),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      if (chatAbort.current === controller) { chatAbort.current = undefined; setChatLoading(false); }
    }
  };

  // Copy helper
  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Resume application
  const handleApply = async () => {
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

    if(!acceptedList.length||resuming)return;
    if (/^ct_[a-f0-9]{32}$/.test(threadId)) {
      setResuming(true);
      try{await resumeJdMatch({
        threadId,
        decisions,
        currentProposals: proposals,
        llmConfig,
        matching:{rawJd:currentJob?.description??"",...jdMatchResumeMaterial(resume)},
      });}catch(error){setErrorNotice(error instanceof Error?error.message:"任务选择未确认，未应用。");return;}
      finally{setResuming(false);}
    }

    const company = currentJob?.company || job?.company || "目标公司";
    const title = currentJob?.title || job?.title || "岗位";
    const customResumeName = `${company} · ${title} 定制版`;

    onApplyToResume({
      acceptedProposals: acceptedList,
      customResumeName,
      targetJobTitle: title,
      targetCompany: company,
    });

    onClose();
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

    return { verified, claimed, gaps, total, score, acceptedCount };
  }, [proposals, decisions]);

  const gapProposals = useMemo(() => (Array.isArray(proposals) ? proposals : []).filter((p) => p.evidenceType === "gap"), [proposals]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 pointer-events-none overflow-hidden transition-opacity">
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="drawer-title"
        className="fixed inset-y-0 right-0 flex max-w-full pl-6 pointer-events-none"
      >
        <div
          className={`w-screen ${
            drawerWidth === "wide" ? "max-w-4xl" : "max-w-2xl"
          } bg-white shadow-[-12px_0_36px_rgba(0,0,0,0.14)] border-l border-slate-200 flex flex-col h-full transform transition-all ease-in-out duration-200 animate-in slide-in-from-right pointer-events-auto`}
        >
          {/* ── Top Header ────────────────────────────────────────────── */}
          <WorkspaceRecoveryNotice {...recovery} />
          <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-900 text-white shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <Bot size={20} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="drawer-title" className="text-base font-semibold truncate text-white">
                    {t("AI 岗位匹配与求职助手", "AI Job Match & Copilot")}
                  </h2>
                  {threadId && (
                    <span className="text-[10px] font-mono text-slate-400 px-1" title={threadId}>
                      #{threadId.slice(-6)}
                    </span>
                  )}
                  {agentHostOnline === false && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30" title={t("本机服务连接尚未确认。模型请求仍只走统一任务，不会浏览器直连或自动切换 API。", "Host connection is unconfirmed. Inference uses tasks only, without direct-browser calls or automatic API fallback.")}>
                      {t("连接待确认", "Connection unconfirmed")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-slate-400 truncate">
                    {currentJob?.title ? `${currentJob.company} · ${currentJob.title}` : t("智能拆解 JD，逐条核实履历契合点", "Inspect JD and match with resume facts")}
                  </p>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>{t("分屏协同 · 左侧可自由操作", "Split copilot · Left side interactive")}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDrawerWidth((w) => (w === "standard" ? "wide" : "standard"))}
                title={drawerWidth === "standard" ? t("展开更宽视窗", "Expand width") : t("恢复标准宽度", "Standard width")}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
              >
                {drawerWidth === "standard" ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
              </button>
              <button
                type="button"
                onClick={onOpenConfig}
                title={t("AI 模型配置", "AI configuration")}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
              >
                <Settings2 size={18} />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("关闭", "Close")}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
          </header>

          {/* ── AI Key Notice Banner ─────────────────────────────────── */}
          {!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama" && (
            <div className="flex items-center justify-between gap-3 px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/25 text-amber-800 text-xs shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle size={15} className="text-amber-600 shrink-0" />
                <span className="truncate">
                  {t("当前未配置 AI 模型 API Key，无法调用真实大模型推理与对话。", "AI model API Key not configured. Real AI reasoning is disabled.")}
                </span>
              </div>
              <button
                type="button"
                onClick={onOpenConfig}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 text-white font-semibold hover:bg-amber-700 transition shrink-0 cursor-pointer shadow-2xs"
              >
                <Settings2 size={13} />
                <span>{t("立即配置模型", "Configure API Key")}</span>
              </button>
            </div>
          )}

          {/* ── Upper Section: Current Job & Match Overview ─────────── */}
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 shrink-0 space-y-3">
            {/* 1. Job Setup Form (When no job or when user clicks Change Job) */}
            {(!currentJob?.description || isEditingJob) && (
              <div className="bg-white rounded-xl p-4 border border-emerald-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Target size={16} className="text-emerald-600" />
                    <h3 className="text-xs font-bold text-slate-900">
                      {isEditingJob ? t("编辑 / 更换目标岗位", "Edit / Change Target Job") : t("设定目标岗位与 JD", "Set Target Job & Paste JD")}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setInputTitle("资深前端/全栈架构师");
                        setInputCompany("某知名高科技企业");
                        setInputSalary("35k-50k · 16薪");
                        setInputLocation("上海 / 远程");
                        setInputDescription(`岗位职责：
1. 负责核心业务中台与高并发系统架构演进，主导微前端与组件库技术标准落地；
2. 推进系统性能治理与工程化建设，首屏性能与交互流畅度达到行业领先水平；
3. 协同后端与产品团队，落地多端一体化与自动化测试流程，保障系统 99.99% 高可用；
4. 深度探索前沿 AI Agent 与大语言模型在研发流程及产品功能中的结合与落地。

任职要求：
1. 本科及以上学历，5年以上现代前端或全栈工程经验，有大型分布式/高流量系统经验；
2. 熟练掌握 React / TypeScript / Node.js 等核心栈，具备优秀的系统架构设计与抽象能力；
3. 具备扎实的工程化与性能调优功底，有实际性能指标量化突破经验者优先；
4. 优秀的沟通协调、跨团队推动能力与自驱攻坚精神。`);
                      }}
                      className="text-[11px] text-emerald-700 hover:text-emerald-900 hover:underline flex items-center gap-1 font-medium cursor-pointer"
                    >
                      <Sparkles size={12} />
                      <span>{t("载入范例岗位 JD", "Load Sample JD")}</span>
                    </button>
                    {isEditingJob && currentJob?.description && (
                      <button
                        type="button"
                        onClick={() => setIsEditingJob(false)}
                        className="text-[11px] text-slate-500 hover:text-slate-800 px-2 py-0.5 rounded border border-slate-200 cursor-pointer"
                      >
                        {t("取消", "Cancel")}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">{t("职位名称", "Job Title")}</label>
                    <input
                      type="text"
                      value={inputTitle}
                      onChange={(e) => setInputTitle(e.target.value)}
                      placeholder={t("例如：资深前端工程师 / 架构师", "e.g. Senior Frontend Engineer")}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">{t("目标公司", "Company")}</label>
                    <input
                      type="text"
                      value={inputCompany}
                      onChange={(e) => setInputCompany(e.target.value)}
                      placeholder={t("例如：字节跳动 / 腾讯 / 创新企业", "e.g. Acme Inc.")}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">{t("岗位 JD 详细要求 (必填)", "Job Description (Required)")}</label>
                  <textarea
                    value={inputDescription}
                    onChange={(e) => setInputDescription(e.target.value)}
                    rows={4}
                    placeholder={t("请在此粘贴招聘 JD 的职责描述与任职要求...", "Paste job description, requirements and responsibilities here...")}
                    className="w-full p-2.5 rounded-lg border border-slate-200 text-xs font-mono leading-relaxed focus:ring-1 focus:ring-emerald-500 focus:outline-none resize-y"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    disabled={loading || !inputDescription.trim()}
                    onClick={() => {
                      const newJob: DrawerJobContext = {
                        title: inputTitle.trim() || t("目标职位", "Target Position"),
                        company: inputCompany.trim() || t("目标企业", "Target Company"),
                        salary: inputSalary.trim() || undefined,
                        location: inputLocation.trim() || undefined,
                        description: inputDescription.trim(),
                      };
                      setCurrentJob(newJob);
                      setIsEditingJob(false);
                      void runMatching(newJob.description);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition disabled:opacity-50 shadow-2xs cursor-pointer"
                  >
                    <Sparkles size={14} />
                    <span>{t("授权当前简历并开始分析", "Share current resume & analyze")}</span>
                  </button>
                </div>
              </div>
            )}

            {/* 2. Job summary card (when a job is loaded and not editing) */}
            {currentJob && !isEditingJob && (
              <div className="bg-white rounded-xl p-3.5 border border-slate-200 shadow-2xs space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">{currentJob.title}</h3>
                    <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
                      <Building2 size={13} className="text-slate-400" />
                      <span>{currentJob.company}</span>
                      {currentJob.location && (
                        <>
                          <span className="text-slate-300">·</span>
                          <MapPin size={13} className="text-slate-400" />
                          <span>{currentJob.location}</span>
                        </>
                      )}
                      {currentJob.salary && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span className="font-semibold text-emerald-700">{currentJob.salary}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsEditingJob(true)}
                      className="text-xs text-emerald-700 hover:text-emerald-900 px-2 py-1 rounded-md border border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100/50 flex items-center gap-1 cursor-pointer font-medium"
                    >
                      <Edit3 size={12} />
                      <span>{t("更换岗位 / 编辑 JD", "Edit JD")}</span>
                    </button>
                    {currentJob.sourceUrl && (
                      <a
                        href={currentJob.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50"
                      >
                        <span>{currentJob.sourcePlatform || t("原文", "Source")}</span>
                        <ExternalLink size={12} />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowRawJd(!showRawJd)}
                      className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
                    >
                      <FileText size={12} />
                      <span>{showRawJd ? t("收起 JD", "Hide JD") : t("查看 JD", "View JD")}</span>
                    </button>
                  </div>
                </div>

                {showRawJd && (
                  <div className="mt-2 p-2.5 bg-slate-50 rounded-lg text-xs text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono border border-slate-200">
                    {currentJob.description}
                  </div>
                )}

                {structuredJd && structuredJd.techStack && structuredJd.techStack.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
                    <span className="text-[11px] text-slate-400 font-medium">{t("技能要求:", "Skills:")}</span>
                    {structuredJd.techStack.map((tech) => (
                      <span key={tech} className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {tech}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Match Overview Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-white rounded-xl border border-slate-200 shadow-2xs">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-11 w-11 rounded-xl bg-emerald-50 text-emerald-700 font-bold text-sm border border-emerald-200">
                  {stats.score}%
                </div>
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                    <span>{stats.score >= 80 ? t("综合匹配度：高", "Match level: High") : stats.score >= 60 ? t("综合匹配度：良好", "Match level: Good") : t("匹配度：待补齐", "Match level: Gaps found")}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1 text-emerald-700 font-medium">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      {stats.verified} {t("项已核实", "Verified")}
                    </span>
                    <span className="text-slate-300">|</span>
                    <span className="flex items-center gap-1 text-amber-700 font-medium">
                      <span className="h-2 w-2 rounded-full bg-amber-500" />
                      {stats.claimed} {t("项待核验", "Claimed")}
                    </span>
                    <span className="text-slate-300">|</span>
                    <span className="flex items-center gap-1 text-rose-700 font-medium">
                      <span className="h-2 w-2 rounded-full bg-rose-500" />
                      {stats.gaps} {t("项需防守", "Gaps")}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (currentJob?.description) {
                      void runMatching(currentJob.description);
                    } else {
                      setIsEditingJob(true);
                    }
                  }}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:border-slate-300 transition disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw size={12} className={loading ? "animate-spin text-emerald-600" : ""} />
                  <span>{loading ? t("匹配分析中…", "Analyzing…") : t("授权当前简历并分析", "Share resume & analyze")}</span>
                </button>
              </div>
            </div>

            {/* Error Notice */}
            {errorNotice && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
                <AlertTriangle size={14} className="shrink-0" />
                <span className="truncate">{errorNotice}</span>
              </div>
            )}
          </div>

          {/* ── Mode Switcher (Tabs) ─────────────────────────────────── */}
          <div className="flex items-center px-6 border-b border-slate-200 bg-white shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab("proposals")}
              className={`flex items-center gap-2 py-3 px-1 text-xs font-semibold border-b-2 mr-6 transition ${
                activeTab === "proposals"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <FileCheck2 size={16} />
              <span>{t("提案卡片审核 (Human-in-the-Loop)", "Proposal Review")}</span>
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">
                {proposals.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("decomposition")}
              className={`flex items-center gap-2 py-3 px-1 text-xs font-semibold border-b-2 mr-6 transition ${
                activeTab === "decomposition"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Layers size={16} />
              <span>{t("JD 原句深度拆解", "JD Breakdown")}</span>
              {decomposedJd && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-50 text-emerald-700 font-mono">
                  {decomposedJd.responsibilities.length + decomposedJd.hardRequirements.length + decomposedJd.preferredQualifications.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("defenses")}
              className={`flex items-center gap-2 py-3 px-1 text-xs font-semibold border-b-2 mr-6 transition ${
                activeTab === "defenses"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <ShieldAlert size={16} />
              <span>{t("面试攻防防御", "Interview Defense")}</span>
              {alignmentReport && alignmentReport.interviewDefenses.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-800 font-mono">
                  {alignmentReport.interviewDefenses.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("chat")}
              className={`flex items-center gap-2 py-3 px-1 text-xs font-semibold border-b-2 transition ${
                activeTab === "chat"
                  ? "border-emerald-600 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <MessageSquare size={16} />
              <span>{t("助理协同对话 (Agent Chat)", "Agent Chat")}</span>
              {messages.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-700 font-mono">
                  {messages.length}
                </span>
              )}
            </button>
          </div>

          {/* ── Middle Section: Proposals / Chat Tab ─────────────────── */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-0 bg-slate-50/50">
            {/* TAB 1: Proposals Review */}
            {activeTab === "proposals" && (
              <div className="space-y-4">
                {loading && (
                  <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-500">
                    <Loader2 size={28} className="animate-spin text-emerald-600" />
                    <p className="text-xs font-medium">{t("正在逐条核对岗位要求与已授权经历…", "Checking each job requirement against the shared experience…")}</p>
                  </div>
                )}

                {!loading && proposals.length === 0 && (
                  <div className="py-12 text-center text-slate-500 space-y-2">
                    <Target size={32} className="mx-auto text-slate-300" />
                    <p className="text-xs font-medium">{t("暂无提案数据，请点击「重新分析」", "No proposals yet. Click Re-match.")}</p>
                  </div>
                )}

                {!loading && proposals.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                      <span>{t("逐条审核修改建议，采纳后可一键同步至定制简历：", "Review each recommendation before applying to your custom resume:")}</span>
                      <span className="font-medium text-emerald-700">
                        {t(`已采纳 ${stats.acceptedCount} / ${stats.total} 条`, `${stats.acceptedCount} / ${stats.total} Accepted`)}
                      </span>
                    </div>

                    {proposals.map((proposal, idx) => {
                      const decision = decisions[proposal.id];
                      const isAccepted = decision?.status === "accepted";
                      const isEdited = decision?.status === "edited";
                      const isRejected = decision?.status === "rejected";
                      const isEditing = editingProposalId === proposal.id;

                      const displayText = isEdited ? decision.editedSuggestion : proposal.suggestion;

                      return (
                        <div
                          key={proposal.id}
                          className={`rounded-xl border transition p-4 bg-white shadow-2xs space-y-3 ${
                            isAccepted
                              ? "border-emerald-500/80 bg-emerald-50/20 ring-1 ring-emerald-500/30"
                              : isEdited
                                ? "border-blue-500/80 bg-blue-50/20 ring-1 ring-blue-500/30"
                                : isRejected
                                  ? "border-slate-200 bg-slate-100/60 opacity-60"
                                  : "border-slate-200 hover:border-slate-300"
                          }`}
                        >
                          {/* Card Header: Requirement & Tag */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2 min-w-0">
                              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-600 shrink-0 mt-0.5">
                                {idx + 1}
                              </span>
                              <div>
                                <h4 className="text-xs font-bold text-slate-900 leading-snug">
                                  {proposal.jdItem}
                                </h4>
                              </div>
                            </div>

                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 border ${
                                proposal.evidenceType === "verified"
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  : proposal.evidenceType === "claimed"
                                    ? "bg-amber-50 text-amber-700 border-amber-200"
                                    : "bg-rose-50 text-rose-700 border-rose-200"
                              }`}
                            >
                              {proposal.evidenceType === "verified"
                                ? t("已核实经历", "Verified")
                                : proposal.evidenceType === "claimed"
                                  ? t("待核实补充", "Claimed")
                                  : t("经历缺口", "Gap")}
                            </span>
                          </div>

                          {/* Suggestion text or Inline Editor */}
                          {isEditing ? (
                            <div className="space-y-2">
                              <textarea
                                value={editedText}
                                onChange={(e) => setEditedText(e.target.value)}
                                rows={3}
                                className="w-full rounded-lg border border-blue-300 p-2.5 text-xs text-slate-800 outline-none focus:border-blue-500 font-sans leading-relaxed"
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={cancelEdit}
                                  className="px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
                                >
                                  {t("取消", "Cancel")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveEdit(proposal.id)}
                                  className="px-3 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                                >
                                  {t("保存修改", "Save edit")}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="p-3 bg-slate-50/80 rounded-lg border border-slate-100 text-xs text-slate-800 leading-relaxed font-sans">
                              {displayText}
                            </div>
                          )}

                          {/* Rationale note */}
                          <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                            <Lightbulb size={12} className="text-amber-500 shrink-0" />
                            <span>{proposal.rationale}</span>
                          </p>

                          {/* Action Buttons */}
                          <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                            <div className="flex items-center gap-1.5">
                              {isAccepted && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                                  <CheckCircle2 size={13} />
                                  {t("已采纳", "Accepted")}
                                </span>
                              )}
                              {isEdited && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700">
                                  <Edit3 size={13} />
                                  {t("已微调并采纳", "Edited & Accepted")}
                                </span>
                              )}
                              {isRejected && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                                  <X size={13} />
                                  {t("已忽略", "Rejected")}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  triggerAgentGuide({
                                    claimId: proposal.profileEntryId,
                                    text: proposal.suggestion,
                                    label: t("🤖 Agent 建议定位此处", "🤖 Locate here"),
                                    actionType: "suggest",
                                  });
                                }}
                                title={t("在左侧高亮定位对应履历并展开", "Locate and spotlight in left editor")}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition"
                              >
                                <Crosshair size={12} />
                                <span>{t("定位", "Locate")}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDecision(proposal.id, "accepted")}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                                  isAccepted
                                    ? "bg-emerald-600 text-white"
                                    : "bg-slate-100 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                                }`}
                              >
                                <Check size={12} />
                                <span>{t("采纳", "Accept")}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => startEdit(proposal)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                                  isEdited
                                    ? "bg-blue-600 text-white"
                                    : "bg-slate-100 text-slate-700 hover:bg-blue-50 hover:text-blue-700"
                                }`}
                              >
                                <Edit3 size={12} />
                                <span>{t("微调", "Edit")}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDecision(proposal.id, "rejected")}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                                  isRejected
                                    ? "bg-slate-600 text-white"
                                    : "bg-slate-100 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                                }`}
                              >
                                <X size={12} />
                                <span>{t("忽略", "Reject")}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: JD 原句深度拆解 */}
            {activeTab === "decomposition" && (
              <div className="space-y-4">
                {!decomposedJd ? (
                  <div className="py-12 text-center text-slate-500 space-y-2">
                    <Target size={32} className="mx-auto text-slate-300" />
                    <p className="text-xs font-medium">{t("暂无 JD 描述，请在上方输入或选择岗位", "No JD provided. Enter or select a job above.")}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Metrics Banner */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs text-center">
                        <div className="text-lg font-bold text-slate-800">{decomposedJd.responsibilities.length}</div>
                        <div className="text-[11px] text-slate-500">{t("核心职责", "Responsibilities")}</div>
                      </div>
                      <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs text-center">
                        <div className="text-lg font-bold text-emerald-700">{decomposedJd.hardRequirements.length}</div>
                        <div className="text-[11px] text-slate-500">{t("硬性门槛", "Hard Requirements")}</div>
                      </div>
                      <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs text-center">
                        <div className="text-lg font-bold text-blue-700">{decomposedJd.preferredQualifications.length}</div>
                        <div className="text-[11px] text-slate-500">{t("加分优先", "Preferences")}</div>
                      </div>
                      <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs text-center">
                        <div className="text-lg font-bold text-purple-700">{decomposedJd.detectedTechStack.length}</div>
                        <div className="text-[11px] text-slate-500">{t("识别技术栈", "Tech Stack")}</div>
                      </div>
                    </div>

                    {/* Detected Tech Stack Tags */}
                    {decomposedJd.detectedTechStack.length > 0 && (
                      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-2">
                        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                          <Sparkles size={14} className="text-purple-600" />
                          <span>{t("从 JD 原文中精准提取的关键技术栈", "Extracted Tech Stack Keywords")}</span>
                        </h4>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {decomposedJd.detectedTechStack.map((tech) => (
                            <span key={tech} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                              {tech}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Section 1: Hard Requirements */}
                    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500" />
                          <span>{t("任职资格与硬性门槛（原句保真）", "Hard Requirements (Exact Quotes)")}</span>
                        </h4>
                        <span className="text-[11px] text-slate-400 font-medium">{decomposedJd.hardRequirements.length} 条</span>
                      </div>
                      <div className="space-y-2">
                        {decomposedJd.hardRequirements.map((item, idx) => (
                          <div key={item.id || idx} className="p-3 rounded-lg bg-slate-50/70 border border-slate-200/80 text-xs space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-mono text-slate-800 leading-relaxed select-text">
                                {item.originalQuote}
                              </span>
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 bg-emerald-100 text-emerald-800">
                                {item.category === "experience" ? t("年限经验", "Experience") : item.category === "tech_stack" ? t("技术栈", "Tech Stack") : item.category === "education" ? t("学历要求", "Education") : item.category === "domain" ? t("行业领域", "Domain") : t("要求", "Required")}
                              </span>
                            </div>
                            {item.keywords.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {item.keywords.map((kw) => (
                                  <span key={kw} className="px-1.5 py-0.5 rounded text-[10px] bg-slate-200/80 text-slate-700 font-mono">
                                    #{kw}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Section 2: Core Responsibilities */}
                    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-blue-500" />
                          <span>{t("核心岗位职责（原句保真）", "Core Responsibilities (Exact Quotes)")}</span>
                        </h4>
                        <span className="text-[11px] text-slate-400 font-medium">{decomposedJd.responsibilities.length} 条</span>
                      </div>
                      <div className="space-y-2">
                        {decomposedJd.responsibilities.map((item, idx) => (
                          <div key={item.id || idx} className="p-3 rounded-lg bg-slate-50/70 border border-slate-200/80 text-xs space-y-1.5">
                            <div className="font-mono text-slate-800 leading-relaxed select-text">
                              {item.originalQuote}
                            </div>
                            {item.keywords.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {item.keywords.map((kw) => (
                                  <span key={kw} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 font-mono">
                                    #{kw}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Section 3: Preferences & Constraints */}
                    {(decomposedJd.preferredQualifications.length > 0 || decomposedJd.constraints.length > 0) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {decomposedJd.preferredQualifications.length > 0 && (
                          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-2">
                            <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 border-b border-slate-100 pb-2">
                              <span>🌟 {t("优先加分项", "Preferred Qualifications")}</span>
                            </h4>
                            <div className="space-y-1.5">
                              {decomposedJd.preferredQualifications.map((item, idx) => (
                                <p key={idx} className="text-xs text-slate-700 bg-slate-50 p-2 rounded border border-slate-100 font-mono">
                                  {item.originalQuote}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                        {decomposedJd.constraints.length > 0 && (
                          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-2">
                            <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 border-b border-slate-100 pb-2">
                              <span>📍 {t("地点与基础约束", "Constraints & Location")}</span>
                            </h4>
                            <div className="space-y-1.5">
                              {decomposedJd.constraints.map((item, idx) => (
                                <p key={idx} className="text-xs text-slate-700 bg-slate-50 p-2 rounded border border-slate-100 font-mono">
                                  {item.originalQuote}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: 面试攻防防御 */}
            {activeTab === "defenses" && (
              <div className="space-y-4">
                {!alignmentReport || alignmentReport.interviewDefenses.length === 0 ? (
                  <div className="py-12 text-center text-slate-500 space-y-2">
                    <ShieldCheck size={32} className="mx-auto text-emerald-400" />
                    <p className="text-xs font-medium">
                      {t("当前岗位与简历匹配极高，暂未检测到高风险门槛追问或薄弱项", "High alignment detected. No high-risk defense questions flagged.")}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Top Guide Banner */}
                    <div className="p-3.5 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/80 rounded-xl space-y-1">
                      <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                        <Sparkles size={14} className="text-amber-600" />
                        <span>{t("针对性面试追问预演与攻防策略", "Targeted Interview Defense & Strategy")}</span>
                      </div>
                      <p className="text-[11px] text-amber-800/80 leading-relaxed">
                        {t(
                          "根据岗位要求与当前自述生成提问方向，不代表已核实的能力或缺口。先核对本人经历；没有做过的内容按假设讨论，不补造年限、上线或量化成果。",
                          "Questions come from the job and current self-report, not verified abilities or gaps. Confirm personal experience; frame unfamiliar work as hypothetical without inventing tenure, production delivery or metrics."
                        )}
                      </p>
                    </div>

                    {/* Defense Cards */}
                    <div className="space-y-3.5">
                      {alignmentReport.interviewDefenses.map((defense) => {
                        const isHighRisk = defense.riskLevel === "high";
                        const isMedRisk = defense.riskLevel === "medium";
                        return (
                          <div
                            key={defense.id}
                            className={`p-4 rounded-xl border transition shadow-sm bg-white ${
                              isHighRisk
                                ? "border-rose-200 hover:border-rose-300"
                                : isMedRisk
                                ? "border-amber-200 hover:border-amber-300"
                                : "border-slate-200 hover:border-slate-300"
                            }`}
                          >
                            {/* Card Top: Badges & Topic */}
                            <div className="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-slate-100">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                    isHighRisk
                                      ? "bg-rose-100 text-rose-700 border border-rose-200"
                                      : isMedRisk
                                      ? "bg-amber-100 text-amber-800 border border-amber-200"
                                      : "bg-blue-100 text-blue-700 border border-blue-200"
                                  }`}
                                >
                                  {isHighRisk
                                    ? t("高风险攻防 · 硬门槛", "High Risk · Hard Gate")
                                    : isMedRisk
                                    ? t("中风险考察 · 场景排障/并发", "Medium Risk · Tech Drill")
                                    : t("实战考察 · 业务深度", "Standard Drill · Experience")}
                                </span>
                                <span className="text-xs font-semibold text-slate-700">
                                  {defense.targetTopic}
                                </span>
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  const textToCopy = `【面试追问】${defense.question}\n\n【核心攻防策略】${defense.coreDefenseStrategy}\n\n【答辩提纲】\n${defense.suggestedAnswerFramework.join("\n")}`;
                                  void navigator.clipboard.writeText(textToCopy);
                                  setCopiedId(defense.id);
                                  setTimeout(() => setCopiedId(null), 2000);
                                }}
                                className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded border border-slate-200 transition"
                              >
                                {copiedId === defense.id ? (
                                  <>
                                    <Check size={12} className="text-emerald-600" />
                                    <span className="text-emerald-600 font-medium">{t("已复制", "Copied")}</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy size={12} />
                                    <span>{t("复制提纲", "Copy Notes")}</span>
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Question Callout */}
                            <div className="p-3 bg-slate-50/80 rounded-lg border border-slate-200/60 mb-3">
                              <div className="text-xs font-bold text-slate-900 leading-snug">
                                ❓ {defense.question}
                              </div>
                            </div>

                            {/* Core Strategy */}
                            <div className="mb-3 text-xs leading-relaxed text-slate-700">
                              <span className="font-bold text-emerald-800">
                                🎯 {t("防守核心要点：", "Defense Core Strategy: ")}
                              </span>
                              {defense.coreDefenseStrategy}
                            </div>

                            {/* Answer Framework Steps */}
                            <div className="space-y-1.5 pt-2 border-t border-slate-100">
                              <div className="text-[11px] font-semibold text-slate-500">
                                📝 {t("结构化回答提纲（建议结合真实经历）：", "Structured Answer Outline:")}
                              </div>
                              <div className="space-y-1 pl-1">
                                {defense.suggestedAnswerFramework.map((step, sIdx) => (
                                  <div
                                    key={sIdx}
                                    className="text-xs text-slate-600 leading-relaxed pl-2 border-l-2 border-emerald-300/60"
                                  >
                                    {step}
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Mock Practice Button */}
                            <div className="mt-3.5 pt-2.5 border-t border-dashed border-slate-200 flex justify-end">
                              <button
                                type="button"
                                onClick={() => void (async()=>{
                                  try{
                                    const selection=await createInterviewSelection({matching:{rawJd:currentJob?.description||inputDescription,...jdMatchResumeMaterial(resume)},focus:{question:defense.question,gapItem:defense.targetTopic,corePoints:[defense.coreDefenseStrategy,...defense.suggestedAnswerFramework]}});
                                    if(!requestMockInterview(agent?.workspaceKey??workspaceKey,selection))throw new Error("AI 职业顾问尚未就绪，请先打开顾问工作区；没有退回普通聊天或发送资料。");
                                    onClose();
                                  }catch(error){setErrorNotice(error instanceof Error?error.message:"对练会话未能打开，未发送资料。");}
                                })()}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
                              >
                                <Bot size={13} />
                                <span>{t("与 Copilot 模拟对练这道题 →", "Practice with Copilot →")}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: Agent Chat */}
            {activeTab === "chat" && (
              <div className="flex flex-col h-full space-y-4">
                {/* Conversation List */}
                <div className="space-y-4 flex-1">
                  {messages.length === 0 && (
                    <div className="p-4 bg-white rounded-2xl border border-slate-200 text-center space-y-3">
                      <div className="h-10 w-10 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                        <Sparkles size={20} />
                      </div>
                      <h4 className="text-xs font-bold text-slate-900">
                        {t("你好！我是你的 BetterMe 专属求职助手", "Hello! I am your BetterMe Career Copilot")}
                      </h4>
                      <p className="text-[11px] text-slate-500 leading-relaxed max-w-sm mx-auto">
                        {t("你可以让我协助调研雇主工商控股背景、按 STAR 原则修改经历细节、寻找同类机会或演练面试答辩。", "Ask me to inspect companies, optimize resume claims with STAR, or prep interview strategies.")}
                      </p>

                      {/* Quick Prompt Chips */}
                      <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => void handleSendMessage(`帮我调研 ${job?.company || "这家公司"} 的企业背景与实控人情况`)}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 text-xs text-slate-700 transition"
                        >
                          🏢 {t("查公司工商背景", "Inspect company background")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            triggerAgentGuide({
                              section: "headline",
                              label: t("🤖 Agent 正在针对个人优势提出建议", "🤖 Agent refining headline"),
                            });
                            void handleSendMessage("帮我根据当前岗位要求，优化个人优势与技术栈表述");
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 text-xs text-slate-700 transition"
                        >
                          ✍️ {t("优化个人优势", "Refine headline & skills")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            triggerAgentGuide({
                              section: "experience",
                              label: t("🤖 Agent 正在结合经历分析防守策略", "🤖 Analyzing experiences for interview"),
                            });
                            void handleSendMessage("针对本岗位的技术难点与潜在缺口，提供面试应答防守策略");
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 text-xs text-slate-700 transition"
                        >
                          💡 {t("面试防守策略", "Interview defense tips")}
                        </button>
                      </div>
                    </div>
                  )}

                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} space-y-2`}
                    >
                      <div
                        className={`rounded-2xl px-4 py-2.5 text-xs max-w-[85%] leading-relaxed ${
                          msg.role === "user"
                            ? "bg-slate-900 text-white rounded-br-xs"
                            : "bg-white text-slate-800 border border-slate-200 shadow-2xs rounded-bl-xs"
                        }`}
                      >
                        {msg.role === "assistant" && <>
                          <AgentReplyMeta meta={msg.meta} compact />
                          {msg.id === lastAssistantMessageId && msg.meta?.status === "truncated" && (
                            <button type="button" className="agent-continue-reply" onClick={() => void handleSendMessage(t("请从上一条不完整回复的结束处继续，避免重复已写内容，并补完尚未回答的部分。", "Continue from the end of the previous incomplete reply, avoid repeating completed text, and finish any unanswered parts."))} disabled={chatLoading}>
                              {chatLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                              <span>{chatLoading ? t("正在补全…", "Continuing…") : t("继续补完", "Continue reply")}</span>
                            </button>
                          )}
                        </>}
                        <AgentMarkdownRenderer content={msg.content} isDark={false} />
                      </div>

                      {/* Render Interactive Action Cards attached to Assistant reply */}
                      {msg.actions && msg.actions.length > 0 && (
                        <div className="w-full max-w-[95%] space-y-2 pl-2">
                          {msg.actions.map((action, aIdx) => (
                            <div
                              key={aIdx}
                              className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs space-y-2.5"
                            >
                              {/* 1. Company Card */}
                              {action.type === "company_card" && (
                                <>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 font-bold text-xs text-slate-900">
                                      <Building2 size={14} className="text-emerald-600" />
                                      <span>{action.companyName}</span>
                                    </div>
                                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                                      {action.ownership || "实控人核查"}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-600 leading-relaxed">{action.summary}</p>
                                  {action.officialUrl && (
                                    <a
                                      href={action.officialUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:underline"
                                    >
                                      <span>{t("访问招聘官网 / 工商链接", "Visit careers website")}</span>
                                      <ExternalLink size={11} />
                                    </a>
                                  )}
                                </>
                              )}

                              {/* 2. Resume Proposal Card */}
                              {action.type === "resume_proposal" && (
                                <>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-bold text-slate-900 flex items-center gap-1">
                                      <Edit3 size={13} className="text-blue-600" />
                                      {t("建议修改项", "Suggested Edit")} · {action.targetSection}
                                    </span>
                                  </div>
                                  <div className="p-2.5 bg-blue-50/50 border border-blue-200/80 rounded-lg text-xs text-slate-800 leading-relaxed font-sans">
                                    {action.proposedText}
                                  </div>
                                  <p className="text-[11px] text-slate-500 leading-relaxed">
                                    💡 {action.rationale}
                                  </p>
                                  <div className="pt-1 flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        triggerAgentGuide({
                                          section: action.targetSection,
                                          text: action.proposedText,
                                          label: t(`🤖 Agent 建议定位: ${action.targetSection}`, `🤖 Locate: ${action.targetSection}`),
                                          actionType: "suggest",
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900 border border-blue-200 px-2.5 py-1 rounded-md bg-blue-50/50 hover:bg-blue-100/50 transition"
                                    >
                                      <Crosshair size={12} />
                                      <span>{t("定位左侧", "Locate on left")}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        // Append to proposals list
                                        const newProp: MatchProposal = {
                                          id: `prop-chat-${Date.now()}`,
                                          jdItem: `${action.targetSection} 优化`,
                                          evidenceType: "verified",
                                          suggestion: action.proposedText || "",
                                          rationale: action.rationale || "来自 Agent 实时对话建议",
                                        };
                                        setProposals((p) => [newProp, ...p]);
                                        setDecisions((d) => ({ ...d, [newProp.id]: { status: "accepted" } }));
                                        setActiveTab("proposals");
                                        triggerAgentGuide({
                                          section: action.targetSection,
                                          text: action.proposedText,
                                          label: t("✨ 已采纳此项建议至提案列表", "✨ Accepted suggestion to proposals"),
                                          actionType: "applied",
                                        });
                                      }}
                                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-2xs transition"
                                    >
                                      <Check size={12} />
                                      <span>{t("采纳并加入定制简历清单", "Accept & add to proposals")}</span>
                                    </button>
                                  </div>
                                </>
                              )}

                              {/* 3. Interview Defense Card */}
                              {action.type === "interview_defense" && (
                                <>
                                  <div className="flex items-center gap-1.5 font-bold text-xs text-amber-800">
                                    <ShieldCheck size={14} className="text-amber-600" />
                                    <span>{t("面试答辩攻防点", "Interview defense")}：{action.gapItem}</span>
                                  </div>
                                  <div className="text-xs text-slate-700 space-y-1">
                                    <p className="font-semibold text-slate-800 text-[11px]">【{t("防守策略", "Strategy")}】：{action.strategy}</p>
                                    <div className="p-2.5 bg-amber-50/60 border border-amber-200/80 rounded-lg text-[11px] leading-relaxed text-slate-800">
                                      “{action.sampleAnswer}”
                                    </div>
                                  </div>
                                  <div className="pt-1 flex justify-end">
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(action.sampleAnswer || "", `card-${aIdx}`)}
                                      className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900 border border-slate-200 px-2 py-1 rounded bg-slate-50"
                                    >
                                      {copiedId === `card-${aIdx}` ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                                      <span>{copiedId === `card-${aIdx}` ? t("已复制话术", "Copied") : t("复制答辩话术", "Copy script")}</span>
                                    </button>
                                  </div>
                                </>
                              )}

                              {/* 5. 3D Architecture Badge Card */}
                              {action.type === "badge_3d" && (
                                <div className="space-y-2.5">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-bold text-purple-900 flex items-center gap-1.5">
                                      <Sparkles size={13} className="text-purple-600" />
                                      {action.title}
                                    </span>
                                    <span className="text-[9px] px-2 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-800 font-semibold">
                                      ⚡️ vork Metal 光追 {action.renderDurationMs ? `· ${(action.renderDurationMs / 1000).toFixed(1)}s` : ""}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-700 leading-relaxed font-medium">
                                    {action.highlight}
                                  </p>
                                  {action.imageUrl && (
                                    <div className="relative rounded-lg overflow-hidden border border-purple-200 bg-black/30">
                                      <img src={action.imageUrl} alt={action.title} className="w-full h-36 object-cover" />
                                    </div>
                                  )}
                                  <div className="pt-1 flex justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(`![${action.title}](${action.imageUrl || ""})\n> **${action.title}**\n> ${action.highlight}`, `badge-${aIdx}`)}
                                      className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900 border border-slate-200 px-2.5 py-1 rounded-md bg-slate-50 hover:bg-slate-100"
                                    >
                                      {copiedId === `badge-${aIdx}` ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                                      <span>{copiedId === `badge-${aIdx}` ? t("已复制引用", "Copied") : t("复制作品集 Markdown", "Copy Markdown")}</span>
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {chatLoading && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 py-2 pl-2">
                      <Loader2 size={14} className="animate-spin text-emerald-600" />
                      <span>{t("Agent 思考中…", "Agent thinking…")}</span>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                {/* Quick Prompts */}
                <div className="flex items-center gap-1.5 overflow-x-auto py-1 text-[11px] shrink-0">
                  <span className="text-slate-400 shrink-0 font-medium">{t("快捷指令:", "Quick prompts:")}</span>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("帮我深入调研这家公司的控股背景、实控人与业务稳定性", "Inspect company ownership, background and stability"))}
                    disabled={chatLoading}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-white hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 border border-slate-200 text-slate-700 transition disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    🔍 {t("调研公司背景与实控人", "Inspect company background")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("根据当前岗位的 JD 要求，按 STAR 原则优化我最核心的工作经历 Bullet Point", "Optimize key work experience bullet point with STAR method"))}
                    disabled={chatLoading}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-white hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 border border-slate-200 text-slate-700 transition disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    ✍️ {t("按 STAR 优化简历经历", "Optimize resume with STAR")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("分析这个岗位面试官最可能深挖的技术考点，并为我提供高情商防守话术", "Analyze tricky interview questions and provide defense script"))}
                    disabled={chatLoading}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-white hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 border border-slate-200 text-slate-700 transition disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    🛡️ {t("面试考点与防守策略", "Interview defense tips")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSendMessage(t("针对目标岗位，分析我目前最大的技能或经历缺口，给出短期攻坚建议", "Diagnose skill gaps and suggest learning roadmap"))}
                    disabled={chatLoading}
                    className="shrink-0 px-2.5 py-1 rounded-full bg-white hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 border border-slate-200 text-slate-700 transition disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    🎯 {t("技能缺口诊断建议", "Skill gap diagnosis")}
                  </button>
                </div>

                {/* Modern AI Chat Composer Deck */}
                <div className="pt-2 border-t border-slate-200 shrink-0">
                  <div className="agent-composer-deck rounded-2xl border border-slate-200 bg-white p-2.5 space-y-2 shadow-xs transition-all">
                    <textarea
                      rows={2}
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder={t("向 Agent 提问（例如：帮我查公司实控人、优化项目经历…）", "Ask agent (e.g. inspect employer, polish resume bullet...)")}
                      className="agent-chat-textarea w-full px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 outline-none resize-none font-sans"
                    />
                    <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-400 select-none">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981] animate-pulse" />
                        <span className="font-semibold text-emerald-600">{t("AI 助手在线", "Agent Online")}</span>
                        <span className="text-slate-300 hidden sm:inline">|</span>
                        <span className="text-[10px] hidden sm:inline">{t("Enter 发送", "Enter to send")}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSendMessage()}
                        disabled={!inputMessage.trim() || chatLoading}
                        className={`agent-btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                          inputMessage.trim() && !chatLoading
                            ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-500/25 active:scale-95"
                            : "bg-slate-100 text-slate-400 disabled:opacity-40 cursor-not-allowed"
                        }`}
                      >
                        <Send size={13} />
                        <span>{t("发送", "Send")}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Lower Section: Gaps & Sticky Action Bar ──────────────── */}
          <footer className="border-t border-slate-200 bg-white p-4 shrink-0 space-y-3">
            {/* Gaps Accordion */}
            {gapProposals.length > 0 && (
              <div className="rounded-xl border border-rose-200/80 bg-rose-50/40 p-3 text-xs space-y-2">
                <button
                  type="button"
                  onClick={() => setShowGapsSummary(!showGapsSummary)}
                  className="flex items-center justify-between w-full font-semibold text-rose-900"
                >
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle size={14} className="text-rose-600" />
                    {t(`检测到 ${gapProposals.length} 项技能与经历缺口`, `${gapProposals.length} Gaps Detected`)}
                  </span>
                  {showGapsSummary ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {showGapsSummary && (
                  <ul className="space-y-1.5 pt-1 text-[11px] text-rose-800 leading-relaxed">
                    {gapProposals.map((g) => (
                      <li key={g.id} className="flex items-start gap-1.5">
                        <span className="text-rose-500 font-bold">•</span>
                        <span>
                          <strong>{g.jdItem}</strong>：{g.rationale}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="text-xs text-slate-600 font-medium">
                <span>{t("已选采纳：", "Accepted: ")}</span>
                <strong className="text-emerald-700">{stats.acceptedCount}</strong>
                <span> / {stats.total} {t("条建议", "items")}</span>
              </div>

              <div className="flex items-center gap-2">
                {onSaveOpportunity && job && (
                  <button
                    type="button"
                    onClick={() => onSaveOpportunity(job)}
                    className="px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition"
                  >
                    {t("收藏跟进", "Track job")}
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleApply}
                  disabled={stats.acceptedCount === 0 || resuming}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {resuming ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  <span>{resuming ? t("同步中...", "Syncing...") : t("一键应用到当前定制简历", "Apply to custom resume")}</span>
                </button>
              </div>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
