import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding, studioAnalysisRuntime, StudioCommitteeTaskSchema, type StudioCommitteeTaskCreate, type StudioCommitteeTask } from "@better-me/agent-contracts";
import type { StudioContext } from "@better-me/agent-contracts/career-studio";
import { AgentTaskKernel, CareerTaskError, type CareerTaskRuntime } from "../src/kernel/service.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { readPrivateJson } from "../src/identity/private-json.js";
import { digest } from "../src/tasks/evidence.js";
import { careerTaskProtocol, type CareerTaskReasoner } from "../src/kernel/model-protocol.js";

const access = { session: "synthetic-committee-session", valid: async () => true }, runtime = studioAnalysisRuntime("synthetic-committee-model");
const statement = "  完整证据😀\r\n" + "来源只证明本地合成设计，不证明个人主导或生产部署。".repeat(60) + "\r\n完整结尾  ";
const context: StudioContext = { id: "synthetic-context", ownerId: "synthetic-committee-owner", workspaceKey: "synthetic-workspace", resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64),
  claims: [{ id: "claim-a", text: "参与本地合成模块设计。", skillIds: [], contribution: "design", confirmedByUser: false, confirmedNumericTokens: [] }], jobs: [], session: access.session,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), revoked: false };
const input = (key = "synthetic-committee-request"): StudioCommitteeTaskCreate => ({ kind: "studio_committee", workspaceKey: `studio-committee:${context.workspaceKey}`, rootScopeKey: context.workspaceKey,
  objective: "按证据完成四角色审查", request: { contextId: context.id, idempotencyKey: key, consent: true, runtime: { model: runtime.modelSettings.model, modelDigest: "a".repeat(64) },
    claimIds: ["claim-a"], statements: [{ kind: "design", label: "完整合成资料", text: statement }], code: [] }, runtimeBinding: careerRuntimeBinding(runtime), consent: true, idempotencyKey: key,
  budget: { maxModelCalls: 20, maxToolCalls: 50, maxActiveMs: 60000 } });
const command = (task: StudioCommitteeTask) => ({ expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding: task.runtimeBinding, consent: true as const });
async function settled(kernel: AgentTaskKernel, id: string) { for (let i = 0; i < 1000; i++) { const task = StudioCommitteeTaskSchema.parse(await kernel.readTask(id)); if (task.status !== "running") return task; await delay(5); } throw Error("committee did not settle"); }
async function fixture(t: TestContext, broker?: EvidenceBroker) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-committee-kernel-"))); let valid = true, checks = 0;
  const options = { ownerId: context.ownerId, directory, broker, validateStudioCommittee: async (task: StudioCommitteeTask) => {
    checks++; if (!valid) throw new CareerTaskError("studio_context_stale");
    if (task.rootScopeKey !== context.workspaceKey || task.workspaceKey !== `studio-committee:${context.workspaceKey}`) throw new CareerTaskError("studio_task_scope_mismatch", 403);
    return context;
  } };
  const kernel = new AgentTaskKernel(options);
  const kernels = [kernel], track = (next: AgentTaskKernel) => { kernels.push(next); return next; };
  t.after(async () => { for (const current of kernels) await current.close(); await rm(directory, { recursive: true, force: true }); });
  return { kernel, directory, options, track, revoke: () => { valid = false; }, checks: () => checks };
}
const scripted: CareerTaskReasoner = async (prompt, _signal, phase, _images, _source, schema) => {
  assert.equal(phase, "studio_committee"); assert.ok(schema); const assessment = Array.isArray(schema["anyOf"]) ? schema["anyOf"][0] as Record<string, unknown> : schema;
  const properties = assessment["properties"] as Record<string, { const: string; prefixItems?: Array<{ properties: Record<string, { const: unknown }> }> }>;
  if (properties["kind"]!.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: properties["requests"]!.prefixItems!.map(item => Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, value.const]))) });
  const snapshot = JSON.parse(prompt.split("\n").find(line => line.startsWith("SELECTED_SNAPSHOT="))!.slice("SELECTED_SNAPSHOT=".length)) as { claims: Array<{ id: string }> };
  return JSON.stringify({ kind: "assessment", role: /Role=(\w+);/.exec(prompt)![1], summary: "保留未知；审查不是事实认证。", claims: snapshot.claims.map(claim => ({ claimId: claim.id, support: "unknown", citations: [], counterCitations: [], risks: [], missing: ["个人归属待本人确认"], questions: ["你实际承担的设计动作是什么？"], defense: [] })) });
};
const execution = (reasoner = scripted): CareerTaskRuntime => ({ runtimeFingerprint: "same-owner-runtime", reasoner });

