import test from "node:test";
import assert from "node:assert/strict";
import { applyDocumentFieldChange, createInitialDocument, getDocumentFieldChanges, type BetterMeDocument, type DocumentFieldChange, type DocumentFieldTarget } from "../src/index.ts";

const NOW = "2026-10-18T12:00:00.000Z";
function fixture() {
  const document = createInitialDocument();
  document.factBase.profile.displayName = { zh: "合成姓名", en: "Synthetic Name" };
  document.factBase.profile.phone = "10000";
  document.factBase.experiences = [{ id: "exp-a", type: "work", org: { zh: "合成团队" }, title: { zh: "工程师" }, start: "2020-01", end: "2023-01", techStack: [], claims: [
    { id: "claim-a", kind: "note", text: { zh: "前缀旧文后缀", en: "Original English" }, tags: [] },
    { id: "claim-b", kind: "note", text: { zh: "另一要点", en: "Other English" }, tags: [] },
  ] }];
  const view = document.resumeViews[0]!;
  document.resumeViews = [view];
  document.activeResumeId = view.id;
  view.name = "合成简历";
  view.includedExperienceIds = [];
  view.includedClaimIds = [];
  view.textStyles = {};
  return document;
}
function change(before: BetterMeDocument, after: BetterMeDocument, target: DocumentFieldTarget): DocumentFieldChange {
  const result = getDocumentFieldChanges(before, after).find((item) => JSON.stringify(item.target) === JSON.stringify(target));
  assert.ok(result, `Missing target ${JSON.stringify(target)}`);
  return result;
}
function restored(document: BetterMeDocument, selected: DocumentFieldChange) {
  const result = applyDocumentFieldChange(document, selected, NOW);
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) throw new Error(result.message);
  return result;
}
const body = { scope: "claim", experienceId: "exp-a", claimId: "claim-a", field: "text", locale: "zh" } as const;
const phone = { scope: "profile", field: "phone" } as const;

test("stable ID restore merges one locale into latest reordered draft and preserves unrelated NaN", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.experiences[0]!.claims[0]!.text.zh = "前缀新文后缀";
  const selected = change(current, historical, body);
  const latest = structuredClone(current);
  latest.factBase.experiences[0]!.claims.reverse();
  latest.factBase.experiences[0]!.claims[1]!.text.en = "Fresh unrelated English";
  latest.factBase.experiences[0]!.claims[0]!.metric = { value: Number.NaN, unit: "", confirmed: false };
  latest.factBase.profile.phone = "latest-phone";
  const untouched = structuredClone(latest), untouchedHistory = structuredClone(historical);
  const result = restored(latest, selected);
  assert.equal(result.document.factBase.experiences[0]!.claims[1]!.text.zh, "前缀新文后缀");
  assert.equal(result.document.factBase.experiences[0]!.claims[1]!.text.en, "Fresh unrelated English");
  assert.equal(result.document.factBase.profile.phone, "latest-phone");
  assert.ok(Number.isNaN(result.document.factBase.experiences[0]!.claims[0]!.metric!.value));
  assert.deepEqual(latest, untouched);
  assert.deepEqual(historical, untouchedHistory);
});

test("changed target rejects stale handle while unrelated current fields can merge", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.profile.phone = "old-phone";
  const selected = change(current, historical, phone);
  current.factBase.profile.phone = "new-phone";
  assert.deepEqual(applyDocumentFieldChange(current, selected), { ok: false, reason: "stale", message: "当前字段或所属结构已在比较后变化，请重新比较，避免覆盖新修改。" });
  assert.equal(current.factBase.profile.phone, "new-phone");
});

test("comparison handles cannot be cloned serialized or forged and snapshots stay immutable", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.profile.phone = "historical";
  const selected = change(current, historical, phone);
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.target));
  assert.ok(Object.isFrozen(selected.restore));
  for (const invalid of [{ ...selected }, structuredClone(selected), JSON.parse(JSON.stringify(selected))]) {
    const result = applyDocumentFieldChange(current, invalid);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.reason, "unsupported"); assert.match(result.message, /重新比较/); }
  }
  historical.factBase.profile.phone = "mutated after comparison";
  assert.equal(restored(current, selected).document.factBase.profile.phone, "historical");
});

test("localized optional fields restore one language without erasing the other", () => {
  const current = fixture(), historical = structuredClone(current);
  current.factBase.profile.headline = { zh: "职位", en: "Title" };
  historical.factBase.profile.headline = { zh: "职位" };
  const target = { scope: "profile", field: "headline", locale: "en" } as const;
  const removed = restored(current, change(current, historical, target)).document;
  assert.deepEqual(removed.factBase.profile.headline, { zh: "职位" });
  const added = restored(removed, change(removed, current, target)).document;
  assert.deepEqual(added.factBase.profile.headline, { zh: "职位", en: "Title" });
  delete current.factBase.profile.headline;
  const blocked = change(current, added, target);
  assert.equal(blocked.restore.available, false);
  assert.match(blocked.restore.reason!, /先恢复.*中文/);
});

