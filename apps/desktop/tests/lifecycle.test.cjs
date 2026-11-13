/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS VM harness mirrors the compiled Electron entry. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

// Compile the real entry and both managers in memory: no Electron binary, dist
// directory, default user profile, ports, model provider or child process needed.
const source = buildSync({
  entryPoints: [path.resolve(__dirname, "../src/main/index.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["electron"], write: false,
}).outputFiles[0].text;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function desktop({ externalHost = false, packaged = false, foreignWeb = false } = {}) {
  const app = new EventEmitter(), nativeTheme = new EventEmitter();
  const live = new Set(), created = [], handles = [], health = [], starts = [], stops = [], errors = [];
  const services = new Set(externalHost ? ["host"] : []);
  let quits = 0;
  Object.assign(app, { getAppPath: () => "/fixture/desktop", getName: () => "better-me-desktop", isPackaged: packaged,
    whenReady: async () => undefined, quit: () => { quits++; } });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); live.add(this); created.push(this);
      this.messages = [];
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send: (...args) => this.messages.push(args), session: { setPermissionRequestHandler() {} } });
    }
    static getAllWindows() { return Array.from(live); }
    async loadURL(url) { this.url = url; }
    async loadFile(file) { this.file = file; }
    close() {
      live.delete(this); this.emit("closed");
      if (!live.size) app.emit("window-all-closed");
    }
  }
  const electron = { app, nativeTheme, BrowserWindow, shell: {}, dialog: { showErrorBox: (...args) => errors.push(args) }, Menu: {
    buildFromTemplate: (items) => items, setApplicationMenu() {},
  }, ipcMain: { handle(channel) { handles.push(channel); } } };
  const modules = {
    electron, "node:path": path.posix, "node:os": { tmpdir: () => "/fixture/tmp" },
    "node:fs": { existsSync: (file) => ["/src/cli.ts", "/tsx/dist/loader.mjs", "/package.json", "/.bin/vite"].some((suffix) => file.endsWith(suffix)) },
    "node:child_process": { spawn(command, args) {
      const service = args.some((s) => s.endsWith("/src/cli.ts")) ? "host" : command.endsWith("/vite") ? "web" : undefined;
      assert.ok(service, "only the fixture host and Vite may start");
      starts.push(service); services.add(service);
      return Object.assign(new EventEmitter(), { kill() { stops.push(service); services.delete(service); } });
    } },
  };
  vm.runInNewContext(source, {
    __dirname: "/fixture/desktop/dist/main", require: (id) => {
      assert.ok(Object.hasOwn(modules, id), "unexpected module: " + id); return modules[id];
    }, process: { platform: "darwin", cwd: () => "/fixture", env: { VITE_DEV_SERVER_URL: "https://untrusted.fixture.invalid/" }, execPath: "/fixture/electron",
      versions: { node: "26.0.0", electron: "fixture" }, getBuiltinModule: id => id === "node:sqlite" ? { DatabaseSync: class {} } : undefined },
    console: { log() {}, warn() {}, error() {} }, AbortSignal, URL, TextDecoder, setTimeout,
    fetch: async (url, options = {}) => {
      const service = url === "http://127.0.0.1:5179/api/v1/agent/health" ? "host"
        : url === "http://127.0.0.1:5173" ? "web" : undefined;
      health.push({ service, method: options.method ?? "GET" });
      if (service === "web" && foreignWeb) return new Response("<title>Unrelated dev server</title>", { headers: { "Content-Type": "text/html" } });
      if (!services.has(service)) throw Error("fixture port has no listener");
      return new Response(service === "host" ? "{}" : '<html><head><title>迈向更好 · BetterMe</title></head><body><div id="root"></div><script type="module"></script></body></html>', { headers: { "Content-Type": service === "web" ? "text/html" : "application/json" } });
    },
  });
  await settle();
  if (!foreignWeb) assert.equal(created.length, 1, "starting the desktop creates its initial window");
  return { app, nativeTheme, live, created, handles, health, starts, stops, services, errors,
    quits: () => quits, assertNoDispatch() {
      assert.ok(health.every(({ service, method }) => service && method === "GET"),
        "desktop lifecycle may probe readiness, never dispatch or resume a task");
    } };
}

