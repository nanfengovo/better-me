import { isResumeProfileVisible, isResumeSectionVisible, projectResume, resolveResumeFactBase, snapshotResumeFacts, type FactBase, type ProjectedResume, type ResumeView } from "@better-me/core";
import type { ResumeEditContext, ResumeProposalTarget } from "@better-me/agent-contracts";
import type { BetterMeDocument } from "@better-me/storage";

export type ResumeProposalWrite = {
  targetRef: ResumeProposalTarget;
  originalText: string;
  proposedText: string;
};

export type ResumeProposalApplyResult =
  | { ok: true; document: BetterMeDocument }
  | { ok: false; reason: "conflict" | "invalid" };

export type CompanionResumeSummary = {
  headline?: string;
  skills?: string[];
  recentExperience?: string;
};

/** Project only non-contact fields from the active, already-filtered resume view. */
export function createCompanionResumeSummary(resume: ProjectedResume | null | undefined): CompanionResumeSummary | undefined {
  if (!resume) return undefined;

  const headline = resume.profile.headline?.trim();
  const skills = [...new Set((resume.skills ?? []).map((skill) => skill.trim()).filter(Boolean))];
  const recentExperience = resume.experiences.map((experience) => {
    const role = [experience.org, experience.title].map((value) => value.trim()).filter(Boolean).join(" · ");
    const claims = experience.claims
      .map((claim) => claim.text.trim())
      .filter(Boolean)
      .map((claim) => `- ${claim}`);
    return [role, ...claims].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");

  const summary: CompanionResumeSummary = {};
  if (headline) summary.headline = headline;
  if (skills.length) summary.skills = skills;
  if (recentExperience) summary.recentExperience = recentExperience;
  return Object.keys(summary).length ? summary : undefined;
}

function sourceLocale(value: { zh: string; en?: string }, requested: "zh" | "en"): "zh" | "en" {
  return requested === "en" && value.en?.trim() ? "en" : "zh";
}

/** Build the minimal, non-contact context only after the user explicitly enables resume sharing. */
export function createResumeAgentContext(factBase: FactBase, view: ResumeView): ResumeEditContext {
  factBase = resolveResumeFactBase(factBase, view);
  const projected = projectResume(factBase, view);
  const headlineText = projected.profile.headline;
  const headlineLocale = factBase.profile.headline
    ? sourceLocale(factBase.profile.headline, view.locale)
    : view.locale;
  const headline = headlineText && isResumeProfileVisible(view, "headline")
    ? {
        targetRef: { kind: "profile_headline" as const, locale: headlineLocale },
        text: headlineText,
      }
    : undefined;

  return {
    locale: view.locale,
    profile: {
      ...(headline ? { headline } : {}),
      skills: projected.skills ?? [],
    },
    experiences: projected.experiences
      .filter((experience) => isResumeSectionVisible(view, experience.type === "work" ? "experience" : experience.type === "education" ? "education" : "projects"))
      .map((experience) => ({
        id: experience.id,
        type: experience.type,
        organization: experience.org,
        title: experience.title,
        claims: experience.claims.flatMap((claim) => {
          const source = factBase.experiences.find((item) => item.id === experience.id)?.claims.find((item) => item.id === claim.id);
          if (!source) return [];
          return [{
            targetRef: {
              kind: "claim_text" as const,
              experienceId: experience.id,
              claimId: claim.id,
              locale: sourceLocale(source.text, view.locale),
            },
            kind: claim.kind,
            text: claim.text,
            tags: claim.tags,
          }];
        }),
      })),
  };
}

function isTargetRef(value: unknown, target: ResumeProposalTarget): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== target.kind || candidate.locale !== target.locale) return false;
  if (target.kind === "profile_headline") return true;
  return candidate.kind === "claim_text"
    && candidate.experienceId === target.experienceId
    && candidate.claimId === target.claimId;
}

/** Approving wording authorizes one resume view, never a change to shared facts. */
export function applyResumeProposal(
  document: BetterMeDocument,
  proposal: ResumeProposalWrite,
  now = new Date().toISOString(),
): ResumeProposalApplyResult {
  const { targetRef, originalText, proposedText } = proposal;
  if (!proposedText.trim() || proposedText.length > 12_000) return { ok: false, reason: "invalid" };
  const activeViews = document.resumeViews.filter(view => view.id === document.activeResumeId);
  if (activeViews.length !== 1) return { ok: false, reason: "conflict" };
  const active = activeViews[0]!;
  const source = resolveResumeFactBase(document.factBase, active);
  // The bilingual writing editor may explicitly review either language.
  if (findResumeContextSource(createResumeAgentContext(document.factBase, { ...active, locale: targetRef.locale }), targetRef) !== originalText) return { ok: false, reason: "conflict" };
  const effective = active.isolatedFactBase ?? snapshotResumeFacts(source, now);
  const finish = (factBase: FactBase): ResumeProposalApplyResult => ({ ok: true, document: {
    ...document, resumeViews: document.resumeViews.map(view => view.id === active.id ? { ...view, isolatedFactBase: factBase, updatedAt: now } : view),
  } });

  if (targetRef.kind === "profile_headline") {
    const currentHeadline = effective.profile.headline;
    const current = currentHeadline?.[targetRef.locale];
    if (current !== originalText) return { ok: false, reason: "conflict" };
    if (!currentHeadline) return { ok: false, reason: "conflict" };
    const nextHeadline = targetRef.locale === "zh"
      ? { zh: proposedText, ...(currentHeadline.en ? { en: currentHeadline.en } : {}) }
      : { zh: currentHeadline.zh, en: proposedText };
    const factBase = {
      ...effective,
      updatedAt: now,
      profile: {
        ...effective.profile,
        headline: nextHeadline,
      },
    };
    return finish(factBase);
  }

  const experiences = effective.experiences.filter((item) => item.id === targetRef.experienceId);
  const claims = experiences.length === 1 ? experiences[0]!.claims.filter((item) => item.id === targetRef.claimId) : [];
  if (claims.length !== 1 || claims[0]!.text[targetRef.locale] !== originalText) return { ok: false, reason: "conflict" };

  const factBase = {
    ...effective,
    updatedAt: now,
    experiences: effective.experiences.map((item) => item.id !== targetRef.experienceId ? item : {
      ...item,
      claims: item.claims.map((entry) => entry.id !== targetRef.claimId ? entry : {
        ...entry,
        text: { ...entry.text, [targetRef.locale]: proposedText },
        updatedAt: now,
      }),
    }),
  };
  return finish(factBase);
}

/** Resolve model-provided targets strictly against fields included in the consented ContextPack. */
export function findResumeContextSource(context: ResumeEditContext, target: ResumeProposalTarget) {
  if (context.profile.headline && isTargetRef(context.profile.headline.targetRef, target)) return context.profile.headline.text;
  for (const experience of context.experiences) {
    const claim = experience.claims.find((entry) => isTargetRef(entry.targetRef, target));
    if (claim) return claim.text;
  }
  return undefined;
}
