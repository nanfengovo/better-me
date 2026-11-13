/** @jsxRuntime automatic */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LlmConfig, ProjectedResume } from "@better-me/core";
import {
  Activity,
  Bot,
  ChevronRight,
  CircleAlert,
  Command,
  Cpu,
  ChevronDown,
  ExternalLink,
  FileText,
  ImagePlus,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { testLlmConnection } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";
import { readChatImage, chatImageErrorMessage, MAX_CHAT_IMAGES, type ChatImageAttachment } from "../lib/chat-images";
import { createCompanionResumeSummary } from "../lib/resume-agent-context";
import {
  listLocalAgentRuntimes,
  scanLocalAgentRuntimes,
  sendAgentChat,
  pauseAgentChatTask,
  chatMessagesForRequest,
  type ChatMessage,
  type LocalRuntimeInfo,
  type ResumeTextReference,
} from "../services/agent-client";
import { getModelImageCapability, modelImageCapabilityDescription, modelImageCapabilityLabel } from "../lib/model-image-capability";
import { AgentBrandIcon as RuntimeIcon } from "./AgentBrandIcon";
import { AgentMarkdownRenderer } from "./AgentMarkdownRenderer";
import { AgentReplyMeta } from "./AgentReplyMeta";
import "./agent-companion.css";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { useAgentTaskRuntime } from "../lib/agent-task-runtime";
import { AgentContinuityButton, AgentMemoryConsent, AgentModelControls } from "./BetterMeAgentCenter";
import { agentBaseLabel, useAgentRouting } from "../lib/agent-routing";
import { AgentSurface, useAgentSidebar } from "./AgentSidebar";
import { OneOffAgentTask } from "./OneOffAgentTask";
import { defaultChatGptClient, type ChatGptClient } from "../services/chatgpt-client";
import { useRecoveryField, useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import { CompanionRecoverySchema } from "../lib/advisor-recovery";
import { privateKey } from "../lib/private-storage";
import { WorkspaceRecoveryNotice } from "./WorkspaceRecoveryNotice";

export interface AgentCompanionProps {
  workspaceKey?: string;
  onOpenWorkspace: () => void;
  llmConfig: LlmConfig;
  onOpenAiConfig: () => void;
  resume?: ProjectedResume | null;
  initialReference?: ResumeTextReference | null;
  onReferenceConsumed?: () => void;
  initialPrompt?: string | null;
  onPromptConsumed?: () => void;
  chatGptClient?: ChatGptClient;
  sendChat?: typeof sendAgentChat;
}

type ProviderCheck = "unknown" | "checking" | "ready" | "offline" | "unconfigured";

const CHAT_GUIDES = [
  { id: "plan", zh: "规划方向", en: "Plan a direction", promptZh: "请引导我梳理下一步职业规划：先问我最关键的目标和约束，再根据我的回答分步调整方案。", promptEn: "Guide me through a career plan: ask about my most important goal and constraints first, then adjust the steps based on my answers." },
  { id: "revise", zh: "修改建议", en: "Review an edit", promptZh: "请先了解我想修改的简历部分和目标岗位，再给出有依据的修改建议；缺少事实请先追问，不要编造。", promptEn: "Ask which resume section and target role I mean, then suggest evidence-based edits. Ask for missing facts instead of inventing them." },
  { id: "study", zh: "学习监督", en: "Study check-in", promptZh: "请作为学习教练，先确认我的目标、可用时间与当前水平，再安排一小步练习，并在我反馈后调整。", promptEn: "Be my study coach: ask about my goal, available time and current level, assign one small exercise, then adjust after my feedback." },
  { id: "interview", zh: "模拟面试", en: "Mock interview", promptZh: "请按目标岗位进行模拟面试：先确认岗位和级别，然后一次问我一个问题，等我回答后给出反馈和下一题。", promptEn: "Run a mock interview: confirm the role and level first, ask one question at a time, wait for my answer, then give feedback and the next question." },
] as const;


function runtimeTone(id: string): string {
  if (id === "claude-code") return "brand-claude";
  if (id === "opencode") return "brand-opencode";
  if (id === "gemini-cli") return "brand-gemini";
  if (id === "codex") return "brand-codex";
  if (id === "deepseek-harness") return "brand-deepseek";
  if (id === "pi") return "brand-pi";
  if (id === "antigravity") return "brand-antigravity";
  if (id === "ollama") return "brand-ollama";
  return "brand-neutral";
}

function providerTone(config: LlmConfig): string {
  if (config.provider === "ollama") return "ollama";
  if (config.provider === "gemini") return "gemini";
  if (config.provider === "openai-compatible") {
    if (config.baseUrl.includes("deepseek")) return "deepseek";
    if (config.baseUrl.includes("openai.com")) return "openai";
    return "compatible";
  }
  return "custom";
}

function providerName(config: LlmConfig, t: (zh: string, en: string) => string): string {
  if (config.provider === "ollama") return t("Ollama · 本地", "Ollama · local");
  if (config.provider === "gemini") return "Google Gemini";
  if (config.provider === "openai-compatible") {
    if (config.baseUrl.includes("deepseek")) return "DeepSeek · API";
    if (config.baseUrl.includes("openai.com")) return "OpenAI · API";
    return t("OpenAI-compatible · API", "OpenAI-compatible · API");
  }
  return t("自定义 Provider", "Custom provider");
}

function providerStatusLabel(status: ProviderCheck, t: (zh: string, en: string) => string): string {
  if (status === "checking") return t("检测中", "Checking");
  if (status === "ready") return t("已连接", "Connected");
  if (status === "offline") return t("连接异常", "Offline");
  if (status === "unconfigured") return t("待配置", "Setup needed");
  return t("未检测", "Not checked");
}

function runtimeStatusLabel(runtime: LocalRuntimeInfo, t: (zh: string, en: string) => string): string {
  if (runtime.status === "available") return t("可用", "Ready");
  if (runtime.status === "not-installed") return t("未安装", "Not installed");
  if (runtime.status === "needs-config") return t("需配置", "Needs setup");
  return t("异常", "Error");
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

function toTypewriterPreview(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "• ")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/~~(.*?)~~/gs, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .trim();
}

function AgentCompanionReply({
  content,
  animate,
  isDark,
  skipLabel,
  messageId,
  onComplete,
  onProgress,
}: {
  content: string;
  animate: boolean;
  isDark: boolean;
  skipLabel: string;
  messageId: string;
  onComplete: (messageId: string) => void;
  onProgress: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const preview = useMemo(() => toTypewriterPreview(content), [content]);
  const [visibleText, setVisibleText] = useState(() => animate && !reducedMotion ? "" : preview);

  useEffect(() => {
    if (!animate || reducedMotion) {
      setVisibleText(preview);
      if (animate) onComplete(messageId);
      return;
    }

    const characters = Array.from(preview);
    if (!characters.length) {
      onComplete(messageId);
      return;
    }

    const steps = Math.min(120, characters.length);
    const chunkSize = Math.max(1, Math.ceil(characters.length / steps));
    const delay = Math.max(12, Math.min(24, 1_800 / steps));
    let position = 0;
    let timer = 0;
    const revealNext = () => {
      position = Math.min(characters.length, position + chunkSize);
      setVisibleText(characters.slice(0, position).join(""));
      onProgress();
      if (position >= characters.length) {
        onComplete(messageId);
        return;
      }
      timer = window.setTimeout(revealNext, delay);
    };

    timer = window.setTimeout(revealNext, 20);
    return () => window.clearTimeout(timer);
  }, [animate, messageId, onComplete, onProgress, preview, reducedMotion]);

  if (animate && !reducedMotion && visibleText !== preview) {
    return (
      <div className="agent-companion-chat-typing" data-testid="agent-companion-typewriter">
        <span className="agent-companion-sr-only" aria-live="polite" aria-atomic="true">{content}</span>
        <p className="agent-companion-chat-typewriter" aria-hidden="true">{visibleText}<span className="agent-companion-typewriter-caret" /></p>
        <button type="button" className="agent-companion-chat-skip-typing" onClick={() => onComplete(messageId)}>{skipLabel}</button>
      </div>
    );
  }

  return <AgentMarkdownRenderer content={content} isDark={isDark} />;
}

export function AgentCompanion(props: AgentCompanionProps) {
  return <AgentCompanionSession key={privateKey(props.workspaceKey ?? "active-resume")} {...props} />;
}

function AgentCompanionSession({ workspaceKey = "active-resume", onOpenWorkspace, llmConfig, onOpenAiConfig, resume, initialReference, onReferenceConsumed, initialPrompt, onPromptConsumed, chatGptClient = defaultChatGptClient, sendChat = sendAgentChat }: AgentCompanionProps) {
  const recovery = useWorkspaceRecovery(`companion:${workspaceKey}`, CompanionRecoverySchema, () => ({ messages: [], draft: "", references: [], attachments: [], prompt: "", pending: false }));
  const saveRecoveryField = recovery.field;
  const { agent, snapshot: agentSnapshot } = useBetterMeAgent();
  const [shareAgentMemory, setShareAgentMemory] = useState(false);
  const agentTask = useRef<string | undefined>(undefined);
  const hydratedScope = useRef<string | undefined>(undefined);
  const selection = agentSnapshot?.data.selection;
  const routing = useAgentRouting();
  const account = !routing?.enabled && selection?.kind === "chatgpt";
  const accountReady = agentSnapshot?.chatGptReady ?? false;
  const taskRuntime = useAgentTaskRuntime(llmConfig);
  useEffect(() => { setShareAgentMemory(false); }, [llmConfig.provider, llmConfig.baseUrl, llmConfig.model, llmConfig.apiKey, selection?.kind, selection?.profileId, selection?.model]);
  const { t, theme } = useUiPreferences();
  const sidebar = useAgentSidebar();
  const showSidebar = sidebar?.show, hideSidebar = sidebar?.hide;
  const [localOpen, setLocalOpen] = useState(false);
  const open = sidebar ? sidebar.open && sidebar.tab === "conversation" && sidebar.conversation === "companion" : localOpen;
  const setOpen = useCallback((next: boolean) => {
    if (showSidebar && hideSidebar) { if (next) showSidebar("conversation", "companion"); else hideSidebar(); }
    else setLocalOpen(next);
  }, [showSidebar, hideSidebar]);
  const [runtimes, setRuntimes] = useState<LocalRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [quickRunExpanded, setQuickRunExpanded] = useState(false);
  const [providerExpanded, setProviderExpanded] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useRecoveryField(recovery, "prompt");
  const [providerCheck, setProviderCheck] = useState<ProviderCheck>("unknown");
  const [providerMessage, setProviderMessage] = useState("");
  const imageCapability = getModelImageCapability(llmConfig);
  const [chatMessages, setChatMessages] = useRecoveryField(recovery, "messages");
  useEffect(() => {
    if (!agent || !agentSnapshot?.ready || agentSnapshot.error || hydratedScope.current === agent.workspaceKey) return;
    hydratedScope.current = agent.workspaceKey;
    const saved = agentSnapshot.data.messages.filter(message => message.origin === "companion" && message.role !== "event").map(message => ({ id: message.id, role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text, createdAt: message.at }));
    setChatMessages(current => [...current, ...saved.filter(message => !current.some(item => item.id === message.id))]);
  }, [agent, agentSnapshot, setChatMessages]);
  const [chatDraft, setChatDraft] = useRecoveryField(recovery, "draft");
  const [chatReferences, setChatReferences] = useRecoveryField(recovery, "references");
  const [chatAttachments, setChatAttachments] = useRecoveryField(recovery, "attachments");
  const [chatAttachmentError, setChatAttachmentError] = useState("");
  const [readingChatAttachments, setReadingChatAttachments] = useState(false);
  const [shareResumeContext, setShareResumeContext] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatNotice, setChatNotice] = useState(recovery.value.pending ? "上次请求已中断，问题和已完成的对话已保留；请核对后手动重试，未自动重发。" : "");
  const [typingReplyId, setTypingReplyId] = useState<string | null>(null);
  const [chatError, setChatError] = useState("");
  const chatAbortRef = useRef<AbortController | null>(null);
  const kernelChatId = useRef<string|undefined>(undefined);
  const pendingChatRef = useRef<ChatMessage | null>(null);
  const providerAbortRef = useRef<AbortController | null>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const chatAutoScrollRef = useRef(true);
  const chatComposerRef = useRef<HTMLTextAreaElement>(null);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const onReferenceConsumedRef = useRef(onReferenceConsumed);
  const onPromptConsumedRef = useRef(onPromptConsumed);
  const focusIncomingPromptRef = useRef(false);

  useEffect(() => { onReferenceConsumedRef.current = onReferenceConsumed; }, [onReferenceConsumed]);
  useEffect(() => { onPromptConsumedRef.current = onPromptConsumed; }, [onPromptConsumed]);
  useEffect(() => { const openCompanion = () => setOpen(true); window.addEventListener("betterme:open-companion", openCompanion); return () => window.removeEventListener("betterme:open-companion", openCompanion); }, [setOpen]);
  useEffect(() => {
    if (!initialPrompt) return;
    setOpen(true);
    setToolsExpanded(false);
    focusIncomingPromptRef.current = true;
    setChatDraft(current => current ? `${current}\n\n${initialPrompt}` : initialPrompt);
    onPromptConsumedRef.current?.();
  }, [initialPrompt, setOpen, setChatDraft]);
  useEffect(() => {
    if (!initialReference) return;
    setOpen(true);
    setToolsExpanded(false);
    setChatReferences((previous) => previous.some((reference) => reference.text === initialReference.text && reference.sourceLabel === initialReference.sourceLabel)
      ? previous
      : [...previous, initialReference].slice(-5));
    setChatDraft((current) => current || t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text."));
    onReferenceConsumedRef.current?.();
  }, [initialReference, t, setOpen, setChatDraft, setChatReferences]);

  useEffect(() => {
    if (open && chatReferences.length) chatComposerRef.current?.focus();
  }, [open, chatReferences.length]);
  useEffect(() => {
    if (open && focusIncomingPromptRef.current && chatComposerRef.current) {
      chatComposerRef.current.focus();
      focusIncomingPromptRef.current = false;
    }
  }, [open, chatDraft]);

  useEffect(() => {
    const thread = chatThreadRef.current;
    if (chatAutoScrollRef.current && thread) thread.scrollTop = thread.scrollHeight;
  }, [chatMessages, chatLoading, typingReplyId]);

  const refresh = useCallback(async (forceScan = false) => {
    setRefreshing(forceScan);
    try {
      const next = forceScan ? await scanLocalAgentRuntimes() : await listLocalAgentRuntimes();
      setRuntimes(next);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const probeProvider = useCallback(async () => {
    if (routing?.enabled) { setProviderCheck("ready"); setProviderMessage("当前使用本账号的统一底座路由；不探测当前 API 配置。实际底座与跳过原因见模型与工具。"); return; }
    if (account) { setProviderCheck(accountReady ? "ready" : "unknown"); setProviderMessage("当前使用 ChatGPT 账号通道；不探测或调用其他付费 API。"); return; }
    const isConfigured = llmConfig.provider === "ollama"
      ? Boolean(llmConfig.baseUrl?.trim())
      : Boolean(llmConfig.apiKey?.trim());
    if (!isConfigured) {
      setProviderCheck("unconfigured");
      setProviderMessage(t("尚未配置 API Key 或本地 Ollama 地址。", "Configure an API key or a local Ollama URL."));
      return;
    }
    providerAbortRef.current?.abort();
    const controller = new AbortController();
    providerAbortRef.current = controller;
    setProviderCheck("checking");
    setProviderMessage(t("正在检查模型服务…", "Checking model service…"));
    try {
      const result = await testLlmConnection(llmConfig, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setProviderCheck(result.success ? "ready" : "offline");
      setProviderMessage(result.message || (result.success ? t("服务可用。", "Service is available.") : t("服务未响应。", "Service did not respond.")));
    } catch (error) {
      if (controller.signal.aborted) return;
      setProviderCheck("offline");
      setProviderMessage(error instanceof Error ? error.message : t("无法连接模型服务。", "Could not connect to the model service."));
    }
  }, [account, accountReady, llmConfig, t, routing?.enabled]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void probeProvider();
    return () => providerAbortRef.current?.abort();
  }, [open, probeProvider]);

  useEffect(() => () => {
    chatAbortRef.current?.abort();
    providerAbortRef.current?.abort();
  }, []);

  const available = useMemo(() => runtimes.filter((runtime) => runtime.status === "available"), [runtimes]);
  const visibleRuntimes = runtimeExpanded ? runtimes : runtimes.slice(0, 5);
  const hiddenRuntimes = runtimes.slice(5);
  const statusLabel = loading
    ? t("探测本机 Agent", "Checking local agents")
    : online === false
      ? t("Agent Host 未连接", "Agent Host offline")
      : available.length > 0
        ? t(`${available.length} 个本机 Agent 可用`, `${available.length} local agent${available.length === 1 ? "" : "s"} ready`)
        : t("暂无可用本机 Agent", "No local agent ready");


  const handleSendChat = useCallback(async (customPrompt?: string) => {
    const references = customPrompt ? [] : chatReferences;
    const attachments = customPrompt ? [] : chatAttachments;
    const typedText = customPrompt ?? chatDraft;
    const textToSend = typedText.trim() ? typedText : (references.length ? t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text.") : "");
    if ((!textToSend && references.length === 0 && attachments.length === 0) || chatLoading || chatAbortRef.current || readingChatAttachments) return;

    const userMessage: ChatMessage = {
      id: `companion-user-${Date.now()}`,
      role: "user",
      content: textToSend,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...chatMessages, userMessage];
    if (account && !accountReady) { setChatError("请先完成 ChatGPT 授权并选择模型；未改用当前 API 配置。"); return; }
    if (routing?.blocked) { setChatError("本账号底座状态尚未确认；请刷新模型与工具。未使用旧 API 配置补发。"); return; }
    if (routing?.enabled && attachments.length) { setChatAttachmentError("当前原生底座适配仅支持文本；请移除图片后发送，不会悄悄丢弃图片或改用付费 API。"); return; }
    if (account && attachments.length) { setChatAttachmentError("当前账号通道仅接入文本对话，请移除图片后发送；不会回退到其他 API。"); return; }
    if (attachments.length && imageCapability === "unsupported") {
      setChatAttachmentError(modelImageCapabilityDescription(imageCapability, t));
      return;
    }
    const history = agent ? agent.reusableCompanionHistory(shareAgentMemory, shareResumeContext).map(message => chatMessages.find(item=>item.id===message.id)??({ id: message.id, role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text })) : chatMessages;
    const requestMessages = chatMessagesForRequest([...history, userMessage]);
    const controller = new AbortController();
    chatAbortRef.current = controller;
    kernelChatId.current=undefined;
    pendingChatRef.current = userMessage;
    saveRecoveryField("pending", true);
    chatAutoScrollRef.current = true;
    setChatMessages(nextMessages);
    if (!customPrompt) {
      setChatDraft("");
      setChatReferences([]);
      setChatAttachmentError("");
    }
    setChatError("");
    setChatNotice("");
    setChatLoading(true);

    try {
      const taskId = crypto.randomUUID(); agentTask.current = taskId;
      const messageIds:{input:string;reply?:string}={input:userMessage.id};
      const produce = async (signal: AbortSignal, sharedText = ""): Promise<ChatMessage> => {
        taskRuntime.assertSelected();
        const reply = await sendChat({ messages:requestMessages, llmConfig, signal, workspaceKey:`companion:${workspaceKey}`,rootScopeKey:agent?.workspaceKey??workspaceKey,
          runtime:taskRuntime.runtime,preferredRuntimeId:taskRuntime.preferredRuntimeId,
          onTask:task=>{kernelChatId.current=task.id;},
          context:sharedText||shareResumeContext?{...(sharedText?{sharedMemory:sharedText}:{}),...(shareResumeContext?{resumeSummary:createCompanionResumeSummary(resume)}:{})}:undefined });
        signal.throwIfAborted();taskRuntime.assertSelected();return reply;
      };
      const reply = agent ? await agent.run({ id: taskId, origin: "companion", label: "Agent 伴侣对话", input: [textToSend, ...references.map(reference => `引用：${reference.text}`)].join("\n"),
        destination: routing?.enabled ? agentBaseLabel(routing.policy) : account ? `ChatGPT · ${selection?.model}` : `${llmConfig.provider} · ${llmConfig.model}`, shareMemories: shareAgentMemory, resumeShared: shareResumeContext, messageIds },
        async (signal, shared) => {const result=await produce(AbortSignal.any([signal, controller.signal]), shared.text);messageIds.reply=result.id;return result;}, value => value.content)
        : await produce(controller.signal);
      if (controller.signal.aborted || chatAbortRef.current !== controller) return;
      setChatMessages((current) => [...current, reply]);
      setChatAttachments([]);
      setTypingReplyId(reply.id);
      pendingChatRef.current = null;
      saveRecoveryField("pending", false);
    } catch (error) {
      if (controller.signal.aborted || chatAbortRef.current !== controller) return;
      const message = error instanceof Error ? error.message : t("对话服务暂时不可用，请检查模型配置后重试。", "Chat is temporarily unavailable. Check model settings and try again.");
      setChatError(message);
      if (!customPrompt) {
        setChatDraft(current => current || typedText);
        setChatReferences(current => current.length ? current : references);
      }
      const errorMessage: ChatMessage = {
        id: `companion-error-${Date.now()}`,
        role: "assistant",
        content: `⚠️ ${message}`,
        createdAt: new Date().toISOString(),
      };
      setChatMessages((current) => [...current, errorMessage]);
      pendingChatRef.current = null;
      saveRecoveryField("pending", false);
    } finally {
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
        agentTask.current = undefined;
        setChatLoading(false);
      }
    }
  }, [workspaceKey, account, accountReady, agent, selection, shareAgentMemory, taskRuntime, sendChat, chatAttachments, chatDraft, chatLoading, chatMessages, chatReferences, imageCapability, llmConfig, readingChatAttachments, resume, shareResumeContext, t, routing, saveRecoveryField, setChatAttachments, setChatDraft, setChatMessages, setChatReferences]);

  const handleStopChat = useCallback(() => {
    const controller = chatAbortRef.current;
    if (!controller) return;
    chatAbortRef.current = null;
    controller.abort();
    if(kernelChatId.current)void pauseAgentChatTask(kernelChatId.current).catch(error=>setChatNotice(error instanceof Error?error.message:"停止结果尚未确认，请读取任务。"));
    if (agent && agentTask.current) void agent.stop(agentTask.current);
    const pending = pendingChatRef.current;
    pendingChatRef.current = null;
    saveRecoveryField("pending", false);
    if (pending) {
      setChatMessages((current) => current.filter((message) => message.id !== pending.id));
      setChatDraft((current) => current || pending.content);
      setChatReferences((current) => current.length ? current : pending.references ?? []);
    }
    setChatError("");
    setChatNotice(t("已停止。修改问题后可以重新发送。", "Stopped. Edit your question and send it again."));
    setChatLoading(false);
    queueMicrotask(() => chatComposerRef.current?.focus());
  }, [agent, t, saveRecoveryField, setChatDraft, setChatMessages, setChatReferences]);

  const handleAddChatImages = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setChatAttachmentError("");
    const remaining = MAX_CHAT_IMAGES - chatAttachments.length;
    if (remaining <= 0) {
      setChatAttachmentError(t("每条消息最多附加 3 张图片。", "You can attach up to 3 images to a message."));
      return;
    }
    setReadingChatAttachments(true);
    const next: ChatImageAttachment[] = [];
    let error = "";
    for (const file of files.slice(0, remaining)) {
      try {
        next.push(await readChatImage(file));
      } catch (reason) {
        error = chatImageErrorMessage(reason, t);
      }
    }
    if (files.length > remaining) error = t("每条消息最多附加 3 张图片。", "You can attach up to 3 images to a message.");
    if (next.length) setChatAttachments((current) => [...current, ...next].slice(0, MAX_CHAT_IMAGES));
    setChatAttachmentError(error);
    setReadingChatAttachments(false);
  }, [chatAttachments.length, t, setChatAttachments]);

  const openChatImagePicker = useCallback(() => {
    const input = chatImageInputRef.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return;
      }
    } catch {
      // Some browsers reject showPicker for clipped inputs; keep the click fallback.
    }
    input.click();
  }, []);

  const lastAssistantMessage = [...chatMessages].reverse().find((message) => message.role === "assistant");

  const finishReplyTyping = useCallback((messageId: string) => {
    setTypingReplyId((current) => current === messageId ? null : current);
  }, []);
  const keepChatAtBottom = useCallback(() => {
    const thread = chatThreadRef.current;
    if (chatAutoScrollRef.current && thread) thread.scrollTop = thread.scrollHeight;
  }, []);
  const handleChatScroll = useCallback(() => {
    const thread = chatThreadRef.current;
    if (thread) chatAutoScrollRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 36;
  }, []);

  const panelState = chatLoading ? "running" : "idle";
  const sharedRunning = agentSnapshot?.data.tasks.filter(task => task.status === "running").length ?? 0;

  return (
    <div className={`agent-companion ${sidebar ? "is-docked" : ""} ${open ? "is-open" : ""} agent-companion-state-${panelState}`}>
      {(sidebar || open) && (<AgentSurface name="companion">
        <section className="agent-companion-panel" role={sidebar ? undefined : "dialog"} aria-label={t("Agent 运行控制台", "Agent runtime console")}>
          <header className="agent-companion-panel-header">
            <div>
              <span className="agent-companion-eyebrow"><Activity size={12} /> {t("本地 Agent 控制台", "Local Agent console")}</span>
              <h2>{t("Agent 伴侣", "Agent Companion")}</h2>
            </div>
            <div className="agent-companion-header-actions">
              <span className={`agent-companion-live-pill is-${online === false ? "offline" : available.length ? "ready" : "idle"}`}><span />{online === false ? t("离线", "Offline") : available.length ? t("在线", "Online") : t("待命", "Idle")}</span>
              <button type="button" className="agent-companion-icon-btn" aria-label={t("关闭 Agent 伴侣", "Close Agent Companion")} onClick={() => setOpen(false)}><X size={16} /></button>
            </div>
          </header>

          <AgentContinuityButton />
          <WorkspaceRecoveryNotice {...recovery} />
          <AgentSurface name="companion-settings">{agent && <details open={sidebar ? true : undefined} className="agent-companion-shared-settings"><summary>模型与本轮上下文 · {routing?.enabled ? agentBaseLabel(routing.policy) : account ? selection?.model || "请选择 GPT" : llmConfig.model || "未配置"}{shareAgentMemory ? " · 已授权共享" : " · 未共享共识"}</summary><div className="agent-companion-shared-settings-body">
            <AgentModelControls editable config={llmConfig} disabled={chatLoading || Boolean(agentSnapshot?.data.tasks.some(task => task.status === "running"))} client={chatGptClient} />
            <AgentMemoryConsent scope="companion" checked={shareAgentMemory} onChange={value => { if (!value) handleStopChat(); setShareAgentMemory(value); }} />
          </div></details>}

          <section style={{ display: account || routing?.enabled || routing?.blocked ? "none" : undefined }} className={`agent-companion-provider is-${providerCheck}`} data-provider={providerTone(llmConfig)} aria-label={t("模型服务状态", "Model provider status")}>
            <div className="agent-provider-summary">
              <div className="agent-provider-mark">{llmConfig.provider === "gemini" ? <RuntimeIcon id="gemini-cli" /> : llmConfig.provider === "ollama" ? <RuntimeIcon id="ollama" /> : providerTone(llmConfig) === "deepseek" ? <RuntimeIcon id="deepseek-harness" /> : <Cpu size={15} aria-hidden="true" />}</div>
              <button type="button" className="agent-provider-summary-toggle" aria-expanded={providerExpanded} aria-controls="agent-provider-details" onClick={() => setProviderExpanded((current) => !current)}>
                <span className="agent-provider-summary-copy">
                  <strong title={llmConfig.model || t("未指定模型", "No model selected")}>{llmConfig.model || t("未指定模型", "No model selected")}</strong>
                  <small>{providerName(llmConfig, t)}</small>
                </span>
                <span className={`agent-provider-state is-${providerCheck}`} title={providerMessage}><span />{providerStatusLabel(providerCheck, t)}</span>
                <ChevronDown size={13} className={providerExpanded ? "is-expanded" : ""} />
              </button>
            </div>
            <div className="agent-provider-details" id="agent-provider-details" hidden={!providerExpanded}>
                <p title={providerMessage}>{providerMessage || t("模型连接检测与配置。", "Model connection and configuration controls.")}</p>
                <div>
                  <button type="button" className="agent-provider-action" aria-label={t("检测模型服务连接", "Check model provider connection")} title={providerMessage || t("检测连接", "Check connection")} onClick={() => void probeProvider()} disabled={providerCheck === "checking"}><RefreshCw size={13} className={providerCheck === "checking" ? "is-spinning" : ""} />{t("检测连接", "Check connection")}</button>
                  <button type="button" className="agent-provider-action" aria-label={t("打开模型配置", "Open model configuration")} title={t("模型配置", "Model settings")} onClick={onOpenAiConfig}><ExternalLink size={13} />{t("模型配置", "Settings")}</button>
                </div>
            </div>
          </section>

          </AgentSurface><div className="agent-companion-content">
            <AgentSurface name="tools">
            <section className="agent-companion-tools" aria-label={t("本机工具", "Local tools")}>
              <button type="button" className="agent-companion-tools-toggle" data-testid="agent-companion-tools-toggle" aria-expanded={toolsExpanded} aria-controls="agent-companion-tools-content" onClick={() => setToolsExpanded((current) => !current)}>
                <span className="agent-companion-tools-icon"><Terminal size={14} /></span>
                <span className="agent-companion-tools-copy"><strong>{t("本机工具", "Local tools")}</strong><small>{taskRuntime.label}</small></span>
                <span className="agent-companion-tools-count">{available.length} {t("可用", "ready")}</span>
                <ChevronDown size={14} className={toolsExpanded ? "is-expanded" : ""} />
              </button>
                <div className="agent-companion-tools-content" id="agent-companion-tools-content" hidden={!toolsExpanded}>
                  <div className="agent-companion-hero">
                    <div className="agent-companion-core">
                      <span className="agent-companion-core-orbit orbit-one" />
                      <span className="agent-companion-core-orbit orbit-two" />
                      <span className={`agent-companion-core-icon ${runtimeTone(taskRuntime.preferredRuntimeId ?? "agent")}`}><RuntimeIcon id={taskRuntime.preferredRuntimeId ?? "agent"} /></span>
                    </div>
                    <div className="agent-companion-hero-copy">
                      <span>{t("当前统一底座", "Selected shared runtime")}</span>
                      <strong>{taskRuntime.label}</strong>
                      <small>{t("单次任务也计入工作区总额度", "One-off tasks use the workspace budget too")}</small>
                    </div>
                    <button type="button" className="agent-companion-refresh hero-refresh" aria-label={t("重新扫描本机 Agent", "Rescan local agents")} title={t("重新扫描", "Rescan")} onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "is-spinning" : ""} /></button>
                  </div>
                  <div className={`agent-companion-health ${online === false ? "is-offline" : available.length > 0 ? "is-ready" : "is-idle"}`}>
                    <span className="agent-companion-health-dot" />
                    <span>{statusLabel}</span>
                    <small>{t("本机能力探测 · 任务沿用统一底座选择", "Local capability discovery · tasks use the shared runtime selection")}</small>
                  </div>

                  <section className="agent-companion-runtime-section" aria-label={t("本机 Agent 运行时", "Local Agent runtimes")}>
            <div className="agent-companion-section-heading"><span>{t("本机能力", "Local capabilities")}</span><small>{t("在模型与工具中选择统一底座", "Select the shared runtime in Models & tools")}</small></div>
            {loading ? (
              <div className="agent-runtime-rail" aria-busy="true">{[0, 1, 2, 3].map((item) => <span className="agent-runtime-skeleton" key={item} />)}</div>
            ) : (
              <div className="agent-runtime-rail" id="agent-runtime-extra">
                {visibleRuntimes.map((runtime) => (
                  <div
                    className={`agent-runtime-tile ${runtime.status !== "available" ? "is-unavailable" : ""}`}
                    key={runtime.id}
                    aria-label={t(`${runtime.name}，${runtimeStatusLabel(runtime, t)}`, `${runtime.name}, ${runtimeStatusLabel(runtime, t)}`)}
                    role="img"
                  >
                    <span className={`agent-runtime-tile-icon ${runtimeTone(runtime.id)}`}><RuntimeIcon id={runtime.id} /></span>
                    <span className="agent-runtime-tile-name">{runtime.name}</span>
                    <span className={`agent-runtime-tile-state status-${runtime.status}`}>{runtimeStatusLabel(runtime, t)}</span>
                    <span className={`agent-runtime-tile-dot status-${runtime.status}`} />
                  </div>
                ))}
                {hiddenRuntimes.length > 0 && (
                  <button
                    type="button"
                    className={`agent-runtime-more ${runtimeExpanded ? "is-expanded" : ""}`}
                    aria-expanded={runtimeExpanded}
                    aria-controls="agent-runtime-extra"
                    onClick={() => setRuntimeExpanded((current) => !current)}
                  >
                    <span className="agent-runtime-more-stack" aria-hidden="true">
                      {hiddenRuntimes.slice(0, 3).map((runtime, index) => (
                        <span className={`agent-runtime-more-icon ${runtimeTone(runtime.id)}`} key={runtime.id} style={{ zIndex: 3 - index }}>
                          <RuntimeIcon id={runtime.id} />
                        </span>
                      ))}
                    </span>
                    <span className="agent-runtime-more-copy">
                      <strong>{runtimeExpanded ? t("收起运行时", "Collapse") : t(`+${hiddenRuntimes.length} 个运行时`, `+${hiddenRuntimes.length} runtimes`)}</strong>
                      <small>{runtimeExpanded ? t("显示较少", "Show less") : t("更多入口", "More entries")}</small>
                    </span>
                    <ChevronRight size={14} className="agent-runtime-more-chevron" />
                  </button>
                )}
                {!runtimes.length && <div className="agent-companion-empty"><CircleAlert size={15} /><span>{t("未读取到本机 Agent。", "No local agents were returned.")}</span></div>}
              </div>
            )}
                  </section>

                  <section className={`agent-companion-advanced ${quickRunExpanded ? "is-expanded" : ""}`} aria-label={t("高级功能", "Advanced features")}>
                    <button type="button" className="agent-companion-advanced-toggle" data-testid="agent-companion-quick-run-toggle" aria-expanded={quickRunExpanded} aria-controls="agent-companion-quick-run-content" onClick={() => setQuickRunExpanded(current => !current)}>
                      <span className="agent-companion-advanced-icon"><Command size={13} /></span>
                      <span className="agent-companion-advanced-copy"><strong>{t("高级功能", "Advanced features")}</strong><small>{t("单次文本任务 · 共用底座与总额度", "One-off text task · shared runtime and budget")}</small></span>
                      <ChevronDown size={13} className={quickRunExpanded ? "is-expanded" : ""} />
                    </button>
                    <div className="agent-companion-advanced-content" id="agent-companion-quick-run-content" hidden={!quickRunExpanded}>
                      <OneOffAgentTask workspaceKey={workspaceKey} rootScopeKey={agent?.workspaceKey ?? workspaceKey} config={llmConfig} prompt={prompt} onPromptChange={setPrompt} />
                    </div>
                  </section>
                </div>
            </section>

            </AgentSurface><section className="agent-companion-chat" aria-label={t("Agent 对话", "Agent chat")}>
              <div className="agent-companion-chat-heading">
                <span><MessageSquare size={13} />{t("Agent 对话", "Agent chat")}</span>
                <div className="agent-companion-chat-heading-actions">
                  {resume && <button
                    type="button"
                    className={`agent-companion-resume-share ${shareResumeContext ? "is-enabled" : ""}`}
                    aria-label={shareResumeContext ? t("已授权 Agent 读取简历字段", "Resume fields shared with Agent") : t("允许 Agent 读取简历字段", "Allow Agent to read resume fields")}
                    aria-pressed={shareResumeContext}
                    title={t("开启后仅发送当前简历视图中的简介、技能与可见经历要点；不发送姓名、联系方式、头像或简历全文。内容会发送到当前配置的模型服务。", "When enabled, only the current resume view’s headline, skills and visible experience highlights are sent to the configured model. Name, contact details, photo and the full resume are excluded.")}
                    disabled={chatLoading}
                    onClick={() => { if (shareResumeContext) handleStopChat(); setShareResumeContext(value => !value); }}
                  >
                    <ShieldCheck size={11} />
                    <span>{shareResumeContext ? t("简历已授权", "Resume shared") : t("简历未共享", "Resume private")}</span>
                  </button>}
                  <small>{t("引用内容会随问题一并发送", "Quotes are sent with your question")}</small>
                </div>
              </div>
              <div className="agent-companion-chat-guides" aria-label={t("引导对话", "Guided conversation")}>
                {CHAT_GUIDES.map((guide) => <button
                  key={guide.id}
                  type="button"
                  data-testid={`agent-guide-${guide.id}`}
                  disabled={chatLoading}
                  onClick={() => {
                    const suggestion = t(guide.promptZh, guide.promptEn);
                    setChatDraft((current) => current.trim() ? `${current.trim()}\n\n${suggestion}` : suggestion);
                    chatComposerRef.current?.focus();
                  }}
                >{t(guide.zh, guide.en)}</button>)}
              </div>
              <div className="agent-companion-chat-thread" ref={chatThreadRef} onScroll={handleChatScroll} data-testid="agent-companion-chat-thread" tabIndex={0} aria-label={t("对话记录", "Conversation history")}>
                {chatMessages.map((message) => (
                  <article key={message.id} className={`agent-companion-chat-message ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                    {message.role === "user" ? (
                      <>
                        {message.content && <p className="agent-companion-chat-user-text">{message.content}</p>}
                        {message.attachments?.length ? <div className="agent-companion-chat-sent-images">{message.attachments.map((attachment, index) => <img key={`${message.id}-image-${index}`} src={attachment.dataUrl} alt={t(`已发送图片：${attachment.name}`, `Sent image: ${attachment.name}`)} />)}</div> : null}
                        {message.references?.map((reference, index) => (
                          <div key={`${message.id}-ref-${index}`} className="agent-companion-chat-quote">
                            <span><FileText size={11} />{reference.sourceLabel}</span>
                            <blockquote>{reference.text}</blockquote>
                          </div>
                        ))}
                      </>
                    ) : (
                      <>
                        <div className="agent-companion-chat-assistant-label"><Bot size={12} />{t("Agent 伴侣", "Agent Companion")}</div>
                        {message.meta && <AgentReplyMeta meta={message.meta} compact isDark={theme === "dark"} />}
                        {message.id === typingReplyId
                          ? <AgentCompanionReply content={message.content} animate isDark={theme === "dark"} skipLabel={t("显示完整回复", "Show full reply")} messageId={message.id} onComplete={finishReplyTyping} onProgress={keepChatAtBottom} />
                          : <AgentMarkdownRenderer content={message.content} isDark={theme === "dark"} />}
                      </>
                    )}
                  </article>
                ))}
                {!chatMessages.length && !chatLoading && (
                  <div className="agent-companion-chat-empty"><Sparkles size={17} /><p>{t("开始一段对话", "Start a conversation")}</p><small>{chatReferences.length ? t("已附上简历引用，写下你想了解的问题。", "Resume quote attached. Ask what you would like to know.") : t("可以提问，也可以从简历中引用内容后继续讨论。", "Ask a question, or reference resume content for context.")}</small></div>
                )}
              </div>
              {chatLoading && <div className="agent-companion-chat-loading" role="status" aria-live="polite"><span className="agent-companion-thinking-dots" aria-hidden="true"><i /><i /><i /></span><span>{t("正在生成回复…", "Generating a reply…")}</span></div>}
              {chatReferences.map((reference, index) => (
                <div key={`${reference.sourceLabel}-${index}`} className="agent-companion-chat-pending-reference">
                  <FileText size={12} />
                  <span><strong>{reference.sourceLabel}</strong><small>{reference.text}</small></span>
                  <button type="button" aria-label={t("移除引用", "Remove quote")} onClick={() => setChatReferences((previous) => previous.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button>
                </div>
              ))}
              {chatAttachments.length > 0 && (
                <div className="agent-companion-chat-image-attachments" aria-label={t("待发送图片", "Images to send")}>
                  {chatAttachments.map((attachment, index) => (
                    <div className="agent-companion-chat-image-card" key={`${attachment.name}-${index}`}>
                      <img src={attachment.dataUrl} alt={t(`待发送图片：${attachment.name}`, `Image to send: ${attachment.name}`)} />
                      <span title={attachment.name}>{attachment.name}</span>
                      <button type="button" aria-label={t(`移除图片 ${attachment.name}`, `Remove image ${attachment.name}`)} onClick={() => setChatAttachments((previous) => previous.filter((_, itemIndex) => itemIndex !== index))} disabled={chatLoading || readingChatAttachments}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              {chatAttachmentError && <p className="agent-companion-chat-attachment-error" role="alert">{chatAttachmentError}</p>}
              {chatAttachments.length > 0 && <div className={`agent-companion-chat-image-capability is-${imageCapability}`} role="status">
                <strong>{modelImageCapabilityLabel(imageCapability, t)}</strong><span>{modelImageCapabilityDescription(imageCapability, t)}</span>
                {imageCapability === "unsupported" && <button type="button" onClick={onOpenAiConfig}>{t("更换模型", "Change model")}</button>}
              </div>}
              <small className="agent-companion-chat-privacy-note">{t("图片会作为完整对话历史随本轮及后续问题发送给当前模型，不会写入简历。", "Images remain in the complete conversation history sent to the current model for this and subsequent questions. They are not saved to the resume.")}</small>
              <div className="agent-companion-chat-compose">
                <input
                  ref={chatImageInputRef}
                  className="agent-companion-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  aria-label={t("选择对话图片", "Choose chat images")}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    const files = Array.from(input.files ?? []);
                    input.value = "";
                    void handleAddChatImages(files);
                  }}
                />
                <button
                  type="button"
                  className="agent-companion-chat-attach"
                  aria-label={t("添加图片", "Add image")}
                  title={t("添加原始 PNG、JPEG 或 WebP（最多 3 张，单张不超过 2 MB，不压缩）", "Add original PNG, JPEG or WebP (up to 3, at most 2 MB each, no compression)")}
                  onClick={openChatImagePicker}
                  disabled={chatLoading || readingChatAttachments || chatAttachments.length >= MAX_CHAT_IMAGES}
                >
                  {readingChatAttachments ? <Loader2 size={14} className="is-spinning" /> : <ImagePlus size={14} />}
                </button>
                <textarea
                  ref={chatComposerRef}
                  aria-label={t("发送给 Agent", "Message Agent")}
                  rows={2}
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onPaste={(event) => {
                    const clipboard = event.clipboardData;
                    const imageFiles = Array.from(clipboard.items)
                      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                      .map((item) => item.getAsFile())
                      .filter((file): file is File => file !== null);
                    const files = imageFiles.length
                      ? imageFiles
                      : Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
                    if (!files.length) return;
                    event.preventDefault();
                    void handleAddChatImages(files);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSendChat();
                    }
                  }}
                  placeholder={t("向 Agent 提问…（Enter 发送，Shift + Enter 换行）", "Ask the Agent… (Enter to send, Shift + Enter for a new line)")}
                  disabled={chatLoading || readingChatAttachments}
                />
                {chatLoading
                  ? <button type="button" className="agent-companion-stop-chat" aria-label={t("停止生成并编辑问题", "Stop generating and edit question")} title={t("停止并修改", "Stop and edit")} onClick={handleStopChat}><Square size={14} /></button>
                  : <button type="button" aria-label={t("发送消息", "Send message")} onClick={() => void handleSendChat()} disabled={readingChatAttachments || (chatAttachments.length > 0 && imageCapability === "unsupported") || (!chatDraft.trim() && chatReferences.length === 0 && chatAttachments.length === 0)}><Send size={14} /></button>}
              </div>
              <div className="agent-companion-chat-footer">
                {chatNotice && <p className="agent-companion-chat-notice" role="status">{chatNotice}</p>}
                {chatError && <p className="agent-companion-chat-error" role="alert">{chatError}</p>}
                {lastAssistantMessage?.meta?.status === "truncated" && (
                  <button type="button" className="agent-companion-chat-continue" onClick={() => void handleSendChat(t("请从上一条回复的结束位置继续，不要重复内容，并补完未回答的部分。", "Continue from the end of the previous reply without repeating completed content."))} disabled={chatLoading}>
                    {chatLoading ? <Loader2 size={12} className="is-spinning" /> : <RefreshCw size={12} />}{t("继续补完", "Continue reply")}
                  </button>
                )}
              </div>
            </section>
          </div>

          <button type="button" className="agent-companion-open-btn" onClick={() => { setOpen(false); onOpenWorkspace(); }}><Bot size={15} /><span>{t("打开完整 Agent 工作台", "Open full Agent Workbench")}</span><ChevronRight size={14} /></button>
        </section></AgentSurface>
      )}
      {!sidebar && <button type="button" className="agent-companion-trigger" aria-expanded={open} aria-label={t("打开 Agent 伴侣", "Open Agent Companion")} aria-describedby={sharedRunning ? "betterme-agent-running-count" : undefined} title={sharedRunning ? `BetterMe Agent · ${sharedRunning} 项运行中` : statusLabel} onClick={() => setOpen(!open)}>
        <span className="agent-companion-orbit" />
        <Bot size={22} />
        <span className={`agent-companion-status-dot ${online === false ? "is-offline" : available.length > 0 ? "is-ready" : "is-idle"}`} />
        {sharedRunning > 0 && <span id="betterme-agent-running-count" className="betterme-agent-running-count" aria-label={`${sharedRunning} 项 Agent 任务运行中`}>{sharedRunning}</span>}
      </button>}
    </div>
  );
}
