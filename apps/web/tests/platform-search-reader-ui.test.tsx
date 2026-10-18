import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { buildPlatformSearchRequest, type PlatformSearchRequest } from "@better-me/source-adapters/browser-contracts";
import { extractJobSearchCards } from "../server/jd-search-capture.ts";
import { OPPORTUNITY_STORAGE_KEY } from "../src/lib/opportunities.ts";
import type { JdBrowserSessionInspection } from "../src/lib/jd-import.ts";

// Synthetic rendered HTML is parsed by the production card parser, then delivered
// through the real HTTP client to a mounted React panel. No platform is contacted.
const dom = new Window({ url: "http://platform-reader-fixture.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, localStorage: dom.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { PlatformSearchSessionPanel } = await import("../src/components/atlas/PlatformSearchSessionPanel.tsx");
type PanelProps = Parameters<typeof PlatformSearchSessionPanel>[0];
type Call = { path: string; body: Record<string, any>; init?: RequestInit };
const at = "2026-10-18T12:00:00.000Z";
const plan = (keyword = "C#", regionId = "cn-shanghai") => buildPlatformSearchRequest({ provider: "liepin", keyword, regionId });
const original = plan();
const sessionId = "synthetic-search-session-12345";
const session = (request = original) => ({ sessionId, platform: request.platform, url: request.url, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
const ready = (request = original) => ({ ...extractJobSearchCards({ url: request.url, title: "Synthetic original-site search", html: `<main>
  <article class="job-card-pc-container"><a class="job-title" href="https://www.liepin.com/job/1234567890.shtml">Synthetic C# Engineer</a>
  <span class="company-name">Synthetic Employer</span><span class="job-dq-box">上海</span><span class="job-salary">20-30k·13薪</span>
  <time class="job-publish-time">2 小时前发布</time><p>卡片可见摘要，未读取完整 JD。</p></article>
  <article class="job-card-pc-container"><a class="job-title" href="https://www.liepin.com/job/1234567891.shtml">Synthetic Unknown Fields</a>
  <p>仅标题和摘要，没有薪资、地点、企业与发布时间。</p></article>
  </main>` }, "猎聘"), capturedAt: at });
const gate = (status: "login_required" | "verification_required") => ({ ...extractJobSearchCards({ url: original.url, title: "Synthetic gate", html: "", gate: status }, "猎聘"), capturedAt: at });
const inspection = (overrides: Partial<JdBrowserSessionInspection> = {}): JdBrowserSessionInspection => ({
  snapshotState: "ready", pageState: "unknown", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 },
  scriptErrors: 0, mainDocument: { state: "response", status: 200 }, resources: [], truncated: false, blockedPopups: 0, blockedSockets: 0,
  ...overrides,
});
let root: ReturnType<typeof createRoot> | undefined;
let lastProps: PanelProps;

async function waitFor(condition: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `Timed out: ${description}: ${dom.document.body.textContent?.slice(-1700)}`);
    await act(async () => { await delay(10); });
  }
}
async function render(requests: PlatformSearchRequest[] = [original], onReviewCard?: PanelProps["onReviewCard"]) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  lastProps = { requests, onReviewCard };
  await act(async () => root!.render(h(PlatformSearchSessionPanel, lastProps)));
}
function button(label: string | RegExp) {
  const match = [...dom.document.querySelectorAll("button")].find((node) => typeof label === "string" ? node.textContent?.trim() === label : label.test(node.textContent ?? ""));
  assert.ok(match, `Missing button: ${label}`); return match;
}
async function click(label: string | RegExp) { await act(async () => button(label).click()); }
function installFetch(handler?: (call: Call, calls: Call[]) => Promise<Response> | Response) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(url), body: JSON.parse(String(init?.body)), init }; calls.push(call);
    if (handler) return handler(call, calls);
    if (call.body.action === "start") return response(session(buildPlatformSearchRequest(call.body.input)));
    if (call.body.action === "read") return response(ready());
    if (call.body.action === "cancel-start") return response({ cancelled: true, closed: true });
    if (call.body.action === "close") return response({ closed: true });
    if (call.body.action === "focus") return response({ activationRequested: true });
    throw new Error(`Unexpected synthetic call: ${call.body.action}`);
  });
  return calls;
}
async function startReady() {
  await click("搜索并读取当前页");
  await waitFor(() => Boolean(dom.document.querySelector(".atlas-platform-card-list li")), "actual parsed cards");
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  mock.restoreAll(); dom.localStorage.clear(); dom.document.body.replaceChildren();
});
after(() => {
  hooks.deregister(); dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("start uses actual client requests and renders parsed card source, raw publication and unknown fields without inventing a full JD", async () => {
  const calls = installFetch(); await render(); assert.equal(calls.length, 0);
  await startReady();
  assert.deepEqual(calls.map((entry) => [entry.path, entry.body.action]), [["/api/jd/search-session", "start"], ["/api/jd/search-session", "read"]]);
  assert.deepEqual(calls[0]!.body.input, { provider: "liepin", keyword: "C#", regionId: "cn-shanghai" });
  assert.equal(calls[1]!.body.sessionId, sessionId);
  const cards = [...dom.document.querySelectorAll(".atlas-platform-card-list > li")]; assert.equal(cards.length, 2);
  assert.match(cards[0]!.textContent!, /Synthetic Employer.*上海.*20-30k·13薪/s);
  const source = cards[0]!.querySelector("a.job-source-badge")!;
  assert.equal(source.textContent, "猎聘"); assert.equal(source.getAttribute("href"), "https://www.liepin.com/job/1234567890.shtml");
  assert.equal(source.getAttribute("rel"), "noopener noreferrer");
  assert.equal(cards[0]!.querySelector('[data-publication-precision="raw"]')?.getAttribute("title")?.includes("2 小时前发布"), true);
  assert.match(cards[0]!.querySelector("pre")!.textContent!, /卡片可见摘要，未读取完整 JD/);
  assert.match(cards[1]!.textContent!, /雇主待核对.*工作地点未披露.*薪资未披露/s);
  assert.ok(cards[1]!.querySelector('[data-publication-precision="unknown"]'));
  assert.equal(cards[1]!.querySelector("time[datetime]"), null);
  assert.equal(dom.document.querySelector("canvas"), null);
});

for (const status of ["login_required", "verification_required"] as const) {
  test(`${status} is an unresolved gate, preserves the same session and permits explicit reread after the user completes it`, async () => {
    let reads = 0;
    const calls = installFetch((call) => {
      if (call.body.action === "start") return response(session());
      if (call.body.action === "read") return response(++reads === 1 ? gate(status) : ready());
      return response({ closed: true, cancelled: true });
    });
    await render(); await click("搜索并读取当前页");
    await waitFor(() => Boolean(dom.document.querySelector('[role="status"]')), "gate disclosure");
    assert.match(dom.document.querySelector('[role="status"]')!.textContent!, status === "login_required" ? /原站需要登录/ : /原站需要人工验证/);
    assert.equal(dom.document.querySelector('[role="status"]')!.textContent!.includes("明确显示暂无结果"), false);
    assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 0);
    assert.equal(button("搜索并读取当前页").disabled, true);
    await click("再次读取当前页"); await waitFor(() => dom.document.querySelectorAll(".atlas-platform-card-list li").length === 2, "reread after gate");
    assert.equal(calls.filter((entry) => entry.body.action === "start").length, 1);
    assert.deepEqual(calls.filter((entry) => entry.body.action === "read").map((entry) => entry.body.sessionId), [sessionId, sessionId]);
  });
}

test("HTTP verification failure retains the live session instead of converting it to an empty result or opening another page", async () => {
  let reads = 0;
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return ++reads === 1
      ? response({ failure: { code: "verification_required", stage: "page", message: "Synthetic 原站需要人工验证" } }, 422)
      : response(ready());
    return response({ closed: true, cancelled: true });
  });
  await render(); await click("搜索并读取当前页"); await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "structured gate error");
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /原站需要人工验证/);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(button("搜索并读取当前页").disabled, true);
  await click("再次读取当前页"); await waitFor(() => Boolean(dom.document.querySelector(".atlas-platform-card-list li")), "same-session retry");
  assert.equal(calls.filter((entry) => entry.body.action === "start").length, 1);
});