test("raw differences remain individually addressable even when display strings match", () => {
  const current = fixture(), historical = structuredClone(current);
  delete current.factBase.profile.phone;
  historical.factBase.profile.phone = "";
  const selected = change(current, historical, phone);
  assert.equal(selected.before, selected.after);
  assert.equal(restored(current, selected).document.factBase.profile.phone, "");
});

test("stable order restore preserves current item content and rejects changed order or membership", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.experiences[0]!.claims.reverse();
  const target = { scope: "order", collection: "claims", experienceId: "exp-a" } as const;
  const selected = change(current, historical, target);
  const latest = structuredClone(current);
  latest.factBase.experiences[0]!.claims[0]!.text.zh = "latest text";
  assert.deepEqual(restored(latest, selected).document.factBase.experiences[0]!.claims.map((item) => item.id), ["claim-b", "claim-a"]);
  assert.equal(restored(latest, selected).document.factBase.experiences[0]!.claims[1]!.text.zh, "latest text");
  latest.factBase.experiences[0]!.claims.reverse();
  assert.equal(applyDocumentFieldChange(latest, selected).ok, false);
  latest.factBase.experiences[0]!.claims.pop();
  assert.equal(applyDocumentFieldChange(latest, selected).ok, false);
});

test("equal-label array order and selection differences still use machine IDs", () => {
  const current = fixture(), historical = structuredClone(current);
  for (const item of current.factBase.experiences[0]!.claims) item.text = { zh: "同名" };
  historical.factBase.experiences[0]!.claims = structuredClone(current.factBase.experiences[0]!.claims).reverse();
  const order = change(current, historical, { scope: "order", collection: "claims", experienceId: "exp-a" });
  assert.equal(order.before, order.after);
  const viewId = current.resumeViews[0]!.id;
  current.resumeViews[0]!.claimSelection = "selected";
  historical.resumeViews[0]!.claimSelection = "selected";
  current.resumeViews[0]!.includedClaimIds = ["claim-a"];
  historical.resumeViews[0]!.includedClaimIds = ["claim-b"];
  const selected = change(current, historical, { scope: "selection", viewId, field: "claims" });
  assert.equal(selected.before, selected.after);
  assert.deepEqual(restored(current, selected).document.resumeViews[0]!.includedClaimIds, ["claim-b"]);
});

test("layout and visibility restore only the selected property", () => {
  const current = fixture(), historical = structuredClone(current), viewId = current.resumeViews[0]!.id;
  historical.resumeViews[0]!.layout = { bodyFontSize: 12, accentColor: "#123456" };
  historical.resumeViews[0]!.sectionVisibility = { education: false };
  const latest = structuredClone(current);
  latest.resumeViews[0]!.layout = { ...current.resumeViews[0]!.layout, accentColor: "#654321" };
  const result = restored(latest, change(current, historical, { scope: "layout", viewId, field: "bodyFontSize" }));
  assert.deepEqual(result.document.resumeViews[0]!.layout, { ...latest.resumeViews[0]!.layout, bodyFontSize: 12 });
  assert.equal(result.document.resumeViews[0]!.sectionVisibility?.education, undefined);
  const hidden = restored(result.document, change(result.document, historical, { scope: "section-visibility", viewId, field: "education" }));
  assert.equal(hidden.document.resumeViews[0]!.sectionVisibility?.education, false);
});

test("format restore requires exact compared text and rejects later text changes", () => {
  const current = fixture(), historical = structuredClone(current), viewId = current.resumeViews[0]!.id;
  const key = "claim:claim-a:zh", target = { scope: "text-style", viewId, key } as const;
  historical.resumeViews[0]!.textStyles = { [key]: [{ start: 0, end: 2, bold: true }] };
  const selected = change(current, historical, target);
  assert.deepEqual(restored(current, selected).document.resumeViews[0]!.textStyles?.[key], [{ start: 0, end: 2, bold: true }]);
  current.factBase.experiences[0]!.claims[0]!.text.zh = "正文已改变";
  assert.equal(applyDocumentFieldChange(current, selected).ok, false);
  assert.equal(change(current, historical, target).restore.available, false);
});

