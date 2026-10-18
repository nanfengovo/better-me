import assert from "node:assert/strict";
import test from "node:test";
import { closeNativeTarget, type NativeCdp } from "../server/jd-native-cdp.ts";

test("a close guard can preserve a target recognized by current metadata or an event during the query", async () => {
  for (const mode of ["metadata", "event"]) {
    let recognized = false; let closes = 0;
    const cdp = { connected: true, async send(method: string) {
      if (method === "Target.closeTarget") { closes++; return { success: true }; }
      recognized = mode === "event";
      return { targetInfos: [{ targetId: "base", url: "about:blank", type: "page" }, { targetId: "setup", url: mode === "metadata" ? "edge://sync-confirmation-dialog/" : "about:blank", type: "page" }] };
    } } as NativeCdp;
    const result = await closeNativeTarget(cdp, "setup", "base", 100, target => recognized || target?.url === "edge://sync-confirmation-dialog/");
    assert.equal(result.preserved, true); assert.equal(result.accepted, "not_sent"); assert.equal(result.confirmed, false); assert.equal(result.actualGone, false); assert.equal(closes, 0);
  }
});

test("a setup event queued after the query guard is rechecked immediately before close", async () => {
  let recognized = false; let checks = 0; let closes = 0;
  const cdp = { connected: true, async send(method: string) {
    if (method === "Target.closeTarget") { closes++; return { success: true }; }
    return { targetInfos: [{ targetId: "base", url: "about:blank", type: "page" }, { targetId: "setup", url: "about:blank", type: "page" }] };
  } } as NativeCdp;
  const result = await closeNativeTarget(cdp, "setup", "base", 100, () => {
    if (++checks === 1) queueMicrotask(() => { recognized = true; });
    return recognized;
  });
  assert.equal(result.preserved, true); assert.equal(result.confirmed, false); assert.equal(closes, 0); assert.equal(checks, 2);
});
