import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasDataset, PreviewOfficeConfirmationInput } from "@better-me/opportunities";
import type { AtlasOfficeAddressConfirmationProps } from "../src/components/atlas/AtlasOfficeAddressConfirmation.tsx";
import { officeCandidates, officeConfirmed, officeJobId, officePreview, officeProposal, officeReason, officeReceipt, officeRevocation, officeRoutes, officeSnapshot, officeSource } from "./fixtures/atlas-office-address.ts";

const dom = new Window({ url: "http://office-confirmation-fixture.invalid" });
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
const { AtlasOfficeAddressConfirmation } = await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const previewLabel = "预览办公地址变更", saveLabel = "确认保存办公地址", retryLabel = "重试本次地址写入 · 核对回执", revokeLabel = "撤销当前办公地址确认";
type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const respond = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-office-panel", value }));
function installFetch(handler?: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, init, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call); if (handler) return handler(call, calls);
    if (call.path === officeRoutes.candidates) return respond(officeCandidates);
    if (call.path === officeRoutes.preview) return respond(officePreview(call.body as PreviewOfficeConfirmationInput));
    if (call.path === officeRoutes.confirm) return respond(officeReceipt);
    if (call.path === officeRoutes.revoke) return respond(officeRevocation);
    if (call.path === officeRoutes.snapshot) return respond(officeSnapshot);
    throw new Error(`Unexpected synthetic route ${call.path}`);
  });
  return calls;
}
function fixture(): AtlasOfficeAddressConfirmationProps {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-office-panel-token", jobId: officeJobId,
    location: structuredClone(officeSource), revision: 11, onClose() {}, onSnapshot() {} };
}
async function render(props: AtlasOfficeAddressConfirmationProps, strict = false) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(strict ? h(React.StrictMode, { children: h(AtlasOfficeAddressConfirmation, props) }) : h(AtlasOfficeAddressConfirmation, props)));
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const entry = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(entry, `Missing field ${label}`); return entry; }
async function change(label: string, value: string) {
  const entry = field(label);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function fillDraft() {
  await change("完整办公地址", officeProposal.formattedAddress); await change("办公街道门牌", officeProposal.streetAddress);
  await change("办公地址邮编", officeProposal.postalCode!); await change("办公地址纬度", String(officeProposal.coordinates.latitude));
  await change("办公地址经度", String(officeProposal.coordinates.longitude)); await change("办公地址依据链接", officeProposal.evidenceUrl);
  await change("办公地址核对说明", officeReason);
}
async function check(selector = ".atlas-office-preview") {
  const input = dom.document.querySelector<HTMLInputElement>(`${selector} input[type=checkbox]`); assert.ok(input);
  await act(async () => input.click());
}
async function close() { await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭办公地址核对"]')!.click()); }
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

test("opening is inert, source text stays text, and a city point never prefills an office coordinate", async () => {
  const calls = installFetch(), props = fixture();
  props.location = { ...props.location, raw: '<script>syntheticUnsafe()</script>', postalCode: "00100", coordinates: { latitude: 31, longitude: 121, coordinateSystem: "WGS84" }, precision: "city" };
  const before = structuredClone(props.location); await render(props);
  assert.equal(calls.length, 0); assert.equal(field("办公地址纬度").value, ""); assert.equal(field("办公地址经度").value, "");
  assert.equal(field("完整办公地址").value, ""); assert.equal(field("办公街道门牌").value, "");
  assert.equal(field("办公地址限定城市").value, ""); assert.equal(field("办公地址限定邮编").value, "");
  assert.equal(field("办公地址邮编").value, "00100");
  assert.equal(dom.document.querySelector("script"), null); assert.match(dom.document.body.textContent!, /<script>/);
  assert.match(dom.document.body.textContent!, /城市分布参考不能直接升级成楼宇/); assert.deepEqual(props.location, before);
  const link = [...dom.document.querySelectorAll("a")].find(node => node.textContent?.includes("Google"))!;
  assert.equal(link.target, "_blank"); assert.match(link.rel, /noopener/); assert.equal(new URL(link.href).searchParams.get("query"), props.location.raw);
});

test("remote or evidence-free locations cannot open an office write workflow", async () => {
  const calls = installFetch();
  for (const location of [{ ...officeSource, kind: "remote-region" as const }, { ...officeSource, evidence: [] }]) {
    await render({ ...fixture(), location }); assert.equal(dom.document.querySelector("fieldset"), null);
    assert.match(dom.document.body.textContent!, /不能保存为办公地址/);
  }
  assert.equal(calls.length, 0);
});

test("source reads never imply an external query and an unconfigured provider leaves the manual form available", async () => {
  const calls = installFetch(call => respond({ ...officeCandidates, configured: false, status: call.body?.query ? "not-configured" : "manual-available", candidates: [] }));
  await render(fixture()); assert.equal(button("查询地址候选").disabled, true);
  await click("读取地址来源与查询配置"); assert.equal(calls[0]!.body?.query, undefined);
  await change("办公地址查询", "  Synthetic Example Road 10  "); await click("查询地址候选");
  assert.equal(calls[1]!.body?.query, "Synthetic Example Road 10"); assert.equal(calls.length, 2);
  assert.match(dom.document.body.textContent!, /尚未配置地址查询服务/); assert.equal(field("完整办公地址").disabled, false);
});

test("only an explicit candidate query sends entered locality and postal constraints; source and confirmation fields stay independent", async () => {
  const calls = installFetch(call => respond(call.body?.query ? officeCandidates : { ...officeCandidates, candidates: [], status: "manual-available" }));
  await render({ ...fixture(), location: { ...officeSource, postalCode: "00100" } });
  await change("办公地址限定城市", "  Shanghai  "); await change("办公地址限定邮编", "  00007  ");
  assert.equal(calls.length, 0); assert.equal(button("查询地址候选").disabled, true);
  await click("读取地址来源与查询配置");
  assert.deepEqual(calls[0]!.body, { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11 });
  await change("办公地址查询", "  Synthetic Example Road 10  ");
  assert.equal(calls.length, 1); assert.equal(dom.document.querySelector(".atlas-office-candidates"), null);
  await click("查询地址候选");
  assert.deepEqual(calls[1]!.body, { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11,
    query: "Synthetic Example Road 10", locality: "Shanghai", postalCode: "00007" });
  assert.equal(field("办公地址邮编").value, "00100");
  assert.equal(field("办公地址纬度").value, ""); assert.equal(dom.document.querySelector(".atlas-office-preview"), null);
  assert.match(dom.document.body.textContent!, /城市填写地图使用的名称/);
  assert.match(dom.document.body.textContent!, /限定条件会发送给地址服务核对/);
});

test("editing any candidate-query field clears old candidates and blank constraints are omitted", async () => {
  const calls = installFetch(); await render(fixture());
  await change("办公地址查询", "Synthetic Example Road 10"); await click("查询地址候选");
  assert.equal(calls[0]!.body?.locality, undefined); assert.equal(calls[0]!.body?.postalCode, undefined);
  for (const [label, value] of [["办公地址限定城市", "Shanghai"], ["办公地址限定邮编", "00007"], ["办公地址查询", "Synthetic Example Road 11"]]) {
    assert.ok(dom.document.querySelector(".atlas-office-candidates"));
    const before = calls.length; await change(label!, value!);
    assert.equal(dom.document.querySelector(".atlas-office-candidates"), null);
    assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent?.includes("填入表单，继续人工核对")), false);
    assert.equal(calls.length, before); await click("查询地址候选");
  }
  await change("办公地址限定城市", " "); await change("办公地址限定邮编", " "); await click("查询地址候选");
  assert.deepEqual(calls.at(-1)!.body, { jobId: officeJobId, locationId: officeSource.id, expectedRevision: 11, query: "Synthetic Example Road 11" });
  assert.equal(field("办公地址纬度").value, ""); assert.equal(field("办公地址邮编").value, "");
});

