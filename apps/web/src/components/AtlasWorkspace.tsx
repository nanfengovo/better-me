import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownUp, ArrowUpRight, Check, ChevronDown, ChevronUp, Compass, Database, ExternalLink, Filter, Globe2, Home, KeyRound, Loader2, LogIn, MapPin, Palette, RefreshCw, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { FactBase, ProjectedResume } from "@better-me/core";
import { extractResumePrefill } from "./atlas/resume-prefill";
import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, normalizeSearchText, DEFAULT_TECHNICAL_ALIASES, type AtlasDataset, type CompanyColorConfig, type JobLocation, type JobQueryInput, type JobQueryResult, type JobSearchItem, type MapBucket, type QueryOptions, type GeocodingResult, type GeocodingCandidate } from "@better-me/opportunities";
import type { OpportunitySeed } from "./OpportunityWorkspace";
import { createAtlasDemo } from "./atlas/demo";
import type { AtlasCamera } from "./atlas/prototypes/types";
import { ATLAS_BASEMAPS } from "./atlas/prototypes/basemaps";
import { buildAtlasJobAction, queryAtlasPage, readAtlasSnapshot, type AtlasJobAction } from "./atlas/client";
import { readOpportunityLibrary } from "../lib/opportunities";
import { projectLocalOpportunities } from "./atlas/local-opportunities";
import { createAtlasSourceClient } from "./atlas/service-client";
import { useAtlasMapReferences } from "./atlas/use-atlas-map-references";
import { clearAtlasConnectionSession, DEFAULT_ATLAS_ENDPOINT, readAtlasConnectionSession, writeAtlasConnectionSession, type AtlasConnectionIdentity, type AtlasDataMode } from "./atlas/connection-session";
import { clearAtlasDevAutoConnectSuppressed, readAtlasDevAutoConnectSuppressed, requestDevJobIndex, writeAtlasDevAutoConnectSuppressed, type DevJobIndexBootstrap } from "./atlas/dev-index-bootstrap";
import { runAtlasSourceSearch, type AtlasAggregateProgress, type AtlasAggregateSource } from "./atlas/aggregate-search";
import { AtlasSearchProgress } from "./atlas/AtlasSearchProgress";
import { AtlasJobDetail } from "./atlas/AtlasJobDetail";
import { useAtlasPaneLayout } from "./atlas/use-atlas-pane-layout";
import { createJobMapFocus, type AtlasMapFocus } from "./atlas/map-focus";
import { frameAdminRegion, frameSearchMap } from "./atlas/map-frame";
import { buildAtlasCityCandidateQuery } from "./atlas/city-candidate-query";
import { getAtlasDataCoverage } from "./atlas/coverage";
import { createAtlasListingPresenter } from "./atlas/presentation";
import { AtlasListingBadges } from "./atlas/JobSourceBadges";
import {
  formatCardPlatform,
  formatCardPublication,
  formatCardDistance,
  formatCardSalaryRMB,
  matchCardPlatform,
  matchCardSalary,
  matchCardDistance,
  matchCardPublication,
} from "./atlas/card-badges";
import { analyzeAiJobRelevance } from "./atlas/ai-job-relevance";
import { PlatformSearchLinks } from "./atlas/PlatformSearchLinks";
import { AtlasLivePlatformQuickSearch } from "./atlas/AtlasLivePlatformQuickSearch";
import {
  enrichSnapshotCompaniesAndOffices,
  type LivePlatformImportSummary,
} from "./atlas/live-platform-auto-import";
import { executeOpportunityHarvestChainedPipeline } from "./atlas/harvest-pipeline";
import { buildChinaRegionFilter, findChinaProvinceByMapId, getChinaProvinces, getChinaCities, getChinaDistricts, type ChinaRegionSelection } from "./atlas/china-regions";
import { resolveAdminBoundaryHighlight, type AdminBoundaryHighlight } from "./atlas/admin-boundary-service";
import countryCatalog from "../../../../config/geography/countries.json";
import { useUiPreferences } from "../lib/ui-preferences";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters/browser-contracts";
import { PlatformAuthHub } from "./atlas/PlatformAuthHub";
import { focusRealChrome } from "../lib/real-chrome-client";
import "./atlas/atlas.css";

const AtlasMap = lazy(() => import("./atlas/prototypes/MapLibrePrototype"));
const AtlasSourcesPanel = lazy(() => import("./atlas/AtlasSourcesPanel").then((m) => ({ default: m.AtlasSourcesPanel })));
const AtlasSourceCandidateReview = lazy(() => import("./atlas/AtlasSourceCandidateReview").then((m) => ({ default: m.AtlasSourceCandidateReview })));
const AtlasReviewedCardImport = lazy(() => import("./atlas/AtlasReviewedCardImport").then((m) => ({ default: m.AtlasReviewedCardImport })));
const AtlasLocationConfirmation = lazy(() => import("./atlas/AtlasLocationConfirmation").then((m) => ({ default: m.AtlasLocationConfirmation })));
const AtlasOfficeAddressConfirmation = lazy(() => import("./atlas/AtlasOfficeAddressConfirmation").then((m) => ({ default: m.AtlasOfficeAddressConfirmation })));
const AtlasReconciliationPanel = lazy(() => import("./atlas/AtlasReconciliationPanel").then((m) => ({ default: m.AtlasReconciliationPanel })));
const AtlasAddressEnrichment = lazy(() => import("./atlas/AtlasAddressEnrichment").then(module => ({ default: module.AtlasAddressEnrichment })));
const AtlasDetailLocations = lazy(() => import("./atlas/AtlasDetailLocations").then(module => ({ default: module.AtlasDetailLocations })));
const COLOR_KEY = "better-me:atlas-colors:v1";
type Props = { active?: boolean; resume?: ProjectedResume | null; factBase?: FactBase | null; onSaveOpportunity: (seed: OpportunitySeed) => void; onAnalyze: (item: AtlasJobAction) => void; onOpenOpportunitySources?: () => void; devJobIndex?: (signal: AbortSignal) => Promise<DevJobIndexBootstrap | undefined> };
const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["zh"], { type: "region" }) : undefined;
const countryName = (code: string) => regionNames?.of(code) ?? code;
function initialColors(): CompanyColorConfig {
  try { const saved = localStorage.getItem(COLOR_KEY); if (saved) return CompanyColorConfigSchema.parse(JSON.parse(saved)); } catch { /* Defaults remain available when storage is blocked. */ }
  return getDefaultCompanyColorConfig();
}
function colorForCountryCode(code: string, config: CompanyColorConfig): string {
  for (const rule of config.rules) {
    if (rule.jurisdictions?.includes(code)) {
      return rule.color;
    }
    if (rule.group) {
      const group = config.groups.find((g) => g.id === rule.group);
      if (group?.jurisdictions.includes(code)) {
        return rule.color;
      }
    }
  }
  return config.rules.find((r) => r.id === "other-known")?.color ?? config.defaultColor;
}

const PLATFORM_FILTER_OPTIONS = [
  ["", "全部平台"],
  ["51job", "51Job"],
  ["boss", "BOSS直聘"],
  ["liepin", "猎聘"],
  ["linkedin", "领英"],
  ["tencent", "腾讯招聘"],
  ["official", "官网直聘"],
  ["other", "其他公开源"],
] as const;

const SALARY_FILTER_OPTIONS = [
  ["", "全部薪资"],
  ["<10k", "10k以下"],
  ["10-20k", "10-20k"],
  ["20-30k", "20-30k"],
  ["30-50k", "30-50k"],
  [">50k", "50k以上"],
  ["negotiable", "薪资面议"],
] as const;

const DISTANCE_FILTER_OPTIONS = [
  ["", "全部距离"],
  ["5km", "5km内"],
  ["10km", "10km内"],
  ["20km", "20km内"],
  ["30km", "30km内"],
  ["50km", "50km内"],
  ["exact", "精确定位"],
] as const;

const PUBLICATION_FILTER_OPTIONS = [
  ["", "全部时间"],
  ["3d", "3天内"],
  ["7d", "7天内"],
  ["30d", "30天内"],
  ["90d", "3个月内"],
  [">90d", "3个月前"],
] as const;

