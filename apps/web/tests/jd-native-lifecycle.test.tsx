import assert from "node:assert/strict";
import test from "node:test";
import { createNativeLiepinBrowser, NativeBrowserSetupRequiredError, type NativeLiepinPage } from "../server/jd-native-liepin-browser.ts";
import type { NativeEdge } from "../server/jd-native-edge.ts";
import type { CdpObject, NativeCdp, NativeCdpEvent } from "../server/jd-native-cdp.ts";
import { NATIVE_SNAPSHOT_STYLES, NATIVE_LIEPIN_PARAGRAPH_STYLES } from "../server/jd-cdp-dom-snapshot.ts";

const source = "https://www.liepin.com/job/1984701079.shtml";
const proxy = "http://127.0.0.1:17891";
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function capture(frame: { id: string; url: string }, marker: string) {
  const strings: string[] = [];
  const str = (value: string) => { const i = strings.indexOf(value); if (i >= 0) return i; strings.push(value); return strings.length - 1; };
  const defaults: Record<string, string> = {
    display: "block", visibility: "visible", opacity: "1", "content-visibility": "visible", "overflow-x": "visible", "overflow-y": "visible",
    "text-overflow": "clip", "-webkit-line-clamp": "none", clip: "auto", "clip-path": "none", transform: "none", filter: "none",
    "mask-image": "none", "-webkit-mask-image": "none", color: "rgb(0, 0, 0)",
  };
  const style = NATIVE_SNAPSHOT_STYLES.map((name) => str(defaults[name]!));
  const text = `岗位职责：维护企业软件系统，分析生产问题并编写回归文档。任职要求：熟悉网络、数据库及异步编程。${marker}`;
  return { strings, documents: [{ frameId: str(frame.id), documentURL: str(frame.url), title: str("本地生命周期测试岗位"), nodes: {
    nodeType: [9, 1, 1, 1, 1, 3], parentIndex: [-1, 0, 1, 1, 3, 4],
    nodeName: ["#document", "HTML", "HEAD", "BODY", "DIV", "#text"].map(str), nodeValue: [-1, -1, -1, -1, -1, str(text)],
    backendNodeId: [1, 2, 3, 4, 5, 6], attributes: [[], [], [], [], [str("class"), str("job-intro-content")], []],
  }, layout: { nodeIndex: [1, 3, 4, 5], styles: [style, style, style, []], bounds: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [0, 0, 900, 200], [0, 0, 900, 100]], text: [-1, -1, -1, str(text)], textColorOpacities: [1, 1, 1, 1] }, textBoxes: { layoutIndex: [3], bounds: [[0, 0, 900, 100]], start: [0], length: [text.length] } }] };
}

