import type { DatabaseSync } from "node:sqlite";
import type { AtlasDataset, MergeDecision, LocationConfirmationDecision, OfficeAddressDecision } from "@better-me/opportunities";
import { DATASET_TABLES, type DatasetTable } from "./dataset-tables.js";

export type ProjectionSelection = Partial<Record<DatasetTable, readonly string[]>>;
type Row = Record<string, unknown>;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Transaction-local dependency closure. No whole-library cache or second source of truth. */
export function createProjectionSlice(db: DatabaseSync, validate: (input: unknown) => AtlasDataset) {
  return {
    read(options: { incoming?: AtlasDataset; seeds?: ProjectionSelection; companyContext?: boolean; listingHistory?: boolean } = {}) {
      const stored = new Map(DATASET_TABLES.map(table => [table, new Map<string, Row>()]));
      const origins = new Map<string, Row>(), sourceLocations = new Map<string, Row>();
      const requested = new Set<string>(), queue: [DatasetTable, string][] = [];
      const pendingHistory = new Set<string>();
      const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
      const statement = (sql: string) => { let value = statements.get(sql); if (!value) { value = db.prepare(sql); statements.set(sql, value); } return value; };
      const doc = (table: string, id: string): Row | undefined => {
        const row = statement(`SELECT document FROM ${table} WHERE id=?`).get(id) as { document: string } | undefined;
        return row && JSON.parse(row.document) as Row;
      };
      const request = (table: DatasetTable, id: unknown) => {
        if (typeof id !== "string") return;
        const key = JSON.stringify([table, id]); if (requested.has(key)) return;
        requested.add(key); queue.push([table, id]);
      };
      const requestJobs = (sql: string, id: string) => {
        for (const row of statement(sql).all(id) as { job_id: string }[]) request("jobs", row.job_id);
      };
      const references = (value: unknown) => {
        if (Array.isArray(value)) { for (const item of value) references(item); return; }
        if (!value || typeof value !== "object") return;
        const row = value as Row;
        const single: Record<string, DatasetTable> = { companyId: "companies", canonicalJobId: "jobs", selectedSnapshotId: "snapshots", snapshotId: "snapshots", observationId: "observations", listingId: "listings" };
        const multiple: Record<string, DatasetTable> = { parentCompanyIds: "companies", locationIds: "locations", compensationIds: "compensations", listingIds: "listings", observationIds: "observations", discoverySourceIds: "sources" };
        for (const [key, entry] of Object.entries(row)) {
          if (single[key]) request(single[key]!, entry);
          else if (multiple[key] && Array.isArray(entry)) for (const id of entry) request(multiple[key]!, id);
          else references(entry);
        }
        if (row.field === "parentCompanyIds" && Array.isArray(row.value)) for (const id of row.value) request("companies", id);
      };
      const locationEntries = new Map<string, LocationConfirmationDecision>(), officeEntries = new Map<string, OfficeAddressDecision>(), mergeEntries = new Map<string, MergeDecision>();
      const decisionRefs = (entry: LocationConfirmationDecision | OfficeAddressDecision) => {
        if (entry.kind === "invalidate") return;
        request("jobs", entry.jobId); request("locations", entry.locationId); request("listings", entry.listingId);
        if (entry.sourceLocation) references(entry.sourceLocation);
      };
      const companyRoots = new Set(options.incoming?.companies.map(row => row.id) ?? []);
      for (const table of DATASET_TABLES) {
        for (const id of options.seeds?.[table] ?? []) request(table, id);
        for (const row of options.incoming?.[table] ?? []) {
          request(table, table === "sources" ? (row as AtlasDataset["sources"][number]).sourceId : (row as { id: string }).id);
          references(row);
          if (table === "listings") request("sources", (row as AtlasDataset["listings"][number]).sourceId);
        }
      }
      for (let index = 0; index < queue.length || pendingHistory.size; index++) {
        if (index === queue.length) {
          // Only source-page preparation needs unselected historical snapshots.
          // Read all requested listings together, never rescan history per row.
          const ids = [...pendingHistory]; pendingHistory.clear();
          for (const row of statement("SELECT id FROM snapshots WHERE listing_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string }[]) request("snapshots", row.id);
          if (index === queue.length) break;
        }
        const [table, id] = queue[index]!;
        const value = doc(table, id);
        if (value) { stored.get(table)!.set(id, value); references(value); }
        if (table === "jobs") {
          const origin = doc("base_jobs", id);
          if (origin) { origins.set(id, origin); references(origin); }
          const alias = statement("SELECT canonical_job_id FROM job_aliases WHERE job_id=?").get(id) as { canonical_job_id: string } | undefined;
          if (alias) {
            request("jobs", alias.canonical_job_id);
            requestJobs("SELECT job_id FROM job_aliases WHERE canonical_job_id=?", alias.canonical_job_id);
          }
          if (options.companyContext && origin && typeof origin.companyId === "string") {
            companyRoots.add(origin.companyId);
            requestJobs("SELECT job_id FROM base_job_dependencies WHERE kind='company' AND entity_id=?", origin.companyId);
          }
          const entries = statement("SELECT document FROM merge_decisions WHERE json_extract(document,'$.targetJobId')=?1 OR json_extract(document,'$.sourceJobId')=?1 OR json_extract(document,'$.leftJobId')=?1 OR json_extract(document,'$.rightJobId')=?1 ORDER BY revision").all(id) as { document: string }[];
          for (const row of entries) {
            const entry = JSON.parse(row.document) as MergeDecision; mergeEntries.set(entry.id, entry);
            const revocations = statement("SELECT document FROM merge_decisions WHERE json_extract(document,'$.targetDecisionId')=? ORDER BY revision").all(entry.id) as { document: string }[];
            for (const revoked of revocations) { const item = JSON.parse(revoked.document) as MergeDecision; mergeEntries.set(item.id, item); }
            if (entry.kind === "merge" && !revocations.length) { request("jobs", entry.targetJobId); request("jobs", entry.sourceJobId); }
          }
        } else if (table === "locations") {
          const origin = doc("base_locations", id);
          if (origin) { sourceLocations.set(id, origin); references(origin); }
          requestJobs("SELECT job_id FROM base_job_dependencies WHERE kind='location' AND entity_id=?", id);
          for (const row of statement("SELECT document FROM location_decisions WHERE json_extract(document,'$.locationId')=? ORDER BY revision").all(id) as { document: string }[]) {
            const entry = JSON.parse(row.document) as LocationConfirmationDecision; locationEntries.set(entry.id, entry); decisionRefs(entry);
          }
          for (const row of statement("SELECT document FROM office_decisions WHERE json_extract(document,'$.locationId')=? ORDER BY revision").all(id) as { document: string }[]) {
            const entry = JSON.parse(row.document) as OfficeAddressDecision; officeEntries.set(entry.id, entry); decisionRefs(entry);
            if (entry.kind === "confirm") for (const invalidation of statement("SELECT document FROM office_decisions WHERE json_extract(document,'$.kind')='invalidate' AND EXISTS (SELECT 1 FROM json_each(document,'$.targetDecisionIds') WHERE value=?) ORDER BY revision").all(entry.id) as { document: string }[]) {
              const item = JSON.parse(invalidation.document) as OfficeAddressDecision; officeEntries.set(item.id, item);
            }
          }
        } else if (table === "companies" && companyRoots.has(id)) {
          requestJobs("SELECT job_id FROM base_job_dependencies WHERE kind='company' AND entity_id=?", id);
        } else if (table === "listings") {
          if (value) request("sources", value.sourceId);
          requestJobs("SELECT job_id FROM base_job_dependencies WHERE kind='listing' AND entity_id=?", id);
          if (value && options.listingHistory) pendingHistory.add(id);
        } else if (table === "compensations") requestJobs("SELECT job_id FROM base_job_dependencies WHERE kind='compensation' AND entity_id=?", id);
      }
      const version = Number((statement("SELECT value FROM metadata WHERE key='revision'").get() as { value: string }).value);
      const dataset = { schemaVersion: 1 as const, revision: version } as AtlasDataset;
      for (const table of DATASET_TABLES) (dataset[table] as unknown[]) = [...stored.get(table)!.entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row);
      const jobs = [...origins.entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row) as AtlasDataset["jobs"];
      const owner = new Map(jobs.flatMap(job => job.listingIds.map(id => [id, job.id] as const)));
      const base = { ...dataset, jobs, locations: [...sourceLocations.entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row) as AtlasDataset["locations"],
        listings: dataset.listings.map(listing => ({ ...listing, ...(owner.has(listing.id) ? { canonicalJobId: owner.get(listing.id)! } : {}) })) };
      const confirmations = new Set([...officeEntries.values()].filter(entry => entry.kind === "confirm").map(entry => entry.id));
      const offices = [...officeEntries.values()].flatMap<OfficeAddressDecision>(entry => {
        if (entry.kind !== "invalidate") return [entry];
        const targetDecisionIds = entry.targetDecisionIds.filter(id => confirmations.has(id));
        return targetDecisionIds.length ? [{ ...entry, targetDecisionIds }] : [];
      });
      const byRevision = <T extends { revision: number }>(entries: T[]) => entries.sort((a, b) => a.revision - b.revision);
      return { current: validate(dataset), base: validate(base),
        merges: byRevision([...mergeEntries.values()]), locations: byRevision([...locationEntries.values()]), offices: byRevision(offices) };
    },
  };
}