test("candidate choice only fills a manual unverified proposal; it never previews or saves automatically", async () => {
  const calls = installFetch(); await render(fixture()); await change("办公地址查询", "Synthetic Example Road 10"); await click("查询地址候选");
  assert.match(dom.document.querySelector(".atlas-office-candidates")!.textContent!, /估算候选.*待核实/);
  assert.equal(field("办公地址纬度").value, ""); await click("填入表单，继续人工核对");
  assert.equal(field("完整办公地址").value, officeProposal.formattedAddress); assert.equal(field("办公地址纬度").value, String(officeProposal.coordinates.latitude));
  assert.equal(calls.length, 1); assert.equal(dom.document.querySelector(".atlas-office-preview"), null);
  await change("办公地址核对说明", officeReason); await click(previewLabel);
  assert.equal((calls[1]!.body?.proposal as typeof officeProposal).basis, "manual-user-confirmation");
  assert.equal(button(saveLabel).disabled, true);
});

test("blank or invalid coordinates and unsafe evidence never reach preview; edits invalidate review", async () => {
  const calls = installFetch(); await render(fixture()); await click(previewLabel); assert.equal(calls.length, 0);
  await fillDraft(); await change("办公地址纬度", "91"); await click(previewLabel); assert.equal(calls.length, 0);
  await change("办公地址纬度", String(officeProposal.coordinates.latitude)); await change("办公地址依据链接", "javascript:alert(1)");
  await click(previewLabel); assert.equal(calls.length, 0); await change("办公地址依据链接", officeProposal.evidenceUrl);
  await click(previewLabel); await check(); assert.equal(button(saveLabel).disabled, false);
  await change("办公地址核对说明", "Edited synthetic reason"); assert.equal(dom.document.querySelector(".atlas-office-preview"), null);
  assert.equal(calls.length, 1);
});

