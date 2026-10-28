/** @jsxRuntime automatic */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LlmConfig, ProjectedResume } from "@better-me/core";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Command,
  Copy,
  Cpu,
  ChevronDown,
  ExternalLink,
  FileText,
  ImagePlus,
  Loader2,
  MessageSquare,
  Play,
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
import { createCompanionResumeSummary } from "../lib/resume-agent-context";
import {
  cancelLocalAgentRun,
  getLocalAgentRun,
  listLocalAgentRuntimes,
  scanLocalAgentRuntimes,
  startLocalAgentRun,
  streamLocalAgentRun,
  sendAgentChat,
  chatMessagesForRequest,
  type ChatMessage,
  type LocalAgentEvent,
  type LocalAgentRun,
  type LocalRuntimeInfo,
  type ResumeTextReference,
} from "../services/agent-client";
import { getModelImageCapability, modelImageCapabilityDescription, modelImageCapabilityLabel } from "../lib/model-image-capability";
import { AgentBrandIcon as RuntimeIcon } from "./AgentBrandIcon";
import { AgentMarkdownRenderer } from "./AgentMarkdownRenderer";
import { AgentReplyMeta } from "./AgentReplyMeta";
import "./agent-companion.css";

export interface AgentCompanionProps {
  onOpenWorkspace: () => void;
  llmConfig: LlmConfig;
  onOpenAiConfig: () => void;
  resume?: ProjectedResume | null;
  initialReference?: ResumeTextReference | null;
  onReferenceConsumed?: () => void;
}

type ProviderCheck = "unknown" | "checking" | "ready" | "offline" | "unconfigured";

type ChatImageAttachment = NonNullable<ChatMessage["attachments"]>[number];

const CHAT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_CHAT_IMAGE_BYTES = 2_000_000;
const MAX_CHAT_IMAGES = 3;

