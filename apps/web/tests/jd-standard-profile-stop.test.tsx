import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createPersistentJobBrowser } from "../server/jd-persistent-browser.ts";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { persistentJobBrowser } from "../server/jd-browser.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import type { NativeBrowserStopMode } from "../server/jd-native-liepin-browser.ts";

const root = path.resolve("C:/synthetic-unused-standard-stop-43");
const source = "https://msearch.51job.com/jobs/all/166761768.html";
const unavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const noLaunch = async (): Promise<never> => { throw new Error("must not launch a browser"); };
const operation = { fetch, routeFor: () => ({ mode: "direct" as const, source: "fixture" }) };

test("ordinary pool cleanup stays owned-only while an explicit empty-pool stop requires evidence for every fixed profile", async () => {
  const checks: string[] = [];
  const pool = createPersistentJobBrowser({ rootDirectory: root, allowedResource: () => true, launch: noLaunch,
    inspectProfileOccupancy: async profile => { checks.push(profile); return "clear"; },
  });
  await pool.closeAll(); await pool.stop("owned-only"); assert.deepEqual(checks, []);
  await pool.stop();
  assert.deepEqual(checks.sort(), ["51job", "boss", "liepin", "linkedin"].map(name => path.join(root, name, "profile")).sort());
  assert.deepEqual(pool.status(), []);
});

test("occupied no-handle profile remains blocked through ordinary cleanup and clears only after an explicit clear recheck", async () => {
  let occupancy: "occupied" | "clear" = "occupied"; let checks = 0; let launches = 0;
  const pool = createPersistentJobBrowser({ rootDirectory: root, allowedResource: () => true,
    launch: async () => { launches++; return noLaunch(); },
    inspectProfileOccupancy: async profile => { checks++; return profile === path.join(root, "51job", "profile") ? occupancy : "clear"; },
  });
  await assert.rejects(pool.stop(), unavailable);
  assert.deepEqual(pool.status(), [{ platform: "51JOB", state: "close_failed", activePages: 0 }]);
  await pool.closeAll(); await pool.stop("owned-only"); assert.equal(checks, 4);
  await assert.rejects(pool.acquire("51JOB", operation), unavailable); assert.equal(launches, 0);
  occupancy = "clear"; await pool.stop(); assert.equal(checks, 8); assert.deepEqual(pool.status(), []);
});

test("missing, unknown and failed inspection never turn an explicit no-handle stop into successful closure", async () => {
  for (const inspection of [undefined, async () => "unknown" as const, async (): Promise<never> => { throw new Error("unreadable OS evidence"); }]) {
    const pool = createPersistentJobBrowser({ rootDirectory: root, allowedResource: () => true, launch: noLaunch, inspectProfileOccupancy: inspection });
    await assert.rejects(pool.stop(), unavailable);
    assert.equal(pool.status().length, 4); assert.ok(pool.status().every(status => status.state === "close_failed"));
    await pool.stop("owned-only"); assert.equal(pool.status().length, 4);
  }
});

test("explicit pool stops share the complete scan; weaker callers inherit its failure and acquisition stays blocked", async () => {
  const gate = deferred<"clear" | "occupied">(); let checks = 0;
  const pool = createPersistentJobBrowser({ rootDirectory: root, allowedResource: () => true, launch: noLaunch,
    inspectProfileOccupancy: async profile => { checks++; return profile === path.join(root, "51job", "profile") ? gate.promise : "clear"; },
  });
  const explicit = pool.stop(); const rejected = assert.rejects(explicit, unavailable);
  assert.equal(pool.stop(), explicit); assert.equal(pool.stop("owned-only"), explicit);
  await tick(); assert.equal(checks, 4);
  await assert.rejects(pool.acquire("LinkedIn", operation), unavailable);
  gate.resolve("occupied"); await rejected;
  assert.deepEqual(pool.status(), [{ platform: "51JOB", state: "close_failed", activePages: 0 }]);
});

