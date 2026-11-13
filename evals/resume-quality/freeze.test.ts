import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentTaskKernel } from "../../apps/agent-host/src/kernel/service.js";
import { FREEZE_PROTOCOL, freezeTaskCandidate, loadGoldCase, prepareBenchmarkMaterial, prepareBenchmarkRequest, verifyFrozenCandidate } from "./freeze.mjs";
import { judgeResumeQuality } from "../../packages/core/src/career-intelligence/resume-quality.js";
import { modelsAreComparable, runResumeQualityReport } from "./report.mjs";
import { digest } from "./gold/extract.mjs";

const datasetDirectory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
const ownerId = "synthetic-quality-export-owner", access = { session: "synthetic-export", valid: async () => true };
const runtimeBinding = { id: "native:synthetic-eval-fixture", label: "Scripted kernel fixture, not a model", location: "unknown" as const };
const metadata = { execution: "scripted_fixture", provider: "fixture", id: "scripted-evidence-preservation", revision: "fixture-v1", runtimeId: runtimeBinding.id };
const budget = { maxModelCalls: 3, maxToolCalls: 3, maxActiveMs: 60_000 };
test("comparison requires two actual models with validated freezes and identical full input hashes", () => {
  const entry = { model: { provider: "fixture", id: "model-a", revision: "v1" }, origin: "kernel_task", execution: "scripted_fixture", validatedFreeze: true, realCases: 5, comparisonSignature: "same-inputs-and-ceilings" };
  assert.equal(modelsAreComparable([entry, entry], 5), false);
  const model = { ...entry, execution: "model" };
  const second = { ...model, model: { ...model.model, id: "model-b" } };
  assert.equal(modelsAreComparable([model, second], 5), true);
  assert.equal(modelsAreComparable([model, model], 5), false, "different runtime IDs alone do not make two models");
  assert.equal(modelsAreComparable([model, { ...second, comparisonSignature: "different-material-hash" }], 5), false);
  assert.equal(modelsAreComparable([model, { ...second, validatedFreeze: false }], 5), false);
  assert.equal(modelsAreComparable([model, { ...second, realCases: 4 }], 5), false);
  const local = { ...model, model: { provider: "ollama", id: "alias-a", revision: "manifest-a" } };
  const alias = { ...model, model: { provider: "ollama", id: "alias-b", revision: "manifest-b" } };
  assert.equal(modelsAreComparable([local, alias], 5), false, "frozen-only runs cannot distinguish local weight blobs; use full campaign comparison");
});
async function fixture(caseId = "gold-backend", invalidFirst = true, protocol = "resume-quality-task-candidate-v2") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-freeze-")), recordDirectory = path.join(root, "owner-records");
  const kernel = new AgentTaskKernel({ ownerId, directory: recordDirectory });
  const { test: source, groups, mapping } = await loadGoldCase(datasetDirectory, caseId);
  const material = await prepareBenchmarkMaterial(source, groups, mapping, protocol);
  const group = material.material.candidate.groups.find(g => material.material.candidate.evidence.some(e => e.groupId === g.id && !e.kind.endsWith("list")))!;
  const evidence = material.material.candidate.evidence.filter(e => e.groupId === group.id && !e.kind.endsWith("list")).slice(0, 2);
  const candidate = { schemaVersion: 1, caseId, groups: [{ groupId: group.id, bullets: evidence.map((e, i) => ({ id: `bullet-${i}`, text: e.text,
    citations: [{ evidenceId: e.id, sourceSha256: e.sha256, original: { start: 0, end: e.text.length, quote: e.text } }] })) }],
    questions: ["Please confirm the original date precision; do not fill a month."] };
  const request = await prepareBenchmarkRequest(source, groups, mapping, { workspaceKey: `synthetic-eval-${caseId}`, rootScopeKey: `synthetic-eval-${caseId}`,
    runtimeBinding, budget, idempotencyKey: `synthetic-${caseId}-export` }, protocol);
  let task = await kernel.createTask(request, access), calls = 0;
  const wire = ["resume-quality-task-candidate-v4", "resume-quality-task-candidate-v5", "resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(protocol) ? { schemaVersion: 2, caseId,
    bullets: candidate.groups.flatMap(g => g.bullets.map(b => ({ id: b.id, text: b.text, evidenceIds: b.citations.map(c => c.evidenceId) }))), questions: candidate.questions } : candidate;
  const raw = " \r\n" + JSON.stringify(["resume-quality-task-candidate-v3", "resume-quality-task-candidate-v4", "resume-quality-task-candidate-v5", "resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(protocol) ? wire : { kind: "reply", content: JSON.stringify(candidate), actions: [] }) + "\r\n  ";
  await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true },
    { runtimeFingerprint: "synthetic-eval-generation", reasoner: async () => ++calls === 1 && invalidFirst ? "FULL INVALID REPAIR OUTPUT\r\n" : { text: raw, finishReason: "stop" } }, access);
  for (let i = 0; i < 400; i++) { task = await kernel.readTask(task.id); if (task.status !== "running") break; await delay(5); }
  assert.equal(task.status, "awaiting_answer", task.error);
  const options = { datasetDirectory, caseId, recordDirectory, taskId: task.id, ownerId, metadata, outputDirectory: path.join(root, "frozen") };
  return { root, kernel, task, source, material, candidate, raw, calls, options };
}

