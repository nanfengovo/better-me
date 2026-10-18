import { z } from "zod";
import { AtlasDatasetSchema, CountryCodeSchema, EntityIdSchema, type AtlasDataset, type CanonicalJob, type Company, type JobLocation } from "./schema.js";
import { deriveEntityId } from "./identity.js";
import { normalizeCompensation, salaryMetric, FxSnapshotSchema, type FxSnapshot } from "./compensation.js";
import { distanceToLocations, evaluateLocationDistance, Wgs84CoordinateSchema } from "./geo.js";
import { classifyCompany, CompanyColorConfigSchema, resolveCompanyColor, type CompanyColorConfig } from "./colors.js";
import { normalizeGeographicName } from "./geocoding.js";

const ids = () => z.array(z.string().trim().min(1).max(240)).max(200).default([]);
const entityIds = () => z.array(EntityIdSchema).max(200).default([]);
const BoundsSchema = z.tuple([
  z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90),
  z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90),
]).refine((b) => b[1] <= b[3], "South must not exceed north");

export const JobQuerySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  search: z.object({ text: z.string().trim().max(300), mode: z.enum(["fuzzy", "exact"]).default("fuzzy") }).strict().optional(),
  market: z.enum(["domestic", "global", "overseas"]).default("global"),
  /** Country and region constraints must match the same office, including multi-office jobs. */
  workCountryCodes: z.array(CountryCodeSchema).max(300).default([]),
  workRegionIds: ids(), companyIds: entityIds(),
  /** Literal substring of original/structured place text after Unicode, whitespace and case normalization.
   * No typo correction, administrative hierarchy, translation or inferred coordinates. */
  workRegionText: z.string().trim().min(1).max(300).optional(),
  /** Explicit aliases supplied by a caller: OR within a group, AND across groups on the same office.
   * Literal field-by-field place-text matching; no inferred administrative hierarchy or coordinates. */
  workRegionGroups: z.array(z.array(z.string().trim().min(1).max(300)).min(1).max(500)).max(3).optional(),
  /** Explicit canonical-job subset; an empty subset matches nothing. */
  jobIds: z.array(EntityIdSchema).max(100_000).optional(),
  controllerJurisdictions: z.array(z.union([z.string().regex(/^[A-Z]{2}$/), z.literal("unknown")])).max(300).default([]),
  ownershipKinds: z.array(z.enum(["state", "private", "dispersed", "joint", "unknown"])).max(5).default([]), sourceIds: entityIds(),
  employmentTypes: z.array(z.enum(["social", "campus", "internship", "unknown"])).max(4).default([]),
  workModes: z.array(z.enum(["on-site", "hybrid", "remote", "unknown"])).max(4).default([]),
  statuses: z.array(z.enum(["open", "closed", "unknown"])).min(1).max(3).default(["open", "unknown"]),
  includeUnknownLocations: z.boolean().default(true),
  salary: z.object({
    currency: z.literal("CNY").default("CNY"), basis: z.literal("gross-annual-fixed").default("gross-annual-fixed"),
    range: z.object({ min: z.number().finite().nonnegative().optional(), max: z.number().finite().nonnegative().optional() }).strict()
      .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, "Invalid salary range").optional(),
    rangeMode: z.enum(["overlap", "minimum", "contained"]).default("overlap"),
    metric: z.enum(["min", "mid", "max"]).default("min"),
    includeEstimates: z.boolean().default(true), includeUnknown: z.boolean().default(true),
  }).strict().optional(),
  distance: z.object({
    anchorRef: z.string().min(1).max(200), maxKm: z.number().finite().nonnegative().max(40_100).optional(),
    allowCityEstimate: z.boolean().default(false), includeUnknown: z.boolean().default(false),
  }).strict().optional(),
  viewport: z.object({ enabled: z.boolean(), bounds: BoundsSchema }).strict().optional(),
  sort: z.object({ field: z.enum(["relevance", "salary", "distance", "updated"]).default("relevance"), direction: z.enum(["asc", "desc"]).default("desc") }).strict().default({}),
  mapLevel: z.enum(["country", "region", "city", "location"]).default("city"),
  page: z.object({ cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).default(30) }).strict().default({}),
}).strict();
export type JobQuery = z.infer<typeof JobQuerySchema>;
export type JobQueryInput = z.input<typeof JobQuerySchema>;

