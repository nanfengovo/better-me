import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createNetworkRuntime, resolveNetworkRoute } from "../server/network-proxy.ts";
import { DEFAULT_NETWORK_SETTINGS } from "../src/lib/network-settings.ts";

const snapshot = { env: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "*" }, system: { enabled: true, server: "127.0.0.1:7890", override: "*" }, warnings: [] };

async function helperConfigurationRules() {
  const source = await readFile(new URL("../../../scripts/domestic-route.ps1", import.meta.url), "utf8");
  const template = source.match(/function Write-Configuration\([\s\S]*?\$text = @"\r?\n([\s\S]*?)\r?\n"@/)?.[1];
  assert.ok(template, "read the actual helper configuration template without executing its engine");
  return template.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

test("独立helper配置仅以精确DOMAIN和DST-PORT443允许BOSS五个验证组件主机", async () => {
  const rules = await helperConfigurationRules();
  const hosts = ["api.geetest.com", "api.geevisit.com", "static.geetest.com", "monitor.geetest.com", "static.geevisit.com"];
  const componentRules = rules.filter((rule) => /gee(?:test|visit)\./i.test(rule));
  assert.deepEqual(componentRules, hosts.map((host) => `AND,((DOMAIN,${host}),(DST-PORT,443)),DIRECT`));
  assert.equal(rules.at(-1), "MATCH,REJECT");
  assert.equal(componentRules.length, 5, "no parent domain, wildcard, other subdomain or port-free component rule");
  for (const host of hosts) {
    const parts = componentRules.find((rule) => rule.includes(`DOMAIN,${host})`))?.match(/^AND,\(\(DOMAIN,([^()]+)\),\(DST-PORT,(\d+)\)\),DIRECT$/);
    assert.ok(parts);
    assert.equal(parts[1], host);
    assert.equal(parts[2], "443");
  }
});

test("独立helper配置仅以精确DOMAIN和DST-PORT443允许51JOB四个已观察的阿里CDN主机", async () => {
  const rules = await helperConfigurationRules();
  const cdnRules = rules.filter((rule) => /alicdn/i.test(rule));
  assert.deepEqual(cdnRules, ["img.alicdn.com", "o.alicdn.com", "g.alicdn.com", "x.alicdn.com"].map((host) => `AND,((DOMAIN,${host}),(DST-PORT,443)),DIRECT`));
  assert.equal(rules.at(-1), "MATCH,REJECT");
  assert.equal(cdnRules.length, 4, "no parent domain, sibling, wildcard, suffix or port-free CDN rule");
});

test("独立helper配置仅以精确DOMAIN和DST-PORT443允许51JOB七个已观察的阿里验证服务主机", async () => {
  const rules = await helperConfigurationRules();
  const hosts = [
    "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com",
    "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com",
    "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com",
    "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com",
    "upload.captcha-pro-open.aliyuncs.com",
    "upload.captcha-pro-open-b.aliyuncs.com",
    "device.captcha-open.aliyuncs.com",
  ];
  const serviceRules = rules.filter((rule) => /aliyuncs|aliyun\.com/i.test(rule));
  const expected = hosts.map((host) => `AND,((DOMAIN,${host}),(DST-PORT,443)),DIRECT`);
  assert.deepEqual(serviceRules, expected, "no parent domain, sibling, wildcard, suffix, error-page host or port-free service rule");
  const cdnEnd = rules.indexOf("AND,((DOMAIN,x.alicdn.com),(DST-PORT,443)),DIRECT");
  assert.ok(cdnEnd >= 0);
  assert.deepEqual(rules.slice(cdnEnd + 1, cdnEnd + 1 + expected.length), expected);
  assert.equal(rules.at(-1), "MATCH,REJECT");
});

test("三平台独立代理优先于常规模式及绕过，域名伪装与其它来源保持原路线", () => {
  for (const mode of ["auto", "direct", "manual"] as const) {
    const settings = { ...DEFAULT_NETWORK_SETTINGS, mode, proxyUrl: "http://127.0.0.1:7890", bypass: "*", domesticProxyUrl: "http://127.0.0.1:17891" };
    for (const domain of ["51job.com", "msearch.51job.com", "ZHIPIN.COM", "m.zhipin.com", "liepin.com", "m.liepin.com"]) {
      assert.deepEqual(resolveNetworkRoute(settings, new URL(`https://${domain}/job`), snapshot), { mode: "manual", source: "国内招聘平台独立代理", proxyUrl: settings.domesticProxyUrl });
    }
    for (const domain of ["fake51job.com", "51job.com.evil.invalid", "zhipin.com.evil.invalid", "liepin.com.evil.invalid", "boards-api.greenhouse.io", "careers.tencent.com"]) {
      assert.equal(resolveNetworkRoute(settings, new URL(`https://${domain}/`), snapshot).proxyUrl, undefined);
    }
  }
  const settings = { ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl: "http://127.0.0.1:17891" };
  const normalContext = { ...snapshot, env: { HTTPS_PROXY: "http://127.0.0.1:7890" }, system: { enabled: false } };
  assert.equal(resolveNetworkRoute(settings, new URL("https://boards-api.greenhouse.io/"), normalContext).proxyUrl, "http://127.0.0.1:7890");
  assert.equal(resolveNetworkRoute({ ...settings, domesticProxyUrl: "" }, new URL("https://m.zhipin.com/"), normalContext).proxyUrl, "http://127.0.0.1:7890");
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("独立路线实际走自己的CONNECT，端口失败不回退到常规代理或直连", async () => {
  const connects: string[] = [];
  const independent = createServer();
  independent.on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    socket.on("error", () => undefined);
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nindependent-path"));
  });
  let fallbackHits = 0;
  const fallback = createServer();
  fallback.on("connect", (_request, socket) => { fallbackHits += 1; socket.destroy(); });
  const domesticProxyUrl = await listen(independent);
  const proxyUrl = await listen(fallback);
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-domestic-route-"));
  const runtime = createNetworkRuntime({ settingsFile: path.join(directory, "settings.json"), readEnv: () => ({}), readSystemProxy: async () => ({ enabled: false }) });
  let independentClosed = false;
  try {
    const request = await runtime.getFetch({ mode: "manual", proxyUrl, bypass: "", domesticProxyUrl });
    assert.equal(await (await request("http://m.zhipin.com/public-job")).text(), "independent-path");
    assert.deepEqual(connects, ["m.zhipin.com:80"]);
    await close(independent); independentClosed = true;
    await assert.rejects(request("http://msearch.51job.com/public-job"), /代理.*失败.*没有回退/);
    assert.equal(fallbackHits, 0);
  } finally {
    await runtime.close();
    if (!independentClosed) await close(independent);
    await close(fallback);
    await rm(directory, { recursive: true, force: true });
  }
});