test("v2 makes the selected target/output objective explicit while v1 archives still reconstruct unchanged", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-backend", false, "resume-quality-task-candidate-v1");
  try {
    const frozen = await freezeTaskCandidate(f.options);
    assert.equal(frozen.run.protocolVersion, "resume-quality-task-candidate-v1");
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    const source = await loadGoldCase(datasetDirectory, "gold-backend");
    const request = await prepareBenchmarkRequest(source.test, source.groups, source.mapping, { workspaceKey: "v2-objective-probe", runtimeBinding, budget, idempotencyKey: "v2-objective-probe" }, "resume-quality-task-candidate-v2");
    assert.match(request.objective, /target is already selected/); assert.match(request.objective, /groupId \(not id\)/);
    assert.equal(JSON.parse(request.conversation.messages[0].content).protocolVersion, "resume-quality-task-candidate-v2");
    assert.notEqual(digest(request.conversation.messages[0].content), frozen.run.origin.inputMaterialSha256);
  } finally { await f.kernel.close(); }
});

test("v3 freezes direct candidate wire without rewriting whitespace and refuses a changed response contract", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-backend", true, "resume-quality-task-candidate-v3");
  try {
    assert.equal(f.task.responseContract, "resume_candidate_v1"); assert.equal(f.task.reply.content, f.raw);
    const frozen = await freezeTaskCandidate(f.options);
    assert.equal(frozen.run.protocolVersion, "resume-quality-task-candidate-v3");
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    assert.equal(await fs.readFile(path.join(f.options.outputDirectory, `${frozen.stem}.reply.txt`), "utf8"), f.raw);
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    delete record.task.responseContract; await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate({ ...f.options, outputDirectory: path.join(f.root, "changed-contract") }), /task_prompt_or_reply_changed/);
  } finally { await f.kernel.close(); }
});

