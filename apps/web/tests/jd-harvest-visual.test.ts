import assert from "node:assert/strict";
import test from "node:test";
import { HarvestVisualRecovery, nativeVisualDriver, parseVisualAction, visualGate, type VisualPage, type VisualDriver } from "../server/jd-harvest-visual";
import { readComputerProposal } from "../server/jd-harvest-visual-runtime";
import type { NativeCdp } from "../server/jd-native-cdp";

const page = (): VisualPage => ({ url: "https://www.liepin.com/zhaopin/?key=rust", width: 1000, height: 700,
  gate: undefined, controls: [{ label: "重试", x: 400, y: 300, width: 100, height: 40 }] });
function fixture() {
  const calls: string[] = [];
  let current = page();
  const driver: VisualDriver = {
    observe: async () => { calls.push("observe"); return structuredClone(current); },
    screenshot: async () => { calls.push("screenshot"); return { base64: "synthetic", width: 1000, height: 700 }; },
    act: async () => { calls.push("act"); },
  };
  const recovery = new HarvestVisualRecovery({
    ocr: async () => [],
    propose: async () => { calls.push("model"); return { type: "click", button: "left", x: 450, y: 320 }; },
  });
  return { recovery, driver, calls, setPage: (value: VisualPage) => { current = value; } };
}
test("login and captcha stop before screenshot, OCR or cloud", async () => {
  const f = fixture(); f.setPage({ ...page(), gate: "verification" });
  assert.equal((await f.recovery.recover(f.driver, page().url, "liepin")).gate, "verification");
  assert.deepEqual(f.calls, ["observe"]);
  assert.equal(visualGate("请完成安全验证"), "verification");
  assert.equal(visualGate("请先登录再查看职位"), "login");
  assert.equal(visualGate("登录 注册 帮助"), undefined);
});
test("one safe browser action only; structural collector must verify afterwards", async () => {
  const f = fixture(); const result = await f.recovery.recover(f.driver, page().url, "liepin");
  assert.equal(result.changed, true); assert.equal(f.calls.filter(x => x === "act").length, 1);
  assert.ok(f.calls.lastIndexOf("observe") > f.calls.indexOf("model"));
  assert.equal((await f.recovery.recover(f.driver, page().url, "liepin")).changed, false, "unchanged input is never replayed");
  assert.equal((await f.recovery.recover(f.driver, page().url, "liepin")).changed, false);
});
test("unrelated route and untrusted controls cannot be operated", async () => {
  const f = fixture(); f.setPage({ ...page(), url: "https://www.liepin.com/apply" });
  assert.equal((await f.recovery.recover(f.driver, page().url, "liepin")).changed, false);
  assert.ok(!f.calls.includes("model"));
  const g = fixture(); g.setPage({ ...page(), controls: [{ ...page().controls[0]!, label: "下一页" }] });
  assert.equal((await g.recovery.recover(g.driver, page().url, "51job")).reason, "no-safe-control", "cannot skip an unread source page");
});

test("OCR detects visual captcha before any model transmission", async () => {
  let models = 0, actions = 0;
  const recovery = new HarvestVisualRecovery({ ocr: async () => [{ text: "请完成安全验证", confidence: .99, x: 1, y: 1, width: 50, height: 20 }],
    propose: async () => { models++; return {}; } });
  const f = fixture();
  const result = await recovery.recover({ ...f.driver, act: async () => { actions++; } }, page().url, "boss");
  assert.equal(result.gate, "verification"); assert.equal(models, 0); assert.equal(actions, 0);
});

test("shared reservation caps parallel providers and later keywords at four", async () => {
  let models = 0;
  const recovery = new HarvestVisualRecovery({ ocr: async () => [], propose: async () => { models++; return { type: "click", button: "left", x: 450, y: 320 }; } });
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, n) => recovery.recover(fixture().driver, page().url, `provider${n}`)));
  assert.equal(models, 4); assert.equal(outcomes.filter(value => value.changed).length, 4);
  assert.equal((await recovery.recover(fixture().driver, page().url, "keyword2")).reason, "budget");
});

test("computer screenshot handshakes use the same four-call budget, without executing input", async () => {
  let models = 0, actions = 0;
  const recovery = new HarvestVisualRecovery({ ocr: async () => [], propose: async (_image, _controls, _signal, context) => {
    models++;
    return context ? { type: "click", button: "left", x: 450, y: 320 }
      : { action: { type: "screenshot" }, continuation: { output: [], callId: "synthetic-call" } };
  } });
  const driver = () => ({ ...fixture().driver, act: async () => { actions++; } });
  const results = await Promise.all(["liepin", "boss", "51job"].map(provider => recovery.recover(driver(), page().url, provider)));
  assert.equal(models, 4); assert.equal(actions, 1);
  assert.equal(results.filter(value => value.changed).length, 1);
  assert.equal(recovery.usage.reservedCalls, 4);
});

