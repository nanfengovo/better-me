import { hasAtlasServiceTarget } from "./backend-connection";
/** @jsxRuntime automatic */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSearch, Loader2, X } from "lucide-react";
import type { AtlasDataset } from "@better-me/opportunities";
import type { ImportReviewedCardsInput, ReviewedCardsCapture, ReviewedCardsPreview } from "@better-me/source-adapters/browser-contracts";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasSourceCandidateReview.css";
import "./AtlasReviewedCardImport.css";

export type AtlasReviewedCardImportProps = {
  endpoint: string; token: string; capture: ReviewedCardsCapture; revision: number;
  onClose: () => void; onSnapshot: (snapshot: AtlasDataset) => void;
  onWritePendingChange?: (pending: boolean) => void;
};
type Write = { input: ImportReviewedCardsInput; key: string };
type Saved = { revision: number; added: number; updated: number; jobIds: string[] };
type LocationReview = { jobId: string; locationId: string; revision: number };
const AtlasLocationConfirmation = lazy(() => import("./AtlasLocationConfirmation").then(module => ({ default: module.AtlasLocationConfirmation })));

/** Explicit human review. Submitted evidence is unverified; a card never claims to be a complete JD. */
export function AtlasReviewedCardImport({ endpoint, token, capture, revision, onClose, onSnapshot, onWritePendingChange }: AtlasReviewedCardImportProps) {
  const captureKey = JSON.stringify(capture);
  const binding = useMemo(() => ({ client: createAtlasSourceClient(endpoint, token), capture: JSON.parse(captureKey) as ReviewedCardsCapture }), [endpoint, token, captureKey]);
  const current = useRef<{ binding: typeof binding; controller: AbortController } | null>(null);
  const pendingWrite = useRef<{ binding: typeof binding; write: Write } | undefined>(undefined);
  const section = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<{ binding: typeof binding; value: ReviewedCardsPreview }>();
  const [pending, setPending] = useState<{ binding: typeof binding; write: Write }>();
  const [saved, setSaved] = useState<{ binding: typeof binding; value: Saved }>();
  const [index, setIndex] = useState<{ binding: typeof binding; value: AtlasDataset }>();
  const [locationReview, setLocationReview] = useState<{ binding: typeof binding; value: LocationReview }>();
  const [dismissed, setDismissed] = useState<typeof binding>();
  const [confirmation, setConfirmation] = useState<typeof binding>();
  const [operation, setOperation] = useState<typeof binding>();
  const [failure, setFailure] = useState<{ binding: typeof binding; message: string }>();
  const confirmed = confirmation === binding;
  const busy = operation === binding;
  const error = failure?.binding === binding ? failure.message : "";
  const latest = useRef({ binding, revision, closed: false, onSnapshot, onWritePendingChange });
  if (latest.current.binding !== binding) latest.current = { binding, revision, closed: false, onSnapshot, onWritePendingChange };
  latest.current.revision = revision; latest.current.onSnapshot = onSnapshot; latest.current.onWritePendingChange = onWritePendingChange;
  useEffect(() => {
    latest.current.closed = false;
    section.current?.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    return () => { if (latest.current.binding === binding) latest.current.closed = true; current.current?.controller.abort(); current.current = null; };
  }, [binding]);
  const value = preview?.binding === binding ? preview.value : undefined;
  const write = pending?.binding === binding ? pending.write : undefined;
  const committed = saved?.binding === binding ? saved.value : undefined;
  const snapshot = index?.binding === binding ? index.value : undefined;
  const fresh = !!committed && !!snapshot && snapshot.revision >= committed.revision && snapshot.revision >= revision;
  const review = fresh && !busy && locationReview?.binding === binding && locationReview.value.revision === snapshot.revision ? locationReview.value : undefined;
  const activeReview = useRef(review); activeReview.current = review;
  const reviewJob = review ? snapshot?.jobs.find(job => job.id === review.jobId) : undefined;
  const reviewLocation = review && reviewJob?.locationIds.includes(review.locationId) ? snapshot?.locations.find(location => location.id === review.locationId) : undefined;
  const importedJobs = committed?.jobIds.map(jobId => ({ jobId, job: snapshot?.jobs.find(job => job.id === jobId) })) ?? [];
  function closeLocationReview() { activeReview.current = undefined; setLocationReview(undefined); }
  function publishSnapshot(next: AtlasDataset) {
    if (latest.current.binding !== binding || latest.current.closed) return;
    setIndex({ binding, value: next }); latest.current.onSnapshot(next);
  }
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (current.current || latest.current.binding !== binding || latest.current.closed) return;
    const active = { binding, controller: new AbortController() };
    current.current = active; setOperation(binding); setFailure(undefined);
    const timeout = setTimeout(() => active.controller.abort(), 25_000);
    try { await operation(active.controller.signal); }
    catch (problem) {
      if (current.current === active) setFailure({ binding, message: active.controller.signal.aborted ? "已停止等待。已提交的写入可能完成；请重试同一请求核对回执。" : problem instanceof Error ? problem.message : "本次操作未完成。" });
    } finally { clearTimeout(timeout); if (current.current === active) { current.current = null; setOperation(undefined); } }
  };
  const alive = (signal: AbortSignal) => { signal.throwIfAborted(); if (current.current?.binding !== binding || latest.current.binding !== binding || latest.current.closed) throw new Error("操作范围已改变。"); };
  const readPreview = () => run(async signal => {
    const next = await binding.client.previewReviewedCards({ ...binding.capture, expectedRevision: revision }, { signal });
    alive(signal); setPreview({ binding, value: next }); setConfirmation(undefined);
  });
  const refresh = () => run(async signal => {
    closeLocationReview();
    const snapshot = await binding.client.snapshot({ signal }); alive(signal); publishSnapshot(snapshot);
    if (!committed) { setPreview(undefined); setConfirmation(undefined); }
  });
  const commit = () => run(async signal => {
    if (!write && (!value || !confirmed)) return;
    const attempt = write ?? { input: { ...binding.capture, expectedRevision: value!.expectedRevision, previewFingerprint: value!.previewFingerprint, reviewed: true as const }, key: `review-${crypto.randomUUID()}` };
    pendingWrite.current = { binding, write: attempt }; setPending(pendingWrite.current); latest.current.onWritePendingChange?.(true);
    let receipt;
    try { receipt = await binding.client.importReviewedCards(attempt.input, { signal, idempotencyKey: attempt.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized"].includes(problem.code)) {
        alive(signal); pendingWrite.current = undefined; setPending(undefined); latest.current.onWritePendingChange?.(false); setPreview(undefined); setConfirmation(undefined);
      }
      throw problem;
    }
    alive(signal); setSaved({ binding, value: { revision: receipt.revision, added: receipt.counts.newJobs, updated: receipt.counts.updatedJobs, jobIds: receipt.jobIds } }); pendingWrite.current = undefined; setPending(undefined); latest.current.onWritePendingChange?.(false); setIndex(undefined);
    try { const snapshot = await binding.client.snapshot({ signal }); alive(signal); publishSnapshot(snapshot); }
    catch (problem) { alive(signal); throw new Error(`岗位已写入索引版本 ${receipt.revision}，页面刷新未完成。请点击“重新读取索引”。${problem instanceof Error ? problem.message : ""}`, { cause: problem }); }
  });
  function close() {
    if (pendingWrite.current?.binding === binding) { setFailure({ binding, message: "这次写入的结果尚未确认，请先重试本次写入核对回执，再关闭或核对其他卡片。" }); return; }
    latest.current.closed = true; current.current?.controller.abort(); current.current = null; closeLocationReview(); setIndex(undefined); setDismissed(binding); onClose();
  }
  if (dismissed === binding) return null;
  return <section ref={section} className="atlas-source-review atlas-reviewed-import" aria-label="核对卡片并加入统一索引" aria-busy={busy}>
    <header><div><p className="atlas-source-review-eyebrow">REVIEW & INDEX</p><h2><FileSearch size={18} />核对卡片 · 加入统一搜索</h2><p>来源卡片摘要 · {capture.cards.length} 个岗位</p></div><button type="button" aria-label="关闭卡片入库核对" disabled={!!write} onClick={close}><X size={18} /></button></header>
    <p>请核对原文的岗位名称、雇主与地点。加入后可在同一索引搜索并接续机会库；这次提交保留为待核实的卡片摘录，薪资、在招状态、企业性质和位置精度仍需各自证据。</p>
    <p className="atlas-small">卡片读取时间：<time dateTime={capture.capturedAt}>{capture.capturedAt}</time>；发布时间以卡片披露为准。</p>
    {write && <p role="status">本次写入尚未确认，保留原批次与请求以核对回执。暂不能关闭、改换卡片批次或切换后端；请勿刷新或离开整个工作区，当前恢复凭据仅保存在本页内存。</p>}
    {capture.cards.map(card => <article className="atlas-source-review-card" key={card.url}><h3>{card.title}</h3><p>{card.company} · {card.locationText || "地点未披露"}</p><p>{card.salaryText || "薪资未披露"} · {card.publicationText || "发布时间未知"}</p><a href={card.url} target="_blank" rel="noopener noreferrer">在 {card.platform} 打开原岗位</a><details><summary>核对实际卡片原文</summary><pre className="atlas-reviewed-excerpt">{card.cardText}</pre></details></article>)}
    {value && <div role="status"><p>预览基于索引版本 {value.expectedRevision}：{value.cards.filter(card => !card.existing).length} 个新岗位，{value.cards.filter(card => card.existing).length} 个已有岗位。摘要不会替换已有的完整 JD。</p><ul>{value.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    {!committed && <div className="atlas-source-review-actions"><button type="button" disabled={busy || !!write || !hasAtlasServiceTarget(endpoint, token)} onClick={() => void readPreview()}>预览入库变化</button><button type="button" disabled={busy || !!write} onClick={() => void refresh()}>重新读取索引</button></div>}
    {value && !committed && <><label className="atlas-reviewed-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !!write} onChange={event => setConfirmation(event.target.checked ? binding : undefined)} />我已核对来源和卡片字段，确认以待核实摘要加入索引</label><button type="button" disabled={busy || (!write && !confirmed)} onClick={() => void commit()}>{busy && <Loader2 size={15} className="animate-spin" />}{write ? "重试本次写入 · 核对回执" : "确认加入统一索引"}</button></>}
    {busy && <p role="status"><Loader2 size={15} className="animate-spin" />正在处理本次请求…</p>}
    {committed && <><div className="atlas-reviewed-success" role="status"><Check size={16} /><p>已加入索引版本 {committed.revision}，新增 {committed.added}、更新 {committed.updated}。行政归属未核实的岗位可能被国内或地区筛选排除；符合筛选但缺少坐标的岗位仍待定位。核对地区不会生成办公坐标。</p><button type="button" disabled={busy} onClick={() => void refresh()}>重新读取索引</button></div>
      <section aria-label="新加入岗位的地区"><h3>核对本次加入岗位的地区</h3>
        {!snapshot ? <p>请先成功重新读取索引，再核对本次岗位地区。</p> : !fresh ? <p role="status">当前地区记录基于索引版本 {snapshot.revision}，最新已知版本为 {Math.max(revision, committed.revision)}。请重新读取索引后再核对地区。</p> : <>
          <p className="atlas-small">以下地点来自本次回执对应的索引版本 {snapshot.revision}，可直接核对，不受当前搜索筛选影响。</p>
          {importedJobs.map(({ jobId, job }) => <article className="atlas-source-review-card" key={jobId}><h4>{job?.title.value ?? "该岗位不在当前索引中"}</h4>
            {!job || !job.locationIds.length ? <p>当前索引没有该岗位可核对的地点记录；请重新读取索引或核对来源。</p> : job.locationIds.map(locationId => {
              const location = snapshot.locations.find(entry => entry.id === locationId);
              return location ? <div key={locationId}><p>来源地点原文：<strong>{location.raw}</strong></p><p>行政范围：{[location.countryCode, location.region, location.city, location.district].filter(Boolean).join(" / ") || "未确认行政范围"} · {location.coordinates ? "已有坐标，精度以索引记录为准" : "坐标待定位"}</p><button type="button" disabled={busy} onClick={() => setLocationReview({ binding, value: { jobId, locationId, revision: snapshot.revision } })}>核对该岗位地区</button></div> : <p key={locationId}>当前索引缺少此地点记录；请重新读取索引后核对。</p>;
            })}</article>)}
        </>}
      </section>
      {review && reviewLocation && <Suspense fallback={<p role="status"><Loader2 size={15} className="animate-spin" />正在打开地区核对…</p>}><AtlasLocationConfirmation endpoint={endpoint} token={token} jobId={review.jobId} location={reviewLocation} revision={review.revision} onClose={closeLocationReview} onSnapshot={next => {
        if (latest.current.binding !== binding || latest.current.closed || activeReview.current !== review || latest.current.revision > review.revision) return;
        closeLocationReview(); publishSnapshot(next);
      }} /></Suspense>}
    </>}
    {error && <p role="alert" className="atlas-source-review-error">{error}</p>}
  </section>;
}
