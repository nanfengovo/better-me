import type { DatabaseSync } from "node:sqlite";
import { OfficeAddressDecisionSchema, type JobLocation } from "@better-me/opportunities";
import type { DatasetUpserts } from "./dataset-sync-contract.js";

const PREFIX = "企业公开办公区与园区坐标核实：";
const WARNING = "legacy-office-coordinate-quarantined：历史批量推定的办公地址和坐标已从公共视图隔离；保留来源地点及既有行政区核对，需重新核对实际工作地址。";

/** Capture inside the caller's read transaction. Reused for all pages of that WAL view. */
export function createPublicSyncProjection(db: DatabaseSync) {
  const entries = db.prepare("SELECT o.document FROM office_decisions o JOIN locations l ON l.id=json_extract(o.document,'$.locationId') AND json_extract(l.document,'$.officeResolution.decisionId')=o.id WHERE json_extract(o.document,'$.kind')='confirm' AND substr(json_extract(o.document,'$.reason'),1,?)=?")
    .all(PREFIX.length, PREFIX) as { document: string }[];
  const locations = new Map<string, JobLocation>(), affected = new Set<string>();
  for (const row of entries) {
    const entry = OfficeAddressDecisionSchema.parse(JSON.parse(row.document));
    if (entry.kind !== "confirm" || entry.sourceLocation.id !== entry.locationId) continue;
    locations.set(entry.locationId, entry.sourceLocation);
    for (const evidence of entry.sourceLocation.evidence) affected.add(evidence.observationId);
  }
  return (rows: DatasetUpserts): DatasetUpserts => !entries.length ? rows : {
    ...rows, locations: rows.locations.map(location => locations.get(location.id) ?? location),
    observations: rows.observations.map(observation => affected.has(observation.id) && !observation.warnings.includes(WARNING)
      ? { ...observation, warnings: [...observation.warnings.slice(-99), WARNING] } : observation),
  };
}
