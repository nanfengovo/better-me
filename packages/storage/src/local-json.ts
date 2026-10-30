import {
  FactBaseSchema,
  ResumeViewSchema,
  createDemoFactBase,
  createDefaultResumeView,
} from "@better-me/core";
import { z } from "zod";
import type { BetterMeDocument, DocumentStore } from "./types.js";

export const STORAGE_KEY = "better-me:document:v1";

const DocumentSchema = z.object({
  documentId: z.string().min(1).max(200).optional(),
  factBase: FactBaseSchema,
  resumeViews: z.array(ResumeViewSchema).min(1),
  activeResumeId: z.string().min(1),
}).refine((doc) => doc.resumeViews.some((view) => view.id === doc.activeResumeId), {
  message: "当前简历视图不存在，请检查备份中的 activeResumeId。",
  path: ["activeResumeId"],
});

export class StoredDocumentError extends Error {
  constructor() {
    super("本地简历数据无法读取。原始数据已保留，请先下载原始数据或恢复有效备份。");
    this.name = "StoredDocumentError";
  }
}

/** V1 web adapter: structured JSON in localStorage (SQLite/OPFS later behind same port). */
export class LocalJsonStore implements DocumentStore {
  constructor(private readonly key = STORAGE_KEY) {}

  async load(): Promise<BetterMeDocument | null> {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(this.key);
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
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          const previous = JSON.parse(raw);
          const timestamp = Date.parse(key === this.key ? previous._betterMeSavedAt : previous.savedAt);
          if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp + 1);
        } catch { /* Keep corrupt bytes until a deliberate, validated save. */ }
      }
    }
    localStorage.setItem(this.key, JSON.stringify({ ...validated, _betterMeSavedAt: new Date(newest).toISOString() }));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
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
