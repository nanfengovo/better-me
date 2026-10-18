import assert from "node:assert/strict";
import test from "node:test";
import { createNativeTargetPolicy } from "../server/jd-native-target-policy.ts";
import type { CdpObject, NativeCdp, NativeCdpEvent } from "../server/jd-native-cdp.ts";

type Call = { method: string; params: CdpObject; session?: string };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const listeners = new Set<(event: NativeCdpEvent) => void>();
  const calls: Call[] = []; const targets = new Map<string, string>([["base", "about:blank"]]);
  const targetTypes = new Map<string, string>([["base", "page"]]);
  const issues: { url: string; type: string }[] = [];
  const setups: string[] = [];
  let popups = 0; let sockets = 0; let failures = 0; let closeAccepted = true; let keepTarget = false;
  let hook: ((call: Call) => Promise<unknown> | unknown) | undefined;
  const emit = (event: NativeCdpEvent) => { for (const listener of [...listeners]) listener(event); };
  const cdp: NativeCdp = {
    connected: true,
    async send<T = CdpObject>(method: string, params: CdpObject = {}, session?: string): Promise<T> {
      const call = { method, params, session }; calls.push(call);
      if (hook) { const result = await hook(call); if (result !== undefined) return result as T; }
      if (method === "Target.getTargets") return { targetInfos: [...targets].map(([targetId, url]) => ({ targetId, url, type: targetTypes.get(targetId) ?? "page" })) } as T;
      if (method === "Target.closeTarget") { if (!keepTarget) targets.delete(params.targetId as string); return { success: closeAccepted } as T; }
      return {} as T;
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); }, close() {},
  };
  const policy = createNativeTargetPolicy(cdp, "base", {
    allow: (url) => url.startsWith("https://allowed.invalid/"),
    onIssue: (url, type) => issues.push({ url, type }), onPopup: () => { popups++; }, onBlockedSocket: () => { sockets++; }, onFailure: () => { failures++; },
    onSetup: id => setups.push(id),
  });
  const attached = (id: string, type = "page", options: { url?: string; openerId?: string; parent?: string; waiting?: boolean; session?: string } = {}) => {
    const url = options.url ?? "about:blank"; targets.set(id, url); targetTypes.set(id, type);
    emit({ method: "Target.attachedToTarget", ...(options.parent ? { sessionId: options.parent } : {}), params: { sessionId: options.session ?? `s-${id}`, targetInfo: { targetId: id, type, url, ...(options.openerId ? { openerId: options.openerId } : {}) }, waitingForDebugger: options.waiting ?? true } });
  };
  return { policy, calls, targets, issues, setups, attached, emit, get popups() { return popups; }, get sockets() { return sockets; }, get failures() { return failures; },
    listenerCount: () => listeners.size, hook: (value: typeof hook) => { hook = value; }, accepted: (value: boolean) => { closeAccepted = value; }, keep: (value: boolean) => { keepTarget = value; } };
}

