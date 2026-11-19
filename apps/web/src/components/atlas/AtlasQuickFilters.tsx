import type { Dispatch, SetStateAction } from "react";
import { Filter, Home, RotateCcw, Sparkles, X } from "lucide-react";
import type { CompanyColorConfig, JobQueryResult, JobSearchItem } from "@better-me/opportunities";
import {
  colorForCountryCode,
  countryName,
  DISTANCE_FILTER_OPTIONS,
  PLATFORM_FILTER_OPTIONS,
  PUBLICATION_FILTER_OPTIONS,
  SALARY_FILTER_OPTIONS,
} from "./atlas-filter-presets";

export type AtlasFilterPill = {
  key: string;
  label: string;
  onClear: () => void;
};

type AtlasQuickFiltersProps = {
  activeFilterCount: number;
  activeFilterPills: AtlasFilterPill[];
  filtersCollapsed: boolean;
  hasLiveHarvest: boolean;
  coverage: {
    ownership: { supported: boolean };
  };
  ownership: string;
  origin: string;
  foreignOrigins: string[];
  colors: CompanyColorConfig;
  platformFilter: string;
  salaryFilter: string;
  distanceFilter: string;
  pubFilter: string;
  anchor: { ref: string } | undefined;
  latitude: string;
  longitude: string;
  maxKm: string;
  text: string;
  penetratedCount: number;
  aiPenetratedOnly: boolean;
  result: JobQueryResult | null;
  setOwnership: Dispatch<SetStateAction<string>>;
  setOrigin: Dispatch<SetStateAction<string>>;
  setPlatformFilter: Dispatch<SetStateAction<string>>;
  setSalaryFilter: Dispatch<SetStateAction<string>>;
  setDistanceFilter: Dispatch<SetStateAction<string>>;
  setPubFilter: Dispatch<SetStateAction<string>>;
  setMaxKm: Dispatch<SetStateAction<string>>;
  setAiPenetratedOnly: Dispatch<SetStateAction<boolean>>;
  onOpenHomeSettings: () => void;
  onResetFilters: () => void;
  t: (zh: string, en: string) => string;
};

