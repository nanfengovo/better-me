import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCareerSimulationSnapshot, simulateCareerInvestment, createJobForensicsSnapshot, analyzeJobForensics, type CareerInvestmentPlan } from "@better-me/core/career-intelligence";
import { convertStudioJobObservation, convertStudioJobObservations, StudioJobObservationInputSchema, type StudioJobObservationInput } from "../src/career-studio/job-observations.js";

const asOf = "2026-11-09T00:00:00.000Z", binding = { ownerId: "synthetic-owner", workspaceId: "workspace-1", sessionGeneration: "session-1", factRevision: "fact-rev-1", rulesVersion: "rules-v1" };
const job = (): StudioJobObservationInput => ({ id: "job-1", title: "Synthetic Engineer", company: "Synthetic Company", description: "需要SQLite，评测实现为硬门槛。", sourceUrl: "https://example.invalid/careers/job-1", platform: "company-website",
  capturedAt: asOf, firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: asOf, publishedAt: "2026-01-01T00:00:00.000Z", availability: "active", verifiedAt: asOf,
  companyKey: "company-1", roleKey: "engineer", locationKey: "office-1", skillIds: ["sqlite", "evaluation"], salaryText: "50k×16，合成文本不能据此换算" });
const comparableSalary = { min: 500000, max: 600000, currency: "CNY", period: "annual" as const, tax: "gross" as const, kind: "base" as const, disclosedAt: asOf };
const weightedRequirements = [{ skillId: "sqlite", weight: 1, hard: false, knowledge: "known" as const, contribution: "any" as const },
  { skillId: "evaluation", weight: 3, hard: true, knowledge: "known" as const, contribution: "implementation" as const }];