test("policy listener precedes browser auto attach, ignores base, and claims events arriving in either order", async () => {
  const f = fixture();
  f.hook((call) => {
    if (call.method === "Target.setAutoAttach" && !call.session) { assert.equal(f.listenerCount(), 1); f.attached("base"); }
  });
  try {
    await f.policy.install();
    const install = f.calls[0];
    assert.equal(install.params.waitForDebuggerOnStart, true); assert.equal(install.params.flatten, true);
    assert.deepEqual(install.params.filter, [{ type: "page" }, { type: "shared_worker" }, { type: "service_worker" }, { type: "iframe" }, { type: "worker" }, { exclude: true }]);
    assert.equal(f.calls.some(call => call.session === "s-base"), false);
    f.attached("job-first"); assert.equal(f.policy.healthy, false);
    assert.deepEqual(await f.policy.claim("job-first"), { sessionId: "s-job-first" });
    const waiting = f.policy.claim("job-later"); await tick(); f.attached("job-later");
    assert.deepEqual(await waiting, { sessionId: "s-job-later" }); await f.policy.settled(); assert.equal(f.policy.healthy, true);
    for (const id of ["job-first", "job-later"]) {
      const methods = f.calls.filter(call => call.session === `s-${id}`).map(call => call.method);
      assert.deepEqual(methods, ["Network.enable", "Network.setBlockedURLs", "Network.setBypassServiceWorker", "Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    }
    assert.equal(f.calls.some(call => ["Runtime.enable", "Runtime.evaluate", "Console.enable", "Log.enable"].includes(call.method)), false);
  } finally { f.policy.dispose(); }
});

test("worker and OOPIF policy acknowledges fetch and recursive attach before the sole Runtime resume", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job");
    let nested = false;
    f.hook((call) => { if (!nested && call.session === "s-worker" && call.method === "Target.setAutoAttach") { nested = true; f.attached("nested", "worker", { url: "blob:https://allowed.invalid/nested", parent: "s-worker" }); } });
    for (const type of ["worker", "iframe", "shared_worker"]) f.attached(type, type, { url: `https://allowed.invalid/${type}.js`, parent: "s-job" });
    await f.policy.settled(); assert.equal(f.policy.healthy, true); assert.equal(nested, true);
    for (const id of ["worker", "iframe", "shared_worker", "nested"]) {
      const calls = f.calls.filter(call => call.session === `s-${id}`); const methods = calls.map(call => call.method);
      assert.ok(methods.indexOf("Fetch.enable") < methods.indexOf("Target.setAutoAttach"));
      assert.ok(methods.indexOf("Target.setAutoAttach") < methods.indexOf("Runtime.runIfWaitingForDebugger"));
      assert.equal(methods.includes("Network.setBypassServiceWorker"), id === "iframe");
    }
  } finally { f.policy.dispose(); }
});

test("popup is denied before close and counted only after actual disappearance, even if acceptance is false", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job"); f.accepted(false);
    f.attached("popup", "page", { url: "https://forbidden.invalid/popup", openerId: "job", parent: "s-job" });
    await f.policy.settled(); assert.equal(f.popups, 1); assert.equal(f.targets.has("popup"), false); assert.equal(f.targets.has("base"), true);
    const deny = f.calls.findIndex(call => call.session === "s-popup" && call.method === "Network.setBlockedURLs");
    const fetch = f.calls.findIndex(call => call.session === "s-popup" && call.method === "Fetch.enable");
    const close = f.calls.findIndex(call => call.method === "Target.closeTarget" && call.params.targetId === "popup");
    assert.deepEqual(f.calls[deny].params.urls, ["*"]); assert.ok(deny < close && fetch < close);
    assert.equal(f.calls.some(call => call.session === "s-popup" && call.method === "Runtime.runIfWaitingForDebugger"), false);
  } finally { f.policy.dispose(); }
});

test("a popup close acceptance without base survival is not counted as a confirmed close", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job");
    f.hook(call => { if (call.method === "Target.closeTarget" && call.params.targetId === "popup") f.targets.delete("base"); });
    f.attached("popup", "page", { url: "https://forbidden.invalid/popup", openerId: "job" });
    await assert.rejects(f.policy.settled());
    assert.equal(f.targets.has("popup"), false); assert.equal(f.popups, 0); assert.equal(f.failures, 1); assert.equal(f.policy.healthy, false);
    assert.equal(f.calls.some(call => call.session === "s-popup" && call.method === "Runtime.runIfWaitingForDebugger"), false);
  } finally { f.policy.dispose(); }
});

