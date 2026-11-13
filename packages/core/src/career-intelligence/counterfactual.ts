import { z } from "zod";
import { EvidenceProvenanceSchema, EvidenceSupportSchema, PersonalContributionSchema } from "./contracts.js";
import {
  IntelligenceAuthorizationSchema, IntelligenceBindingSchema, IntelligenceHashSchema, IntelligenceIdSchema,
  IntelligenceSalarySchema, IntelligenceSourceSchema, IntelligenceInputError,
  ageDays, assertSources, assertUniqueIds, intelligenceHash, intelligenceIsCurrent,
  type IntelligenceAccessOptions,
} from "./snapshots.js";

export const SimulationFactSchema = z.object({
  id: IntelligenceIdSchema, revision: IntelligenceIdSchema, hash: IntelligenceHashSchema,
  text: z.string().min(1).max(8000), skillIds: z.array(IntelligenceIdSchema).max(100),
  support: EvidenceSupportSchema, contribution: PersonalContributionSchema, provenance: EvidenceProvenanceSchema,
  sourceIds: z.array(IntelligenceIdSchema).max(100), confirmedByUser: z.boolean(),
}).strict();
export type SimulationFact = z.infer<typeof SimulationFactSchema>;
export const SimulationRequirementSchema = z.object({
  id: IntelligenceIdSchema, skillId: IntelligenceIdSchema, weight: z.number().finite().positive().max(100),
  hard: z.boolean(), knowledge: z.enum(["known", "unknown"]), contribution: z.enum(["implementation", "design", "any"]),
}).strict();
export const SimulationJobSchema = z.object({
  id: IntelligenceIdSchema, revision: IntelligenceIdSchema, sourceIds: z.array(IntelligenceIdSchema).max(50),
  availability: z.enum(["active", "closed", "unknown"]), verifiedAt: z.string().datetime().nullable(),
  requirements: z.array(SimulationRequirementSchema).max(100), salary: IntelligenceSalarySchema,
}).strict();
export const SimulationRulesSchema = z.object({
  version: IntelligenceIdSchema, maxObservationAgeDays: z.number().finite().positive().max(3650),
  unlockCoverageThreshold: z.number().finite().min(0).max(100), selfReportedWeight: z.number().finite().min(0).max(1),
  highSalary: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minAnnual: z.number().finite().nonnegative() }).strict().optional(),
}).strict();
export const CareerSimulationSnapshotSchema = z.object({
  schemaVersion: z.literal(1), binding: IntelligenceBindingSchema,
  authorization: IntelligenceAuthorizationSchema.extend({ purpose: z.literal("career_simulation") }).strict(),
  cohort: z.object({ id: IntelligenceIdSchema, revision: IntelligenceIdSchema, asOf: z.string().datetime(),
    jobs: z.array(SimulationJobSchema).min(1).max(2000) }).strict(),
  facts: z.array(SimulationFactSchema).max(2000), sources: z.array(IntelligenceSourceSchema).max(2000),
  rules: SimulationRulesSchema, fingerprint: IntelligenceHashSchema,
}).strict();
export type CareerSimulationSnapshot = z.infer<typeof CareerSimulationSnapshotSchema>;
export const CareerInvestmentPlanSchema = z.object({
  id: IntelligenceIdSchema, description: z.string().min(1).max(4000),
  hypotheticalFacts: z.array(z.object({ id: IntelligenceIdSchema, description: z.string().min(1).max(4000),
    skillIds: z.array(IntelligenceIdSchema).min(1).max(100), contribution: z.enum(["implementation", "design"]),
  }).strict()).max(100),
  cost: z.object({ hours: z.number().finite().positive().max(10000).optional(), days: z.number().finite().positive().max(3650).optional(),
    money: z.object({ amount: z.number().finite().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict().optional(),
  }).strict(),
  sensitivities: z.array(z.object({ id: IntelligenceIdSchema, realizationFraction: z.number().finite().min(0).max(1),
    transferability: z.number().finite().min(0).max(1) }).strict()).min(1).max(20),
}).strict();
export type CareerInvestmentPlan = z.infer<typeof CareerInvestmentPlanSchema>;
type Coverage = { jobId: string; coverage: number; eligible: boolean; blockers: string[]; unknowns: string[];
  requirementEvidence: Array<{ requirementId: string; strength: number; factIds: string[]; hypotheticalIds: string[] }> };
export type CareerSimulationReport = {
  schemaVersion: 1; snapshotFingerprint: string; planFingerprint: string; status: "completed" | "stale";
  cohortId: string; cohortRevision: string; rulesVersion: string;
  baseline: { jobs: Coverage[]; distribution: CoverageDistribution } | null;
  scenarios: Array<{ id: string; hypothetical: true; realizationFraction: number; transferability: number; jobs: Coverage[];
    distribution: CoverageDistribution; meanCoverageDelta: number; conditionalUnlocks: string[]; highSalaryConditionalUnlocks: string[];
    salaryUnknownUnlocks: string[]; roi: { coveragePointsPerHour: number | null; coveragePointsPerMoneyUnit: number | null; moneyCurrency: string | null } }>;
  sensitivityBounds: { minMeanCoverageDelta: number; maxMeanCoverageDelta: number } | null;
  cost: CareerInvestmentPlan["cost"]; unknowns: string[]; limitations: string[];
};
export type CoverageDistribution = { min: number; p25: number; median: number; p75: number; max: number; mean: number };

export async function createCareerSimulationSnapshot(input: Omit<CareerSimulationSnapshot, "schemaVersion" | "fingerprint" | "facts"> & {
  facts: Array<Omit<SimulationFact, "hash">>;
}): Promise<CareerSimulationSnapshot> {
  const facts = await Promise.all(input.facts.map(async fact => ({ ...fact, hash: await intelligenceHash(fact) })));
  const unsigned = { ...input, facts, schemaVersion: 1 as const };
  return validateCareerSimulationSnapshot(CareerSimulationSnapshotSchema.parse({ ...unsigned, fingerprint: await intelligenceHash(unsigned) }));
}
export async function validateCareerSimulationSnapshot(input: unknown): Promise<CareerSimulationSnapshot> {
  const snapshot = CareerSimulationSnapshotSchema.parse(input);
  if (JSON.stringify(snapshot).length > 4_000_000) throw new IntelligenceInputError("snapshot_size_exceeded");
  const { fingerprint, ...unsigned } = snapshot;
  if (fingerprint !== await intelligenceHash(unsigned)) throw new IntelligenceInputError("snapshot_fingerprint_changed");
  assertUniqueIds(snapshot.sources.map(item => item.id), "duplicate_source_id");
  assertUniqueIds(snapshot.facts.map(item => item.id), "duplicate_fact_id");
  assertUniqueIds(snapshot.cohort.jobs.map(item => item.id), "duplicate_job_id");
  assertUniqueIds(snapshot.authorization.sourceIds, "duplicate_granted_source_id");
  assertSources(snapshot.authorization.sourceIds, snapshot.sources, snapshot.authorization.sourceIds);
  if (snapshot.rules.version !== snapshot.binding.rulesVersion) throw new IntelligenceInputError("rules_version_mismatch");
  for (const fact of snapshot.facts) {
    const { hash, ...payload } = fact;
    if (hash !== await intelligenceHash(payload)) throw new IntelligenceInputError("fact_hash_changed");
    assertUniqueIds(fact.skillIds, "duplicate_skill_id");
    assertSources(fact.sourceIds, snapshot.sources, snapshot.authorization.sourceIds);
  }
  for (const job of snapshot.cohort.jobs) {
    assertUniqueIds(job.requirements.map(item => item.id), "duplicate_requirement_id");
    assertSources(job.sourceIds, snapshot.sources, snapshot.authorization.sourceIds);
    if (job.availability === "active" && (!job.sourceIds.length || !job.verifiedAt)) throw new IntelligenceInputError("active_job_needs_observation");
    if (job.salary.status === "comparable") {
      assertSources([job.salary.sourceId], snapshot.sources, snapshot.authorization.sourceIds);
      if (!job.sourceIds.includes(job.salary.sourceId)) throw new IntelligenceInputError("salary_source_not_bound_to_job");
    }
  }
  return snapshot;
}
const round = (value: number) => Math.round(value * 10000) / 10000;
function distribution(jobs: readonly Coverage[]): CoverageDistribution {
  const values = jobs.map(job => job.coverage).sort((left, right) => left - right);
  const quantile = (p: number) => {
    const index = (values.length - 1) * p;
    const lower = Math.floor(index), upper = Math.ceil(index);
    return round(values[lower]! + (values[upper]! - values[lower]!) * (index - lower));
  };
  return { min: values[0]!, p25: quantile(.25), median: quantile(.5), p75: quantile(.75), max: values.at(-1)!, mean: round(values.reduce((sum, value) => sum + value, 0) / values.length) };
}
function contributionMatches(actual: string, required: string): boolean {
  return actual !== "unknown" && actual !== "not_mine" && (required === "any" || actual === required || (actual === "implementation" && required === "design"));
}
function factStrength(fact: SimulationFact, snapshot: CareerSimulationSnapshot): number {
  if (fact.support !== "supported" || !fact.confirmedByUser || !fact.sourceIds.length || ["job", "inference"].includes(fact.provenance)) return 0;
  if (fact.contribution === "unknown" || fact.contribution === "not_mine") return 0;
  return fact.provenance === "user_statement" ? snapshot.rules.selfReportedWeight : 1;
}
function cover(snapshot: CareerSimulationSnapshot, plan?: CareerInvestmentPlan, factor = 0): Coverage[] {
  return snapshot.cohort.jobs.map(job => {
    const unknowns: string[] = [], blockers: string[] = [];
    const observedAge = job.verifiedAt ? ageDays(job.verifiedAt, snapshot.cohort.asOf) : undefined;
    const sourcesFresh = job.sourceIds.length > 0 && job.sourceIds.every(id => {
      const source = snapshot.sources.find(item => item.id === id)!;
      const age = ageDays(source.capturedAt, snapshot.cohort.asOf);
      return age !== undefined && age <= snapshot.rules.maxObservationAgeDays;
    });
    if (job.availability !== "active") blockers.push(job.availability === "closed" ? "job_closed" : "job_availability_unknown");
    if (observedAge === undefined || observedAge > snapshot.rules.maxObservationAgeDays || !sourcesFresh) blockers.push("job_observation_missing_or_stale");
    if (!job.requirements.length) { blockers.push("job_requirements_unknown"); unknowns.push("job_requirements_unknown"); }
    const requirementEvidence = job.requirements.map(requirement => {
      if (requirement.knowledge === "unknown") {
        unknowns.push(`requirement:${requirement.id}`);
        if (requirement.hard) blockers.push(`hard_requirement_unknown:${requirement.id}`);
        return { requirementId: requirement.id, strength: 0, factIds: [], hypotheticalIds: [] };
      }
      const matching = snapshot.facts.filter(fact => fact.skillIds.includes(requirement.skillId) && contributionMatches(fact.contribution, requirement.contribution) && factStrength(fact, snapshot) > 0);
      const hypothetical = (plan?.hypotheticalFacts ?? []).filter(fact => fact.skillIds.includes(requirement.skillId) && contributionMatches(fact.contribution, requirement.contribution));
      const strength = Math.max(0, ...matching.map(fact => factStrength(fact, snapshot)), ...(hypothetical.length ? [factor] : []));
      if (requirement.hard && strength < 1) blockers.push(`hard_requirement_unmet:${requirement.id}`);
      return { requirementId: requirement.id, strength, factIds: matching.map(fact => fact.id), hypotheticalIds: hypothetical.map(fact => fact.id) };
    });
    const total = job.requirements.reduce((sum, requirement) => sum + requirement.weight, 0);
    const coverage = total ? round(100 * job.requirements.reduce((sum, requirement, index) => sum + requirement.weight * requirementEvidence[index]!.strength, 0) / total) : 0;
    if (coverage < snapshot.rules.unlockCoverageThreshold) blockers.push("coverage_threshold_unmet");
    return { jobId: job.id, coverage, eligible: blockers.length === 0, blockers, unknowns, requirementEvidence };
  });
}

/** Coverage only; no model text, Fact writes, hiring-probability model or implicit new cohort. */
export async function simulateCareerInvestment(input: unknown, planInput: unknown,
  options: IntelligenceAccessOptions<CareerSimulationSnapshot>): Promise<CareerSimulationReport> {
  const snapshot = await validateCareerSimulationSnapshot(input);
  const plan = CareerInvestmentPlanSchema.parse(planInput);
  assertUniqueIds(plan.hypotheticalFacts.map(fact => fact.id), "duplicate_hypothesis_id");
  assertUniqueIds(plan.sensitivities.map(item => item.id), "duplicate_sensitivity_id");
  if (plan.hypotheticalFacts.some(fact => snapshot.facts.some(actual => actual.id === fact.id))) throw new IntelligenceInputError("hypothesis_overwrites_fact");
  const base = { schemaVersion: 1 as const, snapshotFingerprint: snapshot.fingerprint, planFingerprint: await intelligenceHash(plan),
    cohortId: snapshot.cohort.id, cohortRevision: snapshot.cohort.revision, rulesVersion: snapshot.rules.version,
    cost: plan.cost, limitations: ["Coverage is an evidence-to-requirement signal within this frozen cohort, not an offer probability or candidate-market percentile.",
      "Hypothetical achievements are conditional scenarios and never written into the authoritative Fact Base.",
      "User-confirmed personal statements may contribute only at the explicitly frozen selfReportedWeight; this is self-report, not independent verification.",
      "Salary comparisons use disclosed gross annual base amounts in the same currency; unknown amounts, legality, hours and benefits are not inferred."] };
  if (!await intelligenceIsCurrent(snapshot, options)) return { ...base, status: "stale", baseline: null, scenarios: [], sensitivityBounds: null, unknowns: ["authorization_or_input_changed"] };
  const baseline = cover(snapshot), baselineDistribution = distribution(baseline);
  const unknowns = snapshot.facts.filter(fact => factStrength(fact, snapshot) === 0).map(fact => `ineligible_fact:${fact.id}`);
  const scenarios = plan.sensitivities.map(sensitivity => {
    const jobs = cover(snapshot, plan, sensitivity.realizationFraction * sensitivity.transferability);
    const scenarioDistribution = distribution(jobs), meanCoverageDelta = round(scenarioDistribution.mean - baselineDistribution.mean);
    const conditionalUnlocks = jobs.filter((job, index) => job.eligible && !baseline[index]!.eligible).map(job => job.jobId);
    const salaryUnknownUnlocks: string[] = [], highSalaryConditionalUnlocks: string[] = [];
    for (const id of conditionalUnlocks) {
      const job = snapshot.cohort.jobs.find(item => item.id === id)!;
      if (job.salary.status === "unknown") salaryUnknownUnlocks.push(id);
      else if (snapshot.rules.highSalary && job.salary.currency === snapshot.rules.highSalary.currency && job.salary.min >= snapshot.rules.highSalary.minAnnual) {
        const disclosureAge = ageDays(job.salary.disclosedAt, snapshot.cohort.asOf);
        if (disclosureAge !== undefined && disclosureAge <= snapshot.rules.maxObservationAgeDays) highSalaryConditionalUnlocks.push(id);
        else salaryUnknownUnlocks.push(id);
      }
    }
    return { id: sensitivity.id, hypothetical: true as const, realizationFraction: sensitivity.realizationFraction, transferability: sensitivity.transferability,
      jobs, distribution: scenarioDistribution, meanCoverageDelta, conditionalUnlocks, highSalaryConditionalUnlocks, salaryUnknownUnlocks,
      roi: { coveragePointsPerHour: plan.cost.hours ? round(meanCoverageDelta / plan.cost.hours) : null,
        coveragePointsPerMoneyUnit: plan.cost.money?.amount ? round(meanCoverageDelta / plan.cost.money.amount) : null, moneyCurrency: plan.cost.money?.currency ?? null } };
  });
  if (!await intelligenceIsCurrent(snapshot, options)) return { ...base, status: "stale", baseline: null, scenarios: [], sensitivityBounds: null, unknowns: ["authorization_or_input_changed"] };
  return { ...base, status: "completed", baseline: { jobs: baseline, distribution: baselineDistribution }, scenarios,
    sensitivityBounds: { minMeanCoverageDelta: Math.min(...scenarios.map(item => item.meanCoverageDelta)), maxMeanCoverageDelta: Math.max(...scenarios.map(item => item.meanCoverageDelta)) },
    unknowns: [...unknowns, ...baseline.flatMap(job => job.unknowns.map(value => `${job.jobId}:${value}`))] };
}
