import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultResumeView, createDemoFactBase, projectResume } from "@better-me/core";
import type { BetterMeDocument } from "@better-me/storage";
import { buildCareerEvidenceStatement, type CareerEvidenceEntry } from "../src/lib/career-studio-evidence";
import { buildCareerLayoutDocument, careerStudioDigest } from "../src/lib/career-studio-adoption";
import { careerLayoutSourceFingerprint } from "../src/lib/career-studio-layout";
import type { LayoutCandidate, LayoutScope } from "../src/lib/layout-compiler";

const asOf = "2026-11-09T00:00:00.000Z";
const selfQuote = "我参与实现本机租约恢复逻辑；只核对了本地评测，尚未上线。";
function entry(): CareerEvidenceEntry {
  return { id: "synthetic-card", subscriptionId: "synthetic-subscription", repositoryId: "e".repeat(64), commit: "a".repeat(40), generation: 1, status: "proposal_created", personalContribution: "unknown",
    title: "模型生成的吸引人标题，不是本人事实", summary: "主导千万级高并发架构，性能提升300%，这是必须忽略的合成夸大摘要。", contributionQuestion: "请确认本人贡献与部署边界。",
    citations: [{ evidenceId: "source-1", path: "src/lease.ts", version: "after", sourceHash: "b".repeat(64), startLine: 4, endLine: 5, quote: "export const leaseRecovery = true;\n// local-only evaluation" }],
    review: { kind: "implementation", action: selfQuote, role: "参与实现，非独立主导", deployment: "仅本地评测，未上线" },
    proposalReceipt: { id: "proposal-receipt-1", proposalId: "pending-proposal-1", status: "pending_business_review" }, limitations: ["源码存在不证明作者或生产规模"], createdAt: asOf, updatedAt: asOf };
}
function documentFixture(): BetterMeDocument {
  const base = createDemoFactBase(asOf), active = createDefaultResumeView(base, asOf), other = { ...createDefaultResumeView(base, asOf), id: "other-resume", name: "另一个合成简历" };
  active.id = "active-resume";
  return { documentId: "synthetic-document", factBase: base, resumeViews: [active, other], activeResumeId: active.id };
}
function layoutFixture(document = documentFixture()) {
  const resume = projectResume(document.factBase, document.resumeViews[0]!), fingerprint = careerLayoutSourceFingerprint(resume);
  const scope: LayoutScope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: document.activeResumeId, revision: fingerprint, contentHash: fingerprint };
  const claim = resume.experiences[0]!.claims[0]!;
  const candidate: LayoutCandidate = { id: "approved-layout-candidate", baseScope: scope, replacements: [{ anchor: `claim:${claim.id}`, before: claim.text, after: `${claim.text}。` }], parameters: { bodyFontPt: 11, marginMm: 15 } };
  return { document, resume, scope, candidate };
}

test("reviewed micro-card adopts only the exact self quote and provenance, never model summary, as a personal statement", async () => {
  const base = createDemoFactBase(asOf), before = structuredClone(base), selected = entry();
  const adopted = await buildCareerEvidenceStatement(base, selected, await careerStudioDigest(selected.review));
  assert.equal(adopted.statementId, "git-fact:synthetic-card");
  const statement = adopted.factBase.personalStatements!.at(-1)!;
  assert.equal(statement.kind, "user_statement"); assert.equal(statement.text, selfQuote); assert.equal(statement.evidence[0]!.excerpt, selfQuote);
  assert.match(statement.evidence[0]!.label ?? "", /本人明确自述；实现/);
  assert.equal(statement.evidence[1]!.excerpt, selected.citations[0]!.quote); assert.equal(statement.evidence[1]!.hash, "b".repeat(64));
  assert.equal(JSON.stringify(statement).includes("300%"), false); assert.equal(JSON.stringify(statement).includes(selected.summary!), false);
  assert.deepEqual(adopted.factBase.experiences, before.experiences); assert.deepEqual(adopted.factBase.profile, before.profile); assert.deepEqual(base, before);
  assert.equal(adopted.statementHash.length, 64);
  const repeated = await buildCareerEvidenceStatement(adopted.factBase, selected, await careerStudioDigest(selected.review));
  assert.equal(repeated.factBase, adopted.factBase); assert.equal(repeated.statementHash, adopted.statementHash);
});

