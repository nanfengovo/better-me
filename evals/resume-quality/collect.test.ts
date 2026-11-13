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
import { collectBenchmark, taskHttp } from "./collect.mjs";
import { verifyFrozenCandidate, verifyTaskFailure, loadGoldCase } from "./freeze.mjs";
import { reviewCollection, reviewCollectionQuality } from "./collection-report.mjs";

const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");
const datasetDirectory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
const allCases = ["gold-backend", "gold-frontend", "gold-sre", "gold-fullstack", "gold-data-engineer"];
const runtime = { kind: "model" as const, modelSettings: { provider: "ollama" as const, model: "scripted-benchmark-not-real-model", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "SYNTHETIC-NEVER-ARCHIVE-THIS-SECRET" } };
const runtimeBinding = careerRuntimeBinding(runtime);
const metadata = { execution: "scripted_fixture", provider: "fixture", id: runtime.modelSettings.model, revision: "fixture-v1", runtimeId: runtimeBinding.id };
const budget = { maxModelCalls: 3, maxToolCalls: 1, maxActiveMs: 60_000 };
function reply(prompt: string) {
  const state = JSON.parse(prompt.split("\n\n").at(-1)!);
  const plan = JSON.parse(state.conversation.messages[0].content), source = plan.material;
  const evidence = source.candidate.evidence.find((e: { kind: string; groupId: string }) => !e.kind.endsWith("list") && source.candidate.groups.some((g: { id: string }) => g.id === e.groupId));
  if (["resume-quality-task-candidate-v4", "resume-quality-task-candidate-v5", "resume-quality-task-candidate-v6", "resume-quality-task-candidate-v7"].includes(plan.protocolVersion)) return { plan, content: JSON.stringify({ schemaVersion: 2, caseId: source.caseId,
    bullets: [{ id: "source-bullet", text: evidence.text, evidenceIds: [evidence.id] }], questions: ["Missing facts remain questions."] }) };
  return { plan, content: JSON.stringify({ schemaVersion: 1, caseId: source.caseId, groups: [{ groupId: evidence.groupId,
    bullets: [{ id: "source-bullet", text: evidence.text, citations: [{ evidenceId: evidence.id, sourceSha256: evidence.sha256,
      original: { start: 0, end: evidence.text.length, quote: evidence.text } }] }] }], questions: ["Missing facts remain questions."] }) };
}
async function fixture(reasoner: (prompt: string) => Promise<string> | string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-quality-http-collector-")), token = "synthetic-collector-token";
  let calls = 0, adapterBuilds = 0;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "understanding"),
    checkpointer: new MemorySaver() as never, careerTaskReasoner: async () => { adapterBuilds++; return async prompt => { calls++; return { text: await reasoner(prompt), finishReason: "stop" }; }; } });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`, account = await registerTestIdentity(baseUrl, token, "quality-collector");
  return { directory, server, get calls() { return calls; }, get adapterBuilds() { return adapterBuilds; }, options: { datasetDirectory, caseIds: allCases, campaignId: "synthetic-http-campaign",
    ownerId: account.principal.id, recordDirectory: path.join(directory, "accounts", "owners", account.principal.id, "career-tasks-v1"), metadata,
    runtimeBinding, runtime, budget, outputDirectory: path.join(directory, "collection"), baseUrl,
    headers: { ...account.headers, Authorization: `Bearer ${token}` }, pollMs: 5, observationMs: 5000 },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("authenticated HTTP candidate repair preserves missing-current-role findings and both complete attempts on the original root", { timeout: 30_000 }, async () => {
  let first = true, badRaw = "";
  const f = await fixture(prompt => {
    const result = reply(prompt), state = JSON.parse(prompt.split("\n\n").at(-1)!);
    assert.deepEqual(state.currentWorkInventory.requiredGroups.map((g: { id: string }) => g.id), ["work-0"]);
    if (first) {
      first = false;
      const e = result.plan.material.candidate.evidence.find((e: { id: string }) => e.id === "project-0-action-0");
      badRaw = " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: result.plan.material.caseId,
        bullets: [{ id: "project-only", text: e.text, evidenceIds: [e.id] }], questions: [] }) + " \r\n";
      return badRaw;
    }
    assert.equal(state.observations.find((r: { kind: string }) => r.kind === "free_chat_output").output, badRaw);
    const rejection = state.observations.find((r: { kind: string }) => r.kind === "free_chat_rejected");
    assert.equal(rejection.code, "candidate_current_work_omitted");
    assert.deepEqual(rejection.workCoverage.missingCurrentGroups.map((g: { id: string }) => g.id), ["work-0"]);
    return result.content;
  });
  try {
    const summary = await collectBenchmark({ ...f.options, caseIds: ["gold-frontend"], budget: { ...budget, maxModelCalls: 2 } });
    assert.equal(summary.frozen, 1); assert.equal(summary.failed, 0); assert.equal(summary.observedModelCalls, 2);
    assert.equal(f.calls, 2); assert.equal(f.adapterBuilds, 1);
    const receipt = await reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "review-current-work") });
    const result = receipt.results[0];
    assert.equal(result.candidateRejections[0].code, "candidate_current_work_omitted");
    assert.deepEqual(result.candidateRejections[0].workCoverage.missingCurrentGroups.map((g: { id: string }) => g.id), ["work-0"]);
    const directory = path.join(f.options.outputDirectory, result.caseId, "frozen");
    const record = JSON.parse(await fs.readFile(path.join(directory, `${result.stem}.records`, `${result.taskId}.json`), "utf8"));
    assert.equal(record.recent.filter((r: { kind: string }) => r.kind === "free_chat_output").length, 2);
    assert.equal(record.recent.find((r: { kind: string }) => r.kind === "free_chat_output").output, badRaw);
    assert.equal(record.task.budget.maxModelCalls, 2);
    assert.match(await fs.readFile(path.join(f.directory, "review-current-work", "report.md"), "utf8"), /candidate_current_work_omitted/);
  } finally { await f.close(); }
});

test("normal authenticated task repair rejects all three observed academic relocations and archives the complete source-aware receipt", { timeout: 30_000 }, async () => {
  const badWording = [
    "Separated the faint cosmological EoR signal along the frequency dimension using a Convolutional Denoising Autoencoder (CDAE).",
    "Classified the radio galaxies in the FIRST survey according to morphologies using a Convolutional Neutral Network (CNN).",
    "Developed a suite of utilities to semi-automate the X-ray astronomical data analysis.",
  ];
  let sentBad = false, badRaw = "", repaired = false;
  const f = await fixture(prompt => {
    const result = reply(prompt);
    if (result.plan.material.caseId !== "gold-data-engineer") return result.content;
    const state = JSON.parse(prompt.split("\n\n").at(-1)!);
    if (!sentBad) {
      sentBad = true;
      badRaw = " \r\n" + JSON.stringify({ schemaVersion: 2, caseId: result.plan.material.caseId,
        bullets: badWording.map((text, i) => ({ id: `research-${i}`, text, evidenceIds: ["item-19"] })), questions: [] }) + " \r\n";
      return badRaw;
    }
    const rejection = state.observations.find((o: { kind: string }) => o.kind === "free_chat_rejected");
    assert.equal(rejection.code, "candidate_source_attribution_conflict");
    assert.equal(rejection.attribution.length, 3);
    assert.deepEqual(rejection.attribution.map((a: { claimId: string }) => a.claimId), ["research-0", "research-1", "research-2"]);
    assert.ok(rejection.attribution.every((a: { matchingSources: { kind: string; text: string }[] }) => a.matchingSources.some(s => s.kind === "academic" && s.text.length > 80)));
    assert.equal(state.observations.find((o: { kind: string }) => o.kind === "free_chat_output").output, badRaw);
    repaired = true; return result.content;
  });
  try {
    const summary = await collectBenchmark(f.options);
    assert.equal(summary.frozen, 5); assert.equal(summary.failed, 0); assert.equal(summary.observedModelCalls, 6);
    assert.equal(f.calls, 6); assert.equal(f.adapterBuilds, 1); assert.equal(repaired, true);
    const observed = summary.results.find((r: { caseId: string }) => r.caseId === "gold-data-engineer")!;
    const archived = path.join(f.options.outputDirectory, observed.caseId, "frozen");
    const record = JSON.parse(await fs.readFile(path.join(archived, `${observed.stem}.records`, `${observed.taskId}.json`), "utf8"));
    assert.equal(record.recent.find((r: { kind: string }) => r.kind === "free_chat_output").output, badRaw);
    assert.equal(record.recent.find((r: { kind: string }) => r.kind === "free_chat_rejected").attribution.length, 3);
    const run = JSON.parse(await fs.readFile(path.join(archived, `${observed.stem}.run.json`), "utf8"));
    assert.equal(run.protocolVersion, "resume-quality-task-candidate-v7"); assert.equal(run.origin.execution, "scripted_fixture");
    await verifyFrozenCandidate(run, observed.stem, archived, (await loadGoldCase(datasetDirectory, observed.caseId)).test);
    const receipt = await reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "review-attribution") });
    const reviewed = receipt.results.find((r: { caseId: string }) => r.caseId === observed.caseId);
    assert.deepEqual(reviewed.candidateRejections, record.recent.filter((r: { kind: string }) => r.kind === "free_chat_rejected"));
    assert.match(await fs.readFile(path.join(f.directory, "review-attribution", "report.md"), "utf8"), /candidate_source_attribution_conflict/);
  } finally { await f.close(); }
});

test("five normal authenticated HTTP tasks archive successes, invalid candidates and complete overflow without hiding failures", { timeout: 30_000 }, async () => {
  const seen = new Map<string, number>(), overflow = "FULL-OVERFLOW-".repeat(20_000) + "EXACT-END";
  const f = await fixture(prompt => {
    const r = reply(prompt), id = r.plan.material.caseId, n = (seen.get(id) ?? 0) + 1; seen.set(id, n);
    if (id === "gold-backend" && n === 1) return "FIRST INVALID OUTER ENVELOPE\r\nUNCHANGED";
    if (id === "gold-frontend") return JSON.stringify({ kind: "reply", content: "NOT-CANDIDATE-JSON\r\n".repeat(1500) + "COMPLETE-END" });
    if (id === "gold-sre") return overflow;
    return r.content;
  });
  let creates = 0, starts = 0;
  const transport = async (url: string, init: RequestInit) => { assert.match(url, /\/api\/v1\/agent\/tasks(?:\/|$)/);
    if (init.method === "POST") { if (url.endsWith("/start")) starts++; else creates++; } return fetch(url, init); };
  try {
    const summary = await collectBenchmark({ ...f.options, transport });
    assert.equal(summary.planned, 5); assert.equal(summary.frozen, 3); assert.equal(summary.failed, 2); assert.equal(summary.unresolved, 0);
    assert.equal(summary.observedModelCalls, 8); assert.equal(f.calls, 8); assert.equal(f.adapterBuilds, 1); assert.equal(creates, 5); assert.equal(starts, 5); assert.equal(summary.comparable, false);
    for (const result of summary.results) {
      const directory = path.join(f.options.outputDirectory, result.caseId, result.outcome === "frozen" ? "frozen" : "failure");
      if (result.outcome === "frozen") {
        const run = JSON.parse(await fs.readFile(path.join(directory, `${result.stem}.run.json`), "utf8"));
        await verifyFrozenCandidate(run, result.stem, directory, (await loadGoldCase(datasetDirectory, result.caseId)).test);
      } else {
        const failure = await verifyTaskFailure(directory, result.stem); assert.equal(failure.scored, false);
        if (result.caseId === "gold-sre") {
          const task = JSON.parse(await fs.readFile(path.join(directory, `${result.stem}.task.json`), "utf8"));
          const artifact = task.outputArtifacts[0];
          assert.equal(await fs.readFile(path.join(directory, `${result.stem}.records/outputs/${task.id}/${artifact.id}.txt`), "utf8"), overflow);
        }
        if (result.caseId === "gold-frontend") {
          const record = await fs.readFile(path.join(directory, `${result.stem}.records/${result.taskId}.json`), "utf8");
          assert.match(record, /COMPLETE-END/); assert.ok(!record.includes(runtime.modelSettings.apiKey));
        }
      }
    }
    await assert.rejects(collectBenchmark({ ...f.options, outputDirectory: path.join(f.directory, "second-output"), transport }), /already_exists_observe_original/);
    assert.equal(creates, 5); assert.equal(starts, 5); assert.equal(f.calls, 8);
    const reportDirectory = path.join(f.directory, "whole-campaign-report");
    const receipt = await reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: reportDirectory });
    assert.equal(receipt.planned, 5); assert.equal(receipt.frozen, 3); assert.equal(receipt.failed, 2); assert.equal(receipt.verifiedArchives, 5);
    assert.equal(receipt.observedModelCalls, 8); assert.equal(receipt.candidateAcceptancePercent, 60); assert.equal(receipt.comparable, false);
    await assert.rejects(reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: reportDirectory }), { code: "EEXIST" });
    const full = await reviewCollectionQuality({ datasetDirectory, campaignDirectory: reportDirectory, outputDirectory: path.join(f.directory, "whole-quality-report") });
    assert.equal(full.planned, 5); assert.equal(full.qualityMeasured, 3); assert.equal(full.failed, 2); assert.equal(full.allPlannedQualityMeasured, false);
    for (const entry of full.results.filter(r => r.metrics)) {
      assert.deepEqual(entry.metrics.editorial.automaticChecksScope, ["antiHallucination", "layout"]);
      assert.equal(entry.metrics.editorial.overallQualityPassed, null, "facts/layout pass never becomes overall editorial approval");
      assert.equal(entry.metrics.editorial.status, "requires_review");
      assert.deepEqual(entry.metrics.currentWork.missingCurrentGroups, []);
      assert.equal(entry.metrics.currentWork.overallQualityPassed, null, "current-role presence is not overall resume approval");
    }
    assert.equal(full.candidateAcceptancePercent, 60); assert.equal(full.comparable, false); assert.equal(full.observedModelCalls, 8); assert.equal(f.calls, 8);
    assert.equal(full.results.filter(r => r.metrics === null).length, 2); assert.equal(full.conditionalQuality[0].execution, "scripted_fixture");
    assert.equal(full.files.filter(file => file.path.startsWith("quality/") && file.path.endsWith(".pdf")).length, 3);
    const changed = structuredClone(summary); changed.results.pop(); changed.planned = 4;
    await fs.writeFile(path.join(f.options.outputDirectory, "summary.json"), JSON.stringify(changed));
    await assert.rejects(reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "changed-report") }), /result_set_changed/);
  } finally { await f.close(); }
});

test("lost create acknowledgement only reconciles the original ready task and archives zero-charge failure", { timeout: 30_000 }, async () => {
  const f = await fixture(prompt => reply(prompt).content); let posts = 0;
  try {
    const summary = await collectBenchmark({ ...f.options, caseIds: ["gold-backend"], transport: async (url: string, init: RequestInit) => {
      const response = await fetch(url, init); if (init.method === "POST") { posts++; throw Error("lost response; no retry"); } return response;
    } });
    assert.equal(posts, 1); assert.equal(f.calls, 0); assert.equal(summary.failed, 1); assert.equal(summary.observedModelCalls, 0);
    const result = summary.results[0], directory = path.join(f.options.outputDirectory, result.caseId, "failure");
    const failure = await verifyTaskFailure(directory, result.stem); assert.equal(failure.status, "ready");
    assert.equal(failure.observed.modelCalls, 0); assert.equal(failure.reason.stage, "dispatch");
    const full = await reviewCollectionQuality({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "zero-quality") });
    assert.equal(full.planned, 1); assert.equal(full.qualityMeasured, 0); assert.deepEqual(full.conditionalQuality, []);
    assert.equal(full.results[0].metrics, null); assert.equal(full.observedModelCalls, 0); assert.equal(f.calls, 0);
    assert.equal(full.files.some(file => file.path.endsWith(".pdf")), false, "no fabricated blank success PDF");
    const taskFile = path.join(directory, `${result.stem}.task.json`); await fs.appendFile(taskFile, " ");
    await assert.rejects(verifyTaskFailure(directory, result.stem), /failure_archive_changed/);
  } finally { await f.close(); }
});

test("lost start acknowledgement and transient observations never repeat mutation or inference", { timeout: 30_000 }, async () => {
  const f = await fixture(prompt => reply(prompt).content); let posts = 0, failedReads = 0;
  try {
    const summary = await collectBenchmark({ ...f.options, caseIds: ["gold-backend"], transport: async (url: string, init: RequestInit) => {
      if (init.method === "GET" && /\/ct_[a-f0-9]+$/.test(url) && failedReads++ < 3) throw Error("transient observer only");
      const response = await fetch(url, init); if (init.method === "POST") { posts++; if (url.endsWith("/start")) throw Error("lost acknowledgement"); } return response;
    } });
    assert.equal(summary.frozen, 1); assert.equal(summary.observedModelCalls, 1); assert.equal(f.calls, 1); assert.equal(posts, 2); assert.ok(failedReads >= 4);
  } finally { await f.close(); }
});

test("collector rejects remote/credentialled URLs, unsafe routes and bad metadata before task mutation", async () => {
  for (const baseUrl of ["https://example.com:443", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://localhost:1234"]) {
    assert.throws(() => taskHttp({ baseUrl, headers: {} }), /explicit_loopback_host_required/);
  }
  await assert.rejects(taskHttp({ baseUrl: "http://127.0.0.1:1234", headers: {} })("/../chat"), /tasks_route_required/);
  const f = await fixture(() => { throw Error("must not execute"); });
  try {
    await assert.rejects(collectBenchmark({ ...f.options, metadata: { ...metadata, revision: "" } })); assert.equal(f.calls, 0);
    await assert.rejects(fs.stat(f.options.outputDirectory), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("an observation deadline retains the live original ID and unknown final usage, without restart or false terminal failure", { timeout: 30_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture(async prompt => { await gate.promise; return reply(prompt).content; });
  let posts = 0;
  try {
    const summary = await collectBenchmark({ ...f.options, caseIds: ["gold-backend"], observationMs: 30,
      transport: (url: string, init: RequestInit) => { if (init.method === "POST") posts++; return fetch(url, init); } });
    assert.equal(summary.unresolved, 1); assert.equal(summary.failed, 0); assert.equal(summary.frozen, 0); assert.equal(summary.observedModelCalls, null);
    assert.match(summary.results[0].taskId, /^ct_[a-f0-9]{32}$/); assert.equal(summary.results[0].observed, null); assert.equal(f.calls, 1); assert.equal(posts, 2);
    const receipt = await reviewCollection({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "unresolved-report") });
    assert.equal(receipt.unresolved, 1); assert.equal(receipt.verifiedArchives, 0); assert.equal(receipt.observedModelCalls, null);
    const full = await reviewCollectionQuality({ datasetDirectory, campaignDirectory: f.options.outputDirectory, outputDirectory: path.join(f.directory, "unresolved-quality") });
    assert.equal(full.unresolved, 1); assert.equal(full.qualityMeasured, 0); assert.equal(full.observedModelCalls, null); assert.equal(full.results[0].metrics, null);
    const file = path.join(f.options.recordDirectory, `${summary.results[0].taskId}.json`), record = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(record.task.status, "running"); assert.equal(record.task.usage.modelCalls, 1);
  } finally { gate.resolve(); await f.close(); }
});
