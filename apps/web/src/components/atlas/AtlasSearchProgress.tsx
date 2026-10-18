/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import { Check, CheckCheck, CircleAlert, Clock3, LoaderCircle, Pause, X } from "lucide-react";
import type { AtlasAggregateProgress, AtlasAggregateSource } from "./aggregate-search";
import "./atlas-search-progress.css";

export type AtlasSearchProgressProps = {
  progress: AtlasAggregateProgress | null;
  busy: boolean;
  onCancel: () => void;
};

function sourceLabel(source: AtlasAggregateSource): string {
  if (source.outcomeUnknown) return "等待已结束 · 待核对回执";
  switch (source.status) {
    case "queued": return "排队等待";
    case "running": return source.settled ? "服务端仍在运行 · 待核对" : "正在读取";
    case "completed": return "已完成读取";
    case "partial": return "部分读取";
    case "failed": return "读取失败";
    case "cancelled": return "已取消等待";
    case "superseded": return "已被新请求替代";
  }
}

function SourceIcon({ source }: { source: AtlasAggregateSource }) {
  if (source.outcomeUnknown || source.status === "failed" || source.status === "partial") return <CircleAlert size={15} />;
  if (source.status === "completed") return <Check size={15} />;
  if (source.status === "queued") return <Clock3 size={15} />;
  if (source.status === "cancelled" || source.status === "superseded") return <Pause size={14} />;
  return <LoaderCircle size={15} className={source.settled ? "" : "atlas-acquisition-spinner"} />;
}

function SourceRow({ source }: { source: AtlasAggregateSource }) {
  const summary = source.receipt?.run.summary;
  const counts = [
    summary?.records === undefined ? null : `读取 ${summary.records} 条`,
    summary?.pages === undefined ? null : `${summary.pages} 页`,
    summary?.added === undefined ? null : `新增 ${summary.added}`,
    summary?.changed === undefined ? null : `更新 ${summary.changed}`,
    summary?.needsHuman === undefined ? null : `待人工核对 ${summary.needsHuman}`,
  ].filter((value): value is string => value !== null);
  const warnings = source.receipt?.warnings ?? [];
  const sourceError = source.receipt?.sourceError;
  const issueCount = warnings.length + Number(Boolean(sourceError)) + Number(Boolean(source.error));
  const tone = source.outcomeUnknown ? "unknown" : source.status;
  return <li className={`atlas-acquisition-source is-${tone}`}>
    <span className="atlas-acquisition-source-icon" aria-hidden="true"><SourceIcon source={source} /></span>
    <div className="atlas-acquisition-source-body">
      <div className="atlas-acquisition-source-title"><strong>{source.label}</strong><span>{sourceLabel(source)}</span></div>
      {counts.length > 0 && <p className="atlas-acquisition-counts">{counts.join(" · ")}</p>}
      {source.outcomeUnknown && <p className="atlas-acquisition-uncertain">未收到最终回执，部分岗位可能已保存。请重新读取索引核对；重试沿用本轮请求标识。</p>}
      {source.status === "running" && source.settled && <p className="atlas-acquisition-uncertain">本次回执仍为运行中，尚不能确认最终结果，请稍后重新读取索引核对。</p>}
      {issueCount > 0 && <details className="atlas-acquisition-notices">
        <summary>查看来源提示 <span>{issueCount}</span></summary>
        <ul>
          {source.error && <li>{source.error.message}{source.error.code && <> <code>{source.error.code}</code></>}{source.error.status !== undefined && <> · HTTP {source.error.status}</>}</li>}
          {sourceError && <li>来源返回：<code>{sourceError.code}</code>{sourceError.retryAfterSeconds !== undefined && <> · 来源建议 {sourceError.retryAfterSeconds} 秒后重试</>}</li>}
          {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
        </ul>
      </details>}
    </div>
  </li>;
}

/** Real source receipts and measured elapsed time; no simulated percentage or remaining ETA. */
export function AtlasSearchProgress({ progress, busy, onCancel }: AtlasSearchProgressProps) {
  const [clock, setClock] = useState<{ seconds: number; measured: boolean }>({ seconds: 0, measured: false });
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setClock({ seconds: 0, measured: true });
    const interval = setInterval(() => setClock({ seconds: Math.max(0, Math.floor((Date.now() - started) / 1000)), measured: true }), 1000);
    return () => clearInterval(interval);
  }, [busy]);
  if (!progress && !busy) return null;

  const total = progress?.total ?? 0;
  const returned = progress?.sources.filter((source) => source.receipt !== undefined).length ?? 0;
  const settled = progress?.settled ?? 0;
  const hasIssues = progress?.sources.some((source) => source.outcomeUnknown || source.status === "running" && source.settled || ["failed", "partial", "superseded"].includes(source.status));
  const stage = busy
    ? !total || settled === 0 && !progress?.running ? "正在准备来源搜索" : settled === total ? "正在更新岗位索引" : "正在读取真实岗位"
    : progress?.cancelled ? "本轮等待已取消" : "本轮来源读取已结束";
  const completion = total > 0 ? Math.min(100, Math.max(0, settled / total * 100)) : 0;
  return <section className={`atlas-acquisition ${busy ? "is-busy" : "is-settled"}`} aria-label="真实来源读取进度">
    <div className="atlas-acquisition-heading">
      <span className="atlas-acquisition-radar" aria-hidden="true">{busy ? <span /> : progress?.cancelled ? <Pause size={17} /> : hasIssues ? <CircleAlert size={19} /> : <CheckCheck size={19} />}</span>
      <div className="atlas-acquisition-heading-copy">
        <p className="atlas-acquisition-eyebrow">SOURCE ACQUISITION</p>
        <p className="atlas-acquisition-status" role="status" aria-atomic="true"><strong>{stage}</strong><span>{total > 0 ? `已返回 ${returned} / ${total} 个来源回执` : "正在核对本轮来源与请求范围"}</span></p>
      </div>
      <div className="atlas-acquisition-heading-actions">
        {clock.measured && <span className="atlas-acquisition-elapsed" aria-live="off">已用时 <b>{clock.seconds}</b> 秒</span>}
        {busy && <button type="button" className="atlas-acquisition-cancel" onClick={onCancel}><X size={13} aria-hidden="true" />取消等待</button>}
      </div>
    </div>
    <div className="atlas-acquisition-track" role="progressbar" aria-label="本轮来源处理进度"
      aria-valuemin={0} aria-valuemax={total || undefined} aria-valuenow={total ? settled : undefined}
      aria-valuetext={total ? `已结束等待 ${settled} / ${total} 个来源，包含完成、失败或取消；已返回 ${returned} 个真实回执。` : "正在准备来源，尚无进度回执。"}>
      <span style={{ width: `${completion}%` }} />
    </div>
    <p className="atlas-acquisition-explanation">{busy ? "各来源独立读取，已返回的岗位会先更新到索引与列表。" : "进度按本轮配置来源统计，失败或取消不代表原站没有岗位。"}{total > 0 && <span>已结束等待 {settled} / {total} · 读取中 {progress?.running ?? 0} · 排队 {progress?.queued ?? 0}</span>}</p>
    {progress && progress.sources.length > 0 ? <ul className="atlas-acquisition-sources" aria-label="逐来源读取状态">{progress.sources.map((source) => <SourceRow key={source.sourceId} source={source} />)}</ul>
      : busy && <div className="atlas-acquisition-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </section>;
}
