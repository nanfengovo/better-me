import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Frame, Page, Request, Response } from "playwright-core";
import { createBossResponseObserver, isBossDetailResponseUrl, MAX_BOSS_RESPONSE_BYTES, parseBossDetailResponse } from "../server/jd-boss-response.ts";
import type { BrowserSnapshot } from "../server/jd-browser-snapshot.ts";

const jobId = "anonymousJob-AB_12";
const sourceUrl = `https://m.zhipin.com/mpa/html/weijd/weijd-job/${jobId}?fromSource=2`;
const endpoint = "https://m.zhipin.com/wapi/zpgeek/job/detail.json?securityId=not-inspected";
const title = "高级 C# 软件工程师";
const company = "匿名设备研发公司";
const description = "岗位职责：研发设备通信服务，交付完整回归测试。\n任职要求：熟悉 C#、SQL Server、异步编程与接口文档。\n最后一项：能够阅读英文技术资料。";
const payload = (overrides: Record<string, unknown> = {}) => ({ code: 0, zpData: { jobInfo: { encryptJobId: jobId, jobName: title, jobDesc: description, ...overrides }, brandComInfo: { brandName: company } } });
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = `<h1>${title}</h1><p>${company}</p><main>${description.split("\n").map((text) => `<p>${escaped(text)}</p>`).join("")}</main>`;
const snapshot = (overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({ html, url: sourceUrl, title, ...overrides });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(options: { signal?: AbortSignal; expectedJobId?: string; sourceUrl?: string } = {}) {
  const events = new EventEmitter();
  const frame = {} as Frame;
  let location = sourceUrl;
  let closed = false;
  let bodyReads = 0;
  const page = Object.assign(events, {
    mainFrame: () => frame,
    url: () => location,
    isClosed: () => closed,
  }) as unknown as Page;
  const observer = createBossResponseObserver(page, { expectedJobId: jobId, sourceUrl, now: () => 1_700_000_000_000, ...options });
  const request = (overrides: Partial<Request> = {}) => ({
    url: () => endpoint, resourceType: () => "xhr", method: () => "GET", frame: () => frame, isNavigationRequest: () => false, ...overrides,
  }) as unknown as Request;
  const response = (req: Request, value: unknown = payload(), overrides: Partial<Response> = {}) => ({
    request: () => req, url: () => req.url(), status: () => 200,
    headerValue: async (name: string) => name === "content-type" ? "application/json; charset=utf-8" : null,
    body: async () => { bodyReads += 1; return Buffer.from(JSON.stringify(value)); },
    ...overrides,
  }) as unknown as Response;
  const receive = async (value: unknown = payload(), requestOverrides: Partial<Request> = {}, responseOverrides: Partial<Response> = {}) => {
    const req = request(requestOverrides);
    events.emit("request", req);
    events.emit("response", response(req, value, responseOverrides));
    await flush();
    return req;
  };
  return {
    events, page, frame, observer, request, response, receive, bodyReads: () => bodyReads,
    candidate: (value = snapshot(), committed = true) => observer.candidate(value, { committed }),
    location: (url: string) => { location = url; },
    close: () => { closed = true; events.emit("close"); },
  };
}

test("BOSS仅识别成功的已知响应结构、精确岗位ID和完整文本字段", () => {
  assert.deepEqual(parseBossDetailResponse(payload(), jobId), { jobId, title, description, company });
  const unknown = [null, [], {}, { code: "0", zpData: payload().zpData }, { code: 1, zpData: payload().zpData }, { code: 0, data: payload().zpData }, { code: 0, zpData: [] }, { code: 0, zpData: { jobInfo: [] } }, payload({ encryptJobId: jobId.toLowerCase() }), payload({ encryptJobId: 123 }), payload({ jobName: {} }), payload({ jobDesc: [description] }), payload({ jobDesc: undefined }), payload({ jobName: undefined })];
  for (const value of unknown) assert.equal(parseBossDetailResponse(value, jobId), undefined);
  assert.equal(parseBossDetailResponse(payload(), ""), undefined);
  assert.equal(parseBossDetailResponse(payload(), `${jobId}/other`), undefined);
});

test("BOSS文本采用有界但不截断，拒绝过短/控制字符/HTML和未知替代字段", () => {
  const parsed = parseBossDetailResponse(payload({ jobDesc: `  ${description}\r\n末尾不得丢失  ` }), jobId);
  assert.equal(parsed?.description, `${description}\n末尾不得丢失`);
  for (const fields of [{ jobDesc: "短摘要" }, { jobDesc: "x".repeat(120_001) }, { jobName: "x".repeat(301) }, { jobName: `${title}\n其他岗位` }, { jobDesc: `${description}\u0000` }, { jobDesc: `<div>${description}</div>` }, { jobDesc: undefined, description }, { jobName: "   " }]) assert.equal(parseBossDetailResponse(payload(fields), jobId), undefined);
  const missingCompany = payload();
  delete (missingCompany.zpData as { brandComInfo?: unknown }).brandComInfo;
  assert.deepEqual(parseBossDetailResponse(missingCompany, jobId), { jobId, title, description });
});

test("BOSS只接受官方m/www精确HTTPS443 detail.json端点", () => {
  for (const url of [endpoint, endpoint.replace("m.zhipin", "www.zhipin"), "https://m.zhipin.com:443/wapi/zpgeek/job/detail.json"]) assert.equal(isBossDetailResponseUrl(url), true, url);
  for (const url of [endpoint.replace("https:", "http:"), endpoint.replace("m.zhipin.com", "zhipin.com"), endpoint.replace("m.zhipin.com", "m.zhipin.com.attacker.test"), endpoint.replace("m.zhipin.com", "m.zhipin.com:444"), endpoint.replace("m.zhipin.com", "user@m.zhipin.com"), endpoint.replace("detail.json", "detail.json/"), endpoint.replace("detail.json", "other.json"), endpoint.replace("detail.json", "detail%2ejson"), `${endpoint}#fragment`, "not a URL"]) assert.equal(isBossDetailResponseUrl(url), false, url);
});

test("被动观察器只接纳本页自然Request响应，生成可追溯的原链接候选", async () => {
  const f = fixture();
  try {
    f.events.emit("response", f.response(f.request()));
    await flush();
    assert.equal(f.candidate(), undefined, "a response with no observed page request is not evidence");
    assert.equal(f.bodyReads(), 0);
    await f.receive();
    const result = f.candidate();
    assert.deepEqual(result, {
      text: [title, company, description].join("\n\n"), method: "BOSS 自然响应 + 当前可见岗位正文核对",
      provenance: { kind: "link", platform: "BOSS直聘", url: sourceUrl, title, observedAt: "2023-11-14T22:13:20.000Z" },
    });
    assert.equal(f.events.listenerCount("response"), 1);
  } finally { f.observer.dispose(); }
});

test("标题与整段描述须在当前可见DOM核对，截断尾项、仅head标题及隐藏数据均不能成功", async () => {
  const f = fixture();
  try {
    await f.receive();
    for (const value of [
      `<title>${title}</title><p>${escaped(description)}</p>`,
      `<h1>${title}</h1><p>${escaped(description.split("\n").slice(0, -1).join("\n"))}</p>`,
      `<h1>${title}</h1><div hidden>${escaped(description)}</div>`,
      `<h1>${title}</h1><div aria-hidden="true">${escaped(description)}</div>`,
      `<h1>${title}</h1><div style="display: none !important">${escaped(description)}</div>`,
      `<h1>${title}</h1><div style="visibility:hidden">${escaped(description)}</div>`,
      `<h1>${title}</h1><div style="opacity:0.0">${escaped(description)}</div>`,
      `<h1>${title}</h1><script type="application/ld+json">${JSON.stringify(payload())}</script>`,
      `<h1>${title}</h1><div class="recommend"><p>${escaped(description)}</p></div>`,
      `<h1>${title}</h1><nav>${escaped(description)}</nav>`,
    ]) assert.equal(f.candidate(snapshot({ html: value })), undefined);
    assert.ok(f.candidate(snapshot({ html: `<h1>高级\tC#\n软件工程师</h1><p>${escaped(description.replaceAll("\n", "  \n  "))}</p>` })), "only whitespace is normalized; no description words or tail items may disappear");
    assert.equal(f.candidate(snapshot({ oversized: true })), undefined);
    assert.equal(f.candidate(snapshot({ html: "x".repeat(MAX_BOSS_RESPONSE_BYTES + 1) })), undefined);
  } finally { f.observer.dispose(); }
});

test("公司只有当前可见时加入，不使用API隐藏公司或补造公司", async () => {
  const f = fixture();
  try {
    await f.receive();
    const noCompany = `<h1>${title}</h1><p hidden>${company}</p><p>${escaped(description)}</p>`;
    assert.equal(f.candidate(snapshot({ html: noCompany }))?.text, [title, description].join("\n\n"));
    assert.ok(f.candidate()?.text.includes(company));
  } finally { f.observer.dispose(); }
});

test("可见登录/验证优先于候选，未提交或非同岗快照始终不能采用", async () => {
  const f = fixture();
  try {
    await f.receive();
    assert.equal(f.candidate(snapshot(), false), undefined);
    for (const gate of ["login_required", "verification_required"] as const) {
      assert.equal(f.candidate(snapshot({ gate })), undefined);
      assert.equal(f.observer.candidate(snapshot(), { committed: true, gate }), undefined);
    }
    assert.equal(f.candidate(snapshot({ html: `<title>安全验证</title>${html}` })), undefined);
    assert.equal(f.candidate(snapshot({ html: `${html}<div role="dialog">请完成访问验证</div>` })), undefined);
    assert.ok(f.candidate(snapshot({ html: `${html}<div role="dialog" hidden>请完成访问验证</div>` })));
    assert.equal(f.candidate(snapshot({ url: sourceUrl.replace(jobId, "otherJob") })), undefined);
    f.location(sourceUrl.replace(jobId, "otherJob"));
    assert.equal(f.candidate(), undefined);
    f.location(sourceUrl);
    assert.equal(f.candidate(snapshot({ html: `<link rel="canonical" href="/job_detail/otherJob.html">${html}` })), undefined);
    assert.ok(f.candidate(snapshot({ html: `<link rel="canonical" href="https://www.zhipin.com/job_detail/${jobId}.html">${html}` })));
  } finally { f.observer.dispose(); }
});

test("主导航和同文档导航都清空候选，子frame导航不能污染岗位候选", async () => {
  const f = fixture();
  try {
    await f.receive();
    f.events.emit("framenavigated", {});
    assert.ok(f.candidate());
    f.events.emit("request", f.request({ isNavigationRequest: () => true, resourceType: () => "document" }));
    assert.equal(f.candidate(), undefined);
    f.events.emit("framenavigated", f.frame);
    await f.receive();
    assert.ok(f.candidate());
    f.events.emit("framenavigated", f.frame);
    assert.equal(f.candidate(), undefined, "including a same-URL or same-document main-frame navigation");
  } finally { f.observer.dispose(); }
});

test("响应body迟到跨导航不能复活，旧Request迟到响应也不能冒充新文档", async () => {
  const f = fixture();
  const pending = deferred<Buffer>();
  try {
    const old = await f.receive(payload(), {}, { body: () => pending.promise });
    f.events.emit("request", f.request({ isNavigationRequest: () => true, resourceType: () => "document" }));
    f.events.emit("framenavigated", f.frame);
    pending.resolve(Buffer.from(JSON.stringify(payload())));
    await flush();
    assert.equal(f.candidate(), undefined);
    f.events.emit("response", f.response(old));
    await flush();
    assert.equal(f.candidate(), undefined);
    await f.receive();
    assert.ok(f.candidate());
  } finally { f.observer.dispose(); }
});

test("同页较新API请求清除旧候选，乱序旧响应和失败请求均不被采用", async () => {
  const f = fixture();
  const pending = deferred<Buffer>();
  try {
    await f.receive(payload(), {}, { body: () => pending.promise });
    await f.receive(payload({ encryptJobId: "otherJob" }));
    pending.resolve(Buffer.from(JSON.stringify(payload())));
    await flush();
    assert.equal(f.candidate(), undefined);
    const current = await f.receive();
    assert.ok(f.candidate());
    f.events.emit("requestfailed", current);
    assert.equal(f.candidate(), undefined);
    f.events.emit("response", f.response(current));
    await flush();
    assert.equal(f.candidate(), undefined);
  } finally { f.observer.dispose(); }
});

test("其它frame、非XHR/fetch、POST、未支持端点与失败HTTP不读取响应body", async () => {
  for (const requestOverrides of [{ frame: () => ({}) as Frame }, { frame: () => { throw new Error("unavailable"); } }, { resourceType: () => "document" }, { resourceType: () => "script" }, { method: () => "POST" }, { url: () => endpoint.replace("m.zhipin.com", "attacker.test") }, { url: () => endpoint.replace("detail.json", "list.json") }]) {
    const f = fixture();
    try { await f.receive(payload(), requestOverrides); assert.equal(f.candidate(), undefined); assert.equal(f.bodyReads(), 0); }
    finally { f.observer.dispose(); }
  }
  const f = fixture();
  try {
    await f.receive(payload(), {}, { status: () => 403 });
    assert.equal(f.candidate(), undefined);
    assert.equal(f.bodyReads(), 0);
    await f.receive(payload(), {}, { url: () => endpoint.replace("m.zhipin.com", "attacker.test") });
    assert.equal(f.candidate(), undefined);
    assert.equal(f.bodyReads(), 0);
  } finally { f.observer.dispose(); }
});

test("JSON类型与2MiB仅采用上限：超大声明不读body、实际超限/坏JSON/读取失败保守拒绝", async () => {
  const f = fixture();
  try {
    for (const contentType of [null, "text/html", "text/plain", "application/jsonp"]) {
      await f.receive(payload(), {}, { headerValue: async (name) => name === "content-type" ? contentType : null });
      assert.equal(f.candidate(), undefined);
    }
    assert.equal(f.bodyReads(), 0);
    for (const length of [String(MAX_BOSS_RESPONSE_BYTES + 1), "not-a-size", "-1"]) {
      await f.receive(payload(), {}, { headerValue: async (name) => name === "content-type" ? "application/json" : length });
      assert.equal(f.candidate(), undefined);
    }
    assert.equal(f.bodyReads(), 0);
    await f.receive(payload(), {}, { body: async () => Buffer.alloc(MAX_BOSS_RESPONSE_BYTES + 1, "x") });
    assert.equal(f.candidate(), undefined);
    await f.receive(payload(), {}, { body: async () => Buffer.from("not JSON") });
    assert.equal(f.candidate(), undefined);
    await f.receive(payload(), {}, { body: async () => { throw new Error("body unavailable"); } });
    assert.equal(f.candidate(), undefined);
    await f.receive();
    assert.ok(f.candidate());
  } finally { f.observer.dispose(); }
});

test("取消/关页/显式dispose移除本观察器并清候选，迟到body不会复活", async () => {
  for (const reason of ["abort", "close", "dispose"] as const) {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    const pending = deferred<Buffer>();
    await f.receive(payload(), {}, { body: () => pending.promise });
    if (reason === "abort") controller.abort();
    else if (reason === "close") f.close();
    else f.observer.dispose();
    assert.equal(f.events.listenerCount("request"), 0);
    assert.equal(f.events.listenerCount("response"), 0);
    pending.resolve(Buffer.from(JSON.stringify(payload())));
    await flush();
    assert.equal(f.candidate(), undefined);
    await f.receive();
    assert.equal(f.candidate(), undefined);
    f.observer.dispose();
  }
});

test("预取消或原岗位ID不匹配时不采用任何响应，原ID大小写严格匹配", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({ signal: controller.signal });
  assert.equal(f.events.listenerCount("response"), 0);
  await f.receive();
  assert.equal(f.candidate(), undefined);
  const other = fixture({ expectedJobId: "otherJob" });
  try { await other.receive(); assert.equal(other.candidate(), undefined); assert.equal(other.bodyReads(), 0); }
  finally { other.observer.dispose(); }
});
