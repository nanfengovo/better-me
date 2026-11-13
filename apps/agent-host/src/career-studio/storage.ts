import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export class StudioError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); this.name = "StudioError"; } }
export const studioHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/);
export type StudioRecord<T = unknown> = { kind: string; id: string; revision: number; hash: string; value: T; updatedAt: string };

/** Private, owner-bound derived artifacts. This is not a second Fact/Resume/Job
 * database or a task scheduler. Source and business writes remain elsewhere.
 * No MemorySaver fallback: failure to open/persist is explicitly unavailable. */
export class StudioArtifactStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(readonly ownerId: string, directory: string) {
    if (!ownerId || ownerId.length > 240 || !path.isAbsolute(directory)) throw new StudioError("invalid_studio_store", 503);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== path.normalize(directory)) throw new StudioError("unsafe_studio_store", 503);
    const file = path.join(directory, "artifacts.sqlite");
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "wx", 0o600));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new StudioError("unsafe_studio_store", 503);
    this.db = new DatabaseSync(file, { allowExtension: false });
    try {
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS studio_owner(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL); CREATE TABLE IF NOT EXISTS artifacts(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));");
      this.db.prepare("INSERT OR IGNORE INTO studio_owner(id,owner) VALUES(1,?)").run(ownerId);
      if (this.db.prepare("SELECT owner FROM studio_owner WHERE id=1").get()?.["owner"] !== ownerId) throw new StudioError("studio_owner_mismatch", 403);
    } catch (error) { this.db.close(); throw error; }
  }
  get<T = unknown>(kind: string, id: string): StudioRecord<T> | undefined {
    if (this.closed) throw new StudioError("studio_store_closed", 503);
    keySchema.parse(kind); keySchema.parse(id);
    const row = this.db.prepare("SELECT revision,hash,payload,updated_at FROM artifacts WHERE kind=? AND id=?").get(kind, id);
    if (!row) return;
    if (typeof row["payload"] !== "string" || typeof row["revision"] !== "number" || typeof row["hash"] !== "string" || typeof row["updated_at"] !== "string") throw new StudioError("invalid_studio_artifact", 503);
    const value = JSON.parse(row["payload"]) as T;
    if (studioHash(value) !== row["hash"]) throw new StudioError("studio_artifact_hash_mismatch", 503);
    return { kind, id, revision: row["revision"], hash: row["hash"], value, updatedAt: row["updated_at"] };
  }
  list<T = unknown>(kind: string, limit = 200): StudioRecord<T>[] {
    if (this.closed) throw new StudioError("studio_store_closed", 503);
    keySchema.parse(kind);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new StudioError("invalid_studio_list_limit", 400);
    const rows = this.db.prepare("SELECT id FROM artifacts WHERE kind=? ORDER BY updated_at DESC,id LIMIT ?").all(kind, limit);
    return rows.map(row => this.get<T>(kind, String(row["id"]))!);
  }
  /** Monotone within a kind (artifacts are never deleted). Read under a write
   * transaction when it guards a cross-record publication decision. */
  kindRevision(kind: string): number {
    if (this.closed) throw new StudioError("studio_store_closed", 503);
    keySchema.parse(kind);
    const revision = Number(this.db.prepare("SELECT COALESCE(SUM(revision),0) AS revision FROM artifacts WHERE kind=?").get(kind)?.["revision"]);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new StudioError("invalid_studio_kind_revision", 503);
    return revision;
  }
  put<T>(kind: string, id: string, expectedRevision: number, value: T, guards: readonly { kind: string; revision: number }[] = []): StudioRecord<T> {
    if (this.closed) throw new StudioError("studio_store_closed", 503);
    keySchema.parse(kind); keySchema.parse(id);
    if (guards.length > 8 || guards.some(guard => !keySchema.safeParse(guard.kind).success || !Number.isSafeInteger(guard.revision) || guard.revision < 0)) throw new StudioError("invalid_studio_write_guard", 400);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new StudioError("invalid_studio_revision", 400);
    const payload = JSON.stringify(value);
    if (!payload || Buffer.byteLength(payload) > 8_000_000) throw new StudioError("studio_artifact_too_large", 413);
    const record = { kind, id, revision: expectedRevision + 1, hash: studioHash(value), value: JSON.parse(payload) as T, updatedAt: new Date().toISOString() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const guard of guards) if (this.kindRevision(guard.kind) !== guard.revision) throw new StudioError("studio_guard_revision_conflict");
      const previous = this.get(kind, id);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new StudioError("studio_revision_conflict");
      if (!previous && Number(this.db.prepare("SELECT count(*) AS count FROM artifacts").get()?.["count"]) >= 10_000) throw new StudioError("studio_store_capacity", 413);
      this.db.prepare("INSERT INTO artifacts(kind,id,revision,hash,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,payload=excluded.payload,updated_at=excluded.updated_at").run(kind, id, record.revision, record.hash, payload, record.updatedAt);
      this.db.exec("COMMIT"); return structuredClone(record);
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* BEGIN failure owns no transaction */ } throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
