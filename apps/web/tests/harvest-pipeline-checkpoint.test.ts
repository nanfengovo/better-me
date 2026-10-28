import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { HARVEST_PROVIDERS, type HarvestCapturedBatch, type HarvestCheckpoint, type HarvestCheckpointSnapshot, type HarvestImportReceipt, type HarvestProvider } from "../src/components/atlas/harvest-checkpoint";
import { OpportunityHarvestChainedClientPipeline } from "../src/components/atlas/harvest-pipeline";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";
import type { LiveBatchProviderResultClient } from "../src/lib/platform-search-client";
import { createHarvestJournalAdapter, type JournalStorage, type JournalTable } from "../src/components/atlas/harvest-journal-store";

const capturedAt = "2026-10-28T00:00:00.000Z";
type Client = ReturnType<typeof createAtlasSourceClient>;
const platforms = { liepin: "猎聘", "51job": "51JOB", boss: "BOSS直聘", linkedin: "LinkedIn", indeed: "Indeed", seek: "Seek", gradconnection: "GradConnection" } as const;
const pageUrls = { liepin: "https://www.liepin.com/zhaopin/?key=Rust", "51job": "https://we.51job.com/pc/search", boss: "https://www.zhipin.com/web/geek/job", linkedin: "https://www.linkedin.com/jobs/search/", indeed: "https://www.indeed.com/jobs", seek: "https://www.seek.com.au/jobs", gradconnection: "https://au.gradconnection.com/graduate-jobs/" } as const;

function result(provider: HarvestProvider = "liepin", withCard = false): LiveBatchProviderResultClient {
  const pageUrl = pageUrls[provider];
  const url = "https://www.liepin.com/job/100001.shtml";
  return { provider, platform: platforms[provider], pageUrl, status: withCard ? "ready" : "empty", rawCardCount: withCard ? 1 : 0,
    cards: withCard ? [{ platform: "猎聘", url, title: "Rust engineer", company: "Synthetic Company", cardText: "Rust engineer Synthetic Company", evidence: {
      pageUrl, cardSelector: ".card", fields: [{ field: "url", selector: "a", text: url }, { field: "title", selector: ".title", text: "Rust engineer" }, { field: "company", selector: ".company", text: "Synthetic Company" }],
    } }] : [], warnings: withCard ? ["Synthetic page budget is partial"] : [],
    coverage: { pagesVisited: 1, pageLimit: 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 500, stopReason: withCard ? "page_limit" : "exhausted", partial: withCard } };
}

function memoryCheckpoint(queryTerms = ["Rust"]) {
  const state: HarvestCheckpointSnapshot = { run: { schemaVersion: 1, id: "synthetic-run", scope: "synthetic-scope", state: "running", queryTerms, providers: [...HARVEST_PROVIDERS],
    input: { keyword: "Rust", depth: "quick", view: { mode: "global", country: "", region: "", regionText: "" } }, createdAt: capturedAt, updatedAt: capturedAt }, batches: [], providers: [] };
  const events: string[] = [];
  const checkpoint: HarvestCheckpoint = {
    id: state.run.id, read: async () => { events.push("read"); return structuredClone(state); },
    resume: async () => { state.run.state = "running"; },
    initialize: async (terms, providers) => { events.push("initialize"); assert.deepEqual(terms, state.run.queryTerms); assert.deepEqual(providers, state.run.providers); },
    capture: async value => { events.push("capture"); state.batches.push(structuredClone(value)); },
    prepare: async (id, value) => { events.push("prepare"); state.batches.find(batch => batch.id === id)!.command = structuredClone(value); },
    confirm: async (id, value) => { events.push("confirm"); state.batches.find(batch => batch.id === id)!.receipt = structuredClone(value); },
    recordProvider: async value => { events.push(`provider:${value.term}:${value.result.provider}`); const previous = state.providers.findIndex(item => item.term === value.term && item.result.provider === value.result.provider); if (previous < 0) state.providers.push(structuredClone(value)); else state.providers[previous] = structuredClone(value); },
    settle: async value => { events.push(`settle:${value}`); state.run.state = value; },
  };
  return { state, events, checkpoint };
}

