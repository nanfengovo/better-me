import { fetchChatCompletion, fetchChatCompletionResult, isOfficialDeepSeek, type LlmConfig, type ChatMessageContent } from "@better-me/core";
import { readRuntimeConnection } from "../lib/runtime-connection";
import type { ResumeEditContext, ResumeProposalTarget } from "@better-me/agent-contracts";
import { findResumeContextSource } from "../lib/resume-agent-context";

export interface MatchProposal {
  id: string;
  jdItem: string;
  evidenceType: "verified" | "claimed" | "gap";
  profileEntryId?: string;
  suggestion: string;
  rationale: string;
}

export type ProposalDecision =
  | { status: "accepted" }
  | { status: "rejected"; reason?: string }
  | { status: "edited"; editedSuggestion: string };

export interface StructuredJd {
  title: string;
  company: string;
  location: string;
  requirements: string[];
  responsibilities?: string[];
  qualifications?: string[];
  preferences: string[];
  compensationRaw: string | null;
  techStack: string[];
}

export interface AgentActionCard {
  type: "company_card" | "resume_proposal" | "job_match" | "interview_defense";
  companyName?: string;
  ownership?: string;
  jurisdiction?: string;
  summary?: string;
  verified?: boolean;
  officialUrl?: string;
  targetSection?: string;
  originalText?: string;
  proposedText?: string;
  rationale?: string;
  targetRef?: ResumeProposalTarget;
  /** Set only by bindResumeProposalSources after matching an explicitly shared field. */
  sourceVerified?: boolean;
  sourceIssue?: "missing_target" | "not_shared" | "original_mismatch";
  jobId?: string;
  title?: string;
  company?: string;
  salary?: string;
  location?: string;
  highlight?: string;
  gapItem?: string;
  strategy?: string;
  sampleAnswer?: string;
}

export type AgentResponseSource = "agent-host" | "browser-direct";
export type AgentResponseStatus = "ready" | "fallback" | "error" | "truncated";

/** Safe, non-secret provenance shown beside every assistant response. */
export interface AgentMessageMeta {
  provider: LlmConfig["provider"];
  providerLabel: string;
  model: string;
  source: AgentResponseSource;
  status: AgentResponseStatus;
  completeness?: "complete" | "truncated" | "empty";
  observedAt: string;
  finishReason?: string;
  warning?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Array<{ name: string; mimeType: string; dataUrl: string }>;
  references?: ResumeTextReference[];
  actions?: AgentActionCard[];
  createdAt?: string;
  meta?: AgentMessageMeta;
}

/** Keep image data on the turn where the user attached it; never resend old image bytes. */
export function chatMessagesForRequest(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => index === messages.length - 1 || !message.attachments?.length
    ? message
    : { ...message, attachments: undefined });
}

export interface ResumeTextReference {
  type: "resume_text";
  text: string;
  sourceLabel: string;
}

export interface JdMatchStartResponse {
  status: "awaiting_review" | "complete";
  threadId: string;
  proposals: MatchProposal[];
  structuredJd?: StructuredJd;
  errors: string[];
  backend: "agent-host" | "browser-fallback";
}

export interface JdMatchResumeResponse {
  status: "complete";
  threadId: string;
  accepted: MatchProposal[];
  edited: MatchProposal[];
  gaps: MatchProposal[];
  errors: string[];
}

const DEFAULT_AGENT_HOST_URL = readRuntimeConnection()?.origin ?? "http://127.0.0.1:5179";
const AGENT_TOKEN = readRuntimeConnection()?.agentToken ?? "better-me-agent-token";
const MAX_CHAT_CONTINUATIONS = 2;
const MIN_CONTINUATION_OVERLAP = 8;
const DEFAULT_AGENT_CHAT_TIMEOUT_MS = 35_000;
const LOCAL_OLLAMA_CHAT_TIMEOUT_MS = 120_000;

function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /(?:signal )?timed? out|timeout/i.test(error.message);
}

function agentChatHostTimeoutMs(provider: LlmConfig["provider"]): number {
  return provider === "ollama" ? LOCAL_OLLAMA_CHAT_TIMEOUT_MS : DEFAULT_AGENT_CHAT_TIMEOUT_MS;
}

function describeAgentChatHostFailure(error: unknown): string {
  if (isTimeoutFailure(error)) return "Agent Host 回复超时，已改由浏览器直连重新生成。";
  if (error instanceof TypeError && /failed to fetch|fetch failed|networkerror|load failed/i.test(error.message)) {
    return "本机 Agent Host 无法连接。请先保存当前编辑，再启动或重启 pnpm dev；独立验收入口使用 pnpm dev:isolated。本轮已改为浏览器直连。";
  }
  const detail = error instanceof Error ? error.message : "连接失败";
  return `Agent Host 不可用，已改为浏览器直连：${detail}`;
}

function isLengthLimitedFinishReason(reason: string | undefined): boolean {
  return Boolean(reason && ["length", "max_tokens", "max_output_tokens", "token_limit"].includes(reason.toLowerCase()));
}

function appendContinuation(current: string, addition: string): string {
  const scanLength = Math.min(current.length, addition.length, 4_000);
  for (let overlap = scanLength; overlap >= MIN_CONTINUATION_OVERLAP; overlap -= 1) {
    if (current.slice(-overlap) === addition.slice(0, overlap)) return current + addition.slice(overlap);
  }
  return current + addition;
}

export interface LocalRuntimeInfo {
  id: string;
  name: string;
  status: "available" | "not-installed" | "needs-config" | "error";
  version?: string;
  resolvedCommand?: string;
  detail?: string;
  capabilities: string[];
}

export interface LocalAgentRun {
  id: string;
  workflow: string;
  runtimeId: string;
  status: "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  runDirectory: string;
  outputDirectory: string;
  isolation?: "process" | "os-sandbox" | "none";
  allowedReadPaths?: string[];
  error?: string;
}

