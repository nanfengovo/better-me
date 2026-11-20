import assert from "node:assert/strict";
import test from "node:test";
import { careerJobSnapshotVersion, careerRequirementCapabilityId, careerTrainingRequirements } from "@better-me/agent-contracts";
import { careerTaskSourceFingerprint, createDefaultResumeView, parseFactBase } from "@better-me/core";
import type { BetterMeDocument, DocumentVersion } from "@better-me/storage";
import { createOpportunity, opportunityDecisionCareerJob } from "../src/lib/opportunities";
import { currentOpportunityResumeMaterial, opportunityDecisionEvidence } from "../src/lib/opportunity-decision-source";
import { evidenceSources, withRequirementEvidence } from "../src/lib/requirement-evidence";

const at = "2026-11-20T00:00:00.000Z";
const facts = parseFactBase({ schemaVersion: 1, updatedAt: at, profile: { displayName: { zh: "合成人员" } },
  experiences: [{ id: "record", type: "work", org: { zh: "合成企业" }, title: { zh: "工程师" }, start: "2020-01", end: null,
    claims: [{ id: "work", kind: "action", text: { zh: "我独立设计数据库，比较两种事务方案并确定隔离策略。" } }] }] });
const view = createDefaultResumeView(facts, at);
const document: BetterMeDocument = { documentId: "synthetic-doc", factBase: facts, resumeViews: [view], activeResumeId: view.id };
const checkpoint: DocumentVersion = { id: "synthetic-adopted-version", createdAt: at, kind: "checkpoint", label: "采用", document };
const opportunity = createOpportunity({ company: "合成机会", title: "工程师", description: "岗位要求：独立设计数据库",
  sourcePlatform: "synthetic-source", sourceJobId: "canonical-job", sourceUrl: "https://example.invalid/job/42", status: "open" }, at);

test("opportunity material uses an official version only after exact readback and existing history", async () => {
  let reads = 0;
  const snapshot = await currentOpportunityResumeMaterial(document, {
    read: async () => { reads++; return structuredClone(document); }, listVersions: async () => [checkpoint], assertCurrent() {},
  });
  assert.equal(reads, 2);
  assert.deepEqual(snapshot.officialVersion, { documentId: document.documentId, versionId: checkpoint.id, contentHash: await careerTaskSourceFingerprint(document, view.id) });
  assert.match(snapshot.markdown, /独立设计数据库/);
  const dirty = structuredClone(document);
  dirty.factBase.profile.displayName.zh = "修改中";
  const draft = await currentOpportunityResumeMaterial(dirty, { read: async () => document, listVersions: async () => [checkpoint], assertCurrent() {} });
  assert.equal(draft.officialVersion, undefined);
  assert.match(draft.markdown, /修改中/);
  assert.equal((await currentOpportunityResumeMaterial(document, { read: async () => document, listVersions: async () => [], assertCurrent() {} })).officialVersion, undefined);
  reads = 0;
  await assert.rejects(currentOpportunityResumeMaterial(document, { read: async () => ++reads === 1 ? document : dirty, listVersions: async () => [checkpoint], assertCurrent() {} }), /核对期间/);
  let current = true;
  await assert.rejects(currentOpportunityResumeMaterial(document, {
    read: async () => { current = false; return document; }, listVersions: async () => [checkpoint],
    assertCurrent() { if (!current) throw new Error("identity changed"); },
  }), /identity changed/);
});

test("opportunity decisions use the exact canonical posting and latest non-withdrawn work and independent retest", () => {
  const job = opportunityDecisionCareerJob(opportunity);
  const item = careerTrainingRequirements(job)[0]!;
  const source = evidenceSources(facts)[0]!;
  const work = withRequirementEvidence(document, facts, {
    job, itemId: item.id, quote: item.originalQuote, experienceId: source.experience.id,
    claimId: source.claim.id, sourceVersion: source.sourceVersion, contribution: "design", assessment: "supports",
  }, at);
  const version = careerJobSnapshotVersion(job);
  const capabilityId = careerRequirementCapabilityId(version, item.id, item.originalQuote);
  const retest = { sourceKind: "independent-retest", jobVersion: version, jobId: job.id, itemId: item.id, quote: item.originalQuote,
    capabilityId, sourceVersion: "3".repeat(64), contribution: "design", assessment: "partial", reviewedAt: at,
    kitId: "00000000-0000-4000-8000-000000000002", kitVersion: "4".repeat(64), questionVersion: "5".repeat(64),
    sourceLabel: "合成复测", changedCondition: "提交状态未知", criterion: "解释重复写入处理", completedAt: at, result: "missed",
  } as const;
  const doc = { ...work, requirementEvidence: [...work.requirementEvidence!, retest] };
  assert.equal(opportunityDecisionEvidence(doc, opportunity).supported, 1);
  assert.deepEqual(opportunityDecisionEvidence(doc, opportunity).independentRetests.map(ref => ref.result), ["missed"]);
  const withdrawn = { ...doc, requirementEvidence: [...doc.requirementEvidence, { ...retest, assessment: "withdrawn" as const }] };
  assert.equal(opportunityDecisionEvidence(withdrawn, opportunity).independentRetests.length, 0);
  assert.equal(opportunityDecisionEvidence(doc, { ...opportunity, sourceJobId: "different-posting" }).supported, 0);
  assert.equal(opportunityDecisionEvidence(doc, { ...opportunity, description: "岗位要求：核对方案" }).independentRetests.length, 0);
});
