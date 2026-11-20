import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../dist/index.js";
import { DocumentSchema } from "../dist/schema/document.js";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const l = (zh, en) => ({ zh, en });
function scenario() {
  const factBase = {
    schemaVersion: 1, updatedAt: at,
    profile: { displayName: l("合成测试人", "Synthetic"), headline: l("原职业简介", "Original profile"), links: [], traits: [], targetRoles: [] },
    experiences: ["first", "second"].map(id => ({ id, type: "work", org: l("合成单位", "Fixture"), title: l("测试岗位", "Test"),
      start: "2024-01", end: null, techStack: [], claims: [{ id: `c-${id}`, kind: "action", text: l(`原句-${id}`, `Original ${id}`), tags: [] }] })),
  };
  const source = { ...core.createDefaultResumeView(factBase, at), id: "main", name: "我的通用版", locale: "en",
    layout: { bodyFontSize: 10.5 }, textStyles: { "claim:c-first:en": [{ start: 0, end: 5, bold: true }] } };
  return DocumentSchema.parse({ documentId: "fixture-doc", factBase, activeResumeId: source.id, resumeViews: [source, { ...source, id: "other", name: "另一份" }] });
}
async function command(doc, extra = {}) {
  return { taskId: "task-1", sourceResumeId: "main", sourceFingerprint: await core.careerTaskSourceFingerprint(doc, "main"),
    name: "合成岗位专用", job: { id: "job-1", title: "合成目标岗位", company: "合成公司" },
    patches: [{ targetRef: { kind: "claim_text", experienceId: "second", claimId: "c-second", locale: "en" },
      originalText: "Original second", proposedText: "Reviewed second", evidenceIds: ["evidence-1"] }], ...extra };
}

test("approving a job edition changes only the selected experience and language in a new independent resume", async () => {
  const doc = scenario(), before = structuredClone(doc);
  const { document: saved, receipt, reused } = await core.createCareerTaskResume(doc, await command(doc), later);
  assert.equal(reused, false);
  assert.deepEqual(doc, before);
  assert.deepEqual(saved.factBase, before.factBase);
  assert.deepEqual(saved.resumeViews.slice(0, 2), before.resumeViews);
  const edition = saved.resumeViews.find(view => view.id === receipt.resumeId);
  assert.equal(saved.activeResumeId, receipt.resumeId);
  assert.equal(edition.name, "合成岗位专用");
  assert.deepEqual(edition.layout, before.resumeViews[0].layout);
  assert.deepEqual(edition.textStyles, before.resumeViews[0].textStyles);
  const frozen = core.resolveResumeFactBase(saved.factBase, edition);
  assert.deepEqual(frozen.experiences[0], before.factBase.experiences[0]);
  assert.deepEqual(frozen.experiences[1].claims[0].text, l("原句-second", "Reviewed second"));
  assert.equal(core.projectResume(saved.factBase, edition).experiences[1].claims[0].text, "Reviewed second");
  assert.equal(core.projectResume(saved.factBase, saved.resumeViews[0]).experiences[1].claims[0].text, "Original second");
  const recovered = DocumentSchema.parse(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(recovered.resumeViews[2], edition, "durable document schema retains snapshot and approval identity");
});

test("even an in-place source mutation during asynchronous fingerprinting cannot enter an approved edition", async t => {
  const doc = scenario(), approved = await command(doc);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let reads = 0;
  t.mock.method(crypto.subtle, "digest", async (...args) => {
    const result = await digest(...args);
    if (++reads === 2) doc.factBase.experiences[0].claims[0].text.en = "Unreviewed concurrent change";
    return result;
  });
  const saved = await core.createCareerTaskResume(doc, approved, later);
  assert.equal(core.resolveResumeFactBase(saved.document.factBase, saved.document.resumeViews.at(-1)).experiences[0].claims[0].text.en, "Original first");
});

test("retrying an approved save returns its original receipt even after the source has changed; changed approval or payload is refused", async () => {
  const doc = scenario();
  const approved = await command(doc, { approvalHash: "c".repeat(64) });
  const first = await core.createCareerTaskResume(doc, approved, later);
  const reloaded = DocumentSchema.parse(structuredClone(first.document));
  reloaded.factBase.experiences[1].claims[0].text.en = "New independently edited source";
  const repeat = await core.createCareerTaskResume(reloaded, approved, at);
  assert.equal(repeat.document, reloaded);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.editionState, "as_saved");
  assert.deepEqual(repeat.receipt, first.receipt);
  for (const changed of [{ approvalHash: "a".repeat(64) }, { name: "新名字" }, { patches: [{ ...approved.patches[0], evidenceIds: ["different"] }] }]) {
    await assert.rejects(core.createCareerTaskResume(reloaded, { ...approved, ...changed }), { code: "task_conflict" });
  }
});

