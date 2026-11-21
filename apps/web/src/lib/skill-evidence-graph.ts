import type { Experience, FactBase, FactClaim, Locale, LocalizedString, ResumeView } from "@better-me/core";

export interface EvidenceClaimNode {
  claimId: string;
  experienceId: string;
  text: string;
  kind: string;
  tags: string[];
  includedInResume: boolean;
  metric?: {
    value: number;
    unit: string;
    confirmed: boolean;
    baseline?: string;
  };
}

export interface LinkedExperienceEvidence {
  experienceId: string;
  type: Experience["type"];
  org: string;
  title: string;
  period: string;
  techStack: string[];
  includedInResume: boolean;
  claims: EvidenceClaimNode[];
}

export interface SkillNode {
  id: string;
  name: string;
  keycapLabel: string;
  category: "tech" | "tag" | "strength";
  experienceCount: number;
  claimCount: number;
  verifiedMetricCount: number;
  includedClaimCount: number;
  experiences: LinkedExperienceEvidence[];
}

export interface SkillEvidenceGraph {
  skills: SkillNode[];
  timeline: LinkedExperienceEvidence[];
  totalClaims: number;
  includedClaims: number;
  verifiedMetrics: number;
}

function pick(loc: LocalizedString | undefined, locale: Locale): string {
  if (!loc) return "";
  return locale === "en" ? loc.en?.trim() || loc.zh : loc.zh || loc.en?.trim() || "";
}

function isExperienceIncluded(view: ResumeView, expId: string): boolean {
  if (view.experienceSelection === "selected") {
    return view.includedExperienceIds.includes(expId);
  }
  if (view.includedExperienceIds.length > 0) {
    return view.includedExperienceIds.includes(expId);
  }
  return true;
}

function isClaimIncluded(view: ResumeView, expId: string, claimId: string): boolean {
  if (!isExperienceIncluded(view, expId)) return false;
  if (view.claimSelection === "selected") {
    return view.includedClaimIds.includes(claimId);
  }
  if (view.includedClaimIds.length > 0) {
    return view.includedClaimIds.includes(claimId);
  }
  return true;
}

