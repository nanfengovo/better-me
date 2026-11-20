import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { createAgentServer } from "../../apps/agent-host/src/server.ts";
import { registerTestIdentity } from "../../apps/agent-host/tests/fixtures/identity.ts";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/career-task.ts";
import { careerTaskSourceFingerprint, createCareerTaskResume } from "../../packages/core/src/project/career-task-resume.ts";
import { projectResume, createDefaultResumeView } from "../../packages/core/src/project/resume-projection.ts";
import { DocumentSchema, LocalJsonStore } from "../../packages/storage/src/local-json.ts";
import { inspectCareerTaskWorkspace, resumeSaveCommand } from "../../apps/web/src/lib/career-task-reconciliation.ts";
import { localCatalog, localOllamaOrigin } from "./ollama-context.mjs";
import { digest } from "./gold/extract.mjs";
const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const time = "2026-11-20T00:00:00Z";

function visibility(doc, id = doc.activeResumeId) {
  const view = doc.resumeViews.find(v => v.id === id);
  return Object.fromEntries(projectResume(doc.factBase, view).experiences[0].claims.map(c => [c.id, c.text]));
}
function initialDocument(c) {
  const factBase = { schemaVersion: 1, updatedAt: time,
    profile: { displayName: { zh: "合成资料" }, links: [], traits: [], targetRoles: [], constraints: [] },
    experiences: [{ id: "synthetic-experience", type: "other", org: { zh: "合成实验室" }, title: { zh: "验证记录" }, start: "2025-01", end: "2025-02", techStack: [],
      claims: Object.entries(c.original).map(([id, text]) => ({ id, kind: "action", text: { zh: text }, tags: [] })) }] };
  const view = createDefaultResumeView(factBase, time);
  return DocumentSchema.parse({ documentId: c.id, factBase, activeResumeId: view.id, resumeViews: [view] });
}

