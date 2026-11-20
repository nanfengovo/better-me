import { isBundledDemoWorkSource, type DecomposedJdItem, type Experience, type FactBase, type FactClaim } from "@better-me/core";
import type { RequirementEvidenceLink } from "@better-me/core/document";
import { careerJobSnapshotVersion, careerRequirementCapabilityId, careerTrainingRequirements, independentRetestEvidence, inventoryDigest, type CareerTrainingJob, type TrainingSummary, type TrainingView } from "@better-me/agent-contracts";
import type { BetterMeDocument } from "@better-me/storage";
import { classifyRecommendationClaim } from "./resume-job-recommendations";

type Assessment = RequirementEvidenceLink["assessment"];
type Contribution = RequirementEvidenceLink["contribution"];
type RequirementSource =
  | { sourceKind?: "work"; experienceId: string; claimId: string }
  | { sourceKind: "independent-retest"; kitId: string };
export type RequirementReviewCommand = RequirementSource & {
  job: CareerTrainingJob; itemId: string; quote: string;
  sourceVersion: string; assessment: Assessment; contribution: Contribution;
};
export type EvidenceWorkspace = {
  facts: FactBase;
  links: RequirementEvidenceLink[];
  loadRetests: (job: CareerTrainingJob, item: DecomposedJdItem, signal: AbortSignal) => Promise<RetestEvidence[]>;
  save: (command: RequirementReviewCommand) => Promise<void>;
};
type RetestEvidence = NonNullable<ReturnType<typeof independentRetestEvidence>> & { kitId: string; kitVersion: string };

export function isRequirementTraining(kit: TrainingSummary, workspaceKeys: readonly string[], job: CareerTrainingJob, item: Pick<DecomposedJdItem, "id" | "originalQuote">) {
  const career = kit.career;
  const version = careerJobSnapshotVersion(job);
  return kit.stage === "complete" && !!career && workspaceKeys.includes(career.workspaceKey)
    && career.requirement.snapshotVersion === version && career.requirement.itemId === item.id
    && career.requirement.quote === item.originalQuote
    && (!career.capabilityId || career.capabilityId === careerRequirementCapabilityId(version, item.id, item.originalQuote));
}

export function requirementRetest(kit: TrainingView) {
  const retest = independentRetestEvidence(kit);
  return retest ? { ...retest, kitId: kit.id, kitVersion: kit.version } : undefined;
}

export type EvidenceSource = ReturnType<typeof evidenceSource>;

function evidenceSource(experience: Experience, claim: FactClaim) {
  const content = [experience.org, experience.projectName, experience.title, experience.start, experience.end,
    experience.type, experience.url, claim.kind, claim.text, claim.metric];
  const kind = experience.type === "education" || isBundledDemoWorkSource(experience, claim) ? "unconfirmed" : classifyRecommendationClaim(claim);
  return { experience, claim, sourceVersion: inventoryDigest([...content, claim.tags]), workIdentity: inventoryDigest(content), kind };
}
export function evidenceSources(facts: FactBase) {
  return facts.experiences.flatMap(experience => experience.claims.filter(claim => claim.text.zh.trim() || claim.text.en?.trim())
    .map(claim => evidenceSource(experience, claim)));
}
export function expectedContribution(quote: string): Contribution {
  if (/独立设计|架构设计|设计.{0,8}(系统|方案|数据库)|(?:design|architect)(?:ing)?\b/i.test(quote)) return "design";
  if (/协作|跨团队|\bcollaborat(?:e|ion|ing)\b/i.test(quote)) return "collaboration";
  if (/维护|运维|\bmaint(?:ain|enance)\b/i.test(quote)) return "maintenance";
  if (/实施|实现|开发|\bimplement(?:ation|ing)?\b/i.test(quote)) return "implementation";
  return "other";
}
export function canSupportRequirement(source: EvidenceSource, quote: string, contribution: Contribution) {
  if (source.kind !== "personal-action") return false;
  if (expectedContribution(quote) === "design") {
    const text = [source.claim.text.zh, source.claim.text.en].filter(Boolean).join(" ");
    const ownDesign = /(?:主导|独立|参与|负责|本人|我)(?:了)?[^，。；.!;]{0,10}(?:设计|选型|权衡)|(?:我|本人)(?:比较|选择|决定)|(?:designed|architected|chose|evaluated|weighed)\b/i.test(text);
    const followed = /(?:按|遵循|依照|基于)(?:照)?(?:他人|现有|既有|已有|原有|给定|既定|团队)?(?:的)?(?:数据库)?(?:设计|图纸|方案)|(?:followed|according to|based on) (?:an? |the )?(?:existing |provided )?(?:design|specification)/i.test(text);
    const requiresIndependent = /独立设计|independently (?:design|architect)/i.test(quote);
    const independentlyDesigned = /独立(?:完成|负责)?(?:架构)?设计|(?:independently|solely) (?:designed|architected)/i.test(text);
    return contribution === "design" && ownDesign && !followed && (!requiresIndependent || independentlyDesigned);
  }
  return true;
}
export function requirementSourceKey(link: RequirementSource) {
  return link.sourceKind === "independent-retest" ? `retest:${link.kitId}` : JSON.stringify([link.experienceId, link.claimId]);
}