export interface LocalAgentRunStatusResponse {
  run: LocalAgentRun;
  latestSequence: number;
  /** Complete normalized assistant answer, separate from process logs. */
  output?: string;
  /** Raw stdout/stderr capture for diagnostics; never render as the answer. */
  rawOutput?: string;
}

export interface LocalAgentEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface StartLocalAgentRunParams {
  runtimeId: string;
  workflow?: string;
  prompt: string;
  contextPack?: {
    role: string;
    task: string;
    artifactRefs?: string[];
    toolAllowlist?: string[];
    redactedFields?: string[];
    content?: Record<string, unknown>;
    characterBudget?: number;
  };
  allowedReadPaths?: string[];
  timeoutMs?: number;
  sandboxMode?: "auto" | "required" | "disabled";
  baseUrl?: string;
}

export interface StartLocalAgentRunResponse {
  run: LocalAgentRun;
  eventsUrl: string;
  statusUrl: string;
}

export async function listLocalAgentRuntimes(baseUrl = DEFAULT_AGENT_HOST_URL): Promise<LocalRuntimeInfo[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent/runtimes`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    signal: AbortSignal.timeout(3_500),
  });
  if (!res.ok) throw new Error(`agent_host_${res.status}`);
  const data = await res.json() as { runtimes?: LocalRuntimeInfo[] };
  return Array.isArray(data.runtimes) ? data.runtimes : [];
}

export async function scanLocalAgentRuntimes(baseUrl = DEFAULT_AGENT_HOST_URL): Promise<LocalRuntimeInfo[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent/runtimes/scan`, {
    method: "POST",
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`agent_host_${res.status}`);
  const data = await res.json() as { runtimes?: LocalRuntimeInfo[] };
  return Array.isArray(data.runtimes) ? data.runtimes : [];
}

export async function startLocalAgentRun(params: StartLocalAgentRunParams): Promise<StartLocalAgentRunResponse> {
  const res = await fetch(`${params.baseUrl ?? DEFAULT_AGENT_HOST_URL}/api/v1/agent/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify({
      runtimeId: params.runtimeId,
      workflow: params.workflow ?? "companion-run",
      prompt: params.prompt,
      contextPack: params.contextPack,
      allowedReadPaths: params.allowedReadPaths ?? [],
      timeoutMs: params.timeoutMs,
      sandboxMode: params.sandboxMode,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`agent_run_${res.status}`);
  return res.json() as Promise<StartLocalAgentRunResponse>;
}

export async function getLocalAgentRun(runId: string, baseUrl = DEFAULT_AGENT_HOST_URL): Promise<LocalAgentRunStatusResponse> {
  const res = await fetch(`${baseUrl}/api/v1/agent/runs/${encodeURIComponent(runId)}`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`agent_run_status_${res.status}`);
  return res.json() as Promise<LocalAgentRunStatusResponse>;
}

export async function cancelLocalAgentRun(runId: string, baseUrl = DEFAULT_AGENT_HOST_URL): Promise<{ run: LocalAgentRun }> {
  const res = await fetch(`${baseUrl}/api/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`agent_run_cancel_${res.status}`);
  return res.json() as Promise<{ run: LocalAgentRun }>;
}

function emitSseFrame(frame: string, onEvent: (event: LocalAgentEvent) => void): void {
  const data: string[] = [];
  let eventId = "";
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("id:")) eventId = line.slice(3).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  try {
    const event = JSON.parse(data.join("\n")) as LocalAgentEvent;
    if (!event.id && eventId) event.id = eventId;
    if (Number.isFinite(event.sequence)) onEvent(event);
  } catch {
    // Keepalive/comment frames and malformed third-party output are ignored.
  }
}

export async function streamLocalAgentRun(params: {
  runId: string;
  after?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  onEvent: (event: LocalAgentEvent) => void;
}): Promise<void> {
  const query = new URLSearchParams();
  if (typeof params.after === "number" && params.after >= 0) query.set("after", String(params.after));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(`${params.baseUrl ?? DEFAULT_AGENT_HOST_URL}/api/v1/agent/runs/${encodeURIComponent(params.runId)}/events${suffix}`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}`, Accept: "text/event-stream" },
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`agent_run_events_${res.status}`);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) emitSseFrame(frame, params.onEvent);
    }
    buffer += decoder.decode();
    if (buffer.trim()) emitSseFrame(buffer, params.onEvent);
  } finally {
    reader.releaseLock();
  }
}

export interface CareerWorkflowArtifact {
  id: string;
  type: string;
  version: number;
  runId: string;
  sourceRefs: string[];
  payload: Record<string, unknown>;
}

export interface CareerWorkflowResponse {
  status: "awaiting_approval" | "complete";
  threadId: string;
  workers: Array<{ id: string; status: string; runtimeId?: string; detail?: string }>;
  artifacts: CareerWorkflowArtifact[];
  coverage: { attempted: number; completed: number; missing: string[] };
  errors: string[];
  stepLog: string[];
  approval?: { status: "approved" | "rejected"; actorScope?: string; expectedRevision?: number; idempotencyKey?: string };
}

export async function startCareerWorkflow(params: {
  threadId: string;
  task: string;
  workspaceId?: string;
  requestedRuntimeId?: string;
  baseUrl?: string;
}): Promise<CareerWorkflowResponse> {
  const res = await fetch(`${params.baseUrl ?? DEFAULT_AGENT_HOST_URL}/api/v1/agent/workflows/career/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify({ threadId: params.threadId, task: params.task, workspaceId: params.workspaceId ?? "default", requestedRuntimeId: params.requestedRuntimeId }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!res.ok) throw new Error(`career_workflow_${res.status}`);
  return res.json();
}

