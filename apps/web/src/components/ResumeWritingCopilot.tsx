import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, ChevronLeft, ChevronRight, Pause, RotateCcw, Sparkles, Square, X } from "lucide-react";
import type { LlmConfig } from "@better-me/core";
import {
  generateWritingReply, inspectWriting, isLocalWritingModel, newWritingNote, readWritingSession, reconcileWritingNotes,
  saveWritingSession, writingTargetKey, writingOriginal, writingProposal, WritingReplyError, type WritingMode, type WritingNote, type WritingSource,
} from "../lib/resume-copilot";
import type { ResumeProposalWrite } from "../lib/resume-agent-context";
import { focusWritingSource, observeResumeWriting, readWritingPreviewSelection, useWritingGeometry, type WritingActivity } from "../lib/resume-writing-observer";
import { quoteWritingText } from "../lib/writing-anchor";
import "./resume-writing-copilot.css";

type Props = {
  sessionKey: string; sources: WritingSource[]; config: LlmConfig; active: boolean; children: ReactNode;
  onApply: (proposal: ResumeProposalWrite) => Promise<{ ok: boolean; message: string }>;
  onFocus: (source: WritingSource) => void;
  generate?: typeof generateWritingReply;
};

/** Owns the review session, never the resume. Writes cross the existing approved CAS interface. */
export function ResumeWritingCopilot({ sessionKey, sources, config, active, onApply, onFocus, children, generate = generateWritingReply }: Props) {
  return <WritingCopilotSession key={sessionKey} {...{ sessionKey, sources, config, active, onApply, onFocus, children, generate }} />;
}

