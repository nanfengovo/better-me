import assert from "node:assert/strict";
import test from "node:test";
import { createNativeLiepinBrowser, NativeCaptureError } from "../server/jd-native-liepin-browser.ts";
import type { NativeEdge } from "../server/jd-native-edge.ts";
import type { CdpObject, NativeCdp, NativeCdpEvent } from "../server/jd-native-cdp.ts";
import { NATIVE_SNAPSHOT_STYLES } from "../server/jd-cdp-dom-snapshot.ts";

const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/ownedFactoryJob?fromSource=2";
const proxy = "http://127.0.0.1:17891";
const signal = () => new AbortController().signal;
type Rect = [number, number, number, number];
type Frame = { id: string; loaderId: string; url: string };
const description = "岗位职责：负责设备通信平台和业务系统开发，维护技术文档，完善交付及自动化测试。任职要求：熟悉C#和SQL，具备独立分析与解决问题的能力。";
const bounds: Rect = [60, 730, 112, 40];

/** Independent protocol tables, with snapshot coordinates at twice CSS scale. */
function rawSnapshot(frame: Frame, folded: boolean) {
  const strings: string[] = [];
  const str = (value: string) => { const found = strings.indexOf(value); if (found >= 0) return found; strings.push(value); return strings.length - 1; };
  const nodes = { nodeType: [] as number[], nodeName: [] as number[], parentIndex: [] as number[], nodeValue: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][] };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as Rect[], text: [] as number[], textColorOpacities: [] as number[], offsetRects: [] as (Rect | [])[], clientRects: [] as (Rect | [])[], scrollRects: [] as (Rect | [])[] };
  const textBoxes = { layoutIndex: [] as number[], bounds: [] as Rect[], start: [] as number[], length: [] as number[] };
  const defaults: Record<string, string> = { display: "block", visibility: "visible", opacity: "1", "content-visibility": "visible", "overflow-x": "visible", "overflow-y": "visible", "text-overflow": "clip", "-webkit-line-clamp": "none", clip: "auto", "clip-path": "none", transform: "none", filter: "none", "mask-image": "none", "-webkit-mask-image": "none", color: "rgb(0, 0, 0)" };
  const add = (name: string, parent: number, options: { text?: string; attrs?: Record<string, string>; bounds?: Rect; styles?: Record<string, string>; noLayout?: boolean } = {}) => {
    const at = nodes.nodeType.length; const type = name === "#document" ? 9 : name === "#text" ? 3 : 1;
    nodes.nodeType.push(type); nodes.nodeName.push(str(name)); nodes.parentIndex.push(parent); nodes.nodeValue.push(type === 3 ? str(options.text ?? "") : -1); nodes.backendNodeId.push(100 + at); nodes.attributes.push(Object.entries(options.attrs ?? {}).flatMap(([key, value]) => [str(key), str(value)]));
    if (type !== 9 && !options.noLayout) {
      const rect = options.bounds ?? [0, 0, 2000, 3000]; const row = layout.nodeIndex.length;
      layout.nodeIndex.push(at); layout.styles.push(type === 3 ? [] : NATIVE_SNAPSHOT_STYLES.map(name => str({ ...defaults, ...options.styles }[name]))); layout.bounds.push(rect); layout.text.push(type === 3 ? str(options.text ?? "") : -1); layout.textColorOpacities.push(1);
      layout.offsetRects.push(type === 3 ? [] : [0, 0, rect[2] / 2, rect[3] / 2]); layout.clientRects.push(type === 3 ? [] : [0, 0, rect[2] / 2, rect[3] / 2]); layout.scrollRects.push(type === 3 ? [] : [0, 0, rect[2] / 2, rect[3] / 2]);
      if (type === 3 && options.text) { textBoxes.layoutIndex.push(row); textBoxes.bounds.push(rect); textBoxes.start.push(0); textBoxes.length.push(options.text.length); }
    }
    return at;
  };
  const root = add("#document", -1), html = add("HTML", root), body = add("BODY", html);
  const share = add("DIV", body, { attrs: { class: "share-position" }, bounds: [0, 100, 2000, 2700] });
  const rec = add("DIV", share, { attrs: { class: "rec-detail" }, bounds: [40, 400, 1800, 2300] });
  const candidate = add("DIV", rec, { attrs: { class: `detail-text show-switch${folded ? " four-lines" : ""}` }, bounds: [60, 500, 1760, folded ? 224 : 1200], ...(folded ? { styles: { display: "flow-root", "overflow-x": "hidden", "overflow-y": "hidden", "-webkit-line-clamp": "4" } } : {}) });
  add("#text", candidate, { text: description, bounds: [60, 500, 1760, folded ? 224 : 1200] });
  if (folded) layout.scrollRects[layout.nodeIndex.indexOf(candidate)] = [0, 0, 880, 1120];
  const control = add("A", rec, { attrs: { class: "link-all" }, bounds }); const span = add("SPAN", control, { bounds }); const label = add("#text", span, { text: "查看全部", bounds });
  const doc = { frameId: str(frame.id), documentURL: str(frame.url), title: str("原岗位工程师"), contentWidth: 2000, contentHeight: 3000, nodes, layout, textBoxes };
  return { raw: { strings, documents: [doc] }, str, add, doc, nodes, layout, body, controlId: 100 + control, labelId: 100 + label, descriptionId: 100 + candidate };
}