const QueryOptionsSchema = z.object({
  domesticCountryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(300).optional(),
  fx: FxSnapshotSchema.optional(),
  now: z.string().datetime({ offset: true }).optional(),
  colorConfig: CompanyColorConfigSchema.optional(),
  anchor: Wgs84CoordinateSchema.extend({ ref: z.string().min(1).max(200) }).optional(),
  aliases: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(100)).max(30))
    .refine((aliases) => Object.keys(aliases).length <= 1000, "Too many search aliases").optional(),
}).strict();

export class JobQueryError extends Error {
  constructor(public readonly code: "invalid-query" | "stale-cursor" | "anchor-required", message: string) { super(message); this.name = "JobQueryError"; }
}
export type QueryOptions = {
  domesticCountryCodes?: readonly string[];
  fx?: FxSnapshot;
  now?: string;
  colorConfig?: CompanyColorConfig;
  /** Ref must be replaced whenever the private position changes. Coordinates never enter query results. */
  anchor?: { ref: string; latitude: number; longitude: number; coordinateSystem: "WGS84" };
  aliases?: Record<string, string[]>;
};

export type JobSearchItem = {
  job: CanonicalJob; company: Company; locations: JobLocation[];
  salary?: ReturnType<typeof normalizeCompensation>; salaryCny?: number;
  salaryCandidates: Array<ReturnType<typeof normalizeCompensation> & { locationIds?: string[] }>;
  salarySelection: "none" | "single" | "equivalent" | "ambiguous";
  salaryLocationScope: "bound" | "unscoped";
  distance?: ReturnType<typeof distanceToLocations>;
  color: ReturnType<typeof resolveCompanyColor>;
  relevance: number; matchedFields: string[];
  sources: Array<{ sourceId: string; label: string; url?: string; listingId: string }>;
};
export type MapBucket = {
  id: string; label: string; latitude: number; longitude: number;
  jobIds: string[]; locationIds: string[]; jobCount: number; pinCount: number;
  categories: Array<{ ruleId: string; label: string; color: string; jobCount: number }>;
};
export type JobQueryResult = {
  queryId: string; snapshotVersion: number; asOf: string; normalizedQuery: JobQuery;
  totalJobs: number; companyCount: number; mappedJobs: number; unlocatedJobs: number; locationPinCount: number;
  unknownSalaryCount: number; unknownDistanceCount: number;
  items: JobSearchItem[]; nextCursor?: string; mapBuckets: MapBucket[];
  facets: { countries: Record<string, number>; controllerJurisdictions: Record<string, number>; ownership: Record<string, number>; sources: Record<string, number> };
  sourceCoverage: Array<{ sourceId: string; listings: number; lastObservedAt?: string; partial: boolean; failed: boolean; needsHuman: boolean }>;
};