test("a later manual edition is distinguishable from the initial receipt and is never overwritten, even when the source has been deleted", async () => {
  const doc = scenario(), approved = await command(doc);
  const saved = await core.createCareerTaskResume(doc, approved, later);
  assert.match(saved.receipt.snapshotHash, /^[0-9a-f]{64}$/);
  const withoutSource = { ...saved.document, resumeViews: saved.document.resumeViews.filter(v => v.id !== "main") };
  assert.equal((await core.createCareerTaskResume(withoutSource, approved)).editionState, "as_saved");
  const edited = structuredClone(withoutSource);
  edited.resumeViews.at(-1).isolatedFactBase.experiences[1].claims[0].text.en = "Later manual wording";
  const retry = await core.createCareerTaskResume(edited, approved);
  assert.equal(retry.editionState, "edited_since_save");
  assert.equal(retry.document, edited);
  assert.deepEqual(retry.receipt, saved.receipt);
  assert.equal(retry.document.resumeViews.at(-1).isolatedFactBase.experiences[1].claims[0].text.en, "Later manual wording");
});

test("changing the shared facts never drops selections from a frozen edition; editing the frozen edition does not change other views", async () => {
  const doc = scenario();
  doc.resumeViews[0].experienceSelection = "selected";
  doc.resumeViews[0].includedExperienceIds = ["first", "second"];
  const { document: saved } = await core.createCareerTaskResume(doc, await command(doc), later);
  const edition = saved.resumeViews[2];
  const nextShared = { ...saved.factBase, experiences: saved.factBase.experiences.slice(0, 1) };
  const synced = core.syncResumeViewsWithFactBase(saved.factBase, nextShared, saved.resumeViews, "main");
  assert.deepEqual(synced[2], edition, "removed shared experience must remain in the frozen edition's selection");
  const previous = core.resolveResumeFactBase(nextShared, edition);
  const editedFacts = { ...previous, experiences: previous.experiences.slice(1) };
  const localEdit = core.syncResumeViewsWithFactBase(previous, editedFacts, synced, edition.id, "isolated");
  assert.deepEqual(localEdit.slice(0, 2), synced.slice(0, 2));
  assert.deepEqual(core.projectResume(nextShared, localEdit[2]).experiences.map(e => e.id), ["second"]);
  assert.equal(core.projectResume(nextShared, localEdit[2]).experiences[0].claims[0].text, "Reviewed second");
  assert.deepEqual(core.projectResume(nextShared, localEdit[0]).experiences.map(e => e.id), ["first"]);
});

test("a task edition never copies raw import material or the independent permanent-statements ledger", async () => {
  const doc = scenario(), approved = await command(doc);
  doc.factBase.importSource = { fileName: "synthetic-test.txt", importedAt: later, rawText: "never duplicate the original upload", unparsedLines: [] };
  doc.factBase.personalStatements = [{ id: "synthetic-statement", taskId: "other-task", text: "synthetic-ledger-only marker", kind: "user_statement",
    evidence: [{ id: "answer", hash: "synthetic-hash", excerpt: "synthetic answer", label: "本人补充", kind: "user_statement" }], approvedAt: later }];
  doc.factBase.updatedAt = later;
  assert.equal(DocumentSchema.safeParse(doc).success, true);
  assert.equal(await core.careerTaskSourceFingerprint(doc, "main"), approved.sourceFingerprint);
  const { document } = await core.createCareerTaskResume(doc, approved, later);
  const edition = document.resumeViews[2].isolatedFactBase;
  assert.equal(edition.importSource, undefined);
  assert.deepEqual(edition.personalStatements ?? [], []);
  assert.deepEqual(document.factBase.personalStatements, doc.factBase.personalStatements);
});

