import { Building2, ChevronDown, ChevronUp, Compass, Loader2, LocateFixed, MapPin, Navigation, RefreshCw, Search } from "lucide-react";
import type { NearbyIndexedBucket } from "./nearby-company-radar";
import { formatDistanceLabel, type NearbyCompanyHit, type UserGeolocationFix } from "./prototypes/user-location";

export type NearbyRadarCenterView = {
  longitude: number;
  latitude: number;
  label: string;
  origin: "user-location" | "map-viewport";
  source: UserGeolocationFix["source"] | "viewport";
};

type AtlasNearbyRadarProps = {
  radarCenter: NearbyRadarCenterView;
  hasUserFix: boolean;
  companies: readonly NearbyCompanyHit[];
  nearbyBuckets: readonly NearbyIndexedBucket[];
  loading: boolean;
  error: string;
  radiusMeters: number;
  collapsed: boolean;
  selectedCompanyId?: string;
  anchorSyncedToFix: boolean;
  sortByDistanceActive: boolean;
  connected: boolean;
  busyHarvesting: boolean;
  onToggleCollapsed: () => void;
  onChangeRadius: (radiusMeters: number) => void;
  onRefresh: () => void;
  onReturnToMyLocation?: () => void;
  onUseFixAsJobAnchor: () => void;
  onSelectCompany: (company: NearbyCompanyHit) => void;
  onFilterCompanyJobs: (company: NearbyCompanyHit) => void;
  onHarvestCompanyJobs: (company: NearbyCompanyHit) => void;
  onSelectIndexedBucket: (entry: NearbyIndexedBucket) => void;
};

const RADIUS_OPTIONS = [
  { meters: 1_500, label: "1.5km" },
  { meters: 2_500, label: "2.5km" },
  { meters: 5_000, label: "5km" },
] as const;