export async function resumeCareerWorkflow(params: {
  threadId: string;
  approval: { status: "approved" | "rejected"; approvedArtifactRefs?: string[]; actorScope: string; expectedRevision?: number; idempotencyKey: string };
  baseUrl?: string;
}): Promise<CareerWorkflowResponse> {
  const res = await fetch(`${params.baseUrl ?? DEFAULT_AGENT_HOST_URL}/api/v1/agent/workflows/career/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify({ threadId: params.threadId, approval: params.approval }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!res.ok) throw new Error(`career_workflow_${res.status}`);
  return res.json();
}

export async function checkAgentHostHealth(baseUrl = DEFAULT_AGENT_HOST_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/agent/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function startJdMatch(params: {
  threadId: string;
  rawJd: string;
  allowedProfileEntryIds: string[];
  sessionClaims?: Record<string, string>;
  llmConfig: LlmConfig;
  baseUrl?: string;
}): Promise<JdMatchStartResponse> {
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;
  const isConfigured = Boolean(params.llmConfig.apiKey?.trim()) || params.llmConfig.provider === "ollama";
  if (!isConfigured) {
    return executeClientSideJdMatch(
      params.rawJd,
      params.allowedProfileEntryIds,
      params.sessionClaims,
      params.llmConfig
    );
  }

  // 1. Try agent-host service first (LangGraph + SQLite checkpointing)
  try {
    const res = await fetch(`${host}/api/v1/agent/jd-match/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        threadId: params.threadId,
        rawJd: params.rawJd,
        allowedProfileEntryIds: params.allowedProfileEntryIds,
        sessionClaims: params.sessionClaims ?? {},
        modelSettings: {
          ...params.llmConfig,
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
          temperature: params.llmConfig.temperature,
        },
      }),
      signal: AbortSignal.timeout(isOfficialDeepSeek(params.llmConfig) ? 100_000 : 35_000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.proposals) && data.proposals.length > 0) {
        return {
          ...data,
          backend: "agent-host",
        };
      }
    }
  } catch {
    // If agent-host is unreachable or error, seamlessly fall back to browser direct LLM
  }

  // 2. Browser direct mode using real fetchChatCompletion
  return executeClientSideJdMatch(
    params.rawJd,
    params.allowedProfileEntryIds,
    params.sessionClaims,
    params.llmConfig
  );
}

export async function resumeJdMatch(params: {
  threadId: string;
  decisions: Record<string, ProposalDecision>;
  llmConfig: LlmConfig;
  currentProposals: MatchProposal[];
  baseUrl?: string;
}): Promise<JdMatchResumeResponse> {
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;

  try {
    const res = await fetch(`${host}/api/v1/agent/jd-match/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        threadId: params.threadId,
        decisions: params.decisions,
        modelSettings: {
          ...params.llmConfig,
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) {
      return res.json();
    }
  } catch {
    // Fallback in-browser resume resolution
  }

  const accepted = params.currentProposals.filter(
    (p) => params.decisions[p.id]?.status === "accepted"
  );
  const edited = params.currentProposals
    .filter((p) => params.decisions[p.id]?.status === "edited")
    .map((p) => {
      const d = params.decisions[p.id] as { status: "edited"; editedSuggestion: string };
      return { ...p, suggestion: d.editedSuggestion };
    });
  const gaps = params.currentProposals.filter((p) => p.evidenceType === "gap");

  return {
    status: "complete",
    threadId: params.threadId,
    accepted,
    edited,
    gaps,
    errors: [],
  };
}

export async function sendAgentChat(params: {
  messages: ChatMessage[];
  llmConfig: LlmConfig;
  signal?: AbortSignal;
  context?: {
    currentJob?: {
      title?: string;
      company?: string;
      location?: string;
      description?: string;
    };
    resumeSummary?: {
      displayName?: string;
      headline?: string;
      skills?: string[];
      recentExperience?: string;
    };
    resumeEditContext?: ResumeEditContext;
  };
  baseUrl?: string;
}): Promise<ChatMessage> {
  params.signal?.throwIfAborted();
  const host = params.baseUrl ?? DEFAULT_AGENT_HOST_URL;
  let fallbackWarning: string | undefined;

  try {
    const res = await fetch(`${host}/api/v1/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({
        messages: params.messages,
        modelSettings: {
          ...params.llmConfig,
          provider: params.llmConfig.provider,
          baseUrl: params.llmConfig.baseUrl,
          model: params.llmConfig.model,
          apiKey: params.llmConfig.apiKey || "mock-key",
          temperature: params.llmConfig.temperature,
        },
        context: params.context,
      }),
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(isOfficialDeepSeek(params.llmConfig) ? 100_000 : agentChatHostTimeoutMs(params.llmConfig.provider))])
        : AbortSignal.timeout(isOfficialDeepSeek(params.llmConfig) ? 100_000 : agentChatHostTimeoutMs(params.llmConfig.provider)),
    });
    params.signal?.throwIfAborted();

    if (res.ok) {
      const data = await res.json() as { reply?: unknown };
      params.signal?.throwIfAborted();
      const reply = normaliseChatReply(data.reply, createResponseMeta(params.llmConfig, "agent-host", "ready"));
      if (reply) return bindResumeProposalSources(reply, params.context?.resumeEditContext);
      fallbackWarning = "Agent Host returned an invalid reply";
    } else {
      if (isOfficialDeepSeek(params.llmConfig)) {
        const failure: unknown = await res.json().catch(() => null);
        if (failure && typeof failure === "object" && "error" in failure && failure.error === "model_provider_error" && "message" in failure && typeof failure.message === "string") {
          return { id: `msg-${crypto.randomUUID()}`, role: "assistant", content: failure.message,
            meta: createResponseMeta(params.llmConfig, "agent-host", "error", "上游模型请求失败，未自动重复生成；请处理后重试。"), createdAt: new Date().toISOString() };
        }
      }
      fallbackWarning = `Agent Host returned HTTP ${res.status}`;
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    fallbackWarning = describeAgentChatHostFailure(error);
  }

  params.signal?.throwIfAborted();
  return bindResumeProposalSources(await executeClientSideChat(params, fallbackWarning), params.context?.resumeEditContext);
}

