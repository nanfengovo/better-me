/** @jsxRuntime automatic */
import { useEffect, useRef, useState, useMemo, type ChangeEvent } from "react";
import { useUiPreferences } from "../lib/ui-preferences";
import type { LlmConfig, ProjectedResume } from "@better-me/core";
import type { ResumeEditContext, ResumeProposalTarget } from "@better-me/agent-contracts";
import {
  AlertTriangle,
  ArrowLeft,
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
  FileText,
  Lightbulb,
  Loader2,
  MapPin,
  MessageSquare,
  RefreshCw,
  Send,
  Square,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  X,
  BookmarkPlus,
  ArrowRight,
  Layers,
  GripVertical,
  PanelRightClose,
  PanelRightOpen,
  ImagePlus,
} from "lucide-react";
import { triggerAgentGuide } from "../lib/agent-guide";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { isJdLinkOnly } from "../lib/jd-import";
import { extractAndParseJobLink, type ParsedJobInfo } from "../lib/jd-link-parser";
import {
  startJdMatch,
  resumeJdMatch,
  sendAgentChat,
  chatMessagesForRequest,
  checkAgentHostHealth,
  type MatchProposal,
  type ProposalDecision,
  type StructuredJd,
  type ChatMessage,
  type ResumeTextReference,
} from "../services/agent-client";
import { getModelImageCapability, modelImageCapabilityDescription, modelImageCapabilityLabel } from "../lib/model-image-capability";
import type { DrawerJobContext } from "./JdMatchDrawer";
import { AgentMarkdownRenderer } from "./AgentMarkdownRenderer";
import { AgentReplyMeta } from "./AgentReplyMeta";
import { CareerCoachWorkspace } from "./CareerCoachWorkspace";

export interface AgentWorkspaceProps {
  workspaceKey?: string;
  active?: boolean;
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
}

interface PendingChatImage {
  name: string;
  mimeType: string;
  dataUrl: string;
}

async function prepareChatImage(file: File): Promise<PendingChatImage> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type.toLowerCase())) throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  if (file.size > 15 * 1024 * 1024) throw new Error("单张图片不能超过 15 MB");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理这张图片");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    let quality = 0.78;
    while (dataUrl.length > 4_000_000 && quality >= 0.58) {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
      quality -= 0.1;
    }
    if (dataUrl.length > 4_000_000) throw new Error("图片压缩后仍过大，请先裁剪后再上传");
    return { name: file.name.slice(0, 160) || "resume-image.jpg", mimeType: "image/jpeg", dataUrl };
  } finally {
    bitmap.close();
  }
}

// 60fps spring-eased counter hook for score animation
function useAnimatedCounter(target: number, duration = 800) {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const start = current;
    const startTime = performance.now();
    let frameId: number;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Apple-like ease-out curve
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setCurrent(Math.round(start + (target - start) * ease));
      if (progress < 1) {
        frameId = requestAnimationFrame(step);
      }
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [target, duration]);

  return current;
}