/** Every generation owns a different transport and event listener set; no real browser or network. */
function fixture(options: { setupInitially?: boolean; setupDuringStartupClose?: boolean; verifyManagedProxy?: (url: string) => Promise<boolean>; targetCreationPause?: (id: string) => Promise<void> } = {}) {
  const launches: ReturnType<typeof edgeFixture>[] = [];
  function edgeFixture(generation: number) {
    let connected = true; let nextTarget = 0; let proofCalls = 0; let stops = 0; let reconnectCalls = 0;
    let reconnect: (signal?: AbortSignal) => Promise<boolean> = async () => true;
    let proof: () => Promise<boolean> = async () => false;
    let hook: ((method: string, params: CdpObject, session?: string) => unknown) | undefined;
    const base = `base-${generation}`;
    const targets = new Map<string, { targetId: string; type: string; url: string }>([[base, { targetId: base, type: "page", url: "about:blank" }]]);
    const setupId = `setup-${generation}`;
    const setupInfo = { targetId: setupId, type: "page", url: "edge://sync-confirmation-dialog/" };
    if (options.setupInitially) targets.set(setupId, setupInfo);
    if (options.setupDuringStartupClose) targets.set(setupId, { ...setupInfo, url: "about:blank#startup" });
    const frames = new Map<string, { id: string; loaderId: string; url: string }>();
    type Transport = { cdp: NativeCdp; events: Set<(event: NativeCdpEvent) => void> };
    const transports: Transport[] = []; let currentTransport: Transport;
    const commands: string[] = [];
    let targetQueries = 0;
    const calls: Array<{ method: string; params: CdpObject; session?: string }> = [];
    const emit = (method: string, params: CdpObject, sessionId?: string) => { for (const listener of currentTransport.events) listener({ method, params, ...(sessionId ? { sessionId } : {}) }); };
    function createTransport(): Transport {
      const events = new Set<(event: NativeCdpEvent) => void>();
      const cdp: NativeCdp = {
      get connected() { return connected && currentTransport.cdp === cdp; },
      async send<T = CdpObject>(method: string, params: CdpObject = {}, session?: string): Promise<T> {
        commands.push(method);
        calls.push({ method, params, session });
        if (!connected || currentTransport.cdp !== cdp) throw new Error("fixture disconnected transport");
        const intercepted = hook?.(method, params, session);
        if (intercepted !== undefined) return await intercepted as T;
        let result: unknown = {};
        if (method === "Target.getTargets") {
          result = { targetInfos: [...targets.values()] };
          if (options.setupDuringStartupClose && ++targetQueries === 2) {
            targets.set(setupId, setupInfo); emit("Target.targetInfoChanged", { targetInfo: setupInfo });
          }
        }
        if (method === "Target.createTarget") {
          const id = `job-${generation}-${++nextTarget}`;
          targets.set(id, { targetId: id, type: "page", url: "about:blank" });
          frames.set(id, { id: `main-${id}`, loaderId: `initial-${id}`, url: "about:blank" }); result = { targetId: id };
          await options.targetCreationPause?.(id);
        }
        if (method === "Target.attachToTarget") result = { sessionId: `session:${params.targetId}` };
        if (method === "Target.closeTarget") {
          targets.delete(String(params.targetId)); frames.delete(String(params.targetId));
          emit("Target.targetDestroyed", { targetId: params.targetId }); result = { success: true };
        }
        const id = session?.slice("session:".length);
        if (method === "Page.getFrameTree") result = { frameTree: { frame: { ...frames.get(id!) } } };
        if (method === "Page.navigate") {
          const frame = frames.get(id!)!; frame.url = String(params.url); frame.loaderId = `loaded-${id}`; targets.get(id!)!.url = frame.url;
          emit("Network.requestWillBeSent", { requestId: `request-${id}`, frameId: frame.id, loaderId: frame.loaderId, type: "Document", request: { url: frame.url } }, session);
          emit("Network.responseReceived", { requestId: `request-${id}`, frameId: frame.id, loaderId: frame.loaderId, type: "Document", response: { url: frame.url, status: 200 } }, session);
          emit("Page.frameNavigated", { frame: { ...frame } }, session);
          emit("Page.lifecycleEvent", { frameId: frame.id, loaderId: frame.loaderId, name: "load" }, session);
        }
        if (method === "DOMSnapshot.captureSnapshot") result = capture(frames.get(id!)!, `CYCLE_${id}`);
        return result as T;
      },
      on(listener) { events.add(listener); return () => { events.delete(listener); }; },
      close() { if (currentTransport.cdp === cdp) connected = false; },
      };
      const transport = { cdp, events }; transports.push(transport); return transport;
    }
    currentTransport = createTransport();
    const edge: NativeEdge = {
      get cdp() { return currentTransport.cdp; }, get alive() { return connected; },
      async confirmExited() { proofCalls++; const result = await proof(); if (result) connected = false; return result; },
      async reconnect(operationSignal?: AbortSignal) { reconnectCalls++; const result = await reconnect(operationSignal); operationSignal?.throwIfAborted(); if (result) { connected = true; currentTransport = createTransport(); } return result; },
      async stop() { stops++; connected = false; },
    };
    const setSetup = (active: boolean, method = "Target.targetCreated") => {
      if (active) { targets.set(setupId, setupInfo); emit(method, { targetInfo: setupInfo }); }
      else { targets.delete(setupId); emit("Target.targetDestroyed", { targetId: setupId }); }
    };
    return { edge, commands, calls, targets, emit, base, setupId, setSetup, setProof: (value: typeof proof) => { proof = value; }, setReconnect: (value: typeof reconnect) => { reconnect = value; }, setHook: (value: typeof hook) => { hook = value; }, disconnect: () => { connected = false; }, get proofCalls() { return proofCalls; }, get reconnectCalls() { return reconnectCalls; }, get stops() { return stops; }, get listeners() { return transports.reduce((sum, transport) => sum + transport.events.size, 0); } };
  }
  const browser = createNativeLiepinBrowser({ profileDirectory: "C:/owned-synthetic-native-lifecycle", inspectProfileOccupancy: async () => "clear", networkMode: "managed-proxy", verifyManagedProxy: options.verifyManagedProxy ?? (async () => true), launch: async () => {
    const value = edgeFixture(launches.length + 1); launches.push(value); return value.edge;
  } });
  const open = async (): Promise<NativeLiepinPage> => { const page = await browser.acquire(proxy, signal()); await page.navigate(source, signal()); return page; };
  return { browser, launches, open };
}

