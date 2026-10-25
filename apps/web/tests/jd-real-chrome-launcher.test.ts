import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRealBrowserBinary,
  checkCdpRunning,
  getRealChromeStatus,
} from "../server/jd-real-chrome-launcher";

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
