import { existsSync, readFileSync } from "node:fs";
import { resolveJobAtlasCacheFile } from "./job-atlas-paths";
import {
  classifyEnterpriseOwnershipAndOrigin,
  type EnterpriseControllerEntry,
} from "../src/components/atlas/company-intelligence-catalog";
import { getNetworkFetch } from "./network-proxy";
import {
  discoverStreetEmployersViaWeb,
  fetchPhotonBoundedEmployers,
  fetchRawOsmElementsAndRoads,
  type OsmPoint,
  type StreetWebEmployerCandidate,
} from "./nearby-web-discovery";
import { reverseGeocodeStreet, type GeocoderFetch } from "./street-geocoder";

export type NearbyCompanyKind = "company" | "research" | "park";

export type NearbyStreetHints = {
  road?: string;
  district?: string;
  city?: string;
  suburb?: string;
};

export type NearbyCompanyResult = {
  id: string;
  name: string;
  shortName: string;
  searchKeyword: string;
  kind: NearbyCompanyKind;
  longitude: number;
  latitude: number;
  distanceMeters: number;
  streetAddress?: string;
  ownershipLabel: string;
  ownershipColor: string;
  ownershipReason: string;
  controllers: EnterpriseControllerEntry[];
  sourceTag?: "osm-map" | "street-web";
};

export type NearbyCompaniesResponse = {
  ok: true;
  center: {
    longitude: number;
    latitude: number;
    radiusMeters: number;
  };
  companies: NearbyCompanyResult[];
  cached: boolean;
  source: "osm-nominatim";
};

type NominatimSearchItem = {
  osm_type?: unknown;
  osm_id?: unknown;
  place_id?: unknown;
  lon?: unknown;
  lat?: unknown;
  name?: unknown;
  display_name?: unknown;
  category?: unknown;
  type?: unknown;
  address?: Record<string, unknown> | null;
};

type CacheEntry = {
  expiresAt: number;
  companies: NearbyCompanyResult[];
};

const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 120;
const nearbyCache = new Map<string, CacheEntry>();

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BetterMe-Atlas/1.0",
};

type CachedIntelEntry = {
  categoryLabel?: string;
  reason?: string;
  controllers?: EnterpriseControllerEntry[];
};

let cachedIntelMap: Record<string, CachedIntelEntry> | null = null;

function readCompanyIntelCache(): Record<string, CachedIntelEntry> {
  if (cachedIntelMap) return cachedIntelMap;
  try {
    const file = resolveJobAtlasCacheFile("company-intelligence-cache.json");
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cachedIntelMap = parsed as Record<string, CachedIntelEntry>;
        return cachedIntelMap;
      }
    }
  } catch { /* Non-fatal: continue with structural classification. */ }
  cachedIntelMap = {};
  return cachedIntelMap;
}