test("native factory reads and releases two independent targets in the same persistent browser", async () => {
  const f = fixture();
  try {
    const first = await f.open(); const a = await first.capture(signal()); assert.equal(a.state, "ready"); assert.match(a.snapshot!.html, /CYCLE_job-1-1/);
    await first.release(); assert.equal(first.closed, true); assert.equal(f.browser.hasUnclosed!(), false); assert.equal(f.launches[0]!.targets.size, 1);
    const second = await f.open(); const b = await second.capture(signal()); assert.equal(b.state, "ready"); assert.match(b.snapshot!.html, /CYCLE_job-1-2/); assert.doesNotMatch(b.snapshot!.html, /CYCLE_job-1-1/);
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0]!.stops, 0); assert.equal(f.launches[0]!.proofCalls, 0);
    await first.release(); assert.equal(second.closed, false); assert.equal((await second.capture(signal())).state, "ready");
    await second.release(); assert.equal(f.launches[0]!.targets.size, 1);
  } finally { await f.browser.stop(); }
});

test("native original Liepin capture requests optional whitespace evidence without changing the ordinary fifteen-column path", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const owned = f.launches[0]!;
    owned.setHook((method, _params, session) => {
      if (method === "DOM.getDocument") return { root: { nodeType: 9, backendNodeId: 1, documentURL: source, compatibilityMode: "NoQuirksMode", frameId: `main-${session!.slice("session:".length)}` } };
    });
    await page.capture(signal(), 1000, source);
    const scoped = owned.calls.filter(call => call.method === "DOMSnapshot.captureSnapshot").at(-1)!;
    assert.deepEqual(scoped.params.computedStyles, [...NATIVE_LIEPIN_PARAGRAPH_STYLES]);
    assert.equal(scoped.params.includeDOMRects, true); assert.equal(scoped.params.includeTextColorOpacities, true);
    await page.capture(signal());
    const ordinary = owned.calls.filter(call => call.method === "DOMSnapshot.captureSnapshot").at(-1)!;
    assert.deepEqual(ordinary.params.computedStyles, [...NATIVE_SNAPSHOT_STYLES]);
    await page.capture(signal(), 1000, source.replace("1984701079", "1999999999"));
    const different = owned.calls.filter(call => call.method === "DOMSnapshot.captureSnapshot").at(-1)!;
    assert.deepEqual(different.params.computedStyles, [...NATIVE_SNAPSHOT_STYLES]);
    await page.release();
  } finally { await f.browser.stop(); }
});

test("native disconnection without an exit proof retains the page and refuses a replacement browser", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const old = f.launches[0]!; old.disconnect();
    assert.equal(await f.browser.recoverExited!(), false); assert.equal(f.browser.hasUnclosed!(), true);
    await assert.rejects(page.release()); await assert.rejects(f.open());
    assert.equal(f.launches.length, 1); assert.equal(old.stops, 0); assert.equal(old.reconnectCalls, 0); assert.ok(old.proofCalls >= 1);
    old.setProof(async () => { throw new Error("fixture OS inspection failed"); });
    assert.equal(await f.browser.recoverExited!(), false); assert.equal(f.browser.hasUnclosed!(), true); assert.equal(old.stops, 0);
  } finally { await f.browser.stop(); }
});

test("an idle native browser reconnects its owned transport and captures only a newly navigated job", async () => {
  const f = fixture();
  try {
    const first = await f.open(); const oldSnapshot = await first.capture(signal()); await first.release();
    const owned = f.launches[0]!; const oldCdp = owned.edge.cdp; owned.disconnect();
    const before = owned.calls.length;
    const next = await f.open(); const fresh = await next.capture(signal());
    assert.equal(owned.reconnectCalls, 1); assert.equal(f.launches.length, 1); assert.equal(owned.stops, 0);
    assert.notEqual(owned.edge.cdp, oldCdp); assert.equal(oldCdp.connected, false);
    assert.equal(fresh.state, "ready"); assert.notEqual(fresh.snapshot!.html, oldSnapshot.snapshot!.html);
    assert.equal(next.inspect().mainDocumentRequests, 1);
    const recovery = owned.calls.slice(before);
    assert.equal(recovery.some(call => call.method === "Target.closeTarget"), false);
    assert.equal(recovery.filter(call => call.method === "Target.attachToTarget" && call.params.targetId === owned.base).length, 1);
    assert.equal(recovery.filter(call => call.method === "Page.navigate").length, 1);
    await next.release();
  } finally { await f.browser.stop(); }
});

test("failed native idle reconnect retains ownership and never launches a replacement", async () => {
  for (const result of ["refused", "rejected"] as const) {
    const f = fixture();
    try {
      const first = await f.open(); await first.release(); const owned = f.launches[0]!;
      owned.disconnect(); owned.setReconnect(async () => { if (result === "rejected") throw new Error("fixture OS proof failed"); return false; });
      const commands = owned.calls.length;
      await assert.rejects(f.open()); await assert.rejects(f.open());
      assert.equal(owned.reconnectCalls, 1); assert.equal(f.launches.length, 1); assert.equal(owned.stops, 0);
      assert.equal(f.browser.hasUnclosed!(), true); assert.equal(owned.calls.length, commands);
    } finally { await f.browser.stop(); }
  }
});

