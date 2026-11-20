import assert from "node:assert/strict";
import test from "node:test";
import { careerTrainingRequirements } from "@better-me/agent-contracts";
import { createDefaultResumeView, parseFactBase } from "@better-me/core";
import { exportDocumentJson, parseDocumentJson } from "@better-me/storage";
import { evidenceSources, recommendationReviewReader, withRequirementEvidence, type RequirementReviewCommand } from "../src/lib/requirement-evidence";

const at = "2026-11-20T02:00:00Z";
const databaseJob = { id: "synthetic-db", title: "数据工程师", company: "合成企业", description: "岗位要求：独立设计数据库\n负责实施数据库方案" };
function setup() {
  const facts = parseFactBase({ schemaVersion: 1, updatedAt: at, profile: { displayName: { zh: "合成测试" } },
    experiences: [{ id: "inventory", type: "work", org: { zh: "合成组织" }, title: { zh: "工程师" }, start: "2020-01", end: null,
      claims: [{ id: "impl", kind: "action", text: { zh: "本人按既有设计实施 PostgreSQL 库存更新。" } },
        { id: "design", kind: "action", text: { zh: "我独立设计库存数据库，比较两种写入方案并选定事务隔离策略。" } },
        { id: "deny", kind: "action", text: { zh: "我没有使用过 PostgreSQL。" } }] }] });
  const view = createDefaultResumeView(facts);
  const doc = { documentId: "synthetic", activeResumeId: view.id, factBase: facts, resumeViews: [view] };
  const item = careerTrainingRequirements(databaseJob)[0]!;
  const sources = evidenceSources(facts);
  const command = (index: number, assessment: RequirementReviewCommand["assessment"], contribution: RequirementReviewCommand["contribution"]): RequirementReviewCommand => ({
    job: databaseJob, itemId: item.id, quote: item.originalQuote, claimId: sources[index]!.claim.id,
    experienceId: "inventory", sourceVersion: sources[index]!.sourceVersion, assessment, contribution,
  });
  return { doc, facts, sources, command };
}

test("database implementation can be linked as partial, while claiming design requires its own supporting material", () => {
  const { doc, facts, command } = setup();
  assert.throws(() => withRequirementEvidence(doc, facts, command(0, "supports", "implementation"), at));
  assert.throws(() => withRequirementEvidence(doc, facts, command(0, "supports", "design"), at));
  assert.throws(() => withRequirementEvidence(doc, facts, command(2, "partial", "other"), at));
  const partial = withRequirementEvidence(doc, facts, command(0, "partial", "implementation"), at);
  const supported = withRequirementEvidence(partial, facts, command(1, "supports", "design"), at);
  const reopened = parseDocumentJson(exportDocumentJson(supported));
  const read = recommendationReviewReader(reopened.requirementEvidence!, facts);
  assert.deepEqual(read(databaseJob), { supported: 1, partial: 0, total: 2 });
  assert.equal(read({ ...databaseJob, id: "another-job" }), undefined);
  assert.equal(read({ ...databaseJob, description: databaseJob.description + "（职责已变更）" }), undefined);
  assert.equal(withRequirementEvidence(supported, facts, command(1, "supports", "design"), at), supported);
  const withdrawn = withRequirementEvidence(reopened, facts, command(1, "withdrawn", "design"), at);
  assert.deepEqual(recommendationReviewReader(withdrawn.requirementEvidence!, facts)(databaseJob), { supported: 0, partial: 1, total: 2 });
  assert.equal(read(databaseJob)?.supported, 1, "the earlier saved version is still inspectable");
});

