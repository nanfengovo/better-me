import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { z } from "zod";
import { createToolRegistry, defineTool } from "@better-me/opportunities";
import { createJobHttpServer, toolResponseBudgetBytes } from "../src/http.js";

const TOKEN = "synthetic-test-service-token-only-1234567890";
const ORIGIN = "http://localhost:5173";
function createFixture(maxRequestBytes?: number) {
  let writes = 0;
  const registry = createToolRegistry([
    defineTool({ name: "jobs.search", version: 1, description: "Synthetic query", effect: "read-index", inputSchema: z.object({ text: z.string().optional() }).strict(), outputSchema: z.object({ count: z.number() }).strict(), execute: () => ({ count: 1 }) }),
    defineTool({ name: "sources.register", version: 1, description: "Synthetic write", effect: "local-write", inputSchema: z.object({ sourceId: z.string() }).strict(), outputSchema: z.object({ writes: z.number() }).strict(), execute: () => ({ writes: ++writes }) }),
  ]);
  return createJobHttpServer({ registry, token: TOKEN, allowedOrigins: [ORIGIN], port: 0, maxRequestBytes });
}
async function withServer(run: (url: string) => Promise<void>, maxBytes?: number) {
  const server = createFixture(maxBytes);
  const { url } = await server.listen();
  try { await run(url); } finally { await server.close(); }
}
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: ORIGIN };

test("only public snapshot reads receive the bounded larger response budget", () => {
  assert.equal(toolResponseBudgetBytes("jobs.sync-public"), 96 * 1024 * 1024);
  assert.equal(toolResponseBudgetBytes("jobs.export-public"), 96 * 1024 * 1024);
  assert.equal(toolResponseBudgetBytes("jobs.search"), 64 * 1024 * 1024);
  assert.equal(toolResponseBudgetBytes("jobs.import-public"), 64 * 1024 * 1024);
});

test("local API authenticates every response and rejects unapproved or null origins", async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 401);
    const healthy = await fetch(`${url}/healthz`, { headers });
    assert.equal(healthy.status, 200);
    assert.equal(healthy.headers.get("cache-control"), "no-store");
    assert.equal(healthy.headers.get("access-control-allow-origin"), ORIGIN);
    for (const origin of ["https://unrelated.example", "null", "http://localhost:5173.evil.example"]) {
      assert.equal((await fetch(`${url}/healthz`, { headers: { ...headers, Origin: origin } })).status, 403);
    }
    assert.equal((await fetch(`${url}/healthz`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  });
});

test("preflight is exact and never grants wildcard origins or unrecognized headers", async () => {
  await withServer(async (url) => {
    const preflight = { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization, idempotency-key" };
    const allowed = await fetch(`${url}/api/v1/jobs/search`, { method: "OPTIONS", headers: preflight });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
    assert.equal((await fetch(`${url}/api/v1/jobs/search`, { method: "OPTIONS", headers: { ...preflight, "Access-Control-Request-Headers": "x-privileged-tool-context" } })).status, 403);
    assert.equal((await fetch(`${url}/api/v1/jobs/search`, { method: "OPTIONS", headers: { ...preflight, Origin: "https://unrelated.example" } })).status, 403);
  });
});

test("HTTP invokes the same registry; state changes require a key and replay once", async () => {
  await withServer(async (url) => {
    const search = await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers, body: "{}" });
    assert.equal(search.status, 200);
    assert.equal((await search.json() as { value: { count: number } }).value.count, 1);
    const body = JSON.stringify({ sourceId: "synthetic-source" });
    assert.equal((await fetch(`${url}/api/v1/sources`, { method: "POST", headers, body })).status, 400);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${url}/api/v1/sources`, { method: "POST", headers: { ...headers, "Idempotency-Key": "synthetic-idempotency" }, body });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { value: { writes: number } }).value.writes, 1);
    }
    const conflict = await fetch(`${url}/api/v1/sources`, { method: "POST", headers: { ...headers, "Idempotency-Key": "synthetic-idempotency" }, body: JSON.stringify({ sourceId: "different" }) });
    assert.equal(conflict.status, 409);
    const contextInjection = await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers, body: JSON.stringify({ actorScope: "admin", allowedEffects: ["external-action"] }) });
    assert.equal(contextInjection.status, 400);
  });
});

test("request size, content type, routes and Host are checked before execution", async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers: { Authorization: headers.Authorization, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(`${url}/api/v1/jobs/search?home=private`, { method: "POST", headers, body: "{}" })).status, 400);
    assert.equal((await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers, body: JSON.stringify({ text: "a".repeat(100) }) })).status, 413);
    assert.equal((await fetch(`${url}/api/v1/unknown`, { headers })).status, 404);
    const rebinding = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${url}/healthz`, { headers: { Authorization: headers.Authorization, Host: "unrelated.example" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      request.on("error", reject); request.end();
    });
    assert.equal(rebinding, 403);
  }, 80);
});
