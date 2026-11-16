import type { GeocoderFetch } from "./street-geocoder";

export type RawOsmEmployerItem = {
  osm_type: string;
  osm_id: string | number;
  lon: number;
  lat: number;
  name: string;
  display_name: string;
  category: string;
  type: string;
  address?: Record<string, string>;
};

export type OsmPoint = {
  longitude: number;
  latitude: number;
};

export type StreetWebEmployerCandidate = {
  id: string;
  name: string;
  streetAddress: string;
  houseNumber?: number;
  industrySummary?: string;
  longitude: number;
  latitude: number;
};

type OsmRawElement = {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  nodes?: unknown;
  tags?: Record<string, unknown>;
};

const HIGHWAY_WAY_TAGS = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "service",
  "living_street",
  "pedestrian",
]);

const DIRECTORY_OR_PORTAL_PATTERN =
  /(?:爱企查|企查查|天眼查|企知道|顺企网|启信宝|水滴信用|11467|黄页|企业名录|供应商|批发商|企业单位名录|百度百科|邮政编码|邮编查询|公交线路|招聘网|官网首页)$|企业信息查询平台|查企业_查老板|企业黄页/;

const STRICT_LISTING_DIR_PATTERN = /(?:黄页|企业名录|供应商\|批发商|企业单位名录|企业大全)/;

const NON_EMPLOYER_SNIPPET_TITLE =
  /(?:小区|公寓|宿舍|住宅|新村|家园|菜场|农贸|便利店|药房|药店|诊所|小学|中学|幼儿园|公厕|快递驿站|菜鸟驿站|丰巢|洗车|美容美发|足浴|宾馆|民宿|网吧|烟酒.*批发部|餐厅$)/;

