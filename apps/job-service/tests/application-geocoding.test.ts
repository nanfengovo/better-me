import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GeocodingResultSchema, type GeocodingInput, type TrustedToolContext, type ToolResult } from "@better-me/opportunities";
import { GeocodingProviderError, type GeocodingProvider } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";

const route = "/api/v1/locations/geocode-candidates";
const token = "synthetic-geocoding-http-token-1234567890";
const origin = "http://localhost:5173";
const query = { raw: "上海", kind: "office", countryCodes: ["CN"] } as const;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: origin };
function context(signal = new AbortController().signal): TrustedToolContext {
  return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index"], signal, budget: { requests: 0, bytes: 2_000_000, timeoutMs: 5000 } };
}
function value(result: ToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return GeocodingResultSchema.parse(result.value); }
function unresolved(input: GeocodingInput) {
  return GeocodingResultSchema.parse({ schemaVersion: 1, providerId: "synthetic-geocoding", request: input, status: "unresolved", reason: "no-match-in-scope",
    candidates: [], totalCandidates: 0, truncated: false, requiresConfirmation: true, searchedCountryCodes: [], warnings: [] });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(provider?: GeocodingProvider) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-geocoding-app-"));
  const repository = openJobRepository(join(directory, "jobs.sqlite"));
  const application = createJobApplication({ repository, ...(provider ? { geocodingProvider: provider } : {}) });
  return { repository, application, close: async () => { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("default local city candidates use the same tool and authenticated HTTP result without writing the public index", async () => {
  const f = await fixture(); let http: ReturnType<typeof createJobHttpServer> | undefined;
  try {
    const before = await f.repository.readSnapshot();
    const expected = value(await f.application.registry.execute("locations.geocode-candidates", { ...query, countryCodes: [...query.countryCodes] }, context()));
    const shanghai = expected.candidates.find((candidate) => candidate.place.id === "geonames.1796236");
    assert.ok(shanghai); assert.equal(shanghai.precision, "city"); assert.equal(shanghai.estimated, true); assert.equal(shanghai.verification, "unverified");
    assert.equal(shanghai.place.coordinates.coordinateSystem, "WGS84"); assert.equal(shanghai.evidence.provenance.license, "CC-BY-4.0");
    assert.equal(shanghai.evidence.provenance.sourceArchiveSha256, "7d1c80d5be04850227384c1f6f9163b56401dc46270be1012e1a2de0a5bf4a70");
    assert.equal(expected.requiresConfirmation, true); assert.equal(expected.request.raw, query.raw);
    http = createJobHttpServer({ registry: f.application.registry, token, allowedOrigins: [origin], port: 0 });
    const { url } = await http.listen();
    assert.equal((await fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) })).status, 401);
    assert.equal((await fetch(`${url}${route}`, { method: "POST", headers: { ...headers, Origin: "https://foreign.example.test" }, body: JSON.stringify(query) })).status, 403);
    const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify(query) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(value(await response.json() as ToolResult), expected);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  } finally { await http?.close(); await f.close(); }
});

test("the default provider leaves remote eligibility and unknown location text unlocated", async () => {
  const f = await fixture();
  try {
    for (const kind of ["remote-region", "unknown"] as const) {
      const result = value(await f.application.registry.execute("locations.geocode-candidates", { raw: "上海", kind }, context()));
      assert.equal(result.status, "not-applicable"); assert.equal(result.reason, "not-an-office");
      assert.deepEqual(result.candidates, []); assert.deepEqual(result.searchedCountryCodes, []); assert.equal(result.datasetVersion, undefined);
    }
  } finally { await f.close(); }
});

test("HTTP geocoding rejects caller-selected files, providers and private side inputs before invoking a trusted provider", async () => {
  let calls = 0;
  const f = await fixture({ providerId: "synthetic-geocoding", offline: true, search: async (input) => { calls++; return unresolved(input); } });
  const http = createJobHttpServer({ registry: f.application.registry, token, allowedOrigins: [origin], port: 0 });
  try {
    const { url } = await http.listen();
    for (const extra of [{ manifestPath: "C:/private/manifest.json" }, { providerId: "caller-provider" }, { endpoint: "https://foreign.example.test" }, { homeAddress: "PRIVATE_ADDRESS" }]) {
      const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify({ ...query, ...extra }) });
      assert.equal(response.status, 400); const result = await response.json() as ToolResult;
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "invalid-input");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ADDRESS|C:\/private|foreign\.example/);
    }
    assert.equal(calls, 0);
    const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify(query) });
    assert.equal(response.status, 200); assert.equal(value(await response.json() as ToolResult).status, "unresolved"); assert.equal(calls, 1);
  } finally { await http.close(); await f.close(); }
});

test("provider failures and invalid output remain fixed tool errors; online providers require the external effect", async () => {
  for (const mode of ["unavailable", "invalid-output", "online"] as const) {
    let calls = 0;
    const f = await fixture({ providerId: "synthetic-geocoding", offline: mode !== "online", search: async (input) => {
      calls++;
      if (mode === "unavailable") throw new GeocodingProviderError("dataset-unavailable");
      return { ...unresolved(input), privatePath: "PRIVATE_PROVIDER_PAYLOAD" };
    } });
    try {
      const result = await f.application.registry.execute("locations.geocode-candidates", { ...query, countryCodes: ["CN"] }, context());
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, mode === "unavailable" ? "source-changed" : mode === "online" ? "not-authorized" : "invalid-output");
      assert.equal(calls, mode === "online" ? 0 : 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_PAYLOAD/);
    } finally { await f.close(); }
  }
});

test("service shutdown cancels an in-flight city query and drains late provider work before closing", async () => {
  const entered = deferred<void>(), release = deferred<void>(); let providerSignal: AbortSignal | undefined;
  const f = await fixture({ providerId: "synthetic-geocoding", offline: true, search: async (input, context) => {
    providerSignal = context.signal; entered.resolve(); await release.promise;
    // A third-party provider can ignore cancellation. The application still rejects its late result.
    return unresolved(input);
  } });
  try {
    const before = await f.repository.readSnapshot();
    const request = f.application.registry.execute("locations.geocode-candidates", { ...query, countryCodes: ["CN"] }, context());
    await entered.promise; let closed = false;
    const stopping = f.application.shutdown().then(() => { closed = true; });
    assert.equal(providerSignal?.aborted, true); await Promise.resolve(); assert.equal(closed, false);
    release.resolve(); const result = await request; await stopping;
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "cancelled");
    assert.deepEqual(await f.repository.readSnapshot(), before);
    const later = await f.application.registry.execute("locations.geocode-candidates", { ...query, countryCodes: ["CN"] }, context());
    assert.equal(later.ok, false); if (!later.ok) assert.equal(later.error.code, "cancelled");
  } finally { release.resolve(); await f.close(); }
});