export function AtlasNearbyRadar({
  radarCenter,
  hasUserFix,
  companies,
  nearbyBuckets,
  loading,
  error,
  radiusMeters,
  collapsed,
  selectedCompanyId,
  anchorSyncedToFix,
  sortByDistanceActive,
  connected,
  busyHarvesting,
  onToggleCollapsed,
  onChangeRadius,
  onRefresh,
  onReturnToMyLocation,
  onUseFixAsJobAnchor,
  onSelectCompany,
  onFilterCompanyJobs,
  onHarvestCompanyJobs,
  onSelectIndexedBucket,
}: AtlasNearbyRadarProps) {
  const isCityOnly = radarCenter.source === "ip";
  const isViewportScan = radarCenter.origin === "map-viewport";
  const placeName = radarCenter.label;
  const indexedMatchesCount = companies.filter((entry) => (entry.indexedJobCount ?? 0) > 0).length;

  return (
    <section className="atlas-nearby-radar" aria-label="周边求职公司雷达">
      <div className="atlas-nearby-radar-head">
        <div className="atlas-nearby-radar-title">
          <span className="atlas-nearby-badge">
            <Compass size={12} aria-hidden="true" />
            {isViewportScan ? "视野区域企业" : "周边求职雷达"}
          </span>
          <strong title={placeName}>{placeName}</strong>
          {!isCityOnly && (
            <span className="atlas-nearby-summary">
              {loading
                ? "正在探测周边全行业企业与园区…"
                : `周边 ${companies.length} 家企业（全工种可查${indexedMatchesCount > 0 ? ` · 库内 ${indexedMatchesCount} 家在招` : ""}${nearbyBuckets.length > 0 ? ` · 附近 ${nearbyBuckets.length} 处公点` : ""}）`}
            </span>
          )}
        </div>
        <div className="atlas-nearby-radar-actions">
          {!isCityOnly && (
            <>
              {isViewportScan && hasUserFix && onReturnToMyLocation && (
                <button
                  type="button"
                  className="atlas-nearby-anchor-btn"
                  onClick={onReturnToMyLocation}
                  title="切回我的当前定位周边企业"
                >
                  <LocateFixed size={11} aria-hidden="true" />
                  回我位置
                </button>
              )}
              <button
                type="button"
                className={`atlas-nearby-anchor-btn${anchorSyncedToFix && sortByDistanceActive ? " is-active" : ""}`}
                onClick={onUseFixAsJobAnchor}
                title="以此探测点为参照，将岗位列表按直线距离从近到远排序"
              >
                <Navigation size={11} aria-hidden="true" />
                {anchorSyncedToFix && sortByDistanceActive ? "已按距此排序" : "按距此排序岗位"}
              </button>
              <button
                type="button"
                className="atlas-nearby-icon-btn"
                onClick={onRefresh}
                disabled={loading}
                aria-label="重新探测周边企业"
                title="重新探测周边企业"
              >
                {loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
              </button>
            </>
          )}
          <button
            type="button"
            className="atlas-nearby-icon-btn"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开周边企业列表" : "收起周边企业列表"}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {!collapsed && isCityOnly && (
        <p className="atlas-nearby-city-hint">
          当前仅获取到城市级网络定位（{placeName}），暂无精确街道坐标。请在地图右下角搜索街道、「地图点选」，或在任意区域放大后点击「扫此区域企业」探索周边在招单位。
        </p>
      )}

      {!collapsed && !isCityOnly && (
        <div className="atlas-nearby-radar-body">
          <div className="atlas-nearby-toolbar">
            <span className="atlas-nearby-toolbar-label">探测半径</span>
            <div className="atlas-nearby-radius-group" role="group" aria-label="周边企业探测半径">
              {RADIUS_OPTIONS.map((opt) => (
                <button
                  key={opt.meters}
                  type="button"
                  aria-pressed={radiusMeters === opt.meters}
                  className={radiusMeters === opt.meters ? "is-active" : ""}
                  onClick={() => onChangeRadius(opt.meters)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {nearbyBuckets.length > 0 && (
              <div className="atlas-nearby-bucket-pills" aria-label="附近已采集办公点">
                {nearbyBuckets.slice(0, 4).map((entry) => (
                  <button
                    key={entry.bucket.id}
                    type="button"
                    className="atlas-nearby-bucket-pill"
                    onClick={() => onSelectIndexedBucket(entry)}
                    title={`${entry.bucket.label} · ${entry.bucket.jobCount} 岗${entry.outsideCurrentFilter ? "（点选自动放开当前筛选）" : ""}`}
                  >
                    <MapPin size={10} aria-hidden="true" />
                    <span>{entry.bucket.label}</span>
                    <strong>{entry.bucket.jobCount}岗 · {formatDistanceLabel(entry.distanceMeters)}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && <p className="atlas-nearby-error" role="status">{error}</p>}

          {!loading && !error && companies.length === 0 && (
            <p className="atlas-nearby-empty">
              附近 {formatDistanceLabel(radiusMeters)} 内暂未检索到公开登记的企业或园区，可切换 5km 半径或平移至周边街道点击「扫此区域企业」。
            </p>
          )}

          {companies.length > 0 && (
            <div className="atlas-nearby-strip" role="list" aria-label="周边企业列表">
              {companies.map((company) => {
                const isSelected = selectedCompanyId === company.id;
                const hasIndexed = (company.indexedJobCount ?? 0) > 0;
                return (
                  <article
                    key={company.id}
                    role="listitem"
                    className={`atlas-nearby-card${isSelected ? " is-selected" : ""}${hasIndexed ? " has-indexed-jobs" : ""}`}
                  >
                    <button
                      type="button"
                      className="atlas-nearby-card-select"
                      onClick={() => onSelectCompany(company)}
                      title={`${company.name}${company.streetAddress ? ` · ${company.streetAddress}` : ""}${company.ownershipReason ? `\n${company.ownershipReason}` : ""}`}
                    >
                      <div className="atlas-nearby-card-top">
                        <span className="atlas-nearby-card-name">
                          <i className="atlas-nearby-dot" style={{ background: company.ownershipColor }} aria-hidden="true" />
                          <strong>{company.name}</strong>
                        </span>
                        <span className="atlas-nearby-card-dist">{formatDistanceLabel(company.distanceMeters)}</span>
                      </div>
                      <div className="atlas-nearby-card-meta">
                        <span className="atlas-nearby-ownership">{company.ownershipLabel}</span>
                        {company.streetAddress && <span className="atlas-nearby-street">{company.streetAddress}</span>}
                      </div>
                    </button>
                    <div className="atlas-nearby-card-actions">
                      <button
                        type="button"
                        className="atlas-nearby-job-btn"
                        onClick={() => onFilterCompanyJobs(company)}
                        title={`清空岗位工种/条件限制，只按「${company.searchKeyword}」筛本地全部岗位`}
                      >
                        <Search size={10} aria-hidden="true" />
                        {hasIndexed ? `看库内 ${company.indexedJobCount} 岗` : `筛「${company.searchKeyword}」`}
                      </button>
                      <button
                        type="button"
                        className="atlas-nearby-harvest-btn"
                        disabled={busyHarvesting}
                        onClick={() => onHarvestCompanyJobs(company)}
                        title={connected ? `跨平台实时检索「${company.searchKeyword}」全部在招岗位（不限软件工程）` : "连接本机服务或通过全网平台检索"}
                      >
                        <Building2 size={10} aria-hidden="true" />
                        {connected ? "全网搜全职" : "搜全网岗位"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
