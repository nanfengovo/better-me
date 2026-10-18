import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement } from "happy-dom";
import type { AtlasDataset } from "@better-me/opportunities";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture, type ReviewedCardsPreview } from "@better-me/source-adapters/browser-contracts";
import type { AtlasReviewedCardImportProps } from "../src/components/atlas/AtlasReviewedCardImport.tsx";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const dom = new Window({ url: "http://reviewed-card-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasReviewedCardImport } = await import("../src/components/atlas/AtlasReviewedCardImport.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-10-19T12:00:00.000Z";
const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23&city=020";
const previewPath = "/api/v1/jobs/reviewed-cards/preview";
const importPath = "/api/v1/jobs/reviewed-cards/import";
const snapshotPath = "/api/v1/dataset/export";
const previewLabel = "预览入库变化";
const importLabel = "确认加入统一索引";
const retryLabel = "重试本次写入 · 核对回执";
const snapshot = { ...createAtlasDemo(), revision: 12 };
const receipt = { ok: true, revision: 12, jobIds: ["synthetic-reviewed-job"], snapshotIds: ["synthetic-reviewed-snapshot"],
  counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1 } };

function capture(id = "1234567890"): ReviewedCardsCapture {
  const url = `https://www.liepin.com/job/${id}.shtml`, title = `Synthetic C# Engineer ${id}`, company = "Synthetic Employer";
  return ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl, capturedAt: at, cards: [{
    platform: "猎聘", url, title, company, cardText: `${title} ${company} 卡片可见摘要，没有读取完整任职要求。`,
    evidence: { pageUrl, cardSelector: ".job-card-pc-container", fields: [
      { field: "url", selector: "a[href]", text: url }, { field: "title", selector: ".job-title", text: title },
      { field: "company", selector: ".company-name", text: company },
    ] },
  }] });
}
function preview(value = capture(), revision = 11): ReviewedCardsPreview {
  return { expectedRevision: revision, previewFingerprint: "a".repeat(64), sourceId: "synthetic-reviewed-source", completeness: "excerpt", availability: "unknown",
    cards: value.cards.map(card => ({ jobId: "synthetic-reviewed-job", listingId: "synthetic-reviewed-listing", url: card.url, title: card.title, company: card.company, existing: false })),
    warnings: ["Synthetic card excerpt only; vacancy, salary and location remain unverified."] };
}
function fixture(): AtlasReviewedCardImportProps {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-review-token", capture: capture(), revision: 11, onClose: () => {}, onSnapshot: () => {} };
}
type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-reviewed-request", value }));
function installFetch(handler?: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, init, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call);
    if (handler) return handler(call, calls);
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    if (call.path === snapshotPath) return response(snapshot);
    throw new Error(`Unexpected synthetic route: ${call.path}`);
  });
  return calls;
}
async function render(props: AtlasReviewedCardImportProps) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasReviewedCardImport, props)));
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button: ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function confirm() {
  const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(checkbox);
  await act(async () => checkbox.click());
}
async function close() { await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭卡片入库核对"]')!.click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren();
});
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("mount and configuration changes are inert; unknown fields stay unknown and original excerpts remain plain text", async () => {
  const calls = installFetch(), props = fixture(), before = structuredClone(props.capture);
  props.capture.cards[0]!.cardText += ' <script>syntheticUnsafe()</script><img src=x onerror="bad()">';
  const renderedCapture = structuredClone(props.capture);
  await render(props); await render({ ...props, revision: 99, token: "synthetic-next-token" });
  assert.equal(calls.length, 0); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === importLabel), false);
  assert.match(dom.document.body.textContent!, /地点未披露.*薪资未披露.*发布时间未知/s);
  assert.match(dom.document.body.textContent!, /待核实的卡片摘录/);
  assert.equal(dom.document.querySelector("script,img"), null);
  assert.match(dom.document.querySelector("pre")!.textContent!, /<script>/);
  const original = dom.document.querySelector("article a")!;
  assert.equal(original.getAttribute("href"), before.cards[0]!.url); assert.equal(original.getAttribute("target"), "_blank");
  assert.equal(original.getAttribute("rel"), "noopener noreferrer");
  assert.equal(dom.document.body.textContent!.includes(props.token), false);
  assert.deepEqual(props.capture, renderedCapture);
});

test("only an explicit preview and checkbox allow import; success refreshes the strict snapshot once without upgrading card evidence", async () => {
  const calls = installFetch(), props = fixture(), snapshots: AtlasDataset[] = [];
  props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await click(previewLabel);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.path, previewPath); assert.equal(calls[0]!.key, null);
  assert.deepEqual(calls[0]!.body, { ...props.capture, expectedRevision: 11 });
  assert.equal(button(importLabel).disabled, true);
  await click(importLabel); assert.equal(calls.length, 1);
  await confirm(); assert.equal(button(importLabel).disabled, false);
  await click(importLabel);
  assert.deepEqual(calls.map(call => call.path), [previewPath, importPath, snapshotPath]);
  assert.deepEqual(calls[1]!.body, { ...props.capture, expectedRevision: 11, previewFingerprint: "a".repeat(64), reviewed: true });
  assert.match(calls[1]!.key!, /^review-/);
  assert.equal(calls[1]!.init?.method, "POST"); assert.equal(calls[1]!.init?.credentials, "omit");
  assert.equal(new Headers(calls[1]!.init?.headers).get("Authorization"), "Bearer synthetic-review-token");
  assert.deepEqual(snapshots, [snapshot]); assert.match(dom.document.querySelector(".atlas-reviewed-success")!.textContent!, /版本 12，新增 1、更新 0/);
  assert.equal(props.capture.cards[0]!.locationText, undefined); assert.equal(props.capture.cards[0]!.salaryText, undefined);
  assert.equal(props.capture.cards[0]!.publicationText, undefined);
  assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
});

