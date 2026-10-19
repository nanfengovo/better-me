import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  GazetteerManifestSchema, GazetteerShardSchema, GeocodingRequestSchema, GeocodingResultSchema,
  MapReferenceProjectionSchema, fingerprintMapReferenceLocation,
  normalizeGeographicName, defineTool, ToolError,
  EntityIdSchema,
  type GazetteerManifest, type GazetteerPlace, type GazetteerShardDescriptor, type GeocodingCandidate,
  type GeocodingInput, type GeocodingResult, type ToolHandlerContext,
  type GeocodingRequest, type JobLocation, type MapReferenceProjection, type MapReferencePlace,
} from "@better-me/opportunities";

export type GeocodingContext = Pick<ToolHandlerContext, "signal" | "throwIfCancelled">;
export interface GeocodingProvider {
  readonly providerId: string;
  readonly offline: boolean;
  search(input: GeocodingInput, context: GeocodingContext): Promise<GeocodingResult>;
}
/** Independent read-only city distribution; it neither selects office candidates nor writes locations. */
export interface MapReferenceProvider {
  readonly providerId: string;
  readonly offline: true;
  resolveMapReferences(locations: readonly JobLocation[], context: GeocodingContext): Promise<MapReferenceProjection>;
}
export class GeocodingProviderError extends Error {
  constructor(readonly code: "invalid-request" | "invalid-data" | "dataset-unavailable" | "cancelled") {
    super({ "invalid-request": "The public place query is invalid.", "invalid-data": "The configured place dataset failed validation.", "dataset-unavailable": "The configured local place dataset is unavailable.", "cancelled": "The place query was cancelled." }[code]);
    this.name = "GeocodingProviderError";
  }
}
export type GazetteerLoader = {
  /** Trusted host supplies these functions. Model-controlled arguments never select a path or URL. */
  loadManifest: () => Promise<unknown>;
  loadShard: (descriptor: GazetteerShardDescriptor) => Promise<Uint8Array>;
};
type Match = { place: GazetteerPlace; matchedName: string; match: GeocodingCandidate["match"]; shard: GazetteerShardDescriptor };
type LoadedShard = { places: GazetteerPlace[]; names: Map<string, Array<{ index: number; matchedName: string; match: "exact-name" | "exact-alias" }>> };
function check(context: GeocodingContext) {
  context.throwIfCancelled();
  if (context.signal.aborted) throw new GeocodingProviderError("cancelled");
}
function inBounds(place: GazetteerPlace, bounds: [number, number, number, number] | undefined) {
  if (!bounds) return true;
  const [west, south, east, north] = bounds;
  const { latitude, longitude } = place.coordinates;
  return latitude >= south && latitude <= north && (west <= east ? longitude >= west && longitude <= east : longitude >= west || longitude <= east);
}