test("page inspection resumes the same failed-read session and original scope, reports its login gate and permits rereading", async () => {
  let reads = 0;
  const calls = installFetch(call => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return ++reads === 1
      ? response({ failure: { code: "unsupported_page", stage: "page", message: "Synthetic 搜索结果尚未读取完成" } }, 422)
      : response(ready());
    if (call.body.action === "inspect") return response(inspection({ pageState: "platform_intermediate", gate: "login_required" }));
    return response({ cancelled: true, closed: true });
  });
  await render();
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === "检查页面状态"), false);
  await click("搜索并读取当前页"); await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "failed-read session");
  await render([plan("Python", "cn-beijing")]); await click("检查页面状态");
  await waitFor(() => Boolean(dom.document.querySelector('[aria-label="搜索页面状态检查结果"]')), "original session inspection");
  const diagnostic = dom.document.querySelector('[aria-label="搜索页面状态检查结果"]')!;
  assert.match(diagnostic.textContent!, /页面状态检查已完成/);
  assert.match(diagnostic.textContent!, /平台中转、登录或验证页面/);
  assert.match(diagnostic.textContent!, /当前页面要求登录.*自行完成后再次读取当前页/);
  assert.match(dom.document.body.textContent!, /本次搜索：猎聘 · C# · 上海/);
  assert.equal(diagnostic.textContent!.includes("0 岗"), false);
  assert.deepEqual(calls.filter(entry => entry.body.action === "inspect").map(entry => [entry.path, entry.body]),
    [["/api/jd/browser-session", { action: "inspect", sessionId }]]);
  await click("再次读取当前页"); await waitFor(() => dom.document.querySelectorAll(".atlas-platform-card-list li").length === 2, "read after manual login");
  assert.equal(calls.filter(entry => entry.body.action === "start").length, 1);
  assert.deepEqual(calls.filter(entry => entry.body.action === "read").map(entry => entry.body.sessionId), [sessionId, sessionId]);
});