const plan: CareerInvestmentPlan = { id: "plan-1", description: "假设完成可复现评测", hypotheticalFacts: [{ id: "hypothesis-1", description: "假设新增评测实现", skillIds: ["evaluation"], contribution: "implementation" }], cost: { hours: 20, days: 14 }, sensitivities: [{ id: "conditional", realizationFraction: 1, transferability: 1 }] };
async function simulate(selected: StudioJobObservationInput) {
  const converted = convertStudioJobObservation(selected);
  const snapshot = await createCareerSimulationSnapshot({ binding, authorization: { purpose: "career_simulation", grantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z", sourceIds: [converted.source.id, "fact-source"] },
    sources: [converted.source, { id: "fact-source", hash: "c".repeat(64), capturedAt: asOf }], cohort: { id: "cohort-1", revision: "cohort-v1", asOf, jobs: [converted.simulationJob] },
    facts: [{ id: "fact-1", revision: "fact-v1", text: "本人自述参与SQLite实现", skillIds: ["sqlite"], support: "supported", contribution: "implementation", provenance: "user_statement", confirmedByUser: true, sourceIds: ["fact-source"] }],
    rules: { version: "rules-v1", maxObservationAgeDays: 30, unlockCoverageThreshold: 80, selfReportedWeight: 0.5, highSalary: { currency: "CNY", minAnnual: 400000 } } });
  return simulateCareerInvestment(snapshot, plan, { isCurrent: () => true, now: () => Date.parse(asOf) });
}

test("one shared schema preserves the full original job hash and binds all outputs and disclosed salary to the exact job source", () => {
  const input = { ...job(), requirements: weightedRequirements, comparableSalary, refreshTimes: [asOf], departmentKey: "team-platform", platformJobId: "source-platform-job-7" }, before = structuredClone(input), converted = convertStudioJobObservation(input);
  assert.ok(StudioJobObservationInputSchema.safeParse(input).success); assert.deepEqual(input, before);
  assert.equal(converted.source.id, "job-job-1"); assert.equal(converted.source.url, "https://example.invalid/careers/job-1");
  const independentHash = createHash("sha256").update(JSON.stringify(before)).digest("hex"); assert.equal(converted.source.hash, independentHash);
  assert.equal(converted.simulationJob.revision, independentHash); assert.equal(converted.forensicsObservation.revision, independentHash);
  assert.deepEqual(converted.simulationJob.sourceIds, ["job-job-1"]); assert.equal(converted.forensicsObservation.sourceId, "job-job-1");
  assert.equal(converted.simulationJob.salary.status, "comparable"); if (converted.simulationJob.salary.status === "comparable") { assert.equal(converted.simulationJob.salary.sourceId, "job-job-1"); assert.equal(converted.simulationJob.salary.min, 500000); }
  assert.equal(converted.forensicsObservation.platformJobId, "source-platform-job-7"); assert.equal(converted.forensicsObservation.departmentKey, "team-platform"); assert.deepEqual(converted.forensicsObservation.refreshTimes, [asOf]);
  assert.equal(converted.simulationJob.requirements[1]!.weight, 3); assert.equal(converted.simulationJob.requirements[1]!.hard, true); assert.equal(converted.simulationJob.requirements[1]!.contribution, "implementation");
});

test("salaryText is never parsed, missing observations stay unknown, and explicit empty requirements do not fall back to skills", () => {
  const input = { ...job(), salaryText: "年薪100万，996，每周45h均未核实", availability: "unknown" as const, verifiedAt: null }, converted = convertStudioJobObservation(input);
  assert.equal(converted.simulationJob.salary.status, "unknown"); assert.equal(converted.forensicsObservation.salary.status, "unknown");
  assert.equal(converted.simulationJob.availability, "unknown"); assert.equal(converted.simulationJob.verifiedAt, null); assert.equal(converted.forensicsObservation.departmentKey, null); assert.deepEqual(converted.forensicsObservation.refreshTimes, []);
  assert.deepEqual(converted.simulationJob.requirements.map(requirement => [requirement.weight, requirement.hard, requirement.contribution]), [[1, false, "any"], [1, false, "any"]]);
  assert.match(converted.limitations.join(" "), /完整要求/); assert.match(converted.limitations.join(" "), /未提供，不表示/);
  assert.deepEqual(convertStudioJobObservation({ ...input, requirements: [] }).simulationJob.requirements, []);
  const sourceOnly = convertStudioJobObservation({ ...input, requirements: [{ skillId: "evaluation", weight: 2, hard: true, knowledge: "unknown", contribution: "implementation" }] });
  assert.equal(sourceOnly.simulationJob.requirements.length, 1); assert.equal(sourceOnly.simulationJob.requirements[0]!.knowledge, "unknown");
});

test("actual core simulation uses reviewed weights/hard requirements and only explicit annual salary can conditionally unlock high salary", async () => {
  const selected = { ...job(), requirements: weightedRequirements, comparableSalary }, report = await simulate(selected);
  assert.equal(report.baseline!.distribution.mean, 12.5); assert.equal(report.scenarios[0]!.distribution.mean, 87.5);
  assert.deepEqual(report.scenarios[0]!.conditionalUnlocks, ["job-1"]); assert.deepEqual(report.scenarios[0]!.highSalaryConditionalUnlocks, ["job-1"]); assert.equal(report.scenarios[0]!.roi.coveragePointsPerHour, 3.75);
  const textOnly = await simulate({ ...selected, comparableSalary: undefined, salaryText: "税前年基本工资500000–600000 CNY" });
  assert.deepEqual(textOnly.scenarios[0]!.highSalaryConditionalUnlocks, []); assert.deepEqual(textOnly.scenarios[0]!.salaryUnknownUnlocks, ["job-1"]);
  const unknown = await simulate({ ...selected, requirements: weightedRequirements.map(requirement => requirement.hard ? { ...requirement, knowledge: "unknown" as const } : requirement) });
  assert.equal(unknown.scenarios[0]!.distribution.mean, 12.5); assert.deepEqual(unknown.scenarios[0]!.conditionalUnlocks, []); assert.ok(unknown.scenarios[0]!.jobs[0]!.blockers.some(blocker => blocker.startsWith("hard_requirement_unknown:")));
  const unobserved = await simulate({ ...selected, verifiedAt: null }); assert.deepEqual(unobserved.scenarios[0]!.conditionalUnlocks, []);
});

test("actual core forensics receives real refresh and comparable salary observations without merging originals or judging HR motives", async () => {
  const first = { ...job(), comparableSalary, refreshTimes: ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"], departmentKey: "team-platform", platformJobId: "native-job-1" };
  const second = { ...first, id: "job-2", platform: "other-website", comparableSalary: { ...comparableSalary, min: 800000, max: 1000000 }, platformJobId: "native-job-2" }, originals = structuredClone([first, second]);
  const batch = convertStudioJobObservations([first, second]), snapshot = await createJobForensicsSnapshot({ binding, authorization: { purpose: "job_forensics", grantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z", sourceIds: batch.sources.map(source => source.id) }, asOf,
    sources: batch.sources, observations: batch.forensicsObservations, publicTechnicalObservations: [], rules: { version: "rules-v1", longLivedDays: 90, refreshWindowDays: 30, frequentRefreshCount: 5, wideSalaryRatio: 2.5, maxSourceAgeDays: 30 } });
  const report = await analyzeJobForensics(snapshot, { isCurrent: () => true, now: () => Date.parse(asOf) });
  assert.ok(report.signals.some(signal => signal.code === "frequent_refresh")); assert.ok(report.signals.some(signal => signal.code === "salary_conflict")); assert.equal(report.mergeProposals[0]!.status, "pending_review");
  assert.equal(batch.forensicsObservations.length, 2); assert.equal(batch.sources.length, 2); assert.deepEqual([first, second], originals);
  assert.ok(report.signals.every(signal => signal.uncertainty.length > 0)); assert.doesNotMatch(report.signals.map(signal => signal.summary).join(" "), /HR.*KPI|一定不招|ghost job.*confirmed/i);
});

test("invalid salary units, forged source fields, duplicate requirements, invalid skill IDs and oversized batches fail rather than silently default", () => {
  for (const invalid of [
    { ...job(), comparableSalary: { ...comparableSalary, period: "monthly" } }, { ...job(), comparableSalary: { ...comparableSalary, min: 700000, max: 600000 } },
    { ...job(), comparableSalary: { ...comparableSalary, tax: "net" } }, { ...job(), comparableSalary: { ...comparableSalary, sourceId: "forged-source" } },
    { ...job(), requirements: [weightedRequirements[0], weightedRequirements[0]] }, { ...job(), requirements: [{ ...weightedRequirements[0], skillId: " " }] }, { ...job(), id: "x".repeat(161) },
    { ...job(), requirements: [{ ...weightedRequirements[0], weight: 0 }] }, { ...job(), sourceUrl: "ftp://example.invalid/job" },
  ]) assert.throws(() => convertStudioJobObservation(invalid));
  assert.throws(() => convertStudioJobObservations([job(), job()]), /studio_duplicate_job_observation/);
  assert.throws(() => convertStudioJobObservations(Array.from({ length: 201 }, (_, index) => ({ ...job(), id: `job-${index}` }))), /studio_job_observation_limit/);
});

test("original non-ASCII platform labels and legacy skill spellings remain distinct; missing platform identity is not invented as a real provider", () => {
  const first = convertStudioJobObservation({ ...job(), platform: "合成招聘平台甲" }), repeated = convertStudioJobObservation({ ...job(), platform: "合成招聘平台甲" }), second = convertStudioJobObservation({ ...job(), platform: "合成招聘平台乙" });
  assert.equal(first.forensicsObservation.platform, repeated.forensicsObservation.platform); assert.notEqual(first.forensicsObservation.platform, second.forensicsObservation.platform); assert.equal(first.forensicsObservation.platform, "合成招聘平台甲");
  assert.equal(convertStudioJobObservation({ ...job(), platform: "" }).forensicsObservation.platform, "unknown-platform");
  assert.equal(convertStudioJobObservation({ ...job(), skillIds: ["C++"] }).simulationJob.requirements[0]!.skillId, "C++");
  assert.match(first.limitations.join(" "), /不能证明跨平台同岗/); assert.equal(convertStudioJobObservations([]).sources.length, 0);
});