test("four independent roles, cross reviews and final review execute inside the kernel with exact model/read charges and complete wire", async t => {
  const f = await fixture(t); let calls = 0, task = await f.kernel.createTask(input(), access);
  await f.kernel.run(task.id, "start", command(task), execution(async (...args) => { calls++; return scripted(...args); }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "completed", task.error); assert.equal(calls, 14); assert.equal(task.usage.modelCalls, 14); assert.equal(task.usage.toolCalls, 7);
  assert.equal(task.result?.roles.length, 7); assert.equal(task.result?.status, "completed"); assert.equal(task.result?.claims[0]?.contribution, "unknown"); assert.ok(f.checks() > 20);
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: Array<{ prompt?: string; output?: string }>; committeeState: { snapshot: { evidence: Array<{ excerpt: string }> }; completed: unknown[] } };
  assert.equal(stored.committeeState.snapshot.evidence[0]?.excerpt, statement); assert.equal(stored.committeeState.completed.length, 14);
  assert.ok(stored.recent.some(row => row.prompt?.includes(JSON.stringify(statement.split(/\r?\n/).join("\n")).slice(1, -1))));
  assert.equal(stored.recent.filter(row => row.output !== undefined).length, 14);
  await f.kernel.currentStudioCommittee(task.id, access); await f.kernel.readTask(task.id); assert.equal(calls, 14);
  await assert.rejects(f.kernel.fact(task.id, task.revision, "不自动采用", ["statement-1"], access), /task_kind_not_supported/);
});

