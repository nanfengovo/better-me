import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, FileSearch, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { AtlasDataset, SourceDefinition } from "@better-me/opportunities";
import type { LeadQueryInput, LeadQueryResult, LeadReadResult, OriginalLeadCapture, OriginalLeadPreview } from "@better-me/source-adapters/browser-contracts";
import { useUiPreferences } from "../../lib/ui-preferences";
import { hasAtlasServiceTarget } from "./backend-connection";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import { createAtlasLeadClient } from "./lead-client";
import { atlasLeadRecoveryScope, beginAtlasLeadRecovery, endAtlasLeadRecovery, readAtlasLeadRecovery, useAtlasLeadRecovery, writeAtlasLeadRecovery } from "./lead-recovery";
import { SourcePublicationBadges } from "./JobSourceBadges";
import "./AtlasDiscoveryLeads.css";

type Props = {
  endpoint: string; token: string; revision?: number; sources?: SourceDefinition[]; disabled?: boolean;
  onSnapshot: (snapshot: AtlasDataset) => void; onOpenJob?: (jobId: string, snapshot: AtlasDataset) => void; onClose: () => void;
};
type Selection = LeadReadResult;
const errorText = (problem: unknown) => problem instanceof Error ? problem.message : "线索操作失败，请检查岗位后端。";
const authoritative = (problem: unknown) => problem instanceof AtlasSourceServiceError
  && ["stale-version", "invalid-input", "source-changed", "idempotency-conflict"].includes(problem.code);

