import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, mock } from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";

const at = "2026-10-19T12:00:00.000Z";
const source = SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]);
const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-discovery-token ");
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-company-discovery", value }));
const result = () => ({ status: "requires-company-website", companyName: "Synthetic Company", observedAt: at,
  matchedSources: [], candidates: [], proposals: [], visitedUrls: [], partial: false, warnings: [] });
const invalidResponse = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response";
afterEach(() => mock.restoreAll());

test("company discovery capabilities uses an authenticated read without a source, body or mutation key", async () => {
  const values = [{ schemaVersion: 1, webSearch: { configured: false } },
    ...["duckduckgo-html", "searxng", "host-installed"].map(providerId => ({ schemaVersion: 1, webSearch: { configured: true, providerId, label: "Synthetic provider" } }))];
  let next = 0;
  const fetcher = mock.method(globalThis, "fetch", async () => response(values[next++]));
  const controller = new AbortController();
  for (const value of values) assert.deepEqual(await client().companyDiscoveryCapabilities({ signal: controller.signal }), value);
  for (const call of fetcher.mock.calls) {
    const [url, init] = call.arguments as [URL, RequestInit];
    assert.equal(url.pathname, "/api/v1/companies/discovery-capabilities"); assert.equal(init.method, "GET");
    assert.equal(init.body, undefined); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error");
    assert.equal(init.signal, controller.signal); assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-discovery-token");
    assert.equal(new Headers(init.headers).has("Idempotency-Key"), false);
  }
});

test("name-only discovery omits sourceId and binds the returned company to the normalized request", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => response(result()));
  assert.deepEqual(await client().discoverCompany(undefined, { companyName: "  Synthetic Company  " }), result());
  const [url, init] = fetcher.mock.calls[0]!.arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/api/v1/companies/discover-careers"); assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(String(init.body)), { request: { companyName: "Synthetic Company", limit: 10, maxPages: 3 } });
  assert.equal(new Headers(init.headers).has("Idempotency-Key"), false);
  fetcher.mock.restore(); mock.method(globalThis, "fetch", async () => response({ ...result(), companyName: "Different Company" }));
  await assert.rejects(client().discoverCompany(undefined, { companyName: "Synthetic Company" }), invalidResponse);
});

test("an explicit website or seed cannot expand endpoint policy without a registered sourceId", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => response(result()));
  for (const value of [{ companyName: "Synthetic Company", companyWebsite: "https://company.example/careers" },
    { companyName: "Synthetic Company", seedUrls: ["https://company.example/careers"] },
    { companyName: "Synthetic Company", endpointPolicy: { allowedHosts: ["company.example"] } },
    { companyName: "Synthetic Company", searchProvider: "duckduckgo-html" }]) {
    await assert.rejects(client().discoverCompany(undefined, value), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
  }
  assert.equal(fetcher.mock.callCount(), 0);
  await client().discoverCompany(source.sourceId, { companyName: "Synthetic Company", companyWebsite: "https://company.example/careers" });
  const body = JSON.parse(String((fetcher.mock.calls[0]!.arguments[1] as RequestInit).body));
  assert.equal(body.sourceId, source.sourceId); assert.equal(body.request.companyWebsite, "https://company.example/careers");
});

test("configuration remains a strict non-secret projection and provider/network failures are not empty results", async () => {
  for (const value of [{ schemaVersion: 1, webSearch: { configured: false, label: "private" } },
    { schemaVersion: 1, webSearch: { configured: true, providerId: "untrusted", label: "Synthetic" } },
    { schemaVersion: 1, webSearch: { configured: true, providerId: "searxng", label: "Synthetic", baseUrl: "https://private.example" } },
    { schemaVersion: 1, webSearch: { configured: false }, token: "private" }]) {
    const fetcher = mock.method(globalThis, "fetch", async () => response(value));
    await assert.rejects(client().companyDiscoveryCapabilities(), invalidResponse); fetcher.mock.restore();
  }
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, requestId: "synthetic", error: { code: "needs-auth", message: "private provider credential" } }), { status: 401 }));
  await assert.rejects(client().companyDiscoveryCapabilities(), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "needs-auth" && !error.message.includes("private"));
  fetcher.mock.restore(); mock.method(globalThis, "fetch", async () => { throw new TypeError("private internal endpoint"); });
  await assert.rejects(client().discoverCompany(undefined, { companyName: "Synthetic Company" }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "transport-error" && !error.message.includes("private"));
});

test("search counts remain separate from website reads and enabled proposals are rejected", async () => {
  const search = { providerId: "duckduckgo-html", label: "DuckDuckGo HTML", query: "Synthetic Company official careers 招聘", resultCount: 2 };
  const fetcher = mock.method(globalThis, "fetch", async () => response({ ...result(), status: "no-candidates", search }));
  const received = await client().discoverCompany(undefined, { companyName: "Synthetic Company" });
  assert.equal(received.search?.resultCount, 2); assert.deepEqual(received.visitedUrls, []); fetcher.mock.restore();
  for (const override of [{ enabled: true, status: "active" }, { enabled: false, status: "disabled" }]) {
    const invalid = mock.method(globalThis, "fetch", async () => response({ ...result(), proposals: [{ schemaVersion: 1, candidateId: "synthetic-candidate", source: { ...source, ...override }, reviewRequired: ["Review the company affiliation."] }] }));
    await assert.rejects(client().discoverCompany(undefined, { companyName: "Synthetic Company" }), invalidResponse); invalid.mock.restore();
  }
});

test("metadata and discovery reads share cancellation and bounded response handling", async () => {
  const controller = new AbortController();
  const fetcher = mock.method(globalThis, "fetch", async () => { controller.abort(new DOMException("Synthetic cancel", "AbortError")); return response({ schemaVersion: 1, webSearch: { configured: false } }); });
  await assert.rejects(client().companyDiscoveryCapabilities({ signal: controller.signal }), { name: "AbortError" }); fetcher.mock.restore();
  mock.method(globalThis, "fetch", async () => response({ schemaVersion: 1, webSearch: { configured: false } }));
  await assert.rejects(client().companyDiscoveryCapabilities({ maxBytes: 8 }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
});
