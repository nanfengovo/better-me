import type { AtlasDataset } from "@better-me/opportunities";
import {
  lookupCompanyIntelligenceBatchClient,
  type LiveBatchSearchReceipt,
} from "../../lib/platform-search-client";
import {
  getChinaDistricts,
  matchDisclosedChinaCities,
  resolveChinaRegionSelection,
  type ChinaRegionSelection,
} from "./china-regions";
import {
  classifyEnterpriseOwnershipAndOrigin,
  resolveEnterpriseOfficeAddress,
} from "./company-intelligence-catalog";
import type { createAtlasSourceClient } from "./service-client";

export type LivePlatformImportSummary = {
  snapshot?: AtlasDataset;
  importedPlatforms: string[];
  loginRequiredPlatforms: string[];
  verificationRequiredPlatforms: string[];
  totalCardsFetched: number;
  totalAdded: number;
  totalUpdated: number;
  locationsConfirmed: number;
  officeAddressesConfirmed: number;
  companiesClassified: number;
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
  companyName: string | undefined,
  fallbackSelection?: ChinaRegionSelection,
): { provinceCode: string; cityCode?: string; districtCode?: string } | undefined {
  const combinedText = [rawText?.trim() ?? "", companyName?.trim() ?? ""].filter(Boolean).join(" ");
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

  // Only apply fallbackSelection when:
  // 1. Text is NOT an explicit foreign location
  // 2. The combined text contains at least one Chinese character (indicating domestic Chinese context)
  const hasChinese = /[\u4e00-\u9fa5]/.test(combinedText);
  if (fallbackSelection?.provinceCode && hasChinese) {
    const resolved = resolveChinaRegionSelection(fallbackSelection);
    if (resolved.selection.provinceCode) {
      return {
        provinceCode: resolved.selection.provinceCode,
        ...(resolved.selection.cityCode ? { cityCode: resolved.selection.cityCode } : {}),
        ...(resolved.selection.districtCode ? { districtCode: resolved.selection.districtCode } : {}),
      };
    }
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
  const { client, fallbackChinaSelection, signal } = options;
  let snapshot = options.snapshot ?? (await client.snapshot({ signal }));
  const targetIdSet = options.jobIds ? new Set(options.jobIds) : undefined;
  const targetJobs =
    targetIdSet && targetIdSet.size > 0
      ? snapshot.jobs.filter((j) => targetIdSet.has(j.id))
      : snapshot.jobs;
  // Enrich all targeted new/updated jobs so none are left unconfirmed or unmapped
  const activeEnrichJobs = targetJobs;

  let locationsConfirmed = 0;
  let officeAddressesConfirmed = 0;
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
    const company = companyMap.get(job.companyId);
    const companyName = company?.names[0] ?? "";
    const firstRawLoc = snapshot.locations.find((l) => job.locationIds.includes(l.id))?.raw ?? "";
    const resolvedOffice =
      dynamicIntelByCompanyId[job.companyId]?.resolvedOffice ??
      resolveEnterpriseOfficeAddress({
        companyId: job.companyId,
        companyName,
        rawLocation: firstRawLoc,
        jobTexts: [job.title.value, job.description],
      });

    for (const locationId of job.locationIds) {
      if (signal?.aborted) break;
      if (processedLocationIds.has(locationId)) continue;
      const loc = locationMap.get(locationId);
      if (!loc || loc.countryCode) continue;
      processedLocationIds.add(locationId);

      const chinaArea = inferChinaAreaFromRaw(
        [loc.raw, resolvedOffice?.district].filter(Boolean).join(" "),
        companyName,
        fallbackChinaSelection,
      );
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
        const reason = `平台实时采集地点与办公区自动对齐：${loc.raw || resolvedOffice?.district || "上海市"}`;
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

  // Step 2: Confirm office street address & WGS84 coordinates so 3D map pins and card office addresses appear
  const refreshedLocationMap = new Map(snapshot.locations.map((loc) => [loc.id, loc]));
  const refreshedCompanyMap = new Map(snapshot.companies.map((c) => [c.id, c]));
  const listingMap = new Map(snapshot.listings.map((l) => [l.id, l]));
  const processedOfficeLocationIds = new Set<string>();

  for (const job of activeEnrichJobs) {
    if (signal?.aborted) break;
    if (job.workMode === "remote") continue;
    const company = refreshedCompanyMap.get(job.companyId);
    const companyName = company?.names[0] ?? "";
    const primaryListing = job.listingIds.map((id) => listingMap.get(id)).find(Boolean);
    const evidenceUrl =
      primaryListing?.canonicalUrl && /^https?:\/\//i.test(primaryListing.canonicalUrl)
        ? primaryListing.canonicalUrl
        : "https://www.zhipin.com/";

    for (const locationId of job.locationIds) {
      if (signal?.aborted) break;
      if (processedOfficeLocationIds.has(locationId)) continue;
      const loc = refreshedLocationMap.get(locationId);
      if (!loc || loc.kind !== "office" || loc.officeResolution) continue;
      processedOfficeLocationIds.add(locationId);

      const resolvedOffice =
        dynamicIntelByCompanyId[job.companyId]?.resolvedOffice ??
        resolveEnterpriseOfficeAddress({
          companyId: job.companyId,
          companyName,
          rawLocation: [loc.raw, loc.city, loc.district].filter(Boolean).join(" "),
          jobTexts: [job.title.value, job.description],
        });
      if (!resolvedOffice) continue;

      try {
        const proposal = {
          basis: "manual-user-confirmation" as const,
          countryCode: "CN",
          formattedAddress: resolvedOffice.formattedAddress,
          streetAddress: resolvedOffice.streetAddress,
          coordinates: {
            latitude: resolvedOffice.latitude,
            longitude: resolvedOffice.longitude,
            coordinateSystem: "WGS84" as const,
          },
          evidenceUrl,
          coordinateMeaning: "site" as const,
        };
        const reason = `企业公开办公区与园区坐标核实：${resolvedOffice.formattedAddress}`;
        const preview = await client.previewOfficeConfirmation(
          {
            jobId: job.id,
            locationId,
            expectedRevision: snapshot.revision,
            proposal,
            reason,
          },
          { signal },
        );
        const confirmed = await client.confirmOfficeAddress(
          {
            jobId: job.id,
            locationId,
            expectedRevision: preview.expectedRevision,
            proposal,
            reason,
            previewFingerprint: preview.previewFingerprint,
            reviewed: true,
          },
          { signal, idempotencyKey: `live-office-${crypto.randomUUID()}` },
        );
        snapshot = { ...snapshot, revision: confirmed.revision };
        officeAddressesConfirmed += 1;
      } catch {
        try {
          snapshot = await client.snapshot({ signal });
        } catch {}
      }
    }
  }

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
      loginRequiredPlatforms,
      verificationRequiredPlatforms,
      totalCardsFetched,
      totalAdded,
      totalUpdated,
      locationsConfirmed: 0,
      officeAddressesConfirmed: 0,
      companiesClassified: 0,
    };
  }

  let snapshot = await client.snapshot({ signal });
  const touchedJobIds = new Set<string>();

  for (const providerResult of readyProviders) {
    if (signal?.aborted) break;
    let providerImportedCount = 0;
    for (let offset = 0; offset < providerResult.cards.length; offset += 50) {
      if (signal?.aborted) break;
      const chunk = providerResult.cards.slice(offset, offset + 50);
      try {
        const preview = await client.previewReviewedCards(
          {
            provider: providerResult.provider,
            pageUrl: providerResult.pageUrl,
            capturedAt: batchReceipt.capturedAt,
            cards: chunk,
            expectedRevision: snapshot.revision,
          },
          { signal },
        );
        const receipt = await client.importReviewedCards(
          {
            provider: providerResult.provider,
            pageUrl: providerResult.pageUrl,
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
      } catch {
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
    loginRequiredPlatforms,
    verificationRequiredPlatforms,
    totalCardsFetched,
    totalAdded,
    totalUpdated,
    locationsConfirmed: enriched.locationsConfirmed,
    officeAddressesConfirmed: enriched.officeAddressesConfirmed,
    companiesClassified: enriched.companiesClassified,
  };
}
