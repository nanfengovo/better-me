import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasDataset, JobLocation, LocationConfirmationPreview, LocationConfirmationReceipt, PreviewLocationConfirmationInput } from "@better-me/opportunities";
import type { AtlasLocationConfirmationProps } from "../src/components/atlas/AtlasLocationConfirmation.tsx";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const dom = new Window({ url: "http://location-confirmation-fixture.invalid" });
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
const { AtlasLocationConfirmation } = await import("../src/components/atlas/AtlasLocationConfirmation.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-10-19T12:00:00.000Z";
const base = createAtlasDemo();
const sourceLocation: JobLocation = { id: base.locations[0]!.id, raw: "上海-浦东新区", kind: "unknown", precision: "unknown", verification: "unverified", evidence: base.locations[0]!.evidence };
const confirmedLocation: JobLocation = { ...sourceLocation, kind: "office", countryCode: "CN", regionId: "CN-SH", region: "上海市", city: "上海市", district: "浦东新区", precision: "city",
  userResolution: { decisionId: "synthetic-location-decision", method: "explicit-user-confirmation", at, originalLocationId: sourceLocation.id,
    basis: { kind: "china-catalog", datasetId: "synthetic-catalog", version: "2023", provinceCode: "31", cityCode: "3101", districtCode: "310115" } } };
const snapshot: AtlasDataset = { ...base, revision: 12, locations: base.locations.map(location => location.id === sourceLocation.id ? confirmedLocation : location) };
const receipt: LocationConfirmationReceipt = { ok: true, revision: 12, jobId: base.jobs[0]!.id, locationId: sourceLocation.id,
  decisionId: "synthetic-location-decision", activeDecisionId: "synthetic-location-decision", location: confirmedLocation };
const previewPath = "/api/v1/locations/confirmations/preview";
const confirmPath = "/api/v1/locations/confirmations";
const revokePath = "/api/v1/locations/confirmations/revoke";
const snapshotPath = "/api/v1/dataset/export";
const previewLabel = "预览地区变更", confirmLabel = "确认保存地区", retryLabel = "重试本次地点写入 · 核对回执";
const revokeLabel = "撤销当前地区确认";
const reason = "已核对合成原岗位，披露上海浦东；没有具体办公地址。";
function fixture(): AtlasLocationConfirmationProps {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-location-token", jobId: base.jobs[0]!.id,
    location: structuredClone(sourceLocation), revision: 11, onClose: () => {}, onSnapshot: () => {} };
}
function preview(input?: PreviewLocationConfirmationInput, overrides: Partial<LocationConfirmationPreview> = {}): LocationConfirmationPreview {
  return { expectedRevision: input?.expectedRevision ?? 11, previewFingerprint: "b".repeat(64), jobId: input?.jobId ?? base.jobs[0]!.id,
    locationId: input?.locationId ?? sourceLocation.id, original: sourceLocation, current: sourceLocation, proposed: confirmedLocation,
    warnings: ["Synthetic administrative confirmation does not create office coordinates."], ...overrides };
}
type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-location-request", value }));
function installFetch(handler?: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, init, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call);
    if (handler) return handler(call, calls);
    if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
    if (call.path === confirmPath) return response(receipt);
    if (call.path === revokePath) return response({ ...receipt, activeDecisionId: undefined, decisionId: "synthetic-revoke-decision", location: sourceLocation });
    if (call.path === snapshotPath) return response(snapshot);
    throw new Error(`Unexpected synthetic route: ${call.path}`);
  });
  return calls;
}
async function render(props: AtlasLocationConfirmationProps) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasLocationConfirmation, props)));
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button: ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const entry = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(entry, `Missing field: ${label}`); return entry; }
async function change(label: string, value: string) {
  const entry = field(label);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function selectShanghai() {
  await change("确认国家地区", "CN"); await change("确认省级地区", "31"); await change("确认城市", "3101");
  await change("确认区县", "310115"); await change("确认地点性质", "office"); await change("地区核对说明", reason);
}
async function check(selector = ".atlas-location-preview") {
  const checkbox = dom.document.querySelector<HTMLInputElement>(`${selector} input[type="checkbox"]`); assert.ok(checkbox);
  await act(async () => checkbox.click());
}
async function close() { await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭地区核对"]')!.click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function clean() {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren();
}
afterEach(clean);
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("mount and connection changes are inert; raw evidence is plain text and no office point is invented", async () => {
  const calls = installFetch(), props = fixture();
  props.location.raw += ' <script>syntheticUnsafe()</script><img src=x onerror="bad()">';
  const before = structuredClone(props.location);
  await render(props); await render({ ...props, token: "synthetic-next-token", revision: 99 });
  assert.equal(calls.length, 0); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.equal(dom.document.querySelector("script,img"), null); assert.match(dom.document.body.textContent!, /<script>/);
  assert.match(dom.document.body.textContent!, /不新增办公坐标/); assert.match(dom.document.body.textContent!, /未确认行政范围/);
  assert.equal(field("确认国家地区").value, ""); assert.equal(props.location.coordinates, undefined);
  assert.equal(dom.document.body.textContent!.includes(props.token), false); assert.deepEqual(props.location, before);
});

test("country, province and city changes clear subordinate selections and overseas text without fetching", async () => {
  const calls = installFetch(); await render(fixture()); await selectShanghai();
  assert.equal(field("确认区县").value, "310115");
  await change("确认城市", ""); assert.equal(field("确认区县").value, ""); assert.equal(field("确认区县").disabled, true);
  await change("确认城市", "3101"); await change("确认区县", "310115");
  await change("确认省级地区", "32"); assert.equal(field("确认城市").value, ""); assert.equal(field("确认区县").value, "");
  assert.equal([...dom.document.querySelectorAll("option")].some(option => option.value === "310115"), false);
  await change("确认国家地区", "US"); await change("确认省州地区", "Washington"); await change("确认城市名称", "Seattle");
  await change("确认国家地区", "CN"); assert.equal(field("确认省级地区").value, ""); assert.equal(field("确认城市").value, "");
  await change("确认国家地区", "US"); assert.equal(field("确认省州地区").value, ""); assert.equal(field("确认城市名称").value, "");
  assert.equal(calls.length, 0);
});

test("invalid or incomplete drafts never request the service; an edit invalidates a reviewed preview", async () => {
  const calls = installFetch(); await render(fixture()); await click(previewLabel); assert.equal(calls.length, 0);
  assert.ok(dom.document.querySelector('[role="alert"]'));
  await change("确认国家地区", "CN"); await click(previewLabel); assert.equal(calls.length, 0);
  await selectShanghai(); await click(previewLabel); await check(); assert.equal(button(confirmLabel).disabled, false);
  await change("地区核对说明", `${reason}补充说明。`);
  assert.equal(dom.document.querySelector('.atlas-location-preview input[type="checkbox"]'), null);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === confirmLabel), false);
  assert.equal(calls.length, 1);
});