test("text restore rebases only corresponding surviving styles and clears metric confirmation", () => {
  const current = fixture(), historical = structuredClone(current);
  current.factBase.experiences[0]!.claims[0]!.metric = { value: 20, unit: "%", confirmed: true };
  current.resumeViews[0]!.textStyles = {
    "claim:claim-a:zh": [{ start: 0, end: 2, bold: true }, { start: 2, end: 4, italic: true }, { start: 4, end: 6, underline: true }],
    "claim:claim-b:zh": [{ start: 0, end: 2, bold: true }],
  };
  historical.factBase.experiences[0]!.claims[0]!.text.zh = "前缀新的长文后缀";
  const result = restored(current, change(current, historical, body));
  assert.deepEqual(result.document.resumeViews[0]!.textStyles?.["claim:claim-a:zh"], [{ start: 0, end: 2, bold: true }, { start: 5, end: 6, italic: true }, { start: 6, end: 8, underline: true }]);
  assert.deepEqual(result.document.resumeViews[0]!.textStyles?.["claim:claim-b:zh"], [{ start: 0, end: 2, bold: true }]);
  assert.equal(result.document.factBase.experiences[0]!.claims[0]!.metric!.confirmed, false);
  assert.ok(result.adjustments.some((item) => item.includes("待核实")));
  assert.ok(result.adjustments.some((item) => item.includes("格式")));
});

test("verified historical metric requires matching text at comparison and apply time", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.experiences[0]!.claims[0]!.metric = { value: 1, unit: "%", confirmed: true };
  const target = { scope: "claim", experienceId: "exp-a", claimId: "claim-a", field: "metric" } as const;
  const selected = change(current, historical, target);
  assert.equal(restored(current, selected).document.factBase.experiences[0]!.claims[0]!.metric!.confirmed, true);
  current.factBase.experiences[0]!.claims[0]!.text.en = "edited";
  assert.equal(applyDocumentFieldChange(current, selected).ok, false);
  assert.equal(change(current, historical, target).restore.available, false);
});

test("claim deletion removes only related selection IDs and styles while keeping selected-empty hidden", () => {
  const current = fixture(), historical = structuredClone(current), view = current.resumeViews[0]!;
  view.includedClaimIds = ["claim-a"];
  delete view.claimSelection;
  view.textStyles = { "claim:claim-a:zh": [{ start: 0, end: 2, bold: true }], "claim:claim-b:zh": [{ start: 0, end: 2, italic: true }] };
  historical.factBase.experiences[0]!.claims.shift();
  const result = restored(current, change(current, historical, { scope: "claim-item", experienceId: "exp-a", claimId: "claim-a" }));
  assert.deepEqual(result.document.resumeViews[0]!.includedClaimIds, []);
  assert.equal(result.document.resumeViews[0]!.claimSelection, "selected");
  assert.equal(result.document.resumeViews[0]!.textStyles?.["claim:claim-a:zh"], undefined);
  assert.ok(result.document.resumeViews[0]!.textStyles?.["claim:claim-b:zh"]);
  assert.ok(result.adjustments.length >= 2);
});

test("unrelated scalar restore preserves preexisting dangling references exactly", () => {
  const current = fixture(), historical = structuredClone(current);
  current.resumeViews[0]!.includedExperienceIds = ["preexisting-missing-experience"];
  current.resumeViews[0]!.includedClaimIds = ["preexisting-missing-claim"];
  current.resumeViews[0]!.textStyles = { "claim:preexisting-missing-claim:zh": [{ start: 0, end: 2, bold: true }] };
  historical.factBase.profile.phone = "old-phone";
  const result = restored(current, change(current, historical, phone));
  assert.deepEqual(result.document.resumeViews, current.resumeViews);
  assert.deepEqual(result.adjustments, []);
});

test("experience deletion clears its own dependencies without removing preexisting invalid IDs", () => {
  const current = fixture(), historical = structuredClone(current);
  current.resumeViews[0]!.includedExperienceIds = ["exp-a", "already-missing"];
  current.resumeViews[0]!.includedClaimIds = ["claim-a", "already-missing"];
  historical.factBase.experiences = [];
  const result = restored(current, change(current, historical, { scope: "experience-item", experienceId: "exp-a" }));
  assert.deepEqual(result.document.resumeViews[0]!.includedExperienceIds, ["already-missing"]);
  assert.deepEqual(result.document.resumeViews[0]!.includedClaimIds, ["already-missing"]);
});

test("claim additions insert relative to stable IDs and require the existing parent", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.experiences[0]!.claims.splice(1, 0, { id: "claim-added", kind: "note", text: { zh: "历史新增" }, tags: [] });
  current.resumeViews[0]!.claimSelection = "selected";
  current.resumeViews[0]!.includedClaimIds = ["claim-a"];
  const target = { scope: "claim-item", experienceId: "exp-a", claimId: "claim-added" } as const;
  const result = restored(current, change(current, historical, target));
  assert.deepEqual(result.document.factBase.experiences[0]!.claims.map((item) => item.id), ["claim-a", "claim-added", "claim-b"]);
  assert.deepEqual(result.document.resumeViews[0]!.includedClaimIds, ["claim-a"]);
  current.factBase.experiences = [];
  assert.equal(change(current, historical, target).restore.available, false);
});

