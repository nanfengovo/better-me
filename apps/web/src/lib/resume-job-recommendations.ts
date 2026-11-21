import type { FactBase, FactClaim } from "@better-me/core";
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
  ["PLC"], ["SCADA"], ["WCS"], ["RCS"], ["MES"], ["WMS"], ["Qt"], ["ABP"], ["PyTorch"], ["TensorFlow"], ["AI Agent", "AI agents", "智能体"], ["Excel"], ["Power BI"],
];
const textOf = (value?: { zh?: string; en?: string }) => [value?.zh, value?.en].filter(Boolean).join(" / ");
const unique = (values: string[], max: number) => [...new Map(values.filter(s => s.trim()).map(s => [normalizeSearchText(s), s.trim()])).values()].slice(0, max);
const has = (text: string, term: string) => getSearchTermMatchQuality(text, normalizeSearchText(term), false) > 0;
const spellingsByName = new Map(technologies.flatMap(group => group.map(alias => [normalizeSearchText(alias), group] as const)));
const spellings = (label: string): readonly string[] => spellingsByName.get(normalizeSearchText(label)) ?? [label];
const hasSkill = (text: string, label: string) => spellings(label).some(alias => has(text, alias));
const skillTerms = technologies.map(group => ({ label: group[0]!, terms: [...new Set(group.map(normalizeSearchText))] }));
const recognizedSkills = (text: string) => skillTerms.filter(group => group.terms.some(term => getSearchTermMatchQuality(text, term, false))).map(group => group.label);

export type RecommendationClaimKind = "personal-action" | "self-report" | "negative" | "team" | "planned" | "practice" | "unconfirmed";