test("browser-level auxiliary attachment inherits a denied opener without a parent session", async () => {
  const f = fixture(); let childCreated = false;
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job");
    f.hook(call => {
      if (!childCreated && call.session === "s-popup" && call.method === "Fetch.enable") {
        childCreated = true; f.attached("popup-worker", "worker", { url: "https://allowed.invalid/worker.js", openerId: "popup" });
      }
    });
    f.attached("popup", "page", { url: "https://forbidden.invalid/popup", openerId: "job" });
    await f.policy.settled(); assert.equal(f.policy.healthy, true); assert.equal(childCreated, true);
    assert.deepEqual(f.calls.find(call => call.session === "s-popup-worker" && call.method === "Network.setBlockedURLs")?.params.urls, ["*"]);
    assert.equal(f.calls.some(call => call.session === "s-popup-worker" && call.method === "Runtime.runIfWaitingForDebugger"), false);
    assert.equal(f.targets.has("popup-worker"), false); assert.equal(f.popups, 1);
  } finally { f.policy.dispose(); }
});

test("service workers are denied and confirmed closed without any Runtime resume", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("sw", "service_worker", { url: "https://allowed.invalid/sw.js" });
    await f.policy.settled(); assert.equal(f.policy.healthy, true); assert.equal(f.targets.has("sw"), false);
    assert.deepEqual(f.calls.find(call => call.session === "s-sw" && call.method === "Network.setBlockedURLs")?.params.urls, ["*"]);
    assert.ok(f.calls.some(call => call.session === "s-sw" && call.method === "Fetch.enable"));
    assert.equal(f.calls.some(call => call.session === "s-sw" && call.method.startsWith("Runtime.")), false);
    assert.equal(f.popups, 0);
  } finally { f.policy.dispose(); }
});

test("an unconfirmed service worker close fails adoption without resuming it for a retry", async () => {
  const f = fixture(); let closeAttempted = false;
  try {
    await f.policy.install(); f.keep(true);
    f.hook(call => {
      if (call.method === "Target.closeTarget" && call.params.targetId === "sw") closeAttempted = true;
      if (call.method === "Target.getTargets" && closeAttempted) throw new Error("query unavailable");
    });
    f.attached("sw", "service_worker", { url: "https://allowed.invalid/sw.js" });
    await assert.rejects(f.policy.settled()); assert.equal(f.policy.healthy, false); assert.equal(f.failures, 1);
    assert.equal(f.targets.has("sw"), true); assert.equal(f.popups, 0);
    assert.equal(f.calls.filter(call => call.method === "Target.closeTarget" && call.params.targetId === "sw").length, 1);
    assert.equal(f.calls.some(call => call.session === "s-sw" && call.method.startsWith("Runtime.")), false);
  } finally { f.policy.dispose(); }
});

test("configuration rejection fails closed, does not resume, and later resources are denied", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job");
    f.hook((call) => { if (call.session === "s-worker" && call.method === "Fetch.enable") throw new Error("REMOTE_PRIVATE_DETAIL"); });
    f.attached("worker", "worker", { url: "https://allowed.invalid/worker.js", parent: "s-job" });
    await assert.rejects(f.policy.settled(), error => error instanceof Error && !error.message.includes("REMOTE_PRIVATE_DETAIL"));
    assert.equal(f.policy.healthy, false); assert.equal(f.failures, 1);
    assert.equal(f.calls.some(call => call.session === "s-worker" && call.method === "Runtime.runIfWaitingForDebugger"), false);
    f.emit({ method: "Fetch.requestPaused", sessionId: "s-job", params: { requestId: "r", resourceType: "Script", request: { url: "https://allowed.invalid/script.js" } } });
    await tick(); assert.ok(f.calls.some(call => call.method === "Fetch.failRequest" && call.params.requestId === "r"));
  } finally { f.policy.dispose(); }
});

