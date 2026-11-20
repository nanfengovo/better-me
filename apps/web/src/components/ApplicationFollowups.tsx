import { useUiPreferences } from "../lib/ui-preferences";
import { useEffect, useState } from "react";
import { CalendarClock, Check, ChevronRight, MessageSquare, Plus } from "lucide-react";
import {
  applicationFollowupQueues, opportunityDateTimeInput, parseOpportunityDateTimeInput,
  type ApplicationCommunication, type Opportunity,
} from "../lib/opportunities";
import { useConfirm } from "./ConfirmationDialog";


export function ApplicationFollowups({ jobs, onOpen }: { jobs: Opportunity[]; onOpen: (job: Opportunity) => void }) {
  const { t } = useUiPreferences();
  const QUEUES = { overdue: { title: t("已逾期", "Overdue"), empty: t("暂无逾期", "None overdue") }, today: { title: t("今日待办", "Today"), empty: t("今日暂无待办", "None today") }, upcoming: { title: t("未来安排", "Upcoming"), empty: t("暂无未来安排", "None upcoming") } } as const;

  const [now, setNow] = useState(() => new Date().toISOString());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    const timer = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);
  const queues = applicationFollowupQueues(jobs, now);
  const total = queues.overdue.length + queues.today.length + queues.upcoming.length;
  return <section className={`application-queues${total === 0 ? " is-empty-queue" : ""}`} aria-label={t("跟进待办队列", "Follow-up queue")}>
    <div className="application-queues-heading">
      <div><CalendarClock size={16} /><h2>{t("下一步跟进", "Next follow-ups")}</h2><span>{total} {t("项", "items")}</span></div>
      {total === 0 && <p>{t("在岗位详情中设置跟进时间后，将自动出现在这里。", "Set a follow-up time in job details to track it here.")}</p>}
    </div>
    {total > 0 && <div className="application-queues-grid">{Object.entries(QUEUES).map(([key, meta]) => {
      const group = queues[key as keyof typeof queues];
      return <section className={`application-queue ${key}`} key={key}><h3>{meta.title}<span>{group.length}</span></h3>
        {group.slice(0, expanded ? undefined : 4).map((job) => <button key={job.id} onClick={() => onOpen(job)} className="application-queue-item"><span><small>{job.company} · {job.title}</small><strong>{job.application.nextAction || t("补充下一步计划", "Add next step")}</strong><time dateTime={job.application.nextActionAt}>{opportunityDateTimeInput(job.application.nextActionAt).replace("T", " ")}</time></span><ChevronRight size={14} /></button>)}
        {!group.length && <div className="application-queue-empty">{meta.empty}</div>}
      </section>;
    })}</div>}
    {(expanded || Object.values(queues).some((group) => group.length > 4)) && <button className="studio-button subtle" onClick={() => setExpanded(!expanded)}>{expanded ? t("收起安排", "Collapse schedule") : t("展开全部安排", "Show all scheduled items")}</button>}
  </section>;
}

