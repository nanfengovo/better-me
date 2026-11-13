import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGold } from "./gold/verify.mjs";
import { digest, piiFindings, jobLinkFindings, sourceSpan } from "./gold/extract.mjs";
import { resumes, jobs } from "./gold/sources.mjs";
import { buildGold } from "./gold/build.mjs";
import { goldModelMaterial } from "./gold/material.mjs";
import { judgeResumeQuality, ResumeQualityRunSchema, validateResumeQualityCase } from "../../packages/core/src/career-intelligence/resume-quality.js";
import { syntheticQualityFixture } from "./fixtures.js";

const directory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
async function readCase(id: string) { return validateResumeQualityCase(JSON.parse(await fs.readFile(path.join(directory, `cases/${id}.case.json`), "utf8"))); }
async function readRun(id: string) { return ResumeQualityRunSchema.parse(JSON.parse(await fs.readFile(path.join(directory, `baselines/${id}.run.json`), "utf8"))); }

test("five distinct licensed real-source pairs have complete derived hashes, source maps, labels and no model requests", async () => {
  const verified = await verifyGold({ datasetDirectory: directory });
  assert.equal(verified.realPairs, 5); assert.equal(verified.evidenceUnits, 337); assert.equal(verified.requirements, 147);
  assert.equal(verified.baselines, 3); assert.equal(verified.modelCalls, 0); assert.equal(verified.fullOriginalVerification, false);
  assert.equal(new Set(resumes.map(s => s.author)).size, 5); assert.equal(new Set(resumes.map(s => s.originalSha256)).size, 5);
  assert.equal(new Set(jobs.map(s => s.originalSha256)).size, 5);
});
test("candidate contact URLs/identity are rejected; official JD links are allowlisted instead of blanket bypassed", () => {
  assert.ok(piiFindings("https://github.com/person user@example.com 132-6262-0332").length >= 3);
  assert.deepEqual(jobLinkFindings("[runbooks](https://gitlab.com/gitlab-com/runbooks)"), []);
  assert.ok(jobLinkFindings("[contact](https://personal.example/contact)").includes("unapproved_jd_url"));
  assert.ok(jobLinkFindings("https://gitlab.com.evil.example/data").includes("unapproved_jd_url"));
  assert.ok(jobLinkFindings("https://secret@gitlab.com/runbooks").includes("unapproved_jd_url"));
  assert.ok(jobLinkFindings("user@example.com").includes("email"));
});
test("model material excludes answer labels, STAR signals, approved paraphrases, authors and identifying source URLs", async () => {
  for (const id of ["gold-sre", "gold-backend", "gold-frontend", "gold-fullstack", "gold-data-engineer"]) {
    const fixture = await readCase(id), groups = JSON.parse(await fs.readFile(path.join(directory, `materials/${id}.groups.json`), "utf8"));
    const material = await goldModelMaterial(fixture, groups);
    const text = JSON.stringify(material);
    for (const key of ["requirements", "support", "anchorGroups", "approvedParaphrases", "star", "provenance", "originals"]) assert.ok(!text.includes(`"${key}"`));
    for (const source of resumes) { assert.ok(!text.includes(source.url)); assert.ok(!text.includes(source.author)); }
    assert.equal(material.candidate.evidence.length, fixture.evidence.length);
    fixture.requirements[0]!.weight += 123;
    fixture.entityLexicon.push("SECRET_EVALUATOR_LABEL");
    assert.deepEqual(await goldModelMaterial(fixture, groups), material, "Independent evaluator labels cannot leak through candidate material.");
    assert.deepEqual(piiFindings(JSON.stringify(material.candidate)), []);
  }
});
test("original spans are UTF-16 half-open and source-line precise even with emoji and CRLF", () => {
  const text = "😀 header\r\nfull original unit\r\nlast";
  const start = text.indexOf("full"), end = text.indexOf("\r\nlast");
  assert.deepEqual(sourceSpan(text, start, end), { start, end, startLine: 2, endLine: 2, sha256: digest("full original unit") });
  assert.throws(() => sourceSpan(text, 10, 5), /invalid_original_span/);
});
test("historical Rails is partial support, mobile latency is not Web performance, and a Jest list is not test-writing evidence", async () => {
  const backend = await readCase("gold-backend"), frontend = await readCase("gold-frontend");
  const rails = backend.requirements.find(r => r.original.quote.startsWith("Significant"))!;
  assert.equal(rails.support, "partial"); assert.deepEqual(rails.evidenceIds, ["work-6-action-1"]);
  assert.match(backend.evidence.find(e => e.id === rails.evidenceIds[0])!.text, /freelance.*Ruby on Rails/);
  const performance = frontend.requirements.find(r => r.original.quote.startsWith("Experience with performance"))!;
  assert.equal(performance.support, "not_evidenced"); assert.deepEqual(performance.evidenceIds, []);
  assert.match(frontend.evidence.find(e => e.id === "project-0-action-0")!.text, /Android.*1400ms to 100ms/);
  assert.equal(frontend.requirements.find(r => r.original.quote.startsWith("Experience with writing automated tests"))!.support, "not_evidenced");
});
test("fictional projects, internships, assistance, team attribution and original ambiguous periods survive extraction", async () => {
  const fullstack = await readCase("gold-fullstack"), sre = await readCase("gold-sre"), data = await readCase("gold-data-engineer");
  assert.match(fullstack.evidence.find(e => e.id === "project-2")!.text, /fictional company/);
  assert.ok(fullstack.requirements.every(r => !r.evidenceIds.includes("project-2")));
  assert.match(sre.evidence.find(e => e.id === "work-0-action-3")!.text, /Assisted in reviewing/);
  assert.match(sre.evidence.find(e => e.id === "work-1-action-1")!.text, /with team members/);
  assert.equal(sre.requirements.find(r => r.original.quote === "Ability to use GitLab")!.support, "supported");
  assert.match(data.evidence.find(e => e.id === "item-19")!.text, /^Data Engineer internship/);
  const groups = JSON.parse(await fs.readFile(path.join(directory, "materials/gold-frontend.groups.json"), "utf8"));
  assert.equal(groups[0].dates, "Until Now / 10,2022 (original fields; chronology unresolved)");
  await assert.rejects(fs.stat(path.join(directory, "baselines/gold-frontend.run.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(directory, "baselines/gold-backend.run.json")), { code: "ENOENT" });
});
test("partial evidence never becomes full JD coverage even when every anchor and citation matches", async () => {
  const { test: fixture, run } = await syntheticQualityFixture();
  fixture.requirements[0]!.support = "partial";
  const normalized = await validateResumeQualityCase(fixture); run.caseSha256 = digest(JSON.stringify(normalized));
  const result = await judgeResumeQuality(normalized, run);
  assert.equal(result.antiHallucination.percent, 100); assert.equal(result.coverage.percent, 0);
  assert.deepEqual(result.coverage.requirements[0]!.partialClaimIds, ["claim-1"]);
  assert.deepEqual(result.coverage.requirements[0]!.claimIds, []);
});
test("contradictory support labels are rejected rather than silently changing the coverage denominator", async () => {
  const { test: fixture } = await syntheticQualityFixture();
  fixture.requirements[0]!.support = "not_evidenced";
  await assert.rejects(validateResumeQualityCase(fixture), /unsupported_requirement_has_evidence/);
  fixture.requirements[0]!.support = "supported"; fixture.requirements[0]!.evidenceIds = [];
  await assert.rejects(validateResumeQualityCase(fixture), /supported_requirement_missing_evidence/);
});
test("changed original bytes fail before any dataset directory is created", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-gold-source-negative-"));
  const sources = path.join(temporary, "sources"), output = path.join(temporary, "dataset"); await fs.mkdir(sources);
  await fs.writeFile(path.join(sources, resumes[0]!.file), "Changed source bytes, never treated as authentic.");
  await assert.rejects(buildGold({ sourceDirectory: sources, outputDirectory: output }), /original_hash_changed:c01/);
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
});
test("extractive real-source baselines preserve full claims, honestly missing STAR results, and zero model usage", async () => {
  for (const id of ["gold-sre", "gold-fullstack", "gold-data-engineer"]) {
    const fixture = await readCase(id), run = await readRun(id), before = JSON.stringify({ fixture, run });
    const judged = await judgeResumeQuality(fixture, run);
    assert.equal(judged.origin.kind, "extractive_baseline"); assert.equal(judged.antiHallucination.percent, 100);
    assert.ok(judged.star.percent !== null && judged.star.percent < 100);
    assert.equal(judged.observed.modelCalls, 0); assert.equal(JSON.stringify({ fixture, run }), before);
  }
});
test("new technology/numbers or dropping an internship qualifier cannot pass using a valid source citation", async () => {
  const fixture = await readCase("gold-data-engineer"), run = await readRun("gold-data-engineer");
  run.factBase.experiences[0]!.claims[0]!.text.zh += " Used Kafka at 100000 requests/second.";
  let judged = await judgeResumeQuality(fixture, run);
  assert.ok(judged.antiHallucination.claims[0]!.unsupportedEntities.includes("Kafka"));
  assert.ok(judged.antiHallucination.claims[0]!.unsupportedNumbers.includes("100000"));
  assert.equal(judged.antiHallucination.claims[0]!.compliant, false);
  const e = fixture.evidence.find(e => e.id === "item-19")!, start = e.text.indexOf("Search");
  run.factBase.experiences[0]!.claims[0]!.text.zh = e.text.slice(start);
  run.citations[0]!.original = { start, end: e.text.length, quote: e.text.slice(start) };
  judged = await judgeResumeQuality(fixture, run);
  assert.equal(judged.antiHallucination.claims[0]!.invalidCitations, 0);
  assert.equal(judged.antiHallucination.claims[0]!.requiresSemanticReview, true);
  assert.equal(judged.antiHallucination.claims[0]!.compliant, false);
});
test("separate MIT/CC-BY/CC-BY-SA notices retain attribution and modification boundaries", async () => {
  const notices = await fs.readFile(path.join(directory, "NOTICES.md"), "utf8");
  for (const source of [...resumes, ...jobs]) { assert.ok(notices.includes(source.author)); assert.ok(notices.includes(source.url)); assert.ok(notices.includes(source.licenseUrl)); }
  for (let i = 1; i <= 4; i++) assert.match(await fs.readFile(path.join(directory, `licenses/C0${i}-MIT.txt`), "utf8"), /Permission is hereby granted/);
  assert.match(notices, /GitLab JD-derived text and adaptations remain CC-BY-SA-4.0/);
  assert.match(notices, /not an application or hiring outcome/);
});
test("unlisted files, tampered material and symlink inputs fail dataset verification", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-gold-negative-"));
  const copy = path.join(temporary, "data"); await fs.cp(directory, copy, { recursive: true });
  const material = path.join(copy, "materials/gold-sre.candidate.txt"), original = await fs.readFile(material);
  await fs.writeFile(material, Buffer.concat([original, Buffer.from(" changed")]));
  await assert.rejects(verifyGold({ datasetDirectory: copy }), /equal|hash|bytes/i);
  await fs.writeFile(material, original);
  await fs.writeFile(path.join(copy, "unlisted.txt"), "not silently accepted");
  await assert.rejects(verifyGold({ datasetDirectory: copy }), /Unlisted/);
  const linkCopy = path.join(temporary, "linked"); await fs.cp(directory, linkCopy, { recursive: true });
  await fs.symlink(material, path.join(linkCopy, "extra-link.txt"));
  await assert.rejects(verifyGold({ datasetDirectory: linkCopy }), /links are rejected/);
});
