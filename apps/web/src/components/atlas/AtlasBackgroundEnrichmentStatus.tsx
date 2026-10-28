import type { BackgroundEnrichmentState } from "./use-background-enrichment";
import { ChevronDown } from "lucide-react";

export function AtlasBackgroundEnrichmentStatus({ state }: { state: BackgroundEnrichmentState }) {
  const { status, loading, refreshingSnapshot } = state;
  if (!status && !loading && !state.error) return null;
  const error = state.error ?? (status?.workerState === "error" || status?.workerError
    ? "后台补全暂不可用，将自动重试。" : undefined);
  const activity = loading ? "正在读取后台状态"
    : error ? "最近一次状态"
    : refreshingSnapshot ? "正在更新岗位视图"
    : status?.workerState === "stopped" ? "后台服务未运行，任务已保留"
    : (status?.running ?? 0) > 0 ? "后台处理中"
    : (status?.pending ?? 0) > 0 ? "等待后台处理"
    : (status?.failed ?? 0) > 0 ? status?.nextRetryAt ? "部分任务等待自动重试" : "有异常任务需关注" : "当前无待处理任务";

  return (
    <details className="atlas-background-enrichment" data-state={error || status?.workerState === "stopped" || (status?.failed ?? 0) > 0 ? "attention" : loading || (status?.pending ?? 0) + (status?.running ?? 0) > 0 ? "working" : "idle"} aria-label="地区与企业后台补全状态">
      <summary className="atlas-background-enrichment-heading">
        <strong>地区/企业后台补全</strong>
        <span className="atlas-background-enrichment-activity" role="status">{error || activity}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      {error && <p className="atlas-background-enrichment-error">{activity}</p>}
      {status && <dl aria-label="后台任务项状态">
          <div><dt>待处理</dt><dd>{status.pending + status.running}</dd></div>
          <div><dt>已完成</dt><dd>{status.completed}</dd></div>
          <div data-warning={status.failed > 0}><dt>异常</dt><dd>{status.failed}</dd></div>
        </dl>}
      <p className="atlas-background-enrichment-note">按地区/企业任务项，不是岗位总数；待处理含正在执行。无来源真实坐标，不生成办公点。</p>
    </details>
  );
}
