import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  acceptGeocodingCandidate, createToolRegistry, GazetteerManifestSchema, GeocodingResultSchema,
  type GazetteerManifest, type GazetteerPlace, type GazetteerShardDescriptor,
  type JobLocation,
} from "@better-me/opportunities";
import { createGazetteerProvider, createLocalGazetteerProvider, createGeocodingTool, GeocodingProviderError, type GeocodingContext } from "../src/geocoding.js";

const at = "2026-10-18T14:00:00.000Z";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function context(signal = new AbortController().signal): GeocodingContext {
  return { signal, throwIfCancelled() { if (signal.aborted) throw new GeocodingProviderError("cancelled"); } };
}
function place(id: string, countryCode: string, overrides: Partial<GazetteerPlace> = {}): GazetteerPlace {
  return { id, name: "Springfield", asciiName: "Springfield", aliases: ["Synthetic city"], sourceRecordUrl: `https://places.example.test/${id}`,
    countryCode, alternateCountryCodes: [], administrativeCodes: { admin1: "original-code" }, coordinates: { latitude: 10, longitude: 20, coordinateSystem: "WGS84" },
    featureCode: "PPL", population: 20_000, sourceModifiedDate: "2026-10-17", ...overrides };
}
function fixture(places: GazetteerPlace[]) {
  const version = "synthetic-gazetteer-v1";
  const grouped = new Map<string, GazetteerPlace[]>();
  for (const place of places) grouped.set(place.countryCode, [...(grouped.get(place.countryCode) ?? []), place]);
  const bytes = new Map<string, Uint8Array>();
  const shards: GazetteerShardDescriptor[] = [];
  for (const [countryCode, rows] of grouped) {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, datasetVersion: version, countryCode, places: rows }));
    const compressed = gzipSync(body);
    const descriptor: GazetteerShardDescriptor = { countryCode, alternateCountryCodes: [...new Set(rows.flatMap((row) => row.alternateCountryCodes))].sort(), file: `${countryCode}.json.gz`, encoding: "gzip", sha256: sha(compressed), bytes: compressed.byteLength, decodedBytes: body.byteLength, count: rows.length };
    bytes.set(descriptor.file, compressed); shards.push(descriptor);
  }
  const manifest: GazetteerManifest = { schemaVersion: 1, recordCount: places.length, shards,
    provenance: { datasetId: "synthetic-places", version, sourceUrl: "https://places.example.test/data.zip", sourceArchiveSha256: "a".repeat(64), retrievedAt: at,
      license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic data, not real offices.", coordinateSystem: "WGS84", coverage: "Finite synthetic city points." } };
  const loaded: string[] = [];
  return { manifest, bytes, loaded, provider: createGazetteerProvider({ loadManifest: async () => manifest, loadShard: async (descriptor) => { loaded.push(descriptor.countryCode); return bytes.get(descriptor.file)!; } }) };
}
function error(code: string) { return (value: unknown) => value instanceof GeocodingProviderError && value.code === code; }

test("local candidates retain ambiguity and country bias only ranks; a selection is explicit and stays estimated", async () => {
  const f = fixture([place("place.us", "US"), place("place.ca", "CA")]);
  const result = await f.provider.search({ raw: "Ｓｐｒｉｎｇｆｉｅｌｄ", kind: "office", countryBias: ["CA"], limit: 1 }, context());
  assert.equal(result.totalCandidates, 2); assert.equal(result.truncated, true);
  assert.equal(result.reason, "ambiguous-place-name"); assert.equal(result.requiresConfirmation, true);
  assert.equal(result.candidates[0]!.place.countryCode, "CA");
  assert.equal(result.request.raw, "Ｓｐｒｉｎｇｆｉｅｌｄ");
  const selected = acceptGeocodingCandidate(result, result.candidates[0]!.id);
  assert.equal(selected.verification, "unverified"); assert.equal(selected.candidate.precision, "city"); assert.equal(selected.candidate.estimated, true);
  assert.equal(selected.candidate.place.administrativeCodes.admin1, "original-code");
  assert.throws(() => acceptGeocodingCandidate(result, "invented-candidate"));
  assert.deepEqual(GeocodingResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
});

test("country and administrative scopes are hard filters; source alternate codes are retained without recoding", async () => {
  const f = fixture([place("place.cn", "CN", { name: "Synthetic town", alternateCountryCodes: ["MO"] }), place("place.ca", "CA")]);
  const scoped = await f.provider.search({ raw: "Synthetic town", kind: "office", countryCodes: ["MO"] }, context());
  assert.equal(scoped.totalCandidates, 1); assert.equal(scoped.candidates[0]!.place.countryCode, "CN");
  assert.deepEqual(scoped.candidates[0]!.place.alternateCountryCodes, ["MO"]); assert.deepEqual(f.loaded, ["CN"]);
  const excluded = await f.provider.search({ raw: "Springfield", kind: "office", countryCodes: ["CA"], administrativeCodes: { admin1: "wrong" } }, context());
  assert.equal(excluded.status, "unresolved"); assert.equal(excluded.reason, "no-match-in-scope");
  const accepted = await f.provider.search({ raw: "Springfield", kind: "office", countryCodes: ["CA"], administrativeCodes: { admin1: "original-code" } }, context());
  assert.equal(accepted.totalCandidates, 1); assert.equal(accepted.reason, "single-exact-city"); assert.equal(accepted.requiresConfirmation, true);
});

test("strict name boundaries avoid substring address guessing; prefix matches are explicit candidates", async () => {
  const f = fixture([place("place.fr", "FR", { name: "Saint-Étienne", asciiName: "Saint-Etienne", aliases: ["圣艾蒂安"] })]);
  for (const raw of ["Saint", "Saint-Étienne office", "广东省Saint-Étienne市", "Europe"]) {
    assert.equal((await f.provider.search({ raw, kind: "office" }, context())).status, "unresolved");
  }
  const alias = await f.provider.search({ raw: " 圣艾蒂安 ", kind: "office" }, context());
  assert.equal(alias.candidates[0]!.matchedName, "圣艾蒂安"); assert.equal(alias.candidates[0]!.match, "exact-alias");
  const prefix = await f.provider.search({ raw: "Saint", kind: "office", allowPrefix: true }, context());
  assert.equal(prefix.reason, "partial-name-candidates"); assert.equal(prefix.candidates[0]!.match, "prefix");
  await assert.rejects(f.provider.search({ raw: "S", kind: "office", allowPrefix: true }, context()), error("invalid-request"));
});

test("bounds handle the antimeridian; remote and unknown regions never load or acquire office points", async () => {
  const f = fixture([place("place.fj", "FJ", { name: "Synthetic eastern town", coordinates: { latitude: -17, longitude: 179, coordinateSystem: "WGS84" } })]);
  for (const kind of ["remote-region", "unknown"] as const) {
    const remote = await f.provider.search({ raw: "Europe", kind }, context());
    assert.equal(remote.status, "not-applicable"); assert.deepEqual(remote.candidates, []); assert.deepEqual(f.loaded, []);
  }
  assert.equal((await f.provider.search({ raw: "Synthetic eastern town", kind: "office", bounds: [170, -30, -170, 0] }, context())).totalCandidates, 1);
  assert.equal((await f.provider.search({ raw: "Synthetic eastern town", kind: "office", bounds: [-10, -30, 10, 0] }, context())).totalCandidates, 0);
});

test("lazy shards are cached and caller mutation cannot alter cached source records", async () => {
  const f = fixture([place("place.us", "US"), place("place.ca", "CA")]);
  const input = { raw: "Springfield", kind: "office" as const, countryCodes: ["US"] };
  const first = await f.provider.search(input, context()); first.candidates[0]!.place.name = "Caller mutation";
  const second = await f.provider.search(input, context());
  assert.equal(second.candidates[0]!.place.name, "Springfield"); assert.deepEqual(f.loaded, ["US"]);
  f.provider.clearCache(); await f.provider.search(input, context()); assert.deepEqual(f.loaded, ["US", "US"]);
});

test("byte hashes, decoded limits and WGS84 are enforced before a candidate is returned", async () => {
  const f = fixture([place("place.us", "US")]);
  const descriptor = f.manifest.shards[0]!;
  const original = f.bytes.get(descriptor.file)!;
  f.bytes.set(descriptor.file, Buffer.from("tampered"));
  await assert.rejects(f.provider.search({ raw: "Springfield", kind: "office" }, context()), error("invalid-data"));
  f.bytes.set(descriptor.file, original);
  assert.equal((await f.provider.search({ raw: "Springfield", kind: "office" }, context())).totalCandidates, 1, "A failed shard load may be retried after repair.");
  const mixed = fixture([place("place.us", "US", { coordinates: { latitude: 10, longitude: 20, coordinateSystem: "GCJ02" } as unknown as GazetteerPlace["coordinates"] })]);
  await assert.rejects(mixed.provider.search({ raw: "Springfield", kind: "office" }, context()), error("invalid-data"));
  const bomb = fixture([place("place.us", "US")]); bomb.manifest.shards[0]!.decodedBytes = 1;
  await assert.rejects(bomb.provider.search({ raw: "Springfield", kind: "office" }, context()), error("invalid-data"));
});

test("cancellation prevents dataset work and tools expose only validated candidate results", async () => {
  const f = fixture([place("place.us", "US")]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.provider.search({ raw: "Springfield", kind: "office" }, context(controller.signal)), error("cancelled"));
  assert.deepEqual(f.loaded, []);
  const registry = createToolRegistry([createGeocodingTool(f.provider)]);
  const result = await registry.execute("locations.geocode-candidates", { raw: "Springfield", kind: "office", countryCodes: ["US"] }, {
    requestId: "synthetic-geocoding", actorScope: "local-owner", allowedEffects: ["read-index"], signal: new AbortController().signal,
    budget: { requests: 0, bytes: 100_000, timeoutMs: 3000 },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(GeocodingResultSchema.parse(result.value).candidates[0]!.estimated, true);
});

test("checked-in GeoNames snapshot validates all 244 shards; Chinese aliases and actual ambiguities retain evidence", async () => {
  const manifestPath = fileURLToPath(new URL("../../../config/geography/gazetteer/manifest.json", import.meta.url));
  const manifest = GazetteerManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(manifest.recordCount, 34_167); assert.equal(manifest.shards.length, 244);
  const provider = createLocalGazetteerProvider({ manifestPath });
  const shanghai = await provider.search({ raw: "上海", kind: "office", countryCodes: ["CN"] }, context());
  const city = shanghai.candidates.find((candidate) => candidate.place.id === "geonames.1796236");
  assert.ok(city); assert.equal(city.place.administrativeCodes.admin1, "23"); assert.equal(city.place.coordinates.coordinateSystem, "WGS84");
  assert.equal(city.evidence.provenance.sourceArchiveSha256, "7d1c80d5be04850227384c1f6f9163b56401dc46270be1012e1a2de0a5bf4a70");
  assert.equal(city.evidence.provenance.license, "CC-BY-4.0");
  const all = await provider.search({ raw: "Springfield", kind: "office", limit: 50 }, context());
  assert.equal(all.searchedCountryCodes.length, 244); assert.ok(all.totalCandidates > 2); assert.equal(all.reason, "ambiguous-place-name");
  const hk = await provider.search({ raw: "香港", kind: "office", countryCodes: ["HK"] }, context());
  assert.ok(hk.candidates.some((candidate) => candidate.place.countryCode === "HK"));
  provider.clearCache();
});

test("a future online provider cannot hide its external effect behind the offline tool permission", async () => {
  let called = false;
  const f = fixture([place("place.us", "US")]);
  const registry = createToolRegistry([createGeocodingTool({ providerId: "synthetic-online-port", offline: false, search: async (input, context) => { called = true; return f.provider.search(input, context); } })]);
  const result = await registry.execute("locations.geocode-candidates", { raw: "Springfield", kind: "office" }, {
    requestId: "synthetic-online-denied", actorScope: "local-owner", allowedEffects: ["read-index"], signal: new AbortController().signal,
    budget: { requests: 0, bytes: 100_000, timeoutMs: 3000 },
  });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "not-authorized"); assert.equal(called, false);
});

function location(id: string, overrides: Partial<JobLocation> = {}): JobLocation {
  return { id, raw: "Synthetic source city", city: "Synthetic city", countryCode: "US", kind: "unknown", precision: "city", verification: "unverified", evidence: [], ...overrides };
}

test("distribution references use unique whole city aliases without assigning an office or mutating source locations", async () => {
  const f = fixture([place("place.us", "US"), place("place.ca", "CA")]);
  const locations = [location("location.a"), location("location.b", { kind: "office" })];
  const before = structuredClone(locations);
  const result = await f.provider.resolveMapReferences(locations, context());
  assert.equal(result.references.length, 2); assert.equal(result.places.length, 1); assert.deepEqual(result.unresolved, []);
  assert.equal(result.references[0]!.match, "exact-alias"); assert.equal(result.references[0]!.countryCode, "US");
  assert.equal(result.places[0]!.estimated, true); assert.equal(result.places[0]!.verification, "unverified");
  assert.equal(result.places[0]!.coordinateMeaning, "populated-place-reference-point");
  assert.equal(result.provenance!.version, f.manifest.provenance.version);
  assert.deepEqual(f.loaded, ["US"]); assert.deepEqual(locations, before);
  result.places[0]!.place.name = "Caller mutation";
  const again = await f.provider.resolveMapReferences(locations, context());
  assert.equal(again.places[0]!.place.name, "Springfield"); assert.deepEqual(f.loaded, ["US"]);
  const office = await f.provider.search({ raw: "Synthetic city", kind: "office", countryCodes: ["US"] }, context());
  assert.equal(office.requiresConfirmation, true, "Distribution projection does not relax office-candidate confirmation.");
});

test("distribution skips remote, existing coordinates, missing fields and conflicts without loading data", async () => {
  const f = fixture([place("place.us", "US")]);
  const rows = [location("remote", { kind: "remote-region" }), location("coordinate", { coordinates: { latitude: 10, longitude: 20, coordinateSystem: "WGS84" } }),
    location("conflict", { verification: "conflicting" }), location("country", { countryCode: undefined }), location("city", { city: undefined })];
  const result = await f.provider.resolveMapReferences(rows, context());
  assert.deepEqual(result.unresolved.map(row => row.reason), ["remote-region", "existing-coordinate", "conflicting-location", "missing-country", "missing-city"]);
  assert.equal(result.references.length, 0); assert.equal(result.provenance, undefined); assert.deepEqual(f.loaded, []);
});

test("distribution never takes a first ambiguous name, prefix, raw address or foreign country match", async () => {
  const f = fixture([place("place.us.a", "US"), place("place.us.b", "US"), place("place.ca", "CA", { name: "Only Canadian Town", aliases: [] })]);
  const rows = [location("ambiguous", { city: "Springfield" }), location("prefix", { city: "Spring" }), location("address", { city: "Springfield office" }),
    location("foreign", { city: "Only Canadian Town" }), location("raw", { city: undefined, raw: "Only Canadian Town" })];
  const result = await f.provider.resolveMapReferences(rows, context());
  assert.equal(result.references.length, 0);
  assert.deepEqual(result.unresolved.map(row => row.reason), ["ambiguous-city", "no-exact-match", "no-exact-match", "no-exact-match", "missing-city"]);
  assert.deepEqual(f.loaded, ["US"]);
});

test("distribution cancellation stops before loading or returning a late batch", async () => {
  const f = fixture([place("place.us", "US")]); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.provider.resolveMapReferences([location("one")], context(controller.signal)), error("cancelled"));
  assert.deepEqual(f.loaded, []);
  await assert.rejects(f.provider.resolveMapReferences([location("one"), location("one")], context()), error("invalid-request"));
});
