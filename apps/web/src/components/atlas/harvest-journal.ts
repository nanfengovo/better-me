import type { HarvestJournal, HarvestLease } from "./harvest-checkpoint";
import { harvestConnectionScope, openJournalStorage } from "./harvest-journal-idb";
import { createHarvestJournalAdapter } from "./harvest-journal-store";

export async function openHarvestJournal({ endpoint, token }: { endpoint: string; token: string }): Promise<HarvestJournal> {
  const scope = await harvestConnectionScope(endpoint, token);
  return createHarvestJournalAdapter(await openJournalStorage(), scope);
}

/** A browser-wide exclusive writer. Releasing it never cancels server work. */
export async function acquireHarvestLease(scope: string, { signal }: { signal?: AbortSignal } = {}): Promise<HarvestLease | undefined> {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("采集恢复范围无效，请重新连接本机岗位服务。");
  const manager = globalThis.navigator?.locks;
  if (!manager?.request) throw new Error("当前浏览器不支持跨标签采集锁，无法安全恢复；请使用支持 Web Locks 的浏览器。");
  return new Promise((resolve, reject) => {
    let delivered = false;
    const abortPending = () => { if (!delivered) reject(signal?.reason); };
    signal?.addEventListener("abort", abortPending, { once: true });
    // The Web Locks spec rejects signal + ifAvailable. Cancellation belongs
    // outside the native request and only applies before a lease is delivered.
    void Promise.resolve().then(() => manager.request(`better-me-atlas-harvest:${scope}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      signal?.removeEventListener("abort", abortPending);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (!lock) { resolve(undefined); return; }
      let releaseHold!: () => void;
      const held = new Promise<void>(done => { releaseHold = done; });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseHold();
      };
      delivered = true;
      resolve({ release });
      await held;
    })).catch(error => { signal?.removeEventListener("abort", abortPending); reject(error); });
  });
}