test("a legacy source location without kind can confirm a country while preserving unknown location nature", async () => {
  const calls = installFetch(), props = fixture(); delete props.location.kind;
  await render(props); await change("确认国家地区", "CN"); await change("地区核对说明", "原文仅能确认中国，具体性质与地址未知。");
  await click(previewLabel);
  assert.equal(calls.length, 1, "the visible default unknown option must be represented in the proposal");
  assert.deepEqual(calls[0]!.body!.proposal, { locationKind: "unknown", countryCode: "CN", area: { kind: "manual-area" } });
  assert.equal(props.location.kind, undefined); assert.equal(props.location.countryCode, undefined);
});

test("only explicit preview and confirmation write the chosen path, retain raw source evidence and refresh once", async () => {
  const calls = installFetch(), props = fixture(), snapshots: AtlasDataset[] = [], before = structuredClone(props.location);
  props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await selectShanghai(); await click(previewLabel);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.path, previewPath); assert.equal(calls[0]!.key, null);
  assert.deepEqual(calls[0]!.body, { jobId: props.jobId, locationId: sourceLocation.id, expectedRevision: 11,
    proposal: { locationKind: "office", countryCode: "CN", area: { kind: "china-catalog", provinceCode: "31", cityCode: "3101", districtCode: "310115" } }, reason });
  assert.equal(button(confirmLabel).disabled, true); await click(confirmLabel); assert.equal(calls.length, 1);
  await check(); await click(confirmLabel);
  assert.deepEqual(calls.map(call => call.path), [previewPath, confirmPath, snapshotPath]);
  assert.deepEqual(calls[1]!.body, { ...calls[0]!.body, previewFingerprint: "b".repeat(64), reviewed: true });
  assert.match(calls[1]!.key!, /^location-/); assert.equal(calls[1]!.init?.method, "POST"); assert.equal(calls[1]!.init?.credentials, "omit");
  assert.equal(new Headers(calls[1]!.init?.headers).get("Authorization"), `Bearer ${props.token}`);
  assert.deepEqual(snapshots, [snapshot]); assert.match(dom.document.querySelector(".atlas-location-saved")!.textContent!, /版本 12.*浦东新区/);
  assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); assert.deepEqual(props.location, before);
  assert.equal(snapshots[0]!.locations[0]!.coordinates, undefined); assert.equal(snapshots[0]!.locations[0]!.verification, "unverified");
});

