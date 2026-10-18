import assert from "node:assert/strict";
import test from "node:test";
import { extractJdLink } from "../src/lib/jd-import.ts";
import { JdExtractionError, jdFailureGuidance, readJdFailure, type JdFailure } from "../src/lib/jd-errors.ts";

const link = "https://www.liepin.com/job/123.shtml";
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 400) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("岗位读取客户端保留后端失败分类和HTTP信息，仅连接失败引导代理", async () => {
  const original = globalThis.fetch;
  const failures: JdFailure[] = [
    { code: "network", stage: "connect", message: "尚未收到招聘平台响应。" },
    { code: "timeout", stage: "connect", message: "连接超时。" },
    { code: "login_required", stage: "http", message: "需要登录。", status: 401 },
    { code: "access_denied", stage: "http", message: "网站拒绝访问。", status: 403 },
    { code: "verification_required", stage: "http", message: "需要访问验证。", status: 403 },
    { code: "rate_limited", stage: "http", message: "请求过于频繁。", status: 429, retryAfterSeconds: 60 },
    { code: "unavailable", stage: "http", message: "岗位下线。", status: 410 },
    { code: "unsupported_page", stage: "page", message: "网页无可确认正文。" },
    { code: "ambiguous_jobs", stage: "page", message: "发现多条岗位。" },
    { code: "job_mismatch", stage: "page", message: "正文不是目标岗位。" },
    { code: "browser_unavailable", stage: "service", message: "本地浏览器未安装。" },
    { code: "browser_setup_required", stage: "service", message: "请在专用 Edge 完成或跳过首次设置。" },
    { code: "browser_required", stage: "page", message: "需要浏览器加载正文。" },
  ];
  try {
    for (const failure of failures) {
      globalThis.fetch = async () => json({ error: "通用外层错误不可覆盖分类", failure });
      await assert.rejects(() => extractJdLink(link, signal()), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.deepEqual(error.failure, failure);
        assert.equal(error.message, failure.message);
        assert.equal(jdFailureGuidance(error.failure).network, ["network", "timeout"].includes(failure.code));
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test("旧版error消息继续可读，未知远程分类不能指定客户端操作", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({ error: "旧版岗位读取错误", failure: { code: "open_url", stage: "page", message: "打开任意地址", url: "https://unknown.example" } });
    await assert.rejects(() => extractJdLink(link, signal()), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error.message, "旧版岗位读取错误");
      assert.equal(error.failure.code, "unsupported_page");
      assert.equal(jdFailureGuidance(error.failure).network, false);
      return true;
    });
    assert.deepEqual(readJdFailure({ code: "rate_limited", stage: "http", message: "稍后再读", status: 429, retryAfterSeconds: 1.5, url: "https://unknown.example", network: true }), { code: "rate_limited", stage: "http", message: "稍后再读", status: 429, retryAfterSeconds: 2 });
  } finally { globalThis.fetch = original; }
});

test("缺失静态服务、无效JSON和损坏成功响应归为服务失败而非招聘站网络", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of ["<html>静态首页</html>", "null", "[]", "{}", JSON.stringify({ text: "岗位职责", provenance: [] }), JSON.stringify({ text: "岗位职责", provenance: { url: link, observedAt: "invalid" } }), JSON.stringify({ text: "岗位职责", provenance: { url: "https://unknown.example/job", observedAt: "2026-10-17T08:00:00Z" } })]) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(() => extractJdLink(link, signal()), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "service_unavailable");
        assert.equal(error.failure.stage, "service");
        assert.equal(jdFailureGuidance(error.failure).network, false);
        return true;
      });
    }
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch local service"); };
    await assert.rejects(() => extractJdLink(link, signal()), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
  } finally { globalThis.fetch = original; }
});

test("取消保持AbortError交给调用方隔离，不伪装成招聘站失败", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const abortError = new DOMException("Cancelled", "AbortError");
  try {
    globalThis.fetch = async () => { controller.abort(); throw abortError; };
    await assert.rejects(() => extractJdLink(link, controller.signal), (error: unknown) => error === abortError);
  } finally { globalThis.fetch = original; }
});

test("无效分享链接在请求前拒绝，有效正文与原始来源仍可核对", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return json({ text: "岗位职责：开发任务队列并维护回归用例。", provenance: { kind: "link", url: link, observedAt: "2026-10-17T08:00:00Z", title: "测试岗位" }, method: "JobPosting" }, 200);
    };
    await assert.rejects(() => extractJdLink("https://unknown.example/job", signal()), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "invalid_link");
    assert.equal(calls, 0);
    const result = await extractJdLink(link, signal());
    assert.equal(calls, 1);
    assert.equal(result.text, "岗位职责：开发任务队列并维护回归用例。");
    assert.equal(result.provenance.url, link);
    assert.equal(result.provenance.platform, "猎聘");
    assert.equal(result.method, "JobPosting");
  } finally { globalThis.fetch = original; }
});

test("浏览器读取必须显式选择且不改变默认静态请求或用户分享地址", async () => {
  const original = globalThis.fetch;
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/exampleToken?fromSource=2&openWeapp=1";
  const input = `请看这个岗位 ${mobile}`;
  const controller = new AbortController();
  const bodies: unknown[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/extract");
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      bodies.push(JSON.parse(String(init?.body)));
      return json({ text: "职责：编写设备通信服务；要求熟悉异步编程与回归测试。", provenance: { kind: "link", url: mobile, observedAt: "2026-10-17T08:00:00Z", title: "研发工程师" }, method: "浏览器可见正文" }, 200);
    };
    await extractJdLink(input, controller.signal);
    const result = await extractJdLink(input, controller.signal, "browser");
    assert.deepEqual(bodies, [{ input }, { input, mode: "browser" }]);
    assert.equal(result.provenance.url, mobile);
    assert.equal(result.provenance.platform, "BOSS直聘");
    assert.equal(result.method, "浏览器可见正文");
  } finally { globalThis.fetch = original; }
});

test("浏览器不可用保留服务错误且不会偷偷回退静态读取或重试", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const failure: JdFailure = { code: "browser_unavailable", stage: "service", message: "没有可用的本地浏览器。" };
  try {
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      assert.equal(JSON.parse(String(init?.body)).mode, "browser");
      return json({ failure });
    };
    await assert.rejects(() => extractJdLink(link, signal(), "browser"), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.deepEqual(error.failure, failure);
      assert.equal(jdFailureGuidance(error.failure).network, false);
      assert.match(jdFailureGuidance(error.failure).title, /浏览器/);
      return true;
    });
    assert.equal(calls, 1);
    assert.match(jdFailureGuidance({ code: "browser_required", stage: "page", message: "动态加载" }).guidance, /浏览器读取/);
  } finally { globalThis.fetch = original; }
});

test("浏览器结果在取消后即使完成正文解码也不能返回为成功", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("用户已换链接", "AbortError");
  try {
    const response = json({});
    response.json = async () => {
      controller.abort(reason);
      return { text: "旧岗位正文不能重新采用。", provenance: { url: link, observedAt: "2026-10-17T08:00:00Z" } };
    };
    globalThis.fetch = async () => response;
    await assert.rejects(() => extractJdLink(link, controller.signal, "browser"), (error: unknown) => error === reason);
  } finally { globalThis.fetch = original; }
});
