import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, ArrowUpRight, Compass, Database, Globe2, Home, Loader2, MapPin, Palette, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, normalizeSearchText, type AtlasDataset, type CompanyColorConfig, type JobQueryInput, type JobQueryResult, type JobSearchItem, type MapBucket, type QueryOptions, type GeocodingResult, type GeocodingCandidate } from "@better-me/opportunities";
import type { OpportunitySeed } from "./OpportunityWorkspace";
import { createAtlasDemo } from "./atlas/demo";
import type { AtlasCamera } from "./atlas/prototypes/types";
import { ATLAS_BASEMAPS } from "./atlas/prototypes/basemaps";
import { buildAtlasJobAction, queryAtlasPage, readAtlasSnapshot, type AtlasJobAction } from "./atlas/client";
import { readOpportunityLibrary } from "../lib/opportunities";
import { projectLocalOpportunities } from "./atlas/local-opportunities";
import { createAtlasSourceClient } from "./atlas/service-client";
import { runAtlasSourceSearch, type AtlasAggregateProgress, type AtlasAggregateSource } from "./atlas/aggregate-search";
import { AtlasSearchProgress } from "./atlas/AtlasSearchProgress";
import { AtlasJobDetail } from "./atlas/AtlasJobDetail";
import { createJobMapFocus, type AtlasMapFocus } from "./atlas/map-focus";
import { buildAtlasCityCandidateQuery } from "./atlas/city-candidate-query";
import { getAtlasDataCoverage } from "./atlas/coverage";
import { createAtlasListingPresenter } from "./atlas/presentation";
import { AtlasListingBadges } from "./atlas/JobSourceBadges";
import { PlatformSearchLinks } from "./atlas/PlatformSearchLinks";
import { buildChinaRegionFilter, findChinaProvinceByMapId, getChinaProvinces, getChinaCities, getChinaDistricts, type ChinaRegionSelection } from "./atlas/china-regions";
import countryCatalog from "../../../../config/geography/countries.json";
import { useUiPreferences } from "../lib/ui-preferences";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture } from "@better-me/source-adapters/browser-contracts";
import "./atlas/atlas.css";

