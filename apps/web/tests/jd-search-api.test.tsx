import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { jobSearchMiddleware } from "../server/jd-search-api.ts";
import type { JobSessionBackend } from "../server/jd-session-router.ts";
import { createJdStartRequestId } from "../src/lib/jd-start-request.ts";

test("real loopback search HTTP checks same-origin, bounded JSON and input before any browser call", async () => {
  const calls: unknown[] = [];
  const sessions = {
    startSearchRequest: async (owner: string, input: unknown, requestId: string) => { calls.push({ owner, input, requestId }); return { sessionId: "synthetic-search-12345", platform: "猎聘", url: "https://www.liepin.com/zhaopin/", expiresAt: "2026-10-18T18:00:00Z" }; },
    cancelSearchStart: async (owner: string, input: unknown, requestId: string) => { calls.push({ owner, input, requestId, cancel: true }); return { cancelled: true, closed: true }; },
    readSearch: async (owner: string, id: string) => { calls.push({ owner, id }); return { status: "verification_required", platform: "猎聘", url: "https://www.liepin.com/zhaopin/", cards: [], partial: true, warnings: [] }; },
  } as unknown as JobSessionBackend;
  const server = createServer((request, response) => { void jobSearchMiddleware(request, response, sessions); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { origin: url, "content-type": "application/json" };
  const send = (body: unknown, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ action: "start", input: { provider: "liepin", keyword: "" } }, { origin: "https://unrelated.invalid" })).status, 403);
    assert.equal((await send({ action: "start", input: { provider: "liepin", keyword: "C#", url: "http://127.0.0.1/private" } })).status, 400);
    assert.equal((await send({ action: "read", sessionId: "bad" })).status, 400);
    assert.equal(calls.length, 0);
    const requestId = createJdStartRequestId();
    const input = { provider: "liepin", keyword: "", regionId: "cn-shanghai" };
    assert.equal((await send({ action: "start", input, requestId })).status, 200);
    assert.deepEqual(calls[0], { owner: `${url}\n${new URL(url).host}`, input, requestId });
    assert.equal((await send({ action: "cancel-start", input, requestId })).status, 200);
    const response = await send({ action: "read", sessionId: "synthetic-search-12345" });
    const result = await response.json() as { status: string; cards: unknown[]; capturedAt: string };
    assert.equal(result.status, "verification_required"); assert.equal(result.cards.length, 0);
    assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