export function currentRequirementLinks(links: RequirementEvidenceLink[]) {
  return [...new Map(links.map(link => [JSON.stringify([link.jobVersion, link.itemId, link.quote, requirementSourceKey(link)]), link])).values()];
}

export function currentLinkState(link: RequirementEvidenceLink, sources: EvidenceSource[]): Assessment | "outdated" | "observed" {
  if (link.assessment === "withdrawn") return "withdrawn";
  if (link.sourceKind === "independent-retest") return link.result === "met" ? "partial" : "observed";
  const source = sources.find(s => s.experience.id === link.experienceId && s.claim.id === link.claimId && s.sourceVersion === link.sourceVersion);
  if (!source) return "outdated";
  return link.assessment === "supports" && !canSupportRequirement(source, link.quote, link.contribution) ? "partial" : link.assessment;
}

export function withRequirementEvidence(document: BetterMeDocument, facts: FactBase, command: RequirementReviewCommand, reviewedAt: string, kit?: TrainingView, workspaceKeys: readonly string[] = []): BetterMeDocument {
  const item = careerTrainingRequirements(command.job).find(i => i.id === command.itemId && i.originalQuote === command.quote);
  if (!item) throw new Error("岗位要求已变化，请重新选择原句。");
  const jobVersion = careerJobSnapshotVersion(command.job);
  const capabilityId = careerRequirementCapabilityId(jobVersion, item.id, item.originalQuote);
  const links = document.requirementEvidence ?? [];
  const scoped = links.filter(entry => entry.jobVersion === jobVersion && entry.itemId === item.id && entry.quote === item.originalQuote);
  const previous = scoped.slice().reverse().find(entry => requirementSourceKey(entry) === requirementSourceKey(command));
  if (command.assessment === "withdrawn") {
    if (!previous || previous.sourceVersion !== command.sourceVersion) throw new Error("原关联已变化，请重新打开核对。");
    if (previous.assessment === "withdrawn") return document;
    return { ...document, requirementEvidence: [...links, { ...previous, capabilityId, assessment: "withdrawn", reviewedAt }] };
  }
  const review = { jobVersion, jobId: command.job.id, itemId: item.id, quote: item.originalQuote, capabilityId,
    sourceVersion: command.sourceVersion, contribution: command.contribution, assessment: command.assessment, reviewedAt };
  let record: RequirementEvidenceLink;
  if (command.sourceKind === "independent-retest") {
    const retest = kit && kit.id === command.kitId && isRequirementTraining(kit, workspaceKeys, command.job, item) && requirementRetest(kit);
    if (!retest || retest.version !== command.sourceVersion || command.assessment !== "partial")
      throw new Error("这份复测未能核对为本岗位要求的独立换情境作答。");
    record = { ...review, contribution: expectedContribution(item.originalQuote), sourceKind: command.sourceKind, kitId: retest.kitId, kitVersion: retest.kitVersion,
      questionVersion: retest.questionVersion, sourceLabel: retest.title, changedCondition: retest.change.after,
      criterion: retest.change.criterion, completedAt: retest.completedAt, result: retest.result };
  } else {
    const sources = evidenceSources(facts);
    const source = sources.find(s => s.experience.id === command.experienceId && s.claim.id === command.claimId && s.sourceVersion === command.sourceVersion);
    if (!source) throw new Error("材料已变化，请重新核对当前版本。");
    if ((source.kind !== "personal-action" && source.kind !== "self-report") || (command.assessment === "supports" && !canSupportRequirement(source, item.originalQuote, command.contribution)))
      throw new Error("这份材料尚不能支持所选判断。");
    const duplicate = currentRequirementLinks(scoped).some(link => link.sourceKind !== "independent-retest"
      && requirementSourceKey(link) !== requirementSourceKey(command)
      && (link.sourceVersion === source.sourceVersion || sources.some(candidate => candidate.experience.id === link.experienceId
        && candidate.claim.id === link.claimId && candidate.sourceVersion === link.sourceVersion && candidate.workIdentity === source.workIdentity))
      && ["supports", "partial"].includes(currentLinkState(link, sources)));
    if (duplicate) throw new Error("同一工作材料已关联。简历中的副本沿用原证据。");
    record = { ...review, sourceKind: "work", experienceId: command.experienceId, claimId: command.claimId,
      sourceLabel: source.experience.org.zh.slice(0, 1000), sourceExcerpt: (source.claim.text.zh || source.claim.text.en || "").slice(0, 2000) };
  }
  if (previous?.sourceVersion === record.sourceVersion && previous.contribution === record.contribution && previous.assessment === record.assessment)
    return document;
  return { ...document, requirementEvidence: [...links, record] };
}

