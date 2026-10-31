import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  AGENT_HOST_DEV_ENDPOINT,
  AGENT_HOST_DEV_ORIGINS,
  AGENT_HOST_DEV_TOKEN,
  agentHostDevPlugin,
  agentHostLaunchArgs,
  createDevAgentHostBroker,
  probeAgentHost,
} from "../server/agent-host-dev.ts";

test("Agent Host launch uses the local-only endpoint, development token, and the normal and preview origins", () => {
  assert.deepEqual(agentHostLaunchArgs({ cliPath: "/repo/apps/agent-host/src/cli.ts", tsxLoader: "/repo/node_modules/tsx/loader.mjs", origins: AGENT_HOST_DEV_ORIGINS }), [
    "--import", "/repo/node_modules/tsx/loader.mjs", "/repo/apps/agent-host/src/cli.ts",
    "--host", "127.0.0.1", "--port", "5179", "--token", AGENT_HOST_DEV_TOKEN,
    "--origin", "http://127.0.0.1:5173", "--origin", "http://localhost:5173", "--origin", "http://127.0.0.1:5193",
  ]);
  assert.equal(AGENT_HOST_DEV_ENDPOINT, "http://127.0.0.1:5179");
  assert.deepEqual(agentHostLaunchArgs({ cliPath: "/host.ts", tsxLoader: "/tsx.mjs", origins: [], endpoint: "http://127.0.0.1:5189" }), [
    "--import", "/tsx.mjs", "/host.ts", "--host", "127.0.0.1", "--port", "5189", "--token", AGENT_HOST_DEV_TOKEN,
  ]);
});

test("Agent Host probe sends the expected development bearer token and distinguishes a live foreign service", async () => {
  let authorization = "";
  const seenOrigins: string[] = [];
  assert.equal(await probeAgentHost(AGENT_HOST_DEV_ENDPOINT, async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    const origin = new Headers(init?.headers).get("origin") ?? "";
    seenOrigins.push(origin);
    return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": origin } });
  }), "ready");
  assert.equal(authorization, `Bearer ${AGENT_HOST_DEV_TOKEN}`);
  assert.deepEqual(seenOrigins, [...AGENT_HOST_DEV_ORIGINS]);
  assert.ok(AGENT_HOST_DEV_ORIGINS.includes("http://127.0.0.1:5193"));
  assert.equal(await probeAgentHost(AGENT_HOST_DEV_ENDPOINT, async () => new Response(null, { status: 401 })), "unauthorized");
  assert.equal(await probeAgentHost(AGENT_HOST_DEV_ENDPOINT, async (_input, init) => {
    const origin = new Headers(init?.headers).get("origin") ?? "";
    return new Response(null, { status: 200, headers: origin.endsWith(":5193") ? {} : { "Access-Control-Allow-Origin": origin } });
  }), "origin-rejected", "a healthy Host without preview CORS must not look reusable");
  assert.equal(await probeAgentHost(AGENT_HOST_DEV_ENDPOINT, async () => { throw new Error("connection refused"); }), "down");
});

test("dev Agent Host broker reuses an existing instance, starts once, and only stops owned processes", async () => {
  let status: "ready" | "down" | "unauthorized" | "unavailable" = "ready";
  let starts = 0;
  let stops = 0;
  const broker = createDevAgentHostBroker({
    probe: async () => status,
    start: () => {
      starts += 1;
      status = "ready";
      return { exited: () => false, exitError: () => undefined, stop: async () => { stops += 1; } };
    },
  });
  assert.deepEqual(await broker.ensure(), { endpoint: AGENT_HOST_DEV_ENDPOINT });
  assert.equal(starts, 0, "a healthy existing Agent Host should be reused");
  status = "down";
  const ensured = await Promise.all([broker.ensure(), broker.ensure()]);
  assert.deepEqual(ensured[0], ensured[1]);
  assert.equal(starts, 1, "concurrent startup requests should spawn one process");
  await broker.close();
  assert.equal(stops, 1, "closing dev should stop only its managed child");
});

