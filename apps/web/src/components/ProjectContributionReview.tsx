import { useId, useState } from "react";
import { z } from "zod";
import type { ContributionLead, UnderstandingSession } from "@better-me/agent-contracts";
import { ContributionDraftSchema, contributionSupplement, emptyContributionDraft, type ContributionDraft } from "../lib/project-contribution";

type Props = { session: UnderstandingSession; lead: ContributionLead; enabled: boolean;
  onDiscuss: (answer: string) => void; onPrepare?: (supplement: string) => void };
const StoredDraftSchema = z.object({ summaryHash: z.string(), draft: ContributionDraftSchema });

/** Mounted by versioned lead identity; no model request or résumé mutation occurs here. */
export function ProjectContributionReview({ session, lead, enabled, onDiscuss, onPrepare }: Props) {
  const uid = useId();
  const storageKey = `betterme.contribution.v1:${session.id}:${lead.id}`;
  const [restored] = useState(() => {
    try { const raw = localStorage.getItem(storageKey); if (raw) return { ...StoredDraftSchema.parse(JSON.parse(raw)), error: "" }; }
    catch { return { summaryHash: session.summaryHash ?? "", draft: emptyContributionDraft(), error: "贡献草稿未能恢复；原记录没有被自动覆盖，请先保留重要输入。" }; }
    return { summaryHash: session.summaryHash ?? "", draft: emptyContributionDraft(), error: "" };
  });
  const [draft, setDraft] = useState<ContributionDraft>(restored.draft);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(restored.error);
  function update(patch: Partial<ContributionDraft>) {
    const next = { ...draft, ...patch }; setDraft(next); setChecked(false);
    try { localStorage.setItem(storageKey, JSON.stringify({ summaryHash: session.summaryHash ?? "", draft: next })); setError(""); }
    catch { setError("贡献草稿尚未保存，请保留输入；不会写入简历或自动发送。"); }
  }
  const supplement = contributionSupplement(draft);
  return <details className="contribution-lead">
    <summary>{lead.title} <span>待本人认领</span></summary>
    {restored.summaryHash !== session.summaryHash && <p className="understanding-alert">已恢复上一版线索的个人草稿；项目理解已更新，请对照新依据重新核对，原确认不自动沿用。</p>}
    <p className="understanding-hint">Agent 假设 · {lead.hypothesis}（不是已确认事实）</p>
    <details><summary>查看线索依据</summary>{lead.evidenceIds.map(id => {
      const evidence = session.evidence.find(item => item.id === id);
      const message = session.messages.find(item => item.id === id);
      return <blockquote key={id}>{evidence ? <><strong>{evidence.path} · {evidence.startLine}–{evidence.endLine} 行</strong><p>{evidence.excerpt || "授权已撤销"}</p></> : message?.text ?? "该引用暂不可用，不能据此确认贡献"}</blockquote>;
    })}</details>
    <p><strong>{lead.question}</strong></p>
    {lead.options.length > 0 && <div className="understanding-actions" aria-label="Agent 生成的回答方向">{lead.options.map((option, index) => <button type="button" key={index} onClick={() => {
      const answer = draft.answer.includes(option) ? draft.answer : [draft.answer, option].filter(Boolean).join("\n");
      if (answer.length > 2500) { setError("回答已达长度限制，未覆盖原输入；请先整理草稿。"); return; }
      update({ answer });
    }}>{option}</button>)}</div>}
    <p className="understanding-hint">选项只填入待核对草稿，可自由改写；不确定或不方便披露也可以直接说明。</p>
    <label htmlFor={`${uid}-stage`}>这条线索与你的关系</label>
    <select id={`${uid}-stage`} value={draft.stage} onChange={event => update({ stage: event.target.value as ContributionDraft["stage"] })}>
      <option value="">请选择，不默认认领</option><option value="implementation">我实际实现过</option><option value="design">我参与了设计，尚未声明落地</option><option value="not-mine">不是我做的</option><option value="unknown">不确定／暂不认领</option>
    </select>
    <label htmlFor={`${uid}-answer`}>我的回答与个人动作</label><textarea id={`${uid}-answer`} rows={3} maxLength={2500} value={draft.answer} onChange={event => update({ answer: event.target.value })} placeholder="写清你做了哪部分、团队做了哪部分；也可以纠正 Agent 的猜测。" />
    <details className="contribution-context"><summary>补充职责、客户与使用现场（可选）</summary>
      <label htmlFor={`${uid}-role`}>本人职责（不确定可留空）</label><input id={`${uid}-role`} maxLength={300} value={draft.role} onChange={event => update({ role: event.target.value })} placeholder="例如：负责运单拆解模块；不是整个项目负责人" />
      <label htmlFor={`${uid}-deployment`}>我的工作在哪个阶段使用</label><input id={`${uid}-deployment`} maxLength={600} value={draft.deployment} onChange={event => update({ deployment: event.target.value })} placeholder="例如：内部验证／客户试点／已在现场使用；不知道可留空" />
      <label htmlFor={`${uid}-customer`}>客户或现场私有备注（仅本机草稿，不发送）</label><input id={`${uid}-customer`} maxLength={600} value={draft.customerPrivate} onChange={event => update({ customerPrivate: event.target.value })} placeholder="可留空或写不便披露；请勿填入保密信息" />
      <label htmlFor={`${uid}-public`}>可公开描述（优先行业、场景，不写客户真名）</label><input id={`${uid}-public`} maxLength={600} value={draft.publicContext} onChange={event => update({ publicContext: event.target.value })} placeholder="例如：半导体制造客户的物料搬运现场" />
      <label className="understanding-consent"><input type="checkbox" checked={draft.disclose} onChange={event => update({ disclose: event.target.checked })} />允许把上面的可公开描述交给伴写并用于候选</label>
    </details>
    {!enabled && <p className="understanding-hint">先核对并确认本版项目理解，再认领贡献或向 Agent 继续追问。草稿会保留。</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!enabled} onClick={() => onDiscuss(`请继续核对这条贡献线索，不要把假设当事实：${lead.question}\n我的回答：${draft.answer || "仍不确定，请依据现有材料提出更具体的问题；不要求披露客户真名。"}\n认领状态：${draft.stage || "尚未认领"}`)}>围绕这条线索继续问（先预览）</button>
    {supplement && <><details><summary>预览将交给伴写的补充</summary><pre>{supplement}</pre></details><label className="understanding-consent"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />我确认这些是我的实际经历；设计方案没有被当作已上线成果</label></>}
    {onPrepare && <button type="button" className="understanding-primary" disabled={!enabled || !supplement || !checked} onClick={() => { if (supplement && checked) onPrepare(supplement); }}>带入伴写核对，不修改简历</button>}
  </details>;
}