function client() {
  let imports = 0;
  const service = {
    snapshot: async () => ({ ...createAtlasDemo(), revision: 2 + imports }),
    previewReviewedCards: async (input: { expectedRevision: number }) => ({ expectedRevision: input.expectedRevision, previewFingerprint: "synthetic-preview" }),
    importReviewedCards: async (): Promise<HarvestImportReceipt> => ({ ok: true, revision: 2 + ++imports, jobIds: [], snapshotIds: [], counts: {
      newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1,
    } }),
  } as unknown as Client;
  return { service, imports: () => imports };
}

function response(results: LiveBatchProviderResultClient[], streaming: boolean): Response {
  if (!streaming) return Response.json({ capturedAt, results });
  return new Response([
    ...results.map(result => ({ type: "provider-queued", provider: result.provider, platform: result.platform, pageLimit: 5, scrollLimit: 0, cardLimit: 500 })),
    ...results.map(result => ({ type: "provider-result", result })),
    { type: "complete", capturedAt, providers: results.map(result => result.provider) },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

test("recovery uses frozen terms and skips already-read providers without erasing partial warnings", async () => {
  const stored = memoryCheckpoint(["Frozen Rust"]);
  stored.state.providers.push({ term: "Frozen Rust", capturedAt, result: result("liepin", true) });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ keyword: string; providers: HarvestProvider[] }> = [];
  let restoredWarnings: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request.input);
    return response(request.input.providers.map((provider: HarvestProvider) => result(provider)), request.action.endsWith("stream"));
  };
  try {
    const summary = await new OpportunityHarvestChainedClientPipeline({ client: client().service, checkpoint: stored.checkpoint, keyword: "C#", enrichAfterCommit: false,
      onLiveResults: receipt => { restoredWarnings = receipt.results.find(value => value.provider === "liepin")?.warnings ?? []; } }).execute();
    assert.deepEqual(requests.map(request => request.keyword), ["Frozen Rust"]);
    assert.deepEqual(requests[0]!.providers, ["51job", "boss", "linkedin"]);
    assert.equal(summary.platformCoverage.find(item => item.provider === "liepin")!.coverage.partial, true);
    assert.ok(restoredWarnings.includes("Synthetic page budget is partial"));
    assert.equal(stored.state.run.state, "completed");
  } finally { globalThis.fetch = originalFetch; }
});

test("interrupted terms restore captured cards immediately and only skip their durable provider endpoints", async () => {
  const stored = memoryCheckpoint(["Rust", "Systems"]);
  const recovered = result("liepin", true);
  stored.state.providers.push({ term: "Rust", capturedAt, result: recovered });
  const captured: HarvestCapturedBatch = { id: "old-capture", provider: "liepin", platform: "猎聘", pageUrl: recovered.pageUrl, capturedAt, cards: recovered.cards };
  stored.state.batches.push(captured);
  let shownCards = 0;
  const requests: Array<{ keyword: string; providers: HarvestProvider[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(shownCards, 1, "local captured evidence must be visible before a resumed browser request");
    const request = JSON.parse(String(init?.body)); requests.push(request.input);
    return response(request.input.providers.map((provider: HarvestProvider) => result(provider)), request.action.endsWith("stream"));
  };
  const service = client();
  try {
    await new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false,
      onLiveResults: receipt => { shownCards = receipt.results.reduce((sum, value) => sum + value.cards.length, 0); } }).execute();
    assert.deepEqual(requests.map(request => [request.keyword, request.providers.includes("liepin")]), [["Rust", false], ["Systems", true]]);
    assert.equal(service.imports(), 1);
    assert.equal(stored.state.batches.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("provider completion is durable only after its cards, in SSE and JSON fallback", async () => {
  for (const streaming of [true, false]) {
    const stored = memoryCheckpoint();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return response(request.input.providers.map((provider: HarvestProvider) => result(provider, provider === "liepin")), request.action.endsWith("stream"));
    };
    try {
      await new OpportunityHarvestChainedClientPipeline({ client: client().service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false,
        ...(streaming ? { onLiveProgress() {} } : {}) }).execute();
      assert.ok(stored.events.indexOf("capture") >= 0);
      assert.ok(stored.events.indexOf("capture") < stored.events.indexOf("provider:Rust:liepin"));
      assert.equal(stored.state.batches.length, 1);
      assert.equal(stored.state.run.state, "completed");
    } finally { globalThis.fetch = originalFetch; }
  }
});

test("checkpoint capture failure aborts collection before imports and marks needs-attention", async () => {
  const stored = memoryCheckpoint();
  stored.checkpoint.capture = async () => { throw new Error("synthetic disk full"); };
  const service = client();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return response([result("liepin", true)], request.action.endsWith("stream"));
  };
  try {
    await assert.rejects(new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false }).execute(), /检查点.*synthetic disk full/);
    assert.equal(service.imports(), 0);
    assert.equal(stored.state.providers.length, 0);
    assert.equal(stored.state.run.state, "needs-attention");
  } finally { globalThis.fetch = originalFetch; }
});

