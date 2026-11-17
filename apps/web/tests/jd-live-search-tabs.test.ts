import assert from "node:assert/strict";
import test from "node:test";
import { LiveSearchTabs, liveSearchTabsFor, idleLiveSearchTabs, releaseLiveSearchTabs } from "../server/jd-live-search-tabs";
import { captureProviderViaNativeCdp } from "../server/jd-live-batch-search";
import type { NativeCdp } from "../server/jd-native-cdp";

const url = "https://we.51job.com/pc/search?keyword=Java";
function fixture() {
  const targets = new Map([["personal", "https://example.org/private"]]);
  const sessions = new Map<string, string>();
  const created: string[] = [], closed: string[] = [], navigated: string[] = [], activated: string[] = [];
  let failClose = false, delayedClose = false;
  const cdp: NativeCdp = {
    connected: true, on() { return () => {}; }, close() {},
    async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      if (method === "Target.createTarget") {
        assert.deepEqual(params, { url: "about:blank", background: true });
        const id = `owned-${created.length + 1}`; created.push(id); targets.set(id, "about:blank");
        return { targetId: id } as T;
      }
      if (method === "Target.getTargets") return { targetInfos: [...targets].map(([targetId, url]) => ({ targetId, url, type: "page" })) } as T;
      if (method === "Target.closeTarget") {
        if (failClose) return { success: false } as T;
        if (delayedClose) return { success: true } as T;
        const id = String(params.targetId); closed.push(id); targets.delete(id); return { success: true } as T;
      }
      if (method === "Target.attachToTarget") { const id = String(params.targetId); sessions.set(`s-${id}`, id); return { sessionId: `s-${id}` } as T; }
      if (method === "Target.activateTarget") activated.push(String(params.targetId));
      const target = sessions.get(sessionId ?? "");
      if (method === "Page.navigate" && target) { navigated.push(target); targets.set(target, String(params.url)); }
      if (method === "DOMSnapshot.captureSnapshot") return emptySnapshot(targets.get(target ?? "") ?? url, target ?? "") as T;
      if (method === "Runtime.evaluate") return { result: { value: String(params.expression).includes("marker:")
        ? { url: targets.get(target ?? "") ?? url, marker: "" } : [] } } as T;
      return {} as T;
    },
  };
  return { cdp, targets, created, closed, navigated, activated, failClose(value: boolean) { failClose = value; }, delayedClose(value: boolean) { delayedClose = value; } };
}

function emptySnapshot(pageUrl: string, targetId: string) {
  const strings: string[] = [];
  const str = (value: string) => { strings.push(value); return strings.length - 1; };
  const message = "暂无匹配岗位";
  const styles = ["block", "visible", "1", "visible", "visible", "visible", "clip", "none", "auto", "none", "none", "none", "none", "none", "rgb(0, 0, 0)"].map(str);
  return { strings, documents: [{ frameId: str(targetId), documentURL: str(pageUrl), title: str("Synthetic search"),
    nodes: { nodeType: [9, 1, 1, 1, 1, 3], parentIndex: [-1, 0, 1, 1, 3, 4], nodeName: ["#document", "HTML", "HEAD", "BODY", "DIV", "#text"].map(str),
      nodeValue: [-1, -1, -1, -1, -1, str(message)], backendNodeId: [1, 2, 3, 4, 5, 6], attributes: [[], [], [], [], [str("class"), str("search-empty")], []] },
    layout: { nodeIndex: [1, 3, 4, 5], styles: [styles, styles, styles, []], bounds: [[0, 0, 1000, 1000], [0, 0, 1000, 1000], [0, 0, 600, 20], [0, 0, 600, 20]],
      text: [-1, -1, -1, str(message)], textColorOpacities: [1, 1, 1, 1] },
    textBoxes: { layoutIndex: [3], bounds: [[0, 0, 600, 20]], start: [0], length: [message.length] },
  }] };
}

