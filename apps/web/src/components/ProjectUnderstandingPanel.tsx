import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Check, FolderOpen, RefreshCw, Send, ShieldCheck, Square, X } from "lucide-react";
import type { LlmConfig } from "@better-me/core";
import type { UnderstandingCapability, UnderstandingSession } from "@better-me/agent-contracts";
import { isImplementationEvidencePath } from "@better-me/agent-contracts";
import { z } from "zod";
import { confirmedWritingProjectContext, type ConfirmedWritingProjectContext } from "../lib/resume-copilot";
import { defaultUnderstandingClient, understandingModelRuntime, UnderstandingClientError, type UnderstandingClient } from "../services/understanding-client";
import "./project-understanding-panel.css";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { ProjectContributionReview } from "./ProjectContributionReview";
import { AgentExecutionLog } from "./AgentExecutionLog";
import { useAgentSidebar } from "./AgentSidebar";

type Props = {
  workspaceKey: string; projectKey: string; label: string; sourceText: string; config: LlmConfig;
  onClose: () => void; onConfirmed: (context: ConfirmedWritingProjectContext | undefined) => void;
  client?: UnderstandingClient; pollIntervalMs?: number;
  chatGpt?: { profileId: string; model: string; ready: boolean };
  onRunningChange?: (running: boolean) => void;
  onContribution?: (supplement: string, context: ConfirmedWritingProjectContext, question: string) => void;
};
const PendingSchema = z.object({ id: z.string(), revision: z.number(), answer: z.string(), options: z.array(z.string()) });
const DraftSchema = z.object({ sessionId: z.string().optional(), answer: z.string().max(16000).default(""),
  options: z.array(z.string()).max(8).default([]), questionId: z.string().optional(), pending: PendingSchema.optional() });
type Pending = z.infer<typeof PendingSchema>;
const phaseLabels: Record<UnderstandingSession["phase"], string> = {
  idle: "尚未开始", running: "Agent 正在理解项目", "awaiting-answer": "等待你的补充或纠正",
  "awaiting-confirmation": "等待你确认这份理解", confirmed: "共同理解已确认", error: "本轮尚未完成", cancelled: "本轮已停止",
};
const evidenceLabels = { source: "代码所示 · 不证明上线或个人归属", documentation: "文档描述 · 尚非实现验证", design: "设计方案 · 不等于已交付", user: "你的说明", inference: "Agent 推断 · 待核对", unknown: "尚不明确" };

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

