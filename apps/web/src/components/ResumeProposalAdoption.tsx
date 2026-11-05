import { useRef, useState } from "react";
import { DocumentSchema } from "@better-me/core/document";
import { projectResume } from "@better-me/core";
import type { ResumeChangePreview, ResumeChangeRequest, WorkspaceEvidenceSnapshot } from "@better-me/agent-contracts";
import type { createCapabilityClient } from "../services/capability-client";
import { ResumeTemplate } from "./ResumeTemplate";
import "./resume-design.css";

export function ResumeProposalAdoption({ workspace, client, busy, perform }: {
  workspace?: WorkspaceEvidenceSnapshot; client: ReturnType<typeof createCapabilityClient>; busy: boolean;
  perform: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [assetId, setAssetId] = useState(""), [proposalId, setProposalId] = useState(""), [experienceId, setExperienceId] = useState("");
  const [mode, setMode] = useState<"adopt" | "undo">("adopt"), [adoptionId, setAdoptionId] = useState("");
  const [preview, setPreview] = useState<ResumeChangePreview>(), [consent, setConsent] = useState(false);
  const [name, setName] = useState("合成业务简历"), [createConsent, setCreateConsent] = useState(false), [versionId, setVersionId] = useState("");
  const generation = useRef(0), saveOperation = useRef<{ hash: string; key: string } | undefined>(undefined);
  const createOperation = useRef<{ name: string; key: string } | undefined>(undefined);
  const assets = workspace?.resumeAssets ?? [], asset = assets.find(item => item.id === assetId) ?? assets[0];
  const proposals = (workspace?.proposals ?? []).filter(item => item.eligibility === "current" && !asset?.versions.some(version => version.receipt.kind === "adopt"
    && version.receipt.proposalId === item.id && !asset.versions.some(undo => undo.receipt.undoesReceiptId === version.receipt.id)));
  const proposal = proposals.find(item => item.id === proposalId) ?? proposals[0];
  const target = asset?.targets.find(item => item.experienceId === experienceId) ?? asset?.targets[0];
  const adoptions = asset?.versions.map(item => item.receipt).filter(item => item.kind === "adopt"
    && !asset.versions.some(version => version.receipt.undoesReceiptId === item.id)) ?? [];
  const adoption = adoptions.find(item => item.id === adoptionId) ?? adoptions.at(-1);
  const request: ResumeChangeRequest | undefined = asset && (mode === "adopt" && proposal && target
    ? { kind: "adopt", assetId: asset.id, expectedVersionId: asset.headVersionId, proposalId: proposal.id, resumeId: target.resumeId, experienceId: target.experienceId }
    : mode === "undo" && adoption ? { kind: "undo", assetId: asset.id, expectedVersionId: asset.headVersionId, adoptionReceiptId: adoption.id } : undefined) || undefined;
  const stale = Boolean(preview && (!request || JSON.stringify(preview.request) !== JSON.stringify(request) || preview.authorizationRevision !== asset?.authorizationRevision));
  const clear = () => { generation.current++; setPreview(undefined); setConsent(false); };
  const displayed = asset?.versions.find(item => item.id === versionId) ?? asset?.versions.find(item => item.id === asset.headVersionId);
  const document = DocumentSchema.safeParse(displayed?.document);
  const create = () => perform(async () => {
    if (!createConsent || !workspace) return;
    if (createOperation.current?.name !== name) createOperation.current = { name, key: crypto.randomUUID() };
    setCreateConsent(false); clear();
    await client.createSyntheticResume({ name, expectedRevision: workspace.revision, idempotencyKey: createOperation.current.key, consent: true });
    client.assert();
  });
  const compare = () => perform(async () => {
    if (!request) return;
    clear(); const captured = generation.current;
    const result = await client.previewResumeChange(request); client.assert();
    if (captured === generation.current) setPreview(result);
  });
  const save = () => perform(async () => {
    if (!preview || !consent || stale) return;
    if (saveOperation.current?.hash !== preview.hash) saveOperation.current = { hash: preview.hash, key: crypto.randomUUID() };
    setConsent(false);
    await client.saveResumeChange({ preview: preview.request, previewHash: preview.hash, idempotencyKey: saveOperation.current.key, consent: true });
    client.assert(); clear(); setVersionId("");
  });
  const cancel = () => perform(async () => {
    if (!asset) return;
    clear(); await client.revokeResumePreview({ assetId: asset.id, expectedAuthorizationRevision: asset.authorizationRevision, idempotencyKey: crypto.randomUUID() });
    client.assert();
  });
  return <section className="resume-proposal-adoption" aria-label="合成简历业务采用">
    <h3>提案 → 合成业务简历</h3><p>指定目标、核对差异后单独授权。采用和撤销都追加完整版本；不连接你的默认简历、浏览器草稿或已有 Agent 记录。</p>
    <details open={!assets.length}><summary>新建独立合成简历</summary>
      <label>合成简历名称<input aria-label="合成简历名称" value={name} maxLength={80} disabled={busy} onChange={event => { setName(event.target.value); setCreateConsent(false); }} /></label>
      <label className="capability-consent"><input type="checkbox" aria-label="仅创建合成业务简历" checked={createConsent} disabled={busy} onChange={event => setCreateConsent(event.target.checked)} />仅在当前账号新建合成简历，不读取或导入真实文档。</label>
      <button type="button" disabled={busy || !createConsent || !name.trim()} onClick={() => void create()}>创建合成简历</button>
    </details>
    {asset && <>
      <label>目标简历<select aria-label="目标合成简历" value={asset.id} disabled={busy} onChange={event => { clear(); setAssetId(event.target.value); setExperienceId(""); setAdoptionId(""); setVersionId(""); }}>
        {assets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="capability-actions">{([['adopt', '采用提案'], ['undo', '撤销已采用内容']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { clear(); setMode(value); }}>{label}</button>)}</div>
      {mode === "adopt" ? <>
        <label>待审核提案<select aria-label="待采用提案" disabled={busy || !proposals.length} value={proposal?.id ?? ""} onChange={event => { clear(); setProposalId(event.target.value); }}>
          {!proposals.length && <option value="">暂无尚未采用的有效提案</option>}
          {proposals.map(item => <option key={item.id} value={item.id}>{item.candidate.kind === "design" ? "仅设计" : "本人实现"} · {item.candidate.action}</option>)}</select></label>
        <label>目标经历<select aria-label="目标合成经历" disabled={busy} value={target?.experienceId ?? ""} onChange={event => { clear(); setExperienceId(event.target.value); }}>{asset.targets.map(item => <option key={item.experienceId} value={item.experienceId}>{item.label}</option>)}</select></label>
      </> : <label>要撤销的采用<select aria-label="要撤销的采用" disabled={busy || !adoptions.length} value={adoption?.id ?? ""} onChange={event => { clear(); setAdoptionId(event.target.value); }}>
        {!adoptions.length && <option value="">暂无可撤销的采用</option>}{adoptions.map(item => <option key={item.id} value={item.id}>{item.at} · 采用回执 {item.id}</option>)}</select></label>}
      <p>当前业务版本 {asset.headVersionId} · 保留 {asset.versions.length} 个完整版本</p>
      {adoptions.some(item => workspace?.proposals.find(proposal => proposal.id === item.proposalId)?.eligibility !== "current") && <p role="status">已采用内容的来源核对或授权已变化，请重新核对。既有版本保留，不自动改写；你可以单独预览并撤销该次采用。</p>}
      <button type="button" disabled={busy || !request} onClick={() => void compare()}>{mode === "adopt" ? "预览采用差异" : "预览撤销差异"}</button>
      {preview && <div className="resume-business-diff" aria-label="业务差异预览">
        <h4>{preview.request.kind === "adopt" ? "采用前请核对" : "撤销前请核对"}</h4>
        {preview.diff.map((item, index) => <div key={index}><strong>{item.label}</strong><div className="resume-diff-columns"><div><small>变更前</small><pre>{item.before}</pre></div><div><small>变更后</small><pre>{item.after}</pre></div></div></div>)}
        <p>{preview.warnings.join(" ")}</p><small>预览绑定版本 {preview.request.expectedVersionId} · {preview.hash.slice(0, 16)}</small>
        {stale && <p role="status">目标版本、来源或授权已变化。旧预览不能保存，请重新预览并授权。</p>}
        <label className="capability-consent"><input type="checkbox" aria-label="仅授权本次业务变更" disabled={busy || stale} checked={consent && !stale} onChange={event => setConsent(event.target.checked)} />仅授权上述目标和差异，{preview.request.kind === "adopt" ? "采用到这份合成简历" : "撤销这一条采用"}并保存新版本，不覆盖旧版本。</label>
        <div className="capability-actions"><button type="button" disabled={busy || stale || !consent} onClick={() => void save()}>{preview.request.kind === "adopt" ? "确认采用并保存版本" : "确认撤销并保存版本"}</button>
          <button type="button" disabled={busy} onClick={() => void cancel()}>撤销本次预览授权</button></div>
      </div>}
      <details className="resume-business-history"><summary>完整业务版本与回执（{asset.versions.length}）</summary>
        {asset.versions.map((version, index) => <div key={version.id}><strong>版本 {index + 1} · {version.receipt.kind === "create" ? "合成初始版本" : version.receipt.kind === "adopt" ? "采用提案" : "撤销采用"}</strong>
          <p>{version.receipt.at} · 版本 {version.id}</p><small>业务回执 {version.receipt.id}{version.receipt.undoesReceiptId && ` · 撤销原回执 ${version.receipt.undoesReceiptId}`}</small>
          {version.receipt.source && <p>来源报告回执 {version.receipt.source.reportReceiptId} · 本人提案 {version.receipt.proposalId}</p>}
          <button type="button" onClick={() => setVersionId(version.id)}>查看版本 {index + 1}</button></div>)}
      </details>
      <p>正在查看：{displayed?.id === asset.headVersionId ? "当前已保存业务版本" : "历史只读版本，不会恢复或覆盖当前简历"} · 回执 {displayed?.receipt.id}</p>
      {document.success && <div className="resume-adoption-paper"><ResumeTemplate resume={projectResume(document.data.factBase, document.data.resumeViews[0]!)} templateId="zh-classic" decorative /></div>}
    </>}
  </section>;
}