/** Offline city lookup. Every result is a candidate, including a single exact name. */
export function createGazetteerProvider(options: GazetteerLoader & { providerId?: string }) {
  const providerId = EntityIdSchema.parse(options.providerId ?? "local-gazetteer");
  let manifestTask: Promise<GazetteerManifest> | undefined;
  const cache = new Map<string, Promise<LoadedShard>>();
  async function manifest() {
    manifestTask ??= Promise.resolve().then(() => options.loadManifest()).then((data) => GazetteerManifestSchema.parse(data))
      .catch((error: unknown) => { manifestTask = undefined; throw error instanceof GeocodingProviderError ? error : new GeocodingProviderError("invalid-data"); });
    return manifestTask;
  }
  function loadShard(descriptor: GazetteerShardDescriptor, data: GazetteerManifest): Promise<LoadedShard> {
    let task = cache.get(descriptor.sha256);
    if (!task) {
      task = (async () => {
        try {
          const bytes = await options.loadShard(descriptor);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== descriptor.bytes || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw new GeocodingProviderError("invalid-data");
          const decoded = descriptor.encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: descriptor.decodedBytes }) : bytes;
          if (decoded.byteLength !== descriptor.decodedBytes) throw new GeocodingProviderError("invalid-data");
          const shard = GazetteerShardSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)));
          if (shard.countryCode !== descriptor.countryCode || shard.datasetVersion !== data.provenance.version || shard.places.length !== descriptor.count) throw new GeocodingProviderError("invalid-data");
          const alternates = [...new Set(shard.places.flatMap((place) => place.alternateCountryCodes))].sort();
          if (JSON.stringify(alternates) !== JSON.stringify([...descriptor.alternateCountryCodes].sort())) throw new GeocodingProviderError("invalid-data");
          const names: LoadedShard["names"] = new Map();
          for (const [index, place] of shard.places.entries()) {
            const seen = new Set<string>();
            for (const [position, matchedName] of [place.name, ...(place.asciiName ? [place.asciiName] : []), ...place.aliases].entries()) {
              const normalized = normalizeGeographicName(matchedName);
              if (!normalized || seen.has(normalized)) continue;
              seen.add(normalized);
              const entries = names.get(normalized) ?? [];
              entries.push({ index, matchedName, match: position === 0 ? "exact-name" : "exact-alias" });
              names.set(normalized, entries);
            }
          }
          return { places: shard.places, names };
        } catch (error) {
          cache.delete(descriptor.sha256);
          throw error instanceof GeocodingProviderError ? error : new GeocodingProviderError("invalid-data");
        }
      })();
      cache.set(descriptor.sha256, task);
    }
    return task;
  }
  async function exactMatches(request: Pick<GeocodingRequest, "raw" | "countryCodes" | "bounds" | "administrativeCodes">, context: GeocodingContext) {
    const data = await manifest(); check(context);
    const normalized = normalizeGeographicName(request.raw);
    const countryScope = new Set(request.countryCodes);
    const descriptors = data.shards.filter(shard => !countryScope.size || [shard.countryCode, ...shard.alternateCountryCodes].some(country => countryScope.has(country)));
    const matches = new Map<string, Match>();
    const add = (place: GazetteerPlace, matchedName: string, match: Match["match"], shard: GazetteerShardDescriptor) => {
      if (countryScope.size && ![place.countryCode, ...place.alternateCountryCodes].some(country => countryScope.has(country))) return;
      if (!inBounds(place, request.bounds)) return;
      for (const [level, value] of Object.entries(request.administrativeCodes ?? {})) if (place.administrativeCodes[level as keyof typeof place.administrativeCodes] !== value) return;
      const old = matches.get(place.id);
      if (old && old.shard.countryCode !== shard.countryCode) throw new GeocodingProviderError("invalid-data");
      if (!old) matches.set(place.id, { place, matchedName, match, shard });
    };
    for (const descriptor of descriptors) {
      check(context);
      const loaded = await loadShard(descriptor, data); check(context);
      for (const entry of loaded.names.get(normalized) ?? []) add(loaded.places[entry.index]!, entry.matchedName, entry.match, descriptor);
    }
    return { data, descriptors, matches, add, normalized };
  }
  return {
    providerId, offline: true as const,
    clearCache() { manifestTask = undefined; cache.clear(); },
    async resolveMapReferences(locations: readonly JobLocation[], context: GeocodingContext): Promise<MapReferenceProjection> {
      check(context);
      if (locations.length > 1000 || new Set(locations.map(location => location.id)).size !== locations.length) throw new GeocodingProviderError("invalid-request");
      const result: MapReferenceProjection = { providerId, places: [], references: [], unresolved: [], warnings: [] };
      const places = new Map<string, MapReferencePlace>();
      // Repeated locations in the same city share one finite lookup and one source evidence record.
      const lookups = new Map<string, Awaited<ReturnType<typeof exactMatches>>>();
      for (const location of locations) {
        check(context);
        const reason = location.kind === "remote-region" ? "remote-region" : location.coordinates ? "existing-coordinate"
          : location.verification === "conflicting" ? "conflicting-location" : !location.countryCode ? "missing-country"
            : !location.city || !normalizeGeographicName(location.city) ? "missing-city" : undefined;
        if (reason) { result.unresolved.push({ locationId: location.id, reason }); continue; }
        const city = location.city!, countryCode = location.countryCode!;
        const key = JSON.stringify([countryCode, normalizeGeographicName(city)]);
        let lookup = lookups.get(key);
        if (!lookup) {
          lookup = await exactMatches({ raw: city, countryCodes: [countryCode] }, context);
          lookups.set(key, lookup);
        }
        result.provenance = lookup.data.provenance;
        if (lookup.matches.size !== 1) {
          result.unresolved.push({ locationId: location.id, reason: lookup.matches.size ? "ambiguous-city" : "no-exact-match" });
          continue;
        }
        const match = lookup.matches.values().next().value!;
        if (match.match === "prefix") throw new GeocodingProviderError("invalid-data");
        places.set(match.place.id, { place: match.place, shardSha256: match.shard.sha256, precision: "city", estimated: true,
          coordinateMeaning: "populated-place-reference-point", verification: "unverified" });
        const locationFingerprint = await fingerprintMapReferenceLocation(location); check(context);
        result.references.push({ locationId: location.id, locationFingerprint, countryCode, city, placeId: match.place.id, matchedName: match.matchedName, match: match.match });
      }
      result.places = [...places.values()];
      if (result.provenance) result.warnings = [result.provenance.coverage, "City distribution references are estimated populated-place points, not employer office addresses; they do not provide distance evidence."];
      check(context);
      return MapReferenceProjectionSchema.parse(result);
    },
    async search(input: GeocodingInput, context: GeocodingContext): Promise<GeocodingResult> {
      check(context);
      const parsed = GeocodingRequestSchema.safeParse(input);
      if (!parsed.success) throw new GeocodingProviderError("invalid-request");
      const request = parsed.data;
      const base = { schemaVersion: 1 as const, providerId, request, requiresConfirmation: true as const };
      if (request.kind !== "office") return GeocodingResultSchema.parse({ ...base, status: "not-applicable", reason: "not-an-office", candidates: [], totalCandidates: 0, truncated: false, searchedCountryCodes: [], warnings: ["Remote eligibility and unknown locations are not office addresses."] });
      const { data, descriptors, matches, add, normalized } = await exactMatches(request, context);
      if (!matches.size && request.allowPrefix) {
        for (const descriptor of descriptors) {
          check(context);
          const loaded = await loadShard(descriptor, data);
          for (const [key, entries] of loaded.names) if (key.startsWith(normalized)) for (const entry of entries) add(loaded.places[entry.index]!, entry.matchedName, "prefix", descriptor);
        }
      }
      check(context);
      const bias = (place: GazetteerPlace) => { const index = request.countryBias.findIndex((country) => country === place.countryCode || place.alternateCountryCodes.includes(country)); return index < 0 ? request.countryBias.length : index; };
      const ordered = [...matches.values()].sort((a, b) => bias(a.place) - bias(b.place) || Number(a.match !== "exact-name") - Number(b.match !== "exact-name") || b.place.population - a.place.population || (a.place.id < b.place.id ? -1 : a.place.id > b.place.id ? 1 : 0));
      const candidates: GeocodingCandidate[] = ordered.slice(0, request.limit).map((match) => ({
        id: `geocode:${createHash("sha256").update(JSON.stringify([providerId, data.provenance.version, match.place.id])).digest("hex")}`, providerId, place: match.place, matchedName: match.matchedName, match: match.match,
        countryBiasMatched: request.countryBias.length > 0 && bias(match.place) < request.countryBias.length,
        precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified",
        evidence: { provenance: data.provenance, shardSha256: match.shard.sha256, sourceRecordUrl: match.place.sourceRecordUrl },
      }));
      return GeocodingResultSchema.parse({ ...base,
        status: candidates.length ? "candidates" : "unresolved",
        reason: !candidates.length ? "no-match-in-scope" : candidates[0]!.match === "prefix" ? "partial-name-candidates" : matches.size === 1 ? "single-exact-city" : "ambiguous-place-name",
        candidates, totalCandidates: matches.size, truncated: matches.size > candidates.length,
        searchedCountryCodes: descriptors.map((shard) => shard.countryCode), datasetVersion: data.provenance.version,
        warnings: [data.provenance.coverage, "City reference points are approximate, unverified office locations. Explicit candidate selection is required.", ...(matches.size > candidates.length ? ["Candidate list truncated; narrow the country, administrative code or geographic bounds."] : [])],
      });
    },
  };
}