const EMPLOYER_ALLOW_OVERRIDE =
  /(?:半导体|集成电路|微电子|芯片|晶圆|制造|工业|研发|研究院|研究所|实验室|生物医药|制药|医疗器械|光电|能源|材料|汽车|航天|航空|自动化|机器人|软件|信息技术|网络科技|人工智能|云计算|数据|电子|精密)/;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function stripRoadSuffix(road: string): string {
  return road
    .trim()
    .replace(/\s+\d+.*$/g, "")
    .replace(/(?:高架路|快速路|步行街)$/g, "")
    .trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function buildCoreOsmBbox(lon: number, lat: number, maxMeters: number): string {
  const safeMeters = Math.max(350, Math.min(950, maxMeters));
  const dLat = safeMeters / 111_320;
  const cosLat = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  const dLon = safeMeters / (111_320 * cosLat);
  return [
    (lon - dLon).toFixed(5),
    (lat - dLat).toFixed(5),
    (lon + dLon).toFixed(5),
    (lat + dLat).toFixed(5),
  ].join(",");
}

/**
 * Queries the OSM 0.6 raw map API inside a compact core box around `(lon, lat)`
 * so buildings/plants/offices/works missed by keyword search still surface along
 * with exact road polylines for street-level placement.
 */
export async function fetchRawOsmElementsAndRoads(
  lon: number,
  lat: number,
  radiusMeters: number,
  fetchImpl: GeocoderFetch,
  timeoutMs = 3_800,
  targetRoad?: string,
): Promise<{ osmItems: RawOsmEmployerItem[]; roadPoints: OsmPoint[] }> {
  const bbox = buildCoreOsmBbox(lon, lat, radiusMeters);
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bbox}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "BetterMeJobAtlas/1.0 (+local-desktop)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return { osmItems: [], roadPoints: [] };
    const payload = (await response.json()) as { elements?: unknown };
    const elements = Array.isArray(payload?.elements) ? (payload.elements as OsmRawElement[]) : [];
    if (!elements.length) return { osmItems: [], roadPoints: [] };

    const nodesById = new Map<string, OsmPoint>();
    for (const el of elements) {
      if (el.type === "node" && el.id != null) {
        const elLon = Number(el.lon);
        const elLat = Number(el.lat);
        if (Number.isFinite(elLon) && Number.isFinite(elLat)) {
          nodesById.set(String(el.id), { longitude: elLon, latitude: elLat });
        }
      }
    }

    const osmItems: RawOsmEmployerItem[] = [];
    const roadPoints: OsmPoint[] = [];
    const roadStem = targetRoad ? stripRoadSuffix(targetRoad) : "";

    for (const el of elements) {
      const tags = el.tags;
      if (!tags || typeof tags !== "object") continue;

      const elType = cleanText(el.type);
      const wayNodes = Array.isArray(el.nodes) ? el.nodes : [];

      if (
        roadStem
        && elType === "way"
        && typeof tags.highway === "string"
        && HIGHWAY_WAY_TAGS.has(tags.highway)
        && typeof tags.name === "string"
        && tags.name.includes(roadStem)
      ) {
        for (const nid of wayNodes) {
          const pt = nodesById.get(String(nid));
          if (pt) roadPoints.push(pt);
        }
      }

      const name = cleanText(tags.name) || cleanText(tags["name:zh"]) || cleanText(tags["name:en"]) || cleanText(tags.operator);
      if (!name || name.length < 2) continue;

      const office = cleanText(tags.office);
      const building = cleanText(tags.building);
      const landuse = cleanText(tags.landuse);
      const manMade = cleanText(tags.man_made);
      const amenity = cleanText(tags.amenity);
      const industrial = cleanText(tags.industrial);

      let category = "";
      let osmTagType = "";
      if (office) {
        category = "office";
        osmTagType = office;
      } else if (manMade === "works") {
        category = "man_made";
        osmTagType = "works";
      } else if (amenity === "research_institute") {
        category = "amenity";
        osmTagType = "research_institute";
      } else if (industrial) {
        category = "landuse";
        osmTagType = "industrial";
      } else if (landuse === "industrial" || landuse === "commercial") {
        category = "landuse";
        osmTagType = landuse;
      } else if (building && building !== "apartments" && building !== "residential" && building !== "house" && building !== "dormitory") {
        category = "building";
        osmTagType = building;
      } else {
        continue;
      }

      let elLon = Number(el.lon);
      let elLat = Number(el.lat);
      if ((!Number.isFinite(elLon) || !Number.isFinite(elLat)) && wayNodes.length > 0) {
        let sumLon = 0;
        let sumLat = 0;
        let count = 0;
        for (const nid of wayNodes) {
          const pt = nodesById.get(String(nid));
          if (!pt) continue;
          sumLon += pt.longitude;
          sumLat += pt.latitude;
          count++;
        }
        if (count > 0) {
          elLon = sumLon / count;
          elLat = sumLat / count;
        }
      }
      if (!Number.isFinite(elLon) || !Number.isFinite(elLat)) continue;

      const roadAddr = cleanText(tags["addr:street"]);
      const houseNo = cleanText(tags["addr:housenumber"]);
      const address: Record<string, string> = {};
      if (roadAddr) address.road = roadAddr;
      if (houseNo) address.house_number = houseNo;
      if (cleanText(tags["addr:district"])) address.city_district = cleanText(tags["addr:district"]);

      osmItems.push({
        osm_type: elType || "osm",
        osm_id: (el.id as string | number) ?? name,
        lon: elLon,
        lat: elLat,
        name,
        display_name: [name, roadAddr && houseNo ? `${roadAddr}${houseNo}` : roadAddr].filter(Boolean).join(", "),
        category,
        type: osmTagType,
        ...(Object.keys(address).length > 0 ? { address } : {}),
      });
    }

    return { osmItems, roadPoints };
  } catch {
    return { osmItems: [], roadPoints: [] };
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanCompanyCandidateName(raw: string): string {
  return raw
    .trim()
    .replace(/^[【[]+|[】\]]+$/g, "")
    .replace(/^(?:关于|走进|参观|招聘|欢迎|位於|位于|地址|在|包括|有包括|以及)/, "")
    .replace(/\s*[-_|–—]\s*(?:爱企查|企查查|天眼查|企知道|顺企网|启信宝|百度百科|官网|简介|招聘|工商信息|信用信息).*$/i, "")
    .replace(/_【[^】]*】.*$/g, "")
    .replace(/[（(][^）)]{14,}[）)]$/g, "")
    .trim();
}

function extractIndustryCue(snippet: string): string | undefined {
  const match = snippet.match(/(?:一般项目|经营范围|主营|专注于?|所属行业为?|主要从事)[:：]?\s*([^。；\n]{4,38})/);
  if (!match?.[1]) return undefined;
  return match[1].replace(/[，、,;；]+$/, "").trim();
}

