import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OfficeAddressCandidateSchema, SourceDefinitionSchema, ToolError, type JobLocation, type OfficeAddressCandidate, type ToolHandlerContext } from "@better-me/opportunities";
import { SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import type { OfficeAddressProvider } from "./office-address.js";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };

/** Host opt-in only. Never autocomplete or bulk-geocode the job index against this public service. */
export const OfficeGeocoderConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("nominatim") }).strict(),
  z.object({ provider: z.literal("amap"), key: z.string().trim().min(1).optional() }).strict(),
]);
export type OfficeGeocoderConfig = z.infer<typeof OfficeGeocoderConfigSchema>;
const endpoint = "https://nominatim.openstreetmap.org/search";
const countries = new Set(countryCatalog.countries);
const policy = SourceDefinitionSchema.parse({
  sourceId: "host-office-address-nominatim", name: "OpenStreetMap Nominatim address lookup", adapterId: "office-address-nominatim", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", entryUrl: endpoint,
  remoteFilters: [], endpointPolicy: { allowedHosts: ["nominatim.openstreetmap.org"], allowedPathPrefixes: ["/search"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "© OpenStreetMap contributors · Nominatim", homepageUrl: "https://www.openstreetmap.org/copyright", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 5, maxPages: 1, requestsPerMinute: 50 },
});
const scalar = z.string().trim().min(1).max(2000);
const point = z.object({
  place_rank: z.number().int(), osm_type: z.enum(["node", "way", "relation"]), osm_id: z.number().int().positive().safe(),
  lat: scalar, lon: scalar, display_name: scalar, class: z.string().max(200).optional(), category: z.string().max(200).optional(), type: z.string().max(200).optional(),
  address: z.record(z.string().max(2000)),
}).passthrough();
const payload = z.array(z.unknown()).max(5);
const lookupText = (max: number) => z.string().refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Use plain address text.").transform(value => value.trim()).pipe(z.string().min(1).max(max));
const constraintsSchema = z.object({ locality: lookupText(200).optional(), postalCode: lookupText(100).optional() }).strict();
const searchSchema = constraintsSchema.extend({ query: lookupText(2000) });
type OfficeAddressConstraints = z.infer<typeof constraintsSchema>;
const localityFields = ["city", "town", "village", "municipality"] as const;
const normalizedLocality = (value: string) => value.trim().toLowerCase();
const normalizedPostalCode = (value: string) => value.replace(/[\s-]/gu, "").toUpperCase();

/** Only provider-disclosed house/road points qualify. A country, city, postcode or road is never an office candidate. */
export function parseNominatimOfficeCandidates(value: unknown, countryCode?: string, options: OfficeAddressConstraints = {}): OfficeAddressCandidate[] {
  const parsed = payload.safeParse(value);
  if (!parsed.success) throw new ToolError("source-changed");
  const constraints = constraintsSchema.safeParse(options);
  if (!constraints.success) throw new ToolError("invalid-input");
  const candidates: OfficeAddressCandidate[] = [];
  for (const row of parsed.data) {
    const result = point.safeParse(row);
    if (!result.success) continue;
    const item = result.data, address = item.address;
    const country = address.country_code?.toUpperCase();
    const road = address.road ?? address.pedestrian ?? address.residential;
    const category = item.category ?? item.class;
    // Nominatim represents address-only OSM house points as place/house, unlike place/city.
    // They still need a door number, road and address rank; category alone is not precision.
    if (item.place_rank !== 30 || !road?.trim() || !address.house_number?.trim() || !country || !countries.has(country)
      || countryCode && country !== countryCode || ["boundary", "highway"].includes(category ?? "") || category === "place" && item.type !== "house") continue;
    // A state/county can share a city name. Only explicit provider settlement fields prove locality.
    if (constraints.data.locality && !localityFields.some(field => address[field]
      && normalizedLocality(address[field]) === normalizedLocality(constraints.data.locality!))) continue;
    // Preserve significant digits (including leading zeroes); do not infer missing postal codes.
    if (constraints.data.postalCode && (!address.postcode
      || normalizedPostalCode(address.postcode) !== normalizedPostalCode(constraints.data.postalCode))) continue;
    const number = (text: string) => /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
    const coordinates = { latitude: number(item.lat), longitude: number(item.lon), coordinateSystem: "WGS84" as const };
    const evidenceUrl = `https://www.openstreetmap.org/${item.osm_type}/${item.osm_id}`;
    const proposal = { basis: "manual-user-confirmation", countryCode: country, formattedAddress: item.display_name,
      streetAddress: `${road} ${address.house_number}`, ...(address.postcode?.trim() ? { postalCode: address.postcode } : {}),
      coordinates, evidenceUrl, coordinateMeaning: category === "building" ? "building" : "site" };
    const candidate = OfficeAddressCandidateSchema.safeParse({
      id: `osm-office-${createHash("sha256").update(JSON.stringify({ evidenceUrl, proposal })).digest("hex")}`, providerId: "nominatim",
      proposal, attribution: "© OpenStreetMap contributors · ODbL · https://www.openstreetmap.org/copyright", evidenceUrl, estimated: true, verification: "unverified",
    });
    if (candidate.success && !candidates.some(entry => entry.id === candidate.data.id)) candidates.push(candidate.data);
  }
  return candidates;
}

/** One bounded GET per explicit query, with a process-wide provider instance, 1.1 s gate and a bounded 15 min cache. */
export function createNominatimOfficeProvider(transport: SourceTransport, options: { now?: () => number } = {}): OfficeAddressProvider {
  const now = options.now ?? Date.now;
  let nextRequestAt = -Infinity, pending = false;
  const cache = new Map<string, { at: number; candidates: OfficeAddressCandidate[] }>();
  const rateLimit = (seconds = 60) => { nextRequestAt = Math.max(nextRequestAt, now() + Math.max(1.1, Math.min(31_536_000, seconds)) * 1000); };
  return Object.freeze({ providerId: "nominatim", async search(input: { query: string; location: JobLocation; locality?: string; postalCode?: string }, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const parsedInput = searchSchema.safeParse({ query: input.query,
      ...(input.locality !== undefined ? { locality: input.locality } : {}), ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
    });
    if (!parsedInput.success || input.location.kind !== "office") throw new ToolError("invalid-input");
    const { query, ...constraints } = parsedInput.data;
    const key = JSON.stringify([query, input.location.countryCode ?? null, constraints.locality ?? null, constraints.postalCode ?? null]);
    const cached = cache.get(key);
    if (cached && now() - cached.at >= 0 && now() - cached.at < 900_000) return structuredClone(cached.candidates);
    if (pending || now() < nextRequestAt) throw new ToolError("rate-limited");
    pending = true; nextRequestAt = now() + 1100;
    try {
      const url = new URL(endpoint);
      if (constraints.locality || constraints.postalCode) {
        url.searchParams.set("street", query);
        if (constraints.locality) url.searchParams.set("city", constraints.locality);
        if (constraints.postalCode) url.searchParams.set("postalcode", constraints.postalCode);
      } else url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2"); url.searchParams.set("addressdetails", "1"); url.searchParams.set("limit", "5");
      if (input.location.countryCode) url.searchParams.set("countrycodes", input.location.countryCode.toLowerCase());
      const response = await transport.request({ url: url.toString(), source: policy, context: { ...context, observedAt: new Date(now()).toISOString() }, headers: { accept: "application/json" } });
      context.throwIfCancelled();
      if (response.status === 429) {
        const retry = response.headers["retry-after"];
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - now()) / 1000 : 60;
        rateLimit(Number.isFinite(seconds) ? seconds : 60); throw new ToolError("rate-limited");
      }
      if ([401, 403].includes(response.status)) throw new ToolError("needs-auth");
      if (response.status !== 200 || response.url !== url.toString() || response.headers["content-type"] && !/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(response.headers["content-type"])) throw new ToolError("source-changed");
      if (new TextEncoder().encode(response.text).byteLength > 512 * 1024) throw new ToolError("budget-exceeded");
      let value: unknown;
      try { value = JSON.parse(response.text) as unknown; } catch { throw new ToolError("source-changed"); }
      const candidates = parseNominatimOfficeCandidates(value, input.location.countryCode, constraints);
      context.throwIfCancelled();
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: now(), candidates: structuredClone(candidates) });
      return candidates;
    } catch (error) {
      if (error instanceof SourceTransportError && error.code === "rate-limited") rateLimit(error.retryAfterSeconds);
      if (error instanceof SourceTransportError) throw new ToolError(error.code === "rate-limited" ? "rate-limited" : error.code === "timeout" ? "timeout" : error.code === "cancelled" ? "cancelled" : [401, 403].includes(error.status ?? 0) ? "needs-auth" : error.code === "response-too-large" ? "budget-exceeded" : "source-changed");
      throw error;
    } finally { pending = false; nextRequestAt = Math.max(nextRequestAt, now() + 1100); }
  } });
}

