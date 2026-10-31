import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";
import { ATLAS_DEV_JOB_INDEX_PATH as CLIENT_PATH, parseDevJobIndexBootstrap, requestDevJobIndex } from "../src/components/atlas/dev-index-bootstrap.ts";
import {
  ATLAS_DEV_JOB_INDEX_ENDPOINT, ATLAS_DEV_JOB_INDEX_PATH, ATLAS_DEV_PAGE_ORIGINS, atlasDevIndexPlugin,
  createDevJobIndexBroker, createDevJobIndexMiddleware, defaultJobAtlasDataDirectory, jobServiceLaunchArgs,
  probeJobServiceOrigin, publicDevIndexError,
} from "../server/atlas-dev-index.ts";

const directory = join(tmpdir(), "better-me-dev-index-synthetic");
const token = "a".repeat(43);
const origins = ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:5193"] as const;
afterEach(() => mock.restoreAll());

test("a dev page missing the index helper explains the one-command startup instead of asking for a token", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<!doctype html><title>BetterMe</title>", { status: 200, headers: { "content-type": "text/html" } }));
  const result = await requestDevJobIndex(new AbortController().signal);
  assert.deepEqual(result, { ok: false, error: "本机岗位自动连接尚未就绪。请先保存当前编辑，再启动或重启 pnpm dev；独立验收入口使用 pnpm dev:isolated。无需手填访问令牌。" });
});

test("development bootstrap stays on the fixed loopback index and outside the repository", () => {
  const syntheticHome = join(tmpdir(), "betterme-synthetic-home");
  const dataDirectory = join(syntheticHome, "Library", "Application Support", "BetterMe", "job-atlas");
  assert.equal(CLIENT_PATH, ATLAS_DEV_JOB_INDEX_PATH);
  assert.equal(defaultJobAtlasDataDirectory(syntheticHome), dataDirectory);
  assert.equal(dataDirectory.includes(`${join("简历", "简历Agent")}`), false);
  assert.deepEqual(jobServiceLaunchArgs({
    dataDirectory: defaultJobAtlasDataDirectory(syntheticHome), port: "5178", origins,
    cliPath: "/opt/job-service/src/cli.ts", tsxLoader: "/opt/tsx/dist/loader.mjs",
  }), [
    "--import", "/opt/tsx/dist/loader.mjs", "/opt/job-service/src/cli.ts",
    "--data-dir", dataDirectory,
    "--host", "127.0.0.1", "--port", "5178",
    "--origin", "http://127.0.0.1:5173", "--origin", "http://localhost:5173",
    "--origin", "http://127.0.0.1:5193",
  ]);
  const plugin = atlasDevIndexPlugin();
  assert.equal(plugin.apply, "serve");
  assert.equal(plugin.configurePreviewServer, undefined);
  assert.equal(typeof plugin.configureServer, "function");
});

test("Vite dev starts the local job service eagerly and stops its owned process with the server", async () => {
  let ensureCalls = 0;
  let closeCalls = 0;
  const plugin = atlasDevIndexPlugin({
    createBroker: () => ({
      ensure: async () => { ensureCalls += 1; return { endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token }; },
      close: async () => { closeCalls += 1; },
    }),
  });
  const httpServer = new EventEmitter();
  const server = {
    middlewares: { use: () => {} },
    httpServer,
  };
  const configureServer = plugin.configureServer as ((server: unknown) => (() => void) | void) | undefined;
  assert.ok(configureServer);
  const cleanup = configureServer(server);
  assert.equal(typeof cleanup, "function");
  cleanup?.();
  await nextTurn();
  assert.equal(ensureCalls, 1, "the service should start with Vite, not only after opening the Atlas page");
  httpServer.emit("close");
  await nextTurn();
  assert.equal(closeCalls, 1, "Vite shutdown should release only the service managed by its broker");
});

test("index watcher keeps checking and stops checks on Vite close", async () => {
  let checks = 0, stops = 0;
  const httpServer = new EventEmitter();
  const plugin = atlasDevIndexPlugin({ healthIntervalMs: 5, createBroker: () => ({
    ensure: async () => { checks++; return { endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token }; },
    close: async () => { stops++; },
  }) });
  const cleanup = (plugin.configureServer as (server: unknown) => () => void)({ middlewares: { use: () => {} }, httpServer });
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.ok(checks >= 2);
  httpServer.emit("close");
  const atClose = checks;
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.equal(checks, atClose);
  assert.equal(stops, 1);
});

test("an already reachable service is reused for both page origins without spawning", async () => {
  const seen: string[] = [];
  let started = false;
  const broker = createDevJobIndexBroker({
    dataDirectory: directory,
    readToken: async () => token,
    probe: async (_endpoint, supplied, origin) => { assert.equal(supplied, token); seen.push(origin); return "ready"; },
    start: () => { started = true; throw new Error("already running"); },
  });
  assert.deepEqual(await broker.ensure(), { endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token });
  assert.deepEqual(seen, [...origins]);
  assert.equal(started, false);
});

test("closing during token lookup prevents a late job-service launch", async () => {
  let releaseToken!: (value: string | undefined) => void;
  let tokenLookupStarted!: () => void;
  const started = new Promise<void>((resolve) => { tokenLookupStarted = resolve; });
  let starts = 0;
  const broker = createDevJobIndexBroker({
    dataDirectory: directory,
    readToken: () => new Promise((resolve) => { releaseToken = resolve; tokenLookupStarted(); }),
    probe: async () => "down",
    start: () => { starts += 1; throw new Error("must not start after close"); },
  });
  const ensure = broker.ensure();
  await started;
  const close = broker.close();
  releaseToken(undefined);
  await assert.rejects(ensure, /Vite 开发服务已关闭/);
  await close;
  assert.equal(starts, 0);
});

