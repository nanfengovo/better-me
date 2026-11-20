import assert from "node:assert/strict";
import test from "node:test";
import { recommendOpportunityAction, type OpportunityDecisionEvidence, type OpportunityEvaluationSample, type OpportunityStatus } from "../src/lib/opportunities";
import { opportunityPilotCriteria, summarizeOpportunityEvaluations, type DecisionRoute } from "../src/lib/opportunity-evaluation";

const evidence = (supported: number, total: number, results: ("met" | "missed" | "recorded")[] = [], partial = 0): OpportunityDecisionEvidence => ({
  supported, partial, total, independentRetests: results.map((result, index) => ({
    kitId: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    questionVersion: "1".repeat(64), capabilityId: "2".repeat(64), sourceVersion: "3".repeat(64),
    result,
  })),
});

// Frozen synthetic review scenarios. Labels describe the reasonable next step
// under the evidence and availability conditions, not an observed hiring outcome.
const cases: readonly { name: string; status: OpportunityStatus; evidence: OpportunityDecisionEvidence; expected: DecisionRoute }[] = [
  { name: "open role with all material reviewed", status: "open", evidence: evidence(3, 3), expected: "apply" },
  { name: "single clear requirement", status: "open", evidence: evidence(1, 1), expected: "apply" },
  { name: "reviewed work plus matching assessed retest", status: "open", evidence: evidence(2, 2, ["met"]), expected: "apply" },
  { name: "many affirmative work records with no retest needed", status: "open", evidence: evidence(7, 7), expected: "apply" },
  { name: "important requirement lacks work evidence", status: "open", evidence: evidence(1, 2), expected: "collect-evidence" },
  { name: "no reviewable requirement yet", status: "open", evidence: evidence(0, 0), expected: "collect-evidence" },
  { name: "written retest recorded without assessment", status: "open", evidence: evidence(2, 2, ["recorded"]), expected: "collect-evidence" },
  { name: "closed posting despite complete evidence", status: "closed", evidence: evidence(2, 2), expected: "collect-evidence" },
  { name: "unverified opportunity availability", status: "unknown", evidence: evidence(2, 2), expected: "collect-evidence" },
  { name: "passing retest as partial evidence only", status: "open", evidence: evidence(0, 1, ["met"], 1), expected: "collect-evidence" },
  { name: "first independent retest misses a requirement", status: "open", evidence: evidence(1, 2, ["missed"]), expected: "practice" },
  { name: "work evidence but failed independent transfer", status: "open", evidence: evidence(2, 2, ["missed"]), expected: "practice" },
  { name: "mixed independent outcomes", status: "open", evidence: evidence(1, 3, ["met", "missed"], 1), expected: "practice" },
  { name: "independent scenario still misses crucial condition", status: "open", evidence: evidence(0, 1, ["missed"]), expected: "practice" },
];

test("compare three fixed routes and evidence-aware recommendations on frozen synthetic labels", () => {
  const result = cases.map(row => recommendOpportunityAction(row.evidence, row.status).action);
  const scores = ["apply", "collect-evidence", "practice"].map(action => cases.filter(row => row.expected === action).length);
  const agreement = cases.filter((row, index) => row.expected === result[index]).length;
  for (const [index, row] of cases.entries()) assert.equal(result[index], row.expected, row.name);
  assert.deepEqual(scores, [4, 6, 4], "each fixed baseline uses exactly the same scenarios");
  assert.equal(agreement, 14);
  console.log("Synthetic decision agreement: evidence-aware 14/14; always apply 4/14; always collect 6/14; always practice 4/14. No hiring outcomes inferred.");
});

test("anonymous pilot summary preserves missing outcomes, separates each chosen route, and requires retest plus observed correction evidence", () => {
  const sample = (actualAction: DecisionRoute, outcome: OpportunityEvaluationSample["outcome"], independentRetest: OpportunityEvaluationSample["independentRetest"], corrected = false): OpportunityEvaluationSample => ({
    schemaVersion: 1, recommendedAction: corrected ? (actualAction === "apply" ? "practice" : "apply") : actualAction,
    actualAction, outcome, corrected, independentRetest,
  });
  const unknownOnly = summarizeOpportunityEvaluations(Array.from({ length: 20 }, () => sample("apply", "unknown", "unreviewed", true)));
  assert.equal(unknownOnly.readyForReview, false);
  assert.equal(unknownOnly.comparisons[0]?.unknown, 20);
  assert.equal(unknownOnly.positiveCorrections, 0);
  const complete = (["apply", "collect-evidence", "practice"] as const).flatMap(action =>
    Array.from({ length: opportunityPilotCriteria.knownOutcomesPerRoute }, (_, index) => sample(action, "positive", "met", index === 0)));
  const trial = summarizeOpportunityEvaluations(complete);
  assert.equal(trial.readyForReview, true);
  assert.deepEqual(trial.comparisons.map(route => [route.observations, route.positive, route.corrections]), [[3, 3, 1], [3, 3, 1], [3, 3, 1]]);
  const unsupported = summarizeOpportunityEvaluations(complete.map(item => ({ ...item, outcome: "unknown" })));
  assert.equal(unsupported.readyForReview, false);
  const ungraded = summarizeOpportunityEvaluations(complete.map(item => ({ ...item, independentRetest: "unreviewed" })));
  assert.equal(ungraded.readyForReview, false);
});
