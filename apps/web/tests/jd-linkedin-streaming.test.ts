import assert from "node:assert/strict";
import test from "node:test";
import { fetchLinkedInDirect } from "../server/jd-live-batch-search";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const html = (id: number) => `<li class="base-search-card"><a class="base-search-card__full-link" href="https://www.linkedin.com/jobs/view/${id}/"><h3 class="base-search-card__title">Software Engineer</h3></a><span class="base-search-card__subtitle">Synthetic Company</span></li>`;
const plan = { provider: "linkedin" as const, platform: "LinkedIn" as const, url: "https://www.linkedin.com/jobs/search/?keywords=software" };

test("LinkedIn parses and emits a successful page before another page response arrives", async () => {
  const releaseSecond = deferred(), secondStarted = deferred();
  const cardBatches: number[] = [];
  let requests = 0;
  const running = fetchLinkedInDirect(plan, "software", undefined, "quick", 2,
    event => { if (event.cards?.length) cardBatches.push(event.cards.length); },
    [async () => {
      if (++requests === 2) { secondStarted.resolve(); await releaseSecond.promise; }
      return new Response(html(requests === 1 ? 123456 : 123457));
    }]);
  try {
    await secondStarted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(cardBatches, [1], "one slow response must not hold already fetched page cards");
  } finally { releaseSecond.resolve(); await running; }
});

test("a failed LinkedIn response body does not discard another page's validated cards", async () => {
  let requests = 0;
  const result = await fetchLinkedInDirect(plan, "software", undefined, "quick", 2, undefined,
    [async () => ++requests === 1 ? new Response(html(123456)) : new Response(new ReadableStream({
      start(controller) { controller.error(new Error("synthetic truncated page body")); },
    }))]);
  assert.equal(result.status, "ready");
  assert.equal(result.cards.length, 1);
  assert.equal(result.coverage.pagesVisited, 1);
  assert.equal(result.coverage.stopReason, "error");
  assert.equal(result.coverage.partial, true);
  assert.match(result.warnings.join(" "), /1\/2 个分页请求未成功/);
});

test("LinkedIn concurrent page completion keeps final receipt page ordering deterministic", async () => {
  const releaseFirst = deferred(), secondPublished = deferred();
  const cardUrls: string[] = [];
  let requests = 0;
  const running = fetchLinkedInDirect(plan, "software", undefined, "quick", 2,
    event => {
      cardUrls.push(...(event.cards ?? []).map(card => card.url));
      if (event.cards?.some(card => card.url.includes("123457"))) secondPublished.resolve();
    },
    [async () => {
      const index = requests++;
      if (index === 0) await releaseFirst.promise;
      return new Response(html(123456 + index));
    }]);
  await secondPublished.promise;
  assert.match(cardUrls[0]!, /123457/);
  releaseFirst.resolve();
  const result = await running;
  assert.match(result.cards[0]!.url, /123456/);
  assert.match(result.cards[1]!.url, /123457/);
});

test("LinkedIn cancellation stops new page scheduling and reports partial coverage", async () => {
  const abort = new AbortController(), release = deferred(), firstPublished = deferred();
  let requests = 0;
  const running = fetchLinkedInDirect(plan, "software", abort.signal, "standard", 8,
    event => { if (event.cards?.length && !abort.signal.aborted) { abort.abort(); firstPublished.resolve(); } },
    [async () => {
      const index = requests++;
      if (index > 0) await release.promise;
      return new Response(html(123456 + index));
    }]);
  await firstPublished.promise;
  release.resolve();
  const result = await running;
  assert.equal(requests, 4, "only the initially concurrent requests can already be in flight");
  assert.equal(result.coverage.stopReason, "cancelled");
  assert.equal(result.coverage.partial, true);
});
