import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { careerRuntimeBinding, studioAnalysisRuntime, type AgentTask, type StudioCommitteeTask } from "@better-me/agent-contracts";
import { StudioOperationSchema, type StudioOperation } from "@better-me/agent-contracts/career-studio";
import { createAgentServer } from "../../agent-host/src/server";
import type { CareerTaskReasoner } from "../../agent-host/src/kernel/model-protocol";
import { MemorySaver } from "../../agent-host/tests/fixtures/checkpointer";
import { registerTestIdentity } from "../../agent-host/tests/fixtures/identity";
import { activatePrincipal } from "../src/lib/identity";
import { createCareerStudioClient } from "../src/services/career-studio-client";

const dom = new Window({ url: "http://synthetic-committee.invalid" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const scope = "synthetic-committee-client", selected = { model: "synthetic-committee-client-model", modelDigest: "a".repeat(64) }, runtime = studioAnalysisRuntime(selected.model);
const claim = "本人实现本地租约检查；生产部署未知。", statement = "  完整自述😀\r\n" + claim.repeat(40) + "\r\nTAIL  ";
const scripted: CareerTaskReasoner = async (prompt, _signal, phase, _images, _source, schema) => {
  if (phase === "free_chat") return JSON.stringify({ kind: "reply", content: "已有根，不共享聊天资料。" });
  assert.equal(phase, "studio_committee"); assert.ok(schema); assert.ok(!prompt.includes("PRIVATE-PRIOR-CHAT"));
  const assessment = Array.isArray(schema.anyOf) ? schema.anyOf[0] as Record<string, unknown> : schema;
  const properties = assessment.properties as Record<string, { const: string; prefixItems?: Array<{ properties: Record<string, { const: unknown }> }> }>;
  if (properties.kind!.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: properties.requests!.prefixItems!.map(item => Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, value.const]))) });
  const snapshot = JSON.parse(prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!), citations = JSON.parse(prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!);
  return JSON.stringify({ kind: "assessment", role: prompt.match(/Role=(\w+);/)![1], summary: "合成判断，不认证真实经历。", claims: snapshot.claims.map((item: { id: string }) => ({ claimId: item.id, support: "supported", citations,
    counterCitations: [], risks: [], missing: [], questions: ["哪些行为已经实际验证？"], defense: [] })) });
};
async function fixture(t: TestContext, override?: CareerTaskReasoner, maxModelCalls = 30) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-committee-client-"))), source = path.join(directory, "synthetic-source");
  await mkdir(source); const sourceFile = path.join(source, "lease.ts"), text = "export const lease = 'local fixture';\n// 完整选定源码😀\n"; await writeFile(sourceFile, text);
  let calls = 0, adapters = 0, legacy = 0, lost = false, digest = selected.modelDigest;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, allowedOrigins: [], authToken: "synthetic-committee-client-token", identityDirectory: path.join(directory, "identity"), runtimeDefinitions: [], checkpointer: new MemorySaver() as never,
    careerTaskReasoner: async () => { adapters++; return async (...args) => { calls++; return (override ?? scripted)(...args); }; },
    careerStudioLocalClient: () => ({ binding: async () => ({ id: "synthetic-metadata", version: "v1", location: "local", endpointFingerprint: "c".repeat(64), ...selected, modelDigest: digest }),
      complete: async () => { legacy++; throw Error("Production client may not call the old Studio executor"); } }) });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const identity = await registerTestIdentity(base, "synthetic-committee-client-token", "synthetic-committee-client-owner"); activatePrincipal(identity.principal);
  t.after(async () => { activatePrincipal(undefined); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); dom.localStorage.clear(); });
  const wire: Array<{ path: string; method: string; body?: unknown }> = [], original = globalThis.fetch;
  const fetcher: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? "GET"; wire.push({ path: pathname, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const headers = new Headers(init?.headers); for (const [key, value] of Object.entries(identity.headers)) headers.set(key, value); headers.set("Authorization", "Bearer synthetic-committee-client-token");
    const response = await original(base + pathname, { ...init, headers });
    if (lost && pathname === "/api/v1/agent/tasks" && method === "POST") { lost = false; throw Error("synthetic committed create response lost"); } return response;
  };
  const post = async (route: string, body: unknown) => { const response = await fetcher(base + "/api/v1/agent" + route, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); const data = await response.json(); assert.ok(response.ok, `${response.status}:${JSON.stringify(data)}`); return data; };
  let parent = (await post("/tasks", { kind: "free_chat", workspaceKey: "prior-chat", rootScopeKey: scope, objective: "合成原根", conversation: { messages: [{ id: "prior-message", role: "user", content: "PRIVATE-PRIOR-CHAT" }] }, runtimeBinding: careerRuntimeBinding(runtime), budget: { maxModelCalls, maxToolCalls: 500, maxActiveMs: 60000 }, consent: true, idempotencyKey: "synthetic-prior-chat-root" })).task as AgentTask;
  await post(`/tasks/${parent.id}/start`, { expectedRevision: parent.revision, sourceFingerprint: parent.sourceFingerprint, runtimeBinding: parent.runtimeBinding, consent: true, runtime });
  const tasks = async () => (await (await fetcher(base + "/api/v1/agent/tasks")).json()).tasks as AgentTask[];
  for (let i = 0; i < 300; i++) { parent = (await tasks()).find(row => row.id === parent.id)!; if (parent.status !== "running") break; await delay(5); } assert.equal(parent.status, "awaiting_answer");
  const studio = createCareerStudioClient(fetcher), { context } = await studio.context({ workspaceKey: scope, resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64), consent: true,
    claims: [{ id: "claim-a", text: claim, contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [], skillIds: [] }], jobs: [] });
  await studio.request("/runtime/select", { contextId: context.id, runtime: selected, consent: true });
  const body = { contextId: context.id, runtime: selected, consent: true, idempotencyKey: "synthetic-committee-stable-input", claimIds: ["claim-a"], statements: [{ kind: "user_statement", label: "完整合成自述", text: statement }], code: [{ root: source, files: [{ path: "lease.ts", startLine: 1, endLine: 2 }] }] };
  const read = async (id: string) => StudioOperationSchema.parse(await studio.request("/operation/read", { contextId: context.id, operationId: id }));
  const settled = async (id: string): Promise<StudioOperation> => { for (let i = 0; i < 1500; i++) { const operation = await read(id); if (operation.status !== "running") return operation; await delay(5); } throw Error("committee client did not settle"); };
  return { studio, context, parent, body, tasks, post, read, settled, wire, directory, sourceFile, originalText: text, counts: () => ({ calls, adapters, legacy }), loseCreate: () => { lost = true; }, changeDigest: () => { digest = "d".repeat(64); } };
}

