import { validateResumeQualityCase } from "../../../packages/core/src/career-intelligence/resume-quality.ts";
import { piiFindings, jobLinkFindings } from "./extract.mjs";

/** Explicit allowlist: candidate generation never sees scoring labels or identifying provenance. */
export async function goldModelMaterial(rawCase, rawGroups) {
  const test = await validateResumeQualityCase(rawCase);
  if (!Array.isArray(rawGroups)) throw Error("Candidate groups are required.");
  const groups = rawGroups.map(group => {
    for (const key of ["id", "title", "organization", "dates", "kind"]) if (typeof group[key] !== "string" || !group[key]) throw Error("Invalid candidate context group.");
    return { id: group.id, title: group.title, organization: group.organization, originalPeriod: group.dates, kind: group.kind };
  });
  const candidate = { groups, evidence: test.evidence.map(e => ({ id: e.id, text: e.text, sha256: e.sha256 })) };
  if (piiFindings(JSON.stringify(candidate)).length) throw Error("Candidate material contains contact or identifying terms.");
  if (jobLinkFindings(test.job.text).length) throw Error("Job material has unapproved links or contact data.");
  return { schemaVersion: 1, caseId: test.id, role: test.role, job: { text: test.job.text, sha256: test.job.sha256 }, candidate,
    sourcePolicy: "Author self-report, not independently verified. Preserve team/assistance/internship/academic/mobile/fictional qualifiers and original date precision; ask or leave unknown instead of filling gaps." };
}