function shortKeycap(name: string): string {
  const clean = name.trim();
  if (clean.length <= 6) return clean;
  if (/^[A-Za-z0-9.#+/-]+$/.test(clean)) return clean.slice(0, 8);
  return clean.slice(0, 6);
}

function claimMentionsSkill(claim: FactClaim, skillLower: string): boolean {
  if (claim.tags.some((t) => t.trim().toLowerCase() === skillLower)) return true;
  const hay = `${claim.text.zh} ${claim.text.en ?? ""}`.toLowerCase();
  return hay.includes(skillLower);
}

/**
 * Build a deterministic, 100% DOM-searchable Skill-to-Evidence Atlas from FactBase + ResumeView.
 * Every skill traces back to concrete experiences, verified metrics, and active resume inclusion state.
 */
export function buildSkillEvidenceGraph(factBase: FactBase, view: ResumeView, locale: Locale): SkillEvidenceGraph {
  const timeline: LinkedExperienceEvidence[] = factBase.experiences.map((exp) => {
    const expIncluded = isExperienceIncluded(view, exp.id);
    return {
      experienceId: exp.id,
      type: exp.type,
      org: pick(exp.org, locale),
      title: pick(exp.title, locale),
      period: `${exp.start} ~ ${exp.end ?? (locale === "en" ? "Present" : "至今")}`,
      techStack: exp.techStack,
      includedInResume: expIncluded,
      claims: exp.claims.map((claim) => ({
        claimId: claim.id,
        experienceId: exp.id,
        text: pick(claim.text, locale),
        kind: claim.kind,
        tags: claim.tags,
        includedInResume: isClaimIncluded(view, exp.id, claim.id),
        metric: claim.metric
          ? {
              value: claim.metric.value,
              unit: claim.metric.unit,
              confirmed: Boolean(claim.metric.confirmed),
              baseline: claim.metric.baseline,
            }
          : undefined,
      })),
    };
  });

  // Collect canonical skills with priority: techStack > claim.tags > concise profile traits
  const skillRegistry = new Map<string, { display: string; category: SkillNode["category"] }>();
  const register = (raw: string, category: SkillNode["category"]) => {
    const clean = raw.trim();
    if (!clean || clean.length > 36) return;
    const key = clean.toLowerCase();
    if (!skillRegistry.has(key)) skillRegistry.set(key, { display: clean, category });
  };

  for (const exp of factBase.experiences) {
    for (const tech of exp.techStack) register(tech, "tech");
    for (const claim of exp.claims) {
      for (const tag of claim.tags) register(tag, "tag");
    }
  }
  for (const trait of factBase.profile.traits) {
    const clean = trait.trim();
    if (clean.length >= 2 && clean.length <= 18 && !/[。！？，；：.!?,;:]$/.test(clean)) {
      register(clean, "strength");
    }
  }

  const skills: SkillNode[] = [];
  for (const [key, meta] of skillRegistry.entries()) {
    const linkedExps: LinkedExperienceEvidence[] = [];
    let claimCount = 0;
    let verifiedMetricCount = 0;
    let includedClaimCount = 0;

    for (let i = 0; i < factBase.experiences.length; i += 1) {
      const exp = factBase.experiences[i]!;
      const expNode = timeline[i]!;
      const inTechStack = exp.techStack.some((t) => t.trim().toLowerCase() === key);
      const matchingClaimIds = new Set(
        exp.claims.filter((c) => claimMentionsSkill(c, key)).map((c) => c.id),
      );
      if (!inTechStack && matchingClaimIds.size === 0) continue;

      const relevantClaims =
        matchingClaimIds.size > 0
          ? expNode.claims.filter((c) => matchingClaimIds.has(c.claimId))
          : expNode.claims;

      claimCount += relevantClaims.length;
      verifiedMetricCount += relevantClaims.filter((c) => c.metric?.confirmed).length;
      includedClaimCount += relevantClaims.filter((c) => c.includedInResume).length;
      linkedExps.push({ ...expNode, claims: relevantClaims });
    }

    skills.push({
      id: `skill:${key}`,
      name: meta.display,
      keycapLabel: shortKeycap(meta.display),
      category: meta.category,
      experienceCount: linkedExps.length,
      claimCount,
      verifiedMetricCount,
      includedClaimCount,
      experiences: linkedExps,
    });
  }

  skills.sort(
    (a, b) =>
      b.experienceCount - a.experienceCount ||
      b.claimCount - a.claimCount ||
      b.verifiedMetricCount - a.verifiedMetricCount ||
      a.name.localeCompare(b.name),
  );

  const totalClaims = timeline.reduce((sum, e) => sum + e.claims.length, 0);
  const includedClaims = timeline.reduce((sum, e) => sum + e.claims.filter((c) => c.includedInResume).length, 0);
  const verifiedMetrics = timeline.reduce((sum, e) => sum + e.claims.filter((c) => c.metric?.confirmed).length, 0);

  return { skills, timeline, totalClaims, includedClaims, verifiedMetrics };
}

/**
 * Toggle whether a single experience is included in the active ResumeView without dropping other experiences.
 */
export function toggleExperienceInResumeView(
  factBase: FactBase,
  view: ResumeView,
  experienceId: string,
  now = new Date().toISOString(),
): ResumeView {
  const allIds = factBase.experiences.map((e) => e.id);
  const currentSet = new Set(
    view.experienceSelection === "selected" || view.includedExperienceIds.length > 0
      ? view.includedExperienceIds
      : allIds,
  );
  if (currentSet.has(experienceId)) currentSet.delete(experienceId);
  else currentSet.add(experienceId);

  const nextIds = allIds.filter((id) => currentSet.has(id));
  const allSelected = nextIds.length === allIds.length;
  return {
    ...view,
    experienceSelection: allSelected ? "all" : "selected",
    includedExperienceIds: allSelected ? [] : nextIds,
    updatedAt: now,
  };
}

/**
 * Toggle whether a single claim is projected into the active ResumeView without dropping unrelated claims.
 */
export function toggleClaimInResumeView(
  factBase: FactBase,
  view: ResumeView,
  experienceId: string,
  claimId: string,
  now = new Date().toISOString(),
): ResumeView {
  let nextView = view;
  const allClaimIds = factBase.experiences.flatMap((e) => e.claims.map((c) => c.id));
  const currentSet = new Set(
    view.claimSelection === "selected" || view.includedClaimIds.length > 0
      ? view.includedClaimIds
      : allClaimIds,
  );

  const currentlyIncluded = isClaimIncluded(view, experienceId, claimId);
  if (currentlyIncluded) {
    currentSet.delete(claimId);
  } else {
    if (!isExperienceIncluded(view, experienceId)) {
      nextView = toggleExperienceInResumeView(factBase, view, experienceId, now);
    }
    currentSet.add(claimId);
  }

  const nextIds = allClaimIds.filter((id) => currentSet.has(id));
  const allSelected = nextIds.length === allClaimIds.length;
  return {
    ...nextView,
    claimSelection: allSelected ? "all" : "selected",
    includedClaimIds: allSelected ? [] : nextIds,
    updatedAt: now,
  };
}
