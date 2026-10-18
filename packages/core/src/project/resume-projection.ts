import type { FactBase, Experience, FactClaim } from "../schema/fact.js";
import { getResumeLayout, getResumeSectionOrder, isResumeProfileVisible, isResumeSectionVisible, type ResumeView, type ResumeLayout, type ResumeSectionId, type TextStyleRange } from "../schema/resume.js";
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
  themeId?: ResumeView["themeId"];
  themeOverrides?: ResumeView["themeOverrides"];
  sectionOrder?: ResumeSectionId[];
  sectionVisibility?: ResumeView["sectionVisibility"];
  layout?: ResumeLayout;
  textStyles?: Record<string, TextStyleRange[]>;
  /** Education in its own movable section, independent of header visibility. */
  educationSummary?: string;
  skills?: string[];
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
  // A translated view may fall back to Chinese. Formatting follows the actual source text.
  const textStyles = view.textStyles ? { ...view.textStyles } : undefined;
  const projectStyles = (key: string, text: { zh: string; en?: string }) => {
    if (!textStyles) return;
    const sourceLocale = locale === "en" && text.en?.trim() ? "en" : "zh";
    const ranges = view.textStyles?.[`${key}:${sourceLocale}`];
    if (ranges) textStyles[`${key}:${locale}`] = ranges;
    else delete textStyles[`${key}:${locale}`];
  };
  projectStyles("profile:displayName", base.profile.displayName);
  if (base.profile.headline) projectStyles("profile:headline", base.profile.headline);
  for (const experience of base.experiences) {
    for (const claim of experience.claims) projectStyles(`claim:${claim.id}`, claim.text);
  }
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
  const visibleExperiences = experiences.filter((experience) => isResumeSectionVisible(view,
    experience.type === "work" ? "experience" : experience.type === "education" ? "education" : "projects"));

  return {
    locale,
    templateId: view.templateId,
    themeId: view.themeId,
    themeOverrides: view.themeOverrides,
    sectionOrder: getResumeSectionOrder(view.sectionOrder),
    sectionVisibility: view.sectionVisibility,
    // Keep themed overrides sparse: materializing the legacy accent/font would hide theme defaults.
    layout: view.themeId ? view.layout : getResumeLayout(view.layout),
    textStyles,
    educationSummary: isResumeSectionVisible(view, "education") && base.profile.education ? pickLocale(base.profile.education, locale) : undefined,
    skills: isResumeSectionVisible(view, "skills") ? [...new Set(visibleExperiences.flatMap((experience) => experience.techStack))] : [],
    profile: {
      displayName: pickLocale(base.profile.displayName, locale),
      headline: isResumeProfileVisible(view, "headline") && base.profile.headline
        ? pickLocale(base.profile.headline, locale)
        : undefined,
      avatarUrl: isResumeProfileVisible(view, "photo") && view.templateId !== "en-ats" ? base.profile.avatarUrl : undefined,
      education: isResumeProfileVisible(view, "education") && base.profile.education
        ? pickLocale(base.profile.education, locale)
        : undefined,
      location: isResumeProfileVisible(view, "location") && base.profile.location
        ? pickLocale(base.profile.location, locale)
        : undefined,
      email: isResumeProfileVisible(view, "email") ? base.profile.email : undefined,
      phone: isResumeProfileVisible(view, "phone") ? base.profile.phone : undefined,
      links: isResumeProfileVisible(view, "links") ? base.profile.links : [],
      targetRoles: isResumeProfileVisible(view, "targetRoles") && isResumeSectionVisible(view, "summary") ? base.profile.targetRoles.map((r) => pickLocale(r, locale)) : [],
      traits: isResumeProfileVisible(view, "traits") && isResumeSectionVisible(view, "summary") ? base.profile.traits : [],
    },
    experiences: visibleExperiences,
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
    profileVisibility: { education: false, photo: true },
    // Defaults belong to the renderer; only persist values the user explicitly changes.
    layout: {},
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