function readChatImage(file: File): Promise<ChatImageAttachment> {
  if (!CHAT_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
    return Promise.reject(new Error("unsupported_type"));
  }
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) {
    return Promise.reject(new Error("image_too_large"));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("image_read_failed"));
    reader.onabort = () => reject(new Error("image_read_failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || reader.result.length > 8_000_000) {
        reject(new Error("image_too_large"));
        return;
      }
      resolve({
        name: file.name.trim().slice(0, 160) || "image",
        mimeType: file.type.toLowerCase(),
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function chatImageErrorMessage(error: unknown, t: (zh: string, en: string) => string): string {
  const code = error instanceof Error ? error.message : "image_read_failed";
  if (code === "unsupported_type") return t("图片格式仅支持 PNG、JPEG 或 WebP。", "Only PNG, JPEG or WebP images are supported.");
  if (code === "image_too_large") return t("单张图片需小于 2 MB。", "Each image must be smaller than 2 MB.");
  return t("图片读取失败，请重新选择。", "Could not read the image. Please choose it again.");
}


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

function eventLabel(type: string, t: (zh: string, en: string) => string): string {
  if (type === "text.delta") return t("输出", "Output");
  if (type === "tool.called") return t("工具", "Tool");
  if (type === "agent.thinking") return t("思考", "Thinking");
  if (type === "run.completed") return t("完成", "Completed");
  if (type === "run.failed") return t("失败", "Failed");
  if (type === "run.cancelled") return t("已取消", "Cancelled");
  return type.replaceAll(".", " ");
}

function eventDetail(event: LocalAgentEvent, t: (zh: string, en: string) => string): string {
  if (typeof event.payload.text === "string") return event.payload.text;
  if (typeof event.payload.name === "string") return event.payload.name;
  if (typeof event.payload.error === "string") return event.payload.error;
  if (event.type === "run.completed") return t("运行结果已写入本次 Run 输出目录。", "The result was written to this Run output directory.");
  return t("收到结构化事件。", "Structured event received.");
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

export function AgentCompanion({ onOpenWorkspace, llmConfig, onOpenAiConfig, resume, initialReference, onReferenceConsumed }: AgentCompanionProps) {
  const { t, theme } = useUiPreferences();
  const [open, setOpen] = useState(false);
  const [runtimes, setRuntimes] = useState<LocalRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [quickRunExpanded, setQuickRunExpanded] = useState(false);
  const [providerExpanded, setProviderExpanded] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<LocalAgentRun | null>(null);
  const [events, setEvents] = useState<LocalAgentEvent[]>([]);
  // Keep the user-facing answer separate from the structured event timeline.
  // A single Run can emit dozens of text.delta chunks; rendering those chunks
  // as timeline rows both truncates the answer and makes the log hard to scan.
  const [runOutput, setRunOutput] = useState("");
  const [runOutputWarning, setRunOutputWarning] = useState("");
  const [outputCopied, setOutputCopied] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [providerCheck, setProviderCheck] = useState<ProviderCheck>("unknown");
  const [providerMessage, setProviderMessage] = useState("");
  const imageCapability = getModelImageCapability(llmConfig);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatReferences, setChatReferences] = useState<ResumeTextReference[]>([]);
  const [chatAttachments, setChatAttachments] = useState<ChatImageAttachment[]>([]);
  const [chatAttachmentError, setChatAttachmentError] = useState("");
  const [readingChatAttachments, setReadingChatAttachments] = useState(false);
  const [shareResumeContext, setShareResumeContext] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [typingReplyId, setTypingReplyId] = useState<string | null>(null);
  const [chatError, setChatError] = useState("");
  const streamAbortRef = useRef<AbortController | null>(null);
  const providerAbortRef = useRef<AbortController | null>(null);
  const textDeltaSequencesRef = useRef<Set<number>>(new Set());
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const chatAutoScrollRef = useRef(true);
  const chatComposerRef = useRef<HTMLTextAreaElement>(null);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const onReferenceConsumedRef = useRef(onReferenceConsumed);

  useEffect(() => { onReferenceConsumedRef.current = onReferenceConsumed; }, [onReferenceConsumed]);
  useEffect(() => {
    if (!initialReference) return;
    setOpen(true);
    setToolsExpanded(false);
    setChatReferences((previous) => previous.some((reference) => reference.text === initialReference.text && reference.sourceLabel === initialReference.sourceLabel)
      ? previous
      : [...previous, initialReference].slice(-5));
    setChatDraft((current) => current || t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text."));
    onReferenceConsumedRef.current?.();
  }, [initialReference, t]);

  useEffect(() => {
    if (open && chatReferences.length) chatComposerRef.current?.focus();
  }, [open, chatReferences.length]);

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
      setSelectedRuntimeId((current) => current && next.some((item) => item.id === current && item.status === "available")
        ? current
        : next.find((item) => item.status === "available")?.id ?? "");
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const probeProvider = useCallback(async () => {
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
  }, [llmConfig, t]);

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
    streamAbortRef.current?.abort();
    providerAbortRef.current?.abort();
  }, []);

  const runIsActive = run?.status === "running" || run?.status === "queued";
  const available = useMemo(() => runtimes.filter((runtime) => runtime.status === "available"), [runtimes]);
  const selectedRuntime = useMemo(() => runtimes.find((runtime) => runtime.id === selectedRuntimeId), [runtimes, selectedRuntimeId]);
  const visibleRuntimes = runtimeExpanded ? runtimes : runtimes.slice(0, 5);
  const hiddenRuntimes = runtimes.slice(5);
  const statusLabel = loading
    ? t("探测本机 Agent", "Checking local agents")
    : online === false
      ? t("Agent Host 未连接", "Agent Host offline")
      : available.length > 0
        ? t(`${available.length} 个本机 Agent 可用`, `${available.length} local agent${available.length === 1 ? "" : "s"} ready`)
        : t("暂无可用本机 Agent", "No local agent ready");

  const handleStartRun = useCallback(async () => {
    const cleanPrompt = prompt.trim();
    if (!selectedRuntimeId || !cleanPrompt || runIsActive) return;
    setToolsExpanded(true);
    setQuickRunExpanded(true);
    setRunError(null);
    setEvents([]);
    setRunOutput("");
    setRunOutputWarning("");
    setOutputCopied(false);
    textDeltaSequencesRef.current = new Set();
    let terminalEventSeen = false;
    let startedRunId = "";
    try {
      const started = await startLocalAgentRun({
        runtimeId: selectedRuntimeId,
        workflow: "companion-run",
        prompt: cleanPrompt,
        contextPack: {
          role: "companion-user",
          task: cleanPrompt,
          artifactRefs: [],
          toolAllowlist: [],
          redactedFields: [],
          content: {},
          characterBudget: 8_000,
        },
      });
      startedRunId = started.run.id;
      setRun(started.run);
      const controller = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = controller;
      await streamLocalAgentRun({
        runId: started.run.id,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type !== "text.delta") {
            setEvents((current) => current.some((item) => item.sequence === event.sequence)
              ? current
              : [...current, event].slice(-80));
          }
          if (event.type === "text.delta" && typeof event.payload.text === "string") {
            const sequence = Number(event.sequence);
            const text = event.payload.text;
            const isReplacement = event.payload.replace === true;
            if (!textDeltaSequencesRef.current.has(sequence)) {
              textDeltaSequencesRef.current.add(sequence);
              setRunOutput((current) => isReplacement
                ? text.slice(0, 80_000)
                : current.length >= 80_000
                  ? current
                  : `${current}${text}`.slice(0, 80_000));
            }
          }
          if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
            terminalEventSeen = true;
            setRun((current) => current ? { ...current, status: event.type === "run.completed" ? "completed" : event.type === "run.cancelled" ? "cancelled" : "failed", finishedAt: event.timestamp, error: typeof event.payload.error === "string" ? event.payload.error : current.error } : current);
            controller.abort();
          }
        },
      });
    } catch (error) {
      // A terminal SSE event intentionally aborts the connection. Continue to
      // fetch the persisted Run status/output instead of treating that abort as
      // a user cancellation.
      if (!terminalEventSeen) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRunError(error instanceof Error ? error.message : "agent_run_failed");
        return;
      }
    }
    if (!startedRunId) return;
    try {
      const latest = await getLocalAgentRun(startedRunId).catch(() => undefined);
      if (latest) {
        setRun(latest.run);
        // The status endpoint is authoritative: it replaces any partial or
        // duplicated live chunks with the persisted complete answer.
        if (typeof latest.output === "string") setRunOutput(latest.output);
        if (!latest.output?.trim() && latest.rawOutput?.trim()) {
          setRunOutputWarning(t("运行时输出未解析出最终答复；原始诊断日志已保留在本地 Run 目录，未混入答案。", "The runtime output did not contain a parsed final answer. Raw diagnostics remain in the local Run directory and are not mixed into the answer."));
        }
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "agent_run_failed");
    }
  }, [prompt, runIsActive, selectedRuntimeId, t]);

  const handleCopyOutput = useCallback(async () => {
    if (!runOutput) return;
    try {
      await navigator.clipboard.writeText(runOutput);
      setOutputCopied(true);
      window.setTimeout(() => setOutputCopied(false), 1_600);
    } catch {
      setOutputCopied(false);
    }
  }, [runOutput]);

  const handleCancelRun = useCallback(async () => {
    if (!run || !runIsActive) return;
    try {
      await cancelLocalAgentRun(run.id);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "agent_cancel_failed");
    } finally {
      streamAbortRef.current?.abort();
      setRun((current) => current ? { ...current, status: "cancelled" } : current);
    }
  }, [run, runIsActive]);

  const handleSendChat = useCallback(async (customPrompt?: string) => {
    const references = customPrompt ? [] : chatReferences;
    const attachments = customPrompt ? [] : chatAttachments;
    const typedText = customPrompt ?? chatDraft;
    const textToSend = typedText.trim() || (references.length ? t("请结合引用的简历内容帮我分析。", "Please analyze the quoted resume text.") : "");
    if ((!textToSend && references.length === 0 && attachments.length === 0) || chatLoading || readingChatAttachments) return;

    const userMessage: ChatMessage = {
      id: `companion-user-${Date.now()}`,
      role: "user",
      content: textToSend,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...chatMessages, userMessage];
    if (attachments.length && imageCapability === "unsupported") {
      setChatAttachmentError(modelImageCapabilityDescription(imageCapability, t));
      return;
    }
    const requestMessages = chatMessagesForRequest(nextMessages);
    chatAutoScrollRef.current = true;
    setChatMessages(nextMessages.slice(-24));
    if (!customPrompt) {
      setChatDraft("");
      setChatReferences([]);
      setChatAttachmentError("");
    }
    setChatError("");
    setChatLoading(true);

    try {
      const reply = await sendAgentChat({
        messages: requestMessages,
        llmConfig,
        context: shareResumeContext ? {
          resumeSummary: createCompanionResumeSummary(resume),
        } : undefined,
      });
      setChatMessages((current) => [...current, reply].slice(-24));
      setChatAttachments([]);
      setTypingReplyId(reply.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("对话服务暂时不可用，请检查模型配置后重试。", "Chat is temporarily unavailable. Check model settings and try again.");
      setChatError(message);
      const errorMessage: ChatMessage = {
        id: `companion-error-${Date.now()}`,
        role: "assistant",
        content: `⚠️ ${message}`,
        createdAt: new Date().toISOString(),
      };
      setChatMessages((current) => [...current, errorMessage].slice(-24));
    } finally {
      setChatLoading(false);
    }
  }, [chatAttachments, chatDraft, chatLoading, chatMessages, chatReferences, imageCapability, llmConfig, readingChatAttachments, resume, shareResumeContext, t]);

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
  }, [chatAttachments.length, t]);

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

  const panelState = runIsActive ? "running" : run?.status ?? "idle";

  return (
    <div className={`agent-companion ${open ? "is-open" : ""} agent-companion-state-${panelState}`}>
      {open && (
        <section className="agent-companion-panel" role="dialog" aria-label={t("Agent 运行控制台", "Agent runtime console")}>
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

          <section className={`agent-companion-provider is-${providerCheck}`} data-provider={providerTone(llmConfig)} aria-label={t("模型服务状态", "Model provider status")}>
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

          <div className="agent-companion-content">
            <section className="agent-companion-tools" aria-label={t("本机工具", "Local tools")}>
              <button type="button" className="agent-companion-tools-toggle" data-testid="agent-companion-tools-toggle" aria-expanded={toolsExpanded} aria-controls="agent-companion-tools-content" onClick={() => setToolsExpanded((current) => !current)}>
                <span className="agent-companion-tools-icon"><Terminal size={14} /></span>
                <span className="agent-companion-tools-copy"><strong>{t("本机工具", "Local tools")}</strong><small>{selectedRuntime?.name ?? statusLabel}</small></span>
                <span className="agent-companion-tools-count">{available.length} {t("可用", "ready")}</span>
                <ChevronDown size={14} className={toolsExpanded ? "is-expanded" : ""} />
              </button>
                <div className="agent-companion-tools-content" id="agent-companion-tools-content" hidden={!toolsExpanded}>
                  <div className="agent-companion-hero">
                    <div className={`agent-companion-core ${runIsActive ? "is-running" : ""}`}>
                      <span className="agent-companion-core-orbit orbit-one" />
                      <span className="agent-companion-core-orbit orbit-two" />
                      <span className={`agent-companion-core-icon ${runtimeTone(selectedRuntimeId)}`}><RuntimeIcon id={selectedRuntimeId || "ollama"} /></span>
                      {runIsActive && <span className="agent-companion-core-signal" />}
                    </div>
                    <div className="agent-companion-hero-copy">
                      <span>{runIsActive ? t("正在执行 CLI 单次任务", "Running one-off CLI task") : t("当前执行入口", "Current execution target")}</span>
                      <strong>{selectedRuntime?.name ?? t("选择一个本机 Agent", "Choose a local Agent")}</strong>
                      <small>{selectedRuntime?.version ?? selectedRuntime?.resolvedCommand ?? t("从下方轨道选择可用运行时", "Choose an available runtime below")}</small>
                    </div>
                    <button type="button" className="agent-companion-refresh hero-refresh" aria-label={t("重新扫描本机 Agent", "Rescan local agents")} title={t("重新扫描", "Rescan")} onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "is-spinning" : ""} /></button>
                  </div>
                  <div className={`agent-companion-health ${online === false ? "is-offline" : available.length > 0 ? "is-ready" : "is-idle"}`}>
                    <span className="agent-companion-health-dot" />
                    <span>{statusLabel}</span>
                    <small>{t("本机 CLI · 每次任务使用独立目录", "Local CLI · separate directory per run")}</small>
                  </div>

                  <section className="agent-companion-runtime-section" aria-label={t("本机 Agent 运行时", "Local Agent runtimes")}>
            <div className="agent-companion-section-heading"><span>{t("运行时轨道", "Runtime rail")}</span><small>{t("点击图标切换入口", "Select an entry")}</small></div>
            {loading ? (
              <div className="agent-runtime-rail" aria-busy="true">{[0, 1, 2, 3].map((item) => <span className="agent-runtime-skeleton" key={item} />)}</div>
            ) : (
              <div className="agent-runtime-rail" id="agent-runtime-extra">
                {visibleRuntimes.map((runtime) => (
                  <button
                    type="button"
                    className={`agent-runtime-tile ${selectedRuntimeId === runtime.id ? "is-selected" : ""} ${runtime.status !== "available" ? "is-unavailable" : ""}`}
                    key={runtime.id}
                    disabled={runtime.status !== "available" || Boolean(runIsActive)}
                    aria-label={t(`${runtime.name}，${runtimeStatusLabel(runtime, t)}`, `${runtime.name}, ${runtimeStatusLabel(runtime, t)}`)}
                    aria-pressed={selectedRuntimeId === runtime.id}
                    title={runtime.status === "available" ? t(`使用 ${runtime.name}`, `Use ${runtime.name}`) : t(`${runtime.name} · ${runtimeStatusLabel(runtime, t)}`, `${runtime.name} · ${runtimeStatusLabel(runtime, t)}`)}
                    onClick={() => setSelectedRuntimeId(runtime.id)}
                  >
                    <span className={`agent-runtime-tile-icon ${runtimeTone(runtime.id)}`}><RuntimeIcon id={runtime.id} /></span>
                    <span className="agent-runtime-tile-name">{runtime.name}</span>
                    <span className={`agent-runtime-tile-state status-${runtime.status}`}>{runtimeStatusLabel(runtime, t)}</span>
                    <span className={`agent-runtime-tile-dot status-${runtime.status}`} />
                  </button>
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

                  {available.length > 0 && (
                    <section className={`agent-companion-advanced ${quickRunExpanded ? "is-expanded" : ""}`} aria-label={t("高级功能", "Advanced features")}>
                      <button
                        type="button"
                        className="agent-companion-advanced-toggle"
                        data-testid="agent-companion-quick-run-toggle"
                        aria-expanded={quickRunExpanded}
                        aria-controls="agent-companion-quick-run-content"
                        onClick={() => setQuickRunExpanded((current) => !current)}
                      >
                        <span className="agent-companion-advanced-icon"><Command size={13} /></span>
                        <span className="agent-companion-advanced-copy"><strong>{t("高级功能", "Advanced features")}</strong><small>{t("本机 CLI 单次运行", "One-off local CLI run")}</small></span>
                        {run && <span className={`agent-companion-advanced-status is-${run.status}`}>{run.status === "completed" ? t("已完成", "Complete") : run.status === "failed" ? t("失败", "Failed") : run.status === "cancelled" ? t("已取消", "Cancelled") : run.status === "running" || run.status === "queued" ? t("运行中", "Running") : t("CLI", "CLI")}</span>}
                        <ChevronDown size={13} className={quickRunExpanded ? "is-expanded" : ""} />
                      </button>
                      <div className="agent-companion-advanced-content" id="agent-companion-quick-run-content" hidden={!quickRunExpanded}>
                        <section className="agent-companion-run" aria-label={t("运行本机 Agent", "Run a local agent")}>
              <div className="agent-companion-run-heading"><div><span>{t("本机 CLI 单次运行", "One-off local CLI run")}</span><small>{t("单次 CLI；不会自动带入本对话/简历上下文，也不会自动写入简历或地图。默认不保证 OS 沙箱，实际运行级别见下方状态。", "One-off CLI; chat/resume context is not attached, and nothing is automatically written to your resume or map. OS sandboxing is not guaranteed; the actual level appears below.")}</small></div></div>
              <label className="agent-companion-field"><span>{t("任务提示", "Task prompt")}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("先粘贴岗位描述或其他文本，再写明任务", "Paste the job description or other text, then describe the task")} rows={3} disabled={Boolean(runIsActive)} /></label>
              <div className="agent-companion-run-actions">
                <button type="button" className="agent-companion-run-button" onClick={() => void handleStartRun()} disabled={!selectedRuntimeId || !prompt.trim() || Boolean(runIsActive)}><Play size={13} />{t("开始运行", "Run now")}</button>
                {runIsActive && <button type="button" className="agent-companion-cancel" onClick={() => void handleCancelRun()} aria-label={t("取消当前运行", "Cancel current run")} title={t("取消", "Cancel")}><Square size={13} /></button>}
              </div>
              {run && <div className={`agent-companion-run-status is-${run.status}`}><span>{run.status === "running" || run.status === "queued" ? <Loader2 size={12} className="is-spinning" /> : <Activity size={12} />}</span><span>{run.status === "running" ? t("运行中", "Running") : run.status === "queued" ? t("排队中", "Queued") : run.status === "completed" ? t("已完成", "Completed") : run.status === "failed" ? t("失败", "Failed") : run.status === "cancelled" ? t("已取消", "Cancelled") : run.status}</span><small>{run.isolation === "os-sandbox" ? t("OS 沙箱", "OS sandbox") : run.isolation === "process" ? t("进程运行 · 无 OS 沙箱", "Process run · no OS sandbox") : t("未启用沙箱", "No sandbox")}</small></div>}
              {runError && <div className="agent-companion-run-error"><CircleAlert size={13} />{runError}</div>}
                        </section>

                  {run && (
                    <section className="agent-companion-output" aria-live="polite" aria-label={t("本次运行结果", "Run output")}>
              <div className="agent-companion-section-heading">
                <span>{t("运行结果", "Run output")}</span>
                <button type="button" className="agent-output-copy" onClick={() => void handleCopyOutput()} disabled={!runOutput} aria-label={t("复制完整运行结果", "Copy complete run output")} title={t("复制完整结果", "Copy complete output")}>
                  {outputCopied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{outputCopied ? t("已复制", "Copied") : t("复制", "Copy")}</span>
                </button>
              </div>
              {runOutput
                ? <div className="agent-output-text"><AgentMarkdownRenderer content={runOutput} isDark={false} /></div>
                : <div className="agent-output-empty"><p>{runIsActive ? t("等待 Agent 返回结果…", "Waiting for the Agent response…") : t("本次运行没有返回可展示的文本结果。", "This run returned no displayable text output.")}</p>{runOutputWarning && <p className="agent-output-warning" role="status">{runOutputWarning}</p>}</div>}
                    </section>
                  )}

                  {events.some((event) => event.type !== "text.delta") && (
                    <section className="agent-companion-timeline" aria-live="polite" aria-label={t("当前运行时间线", "Current Run timeline")}>
              <div className="agent-companion-section-heading"><span>{t("运行时间线", "Run timeline")}</span><small>{events.filter((event) => event.type !== "text.delta").length} {t("条事件", "events")}</small></div>
              <div className="agent-timeline-list">
                {events.slice(-8).map((event) => (
                  <div key={event.id} className={`agent-timeline-item event-${event.type.replaceAll(".", "-")}`}>
                    <span className="agent-timeline-dot" />
                    <div><strong>{eventLabel(event.type, t)}</strong><span>{eventDetail(event, t)}</span></div>
                    <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                ))}
              </div>
                    </section>
                  )}
                      </div>
                    </section>
                  )}
                </div>
            </section>

            <section className="agent-companion-chat" aria-label={t("Agent 对话", "Agent chat")}>
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
                    onClick={() => setShareResumeContext((value) => !value)}
                  >
                    <ShieldCheck size={11} />
                    <span>{shareResumeContext ? t("简历已授权", "Resume shared") : t("简历未共享", "Resume private")}</span>
                  </button>}
                  <small>{t("引用内容会随问题一并发送", "Quotes are sent with your question")}</small>
                </div>
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
              <small className="agent-companion-chat-privacy-note">{t("图片只随本条消息发送给当前模型，不会附加到后续问题或保存进简历。", "Images are sent with this message only, not future questions, and are not saved to the resume.")}</small>
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
                  title={t("添加 PNG、JPEG 或 WebP（最多 3 张，每张小于 2 MB）", "Add PNG, JPEG or WebP (up to 3 images, under 2 MB each)")}
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
                <button type="button" aria-label={t("发送消息", "Send message")} onClick={() => void handleSendChat()} disabled={chatLoading || readingChatAttachments || (chatAttachments.length > 0 && imageCapability === "unsupported") || (!chatDraft.trim() && chatReferences.length === 0 && chatAttachments.length === 0)}>
                  {chatLoading ? <Loader2 size={14} className="is-spinning" /> : <Send size={14} />}
                </button>
              </div>
              <div className="agent-companion-chat-footer">
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
        </section>
      )}
      <button type="button" className="agent-companion-trigger" aria-expanded={open} aria-label={t("打开 Agent 伴侣", "Open Agent Companion")} title={statusLabel} onClick={() => setOpen((current) => !current)}>
        <span className="agent-companion-orbit" />
        <Bot size={22} />
        <span className={`agent-companion-status-dot ${online === false ? "is-offline" : available.length > 0 ? "is-ready" : "is-idle"}`} />
      </button>
    </div>
  );
}
