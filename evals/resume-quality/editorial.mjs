import { ResumeCandidateSourceSchema } from "../../packages/agent-contracts/src/resume-candidate.ts";
import { judgeResumeQuality } from "../../packages/core/src/career-intelligence/resume-quality.ts";

const ratio = (n, d) => d ? Number((100 * n / d).toFixed(2)) : null;
const normalized = text => text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
const groupFields = ["id", "title", "organization", "originalPeriod", "kind"];
const groupMetadata = group => Object.fromEntries(groupFields.map(key => [key, group[key]]));

/** Deliberately narrow partial order: explicit Since YYYY / YYYY-YYYY only.
 * Ambiguous or finer date formats stay unassessed, not guessed into months. */
export function reviewSourceChronology(groups) {
  const work = groups.filter(g => ["employment", "internship", "freelance"].includes(g.kind));
  const known = [], unassessedGroupIds = [], inversions = [];
  for (const group of work) {
    const ongoing = /^Since (\d{4})$/u.exec(group.originalPeriod);
    const range = /^(\d{4})\s*[-–—]\s*(\d{4})$/u.exec(group.originalPeriod);
    if (ongoing) known.push({ group, ongoing: true, endYear: null });
    else if (range && Number(range[1]) <= Number(range[2])) known.push({ group, ongoing: false, endYear: Number(range[2]) });
    else unassessedGroupIds.push(group.id);
  }
  for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) {
    const before = known[i], after = known[j];
    if ((!before.ongoing && after.ongoing) || (!before.ongoing && !after.ongoing && before.endYear < after.endYear))
      inversions.push({ beforeGroupId: before.group.id, afterGroupId: after.group.id,
        beforePeriod: before.group.originalPeriod, afterPeriod: after.group.originalPeriod });
  }
  return { inversions, unassessedGroupIds, policy: "Partial order from explicit original Since YYYY and YYYY-YYYY fields only; equal end years and ambiguous periods are not ordered." };
}

/** Independent source-aware editorial screening, not a second model or approval.
 * Caller must reconstruct this full material from the verified frozen archive;
 * candidate-selected groups alone cannot establish document completeness.
 * Gold support/STAR labels remain offline and never enter the generator prompt. */
