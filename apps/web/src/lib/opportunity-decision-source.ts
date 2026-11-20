import { careerJobSnapshotVersion, careerRequirementCapabilityId, careerTrainingRequirements } from "@better-me/agent-contracts";
import { careerTaskSourceFingerprint, projectResume, projectedResumeToMarkdown, resolveResumeFactBase } from "@better-me/core";
import { DocumentSchema, documentFingerprint, type BetterMeDocument, type DocumentVersion } from "@better-me/storage";
import { currentRequirementLinks, evidenceSources, summarizeRequirements } from "./requirement-evidence";
import { opportunityDecisionCareerJob, type Opportunity, type OpportunityDecisionEvidence, type OpportunityMaterial } from "./opportunities";

type ReadOfficialMaterial = {
  read: () => Promise<BetterMeDocument | null>;
  listVersions: () => Promise<DocumentVersion[]>;
  assertCurrent: () => void;
};

/** The actual material can be recorded even while editing. Only an exact
 * official read-back and an existing history checkpoint grant a version receipt. */
export async function currentOpportunityResumeMaterial(document: BetterMeDocument, source: ReadOfficialMaterial): Promise<Omit<OpportunityMaterial, "id" | "createdAt">> {
  source.assertCurrent();
  const view = document.resumeViews.find(item => item.id === document.activeResumeId);
  if (!view || !DocumentSchema.safeParse(document).success) throw new Error("请先补齐并核对简历必填字段，再记录材料快照。");
  const facts = resolveResumeFactBase(document.factBase, view);
  const material: Omit<OpportunityMaterial, "id" | "createdAt"> = {
    resumeViewId: view.id, resumeName: view.name, resumeUpdatedAt: facts.updatedAt > view.updatedAt ? facts.updatedAt : view.updatedAt,
    locale: view.locale, markdown: projectedResumeToMarkdown(projectResume(facts, view)),
  };
  const official = await source.read();
  source.assertCurrent();
  if (!official?.documentId || documentFingerprint(official) !== documentFingerprint(document)) return material;
  const versions = await source.listVersions();
  source.assertCurrent();
  const version = versions.find(entry => documentFingerprint(entry.document) === documentFingerprint(official));
  if (!version) return material;
  const contentHash = await careerTaskSourceFingerprint(version.document, view.id);
  source.assertCurrent();
  // A different window may have committed while history and the hash were read.
  const confirmed = await source.read();
  source.assertCurrent();
  if (!confirmed || documentFingerprint(confirmed) !== documentFingerprint(official))
    throw new Error("正式简历版本在核对期间发生变化，请重新选择材料。");
  return { ...material, officialVersion: { documentId: official.documentId, versionId: version.id, contentHash } };
}

/** Only active decisions for the exact same source JD count. A manual source
 * without a canonical ID is kept separate from indexed jobs. */
export function opportunityDecisionEvidence(document: BetterMeDocument, opportunity: Opportunity): OpportunityDecisionEvidence {
  const job = opportunityDecisionCareerJob(opportunity);
  const items = careerTrainingRequirements(job);
  const snapshotVersion = careerJobSnapshotVersion(job);
  const links = currentRequirementLinks(document.requirementEvidence ?? []).filter(link => link.jobVersion === snapshotVersion
    && items.some(item => item.id === link.itemId && item.originalQuote === link.quote)
    && link.assessment !== "withdrawn");
  const view = document.resumeViews.find(item => item.id === document.activeResumeId);
  const facts = view ? resolveResumeFactBase(document.factBase, view) : document.factBase;
  const summary = summarizeRequirements(items, links, evidenceSources(facts));
  return { ...summary, independentRetests: links.flatMap(link => link.sourceKind === "independent-retest" ? [{
    kitId: link.kitId, questionVersion: link.questionVersion,
    capabilityId: link.capabilityId ?? careerRequirementCapabilityId(snapshotVersion, link.itemId, link.quote),
    sourceVersion: link.sourceVersion, result: link.result, completedAt: link.completedAt,
  }] : []) };
}
