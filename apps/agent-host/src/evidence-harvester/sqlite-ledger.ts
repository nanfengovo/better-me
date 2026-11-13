import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarvesterError, HarvesterStateSchema, type HarvesterLedger, type HarvesterState } from "./types.js";

/** Owner-private acquisition ledger. SQLite's transaction, not a read/write
 * JSON revision convention, serializes writers across processes. */
export class SqliteHarvesterLedger implements HarvesterLedger {
  private readonly db: DatabaseSync;
  private closed = false;
  private inTransaction = false;
  constructor(readonly ownerId: string, directory: string) {
    if (!ownerId || ownerId.length > 200 || !path.isAbsolute(directory)) throw new HarvesterError("invalid_harvester_store");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.normalize(directory)) throw new HarvesterError("unsafe_harvester_store");
    const filename = path.join(directory, "acquisition.sqlite");
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, "wx", 0o600));
    const file = fs.lstatSync(filename);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) throw new HarvesterError("unsafe_harvester_store");
    this.db = new DatabaseSync(filename, { allowExtension: false });
    try {
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS acquisition_state (id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, payload TEXT NOT NULL);");
      const existing = this.db.prepare("SELECT owner_id FROM acquisition_state WHERE id=1").get();
      if (existing && existing["owner_id"] !== ownerId) throw new HarvesterError("harvester_store_owner_mismatch");
      if (!existing) this.db.prepare("INSERT INTO acquisition_state(id,owner_id,payload) VALUES(1,?,?)").run(ownerId, JSON.stringify({ version: 1, revision: 0, ownerId, subscriptions: [], entries: [], operations: {} }));
      this.read();
    } catch (error) { this.db.close(); throw error; }
  }

  read(): HarvesterState {
    if (this.closed) throw new HarvesterError("harvester_store_closed");
    const row = this.db.prepare("SELECT owner_id,payload FROM acquisition_state WHERE id=1").get();
    if (!row || row["owner_id"] !== this.ownerId || typeof row["payload"] !== "string" || Buffer.byteLength(row["payload"]) > 16_000_000) throw new HarvesterError("invalid_harvester_state");
    const state = HarvesterStateSchema.parse(JSON.parse(row["payload"]));
    if (state.ownerId !== this.ownerId) throw new HarvesterError("harvester_store_owner_mismatch");
    return state;
  }

  transact<T>(mutate: (state: HarvesterState) => T): T {
    if (this.closed || this.inTransaction) throw new HarvesterError("harvester_store_unavailable");
    this.inTransaction = true;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const state = this.read();
      const original = JSON.stringify(state);
      const result = mutate(state);
      if (result instanceof Promise) throw new HarvesterError("async_harvester_transaction_denied");
      if (JSON.stringify(state) !== original) {
        state.revision++;
        const payload = JSON.stringify(HarvesterStateSchema.parse(state));
        if (Buffer.byteLength(payload) > 16_000_000) throw new HarvesterError("harvester_store_capacity");
        this.db.prepare("UPDATE acquisition_state SET payload=? WHERE id=1 AND owner_id=?").run(payload, this.ownerId);
      }
      this.db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* BEGIN may not have acquired a writer. */ } throw error; }
    finally { this.inTransaction = false; }
  }

  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