test("inspection displays fixed snapshot diagnostics without raw page data and clears them only after confirmed close", async () => {
  let closes = 0;
  installFetch(call => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return response(ready());
    if (call.body.action === "inspect") return response({ ...inspection({
      snapshotState: "failed", pageState: "unknown", pageLoad: { readyState: "unknown", content: "unknown", visibleFrames: 0 },
      snapshotFailure: { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" },
    }), url: "https://private-user:private-password@example.invalid/private-path", html: "<p>private-dom-fragment</p>", protocolError: "private-protocol-error" });
    return response({ cancelled: true, closed: ++closes > 1 });
  });
  await render(); await startReady(); await click("检查页面状态");
  await waitFor(() => Boolean(dom.document.querySelector('[aria-label="搜索页面状态检查结果"]')), "fixed snapshot failure");
  const diagnostic = dom.document.querySelector('[aria-label="搜索页面状态检查结果"]')!;
  assert.match(diagnostic.textContent!, /本次未能检查当前页面，登录或访问验证状态尚未确认/);
  assert.match(diagnostic.textContent!, /尚未确认当前页面类型/);
  assert.match(diagnostic.textContent!, /页面含有尚未支持的裁剪或文字布局，当前未采用可能被截断的正文/);
  assert.equal(diagnostic.textContent!.includes("未检测到登录"), false);
  assert.doesNotMatch(dom.document.body.innerHTML, /private-user|private-password|private-path|private-dom-fragment|private-protocol-error/);
  await click("结束搜索会话"); await waitFor(() => closes === 1 && !button("结束搜索会话").disabled, "unconfirmed close retained");
  assert.ok(dom.document.querySelector('[aria-label="搜索页面状态检查结果"]'));
  assert.equal(button("搜索并读取当前页").disabled, true);
  await click("结束搜索会话"); await waitFor(() => !button("搜索并读取当前页").disabled, "confirmed close clears diagnostic");
  assert.equal(dom.document.querySelector('[aria-label="搜索页面状态检查结果"]'), null);
});

