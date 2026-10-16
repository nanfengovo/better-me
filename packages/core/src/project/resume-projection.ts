import type { FactBase, Experience, FactClaim } from "../schema/fact.js";
import type { ResumeView } from "../schema/resume.js";
import { pickLocale, type Locale } from "../schema/locale.js";

export type ProjectedClaim = {
  id: string;
  kind: FactClaim["kind"];
  text: string;
  metric?: FactClaim["metric"];
  tags: string[];
};

export type ProjectedExperience = {
  id: string;
  type: Experience["type"];
  org: string;
  title: string;
  start: string;
  end: string | null;
  projectName?: string;
  url?: string;
  techStack: string[];
  claims: ProjectedClaim[];
};

export type ProjectedResume = {
  locale: Locale;
  templateId: string;
  profile: {
    displayName: string;
    headline?: string;
    avatarUrl?: string;
    education?: string;
    location?: string;
    email?: string;
    phone?: string;
    links: { label: string; url: string }[];
    targetRoles: string[];
    traits: string[];
  };
  experiences: ProjectedExperience[];
};

function includeExperience(view: ResumeView, expId: string): boolean {
  if (view.experienceSelection === "all") return true;
  if (view.experienceSelection === "selected") return view.includedExperienceIds.includes(expId);
  if (view.includedExperienceIds.length === 0) return true;
  return view.includedExperienceIds.includes(expId);
}

function includeClaim(view: ResumeView, claimId: string): boolean {
  if (view.claimSelection === "all") return true;
  if (view.claimSelection === "selected") return view.includedClaimIds.includes(claimId);
  if (view.includedClaimIds.length === 0) return true;
  return view.includedClaimIds.includes(claimId);
}

/** Project FactBase → resume view for a locale/template (no invention). */
export function projectResume(
  base: FactBase,
  view: ResumeView,
): ProjectedResume {
  const locale = view.locale;
  const experiences = base.experiences
    .filter((exp) => includeExperience(view, exp.id))
    .map((exp) => {
      const claims = exp.claims
        .filter((c) => c.kind !== "pitfall" && c.kind !== "interview")
        .filter((c) => includeClaim(view, c.id))
        .filter((c) => !(c.metric && !c.metric.confirmed))
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          text: pickLocale(c.text, locale),
          metric: c.metric,
          tags: c.tags,
        }));

      return {
        id: exp.id,
        type: exp.type,
        org: pickLocale(exp.org, locale),
        title: pickLocale(exp.title, locale),
        start: exp.start,
        end: exp.end,
        projectName: exp.projectName
          ? pickLocale(exp.projectName, locale)
          : undefined,
        url: exp.url,
        techStack: exp.techStack,
        claims,
      };
    })
    .filter(
      (exp) =>
        exp.claims.length > 0 ||
        exp.type === "work" ||
        exp.type === "education",
    );

  return {
    locale,
    templateId: view.templateId,
    profile: {
      displayName: pickLocale(base.profile.displayName, locale),
      headline: base.profile.headline
        ? pickLocale(base.profile.headline, locale)
        : undefined,
      avatarUrl: base.profile.avatarUrl,
      education: base.profile.education
        ? pickLocale(base.profile.education, locale)
        : undefined,
      location: base.profile.location
        ? pickLocale(base.profile.location, locale)
        : undefined,
      email: base.profile.email,
      phone: base.profile.phone,
      links: base.profile.links,
      targetRoles: base.profile.targetRoles.map((r) => pickLocale(r, locale)),
      traits: base.profile.traits,
    },
    experiences,
  };
}

export function createDefaultResumeView(
  _base: FactBase,
  now = new Date().toISOString(),
): ResumeView {
  return {
    id: "resume-default",
    name: "Default",
    locale: "zh",
    templateId: "zh-classic",
    experienceSelection: "all",
    includedExperienceIds: [],
    claimSelection: "all",
    includedClaimIds: [],
    sectionOrder: [
      "summary",
      "experience",
      "projects",
      "skills",
      "education",
    ],
    updatedAt: now,
  };
}

/** Follow editor additions in the active view without revealing previously hidden facts. */
export function syncResumeViewsWithFactBase(
  previous: FactBase,
  next: FactBase,
  views: ResumeView[],
  activeResumeId: string,
): ResumeView[] {
  const previousIds = new Set(previous.experiences.map((e) => e.id));
  const nextIds = new Set(next.experiences.map((e) => e.id));
  const addedIds = [...nextIds].filter((id) => !previousIds.has(id));
  const previousClaimIds = new Set(previous.experiences.flatMap((e) => e.claims.map((c) => c.id)));
  const nextClaimIds = new Set(next.experiences.flatMap((e) => e.claims.map((c) => c.id)));
  const addedClaimIds = [...nextClaimIds].filter((id) => !previousClaimIds.has(id));
  return views.map((view) => {
    const claimsAll = view.claimSelection === "all" || (!view.claimSelection && view.includedClaimIds.length === 0);
    const claimIds = view.includedClaimIds.filter((id) => nextClaimIds.has(id));
    if (!claimsAll && view.id === activeResumeId) claimIds.push(...addedClaimIds);
    const claimSelection = claimsAll ? "all" as const : "selected" as const;
    const includedClaimIds = claimsAll ? [] : [...new Set(claimIds)];
    const legacyAll = !view.experienceSelection && (
      view.includedExperienceIds.length === 0 ||
      [...previousIds].every((id) => view.includedExperienceIds.includes(id))
    );
    if (view.experienceSelection === "all" || legacyAll) {
      return { ...view, claimSelection, includedClaimIds, experienceSelection: "all", includedExperienceIds: [] };
    }
    const ids = view.includedExperienceIds.filter((id) => nextIds.has(id));
    if (view.id === activeResumeId) ids.push(...addedIds);
    return { ...view, claimSelection, includedClaimIds, experienceSelection: "selected", includedExperienceIds: [...new Set(ids)] };
  });
}
