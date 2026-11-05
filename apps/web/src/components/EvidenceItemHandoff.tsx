import { useRef, useState } from "react";
import { EvidenceDecision as DecisionSchema } from "@better-me/agent-contracts";
import type { CapabilityTask, EvidenceDecision, EvidenceReviewCommand, EvidenceProposalCommand, WorkspaceEvidenceSnapshot } from "@better-me/agent-contracts";

const emptyClaim = { kind: "implementation" as const, action: "", role: "", deployment: "" };
const decisionLabels = { implementation: "本人实际实现", design: "仅参与设计", "not-mine": "不是我做的", unknown: "暂不确定" };
export function EvidenceItemHandoff({ task, itemIndex, workspace, busy, review, propose, revoke }: {
  task: CapabilityTask; itemIndex: number; workspace?: WorkspaceEvidenceSnapshot; busy: boolean;
  review: (command: EvidenceReviewCommand) => Promise<boolean>; propose: (command: EvidenceProposalCommand) => Promise<boolean>;
  revoke: () => Promise<unknown>;
}) {
  const history = (workspace?.reviews ?? []).filter(item => item.source.taskId === task.id && item.source.itemIndex === itemIndex);
  const latest = history.at(-1), proposals = (workspace?.proposals ?? []).filter(item => item.source.taskId === task.id && item.source.itemIndex === itemIndex);
  const [decision, setDecision] = useState<EvidenceDecision>(latest?.decision ?? emptyClaim);
  const [baseRevision, setBaseRevision] = useState<number>(), [consent, setConsent] = useState(false);
  const [proposalConsentFor, setProposalConsentFor] = useState<string>();
  const operation = useRef<{ payload: string; key: string } | undefined>(undefined);
  const proposalOperation = useRef<{ reviewId: string; key: string } | undefined>(undefined);
  const editable = task.stage === "completed" && task.receipt && !task.grant.revoked && !task.reviewReason;
  const claimed = decision.kind === "implementation" || decision.kind === "design";
  const normalized = DecisionSchema.safeParse(decision);
  const dirty = Boolean(latest && (!normalized.success || JSON.stringify(normalized.data) !== JSON.stringify(latest.decision)));
  const stale = baseRevision !== undefined && baseRevision !== (workspace?.revision ?? 0);
  const change = (value: EvidenceDecision) => { setDecision(value); setBaseRevision(value => value ?? workspace?.revision ?? 0); setConsent(false); setProposalConsentFor(undefined); };
  const reset = () => { setDecision(latest?.decision ?? emptyClaim); setBaseRevision(workspace?.revision ?? 0); setConsent(false); setProposalConsentFor(undefined); };
  const save = async () => {
    if (!consent || !task.receipt || !task.outputHash || stale) return;
    const payload = { taskId: task.id, reportReceiptId: task.receipt.id, reportHash: task.outputHash, itemIndex,
      expectedRevision: baseRevision ?? workspace?.revision ?? 0, decision, consent: true as const };
    const serialized = JSON.stringify(payload);
    if (operation.current?.payload !== serialized) operation.current = { payload: serialized, key: crypto.randomUUID() };
    if (await review({ ...payload, idempotencyKey: operation.current.key })) { setConsent(false); setBaseRevision(undefined); }
  };
  const createProposal = async () => {
    if (!latest || proposalConsentFor !== latest.id || dirty) return;
    if (proposalOperation.current?.reviewId !== latest.id) proposalOperation.current = { reviewId: latest.id, key: crypto.randomUUID() };
    if (await propose({ reviewId: latest.id, expectedRevision: workspace?.revision ?? 0,
      idempotencyKey: proposalOperation.current.key, consent: true })) setProposalConsentFor(undefined);
  };
  return <details className="evidence-handoff" onToggle={event => { if (event.currentTarget.open && baseRevision === undefined) reset(); }}>
    <summary>{latest ? `本人核对：${decisionLabels[latest.decision.kind]} · 修订 ${history.length}` : "核对或纠正我的贡献"}</summary>
    <p>这里保存本人自述，不是系统真实性认证；项目材料不会自动变成个人成果。</p>
    {!editable && <p>本报告已撤权或需重新核对，不能继续交接；已有核对和提案历史保留。</p>}
    <label>贡献归属<select aria-label="贡献归属" disabled={busy || !editable} value={decision.kind} onChange={event => {
      const kind = event.target.value as EvidenceDecision["kind"];
      change(kind === "implementation" || kind === "design" ? { ...emptyClaim, kind } : { kind, note: "" });
    }}>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {claimed && "action" in decision ? <>
      <label>我具体做了什么<textarea aria-label="本人具体动作" rows={3} maxLength={2500} value={decision.action} disabled={busy || !editable} onChange={event => change({ ...decision, action: event.target.value })} /></label>
      <label>我的职责<input aria-label="本人职责" maxLength={300} value={decision.role} disabled={busy || !editable} onChange={event => change({ ...decision, role: event.target.value })} /></label>
      <label>实际使用阶段<input aria-label="实际使用阶段" maxLength={600} placeholder="例如：仅设计、合成实验、试用；未知可以留空" value={decision.deployment} disabled={busy || !editable} onChange={event => change({ ...decision, deployment: event.target.value })} /></label>
    </> : "note" in decision && <label>纠正或待核对说明<textarea aria-label="纠正说明" rows={3} maxLength={2500} value={decision.note} disabled={busy || !editable} onChange={event => change({ ...decision, note: event.target.value })} /></label>}
    {stale && <p role="status">核对版本已有变化。当前输入保留；请先核对最新记录，再重新授权。<button type="button" onClick={reset} disabled={busy}>载入最新核对</button></p>}
    <label className="capability-consent"><input type="checkbox" aria-label="仅保存本次本人核对" checked={consent} disabled={busy || !editable || stale} onChange={event => { setConsent(event.target.checked); setProposalConsentFor(undefined); }} />仅保存本次本人核对或纠正，不采用到Fact或简历。</label>
    <button type="button" className="studio-button" disabled={busy || !editable || !consent || stale || (claimed && "action" in decision && !decision.action.trim())} onClick={() => void save()}>保存本人核对</button>
    {latest && <p>当前自述：{decisionLabels[latest.decision.kind]} · {"action" in latest.decision ? latest.decision.action : latest.decision.note || "未补充说明"} · 核对回执 {latest.receipt.id}</p>}
    {latest && ["implementation", "design"].includes(latest.decision.kind) && !proposals.some(item => item.reviewId === latest.id) && <>
      {dirty && <p role="status">当前自述的修改尚未保存，请先重新核对并保存，再创建提案。</p>}
      <label className="capability-consent"><input type="checkbox" aria-label="仅创建待审核提案" disabled={busy || !editable || stale || consent || dirty} checked={proposalConsentFor === latest.id} onChange={event => setProposalConsentFor(event.target.checked ? latest.id : undefined)} />仅将已保存的这次自述创建为待业务审核提案，不写正式职业资产。</label>
      <button type="button" className="studio-button" disabled={busy || !editable || stale || consent || dirty || proposalConsentFor !== latest.id} onClick={() => void createProposal()}>创建待审核提案</button>
    </>}
    {proposals.map(proposal => <div key={proposal.id} className="evidence-proposal"><strong>{proposal.eligibility === "current" ? "待业务审核 · 未采用到简历" : proposal.eligibility === "review_superseded" ? "历史提案 · 本人核对已修订，不再有效" : "历史提案 · 来源授权或验证已变化，不再有效"}</strong>
      <p>{proposal.candidate.kind === "design" ? "仅设计：" : "本人自述实现："}{proposal.candidate.action}</p><p>{proposal.candidate.role} {proposal.candidate.deployment}</p>
      <small>提案 {proposal.id} · 保存回执 {proposal.receipt.id}</small><p>{proposal.limitations.join(" ")}</p></div>)}
    {history.length > 1 && <details><summary>历次本人核对（不覆盖）</summary>{history.map(item => <p key={item.id}>{item.receipt.at} · {decisionLabels[item.decision.kind]} · {"action" in item.decision ? item.decision.action : item.decision.note}</p>)}</details>}
    {editable && <button type="button" disabled={busy} onClick={() => void revoke()}>撤销此报告的后续交接授权（保留历史）</button>}
  </details>;
}
