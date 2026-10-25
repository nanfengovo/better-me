import assert from "node:assert/strict";
import test from "node:test";
import { extractJdLinkWithAutoBrowser } from "../src/lib/jd-import.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const link = "https://m.zhipin.com/mpa/html/weijd/weijd-job/fixtureToken?fromSource=2";
const success = () => new Response(JSON.stringify({
  text: "岗位职责：维护设备通信服务并编写回归测试。任职要求：熟悉 C# 与 SQL Server。",
  title: "合成岗位",
  method: "公开岗位详情正文",
  provenance: { kind: "link", platform: "BOSS直聘", url: link, observedAt: "2026-10-21T14:00:00Z" },
}), { headers: { "Content-Type": "application/json" } });

async function withFetch(fetchImpl: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("本地开发服务重启导致连接中断时自动重连并完成读取", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return success();
  }, async () => {
    const result = await extractJdLinkWithAutoBrowser(link, new AbortController().signal, 1);
    assert.equal(calls, 2);
    assert.match(result.text, /岗位职责/);
  });
});

test("多次重连仍失败时报连接中断，而不是无限重试", async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(
      extractJdLinkWithAutoBrowser(link, new AbortController().signal, 1),
      (error: unknown) => error instanceof JdExtractionError && error.failure.code === "service_unavailable" && /连接中断/.test(error.message),
    );
    assert.equal(calls, 3);
  });
});

test("服务返回的业务失败不重试", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "需要验证", failure: { code: "verification_required", stage: "page", message: "需要验证" } }), { status: 422, headers: { "Content-Type": "application/json" } });
  }, async () => {
    await assert.rejects(extractJdLinkWithAutoBrowser(link, new AbortController().signal, 1), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "verification_required");
    assert.equal(calls, 1);
  });
});

test("用户取消后不再重连", async () => {
  const controller = new AbortController();
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    controller.abort(new DOMException("cancel", "AbortError"));
    throw controller.signal.reason;
  }, async () => {
    await assert.rejects(extractJdLinkWithAutoBrowser(link, controller.signal, 1), { name: "AbortError" });
    assert.equal(calls, 1);
  });
});
