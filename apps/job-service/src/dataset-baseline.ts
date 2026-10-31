import { randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { BASELINE_PROTOCOL, BASELINE_MAX_BYTES, BASELINE_MAX_ENTITIES, BASELINE_MAX_ROW_BYTES,
  type BaselinePage, type BaselineRequest, type BaselineResponse } from "./dataset-baseline-contract.js";
import { DATASET_TABLES, datasetEntityId, emptyDatasetUpserts, type DatasetCursor, type DatasetTable, type DatasetUpserts } from "./dataset-sync-contract.js";
import { createPublicSyncProjection } from "./public-sync-projection.js";
import { datasetReferences } from "./dataset-references.js";

type Session = {
  db?: DatabaseSync; project: (rows: DatasetUpserts) => DatasetUpserts; cursor: DatasetCursor;
  totalJobs: number; loadedJobs: number; owner: string; created: number; touched: number; sequence: number;
  seen: Map<DatasetTable, Set<string>>; queued: Set<string>; queue: Array<[DatasetTable, string]>; head: number;
  jobAfter: string; jobsDone: boolean; tableIndex: number; tableAfter: string;
  documents: Map<DatasetTable, StatementSync>; scans: Map<DatasetTable, StatementSync>; last?: BaselinePage;
};
const expired = (): BaselineResponse => ({ protocol: BASELINE_PROTOCOL, kind: "expired" });

/** Bounded keyset traversal of a pinned read-only WAL view, not an in-memory full export.
 * Pages may end mid-graph; only checkpoints are safe to query. Shared evidence cycles
 * are drained before publishing. Every public row (including unreferenced history) is sent once.
 */
export function createDatasetBaselineStore(path: string, options: { now?: () => number; idleMs?: number; lifetimeMs?: number; maxSessions?: number } = {}) {
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now, idleMs = options.idleMs ?? 30_000, lifetimeMs = options.lifetimeMs ?? 120_000;
  function release(session: Session) { if (session.db) { try { session.db.exec("ROLLBACK"); } finally { session.db.close(); session.db = undefined; } } }
  function remove(id: string) { const value = sessions.get(id); if (value) release(value); sessions.delete(id); }
  function prune() { for (const [id, value] of sessions) if (now() - value.touched >= idleMs || now() - value.created >= lifetimeMs) remove(id); }
  const timer = setInterval(prune, Math.min(idleMs, 5000)); timer.unref();
  const queueKey = (table: DatasetTable, id: string) => `${table}:${id}`;
  function enqueue(session: Session, table: DatasetTable, id: string) {
    if (session.seen.get(table)!.has(id) || session.queued.has(queueKey(table, id))) return;
    session.queued.add(queueKey(table, id)); session.queue.push([table, id]);
  }
  function start(owner: string): [string, Session] {
    prune();
    // Completed pages retain a bounded replay cache, not active WAL ownership.
    // They must not prevent a fresh reader from using a free session slot.
    for (const [id, value] of sessions) if (!value.db) remove(id);
    if (sessions.size >= (options.maxSessions ?? 4)) throw new Error("baseline-capacity");
    // Production uses a caller-selected WAL file. Do not hold the writer's own
    // :memory: connection across requests or materialize a hidden whole snapshot.
    if (path === ":memory:") throw new Error("baseline-file-required");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
      const metadata = (key: string) => (db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string }).value;
      const cursor = { epoch: metadata("sync_epoch"), revision: Number(metadata("revision")) };
      const timestamp = now();
      const session: Session = { db, cursor, project: createPublicSyncProjection(db), totalJobs: (db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count,
        loadedJobs: 0, owner, created: timestamp, touched: timestamp, sequence: 0, seen: new Map(DATASET_TABLES.map(table => [table, new Set<string>()])),
        queued: new Set(), queue: [], head: 0, jobAfter: "", jobsDone: false, tableIndex: 0, tableAfter: "",
        documents: new Map(DATASET_TABLES.map(table => [table, db.prepare(`SELECT document FROM ${table} WHERE id=?`)])),
        scans: new Map(DATASET_TABLES.map(table => [table, db.prepare(`SELECT id FROM ${table} WHERE id>? ORDER BY id LIMIT ?`)])),
      };
      const id = randomBytes(16).toString("hex"); sessions.set(id, session); return [id, session];
    } catch (error) { db.close(); throw error; }
  }
  function seed(session: Session) {
    if (!session.jobsDone) {
      const jobs = session.scans.get("jobs")!.all(session.jobAfter, session.loadedJobs ? 256 : 64) as { id: string }[];
      if (jobs.length) { session.jobAfter = jobs.at(-1)!.id; for (const row of jobs) enqueue(session, "jobs", row.id); return; }
      session.jobsDone = true;
    }
    // Keyset scans cover orphan companies, disabled sources and immutable history
    // too. No OFFSET, no all-document read, no silent omission of detached rows.
    let scanned = 0;
    while (session.tableIndex < DATASET_TABLES.length && !session.queue.length && scanned < 2048) {
      const table = DATASET_TABLES[session.tableIndex]!;
      const rows = session.scans.get(table)!.all(session.tableAfter, BASELINE_MAX_ENTITIES) as { id: string }[];
      if (!rows.length) { session.tableIndex++; session.tableAfter = ""; continue; }
      session.tableAfter = rows.at(-1)!.id;
      scanned += rows.length;
      for (const row of rows) enqueue(session, table, row.id);
      // Amortize already-delivered keysets, but cap ID work even for a library
      // containing nothing detached. Never read every document in a late page.
    }
  }
  return {
    read(input: BaselineRequest, owner: string): BaselineResponse {
      prune();
      const found = input.page ? [input.page.session, sessions.get(input.page.session)] as const : start(owner);
      const [id, session] = found;
      if (!session || session.owner !== owner) return expired();
      session.touched = now();
      if (input.page && session.last?.sequence === input.page.sequence) return session.last;
      if ((input.page?.sequence ?? 0) !== session.sequence || !session.db) return expired();
      try {
        if (!session.queue.length) seed(session);
        const rows = emptyDatasetUpserts(); let entities = 0, bytes = 1024;
        while (session.head < session.queue.length && entities < BASELINE_MAX_ENTITIES) {
          const [table, entityId] = session.queue[session.head]!;
          const document = session.documents.get(table)!.get(entityId) as { document: string } | undefined;
          if (!document) throw new Error("baseline-reference-missing");
          const fragment = emptyDatasetUpserts(); (fragment[table] as unknown[]).push(JSON.parse(document.document));
          const row = session.project(fragment)[table][0]!;
          const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
          if (size > BASELINE_MAX_ROW_BYTES) throw new Error("baseline-row-too-large");
          if (entities && bytes + size > BASELINE_MAX_BYTES) break;
          session.head++; entities++; bytes += size;
          session.queued.delete(queueKey(table, entityId)); session.seen.get(table)!.add(entityId);
          if (datasetEntityId(table, row) !== entityId) throw new Error("baseline-identity-mismatch");
          (rows[table] as unknown[]).push(row); if (table === "jobs") session.loadedJobs++;
          for (const [target, dependency] of datasetReferences(table, row)) enqueue(session, target, dependency);
        }
        const checkpoint = session.head === session.queue.length;
        if (checkpoint) { session.queue = []; session.head = 0; }
        const complete = checkpoint && session.jobsDone && session.tableIndex === DATASET_TABLES.length;
        const page: BaselinePage = { protocol: BASELINE_PROTOCOL, kind: "page", cursor: session.cursor, session: id, sequence: session.sequence,
          ...(!complete ? { next: { session: id, sequence: session.sequence + 1 } } : {}), totalJobs: session.totalJobs, loadedJobs: session.loadedJobs, checkpoint, complete, rows };
        session.last = page; session.sequence++;
        if (complete) release(session);
        return page;
      } catch (error) { remove(id); throw error; }
    },
    closeSession(session: string, owner: string) { if (sessions.get(session)?.owner === owner) remove(session); return { closed: true as const }; },
    close() { clearInterval(timer); for (const id of sessions.keys()) remove(id); },
  };
}