test("view additions reject absent references and later style source changes", () => {
  const current = fixture(), historical = structuredClone(current);
  const added = structuredClone(historical.resumeViews[0]!);
  added.id = "historical-view";
  added.textStyles = { "profile:displayName:zh": [{ start: 0, end: 2, bold: true }] };
  historical.resumeViews.push(added);
  const target = { scope: "view-item", viewId: added.id } as const;
  const selected = change(current, historical, target);
  assert.equal(restored(current, selected).document.resumeViews.length, 2);
  current.factBase.profile.displayName.zh = "later edit";
  assert.equal(applyDocumentFieldChange(current, selected).ok, false);
  added.includedExperienceIds = ["missing"];
  assert.equal(change(current, historical, target).restore.available, false);
});

test("active view deletion switches minimally and the last view cannot be deleted", () => {
  const current = fixture(), historical = structuredClone(current), firstId = current.resumeViews[0]!.id;
  const second = structuredClone(current.resumeViews[0]!);
  second.id = "second-view";
  current.resumeViews.push(second);
  historical.resumeViews = [structuredClone(second)];
  historical.activeResumeId = second.id;
  const result = restored(current, change(current, historical, { scope: "view-item", viewId: firstId }));
  assert.equal(result.document.activeResumeId, second.id);
  assert.ok(result.adjustments.some((item) => item.includes("切换")));
  const empty = structuredClone(result.document);
  empty.resumeViews = [];
  assert.equal(change(result.document, empty, { scope: "view-item", viewId: second.id }).restore.available, false);
});

test("import source group restore recovers required fields without changing resume content", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.importSource = { fileName: "synthetic.txt", importedAt: NOW, rawText: "合成导入证据", unparsedLines: ["合成待补录"] };
  const group = change(current, historical, { scope: "source-item" });
  const child = change(current, historical, { scope: "source", field: "rawText" });
  assert.equal(child.restore.available, false);
  assert.match(child.restore.reason!, /整组/);
  const result = restored(current, group);
  assert.deepEqual(result.document.factBase.importSource, historical.factBase.importSource);
  assert.deepEqual(result.document.factBase.experiences, current.factBase.experiences);
  assert.deepEqual(result.document.resumeViews, current.resumeViews);
  const removed = restored(result.document, change(result.document, current, { scope: "source-item" }));
  assert.equal(removed.document.factBase.importSource, undefined);
});

test("duplicate experience claim and view IDs disable comparison and reject later ambiguity", () => {
  for (const kind of ["experience", "claim", "view"] as const) {
    const current = fixture(), historical = structuredClone(current);
    historical.factBase.profile.phone = "historical";
    const selected = change(current, historical, phone);
    if (kind === "experience") current.factBase.experiences.push(structuredClone(current.factBase.experiences[0]!));
    if (kind === "claim") current.factBase.experiences[0]!.claims.push(structuredClone(current.factBase.experiences[0]!.claims[0]!));
    if (kind === "view") current.resumeViews.push(structuredClone(current.resumeViews[0]!));
    assert.equal(applyDocumentFieldChange(current, selected).ok, false);
    assert.equal(change(current, historical, phone).restore.available, false);
  }
});

test("single date restore refuses reverse chronology at comparison and after other date edits", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.factBase.experiences[0]!.start = "2024-01";
  historical.factBase.experiences[0]!.end = "2025-01";
  const target = { scope: "experience", experienceId: "exp-a", field: "start" } as const;
  const blocked = change(current, historical, target);
  assert.equal(blocked.restore.available, false);
  assert.match(blocked.restore.reason!, /另一日期/);
  current.factBase.experiences[0]!.end = "2025-01";
  const selected = change(current, historical, target);
  current.factBase.experiences[0]!.end = "2022-01";
  const result = applyDocumentFieldChange(current, selected);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid");
  assert.equal(current.factBase.experiences[0]!.start, "2020-01");
});

test("opaque stable IDs tolerate punctuation without parsing labels or array positions", () => {
  const current = fixture(), historical = structuredClone(current);
  current.factBase.experiences[0]!.id = "exp: odd / id";
  historical.factBase.experiences[0]!.id = "exp: odd / id";
  current.factBase.experiences[0]!.claims[0]!.id = "__proto__:odd:claim";
  historical.factBase.experiences[0]!.claims[0]!.id = "__proto__:odd:claim";
  historical.factBase.experiences[0]!.claims[0]!.text.en = "Restored English";
  const target = { scope: "claim", experienceId: "exp: odd / id", claimId: "__proto__:odd:claim", field: "text", locale: "en" } as const;
  const selected = change(current, historical, target);
  assert.equal(restored(current, selected).document.factBase.experiences[0]!.claims[0]!.text.en, "Restored English");
  assert.ok(!JSON.stringify(selected).includes("__proto__"));
});