function bindResumeProposalSources(reply: ChatMessage, context?: ResumeEditContext): ChatMessage {
  if (!reply.actions?.length) return reply;
  return {
    ...reply,
    actions: reply.actions.map((action) => {
      if (action.type !== "resume_proposal") return action;
      if (!action.targetRef || !context) {
        const { targetRef: _target, originalText: _original, sourceVerified: _verified, sourceIssue: _issue, ...readOnly } = action;
        return { ...readOnly, sourceVerified: false, sourceIssue: action.targetRef ? "not_shared" : "missing_target" };
      }
      const originalText = findResumeContextSource(context, action.targetRef);
      if (originalText === undefined) {
        const { targetRef: _untrustedTarget, originalText: _untrustedOriginal, sourceVerified: _verified, sourceIssue: _issue, ...readOnly } = action;
        return { ...readOnly, sourceVerified: false, sourceIssue: "not_shared" };
      }
      const sourceVerified = action.originalText === originalText;
      return { ...action, originalText, sourceVerified, ...(!sourceVerified ? { sourceIssue: "original_mismatch" as const } : {}) };
    }),
  };
}

// ── Browser Direct Mode (Real LLM Execution) ──────────────────────────────────

function extractJsonBlock<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch?.[1] ? fenceMatch[1].trim() : trimmed;

  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  let start = -1;
  let end = -1;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    end = candidate.lastIndexOf("]");
  } else if (firstBrace !== -1) {
    start = firstBrace;
    end = candidate.lastIndexOf("}");
  }

  const jsonStr = start !== -1 && end !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonStr) as T;
}

function providerLabel(config: LlmConfig): string {
  if (config.provider === "ollama") return "Ollama · 本地";
  if (config.provider === "gemini") return "Google Gemini";
  if (config.provider === "openai-compatible") {
    const baseUrl = config.baseUrl.toLowerCase();
    if (baseUrl.includes("deepseek")) return "DeepSeek · API";
    if (baseUrl.includes("openai.com")) return "OpenAI · API";
    return "OpenAI-compatible · API";
  }
  return "自定义 Provider";
}

function createResponseMeta(
  config: LlmConfig,
  source: AgentResponseSource,
  status: AgentResponseStatus,
  warning?: string,
): AgentMessageMeta {
  return {
    provider: config.provider,
    providerLabel: providerLabel(config),
    model: config.model || "未指定模型",
    source,
    status,
    observedAt: new Date().toISOString(),
    ...(warning ? { warning } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isResumeProposalTarget(value: unknown): value is ResumeProposalTarget {
  if (!isRecord(value) || (value.locale !== "zh" && value.locale !== "en")) return false;
  if (value.kind === "profile_headline") return true;
  return value.kind === "claim_text" && isNonEmptyString(value.experienceId) && isNonEmptyString(value.claimId);
}

function isActionCard(value: unknown): value is AgentActionCard {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "company_card") return isNonEmptyString(value.companyName) && isNonEmptyString(value.summary);
  if (value.type === "resume_proposal") return isNonEmptyString(value.targetSection)
    && isNonEmptyString(value.proposedText)
    && isNonEmptyString(value.rationale)
    && (value.targetRef === undefined || isResumeProposalTarget(value.targetRef));
  if (value.type === "job_match") return isNonEmptyString(value.title) && isNonEmptyString(value.company) && isNonEmptyString(value.highlight);
  if (value.type === "interview_defense") return isNonEmptyString(value.gapItem) && isNonEmptyString(value.strategy) && isNonEmptyString(value.sampleAnswer);
  return false;
}

function parseActionResponse(rawText: string): { content: string; actions?: AgentActionCard[]; warning?: string } {
  let content = rawText.trim();
  let actions: AgentActionCard[] | undefined;
  let warning: string | undefined;
  const fence = /```(?:actions|json)\s*([\s\S]*?)\s*```/gi;
  const matches = [...rawText.matchAll(fence)];

  for (const match of matches) {
    const block = match[1]?.trim();
    if (!block) continue;
    try {
      const parsed = JSON.parse(block) as unknown;
      const candidates = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.actions) ? parsed.actions : undefined;
      if (!candidates) {
        warning = "模型返回的动作卡片结构无法识别，已保留原始文本。";
        continue;
      }
      const valid = candidates.filter(isActionCard);
      if (valid.length > 0) {
        const known = new Set((actions ?? []).map((action) => JSON.stringify(action)));
        actions = [...(actions ?? []), ...valid.filter((action) => !known.has(JSON.stringify(action)))];
      }
      if (valid.length === candidates.length && candidates.length > 0) {
        content = content.replace(match[0], "").trim();
      } else {
        warning = "部分结构化动作卡片无法识别，已保留原始文本供核对。";
      }
    } catch {
      warning = "模型返回的动作卡片不是合法 JSON，已保留原始输出。";
    }
  }

  return {
    content,
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(warning ? { warning } : {}),
  };
}

function normaliseChatReply(value: unknown, fallbackMeta: AgentMessageMeta): ChatMessage | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.content)) return undefined;
  const parsed = parseActionResponse(value.content);
  const suppliedActions = Array.isArray(value.actions) ? value.actions.filter(isActionCard) : [];
  const actions = [...(parsed.actions ?? []), ...suppliedActions];
  const suppliedMeta = isRecord(value.meta) ? value.meta : undefined;
  const meta = suppliedMeta ? {
    ...fallbackMeta,
    ...suppliedMeta,
    provider: fallbackMeta.provider,
    providerLabel: fallbackMeta.providerLabel,
    model: isNonEmptyString(suppliedMeta.model) ? suppliedMeta.model : fallbackMeta.model,
    source: "agent-host" as const,
    status: suppliedMeta.completeness === "truncated" || suppliedMeta.status === "truncated"
      ? "truncated" as const
      : suppliedMeta.completeness === "empty" || suppliedMeta.status === "error"
        ? "error" as const
        : fallbackMeta.status,
  } as AgentMessageMeta : fallbackMeta;
  if (parsed.warning && !meta.warning) meta.warning = parsed.warning;
  return {
    id: isNonEmptyString(value.id) ? value.id : `msg-${Date.now()}`,
    role: value.role === "user" || value.role === "system" ? value.role : "assistant",
    content: parsed.content,
    ...(Array.isArray(value.attachments) ? {
      attachments: value.attachments.flatMap((item) => {
        if (!isRecord(item) || !isNonEmptyString(item.name) || !isNonEmptyString(item.mimeType) || !isNonEmptyString(item.dataUrl)) return [];
        if (!/^image\/(png|jpeg|webp)$/i.test(item.mimeType) || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(item.dataUrl)) return [];
        return [{ name: item.name.slice(0, 160), mimeType: item.mimeType, dataUrl: item.dataUrl }];
      }),
    } : {}),
    ...(Array.isArray(value.references) ? {
      references: value.references.flatMap((item) => {
        if (!isRecord(item) || item.type !== "resume_text" || !isNonEmptyString(item.text) || !isNonEmptyString(item.sourceLabel)) return [];
        return [{ type: "resume_text" as const, text: item.text.slice(0, 12_000), sourceLabel: item.sourceLabel.slice(0, 200) }];
      }),
    } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    createdAt: isNonEmptyString(value.createdAt) ? value.createdAt : new Date().toISOString(),
    meta,
  };
}

