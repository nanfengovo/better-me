import { CountryCodeSchema, getSearchTermMatchQuality, includesSearchText, normalizeSearchText } from "@better-me/opportunities";
import type { SourceJobRecord, SourceScope } from "./contracts.js";

export type SourceScopeMatch = {
  status: "matched" | "unknown" | "excluded";
  roleMatch: boolean;
  nonRoleMatch: boolean;
};

/** Source interests use the same AND-of-terms semantics as the indexed UI search.
 * OR is retained between separate interests. Place/company constraints stay literal;
 * a country and its city must be disclosed on the same office. */
export function assessSourceScopeMatch(record: SourceJobRecord, scope: SourceScope): SourceScopeMatch {
  const includes = (haystack: string, values: string[]) => !values.length || values.some((term) => includesSearchText(haystack, term));
  const officeTexts = record.locations.map((location) => [location.raw, location.countryCode, location.region, location.city].filter(Boolean).join(" "));
  const locationText = [...officeTexts, ...record.remoteEligibleRegions].join(" ");
  const matchesRegion = !scope.regions.length || scope.regions.some((term) => CountryCodeSchema.safeParse(term).success
    ? record.locations.some((location) => location.countryCode === term)
    : includesSearchText(locationText, term));
  const matchesCountryAndRegion = !scope.countryCodes?.length ? matchesRegion : record.locations.some((location) =>
    location.countryCode !== undefined && scope.countryCodes!.includes(location.countryCode)
    && (!scope.regions.length || scope.regions.some((term) => CountryCodeSchema.safeParse(term).success
      ? location.countryCode === term
      : includesSearchText([location.raw, location.region, location.city].filter(Boolean).join(" "), term))));
  const nonRoleMatch = includes(record.companyName ?? "", scope.companyNames) && matchesCountryAndRegion;
  const fields = [record.title, record.description ?? "", record.companyName ?? "", ...officeTexts].map(normalizeSearchText);
  const roleMatch = !scope.roles.length || scope.roles.some((interest) => {
    const terms = normalizeSearchText(interest).split(" ").filter(Boolean);
    return terms.length > 0 && terms.every((term) => fields.some((field) => getSearchTermMatchQuality(field, term, true) > 0));
  });
  // An unread requirement cannot supply a positive match or prove a negative one.
  const status = !nonRoleMatch ? "excluded" : roleMatch ? "matched" : record.completeness === "detail" ? "excluded" : "unknown";
  return { status, roleMatch, nonRoleMatch };
}

/** Unknown excerpts remain unresolved candidates, never confirmed keyword matches. */
export function locallyMatchesSourceScope(record: SourceJobRecord, scope: SourceScope): boolean {
  return assessSourceScopeMatch(record, scope).status === "matched";
}

export function countSourceScopeMatches(records: readonly SourceJobRecord[], scope: SourceScope): { matched: number; unknown: number; excluded: number } {
  const counts = { matched: 0, unknown: 0, excluded: 0 };
  for (const record of records) counts[assessSourceScopeMatch(record, scope).status]++;
  return counts;
}
