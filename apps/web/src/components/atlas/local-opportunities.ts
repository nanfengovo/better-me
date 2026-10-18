import {
  AtlasDatasetSchema, previewLegacyImport,
  type AtlasDataset, type LegacyImportWarning,
} from "@better-me/opportunities";

export type LocalOpportunityProjectionOptions = {
  /** Omit only after the user chooses the current library; an empty selection means no jobs. */
  selectedOpportunityIds?: readonly string[];
  signal?: AbortSignal;
};
export type LocalOpportunityProjection = {
  dataset: AtlasDataset;
  warnings: LegacyImportWarning[];
};
export class LocalOpportunityProjectionError extends Error {
  readonly code = "invalid-selection";
  constructor() { super("所选机会编号无效或已不在本次快照中，请重新选择。"); this.name = "LocalOpportunityProjectionError"; }
}

/**
 * Explicit, in-memory view of an already captured opportunity-library snapshot.
 * It never reads storage, fetches a source, imports a database or changes the v1 library.
 * Only the existing legacy public whitelist is returned; private bindings/fingerprints stay internal.
 */
export async function projectLocalOpportunities(
  librarySnapshot: unknown,
  options: LocalOpportunityProjectionOptions = {},
): Promise<LocalOpportunityProjection> {
  options.signal?.throwIfAborted();
  const selectionInput = options.selectedOpportunityIds;
  if (selectionInput !== undefined && (!Array.isArray(selectionInput) || selectionInput.length > 2000
    || selectionInput.some((id) => typeof id !== "string" || !id.trim() || id.length > 150)
    || new Set(selectionInput).size !== selectionInput.length)) throw new LocalOpportunityProjectionError();
  // Capture the caller's selection before previewLegacyImport yields for hashing.
  const selection = selectionInput === undefined ? undefined : new Set(selectionInput);
  const preview = await previewLegacyImport(librarySnapshot);
  options.signal?.throwIfAborted();
  if (selection && [...selection].some((id) => !preview.privateBindings.some((binding) => binding.oldOpportunityId === id))) throw new LocalOpportunityProjectionError();

  const bindings = preview.privateBindings.filter((binding) => !selection || selection.has(binding.oldOpportunityId));
  const jobs = new Set(bindings.map((binding) => binding.jobId));
  const listings = new Set(bindings.map((binding) => binding.listingId));
  const selectedJobs = preview.dataset.jobs.filter((job) => jobs.has(job.id));
  const companyIds = new Set(selectedJobs.map((job) => job.companyId));
  const locationIds = new Set(selectedJobs.flatMap((job) => job.locationIds));
  const compensationIds = new Set(selectedJobs.flatMap((job) => job.compensationIds));
  const selectedListings = preview.dataset.listings.filter((listing) => listings.has(listing.id));
  const sourceIds = new Set(selectedListings.map((listing) => listing.sourceId));
  const dataset = AtlasDatasetSchema.parse({
    ...preview.dataset,
    // The captured library revision participates in query/cursor invalidation; no new fetch is implied.
    revision: preview.sourceRevision,
    jobs: selectedJobs,
    companies: preview.dataset.companies.filter((company) => companyIds.has(company.id)),
    locations: preview.dataset.locations.filter((location) => locationIds.has(location.id)),
    compensations: preview.dataset.compensations.filter((compensation) => compensationIds.has(compensation.id)),
    listings: selectedListings,
    sources: preview.dataset.sources.filter((source) => sourceIds.has(source.sourceId)),
    observations: preview.dataset.observations.filter((observation) => listings.has(observation.listingId)),
    snapshots: preview.dataset.snapshots.filter((snapshot) => listings.has(snapshot.listingId)),
  });
  const selectedIndexes = new Map<number, number>();
  preview.privateBindings.forEach((binding, index) => { if (jobs.has(binding.jobId)) selectedIndexes.set(index, selectedIndexes.size); });
  const warnings = preview.warnings.flatMap((warning) => warning.jobIndex === undefined ? [{ ...warning }]
    : selectedIndexes.has(warning.jobIndex) ? [{ ...warning, jobIndex: selectedIndexes.get(warning.jobIndex)! }] : []);
  options.signal?.throwIfAborted();
  return { dataset, warnings };
}
