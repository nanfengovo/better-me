import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StudioCommitteeTaskSchema, careerRuntimeBinding, studioAnalysisRuntime, type StudioCommitteeTaskCreate, type StudioCommitteeTask } from "@better-me/agent-contracts";
import type { StudioContext } from "@better-me/agent-contracts/career-studio";
import { createAgentServer } from "../src/server.js";
import { MemorySaver } from "./fixtures/checkpointer.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import type { CareerTaskReasoner } from "../src/kernel/model-protocol.js";

const selected = { model: "synthetic-committee-http", modelDigest: "a".repeat(64) }, runtime = studioAnalysisRuntime(selected.model), scope = "synthetic-committee-workspace";
async function setup(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-committee-http-"))), sourceRoot = path.join(directory, "synthetic-source");
  await mkdir(sourceRoot); const sourceFile = path.join(sourceRoot, "lease.ts"), sourceText = "export const lease = '完整合成源码😀';\r\n// 私有源码不进入目录\r\n";
  await writeFile(sourceFile, sourceText); await writeFile(path.join(sourceRoot, "recovery.ts"), "export const recovery = true;\n");
  let calls = 0, adapters = 0, legacyCalls = 0, metadataDigest = selected.modelDigest;
  const reasoner: CareerTaskReasoner = async (prompt, _signal, phase, _images, _source, contract) => {
    calls++; if (phase === "free_chat") return JSON.stringify({ kind: "reply", content: "合成根已建立" });
    assert.equal(phase, "studio_committee"); assert.ok(contract);
    const assessment = Array.isArray(contract["anyOf"]) ? contract["anyOf"][0] as Record<string, unknown> : contract;
    const properties = assessment["properties"] as Record<string, { const: string; prefixItems?: Array<{ properties: Record<string, { const: unknown }> }> }>;
    if (properties["kind"]!.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: properties["requests"]!.prefixItems!.map(item => Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, value.const]))) });
    const snapshot = JSON.parse(prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: Array<{ id: string }> };
    return JSON.stringify({ kind: "assessment", role: prompt.match(/Role=(\w+);/)![1], summary: "合成审查，不是事实认证。", claims: snapshot.claims.map(claim => ({ claimId: claim.id, support: "unknown", citations: [], counterCitations: [], risks: [], missing: ["个人行动未知"], questions: ["请说明你实际承担的动作。"], defense: [] })) });
  };
  const server = createAgentServer({ host: "127.0.0.1", port: 0, allowedOrigins: [], authToken: "synthetic-committee-token", identityDirectory: path.join(directory, "identity"), runtimeDefinitions: [], checkpointer: new MemorySaver() as never,
    careerTaskReasoner: async () => { adapters++; return reasoner; }, careerStudioLocalClient: () => ({ binding: async () => ({ id: "synthetic-metadata", version: "synthetic-v1", location: "local", endpointFingerprint: "c".repeat(64), ...selected, modelDigest: metadataDigest }),
      complete: async () => { legacyCalls++; throw Error("kernel must not call the legacy Studio completion"); } }) });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const identity = await registerTestIdentity(base, "synthetic-committee-token", "synthetic-committee-owner");
  t.after(async () => { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); });
  const request = async (route: string, body?: unknown, headers = identity.headers) => {
    const response = await fetch(base + "/api/v1/agent" + route, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json", Authorization: "Bearer synthetic-committee-token" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const result = await request("/career-studio/context/create", { workspaceKey: scope, resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64), consent: true,
    claims: [{ id: "claim-a", text: "参与本地模块设计。", contribution: "design", confirmedByUser: false, confirmedNumericTokens: [], skillIds: [] }], jobs: [] }); assert.equal(result.status, 200);
  const context = result.data.context as StudioContext;
  assert.equal((await request("/career-studio/runtime/select", { contextId: context.id, runtime: selected, consent: true })).status, 200);
  const input = (key = "committee-http-request"): StudioCommitteeTaskCreate => ({ kind: "studio_committee", workspaceKey: `studio-committee:${scope}`, rootScopeKey: scope, objective: "合成委员会审查",
    request: { contextId: context.id, idempotencyKey: key, consent: true, runtime: selected, claimIds: ["claim-a"], statements: [{ label: "合成设计", kind: "design", text: "  原始资料😀\r\n保留个人行动未知。\r\nTAIL  " }], code: [] },
    runtimeBinding: careerRuntimeBinding(runtime), budget: { maxModelCalls: 20, maxToolCalls: 50, maxActiveMs: 60000 }, consent: true, idempotencyKey: key });
  const start = (task: StudioCommitteeTask, rt = runtime) => request(`/tasks/${task.id}/start`, { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding: task.runtimeBinding, consent: true, runtime: rt });
  const settled = async (id: string) => { for (let i = 0; i < 1000; i++) { const task = StudioCommitteeTaskSchema.parse((await request(`/tasks/${id}`)).data.task); if (task.status !== "running") return task; await delay(5); } throw Error("HTTP committee did not settle"); };
  return { request, input, start, settled, context, identity, base, sourceRoot, sourceFile, sourceText, counts: () => ({ calls, adapters, legacyCalls }), changeDigest: () => { metadataDigest = "d".repeat(64); } };
}

