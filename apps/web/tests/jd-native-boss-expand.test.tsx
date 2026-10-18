import assert from "node:assert/strict";
import test from "node:test";
import { performBossDescriptionExpansion } from "../server/jd-native-boss-expand.ts";
import type { CdpObject, NativeCdp } from "../server/jd-native-cdp.ts";
import type { BossExpandPlan } from "../server/jd-boss-expand.ts";

type PlanCapture = { plan: BossExpandPlan; identity: string; frameId: string };
type Call = { method: string; params: CdpObject; sessionId?: string };
const identity = "same-owned-document/request-1/loader-1";
function plan(): PlanCapture {
  return { identity, frameId: "main-frame", plan: { controlBackendNodeId: 20, descriptionBackendNodeId: 10, hitBackendNodeIds: [20, 21] } };
}
function fixture() {
  const controller = new AbortController(); const calls: Call[] = []; const captures: string[] = [];
  const state = {
    connected: true,
    plans: [plan(), plan()] as Array<PlanCapture | undefined>,
    currents: [true, true],
    currentGeneration: true,
    metrics: { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0 }, cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, scale: 1 } } as CdpObject,
    quads: { quads: [[100, 200, 180, 200, 180, 228, 100, 228]] } as CdpObject,
    hit: { backendNodeId: 21, frameId: "main-frame" } as CdpObject,
    hook: undefined as ((stage: string, params?: CdpObject) => unknown) | undefined,
  };
  const cdp: NativeCdp = {
    get connected() { return state.connected; },
    send<T = CdpObject>(method: string, params: CdpObject = {}, sessionId?: string): Promise<T> {
      calls.push({ method, params, sessionId });
      const override = state.hook?.(method, params);
      if (override !== undefined) return Promise.resolve(override) as Promise<T>;
      return Promise.resolve(method === "Page.getLayoutMetrics" ? state.metrics : method === "DOM.getContentQuads" ? state.quads : method === "DOM.getNodeForLocation" ? state.hit : {}) as Promise<T>;
    },
    on() { return () => {}; }, close() { state.connected = false; },
  };
  let captured = 0; let checked = 0;
  const options = { cdp, sessionId: "owned-job-session", signal: controller.signal, expectedIdentity: identity,
    async capturePlan() { const stage = `capture-${++captured}`; captures.push(stage); state.hook?.(stage); return state.plans[captured - 1]; },
    async current(value: string) { assert.equal(value, identity); const stage = `current-${++checked}`; captures.push(stage); state.hook?.(stage); return state.currents[checked - 1]!; },
    isCurrent(value: string) { assert.equal(value, identity); state.hook?.("is-current"); return state.currentGeneration; },
  };
  return { state, controller, calls, captures, options, run: () => performBossDescriptionExpansion(options),
    inputs: () => calls.filter(call => call.method === "Input.dispatchMouseEvent") };
}