test("inspection errors and cancellation retain the owned session, receipt and precise launch binding", async () => {
  let inspections = 0, pendingSignal: AbortSignal | undefined;
  const calls = installFetch(call => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return response(ready());
    if (call.body.action === "inspect") {
      if (++inspections === 1) throw new TypeError("Synthetic inspection transport failure");
      if (inspections === 2) return response({ failure: { code: "browser_session_expired", stage: "service", message: "Synthetic 检查暂时无法确认会话" } }, 422);
      pendingSignal = call.init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true }));
    }
    return response({ cancelled: true, closed: true });
  });
  await render(); await startReady();
  for (let attempt = 0; attempt < 2; attempt++) {
    await click("检查页面状态");
    await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')) && !button("检查页面状态").disabled, "retryable inspection failure");
    assert.equal(button("搜索并读取当前页").disabled, true);
    assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 2);
    assert.equal(button("结束搜索会话").disabled, false);
  }
  await click("检查页面状态"); await waitFor(() => Boolean(pendingSignal), "pending owned inspection");
  assert.equal(button("检查页面状态").disabled, true); assert.equal(button("显示专用窗口").disabled, true);
  await click("取消本次等待");
  await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')) && !button("检查页面状态").disabled, "cancelled inspection retained");
  assert.equal(pendingSignal!.aborted, true);
  assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 2);
  assert.equal(calls.filter(entry => entry.body.action === "start").length, 1);
  assert.deepEqual(calls.filter(entry => entry.body.action === "inspect").map(entry => entry.body.sessionId), [sessionId, sessionId, sessionId]);
  await click("结束搜索会话"); await waitFor(() => !button("搜索并读取当前页").disabled, "same launch cleanup after inspection failure");
  assert.deepEqual(calls.find(entry => entry.body.action === "cancel-start")!.body, {
    action: "cancel-start", input: calls[0]!.body.input, requestId: calls[0]!.body.requestId,
  });
});

test("explicit close clears the receipt only after the server confirms the exact launch binding was cancelled and closed", async () => {
  let confirmClose!: (value: Response) => void;
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return response(ready());
    if (call.body.action === "cancel-start") return new Promise<Response>((resolve) => { confirmClose = resolve; });
    return response({ closed: true, cancelled: true });
  });
  await render(); await startReady(); await click("结束搜索会话");
  assert.equal(calls.at(-1)!.path, "/api/jd/search-session");
  assert.deepEqual(calls.at(-1)!.body, { action: "cancel-start", input: calls[0]!.body.input, requestId: calls[0]!.body.requestId });
  assert.equal(button("搜索并读取当前页").disabled, true); assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 2);
  await act(async () => confirmClose(response({ cancelled: true, closed: true })));
  await waitFor(() => !button("搜索并读取当前页").disabled, "confirmed close");
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(dom.document.body.textContent!.includes("本次搜索："), false);
});