/** Persisted leads are separate from the job index. Reading an original and adopting it are explicit steps. */
export function AtlasDiscoveryLeads({ endpoint, token, revision, sources = [], disabled = false, onSnapshot, onOpenJob, onClose }: Props) {
  const { t } = useUiPreferences();
  const client = useMemo(() => createAtlasLeadClient(endpoint, token), [endpoint, token]);
  const snapshots = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const scope = atlasLeadRecoveryScope(endpoint, token), recovery = useAtlasLeadRecovery(endpoint, token);
  const locked = Boolean(recovery.pending || recovery.saved || recovery.active);
  const [search, setSearch] = useState(""), [sourceId, setSourceId] = useState("");
  const [entityType, setEntityType] = useState<"" | "discovery-lead" | "recruitment-campaign">("");
  const [result, setResult] = useState<LeadQueryResult>();
  const [submitted, setSubmitted] = useState<LeadQueryInput>({ limit: 50 });
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Selection>();
  const [originalSourceId, setOriginalSourceId] = useState("");
  const [capture, setCapture] = useState<OriginalLeadCapture>();
  const [preview, setPreview] = useState<OriginalLeadPreview>();
  const [reviewed, setReviewed] = useState(false);
  const [completed, setCompleted] = useState<{ snapshot: AtlasDataset; jobIds: string[] }>();
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  const latest = useRef({ onSnapshot, onOpenJob, disabled }); latest.current = { onSnapshot, onOpenJob, disabled };
  const usable = hasAtlasServiceTarget(endpoint, token);
  const stale = selected && revision !== undefined && revision > selected.snapshotRevision;
  const controlsDisabled = Boolean(disabled || busy || locked);

  function resetRead() { setCapture(undefined); setPreview(undefined); setReviewed(false); setCompleted(undefined); }
  async function run(label: string, action: (signal: AbortSignal) => Promise<void>, allowRecovery = false) {
    if (active.current || latest.current.disabled || !usable) return;
    const held = readAtlasLeadRecovery(scope);
    if (!allowRecovery && (held.pending || held.saved || held.active)) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(label); setError(""); setNotice("");
    const timer = setTimeout(() => controller.abort(), 60_000);
    try { await action(controller.signal); }
    catch (problem) {
      if (active.current === controller) setError(controller.signal.aborted
        ? t("已停止等待。若已提交保存，请用原请求核对回执。", "Waiting stopped. Recover the original receipt if a save was submitted.") : errorText(problem));
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(""); } }
  }
  async function load(query: LeadQueryInput, cursor?: string, pageIndex = 0, signal?: AbortSignal) {
    const next = await client.query({ ...query, ...(cursor ? { cursor } : {}) }, { signal }); signal?.throwIfAborted();
    setResult(next); setPage(pageIndex); setSelected(undefined); setOriginalSourceId(""); resetRead();
    setSubmitted(query); setCursors(current => pageIndex === 0 ? [undefined] : [...current.slice(0, pageIndex), cursor]);
  }
  useEffect(() => {
    const held = readAtlasLeadRecovery(scope);
    if (!usable || held.pending || held.saved || held.active) return;
    const controller = new AbortController(); active.current = controller; setBusy(t("读取已保存线索", "Reading saved leads"));
    const timer = setTimeout(() => controller.abort(), 60_000);
    void client.query({ limit: 50 }, { signal: controller.signal }).then(next => {
      controller.signal.throwIfAborted(); setResult(next);
    }).catch((problem: unknown) => { if (active.current === controller) setError(controller.signal.aborted
      ? t("读取已保存线索已超时，请重新查询。", "Reading saved leads timed out. Please retry the query.") : errorText(problem)); })
      .finally(() => { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(""); } });
    return () => { clearTimeout(timer); controller.abort(); active.current?.abort(); active.current = null; };
  }, [client, scope, usable, t]);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);

  function searchLeads() {
    const query: LeadQueryInput = { limit: 50, ...(search.trim() ? { search: search.trim() } : {}),
      ...(sourceId ? { sourceId } : {}), ...(entityType ? { entityType } : {}) };
    void run(t("查询已保存线索", "Searching saved leads"), signal => load(query, undefined, 0, signal));
  }
  async function choose(leadId: string, signal: AbortSignal) {
    if (!result) return;
    const next = await client.read({ leadId, expectedRevision: result.snapshotRevision }, { signal }); signal.throwIfAborted();
    setSelected(next); setOriginalSourceId(""); resetRead();
  }
  async function readOriginal(signal: AbortSignal) {
    if (!selected || !originalSourceId || stale) return;
    resetRead();
    const next = await client.readOriginal({ leadId: selected.lead.id, leadDigest: selected.leadDigest,
      originalSourceId, expectedRevision: selected.snapshotRevision }, { signal }); signal.throwIfAborted();
    if (next.discoverySourceId !== selected.lead.sourceId || next.url !== selected.lead.record.url) {
      throw new AtlasSourceServiceError("invalid-response", "原页读取与所选发现线索不一致，请重新读取线索。");
    }
    setCapture(next);
  }
  async function makePreview(signal: AbortSignal) {
    if (!capture || !selected || stale) return;
    setPreview(undefined); setReviewed(false);
    const next = await client.previewOriginal({ capture, expectedRevision: selected.snapshotRevision }, { signal }); signal.throwIfAborted(); setPreview(next);
  }
  async function synchronize(signal: AbortSignal) {
    const saved = readAtlasLeadRecovery(scope).saved;
    if (!saved) return;
    const next = await snapshots.snapshot({ signal }); signal.throwIfAborted();
    const listings = next.listings.filter(listing => listing.sourceId === saved.original.sourceId
      && listing.sourceRecordId === saved.original.sourceRecordId);
    const owners = [...new Set(listings.map(listing => listing.canonicalJobId))].filter((id): id is string => Boolean(id));
    const job = owners.length === 1 ? next.jobs.find(job => job.id === owners[0] && listings.every(listing => job.listingIds.includes(listing.id))) : undefined;
    if (next.revision < saved.receipt.revision || !job
      || next.revision === saved.receipt.revision && !saved.receipt.jobIds.includes(job.id)) {
      throw new AtlasSourceServiceError("invalid-response", `岗位已保存至版本 ${saved.receipt.revision}，请重新读取不低于该版本的索引。`);
    }
    latest.current.onSnapshot(next);
    setCompleted({ snapshot: next, jobIds: [job.id] }); setCapture(undefined); setPreview(undefined); setReviewed(false);
    writeAtlasLeadRecovery(scope, {});
    setNotice(t(`原岗位已保存，索引版本 ${next.revision}。发现线索仍保留为发现来源。`, `Original posting saved at index revision ${next.revision}. The discovery lead retains its provenance.`));
  }
  async function save(signal: AbortSignal) {
    const owner = beginAtlasLeadRecovery(scope); if (!owner) return;
    try {
      const held = readAtlasLeadRecovery(scope);
      if (held.saved) { await synchronize(signal); return; }
      let pending = held.pending;
      if (!pending) {
        if (!capture || !preview || !reviewed || !selected || stale) return;
        pending = { input: { capture, expectedRevision: preview.expectedRevision, previewFingerprint: preview.previewFingerprint, reviewed: true },
          key: `lead-original-${crypto.randomUUID()}`, jobId: preview.canonicalJobId };
        writeAtlasLeadRecovery(scope, { pending });
      }
      let receipt;
      try { receipt = await client.importOriginal(pending.input, { signal, idempotencyKey: pending.key, jobId: pending.jobId }); }
      catch (problem) {
        if (authoritative(problem)) { writeAtlasLeadRecovery(scope, {}); setPreview(undefined); setReviewed(false); }
        throw problem;
      }
      writeAtlasLeadRecovery(scope, { saved: { receipt, leadId: pending.input.capture.leadId,
        original: { sourceId: pending.input.capture.originalSourceId, sourceRecordId: pending.input.capture.record.sourceRecordId!, url: pending.input.capture.url } } });
      signal.throwIfAborted();
      try { await synchronize(signal); }
      catch (problem) { throw new Error(t(`岗位已保存至版本 ${receipt.revision}，索引尚未同步；只需重新读取索引。`, `Posting saved at revision ${receipt.revision}; reload the index to synchronize.`), { cause: problem }); }
    } finally { endAtlasLeadRecovery(scope, owner); }
  }
  const canRead = !!selected?.lead.record.url && !!originalSourceId && !controlsDisabled && !stale;
  return <section className="atlas-discovery-leads" aria-label={t("已保存发现线索", "Saved discovery leads")} aria-busy={!!busy || !!recovery.active}>
    <header><div><span className="atlas-eyebrow">DISCOVERY → ORIGINAL POSTING</span><h2><FileSearch size={18} />{t("已保存发现线索", "Saved discovery leads")}</h2></div>
      <button type="button" aria-label={t("关闭发现线索", "Close discovery leads")} onClick={() => { active.current?.abort(); onClose(); }}><X size={16} /></button></header>
    <p className="atlas-leads-note">{t("GitHub 条目、公司目录和招聘批次是发现线索，未计入岗位数量或地图。这里查询本机已保存的记录；读取原岗位与确认保存分别执行。", "GitHub entries, company directories and campaigns are discovery leads, excluded from job counts and maps. This view queries saved local records; original reads and confirmed imports are separate steps.")}</p>
    {!usable && <p role="status">{t("岗位后端尚未连接。", "The job backend is not connected.")}</p>}
    {recovery.pending && <div className="atlas-leads-recovery" role="status"><strong>{t("本次保存结果待确认", "Save result awaits confirmation")}</strong><p>{t("关闭面板或切换页面会保留原请求。核对前不会启动新的读取或保存；刷新页面前请完成核对。", "The original command survives pane and workspace changes. Recover its receipt before another read or save. Finish recovery before reloading this page.")}</p>
      <button type="button" disabled={!!busy || !!recovery.active || disabled} onClick={() => void run(t("核对原保存回执", "Recovering original save receipt"), save, true)}>{t("核对原保存回执", "Recover original save receipt")}</button></div>}
    {recovery.saved && <div className="atlas-leads-recovery" role="status"><strong>{t(`岗位已保存至版本 ${recovery.saved.receipt.revision}`, `Posting saved at revision ${recovery.saved.receipt.revision}`)}</strong><p>{t("只需重新读取索引，不会再次提交保存。", "Reload the index; the save will not be submitted again.")}</p>
      <button type="button" disabled={!!busy || !!recovery.active || disabled} onClick={() => void run(t("重新读取已保存索引", "Reloading saved index"), save, true)}>{t("重新读取已保存索引", "Reload saved index")}</button></div>}
    <form className="atlas-leads-search" onSubmit={event => { event.preventDefault(); searchLeads(); }}>
      <label>{t("线索关键词", "Lead keywords")}<input value={search} onChange={event => setSearch(event.target.value)} maxLength={500} disabled={controlsDisabled} placeholder={t("公司、岗位名称或保留原文", "Company, role or retained text")} /></label>
      <label>{t("线索来源", "Discovery source")}<select value={sourceId} onChange={event => setSourceId(event.target.value)} disabled={controlsDisabled}><option value="">{t("全部已保存来源", "All saved sources")}</option>{sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.attribution.label}</option>)}</select></label>
      <label>{t("线索类型", "Lead type")}<select value={entityType} disabled={controlsDisabled} onChange={event => setEntityType(event.target.value as typeof entityType)}><option value="">{t("全部线索", "All leads")}</option><option value="discovery-lead">{t("发现线索", "Discovery lead")}</option><option value="recruitment-campaign">{t("招聘批次", "Recruitment campaign")}</option></select></label>
      <button type="submit" disabled={!usable || controlsDisabled}><Search size={14} />{t("查询已保存线索", "Search saved leads")}</button>
    </form>
    {busy && <p role="status" className="atlas-leads-status"><Loader2 size={15} className="animate-spin" />{busy}<button type="button" onClick={() => active.current?.abort()}>{t("停止等待", "Stop waiting")}</button></p>}
    {error && <p className="atlas-leads-error" role="alert">{error}</p>}
    {notice && <p role="status" className="atlas-leads-success"><Check size={14} />{notice}</p>}
    {completed && onOpenJob && completed.jobIds.map(id => <button key={id} type="button" disabled={controlsDisabled} onClick={() => onOpenJob(id, completed.snapshot)}>{t("查看规范岗位 · 清除地图筛选", "View canonical job · reset map filters")}</button>)}
    {result && <><p className="atlas-leads-count">{t(`共 ${result.totalLeads} 条已保存线索 · 第 ${page + 1} 页 · 版本 ${result.snapshotRevision}`, `${result.totalLeads} saved leads · page ${page + 1} · revision ${result.snapshotRevision}`)}</p>
      <div className="atlas-leads-layout"><div className="atlas-leads-list">{result.items.map(item => {
        const record = item.lead.record;
        return <article key={item.lead.id} className={selected?.lead.id === item.lead.id ? "selected" : ""}>
          <div className="atlas-leads-badges"><SourcePublicationBadges sourceLabel={item.source.attribution.label} sourceId={item.source.sourceId} adapterId={item.source.adapterId} publishedAt={record.sourcePublishedAt} publishedRaw={record.sourcePublishedRaw} /><span className="atlas-lead-kind">{record.entityType === "recruitment-campaign" ? t("招聘批次", "Recruitment campaign") : t("发现线索", "Discovery lead")}</span></div>
          <h3>{record.title}</h3>{record.companyName && <p>{record.companyName}</p>}<p className="atlas-leads-meta">{t("线索读取时间", "Lead observed")}: <time dateTime={item.lead.observedAt}>{item.lead.observedAt}</time></p>
          <div className="atlas-leads-actions">{record.url && <a href={record.url} target="_blank" rel="noreferrer">{t("查看线索原链", "Open retained link")}<ArrowUpRight size={12} /></a>}
            <button type="button" disabled={controlsDisabled} onClick={() => void run(t("读取所选持久线索", "Reading selected saved lead"), signal => choose(item.lead.id, signal))}>{t("核对这条线索", "Review this lead")}</button></div>
          {item.resolvedJobs.length > 0 && <p className="atlas-leads-meta">{t(`${item.resolvedJobs.length} 条接续记录（含历史）`, `${item.resolvedJobs.length} continuation records (including history)`)}</p>}
        </article>;
      })}{!result.items.length && <p>{t("本机已保存线索中没有匹配记录；这不表示市场没有相关岗位。", "No matching saved leads; this does not establish that the market has no relevant jobs.")}</p>}</div>
      {selected && <aside className="atlas-leads-review" aria-label={t("发现线索原岗核对", "Review the original posting")}> <h3>{t("1 · 选择独立原页来源", "1 · Choose the original source")}</h3><strong>{selected.lead.record.title}</strong><p className="atlas-leads-meta">{selected.source.attribution.label} → {selected.lead.record.url ?? t("没有保留原链", "No retained URL")}</p>
        <p>{t("原来源必须已启用且具有本机已安装的原页读取能力。GitHub 来源的访问策略不授权读取雇主网站。", "The original source must be enabled with an installed original reader. The GitHub source policy does not authorize employer websites.")}</p>
        <label>{t("原岗位来源", "Original posting source")}<select value={originalSourceId} disabled={controlsDisabled} onChange={event => { setOriginalSourceId(event.target.value); resetRead(); }}><option value="">{t("明确选择原来源", "Select an original source")}</option>{selected.eligibleOriginalSources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.attribution.label}</option>)}</select></label>
        {!selected.eligibleOriginalSources.length && <p role="status">{t("当前没有可用的独立原页来源，请先在来源工具审核配置。线索不会自动变成岗位。", "No eligible original source is installed. Review its configuration in source tools; the lead remains a lead.")}</p>}
        {stale && <p className="atlas-leads-error" role="status">{t("索引版本已改变，请重新查询并核对线索。", "The index changed; query and review the lead again.")}</p>}
        <button type="button" disabled={!canRead} onClick={() => void run(t("读取原岗位页面", "Reading the original posting"), readOriginal)}><FileSearch size={14} />{t("读取原岗位页面", "Read original posting")}</button>
        {!!selected.resolvedJobs.length && <details><summary>{t("接续记录（含历史）", "Continuation records (including history)")}</summary>{selected.resolvedJobs.map(job => <p key={`${job.jobId}:${job.sourceId}`}><a href={job.url} target="_blank" rel="noreferrer">{job.title}<ArrowUpRight size={12} /></a></p>)}</details>}
        {capture && <div className="atlas-leads-capture"><h3>{t("2 · 对照线索与原岗位", "2 · Compare the lead and original")}</h3><dl><dt>{t("线索标题", "Lead title")}</dt><dd>{selected.lead.record.title}</dd><dt>{t("原岗位标题", "Original job title")}</dt><dd>{capture.record.title}</dd><dt>{t("原页雇主", "Employer on original")}</dt><dd>{capture.record.companyName}</dd><dt>{t("原岗位编号", "Original job ID")}</dt><dd>{capture.record.sourceRecordId}</dd><dt>{t("原页读取时间", "Original observed")}</dt><dd>{capture.observedAt}</dd><dt>{t("原页工作地点", "Source locations")}</dt><dd>{capture.record.locations.map(location => location.streetAddress ?? location.raw).join(" / ") || t("未披露", "Not disclosed")}</dd></dl>
          <details><summary>{t("核对原页正文与字段证据", "Review original text and field evidence")}</summary><pre>{capture.record.description}</pre>{capture.record.evidence.map((evidence, index) => <div key={index}><strong>{evidence.field}</strong><p>{evidence.selector}</p>{evidence.quote && <blockquote>{evidence.quote}</blockquote>}<a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{t("证据来源", "Evidence source")}</a></div>)}</details>
          <button type="button" disabled={controlsDisabled || !!stale} onClick={() => void run(t("预览原岗位入库", "Previewing original job import"), makePreview)}>{t("预览原岗位入库", "Preview original job import")}</button></div>}
        {preview && <div className="atlas-leads-preview"><h3>{t("3 · 原来源岗位预览与确认", "3 · Review and confirm source posting")}</h3><p>{preview.job.title.value} · {t(`将保存到版本 ${preview.expectedRevision} 之后`, `Based on revision ${preview.expectedRevision}`)}</p>{preview.canonicalJobId !== preview.job.id && <p>{t("此原来源已归并，将更新现有规范岗位并保留其他来源贡献。", "This source posting is merged; the existing canonical job will be updated while retaining other sources.")}</p>}<ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><p>{t("原岗位来源与发现来源分别保留。来源地址不等于已核实办公室，不会自动生成办公坐标。", "Posting and discovery provenance remain separate. Source addresses do not confirm offices or create office coordinates.")}</p>
          <label className="atlas-leads-confirm"><input type="checkbox" checked={reviewed} disabled={controlsDisabled || !!stale} onChange={event => setReviewed(event.target.checked)} />{t("我已核对原岗位、雇主与来源证据，确认接续到岗位索引", "I reviewed the original job, employer and evidence, and confirm adoption into the job index")}</label>
          <button type="button" disabled={controlsDisabled || !reviewed || !!stale} onClick={() => void run(t("保存原岗位", "Saving original job"), save)}><Check size={14} />{t("确认保存原岗位", "Confirm original job import")}</button></div>}
      </aside>}</div>
      <div className="atlas-leads-actions"><button type="button" disabled={controlsDisabled || page === 0} onClick={() => void run(t("读取上一页线索", "Reading previous leads"), signal => load(submitted, cursors[page - 1], page - 1, signal))}>{t("上一页", "Previous page")}</button><button type="button" disabled={controlsDisabled || !result.nextCursor} onClick={() => void run(t("读取下一页线索", "Reading next leads"), signal => load(submitted, result.nextCursor, page + 1, signal))}>{t("下一页", "Next page")}</button>
        <button type="button" disabled={controlsDisabled} onClick={() => void run(t("重新查询已保存线索", "Reloading saved leads"), signal => load(submitted, undefined, 0, signal))}><RefreshCw size={14} />{t("重新查询线索", "Reload leads")}</button></div></>}
  </section>;
}