function resolveOwnershipDisplay(
  rawName: string,
  kind: NearbyCompanyKind,
  displayName: string,
  streetAddress?: string,
): {
  ownershipLabel: string;
  ownershipColor: string;
  ownershipReason: string;
  controllers: EnterpriseControllerEntry[];
} {
  const intelCache = readCompanyIntelCache();
  const cached = intelCache[rawName.trim().toLowerCase()];
  if (cached?.categoryLabel && Array.isArray(cached.controllers) && cached.controllers.length > 0 && !cached.reason?.includes("工商企业注册名称")) {
    return {
      ownershipLabel: cached.categoryLabel,
      ownershipColor: resolveOwnershipColor(cached.categoryLabel, kind),
      ownershipReason: cached.reason ?? "来自本机已核实企业控股缓存。",
      controllers: cached.controllers,
    };
  }

  const intel = classifyEnterpriseOwnershipAndOrigin({
    companyName: rawName,
    locationTexts: [displayName, streetAddress ?? ""].filter(Boolean),
  });
  const isFallback = intel.reason.includes("工商企业注册名称");
  if (!isFallback) {
    return {
      ownershipLabel: intel.categoryLabel,
      ownershipColor: resolveOwnershipColor(intel.categoryLabel, kind),
      ownershipReason: intel.reason,
      controllers: intel.controllers,
    };
  }

  // Structural regional-HQ / Latin-brand cues avoid mislabeling multinationals as domestic private firms.
  const hasMultinationalStructure = /(?:亚太(?:研发|区|总部|技术)|研究开发协创中心)|^[A-Z]{2,}(?:上海|北京|中国|\b)/.test(rawName);
  if (hasMultinationalStructure) {
    return {
      ownershipLabel: "外资 / 跨国分支（待核实）",
      ownershipColor: "#76BD8A",
      ownershipReason: "名称含亚太研发 / 外企分支结构线索，具体控股比例待进一步核对。",
      controllers: intel.controllers,
    };
  }

  const fallbackLabel = kind === "park"
    ? "产业园 / 写字楼"
    : kind === "research"
      ? "研发机构（控股待核）"
      : "企业实体（控股待核）";
  return {
    ownershipLabel: fallbackLabel,
    ownershipColor: kind === "park" ? "#94A3B8" : "#38BDF8",
    ownershipReason: "来自 OSM 真实地图实体，控股性质尚未联网核对。",
    controllers: intel.controllers,
  };
}

const EXCLUDED_CATEGORIES = new Set([
  "place",
  "highway",
  "railway",
  "waterway",
  "natural",
  "boundary",
  "historic",
  "tourism",
  "leisure",
  "shop",
]);

const INFRASTRUCTURE_NOISE_PATTERN =
  /(?:垃圾|码头|堆放区?|吊车|塔吊|变电站|开关站|泵站|污水处理|污水厂|自来水厂|净水厂|加油站|加气站|充电站|收费站|遗址|古迹|坟|墓|陵园|宗祠|教堂|清真寺|寺庙|菜场|农贸|公厕|公共厕所|停车场|立体车库|地铁站|公交站|公交枢纽|高架桥|立交桥|隧道|高速出口|服务区|教学楼|实验楼|学院楼|宿舍楼|出入口$)|^[\d一二三四五六七八九十A-Za-z-]+(?:号楼|座|幢|栋|单元)$/;

const NON_EMPLOYER_NAME_PATTERN =
  /(?:小区|公寓|宿舍|住宅|新村|家园|苑$|花园$|号院$|弄\d|菜场|农贸|超市|便利店|药房|药店|诊所|卫生室|社区卫生|小学|中学|幼儿园|学院|教学楼|食堂|图书馆|体育馆|公园|公厕|停车场|地铁站|公交站|酒店|宾馆|招待所|民宿|网吧|足浴|美发|美容院|环卫|生活广场|购物广场|百货|派出所|消防(?:支队|大队|中队|救援站)|居委会|村委会|党群服务|早教|驾校|废品|洗车|快递驿站|菜鸟驿站|丰巢)/;

const EXPLICIT_COMPANY_NAME_PATTERN =
  /(?:有限公司|有限责任公司|股份有限公司|分公司|集团|科技|软件|信息|半导体|集成电路|微电子|芯片|晶圆|存储|闪存|智能|机器人|网络|数据|生物|医药|制药|医疗|器械|能源|新能源|电力|汽车|零部件|机械|精密|装备|工业|制造|实业|电气|电子|光电|光学|航空|航天|自动化|通信|纤维|材料|新材料|化工|环保|物流|供应链|咨询|设计院|工程|建工|建筑|证券|基金|银行|保险|金融|投资|控股|贸易|传媒|食品|农业|工厂|厂$|微软|英特尔|华为|字节|腾讯|阿里|百度|美团|网易|米哈游|哔哩|商飞|中兴|东软|西门子|博世|霍尼韦尔|埃克森美孚|阿斯利康|欧姆龙|日立|东丽|富士康|宁德时代|盛大|华域|ATLATL|SMC|IBM|SAP|Oracle|NVIDIA|AMD|Tesla|ST Electronics|Semiconductor|Electronics|Manufacturing|Industrial|Pharma|Logistics|Corp\b|Inc\b|Co\.,?\s*Ltd)/i;