const technicalAliases: Record<string, string> = { "dotnet": "dotnet", "csharp": "csharp", "cpp": "cpp", "js": "javascript", "ts": "typescript" };
const exactTechnicalTerms = new Set(["cpp", "csharp", "dotnet"]);
const asciiWord = (value: string | undefined) => value !== undefined && /^[a-z0-9_]$/.test(value);
const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/(?<![a-z0-9_])\.net(?=$|[^a-z_])|(?<=\basp)\.net(?=$|[^a-z_])|(?<=\bvb)\.net(?=$|[^a-z_])/g, " dotnet ")
    .replace(/(?<![a-z0-9_])c\+\+/g, " cpp ").replace(/(?<![a-z0-9_])c#/g, " csharp ")
    .replace(/[\p{L}\p{N}_]+/gu, (word) => Object.hasOwn(technicalAliases, word) ? technicalAliases[word]! : word).replace(/[^\p{L}\p{N}_]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Literal substring matching keeps symbol-bearing languages distinct from C and near spellings. */
function containsNormalizedPhrase(haystack: string, term: string): boolean {
  if (!term) return false;
  const words = term.split(" ");
  const protectedStart = exactTechnicalTerms.has(words[0]!);
  const protectedEnd = exactTechnicalTerms.has(words.at(-1)!);
  let offset = haystack.indexOf(term);
  while (offset !== -1) {
    const end = offset + term.length;
    if ((!protectedStart || !asciiWord(haystack[offset - 1])) && (!protectedEnd || !asciiWord(haystack[end]))) {
      let firstStart = offset, firstEnd = offset, lastStart = end, lastEnd = end;
      while (asciiWord(haystack[firstStart - 1])) firstStart--;
      while (asciiWord(haystack[firstEnd])) firstEnd++;
      while (asciiWord(haystack[lastStart - 1])) lastStart--;
      while (asciiWord(haystack[lastEnd])) lastEnd++;
      const startsInsideTechnical = firstStart < offset && exactTechnicalTerms.has(haystack.slice(firstStart, firstEnd));
      const endsInsideTechnical = lastEnd > end && exactTechnicalTerms.has(haystack.slice(lastStart, lastEnd));
      if (!startsInsideTechnical && !endsInsideTechnical) return true;
    }
    offset = haystack.indexOf(term, offset + 1);
  }
  return false;
}

/** Shared source-scope phrase check; no fuzzy rewrite of an upstream keyword or original record. */
export function includesSearchText(haystack: string, term: string): boolean {
  return containsNormalizedPhrase(normalizeSearchText(haystack), normalizeSearchText(term));
}

/** Bounded edit distance over word candidates; short technical tokens retain exact meaning. */
function closeWord(a: string, b: string): boolean {
  const max = a.length >= 8 ? 2 : 1;
  if (a.length < 4 || Math.abs(a.length - b.length) > max || /\p{Script=Han}/u.test(a + b)) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cost = Math.min(cost, beforePrevious[j - 2]! + 1);
      current.push(cost);
    }
    if (Math.min(...current) > max) return false;
    beforePrevious = previous; previous = current;
  }
  return previous[b.length]! <= max;
}

/** Shared matching quality for a normalized field and one normalized query term.
 * Callers split a query into AND terms; C#/C++/.NET retain exact token meaning. */
export function getSearchTermMatchQuality(haystack: string, term: string, fuzzy: boolean): number {
  if (containsNormalizedPhrase(haystack, term)) return 1;
  if (!fuzzy || exactTechnicalTerms.has(term)) return 0;
  if (/^\p{Script=Han}{3,}$/u.test(term)) {
    const grams = new Set(Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)));
    const hits = [...grams].filter((gram) => haystack.includes(gram)).length;
    return hits >= Math.max(2, Math.ceil(grams.size * 0.65)) ? 0.55 : 0;
  }
  return haystack.split(" ").some((word) => !exactTechnicalTerms.has(word) && closeWord(term, word)) ? 0.6 : 0;
}

function searchScore(job: CanonicalJob, company: Company, locations: JobLocation[], query: JobQuery, aliases?: Record<string, string[]>): { score: number; fields: string[] } | undefined {
  if (!query.search?.text) return { score: 0, fields: [] };
  const fields: Array<[string, number, string]> = [
    ["title", 5, job.title.value], ["company", 4, company.names.join(" ")],
    ["role", 3, [job.roleFamily?.value, job.seniority?.value].filter(Boolean).join(" ")],
    ["location", 2, locations.map((l) => [l.raw, l.countryCode, l.region, l.city].filter(Boolean).join(" ")).join(" ")],
    ["description", 1, job.description],
  ];
  const normalized = fields.map(([field, weight, value]) => ({ field, weight, value: normalizeSearchText(value) }));
  const terms = normalizeSearchText(query.search.text).split(" ").filter(Boolean);
  if (!terms.length) return { score: 0, fields: [] };
  let score = 0;
  const matched = new Set<string>();
  for (const term of terms) {
    const alternatives = [term, ...(aliases && Object.hasOwn(aliases, term) ? aliases[term]! : []).map(normalizeSearchText).filter(Boolean)];
    let best = 0;
    for (const field of normalized) {
      const quality = Math.max(...alternatives.map((candidate) => getSearchTermMatchQuality(field.value, candidate, query.search!.mode === "fuzzy")));
      if (quality) { matched.add(field.field); best = Math.max(best, quality * field.weight); }
    }
    if (!best) return undefined;
    score += best;
  }
  return { score, fields: [...matched] };
}