test("a changed source cannot be silently reused, and copying one claim does not cover another requirement", () => {
  const { doc, facts, command } = setup();
  const saved = withRequirementEvidence(doc, facts, command(1, "supports", "design"), at);
  const copy = structuredClone(facts.experiences[0]!.claims[1]!);
  facts.experiences[0]!.claims.push({ ...copy, id: "copied" });
  assert.throws(() => withRequirementEvidence(saved, facts, { ...command(1, "supports", "design"), claimId: "copied" }, at), /副本/);
  assert.equal(recommendationReviewReader(saved.requirementEvidence!, facts)(databaseJob)?.supported, 1);
  facts.experiences[0]!.claims[1]!.text.zh = "按图实施数据库";
  assert.throws(() => withRequirementEvidence(saved, facts, command(1, "supports", "design"), at));
  assert.equal(recommendationReviewReader(saved.requirementEvidence!, facts)(databaseJob)?.supported, 0);
});

test("a missed retest or an ungraded independent answer cannot increase a job's evidence coverage", async () => {
  const { careerJobSnapshotVersion } = await import("@better-me/agent-contracts");
  const { requirementEvidenceAdvice } = await import("../src/lib/requirement-evidence");
  const { facts, command } = setup();
  const { itemId, quote } = command(1, "supports", "design");
  const entry = { sourceKind: "independent-retest" as const, jobVersion: careerJobSnapshotVersion(databaseJob), jobId: databaseJob.id, itemId, quote,
    sourceVersion: "a".repeat(64), kitVersion: "b".repeat(64), questionVersion: "c".repeat(64), kitId: "129b07e7-96de-4b1e-849f-b0bc693ed6e4",
    changedCondition: "合同确认时间变动", criterion: "说明调整依据", reviewedAt: at, completedAt: at, contribution: "other" as const,
    assessment: "partial" as const, sourceLabel: "合成复测" };
  for (const result of ["missed", "recorded", "met"] as const) {
    const link = { ...entry, result };
    assert.equal(recommendationReviewReader([link], facts)(databaseJob)?.partial, result === "met" ? 1 : 0);
    assert.equal(requirementEvidenceAdvice([link], []), result === "missed" ? "practice" : result === "recorded" ? "review" : "work");
  }
});

test("a restored résumé checkpoint cannot regain reviewed coverage in the ranking for its indexed job", async t => {
  const { syntheticPersistence } = await import("./fixtures/synthetic-persistence");
  const { recommendationDataset } = await import("./fixtures/resume-recommendations");
  const { extractRecommendationProfile, recommendResumeJobs } = await import("../src/lib/resume-job-recommendations");
  const { facts, doc, command } = setup();
  facts.experiences[0]!.techStack = ["PostgreSQL"];
  const dataset = recommendationDataset([{ id: "indexed", title: "PostgreSQL 数据工程师", description: databaseJob.description }]);
  const profile = extractRecommendationProfile(facts);
  const [job] = (await recommendResumeJobs(dataset, profile)).jobs;
  assert.ok(job);
  const support = { ...command(1, "supports", "design"), job };
  const accepted = withRequirementEvidence(doc, facts, support, at);
  const withdrawn = withRequirementEvidence(accepted, facts, { ...support, assessment: "withdrawn" }, at);
  const { controller } = syntheticPersistence(doc);
  t.after(() => controller.dispose());
  await controller.load();
  async function coverage() {
    const actual = controller.getState().doc!;
    const ranking = await recommendResumeJobs(dataset, profile, { requirementReview: recommendationReviewReader(actual.requirementEvidence ?? [], actual.factBase) });
    return ranking.jobs.find(candidate => candidate.id === job!.id)?.requirementReview?.supported;
  }
  assert.ok(await controller.replace(accepted, "supported", "checkpoint"));
  const version = (await controller.history.list())[0]!;
  assert.equal(await coverage(), 1);
  assert.ok(await controller.replace(withdrawn, "withdrawn", "checkpoint"));
  assert.equal(await coverage(), 0);
  assert.ok(await controller.replace(version.document, "restore A", "restore"));
  assert.equal(await coverage(), 0);
  assert.ok(await controller.replace({ ...doc, documentId: "other-resume" }, "open B", "import"));
  assert.ok(await controller.replace(version.document, "restore A from B", "restore"));
  assert.equal(await coverage(), 0);
  assert.equal(version.document.requirementEvidence!.at(-1)!.assessment, "supports");
});
