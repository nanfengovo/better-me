import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectedResume } from "@better-me/core";
import {
  adoptCareerLayoutSelection, applyCareerLayoutCandidate, buildCareerLayoutInput, careerLayoutChanges, careerLayoutPage,
  defaultCareerLayoutCandidates, reviewCareerLayoutSelection, selectedCareerLayoutCandidate,
} from "../src/lib/career-studio-layout";
import { REQUIRED_SEMANTIC_CHECKS, layoutCandidateFingerprint, type LayoutCandidate, type LayoutDiagnosis, type LayoutScope, type MeasuredLayout } from "../src/lib/layout-compiler";

const scope: LayoutScope = { ownerId: "synthetic-layout-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-content" };
const resume: ProjectedResume = { locale: "zh", templateId: "zh-classic", profile: { displayName: "合成候选人", headline: "可靠工程实践", links: [], targetRoles: ["平台工程师"], traits: [] },
  experiences: [{ id: "project", type: "opensource", org: "合成团队", title: "平台实践", start: "2025", end: "2026", techStack: ["SQLite"],
    claims: [{ id: "c1", kind: "responsibility", text: "参与实现 SQLite 并发与回执核对机制，延迟约 10ms。", tags: [] }] }],
  textStyles: { "claim:c1:zh": [{ start: 0, end: 2, bold: true }], "profile:headline:zh": [{ start: 0, end: 2, italic: true }] } };
const input = buildCareerLayoutInput(resume, scope);
const candidate: LayoutCandidate = { id: "candidate", baseScope: scope, replacements: [{ anchor: "profile:headline", before: "可靠工程实践", after: "可靠性工程实践" }], parameters: { bodyFontPt: 11, marginMm: 15 } };
function measurement(proposed: LayoutCandidate, binding = { candidateId: proposed.id, fingerprint: layoutCandidateFingerprint(proposed) }): MeasuredLayout {
  return { status: "measured", scope, source: "dom-estimate", renderBinding: binding, page: careerLayoutPage(resume), pageCount: 1, measuredAt: new Date().toISOString(), limitations: ["synthetic observed-box fixture"], blocks: [
    { id: "c1", anchor: "claim:c1", kind: "claim", order: 0, text: "合成正文", rect: { x: 0, y: 900, width: 100, height: 20 }, lines: [{ text: "合成正文", rect: { x: 0, y: 900, width: 100, height: 20 } }] },
  ] };
}
function verifier(proposed: LayoutCandidate) {
  return { verdict: "equivalent" as const, method: "independent-review" as const, verifierId: "synthetic-reviewer", candidateId: proposed.id, candidateFingerprint: layoutCandidateFingerprint(proposed), scope, checks: REQUIRED_SEMANTIC_CHECKS, detail: "test fixture, not real semantic evidence" };
}
const adapters = { getCurrentScope: () => scope, render: async (proposed: LayoutCandidate, _signal: AbortSignal, binding: { candidateId: string; fingerprint: string }) => measurement(proposed, binding), verifySemantics: async ({ candidate: proposed }: { candidate: LayoutCandidate }) => verifier(proposed) };

test("projection changes only approved text/layout, preserves original data and clears only changed character styling", () => {
  const before = JSON.stringify(resume), projected = applyCareerLayoutCandidate(resume, input, candidate);
  assert.equal(projected.profile.headline, "可靠性工程实践"); assert.equal(projected.layout?.bodyFontSize, 11);
  assert.equal(projected.layout?.pageMargin, 15); assert.equal(projected.textStyles?.["profile:headline:zh"], undefined);
  assert.deepEqual(projected.textStyles?.["claim:c1:zh"], resume.textStyles?.["claim:c1:zh"]);
  assert.equal(projected.experiences[0]?.claims[0]?.text, resume.experiences[0]?.claims[0]?.text);
  assert.equal(JSON.stringify(resume), before);
  assert.equal(careerLayoutPage(projected).marginMm.left, 15);
});

test("all existing Claims have exact anchors and derived project/technical entities are protected", () => {
  const claim = input.texts.find(text => text.anchor === "claim:c1")!;
  assert.equal(claim.protectedSpans?.some(span => span.text === "SQLite"), true);
  const forged: LayoutCandidate = { id: "forged", baseScope: scope, replacements: [{ anchor: claim.anchor, before: claim.text, after: claim.text.replace("SQLite", "Redis") }] };
  assert.throws(() => applyCareerLayoutCandidate(resume, input, forged), /Protected/);
  const duplicate = JSON.parse(JSON.stringify(resume)) as ProjectedResume;
  duplicate.experiences[0]!.claims.push({ ...duplicate.experiences[0]!.claims[0]! });
  assert.throws(() => buildCareerLayoutInput(duplicate, scope), /重复Claim/);
});

test("unsupported gap fields and geometry values cannot become imaginary persisted layout changes", () => {
  assert.throws(() => applyCareerLayoutCandidate(resume, input, { ...candidate, parameters: { bulletGapMm: 1 } }), /没有可持久化/);
  assert.throws(() => applyCareerLayoutCandidate(resume, input, { ...candidate, parameters: { lineHeight: 1.1 } }), /不能低于/);
  assert.throws(() => applyCareerLayoutCandidate(resume, input, { ...candidate, parameters: { sectionGapMm: 0 } }), /不在现有视图/);
  const tiny = { ...resume, layout: { bodyFontSize: 8 } };
  const tinyInput = buildCareerLayoutInput(tiny, scope);
  assert.equal(applyCareerLayoutCandidate(tiny, tinyInput, { id: "unchanged-8", baseScope: scope, replacements: [], parameters: tinyInput.parameters }).layout?.bodyFontSize, 8);
  assert.throws(() => applyCareerLayoutCandidate(resume, input, { ...candidate, parameters: { bodyFontPt: 8 } }));
});