test("idle reconnect refuses missing, changed or additional targets without closing or creating a page", async () => {
  for (const kind of ["missing", "navigated", "extra-page", "setup"] as const) {
    const f = fixture();
    try {
      const first = await f.open(); await first.release(); const owned = f.launches[0]!;
      if (kind === "missing") owned.targets.delete(owned.base);
      else if (kind === "navigated") owned.targets.get(owned.base)!.url = source;
      else owned.targets.set("unexpected", { targetId: "unexpected", type: "page", url: kind === "setup" ? "edge://sync-confirmation-dialog/" : source });
      const beforeTargets = JSON.stringify([...owned.targets]); owned.disconnect(); const commands = owned.calls.length;
      await assert.rejects(f.open());
      assert.equal(owned.reconnectCalls, 1); assert.equal(f.launches.length, 1); assert.equal(f.browser.hasUnclosed!(), true);
      assert.equal(JSON.stringify([...owned.targets]), beforeTargets);
      assert.equal(owned.calls.slice(commands).some(call => ["Target.closeTarget", "Target.createTarget", "Target.attachToTarget"].includes(call.method)), false, kind);
    } finally { await f.browser.stop(); }
  }
});

test("managed idle recovery preserves non-page background targets while opening a fresh job", async () => {
  const f = fixture();
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!;
    owned.targets.set("background", { targetId: "background", type: "background_page", url: "extension://builtin/background.html" });
    owned.targets.set("worker", { targetId: "worker", type: "service_worker", url: "extension://builtin/worker.js" });
    owned.disconnect(); const before = owned.calls.length;
    const next = await f.open(); assert.equal((await next.capture(signal())).state, "ready");
    assert.equal(owned.targets.has("background"), true); assert.equal(owned.targets.has("worker"), true);
    assert.equal(owned.calls.slice(before).some(call => call.method === "Target.closeTarget"), false);
    await next.release();
  } finally { await f.browser.stop(); }
});

test("idle reconnect rechecks the base after protocol setup before creating a new job", async () => {
  const f = fixture();
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!; owned.disconnect();
    owned.setHook(method => {
      if (method === "Target.setDiscoverTargets") owned.targets.set("late-page", { targetId: "late-page", type: "page", url: source });
    });
    const before = owned.calls.length; await assert.rejects(f.open());
    assert.equal(owned.targets.has("late-page"), true); assert.equal(f.browser.hasUnclosed!(), true);
    assert.equal(owned.calls.slice(before).some(call => ["Target.closeTarget", "Target.createTarget"].includes(call.method)), false);
  } finally { await f.browser.stop(); }
});

test("idle reconnect refuses an extra page in the last readiness query without closing it or creating a job", async () => {
  const f = fixture();
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!; owned.disconnect();
    let queries = 0;
    owned.setHook(method => {
      if (method === "Target.getTargets" && ++queries === 4) owned.targets.set("last-query-page", { targetId: "last-query-page", type: "page", url: source });
    });
    const before = owned.calls.length; await assert.rejects(f.open());
    assert.equal(queries, 4); assert.equal(owned.targets.has("last-query-page"), true); assert.equal(f.browser.hasUnclosed!(), true);
    assert.equal(owned.calls.slice(before).some(call => ["Target.closeTarget", "Target.createTarget"].includes(call.method)), false);
  } finally { await f.browser.stop(); }
});

test("idle recovery does not reset failed, setup or different-proxy browsers", async () => {
  for (const kind of ["failed", "setup", "proxy"] as const) {
    const f = fixture();
    try {
      const first = await f.open(); await first.release(); const owned = f.launches[0]!;
      if (kind === "failed") owned.emit("Target.targetDestroyed", { targetId: owned.base });
      if (kind === "setup") owned.setSetup(true);
      owned.disconnect();
      await assert.rejects(f.browser.acquire(kind === "proxy" ? "http://127.0.0.1:17892" : proxy, signal()));
      assert.equal(owned.reconnectCalls, 0); assert.equal(f.launches.length, 1); assert.equal(owned.stops, 0);
    } finally { await f.browser.stop(); }
  }
});

test("concurrent idle acquisition reserves one reconnect and one new target", async () => {
  const f = fixture();
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!; owned.disconnect();
    const reconnect = deferred<boolean>(); owned.setReconnect(() => reconnect.promise);
    const opening = f.open(); await turn(); const before = owned.calls.length;
    await assert.rejects(f.open()); assert.equal(owned.reconnectCalls, 1); assert.equal(f.browser.hasUnclosed!(), true);
    reconnect.resolve(true); const next = await opening;
    assert.equal(owned.calls.slice(before).filter(call => call.method === "Target.createTarget").length, 1);
    assert.equal((await next.capture(signal())).state, "ready"); await next.release();
  } finally { await f.browser.stop(); }
});

