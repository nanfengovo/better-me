/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import type { ApplicationStage, OpportunityActionRecord, Opportunity, OpportunityDecisionEvidence, OpportunityDecisionReceipt, OpportunityEventReview } from "../lib/opportunities";
import { opportunityDateTimeInput, parseOpportunityDateTimeInput } from "../lib/opportunities";
import { useUiPreferences } from "../lib/ui-preferences";

type ReviewInput = Omit<OpportunityEventReview, "reviewedAt">;
type EventKind = "stage" | "communication" | "action";
type Props = {
  job: Opportunity; stages: Record<ApplicationStage, string>; disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (kind: EventKind, eventId: string, review: ReviewInput) => boolean;
  onRecommend?: () => Promise<boolean>;
  onReadEvidence?: (decision: OpportunityDecisionReceipt) => Promise<OpportunityDecisionEvidence | undefined>;
  onCaptureMaterial?: () => Promise<string | undefined>;
  onRecordAction?: (decisionId: string, review: ReviewInput, options: { occurredAt?: string; sourceEvent?: OpportunityActionRecord["sourceEvent"] }) => boolean;
  onEvaluate?: (actionId: string, consent: boolean) => boolean;
  onExportSample?: (actionId: string) => void;
};
const emptyReview: ReviewInput = { action: "other", reason: "", feedback: "unobserved", observation: "" };

