import {
  createDemoFactBase,
  createDefaultResumeView,
} from "@better-me/core";
import { DocumentSchema } from "@better-me/core/document";
import type { BetterMeDocument, DocumentStore } from "./types.js";

export const STORAGE_KEY = "better-me:document:v1";

export class StoredDocumentError extends Error {
  constructor() {
    super("本地简历数据无法读取。原始数据已保留，请先下载原始数据或恢复有效备份。");
    this.name = "StoredDocumentError";
  }
}

/** V1 web adapter: structured JSON in localStorage (SQLite/OPFS later behind same port). */
export class LocalJsonStore implements DocumentStore {
  constructor(private readonly key = STORAGE_KEY, private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = globalThis.localStorage) {}

  async load(): Promise<BetterMeDocument | null> {
    if (!this.storage) return null;
    const raw = this.storage.getItem(this.key);
    if (raw === null) return null;
    try {
      return DocumentSchema.parse(JSON.parse(raw)) as BetterMeDocument;
    } catch {
      throw new StoredDocumentError();
    }
  }

  async save(doc: BetterMeDocument): Promise<void> {
    const validated = DocumentSchema.parse(doc);
    // Internal commit time keeps a failed/older draft from superseding a newer import.
    // It is stripped by DocumentSchema and never appears in exported JSON backups.
    let newest = Date.now();
    for (const key of [this.key, `${this.key}:draft:v1`]) {
      const raw = this.storage.getItem(key);
      if (raw) {
        try {
          const previous = JSON.parse(raw);
          const timestamp = Date.parse(key === this.key ? previous._betterMeSavedAt : previous.savedAt);
          if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp + 1);
        } catch { /* Keep corrupt bytes until a deliberate, validated save. */ }
      }
    }
    this.storage.setItem(this.key, JSON.stringify({ ...validated, _betterMeSavedAt: new Date(newest).toISOString() }));
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}

export { DocumentSchema };

export function exportDocumentJson(doc: BetterMeDocument): string {
  const validated = DocumentSchema.parse(doc);
  return JSON.stringify(validated, null, 2);
}

export function parseDocumentJson(jsonString: string): BetterMeDocument {
  const parsed = JSON.parse(jsonString);
  return DocumentSchema.parse(parsed) as BetterMeDocument;
}

export function createInitialDocument(
  now = new Date().toISOString(),
): BetterMeDocument {
  const factBase = createDemoFactBase(now);
  const resume = createDefaultResumeView(factBase, now);
  return {
    documentId: crypto.randomUUID(),
    factBase,
    resumeViews: [resume],
    activeResumeId: resume.id,
  };
}
