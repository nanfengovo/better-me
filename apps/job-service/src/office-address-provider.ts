import { createHash } from "node:crypto";
import { z } from "zod";
import { OfficeAddressCandidateSchema, SourceDefinitionSchema, ToolError, type JobLocation, type OfficeAddressCandidate, type ToolHandlerContext } from "@better-me/opportunities";
import { SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import type { OfficeAddressProvider } from "./office-address.js";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };

/** Host opt-in only. Never autocomplete or bulk-geocode the job index against a public service. */
export const OfficeGeocoderConfigSchema = z.object({ provider: z.enum(["nominatim", "photon"]) }).strict();
export type OfficeGeocoderConfig = z.infer<typeof OfficeGeocoderConfigSchema>;
const endpoint = "https://nominatim.openstreetmap.org/search";
const photonEndpoint = "https://photon.komoot.io/api/";
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