test("a stop during idle reconnect keeps the late connection from creating a job or surviving shutdown", async () => {
  const f = fixture();
  const first = await f.open(); await first.release(); const owned = f.launches[0]!; owned.disconnect();
  const reconnect = deferred<boolean>(); owned.setReconnect(() => reconnect.promise);
  const opening = assert.rejects(f.open()); await turn(); const before = owned.calls.length;
  const stopping = f.browser.stop(); await turn(); assert.equal(owned.stops, 0);
  reconnect.resolve(true); await opening; await stopping;
  assert.equal(owned.stops, 1); assert.equal(owned.edge.alive, false); assert.equal(f.browser.hasUnclosed!(), false);
  assert.equal(owned.calls.slice(before).some(call => call.method === "Target.createTarget"), false);
  const next = await f.open(); assert.equal(f.launches.length, 2); await next.release(); await f.browser.stop();
});

test("cancelled idle reconnect never creates a page or treats partial recovery as healthy", async () => {
  for (const phase of ["connection", "protocol"] as const) {
    const f = fixture();
    try {
      const first = await f.open(); await first.release(); const owned = f.launches[0]!; owned.disconnect();
      const pending = deferred<boolean>(); const protocol = deferred<unknown>(); let queries = 0;
      if (phase === "connection") owned.setReconnect(() => pending.promise);
      else owned.setHook(method => method === "Target.getTargets" && ++queries === 3 ? protocol.promise : undefined);
      const controller = new AbortController();
      const reason = new Error(`fixture cancelled ${phase}`);
      const opening = assert.rejects(f.browser.acquire(proxy, controller.signal), error => error === reason);
      await turn(); const before = owned.calls.length; controller.abort(reason);
      if (phase === "connection") pending.resolve(true);
      else protocol.resolve({ targetInfos: [...owned.targets.values()] });
      await opening;
      assert.equal(f.browser.hasUnclosed!(), true); assert.equal(f.launches.length, 1);
      assert.equal(owned.calls.slice(before).some(call => call.method === "Target.createTarget"), false);
      await assert.rejects(f.open()); assert.equal(owned.reconnectCalls, 1);
    } finally { await f.browser.stop(); }
  }
});

test("old base failures cannot poison the same browser after an idle transport reconnect", async () => {
  for (const phase of ["during", "after"] as const) {
    const f = fixture();
    try {
      const first = await f.open(); const owned = f.launches[0]!; const late = deferred<unknown>();
      owned.setHook(method => method === "Fetch.failRequest" ? late.promise : undefined);
      owned.emit("Fetch.requestPaused", { requestId: "late-idle-base" }, `session:${owned.base}`);
      await first.release(); owned.disconnect();
      if (phase === "during") owned.setReconnect(async () => { late.reject(new Error("fixture closing old transport")); await turn(); return true; });
      const next = await f.open();
      if (phase === "after") late.reject(new Error("fixture old base transport failure"));
      await turn(); assert.equal((await next.capture(signal())).state, "ready");
      await next.release(); assert.equal(f.browser.hasUnclosed!(), false); assert.equal(owned.listeners, 2);
    } finally { await f.browser.stop(); }
  }
});

test("an old network verification failure rejects its caller without poisoning the reconnected transport", async () => {
  let blockNext = false;
  const entered = deferred<void>(); const oldVerification = deferred<boolean>();
  const f = fixture({ verifyManagedProxy: async () => { if (blockNext) { blockNext = false; entered.resolve(); return oldVerification.promise; } return true; } });
  try {
    const first = await f.open(); const owned = f.launches[0]!;
    blockNext = true;
    const verifying = assert.rejects(first.verifyNetwork!(signal())); await entered.promise;
    await first.release(); owned.disconnect();
    const next = await f.open(); assert.equal((await next.capture(signal())).state, "ready");
    oldVerification.resolve(false); await verifying;
    assert.equal((await next.capture(signal())).state, "ready");
    await next.release(); assert.equal(f.browser.hasUnclosed!(), false);
  } finally { oldVerification.resolve(false); await f.browser.stop(); }
});

test("late network verification from a released lease rejects without poisoning a subsequent lease on the same transport", async () => {
  for (const method of ["verifyNetwork", "current"] as const) for (const result of [false, true]) {
    let blockNext = false;
    const entered = deferred<void>(); const oldVerification = deferred<boolean>();
    const f = fixture({ verifyManagedProxy: async () => { if (blockNext) { blockNext = false; entered.resolve(); return oldVerification.promise; } return true; } });
    try {
      const first = await f.open(); const captured = await first.capture(signal()); const owned = f.launches[0]!; const cdp = owned.edge.cdp;
      blockNext = true;
      const verifying = assert.rejects(method === "verifyNetwork" ? first.verifyNetwork!(signal()) : first.current(captured.identity!, signal()));
      await entered.promise; await first.release();
      const next = await f.open(); assert.equal(owned.edge.cdp, cdp); assert.equal((await next.capture(signal())).state, "ready");
      oldVerification.resolve(result); await verifying;
      assert.equal((await next.capture(signal())).state, "ready");
      assert.equal(owned.reconnectCalls, 0); assert.equal(f.launches.length, 1);
      await next.release(); assert.equal(f.browser.hasUnclosed!(), false);
    } finally { oldVerification.resolve(false); await f.browser.stop(); }
  }
});

