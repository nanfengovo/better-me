import type { AtlasDataset } from "@better-me/opportunities";
import {
  lookupCompanyIntelligenceBatchClient,
  type LiveBatchSearchReceipt,
} from "../../lib/platform-search-client";
import {
  getChinaDistricts,
  matchDisclosedChinaCities,
  type ChinaRegionSelection,
} from "./china-regions";
import {
  classifyEnterpriseOwnershipAndOrigin,
} from "./company-intelligence-catalog";
import { groupLiveCardsForReviewedImport } from "./live-platform-import-utils";
import type { createAtlasSourceClient } from "./service-client";

export type LivePlatformImportSummary = {
  snapshot?: AtlasDataset;
  importedPlatforms: string[];
  importFailures: Array<{
    platform: string;
    pageUrl: string;
    cards: number;
    error: string;
  }>;
  loginRequiredPlatforms: string[];
  verificationRequiredPlatforms: string[];
  totalCardsFetched: number;
  totalAdded: number;
  totalUpdated: number;
  locationsConfirmed: number;
  officeAddressesConfirmed: number;
  companiesClassified: number;
  platformCoverage: Array<{
    provider: LiveBatchSearchReceipt["results"][number]["provider"];
    platform: string;
    status: LiveBatchSearchReceipt["results"][number]["status"];
    cardsCollected: number;
    coverage: LiveBatchSearchReceipt["results"][number]["coverage"];
    error?: string;
  }>;
};

export type SnapshotEnrichmentSummary = {
  snapshot: AtlasDataset;
  locationsConfirmed: number;
  officeAddressesConfirmed: number;
  companiesClassified: number;
};

const FOREIGN_LOCATION_REGEX =
  /\b(?:switzerland|schweiz|suisse|germany|deutschland|berlin|munich|münchen|aachen|frankfurt|hamburg|stuttgart|cologne|köln|united\s+states|usa?\b|california|new\s+york|seattle|san\s+francisco|los\s+angeles|chicago|austin|boston|lincoln|omaha|london|united\s+kingdom|uk\b|great\s+britain|england|scotland|bristol|manchester|birmingham|edinburgh|france|paris|lyon|lille|marseille|lausanne|geneva|basel|amsterdam|rotterdam|utrecht|eindhoven|netherlands|nederland|australia|sydney|melbourne|brisbane|canada|toronto|vancouver|montreal|ireland|dublin|sweden|stockholm|spain|madrid|barcelona|italy|milan|rome|austria|vienna|poland|warsaw|belgium|brussels|denmark|copenhagen|norway|oslo|finland|helsinki|singapore|japan|tokyo|osaka|kyoto|korea|seoul|new\s+zealand|india|bangalore|bengaluru|zürich|zurich)\b/i;

export function isExplicitForeignLocation(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (FOREIGN_LOCATION_REGEX.test(text)) return true;
  const hasChinese = /[\u4e00-\u9fa5]/.test(text);
  if (!hasChinese && /[a-zA-Z]{3,}/.test(text) && /\b(?:office|remote|city|street|st|ave|blvd|rd|gmbh|sa|bv|nv|ag)\b/i.test(text)) {
    return true;
  }
  return false;
}

function inferChinaAreaFromRaw(
  rawText: string | undefined,
): { provinceCode: string; cityCode?: string; districtCode?: string } | undefined {
  // A search filter and an employer's name are not job-location evidence.
  // Only normalize geography literally disclosed by the captured location.
  const combinedText = rawText?.trim() ?? "";
  if (!combinedText) return undefined;

  // Never align explicit foreign locations (e.g. Zurich, Switzerland, Berlin, Remote - US) to China
  if (isExplicitForeignLocation(combinedText) || (rawText && isExplicitForeignLocation(rawText))) {
    return undefined;
  }

  const matches = matchDisclosedChinaCities({ countryCode: "CN", raw: combinedText });
  if (matches.length > 0) {
    const first = matches[0]!;
    const provinceCode = first.province.code;
    const cityCode = first.city.code;
    const districts = getChinaDistricts(provinceCode, cityCode);
    const matchedDistrict = districts.find((d) => {
      const short = d.name.replace(/(?:新区|区|县|市)$/, "");
      return combinedText.includes(d.name) || (short.length >= 2 && combinedText.includes(short));
    });
    return {
      provinceCode,
      cityCode,
      ...(matchedDistrict ? { districtCode: matchedDistrict.code } : {}),
    };
  }

  return undefined;
}

