import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { InterviewFollowUpListSchema, InterviewFollowUpSchema, type InterviewDecision, type InterviewFollowUp, type InterviewPlan } from "@better-me/agent-contracts/career-studio";
import { InterviewFollowUpSummary } from "./InterviewFollowUpSummary";
import "./interview-follow-up.css";

const TrainingKitPanel = lazy(() => import("./TrainingKitPanel").then(module => ({ default: module.TrainingKitPanel })));
const paths = { facts: "核对材料", practice: "练习表达", defer: "暂缓" } as const;
type Request = (route: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
type Decide = (item: InterviewFollowUp, decision: InterviewDecision, signal?: AbortSignal) => Promise<void>;
const dateLabel = (at: string) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function localDateInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function PlanEditor({ item, onSave, onCancel }: {
  item: InterviewFollowUp; onSave: (decision: InterviewDecision) => void; onCancel: () => void;
}) {
  const [path, setPath] = useState<InterviewPlan["path"] | "">(item.plan?.path ?? "");
  const [standard, setStandard] = useState(item.plan?.standard ?? "");
  const [nextAction, setNextAction] = useState(item.plan?.nextAction ?? "");
  const [due, setDue] = useState(() => localDateInput(item.plan ? new Date(item.plan.dueAt) : new Date(Date.now() + 86400000)));
  return <form onSubmit={event => {
    event.preventDefault();
    if (path && due && standard.trim() && nextAction.trim()) onSave({ kind: "plan", plan: { path, standard, nextAction, dueAt: new Date(due).toISOString() } });
  }}>
    <fieldset><legend>这次准备怎么跟进？</legend><div className="ifu-choices">
      {Object.entries(paths).map(([value, label]) => <label key={value}><input required type="radio" name={item.id} value={value} checked={path === value} onChange={() => setPath(value as InterviewPlan["path"])} />{label}</label>)}
    </div></fieldset>
    {path && <><label>验收标准<input required maxLength={600} value={standard} placeholder={path === "facts" ? "例如，找到能说明本人决策的项目记录" : "例如，能说清自己的决定、理由和验证方法"} onChange={e => setStandard(e.target.value)} /></label>
      <label>下一步<input required maxLength={400} value={nextAction} onChange={e => setNextAction(e.target.value)} placeholder={path === "defer" ? "下次面试后再回看这条追问" : path === "facts" ? "核对当时的评审记录" : "换一个项目，独立作答一次"} /></label>
      <label>复查时间<input required type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label></>}
    <div className="crfp-actions"><button className="crfp-primary" disabled={!path || !standard.trim() || !nextAction.trim() || !due}>保存跟进安排</button>
      {item.plan && <button type="button" onClick={onCancel}>取消</button>}</div>
  </form>;
}

function FollowUpCard({ item, decide }: { item: InterviewFollowUp; decide: Decide }) {
  const [editing, setEditing] = useState(false), [workshop, setWorkshop] = useState(false);
  const [form, setForm] = useState<"observe" | "assess" | "interview" | null>(null);
  const [observation, setObservation] = useState(""), [next, setNext] = useState("");
  const [assessment, setAssessment] = useState<"met" | "retry">("retry");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false), life = useRef(new AbortController());
  useEffect(() => { life.current = new AbortController(); return () => life.current.abort(); }, []);
  async function save(decision: InterviewDecision, outer?: AbortSignal) {
    if (saving.current) return;
    const signal = outer ? AbortSignal.any([outer, life.current.signal]) : life.current.signal;
    saving.current = true; setBusy(true); setError("");
    try {
      await decide(item, decision, signal);
      if (!signal.aborted) { setEditing(false); setWorkshop(false); setForm(null); setObservation(""); setNext(""); }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error && /conflict|revision|follow_up_changed/.test(cause.message)
        ? "这条记录已在别处更新。请刷新问题后核对，再保存。" : "这次保存未确认。请刷新问题核对上次结果。");
      if (outer) throw cause;
    } finally { saving.current = false; if (!life.current.signal.aborted) setBusy(false); }
  }
  function openForm(kind: typeof form) { setForm(kind); setObservation(""); setNext(""); }
  const plan = item.plan;
  return <article className="ifu-card" aria-busy={busy}>
    <header><small>{dateLabel(item.happenedAt)} · 面试原问{item.applicationId ? " · " + item.applicationId : ""}</small>
      <blockquote>{item.quote}</blockquote></header>
    <fieldset disabled={busy}>
      {(!plan || editing) ? <PlanEditor item={item} onSave={decision => void save(decision)} onCancel={() => setEditing(false)} /> : <>
        <div className="ifu-plan"><strong>{paths[plan.path]}</strong><span>{dateLabel(plan.dueAt)} 复查</span></div>
        <dl><div><dt>验收标准</dt><dd>{plan.standard}</dd></div><div><dt>下一步</dt><dd>{item.nextAfterAssessment || plan.nextAction}</dd></div>
          {item.observation && <div><dt>观察记录</dt><dd>{item.observation}</dd></div>}
          {item.retestDueAt && <div><dt>换题复测</dt><dd>{item.retestAt ? dateLabel(item.retestAt) + " 已提交" : dateLabel(item.retestDueAt) + " 开放"}{item.retestAt && (item.independent === true ? " · 独立作答" : item.independent === false ? " · 有参考" : " · 帮助情况未知")}</dd></div>}
          {item.assessment && <div><dt>本人判断</dt><dd>{item.assessment === "met" ? "已达到标准" : "还需再练"}</dd></div>}
          {item.interviewObservation && <div><dt>后续面试</dt><dd>{item.interviewObservation}</dd></div>}
        </dl>
        <div className="crfp-actions">
          {plan.path === "practice" && <button className="crfp-primary" type="button" onClick={() => setWorkshop(!workshop)}>{workshop ? "收起训练工坊" : "进入训练工坊"}</button>}
          {plan.path === "facts" && <button className="crfp-primary" type="button" onClick={() => openForm("observe")}>记录核对结果</button>}
          {item.retestAt && <button type="button" onClick={() => openForm("assess")}>记录复测判断</button>}
          <button type="button" onClick={() => { setEditing(true); setWorkshop(false); openForm(null); }}>调整安排</button>
          <button type="button" onClick={() => openForm("interview")}>记录后续面试反馈</button>
        </div>
        {form && <form onSubmit={event => {
          event.preventDefault();
          if (!observation.trim()) return;
          if (form === "assess") { if (next.trim()) void save({ kind: "assess", assessment, observation, nextAction: next }); }
          else void save({ kind: form, observation });
        }}>
          {form === "assess" && <label>对照原标准<select value={assessment} onChange={e => setAssessment(e.target.value as typeof assessment)}><option value="retry">还需再练</option><option value="met">已达到标准</option></select></label>}
          <label>{form === "assess" ? "观察依据" : form === "observe" ? "核对结果" : "后续面试反馈"}<textarea required maxLength={1200} value={observation} onChange={e => setObservation(e.target.value)} /></label>
          {form === "assess" && <label>接下来做什么<input required maxLength={400} value={next} onChange={e => setNext(e.target.value)} /></label>}
          <div className="crfp-actions"><button className="crfp-primary" disabled={!observation.trim() || (form === "assess" && !next.trim())}>{form === "assess" ? "保存复测判断" : "保存观察"}</button><button type="button" onClick={() => openForm(null)}>取消</button></div>
        </form>}
      </>}
    </fieldset>
    {plan?.path === "practice" && workshop && <Suspense fallback={<p>正在打开训练工坊…</p>}>
      <TrainingKitPanel interview={{ followUpId: item.id, criterion: plan.standard, evidence: item.quote,
        ...(item.kitId && item.kitVersion ? { savedKit: { id: item.kitId, version: item.kitVersion } } : {}) }}
        onReview={(kit, signal) => save({ kind: "training", kitId: kit.id, kitVersion: kit.version }, signal)} />
    </Suspense>}
    {!!item.history.length && <details><summary>跟进历史 · {item.history.length}</summary><ol>{item.history.map((h,i) => <li key={i}>{dateLabel(h.at)} · {h.detail}</li>)}</ol></details>}
    {error && <p role="alert">{error}</p>}
  </article>;
}

