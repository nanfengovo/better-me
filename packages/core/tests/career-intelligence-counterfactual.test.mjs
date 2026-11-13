import assert from "node:assert/strict";
import test from "node:test";
import { createCareerSimulationSnapshot, simulateCareerInvestment, validateCareerSimulationSnapshot, CareerInvestmentPlanSchema } from "../src/career-intelligence/counterfactual.ts";
import { intelligenceHash, IntelligenceSalarySchema } from "../src/career-intelligence/snapshots.ts";

const asOf = "2026-11-09T00:00:00.000Z";
const salary = { status: "comparable", min: 200000, max: 300000, currency: "CNY", period: "annual", tax: "gross", kind: "base", sourceId: "source-1", disclosedAt: asOf };
const plan = { id: "evaluation-investment", description: "未来14天补齐授权项目评测证据。", hypotheticalFacts: [
  { id: "hypothesis-evals", description: "假设完成评测并获得待审核的成果。", skillIds: ["evaluation"], contribution: "implementation" },
], cost: { hours: 28, days: 14 }, sensitivities: [
  { id: "half-transfer", realizationFraction: 1, transferability: .5 }, { id: "fully-realized", realizationFraction: 1, transferability: 1 },
] };
async function makeSnapshot(change = () => {}) {
  const requirements = [
    { id: "rust", skillId: "rust", weight: 1, hard: false, knowledge: "known", contribution: "implementation" },
    { id: "eval", skillId: "evaluation", weight: 1, hard: true, knowledge: "known", contribution: "implementation" },
  ];
  const input = { binding: { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "session-1", factRevision: "facts-v1", rulesVersion: "rules-v1" },
    authorization: { grantId: "synthetic-grant", expiresAt: "2099-01-01T00:00:00.000Z", sourceIds: ["source-1"], purpose: "career_simulation" },
    sources: [{ id: "source-1", hash: await intelligenceHash("synthetic-source"), capturedAt: asOf }],
    cohort: { id: "frozen-cohort", revision: "cohort-v1", asOf, jobs: [
      { id: "job-known", revision: "job-v1", sourceIds: ["source-1"], availability: "active", verifiedAt: asOf, requirements: structuredClone(requirements), salary: structuredClone(salary) },
      { id: "job-unknown-salary", revision: "job-v1", sourceIds: ["source-1"], availability: "active", verifiedAt: asOf, requirements: structuredClone(requirements), salary: { status: "unknown", reason: "No comparable salary disclosure." } },
    ] },
    facts: [{ id: "fact-rust", revision: "v1", text: "本人实现Rust服务。", skillIds: ["rust"], support: "supported", contribution: "implementation", provenance: "source", sourceIds: ["source-1"], confirmedByUser: true }],
    rules: { version: "rules-v1", maxObservationAgeDays: 30, unlockCoverageThreshold: 80, selfReportedWeight: .5, highSalary: { currency: "CNY", minAnnual: 180000 } } };
  change(input);
  return createCareerSimulationSnapshot(input);
}
const current = { isCurrent: () => true };

test("same frozen cohort produces baseline, conditional scenarios, explicit sensitivity and cost ROI", async () => {
  const snapshot = await makeSnapshot();
  const before = structuredClone(snapshot);
  const report = await simulateCareerInvestment(snapshot, plan, current);
  assert.equal(report.status, "completed");
  assert.deepEqual(snapshot, before);
  assert.equal(report.baseline.distribution.mean, 50);
  assert.equal(report.scenarios[0].distribution.mean, 75);
  assert.deepEqual(report.scenarios[0].conditionalUnlocks, [], "half-evidence cannot pass a hard requirement");
  assert.equal(report.scenarios[1].distribution.mean, 100);
  assert.deepEqual(report.scenarios[1].conditionalUnlocks, ["job-known", "job-unknown-salary"]);
  assert.deepEqual(report.scenarios[1].highSalaryConditionalUnlocks, ["job-known"]);
  assert.deepEqual(report.scenarios[1].salaryUnknownUnlocks, ["job-unknown-salary"]);
  assert.equal(report.scenarios[1].roi.coveragePointsPerHour, 1.7857);
  assert.deepEqual(report.sensitivityBounds, { minMeanCoverageDelta: 25, maxMeanCoverageDelta: 50 });
  assert.equal(report.cohortRevision, "cohort-v1");
  assert.match(report.limitations.join(" "), /not an offer probability/);
  assert.ok(report.scenarios.every(scenario => scenario.hypothetical === true));
});

test("rewriting prose never creates skill coverage or changes the frozen matching rules", async () => {
  const original = await makeSnapshot();
  const boastful = await makeSnapshot(input => { input.facts[0].text = "主导千万TPS高并发Rust架构与全套评测。"; });
  const one = await simulateCareerInvestment(original, plan, current), two = await simulateCareerInvestment(boastful, { ...plan, description: "Rust 专家评测大师" }, current);
  assert.notEqual(one.snapshotFingerprint, two.snapshotFingerprint);
  assert.deepEqual(one.baseline, two.baseline);
  assert.deepEqual(one.scenarios.map(item => item.distribution), two.scenarios.map(item => item.distribution));
});

