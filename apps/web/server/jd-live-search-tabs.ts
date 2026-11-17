import type { PlatformSearchProvider } from "@better-me/source-adapters";
import { connectNativeCdp, type NativeCdp, type NativeTargetList } from "./jd-native-cdp";
import { HarvestVisualRecovery } from "./jd-harvest-visual";

type Entry = { targetId?: string; url: string; busy: boolean; discard: boolean };
export type LiveSearchTabLease = {
  targetId: string;
  release(reusable: boolean, preserve?: boolean): Promise<void>;
};

/** Only targets created here are reusable. Never adopts an existing user tab. */
export class LiveSearchTabs {
  readonly visualRecovery = new HarvestVisualRecovery();
  private readonly entries = new Map<PlatformSearchProvider, Entry>();
  private closing = false;
  get empty() { return this.entries.size === 0; }

  private sameSearchPage(actual: string, expected: string) {
    if (actual === "about:blank") return true;
    try {
      const current = new URL(actual), search = new URL(expected);
      return current.origin === search.origin && current.pathname.replace(/\/$/, "") === search.pathname.replace(/\/$/, "");
    } catch { return false; }
  }

  private async remove(cdp: NativeCdp, provider: PlatformSearchProvider, entry: Entry): Promise<void> {
    if (entry.targetId) {
      const { targetInfos } = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000);
      const target = targetInfos.find(value => value.targetId === entry.targetId);
      // A user-navigated tab is no longer ours to navigate or close.
      if (target && this.sameSearchPage(target.url, entry.url)) {
        const result = await cdp.send<{ success?: boolean }>("Target.closeTarget", { targetId: entry.targetId }, undefined, 2000);
        if (result.success !== true) throw new Error("采集后台页尚未确认关闭；保留所有权，未创建替代页。");
        const remaining = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000);
        if (remaining.targetInfos.some(value => value.targetId === entry.targetId)) {
          throw new Error("采集后台页尚未确认关闭；保留所有权，未创建替代页。");
        }
      }
    }
    if (this.entries.get(provider) === entry) this.entries.delete(provider);
  }

  async acquire(cdp: NativeCdp, provider: PlatformSearchProvider, url: string): Promise<LiveSearchTabLease> {
    if (this.closing) throw new Error("本轮后台页面正在收尾，未重复启动采集。");
    let entry = this.entries.get(provider);
    if (entry?.busy || entry?.discard) throw new Error("该平台后台页正在读取或等待清理，未重复打开标签页。");
    if (!entry) {
      entry = { url, busy: false, discard: false };
      this.entries.set(provider, entry);
    }
    entry.busy = true;
    const owned = entry;
    try {
      if (owned.targetId) {
        const { targetInfos } = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2000);
        const target = targetInfos.find(value => value.targetId === owned.targetId && value.type === "page");
        if (!target || !this.sameSearchPage(target.url, owned.url)) owned.targetId = undefined;
      }
      if (!owned.targetId) {
        const created = await cdp.send<{ targetId?: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 4000);
        if (!created.targetId) throw new Error("无法创建平台搜索后台页。");
        owned.targetId = created.targetId;
      }
      owned.url = url;
      let released = false;
      return { targetId: owned.targetId, release: async (reusable, preserve = false) => {
        if (released) return;
        released = true;
        owned.busy = false;
        if (preserve) { this.entries.delete(provider); return; }
        if (reusable && !this.closing) return;
        owned.discard = true;
        await this.remove(cdp, provider, owned);
      } };
    } catch (error) {
      owned.busy = false;
      owned.discard = true;
      // A failed create/attach cannot make the registry forget a known target.
      if (!owned.targetId) this.entries.delete(provider);
      throw error;
    }
  }

  async close(cdp: NativeCdp): Promise<boolean> {
    this.closing = true;
    await Promise.allSettled([...this.entries].filter(([, entry]) => !entry.busy).map(async ([provider, entry]) => {
      entry.discard = true;
      await this.remove(cdp, provider, entry);
    }));
    return this.empty;
  }
}

type Collection = { owner: string; tabs: LiveSearchTabs; retainVisualBudget: boolean; timer?: ReturnType<typeof setTimeout> };
const collections = new Map<string, Collection>();
const IDLE_MS = 120_000;

/** An ephemeral capability is scoped to the requesting local origin, not a saved login. */
export function liveSearchTabsFor(id: string, owner: string, retainVisualBudget = false): LiveSearchTabs {
  let collection = collections.get(id);
  if (collection && collection.owner !== owner) throw new Error("采集后台页不属于当前工作台。");
  if (!collection) {
    if (collections.size >= 8) throw new Error("后台采集会话已达上限，请等待现有采集收尾。");
    collection = { owner, tabs: new LiveSearchTabs(), retainVisualBudget };
    collections.set(id, collection);
  }
  // Even if every failed page was closed, later keywords must not get a fresh model allowance.
  if (retainVisualBudget) collection.retainVisualBudget = true;
  clearTimeout(collection.timer);
  return collection.tabs;
}

export async function releaseLiveSearchTabs(id: string, owner: string): Promise<boolean> {
  const collection = collections.get(id);
  if (!collection) return true;
  if (collection.owner !== owner) return false;
  clearTimeout(collection.timer);
  if (collection.tabs.empty) { collections.delete(id); return true; }
  let cdp: NativeCdp | undefined;
  try {
    cdp = await connectNativeCdp(9222);
    if (await collection.tabs.close(cdp)) { collections.delete(id); return true; }
  } catch { /* Keep ownership so a close failure can be retried safely. */ }
  finally { cdp?.close(); }
  idleLiveSearchTabs(id, owner);
  return false;
}

/** Bounded fallback if a renderer disappears before its explicit release. */
export function idleLiveSearchTabs(id: string, owner: string) {
  const collection = collections.get(id);
  if (!collection || collection.owner !== owner) return;
  clearTimeout(collection.timer);
  if (collection.tabs.empty && !collection.retainVisualBudget) { collections.delete(id); return; }
  collection.timer = setTimeout(() => { void releaseLiveSearchTabs(id, owner); }, IDLE_MS);
  collection.timer.unref();
}
