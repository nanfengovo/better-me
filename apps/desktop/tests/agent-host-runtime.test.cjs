/* eslint-disable @typescript-eslint/no-require-imports -- Electron's compiled entry uses CommonJS. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { buildSync } = require("esbuild");

const bundle = buildSync({ entryPoints: [path.resolve(__dirname, "../src/main/agent-host-manager.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node20", external: ["electron"], write: false }).outputFiles[0].text;
const nodePath = "/opt/homebrew/Cellar/node/26.7.0/bin/node";
const installedCli = "/fixture/better-me-agent-os/apps/agent-host/src/cli.ts";

function fixture({ version = "20.18.2", sqlite = false, platform = "darwin", target = nodePath, alterStat,
  probeResult = "26.7.0", healthy = false, cli = installedCli } = {}) {
  const probes = [], starts = [], consulted = [], module = { exports: {} };
  const processDouble = { platform, versions: { node: version, electron: "fixture" }, execPath: "/bundle/Electron",
    cwd: () => "/unknown/path", getuid: () => 501, getBuiltinModule: id => sqlite && id === "node:sqlite" ? { DatabaseSync: class {} } : undefined,
    env: { PATH: "/unknown/path", NODE_OPTIONS: "--require=/untrusted/preload", Node_Path: "/untrusted/modules",
      DYLD_INSERT_LIBRARIES: "injected", LD_PRELOAD: "injected", ELECTRON_RUN_AS_NODE: "inherited", ESBUILD_BINARY_PATH: "injected", BETTERME_FIXTURE: "preserve" } };
  const fs = { existsSync: name => name === cli || name.endsWith("/tsx/dist/loader.mjs"),
    realpathSync(name) { consulted.push(name); if (name === "/opt/homebrew/bin/node") return target; throw Error("not installed"); },
    statSync(name) { const file = name === target;
      return { uid: 501, gid: 80, mode: file ? 0o555 : 0o775, isFile: () => file, isDirectory: () => !file, ...alterStat?.(name) }; } };
  const child = { spawnSync(cmd, args, opts) { probes.push({ cmd, args, opts }); return { status: 0, stdout: probeResult }; },
    spawn(cmd, args, opts) { starts.push({ cmd, args, opts }); healthy = true; return new EventEmitter(); } };
  const requireDouble = id => id === "electron" ? { app: { isPackaged: true, getAppPath: () => "/fixture/BetterMe.app/Contents/Resources/app" } }
    // The fixture models a macOS installation even when the runner is Windows.
    : id === "node:path" ? path.posix : id === "node:child_process" ? child : id === "node:fs" ? fs : require(id);
  vm.runInNewContext(bundle, { __dirname: "/fixture/BetterMe.app/Contents/Resources/app/dist/main", module, exports: module.exports,
    require: requireDouble, process: processDouble, fetch: async () => ({ ok: healthy }), AbortSignal, URL, setTimeout,
    console: { log() {}, error() {}, warn() {} } });
  return { manager: new module.exports.AgentHostManager(), probes, starts, consulted };
}

test("Electron 34 cold-start selects only the checked Homebrew installation and strips ambient preload hooks", async () => {
  const f = fixture(); await f.manager.ensureStarted();
  assert.equal(f.probes.length, 1); assert.equal(f.probes[0].cmd, nodePath);
  assert.ok(f.probes[0].args.some(arg => arg.includes("node:sqlite"))); assert.ok(f.probes[0].opts.timeout > 0);
  assert.deepEqual(Object.keys(f.probes[0].opts.env), []);
  assert.equal(f.starts.length, 1); const start = f.starts[0]; assert.equal(start.cmd, nodePath); assert.ok(start.args.includes(installedCli));
  for (const key of ["NODE_OPTIONS", "Node_Path", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "ESBUILD_BINARY_PATH"]) assert.equal(start.opts.env[key], undefined);
  assert.equal(start.opts.env.BETTERME_FIXTURE, "preserve"); assert.equal(start.opts.env.NODE_ENV, "production");
});

test("a compatible bundled runtime with SQLite wins; attaching a healthy service requires no binary at all", async () => {
  const current = fixture({ version: "24.15.0", sqlite: true });
  await current.manager.ensureStarted(); assert.equal(current.starts[0].cmd, "/bundle/Electron");
  assert.equal(current.starts[0].opts.env.ELECTRON_RUN_AS_NODE, "1"); assert.equal(current.consulted.length, 0);
  const reuse = fixture({ platform: "win32", healthy: true }); await reuse.manager.ensureStarted();
  assert.equal(reuse.starts.length, 0); assert.equal(reuse.consulted.length, 0);
});

test("no PATH, unsupported Node, redirected installation, untrusted owner or writable path can launch the Host", async () => {
  for (const config of [
    { platform: "win32" }, { platform: "linux" }, { target: "/unknown/path/node" },
    { probeResult: "24.14.9" }, { probeResult: "25.0.0" }, { probeResult: "diagnostic output" },
    { alterStat: name => name === nodePath ? { uid: 777 } : {} },
    { alterStat: name => name === "/opt/homebrew/Cellar" ? { mode: 0o777 } : {} },
    { alterStat: name => name === "/opt/homebrew/Cellar" ? { mode: 0o775, gid: 20 } : {} },
  ]) {
    const f = fixture(config); await assert.rejects(f.manager.ensureStarted(), /desktop_agent_host_runtime_unavailable/);
    assert.equal(f.starts.length, 0); assert.ok(!f.consulted.includes("/unknown/path/node"));
    if (config.target || config.alterStat || config.platform) assert.equal(f.probes.length, 0);
  }
});

test("a cli discovered only through an unrelated launch directory never runs", async () => {
  const f = fixture({ cli: "/unknown/path/apps/agent-host/src/cli.ts" });
  await assert.rejects(f.manager.ensureStarted(), /desktop_agent_host_source_unavailable/);
  assert.equal(f.starts.length, 0); assert.equal(f.probes.length, 0);
});
