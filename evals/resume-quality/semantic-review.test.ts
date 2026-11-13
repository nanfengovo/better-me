import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createAgentServer } from "../../apps/agent-host/src/server.js";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/career-task.js";
import { registerTestIdentity } from "../../apps/agent-host/tests/fixtures/identity.js";
import { collectBenchmark } from "./collect.mjs";
import { loadSemanticReviewMaterial, reviewSemanticCampaign } from "./semantic-review.mjs";
import { digest } from "./gold/extract.mjs";

const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");
const datasetDirectory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
const spanFor = (e: { id: string; sha256: string; text: string }) => ({ evidenceId: e.id, sourceSha256: e.sha256, start: 0, end: e.text.length, quote: e.text });

test("source-review overlay exhaustively binds accepted, rejected and full overflow outputs without changing old scores or self-certifying facts", { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-semantic-review-")), token = "synthetic-semantic-token";
  const runtime = { kind: "model" as const, modelSettings: { provider: "ollama" as const, model: "scripted-semantic-not-real-model", baseUrl: "http://127.0.0.1:11434/v1" } };
  const runtimeBinding = careerRuntimeBinding(runtime), overflow = "FULL-OUTPUT-😀\r\n".repeat(12000) + "FULL-END";
  let calls = 0;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(root, "accounts"), runsDirectory: path.join(root, "runs"), understandingDirectory: path.join(root, "understanding"),
    checkpointer: new MemorySaver() as never, careerTaskReasoner: async () => async prompt => {
      calls++; const state = JSON.parse(prompt.split("\n\n").at(-1)!);
      const material = JSON.parse(state.conversation.messages[0].content).material;
      if (material.caseId === "gold-sre") return { text: overflow, finishReason: "stop" };
      const unit = material.candidate.evidence.find((e: { groupId: string }) => material.candidate.groups.some((g: { id: string }) => g.id === e.groupId));
      const bullets = material.caseId === "gold-data-engineer" ? [
        { id: "wrong-exact", text: "Developed a suite of utilities to semi-automate the X-ray astronomical data analysis.", evidenceIds: ["item-19"] },
        { id: "wrong-paraphrase", text: "Developed the low-frequency radio sky image simulation software as part of Research project C.", evidenceIds: ["item-19"] },
      ] : [{ id: "source-exact", text: unit.text, evidenceIds: [unit.id] }];
      return { text: " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: material.caseId, bullets, questions: [] }) + " \r\n", finishReason: "stop" };
    } });
  try {
    await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`, account = await registerTestIdentity(baseUrl, token, "semantic-review-fixture");
    const campaignDirectory = path.join(root, "campaign");
    const summary = await collectBenchmark({ datasetDirectory, caseIds: ["gold-backend", "gold-data-engineer", "gold-sre"], campaignId: "synthetic-semantic-full-batch",
      ownerId: account.principal.id, recordDirectory: path.join(root, "accounts", "owners", account.principal.id, "career-tasks-v1"),
      metadata: { execution: "scripted_fixture", provider: "fixture", id: runtime.modelSettings.model, revision: "fixture-v1", runtimeId: runtimeBinding.id },
      runtimeBinding, runtime, budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 60000 }, outputDirectory: campaignDirectory, baseUrl,
      headers: { ...account.headers, Authorization: `Bearer ${token}` }, pollMs: 5, observationMs: 5000 });
    assert.equal(summary.frozen, 1); assert.equal(summary.failed, 2); assert.equal(calls, 3);
    const options = { datasetDirectory, campaignDirectory };
    const material = await loadSemanticReviewMaterial(options);
    assert.equal(material.cases.length, 3); assert.equal(material.cases.flatMap(c => c.outputs).length, 3);
    const overflowOutput = material.cases.find(c => c.caseId === "gold-sre").outputs[0];
    assert.equal(overflowOutput.raw, overflow); assert.equal(overflowOutput.outputSha256, digest(overflow));
    assert.equal(overflowOutput.unreviewableReason, "invalid_json");
    const review = { schemaVersion: 1, campaignId: material.campaignId, collectionReceiptSha256: material.collectionReceiptSha256,
      reviewer: { kind: "operator_source_review", label: "Synthetic fixture reviewer, not a real judgement", externalHuman: false, blind: false, providerAttestation: false },
      cases: material.cases.map(c => ({ caseId: c.caseId, taskId: c.taskId, caseSha256: c.caseSha256, inputMaterialSha256: c.inputMaterialSha256,
        outputs: c.outputs.map(o => ({ outputIndex: o.outputIndex, outputSha256: o.outputSha256, unreviewableReason: o.unreviewableReason,
          claims: o.claims.map(claim => {
            const wrong = c.caseId === "gold-data-engineer";
            return { claimId: claim.id, textSha256: claim.textSha256, citedEvidenceIds: claim.citedEvidenceIds,
              verdict: wrong ? "wrong_citation" : "supported", reason: wrong ? "Research wording is not supported by the internship citation." : "Exact full source unit retained.",
              supportingSpans: wrong ? [] : claim.citedEvidenceIds.map(id => spanFor(c.source.candidate.evidence.find(e => e.id === id))),
              contrastingSpans: wrong ? [spanFor(c.source.candidate.evidence.find(e => e.id === (claim.id === "wrong-exact" ? "item-13" : "item-12")))] : [],
              star: { situation: "uncertain", task: "uncertain", action: wrong ? "uncertain" : "present", result: wrong ? "uncertain" : "not_stated",
                reason: "Only cited action receives source credit; no observed result is invented.", resultSpans: [] } };
          }) })) })) };
    const before = await fs.readFile(path.join(campaignDirectory, "summary.json"));
    const result = await reviewSemanticCampaign({ ...options, review, outputDirectory: path.join(root, "reviewed") });
    assert.deepEqual(result.total, { claims: 3, supported: 1, wrongCitation: 2, uncertain: 0, sourceStatedResults: 0, purposeOnly: 0 });
    assert.equal(result.accepted.supported, 1); assert.equal(result.rejected.wrongCitation, 2);
    assert.equal(result.overallQualityPassed, null); assert.equal(result.modelRequests, 0); assert.equal(calls, 3);
    assert.deepEqual(result.coverage, { cases: 3, recordedOutputs: 3, unreviewableOutputs: 1, unrecordedModelOutputs: 0 });
    assert.equal(result.reviewer.externalHuman, false); assert.equal(result.cases.find(c => c.caseId === "gold-sre").outputs[0].raw, overflow);
    assert.deepEqual(await fs.readFile(path.join(campaignDirectory, "summary.json")), before);
    const report = await fs.readFile(path.join(root, "reviewed", "report.md"), "utf8");
    assert.match(report, /wrong-paraphrase/); assert.match(report, /invalid_json/);
    assert.match(report, new RegExp(overflowOutput.outputSha256));
    assert.match(report, /完整输出清单/); assert.match(report, /Research project C/);
    const again = await reviewSemanticCampaign({ ...options, review, outputDirectory: path.join(root, "repeated") });
    assert.deepEqual(result, again);
    await assert.rejects(reviewSemanticCampaign({ ...options, review, outputDirectory: path.join(root, "reviewed") }), /EEXIST/);
    let invalid = 0;
    const rejectChange = async (change: (value: typeof review) => void, error: RegExp) => {
      const changed = structuredClone(review); change(changed);
      const outputDirectory = path.join(root, `invalid-${invalid++}`);
      await assert.rejects(reviewSemanticCampaign({ ...options, review: changed, outputDirectory }), error);
      await assert.rejects(fs.stat(outputDirectory), /ENOENT/, "invalid annotations never produce a partial report");
    };
    await rejectChange(r => r.cases.pop(), /complete_case_set/);
    await rejectChange(r => r.cases[1].outputs = [], /complete_output_set/);
    await rejectChange(r => r.cases[1].outputs[0].claims.pop(), /complete_claim_set/);
    await rejectChange(r => r.cases[0].outputs[0].claims.push(r.cases[0].outputs[0].claims[0]), /complete_claim_set/);
    await rejectChange(r => r.collectionReceiptSha256 = "0".repeat(64), /campaign_binding/);
    await rejectChange(r => r.cases[0].taskId = "different-task", /case_binding/);
    await rejectChange(r => r.cases[0].caseSha256 = "0".repeat(64), /case_binding/);
    await rejectChange(r => r.cases[0].inputMaterialSha256 = "0".repeat(64), /case_binding/);
    await rejectChange(r => r.cases[0].outputs[0].outputSha256 = "0".repeat(64), /output_binding/);
    await rejectChange(r => r.cases[0].outputs[0].claims[0].textSha256 = "0".repeat(64), /claim_binding/);
    await rejectChange(r => r.cases[0].outputs[0].claims[0].citedEvidenceIds = ["other-role"], /claim_binding/);
    await rejectChange(r => r.cases[0].outputs[0].claims[0].supportingSpans[0].quote += " changed", /exact_source_span/);
    await rejectChange(r => r.cases[0].outputs[0].claims[0].supportingSpans[0].sourceSha256 = "0".repeat(64), /exact_source_span/);
    await rejectChange(r => r.cases[1].outputs[0].claims[0].supportingSpans = r.cases[1].outputs[0].claims[0].contrastingSpans, /citation_scope/);
    await rejectChange(r => r.cases[1].outputs[0].claims[0].star.result = "present", /unsupported_star_credit/);
    await rejectChange(r => r.cases[0].outputs[0].claims[0].star.result = "present", /result_source/);
    await rejectChange(r => r.reviewer.externalHuman = true, /Invalid/);
    assert.equal(calls, 3, "offline review never invokes or retries a model");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("source-review includes rejected repair attempts and explicitly reports charged calls with no recorded output", { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-semantic-repair-")), token = "synthetic-repair-token";
  const runtime = { kind: "model" as const, modelSettings: { provider: "ollama" as const, model: "scripted-repair-not-real-model", baseUrl: "http://127.0.0.1:11434/v1" } };
  const runtimeBinding = careerRuntimeBinding(runtime);
  let calls = 0;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(root, "accounts"), runsDirectory: path.join(root, "runs"), understandingDirectory: path.join(root, "understanding"),
    checkpointer: new MemorySaver() as never, careerTaskReasoner: async () => async prompt => {
      calls++; const state = JSON.parse(prompt.split("\n\n").at(-1)!);
      const material = JSON.parse(state.conversation.messages[0].content).material;
      if (material.caseId === "gold-sre") throw Error("synthetic_transport_failure_no_model_output");
      const e = material.candidate.evidence[0];
      return { text: " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: material.caseId,
        bullets: [{ id: calls === 1 ? "invalid-contract" : "source-exact", text: e.text, evidenceIds: [calls === 1 ? "unknown-source" : e.id] }], questions: [] }) + " \r\n", finishReason: "stop" };
    } });
  try {
    await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`, account = await registerTestIdentity(baseUrl, token, "semantic-repair-fixture");
    const campaignDirectory = path.join(root, "campaign");
    const summary = await collectBenchmark({ datasetDirectory, caseIds: ["gold-backend", "gold-sre"], campaignId: "synthetic-semantic-repair",
      ownerId: account.principal.id, recordDirectory: path.join(root, "accounts", "owners", account.principal.id, "career-tasks-v1"),
      metadata: { execution: "scripted_fixture", provider: "fixture", id: runtime.modelSettings.model, revision: "fixture-v1", runtimeId: runtimeBinding.id },
      runtimeBinding, runtime, budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60000 }, outputDirectory: campaignDirectory, baseUrl,
      headers: { ...account.headers, Authorization: `Bearer ${token}` }, pollMs: 5, observationMs: 5000 });
    assert.equal(summary.frozen, 1); assert.equal(summary.failed, 1); assert.equal(calls, 3);
    const options = { datasetDirectory, campaignDirectory }, material = await loadSemanticReviewMaterial(options);
    assert.equal(material.cases[0].outputs.length, 2); assert.equal(material.cases[1].outputs.length, 0);
    assert.equal(material.cases[0].outputs[0].unreviewableReason, "invalid_bound_candidate_contract");
    assert.equal(material.cases[0].outputs[0].disposition, "rejected_output");
    assert.equal(material.cases[0].outputs[1].disposition, "accepted_candidate");
    assert.equal(material.cases[1].unrecordedModelOutputs, 1);
    const review = { schemaVersion: 1, campaignId: material.campaignId, collectionReceiptSha256: material.collectionReceiptSha256,
      reviewer: { kind: "operator_source_review", label: "Synthetic repair fixture, not real source judgement", externalHuman: false, blind: false, providerAttestation: false },
      cases: material.cases.map(c => ({ caseId: c.caseId, taskId: c.taskId, caseSha256: c.caseSha256, inputMaterialSha256: c.inputMaterialSha256,
        outputs: c.outputs.map(o => ({ outputIndex: o.outputIndex, outputSha256: o.outputSha256, unreviewableReason: o.unreviewableReason,
          claims: o.claims.map(claim => ({ claimId: claim.id, textSha256: claim.textSha256, citedEvidenceIds: claim.citedEvidenceIds,
            verdict: "supported", reason: "Exact source retained after rejected contract repair.",
            supportingSpans: claim.citedEvidenceIds.map(id => spanFor(c.source.candidate.evidence.find(e => e.id === id))), contrastingSpans: [],
            star: { situation: "not_stated", task: "not_stated", action: "present", result: "not_stated", reason: "No inferred outcome.", resultSpans: [] } })) })) })) };
    const result = await reviewSemanticCampaign({ ...options, review, outputDirectory: path.join(root, "reviewed") });
    assert.deepEqual(result.coverage, { cases: 2, recordedOutputs: 2, unreviewableOutputs: 1, unrecordedModelOutputs: 1 });
    assert.equal(result.total.claims, 1); assert.equal(result.accepted.supported, 1); assert.equal(result.rejected.claims, 0);
    const report = await fs.readFile(path.join(root, "reviewed", "report.md"), "utf8");
    assert.match(report, /invalid_bound_candidate_contract/); assert.match(report, /无已记录输出的调用 1 次/);
    assert.match(report, /无法审阅，不计成功/); assert.equal(calls, 3);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