test("unknown, not-mine, incomplete receipts and stale review hashes cannot be promoted; an existing different statement cannot be overwritten", async () => {
  const base = createDemoFactBase(asOf), selected = entry(), expected = await careerStudioDigest(selected.review);
  for (const changed of [
    { ...selected, review: { kind: "unknown", note: "仍未知" } },
    { ...selected, review: { kind: "not-mine", note: "不是本人" } },
    { ...selected, status: "reviewed" }, { ...selected, proposalReceipt: undefined }, { ...selected, citations: [] },
    { ...selected, review: { ...selected.review, action: "改变后的本人原话" } },
  ]) await assert.rejects(buildCareerEvidenceStatement(base, changed, expected));
  const saved = await buildCareerEvidenceStatement(base, selected, expected), changed = entry();
  changed.review = { kind: "design", action: "我只参与设计，未实现。", role: "设计参与者", deployment: "未实现" };
  await assert.rejects(buildCareerEvidenceStatement(saved.factBase, changed, await careerStudioDigest(changed.review)), /已经保存了不同版本/);
  const changedSource = entry(); changedSource.citations[0]!.sourceHash = "f".repeat(64);
  await assert.rejects(buildCareerEvidenceStatement(saved.factBase, changedSource, expected), /已经保存了不同版本/);
});

test("layout document proposal changes only the active resume projection and preserves shared facts, other views and source document", () => {
  const fixture = layoutFixture(), before = structuredClone(fixture.document), proposed = buildCareerLayoutDocument(fixture.document, fixture.resume, fixture.scope, fixture.candidate);
  assert.deepEqual(fixture.document, before); assert.deepEqual(proposed.factBase, before.factBase); assert.deepEqual(proposed.resumeViews[1], before.resumeViews[1]);
  assert.ok(proposed.resumeViews[0]!.isolatedFactBase, "wording changes belong to the active view's private projection");
  const actual = projectResume(proposed.factBase, proposed.resumeViews[0]!);
  assert.equal(actual.experiences[0]!.claims[0]!.text, fixture.candidate.replacements[0]!.after); assert.equal(actual.layout?.bodyFontSize, 11); assert.equal(actual.layout?.pageMargin, 15);
  const other = projectResume(proposed.factBase, proposed.resumeViews[1]!);
  assert.equal(other.experiences[0]!.claims[0]!.text, before.factBase.experiences[0]!.claims[0]!.text.zh);
  assert.equal(proposed.documentId, before.documentId); assert.equal(proposed.activeResumeId, before.activeResumeId);
});

test("stale, mismatched and ambiguous layout proposals fail atomically without altering shared facts", () => {
  const fixture = layoutFixture(), original = JSON.stringify(fixture.document), changed = structuredClone(fixture.document);
  changed.factBase.experiences[0]!.claims[0]!.text.zh += "原稿有新内容。";
  assert.throws(() => buildCareerLayoutDocument(changed, fixture.resume, fixture.scope, fixture.candidate), /原稿已变化/);
  assert.throws(() => buildCareerLayoutDocument(fixture.document, fixture.resume, fixture.scope, { ...fixture.candidate, replacements: [{ ...fixture.candidate.replacements[0]!, before: "另一句旧原文" }] }));
  assert.throws(() => buildCareerLayoutDocument(fixture.document, fixture.resume, { ...fixture.scope, documentId: "other-resume" }, fixture.candidate));
  assert.equal(JSON.stringify(fixture.document), original);
});
