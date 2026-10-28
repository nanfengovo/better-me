/** @jsxRuntime automatic */
import { useState } from "react";
import { ShieldCheck, Sparkles, Layers, ArrowUpRight, Check, Globe2, MapPin } from "lucide-react";
import { AtlasIllustration } from "./AtlasIllustration";
import {
  PLATFORM_SEARCH_PROVIDERS,
  buildPlatformSearchRequest,
  resolvePlatformSearchRegion,
  type PlatformSearchRequest,
} from "@better-me/source-adapters/browser-contracts";
import { openUrlInRealChrome, openUrlsInRealChrome } from "../../lib/real-chrome-client";
import "./atlas-live-platform-quick-search.css";

export type AtlasLivePlatformQuickSearchProps = {
  keyword: string;
  regionText: string;
  countryCode: string;
  onOpenAggregator: () => void;
  onLiveCaptureNow?: () => void;
  liveCapturing?: boolean;
  onResetFilters: () => void;
  broaderMatches?: {
    domesticCount: number;
    globalCount: number;
    onExpandDomestic: () => void;
    onExpandGlobal: () => void;
  };
  resumePrefill?: {
    hasResumeData: boolean;
    summaryLabel: string;
    apply: () => void;
  };
};

export function AtlasLivePlatformQuickSearch({
  keyword,
  regionText,
  countryCode,
  onOpenAggregator,
  onLiveCaptureNow,
  liveCapturing = false,
  onResetFilters,
  broaderMatches,
  resumePrefill,
}: AtlasLivePlatformQuickSearchProps) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openedNotice, setOpenedNotice] = useState<string | null>(null);

  const region = regionText.trim()
    ? resolvePlatformSearchRegion(regionText.trim())
    : countryCode.trim()
      ? resolvePlatformSearchRegion(countryCode.trim())
      : undefined;

  const searches: Array<{
    provider: (typeof PLATFORM_SEARCH_PROVIDERS)[number];
    request?: PlatformSearchRequest;
    badge: string;
  }> = PLATFORM_SEARCH_PROVIDERS.map((provider) => {
    const badge = "平台原站";

    try {
      const request = buildPlatformSearchRequest({
        provider: provider.id,
        keyword: keyword.trim(),
        ...(region ? { regionId: region.id } : {}),
      });
      return { provider, request, badge };
    } catch {
      return { provider, request: undefined, badge };
    }
  });

  const available = searches.filter((s): s is typeof s & { request: PlatformSearchRequest } => Boolean(s.request));
  const domesticAvailable = available.filter((s) => ["boss", "liepin", "51job"].includes(s.provider.id));

  const handleOpenRealChrome = async (req: PlatformSearchRequest, name: string) => {
    setOpening(name);
    setOpenedNotice(null);
    try {
      const ok = await openUrlInRealChrome(req.url);
      if (ok) {
        setOpenedNotice(`已在 Chrome 中打开 ${name} 搜索。平台可能仍要求登录或验证。`);
      } else {
        window.open(req.url, "_blank", "noopener,noreferrer");
        setOpenedNotice(`已在新标签页打开 ${name} 搜索`);
      }
    } finally {
      setOpening(null);
      setTimeout(() => setOpenedNotice(null), 5000);
    }
  };

  const handleBatchOpenRealChrome = async () => {
    setOpening("batch");
    setOpenedNotice(null);
    const urls = domesticAvailable.length ? domesticAvailable.map((s) => s.request.url) : available.map((s) => s.request.url);
    try {
      const ok = await openUrlsInRealChrome(urls);
      if (ok) {
        setOpenedNotice("已在真实 Chrome 中批量开启 BOSS、猎聘、51JOB 等平台搜索窗口！");
      } else {
        for (const u of urls) {
          window.open(u, "_blank", "noopener,noreferrer");
        }
        setOpenedNotice("已在新标签页批量打开各平台搜索");
      }
    } finally {
      setOpening(null);
      setTimeout(() => setOpenedNotice(null), 5000);
    }
  };

  const displayRegion = region?.name || regionText.trim() || "全国/当前地区";
  const displayKeyword = keyword.trim() || "全部岗位";
  const hasBroaderMatches = Boolean(broaderMatches && (broaderMatches.domesticCount > 0 || broaderMatches.globalCount > 0));

  return (
    <div className="atlas-live-quick-search" role="region" aria-label="全网平台实时聚合搜索">
      <div className="atlas-live-quick-search-header">
        <AtlasIllustration kind="search" />
        <h3 className="atlas-live-title">这个范围内，暂未找到匹配岗位</h3>
        <p className="atlas-live-desc">
          已收录数据中没有 <strong>{displayRegion} · {displayKeyword}</strong> 的匹配项。
          可以放宽条件，或继续读取招聘来源。未读取的来源不代表没有岗位。
        </p>
      </div>
      <div className="atlas-live-empty-actions">
        <button type="button" onClick={onResetFilters}>清除当前筛选</button>
        {onLiveCaptureNow && <button type="button" disabled={liveCapturing || opening !== null} onClick={onLiveCaptureNow}>
          <ShieldCheck size={14} />{liveCapturing ? "正在读取来源…" : "继续从来源获取"}
        </button>}
      </div>
      {hasBroaderMatches && broaderMatches && (
        <div className="atlas-live-broader-box" role="region" aria-label="跨区域索引匹配提示">
          <div className="atlas-live-broader-head">
            <strong>已收录「{displayKeyword}」岗位，当前「{displayRegion}」范围内为 0 岗</strong>
            <span>放宽地区范围即可直接查看已入库岗位：</span>
          </div>
          <div className="atlas-live-broader-actions">
            {broaderMatches.domesticCount > 0 && (
              <button
                type="button"
                className="atlas-live-broader-btn primary"
                onClick={broaderMatches.onExpandDomestic}
              >
                <MapPin size={13} /> 查看全国「{displayKeyword}」岗位（{broaderMatches.domesticCount} 岗）
              </button>
            )}
            {broaderMatches.globalCount > 0 && (
              <button
                type="button"
                className="atlas-live-broader-btn"
                onClick={broaderMatches.onExpandGlobal}
              >
                <Globe2 size={13} /> 查看全球「{displayKeyword}」岗位（{broaderMatches.globalCount} 岗）
              </button>
            )}
          </div>
        </div>
      )}

      {openedNotice && (
        <div className="atlas-live-notice" role="status">
          <Check size={14} /> {openedNotice}
        </div>
      )}

      <details className="atlas-live-platform-disclosure">
        <summary>选择招聘平台与采集方式</summary>
        <p>可在独立 Chrome 中打开来源，或从采集面板读取。平台可能要求登录、验证码，或限制可读取的页数。</p>
      <div className="atlas-live-batch-bar">
        <button
          type="button"
          className={onLiveCaptureNow ? "atlas-live-btn-batch-secondary" : "atlas-live-btn-batch-primary"}
          disabled={opening !== null}
          onClick={handleBatchOpenRealChrome}
        >
          <ShieldCheck size={14} /> 在 Chrome 中打开多个平台搜索
        </button>
        <button
          type="button"
          className="atlas-live-btn-batch-secondary"
          onClick={onOpenAggregator}
        >
          <Layers size={13} /> 打开采集面板，按平台读取
        </button>
      </div>

      <div className="atlas-live-tiles">
        {searches.slice(0, 4).map(({ provider, request, badge }) => (
          <div key={provider.id} className="atlas-live-tile">
            <div className="atlas-live-tile-head">
              <strong>{provider.name}</strong>
              <span className="atlas-live-tile-badge">{badge}</span>
            </div>
            <div className="atlas-live-tile-query">
              <span>{displayRegion}</span> · <span>{displayKeyword}</span>
            </div>
            {request ? (
              <div className="atlas-live-tile-actions">
                <button
                  type="button"
                  className="atlas-live-btn-chrome"
                  disabled={opening !== null}
                  onClick={() => handleOpenRealChrome(request, provider.name)}
                  title="在独立 Chrome 中打开原站；平台可能仍要求登录或验证"
                >
                  <ShieldCheck size={12} /> Chrome 检索
                </button>
                <a
                  href={request.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="atlas-live-btn-direct"
                  title="在普通浏览器新标签页打开原站"
                >
                  直达 <ArrowUpRight size={12} />
                </a>
              </div>
            ) : (
              <div className="atlas-live-tile-unavailable">地区暂无直接映射</div>
            )}
          </div>
        ))}
      </div>
      </details>

      <div className="atlas-live-footer-actions">
        {resumePrefill?.hasResumeData && (
          <button
            type="button"
            className="atlas-live-btn-link"
            onClick={resumePrefill.apply}
          >
            <Sparkles size={13} /> 参考当前简历自动填入（{resumePrefill.summaryLabel}）
          </button>
        )}
      </div>
    </div>
  );
}
