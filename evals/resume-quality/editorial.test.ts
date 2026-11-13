import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadGoldCase, prepareBenchmarkMaterial } from "./freeze.mjs";
import { reviewEditorialCompleteness, reviewSourceChronology } from "./editorial.mjs";
import { judgeResumeQuality, qualityHash, type ResumeQualityRun } from "../../packages/core/src/career-intelligence/resume-quality.js";
import { syntheticQualityFixture } from "./fixtures.js";

test("observed fullstack extractive pass still exposes omitted project groups and an unavailable supported-JD denominator", async () => {
  const gold = await loadGoldCase(fileURLToPath(new URL("./gold/v1/", import.meta.url)), "gold-fullstack");
  const { material } = await prepareBenchmarkMaterial(gold.test, gold.groups, gold.mapping, "resume-quality-task-candidate-v4");
  const observedIds = ["freelance-action-4", "freelance-action-14", "freelance-action-16", "freelance-action-13", "freelance-action-5"];
  const units = observedIds.map(id => material.candidate.evidence.find(e => e.id === id)!);
  assert.equal(units.length, 5, "exact source units selected by the observed v4 candidate");
  const { run: base } = await syntheticQualityFixture();
  const { factBase: _, ...metadata } = base;
  const run: ResumeQualityRun = { ...metadata, caseId: gold.test.id, caseSha256: await qualityHash(JSON.stringify(gold.test)),
    origin: { kind: "extractive_baseline", label: "Replay of observed v4 selection, not new model output" },
    sourceCandidate: { displayName: "Deidentified replay", groups: [{ ...material.candidate.groups.find(g => g.id === "freelance")!,
      claims: units.map((e, i) => ({ id: `bullet-${i}`, text: e.text })) }] },
    citations: units.map((e, i) => ({ claimId: `bullet-${i}`, evidenceId: e.id, sourceSha256: e.sha256, original: { start: 0, end: e.text.length, quote: e.text } })) };
  const judged = await judgeResumeQuality(gold.test, run);
  assert.equal(judged.antiHallucination.percent, 100);
  assert.equal(judged.coverage.percent, 0);
  const before = JSON.stringify({ gold, run, material });
  const review = await reviewEditorialCompleteness(gold.test, run, material);
  assert.equal(review.status, "requires_review");
  assert.equal(review.overallQualityPassed, null, "no lexical/format combination certifies overall resume quality");
  assert.equal(review.sourceGroups.omitted.length, 5);
  assert.equal(review.supportedRequirements.percent, null, "this Gold pair has partial/gap labels only; do not pretend the generator could achieve full support");
  assert.ok(review.findings.some(f => f.code === "source_groups_not_selected"));
  assert.ok(review.findings.some(f => f.code === "no_fully_supported_requirements"));
  assert.equal(JSON.stringify({ gold, run, material }), before);
});

test("reverse-chronology screen catches the observed 2018-2021 before 2023-2024 inversion without inventing date precision", () => {
  const original = [
    { id: "work-0", kind: "employment", originalPeriod: "Since 2024" },
    { id: "work-3", kind: "employment", originalPeriod: "2018 - 2021" },
    { id: "work-1", kind: "employment", originalPeriod: "2023 - 2024" },
    { id: "ambiguous", kind: "employment", originalPeriod: "Until Now / 10,2022 (original fields; chronology unresolved)" },
    { id: "portfolio", kind: "portfolio", originalPeriod: "Not stated" },
  ];
  const before = JSON.stringify(original), review = reviewSourceChronology(original);
  assert.deepEqual(review.inversions.map(i => [i.beforeGroupId, i.afterGroupId]), [["work-3", "work-1"]]);
  assert.deepEqual(review.unassessedGroupIds, ["ambiguous"]);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(reviewSourceChronology([{ id: "same-year-1", kind: "employment", originalPeriod: "2020 - 2024" },
    { id: "same-year-2", kind: "employment", originalPeriod: "2023 - 2024" }]).inversions, [], "equal end-year precision cannot prove which role ended later");
});