export function OpportunityEventReviewPanel({ job, stages, disabled, onDirtyChange, onSave, onRecommend, onReadEvidence, onCaptureMaterial, onRecordAction, onEvaluate, onExportSample }: Props) {
  const { t } = useUiPreferences();
  const when = (at: string) => opportunityDateTimeInput(at).replace("T", " ");
  const actions = { apply: t("直接投递", "Apply directly"), "collect-evidence": t("先补证据", "Gather evidence"), practice: t("先练习", "Practise first"), other: t("其他行动", "Other action") };
  const feedback = { unobserved: t("尚无明确反馈", "No explicit feedback"), reported: t("对方明确反馈", "Feedback from the other party"), interpretation: t("个人推测", "Personal interpretation") };
  const reasons = {
    "verified-requirements": t("当前要求均已有支持证据，可以优先投递。", "Every recorded requirement has supporting evidence. Applying is a reasonable first step."),
    "missing-evidence": t("仍有要求缺少充分证据，先补充可核对的成果及来源。", "Some requirements lack enough evidence. Gather verifiable work and its sources first."),
    "retest-gap": t("独立复测仍有未达成项，先换情境练习并再次验证。", "An independent retest has an unmet criterion. Practise in another scenario and verify again."),
    "unreviewed-retest": t("已记录的独立复测仍待人工核对，先补充或核实证据。", "Recorded independent retests still need review. Verify or supplement the evidence first."),
    "unverified-opportunity": t("岗位开放状态仍待核实，先确认能否投递。", "The opportunity status is unverified. Confirm whether applications are still accepted."),
    "closed-opportunity": t("岗位已标记关闭，先核实开放状态。", "The opportunity is marked closed. Confirm its status first."),
  };
  const outcomeLabels = { positive: t("正向进展", "Positive progress"), negative: t("负向结果", "Negative result"), neutral: t("中性反馈", "Neutral feedback"), unknown: t("仍未知", "Still unknown") };
  const events = [
    ...(job.application.actions ?? []).slice().reverse().map(row => ({ kind: "action" as const, at: row.occurredAt, label: actions[row.review.action], row })),
    ...job.application.history.map(row => ({ kind: "stage" as const, at: row.changedAt, label: stages[row.stage], row })),
    ...job.application.communications.map(row => ({ kind: "communication" as const, at: row.occurredAt, label: t("实际沟通", "Communication"), row })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const [selected, setSelected] = useState("");
  const [selectedDecision, setSelectedDecision] = useState("");
  const [draft, setDraft] = useState<ReviewInput>();
  const [newAction, setNewAction] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [sourceEventId, setSourceEventId] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const event = events.find(item => item.kind + item.row.id === selected) ?? events[0];
  const decision = job.decisions?.find(row => row.id === selectedDecision) ?? job.decisions?.at(-1);
  const recordedAction = event?.kind === "action" ? event.row : undefined;
  const actionDecision = job.decisions?.find(row => row.id === recordedAction?.decisionId);
  const linkedAction = event?.kind !== "action" && job.application.actions?.find(row =>
    (row.sourceEvent?.kind === event?.kind && row.sourceEvent?.id === event?.row.id) ||
    (event?.kind === "communication" && row.review.feedbackCommunicationId === event.row.id));
  const review = event?.row.review;
  const jd = job.jdSnapshots?.find(item => item.id === event?.row.jdSnapshotId);
  const material = job.materials.find(item => item.id === review?.materialId);
  useEffect(() => { onDirtyChange(!!draft || busy); return () => onDirtyChange(false); }, [draft, busy, onDirtyChange]);
  useEffect(() => setConsent(false), [event?.row.id]);
  function clearDraft() { setDraft(undefined); setNewAction(false); setConfirmed(false); setSourceEventId(""); setOccurredAt(""); }
  const sourceEvents = events.filter(item => item.kind !== "action" && item.row.jdSnapshotId === decision?.jdSnapshotId && decision && Date.parse(item.at) >= Date.parse(decision.createdAt));
  function actionOptions() {
    const source = sourceEvents.find(item => item.kind + item.row.id === sourceEventId);
    const sourceEvent = source && source.kind !== "action" ? { kind: source.kind, id: source.row.id } : undefined;
    return { sourceEvent, occurredAt: sourceEvent || !occurredAt ? undefined : parseOpportunityDateTimeInput(occurredAt) };
  }
  function evidenceCount(evidence: OpportunityDecisionEvidence) {
    return t(`${evidence.supported}/${evidence.total} 项要求已有支持，${evidence.partial} 项部分支持；${evidence.independentRetests.length} 项独立复测记录`, `${evidence.supported}/${evidence.total} requirements supported, ${evidence.partial} partially supported; ${evidence.independentRetests.length} independent retest records`);
  }
  const versionLabel = (version?: OpportunityDecisionReceipt["officialVersion"]) => version
    ? t(`正式版本 ${version.versionId}`, `Official version ${version.versionId}`)
    : t("正式版本尚未核实", "Official version unverified");
  const decisionDetails = (receipt: OpportunityDecisionReceipt) => <div className="opportunity-decision-summary">
    <strong className="opportunity-decision-title">{actions[receipt.action]}</strong>
    <p>{reasons[receipt.reasonCode]}</p>
    <p>{evidenceCount(receipt.evidence)}</p>
    <p className="opportunity-review-meta">{versionLabel(receipt.officialVersion)}</p>
    {receipt.evidence.independentRetests.length > 0 && <details><summary>{t("当时的独立复测依据", "Independent retest evidence at the time")}</summary><ul>{receipt.evidence.independentRetests.map(ref => <li key={ref.sourceVersion}>{t("训练", "Training")} {ref.kitId} · {ref.result === "met" ? t("达成", "Met") : ref.result === "missed" ? t("未达成", "Missed") : t("待核对", "Not reviewed")}</li>)}</ul></details>}
  </div>;
  const formDecision = newAction ? decision : actionDecision;
  const feedbackOrigin = job.application.communications.find(row => row.id === review?.feedbackCommunicationId);
  const feedbackOptions = job.application.communications.filter(row => row.direction === "inbound" && (recordedAction ? Date.parse(row.occurredAt) >= Date.parse(recordedAction.occurredAt) : true));
  return <details className="opportunity-event-review">
    <summary>{t("行动与反馈复盘", "Review actions and feedback")}</summary>
    <div className="opportunity-review-content">
    {onRecommend && <section className="opportunity-decision-section">
      {decision && <>
        <label>{t("建议版本", "Advice version")}<select value={decision.id} disabled={!!draft || busy} onChange={e => setSelectedDecision(e.target.value)}>{job.decisions?.slice().reverse().map(row => <option key={row.id} value={row.id}>{when(row.createdAt)} · {actions[row.action]}</option>)}</select></label>
        {decisionDetails(decision)}
      </>}
      <div className="opportunity-review-actions">
        <button type="button" className="studio-button primary" disabled={disabled || busy || !!draft || !job.description.trim()} onClick={async () => { setBusy(true); try { if (await onRecommend()) setSelectedDecision(""); } finally { setBusy(false); } }}>{decision ? t("根据当前证据更新建议", "Update advice from current evidence") : t("生成行动建议", "Recommend an action")}</button>
        {decision && onRecordAction && <button type="button" className="studio-button" disabled={disabled || busy || !!draft} onClick={() => { setNewAction(true); setConfirmed(false); setDraft({ ...emptyReview, action: decision.action }); }}>{t("记录实际采取的行动", "Record the action actually taken")}</button>}
      </div>
    </section>}
    {event && !newAction && <section className="opportunity-review-event">
      <label>{t("选择阶段或沟通记录", "Choose a stage or communication record")}
        <select disabled={!!draft || busy} value={event.kind + event.row.id} onChange={e => setSelected(e.target.value)}>
          {events.map(item => <option key={item.kind + item.row.id} value={item.kind + item.row.id}>{when(item.at)} · {item.label}</option>)}
        </select>
      </label>
      {"summary" in event.row && <p>{event.row.summary}</p>}
      {jd ? <details><summary>{t("当时的岗位原文", "Job description at the time")} · {jd.title}</summary>
        <p>{jd.company} · {when(jd.capturedAt)}</p><pre>{jd.description || t("未保存正文", "No description saved")}</pre>
        {jd.sourceUrl && <a href={jd.sourceUrl} target="_blank" rel="noreferrer">{t("岗位来源", "Job source")}</a>}
      </details> : <p>{t("这条记录的岗位版本未知。", "The job version for this event is unknown.")}</p>}
      {!draft && <>
        {actionDecision ? <details><summary>{t("为什么当时建议这样做", "Why this action was recommended")}</summary>{decisionDetails(actionDecision)}</details> : linkedAction ? <button type="button" className="studio-button" onClick={() => setSelected("action" + linkedAction.id)}>{t("查看关联的行动复盘", "Review the linked action")}</button> : <p>{t("系统当时的建议未知。", "The system advice at that time is unknown.")}</p>}
        {review && <div className="opportunity-review-record"><p><strong>{actions[review.action]}</strong> · {review.reason}</p>
          <p>{feedback[review.feedback]}{review.observation && ' · ' + review.observation}</p>
          {feedbackOrigin && <p>{t("反馈来源", "Feedback source")} · {when(feedbackOrigin.occurredAt)} · {feedbackOrigin.summary}</p>}
          {recordedAction && <p>{outcomeLabels[review.outcome ?? "unknown"]} · {review.afterEvidence ? evidenceCount(review.afterEvidence) : t("后续独立复测未知", "Later independent retest unknown")}</p>}
          {material ? <details><summary>{material.resumeName} · {when(material.createdAt)}</summary><pre>{material.markdown}</pre></details> : <p>{t("未关联简历材料", "No resume snapshot linked")}</p>}
          {recordedAction && <p className="opportunity-review-meta">{versionLabel(review.officialVersion)}</p>}
          <small>{t("复盘记录于", "Reviewed on")} {when(review.reviewedAt)}</small>
        </div>}
        {recordedAction?.previousReviews?.length ? <details><summary>{t("历史复盘", "Previous reviews")}</summary><ul>{recordedAction.previousReviews.map((row, index) => <li key={index}>{when(row.reviewedAt)} · {actions[row.action]} · {row.reason} · {feedback[row.feedback]} {row.observation} · {versionLabel(row.officialVersion)}{row.afterEvidence && ` · ${evidenceCount(row.afterEvidence)}`}</li>)}</ul></details> : null}
        <button type="button" className="studio-button" disabled={disabled || busy} onClick={() => { setSelected(event.kind + event.row.id); setDraft(review ?? emptyReview); }}>
          {review ? t("修正复盘", "Edit review") : t("记录行动理由与反馈", "Record the rationale and feedback")}
        </button>
        {recordedAction && onEvaluate && <section className="opportunity-review-consent">
          {recordedAction.evaluationSample ? <><p>{t("已授权此匿名评审样本，仅在本地记录。", "This anonymous evaluation sample is authorized and recorded locally.")}</p><div className="opportunity-review-actions">
            <button type="button" className="studio-button" onClick={() => onExportSample?.(recordedAction.id)}>{t("下载匿名样本", "Download anonymous sample")}</button>
            <button type="button" className="studio-button" disabled={disabled || busy} onClick={() => { if (onEvaluate(recordedAction.id, false)) setConsent(false); }}>{t("撤回样本授权", "Withdraw sample consent")}</button>
          </div></> : <><label className="opportunity-decision-confirm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{t("同意将本次复盘保存为匿名评审样本（仅行动类型、结果状态、复测状态和是否改选，不含正文及身份）。", "I consent to saving this anonymous review sample locally (action types, outcome, retest status and changed decision only).")}</label>
            <button type="button" className="studio-button" disabled={disabled || busy || !consent} onClick={() => { if (onEvaluate(recordedAction.id, true)) setConsent(false); }}>{t("记录匿名样本", "Record anonymous sample")}</button></>}
        </section>}
      </>}
    </section>}
    {draft && <form className="application-communication-form" onSubmit={e => { e.preventDefault(); if (disabled || busy) return; if (newAction ? confirmed && !!decision && onRecordAction?.(decision.id, draft, actionOptions()) : event && onSave(event.kind, event.row.id, draft)) { if (newAction) setSelected(""); clearDraft(); } }}>
      {newAction && <><label>{t("已有阶段或沟通记录", "Existing stage or communication record")}<select value={sourceEventId} onChange={e => setSourceEventId(e.target.value)}><option value="">{t("新记录", "New record")}</option>{sourceEvents.map(item => <option key={item.kind + item.row.id} value={item.kind + item.row.id}>{when(item.at)} · {item.label}</option>)}</select></label>
      {!sourceEventId && <label>{t("实际行动时间（北京时间，可留空记录此刻）", "Actual action time (Beijing time; leave blank for now)")}<input type="datetime-local" step={1} value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></label>}</>}
      <label>{t("当时采取的行动", "Action taken")}<select value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value as ReviewInput["action"] })}>
        {Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{t("当时为什么这样做", "Why you took this action")}<textarea required maxLength={2000} value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} /></label>
      <label>{t("实际使用的简历快照", "Resume snapshot actually used")}<select value={draft.materialId ?? ""} onChange={e => setDraft({ ...draft, materialId: e.target.value || undefined })}>
        <option value="">{t("未选或未使用", "Unknown or unused")}</option>
        {job.materials.map(m => <option key={m.id} value={m.id}>{m.resumeName} · {when(m.createdAt)} · {m.locale} · {m.officialVersion ? t("正式版本", "Official version") : t("未核实版本", "Unverified version")}</option>)}
      </select></label>
      {formDecision && onCaptureMaterial && <button className="studio-button" type="button" disabled={disabled || busy} onClick={async () => { setBusy(true); try { const materialId = await onCaptureMaterial(); if (materialId) setDraft(current => current && { ...current, materialId }); } finally { setBusy(false); } }}>{t("记录当前简历作为使用材料", "Record current resume as the material used")}</button>}
      <label>{t("反馈来源", "Feedback source")}<select value={draft.feedback} onChange={e => setDraft({ ...draft, feedback: e.target.value as ReviewInput["feedback"], observation: "", outcome: undefined, feedbackCommunicationId: undefined })}>
        {Object.entries(feedback).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {draft.feedback !== "unobserved" && <label>{feedback[draft.feedback]}<textarea required maxLength={2000} value={draft.observation} onChange={e => setDraft({ ...draft, observation: e.target.value })} /></label>}
      {formDecision && !newAction && draft.feedback === "reported" && feedbackOptions.length > 0 && <label>{t("关联已有沟通反馈", "Link existing communication feedback")}<select value={draft.feedbackCommunicationId ?? ""} onChange={e => { const origin = feedbackOptions.find(row => row.id === e.target.value); setDraft({ ...draft, feedbackCommunicationId: origin?.id, observation: origin?.summary.slice(0, 2000) ?? draft.observation }); }}><option value="">{t("手动填写", "Enter manually")}</option>{feedbackOptions.map(row => <option key={row.id} value={row.id}>{when(row.occurredAt)} · {row.summary.slice(0, 80)}</option>)}</select></label>}
      {formDecision && draft.feedback === "reported" && <label>{t("明确反馈的结果", "Observed outcome")}<select value={draft.outcome ?? "unknown"} onChange={e => setDraft({ ...draft, outcome: e.target.value as OpportunityEventReview["outcome"] })}>
        {Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>}
      {formDecision && onReadEvidence && <div className="application-communication-actions">
        <button type="button" className="studio-button" disabled={busy || disabled} onClick={async () => { setBusy(true); try { const evidence = await onReadEvidence(formDecision); if (evidence) setDraft(current => current && { ...current, afterEvidence: evidence }); } finally { setBusy(false); } }}>{t("核对当前独立复测", "Check current independent retests")}</button>
        {draft.afterEvidence && <span>{evidenceCount(draft.afterEvidence)}</span>}
      </div>}
      {newAction && <label className="application-communication-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t("我确认这项行动已经实际发生。", "I confirm that this action has actually taken place.")}</label>}
      <div className="application-communication-actions">
        <button type="button" className="studio-button" disabled={busy} onClick={clearDraft}>{t("取消", "Cancel")}</button>
        <button type="submit" className="studio-button primary" disabled={disabled || busy || (newAction && !confirmed)}>{t("保存复盘", "Save review")}</button>
      </div>
    </form>}
    </div>
  </details>;
}