test("closing the last macOS window keeps the embedded host and its background work alive", async () => {
  const d = await desktop();
  d.created[0].close();
  assert.equal(d.live.size, 0);
  assert.equal(d.quits(), 0);
  assert.deepEqual(d.stops, []);
  assert.equal(d.services.has("host"), true);
  d.assertNoDispatch();
});

test("macOS activation races create one replacement window and do not duplicate IPC or theme observers", async () => {
  const d = await desktop();
  const initialHandles = [...d.handles].sort();
  assert.ok(initialHandles.includes("desktop:get-agent-info"));
  d.created[0].close();
  d.app.emit("activate"); d.app.emit("activate");
  await settle();
  d.app.emit("activate"); await settle();
  assert.equal(d.created.length, 2);
  assert.equal(d.live.size, 1);
  assert.deepEqual([...d.handles].sort(), initialHandles);
  assert.equal(d.nativeTheme.listenerCount("updated"), 1);
  d.nativeTheme.shouldUseDarkColors = true;
  d.nativeTheme.emit("updated");
  assert.deepEqual(d.created[0].messages, []);
  assert.deepEqual(d.created[1].messages, [["desktop:theme-changed", "dark"]]);
  assert.deepEqual(d.starts, ["host", "web"]);
  d.assertNoDispatch();
});

test("before-quit stops owned services without restarting tasks or terminating an independently running host", async () => {
  for (const externalHost of [false, true]) {
    const d = await desktop({ externalHost });
    const priorStarts = [...d.starts], priorRequests = d.health.length;
    d.app.emit("before-quit"); await settle();
    assert.deepEqual(d.stops, externalHost ? ["web"] : ["host", "web"]);
    assert.equal(d.services.has("host"), externalHost);
    assert.deepEqual(d.starts, priorStarts);
    assert.equal(d.health.length, priorRequests);
    d.assertNoDispatch();
  }
});

test("the packaged renderer loads its known loopback web origin even if a remote dev URL is configured", async () => {
  const d = await desktop({ packaged: true });
  assert.equal(d.created[0].url, "http://127.0.0.1:5173/?workspace=autopilot");
  assert.equal(d.created[0].file, undefined, "file:// would resolve Vite's /assets outside of the bundle");
  let blocked = false;
  d.created[0].webContents.emit("will-redirect", { preventDefault: () => { blocked = true; } }, "https://untrusted.fixture.invalid/");
  assert.equal(blocked, true, "the trusted window cannot redirect its desktop bridge to a different origin");
  d.assertNoDispatch();
});

test("a different service occupying the local web port is never opened or replaced", async () => {
  const d = await desktop({ packaged: true, foreignWeb: true, externalHost: true });
  assert.equal(d.created.length, 0);
  assert.deepEqual(d.starts, []);
  assert.equal(d.errors.length, 1, "explain the unavailable workspace with no renderer or file fallback");
  d.assertNoDispatch();
});

test("distributable packages always dispatch to the bundled runtime, never developer managers", () => {
  const compiled = buildSync({
    entryPoints: [path.resolve(__dirname, "../src/main/index.ts")], bundle: true,
    platform: "node", format: "cjs", target: "node22", write: false,
    external: ["electron", "./agent-host-manager.js", "./web-server-manager.js", "./window.js", "./hud-window.js", "./isolated-qa-config.js", "./packaged.js"],
  }).outputFiles[0].text;
  for (const name of ["@better-me/desktop", "BetterMe", undefined]) {
    let bundledStarts = 0;
    const unexpected = () => { throw Error("a distributable must not start a developer service or QA path"); };
    const modules = {
      electron: { app: { isPackaged: true, getName: () => name } }, "node:path": path,
      "./packaged.js": { startPackagedApp: () => { bundledStarts++; } },
      "./agent-host-manager.js": { AgentHostManager: unexpected },
      "./web-server-manager.js": { WebServerManager: unexpected },
      "./window.js": {}, "./hud-window.js": {},
      "./isolated-qa-config.js": { resolveDesktopQaConfig: unexpected },
    };
    vm.runInNewContext(compiled, { require: id => { assert.ok(Object.hasOwn(modules, id), id); return modules[id]; } });
    assert.equal(bundledStarts, 1);
  }
});