const A_ELLIPSOID = 6378245.0;
const EE_ELLIPSOID = 0.00669342162296594323;

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * (2.0 / 3.0);
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * (2.0 / 3.0);
  ret += (160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * (2.0 / 3.0);
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * (2.0 / 3.0);
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * (2.0 / 3.0);
  ret += (150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * (2.0 / 3.0);
  return ret;
}

/** Precise iterative GCJ-02 to WGS-84 coordinate transformation (sub-decimeter accuracy). */
export function gcj02ToWgs84(gcjLon: number, gcjLat: number): { longitude: number; latitude: number } {
  if (gcjLon < 72.004 || gcjLon > 137.8347 || gcjLat < 0.8293 || gcjLat > 55.8271) {
    return { longitude: gcjLon, latitude: gcjLat };
  }
  let wgsLon = gcjLon;
  let wgsLat = gcjLat;
  for (let i = 0; i < 3; i++) {
    const dLat = transformLat(wgsLon - 105.0, wgsLat - 35.0);
    const dLon = transformLon(wgsLon - 105.0, wgsLat - 35.0);
    const radLat = (wgsLat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE_ELLIPSOID * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const deltaLat = (dLat * 180.0) / (((A_ELLIPSOID * (1 - EE_ELLIPSOID)) / (magic * sqrtMagic)) * Math.PI);
    const deltaLon = (dLon * 180.0) / ((A_ELLIPSOID / sqrtMagic) * Math.cos(radLat) * Math.PI);
    wgsLat = gcjLat - deltaLat;
    wgsLon = gcjLon - deltaLon;
  }
  return {
    longitude: Number(wgsLon.toFixed(7)),
    latitude: Number(wgsLat.toFixed(7)),
  };
}

const amapPolicy = SourceDefinitionSchema.parse({
  sourceId: "host-office-address-amap", name: "AMap Web Service geocoding lookup", adapterId: "office-address-amap", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", entryUrl: "https://restapi.amap.com/v3/geocode/geo",
  remoteFilters: [], endpointPolicy: { allowedHosts: ["restapi.amap.com"], allowedPathPrefixes: ["/v3/geocode/geo"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "© 高德开放平台 · 地理编码服务", homepageUrl: "https://lbs.amap.com/", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 5, maxPages: 1, requestsPerMinute: 50 },
});

const amapGeocodeItem = z.object({
  formatted_address: z.string().trim().min(1).max(2000),
  country: z.union([z.string().max(200), z.array(z.unknown())]).optional(),
  province: z.union([z.string().max(200), z.array(z.unknown())]).optional(),
  city: z.union([z.string().max(200), z.array(z.unknown())]).optional(),
  district: z.union([z.string().max(200), z.array(z.unknown())]).optional(),
  street: z.union([z.string().max(1000), z.array(z.unknown())]).optional(),
  number: z.union([z.string().max(200), z.array(z.unknown())]).optional(),
  location: z.string().regex(/^-?\d+(?:\.\d+)?[,-]-?\d+(?:\.\d+)?$/),
  level: z.string().max(200).optional(),
}).passthrough();

const amapPayloadSchema = z.object({
  status: z.string(),
  info: z.string(),
  infocode: z.string().optional(),
  count: z.union([z.string(), z.number()]).optional(),
  geocodes: z.array(amapGeocodeItem).optional(),
}).passthrough();

const amapBuildingLevels = new Set(["门牌号", "楼宇", "商务住宅", "兴趣点", "单元号"]);

export function parseAmapOfficeCandidates(value: unknown, countryCode?: string, options: OfficeAddressConstraints = {}): OfficeAddressCandidate[] {
  const parsed = amapPayloadSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("source-changed");
  if (parsed.data.status !== "1") {
    const code = parsed.data.infocode ?? "";
    if (code === "10001" || code === "10002") throw new ToolError("needs-auth");
    if (code === "10003" || code === "10004" || code === "10044") throw new ToolError("rate-limited");
    throw new ToolError("source-changed");
  }
  const constraints = constraintsSchema.safeParse(options);
  if (!constraints.success) throw new ToolError("invalid-input");
  const candidates: OfficeAddressCandidate[] = [];
  const geocodes = parsed.data.geocodes ?? [];
  for (const item of geocodes) {
    if (!item.level || !amapBuildingLevels.has(item.level)) continue;
    const country = typeof item.country === "string" ? item.country.trim() : "";
    if (country && country !== "中国" && country !== "CN" && countryCode && countryCode !== "CN") continue;
    if (countryCode && countryCode !== "CN") continue;

    const city = typeof item.city === "string" ? item.city.trim() : "";
    const district = typeof item.district === "string" ? item.district.trim() : "";
    const province = typeof item.province === "string" ? item.province.trim() : "";

    if (constraints.data.locality) {
      const loc = constraints.data.locality.toLowerCase().trim();
      const match = (city && city.toLowerCase().includes(loc)) ||
                    (district && district.toLowerCase().includes(loc)) ||
                    (province && province.toLowerCase().includes(loc)) ||
                    item.formatted_address.toLowerCase().includes(loc);
      if (!match) continue;
    }

    const street = typeof item.street === "string" ? item.street.trim() : "";
    const num = typeof item.number === "string" ? item.number.trim() : "";
    const streetAddress = street && num ? `${street} ${num}` : street || item.formatted_address;

    const [lonStr, latStr] = item.location.split(",");
    const gcjLon = Number(lonStr);
    const gcjLat = Number(latStr);
    if (!Number.isFinite(gcjLon) || !Number.isFinite(gcjLat)) continue;

    const wgs = gcj02ToWgs84(gcjLon, gcjLat);
    const evidenceUrl = "https://lbs.amap.com/api/webservice/guide/api/georegeo";
    const coordinateMeaning = (item.level === "楼宇" || item.level === "商务住宅") ? "building" as const : "site" as const;

    const proposal = {
      basis: "manual-user-confirmation" as const,
      countryCode: "CN",
      formattedAddress: item.formatted_address,
      streetAddress,
      coordinates: { latitude: wgs.latitude, longitude: wgs.longitude, coordinateSystem: "WGS84" as const },
      evidenceUrl,
      coordinateMeaning,
    };

    const candidate = OfficeAddressCandidateSchema.safeParse({
      id: `amap-office-${createHash("sha256").update(JSON.stringify({ evidenceUrl, proposal })).digest("hex")}`,
      providerId: "amap",
      proposal,
      attribution: "© 高德开放平台 · 地理编码服务",
      evidenceUrl,
      estimated: true,
      verification: "unverified",
    });

    if (candidate.success && !candidates.some(entry => entry.id === candidate.data.id)) {
      candidates.push(candidate.data);
    }
  }
  return candidates;
}

export function resolveAmapApiKey(explicitKey?: string, dataDirectory?: string): string | undefined {
  if (explicitKey?.trim()) return explicitKey.trim();
  const envKey = process.env.AMAP_KEY?.trim() || process.env.AMAP_WEB_KEY?.trim();
  if (envKey) return envKey;
  const candidates = [
    dataDirectory ? join(dataDirectory, "amap.key") : undefined,
    join(homedir(), "Library", "Application Support", "BetterMe", "job-atlas", "amap.key"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, "utf8").trim();
        if (content && /^[A-Za-z0-9_-]{16,64}$/.test(content)) return content;
      }
    } catch { /* ignore read failure */ }
  }
  return undefined;
}

export const CITY_AREA_CODE_MAP: Record<string, string> = {
  上海: "021", 上海市: "021",
  北京: "010", 北京市: "010",
  广州: "020", 广州市: "020",
  深圳: "0755", 深圳市: "0755",
  杭州: "0571", 杭州市: "0571",
  成都: "028", 成都市: "028",
  武汉: "027", 武汉市: "027",
  南京: "025", 南京市: "025",
  苏州: "0512", 苏州市: "0512",
  西安: "029", 西安市: "029",
  重庆: "023", 重庆市: "023",
  天津: "022", 天津市: "022",
  合肥: "0551", 合肥市: "0551",
  长沙: "0731", 长沙市: "0731",
  厦门: "0592", 厦门市: "0592",
  青岛: "0532", 青岛市: "0532",
  大连: "0411", 大连市: "0411",
  宁波: "0574", 宁波市: "0574",
  无锡: "0510", 无锡市: "0510",
  郑州: "0371", 郑州市: "0371",
  东莞: "0769", 东莞市: "0769",
  佛山: "0757", 佛山市: "0757",
  珠海: "0756", 珠海市: "0756",
  济南: "0531", 济南市: "0531",
  福州: "0591", 福州市: "0591",
  沈阳: "024", 沈阳市: "024",
  哈尔滨: "0451", 哈尔滨市: "0451",
  长春: "0431", 长春市: "0431",
  昆明: "0871", 昆明市: "0871",
  贵阳: "0851", 贵阳市: "0851",
  南宁: "0771", 南宁市: "0771",
  海口: "0898", 海口市: "0898",
  兰州: "0931", 兰州市: "0931",
  银川: "0951", 银川市: "0951",
  西宁: "0971", 西宁市: "0971",
  乌鲁木齐: "0991", 乌鲁木齐市: "0991",
  呼和浩特: "0471", 呼和浩特市: "0471",
  南昌: "0791", 南昌市: "0791",
  太原: "0351", 太原市: "0351",
  石家庄: "0311", 石家庄市: "0311",
  香港: "852",
  澳门: "853",
  台北: "886",
};

export function resolveCityCode(locality?: string, query?: string): string {
  const loc = (locality ?? "").trim();
  if (loc) {
    if (CITY_AREA_CODE_MAP[loc]) return CITY_AREA_CODE_MAP[loc]!;
    for (const [k, v] of Object.entries(CITY_AREA_CODE_MAP)) {
      if (loc.includes(k) || k.includes(loc)) return v;
    }
  }
  const q = (query ?? "").trim();
  if (q) {
    for (const [k, v] of Object.entries(CITY_AREA_CODE_MAP)) {
      if (q.startsWith(k) || q.includes(k)) return v;
    }
  }
  return loc.replace(/[^A-Za-z0-9]/g, "") || "000";
}

/** Fast 32-bit FNV-1a hash function for deterministic character n-gram projection. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Normalizes address text for semantic embedding by stripping common whitespace,
 * punctuation, and standard administrative prefixes (province, city, district).
 */
export function cleanAddressText(text: string): string {
  let t = text.toLowerCase().replace(/[\s,，.。;；/\\()（）\-—_]/g, "");
  t = t.replace(/^[^\d]{2,6}(?:省|市)/, "");
  t = t.replace(/^[^\d]{2,6}(?:市|区|县)/, "");
  t = t.replace(/\s*\d+[-号]?[楼层室栋座]/g, "");
  t = t.replace(/\s*[A-Za-z0-9]+[座栋单元]/g, "");
  return t;
}

/**
 * Extracts recognizable landmark text from an address by stripping administrative prefixes
 * as well as road and door number patterns.
 */
export function extractLandmarkText(text: string): string {
  let t = cleanAddressText(text);
  t = t.replace(/[^\d\s,，]{2,15}[路街道巷弄道]\s*\d+[-至到]?\d*号?/g, "");
  return t.trim();
}

/**
 * Creates a normalized 256-dimensional semantic embedding vector using character
 * uni-gram, bi-gram, and tri-gram feature projection with L2 normalization (pure TS, zero-dependency).
 */
export function createAddressEmbedding(text: string, dim: number = 256): Float32Array {
  const clean = cleanAddressText(text);
  const vec = new Float32Array(dim);
  if (!clean) return vec;

  for (let i = 0; i < clean.length; i++) {
    vec[fnv1a(clean[i]!) % dim] += 1.0;
  }
  for (let i = 0; i < clean.length - 1; i++) {
    vec[fnv1a(clean.slice(i, i + 2)) % dim] += 1.5;
  }
  for (let i = 0; i < clean.length - 2; i++) {
    vec[fnv1a(clean.slice(i, i + 3)) % dim] += 2.0;
  }

  let sumSq = 0;
  for (let i = 0; i < dim; i++) sumSq += vec[i]! * vec[i]!;
  if (sumSq > 0) {
    const inv = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < dim; i++) vec[i]! *= inv;
  }
  return vec;
}

