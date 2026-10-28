import type { DatabaseSync } from "node:sqlite";
import type { CanonicalJob } from "@better-me/opportunities";

/** Derived origin edges, maintained in the same transaction as base_jobs. Never backed up as facts. */
export function createProjectionDependencies(db: DatabaseSync) {
  const remove = db.prepare("DELETE FROM base_job_dependencies WHERE job_id=?");
  const insert = db.prepare("INSERT INTO base_job_dependencies(job_id,kind,entity_id) VALUES (?,?,?)");
  return {
    clear() { db.exec("DELETE FROM base_job_dependencies"); },
    save(job: CanonicalJob) {
      remove.run(job.id);
      const edges = { company: [job.companyId], location: job.locationIds, compensation: job.compensationIds, listing: job.listingIds };
      for (const [kind, ids] of Object.entries(edges)) for (const id of new Set(ids)) insert.run(job.id, kind, id);
    },
  };
}
