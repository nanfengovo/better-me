import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLAnchorElement } from "happy-dom";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters/browser-contracts";
import type { AtlasSourceCandidateReviewProps } from "../src/components/atlas/AtlasSourceCandidateReview.tsx";
import type { AtlasSourcePreview } from "../src/components/atlas/service-client.ts";
import type { OpportunitySeed } from "../src/components/OpportunityWorkspace.tsx";

const dom = new Window({ url: "http://atlas-candidate-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { source: "export {};", format: "module", shortCircuit: true };
  return nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasSourceCandidateReview } = await import("../src/components/atlas/AtlasSourceCandidateReview.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const source = { ...SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]),
  enabled: true, status: "active" as const };
const at = "2026-10-19T02:03:04.000Z";
const scope = { roles: ["C#"], regions: ["深圳"], companyNames: [] };
function fixture(): AtlasSourceCandidateReviewProps {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-candidate-token", source: structuredClone(source),
    request: { scope: structuredClone(scope), maxRecords: 40, maxPages: 20 }, onClose: () => {} };
}
function record(id: string, overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: id, url: `https://jobs.example.invalid/${id}`, title: `Synthetic ${id}`,
    companyName: "Synthetic Employer", description: "Requirements not read", locations: [{ raw: "深圳 · 南山区", countryCode: "CN" }],
    compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown",
    completeness: "excerpt", evidence: [], warnings: [], sourcePublishedRaw: "昨天", ...overrides };
}
function preview(records: SourceJobRecord[], localFilters = scope): AtlasSourcePreview {
  return { page: { records, observedAt: at, coverage: { complete: false, partial: true, fetchedRecords: records.length,
    appliedFilters: [], ignoredFilters: ["roles", "regions", "companyNames"] }, stopReason: "page-limit", warnings: ["Synthetic limited coverage"] },
    localMatchedRecords: 999, localFilters };
}
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-candidate-request", value }));
async function render(props: AtlasSourceCandidateReviewProps) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasSourceCandidateReview, props)));
  return dom.document.querySelector(".atlas-source-review")!;
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button: ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
const readLabel = "重新预览一页 · 不写入";
const titles = () => [...dom.document.querySelectorAll(".atlas-source-review-card h3")].map((node) => node.textContent);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.innerHTML = "";
});
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("mount and configuration changes are inert; an explicit preview reads only one page with no sync or idempotent write", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(url), init }); return response(preview([])); });
  const props = fixture(); await render(props); assert.equal(requests.length, 0);
  let boundScope = dom.document.querySelector('[aria-label="本次预览绑定条件"]')!;
  assert.deepEqual([...boundScope.querySelectorAll("dd")].map((node) => node.textContent), ["C#", "全部", "深圳"]);
  assert.equal(dom.document.body.textContent!.includes(props.token), false);
  await render({ ...props, token: "another-synthetic-token" }); assert.equal(requests.length, 0);
  await click(readLabel); assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).pathname, `/api/v1/sources/${source.sourceId}/preview`);
  assert.equal(requests[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), { scope, maxRecords: 40 });
  assert.equal(new Headers(requests[0]!.init?.headers).has("Idempotency-Key"), false);
  assert.match(dom.document.body.textContent!, /本次重新读取时间/); assert.equal(dom.document.querySelector("time")?.dateTime, at);
  assert.match(dom.document.body.textContent!, /本页没有返回记录，不代表来源没有相关岗位/);
  await render({ ...props, request: { scope: { roles: ["Java"], companyNames: ["Synthetic Company"], regions: [], countryCodes: ["CN"] } } });
  boundScope = dom.document.querySelector('[aria-label="本次预览绑定条件"]')!;
  assert.deepEqual([...boundScope.querySelectorAll("dd")].map((node) => node.textContent), ["Java", "Synthetic Company", "全部", "CN"]);
  assert.equal(dom.document.querySelector(".atlas-source-review-result"), null); assert.equal(requests.length, 1);
  await render({ ...props, request: {} });
  assert.deepEqual([...dom.document.querySelectorAll(".atlas-source-review-scope dd")].map((node) => node.textContent), ["全部", "全部", "全部"]);
  assert.equal(requests.length, 1);
});

