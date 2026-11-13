import { decomposeJdText, type LlmConfig } from "@better-me/core";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { agentOrigin, ownedFetch as fetch, captureIdentity } from "../lib/identity";
import type { AgentChatContext, FreeChatTask, JdMatchTask, JdMatchMaterial, ResumeEditContext, ResumeProposalTarget } from "@better-me/agent-contracts";
import { findResumeContextSource } from "../lib/resume-agent-context";
import { createFreeChatTaskClient, defaultFreeChatTaskClient } from "./free-chat-task-client";
import { understandingModelRuntime, type UnderstandingRuntime } from "./understanding-client";
import { createJdMatchTaskClient,defaultJdMatchTaskClient } from "./jd-match-task-client";
import { AgentTaskClientError } from "./agent-task-transport";

export interface MatchProposal {
  id: string;
  jdItem: string;
  evidenceType: "verified" | "claimed" | "gap";
  profileEntryId?: string;
  suggestion: string;
  rationale: string;
  evidenceIds?:string[];
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
  type: "company_card" | "resume_proposal" | "job_match" | "interview_defense" | "badge_3d";
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
  style?: "quantum_prism" | "cyber_neon" | "sunset_solitude";
  imageUrl?: string;
  renderDurationMs?: number;
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
  taskId?: string;
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

/** Preserve every authorized historical image; the task transports exact bytes as image parts. */
export function chatMessagesForRequest(messages:ChatMessage[]):ChatMessage[]{return messages;}

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

const DEFAULT_AGENT_HOST_URL = agentOrigin();
const AGENT_TOKEN = readRuntimeConnection()?.agentToken ?? "better-me-agent-token";
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

/** @deprecated New execution must use a task with an explicit shared root/runtime. */
export async function startLocalAgentRun(_params: StartLocalAgentRunParams): Promise<StartLocalAgentRunResponse> {
  throw new AgentTaskClientError("独立 CLI 执行入口已退役，请通过统一任务发送；未调用其他接口。", "runtime_run_moved_to_tasks");
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
  const assertIdentity = captureIdentity();
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
      assertIdentity();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        // A callback may synchronously lock or switch identity within this batch.
        assertIdentity();
        emitSseFrame(frame, params.onEvent);
        assertIdentity();
      }
    }
    buffer += decoder.decode();
    assertIdentity();
    if (buffer.trim()) emitSseFrame(buffer, params.onEvent);
    assertIdentity();
  } finally {
    void reader.cancel().catch(() => undefined);
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

/** @deprecated New execution is owned by /tasks. This compatibility seam never dispatches. */
export async function startCareerWorkflow(_params: {
  threadId: string;
  task: string;
  workspaceId?: string;
  requestedRuntimeId?: string;
  baseUrl?: string;
}): Promise<CareerWorkflowResponse> {
  throw new AgentTaskClientError("旧职业工作流已只读；请使用统一任务入口，原历史和审批记录不会自动重放。", "career_workflow_moved_to_tasks");
}

/** @deprecated Existing approvals are history, not permission to resume a retired graph. */
export async function resumeCareerWorkflow(_params: {
  threadId: string;
  approval: { status: "approved" | "rejected"; approvedArtifactRefs?: string[]; actorScope: string; expectedRevision?: number; idempotencyKey: string };
  baseUrl?: string;
}): Promise<CareerWorkflowResponse> {
  throw new AgentTaskClientError("旧职业工作流已只读；旧审批不再启动执行，原记录仍可核对。", "career_workflow_moved_to_tasks");
}

export interface LegacyCareerWorkflowCheckpoint {
  legacy: true; readOnly: true; threadId: string; checkpointId: string;
  state: Record<string, unknown>; pendingWrites: unknown[];
}
/** Read full owner-scoped history without creating a task or recovering consent. */
export async function getLegacyCareerWorkflow(params: { threadId: string; baseUrl?: string; signal?: AbortSignal }): Promise<LegacyCareerWorkflowCheckpoint> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(params.threadId)) throw new AgentTaskClientError("旧工作流标识无效，未读取或修改任何记录。", "invalid_thread_id");
  const res = await fetch(`${params.baseUrl ?? DEFAULT_AGENT_HOST_URL}/api/v1/agent/workflows/career/state/${params.threadId}`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` }, signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new AgentTaskClientError("旧工作流记录尚未读取；未重试、启动或恢复任务。", res.status === 404 ? "thread_not_found" : "legacy_workflow_unavailable");
  const value: unknown = await res.json();
  if (!value || typeof value !== "object" || !("legacy" in value) || value.legacy !== true || !("readOnly" in value) || value.readOnly !== true
    || !("threadId" in value) || value.threadId !== params.threadId || !("checkpointId" in value) || typeof value.checkpointId !== "string"
    || !("state" in value) || !value.state || typeof value.state !== "object" || Array.isArray(value.state) || !("pendingWrites" in value) || !Array.isArray(value.pendingWrites))
    throw new AgentTaskClientError("旧工作流记录格式不完整，未采用；没有启动任务。", "invalid_response");
  return value as LegacyCareerWorkflowCheckpoint;
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
  workspaceKey?:string;rootScopeKey?:string;parentTaskId?:string;consent?:true;
  runtime?:UnderstandingRuntime;preferredRuntimeId?:string;signal?:AbortSignal;
  onTask?:(task:JdMatchTask)=>void;
}): Promise<JdMatchStartResponse> {
  const isConfigured = Boolean(params.llmConfig.apiKey?.trim()) || params.llmConfig.provider === "ollama";
  if (!isConfigured&&!params.runtime) {
    return executeClientSideJdMatch(
      params.rawJd,
      params.allowedProfileEntryIds,
      params.sessionClaims,
      params.llmConfig
    );
  }

  if(params.consent!==true)throw new AgentTaskClientError("请先明确授权当前岗位与简历资料，未自动发送模型请求。","jd_consent_required");
  const client=params.baseUrl?createJdMatchTaskClient({baseUrl:params.baseUrl}):defaultJdMatchTaskClient;
  const task=await client.match({workspaceKey:params.workspaceKey??"jd-analysis",rootScopeKey:params.rootScopeKey,parentTaskId:params.parentTaskId,consent:true,
    matching:{rawJd:params.rawJd,allowedProfileEntryIds:params.allowedProfileEntryIds,sessionClaims:params.sessionClaims??{}},
    runtime:params.runtime??understandingModelRuntime(params.llmConfig),preferredRuntimeId:params.preferredRuntimeId,signal:params.signal,onTask:params.onTask});
  return {status:task.status==="completed"?"complete":"awaiting_review",threadId:task.id,proposals:task.result!.proposals,structuredJd:task.structuredJd,errors:[],backend:"agent-host"};
}

export async function resumeJdMatch(params: {
  threadId: string;
  decisions: Record<string, ProposalDecision>;
  llmConfig: LlmConfig;
  currentProposals: MatchProposal[];
  matching?:JdMatchMaterial;
  baseUrl?: string;
}): Promise<JdMatchResumeResponse> {
  if(!/^ct_[a-f0-9]{32}$/.test(params.threadId))throw new AgentTaskClientError("这是旧图或本地分析记录，不能静默迁移旧许可；原记录保留。","legacy_jd_review_required");
  if(!params.matching)throw new AgentTaskClientError("缺少当前岗位与简历范围核对，未确认旧结果。","jd_scope_required");
  const client=params.baseUrl?createJdMatchTaskClient({baseUrl:params.baseUrl}):defaultJdMatchTaskClient;
  const task=await client.review(params.threadId,params.decisions,params.currentProposals,params.matching),proposals=task.result!.proposals;
  const accepted = proposals.filter(
    (p) => params.decisions[p.id]?.status === "accepted"
  );
  const edited = proposals
    .filter((p) => params.decisions[p.id]?.status === "edited")
    .map((p) => {
      const d = params.decisions[p.id] as { status: "edited"; editedSuggestion: string };
      return { ...p, suggestion: d.editedSuggestion };
    });
  const gaps = proposals.filter((p) => p.evidenceType === "gap");

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
  messages:ChatMessage[];llmConfig:LlmConfig;signal?:AbortSignal;context?:AgentChatContext;baseUrl?:string;
  workspaceKey?:string;rootScopeKey?:string;parentTaskId?:string;runtime?:UnderstandingRuntime;preferredRuntimeId?:string;onTask?:(task:FreeChatTask)=>void;
}):Promise<ChatMessage>{
  const client=params.baseUrl?createFreeChatTaskClient({baseUrl:params.baseUrl}):defaultFreeChatTaskClient;
  const reply=await client.send({...params,workspaceKey:params.workspaceKey??"advisor",runtime:params.runtime??understandingModelRuntime(params.llmConfig)});
  return bindResumeProposalSources({...reply,meta:{...reply.meta,provider:reply.meta?.provider??"custom",providerLabel:reply.meta?.providerLabel??"Agent Host",model:reply.meta?.model??"selected runtime",
    source:"agent-host",status:reply.meta?.status??"ready",observedAt:reply.meta?.observedAt??new Date().toISOString()}},params.context?.resumeEditContext);
}
export const pauseAgentChatTask=(id:string)=>defaultFreeChatTaskClient.pause(id);

export function bindResumeProposalSources(reply: ChatMessage, context?: ResumeEditContext): ChatMessage {
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

// Local deterministic diagnostics only. No browser model or paid fallback exists.
async function executeClientSideJdMatch(
  rawJd: string,
  _allowedProfileEntryIds: string[],
  sessionClaims: Record<string, string> | undefined,
  _llmConfig: LlmConfig
): Promise<JdMatchStartResponse> {
    // No-model path: a JD supplies requirements, not applicant evidence. An
    // overlapping word is only a lead for a question, never verification.
    const lines = rawJd.split(/\r?\n/).map(line => line.trim()).filter(line =>
      line.length > 2 && !/^(?:https?:\/\/|www\.|\/\/|@)/i.test(line)).flatMap(line => {
      // A one-line paste such as “岗位职责：维护入库流程” contains a real
      // requirement. Send the parser a heading AND its verbatim body.
      const inline = line.match(/^(岗位职责|工作职责|职位职责|主要职责|任职要求|任职资格|职位要求|岗位要求|基本要求|加分项|优先条件|Responsibilities|Requirements|Qualifications|Preferred|Bonus)\s*[:：]\s*(\S.*)$/i);
      return inline ? [inline[1]!, inline[2]!] : [line];
    });
    const jd = decomposeJdText(lines.join("\n"));
    const items = [...jd.hardRequirements, ...jd.responsibilities, ...jd.preferredQualifications];
    const claims = Object.values(sessionClaims ?? {});
    const proposals: MatchProposal[] = items.map((item, index) => {
      const overlap = claims.some(text => text.includes(item.originalQuote)
        || item.keywords.some(word => text.toLowerCase().includes(word.toLowerCase())));
      return {
        id: `prop-local-${index}-${Date.now()}`, jdItem: item.originalQuote,
        evidenceType: overlap ? "claimed" : "gap",
        suggestion: overlap
          ? "当前文本有用词重合。若确是相关经历，请说明交付对象和由你完成的那一步。"
          : "当前材料未提供对应依据。如果确实做过，请补一个可核对的实例。",
        rationale: overlap ? "词语相似不是本人贡献或业绩的证明；有可靠统计才写改善幅度。" : "这是当前材料的空白，不表示候选人没有该能力。",
      };
    });
    return {
      status: "awaiting_review", threadId: `thread-local-${Date.now()}`, proposals,
      structuredJd: {
        title: jd.title, company: jd.company, location: jd.location,
        requirements: jd.hardRequirements.map(x => x.originalQuote), responsibilities: jd.responsibilities.map(x => x.originalQuote),
        qualifications: jd.hardRequirements.map(x => x.originalQuote), preferences: jd.preferredQualifications.map(x => x.originalQuote),
        compensationRaw: null, techStack: jd.detectedTechStack,
      },
      errors: items.length ? [] : ["没有可分析的岗位正文，请粘贴实际职责或任职要求。"], backend: "browser-fallback",
    };
  }

