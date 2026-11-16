import type { AtlasDataset, MapBucket } from "@better-me/opportunities";
import { haversineDistanceMeters, type NearbyCompanyHit, type UserGeolocationFix } from "./prototypes/user-location";

export type NearbyIndexedBucket = {
  bucket: MapBucket;
  distanceMeters: number;
  /** True when present in local dataset across all roles, even if hidden by current active search filter. */
  outsideCurrentFilter?: boolean;
  companyKeyword?: string;
};

export type NearbyRadarTargetPoint = {
  longitude: number;
  latitude: number;
  source?: UserGeolocationFix["source"] | "viewport";
};

/** Normalizes company titles so OSM corporate entities match local indexed employers. */
export function normalizeEmployerMatchKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/(?:有限责任公司|股份有限公司|有限公司|分公司|集团|亚太研发|上海研发|中国研发|研发中心|研究开发协创中心|研究院|研究所|科技|信息|软件)/g, "")
    .replace(/[\s·\-_.]+/g, "");
}

const CROSS_SCRIPT_BRAND_ALIASES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/微软|microsoft/i, /微软|microsoft/i],
  [/英特尔|intel/i, /英特尔|intel/i],
  [/埃克森美孚|exxon/i, /埃克森美孚|exxon/i],
  [/欧姆龙|omron/i, /欧姆龙|omron/i],
  [/阿斯利康|astrazeneca/i, /阿斯利康|astrazeneca/i],
  [/东软|neusoft/i, /东软|neusoft/i],
  [/中兴|zte/i, /中兴|zte/i],
  [/中国航发|商发|aecc/i, /中国航发|商发|aecc/i],
  [/宁德时代|catl/i, /宁德时代|catl/i],
  [/华为|huawei/i, /华为|huawei/i],
  [/西门子|siemens/i, /西门子|siemens/i],
  [/博世|bosch/i, /博世|bosch/i],
  [/霍尼韦尔|honeywell/i, /霍尼韦尔|honeywell/i],
  [/日立|hitachi/i, /日立|hitachi/i],
];

function employersMatch(osmCompany: NearbyCompanyHit, datasetCompanyNames: readonly string[]): boolean {
  const candidates = [osmCompany.name, osmCompany.shortName, osmCompany.searchKeyword].filter(Boolean);
  for (const [, aliasPattern] of CROSS_SCRIPT_BRAND_ALIASES) {
    if (candidates.some((c) => aliasPattern.test(c)) && datasetCompanyNames.some((d) => aliasPattern.test(d))) {
      return true;
    }
  }
  const osmKeys = candidates.map(normalizeEmployerMatchKey).filter((k) => k.length >= 2);
  const dataKeys = datasetCompanyNames.map(normalizeEmployerMatchKey).filter((k) => k.length >= 2);
  return osmKeys.some((ok) => dataKeys.some((dk) => dk === ok || (ok.length >= 3 && dk.includes(ok)) || (dk.length >= 3 && ok.includes(dk))));
}

/**
 * Counts how many active jobs in BetterMe's local index belong to each discovered
 * surrounding employer, and supplements with verified local indexed offices near
 * `target` when provided (so nearby hiring leads also work offline).
 */
export function enrichNearbyCompaniesWithIndex(
  companies: readonly NearbyCompanyHit[],
  dataset: AtlasDataset | null | undefined,
  target?: NearbyRadarTargetPoint | null,
  radiusMeters = 2_500,
): NearbyCompanyHit[] {
  if (!dataset?.jobs?.length || !dataset?.companies?.length) {
    return [...companies];
  }

  const jobCountByCompanyId = new Map<string, number>();
  const jobsByLocation = new Map<string, Array<{ companyId: string; countKey: string }>>();
  for (const job of dataset.jobs) {
    if (job.status === "closed") continue;
    jobCountByCompanyId.set(job.companyId, (jobCountByCompanyId.get(job.companyId) ?? 0) + 1);
    for (const locId of job.locationIds ?? []) {
      const list = jobsByLocation.get(locId) ?? [];
      list.push({ companyId: job.companyId, countKey: job.id });
      jobsByLocation.set(locId, list);
    }
  }

  const companyById = new Map(dataset.companies.map((entry) => [entry.id, entry]));
  const activeCompanies = dataset.companies
    .map((entry) => ({
      id: entry.id,
      names: entry.names,
      jobCount: jobCountByCompanyId.get(entry.id) ?? 0,
    }))
    .filter((entry) => entry.jobCount > 0);

  const enriched: NearbyCompanyHit[] = companies.map((company) => {
    let matchedCount = 0;
    for (const candidate of activeCompanies) {
      if (employersMatch(company, candidate.names)) {
        matchedCount += candidate.jobCount;
      }
    }
    return matchedCount > 0
      ? { ...company, indexedJobCount: matchedCount }
      : { ...company, indexedJobCount: undefined };
  });

  if (target && target.source !== "ip" && dataset.locations?.length) {
    const addedCompanyIds = new Set<string>();
    const extras: NearbyCompanyHit[] = [];
    for (const loc of dataset.locations) {
      if (loc.kind === "remote-region" || !loc.coordinates) continue;
      if (loc.precision === "city" || loc.precision === "region" || loc.precision === "country" || loc.precision === "unknown") {
        continue;
      }
      const dist = haversineDistanceMeters(target, loc.coordinates);
      if (dist === null || dist > radiusMeters * 1.15) continue;
      const linkedJobs = jobsByLocation.get(loc.id);
      if (!linkedJobs?.length) continue;
      for (const link of linkedJobs) {
        if (addedCompanyIds.has(link.companyId)) continue;
        const company = companyById.get(link.companyId);
        if (!company?.names?.length) continue;
        const primaryName = company.names[0]!.trim();
        if (!primaryName) continue;
        if (enriched.some((existing) => employersMatch(existing, company.names))) {
          addedCompanyIds.add(link.companyId);
          continue;
        }
        addedCompanyIds.add(link.companyId);
        const stripped = primaryName
          .replace(/（[^）]{1,12}）|\([^)]{1,12}\)/g, "")
          .replace(/(?:有限责任公司|股份有限公司|有限公司|分公司)$/g, "")
          .trim() || primaryName;
        const streetAddr = loc.officeResolution?.formattedAddress || loc.streetAddress || loc.raw;
        extras.push({
          id: `dataset-${link.companyId}`,
          name: primaryName,
          shortName: stripped.length > 16 ? `${stripped.slice(0, 15)}…` : stripped,
          searchKeyword: stripped,
          kind: "company",
          longitude: loc.coordinates.longitude,
          latitude: loc.coordinates.latitude,
          distanceMeters: Math.round(dist),
          ...(streetAddr ? { streetAddress: streetAddr } : {}),
          ownershipLabel: "库内已采企业",
          ownershipColor: "#38BDF8",
          ownershipReason: "来自本机已入库真实办公地址坐标（离线/无外网亦可用）。",
          indexedJobCount: jobCountByCompanyId.get(link.companyId) ?? 1,
        });
      }
    }
    if (extras.length > 0) {
      extras.sort((a, b) => a.distanceMeters - b.distanceMeters);
      return [...enriched, ...extras];
    }
  }

  return enriched;
}

