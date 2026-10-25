import { z } from "zod";
import { DocumentSchema, LocalJsonStore, STORAGE_KEY, createInitialDocument } from "./local-json.js";
import type { BetterMeDocument } from "./types.js";
import { normalizeAutoSaveSettings, type AutoSaveSettings } from "./autosave-policy.js";
import type { DocumentFieldChange } from "./document-diff.js";
import { applyDocumentFieldChange } from "./document-field-restore.js";

export const DRAFT_STORAGE_KEY = `${STORAGE_KEY}:draft:v1`;
export const PREVIOUS_DRAFT_STORAGE_KEY = `${STORAGE_KEY}:previous-draft:v1`;
export const HISTORY_LIMIT = 50;
export const AUTO_SNAPSHOT_COALESCE_MS = 15_000;
export type VersionKind = "automatic" | "checkpoint" | "restore" | "import";
export type DocumentVersion = {
  id: string;
  createdAt: string;
  label: string;
  kind: VersionKind;
  document: BetterMeDocument;
  coalesceStartedAt?: string;
};
export interface VersionRepository {
  list(): Promise<DocumentVersion[]>;
  putAndPrune(version: DocumentVersion, limit: number): Promise<void>;
  delete(id: string): Promise<void>;
  reset?(): void;
}

/** Only input constraints are relaxed. Object/array/enum shapes remain guarded. */
function editingSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodEffects) return editingSchema(schema.innerType());
  if (schema instanceof z.ZodString) return z.string();
  if (schema instanceof z.ZodNumber) return z.union([z.number().finite(), z.nan()]);
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = editingSchema(value as z.ZodTypeAny);
    return z.object(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(editingSchema(schema.element));
  if (schema instanceof z.ZodOptional) return editingSchema(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return editingSchema(schema.unwrap()).nullable();
  if (schema instanceof z.ZodDefault) return editingSchema(schema.removeDefault()).default(schema._def.defaultValue());
  if (schema instanceof z.ZodUnion) return z.union(schema.options.map(editingSchema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  return schema;
}

export const DraftDocumentSchema = editingSchema(DocumentSchema).refine((value: BetterMeDocument) =>
  value.resumeViews.length > 0 && value.resumeViews.some((view) => view.id === value.activeResumeId),
  "草稿中的当前简历视图不存在。",
);
const DraftEnvelopeSchema = z.object({ schemaVersion: z.literal(1), savedAt: z.string().datetime(), document: DraftDocumentSchema });
const VersionSchema = z.object({ id: z.string().min(1), createdAt: z.string().datetime(), label: z.string(), kind: z.enum(["automatic", "checkpoint", "restore", "import"]), coalesceStartedAt: z.string().datetime().optional(), document: DocumentSchema });

function encodeDraft(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "number" && Number.isNaN(item) ? { $betterMeNumber: "NaN" } : item);
}
function decodeDraft(raw: string): unknown {
  return JSON.parse(raw, (_key, item) => item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 1 && item.$betterMeNumber === "NaN" ? Number.NaN : item);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function storageError(error: unknown): string {
  return error instanceof Error && error.name === "QuotaExceededError"
    ? "浏览器存储空间不足，请下载草稿并清理旧版本。"
    : "浏览器无法保存数据，请检查存储权限并下载草稿。";
}
/** Timestamps do not create noise in history. API configuration is never included. */
export function documentFingerprint(document: BetterMeDocument): string {
  return JSON.stringify(document, (key, value) => key === "updatedAt" || key === "createdAt" ? undefined : value);
}

function isConnectionClosingError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error || (typeof error === "object" && error !== null && "name" in error)) {
    const name = String((error as { name?: string }).name || "");
    const msg = String((error as { message?: string }).message || "").toLowerCase();
    return (
      name === "InvalidStateError" ||
      msg.includes("closing") ||
      msg.includes("closed") ||
      msg.includes("connection is closing")
    );
  }
  return false;
}

/** IndexedDB avoids duplicating large portrait snapshots in localStorage's small quota. */
export class IndexedDbVersionRepository implements VersionRepository {
  private database: Promise<IDBDatabase> | null = null;

  reset(): void {
    if (this.database) {
      const pending = this.database;
      this.database = null;
      void pending.then(
        (db) => {
          try {
            db.close();
          } catch {}
        },
        () => {}
      );
    }
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("浏览器未提供 IndexedDB，当前草稿仍会独立保存。"));
          return;
        }
        const request = indexedDB.open("better-me:document-history:v1", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("versions", { keyPath: "id" });
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            this.reset();
          };
          database.onclose = () => {
            this.database = null;
          };
          database.onerror = () => {
            this.database = null;
          };
          resolve(database);
        };
        request.onerror = () => {
          this.database = null;
          reject(request.error ?? new Error("版本库打开失败。"));
        };
        request.onblocked = () => {
          this.database = null;
          reject(new Error("版本库被另一标签页占用，请关闭旧页面后重试。"));
        };
      });
    }
    return this.database;
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let database: IDBDatabase;
      try {
        database = await this.open();
      } catch (err) {
        this.reset();
        throw err;
      }

      let transaction: IDBTransaction;
      try {
        transaction = database.transaction("versions", mode);
      } catch (err) {
        this.reset();
        if (attempt === 0 && isConnectionClosingError(err)) {
          continue;
        }
        throw err;
      }

      try {
        return await new Promise<T>((resolve, reject) => {
          const onError = () => {
            if (isConnectionClosingError(transaction.error)) {
              this.reset();
            }
            reject(transaction.error ?? new Error(mode === "readonly" ? "版本列表读取失败。" : "版本保存失败。"));
          };
          const onAbort = () => {
            if (isConnectionClosingError(transaction.error)) {
              this.reset();
            }
            reject(transaction.error ?? new Error(mode === "readonly" ? "版本读取被中断。" : "版本保存被中断。"));
          };

          transaction.addEventListener?.("error", onError, { once: true });
          transaction.onerror = onError;
          transaction.addEventListener?.("abort", onAbort, { once: true });
          transaction.onabort = onAbort;

          const store = transaction.objectStore("versions");
          operation(store, transaction)
            .then(resolve)
            .catch((err) => {
              try {
                transaction.abort();
              } catch {}
              reject(err);
            });
        });
      } catch (err) {
        if (attempt === 0 && isConnectionClosingError(err)) {
          this.reset();
          continue;
        }
        throw err;
      }
    }
    throw new Error("版本库操作失败，请重试。");
  }

  async list(): Promise<DocumentVersion[]> {
    return this.withStore("readonly", (store) => {
      return new Promise<DocumentVersion[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result as DocumentVersion[]) || []);
        request.onerror = () => reject(request.error ?? new Error("版本列表读取失败。"));
      });
    });
  }

  async putAndPrune(version: DocumentVersion, limit: number): Promise<void> {
    return this.withStore("readwrite", (store, transaction) => {
      return new Promise<void>((resolve, reject) => {
        store.put(clone(version));
        const request = store.getAll();
        request.onsuccess = () => {
          const versions = ((request.result as DocumentVersion[]) || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          for (const old of versions.slice(limit)) {
            store.delete(old.id);
          }
        };
        request.onerror = () => reject(request.error ?? new Error("版本保存失败。"));
        const onComplete = () => resolve();
        transaction.addEventListener?.("complete", onComplete, { once: true });
        transaction.oncomplete = onComplete;
      });
    });
  }

  async delete(id: string): Promise<void> {
    return this.withStore("readwrite", (store, transaction) => {
      return new Promise<void>((resolve, reject) => {
        const request = store.delete(id);
        request.onerror = () => reject(request.error ?? new Error("删除版本失败。"));
        const onComplete = () => resolve();
        transaction.addEventListener?.("complete", onComplete, { once: true });
        transaction.oncomplete = onComplete;
      });
    });
  }
}

