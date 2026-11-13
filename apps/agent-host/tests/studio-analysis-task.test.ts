import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding, studioAnalysisRuntime, studioAnalysisOutputSchema, StudioAnalysisTaskSchema, type StudioAnalysisTaskCreate, type StudioAnalysisTask } from "@better-me/agent-contracts";
import { AgentTaskKernel, CareerTaskError, type CareerTaskRuntime } from "../src/kernel/service.js";
import { readPrivateJson } from "../src/identity/private-json.js";
import { careerTaskProtocol } from "../src/kernel/model-protocol.js";

const access = { session: "synthetic-studio-session", valid: async () => true }, runtime = studioAnalysisRuntime("synthetic-studio-model");
const contract = { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 100000 }, ids: { type: "array", maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["source-a", "source-b"] } } }, required: ["text", "ids"] };
const input = (key = "synthetic-studio-analysis"): StudioAnalysisTaskCreate => ({ kind: "studio_analysis", workspaceKey: "studio-analysis:shared-workspace", rootScopeKey: "shared-workspace", objective: "完整合成分析",
  request: { contextId: "synthetic-context", idempotencyKey: key, consent: true, runtime: { model: runtime.modelSettings.model, modelDigest: "a".repeat(64) }, purpose: "architecture_question", payload: { contract, data: "  完整原文😀\r\n" + "保留输入。".repeat(4000) + "END  " } }, runtimeBinding: careerRuntimeBinding(runtime), consent: true, idempotencyKey: key });
const command = (task: StudioAnalysisTask) => ({ expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding: task.runtimeBinding, consent: true as const });
async function settled(kernel: AgentTaskKernel, id: string) { for (let i = 0; i < 400; i++) { const task = StudioAnalysisTaskSchema.parse(await kernel.readTask(id)); if (task.status !== "running") return task; await delay(5); } throw Error("analysis did not settle"); }
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-studio-analysis-")); let valid = true, checks = 0;
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-studio-owner", directory, validateStudioAnalysis: async () => { checks++; if (!valid) throw new CareerTaskError("studio_context_stale"); } });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  return { kernel, directory, revoke: () => { valid = false; }, checks: () => checks };
}

test("frozen schema vocabulary enforces nested bounds, IDs, uniqueness, strict keys and rejects unsupported grammar before dispatch", () => {
  const schema = studioAnalysisOutputSchema(contract); assert.deepEqual(schema.parse({ text: "完整", ids: ["source-a"] }), { text: "完整", ids: ["source-a"] });
  for (const value of [{ text: "x", ids: ["unknown"] }, { text: "x", ids: ["source-a", "source-a"] }, { text: "x", ids: [], hidden: true }, { ids: [] }]) assert.equal(schema.safeParse(value).success, false);
  for (const value of [{ ...contract, $ref: "https://example.invalid/schema" }, { ...contract, properties: { x: { type: "string", pattern: ".*" } } }, { ...contract, required: ["missing"] }, { ...contract, additionalProperties: true }]) assert.throws(() => studioAnalysisOutputSchema(value));
  const protocol = careerTaskProtocol("studio_analysis", undefined, contract); assert.deepEqual(protocol.jsonSchema, contract);
  assert.throws(() => careerTaskProtocol("studio_analysis"), /analysis_contract_phase_mismatch/);
  assert.throws(() => careerTaskProtocol("free_chat", undefined, contract), /analysis_contract_phase_mismatch/);
});

test("actual kernel keeps complete data/output, purpose contract, root charges and no tools/business adoption", async t => {
  const f = await fixture(t), data = input(); let calls = 0, task = StudioAnalysisTaskSchema.parse(await f.kernel.createTask(data, access));
  const output = { text: "  完整答复😀\r\n" + "全文".repeat(40000) + "END  ", ids: ["source-a"] };
  await f.kernel.run(task.id, "start", command(task), { runtimeFingerprint: "same", reasoner: async (prompt, _signal, phase, _images, _source, selected) => {
    calls++; assert.equal(phase, "studio_analysis"); assert.deepEqual(selected, contract); assert.ok(prompt.includes(JSON.stringify(data.request.payload.data))); return JSON.stringify(output);
  } }, access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "completed", task.error); assert.deepEqual(task.result?.output, output); assert.equal(task.result?.adopted, false);
  assert.equal(task.rootLedger?.usage.modelCalls, 1); assert.equal(task.usage.toolCalls, 0); assert.ok(f.checks() >= 4);
  assert.equal((await f.kernel.createTask(data, access)).id, task.id); assert.equal(calls, 1);
  await assert.rejects(f.kernel.fact(task.id, task.revision, "不能采用", ["source-a"], access), /task_kind_not_supported/);
});

