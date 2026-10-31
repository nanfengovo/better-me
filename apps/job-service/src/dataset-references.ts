import type { DatasetTable } from "./dataset-tables.js";

/** Public reference graph only; never traverses private decisions, credentials or sidecars. */
export function datasetReferences(table: DatasetTable, row: unknown): Array<[DatasetTable, string]> {
  const value = row as Record<string, any>, refs: Array<[DatasetTable, string]> = [];
  const add = (target: DatasetTable, id?: string) => { if (id) refs.push([target, id]); };
  const many = (target: DatasetTable, ids?: string[]) => { ids?.forEach(id => add(target, id)); };
  const evidence = (items?: Array<{ observationId: string }>) => items?.forEach(item => add("observations", item.observationId));
  if (table === "companies") {
    many("companies", value.parentCompanyIds); evidence(value.ultimateControllers?.evidence); evidence(value.legalEntity?.evidence);
    for (const override of value.manualOverrides ?? []) {
      if (override.field === "parentCompanyIds") many("companies", override.value);
      else evidence(override.value?.evidence);
    }
  } else if (table === "jobs") {
    add("companies", value.companyId); many("locations", value.locationIds); many("compensations", value.compensationIds);
    many("listings", value.listingIds); add("snapshots", value.selectedSnapshotId);
    evidence(value.title?.evidence); evidence(value.roleFamily?.evidence); evidence(value.seniority?.evidence);
  } else if (table === "locations" || table === "compensations") {
    evidence(value.evidence); if (table === "compensations") many("locations", value.locationIds);
  } else if (table === "listings") {
    add("sources", value.sourceId); many("sources", value.discoverySourceIds); add("jobs", value.canonicalJobId);
    many("locations", value.locationIds); many("compensations", value.compensationIds); many("observations", value.observationIds);
  } else if (table === "observations") {
    add("listings", value.listingId); add("snapshots", value.snapshotId);
  } else if (table === "snapshots") {
    add("listings", value.listingId); add("observations", value.observationId);
  }
  return refs;
}