test("v4 freezes source-bound handles with exact whole-unit spans, preserving raw wire and independent semantic rejection", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-backend", true, "resume-quality-task-candidate-v4");
  try {
    assert.equal(FREEZE_PROTOCOL, "resume-quality-task-candidate-v7");
    assert.equal(f.task.responseContract, "resume_candidate_v2");
    assert.deepEqual(f.task.candidateSource, { messageId: "benchmark-source", sha256: digest(f.task.conversation.messages[0].content) });
    const frozen = await freezeTaskCandidate(f.options);
    assert.equal(frozen.run.protocolVersion, "resume-quality-task-candidate-v4"); assert.equal(f.task.reply.content, f.raw);
    assert.deepEqual(frozen.run.citations, f.candidate.groups.flatMap(g => g.bullets.flatMap(b => b.citations.map(c => ({ claimId: b.id, ...c })))));
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const wire = JSON.parse(f.raw); wire.bullets[0].text += " Kafka 100000";
    record.task.reply.content = JSON.stringify(wire); record.task.conversation.messages[1] = record.task.reply; record.recent.at(-1).output = record.task.reply.content;
    await fs.writeFile(file, JSON.stringify(record));
    const invented = await freezeTaskCandidate({ ...f.options, outputDirectory: path.join(f.root, "unsupported-wording") });
    const judged = await judgeResumeQuality(f.source, invented.run);
    assert.ok(judged.antiHallucination.percent! < 100, "valid handles are not semantic certification");
    record.task.candidateSource.sha256 = "0".repeat(64); await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate({ ...f.options, outputDirectory: path.join(f.root, "changed-binding") }));
  } finally { await f.kernel.close(); }
});

test("v5 source-bound editorial candidate preserves full raw and reconstructs with its historical protocol", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-backend", false, "resume-quality-task-candidate-v5");
  try {
    assert.equal(f.task.responseContract, "resume_candidate_v3");
    const frozen = await freezeTaskCandidate(f.options);
    assert.equal(frozen.run.protocolVersion, "resume-quality-task-candidate-v5");
    assert.equal(f.task.reply.content, f.raw);
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    const old = await prepareBenchmarkMaterial(f.source, (await loadGoldCase(datasetDirectory, "gold-backend")).groups,
      (await loadGoldCase(datasetDirectory, "gold-backend")).mapping, "resume-quality-task-candidate-v4");
    assert.notEqual(digest(JSON.stringify(old)), frozen.run.origin.inputMaterialSha256);
    assert.equal(JSON.stringify(old.material), JSON.stringify(f.material.material), "full source and JD are unchanged; no scoring labels added");
  } finally { await f.kernel.close(); }
});

test("v6 freezes a guarded candidate but rejects a forged accepted record with the observed research-to-internship attribution", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-data-engineer", false, "resume-quality-task-candidate-v6");
  try {
    assert.equal(f.task.responseContract, "resume_candidate_v4");
    const frozen = await freezeTaskCandidate(f.options);
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const originalSource = record.task.conversation.messages[0].content;
    const wire = { schemaVersion: 2, caseId: f.source.id, bullets: [{ id: "observed-research",
      text: "Developed a suite of utilities to semi-automate the X-ray astronomical data analysis.", evidenceIds: ["item-19"] }], questions: [] };
    const raw = " \r\n" + JSON.stringify(wire) + " \r\n";
    record.task.reply.content = raw; record.task.conversation.messages[1] = record.task.reply; record.recent.at(-1).output = raw;
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate({ ...f.options, outputDirectory: path.join(f.root, "forged-attribution") }), /candidate_source_attribution_conflict/);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).task.conversation.messages[0].content, originalSource);
    assert.equal(await fs.readFile(path.join(f.options.outputDirectory, `${frozen.stem}.reply.txt`), "utf8"), f.raw);
  } finally { await f.kernel.close(); }
});