test("a current lease network rejection still blocks capture after the route becomes available again", async () => {
  for (const method of ["verifyNetwork", "current"] as const) {
    let approved = true;
    const f = fixture({ verifyManagedProxy: async () => approved });
    try {
      const page = await f.open(); const captured = await page.capture(signal()); approved = false;
      await assert.rejects(method === "verifyNetwork" ? page.verifyNetwork!(signal()) : page.current(captured.identity!, signal()));
      approved = true; await assert.rejects(page.capture(signal())); assert.equal(f.browser.hasUnclosed!(), true);
      await page.release(); assert.equal(f.browser.hasUnclosed!(), true);
    } finally { await f.browser.stop(); }
  }
});

test("stop during the acquire proxy preflight waits and prevents the stale acquisition from creating a page", async () => {
  let blockNext = false;
  const entered = deferred<void>(); const preflight = deferred<boolean>();
  const f = fixture({ verifyManagedProxy: async () => { if (blockNext) { blockNext = false; entered.resolve(); return preflight.promise; } return true; } });
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!; blockNext = true;
    const rejected = assert.rejects(f.browser.acquire(proxy, signal())); await entered.promise;
    let stopped = false; const stop = f.browser.stop().then(() => { stopped = true; }); await turn();
    assert.equal(stopped, false); assert.equal(owned.stops, 0);
    const before = owned.calls.length; preflight.resolve(true); await rejected; await stop;
    assert.equal(owned.stops, 1); assert.equal(f.browser.hasUnclosed!(), false);
    assert.equal(owned.calls.slice(before).some(call => call.method === "Target.createTarget"), false);
    assert.deepEqual([...owned.targets.keys()], [owned.base]);
  } finally { preflight.resolve(true); await f.browser.stop(); }
});

test("stop during target creation waits for the acquisition and closes its exact late target", async () => {
  let pauseNext = false;
  const entered = deferred<string>(); const creation = deferred<void>();
  const f = fixture({ targetCreationPause: async id => { if (pauseNext) { pauseNext = false; entered.resolve(id); await creation.promise; } } });
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!; pauseNext = true;
    const rejected = assert.rejects(f.browser.acquire(proxy, signal())); const lateId = await entered.promise;
    assert.equal(owned.targets.has(lateId), true);
    let stopped = false; const stop = f.browser.stop().then(() => { stopped = true; }); await turn();
    assert.equal(stopped, false); assert.equal(owned.stops, 0);
    creation.resolve(); await rejected; await stop;
    assert.equal(owned.stops, 1); assert.equal(f.browser.hasUnclosed!(), false); assert.equal(owned.targets.has(lateId), false);
    assert.equal(owned.calls.filter(call => call.method === "Target.closeTarget" && call.params.targetId === lateId).length, 1);
    assert.deepEqual([...owned.targets.keys()], [owned.base]);
  } finally { creation.resolve(); await f.browser.stop(); }
});

test("native confirmed exit retires old leases locally and reopens the same factory without stopping a live browser", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const old = f.launches[0]!; old.disconnect(); old.setProof(async () => true);
    await page.release(); assert.equal(f.browser.hasUnclosed!(), false); assert.equal(old.listeners, 0); assert.equal(old.stops, 0);
    const commands = old.commands.length; const next = await f.open(); assert.equal(f.launches.length, 2); assert.equal((await next.capture(signal())).state, "ready");
    await page.release(); assert.equal(old.commands.length, commands); assert.equal(next.closed, false);
    await assert.rejects(page.current("old", signal())); await assert.rejects(page.verifyNetwork!(signal()));
    assert.equal((await next.capture(signal())).state, "ready"); await next.release();
  } finally { await f.browser.stop(); }
});

test("native readiness reclaims a confirmed exited idle browser and deduplicates concurrent proof", async () => {
  const f = fixture();
  try {
    const page = await f.open(); await page.release(); const old = f.launches[0]!; old.disconnect();
    const proof = deferred<boolean>(); old.setProof(() => proof.promise);
    const a = f.browser.recoverExited!(), b = f.browser.recoverExited!(); assert.equal(a, b); assert.equal(old.proofCalls, 1);
    const opening = f.open(); await turn(); assert.equal(f.launches.length, 1);
    proof.resolve(true); assert.equal(await a, true); const next = await opening;
    assert.equal(f.launches.length, 2); assert.equal((await next.capture(signal())).state, "ready"); assert.equal(old.stops, 0); await next.release();
  } finally { await f.browser.stop(); }
});