test("shared matching keeps unknown excerpts unresolved and sorts them before matches and exclusions with exact filter counts", async () => {
  const matched = record("matching", { title: "C# 工程师" });
  const unknown = record("unread");
  const excluded = record("full-non-match", { completeness: "detail", description: "Only Java required" });
  const otherOffice = record("other-office", { title: "C# Engineer", locations: [{ raw: "上海", countryCode: "CN" }] });
  const data = preview([matched, excluded, unknown, otherOffice]); const before = structuredClone(data);
  mock.method(globalThis, "fetch", async () => response(data));
  await render(fixture()); await click(readLabel);
  assert.deepEqual(titles(), [unknown.title, matched.title, excluded.title, otherOffice.title]);
  assert.equal(dom.document.querySelectorAll('[data-match-status="unknown"]').length, 1);
  assert.equal(dom.document.querySelectorAll('[data-match-status="matched"]').length, 1);
  assert.match(dom.document.querySelector('[data-match-status="unknown"]')!.textContent!, /不能据摘录确认命中或判定不匹配/);
  await click("待核对 1"); assert.deepEqual(titles(), [unknown.title]);
  await click("已读字段命中 1"); assert.deepEqual(titles(), [matched.title]);
  await click("本次条件排除 2"); assert.deepEqual(titles(), [excluded.title, otherOffice.title]);
  assert.equal(dom.document.body.textContent!.includes("999"), false, "server aggregate match counts cannot reclassify unknown records");
  assert.deepEqual(data, before);
});

test("all records on the returned page remain reviewable; source text is collapsed plain text and original links retain safe navigation", async () => {
  const markup = '<script>window.stolen=true</script><img src=x onerror="bad()">';
  const records = Array.from({ length: 24 }, (_, index) => record(`page-${index}`, index === 1 ? { sourcePublishedRaw: undefined, sourcePublishedAt: "2026-10-18T00:00:00Z" } : index ? {} : { description: markup }));
  mock.method(globalThis, "fetch", async () => response(preview(records)));
  await render(fixture()); await click(readLabel);
  assert.equal(dom.document.querySelectorAll(".atlas-source-review-card").length, 24);
  const first = dom.document.querySelector(".atlas-source-review-card")!;
  assert.equal(first.querySelector("details")!.open, false);
  assert.equal(first.querySelector(".atlas-source-review-description")!.textContent, markup);
  assert.equal(first.querySelector("script,img"), null);
  const original = first.querySelector<HTMLAnchorElement>("a")!;
  assert.equal(original.href, records[0]!.url); assert.equal(original.target, "_blank"); assert.equal(original.rel, "noopener noreferrer");
  assert.match(first.textContent!, /深圳 · 南山区/); assert.match(first.textContent!, /昨天/); assert.match(first.textContent!, /来源摘录/);
  const parsedOnly = dom.document.querySelectorAll(".atlas-source-review-card")[1]!;
  assert.match(parsedOnly.textContent!, /发布时间原文：未披露/); assert.match(parsedOnly.textContent!, /已解析发布时间：2026-10-18T00:00:00Z/);
});

test("an unresolved record can only explicitly prefill an opportunity draft and never triggers another request or index mutation", async () => {
  const seedCalls: OpportunitySeed[] = []; const props = fixture(); props.onReview = (seed) => { seedCalls.push(seed); };
  const unknown = record("unread", { description: "Not yet a complete requirement", sourcePublishedAt: "2026-10-18T00:00:00Z" });
  const original = structuredClone(unknown);
  const fetcher = mock.method(globalThis, "fetch", async () => response(preview([unknown])));
  await render(props); await click(readLabel); assert.equal(seedCalls.length, 0);
  await click("核对后预填机会"); assert.equal(seedCalls.length, 1); assert.equal(fetcher.mock.callCount(), 1);
  const seed = seedCalls[0]!;
  assert.ok(seed.token); assert.equal(seed.description, unknown.description); assert.equal(seed.sourceUrl, unknown.url);
  assert.equal(seed.sourcePlatform, source.attribution.label); assert.equal(seed.collectedAt, at);
  assert.equal(seed.sourcePublishedAt, unknown.sourcePublishedAt); assert.equal(seed.sourcePublishedText, "昨天");
  assert.deepEqual(unknown, original); assert.equal(dom.document.querySelector("[data-match-status]")?.getAttribute("data-match-status"), "unknown");
  await render({ ...props, onReview: undefined }); assert.equal(dom.document.querySelector(".atlas-source-review-card-actions button"), null);
});