test("aborting a run preserves its durable checkpoint without settling it completed or cancelled", async () => {
  const stored = memoryCheckpoint();
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { controller.abort(new Error("synthetic refresh")); throw controller.signal.reason; };
  try {
    await assert.rejects(new OpportunityHarvestChainedClientPipeline({ client: client().service, checkpoint: stored.checkpoint, keyword: "Rust", signal: controller.signal, enrichAfterCommit: false }).execute(), /synthetic refresh/);
    assert.equal(stored.events.some(event => event.startsWith("settle:")), false);
    assert.equal(stored.state.run.state, "running");
  } finally { globalThis.fetch = originalFetch; }
});

test("all durable exhausted-empty providers finish recovery without opening another search", async () => {
  const stored = memoryCheckpoint();
  stored.state.providers = HARVEST_PROVIDERS.map(provider => ({ term: "Rust", capturedAt, result: result(provider) }));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not search again"); };
  try {
    const summary = await new OpportunityHarvestChainedClientPipeline({ client: client().service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false }).execute();
    assert.equal(requests, 0);
    assert.equal(summary.totalCardsFetched, 0);
    assert.equal(stored.state.run.state, "completed");
  } finally { globalThis.fetch = originalFetch; }
});

test("captured pages without a provider-result are restored visibly but never treated as terminal", async () => {
  const stored = memoryCheckpoint();
  const recovered = result("liepin", true);
  stored.state.batches = [{ id: "page-without-terminal", provider: "liepin", platform: "猎聘", capturedAt, pageUrl: recovered.pageUrl, cards: recovered.cards }];
  let firstReceipt: LiveBatchProviderResultClient | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(firstReceipt?.cards.length, 1);
    assert.equal(firstReceipt?.coverage.partial, true);
    assert.match(firstReceipt!.warnings.join(" "), /不恢复虚拟列表滚动位置/);
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.input.providers, HARVEST_PROVIDERS);
    return response(request.input.providers.map((provider: HarvestProvider) => result(provider)), request.action.endsWith("stream"));
  };
  const service = client();
  try {
    const summary = await new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false,
      onLiveResults: receipt => { firstReceipt ??= receipt.results.find(value => value.provider === "liepin"); } }).execute();
    assert.equal(summary.totalCardsFetched, 1);
    assert.equal(service.imports(), 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("an unreadable checkpoint fails closed without querying platforms or the index", async () => {
  const stored = memoryCheckpoint();
  stored.checkpoint.read = async () => { throw new Error("synthetic corrupt journal"); };
  const service = client();
  let snapshots = 0, requests = 0;
  service.service.snapshot = async () => { snapshots++; return createAtlasDemo(); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error("must not search"); };
  try {
    await assert.rejects(new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false }).execute(), /检查点.*synthetic corrupt journal/);
    assert.equal(snapshots, 0);
    assert.equal(requests, 0);
    assert.equal(stored.state.run.state, "needs-attention");
  } finally { globalThis.fetch = originalFetch; }
});

test("error, gate and no-progress receipts stay resumable instead of claiming completed coverage", async () => {
  for (const stopReason of ["error", "gate", "no_progress"] as const) {
    const stored = memoryCheckpoint();
    const incomplete = { ...result("liepin", true), coverage: { ...result("liepin", true).coverage, stopReason, partial: true } };
    stored.state.providers.push({ term: "Rust", capturedAt, result: incomplete });
    const originalFetch = globalThis.fetch;
    let queried = false;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)); queried = request.input.providers.includes("liepin");
      return response([incomplete, ...HARVEST_PROVIDERS.filter(provider => provider !== "liepin").map(provider => result(provider))], request.action.endsWith("stream"));
    };
    try {
      await new OpportunityHarvestChainedClientPipeline({ client: client().service, checkpoint: stored.checkpoint, keyword: "Rust", enrichAfterCommit: false }).execute();
      assert.equal(queried, true);
      assert.equal(stored.state.run.state, "needs-attention");
    } finally { globalThis.fetch = originalFetch; }
  }
});