test("native recovery cannot clear a concurrently stopped browser or affect its successor", async () => {
  const f = fixture();
  const page = await f.open(); await page.release(); const old = f.launches[0]!; old.disconnect();
  const proof = deferred<boolean>(); old.setProof(() => proof.promise);
  const recovering = f.browser.recoverExited!(); const stopping = f.browser.stop(); await stopping;
  proof.resolve(true); assert.equal(await recovering, false); const next = await f.open();
  assert.equal(f.launches.length, 2); assert.equal((await next.capture(signal())).state, "ready");
  await next.release(); await f.browser.stop();
});

test("native recovery ignores old base and popup failures after the new browser is ready", async () => {
  for (const kind of ["base", "popup"] as const) {
    const f = fixture();
    try {
      await f.open(); const old = f.launches[0]!; const late = deferred<unknown>();
      old.setHook((method) => method === (kind === "base" ? "Fetch.failRequest" : "Target.getTargets") ? late.promise : undefined);
      if (kind === "base") old.emit("Fetch.requestPaused", { requestId: "late-base" }, `session:${old.base}`);
      else old.emit("Target.targetCreated", { targetInfo: { targetId: "late-popup", type: "page", url: source, openerId: "job-1-1" } });
      old.disconnect(); old.setProof(async () => true); assert.equal(await f.browser.recoverExited!(), true);
      const next = await f.open(); late.reject(new Error("fixture old transport failed late")); await turn();
      assert.equal((await next.capture(signal())).state, "ready", kind); assert.equal(next.inspect().blockedPopups, 0); await next.release();
    } finally { await f.browser.stop(); }
  }
});

test("browser-account setup preserves the fresh browser and resumes the same instance after manual completion", async () => {
  const f = fixture({ setupInitially: true });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.open(), error => error instanceof NativeBrowserSetupRequiredError && error.failure.code === "browser_setup_required");
      assert.equal(f.browser.hasUnclosed!(), false, "setup without a job lease is an idle owned browser");
      assert.equal(f.launches.length, 1); assert.equal(f.launches[0]!.stops, 0);
      assert.equal(f.launches[0]!.commands.includes("Target.createTarget"), false);
      assert.equal(f.launches[0]!.commands.includes("Target.closeTarget"), false);
      assert.equal(f.launches[0]!.commands.includes("Target.attachToTarget"), false);
    }
    f.launches[0]!.setSetup(false);
    const page = await f.open(); assert.equal(f.launches.length, 1); assert.equal((await page.capture(signal())).state, "ready");
    await page.release(); assert.equal(f.browser.hasUnclosed!(), false);
  } finally { await f.browser.stop(); }
});

test("delayed setup events retain active job ownership and neither close nor capture the browser dialog", async () => {
  for (const event of ["Target.targetCreated", "Target.targetInfoChanged"]) {
    const f = fixture();
    try {
      const page = await f.open(); const owned = f.launches[0]!; owned.setSetup(true, event); await turn();
      assert.equal(f.browser.hasUnclosed!(), true, "an existing job lease remains reserved");
      const capturesBefore = owned.commands.filter(method => method === "DOMSnapshot.captureSnapshot").length;
      await assert.rejects(page.capture(signal()), NativeBrowserSetupRequiredError);
      await assert.rejects(page.verifyNetwork!(signal()), NativeBrowserSetupRequiredError);
      assert.equal(owned.commands.filter(method => method === "DOMSnapshot.captureSnapshot").length, capturesBefore);
      assert.equal(owned.calls.some(call => call.method === "Target.closeTarget" && call.params.targetId === owned.setupId), false);
      assert.equal(owned.calls.some(call => call.method === "Target.attachToTarget" && call.params.targetId === owned.setupId), false);
      owned.setSetup(false); assert.equal((await page.capture(signal())).state, "ready");
      await page.release(); const next = await f.open(); assert.equal(f.launches.length, 1); await next.release();
    } finally { await f.browser.stop(); }
  }
});

test("a delayed setup target found by a later authoritative query can resume an already initialized idle browser", async () => {
  const f = fixture();
  try {
    const first = await f.open(); await first.release(); const owned = f.launches[0]!;
    owned.targets.set(owned.setupId, { targetId: owned.setupId, type: "page", url: "edge://sync-confirmation-dialog/" });
    await assert.rejects(f.open(), NativeBrowserSetupRequiredError);
    assert.equal(f.browser.hasUnclosed!(), false); assert.equal(f.launches.length, 1);
    owned.targets.delete(owned.setupId);
    const second = await f.open(); assert.equal((await second.capture(signal())).state, "ready"); await second.release();
  } finally { await f.browser.stop(); }
});

