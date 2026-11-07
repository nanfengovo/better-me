import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { AtlasClientError, DEFAULT_ATLAS_BACKEND_ENDPOINT, hasAtlasServiceTarget, resolveAtlasServiceTarget } from "../src/components/atlas/backend-connection.ts";
import { readAtlasSnapshot } from "../src/components/atlas/client.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => { mock.restoreAll(); if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); });
function origin(value: string) { Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: value } } }); }

test("the fixed gateway resolves against the current origin without frontend credentials", async () => {
  origin("http://127.0.0.1:5286");
  const target = resolveAtlasServiceTarget(DEFAULT_ATLAS_BACKEND_ENDPOINT, "");
  assert.equal(target.apiRoot.href, "http://127.0.0.1:5286/api/atlas/api/v1/"); assert.deepEqual(target.headers, {});
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true, requestId: "synthetic-gateway", value: createAtlasDemo() })));
  assert.equal((await readAtlasSnapshot("/api/atlas", "")).jobs.length, 22);
  const [url, init] = fetcher.mock.calls[0]!.arguments as unknown as [URL, RequestInit];
  assert.equal(String(url), "http://127.0.0.1:5286/api/atlas/api/v1/dataset/export"); assert.deepEqual(init.headers, {});
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
});

test("gateway syntax and token are exact while manual loopback keeps its existing root and authentication policy", () => {
  origin("https://nanfengovo.github.io");
  assert.equal(resolveAtlasServiceTarget("/api/atlas", "").apiRoot.href, "https://nanfengovo.github.io/api/atlas/api/v1/");
  for (const endpoint of ["/api/atlas/", "/api/atlas?target=http://localhost", "//other.example/api/atlas", "https://other.example/api/atlas", "http://localhost/api/atlas"]) assert.equal(hasAtlasServiceTarget(endpoint, ""), false);
  assert.throws(() => resolveAtlasServiceTarget("/api/atlas", "host-secret"), AtlasClientError);
  for (const endpoint of ["http://127.0.0.1:5178", "https://localhost:5178/", "http://[::1]:5178"]) {
    const target = resolveAtlasServiceTarget(endpoint, " synthetic "); assert.equal(target.apiRoot.pathname, "/api/v1/"); assert.deepEqual(target.headers, { Authorization: "Bearer synthetic" });
  }
  for (const token of ["", " ", "secret\nheader", "x".repeat(4097)]) assert.equal(hasAtlasServiceTarget("http://localhost:5178", token), false);
});

test("static hosting gateway failure remains actionable and does not fall back to another endpoint", async () => {
  origin("https://nanfengovo.github.io");
  const fetcher = mock.method(globalThis, "fetch", async () => new Response("static page", { status: 404 }));
  await assert.rejects(readAtlasSnapshot("/api/atlas", ""), /默认后端不可用.*GitHub 静态网页.*高级连接/);
  assert.equal(fetcher.mock.callCount(), 1);
});