export type PersistenceStatus = {
  kind: "loading" | "saved" | "draft" | "pending" | "error";
  message: string;
  savedAt?: string;
  draftSavedAt?: string;
  historyError?: string;
  recoveredDraft?: boolean;
  rawDraftRecovery?: string;
  rawOfficialRecovery?: string;
  rawPreviousDraftRecovery?: string;
  externalConflict?: boolean;
  hasPendingChanges: boolean;
};
export type PersistenceState = { doc: BetterMeDocument | null; ready: boolean; loadError: string | null; status: PersistenceStatus };

export class LocalDocumentHistory {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: VersionRepository = new IndexedDbVersionRepository()) {}

  reset(): void {
    this.repository.reset?.();
  }

  async list(): Promise<DocumentVersion[]> {
    await this.queue;
    const versions = await this.repository.list();
    return versions.map((version) => VersionSchema.parse(version) as DocumentVersion)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  append(document: BetterMeDocument, label = "自动保存", kind: VersionKind = "automatic", historyIntervalMs = AUTO_SNAPSHOT_COALESCE_MS): Promise<void> {
    const validated = DocumentSchema.parse(document) as BetterMeDocument;
    const task = this.queue.then(async () => {
      const versions = (await this.repository.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = versions[0];
      if (kind === "automatic" && latest && documentFingerprint(latest.document) === documentFingerprint(validated)) return;
      const now = new Date(Math.max(Date.now(), latest ? Date.parse(latest.createdAt) + 1 : 0));
      const coalesce = kind === "automatic" && latest?.kind === "automatic" && now.getTime() - Date.parse(latest.coalesceStartedAt ?? latest.createdAt) < historyIntervalMs;
      await this.repository.putAndPrune({
        id: coalesce ? latest.id : `version-${globalThis.crypto?.randomUUID?.() ?? `${now.getTime()}-${Math.random().toString(36).slice(2)}`}`,
        createdAt: now.toISOString(),
        coalesceStartedAt: kind === "automatic" ? coalesce ? latest.coalesceStartedAt ?? latest.createdAt : now.toISOString() : undefined,
        label: label.trim().slice(0, 100) || (kind === "checkpoint" ? "手动检查点" : "自动保存"),
        kind,
        document: clone(validated),
      }, HISTORY_LIMIT);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  delete(id: string): Promise<void> {
    const task = this.queue.then(() => this.repository.delete(id));
    this.queue = task.catch(() => undefined);
    return task;
  }
}

/** Controller is independent of React so recovery and save ordering can be verified. */
export class DocumentPersistenceController {
  readonly history: LocalDocumentHistory;
  private state: PersistenceState = { doc: null, ready: false, loadError: null, status: { kind: "loading", message: "正在读取本地简历…", hasPendingChanges: false } };
  private listeners = new Set<(state: PersistenceState) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operation = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private externalVersion: BetterMeDocument | null = null;
  private store: LocalJsonStore;
  private autoSave: AutoSaveSettings;
  private autoSaveRevision = 0;
  private persistedFingerprint: string | null = null;
  constructor(options: { history?: LocalDocumentHistory; store?: LocalJsonStore; delayMs?: number; autoSave?: AutoSaveSettings } = {}) {
    this.history = options.history ?? new LocalDocumentHistory();
    this.store = options.store ?? new LocalJsonStore();
    this.autoSave = normalizeAutoSaveSettings(options.autoSave);
    // Legacy explicit delays are used by existing consumers and timer tests.
    if (options.delayMs !== undefined && options.autoSave === undefined) {
      this.autoSave = { ...this.autoSave, enabled: true, trigger: "idle", delayMs: options.delayMs };
    }
  }
  getState(): PersistenceState { return this.state; }
  subscribe(listener: (state: PersistenceState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(patch: Partial<PersistenceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  private hasPendingChanges(document = this.state.doc): boolean {
    return document !== null && documentFingerprint(document) !== this.persistedFingerprint;
  }
  private waitingMessage(document: BetterMeDocument): string {
    const incomplete = !DocumentSchema.safeParse(document).success;
    const draft = incomplete ? "未完成草稿已在本地保护；补齐必填字段后" : "草稿已在本地保护；";
    if (!this.autoSave.enabled) return `${draft}自动保存已关闭，可手动保存完整版本`;
    if (this.autoSave.trigger === "enter") return `${draft}按回车后保存完整版本，也可手动保存`;
    if (this.autoSave.trigger === "blur") return `${draft}离开编辑字段后保存完整版本，也可手动保存`;
    return `${draft}停止编辑 ${this.autoSave.delayMs / 1_000} 秒后保存完整版本，也可手动保存`;
  }
  private scheduleAutoSave(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.autoSave.enabled && this.autoSave.trigger === "idle" && this.state.status.hasPendingChanges && !this.state.status.externalConflict) {
      this.timer = setTimeout(() => { void this.flush(); }, this.autoSave.delayMs);
    }
  }
  setAutoSaveSettings(next: AutoSaveSettings): void {
    const normalized = normalizeAutoSaveSettings(next);
    if (JSON.stringify(normalized) === JSON.stringify(this.autoSave)) return;
    // A preference change cancels scheduled work; an already started save may finish.
    ++this.autoSaveRevision;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.autoSave = normalized;
    if (this.state.doc && this.state.status.hasPendingChanges && !this.state.status.externalConflict && this.state.status.kind !== "error") {
      this.emit({ status: { ...this.state.status, kind: "draft", message: this.waitingMessage(this.state.doc) } });
    }
    this.scheduleAutoSave();
  }
  notifyAutoSaveTrigger(trigger: "enter" | "blur"): Promise<boolean> {
    if (!this.autoSave.enabled || this.autoSave.trigger !== trigger || this.state.status.externalConflict || !this.state.status.hasPendingChanges) return Promise.resolve(false);
    return this.commit(false);
  }
  async load(): Promise<void> {
    const operation = ++this.operation;
    let official: BetterMeDocument | null = null;
    let loadError: string | null = null;
    try { official = await this.store.load(); }
    catch (error) { loadError = error instanceof Error ? error.message : "本地简历读取失败，原文已保留。"; }
    if (operation !== this.operation) return;
    let draft: BetterMeDocument | null = null;
    let draftSavedAt: string | undefined;
    let rawDraftRecovery: string | undefined;
    let rawOfficialRecovery: string | undefined;
    let rawPreviousDraftRecovery: string | undefined;
    let officialSavedAt: string | undefined;
    try {
      rawPreviousDraftRecovery = localStorage.getItem(PREVIOUS_DRAFT_STORAGE_KEY) ?? undefined;
      const officialRaw = localStorage.getItem(STORAGE_KEY);
      if (loadError && officialRaw !== null) rawOfficialRecovery = officialRaw;
      if (officialRaw) {
        try { officialSavedAt = JSON.parse(officialRaw)._betterMeSavedAt; }
        catch { /* Official corruption is handled above and retained as raw recovery. */ }
      }
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw !== null) {
        try {
          const envelope = DraftEnvelopeSchema.parse(decodeDraft(raw));
          if (!officialSavedAt || Date.parse(envelope.savedAt) > Date.parse(officialSavedAt)) {
            draft = envelope.document as BetterMeDocument;
            draftSavedAt = envelope.savedAt;
          }
        } catch { rawDraftRecovery = raw; }
      }
    } catch { loadError = loadError ?? "浏览器拒绝读取草稿，请检查本地存储权限。"; }
    const doc = draft ?? official ?? (loadError ? null : createInitialDocument());
    const valid = doc ? DocumentSchema.safeParse(doc).success : false;
    this.persistedFingerprint = official ? documentFingerprint(official) : null;
    const hasPendingChanges = this.hasPendingChanges(doc);
    this.emit({ doc, ready: true, loadError: doc ? null : loadError, status: {
      kind: doc ? hasPendingChanges || !valid ? "draft" : "saved" : "error",
      message: doc && hasPendingChanges ? `${draft ? "已恢复编辑草稿。" : ""}${this.waitingMessage(doc)}` : official ? "已读取本地简历" : "本地简历已就绪",
      hasPendingChanges,
      draftSavedAt, recoveredDraft: !!draft, rawDraftRecovery, rawOfficialRecovery, rawPreviousDraftRecovery,
      historyError: loadError && doc ? `${loadError} 当前已从草稿恢复，请先下载备份。` : undefined,
    } });
    // Restored drafts become complete versions only after their configured trigger.
    const baseline = official;
    if (baseline) {
      try {
        const versions = await this.history.list();
        if (!versions[0] || documentFingerprint(versions[0].document) !== documentFingerprint(baseline)) {
          await this.history.append(baseline, "会话起点 · 上次完整版本", "checkpoint");
        }
      } catch (error) {
        if (operation === this.operation) this.emit({ status: { ...this.state.status, historyError: error instanceof Error ? error.message : "会话起点未能保存到版本库，请下载备份。" } });
      }
    }
    if (operation !== this.operation) return;
    if (doc) {
      // Preserve corrupt draft bytes until the user edits or restores explicitly.
      if (!rawDraftRecovery && (!draft || !official)) {
        const protection = this.writeDraft(doc);
        this.emit({ status: protection.kind === "error"
          ? protection
          : { ...this.state.status, draftSavedAt: protection.draftSavedAt } });
      }
      if (!loadError) this.scheduleAutoSave();
    }
  }
  private writeDraft(next: BetterMeDocument): PersistenceStatus {
    try {
      let timestamp = Date.now();
      const officialRaw = localStorage.getItem(STORAGE_KEY);
      if (officialRaw) {
        try {
          const officialTimestamp = Date.parse(JSON.parse(officialRaw)._betterMeSavedAt);
          if (Number.isFinite(officialTimestamp)) timestamp = Math.max(timestamp, officialTimestamp + 1);
        } catch { /* A protected draft can coexist with corrupt official bytes. */ }
      }
      const now = new Date(timestamp).toISOString();
      const safeDraft = DraftDocumentSchema.parse(next) as BetterMeDocument;
      localStorage.setItem(DRAFT_STORAGE_KEY, encodeDraft({ schemaVersion: 1, savedAt: now, document: safeDraft }));
      return { ...this.state.status, kind: "draft", message: this.waitingMessage(next), hasPendingChanges: this.hasPendingChanges(next), draftSavedAt: now, rawDraftRecovery: undefined };
    } catch (error) {
      return { ...this.state.status, kind: "error", hasPendingChanges: this.hasPendingChanges(next), message: `${storageError(error)} 当前编辑仅在页面内，离开会丢失。` };
    }
  }
  update(next: BetterMeDocument): void {
    ++this.operation;
    clearTimeout(this.timer);
    const status = this.writeDraft(next);
    const conflict = this.state.status.externalConflict;
    const unchanged = !status.hasPendingChanges && status.kind !== "error";
    this.emit({ doc: next, status: conflict ? { ...status, kind: "error", hasPendingChanges: true, externalConflict: true, message: "另一窗口修改了这份简历。当前编辑草稿已保护；自动保存仍暂停，请手动保存以采用当前窗口内容。" } : unchanged ? { ...status, kind: "saved", message: "内容与已保存版本一致" } : status });
    this.scheduleAutoSave();
  }
  private async writeOfficial(document: BetterMeDocument, operation: number, autoSaveRevision?: number): Promise<boolean> {
    const task = this.saveQueue.then(async () => {
      if (operation !== this.operation || autoSaveRevision !== undefined && autoSaveRevision !== this.autoSaveRevision) return false;
      await this.store.save(document);
      return operation === this.operation;
    });
    this.saveQueue = task.catch(() => undefined);
    return task;
  }
  handleStorageChange(key: string | null, raw: string | null): void {
    if (key !== null && key !== STORAGE_KEY && key !== DRAFT_STORAGE_KEY) return;
    const current = this.state.doc;
    if (!current || !this.state.ready) return;
    try {
      const incoming = key === DRAFT_STORAGE_KEY
        ? DraftEnvelopeSchema.parse(decodeDraft(raw ?? "null")).document as BetterMeDocument
        : DocumentSchema.parse(JSON.parse(raw ?? "null")) as BetterMeDocument;
      if (documentFingerprint(incoming) === documentFingerprint(current)) return;
      const validIncoming = DocumentSchema.safeParse(incoming);
      this.externalVersion = validIncoming.success ? validIncoming.data as BetterMeDocument : null;
    } catch { /* Removed or damaged data in another tab is also a real conflict. */ }
    ++this.operation;
    clearTimeout(this.timer);
    let rawPreviousDraftRecovery = this.state.status.rawPreviousDraftRecovery;
    let protectedCurrent = false;
    try {
      rawPreviousDraftRecovery = encodeDraft({ schemaVersion: 1, savedAt: new Date().toISOString(), document: DraftDocumentSchema.parse(current) });
      localStorage.setItem(PREVIOUS_DRAFT_STORAGE_KEY, rawPreviousDraftRecovery);
      protectedCurrent = true;
    } catch { /* The page remains available for downloading even when storage fails. */ }
    this.emit({ status: {
      ...this.state.status, kind: "error", externalConflict: true, rawPreviousDraftRecovery,
      hasPendingChanges: true,
      message: `另一窗口修改了这份简历。当前窗口的内容${protectedCurrent ? "已另存为切换前草稿" : "仍在页面内，请先下载备份"}。自动保存已暂停；主动保存会采用当前窗口内容。`,
    } });
  }
  private async protectExternalVersion(operation: number): Promise<boolean> {
    const external = this.externalVersion;
    if (!external) return true;
    try {
      await this.history.append(external, "另一窗口 · 完整版本", "checkpoint");
      if (this.externalVersion === external) this.externalVersion = null;
      return operation === this.operation;
    } catch (error) {
      if (operation === this.operation) this.emit({ status: { ...this.state.status, kind: "error", externalConflict: true, message: "无法保护另一窗口的完整版本，当前内容尚未覆盖本地数据。请先下载备份。", historyError: error instanceof Error ? error.message : "版本保护失败。" } });
      return false;
    }
  }
  async flush(force = false): Promise<boolean> {
    // Lifecycle callers must not bypass an explicit Enter/field-exit policy.
    if (!force && (!this.autoSave.enabled || this.autoSave.trigger !== "idle")) return false;
    return this.commit(force);
  }
  private async commit(force: boolean): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state.status.externalConflict && !force) return false;
    if (!force && !this.state.status.hasPendingChanges) return false;
    if (force && this.state.status.externalConflict) this.emit({ status: { ...this.state.status, externalConflict: false } });
    const next = this.state.doc;
    if (!next) return false;
    const operation = ++this.operation;
    const autoSaveRevision = force ? undefined : this.autoSaveRevision;
    const parsed = DocumentSchema.safeParse(next);
    if (!parsed.success) {
      const status = this.writeDraft(next);
      this.emit({ status: status.kind === "error" ? status : { ...status, kind: "draft", message: `未完成草稿已在本地保护；请补齐姓名、邮箱或日期，再${force ? "手动保存完整版本" : this.autoSave.trigger === "enter" ? "按回车保存完整版本" : this.autoSave.trigger === "blur" ? "离开编辑字段以保存完整版本" : "停止编辑以保存完整版本"}` } });
      return false;
    }
    try {
      if (!await this.protectExternalVersion(operation)) return false;
      if (!await this.writeOfficial(parsed.data as BetterMeDocument, operation, autoSaveRevision)) return false;
      this.persistedFingerprint = documentFingerprint(parsed.data as BetterMeDocument);
      const savedAt = new Date().toISOString();
      const draftStatus = this.writeDraft(next);
      this.emit({ status: { ...draftStatus, kind: "saved", hasPendingChanges: false, message: force ? "所有修改已手动保存" : "所有修改已自动保存", savedAt, historyError: draftStatus.kind === "error" ? "完整版本已保存；草稿保护失败，请检查存储空间。" : draftStatus.historyError } });
      try { await this.history.append(parsed.data as BetterMeDocument, force ? "手动保存" : "自动保存", "automatic", this.autoSave.historyIntervalMs); }
      catch (error) {
        if (operation === this.operation) this.emit({ status: { ...this.state.status, historyError: error instanceof Error ? error.message : "版本保存失败，请下载备份。" } });
        return true;
      }
      if (operation === this.operation && this.state.status.historyError && draftStatus.kind !== "error") this.emit({ status: { ...this.state.status, historyError: undefined } });
      return true;
    } catch (error) {
      if (operation === this.operation) {
        const protectedDraft = this.writeDraft(next);
        this.emit({ status: { ...protectedDraft, kind: "error", message: protectedDraft.kind === "error" ? protectedDraft.message : `${storageError(error)} 编辑草稿已保留，完整版本未更新。` } });
      }
      return false;
    }
  }
  async replace(next: BetterMeDocument, label = "导入简历", kind: VersionKind = "import"): Promise<boolean> {
    clearTimeout(this.timer);
    const operation = ++this.operation;
    const parsed = DocumentSchema.safeParse(next);
    if (!parsed.success) {
      this.emit({ status: { ...this.state.status, kind: "error", message: "目标版本存在未完成或无效字段，当前简历未被替换。" } });
      return false;
    }
    if (this.state.status.externalConflict) this.emit({ status: { ...this.state.status, externalConflict: false } });
    try {
      const previous = this.state.doc;
      if (previous && documentFingerprint(previous) !== documentFingerprint(parsed.data as BetterMeDocument)) {
        const validPrevious = DocumentSchema.safeParse(previous);
        if (validPrevious.success) {
          try { await this.history.append(validPrevious.data as BetterMeDocument, "切换前 · 当前编辑", "checkpoint"); }
          catch (error) {
            if (operation === this.operation) this.emit({ status: { ...this.state.status, kind: "error", message: "无法保护切换前版本，当前简历未被替换。请先下载备份。", historyError: error instanceof Error ? error.message : "版本库保存失败。" } });
            return false;
          }
        } else {
          // An unfinished draft must not be promoted into a validated history version.
          const rawPrevious = encodeDraft({ schemaVersion: 1, savedAt: new Date().toISOString(), document: DraftDocumentSchema.parse(previous) });
          localStorage.setItem(PREVIOUS_DRAFT_STORAGE_KEY, rawPrevious);
          if (operation === this.operation) this.emit({ status: { ...this.state.status, rawPreviousDraftRecovery: rawPrevious } });
        }
      }
      // Official storage is atomic. Failure leaves both the editor and protected draft intact.
      if (!await this.protectExternalVersion(operation)) return false;
      if (!await this.writeOfficial(parsed.data as BetterMeDocument, operation)) return false;
      this.persistedFingerprint = documentFingerprint(parsed.data as BetterMeDocument);
      const draftStatus = this.writeDraft(parsed.data as BetterMeDocument);
      this.emit({ doc: parsed.data as BetterMeDocument, loadError: null, status: { ...draftStatus, kind: "saved", hasPendingChanges: false, message: "已保存为新的当前版本", savedAt: new Date().toISOString(), historyError: draftStatus.kind === "error" ? "完整版本已保存；草稿保护失败，请检查存储空间。" : undefined } });
      try { await this.history.append(parsed.data as BetterMeDocument, label, kind); }
      catch (error) {
        if (operation === this.operation) this.emit({ status: { ...this.state.status, historyError: error instanceof Error ? error.message : "版本保存失败。" } });
      }
      return true;
    } catch (error) {
      if (operation === this.operation) this.emit({ status: { ...this.state.status, kind: "error", message: `${storageError(error)} 当前简历未被替换。` } });
      return false;
    }
  }
  /** Restore a single compared field against the current editor, never a stale whole document. */
  async restoreField(change: DocumentFieldChange, label = "恢复单项差异"): Promise<boolean> {
    const previous = this.state.doc;
    if (!this.state.ready || !previous) throw new Error("当前简历尚未就绪，请稍后重新比较。");
    // A field restore is not consent to overwrite another window's document.
    if (this.state.status.externalConflict) throw new Error("另一窗口修改了这份简历。请先处理窗口冲突，再重新比较并恢复单项差异；当前内容未被覆盖。");
    const applied = applyDocumentFieldChange(previous, change);
    if (!applied.ok) throw new Error(applied.message);
    const draft = DraftDocumentSchema.safeParse(applied.document);
    if (!draft.success) throw new Error("单项恢复后的草稿结构无效，当前编辑未被修改。");
    const next = draft.data as BetterMeDocument;
    const validNext = DocumentSchema.safeParse(next);
    const validPrevious = DocumentSchema.safeParse(previous);
    clearTimeout(this.timer);
    this.timer = undefined;
    const operation = ++this.operation;
    const assertCurrent = () => {
      if (operation !== this.operation || this.state.status.externalConflict) {
        throw new Error("当前编辑或其他窗口的数据已变化，未继续应用该项恢复。请重新比较后再操作。");
      }
    };
    const fail = (message: string, historyError?: string): never => {
      if (operation === this.operation) {
        this.emit({ status: { ...this.state.status, kind: "error", message, ...(historyError ? { historyError } : {}) } });
      }
      throw new Error(message);
    };

    // A complete current editor must have an undo snapshot before replacement.
    // Incomplete inputs retain their exact draft form, including NaN, separately.
    try {
      if (validPrevious.success) {
        await this.history.append(validPrevious.data as BetterMeDocument, "单项恢复前 · 当前编辑", "checkpoint");
        assertCurrent();
      } else {
        const rawPrevious = encodeDraft({ schemaVersion: 1, savedAt: new Date().toISOString(), document: DraftDocumentSchema.parse(previous) });
        localStorage.setItem(PREVIOUS_DRAFT_STORAGE_KEY, rawPrevious);
        assertCurrent();
        this.emit({ status: { ...this.state.status, rawPreviousDraftRecovery: rawPrevious } });
      }
    } catch (error) {
      if (operation !== this.operation || this.state.status.externalConflict) throw error;
      fail("无法保护恢复前的当前编辑，该项尚未恢复。请先下载备份或检查本地存储。", error instanceof Error ? error.message : "恢复前快照保存失败。");
    }
    assertCurrent();
    const adjustmentNotice = applied.adjustments.length ? ` ${applied.adjustments.join("；")}` : "";

    if (!validNext.success) {
      const status = this.writeDraft(next);
      if (status.kind === "error") fail(`${status.message} 该项尚未恢复，当前编辑仍保留。`);
      this.emit({ doc: next, status: { ...status, kind: "draft", hasPendingChanges: this.hasPendingChanges(next), message: `该项已恢复并保存为本地草稿；其他未完成字段仍保留，尚未生成完整版本。${adjustmentNotice}` } });
      return true;
    }

    try {
      // LocalJsonStore writes synchronously inside its Promise. Custom async
      // stores retain writeOfficial's existing ordering and cancellation bounds.
      if (!await this.writeOfficial(validNext.data as BetterMeDocument, operation)) {
        assertCurrent();
        fail("该项尚未保存，请重新比较后再恢复。当前编辑仍保留。");
      }
    } catch (error) {
      if (operation !== this.operation || this.state.status.externalConflict) throw error;
      fail(`${storageError(error)} 该项尚未恢复，当前编辑仍保留。`);
    }
    assertCurrent();
    const complete = validNext.data as BetterMeDocument;
    this.persistedFingerprint = documentFingerprint(complete);
    const draftStatus = this.writeDraft(complete);
    this.emit({ doc: complete, loadError: null, status: {
      ...draftStatus, kind: "saved", hasPendingChanges: false,
      message: `该项已恢复并保存，其余当前编辑已保留。${adjustmentNotice}`,
      savedAt: new Date().toISOString(),
      historyError: draftStatus.kind === "error" ? "完整版本已保存；草稿保护失败，请检查存储空间。" : undefined,
    } });
    try {
      await this.history.append(complete, label, "restore");
    } catch (error) {
      if (operation === this.operation) this.emit({ status: {
        ...this.state.status,
        historyError: `该项已保存，但恢复结果快照未保存。恢复前内容已保护，可从“单项恢复前 · 当前编辑”快照或切换前草稿撤回。${error instanceof Error ? ` ${error.message}` : ""}`,
      } });
    }
    return true;
  }
  async checkpoint(label: string): Promise<boolean> {
    const next = this.state.doc;
    if (!next) return false;
    const operation = this.operation;
    if (!await this.flush(true)) return false;
    // flush changes its own operation once; a subsequent edit cancels this checkpoint.
    if (this.operation !== operation + 1) return false;
    try {
      await this.history.append(next, label, "checkpoint");
      return true;
    } catch (error) {
      this.emit({ status: { ...this.state.status, historyError: error instanceof Error ? error.message : "检查点保存失败。" } });
      return false;
    }
  }
  cancelPending(): void { clearTimeout(this.timer); }
  dispose(): void { clearTimeout(this.timer); this.listeners.clear(); }
}

export function describeDocumentChanges(before: BetterMeDocument, after: BetterMeDocument): string[] {
  const changes: string[] = [];
  const oldProfile = before.factBase.profile;
  const newProfile = after.factBase.profile;
  const profileLabels: Record<string, string> = { displayName: "姓名", headline: "职位", email: "邮箱", phone: "电话", avatarUrl: "照片", education: "学历", location: "所在地", links: "个人链接", traits: "优势", targetRoles: "目标岗位" };
  for (const key of new Set([...Object.keys(oldProfile), ...Object.keys(newProfile)])) {
    if (JSON.stringify(oldProfile[key as keyof typeof oldProfile]) !== JSON.stringify(newProfile[key as keyof typeof newProfile])) changes.push(profileLabels[key] ?? "个人信息");
  }
  const oldExperiences = before.factBase.experiences;
  const newExperiences = after.factBase.experiences;
  if (documentFingerprint({ ...before, factBase: { ...before.factBase, experiences: newExperiences } }) !== documentFingerprint(before)) {
    const beforeClaims = oldExperiences.reduce((sum, item) => sum + item.claims.length, 0);
    const afterClaims = newExperiences.reduce((sum, item) => sum + item.claims.length, 0);
    changes.push(`经历 / 要点（${oldExperiences.length} → ${newExperiences.length} 段，${beforeClaims} → ${afterClaims} 条）`);
  }
  if (documentFingerprint({ ...before, resumeViews: after.resumeViews }) !== documentFingerprint(before)) changes.push("简历模板、布局或展示设置");
  if (before.activeResumeId !== after.activeResumeId) changes.push("当前简历");
  return [...new Set(changes)];
}
