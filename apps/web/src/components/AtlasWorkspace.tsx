import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronUp, Database, ExternalLink, Filter, Globe2, Home, KeyRound, Loader2, LogIn, MapPin, Palette, RefreshCw, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { FactBase, LlmConfig, ProjectedResume } from "@better-me/core";
import { extractResumePrefill } from "./atlas/resume-prefill";
import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, normalizeSearchText, DEFAULT_TECHNICAL_ALIASES, type AtlasDataset, type CompanyColorConfig, type JobLocation, type JobQueryInput, type JobQueryResult, type JobSearchItem, type MapBucket, type QueryOptions, type GeocodingResult, type GeocodingCandidate } from "@better-me/opportunities";
import type { OpportunitySeed } from "./OpportunityWorkspace";
import { createAtlasDemo } from "./atlas/demo";
import type { AtlasCamera } from "./atlas/prototypes/types";
import { isMappableOfficeBucket, mapBucketPrecisionLabel } from "./atlas/prototypes/map-performance";
import type { AtlasMapGeometry } from "./atlas/prototypes/map-performance";
import { ATLAS_BASEMAPS } from "./atlas/prototypes/basemaps";
import { buildAtlasJobAction, queryAtlasPage, readAtlasSnapshot, type AtlasJobAction } from "./atlas/client";
import { AtlasBaselineStatus } from "./atlas/AtlasBaselineStatus";
import type { BaselineProgress } from "../../../job-service/src/dataset-baseline-contract";
import { shouldAutoReconnectAtlas } from "./atlas/connection-recovery";
import { AtlasActivityRail } from "./atlas/AtlasActivityRail";
import { AtlasSettingsDialog } from "./atlas/AtlasSettingsDialog";
import { AtlasToolbarMenu } from "./atlas/AtlasToolbarMenu";
import { AtlasIllustration } from "./atlas/AtlasIllustration";
import { AtlasJobCardContent } from "./atlas/AtlasJobCardContent";
import type { AtlasViewMode } from "./atlas/AtlasViewControls";
import { AtlasMapToolbar } from "./atlas/AtlasMapToolbar";
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
import { AtlasWorkbench } from "./atlas/AtlasWorkbench";
import { createJobMapFocus, type AtlasMapFocus } from "./atlas/map-focus";
import { frameAdminRegion, frameSearchMap } from "./atlas/map-frame";
import { buildAtlasCityCandidateQuery } from "./atlas/city-candidate-query";
import { useComputedAtlasMetadata } from "./atlas/use-computed-metadata";
import { createAtlasListingPresenter } from "./atlas/presentation";
import { readRuntimeConnection } from "../lib/runtime-connection";
import {
  matchCardPlatform,
  matchCardSalary,
  matchCardDistance,
  matchCardPublication,
} from "./atlas/card-badges";
import { analyzeAiJobRelevance } from "./atlas/ai-job-relevance";
import { PlatformSearchLinks } from "./atlas/PlatformSearchLinks";
import { AtlasLivePlatformQuickSearch } from "./atlas/AtlasLivePlatformQuickSearch";
import type { LivePlatformImportSummary } from "./atlas/live-platform-auto-import";
import { executeOpportunityHarvestChainedPipeline, type ClientPipelineProgress } from "./atlas/harvest-pipeline";
import { AtlasLiveHarvestResults } from "./atlas/AtlasLiveHarvestResults";
import { applyLiveBatchStreamEvent, buildLiveHarvestView, liveHarvestStopReasonLabel, matchesLiveHarvestQuery, mergeLiveHarvestViews, settleLiveHarvestView, type LiveHarvestView } from "./atlas/live-harvest-view";
import { AtlasHarvestProgress } from "./atlas/AtlasHarvestProgress";
import { sanitizeHarvestDiagnostic } from "./atlas/harvest-issue-presentation";
import { useBackgroundEnrichment } from "./atlas/use-background-enrichment";
import { AtlasBackgroundEnrichmentStatus } from "./atlas/AtlasBackgroundEnrichmentStatus";
import { useHarvestRecovery } from "./atlas/use-harvest-recovery";
import type { HarvestCheckpoint, HarvestRunInput } from "./atlas/harvest-checkpoint";
import { finiteProgressStat, mergeLiveCommitTotals, toHarvestProgressState, type HarvestProgressState } from "./atlas/harvest-progress-presentation";
import { buildChinaRegionFilter, findChinaProvinceByMapId, getChinaProvinces, getChinaCities, getChinaDistricts, type ChinaRegionSelection } from "./atlas/china-regions";
import { resolveAdminBoundaryHighlight, type AdminBoundaryHighlight } from "./atlas/admin-boundary-service";
import countryCatalog from "../../../../config/geography/countries.json";
import { useUiPreferences } from "../lib/ui-preferences";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters/browser-contracts";
import { PlatformAuthHub } from "./atlas/PlatformAuthHub";
import { focusRealChrome } from "../lib/real-chrome-client";
import "./atlas/atlas.css";
import "./atlas/atlas-harvest-progress.css";
import "./atlas/background-enrichment.css";
import "./atlas/harvest-recovery.css";
import "./atlas/atlas-experience.css";
import "./atlas/atlas-command-center.css";

const AtlasMap = lazy(() => import("./atlas/prototypes/MapLibrePrototype"));
const AtlasSourcesPanel = lazy(() => import("./atlas/AtlasSourcesPanel").then((m) => ({ default: m.AtlasSourcesPanel })));
const AtlasSourceCandidateReview = lazy(() => import("./atlas/AtlasSourceCandidateReview").then((m) => ({ default: m.AtlasSourceCandidateReview })));
const AtlasReviewedCardImport = lazy(() => import("./atlas/AtlasReviewedCardImport").then((m) => ({ default: m.AtlasReviewedCardImport })));
const AtlasLocationConfirmation = lazy(() => import("./atlas/AtlasLocationConfirmation").then((m) => ({ default: m.AtlasLocationConfirmation })));
const AtlasOfficeAddressConfirmation = lazy(() => import("./atlas/AtlasOfficeAddressConfirmation").then((m) => ({ default: m.AtlasOfficeAddressConfirmation })));
const AtlasReconciliationPanel = lazy(() => import("./atlas/AtlasReconciliationPanel").then((m) => ({ default: m.AtlasReconciliationPanel })));
const AtlasAddressEnrichment = lazy(() => import("./atlas/AtlasAddressEnrichment").then(module => ({ default: module.AtlasAddressEnrichment })));
const AtlasDetailLocations = lazy(() => import("./atlas/AtlasDetailLocations").then(module => ({ default: module.AtlasDetailLocations })));

function backgroundHarvestProgress(progress: ClientPipelineProgress): ClientPipelineProgress {
  return { ...progress, stats: { ...progress.stats, enrichmentBackground: 1 },
    ...(progress.stage === "completed" && progress.stats?.enrichmentSkipped === 1
      ? { message: "本轮平台读取与入库处理已结束；地区和企业继续在后台自动补全，岗位列表与地图会随索引更新。" } : {}) };
}

function hasIncompleteLiveHarvest(summary: LivePlatformImportSummary): boolean {
  return summary.importFailures.length > 0 || summary.platformCoverage.some((platform) =>
    platform.status === "error"
      || platform.status === "login_required"
      || platform.status === "verification_required"
      || platform.coverage.partial,
  );
}
const COLOR_KEY = "better-me:atlas-colors:v1";
type Props = { active?: boolean; resume?: ProjectedResume | null; factBase?: FactBase | null; agentConfig?: LlmConfig; onAskAgentAboutHarvest?: (prompt: string) => void; onSaveOpportunity: (seed: OpportunitySeed) => void; onAnalyze: (item: AtlasJobAction) => void; onOpenOpportunitySources?: () => void; devJobIndex?: (signal: AbortSignal) => Promise<DevJobIndexBootstrap | undefined> };
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

