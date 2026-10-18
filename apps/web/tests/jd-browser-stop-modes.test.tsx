import assert from "node:assert/strict";
import test from "node:test";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";
import { browserSessionManager } from "../server/jd-browser-session.ts";
import { jdExtractorPlugin } from "../server/jd-extractor.ts";
import type { NativeBrowserStopMode } from "../server/jd-native-liepin-browser.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const unavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function nativeFixture() {
  const modes: NativeBrowserStopMode[] = []; const gate = deferred(); let blocked = true; let fail = false; let retained = false;
  const manager = createNativeLiepinSessions({ browser: {
    acquire: async () => { throw new Error("no browser launch expected"); },
    stop: async (mode = "explicit") => { modes.push(mode); if (blocked) await gate.promise; if (fail) { retained = true; throw new Error("fixture shutdown failed"); } retained = false; },
    hasUnclosed: () => retained,
  } });
  return { manager, modes, release: () => { blocked = false; gate.resolve(); }, setFail: (value: boolean) => { fail = value; } };
}

test("native manager never shares owned-only success with an explicit stop and propagates the later explicit retry", async () => {
  const f = nativeFixture(); const cleanup = f.manager.stopBrowser("owned-only");
  assert.equal(f.manager.stopBrowser("owned-only"), cleanup);
  await assert.rejects(f.manager.stopBrowser(), unavailable);
  await tick(); assert.deepEqual(f.modes, ["owned-only"]); assert.equal(f.manager.hasSession(), true);
  f.release(); await cleanup; await f.manager.stopBrowser();
  assert.deepEqual(f.modes, ["owned-only", "explicit"]); assert.equal(f.manager.hasSession(), false);
});

test("native owned-only callers share a pending explicit stop including its failure and the retained state can retry", async () => {
  const f = nativeFixture(); f.setFail(true); const explicit = f.manager.stopBrowser();
  const rejected = assert.rejects(explicit, /fixture shutdown failed/);
  assert.equal(f.manager.stopBrowser("owned-only"), explicit);
  f.release(); await rejected; assert.equal(f.manager.hasSession(), true);
  f.setFail(false); await f.manager.stopBrowser(); assert.equal(f.manager.hasSession(), false);
  assert.deepEqual(f.modes, ["explicit", "explicit"]);
});

function backendFixture() {
  const modes: NativeBrowserStopMode[] = []; const gate = deferred(); let blocked = true; let fail = false;
  const unused = async (): Promise<never> => { throw new Error("no page operation expected"); };
  const backend: JobSessionBackend = {
    start: unused, read: unused, inspect: unused, focus: unused, close: unused,
    closeAll: async () => undefined,
    stopBrowser: async (mode = "explicit") => { modes.push(mode); if (blocked) await gate.promise; if (fail) throw new Error("fixture backend stop failed"); },
    owns: () => false, hasSession: () => false,
  };
  return { backend, modes, release: () => { blocked = false; gate.resolve(); }, setFail: (value: boolean) => { fail = value; } };
}

test("three-engine router keeps owned-only and explicit stop strength separate and forwards explicit retry to every engine", async () => {
  const fixtures = [backendFixture(), backendFixture(), backendFixture()];
  const router = createJobSessionRouter(fixtures[0].backend, fixtures[1].backend, { nativeBoss: fixtures[2].backend });
  const cleanup = router.stopBrowser("owned-only"); assert.equal(router.stopBrowser("owned-only"), cleanup);
  await assert.rejects(router.stopBrowser(), unavailable);
  await tick(); assert.equal(router.hasSession(), true);
  for (const f of fixtures) { assert.deepEqual(f.modes, ["owned-only"]); f.release(); }
  await cleanup; await router.stopBrowser();
  for (const f of fixtures) assert.deepEqual(f.modes, ["owned-only", "explicit"]);
  assert.equal(router.hasSession(), false);
});

test("router owned-only shares the explicit failure without dropping its stop reservation before every engine settles", async () => {
  const first = backendFixture(), second = backendFixture(); first.setFail(true); first.release();
  const router = createJobSessionRouter(first.backend, second.backend);
  const explicit = router.stopBrowser(); let settled = false;
  const rejected = assert.rejects(explicit.finally(() => { settled = true; }), /fixture backend stop failed/);
  assert.equal(router.stopBrowser("owned-only"), explicit);
  await tick(); assert.equal(settled, false); assert.equal(router.hasSession(), true);
  second.release(); await rejected; first.setFail(false); await router.stopBrowser();
  assert.deepEqual(first.modes, ["explicit", "explicit"]); assert.deepEqual(second.modes, ["explicit", "explicit"]);
});

test("the actual Vite plugin closeBundle requests only owned resources instead of an explicit profile scan", async (context) => {
  const modes: Array<NativeBrowserStopMode | undefined> = [];
  context.mock.method(browserSessionManager, "stopBrowser", async (mode?: NativeBrowserStopMode) => { modes.push(mode); });
  const plugin = jdExtractorPlugin(); const hook = plugin.closeBundle;
  assert.equal(typeof hook, "function");
  await (hook as () => Promise<void>)();
  assert.deepEqual(modes, ["owned-only"]);
});
