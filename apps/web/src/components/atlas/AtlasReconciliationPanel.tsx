/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, Check, GitMerge, Loader2, X } from "lucide-react";
import { HttpUrlSchema, PreviewMergeReviewInputSchema, type AtlasDataset, type ConfirmMergeReviewInput,
  type MergeCandidatesPage, type MergeDecisionsPage, type MergeReviewPreview, type ReconciliationReceipt,
  type RevokeMergeReviewInput, type RevokeMergeReviewPreview } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import { getAtlasSourceBadge } from "./presentation";
import "./AtlasReconciliationPanel.css";

export type AtlasReconciliationPanelProps = { endpoint: string; token: string; data: AtlasDataset; onClose: () => void; onSnapshot: (data: AtlasDataset) => void };
type Overview = { data: AtlasDataset; candidates: MergeCandidatesPage; history: MergeDecisionsPage };
type Write = { kind: "merge"; input: ConfirmMergeReviewInput; key: string } | { kind: "reject"; input: ConfirmMergeReviewInput; key: string } | { kind: "revoke"; input: RevokeMergeReviewInput; key: string };
const signalLabels: Record<string, string> = { "same-application-url": "相同单岗申请地址", "same-official-requisition": "相同官方岗位编号", "same-company-id": "相同雇主记录", "same-employer-name": "雇主名称相同", "same-title": "岗位标题相同", "same-verified-legal-entity": "已核实法律实体相同" };
const fieldLabels: Record<string, string> = { companyId: "雇主记录", title: "岗位标题", description: "岗位正文", selectedSnapshotId: "正文快照", status: "招聘状态", workMode: "工作方式", employmentType: "雇佣形式", roleFamily: "岗位类别", seniority: "职级", locationIds: "工作地点", compensationIds: "薪资分项", remoteEligibleRegions: "远程资格范围" };
const decisionLabel = (kind: string) => kind === "merge" ? "合并" : kind === "reject" ? "暂不合并" : "撤销";
const statusLabel = (status: string) => status === "active" ? "生效中" : status === "revoked" ? "已撤销" : "撤销记录";

function JobSide({ side, label }: { side: MergeReviewPreview["target"]; label: string }) {
  return <article className="atlas-merge-side"><h4>{label}</h4><strong>{side.job.title.value}</strong><p>{side.company.names.join(" / ")}</p>
    <small>{side.canonicalJobId}</small><p>{side.locations.map(location => location.raw).join(" / ") || "地点未披露"}</p>
    <p>{side.listings.length} 条来源记录 · {side.compensations.length} 项薪资记录</p>
    <ul>{side.listings.map(listing => { const url = HttpUrlSchema.safeParse(listing.canonicalUrl), source = side.sources.find(entry => entry.sourceId === listing.sourceId);
      const badge = getAtlasSourceBadge({ sourceId: listing.sourceId, adapterId: source?.adapterId }); return <li key={listing.id}>
      <span className="atlas-merge-source" style={{ color: badge.foreground, backgroundColor: badge.background, borderColor: badge.border }}>{source?.attribution.label ?? listing.sourceId}</span>{" · "}
      {url.success ? <a href={url.data} target="_blank" rel="noopener noreferrer">打开岗位原文</a> : "原文链接待核实"}
    </li>; })}</ul></article>;
}

/** Changing connection identity unmounts the entire review, including unresolved requests. */
export function AtlasReconciliationPanel(props: AtlasReconciliationPanelProps) {
  return <ReconciliationSession key={JSON.stringify([props.endpoint, props.token])} {...props} />;
}

