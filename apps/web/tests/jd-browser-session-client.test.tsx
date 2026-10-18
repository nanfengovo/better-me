import assert from "node:assert/strict";
import test from "node:test";
import { startJdBrowserSession, focusJdBrowserSession, readJdBrowserSession, inspectJdBrowserSession, closeJdBrowserSession, saveJdDraft, isJdLinkOnly, type JdBrowserSession } from "../src/lib/jd-import.ts";
import { JdExtractionError, jdFailureGuidance, type JdFailureCode } from "../src/lib/jd-errors.ts";
import { isBossDescriptionCollapsed, snapshotFailureMessage } from "../src/lib/jd-capture-diagnostics.ts";
import { isJdStartRequestId } from "../src/lib/jd-start-request.ts";

const link = "https://m.liepin.com/job/123.shtml?from=fixture";
const sessionId = "client-fixture-session-123456";
const session = (): JdBrowserSession => ({ sessionId, url: link, platform: "猎聘", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const result = () => ({ text: "岗位职责：开发异步设备通信接口，维护自动化回归测试。任职要求：熟悉 C#、数据库与技术文档。", provenance: { kind: "link", url: link, platform: "猎聘", observedAt: "2026-10-17T08:00:00Z", title: "合成测试岗位" }, method: "独立浏览器可见正文" });
const isFailure = (code: JdFailureCode) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const unknownPageLoad = () => ({ readyState: "unknown", content: "unknown", visibleFrames: 0 });
const inspection = () => ({ snapshotState: "ready", pageState: "platform_intermediate", pageLoad: unknownPageLoad(), scriptErrors: 0, mainDocument: { state: "unknown" }, gate: "verification_required", resources: [{ host: "concat.lietou-static.com", type: "script", outcome: "load_failed", detail: "connection", frame: "main" }], truncated: false, blockedPopups: 2, blockedSockets: 1 });

test("延长只提交原会话ID，严格保留同岗同SID且不采用额外数据", async () => {
  const { extendJdBrowserSession } = await import("../src/lib/jd-import.ts");
  const originalFetch = globalThis.fetch;
  const original = { ...session(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const extended = { ...original, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const requests: unknown[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/browser-session");
      requests.push(JSON.parse(String(init?.body)));
      return json({ ...extended, cookies: "discard", text: "not a JD read" });
    };
    assert.deepEqual(await extendJdBrowserSession(original, new AbortController().signal), extended);
    assert.deepEqual(requests, [{ action: "extend", sessionId }]);
    assert.notEqual(original.expiresAt, extended.expiresAt, "do not mutate the caller before response acceptance");
  } finally { globalThis.fetch = originalFetch; }
});

test("延长拒绝换SID、换岗、缩短、过期和超长时间，传输失败不自动重开或关闭", async () => {
  const { extendJdBrowserSession } = await import("../src/lib/jd-import.ts");
  const originalFetch = globalThis.fetch;
  const original = { ...session(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let payload: unknown;
  const actions: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => { actions.push(JSON.parse(String(init?.body)).action); return json(payload); };
    for (const invalid of [
      { ...original, sessionId: "different-session-123456" }, { ...original, url: "https://m.liepin.com/job/456.shtml" },
      { ...original, platform: "51JOB" }, { ...original, expiresAt: new Date(Date.now() + 30_000).toISOString() },
      { ...original, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...original, expiresAt: new Date(Date.now() + 16 * 60_000).toISOString() },
      { ...original, expiresAt: "invalid" }, {},
    ]) {
      payload = invalid;
      await assert.rejects(extendJdBrowserSession(original, new AbortController().signal), isFailure("service_unavailable"));
    }
    payload = { failure: { code: "browser_session_expired", stage: "service", message: "ended" } };
    await assert.rejects(extendJdBrowserSession(original, new AbortController().signal), isFailure("browser_session_expired"));
    globalThis.fetch = async (_url, init) => { actions.push(JSON.parse(String(init?.body)).action); throw new TypeError("lost response"); };
    await assert.rejects(extendJdBrowserSession(original, new AbortController().signal), isFailure("service_unavailable"));
    assert.ok(actions.every(action => action === "extend"));
  } finally { globalThis.fetch = originalFetch; }
});

test("延长预取消不联网，响应解码时取消拒绝迟到成功", async () => {
  const { extendJdBrowserSession } = await import("../src/lib/jd-import.ts");
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("cancel extension", "AbortError");
  let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; const value = json({}); value.json = async () => { controller.abort(reason); return session(); }; return value; };
    await assert.rejects(extendJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
    await assert.rejects(extendJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("首次设置失败保留可恢复分类，用户重试才再次请求同一岗位", async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const failure = { code: "browser_setup_required", stage: "service", message: "专用 Edge 需要完成首次设置。" } as const;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.action === "cancel-start") return json({ cancelled: true, closed: true });
      return requests.filter(request => request.action === "start").length === 1 ? json({ failure }, 422) : json(session());
    };
    await assert.rejects(startJdBrowserSession(link, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.deepEqual(error.failure, failure);
      const guidance = jdFailureGuidance(error.failure);
      assert.equal(guidance.network, false);
      assert.match(guidance.title, /首次设置/);
      assert.match(guidance.guidance, /完成或跳过.*浏览器读取/);
      assert.doesNotMatch(guidance.guidance, /更换代理|验证码|重新安装/);
      return true;
    });
    assert.deepEqual(requests.map(request => request.action), ["start", "cancel-start"]);
    assert.equal(isJdStartRequestId(requests[0].requestId), true);
    assert.equal(requests[0].requestId, requests[1].requestId);
    const retried = await startJdBrowserSession(link, new AbortController().signal);
    assert.equal(retried.sessionId, sessionId);
    assert.deepEqual(requests.map(request => request.action), ["start", "cancel-start", "start"]);
    assert.notEqual(requests[0].requestId, requests[2].requestId);
  } finally { globalThis.fetch = original; }
});

test("单独粘贴的链接不能当作岗位正文，正文包含原链接仍可继续核对", () => {
  assert.equal(isJdLinkOnly(` \n${link}\n `), true);
  assert.equal(isJdLinkOnly("https://m.zhipin.com/mpa/html/weijd/weijd-job/id?sid=example&fromSource=2"), true);
  assert.equal(isJdLinkOnly(""), false);
  assert.equal(isJdLinkOnly(`岗位职责：开发设备通信接口。任职要求：熟悉 C#。\n原链接：${link}`), false);
});

test("inspect仅接受固定快照失败原因，移除附加页面与协议内容且拒绝成功快照携带失败", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  const failed = { ...inspection(), snapshotState: "failed", pageState: "unknown", gate: undefined };
  try {
    globalThis.fetch = async () => json(payload);
    for (const diagnostic of [
      { stage: "document_state", reason: "main_not_committed" },
      { stage: "capture", reason: "protocol_unavailable" },
      { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" },
      { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "text_fragment_mapping" },
      { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "layout_style_conflict" },
      { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "boss_description_collapsed" },
      ...["node_index", "style_count", "text_opacity", "computed_style", "bounds"].map(detail => ({ stage: "projection", reason: "layout_entry", detail })),
      { stage: "post_projection", reason: "navigation_changed" },
    ]) {
      payload = { ...failed, snapshotFailure: { ...diagnostic, url: "https://private.test/?token=secret", message: "private-error", html: "private-body" } };
      const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
      assert.deepEqual(observed.snapshotFailure, diagnostic);
      assert.doesNotMatch(JSON.stringify(observed), /private|secret|token|https:/);
    }
    for (const snapshotFailure of [null, [], {}, "projection", { stage: "private-stack", reason: "snapshot_shape" }, { stage: "projection", reason: "https://private.test/" }, { stage: "projection", reason: null }, { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "private-style" }, { stage: "projection", reason: "snapshot_shape", detail: "transform" }]) {
      payload = { ...failed, snapshotFailure };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    payload = { ...inspection(), snapshotFailure: { stage: "projection", reason: "snapshot_shape" } };
    await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    for (const snapshotFailure of [
      { stage: "projection", reason: "layout_entry", detail: "transform" },
      { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "bounds" },
      { stage: "capture", reason: "snapshot_visibility_unsupported", detail: "boss_description_collapsed" },
      { stage: "post_projection", reason: "snapshot_visibility_unsupported", detail: "boss_description_collapsed" },
    ]) {
      payload = { ...failed, snapshotFailure };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
  } finally { globalThis.fetch = original; }
});

test("只有精确的职责折叠诊断指导展开，其它布局问题不会误导点击", () => {
  const folded = { stage: "projection", reason: "snapshot_visibility_unsupported", detail: "boss_description_collapsed" } as const;
  assert.equal(isBossDescriptionCollapsed(folded), true);
  assert.match(snapshotFailureMessage(folded), /折叠为四行.*尚未取得完整正文/);
  assert.match(snapshotFailureMessage(folded), /职位描述区域点击“查看全部”/);
  assert.equal(isBossDescriptionCollapsed(undefined), false);
  for (const detail of ["overflow_clip_or_scroll", "line_clamp", "transform", "mask", "layout_style_conflict", "text_range_gap"] as const) {
    const generic = { ...folded, detail };
    assert.equal(isBossDescriptionCollapsed(generic), false);
    assert.doesNotMatch(snapshotFailureMessage(generic), /折叠|查看全部|展开/);
  }
  assert.equal(isBossDescriptionCollapsed({ ...folded, stage: "capture" }), false);
  assert.equal(isBossDescriptionCollapsed({ ...folded, reason: "snapshot_shape" }), false);
});

test("inspect区分脚本错误未采集与零错误，保留旧服务契约并拒绝矛盾值", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    for (const collected of [undefined, true, false]) {
      payload = { ...inspection(), ...(collected === undefined ? {} : { scriptErrorsCollected: collected }) };
      assert.deepEqual(await inspectJdBrowserSession(session(), new AbortController().signal), payload);
    }
    for (const value of [null, "false", 0, {}]) {
      payload = { ...inspection(), scriptErrorsCollected: value };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    payload = { ...inspection(), scriptErrorsCollected: false, scriptErrors: 1 };
    await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
  } finally { globalThis.fetch = original; }
});

test("inspect主页面请求计数兼容省略字段，只采用0到1000整数且剥离额外请求信息", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    payload = inspection();
    const legacy = await inspectJdBrowserSession(session(), new AbortController().signal);
    assert.deepEqual(legacy, inspection());
    assert.equal(Object.hasOwn(legacy, "mainDocumentRequests"), false, "旧服务和原生采集未提供时不伪造零次请求");
    for (const mainDocumentRequests of [0, 1, 37, 1000]) {
      payload = { ...inspection(), mainDocumentRequests, requestUrls: ["https://private.test/?token=secret"], initiator: "private-script" };
      const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
      assert.deepEqual(observed, { ...inspection(), mainDocumentRequests });
      assert.doesNotMatch(JSON.stringify(observed), /private|secret|requestUrls|initiator|https:/);
    }
    for (const mainDocumentRequests of [null, -1, 0.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, "1", false, [], { count: 1 }]) {
      payload = { ...inspection(), mainDocumentRequests };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
  } finally { globalThis.fetch = original; }
});

test("显示岗位窗口只发送会话ID并严格采用activationRequested，不伪报OS可见性", async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  let payload: unknown = { activationRequested: true, visible: true, cookies: "discard" };
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/browser-session");
      assert.equal(init?.method, "POST");
      requests.push(JSON.parse(String(init?.body)));
      return json(payload);
    };
    assert.deepEqual(await focusJdBrowserSession(session(), new AbortController().signal), { activationRequested: true });
    assert.deepEqual(requests, [{ action: "focus", sessionId }]);
    for (const invalid of [{}, { activationRequested: false }, { activationRequested: "true" }, { visible: true }, null]) {
      payload = invalid;
      await assert.rejects(focusJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    payload = { failure: { code: "browser_session_expired", stage: "service", message: "expired" } };
    await assert.rejects(focusJdBrowserSession(session(), new AbortController().signal), isFailure("browser_session_expired"));
    const before = requests.length;
    await assert.rejects(focusJdBrowserSession({ ...session(), sessionId: "short" }, new AbortController().signal), isFailure("service_unavailable"));
    assert.equal(requests.length, before);
  } finally { globalThis.fetch = original; }
});

test("显示请求预取消不联网，JSON解码期间取消拒绝晚成功且不自动close", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("cancel focus", "AbortError");
  const actions: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      actions.push(JSON.parse(String(init?.body)).action);
      const response = json({});
      response.json = async () => { controller.abort(reason); return { activationRequested: true }; };
      return response;
    };
    await assert.rejects(focusJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
    await assert.rejects(focusJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
    assert.deepEqual(actions, ["focus"]);
  } finally { globalThis.fetch = original; }
});

test("人工会话显式start/read/close使用同源接口，read只发送内存会话ID", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const requests: Record<string, unknown>[] = [];
  const input = `看看这个岗位 ${link}`;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/browser-session");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.action === "close") {
        assert.equal(init?.keepalive, true);
        assert.notEqual(init?.signal, controller.signal);
        assert.equal(init?.signal?.aborted, false);
        return json({ closed: true });
      }
      assert.equal(init?.signal, controller.signal);
      return json(body.action === "start" ? { ...session(), unexpected: "ignored" } : result());
    };
    const active = await startJdBrowserSession(input, controller.signal);
    assert.deepEqual(active, { sessionId, url: link, platform: "猎聘", expiresAt: active.expiresAt });
    const pending = await readJdBrowserSession(active, controller.signal);
    assert.equal(pending.text, result().text);
    assert.equal(pending.provenance.url, link);
    await closeJdBrowserSession(active.sessionId);
    assert.equal(isJdStartRequestId(requests[0].requestId), true);
    assert.deepEqual(requests, [{ action: "start", input, requestId: requests[0].requestId }, { action: "read", sessionId }, { action: "close", sessionId }]);
  } finally { globalThis.fetch = original; }
});

