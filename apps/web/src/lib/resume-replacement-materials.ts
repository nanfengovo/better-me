import { isResumeSectionVisible, pickLocale, type FactBase, type ProjectedResume, type ReplacementMaterial, type ResumeView } from "@better-me/core";
import type { DrawerJobContext } from "../components/JdMatchDrawer";
import { readOpportunityLibrary } from "./opportunities";

export function materialKey(row: Pick<ReplacementMaterial, "experienceId" | "claimId">) {
  return JSON.stringify([row.experienceId, row.claimId]);
}

/** Explicitly unpublished notes and unconfirmed metrics are outside this editor. */
export function replacementMaterials(facts: FactBase, view: ResumeView, projected: ProjectedResume): ReplacementMaterial[] {
  const visible = new Set(projected.experiences.flatMap(exp => exp.claims.map(c => materialKey({experienceId: exp.id, claimId: c.id}))));
  return facts.experiences.flatMap(exp => {
    if (exp.type === "education" || !isResumeSectionVisible(view, exp.type === "work" ? "experience" : "projects")) return [];
    const label = [pickLocale(exp.org, view.locale), pickLocale(exp.title, view.locale), exp.projectName && pickLocale(exp.projectName, view.locale)].filter(Boolean).join(" · ");
    return exp.claims.flatMap(claim => {
      const text = pickLocale(claim.text, view.locale);
      if (!text.trim() || claim.kind === "interview" || claim.kind === "pitfall" || (claim.metric && !claim.metric.confirmed)) return [];
      const ref = { experienceId: exp.id, claimId: claim.id };
      return [{ ...ref, label, text, visible: visible.has(materialKey(ref)) }];
    });
  });
}

export function readReplacementJobs(): { jobs: DrawerJobContext[]; error?: string } {
  const { library, error } = readOpportunityLibrary();
  return { error, jobs: library.jobs.filter(job => job.description.trim()).map(({ id, company, title, description, sourcePlatform, sourceUrl }) =>
    ({ id, company, title, description, sourcePlatform, sourceUrl: sourceUrl || undefined })) };
}