export async function enrichSnapshotCompaniesAndOffices(options: {
  client: ReturnType<typeof createAtlasSourceClient>;
  snapshot?: AtlasDataset;
  jobIds?: Iterable<string>;
  fallbackChinaSelection?: ChinaRegionSelection;
  enableWebSearch?: boolean;
  signal?: AbortSignal;
}): Promise<SnapshotEnrichmentSummary> {
  const { client, signal } = options;
  let snapshot = options.snapshot ?? (await client.snapshot({ signal }));
  const targetIdSet = options.jobIds ? new Set(options.jobIds) : undefined;
  const targetJobs =
    targetIdSet && targetIdSet.size > 0
      ? snapshot.jobs.filter((j) => targetIdSet.has(j.id))
      : snapshot.jobs;
  // Enrich all targeted new/updated jobs so none are left unconfirmed or unmapped
  const activeEnrichJobs = targetJobs;

  let locationsConfirmed = 0;
  const officeAddressesConfirmed = 0;
  let companiesClassified = 0;

  // Step 0: Dynamically query backend company & office intelligence tool (live web search + dynamic geocoding + cache)
  const companyMap = new Map(snapshot.companies.map((c) => [c.id, c]));
  const locationMap = new Map(snapshot.locations.map((loc) => [loc.id, loc]));
  const uniqueTargetCompanyIds = [...new Set(activeEnrichJobs.map((j) => j.companyId))];
  const batchLookupItems = uniqueTargetCompanyIds
    .map((companyId) => {
      const company = companyMap.get(companyId);
      if (!company) return undefined;
      const cJobs = targetJobs.filter((j) => j.companyId === companyId);
      const locTexts = cJobs.flatMap((j) =>
        j.locationIds.map((id) => locationMap.get(id)?.raw).filter((v): v is string => Boolean(v)),
      );
      return {
        companyId,
        companyName: company.names[0] ?? "",
        rawLocation: locTexts[0] ?? "",
        jobTexts: cJobs.slice(0, 3).flatMap((j) => [j.title.value, j.description.slice(0, 600)]),
        locationTexts: locTexts.slice(0, 5),
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v && v.companyName));

  const dynamicIntelByCompanyId = await lookupCompanyIntelligenceBatchClient(
    batchLookupItems,
    signal,
    Boolean(options.enableWebSearch),
  );

  // Step 1: Confirm China administrative region for unconfirmed locations
  const processedLocationIds = new Set<string>();
  for (const job of activeEnrichJobs) {
    if (signal?.aborted) break;
    for (const locationId of job.locationIds) {
      if (signal?.aborted) break;
      if (processedLocationIds.has(locationId)) continue;
      const loc = locationMap.get(locationId);
      if (!loc || loc.countryCode) continue;
      processedLocationIds.add(locationId);

      const chinaArea = inferChinaAreaFromRaw(loc.raw);
      if (!chinaArea) continue;

      try {
        const proposal = {
          locationKind: "office" as const,
          countryCode: "CN",
          area: {
            kind: "china-catalog" as const,
            ...chinaArea,
          },
        };
        const reason = `按平台卡片披露原文规范行政地区：${loc.raw}`;
        const preview = await client.previewLocationConfirmation(
          {
            jobId: job.id,
            locationId,
            expectedRevision: snapshot.revision,
            proposal,
            reason,
          },
          { signal },
        );
        const confirmed = await client.confirmLocation(
          {
            jobId: job.id,
            locationId,
            expectedRevision: preview.expectedRevision,
            proposal,
            reason,
            previewFingerprint: preview.previewFingerprint,
            reviewed: true,
          },
          { signal, idempotencyKey: `live-loc-${crypto.randomUUID()}` },
        );
        snapshot = { ...snapshot, revision: confirmed.revision };
        locationsConfirmed += 1;
      } catch {
        try {
          snapshot = await client.snapshot({ signal });
        } catch {}
      }
    }
  }

  // Step 2: Preserve source-backed office addresses only. Company intelligence
  // currently has no job-bound address evidence or coordinate provenance. Its
  // catalog hubs / deterministic jitter must never be written as an office or
  // impersonate a manual user confirmation. Exact addresses use the separate
  // reviewed source-disclosure / office-confirmation flow.
  const refreshedLocationMap = new Map(snapshot.locations.map((loc) => [loc.id, loc]));
  const listingMap = new Map(snapshot.listings.map((l) => [l.id, l]));

  // Step 3: Classify & confirm company ownership & origin country (外企国家、合资、央国企、私企)
  const targetCompanyIds = new Set(activeEnrichJobs.map((j) => j.companyId));
  const observationMap = new Map(snapshot.observations.map((o) => [o.id, o]));
  const companyToEvidence = new Map<
    string,
    { observationId: string; sourceUrl: string; observedAt: string }
  >();
  for (const job of snapshot.jobs) {
    if (companyToEvidence.has(job.companyId)) continue;
    const titleEv = job.title.evidence[0];
    if (titleEv && observationMap.has(titleEv.observationId)) {
      companyToEvidence.set(job.companyId, {
        observationId: titleEv.observationId,
        sourceUrl: titleEv.sourceUrl,
        observedAt: titleEv.observedAt,
      });
      continue;
    }
    for (const lid of job.listingIds) {
      const listing = listingMap.get(lid);
      const obsId = listing?.observationIds[0];
      const obs = obsId ? observationMap.get(obsId) : undefined;
      if (obs) {
        companyToEvidence.set(job.companyId, {
          observationId: obs.id,
          sourceUrl:
            listing?.canonicalUrl && /^https?:\/\//i.test(listing.canonicalUrl)
              ? listing.canonicalUrl
              : "https://www.zhipin.com/",
          observedAt: obs.fetchedAt,
        });
        break;
      }
    }
  }
  const fallbackObs = snapshot.observations[0];

  for (const companyId of targetCompanyIds) {
    if (signal?.aborted) break;
    const company = snapshot.companies.find((c) => c.id === companyId);
    if (!company) continue;
    if (company.manualOverrides.length > 0 || company.ultimateControllers.verification === "verified") {
      continue;
    }

    const companyName = company.names[0] ?? "";
    const companyJobs = snapshot.jobs.filter((j) => j.companyId === companyId);
    const jobTexts = companyJobs.flatMap((j) => [j.title.value, j.description]);
    const locationTexts = companyJobs.flatMap((j) =>
      j.locationIds
        .map((id) => refreshedLocationMap.get(id)?.raw)
        .filter((v): v is string => Boolean(v)),
    );
    const profile =
      dynamicIntelByCompanyId[companyId] ??
      classifyEnterpriseOwnershipAndOrigin({
        companyName,
        jobTexts,
        locationTexts,
      });
    const baseEv =
      company.ultimateControllers.evidence[0] ??
      companyToEvidence.get(companyId) ??
      (fallbackObs
        ? {
            observationId: fallbackObs.id,
            sourceUrl: "https://www.zhipin.com/",
            observedAt: fallbackObs.fetchedAt,
          }
        : undefined);
    if (!baseEv) continue;

    try {
      const proposal = {
        controllers: profile.controllers,
        evidence: [
          {
            observationId: baseEv.observationId,
            sourceUrl: baseEv.sourceUrl,
            observedAt: baseEv.observedAt,
            quote: `${companyName} — ${profile.categoryLabel}`,
          },
        ],
        reason: `${profile.reason} [${profile.categoryLabel}]`,
      };
      const preview = await client.previewCompanyControllerOverride(
        {
          companyId,
          expectedRevision: snapshot.revision,
          proposal,
        },
        { signal },
      );
      const confirmed = await client.confirmCompanyControllerOverride(
        {
          companyId,
          expectedRevision: snapshot.revision,
          proposal,
          previewFingerprint: preview.previewFingerprint,
          reviewed: true,
        },
        { signal, idempotencyKey: `live-ctrl-${crypto.randomUUID()}` },
      );
      snapshot = { ...snapshot, revision: confirmed.revision };
      companiesClassified += 1;
    } catch {
      try {
        snapshot = await client.snapshot({ signal });
      } catch {}
    }
  }

  if (locationsConfirmed > 0 || officeAddressesConfirmed > 0 || companiesClassified > 0) {
    snapshot = await client.snapshot({ signal });
  }
  return {
    snapshot,
    locationsConfirmed,
    officeAddressesConfirmed,
    companiesClassified,
  };
}

export async function importAndConfirmLivePlatformResults(options: {
  client: ReturnType<typeof createAtlasSourceClient>;
  batchReceipt: LiveBatchSearchReceipt;
  fallbackChinaSelection?: ChinaRegionSelection;
  signal?: AbortSignal;
}): Promise<LivePlatformImportSummary> {
  const { client, batchReceipt, fallbackChinaSelection, signal } = options;
  const importedPlatforms: string[] = [];
  const importFailures: LivePlatformImportSummary["importFailures"] = [];
  const loginRequiredPlatforms: string[] = [];
  const verificationRequiredPlatforms: string[] = [];
  let totalCardsFetched = 0;
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const res of batchReceipt.results) {
    if (res.status === "login_required") loginRequiredPlatforms.push(res.platform);
    else if (res.status === "verification_required") verificationRequiredPlatforms.push(res.platform);
    if (res.status === "ready" && res.cards.length > 0) {
      totalCardsFetched += res.cards.length;
    }
  }

  const readyProviders = batchReceipt.results.filter(
    (r) => r.status === "ready" && r.cards.length > 0,
  );
  if (readyProviders.length === 0) {
    return {
      importedPlatforms,
      importFailures,
      loginRequiredPlatforms,
      verificationRequiredPlatforms,
      totalCardsFetched,
      totalAdded,
      totalUpdated,
      locationsConfirmed: 0,
      officeAddressesConfirmed: 0,
      companiesClassified: 0,
      platformCoverage: batchReceipt.results.map((result) => ({
        provider: result.provider, platform: result.platform, status: result.status,
        cardsCollected: result.cards.length, coverage: result.coverage,
        ...(result.error ? { error: result.error } : {}),
      })),
    };
  }

  let snapshot = await client.snapshot({ signal });
  const touchedJobIds = new Set<string>();

  for (const providerResult of readyProviders) {
    if (signal?.aborted) break;
    let providerImportedCount = 0;
    const chunks = groupLiveCardsForReviewedImport(providerResult.cards, providerResult.provider);
    for (const { pageUrl, cards: chunk } of chunks) {
      if (signal?.aborted) break;
      try {
        const preview = await client.previewReviewedCards(
          {
            provider: providerResult.provider,
            pageUrl,
            capturedAt: batchReceipt.capturedAt,
            cards: chunk,
            expectedRevision: snapshot.revision,
          },
          { signal },
        );
        const receipt = await client.importReviewedCards(
          {
            provider: providerResult.provider,
            pageUrl,
            capturedAt: batchReceipt.capturedAt,
            cards: chunk,
            expectedRevision: preview.expectedRevision,
            previewFingerprint: preview.previewFingerprint,
            reviewed: true,
          },
          { signal, idempotencyKey: `live-batch-${crypto.randomUUID()}` },
        );
        snapshot = { ...snapshot, revision: receipt.revision };
        totalAdded += receipt.counts.newJobs;
        totalUpdated += receipt.counts.updatedJobs;
        providerImportedCount += chunk.length;
        for (const id of receipt.jobIds) touchedJobIds.add(id);
      } catch (error) {
        importFailures.push({
          platform: providerResult.platform,
          pageUrl,
          cards: chunk.length,
          error: error instanceof Error ? error.message : "岗位卡片入库失败",
        });
        try {
          snapshot = await client.snapshot({ signal });
        } catch {}
      }
    }
    if (providerImportedCount > 0) {
      importedPlatforms.push(`${providerResult.platform}(${providerImportedCount}岗)`);
    }
  }

  if (totalAdded > 0 || totalUpdated > 0) {
    snapshot = await client.snapshot({ signal });
  }

  const enriched = await enrichSnapshotCompaniesAndOffices({
    client,
    snapshot,
    ...(touchedJobIds.size > 0 ? { jobIds: touchedJobIds } : {}),
    ...(fallbackChinaSelection ? { fallbackChinaSelection } : {}),
    ...(signal ? { signal } : {}),
  });

  return {
    snapshot: enriched.snapshot,
    importedPlatforms,
    importFailures,
    loginRequiredPlatforms,
    verificationRequiredPlatforms,
    totalCardsFetched,
    totalAdded,
    totalUpdated,
    locationsConfirmed: enriched.locationsConfirmed,
    officeAddressesConfirmed: enriched.officeAddressesConfirmed,
    companiesClassified: enriched.companiesClassified,
    platformCoverage: batchReceipt.results.map((result) => ({
      provider: result.provider, platform: result.platform, status: result.status,
      cardsCollected: result.cards.length, coverage: result.coverage,
      ...(result.error ? { error: result.error } : {}),
    })),
  };
}