function ReconciliationSession({ endpoint, token, data, onClose, onSnapshot }: AtlasReconciliationPanelProps) {
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [overview, setOverview] = useState<Overview>();
  const [target, setTarget] = useState(""); const [source, setSource] = useState("");
  const [reason, setReason] = useState(""); const [companyConfirmed, setCompanyConfirmed] = useState(false);
  const [preview, setPreview] = useState<MergeReviewPreview>(); const [reviewed, setReviewed] = useState(false);
  const [revokeId, setRevokeId] = useState(""); const [revokeReason, setRevokeReason] = useState("");
  const [revokePreview, setRevokePreview] = useState<RevokeMergeReviewPreview>(); const [revokeReviewed, setRevokeReviewed] = useState(false);
  const [pending, setPending] = useState<Write>(); const [saved, setSaved] = useState<ReconciliationReceipt>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const current = useRef<AbortController | null>(null);
  const section = useRef<HTMLElement>(null);
  const locked = busy || !!pending || !!saved;
  const snapshot = overview?.data ?? data;
  const stale = !!overview && overview.data.revision !== data.revision;
  const pairStale = !!preview && preview.expectedRevision !== data.revision;
  const revokeStale = !!revokePreview && revokePreview.expectedRevision !== data.revision;
  const jobs = useMemo(() => [...snapshot.jobs].sort((a, b) => a.title.value.localeCompare(b.title.value, "zh")), [snapshot]);
  const jobLabel = (id: string) => { const job = snapshot.jobs.find(entry => entry.id === id); return job ? `${job.title.value} · ${snapshot.companies.find(company => company.id === job.companyId)?.names[0] ?? "雇主待核实"}` : id; };
  useEffect(() => {
    section.current?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    return () => { current.current?.abort(); current.current = null; };
  }, []);
  function alive(signal: AbortSignal) { signal.throwIfAborted(); if (current.current?.signal !== signal) throw new Error("本次核对已关闭。"); }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (current.current) return;
    const controller = new AbortController(); current.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => controller.abort(), 25_000);
    try { await action(controller.signal); }
    catch (problem) { if (current.current === controller) setError(controller.signal.aborted
      ? "已停止等待。提交中的写入可能已完成，请保留本面板并重试本次请求核对回执。"
      : problem instanceof Error ? problem.message : "本次核对未完成。"); }
    finally { clearTimeout(timer); if (current.current === controller) { current.current = null; setBusy(false); } }
  }
  function invalidatePair() { setPreview(undefined); setReviewed(false); setRevokePreview(undefined); setRevokeReviewed(false); setError(""); }
  function choosePair(left: string, right: string) { if (locked) return; setTarget(left); setSource(right); setReason(""); setCompanyConfirmed(false); setRevokeId(""); invalidatePair(); }
  const loadOverview = () => run(async signal => {
    const [fresh, candidates, history] = await Promise.all([client.snapshot({ signal }), client.listMergeCandidates({ limit: 50 }, { signal }), client.listMergeDecisions({ limit: 50 }, { signal })]);
    alive(signal);
    if (fresh.revision !== candidates.snapshotRevision || fresh.revision !== history.snapshotRevision || saved && fresh.revision < saved.revision) throw new Error("读取期间索引发生变化，请重新读取候选与记录。");
    setOverview({ data: fresh, candidates, history }); setSaved(undefined); setRevokeId(""); setRevokePreview(undefined); setRevokeReason(""); setRevokeReviewed(false);
    setTarget(""); setSource(""); setReason(""); setCompanyConfirmed(false); invalidatePair(); onSnapshot(fresh);
  });
  const readPreview = () => run(async signal => {
    if (!overview || stale) throw new Error("请先读取当前版本的候选与记录。");
    const parsed = PreviewMergeReviewInputSchema.safeParse({ targetJobId: target, sourceJobId: source, expectedRevision: overview.data.revision, reason, companyIdentityConfirmed: companyConfirmed });
    if (!parsed.success || target === source) throw new Error("请选择两条不同岗位，并填写核对依据或说明。");
    const result = await client.previewMerge(parsed.data, { signal }); alive(signal); setPreview(result); setReviewed(false); setRevokePreview(undefined);
  });
  const readRevokePreview = () => run(async signal => {
    if (!overview || stale || !revokeId || !revokeReason.trim()) throw new Error("请重新读取当前记录，并填写撤销说明。");
    const result = await client.previewRevokeMerge({ decisionId: revokeId, expectedRevision: overview.data.revision, reason: revokeReason.trim() }, { signal });
    alive(signal); setRevokePreview(result); setRevokeReviewed(false); setPreview(undefined);
  });
  const commit = (kind: Write["kind"]) => run(async signal => {
    if (!pending && (kind === "revoke" ? !revokePreview || !revokeReviewed || revokeStale : !preview || !reviewed || pairStale)) return;
    if (!pending && kind === "merge" && preview?.candidate.requiresCompanyConfirmation && !preview.input.companyIdentityConfirmed) throw new Error("两条记录的雇主身份尚未确认，请先核对并重新预览。");
    const write: Write = pending ?? (kind === "revoke" ? { kind, input: { ...revokePreview!.input, previewFingerprint: revokePreview!.previewFingerprint, reviewed: true }, key: `merge-revoke-${crypto.randomUUID()}` }
      : { kind, input: { ...preview!.input, previewFingerprint: preview!.previewFingerprint, reviewed: true }, key: `merge-${kind}-${crypto.randomUUID()}` });
    setPending(write);
    let receipt: ReconciliationReceipt;
    try { const options = { signal, idempotencyKey: write.key }; receipt = write.kind === "merge" ? await client.mergeJobs(write.input, options)
      : write.kind === "reject" ? await client.rejectMerge(write.input, options) : await client.revokeMerge(write.input, options); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); setPending(undefined); invalidatePair();
      }
      throw problem;
    }
    alive(signal); setSaved(receipt); setPending(undefined);
    try { const fresh = await client.snapshot({ signal }); alive(signal); if (fresh.revision < receipt.revision) throw new Error("索引尚未返回已保存的版本。"); onSnapshot(fresh); }
    catch (problem) { alive(signal); throw new Error(`已保存到索引版本 ${receipt.revision}，页面读取尚未完成，请重新读取索引。`, { cause: problem }); }
  });
  const refreshSnapshot = () => run(async signal => { const fresh = await client.snapshot({ signal }); alive(signal); if (saved && fresh.revision < saved.revision) throw new Error("索引尚未返回已保存的版本，请重试读取。"); onSnapshot(fresh); });
  function close() { current.current?.abort(); current.current = null; onClose(); }
  return <section ref={section} className="atlas-merge-review" aria-label="重复岗位核对" aria-busy={busy}>
    <header><div><span className="atlas-eyebrow">KEEP THE EVIDENCE</span><h3><GitMerge size={18} />重复岗位核对</h3></div><button type="button" aria-label="关闭重复岗位核对" onClick={close}><X size={16} /></button></header>
    <p>把不同来源的同一岗位集中展示。先核对原文和差异，再决定是否合并；各来源、地点、薪资与历史记录都会保留。</p>
    <button type="button" disabled={busy || !!pending} onClick={() => void loadOverview()}>读取候选与记录</button>
    {overview && <><p className="atlas-small">索引版本 {overview.data.revision} · 当前显示 {overview.candidates.candidates.length} 个有限候选{overview.candidates.truncated ? "（达到显示上限）" : ""}。候选扫描有上限，空列表也不代表没有重复岗位；可在下方手动选择。</p>
      {[...new Set([...overview.candidates.warnings, ...overview.history.warnings])].map(warning => <p className="atlas-small" key={warning}>{warning}</p>)}
      {stale && !saved && <p role="status">索引已更新，请重新读取候选与记录后再核对。</p>}
      <div className="atlas-merge-candidates">{overview.candidates.candidates.map(candidate => <button type="button" key={candidate.id} disabled={locked || stale} onClick={() => choosePair(candidate.leftJobId, candidate.rightJobId)}>
        <strong>{jobLabel(candidate.leftJobId)}</strong><span>与 {jobLabel(candidate.rightJobId)}</span><small>{candidate.strong ? "有强线索，仍需本人核对" : "仅有弱线索"} · {candidate.conflicts.length} 类字段差异</small>
      </button>)}</div>
      <fieldset disabled={locked || stale}><legend>选择两条待核对岗位</legend>
        <label>保留摘要的目标岗位<select aria-label="保留摘要的目标岗位" value={target} onChange={event => choosePair(event.target.value, source)}><option value="">请选择</option>{jobs.map(job => <option key={job.id} value={job.id}>{jobLabel(job.id)}</option>)}</select></label>
        <button type="button" disabled={!target || !source} onClick={() => choosePair(source, target)}><ArrowRightLeft size={14} />交换摘要方向</button>
        <label>并入的来源岗位<select aria-label="并入的来源岗位" value={source} onChange={event => choosePair(target, event.target.value)}><option value="">请选择</option>{jobs.map(job => <option key={job.id} value={job.id}>{jobLabel(job.id)}</option>)}</select></label>
        <p className="atlas-small">目标岗位提供标题、正文、雇主和状态摘要；地点、薪资与来源保留各项，不将不同数值混成一个值。</p>
        <label>核对依据或说明<textarea aria-label="岗位归并说明" value={reason} maxLength={2000} onChange={event => { setReason(event.target.value); invalidatePair(); }} /></label>
        <label className="atlas-merge-check"><input type="checkbox" aria-label="已核对为同一雇主" checked={companyConfirmed} onChange={event => { setCompanyConfirmed(event.target.checked); invalidatePair(); }} />我已核对原文与雇主身份，确认两条记录属于同一雇主</label>
      </fieldset>
      {!saved && <button type="button" disabled={locked || stale || !target || !source || target === source || !reason.trim()} onClick={() => void readPreview()}>预览来源与差异</button>}
    </>}
    {preview && !saved && <div className="atlas-merge-preview"><h4>本次预览 · 版本 {preview.expectedRevision}</h4><div className="atlas-merge-sides"><JobSide side={preview.target} label="保留摘要的目标" /><JobSide side={preview.source} label="并入的来源" /></div>
      <h4>依据与字段差异摘要</h4><p>{preview.candidate.strong ? "存在强线索，仍需核对是否为同一岗位。" : "只有弱线索或手动选取，不能仅凭同名认定同岗。"}</p>
      <ul>{preview.candidate.signals.map((signal, index) => <li key={index}>{signalLabels[signal.kind] ?? signal.kind} · {signal.strength === "strong" ? "强线索" : "弱线索"}：{signal.value}</li>)}</ul>
      {preview.candidate.conflicts.map(conflict => <details key={conflict.field}><summary>{fieldLabels[conflict.field] ?? conflict.field}</summary>{conflict.variants.map(variant => <p key={variant.jobId}><strong>{variant.jobId === preview.target.canonicalJobId ? "目标" : "来源"}：</strong>{variant.preview || "未披露"}</p>)}</details>)}
      <p className="atlas-small">差异是截取的摘要，单字段最多 1000 字；完整内容请查看各岗位原文。</p>
      {preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <label className="atlas-merge-check"><input type="checkbox" aria-label="已审阅岗位归并预览" checked={reviewed} disabled={busy || !!pending || pairStale} onChange={event => setReviewed(event.target.checked)} />我已阅读双方来源、摘要方向和字段差异，确认下面的处理决定</label>
      <button type="button" disabled={busy || !!pending || !reviewed || pairStale || preview.candidate.requiresCompanyConfirmation && !preview.input.companyIdentityConfirmed} onClick={() => void commit("merge")}>确认合并岗位</button>
      <button type="button" disabled={busy || !!pending || !reviewed || pairStale} onClick={() => void commit("reject")}>记录暂不合并</button>
    </div>}
    {overview && <details className="atlas-merge-history"><summary>处理记录 · {overview.history.totalAvailable}{overview.history.truncated ? "（仅显示最近部分）" : ""}</summary>
      {!overview.history.items.length && <p>当前没有处理记录。</p>}
      {overview.history.items.map(({ decision, status }) => <article key={decision.id}><strong>{decisionLabel(decision.kind)} · {statusLabel(status)}</strong><p>{decision.kind === "merge" ? `${jobLabel(decision.sourceJobId)} → ${jobLabel(decision.targetJobId)}` : decision.kind === "reject" ? `${jobLabel(decision.leftJobId)} / ${jobLabel(decision.rightJobId)}` : `撤销记录 ${decision.targetDecisionId}`}</p><p>{decision.reason}</p><small>{decision.at} · 版本 {decision.revision}</small>
        {status === "active" && decision.kind !== "revoke" && <button type="button" disabled={locked || stale} onClick={() => { setRevokeId(decision.id); setRevokeReason(""); invalidatePair(); }}>核对撤销这条{decisionLabel(decision.kind)}记录</button>}
      </article>)}
    </details>}
    {revokeId && !saved && <div className="atlas-merge-revoke"><h4>核对撤销记录</h4><p>只撤销选中的这条决定。多层合并可能仍保留其他关联；拆分后保留来源后来更新的内容。</p>
      <label>撤销说明<textarea aria-label="撤销岗位归并说明" maxLength={2000} disabled={locked || stale} value={revokeReason} onChange={event => { setRevokeReason(event.target.value); setRevokePreview(undefined); setRevokeReviewed(false); }} /></label>
      <button type="button" disabled={locked || stale || !revokeReason.trim()} onClick={() => void readRevokePreview()}>预览撤销影响</button>
      {revokePreview && <><p>撤销前 {revokePreview.counts.beforeJobs} 个相关岗位组 → 撤销后 {revokePreview.counts.afterJobs} 个相关岗位组</p>
        <div className="atlas-merge-sides"><div><h4>撤销前</h4>{revokePreview.before.map(side => <JobSide key={side.canonicalJobId} side={side} label="当前岗位组" />)}</div><div><h4>撤销后</h4>{revokePreview.after.map(side => <JobSide key={side.canonicalJobId} side={side} label="预计岗位组" />)}</div></div>
        {revokePreview.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <label className="atlas-merge-check"><input type="checkbox" aria-label="已审阅撤销影响" checked={revokeReviewed} disabled={busy || !!pending || revokeStale} onChange={event => setRevokeReviewed(event.target.checked)} />我已核对撤销后的岗位组和保留来源，确认撤销这条决定</label>
        <button type="button" disabled={busy || !!pending || !revokeReviewed || revokeStale} onClick={() => void commit("revoke")}>确认撤销这条记录</button></>}
    </div>}
    {pending && !saved && <div role="status"><p>写入结果尚未确定，请保持本面板打开。重试会核对同一次请求，避免重复操作。</p><button type="button" disabled={busy} onClick={() => void commit(pending.kind)}>重试本次处理 · 核对回执</button></div>}
    {busy && <p role="status"><Loader2 size={15} className="animate-spin" />正在处理岗位核对…</p>}
    {saved && <p className="atlas-merge-saved" role="status"><Check size={15} />已保存{decisionLabel(saved.decision.kind)}记录，索引版本 {saved.revision}。可重新读取候选与记录继续核对。</p>}
    {error && <p role="alert" className="atlas-error">{error}</p>}
    {saved && <button type="button" disabled={busy} onClick={() => void refreshSnapshot()}>重新读取索引</button>}
  </section>;
}
