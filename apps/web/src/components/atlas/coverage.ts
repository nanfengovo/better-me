import {
  classifyCompany, normalizeCompensation, salaryMetric, Wgs84CoordinateSchema,
  type AtlasDataset, type CompensationReason, type FxSnapshot, type SalaryMetric, type Wgs84Coordinate,
} from "@better-me/opportunities";

export type AtlasCoverageMetric = { supported: boolean; jobs: number; missingJobs: number; totalJobs: number };
export type AtlasCoverageOptions = {
  fx?: FxSnapshot;
  now?: string;
  includeEstimates?: boolean;
  salaryMetric?: SalaryMetric;
  allowCityEstimate?: boolean;
  anchor?: Wgs84Coordinate;
  /** Restrict region suggestions to locations in these countries. Other snapshot-wide metrics stay unchanged. */
  workCountryCodes?: readonly string[];
};
export type AtlasDataCoverage = {
  totalJobs: number;
  salary: AtlasCoverageMetric & {
    sortSupported: boolean; sortJobs: number; rawJobs: number; originalAnnualJobs: number;
    ambiguousJobs: number; estimatedJobs: number; fxBlockedJobs: number;
    reasons: Partial<Record<CompensationReason | "ambiguous" | "missing-record", number>>;
  };
  map: AtlasCoverageMetric;
  distance: AtlasCoverageMetric & { ready: boolean; anchorRequired: boolean; preciseJobs: number; estimatedJobs: number };
  ownership: AtlasCoverageMetric & { values: string[] };
  controller: AtlasCoverageMetric & { values: string[]; completeJobs: number };
  country: AtlasCoverageMetric & { values: string[] };
  region: AtlasCoverageMetric & { options: Array<{ id: string; label: string; countryCodes: string[]; jobs: number }> };
  source: AtlasCoverageMetric & { options: Array<{ id: string; label: string; jobs: number }> };
};

/** Snapshot-wide data availability, independent of the current result page. It never fills missing facts.
 * Salary selection follows queryJobs: distinct comparable intervals stay ambiguous; missing metric endpoints
 * cannot enable salary sorting. Monthly estimates and city-centre distances require matching query options.
 * Source coverage means indexed source attribution, not the ability to search or refresh that platform.
 */