test("CAS is bound to exact job source, visible target and effective language; one invalid field rejects the entire batch", async () => {
  const doc = scenario(), approved = await command(doc), before = structuredClone(doc);
  const [change] = approved.patches;
  for (const [other, code] of [
    [{ ...change }, "duplicate_target"],
    [{ targetRef: { kind: "profile_headline", locale: "en" }, originalText: "Earlier profile", proposedText: "Updated profile", evidenceIds: ["ev-h"] }, "target_changed"],
    [{ ...change, targetRef: { ...change.targetRef, locale: "zh" }, originalText: "原句-second" }, "target_outside_view"],
    [{ ...change, targetRef: { ...change.targetRef, experienceId: "first" } }, "target_changed"],
    [{ ...change, evidenceIds: [] }, "invalid_command"],
  ]) {
    await assert.rejects(core.createCareerTaskResume(doc, { ...approved, patches: [change, other] }), { code });
    assert.deepEqual(doc, before);
  }
  const hidden = scenario(); hidden.resumeViews[0].experienceSelection = "selected"; hidden.resumeViews[0].includedExperienceIds = ["first"];
  await assert.rejects(core.createCareerTaskResume(hidden, await command(hidden)), { code: "target_outside_view" });
  const modifiedRole = structuredClone(doc), modifiedLayout = structuredClone(doc);
  modifiedRole.factBase.experiences[0].title.en = "Another role";
  modifiedLayout.resumeViews[0].layout.bodyFontSize = 11;
  for (const modified of [modifiedRole, modifiedLayout]) await assert.rejects(core.createCareerTaskResume(modified, approved), { code: "source_changed" });
  const changedDocument = { ...doc, documentId: "different-owner-document" };
  await assert.rejects(core.createCareerTaskResume(changedDocument, approved), { code: "source_changed" });
});

test("emphasis remains on surviving source words, while replaced text does not inherit earlier factual emphasis", async () => {
  const doc = scenario();
  doc.resumeViews[0].textStyles["claim:c-second:en"] = [{ start: 0, end: 15, bold: true }];
  const { document: saved } = await core.createCareerTaskResume(doc, await command(doc), later);
  assert.deepEqual(saved.resumeViews[2].textStyles["claim:c-second:en"], [{ start: 8, end: 15, bold: true }]);
  assert.deepEqual(saved.resumeViews[0].textStyles["claim:c-second:en"], [{ start: 0, end: 15, bold: true }]);
});

test("a restored task receipt must name its owning view and cannot silently turn a saved job version into a shared view", async () => {
  const doc = scenario(), saved = (await core.createCareerTaskResume(doc, await command(doc), later)).document;
  const missingSnapshot = structuredClone(saved); delete missingSnapshot.resumeViews.at(-1).isolatedFactBase;
  const wrongReceipt = structuredClone(saved); wrongReceipt.resumeViews.at(-1).careerTaskReceipt.resumeId = "some-other-view";
  assert.equal(DocumentSchema.safeParse(missingSnapshot).success, false);
  assert.equal(DocumentSchema.safeParse(wrongReceipt).success, false);
});

function replacementScenario() {
  const doc = scenario(), view = doc.resumeViews[0];
  const [work, project] = doc.factBase.experiences;
  view.experienceSelection = "selected";
  view.includedExperienceIds = [work.id];
  project.type = "other";
  project.projectName = l("合成课程作品", "Fixture coursework");
  project.url = "https://example.invalid/private-project";
  project.techStack = ["Unreviewed tool"];
  work.claims.push({ id: "keep", kind: "action", text: l("保留原句", "Keep this duty"), tags: [] });
  project.claims[0].text.en = "Built a visible checklist";
  project.claims.push({ id: "secret-sibling", kind: "action", text: l("未选的项目细节", "Unreviewed detail"), tags: [] });
  return doc;
}

const replacement = {
  remove: { experienceId: "first", claimId: "c-first", text: "Original first" },
  use: { experienceId: "second", claimId: "c-second", text: "Built a visible checklist" },
  proposedText: "Built a visible checklist",
};

test("a cross-experience replacement exports exactly the selected bullet under its own heading after a durable round trip", async () => {
  const doc = replacementScenario(), original = structuredClone(doc);
  const approved = await command(doc, { patches: [], replacement });
  const saved = await core.createCareerTaskResume(doc, approved, later);
  assert.deepEqual(doc, original);
  const reloaded = DocumentSchema.parse(JSON.parse(JSON.stringify(saved.document)));
  const preview = core.projectResume(reloaded.factBase, reloaded.resumeViews.at(-1));
  assert.deepEqual(preview.experiences.map(exp => [exp.id, exp.claims.map(c => c.id)]), [["first", ["keep"]], ["second", ["c-second"]]]);
  const markdown = core.projectedResumeToMarkdown(preview);
  assert.match(markdown, /Work Experience[\s\S]*Keep this duty[\s\S]*Projects & Works[\s\S]*Fixture coursework[\s\S]*Built a visible checklist/);
  assert.doesNotMatch(markdown, /Original first|Unreviewed|private-project/);
  assert.equal((markdown.match(/Built a visible checklist/g) || []).length, 1);
  assert.deepEqual(core.projectResume(reloaded.factBase, reloaded.resumeViews[0]), core.projectResume(original.factBase, original.resumeViews[0]));
  const retry = await core.createCareerTaskResume(reloaded, approved, later);
  assert.equal(retry.reused, true);
  assert.equal(retry.document, reloaded);
  assert.deepEqual(retry.receipt, saved.receipt);
  await assert.rejects(core.createCareerTaskResume(reloaded, { ...approved, replacement: { ...replacement, proposedText: "Changed again" } }), { code: "task_conflict" });
});