test("an explicit pool stop cannot share pending owned-only success and must scan on a later retry", async () => {
  let checks = 0;
  const pool = createPersistentJobBrowser({ rootDirectory: root, allowedResource: () => true, launch: noLaunch,
    inspectProfileOccupancy: async () => { checks++; return "clear"; },
  });
  const cleanup = pool.stop("owned-only"); assert.equal(pool.stop("owned-only"), cleanup);
  await assert.rejects(pool.stop(), unavailable); await cleanup; assert.equal(checks, 0);
  await pool.stop(); assert.equal(checks, 4);
});

test("standard manager preserves mode strength, blocks a direct start while stopping, and retries without touching the OS", async () => {
  const gate = deferred<void>(); const modes: Array<NativeBrowserStopMode | undefined> = []; let operationCalls = 0;
  const manager = createBrowserSessionManager({ acquire: async () => { throw new Error("no page expected"); },
    getOperation: async () => { operationCalls++; return operation; },
    stopBrowser: async mode => { modes.push(mode); if (modes.length === 1) await gate.promise; },
  });
  const cleanup = manager.stopBrowser("owned-only"); assert.equal(manager.stopBrowser("owned-only"), cleanup);
  await assert.rejects(manager.stopBrowser(), unavailable); await tick();
  await assert.rejects(manager.start("owner", source), unavailable); assert.equal(operationCalls, 0); assert.equal(manager.hasSession(), true);
  gate.resolve(); await cleanup; await manager.stopBrowser();
  assert.deepEqual(modes, ["owned-only", "explicit"]); assert.equal(manager.hasSession(), false);
});

test("standard manager owned-only callers share explicit failure; existing zero-argument stop injection remains synthetic", async () => {
  const gate = deferred<void>(); let calls = 0; let fail = true;
  const manager = createBrowserSessionManager({ acquire: noLaunch, stopBrowser: async () => { calls++; await gate.promise; if (fail) throw new Error("synthetic stop failure"); } });
  const explicit = manager.stopBrowser(); const rejected = assert.rejects(explicit, /synthetic stop failure/);
  assert.equal(manager.stopBrowser("owned-only"), explicit); gate.resolve(); await rejected;
  fail = false; await manager.stopBrowser(); assert.equal(calls, 2); assert.equal(manager.hasSession(), false);
});

test("the default standard manager forwards cleanup and explicit modes to the actual persistent pool stop API", async context => {
  const modes: Array<NativeBrowserStopMode | undefined> = [];
  context.mock.method(persistentJobBrowser, "stop", async (mode?: NativeBrowserStopMode) => { modes.push(mode); });
  const manager = createBrowserSessionManager();
  await manager.stopBrowser("owned-only"); await manager.stopBrowser();
  assert.deepEqual(modes, ["owned-only", "explicit"]);
});

test("standard start rechecks stop after waiting for an expired session release", async () => {
  const { EventEmitter } = await import("node:events");
  const releaseGate = deferred<void>(); let clock = 1_700_000_000_000; let acquisitions = 0; let releasing = false;
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, url: () => source, mainFrame: () => ({}),
    route: async () => undefined, routeWebSocket: async () => undefined,
    goto: async () => undefined, bringToFront: async () => undefined,
  }) as unknown as import("playwright-core").Page;
  const release = async () => { releasing = true; await releaseGate.promise; };
  const manager = createBrowserSessionManager({ now: () => clock,
    acquire: async () => { acquisitions++; return { page, context: new EventEmitter() as unknown as import("playwright-core").BrowserContext, release, releasePage: release }; },
    getOperation: async () => operation, stopBrowser: async () => undefined,
  });
  await manager.start("owner", source); clock += 600_001;
  const next = manager.start("owner", source); const rejected = assert.rejects(next, unavailable);
  await tick(); assert.equal(releasing, true); const stopping = manager.stopBrowser("owned-only");
  releaseGate.resolve(); await rejected; await stopping; assert.equal(acquisitions, 1); assert.equal(manager.hasSession(), false);
});
