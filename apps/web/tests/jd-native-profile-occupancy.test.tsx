import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { nativeProfileOccupancySnapshot, type NativeProfileOccupancy } from "../server/jd-native-edge.ts";
import { createNativeLiepinBrowser } from "../server/jd-native-liepin-browser.ts";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import { nativeUnavailable } from "../server/jd-native-cdp.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const profile = "C:/owned-synthetic-unowned-profile";
const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/localOccupiedProfileFixture";
const snapshot = (...commands: unknown[]) => ({ processes: commands.map(command => ({ command })) });
const isUnavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";

test("exact profile argument detects occupancy without inferring a process handle or ownership", () => {
  for (const command of [
    `msedge.exe --user-data-dir="${profile}"`,
    `"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "--user-data-dir=${profile}"`,
    `msedge.exe --user-data-dir "${profile}"`,
    `msedge.exe --USER-DATA-DIR="${profile.toUpperCase()}"`,
    `msedge.exe --type=utility --user-data-dir="${profile}/"`,
    `msedge.exe --user-data-dir=C:/unrelated --user-data-dir="${profile}"`,
  ]) assert.equal(nativeProfileOccupancySnapshot(snapshot(command), profile), "occupied", command);
  assert.equal(nativeProfileOccupancySnapshot(snapshot(null, `--user-data-dir="${profile}"`), profile), "occupied");
});

test("empty process inventory and unrelated exact arguments are clear, but prefixes and embedded URL text never match", () => {
  assert.equal(nativeProfileOccupancySnapshot(snapshot(), profile), "clear");
  for (const command of [
    "msedge.exe --type=renderer",
    `msedge.exe --user-data-dir="${profile}-other"`,
    `msedge.exe --user-data-dir="${profile}/child"`,
    `msedge.exe --other-user-data-dir="${profile}"`,
    `msedge.exe https://example.test/?--user-data-dir=${profile}`,
  ]) assert.equal(nativeProfileOccupancySnapshot(snapshot(command), profile), "clear", command);
});

test("missing, malformed, unreadable and ambiguous process evidence remains unknown", () => {
  for (const value of [undefined, null, [], {}, { processes: null }, { processes: {} }, { processes: [null] }, { processes: [{ command: null }] }, snapshot(""), snapshot("   "), snapshot('""'), snapshot('"   "'), snapshot("--user-data-dir="), snapshot("--user-data-dir"), snapshot("--user-data-dir --type=utility"), snapshot("--user-data-dir=relative"), snapshot('"unclosed'), snapshot("msedge\0.exe")]) {
    assert.equal(nativeProfileOccupancySnapshot(value, profile), "unknown", JSON.stringify(value));
  }
  assert.equal(nativeProfileOccupancySnapshot(snapshot(), ""), "unknown");
  assert.equal(nativeProfileOccupancySnapshot(snapshot(), "relative"), "unknown");
});

test("brand new factory stop checks the exact profile and refuses an occupied browser without launching or touching it", async () => {
  let checks = 0; let launches = 0;
  const browser = createNativeLiepinBrowser({ profileDirectory: profile,
    inspectProfileOccupancy: async current => { checks++; assert.equal(current, path.resolve(profile)); return "occupied"; },
    launch: async () => { launches++; throw new Error("must not launch or attach"); },
  });
  assert.equal(browser.hasUnclosed!(), false);
  await assert.rejects(browser.stop(), isUnavailable); assert.equal(browser.hasUnclosed!(), true);
  await assert.rejects(browser.stop(), isUnavailable); assert.equal(checks, 2); assert.equal(launches, 0);
  assert.equal(await browser.recoverExited!(), false); assert.equal(browser.hasUnclosed!(), true);
});

test("owned-only cleanup without an acquired handle neither inspects an old profile nor clears a failed state", async () => {
  let checks = 0; let launches = 0;
  const browser = createNativeLiepinBrowser({ profileDirectory: profile,
    inspectProfileOccupancy: async () => { checks++; return "occupied"; },
    launch: async () => { launches++; throw nativeUnavailable("fixture profile occupied"); },
  });
  await browser.stop("owned-only"); assert.equal(checks, 0); assert.equal(launches, 0); assert.equal(browser.hasUnclosed!(), false);
  await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable); assert.equal(browser.hasUnclosed!(), true);
  await browser.stop("owned-only"); assert.equal(checks, 0); assert.equal(browser.hasUnclosed!(), true);
  await assert.rejects(browser.stop(), isUnavailable); assert.equal(checks, 1); assert.equal(launches, 1);
});