export function InterviewFollowUpPanel({ contextId, savedFeedbackId, request }: { contextId: string; savedFeedbackId: string; request: Request }) {
  const [list, setList] = useState<z.infer<typeof InterviewFollowUpListSchema>>(), [error,setError] = useState("");
  const [open,setOpen] = useState(false), [reload,setReload] = useState(0), [offset,setOffset] = useState(0);
  const [loading,setLoading] = useState(false), generation = useRef(0);
  useEffect(() => {
    if (!open && !savedFeedbackId) return;
    const ac = new AbortController(), version = ++generation.current;
    setLoading(true); setError("");
    request("/feedback/follow-ups", { contextId, offset, limit: 12 }, ac.signal).then(raw => {
      if (!ac.signal.aborted && version === generation.current) setList(InterviewFollowUpListSchema.parse(raw));
    }).catch(() => { if (!ac.signal.aborted) setError("未能读取面试问题，请刷新重试。"); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [contextId, savedFeedbackId, open, reload, offset, request]);
  const decide: Decide = async (item, decision, signal) => {
    const raw = await request("/feedback/follow-up/decide", { contextId, consent: true, feedbackId: item.feedbackId, id: item.id, expectedRevision: item.revision, decision }, signal);
    const { item: updated } = z.object({ item: InterviewFollowUpSchema }).parse(raw);
    const sameDecision = updated.revision === item.revision && (
      (decision.kind === "training" && updated.kitId === decision.kitId && updated.kitVersion === decision.kitVersion) ||
      (decision.kind === "plan" && updated.plan && updated.plan.path === decision.plan.path && updated.plan.nextAction === decision.plan.nextAction &&
        updated.plan.standard === decision.plan.standard && updated.plan.dueAt === decision.plan.dueAt));
    if (signal?.aborted || updated.id !== item.id || updated.feedbackId !== item.feedbackId || updated.versionId !== item.versionId || (updated.revision < item.revision || (updated.revision === item.revision && !sameDecision))) throw new Error("follow_up_receipt_mismatch");
    ++generation.current;
    setList(old => old && ({ ...old, items: old.items.map(existing => existing.id === updated.id && existing.revision <= updated.revision ? updated : existing) }));
  };
  return <section className="crfp-card ifu" aria-label="面试问题跟进"><div className="crfp-subhead"><h3>面试问题跟进</h3>
    <button type="button" disabled={loading} onClick={() => {setOpen(true); setOffset(0); setReload(n => n + 1);}}>{loading ? "读取中…" : list ? "刷新问题" : "查看已存面试问题"}</button></div>
    {error && <p role="alert">{error}</p>}
    {list && <><InterviewFollowUpSummary items={list.items.flatMap(item => item.plan ? [{ ...item, path: item.plan.path }] : [])}/>
      {list.items.length === 0 && <p className="crfp-muted">保存含面试原问的复盘笔记后，可以在这里安排下一步。</p>}
      {list.items.map(item => <FollowUpCard item={item} decide={decide} key={item.id}/>)}
      {(offset > 0 || list.hasMore) && <nav className="crfp-actions" aria-label="面试问题分页">
        <button type="button" disabled={loading || offset === 0} onClick={() => setOffset(n => Math.max(0, n - 12))}>上一页</button>
        <button type="button" disabled={loading || !list.hasMore} onClick={() => setOffset(n => n + 12)}>下一页</button>
      </nav>}
    </>}
  </section>;
}
