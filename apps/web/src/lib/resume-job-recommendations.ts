import type { FactBase } from "@better-me/core";
import { getSearchTermMatchQuality, normalizeSearchText, type AtlasDataset, type SourceListing } from "@better-me/opportunities";
import { buildChinaRegionFilter, matchDisclosedChinaCities } from "../components/atlas/china-regions";

// These are spelling equivalents, not related technologies: knowing WPF is not evidence of C#.
const technologies: readonly (readonly string[])[] = [
  ["C#", "csharp"], ["C++", "cpp"], ["C"], [".NET", "dotnet"], ["ASP.NET"], ["WPF"], ["WinForms", "winform"],
  ["Java"], ["JavaScript", "JS"], ["TypeScript", "TS"], ["React", "React.js", "ReactJS"], ["Vue", "Vue.js", "VueJS"],
  ["Node.js", "NodeJS"], ["Next.js", "NextJS"], ["Angular"], ["Python"], ["Go", "Golang"], ["Rust"], ["PHP"], ["Swift"],
  ["Kotlin"], ["Spring Boot", "SpringBoot"], ["Spring"], ["MyBatis"], ["Django"], ["FastAPI"], ["Flask"],
  ["SQL"], ["MySQL"], ["PostgreSQL", "Postgres"], ["SQL Server", "MSSQL"], ["Redis"], ["MongoDB"],
  ["Docker"], ["Kubernetes", "K8s"], ["Linux"], ["AWS"], ["Azure"], ["Git"], ["RabbitMQ"], ["Kafka"],
  ["PLC"], ["SCADA"], ["WCS"], ["RCS"], ["MES"], ["WMS"], ["Qt"], ["ABP"], ["PyTorch"], ["TensorFlow"],
];
const textOf = (value?: { zh?: string; en?: string }) => [value?.zh, value?.en].filter(Boolean).join(" / ");
const unique = (values: string[], max: number) => [...new Map(values.filter(s => s.trim()).map(s => [normalizeSearchText(s), s.trim()])).values()].slice(0, max);
const has = (text: string, term: string) => getSearchTermMatchQuality(text, normalizeSearchText(term), false) > 0;
const spellings = (label: string): readonly string[] => technologies.find(group => group.some(alias => normalizeSearchText(alias) === normalizeSearchText(label))) ?? [label];
const hasSkill = (text: string, label: string) => spellings(label).some(alias => has(text, alias));

const roleGroups = [
  ["前端", "frontend", "front end"], ["后端", "backend", "back end"], ["全栈", "fullstack", "full stack"],
  ["上位机", "工控", "industrial software"], ["嵌入式", "embedded"], ["测试", "tester", "qa", "test engineer"],
  ["数据分析", "data analyst"], ["算法", "machine learning"], ["运维", "devops", "sre"],
  ["产品经理", "product manager"], ["设计师", "designer"], ["移动端", "mobile", "android", "ios"],
];

export type RecommendationProfile = {
  roles: string[]; skills: string[]; tags: string[]; location: string; locationAliases: string[]; countryCode?: string;
};
export function extractRecommendationProfile(factBase: FactBase): RecommendationProfile {
  const experiences = factBase.experiences.filter(exp => exp.type !== "education");
  const declaredSkills = experiences.flatMap(exp => exp.techStack);
  const prose = normalizeSearchText(experiences.map(exp => [textOf(exp.title), ...exp.claims.map(claim => textOf(claim.text))].join(" ")).join(" "));
  const recognized = technologies.filter(group => group.some(alias => has(prose, alias))).map(group => group[0]!);
  const skills = unique([...declaredSkills.flatMap(skill => skill.split(/[,，;；、|]/)), ...recognized].map(skill => spellings(skill.trim())[0]!), 24);
  const tags = unique(experiences.flatMap(exp => exp.claims.flatMap(claim => claim.tags)).filter(tag => !skills.some(skill => spellings(skill).some(alias => normalizeSearchText(alias) === normalizeSearchText(tag)))), 16);
  const roles = unique((factBase.profile.targetRoles.length ? factBase.profile.targetRoles : experiences.slice(0, 2).map(exp => exp.title)).map(textOf), 4);
  const location = textOf(factBase.profile.location);
  const city = matchDisclosedChinaCities({ countryCode: "CN", raw: location })[0];
  const filter = city ? buildChinaRegionFilter({ provinceCode: city.province.code, cityCode: city.city.code }) : undefined;
  // Use the most specific disclosed city group. A district or precise home address never leaves the browser.
  const locationAliases = filter?.workRegionGroups.at(-1) ?? (location ? unique(location.split(/\s*[/|,，]\s*/), 6) : []);
  return { roles, skills, tags, location, locationAliases, ...(city ? { countryCode: "CN" } : {}) };
}

export type RecommendedJob = {
  id: string; title: string; company: string; description: string; location: string; salary?: string;
  sourceUrl: string; sourcePlatform: string; observedAt?: string; status: "open" | "unknown";
  matchedSkills: string[]; matchedTags: string[]; roleMatched: boolean;
  locationMatch: "same-area" | "other-area" | "unknown" | "unspecified";
  unmentionedSkills: string[]; score: number;
};
export type RecommendationResult = { jobs: RecommendedJob[]; candidates: number; scanned: number; excludedClosed: number };
// Bounded server search results deliberately omit the large observation/history tables.
export type RecommendationPool = Pick<AtlasDataset, "jobs" | "companies" | "locations" | "snapshots"> & {
  listings: Array<Pick<SourceListing, "id" | "sourceId" | "canonicalUrl">>;
  sources: Array<{ sourceId: string; name: string; adapterId: string; attribution: { label: string } }>;
  compensations: Array<{ id: string; raw: string }>;
};

