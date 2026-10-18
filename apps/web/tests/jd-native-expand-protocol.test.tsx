import test from "node:test";
import assert from "node:assert/strict";
import { createNativeCdp, type CdpObject } from "../server/jd-native-cdp.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

type Frame = { id: number; method: string; params: CdpObject; sessionId?: string };
class Socket extends EventTarget {
  readyState = 1;
  frames: Frame[] = [];
  send(text: string) { this.frames.push(JSON.parse(text) as Frame); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  reply(result: unknown = {}) { this.receive({ id: this.frames.at(-1)!.id, result }); }
}
const hit = { x: 10, y: 20, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false };
const press = { type: "mousePressed", x: 10.5, y: 20.25, button: "left", clickCount: 1, buttons: 1 };
const release = { ...press, type: "mouseReleased", buttons: 0 };
const operations: Array<[string, CdpObject]> = [
  ["DOM.scrollIntoViewIfNeeded", { backendNodeId: 42 }],
  ["DOM.getContentQuads", { backendNodeId: 42 }],
  ["DOM.getNodeForLocation", hit],
  ["Page.getLayoutMetrics", {}],
  ["Input.dispatchMouseEvent", press],
  ["Input.dispatchMouseEvent", release],
];
const unavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";
function fixture() {
  const socket = new Socket(); const cdp = createNativeCdp(socket);
  const attachEvent = (session = "owned-session", target = "owned-target") => socket.receive({ method: "Target.attachedToTarget", params: { sessionId: session, targetInfo: { targetId: target } } });
  const rejected = async (method: string, params: CdpObject, session?: string) => {
    const before = socket.frames.length;
    await assert.rejects(cdp.send(method, params, session), unavailable);
    assert.equal(socket.frames.length, before, `${method} must reject before sending`);
  };
  const accepted = async (method: string, params: CdpObject, session = "owned-session") => {
    const before = socket.frames.length; const pending = cdp.send(method, params, session);
    assert.equal(socket.frames.length, before + 1);
    assert.deepEqual(socket.frames.at(-1), { id: before + 1, method, params, sessionId: session });
    socket.reply({ confirmed: true }); assert.deepEqual(await pending, { confirmed: true });
  };
  return { socket, cdp, attachEvent, rejected, accepted };
}

test("native expansion commands require a confirmed attached session before every frame", async () => {
  const f = fixture();
  try {
    for (const [method, params] of operations) for (const session of [undefined, "", "owned-session"]) await f.rejected(method, params, session);
    f.socket.receive({ method: "Target.attachedToTarget", params: { sessionId: "malformed-session", targetInfo: null } });
    for (const [method, params] of operations) await f.rejected(method, params, "malformed-session");
    const pendingAttach = f.cdp.send("Target.attachToTarget", { targetId: "owned-target", flatten: true });
    for (const [method, params] of operations) await f.rejected(method, params, "owned-session");
    f.socket.reply({ sessionId: "owned-session" }); await pendingAttach;
    for (const [method, params] of operations) await f.accepted(method, params);
    for (const [method, params] of operations) await f.rejected(method, params, "other-session");
  } finally { f.cdp.close(); }
});

test("native expansion capability is revoked by detach event, detach acknowledgement, target destruction, and connection close", async () => {
  for (const mode of ["detach-event", "detach-command", "target-destroyed", "closed"]) {
    const f = fixture();
    try {
      f.attachEvent();
      for (const [method, params] of operations) await f.accepted(method, params);
      if (mode === "detach-event") f.socket.receive({ method: "Target.detachedFromTarget", params: { sessionId: "owned-session" } });
      if (mode === "detach-command") {
        const detach = f.cdp.send("Target.detachFromTarget", { sessionId: "owned-session" }); f.socket.reply(); await detach;
      }
      if (mode === "target-destroyed") f.socket.receive({ method: "Target.targetDestroyed", params: { targetId: "owned-target" } });
      if (mode === "closed") f.socket.close();
      for (const [method, params] of operations) await f.rejected(method, params, "owned-session");
    } finally { f.cdp.close(); }
  }
});

test("native expansion geometry accepts only a positive safe backend node identity and exact parameter keys", async () => {
  const f = fixture(); f.attachEvent();
  try {
    for (const method of ["DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads"]) {
      for (const backendNodeId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "42", null, undefined]) await f.rejected(method, { backendNodeId }, "owned-session");
      for (const params of [{}, { nodeId: 42 }, { objectId: "42" }, { backendNodeId: 42, rect: { x: 0, y: 0, width: 1, height: 1 } }, { backendNodeId: 42, nodeId: 42 }]) await f.rejected(method, params, "owned-session");
      await f.accepted(method, { backendNodeId: Number.MAX_SAFE_INTEGER });
    }
  } finally { f.cdp.close(); }
});