test("new filter props cannot relabel a delayed receipt or reuse a live session for different conditions", async () => {
  let deliver!: (value: Response) => void; let reads = 0; const changed = plan("Python", "cn-beijing");
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session(buildPlatformSearchRequest(call.body.input)));
    if (call.body.action === "read") return ++reads === 1 ? new Promise<Response>((resolve) => { deliver = resolve; }) : response(ready(changed));
    return response({ closed: true, cancelled: true });
  });
  await render(); await click("搜索并读取当前页"); await waitFor(() => reads === 1, "first delayed read");
  await render([changed]); await act(async () => deliver(response(ready())));
  await waitFor(() => Boolean(dom.document.querySelector(".atlas-platform-card-list li")), "old-query receipt");
  const scope = [...dom.document.querySelectorAll("p")].find((node) => node.textContent!.includes("本次搜索："))!;
  assert.match(scope.textContent!, /猎聘 · C# · 上海/); assert.equal(scope.textContent!.includes("Python"), false);
  assert.equal(button("搜索并读取当前页").disabled, true);
  assert.equal(calls.filter((entry) => entry.body.action === "start").length, 1);
  await click("结束搜索会话"); await waitFor(() => !button("搜索并读取当前页").disabled, "close original scope");
  await click("搜索并读取当前页"); await waitFor(() => reads === 2 && Boolean(dom.document.querySelector(".atlas-platform-card-list li")), "new query read");
  assert.deepEqual(calls.filter((entry) => entry.body.action === "start").map((entry) => entry.body.input), [
    { provider: "liepin", keyword: "C#", regionId: "cn-shanghai" }, { provider: "liepin", keyword: "Python", regionId: "cn-beijing" },
  ]);
});

test("focus and close failures retain the same receipt and session so close can be retried safely", async () => {
  let closes = 0;
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return response(ready());
    if (call.body.action === "focus") return response({ activationRequested: false });
    if (call.body.action === "cancel-start") return response({ cancelled: true, closed: ++closes > 1 });
    return response({ closed: true, cancelled: true });
  });
  await render(); await startReady(); await click("显示专用窗口");
  await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "failed activation disclosure");
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /未能确认显示/);
  assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 2);
  await click("结束搜索会话"); await waitFor(() => closes === 1 && !button("结束搜索会话").disabled, "failed close retained");
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /尚未确认关闭/);
  assert.equal(button("搜索并读取当前页").disabled, true); assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 2);
  await click("结束搜索会话"); await waitFor(() => !button("搜索并读取当前页").disabled, "successful retry close");
  assert.deepEqual(calls.filter((entry) => entry.body.action === "cancel-start").map((entry) => ({ input: entry.body.input, requestId: entry.body.requestId })),
    Array(2).fill({ input: calls[0]!.body.input, requestId: calls[0]!.body.requestId }));
  assert.equal(calls.filter((entry) => entry.body.action === "start").length, 1);
});

test("review forwards only the selected card, original evidence and capture time without writing the private opportunity library", async () => {
  const sentinel = JSON.stringify({ synthetic: "private-library-must-remain-unchanged" }); dom.localStorage.setItem(OPPORTUNITY_STORAGE_KEY, sentinel);
  const writes = mock.method(dom.localStorage, "setItem"); const reviews: unknown[][] = [];
  const calls = installFetch(); await render([original], (...args) => { reviews.push(args); }); await startReady();
  const buttons = [...dom.document.querySelectorAll("button")].filter((node) => node.textContent === "核对并收藏此岗位");
  await act(async () => buttons[0]!.click());
  assert.equal(reviews.length, 1); assert.deepEqual(reviews[0], [ready().cards[0], at]);
  assert.equal((reviews[0]![0] as Record<string, unknown>).description, undefined);
  assert.equal((reviews[0]![0] as Record<string, unknown>).coordinates, undefined);
  assert.equal(dom.localStorage.getItem(OPPORTUNITY_STORAGE_KEY), sentinel); assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(calls.map((entry) => entry.body.action), ["start", "read"]);
});

test("a read from another query is rejected before any card or review control appears", async () => {
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") return response(ready(plan("Unexpected other query")));
    return response({ closed: true, cancelled: true });
  });
  await render([original], () => { throw new Error("Rejected cards cannot reach review"); }); await click("搜索并读取当前页");
  await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "scope mismatch failure");
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /关键词或地区已改变/);
  assert.equal(dom.document.querySelectorAll(".atlas-platform-card-list li").length, 0);
  assert.equal(dom.document.body.textContent!.includes("核对并收藏此岗位"), false);
  assert.equal(button("搜索并读取当前页").disabled, true);
  assert.equal(calls.filter((entry) => entry.body.action === "start").length, 1);
});