test("dev Agent Host broker does not overwrite a live service with an unknown token", async () => {
  let starts = 0;
  const broker = createDevAgentHostBroker({ probe: async () => "unauthorized", start: () => { starts += 1; throw new Error("must not start"); } });
  await assert.rejects(broker.ensure(), /开发令牌不匹配/);
  assert.equal(starts, 0);
});

test("dev Agent Host broker restarts its exited child and never duplicates a living one", async () => {
  let status: "ready" | "down" = "down", starts = 0, stops = 0, exited = false;
  const broker = createDevAgentHostBroker({ probe: async () => status, start: () => {
    starts++; status = "ready"; exited = false;
    return { exited: () => exited, exitError: () => "exit", stop: async () => { stops++; status = "down"; exited = true; } };
  } });
  await broker.ensure();
  status = "down";
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(stops, 0, "one failed health probe must not stop a busy child");
  status = "ready";
  await broker.ensure();
  status = "down";
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(stops, 0, "a healthy probe resets the failure streak");
  await assert.rejects(broker.ensure(), /正在|退出|恢复/);
  assert.equal(starts, 1, "a down probe must not create a second child while the first is alive");
  await broker.ensure();
  assert.equal(starts, 2);
  await broker.close();
  assert.equal(stops, 2);
});

test("dev Agent Host broker refuses a live instance that does not allow the active preview origin", async () => {
  let starts = 0;
  const broker = createDevAgentHostBroker({ probe: async () => "origin-rejected", start: () => { starts += 1; throw new Error("must not replace"); } });
  await assert.rejects(broker.ensure(), /未允许当前开发页来源/);
  assert.equal(starts, 0);
});

test("closing during the initial health probe prevents a late Agent Host launch", async () => {
  let releaseProbe!: (status: "ready" | "down" | "unauthorized" | "unavailable") => void;
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  let starts = 0;
  const broker = createDevAgentHostBroker({
    probe: () => new Promise((resolve) => { releaseProbe = resolve; probeStarted(); }),
    start: () => { starts += 1; throw new Error("must not start after close"); },
  });
  const ensure = broker.ensure();
  await started;
  const close = broker.close();
  releaseProbe("down");
  await assert.rejects(ensure, /Vite 开发服务已关闭/);
  await close;
  assert.equal(starts, 0);
});

test("Vite dev starts Agent Host eagerly and stops its owned child when the server closes", async () => {
  let ensures = 0;
  let stops = 0;
  const httpServer = new EventEmitter();
  const plugin = agentHostDevPlugin({
    createBroker: () => ({
      ensure: async () => { ensures += 1; return { endpoint: AGENT_HOST_DEV_ENDPOINT }; },
      close: async () => { stops += 1; },
    }),
  });
  const configureServer = plugin.configureServer as ((server: unknown) => (() => void) | void) | undefined;
  assert.ok(configureServer);
  const cleanup = configureServer({ httpServer });
  cleanup?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ensures, 1);
  httpServer.emit("close");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
});

test("Agent Host watcher keeps checking and stops checks on Vite close", async () => {
  let checks = 0, stops = 0;
  const httpServer = new EventEmitter();
  const plugin = agentHostDevPlugin({ healthIntervalMs: 5, createBroker: () => ({
    ensure: async () => { checks++; return { endpoint: AGENT_HOST_DEV_ENDPOINT }; },
    close: async () => { stops++; },
  }) });
  const cleanup = (plugin.configureServer as (server: unknown) => () => void)({ httpServer });
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.ok(checks >= 2, "a health check must run again without a user request");
  httpServer.emit("close");
  const atClose = checks;
  await new Promise((resolve) => setTimeout(resolve, 28));
  assert.equal(checks, atClose);
  assert.equal(stops, 1);
});