test("无效链接在start请求前拒绝，损坏响应仅按启动请求收尾而不采用响应中的会话ID", async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  let responseBody: unknown = session();
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return json(body.action === "cancel-start" ? { cancelled: true, closed: true } : responseBody);
    };
    await assert.rejects(startJdBrowserSession("https://evil.test/job", new AbortController().signal), isFailure("invalid_link"));
    assert.equal(requests.length, 0);
    for (const body of [null, [], {}, { ...session(), sessionId: "short" }, { ...session(), url: "https://127.0.0.1/private" }, { ...session(), url: "https://m.liepin.com/job/999.shtml" }, { ...session(), platform: "BOSS直聘" }, { ...session(), expiresAt: "invalid" }, { ...session(), expiresAt: new Date(Date.now() - 1000).toISOString() }, { ...session(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }]) {
      requests.length = 0;
      responseBody = body;
      await assert.rejects(startJdBrowserSession(link, new AbortController().signal), isFailure("service_unavailable"));
      const attempts = body === null || Array.isArray(body) ? 2 : 1;
      assert.deepEqual(requests.map((request) => request.action), [...Array(attempts).fill("start"), "cancel-start"]);
      assert.equal(isJdStartRequestId(requests[0].requestId), true);
      assert.equal(requests.every(request => request.requestId === requests[0].requestId && request.input === link && request.sessionId === undefined), true);
    }
  } finally { globalThis.fetch = original; }
});

