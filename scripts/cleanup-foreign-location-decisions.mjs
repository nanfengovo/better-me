import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

const dbPath = path.join(os.homedir(), "Library/Application Support/BetterMe/job-atlas/jobs.sqlite");
console.log("Opening database:", dbPath);
const db = new DatabaseSync(dbPath);

db.exec("BEGIN TRANSACTION;");

try {
  const badDecisions = db.prepare(`
    SELECT ld.id as decisionId, json_extract(ld.document, '$.locationId') as locationId, bl.document as baseDoc, json_extract(bl.document, '$.raw') as rawLoc
    FROM location_decisions ld
    JOIN base_locations bl ON json_extract(ld.document, '$.locationId') = bl.id
    WHERE NOT (json_extract(bl.document, '$.raw') GLOB '*[一-龥]*')
      AND json_extract(bl.document, '$.raw') NOT LIKE '%Shanghai%'
  `).all();

  console.log(`Found ${badDecisions.length} erroneous foreign location decisions to remove.`);

  db.exec("DROP TRIGGER IF EXISTS location_decisions_no_delete;");
  db.exec("DROP TRIGGER IF EXISTS location_decisions_no_update;");

  const deleteStmt = db.prepare("DELETE FROM location_decisions WHERE id = ?");
  const restoreLocationStmt = db.prepare("UPDATE locations SET document = ?, latitude = NULL, longitude = NULL WHERE id = ?");

  let count = 0;
  for (const row of badDecisions) {
    deleteStmt.run(row.decisionId);
    restoreLocationStmt.run(row.baseDoc, row.locationId);
    count++;
  }

  db.exec(`
    CREATE TRIGGER location_decisions_no_update BEFORE UPDATE ON location_decisions BEGIN SELECT RAISE(ABORT,'immutable-location-decision'); END;
    CREATE TRIGGER location_decisions_no_delete BEFORE DELETE ON location_decisions BEGIN SELECT RAISE(ABORT,'immutable-location-decision'); END;
  `);

  // Bump revision
  const currentRevRow = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
  const currentRev = Number(JSON.parse(currentRevRow?.value ?? "1987"));
  const nextRev = currentRev + 1;
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(JSON.stringify(nextRev));

  db.exec("COMMIT;");
  console.log(`Successfully removed ${count} foreign location decisions and restored locations. Bumped revision to ${nextRev}.`);
} catch (err) {
  db.exec("ROLLBACK;");
  console.error("Error during cleanup:", err);
  process.exit(1);
} finally {
  db.close();
}