/** All CDP calls below resolve in memory; this fixture never launches a browser. */
function fixture() {
  let connected = true; let nextTarget = 0; let frame: Frame = { id: "main", loaderId: "initial", url: "about:blank" }; let folded = true; let approved = true;
  let hook: ((method: string, params: CdpObject) => unknown | Promise<unknown>) | undefined;
  let rawHook: ((raw: ReturnType<typeof rawSnapshot>) => void) | undefined;
  const calls: { method: string; params: CdpObject; sessionId?: string }[] = [];
  const targets = new Map([["base", { targetId: "base", type: "page", url: "about:blank" }]]);
  const listeners = new Set<(event: NativeCdpEvent) => void>();
  const emit = (method: string, params: CdpObject) => { for (const listener of listeners) listener({ method, params, sessionId: "session-job-1" }); };
  const cdp: NativeCdp = {
    get connected() { return connected; },
    async send<T = CdpObject>(method: string, params: CdpObject = {}, sessionId?: string): Promise<T> {
      calls.push({ method, params, sessionId });
      const replacement = await hook?.(method, params); if (replacement !== undefined) return replacement as T;
      let result: unknown = {};
      if (method === "Target.getTargets") result = { targetInfos: [...targets.values()] };
      if (method === "Target.createTarget") { const targetId = `job-${++nextTarget}`; targets.set(targetId, { targetId, type: "page", url: "about:blank" }); result = { targetId }; }
      if (method === "Target.closeTarget") { targets.delete(String(params.targetId)); result = { success: true }; }
      if (method === "Target.attachToTarget") result = { sessionId: `session-${params.targetId}` };
      if (method === "Page.getFrameTree") result = { frameTree: { frame: { ...frame } } };
      if (method === "DOMSnapshot.captureSnapshot") { const value = rawSnapshot(frame, folded); rawHook?.(value); result = value.raw; }
      if (method === "Page.getLayoutMetrics") result = { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700, offsetX: 0, offsetY: 0, scale: 1 }, layoutViewport: { clientWidth: 2000, clientHeight: 1400 } };
      if (method === "DOM.getContentQuads") result = { quads: [[100, 200, 156, 200, 156, 220, 100, 220]] };
      if (method === "DOM.getNodeForLocation") result = { backendNodeId: rawSnapshot(frame, folded).labelId, frameId: "main" };
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") folded = false;
      return result as T;
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { connected = false; },
  };
  const edge: NativeEdge = { cdp, get alive() { return connected; }, async stop() { connected = false; } };
  const browser = createNativeLiepinBrowser({ platform: "BOSS直聘", profileDirectory: "C:/owned-synthetic-boss-factory-profile", networkMode: "managed-proxy", verifyManagedProxy: async url => approved && url === proxy, inspectProfileOccupancy: async () => "clear", launch: async () => edge });
  const commit = (url = source, id = "original", loader = "original-loader") => {
    emit("Network.requestWillBeSent", { requestId: id, loaderId: loader, frameId: "main", type: "Document", request: { url } });
    emit("Network.responseReceived", { requestId: id, loaderId: loader, frameId: "main", type: "Document", response: { status: 200, url } });
    frame = { id: "main", loaderId: loader, url }; targets.get("job-1")!.url = url;
    emit("Page.frameNavigated", { frame: { ...frame } }); emit("Page.lifecycleEvent", { frameId: "main", loaderId: loader, name: "load" });
  };
  return { browser, calls, targets, commit, emit, setHook: (value: typeof hook) => { hook = value; }, setRawHook: (value: typeof rawHook) => { rawHook = value; }, setApproved: (value: boolean) => { approved = value; }, inputs: () => calls.filter(call => call.method.startsWith("Input.")), get folded() { return folded; } };
}