const AtlasMap = lazy(() => import("./atlas/prototypes/MapLibrePrototype"));
const AtlasSourcesPanel = lazy(() => import("./atlas/AtlasSourcesPanel").then((m) => ({ default: m.AtlasSourcesPanel })));
const AtlasSourceCandidateReview = lazy(() => import("./atlas/AtlasSourceCandidateReview").then((m) => ({ default: m.AtlasSourceCandidateReview })));
const AtlasReviewedCardImport = lazy(() => import("./atlas/AtlasReviewedCardImport").then((m) => ({ default: m.AtlasReviewedCardImport })));
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
  const [demo] = useState(createAtlasDemo);
  const [liveData, setLiveData] = useState<AtlasDataset | null>(null);
  const [dataMode, setDataMode] = useState<"demo" | "live" | "local">("local");
  const [localData, setLocalData] = useState<AtlasDataset | null>(null);
  const [localError, setLocalError] = useState("");
  const [localWarnings, setLocalWarnings] = useState(0);
  const [localLoading, setLocalLoading] = useState(false);
  const [publicationNow, setPublicationNow] = useState(() => new Date().toISOString());
  const [localReload, setLocalReload] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [searchSourceId, setSearchSourceId] = useState("");
  const [sourceSearching, setSourceSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<AtlasAggregateProgress | null>(null);
  const [sourceReview, setSourceReview] = useState<AtlasAggregateSource>();
  const [cardReview, setCardReview] = useState<ReviewedCardsCapture>();
  const [searchDepth, setSearchDepth] = useState("standard");
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
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:5178");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connectionAbort = useRef<AbortController | null>(null);
  const connectedIdentity = useRef<{ endpoint: string; token: string } | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [anchor, setAnchor] = useState<QueryOptions["anchor"]>();
  const [homeError, setHomeError] = useState("");
  const [colors, setColors] = useState(initialColors);
  const [colorsMessage, setColorsMessage] = useState("");
  const [rawResult, setResult] = useState<JobQueryResult | null>(null);
  const [resultData, setResultData] = useState<AtlasDataset | null>(null);
  const [queryError, setQueryError] = useState("");
  const [querying, setQuerying] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [bucket, setBucket] = useState<MapBucket | null>(null);
  const [mapError, setMapError] = useState("");
  const [rotating, setRotating] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [listPage, setListPage] = useState<JobQueryResult | null>(null);
  const [listItems, setListItems] = useState<JobSearchItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
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
  const searchableSources = (connected ? liveData?.sources : [])?.filter((entry) => entry.enabled && entry.status === "active" && entry.entityType === "job-posting" && entry.runtime.includes("local-service") && entry.capabilities.includes("list-jobs") && entry.entryUrl) ?? [];
  const selectedSearchSources = searchSourceId ? searchableSources.filter((entry) => entry.sourceId === searchSourceId) : searchableSources;
  const reviewSource = sourceReview ? liveData?.sources.find((entry) => entry.sourceId === sourceReview.sourceId) : undefined;
  useEffect(() => { setSourceReview(undefined); setCardReview(undefined); }, [endpoint, token]);
  const result = resultData === data ? rawResult : null;
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
    salary: { range: salaryMin || salaryMax ? { min: salaryMin ? Number(salaryMin) * 10000 : undefined, max: salaryMax ? Number(salaryMax) * 10000 : undefined } : undefined, metric: "min", includeEstimates: true, includeUnknown: !salaryMin && !salaryMax },
    distance: anchor ? { anchorRef: anchor.ref, maxKm: maxKm ? Number(maxKm) : undefined, allowCityEstimate: true, includeUnknown: !maxKm } : undefined,
    sort: { field: sort, direction }, mapLevel, page: { limit: 30 },
  }), [text, mode, country, region, regionText, chinaFilter, origin, ownership, source, salaryMin, salaryMax, anchor, maxKm, sort, direction, mapLevel, includeUnclassified]);
  const generation = useMemo(() => ({ data, query, now: new Date().toISOString() }), [data, query]);
  const queryOptions = useMemo<QueryOptions>(() => ({ now: generation.now, colorConfig: colors, anchor, domesticCountryCodes: countryCatalog.domesticCountryCodes }), [generation, colors, anchor]);
  const selectionKey = JSON.stringify({ ...query, mapLevel: "city", sort: undefined });
  useEffect(() => { cancelCardClick(); setBucket(null); setSelectedId(""); setFocus(undefined); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }, [selectionKey, dataMode]);
  useEffect(() => { if (!active) cancelCardClick(); }, [active]);
  useEffect(() => {
    queryAbort.current?.abort();
    const abort = new AbortController(); queryAbort.current = abort;
    if (!data) { setResult(null); setListPage(null); setListItems([]); return; }
    setQuerying(true); setQueryError(""); setLoadingMore(false);
    const timer = setTimeout(() => {
      void queryAtlasPage(data, query, queryOptions, { signal: abort.signal, selectedJobIds: bucket?.jobIds }).then((next) => {
        if (!abort.signal.aborted) { setResultData(data); setResult(next.summary); setListPage(next.page); setListItems(next.page.items); setQuerying(false); }
      }, (error: unknown) => { if (!abort.signal.aborted) { setResult(null); setListPage(null); setListItems([]); setQuerying(false); setQueryError(error instanceof Error ? error.message : "查询失败"); } });
    }, 120);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [data, query, queryOptions, bucket]);
  async function loadMore() {
    const abort = queryAbort.current;
    if (!data || resultData !== data || !listPage?.nextCursor || !abort || abort.signal.aborted || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await queryAtlasPage(data, query, queryOptions, { cursor: listPage.nextCursor, selectedJobIds: bucket?.jobIds, signal: abort.signal });
      if (!abort.signal.aborted) { setListPage(next.page); setListItems((items) => [...items, ...next.page.items.filter((n) => !items.some((i) => i.job.id === n.job.id))]); }
    } catch (error) { if (!abort.signal.aborted) setQueryError(error instanceof Error ? error.message : "加载失败"); }
    finally { if (!abort.signal.aborted) setLoadingMore(false); }
  }
  useEffect(() => () => { cancelCardClick(); connectionAbort.current?.abort(); searchAbort.current?.abort(); locationAbort.current?.abort(); }, []);

  async function connect() {
    searchAbort.current?.abort();
    connectionAbort.current?.abort();
    const abort = new AbortController(); connectionAbort.current = abort;
    setConnecting(true); setConnectionError("");
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const snapshot = await readAtlasSnapshot(endpoint, token, { signal: abort.signal });
      if (connectionAbort.current !== abort) return;
      connectedIdentity.current = { endpoint, token };
      setLiveData(snapshot); setDataMode("live"); setSelectedId(""); setSettings(null); setSourceSearchMessage(""); setSourceSearchError("");
    } catch (error) {
      if (connectionAbort.current === abort) setConnectionError(abort.signal.aborted ? "连接超时或已取消。请确认本机岗位服务正在运行。" : error instanceof Error ? error.message : "无法连接本机服务。");
    } finally { clearTimeout(timeout); if (connectionAbort.current === abort) setConnecting(false); }
  }
  async function searchSourceJobs() {
    if (!connected) { setSettings("connection"); setSourceSearchMessage("先连接本机来源服务，再按关键词从已配置来源获取岗位。"); return; }
    if (!selectedSearchSources.length) { setSourcesOpen(true); setSourceSearchMessage("尚无启用的岗位来源，请先添加或启用真实来源配置。"); return; }
    if (text.trim().length > 300) { setSourceSearchError("来源搜索关键词最多 300 个字符。"); return; }
    searchAbort.current?.abort(); const abort = new AbortController(); searchAbort.current = abort;
    setSourceSearching(true); setSourceSearchError(""); setSourceSearchMessage(""); setSourceReview(undefined); setBucket(null);
    const client = createAtlasSourceClient(endpoint, token);
    const requestIdentities = new Map<string, string>();
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
          const identity = JSON.stringify([endpoint, entry.sourceId, request]);
          requestIdentities.set(entry.sourceId, identity);
          let idempotencyKey = searchKeys.current.get(identity);
          if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); searchKeys.current.set(identity, idempotencyKey); }
          return { request, idempotencyKey };
        },
        sync: async (id, request, options) => {
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error("该来源等待超过 60 秒，已停止本次等待；可保留回执继续核对。")), 60000);
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
    } finally { if (searchAbort.current === abort) setSourceSearching(false); }
  }
  const visibleItems = resultData === data ? listItems : [];
  const selected = visibleItems.find((item) => item.job.id === selectedId)
    ?? (selectedCard.current?.job.id === selectedId && data?.jobs.some((job) => job.id === selectedId) ? selectedCard.current : undefined);
  function openJob(item: JobSearchItem) {
    cancelCardClick();
    if (selectedId !== item.job.id) { locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); }
    selectedCard.current = item; setSelectedId(item.job.id);
  }
  function clickJob(item: JobSearchItem, detail: number) {
    cancelCardClick();
    // Keep the card under the pointer until the native double-click sequence has ended.
    // Keyboard and assistive activations have detail=0 and open immediately.
    if (detail === 0) openJob(item);
    else if (detail === 1) cardClickTimer.current = setTimeout(() => openJob(item), 520);
  }
  function closeJob() { cancelCardClick(); locationAbort.current?.abort(); locationAbort.current = null; setLocationSearch(undefined); setSelectedId(""); setFocus(undefined); }
  function flyToJob(target: AtlasMapFocus) {
    const offset = window.innerWidth > 1200 ? Math.min(220, (scene.current?.clientWidth ?? 0) * .28) : 0;
    setFocus({ ...target, viewportOffset: [offset, 0] }); setRotating(false);
    scene.current?.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  async function locateJob(item: JobSearchItem, locationId?: string) {
    openJob(item);
    const direct = createJobMapFocus(item, crypto.randomUUID(), { locationId });
    if (direct) { locationAbort.current?.abort(); setLocationSearch(undefined); flyToJob(direct); return; }
    const location = item.locations.find((entry) => (!locationId || entry.id === locationId) && entry.kind === "office");
    if (!location) { setLocationSearch({ jobId: item.job.id, locationId: locationId ?? "", loading: false, error: "该岗位未披露可确认的办公地点，不能将远程资格或未知地点标成办公地址。" }); return; }
    if (!connected) { setLocationSearch({ jobId: item.job.id, locationId: location.id, loading: false, error: "来源只有地点原文。连接本机服务后，可查询离线城市候选；也可以打开 Google 地图核对。" }); return; }
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
  function resetFilters() { setText(""); setCountry(""); setRegion(""); setRegionText(""); setChinaSelection({}); setOrigin(""); setOwnership(""); setSource(""); setSalaryMin(""); setSalaryMax(""); setMaxKm(""); setIncludeUnclassified(false); setSort("relevance"); setDirection("desc"); setBucket(null); }

  return <section className="atlas-workspace" aria-label={t("岗位地图", "Opportunity atlas")}>
    <div className="atlas-heading"><div><span className="atlas-eyebrow">BETTERME / OPPORTUNITY ATLAS</span><h1>{t("让下一个机会，有迹可循。", "Find where your next chapter begins.")}</h1><p>{t("从全球视野，找到与你更近的工作。", "Explore opportunities across the world, and closer to home.")}</p></div><div className="atlas-top-actions"><button onClick={() => setSettings(settings === "maps" ? null : "maps")}><Globe2 size={15} />地图服务</button><button onClick={() => setSettings(settings === "home" ? null : "home")}><Home size={15} />{anchor ? t("已设置家庭参照点", "Home set") : t("设置离家距离", "Set home distance")}</button><button onClick={() => setSettings(settings === "connection" ? null : "connection")}><Database size={15} />{t("连接本机服务", "Connect local service")}</button></div></div>
    <div className={`atlas-data-banner ${dataMode}`} role="status"><span className="atlas-status-dot" /><strong>{dataMode === "demo" ? "演示模式 · 非真实招聘" : dataMode === "live" ? "真实来源 · 本机索引" : "真实来源 · 当前机会库"}</strong><span>{dataMode === "demo" ? "企业、岗位和薪资均为合成样本，不计入真实岗位。" : `${data?.jobs.length ?? 0} 个来源岗位 · ${dataMode === "local" ? "只在本页读取公开岗位字段，原机会库不变" : `索引版本 ${liveData?.revision} · 手动刷新`}`}</span><label className="atlas-data-selector">数据视图<select aria-label="岗位数据视图" value={dataMode} onChange={(e) => { searchAbort.current?.abort(); setDataMode(e.target.value as typeof dataMode); resetFilters(); }}><option value="local">当前机会库 · 真实来源</option>{liveData && <option value="live">本机采集索引 · 真实来源</option>}<option value="demo">合成演示 · 仅体验地图</option></select></label>{dataMode === "local" && <button disabled={localLoading} onClick={() => setLocalReload((n) => n + 1)}>{localLoading ? "正在读取…" : "重新读取机会库"}</button>}{dataMode === "live" && <button disabled={connecting} onClick={() => void connect()}>重新读取索引</button>}<button onClick={() => { setSourcesOpen(!sourcesOpen); setSettings(null); }}>来源工具</button>{onOpenOpportunitySources && <button onClick={onOpenOpportunitySources}>51JOB / BOSS / 猎聘 / LinkedIn 单岗读取</button>}</div>
    {localError && dataMode === "local" && <p role="alert" className="atlas-error">{localError}</p>}
    {dataMode === "local" && !!localData?.jobs.length && localWarnings > 0 && <p className="atlas-small">有 {localWarnings} 项来源字段提示：未提供的日期、结构化薪资与坐标保持未知。查看岗位详情核对原文；投递记录和联系人未进入地图数据。</p>}
    {sourcesOpen && <Suspense fallback={<p role="status">正在加载来源工具…</p>}><AtlasSourcesPanel endpoint={endpoint} token={token} onSnapshot={(snapshot) => { searchAbort.current?.abort(); setLiveData(snapshot); setDataMode("live"); }} onClose={() => setSourcesOpen(false)} /></Suspense>}
    {settings && <div className="atlas-settings"><button className="atlas-panel-close" aria-label="关闭地图设置" onClick={() => setSettings(null)}><X size={17} /></button>
      {settings === "maps" && <div><h2>地图与街道底图</h2><p>全球与国内均使用同一经纬度视图，可连续缩放至街道。开放底图无需 API Key；联网底图会向所选服务请求当前视野的瓦片，离线轮廓不请求外部地图服务。</p><label className="atlas-basemap-select">底图来源<select value={basemapId} onChange={(e) => { setBasemapId(e.target.value); setMapError(""); }}><option value="auto">OpenFreeMap · 跟随浅深主题</option>{ATLAS_BASEMAPS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}<option value="offline">本地概览 · 离线边界</option></select></label><p className="atlas-small">道路、建筑、门牌和地名是否显示取决于底图覆盖。城市级岗位不会显示成精确办公地址。Google 地图可从岗位详情的“Google 地图”入口打开；内嵌 Google Maps 尚未启用，需要个人 Key、服务权限及对应计费配置。</p></div>}
      {settings === "connection" && <form onSubmit={(e) => { e.preventDefault(); void connect(); }}><h2>{t("连接你的本机岗位索引", "Connect your local job index")}</h2><p>请先按 <code>apps/job-service/README.md</code> 启动服务，允许当前网页 Origin：<code>{window.location.origin}</code>。访问令牌仅保留在当前页面内存中。</p><div className="atlas-form-row"><label>服务地址<input value={endpoint} onChange={(e) => { connectionAbort.current?.abort(); searchAbort.current?.abort(); setEndpoint(e.target.value); }} placeholder="http://127.0.0.1:5178" /></label><label>访问令牌<input type="password" autoComplete="off" value={token} onChange={(e) => { connectionAbort.current?.abort(); searchAbort.current?.abort(); setToken(e.target.value); }} /></label><button type="submit" disabled={connecting}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{connecting ? "正在连接" : "连接并读取索引"}</button></div>{connectionError && <p role="alert" className="atlas-error">{connectionError}</p>}<p className="atlas-small">读取公开岗位快照，在本页执行共享查询。家庭参照坐标不发送给服务。公网 HTTPS 页面连接本机可能需要浏览器本地网络授权；完整体验建议使用本机网页。</p></form>}
      {settings === "home" && <form onSubmit={(e) => { e.preventDefault(); const lat = Number(latitude), lon = Number(longitude); if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { setHomeError("请输入有效的 WGS84 纬度（-90～90）和经度（-180～180）。"); return; } setAnchor({ ref: crypto.randomUUID(), latitude: lat, longitude: lon, coordinateSystem: "WGS84" }); setHomeError(""); setSettings(null); }}><h2>离家距离 · 私人参照点</h2><p>使用 WGS84 坐标计算直线距离，仅保留在本页内存。城市中心距离会标为估算；不会请求你的设备定位或将家庭坐标发送到外部。</p><div className="atlas-form-row"><label>纬度<input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="例如 31.2304" /></label><label>经度<input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="例如 121.4737" /></label><button type="submit">应用参照点</button>{anchor && <button type="button" onClick={() => { setAnchor(undefined); setLatitude(""); setLongitude(""); setMaxKm(""); if (sort === "distance") setSort("relevance"); }}>清除</button>}</div>{homeError && <p role="alert" className="atlas-error">{homeError}</p>}</form>}
      {settings === "colors" && <div><h2>企业控股来源配色</h2><p>配色依据已核实的最终控股方来源。工作地点不代表企业来源；待核实与证据冲突单列。颜色只影响岗位地图。</p><div className="atlas-color-grid">{colors.rules.map((rule, index) => <label key={rule.id}><input type="color" aria-label={`${rule.label}颜色`} value={rule.color} onChange={(e) => setColors((current) => ({ ...current, rules: current.rules.map((r, n) => n === index ? { ...r, color: e.target.value } : r) }))} /><span>{rule.label}</span></label>)}</div><div className="atlas-form-row"><button onClick={() => { try { localStorage.setItem(COLOR_KEY, JSON.stringify(CompanyColorConfigSchema.parse(colors))); setColorsMessage("配色已保存到当前浏览器。"); } catch { setColorsMessage("浏览器未允许保存，当前页面仍应用此配色。"); } }}>保存配色</button><button onClick={() => { setColors(getDefaultCompanyColorConfig()); setColorsMessage("已恢复默认配色；点击保存可保留。"); }}>恢复默认</button><span role="status">{colorsMessage}</span></div></div>}
    </div>}
    <form className="atlas-searchbar" onSubmit={(e) => { e.preventDefault(); void searchSourceJobs(); }}><label className="atlas-search"><Search size={18} /><input aria-label="搜索地图岗位" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("关键词、技能、公司… 可筛选已收录或从来源获取", "Filter indexed jobs or fetch from a source…")} /></label>{mode === "domestic" ? <div className="atlas-domestic-region" role="group" aria-label="国内省市区筛选"><span>中国</span><select aria-label="工作省份" value={chinaSelection.provinceCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: e.target.value || undefined })}><option value="">全部省份</option>{getChinaProvinces().map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作城市" disabled={!chinaCities.length} value={chinaSelection.cityCode ?? ""} onChange={(e) => setChinaSelection({ provinceCode: chinaSelection.provinceCode, cityCode: e.target.value || undefined })}><option value="">全部城市</option>{chinaCities.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select><select aria-label="工作区县" disabled={!chinaDistricts.length} value={chinaSelection.districtCode ?? ""} onChange={(e) => setChinaSelection({ ...chinaSelection, districtCode: e.target.value || undefined })}><option value="">全部区 / 县</option>{chinaDistricts.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></div> : <><select aria-label="工作国家或地区" value={country} onChange={(e) => { setCountry(e.target.value); setRegion(""); setRegionText(""); }}><option value="">{t("所有国家 / 地区", "All countries / regions")}</option>{countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}</select><label className="atlas-region-search"><MapPin size={15} /><input aria-label="工作城市或地区关键词" value={regionText} onChange={(e) => { setRegionText(e.target.value); setRegion(""); }} placeholder="城市 / 地区，如北京、Berlin" maxLength={300} /></label></>}{searchableSources.length > 0 && <select aria-label="搜索原始来源" value={searchSourceId} onChange={(e) => { searchAbort.current?.abort(); setSearchSourceId(e.target.value); }}><option value="">已配置岗位来源（{searchableSources.length}）</option>{searchableSources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.attribution.label}{entry.remoteFilters.includes("roles") ? " · 实时关键词" : " · 来源岗位"}</option>)}</select>}<select aria-label="来源读取范围" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value)}><option value="standard">按来源配置读取</option><option value="quick">快速 · 每源最多 50 条 / 2 页</option></select><button className="atlas-source-search" type="submit" disabled={sourceSearching || connecting}>{sourceSearching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}{connected ? "从来源获取岗位" : "连接真实来源搜索"}</button><button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} />{t("筛选", "Filters")}</button></form>
    <p className="atlas-small atlas-search-scope">输入会实时筛选已收录的 {data?.jobs.length ?? 0} 个岗位；{connected ? `点击获取后，查询 ${selectedSearchSources.length} 个已配置岗位来源，先返回的结果先展示；不包含下方四平台浏览器搜索。` : "连接本机服务后，可同时查询已启用的真实来源。"}读取不超过来源配置额度；详情完整度见逐源状态。</p>
    {mode === "domestic" && <p className="atlas-small">按省 → 市 → 区县逐级选择，修改上级会清除下级。大陆三级目录采用 2023 统计区划快照，部分末级为镇街/功能区；港澳台保留地区筛选，下级目录待补充。岗位只披露城市时，选择区县会排除位置不明确的岗位。</p>}
    {connected && selectedSearchSources.length > 0 && <details className="atlas-source-limits"><summary>本次实际读取范围 · {selectedSearchSources.length} 个已配置岗位来源</summary><ul>{selectedSearchSources.map((entry) => <li key={entry.sourceId}>{entry.attribution.label}：最多 {Math.min(searchDepth === "quick" ? 50 : 500, entry.refreshPolicy.maxRecords)} 条 / {Math.min(searchDepth === "quick" ? 2 : 20, entry.refreshPolicy.maxPages)} 页{entry.options?.fetchDetails === true && typeof entry.options.maxDetailRequestsPerPage === "number" ? `，每页最多 ${entry.options.maxDetailRequestsPerPage} 个详情` : ""}</li>)}</ul><p>这里只查询已配置的岗位来源（企业官网或公开聚合源）。下方原站浏览器搜索独立执行，不计入官网来源回执。</p><button type="button" onClick={() => setSourcesOpen(true)}>管理与扩展来源</button></details>}
    <PlatformSearchLinks keyword={text} regionText={mode === "domestic" ? (chinaFilter.selectedCity?.isGrouping && ["11", "12", "31", "50"].includes(chinaFilter.selectedProvince?.code ?? "") ? chinaFilter.selectedProvince?.name : chinaFilter.selectedCity?.name) ?? chinaFilter.selectedProvince?.name ?? "" : regionText || (region ? regions.find((entry) => entry.id === region)?.label ?? region : "")} countryCode={mode === "domestic" ? chinaFilter.workCountryCodes[0] ?? "CN" : country} onOpenSingleJob={onOpenOpportunitySources} onReviewCard={(card, capturedAt) => onSaveOpportunity({ token: crypto.randomUUID(), title: card.title, description: `[原站搜索列表卡片摘要，非完整 JD；请打开岗位原文核对]\n${card.cardText}`, sourceUrl: card.url, sourcePlatform: card.platform, collectedAt: capturedAt, sourcePublishedText: card.publicationText })} onIndexCard={(card, receipt, provider) => {
      if (!connected) { setSettings("connection"); setSourceSearchMessage("请先连接本机岗位索引，再核对卡片入库。"); return; }
      const parsed = ReviewedCardsCaptureSchema.safeParse({ provider, pageUrl: receipt.url, capturedAt: receipt.capturedAt, cards: [card] });
      if (!parsed.success) { setSourceSearchError("这张卡片的来源或字段证据不足，未加入索引；请打开原岗位核对。"); return; }
      setCardReview(parsed.data);
    }} />
    {cardReview && connected && liveData && <Suspense fallback={<p role="status">正在打开卡片核对…</p>}><AtlasReviewedCardImport key={`${cardReview.capturedAt}:${cardReview.cards[0]!.url}`} endpoint={endpoint} token={token} capture={cardReview} revision={liveData.revision} onClose={() => setCardReview(undefined)} onSnapshot={snapshot => {
      searchAbort.current?.abort();
      setLiveData(current => current && current.revision > snapshot.revision ? current : snapshot); setDataMode("live");
    }} /></Suspense>}
    {mode === "domestic" && chinaFilter.selectedDistrict && <p className="atlas-small">原站搜索链接只应用城市范围；区县条件在已收录岗位的位置原文中复核。尚未披露区县不算命中。</p>}
    <AtlasSearchProgress progress={searchProgress} busy={sourceSearching} onCancel={() => searchAbort.current?.abort()} onReviewSource={setSourceReview} />
    {sourceReview?.receipt && reviewSource && <Suspense fallback={<p role="status">正在加载来源候选核对…</p>}><AtlasSourceCandidateReview key={`${sourceReview.receipt.run.runId}:${endpoint}`} endpoint={endpoint} token={token} source={reviewSource} request={{ scope: sourceReview.receipt.localFilters, maxRecords: sourceReview.receipt.run.scope.maxRecords }} onClose={() => setSourceReview(undefined)} onReview={onSaveOpportunity} /></Suspense>}
    {sourceSearchMessage && <p role="status" className="atlas-search-notice">{sourceSearchMessage}</p>}
    {sourceSearchError && <p role="alert" className="atlas-error">{sourceSearchError}</p>}
    <div className="atlas-coverage" aria-label="当前索引筛选覆盖"><span>当前视图 {coverage.totalJobs} 岗</span><span>国家/地区 {coverage.country.jobs}</span><span>可比较年薪 {coverage.salary.jobs}</span><span>可计算距离 {coverage.distance.jobs}</span><span>已核实企业性质 {coverage.ownership.jobs}</span><span>已定位 {coverage.map.jobs}</span></div>
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
    {queryError && <p className="atlas-error" role="alert">{queryError}</p>}
    <div className="atlas-main-grid"><div className="atlas-map-column"><div className={`atlas-map-card ${theme}`}><div className="atlas-map-top"><div className="atlas-mode-switch" role="group" aria-label="地图范围"><button aria-pressed={mode === "global"} className={mode === "global" ? "active" : ""} onClick={() => changeMapMode("global")}><Globe2 size={15} />{t("全球", "Global")}</button><button aria-pressed={mode === "domestic"} className={mode === "domestic" ? "active" : ""} onClick={() => changeMapMode("domestic")}><MapPin size={15} />{t("国内", "China")}</button></div><span>{mapLevel === "location" ? "STREET & ADDRESS" : "3D EXPLORER"} <i /></span></div><div className="atlas-scene" ref={scene}>{active && <Suspense fallback={<div className="atlas-map-loading"><Loader2 className="animate-spin" />正在加载三维地图…</div>}><AtlasMap key={mapKey} mode={mode} basemap={basemapId === "offline" ? null : basemapId === "auto" ? undefined : ATLAS_BASEMAPS.find((p) => p.id === basemapId)} buckets={result?.mapBuckets ?? []} selectedBucketId={bucket?.id} selectedRegionId={mode === "domestic" ? chinaFilter.selectedProvince?.mapId : region || country || undefined} initialView={camera.current} focus={focus} selectedJobId={selectedId} visual={{ autoRotate: rotating, maxDpr: 1.5, pedestal: true, entrance: true, theme }} onViewChange={(view) => { camera.current = view; setMapZoom(view.zoom); }} onPick={setBucket} onCountry={(pick) => { if (mode === "domestic") { const province = findChinaProvinceByMapId(pick.id); if (province) setChinaSelection({ provinceCode: province.code }); else setSourceSearchMessage("该区域尚未纳入当前国内行政目录，请按来源披露地点查询。"); } else if (pick.countryCode) { setCountry(pick.countryCode); setRegion(""); setRegionText(""); } }} onError={(error) => setMapError(error.message)} /></Suspense>}</div><div className="atlas-map-caption"><div><span className="atlas-eyebrow">{mode === "global" ? "A WORLD OF POSSIBILITIES" : "CLOSER TO YOUR NEXT CHAPTER"}</span><strong>{mode === "global" ? t("机会，不止一座城。", "Your next role could be anywhere.") : t("在熟悉的土地，发现新可能。", "A new perspective, closer to home.")}</strong><small>拖动旋转 · 连续缩放至街道 · 城市中心与精确地址分开标注</small></div><div className="atlas-map-controls"><button aria-label="重置地图视角" title="重置视角" onClick={resetCamera}><Compass size={17} /></button><button aria-pressed={rotating} onClick={() => setRotating(!rotating)}>{rotating ? "暂停旋转" : "自动旋转"}</button></div></div>{mapError && <div role="alert" className="atlas-render-error">三维地图暂不可用：{mapError}。岗位列表仍可使用。<button onClick={() => { setMapKey((k) => k + 1); setMapError(""); }}>重试</button></div>}</div>
      <div className="atlas-stat-grid" aria-live="polite">{[[result?.totalJobs ?? 0, "匹配岗位"], [result?.companyCount ?? 0, "企业"], [result?.mappedJobs ?? 0, "已定位岗位"], [result?.unlocatedJobs ?? 0, "待定位岗位"]].map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</div><div className="atlas-legend"><div className="atlas-legend-title"><strong>企业控股来源</strong><button onClick={() => setSettings(settings === "colors" ? null : "colors")}><Palette size={14} />配置颜色</button></div><div>{colors.rules.filter((r) => r.id !== "joint" && r.id !== "other-known").map((r) => <span key={r.id}><i style={{ background: r.color }} />{r.label}</span>)}<span><i style={{ background: colors.defaultColor }} />待核实</span></div></div><p className="atlas-footnote">Natural Earth 概略边界 · OpenFreeMap / OpenStreetMap 街道 · WGS84 · 地图展示来源位置，并区分城市估算与办公地址，远程资格不作为办公地址。国内行政分组用于展示；本地图不用于正式测绘。多地点岗位可有多个标记，统计按岗位去重。</p></div>
      <aside className="atlas-results"><div className="atlas-results-heading"><div><span className="atlas-eyebrow">YOUR OPPORTUNITY RADAR</span><h2>{bucket ? bucket.label : t("探索机会", "Explore opportunities")} <span>{bucket ? bucket.jobCount : result?.totalJobs ?? 0}</span></h2></div>{querying && <Loader2 size={16} className="animate-spin" />}{bucket && <button aria-label="取消城市选择" onClick={() => setBucket(null)}><X size={16} /></button>}</div><div className="atlas-sort"><select aria-label="岗位排序" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="salary" disabled={!coverage.salary.sortSupported}>人民币税前年薪下限{!coverage.salary.sortSupported ? " · 暂无可比数据" : ""}</option><option value="distance" disabled={!coverage.distance.ready}>离家直线距离{!coverage.distance.supported ? " · 缺岗位坐标" : !anchor ? " · 请设参照点" : ""}</option><option value="updated">最近更新</option></select><button aria-label={direction === "desc" ? "当前降序，切换升序" : "当前升序，切换降序"} onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}><ArrowDownUp size={14} />{direction === "desc" ? "降序" : "升序"}</button><label><input type="checkbox" checked={originalCurrency} onChange={(e) => setOriginalCurrency(e.target.checked)} />原币</label></div><div className="atlas-job-list" aria-busy={querying || sourceSearching}>{(querying || sourceSearching) && !visibleItems.length && <div className="atlas-results-loading" role="status"><span>{sourceSearching ? "正在从真实来源获取岗位…" : "正在匹配岗位…"}</span>{[0, 1, 2].map((n) => <div key={n} className="atlas-skeleton-card" aria-hidden="true"><i /><i /><i /></div>)}</div>}{visibleItems.map((item) => <button key={item.job.id} className={`atlas-job-card ${selectedId === item.job.id ? "selected" : ""}`} aria-expanded={selectedId === item.job.id} aria-controls="atlas-job-detail" onClick={(event) => clickJob(item, event.detail)} onDoubleClick={() => { cancelCardClick(); void locateJob(item); }}><span className="atlas-company-line"><i style={{ background: item.color.color }} />{item.company.names[0]}<ArrowUpRight size={14} /></span><strong>{item.job.title.value}</strong><span className="atlas-job-meta"><MapPin size={12} />{item.locations.map((l) => l.city ?? l.raw).join(" / ") || "地点待核实"}{item.distance?.km !== undefined && ` · ${item.distance.estimated ? "约 " : ""}${Math.round(item.distance.km)} km`}</span><span className="atlas-job-salary">{annual(originalCurrency ? item.salary?.originalAnnual : item.salary?.cnyAnnual)}</span><AtlasListingBadges presentations={presentListing?.(item) ?? []} /><span className="atlas-card-hint">单击查看详情 · 双击定位地图</span><span className="atlas-job-classification">{item.color.label} {item.color.classification.jurisdictions.map(countryName).join(" / ")}</span></button>)}{!visibleItems.length && !querying && !sourceSearching && <div className="atlas-empty"><Search size={24} /><strong>暂未找到匹配岗位</strong><p>{dataMode === "local" && !localData?.jobs.length ? "当前机会库暂无岗位。点击“连接真实来源搜索”，或先读取并收藏四平台岗位。" : "当前已收录数据没有匹配项。可从所选来源获取岗位，或放宽关键词与地区；有查询上限时不代表全站无结果。"}</p><button onClick={resetFilters}>清除筛选</button></div>}{resultData === data && listPage?.nextCursor && <button disabled={loadingMore || querying} className="atlas-load-more" onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "显示更多岗位"}</button>}</div><p className="atlas-list-note">统一比较税前固定年薪，奖金与股票不混入。未知薪资、缺少有效汇率和未知距离放在排序末尾。{result?.unknownSalaryCount ?? 0} 个岗位薪资暂不可比较。</p></aside></div>
    {selected && data && <AtlasJobDetail key={selected.job.id} item={selected} data={data} demo={dataMode === "demo"} originalCurrency={originalCurrency} presentations={presentListing?.(selected) ?? []} onClose={closeJob} onLocate={(locationId) => void locateJob(selected, locationId)} onSave={() => routeJob(selected, false)} onAnalyze={() => routeJob(selected, true)}>
      {locationSearch?.jobId === selected.job.id && <div className="atlas-location-candidates" aria-label="城市定位候选">
        {locationSearch.loading && <p role="status"><Loader2 size={15} className="animate-spin" /> 正在查询本地地名库…</p>}
        {locationSearch.error && <p role="status">{locationSearch.error}</p>}
        {locationSearch.result && <><p>来源没有办公坐标。请选择城市参考点，仅用于本次地图浏览；不会写入岗位地址。</p>{locationSearch.result.candidates.map((candidate) => <button key={candidate.id} onClick={() => chooseLocationCandidate(candidate)}><MapPin size={14} />{candidate.matchedName} · {countryName(candidate.place.countryCode)} · {Object.values(candidate.place.administrativeCodes).join(" / ")}<small>城市估算 · 非办公地址</small></button>)}{!locationSearch.result.candidates.length && <p>在当前国家 / 地区范围没有找到明确候选，请打开原文核对地点。</p>}<small>{locationSearch.result.candidates[0]?.evidence.provenance.attribution}</small></>}
      </div>}
    </AtlasJobDetail>}

  </section>;
}