test("explicit stop cannot inherit pending owned-only success and requires a later stronger occupancy proof", async () => {
  let checks = 0;
  const browser = createNativeLiepinBrowser({ profileDirectory: profile,
    inspectProfileOccupancy: async () => { checks++; return "occupied"; },
    launch: async () => { throw new Error("must not launch"); },
  });
  const cleanup = browser.stop("owned-only"); const explicit = browser.stop();
  assert.notEqual(cleanup, explicit);
  await assert.rejects(explicit, isUnavailable); await cleanup;
  assert.equal(checks, 0); assert.equal(browser.hasUnclosed!(), false);
  await assert.rejects(browser.stop(), isUnavailable); assert.equal(checks, 1); assert.equal(browser.hasUnclosed!(), true);
});

test("no-handle stop treats unknown, asynchronous rejection, and synchronous inspector throw as unconfirmed", async () => {
  for (const mode of ["unknown", "reject", "throw"] as const) {
    const browser = createNativeLiepinBrowser({ profileDirectory: profile,
      inspectProfileOccupancy: () => { if (mode === "throw") throw new Error("OS denied"); return mode === "reject" ? Promise.reject(new Error("OS unavailable")) : Promise.resolve("unknown"); },
      launch: async () => { throw new Error("must not launch"); },
    });
    await assert.rejects(browser.stop(), isUnavailable); assert.equal(browser.hasUnclosed!(), true);
    await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable);
  }
});

test("launch failure from occupied profile cannot be cleared by stop until the user has closed that browser", async () => {
  let occupancy: NativeProfileOccupancy = "occupied"; let launches = 0; let checks = 0;
  const browser = createNativeLiepinBrowser({ profileDirectory: profile,
    inspectProfileOccupancy: async () => { checks++; return occupancy; },
    launch: async () => { launches++; throw nativeUnavailable("岗位专用目录仍被浏览器占用，请先显式关闭该工具浏览器。"); },
  });
  await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable);
  assert.equal(launches, 1); assert.equal(browser.hasUnclosed!(), true);
  await assert.rejects(browser.stop(), isUnavailable); assert.equal(browser.hasUnclosed!(), true);
  await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable); assert.equal(launches, 1);
  occupancy = "clear"; await browser.stop(); assert.equal(browser.hasUnclosed!(), false); assert.equal(checks, 2);
  await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable); assert.equal(launches, 2);
  await browser.stop(); assert.equal(browser.hasUnclosed!(), false);
});

test("manager explicit stop propagates unowned occupancy and preserves its blocked state until a clear recheck", async () => {
  let occupancy: NativeProfileOccupancy = "occupied";
  const browser = createNativeLiepinBrowser({ platform: "BOSS直聘", profileDirectory: profile,
    inspectProfileOccupancy: async () => occupancy,
    launch: async () => { throw nativeUnavailable("岗位专用目录仍被浏览器占用，请先显式关闭该工具浏览器。"); },
  });
  const manager = createNativeLiepinSessions({ platform: "BOSS直聘", browser, getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }) });
  await assert.rejects(manager.start("owner", source), isUnavailable); assert.equal(manager.hasSession(), true);
  await assert.rejects(manager.stopBrowser(), isUnavailable); assert.equal(manager.hasSession(), true);
  occupancy = "clear"; await manager.stopBrowser(); assert.equal(manager.hasSession(), false);
});

test("concurrent no-handle stops share one observation and block acquisition until it settles", async () => {
  let complete!: (value: NativeProfileOccupancy) => void; let checks = 0; let launches = 0;
  const pending = new Promise<NativeProfileOccupancy>(resolve => { complete = resolve; });
  const browser = createNativeLiepinBrowser({ profileDirectory: profile,
    inspectProfileOccupancy: async () => { checks++; return pending; },
    launch: async () => { launches++; throw new Error("must not launch while stopping"); },
  });
  const first = browser.stop(); const second = browser.stop(); assert.equal(first, second);
  assert.equal(browser.hasUnclosed!(), true);
  await assert.rejects(browser.acquire(undefined, new AbortController().signal), isUnavailable);
  complete("clear"); await first; assert.equal(checks, 1); assert.equal(launches, 0); assert.equal(browser.hasUnclosed!(), false);
});
