import assert from "node:assert/strict";
import test from "node:test";
import { judgeResumeQuality, qualityHash, validateResumeQualityCase } from "../../packages/core/src/career-intelligence/resume-quality.js";
import { syntheticQualityFixture } from "./fixtures.js";

test("weighted coverage needs exact source, independent eligible evidence and all anchors; a real gap remains uncovered", async () => {
  const { test: fixture, run } = await syntheticQualityFixture(), before = JSON.stringify({ fixture, run });
  const result = await judgeResumeQuality(fixture, run);
  assert.equal(result.coverage.percent, 66.67); assert.equal(result.antiHallucination.percent, 100); assert.equal(result.star.percent, 100);
  assert.deepEqual(result.coverage.requirements[1]!.claimIds, []);
  assert.equal(JSON.stringify({ fixture, run }), before, "evaluation does not edit candidate facts or benchmark labels");
});
test("a JD keyword alone and a citation with the wrong source hash never earn coverage or factual credit", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  run.citations[0]!.sourceSha256 = "0".repeat(64);
  const result = await judgeResumeQuality(fixture, run);
  assert.equal(result.coverage.percent, 0); assert.equal(result.antiHallucination.percent, 0); assert.equal(result.star.percent, 0);
  assert.equal(result.antiHallucination.claims[0]!.invalidCitations, 1);
});
test("uncited new names and numbers are reported whole, not upgraded from JD requirements", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  run.factBase.experiences[0]!.claims[0]!.text.en = "Implemented Redis and Kafka and Kubernetes for 10000 requests, reducing latency 99%.";
  const result = await judgeResumeQuality(fixture, run), claim = result.antiHallucination.claims[0]!;
  assert.ok(claim.unsupportedNumbers.includes("10000")); assert.ok(claim.unsupportedNumbers.includes("99%"));
  assert.ok(claim.unsupportedEntities.includes("Kafka")); assert.ok(claim.unsupportedEntities.includes("Kubernetes"));
  assert.equal(claim.compliant, false); assert.equal(result.coverage.percent, 0);
});
test("unknown paraphrases need review; only an independently frozen, correctly cited approval can pass", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  run.factBase.experiences[0]!.claims[0]!.text.en = "Implemented Redis caching.";
  let result = await judgeResumeQuality(fixture, run);
  assert.equal(result.antiHallucination.percent, 0); assert.equal(result.antiHallucination.claims[0]!.requiresSemanticReview, true);
  fixture.approvedParaphrases.push({ text: "Implemented Redis caching.", evidenceIds: ["source-1"], reviewer: "independent-fixture-label" });
  run.caseSha256 = await qualityHash(JSON.stringify(fixture));
  result = await judgeResumeQuality(fixture, run);
  assert.equal(result.antiHallucination.percent, 100);
});
test("an exact substring that deletes a negation is not awarded factual credit", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  const source = "Did not implement Redis caching in production.";
  fixture.evidence[0]!.text = source; fixture.evidence[0]!.sha256 = await qualityHash(source);
  fixture.evidence[0]!.star = { situation: [], task: [], action: [], result: [] };
  run.caseSha256 = await qualityHash(JSON.stringify(fixture));
  run.factBase.experiences[0]!.claims[0]!.text.en = source.slice(8);
  run.citations[0] = { claimId: "claim-1", evidenceId: "source-1", sourceSha256: fixture.evidence[0]!.sha256,
    original: { start: 8, end: source.length, quote: source.slice(8) } };
  const result = await judgeResumeQuality(fixture, run);
  assert.equal(result.antiHallucination.claims[0]!.invalidCitations, 0, "a valid coordinate alone does not establish entailment");
  assert.equal(result.antiHallucination.claims[0]!.requiresSemanticReview, true);
  assert.equal(result.antiHallucination.percent, 0); assert.equal(result.coverage.percent, 0);
});
test("changed job/source bytes, invalid UTF-16 spans, duplicate IDs and candidate bindings fail closed", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  const broken = structuredClone(fixture); broken.job.text += " "; await assert.rejects(validateResumeQualityCase(broken), /job_hash_changed/);
  const badSpan = structuredClone(fixture); badSpan.requirements[0]!.original.start = 1; await assert.rejects(validateResumeQualityCase(badSpan), /span_changed/);
  const duplicate = structuredClone(fixture); duplicate.evidence.push(duplicate.evidence[0]!); await assert.rejects(validateResumeQualityCase(duplicate), /duplicate_evidence/);
  const badSource = structuredClone(fixture); badSource.evidence[0]!.text += " "; await assert.rejects(validateResumeQualityCase(badSource), /evidence_hash_changed/);
  run.caseSha256 = "0".repeat(64); await assert.rejects(judgeResumeQuality(fixture, run), /binding_changed/);
});
test("technology boundaries do not mistake Mongo for Go; empty selected claims are unknown, not a perfect factual score", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  fixture.requirements[0]!.anchorGroups = [["Go"]]; run.caseSha256 = await qualityHash(JSON.stringify(fixture));
  run.factBase.experiences[0]!.claims[0]!.text.en = "Mongo";
  let result = await judgeResumeQuality(fixture, run); assert.equal(result.coverage.percent, 0);
  run.view.claimSelection = "selected"; run.view.includedClaimIds = []; run.citations = [];
  result = await judgeResumeQuality(fixture, run);
  assert.equal(result.antiHallucination.percent, null); assert.equal(result.star.percent, null);
});