export async function reviewEditorialCompleteness(test, run, rawMaterial) {
  const source = ResumeCandidateSourceSchema.parse(rawMaterial);
  if (source.caseId !== test.id || !("sourceCandidate" in run)) throw Error("editorial_full_source_candidate_required");
  for (const evidence of source.candidate.evidence) {
    const original = test.evidence.find(e => e.id === evidence.id);
    if (!original || original.sha256 !== evidence.sha256 || original.text !== evidence.text) throw Error("editorial_source_changed");
  }
  if (source.candidate.evidence.length !== test.evidence.length) throw Error("editorial_source_incomplete");
  const groups = source.candidate.groups.map(groupMetadata);
  if (groups.some(g => groupFields.some(key => typeof g[key] !== "string" || !g[key]))) throw Error("editorial_source_metadata_required");
  for (const selected of run.sourceCandidate.groups) {
    const original = groups.find(g => g.id === selected.id);
    if (!original || JSON.stringify(groupMetadata(selected)) !== JSON.stringify(original)) throw Error("editorial_group_metadata_changed");
    for (const claim of selected.claims) {
      if (run.citations.filter(c => c.claimId === claim.id).some(ref => !source.candidate.evidence.some(e => e.id === ref.evidenceId && e.groupId === selected.id)))
        throw Error("editorial_cross_group_citation");
    }
  }
  const judged = await judgeResumeQuality(test, run);
  const chosen = new Set(run.sourceCandidate.groups.map(g => g.id));
  const selected = run.sourceCandidate.groups.map(groupMetadata), omitted = groups.filter(g => !chosen.has(g.id));
  const chronology = reviewSourceChronology(selected);
  const supported = judged.coverage.requirements.filter(r => r.support === "supported");
  const uncovered = supported.filter(r => !r.claimIds.length).map(r => ({ id: r.id, original: r.original, weight: r.weight }));
  const supportedWeight = supported.reduce((n, r) => n + r.weight, 0);
  const claims = judged.antiHallucination.claims;
  const sourceRelocationFindings = run.sourceCandidate.groups.flatMap(group => group.claims.flatMap(claim => {
    // A whole exact candidate wording found only in another source group is an
    // actionable attribution lead, not permission to transfer or repair it.
    // Sentence-final punctuation can become a source attribution suffix
    // ("analysis: Research project B."); retain every content word/qualifier.
    const wording = normalized(claim.text).replace(/[.!?。！？]+$/u, "").trim();
    if (!wording) return [];
    if (source.candidate.evidence.some(e => e.groupId === group.id && normalized(e.text).includes(wording))) return [];
    const possibleSources = source.candidate.evidence.filter(e => e.groupId !== group.id && normalized(e.text).includes(wording))
      .map(e => ({ evidenceId: e.id, groupId: e.groupId, kind: e.kind, sourceSha256: e.sha256, text: e.text }));
    return possibleSources.length ? [{ claimId: claim.id, renderedGroupId: group.id, possibleSources }] : [];
  }));
  const semanticReviewClaimIds = claims.filter(c => c.requiresSemanticReview).map(c => c.claimId);
  const screenFindings = claims.filter(c => c.invalidCitations || c.unsupportedEntities.length || c.unsupportedNumbers.length).map(c => ({
    claimId: c.claimId, invalidCitations: c.invalidCitations, unsupportedEntities: c.unsupportedEntities, unsupportedNumbers: c.unsupportedNumbers,
  }));
  const resultsAvailableButAbsent = [], resultsMissingInSource = [];
  for (const claim of claims) {
    const available = test.evidence.some(e => claim.citedEvidenceIds.includes(e.id) && e.star.result.length);
    if (!available) resultsMissingInSource.push(claim.claimId);
    else if (!claim.star.result) resultsAvailableButAbsent.push(claim.claimId);
  }
  const byWording = new Map();
  for (const claim of claims) { const key = normalized(claim.text); byWording.set(key, [...(byWording.get(key) ?? []), claim.claimId]); }
  const duplicateClaimGroups = [...byWording.values()].filter(ids => ids.length > 1);
  const headingOnlyClaimIds = run.sourceCandidate.groups.flatMap(g => g.claims.filter(c =>
    [g.title, g.organization, `${g.title} ${g.organization}`, `${g.organization} ${g.title}`].some(heading => normalized(heading) === normalized(c.text))).map(c => c.id));
  const findings = [];
  const add = (code, condition, detail) => { if (condition) findings.push({ code, detail }); };
  add("semantic_review_required", semanticReviewClaimIds.length, "Unknown paraphrases need independent source review; a valid handle does not certify wording.");
  add("fact_screen_findings", screenFindings.length, "Review complete name/number/citation findings against the cited role, not the JD or another employer.");
  add("source_groups_not_selected", omitted.length, "Review omitted source groups, especially recent work and representative delivery. Omission is not automatically an error; one page need not include every old project.");
  add("supported_requirements_not_covered", uncovered.length, "Source-reviewed supported JD requirements remain uncovered. This is not permission to copy them from the JD.");
  add("no_fully_supported_requirements", supported.length === 0, "This source/JD pair has no fully supported requirement labels. Supported-only coverage is unknown, not a zero writing score; inspect partial matches and improve dataset representativeness without relabelling gaps as support.");
  add("available_result_not_expressed", resultsAvailableButAbsent.length, "A cited source has a labelled result not expressed in the candidate; inspect before revising, do not infer semantic absence from this lexical check alone.");
  add("result_not_in_cited_source", resultsMissingInSource.length, "Keep supported actions/purpose and ask for missing observable results. Do not manufacture results or force every bullet into numeric STAR.");
  add("duplicate_bullets", duplicateClaimGroups.length, "Exact normalized wording repeats; review complementary contributions without fabricating a new one.");
  add("heading_only_bullets", headingOnlyClaimIds.length, "A role/employer heading alone does not describe a contribution.");
  add("work_chronology_inversion", chronology.inversions.length, "Explicit original work periods contradict reverse chronology; inspect the unchanged candidate order. Ambiguous dates are not guessed or repaired.");
  add("possible_source_relocation", sourceRelocationFindings.length, "Complete proposed wording occurs in another source group, not this role's evidence. Review academic/project/employer attribution; do not silently replace the citation or move the claim.");
  return { schemaVersion: 1, policyVersion: "resume-editorial-v1", status: findings.length ? "requires_review" : "no_rule_findings",
    overallQualityPassed: null, caseId: test.id, caseSha256: judged.caseSha256, runSha256: judged.runSha256,
    sourceGroups: { selected, omitted, selectedPercent: ratio(selected.length, groups.length), datePolicy: "Original date strings retained; no inferred months, chronology or recent-role certification." },
    supportedRequirements: { percent: ratio(supported.filter(r => r.claimIds.length).reduce((n, r) => n + r.weight, 0), supportedWeight), availableWeight: supportedWeight, uncovered,
      notEvidencedIds: judged.coverage.requirements.filter(r => r.support === "not_evidenced").map(r => r.id),
      partialIds: judged.coverage.requirements.filter(r => r.support === "partial").map(r => r.id) },
    facts: { semanticReviewClaimIds, screenFindings }, star: { resultsAvailableButAbsent, resultsMissingInSource }, chronology, sourceRelocationFindings, duplicateClaimGroups, headingOnlyClaimIds, findings,
    limitations: ["No overall quality or factual approval is inferred from the absence of rule findings. Independent semantic and human editorial review remain necessary.",
      "All omitted source groups and their unchanged dates are exposed; presence/coverage alone does not prove a useful or complete resume.",
      "Supported JD and STAR labels are offline source-reviewed annotations, not generator self-scores or independent employment verification.",
      "Actual A4 density, orphan and clipping checks remain a separate rendered-artifact axis; this review imposes no invented density threshold."] };
}