export function recommendationSourceUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Read-only, explainable ranking. Scores order evidence; they are never a hiring probability. */
export async function recommendResumeJobs(dataset: RecommendationPool, profile: RecommendationProfile, options: {
  signal?: AbortSignal; sameAreaOnly?: boolean; limit?: number;
} = {}): Promise<RecommendationResult> {
  const companies = new Map(dataset.companies.map(company => [company.id, company]));
  const locations = new Map(dataset.locations.map(location => [location.id, location]));
  const listings = new Map(dataset.listings.map(listing => [listing.id, listing]));
  const sources = new Map(dataset.sources.map(source => [source.sourceId, source]));
  const snapshots = new Map(dataset.snapshots.map(snapshot => [snapshot.id, snapshot]));
  const compensations = new Map(dataset.compensations.map(salary => [salary.id, salary.raw]));
  const roleText = normalizeSearchText(profile.roles.join(" "));
  const directions = roleGroups.filter(group => group.some(term => has(roleText, term)));
  const rankedByIdentity = new Map<string, RecommendedJob>();
  let excludedClosed = 0;
  for (const [index, job] of dataset.jobs.entries()) {
    options.signal?.throwIfAborted();
    // Yield between batches so large local indexes never hold the Stop button hostage.
    if (index > 0 && index % 200 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (job.status === "closed") { excludedClosed++; continue; }
    const company = companies.get(job.companyId);
    const listing = job.listingIds.map(id => listings.get(id)).find(item => recommendationSourceUrl(item?.canonicalUrl));
    const snapshot = job.selectedSnapshotId ? snapshots.get(job.selectedSnapshotId) : undefined;
    const sourceUrl = recommendationSourceUrl(snapshot?.sourceUrl) ?? recommendationSourceUrl(listing?.canonicalUrl);
    if (!company || !sourceUrl || /\.(?:invalid|test|example)(?:[:/]|$)|https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:[:/]|$)/i.test(sourceUrl)) continue;
    const source = listing ? sources.get(listing.sourceId) : undefined;
    if (source && /demo|synthetic|fixture|演示|合成示例/i.test(`${source.adapterId} ${source.name}`)) continue;
    const titleText = normalizeSearchText(job.title.value);
    const fullText = normalizeSearchText(`${job.title.value} ${job.description}`);
    const matchedSkills = profile.skills.filter(skill => hasSkill(fullText, skill));
    const matchedTags = profile.tags.filter(tag => has(fullText, tag));
    const roleMatched = directions.some(group => group.some(term => has(titleText, term)))
      || profile.roles.some(role => role.split(" / ").some(term => has(titleText, term)));
    // A city match or generic job title alone must not outweigh a different technical stack.
    if (profile.skills.length ? !matchedSkills.length && !matchedTags.length : !roleMatched && !matchedTags.length) continue;
    const places = job.locationIds.flatMap(id => locations.get(id) ? [locations.get(id)!] : []);
    const sameArea = places.some(place => (!profile.countryCode || !place.countryCode || place.countryCode === profile.countryCode)
      && profile.locationAliases.some(alias => [place.city, place.region, place.raw].some(field => field && has(normalizeSearchText(field), alias))));
    const locationMatch: RecommendedJob["locationMatch"] = !profile.location ? "unspecified" : sameArea ? "same-area" : places.length ? "other-area" : "unknown";
    if (options.sameAreaOnly && profile.location && !sameArea) continue;
    const key = `${normalizeSearchText(company.names[0]!)}:${titleText}:${unique(places.map(place => normalizeSearchText(place.city ?? place.raw)), 20).sort().join(",")}`;
    const unmentionedSkills = technologies.filter(group => group.some(alias => has(fullText, alias))
      && !profile.skills.some(skill => spellings(skill).some(alias => group.some(term => normalizeSearchText(term) === normalizeSearchText(alias)))))
      .map(group => group[0]!).slice(0, 4);
    const score = matchedSkills.length * 10 + (profile.skills.length ? matchedSkills.length / profile.skills.length * 24 : 0)
      + matchedTags.length * 7 + (roleMatched ? 18 : 0);
    const candidate: RecommendedJob = { id: job.id, title: job.title.value, company: company.names[0]!, description: job.description,
      location: unique(places.map(place => [...new Set([place.city, place.region].filter(Boolean))].join(" · ") || place.raw), 3).join(" / "),
      salary: job.compensationIds.map(id => compensations.get(id)).filter(Boolean).join(" / ") || undefined,
      sourceUrl, sourcePlatform: source?.attribution.label ?? source?.name ?? "来源待核实",
      observedAt: snapshot?.createdAt, status: job.status, matchedSkills, matchedTags, roleMatched, locationMatch, unmentionedSkills, score };
    const previous = rankedByIdentity.get(key);
    if (!previous || candidate.score > previous.score || (candidate.score === previous.score && candidate.status === "open" && previous.status !== "open")) rankedByIdentity.set(key, candidate);
  }
  options.signal?.throwIfAborted();
  const ranked = [...rankedByIdentity.values()];
  const locationPriority = (item: RecommendedJob) => item.locationMatch === "same-area" ? 1 : 0;
  ranked.sort((a, b) => locationPriority(b) - locationPriority(a) || b.score - a.score || a.id.localeCompare(b.id));
  return { jobs: ranked.slice(0, Math.max(1, Math.min(options.limit ?? 3, 6))), candidates: ranked.length, scanned: dataset.jobs.length, excludedClosed };
}