test("authenticated task HTTP executes all committee roles through the existing owner adapter, not legacy local completion", async t => {
  const f = await setup(t), data = f.input();
  const created = await f.request("/tasks", data); assert.equal(created.status, 201); let task = StudioCommitteeTaskSchema.parse(created.data.task);
  assert.equal((await f.start(task)).status, 202); task = await f.settled(task.id);
  assert.equal(task.status, "completed", task.error); assert.equal(task.result?.roles.length, 7); assert.equal(task.rootLedger?.usage.modelCalls, 14); assert.equal(task.rootLedger?.usage.toolCalls, 7);
  assert.deepEqual(f.counts(), { calls: 14, adapters: 1, legacyCalls: 0 });
  assert.equal((await f.request(`/tasks/${task.id}/committee/current`)).status, 200);
  const replay = await f.request("/tasks", data); assert.ok([200, 201].includes(replay.status)); assert.equal((replay.data.task as StudioCommitteeTask).id, task.id); assert.equal(f.counts().calls, 14);
  f.changeDigest(); const stale = await f.request(`/tasks/${task.id}/committee/current`); assert.equal(stale.status, 409); assert.equal(stale.data.error, "local_runtime_changed"); assert.equal(f.counts().calls, 14);
});

test("actual authenticated HTTP rejects another owner, forged scope, digest drift and a different runtime without dispatch", async t => {
  const f = await setup(t), forged = f.input(); forged.rootScopeKey = "forged-workspace";
  assert.equal((await f.request("/tasks", forged)).status, 403);
  const created = await f.request("/tasks", f.input()); const task = StudioCommitteeTaskSchema.parse(created.data.task);
  const wrongRuntime = { ...runtime, modelSettings: { ...runtime.modelSettings, temperature: 0.3 } }; const wrong = await f.start(task, wrongRuntime);
  assert.ok([409, 422].includes(wrong.status)); assert.equal(f.counts().calls, 0);
  const other = await registerTestIdentity(f.base, "synthetic-committee-token", "synthetic-other-owner");
  assert.equal((await f.request(`/tasks/${task.id}/committee/current`, undefined, other.headers)).status, 404);
  const foreign = await f.request("/tasks", f.input("other-owner-request"), other.headers); assert.equal(foreign.status, 409); assert.equal(foreign.data.error, "studio_context_stale");
  f.changeDigest(); const drift = await f.start(task); assert.equal(drift.status, 409); assert.equal(drift.data.error, "local_runtime_changed"); assert.equal(f.counts().calls, 0); assert.equal(f.counts().legacyCalls, 0);
});

test("completed task reads recheck revoked context and cannot use an old cached committee as current", async t => {
  const f = await setup(t); let task = StudioCommitteeTaskSchema.parse((await f.request("/tasks", f.input())).data.task);
  assert.equal((await f.start(task)).status, 202); task = await f.settled(task.id); assert.equal(task.status, "completed");
  assert.equal((await f.request("/career-studio/context/revoke", { contextId: f.context.id })).status, 200);
  const current = await f.request(`/tasks/${task.id}/committee/current`); assert.equal(current.status, 409); assert.equal(current.data.error, "studio_context_stale");
  assert.equal((await f.request(`/tasks/${task.id}`)).status, 200); assert.equal(f.counts().calls, 14); assert.equal(f.counts().legacyCalls, 0);
});

test("actual authenticated legacy committee route is retired before parsing/runtime selection and cannot dispatch", async t => {
  const f = await setup(t);
  for (const body of [f.input().request, { unexpected: true }, { ...f.input().request, runtime: { model: "forged", modelDigest: "f".repeat(64) } }]) {
    const response = await f.request("/career-studio/committee/start", body);
    assert.equal(response.status, 410); assert.equal(response.data.error, "studio_committee_moved_to_agent_tasks");
  }
  const unauthenticated = await f.request("/career-studio/committee/start", {}, {});
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual((await f.request("/tasks")).data.tasks, []);
  assert.deepEqual(f.counts(), { calls: 0, adapters: 0, legacyCalls: 0 });
});