export default function AtlasWorkspace({ active = true, resume, factBase, onSaveOpportunity, onAnalyze, onOpenOpportunitySources, devJobIndex = import.meta.env?.DEV === true ? requestDevJobIndex : undefined }: Props) {
  const { t, theme } = useUiPreferences();
  const { workspace, layout } = useAtlasPaneLayout(active);
  const resumePrefill = useMemo(() => extractResumePrefill(resume, factBase), [resume, factBase]);
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const prefillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (prefillTimer.current) clearTimeout(prefillTimer.current);
    };
  }, []);
  const [demo] = useState(createAtlasDemo);
  const [initialConnection] = useState(readAtlasConnectionSession);
  const restoreConnection = useRef(initialConnection?.dataMode === "live");
  const [liveData, setLiveData] = useState<AtlasDataset | null>(null);
  const [dataMode, setDataMode] = useState<AtlasDataMode>(initialConnection?.dataMode ?? "local");
  const [localData, setLocalData] = useState<AtlasDataset | null>(null);
  const [localError, setLocalError] = useState("");
  const [localWarnings, setLocalWarnings] = useState(0);
  const [localLoading, setLocalLoading] = useState(false);
  const [publicationNow, setPublicationNow] = useState(() => new Date().toISOString());
  const [localReload, setLocalReload] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [searchSourceId, setSearchSourceId] = useState("");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [harvestStage, setHarvestStage] = useState<{ index: number; total: number; message: string } | null>(null);
  const [searchProgress, setSearchProgress] = useState<AtlasAggregateProgress | null>(null);
  const [sourceReview, setSourceReview] = useState<AtlasAggregateSource>();
  const [cardReview, setCardReview] = useState<ReviewedCardsCapture>();
  const [locationReview, setLocationReview] = useState<{ jobId: string; location: JobLocation }>();
  const [officeReview, setOfficeReview] = useState<{ jobId: string; location: JobLocation }>();
  const [detailReviewJobId, setDetailReviewJobId] = useState("");
  const [enrichmentScope, setEnrichmentScope] = useState<string[] | null>(null);
  const [locationChoices, setLocationChoices] = useState<string>();
  const [officeFocusRequest, setOfficeFocusRequest] = useState<{ id: string; jobId: string; locationId: string; snapshot: AtlasDataset; selectionKey: string; endpoint: string; token: string }>();
  const officeFocusAbort = useRef<AbortController | null>(null);
  const officeFocusApplied = useRef<string | undefined>(undefined);
  const recoveredOfficeSelection = useRef<{ data: AtlasDataset; selectionKey: string; jobId: string } | undefined>(undefined);
  function cancelOfficeFocus() { officeFocusAbort.current?.abort(); officeFocusAbort.current = null; setOfficeFocusRequest(undefined); recoveredOfficeSelection.current = undefined; }
  const [searchDepth, setSearchDepth] = useState<"quick" | "standard" | "deep">("standard");
  const [searchConcurrency, setSearchConcurrency] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("better-me:atlas-concurrency");
      return saved ? Number(saved) : 9;
    } catch {
      return 9;
    }
  });
  const [sourceSearchMessage, setSourceSearchMessage] = useState("");
  const [sourceSearchError, setSourceSearchError] = useState("");
  const searchAbort = useRef<AbortController | null>(null);
  const searchKeys = useRef(new Map<string, string>());
  const [mode, setMode] = useState<"global" | "domestic">("global");
  const [text, setText] = useState("");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [regionText, setRegionText] = useState("");
  const [chinaSelection, setChinaSelection] = useState<ChinaRegionSelection>({});
  const [adminBoundary, setAdminBoundary] = useState<AdminBoundaryHighlight | null>(null);
  const [origin, setOrigin] = useState("");
  const [ownership, setOwnership] = useState("");
  const [source, setSource] = useState("");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");
  const [maxKm, setMaxKm] = useState("");
  const [includeUnclassified, setIncludeUnclassified] = useState(false);
  const [sort, setSort] = useState<"relevance" | "salary" | "distance" | "updated">("relevance");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [originalCurrency, setOriginalCurrency] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [platformFilter, setPlatformFilter] = useState("");
  const [salaryFilter, setSalaryFilter] = useState("");
  const [distanceFilter, setDistanceFilter] = useState("");
  const [pubFilter, setPubFilter] = useState("");
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [aiPenetratedOnly, setAiPenetratedOnly] = useState(false);
  const [aiBannerDismissed, setAiBannerDismissed] = useState(false);

  const activeFilterPills = useMemo(() => {
    const list: Array<{ key: string; label: string; onClear: () => void }> = [];
    if (aiPenetratedOnly) {
      list.push({
        key: "aiPenetrated",
        label: "🤖 仅看 AI 穿透命中",
        onClear: () => setAiPenetratedOnly(false),
      });
    }
    if (ownership || origin) {
      let label = "性质: ";
      if (origin === "FOREIGN_ALL") label += "外企";
      else if (ownership === "state") label += "央企/国企";
      else if (ownership === "joint") label += "合资";
      else if (ownership === "private" && origin === "CN") label += "民企";
      else if (origin) label += countryName(origin);
      else label += ownership;
      list.push({
        key: "ownership",
        label,
        onClear: () => { setOwnership(""); setOrigin(""); },
      });
    }
    if (platformFilter) {
      const opt = PLATFORM_FILTER_OPTIONS.find(([k]) => k === platformFilter);
      list.push({
        key: "platform",
        label: `平台: ${opt ? opt[1] : platformFilter}`,
        onClear: () => setPlatformFilter(""),
      });
    }
    if (salaryFilter) {
      const opt = SALARY_FILTER_OPTIONS.find(([k]) => k === salaryFilter);
      list.push({
        key: "salary",
        label: `薪资: ${opt ? opt[1] : salaryFilter}`,
        onClear: () => setSalaryFilter(""),
      });
    }
    if (distanceFilter) {
      const opt = DISTANCE_FILTER_OPTIONS.find(([k]) => k === distanceFilter);
      list.push({
        key: "distance",
        label: `距离: ${opt ? opt[1] : distanceFilter}`,
        onClear: () => { setDistanceFilter(""); setMaxKm(""); },
      });
    }
    if (pubFilter) {
      const opt = PUBLICATION_FILTER_OPTIONS.find(([k]) => k === pubFilter);
      list.push({
        key: "pub",
        label: `发布: ${opt ? opt[1] : pubFilter}`,
        onClear: () => setPubFilter(""),
      });
    }
    return list;
  }, [aiPenetratedOnly, ownership, origin, platformFilter, salaryFilter, distanceFilter, pubFilter]);

  const activeFilterCount = activeFilterPills.length;

  function applyKeywordChip(keyword: string) {
    if (text.trim() === keyword.trim()) {
      setText("");
    } else {
      setText(keyword);
      void searchSourceJobs(keyword);
    }
  }
  const [settings, setSettings] = useState<"connection" | "home" | "colors" | "maps" | null>(null);
  const [endpoint, setEndpoint] = useState(initialConnection?.dataMode === "live" ? initialConnection.endpoint : DEFAULT_ATLAS_ENDPOINT);
  const [token, setToken] = useState(initialConnection?.dataMode === "live" ? initialConnection.token : "");
  useEffect(() => { setDetailReviewJobId(""); setEnrichmentScope(null); }, [endpoint, token, dataMode, active]);
  const [connecting, setConnecting] = useState(false);
  const connectionAbort = useRef<AbortController | null>(null);
  const devBootstrapAbort = useRef<AbortController | null>(null);
  const devAutoConnectSuppressed = useRef(readAtlasDevAutoConnectSuppressed());
  const connectedIdentity = useRef<{ endpoint: string; token: string } | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [latitude, setLatitude] = useState(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return String(JSON.parse(raw).latitude ?? "");
    } catch {}
    return "";
  });
  const [longitude, setLongitude] = useState(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return String(JSON.parse(raw).longitude ?? "");
    } catch {}
    return "";
  });
  const [anchor, setAnchorState] = useState<QueryOptions["anchor"]>(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return JSON.parse(raw);
    } catch {}
    return undefined;
  });
  const setAnchor = useCallback((val: QueryOptions["anchor"]) => {
    setAnchorState(val);
    try {
      if (val) localStorage.setItem("better-me:atlas-anchor:v1", JSON.stringify(val));
      else localStorage.removeItem("better-me:atlas-anchor:v1");
    } catch {}
  }, []);
  const [homeError, setHomeError] = useState("");
  const [colors, setColors] = useState(initialColors);
  const [colorsMessage, setColorsMessage] = useState("");
  const [rawResult, setResult] = useState<JobQueryResult | null>(null);
  const [resultData, setResultData] = useState<AtlasDataset | null>(null);
  const [queryError, setQueryError] = useState("");
  const [querying, setQuerying] = useState(false);
  const [platformSearchOpen, setPlatformSearchOpen] = useState(false);
  const [authHubOpen, setAuthHubOpen] = useState(false);
  const [intervenePlatforms, setIntervenePlatforms] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => { setLocationReview(undefined); }, [selectedId, endpoint, token]);
  const [bucket, setBucket] = useState<MapBucket | null>(null);
  const [mapError, setMapError] = useState("");
  const [rotating, setRotating] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [listPage, setListPage] = useState<JobQueryResult | null>(null);
  const [listItems, setListItems] = useState<JobSearchItem[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const paging = useRef({ key: "", queryId: "" });
  const [mapZoom, setMapZoom] = useState(1.5);
  const camera = useRef<AtlasCamera | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);
  const [basemapId, setBasemapId] = useState("auto");
  const [focus, setFocus] = useState<AtlasMapFocus>();
  const [locationSearch, setLocationSearch] = useState<{ jobId: string; locationId: string; result?: GeocodingResult; loading: boolean; error?: string }>();
  const locationAbort = useRef<AbortController | null>(null);
  const selectedCard = useRef<JobSearchItem | undefined>(undefined);
  const cardClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function cancelCardClick() { clearTimeout(cardClickTimer.current); cardClickTimer.current = undefined; }
  const queryAbort = useRef<AbortController | null>(null);
  const data = dataMode === "demo" ? demo : dataMode === "live" ? liveData : localData;
  const connected = Boolean(liveData && connectedIdentity.current?.endpoint === endpoint && connectedIdentity.current.token === token);
  const mapReferences = useAtlasMapReferences({ active, dataMode, connected, endpoint, token, snapshot: dataMode === "live" ? liveData : null });
  const searchableSources = (connected ? liveData?.sources : [])?.filter((entry) => entry.enabled && entry.status === "active" && entry.entityType === "job-posting" && entry.runtime.includes("local-service") && entry.capabilities.includes("list-jobs") && entry.entryUrl) ?? [];
  const selectedSearchSources = searchSourceId ? searchableSources.filter((entry) => entry.sourceId === searchSourceId) : searchableSources;
  const reviewSource = sourceReview ? liveData?.sources.find((entry) => entry.sourceId === sourceReview.sourceId) : undefined;
  useEffect(() => { setSourceReview(undefined); setCardReview(undefined); }, [endpoint, token]);
  const result = resultData === data ? rawResult : null;
  const locatedBuckets = useMemo(() => (result?.mapBuckets ?? []).filter((bucket) => bucket.positionBasis !== "city-reference"), [result?.mapBuckets]);
  const mapFrame = useMemo(() => frameSearchMap(locatedBuckets), [locatedBuckets]);
  const emptyIndex = !!data && !data.jobs.length;
  const dataLoading = connecting || (dataMode === "local" && localLoading);
  const presentListing = useMemo(() => data ? createAtlasListingPresenter(data, { now: publicationNow }) : undefined, [data, publicationNow]);
  useEffect(() => { if (!active) return; setPublicationNow(new Date().toISOString()); const timer = setInterval(() => setPublicationNow(new Date().toISOString()), 60000); return () => clearInterval(timer); }, [active]);
  useEffect(() => {
    if (!active || dataMode !== "local") return;
    const abort = new AbortController();
    setLocalLoading(true); setLocalError("");
    const snapshot = readOpportunityLibrary();
    if (snapshot.error) { setLocalError(snapshot.error); setLocalLoading(false); return; }
    void projectLocalOpportunities(snapshot.library, { signal: abort.signal }).then((projection) => {
      if (!abort.signal.aborted) { setLocalData((current) => current?.revision === projection.dataset.revision ? current : projection.dataset); setLocalWarnings(projection.warnings.length); setLocalLoading(false); }
    }, (error: unknown) => { if (!abort.signal.aborted) { setLocalError(error instanceof Error ? error.message : "无法读取当前机会库。"); setLocalLoading(false); } });
    return () => abort.abort();
  }, [active, dataMode, localReload]);
  const coverage = useMemo(() => getAtlasDataCoverage(data, { anchor, now: publicationNow, includeEstimates: true, allowCityEstimate: true, workCountryCodes: country ? [country] : mode === "domestic" ? (chinaSelection.provinceCode && ["HK", "MO", "TW"].includes(chinaSelection.provinceCode) ? [chinaSelection.provinceCode] : countryCatalog.domesticCountryCodes) : [] }), [data, anchor, publicationNow, country, mode, chinaSelection.provinceCode]);
  function applyResumePrefill() {
    if (!resumePrefill.hasResumeData) return;
    if (resumePrefill.targetRole) {
      setText(resumePrefill.targetRole);
    }
    if (resumePrefill.mode === "domestic" && resumePrefill.chinaSelection.provinceCode) {
      setMode("domestic");
      setChinaSelection(resumePrefill.chinaSelection);
      setCountry("");
      setRegion("");
      setRegionText("");
    } else if (resumePrefill.countryCode) {
      setMode("global");
      setCountry(resumePrefill.countryCode);
      setChinaSelection({});
      setRegion("");
      setRegionText("");
    }
    if (resumePrefill.salaryMinWan && !salaryMin && coverage.salary.supported) {
      setSalaryMin(resumePrefill.salaryMinWan);
    }
    setPrefillNotice(`已参考当前简历自动填入：${resumePrefill.summaryLabel}`);
    if (prefillTimer.current) clearTimeout(prefillTimer.current);
    prefillTimer.current = setTimeout(() => setPrefillNotice(null), 4000);
  }
  const countries = useMemo(() => [...new Set([...countryCatalog.countries, ...coverage.country.values])].sort((a, b) => countryName(a).localeCompare(countryName(b), "zh")), [coverage.country.values]);
  const origins = coverage.controller.values;
  const foreignOrigins = useMemo(
    () => origins.filter((c) => c !== "CN" && c !== "unknown"),
    [origins],
  );
  const regions = coverage.region.options.filter((entry) => !country || entry.countryCodes.includes(country));
  const chinaFilter = useMemo(() => buildChinaRegionFilter(chinaSelection), [chinaSelection]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (mode === "domestic" && chinaSelection.provinceCode) {
      resolveAdminBoundaryHighlight(chinaSelection, theme, controller.signal)
        .then((boundary) => {
          if (!cancelled) setAdminBoundary(boundary);
        })
        .catch(() => {
          if (!cancelled) setAdminBoundary(null);
        });
    } else {
      setAdminBoundary(null);
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mode, chinaSelection, theme]);

  const displayFrame = useMemo(() => {
    if (adminBoundary?.bounds) {
      return {
        bounds: adminBoundary.bounds,
        maxZoom: adminBoundary.boundsMaxZoom ?? 11,
      };
    }
    return mapFrame ?? (mode === "domestic" ? frameAdminRegion(chinaFilter.selectedProvince?.mapId) : null);
  }, [adminBoundary, mapFrame, mode, chinaFilter.selectedProvince?.mapId]);
  const scopePlace = mode === "domestic" ? [chinaFilter.selectedProvince?.name, chinaFilter.selectedCity && !chinaFilter.selectedCity.isGrouping ? chinaFilter.selectedCity.name : undefined, chinaFilter.selectedDistrict?.name].filter(Boolean).join(" · ") : "";
  const chinaCities = getChinaCities(chinaSelection.provinceCode ?? "");
  const chinaDistricts = getChinaDistricts(chinaSelection.provinceCode ?? "", chinaSelection.cityCode ?? "");
  const mapLevel = mapZoom >= 10 ? "location" : "city";
  const [pageSize, setPageSize] = useState<number>(30);
  const query = useMemo<JobQueryInput>(() => ({
    search: text.trim() ? { text, mode: "fuzzy" } : undefined,
    market: mode === "domestic" ? "domestic" : "global",
    includeUnknownLocations: mode === "global" || includeUnclassified,
    workCountryCodes: mode === "domestic" ? chinaFilter.workCountryCodes : country ? [country] : [],
    workRegionIds: mode === "domestic" ? [] : region ? [region] : [],
    workRegionText: mode === "domestic" ? undefined : regionText.trim() || undefined,
    workRegionGroups: mode === "domestic" ? chinaFilter.workRegionGroups : undefined,
    controllerJurisdictions:
      origin === "FOREIGN_ALL"
        ? foreignOrigins.length > 0
          ? foreignOrigins
          : ["US", "DE", "FR", "CH", "SE", "FI", "DK", "GB", "NL", "IT", "JP", "KR", "SG", "HK"]
        : origin
          ? [origin]
          : [],
    ownershipKinds: ownership ? [ownership as "state" | "private" | "unknown" | "joint" | "dispersed"] : [],
    sourceIds: source
      ? [source]
      : platformFilter
        ? (data?.sources ?? [])
            .filter((s) => matchCardPlatform({ sources: [{ sourceId: s.sourceId, label: s.attribution?.label ?? s.name ?? s.sourceId, listingId: "" }] } as any, platformFilter))
            .map((s) => s.sourceId)
            .concat(
              (data?.sources ?? []).some((s) => matchCardPlatform({ sources: [{ sourceId: s.sourceId, label: s.attribution?.label ?? s.name ?? s.sourceId, listingId: "" }] } as any, platformFilter))
                ? []
                : ["__empty_platform__"]
            )
        : [],
    salary: { range: salaryMin || salaryMax ? { min: salaryMin ? Number(salaryMin) * 10000 : undefined, max: salaryMax ? Number(salaryMax) * 10000 : undefined } : undefined, metric: "min", includeEstimates: true, includeUnknown: !salaryMin && !salaryMax },
    distance: anchor ? { anchorRef: anchor.ref, maxKm: maxKm ? Number(maxKm) : undefined, allowCityEstimate: true, includeUnknown: !maxKm } : undefined,
    sort: { field: sort, direction }, mapLevel: "location", page: { limit: pageSize },
  }), [text, mode, country, region, regionText, chinaFilter, origin, foreignOrigins, ownership, source, platformFilter, data?.sources, salaryMin, salaryMax, anchor, maxKm, sort, direction, includeUnclassified, pageSize]);
  const generation = useMemo(() => ({ data, query, now: new Date().toISOString() }), [data, query]);
  const queryOptions = useMemo<QueryOptions>(() => ({
    now: generation.now,
    colorConfig: colors,
    anchor,
    domesticCountryCodes: countryCatalog.domesticCountryCodes,
    aliases: DEFAULT_TECHNICAL_ALIASES,
    ...(mapReferences.result ? { mapReferences: mapReferences.result } : {}),
  }), [generation, colors, anchor, mapReferences.result]);
  const penetratedCount = useMemo(() => {
    if (!text.trim() || !data) return 0;
    return data.jobs.filter((job) => {
      const company = data.companies.find((c) => c.id === job.companyId);
      return analyzeAiJobRelevance(job, text, company?.names?.[0]).isPenetrated;
    }).length;
  }, [text, data]);

  const aiPenetratedJobIds = useMemo(() => {
    if (!aiPenetratedOnly || !text.trim() || !data) return undefined;
    return data.jobs
      .filter((job) => {
        const company = data.companies.find((c) => c.id === job.companyId);
        return analyzeAiJobRelevance(job, text, company?.names?.[0]).isPenetrated;
      })
      .map((job) => job.id);
  }, [aiPenetratedOnly, text, data]);

  const effectiveSelectedJobIds = useMemo(() => {
    if (!bucket?.jobIds && !aiPenetratedJobIds) return undefined;
    if (!bucket?.jobIds) return aiPenetratedJobIds;
    if (!aiPenetratedJobIds) return bucket.jobIds;
    const set = new Set(aiPenetratedJobIds);
    return bucket.jobIds.filter((id) => set.has(id));
  }, [bucket?.jobIds, aiPenetratedJobIds]);

  const selectionKey = JSON.stringify({ ...query, mapLevel: "city", sort: undefined, aiPenetratedOnly });
  useEffect(() => { setAiBannerDismissed(false); }, [text]);
  useEffect(() => { cancelCardClick(); cancelOfficeFocus(); setOfficeReview(undefined); setLocationChoices(undefined); setBucket(null); setSelectedId(""); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [selectionKey, dataMode]);
  useEffect(() => { if (!active) { cancelCardClick(); cancelOfficeFocus(); setOfficeReview(undefined); setLocationChoices(undefined); } }, [active]);
  useEffect(() => { cancelOfficeFocus(); }, [endpoint, token]);
  useEffect(() => { cancelCardClick(); setBucket(null); recoveredOfficeSelection.current = undefined; selectedCard.current = undefined; setSelectedId(""); setLocationReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [data, endpoint, token]);
  useEffect(() => {
    cancelCardClick(); setBucket(current => current?.positionBasis === "city-reference" ? null : current);
    setFocus(current => current?.positionBasis === "city-reference" ? undefined : current);
    if (selectedCard.current?.mapReferences?.length && recoveredOfficeSelection.current?.data !== data) { selectedCard.current = undefined; setSelectedId(""); setLocationReview(undefined); }
  }, [mapReferences.result, data]);
  useEffect(() => {
    queryAbort.current?.abort();
    const abort = new AbortController(); queryAbort.current = abort;
    const listKey = `${selectionKey}|${bucket?.id ?? ""}|${aiPenetratedOnly ? "penetrated" : "all"}|${data?.revision ?? 0}|${data?.jobs.length ?? 0}|${dataMode}`;
    if (paging.current.key !== listKey) {
      paging.current = { key: listKey, queryId: "" };
      if (pageIndex !== 0) { setPageIndex(0); setQuerying(false); return; }
    }
    if (!data) { setResult(null); setListPage(null); setListItems([]); setQuerying(false); return; }
    const cursor = pageIndex > 0 && paging.current.queryId ? `${paging.current.queryId}:${pageIndex * pageSize}` : undefined;
    setQuerying(true); setQueryError("");
    const timer = setTimeout(() => {
      void queryAtlasPage(data, query, queryOptions, { signal: abort.signal, ...(cursor ? { cursor } : {}), selectedJobIds: effectiveSelectedJobIds }).then((next) => {
        if (abort.signal.aborted || paging.current.key !== listKey) return;
        const queryId = /^(query_[a-f0-9]{64}):/.exec(next.page.nextCursor ?? "")?.[1];
        if (queryId) paging.current.queryId = queryId;
        setResultData(data); setResult(next.summary); setListPage(next.page); setListItems(next.page.items); setQuerying(false);
      }, (error: unknown) => {
        if (abort.signal.aborted || paging.current.key !== listKey) return;
        const stale = error instanceof Error && error.message.includes("请从第一页");
        if (stale && pageIndex !== 0) { paging.current.queryId = ""; setPageIndex(0); setQuerying(false); return; }
        setResult(null); setListPage(null); setListItems([]); setQuerying(false); setQueryError(error instanceof Error ? error.message : "查询失败");
      });
    }, 120);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [data, dataMode, query, queryOptions, bucket, pageIndex, pageSize, selectionKey]);
  const [broaderCounts, setBroaderCounts] = useState<{ domestic: number; global: number } | null>(null);
  useEffect(() => {
    const keyword = text.trim();
    if (querying || !data || !keyword || (result?.totalJobs ?? 0) > 0) {
      setBroaderCounts(null);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    void Promise.all([
      queryAtlasPage(
        data,
        {
          search: { text: keyword, mode: "fuzzy" },
          market: "domestic",
          includeUnknownLocations: false,
          workCountryCodes: countryCatalog.domesticCountryCodes,
          page: { limit: 1 },
        },
        queryOptions,
        { signal: abort.signal },
      ),
      queryAtlasPage(
        data,
        {
          search: { text: keyword, mode: "fuzzy" },
          market: "global",
          includeUnknownLocations: true,
          workCountryCodes: [],
          page: { limit: 1 },
        },
        queryOptions,
        { signal: abort.signal },
      ),
    ]).then(([domesticRes, globalRes]) => {
      if (cancelled || abort.signal.aborted) return;
      setBroaderCounts({
        domestic: domesticRes.summary.totalJobs,
        global: globalRes.summary.totalJobs,
      });
    }, () => {
      if (!cancelled) setBroaderCounts(null);
    });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [querying, data, text, result?.totalJobs, queryOptions]);
  useEffect(() => () => { cancelCardClick(); connectionAbort.current?.abort(); devBootstrapAbort.current?.abort(); searchAbort.current?.abort(); locationAbort.current?.abort(); officeFocusAbort.current?.abort(); }, []);

  const connect = useCallback(async (identity: AtlasConnectionIdentity, remember: boolean) => {
    searchAbort.current?.abort();
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    connectionAbort.current?.abort();
    const abort = new AbortController(); connectionAbort.current = abort;
    setSourcesOpen(false); setReconciliationOpen(false); setSourceReview(undefined); setCardReview(undefined); setLocationReview(undefined);
    setConnecting(true); setConnectionError(""); setConnectionNotice(""); setDataMode("live");
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const snapshot = await readAtlasSnapshot(identity.endpoint, identity.token, { signal: abort.signal });
      if (connectionAbort.current !== abort || abort.signal.aborted || devAutoConnectSuppressed.current) return;
      restoreConnection.current = false;
      connectedIdentity.current = identity;
      if (remember && !writeAtlasConnectionSession({ schemaVersion: 1, dataMode: "live", ...identity })) setConnectionNotice("本次已连接；浏览器未允许保存标签页会话，刷新后需要重新连接。");
      setLiveData(snapshot); setDataMode("live"); setSelectedId(""); setSettings(null); setSourceSearchMessage(""); setSourceSearchError("");
    } catch (error) {
      if (connectionAbort.current === abort) {
        restoreConnection.current = false;
        setConnectionError(`${remember ? "" : "未能恢复本机索引连接，仍保留本机索引视图；请重试或检查连接设置。"}${abort.signal.aborted ? "连接超时或已取消。请确认本机岗位服务正在运行。" : error instanceof Error ? error.message : "无法连接本机服务。"}`);
      }
    } finally { clearTimeout(timeout); if (connectionAbort.current === abort) setConnecting(false); }
  }, []);
  useEffect(() => {
    if (!active || !restoreConnection.current || initialConnection?.dataMode !== "live") return;
    void connect(initialConnection, false);
    const abort = connectionAbort.current;
    return () => { if (connectionAbort.current === abort) { connectionAbort.current = null; abort?.abort(); setConnecting(false); } };
  }, [active, initialConnection, connect]);
  const bootstrapDevIndex = useCallback(async (signal?: AbortSignal) => {
    if (!devJobIndex || devAutoConnectSuppressed.current || readAtlasDevAutoConnectSuppressed()) return;
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    devBootstrapAbort.current = abort;
    setDataMode("live"); setConnecting(true); setConnectionError(""); setConnectionNotice("正在准备本机岗位索引…");
    try {
      const result = await devJobIndex(abort.signal);
      if (abort.signal.aborted || devAutoConnectSuppressed.current) {
        if (!connectedIdentity.current && devBootstrapAbort.current === abort) setConnecting(false);
        return;
      }
      if (!result?.ok) {
        setConnecting(false); setConnectionNotice("");
        setConnectionError(result ? result.error : "本地开发服务没有返回岗位索引连接。请确认当前页面由本机开发服务打开。");
        return;
      }
      setEndpoint(result.endpoint); setToken(result.token);
      await connect({ endpoint: result.endpoint, token: result.token }, true);
    } catch (error) {
      if (abort.signal.aborted || devAutoConnectSuppressed.current) {
        if (!connectedIdentity.current && devBootstrapAbort.current === abort) setConnecting(false);
        return;
      }
      setConnecting(false); setConnectionNotice("");
      setConnectionError(error instanceof Error && error.message ? error.message : "无法准备本机岗位索引。");
    } finally {
      signal?.removeEventListener("abort", stop);
      if (devBootstrapAbort.current === abort) devBootstrapAbort.current = null;
    }
  }, [connect, devJobIndex]);
  useEffect(() => {
    if (!active || !devJobIndex || initialConnection || connectedIdentity.current || devAutoConnectSuppressed.current || readAtlasDevAutoConnectSuppressed()) return;
    const abort = new AbortController();
    void bootstrapDevIndex(abort.signal);
    return () => abort.abort();
  }, [active, devJobIndex, initialConnection, bootstrapDevIndex]);
  function cancelConnection() {
    restoreConnection.current = false;
    const abort = connectionAbort.current; connectionAbort.current = null; abort?.abort();
    searchAbort.current?.abort(); setConnecting(false);
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    setSourcesOpen(false); setReconciliationOpen(false); setSourceReview(undefined); setCardReview(undefined); setLocationReview(undefined);
  }
  function changeConnection(field: "endpoint" | "token", value: string) {
    cancelConnection(); clearAtlasConnectionSession(); connectedIdentity.current = null;
    setLiveData(null); setConnectionError(""); setConnectionNotice("连接资料已更改，请重新连接并读取索引。");
    if (field === "endpoint") setEndpoint(value); else setToken(value);
  }
  function chooseDataMode(next: AtlasDataMode) {
    cancelConnection(); setDataMode(next); setConnectionError(""); setConnectionNotice(""); resetFilters();
    if (next === "live" && connectedIdentity.current) writeAtlasConnectionSession({ schemaVersion: 1, dataMode: next, ...connectedIdentity.current });
    else if (next !== "live") writeAtlasConnectionSession({ schemaVersion: 1, dataMode: next });
    else { clearAtlasConnectionSession(); setSettings("connection"); }
  }
  function disconnect() {
    devAutoConnectSuppressed.current = true; writeAtlasDevAutoConnectSuppressed(); devBootstrapAbort.current?.abort();
    cancelConnection(); clearAtlasConnectionSession(); connectedIdentity.current = null;
    setToken(""); setLiveData(null); setDataMode("local"); setConnectionError(""); setConnectionNotice("已断开本机索引，并清除当前标签页的会话连接。");
  }
  function currentPlatformRegionText(): string {
    if (mode === "domestic") {
      return (
        (chinaFilter.selectedCity?.isGrouping &&
        ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "")
          ? chinaFilter.selectedProvince?.name
          : chinaFilter.selectedCity?.name) ??
        chinaFilter.selectedProvince?.name ??
        ""
      );
    }
    return regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "");
  }

  function formatLivePlatformNotice(summary: LivePlatformImportSummary | undefined): string {
    if (!summary) return "";
    const parts: string[] = [];
    if (summary.importedPlatforms.length > 0) {
      parts.push(
        `🌐 全网平台实时检索（${summary.importedPlatforms.join("、")}）：共抓取 ${summary.totalCardsFetched} 条最新岗位，新增入库 ${summary.totalAdded} 岗、更新 ${summary.totalUpdated} 岗${summary.officeAddressesConfirmed > 0 || summary.companiesClassified > 0 ? `，已自动核实 ${summary.companiesClassified} 家企业性质/外企国别与 ${summary.officeAddressesConfirmed} 个办公地址坐标并点亮地图` : summary.locationsConfirmed > 0 ? `，已自动对齐 ${summary.locationsConfirmed} 个国内行政地区并点亮地图` : ""}。`,
      );
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

  async function enrichCurrentIndex() {
    if (!connected || !liveData) return;
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    setSourceSearching(true);
    setSourceSearchError("");
    setSourceSearchMessage("正在智能核实当前岗位库的企业性质（央企/国企/外企国别/合资/民企）与办公地址 WGS84 坐标…");
    try {
      const client = createAtlasSourceClient(endpoint, token);
      const enriched = await enrichSnapshotCompaniesAndOffices({
        client,
        snapshot: liveData,
        fallbackChinaSelection: mode === "domestic" ? chinaSelection : undefined,
        signal: abort.signal,
      });
      if (searchAbort.current !== abort || abort.signal.aborted) return;
      setLiveData(enriched.snapshot);
      setDataMode("live");
      setSourceSearchMessage(
        `已完成企业与地址智能补全：新增核实 ${enriched.companiesClassified} 家企业控股性质/国别、${enriched.officeAddressesConfirmed} 个办公地址坐标、${enriched.locationsConfirmed} 个行政区划。`,
      );
    } catch (error) {
      if (searchAbort.current === abort) {
        setSourceSearchError(error instanceof Error ? error.message : "企业性质与办公地址补全未完成。");
      }
    } finally {
      if (searchAbort.current === abort) setSourceSearching(false);
    }
  }

  async function searchLivePlatformsOnly() {
    if (!connected) {
      setSettings("connection");
      setSourceSearchMessage("先连接本机来源服务，再执行全网平台实时抓取入库。");
      return;
    }
    if (text.trim().length > 300) {
      setSourceSearchError("来源搜索关键词最多 300 个字符。");
      return;
    }
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    setSourceSearching(true);
    setSourceSearchError("");
    setSourceSearchMessage("正在通过真实 Chrome CDP 从 猎聘、前程无忧 51JOB、BOSS直聘、LinkedIn 实时抓取最新岗位…");
    setHarvestStage({ index: 1, total: 5, message: "动态检索意图与语义拓展…" });
    setSourceReview(undefined);
    setBucket(null);
    const client = createAtlasSourceClient(endpoint, token);
    const liveKeyword = text.trim() || resumePrefill.targetRole || "软件工程师";
    const liveRegion = currentPlatformRegionText();
    try {
      const summary = await executeOpportunityHarvestChainedPipeline(
        {
          client,
          keyword: liveKeyword,
          region: liveRegion,
          depth: searchDepth,
          maxPages: searchDepth === "deep" ? 30 : searchDepth === "standard" ? 15 : 5,
          chinaSelection: mode === "domestic" ? chinaSelection : undefined,
          initialSnapshot: (dataMode === "live" && liveData) ? liveData : undefined,
          signal: abort.signal,
          onCardsCommitted: (snapshot) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              setLiveData(snapshot);
              setDataMode("live");
              setSourceSearching(false);
            }
          },
          onSnapshotAvailable: (snapshot) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              setLiveData(snapshot);
              setDataMode("live");
            }
          },
        },
        (progress) => {
          if (searchAbort.current === abort && !abort.signal.aborted) {
            setHarvestStage({
              index: progress.stageIndex,
              total: progress.totalStages,
              message: progress.message,
            });
            setSourceSearchMessage(`[流水线 ${progress.stageIndex}/5] ${progress.message}`);
          }
        },
      );
      if (searchAbort.current !== abort || abort.signal.aborted) return;
      if (summary.snapshot) {
        setLiveData(summary.snapshot);
        setDataMode("live");
      }
      const notice = formatLivePlatformNotice(summary);
      setSourceSearchMessage(
        notice || `已完成全网平台（BOSS · 51 · 猎聘 · 领英）实时检索，暂未发现新卡片。`,
      );
    } catch (error) {
      if (searchAbort.current === abort) {
        setSourceSearchError(error instanceof Error ? error.message : "全网平台实时抓取失败。");
      }
    } finally {
      if (searchAbort.current === abort) {
        setSourceSearching(false);
        setHarvestStage(null);
      }
    }
  }

  async function searchSourceJobs(overrideKeyword?: string) {
    if (!connected) { setSettings("connection"); setSourceSearchMessage("先连接本机来源服务，再按关键词从已配置来源获取岗位。"); return; }
    const effectiveText = (overrideKeyword !== undefined ? overrideKeyword : text).trim();
    if (effectiveText.length > 300) { setSourceSearchError("来源搜索关键词最多 300 个字符。"); return; }
    searchAbort.current?.abort(); const abort = new AbortController(); searchAbort.current = abort;
    setSourceSearching(true); setSourceSearchError(""); setSourceSearchMessage(""); setSourceReview(undefined); setBucket(null); setIntervenePlatforms([]);
    const client = createAtlasSourceClient(endpoint, token);
    const requestIdentities = new Map<string, string>();
    const scopeCountry = mode === "global" ? country : "";
    const requestedRegion = regionText.trim() || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "");
    const scopeRegions = mode === "domestic" ? chinaFilter.sourceRegions : requestedRegion ? [requestedRegion] : [];
    const acquisitionCountries = mode === "domestic" ? (chinaFilter.workCountryCodes.length ? chinaFilter.workCountryCodes : includeUnclassified ? [] : countryCatalog.domesticCountryCodes) : scopeCountry && scopeRegions.length ? [scopeCountry] : [];
    // Serialize snapshot refreshes so a slower, older response cannot replace a newer index.
    let refresh: Promise<void> = Promise.resolve();
    const enableLiveCommercialSearch = import.meta.env?.DEV === true && !searchSourceId;
    const liveKeyword = effectiveText || resumePrefill.targetRole || "软件工程师";
    const liveRegion = currentPlatformRegionText();
    let liveSummary: LivePlatformImportSummary | undefined;
    const liveCommercialPromise: Promise<void> = enableLiveCommercialSearch
      ? executeOpportunityHarvestChainedPipeline(
          {
            client,
            keyword: liveKeyword,
            region: liveRegion,
            depth: searchDepth,
            maxPages: searchDepth === "deep" ? 30 : searchDepth === "standard" ? 15 : 5,
            chinaSelection: mode === "domestic" ? chinaSelection : undefined,
            initialSnapshot: (dataMode === "live" && liveData) ? liveData : undefined,
            signal: abort.signal,
            onCardsCommitted: (snapshot) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                setLiveData(snapshot);
                setDataMode("live");
                if (!selectedSearchSources.length) {
                  setSourceSearching(false);
                }
              }
            },
            onSnapshotAvailable: (snapshot) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                setLiveData(snapshot);
                setDataMode("live");
              }
            },
          },
          (progress) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              setSourceSearchMessage(`[全网实时检索 ${progress.stageIndex}/5] ${progress.message}`);
            }
          },
        )
          .then((summary) => {
            if (abort.signal.aborted || searchAbort.current !== abort) return;
            liveSummary = summary;
            if (summary.snapshot) {
              setLiveData(summary.snapshot);
              setDataMode("live");
            }
            if (summary.loginRequiredPlatforms.length > 0 || summary.verificationRequiredPlatforms.length > 0) {
              setIntervenePlatforms([...summary.loginRequiredPlatforms, ...summary.verificationRequiredPlatforms]);
            } else {
              setIntervenePlatforms([]);
            }
            const notice = formatLivePlatformNotice(summary);
            if (notice) setSourceSearchMessage(notice);
          })
          .catch(() => {})
      : Promise.resolve();

    if (!selectedSearchSources.length) {
      try {
        await liveCommercialPromise;
        if (searchAbort.current !== abort) return;
        const liveNotice = formatLivePlatformNotice(liveSummary);
        setSourceSearchMessage(
          liveNotice || `已完成全网平台（51Job · BOSS · 猎聘 · 领英）实时检索与流式入库。`,
        );
      } catch (error) {
        if (searchAbort.current === abort) setSourceSearchError(error instanceof Error ? error.message : "全网平台实时抓取失败。");
      } finally {
        if (searchAbort.current === abort) setSourceSearching(false);
      }
      return;
    }

    try {
      const activeConcurrency = Math.min(Math.max(1, searchConcurrency), selectedSearchSources.length || 1, 16);
      const aggregate = await runAtlasSourceSearch({
        sources: selectedSearchSources, signal: abort.signal, concurrency: activeConcurrency,
        buildRequest: (entry) => {
          const companyName = typeof entry.options?.companyName === "string" ? entry.options.companyName : "";
          const companySearch = Boolean(text.trim() && companyName && normalizeSearchText(text) === normalizeSearchText(companyName));
          const scope = { roles: text.trim() && !companySearch ? [text.trim()] : [], regions: scopeRegions.length ? scopeRegions : scopeCountry ? [scopeCountry] : [], ...(acquisitionCountries.length ? { countryCodes: acquisitionCountries } : {}), companyNames: companySearch ? [companyName] : [] };
          const request = { scope, maxRecords: Math.min(searchDepth === "quick" ? 50 : searchDepth === "deep" ? 2000 : 500, entry.refreshPolicy.maxRecords), maxPages: Math.min(searchDepth === "quick" ? 2 : searchDepth === "deep" ? 50 : 20, entry.refreshPolicy.maxPages) };
          const identity = JSON.stringify([endpoint, entry.sourceId, request]);
          requestIdentities.set(entry.sourceId, identity);
          let idempotencyKey = searchKeys.current.get(identity);
          if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); searchKeys.current.set(identity, idempotencyKey); }
          return { request, idempotencyKey };
        },
        sync: async (id, request, options) => {
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error("该来源等待超过 90 秒，已停止本次等待；可保留回执继续核对。")), 90000);
          try { return await client.sync(id, request, { ...options, signal: AbortSignal.any([abort.signal, timeout.signal]) }); }
          finally { clearTimeout(timer); }
        },
        onProgress: (progress) => { if (searchAbort.current === abort) setSearchProgress(progress); },
        onReceipt: async (receipt, entry) => {
          // Keep the key while the server is still running or the outcome is not confirmed.
          if (receipt.run.status !== "running") { const identity = requestIdentities.get(entry.sourceId); if (identity) searchKeys.current.delete(identity); }
          refresh = refresh.catch(() => {}).then(async () => {
            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), 20000);
            try {
              const snapshot = await client.snapshot({ signal: AbortSignal.any([abort.signal, timeout.signal]) });
              if (abort.signal.aborted || searchAbort.current !== abort) return;
              setLiveData(snapshot); setDataMode("live");
            } finally { clearTimeout(timer); }
          });
          await refresh;
        },
      });
      await liveCommercialPromise;
      if (searchAbort.current !== abort) return;
      const receipts = aggregate.sources.filter((entry) => entry.receipt);
      const records = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.records ?? 0), 0);
      const added = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.added ?? 0), 0);
      const failed = aggregate.sources.filter((entry) => entry.error || entry.status === "failed").length;
      const pendingRequirements = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.needsHuman ?? 0), 0);
      const liveNotice = formatLivePlatformNotice(liveSummary);
      const totalAddedAll = added + (liveSummary?.totalAdded ?? 0) + (liveSummary?.totalUpdated ?? 0);
      setSourceSearchMessage(`${liveNotice ? `${liveNotice} · ` : ""}${aggregate.cancelled ? "已停止等待" : "本次配置来源读取已结束"} · ${receipts.length}/${aggregate.total} 个来源返回回执，原始返回 ${records} 条，新增入库 ${added} 岗。原始条数不代表匹配岗位数；仅已确认匹配的结果进入索引。${pendingRequirements ? ` 另有 ${pendingRequirements} 条候选要求未读全，尚不能判断是否符合。` : ""}${failed ? ` ${failed} 个来源未成功，请展开逐源状态。` : ""}${aggregate.cancelled ? " 未确认的请求可能已保存部分数据，可重新读取索引核对。" : ""}${totalAddedAll === 0 ? " 💡 提示：企业官网公开源可能受海外网络或配额限制（如 ABB 等）；已自动为您展开下方的【全网商业平台聚合搜索】，配合【真实 Chrome 防反爬接管】可快速从 BOSS直聘、猎聘、51JOB 等全平台获取国内最新岗位。" : ""}`);
      if (totalAddedAll === 0) setPlatformSearchOpen(true);
      if (failed) setSourceSearchError(aggregate.sources.filter((entry) => entry.error || entry.status === "failed").map((entry) => `${entry.label}：${entry.error?.message ?? entry.receipt?.sourceError?.code ?? "来源读取失败"}`).join("；"));
      if (aggregate.notificationErrors.length) setSourceSearchError("部分来源已返回，但索引展示刷新未完成，请点击“重新读取索引”核对。来源回执已保留。");
    } catch (error) {
      if (searchAbort.current === abort) setSourceSearchError(error instanceof Error ? error.message : "聚合来源搜索失败。");
    } finally { if (searchAbort.current === abort) setSourceSearching(false); }
  }
  const visibleItems = useMemo(() => {
    if (resultData !== data) return [];
    return listItems.filter((item) => {
      if (salaryFilter && !matchCardSalary(item, salaryFilter)) return false;
      if (pubFilter && !matchCardPublication(item, pubFilter, presentListing?.(item), data)) return false;
      if (distanceFilter && anchor && !matchCardDistance(item, distanceFilter)) return false;
      if (distanceFilter === "exact" && (item.distance?.estimated || !item.distance)) return false;
      if (aiPenetratedOnly) {
        const rel = analyzeAiJobRelevance(item.job, text, item.company.names[0]);
        if (!rel.isPenetrated) return false;
      }
      return true;
    });
  }, [resultData, data, listItems, salaryFilter, pubFilter, distanceFilter, anchor, presentListing, aiPenetratedOnly, text]);
  const selected = visibleItems.find((item) => item.job.id === selectedId)
    ?? (selectedCard.current?.job.id === selectedId && data?.jobs.some((job) => job.id === selectedId) ? selectedCard.current : undefined);
  useEffect(() => {
    const request = officeFocusRequest;
    if (!request) return;
    if (!active || !connected || dataMode !== "live" || data !== request.snapshot || selectionKey !== request.selectionKey || endpoint !== request.endpoint || token !== request.token) {
      cancelOfficeFocus(); return;
    }
    // A saved job may be beyond the first page. Recheck it against the same snapshot and
    // current filters; queryAtlasPage intersects this ID with any existing job filter.
    const abort = new AbortController(); officeFocusAbort.current = abort;
    void queryAtlasPage(data, { ...query, page: { limit: 1 } }, queryOptions, { signal: abort.signal, selectedJobIds: [request.jobId] }).then(next => {
      if (abort.signal.aborted) return;
      const item = next.page.items.find(value => value.job.id === request.jobId);
      if (!item) { cancelOfficeFocus(); selectedCard.current = undefined; setSelectedId(""); setFocus(undefined); return; }
      recoveredOfficeSelection.current = { data, selectionKey, jobId: item.job.id };
      selectedCard.current = item; setSelectedId(item.job.id);
      if (officeFocusApplied.current === request.id) return;
      officeFocusApplied.current = request.id;
      const target = createJobMapFocus(item, crypto.randomUUID(), { locationId: request.locationId });
      if (target) { setFocus({ ...target, viewportOffset: [0, 0] }); setRotating(false); }
    }, (error: unknown) => {
      if (!abort.signal.aborted) { cancelOfficeFocus(); setSourceSearchError(error instanceof Error ? error.message : "无法重新核对已保存岗位，请重新读取索引。"); }
    });
    return () => abort.abort();
  }, [officeFocusRequest, active, connected, dataMode, data, selectionKey, endpoint, token, query, queryOptions]);
  useEffect(() => {
    if (resultData !== data || !rawResult || !selectedId || listItems.some(item => item.job.id === selectedId)) return;
    const recovered = recoveredOfficeSelection.current;
    if (recovered?.data === data && recovered.selectionKey === selectionKey && recovered.jobId === selectedId) return;
    // A saved location may remove this job from the active area. Discard the old card's facts.
    selectedCard.current = undefined; setSelectedId(""); setLocationReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setFocus(undefined);
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
  }, [data, resultData, rawResult, selectedId, listItems, selectionKey]);
  function openJob(item: JobSearchItem) {
    cancelCardClick();
    setDetailReviewJobId(""); setEnrichmentScope(null);
    if (selectedId !== item.job.id) { cancelOfficeFocus(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setOfficeReview(undefined); setLocationChoices(undefined); }
    selectedCard.current = item; setSelectedId(item.job.id);
  }
  function clickJob(item: JobSearchItem, detail: number) {
    cancelCardClick();
    // The desktop reading column is always reserved, keeping the card under the pointer.
    // Smaller layouts can still move the card when details appear; preserve their double-click window.
    if (detail === 0 || layout === "wide") openJob(item);
    else if (detail === 1) cardClickTimer.current = setTimeout(() => openJob(item), 520);
  }
  function closeJob() { cancelCardClick(); cancelOfficeFocus(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setSelectedId(""); setFocus(undefined); }
  function flyToJob(target: AtlasMapFocus) {
    setFocus({ ...target, viewportOffset: [0, 0] }); setRotating(false);
    const element = scene.current;
    const bounds = element?.getBoundingClientRect();
    const scrollport = workspace.current?.getBoundingClientRect();
    const visibleTop = Math.max(0, scrollport?.top ?? 0), visibleLeft = Math.max(0, scrollport?.left ?? 0);
    const visibleBottom = Math.min(window.innerHeight, scrollport?.bottom ?? window.innerHeight);
    const visibleRight = Math.min(window.innerWidth, scrollport?.right ?? window.innerWidth);
    // A desktop map already beside the selected card should not pull the document away from it.
    // The workspace scrollport can clip a map which still intersects the browser viewport.
    const visible = bounds && visibleBottom > visibleTop && visibleRight > visibleLeft
      && bounds.bottom > visibleTop && bounds.top < visibleBottom && bounds.right > visibleLeft && bounds.left < visibleRight;
    if (element && !visible) element.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  async function locateJob(item: JobSearchItem, locationId?: string) {
    openJob(item);
    const choices = item.job.workMode === "remote" ? [] : item.locations.filter(location => location.kind === "office");
    if (!locationId && choices.length > 1) {
      locationAbort.current?.abort(); setLocationSearch(undefined); setFocus(undefined); setLocationChoices(item.job.id);
      return;
    }
    setLocationChoices(undefined);
    const direct = createJobMapFocus(item, crypto.randomUUID(), { locationId: locationId ?? choices[0]?.id });
    const location = choices.find(entry => !locationId || entry.id === locationId);
    if (direct && (direct.precision === "address" || direct.precision === "manual")) {
      locationAbort.current?.abort(); setLocationSearch(undefined); flyToJob(direct); return;
    }
    if (connected && dataMode === "live" && location?.streetAddress) {
      locationAbort.current?.abort(); setLocationSearch(undefined); setFocus(undefined); setOfficeReview({ jobId: item.job.id, location }); return;
    }
    if (direct) { locationAbort.current?.abort(); setLocationSearch(undefined); flyToJob(direct); return; }
    if (!location) { locationAbort.current?.abort(); setFocus(undefined); setLocationSearch({ jobId: item.job.id, locationId: locationId ?? "", loading: false, error: "该岗位未披露可确认的办公地点，不能将远程资格或未知地点标成办公地址。" }); return; }
    if (!connected) { setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: false, error: "来源只有地点原文。连接本机服务后，可核对具体办公地址或查询离线城市候选；也可以打开 Google 地图核对。" }); return; }
    locationAbort.current?.abort(); const abort = new AbortController(); locationAbort.current = abort;
    setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: true });
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await createAtlasSourceClient(endpoint, token).geocodeCandidates(buildAtlasCityCandidateQuery(location), { signal: abort.signal });
      if (locationAbort.current !== abort || abort.signal.aborted) return;
      setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: false, result });
    } catch (error) {
      if (locationAbort.current === abort) setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: false, error: abort.signal.aborted ? "城市查询已取消或超时，可重试。" : error instanceof Error ? error.message : "城市候选暂不可用。" });
    } finally { clearTimeout(timer); }
  }
  function chooseLocationCandidate(candidate: GeocodingCandidate) {
    if (!selected || locationSearch?.jobId !== selected.job.id || !locationSearch.result?.candidates.some((entry) => entry.id === candidate.id)) return;
    const target = createJobMapFocus(selected, crypto.randomUUID(), { locationId: locationSearch.locationId, cityCandidate: { locationId: locationSearch.locationId, candidate } });
    if (target) flyToJob(target);
  }
  function routeJob(item: JobSearchItem, analyze: boolean) {
    if (dataMode === "demo") return;
    if (!data || resultData !== data || !data.jobs.some((job) => job.id === item.job.id)) return;
    const input = buildAtlasJobAction(data, item);
    if (analyze) onAnalyze(input);
    else onSaveOpportunity({ token: crypto.randomUUID(), title: item.job.title.value, description: item.job.description, sourceUrl: input.url, sourcePlatform: input.platform, collectedAt: input.observedAt, sourcePublishedAt: input.sourcePublishedAt, sourcePublishedText: input.sourcePublishedText });
  }
  function resetCamera() { camera.current = undefined; setFocus(undefined); setMapZoom(mode === "global" ? 1.65 : 3.1); setMapKey((k) => k + 1); setMapError(""); }
  function changeMapMode(next: "global" | "domestic") { camera.current = undefined; setFocus(undefined); setMode(next); setMapZoom(next === "global" ? 1.65 : 3.1); setMapKey((k) => k + 1); setCountry(""); setRegion(""); setRegionText(""); setMapError(""); }
  function resetFilters() {
    setText(""); setCountry(""); setRegion(""); setRegionText(""); setChinaSelection({}); setAdminBoundary(null);
    setOrigin(""); setOwnership(""); setSource(""); setSalaryMin(""); setSalaryMax(""); setMaxKm("");
    setIncludeUnclassified(false); setSort("relevance"); setDirection("desc"); setBucket(null);
    setPlatformFilter(""); setSalaryFilter(""); setDistanceFilter(""); setPubFilter("");
    setAiPenetratedOnly(false);
  }

  return <section ref={workspace} className="atlas-workspace" data-pane-layout={layout} aria-label={t("岗位地图", "Opportunity atlas")}>
    <div className="atlas-command">
    <div className="atlas-heading"><div><span className="atlas-eyebrow">BETTERME / OPPORTUNITY ATLAS</span><h1>{t("让下一个机会，有迹可循。", "Find where your next chapter begins.")}</h1><p>{t("从全球视野，找到与你更近的工作。", "Explore opportunities across the world, and closer to home.")}</p></div><details className="atlas-top-actions"><summary>地图与连接</summary><button onClick={() => setSettings(settings === "maps" ? null : "maps")}><Globe2 size={15} />地图服务</button><button onClick={() => setSettings(settings === "home" ? null : "home")}><Home size={15} />{anchor ? t("已设置家庭参照点", "Home set") : t("设置离家距离", "Set home distance")}</button><button onClick={() => setSettings(settings === "connection" ? null : "connection")}><Database size={15} />{t("连接本机服务", "Connect local service")}</button></details></div>
    <div className={`atlas-data-banner ${dataMode}`} role="status"><span className="atlas-status-dot" /><strong>{dataMode === "demo" ? "演示模式 · 非真实招聘" : dataMode === "live" ? "真实来源 · 本机索引" : "真实来源 · 当前机会库"}</strong><span>{dataMode === "demo" ? "企业、岗位和薪资均为合成样本，不计入真实岗位。" : `${data?.jobs.length ?? 0} 个来源岗位 · ${text.trim() ? `关键词“${text.trim()}”${scopePlace ? `在${scopePlace}` : ""}命中 ${result?.totalJobs ?? 0} 岗 · ` : ""}${dataMode === "local" ? "只在本页读取公开岗位字段，原机会库不变" : connecting ? "正在连接并读取本机索引…" : liveData ? `索引版本 ${liveData.revision} · 手动刷新` : "索引尚未读取 · 请重试连接"}`}</span><label className="atlas-data-selector">数据视图<select aria-label="岗位数据视图" value={dataMode} onChange={(e) => chooseDataMode(e.target.value as AtlasDataMode)}><option value="local">当前机会库 · 真实来源</option><option value="live">本机采集索引 · 真实来源</option><option value="demo">合成演示 · 仅体验地图</option></select></label><details className="atlas-banner-tools"><summary>索引工具</summary>{dataMode === "local" && <button disabled={localLoading} onClick={() => setLocalReload((n) => n + 1)}>{localLoading ? "正在读取…" : "重新读取机会库"}</button>}{dataMode === "live" && <button disabled={connecting} onClick={() => { restoreConnection.current = false; if (devJobIndex && !token.trim() && !devAutoConnectSuppressed.current) void bootstrapDevIndex(); else void connect({ endpoint, token }, true); }}>重新读取索引</button>}<button onClick={() => { setSourcesOpen(!sourcesOpen); setReconciliationOpen(false); setSettings(null); }}>来源工具</button>{dataMode === "live" && connected && <button aria-expanded={reconciliationOpen} onClick={() => { setReconciliationOpen(!reconciliationOpen); setSourcesOpen(false); }}>重复岗位核对</button>}{onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>全平台单岗读取（BOSS · 猎聘 · 51 · 领英 · Seek · Indeed · GradConnection）</button>}</details></div>
    {connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}
    {connectionNotice && <p role="status" className="atlas-small">{connectionNotice}</p>}
    {localError && dataMode === "local" && <p role="alert" className="atlas-error">{localError}</p>}
    {dataMode === "local" && !!localData?.jobs.length && localWarnings > 0 && <p className="atlas-small">有 {localWarnings} 项来源字段提示：未提供的日期、结构化薪资与坐标保持未知。查看岗位详情核对原文；投递记录和联系人未进入地图数据。</p>}
    {active && reconciliationOpen && connected && dataMode === "live" && liveData && <Suspense fallback={<p role="status">正在打开重复岗位核对…</p>}><AtlasReconciliationPanel endpoint={endpoint} token={token} data={liveData} onClose={() => setReconciliationOpen(false)} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`已读取岗位处理记录，索引版本 ${snapshot.revision}。列表与地图会按当前来源组合重新计算。`);
    }} /></Suspense>}
    {sourcesOpen && <Suspense fallback={<p role="status">正在加载来源工具…</p>}><AtlasSourcesPanel endpoint={endpoint} token={token} onSnapshot={(snapshot) => { searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live"); }} onClose={() => setSourcesOpen(false)} /></Suspense>}
    {settings && <div className="atlas-settings"><button className="atlas-panel-close" aria-label="关闭地图设置" onClick={() => setSettings(null)}><X size={17} /></button>
      {settings === "maps" && <div><h2>地图与街道底图</h2><p>全球与国内均使用同一经纬度视图，可连续缩放至街道。开放底图无需 API Key；联网底图会向所选服务请求当前视野的瓦片，离线轮廓不请求外部地图服务。</p><label className="atlas-basemap-select">底图来源<select value={basemapId} onChange={(e) => { setBasemapId(e.target.value); setMapError(""); }}><option value="auto">OpenFreeMap · 跟随浅深主题</option>{ATLAS_BASEMAPS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}<option value="offline">本地概览 · 离线边界</option></select></label><p className="atlas-small">道路、建筑、门牌和地名是否显示取决于底图覆盖。城市级岗位不会显示成精确办公地址。Google 地图可从岗位详情的“Google 地图”入口打开；内嵌 Google Maps 尚未启用，需要个人 Key、服务权限及对应计费配置。</p></div>}
      {settings === "connection" && <form onSubmit={(e) => { e.preventDefault(); devAutoConnectSuppressed.current = false; clearAtlasDevAutoConnectSuppressed(); restoreConnection.current = false; void connect({ endpoint, token }, true); }}><h2>{t("连接你的本机岗位索引", "Connect your local job index")}</h2><p>{import.meta.env?.DEV ? "本机开发页会自动连接 127.0.0.1:5178 并读取索引，不必手填服务地址和访问令牌。" : "公网页面没有本地开发接口，仍需填写本机服务地址和访问令牌。"}允许当前网页 Origin：<code>{window.location.origin}</code>。连接成功后，访问令牌仅保留在当前标签页的会话存储中，刷新可恢复连接；断开并清除后，这个标签页不会马上再自动连接。令牌不写入永久存储或网址。</p><div className="atlas-form-row"><label>服务地址<input value={endpoint} onChange={(e) => changeConnection("endpoint", e.target.value)} placeholder="http://127.0.0.1:5178" /></label><label>访问令牌<input type="password" autoComplete="off" value={token} onChange={(e) => changeConnection("token", e.target.value)} /></label><button type="submit" disabled={connecting}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{connecting ? "正在连接" : "连接并读取索引"}</button><button type="button" onClick={disconnect}>断开并清除会话连接</button></div><p className="atlas-small">读取公开岗位快照，在本页执行共享查询。家庭参照坐标不发送给服务。公网 HTTPS 页面连接本机可能需要浏览器本地网络授权；完整体验建议使用本机网页。</p></form>}
      {settings === "home" && (
        <form onSubmit={(e) => {
          e.preventDefault();
          const lat = Number(latitude), lon = Number(longitude);
          if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            setHomeError("请输入有效的 WGS84 纬度（-90～90）和经度（-180～180）。");
            return;
          }
          setAnchor({ ref: crypto.randomUUID(), latitude: lat, longitude: lon, coordinateSystem: "WGS84" });
          setHomeError("");
          setSettings(null);
        }}>
          <h2>离家距离 · 私人参照点</h2>
          <p>使用 WGS84 坐标计算直线距离，仅保留在本页内存。城市中心距离会标为估算；可选用快捷地标一键填入，或直接输入坐标。</p>
          <div className="atlas-home-presets">
            <span style={{ fontSize: 11, color: "var(--color-ink-muted)", alignSelf: "center", marginRight: 4 }}>快捷地标：</span>
            {[
              { label: "人民广场", lat: 31.2304, lon: 121.4737 },
              { label: "张江高科", lat: 31.2047, lon: 121.5878 },
              { label: "徐家汇", lat: 31.1957, lon: 121.4365 },
              { label: "陆家嘴", lat: 31.2397, lon: 121.5000 },
              { label: "虹桥枢纽", lat: 31.1963, lon: 121.3195 },
              { label: "临港新片区", lat: 30.8872, lon: 121.9287 },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                className="atlas-home-preset-btn"
                onClick={() => {
                  setLatitude(String(p.lat));
                  setLongitude(String(p.lon));
                  setAnchor({ ref: crypto.randomUUID(), latitude: p.lat, longitude: p.lon, coordinateSystem: "WGS84" });
                  setHomeError("");
                  setSettings(null);
                }}
              >
                📍 {p.label}
              </button>
            ))}
          </div>
          <div className="atlas-form-row">
            <label>纬度<input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="例如 31.2304" /></label>
            <label>经度<input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="例如 121.4737" /></label>
            <button type="submit">应用参照点</button>
            {anchor && (
              <button
                type="button"
                onClick={() => {
                  setAnchor(undefined);
                  setLatitude("");
                  setLongitude("");
                  setMaxKm("");
                  setDistanceFilter("");
                  if (sort === "distance") setSort("relevance");
                }}
              >
                清除
              </button>
            )}
          </div>
          {homeError && <p role="alert" className="atlas-error">{homeError}</p>}
        </form>
      )}
      {settings === "colors" && <div><h2>企业控股来源配色</h2><p>配色依据已核实的最终控股方来源。工作地点不代表企业来源；待核实与证据冲突单列。颜色只影响岗位地图。</p><div className="atlas-color-grid">{colors.rules.map((rule, index) => <label key={rule.id}><input type="color" aria-label={`${rule.label}颜色`} value={rule.color} onChange={(e) => setColors((current) => ({ ...current, rules: current.rules.map((r, n) => n === index ? { ...r, color: e.target.value } : r) }))} /><span>{rule.label}</span></label>)}</div><div className="atlas-form-row"><button onClick={() => { try { localStorage.setItem(COLOR_KEY, JSON.stringify(CompanyColorConfigSchema.parse(colors))); setColorsMessage("配色已保存到当前浏览器。"); } catch { setColorsMessage("浏览器未允许保存，当前页面仍应用此配色。"); } }}>保存配色</button><button onClick={() => { setColors(getDefaultCompanyColorConfig()); setColorsMessage("已恢复默认配色；点击保存可保留。"); }}>恢复默认</button><span role="status">{colorsMessage}</span></div></div>}
    </div>}
    {resumePrefill.hasResumeData && (
      <div className="atlas-resume-prefill-bar" role="region" aria-label="简历画像与关键词快捷联动">
        <div className="atlas-prefill-main">
          <button
            type="button"
            className="atlas-prefill-btn"
            onClick={applyResumePrefill}
            title="根据当前简历的目标岗位、目标城市与期望薪资一键自动填入"
          >
            <Sparkles size={13} />
            <span>参考当前简历自动填入<strong>（{resumePrefill.summaryLabel}）</strong></span>
          </button>
          <div className="atlas-prefill-chips" role="group" aria-label="候选搜索词">
            <span className="atlas-prefill-hint">快捷词：</span>
            {resumePrefill.targetRole && (
              <button
                type="button"
                className={`atlas-chip-btn ${text.trim() === resumePrefill.targetRole.trim() ? "active" : ""}`}
                onClick={() => applyKeywordChip(resumePrefill.targetRole)}
                title={`设为搜索关键词：${resumePrefill.targetRole}`}
              >
                🎯 {resumePrefill.targetRole}
              </button>
            )}
            {resumePrefill.skills.map((skill) => (
              <button
                key={skill}
                type="button"
                className={`atlas-chip-btn ${text.trim() === skill.trim() ? "active" : ""}`}
                onClick={() => applyKeywordChip(skill)}
                title={`设为搜索关键词：${skill}`}
              >
                ⚡ {skill}
              </button>
            ))}
          </div>
        </div>
        {prefillNotice && <p className="atlas-prefill-notice" role="status"><Check size={13} /> {prefillNotice}</p>}
      </div>
    )}
    <form className="atlas-searchbar" onSubmit={(e) => { e.preventDefault(); void searchSourceJobs(); }}><label className="atlas-search"><Search size={18} /><input aria-label="搜索地图岗位" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("关键词、技能或公司", "Role, skill, or company")} /></label>{mode === "domestic" ? <div className="atlas-domestic-region" role="group" aria-label="国内省市区筛选"><span>中国</span><select aria-label="工作省份" value={chinaSelection.provinceCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: e.target.value || undefined })}><option value="">全部省份</option>{getChinaProvinces().map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作城市" disabled={!chinaCities.length} value={chinaSelection.cityCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: chinaSelection.provinceCode, cityCode: e.target.value || undefined })}><option value="">全部城市</option>{chinaCities.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作区县" disabled={!chinaDistricts.length} value={chinaSelection.districtCode ?? ""} onChange={(e) => setChinaSelection({ ...chinaSelection, districtCode: e.target.value || undefined })}><option value="">全部区 / 县</option>{chinaDistricts.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></div> : <><select aria-label="工作国家或地区" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(""); setRegionText(""); }}><option value="">{t("所有国家 / 地区", "All countries / regions")}</option>{countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select><label className="atlas-region-search"><MapPin size={15} /><input aria-label="工作城市或地区关键词" value={regionText} onChange={(e) => { setRegionText(e.target.value); setRegion(""); }} placeholder="城市 / 地区，如北京、Berlin" maxLength={300} /></label></>}<details className="atlas-fetch-options"><summary>获取方式</summary>{searchableSources.length > 0 && <select aria-label="搜索原始来源" value={searchSourceId} onChange={(e) => { searchAbort.current?.abort(); setSearchSourceId(e.target.value); }}><option value="">已配置岗位来源（{searchableSources.length}）</option>{searchableSources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.attribution.label}{entry.remoteFilters.includes("roles") ? " · 实时关键词" : " · 来源岗位"}</option>)}</select>}<select aria-label="来源读取范围" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value as "quick" | "standard" | "deep")}><option value="deep">深度采集 · 遍历全部分页（最多 10~15 页）</option><option value="standard">标准模式 · 采集 3~5 页</option><option value="quick">快速模式 · 采集 1~2 页</option></select><select aria-label="并发同步数量" value={searchConcurrency} onChange={(e) => { const val = Number(e.target.value); setSearchConcurrency(val); try { localStorage.setItem("better-me:atlas-concurrency", String(val)); } catch {} }}><option value={16}>全源同时并发（极速）</option><option value={6}>6 源并发</option><option value={4}>4 源并发</option><option value={2}>2 源并发（排队）</option></select></details><button className="atlas-source-search" type="submit" disabled={sourceSearching || connecting}>{sourceSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}{connected ? "从来源获取岗位" : "连接真实来源搜索"}</button><button type="button" className="atlas-auth-hub-trigger" title="全网平台统一登录与会话接管中心（BOSS直聘 · 猎聘 · 51JOB · 领英）" onClick={() => setAuthHubOpen(true)}><KeyRound size={15} />平台登录态</button><button type="button" aria-expanded={platformSearchOpen} className="atlas-platform-trigger" title="BOSS · 猎聘 · 51 · 领英 · Seek · Indeed · GradConnection · 官网" onClick={() => setPlatformSearchOpen(!platformSearchOpen)}>全网平台</button><button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} />{t("筛选", "Filters")}</button></form>
    {intervenePlatforms.length > 0 && (
      <div className="atlas-intervene-banner" role="alert">
        <div className="atlas-intervene-content">
          <strong><AlertTriangle size={14} /> 检测到【{intervenePlatforms.join("、")}】需要用户在接管浏览器中登录或安全验证</strong>
          <span>商业招聘平台需在已接管的真实 Chrome 窗口中扫码或短信登录一次，本地持久保存后永久复用。</span>
        </div>
        <div className="atlas-intervene-actions">
          <button type="button" className="btn-intervene-open" onClick={() => setAuthHubOpen(true)}>
            <LogIn size={13} />
            <span>打开统一登录中心</span>
          </button>
          <button type="button" className="btn-intervene-focus" onClick={() => void focusRealChrome()}>
            <ExternalLink size={13} />
            <span>置顶 Chrome 扫码</span>
          </button>
          <button type="button" className="btn-intervene-retry" onClick={() => void searchSourceJobs()}>
            <RefreshCw size={13} />
            <span>我已登录，重新检索</span>
          </button>
        </div>
      </div>
    )}
    </div>
    <details className="atlas-more" open={moreOpen || platformSearchOpen || filtersOpen} onToggle={(event) => { const open = event.currentTarget.open; setMoreOpen(open); if (!open) { setPlatformSearchOpen(false); setFiltersOpen(false); } }}>
      <summary>来源说明、聚合与补全</summary>
    <p className="atlas-small atlas-search-scope">输入会实时筛选已收录的 {data?.jobs.length ?? 0} 个岗位底池{text.trim() ? `（当前关键词${scopePlace ? `在${scopePlace}` : ""}命中 ${result?.totalJobs ?? 0} 岗）` : ""}；{connected ? `点击“从已配置官网源获取”查询 ${selectedSearchSources.length} 个海外及企业官网源；查询国内城市职位（如上海的 C#），请使用【全网商业平台聚合】，通过真实 Chrome CDP 极速获取 BOSS直聘、猎聘、51JOB 等平台海量岗位并流式入库点亮地图。` : "连接本机服务后，可同时查询已启用的真实来源。"}读取不超过来源配置额度；详情完整度见逐源状态。</p>
    <div className={`atlas-antibot-feature-card ${platformSearchOpen ? "open" : ""}`} aria-label="全网平台防反爬检索聚合">
      <div className="atlas-antibot-header">
        <div className="atlas-antibot-title">
          <ShieldCheck size={16} className="atlas-shield-icon" />
          <strong>全网商业平台聚合（真实 Chrome CDP 防反爬接管）</strong>
          <span className="atlas-antibot-tag">规避滑块 · 共享原生指纹与登录态</span>
        </div>
        <div className="atlas-antibot-actions">
          <button
            type="button"
            className="atlas-antibot-toggle-btn"
            aria-expanded={platformSearchOpen}
            onClick={() => setPlatformSearchOpen(!platformSearchOpen)}
          >
            {platformSearchOpen ? "收起全网聚合" : "展开全网商业平台聚合（BOSS · 猎聘 · 51JOB · 领英）"}
          </button>
        </div>
      </div>
      <p className="atlas-antibot-desc">
        商业平台（BOSS直聘、猎聘、51JOB 等）普遍具备严格的反爬机制。BetterMe 提供<strong>真实 Chrome 接管能力（CDP 端口 9222）</strong>，运行真实浏览器窗口，具备完全真实的 TLS 握手特征与 Canvas 硬件指纹，并在本地持久化保存账号登录态。不仅能安全规避滑块与 403 拦截，还可直接读取页面岗位卡片，一键批量入库点亮三维地图。
      </p>
    </div>
    <PlatformSearchLinks open={platformSearchOpen} onToggleOpen={setPlatformSearchOpen} keyword={text} regionText={mode === "domestic" ? (chinaFilter.selectedCity?.isGrouping && ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "") ? chinaFilter.selectedProvince?.name : chinaFilter.selectedCity?.name) ?? chinaFilter.selectedProvince?.name ?? "" : regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "")} countryCode={mode === "domestic" ? chinaFilter.workCountryCodes[0] ?? "CN" : country} districtCode={chinaSelection.districtCode} onOpenSingleJob={onOpenOpportunitySources} onReviewCard={(card, capturedAt) => onSaveOpportunity({ token: crypto.randomUUID(), title: card.title, description: `[原站搜索列表卡片摘要，非完整 JD；请打开岗位原文核对]\n${card.cardText}`, sourceUrl: card.url, sourcePlatform: card.platform, collectedAt: capturedAt, sourcePublishedText: card.publicationText })} onIndexCard={(card, receipt, provider) => {
      if (!connected) { setSettings("connection"); setSourceSearchMessage("请先连接本机岗位索引，再核对卡片入库。"); return; }
      const parsed = ReviewedCardsCaptureSchema.safeParse({ provider, pageUrl: receipt.url, capturedAt: receipt.capturedAt, cards: [card] });
      if (!parsed.success) { setSourceSearchError("这张卡片的来源或字段证据不足，未加入索引；请打开原岗位核对。"); return; }
      setCardReview(parsed.data);
    }} onIndexCards={(cards, receipt, provider) => {
      if (!connected) { setSettings("connection"); setSourceSearchMessage("请先连接本机岗位索引，再核对卡片入库。"); return; }
      const parsed = ReviewedCardsCaptureSchema.safeParse({ provider, pageUrl: receipt.url, capturedAt: receipt.capturedAt, cards });
      if (!parsed.success) { setSourceSearchError("卡片数据证据不足，未加入索引；请打开原岗位核对。"); return; }
      setCardReview(parsed.data);
    }} />
    {cardReview && connected && liveData && <Suspense fallback={<p role="status">正在打开卡片核对…</p>}><AtlasReviewedCardImport key={`${cardReview.capturedAt}:${cardReview.cards[0]!.url}`} endpoint={endpoint} token={token} capture={cardReview} revision={liveData.revision} onClose={() => setCardReview(undefined)} onSnapshot={snapshot => {
      searchAbort.current?.abort();
      setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
    }} /></Suspense>}
    {mode === "domestic" && <p className="atlas-small">按省 → 市 → 区县逐级选择，修改上级会清除下级。大陆三级目录采用 2023 统计区划快照，部分末级为镇街/功能区；港澳台保留地区筛选，下级目录待补充。岗位只披露城市时，选择区县会排除位置不明确的岗位。</p>}
    {connected && selectedSearchSources.length > 0 && <details className="atlas-source-limits"><summary>本次实际读取范围 · {selectedSearchSources.length} 个已配置岗位来源（{Math.min(searchConcurrency, selectedSearchSources.length)} 源并发）</summary><ul>{selectedSearchSources.map((entry) => <li key={entry.sourceId}>{entry.attribution.label}：最多 {Math.min(searchDepth === "quick" ? 50 : searchDepth === "deep" ? 2000 : 500, entry.refreshPolicy.maxRecords)} 条 / {Math.min(searchDepth === "quick" ? 2 : searchDepth === "deep" ? 50 : 20, entry.refreshPolicy.maxPages)} 页{entry.options?.fetchDetails === true && typeof entry.options.maxDetailRequestsPerPage === "number" ? `，每页最多 ${entry.options.maxDetailRequestsPerPage} 个详情` : ""}</li>)}</ul><p>这里只查询已配置的岗位来源（企业官网或公开聚合源）。下方原站浏览器搜索独立执行，不计入官网来源回执。</p><button type="button" onClick={() => setSourcesOpen(true)}>管理与扩展来源</button></details>}
    {mode === "domestic" && chinaFilter.selectedDistrict && <p className="atlas-small">原站搜索链接只应用城市范围；区县条件在已收录岗位的位置原文中复核。尚未披露区县不算命中。</p>}
    <AtlasSearchProgress progress={searchProgress} busy={sourceSearching} onCancel={() => searchAbort.current?.abort()} onReviewSource={setSourceReview} />
    {sourceReview?.receipt && reviewSource && <Suspense fallback={<p role="status">正在加载来源候选核对…</p>}><AtlasSourceCandidateReview key={`${sourceReview.receipt.run.runId}:${endpoint}`} endpoint={endpoint} token={token} source={reviewSource} request={{ scope: sourceReview.receipt.localFilters, maxRecords: sourceReview.receipt.run.scope.maxRecords }} onClose={() => setSourceReview(undefined)} onReview={onSaveOpportunity} /></Suspense>}
    {sourceSearchMessage && <p role="status" className="atlas-search-notice">{sourceSearchMessage}</p>}
    {sourceSearchError && <p role="alert" className="atlas-error">{sourceSearchError}</p>}
    <div className="atlas-coverage" aria-label="当前索引筛选覆盖"><span>当前视图 {coverage.totalJobs} 岗{text.trim() || chinaFilter.selectedProvince || country ? `（命中 ${result?.totalJobs ?? 0} 岗）` : ""}</span><span>国家/地区 {coverage.country.jobs} 岗</span><span>可比较年薪 {coverage.salary.jobs} 岗</span><span>可计算距离 {coverage.distance.jobs} 岗</span><span>已核实企业性质 {coverage.ownership.jobs} 岗</span><span>已定位 {coverage.map.jobs} 岗</span></div>
    {filtersOpen && <div className="atlas-filters">
      {mode === "global" && <label>工作地区<select aria-label="筛选工作地区" disabled={!regions.length && !region} value={region} onChange={(e) => { setRegion(e.target.value); setRegionText(""); }}><option value="">全部地区</option>{regions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.jobs} 岗</option>)}</select>{!regions.length && <small>当前没有已收录地区选项；可在上方输入城市，再从来源获取。</small>}</label>}
      <label>企业性质<select aria-label="筛选企业性质" value={ownership} disabled={!coverage.totalJobs} onChange={(e) => setOwnership(e.target.value)}><option value="">全部性质</option>{[["private", "民营 / 私有控股"], ["state", "国有控股"], ["joint", "合资 / 共同控制"], ["dispersed", "分散持股"]].map(([id, label]) => <option key={id} value={id} disabled={!coverage.ownership.values.includes(id!)}>{label}</option>)}<option value="unknown">待核实</option></select>{!coverage.ownership.supported && <small>尚无已核实性质，可查看待核实岗位。</small>}</label>
      <label>控股方国家 / 地区<select value={origin} disabled={!coverage.totalJobs} onChange={(e) => setOrigin(e.target.value)}><option value="">全部来源</option>{foreignOrigins.length > 0 && <option value="FOREIGN_ALL">外企（全部境外控股）</option>}{origins.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}<option value="unknown">待核实</option></select>{!coverage.controller.supported && <small>缺控股来源证据，不能按品牌或工作地点猜测。</small>}</label>
      <label>岗位信息源<select aria-label="筛选岗位信息源" disabled={!coverage.source.supported && !source} value={source} onChange={(e) => setSource(e.target.value)}><option value="">全部来源</option>{coverage.source.options.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.jobs} 岗</option>)}</select></label>
      <label>最低年薪（万元 CNY）<input type="number" min="0" disabled={!coverage.salary.supported && !salaryMin} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} />{!coverage.salary.supported && <small>{coverage.salary.fxBlockedJobs ? "缺有效汇率，当前薪资无法换算。" : "暂无可比较的税前固定年薪。"}</small>}</label>
      <label>最高年薪（万元 CNY）<input type="number" min="0" disabled={!coverage.salary.supported && !salaryMax} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} /></label>
      <label>离家不超过（km）<input type="number" min="0" max="40100" disabled={(!coverage.distance.ready && !maxKm)} value={maxKm} onChange={(e) => setMaxKm(e.target.value)} placeholder={!coverage.distance.supported ? "岗位尚无可用坐标" : anchor ? "不限制" : "先设置参照点"} /><small>{!coverage.distance.supported ? "需岗位位置证据；仅有城市原文不能计算距离。" : !anchor ? "先设置家庭参照点。" : `${coverage.distance.jobs} 岗可计算；城市中心会标估算。`}</small></label>
      <button onClick={resetFilters}>清除筛选</button>
      {mode === "domestic" && <label className="atlas-unknown-toggle"><input type="checkbox" checked={includeUnclassified && !chinaFilter.selectedProvince} disabled={Boolean(chinaFilter.selectedProvince)} onChange={(e) => setIncludeUnclassified(e.target.checked)} />{chinaFilter.selectedProvince ? "已选行政范围，只匹配明确披露国家/地区的岗位" : `国内视图包含国家/地区待核实岗位（${coverage.country.missingJobs}）`}</label>}
    </div>}
    {connected && dataMode === "live" && visibleItems.length > 0 && <div className="atlas-enrichment-entry"><span>当前页 {visibleItems.length} 条，筛选共 {bucket?.jobCount ?? result?.totalJobs ?? 0} 个岗位（全库 {data?.jobs.length ?? coverage.totalJobs}）。地图只标有来源坐标的岗位。</span><button type="button" onClick={() => { cancelOfficeFocus(); setDetailReviewJobId(""); setEnrichmentScope(visibleItems.slice(0, 50).map(item => item.job.id)); }}><MapPin size={14} />补全当前结果办公地点</button><button type="button" disabled={sourceSearching} onClick={() => void enrichCurrentIndex()}><Sparkles size={14} />智能核实企业性质与办公坐标</button><small>本次最多 50 个已显示结果；读取前可核对范围，不自动保存候选坐标。</small></div>}
    {queryError && <p className="atlas-error" role="alert">{queryError}</p>}
    {mapReferences.loading && <p className="atlas-small" role="status"><Loader2 size={14} className="animate-spin" /> 正在读取城市分布参考，岗位列表可继续使用… <button type="button" onClick={mapReferences.cancel}>取消地图参考读取</button></p>}
    {mapReferences.error && <p className="atlas-small" role="status">{mapReferences.error} <button type="button" onClick={mapReferences.retry}>重新读取城市参考</button></p>}
    {mapReferences.result && <div className="atlas-small" aria-label="城市参考数据来源">城市分布采用离线地名数据，保留来源岗位地点；不确认办公地址。{mapReferences.result.provenance?.attribution}{mapReferences.result.truncated && ` · 本次只处理 ${mapReferences.result.processedLocations}/${mapReferences.result.totalLocations} 个地点，未处理地点仍待定位。`}{mapReferences.result.warnings.length > 0 && <details><summary>城市参考范围与提示</summary><ul>{mapReferences.result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}</div>}
    </details>
    <div className={`atlas-main-grid ${(selected && data) || detailReviewJobId || enrichmentScope ? "has-detail" : ""} ${emptyIndex ? "is-empty-index" : ""}`}><div className="atlas-map-column"><div className={`atlas-map-card ${theme}`}><div className="atlas-map-top"><div className="atlas-mode-switch" role="group" aria-label="地图范围"><button aria-pressed={mode === "global"} className={mode === "global" ? "active" : ""} onClick={() => changeMapMode("global")}><Globe2 size={15} />{t("全球", "Global")}</button><button aria-pressed={mode === "domestic"} className={mode === "domestic" ? "active" : ""} onClick={() => changeMapMode("domestic")}><MapPin size={15} />{t("国内", "China")}</button></div><span>{mapLevel === "location" ? "STREET & ADDRESS" : "3D EXPLORER"} <i /></span></div><div className="atlas-scene" ref={scene}>{active && <Suspense fallback={<div className="atlas-map-loading"><Loader2 className="animate-spin" />正在加载三维地图…</div>}><AtlasMap key={mapKey} mode={mode} basemap={basemapId === "offline" ? null : basemapId === "auto" ? undefined : ATLAS_BASEMAPS.find((p) => p.id === basemapId)} buckets={locatedBuckets} bounds={displayFrame?.bounds} boundsMaxZoom={displayFrame?.maxZoom} adminBoundary={adminBoundary} selectedBucketId={bucket?.id} selectedRegionId={mode === "domestic" ? chinaFilter.selectedProvince?.mapId : region || country || undefined} initialView={camera.current} focus={focus} selectedJobId={selectedId} visual={{ autoRotate: rotating, maxDpr: 1.5, pedestal: true, entrance: true, theme }} onViewChange={(view) => { camera.current = view; setMapZoom(previous => (previous >= 10) === (view.zoom >= 10) ? previous : view.zoom); }} onPick={setBucket} onCountry={(pick) => { if (mode === "domestic") { const province = findChinaProvinceByMapId(pick.id); if (province) setChinaSelection({ provinceCode: province.code }); else setSourceSearchMessage("该区域尚未纳入当前国内行政目录，请按来源披露地点查询。"); } else if (pick.countryCode) { setCountry(pick.countryCode); setRegion(""); setRegionText(""); } }} onError={(error) => setMapError(error.message)} /></Suspense>}</div><div className="atlas-map-caption"><div><span className="atlas-eyebrow">{mode === "global" ? "A WORLD OF POSSIBILITIES" : "CLOSER TO YOUR NEXT CHAPTER"}</span><strong>{mode === "global" ? t("机会，不止一座城。", "Your next role could be anywhere.") : t("在熟悉的土地，发现新可能。", "A new perspective, closer to home.")}</strong><small>拖动旋转 · 连续缩放至街道 · 城市中心与精确地址分开标注</small></div><div className="atlas-map-controls"><button aria-label="重置地图视角" title="重置视角" onClick={resetCamera}><Compass size={17} /></button><button aria-pressed={rotating} onClick={() => setRotating(!rotating)}>{rotating ? "暂停旋转" : "自动旋转"}</button></div></div>{mapError && <div role="alert" className="atlas-render-error">三维地图暂不可用：{mapError}。岗位列表仍可使用。<button onClick={() => { setMapKey((k) => k + 1); setMapError(""); }}>重试</button></div>}</div>
      <div className="atlas-map-footer"><div className="atlas-stat-grid" aria-live="polite">{[[result?.totalJobs ?? 0, "匹配岗位"], [result?.companyCount ?? 0, "企业"], [result?.mappedJobs ?? 0, "有来源坐标"], [result?.unlocatedJobs ?? 0, "待定位岗位"]].map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</div></div></div>
      <aside className="atlas-results">
        <div className="atlas-results-heading">
          <div className="atlas-results-heading-left">
            <span className="atlas-eyebrow">YOUR OPPORTUNITY RADAR</span>
            <h2>
              {bucket ? bucket.label : t("探索机会", "Explore opportunities")}{" "}
              <span>{bucket ? bucket.jobCount : result?.totalJobs ?? 0}</span>
            </h2>
          </div>
          <div className="atlas-results-heading-actions">
            {querying && <Loader2 size={16} className="animate-spin text-emerald-500" />}
            {bucket && (
              <button
                type="button"
                className="atlas-city-clear-btn"
                aria-label="取消城市选择"
                onClick={() => setBucket(null)}
                title="返回全部城市"
              >
                <X size={13} />
                <span>清除城市</span>
              </button>
            )}
            <button
              type="button"
              className={`atlas-filter-toggle-btn ${filtersCollapsed ? "is-collapsed" : "is-expanded"}`}
              onClick={() => setFiltersCollapsed((prev) => !prev)}
              aria-expanded={!filtersCollapsed}
              title={filtersCollapsed ? "展开多维筛选条件" : "收起多维筛选条件"}
            >
              <SlidersHorizontal size={13} />
              <span>{filtersCollapsed ? "展开筛选" : "收起筛选"}</span>
              {activeFilterCount > 0 && (
                <span className="atlas-filter-count-badge">{activeFilterCount}</span>
              )}
              {filtersCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
          </div>
        </div>

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
              onClick={resetFilters}
              title="重置所有筛选"
            >
              <RotateCcw size={11} />
              重置
            </button>
          </div>
        )}

        <div className={`atlas-quick-filters ${filtersCollapsed ? "is-collapsed" : ""}`} role="group" aria-label="岗位多维快捷筛选">
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
                    setSettings("home");
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
              onClick={() => setSettings("home")}
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
                onClick={resetFilters}
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
            <span className="atlas-filter-label is-ai"><Sparkles size={11} />穿透</span>
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
                仅看 AI 穿透命中 ({penetratedCount})
              </button>
            </div>
          </div>
        )}
      </div>
      {text.trim() && sourceSearching && (
        <div className="atlas-local-cache-banner live-searching" role="status">
          <div className="atlas-local-cache-info">
            <Loader2 size={15} className="text-emerald-500 animate-spin shrink-0" />
            <div className="atlas-local-cache-text-col">
              <span>
                {harvestStage ? (
                  <>
                    <strong className="text-emerald-600">[{harvestStage.index}/{harvestStage.total} 流水线]</strong> {harvestStage.message}
                  </>
                ) : (
                  <>
                    正在<strong>全网商业平台（BOSS直聘 · 51Job · 猎聘 · 领英）</strong>多路并发极速抓取…
                  </>
                )}
              </span>
              {harvestStage && (
                <div className="atlas-live-harvest-progress-bar">
                  <div
                    className="atlas-live-harvest-progress-fill"
                    style={{ width: `${Math.max(15, (harvestStage.index / harvestStage.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="atlas-local-cache-btn"
            disabled
          >
            <Loader2 size={13} className="animate-spin" />
            正在抓取入库…
          </button>
        </div>
      )}
      {text.trim() && !sourceSearching && penetratedCount > 0 && !aiBannerDismissed && (
        <div className="atlas-ai-penetration-banner" role="status">
          <div className="atlas-ai-banner-header">
            <div className="atlas-ai-banner-badge-group">
              <span className="atlas-ai-badge-pill">
                <Sparkles size={11} className="atlas-ai-sparkle-icon" />
                AI 穿透定位
              </span>
              <span className="atlas-ai-banner-headline">
                识别到 <strong>{penetratedCount}</strong> 个高契合通用标题岗位
              </span>
            </div>
            <button
              type="button"
              className="atlas-ai-banner-close-btn"
              onClick={() => setAiBannerDismissed(true)}
              title="收起此提示（可在上方筛选器恢复）"
              aria-label="收起 AI 穿透提示"
            >
              <X size={13} />
            </button>
          </div>
          <div className="atlas-ai-banner-footer">
            <span className="atlas-ai-banner-desc">
              标题通用（如“软件工程师/上位机”），但 JD 任职要求明确包含 “<strong>{text.trim()}</strong>” 核心技术栈
            </span>
            <div className="atlas-ai-banner-actions">
              <button
                type="button"
                className={`atlas-ai-filter-toggle-btn ${aiPenetratedOnly ? "active" : ""}`}
                onClick={() => setAiPenetratedOnly((prev) => !prev)}
              >
                <Sparkles size={11} className="atlas-ai-sparkle-icon" />
                {aiPenetratedOnly ? "恢复全部岗位" : `仅看 AI 穿透岗位 (${penetratedCount})`}
              </button>
              <button
                type="button"
                className="atlas-compact-refresh-btn"
                onClick={() => void searchLivePlatformsOnly()}
                title="通过真实 Chrome CDP 极速获取全网商业平台岗位并自动入库点亮地图"
              >
                <RefreshCw size={11} />
                全网重搜
              </button>
            </div>
          </div>
        </div>
      )}
      {text.trim() && !sourceSearching && (penetratedCount === 0 || aiBannerDismissed) && (
        <div className="atlas-local-cache-banner" role="status">
          <div className="atlas-local-cache-info">
            <Globe2 size={15} className="text-emerald-500 shrink-0" />
            <div className="atlas-local-cache-text-col">
              <span>
                已同步全网平台真实岗位（当前命中 <strong>{bucket ? bucket.jobCount : result?.totalJobs ?? 0}</strong> 岗 / 库内总计 {data?.jobs.length ?? 0} 岗）。
              </span>
            </div>
          </div>
          <div className="atlas-local-cache-actions">
            {penetratedCount > 0 && aiBannerDismissed && (
              <button
                type="button"
                className="atlas-compact-refresh-btn"
                onClick={() => setAiBannerDismissed(false)}
                title="展开 AI 穿透定位提示"
              >
                <Sparkles size={11} className="text-indigo-500" />
                AI 穿透 ({penetratedCount})
              </button>
            )}
            <button
              type="button"
              className="atlas-local-cache-btn"
              disabled={sourceSearching}
              onClick={() => void searchLivePlatformsOnly()}
              title="通过真实 Chrome CDP 极速获取全网商业平台岗位并自动入库点亮地图"
            >
              <RefreshCw size={13} />
              全网重新抓取
            </button>
          </div>
        </div>
      )}
      <details className="atlas-sort-fold"><summary>{sort === "relevance" ? "相关度" : sort === "salary" ? "年薪" : sort === "distance" ? "距离" : "更新"} · {direction === "desc" ? "降序" : "升序"}</summary><div className="atlas-sort"><select aria-label="岗位排序" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="salary" disabled={!coverage.salary.sortSupported}>人民币税前年薪下限{!coverage.salary.sortSupported ? " · 暂无可比数据" : ""}</option><option value="distance" disabled={!coverage.distance.ready}>离家直线距离{!coverage.distance.supported ? " · 缺岗位坐标" : !anchor ? " · 请设参照点" : ""}</option><option value="updated">最近更新</option></select><button aria-label={direction === "desc" ? "当前降序，切换升序" : "当前升序，切换降序"} onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}><ArrowDownUp size={14} />{direction === "desc" ? "降序" : "升序"}</button><label><input type="checkbox" checked={originalCurrency} onChange={(e) => setOriginalCurrency(e.target.checked)} />原币</label><select aria-label="每页条数" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}><option value={30}>每页 30 岗</option><option value={50}>每页 50 岗</option><option value={100}>每页 100 岗</option><option value={200}>每页 200 岗</option></select></div></details><div className="atlas-job-list" aria-busy={querying || sourceSearching}>{(querying || sourceSearching) && !visibleItems.length && <div className="atlas-results-loading" role="status"><span>{sourceSearching ? "正在从真实来源获取岗位…" : "正在匹配岗位…"}</span>{[0, 1, 2].map((n) => <div key={n} className="atlas-skeleton-card" aria-hidden="true"><i /><i /><i /></div>)}</div>}{visibleItems.map((item) => {
  const presentations = presentListing?.(item) ?? [];
  const platformLabel = formatCardPlatform(item);
  const pubBadge = formatCardPublication(item, presentations, data);
  const distanceBadge = formatCardDistance(item, Boolean(anchor));
  const salaryBadge = formatCardSalaryRMB(item);
  const aiRelevance = analyzeAiJobRelevance(item.job, text, item.company.names[0]);

  return (
    <button
      key={item.job.id}
      className={`atlas-job-card ${selectedId === item.job.id ? "selected" : ""}`}
      aria-expanded={selectedId === item.job.id}
      aria-controls="atlas-job-detail"
      onClick={(event) => clickJob(item, event.detail)}
      onDoubleClick={() => { cancelCardClick(); void locateJob(item); }}
    >
      <span className="atlas-company-line">
        <i style={{ background: item.color.color }} />
        {item.company.names[0]}
        <ArrowUpRight size={14} />
      </span>
      <strong>{item.job.title.value}</strong>
      {aiRelevance.isPenetrated && (
        <div className="atlas-ai-penetration-tag" title={aiRelevance.reason}>
          <span className="atlas-ai-badge-pill">
            <Sparkles size={11} className="atlas-ai-sparkle-icon" />
            AI 穿透命中
          </span>
          <span className="atlas-ai-skill-text">{aiRelevance.highlightSkillText}</span>
          {aiRelevance.highlightSnippet && (
            <span className="atlas-ai-evidence-pill" title={aiRelevance.highlightSnippet}>
              任职要求明确
            </span>
          )}
        </div>
      )}
      <span className="atlas-job-meta">
        <MapPin size={12} />
        {item.locations.map((l) => l.officeResolution?.formattedAddress ?? l.streetAddress ?? l.city ?? l.raw).join(" / ") || "地点待核实"}
      </span>
      <span
        className={`atlas-job-salary ${salaryBadge.isNegotiable ? "is-negotiable" : "has-salary"}`}
        title={salaryBadge.tooltip}
      >
        {salaryBadge.label}
      </span>
      <div className="atlas-job-card-tags">
        <span className="atlas-job-classification" style={{ borderColor: `${item.color.color}66` }}>
          <i style={{ background: item.color.color }} />
          {item.color.label} {item.color.classification.jurisdictions.map(countryName).join(" / ")}
        </span>
        <span className="atlas-badge-platform" title={`来源平台：${platformLabel}`}>
          {platformLabel}
        </span>
        <span className="atlas-badge-publication" title={pubBadge.tooltip}>
          {pubBadge.label}
        </span>
        <span className="atlas-badge-distance" title={distanceBadge.tooltip}>
          {distanceBadge.label}
        </span>
      </div>
      <AtlasListingBadges presentations={presentations} />
      {!!item.mapReferences?.length && <span className="atlas-card-hint">城市分布参考 · 城市估算，非办公地址</span>}
      <span className="atlas-card-hint">单击查看详情 · 双击定位地图</span>
    </button>
  );
})}{!visibleItems.length && !querying && !sourceSearching && (
  Boolean((text.trim() || chinaFilter.selectedProvince || regionText.trim() || country) && !emptyIndex && data) ? (
    <AtlasLivePlatformQuickSearch
      keyword={text}
      regionText={mode === "domestic" ? (chinaFilter.selectedCity?.isGrouping && ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "") ? chinaFilter.selectedProvince?.name : chinaFilter.selectedCity?.name) ?? chinaFilter.selectedProvince?.name ?? "" : regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "")}
      countryCode={mode === "domestic" ? chinaFilter.workCountryCodes[0] ?? "CN" : country}
      onLiveCaptureNow={() => void searchLivePlatformsOnly()}
      liveCapturing={sourceSearching}
      onOpenAggregator={() => {
        setPlatformSearchOpen(true);
        if (typeof document !== "undefined") {
          setTimeout(() => {
            const el = document.querySelector(".atlas-platform-search");
            el?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 80);
        }
      }}
      onResetFilters={resetFilters}
      broaderMatches={broaderCounts ? {
        domesticCount: broaderCounts.domestic,
        globalCount: broaderCounts.global,
        onExpandDomestic: () => {
          setMode("domestic");
          setChinaSelection({});
          setSalaryMin("");
          setSalaryMax("");
        },
        onExpandGlobal: () => {
          setMode("global");
          setCountry("");
          setRegion("");
          setRegionText("");
          setChinaSelection({});
          setSalaryMin("");
          setSalaryMax("");
        },
      } : undefined}
      resumePrefill={resumePrefill.hasResumeData ? {
        hasResumeData: true,
        summaryLabel: resumePrefill.summaryLabel,
        apply: applyResumePrefill,
      } : undefined}
    />
  ) : (
    <div className="atlas-empty"><Search size={24} /><strong>{dataLoading ? "正在读取岗位…" : emptyIndex ? "先把真实岗位接入地图" : !data && dataMode === "live" ? "连接本机索引，查看已采集岗位" : "暂未找到匹配岗位"}</strong><p>{dataLoading ? "读取完成后会显示当前数据范围。" : emptyIndex ? "当前数据集还没有岗位。连接本机采集索引，或读取并收藏招聘原文；办公室地址会按来源逐岗补全。" : !data && dataMode === "live" ? "当前尚未取得本机岗位数据，请检查连接。" : "当前已收录数据没有匹配项。企业官网（如 ABB、Bosch）常因海外网络或配额限制无法返回国内岗位；推荐使用下方【全网商业平台聚合】，通过真实 Chrome CDP 接管规避反爬。"}</p><div className="atlas-empty-actions">{resumePrefill.hasResumeData && <button type="button" className="atlas-empty-btn-prefill" onClick={applyResumePrefill}><Sparkles size={14} /> 参考当前简历自动填入（{resumePrefill.summaryLabel}）</button>}<button type="button" className="atlas-empty-btn-platform" onClick={() => setPlatformSearchOpen(true)}><ShieldCheck size={14} /> 展开全网商业平台防反爬检索（BOSS · 猎聘 · 51 · 领英）</button></div>{!dataLoading && (emptyIndex || !data) ? <><button onClick={() => connected ? void searchSourceJobs() : setSettings("connection")}>{connected ? searchableSources.length ? "从已配置来源获取岗位" : "配置岗位来源" : "连接真实来源搜索"}</button>{onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>读取并收藏单个岗位</button>}<ol><li>连接本机采集索引</li><li>搜索岗位并补全工作地点</li><li>单击阅读 · 双击定位</li></ol></> : !dataLoading && <button onClick={resetFilters}>清除筛选</button>}</div>
  )
)}{resultData === data && (listPage?.totalJobs ?? 0) > pageSize && <nav className="atlas-pager" aria-label="岗位分页"><button type="button" disabled={pageIndex === 0 || querying} onClick={() => setPageIndex((index) => Math.max(0, index - 1))}>上一页</button><span>第 {pageIndex * pageSize + 1}–{pageIndex * pageSize + visibleItems.length} 条，共 {listPage?.totalJobs ?? 0} 条</span><button type="button" disabled={querying || (pageIndex + 1) * pageSize >= (listPage?.totalJobs ?? 0)} onClick={() => setPageIndex((index) => index + 1)}>下一页</button></nav>}</div><details className="atlas-list-note"><summary>薪资比较口径</summary><p>统一比较税前固定年薪，奖金与股票不混入。未知薪资、缺少有效汇率和未知距离放在排序末尾。{result?.unknownSalaryCount ?? 0} 个岗位薪资暂不可比较。</p></details></aside>
    {!emptyIndex && !selected && !detailReviewJobId && !enrichmentScope && layout === "wide" && <aside className="atlas-detail-placeholder" aria-label={t("岗位阅读面板", "Job reading pane")}><MapPin size={27} /><strong>{t("选择一个岗位，展开下一步。", "Select a role to explore the details.")}</strong><p>{t("单击阅读岗位原文与工作地址，双击在地图中定位。", "Click to read the posting and work address; double-click to locate it on the map.")}</p><small>{t("具体办公位置以来源披露或本人核对为准。", "Office locations follow source disclosures or your explicit review.")}</small></aside>}
    {active && enrichmentScope && connected && dataMode === "live" && liveData && <aside id="atlas-job-detail" className="atlas-job-detail atlas-enrichment-detail" aria-label="岗位办公地点批量核对面板"><div className="atlas-job-detail-body"><Suspense fallback={<p role="status">正在打开办公地点补全…</p>}><AtlasAddressEnrichment endpoint={endpoint} token={token} data={liveData} jobIds={enrichmentScope} onClose={() => { cancelOfficeFocus(); setEnrichmentScope(null); }} onSnapshot={snapshot => { setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); }} onReviewJob={jobId => {
      setEnrichmentScope(null);
      const item = listItems.find(entry => entry.job.id === jobId);
      if (item) openJob(item);
      if (liveData.jobs.find(job => job.id === jobId)?.listingIds.some(id => liveData.listings.find(listing => listing.id === id)?.sourceId.startsWith("reviewed-platform-"))) setDetailReviewJobId(jobId);
      else setSourcesOpen(true);
    }} onOfficeSnapshot={(snapshot, location, jobId) => {
      if (liveData.revision > snapshot.revision) return;
      setOfficeFocusRequest({ id: crypto.randomUUID(), jobId, locationId: location.id, snapshot, selectionKey, endpoint, token });
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`办公位置已读取，索引版本 ${snapshot.revision}。符合当前筛选时会定位高亮，也可双击岗位再次定位。`);
    }} onReviewOffice={(jobId, locationId) => {
      const location = liveData.locations.find(entry => entry.id === locationId);
      const item = listItems.find(entry => entry.job.id === jobId);
      if (location && item) { setEnrichmentScope(null); openJob(item); setOfficeReview({jobId, location}); }
    }} /></Suspense></div></aside>}
    {!enrichmentScope && detailReviewJobId && active && connected && liveData && <aside id="atlas-job-detail" className="atlas-job-detail atlas-address-detail" aria-label="岗位办公地址核对面板"><div className="atlas-job-detail-body"><Suspense fallback={<p role="status">正在打开原岗位地址核对…</p>}><AtlasDetailLocations key={`${detailReviewJobId}:${endpoint}:${token}`} endpoint={endpoint} token={token} data={liveData} jobId={detailReviewJobId} onClose={() => { cancelOfficeFocus(); setDetailReviewJobId(""); }} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`来源地点已读取，索引版本 ${snapshot.revision}。可在核对面板继续确认具体办公位置。`);
    }} onOfficeSnapshot={(snapshot, location) => {
      if (liveData.revision > snapshot.revision) return;
      setOfficeFocusRequest({ id: crypto.randomUUID(), jobId: detailReviewJobId, locationId: location.id, snapshot, selectionKey, endpoint, token });
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`办公位置已读取，索引版本 ${snapshot.revision}。符合当前筛选时会定位高亮，也可双击岗位再次定位。`);
    }} /></Suspense></div></aside>}
    {!enrichmentScope && !detailReviewJobId && selected && data && <AtlasJobDetail key={selected.job.id} item={selected} data={data} searchQuery={text} demo={dataMode === "demo"} originalCurrency={originalCurrency} presentations={presentListing?.(selected) ?? []} onClose={closeJob} onLocate={(locationId) => void locateJob(selected, locationId)} onSave={() => routeJob(selected, false)} onAnalyze={() => routeJob(selected, true)} onConfirmLocation={connected ? location => { setOfficeReview(undefined); setLocationReview({ jobId: selected.job.id, location }); } : undefined} onConfirmOffice={connected ? location => { setLocationReview(undefined); setOfficeReview({ jobId: selected.job.id, location }); } : undefined} onReadLocations={connected && selected.job.listingIds.some(id => data.listings.find(listing => listing.id === id)?.sourceId.startsWith("reviewed-platform-")) ? () => setDetailReviewJobId(selected.job.id) : undefined}>
      {locationReview?.jobId === selected.job.id && connected && liveData && <Suspense fallback={<p role="status">正在打开地区核对…</p>}><AtlasLocationConfirmation key={`${locationReview.jobId}:${locationReview.location.id}:${endpoint}`} endpoint={endpoint} token={token} jobId={locationReview.jobId} location={locationReview.location} revision={liveData.revision} onClose={() => setLocationReview(undefined)} onSnapshot={snapshot => {
        searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
        setSourceSearchMessage(`已读取地区记录，索引版本 ${snapshot.revision}。当前筛选会按最新确认结果重新计算；不再符合条件的岗位会退出列表。`);
      }} /></Suspense>}
      {officeReview?.jobId === selected.job.id && active && connected && liveData && <Suspense fallback={<p role="status">正在打开办公地址核对…</p>}><AtlasOfficeAddressConfirmation key={`${officeReview.jobId}:${officeReview.location.id}:${endpoint}:${token}`} endpoint={endpoint} token={token} jobId={officeReview.jobId} location={officeReview.location} revision={liveData.revision} onClose={() => setOfficeReview(undefined)} onSnapshot={snapshot => {
        if (liveData.revision > snapshot.revision) return;
        setOfficeFocusRequest({ id: crypto.randomUUID(), jobId: officeReview.jobId, locationId: officeReview.location.id, snapshot, selectionKey, endpoint, token });
        searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
        setSourceSearchMessage(`已读取办公地址记录，索引版本 ${snapshot.revision}。地图将使用最新有效位置，来源未披露的地址仍待核对。`);
      }} /></Suspense>}
      {locationChoices === selected.job.id && <div className="atlas-location-candidates" aria-label="选择要定位的工作地点"><p>该岗位披露多个地点，请选择本次要定位的办公地点。</p>{selected.locations.filter(location => location.kind === "office").map(location => <button type="button" key={location.id} onClick={() => void locateJob(selected, location.id)}><MapPin size={14} />{location.officeResolution?.formattedAddress ?? location.streetAddress ?? location.raw}</button>)}</div>}
      {locationSearch?.jobId === selected.job.id && <div className="atlas-location-candidates" aria-label="城市定位候选">
        {locationSearch.loading && <p role="status"><Loader2 size={15} className="animate-spin" /> 正在查询本地地名库…</p>}
        {locationSearch.error && <p role="status">{locationSearch.error}</p>}
        {locationSearch.result && <><p>来源没有办公坐标。请选择城市参考点，仅用于本次地图浏览；不会写入岗位地址。</p>{locationSearch.result.candidates.map((candidate) => <button key={candidate.id} onClick={() => chooseLocationCandidate(candidate)}><MapPin size={14} />{candidate.matchedName} · {countryName(candidate.place.countryCode)} · {Object.values(candidate.place.administrativeCodes).join(" / ")}<small>城市估算 · 非办公地址</small></button>)}{!locationSearch.result.candidates.length && <p>在当前国家 / 地区范围没有找到明确候选，请打开原文核对地点。</p>}<small>{locationSearch.result.candidates[0]?.evidence.provenance.attribution}</small></>}
      </div>}
    </AtlasJobDetail>}
    </div>
    <div className="atlas-map-notes">
      <p className="atlas-small" aria-label="地图位置口径">有来源坐标 {result?.mappedJobs ?? 0} 岗，待定位 {result?.unlocatedJobs ?? 0} 岗。地图上的点只来自这些岗位的来源坐标，与当前筛选一致；没有坐标的岗位留在列表里，不使用城市估算补点。</p>
      <div className="atlas-legend"><div className="atlas-legend-title"><strong>企业控股来源</strong><button onClick={() => setSettings(settings === "colors" ? null : "colors")}><Palette size={14} />配置颜色</button></div><div>{colors.rules.map((r) => <span key={r.id}><i style={{ background: r.color }} />{r.label}</span>)}<span><i style={{ background: colors.defaultColor }} />待核实</span></div></div>
      <p className="atlas-footnote">Natural Earth 概略边界 · OpenFreeMap / OpenStreetMap 街道 · WGS84 · 地图展示来源位置，并区分城市估算与办公地址，远程资格不作为办公地址。国内行政分组用于展示；本地图不用于正式测绘。多地点岗位可有多个标记，统计按岗位去重。</p>
    </div>

    <PlatformAuthHub
      isOpen={authHubOpen}
      onClose={() => setAuthHubOpen(false)}
      onRefreshSearch={() => void searchSourceJobs()}
    />
  </section>;
}