type CommunicationInput = Omit<ApplicationCommunication, "id" | "recordedAt">;
export function ApplicationCommunicationLog({ job, disabled, onDirtyChange, onRecord, onDelete }: {
  job: Opportunity; disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onRecord: (input: CommunicationInput) => boolean;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useUiPreferences();
  const METHODS = { email: t("邮件", "Email"), phone: t("电话", "Phone"), platform: t("招聘平台 / 即时消息", "Job platform / instant message"), video: t("视频", "Video"), "in-person": t("当面", "In person"), other: t("其他", "Other") } as const;
  const confirmAction = useConfirm();
  const [composing, setComposing] = useState(false);
  const [direction, setDirection] = useState<ApplicationCommunication["direction"]>("outbound");
  const [method, setMethod] = useState<ApplicationCommunication["method"]>("platform");
  const [occurredAt, setOccurredAt] = useState("");
  const [originalOccurredAt, setOriginalOccurredAt] = useState("");
  const [contact, setContact] = useState("");
  const [summary, setSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onDirtyChange(composing); return () => onDirtyChange(false); }, [composing, onDirtyChange]);
  const entries = [...job.application.communications].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  function begin() {
    const now = new Date().toISOString();
    setDirection("outbound"); setMethod("platform"); setOriginalOccurredAt(now); setOccurredAt(opportunityDateTimeInput(now, "second"));
    setContact(job.application.contactName); setSummary(""); setConfirmed(false); setError(""); setComposing(true);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!confirmed) { setError(t("请确认这次沟通已实际发生。待发送内容可写入下一步。", "Confirm that this communication actually happened. Put unsent drafts in Next step.")); return; }
    try {
      const at = parseOpportunityDateTimeInput(occurredAt, originalOccurredAt);
      if (!at) throw new Error(t("请填写实际发生时间。", "Enter when the communication actually happened."));
      if (onRecord({ direction, method, occurredAt: at, contact, summary })) setComposing(false);
    } catch (err) { setError(err instanceof Error ? err.message : t("沟通记录保存失败。", "Could not save the communication record.")); }
  }
  return <section className="application-communications" aria-label={t("实际沟通记录", "Communication history")}>
    <div className="application-communications-heading"><h3><MessageSquare size={15} />{t("沟通记录", "Communication history")} <span>{entries.length} / 200</span></h3>{!composing && <button type="button" className="studio-button" onClick={begin} disabled={disabled || entries.length >= 200}><Plus size={13} />{t("记录一次沟通", "Record a communication")}</button>}</div>
    {composing && <form className="application-communication-form" onSubmit={submit}>
      <div className="opportunity-form-grid"><label>{t("沟通方向", "Direction")}<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="outbound">{t("我发出", "Sent by me")}</option><option value="inbound">{t("对方发来", "Received")}</option></select></label>
        <label>{t("沟通方式", "Method")}<select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>{Object.entries(METHODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{t("实际发生时间（北京时间）", "Actual time (Beijing time)")}<input type="datetime-local" step={1} required value={occurredAt} max={opportunityDateTimeInput(new Date().toISOString(), "second")} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label>{t("本次沟通对象", "Contact for this communication")}<input maxLength={500} value={contact} placeholder={t("例如：招聘负责人 / 面试官", "For example: hiring manager / interviewer")} onChange={(event) => setContact(event.target.value)} /></label></div>
      <label>{t("实际沟通摘要", "Communication summary")}<textarea required maxLength={10_000} rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={t("记录实际发生的内容、结论与约定，不必存放敏感信息。", "Record what happened, the outcome and agreements. Sensitive information is not required.")} /></label>
      <label className="application-communication-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("我确认这次沟通已经实际发生", "I confirm this communication actually happened")}</label>
      {error && <p role="alert" className="application-communication-error">{error}</p>}
      <div className="application-communication-actions"><button type="button" className="studio-button" onClick={async () => { if (await confirmAction(t("放弃这条尚未保存的沟通记录？", "Discard this unsaved communication record?"), { title: t("保留实际沟通记录", "Keep communication record"), confirmLabel: t("放弃编辑", "Discard edit") })) setComposing(false); }}>{t("取消补录", "Cancel entry")}</button><button className="studio-button primary" type="submit" disabled={disabled}><Check size={13} />{t("保存实际沟通", "Save communication")}</button></div>
    </form>}
    {!entries.length && !composing && <p className="application-communication-empty">{t("暂无沟通记录。", "No communication recorded yet.")}</p>}
    <ol className="application-communication-list">{entries.map((entry) => <li key={entry.id}><div><strong>{entry.direction === "outbound" ? t("我发出", "Sent by me") : t("对方发来", "Received")} · {METHODS[entry.method]}</strong><time dateTime={entry.occurredAt}>{opportunityDateTimeInput(entry.occurredAt).replace("T", " ")} {t("北京时间", "Beijing time")}</time></div>{entry.contact && <p className="application-communication-contact">{t("对象：", "Contact:")}{entry.contact}</p>}<p>{entry.summary}</p><footer><small>{t("补录于", "Recorded")} {opportunityDateTimeInput(entry.recordedAt).replace("T", " ")}</small><button type="button" disabled={disabled} onClick={() => { void onDelete(entry.id); }}>{t("删除这条记录", "Delete this record")}</button></footer></li>)}</ol>
  </section>;
}