test("a lost write response retains the exact body, old preview revision and idempotency key after the index advances", async () => {
  let writes = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
    if (call.path === confirmPath) { if (++writes === 1) throw new TypeError("Synthetic response lost"); return response(receipt); }
    assert.equal(call.path, snapshotPath); return response(snapshot);
  });
  const props = fixture(); props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await selectShanghai(); await click(previewLabel); await check(); await click(confirmLabel);
  assert.equal(writes, 1); assert.equal(snapshots.length, 0); assert.equal(button(previewLabel).disabled, true);
  assert.equal(dom.document.querySelector<HTMLInputElement>('.atlas-location-preview input[type="checkbox"]')!.disabled, true);
  await render({ ...props, revision: 99 }); await click(retryLabel);
  const attempts = calls.filter(call => call.path === confirmPath);
  assert.equal(attempts.length, 2); assert.equal(attempts[1]!.init!.body, attempts[0]!.init!.body); assert.equal(attempts[1]!.key, attempts[0]!.key);
  assert.equal(attempts[1]!.body!.expectedRevision, 11); assert.deepEqual(snapshots, [snapshot]);
  assert.equal(calls.filter(call => call.path === previewPath).length, 1);
});

test("an authoritative revision rejection discards checkbox and pending write, then requires a new preview", async () => {
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
    assert.equal(call.path, confirmPath);
    return new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale-request", error: { code: "stale-version", message: "Private diagnostic must not surface" } }), { status: 409 });
  });
  const props = fixture(); await render(props); await selectShanghai(); await click(previewLabel); await check(); await click(confirmLabel);
  assert.equal(button(previewLabel).disabled, false); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === retryLabel), false);
  assert.doesNotMatch(dom.document.body.textContent!, /Private diagnostic/);
  await render({ ...props, revision: 12 }); await click(previewLabel);
  assert.equal(button(confirmLabel).disabled, true); assert.equal(calls.filter(call => call.path === confirmPath).length, 1);
  assert.equal(calls.filter(call => call.path === previewPath)[1]!.body!.expectedRevision, 12);
});

test("a preview for another revision, job or location cannot become a confirmable selection", async () => {
  for (const mismatch of [{ expectedRevision: 12 }, { jobId: "synthetic-other-job" }, { locationId: "synthetic-other-location" }]) {
    const calls = installFetch(call => { assert.equal(call.path, previewPath); return response(preview(call.body as PreviewLocationConfirmationInput, mismatch)); });
    await render(fixture()); await selectShanghai(); await click(previewLabel);
    assert.equal(dom.document.querySelector('.atlas-location-preview input[type="checkbox"]'), null, `mismatched preview accepted: ${JSON.stringify(mismatch)}`);
    assert.ok(dom.document.querySelector('[role="alert"]')); assert.equal(calls.length, 1);
    await clean();
  }
});

test("a committed receipt survives snapshot failure and retry reads only the index", async () => {
  let reads = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
    if (call.path === confirmPath) return response(receipt);
    assert.equal(call.path, snapshotPath); if (++reads === 1) throw new TypeError("Synthetic snapshot unavailable"); return response(snapshot);
  });
  const props = fixture(); props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await selectShanghai(); await click(previewLabel); await check(); await click(confirmLabel);
  assert.match(dom.document.querySelector(".atlas-location-saved")!.textContent!, /版本 12/);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已保存到索引版本 12/); assert.equal(snapshots.length, 0);
  await click("重新读取索引"); assert.deepEqual(snapshots, [snapshot]);
  assert.equal(calls.filter(call => call.path === confirmPath).length, 1); assert.equal(reads, 2);
});

test("changing location or connection aborts old preview and write requests and ignores late responses", async () => {
  const changes = [
    (props: AtlasLocationConfirmationProps) => ({ ...props, location: { ...props.location, raw: "另一个合成来源地点" } }),
    (props: AtlasLocationConfirmationProps) => ({ ...props, token: "synthetic-next-location-token" }),
    (props: AtlasLocationConfirmationProps) => ({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasLocationConfirmationProps) => ({ ...props, jobId: "synthetic-next-job" }),
  ];
  for (const phase of ["preview", "confirm"] as const) for (const changeProps of changes) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const calls = installFetch(call => {
      if (phase === "confirm" && call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
      assert.equal(call.path, phase === "preview" ? previewPath : confirmPath); signal = call.init?.signal as AbortSignal; return late.promise;
    });
    const props = fixture(); props.onSnapshot = () => { snapshots++; };
    await render(props); await selectShanghai(); await click(previewLabel);
    if (phase === "confirm") { await check(); await click(confirmLabel); }
    assert.equal(signal?.aborted, false); await render(changeProps(props)); assert.equal(signal?.aborted, true);
    assert.equal(button(previewLabel).disabled, false); const oldCallCount = calls.length;
    await act(async () => late.resolve(response(phase === "preview" ? preview() : receipt)));
    assert.equal(calls.length, oldCallCount); assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-location-saved"), null);
    assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); await clean();
  }
});

