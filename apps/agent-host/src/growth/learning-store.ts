import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CareerTaskAccess } from "../kernel/service.js";
import { privateDirectory } from "../identity/private-json.js";
import { GrowthJourneyError } from "./service.js";

export function learningFail(code: string, status = 409): never {
  throw new GrowthJourneyError(code, status);
}

/** A lifetime writer lease and a separately committed database: a Host crash
 * releases the lease without rolling back the user's last saved document. */
export class LearningStore {
  private lease?: DatabaseSync;
  private database?: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private revoked = new Set<string>();
  constructor(
    readonly ownerId: string,
    readonly directory: string,
  ) {
    if (
      !ownerId ||
      !path.isAbsolute(directory) ||
      path.dirname(directory) === directory
    )
      learningFail("learning_invalid_store", 503);
  }
  async assert(access: CareerTaskAccess) {
    if (this.closed) learningFail("learning_closed", 503);
    if (
      !access ||
      this.revoked.has(access.session) ||
      !(await access.valid()) ||
      this.revoked.has(access.session)
    )
      learningFail("learning_access_invalid", 403);
  }
  private async file(name: string) {
    const file = path.join(this.directory, name);
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      learningFail("learning_unsafe_store", 503);
    return file;
  }
  private async open() {
    if (this.database) return;
    await privateDirectory(this.directory);
    const lease = new DatabaseSync(await this.file("writer.sqlite"), {
      allowExtension: false,
    });
    try {
      lease.exec(
        "PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
      );
      lease
        .prepare("INSERT OR IGNORE INTO owner VALUES(1,?)")
        .run(this.ownerId);
      if (
        lease.prepare("SELECT value FROM owner WHERE id=1").get()?.value !==
        this.ownerId
      )
        learningFail("learning_owner_mismatch", 403);
      lease.exec("COMMIT; BEGIN EXCLUSIVE");
      const database = new DatabaseSync(await this.file("learning.sqlite"), {
        allowExtension: false,
      });
      try {
        database.exec(
          "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, body TEXT NOT NULL, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS paths(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)",
        );
        database.exec("CREATE TABLE IF NOT EXISTS translations(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS translation_artifacts(job_id TEXT NOT NULL, kind TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(job_id,kind))");
        database
          .prepare("INSERT OR IGNORE INTO owner VALUES(1,?)")
          .run(this.ownerId);
        if (
          database.prepare("SELECT value FROM owner WHERE id=1").get()
            ?.value !== this.ownerId
        )
          learningFail("learning_owner_mismatch", 403);
        this.lease = lease;
        this.database = database;
      } catch (error) {
        database.close();
        throw error;
      }
    } catch (error) {
      lease.close();
      if (error instanceof GrowthJourneyError) throw error;
      learningFail("learning_single_writer_required", 503);
    }
  }
  run<T>(
    access: CareerTaskAccess,
    operation: (database: DatabaseSync) => Promise<T> | T,
  ): Promise<T> {
    const execute = async () => {
      await this.assert(access);
      await this.open();
      const value = await operation(this.database!);
      await this.assert(access);
      return value;
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.catch(() => undefined);
    return result;
  }
  invalidate(session: string) {
    this.revoked.add(session);
  }
  async close() {
    this.closed = true;
    await this.queue;
    this.database?.close();
    this.lease?.close();
    this.database = undefined;
    this.lease = undefined;
  }
}