export function AgentWorkspace({
  workspaceKey = "active-resume",
  active = true,
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
}: AgentWorkspaceProps) {
  const { t, theme } = useUiPreferences();
  const isDark = theme === "dark";
  const [showCareerCoach, setShowCareerCoach] = useState(false);

  // Current Target Job state
  const [currentJob, setCurrentJob] = useState<DrawerJobContext | null>(job);
  const currentJobView: DrawerJobContext = currentJob ?? {
    title: t("简历讨论", "Resume discussion"),
    company: "",
    description: "",
  };
  const [isEditingJob, setIsEditingJob] = useState(false);
  const isSetupMode = !currentJob?.description || isEditingJob;
  const [inputTitle, setInputTitle] = useState(job?.title || "");
  const [inputCompany, setInputCompany] = useState(job?.company || "");
  const [inputSalary, setInputSalary] = useState(job?.salary || "");
  const [inputLocation, setInputLocation] = useState(job?.location || "");
  const [inputDescription, setInputDescription] = useState(job?.description || "");

  // Link import state
  const [isLinkInputOpen, setIsLinkInputOpen] = useState(true);
  const [linkInputValue, setLinkInputValue] = useState("");
  const [isExtractingLink, setIsExtractingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkSuccessNotice, setLinkSuccessNotice] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | undefined>(job?.sourceUrl);
  const [sourcePlatform, setSourcePlatform] = useState<string | undefined>(job?.sourcePlatform);

  // High-Tech Cyberpunk Stream / Handwriting Fill state
  const [isStreamingFill, setIsStreamingFill] = useState(false);
  const [streamingField, setStreamingField] = useState<"title" | "company" | "salary" | "location" | "description" | null>(null);
  const skipAnimationRef = useRef<boolean>(false);

  const [leftViewMode, setLeftViewMode] = useState<"jd" | "chat">("chat");
  const [pageMotion, setPageMotion] = useState<"forward" | "back" | "none">("none");
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const showRightPane = isSetupMode || rightPaneOpen;

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
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ pointerId: number; percent: number } | null>(null);

  const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragRef.current = { pointerId: e.pointerId, percent: splitPercent };
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
    setSplitPercent(DEFAULT_SPLIT_PERCENT);
    try {
      localStorage.setItem(AGENT_SPLIT_KEY, String(DEFAULT_SPLIT_PERCENT));
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
  };

  // Foldable sections state
  const [isJobSpecFolded, setIsJobSpecFolded] = useState(false);

  // Matching state
  const [threadId, setThreadId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [structuredJd, setStructuredJd] = useState<StructuredJd | null>(null);
  const [proposals, setProposals] = useState<MatchProposal[]>([]);
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>({});
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [agentHostOnline, setAgentHostOnline] = useState<boolean | null>(null);

  // Proposal filter & detail view
  const [proposalFilter, setProposalFilter] = useState<"all" | "accepted" | "pending" | "rejected">("all");
  const [activeDiffProposalId, setActiveDiffProposalId] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [shareResumeForEditing, setShareResumeForEditing] = useState(false);
  const [resumeProposalStates, setResumeProposalStates] = useState<Record<string, { status: "saving" | "approved" | "rejected" | "conflict" | "error"; message?: string }>>({});
  const lastAssistantMessageId = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const [inputMessage, setInputMessage] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const chatAbortRef = useRef<AbortController | null>(null);
  const pendingChatRef = useRef<ChatMessage | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingChatImage[]>([]);
  const [pendingReferences, setPendingReferences] = useState<ResumeTextReference[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const imageCapability = getModelImageCapability(llmConfig);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => chatAbortRef.current?.abort(), []);

  const decideResumeProposal = async (key: string, action: NonNullable<ChatMessage["actions"]>[number], approve: boolean) => {
    if (!approve) {
      setResumeProposalStates((previous) => ({ ...previous, [key]: { status: "rejected", message: t("已拒绝；简历未修改。", "Rejected. The resume was not changed.") } }));
      return;
    }
    if (action.type !== "resume_proposal" || !action.sourceVerified || !action.targetRef || !action.originalText || !action.proposedText || !onApplyResumeProposal) {
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
  }, [initialReference]);

  // View state
  const [showGapsSummary, setShowGapsSummary] = useState(false);

  // Guided application milestone modal state
  const [isApplying, setIsApplying] = useState(false);
  const [applyStep, setApplyStep] = useState<1 | 2 | 3>(1);
  const [extractingStepMessage, setExtractingStepMessage] = useState<string | null>(null);

  // Auto-listen to direct web sync from Bookmarklet / Browser Extension
  const lastProcessedSyncTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    // The Docker runtime deliberately does not attach the host browser/profile.
    if (readRuntimeConnection()) return;
    let isCancelled = false;
    const checkSync = async () => {
      try {
        const resp = await fetch("/api/jd/sync-extension");
        if (!resp.ok) return;
        const data = (await resp.json()) as { latest?: { title: string; company: string; salary?: string; location?: string; description: string; sourceUrl?: string; syncedAt: number } };
        if (data.latest && data.latest.syncedAt > lastProcessedSyncTimeRef.current) {
          lastProcessedSyncTimeRef.current = data.latest.syncedAt;
          if (isCancelled) return;
          setInputTitle(data.latest.title);
          setInputCompany(data.latest.company);
          if (data.latest.salary) setInputSalary(data.latest.salary);
          if (data.latest.location) setInputLocation(data.latest.location);
          setInputDescription(data.latest.description);
          if (data.latest.sourceUrl) {
            setSourceUrl(data.latest.sourceUrl);
          }
          setIsLinkInputOpen(false);
          setLinkSuccessNotice(
            t(
              `🎉 已全自动接收浏览器直推岗位：${data.latest.company} · ${data.latest.title}`,
              `🎉 Auto-synced from browser: ${data.latest.company} · ${data.latest.title}`
            )
          );
          triggerAgentGuide({
            actionType: "focus",
            label: `已全自动接收岗位「${data.latest.title}」`,
            text: data.latest.title,
          });
          setTimeout(() => setLinkSuccessNotice(null), 4000);
        }
      } catch {
        // Ignore polling error
      }
    };

    const interval = setInterval(() => { void checkSync(); }, 1200);
    if (typeof (interval as unknown as { unref?: () => void }).unref === "function") {
      (interval as unknown as { unref: () => void }).unref();
    }
    const onWindowFocus = () => { void checkSync(); };
    window.addEventListener("focus", onWindowFocus);

    return () => {
      isCancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  // Sync prop job changes to local state
  useEffect(() => {
    if (job) {
      setCurrentJob(job);
      setInputTitle(job.title || "");
      setInputCompany(job.company || "");
      setInputSalary(job.salary || "");
      setInputLocation(job.location || "");
      setInputDescription(job.description || "");
      setSourceUrl(job.sourceUrl);
      setSourcePlatform(job.sourcePlatform);
      setIsEditingJob(false);
    }
  }, [job]);

  function extractUrlFromText(text: string): string | null {
    if (!text) return null;
    const trimmed = text.trim();
    const bossShortMatch = trimmed.match(/^(?:https?:\/\/(?:www\.)?zhipin\.com\/)?(?:job|job_detail)\/([a-z\d_-]+)/i);
    if (bossShortMatch) {
      return `https://www.zhipin.com/job_detail/${bossShortMatch[1]}.html`;
    }
    const match = text.match(/https?:\/\/[^\s<>"「」『』。，；！？【】《》]+/i);
    if (match) {
      const foundUrl = match[0];
      const bossUrlMatch = foundUrl.match(/https?:\/\/(?:www\.)?zhipin\.com\/(?:job|job_detail)\/([a-z\d_-]+)/i);
      if (bossUrlMatch) {
        return `https://www.zhipin.com/job_detail/${bossUrlMatch[1]}.html`;
      }
      return foundUrl;
    }
    if (trimmed.startsWith("job/") || trimmed.startsWith("/job/") || trimmed.includes("zhipin.com")) {
      const cleanPath = trimmed.replace(/^https?:\/\//i, "").replace(/^www\.zhipin\.com\/?/i, "").replace(/^\/+/, "");
      return `https://www.zhipin.com/${cleanPath}`;
    }
    if (trimmed.includes("liepin.com")) {
      const cleanPath = trimmed.replace(/^https?:\/\//i, "").replace(/^www\.liepin\.com\/?/i, "").replace(/^\/+/, "");
      return `https://www.liepin.com/${cleanPath}`;
    }
    if (trimmed.includes("51job.com")) {
      const cleanPath = trimmed.replace(/^https?:\/\//i, "").replace(/^jobs\.51job\.com\/?/i, "").replace(/^www\.51job\.com\/?/i, "").replace(/^\/+/, "");
      return `https://jobs.51job.com/${cleanPath}`;
    }
    return null;
  }

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
    handleSkipStreamAnimation();
    setInputTitle(preset.title);
    setInputCompany(preset.company);
    setInputSalary(preset.salary);
    setInputLocation(preset.location);
    setInputDescription(preset.description);
    setLinkError(null);
    setLinkSuccessNotice(null);
  }

  const commitParsedFields = (parsed: ParsedJobInfo) => {
    setInputTitle(parsed.title);
    setInputCompany(parsed.company);
    setInputSalary(parsed.salary);
    setInputLocation(parsed.location);
    setInputDescription(parsed.description);
  };

  const playHighTechStreamFill = async (parsed: ParsedJobInfo) => {
    setIsStreamingFill(true);
    skipAnimationRef.current = false;

    const streamChunk = async (
      text: string,
      setter: (val: string) => void,
      field: "title" | "company" | "salary" | "location" | "description",
      chunkSize: number,
      tickDelay: number
    ) => {
      if (!text) return;
      setStreamingField(field);
      let acc = "";
      for (let i = 0; i < text.length; i += chunkSize) {
        if (skipAnimationRef.current) {
          setter(text);
          return;
        }
        acc += text.slice(i, i + chunkSize);
        setter(acc);
        await new Promise((resolve) => setTimeout(resolve, tickDelay));
      }
      setter(text);
    };

    try {
      // 1. Title (handwriting / typewriter style)
      await streamChunk(parsed.title, setInputTitle, "title", 2, 14);
      if (skipAnimationRef.current) {
        commitParsedFields(parsed);
        return;
      }
      // 2. Company
      await streamChunk(parsed.company, setInputCompany, "company", 2, 14);
      if (skipAnimationRef.current) {
        commitParsedFields(parsed);
        return;
      }
      // 3. Salary & Location
      if (parsed.salary) {
        await streamChunk(parsed.salary, setInputSalary, "salary", 2, 10);
      }
      if (parsed.location) {
        await streamChunk(parsed.location, setInputLocation, "location", 2, 10);
      }
      if (skipAnimationRef.current) {
        commitParsedFields(parsed);
        return;
      }
      // 4. Description (rapid cyber matrix stream)
      await streamChunk(parsed.description, setInputDescription, "description", 36, 16);
    } finally {
      commitParsedFields(parsed);
      setIsStreamingFill(false);
      setStreamingField(null);
    }
  };

  const handleSkipStreamAnimation = () => {
    skipAnimationRef.current = true;
    setIsStreamingFill(false);
    setStreamingField(null);
  };

  const handleExtractLink = async (overrideInput?: string, forceMode?: "static" | "browser" | "auto-browser") => {
    const raw = (overrideInput ?? linkInputValue).trim();
    if (!raw) {
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
    try {
      let parsed: ParsedJobInfo;
      if (forceMode === "auto-browser") {
        setExtractingStepMessage(t("🤖 正在启动自动化浏览器加载岗位...若遇安全验证请协助滑动，系统将自动读取！", "Automated browser active... If captcha appears, complete it and system will auto-read!"));
        parsed = await extractAndParseJobLink(inputToProcess, {
          signal: controller.signal,
          llmConfig,
          mode: "auto-browser",
        });
      } else {
        try {
          parsed = await extractAndParseJobLink(inputToProcess, {
            signal: controller.signal,
            llmConfig,
            mode: "static",
          });
        } catch {
          // If static extraction encounters network/anti-bot errors, auto-fallback to local automated browser engine
          setExtractingStepMessage(t("🤖 已启动自动化浏览器接续抓取...若出现滑块验证，请在浏览器中拖动完成，系统将自动继续！", "Automated browser active... If captcha slider appears, please complete it; system will auto-resume!"));
          parsed = await extractAndParseJobLink(inputToProcess, {
            signal: controller.signal,
            llmConfig,
            mode: "auto-browser",
          });
        }
      }

      // Populate form fields with high-tech stream animation
      const isTestContext = typeof process !== "undefined" && Boolean(process.env?.NODE_TEST_CONTEXT);
      const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      if (isTestContext || prefersReducedMotion) {
        commitParsedFields(parsed);
      } else {
        await playHighTechStreamFill(parsed);
      }

      if (parsed.sourceUrl || normalizedUrl) {
        setSourceUrl(parsed.sourceUrl || normalizedUrl || undefined);
      }
      if (parsed.sourcePlatform) {
        setSourcePlatform(parsed.sourcePlatform);
      }

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

      setTimeout(() => {
        setIsLinkInputOpen(false);
        setLinkSuccessNotice(null);
      }, 2500);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t("未能成功读取岗位链接，请检查网络或直接粘贴 JD 正文", "Failed to extract job link");
      setLinkError(msg);
    } finally {
      setIsExtractingLink(false);
      setExtractingStepMessage(null);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          setLinkInputValue(text);
          setLinkError(null);
        }
      }
    } catch {
      // Ignore clipboard permission or support error
    }
  };

  const handlePasteClipboardAndExtract = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text?.trim()) {
          setLinkInputValue(text.slice(0, 300));
          await handleExtractLink(text);
        }
      }
    } catch {
      // Ignore clipboard permission or support error
    }
  };

  // Check agent host daemon health
  useEffect(() => {
    void checkAgentHostHealth().then(setAgentHostOnline);
  }, []);

  // Trigger initial match when opened with a job
  useEffect(() => {
    if (active && !showCareerCoach && currentJob?.description && proposals.length === 0 && !loading && !errorNotice) {
      void runMatching(currentJob.description);
    }
  }, [currentJob?.description, active, showCareerCoach]);

  // Auto-scroll chat
  useEffect(() => {
    if (leftViewMode !== "jd") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, leftViewMode]);

  const runMatching = async (jdText: string) => {
    setLoading(true);
    setErrorNotice(null);
    const newThreadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setThreadId(newThreadId);

    const allowedIds: string[] = [];
    const sessionClaims: Record<string, string> = {};

    if (resume) {
      if (resume.profile.displayName) sessionClaims["candidate_name"] = resume.profile.displayName;
      if (resume.profile.headline) sessionClaims["headline"] = resume.profile.headline;
      if (resume.profile.education) sessionClaims["education"] = resume.profile.education;
      if (resume.educationSummary) sessionClaims["education_summary"] = resume.educationSummary;
      if (resume.profile.location) sessionClaims["location"] = resume.profile.location;
      if (resume.skills && resume.skills.length > 0) sessionClaims["skills"] = resume.skills.join(", ");
      if (resume.profile.traits && resume.profile.traits.length > 0) sessionClaims["traits"] = resume.profile.traits.join(", ");
      if (resume.profile.targetRoles && resume.profile.targetRoles.length > 0) sessionClaims["target_roles"] = resume.profile.targetRoles.join(", ");

      resume.experiences.forEach((exp, idx) => {
        const typeLabel = exp.type === "opensource" ? "开源项目" : exp.type === "education" ? "教育经历" : "工作经历";
        const key = `${typeLabel}_${idx + 1}_${exp.org || exp.projectName || "经历"}`;
        const claimTexts = exp.claims.map((c) => {
          allowedIds.push(c.id);
          return `• [${c.id}] ${c.text}`;
        });
        const details = [
          `${exp.title} (${exp.start} - ${exp.end || "至今"})`,
          exp.projectName ? `项目名称: ${exp.projectName}` : null,
          exp.techStack && exp.techStack.length > 0 ? `技术栈: ${exp.techStack.join(", ")}` : null,
          claimTexts.length > 0 ? `具体经历与成果:\n${claimTexts.join("\n")}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        sessionClaims[key] = details;
      });
    }

    try {
      const res = await startJdMatch({
        threadId: newThreadId,
        rawJd: jdText,
        allowedProfileEntryIds: allowedIds,
        sessionClaims,
        llmConfig,
      });

      const loadedProposals = Array.isArray(res.proposals) ? res.proposals : [];
      setProposals(loadedProposals);
      if (res.structuredJd) {
        setStructuredJd(res.structuredJd);
      }

      // Default decisions: accept verified items, leave others undecided
      const initialDecisions: Record<string, ProposalDecision> = {};
      for (const p of loadedProposals) {
        if (p.evidenceType === "verified") {
          initialDecisions[p.id] = { status: "accepted" };
        }
      }
      setDecisions(initialDecisions);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : t("岗位匹配失败，请检查模型配置", "Job matching failed"));
    } finally {
      setLoading(false);
    }
  };

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

  const handleSubmitJobSetup = () => {
    if (!inputDescription.trim() || loading) return;
    const newJob: DrawerJobContext = {
      title: inputTitle.trim() || t("目标职位", "Target Position"),
      company: inputCompany.trim() || t("目标企业", "Target Company"),
      salary: inputSalary.trim() || undefined,
      location: inputLocation.trim() || undefined,
      description: inputDescription.trim(),
      sourceUrl,
      sourcePlatform,
    };
    setCurrentJob(newJob);
    setIsEditingJob(false);
    void runMatching(newJob.description);
  };

  const handleCancelJobEdit = () => {
    if (currentJob) {
      setInputTitle(currentJob.title);
      setInputCompany(currentJob.company);
      setInputSalary(currentJob.salary || "");
      setInputLocation(currentJob.location || "");
      setInputDescription(currentJob.description);
      setSourceUrl(currentJob.sourceUrl);
      setSourcePlatform(currentJob.sourcePlatform);
    }
    setIsEditingJob(false);
    setIsLinkInputOpen(false);
    setLinkError(null);
  };

  const handleOpenJobEdit = () => {
    if (currentJob) {
      setInputTitle(currentJob.title);
      setInputCompany(currentJob.company);
      setInputSalary(currentJob.salary || "");
      setInputLocation(currentJob.location || "");
      setInputDescription(currentJob.description);
      setSourceUrl(currentJob.sourceUrl);
      setSourcePlatform(currentJob.sourcePlatform);
    }
    setIsEditingJob(true);
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

  const handleChatImageSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    setAttachmentError(null);
    const room = Math.max(0, 3 - pendingAttachments.length);
    if (room === 0) {
      setAttachmentError(t("一条消息最多附加 3 张图片。", "Attach up to 3 images to a message."));
      return;
    }
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareChatImage));
      setPendingAttachments((previous) => [...previous, ...prepared].slice(0, 3));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : t("图片读取失败，请重试。", "Could not read the image. Try again."));
    }
  };

  // Chat message submission
  const handleSendMessage = async (customText?: string) => {
    const selectedAttachments = customText ? [] : pendingAttachments;
    if (selectedAttachments.length && imageCapability === "unsupported") {
      setAttachmentError(modelImageCapabilityDescription(imageCapability, t));
      return;
    }
    const selectedReferences = pendingReferences;
    const typedText = customText ?? inputMessage;
    const textToSend = typedText.trim() || (selectedAttachments.length ? t("请帮我分析这张图片。", "Please analyze the attached image.") : selectedReferences.length ? t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text.") : "");
    if ((!textToSend && selectedAttachments.length === 0 && selectedReferences.length === 0) || chatLoading || chatAbortRef.current) return;

    if (leftViewMode === "jd") {
      showLeftPage("chat");
    }

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content: textToSend.trim(),
      ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
      ...(selectedReferences.length ? { references: selectedReferences } : {}),
      createdAt: new Date().toISOString(),
    };

    const controller = new AbortController();
    chatAbortRef.current = controller;
    pendingChatRef.current = userMsg;
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
      const reply = await sendAgentChat({
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
      setMessages((prev) => [...prev, reply]);
      pendingChatRef.current = null;
    } catch (err) {
      if (controller.signal.aborted || chatAbortRef.current !== controller) return;
      const errorMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: "assistant",
        content: err instanceof Error ? `⚠️ ${err.message}` : t("抱歉，对话服务出现异常，请检查 AI 配置。", "Sorry, chat service failed. Check AI configuration."),
      };
      setMessages((prev) => [...prev, errorMsg]);
      pendingChatRef.current = null;
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
    const pending = pendingChatRef.current;
    pendingChatRef.current = null;
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
  const handleApply = () => {
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

    // Invoke onApplyToResume directly so state updates and tests are immediate
    onApplyToResume({
      acceptedProposals: acceptedList,
      customResumeName,
      targetJobTitle: title,
      targetCompany: company,
    });

    setIsApplying(true);
    setApplyStep(1);

    if (threadId && agentHostOnline) {
      void resumeJdMatch({
        threadId,
        decisions,
        currentProposals: proposals,
        llmConfig,
      }).catch(() => {});
    }

    setTimeout(() => setApplyStep(2), 400);
    setTimeout(() => setApplyStep(3), 800);
    setTimeout(() => {
      setIsApplying(false);
      const firstEntryId = acceptedList.find((p) => p.profileEntryId)?.profileEntryId;
      if (firstEntryId) {
        triggerAgentGuide({
          claimId: firstEntryId,
          label: t("🎯 已基于岗位 JD 完成定制更新", "🎯 Customized based on target JD"),
          actionType: "applied",
        });
      }
    }, 1200);
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

  const animatedScore = useAnimatedCounter(stats.score, 900);

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

  // Circumference for radial progress gauge

  if (showCareerCoach) return (
    <section className="career-coach-shell">
      <nav className="career-coach-entry-nav" aria-label={t("Agent 工作区", "Agent workspace")}>
        <button type="button" onClick={() => setShowCareerCoach(false)}><ArrowLeft size={16} />{t("返回对话与 JD", "Back to chat and JD")}</button>
        <button type="button" onClick={onNavigateToResume}>{t("返回简历", "Back to resume")}</button>
      </nav>
      {active && <CareerCoachWorkspace key={workspaceKey} workspaceKey={workspaceKey} job={careerCoachJob}
        resumeEditContext={resumeEditContext} llmConfig={llmConfig} onOpenConfig={onOpenConfig}
        onApplyResumeProposal={onApplyResumeProposal} />}
    </section>
  );

  return (
    <section
      className={`w-full h-full flex flex-col min-h-0 overflow-hidden font-sans transition-colors duration-200 ${
        isDark ? "bg-[var(--ui-canvas,#1a1a1f)] text-[var(--ui-text,#edeef4)]" : "bg-slate-100/90 text-slate-900"
      }`}
    >
      {/* ── Top Workspace Bar ────────────────────────────────────────────── */}
      <header
        className={`flex items-center justify-between px-6 py-3 shrink-0 border-b shadow-2xs z-20 transition-colors duration-200 ${
          isDark
            ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text,#edeef4)] border-[var(--ui-border,#484b58)]"
            : "bg-white text-slate-900 border-slate-200"
        }`}
      >
        <div className="flex items-center gap-4 min-w-0">
          <button
            type="button"
            onClick={onNavigateToResume}
            className={`agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition cursor-pointer border ${
              isDark
                ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#363842)] text-[var(--ui-text-secondary,#c5c8d6)] hover:text-white border-[var(--ui-border,#484b58)]"
                : "bg-slate-50 hover:bg-slate-100 text-slate-700 hover:text-slate-900 border-slate-200 shadow-2xs"
            }`}
            title={t("返回简历编辑", "Back to resume editor")}
          >
            <ArrowLeft size={14} />
            <span>{t("返回简历", "Back to Resume")}</span>
          </button>

          <div className={`h-4 w-px ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-200"}`} />

          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-xl border shrink-0 ${
                isDark
                  ? "bg-[var(--ui-surface-soft,#363842)] text-emerald-400 border-[var(--ui-border,#484b58)]"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
              }`}
            >
              <Bot size={16} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h1 className={`text-sm font-semibold tracking-tight truncate ${isDark ? "text-white" : "text-slate-900"}`}>
                  {t("AI 顾问工作台", "AI Career Workspace")}
                </h1>
                <span
                  className={`inline-flex h-2 w-2 rounded-full shrink-0 ${
                    agentHostOnline === true ? "bg-emerald-500" : isDark ? "bg-[var(--ui-text-muted,#8b90a0)]" : "bg-slate-400"
                  }`}
                  title={
                    agentHostOnline === true
                      ? `本机 Agent :5179${threadId ? ` · #${threadId.slice(-6)}` : ""}`
                      : t("直连推理（未连本机 Agent）", "Direct LLM (agent-host offline)")
                  }
                />
              </div>
              {currentJob?.title ? (
                <p className={`text-[11px] truncate mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#8b90a0)]" : "text-slate-500"}`}>
                  {currentJob.company} · {currentJob.title}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button type="button" onClick={() => setShowCareerCoach(true)}
            className="agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs cursor-pointer"
            style={{ color: "var(--ui-accent)", borderColor: "var(--ui-border)", background: "var(--ui-accent-soft)" }}>
            <Target size={14} />{t("职业成长", "Career growth")}
          </button>
          {(!currentJob?.description || isEditingJob) ? null : (
            <button
              type="button"
              onClick={handleOpenJobEdit}
              className={`agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs transition cursor-pointer ${
                isDark
                  ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text,#edeef4)] hover:text-white hover:bg-[var(--ui-hover,#41434e)]"
                  : "border-slate-200 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 shadow-2xs"
              }`}
            >
              <Edit3 size={13} />
              <span>{t("更换岗位 / 编辑 JD", "Edit JD")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenConfig}
            title={t("AI 模型配置", "AI configuration")}
            className={`agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs transition cursor-pointer ${
              isDark
                ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text,#edeef4)] hover:text-white hover:bg-[var(--ui-hover,#41434e)]"
                : "border-slate-200 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 shadow-2xs"
            }`}
          >
            <Settings2 size={14} />
            <span>{t("模型设置", "Model Settings")}</span>
          </button>
        </div>
      </header>

      {/* ── API Key Notice Banner ─────────────────────────────────── */}
      {!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama" && (
        <div
          className={`flex items-center justify-between gap-4 px-6 py-2.5 border-b text-xs shrink-0 z-10 ${
            isDark
              ? "bg-amber-500/10 border-amber-500/25 text-amber-200"
              : "bg-amber-50 border-amber-200/80 text-amber-900"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={15} className="text-amber-500 shrink-0" />
            <span className="truncate">
              {t("未配置模型 API Key，无法拆解与对话。", "API Key missing — matching and chat unavailable.")}
            </span>
          </div>
          <button
            type="button"
            onClick={onOpenConfig}
            className="agent-btn-press inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-semibold transition shrink-0 cursor-pointer"
          >
            <Settings2 size={12} />
            <span>{t("去配置", "Configure")}</span>
          </button>
        </div>
      )}

      {/* ── Main Dual-Pane Content Area (With Draggable Splitter) ── */}
      <div
        ref={splitContainerRef}
        className={`flex-1 w-full min-h-0 p-4 md:p-5 flex flex-col lg:flex-row gap-0 overflow-hidden relative ${
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
          {((!currentJob?.description || isEditingJob) && !(leftViewMode === "chat" && (pendingReferences.length > 0 || messages.length > 0))) ? (
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
                    {isEditingJob ? t("编辑 / 更换目标岗位", "Edit / Change Target Job") : t("设定目标岗位与完整 JD", "Set Target Job & Full JD")}
                  </h3>
                  <p className={`text-[11px] mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {t("粘贴链接或 JD，确认字段后开始拆解", "Paste a link or JD, then start matching")}
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
                {/* ── Link Import Panel (always open in setup) ── */}
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
                        setLinkInputValue(e.target.value);
                        setLinkError(null);
                      }}
                      onKeyDown={(e) => {
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

                {isStreamingFill && (
                  <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-[11px] ${
                    isDark ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-emerald-200 bg-emerald-50 text-emerald-800"
                  }`}>
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin shrink-0" />
                      <span>
                        {streamingField === "title"
                          ? t("正在填入职位名称…", "Filling title…")
                          : streamingField === "company"
                          ? t("正在填入公司…", "Filling company…")
                          : streamingField === "salary"
                          ? t("正在填入薪资…", "Filling salary…")
                          : streamingField === "location"
                          ? t("正在填入地点…", "Filling location…")
                          : t("正在填入 JD…", "Filling JD…")}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={handleSkipStreamAnimation}
                      className="underline-offset-2 hover:underline cursor-pointer bg-transparent border-0 p-0 text-[11px] font-medium"
                    >
                      {t("跳过", "Skip")}
                    </button>
                  </div>
                )}

                {/* 2-column Metadata Grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {t("职位名称", "Job Title")}
                      </label>
                      {streamingField === "title" && (
                        <span className="text-[10px] text-emerald-500">{t("填入中", "Writing")}</span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={inputTitle}
                      onChange={(e) => {
                        handleSkipStreamAnimation();
                        setInputTitle(e.target.value);
                      }}
                      placeholder={t("例如：资深前端工程师 / 架构师", "e.g. Senior Frontend Engineer")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        streamingField === "title" ? "cyber-typing-active" : ""
                      } ${
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
                      {streamingField === "company" && (
                        <span className="text-[10px] text-emerald-500">{t("填入中", "Writing")}</span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={inputCompany}
                      onChange={(e) => {
                        handleSkipStreamAnimation();
                        setInputCompany(e.target.value);
                      }}
                      placeholder={t("例如：字节跳动 / 腾讯 / 创新企业", "e.g. Acme Inc.")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        streamingField === "company" ? "cyber-typing-active" : ""
                      } ${
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
                      {streamingField === "salary" && (
                        <span className="text-[10px] text-emerald-500">{t("填入中", "Writing")}</span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={inputSalary}
                      onChange={(e) => {
                        handleSkipStreamAnimation();
                        setInputSalary(e.target.value);
                      }}
                      placeholder={t("例如：35k-50k · 16薪", "e.g. 35k-50k")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        streamingField === "salary" ? "cyber-typing-active" : ""
                      } ${
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
                      {streamingField === "location" && (
                        <span className="text-[10px] text-emerald-500">{t("填入中", "Writing")}</span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={inputLocation}
                      onChange={(e) => {
                        handleSkipStreamAnimation();
                        setInputLocation(e.target.value);
                      }}
                      placeholder={t("例如：上海 / 远程", "e.g. Shanghai / Remote")}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 transition ${
                        streamingField === "location" ? "cyber-typing-active" : ""
                      } ${
                        isDark
                          ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                          : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 shadow-2xs"
                      }`}
                    />
                  </div>
                </div>

                {/* Full JD Textarea */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className={`block text-[11px] font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                      {t("岗位完整 JD 文本 (必填)", "Job Description (Required)")}
                    </label>
                    <div className="flex items-center gap-2 text-[10px]">
                      {streamingField === "description" && (
                        <span className="text-[10px] text-emerald-500">{t("填入中…", "Writing…")}</span>
                      )}
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
                      handleSkipStreamAnimation();
                      setInputDescription(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        handleSubmitJobSetup();
                      }
                    }}
                    rows={8}
                    placeholder={t("请在此粘贴招聘 JD 的职责描述、任职要求与福利待遇... (支持快捷键 ⌘+Enter 快速开始分析)", "Paste job description, requirements and responsibilities here... (⌘+Enter to submit)")}
                    className={`w-full p-3.5 rounded-2xl border text-xs font-mono leading-relaxed focus:border-emerald-500/80 focus:outline-none focus:ring-1 focus:ring-emerald-500/20 resize-y transition ${
                      streamingField === "description" ? "cyber-typing-active" : ""
                    } ${
                      isDark
                        ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)] placeholder:text-[var(--ui-text-muted,#a7adbd)]"
                        : "border-slate-200 bg-white text-slate-800 placeholder-slate-400 shadow-2xs"
                    }`}
                  />
                </div>

              </div>

              {/* Bottom Sticky Action Footer */}
              <div
                className={`p-4 border-t shrink-0 flex items-center justify-between ${
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
                            ? t("保存并重新分析", "Save & Re-analyze")
                            : t("开始拆解", "Start matching")}
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
                <div className="flex items-start gap-2.5">
                  <div
                    className={`mt-0.5 h-8 w-8 rounded-lg border flex items-center justify-center text-xs font-semibold shrink-0 ${
                      isDark
                        ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
                        : "bg-emerald-50 border-emerald-200/80 text-emerald-800"
                    }`}
                  >
                    {(currentJobView.company || currentJobView.title || "岗").slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <h2 className={`text-sm font-semibold leading-snug ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                      {currentJobView.title}
                    </h2>
                    <p className={`text-xs leading-snug ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                      {currentJobView.company}
                    </p>
                    {currentJobView.location ? (
                      <p className={`text-[11px] leading-snug flex items-start gap-1 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                        <MapPin size={11} className="shrink-0 mt-0.5 opacity-70" />
                        <span>{currentJobView.location.replace(/\s+/g, " ")}</span>
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5 text-[11px]">
                      {currentJobView.salary ? (
                        <span className={`tabular-nums font-medium ${isDark ? "text-emerald-300" : "text-emerald-700"}`}>
                          {currentJobView.salary}
                        </span>
                      ) : null}
                      {currentJobView.sourceUrl ? (
                        <a
                          href={currentJobView.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`inline-flex items-center gap-0.5 hover:underline ${isDark ? "text-emerald-300" : "text-emerald-700"}`}
                        >
                          {currentJobView.sourcePlatform || t("来源", "Source")}
                          <ExternalLink size={10} />
                        </a>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {currentJob && <button
                      type="button"
                      onClick={handleOpenJobEdit}
                      className={`agent-btn-press inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border cursor-pointer ${
                        isDark
                          ? "text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:text-white"
                          : "text-slate-600 border-slate-200 bg-white hover:text-slate-900"
                      }`}
                      title={t("修改岗位与 JD 信息", "Edit Job Details")}
                    >
                      <Edit3 size={12} />
                      <span>{t("编辑岗位", "Edit")}</span>
                    </button>}
                    {onSaveOpportunity && currentJob ? (
                      <button
                        type="button"
                        onClick={() => onSaveOpportunity(currentJob)}
                        className={`agent-btn-press inline-flex items-center justify-center h-7 w-7 rounded-lg border cursor-pointer ${
                          isDark
                            ? "text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:text-white"
                            : "text-slate-600 border-slate-200 bg-white hover:text-slate-900"
                        }`}
                        title={t("收藏", "Save")}
                        aria-label={t("收藏", "Save")}
                      >
                        <BookmarkPlus size={13} />
                      </button>
                    ) : null}
                  </div>
                </div>

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
              <div
                style={{ overflowY: "auto" }}
                className={`overflow-y-auto min-h-0 flex-1 agent-custom-scrollbar p-4 space-y-3.5 pb-8 ${
                  isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-slate-50/30"
                }`}
              >
                {/* Section Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText size={15} className="text-emerald-500" />
                    <h3 className={`text-xs font-bold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                      {t("完整岗位 JD 与要求", "Complete Job Profile & Requirements")}
                    </h3>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium border ${
                        isDark ? "bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-700 border-slate-300"
                      }`}
                    >
                      {displayQualifications.length + displayResponsibilities.length} 项要求
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsJobSpecFolded(!isJobSpecFolded)}
                      className={`agent-btn-press text-[11px] flex items-center gap-1 px-2.5 py-1 rounded-lg border cursor-pointer transition ${
                        isDark
                          ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                          : "text-slate-600 hover:text-slate-900 border-slate-200 bg-white shadow-2xs"
                      }`}
                      title={isJobSpecFolded ? t("展开岗位JD要求", "Expand Job Spec") : t("收起岗位JD要求", "Collapse Job Spec")}
                    >
                      <ChevronDown size={12} className={`transition-transform duration-200 ${isJobSpecFolded ? "-rotate-90" : ""}`} />
                      <span>{isJobSpecFolded ? t("展开JD", "Expand") : t("收起JD", "Collapse")}</span>
                    </button>

                    {currentJob?.description && (
                      <button
                        type="button"
                        onClick={() => handleCopy(currentJobView.description, "raw-jd")}
                        className={`agent-btn-press text-[11px] flex items-center gap-1 px-2.5 py-1 rounded-lg border cursor-pointer transition ${
                          isDark
                            ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                            : "text-slate-600 hover:text-slate-900 border-slate-200 bg-white shadow-2xs"
                        }`}
                      >
                        {copiedId === "raw-jd" ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                        <span>{copiedId === "raw-jd" ? t("已复制", "Copied") : t("复制 JD", "Copy JD")}</span>
                      </button>
                    )}
                  </div>
                </div>

                {!isJobSpecFolded && (
                  <>
                {/* Tech Stack Chips Bar */}
                {structuredJd?.techStack && structuredJd.techStack.length > 0 && (() => {
                  const candidateSkills = (resume?.skills || []).map((s) => s.toLowerCase());
                  const matched = structuredJd.techStack.filter((t) => candidateSkills.some((s) => s.includes(t.toLowerCase()) || t.toLowerCase().includes(s)));
                  const unmatched = structuredJd.techStack.filter((t) => !matched.includes(t));
                  return (
                    <div
                      className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
                        isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5 font-bold">
                          <Layers size={13} className="text-emerald-400" />
                          <span className={`text-[11px] uppercase tracking-wider font-mono ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-700"}`}>
                            {t("核心技术栈要求", "Required Tech Stack")}
                          </span>
                        </div>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                            matched.length > 0
                              ? isDark
                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : isDark
                                ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]"
                                : "bg-slate-100 text-slate-600 border-slate-200"
                          }`}
                        >
                          {t(`已命中 ${matched.length} / ${structuredJd.techStack.length} 项`, `${matched.length}/${structuredJd.techStack.length} Matched`)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {matched.map((tech) => (
                          <span
                            key={tech}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border font-mono transition shadow-2xs ${
                              isDark
                                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-[0_0_8px_rgba(16,185,129,0.15)]"
                                : "bg-emerald-50 text-emerald-800 border-emerald-300"
                            }`}
                          >
                            <Check size={11} className="text-emerald-500 stroke-[2.5]" />
                            <span>{tech}</span>
                          </span>
                        ))}
                        {unmatched.map((tech) => (
                          <span
                            key={tech}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border font-mono transition ${
                              isDark
                                ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)]"
                                : "bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300"
                            }`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500/50" />
                            <span>{tech}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* 1. Job Responsibilities Section */}
                <div
                  className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
                    isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h4 className={`text-xs font-bold flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      <span>{t("岗位核心职责", "Job Responsibilities")}</span>
                    </h4>
                    <span className={`text-[10px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                      {displayResponsibilities.length} {t("项核心任务", "tasks")}
                    </span>
                  </div>
                  <div className="space-y-2 text-xs leading-relaxed font-sans">
                    {displayResponsibilities.map((item, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-xl border transition-all duration-150 flex items-start gap-2.5 ${
                          isDark
                            ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)] text-[var(--ui-text-secondary,#c7cad4)]"
                            : "bg-slate-50/80 border-slate-200/80 hover:border-slate-300 text-slate-800 shadow-2xs"
                        }`}
                      >
                        <span
                          className={`flex h-5 w-5 rounded-full font-mono font-bold text-[10px] items-center justify-center shrink-0 mt-0.5 border ${
                            isDark ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-600 border-slate-300"
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <p className="flex-1 whitespace-pre-wrap leading-relaxed">{item}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 2. Job Qualifications & Requirements Section */}
                <div
                  className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
                    isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h4 className={`text-xs font-bold flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
                      <span>{t("任职资格与硬性门槛", "Qualifications & Requirements")}</span>
                    </h4>
                    <span className={`text-[10px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                      {displayQualifications.length} {t("项硬性要求", "criteria")}
                    </span>
                  </div>
                  <div className="space-y-2 text-xs leading-relaxed font-sans">
                    {displayQualifications.map((item, idx) => {
                      const matchingProposal = proposals.find((p) => item.includes(p.jdItem.slice(0, 15)) || p.jdItem.includes(item.slice(0, 15)));
                      const isVerified = matchingProposal?.evidenceType === "verified";
                      const isGap = matchingProposal?.evidenceType === "gap";

                      return (
                        <div
                          key={idx}
                          className={`p-3 rounded-xl border transition-all duration-150 flex items-start gap-2.5 ${
                            isVerified
                              ? isDark
                                ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-200"
                                : "bg-emerald-50/70 border-emerald-300 text-emerald-900"
                              : isGap
                                ? isDark
                                  ? "bg-rose-950/20 border-rose-500/30 text-rose-200"
                                  : "bg-rose-50/70 border-rose-200 text-rose-900"
                                : isDark
                                  ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)] text-[var(--ui-text-secondary,#c7cad4)]"
                                  : "bg-slate-50/80 border-slate-200/80 hover:border-slate-300 text-slate-800 shadow-2xs"
                          }`}
                        >
                          <span
                            className={`flex h-5 w-5 rounded-full font-mono font-bold text-[10px] items-center justify-center shrink-0 mt-0.5 border ${
                              isDark ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-600 border-slate-300"
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="whitespace-pre-wrap leading-relaxed">{item}</p>
                            {matchingProposal && (
                              <div className="mt-1.5 flex items-center gap-2">
                                <span
                                  className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${
                                    isVerified
                                      ? isDark
                                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                        : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                      : isGap
                                        ? isDark
                                          ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
                                          : "bg-rose-50 text-rose-700 border-rose-200"
                                        : isDark
                                          ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                                          : "bg-amber-50 text-amber-700 border-amber-200"
                                  }`}
                                >
                                  {isVerified ? t("✓ 履历已核实", "Verified") : isGap ? t("⚠️ 技能缺口", "Gap") : t("⚡ 待补充证据", "Claimed")}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                  </>
                )}
              </div>
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
                    <div
                      className={`p-3.5 rounded-xl border transition-colors ${
                        isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div
                          className={`h-6 w-6 rounded-lg border flex items-center justify-center shrink-0 shadow-xs ${
                            isDark
                              ? "bg-gradient-to-br from-emerald-500/20 to-teal-500/30 text-emerald-400 border-emerald-500/30"
                              : "bg-gradient-to-br from-emerald-50 to-teal-100 text-emerald-700 border-emerald-200"
                          }`}
                        >
                          <Sparkles size={12} />
                        </div>
                        <h4 className={`text-xs font-bold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                          {t("BetterMe 专属求职顾问已就绪", "BetterMe Career Copilot Ready")}
                        </h4>
                      </div>
                      <p className={`text-[11px] leading-relaxed mb-2.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                        {t("可随时协助调研雇主背景、按 STAR 原则修改经历细节、寻找同类机会或演练面试答辩。", "Ask me to inspect employers, polish resume claims with STAR, or prep interview strategies.")}
                      </p>

                      {/* Quick Prompt Cards */}
                      <div className="grid grid-cols-3 gap-1.5 text-left">
                        <button
                          type="button"
                          onClick={() => void handleSendMessage(`帮我深入调研 ${currentJob?.company || "这家公司"} 的企业背景、实控人与经营稳定性`)}
                          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
                            isDark
                              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
                              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
                          }`}
                        >
                          <span className="text-xs shrink-0">🏢</span>
                          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("查公司", "Company")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            triggerAgentGuide({
                              section: "headline",
                              label: t("🤖 Agent 正在针对岗位优化个人优势", "🤖 Refining headline for job"),
                            });
                            void handleSendMessage("根据当前目标岗位 JD，帮我按 STAR 原则优化最核心的一段项目经历 Bullet Point");
                          }}
                          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
                            isDark
                              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
                              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
                          }`}
                        >
                          <span className="text-xs shrink-0">✍️</span>
                          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("STAR 润色", "STAR Polish")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            triggerAgentGuide({
                              section: "experience",
                              label: t("🤖 Agent 正在结合缺口准备面试防守", "🤖 Analyzing gaps for defense"),
                            });
                            void handleSendMessage("针对本岗位任职要求中我可能存在的经验缺口，提供高情商的面试应答防守策略");
                          }}
                          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
                            isDark
                              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
                              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
                          }`}
                        >
                          <span className="text-xs shrink-0">🛡️</span>
                          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("面试防守", "Defense")}</span>
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
                        <div className="w-full max-w-[95%] space-y-2.5 pl-2">
                          {msg.actions.map((action, aIdx) => (
                            <div
                              key={aIdx}
                              className={`rounded-2xl border p-3.5 shadow-md space-y-2.5 ${
                                isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200 bg-white"
                              }`}
                            >
                              {/* Company Card */}
                              {action.type === "company_card" && (
                                <>
                                  <div className="flex items-center justify-between">
                                    <div className={`flex items-center gap-1.5 font-bold text-xs ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                                      <Building2 size={14} className={isDark ? "text-emerald-400" : "text-emerald-600"} />
                                      <span>{action.companyName}</span>
                                    </div>
                                    <span
                                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                                        isDark
                                          ? "bg-[var(--ui-surface-raised,#2e3038)] text-emerald-300 border-emerald-500/30"
                                          : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                      }`}
                                    >
                                      {action.ownership || "实控人核查"}
                                    </span>
                                  </div>
                                  <p className={`text-xs leading-relaxed ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>{action.summary}</p>
                                  {action.officialUrl && (
                                    <a
                                      href={action.officialUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className={`inline-flex items-center gap-1 text-[11px] hover:underline ${
                                        isDark ? "text-emerald-400" : "text-emerald-700 font-semibold"
                                      }`}
                                    >
                                      <span>{t("访问招聘官网 / 工商链接", "Visit careers website")}</span>
                                      <ExternalLink size={11} />
                                    </a>
                                  )}
                                </>
                              )}

                              {/* Resume Proposal Card */}
                              {action.type === "resume_proposal" && (
                                <>
                                  <div className="flex items-center justify-between gap-2 text-xs">
                                    <span className={`font-bold flex min-w-0 items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                                      <Edit3 size={13} className={isDark ? "text-teal-400" : "text-teal-600"} />
                                      <span className="truncate">{t("简历修改提案", "Resume edit proposal")} · {action.targetSection}</span>
                                    </span>
                                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${action.sourceVerified
                                      ? isDark ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300" : "border-emerald-200 bg-emerald-50 text-emerald-800"
                                      : isDark ? "border-amber-500/35 bg-amber-500/10 text-amber-200" : "border-amber-200 bg-amber-50 text-amber-800"
                                    }`}>{action.sourceVerified ? t("已绑定简历原文", "Source verified") : t("只读 · 未绑定原文", "Read-only · unlinked")}</span>
                                  </div>
                                  {action.sourceVerified && action.originalText && <div className="grid gap-2 sm:grid-cols-2">
                                    <div className={`min-w-0 rounded-xl border p-3 ${isDark ? "border-[var(--ui-border,#484b58)] bg-black/15" : "border-slate-200 bg-slate-50"}`}>
                                      <div className={`mb-1.5 text-[10px] font-semibold ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>{t("当前原文", "Current text")}</div>
                                      <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>{action.originalText}</p>
                                    </div>
                                    <div className={`min-w-0 rounded-xl border p-3 ${isDark ? "border-teal-500/30 bg-teal-500/5" : "border-teal-200 bg-teal-50/60"}`}>
                                      <div className={`mb-1.5 text-[10px] font-semibold ${isDark ? "text-teal-300" : "text-teal-800"}`}>{t("建议替换为", "Suggested replacement")}</div>
                                      <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{action.proposedText}</p>
                                    </div>
                                  </div>}
                                  {!action.sourceVerified && <div className={`rounded-xl border p-3 text-xs leading-relaxed ${isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)]" : "border-slate-200 bg-slate-50 text-slate-800"}`}>
                                    <p>{action.proposedText}</p>
                                    {action.sourceIssue === "original_mismatch" && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-300"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{t("模型返回的原文与当前简历字段不一致；为避免错写，已禁用批准。请重新生成建议。", "The model’s source text does not exactly match the current resume field. Approval is disabled to prevent an incorrect write; regenerate the proposal.")}</p>}
                                    {action.sourceIssue === "not_shared" && <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">{t("该目标不在本次授权的简历字段中，不能写回。", "This target was not included in the fields you shared, so it cannot be written back.")}</p>}
                                  </div>}
                                  <p className={`text-[11px] leading-relaxed flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                                    <Lightbulb size={13} className="text-amber-500 shrink-0" />
                                    <span>{action.rationale}</span>
                                  </p>
                                  {(() => {
                                    const proposalKey = `${msg.id}:${aIdx}`;
                                    const decision = resumeProposalStates[proposalKey];
                                    return <div className="space-y-2 pt-1">
                                      {decision?.message && <p role="status" className={`text-[11px] ${decision.status === "conflict" || decision.status === "error" ? "text-rose-500" : decision.status === "approved" ? "text-emerald-500" : isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>{decision.message}</p>}
                                      <div className="flex flex-wrap items-center justify-end gap-2">
                                        <button type="button" onClick={() => triggerAgentGuide({ section: action.targetRef?.kind === "profile_headline" ? "headline" : "experience", text: action.proposedText, label: t("定位简历中的建议目标", "Locate the proposed resume field"), actionType: "suggest" })} className={`agent-btn-press inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs transition ${isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-teal-500/40" : "border-slate-200 bg-white text-slate-700 hover:border-teal-300"}`}>
                                          <Crosshair size={12} /><span>{t("定位目标", "Locate target")}</span>
                                        </button>
                                        {action.sourceVerified && !decision && <>
                                          <button type="button" onClick={() => void decideResumeProposal(proposalKey, action, false)} className={`agent-btn-press rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${isDark ? "border-rose-500/30 text-rose-200 hover:bg-rose-500/10" : "border-rose-200 text-rose-700 hover:bg-rose-50"}`}>
                                            {t("拒绝", "Reject")}
                                          </button>
                                          <button type="button" onClick={() => void decideResumeProposal(proposalKey, action, true)} className="agent-btn-press inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition hover:bg-teal-500">
                                            <Check size={12} />
                                            <span>{t("批准并写回简历", "Approve & write to resume")}</span>
                                          </button>
                                        </>}
                                        {decision?.status === "saving" && <span className="text-[11px] text-slate-400">{t("正在核对原文并保存…", "Checking source and saving…")}</span>}
                                      </div>
                                    </div>;
                                  })()}
                                </>
                              )}

                              {/* Interview Defense Card */}
                              {action.type === "interview_defense" && (
                                <>
                                  <div className={`flex items-center gap-1.5 font-bold text-xs ${isDark ? "text-amber-300" : "text-amber-800"}`}>
                                    <ShieldCheck size={14} className="text-amber-500" />
                                    <span>{t("面试答辩攻防点", "Interview defense")}：{action.gapItem}</span>
                                  </div>
                                  <div className={`text-xs space-y-1.5 ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                                    <p className={`font-semibold text-xs ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>【{t("防守策略", "Strategy")}】：{action.strategy}</p>
                                    <div
                                      className={`p-2.5 rounded-xl text-xs leading-relaxed border ${
                                        isDark
                                          ? "bg-[var(--ui-input,#22232a)] border-amber-500/30 text-amber-100"
                                          : "bg-amber-50/70 border-amber-200 text-slate-800"
                                      }`}
                                    >
                                      “{action.sampleAnswer}”
                                    </div>
                                  </div>
                                  <div className="pt-1 flex justify-end">
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(action.sampleAnswer || "", `card-${aIdx}`)}
                                      className={`agent-btn-press inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-xl cursor-pointer ${
                                        isDark
                                          ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                                          : "text-slate-700 hover:text-slate-900 border-slate-200 bg-slate-50"
                                      }`}
                                    >
                                      {copiedId === `card-${aIdx}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                      <span>{copiedId === `card-${aIdx}` ? t("已复制话术", "Copied") : t("复制答辩话术", "Copy script")}</span>
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {chatLoading && (
                    <div className="flex items-center gap-2 text-xs text-emerald-500 py-2 pl-2">
                      <Loader2 size={14} className="animate-spin text-emerald-500" />
                      <span>{t("Agent 正在结合当前岗位与本次授权内容思考…", "Agent is considering the current job and the context you shared…")}</span>
                    </div>
                  )}
                  {chatNotice && <p role="status" className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-300">{chatNotice}</p>}

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
                    onClick={() => void handleSendMessage(t("根据当前岗位的 JD 要求，按 STAR 原则优化我最核心的工作经历 Bullet Point", "Optimize key work experience bullet point with STAR method"))}
                    disabled={chatLoading}
                    className={`agent-btn-press shrink-0 px-3 py-1 rounded-full border transition disabled:opacity-50 cursor-pointer shadow-xs ${
                      isDark
                        ? "bg-[var(--ui-surface,#27282f)] hover:bg-[var(--ui-hover,#41434e)] hover:text-emerald-300 hover:border-emerald-500/40 border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)]"
                        : "bg-white hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200 border-slate-200 text-slate-700 shadow-2xs"
                    }`}
                  >
                    ✍️ {t("按 STAR 润色核心经历", "Optimize resume with STAR")}
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
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder={t(
                        "向 Copilot 提问或提出修改需求（例如：帮我查公司实控人、按 STAR 润色经历、推演面试考点）…",
                        "Ask copilot anything (e.g. inspect employer, polish with STAR, interview prep)..."
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
                        <button type="button" disabled={chatLoading || pendingAttachments.length >= 3} onClick={() => chatImageInputRef.current?.click()} title={t("添加图片（最多 3 张）", "Attach images (up to 3)")} className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition disabled:opacity-40 ${isDark ? "border-[var(--ui-border,#484b58)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-emerald-500/40 hover:text-emerald-300" : "border-slate-200 text-slate-600 hover:border-emerald-300 hover:text-emerald-700"}`} aria-label={t("上传图片", "Upload image")}><ImagePlus size={15} /></button>
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
                        disabled={(!inputMessage.trim() && !pendingAttachments.length && !pendingReferences.length) || (pendingAttachments.length > 0 && imageCapability === "unsupported")}
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

        {!showRightPane && (
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
          aria-valuenow={Math.round(splitPercent)}
          title={t("拖动调整左右宽度；双击恢复 46:54 默认布局", "Drag left/right to resize; double-click to reset")}
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
            {Math.round(splitPercent)}% / {Math.round(100 - splitPercent)}%
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
                    {t("岗位摘要", "Job summary")}
                  </h3>
                  <p className={`text-[11px] mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {t("确认左侧字段后开始拆解", "Confirm fields on the left, then start")}
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
                <div className="space-y-3 text-xs">
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
            <>
          <div
            className={`px-4 py-3.5 border-b shrink-0 ${
              isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200"
            }`}
          >
            {(() => {
              const ringR = 20;
              const ringC = 2 * Math.PI * ringR;
              const ringOffset = ringC - (Math.max(0, Math.min(100, animatedScore)) / 100) * ringC;
              const scoreTone =
                stats.score >= 80 ? "text-emerald-600" : stats.score >= 55 ? "text-teal-600" : stats.score >= 35 ? "text-amber-600" : "text-rose-600";
              const scoreStroke =
                stats.score >= 80 ? "stroke-emerald-500" : stats.score >= 55 ? "stroke-teal-500" : stats.score >= 35 ? "stroke-amber-500" : "stroke-rose-500";
              const scoreLabel = loading
                ? t("正在比对", "Matching")
                : stats.total === 0
                  ? t("尚无结果", "No result")
                  : stats.score >= 80
                    ? t("高度契合", "Strong fit")
                    : stats.score >= 55
                      ? t("基本契合", "Fair fit")
                      : stats.score >= 35
                        ? t("部分契合", "Partial fit")
                        : t("差距较大", "Wide gap");
              const mixTotal = Math.max(stats.total, 1);
              return (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
              <div className="min-w-0 flex items-center gap-3.5">
                <div className="relative h-[52px] w-[52px] shrink-0" aria-hidden>
                  <svg className="h-[52px] w-[52px] -rotate-90" viewBox="0 0 56 56">
                    <circle
                      cx="28"
                      cy="28"
                      r={ringR}
                      strokeWidth="3"
                      fill="none"
                      className={isDark ? "stroke-[var(--ui-border,#484b58)]" : "stroke-slate-200"}
                    />
                    {loading ? (
                      <circle
                        cx="28"
                        cy="28"
                        r={ringR}
                        strokeWidth="3"
                        fill="none"
                        strokeLinecap="round"
                        strokeDasharray={`${ringC * 0.22} ${ringC}`}
                        className={`stroke-emerald-500 fit-ring-pending`}
                      />
                    ) : (
                      <circle
                        cx="28"
                        cy="28"
                        r={ringR}
                        strokeWidth="3"
                        fill="none"
                        strokeLinecap="round"
                        strokeDasharray={ringC}
                        strokeDashoffset={ringOffset}
                        className={`fit-ring-value ${scoreStroke}`}
                      />
                    )}
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className={`text-[13px] font-semibold tabular-nums tracking-tight leading-none ${loading ? (isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400") : isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                      {loading ? "…" : animatedScore}
                    </span>
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <p className={`text-[13px] font-semibold tracking-tight truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                      {currentJob?.title || t("目标岗位", "Target role")}
                    </p>
                    <span className={`text-[11px] shrink-0 tabular-nums ${loading ? (isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400") : scoreTone}`}>
                      {loading ? "" : `${animatedScore}%`}
                      <span className={`ml-1 font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                        {scoreLabel}
                      </span>
                    </span>
                  </div>
                  {currentJob?.company ? (
                    <p className={`text-[11px] truncate mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                      {currentJobView.company}
                    </p>
                  ) : null}

                  <div
                    className={`mt-2 h-1 w-full rounded-full overflow-hidden flex ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`}
                    aria-hidden
                  >
                    {loading || stats.total === 0 ? (
                      <div className={`h-full w-1/3 rounded-full ${loading ? "bg-emerald-400/70 animate-pulse" : ""}`} />
                    ) : (
                      <>
                        <div className="fit-mix-seg h-full bg-emerald-500" style={{ width: `${(stats.verified / mixTotal) * 100}%` }} />
                        <div className="fit-mix-seg h-full bg-amber-400" style={{ width: `${(stats.claimed / mixTotal) * 100}%` }} />
                        <div className="fit-mix-seg h-full bg-rose-400" style={{ width: `${(stats.gaps / mixTotal) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <div className={`mt-1.5 flex items-center gap-3 text-[11px] tabular-nums ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {loading ? "—" : stats.verified} {t("已核实", "verified")}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                      {loading ? "—" : stats.claimed} {t("待核验", "claimed")}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                      {loading ? "—" : stats.gaps} {t("缺口", "gaps")}
                    </span>
                    <span className="sr-only">{t("契合度", "fit")}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 self-center">
                <button
                  type="button"
                  onClick={() => setRightPaneOpen(false)}
                  className={`agent-btn-press hidden lg:inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-medium cursor-pointer ${
                    isDark
                      ? "border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)] hover:text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:text-slate-900"
                  }`}
                  title={t("收起匹配结果", "Collapse match results")}
                >
                  <PanelRightClose size={13} />
                  <span>{t("收起", "Hide")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (currentJob?.description) {
                      void runMatching(currentJobView.description);
                    } else {
                      setIsEditingJob(true);
                    }
                  }}
                  disabled={loading}
                  className={`agent-btn-press inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition disabled:opacity-50 cursor-pointer ${
                    isDark
                      ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-secondary,#c7cad4)] hover:text-white hover:bg-[var(--ui-hover,#41434e)]"
                      : "border-slate-200 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50"
                  }`}
                >
                  <RefreshCw size={12} className={loading ? "animate-spin text-emerald-500" : ""} />
                  <span>{loading ? t("分析中…", "Analyzing…") : t("重新分析", "Re-match")}</span>
                </button>

                <button
                  type="button"
                  onClick={handleApply}
                  disabled={stats.acceptedCount === 0 || isApplying}
                  className="agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isApplying ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  <span>
                    {isApplying
                      ? t("应用中…", "Applying…")
                      : t(`应用已采纳 (${stats.acceptedCount})`, `Apply accepted (${stats.acceptedCount})`)}
                  </span>
                </button>
              </div>
            </div>
              );
            })()}

            {errorNotice && (
              <div
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] ${
                  isDark
                    ? "bg-rose-950/40 border-rose-500/30 text-rose-300"
                    : "bg-rose-50 border-rose-200 text-rose-700"
                }`}
              >
                <AlertTriangle size={13} className="shrink-0 text-rose-500" />
                <span className="truncate">{errorNotice}</span>
              </div>
            )}
          </div>

          <div className={`flex-1 flex flex-col min-h-0 ${isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-[#f7f6f3]"}`}>
            <div className="px-3 pt-3 shrink-0">
              <div
                className={`grid grid-cols-4 p-0.5 rounded-lg ${
                  isDark ? "bg-[var(--ui-surface-soft,#363842)]" : "bg-slate-200/70"
                }`}
              >
                {(
                  [
                    ["all", t("全部提案", "All"), stats.total],
                    ["accepted", t("已采纳", "Accepted"), stats.acceptedCount],
                    ["pending", t("待审核", "Pending"), stats.pendingCount],
                    ["rejected", t("已忽略", "Rejected"), stats.rejectedCount],
                  ] as const
                ).map(([key, label, count]) => {
                  const active = proposalFilter === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setProposalFilter(key)}
                      className={`agent-btn-press py-1.5 rounded-md text-[11px] font-medium tabular-nums cursor-pointer transition-colors ${
                        active
                          ? isDark
                            ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text,#edeef4)] shadow-sm"
                            : "bg-white text-slate-900 shadow-sm"
                          : isDark
                            ? "text-[var(--ui-text-muted,#a7adbd)] hover:text-[var(--ui-text,#edeef4)]"
                            : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      {label}
                      <span className={`ml-1 ${active ? "" : "opacity-70"}`}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className={`flex-1 overflow-y-auto p-3 space-y-2.5 min-h-0 agent-custom-scrollbar ${
                isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-slate-50/40"
              }`}
            >
              {loading && (
                <div className="space-y-2.5" aria-busy="true">
                  <p className={`text-[11px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                    {t("正在比对岗位与履历…", "Matching job against your profile…")}
                  </p>
                  {[0, 1, 2].map((row) => (
                    <div
                      key={row}
                      className={`rounded-xl border px-3 py-3 space-y-2 ${
                        isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200/80 bg-white"
                      }`}
                    >
                      <div className={`h-2.5 rounded-full w-2/5 animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-200"}`} />
                      <div className={`h-2 rounded-full w-full animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`} />
                      <div className={`h-2 rounded-full w-4/5 animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`} />
                    </div>
                  ))}
                </div>
              )}

              {!loading && proposals.length === 0 && (
                <div className={`py-12 text-center space-y-2 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                  <Target size={28} className={`mx-auto ${isDark ? "text-[var(--ui-border,#484b58)]" : "text-slate-300"}`} />
                  <p className="text-xs">{t("暂无提案。设定岗位后点击「开始拆解」", "No proposals yet. Set a job and start matching.")}</p>
                </div>
              )}

              {!loading && gapProposals.length > 0 && proposalFilter === "all" && (
                <div
                  className={`rounded-xl border ${
                    isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200/80 bg-white"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setShowGapsSummary((open) => !open)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left cursor-pointer ${
                      isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"
                    }`}
                  >
                    <span className="text-[12px] font-medium">
                      {t(`${gapProposals.length} 项缺口`, `${gapProposals.length} gaps`)}
                      <span className={`ml-2 font-normal ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                        {t("面试时需要应答", "Worth preparing")}
                      </span>
                    </span>
                    {showGapsSummary ? <ChevronUp size={14} className="shrink-0 opacity-60" /> : <ChevronDown size={14} className="shrink-0 opacity-60" />}
                  </button>
                  {showGapsSummary && (
                    <ul className={`border-t text-[12px] leading-relaxed ${isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-100"}`}>
                      {gapProposals.map((g) => (
                        <li
                          key={g.id}
                          className={`flex items-start justify-between gap-3 px-3 py-2.5 ${
                            isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"
                          }`}
                        >
                          <span>
                            <span className={`font-medium ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>{g.jdItem}</span>
                            <span className={isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}> · {g.rationale}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              if (leftViewMode === "jd") showLeftPage("chat");
                              void handleSendMessage(`针对这个岗位的缺口项“${g.jdItem}”，帮我制定一套高情商的面试应答与能力迁移策略`);
                            }}
                            className={`shrink-0 text-[11px] cursor-pointer hover:underline ${isDark ? "text-emerald-300" : "text-emerald-700"}`}
                          >
                            {t("问顾问", "Ask")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!loading && filteredProposals.length === 0 && proposals.length > 0 && (
                <div className={`py-10 text-center text-xs ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                  {t("当前筛选条件下没有提案", "No proposals under this filter")}
                </div>
              )}

              {!loading && filteredProposals.map((proposal, idx) => {
                const decision = decisions[proposal.id];
                const isAccepted = decision?.status === "accepted";
                const isEdited = decision?.status === "edited";
                const isRejected = decision?.status === "rejected";
                const isEditing = editingProposalId === proposal.id;
                const isDiffOpen = activeDiffProposalId === proposal.id;

                const displayText = isEdited ? decision.editedSuggestion : proposal.suggestion;
                const currentOriginalClaim = getClaimText(proposal.profileEntryId);
                const evidenceBorder =
                  proposal.evidenceType === "verified"
                    ? "border-l-emerald-500"
                    : proposal.evidenceType === "claimed"
                      ? "border-l-amber-500"
                      : "border-l-rose-500";

                return (
                  <div
                    key={proposal.id}
                    style={{ animationDelay: `${Math.min(idx * 50, 400)}ms` }}
                    className={`agent-stagger-item rounded-xl border border-l-[3px] ${evidenceBorder} transition-all duration-200 p-3 space-y-2.5 ${
                      isAccepted
                        ? isDark
                          ? "border-emerald-500/40 bg-emerald-950/15"
                          : "border-emerald-200 bg-emerald-50/40"
                        : isEdited
                          ? isDark
                            ? "border-teal-500/40 bg-teal-950/15"
                            : "border-teal-200 bg-teal-50/40"
                          : isRejected
                            ? isDark
                              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] opacity-50"
                              : "border-slate-200 bg-slate-100/60 opacity-60"
                            : isDark
                              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-surface-raised,#2e3038)]"
                              : "bg-white border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold shrink-0 mt-0.5 ${
                            isDark
                              ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)]"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <h4 className={`text-xs font-semibold leading-snug ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                          {proposal.jdItem}
                        </h4>
                      </div>

                      <span
                        className={`text-[10px] font-medium shrink-0 ${
                          proposal.evidenceType === "verified"
                            ? isDark
                              ? "text-emerald-400"
                              : "text-emerald-700"
                            : proposal.evidenceType === "claimed"
                              ? isDark
                                ? "text-amber-400"
                                : "text-amber-700"
                              : isDark
                                ? "text-rose-400"
                                : "text-rose-700"
                        }`}
                      >
                        {proposal.evidenceType === "verified"
                          ? t("已核实", "Verified")
                          : proposal.evidenceType === "claimed"
                            ? t("待核验", "Claimed")
                            : t("缺口", "Gap")}
                      </span>
                    </div>

                    {/* Suggestion text or Inline Editor */}
                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          value={editedText}
                          onChange={(e) => setEditedText(e.target.value)}
                          rows={3}
                          className={`w-full rounded-xl border p-3 text-xs outline-none font-sans leading-relaxed ${
                            isDark
                              ? "border-teal-500/60 bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)]"
                              : "border-teal-400 bg-white text-slate-900 shadow-inner"
                          }`}
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className={`agent-btn-press px-2.5 py-1 text-xs rounded-lg cursor-pointer ${
                              isDark ? "text-[var(--ui-text-muted,#a7adbd)] hover:bg-[var(--ui-hover,#41434e)]" : "text-slate-600 hover:bg-slate-100"
                            }`}
                          >
                            {t("取消", "Cancel")}
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(proposal.id)}
                            className="agent-btn-press px-3 py-1 text-xs font-bold text-white bg-teal-600 hover:bg-teal-500 rounded-lg cursor-pointer"
                          >
                            {t("保存修改", "Save edit")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p
                        className={`text-xs leading-relaxed font-sans ${
                          isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"
                        }`}
                      >
                        {displayText}
                      </p>
                    )}

                    <p
                      className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${
                        isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"
                      }`}
                    >
                      <Lightbulb size={12} className="text-amber-400 shrink-0 mt-0.5" />
                      <span>{proposal.rationale}</span>
                    </p>

                    {/* Diff Comparison Accordion when Locating */}
                    {isDiffOpen && (
                      <div
                        className={`agent-diff-popover p-3 rounded-xl border space-y-2 text-xs ${
                          isDark
                            ? "bg-[var(--ui-surface-raised,#2e3038)] border-emerald-500/40"
                            : "bg-slate-50 border-emerald-300 shadow-sm"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] font-bold">
                          <span className={isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}>
                            {currentOriginalClaim ? t("原始履历记录", "Original Claim") : t("当前简历状态", "Current Resume")}
                          </span>
                          <ArrowRight size={12} className={isDark ? "text-emerald-400" : "text-emerald-600"} />
                          <span className={isDark ? "text-emerald-400" : "text-emerald-700"}>
                            {t("建议定制优化表达", "Proposed Resume Expression")}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div
                            className={`p-2.5 rounded-xl border text-[11px] leading-relaxed ${
                              isDark
                                ? "bg-[var(--ui-input,#22232a)] border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)]"
                                : "bg-white border-slate-200 text-slate-600"
                            }`}
                          >
                            {currentOriginalClaim || (
                              <span className="italic">
                                {t("（简历中暂无明确对应经历，此项为针对 JD 要求的补充或应答建议）", "(No existing claim in resume; this is gap defense / addition suggestion)")}
                              </span>
                            )}
                          </div>
                          <div
                            className={`p-2.5 rounded-xl border text-[11px] leading-relaxed ${
                              isDark
                                ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-200"
                                : "bg-emerald-50 border-emerald-200 text-emerald-900"
                            }`}
                          >
                            {displayText}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Action Buttons */}
                    <div className={`flex items-center justify-between pt-2.5 border-t ${isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-100"}`}>
                      <div className="flex items-center gap-1.5">
                        {isAccepted && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                            <CheckCircle2 size={13} />
                            {t("已采纳", "Accepted")}
                          </span>
                        )}
                        {isEdited && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-400">
                            <Edit3 size={13} />
                            {t("已微调并采纳", "Edited & Accepted")}
                          </span>
                        )}
                        {isRejected && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ui-text-muted,#a7adbd)]">
                            <X size={13} />
                            {t("已忽略", "Rejected")}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveDiffProposalId(isDiffOpen ? null : proposal.id);
                            triggerAgentGuide({
                              claimId: proposal.profileEntryId,
                              text: proposal.suggestion,
                              label: t("🤖 Agent 建议定位此处", "🤖 Locate here"),
                              actionType: "suggest",
                            });
                          }}
                          title={t("在简历对应履历进行视觉引导高亮与前后对比", "Locate claim with diff preview")}
                          className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-medium border transition cursor-pointer ${
                            isDark
                              ? "text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30"
                              : "text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200"
                          }`}
                        >
                          <Crosshair size={12} />
                          <span>{isDiffOpen ? t("收起对比", "Hide Diff") : t("定位", "Locate")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDecision(proposal.id, "accepted")}
                          className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                            isAccepted
                              ? "bg-emerald-600 text-white shadow-xs"
                              : isDark
                                ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:bg-emerald-600/30 hover:text-emerald-300 border border-[var(--ui-border,#484b58)]"
                                : "bg-slate-100 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 border border-slate-200"
                          }`}
                        >
                          <Check size={12} />
                          <span>{t("采纳", "Accept")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => startEdit(proposal)}
                          className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                            isEdited
                              ? "bg-teal-600 text-white shadow-xs"
                              : isDark
                                ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:bg-teal-600/30 hover:text-teal-300 border border-[var(--ui-border,#484b58)]"
                                : "bg-slate-100 text-slate-700 hover:bg-teal-50 hover:text-teal-700 border border-slate-200"
                          }`}
                        >
                          <Edit3 size={12} />
                          <span>{t("微调", "Edit")}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDecision(proposal.id, "rejected")}
                          className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                            isRejected
                              ? "bg-slate-600 text-white"
                              : isDark
                                ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-muted,#a7adbd)] hover:bg-rose-950/40 hover:text-rose-400 border border-[var(--ui-border,#484b58)]"
                                : "bg-slate-100 text-slate-500 hover:bg-rose-50 hover:text-rose-700 border border-slate-200"
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

          </div>
        </>
      )}
    </div>
        )}
  </div>

      {/* ── Guided Application Multi-Step Transition Overlay Modal ──── */}
      {isApplying && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md ${isDark ? "bg-black/70" : "bg-slate-900/40"}`}>
          <div
            className={`agent-diff-popover w-full max-w-md rounded-3xl border p-6 shadow-2xl space-y-5 text-center ${
              isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] text-[var(--ui-text,#edeef4)]" : "bg-white border-slate-200 text-slate-900"
            }`}
          >
            <div
              className={`h-14 w-14 mx-auto rounded-3xl border flex items-center justify-center shadow-xs ${
                isDark
                  ? "bg-gradient-to-br from-emerald-500/20 to-teal-500/30 text-emerald-400 border-emerald-500/30"
                  : "bg-gradient-to-br from-emerald-50 to-teal-100 text-emerald-700 border-emerald-200"
              }`}
            >
              <Sparkles size={28} className="animate-spin text-emerald-500" />
            </div>

            <div>
              <h3 className="text-base font-bold tracking-tight">
                {t("AI 顾问正在生成专属定制版简历", "Generating Tailored Resume...")}
              </h3>
              <p className={`text-xs mt-1 ${isDark ? "text-[var(--ui-text-muted,#8b90a0)]" : "text-slate-500"}`}>
                {currentJob?.company} · {currentJob?.title}
              </p>
            </div>

            {/* Stepper Checklist */}
            <div className="space-y-3 text-left max-w-xs mx-auto text-xs">
              <div
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${
                  applyStep >= 1
                    ? isDark
                      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200"
                      : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    : isDark
                      ? "bg-[var(--ui-surface-soft,#363842)]/50 border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#8b90a0)]"
                      : "bg-slate-100 border-slate-200 text-slate-400"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    applyStep >= 1 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
                  }`}
                >
                  {applyStep > 1 ? <Check size={12} /> : "1"}
                </span>
                <span className="font-semibold">创建岗位专属定制简历副本</span>
              </div>

              <div
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${
                  applyStep >= 2
                    ? isDark
                      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200"
                      : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    : isDark
                      ? "bg-[var(--ui-surface-soft,#363842)]/50 border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#8b90a0)]"
                      : "bg-slate-100 border-slate-200 text-slate-400"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    applyStep >= 2 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
                  }`}
                >
                  {applyStep > 2 ? <Check size={12} /> : "2"}
                </span>
                <span className="font-semibold">注入 {stats.acceptedCount} 项采纳的真实经历与量化成果</span>
              </div>

              <div
                className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${
                  applyStep >= 3
                    ? isDark
                      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200"
                      : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    : isDark
                      ? "bg-[var(--ui-surface-soft,#363842)]/50 border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#8b90a0)]"
                      : "bg-slate-100 border-slate-200 text-slate-400"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    applyStep >= 3 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
                  }`}
                >
                  {applyStep === 3 ? <Loader2 size={12} className="animate-spin" /> : "3"}
                </span>
                <span className="font-semibold">自动平滑切回编辑器并定位高亮条目</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
