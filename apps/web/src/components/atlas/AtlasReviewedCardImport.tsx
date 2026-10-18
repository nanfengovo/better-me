/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSearch, Loader2, X } from "lucide-react";
import type { AtlasDataset } from "@better-me/opportunities";
import type { ImportReviewedCardsInput, ReviewedCardsCapture, ReviewedCardsPreview } from "@better-me/source-adapters/browser-contracts";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasSourceCandidateReview.css";
import "./AtlasReviewedCardImport.css";

export type AtlasReviewedCardImportProps = {
  endpoint: string; token: string; capture: ReviewedCardsCapture; revision: number;
  onClose: () => void; onSnapshot: (snapshot: AtlasDataset) => void;
};
type Write = { input: ImportReviewedCardsInput; key: string };
type Saved = { revision: number; added: number; updated: number };

/** Explicit human review. Submitted evidence is unverified; a card never claims to be a complete JD. */
export function AtlasReviewedCardImport({ endpoint, token, capture, revision, onClose, onSnapshot }: AtlasReviewedCardImportProps) {
  const captureKey = JSON.stringify(capture);
  const binding = useMemo(() => ({ client: createAtlasSourceClient(endpoint, token), capture: JSON.parse(captureKey) as ReviewedCardsCapture }), [endpoint, token, captureKey]);
  const current = useRef<{ binding: typeof binding; controller: AbortController } | null>(null);
  const section = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<{ binding: typeof binding; value: ReviewedCardsPreview }>();
  const [pending, setPending] = useState<{ binding: typeof binding; write: Write }>();
  const [saved, setSaved] = useState<{ binding: typeof binding; value: Saved }>();
  const [confirmation, setConfirmation] = useState<typeof binding>();
  const [operation, setOperation] = useState<typeof binding>();
  const [failure, setFailure] = useState<{ binding: typeof binding; message: string }>();
  const confirmed = confirmation === binding;
  const busy = operation === binding;
  const error = failure?.binding === binding ? failure.message : "";
  useEffect(() => {
    section.current?.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    return () => { current.current?.controller.abort(); current.current = null; };
  }, [binding]);
  const value = preview?.binding === binding ? preview.value : undefined;
  const write = pending?.binding === binding ? pending.write : undefined;
  const committed = saved?.binding === binding ? saved.value : undefined;
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (current.current) return;
    const active = { binding, controller: new AbortController() };
    current.current = active; setOperation(binding); setFailure(undefined);
    const timeout = setTimeout(() => active.controller.abort(), 25_000);
    try { await operation(active.controller.signal); }
    catch (problem) {
      if (current.current === active) setFailure({ binding, message: active.controller.signal.aborted ? "已停止等待。已提交的写入可能完成；请重试同一请求核对回执。" : problem instanceof Error ? problem.message : "本次操作未完成。" });
    } finally { clearTimeout(timeout); if (current.current === active) { current.current = null; setOperation(undefined); } }
  };
  const alive = (signal: AbortSignal) => { signal.throwIfAborted(); if (current.current?.binding !== binding) throw new Error("操作范围已改变。"); };
  const readPreview = () => run(async signal => {
    const next = await binding.client.previewReviewedCards({ ...binding.capture, expectedRevision: revision }, { signal });
    alive(signal); setPreview({ binding, value: next }); setConfirmation(undefined);
  });
  const refresh = () => run(async signal => {
    const snapshot = await binding.client.snapshot({ signal }); alive(signal); onSnapshot(snapshot);
    if (!committed) { setPreview(undefined); setConfirmation(undefined); }
  });
  const commit = () => run(async signal => {
    if (!write && (!value || !confirmed)) return;
    const attempt = write ?? { input: { ...binding.capture, expectedRevision: value!.expectedRevision, previewFingerprint: value!.previewFingerprint, reviewed: true as const }, key: `review-${crypto.randomUUID()}` };
    setPending({ binding, write: attempt });
    let receipt;
    try { receipt = await binding.client.importReviewedCards(attempt.input, { signal, idempotencyKey: attempt.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized"].includes(problem.code)) {
        alive(signal); setPending(undefined); setPreview(undefined); setConfirmation(undefined);
      }
      throw problem;
    }
    alive(signal); setSaved({ binding, value: { revision: receipt.revision, added: receipt.counts.newJobs, updated: receipt.counts.updatedJobs } }); setPending(undefined);
    try { const snapshot = await binding.client.snapshot({ signal }); alive(signal); onSnapshot(snapshot); }
    catch (problem) { alive(signal); throw new Error(`岗位已写入索引版本 ${receipt.revision}，页面刷新未完成。请点击“重新读取索引”。${problem instanceof Error ? problem.message : ""}`, { cause: problem }); }
  });
  function close() { current.current?.controller.abort(); current.current = null; onClose(); }
  return <section ref={section} className="atlas-source-review atlas-reviewed-import" aria-label="核对卡片并加入统一索引" aria-busy={busy}>
    <header><div><p className="atlas-source-review-eyebrow">REVIEW & INDEX</p><h2><FileSearch size={18} />核对卡片 · 加入统一搜索</h2><p>来源卡片摘要 · {capture.cards.length} 个岗位</p></div><button type="button" aria-label="关闭卡片入库核对" onClick={close}><X size={18} /></button></header>
    <p>请核对原文的岗位名称、雇主与地点。加入后可在同一索引搜索并接续机会库；这次提交保留为待核实的卡片摘录，薪资、在招状态、企业性质和位置精度仍需各自证据。</p>
    <p className="atlas-small">卡片读取时间：<time dateTime={capture.capturedAt}>{capture.capturedAt}</time>；发布时间以卡片披露为准。</p>
    {capture.cards.map(card => <article className="atlas-source-review-card" key={card.url}><h3>{card.title}</h3><p>{card.company} · {card.locationText || "地点未披露"}</p><p>{card.salaryText || "薪资未披露"} · {card.publicationText || "发布时间未知"}</p><a href={card.url} target="_blank" rel="noopener noreferrer">在 {card.platform} 打开原岗位</a><details><summary>核对实际卡片原文</summary><pre className="atlas-reviewed-excerpt">{card.cardText}</pre></details></article>)}
    {value && <div role="status"><p>预览基于索引版本 {value.expectedRevision}：{value.cards.filter(card => !card.existing).length} 个新岗位，{value.cards.filter(card => card.existing).length} 个已有岗位。摘要不会替换已有的完整 JD。</p><ul>{value.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    {!committed && <div className="atlas-source-review-actions"><button type="button" disabled={busy || !!write || !token.trim()} onClick={() => void readPreview()}>预览入库变化</button><button type="button" disabled={busy || !!write} onClick={() => void refresh()}>重新读取索引</button></div>}
    {value && !committed && <><label className="atlas-reviewed-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !!write} onChange={event => setConfirmation(event.target.checked ? binding : undefined)} />我已核对来源和卡片字段，确认以待核实摘要加入索引</label><button type="button" disabled={busy || (!write && !confirmed)} onClick={() => void commit()}>{busy && <Loader2 size={15} className="animate-spin" />}{write ? "重试本次写入 · 核对回执" : "确认加入统一索引"}</button></>}
    {busy && <p role="status"><Loader2 size={15} className="animate-spin" />正在处理本次请求…</p>}
    {committed && <div className="atlas-reviewed-success" role="status"><Check size={16} /><p>已加入索引版本 {committed.revision}，新增 {committed.added}、更新 {committed.updated}。缺少坐标的岗位会显示在待定位列表。</p><button type="button" disabled={busy} onClick={() => void refresh()}>重新读取索引</button></div>}
    {error && <p role="alert" className="atlas-source-review-error">{error}</p>}
  </section>;
}
