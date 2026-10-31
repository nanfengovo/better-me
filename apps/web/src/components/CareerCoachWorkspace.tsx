import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import type { ResumeEditContext } from "@better-me/agent-contracts";
import { ArrowRight, BookOpen, Check, Compass, Download, MessageSquare, Settings2, ShieldCheck, Sparkles, Target, X } from "lucide-react";
import type { DrawerJobContext } from "./JdMatchDrawer";
import { findResumeContextSource, type ResumeProposalWrite } from "../lib/resume-agent-context";
import { generateCoach } from "../lib/career-coach/model";
import { addCoachRecord, addCoachSubmission, adoptCoachPlan, contextFingerprint, createCoachRecord, getCoachProgress, updateCoachTask } from "../lib/career-coach/state";
import { useCareerCoach } from "../lib/career-coach/use-career-coach";
import type { CoachRepository } from "../lib/career-coach/storage";
import type { CoachContext, CoachGenerate, CoachInterviewFeedback, CoachMode, CoachPlan, CoachRecord, CoachRequest, CoachSettings, CoachState, CoachSubmission, CoachTaskStatus } from "../lib/career-coach/types";
import "./career-coach-workspace.css";

export interface CareerCoachWorkspaceProps {
  workspaceKey: string;
  resumeEditContext?: ResumeEditContext;
  job: DrawerJobContext | null;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
  onApplyResumeProposal?: (proposal: ResumeProposalWrite) => Promise<{ ok: boolean; message?: string }>;
  generate?: CoachGenerate;
  repository?: CoachRepository;
}

const MODES = [
  { id: "analysis", title: "规划分析", subtitle: "找到适合的下一步", icon: Compass },
  { id: "resume", title: "修改建议", subtitle: "让真实经历更清晰", icon: Sparkles },
  { id: "plan", title: "学习方案", subtitle: "把目标拆成每周行动", icon: BookOpen },
  { id: "review", title: "学习监督", subtitle: "用证据复盘进展", icon: Target },
  { id: "interview", title: "模拟面试", subtitle: "一问一答，练习表达", icon: MessageSquare },
] as const;
const STATUS: Record<CoachTaskStatus, string> = { todo: "未开始", in_progress: "进行中", submitted: "已提交", self_completed: "本人自评完成" };
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试；原记录未被清除。";

function Points({ title, items }: { title: string; items: string[] }) {
  return items.length ? <div className="coach-points"><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null;
}
function Feedback({ value }: { value: CoachInterviewFeedback }) {
  return <div className="coach-feedback"><p>{value.summary}</p><Points title="回答中的优势" items={value.strengths} /><Points title="下一次可以改进" items={value.improvements} />
    <div className="coach-rubric">{value.rubric.map((item, index) => <div key={index}><strong>{item.criterion} · {item.score}/4</strong><p>{item.comment}</p></div>)}</div>
    <small>仅基于本次回答的模型练习反馈，不是能力认证或录用结论。</small></div>;
}
function PlanContent({ plan }: { plan: CoachPlan }) {
  return <><p>{plan.goal}</p><div className="coach-pill-row"><span>{plan.durationWeeks} 周</span><span>每周 ≤ {plan.weeklyHours} 小时</span><span>{plan.phases.flatMap((phase) => phase.tasks).length} 项任务</span></div>
    {plan.phases.map((phase, index) => <section className="coach-phase" key={index}><header><span className="coach-step">{String(index + 1).padStart(2, "0")}</span><div><h3>{phase.title}</h3><small>第 {phase.startWeek}–{phase.endWeek} 周 · {phase.objective}</small></div></header>
      {phase.tasks.map((task) => <details className="coach-task" key={task.id}><summary><span>第 {task.week} 周 · {task.title}</span><small>{task.minutes} 分钟</small></summary><p><strong>交付物：</strong>{task.deliverable}</p><Points title="验收条件" items={task.acceptanceCriteria} /><Points title="资源检索词（尚未联网核验）" items={task.resourceQueries} /></details>)}</section>)}
    <Points title="风险与调整" items={plan.risks} /><p className="coach-note">复盘节奏：{plan.reviewCadence}</p></>;
}

export function CareerCoachWorkspace(props: CareerCoachWorkspaceProps) {
  return <CareerCoachSession key={props.workspaceKey} {...props} />;
}

