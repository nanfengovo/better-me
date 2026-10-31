import type { BaselineProgress } from "../../../../job-service/src/dataset-baseline-contract";

/** Functional loading state only. No motion, query policy, persistence or source writes. */
export function AtlasBaselineStatus({ progress, loading, onRetry }: { progress: BaselineProgress; loading: boolean; onRetry(): void }) {
  return <div className="atlas-small" role="status" aria-label="首次岗位基线加载">
    <strong>{loading ? "正在分页加载岗位" : "岗位基线读取未完成"}</strong>{" · "}
    已加载 {progress.loadedJobs.toLocaleString()} / {progress.totalJobs.toLocaleString()} 岗。
    列表、筛选和地图可先使用已加载部分；当前匹配数不代表全库结果。
    {!loading && <button type="button" onClick={onRetry}>重试读取索引</button>}
  </div>;
}