test("production committee client -> authenticated task -> same owner/root; publication and whiteboard reuse metered fresh kernel evidence", async t => {
  const f = await fixture(t), start = StudioOperationSchema.parse(await f.studio.request("/committee/start", f.body)), complete = await f.settled(start.id);
  assert.equal(complete.status, "completed", complete.errorCode); assert.equal(complete.id, start.id); assert.equal(complete.taskStatus, "completed");
  let task = (await f.tasks()).find(row => row.id === start.id) as StudioCommitteeTask;
  assert.equal(task.rootTaskId, f.parent.id); assert.equal(task.rootLedger?.usage.modelCalls, 15); assert.deepEqual(f.counts(), { calls: 15, adapters: 1, legacy: 0 });
  const history = await f.studio.request("/operation/list", { contextId: f.context.id }) as { operations: StudioOperation[] }; assert.equal(history.operations.find(row => row.id === task.id)?.status, "completed");
  const used = task.usage.toolCalls;
  const imported = await f.studio.request("/architecture/evidence", { contextId: f.context.id, operationId: task.id, consent: true }) as { evidence: Array<{ excerpt: string; path?: string }> };
  assert.equal(imported.evidence.find(row => row.path === "lease.ts")?.excerpt, f.originalText.trimEnd());
  task = (await f.tasks()).find(row => row.id === task.id) as StudioCommitteeTask; assert.equal(task.usage.toolCalls, used + 1, "adoption uses the charged kernel reread, not a second free Broker read");
  const review = task.result!.claims[0]!; assert.equal(review.support, "supported");
  const publication = await f.studio.request("/publication/review", { contextId: f.context.id, operationId: task.id, claimId: "claim-a", expectedClaimHash: review.claimHash,
    disclosure: "publishable", review: { kind: "implementation", action: "合成自述核对，不认证生产。", role: "未知", deployment: "未认证" }, consent: true, idempotencyKey: "synthetic-publication" }) as { operationId: string; fact: { evidence: unknown[] } };
  assert.equal(publication.operationId, task.id); assert.ok(!JSON.stringify(publication).includes("export const lease")); assert.ok(publication.fact.evidence.length);
  const posts = f.wire.filter(row => row.method === "POST" && row.path.includes("/tasks")).length;
  await f.studio.request("/committee/start", f.body); assert.equal(f.wire.filter(row => row.method === "POST" && row.path.includes("/tasks")).length, posts);
  assert.ok(!f.wire.some(row => row.path.endsWith("/career-studio/committee/start"))); assert.equal(f.counts().calls, 15);
  await writeFile(f.sourceFile, "changed\n// changed\n");
  await assert.rejects(f.read(task.id), error => error instanceof Error && "code" in error && error.code === "studio_source_changed");
  await assert.rejects(f.studio.request("/architecture/evidence", { contextId: f.context.id, operationId: task.id, consent: true }), /studio_source_changed/); assert.equal(f.counts().calls, 15);
  await writeFile(f.sourceFile, f.originalText);
  const root = (await f.tasks()).find(row => row.id === f.parent.id)!;
  await f.post(`/tasks/${root.id}/budget`, { expectedRevision: root.revision, consent: true, budget: { maxModelCalls: 15, maxToolCalls: root.rootLedger!.usage.toolCalls, maxActiveMs: 60000 } });
  await assert.rejects(f.studio.request("/architecture/evidence", { contextId: f.context.id, operationId: task.id, consent: true }), /tool_call_budget/);
  assert.equal((await f.tasks()).find(row => row.id === task.id)!.rootLedger?.usage.toolCalls, root.rootLedger!.usage.toolCalls); assert.equal(f.counts().calls, 15);
});