test("setup cannot unlock a failed base or disconnected browser and explicit stop still closes its owner", async () => {
  const f = fixture();
  const page = await f.open(); const owned = f.launches[0]!;
  owned.setSetup(true); owned.emit("Target.targetDestroyed", { targetId: owned.base }); await page.release();
  await assert.rejects(f.open(), error => error instanceof Error && !(error instanceof NativeBrowserSetupRequiredError));
  assert.equal(f.browser.hasUnclosed!(), true); assert.equal(f.launches.length, 1);
  await f.browser.stop(); assert.equal(owned.stops, 1); assert.equal(f.browser.hasUnclosed!(), false);
  const pending = fixture({ setupInitially: true });
  await assert.rejects(pending.open(), NativeBrowserSetupRequiredError); pending.launches[0]!.disconnect();
  await assert.rejects(pending.open(), error => error instanceof Error && !(error instanceof NativeBrowserSetupRequiredError));
  assert.equal(pending.launches.length, 1); await pending.browser.stop(); assert.equal(pending.launches[0]!.stops, 1);
});

test("setup arriving during the final current-frame check cannot be adopted", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const initial = await page.capture(signal()); const owned = f.launches[0]!;
    owned.setHook(method => { if (method === "Page.getFrameTree") { owned.setHook(undefined); owned.setSetup(true); } return undefined; });
    await assert.rejects(page.current(initial.identity!, signal()), NativeBrowserSetupRequiredError);
    owned.setSetup(false); assert.equal((await page.capture(signal())).state, "ready"); await page.release();
  } finally { await f.browser.stop(); }
});

test("an event arriving inside a setup query is not cleared by the stale target response", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const owned = f.launches[0]!; owned.setSetup(true);
    owned.setHook(method => {
      if (method === "Target.getTargets") {
        owned.setHook(undefined); const stale = [...owned.targets.values()].filter(target => target.targetId !== owned.setupId);
        owned.setSetup(true, "Target.targetInfoChanged"); return { targetInfos: stale };
      }
      return undefined;
    });
    await assert.rejects(page.capture(signal()), NativeBrowserSetupRequiredError);
    owned.setSetup(false); await page.release();
  } finally { await f.browser.stop(); }
});

test("an old setup query cannot mutate the replacement browser after explicit stop", async () => {
  const f = fixture();
  try {
    const oldPage = await f.open(); const old = f.launches[0]!; old.setSetup(true); const pending = deferred<unknown>();
    old.setHook(method => { if (method === "Target.getTargets") { old.setHook(undefined); return pending.promise; } return undefined; });
    const oldCapture = oldPage.capture(signal()); await turn(); await f.browser.stop();
    const next = await f.open(); const replacement = f.launches[1]!; replacement.setSetup(true);
    pending.resolve({ targetInfos: [{ targetId: old.base, type: "page", url: "about:blank" }] }); await assert.rejects(oldCapture);
    await assert.rejects(next.capture(signal()), NativeBrowserSetupRequiredError);
    replacement.setSetup(false); await next.release();
  } finally { await f.browser.stop(); }
});

test("a blank popup that becomes exact browser setup while its close query is pending is preserved", async () => {
  const f = fixture();
  try {
    const page = await f.open(); const owned = f.launches[0]!;
    owned.targets.set(owned.setupId, { targetId: owned.setupId, type: "page", url: "about:blank" });
    owned.setHook(method => {
      if (method === "Target.getTargets") {
        owned.setHook(undefined); const stale = [...owned.targets.values()]; owned.setSetup(true, "Target.targetInfoChanged"); return { targetInfos: stale };
      }
      return undefined;
    });
    owned.emit("Target.targetCreated", { targetInfo: { targetId: owned.setupId, type: "page", url: "about:blank" } }); await turn();
    assert.equal(owned.calls.some(call => call.method === "Target.closeTarget" && call.params.targetId === owned.setupId), false);
    await assert.rejects(page.capture(signal()), NativeBrowserSetupRequiredError);
    owned.setSetup(false); assert.equal((await page.capture(signal())).state, "ready"); await page.release();
  } finally { await f.browser.stop(); }
});

test("a startup legacy target becoming browser setup before close is preserved and can resume", async () => {
  const f = fixture({ setupDuringStartupClose: true });
  try {
    await assert.rejects(f.open(), NativeBrowserSetupRequiredError); const owned = f.launches[0]!;
    assert.equal(owned.calls.some(call => call.method === "Target.closeTarget" && call.params.targetId === owned.setupId), false);
    assert.equal(f.browser.hasUnclosed!(), false); owned.setSetup(false);
    const page = await f.open(); assert.equal(f.launches.length, 1); assert.equal((await page.capture(signal())).state, "ready"); await page.release();
  } finally { await f.browser.stop(); }
});