export function ProjectUnderstandingPanel({ workspaceKey, projectKey, label, sourceText, config, onClose, onConfirmed,
  client = defaultUnderstandingClient, pollIntervalMs = 1500, chatGpt, onRunningChange, onContribution }: Props) {
  const { agent, snapshot: agentSnapshot } = useBetterMeAgent();
  const sidebar = useAgentSidebar();
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
  const [runtime, setRuntime] = useState(chatGpt ? "chatgpt" : "model");
  const [consent, setConsent] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState("");
  const [grantPath, setGrantPath] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true), lock = useRef(false), activeRequest = useRef<AbortController | undefined>(undefined);
  const current = useRef({ session, scope, answer, options, pending }); current.current = { session, scope, answer, options, pending };
  const confirmedCallback = useRef(onConfirmed); confirmedCallback.current = onConfirmed;
  const acceptRef = useRef<(next: UnderstandingSession) => void>(() => {});

  function accept(next: UnderstandingSession) {
    const snapshot = current.current;
    if (next.workspaceKey !== workspaceKey || next.projectKey !== snapshot.scope?.projectKey) {
      throw new UnderstandingClientError("这份记录与当前字段不一致，未载入；请重新建立项目对话。", 409, "scope_mismatch");
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
          else setStorageError("本地对话指针格式不完整，未覆盖原记录。你仍可重新建立对话。");
        }
      } catch { setStorageError("本地草稿暂时不可读取；请保留重要输入，不要依赖刷新恢复。"); }
      if (saved) {
        setPointer(saved.sessionId); setAnswer(saved.answer); setOptions(saved.options); setPending(saved.pending);
        current.current.answer = saved.answer; current.current.pending = saved.pending;
        if (saved.sessionId) {
          try {
            const restored = await client.getSession(saved.sessionId, controller.signal);
            if (live) { acceptRef.current(restored); if (restored.question?.id === saved.questionId) setOptions(saved.options); }
          } catch (caught) {
            if (live) { setError(caught instanceof Error ? caught.message : "暂时无法读取项目对话，草稿仍保留。"); setMissing(caught instanceof UnderstandingClientError && caught.status === 404); }
          }
        }
      }
    }).catch(() => { if (live) setError("当前浏览器无法建立安全的来源绑定，请使用本机安全来源后重试。"); })
      .finally(() => { if (live) setInitializing(false); });
    void client.getCapabilities(controller.signal).then(value => { if (live) setCapabilities(value); })
      .catch(() => { if (live) setCapabilityError("暂时无法检测原生 Agent；不会自动切换运行方式。"); });
    return () => { live = false; controller.abort(); };
  }, [client, projectKey, workspaceKey]);
  useEffect(() => {
    if (initializing || !scope) return;
    try {
      localStorage.setItem(scope.storageKey, JSON.stringify({ sessionId: pointer, answer, options, questionId: session?.question?.id, pending }));
      setStorageError("");
    } catch { setStorageError("对话指针或输入草稿未能保存到浏览器；服务端历史不受影响，请复制未发送内容后再离开。"); }
  }, [answer, initializing, options, pending, pointer, scope, session?.question?.id]);
  useEffect(() => {
    confirmedCallback.current(session && session.sourceText === sourceText ? confirmedWritingProjectContext(session) : undefined);
    setConfirmationToken("");
  }, [session, sourceText]);
  useEffect(() => {
    if (session && agentSnapshot?.ready && !agentSnapshot.error) agent?.observeUnderstanding(session, projectKey);
  }, [agent, agentSnapshot?.ready, agentSnapshot?.error, session, projectKey]);
  useEffect(() => { setConsent(false); }, [config.provider, config.baseUrl, config.model, sourceText]);
  useEffect(() => { setConsent(false); }, [chatGpt?.profileId, chatGpt?.model, chatGpt?.ready]);
  const accountAgentSelected = Boolean(chatGpt);
  const preferredReader = sidebar?.readerRuntime ?? "model";
  useEffect(() => { setRuntime(preferredReader === "model" ? accountAgentSelected ? "chatgpt" : "model" : preferredReader); setConsent(false); }, [accountAgentSelected, preferredReader]);
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
      catch (caught) { if (live) setError(caught instanceof Error ? caught.message : "进度暂时无法更新；运行状态尚未确认，输入已保留。"); }
      if (live) timer = setTimeout(() => void poll(), pollIntervalMs);
    };
    timer = setTimeout(() => void poll(), pollIntervalMs);
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearTimeout(timer); clearInterval(ticker); controller.abort(); };
  }, [client, pollIntervalMs, running, session?.id]);

  async function perform(name: string, task: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setOperation(name); setError("");
    const controller = new AbortController(); activeRequest.current = controller;
    try { await task(controller.signal); }
    catch (caught) {
      if (!alive.current || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "本次操作未完成，输入仍保留。");
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
    if (!current.current.scope) throw new Error("来源绑定尚未就绪，请稍后重试。");
    const created = await client.createSession({ workspaceKey, projectKey: current.current.scope.projectKey, label: label.slice(0, 300), sourceText }, signal);
    if (!alive.current || signal.aborted) throw new DOMException("Aborted", "AbortError");
    acceptRef.current(created); return created;
  }
  const refresh = () => void perform("refresh", async signal => {
    if (pointer) { const next = await client.getSession(pointer, signal); if (alive.current) acceptRef.current(next); }
    const runtimes = await client.getCapabilities(signal); if (alive.current) { setCapabilities(runtimes); setCapabilityError(""); setUncertain(false); }
  });
  const send = () => void perform("send", async signal => {
    if (!consent || sourceChanged) return;
    const before = await ensureSession(signal);
    if (before.phase === "running") throw new Error("上一轮仍在运行，请先查看进度或停止，不会重复发送。");
    const selected = options.filter(id => before.question?.options.some(option => option.id === id));
    const oldPending = current.current.pending;
    const submission = oldPending && oldPending.revision === before.revision && oldPending.answer === answer && JSON.stringify(oldPending.options) === JSON.stringify(selected)
      ? oldPending : { id: crypto.randomUUID(), revision: before.revision, answer, options: selected };
    setPending(submission); current.current.pending = submission;
    confirmedCallback.current(undefined); setConsent(false);
    const next = await client.startTurn(before.id, { expectedRevision: before.revision, idempotencyKey: submission.id, answer,
      selectedOptionIds: selected, consentToSend: true,
      runtime: runtime === "chatgpt" ? { kind: "chatgpt", profileId: chatGpt?.profileId ?? "", model: chatGpt?.model ?? "" }
        : runtime === "model" ? understandingModelRuntime(config) : { kind: "native", runtimeId: runtime },
    }, signal);
    if (alive.current) { acceptRef.current(next); setUncertain(false); }
  });
  const token = session?.summaryHash ? `${session.revision}:${session.summaryHash}` : "";
  const selectedNative = capabilities.find(item => item.id === runtime);
  const runtimeReady = runtime === "chatgpt" ? Boolean(chatGpt?.ready) : runtime === "model" ? Boolean(config.model.trim() && config.baseUrl.trim() && (config.provider === "ollama" || config.apiKey?.trim())) : Boolean(selectedNative?.available && selectedNative.supported);
  const busy = initializing || Boolean(operation);
  const lastEvent = session?.events.at(-1);
  const lastTerminal = session?.events.map(event => event.kind).reduce((last, kind, index) => ["waiting", "completed", "error", "cancelled"].includes(kind) ? index : last, -1) ?? -1;
  const runStart = session?.events[lastTerminal + 1]?.at ?? session?.updatedAt;
  const idleSeconds = relativeSeconds(lastEvent?.at ?? session?.updatedAt, now);
  const visibleMessages = showAllHistory ? session?.messages : session?.messages.slice(-20);
  const sessionPhaseLabel = session?.phase === "idle" && session.turnCount > 0 ? "等待继续对齐" : session ? phaseLabels[session.phase] : "等待你发起第一轮";

  return <section className="understanding-panel no-print" aria-labelledby={`${uid}-title`}>
    <div className="understanding-sticky">
    <header className="understanding-heading"><div><span className="understanding-eyebrow"><BookOpen size={14} />先建立共同语言</span><h2 id={`${uid}-title`}>一起弄清这个项目</h2></div><button type="button" onClick={onClose} aria-label="收起项目理解面板"><X size={16} /></button></header>
    <div className="understanding-progress" role="status" aria-live="polite"><strong>{initializing ? "正在恢复本地对话…" : operation === "send" ? "正在提交本轮请求…" : sourceChanged ? "原文已变化 · 需要重新确认" : sessionPhaseLabel}</strong><span>{session ? `已交流 ${session.turnCount} 轮 · 版本 ${session.revision}` : "没有预设轮数"}</span>
      {lastEvent && <span>最近进度：{lastEvent.label}{running && <span aria-hidden="true"> · {idleSeconds} 秒前</span>}</span>}
      {running && <span aria-live="off">本轮已等待 {relativeSeconds(runStart, now)} 秒{idleSeconds >= 30 ? "；暂时没有新的进度，不能据此判断已失败。可停止或刷新状态。" : ""}</span>}
      <div className="understanding-actions"><button type="button" disabled={busy} onClick={refresh}><RefreshCw size={13} />刷新状态</button>{running && <button type="button" disabled={Boolean(operation)} onClick={() => void perform("cancel", async signal => { const next = await client.cancel(session.id, session.turnCount, signal); if (alive.current) { acceptRef.current(next); setUncertain(false); } })}><Square size={13} />停止本轮</button>}</div>
    </div>
    </div>
    <div className="understanding-body">
    <nav className="agent-flow-status" aria-label="项目协作进度"><span aria-current={!session?.understanding ? "step" : undefined}>1 理解项目</span><span aria-current={session?.understanding && session.phase !== "confirmed" ? "step" : undefined}>2 核对共识</span><span aria-current={session?.phase === "confirmed" ? "step" : undefined}>3 认领贡献</span><span>4 旁批与候选</span></nav>
    {sidebar && <button type="button" onClick={() => sidebar.learn("contribution")}>如何把理解转成简历</button>}
    <p className="understanding-intro">先对齐术语、流程和边界，轮数由你们的理解决定。你确认后，再讨论个人贡献；这里不会修改简历。</p>
    <details className="understanding-source"><summary>当前字段 · {label}</summary><blockquote>{sourceText}</blockquote><p>只使用这条原文。原文变化会保留对话历史，并要求你重新确认理解。</p></details>
    {sourceChanged && <div className="understanding-alert" role="alert"><p>原文已变化，旧共识暂不可用于伴写。对话历史仍保留；只有你确认后才会更新本次材料。</p><button type="button" disabled={busy || running || sourceText.length > 16000 || !sourceText.trim()} onClick={() => void perform("source", async signal => {
      if (!session) return; confirmedCallback.current(undefined);
      const next = await client.updateSource(session.id, { expectedRevision: session.revision, sourceText }, signal);
      if (alive.current) { acceptRef.current(next); setConsent(false); }
    })}>以新原文继续（重新确认）</button></div>}
    {storageError && <p className="understanding-alert" role="alert">{storageError}</p>}
    {error && <p className="understanding-alert" role="alert">{error}</p>}
    {session?.error && <p className="understanding-alert" role="alert">{session.error.message} 你的输入和对话记录已保留。</p>}
    {session?.checkpoint && <section className="understanding-checkpoint" aria-label="本轮取证进度"><strong>第 {session.checkpoint.turn} 轮 · {({ reading: "取证中", synthesizing: "正在整理阶段理解", partial: "取证进度已保留，理解尚未更新", complete: "本轮理解已更新" })[session.checkpoint.status]}</strong><p>读取操作 {session.checkpoint.used} / {session.checkpoint.budget} · 材料 {session.checkpoint.evidenceIds.length} 段 · 目录复用 {session.checkpoint.reusedDirectories} 次</p>
      {session.checkpoint.status === "partial" && <p>下面的旧理解不代表本轮新材料。可继续一轮要求先整理现有证据；不会自动重发或切换模型。</p>}
      {session.checkpoint.evidenceIds.length > 0 && <details><summary>本轮取得了什么</summary><ul>{session.evidence.filter(item => session.checkpoint!.evidenceIds.includes(item.id)).map(item => <li key={item.id}>{item.path} · {item.startLine}–{item.endLine} 行{!item.excerpt ? " · 已撤销" : ""}</li>)}</ul></details>}
    </section>}
    {missing && <button type="button" disabled={busy} onClick={() => { setPointer(undefined); setMissing(false); setError(""); setSession(undefined); }}>保留输入，重新建立对话</button>}
    <details className="understanding-permissions"><summary><FolderOpen size={14} />允许 Agent 阅读的资料范围（可选）</summary>{sidebar && <button type="button" onClick={() => sidebar.learn("evidence")}>查看授权教程</button>}
      <p>仅按你明确授权的目录或文件读取材料；不会据此认定你的个人贡献。撤销授权会使旧确认失效。自动排除不等于完整脱敏，请勿授权凭据或不应共享的资料。</p>
      <label htmlFor={`${uid}-path`}>要授权的本机目录或文件完整路径</label><div className="understanding-path"><input id={`${uid}-path`} value={grantPath} maxLength={2000} placeholder="输入你要共享的目录或文件" onChange={event => setGrantPath(event.target.value)} /><button type="button" disabled={busy || running || !grantPath.trim()} onClick={() => void perform("grant", async signal => { const before = await ensureSession(signal); confirmedCallback.current(undefined); const next = await client.addGrant(before.id, grantPath.trim(), signal); if (alive.current) { acceptRef.current(next); setGrantPath(""); } })}>授权只读</button></div>
      {session?.grants.filter(grant => !grant.revokedAt).map(grant => <div className="understanding-grant" key={grant.id}><code>{grant.path}</code><button type="button" disabled={Boolean(operation)} onClick={() => void perform("revoke", async signal => { confirmedCallback.current(undefined); const next = await client.revokeGrant(session.id, grant.id, signal); if (alive.current) acceptRef.current(next); })}>撤销授权</button></div>)}
    </details>
    {session?.understanding && <section className="understanding-card" aria-label="当前项目理解卡片"><div className="understanding-card-heading"><h3>{session.checkpoint && session.checkpoint.status !== "complete" ? "上次理解 · 本轮尚未更新" : "我目前这样理解"}</h3><span>{sourceChanged ? "原文已变化 · 待重确认" : session.phase === "confirmed" ? "你已确认" : "待你核对"}</span></div><p>{session.understanding.summary}</p>
      {session.understanding.terms.length > 0 && <dl className="understanding-terms">{session.understanding.terms.map((term, index) => <div key={`${term.term}-${index}`}><dt>{term.term}</dt><dd>{term.meaning}</dd></div>)}</dl>}
      {session.understanding.boundaries.length > 0 && <><h4>项目边界</h4><ul>{session.understanding.boundaries.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {session.understanding.claims.length > 0 && <details><summary>理解依据与待核对推断</summary>{session.understanding.claims.map(claim => <p key={claim.id}><span className="understanding-evidence-kind">{claim.kind === "source" && !session.evidence.some(item => claim.evidenceIds.includes(item.id) && item.excerpt && isImplementationEvidencePath(item.path)) ? "历史材料结论 · 未核对代码证据" : evidenceLabels[claim.kind]}</span>{claim.text}</p>)}</details>}
      {session.understanding.unknowns.length > 0 && <><h4>仍不确定</h4><ul>{session.understanding.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {session.phase === "awaiting-confirmation" && <div className="understanding-confirm"><label><input type="checkbox" checked={confirmationToken === token && Boolean(token)} onChange={event => setConfirmationToken(event.target.checked ? token : "")} />我已核对本版术语和项目边界；这不等于确认我的个人贡献</label><button type="button" disabled={busy || sourceChanged || !token || confirmationToken !== token} onClick={() => void perform("confirm", async signal => {
        const next = await client.confirm(session.id, { expectedRevision: session.revision, summaryHash: session.summaryHash! }, signal);
        if (alive.current) acceptRef.current(next);
      })}><Check size={14} />确认共同理解，再讨论贡献</button></div>}
      {session.phase === "confirmed" && !sourceChanged && <p className="understanding-confirmed"><ShieldCheck size={15} />确认仅作为术语背景；个人动作和成果仍需你另外提供、逐字核对。</p>}
    </section>}
    {session && Boolean(session.understanding?.contributionLeads?.length) && <section className="understanding-contributions" aria-label="贡献线索与个人确认"><h3>从项目理解到你的贡献</h3><p className="understanding-hint">下面是 Agent 根据材料提出的方向，不是对你职责的认定。项目背景确认、个人贡献确认、简历采用是三个独立步骤。</p>
      {composeNotice && <p role="status">{composeNotice}</p>}
      {session.understanding!.contributionLeads!.map(lead => <ProjectContributionReview key={`${session.id}:${session.summaryHash}:${lead.id}`} session={session} lead={lead} enabled={session.phase === "confirmed" && !sourceChanged && !busy} onDiscuss={text => {
        const combined = answer.includes(text) ? answer : [answer, text].filter(Boolean).join("\n\n");
        if (combined.length > 16000) { setComposeNotice("当前纠正草稿过长，未覆盖原输入；请先整理下方输入框。"); return; }
        setAnswer(combined); setOptions([]); setConsent(false); setComposeNotice("已追加到下方「补充或纠正理解」输入框，保留原草稿；核对并授权本轮后再发送。");
      }} onPrepare={onContribution ? supplement => void perform("contribution", async signal => {
        const fresh = await client.getSession(session.id, signal);
        if (!alive.current) return;
        acceptRef.current(fresh);
        const context = confirmedWritingProjectContext(fresh);
        if (!context || fresh.sourceText !== sourceText || context.summaryHash !== session.summaryHash || context.revision !== session.revision) throw new Error("项目理解或授权已变化，请先重新核对；贡献草稿仍保留。");
        onContribution(supplement, context, lead.question);
      }) : undefined} />)}
    </section>}
    {session?.question && <fieldset className="understanding-question"><legend>{session.question.text}</legend><p>{session.question.why}</p><span className="understanding-hint">{session.question.allowMultiple ? "可以多选，也可以只在下面自由说明。" : "可以选一项，也可以只在下面自由说明。"}没有默认答案。</span>
      <div className="understanding-choices">{session.question.options.map(option => <label key={option.id} className={options.includes(option.id) ? "is-selected" : ""}><input type={session.question?.allowMultiple ? "checkbox" : "radio"} name={`${uid}-question`} value={option.id} checked={options.includes(option.id)} onChange={event => setOptions(old => session.question?.allowMultiple ? event.target.checked ? [...old, option.id] : old.filter(id => id !== option.id) : [option.id])} /><span>{option.label}</span></label>)}</div>
      {options.length > 0 && <button type="button" onClick={() => setOptions([])}>清除选择</button>}
    </fieldset>}
    <div className="understanding-compose"><label htmlFor={`${uid}-answer`}>{session?.understanding ? "补充或纠正理解" : "用自己的话说说这个项目（也可以先让 Agent 提问）"}</label><textarea id={`${uid}-answer`} rows={3} maxLength={16000} value={answer} onChange={event => setAnswer(event.target.value)} placeholder="例如：这个词在我们的项目里不是这个意思……也可以说明不确定、暂时跳过，或直接提出新的问题。" />
      <label htmlFor={`${uid}-runtime`}>本轮使用</label><select id={`${uid}-runtime`} value={runtime} disabled={running || busy} onChange={event => { setRuntime(event.target.value); sidebar?.setReaderRuntime(["model", "chatgpt"].includes(event.target.value) ? "model" : event.target.value); setConsent(false); }}><option value="model">当前模型 · {config.model || "尚未配置"}</option><option value="chatgpt">ChatGPT 账号授权 · {chatGpt?.model || "请在上方伴写 Agent 中授权并选模型"}</option>{capabilities.map(item => <option key={item.id} value={item.id} disabled={!item.available || !item.supported}>{item.name}{!item.supported || !item.available ? " · 暂不可用" : " · 原生 Agent"}</option>)}</select>
      {runtime === "chatgpt" && <p className="understanding-hint">使用上方选择的 ChatGPT 账号与套餐。额度或授权异常时停止，不使用当前 API 配置补发。</p>}
      {capabilityError && <p className="understanding-hint">{capabilityError}</p>}{capabilities.some(item => !item.available || !item.supported) && <details><summary>本机 Agent 兼容性</summary>{capabilities.filter(item => !item.available || !item.supported).map(item => <p className="understanding-hint" key={item.id}>{item.name}：{item.reason ?? "当前环境不支持此只读工作流"}</p>)}</details>}
      {!runtimeReady && <p className="understanding-hint">请先完成当前模型配置，或选择明确可用的原生 Agent。不会自动改用其他提供方。</p>}
      <label className="understanding-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />允许本轮将这条原文、对话和授权资料交给所选运行方式处理</label>
      <p className="understanding-hint">本机原生 Agent 也可能调用云模型。资料会按所选模型或原生工具的配置发送；只读权限不代表资料不会离开本机。</p>
      <button type="button" className="understanding-primary" disabled={busy || running || sourceChanged || uncertain || missing || !scope || !consent || !runtimeReady || sourceText.length > 16000 || !sourceText.trim()} onClick={send}><Send size={14} />{operation === "send" ? "正在提交…" : session?.phase === "confirmed" ? "继续纠正，重新对齐" : "让 Agent 继续理解"}</button>
      {uncertain && <p className="understanding-hint">上次请求的结果尚未确认，请先刷新状态；不会自动重发。</p>}
      <small>输入草稿留在当前浏览器；对话与确认保存在本机 Agent。收起面板不会停止正在运行的一轮。</small>
    </div>
    {Boolean(session?.messages.length) && <details className="understanding-history" open><summary>对话历史 · {session?.messages.length} 条</summary>{!showAllHistory && (session?.messages.length ?? 0) > 20 && <button type="button" onClick={() => setShowAllHistory(true)}>展开更早的 {(session?.messages.length ?? 0) - 20} 条记录</button>}<ol>{visibleMessages?.map(message => <li key={message.id} data-role={message.role}><div><strong>{message.role === "user" ? "你" : message.role === "agent" ? "Agent" : "状态"}</strong><time dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time></div><p>{message.text}</p>{message.question && <p className="understanding-history-question">追问：{message.question.text}</p>}</li>)}</ol></details>}
    <AgentExecutionLog entries={(session?.events ?? []).map(event => ({ id: String(event.sequence), at: event.at, kind: event.kind, label: event.label, important: !["reading", "thinking"].includes(event.kind) }))} />
    {Boolean(session?.evidence.length) && <details className="understanding-evidence"><summary>已读取材料 · {session?.evidence.length} 段</summary>{session?.evidence.map(item => <details key={item.id}><summary>{item.path} · {item.startLine}–{item.endLine} 行</summary><p>采集于 <time dateTime={item.collectedAt}>{new Date(item.collectedAt).toLocaleString()}</time> · 内容指纹 <code>{item.hash}</code>。这是采集时快照，不代表当前生产状态，也不证明个人贡献。</p><pre>{item.excerpt || "此材料已撤销或不再用于后续推理；仅保留采集记录。"}</pre></details>)}</details>}
    </div>
  </section>;
}
