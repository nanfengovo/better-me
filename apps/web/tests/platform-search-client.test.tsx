import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { buildPlatformSearchRequest } from "@better-me/source-adapters/browser-contracts";
import { readPlatformSearch, runLivePlatformBatchSearch, startPlatformSearch } from "../src/lib/platform-search-client.ts";
import { createJdStartRequestId } from "../src/lib/jd-start-request.ts";

const input = { provider: "liepin", keyword: "C#", regionId: "cn-shanghai" } as const;
const plan = buildPlatformSearchRequest(input);
const session = { sessionId: "synthetic-search-session-1234", platform: plan.platform, url: plan.url, expiresAt: "2026-10-18T18:00:00Z" };
const card = { platform: "猎聘", title: "Synthetic engineer", url: "https://www.liepin.com/job/1999999999.shtml", company: "Synthetic employer", cardText: "Synthetic list excerpt", evidence: { pageUrl: plan.url, cardSelector: ".job-card-pc-container", fields: [] } };
const receipt = () => ({ status: "ready", platform: "猎聘", url: plan.url, cards: [card], partial: true, warnings: ["Single page only"], capturedAt: "2026-10-18T17:00:00Z" });
afterEach(() => mock.restoreAll());

test("platform client preserves exact search input and validates the returned session", async () => {
  const calls: unknown[] = [];
  const requestId = createJdStartRequestId();
  mock.method(globalThis, "fetch", async (url, options) => { assert.equal(url, "/api/jd/search-session"); calls.push(JSON.parse(String(options.body))); return Response.json(session); });
  assert.deepEqual(await startPlatformSearch(input, undefined, requestId), session);
  assert.deepEqual(calls, [{ action: "start", input, requestId }]);
});

test("list receipt keeps excerpt and publication unknown without substituting captured time", async () => {
  mock.method(globalThis, "fetch", async () => Response.json(receipt()));
  const found = await readPlatformSearch(session);
  assert.equal(found.cards[0]!.publicationText, undefined);
  assert.equal(found.capturedAt, "2026-10-18T17:00:00Z");
  assert.equal(found.partial, true);
});

test("client rejects changed region, cross-platform cards, duplicates and false empty status", async () => {
  for (const value of [
    { ...receipt(), url: plan.url.replace("dq=020", "dq=010").replace("city=020", "city=010") },
    { ...receipt(), cards: [{ ...card, url: "https://www.zhipin.com/job_detail/synthetic.html" }] },
    { ...receipt(), cards: [card, card] },
    { ...receipt(), status: "empty" },
    { ...receipt(), cards: [] },
  ]) {
    const fetcher = mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(readPlatformSearch(session)); fetcher.mock.restore();
  }
});

test("blocked and unavailable service outcomes are not converted into zero jobs", async () => {
  let value: unknown = { ...receipt(), status: "verification_required", cards: [] };
  mock.method(globalThis, "fetch", async () => Response.json(value));
  assert.equal((await readPlatformSearch(session)).status, "verification_required");
  value = { error: "Needs update", failure: { code: "service_unavailable", stage: "service", message: "Needs update" } };
  await assert.rejects(readPlatformSearch(session), /Needs update/);
});

test("live batch returns validated coverage and does not turn transport or schema errors into empty results", async () => {
  const coverage = { pagesVisited: 12, scrollSteps: 0, scrollLimit: 60, pageLimit: 15, cardLimit: 1500, stopReason: "page_limit", partial: true };
  const live = {
    capturedAt: "2026-10-25T12:00:00Z",
    results: [{ provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=Java", status: "empty", cards: [], rawCardCount: 0, warnings: [], coverage }],
  };
  mock.method(globalThis, "fetch", async () => Response.json(live));
  const parsed = await runLivePlatformBatchSearch({ keyword: "Java", providers: ["liepin"] });
  assert.equal(parsed.results[0]!.coverage.pagesVisited, 12);
  assert.equal(parsed.results[0]!.coverage.partial, true);

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => Response.json({ capturedAt: live.capturedAt, results: [{ ...live.results[0], coverage: undefined }] }));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Java", providers: ["liepin"] }), /缺少有效结果或覆盖信息/);

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => Response.json({
    ...live,
    results: [{ ...live.results[0], status: "empty", cards: [card] }],
  }));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Java", providers: ["liepin"] }), /缺少有效结果或覆盖信息/);

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => { throw new Error("synthetic offline"); });
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Java", providers: ["liepin"] }), /无法连接本机搜索工具/);
});

