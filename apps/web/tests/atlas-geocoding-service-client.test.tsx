import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { GeocodingResultSchema, type GeocodingInput } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";

const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-token ");
const query = { raw: "上海", kind: "office", countryCodes: ["CN"] } as GeocodingInput;
const envelope = (value: unknown) => JSON.stringify({ ok: true, requestId: "synthetic-geocoding-client", value });
function candidates() {
  return GeocodingResultSchema.parse({
    schemaVersion: 1, providerId: "synthetic-gazetteer", request: query, status: "candidates", reason: "single-exact-city", totalCandidates: 1,
    truncated: false, requiresConfirmation: true, searchedCountryCodes: ["CN"], datasetVersion: "synthetic-v1", warnings: ["Synthetic approximate city point."],
    candidates: [{ id: "candidate.1", providerId: "synthetic-gazetteer", matchedName: "上海", match: "exact-alias", countryBiasMatched: false,
      precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified",
      place: { id: "place.1", name: "Original source name", aliases: ["上海"], sourceRecordUrl: "https://places.example.test/1", countryCode: "CN", alternateCountryCodes: [],
        administrativeCodes: { admin1: "original-code" }, coordinates: { latitude: 31, longitude: 121, coordinateSystem: "WGS84" }, featureCode: "PPL", population: 20_000, sourceModifiedDate: "2026-10-17" },
      evidence: { shardSha256: "b".repeat(64), sourceRecordUrl: "https://places.example.test/1", provenance: { datasetId: "synthetic", version: "synthetic-v1",
        sourceUrl: "https://places.example.test/data.zip", sourceArchiveSha256: "a".repeat(64), retrievedAt: "2026-10-18T12:00:00.000Z", license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic", coordinateSystem: "WGS84", coverage: "Finite synthetic city points." } },
    }],
  });
}
afterEach(() => mock.restoreAll());

test("city candidate client uses the authenticated read-only route and preserves exact evidence and confirmation semantics", async () => {
  const result = candidates(); const signal = new AbortController().signal;
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(envelope(result)));
  assert.deepEqual(await client().geocodeCandidates(query, { signal }), result);
  const [url, init] = fetcher.mock.calls[0]!.arguments as unknown as [URL, RequestInit];
  assert.equal(url.href, "http://127.0.0.1:5178/api/v1/locations/geocode-candidates"); assert.equal(init.method, "POST");
  assert.equal(init.signal, signal); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  assert.deepEqual(init.headers, { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(init.body)), result.request);
});

test("city candidate client rejects paths, provider overrides and private inputs before any request", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  for (const value of [{ ...query, manifestPath: "C:/private/file.json" }, { ...query, providerId: "override" }, { ...query, homeAddress: "PRIVATE_ADDRESS" },
    { ...query, raw: "!!!" }, { ...query, limit: 0 }, { ...query, countryCodes: ["CN", "CN"] }]) {
    await assert.rejects(client().geocodeCandidates(value), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test("city candidate client refuses extra fields, invented precision and silent automatic selection", async () => {
  const base = candidates();
  for (const value of [{ ...base, privateToken: "PRIVATE_RESULT" }, { ...base, requiresConfirmation: false },
    { ...base, candidates: [{ ...base.candidates[0], precision: "address" }] },
    { ...base, candidates: [{ ...base.candidates[0], estimated: false }] },
    { ...base, request: { ...base.request, countryCodes: ["US"] } }]) {
    const fetcher = mock.method(globalThis, "fetch", async () => new Response(envelope(value)));
    await assert.rejects(client().geocodeCandidates(query), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response" && !error.message.includes("PRIVATE_RESULT"));
    fetcher.mock.restore();
  }
});

test("city candidate client rejects a valid result bound to another original place query", async () => {
  const other = candidates(); other.request.raw = "北京"; other.candidates[0]!.matchedName = "北京"; other.candidates[0]!.place.aliases = ["北京"];
  assert.equal(GeocodingResultSchema.safeParse(other).success, true);
  mock.method(globalThis, "fetch", async () => new Response(envelope(other)));
  await assert.rejects(client().geocodeCandidates(query), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response");
});

test("city candidate requests forward cancellation and enforce response byte limits", async () => {
  const controller = new AbortController(); let bodyCancelled = false;
  const fetcher = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException("synthetic cancelled", "AbortError"))); }, cancel() { bodyCancelled = true; } }));
  });
  await assert.rejects(client().geocodeCandidates(query, { signal: controller.signal }), { name: "AbortError" }); assert.equal(bodyCancelled, true);
  fetcher.mock.restore(); bodyCancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(stream) { stream.enqueue(new TextEncoder().encode("中文")); }, cancel() { bodyCancelled = true; } })));
  await assert.rejects(client().geocodeCandidates(query, { maxBytes: 8 }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
  assert.equal(bodyCancelled, true);
});
