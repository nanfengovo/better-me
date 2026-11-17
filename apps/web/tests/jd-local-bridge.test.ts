import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { jdExtractionMiddleware } from "../server/jd-extractor.ts";
import { createLocalBridge } from "../server/local-bridge.ts";

async function rawHostRequest(url: string, host: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { method: body === undefined ? "GET" : "POST", headers: { ...headers, Host: host } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("unrelated websites cannot write or read the local job synchronization bridge", async () => {
  const server = createServer((req, res) => { void jdExtractionMiddleware(req, res, () => { res.writeHead(404); res.end(); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { Origin: "https://untrusted.invalid", "Content-Type": "application/json" };
    const write = await fetch(`${origin}/api/jd/sync-extension`, { method: "POST", headers,
      body: JSON.stringify({ title: "Synthetic security regression", description: "No real job or cookie" }) });
    const read = await fetch(`${origin}/api/jd/sync-extension`, { headers });
    assert.equal(write.status, 403, "unpaired foreign writes must be rejected");
    assert.equal(read.status, 403, "foreign reads must be rejected");
    assert.equal(read.headers.get("access-control-allow-origin"), null);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("paired job sync preserves local polling, but rejects replay, cross-purpose, origin and owner changes", async () => {
  let clock = 1000;
  let injections = 0;
  const bridge = createLocalBridge({ now: () => clock, injectCookies: async () => { injections++; return { success: true, count: 1 }; } });
  const server = createServer((req, res) => { void bridge(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const local = { Origin: origin, "X-BetterMe-Bridge": "1", "Content-Type": "application/json" };
  const request = (route: string, headers: Record<string, string>, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(origin + "/api/jd/" + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const grant = async (purpose: "job" | "cookies", sender = "https://sender.invalid") => {
    const response = await request("bridge-grant", local, { purpose, origin: sender });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    return (await response.json()).token as string;
  };
  try {
    assert.equal((await request("bridge-grant", { Origin: "https://untrusted.invalid", "Content-Type": "application/json" }, { purpose: "cookies" })).status, 403);
    assert.equal((await request("sync-extension", {})).status, 403, "origin-less GET still requires non-simple workbench header");
    const token = await grant("job");
    const sender = { Origin: "https://sender.invalid", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const preflight = await request("sync-extension", { Origin: sender.Origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization" }, undefined, "OPTIONS");
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), sender.Origin);
    const job = { title: "Synthetic engineer", company: "Synthetic company", description: "Synthetic JD" };
    assert.equal((await request("cookie-bridge", sender, { cookies: [] })).status, 403);
    assert.equal((await request("sync-extension", { ...sender, Origin: "https://other.invalid" }, job)).status, 403);
    assert.equal((await rawHostRequest(origin + "/api/jd/sync-extension", "localhost:54321", sender, job)).status, 403);
    assert.equal((await request("sync-extension", sender, job)).status, 200);
    assert.equal((await request("sync-extension", sender, job)).status, 403, "single-use grant cannot replay");
    assert.equal((await request("sync-extension", sender)).status, 403, "sender never obtains read authority");
    const read = await request("sync-extension", local);
    assert.equal((await read.json()).latest.title, job.title);
    const otherOwner = await rawHostRequest(origin + "/api/jd/sync-extension", "localhost:54321", { "X-BetterMe-Bridge": "1" });
    assert.equal(JSON.parse(otherOwner.body).latest, null);
    const old = await grant("job"); const replacement = await grant("job");
    assert.notEqual(old, replacement);
    assert.equal((await request("sync-extension", { ...sender, Authorization: `Bearer ${old}` }, job)).status, 403);
    clock += 600_001;
    assert.equal((await request("sync-extension", { ...sender, Authorization: `Bearer ${replacement}` }, job)).status, 403);
    assert.equal((await (await request("sync-extension", local)).json()).latest, null, "synced payload expires as well");
    assert.equal(injections, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("cookie bridge uses validated synthetic cookies once, with bounded JSON and no remote CDP target", async () => {
  const injected: unknown[] = [];
  const bridge = createLocalBridge({ injectCookies: async cookies => { injected.push(cookies); return { success: true, count: cookies.length }; } });
  const server = createServer((req, res) => { void bridge(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const local = { Origin: origin, "X-BetterMe-Bridge": "1", "Content-Type": "application/json" };
  const post = (route: string, headers: Record<string, string>, body: unknown) => fetch(origin + "/api/jd/" + route, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const token = (await (await post("bridge-grant", local, { purpose: "cookies" })).json()).token;
    const sender = { Origin: "https://www.zhipin.com", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const cookies = [{ name: "synthetic", value: "synthetic-value", domain: ".zhipin.com" }];
    assert.equal((await post("cookie-bridge", { ...sender, Origin: "https://zhipin.com.untrusted.invalid" }, { cookies })).status, 403);
    assert.equal((await post("cookie-bridge", { ...sender, Origin: "null" }, { cookies })).status, 403);
    assert.equal((await post("cookie-bridge", { ...sender, Origin: "https://www.zhipin.com:8443" }, { cookies })).status, 403);
    assert.equal((await post("cookie-bridge", sender, { cookies: [{ ...cookies[0], domain: ".linkedin.com" }] })).status, 400);
    assert.equal((await post("cookie-bridge", sender, { cookies: [{ ...cookies[0], domain: ".com" }] })).status, 400);
    assert.equal((await post("cookie-bridge", { ...local, "Content-Type": "text/plain" }, { cookies })).status, 403);
    assert.equal((await post("cookie-bridge", local, { cookies, padding: "x".repeat(132_000) })).status, 413);
    assert.equal((await post("cookie-bridge", local, null)).status, 400);
    assert.equal((await post("cookie-bridge", sender, { cookies, port: 1, url: "http://untrusted.invalid" })).status, 200);
    assert.equal((await post("cookie-bridge", sender, { cookies })).status, 403);
    assert.equal(injected.length, 1);
    const actual = injected[0] as Array<{ name: string; domain: string; port?: unknown; url?: unknown }>;
    assert.equal(actual[0].name, "synthetic"); assert.equal(actual[0].domain, ".zhipin.com");
    assert.equal(actual[0].port, undefined); assert.equal(actual[0].url, undefined);
    assert.equal((await post("cookie-bridge", local, { platform: "boss", cookies: "synthetic=local-value" })).status, 200, "manual same-origin import preserved");
    assert.equal(injected.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("browser control rejects untrusted or header-less requests before any browser side effect", async () => {
  const server = createServer((req, res) => { void jdExtractionMiddleware(req, res, () => { res.writeHead(404); res.end(); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(origin + "/api/jd/real-chrome", { method, headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ action: "kill" }) } : {}) });
      assert.equal(response.status, 403);
    }
    const invalid = await fetch(origin + "/api/jd/real-chrome", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-BetterMe-Bridge": "1" }, body: JSON.stringify({ action: "kill", port: "9222; invalid" }) });
    assert.equal(invalid.status, 400);
    for (const body of [{ action: "open-tab" }, { action: "open-tabs", urls: [] }, { action: "open-tab", url: "javascript:alert(1)" }, { action: "open-platform-login", platform: "untrusted" }, { action: "inject-cookies", cookies: [] }]) {
      const response = await fetch(origin + "/api/jd/real-chrome", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-BetterMe-Bridge": "1" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, "invalid actions must not fall through to launching a browser");
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a cookie grant is consumed before an uncertain side effect and never permits concurrent or automatic retries", async () => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const bridge = createLocalBridge({ injectCookies: async () => {
    calls++; entered(); await gate;
    throw new Error("synthetic-sensitive-error-that-must-not-leak");
  } });
  const server = createServer((req, res) => { void bridge(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, headers: Record<string, string>, body: unknown) => fetch(origin + "/api/jd/" + route, { method: "POST", headers, body: JSON.stringify(body) });
  const local = { Origin: origin, "Content-Type": "application/json", "X-BetterMe-Bridge": "1" };
  try {
    for (const sender of ["null", "http://untrusted.invalid", "https://sender.invalid/path", "https://user:pass@sender.invalid"]) {
      assert.equal((await post("bridge-grant", local, { purpose: "job", origin: sender })).status, 400);
    }
    const token = (await (await post("bridge-grant", local, { purpose: "cookies" })).json()).token;
    const headers = { Origin: "https://www.zhipin.com", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const body = { cookies: [{ name: "synthetic", value: "synthetic-value", domain: "zhipin.com" }] };
    const first = post("cookie-bridge", headers, body);
    await started;
    assert.equal((await post("cookie-bridge", headers, body)).status, 403);
    release();
    const failed = await first;
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /synthetic-sensitive|synthetic-value/);
    assert.equal((await post("cookie-bridge", headers, body)).status, 403);
    assert.equal(calls, 1);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