test("ordinary expansion scrolls, revalidates, and submits exactly one CSS-coordinate click to the owned session", async () => {
  const f = fixture();
  // Legacy pixel metrics deliberately differ by 2x. They must never scale CSS quads.
  f.state.metrics.layoutViewport = { clientWidth: 2000, clientHeight: 1400 };
  assert.equal(await f.run(), true);
  assert.deepEqual(f.captures, ["capture-1", "current-1", "capture-2", "current-2"]);
  assert.deepEqual(f.calls.map(call => call.method), ["DOM.scrollIntoViewIfNeeded", "Page.getLayoutMetrics", "DOM.getContentQuads", "DOM.getNodeForLocation", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
  assert.ok(f.calls.every(call => call.sessionId === "owned-job-session"));
  assert.deepEqual(f.calls[0]!.params, { backendNodeId: 20 });
  assert.deepEqual(f.calls[3]!.params, { x: 140, y: 214, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
  assert.deepEqual(f.inputs().map(call => call.params), [
    { type: "mousePressed", x: 140, y: 214, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", x: 140, y: 214, button: "left", buttons: 0, clickCount: 1 },
  ]);
});

test("scrolled pages hit-test CSS document coordinates while input keeps CSS viewport coordinates without DPI multiplication", async () => {
  const f = fixture();
  f.state.metrics = {
    cssLayoutViewport: { clientWidth: 1000, clientHeight: 900, pageX: 0, pageY: 333 },
    cssVisualViewport: { clientWidth: 1000, clientHeight: 900, pageX: 0, pageY: 333, offsetX: 0, offsetY: 0, scale: 1 },
    layoutViewport: { clientWidth: 2000, clientHeight: 1800, pageX: 0, pageY: 666 },
  };
  f.state.quads = { quads: [[24, 775, 104, 775, 104, 803, 24, 803]] };
  f.state.hook = (stage, params) => {
    if (stage === "DOM.getNodeForLocation") return { backendNodeId: params?.x === 64 && params.y === 1122 ? 21 : 999, frameId: "main-frame" };
  };
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls.find(call => call.method === "DOM.getNodeForLocation")!.params, { x: 64, y: 1122, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
  assert.deepEqual(f.inputs().map(call => [call.params.x, call.params.y]), [[64, 789], [64, 789]]);
});

test("missing, invalid, excessive or inconsistent CSS page scroll evidence rejects without hit-testing or input", async () => {
  for (const column of ["cssLayoutViewport", "cssVisualViewport"]) {
    for (const property of ["pageX", "pageY"]) {
      for (const value of [undefined, null, NaN, Infinity, -1, 10_000_001]) {
        const f = fixture(); (f.state.metrics[column] as CdpObject)[property] = value;
        assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
        assert.equal(f.calls.filter(call => call.method === "DOM.getNodeForLocation").length, 0);
      }
      const f = fixture(); (f.state.metrics[column] as CdpObject)[property] = 333;
      assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
    }
  }
});

test("missing or changed source, frame, description, control or hit ownership rejects without input", async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.plans[0] = undefined; },
    f => { f.state.plans[0]!.identity = "different-source"; },
    f => { f.state.plans[1] = undefined; },
    f => { f.state.plans[1]!.identity = "new-loader"; },
    f => { f.state.plans[1]!.frameId = "other-frame"; },
    f => { f.state.plans[1]!.plan.controlBackendNodeId = 22; f.state.plans[1]!.plan.hitBackendNodeIds = [22, 21]; },
    f => { f.state.plans[1]!.plan.descriptionBackendNodeId = 11; },
    f => { f.state.plans[1]!.plan.hitBackendNodeIds = [20, 22]; },
    f => { f.state.currents[0] = false; },
    f => { f.state.currents[1] = false; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
  }
});

test("malformed node plans and disconnected or missing owned sessions never scroll or click", async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.connected = false; },
    f => { f.options.sessionId = ""; },
    f => { f.options.expectedIdentity = ""; },
    f => { f.state.plans[0]!.frameId = ""; },
    f => { f.state.plans[0]!.plan.controlBackendNodeId = NaN; },
    f => { f.state.plans[0]!.plan.descriptionBackendNodeId = 20; },
    f => { f.state.plans[0]!.plan.hitBackendNodeIds = [21]; },
    f => { f.state.plans[0]!.plan.hitBackendNodeIds = [20, 20]; },
    f => { f.state.plans[0]!.plan.hitBackendNodeIds = [20, -1]; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f); assert.equal(await f.run(), false); assert.equal(f.calls.length, 0);
  }
});

test("overlay, wrong-frame, unknown or absent hit nodes never receive an input event", async () => {
  for (const hit of [{ backendNodeId: 999, frameId: "main-frame" }, { backendNodeId: 20, frameId: "iframe" }, {}, { backendNodeId: "20", frameId: "main-frame" }]) {
    const f = fixture(); f.state.hit = hit;
    assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
  }
});

test("a control that moved during scroll uses its new CSS quad, with a fresh actual hit", async () => {
  const f = fixture(); f.state.hook = stage => { if (stage === "capture-2") f.state.quads = { quads: [[200, 300, 280, 300, 280, 328, 200, 328]] }; };
  assert.equal(await f.run(), true);
  assert.equal(f.inputs()[0]!.params.x, 240); assert.equal(f.inputs()[0]!.params.y, 314);
  const moved = fixture(); moved.state.hook = stage => { if (stage === "DOM.getNodeForLocation") moved.state.hit = { backendNodeId: 999, frameId: "main-frame" }; };
  assert.equal(await moved.run(), false); assert.equal(moved.inputs().length, 0);
});

test("overlay appearing during the final asynchronous identity check is hit-tested before click", async () => {
  const f = fixture();
  f.state.hook = stage => { if (stage === "current-2") f.state.hit = { backendNodeId: 999, frameId: "main-frame" }; };
  assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
  assert.equal(f.calls.filter(call => call.method === "DOM.getNodeForLocation").length, 1);
});

test("generation invalidation while the final hit request resolves prevents the click synchronously", async () => {
  const f = fixture();
  f.state.hook = stage => { if (stage === "DOM.getNodeForLocation") f.state.currentGeneration = false; };
  assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
});

test("a final synchronous guard failure, disconnect or cancellation cannot submit input", async () => {
  for (const mode of ["false", "throw", "disconnect", "cancel"]) {
    const f = fixture(); const reason = new Error("cancel at synchronous identity guard");
    f.state.hook = stage => {
      if (stage !== "is-current") return;
      if (mode === "false") f.state.currentGeneration = false;
      if (mode === "throw") throw new Error("event identity unavailable");
      if (mode === "disconnect") f.state.connected = false;
      if (mode === "cancel") f.controller.abort(reason);
    };
    if (mode === "cancel") await assert.rejects(f.run(), error => error === reason);
    else assert.equal(await f.run(), false);
    assert.equal(f.inputs().length, 0);
  }
});

test("unsupported or clipped quads, unknown CSS viewport, and zoom never use guessed coordinates", async () => {
  const quads: unknown[] = [[], [[0, 0, 10, 0, 10, 10, 0, 10], [20, 0, 30, 0, 30, 10, 20, 10]], [[-1, 0, 10, 0, 10, 10, -1, 10]], [[0, 690, 20, 690, 20, 710, 0, 710]], [[0, 0, 20, 1, 20, 10, 0, 10]], [[0, 0, 1, 0, 1, 10, 0, 10]], [[0, 0, NaN, 0, 20, 10, 0, 10]], [[0, 0, 20, 0, 20, 10, 0]]];
  for (const value of quads) { const f = fixture(); f.state.quads = { quads: value }; assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0); }
  const metrics: CdpObject[] = [{ layoutViewport: { clientWidth: 1000, clientHeight: 700 } }];
  for (const key of ["offsetX", "offsetY", "scale", "clientWidth", "clientHeight"]) {
    const f = fixture(); const visual = f.state.metrics.cssVisualViewport as CdpObject; visual[key] = key.startsWith("offset") ? 1 : key === "scale" ? 2 : 500;
    metrics.push(f.state.metrics);
  }
  for (const value of metrics) { const f = fixture(); f.state.metrics = value; assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0); }
});