test("committee inherits the prior chat root's ceiling, cannot spend a fresh allowance and stops before the next role call", async t => {
  const f = await fixture(t), data = input();
  const parent = await f.kernel.createTask({ kind: "free_chat", workspaceKey: "prior-chat", rootScopeKey: context.workspaceKey, objective: "已有会话",
    conversation: { messages: [{ id: "user-first", role: "user", content: "不共享给委员会的私有旧聊天" }] }, runtimeBinding: data.runtimeBinding, budget: { maxModelCalls: 4, maxToolCalls: 50, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-prior-chat" }, access);
  await f.kernel.run(parent.id, "start", { expectedRevision: parent.revision, sourceFingerprint: parent.sourceFingerprint, runtimeBinding: parent.runtimeBinding, consent: true }, execution(async () => JSON.stringify({ kind: "reply", content: "已记录" })), access);
  for (let i = 0; i < 300 && (await f.kernel.readTask(parent.id)).status === "running"; i++) await delay(5);
  delete data.budget; let task = await f.kernel.createTask(data, access), calls = 0;
  assert.equal(task.rootTaskId, parent.id); assert.equal(task.budget.maxModelCalls, 4);
  await f.kernel.run(task.id, "start", command(task), execution(async (...args) => { calls++; assert.ok(!args[0].includes("不共享给委员会的私有旧聊天")); return scripted(...args); }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "budget_exhausted"); assert.equal(task.error, "model_call_budget"); assert.equal(calls, 3); assert.equal(task.rootLedger?.usage.modelCalls, 4);
  assert.notEqual(task.result?.status, "completed"); await assert.rejects(f.kernel.createTask({ ...input("another-committee"), budget: undefined }, access), /model_call_budget/);
});

test("explicit resume replays only complete matching wire locally and charges the incomplete pending call again; reads never infer", async t => {
  const f = await fixture(t); let task = await f.kernel.createTask(input(), access), calls = 0;
  const run = execution(async (...args) => { calls++; if (calls === 4) return { text: "  未完成原文😀\r\nTAIL  ", finishReason: "length" }; return scripted(...args); });
  await f.kernel.run(task.id, "start", command(task), run, access); task = await settled(f.kernel, task.id);
  assert.equal(task.status, "paused", task.error); assert.equal(task.partialOutput?.text, "  未完成原文😀\r\nTAIL  "); assert.equal(calls, 4);
  await f.kernel.readTask(task.id); assert.equal(calls, 4);
  await f.kernel.run(task.id, "resume", command(task), run, access); task = await settled(f.kernel, task.id);
  assert.equal(task.status, "completed", task.error); assert.equal(calls, 15); assert.equal(task.rootLedger?.usage.modelCalls, 15); assert.equal(task.partialOutput, undefined);
});

test("denied frozen reads still spend the root tool budget and cannot expand evidence scope", async t => {
  const f = await fixture(t), data = input(); data.budget!.maxToolCalls = 1; let task = await f.kernel.createTask(data, access), calls = 0;
  await f.kernel.run(task.id, "start", command(task), execution(async () => { calls++; return JSON.stringify({ kind: "request_evidence", requests: [{ evidenceId: "ungranted", startLine: 1, endLine: 1 }] }); }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "budget_exhausted"); assert.equal(task.error, "tool_call_budget"); assert.equal(task.usage.toolCalls, 1); assert.equal(calls, 2); assert.notEqual(task.result?.status, "completed");
});

test("after the initial eight reads the kernel grammar still permits exact additional authorized evidence, charged to the same root", async t => {
  const f = await fixture(t), data = input(); data.request.statements = Array.from({ length: 10 }, (_, index) => ({ kind: "design", label: `证据${index + 1}`, text: `第${index + 1}份完整设计原文` }));
  data.budget = { maxModelCalls: 30, maxToolCalls: 100, maxActiveMs: 60000 }; let calls = 0, extra = false, task = await f.kernel.createTask(data, access);
  await f.kernel.run(task.id, "start", command(task), execution(async (...args) => {
    calls++; const [prompt, , , , , schema] = args;
    if (!extra && /Role=recruiter;/.test(prompt) && Array.isArray(schema?.["anyOf"])) {
      const branch = schema["anyOf"][1] as { properties: { requests: { items: { properties: { evidenceId: { enum: string[] } } } } } };
      assert.ok(branch.properties.requests.items.properties.evidenceId.enum.includes("statement-10")); assert.ok(prompt.includes('"id":"statement-10"'));
      extra = true; return JSON.stringify({ kind: "request_evidence", requests: [{ evidenceId: "statement-10", startLine: 1, endLine: 1 }] });
    }
    if (extra && /Role=recruiter;/.test(prompt) && prompt.includes("HOST_CITATION_CATALOG=")) assert.ok(prompt.includes("第10份完整设计原文"));
    return scripted(...args);
  }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.status, "completed", task.error); assert.equal(extra, true); assert.equal(calls, 15); assert.equal(task.usage.modelCalls, 15); assert.equal(task.usage.toolCalls, 57);
});

test("malformed output stays complete and its repair cannot escape the exhausted original root", async t => {
  const f = await fixture(t), data = input(); data.budget!.maxModelCalls = 1;
  let task = await f.kernel.createTask(data, access), calls = 0; const malformed = "  非JSON完整回复😀\r\n" + "保留".repeat(20000) + "TAIL  ";
  const run = execution(async (...args) => { calls++; return calls === 1 ? malformed : scripted(...args); });
  await f.kernel.run(task.id, "start", command(task), run, access); task = await settled(f.kernel, task.id);
  assert.equal(task.status, "budget_exhausted"); assert.equal(task.error, "model_call_budget"); assert.equal(calls, 1);
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: Array<{ output?: string }> }; assert.ok(stored.recent.some(row => row.output === malformed));
  task = StudioCommitteeTaskSchema.parse(await f.kernel.budget(task.id, task.revision, { maxModelCalls: 20, maxToolCalls: 50, maxActiveMs: 60000 }, access));
  assert.equal(task.usage.modelCalls, 1); await f.kernel.run(task.id, "resume", command(task), run, access); task = await settled(f.kernel, task.id);
  assert.equal(task.status, "completed", task.error); assert.equal(calls, 14); assert.equal(task.usage.modelCalls, 14);
});

test("explicit pause fences a late committee result and reopening the task does not start another role", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), late = Promise.withResolvers<string>(); let task = await f.kernel.createTask(input(), access), calls = 0;
  await f.kernel.run(task.id, "start", command(task), execution(async () => { calls++; entered.resolve(); return late.promise; }), access);
  await entered.promise; task = StudioCommitteeTaskSchema.parse(await f.kernel.readTask(task.id));
  const output = JSON.stringify({ kind: "request_evidence", requests: [{ evidenceId: "statement-1", startLine: 1, endLine: 3 }] });
  await f.kernel.stop(task.id, task.revision, false, access); late.resolve(output); await delay(30);
  task = StudioCommitteeTaskSchema.parse(await f.kernel.readTask(task.id)); assert.equal(task.status, "paused"); assert.equal(task.result, undefined); assert.equal(task.usage.modelCalls, 1); assert.equal(calls, 1);
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: Array<{ output?: string; late?: boolean }> }; assert.ok(stored.recent.some(row => row.output === output && row.late === true));
});

test("context revoked during a send keeps full raw output but rejects adoption and any following role", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), late = Promise.withResolvers<string>(); let task = await f.kernel.createTask(input(), access), calls = 0;
  await f.kernel.run(task.id, "start", command(task), execution(async () => { calls++; entered.resolve(); return late.promise; }), access);
  await entered.promise; f.revoke(); const output = "  撤权后的完整回复😀\r\n" + "不能采用".repeat(4000) + "TAIL  "; late.resolve(output);
  task = await settled(f.kernel, task.id); assert.equal(task.error, "studio_context_stale"); assert.equal(calls, 1); assert.notEqual(task.result?.status, "completed");
  const stored = await readPrivateJson(path.join(f.directory, `${task.id}.json`)) as { recent: Array<{ output?: string }> }; assert.ok(stored.recent.some(row => row.output === output));
  await assert.rejects(f.kernel.currentStudioCommittee(task.id, access), /studio_context_stale/);
});