test("取消后迟到的start成功响应按请求ID清理，取消原因保持且不沿用取消信号", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("用户切换了岗位链接", "AbortError");
  let release: (response: Response) => void = () => { throw new Error("start was not requested"); };
  const actions: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      actions.push(body.action);
      if (body.action === "cancel-start") {
        assert.equal(controller.signal.aborted, true);
        assert.notEqual(init?.signal, controller.signal);
        assert.equal(init?.signal?.aborted, false);
        assert.equal(init?.keepalive, true);
        return json({ cancelled: true, closed: true });
      }
      return new Promise<Response>((resolve) => { release = resolve; });
    };
    const opening = startJdBrowserSession(link, controller.signal);
    controller.abort(reason);
    release(json(session()));
    await assert.rejects(opening, (error: unknown) => error === reason);
    assert.deepEqual(actions, ["start", "cancel-start"]);
  } finally { globalThis.fetch = original; }
});

test("start响应JSON解码期间取消同样收尾，预先取消不会发请求", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("modal closed", "AbortError");
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      if (JSON.parse(String(init?.body)).action === "cancel-start") return json({ cancelled: true, closed: true });
      const response = json({});
      response.json = async () => { controller.abort(reason); return session(); };
      return response;
    };
    await assert.rejects(startJdBrowserSession(link, controller.signal), (error: unknown) => error === reason);
    assert.equal(calls, 2);
    await assert.rejects(startJdBrowserSession(link, controller.signal), (error: unknown) => error === reason);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("read的登录或验证失败保留分类，不自动重试、结束或重新登录", async () => {
  const original = globalThis.fetch;
  const actions: string[] = [];
  try {
    for (const code of ["login_required", "verification_required", "browser_session_expired"] as const) {
      actions.length = 0;
      globalThis.fetch = async (_url, init) => {
        actions.push(JSON.parse(String(init?.body)).action);
        return json({ failure: { code, stage: "page", message: "原网站仍要求用户处理。" } }, 422);
      };
      await assert.rejects(readJdBrowserSession(session(), new AbortController().signal), isFailure(code));
      assert.deepEqual(actions, ["read"]);
      assert.equal(jdFailureGuidance({ code, stage: "page", message: "failed" }).network, false);
    }
  } finally { globalThis.fetch = original; }
});

