import { isDeepStrictEqual } from "node:util";
import type { EvidenceReviewInput, EvidenceReviewReport, JobComparisonInput, NormalizedJob, RequirementReference } from "@better-me/agent-contracts";
import { hash } from "./verification.js";
import { LIMITS } from "./sandbox.js";

export const EVIDENCE_VERIFIER = "job-evidence-check-v1";
export const EVIDENCE_RECIPE = Object.freeze({ id: "job-evidence-review", version: 1,
  recipeHash: hash({ recipe: "job-evidence-review-v1", links: "exact-snapshot-position-and-text", claims: "pending-only", verifier: EVIDENCE_VERIFIER }),
  verifier: EVIDENCE_VERIFIER });
const questions = { needs_evidence: "这条要求有哪些可提供的项目材料？没有材料不等于你不会。",
  needs_personal_confirmation: "线索是否相关、确属你的经历？你具体做了什么，有哪些可核实的行动和结果？" };
const limitations = ["线索及关联由本次输入提供，未核实材料真实性、归属或相关性。", "项目背景不等于个人贡献；所有项目线索均待本人核对，不认证技能或自动写入简历。"];
const reference = (row: NormalizedJob, requirementIndex: number, text: string): RequirementReference => ({ rowIndex: row.index,
  requirementIndex, sourceNamespace: row.sourceNamespace, jobId: row.jobId, snapshotAt: row.snapshotAt, text });
const matches = (a: RequirementReference, b: RequirementReference) => a.rowIndex === b.rowIndex && a.requirementIndex === b.requirementIndex
  && a.sourceNamespace === b.sourceNamespace && a.jobId === b.jobId && a.snapshotAt === b.snapshotAt && a.text === b.text;

/** Trusted composition consumes already-verified generated output. No model or file access. */
export function prepareEvidenceReview(rows: NormalizedJob[], evidence: EvidenceReviewInput): EvidenceReviewReport {
  const targets = rows.filter(row => row.batch === "after");
  const items: EvidenceReviewReport["items"] = []; let bytes = 0;
  for (const row of targets) for (const [index, text] of row.requirements.entries()) {
    const requirement = reference(row, index, text), evidenceIds = evidence.notes.filter(note => note.links.some(link => matches(link, requirement))).map(note => note.id);
    const status: EvidenceReviewReport["items"][number]["status"] = evidenceIds.length ? "needs_personal_confirmation" : "needs_evidence";
    const item = { requirement, title: row.title, evidenceIds, status, question: questions[status] };
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > LIMITS.outputBytes) throw Error("evidence_report_output_limit");
    items.push(item);
  }
  const report = { rowsReviewed: targets.length, emptyJobRows: targets.filter(row => !row.requirements.length).map(row => row.index), items,
    unresolvedLinks: evidence.notes.flatMap(note => note.links.flatMap((link, linkIndex) => items.some(item => matches(link, item.requirement)) ? []
      : [{ evidenceId: note.id, linkIndex, reason: "引用与本次岗位快照不符：未用于关联" }])),
    unlinkedEvidenceIds: evidence.notes.filter(note => !items.some(item => item.evidenceIds.includes(note.id))).map(note => note.id), limitations: [...limitations] };
  if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.outputBytes) throw Error("evidence_report_output_limit");
  return report;
}

/** Independently checks the business artifact against raw input, not its producer's success flag. */
export function verifyEvidenceReview(input: JobComparisonInput, evidence: EvidenceReviewInput, report: EvidenceReviewReport): void {
  const batch = input.after;
  const jobs = batch.format === "board-v1" ? batch.jobs.map(job => ({ id: job.jobId, title: job.title, requirements: job.requirements }))
    : batch.positions.map(job => ({ id: job.id, title: job.name, requirements: job.needs }));
  let cursor = 0;
  for (const [rowIndex, job] of jobs.entries()) for (const [requirementIndex, text] of job.requirements.entries()) {
    const item = report.items[cursor++];
    const expected = { rowIndex, requirementIndex, sourceNamespace: batch.sourceNamespace, jobId: job.id, snapshotAt: batch.capturedAt, text };
    if (!item || !isDeepStrictEqual(item.requirement, expected) || item.title !== job.title) throw Error("evidence_source_mismatch");
    const ids = evidence.notes.filter(note => note.links.some(link => matches(link, expected))).map(note => note.id);
    const status = ids.length ? "needs_personal_confirmation" : "needs_evidence";
    if (!isDeepStrictEqual(item.evidenceIds, ids) || item.status !== status || item.question !== questions[status]) throw Error("evidence_claim_not_pending");
  }
  const unresolved = evidence.notes.flatMap(note => note.links.flatMap((link, linkIndex) => {
    const job = jobs[link.rowIndex];
    const valid = job && link.sourceNamespace === batch.sourceNamespace && link.jobId === job.id && link.snapshotAt === batch.capturedAt
      && job.requirements[link.requirementIndex] === link.text;
    return valid ? [] : [{ evidenceId: note.id, linkIndex, reason: "引用与本次岗位快照不符：未用于关联" }];
  }));
  if (cursor !== report.items.length || report.rowsReviewed !== jobs.length || !isDeepStrictEqual(report.limitations, limitations)
    || !isDeepStrictEqual(report.emptyJobRows, jobs.flatMap((job, i) => job.requirements.length ? [] : [i]))
    || !isDeepStrictEqual(report.unresolvedLinks, unresolved)
    || !isDeepStrictEqual(report.unlinkedEvidenceIds, evidence.notes.filter(note => !report.items.some(item => item.evidenceIds.includes(note.id))).map(note => note.id)))
    throw Error("evidence_coverage_mismatch");
}
