import type { LivePlatformImportSummary } from "./live-platform-auto-import";
import { liveHarvestStopReasonLabel } from "./live-harvest-view";

export function formatLivePlatformNotice(summary: LivePlatformImportSummary | undefined): string {
  if (!summary) return "";
  const parts: string[] = [];
  if (summary.importedPlatforms.length > 0) {
    parts.push(
      `🌐 商业平台本轮实时读取（${summary.importedPlatforms.join("、")}）：读取 ${summary.totalCardsFetched} 条原站岗位卡片，新增入库 ${summary.totalAdded} 岗、更新 ${summary.totalUpdated} 岗。地区与企业信息由后台按来源自动补全，进度独立显示；未生成推测办公坐标。`,
    );
  }
  if (summary.platformCoverage.length > 0) {
    parts.push(`实时采集覆盖：${summary.platformCoverage.map((entry) => {
      const { coverage } = entry;
      const progress = entry.provider === "boss"
        ? `${entry.platform} ${entry.cardsCollected}条 / 虚拟列表滚动${coverage.scrollSteps}/${coverage.scrollLimit}步`
        : `${entry.platform} ${entry.cardsCollected}条 / ${coverage.pagesVisited}页（预算${coverage.pageLimit}页）`;
      if (entry.status === "error") return `${progress} · 失败${entry.error ? `：${entry.error}` : ""}`;
      if (entry.status === "empty" && !coverage.partial) return `${progress} · 平台返回空列表`;
      const stopLabel = liveHarvestStopReasonLabel(entry.status, coverage.stopReason, coverage.failureKind);
      return coverage.partial ? `${progress} · 未完成：${stopLabel}` : `${progress} · ${stopLabel}`;
    }).join("；")}。`);
  }
  const conflicts = summary.importFailures.filter((failure) => failure.conflict);
  if (conflicts.length) {
    parts.push(`公司归属冲突已逐岗隔离 ${conflicts.reduce((sum, failure) => sum + failure.cards, 0)} 条（${conflicts.map((failure) => `${failure.platform}：${failure.error}`).join("；")}）。冲突记录已保留，其余岗位照常入库和补全地区。`);
  }
  const unconfirmedImports = summary.importFailures.filter((failure) => !failure.conflict);
  if (unconfirmedImports.length > 0) {
    const failedCards = unconfirmedImports.reduce((total, failure) => total + failure.cards, 0);
    parts.push(`实时卡片提交未确认 ${failedCards} 条（${unconfirmedImports.map((failure) => `${failure.platform}：${failure.error}`).join("；")}）。卡片仍保留在原站实时列表；未收到成功回执不等于未写入，索引与地图以已确认结果为准。`);
  }
  if (summary.loginRequiredPlatforms.length > 0) {
    parts.push(
      `提示：${summary.loginRequiredPlatforms.join("、")} 需在已开启的独立 Chrome 窗口扫码登录一次以解锁实时卡片抓取。`,
    );
  }
  if (summary.verificationRequiredPlatforms.length > 0) {
    parts.push(
      `提示：${summary.verificationRequiredPlatforms.join("、")} 触发页面安全验证，可在独立 Chrome 窗口完成后重试。`,
    );
  }
  return parts.join(" ");
}