test("v7 refuses to freeze forged accepted portfolio-only output that omits explicit ongoing employment", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-frontend", false, FREEZE_PROTOCOL);
  try {
    assert.equal(f.task.responseContract, "resume_candidate_v5");
    const frozen = await freezeTaskCandidate(f.options);
    await verifyFrozenCandidate(frozen.run, frozen.stem, f.options.outputDirectory, f.source);
    const measuredDirectory = path.join(f.root, "current-work-quality");
    const measuredCases = path.join(f.root, "current-work-cases"); await fs.mkdir(measuredCases);
    await fs.writeFile(path.join(measuredCases, `${f.source.id}.case.json`), JSON.stringify(f.source));
    await runResumeQualityReport({ casesDirectory: measuredCases, runsDirectory: f.options.outputDirectory, outputDirectory: measuredDirectory });
    const measured = JSON.parse(await fs.readFile(path.join(measuredDirectory, `${frozen.stem}.metrics.json`), "utf8"));
    assert.deepEqual(measured.currentWorkCoverage.requiredGroups.map((g: { id: string }) => g.id), ["work-0"]);
    assert.deepEqual(measured.currentWorkCoverage.missingCurrentGroups, []);
    assert.equal(measured.currentWorkCoverage.overallQualityPassed, null);
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const project = f.material.material.candidate.evidence.find(e => e.id === "project-0-action-0");
    const wire = { schemaVersion: 2, caseId: f.source.id, bullets: [{ id: "project-only", text: project.text, evidenceIds: [project.id] }], questions: [] };
    const changedRaw = " \r\n" + JSON.stringify(wire) + " \r\n";
    record.task.reply.content = changedRaw; record.task.conversation.messages[1] = record.task.reply; record.recent.at(-1).output = changedRaw;
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate({ ...f.options, outputDirectory: path.join(f.root, "forged-current-role") }), /candidate_current_work_omitted/);
    assert.equal(await fs.readFile(path.join(f.options.outputDirectory, `${frozen.stem}.reply.txt`), "utf8"), f.raw);
  } finally { await f.kernel.close(); }
});

test("actual kernel reply freezes whole wire/repairs/root charges and reconstructs a year-only source projection", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const recordFile = path.join(f.options.recordDirectory, `${f.task.id}.json`), before = await fs.readFile(recordFile);
    const exported = await freezeTaskCandidate(f.options);
    assert.equal(exported.run.origin.execution, "scripted_fixture"); assert.equal(exported.run.observed.modelCalls, 2);
    assert.equal(exported.modelRequests, 0); assert.equal(f.calls, 2);
    assert.equal(await fs.readFile(path.join(f.options.outputDirectory, `${exported.stem}.output.txt`), "utf8"), f.raw);
    assert.deepEqual(await fs.readFile(path.join(f.options.outputDirectory, `${exported.stem}.records/${f.task.id}.json`)), before);
    assert.deepEqual(await fs.readFile(recordFile), before, "export cannot mutate the Host store");
    assert.match(before.toString(), /FULL INVALID REPAIR OUTPUT/);
    const result = await judgeResumeQuality(f.source, exported.run);
    assert.equal(result.antiHallucination.percent, 100);
    assert.equal(result.resume.experiences[0]!.start, "Since 2024"); assert.equal(result.resume.experiences[0]!.end, "");
    assert.ok(!("factBase" in exported.run), "no fake January or FactBase migration");
    await verifyFrozenCandidate(exported.run, exported.stem, f.options.outputDirectory, f.source);
    await assert.rejects(freezeTaskCandidate(f.options), /EEXIST/);
    const changed = structuredClone(exported.run); changed.sourceCandidate.groups[0].claims[0].text += " Kafka 100000";
    await assert.rejects(verifyFrozenCandidate(changed, exported.stem, f.options.outputDirectory, f.source), /projection_changed/);
  } finally { await f.kernel.close(); }
});

