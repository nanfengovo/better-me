import { useCallback, useEffect, useId, useRef, useState } from "react";
import { privateStorage as localStorage } from "../lib/identity";
import { BookOpen, Check, FolderOpen, RefreshCw, Send, ShieldCheck, Square, X } from "lucide-react";
import type { LlmConfig } from "@better-me/core";
import type { UnderstandingCapability, UnderstandingSession } from "@better-me/agent-contracts";
import { isImplementationEvidencePath, careerRuntimeBinding } from "@better-me/agent-contracts";
import { z } from "zod";
import { confirmedWritingProjectContext, type ConfirmedWritingProjectContext } from "../lib/resume-copilot";
import { defaultUnderstandingClient, understandingModelRuntime, UnderstandingClientError, type UnderstandingClient, type UnderstandingRuntime } from "../services/understanding-client";
import { agentBaseLabel, useAgentRouting } from "../lib/agent-routing";
import "./project-understanding-panel.css";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { ProjectContributionReview } from "./ProjectContributionReview";
import { AgentExecutionLog } from "./AgentExecutionLog";
import { useAgentSidebar } from "./AgentSidebar";
import { nativeToolStatus } from "../lib/native-tool-status";
import { useUiPreferences } from "../lib/ui-preferences";

type Props = {
  workspaceKey: string; projectKey: string; label: string; sourceText: string; config: LlmConfig;
  onClose: () => void; onConfirmed: (context: ConfirmedWritingProjectContext | undefined) => void;
  client?: UnderstandingClient; pollIntervalMs?: number;
  chatGpt?: { profileId: string; model: string; ready: boolean };
  onRunningChange?: (running: boolean) => void;
  onContribution?: (supplement: string, context: ConfirmedWritingProjectContext, question: string) => void;
  onSessionChange?: (session: UnderstandingSession | undefined) => void;
  onCompleteToWriting?: (supplement: string, context: ConfirmedWritingProjectContext) => void;
};
const PendingSchema = z.object({ id: z.string(), revision: z.number(), answer: z.string(), options: z.array(z.string()) });
const DraftSchema = z.object({ sessionId: z.string().optional(), answer: z.string().max(16000).default(""),
  options: z.array(z.string()).max(8).default([]), questionId: z.string().optional(), pending: PendingSchema.optional() });
type Pending = z.infer<typeof PendingSchema>;
type Translate = ReturnType<typeof useUiPreferences>["t"];
const phaseLabel = (phase: UnderstandingSession["phase"], t: Translate): string => ({
  idle: t("尚未开始", "Not started"), running: t("Agent 正在理解项目", "Agent is reading the project"), "awaiting-answer": t("等待你的补充或纠正", "Waiting for your input or correction"),
  "awaiting-confirmation": t("等待你确认这份理解", "Waiting for you to confirm this understanding"), confirmed: t("共同理解已确认", "Shared understanding confirmed"), error: t("本轮尚未完成", "This round did not finish"), cancelled: t("本轮已停止", "This round was stopped"),
})[phase];
const evidenceLabel = (kind: "source" | "documentation" | "design" | "user" | "inference" | "unknown", t: Translate): string => ({
  source: t("代码所示 · 不证明上线或个人归属", "Shown in code · does not prove it shipped or who owns it"), documentation: t("文档描述 · 尚非实现验证", "Described in docs · not verified in implementation"),
  design: t("设计方案 · 不等于已交付", "Design proposal · not the same as delivered"), user: t("你的说明", "Your explanation"), inference: t("Agent 推断 · 待核对", "Agent inference · needs checking"), unknown: t("尚不明确", "Not yet clear"),
})[kind];

/** Stable field identity retains history; source changes require an explicit revision update. */
export async function understandingScope(workspaceKey: string, projectKey: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([workspaceKey, projectKey]));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { projectKey: `source-${hash}`, storageKey: `betterme.understanding.v1:${hash}` };
}
function relativeSeconds(at: string | undefined, now: number): number {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 1000)) : 0;
}

export function extractUnderstandingUserSupplement(session: UnderstandingSession | undefined, draftAnswer = ""): string {
  const filler = /^(没有|没问题|没有问题|确认|对的|好的|无|ok|okay|no|none|nothing|yes|confirmed|fine|looks good|那现在这里是闭环了吗.*)$/i;
  const parts = [
    ...(session?.messages ?? []).filter(m => m.role === "user").map(m => m.text.trim()),
    draftAnswer.trim(),
  ].filter(text => text.length > 0 && !filler.test(text));
  return [...new Set(parts)].join("\n");
}