test("read拒绝错岗、损坏来源与取消后的晚结果，关闭信号独立", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({ ...result(), provenance: { ...result().provenance, url: "https://m.liepin.com/job/999.shtml" } });
    await assert.rejects(readJdBrowserSession(session(), new AbortController().signal), isFailure("job_mismatch"));
    globalThis.fetch = async () => json({ ...result(), provenance: { url: link, observedAt: "invalid" } });
    await assert.rejects(readJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    const controller = new AbortController();
    const reason = new DOMException("Cancelled read", "AbortError");
    globalThis.fetch = async () => {
      const response = json({});
      response.json = async () => { controller.abort(reason); return result(); };
      return response;
    };
    await assert.rejects(readJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
  } finally { globalThis.fetch = original; }
});

test("close校验明确成功，错误响应和无效ID不能伪装成会话已结束", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls += 1; return json({ closed: false }); };
    await assert.rejects(closeJdBrowserSession("short"), isFailure("service_unavailable"));
    assert.equal(calls, 0);
    await assert.rejects(closeJdBrowserSession(sessionId), isFailure("service_unavailable"));
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response("<html>not a session endpoint</html>");
    await assert.rejects(closeJdBrowserSession(sessionId), isFailure("service_unavailable"));
  } finally { globalThis.fetch = original; }
});