test("observed JD-as-experience failure cannot gain fact or JD coverage credit from a valid source-bound handle", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-frontend", false, "resume-quality-task-candidate-v4");
  try {
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const wire = { schemaVersion: 2, caseId: "gold-frontend", bullets: [{ id: "observed-jd-leak",
      text: "Developed features and improvements to the GitLab product by crafting code that meets internal standards for style, maintainability, and best practices for a high-scale web environment.",
      evidenceIds: ["work-0"] }], questions: [] };
    const source = f.material.material.candidate.evidence.find(e => e.id === "work-0")!;
    assert.match(source.text, /Senior Android Developer/); assert.doesNotMatch(source.text, /GitLab/);
    record.task.reply.content = JSON.stringify(wire); record.task.conversation.messages[1] = record.task.reply; record.recent.at(-1).output = record.task.reply.content;
    await fs.writeFile(file, JSON.stringify(record));
    const frozen = await freezeTaskCandidate(f.options), judged = await judgeResumeQuality(f.source, frozen.run);
    assert.equal(judged.antiHallucination.claims[0].validCitations, 1);
    assert.equal(judged.antiHallucination.claims[0].requiresSemanticReview, true);
    assert.equal(judged.antiHallucination.claims[0].compliant, false);
    assert.equal(judged.antiHallucination.percent, 0); assert.equal(judged.coverage.percent, 0);
    assert.equal(frozen.run.sourceCandidate.groups[0].claims[0].text, wire.bullets[0].text, "retain, do not repair the model wording");
  } finally { await f.kernel.close(); }
});

test("fixture tasks on all five real Gold sources export and print without invented timelines or a real-model ranking", { timeout: 60_000 }, async () => {
  const outputs = [];
  for (const caseId of ["gold-sre", "gold-backend", "gold-frontend", "gold-fullstack", "gold-data-engineer"]) {
    const f = await fixture(caseId, false);
    try { outputs.push({ f, exported: await freezeTaskCandidate(f.options) }); } finally { await f.kernel.close(); }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-five-frozen-")), runs = path.join(root, "runs"); await fs.mkdir(runs);
  for (const { f } of outputs) await fs.cp(f.options.outputDirectory, runs, { recursive: true, errorOnExist: true });
  const summary = await runResumeQualityReport({ casesDirectory: path.join(datasetDirectory, "cases"), runsDirectory: runs, outputDirectory: path.join(root, "report") });
  assert.equal(summary.realCases, 5); assert.equal(summary.comparable, false);
  assert.equal(summary.models[0]!.execution, "scripted_fixture"); assert.equal(summary.models[0]!.realCases, 5); assert.equal(summary.models[0]!.a4PassRate, 100);
  const { exported } = outputs.find(o => o.f.options.caseId === "gold-frontend")!;
  const metrics = JSON.parse(await fs.readFile(path.join(root, "report", `${exported.stem}.metrics.json`), "utf8"));
  assert.equal(metrics.resume.experiences[0].start, "Until Now / 10,2022 (original fields; chronology unresolved)");
  assert.match(metrics.layout.pages[0].text, /chronology unresolved/); assert.doesNotMatch(metrics.layout.pages[0].text, /Present/);
  assert.equal(metrics.layout.missingClaims.length, 0);
  const fullstack = outputs.find(o => o.f.options.caseId === "gold-fullstack")!;
  const fullstackMetrics = JSON.parse(await fs.readFile(path.join(root, "report", `${fullstack.exported.stem}.metrics.json`), "utf8"));
  assert.equal(fullstackMetrics.resume.experiences[0].type, "work", "freelance work is not demoted into a fictional portfolio project");
  console.log(JSON.stringify({ fixtureReport: path.join(root, "report"), realSources: 5, execution: "scripted_fixture", externalModelCalls: 0 }));
});

test("child export derives the original shared root charges and retains both member records", { timeout: 30_000 }, async () => {
  const f = await fixture("gold-backend", false);
  try {
    const { groups, mapping } = await loadGoldCase(datasetDirectory, "gold-backend");
    const request = await prepareBenchmarkRequest(f.source, groups, mapping, { workspaceKey: "synthetic-eval-child", rootScopeKey: f.task.rootScopeKey,
      parentTaskId: f.task.id, runtimeBinding, idempotencyKey: "synthetic-export-child" }, "resume-quality-task-candidate-v2");
    let child = await f.kernel.createTask(request, access);
    await f.kernel.run(child.id, "start", { expectedRevision: child.revision, sourceFingerprint: child.sourceFingerprint, runtimeBinding, consent: true },
      { runtimeFingerprint: "synthetic-eval-generation", reasoner: async () => ({ text: f.raw, finishReason: "stop" }) }, access);
    for (let i = 0; i < 400; i++) { child = await f.kernel.readTask(child.id); if (child.status !== "running") break; await delay(5); }
    assert.equal(child.status, "awaiting_answer");
    const result = await freezeTaskCandidate({ ...f.options, taskId: child.id });
    assert.equal(result.run.origin.rootTaskId, f.task.id); assert.equal(result.run.observed.modelCalls, 2);
    assert.deepEqual(result.run.budget, budget);
    for (const id of [f.task.id, child.id]) assert.ok((await fs.stat(path.join(f.options.outputDirectory, `${result.stem}.records/${id}.json`))).isFile());
    await verifyFrozenCandidate(result.run, result.stem, f.options.outputDirectory, f.source);
  } finally { await f.kernel.close(); }
});

test("material never exposes scoring labels or attribution; grouped evidence cannot be transferred to another employer", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const prompt = JSON.stringify(f.material);
    for (const key of ["requirements", "anchorGroups", "star", "approvedParaphrases", "provenance", "originals", "author"]) assert.ok(!prompt.includes(`"${key}"`));
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const candidate = structuredClone(f.candidate); candidate.groups[0].groupId = "work-1";
    record.task.reply.content = JSON.stringify(candidate); record.task.conversation.messages[1] = record.task.reply;
    record.recent.at(-1).output = JSON.stringify({ kind: "reply", content: record.task.reply.content });
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate(f.options), /evidence_group_changed/);
    await assert.rejects(fs.stat(f.options.outputDirectory), { code: "ENOENT" });
  } finally { await f.kernel.close(); }
});

