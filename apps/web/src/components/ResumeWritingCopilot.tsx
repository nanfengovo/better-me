import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LocateFixed, Pause, RotateCcw, Settings2, Sparkles, Square, X } from "lucide-react";
import type { LlmConfig } from "@better-me/core";
import {
  generateWritingReply, inspectWriting, isLocalWritingModel, newWritingNote, readWritingSession, reconcileWritingNotes,
  saveWritingSession, writingTargetKey, writingOriginal, writingProposal, WritingReplyError, confirmedWritingProjectContext,
  type ConfirmedWritingProjectContext, type WritingMode, type WritingNote, type WritingSource,
  writingMessages, parseWritingReply,
} from "../lib/resume-copilot";
import type { ResumeProposalWrite } from "../lib/resume-agent-context";
import { focusWritingSource, observeResumeWriting, readWritingPreviewSelection, revealWritingPreview, useWritingGeometry, type WritingActivity } from "../lib/resume-writing-observer";
import { quoteWritingText, resolveWritingQuote } from "../lib/writing-anchor";
import { writingAnnotations } from "../lib/writing-annotations";
import { ProjectUnderstandingPanel } from "./ProjectUnderstandingPanel";
import { defaultUnderstandingClient, type UnderstandingClient } from "../services/understanding-client";
import "./resume-writing-copilot.css";
import "./writing-annotations.css";
import { ChatGptAgentControls } from "./ChatGptAgentControls";
import { defaultChatGptClient, ChatGptClientError, type ChatGptClient, type ChatGptChoice } from "../services/chatgpt-client";
import { generateChatGptWritingReply } from "../lib/chatgpt-writing";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { AgentContinuityButton, AgentMemoryConsent } from "./BetterMeAgentCenter";
import { AgentSurface, useAgentSidebar } from "./AgentSidebar";
import { OPEN_PROJECT_EVENT } from "../lib/agent-navigation";
import { useUiPreferences } from "../lib/ui-preferences";
import { agentBaseLabel, useAgentRouting } from "../lib/agent-routing";
import { AgentRoutingClientError } from "../services/agent-routing-client";

type Props = {
  sessionKey: string; sources: WritingSource[]; config: LlmConfig; active: boolean; children: ReactNode;
  onApply: (proposal: ResumeProposalWrite) => Promise<{ ok: boolean; message: string }>;
  onFocus: (source: WritingSource) => void;
  generate?: typeof generateWritingReply;
  understandingClient?: UnderstandingClient;
  chatGptClient?: ChatGptClient;
};

/** Owns the review session, never the resume. Writes cross the existing approved CAS interface. */
export function ResumeWritingCopilot({ sessionKey, sources, config, active, onApply, onFocus, children, generate = generateWritingReply, understandingClient = defaultUnderstandingClient, chatGptClient = defaultChatGptClient }: Props) {
  return <WritingCopilotSession key={sessionKey} {...{ sessionKey, sources, config, active, onApply, onFocus, children, generate, understandingClient, chatGptClient }} />;
}