test("a lost import response preserves the exact body, preview revision and idempotency key across retry and unrelated revision changes", async () => {
  let imports = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) { if (++imports === 1) throw new TypeError("Synthetic response lost"); return response(receipt); }
    assert.equal(call.path, snapshotPath); return response(snapshot);
  });
  const props = fixture(); props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.equal(imports, 1); assert.equal(snapshots.length, 0); assert.ok(dom.document.querySelector('[role="alert"]'));
  assert.equal(button(previewLabel).disabled, true); assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  await render({ ...props, revision: 99 }); await click(retryLabel);
  const writes = calls.filter(call => call.path === importPath);
  assert.equal(writes.length, 2); assert.equal(writes[1]!.init!.body, writes[0]!.init!.body); assert.equal(writes[1]!.key, writes[0]!.key);
  assert.equal(writes[1]!.body!.expectedRevision, 11); assert.deepEqual(snapshots, [snapshot]);
  assert.equal(calls.filter(call => call.path === previewPath).length, 1);
});

test("an authoritative stale-version rejection clears confirmation and requires a fresh preview before another write", async () => {
  let previews = 0, writes = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(capture(), ++previews === 1 ? 11 : 12));
    assert.equal(call.path, importPath); writes++;
    return new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale-receipt", error: { code: "stale-version", message: "Private server text must not surface" } }), { status: 409 });
  });
  const props = fixture(); await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.equal(writes, 1); assert.equal(button(previewLabel).disabled, false); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.doesNotMatch(dom.document.body.textContent!, /Private server text/);
  await render({ ...props, revision: 12 }); await click(previewLabel);
  assert.equal(button(importLabel).disabled, true); assert.equal(writes, 1);
  assert.equal(calls.filter(call => call.path === previewPath).length, 2);
});

test("a failed snapshot after a successful receipt exposes committed status and retries only the index read", async () => {
  let reads = 0, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    assert.equal(call.path, snapshotPath); if (++reads === 1) throw new TypeError("Synthetic snapshot unavailable"); return response(snapshot);
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; };
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.match(dom.document.querySelector(".atlas-reviewed-success")!.textContent!, /版本 12/);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /岗位已写入索引版本 12/); assert.equal(snapshots, 0);
  await click("重新读取索引");
  assert.equal(snapshots, 1); assert.equal(calls.filter(call => call.path === importPath).length, 1); assert.equal(reads, 2);
});

test("closing or unmounting aborts in-flight preview and import; ignored late responses cannot publish success or a snapshot", async () => {
  for (const phase of ["preview", "import"] as const) for (const action of ["close", "unmount"] as const) {
    const old = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0, closes = 0;
    const calls = installFetch(call => {
      if (phase === "import" && call.path === previewPath) return response(preview());
      assert.equal(call.path, phase === "preview" ? previewPath : importPath); signal = call.init?.signal as AbortSignal; return old.promise;
    });
    const props = fixture(); props.onSnapshot = () => { snapshots++; }; props.onClose = () => { closes++; };
    await render(props); await click(previewLabel);
    if (phase === "import") { await confirm(); await click(importLabel); }
    assert.equal(signal?.aborted, false);
    if (action === "close") await close(); else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); assert.equal(closes, action === "close" ? 1 : 0);
    await act(async () => old.resolve(response(phase === "preview" ? preview() : receipt)));
    assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-reviewed-success"), null);
    assert.equal(calls.filter(call => call.path === snapshotPath).length, 0);
    if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren();
  }
});

test("changing capture, endpoint or token aborts the old request, restores controls and ignores its late result without auto-reading", async () => {
  const changes = [
    (props: AtlasReviewedCardImportProps) => ({ ...props, capture: capture("1234567891") }),
    (props: AtlasReviewedCardImportProps) => ({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasReviewedCardImportProps) => ({ ...props, token: "synthetic-next-review-token" }),
  ];
  for (const change of changes) {
    const old = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const props = fixture(); props.onSnapshot = () => { snapshots++; };
    const calls = installFetch(call => {
      if (calls.length === 1) { signal = call.init?.signal as AbortSignal; return old.promise; }
      assert.equal(call.path, previewPath); return response(preview(change(props).capture));
    });
    await render(props); await click(previewLabel); await render(change(props));
    assert.equal(signal?.aborted, true); assert.equal(calls.length, 1);
    assert.equal(button(previewLabel).disabled, false, "a changed capture must not inherit the old request's busy state");
    await act(async () => old.resolve(response(preview())));
    assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); assert.equal(snapshots, 0);
    await click(previewLabel); assert.equal(calls.length, 2); assert.equal(button(importLabel).disabled, true);
    if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren();
  }
});

test("the write deadline preserves its ambiguous request for explicit retry and cannot accept a late transport receipt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<Response>(); let importSignal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    assert.equal(call.path, importPath); importSignal = call.init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      importSignal!.addEventListener("abort", () => reject(importSignal!.reason), { once: true });
      void late.promise.then(resolve);
    });
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; };
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  await act(async () => mock.timers.tick(24_999)); assert.equal(importSignal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(importSignal?.aborted, true);
  assert.equal(button(retryLabel).disabled, false); assert.equal(button(previewLabel).disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已提交的写入可能完成/);
  await act(async () => late.resolve(response(receipt)));
  assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-reviewed-success"), null);
  assert.equal(calls.filter(call => call.path === snapshotPath).length, 0);
});
