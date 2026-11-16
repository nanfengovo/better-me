import assert from "node:assert/strict";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapterContext } from "../src/contracts.js";
import {
  SourceTransportError,
  createControlledSourceTransport,
  createGoogleDohResolver,
} from "../src/transport.js";

const SOURCE: SourceDefinition = {
  sourceId: "synthetic-source",
  name: "Synthetic HTTPS Source",
  adapterId: "greenhouse",
  adapterVersion: "1",
  capabilities: ["job-postings"],
  runtime: ["local-service"],
  entityType: "job-posting",
  enabled: true,
  status: "active",
  remoteFilters: [],
  endpointPolicy: {
    allowedHosts: ["jobs.example.com"],
    allowedPathPrefixes: ["/v1/boards/"],
    requireHttps: true,
    allowRedirects: false,
    maxRedirects: 0,
  },
  attribution: {
    label: "Synthetic",
    homepageUrl: "https://jobs.example.com",
    usage: "public-jobs",
    requiresAttribution: false,
  },
  refreshPolicy: {
    mode: "manual",
    minIntervalSeconds: 0,
    maxRecords: 100,
    maxPages: 5,
    requestsPerMinute: 600,
  },
};

function makeContext(options: { requests?: number; bytes?: number; signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  let remainingRequests = options.requests ?? 20;
  let remainingBytes = options.bytes ?? 512_000;
  let consumedBytes = 0;
  const ctx: SourceAdapterContext = {
    requestId: "req-1",
    signal,
    actorScope: "synthetic-user",
    observedAt: "2026-10-18T12:00:00.000Z",
    budget: { requests: remainingRequests, bytes: remainingBytes, timeoutMs: 5_000 },
    consumeRequests(count = 1) {
      if (remainingRequests < count) throw new ToolError("budget-exceeded");
      remainingRequests -= count;
    },
    consumeBytes(count) {
      if (remainingBytes < count) throw new ToolError("budget-exceeded");
      remainingBytes -= count;
      consumedBytes += count;
    },
    throwIfCancelled() {
      if (signal.aborted) throw new SourceTransportError("cancelled");
    },
  };
  return { ctx, controller, getConsumedBytes: () => consumedBytes };
}

test("transport advertises gzip, deflate, br and transparently decodes compressed payloads", async () => {
  const payload = JSON.stringify({ jobs: Array.from({ length: 10 }, (_, idx) => ({ id: idx, title: "Rust Systems Engineer" })) });
  const expectedBytes = Buffer.byteLength(payload, "utf8");
  const cases: Array<{ encoding: string; body: Buffer }> = [
    { encoding: "gzip", body: gzipSync(payload) },
    { encoding: "deflate", body: deflateSync(payload) },
    { encoding: "br", body: brotliCompressSync(payload) },
  ];

  for (const item of cases) {
    let seenAcceptEncoding = "";
    let closed = false;
    const { ctx, getConsumedBytes } = makeContext();
    const transport = createControlledSourceTransport({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      send: async ({ headers }) => {
        seenAcceptEncoding = headers["accept-encoding"] ?? "";
        return {
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": item.encoding },
          body: (async function* () {
            yield item.body.subarray(0, 12);
            yield item.body.subarray(12);
          })(),
          close: () => { closed = true; },
        };
      },
    });
    const res = await transport.request({ url: "https://jobs.example.com/v1/boards/demo/jobs", source: SOURCE, context: ctx });
    assert.equal(seenAcceptEncoding, "gzip, deflate, br");
    assert.equal(res.text, payload);
    assert.equal(getConsumedBytes(), expectedBytes);
    assert.equal(closed, true);
  }
});

test("transport rejects decompressed zip-bombs, budget overflows, wire overflows, and corrupt compressed streams", async () => {
  const bigRepeated = Buffer.from("A".repeat(4096), "utf8");
  const gzippedBomb = gzipSync(bigRepeated);
  assert.ok(gzippedBomb.byteLength < 512, "Compressed fixture should fit well below maxResponseBytes");

  // 1. Decompressed size exceeds maxResponseBytes
  let closedBomb = false;
  await assert.rejects(
    () => createControlledSourceTransport({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      maxResponseBytes: 1024,
      send: async () => ({
        status: 200,
        headers: { "content-encoding": "gzip" },
        body: (async function* () { yield gzippedBomb; })(),
        close: () => { closedBomb = true; },
      }),
    }).request({ url: "https://jobs.example.com/v1/boards/demo/jobs", source: SOURCE, context: makeContext().ctx }),
    (error: unknown) => error instanceof SourceTransportError && error.code === "response-too-large",
  );
  assert.equal(closedBomb, true);

  // 2. Decompressed size exceeds caller budget.bytes
  let closedBudget = false;
  await assert.rejects(
    () => createControlledSourceTransport({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      maxResponseBytes: 16_384,
      send: async () => ({
        status: 200,
        headers: { "content-encoding": "gzip" },
        body: (async function* () { yield gzippedBomb; })(),
        close: () => { closedBudget = true; },
      }),
    }).request({ url: "https://jobs.example.com/v1/boards/demo/jobs", source: SOURCE, context: makeContext({ bytes: 512 }).ctx }),
    (error: unknown) => error instanceof ToolError && error.code === "budget-exceeded",
  );
  assert.equal(closedBudget, true);

  // 3. Raw compressed wire bytes exceed maxResponseBytes
  let closedWire = false;
  await assert.rejects(
    () => createControlledSourceTransport({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      maxResponseBytes: 20,
      send: async () => ({
        status: 200,
        headers: { "content-encoding": "gzip" },
        body: (async function* () { yield gzippedBomb; })(),
        close: () => { closedWire = true; },
      }),
    }).request({ url: "https://jobs.example.com/v1/boards/demo/jobs", source: SOURCE, context: makeContext().ctx }),
    (error: unknown) => error instanceof SourceTransportError && error.code === "response-too-large",
  );
  assert.equal(closedWire, true);

  // 4. Corrupt compressed payload & unsupported content-encoding
  for (const [encoding, bytes] of [
    ["gzip", Buffer.from("not-valid-gzip-bytes", "utf8")],
    ["zstd", Buffer.from("{}", "utf8")],
  ] as const) {
    let closedCorrupt = false;
    await assert.rejects(
      () => createControlledSourceTransport({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        send: async () => ({
          status: 200,
          headers: { "content-encoding": encoding },
          body: (async function* () { yield bytes; })(),
          close: () => { closedCorrupt = true; },
        }),
      }).request({ url: "https://jobs.example.com/v1/boards/demo/jobs", source: SOURCE, context: makeContext().ctx }),
      (error: unknown) => error instanceof SourceTransportError && error.code === "invalid-response",
    );
    assert.equal(closedCorrupt, true);
  }
});

test("createGoogleDohResolver keeps default uncached behavior and supports opt-in TTL cache + singleflight with isolated abort", async () => {
  let nowMs = 1_000_000;
  let dohCalls = 0;
  let responseTtl = 10;

  const dohSend = async () => {
    dohCalls++;
    await new Promise((r) => setTimeout(r, 25));
    return {
      status: 200,
      headers: { "content-type": "application/dns-json" },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, TTL: responseTtl, data: dohCalls === 1 ? "93.184.216.34" : "93.184.216.35" }],
        }), "utf8");
      })(),
      close: () => {},
    };
  };

  // Default: uncached
  const uncached = createGoogleDohResolver({ send: dohSend });
  await uncached("jobs.example.com", makeContext().ctx, new AbortController().signal);
  await uncached("jobs.example.com", makeContext().ctx, new AbortController().signal);
  assert.equal(dohCalls, 2);

  // Opt-in TTL caching + singleflight + abort isolation
  dohCalls = 0;
  const cached = createGoogleDohResolver({ send: dohSend, cacheMaxTtlMs: 30_000, now: () => nowMs });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = cached("jobs.example.com", makeContext({ signal: c1.signal }).ctx, c1.signal);
  const p2 = cached("jobs.example.com", makeContext({ signal: c2.signal }).ctx, c2.signal);
  c1.abort();
  await assert.rejects(p1, (err: unknown) => err instanceof SourceTransportError && err.code === "cancelled");
  const first = await p2;
  assert.equal(first[0]?.address, "93.184.216.34");
  assert.equal(dohCalls, 1);

  // Within TTL: hits cache without extra DoH traffic
  nowMs += 5_000;
  const second = await cached("JOBS.EXAMPLE.COM", makeContext().ctx, new AbortController().signal);
  assert.equal(second[0]?.address, "93.184.216.34");
  assert.equal(dohCalls, 1);

  // Past answer TTL (10s < 30s max): expires cleanly and refreshes
  nowMs += 6_000;
  responseTtl = 0;
  const third = await cached("jobs.example.com", makeContext().ctx, new AbortController().signal);
  assert.equal(third[0]?.address, "93.184.216.35");
  assert.equal(dohCalls, 2);

  // Answer with TTL=0 must not be cached
  await cached("jobs.example.com", makeContext().ctx, new AbortController().signal);
  assert.equal(dohCalls, 3);
});