function WritingCopilotSession({ sessionKey, sources, config, active, onApply, onFocus, children, generate = generateWritingReply, understandingClient = defaultUnderstandingClient, chatGptClient = defaultChatGptClient }: Props) {
  const { t } = useUiPreferences();
  const { agent, snapshot: agentSnapshot } = useBetterMeAgent();
  const routing = useAgentRouting();
  const sidebar = useAgentSidebar();
  const [shareAgentMemory, setShareAgentMemory] = useState(false);
  const sharedTask = useRef<string | undefined>(undefined);
  const storageKey = `betterme.writing.v1:${sessionKey}`;
  const [session, setSession] = useState(() => readWritingSession(localStorage, storageKey));
  const [selected, setSelected] = useState<string>();
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const agentPaneId = useId();
  const collapseButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [confirmedAnswer, setConfirmedAnswer] = useState(false);
  const [confirmedProposal, setConfirmedProposal] = useState(false);
  const [understandingSource, setUnderstandingSource] = useState<WritingSource>();
  const [projectContexts, setProjectContexts] = useState<Record<string, { sourceText: string; context: ConfirmedWritingProjectContext }>>({});
  const [shareProjectContext, setShareProjectContext] = useState(false);
  const [localAgentKind, setLocalAgentKind] = useState<"current" | "chatgpt">(() => {
    try { return localStorage.getItem(`betterme.writing-agent.v1:${sessionKey}`) === "chatgpt" ? "chatgpt" : "current"; } catch { return "current"; }
  });
  const [localChoice, setLocalChoice] = useState<ChatGptChoice>({ profileId: "", model: "" });
  const [localReady, setLocalReady] = useState(false);
  const agentKind = agentSnapshot?.data.selection.kind ?? localAgentKind;
  const chatGptChoice = agentSnapshot?.data.selection ?? localChoice;
  const chatGptReady = agentSnapshot?.chatGptReady ?? localReady;
  const setAgentKind = (kind: "current" | "chatgpt") => agent ? agent.setSelection({ kind, profileId: "", model: "" }) : setLocalAgentKind(kind);
  const setChatGptChoice = (choice: ChatGptChoice) => agent ? agent.setSelection({ kind: "chatgpt", ...choice }) : setLocalChoice(choice);
  const setChatGptReady = agent?.setChatGptReady ?? setLocalReady;
  const [understandingRunning, setUnderstandingRunning] = useState(false);
  const [activity, setActivity] = useState<WritingActivity>();
  const shell = useRef<HTMLDivElement>(null), card = useRef<HTMLElement>(null), understandingCard = useRef<HTMLDivElement>(null);
  const latest = useRef({ session, sources, config, active }); latest.current = { session, sources, config, active };
  const request = useRef<{ controller: AbortController; id: number; noteId: string } | null>(null);
  const autoAsk = useRef<(note: WritingNote, open: boolean) => Promise<void>>(async () => {});
  const autoBudget = useRef(new Map<string, number>());
  const epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writeLock = useRef(false), alive = useRef(true);
  const pendingExpand = useRef<string | undefined>(undefined);
  const revealFrame = useRef(0);
  const noteIndex = useRef<HTMLElement>(null);
  const notes = session.notes.filter(n => n.state === "open");
  const annotations = useMemo(() => writingAnnotations(session.notes.filter(note => note.state === "open"), sources), [session.notes, sources]);
  const firstSourceWithNote = sources.find(source => notes.some(note => writingTargetKey(note.source.targetRef) === writingTargetKey(source.targetRef)));
  const focusedNote = notes.find(n => n.id === selected) ?? notes.find(n => writingTargetKey(n.source.targetRef) === activity?.key)
    ?? notes.find(n => firstSourceWithNote && writingTargetKey(n.source.targetRef) === writingTargetKey(firstSourceWithNote.targetRef)) ?? notes[0];
  const focusedAnnotation = annotations.find(annotation => annotation.id === focusedNote?.id);
  const applied = session.notes.find(n => n.state === "applied" && sources.some(s => writingTargetKey(s.targetRef) === writingTargetKey(n.source.targetRef) && s.text === writingProposal(n)?.proposedText));
  const archived = session.notes.filter(n => n.state !== "open");
  const selectionSource = activity && sources.find(s => writingTargetKey(s.targetRef) === activity.key && s.text === activity.text);
  const selectionQuote = selectionSource && activity && quoteWritingText(selectionSource.text, activity.start, activity.end);
  const visible = session.mode !== "paused";
  const canAutoModel = !routing?.enabled && agentKind === "current" && isLocalWritingModel(config);
  const liveUnderstandingSource = understandingSource && sources.find(source => writingTargetKey(source.targetRef) === writingTargetKey(understandingSource.targetRef));
  const understandingOriginal = liveUnderstandingSource
    ? (understandingSource?.quote && resolveWritingQuote(liveUnderstandingSource.text, understandingSource.quote)?.exact) || liveUnderstandingSource.text
    : undefined;
  const focusedContext = focusedNote && projectContexts[writingTargetKey(focusedNote.source.targetRef)];
  const usableContext = focusedNote && focusedContext?.sourceText === writingOriginal(focusedNote.source) ? focusedContext.context : undefined;
  const hasAgentContent = Boolean(focusedNote && visible || agentKind === "chatgpt" || understandingSource || applied || archived.length || storageError || message);
  const showAgentPane = sidebar ? sidebar.open && sidebar.tab === "conversation" && sidebar.conversation === "writing" : hasAgentContent && !agentCollapsed;
  const compactHint = !expanded && !understandingSource && !busy && agentKind !== "chatgpt";
  const geometry = useWritingGeometry(shell, understandingSource ? understandingCard : card, active && visible && showAgentPane ? liveUnderstandingSource ?? focusedNote?.source : undefined, annotations, focusedNote?.id);
  useEffect(() => () => cancelAnimationFrame(revealFrame.current), []);
  useEffect(() => {
    const index = noteIndex.current;
    if (!index) return;
    // Keep the active index visible without moving the chat or the outer page.
    const reveal = () => {
      const current = index.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!current) return;
      if (index.scrollWidth > index.clientWidth) index.scrollLeft = Math.max(0, current.offsetLeft - index.clientWidth / 2 + current.offsetWidth / 2);
      if (index.scrollHeight > index.clientHeight) index.scrollTop = Math.max(0, current.offsetTop - index.clientHeight / 2 + current.offsetHeight / 2);
    };
    reveal();
    const resize = new ResizeObserver(reveal); resize.observe(index);
    return () => resize.disconnect();
  }, [focusedNote?.id, expanded, showAgentPane, understandingSource, visible, annotations.length]);
  const navigation = useRef({ busy, understandingRunning, onFocus }); navigation.current = { busy, understandingRunning, onFocus };
  useEffect(() => {
    const open = (event: Event) => {
      const key = (event as CustomEvent<{ targetKey?: string }>).detail?.targetKey;
      if (!key) return;
      if (navigation.current.busy || navigation.current.understandingRunning) { setMessage("当前一轮仍在运行，未切换原文或打断任务；完成后再打开对应项目。"); return; }
      const source = latest.current.sources.find(item => writingTargetKey(item.targetRef) === key);
      if (!source) { setMessage("此共识对应的原文未载入或已移除，请先核对当前简历；没有使用旧理解生成内容。"); return; }
      const existing = latest.current.session.notes.find(note => note.state === "open" && writingTargetKey(note.source.targetRef) === key && note.source.text === source.text);
      const note = existing ?? newWritingNote(source, inspectWriting(source, latest.current.sources) ?? { kind: "selection", title: "一起打磨这段表达", question: "哪些动作是你本人完成的？" });
      if (!existing) setSession(value => ({ ...value, notes: [note, ...value.notes].slice(0, 80) }));
      setSelected(note.id); setUnderstandingSource(source); setExpanded(true); setAgentCollapsed(false);
      navigation.current.onFocus(source);
    };
    window.addEventListener(OPEN_PROJECT_EVENT, open); return () => window.removeEventListener(OPEN_PROJECT_EVENT, open);
  }, []);

  function collapseAgent() {
    if (sidebar) { sidebar.hide(); return; }
    setAgentCollapsed(true);
    // A panel-local collapse must not leave keyboard focus inside hidden content.
    collapseButton.current?.focus();
  }

  const stop = useCallback(() => { epoch.current++; request.current?.controller.abort(); request.current = null; if (agent && sharedTask.current) void agent.stop(sharedTask.current); sharedTask.current = undefined; setBusy(false); }, [agent]);
  function changeNote(id: string, change: Partial<WritingNote>) {
    setSession(current => ({ ...current, notes: current.notes.map(n => n.id === id ? { ...n, ...change, updatedAt: Date.now() } : n) }));
  }
  function check(keys?: string[]) {
    const current = latest.current;
    if (current.session.mode === "paused") return;
    setSession(state => {
      const next = reconcileWritingNotes(state.notes, current.sources);
      for (const source of current.sources.filter(s => !keys || keys.includes(writingTargetKey(s.targetRef))).reverse()) {
        const issue = inspectWriting(source, current.sources);
        if (!issue || next.some(n => !n.source.quote && writingTargetKey(n.source.targetRef) === writingTargetKey(source.targetRef) && n.source.text === source.text && n.issue.kind === issue.kind)) continue;
        next.unshift(newWritingNote(source, issue));
      }
      return { ...state, notes: next.slice(0, 80) };
    });
  }
  function checkSelection() {
    if (!selectionSource || !selectionQuote || session.mode === "paused") return;
    if (selectionQuote.exact.length > 12000) { setMessage("选中文字过长，请缩小到一个要点或片段后再完善。"); return; }
    stop();
    const source = { ...selectionSource, quote: selectionQuote };
    const existing = session.notes.find(n => n.state === "open" && writingTargetKey(n.source.targetRef) === writingTargetKey(source.targetRef) && n.source.text === source.text && n.source.quote?.start === selectionQuote.start && n.source.quote.exact === selectionQuote.exact);
    const note = existing ?? newWritingNote(source, inspectWriting(source, sources) ?? { kind: "selection", title: "一起打磨这段表达", question: "这段话中，哪些是你亲手做的动作？当时为什么这样处理？有没有可观察的结果或用途？" });
    if (!existing) setSession(s => ({ ...s, notes: [note, ...s.notes].slice(0, 80) }));
    pendingExpand.current = note.id; setSelected(note.id); setExpanded(true); setAgentCollapsed(false);
    sidebar?.show("conversation", "writing");
  }
  useEffect(() => {
    try { saveWritingSession(localStorage, storageKey, session); setStorageError(""); }
    catch { setStorageError("伴写记录暂未保存（浏览器空间不足或存储受限）。简历仍由原保存流程保护，请勿关闭页面以免丢失追问进度。"); }
  }, [session, storageKey]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (privateStorageEvent(event)?.key !== storageKey) return;
      stop(); setSession(current => {
        const remote = readWritingSession(localStorage, storageKey);
        const merged = new Map(current.notes.map(note => [note.id, note]));
        for (const note of remote.notes) if (!merged.has(note.id) || merged.get(note.id)!.updatedAt <= note.updatedAt) merged.set(note.id, note);
        return { ...remote, notes: [...merged.values()].slice(0, 80) };
      });
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [storageKey, stop]);
  useEffect(() => {
    const next = reconcileWritingNotes(latest.current.session.notes, sources);
    if (next.some((n, i) => n !== latest.current.session.notes[i])) {
      stop(); setSession(current => ({ ...current, notes: reconcileWritingNotes(current.notes, sources) }));
      setConfirmedProposal(false);
      setMessage("原文已变化，旧改写已失效。未变化的引用会重新定位，补充内容仍保留。");
    }
  }, [sources, stop]);
  useEffect(() => {
    if (agentSnapshot?.ready && !agentSnapshot.error) agent?.reconcileSources(sources.map(source => ({ key: writingTargetKey(source.targetRef), text: source.text })));
  }, [agent, agentSnapshot?.ready, agentSnapshot?.error, sources]);
  useEffect(() => {
    const editor = document.getElementById("resume-editor-panel");
    if (!editor || !active || session.mode === "paused") return;
    return observeResumeWriting(editor, (next, shouldCheck) => {
      setActivity(next);
      // Locating a quote focuses its whole textarea. That focus must not replace
      // the explicitly selected quote with the first note for the same field.
      setSelected(current => {
        const note = latest.current.session.notes.find(item => item.id === current);
        return note && writingTargetKey(note.source.targetRef) === next.key && note.source.text === next.text ? current : undefined;
      });
      if (!shouldCheck) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { if (latest.current.active && latest.current.session.mode === "proactive") check([next.key]); }, 1800);
    });
  }, [active, session.mode]);
  useEffect(() => {
    if (!active || session.mode !== "proactive") return;
    const initial = setTimeout(() => check(), 1800);
    return () => clearTimeout(initial);
  }, [active, session.mode]);
  useEffect(() => { if (session.mode === "paused") stop(); if (!active || session.mode === "paused") clearTimeout(timer.current); }, [active, session.mode, stop]);
  useEffect(() => { stop(); setShareAgentMemory(false); }, [config.provider, config.baseUrl, config.model, config.apiKey, stop]);
  useEffect(() => { stop(); setConfirmedAnswer(false); setShareProjectContext(false); setShareAgentMemory(false); }, [agentKind, chatGptChoice.profileId, chatGptChoice.model, routing?.policy?.revision, stop]);
  useEffect(() => {
    if (!active || session.mode !== "proactive" || !session.autoLocalModel || !canAutoModel || !focusedNote || focusedNote.autoAsked || focusedNote.answer || focusedNote.questions) return;
    changeNote(focusedNote.id, { autoAsked: true });
    const key = writingTargetKey(focusedNote.source.targetRef), now = Date.now();
    if (now - (autoBudget.current.get(key) ?? 0) < 60000) return;
    autoBudget.current.set(key, now);
    void autoAsk.current(focusedNote, false);
  }, [active, session.mode, session.autoLocalModel, canAutoModel, focusedNote]);
  useEffect(() => { alive.current = true; const generation = epoch; return () => { alive.current = false; generation.current++; request.current?.controller.abort(); clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    if (request.current && request.current.noteId !== focusedNote?.id) stop();
    setConfirmedAnswer(false); setConfirmedProposal(false); setShareProjectContext(false); setExpanded(pendingExpand.current === focusedNote?.id && !!focusedNote?.id); pendingExpand.current = undefined; setMessage("");
  }, [focusedNote?.id, stop]);

  function mode(value: WritingMode) { stop(); setSession(s => ({ ...s, mode: value })); }
  async function ask(note: WritingNote, openOnReturn = true) {
    stop(); setMessage(""); setConfirmedProposal(false);
    if (routing?.blocked) { setMessage("本账号底座状态尚未确认；请刷新模型与工具。未使用旧 API 配置补发。"); return; }
    if (!routing?.enabled && agentKind === "chatgpt" && !chatGptReady) { setMessage("请先完成 ChatGPT 授权、选择可用模型并检查额度状态；不会改用当前 API 配置。"); return; }
    if (note.answer.trim() && !confirmedAnswer) { setMessage("请先核对补充内容是否真实；它不会自动变成已核实事实。"); return; }
    const controller = new AbortController(), id = ++epoch.current;
    request.current = { controller, id, noteId: note.id }; setBusy(true);
    const timeout = setTimeout(() => controller.abort("timeout"), 120000);
    try {
      let context: ConfirmedWritingProjectContext | undefined;
      if (shareProjectContext && usableContext) {
        const fresh = await understandingClient.getSession(usableContext.sessionId, controller.signal);
        context = confirmedWritingProjectContext(fresh);
        if (!context || fresh.sourceText !== writingOriginal(note.source) || context.revision !== usableContext.revision || context.summaryHash !== usableContext.summaryHash) {
          setShareProjectContext(false);
          throw new WritingReplyError("项目理解已变化或需要重新确认，本次未发送伴写请求。请打开项目理解核对最新版本；个人补充仍保留。");
        }
      }
      const produce = async (signal: AbortSignal, sharedText?: string) => {
        routing?.assertSelected();
        const nativeReply = async () => {
          const messages = writingMessages(note.source, note.answer, context, sharedText);
          const reply = await routing!.respond(messages.filter(message => message.role === "system").map(message => message.content).join("\n"), messages.filter(message => message.role === "user").map(message => ({ role: "user" as const, content: message.content })), signal);
          signal.throwIfAborted(); return parseWritingReply(reply.text, note.source, note.answer);
        };
        const result = await (routing?.enabled ? nativeReply() : agentKind === "chatgpt"
          ? generateChatGptWritingReply(chatGptClient, chatGptChoice, note.source, note.answer, signal, context, sharedText)
          : generate(config, note.source, note.answer, signal, undefined, context, sharedText));
        if (context) {
          const fresh = await understandingClient.getSession(context.sessionId, signal);
          const confirmed = confirmedWritingProjectContext(fresh);
          if (!confirmed || fresh.sourceText !== writingOriginal(note.source) || confirmed.revision !== context.revision || confirmed.summaryHash !== context.summaryHash) {
            setShareProjectContext(false);
            throw new WritingReplyError("生成期间项目理解或授权已变化，未采用迟到候选；你的补充仍保留，请重新核对背景。");
          }
        }
        return result; // Validate before the shared Agent records a successful result.
      };
      const taskId = crypto.randomUUID(); sharedTask.current = taskId;
      const reply = agent ? await agent.run({ id: taskId, origin: "writing", label: `伴写 · ${note.source.label}`, destination: routing?.enabled ? agentBaseLabel(routing.policy) : agentKind === "chatgpt" ? `ChatGPT · ${chatGptChoice.model}` : `${config.provider} · ${config.model}`,
        input: [writingOriginal(note.source), note.answer].filter(Boolean).join("\n补充："), shareMemories: shareAgentMemory },
        (signal, shared) => produce(AbortSignal.any([signal, controller.signal]), shared.text), value => [value.rationale, ...value.questions, value.proposedText].filter(Boolean).join("\n"))
        : await produce(controller.signal);
      const current = latest.current.session.notes.find(n => n.id === note.id);
      const source = latest.current.sources.find(s => writingTargetKey(s.targetRef) === writingTargetKey(note.source.targetRef));
      if (epoch.current !== id || controller.signal.aborted || current?.state !== "open" || current.answer !== note.answer || source?.text !== note.source.text) return;
      changeNote(note.id, { questions: reply.questions, rationale: reply.rationale, proposedText: note.answer.trim() ? reply.proposedText : undefined, evidenceQuotes: reply.evidenceQuotes });
      if (openOnReturn) setExpanded(true);
    } catch (error) {
      if (epoch.current === id) setMessage(controller.signal.aborted
        ? "本次分析等待超时，原文和补充已保留。可重试，或先根据本地追问继续写。"
        : error instanceof WritingReplyError || error instanceof ChatGptClientError || error instanceof AgentRoutingClientError ? error.message : "模型暂时没有给出可核对的完整建议。原文未改动；可以重试或按本地追问自行补充。");
    } finally { clearTimeout(timeout); if (epoch.current === id) { request.current = null; sharedTask.current = undefined; setBusy(false); } }
  }
  autoAsk.current = ask;
  async function apply(note: WritingNote, undo = false) {
    stop();
    const proposal = writingProposal(note, undo);
    if (!proposal || writeLock.current || (!undo && !confirmedProposal)) return;
    writeLock.current = true; setApplying(true);
    try {
      const result = await onApply(proposal);
      if (!alive.current) return;
      setMessage(result.ok && undo ? "已撤销这次伴写修改，恢复了修改前的原文；其他字段保持不变。" : result.message);
      if (result.ok) { changeNote(note.id, { state: undo ? "dismissed" : "applied" }); setConfirmedProposal(false); if (!undo) agent?.track({ id: `writing-applied:${note.id}`, kind: "resume-applied", label: `${note.source.label}：本人采用了一条表达建议，未自动认证能力。`, origin: "writing" }); }
    } catch { if (alive.current) setMessage("本次修改未能确认保存，请先检查原文与保存状态；你的补充和候选仍在，不会自动重试写入。"); }
    finally { writeLock.current = false; if (alive.current) setApplying(false); }
  }
  function dismiss(note: WritingNote) { stop(); changeNote(note.id, { state: "dismissed" }); setExpanded(false); }
  function revealPreview(note: WritingNote) {
    cancelAnimationFrame(revealFrame.current);
    // Wait for a selected card or revealed workspace to commit its layout.
    revealFrame.current = requestAnimationFrame(() => { if (shell.current) revealWritingPreview(shell.current, note.source); });
  }
  function locate(note: WritingNote) {
    onFocus(note.source);
    revealPreview(note);
    if (sidebar && window.matchMedia("(max-width: 840px), (max-height: 500px)").matches) {
      sidebar.hide(); requestAnimationFrame(() => focusWritingSource(note.source)); return;
    }
    if (!focusWritingSource(note.source)) setMessage("已定位到对应经历；如果要点已折叠，请展开后编辑。");
  }
  function selectNote(note: WritingNote, keyboard: boolean) {
    if (busy || understandingRunning || applying) return;
    setKeyboardNavigation(keyboard); setSelected(note.id); setExpanded(false);
    setConfirmedAnswer(false); setConfirmedProposal(false); setShareProjectContext(false);
    // Paging is browsing, not editing: retain keyboard focus and the mobile
    // sidebar. The explicit Locate action still opens the matching editor.
    revealPreview(note);
  }

  return <div ref={shell} data-writing-annotations={geometry?.annotations.length ? "true" : undefined} className={`writing-shell ${sidebar ? "is-docked" : showAgentPane ? "has-agent-pane" : ""} ${compactHint ? "is-agent-idle" : ""}`} onMouseUpCapture={() => { if (shell.current) { const next = readWritingPreviewSelection(shell.current, sources); if (next) setActivity(next); } }} onKeyUpCapture={() => { if (shell.current) { const next = readWritingPreviewSelection(shell.current, sources); if (next) setActivity(next); } }}>
    <AgentSurface name="writing"><div className="writing-toolbar no-print">
      <span className="writing-brand"><Bot size={15} /> {t("简历伴写", "Writing copilot")}</span>
      {!sidebar && <AgentContinuityButton compact />}
      {sidebar && <button type="button" onClick={() => sidebar.show("settings")} aria-label={t("伴写设置", "Copilot settings")}><Settings2 size={14} /></button>}
      <AgentSurface name="writing-settings"><details open={sidebar ? true : undefined} className="writing-settings" onKeyDown={event => {
        if (!sidebar && event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); event.stopPropagation(); }
      }} onBlur={event => { if (!sidebar && !event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}>
      <summary><Settings2 size={13} />{routing?.enabled ? agentBaseLabel(routing.policy) : agentKind === "chatgpt" ? t("ChatGPT 账号授权", "ChatGPT account") : t("当前配置模型", "Configured model")}<span>{t(" · 设置", " · Settings")}</span></summary>
      <div className="writing-settings-body" role="group" aria-label={t("伴写设置与授权", "Copilot settings & access")}>
      {!sidebar && routing?.enabled && <p>底座来源与备援在 BetterMe Agent 的「模型与工具」中统一设置；当前：{agentBaseLabel(routing.policy)}。</p>}
      {!sidebar && !routing?.enabled && <label>{t("Agent 来源", "Agent source")}
      <select aria-label={t("伴写 Agent 来源", "Writing Agent source")} value={agentKind} disabled={understandingRunning || busy} onChange={event => {
        stop(); const next = event.target.value === "chatgpt" ? "chatgpt" : "current"; setAgentKind(next);
        try { localStorage.setItem(`betterme.writing-agent.v1:${sessionKey}`, next); } catch { setStorageError(t("Agent 选择暂未保存；不会自动更换当前来源。", "Agent selection could not be saved; current source remains unchanged.")); }
      }}><option value="current">{t("当前配置模型", "Configured model")}</option><option value="chatgpt">{t("ChatGPT 账号授权", "ChatGPT account")}</option></select></label>}
      <label>{t("参与方式", "Mode")}
      <select aria-label={t("伴写参与方式", "Copilot mode")} value={session.mode} onChange={e => mode(e.target.value as WritingMode)}>
        <option value="proactive">{t("主动提醒 · 本地", "Proactive · Local")}</option><option value="quiet">{t("安静 · 手动检查", "Quiet · Manual check")}</option><option value="paused">{t("暂停伴写", "Paused")}</option>
      </select></label>
      {canAutoModel && <label className="writing-check" title={t("允许停笔后仅将当前条目发送给所配置的本机 Ollama 接口作一次追问。实际推理位置取决于该模型配置；补充和改写仍由你发起。", "After you pause typing, send only the current item to your configured local Ollama endpoint for one follow-up question.")}><input type="checkbox" checked={session.autoLocalModel ?? false} onChange={e => { stop(); setSession(s => ({ ...s, autoLocalModel: e.target.checked })); }} />{t("允许本机模型主动追问", "Allow local model follow-ups")}</label>}
      <AgentMemoryConsent scope="writing" checked={shareAgentMemory} onChange={value => { if (!value) stop(); setShareAgentMemory(value); }} />
      </div>
      </details></AgentSurface>
      <button data-agent-guide="writing-check" onClick={() => { check(); setExpanded(false); setAgentCollapsed(false); sidebar?.show("conversation", "writing"); }} disabled={session.mode === "paused"}><Sparkles size={13} />{t("检查当前简历", "Review resume")}</button>
      {selectionQuote && <button onClick={checkSelection} disabled={session.mode === "paused"}>{t("完善选中文字", "Polish selection")}</button>}
      <span className="writing-count">{session.mode === "paused" ? <><Pause size={13} />{t("已暂停", "Paused")}</> : t(`${notes.length} 条待完善`, `${notes.length} to refine`)}</span>
      {(busy || understandingRunning) && <span className="writing-running" role="status">{understandingRunning ? t("项目理解中", "Understanding project") : t("伴写分析中", "Analyzing")}</span>}
      {!sidebar && understandingSource && <button type="button" disabled={understandingRunning} onClick={() => setUnderstandingSource(undefined)}>{t("返回伴写建议", "Back to suggestions")}</button>}
      <button ref={collapseButton} type="button" className="writing-collapse" aria-label={showAgentPane ? t("收起 Agent 对话", "Collapse Agent chat") : t("展开 Agent 对话", "Expand Agent chat")} aria-controls={agentPaneId} aria-expanded={showAgentPane} disabled={!hasAgentContent}
        onClick={() => showAgentPane ? collapseAgent() : sidebar ? sidebar.show("conversation", "writing") : setAgentCollapsed(false)}>{showAgentPane ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{showAgentPane ? t("收起对话", "Hide chat") : t("展开对话", "Show chat")}</button>
    </div></AgentSurface>
    <AgentSurface name="writing"><div id={agentPaneId} className="writing-agent-pane no-print" hidden={!sidebar && !showAgentPane}>
    <div className={`writing-agent-scroll${understandingSource ? " has-project-understanding" : expanded && focusedNote ? " has-writing-review" : ""}`} role="region" aria-label="Agent 对话与历史" tabIndex={0}>
    <div className="writing-status no-print">
      {sidebar && !hasAgentContent && <p className="writing-message">{t("从简历页点击“检查当前简历”开始；资料不会自动发送给模型。", "Click \"Review resume\" on the resume page to start; your data is never sent automatically.")}</p>}
      {agentKind === "chatgpt" && !routing?.enabled && !sidebar && <ChatGptAgentControls value={chatGptChoice} onChange={choice => { stop(); setChatGptChoice(choice); }} onReady={setChatGptReady} client={chatGptClient} disabled={busy || understandingRunning} />}
      {storageError && <p className="writing-message" role="status">{storageError}</p>}
      {message && <p className="writing-message" role="status">{message}</p>}
      {understandingSource && liveUnderstandingSource && understandingOriginal !== undefined && <div ref={understandingCard} className="writing-understanding-anchor"><nav className="writing-understanding-navigation" aria-label={t("当前项目导航", "Current project navigation")}>{sidebar && <button type="button" className="writing-return" disabled={understandingRunning} onClick={() => setUnderstandingSource(undefined)}><ChevronLeft size={14} />{t("返回伴写建议", "Back to suggestions")}</button>}<button type="button" className="writing-source" onClick={() => { onFocus(liveUnderstandingSource); if (sidebar && window.matchMedia("(max-width: 840px), (max-height: 500px)").matches) sidebar.hide(); focusWritingSource(liveUnderstandingSource); }}>{t("定位原文", "Locate source")} · {liveUnderstandingSource.label}</button></nav><ProjectUnderstandingPanel
        key={writingTargetKey(understandingSource.targetRef)} workspaceKey={sessionKey} projectKey={writingTargetKey(understandingSource.targetRef)}
        label={liveUnderstandingSource.label} sourceText={understandingOriginal} config={config} client={understandingClient}
        chatGpt={agentKind === "chatgpt" ? { ...chatGptChoice, ready: chatGptReady } : undefined}
        onRunningChange={setUnderstandingRunning}
        onContribution={(supplement, context, question) => {
          const targetKey = writingTargetKey(understandingSource.targetRef);
          const note = latest.current.session.notes.find(item => item.state === "open" && writingTargetKey(item.source.targetRef) === targetKey && writingOriginal(item.source) === understandingOriginal);
          const source = latest.current.sources.find(item => writingTargetKey(item.targetRef) === targetKey);
          if (!note || source?.text !== note.source.text) throw new Error("简历字段已变化，未带入补充，请重新核对原文。");
          const answer = note.answer.includes(supplement) ? note.answer : [note.answer, supplement].filter(Boolean).join("\n\n");
          if (answer.length > 6000) throw new Error("现有补充加上贡献记录超过长度上限，未覆盖原输入；请先整理伴写补充。");
          stop();
          setProjectContexts(current => ({ ...current, [targetKey]: { sourceText: understandingOriginal, context } }));
          changeNote(note.id, { answer, proposedText: undefined, evidenceQuotes: undefined, questions: [question], rationale: undefined });
          setSelected(note.id); setUnderstandingSource(undefined); setExpanded(true); setAgentCollapsed(false);
          setConfirmedAnswer(false); setConfirmedProposal(false); setShareProjectContext(false);
          setMessage("已追加本人确认的贡献补充；尚未发送模型或修改简历。请核对后生成候选。");
        }}
        onClose={collapseAgent} onConfirmed={context => {
          const key = writingTargetKey(understandingSource.targetRef);
          if (!context) setShareProjectContext(false);
          setProjectContexts(current => {
            if (context) return { ...current, [key]: { sourceText: understandingOriginal, context } };
            if (!current[key]) return current;
            const next = { ...current }; delete next[key]; return next;
          });
        }} /></div>}
      {applied && <div className="writing-applied"><Check size={14} />{t("已采用一条表达建议", "Applied 1 writing suggestion")}<button onClick={() => void apply(applied, true)}><RotateCcw size={12} />{t("撤销这次修改", "Undo change")}</button></div>}
      {!!archived.length && <details className="writing-archive"><summary>{t(`已处理与历史批注（${archived.length}）`, `History & resolved notes (${archived.length})`)}</summary>{archived.map(note => {
        const current = sources.find(s => writingTargetKey(s.targetRef) === writingTargetKey(note.source.targetRef));
        return <article key={note.id}><strong>{note.source.label} · {note.state === "applied" ? t("已采用", "Applied") : note.state === "stale" ? t("原文已变化", "Source changed") : t("已收起", "Dismissed")}</strong><blockquote>{writingOriginal(note.source).slice(0, 180)}</blockquote>{note.answer && <p>{t("你的补充：", "Your input: ")}{note.answer}</p>}{current && note.state !== "applied" && <button onClick={() => {
          stop(); const restored = newWritingNote(current, inspectWriting(current, sources) ?? note.issue);
          restored.answer = note.answer;
          setSession(s => ({ ...s, notes: [restored, ...s.notes].slice(0, 80) })); setSelected(restored.id);
        }}>{t("重新完善这条（保留补充）", "Refine again (keep input)")}</button>}</article>;
      })}</details>}
    </div>
    {visible && !understandingSource && annotations.length > 1 && <nav ref={noteIndex} className="writing-note-index" data-compact={expanded ? "true" : undefined} aria-label={t("按颜色与编号定位批注", "Locate notes by color and number")}>
      {annotations.map(annotation => <button type="button" key={annotation.id} data-annotation-id={annotation.id} data-annotation-tone={annotation.tone}
        aria-label={t(`批注 ${annotation.number}：${annotation.source.label}`, `Note ${annotation.number}: ${annotation.source.label}`)} title={`${annotation.number} · ${annotation.source.label}`}
        aria-pressed={annotation.id === focusedNote?.id} disabled={busy || understandingRunning || applying}
        onClick={event => { const note = notes.find(item => item.id === annotation.id); if (note) selectNote(note, event.detail === 0); }}>{annotation.number}</button>)}
    </nav>}
    {visible && focusedNote && <aside ref={card} tabIndex={-1} className="writing-note no-print" data-agent-guide="writing-note" data-annotation-tone={focusedAnnotation?.tone} data-keyboard={keyboardNavigation ? "true" : undefined} aria-label={t("Agent 伴写批注", "Agent writing note")} key={focusedNote.id} hidden={Boolean(understandingSource)}>
      <div className="writing-note-context">
      <header><span><span className="writing-note-number">{focusedAnnotation?.number}</span><Bot size={14} />{busy ? t("正在分析这条内容", "Analyzing this entry") : t("当前批注", "Current note")}</span>{sidebar && <button type="button" className="writing-guide-trigger" onClick={() => sidebar.learn("annotation")}>{t("旁批协作教程", "Note guide")}</button>}{busy && <button aria-label={t("停止当前伴写分析", "Stop current analysis")} onClick={() => { stop(); setMessage("已停止分析，补充内容留在输入框中。"); }}><Square size={12} />{t("停止", "Stop")}</button>}<button aria-label={t("本条不再提示", "Dismiss this note")} onClick={() => dismiss(focusedNote)}><X size={14} /></button></header>
      <button className="writing-source" onClick={() => locate(focusedNote)} title={focusedNote.source.label}><span>{focusedNote.source.label}</span><LocateFixed size={13} />{t("定位", "Locate")}</button>
      {geometry && geometry.visibility !== "visible" && <button type="button" className="writing-source-location" onClick={() => locate(focusedNote)}><LocateFixed size={13} />{geometry.visibility === "above" ? t("原文在预览上方 · 点击定位", "Source above · Locate") : geometry.visibility === "below" ? t("原文在预览下方 · 点击定位", "Source below · Locate") : t("原文未在当前预览显示 · 定位编辑字段", "Source outside this preview · Locate editor")}</button>}
      <nav className="agent-flow-status" aria-label={t("伴写协作进度", "Writing workflow")}><span>{t("项目共识", "Project context")}</span><span aria-current={!focusedNote.proposedText ? "step" : undefined}>{t("本人补充", "Your input")}</span><span aria-current={focusedNote.proposedText ? "step" : undefined}>{t("核对候选", "Review draft")}</span><span>{t("采用与撤销", "Apply & undo")}</span></nav><h3>{focusedNote.issue.title}</h3>
      <blockquote>{writingOriginal(focusedNote.source).slice(0, 180) || t("这条要点还是空白，可以先描述一件实际做过的事。", "This bullet is still empty—start by describing something you actually did.")}{writingOriginal(focusedNote.source).length > 180 ? "…" : ""}</blockquote>
      {focusedNote.source.quote && <small>{t("只完善所选片段，周围内容保持不变", "Only refines the selected phrase; surrounding text stays unchanged")}</small>}
      <div className="writing-note-actions"><button type="button" data-agent-guide="understanding-start" onClick={() => { stop(); setUnderstandingSource(focusedNote.source); }}>{t("先对齐项目理解", "Align project context")}</button>{!expanded && <button className="writing-primary" onClick={() => setExpanded(true)}>{t("一起完善这条经历", "Refine this entry together")}</button>}</div>
      </div>
      {expanded && <div className="writing-review">
        <div className="writing-review-body" role="region" aria-label="伴写建议与修改对照" tabIndex={0}>
        {(focusedNote.questions?.length ? focusedNote.questions : [focusedNote.issue.question]).map((question, index) => <p className="writing-question" key={index}>{question}</p>)}
        <details className="writing-send-details"><summary>本次发送范围与授权</summary><small>发送本条原文、本人补充{shareProjectContext && usableContext ? "及已确认项目术语背景" : ""}。不自动附带姓名、联系方式或其他简历字段；共享记忆由「模型与工具」中的简历伴写开关单独控制。项目共识、文件只读授权、本人贡献确认不能互相代替。请勿填入敏感信息。</small></details>
        {focusedNote.rationale && <p>{focusedNote.rationale}</p>}
        {focusedNote.answer.trim() && !focusedNote.proposedText && <button disabled={!confirmedAnswer} onClick={() => { stop(); changeNote(focusedNote.id, { proposedText: focusedNote.answer.trim(), evidenceQuotes: [focusedNote.answer.trim()], rationale: "候选直接来自你本人核对的补充，未由模型扩写；请继续检查表达和事实。" }); setConfirmedProposal(false); }}>用我的补充作为可编辑草稿</button>}
        {focusedNote.proposedText && <section className="writing-diff" aria-label="修改对照">
          <label>原文</label><del>{writingOriginal(focusedNote.source)}</del>
          <label htmlFor="writing-proposal">候选表达 · 可继续编辑</label>
          <textarea id="writing-proposal" rows={4} maxLength={12000} value={focusedNote.proposedText} onChange={e => { stop(); changeNote(focusedNote.id, { proposedText: e.target.value, evidenceQuotes: undefined }); setConfirmedProposal(false); }} />
          <details className="writing-candidate-evidence" open><summary>候选引用依据 · 请逐句核对</summary>{focusedNote.evidenceQuotes?.length ? focusedNote.evidenceQuotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>) : <p>候选已手动编辑或没有保留引用，请重新核对与原文、本人补充是否一致。</p>}<small>引用已校验来自本条原文或你的补充；这不是外部事实认证，也不能证明候选每句话都成立。项目代码、设计方案与 Agent 猜测不作为个人成果依据。</small></details>
          <label className="writing-check"><input type="checkbox" checked={confirmedProposal} onChange={e => setConfirmedProposal(e.target.checked)} />我已逐字核对，没有夸大或新增不实事实</label>
          <button className="writing-primary" disabled={applying || !confirmedProposal || !focusedNote.proposedText.trim()} onClick={() => void apply(focusedNote)}>{applying ? "正在保护版本并保存…" : "确认采用到简历"}</button>
          <small>仅替换这一字段，不改变事实核实状态。手动编辑原文后本建议失效。</small>
        </section>}
        <button onClick={collapseAgent}>收起，继续写</button>
        </div>
        <div className="writing-review-compose" role="region" aria-label="伴写输入">
          <label htmlFor="writing-answer">补充你实际做过的事情</label>
          <textarea id="writing-answer" data-agent-guide="writing-answer" rows={2} maxLength={6000} value={focusedNote.answer} placeholder="可以说不知道或没有数据，不需要编造结果。" onChange={e => { stop(); changeNote(focusedNote.id, { answer: e.target.value, proposedText: undefined, evidenceQuotes: undefined }); setConfirmedAnswer(false); setConfirmedProposal(false); }} />
          {focusedNote.answer.trim() && <label className="writing-check"><input type="checkbox" checked={confirmedAnswer} onChange={e => setConfirmedAnswer(e.target.checked)} />我确认这段补充来自实际经历</label>}
          {usableContext && <label className="writing-check"><input type="checkbox" checked={shareProjectContext} onChange={event => { stop(); setShareProjectContext(event.target.checked); }} />本次携带已确认项目共识（仅术语和边界，不证明个人贡献）</label>}
          <small>发送至：{routing?.enabled ? agentBaseLabel(routing.policy) : agentKind === "chatgpt" ? `ChatGPT · ${chatGptChoice.model || "未选择模型"}` : `${config.provider} · ${config.model || "未配置"}`}{shareAgentMemory ? " · 简历伴写记忆已授权" : " · 未共享记忆"}</small>
          {busy ? <button className="writing-primary" onClick={() => { stop(); setMessage("已停止分析，补充内容留在输入框中。"); }}><Square size={12} />停止分析</button> : <button className="writing-primary" onClick={() => void ask(focusedNote)} disabled={!routing?.enabled && agentKind === "chatgpt" && !chatGptReady || !!focusedNote.answer.trim() && !confirmedAnswer}>{focusedNote.answer.trim() ? "请 Agent 整理候选表达" : "请 Agent 进一步追问"}</button>}
        </div>
      </div>}
      {notes.length > 1 && <footer><button aria-label="上一条批注" disabled={busy || understandingRunning || applying} onClick={event => selectNote(notes[(notes.indexOf(focusedNote) - 1 + notes.length) % notes.length]!, event.detail === 0)}><ChevronLeft size={13} /></button><span>{t(`第 ${focusedAnnotation?.number} 条 / 共 ${notes.length} 条`, `Note ${focusedAnnotation?.number} / ${notes.length}`)}</span><button aria-label="下一条批注" disabled={busy || understandingRunning || applying} onClick={event => selectNote(notes[(notes.indexOf(focusedNote) + 1) % notes.length]!, event.detail === 0)}><ChevronRight size={13} /></button></footer>}
    </aside>}
    </div>
    </div></AgentSurface>
    <div className="writing-document">{children}</div>
    {visible && geometry && geometry.annotations.length > 0 && createPortal(<svg className="writing-overlay no-print" data-keyboard={keyboardNavigation ? "true" : undefined} aria-hidden="true">
      {geometry.annotations.map(annotation => <g key={annotation.id} data-annotation-id={annotation.id} data-annotation-tone={annotation.tone} data-active={annotation.active ? "true" : undefined}>
        {annotation.lines.map((line, index) => <rect className="writing-annotation-highlight" key={index} {...line} rx="3" />)}
        {annotation.active && geometry.path && <><path className="writing-connector-halo" d={geometry.path} pathLength="1" /><path className="writing-connector" d={geometry.path} pathLength="1" /><circle className="writing-connector-end" cx={geometry.tx} cy={geometry.ty} r="4" /></>}
        <circle className="writing-annotation-badge" cx={annotation.badge.x} cy={annotation.badge.y} r={annotation.active ? 11 : 9} />
        <text className="writing-annotation-number" x={annotation.badge.x} y={annotation.badge.y} dy=".35em" textAnchor="middle">{annotation.number}</text>
        {annotation.active && <circle key={annotation.id} className="writing-annotation-ping" cx={annotation.badge.x} cy={annotation.badge.y} r="14" />}
      </g>)}
    </svg>, document.body)}
  </div>;
}
import { privateStorage as localStorage, privateStorageEvent } from "../lib/identity";