test("会话ID及登录状态不会经成功来源字段进入确认后的JD草稿", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const records = new Map<string, string>();
  globalThis.localStorage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } } as Storage;
  try {
    globalThis.fetch = async () => json({ ...result(), sessionId, provenance: { ...result().provenance, sessionId, cookies: "not-a-persistable-field" } });
    const pending = await readJdBrowserSession(session(), new AbortController().signal);
    assert.equal(records.size, 0, "reading alone does not save or confirm the JD");
    saveJdDraft({ text: pending.text, shareInput: link, provenance: pending.provenance });
    const saved = [...records.values()].join("\n");
    assert.doesNotMatch(saved, new RegExp(sessionId));
    assert.doesNotMatch(saved, /cookies|not-a-persistable-field/);
    assert.match(saved, /设备通信接口/);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test("inspect只检查同源会话ID，白名单保留诊断且不保存正文、URL或认证信息", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const records = new Map<string, string>();
  const controller = new AbortController();
  const requests: Record<string, unknown>[] = [];
  globalThis.localStorage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } } as Storage;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/browser-session");
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      requests.push(JSON.parse(String(init?.body)));
      return json({ ...inspection(), sessionId, cookies: "secret", text: result().text, url: link, resources: [{ ...inspection().resources[0], url: `${link}&token=private`, headers: { authorization: "secret" } }] });
    };
    const observed = await inspectJdBrowserSession(session(), controller.signal);
    assert.deepEqual(observed, inspection());
    assert.deepEqual(requests, [{ action: "inspect", sessionId }]);
    assert.equal(records.size, 0);
    assert.doesNotMatch(JSON.stringify(observed), /sessionId|cookies|authorization|token|岗位职责|https:/);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test("inspect严格拒绝URL、凭据、路径、端口、IP和非DNS资源标识", async () => {
  const original = globalThis.fetch;
  let resourceHost = "concat.lietou-static.com";
  try {
    globalThis.fetch = async () => json({ ...inspection(), resources: [{ ...inspection().resources[0], host: resourceHost }] });
    for (const host of ["https://concat.lietou-static.com", "user:password@cdn.example.com", "cdn.example.com/private", "cdn.example.com?token=private", "cdn.example.com#token", "cdn.example.com:443", "127.0.0.1", "127.1", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1", "[::1]", "::1", "localhost", "cdn.example.com.", ".example.com", "cdn..example.com", "-cdn.example.com", "cdn_.example.com", " cdn.example.com", "cdn.example.com\n", "例子.com", `${"a".repeat(64)}.example.com`, `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.com`]) {
      resourceHost = host;
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"), host);
    }
    for (const host of ["cdn.example.com", "img.bosszhipin.com", "xn--fsqu00a.xn--fiqs8s", "CDN.Example.COM"]) {
      resourceHost = host;
      assert.equal((await inspectJdBrowserSession(session(), new AbortController().signal)).resources[0].host, host.toLowerCase());
    }
  } finally { globalThis.fetch = original; }
});

test("inspect拒绝损坏状态、超量资源、非法类型和不完整的拦截计数", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    for (const malformed of [null, [], {}, { ...inspection(), pageState: "success" }, { ...inspection(), gate: null }, { ...inspection(), gate: "verified" }, { ...inspection(), resources: {} }, { ...inspection(), resources: Array.from({ length: 31 }, () => inspection().resources[0]) }, { ...inspection(), resources: [null] }, { ...inspection(), resources: [[]] }, { ...inspection(), resources: [{ ...inspection().resources[0], host: 123 }] }, { ...inspection(), resources: [{ ...inspection().resources[0], type: "media" }] }, { ...inspection(), resources: [{ ...inspection().resources[0], outcome: "loaded" }] }, { ...inspection(), truncated: "false" }, ...["blockedPopups", "blockedSockets"].flatMap((key) => [undefined, null, -1, 0.5, 1001, "1"].map((value) => ({ ...inspection(), [key]: value })))]) {
      payload = malformed;
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const pageState of ["original_job", "platform_intermediate", "different_job", "blank", "unknown"]) {
      payload = { snapshotState: "ready", pageState, pageLoad: unknownPageLoad(), scriptErrors: 0, mainDocument: { state: "unknown" }, resources: [], truncated: false, blockedPopups: 0, blockedSockets: 1000 };
      assert.deepEqual(await inspectJdBrowserSession(session(), new AbortController().signal), payload);
    }
    payload = { ...inspection(), resources: Array.from({ length: 30 }, () => inspection().resources[0]), truncated: true };
    assert.equal((await inspectJdBrowserSession(session(), new AbortController().signal)).resources.length, 30);
    payload = { ...inspection(), gate: "login_required" };
    assert.equal((await inspectJdBrowserSession(session(), new AbortController().signal)).gate, "login_required");
  } finally { globalThis.fetch = original; }
});