export function parseDuckDuckGoStreetResults(
  html: string,
  hints: {
    road?: string;
    suburb?: string;
    district?: string;
    city?: string;
  },
  centerLon: number,
  centerLat: number,
  roadPoints: readonly OsmPoint[],
): StreetWebEmployerCandidate[] {
  const blocks = html.split(/class="result\s+results_links/i).slice(1, 20);
  if (blocks.length === 0) return [];

  const roadStem = hints.road ? stripRoadSuffix(hints.road) : "";
  const suburbStem = hints.suburb ? stripRoadSuffix(hints.suburb) : "";
  const roadRegex = roadStem ? new RegExp(`${escapeRegExp(roadStem)}\\s*(?:(\\d{1,5})\\s*号|([A-Za-z0-9-]+栋)|与|交[汇叉]|园区?)`, "u") : null;
  const candidates: Array<Omit<StreetWebEmployerCandidate, "longitude" | "latitude">> = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const titleRaw = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const snippetRaw =
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/span>/i)?.[1]
      ?? "";
    const title = stripTags(titleRaw);
    const snippet = stripTags(snippetRaw);
    if (!title && !snippet) continue;
    if (STRICT_LISTING_DIR_PATTERN.test(title)) continue;
    if (DIRECTORY_OR_PORTAL_PATTERN.test(title) && !roadRegex?.test(snippet)) continue;

    const combined = `${title} ${snippet}`;
    let matchedAddress = "";
    let houseNumber: number | undefined;

    if (roadRegex) {
      const roadMatch = combined.match(roadRegex);
      if (roadMatch) {
        houseNumber = roadMatch[1] ? Number(roadMatch[1]) : undefined;
        matchedAddress = [
          hints.district,
          houseNumber ? `${roadStem}${houseNumber}号` : `${roadStem}沿线`,
        ].filter(Boolean).join(" · ");
      }
    }

    if (!matchedAddress && suburbStem && suburbStem.length >= 2) {
      const parkAddrMatch = combined.match(
        new RegExp(`(?:位于|地址[:：]?|坐落于)[^，。；]{0,20}(${escapeRegExp(suburbStem)}[^，。；]{0,18}(?:号|路|园|港|大厦)?)`),
      );
      if (parkAddrMatch?.[1]) {
        matchedAddress = [hints.district, parkAddrMatch[1].trim()].filter(Boolean).join(" · ");
      }
    }

    if (!matchedAddress) continue;

    // Extract clean legal/research/industrial employer name from snippet first, then title prefix.
    const snippetEntityMatch = snippet.match(
      /([\u4e00-\u9fa5A-Za-z0-9（）()·]{3,30}(?:有限责任公司|股份有限公司|有限公司|研究院|研究所|实验室|产业园|创新中心|科技园|制造中心|工厂))(?:[，,]|\s|成立于|位于|是)/,
    );
    const titlePrefix = cleanCompanyCandidateName(title.split(/\s*[|｜\-–—_]\s*/)[0] ?? "");
    const rawName = cleanCompanyCandidateName(snippetEntityMatch?.[1] || titlePrefix);
    if (!rawName || rawName.length < 3 || rawName.length > 36) continue;
    if (/^[（()）]/.test(rawName)) continue;
    if (/(?:有哪些公司|有哪些企业|有什么公司|什么公司|怎么样|好不好|在哪里|在哪儿|怎么走|推荐$)/.test(rawName)) continue;
    if (rawName.replace(/（[^）]*）|\([^)]*\)|有限责任公司|股份有限公司|有限公司|分公司|公司/g, "").trim().length < 2) continue;
    if (DIRECTORY_OR_PORTAL_PATTERN.test(rawName)) continue;
    if (NON_EMPLOYER_SNIPPET_TITLE.test(rawName) && !EMPLOYER_ALLOW_OVERRIDE.test(rawName)) continue;
    if (!/(?:公司|集团|研究院|研究所|中心|工厂|工业|制造|半导体|微电子|科技|生物|医药|能源|电子|电气|光电|汽车|软件)/.test(rawName)) {
      continue;
    }

    const dedupeKey = rawName.toLowerCase().replace(/[\s()（）·\-_.]+/g, "");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      id: `streetweb-${dedupeKey.slice(0, 24)}`,
      name: rawName,
      streetAddress: matchedAddress,
      ...(Number.isFinite(houseNumber) ? { houseNumber } : {}),
      ...(extractIndustryCue(snippet) ? { industrySummary: extractIndustryCue(snippet) } : {}),
    });
  }

  if (candidates.length === 0) return [];

  // Place street-verified employers along the actual OSM road vertices when available,
  // or gently staggered along a short 45-160m street corridor around center so pins never stack.
  const anchorPts = roadPoints.length >= 2
    ? [...roadPoints].sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude)
    : [];
  const cosLat = Math.max(0.25, Math.cos((centerLat * Math.PI) / 180));

  return candidates.map((cand, index) => {
    let lon: number;
    let lat: number;
    if (anchorPts.length >= 2) {
      const ratio = candidates.length === 1 ? 0.5 : (index + 1) / (candidates.length + 1);
      const ptIdx = Math.min(anchorPts.length - 1, Math.max(0, Math.floor(ratio * (anchorPts.length - 1))));
      const base = anchorPts[ptIdx]!;
      // Nudge slightly perpendicular to avoid overlapping road centerline label
      const latOffset = (((index % 2 === 0 ? 1 : -1) * 18) / 111_320);
      lon = base.longitude;
      lat = base.latitude + latOffset;
    } else {
      const angle = ((index * 67 + 25) * Math.PI) / 180;
      const offsetMeters = 55 + index * 28;
      lon = centerLon + (offsetMeters * Math.cos(angle)) / (111_320 * cosLat);
      lat = centerLat + (offsetMeters * Math.sin(angle)) / 111_320;
    }

    return {
      ...cand,
      longitude: Number(lon.toFixed(6)),
      latitude: Number(lat.toFixed(6)),
    };
  });
}