function CareerCoachSession({ workspaceKey, resumeEditContext, job, llmConfig, onOpenConfig, onApplyResumeProposal, generate = generateCoach, repository }: CareerCoachWorkspaceProps) {
  const { state, ready, persistenceError, conflict, update, reload, clear } = useCareerCoach(workspaceKey, repository);
  const [mode, setMode] = useState<CoachMode>("analysis");
  const [shareResume, setShareResume] = useState(false);
  const [shareJob, setShareJob] = useState(false);
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [evidence, setEvidence] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [taskId, setTaskId] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const requestRef = useRef<{ id: number; controller?: AbortController; busy: boolean }>({ id: 0, busy: false });
  const applyingRef = useRef(false);
  const appliedContextFingerprints = useRef(new Map<string, string>());
  const stateRef = useRef(state); stateRef.current = state;
  const context = useMemo<CoachContext>(() => ({ ...(shareResume && resumeEditContext ? { resume: resumeEditContext } : {}),
    ...(shareJob && job ? { job: { title: job.title, company: job.company, description: job.description, location: job.location } } : {}) }), [shareResume, resumeEditContext, shareJob, job]);
  const fingerprint = contextFingerprint(context);
  const scope = JSON.stringify([workspaceKey, mode, fingerprint, state.settings, llmConfig]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const contextRef = useRef(context); contextRef.current = context;
  const invalidate = (showNotice = false) => {
    const wasBusy = requestRef.current.busy;
    requestRef.current.controller?.abort();
    requestRef.current = { id: requestRef.current.id + 1, busy: false };
    setBusy(false);
    if (showNotice && wasBusy) setNotice("本次生成已取消，未采纳迟到结果；已提交的学习证据和面试回答仍保留。 ");
  };
  useEffect(() => {
    return () => { requestRef.current.controller?.abort(); requestRef.current = { id: requestRef.current.id + 1, busy: false }; };
  }, []);
  useEffect(() => {
    // Also catches externally changed resume/JD/configuration, not only button actions.
    if (requestRef.current.busy) invalidate(true);
    // The serialized scope deliberately includes settings and permission changes.
  }, [scope]);

  const mutate = (operation: (current: CoachState) => CoachState) => {
    try { update(operation); return true; } catch (failure) { setError(messageOf(failure)); return false; }
  };
  const changeSettings = (next: Partial<CoachSettings>) => { invalidate(true); mutate((current) => ({ ...current, settings: { ...current.settings, ...next } })); };
  const makeRequest = (targetMode: CoachMode, text = input): CoachRequest => ({ mode: targetMode, settings: stateRef.current.settings, input: text, context });
  const run = async (request: CoachRequest, apply?: (next: CoachState, record: CoachRecord) => CoachState) => {
    if (requestRef.current.busy || !ready || conflict) return;
    if (!request.settings.goal.trim()) { setError("请先填写本阶段目标，再开始这次任务。"); return; }
    if (!llmConfig.baseUrl.trim() || !llmConfig.model.trim() || (llmConfig.provider !== "ollama" && !llmConfig.apiKey.trim())) {
      setError("请先打开模型配置，填写服务地址、模型名称和所需 API Key；Ollama 本地模型可不填 Key。"); return;
    }
    const id = requestRef.current.id + 1;
    const controller = new AbortController();
    const requestScope = scopeRef.current;
    requestRef.current = { id, controller, busy: true }; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await generate(request, llmConfig, controller.signal);
      if (controller.signal.aborted || requestRef.current.id !== id || scopeRef.current !== requestScope) return;
      const record = createCoachRecord(result, request);
      update((current) => { const next = addCoachRecord(current, record); return apply ? apply(next, record) : next; });
      setSelectedRecordId("");
      if (request.mode === "analysis") setInput("");
      setNotice("已生成模型参考结果。需要采纳或修改的内容仍由你决定。");
    } catch (failure) {
      if (!controller.signal.aborted && requestRef.current.id === id && scopeRef.current === requestScope) setError(messageOf(failure));
    } finally { if (requestRef.current.id === id) { requestRef.current.busy = false; setBusy(false); } }
  };
  const modeRecords = [...state.records].reverse().filter((record) => record.mode === mode);
  const latest = modeRecords.find((record) => record.id === selectedRecordId) ?? modeRecords[0];
  const analysis = latest?.payload.kind === "analysis" ? latest.payload : undefined;
  const resume = latest?.payload.kind === "resume" ? latest.payload : undefined;
  const candidate = latest?.payload.kind === "plan" ? latest.payload : undefined;
  const tasks = state.activePlan?.plan.phases.flatMap((phase) => phase.tasks) ?? [];
  const selectedTask = tasks.find((task) => task.id === taskId) ?? tasks[0];
  const submissions = state.submissions.filter((item) => item.planId === state.activePlan?.id && item.taskId === selectedTask?.id);
  const progress = getCoachProgress(state);
  const interview = state.interview;
  const interviewChanged = Boolean(interview && interview.contextFingerprint !== fingerprint);
  const disabled = busy || !ready || conflict;
  const carryToPlan = (text: string) => {
    invalidate(true); setMode("plan"); setSelectedRecordId(""); setInput(text.slice(0, 12000));
    setNotice("已把这次结论放入学习重点。请先核对内容与授权，再点击生成；尚未发送或替换方案。");
  };

  const generateAnalysis = () => {
    const previous = latest?.mode === "analysis" ? latest.input : "";
    const combined = [previous, input].filter(Boolean).join("\n补充回答：");
    if (combined.length > 12000) { setError("本轮补充已超过 12000 字，请精简后重试。"); return; }
    void run({ ...makeRequest("analysis", combined), plan: state.activePlan?.plan });
  };
  const approve = async (record: CoachRecord, index: number) => {
    const proposal = record.payload.kind === "resume" ? record.payload.proposals[index] : undefined;
    const key = `${record.id}:${index}`;
    if (!proposal || applyingRef.current || disabled || decisions[key]) return;
    const expectedFingerprint = appliedContextFingerprints.current.get(record.id) ?? record.basis.contextFingerprint;
    if (!contextRef.current.resume || expectedFingerprint !== contextFingerprint(contextRef.current)
      || findResumeContextSource(contextRef.current.resume, proposal.targetRef) !== proposal.originalText) {
      setError("本次授权或简历原文已变化，请重新生成修改建议后核对；未写入简历。"); return;
    }
    if (!onApplyResumeProposal) { setError("当前入口尚未提供简历写回能力；提案未应用。"); return; }
    // Only our own successful edits may advance this batch's source fingerprint.
    // Unrelated external edits must still require generating a fresh proposal.
    const expectedContext = structuredClone(contextRef.current);
    const target = proposal.targetRef;
    if (target.kind === "profile_headline" && expectedContext.resume?.profile.headline) expectedContext.resume.profile.headline.text = proposal.proposedText;
    if (target.kind === "claim_text") {
      const claim = expectedContext.resume?.experiences.find((item) => item.id === target.experienceId)?.claims.find((item) =>
        item.targetRef.kind === "claim_text" && item.targetRef.claimId === target.claimId && item.targetRef.locale === target.locale);
      if (claim) claim.text = proposal.proposedText;
    }
    applyingRef.current = true;
    try {
      const result = await onApplyResumeProposal({ targetRef: proposal.targetRef, originalText: proposal.originalText, proposedText: proposal.proposedText });
      if (result.ok) { appliedContextFingerprints.current.set(record.id, contextFingerprint(expectedContext)); setDecisions((current) => ({ ...current, [key]: "已应用" })); setNotice(result.message ?? "已将这一条建议应用到原简历。"); }
      else setError(result.message ?? "原文已变化或保存冲突，未应用此建议。请回到简历核对后重新生成。");
    } catch (failure) { setError(messageOf(failure)); } finally { applyingRef.current = false; }
  };
  const adopt = () => {
    if (!latest || latest.payload.kind !== "plan") return;
    if (state.activePlan && state.activePlan.id !== latest.id && !window.confirm("替换当前学习方案？旧模型记录和学习提交会保留，旧任务进度将不再跟踪。建议先下载备份。")) return;
    if (mutate((current) => adoptCoachPlan(current, latest.id))) { setNotice("已采纳学习方案，可到学习监督选择任务并提交证据。"); setTaskId(""); }
  };
  const saveSubmission = () => {
    if (!selectedTask || !evidence.trim()) { setError("请选择任务并填写可阅读的学习证据。"); return; }
    if (mutate((current) => addCoachSubmission(current, { taskId: selectedTask.id, evidence, minutes }))) {
      setEvidence(""); setError(undefined); setNotice("学习提交已加入本地记录。可单独请求模型反馈；提交不代表通过验收。");
    }
  };
  const reviewSubmission = (submission: CoachSubmission) => {
    const active = stateRef.current.activePlan;
    const task = active?.plan.phases.flatMap((phase) => phase.tasks).find((item) => item.id === submission.taskId);
    if (!active || !task || active.id !== submission.planId) { setError("提交不属于当前方案，请重新选择。"); return; }
    void run({ ...makeRequest("review", "请针对本次学习证据和任务验收条件给出反馈。"), task, plan: active.plan,
      submission: { evidence: submission.evidence, minutes: submission.minutes } }, (next, record) => ({ ...next,
      submissions: next.submissions.map((item) => item.id === submission.id ? { ...item, feedbackRecordId: record.id } : item) }));
  };
  const requestInterview = (session: NonNullable<CoachState["interview"]>) => {
    void run({ ...makeRequest("interview", "请按本轮面试设置继续，一次只问一道题。"), interview: { turns: session.turns, totalRounds: session.totalRounds } }, (next, record) => {
      if (record.payload.kind !== "interview" || next.interview?.id !== session.id) return next;
      const payload = record.payload;
      return { ...next, interview: { ...next.interview, status: payload.complete ? "completed" : "active", question: payload.question,
        turns: next.interview.turns.map((turn, index) => index === next.interview!.turns.length - 1 && payload.feedback ? { ...turn, feedback: payload.feedback } : turn) } };
    });
  };
  const startInterview = () => {
    if (disabled || !state.settings.goal.trim()) { setError("请先填写本阶段目标。"); return; }
    if (interview && !window.confirm("重新开始面试？当前会话将重置，未获反馈的回答也会离开当前会话。成功模型记录仍保留，请按需先下载备份。")) return;
    const session: NonNullable<CoachState["interview"]> = { id: crypto.randomUUID(), status: "active", totalRounds: state.settings.interviewRounds, contextFingerprint: fingerprint, turns: [] };
    if (mutate((current) => ({ ...current, interview: session }))) { setAnswer(""); requestInterview(session); }
  };
  const submitAnswer = () => {
    const session = stateRef.current.interview;
    if (disabled || !session || session.status !== "active" || session.contextFingerprint !== fingerprint) return;
    if (!session.question) { requestInterview(session); return; }
    if (!answer.trim()) { setError("请先填写你自己的回答，再提交这一题。"); return; }
    const nextSession = { ...session, question: undefined, turns: [...session.turns, { question: session.question.text, answer: answer.trim() }] };
    if (mutate((current) => ({ ...current, interview: nextSession }))) { setAnswer(""); requestInterview(nextSession); }
  };
  const exportState = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(stateRef.current, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `better-me-career-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
    setNotice("已发起 JSON 备份下载。备份可能包含个人信息，请妥善保管。");
  };
  const reset = async () => {
    if (!window.confirm("只清除当前简历视图的职业成长记录？将移除计划、学习提交和面试，不影响原简历与岗位库。此操作不可撤销，请先下载备份。")) return;
    invalidate();
    try { await clear(); setInput(""); setAnswer(""); setEvidence(""); setDecisions({}); setNotice("已清除当前成长记录；原简历和岗位库未被改动。"); setError(undefined); } catch (failure) { setError(messageOf(failure)); }
  };

  return <section className="career-coach" aria-label="成长工作区">
    <header className="coach-header"><div><div className="coach-eyebrow"><span />BETTERME / CAREER LAB</div><h1>把下一步，变成看得见的成长。</h1><p>从职业判断到学习实践，在你的简历与目标之间建立一条可验证的路径。</p></div>
      <div className="coach-header-actions"><button type="button" onClick={onOpenConfig}><Settings2 size={16} />模型配置</button><button type="button" onClick={exportState} disabled={!ready}><Download size={16} />下载备份</button></div></header>
    <nav className="coach-tabs" aria-label="成长任务">{MODES.map((item, index) => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => { invalidate(true); setMode(item.id); setInput(""); setError(undefined); }}><span className="coach-tab-number">0{index + 1}</span><item.icon size={18} /><span>{item.title}<small>{item.subtitle}</small></span><ArrowRight size={15} /></button>)}</nav>
    <div className="coach-layout"><aside className="coach-setup"><div className="coach-section-heading"><Target size={18} /><h2>你的成长坐标</h2></div><p className="coach-muted">五个工作区共用这些约束，你始终可以调整。</p>
      <fieldset disabled={!ready || conflict}><label>本阶段目标<textarea value={state.settings.goal} maxLength={4000} rows={3} placeholder="例如：8 周内补齐接口设计与测试，准备全栈岗位面试" onChange={(event) => changeSettings({ goal: event.target.value })} /></label>
        <label>背景与限制<textarea value={state.settings.background} maxLength={6000} rows={3} placeholder="已有经验、希望改善的方面、时间或精力限制" onChange={(event) => changeSettings({ background: event.target.value })} /></label>
        <div className="coach-two-fields"><label>计划周数<input type="number" min={1} max={52} value={state.settings.durationWeeks} onChange={(event) => changeSettings({ durationWeeks: Math.min(52, Math.max(1, Number(event.target.value) || 1)) })} /></label><label>每周小时<input type="number" min={1} max={40} step={0.5} value={state.settings.weeklyHours} onChange={(event) => changeSettings({ weeklyHours: Math.min(40, Math.max(1, Number(event.target.value) || 1)) })} /></label></div>
        <label>面试轮数<input type="number" min={2} max={8} value={state.settings.interviewRounds} onChange={(event) => changeSettings({ interviewRounds: Math.min(8, Math.max(2, Number(event.target.value) || 2)) })} /></label>
      </fieldset>
      <div className="coach-permissions"><h3><ShieldCheck size={16} />本次资料授权</h3><label><input type="checkbox" checked={shareResume} disabled={!resumeEditContext} onChange={(event) => { invalidate(true); setShareResume(event.target.checked); }} /><span>共享当前简历字段<small>{resumeEditContext ? "仅当前视图允许的简介、技能和经历" : "当前没有可共享的简历"}</small></span></label>
        <label><input type="checkbox" checked={shareJob} disabled={!job} onChange={(event) => { invalidate(true); setShareJob(event.target.checked); }} /><span>共享当前目标岗位<small>{job ? [job.company, job.title].filter(Boolean).join(" · ") : "可先回 JD 工作区选择岗位"}</small></span></label>
        <p>默认不共享。点击生成后，已选资料与本次输入会发送给你配置的模型服务。关闭授权不删除已有私人记录。</p></div>
      <div className="coach-storage"><strong>只保存在此浏览器 · 当前简历视图</strong><p>{state.records.length} 条模型记录 · {state.submissions.length} 条学习提交</p><button type="button" className="coach-text-button" onClick={() => void reset()} disabled={!ready || busy}>清除成长记录</button></div>
    </aside><main className="coach-main">
      {!ready && <p role="status">正在读取本地成长记录…</p>}
      {persistenceError && <div className="coach-alert" role="alert"><strong>{conflict ? "检测到跨窗口保存冲突" : "本地记录尚未可靠保存"}</strong><p>{persistenceError}</p><p>请先下载备份。重新读取会用已保存版本替换本页草稿。</p><button type="button" onClick={() => { if (window.confirm("已下载需要保留的草稿？重新读取会替换当前内容。")) { invalidate(); void reload(); } }}>重新读取记录</button></div>}
      {error && <div className="coach-alert" role="alert"><strong>这一步尚未完成</strong><p>{error}</p><button type="button" onClick={onOpenConfig}>检查模型配置</button></div>}
      {notice && <p className="coach-notice" role="status">{notice}</p>}
      {busy && <div className="coach-running" role="status"><span className="coach-busy-dot" />模型正在处理本次请求…<button type="button" onClick={() => invalidate(true)}><X size={16} />取消生成</button></div>}
      <div className="coach-panel-heading"><span className="coach-kicker">{String(MODES.findIndex((item) => item.id === mode) + 1).padStart(2, "0")} / GROWTH WORKSPACE</span><h2>{MODES.find((item) => item.id === mode)?.title}</h2></div>
      {(mode === "analysis" || mode === "resume" || mode === "plan") && modeRecords.length > 1 && <label>查看本类历史结果<select value={latest?.id ?? ""} disabled={disabled} onChange={(event) => setSelectedRecordId(event.target.value)}>{modeRecords.map((record) => <option key={record.id} value={record.id}>{new Date(record.createdAt).toLocaleString()} · {record.payload.kind === "plan" ? record.payload.title : record.payload.kind === "analysis" || record.payload.kind === "resume" ? record.payload.summary.slice(0, 45) : record.mode}</option>)}</select></label>}
      {(mode === "analysis" || mode === "resume" || mode === "plan") && <section className="coach-compose">
        <p>{mode === "analysis" ? "先看证据，再做判断。你可以讨论职业方向，也可以分析当前方案的可行性。" : mode === "resume" ? "只优化已授权的真实原文，不添加项目、数字或未证实的技能。每条修改由你核对后应用。" : "生成覆盖每周的长期方案，包括交付物、验收条件和复盘节奏。生成不等于采纳。"}</p>
        {(mode === "analysis" || mode === "plan") && state.activePlan && <p className="coach-note">本次会一并发送已采纳方案「{state.activePlan.plan.title}」用于分析或调整；不会自动替换。</p>}
        <label>{mode === "analysis" ? "本轮问题或补充回答" : mode === "resume" ? "希望怎样改善表达" : "本轮学习重点"}<textarea value={input} rows={3} maxLength={12000} disabled={disabled} placeholder={mode === "analysis" ? "例如：我想提高收入，但希望保持可持续的工作节奏，应该先补什么？" : mode === "resume" ? "例如：让职责描述更明确，保持事实与原意" : "例如：优先练接口设计、异常处理和自动化测试"} onChange={(event) => setInput(event.target.value)} /></label>
        <button type="button" className="coach-primary" disabled={disabled || (mode === "resume" && !shareResume)} onClick={() => mode === "analysis" ? generateAnalysis() : void run({ ...makeRequest(mode), ...(mode === "plan" ? { plan: state.activePlan?.plan } : {}) })}><Sparkles size={17} />{mode === "analysis" ? "开始规划分析" : mode === "resume" ? "生成修改建议" : "生成学习方案"}<ArrowRight size={16} /></button>
        {mode === "resume" && !shareResume && <small>请先在左侧明确授权共享当前简历字段。</small>}
      </section>}
      {latest && (mode === "analysis" || mode === "resume" || mode === "plan") && <div className="coach-result-meta"><span>模型参考 · {latest.model.name}</span><span>{new Date(latest.createdAt).toLocaleString()} · {latest.basis.resumeShared ? "含简历" : "无简历"} / {latest.basis.jobShared ? "含岗位" : "无岗位"}</span></div>}
      {mode === "analysis" && (analysis ? <section className="coach-result"><h3>本轮判断</h3><p className="coach-summary">{analysis.summary}</p><div className="coach-direction-grid">{analysis.directions.map((direction, index) => <article key={index}><span className="coach-kicker">方向 {index + 1}</span><h3>{direction.title}</h3><p>{direction.reason}</p><Points title="材料依据" items={direction.evidence} /><Points title="需要权衡" items={direction.tradeoffs} /></article>)}</div><Points title="已有优势" items={analysis.strengths} />
        {analysis.gaps.length > 0 && <div className="coach-gap-list"><h3>值得补充或练习</h3>{analysis.gaps.map((gap, index) => <div key={index}><span className="coach-badge">{gap.status === "unknown" ? "尚无依据，不代表不会" : "建议练习"}</span><strong>{gap.skill}</strong><p>{gap.reason}</p></div>)}</div>}
        {analysis.questions.map((question, index) => <div className="coach-question" key={index}><h3>{question.question}</h3><p>{question.why}</p><div className="coach-choice-row">{question.options.map((option, choice) => <button type="button" key={choice} disabled={disabled} onClick={() => setInput((current) => `${current}${current ? "\n" : ""}${question.question}：${option}`.slice(0, 12000))}>{option}</button>)}</div></div>)}
        {analysis.questions.length > 0 && <p className="coach-note">选项只填入上方输入框，核对后点击「开始规划分析」提交；不会替你自动回答。</p>}<Points title="下一步行动" items={analysis.nextActions} /><button type="button" disabled={disabled} onClick={() => carryToPlan(`请核对并以这些规划结论作为候选学习重点：\n${analysis.summary}\n${analysis.nextActions.join("\n")}\n用户已补充：${latest?.input ?? ""}`)}>用本轮结论制定方案<ArrowRight size={16} /></button></section> : <Empty title="先把目标说清楚" text="填入你的阶段目标与背景，让模型提出有依据的方向、取舍和必要追问。未提供的信息会被标记为未知。" />)}
      {mode === "resume" && (resume && latest ? <section className="coach-result"><p className="coach-summary">{resume.summary}</p>{resume.proposals.length === 0 && <p>本轮没有可应用的改写提案。</p>}{resume.proposals.map((proposal, index) => {
        const key = `${latest.id}:${index}`;
        return <article className="coach-proposal" key={key}><h3>提案 {index + 1} · {proposal.targetRef.kind === "profile_headline" ? "个人简介" : "经历条目"}</h3><div className="coach-diff"><div><small>原文</small><p>{proposal.originalText}</p></div><div><small>建议表达</small><p>{proposal.proposedText}</p></div></div><p>{proposal.rationale}</p><div className="coach-inline-actions">{decisions[key] ? <strong>{decisions[key]}</strong> : <><button type="button" className="coach-primary" disabled={disabled || !shareResume} onClick={() => void approve(latest, index)}><Check size={16} />核对并应用此条</button><button type="button" disabled={disabled} onClick={() => setDecisions((current) => ({ ...current, [key]: "本次已拒绝" }))}>拒绝此条</button></>}</div></article>; })}</section> : <Empty title="表达可以更好，事实不能改变" text="共享简历后生成原文与建议对照。未经你逐条批准，不会改动简历或事实库。" />)}
      {mode === "plan" && <>{state.activePlan && <div className="coach-adopted"><Check size={18} /><div><strong>正在执行：{state.activePlan.plan.title}</strong><p>{state.activePlan.startDate} 开始 · 自评完成 {progress.selfCompleted}/{progress.total}</p></div></div>}
        {candidate && latest ? <section className="coach-result"><div className="coach-section-heading"><h3>{candidate.title}</h3><span className="coach-badge">{state.activePlan?.id === latest.id ? "已采纳" : "候选方案 · 尚未执行"}</span></div><PlanContent plan={candidate} /><button type="button" className="coach-primary" disabled={disabled || state.activePlan?.id === latest.id} onClick={adopt}><Check size={17} />{state.activePlan?.id === latest.id ? "已采纳此方案" : state.activePlan ? "确认替换当前方案" : "采纳此学习方案"}</button></section> : <Empty title="让长期目标有每周的落点" text="设置周期与可用时间，生成包含阶段、任务、交付物和验收条件的方案。模型超出时间预算的结果不会被采用。" />}</>}
      {mode === "review" && (state.activePlan ? <>
        <div className="coach-metrics"><div><strong>{progress.selfCompleted}/{progress.total}</strong><span>本人自评完成</span></div><div><strong>{progress.submitted}</strong><span>待本人核对的提交</span></div><div><strong>{progress.overdue}</strong><span>已过计划周界</span></div><div><strong>{progress.totalMinutes}</strong><span>记录投入 / 分钟</span></div></div>
        <p className="coach-note">当前方案：{state.activePlan.plan.title}。打开页面时计算逾期，不在后台监控、提醒或自动认证完成。</p>
        <section className="coach-compose"><label>选择学习任务<select value={selectedTask?.id ?? ""} onChange={(event) => setTaskId(event.target.value)} disabled={disabled}>{tasks.map((task) => <option key={task.id} value={task.id}>第 {task.week} 周 · {task.title}</option>)}</select></label>
          {selectedTask && <><p><strong>交付物：</strong>{selectedTask.deliverable}</p><Points title="本人验收条件" items={selectedTask.acceptanceCriteria} /><label>任务状态<select aria-label="任务状态" value={state.activePlan.progress[selectedTask.id]?.status ?? "todo"} disabled={disabled} onChange={(event) => mutate((current) => updateCoachTask(current, selectedTask.id, event.target.value as CoachTaskStatus))}>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></>}
          <label>学习证据<textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={12000} rows={5} placeholder="粘贴实际实现说明、代码片段、测试结果或自己的解释。只有链接时，模型不能宣称已访问验证。" /></label>
          <label>本次投入分钟<input type="number" min={0} max={1440} value={minutes} onChange={(event) => setMinutes(Math.min(1440, Math.max(0, Math.round(Number(event.target.value) || 0))))} /></label>
          <button type="button" className="coach-primary" disabled={disabled} onClick={saveSubmission}><Check size={17} />保存学习提交</button><small>先保存证据，再按需请求模型反馈；两步独立，不把失败反馈记成完成。</small>
        </section><section className="coach-result"><h3>当前任务的学习提交</h3>{submissions.length === 0 && <p>还没有提交。完成一小步后，把可阅读的证据留在这里。</p>}{[...submissions].reverse().map((submission) => {
          const record = state.records.find((item) => item.id === submission.feedbackRecordId);
          const feedback = record?.payload.kind === "review" ? record.payload : undefined;
          return <article className="coach-submission" key={submission.id}><small>{new Date(submission.createdAt).toLocaleString()} · {submission.minutes} 分钟</small><p className="coach-prewrap">{submission.evidence}</p>{feedback ? <div className="coach-feedback"><span className="coach-badge">{({ insufficient: "证据不足", needs_revision: "还需修改", ready_for_self_check: "可以进入本人自查" })[feedback.evidenceAssessment]}</span><p>{feedback.summary}</p><Points title="证据中的优势" items={feedback.strengths} /><Points title="改进建议" items={feedback.improvements} /><Points title="下一步" items={feedback.nextActions} /><Points title="本人核对问题" items={feedback.checkQuestions} /></div> : <p className="coach-muted">已保留提交，尚无模型反馈。</p>}<button type="button" disabled={disabled} onClick={() => reviewSubmission(submission)}>{feedback ? "重新请求反馈" : "请求模型反馈"}</button></article>;
        })}</section></> : <Empty title="先采纳一份学习方案" text="学习监督只跟踪你明确采纳的任务。到学习方案生成并采纳后，再提交证据、复盘和自评完成。" action={<button type="button" className="coach-primary" onClick={() => setMode("plan")}>去制定学习方案<ArrowRight size={16} /></button>} />)}
      {mode === "interview" && <>
        <div className="coach-compose"><p>每次只问一道题，必须等你的真实回答才能评价。满 {interview?.totalRounds ?? state.settings.interviewRounds} 轮后生成总结；不会替你作答。</p><div className="coach-inline-actions"><button type="button" className="coach-primary" disabled={disabled} onClick={startInterview}><MessageSquare size={17} />{interview ? "重新开始面试" : "开始模拟面试"}</button>{interview?.status === "active" && <button type="button" onClick={() => { invalidate(true); mutate((current) => ({ ...current, interview: current.interview ? { ...current.interview, status: "stopped" } : undefined })); }}>停止本轮面试</button>}</div></div>
        {interviewChanged && <p className="coach-alert" role="alert">面试使用的简历或岗位授权已变化。请恢复原资料授权后继续，或下载记录后重新开始；不会把新旧上下文静默混合。</p>}
        {!interview && <Empty title="把“我做过”讲成有证据的回答" text="练习项目细节、方案取舍和异常处理。先自行回答，再看模型基于文本提供的评分依据。" />}
        {interview && <section className="coach-result"><div className="coach-section-heading"><h3>本轮面试</h3><span className="coach-badge">已作答 {interview.turns.length}/{interview.totalRounds} · {({ active: "进行中", completed: "已完成", stopped: "已停止" })[interview.status]}</span></div>
          {interview.turns.map((turn, index) => <article className="coach-interview-turn" key={index}><h3>第 {index + 1} 题 · {turn.question}</h3><div className="coach-answer"><small>我的回答</small><p className="coach-prewrap">{turn.answer}</p></div>{turn.feedback ? <Feedback value={turn.feedback} /> : <p className="coach-muted">回答已保留，尚未获得有效反馈。</p>}</article>)}
          {interview.status === "active" && <div className="coach-question"><h3>{interview.question ? `第 ${interview.turns.length + 1} 题 · ${interview.question.text}` : "等待生成本轮结果"}</h3>{interview.question && <><p>考察点：{interview.question.focus}</p><Points title="本题评价标准" items={interview.question.evaluationCriteria} /><label>你的面试回答<textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={6} maxLength={12000} disabled={disabled || interviewChanged} placeholder="用自己的经历与思路回答，不需要追求一次完美。" /></label></>}
            <div className="coach-inline-actions"><button type="button" className="coach-primary" disabled={disabled || interviewChanged} onClick={submitAnswer}>{interview.question ? "提交回答并继续" : "重试本轮生成"}<ArrowRight size={16} /></button>{interview.question && interview.turns.length > 0 && <button type="button" disabled={disabled || interviewChanged || Boolean(answer.trim())} onClick={() => requestInterview(interview)}>重新生成上一题反馈与本题</button>}</div></div>}
          {interview.status === "completed" && latest?.payload.kind === "interview" && latest.payload.complete && <div className="coach-final-summary"><h3>面试复盘</h3><p>{latest.payload.summary}</p><Points title="建议继续练习" items={latest.payload.nextActions} /><button type="button" disabled={disabled} onClick={() => { if (latest.payload.kind === "interview") carryToPlan(`请先核对这次模拟面试的参考反馈，再调整学习重点：\n${latest.payload.summary}\n${latest.payload.nextActions.join("\n")}`); }}>用面试反馈调整方案<ArrowRight size={16} /></button></div>}
        </section>}
      </>}
      <footer className="coach-footer"><ShieldCheck size={15} /><span>模型建议 ≠ 已核实事实。所有写回、采纳和完成判断由你掌握。</span></footer>
    </main></div>
  </section>;
}

function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="coach-empty"><div className="coach-empty-mark"><Compass size={30} strokeWidth={1.3} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