test("unknown create reconciles once; paused task never resumes from start/read and explicit resume retains original ID/budget", async t => {
  let sent = 0; const f = await fixture(t, async (...args) => { if (args[2] === "studio_committee" && ++sent === 4) return { text: "  完整部分回复😀\r\nTAIL  ", finishReason: "length" }; return scripted(...args); });
  f.loseCreate(); await assert.rejects(f.studio.request("/committee/start", f.body), /未收到任务服务回执/);
  let task = (await f.tasks()).find(row => row.kind === "studio_committee") as StudioCommitteeTask; assert.equal(task.status, "ready"); assert.equal(f.counts().calls, 1);
  await f.studio.request("/committee/start", f.body); const paused = await f.settled(task.id); assert.equal(paused.taskStatus, "paused");
  const posts = f.wire.filter(row => row.method === "POST" && row.path.includes("/tasks")).length;
  await f.studio.request("/committee/start", f.body); await f.read(task.id); assert.equal(f.counts().calls, 5); assert.equal(f.wire.filter(row => row.method === "POST" && row.path.includes("/tasks")).length, posts);
  await assert.rejects(f.studio.request("/committee/resume", { contextId: f.context.id, operationId: task.id, runtime: selected, consent: false }), /explicit_committee_resume_consent_required/);
  await f.studio.request("/committee/resume", { contextId: f.context.id, operationId: task.id, runtime: selected, consent: true });
  const result = await f.settled(task.id); assert.equal(result.status, "completed", result.errorCode); task = (await f.tasks()).find(row => row.id === task.id) as StudioCommitteeTask;
  assert.equal(task.usage.modelCalls, 15); assert.equal(task.rootLedger?.usage.modelCalls, 16); assert.equal(task.rootTaskId, f.parent.id);
  assert.equal(f.wire.filter(row => row.method === "POST" && row.path === "/api/v1/agent/tasks").length, 2); assert.equal(f.counts().adapters, 1); assert.equal(f.counts().legacy, 0);
});