test("abort at every precommit await propagates and sends no mouse event", async () => {
  const stages = ["capture-1", "current-1", "DOM.scrollIntoViewIfNeeded", "capture-2", "current-2", "Page.getLayoutMetrics", "DOM.getContentQuads", "DOM.getNodeForLocation"];
  for (const stage of stages) {
    const f = fixture(); const reason = new Error(`abort:${stage}`);
    f.state.hook = at => { if (at === stage) f.controller.abort(reason); };
    await assert.rejects(f.run(), error => error === reason); assert.equal(f.inputs().length, 0);
  }
  const f = fixture(); const reason = new Error("already cancelled"); f.controller.abort(reason);
  await assert.rejects(f.run(), error => error === reason); assert.equal(f.calls.length, 0); assert.equal(f.captures.length, 0);
});

test("protocol failures at each precommit step stop without input or retry", async () => {
  for (const stage of ["capture-1", "current-1", "DOM.scrollIntoViewIfNeeded", "capture-2", "current-2", "Page.getLayoutMetrics", "DOM.getContentQuads", "DOM.getNodeForLocation"]) {
    const f = fixture(); f.state.hook = at => { if (at === stage) throw new Error("synthetic transport failure"); };
    assert.equal(await f.run(), false); assert.equal(f.inputs().length, 0);
  }
});

test("press and release are queued together before either response and cancellation is reported after both settle", async () => {
  const f = fixture(); const reason = new Error("cancel after click commit");
  let settlePress: (() => void) | undefined; let settleRelease: (() => void) | undefined;
  f.state.hook = (stage, params) => {
    if (stage === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
      f.controller.abort(reason); return new Promise(resolve => { settlePress = () => resolve({}); });
    }
    if (stage === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") return new Promise(resolve => { settleRelease = () => resolve({}); });
  };
  const reading = f.run();
  // All preceding steps are bounded, resolved promises. No timers or real browser.
  for (let i = 0; i < 20 && !settleRelease; i++) await Promise.resolve();
  assert.ok(settlePress); assert.ok(settleRelease); assert.equal(f.inputs().length, 2);
  let done = false; const checked = assert.rejects(reading, error => error === reason).then(() => { done = true; });
  settlePress(); await Promise.resolve(); assert.equal(done, false);
  settleRelease(); await checked; assert.equal(f.inputs().length, 2);
});

test("input rejection or synchronous transport failure still settles the one submitted release without retries", async () => {
  for (const mode of ["press-reject", "release-reject", "press-throw"]) {
    const f = fixture();
    f.state.hook = (stage, params) => {
      if (stage !== "Input.dispatchMouseEvent") return;
      if (params?.type === "mousePressed" && mode === "press-throw") throw new Error("send failed");
      if (params?.type === (mode === "press-reject" ? "mousePressed" : "mouseReleased") && mode !== "press-throw") return Promise.reject(new Error("protocol input failed"));
    };
    assert.equal(await f.run(), false); assert.equal(f.inputs().length, 2);
  }
});

test("successful protocol submission does not pretend to prove effective expansion or read text", async () => {
  const f = fixture(); assert.equal(await f.run(), true);
  assert.equal(f.calls.filter(call => /Runtime|DOMSnapshot|Page.navigate/.test(call.method)).length, 0);
  // The factory must re-enter its normal complete-visible-text capture after this.
  assert.equal(f.inputs().length, 2); assert.equal(f.state.plans[1]!.plan.descriptionBackendNodeId, 10);
});