test("only permitted resource requests are continued and only confirmed blocked websocket failures are counted", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("job"); await f.policy.claim("job");
    for (const [id, url, resourceType] of [["allowed", "https://allowed.invalid/code.js", "Script"], ["denied", "https://forbidden.invalid/code.js", "Script"], ["other", "https://forbidden.invalid/other", "Other"]]) {
      f.emit({ method: "Fetch.requestPaused", sessionId: "s-job", params: { requestId: id, request: { url }, resourceType } });
    }
    for (const id of ["blocked", "normal", "unknown"]) if (id !== "unknown") f.emit({ method: "Network.webSocketCreated", sessionId: "s-job", params: { requestId: id } });
    for (const [id, errorText] of [["blocked", "net::ERR_BLOCKED_BY_CLIENT"], ["normal", "net::ERR_CONNECTION_REFUSED"], ["unknown", "net::ERR_BLOCKED_BY_CLIENT"]]) f.emit({ method: "Network.loadingFailed", sessionId: "s-job", params: { requestId: id, errorText } });
    await f.policy.settled(); assert.equal(f.sockets, 1);
    assert.deepEqual(f.issues, [{ url: "https://forbidden.invalid/code.js", type: "script" }]);
    assert.ok(f.calls.some(call => call.method === "Fetch.continueRequest" && call.params.requestId === "allowed"));
    assert.ok(f.calls.some(call => call.method === "Fetch.failRequest" && call.params.requestId === "other"));
  } finally { f.policy.dispose(); }
});

test("unclaimed blank page closes after the claim window while extension targets are only detached", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("unclaimed");
    f.attached("extension", "service_worker", { url: "chrome-extension://anonymous/background.js" });
    await f.policy.settled(); assert.equal(f.targets.has("unclaimed"), false); assert.equal(f.targets.has("extension"), true);
    assert.equal(f.calls.filter(call => call.session === "s-extension").length, 0);
    assert.ok(f.calls.some(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-extension"));
    assert.equal(f.popups, 0); assert.equal(f.failures, 0);
  } finally { f.policy.dispose(); }
});

test("the exact Edge browser-account setup page is only detached from our auto session", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("setup", "page", { url: "edge://sync-confirmation-dialog/" }); await f.policy.settled();
    assert.equal(f.targets.has("setup"), true); assert.equal(f.policy.healthy, true);
    assert.deepEqual(f.calls.filter(call => call.params.sessionId === "s-setup" || call.session === "s-setup" || call.params.targetId === "setup"), [{ method: "Target.detachFromTarget", params: { sessionId: "s-setup" }, session: undefined }]);
    assert.equal(f.popups, 0); assert.equal(f.failures, 0);
  } finally { f.policy.dispose(); }
});

test("similar browser setup URLs, other internal pages and non-page targets retain normal denial", async () => {
  for (const [type, url] of [["page", "edge://sync-confirmation-dialog/?extra=1"], ["page", "edge://sync-confirmation-dialog/other"], ["page", "edge://settings/"], ["page", "chrome://sync-confirmation-dialog/"], ["service_worker", "edge://sync-confirmation-dialog/"]]) {
    const f = fixture();
    try {
      await f.policy.install(); f.attached("other", type, { url }); await f.policy.settled();
      assert.equal(f.targets.has("other"), false);
      assert.ok(f.calls.some(call => call.session === "s-other" && call.method === "Fetch.enable"));
      assert.equal(f.calls.some(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-other"), false);
      assert.equal(f.calls.some(call => call.session === "s-other" && call.method.startsWith("Runtime.")), false);
    } finally { f.policy.dispose(); }
  }
});

test("a blank unclaimed target becoming browser setup cancels its timer and detaches without configuration", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("setup");
    f.targets.set("setup", "edge://sync-confirmation-dialog/");
    f.emit({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "setup", type: "page", url: "edge://sync-confirmation-dialog/" } } });
    await f.policy.settled(); assert.equal(f.policy.healthy, true); assert.equal(f.targets.has("setup"), true);
    assert.equal(f.calls.some(call => call.session === "s-setup"), false);
    assert.ok(f.calls.some(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-setup"));
  } finally { f.policy.dispose(); }
});