function companyFacts(company: Company): { countries: string[]; ownership: string[] } {
  const facts = classifyCompany(company);
  return { countries: [...facts.jurisdictions, ...(!facts.jurisdictionComplete ? ["unknown"] : [])], ownership: [facts.ownership] };
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inBounds(location: JobLocation, bounds: [number, number, number, number]): boolean {
  const c = location.coordinates;
  if (!c) return false;
  const [west, south, east, north] = bounds;
  return c.latitude >= south && c.latitude <= north && (west <= east ? c.longitude >= west && c.longitude <= east : c.longitude >= west || c.longitude <= east);
}
function increment(target: Record<string, number>, key: string): void {
  Object.defineProperty(target, key, { value: (Object.hasOwn(target, key) ? target[key]! : 0) + 1, enumerable: true, writable: true, configurable: true });
}
function regionMatch(location: JobLocation, ids: string[]): boolean {
  return !ids.length || ids.some((id) => [location.regionId, location.countryCode, location.region, location.city, location.district].includes(id));
}

function regionTextMatch(location: JobLocation, text: string | undefined): boolean {
  return text === undefined || [...(location.userResolution ? [] : [location.raw]), location.regionId, location.region, location.city, location.district].some((value) =>
    value !== undefined && normalizeGeographicName(value).includes(text));
}

function regionGroupsMatch(location: JobLocation, groups: string[][]): boolean {
  if (!groups.length) return true;
  const fields = [...(location.userResolution ? [] : [location.raw]), location.regionId, location.region, location.city, location.district]
    .filter((value): value is string => value !== undefined).map(normalizeGeographicName);
  return groups.every((group) => group.some((term) => fields.some((value) => value.includes(term))));
}

function filterSalary(salary: JobSearchItem["salary"], query: JobQuery): boolean {
  if (!query.salary) return true;
  const interval = salary?.cnyAnnual;
  if (!interval || (!query.salary.includeEstimates && salary?.estimated)) return query.salary.includeUnknown;
  const range = query.salary.range;
  if (!range || (range.min === undefined && range.max === undefined)) return true;
  if (query.salary.rangeMode === "minimum") return interval.min === undefined ? query.salary.includeUnknown : (range.min === undefined || interval.min >= range.min) && (range.max === undefined || interval.min <= range.max);
  if (query.salary.rangeMode === "contained") {
    if ([interval.min, interval.max].some((endpoint) => endpoint !== undefined && ((range.min !== undefined && endpoint < range.min) || (range.max !== undefined && endpoint > range.max)))) return false;
    if ((range.min !== undefined && interval.min === undefined) || (range.max !== undefined && interval.max === undefined)) return query.salary.includeUnknown;
    return true;
  }
  // An unknown endpoint remains unknown. Known separation can still exclude the interval.
  if ((range.min !== undefined && interval.max !== undefined && interval.max < range.min) || (range.max !== undefined && interval.min !== undefined && interval.min > range.max)) return false;
  const inside = (value: number | undefined) => value !== undefined && (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
  return inside(interval.min) || inside(interval.max) || (interval.min !== undefined && interval.max !== undefined) || query.salary.includeUnknown;
}

function buildMapBuckets(items: JobSearchItem[], level: JobQuery["mapLevel"]): MapBucket[] {
  type Accumulator = { label: string; points: Array<{ latitude: number; longitude: number }>; jobs: Set<string>; locations: Set<string>; pins: Set<string>; categories: Map<string, { label: string; color: string; jobs: Set<string> }> };
  const buckets = new Map<string, Accumulator>();
  for (const item of items) for (const location of item.locations) {
    if (!location.coordinates) continue;
    const parts = level === "country" ? [location.countryCode ?? "unknown"] : level === "region" ? [location.countryCode, location.regionId ?? location.region ?? location.city ?? location.id] : level === "city" ? [location.countryCode, location.regionId ?? location.region, location.city ?? location.id] : [location.id];
    const id = JSON.stringify(parts);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { label: (level === "country" ? location.countryCode : level === "region" ? location.region : location.city) ?? location.raw, points: [], jobs: new Set(), locations: new Set(), pins: new Set(), categories: new Map() };
      buckets.set(id, bucket);
    }
    const pin = JSON.stringify([item.job.id, location.id]);
    if (!bucket.pins.has(pin)) bucket.points.push(location.coordinates);
    bucket.jobs.add(item.job.id); bucket.locations.add(location.id); bucket.pins.add(pin);
    let category = bucket.categories.get(item.color.ruleId);
    if (!category) { category = { label: item.color.label, color: item.color.color, jobs: new Set() }; bucket.categories.set(item.color.ruleId, category); }
    category.jobs.add(item.job.id);
  }
  return [...buckets.entries()].map(([id, bucket]) => {
    let x = 0, y = 0, z = 0;
    for (const p of bucket.points) { const lat = p.latitude * Math.PI / 180, lon = p.longitude * Math.PI / 180; x += Math.cos(lat) * Math.cos(lon); y += Math.cos(lat) * Math.sin(lon); z += Math.sin(lat); }
    // This is the centroid of observed job positions, never an invented office address.
    return { id, label: bucket.label, latitude: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, longitude: Math.atan2(y, x) * 180 / Math.PI,
      jobIds: [...bucket.jobs].sort(), locationIds: [...bucket.locations].sort(), jobCount: bucket.jobs.size, pinCount: bucket.pins.size,
      categories: [...bucket.categories.entries()].map(([ruleId, c]) => ({ ruleId, label: c.label, color: c.color, jobCount: c.jobs.size })).sort((a, b) => compareIds(a.ruleId, b.ruleId)),
    };
  }).sort((a, b) => compareIds(a.id, b.id));
}

/** Reference query implementation shared by UI, transports and tools. No network or private storage. */
export async function queryJobs(inputDataset: AtlasDataset, input: JobQueryInput, inputOptions: QueryOptions = {}): Promise<JobQueryResult> {
  const parsed = JobQuerySchema.safeParse(input);
  if (!parsed.success) throw new JobQueryError("invalid-query", "岗位查询参数不受支持。");
  const query = parsed.data;
  const parsedOptions = QueryOptionsSchema.safeParse(inputOptions);
  if (!parsedOptions.success) throw new JobQueryError("invalid-query", "查询上下文不受支持。");
  const options = parsedOptions.data;
  // Freeze derived values for the UTC calendar day so cursors survive separate requests.
  const asOf = `${new Date(options.now ?? Date.now()).toISOString().slice(0, 10)}T00:00:00.000Z`;
  const dataset = AtlasDatasetSchema.parse(inputDataset);
  if ((query.distance || query.sort.field === "distance") && (!options.anchor || options.anchor.ref !== query.distance?.anchorRef)) throw new JobQueryError("anchor-required", "请先设置本次查询的本地距离参照点。");
  const { cursor, ...page } = query.page;
  const queryId = await deriveEntityId("query", [await fingerprint({ ...query, page }), await fingerprint(dataset), await fingerprint({ domestic: options.domesticCountryCodes ?? ["CN", "HK", "MO", "TW"], fx: options.fx, asOf, aliases: options.aliases, colors: options.colorConfig })]);
  let offset = 0;
  if (cursor) {
    const match = /^(query_[a-f0-9]{64}):(\d+)$/.exec(cursor);
    if (!match || match[1] !== queryId || !Number.isSafeInteger(Number(match[2]))) throw new JobQueryError("stale-cursor", "查询或数据版本已变化，请从第一页重新查询。");
    offset = Number(match[2]);
  }
  const companies = new Map(dataset.companies.map((company) => [company.id, company]));
  const locations = new Map(dataset.locations.map((location) => [location.id, location]));
  const compensations = new Map(dataset.compensations.map((compensation) => [compensation.id, compensation]));
  const listings = new Map(dataset.listings.map((listing) => [listing.id, listing]));
  const sources = new Map(dataset.sources.map((source) => [source.sourceId, source]));
  const domestic = new Set(options.domesticCountryCodes ?? ["CN", "HK", "MO", "TW"]);
  const workRegionText = query.workRegionText === undefined ? undefined : normalizeGeographicName(query.workRegionText);
  const workRegionGroups = (query.workRegionGroups ?? []).map((group) => group.map(normalizeGeographicName));
  const hasLocationFilter = query.workCountryCodes.length > 0 || query.workRegionIds.length > 0 || workRegionText !== undefined || workRegionGroups.length > 0;
  const selectedJobIds = query.jobIds === undefined ? undefined : new Set(query.jobIds);
  const items: JobSearchItem[] = [];
  for (const job of dataset.jobs) {
    if (selectedJobIds && !selectedJobIds.has(job.id)) continue;
    if (!query.statuses.includes(job.status) || (query.companyIds.length && !query.companyIds.includes(job.companyId)) || (query.workModes.length && !query.workModes.includes(job.workMode)) || (query.employmentTypes.length && !query.employmentTypes.includes(job.employmentType))) continue;
    const company = companies.get(job.companyId)!;
    const facts = companyFacts(company);
    if ((query.controllerJurisdictions.length && !query.controllerJurisdictions.some((country) => facts.countries.includes(country))) || (query.ownershipKinds.length && !query.ownershipKinds.some((kind) => facts.ownership.includes(kind)))) continue;
    const jobListings = job.listingIds.map((id) => listings.get(id)!);
    if (query.sourceIds.length && !jobListings.some((listing) => query.sourceIds.includes(listing.sourceId))) continue;
    const jobLocations = job.locationIds.map((id) => locations.get(id)!);
    let matchedLocations = jobLocations.filter((location) => (query.includeUnknownLocations || location.countryCode !== undefined)
      && (!query.workCountryCodes.length || location.countryCode !== undefined && query.workCountryCodes.includes(location.countryCode))
      && regionMatch(location, query.workRegionIds) && regionTextMatch(location, workRegionText) && regionGroupsMatch(location, workRegionGroups)
      && (!query.viewport?.enabled || inBounds(location, query.viewport.bounds))
      && (query.market === "global" || (location.countryCode ? domestic.has(location.countryCode) === (query.market === "domestic") : query.includeUnknownLocations)));
    const spatialFilter = !query.includeUnknownLocations || query.market !== "global" || hasLocationFilter || query.viewport?.enabled;
    if (spatialFilter && !matchedLocations.length && !(query.includeUnknownLocations && !jobLocations.length && !query.viewport?.enabled && !hasLocationFilter)) continue;
    const anchor = options.anchor ? { latitude: options.anchor.latitude, longitude: options.anchor.longitude, coordinateSystem: options.anchor.coordinateSystem } : undefined;
    if (query.distance && anchor) {
      matchedLocations = matchedLocations.filter((location) => {
        const value = evaluateLocationDistance(anchor, location, { allowCityEstimate: query.distance!.allowCityEstimate }).distance;
        return value ? query.distance!.maxKm === undefined || value.km <= query.distance!.maxKm : query.distance!.includeUnknown;
      });
      if (!matchedLocations.length && (!query.distance.includeUnknown || jobLocations.length)) continue;
    }
    const relevance = searchScore(job, company, matchedLocations, query, options.aliases);
    if (!relevance) continue;
    const matchedLocationIds = new Set(matchedLocations.map((location) => location.id));
    const salaryRecords = job.compensationIds.map((id) => compensations.get(id)!).filter((compensation) => !compensation.locationIds?.length || compensation.locationIds.some((id) => matchedLocationIds.has(id)));
    const salaryCandidates = salaryRecords.map((compensation) => normalizeCompensation(compensation, { fx: options.fx, now: asOf, allowMonthlyEstimate: query.salary?.includeEstimates ?? true }));
    const metric = query.salary?.metric ?? "min";
    const comparable = salaryCandidates.filter((value) => value.cnyAnnual && (query.salary?.includeEstimates !== false || !value.estimated));
    const intervals = new Set(comparable.map((value) => JSON.stringify([value.cnyAnnual!.min, value.cnyAnnual!.max])));
    const salarySelection = intervals.size > 1 ? "ambiguous" : comparable.length > 1 ? "equivalent" : comparable.length ? "single" : "none";
    const orderedSalaries = [...(comparable.length ? comparable : salaryCandidates)].sort((a, b) => Number(a.estimated) - Number(b.estimated) || Number(b.verification === "verified") - Number(a.verification === "verified") || compareIds(a.compensationId, b.compensationId));
    const salary = salarySelection === "ambiguous" ? undefined : orderedSalaries[0];
    const salaryCny = salary ? salaryMetric(salary, metric) : undefined;
    if (!filterSalary(salary, query)) continue;
    const distance = anchor && query.distance ? distanceToLocations(anchor, matchedLocations, { allowCityEstimate: query.distance.allowCityEstimate }) : undefined;
    if (query.distance && ((!distance && !query.distance.includeUnknown) || (distance && query.distance.maxKm !== undefined && distance.km > query.distance.maxKm))) continue;
    const color = resolveCompanyColor(company, options.colorConfig);
    items.push({ job, company, locations: matchedLocations, ...(salary ? { salary } : {}), ...(salaryCny !== undefined ? { salaryCny } : {}), ...(distance ? { distance } : {}), salaryCandidates, salarySelection, salaryLocationScope: salaryRecords.some((record) => !record.locationIds?.length) ? "unscoped" : "bound", color, relevance: relevance.score, matchedFields: relevance.fields,
      sources: jobListings.map((listing) => ({ sourceId: listing.sourceId, label: sources.get(listing.sourceId)!.name, ...(listing.canonicalUrl ? { url: listing.canonicalUrl } : {}), listingId: listing.id })),
    });
  }
  const field = query.sort.field;
  const direction = query.sort.direction === "asc" ? 1 : -1;
  items.sort((a, b) => {
    const left = field === "salary" ? a.salaryCny : field === "distance" ? a.distance?.km : field === "updated" ? Date.parse(a.job.updatedAt) : a.relevance;
    const right = field === "salary" ? b.salaryCny : field === "distance" ? b.distance?.km : field === "updated" ? Date.parse(b.job.updatedAt) : b.relevance;
    if (left === undefined && right !== undefined) return 1;
    if (right === undefined && left !== undefined) return -1;
    return (left !== undefined && right !== undefined ? (left - right) * direction : 0) || compareIds(a.job.id, b.job.id);
  });
  const facets: JobQueryResult["facets"] = { countries: {}, controllerJurisdictions: {}, ownership: {}, sources: {} };
  let mappedJobs = 0, locationPinCount = 0;
  for (const item of items) {
    const mapped = new Set(item.locations.filter((l) => l.coordinates).map((l) => l.id));
    if (mapped.size) mappedJobs++;
    locationPinCount += mapped.size;
    for (const country of new Set(item.locations.map((l) => l.countryCode ?? "unknown"))) increment(facets.countries, country);
    if (!item.locations.length) increment(facets.countries, "unknown");
    for (const kind of companyFacts(item.company).ownership) increment(facets.ownership, kind);
    for (const country of companyFacts(item.company).countries) increment(facets.controllerJurisdictions, country);
    for (const sourceId of new Set(item.sources.map((s) => s.sourceId))) increment(facets.sources, sourceId);
  }
  const sourceCoverage = dataset.sources.filter((s) => !query.sourceIds.length || query.sourceIds.includes(s.sourceId)).map((source) => {
    const sourceListings = dataset.listings.filter((listing) => listing.sourceId === source.sourceId);
    const listingIds = new Set(sourceListings.map((l) => l.id));
    const observations = dataset.observations.filter((o) => listingIds.has(o.listingId)).sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || compareIds(a.id, b.id));
    const latest = new Map<string, typeof observations[number]>();
    for (const observation of observations) if (!latest.has(observation.listingId)) latest.set(observation.listingId, observation);
    // Coverage describes current indexed listings, not completion of a remote enumeration run.
    return { sourceId: source.sourceId, listings: sourceListings.length, ...(observations[0] ? { lastObservedAt: observations[0].fetchedAt } : {}), partial: [...latest.values()].some((o) => o.result === "partial"), failed: [...latest.values()].some((o) => o.result === "failed"), needsHuman: [...latest.values()].some((o) => o.result === "needs-human") };
  });
  return { queryId, snapshotVersion: dataset.revision, asOf, normalizedQuery: query,
    totalJobs: items.length, companyCount: new Set(items.map((item) => item.company.id)).size, mappedJobs, unlocatedJobs: items.length - mappedJobs, locationPinCount,
    unknownSalaryCount: items.filter((item) => item.salaryCny === undefined).length, unknownDistanceCount: items.filter((item) => !item.distance).length,
    items: items.slice(offset, offset + query.page.limit), ...(offset + query.page.limit < items.length ? { nextCursor: `${queryId}:${offset + query.page.limit}` } : {}),
    mapBuckets: buildMapBuckets(items, query.mapLevel), facets, sourceCoverage,
  };
}

export function createJobQueryService(repository: { readSnapshot(): Promise<AtlasDataset> }) {
  return { search: async (input: JobQueryInput, options?: QueryOptions) => queryJobs(await repository.readSnapshot(), input, options) };
}