const RESEARCH_NAME_PATTERN = /(?:研究院|研究所|研发中心|协创中心|创新中心|实验室|技术中心|工程中心|Research)/i;

const PARK_OR_BUILDING_PATTERN = /(?:科技园|软件园|产业园|创意港|创新园|大厦|商务楼|办公楼|科创园|数字港|创业园|SOHO|中心$|广场$|\b(?:Building|Tower|Park|Campus|Phase|Fab)\s*\d+$)/i;

const LOW_SIGNAL_PROPERTY_PATTERN = /(?:物业管理|物业服务|城区管理|保洁|停车管理|菜市场)/;

const MAX_NEARBY_EMPLOYER_RESULTS = 45;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Derives a concise display name and a high-recall job search brand keyword
 * from a registered OSM entity title (e.g. "东软集团（上海）有限公司" -> "东软集团").
 */
export function deriveEmployerSearchLabels(rawName: string): { shortName: string; searchKeyword: string } {
  const firstSegment = rawName.split(/[;；]/)[0]?.trim() || rawName;
  const normalized = firstSegment.trim().replace(/\s+/g, " ");
  let short = normalized
    .replace(/（[^）]{1,12}）|\([^)]{1,12}\)/g, "")
    .replace(/(?:有限责任公司|股份有限公司|有限公司|分公司)$/g, "")
    .trim();
  if (!short || short.length < 2) {
    short = normalized;
  }

  let keyword = short
    .replace(/的?(?:客户服务部|研发部|事业部|亚太研发|中国研发|上海研发|研发中心|研究开发协创中心|研发基地|未来能源研究院|研究院|研究所|协创中心|创新中心)$/g, "")
    .replace(/(?:中国|上海|北京|深圳|杭州|苏州|南京|成都|武汉|西安)$/g, "")
    .trim();

  // Keep short distinct brand stems while guarding against over-stripping 1-char prefixes.
  if (keyword.length < 2) {
    keyword = short;
  }
  return {
    shortName: short.length > 16 ? `${short.slice(0, 15)}…` : short,
    searchKeyword: keyword,
  };
}

function resolveOwnershipColor(categoryLabel: string, kind: NearbyCompanyKind): string {
  if (/外企|港资|台资/.test(categoryLabel)) return "#76BD8A";
  if (/央企|国企|国有控股/.test(categoryLabel)) return "#D6A627";
  if (/合资/.test(categoryLabel)) return "#81739D";
  if (/民营|私企/.test(categoryLabel)) return "#D75E61";
  return kind === "park" ? "#94A3B8" : "#38BDF8";
}