async function readBoundedFile(path: string, maximum: number, expectedBytes?: number): Promise<Uint8Array> {
  try {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximum || (expectedBytes !== undefined && stat.size !== expectedBytes)) throw new GeocodingProviderError("invalid-data");
      const bytes = Buffer.alloc(stat.size);
      let position = 0;
      while (position < bytes.length) {
        const read = await file.read(bytes, position, bytes.length - position, position);
        if (!read.bytesRead) throw new GeocodingProviderError("invalid-data");
        position += read.bytesRead;
      }
      if ((await file.stat()).size !== bytes.length) throw new GeocodingProviderError("invalid-data");
      return bytes;
    } finally { await file.close(); }
  } catch (error) { throw error instanceof GeocodingProviderError ? error : new GeocodingProviderError("dataset-unavailable"); }
}

/** The only filesystem path is supplied once by a trusted host, never by the geocoding request. */
export function createLocalGazetteerProvider(options: { manifestPath: string; providerId?: string }) {
  if (!isAbsolute(options.manifestPath)) throw new GeocodingProviderError("invalid-request");
  const directory = dirname(options.manifestPath);
  return createGazetteerProvider({ providerId: options.providerId,
    loadManifest: async () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(options.manifestPath, 256 * 1024))),
    loadShard: (descriptor) => readBoundedFile(join(directory, "countries", descriptor.file), 8 * 1024 * 1024, descriptor.bytes),
  });
}

export function createGeocodingTool(provider: GeocodingProvider) {
  return defineTool({ name: "locations.geocode-candidates", version: 1, description: provider.offline ? "按显式地点查询本地城市候选；保留歧义、来源、WGS84和估算精度，不自动写岗位或家庭地址。" : "按显式地点查询外部地理候选；查询会发送给配置的provider，保留歧义、来源与精度，不自动写岗位。", effect: provider.offline ? "read-index" : "external-read",
    inputSchema: GeocodingRequestSchema, outputSchema: GeocodingResultSchema,
    execute: async (input, context) => {
      try { return await provider.search(input, context); }
      catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(error instanceof GeocodingProviderError ? error.code === "invalid-request" ? "invalid-input" : error.code === "cancelled" ? "cancelled" : "source-changed" : "internal-error");
      }
    },
  });
}