test("cancellation stops waiting immediately and a late old response cannot replace a later explicit preview", async () => {
  const old = deferred<Response>(); let signal: AbortSignal | undefined; let calls = 0;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++; if (calls === 1) { signal = init?.signal as AbortSignal; return old.promise; }
    return response(preview([record("current")]));
  });
  await render(fixture()); await click(readLabel); assert.equal(signal?.aborted, false);
  await click("取消预览"); assert.equal(signal?.aborted, true); assert.equal(button(readLabel).disabled, false);
  await click(readLabel); assert.deepEqual(titles(), ["Synthetic current"]);
  await act(async () => old.resolve(response(preview([record("stale")]))));
  assert.deepEqual(titles(), ["Synthetic current"]);
});

test("source, request, endpoint and token changes abort old reads, hide their results and never start an automatic replacement", async () => {
  const changes = [
    (props: AtlasSourceCandidateReviewProps) => ({ ...props, source: { ...props.source, sourceId: "synthetic-next-source" } }),
    (props: AtlasSourceCandidateReviewProps) => ({ ...props, request: { ...props.request, scope: { ...scope, roles: ["C++"] } } }),
    (props: AtlasSourceCandidateReviewProps) => ({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasSourceCandidateReviewProps) => ({ ...props, token: "synthetic-changed-token" }),
  ];
  for (const change of changes) {
    const old = deferred<Response>(); let signal: AbortSignal | undefined;
    const fetcher = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return old.promise; });
    const props = fixture(); await render(props); await click(readLabel); assert.equal(fetcher.mock.callCount(), 1);
    await render(change(props)); assert.equal(signal?.aborted, true); assert.equal(fetcher.mock.callCount(), 1);
    await act(async () => old.resolve(response(preview([record("stale-binding")])))); assert.deepEqual(titles(), []);
    await act(async () => root!.unmount()); root = undefined; mock.restoreAll();
  }
});

test("close and unmount abort in-flight reads and ignore transport responses that arrive afterwards", async () => {
  for (const action of ["close", "unmount"]) {
    const old = deferred<Response>(); let signal: AbortSignal | undefined; let closes = 0;
    mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return old.promise; });
    const props = fixture(); props.onClose = () => { closes++; }; await render(props); await click(readLabel);
    if (action === "close") await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭候选核对"]')!.click());
    else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); assert.equal(closes, action === "close" ? 1 : 0);
    await act(async () => old.resolve(response(preview([record("late-after-close")])))); assert.deepEqual(titles(), []);
    if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll();
  }
});

test("a stalled preview has a real 60-second deadline and a timeout cannot adopt a late record", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const old = deferred<Response>(); let signal: AbortSignal | undefined;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return old.promise; });
  await render(fixture()); await click(readLabel);
  await act(async () => mock.timers.tick(59_999)); assert.equal(signal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(signal?.aborted, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /超过 60 秒/); assert.equal(button(readLabel).disabled, false);
  await act(async () => old.resolve(response(preview([record("late-after-timeout")])))); assert.deepEqual(titles(), []);
});

test("invalid original URL or response scope never exposes an unsafe link or an unrelated result", async () => {
  let invalidScope = false;
  mock.method(globalThis, "fetch", async () => response(invalidScope ? preview([record("wrong-scope")], { ...scope, roles: ["Java"] })
    : preview([record("unsafe", { url: "javascript:alert(1)" })])));
  await render(fixture()); await click(readLabel);
  assert.equal(dom.document.querySelector(".atlas-source-review-card a"), null); assert.deepEqual(titles(), []);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /不符合来源工具契约/);
  invalidScope = true; await click(readLabel);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /预览条件与本次请求不一致/); assert.deepEqual(titles(), []);
});


test("default backend permits an explicit candidate preview without a browser token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(preview([])); });
  await render({ ...fixture(), endpoint: "/api/atlas", token: "" }); assert.equal(calls.length, 0);
  assert.equal(button(readLabel).disabled, false); await click(readLabel);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.url, `${dom.location.origin}/api/atlas/api/v1/sources/${source.sourceId}/preview`);
  assert.equal(new Headers(calls[0]!.init?.headers).has("Authorization"), false);
});
