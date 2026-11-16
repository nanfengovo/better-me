import assert from "node:assert/strict";
import test from "node:test";
import { bypassesProxy, parseMacProxyOutput, resolveNetworkRoute } from "../server/network-proxy.ts";

const SCUTIL_CLASH = `<dictionary> {
  ExceptionsList : <array> {
    0 : *zhihu.com,*zhimg.com,localhost,*.local,127.*,10.*,192.168.*
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`;

test("parseMacProxyOutput extracts HTTP/HTTPS/SOCKS servers and multi-line ExceptionsList", () => {
  const parsed = parseMacProxyOutput(SCUTIL_CLASH);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.server, "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7890");
  assert.equal(parsed.override, "*zhihu.com,*zhimg.com,localhost,*.local,127.*,10.*,192.168.*");
  assert.equal(parsed.pac, undefined);
  assert.equal(parsed.source, "macOS 系统代理");
});

test("parseMacProxyOutput handles disabled, SOCKS-only, and PAC macOS configs", () => {
  assert.deepEqual(parseMacProxyOutput("<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  ProxyAutoConfigEnable : 0\n}"), {
    enabled: false,
  });

  const socksOnly = parseMacProxyOutput(`<dictionary> {
  HTTPEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080
}`);
  assert.equal(socksOnly.enabled, true);
  assert.equal(socksOnly.server, "socks=127.0.0.1:1080");

  const pacOnly = parseMacProxyOutput(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:7890/proxy.pac
}`);
  assert.equal(pacOnly.enabled, false);
  assert.equal(pacOnly.pac, true);
  assert.equal(pacOnly.override, "*.local,169.254/16");
});

test("bypassesProxy and resolveNetworkRoute support macOS ExceptionsList wildcards without false suffix matches", () => {
  const system = parseMacProxyOutput(SCUTIL_CLASH);
  const settings = { mode: "auto" as const, proxyUrl: "", bypass: "localhost,127.0.0.1,::1" };

  const overseas = resolveNetworkRoute(settings, new URL("https://boards-api.greenhouse.io/v1/boards/duolingo/jobs"), { env: {}, system });
  assert.equal(overseas.mode, "auto");
  assert.equal(overseas.source, "macOS 系统代理");
  assert.equal(overseas.proxyUrl, "http://127.0.0.1:7890");

  for (const directUrl of [
    "https://www.zhihu.com/question/123",
    "https://zhihu.com/",
    "http://dev.local:3000/",
    "http://127.0.0.2:8080/",
    "http://192.168.1.10/",
  ]) {
    const route = resolveNetworkRoute(settings, new URL(directUrl), { env: {}, system });
    assert.equal(route.proxyUrl, undefined, directUrl);
    assert.equal(route.source, "命中系统绕过代理规则，直接连接");
  }

  assert.equal(bypassesProxy(new URL("https://evilzhihu.com/"), "*zhihu.com"), false);
  assert.equal(bypassesProxy(new URL("https://sub.example.com/"), ".example.com"), true);
});

test("resolveNetworkRoute surfaces clear errors for macOS SOCKS-only and PAC configurations", () => {
  const settings = { mode: "auto" as const, proxyUrl: "", bypass: "" };
  const socks = parseMacProxyOutput("SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : 7890");
  assert.throws(
    () => resolveNetworkRoute(settings, new URL("https://boards-api.greenhouse.io/"), { env: {}, system: socks }),
    /SOCKS/,
  );

  const pac = parseMacProxyOutput("ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://127.0.0.1/pac");
  assert.throws(
    () => resolveNetworkRoute(settings, new URL("https://boards-api.greenhouse.io/"), { env: {}, system: pac }),
    /PAC/,
  );
});
