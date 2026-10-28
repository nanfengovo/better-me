import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRealBrowserBinary,
  checkCdpRunning,
  getRealChromeStatus,
  realChromeLaunchCommand,
  scheduleLaunchActivation,
} from "../server/jd-real-chrome-launcher";

test("default macOS launch uses background Launch Services while explicit launch may foreground", () => {
  const binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const args = ["--remote-debugging-port=9222", "https://www.zhipin.com"];
  assert.deepEqual(realChromeLaunchCommand(binary, args, {}, "darwin"), {
    command: "open",
    args: ["-g", "-j", "-n", "-a", "/Applications/Google Chrome.app", "--args", ...args],
  });
  assert.deepEqual(realChromeLaunchCommand(binary, args, { focusOnLaunch: true }, "darwin"), {
    command: binary,
    args,
  });
});

test("macOS launch activation is opt-in while an explicit foreground request still activates", () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let activations = 0;
  const schedule = (callback: () => void, delay: number) => {
    scheduled.push({ callback, delay });
    return 1 as unknown as NodeJS.Timeout;
  };
  const activate = () => { activations++; };

  assert.equal(scheduleLaunchActivation({}, schedule, activate, "darwin"), false);
  assert.deepEqual(scheduled, [], "default background startup must not schedule AppleScript activation");
  assert.equal(scheduleLaunchActivation({ focusOnLaunch: true }, schedule, activate, "darwin"), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.delay, 700);
  scheduled[0]?.callback();
  assert.equal(activations, 1, "an explicit foreground launch retains the existing activation behavior");
});

test("findRealBrowserBinary finds a browser or returns undefined gracefully", () => {
  const binary = findRealBrowserBinary();
  if (process.platform === "darwin") {
    // Usually Google Chrome or Edge is installed on dev machine
    if (binary) {
      assert.ok(binary.includes("Chrome") || binary.includes("Edge") || binary.includes("Brave") || binary.includes("Chromium"));
    }
  }
});

test("checkCdpRunning returns false for an inactive port", async () => {
  const isRunning = await checkCdpRunning(49151); // reserved / inactive port
  assert.equal(isRunning, false);
});

test("getRealChromeStatus returns structured information", async () => {
  const status = await getRealChromeStatus(49151);
  assert.equal(typeof status.running, "boolean");
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.binaryFound, "boolean");
  assert.equal(typeof status.message, "string");
  assert.equal(status.port, 49151);
});
