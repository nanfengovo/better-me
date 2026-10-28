import { AtlasDatasetSchema, type AtlasDataset, type CanonicalJob, type Company, type JobLocation } from "./schema.js";
import { classifyCompany } from "./colors.js";
import { executeJobQuery, normalizeSearchText, type JobQueryInput, type JobQueryResult, type QueryOptions } from "./query.js";

type SearchField = { field: string; weight: number; value: string };
type StaticFields = { title: string; role: string; description: string };
type PreparedText = { source: string; value: string };
// Delta snapshots retain unchanged entity identities. Weak keys neither retain
// old snapshots nor confuse two independent stores with the same revision.
const jobText = new WeakMap<CanonicalJob, { source: StaticFields; value: StaticFields }>();
const companyText = new WeakMap<Company, PreparedText>();
const locationText = new WeakMap<JobLocation, PreparedText>();

function normalized<K extends object>(cache: WeakMap<K, PreparedText>, key: K, source: string): string {
  const previous = cache.get(key);
  if (previous?.source === source) return previous.value;
  const value = normalizeSearchText(source); cache.set(key, { source, value }); return value;
}

function normalizedJob(raw: CanonicalJob, job: CanonicalJob): StaticFields {
  const source = { title: job.title.value, role: [job.roleFamily?.value, job.seniority?.value].filter(Boolean).join(" "), description: job.description };
  const previous = jobText.get(raw);
  if (previous && previous.source.title === source.title && previous.source.role === source.role && previous.source.description === source.description) return previous.value;
  const value = { title: normalizeSearchText(source.title), role: normalizeSearchText(source.role), description: normalizeSearchText(source.description) };
  jobText.set(raw, { source, value }); return value;
}

/** Internal execution state. The public boundary is only createJobQueryIndex(). */
export type QueryIndexContext = {
  dataset: AtlasDataset;
  companies: Map<string, Company>;
  locations: Map<string, JobLocation>;
  compensations: Map<string, AtlasDataset["compensations"][number]>;
  listings: Map<string, AtlasDataset["listings"][number]>;
  sources: Map<string, AtlasDataset["sources"][number]>;
  facts: Map<string, { countries: string[]; ownership: string[] }>;
  candidates(query: import("./query.js").JobQuery): CanonicalJob[];
  fields(job: CanonicalJob, company: Company, locations: JobLocation[]): SearchField[];
  fingerprint?: Promise<string>;
  coverage?: JobQueryResult["sourceCoverage"];
  matches: Map<string, Promise<Omit<JobQueryResult, "queryId" | "normalizedQuery" | "nextCursor" | "mapBuckets">>>;
  plans: Map<string, Promise<Omit<JobQueryResult, "queryId" | "normalizedQuery" | "nextCursor">>>;
};

export type JobQueryIndex = {
  /** Snapshot and returned query facts are read-only. Create another index for
   * a new snapshot; never edit an indexed entity or returned map bucket in place. */
  search(input: JobQueryInput, options?: QueryOptions): Promise<JobQueryResult>;
};

/** One validated, immutable snapshot; bounded query plans and weak text indexes.
 * No persistence, UI state, worker lifecycle, network or revision-only identity. */
export function createJobQueryIndex(input: AtlasDataset): JobQueryIndex {
  const dataset = AtlasDatasetSchema.parse(input);
  const companies = new Map(dataset.companies.map(row => [row.id, row]));
  const facts = new Map(dataset.companies.map(company => {
    const value = classifyCompany(company);
    return [company.id, { countries: [...value.jurisdictions, ...(!value.jurisdictionComplete ? ["unknown"] : [])], ownership: [value.ownership] }];
  }));
  // Keep text preparation lazy: an initial unfiltered list need not process
  // every description, and selective postings may only need a handful of jobs.
  const rawJobs = new Map(input.jobs.map(job => [job.id, job]));
  const rawCompanies = new Map(input.companies.map(company => [company.id, company]));
  const rawLocations = new Map(input.locations.map(location => [location.id, location]));
  const preparedJobs = new Map<string, StaticFields>();
  const preparedCompanies = new Map<string, string>();
  const preparedLocations = new Map<string, string>();
  const listings = new Map(dataset.listings.map(row => [row.id, row]));
  const postings = new Map<string, Map<string, Set<CanonicalJob>>>();
  function add(field: string, value: string, job: CanonicalJob) {
    let values = postings.get(field); if (!values) { values = new Map(); postings.set(field, values); }
    let jobs = values.get(value); if (!jobs) { jobs = new Set(); values.set(value, jobs); }
    jobs.add(job);
  }
  for (const job of dataset.jobs) {
    add("id", job.id, job); add("status", job.status, job); add("company", job.companyId, job);
    add("workMode", job.workMode, job); add("employment", job.employmentType, job);
    for (const id of job.listingIds) add("source", listings.get(id)!.sourceId, job);
    for (const value of facts.get(job.companyId)!.countries) add("controller", value, job);
    for (const value of facts.get(job.companyId)!.ownership) add("ownership", value, job);
  }
  const context: QueryIndexContext = {
    dataset, companies, facts, listings,
    locations: new Map(dataset.locations.map(row => [row.id, row])),
    compensations: new Map(dataset.compensations.map(row => [row.id, row])),
    sources: new Map(dataset.sources.map(row => [row.sourceId, row])), matches: new Map(), plans: new Map(),
    candidates(query) {
      // OR within a filter, AND across filters. Spatial predicates still run on
      // the same office below; independent country/region postings would be wrong.
      const groups: Array<[string, readonly string[] | undefined]> = [
        ["id", query.jobIds], ["status", query.statuses], ["company", query.companyIds],
        ["workMode", query.workModes], ["employment", query.employmentTypes],
        ["source", query.sourceIds], ["controller", query.controllerJurisdictions], ["ownership", query.ownershipKinds],
      ];
      let candidates: Set<CanonicalJob> | undefined;
      for (const [field, values] of groups) {
        if (values === undefined || (!values.length && field !== "id")) continue;
        const union = new Set<CanonicalJob>();
        for (const value of values) for (const job of postings.get(field)?.get(value) ?? []) union.add(job);
        if (!candidates) candidates = union;
        else for (const job of candidates) if (!union.has(job)) candidates.delete(job);
        if (!candidates.size) return [];
      }
      return candidates ? [...candidates] : dataset.jobs;
    },
    fields(job, company, locations) {
      let values = preparedJobs.get(job.id);
      if (!values) { values = normalizedJob(rawJobs.get(job.id)!, job); preparedJobs.set(job.id, values); }
      let companyValue = preparedCompanies.get(company.id);
      if (companyValue === undefined) { companyValue = normalized(companyText, rawCompanies.get(company.id)!, company.names.join(" ")); preparedCompanies.set(company.id, companyValue); }
      const locationValues = locations.map(location => {
        let value = preparedLocations.get(location.id);
        if (value === undefined) {
          value = normalized(locationText, rawLocations.get(location.id)!, [location.raw, location.countryCode, location.region, location.city].filter(Boolean).join(" "));
          preparedLocations.set(location.id, value);
        }
        return value;
      });
      return [
        { field: "title", weight: 5, value: values.title },
        { field: "company", weight: 4, value: companyValue },
        { field: "role", weight: 3, value: values.role },
        { field: "location", weight: 2, value: locationValues.filter(Boolean).join(" ") },
        { field: "description", weight: 1, value: values.description },
      ];
    },
  };
  return { search: (query, options = {}) => executeJobQuery(input, query, options, context) };
}