test("live batch SSE reports provider progress, accepts large split events, and requires every final provider receipt", async () => {
  const coverage = { pagesVisited: 2, scrollSteps: 0, scrollLimit: 0, pageLimit: 5, cardLimit: 500, stopReason: "page_limit", partial: true };
  const providerResult = {
    provider: "liepin", platform: "猎聘", pageUrl: "https://www.liepin.com/zhaopin/?key=Rust", status: "ready",
    cards: [{ ...card, company: "Synthetic employer" }], rawCardCount: 1,
    warnings: Array.from({ length: 80 }, () => "实时覆盖说明".repeat(100)), coverage,
  };
  const queue = { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 };
  const start = { ...queue, type: "provider-start" };
  const progress = { type: "provider-progress", provider: "liepin", platform: "猎聘", pagesVisited: 2, scrollSteps: 0, cardsCaptured: 1, pageLimit: 5, scrollLimit: 0, cardLimit: 500, cards: [card] };
  const events = [queue, start, progress, { type: "provider-result", result: providerResult }];
  const streamText = `${events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: ${JSON.stringify({ type: "complete", capturedAt: "2026-10-25T12:00:00Z", providers: ["liepin"] })}\r\n\r\n`;
  assert.ok(new TextEncoder().encode(JSON.stringify(events[3])).byteLength > 64_000, "fixture exercises a legal result event larger than the old 64 KB cap");
  const encoded = new TextEncoder().encode(streamText);
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Split the protocol at arbitrary UTF-8 byte boundaries and across CRLF delimiters.
      for (let offset = 0; offset < encoded.length;) {
        const size = Math.min((offset % 97) + 1, encoded.length - offset);
        controller.enqueue(encoded.slice(offset, offset + size));
        offset += size;
      }
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  const observed: string[] = [];
  const result = await runLivePlatformBatchSearch({ keyword: "Rust", providers: ["liepin"] }, undefined, {
    onEvent(event) {
      observed.push(event.type);
      if (event.type === "provider-progress") {
        assert.equal(event.cards?.length, 1);
        assert.equal(event.cards?.[0]?.evidence.pageUrl, card.evidence.pageUrl);
      }
    },
  });
  assert.deepEqual(observed, ["provider-queued", "provider-start", "provider-progress", "provider-result"]);
  assert.equal(result.results[0]!.cards.length, 1);
  assert.equal(JSON.parse(String(fetcher.mock.calls[0]!.arguments[1]?.body)).action, "live-batch-search-stream");

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify({ type: "provider-result", result: providerResult })}\n\n`));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust", providers: ["liepin"] }, undefined, { onEvent() {} }), /没有最终回执|缺少平台最终回执/);

  mock.restoreAll();
  const invalidProgress = { ...progress, cards: Array.from({ length: 51 }, () => card) };
  mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify({ ...invalidProgress, type: "provider-progress" })}\n\n`));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust", providers: ["liepin"] }, undefined, { onEvent() {} }), /实时搜索平台进度无效/);
});

test("SSE dispatch awaits an async consumer before delivering the next event", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const queue = { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 };
  const observed: string[] = [];
  mock.method(globalThis, "fetch", async () => new Response([queue, { ...queue, type: "provider-start" }].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
  const running = assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust" }, undefined, { onEvent: async event => {
    observed.push(event.type);
    if (event.type === "provider-queued") await held;
  } }), /没有最终回执/);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(observed, ["provider-queued"]);
  } finally { release(); await running; }
  assert.deepEqual(observed, ["provider-queued", "provider-start"]);
});

test("SSE cancellation does not dispatch an unterminated tail after an awaited callback", async () => {
  const abort = new AbortController();
  const queue = { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 };
  const observed: string[] = [];
  mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify(queue)}\n\ndata: ${JSON.stringify({ ...queue, type: "provider-start" })}`));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust" }, abort.signal, { onEvent: async event => {
    observed.push(event.type);
    abort.abort(new Error("synthetic stream cancelled"));
  } }), /synthetic stream cancelled/);
  assert.deepEqual(observed, ["provider-queued"]);
});

test("resumed SSE subsets validate the explicitly requested providers rather than requiring queued status events", async () => {
  const providers = ["51job", "boss", "linkedin"] as const;
  const platforms = { "51job": "51JOB", boss: "BOSS直聘", linkedin: "LinkedIn" } as const;
  const results = providers.map(provider => ({ provider, platform: platforms[provider], pageUrl: "https://www.linkedin.com/jobs/search/", status: "empty", cards: [], rawCardCount: 0, warnings: [],
    coverage: { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: "exhausted", partial: false } }));
  const encode = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  mock.method(globalThis, "fetch", async () => encode([...results.map(result => ({ type: "provider-result", result })),
    { type: "complete", capturedAt: "2026-10-28T00:00:00Z", providers }]));
  const receipt = await runLivePlatformBatchSearch({ keyword: "Rust", providers: [...providers] }, undefined, { onEvent() {} });
  assert.deepEqual(receipt.results.map(result => result.provider), providers);

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => encode([{ type: "provider-result", result: results[0] },
    { type: "complete", capturedAt: "2026-10-28T00:00:00Z", providers: ["51job"] }]));
  await assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust", providers: [...providers] }, undefined, { onEvent() {} }), /缺少平台最终回执/);
});

test("explicit SSE subsets reject unrequested queued, progress and result events before dispatch", async () => {
  const queued = { type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 };
  const progress = { ...queued, type: "provider-progress", pagesVisited: 1, scrollSteps: 0, cardsCaptured: 0 };
  const result = { type: "provider-result", result: { provider: "liepin", platform: "猎聘", pageUrl: plan.url, status: "empty", cards: [], rawCardCount: 0, warnings: [],
    coverage: { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: "exhausted", partial: false } } };
  for (const event of [queued, progress, result]) {
    let dispatched = false;
    const fetcher = mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify(event)}\n\n`));
    await assert.rejects(runLivePlatformBatchSearch({ keyword: "Rust", providers: ["linkedin"] }, undefined, { onEvent() { dispatched = true; } }), /未请求的平台/);
    assert.equal(dispatched, false);
    fetcher.mock.restore();
  }
});
