import { isResumeProfileVisible, isResumeSectionVisible, projectResume, type FactBase, type ProjectedResume, type ResumeView } from "@better-me/core";
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

  const headline = resume.profile.headline?.trim().slice(0, 600);
  const skills = [...new Set((resume.skills ?? []).map((skill) => skill.trim()).filter(Boolean))]
    .slice(0, 30)
    .map((skill) => skill.slice(0, 100));
  const recentExperience = resume.experiences.slice(0, 3).map((experience) => {
    const role = [experience.org, experience.title].map((value) => value.trim()).filter(Boolean).join(" · ");
    const claims = experience.claims.slice(0, 3)
      .map((claim) => claim.text.trim())
      .filter(Boolean)
      .map((claim) => `- ${claim.slice(0, 360)}`);
    return [role, ...claims].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n").slice(0, 4_000);

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

/** Apply one reviewed proposal only when its exact source text is still current (CAS). */
export function applyResumeProposal(
  document: BetterMeDocument,
  proposal: ResumeProposalWrite,
  now = new Date().toISOString(),
): ResumeProposalApplyResult {
  const { targetRef, originalText, proposedText } = proposal;
  if (!proposedText.trim() || proposedText.length > 12_000) return { ok: false, reason: "invalid" };

  if (targetRef.kind === "profile_headline") {
    const currentHeadline = document.factBase.profile.headline;
    const current = currentHeadline?.[targetRef.locale];
    if (current !== originalText) return { ok: false, reason: "conflict" };
    if (!currentHeadline) return { ok: false, reason: "conflict" };
    const nextHeadline = targetRef.locale === "zh"
      ? { zh: proposedText, ...(currentHeadline.en ? { en: currentHeadline.en } : {}) }
      : { zh: currentHeadline.zh, en: proposedText };
    const factBase = {
      ...document.factBase,
      updatedAt: now,
      profile: {
        ...document.factBase.profile,
        headline: nextHeadline,
      },
    };
    return { ok: true, document: { ...document, factBase } };
  }

  const experience = document.factBase.experiences.find((item) => item.id === targetRef.experienceId);
  const claim = experience?.claims.find((item) => item.id === targetRef.claimId);
  if (!experience || !claim || claim.text[targetRef.locale] !== originalText) return { ok: false, reason: "conflict" };

  const factBase = {
    ...document.factBase,
    updatedAt: now,
    experiences: document.factBase.experiences.map((item) => item.id !== targetRef.experienceId ? item : {
      ...item,
      claims: item.claims.map((entry) => entry.id !== targetRef.claimId ? entry : {
        ...entry,
        text: { ...entry.text, [targetRef.locale]: proposedText },
        updatedAt: now,
      }),
    }),
  };
  return { ok: true, document: { ...document, factBase } };
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
