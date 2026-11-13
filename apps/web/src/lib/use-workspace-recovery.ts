import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import { capturePrivateStorage, privateKey } from "./private-storage";

// Failed local writes must survive React unmounts too. This is only a same-process
// safety net; the unload guard still protects them against a browser/app exit.
type RetainedDraft = { value: unknown; raw: string | null; error: string; blocked: boolean; owner: string };
const retainedDrafts = new Map<string, RetainedDraft>();

/** Synchronous, owner-scoped UI journal. Never stores credentials or grants and
 * never starts work on restore. Callers must key their session by workspace. */
export function useWorkspaceRecovery<T>(key: string, schema: z.ZodType<T>, initial: () => NoInfer<T>) {
  const [scope] = useState(() => {
    const storage = capturePrivateStorage();
    const storageKey = `betterme.recovery.v1:${key}`;
    const eventKey = privateKey(storageKey), owner = privateKey("");
    let raw: string | null = null, value = initial(), error = "", blocked = false;
    try {
      raw = storage.getItem(storageKey);
      if (raw !== null) value = schema.parse(z.object({ version: z.literal(1), value: z.unknown() }).strict().parse(JSON.parse(raw)).value);
    } catch {
      error = "本机恢复记录无法读取，原记录未覆盖。请下载备份并保留此页内容。";
      blocked = true;
    }
    const retained = retainedDrafts.get(eventKey);
    if (retained) {
      value = schema.parse(retained.value); error = retained.error; blocked = retained.blocked;
      if (raw !== retained.raw) {
        error = "另一窗口已更新记录，本页保留未保存草稿且不覆盖。请下载本页备份，再刷新页面核对。";
        blocked = true;
      }
      raw = retained.raw;
    }
    if (error) retainedDrafts.set(eventKey, { value, raw, error, blocked, owner });
    return { storage, storageKey, eventKey, owner, raw, value, error, blocked, restored: raw !== null && !error };
  });
  const [value, setValue] = useState(scope.value);
  const [error, setError] = useState(scope.error);
  const current = useRef({ value: scope.value, raw: scope.raw, error: scope.error, blocked: scope.blocked });
  const set = useCallback<Dispatch<SetStateAction<T>>>((change) => {
    const previous = current.current;
    const next = schema.parse(typeof change === "function" ? (change as (value: T) => T)(previous.value) : change);
    if (JSON.stringify(next) === JSON.stringify(previous.value)) return;
    previous.value = next;
    setValue(next);
    if (previous.blocked) {
      retainedDrafts.set(scope.eventKey, { ...previous, owner: scope.owner });
      return;
    }
    try {
      // Do not silently overwrite a different window's history or a corrupt record.
      if (scope.storage.getItem(scope.storageKey) !== previous.raw) {
        previous.blocked = true;
        throw new Error("另一窗口已更新记录，本页未覆盖对方内容。请下载本页备份，再刷新页面核对。");
      }
      const raw = JSON.stringify({ version: 1, value: next });
      scope.storage.setItem(scope.storageKey, raw);
      previous.raw = raw; previous.error = ""; setError("");
      retainedDrafts.delete(scope.eventKey);
    } catch (failure) {
      previous.error = previous.blocked && failure instanceof Error ? failure.message
        : "本机记录尚未保存（空间不足或存储受限）。请下载备份，暂勿关闭或刷新。";
      retainedDrafts.set(scope.eventKey, { ...previous, owner: scope.owner });
      setError(previous.error);
    }
  }, [schema, scope]);
  const field = useCallback(<K extends keyof T>(name: K, change: SetStateAction<T[K]>) => {
    set(value => ({ ...value, [name]: typeof change === "function" ? (change as (old: T[K]) => T[K])(value[name]) : change }));
  }, [set]);
  useEffect(() => {
    const unsavedError = () => current.current.error || [...retainedDrafts.values()].find(draft => draft.owner === scope.owner)?.error;
    const protect = (event: BeforeUnloadEvent) => {
      if (!unsavedError()) return;
      event.preventDefault(); event.returnValue = "";
    };
    const signOut = (event: Event) => {
      const error = unsavedError();
      if (error) (event as CustomEvent<Promise<void>[]>).detail.push(Promise.reject(new Error(error)));
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== scope.eventKey || event.newValue === current.current.raw) return;
      current.current.blocked = true;
      current.current.error = "另一窗口已更新记录，本页保留当前内容且不覆盖。请下载本页备份，再刷新页面核对。";
      retainedDrafts.set(scope.eventKey, { ...current.current, owner: scope.owner });
      setError(current.current.error);
    };
    window.addEventListener("beforeunload", protect);
    window.addEventListener("betterme:before-sign-out", signOut);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("beforeunload", protect);
      window.removeEventListener("betterme:before-sign-out", signOut);
      window.removeEventListener("storage", changed);
    };
  }, [scope]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, value: current.current.value,
      ...(scope.blocked && scope.raw ? { unreadableOriginal: scope.raw } : {}) }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "betterme-workspace-recovery.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { value, set, field, error, restored: scope.restored, download };
}

export function useRecoveryField<T, K extends keyof T>(recovery: { value: T; field: (name: K, change: SetStateAction<T[K]>) => void }, name: K): [T[K], Dispatch<SetStateAction<T[K]>>] {
  const field = recovery.field;
  const set = useCallback<Dispatch<SetStateAction<T[K]>>>(change => field(name, change), [field, name]);
  return [recovery.value[name], set];
}
