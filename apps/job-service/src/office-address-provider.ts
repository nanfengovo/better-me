import { createHash } from "node:crypto";
import { z } from "zod";
import { OfficeAddressCandidateSchema, SourceDefinitionSchema, ToolError, type JobLocation, type OfficeAddressCandidate, type ToolHandlerContext } from "@better-me/opportunities";
import { SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import type { OfficeAddressProvider } from "./office-address.js";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };

/** Host opt-in only. Never autocomplete or bulk-geocode the job index against a public service. */
export const OfficeGeocoderConfigSchema = z.object({ provider: z.enum(["nominatim", "photon", "amap"]) }).strict();
export type OfficeGeocoderConfig = z.infer<typeof OfficeGeocoderConfigSchema>;
const endpoint = "https://nominatim.openstreetmap.org/search";
const photonEndpoint = "https://photon.komoot.io/api/";
const amapEndpoint = "https://restapi.amap.com/v3/geocode/geo";
const countries = new Set(countryCatalog.countries);
const policy = SourceDefinitionSchema.parse({
  sourceId: "host-office-address-nominatim", name: "OpenStreetMap Nominatim address lookup", adapterId: "office-address-nominatim", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", entryUrl: endpoint,
  remoteFilters: [], endpointPolicy: { allowedHosts: ["nominatim.openstreetmap.org"], allowedPathPrefixes: ["/search"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "© OpenStreetMap contributors · Nominatim", homepageUrl: "https://www.openstreetmap.org/copyright", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 5, maxPages: 1, requestsPerMinute: 50 },
});
const photonPolicy = SourceDefinitionSchema.parse({
  sourceId: "host-office-address-photon", name: "Photon address lookup", adapterId: "office-address-photon", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", entryUrl: photonEndpoint,
  remoteFilters: [], endpointPolicy: { allowedHosts: ["photon.komoot.io"], allowedPathPrefixes: ["/api/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "© OpenStreetMap contributors · Photon by Komoot", homepageUrl: "https://photon.komoot.io/", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 5, maxPages: 1, requestsPerMinute: 30 },
});
const amapPolicy = SourceDefinitionSchema.parse({
  sourceId: "host-office-address-amap", name: "Amap Web service geocoding", adapterId: "office-address-amap", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", entryUrl: amapEndpoint,
  remoteFilters: [], endpointPolicy: { allowedHosts: ["restapi.amap.com"], allowedPathPrefixes: ["/v3/geocode/geo"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "高德地图开放平台地理编码", homepageUrl: "https://lbs.amap.com/", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 5, maxPages: 1, requestsPerMinute: 30 },
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

const photonFeature = z.object({ type: z.literal("Feature"), geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }).strict(), properties: z.record(z.unknown()) }).passthrough();
const photonPayload = z.object({ type: z.literal("FeatureCollection"), features: z.array(z.unknown()).max(5) }).passthrough();
function photonText(properties: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof properties[key] === "string" && properties[key].trim()) return properties[key].trim();
  return undefined;
}
function photonOsmType(value: unknown): "node" | "way" | "relation" | undefined {
  if (value === "N" || value === "node") return "node";
  if (value === "W" || value === "way") return "way";
  if (value === "R" || value === "relation") return "relation";
  return undefined;
}

const amapGeocode = z.object({
  formatted_address: scalar.optional(), country: scalar.optional(), province: scalar.optional(), city: z.union([scalar, z.array(scalar).max(3)]).optional(),
  district: scalar.optional(), township: scalar.optional(), street: z.union([scalar, z.object({ name: scalar.optional(), number: scalar.optional() }).passthrough()]).optional(),
  number: scalar.optional(), building: z.union([scalar, z.object({ name: scalar.optional() }).passthrough()]).optional(), location: scalar,
  level: scalar,
}).passthrough();
const amapPayload = z.object({ status: z.enum(["0", "1"]), info: scalar.optional(), infocode: scalar.optional(), geocodes: z.array(z.unknown()).max(5).optional() }).passthrough();
const amapKeySchema = z.string().trim().min(1).max(256).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Invalid Amap key.");
const amapText = (value: unknown, key?: "name" | "number"): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (key && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
};
const amapCity = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value.find(Boolean)?.trim() : value?.trim() || undefined;
const normalizedChinaLocality = (value: string) => normalizedLocality(value).replace(/[市区县]$/u, "");
function amapCountryCode(value: string | undefined): "CN" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "cn" || normalized.includes("中国") || normalized.includes("china") ? "CN" : undefined;
}

/** Amap returns GCJ-02. Convert only the candidate coordinates; preserve the raw pair for audit. */
function gcj02ToWgs84(longitude: number, latitude: number): { longitude: number; latitude: number } {
  const a = 6378245.0, ee = 0.006693421622965943;
  const outOfChina = longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
  if (outOfChina) return { longitude, latitude };
  const transformLat = (x: number, y: number) => {
    let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return ret;
  };
  const transformLon = (x: number, y: number) => {
    let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return ret;
  };
  const radLat = latitude / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = transformLat(longitude - 105, latitude - 35) * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  const dLon = transformLon(longitude - 105, latitude - 35) * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  const mgLat = latitude + dLat, mgLon = longitude + dLon;
  return { longitude: longitude * 2 - mgLon, latitude: latitude * 2 - mgLat };
}

/** Only Amap door/building-level results qualify; city/road/POI results remain no-match. */
export function parseAmapOfficeCandidates(value: unknown, countryCode?: string, options: OfficeAddressConstraints = {}): OfficeAddressCandidate[] {
  const parsed = amapPayload.safeParse(value);
  if (!parsed.success) throw new ToolError("source-changed");
  const constraints = constraintsSchema.safeParse(options);
  if (!constraints.success) throw new ToolError("invalid-input");
  if (parsed.data.status !== "1") {
    if (/key|user|auth|permission/i.test(parsed.data.info ?? "") || ["10001", "10002", "10003"].includes(parsed.data.infocode ?? "")) throw new ToolError("needs-auth");
    return [];
  }
  const candidates: OfficeAddressCandidate[] = [];
  for (const raw of parsed.data.geocodes ?? []) {
    const result = amapGeocode.safeParse(raw);
    if (!result.success) continue;
    const item = result.data, country = amapCountryCode(item.country), city = amapCity(item.city);
    const street = amapText(item.street, "name"), number = amapText(item.street, "number") ?? amapText(item.number);
    const building = amapText(item.building, "name");
    if (country !== "CN" || countryCode && country !== countryCode || !["门牌号", "楼栋"].includes(item.level)
      || !street || !number && !building) continue;
    if (constraints.data.locality && (!city || normalizedChinaLocality(city) !== normalizedChinaLocality(constraints.data.locality))) continue;
    const rawLocation = item.location.split(",").map(value => Number(value.trim()));
    if (rawLocation.length !== 2 || !rawLocation.every(Number.isFinite)) continue;
    const longitude = rawLocation[0]!, latitude = rawLocation[1]!;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const converted = gcj02ToWgs84(longitude, latitude);
    const postalCode = undefined;
    if (constraints.data.postalCode && !postalCode) continue;
    const streetAddress = [street, number ?? building].filter(Boolean).join(" ");
    const formattedAddress = item.formatted_address ?? [item.province, city, item.district, streetAddress].filter(Boolean).join("");
    const evidenceUrl = amapEndpoint;
    const proposal = { basis: "manual-user-confirmation" as const, countryCode: "CN" as const, formattedAddress,
      streetAddress, coordinates: { ...converted, coordinateSystem: "WGS84" as const },
      originalCoordinates: { latitude, longitude, coordinateSystem: "GCJ02" as const }, evidenceUrl,
      coordinateMeaning: item.level === "楼栋" ? "building" as const : "entrance" as const };
    const candidate = OfficeAddressCandidateSchema.safeParse({
      id: `amap-office-${createHash("sha256").update(JSON.stringify({ evidenceUrl, proposal })).digest("hex")}`, providerId: "amap", proposal,
      attribution: "高德地图开放平台地理编码；原始坐标 GCJ-02，已转换为 WGS84；候选需人工核对 · https://lbs.amap.com/", evidenceUrl, estimated: true, verification: "unverified",
    });
    if (candidate.success && !candidates.some(entry => entry.id === candidate.data.id)) candidates.push(candidate.data);
  }
  return candidates;
}

/** Photon is a second explicit lookup option. It is still a provider candidate, never office verification. */
export function parsePhotonOfficeCandidates(value: unknown, countryCode?: string, options: OfficeAddressConstraints = {}): OfficeAddressCandidate[] {
  const parsed = photonPayload.safeParse(value);
  if (!parsed.success) throw new ToolError("source-changed");
  const constraints = constraintsSchema.safeParse(options);
  if (!constraints.success) throw new ToolError("invalid-input");
  const candidates: OfficeAddressCandidate[] = [];
  for (const feature of parsed.data.features) {
    const result = photonFeature.safeParse(feature);
    if (!result.success) continue;
    const properties = result.data.properties;
    const country = photonText(properties, "countrycode")?.toUpperCase();
    const street = photonText(properties, "street", "road");
    const houseNumber = photonText(properties, "housenumber", "house_number");
    const osmType = photonOsmType(properties.osm_type);
    const osmId = typeof properties.osm_id === "number" && Number.isSafeInteger(properties.osm_id) && properties.osm_id > 0 ? properties.osm_id : undefined;
    const locality = photonText(properties, "city", "town", "village", "municipality");
    const postalCode = photonText(properties, "postcode", "postalcode");
    const featureType = photonText(properties, "type", "osm_value")?.toLowerCase();
    // Photon can return city, street and postcode features. Only a provider-disclosed
    // house/building feature with a street plus house number and OSM identity qualifies.
    if (!country || !countries.has(country) || countryCode && country !== countryCode || !street || !houseNumber || !osmType || osmId === undefined
      || !featureType || !["house", "building", "residential"].includes(featureType)) continue;
    if (constraints.data.locality && (!locality || normalizedLocality(locality) !== normalizedLocality(constraints.data.locality))) continue;
    if (constraints.data.postalCode && (!postalCode || normalizedPostalCode(postalCode) !== normalizedPostalCode(constraints.data.postalCode))) continue;
    const [longitude, latitude] = result.data.geometry.coordinates;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const evidenceUrl = `https://www.openstreetmap.org/${osmType}/${osmId}`;
    const formattedAddress = [houseNumber, street, locality, postalCode, photonText(properties, "country")].filter(Boolean).join(", ");
    const proposal = { basis: "manual-user-confirmation" as const, countryCode: country, formattedAddress: formattedAddress || `${street} ${houseNumber}`,
      streetAddress: `${street} ${houseNumber}`, ...(postalCode ? { postalCode } : {}), coordinates: { latitude, longitude, coordinateSystem: "WGS84" as const }, evidenceUrl,
      coordinateMeaning: properties.type === "house" || properties.osm_value === "building" ? "building" as const : "site" as const };
    const candidate = OfficeAddressCandidateSchema.safeParse({
      id: `photon-office-${createHash("sha256").update(JSON.stringify({ evidenceUrl, proposal })).digest("hex")}`, providerId: "photon", proposal,
      attribution: "© OpenStreetMap contributors · Photon by Komoot · https://photon.komoot.io/", evidenceUrl, estimated: true, verification: "unverified",
    });
    if (candidate.success && !candidates.some(entry => entry.id === candidate.data.id)) candidates.push(candidate.data);
  }
  return candidates;
}

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

/** One bounded GET per explicit query, with a 2 s gate matching Photon policy and bounded cache/cancellation. */
export function createPhotonOfficeProvider(transport: SourceTransport, options: { now?: () => number } = {}): OfficeAddressProvider {
  const now = options.now ?? Date.now;
  let nextRequestAt = -Infinity, pending = false;
  const cache = new Map<string, { at: number; candidates: OfficeAddressCandidate[] }>();
  const minIntervalMs = 2_000; // Matches the registered Photon ceiling of 30 requests per minute.
  const rateLimit = (seconds = 60) => { nextRequestAt = Math.max(nextRequestAt, now() + Math.max(minIntervalMs / 1000, Math.min(31_536_000, seconds)) * 1000); };
  return Object.freeze({ providerId: "photon", async search(input: { query: string; location: JobLocation; locality?: string; postalCode?: string }, context: ToolHandlerContext) {
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
    pending = true; nextRequestAt = now() + minIntervalMs;
    try {
      const url = new URL(photonEndpoint);
      url.searchParams.set("q", [query, constraints.locality, constraints.postalCode].filter(Boolean).join(", "));
      url.searchParams.set("limit", "5");
      const response = await transport.request({ url: url.toString(), source: photonPolicy, context: { ...context, observedAt: new Date(now()).toISOString() }, headers: { accept: "application/geo+json, application/json" } });
      context.throwIfCancelled();
      if (response.status === 429) {
        const retry = response.headers["retry-after"];
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - now()) / 1000 : 60;
        rateLimit(Number.isFinite(seconds) ? seconds : 60); throw new ToolError("rate-limited");
      }
      if ([401, 403].includes(response.status)) throw new ToolError("needs-auth");
      if (response.status !== 200 || response.url !== url.toString() || response.headers["content-type"] && !/^application\/(?:geo\+json|json|[^;]+\+json)(?:;|$)/i.test(response.headers["content-type"])) throw new ToolError("source-changed");
      if (new TextEncoder().encode(response.text).byteLength > 512 * 1024) throw new ToolError("budget-exceeded");
      let value: unknown;
      try { value = JSON.parse(response.text) as unknown; } catch { throw new ToolError("source-changed"); }
      const candidates = parsePhotonOfficeCandidates(value, input.location.countryCode, constraints);
      context.throwIfCancelled();
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: now(), candidates: structuredClone(candidates) });
      return candidates;
    } catch (error) {
      if (error instanceof SourceTransportError && error.code === "rate-limited") rateLimit(error.retryAfterSeconds);
      if (error instanceof SourceTransportError) throw new ToolError(error.code === "rate-limited" ? "rate-limited" : error.code === "timeout" ? "timeout" : error.code === "cancelled" ? "cancelled" : [401, 403].includes(error.status ?? 0) ? "needs-auth" : error.code === "response-too-large" ? "budget-exceeded" : "source-changed");
      throw error;
    } finally { pending = false; nextRequestAt = Math.max(nextRequestAt, now() + minIntervalMs); }
  } });
}