test("root exhaustion remains visible and current adoption cannot bypass its tool ceiling or metadata authority", async t => {
  const f = await fixture(t, undefined, 4), start = StudioOperationSchema.parse(await f.studio.request("/committee/start", f.body)), result = await f.settled(start.id);
  assert.equal(result.taskStatus, "budget_exhausted"); assert.equal(result.errorCode, "model_call_budget"); assert.equal(f.counts().calls, 4);
  await f.studio.request("/committee/start", f.body); assert.equal(f.counts().calls, 4);
  const before = f.wire.length; await assert.rejects(f.studio.request("/committee/start", { ...f.body, statements: [] }), /另一份完整资料/); assert.ok(f.wire.slice(before).every(row => row.method === "GET"));
  await assert.rejects(f.studio.request("/architecture/evidence", { contextId: f.context.id, operationId: start.id, consent: true }), /studio_committee_completed_required/);
  f.changeDigest(); await assert.rejects(f.studio.request("/committee/resume", { contextId: f.context.id, operationId: start.id, runtime: selected, consent: true })); assert.equal(f.counts().calls, 4);
});

for (const oversized of [false,true]) test(`actual owner runtime preserves a full late committee ${oversized?"artifact":"reply"} after the production client explicitly pauses`, async t => {
  const entered = Promise.withResolvers<void>(), late = Promise.withResolvers<void>(), returned = Promise.withResolvers<void>(); let expected = "";
  const f = await fixture(t, async (...args) => {
    if (args[2] !== "studio_committee") return scripted(...args);
    expected = oversized ? "  完整迟到回复😀\r\n"+"private synthetic wire ".repeat(9000)+"\r\nTAIL  " : await scripted(...args) as string;
    entered.resolve(); await late.promise; returned.resolve();
    // Completion notification is not archive publication. Exercise a delayed
    // large delivery as well as the real persistence path, even on a fast disk.
    if (oversized) await delay(3000);
    return expected;
  });
  const operation = StudioOperationSchema.parse(await f.studio.request("/committee/start", f.body)); await entered.promise;
  const paused = StudioOperationSchema.parse(await f.studio.request("/operation/cancel", { contextId: f.context.id, operationId: operation.id })); assert.equal(paused.taskStatus, "paused");
  late.resolve(); await returned.promise;
  const owners = await readdir(path.join(f.directory, "identity/owners")); assert.equal(owners.length, 1);
  const file = path.join(f.directory, "identity/owners", owners[0]!, "career-tasks-v1", `${operation.id}.json`);
  let retained = false;
  // Wait for durable publication, not 200 scheduler turns. Windows fsync and
  // the deliberate delayed delivery above may outlast that accidental window.
  const publicationDeadline = Date.now() + 30_000;
  while (Date.now() < publicationDeadline) {
    const record = JSON.parse(await readFile(file, "utf8"));
    if(oversized){
      const artifact=record.task.outputArtifacts?.[0];
      if(artifact)retained=(await readFile(path.join(path.dirname(file),"outputs",operation.id,`${artifact.id}.txt`),"utf8"))===expected;
    }else retained = record.recent.some((row: { kind: string; output?: string; late?: boolean }) => row.kind === "studio_committee_output" && row.output === expected && row.late === true);
    if (retained) { assert.equal(record.committeeState.completed.length,0);assert.equal(record.task.result,undefined);break; } await delay(25);
  }
  assert.equal(retained, true, "the real owner runtime must deliver late complete wire to the kernel's private archive before refusing adoption");
  const task = (await f.tasks()).find(row => row.id === operation.id)!; assert.equal(task.status, "paused"); assert.equal(task.usage.modelCalls, 1); assert.equal(f.counts().calls, 2); assert.equal(f.counts().legacy, 0);
});