test("three actual collector calls reuse one owned background tab and close it after the run", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  for (const keyword of ["Java", "Rust", "Go"]) {
    const result = await captureProviderViaNativeCdp(f.cdp, { provider: "51job", platform: "51JOB", url: url.replace("Java", keyword) },
      [], keyword, undefined, 0, "quick", 1, undefined, undefined, async () => undefined, tabs);
    assert.equal(result.status, "empty");
    assert.equal(result.coverage.stopReason, "exhausted");
  }
  assert.equal(f.created.length, 1, "the provider worker reuses its own page across expanded keywords");
  assert.equal(f.closed.length, 0, "the leased page remains available until run cleanup");
  assert.equal(await tabs.close(f.cdp), true);
  assert.deepEqual(f.closed, ["owned-1"]);
  assert.deepEqual(f.activated, []);
  assert.ok(f.navigated.every(id => id !== "personal"));
  assert.equal(f.targets.get("personal"), "https://example.org/private");
});

test("an exclusive provider lease rejects overlap and cancellation retires only the owned page", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  const first = tabs.acquire(f.cdp, "51job", url);
  await assert.rejects(tabs.acquire(f.cdp, "51job", url), /未重复打开/);
  const lease = await first;
  await lease.release(false);
  assert.deepEqual(f.closed, [lease.targetId]);
  assert.equal(tabs.empty, true);
  assert.ok(f.targets.has("personal"));
});

test("user-navigated pages and explicit interactive gates are relinquished, not reused or closed", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  const lease = await tabs.acquire(f.cdp, "51job", url);
  await lease.release(true);
  f.targets.set(lease.targetId, "https://example.org/user-chosen");
  const next = await tabs.acquire(f.cdp, "51job", url);
  assert.notEqual(next.targetId, lease.targetId);
  await next.release(false, true);
  await tabs.close(f.cdp);
  assert.deepEqual(f.closed, []);
  assert.equal(f.targets.size, 3);
});

test("a failed close retains ownership, blocks replacement and permits bounded cleanup retry", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  const lease = await tabs.acquire(f.cdp, "51job", url);
  f.failClose(true);
  await assert.rejects(lease.release(false), /尚未确认关闭/);
  await assert.rejects(tabs.acquire(f.cdp, "51job", url), /未重复打开/);
  assert.equal(await tabs.close(f.cdp), false);
  f.failClose(false);
  assert.equal(await tabs.close(f.cdp), true);
  assert.equal(f.created.length, 1);
});

test("closing a busy collection prevents new leases and its final release drains the page", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  const lease = await tabs.acquire(f.cdp, "51job", url);
  assert.equal(await tabs.close(f.cdp), false);
  await assert.rejects(tabs.acquire(f.cdp, "boss", "https://www.zhipin.com/web/geek/job"), /正在收尾/);
  await lease.release(true);
  assert.equal(tabs.empty, true);
});

test("an accepted close is not considered complete while the target still exists", async () => {
  const f = fixture(), tabs = new LiveSearchTabs();
  const lease = await tabs.acquire(f.cdp, "51job", url);
  f.delayedClose(true);
  await assert.rejects(lease.release(false), /尚未确认关闭/);
  await assert.rejects(tabs.acquire(f.cdp, "51job", url), /未重复打开/);
  assert.equal(tabs.empty, false);
  f.delayedClose(false);
  assert.equal(await tabs.close(f.cdp), true);
  assert.ok(f.targets.has("personal"));
});

test("collection capabilities are origin-bound and releasing an absent collection does not connect a browser", async () => {
  const id = "55a30631-e3b0-41c0-adb7-7c001b001111";
  liveSearchTabsFor(id, "origin-a");
  assert.throws(() => liveSearchTabsFor(id, "origin-b"), /不属于/);
  assert.equal(await releaseLiveSearchTabs(id, "origin-b"), false);
  idleLiveSearchTabs(id, "origin-a");
  assert.equal(await releaseLiveSearchTabs(id, "origin-a"), true);
});

test("closing every failed page between keywords cannot reset the collection visual budget", async () => {
  const id = "55a30631-e3b0-41c0-adb7-7c001b002222";
  const first = liveSearchTabsFor(id, "origin-a", true);
  idleLiveSearchTabs(id, "origin-a");
  const nextKeyword = liveSearchTabsFor(id, "origin-a", true);
  assert.equal(nextKeyword.visualRecovery, first.visualRecovery);
  assert.equal(await releaseLiveSearchTabs(id, "origin-a"), true, "empty tool pools release without opening Chrome");
  const newCollection = liveSearchTabsFor(id, "origin-a");
  assert.notEqual(newCollection.visualRecovery, first.visualRecovery);
  idleLiveSearchTabs(id, "origin-a");
});