test("preview and explicit review precede the exact write; successful snapshot refresh preserves source facts", async () => {
  const calls = installFetch(), props = fixture(), snapshots: AtlasDataset[] = [], original = structuredClone(props.location);
  props.onSnapshot = data => snapshots.push(data); await render(props, true); await fillDraft(); await click(previewLabel);
  assert.equal(button(saveLabel).disabled, true); assert.deepEqual(calls.map(call => call.path), [officeRoutes.preview]);
  await check(); await click(saveLabel);
  assert.deepEqual(calls.map(call => call.path), [officeRoutes.preview, officeRoutes.confirm, officeRoutes.snapshot]);
  assert.deepEqual(calls[1]!.body, { ...calls[0]!.body, previewFingerprint: "b".repeat(64), reviewed: true });
  assert.match(calls[1]!.key!, /^office-/); assert.deepEqual(snapshots, [officeSnapshot]); assert.deepEqual(props.location, original);
  assert.match(dom.document.querySelector(".atlas-office-saved")!.textContent!, /版本 12.*待核实/);
});

test("a lost write reply reuses its exact input and key despite a newer parent revision", async () => {
  let writes = 0;
  const calls = installFetch(call => {
    if (call.path === officeRoutes.preview) return respond(officePreview());
    if (call.path === officeRoutes.confirm) { if (++writes === 1) throw new TypeError("Synthetic response lost"); return respond(officeReceipt); }
    assert.equal(call.path, officeRoutes.snapshot); return respond({ ...officeSnapshot, revision: 99 });
  });
  const props = fixture(); await render(props); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
  assert.equal(button(retryLabel).disabled, false); assert.equal(field("完整办公地址").closest("fieldset")!.disabled, true);
  await render({ ...props, revision: 99 }); await click(retryLabel);
  const submitted = calls.filter(call => call.path === officeRoutes.confirm);
  assert.equal(submitted.length, 2); assert.deepEqual(submitted[0]!.body, submitted[1]!.body); assert.equal(submitted[0]!.key, submitted[1]!.key);
  assert.equal(submitted[1]!.body?.expectedRevision, 11); assert.ok(dom.document.querySelector(".atlas-office-saved"));
});

