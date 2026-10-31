import { CoachStateSchema, type CoachState } from "./types";
import { createCoachState } from "./state";

export class CoachStorageConflict extends Error {
  constructor() { super("另一窗口已修改成长记录。本页内容未覆盖对方记录，请先下载备份，再读取已保存版本。"); this.name = "CoachStorageConflict"; }
}
export interface CoachRepository {
  load(workspaceKey: string): Promise<CoachState | undefined>;
  save(state: CoachState, expectedRevision: number): Promise<void>;
  /** Clear user content while retaining a monotonically increasing scope revision. */
  clear(workspaceKey: string, expectedRevision: number): Promise<void>;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validate(raw: unknown, key: string): CoachState | undefined {
  if (raw === undefined) return undefined;
  const parsed = CoachStateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.workspaceKey !== key) throw new Error("成长记录格式不兼容或损坏；原始数据未覆盖。请保留浏览器数据并检查备份。");
  return parsed.data;
}
function assertRevision(current: CoachState | undefined, expected: number) {
  if ((current?.revision ?? 0) !== expected) throw new CoachStorageConflict();
}

/** Test/in-memory adapter. Production uses the independent IndexedDB store below. */
export function createMemoryCoachRepository(): CoachRepository {
  const entries = new Map<string, CoachState>();
  return {
    async load(key) { const current = entries.get(key); return current ? clone(current) : undefined; },
    async save(next, expected) {
      assertRevision(entries.get(next.workspaceKey), expected);
      if (next.revision !== expected + 1) throw new CoachStorageConflict();
      entries.set(next.workspaceKey, clone(CoachStateSchema.parse(next)));
    },
    async clear(key, expected) {
      assertRevision(entries.get(key), expected);
      entries.set(key, { ...createCoachState(key), revision: expected + 1 });
    },
  };
}

/** Atomic revision checks prevent a stale browser tab overwriting another tab. */
export class IndexedDbCoachRepository implements CoachRepository {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("浏览器未提供 IndexedDB；当前成长内容仅在本页，请下载备份。")); return; }
        const request = indexedDB.open("better-me:career-coach:v1", 1);
        const timer = setTimeout(() => reject(new Error("成长记录库打开超时；请下载当前备份后重试。")), 5000);
        request.onupgradeneeded = () => { request.result.createObjectStore("workspaces", { keyPath: "workspaceKey" }); };
        request.onsuccess = () => { clearTimeout(timer); const db = request.result; db.onversionchange = () => { db.close(); this.database = undefined; }; resolve(db); };
        request.onerror = () => { clearTimeout(timer); reject(new Error("无法打开成长记录库；请检查浏览器存储权限并下载备份。")); };
        request.onblocked = () => { clearTimeout(timer); reject(new Error("成长记录库被其他旧页面阻塞；请先备份再重试。")); };
      }).catch((error: unknown) => { this.database = undefined; throw error; });
    }
    return this.database;
  }
  async load(key: string): Promise<CoachState | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("workspaces", "readonly");
      const request = transaction.objectStore("workspaces").get(key);
      request.onsuccess = () => { try { resolve(validate(request.result, key)); } catch (error) { reject(error); } };
      request.onerror = () => reject(new Error("读取成长记录失败；不会覆盖已有记录。"));
      transaction.onabort = () => reject(new Error("读取成长记录被中断。"));
    });
  }
  private async write(key: string, expected: number, next: CoachState): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let failure: unknown;
      const transaction = db.transaction("workspaces", "readwrite");
      const store = transaction.objectStore("workspaces");
      const request = store.get(key);
      request.onsuccess = () => {
        try { assertRevision(validate(request.result, key), expected); store.put(next); }
        catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(failure ?? new Error("成长记录未能保存，可能是空间不足或存储权限受限；请下载备份，勿关闭本页。"));
    });
  }
  async save(state: CoachState, expectedRevision: number): Promise<void> {
    const next = CoachStateSchema.parse(state);
    if (next.revision !== expectedRevision + 1) throw new CoachStorageConflict();
    if (JSON.stringify(next).length > 3_000_000) throw new Error("成长记录超过本版 3 MB 保存上限，请下载备份；已有记录未被删除。");
    return this.write(next.workspaceKey, expectedRevision, next);
  }
  async clear(key: string, expectedRevision: number): Promise<void> {
    // A deleted key would reset its CAS revision to zero and let an old tab
    // resurrect pre-clear content once another record reaches the same revision.
    return this.write(key, expectedRevision, { ...createCoachState(key), revision: expectedRevision + 1 });
  }
}
export const defaultCoachRepository: CoachRepository = new IndexedDbCoachRepository();
