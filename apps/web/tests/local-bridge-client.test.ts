import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { cookieBridgeBookmarklet, requestLocalBridgeGrant } from "../src/lib/local-bridge-client.ts";

test("bookmarklet requests only a single authorized import and does not read cookies on unrelated sites", async () => {
  const token = "a".repeat(64);
  const script = cookieBridgeBookmarklet("http://127.0.0.1:54321", token).replace(/^javascript:/, "");
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  let reads = 0;
  const document = { get cookie() { reads++; return "synthetic=value"; } };
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => { calls.push({ url, init }); return { json: async () => ({ success: true, count: 1 }) }; };
  for (const hostname of ["untrusted.invalid", "zhipin.com.untrusted.invalid"]) {
    runInNewContext(script, { location: { protocol: "https:", hostname }, document, fetch, alert() {} });
  }
  assert.equal(reads, 0); assert.equal(calls.length, 0);
  runInNewContext(script, { location: { protocol: "https:", hostname: "www.zhipin.com" }, document, fetch, alert() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:54321/api/jd/cookie-bridge");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(calls[0].init.body).cookies, [{ name: "synthetic", value: "value", domain: "www.zhipin.com" }]);
  assert.throws(() => cookieBridgeBookmarklet("https://untrusted.invalid", token));
});

test("workbench pairing is explicit and uses a non-simple header without storing credentials", async context => {
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  context.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ token: "a".repeat(64), expiresAt: 600_000 }));
  });
  assert.equal(calls.length, 0);
  await requestLocalBridgeGrant("job", "chrome-extension://synthetic-id");
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/jd/bridge-grant");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-BetterMe-Bridge"], "1");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { purpose: "job", origin: "chrome-extension://synthetic-id" });
});