test("native expansion hit tests reject fractional coordinates, ignored pointer events, shadow traversal, and extra keys", async () => {
  const f = fixture(); f.attachEvent();
  try {
    for (const key of ["x", "y"]) for (const coordinate of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "10", null, undefined]) await f.rejected("DOM.getNodeForLocation", { ...hit, [key]: coordinate }, "owned-session");
    for (const params of [{}, { x: 10, y: 20 }, { ...hit, includeUserAgentShadowDOM: true }, { ...hit, ignorePointerEventsNone: true }, { ...hit, extra: false }]) await f.rejected("DOM.getNodeForLocation", params, "owned-session");
    await f.accepted("DOM.getNodeForLocation", { ...hit, x: 0, y: Number.MAX_SAFE_INTEGER });
  } finally { f.cdp.close(); }
});

test("native expansion mouse events permit only one ordinary left press and release with finite CSS coordinates", async () => {
  const f = fixture(); f.attachEvent();
  try {
    for (const type of ["mouseMoved", "mouseWheel", "mousePressed ", "touchStart", undefined]) await f.rejected("Input.dispatchMouseEvent", { ...press, type }, "owned-session");
    for (const key of ["x", "y"]) for (const coordinate of [-1, 1_000_000.1, NaN, Infinity, -Infinity, "10", null, undefined]) await f.rejected("Input.dispatchMouseEvent", { ...press, [key]: coordinate }, "owned-session");
    for (const params of [{}, { ...press, button: "right" }, { ...press, button: "none" }, { ...press, clickCount: 2 }, { ...press, clickCount: 0 }, { ...press, buttons: 0 }, { ...release, buttons: 1 }, { ...press, modifiers: 0 }, { ...press, pointerType: "mouse" }, { ...press, timestamp: 1 }]) await f.rejected("Input.dispatchMouseEvent", params, "owned-session");
    const missingButton = { ...press } as CdpObject; delete missingButton.button;
    await f.rejected("Input.dispatchMouseEvent", missingButton, "owned-session");
    await f.accepted("Input.dispatchMouseEvent", { ...press, x: 0, y: 1_000_000 });
    await f.accepted("Input.dispatchMouseEvent", release);
  } finally { f.cdp.close(); }
});

test("native layout metrics require no parameters and new capabilities reject non-object or hidden extra keys", async () => {
  const f = fixture(); f.attachEvent();
  try {
    await f.rejected("Page.getLayoutMetrics", { extra: false }, "owned-session");
    for (const [method, params] of operations) {
      for (const invalid of [null, [], "", 1]) await f.rejected(method, invalid as unknown as CdpObject, "owned-session");
      const hiddenExtra = Object.defineProperty({ ...params }, "extra", { value: false, enumerable: false });
      await f.rejected(method, hiddenExtra, "owned-session");
      await f.rejected(method, { ...params, [Symbol("extra")]: false }, "owned-session");
      const prototypeSerializer = Object.assign(Object.create({ toJSON: () => ({ unapproved: true }) }) as CdpObject, params);
      await f.rejected(method, prototypeSerializer, "owned-session");
    }
    const accessor = Object.defineProperty({}, "backendNodeId", { enumerable: true, get: () => 42 });
    await f.rejected("DOM.getContentQuads", accessor, "owned-session");
    const hiddenRequired = Object.defineProperty({}, "backendNodeId", { enumerable: false, value: 42 });
    await f.rejected("DOM.getContentQuads", hiddenRequired, "owned-session");
    await f.accepted("Page.getLayoutMetrics", {});
  } finally { f.cdp.close(); }
});

test("ordinary expansion adds no JavaScript evaluation, DOM mutation, keyboard, touch, or drag capability", async () => {
  const f = fixture(); f.attachEvent();
  try {
    for (const method of ["Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn", "DOM.setAttributeValue", "DOM.setOuterHTML", "DOM.removeNode", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchTouchEvent", "Input.dispatchDragEvent", "Console.enable", "Log.enable"]) await f.rejected(method, {}, "owned-session");
    assert.equal(f.socket.frames.length, 0);
  } finally { f.cdp.close(); }
});