test("a denied popup becoming browser setup in an await stops later configuration and Runtime commands", async () => {
  const f = fixture();
  try {
    await f.policy.install();
    f.hook(call => {
      if (call.method === "Network.enable" && call.session === "s-setup") {
        f.targets.set("setup", "edge://sync-confirmation-dialog/");
        f.emit({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "setup", type: "page", url: "edge://sync-confirmation-dialog/" } } });
      }
    });
    f.attached("setup", "page", { url: "about:blank", openerId: "job" }); await f.policy.settled();
    assert.equal(f.policy.healthy, true); assert.equal(f.targets.has("setup"), true);
    assert.deepEqual(f.calls.filter(call => call.session === "s-setup").map(call => call.method), ["Network.enable"]);
    assert.ok(f.calls.some(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-setup"));
    assert.equal(f.calls.some(call => call.method === "Target.closeTarget" && call.params.targetId === "setup"), false);
  } finally { f.policy.dispose(); }
});

test("a close query discovering exact setup preserves it and detaches the denied auto session", async () => {
  const f = fixture();
  try {
    await f.policy.install(); let firstQuery = true;
    f.hook(call => { if (call.method === "Target.getTargets" && firstQuery) { firstQuery = false; f.targets.set("setup", "edge://sync-confirmation-dialog/"); } });
    f.attached("setup", "page", { url: "about:blank", openerId: "job" }); await f.policy.settled();
    assert.equal(f.policy.healthy, true); assert.equal(f.targets.has("setup"), true);
    assert.equal(f.calls.some(call => call.method === "Target.closeTarget" && call.params.targetId === "setup"), false);
    assert.equal(f.calls.some(call => call.session === "s-setup" && call.method.startsWith("Runtime.")), false);
    assert.ok(f.calls.some(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-setup"));
    assert.deepEqual(f.setups, ["setup"], "factory is notified even without a target-info event");
  } finally { f.policy.dispose(); }
});

test("setup conversion during Runtime resume preserves once and does not poison policy health", async () => {
  const f = fixture();
  try {
    await f.policy.install();
    f.hook(call => { if (call.method === "Runtime.runIfWaitingForDebugger" && call.session === "s-job") {
      f.targets.set("job", "edge://sync-confirmation-dialog/");
      f.emit({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "job", type: "page", url: "edge://sync-confirmation-dialog/" } } });
    } });
    f.attached("job"); await assert.rejects(f.policy.claim("job")); await f.policy.settled();
    assert.equal(f.policy.healthy, true); assert.equal(f.failures, 0); assert.equal(f.targets.has("job"), true);
    assert.equal(f.calls.filter(call => call.method === "Target.detachFromTarget" && call.params.sessionId === "s-job").length, 1);
    assert.deepEqual(f.setups, ["job"]);
  } finally { f.policy.dispose(); }
});

test("existing nonpaused worker receives the barrier but cannot be reported as controlled from its first request", async () => {
  const f = fixture();
  try {
    await f.policy.install(); f.attached("old-worker", "worker", { waiting: false, url: "https://allowed.invalid/old-worker.js" });
    await assert.rejects(f.policy.settled()); assert.equal(f.policy.healthy, false);
    assert.ok(f.calls.some(call => call.session === "s-old-worker" && call.method === "Fetch.enable"));
    assert.equal(f.calls.some(call => call.session === "s-old-worker" && call.method === "Runtime.runIfWaitingForDebugger"), false);
  } finally { f.policy.dispose(); }
});

test("dispose prevents a late setup completion from resuming a target and removes all listeners", async () => {
  const f = fixture(); const stalled = deferred<CdpObject>();
  try {
    await f.policy.install();
    f.hook((call) => call.session === "s-job" && call.method === "Fetch.enable" ? stalled.promise : undefined);
    f.attached("job"); const claiming = f.policy.claim("job"); await tick();
    f.policy.dispose(); stalled.resolve({});
    await assert.rejects(claiming); assert.equal(f.listenerCount(), 0); assert.equal(f.policy.healthy, false);
    assert.equal(f.calls.some(call => call.session === "s-job" && call.method === "Runtime.runIfWaitingForDebugger"), false);
    await assert.rejects(f.policy.settled());
  } finally { f.policy.dispose(); }
});
