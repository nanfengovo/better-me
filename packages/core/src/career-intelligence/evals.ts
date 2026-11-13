import type { CommitteeIssueCode, CommitteeReport, CommitteeSnapshot, CommitteeStatus, EvidenceSupport } from "./contracts.js";
import { validateCommitteeCitation } from "./claims.js";

export type CommitteeGoldenExpectation = {
  status: CommitteeStatus; support: EvidenceSupport; requiredIssueCodes?: CommitteeIssueCode[];
  rewriteAllowed: boolean; citationEvidenceIds: string[];
};
export type CommitteeGoldenCase = {
  id: string; description: string; tags: string[]; snapshot: CommitteeSnapshot;
  expected: CommitteeGoldenExpectation;
};
export type CommitteeGoldenResult = {
  id: string; passed: boolean; failures: string[]; status: CommitteeStatus;
  faithfulness: { correct: number; total: number };
  citations: { correct: number; total: number };
  modelCalls: number; toolCalls: number; outputCharacters: number; elapsedMs: number;
};
export type CommitteeGoldenSummary = {
  schemaVersion: 1; adapterId: string; judgeVersion: "committee-golden-v1";
  cases: CommitteeGoldenResult[];
  metrics: { expectationPassRate: number; faithfulness: number | null; citationPrecision: number | null;
    incompleteRate: number; toolSteps: { total: number; mean: number; p95: number; max: number };
    modelCalls: number; outputCharacters: number; elapsedMs: number };
  limitations: string[];
};

/** Expectations are independent data. This judge never asks the generating model to grade itself. */
export function judgeCommitteeGoldenCase(test: CommitteeGoldenCase, report: CommitteeReport): CommitteeGoldenResult {
  const failures: string[] = [];
  const expectedIds = test.snapshot.claims.map(claim => claim.id);
  const validIdentity = report.snapshotFingerprint === test.snapshot.fingerprint && report.claims.length === expectedIds.length
    && new Set(report.claims.map(claim => claim.claimId)).size === report.claims.length
    && report.claims.every(claim => test.snapshot.claims.some(expected => expected.id === claim.claimId && expected.hash === claim.claimHash));
  if (!validIdentity) failures.push("report identity, claim IDs, hashes or cardinality do not match the independent test snapshot");
  if (report.status !== test.expected.status) failures.push(`status: expected ${test.expected.status}, got ${report.status}`);
  const correctSupport = validIdentity ? report.claims.filter(claim => claim.support === test.expected.support).length : 0;
  if (correctSupport !== test.snapshot.claims.length) failures.push(`support: expected ${test.expected.support} for all selected claims; observed ${report.claims.map(claim => `${claim.claimId}=${claim.support}`).join(", ")}`);
  const rewriteCorrect = validIdentity && report.claims.every(claim => Boolean(claim.rewriteProposal) === test.expected.rewriteAllowed);
  if (!rewriteCorrect) failures.push(`rewriteAllowed: expected ${test.expected.rewriteAllowed}`);
  for (const code of test.expected.requiredIssueCodes ?? [])
    if (!report.issues.some(issue => issue.code === code)) failures.push(`missing issue: ${code}`);
  const citations = report.claims.flatMap(claim => [...claim.citations, ...claim.counterCitations]);
  const completeRanges = test.snapshot.evidence.map(item => ({ evidenceId: item.id, startLine: item.startLine, endLine: item.endLine }));
  const valid = citations.filter(citation => test.expected.citationEvidenceIds.includes(citation.evidenceId)
    && validateCommitteeCitation(citation, test.snapshot, completeRanges) === undefined).length;
  if (valid !== citations.length) failures.push("accepted citation is outside independently expected evidence");
  return { id: test.id, passed: failures.length === 0, failures, status: report.status,
    faithfulness: { correct: correctSupport + Number(rewriteCorrect), total: test.snapshot.claims.length + 1 },
    citations: { correct: valid, total: citations.length }, ...report.usage };
}

/** A runner can use scripted protocol fixtures or a real authorized local-model adapter. */
export async function runGoldenEvals<T extends CommitteeGoldenCase>(cases: readonly T[], options: {
  adapterId: string; run: (test: T) => Promise<CommitteeReport>;
}): Promise<CommitteeGoldenSummary> {
  if (!cases.length || new Set(cases.map(test => test.id)).size !== cases.length) throw new Error("Golden evals need nonempty, uniquely identified cases.");
  const results: CommitteeGoldenResult[] = [];
  for (const test of cases) results.push(judgeCommitteeGoldenCase(test, await options.run(test)));
  const sum = (select: (result: CommitteeGoldenResult) => number) => results.reduce((total, result) => total + select(result), 0);
  const faithfulTotal = sum(result => result.faithfulness.total);
  const citationTotal = sum(result => result.citations.total);
  const steps = results.map(result => result.toolCalls).sort((a, b) => a - b);
  return { schemaVersion: 1, adapterId: options.adapterId, judgeVersion: "committee-golden-v1", cases: results,
    metrics: { expectationPassRate: sum(result => Number(result.passed)) / results.length,
      faithfulness: faithfulTotal ? sum(result => result.faithfulness.correct) / faithfulTotal : null,
      citationPrecision: citationTotal ? sum(result => result.citations.correct) / citationTotal : null,
      incompleteRate: sum(result => Number(result.status !== "completed")) / results.length,
      toolSteps: { total: sum(result => result.toolCalls), mean: sum(result => result.toolCalls) / results.length,
        p95: steps[Math.ceil(steps.length * 0.95) - 1] ?? 0, max: steps.at(-1) ?? 0 },
      modelCalls: sum(result => result.modelCalls), outputCharacters: sum(result => result.outputCharacters), elapsedMs: sum(result => result.elapsedMs) },
    limitations: ["Scripted protocol-fixture scores verify guardrails, not real-model semantic accuracy.",
      "Citation precision uses independent expected evidence IDs, not merely schema validity; a case without citations contributes no denominator.",
      "Incomplete rate includes intentionally cancelled/budget/stale adversarial cases; inspect per-case expectations before interpreting it.",
      "Faithfulness is benchmark agreement within these fixtures, not a zero-hallucination guarantee or hiring probability.",
      "Calls/characters/time are observed execution cost proxies; monetary/token cost is not fabricated."],
  };
}