test("checkbox subsets are new candidates; unselected text/layout is never applied", () => {
  const onlyLayout = selectedCareerLayoutCandidate(input, candidate, [], true);
  assert.equal(onlyLayout.replacements.length, 0); assert.equal(careerLayoutChanges(input, onlyLayout).length, 2);
  const onlyText = selectedCareerLayoutCandidate(input, candidate, ["profile:headline"], false);
  assert.equal(onlyText.parameters, undefined); assert.equal(onlyText.replacements.length, 1);
  assert.throws(() => selectedCareerLayoutCandidate(input, candidate, [], false), /至少选择/);
});

test("default layout candidates use observed issue kinds, preserve wording, and obey remaining budgets", () => {
  const report: LayoutDiagnosis = { status: "diagnosed", scope, source: "dom-estimate", pages: [], issues: [{ id: "overflow", kind: "overflow", severity: "error", pageNumber: 1, detail: "synthetic measured overflow", metrics: {} }], penalty: 20, finalFileCheck: "not-performed", limitations: [] };
  const generated = defaultCareerLayoutCandidates(input, { id: "base", baseScope: scope, replacements: [] }, report, input.parameters!, 1, 2);
  assert.equal(generated.length, 2); assert.equal(generated.every(value => value.replacements.length === 0), true);
  assert.ok(generated[0]!.parameters!.lineHeight! < input.parameters!.lineHeight!);
});

test("subset review requires its own semantic verdict and exact candidate-bound real measurement", async () => {
  const reviewed = await reviewCareerLayoutSelection(input, candidate, adapters);
  assert.equal(reviewed.status, "reviewed");
  const selfReview = await reviewCareerLayoutSelection(input, candidate, { ...adapters, verifySemantics: async () => ({ ...verifier(candidate), method: "model-self-review" }) });
  assert.equal(selfReview.status, "rejected");
  const wrong = await reviewCareerLayoutSelection(input, candidate, { ...adapters, render: async () => measurement(candidate, { candidateId: candidate.id, fingerprint: "old" }) });
  assert.equal(wrong.status, "rejected");
});

test("cancellation, hung verifier deadlines and source changes do not expose selected proposals", async () => {
  let current = scope;
  const stale = await reviewCareerLayoutSelection(input, candidate, { ...adapters, getCurrentScope: () => current, verifySemantics: async () => { current = { ...scope, revision: "2" }; return verifier(candidate); } });
  assert.equal(stale.status, "stale");
  const timeout = await reviewCareerLayoutSelection(input, candidate, { ...adapters, verifySemantics: async () => new Promise(() => {}) }, { timeoutMs: 10 });
  assert.equal(timeout.status, "timeout");
  const controller = new AbortController(); controller.abort();
  const cancelled = await reviewCareerLayoutSelection(input, candidate, adapters, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
});

test("adoption needs an exact business receipt and cannot promote an absent semantic check", async () => {
  const reviewed = await reviewCareerLayoutSelection(input, candidate, adapters); assert.equal(reviewed.status, "reviewed"); if (reviewed.status !== "reviewed") return;
  let calls = 0;
  const saved = await adoptCareerLayoutSelection(input, reviewed, async (_candidate, context) => { calls++; return { versionId: "stored-version", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint }; }, { getCurrentScope: () => scope, operationId: "synthetic-op" });
  assert.equal(saved.status, "saved"); assert.equal(calls, 1);
  const unknown = await adoptCareerLayoutSelection(input, reviewed, async () => undefined, { getCurrentScope: () => scope, operationId: "synthetic-op-2" });
  assert.equal(unknown.status, "unknown");
  const unverified = await adoptCareerLayoutSelection(input, { ...reviewed, semanticVerdict: undefined }, async () => { throw new Error("must not dispatch"); }, { getCurrentScope: () => scope, operationId: "synthetic-op-3" });
  assert.equal(unverified.status, "stale");
});

test("late adoption receipts after account switch are not displayed as current success", async () => {
  const reviewed = await reviewCareerLayoutSelection(input, candidate, adapters); if (reviewed.status !== "reviewed") assert.fail("fixture review failed");
  let current = scope;
  const outcome = await adoptCareerLayoutSelection(input, reviewed, async (_candidate, context) => { current = { ...scope, ownerId: "other" }; return { versionId: "old-owner-version", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint }; }, { getCurrentScope: () => current, operationId: "synthetic-op" });
  assert.equal(outcome.status, "stale");
});

test("an exact business CAS receipt can attest its own same-owner/session/document source advance", async () => {
  const reviewed = await reviewCareerLayoutSelection(input, candidate, adapters); if (reviewed.status !== "reviewed") assert.fail("fixture review failed");
  let current = scope;
  const resultScope = { ...scope, revision: "2", contentHash: "saved-projection" };
  const outcome = await adoptCareerLayoutSelection(input, reviewed, async (_candidate, context) => {
    current = resultScope;
    return { versionId: "actual-read-back-version", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint, resultScope };
  }, { getCurrentScope: () => current, operationId: "self-CAS" });
  assert.equal(outcome.status, "saved");
  for (const receipt of [undefined, { versionId: "unbound", baseScope: scope, candidateFingerprint: "wrong", resultScope },
    { versionId: "unattested", baseScope: scope, candidateFingerprint: layoutCandidateFingerprint(candidate) }]) {
    current = scope;
    const stale = await adoptCareerLayoutSelection(input, reviewed, async () => { current = resultScope; return receipt; }, { getCurrentScope: () => current, operationId: "unmatched-CAS" });
    assert.equal(stale.status, "stale");
  }
});