test("wrong citation offsets and unsupported numbers stay in the candidate and fail evaluation, rather than being silently repaired", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    const candidate = structuredClone(f.candidate); candidate.groups[0].bullets[0].text += " Kafka 100000";
    candidate.groups[0].bullets[0].citations[0].original.start = 1;
    record.task.reply.content = JSON.stringify(candidate); record.task.conversation.messages[1] = record.task.reply;
    record.recent.at(-1).output = JSON.stringify({ kind: "reply", content: record.task.reply.content }); await fs.writeFile(file, JSON.stringify(record));
    const frozen = await freezeTaskCandidate(f.options), assessed = await judgeResumeQuality(f.source, frozen.run);
    assert.ok(assessed.antiHallucination.percent! < 100); assert.equal(assessed.antiHallucination.claims[0]!.invalidCitations, 1);
    assert.match(assessed.antiHallucination.claims[0]!.text, /Kafka 100000$/);
  } finally { await f.kernel.close(); }
});

test("owner/runtime changes, active roots, changed inputs and archive tampering fail closed", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(freezeTaskCandidate({ ...f.options, ownerId: "another-owner" }), /owner_record/);
    await assert.rejects(freezeTaskCandidate({ ...f.options, metadata: { ...metadata, runtimeId: "different" } }), /runtime_binding_changed/);
    const file = path.join(f.options.recordDirectory, `${f.task.id}.json`), original = await fs.readFile(file), record = JSON.parse(original.toString());
    record.task.status = "running"; await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate(f.options), /root_still_active/);
    record.task.status = "awaiting_answer"; record.task.conversation.messages[0].content += " "; await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(freezeTaskCandidate(f.options), /prompt_or_reply_changed/);
    await fs.writeFile(file, original); const result = await freezeTaskCandidate(f.options);
    const rawFile = path.join(f.options.outputDirectory, `${result.stem}.output.txt`); await fs.appendFile(rawFile, " tail");
    await assert.rejects(verifyFrozenCandidate(result.run, result.stem, f.options.outputDirectory, f.source), /archive_changed/);
    assert.notEqual(digest(await fs.readFile(rawFile)), result.run.origin.rawOutputSha256);
  } finally { await f.kernel.close(); }
});