export function ProjectUnderstandingPanel({ workspaceKey, projectKey, label, sourceText, config, onClose, onConfirmed,
  client = defaultUnderstandingClient, pollIntervalMs = 1500, chatGpt, onRunningChange, onContribution, onSessionChange, onCompleteToWriting }: Props) {
  const { agent, snapshot: agentSnapshot } = useBetterMeAgent();
  const sidebar = useAgentSidebar();
  const { t: translate } = useUiPreferences();
  const translateRef = useRef(translate); translateRef.current = translate;
  const t = useCallback<Translate>((chinese, english) => translateRef.current(chinese, english), []);
  const uid = useId();
  const [scope, setScope] = useState<{ projectKey: string; storageKey: string }>();
  const [session, setSession] = useState<UnderstandingSession>();
  const [pointer, setPointer] = useState<string>();
  const [answer, setAnswer] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [initializing, setInitializing] = useState(true);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState("");
  const [composeNotice, setComposeNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [missing, setMissing] = useState(false);
  const [capabilities, setCapabilities] = useState<UnderstandingCapability[]>([]);
  const [capabilityError, setCapabilityError] = useState("");
  const routing = useAgentRouting();
  const [runtime, setRuntime] = useState(chatGpt ? "chatgpt" : "model");
  const [consent, setConsent] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState("");
  const [grantPath, setGrantPath] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true), lock = useRef(false), activeRequest = useRef<AbortController | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null), cardRef = useRef<HTMLElement>(null);
  const current = useRef({ session, scope, answer, options, pending }); current.current = { session, scope, answer, options, pending };
  const confirmedCallback = useRef(onConfirmed); confirmedCallback.current = onConfirmed;
  const sessionChangeCallback = useRef(onSessionChange); sessionChangeCallback.current = onSessionChange;
  const acceptRef = useRef<(next: UnderstandingSession) => void>(() => {});

  function accept(next: UnderstandingSession) {
    const snapshot = current.current;
    if (next.workspaceKey !== workspaceKey || next.projectKey !== snapshot.scope?.projectKey) {
      throw new UnderstandingClientError(t("这份记录与当前字段不一致，未载入；请重新建立项目对话。", "This record does not match the current field and was not loaded; please start a new project conversation."), 409, "scope_mismatch");
    }
    if (snapshot.session && next.revision < snapshot.session.revision) return;
    if (next.revision !== snapshot.session?.revision) setConsent(false);
    if (next.question?.id !== snapshot.session?.question?.id) setOptions([]);
    const submitted = snapshot.pending;
    if (submitted && next.revision > submitted.revision && ["awaiting-answer", "awaiting-confirmation", "confirmed"].includes(next.phase)) {
      if (snapshot.answer === submitted.answer) setAnswer("");
      setOptions([]); setPending(undefined);
    }
    current.current.session = next;
    setSession(next); setPointer(next.id); setMissing(false); setNow(Date.now());
  }
  acceptRef.current = accept;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void understandingScope(workspaceKey, projectKey).then(async nextScope => {
      if (!live) return;
      current.current.scope = nextScope; setScope(nextScope);
      let saved: z.infer<typeof DraftSchema> | undefined;
      try {
        const raw = localStorage.getItem(nextScope.storageKey);
        if (raw) {
          const parsed = DraftSchema.safeParse(JSON.parse(raw));
          if (parsed.success) saved = parsed.data;
          else setStorageError(t("本地对话指针格式不完整，未覆盖原记录。你仍可重新建立对话。", "The local conversation pointer is incomplete and the original record was not overwritten. You can still start a new conversation."));
        }
      } catch { setStorageError(t("本地草稿暂时不可读取；请保留重要输入，不要依赖刷新恢复。", "The local draft cannot be read right now; keep important input and do not rely on a refresh to restore it.")); }
      if (saved) {
        setPointer(saved.sessionId); setAnswer(saved.answer); setOptions(saved.options); setPending(saved.pending);
        current.current.answer = saved.answer; current.current.pending = saved.pending;
        if (saved.sessionId) {
          try {
            const restored = await client.getSession(saved.sessionId, controller.signal);
            if (live) { acceptRef.current(restored); if (restored.question?.id === saved.questionId) setOptions(saved.options); }
          } catch (caught) {
            if (live) { setError(caught instanceof Error ? caught.message : t("暂时无法读取项目对话，草稿仍保留。", "Cannot read the project conversation right now; your draft is kept.")); setMissing(caught instanceof UnderstandingClientError && caught.status === 404); }
          }
        }
      }
    }).catch(() => { if (live) setError(t("当前浏览器无法建立安全的来源绑定，请使用本机安全来源后重试。", "This browser cannot create a secure source binding; use a secure local origin and try again.")); })
      .finally(() => { if (live) setInitializing(false); });
    void client.getCapabilities(controller.signal).then(value => { if (live) setCapabilities(value); })
      .catch(() => { if (live) setCapabilityError(t("暂时无法检测原生 Agent；不会自动切换运行方式。", "Cannot detect native agents right now; the runtime will not be switched automatically.")); });
    return () => { live = false; controller.abort(); };
  }, [client, projectKey, t, workspaceKey]);
  useEffect(() => {
    if (initializing || !scope) return;
    try {
      localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: pointer, answer, options, questionId: session?.question?.id, pending }));
      setStorageError("");
    } catch { setStorageError(t("对话指针或输入草稿未能保存到浏览器；服务端历史不受影响，请复制未发送内容后再离开。", "The conversation pointer or input draft could not be saved in this browser; server history is unaffected, so copy anything unsent before leaving.")); }
  }, [answer, initializing, options, pending, pointer, scope, session?.question?.id, t]);
  useEffect(() => {
    confirmedCallback.current(session && session.sourceText === sourceText ? confirmedWritingProjectContext(session) : undefined);
    sessionChangeCallback.current?.(session);
    setConfirmationToken("");
    if (session?.understanding && cardRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = Math.max(0, cardRef.current.offsetTop - bodyRef.current.offsetTop - 8);
    }
  }, [session, sourceText]);
  useEffect(() => {
    if (session && agentSnapshot?.ready && !agentSnapshot.error) agent?.observeUnderstanding(session, projectKey);
  }, [agent, agentSnapshot?.ready, agentSnapshot?.error, session, projectKey]);
  useEffect(() => { setConsent(false); }, [config.provider, config.baseUrl, config.model, sourceText]);
  useEffect(() => { setConsent(false); }, [chatGpt?.profileId, chatGpt?.model, chatGpt?.ready]);
  const accountAgentSelected = Boolean(chatGpt);
  const preferredReader = sidebar?.readerRuntime ?? "model";
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void client.getCapabilities(controller.signal).then(value => {
      if (!controller.signal.aborted) { setCapabilities(value); setCapabilityError(""); }
    }).catch(() => { if (!controller.signal.aborted) setCapabilityError(t("工具状态尚未确认，请在模型与工具中刷新；不会自动切换。", "Tool status is not confirmed yet; refresh it in Models & tools. Nothing is switched automatically.")); }); };
    window.addEventListener("betterme:native-tools-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("betterme:native-tools-changed", refresh); };
  }, [client, t]);
  useEffect(() => { setRuntime(routing?.enabled ? "unified" : preferredReader === "model" ? accountAgentSelected ? "chatgpt" : "model" : preferredReader); setConsent(false); }, [accountAgentSelected, preferredReader, routing?.enabled, routing?.policy?.revision]);
  const running = session?.phase === "running";
  const runningCallback = useRef(onRunningChange); runningCallback.current = onRunningChange;
  const requestActive = running || operation === "send";
  useEffect(() => {
    runningCallback.current?.(requestActive);
    return () => runningCallback.current?.(false);
  }, [requestActive]);
  useEffect(() => {
    if (!running) window.dispatchEvent(new window.Event("betterme:chatgpt-state"));
  }, [running]);
  const sourceChanged = Boolean(session && session.sourceText !== sourceText);
  useEffect(() => {
    if (!running || !session?.id) return;
    let live = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await client.getSession(session.id, controller.signal); if (live) { acceptRef.current(next); setError(""); setUncertain(false); } }
      catch (caught) { if (live) setError(caught instanceof Error ? caught.message : t("进度暂时无法更新；运行状态尚未确认，输入已保留。", "Progress cannot be updated right now; the run status is unconfirmed and your input is kept.")); }
      if (live) timer = setTimeout(() => void poll(), pollIntervalMs);
    };
    timer = setTimeout(() => void poll(), pollIntervalMs);
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearTimeout(timer); clearInterval(ticker); controller.abort(); };
  }, [client, pollIntervalMs, running, session?.id, t]);

  async function perform(name: string, task: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setOperation(name); setError("");
    const controller = new AbortController(); activeRequest.current = controller;
    try { await task(controller.signal); }
    catch (caught) {
      if (!alive.current || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : t("本次操作未完成，输入仍保留。", "This action did not finish; your input is kept."));
      if (caught instanceof UnderstandingClientError && caught.status === undefined) setUncertain(true);
      if (caught instanceof UnderstandingClientError && caught.status === 409 && current.current.session) {
        try { const fresh = await client.getSession(current.current.session.id, controller.signal); if (alive.current) acceptRef.current(fresh); } catch { /* Keep the useful original conflict and draft. */ }
      }
    } finally { lock.current = false; if (alive.current) { setOperation(undefined); activeRequest.current = undefined; } }
  }
  async function ensureSession(signal: AbortSignal) {
    if (current.current.session) return current.current.session;
    if (pointer && !missing) {
      const restored = await client.getSession(pointer, signal); acceptRef.current(restored); return restored;
    }
    if (!current.current.scope) throw new Error(t("来源绑定尚未就绪，请稍后重试。", "The source binding is not ready yet; please try again shortly."));
    if(routing?.blocked)throw new Error(t("本账号底座状态尚未确认；未使用旧配置建立新任务。", "This account's base status is unconfirmed; no new task was created with the old configuration."));
    const created = await client.createSession({ workspaceKey, projectKey: current.current.scope.projectKey, label, sourceText,rootScopeKey:agent?.workspaceKey??workspaceKey,runtimeBinding:careerRuntimeBinding(selectedRuntime(),routing?.policy?.preferred) }, signal);
    if (!alive.current || signal.aborted) throw new DOMException("Aborted", "AbortError");
    acceptRef.current(created); return created;
  }
  function selectedRuntime():UnderstandingRuntime{return routing?.enabled&&routing.policy?{kind:"unified",expectedRevision:routing.policy.revision}:runtime==="chatgpt"?{kind:"chatgpt",profileId:chatGpt?.profileId??"",model:chatGpt?.model??""}:runtime==="model"?understandingModelRuntime(config):{kind:"native",runtimeId:runtime};}
  const refresh = () => void perform("refresh", async signal => {
    if (pointer) { const next = await client.getSession(pointer, signal); if (alive.current) acceptRef.current(next); }
    const runtimes = await client.getCapabilities(signal); if (alive.current) { setCapabilities(runtimes); setCapabilityError(""); setUncertain(false); }
  });
  const send = () => void perform("send", async signal => {
    if (!consent || sourceChanged) return;
    if (routing?.blocked) throw new Error(t("本账号统一底座状态尚未确认，请刷新模型与工具；未使用旧 API 配置。", "This account's unified base status is unconfirmed; refresh Models & tools. The old API configuration was not used."));
    const before = await ensureSession(signal);
    if (before.phase === "running") throw new Error(t("上一轮仍在运行，请先查看进度或停止，不会重复发送。", "The previous round is still running; check its progress or stop it first. Nothing is sent twice."));
    const selected = options.filter(id => before.question?.options.some(option => option.id === id));
    const oldPending = current.current.pending;
    const submission = oldPending && oldPending.revision === before.revision && oldPending.answer === answer && JSON.stringify(oldPending.options) === JSON.stringify(selected)
      ? oldPending : { id: crypto.randomUUID(), revision: before.revision, answer, options: selected };
    setPending(submission); current.current.pending = submission;
    confirmedCallback.current(undefined); setConsent(false);
    const next = await client.startTurn(before.id, { expectedRevision: before.revision, idempotencyKey: submission.id, answer,
      selectedOptionIds: selected, consentToSend: true,
      runtime: selectedRuntime(),
    }, signal);
    if (alive.current) { acceptRef.current(next); setUncertain(false); }
  });
  const token = session?.summaryHash ? `${session.revision}:${session.summaryHash}` : "";
  const selectedNative = capabilities.find(item => item.id === runtime);
  const runtimeReady = !routing?.blocked && (routing?.enabled || (runtime === "chatgpt" ? Boolean(chatGpt?.ready) : runtime === "model" ? Boolean(config.model.trim() && config.baseUrl.trim() && (config.provider === "ollama" || config.apiKey?.trim())) : Boolean(selectedNative?.available && selectedNative.supported)));
  const busy = initializing || Boolean(operation);
  const lastEvent = session?.events.at(-1);
  const lastTerminal = session?.events.map(event => event.kind).reduce((last, kind, index) => ["waiting", "completed", "error", "cancelled"].includes(kind) ? index : last, -1) ?? -1;
  const runStart = session?.events[lastTerminal + 1]?.at ?? session?.updatedAt;
  const idleSeconds = relativeSeconds(lastEvent?.at ?? session?.updatedAt, now);
  const visibleMessages = showAllHistory ? session?.messages : session?.messages.slice(-20);
  const sessionPhaseLabel = session?.phase === "idle" && session.turnCount > 0 ? t("等待继续对齐", "Waiting to continue aligning") : session ? phaseLabel(session.phase, t) : t("等待你发起第一轮", "Waiting for you to start the first round");

  return <section className="understanding-panel no-print" aria-labelledby={`${uid}-title`}>
    <div className="understanding-sticky">
    <header className="understanding-heading"><div><span className="understanding-eyebrow"><BookOpen size={14} />{t("先建立共同语言", "Build a shared vocabulary first")}</span><h2 id={`${uid}-title`}>{t("一起弄清这个项目", "Let's get this project clear together")}</h2></div><button type="button" onClick={onClose} aria-label={t("收起项目理解面板", "Collapse the project understanding panel")}><X size={16} /></button></header>
    <div className="understanding-current" role="status" aria-live="polite"><strong>{initializing ? t("正在恢复本地对话…", "Restoring the local conversation…") : operation === "send" ? t("正在提交本轮请求…", "Submitting this round…") : sourceChanged ? t("原文已变化 · 需要重新确认", "Source text changed · needs re-confirmation") : sessionPhaseLabel}</strong></div>
    </div>
    <div ref={bodyRef} className="understanding-body" role="region" aria-label={t("项目理解对话与证据", "Project understanding conversation and evidence")} tabIndex={0}>
    <div className="understanding-meta-bar">
      <details className="understanding-progress"><summary>{t("协作进度", "Progress")} · {session?.phase === "confirmed" ? "3" : session?.understanding ? "2" : "1"} / 4</summary><span>{session ? t(`已交流 ${session.turnCount} 轮 · 版本 ${session.revision}`, `${session.turnCount} rounds so far · version ${session.revision}`) : t("没有预设轮数", "No preset number of rounds")}</span>
        {lastEvent && <span>{t("最近进度：", "Latest progress: ")}{lastEvent.label}{running && <span aria-hidden="true"> · {t(`${idleSeconds} 秒前`, `${idleSeconds}s ago`)}</span>}</span>}
        {running && <span aria-live="off">{t(`本轮已等待 ${relativeSeconds(runStart, now)} 秒`, `Waited ${relativeSeconds(runStart, now)}s this round`)}{idleSeconds >= 30 ? t("；暂时没有新的进度，不能据此判断已失败。可停止或刷新状态。", "; no new progress yet, which does not mean it failed. You can stop it or refresh the status.") : ""}</span>}
        <div className="understanding-actions"><button type="button" disabled={busy} onClick={refresh}><RefreshCw size={13} />{t("刷新状态", "Refresh status")}</button>{running && <button type="button" disabled={Boolean(operation)} onClick={() => void perform("cancel", async signal => { const next = await client.cancel(session.id, session.turnCount, signal); if (alive.current) { acceptRef.current(next); setUncertain(false); } })}><Square size={13} />{t("停止本轮", "Stop this round")}</button>}</div>
      </details>
      <details className="understanding-help"><summary>{t("如何一起完善这段经历", "How we refine this experience together")}</summary>
      <nav className="agent-flow-status" aria-label={t("项目协作进度", "Project collaboration progress")}><span aria-current={!session?.understanding ? "step" : undefined}>{t("1 理解项目", "1 Understand the project")}</span><span aria-current={session?.understanding && session.phase !== "confirmed" ? "step" : undefined}>{t("2 核对共识", "2 Check the shared view")}</span><span aria-current={session?.phase === "confirmed" ? "step" : undefined}>{t("3 认领贡献", "3 Claim contributions")}</span><span>{t("4 旁批与候选", "4 Margin notes and candidates")}</span></nav>
      {sidebar && <button type="button" onClick={() => sidebar.learn("contribution")}>{t("如何把理解转成简历", "How to turn understanding into a resume")}</button>}
      <p className="understanding-intro">{t("先对齐术语、流程和边界，轮数由你们的理解决定。你确认后，再讨论个人贡献；这里不会修改简历。", "First align on terms, flow and boundaries; the number of rounds depends on how well you understand each other. Personal contributions come after you confirm, and nothing here edits your resume.")}</p>
      </details>
      <details className="understanding-source"><summary>{t("当前字段 · ", "Current field · ")}{label}</summary><blockquote>{sourceText}</blockquote><p>{t("只使用这条原文。原文变化会保留对话历史，并要求你重新确认理解。", "Only this source text is used. If it changes, the conversation history is kept and you are asked to re-confirm the understanding.")}</p></details>
      <details className="understanding-permissions"><summary data-agent-guide="permissions"><FolderOpen size={14} />{t("允许 Agent 阅读的资料范围（可选）", "Material the Agent may read (optional)")}</summary>{sidebar && <button type="button" onClick={() => sidebar.learn("evidence")}>{t("查看授权教程", "View the authorization guide")}</button>}
        <p>{t("仅按你明确授权的目录或文件读取材料；不会据此认定你的个人贡献。撤销授权会使旧确认失效。自动排除不等于完整脱敏，请勿授权凭据或不应共享的资料。", "Material is read only from folders or files you explicitly authorize and is never used to decide your personal contribution. Revoking access invalidates earlier confirmations. Automatic exclusion is not full redaction, so do not authorize credentials or anything that should not be shared.")}</p>
        <label htmlFor={`${uid}-path`}>{t("要授权的本机目录或文件完整路径", "Full path of the local folder or file to authorize")}</label><div className="understanding-path"><input id={`${uid}-path`} value={grantPath} maxLength={2000} placeholder={t("输入你要共享的目录或文件", "Enter the folder or file to share")} onChange={event => setGrantPath(event.target.value)} /><button type="button" disabled={busy || running || !grantPath.trim()} onClick={() => void perform("grant", async signal => { const before = await ensureSession(signal); confirmedCallback.current(undefined); const next = await client.addGrant(before.id, grantPath.trim(), signal); if (alive.current) { acceptRef.current(next); setGrantPath(""); } })}>{t("授权只读", "Grant read-only access")}</button></div>
        {session?.grants.filter(grant => !grant.revokedAt).map(grant => <div className="understanding-grant" key={grant.id}><code>{grant.path}</code><button type="button" disabled={Boolean(operation)} onClick={() => void perform("revoke", async signal => { confirmedCallback.current(undefined); const next = await client.revokeGrant(session.id, grant.id, signal); if (alive.current) acceptRef.current(next); })}>{t("撤销授权", "Revoke access")}</button></div>)}
      </details>
      <details className="understanding-runtime"><summary>{t("本轮模型与资料去向 · ", "Model and material destination this round · ")}{routing?.enabled ? agentBaseLabel(routing.policy, t) : runtime === "model" ? config.model || t("未配置", "Not configured") : runtime === "chatgpt" ? chatGpt?.model || "ChatGPT" : capabilities.find(item => item.id === runtime)?.name || runtime}</summary>
        {routing?.enabled ? <p>{t("跟随统一 Agent 底座；在“模型与工具”中可任意调整首选和备选。跳过和选择原因在同处可见；本轮授权只覆盖当前原文与已批准资料。", "Follows the unified Agent base; adjust the preferred and fallback bases any time in Models & tools, where skip and selection reasons are also shown. This round's authorization covers only the current source text and approved material.")}</p> : <><label htmlFor={`${uid}-runtime`}>{t("本轮使用", "Use this round")}</label><select id={`${uid}-runtime`} value={runtime} disabled={running || busy} onChange={event => { setRuntime(event.target.value); sidebar?.setReaderRuntime(["model", "chatgpt"].includes(event.target.value) ? "model" : event.target.value); setConsent(false); }}><option value="model">{t("当前模型 · ", "Current model · ")}{config.model || t("尚未配置", "Not configured yet")}</option><option value="chatgpt">{t("ChatGPT 账号授权 · ", "ChatGPT account · ")}{chatGpt?.model || t("请在上方伴写 Agent 中授权并选模型", "Authorize and pick a model in the writing Agent above")}</option>{capabilities.map(item => <option key={item.id} value={item.id} disabled={!item.available || !item.supported}>{item.name} · {nativeToolStatus(item, t)}</option>)}</select></>}
        {runtime === "chatgpt" && <p className="understanding-hint">{t("使用上方选择的 ChatGPT 账号与套餐。额度或授权异常时停止，不使用当前 API 配置补发。", "Uses the ChatGPT account and plan selected above. If quota or authorization fails it stops and does not resend through the current API configuration.")}</p>}
        {capabilityError && <p className="understanding-hint">{capabilityError}</p>}{capabilities.some(item => !item.available || !item.supported) && <details><summary>{t("本机 Agent 兼容性", "Local agent compatibility")}</summary>{capabilities.filter(item => !item.available || !item.supported).map(item => <p className="understanding-hint" key={item.id}>{item.name}{t("：", ": ")}{item.reason ?? t("当前环境不支持此只读工作流", "This environment does not support the read-only workflow")}</p>)}</details>}
        {!runtimeReady && <p className="understanding-hint">{t("请先完成当前模型配置，或选择明确可用的原生 Agent。不会自动改用其他提供方。", "Finish the current model configuration or pick a native agent that is clearly available. No other provider is substituted automatically.")}</p>}
        <p className="understanding-hint">{t("本机原生 Agent 也可能调用云模型。资料会按所选模型或原生工具的配置发送；只读权限不代表资料不会离开本机。", "Local native agents may also call cloud models. Material is sent according to the chosen model or native tool, and read-only access does not mean it stays on this computer.")}</p>
        <small>{t("输入草稿留在当前浏览器；对话与确认保存在本机 Agent。收起面板不会停止正在运行的一轮。", "Input drafts stay in this browser; conversations and confirmations are stored in the local Agent. Collapsing the panel does not stop a running round.")}</small>
      </details>
      <AgentExecutionLog entries={(session?.events ?? []).map(event => ({ id: String(event.sequence), at: event.at, kind: event.kind, label: event.label, important: !["reading", "thinking"].includes(event.kind) }))} />
      {Boolean(session?.evidence.length) && <details className="understanding-evidence"><summary>{t("已读取材料 · ", "Material read · ")}{t(`${session?.evidence.length} 段`, `${session?.evidence.length} excerpts`)}</summary>{session?.evidence.map(item => <details key={item.id}><summary>{item.path} · {t(`${item.startLine}–${item.endLine} 行`, `lines ${item.startLine}–${item.endLine}`)}</summary><p>{t("采集于 ", "Collected ")}<time dateTime={item.collectedAt}>{new Date(item.collectedAt).toLocaleString()}</time>{t(" · 内容指纹 ", " · content fingerprint ")}<code>{item.hash}</code>{t("。这是采集时快照，不代表当前生产状态，也不证明个人贡献。", ". This is a snapshot from collection time; it does not reflect current production or prove a personal contribution.")}</p><pre>{item.excerpt || t("此材料已撤销或不再用于后续推理；仅保留采集记录。", "This material was revoked or is no longer used for later reasoning; only the collection record is kept.")}</pre></details>)}</details>}
    </div>
    {sourceChanged && <div className="understanding-alert" role="alert"><p>{t("原文已变化，旧共识暂不可用于伴写。对话历史仍保留；只有你确认后才会更新本次材料。", "The source text changed, so the old shared view cannot be used for writing help for now. The conversation history is kept, and the material is updated only after you confirm.")}</p><button type="button" disabled={busy || running || sourceText.length > 16000 || !sourceText.trim()} onClick={() => void perform("source", async signal => {
      if (!session) return; confirmedCallback.current(undefined);
      const next = await client.updateSource(session.id, { expectedRevision: session.revision, sourceText }, signal);
      if (alive.current) { acceptRef.current(next); setConsent(false); }
    })}>{t("以新原文继续（重新确认）", "Continue with the new source text (re-confirm)")}</button></div>}
    {storageError && <p className="understanding-alert" role="alert">{storageError}</p>}
    {error && <p className="understanding-alert" role="alert">{error}</p>}
    {session?.error && <p className="understanding-alert" role="alert">{session.error.message} {t("你的输入和对话记录已保留。", "Your input and conversation history are kept.")}</p>}
    {session?.checkpoint && <section className="understanding-checkpoint" aria-label={t("本轮取证进度", "Evidence progress this round")}><strong>{t(`第 ${session.checkpoint.turn} 轮 · `, `Round ${session.checkpoint.turn} · `)}{({ reading: t("取证中", "Reading evidence"), synthesizing: t("正在整理阶段理解", "Summarizing the interim understanding"), partial: t("取证进度已保留，理解尚未更新", "Evidence progress kept; understanding not updated yet"), complete: t("本轮理解已更新", "Understanding updated this round") })[session.checkpoint.status]}</strong><p>{t(`读取操作 ${session.checkpoint.used} / ${session.checkpoint.budget} · 材料 ${session.checkpoint.evidenceIds.length} 段 · 目录复用 ${session.checkpoint.reusedDirectories} 次`, `Reads ${session.checkpoint.used} / ${session.checkpoint.budget} · ${session.checkpoint.evidenceIds.length} excerpts · directories reused ${session.checkpoint.reusedDirectories} times`)}</p>
      {session.checkpoint.status === "partial" && <p>{t("下面的旧理解不代表本轮新材料。可继续一轮要求先整理现有证据；不会自动重发或切换模型。", "The earlier understanding below does not reflect this round's new material. You can continue one more round and ask it to organize the existing evidence first; nothing is resent or switched automatically.")}</p>}
      {session.checkpoint.evidenceIds.length > 0 && <details><summary>{t("本轮取得了什么", "What this round gathered")}</summary><ul>{session.evidence.filter(item => session.checkpoint!.evidenceIds.includes(item.id)).map(item => <li key={item.id}>{item.path} · {t(`${item.startLine}–${item.endLine} 行`, `lines ${item.startLine}–${item.endLine}`)}{!item.excerpt ? t(" · 已撤销", " · revoked") : ""}</li>)}</ul></details>}
    </section>}
    {missing && <button type="button" disabled={busy} onClick={() => { setPointer(undefined); setMissing(false); setError(""); setSession(undefined); }}>{t("保留输入，重新建立对话", "Keep the input and start a new conversation")}</button>}
    {session?.id.startsWith("understanding_")&&<button type="button" disabled={busy||running} onClick={()=>{current.current.session=undefined;setPointer(undefined);setSession(undefined);setPending(undefined);setOptions([]);setConsent(false);setError("");confirmedCallback.current(undefined);}}>{t("保留旧记录，建立内核任务（重新授权）", "Keep the old record and create a kernel task (re-authorize)")}</button>}
    {Boolean(session?.messages.length) && <details className="understanding-history" open><summary>{t("对话历史 · ", "Conversation history · ")}{t(`${session?.messages.length} 条`, `${session?.messages.length} messages`)}</summary>{!showAllHistory && (session?.messages.length ?? 0) > 20 && <button type="button" onClick={() => setShowAllHistory(true)}>{t(`展开更早的 ${(session?.messages.length ?? 0) - 20} 条记录`, `Show ${(session?.messages.length ?? 0) - 20} earlier messages`)}</button>}<ol>{visibleMessages?.map(message => <li key={message.id} data-role={message.role}><div><strong>{message.role === "user" ? t("你", "You") : message.role === "agent" ? "Agent" : t("状态", "Status")}</strong><time dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time></div><p>{message.text}</p>{message.question && <p className="understanding-history-question">{t("追问：", "Follow-up: ")}{message.question.text}</p>}</li>)}</ol></details>}
    {session?.understanding && <section ref={cardRef} tabIndex={-1} className="understanding-card" data-agent-guide="understanding-summary" aria-label={t("当前项目理解卡片", "Current project understanding card")}><div className="understanding-card-heading"><h3>{session.checkpoint && session.checkpoint.status !== "complete" ? t("上次理解 · 本轮尚未更新", "Previous understanding · not updated this round") : t("我目前这样理解（完整整理）", "My current understanding (full summary)")}</h3><span>{sourceChanged ? t("原文已变化 · 待重确认", "Source changed · re-confirm") : session.phase === "confirmed" ? t("你已确认", "You confirmed") : t("待你核对", "Awaiting your review")}</span></div><p>{session.understanding.summary}</p>
      {session.understanding.terms.length > 0 && <dl className="understanding-terms">{session.understanding.terms.map((term, index) => <div key={`${term.term}-${index}`}><dt>{term.term}</dt><dd>{term.meaning}</dd></div>)}</dl>}
      {session.understanding.boundaries.length > 0 && <><h4>{t("项目边界", "Project boundaries")}</h4><ul>{session.understanding.boundaries.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {session.understanding.claims.length > 0 && <details><summary>{t("理解依据与待核对推断", "Evidence and inferences to verify")}</summary>{session.understanding.claims.map(claim => <p key={claim.id}><span className="understanding-evidence-kind">{claim.kind === "source" && !session.evidence.some(item => claim.evidenceIds.includes(item.id) && item.excerpt && isImplementationEvidencePath(item.path)) ? t("历史材料结论 · 未核对代码证据", "Conclusion from historical material · code evidence not checked") : evidenceLabel(claim.kind, t)}</span>{claim.text}</p>)}</details>}
      {session.understanding.unknowns.length > 0 && <><h4>{t("仍不确定", "Still uncertain")}</h4><ul>{session.understanding.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {session.phase === "awaiting-confirmation" && <div className="understanding-confirm"><label><input type="checkbox" checked={confirmationToken === token && Boolean(token)} onChange={event => setConfirmationToken(event.target.checked ? token : "")} />{t("我已核对本版术语和项目边界；这不等于确认我的个人贡献", "I have checked this version of the terms and project boundaries; this does not confirm my personal contribution")}</label><button type="button" disabled={busy || sourceChanged || !token || confirmationToken !== token} onClick={() => void perform("confirm", async signal => {
        const next = await client.confirm(session.id, { expectedRevision: session.revision, summaryHash: session.summaryHash! }, signal);
        if (alive.current) acceptRef.current(next);
      })}><Check size={14} />{t("确认共同理解，再讨论贡献", "Confirm the shared understanding, then discuss contributions")}</button></div>}
      {session.phase === "confirmed" && !sourceChanged && <div className="understanding-confirmed-block"><p className="understanding-confirmed"><ShieldCheck size={15} />{t("确认仅作为术语背景；个人动作和成果仍需你另外提供、逐字核对。", "This confirmation is only terminology background; your personal actions and results still need to be provided and checked word by word.")}</p>{onCompleteToWriting && confirmedWritingProjectContext(session) && <button type="button" className="understanding-primary" disabled={busy} onClick={() => onCompleteToWriting(extractUnderstandingUserSupplement(session, answer), confirmedWritingProjectContext(session)!)}><Check size={14} />{t("同步项目理解与对话记忆，进入经历改写 →", "Sync the understanding and conversation memory, then rewrite the experience →")}</button>}</div>}
    </section>}
    {session && Boolean(session.understanding?.contributionLeads?.length) && <section tabIndex={-1} className="understanding-contributions" data-agent-guide="contribution-review" aria-label={t("贡献线索与个人确认", "Contribution leads and personal confirmation")}><h3>{t("从项目理解到你的贡献", "From project understanding to your contribution")}</h3><p className="understanding-hint">{t("下面是 Agent 根据材料提出的方向，不是对你职责的认定。项目背景确认、个人贡献确认、简历采用是三个独立步骤。", "These are directions the Agent proposes from the material, not a statement of your responsibilities. Confirming the project background, confirming your contribution and adopting it into the resume are three separate steps.")}</p>
      {composeNotice && <p role="status">{composeNotice}</p>}
      {session.understanding!.contributionLeads!.map(lead => <ProjectContributionReview key={`${session.id}:${session.summaryHash}:${lead.id}`} session={session} lead={lead} enabled={session.phase === "confirmed" && !sourceChanged && !busy} onDiscuss={text => {
        const combined = answer.includes(text) ? answer : [answer, text].filter(Boolean).join("\n\n");
        if (combined.length > 16000) { setComposeNotice(t("当前纠正草稿过长，未覆盖原输入；请先整理下方输入框。", "The correction draft is too long and the original input was not overwritten; tidy the input box below first.")); return; }
        setAnswer(combined); setOptions([]); setConsent(false); setComposeNotice(t("已追加到下方「补充或纠正理解」输入框，保留原草稿；核对并授权本轮后再发送。", "Added to the “Add or correct understanding” box below and your original draft is kept; review and authorize this round before sending."));
      }} onPrepare={onContribution ? supplement => void perform("contribution", async signal => {
        const fresh = await client.getSession(session.id, signal);
        if (!alive.current) return;
        acceptRef.current(fresh);
        const context = confirmedWritingProjectContext(fresh);
        if (!context || fresh.sourceText !== sourceText || context.summaryHash !== session.summaryHash || context.revision !== session.revision) throw new Error(t("项目理解或授权已变化，请先重新核对；贡献草稿仍保留。", "The project understanding or authorization changed; please re-check it first. Your contribution draft is kept."));
        onContribution(supplement, context, lead.question);
      }) : undefined} />)}
    </section>}
    {session?.question && <fieldset className="understanding-question"><legend>{session.question.text}</legend><p>{session.question.why}</p><span className="understanding-hint">{session.question.allowMultiple ? t("可以多选，也可以只在下面自由说明。", "You can pick several, or just explain freely below.") : t("可以选一项，也可以只在下面自由说明。", "You can pick one, or just explain freely below.")}{t("没有默认答案。", " There is no default answer.")}</span>
      <div className="understanding-choices">{session.question.options.map(option => <label key={option.id} className={options.includes(option.id) ? "is-selected" : ""}><input type={session.question?.allowMultiple ? "checkbox" : "radio"} name={`${uid}-question`} value={option.id} checked={options.includes(option.id)} onChange={event => setOptions(old => session.question?.allowMultiple ? event.target.checked ? [...old, option.id] : old.filter(id => id !== option.id) : [option.id])} /><span>{option.label}</span></label>)}</div>
      {options.length > 0 && <button type="button" onClick={() => setOptions([])}>{t("清除选择", "Clear selection")}</button>}
    </fieldset>}
    </div>
    <div className="understanding-compose" role="region" aria-label={t("项目理解输入", "Project understanding input")}>
      {onCompleteToWriting && session?.understanding && !sourceChanged && (session.phase === "awaiting-confirmation" || session.phase === "confirmed") && <div className="understanding-handoff-bar">
        <small>{session.phase === "confirmed" ? t("项目理解已确认，可携带记忆直接改写", "Project understanding confirmed; you can rewrite with the memory attached") : t("若上方理解准确，可直接闭环进入改写", "If the understanding above is accurate, you can wrap up and go straight to rewriting")}</small>
        <button type="button" className="understanding-primary" disabled={busy || running || (session.phase !== "confirmed" && !token)} onClick={() => void perform("confirm-handoff", async signal => {
          let latestSession = session;
          if (latestSession.phase !== "confirmed") {
            latestSession = await client.confirm(latestSession.id, { expectedRevision: latestSession.revision, summaryHash: latestSession.summaryHash! }, signal);
            if (!alive.current) return;
            acceptRef.current(latestSession);
          }
          const ctx = confirmedWritingProjectContext(latestSession);
          if (ctx) onCompleteToWriting(extractUnderstandingUserSupplement(latestSession, answer), ctx);
        })}><Check size={13} />{session.phase === "confirmed" ? t("同步理解与对话记忆，去改写 →", "Sync understanding and memory, go rewrite →") : t("理解无误，同步记忆去改写 →", "Looks right, sync memory and go rewrite →")}</button>
      </div>}
      <label htmlFor={`${uid}-answer`}>{session?.understanding ? t("补充或纠正理解", "Add or correct understanding") : t("用自己的话说说这个项目（也可以先让 Agent 提问）", "Describe this project in your own words (or let the Agent ask first)")}</label><textarea id={`${uid}-answer`} data-agent-guide="understanding-answer" rows={1} maxLength={16000} value={answer} onChange={event => setAnswer(event.target.value)} placeholder={t("说说原来的困难、你做的事，或纠正 Agent 的理解。", "Describe the original difficulty, what you did, or correct the Agent's understanding.")} />
      <div className="understanding-compose-footer">
        <div className="understanding-compose-consent-col">
          <label className="understanding-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{t("允许本轮将这条原文、对话和授权资料交给所选运行方式处理", "Allow this round to pass this source text, the conversation and authorized material to the selected runtime")}</label>
          <p className="understanding-destination">{t("发送至：", "Send to: ")}{runtime === "model" ? `${config.provider} · ${config.model || t("未配置", "Not configured")}` : runtime === "chatgpt" ? `ChatGPT · ${chatGpt?.model || t("未配置", "Not configured")}` : capabilities.find(item => item.id === runtime)?.name || runtime}{t(" · 可能使用云模型", " · may use a cloud model")}</p>
        </div>
        <button type="button" className="understanding-primary" disabled={busy || running || sourceChanged || uncertain || missing || !scope || !consent || !runtimeReady || sourceText.length > 16000 || !sourceText.trim()} onClick={send}><Send size={13} />{operation === "send" ? t("正在提交…", "Submitting…") : session?.phase === "confirmed" ? t("继续纠正，重新对齐", "Keep correcting and re-align") : t("让 Agent 继续理解", "Let the Agent keep reading")}</button>
      </div>
      {!runtimeReady && <p className="understanding-hint">{t("模型未就绪，请展开“本轮模型与资料去向”检查。", "The model is not ready; expand “Model and material destination this round” to check.")}</p>}
      {uncertain && <p className="understanding-hint">{t("上次请求结果未确认，请先展开协作进度刷新状态；不会自动重发。", "The last request's outcome is unconfirmed; expand Progress and refresh the status first. Nothing is resent automatically.")}</p>}
    </div>
  </section>;
}