/**
 * Returns geocoded job office buckets from the user's local index sorted by proximity
 * within `maxRadiusMeters` of a radar center, decoupling surrounding all-role coverage
 * from narrow role keyword filters when `dataset` is provided.
 */
export function findNearbyIndexedOfficeBuckets(
  filteredBuckets: readonly MapBucket[],
  target: NearbyRadarTargetPoint | null | undefined,
  maxRadiusMeters = 8_000,
  dataset?: AtlasDataset | null,
): NearbyIndexedBucket[] {
  if (!target || target.source === "ip") return [];
  const matches: NearbyIndexedBucket[] = [];
  const seenLocationIds = new Set<string>();
  const seenBucketCoords = new Set<string>();

  for (const bucket of filteredBuckets) {
    if (bucket.positionBasis === "city-reference" || bucket.precision === "city" || bucket.jobCount <= 0) {
      continue;
    }
    const distanceMeters = haversineDistanceMeters(target, bucket);
    if (distanceMeters === null || distanceMeters > maxRadiusMeters) continue;
    for (const locId of bucket.locationIds) seenLocationIds.add(locId);
    seenBucketCoords.add(`${bucket.longitude.toFixed(4)},${bucket.latitude.toFixed(4)}`);
    matches.push({ bucket, distanceMeters });
  }

  if (dataset?.locations?.length && dataset?.jobs?.length) {
    const activeJobIdsByLocation = new Map<string, { jobIds: string[]; companyNames: Set<string> }>();
    const companyNameById = new Map<string, string>();
    for (const company of dataset.companies ?? []) {
      const primary = company.names?.[0]?.trim();
      if (primary) companyNameById.set(company.id, primary);
    }
    for (const job of dataset.jobs) {
      if (job.status === "closed") continue;
      const companyName = companyNameById.get(job.companyId);
      for (const locId of job.locationIds ?? []) {
        let entry = activeJobIdsByLocation.get(locId);
        if (!entry) {
          entry = { jobIds: [], companyNames: new Set() };
          activeJobIdsByLocation.set(locId, entry);
        }
        entry.jobIds.push(job.id);
        if (companyName) entry.companyNames.add(companyName);
      }
    }

    for (const loc of dataset.locations) {
      if (seenLocationIds.has(loc.id)) continue;
      if (loc.kind === "remote-region" || !loc.coordinates) continue;
      if (loc.precision === "city" || loc.precision === "region" || loc.precision === "country" || loc.precision === "unknown") {
        continue;
      }
      const dist = haversineDistanceMeters(target, loc.coordinates);
      if (dist === null || dist > maxRadiusMeters) continue;
      const linked = activeJobIdsByLocation.get(loc.id);
      if (!linked || linked.jobIds.length === 0) continue;
      const coordKey = `${loc.coordinates.longitude.toFixed(4)},${loc.coordinates.latitude.toFixed(4)}`;
      if (seenBucketCoords.has(coordKey)) continue;
      seenBucketCoords.add(coordKey);
      const companyTitle = [...linked.companyNames][0];
      const addrLabel = loc.officeResolution?.formattedAddress || loc.streetAddress || loc.raw;
      const label = companyTitle && addrLabel && !addrLabel.includes(companyTitle)
        ? `${companyTitle} · ${addrLabel}`
        : addrLabel || companyTitle || "附近已采办公点";
      matches.push({
        bucket: {
          id: `allrole:${loc.id}`,
          label,
          latitude: loc.coordinates.latitude,
          longitude: loc.coordinates.longitude,
          jobIds: linked.jobIds,
          locationIds: [loc.id],
          jobCount: linked.jobIds.length,
          pinCount: linked.jobIds.length,
          displayGrade: loc.officeResolution ? "building" : loc.precision === "address" ? "address" : "street",
          categories: [{ ruleId: "nearby-allrole", label: "全部职能", color: "#38BDF8", jobCount: linked.jobIds.length }],
        },
        distanceMeters: dist,
        outsideCurrentFilter: true,
        ...(companyTitle ? { companyKeyword: companyTitle } : {}),
      });
    }
  }

  matches.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return matches.slice(0, 12);
}