export default function AtlasWorkspace({ active = true, resume, factBase, agentConfig, onAskAgentAboutHarvest, onSaveOpportunity, onAnalyze, onOpenOpportunitySources, devJobIndex = (import.meta.env?.DEV === true || readRuntimeConnection()) ? requestDevJobIndex : undefined }: Props) {
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
  // Read-only previews are deliberately separate from the completed CAS/harvest
  // baseline. Background writes and recovery never receive a partial dataset.
  const [baselinePreview, setBaselinePreview] = useState<{ dataset: AtlasDataset; progress: BaselineProgress; endpoint: string; token: string }>();
  const publishLiveSnapshot = useCallback((snapshot: AtlasDataset) => {
    setLiveData(current => current && current.revision >= snapshot.revision ? current : snapshot);
  }, []);
  const [liveHarvest, setLiveHarvest] = useState<LiveHarvestView | null>(null);
  const [preferLiveResults, setPreferLiveResults] = useState(true);
  const [liveCommitStats, setLiveCommitStats] = useState<{ totalAdded: number; totalUpdated: number }>();
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
  const [harvestStage, setHarvestStage] = useState<HarvestProgressState | null>(null);
  const [harvestCancelled, setHarvestCancelled] = useState(false);
  const [harvestFailed, setHarvestFailed] = useState(false);
  const [harvestImportFailures, setHarvestImportFailures] = useState<LivePlatformImportSummary["importFailures"]>([]);
  const [harvestFailureMessage, setHarvestFailureMessage] = useState<string>();
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
  function cancelSourceSearch() {
    const current = searchAbort.current;
    if (!current) return;
    const cancellingLiveHarvest = Boolean(harvestStage || liveHarvest);
    // Invalidate callbacks before aborting: CDP transports may take time to
    // acknowledge cancellation, but the UI must stop claiming active work now.
    searchAbort.current = null;
    void harvestRecovery.cancel().catch(() => { /* The recovery status reports a failed stop receipt. */ });
    current.abort();
    setSourceSearching(false);
    setHarvestCancelled(true);
    setHarvestFailed(false);
    setLiveHarvest((previous) => settleLiveHarvestView(previous, { outcome: "cancelled" }));
    setSourceSearchMessage(cancellingLiveHarvest
      ? "已发出停止信号，界面不再显示原站读取仍在继续；已收到的岗位保留，未确认请求不计为已覆盖。"
      : "已停止等待。已确认返回的岗位保留；服务端状态未知的请求可能已保存部分数据，请重新读取索引核对。");
  }
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
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
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
      // Keyword chips only filter the existing index.
    }
  }
  const [settings, setSettings] = useState<"connection" | "home" | "colors" | "maps" | null>(null);
  useEffect(() => { if (!active) { setSettings(null); setCollectionOpen(false); } }, [active]);
  const [endpoint, setEndpoint] = useState(initialConnection?.dataMode === "live" ? initialConnection.endpoint : DEFAULT_ATLAS_ENDPOINT);
  const [token, setToken] = useState(initialConnection?.dataMode === "live" ? initialConnection.token : "");
  useEffect(() => { setDetailReviewJobId(""); setEnrichmentScope(null); }, [endpoint, token, dataMode, active]);
  const [connecting, setConnecting] = useState(false);
  const connectionAbort = useRef<AbortController | null>(null);
  const devBootstrapAbort = useRef<AbortController | null>(null);
  const devAutoConnectSuppressed = useRef(readAtlasDevAutoConnectSuppressed());
  const connectedIdentity = useRef<{ endpoint: string; token: string } | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [autoReconnect, setAutoReconnect] = useState(false);
  const reconnectAttempts = useRef(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [latitude, setLatitude] = useState(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return String(JSON.parse(raw).latitude ?? "");
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
    return "";
  });
  const [longitude, setLongitude] = useState(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return String(JSON.parse(raw).longitude ?? "");
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
    return "";
  });
  const [anchor, setAnchorState] = useState<QueryOptions["anchor"]>(() => {
    try {
      const raw = localStorage.getItem("better-me:atlas-anchor:v1");
      if (raw) return JSON.parse(raw);
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
    return undefined;
  });
  const setAnchor = useCallback((val: QueryOptions["anchor"]) => {
    setAnchorState(val);
    try {
      if (val) localStorage.setItem("better-me:atlas-anchor:v1", JSON.stringify(val));
      else localStorage.removeItem("better-me:atlas-anchor:v1");
    } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
  }, []);
  const [homeError, setHomeError] = useState("");
  const [colors, setColors] = useState(initialColors);
  const [colorsMessage, setColorsMessage] = useState("");
  const [rawResult, setResult] = useState<JobQueryResult | null>(null);
  const [resultGeometry, setResultGeometry] = useState<AtlasMapGeometry>();
  const [resultData, setResultData] = useState<AtlasDataset | null>(null);
  const [resultIdentity, setResultIdentity] = useState<object | null>(null);
  const [listResultIdentity, setListResultIdentity] = useState<object | null>(null);
  const [recheckedSelection, setRecheckedSelection] = useState<{ data: AtlasDataset; identity: object; item: JobSearchItem }>();
  const [queryError, setQueryError] = useState("");
  const [querying, setQuerying] = useState(false);
  const [platformSearchOpen, setPlatformSearchOpen] = useState(false);
  const [authHubOpen, setAuthHubOpen] = useState(false);
  const [intervenePlatforms, setIntervenePlatforms] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [readingRevision, setReadingRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => { setLocationReview(undefined); }, [selectedId, endpoint, token]);
  const [bucket, setBucket] = useState<MapBucket | null>(null);
  const [mapError, setMapError] = useState("");
  const [rotating, setRotating] = useState(false);
  const [mapPresentation, setMapPresentation] = useState<{ mode: AtlasViewMode; animate: boolean }>({ mode: "spatial", animate: false });
  const [mapKey, setMapKey] = useState(0);
  const [listPage, setListPage] = useState<JobQueryResult | null>(null);
  const [listItems, setListItems] = useState<JobSearchItem[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const paging = useRef<{ key: string; queryId: string; data?: AtlasDataset; options?: QueryOptions }>({ key: "", queryId: "" });
  const [mapZoom, setMapZoom] = useState(1.5);
  const camera = useRef<AtlasCamera | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);
  const [basemapId, setBasemapId] = useState("auto");
  const [focus, setFocus] = useState<AtlasMapFocus>();
  const [locationSearch, setLocationSearch] = useState<{ jobId: string; locationId: string; result?: GeocodingResult; loading: boolean; error?: string }>();
  const locationAbort = useRef<AbortController | null>(null);
  const selectedCard = useRef<JobSearchItem | undefined>(undefined);
  const mapActivationAbort = useRef<AbortController | null>(null);
  useEffect(() => () => mapActivationAbort.current?.abort(), []);
  const queryAbort = useRef<AbortController | null>(null);
  const preview = baselinePreview?.endpoint === endpoint && baselinePreview.token === token ? baselinePreview : undefined;
  const hasBaselinePreview = Boolean(preview && !liveData);
  const data = dataMode === "demo" ? demo : dataMode === "live" ? liveData ?? preview?.dataset ?? null : localData;
  const connected = Boolean(liveData && connectedIdentity.current?.endpoint === endpoint && connectedIdentity.current.token === token);
  const backgroundEnrichment = useBackgroundEnrichment({
    endpoint, token, enabled: active && connected && dataMode === "live", currentRevision: liveData?.revision,
    onSnapshot: publishLiveSnapshot,
  });
  const harvestRecovery = useHarvestRecovery({
    endpoint, token, enabled: active && connected && dataMode === "live",
    onResume: async (input, checkpoint, signal) => {
      // This is the saved intent, not a new search. Update the scope guard before
      // restoring filters so their normal user-change effect cannot cancel it.
      liveMarketScope.current = { mode: input.view.mode, country: input.view.country };
      setMode(input.view.mode); setCountry(input.view.country);
      setText(input.keyword); setRegion(input.view.region); setRegionText(input.view.regionText);
      setChinaSelection(input.chinaSelection ?? {}); setSearchDepth(input.depth);
      await searchLivePlatformsOnly({ input, checkpoint, signal });
    },
  });
  const mapReferences = useAtlasMapReferences({ active, dataMode, connected, endpoint, token, snapshot: dataMode === "live" ? liveData : null });
  const searchableSources = (connected ? liveData?.sources : [])?.filter((entry) => entry.enabled && entry.status === "active" && entry.entityType === "job-posting" && entry.runtime.includes("local-service") && entry.capabilities.includes("list-jobs") && entry.entryUrl) ?? [];
  const selectedSearchSources = searchSourceId ? searchableSources.filter((entry) => entry.sourceId === searchSourceId) : searchableSources;
  const reviewSource = sourceReview ? liveData?.sources.find((entry) => entry.sourceId === sourceReview.sourceId) : undefined;
  useEffect(() => { setSourceReview(undefined); setCardReview(undefined); }, [endpoint, token]);
  const emptyIndex = !!data && !data.jobs.length;
  const dataLoading = connecting || (dataMode === "local" && localLoading);
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
  const metadataScope = useMemo(() => ({ dataMode, endpoint, token }), [dataMode, endpoint, token]);
  const computedMetadata = useComputedAtlasMetadata(data, { anchor, now: publicationNow, includeEstimates: true, allowCityEstimate: true, workCountryCodes: country ? [country] : mode === "domestic" ? (chinaSelection.provinceCode && ["HK", "MO", "TW"].includes(chinaSelection.provinceCode) ? [chinaSelection.provinceCode] : countryCatalog.domesticCountryCodes) : [] }, text, metadataScope);
  const coverage = computedMetadata.coverage;
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
  const countryOptions = useMemo(() => countries.map(code => <option key={code} value={code}>{countryName(code)}</option>), [countries]);
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
  const queryKey = JSON.stringify(query);
  const queryIdentity = useMemo(() => ({ queryKey, dataMode, endpoint, token }), [queryKey, dataMode, endpoint, token]);
  // Keep a coherent prior projection visible while the same query catches up.
  // A different filter, mode or connection never inherits this stale view.
  const result = data && resultIdentity === queryIdentity ? rawResult : null;
  const displayedData = result ? resultData : data;
  const presentListing = useMemo(() => displayedData ? createAtlasListingPresenter(displayedData, { now: publicationNow }) : undefined, [displayedData, publicationNow]);
  const locatedBuckets = useMemo(() => (result?.mapBuckets ?? []).filter(isMappableOfficeBucket), [result?.mapBuckets]);
  const mappableJobIds = useMemo(() => new Set(locatedBuckets.flatMap((entry) => entry.jobIds)), [locatedBuckets]);
  const mappableJobCount = mappableJobIds.size;
  const mappableLocationCount = useMemo(() => new Set(locatedBuckets.flatMap((entry) => entry.locationIds)).size, [locatedBuckets]);
  const mappableCoordinateCount = useMemo(() => new Set(locatedBuckets.map((entry) => `${entry.longitude},${entry.latitude}`)).size, [locatedBuckets]);
  const noPreciseLocationJobCount = Math.max(0, (result?.totalJobs ?? 0) - mappableJobCount);
  const mapFrame = useMemo(() => frameSearchMap(locatedBuckets), [locatedBuckets]);
  const displayFrame = useMemo(() => {
    if (adminBoundary?.bounds) return { bounds: adminBoundary.bounds, maxZoom: adminBoundary.boundsMaxZoom ?? 11 };
    return mapFrame ?? (mode === "domestic" ? frameAdminRegion(chinaFilter.selectedProvince?.mapId) : null);
  }, [adminBoundary, mapFrame, mode, chinaFilter.selectedProvince?.mapId]);
  const allPenetratedJobIds = computedMetadata.penetratedIds;
  const aiPenetratedJobIds = aiPenetratedOnly ? allPenetratedJobIds : undefined;
  const [penetrationResult, setPenetrationResult] = useState<{ data: AtlasDataset; query: JobQueryInput; count: number }>();
  const penetratedCount = penetrationResult?.data === data && penetrationResult?.query === query
    ? penetrationResult.count : 0;
  useEffect(() => {
    if (!data || !allPenetratedJobIds.length) { setPenetrationResult(undefined); return; }
    const abort = new AbortController();
    // Count within the same scope, including jobs without map coordinates.
    void queryAtlasPage(data, { ...query, jobIds: allPenetratedJobIds, page: { limit: 1 } }, queryOptions, { signal: abort.signal })
      .then(({ page }) => { if (!abort.signal.aborted) setPenetrationResult({ data, query, count: page.totalJobs }); })
      .catch(() => { if (!abort.signal.aborted) setPenetrationResult(undefined); });
    return () => abort.abort();
  }, [data, query, queryOptions, allPenetratedJobIds]);

  const effectiveSelectedJobIds = useMemo(() => {
    if (!bucket?.jobIds && !aiPenetratedJobIds) return undefined;
    if (!bucket?.jobIds) return aiPenetratedJobIds;
    if (!aiPenetratedJobIds) return bucket.jobIds;
    const set = new Set(aiPenetratedJobIds);
    return bucket.jobIds.filter((id) => set.has(id));
  }, [bucket?.jobIds, aiPenetratedJobIds]);
  const selectedIdsKey = useMemo(() => JSON.stringify(effectiveSelectedJobIds ?? null), [effectiveSelectedJobIds]);
  const listIdentity = useMemo(() => ({ queryIdentity, selectedIdsKey, bucketId: bucket?.id }), [queryIdentity, selectedIdsKey, bucket?.id]);

  const selectionKey = JSON.stringify({ ...query, mapLevel: "city", sort: undefined, aiPenetratedOnly });
  useEffect(() => { setAiBannerDismissed(false); }, [text]);
  useEffect(() => { mapActivationAbort.current?.abort(); cancelOfficeFocus(); setOfficeReview(undefined); setLocationChoices(undefined); setBucket(null); setSelectedId(""); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [selectionKey, dataMode]);
  useEffect(() => { if (!active) { cancelOfficeFocus(); setOfficeReview(undefined); setLocationChoices(undefined); } }, [active]);
  useEffect(() => { cancelOfficeFocus(); }, [endpoint, token]);
  useEffect(() => { setBucket(null); recoveredOfficeSelection.current = undefined; selectedCard.current = undefined; setSelectedId(""); setLocationReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [dataMode, endpoint, token]);
  // Version-bound editing proposals must expire, but an unrelated ingestion
  // commit must not close the reading pane. The settled query rechecks selection.
  useEffect(() => { setLocationReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [data]);
  useEffect(() => {
    setBucket(current => current?.positionBasis === "city-reference" ? null : current);
    setFocus(current => current?.positionBasis === "city-reference" ? undefined : current);
    if (selectedCard.current?.mapReferences?.length && recoveredOfficeSelection.current?.data !== data) { selectedCard.current = undefined; setSelectedId(""); setLocationReview(undefined); }
  }, [mapReferences.result, data]);
  useEffect(() => {
    queryAbort.current?.abort();
    const abort = new AbortController(); queryAbort.current = abort;
    const listKey = `${queryKey}|${bucket?.id ?? ""}|${aiPenetratedOnly ? "penetrated" : "all"}|${dataMode}`;
    if (paging.current.key !== listKey) {
      paging.current = { key: listKey, queryId: "" };
      if (pageIndex !== 0) { setPageIndex(0); setQuerying(false); return; }
    }
    if (!data) { setResult(null); setListPage(null); setListItems([]); setQuerying(false); return; }
    if (aiPenetratedOnly && !computedMetadata.ready) { setQuerying(!computedMetadata.error); return () => abort.abort(); }
    const cursor = pageIndex > 0 && paging.current.queryId && paging.current.data === data && paging.current.options === queryOptions
      ? `${paging.current.queryId}:${pageIndex * pageSize}` : undefined;
    setQuerying(true); setQueryError("");
    const timer = setTimeout(() => {
      void queryAtlasPage(data, query, queryOptions, { signal: abort.signal, ...(cursor ? { cursor } : { pageIndex }), selectedJobIds: effectiveSelectedJobIds }).then((next) => {
        if (abort.signal.aborted || paging.current.key !== listKey) return;
        paging.current.queryId = next.page.queryId; paging.current.data = data; paging.current.options = queryOptions;
        if (next.pageIndex !== undefined && next.pageIndex !== pageIndex) setPageIndex(next.pageIndex);
        setResultIdentity(queryIdentity); setListResultIdentity(listIdentity); setResultData(data); setResult(next.summary); setResultGeometry(next.geometry); setListPage(next.page); setListItems(next.page.items); setQuerying(false);
      }, (error: unknown) => {
        if (abort.signal.aborted || paging.current.key !== listKey) return;
        const stale = error instanceof Error && error.message.includes("请从第一页");
        if (stale && pageIndex !== 0) { paging.current.queryId = ""; setPageIndex(0); setQuerying(false); return; }
        setResult(null); setListPage(null); setListItems([]); setQuerying(false); setQueryError(error instanceof Error ? error.message : "查询失败");
      });
    }, hasBaselinePreview ? 0 : 120);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [data, dataMode, query, queryKey, queryIdentity, listIdentity, queryOptions, bucket, pageIndex, pageSize, selectionKey, effectiveSelectedJobIds, aiPenetratedOnly, computedMetadata.ready, computedMetadata.error, hasBaselinePreview]);
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
  useEffect(() => () => { connectionAbort.current?.abort(); devBootstrapAbort.current?.abort(); searchAbort.current?.abort(); locationAbort.current?.abort(); officeFocusAbort.current?.abort(); }, []);

  const connect = useCallback(async (identity: AtlasConnectionIdentity, remember: boolean) => {
    searchAbort.current?.abort();
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    connectionAbort.current?.abort();
    const abort = new AbortController(); connectionAbort.current = abort;
    setSourcesOpen(false); setReconciliationOpen(false); setSourceReview(undefined); setCardReview(undefined); setLocationReview(undefined);
    setBaselinePreview(current => current?.endpoint === identity.endpoint && current.token === identity.token ? current : undefined);
    setConnecting(true); setConnectionError(""); setConnectionNotice(""); setDataMode("live");
    setAutoReconnect(false);
    const timeout = setTimeout(() => abort.abort(), 120_000);
    try {
      const snapshot = await readAtlasSnapshot(identity.endpoint, identity.token, { signal: abort.signal,
        onProgress: (dataset, progress) => {
          if (connectionAbort.current !== abort || abort.signal.aborted || devAutoConnectSuppressed.current) return;
          setBaselinePreview({ dataset, progress, ...identity });
        },
      });
      if (connectionAbort.current !== abort || abort.signal.aborted || devAutoConnectSuppressed.current) return;
      restoreConnection.current = false;
      const sameConnection = connectedIdentity.current?.endpoint === identity.endpoint && connectedIdentity.current?.token === identity.token;
      connectedIdentity.current = identity;
      reconnectAttempts.current = 0;
      if (remember && !writeAtlasConnectionSession({ schemaVersion: 1, dataMode: "live", ...identity })) setConnectionNotice("本次已连接；浏览器未允许保存标签页会话，刷新后需要重新连接。");
      setLiveData(current => sameConnection && current && current.revision > snapshot.revision ? current : snapshot); setBaselinePreview(undefined); setDataMode("live"); setSelectedId(""); setSettings(null); setSourceSearchMessage(""); setSourceSearchError("");
    } catch (error) {
      if (connectionAbort.current === abort) {
        restoreConnection.current = false;
        const retry = Boolean(devJobIndex) && shouldAutoReconnectAtlas(error, abort.signal.aborted);
        setAutoReconnect(retry);
        setConnectionError(`${remember ? "" : "未能恢复本机索引连接，仍保留本机索引视图；请重试或检查连接设置。"}${abort.signal.aborted ? "连接超时或已取消。请确认本机岗位服务正在运行。" : error instanceof Error ? error.message : "无法连接本机服务。"}${retry ? " 服务恢复后将自动重连。" : ""}`);
      }
    } finally { clearTimeout(timeout); if (connectionAbort.current === abort) setConnecting(false); }
  }, [devJobIndex]);
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
    setDataMode("live"); setConnecting(true); setAutoReconnect(false); setConnectionError(""); setConnectionNotice("正在准备本机岗位索引…");
    try {
      const result = await devJobIndex(abort.signal);
      if (abort.signal.aborted || devAutoConnectSuppressed.current) {
        if (!connectedIdentity.current && devBootstrapAbort.current === abort) setConnecting(false);
        return;
      }
      if (!result?.ok) {
        setConnecting(false); setConnectionNotice("");
        const retry = !result || !/令牌|来源|Origin|拒绝|占用/.test(result.error);
        setAutoReconnect(retry);
        setConnectionError(`${result ? result.error : "本地开发服务没有返回岗位索引连接。请确认当前页面由本机开发服务打开。"}${retry ? " 服务恢复后将自动重连。" : ""}`);
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
      const retry = error instanceof TypeError;
      setAutoReconnect(retry);
      setConnectionError(`${error instanceof Error && error.message ? error.message : "无法准备本机岗位索引。"}${retry ? " 服务恢复后将自动重连。" : ""}`);
    } finally {
      signal?.removeEventListener("abort", stop);
      if (devBootstrapAbort.current === abort) devBootstrapAbort.current = null;
    }
  }, [connect, devJobIndex]);
  useEffect(() => {
    if (!active || !devJobIndex || !autoReconnect || connecting || devAutoConnectSuppressed.current || readAtlasDevAutoConnectSuppressed()) return;
    const delay = Math.min(3_000 * 2 ** Math.min(reconnectAttempts.current++, 4), 48_000);
    const timer = setTimeout(() => { void bootstrapDevIndex(); }, delay);
    return () => clearTimeout(timer);
  }, [active, autoReconnect, connecting, devJobIndex, bootstrapDevIndex]);
  useEffect(() => {
    if (!active || !devJobIndex || initialConnection || connectedIdentity.current || devAutoConnectSuppressed.current || readAtlasDevAutoConnectSuppressed()) return;
    const abort = new AbortController();
    void bootstrapDevIndex(abort.signal);
    return () => abort.abort();
  }, [active, devJobIndex, initialConnection, bootstrapDevIndex]);
  function cancelConnection() {
    setAutoReconnect(false); reconnectAttempts.current = 0;
    restoreConnection.current = false;
    const abort = connectionAbort.current; connectionAbort.current = null; abort?.abort();
    searchAbort.current?.abort(); setConnecting(false); setBaselinePreview(undefined);
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

  const liveHarvestQuery = useMemo(() => {
    const queryRegion = mode === "domestic"
      ? (chinaFilter.selectedCity?.isGrouping && ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "")
        ? chinaFilter.selectedProvince?.name
        : chinaFilter.selectedCity?.name) ?? chinaFilter.selectedProvince?.name ?? ""
      : regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "");
    return {
      keyword: text.trim() || resumePrefill.targetRole || "软件工程师",
      ...(queryRegion ? { region: queryRegion } : {}),
      ...(mode === "domestic" && chinaSelection.districtCode ? { districtCode: chinaSelection.districtCode } : {}),
    };
  }, [text, resumePrefill.targetRole, mode, chinaFilter, chinaSelection.districtCode, regionText, region, regions]);

  const liveMarketScope = useRef({ mode, country });
  const cancelHarvestRecovery = harvestRecovery.cancel;
  useEffect(() => {
    if (liveMarketScope.current.mode === mode && liveMarketScope.current.country === country) return;
    liveMarketScope.current = { mode, country };
    void cancelHarvestRecovery().catch(() => { /* Its independent status remains actionable. */ });
    searchAbort.current?.abort();
    searchAbort.current = null;
    setLiveHarvest(null);
    setLiveCommitStats(undefined);
    setSourceSearching(false);
    setHarvestFailed(false);
    setHarvestCancelled(false);
    setHarvestImportFailures([]);
    setHarvestFailureMessage(undefined);
    setHarvestStage({ stage: "intent-expansion", stageIndex: 1, totalStages: 5, message: "准备本轮实时搜索请求" });
    setSourceSearchMessage("");
    setSourceSearchError("");
  }, [mode, country, cancelHarvestRecovery]);

  function formatLivePlatformNotice(summary: LivePlatformImportSummary | undefined): string {
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
        const stopLabel = liveHarvestStopReasonLabel(entry.status, coverage.stopReason);
        return coverage.partial ? `${progress} · 未完成：${stopLabel}` : `${progress} · ${stopLabel}`;
      }).join("；")}。`);
    }
    if (summary.importFailures.length > 0) {
      const failedCards = summary.importFailures.reduce((total, failure) => total + failure.cards, 0);
      parts.push(`实时卡片提交未确认 ${failedCards} 条（${summary.importFailures.map((failure) => `${failure.platform}：${failure.error}`).join("；")}）。卡片仍保留在原站实时列表；未收到成功回执不等于未写入，索引与地图以已确认结果为准。`);
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

  function harvestRunInput(keyword: string): HarvestRunInput {
    return { keyword, region: currentPlatformRegionText(), depth: searchDepth,
      maxPages: searchDepth === "deep" ? 50 : searchDepth === "standard" ? 20 : 5,
      chinaSelection: mode === "domestic" ? chinaSelection : undefined,
      view: { mode, country, region, regionText } };
  }

  async function searchLivePlatformsOnly(restored?: { input: HarvestRunInput; checkpoint: HarvestCheckpoint; signal: AbortSignal }) {
    if (!connected) {
      setSettings("connection");
      setSourceSearchMessage("先连接本机来源服务，再执行全网平台实时抓取入库。");
      return;
    }
    if ((restored?.input.keyword ?? text).trim().length > 300) {
      setSourceSearchError("来源搜索关键词最多 300 个字符。");
      return;
    }
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    setSourceSearching(true);
    setSourceSearchError("");
    setLiveHarvest(null);
    setHarvestCancelled(false);
    setHarvestFailed(false);
    setPreferLiveResults(true);
    setHarvestImportFailures([]);
    setHarvestFailureMessage(undefined);
    setLiveCommitStats(undefined);
    setSearchProgress(null);
    setSourceSearchMessage(restored ? "正在核对上次入库回执并继续未完成的平台；已完成的平台不重复读取。" : "正在通过真实 Chrome CDP 读取猎聘、前程无忧 51JOB、BOSS直聘和 LinkedIn 的本轮搜索结果…");
    setHarvestStage({ stage: "intent-expansion", stageIndex: 1, totalStages: 5, message: "正在连接实时平台并准备本轮搜索…" });
    setSourceReview(undefined);
    setBucket(null);
    const client = createAtlasSourceClient(endpoint, token);
    const savedInput = restored?.input ?? harvestRunInput(text.trim() || resumePrefill.targetRole || "软件工程师");
    try {
      const execute = (checkpoint: HarvestCheckpoint, signal: AbortSignal) => executeOpportunityHarvestChainedPipeline(
        {
          client,
          checkpoint,
          keyword: savedInput.keyword,
          region: savedInput.region,
          depth: savedInput.depth,
          enrichAfterCommit: false,
          maxPages: savedInput.maxPages,
          chinaSelection: savedInput.chinaSelection,
          initialSnapshot: (dataMode === "live" && liveData) ? liveData : undefined,
          signal,
          onLiveResults: (receipt, query) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              setLiveHarvest(previous => mergeLiveHarvestViews(previous, buildLiveHarvestView(receipt, query)));
            }
          },
          onLiveProgress: (event, receipt, query) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              setLiveHarvest(previous => applyLiveBatchStreamEvent(previous, receipt, query, event));
            }
          },
          onCardsCommitted: (snapshot, stats) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              publishLiveSnapshot(snapshot);
              setDataMode("live");
              setLiveCommitStats(previous => mergeLiveCommitTotals(previous, stats));
            }
          },
          onSnapshotAvailable: (snapshot) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              publishLiveSnapshot(snapshot);
              setDataMode("live");
            }
          },
        },
        (progress) => {
          if (searchAbort.current === abort && !abort.signal.aborted) {
            if (typeof progress.stats?.totalAdded === "number" && typeof progress.stats?.totalUpdated === "number") {
              setLiveCommitStats({ totalAdded: progress.stats.totalAdded, totalUpdated: progress.stats.totalUpdated });
            }
            setHarvestStage(previous => toHarvestProgressState(backgroundHarvestProgress(progress), previous));
            setSourceSearchMessage(`[流水线 ${progress.stageIndex}/5] ${progress.message}`);
          }
        },
      );
      const summary = restored
        ? await execute(restored.checkpoint, AbortSignal.any([abort.signal, restored.signal]))
        : await harvestRecovery.run(savedInput, execute, abort.signal);
      if (!summary) return;
      if (searchAbort.current !== abort || abort.signal.aborted) return;
      setLiveCommitStats({ totalAdded: summary.totalAdded, totalUpdated: summary.totalUpdated });
      setHarvestFailed(hasIncompleteLiveHarvest(summary));
      setHarvestImportFailures(summary.importFailures);
      if (summary.snapshot) {
        publishLiveSnapshot(summary.snapshot);
        setDataMode("live");
      }
      const notice = formatLivePlatformNotice(summary);
      setSourceSearchMessage(
        notice || `已完成全网平台（BOSS · 51 · 猎聘 · 领英）实时检索，暂未发现新卡片。`,
      );
    } catch (error) {
      if (searchAbort.current === abort) {
        setHarvestFailed(true);
        setHarvestFailureMessage(error instanceof Error ? error.message : "全网平台实时抓取失败，未返回具体原因。");
        setLiveHarvest((previous) => settleLiveHarvestView(previous, {
          outcome: "error",
          message: error instanceof Error ? error.message : "实时搜索流异常中断",
        }));
        setSourceSearchError(error instanceof Error ? error.message : "全网平台实时抓取失败。");
      }
      if (restored && !restored.signal.aborted) throw error;
    } finally {
      if (searchAbort.current === abort) {
        setSourceSearching(false);
      }
    }
  }

  async function searchSourceJobs(overrideKeyword?: string) {
    if (!connected) { setSettings("connection"); setSourceSearchMessage("先连接本机来源服务，再按关键词从已配置来源获取岗位。"); return; }
    const effectiveText = (overrideKeyword !== undefined ? overrideKeyword : text).trim();
    if (effectiveText.length > 300) { setSourceSearchError("来源搜索关键词最多 300 个字符。"); return; }
    searchAbort.current?.abort(); const abort = new AbortController(); searchAbort.current = abort;
    setSourceSearching(true); setSourceSearchError(""); setSourceSearchMessage(""); setSourceReview(undefined); setBucket(null); setIntervenePlatforms([]); setLiveHarvest(null);
    setPreferLiveResults(true); setLiveCommitStats(undefined); setSearchProgress(null); setHarvestStage(null); setHarvestCancelled(false); setHarvestFailed(false);
    setHarvestImportFailures([]); setHarvestFailureMessage(undefined);
    const client = createAtlasSourceClient(endpoint, token);
    const requestIdentities = new Map<string, string>();
    const scopeCountry = mode === "global" ? country : "";
    const requestedRegion = regionText.trim() || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "");
    const scopeRegions = mode === "domestic" ? chinaFilter.sourceRegions : requestedRegion ? [requestedRegion] : [];
    const acquisitionCountries = mode === "domestic" ? (chinaFilter.workCountryCodes.length ? chinaFilter.workCountryCodes : includeUnclassified ? [] : countryCatalog.domesticCountryCodes) : scopeCountry && scopeRegions.length ? [scopeCountry] : [];
    // Serialize snapshot refreshes so a slower, older response cannot replace a newer index.
    let refresh: Promise<void> = Promise.resolve();
    const enableLiveCommercialSearch = import.meta.env?.DEV === true && !searchSourceId;
    if (enableLiveCommercialSearch) {
      setHarvestStage({ stage: "intent-expansion", stageIndex: 1, totalStages: 5, message: "正在连接实时平台并准备本轮搜索…" });
    }
    const liveKeyword = effectiveText || resumePrefill.targetRole || "软件工程师";
    const liveInput = harvestRunInput(liveKeyword);
    let liveSummary: LivePlatformImportSummary | undefined;
    let liveCommercialError: Error | undefined;
    const liveCommercialPromise: Promise<void> = enableLiveCommercialSearch
      ? harvestRecovery.run(liveInput, (checkpoint, signal) => executeOpportunityHarvestChainedPipeline(
          {
            client,
            checkpoint,
            keyword: liveKeyword,
            region: liveInput.region,
            depth: searchDepth,
            enrichAfterCommit: false,
            maxPages: searchDepth === "deep" ? 50 : searchDepth === "standard" ? 20 : 5,
            chinaSelection: mode === "domestic" ? chinaSelection : undefined,
            initialSnapshot: (dataMode === "live" && liveData) ? liveData : undefined,
            signal,
            onLiveResults: (receipt, query) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                setLiveHarvest(previous => mergeLiveHarvestViews(previous, buildLiveHarvestView(receipt, query)));
              }
            },
            onLiveProgress: (event, receipt, query) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                setLiveHarvest(previous => applyLiveBatchStreamEvent(previous, receipt, query, event));
              }
            },
            onCardsCommitted: (snapshot, stats) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                publishLiveSnapshot(snapshot);
                setDataMode("live");
                setLiveCommitStats(previous => mergeLiveCommitTotals(previous, stats));
              }
            },
            onSnapshotAvailable: (snapshot) => {
              if (searchAbort.current === abort && !abort.signal.aborted) {
                publishLiveSnapshot(snapshot);
                setDataMode("live");
              }
            },
          },
          (progress) => {
            if (searchAbort.current === abort && !abort.signal.aborted) {
              if (typeof progress.stats?.totalAdded === "number" && typeof progress.stats?.totalUpdated === "number") {
                setLiveCommitStats({ totalAdded: progress.stats.totalAdded, totalUpdated: progress.stats.totalUpdated });
              }
              setHarvestStage(previous => toHarvestProgressState(backgroundHarvestProgress(progress), previous));
              setSourceSearchMessage(`[全网实时检索 ${progress.stageIndex}/5] ${progress.message}`);
            }
          },
        ), abort.signal)
          .then((summary) => {
            if (!summary || abort.signal.aborted || searchAbort.current !== abort) return;
            liveSummary = summary;
            setHarvestFailed(hasIncompleteLiveHarvest(summary));
            setHarvestImportFailures(summary.importFailures);
            setLiveCommitStats({ totalAdded: summary.totalAdded, totalUpdated: summary.totalUpdated });
            if (summary.snapshot) {
              publishLiveSnapshot(summary.snapshot);
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
          .catch((error: unknown) => {
            if (abort.signal.aborted || searchAbort.current !== abort) return;
            liveCommercialError = error instanceof Error ? error : new Error("全网平台实时抓取失败。");
            setHarvestFailed(true);
            setHarvestFailureMessage(liveCommercialError.message);
            setLiveHarvest((previous) => settleLiveHarvestView(previous, {
              outcome: "error",
              message: liveCommercialError!.message,
            }));
            setSourceSearchError(liveCommercialError.message);
          })
      : Promise.resolve();

    if (!selectedSearchSources.length) {
      try {
        await liveCommercialPromise;
        if (searchAbort.current !== abort) return;
        if (liveCommercialError) throw liveCommercialError;
        const liveNotice = formatLivePlatformNotice(liveSummary);
        setSourceSearchMessage(
          liveNotice || "本轮没有收到平台采集回执，未确认有新岗位入库。",
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
              publishLiveSnapshot(snapshot); setDataMode("live");
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
      setSourceSearchMessage(`${liveNotice ? `${liveNotice} · ` : ""}${aggregate.cancelled ? "已停止等待" : "本次配置来源读取已结束"} · ${receipts.length}/${aggregate.total} 个来源返回回执，原始返回 ${records} 条，新增入库 ${added} 岗。原始条数不代表匹配岗位数；仅已确认匹配的结果进入索引。${pendingRequirements ? ` 另有 ${pendingRequirements} 条候选要求未读全，尚不能判断是否符合。` : ""}${failed ? ` ${failed} 个来源未成功，请展开逐源状态。` : ""}${aggregate.cancelled ? " 未确认的请求可能已保存部分数据，可重新读取索引核对。" : ""}${totalAddedAll === 0 ? " 💡 提示：企业官网公开源可能受网络或配额限制；已展开【全网商业平台聚合】，可查看平台当前页面在本轮预算内返回的岗位卡片，登录/验证需由你本人在 Chrome 中完成。" : ""}`);
      if (totalAddedAll === 0) setPlatformSearchOpen(true);
      if (failed || liveCommercialError) setSourceSearchError([
        liveCommercialError?.message,
        ...aggregate.sources.filter((entry) => entry.error || entry.status === "failed").map((entry) => `${entry.label}：${entry.error?.message ?? entry.receipt?.sourceError?.code ?? "来源读取失败"}`),
      ].filter(Boolean).join("；"));
      if (aggregate.notificationErrors.length) setSourceSearchError("部分来源已返回，但索引展示刷新未完成，请点击“重新读取索引”核对。来源回执已保留。");
    } catch (error) {
      if (searchAbort.current === abort) setSourceSearchError(error instanceof Error ? error.message : "聚合来源搜索失败。");
    } finally { if (searchAbort.current === abort) setSourceSearching(false); }
  }
  const visibleItems = useMemo(() => {
    if (preferLiveResults && !bucket && liveHarvest && matchesLiveHarvestQuery(liveHarvest, liveHarvestQuery)) return [];
    if (!result || listResultIdentity !== listIdentity) return [];
    return listItems.filter((item) => {
      if (salaryFilter && !matchCardSalary(item, salaryFilter)) return false;
      if (pubFilter && !matchCardPublication(item, pubFilter, presentListing?.(item), displayedData)) return false;
      if (distanceFilter && anchor && !matchCardDistance(item, distanceFilter)) return false;
      if (distanceFilter === "exact" && (item.distance?.estimated || !item.distance)) return false;
      if (aiPenetratedOnly) {
        const rel = analyzeAiJobRelevance(item.job, text, item.company.names[0]);
        if (!rel.isPenetrated) return false;
      }
      return true;
    });
  }, [preferLiveResults, bucket, liveHarvest, liveHarvestQuery, result, listResultIdentity, listIdentity, displayedData, listItems, salaryFilter, pubFilter, distanceFilter, anchor, presentListing, aiPenetratedOnly, text]);
  const activeLiveHarvest = preferLiveResults && !bucket && liveHarvest && matchesLiveHarvestQuery(liveHarvest, liveHarvestQuery)
    ? liveHarvest
    : null;
  const showHarvestStatus = Boolean(activeLiveHarvest || harvestStage && (harvestStage.stage !== "intent-expansion"
    || sourceSearching || harvestFailed || harvestCancelled || Object.keys(harvestStage.stats ?? {}).length));
  const unlocatedVisibleItems = useMemo(() => visibleItems.filter((item) => !mappableJobIds.has(item.job.id)), [visibleItems, mappableJobIds]);
  function beginAddressEnrichment() {
    if (!connected || dataMode !== "live") return;
    // The review pane can also re-check an existing office. The map footer
    // calls this with missing-address rows; the folded workspace entry keeps
    // the broader review behavior for the current page.
    const candidates = unlocatedVisibleItems.length ? unlocatedVisibleItems : visibleItems;
    const jobIds = candidates.slice(0, 50).map((item) => item.job.id);
    if (!jobIds.length) {
      setSourceSearchMessage("当前页岗位已有来源坐标，或尚未完成列表读取；没有可补全的岗位。");
      return;
    }
    cancelOfficeFocus();
    setDetailReviewJobId("");
    setEnrichmentScope(jobIds);
  }
  const selected = result && listPage?.totalJobs !== 0 && listResultIdentity === listIdentity ? visibleItems.find((item) => item.job.id === selectedId)
    ?? (recheckedSelection?.data === data && recheckedSelection.identity === listIdentity && recheckedSelection.item.job.id === selectedId ? recheckedSelection.item : undefined)
    ?? (selectedCard.current?.job.id === selectedId && data?.jobs.some((job) => job.id === selectedId) ? selectedCard.current : undefined) : undefined;
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
    if (!active || !data || resultData !== data || listResultIdentity !== listIdentity || !rawResult || !selectedId || listItems.some(item => item.job.id === selectedId)) return;
    const abort = new AbortController();
    const discard = () => {
      selectedCard.current = undefined; setSelectedId(""); setRecheckedSelection(undefined); setLocationReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setFocus(undefined);
      locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    };
    // An authoritative empty scope already excludes the selected job. Do not
    // retain a revoked fact while scheduling an unnecessary second query.
    if (listPage?.totalJobs === 0 || effectiveSelectedJobIds && !effectiveSelectedJobIds.includes(selectedId)) { discard(); return; }
    const recovered = recoveredOfficeSelection.current;
    if (recovered?.data === data && recovered.selectionKey === selectionKey && recovered.jobId === selectedId) return;
    if (recheckedSelection?.data === data && recheckedSelection.identity === listIdentity && recheckedSelection.item.job.id === selectedId) return;
    // New jobs may push the selected one off this page without removing it from
    // the search. Recheck that single job; page membership is not query membership.
    void queryAtlasPage(data, { ...query, page: { limit: 1 } }, queryOptions, { selectedJobIds: [selectedId], signal: abort.signal }).then(next => {
      if (abort.signal.aborted) return;
      const item = next.page.items.find(value => value.job.id === selectedId);
      if (!item) { discard(); return; }
      selectedCard.current = item; setRecheckedSelection({ data, identity: listIdentity, item });
    }, () => { if (!abort.signal.aborted) discard(); });
    return () => abort.abort();
  }, [active, data, resultData, rawResult, listPage, listResultIdentity, listIdentity, selectedId, listItems, selectionKey, effectiveSelectedJobIds, query, queryOptions, recheckedSelection]);
  function openJob(item: JobSearchItem) {
    setReadingRevision(revision => revision + 1);
    setDetailReviewJobId(""); setEnrichmentScope(null);
    if (selectedId !== item.job.id) { cancelOfficeFocus(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setOfficeReview(undefined); setLocationChoices(undefined); }
    selectedCard.current = item; setSelectedId(item.job.id);
  }
  function activateMapBucket(next: MapBucket) {
    const jobId = next.jobIds[0];
    if (!jobId || !data) return;
    // A map bucket can contain a job beyond the current list page. Resolve that
    // one ID against the same query before opening the reading pane, so every
    // source-backed address has a deterministic next action.
    const current = listItems.find((item) => item.job.id === jobId);
    if (current) { openJob(current); return; }
    mapActivationAbort.current?.abort();
    const abort = new AbortController(); mapActivationAbort.current = abort;
    void queryAtlasPage(data, { ...query, page: { limit: 1 } }, queryOptions, { signal: abort.signal, selectedJobIds: [jobId] }).then(({ page }) => {
      if (abort.signal.aborted) return;
      const item = page.items.find((entry) => entry.job.id === jobId);
      if (item) openJob(item);
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setSourceSearchError(error instanceof Error ? error.message : "无法打开该办公地址对应的岗位。");
    });
  }
  function closeJob() { cancelOfficeFocus(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setSelectedId(""); setFocus(undefined); }
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

  function retryIndexConnection() {
    restoreConnection.current = false;
    if (devJobIndex && !token.trim() && !devAutoConnectSuppressed.current) void bootstrapDevIndex();
    else void connect({ endpoint, token }, true);
  }
  const indexError = dataMode === "live" ? connectionError : dataMode === "local" ? localError : "";
  const indexState = indexError ? "attention" : dataLoading ? "working" : data ? "ready" : "idle";
  const searchFilterCount = activeFilterCount + Number(Boolean(source)) + Number(Boolean(salaryMin || salaryMax))
    + Number(Boolean(maxKm && !distanceFilter)) + Number(Boolean(region))
    + Number(includeUnclassified && mode === "domestic" && !chinaFilter.selectedProvince);
  const settingsTitles = {
    maps: "地图与街道底图",
    connection: t("连接你的本机岗位索引", "Connect your local job index"),
    home: "离家距离 · 私人参照点",
    colors: "企业控股来源配色",
  };

  return <section ref={workspace} className="atlas-workspace atlas-experience atlas-command-center" data-pane-layout={layout} data-controls-open={commandOpen || undefined} data-flexible-layout aria-label={t("岗位地图", "Opportunity atlas")}>
    <div className="atlas-primary-search">
      <form className="atlas-searchbar" aria-label="筛选已收录岗位" onSubmit={(e) => { e.preventDefault(); }}>
        <div className="atlas-search-fields"><label className="atlas-search"><Search size={18} /><input aria-label="搜索地图岗位" aria-describedby="atlas-search-help" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("关键词、技能或公司", "Role, skill, or company")} />{text && <button type="button" className="atlas-search-clear" aria-label="清除岗位关键词" onClick={() => setText("")}><X size={14} /></button>}</label>{mode === "domestic" ? <div className="atlas-domestic-region" role="group" aria-label="国内省市区筛选"><span>中国</span><select aria-label="工作省份" value={chinaSelection.provinceCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: e.target.value || undefined })}><option value="">全部省份</option>{getChinaProvinces().map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作城市" disabled={!chinaCities.length} value={chinaSelection.cityCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: chinaSelection.provinceCode, cityCode: e.target.value || undefined })}><option value="">全部城市</option>{chinaCities.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作区县" disabled={!chinaDistricts.length} value={chinaSelection.districtCode ?? ""} onChange={(e) => setChinaSelection({ ...chinaSelection, districtCode: e.target.value || undefined })}><option value="">全部区 / 县</option>{chinaDistricts.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></div> : <><select aria-label="工作国家或地区" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(""); setRegionText(""); }}><option value="">{t("所有国家 / 地区", "All countries / regions")}</option>{countryOptions}</select><label className="atlas-region-search"><MapPin size={15} /><input aria-label="工作城市或地区关键词" value={regionText} onChange={(e) => { setRegionText(e.target.value); setRegion(""); }} placeholder="城市 / 地区，如北京、Berlin" maxLength={300} /></label></>}<button className="atlas-source-search" aria-busy={sourceSearching} type="button" onClick={() => setCollectionOpen(true)} disabled={sourceSearching || connecting}>{sourceSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}采集新岗位</button></div>
        <div className="atlas-search-utilities">
          <span id="atlas-search-help" className="atlas-search-hint">仅筛选已收录岗位 · Enter 不启动采集</span>
          <div className="atlas-search-tools"><AtlasToolbarMenu className="atlas-fetch-options" label="获取方式">{searchableSources.length > 0 && <select aria-label="搜索原始来源" value={searchSourceId} onChange={(e) => { searchAbort.current?.abort(); setSearchSourceId(e.target.value); }}><option value="">已配置岗位来源（{searchableSources.length}）</option>{searchableSources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.attribution.label}{entry.remoteFilters.includes("roles") ? " · 实时关键词" : " · 来源岗位"}</option>)}</select>}<select aria-label="来源读取范围" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value as "quick" | "standard" | "deep")}><option value="deep">深度采集 · 最多 50 页 / 每平台 3000 岗</option><option value="standard">标准模式 · 最多 20 页 / 每平台 1500 岗</option><option value="quick">快速模式 · 最多 5 页 / 每平台 500 岗</option></select><small>预算、登录验证、无新增等情况会提前停止；上限不代表网站总量。</small><select aria-label="并发同步数量" value={searchConcurrency} onChange={(e) => { const val = Number(e.target.value); setSearchConcurrency(val); try { localStorage.setItem("better-me:atlas-concurrency", String(val)); } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ } }}><option value={16}>全源同时并发（极速）</option><option value={6}>6 源并发</option><option value={4}>4 源并发</option><option value={2}>2 源并发（排队）</option></select></AtlasToolbarMenu><button type="button" className="atlas-auth-hub-trigger" title="全网平台统一登录与会话接管中心（BOSS直聘 · 猎聘 · 51JOB · 领英）" onClick={() => setAuthHubOpen(true)}><KeyRound size={15} />平台登录态</button><button type="button" aria-expanded={platformSearchOpen} className="atlas-platform-trigger" title="BOSS · 猎聘 · 51 · 领英 · Seek · Indeed · GradConnection · 官网" onClick={() => { setCommandOpen(true); setPlatformSearchOpen(!platformSearchOpen); }}>全网平台</button><button type="button" aria-label={t("筛选", "Filters")} aria-controls="atlas-search-filters" aria-expanded={filtersOpen} onClick={() => { setCommandOpen(true); setFiltersOpen(!filtersOpen); }}><SlidersHorizontal size={16} />{t("筛选", "Filters")}{searchFilterCount > 0 && <span className="atlas-filter-count">{searchFilterCount}</span>}</button></div>
        </div>
      </form>
    </div>
    {collectionOpen && active && <AtlasSettingsDialog title="采集新岗位" onClose={() => setCollectionOpen(false)} closeLabel="取消岗位采集">
      <p>这会访问招聘来源，并把返回的岗位收录到当前索引。仅浏览或筛选已有岗位不需要采集。</p>
      <dl className="atlas-collection-scope"><div><dt>关键词</dt><dd>{text.trim() || (!searchSourceId && import.meta.env?.DEV ? resumePrefill.targetRole || "软件工程师（实时平台默认词）" : "未指定（来源默认范围）")}</dd></div><div><dt>地区</dt><dd>{mode === "domestic" ? ["中国", chinaFilter.selectedProvince?.name, chinaFilter.selectedCity?.name].filter(Boolean).join(" / ") : [country ? countryName(country) : "所有国家 / 地区", regionText || region].filter(Boolean).join(" / ")}</dd></div><div><dt>来源</dt><dd>{searchableSources.find(entry => entry.sourceId === searchSourceId)?.attribution.label ?? (searchableSources.length ? "已配置来源（" + searchableSources.length + "）" + (!searchSourceId && import.meta.env?.DEV ? " + 实时平台（BOSS / 猎聘 / 51Job / 领英）" : "") : "连接后读取已配置来源")}</dd></div><div><dt>预算上限</dt><dd>{searchDepth === "deep" ? "每平台 50 页 / 3000 岗" : searchDepth === "standard" ? "每平台 20 页 / 1500 岗" : "每平台 5 页 / 500 岗"} · {searchConcurrency} 源并发</dd></div></dl>
      <p className="atlas-small">上限不是预期新增量；登录、来源限制或无新增会提前结束。可取消并保留已收到的结果。</p>
      <div className="atlas-collection-actions"><button type="button" onClick={() => { setCollectionOpen(false); setCommandOpen(true); }}>调整范围</button><button type="button" onClick={() => setCollectionOpen(false)}>暂不采集</button><button type="button" onClick={() => { setCollectionOpen(false); void searchSourceJobs(); }}>确认开始采集</button></div>
    </AtlasSettingsDialog>}
    {connectionError && dataMode === "live" && <div className="atlas-connection-alert" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div className="atlas-connection-alert-copy">
        <strong>本机索引连接未恢复</strong>
        <span>{liveData ? "已读取的岗位仍保留；本次连接未成功。" : "索引尚未读取，暂时无法显示岗位。请重试或检查连接设置。"}</span>
        <details><summary>查看错误详情</summary><p>{connectionError}</p></details>
      </div>
      <div className="atlas-connection-alert-actions">
        <button type="button" disabled={connecting} onClick={retryIndexConnection}><RefreshCw size={14} />重试连接</button>
        <button type="button" onClick={() => setSettings("connection")}>连接设置</button>
      </div>
    </div>}
    {dataMode === "live" && preview && !preview.progress.complete && <AtlasBaselineStatus progress={preview.progress} loading={connecting} onRetry={() => void connect({ endpoint, token }, true)} />}
    {connectionNotice && <p role="status" className="atlas-small">{connectionNotice}</p>}
    {!commandOpen && (indexError || sourceSearchError) && <p className="atlas-error" role="alert">{sourceSearchError || indexError}</p>}
    {active && settings && <AtlasSettingsDialog title={settingsTitles[settings]} onClose={() => setSettings(null)}>
      {settings === "maps" && <div><p>全球与国内均使用同一经纬度视图，可连续缩放至街道。开放底图无需 API Key；联网底图会向所选服务请求当前视野的瓦片，离线轮廓不请求外部地图服务。</p><label className="atlas-basemap-select">底图来源<select value={basemapId} onChange={(e) => { setBasemapId(e.target.value); setMapError(""); }}><option value="auto">OpenFreeMap · 跟随浅深主题</option>{ATLAS_BASEMAPS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}<option value="offline">本地概览 · 离线边界</option></select></label><details className="atlas-settings-disclosure"><summary>覆盖范围、3D 与隐私说明</summary><p className="atlas-small">道路、建筑、门牌和地名是否显示取决于底图覆盖；仅对含高度属性的底图建筑做 3D 表现，不代表实测楼高。离线省域立体效果是概览示意，不代表实测地形。城市级岗位不会显示成精确办公地址。“三维地球”由 Cesium 渲染本地概略边界，不含卫星影像。地图内“实景 3D / 数据与画质”可加载 Google 摄影测量 3D Tiles 或获准使用的 3D Tiles，需自行配置服务权限、Key 与可能的计费；Key 仅保留在当前页面内存。上海街区覆盖需实测，不能用城市中心或模型网格推断办公地址。</p></details></div>}
      {settings === "connection" && <form onSubmit={(e) => { e.preventDefault(); devAutoConnectSuppressed.current = false; clearAtlasDevAutoConnectSuppressed(); restoreConnection.current = false; void connect({ endpoint, token }, true); }}><p>{(import.meta.env?.DEV || readRuntimeConnection()) ? "当前工作台会自动连接配套岗位服务并读取索引，不必手填服务地址和访问令牌。" : "公网页面没有本地开发接口，仍需填写本机服务地址和访问令牌。"}允许当前网页 Origin：<code>{window.location.origin}</code>。连接成功后，访问令牌仅保留在当前标签页的会话存储中，刷新可恢复连接；断开并清除后，这个标签页不会马上再自动连接。令牌不写入永久存储或网址。</p><div className="atlas-form-row"><label>服务地址<input value={endpoint} onChange={(e) => changeConnection("endpoint", e.target.value)} placeholder="http://127.0.0.1:5178" /></label><label>访问令牌<input type="password" autoComplete="off" value={token} onChange={(e) => changeConnection("token", e.target.value)} /></label><button type="submit" disabled={connecting}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{connecting ? "正在连接" : "连接并读取索引"}</button><button type="button" onClick={disconnect}>断开并清除会话连接</button></div>{connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}<p className="atlas-small">读取公开岗位快照，在本页执行共享查询。家庭参照坐标不发送给服务。公网 HTTPS 页面连接本机可能需要浏览器本地网络授权；完整体验建议使用本机网页。</p></form>}
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
          <p>使用 WGS84 坐标计算直线距离，保存在当前浏览器，不发送给岗位服务。城市中心距离会标为估算；可选用快捷地标一键填入，或直接输入坐标。</p>
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
      {settings === "colors" && <div><p>配色依据已核实的最终控股方来源。工作地点不代表企业来源；待核实与证据冲突单列。颜色只影响岗位地图。</p><div className="atlas-color-grid">{colors.rules.map((rule, index) => <label key={rule.id}><input type="color" aria-label={`${rule.label}颜色`} value={rule.color} onChange={(e) => setColors((current) => ({ ...current, rules: current.rules.map((r, n) => n === index ? { ...r, color: e.target.value } : r) }))} /><span>{rule.label}</span></label>)}</div><div className="atlas-form-row"><button onClick={() => { try { localStorage.setItem(COLOR_KEY, JSON.stringify(CompanyColorConfigSchema.parse(colors))); setColorsMessage("配色已保存到当前浏览器。"); } catch { setColorsMessage("浏览器未允许保存，当前页面仍应用此配色。"); } }}>保存配色</button><button onClick={() => { setColors(getDefaultCompanyColorConfig()); setColorsMessage("已恢复默认配色；点击保存可保留。"); }}>恢复默认</button><span role="status">{colorsMessage}</span></div></div>}
    </AtlasSettingsDialog>}
    <details className="atlas-workspace-controls" aria-label="地图搜索与筛选面板" open={commandOpen}>
      <summary onClick={event => { event.preventDefault(); setCommandOpen(open => !open); }}>
        <span>{commandOpen ? "收起" : "展开"}高级选项与运行状态</span>
        <small>{mode === "domestic" ? [chinaFilter.selectedProvince?.name, chinaFilter.selectedCity?.name].filter(Boolean).join(" / ") : [country ? countryName(country) : "", regionText || region].filter(Boolean).join(" / ")}{(chinaFilter.selectedProvince || country || regionText || region) ? " · " : ""}{text.trim() ? `关键词 ${text.trim()} · ` : ""}{result ? `${result.totalJobs.toLocaleString("zh-CN")} 岗命中` : "岗位地图"}</small>
      </summary>
    <div className="atlas-command">
    <div className="atlas-heading">
      <div className="atlas-heading-copy"><span className="atlas-eyebrow">OPPORTUNITY ATLAS</span><h1>{t("让下一个机会，有迹可循。", "Find where your next chapter begins.")}</h1></div>
      <AtlasIllustration compact interactive={false} />
      <AtlasToolbarMenu className="atlas-top-actions" label={<><SlidersHorizontal size={15} aria-hidden="true" />地图与连接</>}>
        <button type="button" data-close-menu onClick={() => setSettings("maps")}><Globe2 size={16} />地图服务</button>
        <button type="button" data-close-menu onClick={() => setSettings("home")}><Home size={16} />{anchor ? t("已设置家庭参照点", "Home set") : t("设置离家距离", "Set home distance")}</button>
        <button type="button" data-close-menu onClick={() => setSettings("connection")}><Database size={16} />{t("连接本机服务", "Connect local service")}</button>
      </AtlasToolbarMenu>
    </div>
    <div className={`atlas-data-banner ${dataMode}`} data-state={indexState}>
      <div className="atlas-data-context" role="status">
        <span className="atlas-status-dot" aria-hidden="true" />
        <strong>{dataMode === "demo" ? "演示模式 · 非真实招聘" : dataMode === "live" ? "真实来源 · 本机索引" : "真实来源 · 当前机会库"}</strong>
        <span className="atlas-data-meta">{dataMode === "demo" ? "合成样本，不计入真实岗位" : dataLoading ? "正在读取索引…" : indexError ? (data ? "连接异常 · 显示上次已读数据" : "索引尚未读取") : data ? `${data.jobs.length.toLocaleString("zh-CN")} 个来源岗位${dataMode === "live" ? ` · 索引版本 ${data.revision}` : ""}` : "等待连接"}</span>
      </div>
      <div className="atlas-data-controls">
        <label className="atlas-data-selector"><span>数据视图</span><select aria-label="岗位数据视图" value={dataMode} onChange={(e) => chooseDataMode(e.target.value as AtlasDataMode)}><option value="local">当前机会库 · 真实来源</option><option value="live">本机采集索引 · 真实来源</option><option value="demo">合成演示 · 仅体验地图</option></select></label>
        <AtlasToolbarMenu className="atlas-banner-tools" label="索引工具">
          {dataMode === "local" && <button type="button" data-close-menu disabled={localLoading} onClick={() => setLocalReload((n) => n + 1)}><RefreshCw size={15} />{localLoading ? "正在读取…" : "重新读取机会库"}</button>}
          {dataMode === "live" && <button type="button" data-close-menu disabled={connecting} onClick={retryIndexConnection}><RefreshCw size={15} />重新读取索引</button>}
          <button type="button" data-close-menu onClick={() => { setSourcesOpen(!sourcesOpen); setReconciliationOpen(false); setSettings(null); }}>来源工具</button>
          {dataMode === "live" && connected && <button type="button" data-close-menu aria-expanded={reconciliationOpen} onClick={() => { setReconciliationOpen(!reconciliationOpen); setSourcesOpen(false); }}>重复岗位核对</button>}
          {onOpenOpportunitySources && <button type="button" data-close-menu onClick={onOpenOpportunitySources}>全平台单岗读取（BOSS · 猎聘 · 51 · 领英 · Seek · Indeed · GradConnection）</button>}
        </AtlasToolbarMenu>
      </div>
    </div>
    {localError && dataMode === "local" && <p role="alert" className="atlas-error">{localError}</p>}
    {dataMode === "local" && !!localData?.jobs.length && localWarnings > 0 && <p className="atlas-small">有 {localWarnings} 项来源字段提示：未提供的日期、结构化薪资与坐标保持未知。查看岗位详情核对原文；投递记录和联系人未进入地图数据。</p>}
    {active && reconciliationOpen && connected && dataMode === "live" && liveData && <Suspense fallback={<p role="status">正在打开重复岗位核对…</p>}><AtlasReconciliationPanel endpoint={endpoint} token={token} data={liveData} onClose={() => setReconciliationOpen(false)} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`已读取岗位处理记录，索引版本 ${snapshot.revision}。列表与地图会按当前来源组合重新计算。`);
    }} /></Suspense>}
    {sourcesOpen && <Suspense fallback={<p role="status">正在加载来源工具…</p>}><AtlasSourcesPanel endpoint={endpoint} token={token} onSnapshot={(snapshot) => { searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live"); }} onClose={() => setSourcesOpen(false)} /></Suspense>}

    <div className="atlas-search-panel">

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
    </div>
    {filtersOpen && <div className="atlas-filters" id="atlas-search-filters" role="region" aria-label="更多岗位筛选">
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
    <AtlasActivityRail
      index={{ state: indexState, value: data?.jobs.length,
        detail: indexError ? "读取异常，可重试连接" : dataLoading ? "正在读取，可先浏览已到达的岗位" : dataMode === "demo" ? "合成样本 · 非真实招聘" : data ? "已收录，可即时筛选" : "连接后自动读取" }}
      collection={{ state: harvestFailed || sourceSearchError ? "attention" : sourceSearching && !harvestCancelled ? "working" : activeLiveHarvest ? "ready" : "idle",
        value: activeLiveHarvest?.totalCards ?? finiteProgressStat(harvestStage?.stats, "cardsFetched"),
        detail: harvestCancelled ? "已停止 · 保留收到的结果" : harvestFailed || sourceSearchError ? "部分未完成 · 查看采集详情" : sourceSearching ? "边采集边入库 · 可继续搜索" : harvestStage?.stage === "completed" ? "本轮已结束 · 覆盖范围见回执" : "按当前关键词与地区采集" }}
      enrichment={{ state: backgroundEnrichment.error || backgroundEnrichment.status?.workerState === "error" || backgroundEnrichment.status?.workerState === "stopped" || (backgroundEnrichment.status?.failed ?? 0) > 0 ? "attention" : backgroundEnrichment.loading || (backgroundEnrichment.status?.pending ?? 0) + (backgroundEnrichment.status?.running ?? 0) > 0 ? "working" : backgroundEnrichment.status ? "ready" : "idle",
        value: backgroundEnrichment.status ? backgroundEnrichment.status.pending + backgroundEnrichment.status.running : undefined,
        detail: backgroundEnrichment.error || backgroundEnrichment.status?.workerState === "error" ? "状态异常 · 任务保留" : backgroundEnrichment.status?.workerState === "stopped" ? "后台已停 · 任务保留" : (backgroundEnrichment.status?.failed ?? 0) > 0 ? "部分任务异常 · 详情见列表" : backgroundEnrichment.status ? "后台自动处理，不阻塞搜索" : "连接后自动跟随入库" }}
      map={{ state: mapError ? "attention" : querying ? "working" : result ? "ready" : "idle", value: result ? mappableJobCount : undefined,
        detail: mapError ? "地图暂不可用 · 列表仍可用" : querying ? "正在更新 · 可继续阅读" : result && !mappableJobCount ? "暂无来源精确坐标" : mapLevel === "location" ? "街道层级 · 来源真实坐标" : "仅展示来源真实坐标" }}
    />
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
    <details className="atlas-more" open={moreOpen || platformSearchOpen}>
      <summary onClick={event => {
        // Native pointer and keyboard activation both dispatch click. Only an
        // explicit summary action owns moreOpen; derived open/toggle events do not.
        event.preventDefault();
        const open = !(moreOpen || platformSearchOpen);
        setMoreOpen(open);
        if (!open) setPlatformSearchOpen(false);
      }}>来源说明、聚合与补全</summary>
    <p className="atlas-small atlas-search-scope">{data ? `输入会实时筛选已收录的 ${data.jobs.length} 个岗位底池` : "索引尚未读取，成功读取后可筛选已收录岗位"}{text.trim() ? `（当前关键词${scopePlace ? `在${scopePlace}` : ""}命中 ${result?.totalJobs ?? 0} 岗）` : ""}；{connected ? `点击“从已配置官网源获取”查询 ${selectedSearchSources.length} 个海外及企业官网源；如需查看商业平台本轮搜索结果，请展开【全网商业平台聚合】。卡片直接来自本轮页面，不依赖是否已入库；地图与办公地点仍来自本机索引。` : "连接本机服务后，可查询已启用来源；全网实时平台抓取需要本机搜索服务。"}读取受页数、滚动和岗位预算约束，逐平台状态会标明实际覆盖。</p>
    <div className={`atlas-antibot-feature-card ${platformSearchOpen ? "open" : ""}`} aria-label="全网平台实时岗位读取">
      <div className="atlas-antibot-header">
        <div className="atlas-antibot-title">
          <ShieldCheck size={16} className="atlas-shield-icon" />
          <strong>全网商业平台聚合（Chrome 页面实时读取）</strong>
          <span className="atlas-antibot-tag">人工完成验证 · 覆盖范围可见</span>
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
        <strong>通过本机真实 Chrome（CDP 端口 9222）读取平台搜索页的岗位卡片。</strong>登录和人机验证由你在浏览器中完成；遇到验证、限流、页面结构变化或预算上限时会停止并标记部分覆盖，不绕过平台防护。实时卡片直接显示本轮结果；只有经过确认的卡片才进入本机索引，地图与办公地点仍使用索引数据。
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
    <AtlasSearchProgress progress={searchProgress} busy={sourceSearching} onCancel={cancelSourceSearch} onReviewSource={setSourceReview} />
    {sourceReview?.receipt && reviewSource && <Suspense fallback={<p role="status">正在加载来源候选核对…</p>}><AtlasSourceCandidateReview key={`${sourceReview.receipt.run.runId}:${endpoint}`} endpoint={endpoint} token={token} source={reviewSource} request={{ scope: sourceReview.receipt.localFilters, maxRecords: sourceReview.receipt.run.scope.maxRecords }} onClose={() => setSourceReview(undefined)} onReview={onSaveOpportunity} /></Suspense>}
    {!sourceSearching && (showHarvestStatus || searchProgress) && (sourceSearchMessage || sourceSearchError)
      ? <details className="atlas-search-diagnostics">
          <summary role={sourceSearchError ? "alert" : undefined}>{sourceSearchError?.includes("未收到本机服务回执")
            ? "未收到本机服务回执；请求标识已保留，重试会先核对结果 · 查看详情"
            : sourceSearchError ? "本轮有来源未完成，已保留收到的结果 · 查看原始消息" : "本轮来源消息 · 查看详情"}</summary>
          {sourceSearchMessage && <p className="atlas-search-notice">{sourceSearchMessage}</p>}
          {sourceSearchError && <p className="atlas-error">{sourceSearchError}</p>}
        </details>
      : <>{sourceSearchMessage && <p role="status" className="atlas-search-notice">{sourceSearchMessage}</p>}{sourceSearchError && <p role="alert" className="atlas-error">{sourceSearchError}</p>}</>}
    <div className="atlas-coverage" aria-label="当前索引筛选覆盖"><span>当前视图 {coverage.totalJobs} 岗{text.trim() || chinaFilter.selectedProvince || country ? `（命中 ${result?.totalJobs ?? 0} 岗）` : ""}</span><span>国家/地区 {coverage.country.jobs} 岗</span><span>可比较年薪 {coverage.salary.jobs} 岗</span><span>可计算距离 {coverage.distance.jobs} 岗</span><span>已核实企业性质 {coverage.ownership.jobs} 岗</span><span>已定位 {coverage.map.jobs} 岗</span></div>
    {connected && dataMode === "live" && Boolean(data?.jobs.length) && <div className="atlas-enrichment-entry"><span>当前页 {visibleItems.length} 条，筛选共 {bucket?.jobCount ?? result?.totalJobs ?? 0} 个岗位（全库 {data?.jobs.length ?? coverage.totalJobs}）。地图只标有来源坐标的岗位。</span><button type="button" disabled={!visibleItems.length} onClick={beginAddressEnrichment}><MapPin size={14} />补全当前结果办公地点</button><small>办公地点补全本次最多读取 50 个未定位结果；来源地址和候选坐标都要核对，不自动生成办公坐标。</small></div>}
    {queryError && <p className="atlas-error" role="alert">{queryError}</p>}
    {computedMetadata.error && <p className="atlas-error" role="alert">{computedMetadata.error}</p>}
    {mapReferences.loading && <p className="atlas-small" role="status"><Loader2 size={14} className="animate-spin" /> 正在读取城市分布参考，岗位列表可继续使用… <button type="button" onClick={mapReferences.cancel}>取消地图参考读取</button></p>}
    {mapReferences.error && <p className="atlas-small" role="status">{mapReferences.error} <button type="button" onClick={mapReferences.retry}>重新读取城市参考</button></p>}
    {mapReferences.result && <div className="atlas-small" aria-label="城市参考数据来源">城市分布采用离线地名数据，保留来源岗位地点；不确认办公地址。{mapReferences.result.provenance?.attribution}{mapReferences.result.truncated && ` · 本次只处理 ${mapReferences.result.processedLocations}/${mapReferences.result.totalLocations} 个地点，未处理地点仍待定位。`}{mapReferences.result.warnings.length > 0 && <details><summary>城市参考范围与提示</summary><ul>{mapReferences.result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}</div>}
    </details>
    </details>
    {showHarvestStatus && <AtlasHarvestProgress
      agentConfig={agentConfig}
      active={active}
      onAskAgent={onAskAgentAboutHarvest}
      progress={harvestStage}
      discoveredCards={liveHarvest?.totalCards}
      providers={liveHarvest?.providers}
      importFailures={harvestImportFailures}
      failureMessage={harvestFailureMessage}
      busy={sourceSearching && !harvestCancelled && !harvestFailed && harvestStage?.stage !== "completed"}
      cancelled={harvestCancelled}
      failed={harvestFailed}
      onCancel={sourceSearching && !harvestFailed && harvestStage?.stage !== "completed" ? cancelSourceSearch : undefined}
      onOpenLogin={() => setAuthHubOpen(true)}
      onResume={harvestRecovery.state.canResume && !sourceSearching ? () => void harvestRecovery.continuePrevious().catch(() => { /* The status keeps the actual recovery error visible. */ }) : undefined}
      recoveryMessage={harvestRecovery.state.message}
      recoveryPhase={harvestRecovery.state.phase}
    />}
    {dataMode === "live" && connected && result && noPreciseLocationJobCount > 0 && <div className="atlas-address-coverage" aria-label="地图地址覆盖" role="status">
      <div><strong>{mappableCoordinateCount.toLocaleString("zh-CN")} 个坐标点 · {mappableLocationCount.toLocaleString("zh-CN")} 个来源地址 · 覆盖 {mappableJobCount.toLocaleString("zh-CN")} 岗</strong>
        <span>{noPreciseLocationJobCount.toLocaleString("zh-CN")} 个岗位暂无可验证办公地址；城市 / 区域不作为办公地址。</span></div>
      <button type="button" disabled={!unlocatedVisibleItems.length} onClick={beginAddressEnrichment}><MapPin size={14} />补全当前结果办公地点</button>
    </div>}
    <AtlasWorkbench detailKey={readingRevision} mapFocusKey={focus?.requestId} onCloseDetail={() => { closeJob(); setDetailReviewJobId(""); setEnrichmentScope(null); }} active={active} layout={layout} hasDetail={Boolean((selected && data) || detailReviewJobId || enrichmentScope)} empty={emptyIndex}
      map={<div className="atlas-map-column"><div className={`atlas-map-card ${theme}`}><AtlasMapToolbar mode={mode} onModeChange={changeMapMode} viewMode={mapPresentation.mode} onViewChange={(mode, animate) => { setMapPresentation({ mode, animate }); setRotating(false); }} rotating={rotating} onToggleRotation={() => setRotating(!rotating)} onReset={resetCamera} globalLabel={t("全球", "Global")} domesticLabel={t("国内", "China")} /><div className="atlas-scene" ref={scene}>{active && <Suspense fallback={<div className="atlas-map-loading"><span className="atlas-map-loading-stack" aria-hidden="true"><i /><i /><i /></span><strong>正在准备地图</strong><small>岗位列表可先浏览，地图随后就绪。</small></div>}><AtlasMap resetRevision={mapKey} mode={mode} basemap={basemapId === "offline" ? null : basemapId === "auto" ? undefined : ATLAS_BASEMAPS.find((p) => p.id === basemapId)} buckets={locatedBuckets} geometry={result ? resultGeometry : undefined} framingKey={selectionKey} bounds={displayFrame?.bounds} boundsMaxZoom={displayFrame?.maxZoom} adminBoundary={adminBoundary} selectedBucketId={bucket?.id} selectedRegionId={mode === "domestic" ? chinaFilter.selectedProvince?.mapId : region || country || undefined} initialView={camera.current} focus={focus} selectedJobId={selectedId} visual={{ viewMode: mapPresentation.mode, animateViewChange: mapPresentation.animate, autoRotate: rotating && !sourceSearching, maxDpr: 1.5, pedestal: true, entrance: true, theme }} onViewChange={(view) => { camera.current = view; setMapZoom(previous => (previous >= 10) === (view.zoom >= 10) ? previous : view.zoom); }} onPick={setBucket} onActivateBucket={activateMapBucket} onCountry={(pick) => { if (mode === "domestic") { const province = findChinaProvinceByMapId(pick.id); if (province) setChinaSelection({ provinceCode: province.code }); else setSourceSearchMessage("该区域尚未纳入当前国内行政目录，请按来源披露地点查询。"); } else if (pick.countryCode) { setCountry(pick.countryCode); setRegion(""); setRegionText(""); } }} onError={(error) => setMapError(error.message)} /></Suspense>}{!querying && !sourceSearching && !connecting && !locatedBuckets.length && (result?.totalJobs ?? 0) > 0 && <div className={`atlas-map-empty-overlay ${theme}`} role="status"><AtlasIllustration kind="discovery" interactive={false} /><strong>暂无可验证办公地址</strong><span>当前 {result?.totalJobs.toLocaleString()} 个匹配岗位只有城市或区域信息，地图不会绘制虚构点位。</span>{text.trim() && <button type="button" onClick={() => setText("")}><Search size={13} />扩大到全部关键词结果</button>}{connected && dataMode === "live" && visibleItems.length > 0 && <button type="button" onClick={() => { cancelOfficeFocus(); setDetailReviewJobId(""); setEnrichmentScope(visibleItems.slice(0, 50).map(item => item.job.id)); }}><MapPin size={13} />补全当前结果办公地点</button>}<small>补全后，来源披露或本人核对的真实坐标会出现在地图上，并可直接点击。</small></div>}</div>{mapError && <div role="alert" className="atlas-render-error">三维地图暂不可用：{mapError}。岗位列表仍可使用。<button onClick={() => { setMapKey((k) => k + 1); setMapError(""); }}>重试</button></div>}</div>
      <div className="atlas-map-footer"><div className="atlas-stat-grid" aria-live="polite">{[[result?.totalJobs ?? 0, "匹配岗位"], [result?.companyCount ?? 0, "企业"], [mappableCoordinateCount, "坐标点"], [noPreciseLocationJobCount, "无精确位置岗位"]].map(([number, label]) => <div key={label}><strong>{!result ? "—" : number}</strong><span>{label}</span></div>)}</div>{mappableLocationCount > 0 && <small className="atlas-map-coordinate-note" aria-label="地图坐标统计">地图当前绘制 {mappableCoordinateCount} 个真实坐标，承载 {mappableLocationCount} 个来源地址、{mappableJobCount} 个岗位；同坐标地址已合并显示，点击可逐个选择。</small>}</div></div>}
      jobs={<aside className={`atlas-results ${activeLiveHarvest ? "is-live-source-results" : ""}`}>
        <div className="atlas-results-heading">
          <div className="atlas-results-heading-left">
            <span className="atlas-eyebrow">YOUR OPPORTUNITY RADAR</span>
            <h2>
              {activeLiveHarvest ? "原站实时岗位" : bucket ? bucket.label : t("探索机会", "Explore opportunities")}{" "}
              <span>{activeLiveHarvest ? activeLiveHarvest.totalCards : bucket ? bucket.jobCount : result?.totalJobs ?? "—"}</span>
            </h2>
            {!activeLiveHarvest && result && (
              <p className="atlas-results-map-summary" role="status">
                <MapPin size={12} aria-hidden="true" />
                {mappableCoordinateCount.toLocaleString("zh-CN")} 个坐标点 · {mappableLocationCount.toLocaleString("zh-CN")} 个来源地址 · 覆盖 {mappableJobCount.toLocaleString("zh-CN")} 岗
              </p>
            )}
            {bucket && <p className="atlas-selected-location-note" role="status">地图点位 · {mapBucketPrecisionLabel(bucket)} · 招聘来源见下方岗位详情</p>}
          </div>
          <div className="atlas-results-heading-actions">
            {liveHarvest && matchesLiveHarvestQuery(liveHarvest, liveHarvestQuery) && !bucket && (
              <button type="button" className="atlas-city-clear-btn" onClick={() => setPreferLiveResults(!preferLiveResults)}>
                {activeLiveHarvest ? "查看索引" : "查看实时结果"}
              </button>
            )}
            {activeLiveHarvest && <button type="button" className="atlas-city-clear-btn" disabled={sourceSearching} onClick={() => void searchLivePlatformsOnly()}>重新实时抓取</button>}
            {querying && <Loader2 size={16} className="animate-spin text-emerald-500" />}
            {bucket && (
              <button
                type="button"
                className="atlas-city-clear-btn"
              aria-label="取消位置选择"
                onClick={() => setBucket(null)}
                title="返回全部位置"
              >
                <X size={13} />
                <span>清除位置</span>
              </button>
            )}
            <button
              type="button"
              hidden={Boolean(activeLiveHarvest)}
              className={`atlas-filter-toggle-btn ${filtersCollapsed ? "is-collapsed" : "is-expanded"}`}
              onClick={() => setFiltersCollapsed((prev) => !prev)}
              aria-expanded={!filtersCollapsed}
              aria-controls="atlas-quick-filters"
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

        <div id="atlas-quick-filters" className={`atlas-quick-filters ${filtersCollapsed ? "is-collapsed" : ""}`} hidden={filtersCollapsed || Boolean(activeLiveHarvest)} role="group" aria-label="岗位多维快捷筛选">
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
      <AtlasBackgroundEnrichmentStatus state={backgroundEnrichment} />
      {!showHarvestStatus && harvestRecovery.state.message && <div className="atlas-harvest-recovery" data-phase={harvestRecovery.state.phase} role={harvestRecovery.state.phase === "error" ? "alert" : "status"}>
        <Database size={14} aria-hidden="true" />
        <span>{sanitizeHarvestDiagnostic(harvestRecovery.state.message)}</span>
        {harvestRecovery.state.canResume && <button type="button" disabled={sourceSearching} onClick={() => void harvestRecovery.continuePrevious().catch(() => { /* The independent status exposes its error. */ })}>继续上次采集</button>}
      </div>}
      {result && resultData !== data && <p className="atlas-small atlas-query-refresh" role="status">索引有更新，正在同步当前结果；可以继续阅读。</p>}
      {activeLiveHarvest && <AtlasLiveHarvestResults view={activeLiveHarvest} compactHeading busy={sourceSearching && (!activeLiveHarvest.providers.length || activeLiveHarvest.providers.some(provider => provider.status === "queued" || provider.status === "running"))} />}
      {liveCommitStats && !(showHarvestStatus && harvestStage?.stats?.totalAdded === liveCommitStats.totalAdded && harvestStage?.stats?.totalUpdated === liveCommitStats.totalUpdated) && <p className="atlas-small" role="status">本轮已提交：新增 {liveCommitStats.totalAdded} 岗 · 更新 {liveCommitStats.totalUpdated} 岗。地图仍需来源披露的精确坐标。</p>}
      {text.trim() && !sourceSearching && penetratedCount > 0 && !aiBannerDismissed && (
        <div className="atlas-ai-penetration-banner" role="status">
          <div className="atlas-ai-banner-header">
            <div className="atlas-ai-banner-badge-group">
              <span className="atlas-ai-badge-pill">
                <Sparkles size={11} className="atlas-ai-sparkle-icon" />
                AI 穿透定位
              </span>
              <span className="atlas-ai-banner-headline">
                当前筛选内 <strong>{penetratedCount}</strong> 个技术栈匹配的通用标题岗位
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
              JD 包含 “<strong>{text.trim()}</strong>” 相关技术栈；“仅看穿透”会隐藏标题直接命中的岗位。
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
                title="读取原站分页结果并入库；地图仅显示已有真实地址坐标的岗位"
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
                本机索引当前命中 <strong>{bucket ? bucket.jobCount : result?.totalJobs ?? (querying ? "—" : 0)}</strong> 岗 / 库内共 {data?.jobs.length ?? 0} 岗；原站本轮采集数量见实时回执。
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
              title="读取原站分页结果并入库；地图仅显示已有真实地址坐标的岗位"
            >
              <RefreshCw size={13} />
              全网重新抓取
            </button>
          </div>
        </div>
      )}
      <details className="atlas-sort-fold"><summary>{sort === "relevance" ? "相关度" : sort === "salary" ? "年薪" : sort === "distance" ? "距离" : "更新"} · {direction === "desc" ? "降序" : "升序"}</summary><div className="atlas-sort"><select aria-label="岗位排序" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="salary" disabled={!coverage.salary.sortSupported}>人民币税前年薪下限{!coverage.salary.sortSupported ? " · 暂无可比数据" : ""}</option><option value="distance" disabled={!coverage.distance.ready}>离家直线距离{!coverage.distance.supported ? " · 缺岗位坐标" : !anchor ? " · 请设参照点" : ""}</option><option value="updated">最近更新</option></select><button aria-label={direction === "desc" ? "当前降序，切换升序" : "当前升序，切换降序"} onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}><ArrowDownUp size={14} />{direction === "desc" ? "降序" : "升序"}</button><label><input type="checkbox" checked={originalCurrency} onChange={(e) => setOriginalCurrency(e.target.checked)} />原币</label><select aria-label="每页条数" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}><option value={30}>每页 30 岗</option><option value={50}>每页 50 岗</option><option value={100}>每页 100 岗</option><option value={200}>每页 200 岗</option></select></div></details><div className="atlas-job-list" aria-busy={querying || sourceSearching}>{(querying || sourceSearching) && !visibleItems.length && <div className="atlas-results-loading" role="status"><span>{sourceSearching ? "正在从真实来源获取岗位…" : "正在匹配岗位…"}</span>{[0, 1, 2].map((n) => <div key={n} className="atlas-skeleton-card" aria-hidden="true"><i /><i /><i /></div>)}</div>}{visibleItems.map((item) => {
  return (
    <div className="atlas-job-card-row" key={item.job.id}>
    <button
      type="button"
      className={`atlas-job-card ${selectedId === item.job.id ? "selected" : ""}`}
      aria-expanded={selectedId === item.job.id}
      aria-controls="atlas-job-detail"
      onClick={() => openJob(item)}
      onDoubleClick={() => { void locateJob(item); }}
    >
      <AtlasJobCardContent item={item} presentListing={presentListing} data={data} hasAnchor={Boolean(anchor)} keyword={text} countryName={countryName} />
    </button>
    <button type="button" className="atlas-job-locate" aria-label={"在地图定位：" + item.job.title.value} title="在地图定位；未披露坐标时先核对地点" onClick={() => void locateJob(item)}><MapPin size={16} aria-hidden="true" /></button>
    </div>
  );
})}{!activeLiveHarvest && !visibleItems.length && !querying && !sourceSearching && (
  (text.trim() || chinaFilter.selectedProvince || regionText.trim() || country) && !emptyIndex && data ? (
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
    <div className="atlas-empty">
      {!dataLoading && <AtlasIllustration kind={emptyIndex || !data ? "discovery" : "search"} />}
      <strong>{dataLoading ? "正在读取岗位…" : emptyIndex ? "先把真实岗位接入地图" : !data && dataMode === "live" ? "连接本机索引，查看已采集岗位" : "暂未找到匹配岗位"}</strong>
      <p>{dataLoading ? "已读取的岗位会逐步显示，地图随后更新。" : emptyIndex ? "连接本机采集索引，或读取并收藏招聘原文。岗位会逐步出现，地区与企业在后台自动补全。" : !data && dataMode === "live" ? "暂未取得本机岗位数据。请检查服务连接；已有数据不会因此清空。" : "已收录岗位中没有匹配项。可以清除筛选、扩大地区范围，或继续读取招聘来源。"}</p>
      {!dataLoading && <div className="atlas-empty-actions">
        {emptyIndex || !data ? <>
          <button className="atlas-empty-primary" onClick={() => connected ? setCollectionOpen(true) : setSettings("connection")}>{connected ? searchableSources.length ? "从已配置来源获取岗位" : "配置岗位来源" : "连接真实来源搜索"}</button>
          {onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>读取并收藏单个岗位</button>}
        </> : <button className="atlas-empty-primary" onClick={resetFilters}>清除筛选</button>}
        <button type="button" className="atlas-empty-btn-platform" onClick={() => { setCommandOpen(true); setPlatformSearchOpen(true); }}>查看招聘平台与采集选项</button>
        {resumePrefill.hasResumeData && <button type="button" className="atlas-empty-btn-prefill" onClick={applyResumePrefill}><Sparkles size={14} />参考当前简历自动填入（{resumePrefill.summaryLabel}）</button>}
      </div>}
    </div>
  )
)}{result && (listPage?.totalJobs ?? 0) > pageSize && <nav className="atlas-pager" aria-label="岗位分页"><button type="button" disabled={pageIndex === 0 || querying} onClick={() => setPageIndex((index) => Math.max(0, index - 1))}>上一页</button><span>第 {pageIndex * pageSize + 1}–{pageIndex * pageSize + visibleItems.length} 条，共 {listPage?.totalJobs ?? 0} 条</span><button type="button" disabled={querying || (pageIndex + 1) * pageSize >= (listPage?.totalJobs ?? 0)} onClick={() => setPageIndex((index) => index + 1)}>下一页</button></nav>}</div><details className="atlas-list-note"><summary>薪资比较口径</summary><p>统一比较税前固定年薪，奖金与股票不混入。未知薪资、缺少有效汇率和未知距离放在排序末尾。{result?.unknownSalaryCount ?? 0} 个岗位薪资暂不可比较。</p></details></aside>}
    detail={<>
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
    {!enrichmentScope && !detailReviewJobId && selected && data && <AtlasJobDetail key={selected.job.id} item={selected} data={displayedData ?? data} searchQuery={text} demo={dataMode === "demo"} originalCurrency={originalCurrency} presentations={presentListing?.(selected) ?? []} onClose={closeJob} onLocate={(locationId) => void locateJob(selected, locationId)} onSave={() => routeJob(selected, false)} onAnalyze={() => routeJob(selected, true)} onConfirmLocation={connected && resultData === data ? location => { setOfficeReview(undefined); setLocationReview({ jobId: selected.job.id, location }); } : undefined} onConfirmOffice={connected && resultData === data ? location => { setLocationReview(undefined); setOfficeReview({ jobId: selected.job.id, location }); } : undefined} onReadLocations={connected && selected.job.listingIds.some(id => data.listings.find(listing => listing.id === id)?.sourceId.startsWith("reviewed-platform-")) ? () => setDetailReviewJobId(selected.job.id) : undefined}>
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
    </>} />
    <div className="atlas-map-notes">
      <p className="atlas-small" aria-label="地图位置口径">地图按来源坐标绘制地址、街道与本人核对的位置；城市估算不作为办公地址落点。没有足够精度坐标的岗位仍保留在列表中。</p>
      <div className="atlas-precision-legend" aria-label="地图位置精度说明"><strong>位置精度</strong><span><i className="building" />本人核对 · 楼宇 / 入口 / 园区</span><span><i className="street" />街道级来源坐标</span><span><i className="address" />地址级来源坐标</span><small>点位可点选；重叠时可选择具体地址</small></div>
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