export function getAtlasDataCoverage(data: AtlasDataset | null | undefined, options: AtlasCoverageOptions = {}): AtlasDataCoverage {
  const jobs = data?.jobs ?? [], totalJobs = jobs.length;
  const metric = (count: number): AtlasCoverageMetric => ({ supported: count > 0, jobs: count, missingJobs: totalJobs - count, totalJobs });
  const locations = new Map(data?.locations.map((location) => [location.id, location]));
  const compensations = new Map(data?.compensations.map((compensation) => [compensation.id, compensation]));
  const companies = new Map(data?.companies.map((company) => [company.id, classifyCompany(company)]));
  const sources = new Map(data?.sources.map((source) => [source.sourceId, source]));
  const listings = new Map(data?.listings.map((listing) => [listing.id, listing]));
  const countryValues = new Set<string>(), ownershipValues = new Set<string>(), controllerValues = new Set<string>();
  const regionOptions = new Map<string, { label: string; countries: Set<string>; jobs: number }>();
  const sourceOptions = new Map<string, { label: string; jobs: number }>();
  const reasons: AtlasDataCoverage["salary"]["reasons"] = {};
  let salaryJobs = 0, sortJobs = 0, rawJobs = 0, originalAnnualJobs = 0, ambiguousJobs = 0, estimatedJobs = 0, fxBlockedJobs = 0;
  let mapJobs = 0, distanceJobs = 0, preciseJobs = 0, estimatedDistanceJobs = 0;
  let countryJobs = 0, regionJobs = 0, sourceJobs = 0, ownershipJobs = 0, controllerJobs = 0, completeControllerJobs = 0;
  const now = options.now ?? new Date().toISOString();
  for (const job of jobs) {
    const jobLocations = job.locationIds.flatMap((id) => locations.get(id) ? [locations.get(id)!] : []);
    const jobLocationIds = new Set(jobLocations.map((location) => location.id));
    const jobCompensations = job.compensationIds.flatMap((id) => {
      const compensation = compensations.get(id);
      return compensation && (!compensation.locationIds?.length || compensation.locationIds.some((locationId) => jobLocationIds.has(locationId))) ? [compensation] : [];
    });
    const salaryCandidates = jobCompensations.map((compensation) => normalizeCompensation(compensation, {
      now, fx: options.fx, allowMonthlyEstimate: options.includeEstimates ?? true,
    }));
    if (jobCompensations.some((compensation) => compensation.raw.trim())) rawJobs++;
    if (salaryCandidates.some((salary) => salary.originalAnnual)) originalAnnualJobs++;
    if (salaryCandidates.some((salary) => salary.reason.startsWith("fx-"))) fxBlockedJobs++;
    const comparable = salaryCandidates.filter((salary) => salary.cnyAnnual && (options.includeEstimates !== false || !salary.estimated));
    const intervals = new Set(comparable.map((salary) => JSON.stringify([salary.cnyAnnual!.min, salary.cnyAnnual!.max])));
    const jobReasons = new Set<CompensationReason | "ambiguous" | "missing-record">(salaryCandidates.map((salary) => salary.reason));
    if (!salaryCandidates.length) jobReasons.add("missing-record");
    if (intervals.size > 1) { ambiguousJobs++; jobReasons.add("ambiguous"); }
    else if (comparable.length) {
      // Equivalent annual intervals prefer non-estimated, verified disclosures, exactly as queryJobs.
      comparable.sort((a, b) => Number(a.estimated) - Number(b.estimated) || Number(b.verification === "verified") - Number(a.verification === "verified")
        || (a.compensationId < b.compensationId ? -1 : a.compensationId > b.compensationId ? 1 : 0));
      const selected = comparable[0]!;
      salaryJobs++;
      if (salaryMetric(selected, options.salaryMetric ?? "min") !== undefined) sortJobs++;
      if (selected.estimated) estimatedJobs++;
    }
    for (const reason of jobReasons) reasons[reason] = (reasons[reason] ?? 0) + 1;

    if (jobLocations.some((location) => location.coordinates)) mapJobs++;
    const eligibleLocations = jobLocations.filter((location) => location.coordinates && location.kind !== "remote-region" && location.kind !== "unknown"
      && (["address", "manual", "street"].includes(location.precision) || (location.precision === "city" && options.allowCityEstimate === true)));
    if (eligibleLocations.length) distanceJobs++;
    if (eligibleLocations.some((location) => ["address", "manual"].includes(location.precision))) preciseJobs++;
    if (eligibleLocations.some((location) => ["city", "street"].includes(location.precision))) estimatedDistanceJobs++;
    const jobCountries = new Set(jobLocations.flatMap((location) => location.countryCode ? [location.countryCode] : []));
    if (jobCountries.size) countryJobs++;
    for (const country of jobCountries) countryValues.add(country);
    const jobRegions = new Map<string, { label: string; countries: Set<string> }>();
    for (const location of jobLocations) {
      if (options.workCountryCodes?.length && (!location.countryCode || !options.workCountryCodes.includes(location.countryCode))) continue;
      // A province identifier must not inherit one city's label. Keep the evidenced city separately.
      const regionId = location.regionId ?? location.region;
      const entries = [
        ...(regionId ? [{ id: regionId, label: location.region ?? regionId }] : []),
        ...(location.city ? [{ id: location.city, label: location.city }] : []),
      ];
      for (const { id, label } of entries) {
        const value = jobRegions.get(id) ?? { label, countries: new Set<string>() };
        if (location.countryCode) value.countries.add(location.countryCode);
        jobRegions.set(id, value);
      }
    }
    if (jobRegions.size) regionJobs++;
    for (const [id, value] of jobRegions) {
      const accumulated = regionOptions.get(id) ?? { label: value.label, countries: new Set<string>(), jobs: 0 };
      accumulated.jobs++;
      for (const country of value.countries) accumulated.countries.add(country);
      regionOptions.set(id, accumulated);
    }
    const facts = companies.get(job.companyId);
    if (facts?.status === "verified" && facts.ownership !== "unknown") { ownershipJobs++; ownershipValues.add(facts.ownership); }
    if (facts?.status === "verified" && facts.jurisdictions.length) {
      controllerJobs++;
      for (const country of facts.jurisdictions) controllerValues.add(country);
      if (facts.jurisdictionComplete) completeControllerJobs++;
    }
    const jobSourceIds = new Set(job.listingIds.flatMap((id) => {
      const listing = listings.get(id);
      return listing && (!listing.canonicalJobId || listing.canonicalJobId === job.id) && sources.has(listing.sourceId) ? [listing.sourceId] : [];
    }));
    if (jobSourceIds.size) sourceJobs++;
    for (const id of jobSourceIds) {
      const accumulated = sourceOptions.get(id) ?? { label: sources.get(id)!.attribution.label, jobs: 0 };
      accumulated.jobs++; sourceOptions.set(id, accumulated);
    }
  }
  const anchorRequired = !options.anchor || !Wgs84CoordinateSchema.safeParse({ latitude: options.anchor.latitude,
    longitude: options.anchor.longitude, coordinateSystem: options.anchor.coordinateSystem }).success;
  return {
    totalJobs,
    salary: { ...metric(salaryJobs), sortSupported: sortJobs > 0, sortJobs, rawJobs, originalAnnualJobs, ambiguousJobs, estimatedJobs, fxBlockedJobs, reasons },
    map: metric(mapJobs),
    distance: { ...metric(distanceJobs), ready: distanceJobs > 0 && !anchorRequired, anchorRequired, preciseJobs, estimatedJobs: estimatedDistanceJobs },
    ownership: { ...metric(ownershipJobs), values: [...ownershipValues].sort() },
    controller: { ...metric(controllerJobs), values: [...controllerValues].sort(), completeJobs: completeControllerJobs },
    country: { ...metric(countryJobs), values: [...countryValues].sort() },
    region: { ...metric(regionJobs), options: [...regionOptions].map(([id, value]) => ({ id, label: value.label, jobs: value.jobs, countryCodes: [...value.countries].sort() })).sort((a, b) => a.id.localeCompare(b.id)) },
    source: { ...metric(sourceJobs), options: [...sourceOptions].map(([id, value]) => ({ id, ...value })).sort((a, b) => a.id.localeCompare(b.id)) },
  };
}