test("personal self-report is explicitly weighted, not independently certified or inferred from Git authorship", async () => {
  const self = await makeSnapshot(input => { input.facts[0].provenance = "user_statement"; });
  const report = await simulateCareerInvestment(self, plan, current);
  assert.equal(report.baseline.distribution.mean, 25);
  assert.match(report.limitations.join(" "), /self-report, not independent verification/);
  for (const change of [fact => { fact.confirmedByUser = false; }, fact => { fact.contribution = "unknown"; }, fact => { fact.provenance = "inference"; }, fact => { fact.support = "partial"; }, fact => { fact.contribution = "not_mine"; }]) {
    const excluded = await makeSnapshot(input => change(input.facts[0]));
    const result = await simulateCareerInvestment(excluded, plan, current);
    assert.equal(result.baseline.distribution.mean, 0);
    assert.ok(result.unknowns.includes("ineligible_fact:fact-rust"));
  }
});

test("design evidence cannot satisfy an implementation requirement", async () => {
  const snapshot = await makeSnapshot(input => { input.facts[0].contribution = "design"; });
  const report = await simulateCareerInvestment(snapshot, plan, current);
  assert.equal(report.baseline.distribution.mean, 0);
});

test("unknown hard requirements and unverified/closed/stale jobs never become conditional unlocks", async () => {
  for (const change of [job => { job.requirements[1].knowledge = "unknown"; }, job => { job.availability = "unknown"; }, job => { job.availability = "closed"; }, job => { job.verifiedAt = "2020-01-01T00:00:00.000Z"; }]) {
    const snapshot = await makeSnapshot(input => input.cohort.jobs.forEach(change));
    const report = await simulateCareerInvestment(snapshot, plan, current);
    assert.deepEqual(report.scenarios[1].conditionalUnlocks, []);
    assert.deepEqual(report.scenarios[1].highSalaryConditionalUnlocks, []);
  }
  const missing = await makeSnapshot(input => input.cohort.jobs.forEach(job => { job.availability = "unknown"; job.sourceIds = []; job.verifiedAt = null; job.salary = { status: "unknown", reason: "No source." }; }));
  assert.deepEqual((await simulateCareerInvestment(missing, plan, current)).scenarios[1].conditionalUnlocks, []);
});

test("salary comparison preserves missing/currency/staleness instead of unlocking assumed income", async () => {
  for (const change of [value => { value.status = "unknown"; value.reason = "Unknown."; for (const key of Object.keys(value)) if (!["status", "reason"].includes(key)) delete value[key]; }, value => { value.currency = "USD"; }, value => { value.disclosedAt = "2020-01-01T00:00:00.000Z"; }]) {
    const snapshot = await makeSnapshot(input => change(input.cohort.jobs[0].salary));
    const result = await simulateCareerInvestment(snapshot, plan, current);
    assert.deepEqual(result.scenarios[1].highSalaryConditionalUnlocks, []);
  }
  assert.throws(() => IntelligenceSalarySchema.parse({ ...salary, tax: "unknown" }));
  assert.throws(() => IntelligenceSalarySchema.parse({ ...salary, min: 400000 }));
});

test("unknown investment costs remain null rather than invented ROI", async () => {
  const report = await simulateCareerInvestment(await makeSnapshot(), { ...plan, cost: {} }, current);
  assert.deepEqual(report.scenarios[1].roi, { coveragePointsPerHour: null, coveragePointsPerMoneyUnit: null, moneyCurrency: null });
  assert.throws(() => CareerInvestmentPlanSchema.parse({ ...plan, cost: { hours: -1 } }));
});

test("expired/revoked/session-switched inputs discard scenario results", async () => {
  const snapshot = await makeSnapshot();
  let calls = 0;
  const late = await simulateCareerInvestment(snapshot, plan, { isCurrent: () => ++calls === 1 });
  assert.equal(late.status, "stale");
  assert.equal(late.baseline, null);
  assert.deepEqual(late.scenarios, []);
  const expired = await makeSnapshot(input => { input.authorization.expiresAt = "2000-01-01T00:00:00.000Z"; });
  assert.equal((await simulateCareerInvestment(expired, plan, current)).status, "stale");
});

test("untrusted malformed, duplicate, changed or unauthorized snapshots are rejected", async () => {
  const changed = structuredClone(await makeSnapshot()); changed.cohort.jobs[0].requirements[0].weight = 999;
  await assert.rejects(validateCareerSimulationSnapshot(changed));
  const tampered = structuredClone(await makeSnapshot()); tampered.facts[0].text = "Changed";
  await assert.rejects(validateCareerSimulationSnapshot(tampered), /snapshot_fingerprint_changed/);
  await assert.rejects(makeSnapshot(input => { input.authorization.sourceIds = []; }), /source_not_authorized/);
  await assert.rejects(makeSnapshot(input => { input.rules.version = "other"; }), /rules_version_mismatch/);
  await assert.rejects(makeSnapshot(input => { input.cohort.jobs.push(structuredClone(input.cohort.jobs[0])); }), /duplicate_job_id/);
  await assert.rejects(makeSnapshot(input => { input.cohort.jobs[0].sourceIds = []; }), /active_job_needs_observation/);
  await assert.rejects(simulateCareerInvestment(await makeSnapshot(), { ...plan, hypotheticalFacts: [{ ...plan.hypotheticalFacts[0], id: "fact-rust" }] }, current), /hypothesis_overwrites_fact/);
});
