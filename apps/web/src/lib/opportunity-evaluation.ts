import type { OpportunityEvaluationSample } from "./opportunities";

const routes = ["apply", "collect-evidence", "practice"] as const;
export type DecisionRoute = typeof routes[number];

/** Pilot review criteria are deliberately fixed for a small, local pilot.
 * Unknown outcomes and unreviewed responses never count as success. */
export const opportunityPilotCriteria = {
  knownOutcomesPerRoute: 3,
  gradedIndependentRetests: 6,
  minimumRetestMetRatio: 0.75,
  confirmedPositiveCorrections: 2,
} as const;

export function summarizeOpportunityEvaluations(samples: readonly OpportunityEvaluationSample[]) {
  const comparisons = routes.map(action => {
    const acted = samples.filter(sample => sample.actualAction === action);
    return {
      action, observations: acted.length,
      positive: acted.filter(sample => sample.outcome === "positive").length,
      neutral: acted.filter(sample => sample.outcome === "neutral").length,
      negative: acted.filter(sample => sample.outcome === "negative").length,
      unknown: acted.filter(sample => sample.outcome === "unknown").length,
      corrections: acted.filter(sample => sample.corrected).length,
    };
  });
  const retests = {
    met: samples.filter(sample => sample.independentRetest === "met").length,
    missed: samples.filter(sample => sample.independentRetest === "missed").length,
    unreviewed: samples.filter(sample => sample.independentRetest === "unreviewed").length,
    unknown: samples.filter(sample => sample.independentRetest === "unknown").length,
  };
  const positiveCorrections = samples.filter(sample => sample.corrected && sample.outcome === "positive").length;
  const gradedRetests = retests.met + retests.missed;
  const criteria = opportunityPilotCriteria;
  const checks = {
    diverseKnownOutcomes: comparisons.every(route => route.positive + route.neutral + route.negative >= criteria.knownOutcomesPerRoute),
    independentRetestQuality: gradedRetests >= criteria.gradedIndependentRetests && retests.met / gradedRetests >= criteria.minimumRetestMetRatio,
    observedCorrections: positiveCorrections >= criteria.confirmedPositiveCorrections,
  };
  return {
    samples: samples.length, comparisons, retests, positiveCorrections, checks,
    readyForReview: Object.values(checks).every(Boolean),
  };
}