async function executeCase(c, model, endpoint, revision) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-grounded-edit-"));
  const token = randomUUID(), identityDirectory = path.join(directory, "accounts");
  const filename = key => path.join(directory, encodeURIComponent(key) + ".json");
  const store = () => new LocalJsonStore("synthetic-resume", {
    getItem: key => existsSync(filename(key)) ? readFileSync(filename(key), "utf8") : null,
    setItem: (key, value) => writeFileSync(filename(key), value, "utf8"),
    removeItem: key => rmSync(filename(key), { force: true }),
  });
  const base = initialDocument(c), runtime = { kind: "model", modelSettings: { provider: "ollama", model, baseUrl: endpoint + "/v1", apiKey: "synthetic-local", temperature: 0 } };
  const runtimeBinding = careerRuntimeBinding(runtime);
  const attempts = [], report = { id: c.id, passed: false, attempts };
  let server, origin, identity, phase = "initialization";
  async function open() {
    server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
      identityDirectory, runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "understanding"),
      chatGptDirectory: path.join(directory, "chat"), checkpointer: new MemorySaver() });
    await once(server, "listening");
    origin = "http://127.0.0.1:" + server.address().port;
  }
  async function close() {
    if (!server) return;
    const current = server; server = undefined;
    current.closeAllConnections();
    await new Promise(resolve => current.close(resolve));
  }
  async function call(suffix, body) {
    const response = await fetch(origin + "/api/v1/agent/tasks" + suffix, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { ...identity.headers, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error("host_http_" + response.status);
    return (await response.json()).task;
  }
  async function settled(id) {
    const deadline = Date.now() + 195_000;
    while (Date.now() < deadline) {
      const task = await call("/" + id);
      if (task.status !== "running") return task;
      await delay(350);
    }
    throw Error("host_poll_timeout");
  }
  const command = task => ({ expectedRevision: task.revision, sourceFingerprint: task.resume.sourceFingerprint, runtimeBinding, runtime, consent: true });
  async function record(task) {
    const stored = JSON.parse(await fs.readFile(path.join(identityDirectory, "owners", identity.principal.id, "career-tasks-v1", task.id + ".json"), "utf8"));
    return { status: task.status, error: task.error ?? null, usage: task.usage, plan: task.writingPlan, confirmation: task.writingConfirmation, draft: task.draft,
      evidence: task.evidence, trace: stored.recent.filter(row => row.writingPhase), fallbacks:stored.recent.filter(row=>row.kind==="writing_fallback"), receipt: task.receipt };
  }
  try {
    await store().save(base); await open();
    identity = await registerTestIdentity(origin, token, "synthetic-revision-reader");
    for (const [index, def] of c.rounds.entries()) {
      phase = `round-${index+1}-planning`;
      assert.equal((await localCatalog(model, endpoint)).entry.digest, revision);
      const doc = await store().load(), before = visibility(doc), source = doc.resumeViews.find(v => v.id === doc.activeResumeId);
      const fields = Object.entries(before).map(([id, originalText]) => ({ id, originalText,
        targetRef: { kind: "claim_text", locale: "zh", experienceId: "synthetic-experience", claimId: id } }));
      const taskInput = { workflow: "text_v1", workspaceKey: c.id, idempotencyKey: `revision-${c.id}-${index+1}`, objective: def.objective, job: c.job,
        resume: { id: source.id, name: source.name, sourceFingerprint: await careerTaskSourceFingerprint(doc, source.id), fields },
        materials: [{ id: def.target, kind: "source", label: "合成项目材料", text: def.material }], consent: true, runtimeBinding, budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 180_000 } };
      const attempt = { round: index + 1, before, target: def.target, input: taskInput }; attempts.push(attempt);
      let task = await call("", taskInput);
      const route = "/" + task.id;
      await call(route + "/start", command(task)); task = await settled(task.id); attempt.observed = await record(task);
      assert.equal(task.status, "awaiting_answer", task.error);
      assert.deepEqual(new Set(task.writingPlan.selections.map(item => item.fieldId)), new Set(Object.keys(before)));
      attempt.modelRecommendedTarget = task.writingPlan.selections.some(item => item.fieldId === def.target && item.include);
      assert.ok(task.writingPlan.questions.some(item => item.fieldId === def.target), "missing field-bound personal confirmation");
      const confirmation = { planHash: task.writingPlan.hash, selectedFieldIds: [def.target], confirmed: true,
        answers: task.writingPlan.questions.map(q => ({ questionId: q.id, text: q.fieldId === def.target ? def.detail : "保留原文" })) };
      phase = `round-${index+1}-draft`;
      await call(route + "/answer", { ...command(task), answer: JSON.stringify(confirmation) }); task = await settled(task.id); attempt.observed = await record(task);
      assert.equal(task.status, "awaiting_review", task.error);
      assert.equal(task.draft.patches.length, 1);
      const patch = task.draft.patches[0], expected = before[def.target] + "\n" + def.detail;
      assert.equal(patch.fieldId, def.target);
      assert.equal(patch.originalText, before[def.target]);
      assert.equal(patch.proposedText, expected, "an independent fixture confirms the complete original and addition");
      assert.deepEqual(patch.evidenceIds.map(id => task.evidence.find(item => item.id === id)?.excerpt), [before[def.target], def.detail]);
      phase = `round-${index+1}-synthetic-review-and-save`;
      // This approval is for a synthetic fixture only, after all byte-level
      // expectations passed. The normal application still asks its user.
      const saved = await createCareerTaskResume(doc, resumeSaveCommand(task, [patch.id]), time);
      await store().save(saved.document);
      const loaded = await store().load(), actual = visibility(loaded);
      assert.deepEqual(actual, { ...before, [def.target]: expected });
      assert.deepEqual(visibility(loaded, source.id), before);
      const checked = await inspectCareerTaskWorkspace(loaded, task, { kind: "resume" });
      assert.equal(checked.state, "current"); assert.ok(checked.receipt);
      task = await call(route + "/receipt", { ...checked.receipt, expectedRevision: task.revision });
      assert.equal(task.status, "completed");
      await close(); await open();
      task = await call(route); assert.equal(task.status, "completed"); assert.deepEqual(task.receipt, checked.receipt && { ...task.receipt, ...checked.receipt });
      attempt.observed = await record(task); attempt.after = actual; attempt.previousVersion = visibility(await store().load(), source.id); attempt.passed = true;
    }
    const final = await store().load();
    assert.deepEqual(final.factBase, base.factBase);
    assert.equal(final.resumeViews.length, c.rounds.length + 1);
    report.versions = final.resumeViews.map(view => ({ id: view.id, fields: visibility(final, view.id) }));
    report.passed = true;
  } catch (error) {
    report.failure = { phase, message: error.message };
  } finally {
    try { await close(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  return report;
}

const { values } = parseArgs({ options: { model: { type: "string" }, endpoint: { type: "string" }, out: { type: "string" } } });
const endpoint = localOllamaOrigin(values.endpoint), model = values.model;
if (!model || !values.out) throw Error("usage: revision-live --model EXACT_LOCAL_MODEL --out NEW_DIRECTORY");
const datasetBytes = await fs.readFile(new URL("./gold/reviewed-revisions-v2.json", import.meta.url));
const dataset = JSON.parse(datasetBytes), { entry } = await localCatalog(model, endpoint);
const sources = Object.fromEntries(await Promise.all(["evals/resume-quality/revision-live.mjs", "apps/agent-host/src/kernel/resume-text.ts", "apps/agent-host/src/kernel/resume-text-grounded.ts", "apps/agent-host/src/kernel/model-protocol.ts", "apps/agent-host/src/kernel/service.ts", "apps/agent-host/src/tasks/evidence.ts", "apps/agent-host/src/tasks/runtime.ts"].map(async file =>
  [file, digest(await fs.readFile(new URL("../../" + file, import.meta.url)))])));
await fs.mkdir(values.out, { mode: 0o700 });
await save(path.join(values.out, "plan.json"), { datasetSha256: digest(datasetBytes), model, revision: entry.digest, sources, caseIds: dataset.cases.map(c => c.id) });
const results = [];
for (const c of dataset.cases) {
  const result = await executeCase(c, model, endpoint, entry.digest);
  results.push(result); await save(path.join(values.out, c.id + ".json"), result);
  console.log(JSON.stringify({ id: c.id, passed: result.passed, rounds: result.attempts.map(item=>({ passed: item.passed ?? false, modelRecommendedTarget: item.modelRecommendedTarget ?? false, status: item.observed?.status })), failure: result.failure }));
}
const after = await localCatalog(model, endpoint);
const summary = { distinctCases: results.length, passedCases: results.filter(r => r.passed).length, passedRounds: results.flatMap(r => r.attempts).filter(a => a.passed).length,
  plannedRounds: dataset.cases.reduce((n, c) => n + c.rounds.length, 0), modelRecommendedTargets: results.flatMap(r => r.attempts).filter(a => a.modelRecommendedTarget).length,
  modelCalls:results.flatMap(r=>r.attempts).reduce((n,a)=>n+(a.observed?.trace.length??0),0),
  modelIncomplete:results.flatMap(r=>r.attempts).reduce((n,a)=>n+(a.observed?.fallbacks.length??0),0),
  sameModelDigest: after.entry.digest === entry.digest };
await save(path.join(values.out, "report.json"), summary);
console.log(JSON.stringify(summary, null, 2));
if (summary.passedCases !== summary.distinctCases || !summary.sameModelDigest) process.exitCode = 1;
