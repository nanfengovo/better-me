import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATLAS_DEV_JOB_INDEX_PATH as CLIENT_PATH, parseDevJobIndexBootstrap } from "../src/components/atlas/dev-index-bootstrap.ts";
import {
  ATLAS_DEV_JOB_INDEX_ENDPOINT, ATLAS_DEV_JOB_INDEX_PATH, ATLAS_DEV_PAGE_ORIGINS, atlasDevIndexPlugin,
  createDevJobIndexBroker, createDevJobIndexMiddleware, defaultJobAtlasDataDirectory, jobServiceLaunchArgs,
  probeJobServiceOrigin, publicDevIndexError,
} from "../server/atlas-dev-index.ts";

const directory = join(tmpdir(), "better-me-dev-index-synthetic");
const token = "a".repeat(43);
const origins = ["http://127.0.0.1:5173", "http://localhost:5173"] as const;

test("development bootstrap stays on the fixed loopback index and outside the repository", () => {
  assert.equal(CLIENT_PATH, ATLAS_DEV_JOB_INDEX_PATH);
  assert.equal(defaultJobAtlasDataDirectory("/Users/example"), "/Users/example/Library/Application Support/BetterMe/job-atlas");
  assert.equal(defaultJobAtlasDataDirectory("/Users/example").includes(`${join("简历", "简历Agent")}`), false);
  assert.deepEqual(jobServiceLaunchArgs({
    dataDirectory: defaultJobAtlasDataDirectory("/Users/example"), port: "5178", origins,
    cliPath: "/opt/job-service/src/cli.ts", tsxLoader: "/opt/tsx/dist/loader.mjs",
  }), [
    "--import", "/opt/tsx/dist/loader.mjs", "/opt/job-service/src/cli.ts",
    "--data-dir", "/Users/example/Library/Application Support/BetterMe/job-atlas",
    "--host", "127.0.0.1", "--port", "5178",
    "--origin", "http://127.0.0.1:5173", "--origin", "http://localhost:5173",
  ]);
  const plugin = atlasDevIndexPlugin();
  assert.equal(plugin.apply, "serve");
  assert.equal(plugin.configurePreviewServer, undefined);
  assert.equal(typeof plugin.configureServer, "function");
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