test("inspect必须明确快照是否可用，拒绝缺失或未知状态且仅保留枚举和去敏诊断", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    for (const snapshotState of [undefined, null, false, 0, "", "success", "READY", "ready ", { state: "ready" }, ["ready"]]) {
      payload = { ...inspection(), snapshotState };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const snapshotState of ["ready", "navigation_in_progress", "failed", "oversized"]) {
      const diagnostic = { snapshotState, pageState: "unknown", pageLoad: unknownPageLoad(), scriptErrors: 0, mainDocument: { state: "unknown" }, resources: inspection().resources, truncated: false, blockedPopups: 0, blockedSockets: 0 };
      payload = { ...diagnostic, url: `${link}&token=private`, title: "private-title", html: "private-body", exception: "private-error", navigation: { originalUrl: link } };
      const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
      assert.deepEqual(observed, diagnostic);
      assert.doesNotMatch(JSON.stringify(observed), /private|https:|originalUrl|exception|title|html/);
    }
  } finally { globalThis.fetch = original; }
});

test("inspect加载诊断仅保留状态与有界计数，拒绝损坏值和不可用快照的内容结论", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    for (const pageLoad of [undefined, null, [], "complete", {},
      { ...unknownPageLoad(), readyState: "finished" }, { ...unknownPageLoad(), content: "private-body" },
      ...[undefined, null, -1, 0.5, 1001, "1"].map((visibleFrames) => ({ ...unknownPageLoad(), visibleFrames }))]) {
      payload = { ...inspection(), pageLoad };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const scriptErrors of [undefined, null, -1, 0.5, 1001, "1"]) {
      payload = { ...inspection(), scriptErrors };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const snapshotState of ["navigation_in_progress", "failed", "oversized"]) {
      payload = { ...inspection(), snapshotState, pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 1 } };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
      for (const contradictory of [{ pageState: "original_job" }, { pageState: "platform_intermediate" }, { pageState: "blank" }, { gate: "login_required" }, { gate: "verification_required" }]) {
        payload = { ...inspection(), snapshotState, pageState: "unknown", pageLoad: unknownPageLoad(), ...contradictory };
        await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
      }
    }
    for (const gate of ["login_required", "verification_required"]) {
      payload = { ...inspection(), pageState: "blank", gate };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const readyState of ["loading", "interactive", "complete", "unknown"]) {
      for (const content of ["empty", "visible_text", "embedded_content", "unknown"]) {
        const pageLoad = { readyState, content, visibleFrames: content === "embedded_content" ? 1000 : 0 };
        payload = { ...inspection(), pageLoad: { ...pageLoad, url: `${link}&token=private`, text: "private-body" }, scriptErrors: 1000, error: "private-stack" };
        const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
        assert.deepEqual(observed.pageLoad, pageLoad);
        assert.equal(observed.scriptErrors, 1000);
        assert.doesNotMatch(JSON.stringify(observed), /private|token|https:|stack/);
      }
    }
  } finally { globalThis.fetch = original; }
});

