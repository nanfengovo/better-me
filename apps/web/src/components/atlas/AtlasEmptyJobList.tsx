import { Sparkles } from "lucide-react";
import { AtlasIllustration } from "./AtlasIllustration";

interface AtlasEmptyJobListProps {
  dataLoading: boolean;
  emptyIndex: boolean;
  hasData: boolean;
  dataMode: string;
  connected: boolean;
  hasSearchableSources: boolean;
  hasResumeData: boolean;
  resumeSummaryLabel: string;
  onOpenCollection: () => void;
  onOpenConnectionSettings: () => void;
  onOpenOpportunitySources?: () => void;
  onResetFilters: () => void;
  onOpenPlatformSearch: () => void;
  onApplyResumePrefill: () => void;
}

export function AtlasEmptyJobList({
  dataLoading,
  emptyIndex,
  hasData,
  dataMode,
  connected,
  hasSearchableSources,
  hasResumeData,
  resumeSummaryLabel,
  onOpenCollection,
  onOpenConnectionSettings,
  onOpenOpportunitySources,
  onResetFilters,
  onOpenPlatformSearch,
  onApplyResumePrefill,
}: AtlasEmptyJobListProps) {
  return (
    <div className="atlas-empty">
      {!dataLoading && <AtlasIllustration kind={emptyIndex || !hasData ? "discovery" : "search"} />}
      <strong>
        {dataLoading
          ? "正在读取岗位…"
          : emptyIndex
            ? "先把真实岗位接入地图"
            : !hasData && dataMode === "live"
              ? "连接本机索引，查看已采集岗位"
              : "暂未找到匹配岗位"}
      </strong>
      <p>
        {dataLoading
          ? "已读取的岗位会逐步显示，地图随后更新。"
          : emptyIndex
            ? "连接本机采集索引，或读取并收藏招聘原文。岗位会逐步出现，地区与企业在后台自动补全。"
            : !hasData && dataMode === "live"
              ? "暂未取得本机岗位数据。请检查服务连接；已有数据不会因此清空。"
              : "已收录岗位中没有匹配项。可以清除筛选、扩大地区范围，或继续读取招聘来源。"}
      </p>
      {!dataLoading && (
        <div className="atlas-empty-actions">
          {emptyIndex || !hasData ? (
            <>
              <button
                className="atlas-empty-primary"
                onClick={() => (connected ? onOpenCollection() : onOpenConnectionSettings())}
              >
                {connected
                  ? hasSearchableSources
                    ? "从已配置来源获取岗位"
                    : "配置岗位来源"
                  : "连接真实来源搜索"}
              </button>
              {onOpenOpportunitySources && (
                <button onClick={onOpenOpportunitySources}>读取并收藏单个岗位</button>
              )}
            </>
          ) : (
            <button className="atlas-empty-primary" onClick={onResetFilters}>
              清除筛选
            </button>
          )}
          <button type="button" className="atlas-empty-btn-platform" onClick={onOpenPlatformSearch}>
            查看招聘平台与采集选项
          </button>
          {hasResumeData && (
            <button type="button" className="atlas-empty-btn-prefill" onClick={onApplyResumePrefill}>
              <Sparkles size={14} />参考当前简历自动填入（{resumeSummaryLabel}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