test("the real journal completes SSE recovery when provider and complete timestamps differ", async () => {
  let tables: Record<JournalTable, Map<string, { id: string }>> = { runs: new Map(), batches: new Map(), providers: new Map() };
  let tail = Promise.resolve();
  const storage: JournalStorage = { close() {}, transaction(mode, work) {
    const task = tail.then(async () => {
      const copy = structuredClone(tables);
      const value = await work({
        async get(table, id) { return structuredClone(copy[table].get(id)); },
        async list(table, filter) { return structuredClone([...copy[table].values()].filter(row => !filter || Reflect.get(row, filter.index) === filter.value)); },
        async put(table, row) { copy[table].set(row.id, structuredClone(row)); },
        async delete(table, id) { copy[table].delete(id); },
      });
      if (mode === "readwrite") tables = copy;
      return value;
    });
    tail = task.then(() => {}, () => {});
    return task;
  } };
  const journal = createHarvestJournalAdapter(storage, "a".repeat(64));
  const checkpoint = await journal.create({ keyword: "Rust", depth: "quick", view: { mode: "global", country: "", region: "", regionText: "" } });
  await checkpoint.initialize(["Rust"], HARVEST_PROVIDERS);
  await checkpoint.recordProvider({ term: "Rust", capturedAt, result: { ...result("liepin", true), coverage: { ...result("liepin", true).coverage, stopReason: "no_progress" } } });
  const service = client();
  service.service.previewReviewedCards = async input => ({ expectedRevision: input.expectedRevision, previewFingerprint: "b".repeat(64) }) as Awaited<ReturnType<Client["previewReviewedCards"]>>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.input.providers, HARVEST_PROVIDERS, "the old nonterminal provider must be retried");
    return response(request.input.providers.map((provider: HarvestProvider) => result(provider, provider === "liepin")), true);
  };
  try {
    await new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint, keyword: "Rust", enrichAfterCommit: false, onLiveProgress() {} }).execute();
    const persisted = await checkpoint.read();
    assert.equal(persisted.run.state, "completed");
    assert.equal(persisted.providers.length, 4);
    assert.equal(persisted.providers.find(value => value.result.provider === "liepin")!.result.coverage.stopReason, "page_limit");
    assert.notEqual(persisted.providers[0]!.capturedAt, capturedAt, "keep the first durable provider timestamp, not the later complete receipt's timestamp");
    assert.equal(persisted.batches[0]!.receipt?.counts.newJobs, 1);
    assert.equal(service.imports(), 1);
  } finally { globalThis.fetch = originalFetch; journal.close(); }
});

test("a checkpoint write failure aborts a quiet collection stream without mislabeling it as user cancellation", async () => {
  const stored = memoryCheckpoint();
  stored.checkpoint.prepare = async () => { throw new Error("synthetic durable storage failure"); };
  const caller = new AbortController();
  const service = client();
  const originalFetch = globalThis.fetch;
  let networkAborted = false;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const abort = () => { networkAborted = true; controller.error(init!.signal!.reason); };
    init!.signal!.addEventListener("abort", abort, { once: true });
    const cards = result("liepin", true).cards;
    const events = [{ type: "provider-queued", provider: "liepin", platform: "猎聘", pageLimit: 5, scrollLimit: 0, cardLimit: 500 },
      { type: "provider-progress", provider: "liepin", platform: "猎聘", pagesVisited: 1, scrollSteps: 0, cardsCaptured: 1, pageLimit: 5, scrollLimit: 0, cardLimit: 500, cards }];
    controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    // No more platform events: only abort can unblock this synthetic stream.
  } }));
  let outcome = "pending";
  const running = new OpportunityHarvestChainedClientPipeline({ client: service.service, checkpoint: stored.checkpoint, keyword: "Rust", signal: caller.signal, enrichAfterCommit: false, onLiveProgress() {} }).execute()
    .then(() => { outcome = "completed"; }, error => { outcome = error.message; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(outcome, /检查点.*synthetic durable storage failure/);
    assert.equal(networkAborted, true);
    assert.equal(caller.signal.aborted, false);
    assert.equal(stored.state.run.state, "needs-attention");
    assert.equal(service.imports(), 0);
  } finally { caller.abort(new Error("synthetic test cleanup")); await running; globalThis.fetch = originalFetch; }
});