test("inspect保留验证图片与字体错误供核对，不接收额外资源URL", async () => {
  const original = globalThis.fetch;
  const resources = [
    { host: "captcha.example.test", type: "image", outcome: "blocked_by_tool", detail: "blocked_by_tool", frame: "child" },
    { host: "fonts.example.test", type: "font", outcome: "http_error", detail: "http", frame: "main", httpStatus: 404 },
  ];
  try {
    globalThis.fetch = async () => json({ ...inspection(), resources: resources.map((item) => ({ ...item, url: `https://${item.host}/private?token=secret` })) });
    const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
    assert.deepEqual(observed.resources, resources);
    assert.doesNotMatch(JSON.stringify(observed), /private|token|secret|https:/);
  } finally { globalThis.fetch = original; }
});

test("inspect区分主文档响应与资源失败类别，剥离原始错误并拒绝矛盾状态", async () => {
  const original = globalThis.fetch;
  let payload: unknown;
  try {
    globalThis.fetch = async () => json(payload);
    for (const state of ["pending", "failed", "unknown"]) {
      payload = { ...inspection(), mainDocument: { state, url: `${link}&private=token`, error: "private-error" } };
      assert.deepEqual((await inspectJdBrowserSession(session(), new AbortController().signal)).mainDocument, { state });
    }
    payload = { ...inspection(), mainDocument: { state: "response", status: 403, headers: { authorization: "private-token" } }, resources: [{ ...inspection().resources[0], detail: "tls", frame: "child", errorText: "private-error", url: link }] };
    const observed = await inspectJdBrowserSession(session(), new AbortController().signal);
    assert.deepEqual(observed.mainDocument, { state: "response", status: 403 });
    assert.equal(observed.resources[0].detail, "tls");
    assert.equal(observed.resources[0].frame, "child");
    assert.doesNotMatch(JSON.stringify(observed), /private|token|https:|errorText|headers/);
    for (const mainDocument of [undefined, null, [], {}, { state: "loaded" }, { state: "response" }, { state: "response", status: "200" }, { state: "response", status: 99 }, { state: "response", status: 600 }, { state: "response", status: 200.5 }, { state: "pending", status: 200 }]) {
      payload = { ...inspection(), mainDocument };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const changes of [{ frame: undefined }, { frame: "private-frame" }, { detail: undefined }, { detail: "net::ERR_CONNECTION_RESET" }, { detail: "http" }, { httpStatus: 403 }, { outcome: "blocked_by_tool", detail: "connection" }, { outcome: "http_error", detail: "http" }, { outcome: "http_error", detail: "http", httpStatus: 399 }, { outcome: "http_error", detail: "http", httpStatus: 600 }, { outcome: "http_error", detail: "http", httpStatus: "403" }]) {
      payload = { ...inspection(), resources: [{ ...inspection().resources[0], ...changes }] };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
    }
    for (const detail of ["unknown", "cancelled", "dns", "proxy", "connection", "tls", "timeout", "other"]) {
      payload = { ...inspection(), resources: [{ ...inspection().resources[0], detail }] };
      assert.equal((await inspectJdBrowserSession(session(), new AbortController().signal)).resources[0].detail, detail);
    }
  } finally { globalThis.fetch = original; }
});

