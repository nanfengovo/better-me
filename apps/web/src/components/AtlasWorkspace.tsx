import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, ArrowUpRight, Compass, Database, Globe2, Home, Loader2, MapPin, Palette, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, normalizeSearchText, type AtlasDataset, type CompanyColorConfig, type JobLocation, type JobQueryInput, type JobQueryResult, type JobSearchItem, type QueryOptions, type GeocodingResult, type GeocodingCandidate, type OfficeAddressCandidate } from "@better-me/opportunities";
import type { OpportunitySeed } from "./OpportunityWorkspace";
import { createAtlasDemo } from "./atlas/demo";
import type { AtlasCamera } from "./atlas/prototypes/types";
import { selectAtlasBuckets, type AtlasBucketSelection } from "./atlas/prototypes/bucket-selection";
import { ATLAS_BASEMAPS } from "./atlas/prototypes/basemaps";
import { buildAtlasJobAction, queryAtlasPage, readAtlasSnapshot, type AtlasJobAction } from "./atlas/client";
import { readOpportunityLibrary } from "../lib/opportunities";
import { projectLocalOpportunities } from "./atlas/local-opportunities";
import { createAtlasSourceClient } from "./atlas/service-client";
import { useAtlasMapReferences } from "./atlas/use-atlas-map-references";
import { useAtlasFxContext } from "./atlas/useAtlasFxContext";
import { useAtlasFxRecovery } from "./atlas/fx-recovery";
import { useAtlasCompanyControlRecovery } from "./atlas/company-control-recovery";
import { atlasSourceScanRecoveryScope, readAtlasSourceScanRecovery, useAtlasSourceScanRecovery } from "./atlas/source-scan-recovery";
import { atlasAggregateRecoveryScope, beginAtlasAggregateRecovery, endAtlasAggregateRecovery, readAtlasAggregateRecovery, rejectAtlasAggregateRequest, retainAtlasAggregateRequest, saveAtlasAggregateReceipt, settleAtlasAggregateReceipt, useAtlasAggregateRecovery } from "./atlas/aggregate-recovery";
import { AtlasAggregateRecoveryControls } from "./atlas/AtlasAggregateRecoveryControls";
import { atlasLeadRecoveryScope, readAtlasLeadRecovery, useAtlasLeadRecovery } from "./atlas/lead-recovery";
import { clearAtlasConnectionSession, DEFAULT_ATLAS_BACKEND_ENDPOINT, DEFAULT_ATLAS_ENDPOINT, readAtlasConnectionSession, writeAtlasConnectionSession, type AtlasConnectionIdentity, type AtlasDataMode } from "./atlas/connection-session";
import { isDefaultAtlasEndpoint } from "./atlas/backend-connection";
import { runAtlasSourceSearch, type AtlasAggregateProgress, type AtlasAggregateSource } from "./atlas/aggregate-search";
import { AtlasSearchProgress } from "./atlas/AtlasSearchProgress";
import { AtlasJobDetail } from "./atlas/AtlasJobDetail";
import { useAtlasPaneLayout } from "./atlas/use-atlas-pane-layout";
import { createJobMapFocus, createOfficeCandidateMapFocus, type AtlasMapFocus } from "./atlas/map-focus";
import { buildAtlasCityCandidateQuery } from "./atlas/city-candidate-query";
import { getAtlasDataCoverage } from "./atlas/coverage";
import { createAtlasListingPresenter } from "./atlas/presentation";
import { AtlasListingBadges } from "./atlas/JobSourceBadges";
import { PlatformSearchLinks, type PlatformSearchLinksProps } from "./atlas/PlatformSearchLinks";
import { buildChinaRegionFilter, findChinaProvinceByMapId, getChinaProvinces, getChinaCities, getChinaDistricts, type ChinaRegionSelection } from "./atlas/china-regions";
import countryCatalog from "../../../../config/geography/countries.json";
import { useUiPreferences } from "../lib/ui-preferences";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters/browser-contracts";
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
const AtlasCompensationReview = lazy(() => import("./atlas/AtlasCompensationReview").then(module => ({ default: module.AtlasCompensationReview })));
const AtlasFxPanel = lazy(() => import("./atlas/AtlasFxPanel").then(module => ({ default: module.AtlasFxPanel })));
const AtlasCompanyControlReview = lazy(() => import("./atlas/AtlasCompanyControlReview").then(module => ({ default: module.AtlasCompanyControlReview })));
const COLOR_KEY = "better-me:atlas-colors:v1";
type Props = { active?: boolean; onSaveOpportunity: (seed: OpportunitySeed) => void; onAnalyze: (item: AtlasJobAction) => void; onOpenOpportunitySources?: () => void };
const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["zh"], { type: "region" }) : undefined;
const countryName = (code: string) => regionNames?.of(code) ?? code;
const annual = (value?: { currency: string; min?: number; max?: number }) => value ? `${value.currency} ${value.min === undefined ? "?" : (value.min / 10000).toFixed(1)}–${value.max === undefined ? "?" : (value.max / 10000).toFixed(1)} 万 / 年` : "薪资待核实";
function initialColors(): CompanyColorConfig {
  try { const saved = localStorage.getItem(COLOR_KEY); if (saved) return CompanyColorConfigSchema.parse(JSON.parse(saved)); } catch { /* Defaults remain available when storage is blocked. */ }
  return getDefaultCompanyColorConfig();
}