test("source grant/read/revalidation are real charged broker operations and a changed source stops the next model", async t => {
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-committee-source-"))); t.after(() => rm(project, { recursive: true, force: true }));
  // Copy a public synthetic fixture, not a personal project or source file.
  const source = await readFile(new URL("./fixtures/checkpointer.ts", import.meta.url), "utf8");
  const { writeFile } = await import("node:fs/promises"); await writeFile(path.join(project, "source.ts"), source);
  const broker = new EvidenceBroker(), f = await fixture(t, broker), data = input(); data.request.code = [{ root: project, files: [{ path: "source.ts", startLine: 1, endLine: 2 }] }];
  let task = await f.kernel.createTask(data, access), calls = 0;
  await f.kernel.run(task.id, "start", command(task), execution(async (...args) => { calls++; await writeFile(path.join(project, "source.ts"), source + "\n// changed synthetic version\n"); return scripted(...args); }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.error, "studio_source_changed"); assert.equal(calls, 1); assert.equal(task.usage.modelCalls, 1); assert.ok(task.usage.toolCalls >= 5); assert.notEqual(task.result?.status, "completed");
});

test("oversized wire remains complete in a private artifact; host reopen does not infer and explicit resume reuses completed turns", async t => {
  const f = await fixture(t); let task = await f.kernel.createTask(input(), access), calls = 0; const huge = "完整😀\r\n".repeat(30000) + "TAIL";
  await f.kernel.run(task.id, "start", command(task), execution(async (...args) => { calls++; return calls === 2 ? huge : scripted(...args); }), access);
  task = await settled(f.kernel, task.id); assert.equal(task.error, "decision_output_budget"); assert.equal((await f.kernel.readOutput(task.id, task.outputArtifacts![0]!.id)).text, huge); assert.equal(task.usage.modelCalls, 2);
  await f.kernel.close(); const reopened = f.track(new AgentTaskKernel(f.options));
  task = StudioCommitteeTaskSchema.parse(await reopened.readTask(task.id)); assert.equal(calls, 2);
  await reopened.run(task.id, "resume", command(task), execution(async (...args) => { calls++; return scripted(...args); }), access); task = await settled(reopened, task.id);
  assert.equal(task.status, "completed", task.error); assert.equal(calls, 15); assert.equal(task.usage.modelCalls, 15);
});

test("committee protocol is Host-selected, preserves exact grammar, and missing authority cannot dispatch", async t => {
  const f = await fixture(t); const grammar = { type: "object", properties: { kind: { const: "request_evidence" } } };
  assert.deepEqual(careerTaskProtocol("studio_committee", undefined, grammar).jsonSchema, grammar);
  assert.throws(() => careerTaskProtocol("studio_committee"), /analysis_contract_phase_mismatch/);
  assert.throws(() => careerTaskProtocol("free_chat", undefined, grammar), /analysis_contract_phase_mismatch/);
  const missing = f.track(new AgentTaskKernel({ ownerId: context.ownerId, directory: path.join(f.directory, "missing-authority") }));
  await assert.rejects(missing.createTask(input(), access), /studio_committee_authority_required/);
  const forged = input(); forged.rootScopeKey = "other-scope"; await assert.rejects(f.kernel.createTask(forged, access), /studio_task_scope_mismatch/);
  assert.equal(digest(statement).length, 64);
});