test("inspect失败沿用服务分类，无效ID或预先取消不请求，接口错误不当作诊断成功", async () => {
  const original = globalThis.fetch;
  const actions: string[] = [];
  try {
    for (const code of ["login_required", "verification_required", "browser_session_expired", "timeout"] as const) {
      actions.length = 0;
      globalThis.fetch = async (_url, init) => { actions.push(JSON.parse(String(init?.body)).action); return json({ failure: { code, stage: "page", message: "无法检查。" } }, 422); };
      await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure(code));
      assert.deepEqual(actions, ["inspect"]);
    }
    actions.length = 0;
    await assert.rejects(inspectJdBrowserSession({ ...session(), sessionId: "short" }, new AbortController().signal), isFailure("service_unavailable"));
    const controller = new AbortController();
    const reason = new DOMException("检查已取消", "AbortError");
    controller.abort(reason);
    await assert.rejects(inspectJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
    assert.equal(actions.length, 0);
    globalThis.fetch = async () => json(inspection(), 503);
    await assert.rejects(inspectJdBrowserSession(session(), new AbortController().signal), isFailure("service_unavailable"));
  } finally { globalThis.fetch = original; }
});

test("inspect响应迟到或JSON解码时取消不会采用诊断，也不会隐式重试或读取正文", async () => {
  const original = globalThis.fetch;
  try {
    for (const duringDecode of [false, true]) {
      const controller = new AbortController();
      const reason = new DOMException("检查窗口已关闭", "AbortError");
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        actions.push(JSON.parse(String(init?.body)).action);
        const response = json(inspection());
        if (duringDecode) response.json = async () => { controller.abort(reason); return inspection(); };
        else controller.abort(reason);
        return response;
      };
      await assert.rejects(inspectJdBrowserSession(session(), controller.signal), (error: unknown) => error === reason);
      assert.deepEqual(actions, ["inspect"]);
    }
  } finally { globalThis.fetch = original; }
});