test("a current revision change invalidates an unsubmitted preview and address candidates", async () => {
  const calls = installFetch(), props = fixture(); await render(props); await change("办公地址查询", "Synthetic Example Road 10");
  await click("查询地址候选"); await click("填入表单，继续人工核对"); await change("办公地址核对说明", officeReason); await click(previewLabel); await check();
  await render({ ...props, revision: 12 }); assert.equal(button(saveLabel).disabled, true);
  assert.equal(button("填入表单，继续人工核对").disabled, true); assert.match(dom.document.body.textContent!, /本预览已失效/);
  assert.equal(calls.filter(call => call.path === officeRoutes.confirm).length, 0);
});

test("a candidate reply arriving after the parent revision advances is discarded", async () => {
  const late = deferred<Response>();
  const calls = installFetch(call => { assert.equal(call.path, officeRoutes.candidates); return late.promise; });
  const props = fixture(); await render(props); await change("办公地址查询", "Synthetic Example Road 10");
  await click("查询地址候选"); await render({ ...props, revision: 12 });
  await act(async () => late.resolve(respond(officeCandidates)));
  assert.equal(dom.document.querySelector(".atlas-office-candidates"), null);
  assert.equal(field("办公地址纬度").value, ""); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /索引已更新/);
  assert.equal(calls.length, 1);
});

test("a preview reply arriving after the parent revision advances cannot create a stale review", async () => {
  const late = deferred<Response>();
  const calls = installFetch(call => { assert.equal(call.path, officeRoutes.preview); return late.promise; });
  const props = fixture(); await render(props); await fillDraft(); await click(previewLabel);
  await render({ ...props, revision: 12 }); await act(async () => late.resolve(respond(officePreview())));
  assert.equal(dom.document.querySelector(".atlas-office-preview"), null);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /索引已更新/);
  assert.equal(calls.length, 1);
});

test("a committed write receipt survives a newer revision but its older snapshot cannot downgrade the parent", async () => {
  const late = deferred<Response>(); let reads = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === officeRoutes.preview) return respond(officePreview());
    if (call.path === officeRoutes.confirm) return late.promise;
    assert.equal(call.path, officeRoutes.snapshot); return respond({ ...officeSnapshot, revision: ++reads === 1 ? 12 : 99 });
  });
  const props = fixture(); props.onSnapshot = data => snapshots.push(data);
  await render(props); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
  await render({ ...props, revision: 99 }); await act(async () => late.resolve(respond(officeReceipt)));
  assert.ok(dom.document.querySelector(".atlas-office-saved")); assert.deepEqual(snapshots, []);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已保存.*刷新未完成/);
  await click("重新读取索引"); assert.deepEqual(snapshots.map(value => value.revision), [99]);
  assert.equal(calls.filter(call => call.path === officeRoutes.confirm).length, 1);
});

test("a definitive stale-version failure clears the preview and write so a new version must be reviewed", async () => {
  const calls = installFetch(call => call.path === officeRoutes.preview ? respond(officePreview()) : new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale-office", error: { code: "stale-version", message: "Synthetic stale snapshot" } }), { status: 409 }));
  await render(fixture()); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
  assert.equal(dom.document.querySelector(".atlas-office-preview"), null); assert.equal(field("完整办公地址").disabled, false);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent?.includes(retryLabel)), false);
  assert.equal(calls.length, 2); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /stale-version/);
});

test("changing connection, job or source location aborts old work and ignores its late reply", async () => {
  for (const changeKind of ["token", "job", "location"] as const) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const calls = installFetch(call => { signal = call.init?.signal as AbortSignal; return late.promise; });
    const props = fixture(); props.onSnapshot = () => snapshots++; await render(props); await fillDraft(); await click(previewLabel);
    const changed = changeKind === "token" ? { ...props, token: "synthetic-other-token" } : changeKind === "job" ? { ...props, jobId: "synthetic-other-job" }
      : { ...props, location: { ...props.location, raw: "Changed source address" } };
    await render(changed); assert.equal(signal?.aborted, true);
    await act(async () => late.resolve(respond(officePreview())));
    assert.equal(dom.document.querySelector(".atlas-office-preview"), null); assert.equal(snapshots, 0); assert.equal(calls.length, 1);
    await clean();
  }
});