const CHAT_SYSTEM_PROMPT = `你是一个内置于 BetterMe 个人求职与成长工作台的专属 Agent 职业顾问助手。
你的任务是协助候选人深入分析目标岗位、调研雇主背景、优化简历表达、制定面试应对策略。

【真实性与回答质量】
- 先直接回答用户当前的问题，再给出依据、限制和可执行的下一步；不要只复述问题、套模板或给空泛建议。
- 有多个对象或要求时逐项覆盖。需要更多信息时先说明缺口，并给出基于现有信息能确定的部分。
- 没有实时检索或用户提供来源时，不得声称已经核实公司、岗位、薪资或招聘状态；明确区分事实、推断和待核实项。
- 简历建议不得补造项目、技术、职责或量化成果；缺少事实时用问题标出需补充内容。
- 仅当请求中含“用户本次明确授权的可编辑简历字段”时，才可生成可写回的简历建议卡。普通聊天、简历概况、引用摘录不授权写回。
- 简历建议卡必须针对授权字段中的现有目标，逐字复制其 targetRef；originalText 必须与该字段原文完全一致。不得自造目标或 ID；只调整措辞、不增加事实、技术、指标、责任或成果。
- 缺少可证实内容时不要给简历建议卡，改为追问。建议仍需用户逐条审阅批准，不会自动写入。
- 回答受长度限制时明确提示未完成，不要用省略号伪装成完整结果。
- 将对话当作连续协作：沿用已确认的目标和限制，不重复追问。信息不足时先提供能确定的部分，再提出至多两个推动下一步的澄清问题。
- 规划、学习和模拟面试按目标澄清 → 步骤或练习 → 用户反馈 → 调整下一步推进。每轮末尾只给一个可选择的下一步，不要代替用户决定或声称已经执行。

你可以执行以下专业任务，并在回答中按规范输出结构化动作卡片（Action Cards）：
1. 查公司资料：分析其控股背景（民营/国企/外企）、业务方向、稳定性及潜在风险。
2. 优化简历细节：针对目标 JD 将口语化、扁平的经历改写为符合 STAR 原则、量化且突出技术难点的 Bullet Point。
3. 岗位匹配与缺口攻防：分析简历在目标岗位的优势与盲区，提供面试应答防守策略。

【输出规范】：
请用专业、诚恳、富有建设性的语气回答用户。
如果你的建议包含可以直接操作的动作，请在正文最后附带一个 JSON 代码块，格式如下（若无动作卡片可不附带）：
\`\`\`actions
[
  {
    "type": "company_card",
    "companyName": "公司名称",
    "ownership": "企业性质，如外商独资/民营高科技",
    "jurisdiction": "注册属地代码，如 CN/US",
    "summary": "企业背景及实控人简析",
    "verified": true,
    "officialUrl": "https://..."
  },
  {
    "type": "resume_proposal",
    "targetSection": "目标模块，如 工作经历/个人优势/技术栈",
    "targetRef": {"kind":"claim_text","experienceId":"只可复制授权上下文中的 ID","claimId":"只可复制授权上下文中的 ID","locale":"zh"},
    "originalText": "必须与该授权字段原文完全一致",
    "proposedText": "优化后的专业表述",
    "rationale": "优化理由及契合的 JD 核心点"
  },
  {
    "type": "interview_defense",
    "gapItem": "潜在缺口或面试官高频质疑点",
    "strategy": "防守策略与经验迁移逻辑",
    "sampleAnswer": "高情商/高专业度的面试参考话术"
  },
  {
    "type": "job_match",
    "title": "岗位名称",
    "company": "推荐公司",
    "salary": "薪资范围",
    "location": "城市",
    "highlight": "与候选人画像契合的亮点"
  }
]
\`\`\`
注意：正文可使用常规 Markdown 排版，\`\`\`actions 代码块必须是合法 JSON 数组，不要在 JSON 代码块之后再添加正文。`;

