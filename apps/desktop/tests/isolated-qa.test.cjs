/* eslint-disable @typescript-eslint/no-require-imports -- Native CommonJS VM harness must match Electron's compiled entry. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

function moduleUnderTest(relative, overrides = {}) {
  const source = buildSync({ entryPoints: [path.resolve(__dirname, relative)], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: id => Object.hasOwn(overrides, id) ? overrides[id] : require(id), URL, process, fetch, AbortSignal, TextDecoder, console, setTimeout });
  return module.exports;
}

test("desktop QA is opt-in and the ordinary launch has no isolation overrides", () => {
  const { resolveDesktopQaConfig } = moduleUnderTest("../src/main/isolated-qa-config.ts");
  assert.equal(resolveDesktopQaConfig({ environment: {}, isPackaged: false }), undefined);
  assert.equal(resolveDesktopQaConfig({ environment: { NODE_ENV: "test", VITE_DEV_SERVER_URL: "http://127.0.0.1:5273" }, isPackaged: false }), undefined);
  assert.equal(resolveDesktopQaConfig({ environment: {}, isPackaged: true }), undefined);
});

test("desktop QA managers reuse only their actual loopback fixtures and cannot spawn, stop, redirect or fall back to the real services", async () => {
  let starts = 0, hostHealthy = true, webMode = "ready";
  const startsForbidden = { "node:child_process": { spawn() { starts++; throw Error("no child process is allowed in external QA"); } }, electron: { app: { getAppPath() { throw Error("external QA must not discover source trees"); } } } };
  const { AgentHostManager } = moduleUnderTest("../src/main/agent-host-manager.ts", startsForbidden);
  const { WebServerManager } = moduleUnderTest("../src/main/web-server-manager.ts", startsForbidden);
  const requests = [];
  const host = http.createServer((req, res) => { requests.push({ service: "host", path: req.url, authorization: req.headers.authorization }); res.writeHead(hostHealthy ? 200 : 503); res.end("{}"); });
  const web = http.createServer((_req, res) => { requests.push({ service: "web" });
    if (webMode === "redirect") { res.writeHead(302, { Location: "http://127.0.0.1:5173" }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end(webMode === "foreign" ? "<html>Foreign app</html>" : '<html><head><title>迈向更好 · BetterMe</title></head><body><div id="root"></div><script type="module"></script></body></html>');
  });
  try {
    await Promise.all([new Promise(resolve => host.listen(0, "127.0.0.1", resolve)), new Promise(resolve => web.listen(0, "127.0.0.1", resolve))]);
    const hostPort = host.address().port, webPort = web.address().port;
    const hostManager = new AgentHostManager({ externalOnly: true, endpoint: `http://127.0.0.1:${hostPort}`, port: hostPort, token: "synthetic-qa-token-canary" });
    const webManager = new WebServerManager({ externalOnly: true, endpoint: `http://127.0.0.1:${webPort}`, port: webPort });
    assert.equal(hostManager.getConfig().port, hostPort); assert.equal(webManager.getEndpoint(), `http://127.0.0.1:${webPort}`);
    await hostManager.ensureStarted(); await webManager.ensureStarted();
    hostManager.stop(); webManager.stop();
    await hostManager.ensureStarted(); await webManager.ensureStarted();
    hostHealthy = false;
    await assert.rejects(hostManager.ensureStarted(), /desktop_qa_external_host_unavailable/);
    for (const mode of ["foreign", "redirect"]) { webMode = mode; await assert.rejects(webManager.ensureStarted()); }
    assert.equal(starts, 0);
    assert.ok(requests.every(item => item.service !== "host" || item.path === "/api/v1/agent/health" && item.authorization === "Bearer synthetic-qa-token-canary"));
    assert.throws(() => new AgentHostManager({ externalOnly: true, endpoint: "http://remote.invalid:5279", port: 5279, token: "synthetic-qa-token-canary" }), /desktop_qa_configuration_invalid/);
    assert.throws(() => new WebServerManager({ externalOnly: false, endpoint: `http://127.0.0.1:${webPort}`, port: webPort }), /desktop_qa_configuration_invalid/);
  } finally { host.closeAllConnections(); web.closeAllConnections(); await Promise.all([new Promise(resolve => host.close(resolve)), new Promise(resolve => web.close(resolve))]); }
});

const qaEnvironment = () => ({ NODE_ENV: "test", BETTERME_DESKTOP_QA_MODE: "external-reuse-only",
  BETTERME_DESKTOP_QA_HOST_URL: "http://127.0.0.1:5279", BETTERME_DESKTOP_QA_WEB_URL: "http://127.0.0.1:5273",
  BETTERME_DESKTOP_QA_TOKEN: "synthetic-qa-token-canary", BETTERME_DESKTOP_QA_PROFILE_ROOT: path.resolve(os.tmpdir(), "betterme-desktop-qa-ABC123") });

test("desktop QA accepts only an explicit unpackaged test process with numeric loopback non-production ports", () => {
  const { resolveDesktopQaConfig } = moduleUnderTest("../src/main/isolated-qa-config.ts");
  const config = resolveDesktopQaConfig({ environment: qaEnvironment(), isPackaged: false });
  assert.equal(config.workspaceUrl, "http://127.0.0.1:5273/?workspace=autopilot");
  assert.equal(config.host.endpoint, "http://127.0.0.1:5279");
  assert.equal(config.host.port, 5279);
  assert.equal(config.externalOnly, true);
  for (const patch of [{ NODE_ENV: "development" }, { BETTERME_DESKTOP_QA_MODE: "1" },
    { BETTERME_DESKTOP_QA_HOST_URL: "https://remote.invalid:5279" }, { BETTERME_DESKTOP_QA_HOST_URL: "http://localhost:5279" },
    { BETTERME_DESKTOP_QA_HOST_URL: "http://127.0.0.1:5179" }, { BETTERME_DESKTOP_QA_WEB_URL: "http://127.0.0.1:5173" },
    { BETTERME_DESKTOP_QA_HOST_URL: "http://user:secret@127.0.0.1:5279" }, { BETTERME_DESKTOP_QA_WEB_URL: "http://127.0.0.1:5273/path?query=1" },
    { BETTERME_DESKTOP_QA_HOST_URL: "http://127.0.0.1:5273" }, { BETTERME_DESKTOP_QA_TOKEN: "" },
    { BETTERME_DESKTOP_QA_PROFILE_ROOT: "relative/profile" }, { BETTERME_DESKTOP_QA_UNKNOWN: "mistyped" }]) {
    assert.throws(() => resolveDesktopQaConfig({ environment: { ...qaEnvironment(), ...patch }, isPackaged: false }), /desktop_qa_configuration_invalid/);
  }
  assert.throws(() => resolveDesktopQaConfig({ environment: qaEnvironment(), isPackaged: true }), /desktop_qa_configuration_invalid/);
});

test("desktop QA reserves only a new private canonical temp profile and never adopts an existing account directory", { skip: process.platform === "win32" && "Windows QA profile ACL review is explicitly unavailable" }, () => {
  const { resolveDesktopQaConfig, prepareDesktopQaProfile } = moduleUnderTest("../src/main/isolated-qa-config.ts");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, "betterme-desktop-qa-"));
  const config = resolveDesktopQaConfig({ environment: { ...qaEnvironment(), BETTERME_DESKTOP_QA_PROFILE_ROOT: root }, isPackaged: false });
  try {
    const paths = prepareDesktopQaProfile(config, temporaryRoot);
    assert.equal(paths.userData, path.join(root, "userData"));
    assert.equal(paths.sessionData, path.join(root, "sessionData"));
    for (const location of Object.values(paths)) assert.equal(fs.statSync(location).mode & 0o077, 0);
    assert.throws(() => prepareDesktopQaProfile(config, temporaryRoot), /desktop_qa_profile_not_fresh_private_temp/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const occupied = fs.mkdtempSync(path.join(temporaryRoot, "betterme-desktop-qa-"));
  try {
    fs.writeFileSync(path.join(occupied, "account-canary"), "synthetic");
    const input = { ...config, profileRoot: occupied };
    assert.throws(() => prepareDesktopQaProfile(input, temporaryRoot), /desktop_qa_profile_not_fresh_private_temp/);
    assert.equal(fs.readFileSync(path.join(occupied, "account-canary"), "utf8"), "synthetic");
    fs.unlinkSync(path.join(occupied, "account-canary")); fs.chmodSync(occupied, 0o755);
    assert.throws(() => prepareDesktopQaProfile(input, temporaryRoot), /desktop_qa_profile_not_fresh_private_temp/);
    fs.chmodSync(occupied, 0o700);
    assert.throws(() => prepareDesktopQaProfile(input, path.join(temporaryRoot, "other")), /desktop_qa_profile_not_fresh_private_temp/);
  } finally { fs.rmSync(occupied, { recursive: true, force: true }); }
});

test("the real desktop bootstrap sets every private profile path before readiness and never uses real ports or a remote dev URL", { skip: process.platform === "win32" && "Windows QA profile ACL review is explicitly unavailable" }, async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temporaryRoot, "betterme-desktop-qa-"));
  const source = buildSync({ entryPoints: [path.resolve(__dirname, "../src/main/index.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], write: false }).outputFiles[0].text;
  const app = new EventEmitter(), nativeTheme = new EventEmitter(), profilePaths = new Map(), windows = [], errors = [], requests = [], handlers = new Map();
  let starts = 0, readyObserved = false;
  Object.assign(app, { isPackaged: false, getPath: name => { assert.equal(name, "temp"); return temporaryRoot; },
    setPath: (name, location) => { assert.equal(readyObserved, false); assert.ok(location.startsWith(root + path.sep)); profilePaths.set(name, location); },
    whenReady: async () => { readyObserved = true; assert.equal(profilePaths.size, 4, "profile boundaries must precede Electron readiness"); }, quit() {} });
  class BrowserWindow extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {}, session: { setPermissionRequestHandler() {} } }); }
    static getAllWindows() { return windows; }
    async loadURL(url) { this.url = url; }
  }
  const electron = { app, nativeTheme, BrowserWindow, shell: {}, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, dialog: { showErrorBox: (...value) => errors.push(value) } };
  const forbiddenSpawn = { spawn() { starts++; throw Error("external-only must never spawn a service"); } };
  try {
    vm.runInNewContext(source, { __dirname: "/synthetic/desktop/dist/main", require: id => id === "electron" ? electron : id === "node:child_process" ? forbiddenSpawn : require(id),
      process: { env: { ...qaEnvironment(), BETTERME_DESKTOP_QA_PROFILE_ROOT: root, VITE_DEV_SERVER_URL: "https://remote.invalid/" }, platform: process.platform, getuid: process.getuid },
      console: { log() {}, warn() {}, error() {} }, URL, AbortSignal, TextDecoder, setTimeout,
      fetch: async (url) => { requests.push(url); if (url === "http://127.0.0.1:5279/api/v1/agent/health") return new Response("{}");
        assert.equal(url, "http://127.0.0.1:5273"); return new Response('<html><head><title>迈向更好 · BetterMe</title></head><body><div id="root"></div><script type="module"></script></body></html>', { headers: { "Content-Type": "text/html" } }); },
    });
    for (let i = 0; i < 10 && windows.length === 0 && errors.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []); assert.equal(windows.length, 1);
    assert.equal(windows[0].url, "http://127.0.0.1:5273/?workspace=autopilot");
    assert.equal((await handlers.get("desktop:get-agent-info")()).port, 5279);
    let blocked = false; windows[0].webContents.emit("will-navigate", { preventDefault: () => { blocked = true; } }, "http://127.0.0.1:5173/"); assert.equal(blocked, true);
    app.emit("before-quit"); assert.equal(starts, 0);
    assert.ok(requests.every(url => url.startsWith("http://127.0.0.1:527")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