// A claim is one selectable source. Mixed ownership or polarity requires review before
// attributing any of its tags to this person. A missing affirmative action stays unknown.
export function classifyRecommendationClaim(claim: Pick<FactClaim, "text" | "kind" | "metric">): RecommendationClaimKind {
  const text = textOf(claim.text).normalize("NFKC");
  if (claim.kind === "interview" || claim.kind === "pitfall" || (claim.metric && !claim.metric.confirmed)) return "unconfirmed";
  if (/没有|从未|并未|未曾|尚未|没(?:有)?(?:用过|使用|接触|做过|参与|负责|掌握)|未(?:使用|接触|参与|负责|掌握)|不(?:会|熟悉|掌握|具备|擅长)|无.{0,16}(?:经验|经历)|并非本人|不是我|\b(?:never|not|no experience|no exposure|without experience|haven['’]t|hasn['’]t|didn['’]t|don['’]t|can['’]t)\b/i.test(text)) return "negative";
  if (/计划|打算|希望|准备(?:学习|使用|实现)|拟(?:学习|采用)|将(?:会|学习|使用)|\b(?:plan(?:ning)? to|intend to|aim to|would like to|will|aspire to)\b/i.test(text)) return "planned";
  if (/(?:练习|复测|训练营|模拟面试|习题|课程作业)|\b(?:practice|practised|practiced|retest|training exercise|coursework|tutorial)\b/i.test(text) || /^(?:practice|training|retest)$/.test(claim.kind)) return "practice";
  const ownerText = text.replace(/(?:为|给|帮助|支持|跨)(?:整个)?(?:团队|小组|同事|公司)/g, "");
  if (/(?:团队|小组|同事|他人|其他人|别人|我们|供应商)|(?:项目|公司|部门|平台|系统)(?:采用|使用|基于)|\b(?:we|our team|the team|colleagues?|teammates?|the project|the company|the vendor)\b/i.test(ownerText)) return "team";
  if (claim.kind === "user_statement" || /自述|自评|熟悉|熟练|擅长|了解|掌握|\b(?:familiar with|proficient in|skilled in|knowledge of)\b/i.test(text)) return "self-report";
  if (/(?:实现|使用|开发|维护|优化|设计|构建|搭建|部署|负责|主导|完成|排查|修复|交付|编写|验证|实施|集成|重构|测试|降低|提升)|\b(?:implement(?:ed)?|used|built|developed|designed|maintained|deployed|delivered|tested|reduced|improved|led|wrote|fixed|integrated|optimized)\b/i.test(text)) return "personal-action";
  return "unconfirmed";
}

/** Skills-only headers from imported resumes live in profile.traits. Keep the matched names, never the free text. */
export function skillsFromResumeTraits(traits: readonly string[]): string[] {
  return [...new Set(traits.flatMap(line => {
    const kind = classifyRecommendationClaim({ kind: "action", text: { zh: line } });
    if (["negative", "planned", "practice", "team"].includes(kind)) return [];
    return line.split(/[,，、;；\n]/u).flatMap(term => recognizedSkills(normalizeSearchText(term)));
  }))];
}

const roleGroups = [
  ["前端", "frontend", "front end"], ["后端", "backend", "back end"], ["全栈", "fullstack", "full stack"],
  ["上位机", "工控", "industrial software"], ["嵌入式", "embedded"], ["测试", "tester", "qa", "test engineer"],
  ["数据分析", "data analyst"], ["算法", "machine learning"], ["运维", "devops", "sre"],
  ["产品经理", "product manager"], ["设计师", "designer"], ["移动端", "mobile", "android", "ios"],
];

export type RecommendationProfile = {
  roles: string[]; skills: string[]; tags: string[]; location: string; locationAliases: string[]; countryCode?: string; targetRole?: string;
};
export function extractRecommendationProfile(factBase: FactBase): RecommendationProfile {
  const experiences = factBase.experiences.filter(exp => exp.type !== "education");
  const skillsFromClaims: string[] = [], declaredSkills: string[] = [], eligibleTags: string[] = [];
  for (const experience of experiences) {
    const restricted = new Set<string>();
    for (const claim of experience.claims) {
      const recognized = recognizedSkills(normalizeSearchText(textOf(claim.text)));
      if (classifyRecommendationClaim(claim) === "personal-action") {
        skillsFromClaims.push(...recognized);
        eligibleTags.push(...claim.tags);
      } else {
        // An unqualified project tech stack must not reintroduce technology explicitly
        // attributed to the team, denied or only practised in this experience.
        for (const skill of [...recognized, ...claim.tags]) restricted.add(normalizeSearchText(spellings(skill)[0]!));
      }
    }
    for (const skill of experience.techStack.flatMap(skill => skill.split(/[,，;；、|]/))) {
      const name = spellings(skill.trim())[0]!;
      if (!restricted.has(normalizeSearchText(name))) declaredSkills.push(name);
    }
  }
  const skills = unique([...declaredSkills, ...skillsFromClaims], 24);
  const skillNames = new Set(skills.map(normalizeSearchText));
  const tags = unique(eligibleTags.filter(tag => !skillNames.has(normalizeSearchText(spellings(tag)[0]!))), 16);
  const roles = unique((factBase.profile.targetRoles.length ? factBase.profile.targetRoles : experiences.slice(0, 2).map(exp => exp.title)).map(textOf), 4);
  const location = textOf(factBase.profile.location);
  const city = matchDisclosedChinaCities({ countryCode: "CN", raw: location })[0];
  const filter = city ? buildChinaRegionFilter({ provinceCode: city.province.code, cityCode: city.city.code }) : undefined;
  // Use the most specific disclosed city group. A district or precise home address never leaves the browser.
  // Unknown free-form locations may include a street, house number or contact
  // details. Until a locality is recognized, omit the external area filter.
  const locationAliases = filter?.workRegionGroups.at(-1) ?? [];
  return { roles, skills, tags, location, locationAliases, ...(city ? { countryCode: "CN" } : {}) };
}

export type RecommendedJob = {
  id: string; title: string; company: string; description: string; location: string; salary?: string;
  sourceUrl: string; sourcePlatform: string; observedAt?: string; status: "open" | "unknown";
  matchedSkills: string[]; matchedTags: string[]; roleMatched: boolean;
  locationMatch: "same-area" | "other-area" | "unknown" | "unspecified";
  unmentionedSkills: string[]; score: number; match: JobEvidenceMatch; requirementReview?: RequirementReview;
};
export type RequirementReview = { supported: number; partial: number; total: number };
export type MatchDimension = { kind: "skills" | "tags" | "role" | "location"; matched: number; total: number; weight: number };
export type JobEvidenceMatch = { percentage: number; dimensions: MatchDimension[] };

/** A fixed rubric, independent of other candidates. Unknown evidence earns no points.
 * The technical denominator is technologies actually disclosed by the posting,
 * not every unrelated skill a broad resume happens to contain. */
function evidenceMatch(profile: RecommendationProfile, disclosed: string[], matchedSkills: string[], matchedTags: string[], roleMatched: boolean, sameArea: boolean): JobEvidenceMatch {
  const declared = unique([...disclosed, ...matchedSkills], 100);
  const dimensions: MatchDimension[] = [
    { kind: "skills", matched: declared.filter(skill => [...profile.skills, ...profile.tags].some(value => spellings(value).some(alias => spellings(skill).includes(alias)))).length, total: declared.length, weight: profile.skills.length ? 55 : 0 },
    { kind: "tags", matched: matchedTags.length, total: profile.tags.length, weight: profile.tags.length ? 15 : 0 },
    { kind: "role", matched: Number(roleMatched), total: 1, weight: profile.roles.length ? 20 : 0 },
    { kind: "location", matched: Number(sameArea), total: 1, weight: profile.location ? 10 : 0 },
  ];
  const weight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const points = dimensions.reduce((sum, dimension) => sum + (dimension.total ? dimension.matched / dimension.total * dimension.weight : 0), 0);
  return { percentage: weight ? Math.max(0, Math.min(100, Math.round(points / weight * 100))) : 0, dimensions };
}
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

type RankingOptions = {
  signal?: AbortSignal; sameAreaOnly?: boolean; workMode?: "on-site" | "hybrid" | "remote"; limit?: number;
  requirementReview?: (job: RecommendedJob) => RequirementReview | undefined;
};
type CachedScore = { signature: string; candidate: RecommendedJob | null };

/** Read-only, explainable ranking. Scores order evidence; they are never a hiring probability. */
export function recommendResumeJobs(dataset: RecommendationPool, profile: RecommendationProfile, options: RankingOptions = {}) {
  return rankRecommendationPool(dataset, profile, options);
}

/** Reuse completed scores across successive candidate snapshots within one
 * immutable profile/filter/evidence review. Recreate when that review changes.
 * The result always represents the supplied snapshot, including removed jobs. */
export function createRecommendationRanker(profile: RecommendationProfile, options: Omit<RankingOptions, "signal"> = {}) {
  const scores = new Map<string, CachedScore>();
  const captured = structuredClone(profile);
  const settings = { ...options };
  return (dataset: RecommendationPool, signal?: AbortSignal) => rankRecommendationPool(dataset, captured, { ...settings, signal }, scores);
}

async function rankRecommendationPool(dataset: RecommendationPool, profile: RecommendationProfile, options: RankingOptions,
  scores?: Map<string, CachedScore>): Promise<RecommendationResult> {
  const companies = new Map(dataset.companies.map(company => [company.id, company]));
  const locations = new Map(dataset.locations.map(location => [location.id, location]));
  const listings = new Map(dataset.listings.map(listing => [listing.id, listing]));
  const sources = new Map(dataset.sources.map(source => [source.sourceId, source]));
  const snapshots = new Map(dataset.snapshots.map(snapshot => [snapshot.id, snapshot]));
  const compensations = new Map(dataset.compensations.map(salary => [salary.id, salary.raw]));
  const targetRole = profile.targetRole?.trim();
  const roles = targetRole ? [targetRole] : profile.roles;
  const roleText = normalizeSearchText(roles.join(" "));
  const directions = roleGroups.filter(group => group.some(term => has(roleText, term)));
  const rankedByIdentity = new Map<string, RecommendedJob>();
  const seen = scores ? new Set<string>() : undefined;
  function include(candidate: RecommendedJob | null) {
    if (!candidate) return;
    const previous = rankedByIdentity.get(candidate.id);
    if (!previous || candidate.score > previous.score || (candidate.score === previous.score && candidate.status === "open" && previous.status !== "open")) rankedByIdentity.set(candidate.id, candidate);
  }
  let excludedClosed = 0;
  let sliceStarted = performance.now();
  for (const [index, job] of dataset.jobs.entries()) {
    options.signal?.throwIfAborted();
    // Yield between batches so large local indexes never hold the Stop button hostage.
    if (index > 0 && (index % 100 === 0 || performance.now() - sliceStarted >= 8)) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
      sliceStarted = performance.now();
    }
    if (job.status === "closed") { excludedClosed++; continue; }
    if (options.workMode && options.workMode !== job.workMode) continue;
    const company = companies.get(job.companyId);
    const listing = job.listingIds.map(id => listings.get(id)).find(item => recommendationSourceUrl(item?.canonicalUrl));
    const snapshot = job.selectedSnapshotId ? snapshots.get(job.selectedSnapshotId) : undefined;
    const sourceUrl = recommendationSourceUrl(snapshot?.sourceUrl) ?? recommendationSourceUrl(listing?.canonicalUrl);
    if (!company || !sourceUrl || /\.(?:invalid|test|example)(?:[:/]|$)|https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:[:/]|$)/i.test(sourceUrl)) continue;
    const source = listing ? sources.get(listing.sourceId) : undefined;
    if (source && /demo|synthetic|fixture|演示|合成示例/i.test(`${source.adapterId} ${source.name}`)) continue;
    const places = job.locationIds.flatMap(id => locations.get(id) ? [locations.get(id)!] : []);
    const salary = job.compensationIds.map(id => compensations.get(id)).filter(Boolean).join(" / ") || undefined;
    const sourcePlatform = source?.attribution.label ?? source?.name ?? "来源待核实";
    // Search batches contain fresh object instances. Compare the resolved material
    // used for ranking and review, not object identity or unrelated index fields.
    const signature = scores ? JSON.stringify([job.title.value, job.description, job.status, job.workMode, company.names[0], sourceUrl,
      sourcePlatform, snapshot?.createdAt, places.map(place => [place.city, place.region, place.raw, place.countryCode]), salary]) : "";
    seen?.add(job.id);
    const cached = scores?.get(job.id);
    if (cached?.signature === signature) {
      include(cached.candidate);
      continue;
    }
    // Cache exclusions as well as scores, since later batches may repeat either.
    const remember = (candidate: RecommendedJob | null) => {
      options.signal?.throwIfAborted();
      scores?.set(job.id, { signature, candidate });
      include(candidate);
    };
    const titleText = normalizeSearchText(job.title.value);
    const fullText = normalizeSearchText(`${job.title.value} ${job.description}`);
    const matchedSkills = profile.skills.filter(skill => hasSkill(fullText, skill));
    const matchedTags = profile.tags.filter(tag => has(fullText, tag));
    const roleMatched = directions.some(group => group.some(term => has(titleText, term)))
      || roles.some(role => role.split(" / ").some(term => has(titleText, term)));
    const relevantByText = matchedTags.length || matchedSkills.length || (roleMatched && (targetRole || !profile.skills.length));
    if (!relevantByText && !options.requirementReview) { remember(null); continue; }
    // Unknown free-form home locations are never sent to search. An exact
    // structured city match is still comparable locally (e.g. Berlin / DE).
    const sameDisclosedCity = !profile.locationAliases.length && !!profile.location && places.some(place =>
      place.city && (!profile.countryCode || !place.countryCode || profile.countryCode === place.countryCode)
      && profile.location.split(" / ").some(value => normalizeSearchText(value) === normalizeSearchText(place.city!)));
    const sameArea = sameDisclosedCity || places.some(place => (!profile.countryCode || !place.countryCode || place.countryCode === profile.countryCode)
      && profile.locationAliases.some(alias => [place.city, place.region, place.raw].some(field => field && has(normalizeSearchText(field), alias))));
    const locationMatch: RecommendedJob["locationMatch"] = !profile.location ? "unspecified" : sameArea ? "same-area" : profile.locationAliases.length && places.some(place => place.city || (profile.countryCode && place.countryCode && place.countryCode !== profile.countryCode)) ? "other-area" : "unknown";
    if (options.sameAreaOnly && profile.location && !sameArea) { remember(null); continue; }
    // The index already resolves cross-source aliases to canonical IDs. Teams can
    // advertise different jobs with identical company, title and location.
    const disclosed = recognizedSkills(fullText);
    const evidenced = new Set([...matchedSkills, ...matchedTags].map(term => spellings(term)[0]!));
    const unmentionedSkills = disclosed.filter(label => !evidenced.has(label)).slice(0, 4);
    const score = matchedSkills.length * 10 + (profile.skills.length ? matchedSkills.length / profile.skills.length * 24 : 0)
      + matchedTags.length * 7 + (roleMatched ? 18 : 0);
    const candidate: RecommendedJob = { id: job.id, title: job.title.value, company: company.names[0]!, description: job.description,
      location: unique(places.map(place => [...new Set([place.city, place.region].filter(Boolean))].join(" · ") || place.raw), 3).join(" / "),
      salary, sourceUrl, sourcePlatform,
      observedAt: snapshot?.createdAt, status: job.status, matchedSkills, matchedTags, roleMatched, locationMatch, unmentionedSkills, score,
      match: evidenceMatch(profile, disclosed, matchedSkills, matchedTags, roleMatched, sameArea) };
    const review = options.requirementReview?.(candidate);
    if (!relevantByText && !review?.supported && !review?.partial) { remember(null); continue; }
    if (review) candidate.requirementReview = review;
    remember(candidate);
  }
  options.signal?.throwIfAborted();
  // Retain only the sources present in the latest completed pass. A superseded
  // pass can contribute completed scores but cannot prune the new snapshot.
  if (scores && seen) for (const id of scores.keys()) if (!seen.has(id)) scores.delete(id);
  const ranked = [...rankedByIdentity.values()];
  const locationPriority = (item: RecommendedJob) => item.locationMatch === "same-area" ? 1 : 0;
  const coverage = (job: RecommendedJob, key: "supported" | "partial") =>
    job.requirementReview?.total ? job.requirementReview[key] / job.requirementReview.total : 0;
  ranked.sort((a, b) => locationPriority(b) - locationPriority(a)
    || (targetRole ? Number(b.roleMatched) - Number(a.roleMatched) : 0)
    || coverage(b, "supported") - coverage(a, "supported") || coverage(b, "partial") - coverage(a, "partial") || b.match.percentage - a.match.percentage || b.score - a.score || a.id.localeCompare(b.id));
  const jobs = ranked.slice(0, Math.max(1, Math.min(options.limit ?? 3, 6)));
  return { jobs: scores ? structuredClone(jobs) : jobs, candidates: ranked.length, scanned: dataset.jobs.length, excludedClosed };
}