/**
 * Calculates the cosine similarity between two normalized vectors (dot product).
 * Returns a value in [0.0, 1.0].
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return Math.max(0, Math.min(1, dot));
}

/**
 * Normalizes an address query by extracting administrative locality and road/number key,
 * stripping secondary decorations like industrial parks, building blocks, and room numbers.
 * Example: ("上海市", "浦东新区科苑路399号张江创新园A座301室") -> "021:科苑路_399号"
 */
export function normalizeAddressKey(locality?: string, query?: string): string {
  const cityCode = resolveCityCode(locality, query);
  let text = (query ?? "").trim();
  if (!text) return `${cityCode}:`;

  // Strip brackets and parentheses: (A座), （3号楼）
  text = text.replace(/[\(（][^\)）]*[\)）]/g, " ");

  // Strip room/floor suffixes: 301室, 5层, 12楼, A座, 1号楼, etc.
  text = text.replace(/\s*\d+[-号]?[楼层室栋座]/g, " ");
  text = text.replace(/\s*[A-Za-z0-9]+[座栋单元]/g, " ");

  // Strip leading province/city/district: e.g. "上海市", "浦东新区", "北京市", "海淀区"
  text = text.replace(/^[^\d\s,，]{2,10}(?:省|市|特别行政区)/, " ").trim();
  text = text.replace(/^[^\d\s,，]{2,10}(?:区|县|旗|盟)/, " ").trim();

  // Match road and door number pattern: e.g. "科苑路399号", "东北旺西路8号", "文一西路969号"
  const roadMatch = text.match(/([^\d\s,，]{2,15}[路街道巷弄道])\s*(\d+[-至到]?\d*号?)/);
  if (roadMatch) {
    const road = roadMatch[1]!.trim();
    const num = roadMatch[2]!.trim().endsWith("号") ? roadMatch[2]!.trim() : `${roadMatch[2]!.trim()}号`;
    return `${cityCode}:${road}_${num}`;
  }

  // Fallback: strip whitespace and return clean string
  const clean = text.replace(/\s+/g, "").slice(0, 100);
  return `${cityCode}:${clean}`;
}