/** Restoring résumé content from the same document keeps the latest review decisions. */
export function preserveRequirementReviews(snapshot: BetterMeDocument, current?: BetterMeDocument | null): BetterMeDocument {
  return current?.documentId && current.documentId === snapshot.documentId && current.requirementEvidence
    ? { ...snapshot, requirementEvidence: current.requirementEvidence }
    : snapshot;
}

export function requirementEvidenceAdvice(links: RequirementEvidenceLink[], sources: EvidenceSource[]) {
  const active = currentRequirementLinks(links);
  const work = active.some(link => link.sourceKind !== "independent-retest" && currentLinkState(link, sources) === "supports");
  const latest = active
    .filter((link): link is Extract<RequirementEvidenceLink, { sourceKind: "independent-retest" }> =>
      link.sourceKind === "independent-retest" && link.assessment !== "withdrawn")
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
  if (latest?.result === "missed") return "practice";
  if (latest?.result === "recorded") return "review";
  if (latest && work) return "prepare";
  if (latest) return "work";
  if (work) return "retest";
  return "clarify";
}

export function summarizeRequirements(items: DecomposedJdItem[], links: RequirementEvidenceLink[], sources: EvidenceSource[]) {
  let supported = 0, partial = 0;
  const active = currentRequirementLinks(links);
  for (const item of items) {
    const states = active.filter(link => link.itemId === item.id && link.quote === item.originalQuote).map(link => currentLinkState(link, sources));
    if (states.includes("supports")) supported++;
    else if (states.includes("partial")) partial++;
  }
  return { supported, partial, total: items.length };
}
export function recommendationReviewReader(links: RequirementEvidenceLink[], facts: FactBase) {
  const sources = evidenceSources(facts);
  const byId = new Map<string, RequirementEvidenceLink[]>();
  for (const link of links) if (link.jobId) {
    const group = byId.get(link.jobId) ?? [];
    group.push(link); byId.set(link.jobId, group);
  }
  return (job: CareerTrainingJob) => {
    const group = job.id && byId.get(job.id);
    if (!group) return undefined;
    const version = careerJobSnapshotVersion(job);
    const current = group.filter(link => link.jobVersion === version);
    if (current.length) return summarizeRequirements(careerTrainingRequirements(job), current, sources);
    return undefined;
  };
}