test("a visible same-experience candidate takes the earlier slot only once; an in-place edit uses the effective source language", async () => {
  const doc = replacementScenario(), work = doc.factBase.experiences[0];
  work.claims.splice(1, 0, { id: "middle", kind: "action", text: l("中间", "Middle bullet"), tags: [] });
  const promote = { ...replacement, use: { experienceId: "first", claimId: "keep", text: "Keep this duty" }, proposedText: "Keep this duty" };
  const promoted = await core.createCareerTaskResume(doc, await command(doc, { patches: [], replacement: promote }));
  assert.deepEqual(core.projectResume(promoted.document.factBase, promoted.document.resumeViews.at(-1)).experiences[0].claims.map(c => c.id), ["keep", "middle"]);
  const reverse = { ...promote, remove: promote.use, use: promote.remove, proposedText: promote.remove.text };
  const earlier = await core.createCareerTaskResume(doc, await command(doc, { patches: [], replacement: reverse }));
  assert.deepEqual(core.projectResume(earlier.document.factBase, earlier.document.resumeViews.at(-1)).experiences[0].claims.map(c => c.id), ["c-first", "middle"]);
  delete work.claims[0].text.en;
  const ref = { experienceId: "first", claimId: "c-first", text: "原句-first" };
  const rewrite = { remove: ref, use: ref, proposedText: "用户确认的补充" };
  const revised = await core.createCareerTaskResume(doc, await command(doc, { patches: [], replacement: rewrite }));
  const edition = revised.document.resumeViews.at(-1), actual = edition.isolatedFactBase.experiences[0].claims[0].text;
  assert.deepEqual(actual, { zh: rewrite.proposedText });
  assert.equal(core.projectResume(revised.document.factBase, edition).experiences[0].claims[0].text, rewrite.proposedText);
});

test("replacements reject wrong ownership, stale source, hidden sections, private notes, ambiguous IDs and concurrent selection edits", async () => {
  for (const [setup, code] of [
    [doc => { doc.factBase.experiences[1].claims[0].kind = "interview"; }, "target_outside_view"],
    [doc => { doc.factBase.experiences[1].claims[0].kind = "pitfall"; }, "target_outside_view"],
    [doc => { doc.factBase.experiences[1].claims[0].metric = { value: 8, unit: "%", confirmed: false }; }, "target_outside_view"],
    [doc => { doc.resumeViews[0].sectionVisibility = { projects: false }; }, "target_outside_view"],
    [doc => { doc.resumeViews[0].experienceSelection = "all"; }, "invalid_command"],
    [doc => { doc.factBase.experiences[1].claims[1].id = "c-first"; }, "target_changed"],
    [doc => { doc.factBase.experiences[1].claims[1].id = "keep"; }, "target_changed"],
    [doc => { doc.factBase.experiences[1].claims[0].text.en = "Updated"; }, "target_changed"],
  ]) {
    const doc = replacementScenario();
    setup(doc);
    const approved = await command(doc, { patches: [], replacement });
    await assert.rejects(core.createCareerTaskResume(doc, approved), { code });
    assert.equal(doc.resumeViews.length, 2);
  }
  const doc = replacementScenario(), approved = await command(doc, { patches: [], replacement });
  await assert.rejects(core.createCareerTaskResume(doc, { ...approved, replacement: { ...replacement, use: { ...replacement.use, experienceId: "first" } } }), { code: "target_changed" });
  await assert.rejects(core.createCareerTaskResume(doc, { ...approved, replacement: { remove: replacement.use, use: replacement.remove, proposedText: "Other" } }), { code: "target_outside_view" });
  await assert.rejects(core.createCareerTaskResume(doc, { ...approved, patches: (await command(doc)).patches }), { code: "invalid_command" });
  doc.resumeViews[0].includedExperienceIds = ["second"];
  await assert.rejects(core.createCareerTaskResume(doc, approved), { code: "source_changed" });
});