function formatOsmStreetAddress(address: Record<string, unknown> | null | undefined): string | undefined {
  if (!address || typeof address !== "object") return undefined;
  const district = cleanText(address.city_district) || cleanText(address.district) || cleanText(address.county) || cleanText(address.state_district);
  const road = cleanText(address.road) || cleanText(address.pedestrian);
  const houseNumber = cleanText(address.house_number);
  const parts: string[] = [];
  if (district) parts.push(district);
  if (road) parts.push(houseNumber && !road.includes(houseNumber) ? `${road} ${houseNumber}` : road);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Evaluates raw OSM Nominatim search hits around a coordinate and returns
 * verified employer / research / office park entities ordered for job seeking.
 */
export function parseNearbyCompaniesFromNominatim(
  rawItems: readonly unknown[],
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
): NearbyCompanyResult[] {
  const results: NearbyCompanyResult[] = [];
  const seenNames = new Set<string>();

  for (let index = 0; index < rawItems.length; index++) {
    const item = rawItems[index] as NominatimSearchItem | null;
    if (!item || typeof item !== "object") continue;

    const lon = Number(item.lon);
    const lat = Number(item.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    if (Math.abs(lon) < 1e-6 && Math.abs(lat) < 1e-6) continue;

    const category = cleanText(item.category).toLowerCase();
    const osmType = cleanText(item.type).toLowerCase();
    if (EXCLUDED_CATEGORIES.has(category)) continue;
    if (category === "amenity" && osmType !== "research_institute") continue;
    if ((osmType === "university" || osmType === "school" || osmType === "college" || osmType === "hospital") && !RESEARCH_NAME_PATTERN.test(cleanText(item.name))) {
      continue;
    }

    const displayName = cleanText(item.display_name);
    const rawName = cleanText(item.name) || cleanText(displayName.split(",")[0]);
    if (!rawName || rawName.length < 2) continue;

    const isExplicitCompany = EXPLICIT_COMPANY_NAME_PATTERN.test(rawName);
    const isResearch = RESEARCH_NAME_PATTERN.test(rawName) || osmType === "research_institute" || osmType === "research";
    const isPark = PARK_OR_BUILDING_PATTERN.test(rawName);
    const isOfficeTag = category === "office" || category === "company";
    const isIndustrialOrWorksTag =
      (category === "man_made" && osmType === "works")
      || (category === "landuse" && (osmType === "industrial" || osmType === "commercial"))
      || (category === "building" && ["office", "industrial", "commercial", "manufacture", "warehouse", "factory"].includes(osmType));

    if (LOW_SIGNAL_PROPERTY_PATTERN.test(rawName) || INFRASTRUCTURE_NOISE_PATTERN.test(rawName)) continue;
    if (!isExplicitCompany && NON_EMPLOYER_NAME_PATTERN.test(rawName)) continue;
    if (category === "landuse" && osmType === "residential" && !isExplicitCompany) continue;

    // Require clear employer, manufacturing, R&D, or office-park semantics rather than stray landmarks.
    if (!isOfficeTag && !isIndustrialOrWorksTag && !isExplicitCompany && !isResearch && !isPark) {
      continue;
    }

    const distanceMeters = haversineMeters(centerLon, centerLat, lon, lat);
    if (distanceMeters > radiusMeters * 1.15) continue;

    const dedupeKey = rawName.toLowerCase().replace(/[\s()（）·\-_.]+/g, "");
    if (seenNames.has(dedupeKey)) continue;
    seenNames.add(dedupeKey);

    const isBareBuildingCode = /(?:[一二三四五六七八九十\d]+号楼|^[A-Za-z]{2,14}\s*\d+)$/.test(rawName);
    const isLegalCompany =
      /(?:有限公司|有限责任公司|股份有限公司|分公司|集团|制造|工业|半导体|电子|生物|医药|能源|材料)/.test(rawName)
      || isOfficeTag
      || (!isBareBuildingCode && ((category === "man_made" && osmType === "works")
        || (category === "building" && ["industrial", "manufacture", "factory"].includes(osmType))));
    const kind: NearbyCompanyKind = (isPark || isBareBuildingCode) && !isLegalCompany
      ? "park"
      : isResearch
        ? "research"
        : isExplicitCompany || isOfficeTag || isIndustrialOrWorksTag
          ? "company"
          : "park";

    const streetAddress = formatOsmStreetAddress(item.address);
    const ownership = resolveOwnershipDisplay(rawName, kind, displayName, streetAddress);
    const labels = deriveEmployerSearchLabels(rawName);
    const idPrefix = cleanText(item.osm_type) || "osm";
    const idVal = item.osm_id ?? item.place_id ?? index;

    results.push({
      id: `${idPrefix}-${String(idVal)}`,
      name: rawName,
      shortName: labels.shortName,
      searchKeyword: labels.searchKeyword,
      kind,
      longitude: Number(lon.toFixed(6)),
      latitude: Number(lat.toFixed(6)),
      distanceMeters,
      ...(streetAddress ? { streetAddress } : {}),
      ...ownership,
      sourceTag: "osm-map",
    });
  }

  return sortAndCompactNearbyCompanies(results);
}

function sortAndCompactNearbyCompanies(results: NearbyCompanyResult[]): NearbyCompanyResult[] {
  const kindWeight: Record<NearbyCompanyKind, number> = {
    company: 0,
    research: 1,
    park: 2,
  };

  const ordered = [...results].sort((left, right) => {
    const kindDiff = kindWeight[left.kind] - kindWeight[right.kind];
    if (kindDiff !== 0) return kindDiff;
    return left.distanceMeters - right.distanceMeters;
  });

  // Suppress duplicate close-by entries sharing the same stripped search brand inside 60m.
  const compacted: NearbyCompanyResult[] = [];
  const seenDedupKeys = new Set<string>();
  for (const item of ordered) {
    const nameKey = item.name.toLowerCase().replace(/[\s()（）·\-_.]+/g, "");
    if (seenDedupKeys.has(nameKey)) continue;
    const duplicateBrandNearby = compacted.some(
      (kept) =>
        kept.searchKeyword.toLowerCase() === item.searchKeyword.toLowerCase()
        && haversineMeters(kept.longitude, kept.latitude, item.longitude, item.latitude) < 60,
    );
    if (duplicateBrandNearby) continue;
    seenDedupKeys.add(nameKey);
    compacted.push(item);
    if (compacted.length >= MAX_NEARBY_EMPLOYER_RESULTS) break;
  }

  return compacted;
}

function convertStreetWebCandidates(
  candidates: readonly StreetWebEmployerCandidate[],
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
): NearbyCompanyResult[] {
  const converted: NearbyCompanyResult[] = [];
  for (const cand of candidates) {
    const distanceMeters = haversineMeters(centerLon, centerLat, cand.longitude, cand.latitude);
    if (distanceMeters > radiusMeters * 1.15) continue;
    const isResearch = RESEARCH_NAME_PATTERN.test(cand.name);
    const isPark = PARK_OR_BUILDING_PATTERN.test(cand.name) && !/(?:有限公司|集团)/.test(cand.name);
    const kind: NearbyCompanyKind = isPark ? "park" : isResearch ? "research" : "company";
    const baseOwnership = resolveOwnershipDisplay(cand.name, kind, cand.streetAddress, cand.streetAddress);
    const labels = deriveEmployerSearchLabels(cand.name);
    converted.push({
      id: cand.id,
      name: cand.name,
      shortName: labels.shortName,
      searchKeyword: labels.searchKeyword,
      kind,
      longitude: cand.longitude,
      latitude: cand.latitude,
      distanceMeters,
      streetAddress: cand.streetAddress,
      ...baseOwnership,
      ownershipReason: cand.industrySummary
        ? `街道公开工商/招聘线索（主营：${cand.industrySummary}）；点击可跨平台检索全部在招工种。`
        : "来自所在街道公开工商与企业目录检索，支持按公司跨平台查全部在招岗位。",
      sourceTag: "street-web",
    });
  }
  return converted;
}

function buildViewbox(longitude: number, latitude: number, radiusMeters: number): string {
  const cosLat = Math.max(0.15, Math.cos((latitude * Math.PI) / 180));
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * cosLat);
  const west = Math.max(-180, longitude - dLon);
  const east = Math.min(180, longitude + dLon);
  const north = Math.min(85, latitude + dLat);
  const south = Math.max(-85, latitude - dLat);
  return `${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)},${south.toFixed(5)}`;
}

async function queryNominatimBounded(
  term: string,
  viewbox: string,
  fetchImpl: GeocoderFetch,
  timeoutMs: number,
): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(term)}` +
    `&format=jsonv2&addressdetails=1&bounded=1&viewbox=${viewbox}&limit=20&accept-language=zh-CN`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function clearNearbyCompaniesCache(): void {
  nearbyCache.clear();
}

function inferStreetHintsFromNominatim(items: readonly unknown[]): NearbyStreetHints {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const addr = (item as NominatimSearchItem).address;
    if (!addr || typeof addr !== "object") continue;
    const road = cleanText(addr.road) || cleanText(addr.pedestrian);
    const district = cleanText(addr.city_district) || cleanText(addr.district) || cleanText(addr.county);
    const city = cleanText(addr.city) || cleanText(addr.town) || cleanText(addr.state);
    const suburb = cleanText(addr.suburb) || cleanText(addr.neighbourhood) || cleanText(addr.quarter);
    if (road || suburb) {
      return {
        ...(road ? { road } : {}),
        ...(district ? { district } : {}),
        ...(city ? { city } : {}),
        ...(suburb ? { suburb } : {}),
      };
    }
  }
  return {};
}

/**
 * Discovers real surrounding employers, R&D centers, factories, and office parks around
 * a WGS-84 coordinate across all industries so Atlas surfaces nearby career targets everywhere.
 */
export async function discoverNearbyCompanies(
  longitude: number,
  latitude: number,
  options: {
    radiusMeters?: number;
    fetchImpl?: GeocoderFetch;
    timeoutMs?: number;
    bypassCache?: boolean;
    streetHints?: NearbyStreetHints;
  } = {},
): Promise<NearbyCompaniesResponse> {
  const radiusMeters = Math.max(500, Math.min(5_000, Math.round(options.radiusMeters ?? 2_500)));
  const roadCacheTag = cleanText(options.streetHints?.road || options.streetHints?.suburb).slice(0, 24);
  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)},${Math.round(radiusMeters / 500) * 500}${roadCacheTag ? `:${roadCacheTag}` : ""}`;
  const now = Date.now();

  if (!options.bypassCache) {
    const hit = nearbyCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return {
        ok: true,
        center: { longitude, latitude, radiusMeters },
        companies: hit.companies.map((entry) => ({
          ...entry,
          distanceMeters: haversineMeters(longitude, latitude, entry.longitude, entry.latitude),
        })),
        cached: true,
        source: "osm-nominatim",
      };
    }
  }

  const fetchImpl = options.fetchImpl ?? (await getNetworkFetch());
  const timeoutMs = options.timeoutMs ?? 5_200;
  const viewbox = buildViewbox(longitude, latitude, radiusMeters);
  // Keep Nominatim concurrency low (<=3 terms) to avoid 429s; pair with Photon + OSM 0.6 raw map API.
  const terms = [
    "[office=company]",
    "[landuse=industrial]",
    "有限公司",
  ];

  const rawOsmPromise = fetchRawOsmElementsAndRoads(
    longitude,
    latitude,
    radiusMeters,
    fetchImpl,
    Math.min(timeoutMs, 3_800),
    options.streetHints?.road,
  ).catch(() => ({ osmItems: [], roadPoints: [] as OsmPoint[] }));

  const photonPromise = fetchPhotonBoundedEmployers(
    longitude,
    latitude,
    radiusMeters,
    fetchImpl,
    Math.min(timeoutMs, 3_400),
  ).catch(() => []);

  const initialWebPromise = (options.streetHints?.road || options.streetHints?.suburb)
    ? discoverStreetEmployersViaWeb(
        {
          longitude,
          latitude,
          road: options.streetHints.road,
          district: options.streetHints.district,
          city: options.streetHints.city,
          suburb: options.streetHints.suburb,
          roadPoints: [],
        },
        fetchImpl,
        Math.min(timeoutMs, 3_800),
      ).catch(() => [] as StreetWebEmployerCandidate[])
    : null;

  const [batches, rawOsm, photonItems, initialWebHits] = await Promise.all([
    Promise.all(terms.map((term) => queryNominatimBounded(term, viewbox, fetchImpl, timeoutMs))),
    rawOsmPromise,
    photonPromise,
    initialWebPromise ?? Promise.resolve([] as StreetWebEmployerCandidate[]),
  ]);

  const roadPoints = rawOsm.roadPoints;

  // Deduplicate raw OSM, Photon & Nominatim hits before parsing/sorting
  const merged = new Map<string, unknown>();
  for (const list of [...batches, rawOsm.osmItems, photonItems]) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as NominatimSearchItem;
      const key = `${cleanText(rec.osm_type)}:${String(rec.osm_id ?? rec.place_id ?? Math.random())}`;
      if (!merged.has(key)) merged.set(key, item);
    }
  }

  // Fallback to office towers ("大厦") when mapped employer density is still sparse
  const osmPreview = parseNearbyCompaniesFromNominatim([...merged.values()], longitude, latitude, radiusMeters);
  if (osmPreview.filter((entry) => entry.kind !== "park").length < 6) {
    const towers = await queryNominatimBounded("大厦", viewbox, fetchImpl, Math.min(timeoutMs, 3_200));
    for (const item of towers) {
      if (!item || typeof item !== "object") continue;
      const rec = item as NominatimSearchItem;
      const key = `${cleanText(rec.osm_type)}:${String(rec.osm_id ?? rec.place_id ?? Math.random())}`;
      if (!merged.has(key)) merged.set(key, item);
    }
  }

  let webHits = initialWebHits;
  if (!initialWebPromise) {
    let resolvedHints = inferStreetHintsFromNominatim([...merged.values()]);
    if (!resolvedHints.road && !resolvedHints.suburb) {
      const rev = await reverseGeocodeStreet(longitude, latitude, { fetchImpl, timeoutMs: 1_800 }).catch(() => null);
      if (rev) {
        const primaryCity = rev.cityLabel.split("·").pop()?.trim() || rev.cityLabel;
        resolvedHints = {
          road: rev.road,
          district: rev.district,
          city: primaryCity,
          suburb: rev.subdistrict,
        };
      }
    }
    if (resolvedHints.road || resolvedHints.suburb) {
      webHits = await discoverStreetEmployersViaWeb(
        {
          longitude,
          latitude,
          road: resolvedHints.road,
          district: resolvedHints.district,
          city: resolvedHints.city,
          suburb: resolvedHints.suburb,
          roadPoints,
        },
        fetchImpl,
        Math.min(timeoutMs, 3_600),
      ).catch(() => [] as StreetWebEmployerCandidate[]);
    }
  } else if (roadPoints.length >= 2 && webHits.length > 0) {
    // Anchor street-web candidates onto real OSM road polyline points when road vertices arrived in parallel
    const anchorPts = [...roadPoints].sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude);
    webHits = webHits.map((cand, index) => {
      const ratio = webHits.length === 1 ? 0.5 : (index + 1) / (webHits.length + 1);
      const ptIdx = Math.min(anchorPts.length - 1, Math.max(0, Math.floor(ratio * (anchorPts.length - 1))));
      const base = anchorPts[ptIdx]!;
      return {
        ...cand,
        longitude: Number(base.longitude.toFixed(6)),
        latitude: Number((base.latitude + ((index % 2 === 0 ? 1 : -1) * 18) / 111_320).toFixed(6)),
      };
    });
  }

  const osmCompanies = parseNearbyCompaniesFromNominatim([...merged.values()], longitude, latitude, radiusMeters);
  const webCompanies = convertStreetWebCandidates(webHits, longitude, latitude, radiusMeters);
  const companies = sortAndCompactNearbyCompanies([...osmCompanies, ...webCompanies]);

  if (companies.length > 0) {
    if (nearbyCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = nearbyCache.keys().next().value;
      if (firstKey) nearbyCache.delete(firstKey);
    }
    nearbyCache.set(cacheKey, {
      expiresAt: now + CACHE_TTL_MS,
      companies,
    });
  }

  return {
    ok: true,
    center: { longitude, latitude, radiusMeters },
    companies,
    cached: false,
    source: "osm-nominatim",
  };
}