test("actual owner kernel supplies privacy metadata without free reads; selected reuse is charged once per original source, same root", async t => {
  const f = await setup(t), data = f.input(); data.budget!.maxToolCalls = 500;
  data.request.code = [{ root: f.sourceRoot, files: [{ path: "lease.ts", startLine: 1, endLine: 2 }, { path: "recovery.ts", startLine: 1, endLine: 1 }] }];
  const catalog = () => f.request("/career-studio/privacy/local/catalog", { contextId: f.context.id });
  assert.deepEqual((await catalog()).data.sources, []);
  let task = StudioCommitteeTaskSchema.parse((await f.request("/tasks", data)).data.task);
  assert.equal((await f.start(task)).status, 202); task = await f.settled(task.id); assert.equal(task.status, "completed", task.error);
  const used = task.usage.toolCalls, first = await catalog(); assert.equal(first.status, 200);
  type Choice = { operationId: string; evidenceId: string; path: string };
  const choices = first.data.sources as Choice[]; assert.equal(choices.length, 2); assert.ok(choices.every(choice => choice.operationId === task.id));
  assert.ok(!JSON.stringify(first.data).includes("完整合成源码")); assert.ok(!JSON.stringify(first.data).includes(f.sourceRoot));
  await catalog(); task = StudioCommitteeTaskSchema.parse((await f.request(`/tasks/${task.id}`)).data.task); assert.equal(task.usage.toolCalls, used, "metadata never rereads or adopts source bodies");
  const body = { contextId: f.context.id, expectedRevision: 0, selections: choices.map(({ operationId, evidenceId }) => ({ operationId, evidenceId })), privateTerms: [], consent: true };
  const selectedSources = await f.request("/career-studio/privacy/local/configure", body); assert.equal(selectedSources.status, 200, JSON.stringify(selectedSources.data)); assert.equal(selectedSources.data.revision, 1);
  task = StudioCommitteeTaskSchema.parse((await f.request(`/tasks/${task.id}`)).data.task);
  assert.equal(task.usage.toolCalls, used + 2, "both selections share one metered fresh review, not two all-source rereads");
  const metadata = await f.request("/career-studio/privacy/context", { contextId: f.context.id }); assert.equal(metadata.status, 200, JSON.stringify(metadata.data)); assert.equal(metadata.data.localOnlySourceCount, 2);
  task = StudioCommitteeTaskSchema.parse((await f.request(`/tasks/${task.id}`)).data.task); assert.equal(task.usage.toolCalls, used + 4);
  assert.equal(task.rootLedger?.rootTaskId, task.id); assert.deepEqual(f.counts(), { calls: 14, adapters: 1, legacyCalls: 0 });
  await writeFile(f.sourceFile, "changed source\n// changed\n");
  const stale = await f.request("/career-studio/privacy/local/configure", { ...body, expectedRevision: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.data.error, "studio_source_changed"); assert.equal((await catalog()).data.revision, 1);
  await writeFile(f.sourceFile, f.sourceText);
  task = StudioCommitteeTaskSchema.parse((await f.request(`/tasks/${task.id}`)).data.task);
  const ceiling = task.rootLedger!.usage.toolCalls;
  assert.equal((await f.request(`/tasks/${task.id}/budget`, { expectedRevision: task.revision, consent: true, budget: { maxModelCalls: 20, maxToolCalls: ceiling, maxActiveMs: 60000 } })).status, 200);
  const denied = await f.request("/career-studio/privacy/local/configure", { ...body, expectedRevision: 1 }); assert.equal(denied.status, 409); assert.equal(denied.data.error, "tool_call_budget");
  task = StudioCommitteeTaskSchema.parse((await f.request(`/tasks/${task.id}`)).data.task); assert.equal(task.rootLedger?.usage.toolCalls, ceiling);
  assert.equal((await catalog()).data.revision, 1); assert.deepEqual(f.counts(), { calls: 14, adapters: 1, legacyCalls: 0 });
});

test("privacy reuse rejects foreign selection, local digest drift and revoked current context without another model call", async t => {
  const f = await setup(t), data = f.input(); data.budget!.maxToolCalls = 500;
  data.request.code = [{ root: f.sourceRoot, files: [{ path: "lease.ts", startLine: 1, endLine: 2 }] }];
  let task = StudioCommitteeTaskSchema.parse((await f.request("/tasks", data)).data.task); await f.start(task); task = await f.settled(task.id); assert.equal(task.status, "completed");
  const catalog = await f.request("/career-studio/privacy/local/catalog", { contextId: f.context.id });
  const choices = (catalog.data.sources as Array<{ operationId: string; evidenceId: string }>).map(({ operationId, evidenceId }) => ({ operationId, evidenceId }));
  const body = { contextId: f.context.id, expectedRevision: 0, selections: choices, privateTerms: [], consent: true };
  const forged = await f.request("/career-studio/privacy/local/configure", { ...body, selections: [{ ...choices[0], evidenceId: "ungranted" }] }); assert.equal(forged.status, 403); assert.equal(forged.data.error, "privacy_source_not_originally_authorized");
  const other = await registerTestIdentity(f.base, "synthetic-committee-token", "synthetic-other-privacy-owner");
  assert.equal((await f.request("/career-studio/privacy/local/configure", body, other.headers)).status, 409);
  f.changeDigest(); const drift = await f.request("/career-studio/privacy/local/configure", body); assert.equal(drift.status, 409); assert.equal(drift.data.error, "local_runtime_changed");
  assert.equal((await f.request("/career-studio/context/revoke", { contextId: f.context.id })).status, 200);
  assert.equal((await f.request("/career-studio/privacy/local/configure", body)).status, 409);
  assert.deepEqual(f.counts(), { calls: 14, adapters: 1, legacyCalls: 0 });
});