let ddgCooldownUntil = 0;

/**
 * Fetches OSM entities via Komoot Photon without Nominatim's strict per-IP QPS cap
 * so broader manufacturing, park, and R&D campuses within `radiusMeters` stay covered.
 */
export async function fetchPhotonBoundedEmployers(
  lon: number,
  lat: number,
  radiusMeters: number,
  fetchImpl: GeocoderFetch,
  timeoutMs = 3_200,
): Promise<RawOsmEmployerItem[]> {
  const dLat = radiusMeters / 111_320;
  const cosLat = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  const dLon = radiusMeters / (111_320 * cosLat);
  const bbox = [
    Math.max(-180, lon - dLon).toFixed(5),
    Math.max(-85, lat - dLat).toFixed(5),
    Math.min(180, lon + dLon).toFixed(5),
    Math.min(85, lat + dLat).toFixed(5),
  ].join(",");

  const terms = ["公司", "工业"];
  const results: RawOsmEmployerItem[] = [];

  await Promise.all(
    terms.map(async (q) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url =
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}` +
          `&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}` +
          `&bbox=${encodeURIComponent(bbox)}&limit=25`;
        const res = await fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": "BetterMeJobAtlas/1.0" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { features?: unknown[] };
        const features = Array.isArray(payload?.features) ? payload.features : [];
        for (const f of features) {
          if (!f || typeof f !== "object") continue;
          const feat = f as { geometry?: { coordinates?: unknown[] }; properties?: Record<string, unknown> };
          const coords = feat.geometry?.coordinates;
          const pLon = Array.isArray(coords) ? Number(coords[0]) : NaN;
          const pLat = Array.isArray(coords) ? Number(coords[1]) : NaN;
          if (!Number.isFinite(pLon) || !Number.isFinite(pLat)) continue;
          const props = feat.properties ?? {};
          const name = cleanText(props.name);
          if (!name || name.length < 2) continue;
          const category = cleanText(props.osm_key) || "office";
          const osmType = cleanText(props.osm_value) || "company";
          const addr: Record<string, string> = {};
          if (cleanText(props.district)) addr.city_district = cleanText(props.district);
          if (cleanText(props.street)) addr.road = cleanText(props.street);
          const rawPhotonOsmType = cleanText(props.osm_type).toUpperCase();
          const osmTypeNormalized = rawPhotonOsmType === "W"
            ? "way"
            : rawPhotonOsmType === "N"
              ? "node"
              : rawPhotonOsmType === "R"
                ? "relation"
                : rawPhotonOsmType.toLowerCase() || "pho";
          results.push({
            osm_type: osmTypeNormalized,
            osm_id: (props.osm_id as string | number) ?? name,
            lon: pLon,
            lat: pLat,
            name,
            display_name: [name, addr.road, addr.city_district].filter(Boolean).join(", "),
            category,
            type: osmType,
            ...(Object.keys(addr).length > 0 ? { address: addr } : {}),
          });
        }
      } catch {
        // Non-fatal: Photon is supplementary to OSM map + Nominatim.
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return results;
}

/**
 * Discovers unmapped street-corridor employers across China (manufacturing fabs,
 * plants, R&D campuses, offices) via one polite public web street query without hardcoding.
 */
export async function discoverStreetEmployersViaWeb(
  params: {
    longitude: number;
    latitude: number;
    road?: string;
    district?: string;
    city?: string;
    suburb?: string;
    roadPoints: readonly OsmPoint[];
  },
  fetchImpl: GeocoderFetch,
  timeoutMs = 3_600,
): Promise<StreetWebEmployerCandidate[]> {
  if (Date.now() < ddgCooldownUntil) return [];
  const roadStem = params.road ? stripRoadSuffix(params.road) : "";
  const city = cleanText(params.city).replace(/市$/, "");
  const district = cleanText(params.district);
  const suburb = cleanText(params.suburb);
  if (!roadStem && !suburb) return [];

  const q = roadStem
    ? [city, district, roadStem, "有限公司", "企业"].filter(Boolean).join(" ")
    : [city, suburb, "企业", "研发", "制造"].filter(Boolean).join(" ");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });
    // Back off politely when DuckDuckGo returns a deferred/rate-limit challenge status (202/429).
    if (res.status === 202 || res.status === 429) {
      ddgCooldownUntil = Date.now() + 90_000;
      return [];
    }
    if (!res.ok) return [];
    const html = await res.text();
    if (!html) return [];
    const parsed = parseDuckDuckGoStreetResults(
      html,
      { road: roadStem, suburb, district, city },
      params.longitude,
      params.latitude,
      params.roadPoints,
    );
    return parsed.slice(0, 14);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
