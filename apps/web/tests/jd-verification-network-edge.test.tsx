import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page } from "playwright-core";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { inspectJdBrowserSession } from "../src/lib/jd-import.ts";
import { readVerificationNetworkSnapshot } from "../src/lib/jd-verification-network.ts";

// Every browser request is intercepted locally. The dead proxy also prevents
// external access if a future change accidentally skips the fixture handler.
test("真实隔离Chromium通过实际网络事件记录51job验证传输，HTTP200不代表验证通过且不泄露内容", { timeout: 20_000 }, async () => {
  const original = "https://jobs.51job.com/shanghai/166509900.html";
  const deviceHost = "device.captcha-open.aliyuncs.com";
  const uploadHost = "upload.captcha-pro-open.aliyuncs.com";
  const scriptUrl = `https://${deviceHost}/private-script-location.js?signature=script-query-secret`;
  const successUrl = `https://${deviceHost}/private-fetch-location?signature=fetch-query-secret`;
  const failedUrl = `https://${uploadHost}/private-failure-location?signature=failed-query-secret`;
  const requestBody = "synthetic-private-request-body";
  const responseBody = "synthetic-private-response-body";
  const owner = "http://localhost:5175";
  const originalFetch = globalThis.fetch;
  let page: Page | undefined;
  let mainRequests = 0;
  const routed = new Set<string>();
  const manager = createBrowserSessionManager({
    getOperation: async () => ({
      fetch: async () => { throw new Error("synthetic browser test forbids preflight"); },
      routeFor: () => ({ mode: "manual", source: "isolated verification event fixture", proxyUrl: "http://127.0.0.1:1" }),
    }),
    launch: async options => {
      const browser = await chromium.launch({ ...options, headless: true, channel: process.platform === "win32" ? "msedge" : "chrome" });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async contextOptions => {
        const context = await newContext(contextOptions);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          // The manager has registered its guard before calling newPage. This
          // later handler takes precedence and never continues to the network.
          await context.route("**/*", async route => {
            const request = route.request(), url = request.url();
            routed.add(url);
            if (url === original) {
              if (request.isNavigationRequest()) mainRequests++;
              await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><title>安全验证</title><meta name="aliyun_waf_fixture"><script src="${scriptUrl}"></script></head><body><main>请完成访问验证</main></body></html>` });
            } else if (url === scriptUrl) {
              await route.fulfill({ contentType: "text/javascript", body: "window.syntheticVerificationScriptLoaded=true;" });
            } else if (url === successUrl) {
              assert.equal(request.method(), "POST");
              assert.equal(request.postData(), requestBody);
              await route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: responseBody });
            } else if (url === failedUrl) {
              assert.equal(request.method(), "POST");
              assert.equal(request.postData(), requestBody);
              await route.abort("connectionreset");
            } else await route.abort("blockedbyclient");
          });
          page = await newPage();
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  try {
    const session = await manager.start(owner, original);
    assert.ok(page);
    assert.equal(await page.evaluate("window.syntheticVerificationScriptLoaded"), true);
    const finished = page.waitForEvent("requestfinished", request => request.url() === successUrl);
    const failed = page.waitForEvent("requestfailed", request => request.url() === failedUrl);
    const values = await page.evaluate(async ({ successUrl, failedUrl, requestBody }) => {
      const options = { method: "POST", headers: { "Content-Type": "text/plain" }, body: requestBody };
      const success = await fetch(successUrl, options);
      const value = await success.text();
      let rejected = false;
      try { await fetch(failedUrl, options); } catch { rejected = true; }
      return { status: success.status, value, rejected };
    }, { successUrl, failedUrl, requestBody });
    const [successfulRequest, failedRequest] = await Promise.all([finished, failed]);
    assert.deepEqual(values, { status: 200, value: responseBody, rejected: true });
    assert.equal((await successfulRequest.response())?.status(), 200);
    assert.ok(failedRequest.failure());

    const inspection = await manager.inspect(owner, session.sessionId);
    assert.equal(inspection.gate, "verification_required", "successful transport never means the site's verification passed");
    assert.equal(inspection.snapshotState, "ready");
    assert.equal(inspection.mainDocumentRequests, 1);
    assert.equal(mainRequests, 1);
    assert.deepEqual(inspection.mainDocument, { state: "response", status: 200 });
    const network = inspection.verificationNetwork;
    assert.ok(network);
    assert.equal(network.truncated, false);
    assert.deepEqual(readVerificationNetworkSnapshot(network), network);
    assert.equal(network.requests.length, 3);
    const deviceFetch = network.requests.find(request => request.host === deviceHost && request.type === "fetch");
    const uploadFetch = network.requests.find(request => request.host === uploadHost && request.type === "fetch");
    const deviceScript = network.requests.find(request => request.host === deviceHost && request.type === "script");
    assert.ok(deviceFetch); assert.ok(uploadFetch); assert.ok(deviceScript);
    for (const request of [deviceFetch, deviceScript]) {
      const events = network.events.filter(event => event.requestId === request.id);
      assert.deepEqual(events.map(event => event.phase), ["request", "response", "finished"]);
      assert.equal(events[1].status, 200);
    }
    assert.deepEqual(network.events.filter(event => event.requestId === uploadFetch.id).map(event => event.phase), ["request", "failed"]);
    for (const [index, event] of network.events.entries()) {
      assert.ok(Number.isInteger(event.atMs) && event.atMs >= (network.events[index - 1]?.atMs ?? 0));
      assert.deepEqual(Object.keys(event).sort(), (event.phase === "response" ? ["requestId", "phase", "atMs", "status"] : ["requestId", "phase", "atMs"]).sort());
    }
    for (const request of network.requests) assert.deepEqual(Object.keys(request).sort(), ["host", "id", "type"]);

    // Exercise the production client's strict inspection parser on the actual
    // server snapshot instead of constructing a separately valid fixture.
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { action: "inspect", sessionId: session.sessionId });
      return new Response(JSON.stringify(inspection), { headers: { "Content-Type": "application/json" } });
    };
    const client = await inspectJdBrowserSession(session, new AbortController().signal);
    assert.deepEqual(client.verificationNetwork, network);
    assert.equal(client.gate, "verification_required");
    assert.equal(client.mainDocumentRequests, 1);
    const serialized = JSON.stringify({ inspection, client });
    for (const secret of ["private-script-location", "private-fetch-location", "private-failure-location", "signature", "script-query-secret", "fetch-query-secret", "failed-query-secret", requestBody, responseBody]) assert.equal(serialized.includes(secret), false, secret);
    assert.deepEqual([...routed].sort(), [original, scriptUrl, successUrl, failedUrl].sort());
    assert.equal(manager.isActive(owner, session.sessionId), true);
  } finally {
    globalThis.fetch = originalFetch;
    await manager.closeAll();
  }
  assert.equal(page?.isClosed(), true, "the isolated browser is fully cleaned up");
});