test("a stopped index is started once with both origins, and a refused origin or token is not replaced", async () => {
  let current: string | undefined;
  let starts = 0;
  const broker = createDevJobIndexBroker({
    dataDirectory: directory, timeoutMs: 1_000, sleep: async () => {},
    readToken: async () => current,
    probe: async () => current ? "ready" : "down",
    start: async (spec) => {
      starts += 1;
      assert.deepEqual(spec.origins, [...ATLAS_DEV_PAGE_ORIGINS]);
      assert.equal(spec.endpoint, ATLAS_DEV_JOB_INDEX_ENDPOINT);
      assert.equal(spec.dataDirectory, directory);
      current = token;
      return { exited: () => false, exitError: () => undefined, stop: async () => {} };
    },
  });
  const pending = [broker.ensure(), broker.ensure()];
  const [first, second] = await Promise.all(pending);
  assert.equal(starts, 1);
  assert.equal(first.token, token);
  assert.equal(second.token, token);

  const rejected = createDevJobIndexBroker({
    dataDirectory: directory,
    readToken: async () => token,
    probe: async (_endpoint, _token, origin) => origin === origins[1] ? "origin-rejected" : "ready",
    start: () => { throw new Error("must not replace a running service"); },
  });
  await assert.rejects(rejected.ensure(), /http:\/\/127\.0\.0\.1:5173 和 http:\/\/localhost:5173/);

  const unauthorized = createDevJobIndexBroker({
    dataDirectory: directory,
    readToken: async () => token,
    probe: async () => "unauthorized",
    start: () => { throw new Error("must not invent another token"); },
  });
  await assert.rejects(unauthorized.ensure(), /不会改用其他令牌/);
});

test("startup failure is returned without the token and stops the process that was just launched", async () => {
  let stopped = false;
  const broker = createDevJobIndexBroker({
    dataDirectory: directory,
    readToken: async () => undefined,
    probe: async () => "down",
    start: async () => ({ exited: () => true, exitError: () => `listen EADDRINUSE ${token}`, stop: async () => { stopped = true; } }),
  });
  await assert.rejects(broker.ensure(), /EADDRINUSE/);
  assert.equal(stopped, true);
  assert.equal(publicDevIndexError(new Error(`listen failed ${token}`)).includes(token), false);
  assert.match(publicDevIndexError(new Error(`listen failed ${token}`)), /\[redacted\]/);
});

test("index broker recovers an owned unresponsive child without replacing an unknown instance", async () => {
  let status: "ready" | "down" = "down", starts = 0, stops = 0, exited = false;
  const broker = createDevJobIndexBroker({ dataDirectory: directory, readToken: async () => token,
    probe: async () => status, start: () => {
      starts++; status = "ready"; exited = false;
      return { exited: () => exited, exitError: () => "exit", stop: async () => { stops++; exited = true; status = "down"; } };
    },
  });
  await broker.ensure();
  status = "down";
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(stops, 0, "a single failed health check should not interrupt a busy snapshot");
  status = "ready";
  await broker.ensure();
  status = "down";
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(stops, 0);
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(starts, 1);
  await broker.ensure();
  assert.equal(starts, 2);
  await broker.close();
  assert.equal(stops, 2);
});

test("the dev route gives the token only to a loopback page and surfaces a real startup error", async () => {
  const secret = "b".repeat(43);
  let reads = 0;
  const middleware = createDevJobIndexMiddleware({
    async ensure() { reads += 1; return { endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token: secret }; },
  });
  const denied = await invoke(middleware, "203.0.113.8");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.includes(secret), false);
  assert.equal(reads, 0);

  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end("missing"); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const other = await fetch(`http://127.0.0.1:${port}/other`);
    assert.equal(other.status, 404);
    const ok = await fetch(`http://127.0.0.1:${port}${ATLAS_DEV_JOB_INDEX_PATH}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(parseDevJobIndexBootstrap(await ok.json()), { ok: true, endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token: secret });
  } finally { await new Promise((resolve) => server.close(() => resolve(undefined))); }

  const failing = createDevJobIndexMiddleware({ async ensure() { throw new Error(`refused ${secret}`); } });
  const failure = await invoke(failing, "127.0.0.1");
  assert.equal(failure.status, 503);
  assert.equal(failure.body.includes(secret), false);
  assert.match(failure.body, /\[redacted\]/);
  assert.equal(parseDevJobIndexBootstrap(JSON.parse(failure.body))?.ok, false);
});

test("public or unrelated payloads are not treated as a development connection", () => {
  assert.equal(parseDevJobIndexBootstrap({ endpoint: "https://jobs.example.invalid", token }), undefined);
  assert.equal(parseDevJobIndexBootstrap({ endpoint: ATLAS_DEV_JOB_INDEX_ENDPOINT, token, extra: true }), undefined);
  assert.equal(parseDevJobIndexBootstrap("<!doctype html>"), undefined);
  assert.deepEqual(parseDevJobIndexBootstrap({ error: "端口 5178 被占用。" }), { ok: false, error: "端口 5178 被占用。" });
});

function invoke(middleware: ReturnType<typeof createDevJobIndexMiddleware>, remoteAddress: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = { method: "GET", url: ATLAS_DEV_JOB_INDEX_PATH, headers: { host: "127.0.0.1:5173" }, socket: { remoteAddress }, destroyed: false } as IncomingMessage;
    const response = {
      destroyed: false, writableEnded: false, statusCode: 0,
      writeHead(status: number) { this.statusCode = status; },
      end(body?: string) { this.writableEnded = true; resolve({ status: this.statusCode, body: body ?? "" }); },
    };
    try { middleware(request, response as unknown as ServerResponse, () => reject(new Error("next"))); }
    catch (error) { reject(error); }
  });
}
