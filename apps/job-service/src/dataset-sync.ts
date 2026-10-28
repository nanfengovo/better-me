import type { DatabaseSync } from "node:sqlite";
import type { AtlasDataset } from "@better-me/opportunities";
import {
  DATASET_SYNC_PROTOCOL, DATASET_TABLES, MAX_DELTA_BYTES, MAX_DELTA_ENTITIES, SYNC_REVISION_WINDOW,
  emptyDatasetUpserts, emptyDatasetDeletes, type DatasetTable, type DatasetUpserts, type DatasetSyncRequest, type DatasetSyncResponse,
} from "./dataset-sync-contract.js";

/** Durable net changes, committed in the entity transaction; not a second writer/outbox. */
export function createDatasetSyncStore(db: DatabaseSync, publicSnapshot: () => AtlasDataset, projectRows: (rows: DatasetUpserts) => DatasetUpserts) {
  const mark = db.prepare("INSERT INTO dataset_changes(table_name,entity_id,revision,deleted) VALUES (?,?,?,?) ON CONFLICT(table_name,entity_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted");
  const metadata = (key: string) => (db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string }).value;
  return {
    changed(table: DatasetTable, id: string, revision: number, deleted = false) { mark.run(table, id, revision, deleted ? 1 : 0); },
    finish(revision: number, reset = false) {
      if (reset) {
        db.exec("DELETE FROM dataset_changes; UPDATE metadata SET value=lower(hex(randomblob(16))) WHERE key='sync_epoch'");
        db.prepare("UPDATE metadata SET value=? WHERE key='sync_floor'").run(String(revision));
      } else {
        const floor = Math.max(Number(metadata("sync_floor")), revision - SYNC_REVISION_WINDOW);
        db.prepare("DELETE FROM dataset_changes WHERE revision<=?").run(floor);
        db.prepare("UPDATE metadata SET value=? WHERE key='sync_floor'").run(String(floor));
      }
    },
    /** Caller holds a read transaction, so cursor, documents and projection share a WAL revision. */
    read(input: DatasetSyncRequest): DatasetSyncResponse {
      const cursor = { epoch: metadata("sync_epoch"), revision: Number(metadata("revision")) };
      const snapshot = (reason: Extract<DatasetSyncResponse, { kind: "snapshot" }>["reason"]): DatasetSyncResponse =>
        ({ protocol: DATASET_SYNC_PROTOCOL, kind: "snapshot", reason, cursor, dataset: publicSnapshot() });
      if (!input.cursor) return snapshot("initial");
      if (input.cursor.epoch !== cursor.epoch) return snapshot("store-changed");
      if (input.cursor.revision > cursor.revision) return snapshot("cursor-ahead");
      if (input.cursor.revision < Math.max(Number(metadata("sync_floor")), cursor.revision - SYNC_REVISION_WINDOW)) return snapshot("cursor-expired");
      if (input.cursor.revision === cursor.revision) return { protocol: DATASET_SYNC_PROTOCOL, kind: "unchanged", cursor };
      const changes = db.prepare("SELECT table_name,entity_id,deleted FROM dataset_changes INDEXED BY dataset_changes_revision WHERE revision>? ORDER BY revision LIMIT ?")
        .all(input.cursor.revision, MAX_DELTA_ENTITIES + 1) as { table_name: DatasetTable; entity_id: string; deleted: number }[];
      if (changes.length > MAX_DELTA_ENTITIES) return snapshot("delta-too-large");
      const upserts = emptyDatasetUpserts(), deletes = emptyDatasetDeletes();
      const documents = new Map(DATASET_TABLES.map(table => [table, db.prepare(`SELECT document FROM ${table} WHERE id=?`)]));
      for (const change of changes) {
        if (change.deleted) { deletes[change.table_name].push(change.entity_id); continue; }
        // Primary-key reads on the bounded changed set. Do not rely on a JOIN
        // planner that might scan old markers or public tables to satisfy ORDER BY.
        const row = documents.get(change.table_name)!.get(change.entity_id) as { document: string } | undefined;
        if (!row) throw new Error("dataset-sync-missing-entity");
        (upserts[change.table_name] as unknown[]).push(JSON.parse(row.document));
      }
      const delta: DatasetSyncResponse = { protocol: DATASET_SYNC_PROTOCOL, kind: "delta", schemaVersion: 1, from: input.cursor, to: cursor, upserts: projectRows(upserts), deletes };
      return Buffer.byteLength(JSON.stringify(delta), "utf8") > MAX_DELTA_BYTES ? snapshot("delta-too-large") : delta;
    },
  };
}