function WritingCopilotSession({ sessionKey, sources, config, active, onApply, onFocus, children, generate = generateWritingReply }: Props) {
  const storageKey = `betterme.writing.v1:${sessionKey}`;
  const [session, setSession] = useState(() => readWritingSession(localStorage, storageKey));
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [confirmedAnswer, setConfirmedAnswer] = useState(false);
  const [confirmedProposal, setConfirmedProposal] = useState(false);
  const [activity, setActivity] = useState<WritingActivity>();
  const shell = useRef<HTMLDivElement>(null), card = useRef<HTMLElement>(null);
  const latest = useRef({ session, sources, config, active }); latest.current = { session, sources, config, active };
  const request = useRef<{ controller: AbortController; id: number; noteId: string } | null>(null);
  const autoAsk = useRef<(note: WritingNote, open: boolean) => Promise<void>>(async () => {});
  const autoBudget = useRef(new Map<string, number>());
  const epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writeLock = useRef(false), alive = useRef(true);
  const pendingExpand = useRef<string | undefined>(undefined);
  const notes = session.notes.filter(n => n.state === "open");
  const firstSourceWithNote = sources.find(source => notes.some(note => writingTargetKey(note.source.targetRef) === writingTargetKey(source.targetRef)));
  const focusedNote = notes.find(n => n.id === selected) ?? notes.find(n => writingTargetKey(n.source.targetRef) === activity?.key)
    ?? notes.find(n => firstSourceWithNote && writingTargetKey(n.source.targetRef) === writingTargetKey(firstSourceWithNote.targetRef)) ?? notes[0];
  const applied = session.notes.find(n => n.state === "applied" && sources.some(s => writingTargetKey(s.targetRef) === writingTargetKey(n.source.targetRef) && s.text === writingProposal(n)?.proposedText));
  const archived = session.notes.filter(n => n.state !== "open");
  const selectionSource = activity && sources.find(s => writingTargetKey(s.targetRef) === activity.key && s.text === activity.text);
  const selectionQuote = selectionSource && activity && quoteWritingText(selectionSource.text, activity.start, activity.end);
  const visible = active && session.mode !== "paused";
  const canAutoModel = isLocalWritingModel(config);
  const geometry = useWritingGeometry(shell, card, visible ? focusedNote?.source : undefined);

  function stop() { epoch.current++; request.current?.controller.abort(); request.current = null; setBusy(false); }
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
    pendingExpand.current = note.id; setSelected(note.id); setExpanded(true);
  }
  useEffect(() => {
    try { saveWritingSession(localStorage, storageKey, session); setStorageError(""); }
    catch { setStorageError("伴写记录暂未保存（浏览器空间不足或存储受限）。简历仍由原保存流程保护，请勿关闭页面以免丢失追问进度。"); }
  }, [session, storageKey]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      stop(); setSession(current => {
        const remote = readWritingSession(localStorage, storageKey);
        const merged = new Map(current.notes.map(note => [note.id, note]));
        for (const note of remote.notes) if (!merged.has(note.id) || merged.get(note.id)!.updatedAt <= note.updatedAt) merged.set(note.id, note);
        return { ...remote, notes: [...merged.values()].slice(0, 80) };
      });
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [storageKey]);
  useEffect(() => {
    const next = reconcileWritingNotes(latest.current.session.notes, sources);
    if (next.some((n, i) => n !== latest.current.session.notes[i])) {
      stop(); setSession(current => ({ ...current, notes: reconcileWritingNotes(current.notes, sources) }));
      setConfirmedProposal(false);
      setMessage("原文已变化，旧改写已失效。未变化的引用会重新定位，补充内容仍保留。");
    }
  }, [sources]);
  useEffect(() => {
    const editor = document.getElementById("resume-editor-panel");
    if (!editor || !active || session.mode === "paused") return;
    return observeResumeWriting(editor, (next, shouldCheck) => {
      setActivity(next);
      setSelected(undefined);
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
  useEffect(() => { if (!active || session.mode === "paused") { stop(); clearTimeout(timer.current); } }, [active, session.mode]);
  useEffect(() => { stop(); }, [config.provider, config.baseUrl, config.model, config.apiKey]);
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
    setConfirmedAnswer(false); setConfirmedProposal(false); setExpanded(pendingExpand.current === focusedNote?.id && !!focusedNote?.id); pendingExpand.current = undefined; setMessage("");
  }, [focusedNote?.id]);

  function mode(value: WritingMode) { stop(); setSession(s => ({ ...s, mode: value })); }
  async function ask(note: WritingNote, openOnReturn = true) {
    stop(); setMessage(""); setConfirmedProposal(false);
    if (note.answer.trim() && !confirmedAnswer) { setMessage("请先核对补充内容是否真实；它不会自动变成已核实事实。"); return; }
    const controller = new AbortController(), id = ++epoch.current;
    request.current = { controller, id, noteId: note.id }; setBusy(true);
    const timeout = setTimeout(() => controller.abort("timeout"), 120000);
    try {
      const reply = await generate(config, note.source, note.answer, controller.signal);
      const current = latest.current.session.notes.find(n => n.id === note.id);
      const source = latest.current.sources.find(s => writingTargetKey(s.targetRef) === writingTargetKey(note.source.targetRef));
      if (epoch.current !== id || controller.signal.aborted || current?.state !== "open" || current.answer !== note.answer || source?.text !== note.source.text) return;
      changeNote(note.id, { questions: reply.questions, rationale: reply.rationale, proposedText: note.answer.trim() ? reply.proposedText : undefined });
      if (openOnReturn) setExpanded(true);
    } catch (error) {
      if (epoch.current === id) setMessage(controller.signal.aborted
        ? "本次分析等待超时，原文和补充已保留。可重试，或先根据本地追问继续写。"
        : error instanceof WritingReplyError ? error.message : "模型暂时没有给出可核对的完整建议。原文未改动；可以重试或按本地追问自行补充。");
    } finally { clearTimeout(timeout); if (epoch.current === id) { request.current = null; setBusy(false); } }
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
      if (result.ok) { changeNote(note.id, { state: undo ? "dismissed" : "applied" }); setConfirmedProposal(false); }
    } catch { if (alive.current) setMessage("本次修改未能确认保存，请先检查原文与保存状态；你的补充和候选仍在，不会自动重试写入。"); }
    finally { writeLock.current = false; if (alive.current) setApplying(false); }
  }
  function dismiss(note: WritingNote) { stop(); changeNote(note.id, { state: "dismissed" }); setExpanded(false); }
  function locate(note: WritingNote) { onFocus(note.source); if (!focusWritingSource(note.source)) setMessage("已定位到对应经历；如果要点已折叠，请展开后编辑。"); }

  return <div ref={shell} className={`writing-shell ${visible && focusedNote ? "has-writing-note" : ""}`} onMouseUpCapture={() => { if (shell.current) { const next = readWritingPreviewSelection(shell.current, sources); if (next) setActivity(next); } }} onKeyUpCapture={() => { if (shell.current) { const next = readWritingPreviewSelection(shell.current, sources); if (next) setActivity(next); } }}>
    <div className="writing-toolbar no-print">
      <span className="writing-brand"><Bot size={15} /> 简历伴写</span>
      <select aria-label="伴写参与方式" value={session.mode} onChange={e => mode(e.target.value as WritingMode)}>
        <option value="proactive">主动提醒 · 本地</option><option value="quiet">安静 · 手动检查</option><option value="paused">暂停伴写</option>
      </select>
      <button onClick={() => { check(); setExpanded(false); }} disabled={session.mode === "paused"}><Sparkles size={13} />检查当前简历</button>
      {selectionQuote && <button onClick={checkSelection} disabled={session.mode === "paused"}>完善选中文字</button>}
      {canAutoModel && <label className="writing-check" title="允许停笔后仅将当前条目发送给所配置的本机 Ollama 接口作一次追问。实际推理位置取决于该模型配置；补充和改写仍由你发起。"><input type="checkbox" checked={session.autoLocalModel ?? false} onChange={e => { stop(); setSession(s => ({ ...s, autoLocalModel: e.target.checked })); }} />允许本机模型主动追问</label>}
      <span className="writing-count">{session.mode === "paused" ? <Pause size={13} /> : `${notes.length} 条待完善`}</span>
    </div>
    <div className="writing-status no-print">
      {storageError && <p className="writing-message" role="status">{storageError}</p>}
      {message && <p className="writing-message" role="status">{message}</p>}
      {applied && <div className="writing-applied"><Check size={14} />已采用一条表达建议<button onClick={() => void apply(applied, true)}><RotateCcw size={12} />撤销这次修改</button></div>}
      {!!archived.length && <details className="writing-archive"><summary>已处理与历史批注（{archived.length}）</summary>{archived.map(note => {
        const current = sources.find(s => writingTargetKey(s.targetRef) === writingTargetKey(note.source.targetRef));
        return <article key={note.id}><strong>{note.source.label} · {note.state === "applied" ? "已采用" : note.state === "stale" ? "原文已变化" : "已收起"}</strong><blockquote>{writingOriginal(note.source).slice(0, 180)}</blockquote>{note.answer && <p>你的补充：{note.answer}</p>}{current && note.state !== "applied" && <button onClick={() => {
          stop(); const restored = newWritingNote(current, inspectWriting(current, sources) ?? note.issue);
          restored.answer = note.answer;
          setSession(s => ({ ...s, notes: [restored, ...s.notes].slice(0, 80) })); setSelected(restored.id);
        }}>重新完善这条（保留补充）</button>}</article>;
      })}</details>}
    </div>
    <div className="writing-document">{children}</div>
    {visible && focusedNote && <aside ref={card} className="writing-note no-print" aria-label="Agent 伴写批注" key={focusedNote.id}>
      <header><span><Bot size={14} />{busy ? "正在分析这条内容" : "Agent 留意到"}</span>{busy && <button aria-label="停止当前伴写分析" onClick={() => { stop(); setMessage("已停止分析，补充内容留在输入框中。"); }}><Square size={12} />停止</button>}<button aria-label="本条不再提示" onClick={() => dismiss(focusedNote)}><X size={14} /></button></header>
      <button className="writing-source" onClick={() => locate(focusedNote)} title={focusedNote.source.label}>{focusedNote.source.label}</button>
      <h3>{focusedNote.issue.title}</h3>
      <blockquote>{writingOriginal(focusedNote.source).slice(0, 180) || "这条要点还是空白，可以先描述一件实际做过的事。"}{writingOriginal(focusedNote.source).length > 180 ? "…" : ""}</blockquote>
      {focusedNote.source.quote && <small>只完善所选片段，周围内容保持不变</small>}
      {!expanded ? <button className="writing-primary" onClick={() => setExpanded(true)}>一起完善这条经历</button> : <div className="writing-review">
        {(focusedNote.questions?.length ? focusedNote.questions : [focusedNote.issue.question]).map((question, index) => <p className="writing-question" key={index}>{question}</p>)}
        <label htmlFor="writing-answer">补充你实际做过的事情</label>
        <textarea id="writing-answer" rows={3} maxLength={6000} value={focusedNote.answer} placeholder="可以说不知道或没有数据，不需要编造结果。" onChange={e => { stop(); changeNote(focusedNote.id, { answer: e.target.value, proposedText: undefined }); setConfirmedAnswer(false); setConfirmedProposal(false); }} />
        {focusedNote.answer.trim() && <label className="writing-check"><input type="checkbox" checked={confirmedAnswer} onChange={e => setConfirmedAnswer(e.target.checked)} />我确认这段补充来自实际经历</label>}
        <small>点击后仅发送本条原文与补充给当前配置模型（{config.provider} · {config.model || "未配置"}），不附带姓名、联系方式字段或其他经历。请勿在补充中填入敏感信息。</small>
        {busy ? <button className="writing-primary" onClick={() => { stop(); setMessage("已停止分析，补充内容留在输入框中。"); }}><Square size={12} />停止分析</button> : <button className="writing-primary" onClick={() => void ask(focusedNote)} disabled={!!focusedNote.answer.trim() && !confirmedAnswer}>{focusedNote.answer.trim() ? "请 Agent 整理候选表达" : "请 Agent 进一步追问"}</button>}
        {focusedNote.rationale && <p>{focusedNote.rationale}</p>}
        {focusedNote.answer.trim() && !focusedNote.proposedText && <button disabled={!confirmedAnswer} onClick={() => { stop(); changeNote(focusedNote.id, { proposedText: focusedNote.answer.trim(), rationale: "候选直接来自你本人核对的补充，未由模型扩写；请继续检查表达和事实。" }); setConfirmedProposal(false); }}>用我的补充作为可编辑草稿</button>}
        {focusedNote.proposedText && <section className="writing-diff" aria-label="修改对照">
          <label>原文</label><del>{writingOriginal(focusedNote.source)}</del>
          <label htmlFor="writing-proposal">候选表达 · 可继续编辑</label>
          <textarea id="writing-proposal" rows={4} maxLength={12000} value={focusedNote.proposedText} onChange={e => { stop(); changeNote(focusedNote.id, { proposedText: e.target.value }); setConfirmedProposal(false); }} />
          <label className="writing-check"><input type="checkbox" checked={confirmedProposal} onChange={e => setConfirmedProposal(e.target.checked)} />我已逐字核对，没有夸大或新增不实事实</label>
          <button className="writing-primary" disabled={applying || !confirmedProposal || !focusedNote.proposedText.trim()} onClick={() => void apply(focusedNote)}>{applying ? "正在保护版本并保存…" : "确认采用到简历"}</button>
          <small>仅替换这一字段，不改变事实核实状态。手动编辑原文后本建议失效。</small>
        </section>}
        <button onClick={() => setExpanded(false)}>收起，继续写</button>
      </div>}
      {notes.length > 1 && <footer><button aria-label="上一条批注" onClick={() => { setSelected(notes[(notes.indexOf(focusedNote) - 1 + notes.length) % notes.length]!.id); setExpanded(false); }}><ChevronLeft size={13} /></button><span>{notes.indexOf(focusedNote) + 1} / {notes.length}</span><button aria-label="下一条批注" onClick={() => { setSelected(notes[(notes.indexOf(focusedNote) + 1) % notes.length]!.id); setExpanded(false); }}><ChevronRight size={13} /></button></footer>}
    </aside>}
    {visible && geometry && <svg className="writing-overlay no-print" aria-hidden="true">
      {geometry.lines.map((line, i) => <rect key={i} {...line} rx="3" />)}
      {geometry.path && <><path d={geometry.path} /><circle cx={geometry.x} cy={geometry.y} r="4" /></>}
    </svg>}
  </div>;
}
