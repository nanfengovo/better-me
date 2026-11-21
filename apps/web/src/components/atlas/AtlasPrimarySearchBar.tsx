import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import { AlertTriangle, KeyRound, Loader2, MapPin, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import type { AtlasDataset } from "@better-me/opportunities";
import type { BaselineProgress } from "../../../../job-service/src/dataset-baseline-contract";
import { AtlasBaselineStatus } from "./AtlasBaselineStatus";
import { AtlasSettingsDialog } from "./AtlasSettingsDialog";
import { AtlasToolbarMenu } from "./AtlasToolbarMenu";
import { HarvestVisualConsent } from "./HarvestVisualConsent";
import { countryName } from "./atlas-filter-presets";
import { getChinaProvinces, type ChinaRegionFilter, type ChinaRegionSelection } from "./china-regions";
import type { AtlasDataMode } from "./connection-session";

type RegionOption = { code: string; label: string };
type SourceOption = {
  sourceId: string;
  attribution: { label: string };
  remoteFilters: ReadonlyArray<string>;
};

type AtlasPrimarySearchBarProps = {
  active: boolean;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  mode: "global" | "domestic";
  chinaFilter: ChinaRegionFilter;
  chinaSelection: ChinaRegionSelection;
  setChinaSelection: Dispatch<SetStateAction<ChinaRegionSelection>>;
  chinaCities: ReadonlyArray<RegionOption>;
  chinaDistricts: ReadonlyArray<RegionOption>;
  country: string;
  setCountry: Dispatch<SetStateAction<string>>;
  countryOptions: ReactNode;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  regionText: string;
  setRegionText: Dispatch<SetStateAction<string>>;
  sourceSearching: boolean;
  connecting: boolean;
  filtersOpen: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  commandOpen: boolean;
  setCommandOpen: Dispatch<SetStateAction<boolean>>;
  searchFilterCount: number;
  searchableSources: ReadonlyArray<SourceOption>;
  searchSourceId: string;
  setSearchSourceId: Dispatch<SetStateAction<string>>;
  searchAbort: MutableRefObject<AbortController | null>;
  searchDepth: "quick" | "standard" | "deep";
  setSearchDepth: Dispatch<SetStateAction<"quick" | "standard" | "deep">>;
  searchConcurrency: number;
  setSearchConcurrency: Dispatch<SetStateAction<number>>;
  platformSearchOpen: boolean;
  setPlatformSearchOpen: Dispatch<SetStateAction<boolean>>;
  collectionOpen: boolean;
  setCollectionOpen: Dispatch<SetStateAction<boolean>>;
  allowVisualFallback: boolean;
  setAllowVisualFallback: Dispatch<SetStateAction<boolean>>;
  resumeTargetRole: string;
  onDiscoverOfficialJobs?: () => void;
  onOpenAuthHub: () => void;
  onSearchSourceJobs: () => Promise<void>;
  connectionError: string;
  dataMode: AtlasDataMode;
  liveData: AtlasDataset | null;
  onRetryConnection: () => void;
  onOpenConnectionSettings: () => void;
  preview: { dataset: AtlasDataset; progress: BaselineProgress; endpoint: string; token: string } | undefined;
  endpoint: string;
  token: string;
  onConnect: (credentials: { endpoint: string; token: string }, manual: boolean) => Promise<void>;
  connectionNotice: string;
  sourceSearchError: string;
  indexError: string;
  t: (zh: string, en: string) => string;
};

export function AtlasPrimarySearchBar({
  active,
  text,
  setText,
  mode,
  chinaFilter,
  chinaSelection,
  setChinaSelection,
  chinaCities,
  chinaDistricts,
  country,
  setCountry,
  countryOptions,
  region,
  setRegion,
  regionText,
  setRegionText,
  sourceSearching,
  connecting,
  filtersOpen,
  setFiltersOpen,
  commandOpen,
  setCommandOpen,
  searchFilterCount,
  searchableSources,
  searchSourceId,
  setSearchSourceId,
  searchAbort,
  searchDepth,
  setSearchDepth,
  searchConcurrency,
  setSearchConcurrency,
  platformSearchOpen,
  setPlatformSearchOpen,
  collectionOpen,
  setCollectionOpen,
  allowVisualFallback,
  setAllowVisualFallback,
  resumeTargetRole,
  onDiscoverOfficialJobs,
  onOpenAuthHub,
  onSearchSourceJobs,
  connectionError,
  dataMode,
  liveData,
  onRetryConnection,
  onOpenConnectionSettings,
  preview,
  endpoint,
  token,
  onConnect,
  connectionNotice,
  sourceSearchError,
  indexError,
  t,
}: AtlasPrimarySearchBarProps) {
  return (
    <>
      <div className="atlas-primary-search">
        <form className="atlas-searchbar" aria-label="筛选已收录岗位" onSubmit={(e) => { e.preventDefault(); }}>
          <div className="atlas-search-fields">
            <label className="atlas-search">
              <Search size={18} />
              <input
                aria-label="搜索地图岗位"
                aria-describedby="atlas-search-help"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("关键词、技能或公司", "Role, skill, or company")}
              />
              {text && (
                <button type="button" className="atlas-search-clear" aria-label="清除岗位关键词" onClick={() => setText("")}>
                  <X size={14} />
                </button>
              )}
            </label>
            {mode === "domestic" ? (
              <AtlasToolbarMenu
                className="atlas-region-menu"
                label={<><MapPin size={14} />{chinaFilter.selectedCity?.name || chinaFilter.selectedProvince?.name || "全国"}</>}
              >
                <div className="atlas-domestic-region" role="group" aria-label="国内省市区筛选">
                  <span>中国</span>
                  <select aria-label="工作省份" value={chinaSelection.provinceCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: e.target.value || undefined })}>
                    <option value="">全部省份</option>
                    {getChinaProvinces().map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
                  </select>
                  <select aria-label="工作城市" disabled={!chinaCities.length} value={chinaSelection.cityCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: chinaSelection.provinceCode, cityCode: e.target.value || undefined })}>
                    <option value="">全部城市</option>
                    {chinaCities.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
                  </select>
                  <select aria-label="工作区县" disabled={!chinaDistricts.length} value={chinaSelection.districtCode ?? ""} onChange={(e) => setChinaSelection({ ...chinaSelection, districtCode: e.target.value || undefined })}>
                    <option value="">全部区 / 县</option>
                    {chinaDistricts.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
                  </select>
                </div>
              </AtlasToolbarMenu>
            ) : (
              <>
                <select aria-label="工作国家或地区" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(""); setRegionText(""); }}>
                  <option value="">{t("所有国家 / 地区", "All countries / regions")}</option>
                  {countryOptions}
                </select>
                <label className="atlas-region-search">
                  <MapPin size={15} />
                  <input aria-label="工作城市或地区关键词" value={regionText} onChange={(e) => { setRegionText(e.target.value); setRegion(""); }} placeholder="城市 / 地区，如北京、Berlin" maxLength={300} />
                </label>
              </>
            )}
            <button className="atlas-source-search" aria-busy={sourceSearching} type="button" onClick={() => setCollectionOpen(true)} disabled={sourceSearching || connecting}>
              {sourceSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              采集新岗位
            </button>
          </div>
          <div className="atlas-search-utilities">
            <span id="atlas-search-help" className="atlas-search-hint">仅筛选已收录岗位 · Enter 不启动采集</span>
            <div className="atlas-search-tools">
              {onDiscoverOfficialJobs && <button type="button" className="atlas-official-discovery" aria-haspopup="dialog" onClick={onDiscoverOfficialJobs}>
                <Search size={15} />{t("按简历发现官网岗位", "Discover employer jobs")}
              </button>}
              <button type="button" onClick={() => { setFiltersOpen(!filtersOpen); setCommandOpen(true); }} aria-controls="atlas-search-filters" aria-expanded={filtersOpen} aria-haspopup="dialog">
                <SlidersHorizontal size={15} />
                筛选与设置
                {searchFilterCount > 0 && <span className="atlas-filter-count">{searchFilterCount}</span>}
              </button>
              <AtlasToolbarMenu className="atlas-operations-menu" label="采集工具">
                <AtlasToolbarMenu className="atlas-fetch-options" label="获取方式">
                  {searchableSources.length > 0 && (
                    <select aria-label="搜索原始来源" value={searchSourceId} onChange={(e) => { searchAbort.current?.abort(); setSearchSourceId(e.target.value); }}>
                      <option value="">已配置岗位来源（{searchableSources.length}）</option>
                      {searchableSources.map((entry) => (
                        <option key={entry.sourceId} value={entry.sourceId}>
                          {entry.attribution.label}{entry.remoteFilters.includes("roles") ? " · 实时关键词" : " · 来源岗位"}
                        </option>
                      ))}
                    </select>
                  )}
                  <select aria-label="来源读取范围" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value as "quick" | "standard" | "deep")}>
                    <option value="deep">深度采集 · 最多 50 页 / 每平台 3000 岗</option>
                    <option value="standard">标准模式 · 最多 20 页 / 每平台 1500 岗</option>
                    <option value="quick">快速模式 · 最多 5 页 / 每平台 500 岗</option>
                  </select>
                  <small>预算、登录验证、无新增等情况会提前停止；上限不代表网站总量。</small>
                  <select
                    aria-label="并发同步数量"
                    value={searchConcurrency}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setSearchConcurrency(val);
                      try { localStorage.setItem("better-me:atlas-concurrency", String(val)); } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
                    }}
                  >
                    <option value={16}>全源同时并发（极速）</option>
                    <option value={6}>6 源并发</option>
                    <option value={4}>4 源并发</option>
                    <option value={2}>2 源并发（排队）</option>
                  </select>
                </AtlasToolbarMenu>
                <button type="button" className="atlas-auth-hub-trigger" title="全网平台统一登录与会话接管中心（BOSS直聘 · 猎聘 · 51JOB · 领英）" onClick={onOpenAuthHub}>
                  <KeyRound size={15} />平台登录态
                </button>
                <button type="button" aria-expanded={platformSearchOpen} className="atlas-platform-trigger" title="BOSS · 猎聘 · 51 · 领英 · Seek · Indeed · GradConnection · 官网" onClick={() => { setCommandOpen(true); setPlatformSearchOpen(!platformSearchOpen); }}>
                  全网平台
                </button>
              </AtlasToolbarMenu>
            </div>
          </div>
        </form>
      </div>
      {collectionOpen && active && (
        <AtlasSettingsDialog title="采集新岗位" onClose={() => { setAllowVisualFallback(false); setCollectionOpen(false); }} closeLabel="取消岗位采集">
          <HarvestVisualConsent checked={allowVisualFallback} onChange={setAllowVisualFallback} />
          <p>这会访问招聘来源，并把返回的岗位收录到当前索引。仅浏览或筛选已有岗位不需要采集。</p>
          <dl className="atlas-collection-scope">
            <div><dt>关键词</dt><dd>{text.trim() || (!searchSourceId && import.meta.env?.DEV ? resumeTargetRole || "软件工程师（实时平台默认词）" : "未指定（来源默认范围）")}</dd></div>
            <div><dt>地区</dt><dd>{mode === "domestic" ? ["中国", chinaFilter.selectedProvince?.name, chinaFilter.selectedCity?.name].filter(Boolean).join(" / ") : [country ? countryName(country) : "所有国家 / 地区", regionText || region].filter(Boolean).join(" / ")}</dd></div>
            <div><dt>来源</dt><dd>{searchableSources.find((entry) => entry.sourceId === searchSourceId)?.attribution.label ?? (searchableSources.length ? "已配置来源（" + searchableSources.length + "）" + (!searchSourceId && import.meta.env?.DEV ? " + 实时平台（BOSS / 猎聘 / 51Job / 领英）" : "") : "连接后读取已配置来源")}</dd></div>
            <div><dt>预算上限</dt><dd>{searchDepth === "deep" ? "每平台 50 页 / 3000 岗" : searchDepth === "standard" ? "每平台 20 页 / 1500 岗" : "每平台 5 页 / 500 岗"} · {searchConcurrency} 源并发</dd></div>
          </dl>
          <p className="atlas-small">上限不是预期新增量；登录、来源限制或无新增会提前结束。可取消并保留已收到的结果。</p>
          <div className="atlas-collection-actions">
            <button type="button" onClick={() => { setAllowVisualFallback(false); setCollectionOpen(false); setCommandOpen(true); }}>调整范围</button>
            <button type="button" onClick={() => { setAllowVisualFallback(false); setCollectionOpen(false); }}>暂不采集</button>
            <button type="button" onClick={() => { setCollectionOpen(false); void onSearchSourceJobs(); }}>确认开始采集</button>
          </div>
        </AtlasSettingsDialog>
      )}
      {connectionError && dataMode === "live" && (
        <div className="atlas-connection-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div className="atlas-connection-alert-copy">
            <strong>本机索引连接未恢复</strong>
            <span>{liveData ? "保留上次已读岗位" : "连接后显示已采集岗位"}</span>
          </div>
          <div className="atlas-connection-alert-actions">
            <button type="button" disabled={connecting} onClick={onRetryConnection}><RefreshCw size={14} />重试连接</button>
            <button type="button" onClick={onOpenConnectionSettings}>连接详情</button>
          </div>
        </div>
      )}
      {dataMode === "live" && preview && !preview.progress.complete && <AtlasBaselineStatus progress={preview.progress} loading={connecting} onRetry={() => void onConnect({ endpoint, token }, true)} />}
      {connectionNotice && <p role="status" className="atlas-small">{connectionNotice}</p>}
      {!commandOpen && (sourceSearchError || (indexError && !connectionError)) && <p className="atlas-error" role="alert">{sourceSearchError || indexError}</p>}
    </>
  );
}