test("inventory cannot invent recent dates, approve paraphrases, or demand invented STAR results", async () => {
  const { test: fixture, run, text } = await syntheticQualityFixture();
  const group = { id: "work-1", title: "Engineer", organization: "SyntheticOrg", originalPeriod: "Not stated", kind: "employment" };
  const material = { caseId: fixture.id, candidate: { groups: [group], evidence: [{ ...fixture.evidence[0], groupId: group.id }] } };
  const { factBase: _, ...metadata } = run;
  const candidate: ResumeQualityRun = { ...metadata, sourceCandidate: { displayName: "Synthetic", groups: [{ ...group, claims: [{ id: "claim-1", text }] }] } };
  let result = await reviewEditorialCompleteness(fixture, candidate, material);
  assert.equal(result.sourceGroups.selected[0].originalPeriod, "Not stated");
  assert.equal(result.overallQualityPassed, null);
  fixture.evidence[0].star.result = []; candidate.caseSha256 = await qualityHash(JSON.stringify(fixture));
  result = await reviewEditorialCompleteness(fixture, candidate, material);
  assert.equal(result.star.resultsMissingInSource[0], "claim-1");
  candidate.sourceCandidate.groups[0].claims[0].text = "Implemented Redis caching.";
  result = await reviewEditorialCompleteness(fixture, candidate, material);
  assert.deepEqual(result.facts.semanticReviewClaimIds, ["claim-1"]);
  assert.equal(result.overallQualityPassed, null);
  const changed = structuredClone(material); changed.candidate.evidence[0].text += " changed";
  await assert.rejects(reviewEditorialCompleteness(fixture, candidate, changed));
});

test("observed research wording cannot be relocated into an internship using a valid but unrelated handle", async () => {
  const gold = await loadGoldCase(fileURLToPath(new URL("./gold/v1/", import.meta.url)), "gold-data-engineer");
  const { material } = await prepareBenchmarkMaterial(gold.test, gold.groups, gold.mapping);
  const group = material.candidate.groups.find(g => g.id === "internship-data")!;
  const unrelated = material.candidate.evidence.find(e => e.id === "item-19")!;
  const observed = [
    "Separated the faint cosmological EoR signal along the frequency dimension using a Convolutional Denoising Autoencoder (CDAE).",
    "Classified the radio galaxies in the FIRST survey according to morphologies using a Convolutional Neutral Network (CNN).",
    "Developed a suite of utilities to semi-automate the X-ray astronomical data analysis.",
  ];
  const { factBase: _, ...metadata } = (await syntheticQualityFixture()).run;
  const run: ResumeQualityRun = { ...metadata, caseId: gold.test.id, caseSha256: await qualityHash(JSON.stringify(gold.test)),
    origin: { kind: "extractive_baseline", label: "Observed v5 wrong-handle replay, not a new model run" },
    sourceCandidate: { displayName: "Deidentified replay", groups: [{ ...group, claims: observed.map((text, i) => ({ id: `observed-research-${i}`, text })) }] },
    citations: observed.map((_, i) => ({ claimId: `observed-research-${i}`, evidenceId: unrelated.id, sourceSha256: unrelated.sha256,
      original: { start: 0, end: unrelated.text.length, quote: unrelated.text } })) };
  const result = await reviewEditorialCompleteness(gold.test, run, material);
  assert.equal((await judgeResumeQuality(gold.test, run)).antiHallucination.claims[0].invalidCitations, 0);
  assert.equal(result.sourceRelocationFindings[0].renderedGroupId, "internship-data");
  assert.equal(result.sourceRelocationFindings.length, 3);
  assert.ok(result.sourceRelocationFindings[0].possibleSources.some(s => s.evidenceId === "item-14" && s.groupId === "research-achievements" && s.kind === "academic"));
  assert.ok(result.findings.some(f => f.code === "possible_source_relocation"));
  assert.equal(result.overallQualityPassed, null);
});