/** One bounded Amap lookup per explicit query. The key is host-only configuration and never enters a candidate or log. */
export function createAmapOfficeProvider(transport: SourceTransport, options: { key?: string; now?: () => number } = {}): OfficeAddressProvider {
  const now = options.now ?? Date.now;
  const key = options.key ? amapKeySchema.safeParse(options.key.trim()) : undefined;
  let nextRequestAt = -Infinity, pending = false;
  const cache = new Map<string, { at: number; candidates: OfficeAddressCandidate[] }>();
  const minIntervalMs = 2_000;
  const rateLimit = (seconds = 60) => { nextRequestAt = Math.max(nextRequestAt, now() + Math.max(minIntervalMs / 1000, Math.min(31_536_000, seconds)) * 1000); };
  return Object.freeze({ providerId: "amap", async search(input: { query: string; location: JobLocation; locality?: string; postalCode?: string }, context: ToolHandlerContext) {
    context.throwIfCancelled();
    if (!key?.success) throw new ToolError("needs-auth");
    if (input.location.kind !== "office" || input.location.countryCode && input.location.countryCode !== "CN") throw new ToolError("invalid-input");
    const parsedInput = searchSchema.safeParse({ query: input.query,
      ...(input.locality !== undefined ? { locality: input.locality } : {}), ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
    });
    if (!parsedInput.success) throw new ToolError("invalid-input");
    const { query, ...constraints } = parsedInput.data;
    const cacheKey = JSON.stringify([query, input.location.countryCode ?? "CN", constraints.locality ?? null, constraints.postalCode ?? null]);
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at >= 0 && now() - cached.at < 900_000) return structuredClone(cached.candidates);
    if (pending || now() < nextRequestAt) throw new ToolError("rate-limited");
    pending = true; nextRequestAt = now() + minIntervalMs;
    try {
      const url = new URL(amapEndpoint);
      url.searchParams.set("key", key.data); url.searchParams.set("address", query); url.searchParams.set("output", "JSON"); url.searchParams.set("batch", "false");
      if (constraints.locality) url.searchParams.set("city", constraints.locality);
      const response = await transport.request({ url: url.toString(), source: amapPolicy, context: { ...context, observedAt: new Date(now()).toISOString() }, headers: { accept: "application/json" } });
      context.throwIfCancelled();
      if (response.status === 429) {
        const retry = response.headers["retry-after"];
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - now()) / 1000 : 60;
        rateLimit(Number.isFinite(seconds) ? seconds : 60); throw new ToolError("rate-limited");
      }
      if ([401, 403].includes(response.status)) throw new ToolError("needs-auth");
      // Never compare or expose the key-bearing URL in a user-facing error; the controlled transport
      // still validates the fixed host/path and response URL before this provider sees it.
      let responseUrl: URL;
      try { responseUrl = new URL(response.url); } catch { throw new ToolError("source-changed"); }
      if (response.status !== 200 || responseUrl.origin !== "https://restapi.amap.com" || responseUrl.pathname !== "/v3/geocode/geo"
        || response.headers["content-type"] && !/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(response.headers["content-type"])) throw new ToolError("source-changed");
      if (new TextEncoder().encode(response.text).byteLength > 512 * 1024) throw new ToolError("budget-exceeded");
      let value: unknown;
      try { value = JSON.parse(response.text) as unknown; } catch { throw new ToolError("source-changed"); }
      const candidates = parseAmapOfficeCandidates(value, input.location.countryCode ?? "CN", constraints);
      context.throwIfCancelled();
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { at: now(), candidates: structuredClone(candidates) });
      return candidates;
    } catch (error) {
      if (error instanceof SourceTransportError && error.code === "rate-limited") rateLimit(error.retryAfterSeconds);
      if (error instanceof SourceTransportError) throw new ToolError(error.code === "rate-limited" ? "rate-limited" : error.code === "timeout" ? "timeout" : error.code === "cancelled" ? "cancelled" : [401, 403].includes(error.status ?? 0) ? "needs-auth" : error.code === "response-too-large" ? "budget-exceeded" : "source-changed");
      throw error;
    } finally { pending = false; nextRequestAt = Math.max(nextRequestAt, now() + minIntervalMs); }
  } });
}
