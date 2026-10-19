import { createHash } from "node:crypto";
import { z } from "zod";
import { OfficeAddressCandidateSchema, SourceDefinitionSchema, ToolError, type JobLocation, type OfficeAddressCandidate, type ToolHandlerContext } from "@better-me/opportunities";
import { SourceTransportError, type SourceTransport } from "@better-me/source-adapters";
import type { OfficeAddressProvider } from "./office-address.js";
import countryCatalog from "../../../config/geography/countries.json" with { type: "json" };

/** Host opt-in only. Never autocomplete or bulk-geocode the job index against this public service. */
export const OfficeGeocoderConfigSchema = z.object({ provider: z.literal("nominatim") }).strict();
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

/** Only provider-disclosed house/road points qualify. A country, city, postcode or road is never an office candidate. */
export function parseNominatimOfficeCandidates(value: unknown, countryCode?: string): OfficeAddressCandidate[] {
  const parsed = payload.safeParse(value);
  if (!parsed.success) throw new ToolError("source-changed");
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
  return Object.freeze({ providerId: "nominatim", async search(input: { query: string; location: JobLocation }, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const query = input.query.trim();
    if (!query || query.length > 2000 || /[\p{Cc}\p{Cs}]/u.test(query) || input.location.kind !== "office") throw new ToolError("invalid-input");
    const key = JSON.stringify([query, input.location.countryCode ?? null]);
    const cached = cache.get(key);
    if (cached && now() - cached.at >= 0 && now() - cached.at < 900_000) return structuredClone(cached.candidates);
    if (pending || now() < nextRequestAt) throw new ToolError("rate-limited");
    pending = true; nextRequestAt = now() + 1100;
    try {
      const url = new URL(endpoint);
      url.searchParams.set("q", query); url.searchParams.set("format", "jsonv2"); url.searchParams.set("addressdetails", "1"); url.searchParams.set("limit", "5");
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
      const candidates = parseNominatimOfficeCandidates(value, input.location.countryCode);
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