test("a lost start response is recovered with exactly the original input and request id even after filters change", async () => {
  let starts = 0; const changed = plan("Python", "cn-beijing");
  const calls = installFetch((call) => {
    if (call.body.action === "start") { if (++starts === 1) throw new TypeError("Synthetic lost start response"); return response(session()); }
    if (call.body.action === "read") return response(ready());
    return response({ closed: true, cancelled: true });
  });
  await render(); await click("搜索并读取当前页");
  await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "unknown start outcome");
  assert.equal(button("重试恢复本次搜索").disabled, false);
  assert.equal(button("结束本次搜索请求").disabled, false);
  await render([changed]); await click("重试恢复本次搜索");
  await waitFor(() => Boolean(dom.document.querySelector(".atlas-platform-card-list li")), "recovered original search");
  const launches = calls.filter((entry) => entry.body.action === "start"); assert.equal(launches.length, 2);
  assert.deepEqual(launches[1]!.body, launches[0]!.body);
  assert.equal(typeof launches[0]!.body.requestId, "string");
  assert.match(dom.document.body.textContent!, /本次搜索：猎聘 · C# · 上海/);
});

test("an unknown start is explicitly cancelled by its original binding and a failed cancellation remains retryable", async () => {
  let cancellations = 0;
  const calls = installFetch((call) => {
    if (call.body.action === "start") throw new TypeError("Synthetic lost response");
    if (call.body.action === "cancel-start") return response({ cancelled: true, closed: ++cancellations > 1 });
    throw new Error("Unknown launches must not read a made-up session id");
  });
  await render(); await click("搜索并读取当前页");
  await waitFor(() => Boolean(dom.document.querySelector('[role="alert"]')), "pending launch");
  await render([plan("Different", "cn-beijing")]); await click("结束本次搜索请求");
  await waitFor(() => cancellations === 1 && !button("结束本次搜索请求").disabled, "failed cancellation retained");
  assert.equal(button("重试恢复本次搜索").disabled, false);
  await click("结束本次搜索请求"); await waitFor(() => !button("搜索并读取当前页").disabled, "confirmed exact cancellation");
  const expected = { action: "cancel-start", input: calls[0]!.body.input, requestId: calls[0]!.body.requestId };
  assert.deepEqual(calls.filter((entry) => entry.body.action === "cancel-start").map((entry) => entry.body), [expected, expected]);
  assert.equal(calls.some((entry) => entry.body.action === "read"), false);
});

test("a changed platform list keeps the live scope provider visible until explicit close", async () => {
  installFetch(); await render(); await startReady();
  const other = buildPlatformSearchRequest({ provider: "linkedin", keyword: "Python", regionId: "cn-beijing" });
  await render([other]);
  const select = dom.document.querySelector('select[aria-label="读取岗位平台"]')!;
  assert.equal((select as unknown as HTMLSelectElement).value, "liepin");
  assert.equal((select as unknown as HTMLSelectElement).disabled, true);
  assert.match(select.textContent!, /猎聘/);
  assert.match(dom.document.body.textContent!, /本次搜索：猎聘 · C# · 上海/);
});

test("unmount aborts a pending read and sends only an exact keepalive cancellation for the original launch", async () => {
  let readSignal: AbortSignal | undefined;
  const calls = installFetch((call) => {
    if (call.body.action === "start") return response(session());
    if (call.body.action === "read") {
      readSignal = call.init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => readSignal!.addEventListener("abort", () => reject(readSignal!.reason), { once: true }));
    }
    return response({ cancelled: true, closed: true });
  });
  await render(); await click("搜索并读取当前页"); await waitFor(() => Boolean(readSignal), "pending owned read");
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(readSignal!.aborted, true);
  const cancellations = calls.filter((entry) => entry.body.action === "cancel-start"); assert.equal(cancellations.length, 1);
  assert.deepEqual(cancellations[0]!.body, { action: "cancel-start", input: calls[0]!.body.input, requestId: calls[0]!.body.requestId });
  assert.equal(cancellations[0]!.init?.keepalive, true);
  assert.equal(calls.some((entry) => entry.body.action === "stop-browser"), false);
});