test("closing or unmounting a pending write ignores late success and never refreshes another pane", async () => {
  for (const action of ["close", "unmount"] as const) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0, closes = 0;
    const calls = installFetch(call => {
      if (call.path === officeRoutes.preview) return respond(officePreview());
      signal = call.init?.signal as AbortSignal; return late.promise;
    });
    const props = fixture(); props.onSnapshot = () => snapshots++; props.onClose = () => closes++;
    await render(props); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
    if (action === "close") await close(); else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); await act(async () => late.resolve(respond(officeReceipt)));
    assert.equal(snapshots, 0); assert.equal(closes, action === "close" ? 1 : 0); assert.equal(calls.length, 2);
    await clean();
  }
});

test("saved writes with a failed snapshot stay saved and the refresh action never repeats the write", async () => {
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path === officeRoutes.preview) return respond(officePreview());
    if (call.path === officeRoutes.confirm) return respond(officeReceipt);
    assert.equal(call.path, officeRoutes.snapshot); if (++reads === 1) throw new TypeError("Synthetic snapshot read failed"); return respond(officeSnapshot);
  });
  await render(fixture()); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
  assert.ok(dom.document.querySelector(".atlas-office-saved")); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已保存.*刷新未完成/);
  await click("重新读取索引"); assert.equal(calls.filter(call => call.path === officeRoutes.confirm).length, 1); assert.equal(reads, 2);
});

test("the write deadline retains its original request, permits receipt recovery and rejects a late success", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === officeRoutes.preview) return respond(officePreview());
    assert.equal(call.path, officeRoutes.confirm); signal = call.init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); void late.promise.then(resolve); });
  });
  const props = fixture(); props.onSnapshot = () => snapshots++;
  await render(props); await fillDraft(); await click(previewLabel); await check(); await click(saveLabel);
  await act(async () => mock.timers.tick(24_999)); assert.equal(signal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(signal?.aborted, true);
  assert.equal(button(retryLabel).disabled, false); assert.equal(button(previewLabel).disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /提交中的写入可能已完成/);
  await act(async () => late.resolve(respond(officeReceipt)));
  assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-office-saved"), null);
  assert.equal(calls.filter(call => call.path === officeRoutes.snapshot).length, 0);
});

test("revocation uses an independent renewed checkbox, explicit reason, active decision and original key after a lost reply", async () => {
  let writes = 0;
  const calls = installFetch(call => {
    if (call.path === officeRoutes.revoke) { if (++writes === 1) throw new TypeError("Synthetic revocation response lost"); return respond(officeRevocation); }
    assert.equal(call.path, officeRoutes.snapshot); return respond({ ...officeSnapshot, locations: officeSnapshot.locations.map(location => location.id === officeSource.id ? officeSource : location) });
  });
  const props = { ...fixture(), location: structuredClone(officeConfirmed) }; await render(props);
  assert.equal(button(revokeLabel).disabled, true); await check(".atlas-office-revoke"); assert.equal(button(revokeLabel).disabled, true);
  await change("办公地址核对说明", "Synthetic revocation reason"); assert.equal(button(revokeLabel).disabled, true);
  await check(".atlas-office-revoke"); await click(revokeLabel); await click(retryLabel);
  const submitted = calls.filter(call => call.path === officeRoutes.revoke);
  assert.equal(submitted.length, 2); assert.deepEqual(submitted[0]!.body, submitted[1]!.body); assert.equal(submitted[0]!.key, submitted[1]!.key);
  assert.deepEqual(submitted[0]!.body, { jobId: props.jobId, locationId: officeSource.id, decisionId: officeReceipt.decisionId, expectedRevision: 11, reason: "Synthetic revocation reason", reviewed: true });
  assert.match(submitted[0]!.key!, /^office-revoke-/); assert.match(dom.document.querySelector(".atlas-office-saved")!.textContent!, /恢复/);
});