test("moved control, changed page, new gate and cancellation reject stale model input", async () => {
  for (const change of ["moved", "gate", "route", "signature", "abort"] as const) {
    const f = fixture(); let actions = 0;
    const abort = new AbortController();
    const recovery = new HarvestVisualRecovery({ ocr: async () => [], propose: async () => {
      if (change === "moved") f.setPage({ ...page(), controls: [{ ...page().controls[0]!, x: 600 }] });
      if (change === "gate") f.setPage({ ...page(), gate: "login" });
      if (change === "route") f.setPage({ ...page(), url: "https://www.liepin.com/apply" });
      if (change === "signature") f.setPage({ ...page(), signature: 42 });
      if (change === "abort") abort.abort();
      return { type: "click", button: "left", x: 450, y: 320 };
    } });
    const result = await recovery.recover({ ...f.driver, act: async () => { actions++; } }, page().url, "liepin", abort.signal);
    assert.equal(result.changed, false, change); assert.equal(actions, 0, change);
  }
});

test("typing, unsafe click, giant scroll, multi-action and safety checks fail closed", async () => {
  for (const action of [{ type: "type", text: "credential" }, { type: "keypress", keys: ["ENTER"] },
    { type: "click", button: "left", x: 4, y: 5 }, { type: "click", button: "right", x: 450, y: 320 },
    { type: "scroll", x: 400, y: 300, scroll_x: 0, scroll_y: 99999 }]) {
    const f = fixture(); let actions = 0;
    const recovery = new HarvestVisualRecovery({ ocr: async () => [], propose: async () => action });
    assert.equal((await recovery.recover({ ...f.driver, act: async () => { actions++; } }, page().url, "liepin")).changed, false);
    assert.equal(actions, 0);
  }
  const call = { type: "computer_call", actions: [{ type: "click", button: "left", x: 1, y: 2 }] };
  assert.equal(readComputerProposal({ status: "completed", output: [{ ...call, actions: [...call.actions, ...call.actions] }] }), undefined);
  assert.equal(readComputerProposal({ status: "completed", output: [{ ...call, pending_safety_checks: [{ id: "check" }] }] }), undefined);
  assert.equal(readComputerProposal({ status: "completed", output: [{ ...call, pending_safety_checks: {} }] }), undefined);
  assert.deepEqual(readComputerProposal({ status: "completed", output: [call] }), call.actions[0]);
  assert.equal(parseVisualAction({ type: "click", button: "left", x: Number.NaN, y: 2 }), undefined);
});

test("OCR locates an unlabeled button but cannot invent controls or job evidence", async () => {
  let actions = 0, ocr = 0;
  const f = fixture(); f.setPage({ ...page(), controls: [{ ...page().controls[0]!, label: "" }] });
  const recovery = new HarvestVisualRecovery({ ocr: async () => { ocr++; return [{ text: "重试", confidence: .99, x: 420, y: 305, width: 50, height: 25 }]; },
    propose: async () => ({ type: "click", button: "left", x: 450, y: 320 }) });
  assert.equal((await recovery.recover({ ...f.driver, act: async () => { actions++; } }, page().url, "liepin")).changed, true);
  assert.equal(actions, 1); assert.equal(ocr, 2, "unlabeled OCR candidate is recognized again before input");
  const g = fixture(); g.setPage({ ...page(), controls: [] });
  assert.equal((await new HarvestVisualRecovery({ ocr: async () => [], propose: async () => { throw new Error("must not call"); } }).recover(g.driver, page().url, "boss")).reason, "no-safe-control");
});

test("ambiguous action failure is not automatically replayed", async () => {
  const f = fixture(); let actions = 0;
  const driver = { ...f.driver, act: async () => { actions++; throw new Error("unknown delivery"); } };
  assert.equal((await f.recovery.recover(driver, page().url, "liepin")).changed, false);
  assert.equal((await f.recovery.recover(driver, page().url, "liepin")).changed, false);
  assert.equal(actions, 1);
});

test("native driver dispatches browser input only, and releases the button on cancellation", async () => {
  const methods: string[] = []; const abort = new AbortController();
  const cdp = { send: async (method: string, params: Record<string, unknown>) => {
    methods.push(`${method}:${params.type ?? ""}`); if (params.type === "mousePressed") abort.abort(); return {};
  } } as unknown as NativeCdp;
  await nativeVisualDriver(cdp, "owned-session", abort.signal).act({ type: "click", button: "left", x: 10, y: 20 });
  assert.deepEqual(methods, ["Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});
