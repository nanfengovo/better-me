export type JdBrowserCleanupSnapshot = Readonly<{ pending: number; retrying: boolean }>;

/** Page-local cleanup bookkeeping. Keys identify trusted requests or sessions. */
export function createJdBrowserCleanupTracker() {
  const items = new Map<string, () => Promise<void>>();
  const confirmed = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: JdBrowserCleanupSnapshot = Object.freeze({ pending: 0, retrying: false });
  let retrying: Promise<void> | undefined;
  const idle = Promise.resolve();

  const publish = () => {
    const active = retrying !== undefined;
    if (snapshot.pending === items.size && snapshot.retrying === active) return;
    snapshot = Object.freeze({ pending: items.size, retrying: active });
    for (const listener of [...listeners]) if (listeners.has(listener)) listener();
  };

  const confirm = (key: string) => {
    confirmed.add(key);
    items.delete(key);
    publish();
  };

  return {
    record(key: string, cleanup: () => Promise<void>) {
      if (confirmed.has(key) || items.has(key)) return;
      items.set(key, cleanup);
      publish();
    },
    confirm,
    retry(): Promise<void> {
      if (retrying) return retrying;
      const captured = [...items];
      if (captured.length === 0) return idle;
      const work = Promise.resolve().then(async () => {
        for (const [key, cleanup] of captured) {
          if (confirmed.has(key) || !items.has(key)) continue;
          try {
            await cleanup();
            confirm(key);
          } catch {
            // An unconfirmed item remains available for a later exact retry.
          }
        }
      }).finally(() => {
        if (retrying === work) { retrying = undefined; publish(); }
      });
      retrying = work;
      publish();
      return work;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
  };
}

/** Shared by modal instances in this page; never persisted across a refresh. */
export const jdBrowserCleanupTracker = createJdBrowserCleanupTracker();
