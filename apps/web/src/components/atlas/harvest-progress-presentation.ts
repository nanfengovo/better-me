import type { ClientPipelineProgress, ClientPipelineStage } from "./harvest-pipeline";

export type HarvestProgressState = Pick<ClientPipelineProgress, "stage" | "stageIndex" | "totalStages" | "message" | "stats">;

const RUN_COUNT_KEYS = [
  "cardsFetched", "committedCards", "pendingCards", "pendingBatches", "failedCards", "cancelledCards",
  "totalAdded", "totalUpdated", "totalUnchanged", "failedQueryTerms", "completedQueryTerms", "queryTermTotal",
  "failedPlatforms", "blockedPlatforms", "partialPlatforms",
] as const;

export function toHarvestProgressState(progress: ClientPipelineProgress, previous?: HarvestProgressState | null): HarvestProgressState {
  const stats = { ...progress.stats };
  // Source, writer and enrichment progress are interleaved. Only inherit
  // known run counters; query-local messages/errors must not follow the next term.
  if (previous && progress.stage !== "intent-expansion") {
    for (const key of RUN_COUNT_KEYS) {
      const confirmed = finiteProgressStat(previous.stats, key);
      if (stats[key] === undefined && confirmed !== undefined) stats[key] = confirmed;
    }
  }
  return {
    stage: progress.stage,
    stageIndex: progress.stageIndex,
    totalStages: progress.totalStages,
    message: progress.message,
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
  };
}

type LiveCommitTotals = { totalAdded: number; totalUpdated: number };

/** Snapshot refreshes may finish after more recent commit receipts. */
export function mergeLiveCommitTotals(previous: LiveCommitTotals | undefined, incoming: LiveCommitTotals): LiveCommitTotals {
  return {
    totalAdded: Math.max(previous?.totalAdded ?? 0, incoming.totalAdded),
    totalUpdated: Math.max(previous?.totalUpdated ?? 0, incoming.totalUpdated),
  };
}

const stageHeadlines: Record<ClientPipelineStage, string> = {
  "intent-expansion": "正在准备实时检索词",
  "platform-harvest": "正在读取招聘平台原站页面",
  "cas-ingestion": "正在保存已核验岗位",
  "enterprise-intelligence": "正在核对地区与企业信息",
  "spatial-geocoding": "正在汇总地图定位状态",
  completed: "本轮平台读取与索引处理已结束",
};

export function harvestStageHeadline(stage: ClientPipelineStage): string {
  return stageHeadlines[stage];
}

export function harvestStageName(index: number): string {
  return ["检索准备", "原站采集", "岗位入库", "地区与企业", "地图汇总"][index - 1] ?? "处理中";
}

export function harvestStepState(index: number, activeIndex: number, concurrentIngestion = false): "complete" | "current" | "pending" {
  if (concurrentIngestion && (index === 2 || index === 3)) return "current";
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "current";
  return "pending";
}

export function finiteProgressStat(stats: Record<string, number | string> | undefined, key: string): number | undefined {
  const value = stats?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function stringProgressStat(stats: Record<string, number | string> | undefined, key: string): string | undefined {
  const value = stats?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