test("invalid JSON contract output is retained and repaired only inside the original root budget", async t => {
  const f = await fixture(t), data = input(); data.budget = { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60000 };
  let calls = 0, task = StudioAnalysisTaskSchema.parse(await f.kernel.createTask(data, access)); const bad = JSON.stringify({ text: "不允许的引证", ids: ["invented"] });
  const execution: CareerTaskRuntime = { runtimeFingerprint: "same", reasoner: async prompt => { calls++; if (calls === 1) return bad; assert.ok(prompt.includes(JSON.stringify(bad).slice(1, -1))); return JSON.stringify({ text: "修复", ids: [] }); } };
  await f.kernel.run(task.id, "start", command(task), execution, access); task = await settled(f.kernel, task.id);
  assert.equal(task.status, "completed", task.error); assert.equal(task.rootLedger?.usage.modelCalls, 2); assert.equal(calls, 2);
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: { output?: string }[] }; assert.ok(stored.recent.some(item => item.output === bad));
  await assert.rejects(f.kernel.createTask(input("another-analysis"), access), /model_call_budget/); assert.equal(calls, 2);
});

test("revoked authority rejects late adoption after preserving the complete wire and original charge", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), late = Promise.withResolvers<string>(); let task = StudioAnalysisTaskSchema.parse(await f.kernel.createTask(input(), access));
  await f.kernel.run(task.id, "start", command(task), { runtimeFingerprint: "same", reasoner: async () => { entered.resolve(); return late.promise; } }, access);
  await entered.promise; f.revoke(); const output = JSON.stringify({ text: "晚结果完整保留", ids: [] }); late.resolve(output);
  task = await settled(f.kernel, task.id); assert.equal(task.error, "studio_context_stale"); assert.equal(task.result, undefined); assert.equal(task.usage.modelCalls, 1);
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: { output?: string }[] }; assert.ok(stored.recent.some(item => item.output === output));
  await assert.rejects(f.kernel.run(task.id, "resume", command(task), { runtimeFingerprint: "same", reasoner: async () => output }, access), /studio_context_stale/);
});

test("incomplete and oversized replies remain full; explicit stop fences late results; reads do not replay", async t => {
  const f = await fixture(t); let task = StudioAnalysisTaskSchema.parse(await f.kernel.createTask(input(), access)), calls = 0;
  const raw = JSON.stringify({ text: "未完成😀", ids: [] });
  await f.kernel.run(task.id, "start", command(task), { runtimeFingerprint: "same", reasoner: async () => { calls++; return { text: raw, finishReason: "length" }; } }, access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "paused"); assert.equal(task.partialOutput?.text, raw); await f.kernel.readTask(task.id); assert.equal(calls, 1);
  const huge = "完整原文😀\r\n".repeat(30000) + "TAIL";
  await f.kernel.run(task.id, "resume", command(task), { runtimeFingerprint: "same", reasoner: async () => { calls++; return huge; } }, access);
  task = await settled(f.kernel, task.id); assert.equal(task.error, "decision_output_budget"); assert.equal((await f.kernel.readOutput(task.id, task.outputArtifacts![0]!.id)).text, huge);
  let stopped = StudioAnalysisTaskSchema.parse(await f.kernel.createTask(input("stopped-analysis"), access)); const entered = Promise.withResolvers<void>(), late = Promise.withResolvers<string>();
  await f.kernel.run(stopped.id, "start", command(stopped), { runtimeFingerprint: "same", reasoner: async () => { entered.resolve(); return late.promise; } }, access); await entered.promise;
  stopped = StudioAnalysisTaskSchema.parse(await f.kernel.readTask(stopped.id)); await f.kernel.stop(stopped.id, stopped.revision, false, access); late.resolve(raw); await delay(10);
  stopped = StudioAnalysisTaskSchema.parse(await f.kernel.readTask(stopped.id)); assert.equal(stopped.status, "paused"); assert.equal(stopped.result, undefined); assert.equal(stopped.usage.modelCalls, 1);
});

test("missing authority and unknown contract cannot open a new independent executor", async t => {
  const f = await fixture(t), unsafe = input(); unsafe.request.payload.contract = { type: "object", $ref: "anything" };
  await assert.rejects(f.kernel.createTask(unsafe, access), /invalid_studio_output_contract/);
  f.revoke(); await assert.rejects(f.kernel.createTask(input(), access), /studio_context_stale/);
});
