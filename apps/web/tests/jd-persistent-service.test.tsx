import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { browserSessionMiddleware } from "../server/jd-extractor.ts";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { stopJdPersistentBrowser } from "../src/lib/jd-import.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

// No browser launches: this checks the actual local HTTP action and client contract.
test("显式stop-browser受本机同源约束，先释放岗位再关闭常驻窗口", async () => {
  const manager = createBrowserSessionManager();
  const calls: string[] = [];
  let failStop = false;
  manager.closeAll = async () => { calls.push("pages"); };
  const server = createHttpServer((request, response) => {
    void browserSessionMiddleware(request, response, manager, async () => {
      calls.push("contexts");
      if (failStop) throw new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "未能确认窗口关闭" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (requestOrigin: string) => fetch(`${origin}/api/jd/browser-session`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify({ action: "stop-browser" }),
  });
  try {
    assert.equal((await post("https://evil.test")).status, 403);
    assert.deepEqual(calls, []);
    const response = await post(origin);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { closed: true });
    assert.deepEqual(calls, ["pages", "contexts"]);
    failStop = true;
    const failed = await post(origin);
    assert.equal(failed.status, 422);
    const payload = await failed.json();
    assert.equal(payload.closed, undefined);
    assert.equal(payload.failure.code, "browser_unavailable");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("关闭常驻浏览器客户端严格核对closed与服务错误，不发送任意目录", async () => {
  const originalFetch = globalThis.fetch;
  let payload: unknown = { closed: true };
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/jd/browser-session");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "stop-browser" });
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    };
    await stopJdPersistentBrowser();
    for (const invalid of [{}, { closed: false }, { closed: "true" }]) {
      payload = invalid;
      await assert.rejects(stopJdPersistentBrowser(), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
    }
    payload = { failure: { code: "browser_unavailable", stage: "service", message: "窗口尚未关闭" } };
    await assert.rejects(stopJdPersistentBrowser(), (error: unknown) => error instanceof JdExtractionError && error.failure.message === "窗口尚未关闭");
  } finally { globalThis.fetch = originalFetch; }
});
