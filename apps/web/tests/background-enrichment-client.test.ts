import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { BackgroundEnrichmentClientError, readBackgroundEnrichmentStatus } from "../src/lib/background-enrichment-client";

const status = { revision: 12, pending: 3, running: 1, completed: 8, failed: 2, nextRetryAt: "2026-10-28T12:00:00.000Z", workerState: "running" };
const body = (value: unknown = status) => JSON.stringify({ ok: true, requestId: "synthetic-background-status", value });
const code = (value: BackgroundEnrichmentClientError["code"]) => (error: unknown) => error instanceof BackgroundEnrichmentClientError && error.code === value;
afterEach(() => mock.restoreAll());

test("background status uses only the authenticated bounded read route", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(body()));
  const abort = new AbortController();
  assert.deepEqual(await readBackgroundEnrichmentStatus("http://127.0.0.1:5178", " synthetic-token ", { signal: abort.signal }), status);
  const [url, options] = fetcher.mock.calls[0]!.arguments as unknown as [URL, RequestInit];
  assert.equal(String(url), "http://127.0.0.1:5178/api/v1/enrichment/status");
  assert.deepEqual(options, { method: "GET", signal: abort.signal, headers: { Authorization: "Bearer synthetic-token" }, credentials: "omit", redirect: "error", cache: "no-store" });
});

test("invalid connection identities do not send credentials or touch the network", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(body()));
  for (const endpoint of ["not-a-url", "https://example.invalid", "http://localhost.example.invalid", "http://localhost/path", "http://user:password@localhost", "http://localhost/?x=y", "http://localhost/#x"]) {
    await assert.rejects(readBackgroundEnrichmentStatus(endpoint, "synthetic"), code("invalid-endpoint"));
  }
  await assert.rejects(readBackgroundEnrichmentStatus("http://localhost", "  "), code("missing-token"));
  await assert.rejects(readBackgroundEnrichmentStatus("http://localhost", "synthetic\r\nheader"), code("missing-token"));
  assert.equal(fetcher.mock.callCount(), 0);
});

test("status schemas reject malformed counters and unknown data without exposing server error details", async () => {
  for (const value of [{ ...status, revision: -1 }, { ...status, pending: 1.2 }, { ...status, secret: "private" }, { ...status, nextRetryAt: "tomorrow" }]) {
    mock.restoreAll(); mock.method(globalThis, "fetch", async () => new Response(body(value)));
    await assert.rejects(readBackgroundEnrichmentStatus("http://localhost", "synthetic"), code("invalid-response"));
  }
  mock.restoreAll(); mock.method(globalThis, "fetch", async () => new Response("PRIVATE_DATABASE_PATH", { status: 500 }));
  await assert.rejects(readBackgroundEnrichmentStatus("http://localhost", "synthetic"), error => error instanceof Error && !error.message.includes("PRIVATE_DATABASE_PATH"));
});

test("oversized status streams are cancelled before an unbounded tail can be read", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode("中文")); }, cancel() { cancelled = true; } });
  mock.method(globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(readBackgroundEnrichmentStatus("http://localhost", "synthetic", { maxBytes: 8 }), code("too-large"));
  assert.equal(cancelled, true);
});
