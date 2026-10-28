import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { jobSearchMiddleware } from "../server/jd-search-api.ts";
import { streamLiveBatchSearch } from "../server/jd-search-api.ts";
import type { LiveBatchSearchCallbacks, LiveBatchSearchResult } from "../server/jd-live-batch-search.ts";
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

test("live batch SSE streams provider state/results before a compact final receipt", async () => {
  const coverage = { pagesVisited: 1, scrollSteps: 0, scrollLimit: 0, pageLimit: 5, cardLimit: 500, stopReason: "exhausted" as const, partial: false };
  const result = {
    provider: "liepin" as const, platform: "猎聘" as const, pageUrl: "https://www.liepin.com/zhaopin/?key=Rust",
    status: "ready" as const, cards: [{ platform: "猎聘" as const, title: "Rust 工程师", url: "https://www.liepin.com/job/123456789.shtml",
      company: "Synthetic employer", cardText: "Rust role excerpt", evidence: { pageUrl: "https://www.liepin.com/zhaopin/?key=Rust",
        cardSelector: ".job-card", fields: [{ field: "title" as const, selector: ".title", text: "Rust 工程师" }] } }],
    rawCardCount: 1, warnings: [], coverage,
  };
  let calls = 0;
  const runner = async (_input: { keyword: string; providers?: Array<"liepin"> }, _signal: AbortSignal | undefined, callbacks: LiveBatchSearchCallbacks): Promise<LiveBatchSearchResult> => {
    calls++;
    await callbacks?.onProviderQueued?.("liepin", "猎聘");
    await callbacks?.onProviderStart?.("liepin", "猎聘");
    await callbacks?.onProviderProgress?.({ provider: "liepin", platform: "猎聘", pagesVisited: 1, scrollSteps: 0, cardsCaptured: 1, cards: result.cards });
    await callbacks.onProviderResult?.(result as LiveBatchSearchResult["results"][number]);
    return { capturedAt: "2026-10-26T00:00:00.000Z", results: [result as LiveBatchSearchResult["results"][number]] };
  };
  const server = createServer((_request, response) => {
    void streamLiveBatchSearch(response, { keyword: "Rust", providers: ["liepin"] }, new AbortController(), runner);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(url);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    const body = await response.text();
    const events = body.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, "")) as { type: string });
    assert.deepEqual(events.map(event => event.type), ["provider-queued", "provider-start", "provider-progress", "provider-result", "complete"]);
    const progress = events[2] as { cards?: Array<{ evidence: { pageUrl: string } }> };
    assert.equal(progress.cards?.length, 1);
    assert.equal(progress.cards?.[0]?.evidence.pageUrl, result.cards[0]?.evidence.pageUrl, "SSE progress must preserve verified source-page evidence");
    assert.deepEqual(events.at(-1), { type: "complete", capturedAt: "2026-10-26T00:00:00.000Z", providers: ["liepin"] });
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("live batch SSE aborts the collector when the client disconnects", async () => {
  let sawAbort = false;
  const runner = async (_input: { keyword: string; providers?: Array<"liepin"> }, signal: AbortSignal | undefined, callbacks: LiveBatchSearchCallbacks): Promise<LiveBatchSearchResult> => {
    await callbacks.onProviderQueued?.("liepin", "猎聘");
    await new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { sawAbort = true; reject(signal.reason); return; }
      signal?.addEventListener("abort", () => { sawAbort = true; reject(signal.reason); }, { once: true });
    });
  };
  const server = createServer((_request, response) => {
    const operation = new AbortController();
    response.once("close", () => { if (!response.writableEnded) operation.abort(new DOMException("client closed", "AbortError")); });
    void streamLiveBatchSearch(response, { keyword: "Rust", providers: ["liepin"] }, operation, runner);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /provider-queued/);
    await reader.cancel();
    for (let attempt = 0; attempt < 20 && !sawAbort; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sawAbort, true, "disconnecting the stream must cancel the browser collector's AbortSignal");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