export default function AtlasWorkspace({ active = true, onSaveOpportunity, onAnalyze, onOpenOpportunitySources }: Props) {
  const { t, theme } = useUiPreferences();
  const { workspace, layout } = useAtlasPaneLayout(active);
  const [demo] = useState(createAtlasDemo);
  const [initialConnection] = useState(() => readAtlasConnectionSession() ?? { schemaVersion: 1 as const, dataMode: "live" as const, endpoint: DEFAULT_ATLAS_BACKEND_ENDPOINT, token: "" });
  const restoreConnection = useRef(initialConnection?.dataMode === "live");
  const [liveData, setLiveData] = useState<AtlasDataset | null>(null);
  const [dataMode, setDataMode] = useState<AtlasDataMode>(initialConnection.dataMode);
  const [localData, setLocalData] = useState<AtlasDataset | null>(null);
  const [localError, setLocalError] = useState("");
  const [localWarnings, setLocalWarnings] = useState(0);
  const [localLoading, setLocalLoading] = useState(false);
  const [publicationNow, setPublicationNow] = useState(() => new Date().toISOString());
  const [localReload, setLocalReload] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [searchSourceId, setSearchSourceId] = useState("");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<AtlasAggregateProgress | null>(null);
  const [sourceReview, setSourceReview] = useState<AtlasAggregateSource>();
  const [cardReview, setCardReview] = useState<ReviewedCardsCapture>();
  const activeCardReview = useRef(cardReview); activeCardReview.current = cardReview;
  const cardWritePending = useRef<ReviewedCardsCapture | undefined>(undefined);
  function retainPendingCardWrite() {
    if (!cardWritePending.current) return false;
    setSourceSearchMessage("卡片写入结果尚未确认，请先在原卡片核对面板重试本次写入、核对回执，再关闭、切换后端或核对其他批次。");
    return true;
  }
  const [locationReview, setLocationReview] = useState<{ jobId: string; location: JobLocation }>();
  const [officeReview, setOfficeReview] = useState<{ jobId: string; location: JobLocation; prefillFromSourceAddress?: boolean }>();
  const [detailReviewJobId, setDetailReviewJobId] = useState("");
  const [compensationReviewJobId, setCompensationReviewJobId] = useState("");
  const [companyReview, setCompanyReview] = useState<{ jobId: string; companyId: string }>();
  const [enrichmentScope, setEnrichmentScope] = useState<string[] | null>(null);
  const [locationChoices, setLocationChoices] = useState<string>();
  const [officeFocusRequest, setOfficeFocusRequest] = useState<{ id: string; jobId: string; locationId: string; snapshot: AtlasDataset; selectionKey: string; endpoint: string; token: string }>();
  const [leadJobRequest, setLeadJobRequest] = useState<{ jobId: string; snapshot: AtlasDataset; endpoint: string; token: string }>();
  const officeFocusAbort = useRef<AbortController | null>(null);
  const officeFocusApplied = useRef<string | undefined>(undefined);
  const recoveredOfficeSelection = useRef<{ data: AtlasDataset; selectionKey: string; jobId: string } | undefined>(undefined);
  function cancelOfficeFocus() { officeFocusAbort.current?.abort(); officeFocusAbort.current = null; setOfficeFocusRequest(undefined); recoveredOfficeSelection.current = undefined; }
  const [searchDepth, setSearchDepth] = useState("standard");
  const [sourceSearchMessage, setSourceSearchMessage] = useState("");
  const [sourceSearchError, setSourceSearchError] = useState("");
  const searchAbort = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"global" | "domestic">("global");
  const [text, setText] = useState("");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [regionText, setRegionText] = useState("");
  const [chinaSelection, setChinaSelection] = useState<ChinaRegionSelection>({});
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
  const [settings, setSettings] = useState<"connection" | "home" | "colors" | "maps" | null>(null);
  const [endpoint, setEndpoint] = useState(initialConnection.dataMode === "live" ? initialConnection.endpoint : DEFAULT_ATLAS_BACKEND_ENDPOINT);
  const [token, setToken] = useState(initialConnection?.dataMode === "live" ? initialConnection.token : "");
  const leadConnection = useRef({ endpoint, token }); leadConnection.current = { endpoint, token };
  useEffect(() => { setDetailReviewJobId(""); setCompensationReviewJobId(""); setCompanyReview(undefined); setEnrichmentScope(null); setFxOpen(false); }, [endpoint, token, dataMode, active]);
  const fxRecovery = useAtlasFxRecovery(endpoint, token);
  const fxWritePending = dataMode === "live" && Boolean(fxRecovery.pending || fxRecovery.saved);
  const companyRecovery = useAtlasCompanyControlRecovery(endpoint, token);
  const companyWritePending = dataMode === "live" && Boolean(companyRecovery.pending || companyRecovery.saved);
  const scanRecovery = useAtlasSourceScanRecovery(endpoint, token);
  const scanWritePending = dataMode === "live" && Boolean(scanRecovery.pending || scanRecovery.saved || scanRecovery.refreshOnly);
  const aggregateRecovery = useAtlasAggregateRecovery(endpoint, token);
  const aggregateWritePending = aggregateRecovery.active || aggregateRecovery.entries.length > 0;
  const leadRecovery = useAtlasLeadRecovery(endpoint, token);
  const leadWritePending = Boolean(leadRecovery.pending || leadRecovery.saved || leadRecovery.active);
  useEffect(() => {
    if (!leadWritePending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [leadWritePending]);
  const queryWritePending = fxWritePending || companyWritePending || scanWritePending || leadWritePending;
  const [connecting, setConnecting] = useState(false);
  const connectionAbort = useRef<AbortController | null>(null);
  const connectedIdentity = useRef<{ endpoint: string; token: string } | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [anchor, setAnchor] = useState<QueryOptions["anchor"]>();
  const [homeError, setHomeError] = useState("");
  const [colors, setColors] = useState(initialColors);
  const [colorsMessage, setColorsMessage] = useState("");
  const [rawResult, setResult] = useState<JobQueryResult | null>(null);
  const [resultData, setResultData] = useState<AtlasDataset | null>(null);
  const [resultOptions, setResultOptions] = useState<QueryOptions | null>(null);
  const [queryError, setQueryError] = useState("");
  const [querying, setQuerying] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  useEffect(() => { setLocationReview(undefined); }, [selectedId, endpoint, token]);
  const [bucket, setBucket] = useState<AtlasBucketSelection | null>(null);
  const [mapError, setMapError] = useState("");
  const [rotating, setRotating] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [listPage, setListPage] = useState<JobQueryResult | null>(null);
  const [listItems, setListItems] = useState<JobSearchItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mapZoom, setMapZoom] = useState(1.5);
  const camera = useRef<AtlasCamera | undefined>(undefined);
  // A camera snapshot is only reusable within the mode that created it. Without
  // this guard a late moveend from the global scene can restore a world-scale
  // camera after the domestic renderer has mounted.
  const cameraMode = useRef<"global" | "domestic" | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);
  const [basemapId, setBasemapId] = useState("auto");
  const [focus, setFocus] = useState<AtlasMapFocus>();
  const [locationSearch, setLocationSearch] = useState<{ jobId: string; locationId: string; result?: GeocodingResult; loading: boolean; error?: string }>();
  const locationAbort = useRef<AbortController | null>(null);
  const selectedCard = useRef<JobSearchItem | undefined>(undefined);
  const cardClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function cancelCardClick() { clearTimeout(cardClickTimer.current); cardClickTimer.current = undefined; }
  const queryAbort = useRef<AbortController | null>(null);
  const completedQuery = useRef<{ data: AtlasDataset; options: QueryOptions; bucket: AtlasBucketSelection | null } | undefined>(undefined);
  const data = dataMode === "demo" ? demo : dataMode === "live" ? liveData : localData;
  const connected = Boolean(!connectionError && liveData && connectedIdentity.current?.endpoint === endpoint && connectedIdentity.current.token === token);
  const mapReferences = useAtlasMapReferences({ active, dataMode, connected, endpoint, token, snapshot: dataMode === "live" ? liveData : null });
  const fxContext = useAtlasFxContext({ active, dataMode, connected, endpoint, token, snapshot: dataMode === "live" ? liveData : null, asOfDay: publicationNow.slice(0, 10) });
  const fxReady = fxContext.ready && !queryWritePending;
  const searchableSources = (connected ? liveData?.sources : [])?.filter((entry) => entry.enabled && entry.status === "active" && entry.entityType === "job-posting" && entry.runtime.includes("local-service") && entry.capabilities.includes("list-jobs") && entry.entryUrl) ?? [];
  const selectedSearchSources = searchSourceId ? searchableSources.filter((entry) => entry.sourceId === searchSourceId) : searchableSources;
  const reviewSource = sourceReview ? liveData?.sources.find((entry) => entry.sourceId === sourceReview.sourceId) : undefined;
  useEffect(() => { setSourceReview(undefined); setCardReview(undefined); }, [endpoint, token]);
  const emptyIndex = !!data && !data.jobs.length;
  const dataLoading = connecting || (dataMode === "local" && localLoading) || fxContext.loading || queryWritePending;
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
  const coverageNow = fxContext.context?.asOf ?? publicationNow;
  const currentFx = dataMode === "live" ? fxContext.context?.activeSnapshot?.fx : undefined;
  const coverage = useMemo(() => getAtlasDataCoverage(fxReady ? data : null, { anchor, now: coverageNow, fx: currentFx, includeEstimates: false, allowCityEstimate: true, workCountryCodes: country ? [country] : mode === "domestic" ? (chinaSelection.provinceCode && ["HK", "MO", "TW"].includes(chinaSelection.provinceCode) ? [chinaSelection.provinceCode] : countryCatalog.domesticCountryCodes) : [] }), [data, fxReady, currentFx, anchor, coverageNow, country, mode, chinaSelection.provinceCode]);
  const countries = useMemo(() => [...new Set([...countryCatalog.countries, ...coverage.country.values])].sort((a, b) => countryName(a).localeCompare(countryName(b), "zh")), [coverage.country.values]);
  const origins = coverage.controller.values;
  const regions = coverage.region.options.filter((entry) => !country || entry.countryCodes.includes(country));
  const chinaFilter = useMemo(() => buildChinaRegionFilter(chinaSelection), [chinaSelection]);
  const chinaCities = getChinaCities(chinaSelection.provinceCode ?? "");
  const chinaDistricts = getChinaDistricts(chinaSelection.provinceCode ?? "", chinaSelection.cityCode ?? "");
  const mapLevel = mapZoom >= 10 ? "location" : "city";
  const query = useMemo<JobQueryInput>(() => ({
    search: text.trim() ? { text, mode: "fuzzy" } : undefined,
    market: mode === "domestic" ? "domestic" : "global",
    includeUnknownLocations: mode === "global" || includeUnclassified,
    workCountryCodes: mode === "domestic" ? chinaFilter.workCountryCodes : country ? [country] : [],
    workRegionIds: mode === "domestic" ? [] : region ? [region] : [],
    workRegionText: mode === "domestic" ? undefined : regionText.trim() || undefined,
    workRegionGroups: mode === "domestic" ? chinaFilter.workRegionGroups : undefined,
    controllerJurisdictions: origin ? [origin] : [],
    ownershipKinds: ownership ? [ownership as "state" | "private" | "unknown" | "joint" | "dispersed"] : [],
    sourceIds: source ? [source] : [],
    salary: { range: salaryMin || salaryMax ? { min: salaryMin ? Number(salaryMin) * 10000 : undefined, max: salaryMax ? Number(salaryMax) * 10000 : undefined } : undefined, metric: "min", includeEstimates: false, includeUnknown: !salaryMin && !salaryMax },
    distance: anchor ? { anchorRef: anchor.ref, maxKm: maxKm ? Number(maxKm) : undefined, allowCityEstimate: true, includeUnknown: !maxKm } : undefined,
    sort: { field: sort, direction }, mapLevel, page: { limit: 30 },
  }), [text, mode, country, region, regionText, chinaFilter, origin, ownership, source, salaryMin, salaryMax, anchor, maxKm, sort, direction, mapLevel, includeUnclassified]);
  const generation = useMemo(() => ({ data, query, now: new Date().toISOString() }), [data, query]);
  const queryOptions = useMemo<QueryOptions>(() => ({ now: fxContext.context?.asOf ?? generation.now, fx: currentFx, colorConfig: colors, anchor, domesticCountryCodes: countryCatalog.domesticCountryCodes, ...(mapReferences.result ? { mapReferences: mapReferences.result } : {}) }), [generation, fxContext.context, currentFx, colors, anchor, mapReferences.result]);
  const resultCurrent = fxReady && resultData === data && resultOptions === queryOptions;
  const result = resultCurrent ? rawResult : null;
  const selectedMapBucketIds = useMemo(() => {
    if (!bucket && !selectedId) return undefined;
    const selected = new Set(bucket?.jobIds ?? []);
    if (selectedId) selected.add(selectedId);
    const ids = result?.mapBuckets
      .filter(group => group.jobIds.some(id => selected.has(id)))
      .map(group => group.id)
      .sort() ?? [];
    return ids.length ? ids : undefined;
  }, [bucket, result, selectedId]);
  const fxUnavailable = dataMode === "live" && !!data && !fxReady;
  const selectionKey = JSON.stringify({ ...query, mapLevel: "city", sort: undefined });
  useEffect(() => { cancelCardClick(); cancelOfficeFocus(); setOfficeReview(undefined); setCompensationReviewJobId(""); setCompanyReview(undefined); setLocationChoices(undefined); setBucket(null); setSelectedId(""); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [selectionKey, dataMode]);
  useEffect(() => { if (!active) { cancelCardClick(); cancelOfficeFocus(); setCompensationReviewJobId(""); setCompanyReview(undefined); setOfficeReview(undefined); setLocationChoices(undefined); } }, [active]);
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
    if (!data) { completedQuery.current = undefined; setResult(null); setListPage(null); setListItems([]); setQuerying(false); setLoadingMore(false); return; }
    if (!fxReady) { setQuerying(false); setLoadingMore(false); return () => abort.abort(); }
    if (completedQuery.current?.data === data && completedQuery.current.options === queryOptions && completedQuery.current.bucket === bucket) return () => abort.abort();
    setQuerying(true); setQueryError(""); setLoadingMore(false);
    const timer = setTimeout(() => {
      void queryAtlasPage(data, query, queryOptions, { signal: abort.signal, selectedJobIds: bucket?.jobIds }).then((next) => {
        if (!abort.signal.aborted) { completedQuery.current = { data, options: queryOptions, bucket }; setResultData(data); setResultOptions(queryOptions); setResult(next.summary); setListPage(next.page); setListItems(next.page.items); setQuerying(false); }
      }, (error: unknown) => { if (!abort.signal.aborted) { setResult(null); setListPage(null); setListItems([]); setQuerying(false); setQueryError(error instanceof Error ? error.message : "查询失败"); } });
    }, 120);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [data, query, queryOptions, bucket, fxReady]);
  async function loadMore() {
    const abort = queryAbort.current;
    if (!data || !resultCurrent || !listPage?.nextCursor || !abort || abort.signal.aborted || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await queryAtlasPage(data, query, queryOptions, { cursor: listPage.nextCursor, selectedJobIds: bucket?.jobIds, signal: abort.signal });
      if (!abort.signal.aborted) { setListPage(next.page); setListItems((items) => [...items, ...next.page.items.filter((n) => !items.some((i) => i.job.id === n.job.id))]); }
    } catch (error) { if (!abort.signal.aborted) setQueryError(error instanceof Error ? error.message : "加载失败"); }
    finally { if (!abort.signal.aborted) setLoadingMore(false); }
  }
  useEffect(() => () => { cancelCardClick(); connectionAbort.current?.abort(); searchAbort.current?.abort(); locationAbort.current?.abort(); officeFocusAbort.current?.abort(); }, []);

  const connect = useCallback(async (identity: AtlasConnectionIdentity, remember: boolean) => {
    if (cardWritePending.current) { setConnectionNotice("卡片写入结果尚未确认，请先在原核对面板核对回执，再重连或切换后端。"); return; }
    const currentLeadConnection = leadConnection.current;
    const leadWrite = readAtlasLeadRecovery(atlasLeadRecoveryScope(currentLeadConnection.endpoint, currentLeadConnection.token));
    if (leadWrite.pending || leadWrite.saved || leadWrite.active) { setSourcesOpen(true); setConnectionNotice("原岗位接续尚未同步，请先在发现线索中恢复原回执及索引，再更改后端。"); return; }
    searchAbort.current?.abort();
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    connectionAbort.current?.abort();
    const abort = new AbortController(); connectionAbort.current = abort;
    setSourcesOpen(false); setReconciliationOpen(false); setSourceReview(undefined); setCardReview(undefined); setLocationReview(undefined);
    setConnecting(true); setConnectionError(""); setConnectionNotice(""); setDataMode("live");
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const snapshot = await readAtlasSnapshot(identity.endpoint, identity.token, { signal: abort.signal });
      if (connectionAbort.current !== abort || abort.signal.aborted) return;
      restoreConnection.current = false;
      connectedIdentity.current = identity;
      if ((remember || isDefaultAtlasEndpoint(identity.endpoint)) && !writeAtlasConnectionSession({ schemaVersion: 1, dataMode: "live", ...identity })) setConnectionNotice("本次已连接；浏览器未允许保存标签页会话，刷新后需要重新连接。");
      setLiveData(snapshot); setDataMode("live"); setSelectedId(""); setSettings(null); setSourceSearchMessage(""); setSourceSearchError("");
    } catch (error) {
      if (connectionAbort.current === abort) {
        restoreConnection.current = false;
        setConnectionError(`${isDefaultAtlasEndpoint(identity.endpoint) ? "默认后端不可用，仍保留真实索引视图；请重试或检查后端设置。" : remember ? "" : "未能恢复本机索引连接，仍保留本机索引视图；请重试或检查连接设置。"}${abort.signal.aborted ? "连接超时或已取消。请确认本机岗位服务正在运行。" : error instanceof Error ? error.message : "无法连接本机服务。"}`);
      }
    } finally { clearTimeout(timeout); if (connectionAbort.current === abort) setConnecting(false); }
  }, []);
  useEffect(() => {
    if (!active || !restoreConnection.current || initialConnection?.dataMode !== "live") return;
    void connect(initialConnection, false);
    const abort = connectionAbort.current;
    return () => { if (connectionAbort.current === abort) { connectionAbort.current = null; abort?.abort(); setConnecting(false); } };
  }, [active, initialConnection, connect]);
  function cancelConnection() {
    if (retainPendingCardWrite()) return false;
    const leadWrite = readAtlasLeadRecovery(atlasLeadRecoveryScope(endpoint, token));
    if (leadWrite.pending || leadWrite.saved || leadWrite.active) { setSourcesOpen(true); setSourceSearchMessage("原岗位接续结果尚未同步，请先在已保存发现线索中核对原回执及索引。"); return false; }
    restoreConnection.current = false;
    const abort = connectionAbort.current; connectionAbort.current = null; abort?.abort();
    searchAbort.current?.abort(); setConnecting(false);
    locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined);
    setSourcesOpen(false); setReconciliationOpen(false); setSourceReview(undefined); setCardReview(undefined); setLocationReview(undefined); setCompensationReviewJobId(""); setCompanyReview(undefined);
    return true;
  }
  function changeConnection(field: "endpoint" | "token", value: string) {
    if (!cancelConnection()) return;
    clearAtlasConnectionSession(); connectedIdentity.current = null;
    setLiveData(null); setConnectionError(""); setConnectionNotice("连接资料已更改，请重新连接并读取索引。");
    if (field === "endpoint") setEndpoint(value); else setToken(value);
  }
  function chooseDataMode(next: AtlasDataMode) {
    if (!cancelConnection()) return;
    setDataMode(next); setConnectionError(""); setConnectionNotice(""); resetFilters();
    if (next === "live" && connectedIdentity.current) writeAtlasConnectionSession({ schemaVersion: 1, dataMode: next, ...connectedIdentity.current });
    else if (next !== "live") writeAtlasConnectionSession({ schemaVersion: 1, dataMode: next });
    else { clearAtlasConnectionSession(); void connect({ endpoint, token }, true); }
  }
  function disconnect() {
    if (!cancelConnection()) return;
    writeAtlasConnectionSession({ schemaVersion: 1, dataMode: "local" }); connectedIdentity.current = null;
    setEndpoint(DEFAULT_ATLAS_BACKEND_ENDPOINT); setToken(""); setLiveData(null); setDataMode("local"); setConnectionError(""); setConnectionNotice("已断开本机索引，并清除当前标签页的会话连接。");
  }
  function useDefaultBackend() {
    if (!cancelConnection()) return;
    clearAtlasConnectionSession(); connectedIdentity.current = null; setLiveData(null);
    setEndpoint(DEFAULT_ATLAS_BACKEND_ENDPOINT); setToken("");
    void connect({ endpoint: DEFAULT_ATLAS_BACKEND_ENDPOINT, token: "" }, true);
  }
  async function searchSourceJobs() {
    const leadWrite = readAtlasLeadRecovery(atlasLeadRecoveryScope(endpoint, token));
    if (leadWrite.pending || leadWrite.saved || leadWrite.active) { setSourcesOpen(true); setSourceSearchMessage("请先在已保存发现线索中核对原岗位保存回执，再启动新的来源搜索。"); return; }
    const savedScan = readAtlasSourceScanRecovery(atlasSourceScanRecoveryScope(endpoint, token));
    if (savedScan.pending || savedScan.saved || savedScan.refreshOnly) { setSourcesOpen(true); setSourceSearchMessage("请先在来源工具中核对原扫描回执，再启动下一次来源搜索。"); return; }
    const recoveryScope = atlasAggregateRecoveryScope(endpoint, token), unresolved = readAtlasAggregateRecovery(recoveryScope);
    if (unresolved.active || unresolved.entries.length) { setSourcesOpen(true); setSourceSearchMessage("请先核对原聚合搜索回执，再启动下一次来源搜索。"); return; }
    if (!connected) { setSettings("connection"); setSourceSearchMessage("本机岗位后端当前不可用；默认连接无需手动填写，查看状态并重试即可。"); return; }
    if (!selectedSearchSources.length) { setSourcesOpen(true); setSourceSearchMessage("尚无启用的岗位来源，请先添加或启用真实来源配置。"); return; }
    if (text.trim().length > 300) { setSourceSearchError("来源搜索关键词最多 300 个字符。"); return; }
    const owner = beginAtlasAggregateRecovery(recoveryScope); if (!owner) return;
    searchAbort.current?.abort(); const abort = new AbortController(); searchAbort.current = abort;
    setSourceSearching(true); setSourceSearchError(""); setSourceSearchMessage(""); setSourceReview(undefined); setBucket(null);
    const client = createAtlasSourceClient(endpoint, token);
    const requestKeys = new Map<string, string>();
    const scopeCountry = mode === "global" ? country : "";
    const requestedRegion = regionText.trim() || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "");
    const scopeRegions = mode === "domestic" ? chinaFilter.sourceRegions : requestedRegion ? [requestedRegion] : [];
    const acquisitionCountries = mode === "domestic" ? (chinaFilter.workCountryCodes.length ? chinaFilter.workCountryCodes : includeUnclassified ? [] : countryCatalog.domesticCountryCodes) : scopeCountry && scopeRegions.length ? [scopeCountry] : [];
    // Serialize snapshot refreshes so a slower, older response cannot replace a newer index.
    let refresh: Promise<void> = Promise.resolve();
    try {
      const aggregate = await runAtlasSourceSearch({
        sources: selectedSearchSources, signal: abort.signal, concurrency: 2,
        buildRequest: (entry) => {
          const companyName = typeof entry.options?.companyName === "string" ? entry.options.companyName : "";
          const companySearch = Boolean(text.trim() && companyName && normalizeSearchText(text) === normalizeSearchText(companyName));
          const scope = { roles: text.trim() && !companySearch ? [text.trim()] : [], regions: scopeRegions.length ? scopeRegions : scopeCountry ? [scopeCountry] : [], ...(acquisitionCountries.length ? { countryCodes: acquisitionCountries } : {}), companyNames: companySearch ? [companyName] : [] };
          const request = { scope, maxRecords: Math.min(searchDepth === "quick" ? 50 : 500, entry.refreshPolicy.maxRecords), maxPages: Math.min(searchDepth === "quick" ? 2 : 20, entry.refreshPolicy.maxPages) };
          const idempotencyKey = crypto.randomUUID(); requestKeys.set(entry.sourceId, idempotencyKey);
          return { request, idempotencyKey };
        },
        sync: async (id, request, options) => {
          retainAtlasAggregateRequest(recoveryScope, { sourceId: id, label: selectedSearchSources.find(entry => entry.sourceId === id)!.attribution.label, input: request, key: options.idempotencyKey });
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error("该来源等待超过 60 秒，已停止本次等待；可保留回执继续核对。")), 60000);
          try {
            const receipt = await client.sync(id, request, { ...options, signal: AbortSignal.any([abort.signal, timeout.signal]) });
            saveAtlasAggregateReceipt(recoveryScope, options.idempotencyKey, receipt); return receipt;
          }
          catch (failure) { rejectAtlasAggregateRequest(recoveryScope, options.idempotencyKey, failure); throw failure; }
          finally { clearTimeout(timer); }
        },
        onProgress: (progress) => { if (searchAbort.current === abort) setSearchProgress(progress); },
        onReceipt: async (receipt, entry) => {
          refresh = refresh.catch(() => {}).then(async () => {
            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), 20000);
            try {
              const snapshot = await client.snapshot({ signal: AbortSignal.any([abort.signal, timeout.signal]) });
              if (abort.signal.aborted || searchAbort.current !== abort) return;
              setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
              const key = requestKeys.get(entry.sourceId); if (key) settleAtlasAggregateReceipt(recoveryScope, key, receipt.run.runId);
            } finally { clearTimeout(timer); }
          });
          await refresh;
        },
      });
      if (searchAbort.current !== abort) return;
      const receipts = aggregate.sources.filter((entry) => entry.receipt);
      const records = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.records ?? 0), 0);
      const added = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.added ?? 0), 0);
      const failed = aggregate.sources.filter((entry) => entry.error || entry.status === "failed").length;
      const pendingRequirements = receipts.reduce((n, entry) => n + (entry.receipt?.run.summary?.needsHuman ?? 0), 0);
      setSourceSearchMessage(`${aggregate.cancelled ? "已停止等待" : "本次配置来源读取已结束"} · ${receipts.length}/${aggregate.total} 个来源返回回执，原始返回 ${records} 条，新增入库 ${added} 岗。原始条数不代表匹配岗位数；仅已确认匹配的结果进入索引。${pendingRequirements ? ` 另有 ${pendingRequirements} 条候选要求未读全，尚不能判断是否符合。` : ""}${failed ? ` ${failed} 个来源未成功，请展开逐源状态。` : ""}${aggregate.cancelled ? " 未确认的请求可能已保存部分数据，可重新读取索引核对。" : ""}`);
      if (failed) setSourceSearchError(aggregate.sources.filter((entry) => entry.error || entry.status === "failed").map((entry) => `${entry.label}：${entry.error?.message ?? entry.receipt?.sourceError?.code ?? "来源读取失败"}`).join("；"));
      if (aggregate.notificationErrors.length) setSourceSearchError("部分来源已返回，但索引展示刷新未完成，请点击“重新读取索引”核对。来源回执已保留。");
    } catch (error) {
      if (searchAbort.current === abort) setSourceSearchError(error instanceof Error ? error.message : "聚合来源搜索失败。");
    } finally { endAtlasAggregateRecovery(recoveryScope, owner); if (searchAbort.current === abort) setSourceSearching(false); }
  }
  const visibleItems = resultCurrent ? listItems : [];
  const selected = visibleItems.find((item) => item.job.id === selectedId)
    ?? (resultCurrent && recoveredOfficeSelection.current?.data === data && selectedCard.current?.job.id === selectedId && data?.jobs.some((job) => job.id === selectedId) ? selectedCard.current : undefined);
  useEffect(() => {
    const request = officeFocusRequest;
    if (!request) return;
    if (!active || !connected || dataMode !== "live" || data !== request.snapshot || selectionKey !== request.selectionKey || endpoint !== request.endpoint || token !== request.token) {
      cancelOfficeFocus(); return;
    }
    if (!fxReady) return;
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
  }, [officeFocusRequest, active, connected, dataMode, data, selectionKey, endpoint, token, query, queryOptions, fxReady]);
  useEffect(() => {
    const request = leadJobRequest;
    if (!request) return;
    if (endpoint !== request.endpoint || token !== request.token) { setLeadJobRequest(undefined); return; }
    if (!active || !connected || dataMode !== "live" || data !== request.snapshot || !fxReady) return;
    const controller = new AbortController();
    void queryAtlasPage(data, { ...query, page: { limit: 1 } }, queryOptions, { signal: controller.signal, selectedJobIds: [request.jobId] }).then(next => {
      if (controller.signal.aborted) return;
      const item = next.page.items.find(value => value.job.id === request.jobId);
      if (!item) { setSourceSearchMessage("原岗位已保存，但当前筛选未显示它。请清除筛选后重新查看。"); setLeadJobRequest(undefined); return; }
      recoveredOfficeSelection.current = { data, selectionKey, jobId: item.job.id };
      selectedCard.current = item; setSelectedId(item.job.id);
      const target = createJobMapFocus(item, crypto.randomUUID());
      if (target) { setFocus({ ...target, viewportOffset: [0, 0] }); setRotating(false); }
      else setSourceSearchMessage("已打开原岗位详情。来源尚未披露可定位的办公点，可继续核对工作地点；本次未生成坐标。");
      setLeadJobRequest(undefined);
    }, (problem: unknown) => { if (!controller.signal.aborted) { setSourceSearchError(problem instanceof Error ? problem.message : "无法打开已保存的原岗位。"); setLeadJobRequest(undefined); } });
    return () => controller.abort();
  }, [leadJobRequest, active, connected, dataMode, data, endpoint, token, fxReady, query, queryOptions, selectionKey]);
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
    setDetailReviewJobId(""); setCompensationReviewJobId(""); setCompanyReview(undefined); setEnrichmentScope(null);
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
  function closeJob() { setCompanyReview(undefined); setCompensationReviewJobId(""); cancelCardClick(); cancelOfficeFocus(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setOfficeReview(undefined); setLocationChoices(undefined); setSelectedId(""); setFocus(undefined); }
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
  function focusOfficeCandidate(jobId: string, location: JobLocation, candidate: OfficeAddressCandidate) {
    const item = listItems.find(value => value.job.id === jobId) ?? (selectedCard.current?.job.id === jobId ? selectedCard.current : undefined);
    const label = item?.job.title.value ?? data?.jobs.find(value => value.id === jobId)?.title.value ?? "岗位办公地址候选";
    const target = createOfficeCandidateMapFocus(jobId, label, location, candidate, crypto.randomUUID());
    if (!target) { setSourceSearchError("地址候选与原岗位地点不一致，未生成地图定位。请保留候选待核实状态并重新核对。"); return; }
    setSelectedId(jobId);
    flyToJob(target);
    setSourceSearchMessage("已临时定位地址查询候选；候选仍为估算、待核实位置，未填入表单，也未写入索引。请继续人工核对后再决定是否保存。");
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
      locationAbort.current?.abort(); setLocationSearch(undefined); setFocus(undefined); setOfficeReview({ jobId: item.job.id, location, prefillFromSourceAddress: true }); return;
    }
    if (direct) { locationAbort.current?.abort(); setLocationSearch(undefined); flyToJob(direct); return; }
    if (!location) { locationAbort.current?.abort(); setFocus(undefined); setLocationSearch({ jobId: item.job.id, locationId: locationId ?? "", loading: false, error: "该岗位未披露可确认的办公地点，不能将远程资格或未知地点标成办公地址。" }); return; }
    if (!connected) { setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: false, error: "来源只有地点原文。本机岗位后端不可用时，无法核对具体办公地址或查询离线城市候选；也可以打开 Google 地图核对。" }); return; }
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
    if (!data || !resultCurrent || !data.jobs.some((job) => job.id === item.job.id)) return;
    const input = buildAtlasJobAction(data, item);
    if (analyze) onAnalyze(input);
    else onSaveOpportunity({ token: crypto.randomUUID(), title: item.job.title.value, description: item.job.description, sourceUrl: input.url, sourcePlatform: input.platform, collectedAt: input.observedAt, sourcePublishedAt: input.sourcePublishedAt, sourcePublishedText: input.sourcePublishedText });
  }
  function resetCamera() { camera.current = undefined; cameraMode.current = undefined; setFocus(undefined); setMapZoom(mode === "global" ? 1.65 : 3.1); setMapKey((k) => k + 1); setMapError(""); }
  function changeMapMode(next: "global" | "domestic") { camera.current = undefined; cameraMode.current = undefined; setFocus(undefined); setMode(next); setMapZoom(next === "global" ? 1.65 : 3.1); setMapKey((k) => k + 1); setCountry(""); setRegion(""); setRegionText(""); setMapError(""); }
  function resetFilters() { setText(""); setCountry(""); setRegion(""); setRegionText(""); setChinaSelection({}); setOrigin(""); setOwnership(""); setSource(""); setSalaryMin(""); setSalaryMax(""); setMaxKm(""); setIncludeUnclassified(false); setSort("relevance"); setDirection("desc"); setBucket(null); }
  function recoverCompanyReview() {
    const identity = companyRecovery.pending?.input ?? companyRecovery.saved;
    if (!identity) return;
    cancelOfficeFocus(); setEnrichmentScope(null); setDetailReviewJobId(""); setCompensationReviewJobId("");
    setLocationReview(undefined); setOfficeReview(undefined); setCompanyReview({ jobId: identity.jobId, companyId: identity.companyId });
  }
  const reviewPlatformCards: NonNullable<PlatformSearchLinksProps["onIndexCards"]> = (cards, receipt, provider) => {
    if (retainPendingCardWrite()) return;
    if (!connected) { setSettings("connection"); setSourceSearchMessage("本机岗位后端当前不可用；默认连接无需手动填写，重试自动后端后再核对卡片入库。"); return; }
    const parsed = receipt.status === "ready" && ReviewedCardsCaptureSchema.safeParse({ provider, pageUrl: receipt.url, capturedAt: receipt.capturedAt, cards });
    if (!parsed || !parsed.success) { setSourceSearchError("所选卡片的来源或字段证据不足，未加入索引；请打开原岗位核对。"); return; }
    setSourceSearchError(""); setCardReview(parsed.data);
  };

  return <section ref={workspace} className="atlas-workspace" data-pane-layout={layout} aria-label={t("岗位地图", "Opportunity atlas")}>
    <div className="atlas-heading"><div><span className="atlas-eyebrow">BETTERME / OPPORTUNITY ATLAS</span><h1>{t("让下一个机会，有迹可循。", "Find where your next chapter begins.")}</h1><p>{t("从全球视野，找到与你更近的工作。", "Explore opportunities across the world, and closer to home.")}</p></div><div className="atlas-top-actions"><button onClick={() => setSettings(settings === "maps" ? null : "maps")}><Globe2 size={15} />地图服务</button><button onClick={() => setSettings(settings === "home" ? null : "home")}><Home size={15} />{anchor ? t("已设置家庭参照点", "Home set") : t("设置离家距离", "Set home distance")}</button><button aria-label="本机后端状态与高级设置" title="本机网页自动使用同源岗位后端；打开查看状态与高级设置" onClick={() => setSettings(settings === "connection" ? null : "connection")}><Database size={15} />{connecting ? "本机后端 · 读取中…" : connected ? isDefaultAtlasEndpoint(endpoint) ? "本机后端 · 自动" : "本机后端 · 手动直连" : "本机后端 · 未就绪"}</button></div></div>
    <div className={`atlas-data-banner ${dataMode}`} role="status"><span className="atlas-status-dot" /><strong>{dataMode === "demo" ? "演示模式 · 非真实招聘" : dataMode === "live" ? "真实来源 · 本机索引" : "真实来源 · 当前机会库"}</strong><span>{dataMode === "demo" ? "企业、岗位和薪资均为合成样本，不计入真实岗位。" : dataMode === "live" && !liveData ? connecting ? "正在连接默认或已保存后端，读取真实岗位索引…" : "后端尚未连接，岗位数量未知；请重试或打开设置。" : `${data?.jobs.length ?? 0} 个来源岗位 · ${dataMode === "local" ? "只在本页读取公开岗位字段，原机会库不变" : connecting ? "正在重新读取本机索引…" : connectionError ? `保留索引版本 ${liveData?.revision} · 后端暂不可用` : `索引版本 ${liveData?.revision} · 手动刷新`}`}</span><label className="atlas-data-selector">数据视图<select aria-label="岗位数据视图" value={dataMode} onChange={(e) => chooseDataMode(e.target.value as AtlasDataMode)}><option value="local">当前机会库 · 真实来源</option><option value="live">本机采集索引 · 真实来源</option><option value="demo">合成演示 · 仅体验地图</option></select></label>{dataMode === "local" && <button disabled={localLoading} onClick={() => setLocalReload((n) => n + 1)}>{localLoading ? "正在读取…" : "重新读取机会库"}</button>}{dataMode === "live" && <button disabled={connecting} onClick={() => { restoreConnection.current = false; void connect({ endpoint, token }, true); }}>重新读取索引</button>}<button onClick={() => { setSourcesOpen(!sourcesOpen); setReconciliationOpen(false); setSettings(null); }}>来源工具</button>{dataMode === "live" && connected && <button aria-expanded={reconciliationOpen} onClick={() => { setReconciliationOpen(!reconciliationOpen); setSourcesOpen(false); }}>重复岗位核对</button>}{onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>51JOB / BOSS / 猎聘 / LinkedIn 单岗读取</button>}</div>
    {connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}
    {connectionNotice && <p role="status" className="atlas-small">{connectionNotice}</p>}
    {dataMode === "live" && connected && <div className="atlas-fx-status" role="status"><button type="button" aria-expanded={fxOpen} onClick={() => setFxOpen(!fxOpen)}>{t("参考汇率", "Reference FX")}</button><span>{fxWritePending ? t("汇率写入结果待核对，旧查询已隐藏。", "FX write pending; old query results hidden.") : fxContext.loading ? t("正在读取与当前索引同版的汇率…", "Loading FX for the current index…") : fxContext.context?.activeSnapshot ? `${fxContext.context.activeSnapshot.fx.provider} · ${fxContext.context.activeSnapshot.fx.date}` : fxContext.context ? t("未启用外币换算 · 保留人民币与原币", "FX disabled · CNY and original currencies retained") : ""}</span>{fxContext.loading && <button type="button" onClick={fxContext.cancel}>{t("停止等待汇率", "Stop waiting for FX")}</button>}</div>}
    {scanWritePending && connected && <div className="atlas-company-recovery-status" role="status"><span>{t("来源扫描尚未同步，旧列表、地图与统计已暂停。", "Source scan not synchronized; old results, map and counts are paused.")}</span><button type="button" onClick={() => setSourcesOpen(true)}>{t("核对来源扫描", "Recover source scan")}</button></div>}
    {leadWritePending && <div className="atlas-company-recovery-status" role="status"><span>{t("原岗位接续尚未同步，列表、地图与统计已暂停。关闭面板仍保留原请求。", "Original posting adoption awaits synchronization. Results, map and counts are paused; closing the pane preserves the command.")}</span><button type="button" onClick={() => setSourcesOpen(true)}>{t("恢复发现线索核对", "Recover discovery adoption")}</button></div>}
    {companyWritePending && connected && <div className="atlas-company-recovery-status" role="status"><span>{t("企业写入结果尚未同步，旧分类、列表、地图与统计已暂停。", "Company write not synchronized; old classification, results, map and counts are paused.")}</span><button type="button" onClick={recoverCompanyReview}>{t("恢复企业核对", "Resume company review")}</button></div>}
    {dataMode === "live" && fxContext.error && <p role={fxContext.unsupported ? "status" : "alert"} className="atlas-error">{fxContext.error}<button type="button" onClick={fxContext.retry}>{t("重试汇率上下文", "Retry FX context")}</button></p>}
    {active && fxOpen && connected && dataMode === "live" && liveData && <Suspense fallback={<p role="status">{t("正在打开汇率管理…", "Opening FX management…")}</p>}><AtlasFxPanel endpoint={endpoint} token={token} data={liveData} state={fxContext.state} loading={fxContext.loading} unsupported={fxContext.unsupported} onRetry={fxContext.retry} onClose={() => setFxOpen(false)} onSnapshot={snapshot => { searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); }} /></Suspense>}
    {localError && dataMode === "local" && <p role="alert" className="atlas-error">{localError}</p>}
    {dataMode === "local" && !!localData?.jobs.length && localWarnings > 0 && <p className="atlas-small">有 {localWarnings} 项来源字段提示：未提供的日期、结构化薪资与坐标保持未知。查看岗位详情核对原文；投递记录和联系人未进入地图数据。</p>}
    {active && reconciliationOpen && connected && dataMode === "live" && liveData && <Suspense fallback={<p role="status">正在打开重复岗位核对…</p>}><AtlasReconciliationPanel endpoint={endpoint} token={token} data={liveData} onClose={() => setReconciliationOpen(false)} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`已读取岗位处理记录，索引版本 ${snapshot.revision}。列表与地图会按当前来源组合重新计算。`);
    }} /></Suspense>}
    {sourcesOpen && <Suspense fallback={<p role="status">正在加载来源工具…</p>}><AtlasSourcesPanel disabled={sourceSearching} endpoint={endpoint} token={token} revision={liveData?.revision} onSnapshot={(snapshot) => {
      if (leadConnection.current.endpoint !== endpoint || leadConnection.current.token !== token) return;
      // A recovered authenticated snapshot also restores this root's connection identity after remount.
      connectedIdentity.current = { endpoint, token }; restoreConnection.current = false;
      connectionAbort.current?.abort(); connectionAbort.current = null;
      setConnecting(false); setConnectionError(""); setConnectionNotice("");
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
    }} onOpenJob={(jobId, snapshot) => {
      if (liveData && liveData.revision > snapshot.revision) { setSourceSearchMessage("索引版本已改变，请重新读取线索及岗位后再查看。"); return; }
      cancelOfficeFocus(); resetFilters(); setMode("global"); setLiveData(snapshot); setDataMode("live"); setSourcesOpen(false);
      setLeadJobRequest({ jobId, snapshot, endpoint, token });
    }} onClose={() => setSourcesOpen(false)} /></Suspense>}
    {settings && <div className="atlas-settings"><button className="atlas-panel-close" aria-label="关闭地图设置" onClick={() => setSettings(null)}><X size={17} /></button>
      {settings === "maps" && <div><h2>地图与街道底图</h2><p>全球与国内均使用同一经纬度视图，可连续缩放至街道。开放底图无需 API Key；联网底图会向所选服务请求当前视野的瓦片，离线轮廓不请求外部地图服务。</p><label className="atlas-basemap-select">底图来源<select value={basemapId} onChange={(e) => { setBasemapId(e.target.value); setMapError(""); }}><option value="auto">OpenFreeMap · 跟随浅深主题</option>{ATLAS_BASEMAPS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}<option value="offline">本地概览 · 离线边界</option></select></label><p className="atlas-small">道路、建筑、门牌和地名是否显示取决于底图覆盖。城市级岗位不会显示成精确办公地址。Google 地图可从岗位详情的“Google 地图”入口打开；内嵌 Google Maps 尚未启用，需要个人 Key、服务权限及对应计费配置。</p></div>}
      {settings === "connection" && <form onSubmit={(e) => { e.preventDefault(); restoreConnection.current = false; void connect({ endpoint, token }, true); }}><h2>{t("本机后端状态", "Local backend status")}</h2><p>本机网页默认使用同源岗位后端，进入岗位地图会自动读取索引，不需要手动连接或填写令牌。这里仅用于查看状态、重试自动后端；GitHub Pages 等静态网页才需要下方的高级直连。</p><div className="atlas-form-row"><button type="button" disabled={connecting} onClick={useDefaultBackend}>使用自动后端</button><button type="button" disabled={connecting} onClick={() => { restoreConnection.current = false; void connect({ endpoint, token }, true); }}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{connecting ? "正在读取" : "重试自动后端"}</button><button type="button" onClick={disconnect}>暂停自动读取</button></div><details><summary>高级直连 · 手动服务地址与令牌</summary><p>GitHub Pages 只提供静态网页，尚未部署岗位后端。需要直连时，先按 <code>apps/job-service/README.md</code> 启动本机服务并允许当前 Origin：<code>{window.location.origin}</code>。手动令牌仅在连接成功后保留于当前标签页会话，默认同源后端不会向网页提供宿主令牌。</p><div className="atlas-form-row"><label>服务地址<input value={endpoint} onChange={(e) => changeConnection("endpoint", e.target.value)} placeholder={DEFAULT_ATLAS_ENDPOINT} /></label><label>访问令牌<input type="password" autoComplete="off" value={token} onChange={(e) => changeConnection("token", e.target.value)} /></label><button type="submit" disabled={connecting}>连接并读取索引</button></div></details><p className="atlas-small">家庭参照坐标不发送给服务。公网 HTTPS 页面直连本机可能需要浏览器本地网络授权；完整体验建议使用本机网页。</p></form>}
      {settings === "home" && <form onSubmit={(e) => { e.preventDefault(); const lat = Number(latitude), lon = Number(longitude); if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { setHomeError("请输入有效的 WGS84 纬度（-90～90）和经度（-180～180）。"); return; } setAnchor({ ref: crypto.randomUUID(), latitude: lat, longitude: lon, coordinateSystem: "WGS84" }); setHomeError(""); setSettings(null); }}><h2>离家距离 · 私人参照点</h2><p>使用 WGS84 坐标计算直线距离，仅保留在本页内存。城市中心距离会标为估算；不会请求你的设备定位或将家庭坐标发送到外部。</p><div className="atlas-form-row"><label>纬度<input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="例如 31.2304" /></label><label>经度<input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="例如 121.4737" /></label><button type="submit">应用参照点</button>{anchor && <button type="button" onClick={() => { setAnchor(undefined); setLatitude(""); setLongitude(""); setMaxKm(""); if (sort === "distance") setSort("relevance"); }}>清除</button>}</div>{homeError && <p role="alert" className="atlas-error">{homeError}</p>}</form>}
      {settings === "colors" && <div><h2>企业控股来源配色</h2><p>配色依据已核实的最终控股方来源。工作地点不代表企业来源；待核实与证据冲突单列。颜色只影响岗位地图。</p><div className="atlas-color-grid">{colors.rules.map((rule, index) => <label key={rule.id}><input type="color" aria-label={`${rule.label}颜色`} value={rule.color} onChange={(e) => setColors((current) => ({ ...current, rules: current.rules.map((r, n) => n === index ? { ...r, color: e.target.value } : r) }))} /><span>{rule.label}</span></label>)}</div><div className="atlas-form-row"><button onClick={() => { try { localStorage.setItem(COLOR_KEY, JSON.stringify(CompanyColorConfigSchema.parse(colors))); setColorsMessage("配色已保存到当前浏览器。"); } catch { setColorsMessage("浏览器未允许保存，当前页面仍应用此配色。"); } }}>保存配色</button><button onClick={() => { setColors(getDefaultCompanyColorConfig()); setColorsMessage("已恢复默认配色；点击保存可保留。"); }}>恢复默认</button><span role="status">{colorsMessage}</span></div></div>}
    </div>}
    <form className="atlas-searchbar" onSubmit={(e) => { e.preventDefault(); void searchSourceJobs(); }}><label className="atlas-search"><Search size={18} /><input aria-label="搜索地图岗位" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("关键词、技能、公司… 可筛选已收录或从来源获取", "Filter indexed jobs or fetch from a source…")} /></label>{mode === "domestic" ? <div className="atlas-domestic-region" role="group" aria-label="国内省市区筛选"><span>中国</span><select aria-label="工作省份" value={chinaSelection.provinceCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: e.target.value || undefined })}><option value="">全部省份</option>{getChinaProvinces().map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作城市" disabled={!chinaCities.length} value={chinaSelection.cityCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: chinaSelection.provinceCode, cityCode: e.target.value || undefined })}><option value="">全部城市</option>{chinaCities.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作区县" disabled={!chinaDistricts.length} value={chinaSelection.districtCode ?? ""} onChange={(e) => setChinaSelection({ ...chinaSelection, districtCode: e.target.value || undefined })}><option value="">全部区 / 县</option>{chinaDistricts.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></div> : <><select aria-label="工作国家或地区" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(""); setRegionText(""); }}><option value="">{t("所有国家 / 地区", "All countries / regions")}</option>{countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select><label className="atlas-region-search"><MapPin size={15} /><input aria-label="工作城市或地区关键词" value={regionText} onChange={(e) => { setRegionText(e.target.value); setRegion(""); }} placeholder="城市 / 地区，如北京、Berlin" maxLength={300} /></label></>}{searchableSources.length > 0 && <select aria-label="搜索原始来源" value={searchSourceId} onChange={(e) => { searchAbort.current?.abort(); setSearchSourceId(e.target.value); }}><option value="">已配置岗位来源（{searchableSources.length}）</option>{searchableSources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.attribution.label}{entry.remoteFilters.includes("roles") ? " · 实时关键词" : " · 来源岗位"}</option>)}</select>}<select aria-label="来源读取范围" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value)}><option value="standard">按来源配置读取</option><option value="quick">快速 · 每源最多 50 条 / 2 页</option></select><button className="atlas-source-search" type="submit" disabled={sourceSearching || connecting || scanWritePending || aggregateWritePending}>{sourceSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}{connected ? "从来源获取岗位" : "打开后端状态"}</button><button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} />{t("筛选", "Filters")}</button></form>
    <p className="atlas-small atlas-search-scope">输入会实时筛选{data ? `已收录的 ${data.jobs.length} 个岗位` : "本机后端索引"}；{connected ? `点击获取后，查询 ${selectedSearchSources.length} 个已配置岗位来源，先返回的结果先展示；不包含下方四平台浏览器搜索。` : "后端不可用时，请从右上角查看状态并重试；这里不会自动读取外部来源。"}读取不超过来源配置额度；详情完整度见逐源状态。</p>
    {mode === "domestic" && <p className="atlas-small">按省 → 市 → 区县逐级选择，修改上级会清除下级。大陆三级目录采用 2023 统计区划快照，部分末级为镇街/功能区；港澳台保留地区筛选，下级目录待补充。岗位只披露城市时，选择区县会排除位置不明确的岗位。</p>}
    {connected && selectedSearchSources.length > 0 && <details className="atlas-source-limits"><summary>本次实际读取范围 · {selectedSearchSources.length} 个已配置岗位来源</summary><ul>{selectedSearchSources.map((entry) => <li key={entry.sourceId}>{entry.attribution.label}：最多 {Math.min(searchDepth === "quick" ? 50 : 500, entry.refreshPolicy.maxRecords)} 条 / {Math.min(searchDepth === "quick" ? 2 : 20, entry.refreshPolicy.maxPages)} 页{entry.options?.fetchDetails === true && typeof entry.options.maxDetailRequestsPerPage === "number" ? `，每页最多 ${entry.options.maxDetailRequestsPerPage} 个详情` : ""}</li>)}</ul><p>这里只查询已配置的岗位来源（企业官网或公开聚合源）。下方原站浏览器搜索独立执行，不计入官网来源回执。</p><button type="button" onClick={() => setSourcesOpen(true)}>管理与扩展来源</button></details>}
    <PlatformSearchLinks keyword={text} regionText={mode === "domestic" ? (chinaFilter.selectedCity?.isGrouping && ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "") ? chinaFilter.selectedProvince?.name : chinaFilter.selectedCity?.name) ?? chinaFilter.selectedProvince?.name ?? "" : regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "")} countryCode={mode === "domestic" ? chinaFilter.workCountryCodes[0] ?? "CN" : country} onOpenSingleJob={onOpenOpportunitySources} onReviewCard={(card, capturedAt) => onSaveOpportunity({ token: crypto.randomUUID(), title: card.title, description: `[原站搜索列表卡片摘要，非完整 JD；请打开岗位原文核对]\n${card.cardText}`, sourceUrl: card.url, sourcePlatform: card.platform, collectedAt: capturedAt, sourcePublishedText: card.publicationText })} onIndexCard={(card, receipt, provider) => reviewPlatformCards([card], receipt, provider)} onIndexCards={reviewPlatformCards} />
    {cardReview && connected && liveData && <Suspense fallback={<p role="status">正在打开卡片核对…</p>}><AtlasReviewedCardImport key={JSON.stringify(cardReview)} endpoint={endpoint} token={token} capture={cardReview} revision={liveData.revision} onClose={() => { if (activeCardReview.current === cardReview && !retainPendingCardWrite()) setCardReview(undefined); }} onWritePendingChange={pending => {
      if (activeCardReview.current !== cardReview) return;
      if (pending) cardWritePending.current = cardReview; else if (cardWritePending.current === cardReview) cardWritePending.current = undefined;
    }} onSnapshot={snapshot => {
      if (activeCardReview.current !== cardReview) return;
      searchAbort.current?.abort();
      setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
    }} /></Suspense>}
    {mode === "domestic" && chinaFilter.selectedDistrict && <p className="atlas-small">原站搜索链接只应用城市范围；区县条件在已收录岗位的位置原文中复核。尚未披露区县不算命中。</p>}
    <AtlasSearchProgress progress={searchProgress} busy={sourceSearching} onCancel={() => searchAbort.current?.abort()} onReviewSource={setSourceReview} />
    {connected && <AtlasAggregateRecoveryControls endpoint={endpoint} token={token} disabled={scanWritePending} onSnapshot={snapshot => { setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live"); setSourceSearchError(""); }} />}
    {sourceReview?.receipt && reviewSource && <Suspense fallback={<p role="status">正在加载来源候选核对…</p>}><AtlasSourceCandidateReview key={`${sourceReview.receipt.run.runId}:${endpoint}`} endpoint={endpoint} token={token} source={reviewSource} request={{ scope: sourceReview.receipt.localFilters, maxRecords: sourceReview.receipt.run.scope.maxRecords }} onClose={() => setSourceReview(undefined)} onReview={onSaveOpportunity} /></Suspense>}
    {sourceSearchMessage && <p role="status" className="atlas-search-notice">{sourceSearchMessage}</p>}
    {sourceSearchError && <p role="alert" className="atlas-error">{sourceSearchError}</p>}
    <div className="atlas-coverage" aria-label="当前索引筛选覆盖" aria-busy={fxUnavailable}>{fxUnavailable ? <span>{companyWritePending ? t("企业核对尚未同步，旧分类与覆盖统计已隐藏。", "Company review is not synchronized; old classification and coverage counts are hidden.") : "正在核对当前索引的汇率上下文，旧覆盖统计已隐藏。"}</span> : <><span>当前视图 {coverage.totalJobs} 岗</span><span>国家/地区 {coverage.country.jobs}</span><span>可比较年薪 {coverage.salary.jobs}</span><span>可计算距离 {coverage.distance.jobs}</span><span>已核实企业性质 {coverage.ownership.jobs}</span><span>已定位 {coverage.map.jobs}</span></>}</div>
    {filtersOpen && <div className="atlas-filters">
      {mode === "global" && <label>工作地区<select aria-label="筛选工作地区" disabled={!regions.length && !region} value={region} onChange={(e) => { setRegion(e.target.value); setRegionText(""); }}><option value="">全部地区</option>{regions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.jobs} 岗</option>)}</select>{!regions.length && <small>当前没有已收录地区选项；可在上方输入城市，再从来源获取。</small>}</label>}
      <label>企业性质<select aria-label="筛选企业性质" value={ownership} disabled={!coverage.totalJobs} onChange={(e) => setOwnership(e.target.value)}><option value="">全部性质</option>{[["private", "民营 / 私有控股"], ["state", "国有控股"], ["joint", "合资 / 共同控制"], ["dispersed", "分散持股"]].map(([id, label]) => <option key={id} value={id} disabled={!coverage.ownership.values.includes(id!)}>{label}</option>)}<option value="unknown">待核实</option></select>{!coverage.ownership.supported && <small>尚无已核实性质，可查看待核实岗位。</small>}</label>
      <label>控股方国家 / 地区<select value={origin} disabled={!coverage.totalJobs} onChange={(e) => setOrigin(e.target.value)}><option value="">全部来源</option>{origins.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}<option value="unknown">待核实</option></select>{!coverage.controller.supported && <small>缺控股来源证据，不能按品牌或工作地点猜测。</small>}</label>
      <label>岗位信息源<select aria-label="筛选岗位信息源" disabled={!coverage.source.supported && !source} value={source} onChange={(e) => setSource(e.target.value)}><option value="">全部来源</option>{coverage.source.options.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.jobs} 岗</option>)}</select></label>
      <label>最低年薪（万元 CNY）<input type="number" min="0" disabled={!coverage.salary.supported && !salaryMin} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} />{!coverage.salary.supported && <small>{coverage.salary.fxBlockedJobs ? "缺有效汇率，当前薪资无法换算。" : "暂无可比较的税前固定年薪。"}</small>}</label>
      <label>最高年薪（万元 CNY）<input type="number" min="0" disabled={!coverage.salary.supported && !salaryMax} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} /></label>
      <label>离家不超过（km）<input type="number" min="0" max="40100" disabled={(!coverage.distance.ready && !maxKm)} value={maxKm} onChange={(e) => setMaxKm(e.target.value)} placeholder={!coverage.distance.supported ? "岗位尚无可用坐标" : anchor ? "不限制" : "先设置参照点"} /><small>{!coverage.distance.supported ? "需岗位位置证据；仅有城市原文不能计算距离。" : !anchor ? "先设置家庭参照点。" : `${coverage.distance.jobs} 岗可计算；城市中心会标估算。`}</small></label>
      <button onClick={resetFilters}>清除筛选</button>
      {mode === "domestic" && <label className="atlas-unknown-toggle"><input type="checkbox" checked={includeUnclassified && !chinaFilter.selectedProvince} disabled={Boolean(chinaFilter.selectedProvince)} onChange={(e) => setIncludeUnclassified(e.target.checked)} />{chinaFilter.selectedProvince ? "已选行政范围，只匹配明确披露国家/地区的岗位" : `国内视图包含国家/地区待核实岗位（${coverage.country.missingJobs}）`}</label>}
    </div>}
    {connected && dataMode === "live" && visibleItems.length > 0 && <div className="atlas-enrichment-entry"><span>当前显示 {visibleItems.length} / {bucket?.jobCount ?? result?.totalJobs ?? 0} 个结果 · 办公点与城市参考分别标注</span><button type="button" onClick={() => { cancelOfficeFocus(); setCompanyReview(undefined); setCompensationReviewJobId(""); setDetailReviewJobId(""); setEnrichmentScope(visibleItems.slice(0, 50).map(item => item.job.id)); }}><MapPin size={14} />补全当前结果办公地点</button><small>本次最多 50 个已显示结果；读取前可核对范围，不自动保存候选坐标。</small></div>}
    {queryError && <p className="atlas-error" role="alert">{queryError}</p>}
    {mapReferences.loading && <p className="atlas-small" role="status"><Loader2 size={14} className="animate-spin" /> 正在读取城市分布参考，岗位列表可继续使用… <button type="button" onClick={mapReferences.cancel}>取消地图参考读取</button></p>}
    {mapReferences.error && <p className="atlas-small" role="status">{mapReferences.error} <button type="button" onClick={mapReferences.retry}>重新读取城市参考</button></p>}
    {mapReferences.result && <div className="atlas-small" aria-label="城市参考数据来源">城市分布采用离线地名数据，保留来源岗位地点；不确认办公地址。{mapReferences.result.provenance?.attribution}{mapReferences.result.truncated && ` · 本次只处理 ${mapReferences.result.processedLocations}/${mapReferences.result.totalLocations} 个地点，未处理地点仍待定位。`}{mapReferences.result.warnings.length > 0 && <details><summary>城市参考范围与提示</summary><ul>{mapReferences.result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}</div>}
    <div className={`atlas-main-grid ${(selected && data) || detailReviewJobId || compensationReviewJobId || companyReview || enrichmentScope ? "has-detail" : ""} ${emptyIndex ? "is-empty-index" : ""}`}><div className="atlas-map-column"><div className={`atlas-map-card ${theme}`}><div className="atlas-map-top"><div className="atlas-mode-switch" role="group" aria-label="地图范围"><button aria-pressed={mode === "global"} className={mode === "global" ? "active" : ""} onClick={() => changeMapMode("global")}><Globe2 size={15} />{t("全球", "Global")}</button><button aria-pressed={mode === "domestic"} className={mode === "domestic" ? "active" : ""} onClick={() => changeMapMode("domestic")}><MapPin size={15} />{t("国内", "China")}</button></div><span>{mapLevel === "location" ? "STREET & ADDRESS" : "3D EXPLORER"} <i /></span></div><div className="atlas-scene" ref={scene}>{active && <Suspense fallback={<div className="atlas-map-loading"><Loader2 className="animate-spin" />正在加载三维地图…</div>}><AtlasMap key={mapKey} bucketLevel={mapLevel} mode={mode} basemap={basemapId === "offline" ? null : basemapId === "auto" ? undefined : ATLAS_BASEMAPS.find((p) => p.id === basemapId)} buckets={result?.mapBuckets ?? []} selectedBucketId={bucket?.memberBucketIds ? undefined : bucket?.id} selectedBucketIds={selectedMapBucketIds} selectedRegionId={mode === "domestic" ? chinaFilter.selectedProvince?.mapId : region || country || undefined} initialView={cameraMode.current === mode ? camera.current : undefined} focus={focus} selectedJobId={selectedId} visual={{ autoRotate: rotating, maxDpr: 1.5, pedestal: true, entrance: true, theme }} onViewChange={(view) => { camera.current = view; cameraMode.current = mode; setMapZoom(previous => (previous >= 10) === (view.zoom >= 10) ? previous : view.zoom); }} onPick={setBucket} onPickMany={buckets => setBucket(selectAtlasBuckets(buckets))} onCountry={(pick) => { if (mode === "domestic") { const province = findChinaProvinceByMapId(pick.id); if (province) setChinaSelection({ provinceCode: province.code }); else setSourceSearchMessage("该区域尚未纳入当前国内行政目录，请按来源披露地点查询。"); } else if (pick.countryCode) { setCountry(pick.countryCode); setRegion(""); setRegionText(""); } }} onReady={() => setMapError("")} onError={(error) => setMapError(error.message)} /></Suspense>}</div><div className="atlas-map-caption"><div><span className="atlas-eyebrow">{mode === "global" ? "A WORLD OF POSSIBILITIES" : "CLOSER TO YOUR NEXT CHAPTER"}</span><strong>{mode === "global" ? t("机会，不止一座城。", "Your next role could be anywhere.") : t("在熟悉的土地，发现新可能。", "A new perspective, closer to home.")}</strong><small>拖动旋转 · 连续缩放至街道 · 城市中心与精确地址分开标注</small></div><div className="atlas-map-controls"><button aria-label="重置地图视角" title="重置视角" onClick={resetCamera}><Compass size={17} /></button><button aria-pressed={rotating} onClick={() => setRotating(!rotating)}>{rotating ? "暂停旋转" : "自动旋转"}</button></div></div>{mapError && <div role="alert" className="atlas-render-error">三维地图暂不可用：{mapError}。岗位列表仍可使用。<button onClick={() => { setMapKey((k) => k + 1); setMapError(""); }}>重试</button></div>}</div>
      <div className="atlas-stat-grid" aria-live="polite">{[[result?.totalJobs ?? 0, "匹配岗位"], [result?.companyCount ?? 0, "企业"], [result?.mapReferenceCoverage?.mapVisibleJobs ?? result?.mappedJobs ?? 0, "地图可展示"], [result?.mapReferenceCoverage?.mapPendingJobs ?? result?.unlocatedJobs ?? 0, "待定位岗位"]].map(([number, label]) => <div key={label}><strong>{(dataMode === "live" && !data || fxUnavailable) ? "—" : number}</strong><span>{label}</span></div>)}</div><p className="atlas-small" aria-label="地图位置口径">{fxUnavailable ? companyWritePending ? t("企业核对尚未同步，旧地图统计已隐藏。", "Company review is not synchronized; old map counts are hidden.") : "汇率上下文尚未就绪，旧地图统计已隐藏。" : dataMode === "live" && !data ? "后端未连接，地图岗位位置统计尚未取得。" : <>有效岗位坐标 {result?.mappedJobs ?? 0} 岗 · 城市分布参考 {result?.mapReferenceCoverage?.cityReferenceJobs ?? 0} 岗。</>}城市参考为估算展示，非办公地址，不参与离家距离；多地点按岗位去重。</p><div className="atlas-legend"><div className="atlas-legend-title"><strong>企业控股来源</strong><button onClick={() => setSettings(settings === "colors" ? null : "colors")}><Palette size={14} />配置颜色</button></div><div>{colors.rules.filter((r) => r.id !== "joint" && r.id !== "other-known").map((r) => <span key={r.id}><i style={{ background: r.color }} />{r.label}</span>)}<span><i style={{ background: colors.defaultColor }} />待核实</span></div></div><p className="atlas-footnote">Natural Earth 概略边界 · OpenFreeMap / OpenStreetMap 街道 · WGS84 · 地图展示来源位置，并区分城市估算与办公地址，远程资格不作为办公地址。国内行政分组用于展示；本地图不用于正式测绘。多地点岗位可有多个标记，统计按岗位去重。</p></div>
      <aside className="atlas-results"><div className="atlas-results-heading"><div><span className="atlas-eyebrow">YOUR OPPORTUNITY RADAR</span><h2>{bucket ? bucket.label : t("探索机会", "Explore opportunities")} <span>{(dataMode === "live" && !data || fxUnavailable) ? "—" : bucket ? bucket.jobCount : result?.totalJobs ?? 0}</span></h2></div>{querying && <Loader2 size={16} className="animate-spin" />}{bucket && <button aria-label="取消城市选择" onClick={() => setBucket(null)}><X size={16} /></button>}</div><div className="atlas-sort"><select aria-label="岗位排序" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="salary" disabled={!coverage.salary.sortSupported}>人民币税前年薪下限{!coverage.salary.sortSupported ? " · 暂无可比数据" : ""}</option><option value="distance" disabled={!coverage.distance.ready}>离家直线距离{!coverage.distance.supported ? " · 缺岗位坐标" : !anchor ? " · 请设参照点" : ""}</option><option value="updated">最近更新</option></select><button aria-label={direction === "desc" ? "当前降序，切换升序" : "当前升序，切换降序"} onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}><ArrowDownUp size={14} />{direction === "desc" ? "降序" : "升序"}</button><label><input type="checkbox" checked={originalCurrency} onChange={(e) => setOriginalCurrency(e.target.checked)} />原币</label></div><div className="atlas-job-list" aria-busy={querying || sourceSearching || fxContext.loading || queryWritePending}>{(querying || sourceSearching || fxContext.loading || queryWritePending) && !visibleItems.length && <div className="atlas-results-loading" role="status"><span>{sourceSearching ? "正在从真实来源获取岗位…" : companyWritePending ? "正在核对企业保存回执与最新索引…" : fxContext.loading || fxWritePending ? "正在核对当前汇率上下文…" : "正在匹配岗位…"}</span>{[0, 1, 2].map((n) => <div key={n} className="atlas-skeleton-card" aria-hidden="true"><i /><i /><i /></div>)}</div>}{visibleItems.map((item) => <button key={item.job.id} className={`atlas-job-card ${selectedId === item.job.id ? "selected" : ""}`} aria-expanded={selectedId === item.job.id} aria-controls="atlas-job-detail" onClick={(event) => clickJob(item, event.detail)} onDoubleClick={() => { cancelCardClick(); void locateJob(item); }}><span className="atlas-company-line"><i style={{ background: item.color.color }} />{item.company.names[0]}<ArrowUpRight size={14} /></span><strong>{item.job.title.value}</strong><span className="atlas-job-meta"><MapPin size={12} />{item.locations.map((l) => l.officeResolution?.formattedAddress ?? l.streetAddress ?? l.city ?? l.raw).join(" / ") || "地点待核实"}{item.distance?.km !== undefined && ` · ${item.distance.estimated ? "约 " : ""}${Math.round(item.distance.km)} km`}</span><span className="atlas-job-salary">{annual(originalCurrency ? item.salary?.originalAnnual : item.salary?.cnyAnnual)}</span><AtlasListingBadges presentations={presentListing?.(item) ?? []} />{!!item.mapReferences?.length && <span className="atlas-card-hint">城市分布参考 · 城市级估算，非办公地址</span>}<span className="atlas-card-hint">单击查看详情 · 双击定位地图</span><span className="atlas-job-classification">{item.color.label} {item.color.classification.jurisdictions.map(countryName).join(" / ")}</span></button>)}{!visibleItems.length && !querying && !sourceSearching && !fxContext.loading && !queryWritePending && <div className="atlas-empty"><Search size={24} /><strong>{fxUnavailable ? "当前汇率上下文不可用" : dataLoading ? "正在读取岗位…" : emptyIndex ? "先把真实岗位接入地图" : !data && dataMode === "live" ? "后端尚未连接，岗位数量未知" : "暂未找到匹配岗位"}</strong><p>{fxUnavailable ? "当前查询、地图与统计已暂停，避免沿用旧汇率。请重试汇率上下文或重新读取索引。" : dataLoading ? "读取完成后会显示当前数据范围。" : emptyIndex ? "当前数据集还没有岗位。可从已配置来源获取岗位，或读取并收藏招聘原文；办公室地址会按来源逐岗补全。" : !data && dataMode === "live" ? "当前尚未取得真实岗位数据，不能据此判断市场没有岗位。请重试后端连接，或在设置中选择高级直连。" : "当前已收录数据没有匹配项。可从所选来源获取岗位，或放宽关键词与地区；有查询上限时不代表全站无结果。"}</p>{!dataLoading && (emptyIndex || !data) ? <><button onClick={() => connected ? void searchSourceJobs() : setSettings("connection")}>{connected ? searchableSources.length ? "从已配置来源获取岗位" : "配置岗位来源" : "打开后端状态"}</button>{onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>读取并收藏单个岗位</button>}<ol><li>确认岗位后端正在运行</li><li>搜索岗位并补全工作地点</li><li>单击阅读 · 双击定位</li></ol></> : !dataLoading && <button onClick={fxUnavailable ? fxContext.retry : resetFilters}>{fxUnavailable ? "重试汇率上下文" : "清除筛选"}</button>}</div>}{resultCurrent && listPage?.nextCursor && <button disabled={loadingMore || querying} className="atlas-load-more" onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "显示更多岗位"}</button>}</div><p className="atlas-list-note">统一比较税前固定年薪，奖金与股票不混入。未知薪资、缺少有效汇率和未知距离放在排序末尾。{fxUnavailable ? companyWritePending ? t("统计等待企业核对与同版索引。", "Counts are waiting for the company review and matching index.") : "当前薪资统计等待同版汇率上下文。" : `${result?.unknownSalaryCount ?? 0} 个岗位薪资暂不可比较。`}</p></aside>
    {!emptyIndex && !selected && !detailReviewJobId && !compensationReviewJobId && !companyReview && !enrichmentScope && layout === "wide" && <aside className="atlas-detail-placeholder" aria-label={t("岗位阅读面板", "Job reading pane")}><MapPin size={27} /><strong>{t("选择一个岗位，展开下一步。", "Select a role to explore the details.")}</strong><p>{t("单击阅读岗位原文与工作地址，双击在地图中定位。", "Click to read the posting and work address; double-click to locate it on the map.")}</p><small>{t("具体办公位置以来源披露或本人核对为准。", "Office locations follow source disclosures or your explicit review.")}</small></aside>}
    {active && enrichmentScope && connected && dataMode === "live" && liveData && <aside id="atlas-job-detail" className="atlas-job-detail atlas-enrichment-detail" aria-label="岗位办公地点批量核对面板"><div className="atlas-job-detail-body"><Suspense fallback={<p role="status">正在打开办公地点补全…</p>}><AtlasAddressEnrichment endpoint={endpoint} token={token} data={liveData} jobIds={enrichmentScope} onOfficeCandidateFocus={focusOfficeCandidate} onClose={() => { cancelOfficeFocus(); setEnrichmentScope(null); }} onSnapshot={snapshot => { setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); }} onReviewJob={jobId => {
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
    }} onOfficeCandidateFocus={focusOfficeCandidate} onOfficeSnapshot={(snapshot, location) => {
      if (liveData.revision > snapshot.revision) return;
      setOfficeFocusRequest({ id: crypto.randomUUID(), jobId: detailReviewJobId, locationId: location.id, snapshot, selectionKey, endpoint, token });
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(`办公位置已读取，索引版本 ${snapshot.revision}。符合当前筛选时会定位高亮，也可双击岗位再次定位。`);
    }} /></Suspense></div></aside>}
    {!enrichmentScope && !detailReviewJobId && !companyReview && compensationReviewJobId && active && connected && dataMode === "live" && liveData && <aside id="atlas-job-detail" className="atlas-job-detail" aria-label={t("岗位薪资核对面板", "Compensation review pane")}><div className="atlas-job-detail-body"><Suspense fallback={<p role="status">{t("正在打开来源薪资核对…", "Opening compensation review…")}</p>}><AtlasCompensationReview key={`${compensationReviewJobId}:${endpoint}:${token}`} endpoint={endpoint} token={token} data={liveData} jobId={compensationReviewJobId} queryOptions={queryOptions} queryReady={fxReady} onClose={() => setCompensationReviewJobId("")} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(t(`薪资记录已读取，索引版本 ${snapshot.revision}。列表、地图与统计按最新有效薪资重新计算。`, `Compensation records loaded at revision ${snapshot.revision}. Results, map and counts use the current compensation.`));
    }} /></Suspense></div></aside>}
    {!enrichmentScope && !detailReviewJobId && companyReview && active && connected && dataMode === "live" && liveData && <aside id="atlas-job-detail" className="atlas-job-detail" aria-label={t("企业核对阅读面板", "Company review reading pane")}><div className="atlas-job-detail-body"><Suspense fallback={<p role="status">{t("正在打开企业控股证据核对…", "Opening company control evidence review…")}</p>}><AtlasCompanyControlReview endpoint={endpoint} token={token} data={liveData} jobId={companyReview.jobId} companyId={companyReview.companyId} colorConfig={colors} onClose={() => setCompanyReview(undefined)} onSnapshot={snapshot => {
      searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot);
      setSourceSearchMessage(t(`企业核对已更新，索引版本 ${snapshot.revision}。分类、配色、筛选、列表、地图与统计采用同一版本。`, `Company review updated at revision ${snapshot.revision}. Classification, colors, filters, results, map and counts use the same version.`));
    }} /></Suspense></div></aside>}
    {!enrichmentScope && !detailReviewJobId && !compensationReviewJobId && !companyReview && selected && data && <AtlasJobDetail key={selected.job.id} item={selected} data={data} demo={dataMode === "demo"} originalCurrency={originalCurrency} presentations={presentListing?.(selected) ?? []} onReviewCompany={active && connected && dataMode === "live" ? () => { setLocationReview(undefined); setOfficeReview(undefined); setCompensationReviewJobId(""); setCompanyReview({ jobId: selected.job.id, companyId: selected.job.companyId }); } : undefined} onReviewCompensation={active && connected && dataMode === "live" ? () => { setLocationReview(undefined); setOfficeReview(undefined); setCompanyReview(undefined); setCompensationReviewJobId(selected.job.id); } : undefined} onClose={closeJob} onLocate={(locationId) => void locateJob(selected, locationId)} onSave={() => routeJob(selected, false)} onAnalyze={() => routeJob(selected, true)} onConfirmLocation={connected ? location => { setOfficeReview(undefined); setLocationReview({ jobId: selected.job.id, location }); } : undefined} onConfirmOffice={connected ? location => { setLocationReview(undefined); setOfficeReview({ jobId: selected.job.id, location }); } : undefined} onReadLocations={connected && selected.job.listingIds.some(id => data.listings.find(listing => listing.id === id)?.sourceId.startsWith("reviewed-platform-")) ? () => setDetailReviewJobId(selected.job.id) : undefined}>
      {locationReview?.jobId === selected.job.id && connected && liveData && <Suspense fallback={<p role="status">正在打开地区核对…</p>}><AtlasLocationConfirmation key={`${locationReview.jobId}:${locationReview.location.id}:${endpoint}`} endpoint={endpoint} token={token} jobId={locationReview.jobId} location={locationReview.location} revision={liveData.revision} onClose={() => setLocationReview(undefined)} onSnapshot={snapshot => {
        searchAbort.current?.abort(); setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
        setSourceSearchMessage(`已读取地区记录，索引版本 ${snapshot.revision}。当前筛选会按最新确认结果重新计算；不再符合条件的岗位会退出列表。`);
      }} /></Suspense>}
      {officeReview?.jobId === selected.job.id && active && connected && liveData && <Suspense fallback={<p role="status">正在打开办公地址核对…</p>}><AtlasOfficeAddressConfirmation key={`${officeReview.jobId}:${officeReview.location.id}:${endpoint}:${token}:${officeReview.prefillFromSourceAddress ? "source-prefill" : "manual"}`} endpoint={endpoint} token={token} jobId={officeReview.jobId} location={officeReview.location} revision={liveData.revision} prefillFromSourceAddress={officeReview.prefillFromSourceAddress} onCandidateFocus={candidate => focusOfficeCandidate(officeReview.jobId, officeReview.location, candidate)} onClose={() => setOfficeReview(undefined)} onSnapshot={snapshot => {
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

  </section>;
}
