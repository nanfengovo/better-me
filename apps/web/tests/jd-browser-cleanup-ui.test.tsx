import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { ProjectedResume, LlmConfig } from "@better-me/core";

// Mount the real modal and client; every HTTP request stays in this test process.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://127.0.0.1:5199" });
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { JdMatchModal } = await import("../src/components/JdMatchModal.tsx");
const { jdBrowserCleanupTracker } = await import("../src/lib/jd-browser-cleanup.ts");
const originalFetch = globalThis.fetch;
const linkA = "https://m.liepin.com/job/123.shtml";
const linkB = "https://m.liepin.com/job/456.shtml";
const textB = "岗位职责：开发设备接口，维护自动化回归与技术文档。任职要求：熟悉 C#、异步编程和关系型数据库。";
const resume: ProjectedResume = { locale: "zh", templateId: "zh-classic", profile: { displayName: "UI fixture" }, experiences: [] };
const config: LlmConfig = { provider: "openai-compatible", model: "fixture", baseUrl: "https://unused.example.test", apiKey: "" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let sequence = 0;
let root: ReturnType<typeof createRoot> | undefined;

type Request = { action: string; input?: string; requestId?: string; sessionId?: string };
type Policy = Partial<Record<"start" | "cancel-start" | "close" | "read" | "inspect" | "focus" | "extend" | "stop-browser", (body: Request, signal?: AbortSignal | null) => Response | Promise<Response> | undefined>>;
const inspectedOriginal = () => ({ snapshotState: "ready", pageState: "original_job", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 0 }, scriptErrors: 0, mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, resources: [], truncated: false, blockedPopups: 0, blockedSockets: 0 });
async function flush(action: () => void | Promise<void> = () => undefined) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  assert.ok(found, `missing button: ${label}`);
  assert.equal(found.disabled, false, `disabled button: ${label}`);
  return found;
}
async function click(label: string) { await flush(() => button(label).click()); }
async function input(id: string, value: string) {
  await flush(() => {
    const field = dom.document.getElementById(id);
    assert.ok(field instanceof dom.HTMLTextAreaElement, `missing textarea: ${id}`);
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
const notice = () => dom.document.querySelector('[aria-label="岗位页清理状态"]');
const fieldValue = (id: string) => (dom.document.getElementById(id) as unknown as HTMLTextAreaElement | null)?.value;

async function mount(policy: Policy = {}) {
  const calls: Request[] = [];
  const sessions = new Map<string, string>();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/jd/browser-session", "fixture must never access external sites or AI");
    const body = JSON.parse(String(init?.body)) as Request;
    calls.push(body);
    if (body.action === "start") {
      const id = `ui-fixture-session-${++sequence}-1234567890`;
      sessions.set(id, body.input!);
      return policy.start?.(body) ?? response({ sessionId: id, url: body.input, platform: "猎聘", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (body.action === "cancel-start") return policy["cancel-start"]?.(body) ?? response({ cancelled: true, closed: true });
    if (body.action === "close") return policy.close?.(body) ?? response({ closed: true });
    if (body.action === "focus") return policy.focus?.(body) ?? response({ activationRequested: true });
    if (body.action === "extend") return policy.extend?.(body) ?? response({ sessionId: body.sessionId, url: sessions.get(body.sessionId!), platform: "猎聘", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (body.action === "stop-browser") return policy["stop-browser"]?.(body) ?? response({ closed: true });
    if (body.action === "read") return policy.read?.(body, init?.signal) ?? response({ text: textB, method: "合成UI测试", provenance: { kind: "link", platform: "猎聘", url: sessions.get(body.sessionId!), observedAt: new Date().toISOString() } });
    if (body.action === "inspect") return policy.inspect?.(body, init?.signal) ?? response(inspectedOriginal());
    throw new Error(`unexpected fixture action: ${body.action}`);
  };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")! as unknown as Element);
  const render = async (visible = true) => flush(() => root!.render(visible ? createElement(JdMatchModal, {
    isOpen: true, onClose() {}, resume, llmConfig: config, onOpenConfig() {}, onOpenNetworkSettings() {}, initialText: "当前合成正文，请保留。",
  }) : null));
  await render();
  await click("分享链接");
  await input("jd-share", linkA);
  return { calls, render };
}

afterEach(async () => {
  globalThis.fetch = async () => response({ cancelled: true, closed: true });
  await flush(async () => { root?.unmount(); root = undefined; await jdBrowserCleanupTracker.retry(); });
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 0);
  globalThis.fetch = originalFetch;
});
after(async () => {
  css.deregister();
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("显式取消后清理未确认跨换链接保留，重试仅取消原requestId", async () => {
  const waiting = deferred<Response>();
  let cancels = 0;
  const { calls } = await mount({ start: () => waiting.promise, "cancel-start": () => response({ cancelled: true, closed: ++cancels > 1 }) });
  await click("打开独立浏览器");
  await click("取消读取");
  assert.match(notice()?.textContent ?? "", /尚未确认/);
  await input("jd-share", linkB);
  assert.ok(notice(), "typing a new URL must not hide unresolved cleanup");
  assert.equal(fieldValue("jd-text"), "当前合成正文，请保留。");
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
  const old = calls.filter(call => call.action === "start" || call.action === "cancel-start");
  assert.deepEqual(old.map(call => call.action), ["start", "cancel-start", "cancel-start"]);
  assert.ok(old.every(call => call.requestId === old[0]!.requestId && call.input === linkA));
  assert.ok(calls.every(call => call.action !== "stop-browser"));
});

test("新岗位预览成功后才到达的旧清理失败仍须精确封口且不覆盖新正文", async () => {
  const oldStart = deferred<Response>(), oldCancel = deferred<Response>();
  let starts = 0, cancels = 0;
  const { calls } = await mount({ start: () => ++starts === 1 ? oldStart.promise : undefined, "cancel-start": () => ++cancels === 1 ? oldCancel.promise : response({ cancelled: true, closed: true }) });
  await click("打开独立浏览器");
  await click("取消读取");
  await input("jd-share", linkB);
  await click("浏览器读取");
  assert.equal(fieldValue("jd-extracted"), textB);
  await flush(() => oldCancel.resolve(response({ cancelled: true, closed: false })));
  assert.ok(notice(), "a newer successful start does not tombstone an unknown delayed old POST");
  assert.equal(fieldValue("jd-extracted"), textB);
  const before = calls.length;
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
  assert.equal(fieldValue("jd-extracted"), textB);
  assert.deepEqual(calls.slice(before).map(call => call.action), ["cancel-start"]);
  assert.equal(calls.at(-1)!.requestId, calls[0]!.requestId);
  assert.equal(calls.at(-1)!.input, linkA);
});

test("真实unmount后到达的取消清理失败在重开面板时可见并可恢复", async () => {
  const oldStart = deferred<Response>(), oldCancel = deferred<Response>();
  let cancels = 0;
  const { render, calls } = await mount({ start: () => oldStart.promise, "cancel-start": () => ++cancels === 1 ? oldCancel.promise : response({ cancelled: true, closed: true }) });
  await click("打开独立浏览器");
  await render(false);
  await flush(() => oldCancel.resolve(response({ cancelled: true, closed: false })));
  assert.equal(dom.document.querySelector('[role="dialog"]'), null);
  await render();
  assert.ok(notice(), "the cleanup record must outlive a particular modal instance");
  assert.equal(fieldValue("jd-text"), "当前合成正文，请保留。");
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
  assert.equal(calls.at(-1)!.requestId, calls[0]!.requestId);
});

test("正文取得后关闭响应迟到失败跨tab可见，精确关闭旧页保留新文字", async () => {
  const oldClose = deferred<Response>();
  let closes = 0;
  const { calls } = await mount({ close: () => ++closes === 1 ? oldClose.promise : response({ closed: true }) });
  await click("浏览器读取");
  assert.equal(fieldValue("jd-extracted"), textB);
  await click("截图识别");
  await input("jd-text", "用户新写的正文，不得被旧清理结果覆盖。");
  await flush(() => oldClose.resolve(response({ closed: false })));
  assert.ok(notice());
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
  assert.equal(fieldValue("jd-text"), "用户新写的正文，不得被旧清理结果覆盖。");
  const closeCalls = calls.filter(call => call.action === "close");
  assert.equal(closeCalls.length, 2);
  assert.equal(closeCalls[0]!.sessionId, closeCalls[1]!.sessionId);
});

test("重试失败保留提示，单独stop成功不能假认未知旧启动请求已取消", async () => {
  const oldStart = deferred<Response>();
  let cancels = 0;
  await mount({ start: () => oldStart.promise, "cancel-start": () => response({ cancelled: true, closed: ++cancels >= 3 }) });
  await click("打开独立浏览器");
  await click("取消读取");
  assert.ok(notice());
  await click("关闭招聘浏览器");
  assert.ok(notice());
  await click("重试清理先前岗位页");
  assert.ok(notice(), "a failed exact retry must retain the resource record");
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
});

test("远端相似清理文案或额外marker不能伪造本地清理资源", async () => {
  await mount({ start: () => response({ failure: { code: "service_unavailable", stage: "service", message: "尚未确认清理（远端合成错误）", cleanupUnconfirmed: true, requestId: "remote-forged" } }, 422) });
  await click("打开独立浏览器");
  assert.match(dom.document.body.textContent ?? "", /远端合成错误/);
  assert.equal(notice(), null);
});

test("显示窗口发现会话已结束仍保留精确SID清理，失败提示可重试", async () => {
  let closes = 0;
  const { calls } = await mount({
    focus: () => response({ failure: { code: "browser_session_expired", stage: "service", message: "合成会话已结束" } }, 422),
    close: () => response({ closed: ++closes > 1 }),
  });
  await click("打开独立浏览器");
  await click("显示岗位窗口");
  assert.equal(dom.document.querySelector('[aria-label="独立浏览器会话"]'), null);
  assert.ok(notice(), "expired focus must not discard a failed page cleanup");
  await click("重试清理先前岗位页");
  assert.equal(notice(), null);
  const focusCall = calls.find(call => call.action === "focus")!;
  const closeCalls = calls.filter(call => call.action === "close");
  assert.equal(closeCalls.length, 2);
  assert.ok(closeCalls.every(call => call.sessionId === focusCall.sessionId));
  assert.ok(calls.every(call => call.action !== "stop-browser"));
});

test("延长同一岗位更新到期时间，排队中的旧到期回调不关闭延长后的页面", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  let clock = originalNow();
  const expiryCallbacks: Array<() => void> = [];
  try {
    Date.now = () => clock;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms && ms > 500_000 && ms <= 600_000) expiryCallbacks.push(() => callback(...args));
      return originalSetTimeout(callback, ms, ...args);
    }) as typeof setTimeout;
    const { calls } = await mount();
    await click("打开独立浏览器");
    const oldExpiry = expiryCallbacks.at(-1)!;
    assert.ok(oldExpiry);
    clock += 9 * 60_000;
    await click("再保留 10 分钟");
    assert.match(dom.document.body.textContent ?? "", /已延长/);
    await flush(oldExpiry);
    assert.ok(dom.document.querySelector('[aria-label="独立浏览器会话"]'));
    assert.deepEqual(calls.map(call => call.action), ["start", "extend"]);
    const extendedExpiry = expiryCallbacks.at(-1)!;
    assert.notEqual(extendedExpiry, oldExpiry);
    clock += 600_000;
    await flush(extendedExpiry);
    assert.equal(dom.document.querySelector('[aria-label="独立浏览器会话"]'), null);
    assert.equal(calls.at(-1)!.action, "close");
    assert.equal(calls.at(-1)!.sessionId, calls[1]!.sessionId);
  } finally { Date.now = originalNow; globalThis.setTimeout = originalSetTimeout; }
});

test("延长响应丢失保留原页面和原期限，不自动重复启动或关闭", async () => {
  const { calls } = await mount({ extend: () => Promise.reject(new TypeError("lost extension response")) });
  await click("打开独立浏览器");
  await click("再保留 10 分钟");
  assert.ok(dom.document.querySelector('[aria-label="独立浏览器会话"]'));
  assert.match(dom.document.body.textContent ?? "", /未确认延长.*原/);
  assert.deepEqual(calls.map(call => call.action), ["start", "extend"]);
});

test("关闭原页后到达的延长成功不得复活会话或覆盖后续页面", async () => {
  const waiting = deferred<Response>();
  let extending!: Request;
  const { calls } = await mount({ extend: body => { extending = body; return waiting.promise; } });
  await click("打开独立浏览器");
  await click("再保留 10 分钟");
  await click("关闭本次岗位页");
  await input("jd-share", linkB);
  await flush(() => waiting.resolve(response({ sessionId: extending.sessionId, url: linkA, platform: "猎聘", expiresAt: new Date(Date.now() + 600_000).toISOString() })));
  assert.equal(dom.document.querySelector('[aria-label="独立浏览器会话"]'), null);
  assert.equal(fieldValue("jd-share"), linkB);
  assert.doesNotMatch(dom.document.body.textContent ?? "", /已延长/);
  assert.deepEqual(calls.map(call => call.action), ["start", "extend", "close"]);
});

for (const action of ["read", "inspect"] as const) {
  for (const failureKind of ["server-timeout", "transport", "client-timeout"] as const) {
    test(`${action}的${failureKind}保留验证后的同一SID，可继续检查和读取且不自动开关页面`, async () => {
      const originalSetTimeout = globalThis.setTimeout;
      let expireOperation: (() => void) | undefined;
      let gated = false, failed = false;
      const failure = (_body: Request, signal?: AbortSignal | null) => {
        if (failed) return undefined;
        failed = true;
        if (failureKind === "server-timeout") return response({ failure: { code: "timeout", stage: "page", message: "合成单次快照超时" } }, 422);
        if (failureKind === "transport") return Promise.reject(new TypeError("合成临时连接中断"));
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal?.aborted) reject(signal.reason);
        });
      };
      const policy: Policy = {
        read: (body, signal) => {
          if (!gated) { gated = true; return response({ failure: { code: "verification_required", stage: "page", message: "合成原站验证" } }, 422); }
          return action === "read" ? failure(body, signal) : undefined;
        },
        inspect: action === "inspect" ? failure : undefined,
      };
      try {
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
          if (ms === (action === "read" ? 50_000 : 15_000)) expireOperation = () => callback(...args);
          return originalSetTimeout(callback, ms, ...args);
        }) as typeof setTimeout;
        const { calls } = await mount(policy);
        await click("打开独立浏览器");
        await click("完成后读取原岗位");
        assert.ok(dom.document.querySelector('[aria-label="独立浏览器会话"]'), "gate keeps the current page");
        await click(action === "read" ? "完成后读取原岗位" : "检查当前窗口");
        if (failureKind === "client-timeout") { assert.ok(expireOperation); await flush(expireOperation); }
        assert.ok(dom.document.querySelector('[aria-label="独立浏览器会话"]'), "a single failed operation must not discard the verified page");
        assert.equal(fieldValue("jd-text"), "当前合成正文，请保留。");
        assert.equal(fieldValue("jd-extracted"), undefined);
        assert.equal(calls.filter(call => call.action === "start").length, 1);
        assert.equal(calls.filter(call => call.action === "close").length, 0);
        const sid = calls.find(call => call.action === action)!.sessionId;
        await click("检查当前窗口");
        assert.match(dom.document.body.textContent ?? "", /已识别为原岗位/);
        await click("完成后读取原岗位");
        assert.equal(fieldValue("jd-extracted"), textB);
        assert.equal(calls.filter(call => call.action === "start").length, 1);
        assert.equal(calls.filter(call => call.action === "close").length, 1, "only successful reading closes the page");
        assert.ok(calls.filter(call => call.sessionId).every(call => call.sessionId === sid));
      } finally { globalThis.setTimeout = originalSetTimeout; }
    });
  }

  test(`${action}确认过期仍清除会话并精确关闭原SID`, async () => {
    const { calls } = await mount({ [action]: () => response({ failure: { code: "browser_session_expired", stage: "service", message: "合成会话已过期" } }, 422) });
    await click("打开独立浏览器");
    await click(action === "read" ? "完成后读取原岗位" : "检查当前窗口");
    assert.equal(dom.document.querySelector('[aria-label="独立浏览器会话"]'), null);
    assert.deepEqual(calls.map(call => call.action), ["start", action, "close"]);
    assert.equal(calls[1]!.sessionId, calls[2]!.sessionId);
  });

  for (const ending of ["close", "change-link", "unmount"] as const) {
    test(`${action}的迟到成功在${ending}后不复活会话或采用旧正文`, async () => {
      const waiting = deferred<Response>();
      const { calls, render } = await mount({ [action]: () => waiting.promise });
      await click("打开独立浏览器");
      await click(action === "read" ? "完成后读取原岗位" : "检查当前窗口");
      if (ending === "unmount") await render(false);
      else if (ending === "change-link") await input("jd-share", linkB);
      else await click("关闭本次岗位页");
      await flush(() => waiting.resolve(response(action === "inspect" ? inspectedOriginal() : { text: textB, method: "合成迟到正文", provenance: { kind: "link", platform: "猎聘", url: linkA, observedAt: new Date().toISOString() } })));
      assert.equal(dom.document.querySelector('[aria-label="独立浏览器会话"]'), null);
      assert.equal(fieldValue("jd-extracted"), undefined);
      if (ending === "change-link") assert.equal(fieldValue("jd-share"), linkB);
      if (ending === "unmount") assert.equal(dom.document.querySelector('[role="dialog"]'), null);
      assert.deepEqual(calls.map(call => call.action), ["start", action, "close"]);
      assert.equal(calls[1]!.sessionId, calls[2]!.sessionId);
    });
  }
}
