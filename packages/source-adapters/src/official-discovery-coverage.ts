import { includesSearchText } from "@better-me/opportunities";
import { resolvePlatformSearchRegion } from "./platform-search.js";
import { resolveSourceCountryCode } from "./source-country.js";
import type { DiscoverOfficialJobsInput } from "./official-job-discovery-contracts.js";

/** Work down the ranked groups one position at a time, preserving each employer's own ordering. */
export function interleaveEmployers<T>(ranked: readonly T[], employer: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of ranked) {
    const key = employer(item).normalize("NFKC").trim().toLowerCase();
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const ordered: T[] = [];
  for (let index = 0; ordered.length < ranked.length; index++) {
    for (const group of groups.values()) if (index < group.length) ordered.push(group[index]!);
  }
  return ordered;
}

export async function mapDiscoveryItems<T, R>(items: readonly T[], concurrency: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]!);
    }
  }));
  return results;
}

export function discoveryRegion(region?: string) {
  const explicitCountry = region ? resolveSourceCountryCode(region) : undefined;
  const city = region && !explicitCountry ? resolvePlatformSearchRegion(region) : undefined;
  const country = explicitCountry ?? city?.countryCode;
  const english = city?.platforms.linkedin ?? (country ? new Intl.DisplayNames(["en"], { type: "region" }).of(country) : undefined) ?? region;
  const matches = (location: { city?: string | null; country?: string | null; region?: string | null }) => {
    if (!region) return true;
    if (country && location.country?.toUpperCase() !== country) return false;
    if (city) return [city.name, ...city.aliases].some(name => location.city && includesSearchText(location.city, name));
    return Boolean(country || [location.city, location.region, location.country].some(part => part && includesSearchText(part, region)));
  };
  return { city, country, english, matches };
}

/** Related spellings can widen retrieval; confirmed skill labels still require the job text and the user's own skills. */
export function officialQuerySkills(input: DiscoverOfficialJobsInput) {
  const terms = input.skills.slice(0, 2);
  if (terms.some(skill => /^(?:c#|csharp|\.net|dotnet|asp\.net(?: core)?)$/i.test(skill))) {
    for (const alternate of [".NET", "C#"]) if (!terms.some(skill => skill.toLowerCase() === alternate.toLowerCase())) terms.push(alternate);
  }
  return terms;
}

export function matchedOfficialSkills(text: string, input: DiscoverOfficialJobsInput): string[] {
  return [...new Set([...input.skills, ...(input.secondarySkills ?? [])])].filter(skill => includesSearchText(text, skill));
}

export function relatedOfficialSkills(text: string, input: DiscoverOfficialJobsInput): string[] {
  const own = [...input.skills, ...(input.secondarySkills ?? [])].map(term => term.toLowerCase());
  return officialQuerySkills(input).filter(term => !own.includes(term.toLowerCase()) && includesSearchText(text, term));
}

const software = /software|developer|programmer|backend|front.?end|full.?stack|\.net|c#|软件|后端|全栈|前端|程序员|上位机/i;
export function discoveryRoleScore(title: string, input: DiscoverOfficialJobsInput): number {
  if (input.role && includesSearchText(title, input.role)) return 8;
  if (software.test(input.role) && software.test(title)) return 6;
  if (software.test(input.role) && /engineer|工程师|开发|automation/i.test(title)) return 2;
  return 0;
}

