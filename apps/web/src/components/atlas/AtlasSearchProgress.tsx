/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import { Check, CheckCheck, CircleAlert, Clock3, LoaderCircle, Pause, X } from "lucide-react";
import type { AtlasAggregateProgress, AtlasAggregateSource } from "./aggregate-search";
import "./atlas-search-progress.css";

export type AtlasSearchProgressProps = {
  progress: AtlasAggregateProgress | null;
  busy: boolean;
  onCancel: () => void;
  onReviewSource?: (source: AtlasAggregateSource) => void;
};

function errorLabel(code: string): string {
  const labels: Record<string, string> = { timeout: "读取超时，尚未读完", "rate-limited": "原站限流", "needs-auth": "原站需要登录", "source-changed": "原站结构变化，需核对", "budget-exceeded": "已达到本次读取预算" };
  return labels[code] ?? `读取中断：${code}`;
}

function sourceLabel(source: AtlasAggregateSource): string {
  if (source.error?.code === "rate-limited" && source.error.status === 429) return "刷新间隔限制 · 稍后重试";
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

function SourceRow({ source, onReview }: { source: AtlasAggregateSource; onReview?: (source: AtlasAggregateSource) => void }) {
  const summary = source.receipt?.run.summary;
  const counts = [
    summary?.records === undefined ? null : `原始返回 ${summary.records} 条`,
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
      {sourceError && <p className="atlas-acquisition-uncertain">{errorLabel(sourceError.code)}{sourceError.retryAfterSeconds !== undefined && ` · 建议 ${sourceError.retryAfterSeconds} 秒后重试`}</p>}
      {onReview && (summary?.needsHuman ?? 0) > 0 && <button type="button" onClick={() => onReview(source)}>查看未核对候选</button>}
      {source.outcomeUnknown && <p className="atlas-acquisition-uncertain">{source.error?.code === "rate-limited" && source.error.status === 429 ? "本次刷新被间隔策略拒绝，已收录岗位仍可筛选。此前未确认的请求继续保留原标识，请重新读取索引核对。" : "未收到最终回执，部分岗位可能已保存。请重新读取索引核对；重试沿用本轮请求标识。"}</p>}
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
export function AtlasSearchProgress({ progress, busy, onCancel, onReviewSource }: AtlasSearchProgressProps) {
  const [expanded, setExpanded] = useState(false);
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
  const incomplete = progress?.sources.filter((source) => source.outcomeUnknown || source.status !== "completed").length ?? 0;
  const stage = busy
    ? !total || settled === 0 && !progress?.running ? "正在准备来源搜索" : settled === total ? "正在更新岗位索引" : "正在读取真实岗位"
    : progress?.cancelled ? "本轮等待已取消" : hasIssues ? "本轮仅完成部分读取" : "本轮来源读取已结束";
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
        {!busy && total > 0 && <button type="button" aria-expanded={expanded} aria-controls="atlas-acquisition-details" onClick={() => setExpanded(!expanded)}>{expanded ? "收起逐源明细" : "展开逐源明细"}</button>}
      </div>
    </div>
    <div className="atlas-acquisition-track" role="progressbar" aria-label="本轮来源处理进度"
      aria-valuemin={0} aria-valuemax={total || undefined} aria-valuenow={total ? settled : undefined}
      aria-valuetext={total ? `已结束等待 ${settled} / ${total} 个来源，包含完成、失败或取消；已返回 ${returned} 个真实回执。` : "正在准备来源，尚无进度回执。"}>
      <span style={{ width: `${completion}%` }} />
    </div>
    <p className="atlas-acquisition-explanation">{busy ? "各来源独立读取，已确认匹配的岗位先更新到索引与列表。" : incomplete ? `${incomplete} 个来源未完整读完或尚待核对；原始返回条数不是关键词命中数。` : "仅统计本轮配置来源，不代表全市场覆盖；原始返回条数不是关键词命中数。"}{total > 0 && <span>已结束等待 {settled} / {total} · 读取中 {progress?.running ?? 0} · 排队 {progress?.queued ?? 0}</span>}</p>
    {!busy && !expanded && incomplete > 0 && <p className="atlas-acquisition-summary">{progress?.sources.filter((source) => source.outcomeUnknown || source.status !== "completed").map((source) => `${source.label}：${source.receipt?.sourceError ? errorLabel(source.receipt.sourceError.code) : sourceLabel(source)}${source.receipt?.run.summary?.needsHuman ? `，${source.receipt.run.summary.needsHuman} 条要求待核对` : ""}`).join("；")}</p>}
    {!busy && !expanded && onReviewSource && <div className="atlas-acquisition-review-actions">{progress?.sources.filter((source) => (source.receipt?.run.summary?.needsHuman ?? 0) > 0).map((source) => <button key={source.sourceId} type="button" onClick={() => onReviewSource(source)}>查看 {source.label} 未核对候选</button>)}</div>}
    {progress && progress.sources.length > 0 ? <ul id="atlas-acquisition-details" hidden={!busy && !expanded} className="atlas-acquisition-sources" aria-label="逐来源读取状态">{progress.sources.map((source) => <SourceRow key={source.sourceId} source={source} onReview={busy ? undefined : onReviewSource} />)}</ul>
      : busy && <div className="atlas-acquisition-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </section>;
}