async function executeClientSideJdMatch(
  rawJd: string,
  allowedProfileEntryIds: string[],
  sessionClaims: Record<string, string> | undefined,
  llmConfig: LlmConfig
): Promise<JdMatchStartResponse> {
  const isConfigured = Boolean(llmConfig.apiKey?.trim()) || llmConfig.provider === "ollama";
  if (!isConfigured) {
    const isUrlOrJunk = (l: string) =>
      /^https?:\/\//i.test(l) ||
      /^www\./i.test(l) ||
      /\.(com|cn|net|org|html)/i.test(l) ||
      l.length < 3 ||
      l.startsWith("//") ||
      l.startsWith("@");

    const rawLines = rawJd
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !isUrlOrJunk(l));

    const respLines: string[] = [];
    const qualLines: string[] = [];
    let section: "resp" | "qual" | "other" = "resp";

    for (const line of rawLines) {
      if (/职责|工作内容|负责/i.test(line)) {
        section = "resp";
        continue;
      }
      if (/要求|任职资格|门槛|条件|技能/i.test(line)) {
        section = "qual";
        continue;
      }
      const cleanLine = line.replace(/^[0-9]+[、. ]+/, "").trim();
      if (cleanLine.length >= 6) {
        if (section === "resp") {
          respLines.push(cleanLine);
        } else {
          qualLines.push(cleanLine);
        }
      }
    }

    const meaningfulRequirements = [
      ...qualLines,
      ...respLines,
      ...rawLines.map((l) => l.replace(/^[0-9]+[、. ]+/, "").trim()).filter((l) => l.length >= 8),
    ].filter((l) => !isUrlOrJunk(l));

    const uniqueReqs = Array.from(new Set(meaningfulRequirements));
    const extractedItems =
      uniqueReqs.length > 0
        ? uniqueReqs.slice(0, 5)
        : [
            "负责核心业务中台与高并发系统架构演进，主导微前端与组件库技术标准落地",
            "熟练掌握 React / TypeScript / Node.js 等核心栈，具备优秀的系统架构设计与抽象能力",
            "推进系统性能治理与工程化建设，首屏性能与交互流畅度达到行业领先水平",
            "协同后端与产品团队，落地多端一体化与自动化测试流程，保障系统高可用",
            "探索前沿 AI Agent 与大语言模型在研发流程及产品功能中的结合与落地",
          ];

    // Detect tech stack keywords in rawJd
    const techDict = [
      "React",
      "Vue",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "Go",
      "Python",
      "Java",
      "C#",
      ".NET",
      "微前端",
      "高并发",
      "组件库",
      "分布式",
      "Redis",
      "PostgreSQL",
      "Docker",
      "Kubernetes",
      "AI Agent",
      "大模型",
      "LLM",
      "Next.js",
      "Vite",
      "性能治理",
    ];
    const detectedTech = techDict.filter((t) => rawJd.toLowerCase().includes(t.toLowerCase()));
    const finalTech = detectedTech.length > 0 ? detectedTech : ["React", "TypeScript", "Node.js", "架构演进"];

    const claimsStr = Object.values(sessionClaims ?? {}).join(" ");
    const fallbackProposals: MatchProposal[] = extractedItems.map((item, idx) => {
      const words = item.split(/[\s,，、/]+/).filter((w) => w.length >= 2);
      const matchesWord = words.find((w) => claimsStr.includes(w));
      const matchedClaimId = allowedProfileEntryIds[idx % Math.max(1, allowedProfileEntryIds.length)];

      if (matchesWord && idx < 3) {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "verified",
          profileEntryId: matchedClaimId,
          suggestion: `针对“${item.slice(0, 24)}”，在经历中突出 ${matchesWord} 相关核心指标与攻坚过程`,
          rationale: `履历已具备 ${matchesWord} 相关经历证明，契合该岗位指标（本地事实库规则比对）`,
        };
      } else if (idx === 3) {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "claimed",
          profileEntryId: matchedClaimId,
          suggestion: `结合该职责要求，补充相关工程化与自动化落地的项目细节`,
          rationale: `建议在此条目下补充量化产出数据，以强化说服力（本地事实库规则比对）`,
        };
      } else {
        return {
          id: `prop-heuristic-${idx}-${Date.now()}`,
          jdItem: item.slice(0, 60),
          evidenceType: "gap",
          suggestion: `在面试中准备针对此技术方向的自学见解或同类技术迁移经验`,
          rationale: `当前简历中尚未明确体现该特定方向经验，建议做好面试应答防守（本地事实库规则比对）`,
        };
      }
    });

    return {
      status: "awaiting_review",
      threadId: `thread-demo-${Date.now()}`,
      proposals: fallbackProposals,
      structuredJd: {
        title: "目标职位",
        company: "目标公司",
        location: "工作地点",
        requirements: extractedItems,
        responsibilities: respLines.length > 0 ? respLines : extractedItems.slice(0, 3),
        qualifications: qualLines.length > 0 ? qualLines : extractedItems.slice(2, 5),
        preferences: [],
        compensationRaw: null,
        techStack: finalTech,
      },
      errors: [],
      backend: "browser-fallback",
    };
  }

  // 1. Structure JD
  const structurePrompt = `你是一个结构化招聘信息提取助手。
从用户提供的 JD 文本中提取以下字段，以纯 JSON 格式输出：
{
  "title": "职位名称",
  "company": "公司名称",
  "location": "工作地点",
  "responsibilities": ["岗位职责列表（纯文本要求，每项一行，去除 URL 或广告）"],
  "qualifications": ["任职要求列表（纯文本要求，每项一行，去除 URL 或广告）"],
  "requirements": ["必须具备的核心硬性指标列表（每项一行）"],
  "preferences": ["加分项列表（每项一行）"],
  "compensationRaw": "薪资描述（原文，或 null）",
  "techStack": ["核心技术栈 / 工具列表"]
}
注意：严禁提取任何 HTTP/HTTPS 链接作为要求条目。只输出 JSON，不要 markdown 围栏或额外解释。`;

  let structuredJd: StructuredJd;
  try {
    const rawStructure = await fetchChatCompletion(
      { ...llmConfig, temperature: 0.1 },
      [
        { role: "system", content: structurePrompt },
        { role: "user", content: rawJd },
      ]
    );
    structuredJd = extractJsonBlock<StructuredJd>(rawStructure);
  } catch {
    const lines = rawJd
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !/^https?:\/\//i.test(l));
    structuredJd = {
      title: lines[0] || "目标职位",
      company: "目标公司",
      location: "工作地点",
      requirements: lines.slice(1, 6),
      responsibilities: lines.slice(1, 4),
      qualifications: lines.slice(4, 7),
      preferences: [],
      compensationRaw: null,
      techStack: [],
    };
  }

  // 2. Match against candidate facts
  const claimsSummary = Object.entries(sessionClaims ?? {})
    .map(([k, v]) => `[${k}]:\n${v}`)
    .join("\n\n");
  const verifiedIds = allowedProfileEntryIds.join(", ") || "（无）";

  const matchPrompt = `你是一个资深简历匹配专家与职业顾问。
请根据目标岗位的需求与候选人的实际经历与声明，生成客观专业的逐条匹配建议。

## 岗位需求与加分项
${(structuredJd.requirements || []).map((r, i) => `${i + 1}. ${r}`).join("\n")}
${(structuredJd.preferences || []).map((p, i) => `[加分项] ${i + 1}. ${p}`).join("\n")}

## 候选人履历与事实库（包含已核实经历与声明）
${claimsSummary || "（无详细履历）"}

## 候选人已核实条目 ID 列表
${verifiedIds}

【判定原则】：
1. 如果候选人履历中有明确对应的经历或成果，标注为 "verified"，并填入对应的 profileEntryId（必须来自上述条目 ID 列表）。suggestion 给出如何针对本条 JD 精准提炼该经历的表达建议。
2. 如果候选人履历中有相关表述但缺乏明确的已核实事实，标注为 "claimed"。
3. 如果候选人履历中完全没有提及该项技能或经验，必须诚实标注为 "gap"，并在 suggestion 中给出面试应对或技能迁移的防守策略建议。
4. 绝对不可无中生有虚构候选人没有的经历或假数据。

请以纯 JSON 数组格式输出每条分析：
[
  {
    "jdItem": "原需求文本",
    "evidenceType": "verified" | "claimed" | "gap",
    "profileEntryId": "条目 ID（仅 verified 时填写，可选）",
    "suggestion": "简历具体建议表述",
    "rationale": "匹配依据或缺口分析"
  }
]`;

  let proposals: MatchProposal[];
  try {
    const rawMatch = await fetchChatCompletion(
      { ...llmConfig, temperature: 0.2 },
      [
        { role: "system", content: "你是一个精准客观的简历匹配助手。只输出合法的 JSON 数组。" },
        { role: "user", content: matchPrompt },
      ]
    );

    const rawProposals = extractJsonBlock<Array<{
      jdItem: string;
      evidenceType: "verified" | "claimed" | "gap";
      profileEntryId?: string;
      suggestion: string;
      rationale: string;
    }>>(rawMatch);

    proposals = (rawProposals || []).map((p, i) => ({
      id: `prop-${i}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      jdItem: p.jdItem,
      evidenceType: p.evidenceType || "claimed",
      profileEntryId: p.profileEntryId,
      suggestion: p.suggestion,
      rationale: p.rationale,
    }));
  } catch (err: any) {
    if (!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama") {
      const jdLines = rawJd
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 5 && !l.includes("岗位职责") && !l.includes("任职要求"));
      const extractedItems = jdLines.slice(0, 5);

      const claimsStr = Object.values(sessionClaims ?? {}).join(" ");
      proposals = extractedItems.map((item, idx) => {
        const words = item.split(/[\s,，、/]+/).filter((w) => w.length >= 2);
        const matchesWord = words.find((w) => claimsStr.includes(w));
        const matchedClaimId = allowedProfileEntryIds[idx % Math.max(1, allowedProfileEntryIds.length)];

        if (matchesWord && idx < 3) {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "verified" as const,
            profileEntryId: matchedClaimId,
            suggestion: `针对“${item.replace(/^[0-9]+[、. ]+/, "").slice(0, 24)}”，在经历中突出 ${matchesWord} 相关核心指标与攻坚过程`,
            rationale: `履历已具备 ${matchesWord} 相关经历证明，契合该岗位指标（本地事实库比对）`,
          };
        } else if (idx === 3) {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "claimed" as const,
            profileEntryId: matchedClaimId,
            suggestion: `结合该职责要求，补充相关工程化与自动化落地的项目细节`,
            rationale: `建议在此条目下补充量化产出数据，以强化说服力（本地事实库比对）`,
          };
        } else {
          return {
            id: `prop-heuristic-${idx}-${Date.now()}`,
            jdItem: item.replace(/^[0-9]+[、. ]+/, "").slice(0, 50),
            evidenceType: "gap" as const,
            suggestion: `在面试中准备针对此技术方向的自学见解或同类技术迁移经验`,
            rationale: `当前简历中尚未明确体现该特定方向经验，建议做好面试应答防守（本地事实库比对）`,
          };
        }
      });
    } else {
      throw new Error(`岗位匹配分析失败: ${err?.message || String(err)}`, { cause: err });
    }
  }

  return {
    status: "awaiting_review",
    threadId: `thread-direct-${Date.now()}`,
    proposals,
    structuredJd,
    errors: [],
    backend: "browser-fallback",
  };
}

async function executeClientSideChat(params: {
  messages: ChatMessage[];
  llmConfig: LlmConfig;
  signal?: AbortSignal;
  context?: {
    currentJob?: {
      title?: string;
      company?: string;
      location?: string;
      description?: string;
    };
    resumeSummary?: {
      displayName?: string;
      headline?: string;
      skills?: string[];
      recentExperience?: string;
    };
    resumeEditContext?: ResumeEditContext;
  };
}, fallbackWarning?: string): Promise<ChatMessage> {
  params.signal?.throwIfAborted();
  const isConfigured = Boolean(params.llmConfig.apiKey?.trim()) || params.llmConfig.provider === "ollama";
  if (!isConfigured) {
    return {
      id: `msg-no-key-${Date.now()}`,
      role: "assistant",
      content: `👋 你好！我是你的专属 AI 求职助手。\n\n当前尚未检测到已配置的 AI 模型密钥。请点击右上角 **⚙️ 设置** 按钮，填入你的 API Key（例如免费的 Google AI Studio Gemini API Key、极高性价比的 DeepSeek，或本地 Ollama 服务）。\n\n配置完成后，我将为你提供：\n- 🔍 **目标企业背调与实控人分析**\n- ✍️ **按 STAR 原则一键优化简历细节**\n- 🛡️ **针对 JD 缺口的面试攻防话术**\n- 🎯 **真实深度岗位契合度诊断**`,
      createdAt: new Date().toISOString(),
      meta: createResponseMeta(params.llmConfig, "browser-direct", "error", "尚未配置可用的模型服务。"),
    };
  }

  const contextNotes: string[] = [];
  if (params.context?.currentJob) {
    const job = params.context.currentJob;
    contextNotes.push(`【当前目标岗位】：
职位：${job.title || "未披露"}
公司：${job.company || "未披露"}
地点：${job.location || "未披露"}
JD 描述：${job.description ? job.description.slice(0, 1500) : "未提供"}`);
  }

  if (params.context?.resumeSummary) {
    const r = params.context.resumeSummary;
    contextNotes.push(`【候选人简历概况】：
个人优势/Headline：${r.headline || "未填写"}
核心技能栈：${r.skills?.join(", ") || "未填写"}
可见经历要点：${r.recentExperience || "未提供"}`);
  }

  if (params.context?.resumeEditContext) {
    contextNotes.push(`【用户本次明确授权用于提出修改建议的简历字段】（只读提案，仍需用户逐条批准）：\n${JSON.stringify(params.context.resumeEditContext)}`);
  }

  const systemContent = contextNotes.length > 0
    ? `${CHAT_SYSTEM_PROMPT}\n\n当前上下文背景信息：\n${contextNotes.join("\n\n")}`
    : CHAT_SYSTEM_PROMPT;

  const promptMessages: Array<{ role: "system" | "user" | "assistant"; content: ChatMessageContent }> = [
    { role: "system", content: systemContent },
    ...params.messages.map((m) => ({
      role: m.role,
      content: m.role === "user" && (m.attachments?.length || m.references?.length)
        ? [
            { type: "text" as const, text: [m.content, ...(m.references ?? []).map((reference) => `[简历引用 · ${reference.sourceLabel}]\n${reference.text}`)].filter(Boolean).join("\n\n") || "请分析附件。" },
            ...(m.attachments ?? []).map((attachment) => ({ type: "image_url" as const, image_url: { url: attachment.dataUrl } })),
          ]
        : m.content,
    })),
  ];

  let rawOutput: string;
  let finishReason: string | undefined;
  let continuationFailed = false;
  try {
    const initial = await fetchChatCompletionResult(
      { ...params.llmConfig, temperature: 0.3 },
      promptMessages,
      { signal: params.signal },
    );
    params.signal?.throwIfAborted();
    rawOutput = initial.content;
    finishReason = initial.finishReason;
    let continuationCount = 0;
    while (isLengthLimitedFinishReason(finishReason) && continuationCount < MAX_CHAT_CONTINUATIONS && rawOutput.trim()) {
      let continuation;
      try {
        continuation = await fetchChatCompletionResult(
          { ...params.llmConfig, temperature: 0.3 },
          [
            ...promptMessages,
            { role: "assistant", content: rawOutput },
            { role: "user", content: "请从上一条回复准确结束的位置继续，不要重复已输出内容。补完所有尚未完成的段落与结构化动作卡片；如果不能确认某项信息，请明确标注待核实。" },
          ],
          { signal: params.signal },
        );
      } catch {
        params.signal?.throwIfAborted();
        continuationFailed = true;
        break;
      }
      params.signal?.throwIfAborted();
      if (!continuation.content.trim()) break;
      rawOutput = appendContinuation(rawOutput, continuation.content);
      finishReason = continuation.finishReason;
      continuationCount += 1;
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    const detail = error instanceof Error ? error.message : "模型服务请求失败";
    return {
      id: `msg-chat-error-${Date.now()}`,
      role: "assistant",
      content: `模型未能生成回复：${detail}\n\n请检查服务商、模型名称和网络连接后重试。`,
      createdAt: new Date().toISOString(),
      meta: createResponseMeta(params.llmConfig, "browser-direct", "error", detail),
    };
  }

  params.signal?.throwIfAborted();
  const parsed = parseActionResponse(rawOutput);
  const lengthLimited = isLengthLimitedFinishReason(finishReason);
  const empty = !parsed.content.trim() && !parsed.actions?.length;
  const status: AgentResponseStatus = empty ? "error" : lengthLimited ? "truncated" : fallbackWarning ? "fallback" : "ready";
  const warning = [
    fallbackWarning,
    parsed.warning,
    lengthLimited ? "模型输出仍触及长度上限，回复可能不完整；可让 Agent 继续补完。" : undefined,
    continuationFailed ? "自动续答请求失败，已保留当前内容；可手动继续补完。" : undefined,
    empty ? "模型返回空内容，请重试或检查服务商配置。" : undefined,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: "assistant",
    content: parsed.content || (parsed.actions?.length ? "已整理出以下结构化建议：" : "模型返回空内容，请重试。"),
    ...(parsed.actions ? { actions: parsed.actions } : {}),
    createdAt: new Date().toISOString(),
    meta: {
      ...createResponseMeta(params.llmConfig, "browser-direct", status, warning),
      completeness: empty ? "empty" : lengthLimited ? "truncated" : "complete",
      ...(finishReason ? { finishReason } : {}),
    },
  };
}

