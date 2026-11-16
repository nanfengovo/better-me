import assert from "node:assert/strict";
import test from "node:test";
import { parseJobServiceArgs } from "../src/cli.ts";
import { LocalJobServiceError, validateJobServiceConfig } from "../src/lifecycle.ts";
import { formatProxyLogLabel, isValidProxySetting, parseMacHttpProxyOutput } from "../src/proxy.ts";

test("parseMacHttpProxyOutput parses macOS scutil HTTP/HTTPS proxy and ExceptionsList", () => {
  const parsed = parseMacHttpProxyOutput(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`);
  assert.deepEqual(parsed, { url: "http://127.0.0.1:7890/", bypass: "127.0.0.1,*.local" });
  assert.equal(parseMacHttpProxyOutput("<dictionary> {\n  HTTPEnable : 0\n}"), undefined);
});

test("CLI and lifecycle proxy configuration accept auto, direct, and valid HTTP(S) proxy URLs", () => {
  assert.equal(isValidProxySetting("auto"), true);
  assert.equal(isValidProxySetting("direct"), true);
  assert.equal(isValidProxySetting("http://127.0.0.1:7890"), true);
  assert.equal(isValidProxySetting("socks5://127.0.0.1:7890"), false);
  assert.equal(formatProxyLogLabel("http://user:secret@127.0.0.1:7890/"), "http://127.0.0.1:7890");

  const parsed = parseJobServiceArgs([
    "--data-dir", "/tmp/betterme-proxy-test",
    "--origin", "http://localhost:5173",
    "--proxy", "auto",
  ]);
  assert.equal(parsed.help, false);
  if (!parsed.help) assert.equal(parsed.config.proxy, "auto");

  assert.throws(
    () => validateJobServiceConfig({ dataDirectory: "/tmp/betterme-proxy-test", allowedOrigins: ["http://localhost:5173"], proxy: "socks5://127.0.0.1:7890" }),
    (error: unknown) => error instanceof LocalJobServiceError && error.code === "invalid-config",
  );
});