test("BOSS factory capture exposes a validated folded plan and identity without scrolling or input", async () => {
  const f = fixture(); const page = await f.browser.acquire(proxy, signal());
  try {
    f.commit(); const result = await page.capture(signal(), 1000, source);
    assert.equal(result.state, "failed"); assert.equal(result.failure, "visibility_unsupported"); assert.equal(result.diagnostic?.detail, "boss_description_collapsed");
    assert.ok(result.identity); assert.equal(result.frameId, "main");
    const expected = rawSnapshot({ id: "main", loaderId: "original-loader", url: source }, true);
    assert.equal(result.expansionPlan?.controlBackendNodeId, expected.controlId); assert.equal(result.expansionPlan?.descriptionBackendNodeId, expected.descriptionId); assert.ok(result.expansionPlan?.hitBackendNodeIds.includes(expected.labelId));
    assert.equal(result.snapshot, undefined); assert.equal(await page.current(result.identity, signal()), true);
    assert.equal(f.inputs().length, 0); assert.equal(f.calls.some(call => call.method === "DOM.scrollIntoViewIfNeeded"), false);
  } finally { await f.browser.stop(); }
});

test("factory expansion uses the same owned session and CSS hit, then normal capture returns complete visible text", async () => {
  const f = fixture(); const page = await f.browser.acquire(proxy, signal());
  try {
    f.commit(); const folded = await page.capture(signal(), 1000, source); assert.ok(folded.identity);
    const start = f.calls.length;
    assert.equal(await page.expandDescription!(signal(), source, folded.identity), true);
    const calls = f.calls.slice(start); const action = calls.filter(call => ["DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "DOM.getNodeForLocation", "Input.dispatchMouseEvent"].includes(call.method));
    assert.deepEqual(action.map(call => call.method), ["DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "DOM.getNodeForLocation", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
    assert.ok(action.every(call => call.sessionId === "session-job-1"));
    assert.deepEqual(f.inputs().map(call => call.params.type), ["mousePressed", "mouseReleased"]);
    assert.ok(f.inputs().every(call => call.params.x === 128 && call.params.y === 210));
    assert.equal(f.folded, false); const full = await page.capture(signal(), 1000, source);
    assert.equal(full.state, "ready"); assert.ok(full.snapshot?.html.includes(description)); assert.equal(full.expansionPlan, undefined); assert.equal(full.identity, folded.identity);
    assert.equal(await page.expandDescription!(signal(), source, full.identity!), false); assert.equal(f.inputs().length, 2);
    assert.equal(f.calls.some(call => /Runtime\.(?:evaluate|callFunctionOn|enable)|Page\.navigate/.test(call.method)), false);
  } finally { await f.browser.stop(); }
});

test("wrong source, visible gate and unsupported control geometry never expose an expansion plan", async () => {
  for (const mode of ["source", "gate", "geometry", "navigation"] as const) {
    const f = fixture(); const page = await f.browser.acquire(proxy, signal());
    try {
      f.commit(mode === "navigation" ? "https://m.zhipin.com/web/common/security-check.html" : source);
      if (mode === "gate") f.setRawHook(value => { const gate = value.add("DIV", value.body, { attrs: { role: "dialog" } }); value.add("#text", gate, { text: "请完成安全验证" }); });
      if (mode === "geometry") f.setRawHook(value => { value.layout.offsetRects[value.layout.nodeIndex.indexOf(value.controlId - 100)] = []; });
      const captured = await page.capture(signal(), 1000, mode === "source" ? source.replace("ownedFactoryJob", "anotherJob") : source);
      assert.equal(captured.expansionPlan, undefined, mode); assert.equal(f.inputs().length, 0);
      assert.equal(f.calls.some(call => call.method === "DOM.scrollIntoViewIfNeeded"), false);
      if (mode === "gate" || mode === "navigation") assert.equal(captured.snapshot?.gate, "verification_required");
    } finally { await f.browser.stop(); }
  }
});

test("same-document generation change as the hit resolves prevents all input using the factory synchronous guard", async () => {
  const f = fixture(); const page = await f.browser.acquire(proxy, signal());
  try {
    f.commit(); const captured = await page.capture(signal(), 1000, source); assert.ok(captured.identity);
    f.setHook(method => { if (method === "DOM.getNodeForLocation") f.emit("Page.navigatedWithinDocument", { frameId: "main", url: source }); });
    assert.equal(await page.expandDescription!(signal(), source, captured.identity), false);
    assert.equal(f.calls.filter(call => call.method === "DOM.getNodeForLocation").length, 1); assert.equal(f.inputs().length, 0); assert.equal(f.folded, true);
  } finally { await f.browser.stop(); }
});

test("document changes before and after planning prevent factory expansion without any input", async () => {
  for (const stage of ["snapshot", "planned-current", "after-scroll"] as const) {
    const f = fixture(); const page = await f.browser.acquire(proxy, signal());
    try {
      f.commit(); const captured = await page.capture(signal(), 1000, source); assert.ok(captured.identity); let frameCalls = 0; let changed = false;
      f.setHook(method => {
        if (method === "Page.getFrameTree") frameCalls++;
        if (!changed && (stage === "snapshot" && method === "DOMSnapshot.captureSnapshot" || stage === "planned-current" && method === "Page.getFrameTree" && frameCalls === 3 || stage === "after-scroll" && method === "DOM.scrollIntoViewIfNeeded")) { changed = true; f.emit("Page.navigatedWithinDocument", { frameId: "main", url: source }); }
      });
      assert.equal(await page.expandDescription!(signal(), source, captured.identity), false, stage); assert.ok(changed); assert.equal(f.inputs().length, 0);
    } finally { await f.browser.stop(); }
  }
});

test("managed route failure before the planning current-check or after scrolling sends no input", async () => {
  for (const stage of ["snapshot", "after-scroll"] as const) {
    const f = fixture(); const page = await f.browser.acquire(proxy, signal());
    try {
      f.commit(); const captured = await page.capture(signal(), 1000, source); assert.ok(captured.identity); let changed = false;
      f.setHook(method => { if (!changed && method === (stage === "snapshot" ? "DOMSnapshot.captureSnapshot" : "DOM.scrollIntoViewIfNeeded")) { changed = true; f.setApproved(false); } });
      assert.equal(await page.expandDescription!(signal(), source, captured.identity), false); assert.ok(changed); assert.equal(f.inputs().length, 0);
      await assert.rejects(page.capture(signal(), 1000, source), error => error instanceof NativeCaptureError && error.diagnostic.reason === "network_unavailable");
    } finally { await f.browser.stop(); }
  }
});

test("release or cancellation before expansion and during the last hit cannot dispatch input", async () => {
  for (const mode of ["released-before", "cancelled-before", "released-at-hit", "cancelled-at-hit"] as const) {
    const f = fixture(); const page = await f.browser.acquire(proxy, signal()); const controller = new AbortController(); const reason = new Error(`factory-stop:${mode}`);
    try {
      f.commit(); const captured = await page.capture(signal(), 1000, source); assert.ok(captured.identity);
      if (mode === "released-before") await page.release();
      if (mode === "cancelled-before") controller.abort(reason);
      f.setHook(async method => { if (method !== "DOM.getNodeForLocation") return; if (mode === "released-at-hit") await page.release(); if (mode === "cancelled-at-hit") controller.abort(reason); });
      if (mode.startsWith("cancelled")) await assert.rejects(page.expandDescription!(controller.signal, source, captured.identity), error => error === reason);
      else assert.equal(await page.expandDescription!(controller.signal, source, captured.identity), false);
      assert.equal(f.inputs().length, 0); assert.equal(f.calls.some(call => call.method === "Browser.close"), false);
      if (mode.startsWith("released")) { assert.equal(page.closed, true); assert.equal(f.targets.size, 1); assert.equal(f.targets.get("base")?.url, "about:blank"); }
    } finally { await f.browser.stop(); }
  }
});
