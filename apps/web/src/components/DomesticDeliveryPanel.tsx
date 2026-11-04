import { useCallback, useEffect, useState } from "react";
import { BellRing, CheckCheck, ExternalLink, Smartphone } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { deliveryAttention, deliveryIsCurrent, deliveryPlatform, type DeliveryAction, type DeliveryCommand, type DeliveryInput, type DeliveryPlan, type DeliveryReceipt } from "../lib/domestic-delivery";
import { opportunityDateTimeInput, parseOpportunityDateTimeInput, type Opportunity } from "../lib/opportunities";
import "./domestic-delivery.css";

type Props = {
  job: Opportunity; disabled: boolean; onDirtyChange: (dirty: boolean) => void;
  onPrepare: (input: DeliveryInput) => boolean;
  onCommand: (id: string, command: DeliveryCommand) => boolean;
};
const PLATFORMS = { boss: "BOSS 直聘", "51job": "51job", liepin: "猎聘" };
export function DomesticDeliveryPanel({ job, disabled, onDirtyChange, onPrepare, onCommand }: Props) {
  const { t } = useUiPreferences();
  const platform = deliveryPlatform(job.applicationUrl || job.sourceUrl);
  const [action, setAction] = useState<DeliveryAction>("greeting");
  const [account, setAccount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [onlineResume, setOnlineResume] = useState("");
  const [attachments, setAttachments] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, boolean>>({});
  const receiptDirtyChanged = useCallback((id: string, dirty: boolean) => setReceiptDrafts(current => current[id] === dirty ? current : { ...current, [id]: dirty }), []);
  const dirty = !!(account || recipient || materialId || onlineResume || attachments || message || Object.values(receiptDrafts).some(Boolean));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (!platform) return;
    if (onPrepare({ platform, action, account, recipient, materialId, onlineResume, attachments, message })) {
      setAccount(""); setRecipient(""); setMaterialId(""); setOnlineResume(""); setAttachments(""); setMessage(""); setError("");
      setNotice(t("草稿已保存。展开行动卡核对后，再由你去官方平台完成操作。", "Draft saved. Review its action card before completing the action on the official platform."));
    }
  }
  const actionLabels = { greeting: t("发起沟通", "Send a greeting"), share_resume: t("共享简历", "Share a resume"), application: t("提交岗位申请", "Submit an application") };
  return <details className="delivery-panel" data-delivery-assistant>
    <summary><Smartphone size={18} /><span>{t("国内平台 · 投递行动卡", "China platforms · Application action cards")}</span><span className="delivery-count">{job.deliveryPlans?.length ?? 0}</span></summary>
    <div className="delivery-panel-body">
      <div className="delivery-intro"><strong>{t("准备充分，再由你发送", "Prepare carefully. You stay in control.")}</strong><p>{t("当前支持准备、站内待办和本人回执；不采集手机、不自动点击或群发，也不保证防封。打开链接不算已投递。", "Preparation, in-app follow-ups and personal receipts only. No phone capture, automated taps or bulk sending. Account safety is not guaranteed. Opening a link is not applying.")}</p></div>
      <div className="delivery-cards">{(job.deliveryPlans ?? []).slice().reverse().map(plan => <DeliveryCard key={plan.id} job={job} plan={plan} disabled={disabled} actionLabel={actionLabels[plan.action]} onDirtyChange={receiptDirtyChanged} onCommand={onCommand} />)}</div>
      {!platform ? <p className="delivery-warning">{t("先在岗位信息中填写 BOSS、51job 或猎聘的 HTTPS 官方岗位链接；不接受短链或其他平台链接。", "Add a BOSS, 51job or Liepin HTTPS job URL in job details first. Short links and other platforms are not supported.")}</p> : <form className="delivery-form" onSubmit={prepare}>
        <div className="delivery-form-grid">
          <label>{t("平台", "Platform")}<input readOnly value={PLATFORMS[platform]} /></label>
          <label>{t("本次动作", "Action")}<select value={action} onChange={event => setAction(event.target.value as DeliveryAction)}>{Object.entries(actionLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label>{t("平台账号标记", "Platform account label")}<input required maxLength={200} value={account} onChange={event => setAccount(event.target.value)} placeholder={t("仅便于本人辨认，不填密码或验证码", "A personal label, never a password or code")} /></label>
          <label>{t("接收对象", "Recipient")}<input required maxLength={300} value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={t("公司、招聘者或猎头的明确标记", "Identify the company, recruiter or headhunter")} /></label>
          <label>{t("材料快照", "Material snapshot")}<select required={action !== "greeting"} value={materialId} onChange={event => setMaterialId(event.target.value)}><option value="">{t("不带简历 / 请选择", "No resume / Select a snapshot")}</option>{job.materials.map(item => <option value={item.id} key={item.id}>{item.resumeName} · {opportunityDateTimeInput(item.createdAt).replace("T", " ")}</option>)}</select></label>
          <label>{t("官方平台在线简历版本", "Online resume version on the platform")}<input required={action !== "greeting"} maxLength={500} value={onlineResume} onChange={event => setOnlineResume(event.target.value)} placeholder={t("本人核对版本；不分享时写“无”", "Check the version; enter None if not shared")} /></label>
        </div>
        <label>{t("平台附件与实际分享范围", "Platform attachments and sharing scope")}<input required={action !== "greeting"} maxLength={1000} value={attachments} onChange={event => setAttachments(event.target.value)} placeholder={t("附件名称/版本、联系方式等；没有附件写“无”", "Attachment names/versions, contact details; enter None if absent")} /></label>
        {platform === "51job" && <p className="delivery-warning">{t("51job 的快速申请默认版本可能不同，在线简历与已上传附件也可能同时可见。请在官方平台逐项检查，不能只核对本地快照。", "51job quick-apply defaults may differ. Online and uploaded resumes may both be visible. Check the actual platform, not only this local snapshot.")}</p>}
        {action !== "greeting" && !job.materials.length && <p className="delivery-warning">{t("尚无材料快照。先在下方“投递材料快照”记录当前简历，再准备共享或申请。快照是 Markdown 核对件，不是已经上传的 PDF。", "Save a resume under Material snapshots below first. It is a Markdown reference, not an uploaded PDF.")}</p>}
        <label>{t("待发文案（不会自动发送）", "Message draft (not sent automatically)")}<textarea rows={3} maxLength={5000} value={message} onChange={event => setMessage(event.target.value)} /></label>
        <div className="delivery-buttons"><button type="submit" className="studio-button" disabled={disabled}>{t("保存行动草稿", "Save action draft")}</button><span>{t("账号标记不是登录凭据；不保存 Cookie。", "An account label is not a credential. Cookies are not saved.")}</span></div>
      </form>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <p className="delivery-footnote">{t("手机桥接 / OpenCV / 无人值守发送尚未接入。人工确认不能替代平台许可。", "Phone bridging, OpenCV and unattended sending are not connected. Personal approval does not replace platform permission.")}</p>
    </div>
  </details>;
}

function DeliveryCard({ job, plan, disabled, actionLabel, onCommand, onDirtyChange }: { job: Opportunity; plan: DeliveryPlan; disabled: boolean; actionLabel: string; onCommand: Props["onCommand"]; onDirtyChange: (id: string, dirty: boolean) => void }) {
  const { t } = useUiPreferences();
  const [checked, setChecked] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [outcome, setOutcome] = useState<DeliveryReceipt["outcome"]>("outcome_unknown");
  const [basis, setBasis] = useState<DeliveryReceipt["basis"]>("personal_confirmation");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const current = deliveryIsCurrent(plan, job);
  const dirty = !!(note || occurredAt || confirmed);
  useEffect(() => { onDirtyChange(plan.id, dirty); return () => onDirtyChange(plan.id, false); }, [dirty, onDirtyChange, plan.id]);
  const statuses = { draft: t("待核对", "Needs review"), ready: t("已核对 · 待本人操作", "Reviewed · Your action needed"), handed_off: t("已打开平台 · 待核实", "Platform opened · Verify result"), outcome_unknown: t("结果待核实 · 不重发", "Result unknown · Do not resend"), confirmed: t("本人确认已完成", "Personally confirmed"), not_sent: t("本人确认未发送", "Confirmed not sent"), cancelled: t("已取消准备", "Preparation cancelled") };
  function receipt(event: React.FormEvent) {
    event.preventDefault();
    try {
      const at = parseOpportunityDateTimeInput(occurredAt);
      if (!at) throw new Error(t("填写实际发生/核实时间。", "Enter the time of the action or verification."));
      if (onCommand(plan.id, { kind: "receipt", confirmed, receipt: { outcome, basis, note, occurredAt: at } })) {
        setNote(""); setOccurredAt(""); setConfirmed(false); setReceiptOpen(false); setError("");
      }
    } catch (error) { setError(error instanceof Error ? error.message : t("回执保存失败。", "Could not save the receipt.")); }
  }
  return <article className="delivery-card" data-status={plan.status}>
    <header><strong>{actionLabel}</strong><span>{statuses[plan.status]}</span></header>
    <dl><dt>{t("对象", "Target")}</dt><dd>{PLATFORMS[plan.platform]} · {plan.account} → {plan.recipient}</dd><dt>{t("岗位", "Job")}</dt><dd>{plan.company} · {plan.title}</dd><dt>{t("材料", "Materials")}</dt><dd>{plan.materialSnapshot?.resumeName || t("不带简历", "No resume")}{plan.onlineResume && ` · ${plan.onlineResume}`}{plan.attachments && ` · ${plan.attachments}`}</dd></dl>
    {plan.materialSnapshot && <details><summary>{t("核对不可变材料快照", "Review immutable material snapshot")}</summary><pre>{plan.materialSnapshot.markdown}</pre></details>}
    {plan.message && <pre className="delivery-message">{plan.message}</pre>}
    {!current && (plan.status === "draft" || plan.status === "ready") && <p className="delivery-warning">{t("岗位或材料已变更，旧核对失效。取消这张卡，再按当前内容准备。", "The job or material changed. Cancel this card and prepare a new one.")}</p>}
    {plan.status === "draft" && <><label className="delivery-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />{t("已核对岗位、账号、对象、文案及平台实际分享的全部简历。仅确认准备，不授权自动发送。", "I checked the job, account, recipient, message and all resumes shared on the platform. This reviews preparation, not automatic sending.")}</label><button className="studio-button" disabled={disabled || !checked || !current} onClick={() => onCommand(plan.id, { kind: "review", confirmed: checked })}><CheckCheck size={14} />{t("确认本次准备", "Confirm preparation")}</button></>}
    {plan.status === "ready" && current && <a className={`studio-button${disabled ? " disabled" : ""}`} href={disabled ? undefined : plan.url} aria-disabled={disabled} target="_blank" rel="noopener noreferrer" onClick={event => { if (disabled || !onCommand(plan.id, { kind: "handoff" })) event.preventDefault(); }}>{t("本人去官方平台操作", "Continue on the official platform")}<ExternalLink size={14} /></a>}
    {(plan.status === "draft" || plan.status === "ready") && <button className="studio-button" disabled={disabled} onClick={() => onCommand(plan.id, { kind: "cancel" })}>{t("取消准备", "Cancel preparation")}</button>}
    {["ready", "handed_off", "outcome_unknown"].includes(plan.status) && <button className="studio-button" disabled={disabled} onClick={() => setReceiptOpen(!receiptOpen)} aria-expanded={receiptOpen}>{t("记录实际结果", "Record actual result")}</button>}
    {receiptOpen && <form className="delivery-receipt" onSubmit={receipt}>
      <label>{t("实际结果", "Actual result")}<select value={outcome} onChange={event => { setOutcome(event.target.value as DeliveryReceipt["outcome"]); setConfirmed(false); }}><option value="outcome_unknown">{t("结果不明，先核实", "Unknown; verify first")}</option><option value="confirmed">{t("已完成本卡动作", "This action was completed")}</option><option value="not_sent">{t("确认没有发送", "Confirmed nothing was sent")}</option></select></label>
      <label>{t("依据", "Basis")}<select value={basis} onChange={event => { setBasis(event.target.value as DeliveryReceipt["basis"]); setConfirmed(false); }}><option value="personal_confirmation">{t("本人手动确认", "Personal confirmation")}</option><option value="platform_record">{t("本人查看平台记录", "I checked a platform record")}</option></select></label>
      <label>{t("实际发生 / 核实时间（北京时间）", "Action / verification time (Beijing time)")}<input required type="datetime-local" value={occurredAt} onChange={event => { setOccurredAt(event.target.value); setConfirmed(false); }} /></label>
      <label>{t("最小回执说明", "Minimal receipt note")}<textarea required rows={2} maxLength={2000} value={note} onChange={event => { setNote(event.target.value); setConfirmed(false); }} placeholder={t("说明在哪里看到什么结果；不要粘贴完整聊天或敏感号码", "Where you saw which result; avoid full chats and sensitive numbers")} /></label>
      <label className="delivery-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("这是本人核实的记录，不是系统验证；发招呼或共享简历不等于岗位申请。", "This is my attestation, not system verification. A greeting or resume share is not an application.")}</label>
      <button className="studio-button" type="submit" disabled={disabled || !confirmed}>{t("保存本人回执", "Save personal receipt")}</button>{error && <p role="alert">{error}</p>}
    </form>}
    {!!plan.receipts.length && <ol className="delivery-receipts">{plan.receipts.map((receipt, index) => <li key={index}><strong>{receipt.outcome === "confirmed" ? t("本人确认完成", "Personally confirmed") : receipt.outcome === "not_sent" ? t("确认未发", "Not sent") : t("待核实", "Unknown")}</strong><time dateTime={receipt.occurredAt}>{opportunityDateTimeInput(receipt.occurredAt).replace("T", " ")}</time><span>{receipt.note}</span></li>)}</ol>}
  </article>;
}

export function DeliveryAttentionQueue({ jobs, onOpen }: { jobs: Opportunity[]; onOpen: (job: Opportunity) => void }) {
  const { t } = useUiPreferences();
  const items = deliveryAttention(jobs);
  if (!items.length) return null;
  return <section className="delivery-attention" aria-label={t("投递站内待办", "Application follow-ups")}><header><BellRing size={16} /><strong>{t("投递待核实", "Application checks")}</strong><span>{items.length}</span></header><p>{t("站内提醒，不发送系统通知；关闭页面后不会继续执行。结果不明时先核实，不自动重发。", "In-app only, no system notifications or execution after closing. Verify unknown results before retrying.")}</p><ul>{items.slice(0, 8).map(item => <li key={item.planId}><button type="button" onClick={() => { const job = jobs.find(job => job.id === item.jobId); if (job) onOpen(job); }}><span>{item.title}</span><small>{item.kind === "stale" ? t("材料已变更", "Materials changed") : item.kind === "unknown" ? t("结果不明", "Unknown result") : t("核实平台结果", "Check platform result")}</small></button></li>)}</ul></section>;
}
