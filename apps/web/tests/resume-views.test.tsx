import assert from "node:assert/strict";
import test from "node:test";
import { createInitialDocument } from "@better-me/storage";
import { careerTaskSourceFingerprint, createCareerTaskResume } from "@better-me/core";
import { addResumeView, duplicateResumeView, removeResumeView, resumeNamesByOpportunity } from "../src/lib/resume-views";

test("multiple views keep one factual source and distinct stable identities", () => {
  const original = createInitialDocument();
  const next = addResumeView(addResumeView(original));
  assert.equal(next.resumeViews.length, 3);
  assert.equal(new Set(next.resumeViews.map((view) => view.id)).size, 3);
  assert.equal(next.factBase, original.factBase);
  assert.equal(original.resumeViews.length, 1);
});

test("a manual duplicate of a task edition retains independent facts but cannot claim the original approval receipt", async () => {
  const doc = createInitialDocument("2026-01-01T00:00:00.000Z");
  const sourceId = doc.activeResumeId;
  const { document, receipt } = await createCareerTaskResume(doc, { taskId: "copy-test", sourceResumeId: sourceId,
    sourceFingerprint: await careerTaskSourceFingerprint(doc, sourceId), name: "合成专用版", job: { title: "虚构测试岗位" },
    patches: [{ targetRef: { kind: "profile_headline", locale: "zh" }, originalText: doc.factBase.profile.headline!.zh,
      proposedText: "虚构岗位版简介", evidenceIds: ["synthetic-source"] }] });
  const next = duplicateResumeView(document, receipt.resumeId);
  const copy = next.resumeViews.at(-1)!;
  assert.equal(copy.careerTaskReceipt, undefined);
  assert.deepEqual(copy.isolatedFactBase, document.resumeViews.at(-1)?.isolatedFactBase);
  assert.notEqual(copy.isolatedFactBase, document.resumeViews.at(-1)?.isolatedFactBase);
  assert.equal(next.resumeViews.filter(v => v.careerTaskReceipt?.taskId === "copy-test").length, 1);
});

test("a job-specific copy preserves deliberate exclusions and isolates nested presentation edits", () => {
  const document = createInitialDocument();
  const view = document.resumeViews[0]!;
  view.sectionVisibility = { education: false };
  view.experienceSelection = "selected";
  view.includedExperienceIds = [];
  view.layout = { accentColor: "#123456" };
  const next = duplicateResumeView(document, view.id, { name: "Example · Backend", targetJdId: "job-1" });
  const copy = next.resumeViews.at(-1)!;
  assert.equal(copy.id, next.activeResumeId);
  assert.notEqual(copy.id, view.id);
  assert.equal(copy.targetJdId, "job-1");
  assert.deepEqual(copy.includedExperienceIds, []);
  assert.equal(copy.sectionVisibility?.education, false);
  copy.layout!.accentColor = "#654321";
  assert.equal(view.layout.accentColor, "#123456");
  assert.equal(next.factBase, document.factBase);
});

test("removing a view preserves facts, chooses a surviving view and protects the final one", () => {
  const original = createInitialDocument();
  assert.throws(() => removeResumeView(original, original.activeResumeId), /至少/);
  const two = addResumeView(original);
  const one = removeResumeView(two, two.activeResumeId);
  assert.equal(one.activeResumeId, original.activeResumeId);
  assert.equal(one.factBase, original.factBase);
  assert.equal(one.resumeViews.length, 1);
  assert.throws(() => duplicateResumeView(one, "missing"), /找不到/);
});

test("imported job identifiers cannot collide with object prototype names", () => {
  const original = createInitialDocument();
  const first = duplicateResumeView(original, original.activeResumeId, { name: "Prototype job", targetJdId: "__proto__" });
  const next = duplicateResumeView(first, first.activeResumeId, { name: "Constructor job", targetJdId: "constructor" });
  const names = resumeNamesByOpportunity(next);
  assert.deepEqual(names["__proto__"], ["Prototype job"]);
  assert.deepEqual(names["constructor"], ["Constructor job"]);
  assert.equal(names["toString"], undefined);
});
