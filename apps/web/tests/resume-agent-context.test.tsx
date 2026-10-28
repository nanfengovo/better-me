import assert from "node:assert/strict";
import test from "node:test";
import { projectResume } from "@better-me/core";
import { createInitialDocument } from "@better-me/storage";
import { applyResumeProposal, createCompanionResumeSummary, createResumeAgentContext, findResumeContextSource } from "../src/lib/resume-agent-context";

test("Companion resume summary is opt-in payload-safe and uses only the active projected view", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  document.factBase.profile.displayName = { zh: "机密姓名", en: "Secret Name" };
  document.factBase.profile.email = "private@example.com";
  document.factBase.profile.phone = "+1-555-0100";
  document.factBase.profile.avatarUrl = "data:image/png;base64,private";
  const view = document.resumeViews[0]!;
  view.experienceSelection = "selected";
  view.includedExperienceIds = [document.factBase.experiences[0]!.id];

  const summary = createCompanionResumeSummary(projectResume(document.factBase, view));
  const serialized = JSON.stringify(summary);

  assert.ok(summary);
  assert.ok(summary.headline || summary.skills?.length || summary.recentExperience);
  assert.ok(!serialized.includes("机密姓名"));
  assert.ok(!serialized.includes("Secret Name"));
  assert.ok(!serialized.includes("private@example.com"));
  assert.ok(!serialized.includes("555-0100"));
  assert.ok(!serialized.includes("data:image"));
  assert.ok(!("displayName" in summary));
});

test("resume edit context contains only visible, allow-listed fields and omits contact data", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  document.factBase.profile.email = "private@example.com";
  document.factBase.profile.phone = "+1-555-0100";
  document.factBase.profile.avatarUrl = "data:image/png;base64,private";
  const view = document.resumeViews[0]!;
  const context = createResumeAgentContext(document.factBase, view);
  const serialized = JSON.stringify(context);

  assert.ok(context.experiences.length > 0);
  assert.ok(context.experiences.some((experience) => experience.claims.length > 0));
  assert.ok(!serialized.includes("private@example.com"));
  assert.ok(!serialized.includes("555-0100"));
  assert.ok(!serialized.includes("data:image"));
  assert.ok(!("displayName" in context.profile));
  assert.ok(!("email" in context.profile));
});

test("resume edit context respects the active resume view's excluded experiences", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  const view = document.resumeViews[0]!;
  const excludedId = document.factBase.experiences.at(-1)!.id;
  view.experienceSelection = "selected";
  view.includedExperienceIds = [document.factBase.experiences[0]!.id];
  const context = createResumeAgentContext(document.factBase, view);

  assert.ok(!context.experiences.some((experience) => experience.id === excludedId));
});

test("proposal source lookup only resolves targets included in the consented context", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  const context = createResumeAgentContext(document.factBase, document.resumeViews[0]!);
  const target = context.experiences[0]!.claims[0]!.targetRef;

  assert.equal(findResumeContextSource(context, target), context.experiences[0]!.claims[0]!.text);
  assert.equal(findResumeContextSource(context, { ...target, claimId: "not-shared" }), undefined);
});

test("approved proposal writes only after exact-source CAS and preserves other document data", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  const context = createResumeAgentContext(document.factBase, document.resumeViews[0]!);
  const experience = context.experiences[0]!;
  const claim = experience.claims[0]!;
  const result = applyResumeProposal(document, {
    targetRef: claim.targetRef,
    originalText: claim.text,
    proposedText: `${claim.text}（经用户审阅的表达）`,
  }, "2026-10-27T12:01:00.000Z");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const written = result.document.factBase.experiences.find((item) => item.id === experience.id)!.claims.find((item) => item.id === claim.targetRef.claimId)!;
  assert.equal(written.text[claim.targetRef.locale], `${claim.text}（经用户审阅的表达）`);
  assert.equal(result.document.factBase.profile.email, document.factBase.profile.email);
  assert.equal(result.document.resumeViews[0]!.id, document.resumeViews[0]!.id);

  const changedDocument = structuredClone(document);
  const changedClaim = changedDocument.factBase.experiences.find((item) => item.id === experience.id)!.claims.find((item) => item.id === claim.targetRef.claimId)!;
  changedClaim.text[claim.targetRef.locale] = "另一处已修改的文本";
  const conflict = applyResumeProposal(changedDocument, {
    targetRef: claim.targetRef,
    originalText: claim.text,
    proposedText: "不得覆盖的新建议",
  });
  assert.deepEqual(conflict, { ok: false, reason: "conflict" });
  assert.equal(changedClaim.text[claim.targetRef.locale], "另一处已修改的文本");
});

test("headline proposal applies to its exact locale and conflicting sources fail closed", () => {
  const document = createInitialDocument("2026-10-27T12:00:00.000Z");
  const locale = document.resumeViews[0]!.locale;
  const originalText = document.factBase.profile.headline?.[locale];
  assert.ok(originalText);
  const targetRef = { kind: "profile_headline" as const, locale };
  const result = applyResumeProposal(document, { targetRef, originalText, proposedText: "清晰的个人简介" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.document.factBase.profile.headline?.[locale], "清晰的个人简介");
  assert.deepEqual(applyResumeProposal(document, { targetRef, originalText: "旧内容", proposedText: "不应写入" }), { ok: false, reason: "conflict" });
});