export interface GeoAddressCacheEntry {
  normKey: string;
  cityCode: string;
  rawQuery: string;
  candidate: OfficeAddressCandidate;
  embedding?: number[];
  landmarkEmbedding?: number[];
  cachedAt: string;
}

export function createAmapOfficeProvider(transport: SourceTransport, options: { key?: string; dataDirectory?: string; now?: () => number } = {}): OfficeAddressProvider {
  const now = options.now ?? Date.now;
  let nextRequestAt = -Infinity, pending = false;
  const cache = new Map<string, { at: number; candidates: OfficeAddressCandidate[] }>();
  const rateLimit = (seconds = 60) => { nextRequestAt = Math.max(nextRequestAt, now() + Math.max(1.1, Math.min(31_536_000, seconds)) * 1000); };

  const persistentCachePath = options.dataDirectory ? join(options.dataDirectory, "geo-address-cache.json") : undefined;
  const persistentMap = new Map<string, GeoAddressCacheEntry>();

  if (persistentCachePath && existsSync(persistentCachePath)) {
    try {
      const content = readFileSync(persistentCachePath, "utf8");
      const data = JSON.parse(content);
      if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && (v as any).candidate) {
            const entry = v as GeoAddressCacheEntry;
            if (!entry.embedding && entry.candidate?.proposal?.formattedAddress) {
              entry.embedding = Array.from(createAddressEmbedding(entry.candidate.proposal.formattedAddress));
            }
            if (!entry.landmarkEmbedding) {
              const landmark = extractLandmarkText(entry.rawQuery || entry.candidate?.proposal?.formattedAddress || "");
              if (landmark) {
                entry.landmarkEmbedding = Array.from(createAddressEmbedding(landmark));
              }
            }
            persistentMap.set(k, entry);
          }
        }
      }
    } catch { /* ignore read failure */ }
  }

  const savePersistentCache = () => {
    if (!persistentCachePath) return;
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of persistentMap.entries()) {
        obj[k] = v;
      }
      writeFileSync(persistentCachePath, JSON.stringify(obj, null, 2), "utf8");
    } catch { /* ignore write failure */ }
  };

  return Object.freeze({
    providerId: "amap",
    async search(input: { query: string; location: JobLocation; locality?: string; postalCode?: string }, context: ToolHandlerContext) {
      context.throwIfCancelled();
      const apiKey = resolveAmapApiKey(options.key, options.dataDirectory);
      if (!apiKey) throw new ToolError("needs-auth");

      const parsedInput = searchSchema.safeParse({
        query: input.query,
        ...(input.locality !== undefined ? { locality: input.locality } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
      });
      if (!parsedInput.success || input.location.kind !== "office") throw new ToolError("invalid-input");
      const { query, ...constraints } = parsedInput.data;

      // 1. Stage 1: Check normalized persistent dictionary first (0 ms, 0 API consumption, Q5 option B)
      const normKey = normalizeAddressKey(constraints.locality, query);
      const persistentHit = persistentMap.get(normKey);
      if (persistentHit) {
        return [structuredClone(persistentHit.candidate)];
      }

      // 2. Stage 2: Semantic vector embedding similarity search (Q5 option C)
      const cityCode = resolveCityCode(constraints.locality, query);
      const queryVec = createAddressEmbedding(query);
      const landmark = extractLandmarkText(query);
      const landmarkVec = landmark ? createAddressEmbedding(landmark) : undefined;
      let bestEntry: GeoAddressCacheEntry | undefined;
      let bestScore = -1;

      for (const entry of persistentMap.values()) {
        if (entry.cityCode && entry.cityCode !== cityCode && !entry.normKey.startsWith(`${cityCode}:`)) {
          continue;
        }
        let score = 0;
        if (entry.embedding && entry.embedding.length > 0) {
          score = Math.max(score, cosineSimilarity(queryVec, entry.embedding));
        }
        if (entry.landmarkEmbedding && entry.landmarkEmbedding.length > 0) {
          score = Math.max(score, cosineSimilarity(queryVec, entry.landmarkEmbedding));
          if (landmarkVec) {
            score = Math.max(score, cosineSimilarity(landmarkVec, entry.landmarkEmbedding));
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestEntry = entry;
        }
      }

      if (bestEntry && bestScore >= 0.85) {
        persistentMap.set(normKey, {
          normKey,
          cityCode,
          rawQuery: query,
          candidate: structuredClone(bestEntry.candidate),
          embedding: Array.from(queryVec),
          ...(landmarkVec ? { landmarkEmbedding: Array.from(landmarkVec) } : {}),
          cachedAt: new Date(now()).toISOString(),
        });
        savePersistentCache();
        return [structuredClone(bestEntry.candidate)];
      }

      const key = JSON.stringify([query, input.location.countryCode ?? null, constraints.locality ?? null, constraints.postalCode ?? null]);
      const cached = cache.get(key);
      if (cached && now() - cached.at >= 0 && now() - cached.at < 900_000) return structuredClone(cached.candidates);
      if (pending || now() < nextRequestAt) throw new ToolError("rate-limited");
      pending = true; nextRequestAt = now() + 1100;

      try {
        const url = new URL("https://restapi.amap.com/v3/geocode/geo");
        url.searchParams.set("key", apiKey);
        url.searchParams.set("address", query);
        if (constraints.locality) url.searchParams.set("city", constraints.locality);
        url.searchParams.set("output", "JSON");

        const response = await transport.request({
          url: url.toString(),
          source: amapPolicy,
          context: { ...context, observedAt: new Date(now()).toISOString() },
          headers: { accept: "application/json" },
        });
        context.throwIfCancelled();

        if (response.status === 429) {
          const retry = response.headers["retry-after"];
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
          rateLimit(seconds);
          throw new ToolError("rate-limited");
        }
        if ([401, 403].includes(response.status)) throw new ToolError("needs-auth");
        if (response.status !== 200) throw new ToolError("source-changed");
        if (new TextEncoder().encode(response.text).byteLength > 512 * 1024) throw new ToolError("budget-exceeded");

        let value: unknown;
        try { value = JSON.parse(response.text) as unknown; } catch { throw new ToolError("source-changed"); }
        const candidates = parseAmapOfficeCandidates(value, input.location.countryCode, constraints);
        context.throwIfCancelled();

        if (candidates.length > 0) {
          const best = candidates[0]!;
          const embeddingVec = createAddressEmbedding(best.proposal.formattedAddress || query);
          const lmark = extractLandmarkText(query || best.proposal.formattedAddress);
          const lmarkVec = lmark ? createAddressEmbedding(lmark) : undefined;
          persistentMap.set(normKey, {
            normKey,
            cityCode,
            rawQuery: query,
            candidate: structuredClone(best),
            embedding: Array.from(embeddingVec),
            ...(lmarkVec ? { landmarkEmbedding: Array.from(lmarkVec) } : {}),
            cachedAt: new Date(now()).toISOString(),
          });
          savePersistentCache();
        }

        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: now(), candidates: structuredClone(candidates) });
        return candidates;
      } catch (error) {
        if (error instanceof SourceTransportError && error.code === "rate-limited") rateLimit(error.retryAfterSeconds);
        if (error instanceof SourceTransportError) {
          throw new ToolError(
            error.code === "rate-limited" ? "rate-limited" :
            error.code === "timeout" ? "timeout" :
            error.code === "cancelled" ? "cancelled" :
            [401, 403].includes(error.status ?? 0) ? "needs-auth" :
            error.code === "response-too-large" ? "budget-exceeded" : "source-changed"
          );
        }
        throw error;
      } finally {
        pending = false;
        nextRequestAt = Math.max(nextRequestAt, now() + 1100);
      }
    },
  });
}