export function AtlasQuickFilters({
  activeFilterCount,
  activeFilterPills,
  filtersCollapsed,
  hasLiveHarvest,
  coverage,
  ownership,
  origin,
  foreignOrigins,
  colors,
  platformFilter,
  salaryFilter,
  distanceFilter,
  pubFilter,
  anchor,
  latitude,
  longitude,
  maxKm,
  text,
  penetratedCount,
  aiPenetratedOnly,
  result,
  setOwnership,
  setOrigin,
  setPlatformFilter,
  setSalaryFilter,
  setDistanceFilter,
  setPubFilter,
  setMaxKm,
  setAiPenetratedOnly,
  onOpenHomeSettings,
  onResetFilters,
  t,
}: AtlasQuickFiltersProps) {
  return (
    <>
      {filtersCollapsed && activeFilterCount > 0 && (
        <div className="atlas-collapsed-filter-summary">
          <span className="summary-label">
            <Filter size={12} />
            已生效筛选:
          </span>
          <div className="summary-tags">
            {activeFilterPills.map((pill) => (
              <span key={pill.key} className="summary-tag">
                <span>{pill.label}</span>
                <button
                  type="button"
                  onClick={pill.onClear}
                  aria-label={`清除${pill.label}`}
                  title="移除该条件"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="summary-reset-btn"
            onClick={onResetFilters}
            title="重置所有筛选"
          >
            <RotateCcw size={11} />
            重置
          </button>
        </div>
      )}

      <div
        id="atlas-quick-filters"
        className={`atlas-quick-filters ${filtersCollapsed ? "is-collapsed" : ""}`}
        hidden={filtersCollapsed || hasLiveHarvest}
        role="group"
        aria-label="岗位多维快捷筛选"
      >
        {coverage.ownership.supported && (
          <div className="atlas-filter-row">
            <span className="atlas-filter-label is-ownership"><i />性质</span>
            <div className="atlas-filter-pills">
              <button type="button" className={!ownership && !origin ? "active" : ""} onClick={() => { setOwnership(""); setOrigin(""); }}>全部</button>
              <button type="button" className={origin === "FOREIGN_ALL" ? "active" : ""} onClick={() => { if (origin === "FOREIGN_ALL") { setOrigin(""); setOwnership(""); } else { setOrigin("FOREIGN_ALL"); setOwnership(""); } }}><i style={{ background: "#76BD8A" }} />外企</button>
              <button type="button" className={ownership === "state" ? "active" : ""} onClick={() => { if (ownership === "state") { setOwnership(""); setOrigin(""); } else { setOwnership("state"); setOrigin(""); } }}><i style={{ background: colors.rules.find((r) => r.id === "domestic-state")?.color ?? "#D6A627" }} />央企 / 国企</button>
              <button type="button" className={ownership === "joint" ? "active" : ""} onClick={() => { if (ownership === "joint") { setOwnership(""); setOrigin(""); } else { setOwnership("joint"); setOrigin(""); } }}><i style={{ background: colors.rules.find((r) => r.id === "joint")?.color ?? "#81739D" }} />合资</button>
              <button type="button" className={ownership === "private" && origin === "CN" ? "active" : ""} onClick={() => { if (ownership === "private" && origin === "CN") { setOwnership(""); setOrigin(""); } else { setOwnership("private"); setOrigin("CN"); } }}><i style={{ background: colors.rules.find((r) => r.id === "domestic-private")?.color ?? "#D75E61" }} />民营 / 私企</button>
              {foreignOrigins.length > 0 && origin === "FOREIGN_ALL" && foreignOrigins.map((code) => (
                <button key={code} type="button" className={origin === code ? "active" : ""} onClick={() => setOrigin(code)}>
                  <i style={{ background: colorForCountryCode(code, colors) }} />{countryName(code)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="atlas-filter-row">
          <span className="atlas-filter-label is-platform"><i />平台</span>
          <div className="atlas-filter-pills">
            {PLATFORM_FILTER_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={platformFilter === key ? "active" : ""}
                onClick={() => setPlatformFilter(platformFilter === key ? "" : key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="atlas-filter-row">
          <span className="atlas-filter-label is-salary"><i />薪资</span>
          <div className="atlas-filter-pills">
            {SALARY_FILTER_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={salaryFilter === key ? "active" : ""}
                onClick={() => setSalaryFilter(salaryFilter === key ? "" : key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="atlas-filter-row">
          <span className="atlas-filter-label is-distance"><i />距离</span>
          <div className="atlas-filter-pills">
            {DISTANCE_FILTER_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={distanceFilter === key ? "active" : ""}
                onClick={() => {
                  if (key && key !== "exact" && !anchor) {
                    setDistanceFilter(key);
                    onOpenHomeSettings();
                    return;
                  }
                  const next = distanceFilter === key ? "" : key;
                  setDistanceFilter(next);
                  if (next === "exact" || !next) {
                    setMaxKm("");
                  } else {
                    setMaxKm(next.replace("km", ""));
                  }
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={`atlas-anchor-quick-btn ${anchor ? "has-anchor" : "need-anchor"}`}
              onClick={onOpenHomeSettings}
              title={anchor ? `当前家庭参照点 (${latitude || "已设"}, ${longitude || "已设"}) · 点击修改` : "点击设置家庭位置参照点"}
            >
              <Home size={12} />
              {anchor ? "距家基准已设" : "设置家坐标"}
            </button>
          </div>
        </div>

        <div className="atlas-filter-row">
          <span className="atlas-filter-label is-publication"><i />发布</span>
          <div className="atlas-filter-pills">
            {PUBLICATION_FILTER_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={pubFilter === key ? "active" : ""}
                onClick={() => setPubFilter(pubFilter === key ? "" : key)}
              >
                {label}
              </button>
            ))}
            {(platformFilter || salaryFilter || distanceFilter || pubFilter || ownership || origin || maxKm || aiPenetratedOnly) && (
              <button
                type="button"
                className="atlas-filter-clear-all"
                onClick={onResetFilters}
                title="清除所有快捷筛选条件"
              >
                <RotateCcw size={12} />
                重置筛选
              </button>
            )}
          </div>
        </div>
        {text.trim() && penetratedCount > 0 && (
          <div className="atlas-filter-row">
            <span className="atlas-filter-label is-ai"><Sparkles size={11} />{t("规则", "Rules")}</span>
            <div className="atlas-filter-pills">
              <button
                type="button"
                className={!aiPenetratedOnly ? "active" : ""}
                onClick={() => setAiPenetratedOnly(false)}
              >
                全部命中 ({result?.totalJobs ?? 0})
              </button>
              <button
                type="button"
                className={`atlas-ai-pill-btn ${aiPenetratedOnly ? "active" : ""}`}
                onClick={() => setAiPenetratedOnly(true)}
              >
                <Sparkles size={11} className="atlas-ai-sparkle-icon" />
                {t("仅看关键词规则命中", "Keyword rule matches only")} ({penetratedCount})
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
export type { JobSearchItem };
