/** @jsxRuntime automatic */
import { useState } from "react";
import { ShieldCheck, Sparkles, Layers, ArrowUpRight, Compass, Check, Globe2, MapPin } from "lucide-react";
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
    let badge = "商业大厂";
    if (provider.id === "boss") badge = "极速直聘 · 强风控";
    else if (provider.id === "liepin") badge = "猎头中高端 · 支持卡片解析";
    else if (provider.id === "51job") badge = "综合龙头 · 编码直搜";
    else if (provider.id === "linkedin") badge = "外企/跨国机会";

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
        setOpenedNotice(`已在真实 Chrome 中开启 ${name} 搜索窗口，享有独立硬件指纹！`);
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
      {hasBroaderMatches && broaderMatches && (
        <div className="atlas-live-broader-box" role="region" aria-label="跨区域索引匹配提示">
          <div className="atlas-live-broader-head">
            <strong>💡 本地索引已有「{displayKeyword}」岗位，仅当前「{displayRegion}」筛选下为 0 岗</strong>
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

      <div className="atlas-live-quick-search-header">
        <div className="atlas-live-badge-row">
          <span className="atlas-live-tag">
            <Compass size={12} /> 全网商业平台实时机会
          </span>
          <span className="atlas-live-tag-alt">
            <ShieldCheck size={12} /> 真实 Chrome 免滑块风控
          </span>
        </div>
        <h3 className="atlas-live-title">
          本地离线底池暂无【{displayRegion} · {displayKeyword}】
        </h3>
        <p className="atlas-live-desc">
          当前本地已收录岗位主要来自腾讯（深圳为主）及海外企业官网。查询 <strong>{displayRegion}</strong> 的 <strong>{displayKeyword}</strong> 职位，可通过下方商业平台实时检索并采集入库：
        </p>
      </div>

      {openedNotice && (
        <div className="atlas-live-notice" role="status">
          <Check size={14} /> {openedNotice}
        </div>
      )}

      <div className="atlas-live-batch-bar">
        {onLiveCaptureNow && (
          <button
            type="button"
            className="atlas-live-btn-batch-primary"
            disabled={liveCapturing || opening !== null}
            onClick={onLiveCaptureNow}
          >
            <ShieldCheck size={14} />{" "}
            {liveCapturing
              ? "正在从 BOSS、51JOB、猎聘、领英 实时采集最新岗位入库…"
              : "⚡ 立即实时抓取全网平台最新岗位入库（BOSS · 51 · 猎聘 · 领英）"}
          </button>
        )}
        <button
          type="button"
          className={onLiveCaptureNow ? "atlas-live-btn-batch-secondary" : "atlas-live-btn-batch-primary"}
          disabled={opening !== null}
          onClick={handleBatchOpenRealChrome}
        >
          <ShieldCheck size={14} /> 一键在真实 Chrome 中打开全部平台搜索窗口（免滑块验证）
        </button>
        <button
          type="button"
          className="atlas-live-btn-batch-secondary"
          onClick={onOpenAggregator}
        >
          <Layers size={13} /> 展开顶部「全网采集读取器」，单平台精细读取入库 ↗
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
                  title="在独立真实 Chrome 中打开，享有真实 TLS、Canvas 指纹和保存的登录态，避免滑块验证码拦截"
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
        <button
          type="button"
          className="atlas-live-btn-link"
          onClick={onResetFilters}
        >
          清除当前筛选
        </button>
      </div>
    </div>
  );
}