test("close and unmount stop waiting without accepting late writes or refreshing the index", async () => {
  for (const action of ["close", "unmount"] as const) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0, closes = 0;
    const calls = installFetch(call => {
      if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
      assert.equal(call.path, confirmPath); signal = call.init?.signal as AbortSignal; return late.promise;
    });
    const props = fixture(); props.onSnapshot = () => { snapshots++; }; props.onClose = () => { closes++; };
    await render(props); await selectShanghai(); await click(previewLabel); await check(); await click(confirmLabel);
    if (action === "close") await close(); else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); assert.equal(closes, action === "close" ? 1 : 0);
    await act(async () => late.resolve(response(receipt)));
    assert.equal(snapshots, 0); assert.equal(calls.filter(call => call.path === snapshotPath).length, 0); await clean();
  }
});

test("revocation needs its own explicit checkbox and nonempty reason and addresses the active decision", async () => {
  const restoredSnapshot = { ...snapshot, locations: snapshot.locations.map(location => location.id === sourceLocation.id ? sourceLocation : location) };
  const calls = installFetch(call => {
    if (call.path === revokePath) return response({ ...receipt, activeDecisionId: undefined, decisionId: "synthetic-revoke-decision", location: sourceLocation });
    assert.equal(call.path, snapshotPath); return response(restoredSnapshot);
  }), props = fixture(), snapshots: AtlasDataset[] = []; props.location = structuredClone(confirmedLocation); props.onSnapshot = value => { snapshots.push(value); };
  await render(props); assert.equal(button(revokeLabel).disabled, true); assert.equal(calls.length, 0);
  await check(".atlas-location-revoke"); assert.equal(button(revokeLabel).disabled, true);
  await change("地区核对说明", "原地区确认有误，恢复来源披露。"); assert.equal(button(revokeLabel).disabled, true, "editing the reason must require a renewed checkbox");
  await check(".atlas-location-revoke"); assert.equal(button(revokeLabel).disabled, false); await click(revokeLabel);
  assert.deepEqual(calls.map(call => call.path), [revokePath, snapshotPath]);
  assert.deepEqual(calls[0]!.body, { jobId: props.jobId, locationId: sourceLocation.id, decisionId: "synthetic-location-decision", expectedRevision: 11, reason: "原地区确认有误，恢复来源披露。", reviewed: true });
  assert.match(calls[0]!.key!, /^location-revoke-/); assert.match(dom.document.querySelector(".atlas-location-saved")!.textContent!, /未确认行政范围/);
  assert.equal(props.location.userResolution!.decisionId, "synthetic-location-decision"); assert.deepEqual(snapshots, [restoredSnapshot]);
});

test("a lost revoke response retries the original active decision and revision without issuing a new confirmation", async () => {
  let writes = 0;
  const calls = installFetch(call => {
    if (call.path === revokePath) {
      if (++writes === 1) throw new TypeError("Synthetic revocation response lost");
      return response({ ...receipt, activeDecisionId: undefined, decisionId: "synthetic-revoke-decision", location: sourceLocation });
    }
    assert.equal(call.path, snapshotPath); return response(snapshot);
  });
  const props = fixture(); props.location = structuredClone(confirmedLocation);
  await render(props); await change("地区核对说明", "确认原地区无效，恢复来源。"); await check(".atlas-location-revoke"); await click(revokeLabel);
  assert.equal(writes, 1); await render({ ...props, revision: 99 }); await click(retryLabel);
  const attempts = calls.filter(call => call.path === revokePath);
  assert.equal(attempts.length, 2); assert.equal(attempts[0]!.init!.body, attempts[1]!.init!.body); assert.equal(attempts[0]!.key, attempts[1]!.key);
  assert.equal(attempts[1]!.body!.expectedRevision, 11); assert.equal(attempts[1]!.body!.decisionId, "synthetic-location-decision");
  assert.deepEqual(calls.map(call => call.path), [revokePath, revokePath, snapshotPath]);
});

test("a write deadline retains its durable request and does not publish a late receipt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<Response>(); let writeSignal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(call.body as PreviewLocationConfirmationInput));
    assert.equal(call.path, confirmPath); writeSignal = call.init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { writeSignal!.addEventListener("abort", () => reject(writeSignal!.reason), { once: true }); void late.promise.then(resolve); });
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; };
  await render(props); await selectShanghai(); await click(previewLabel); await check(); await click(confirmLabel);
  await act(async () => mock.timers.tick(24_999)); assert.equal(writeSignal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(writeSignal?.aborted, true);
  assert.equal(button(retryLabel).disabled, false); assert.equal(button(previewLabel).disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已提交的写入可能完成/);
  await act(async () => late.resolve(response(receipt)));
  assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-location-saved"), null);
  assert.equal(calls.filter(call => call.path === snapshotPath).length, 0);
});
