import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { studioAnalysisRuntime, type StudioAnalysisRequest, type StudioAnalysisTask, type AgentTask, careerRuntimeBinding } from "@better-me/agent-contracts";
import { createAgentServer } from "../../agent-host/src/server";
import type { CareerTaskReasoner } from "../../agent-host/src/kernel/model-protocol";
import { MemorySaver } from "../../agent-host/tests/fixtures/checkpointer";
import { registerTestIdentity } from "../../agent-host/tests/fixtures/identity";
import { activatePrincipal } from "../src/lib/identity";
import { createCareerStudioClient } from "../src/services/career-studio-client";
import { createStudioAnalysisTaskClient } from "../src/services/studio-analysis-task-client";
import { createFreeChatTaskClient } from "../src/services/free-chat-task-client";
import { createCareerLayoutModelAdapter, type CareerLayoutModelResponse } from "../src/services/career-layout-model";
import { REQUIRED_SEMANTIC_CHECKS, type LayoutDiagnosis, type LayoutScope } from "../src/lib/layout-compiler";
import { createCareerArchitectureAdapters } from "../src/services/career-architecture-client";
import { createArchitectureDocument, architectureGraphFingerprint } from "../src/lib/architecture-lab";

const dom = new Window({ url: "http://synthetic-studio.invalid" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const scope = "synthetic-studio-workspace", selected = { model: "synthetic-studio-model", modelDigest: "a".repeat(64) }, runtime = studioAnalysisRuntime(selected.model);
const contract = { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 100000 } }, required: ["text"] };
const request = (contextId: string, key = "analysis-request"): StudioAnalysisRequest => ({ contextId, consent: true, runtime: selected, purpose: "architecture_question", idempotencyKey: key, payload: { contract, data: "  冻结合成输入😀\r\n" + "不裁原文。".repeat(2000) + "END  " } });

async function fixture(t: TestContext, reasoner: () => Promise<CareerTaskReasoner>) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-studio-tasks-http-"))), originalFetch = globalThis.fetch, wire: { path: string; method: string }[] = [];
  let metadataDigest = selected.modelDigest, localComplete = 0, loseCreate = false;
  const server = createAgentServer({ host: "127.0.0.1", port: 0, allowedOrigins: [], authToken: "synthetic-studio-token", identityDirectory: path.join(directory, "identity"), runtimeDefinitions: [], checkpointer: new MemorySaver() as never,
    careerTaskReasoner: reasoner, careerStudioLocalClient: () => ({ binding: async () => ({ id: "synthetic-metadata", version: "synthetic-v1", location: "local", endpointFingerprint: "c".repeat(64), ...selected, modelDigest: metadataDigest }), complete: async () => { localComplete++; throw Error("retired Studio executor must never be called"); } }) });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const identity = await registerTestIdentity(base, "synthetic-studio-token", "synthetic-studio-owner"); activatePrincipal(identity.principal);
  t.after(async () => { activatePrincipal(undefined); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); dom.localStorage.clear(); });
  const fetcher: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? "GET"; wire.push({ path: pathname, method });
    assert.ok(pathname.startsWith("/api/v1/agent/"), `no browser/provider dispatch: ${pathname}`);
    const headers = new Headers(init?.headers); for (const [key, value] of Object.entries(identity.headers)) headers.set(key, value); headers.set("Authorization", "Bearer synthetic-studio-token");
    const result = await originalFetch(base + pathname, { ...init, headers });
    if (loseCreate && pathname === "/api/v1/agent/tasks" && method === "POST") { loseCreate = false; throw Error("synthetic lost committed create receipt"); } return result;
  };
  const studio = createCareerStudioClient(fetcher), analysis = createStudioAnalysisTaskClient({ fetch: fetcher, pollMs: 5 });
  const { context } = await studio.context({ workspaceKey: scope, resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64), claims: [], jobs: [], consent: true });
  await studio.request("/runtime/select", { contextId: context.id, runtime: selected, consent: true });
  return { studio, analysis, context, directory, identity, wire, fetcher, base, localCalls: () => localComplete, changeDigest: () => { metadataDigest = "d".repeat(64); }, loseCreate: () => { loseCreate = true; },
    tasks: async () => (await (await fetcher(base + "/api/v1/agent/tasks")).json()).tasks as AgentTask[] };
}

test("production Studio caller -> authenticated tasks -> kernel uses the previous chat root and one adapter; complete reply re-read is GET-only", async t => {
  let calls = 0, adapters = 0; const text = "  完整答复😀\r\n" + "全文不裁".repeat(18000) + "END  ";
  const f = await fixture(t, async () => { adapters++; return async (prompt, _signal, phase, _images, _source, schema) => { calls++;
    if (phase === "free_chat") return JSON.stringify({ kind: "reply", content: "既有聊天" });
    assert.equal(phase, "studio_analysis"); assert.deepEqual(schema, contract); assert.ok(!prompt.includes("PRIVATE-PRIOR-CHAT")); assert.ok(prompt.includes(JSON.stringify(request(f.context.id).payload.data))); return JSON.stringify({ text });
  }; });
  const chat = createFreeChatTaskClient({ fetch: f.fetcher, pollMs: 5 }), prior = await chat.send({ workspaceKey: "prior-chat", rootScopeKey: scope, runtime, messages: [{ id: "prior-message", role: "user", content: "PRIVATE-PRIOR-CHAT" }] });
  const result = await f.studio.request("/model", request(f.context.id)) as { output: { text: string }; adopted: boolean };
  assert.equal(result.output.text, text); assert.equal(result.adopted, false); assert.equal(calls, 2); assert.equal(adapters, 1); assert.equal(f.localCalls(), 0);
  const task = (await f.tasks()).find(row => row.kind === "studio_analysis") as StudioAnalysisTask;
  assert.equal(task.rootTaskId, prior.meta?.taskId); assert.equal(task.rootLedger?.usage.modelCalls, 2); assert.equal(task.usage.toolCalls, 0);
  const posts = f.wire.filter(row => row.method === "POST").length;
  assert.deepEqual(await f.studio.request("/model", request(f.context.id)), result); assert.equal(f.wire.filter(row => row.method === "POST").length, posts); assert.equal(calls, 2);
  assert.ok(!f.wire.some(row => row.path.endsWith("/career-studio/model")));
  assert.ok(f.wire.filter(row => row.method === "POST" && !row.path.includes("/context/") && !row.path.endsWith("/runtime/select")).every(row => row.path.startsWith("/api/v1/agent/tasks")));
  f.changeDigest(); await assert.rejects(f.studio.request("/model", request(f.context.id)), error => error instanceof Error && "code" in error && error.code === "local_runtime_changed");
  assert.equal(calls, 2); assert.equal(f.wire.filter(row => row.method === "POST").length, posts);
});

test("a conflicting root model and forged scope/runtime cannot create independent generation or change old records", async t => {
  let calls = 0; const f = await fixture(t, async () => async () => { calls++; return JSON.stringify({ kind: "reply", content: "existing" }); });
  await createFreeChatTaskClient({ fetch: f.fetcher, pollMs: 5 }).send({ workspaceKey: "prior", rootScopeKey: scope, runtime: studioAnalysisRuntime("another-model"), messages: [{ id: "message", role: "user", content: "合成" }] });
  const before = JSON.stringify(await f.tasks()); await assert.rejects(f.studio.request("/model", request(f.context.id)), error => error instanceof Error && "code" in error && error.code === "root_runtime_binding_changed");
  assert.equal(JSON.stringify(await f.tasks()), before); assert.equal(calls, 1); assert.equal(f.localCalls(), 0);
  const forged = { kind: "studio_analysis", workspaceKey: "studio-analysis:forged", rootScopeKey: "forged", objective: "合成", request: request(f.context.id), runtimeBinding: careerRuntimeBinding(runtime), consent: true, idempotencyKey: "forged-task-scope" };
  const response = await f.fetcher(f.base + "/api/v1/agent/tasks", { method: "POST", body: JSON.stringify(forged) }); assert.equal(response.status, 403); assert.equal((await response.json()).error, "studio_task_scope_mismatch");
  const other = await registerTestIdentity(f.base, "synthetic-studio-token", "synthetic-other-owner"), headers = { ...other.headers, Authorization: "Bearer synthetic-studio-token", "Content-Type": "application/json" };
  const foreign = await fetch(f.base + "/api/v1/agent/tasks", { method: "POST", headers, body: JSON.stringify({ ...forged, workspaceKey: `studio-analysis:${scope}`, rootScopeKey: scope }) });
  assert.equal(foreign.status, 409); assert.equal((await foreign.json()).error, "studio_context_stale"); assert.equal(calls, 1);
});

test("unknown committed create is reconciled with one stable task; old model HTTP is 410 and never reaches complete", async t => {
  let calls = 0; const f = await fixture(t, async () => async () => { calls++; return JSON.stringify({ text: "一次派送" }); });
  f.loseCreate(); await assert.rejects(f.studio.request("/model", request(f.context.id)), /未收到任务服务回执/); assert.equal(calls, 0);
  const task = (await f.tasks())[0] as StudioAnalysisTask; assert.equal(task.status, "ready");
  const result = await f.studio.request("/model", request(f.context.id)) as { output: { text: string } }; assert.equal(result.output.text, "一次派送"); assert.equal(calls, 1);
  assert.equal(f.wire.filter(row => row.path === "/api/v1/agent/tasks" && row.method === "POST").length, 1);
  const legacy = await f.fetcher(f.base + "/api/v1/agent/career-studio/model", { method: "POST", body: JSON.stringify(request(f.context.id)) }); assert.equal(legacy.status, 410); assert.equal(f.localCalls(), 0);
  await assert.rejects(f.studio.request("/model", { ...request(f.context.id), payload: { contract, data: "different" } }), /另一份完整资料/);
});

test("context revocation/digest drift blocks late results with full wire retained; direct runtime substitution is refused", async t => {
  const entered = Promise.withResolvers<void>(), late = Promise.withResolvers<string>(); let calls = 0;
  const f = await fixture(t, async () => async () => { calls++; entered.resolve(); return late.promise; });
  const pending = f.studio.request("/model", request(f.context.id)); const failure = assert.rejects(pending); await entered.promise;
  await f.studio.request("/context/revoke", { contextId: f.context.id }); const raw = JSON.stringify({ text: "完整晚结果😀" }); late.resolve(raw); await failure;
  const task = (await f.tasks())[0] as StudioAnalysisTask; assert.equal(task.error, "studio_context_stale"); assert.equal(task.result, undefined); assert.equal(task.usage.modelCalls, 1); assert.equal(calls, 1);
  const owners = path.join(f.directory, "identity", "owners"), ownerDirectories = await readdir(owners); assert.equal(ownerDirectories.length, 1);
  const stored = JSON.parse(await readFile(path.join(owners, ownerDirectories[0]!, "career-tasks-v1", `${task.id}.json`), "utf8")); assert.ok(stored.recent.some((item: { output?: string }) => item.output === raw));
  const other = await f.studio.context({ workspaceKey: scope, resumeId: "synthetic-resume", sourceFingerprint: "b".repeat(64), claims: [], jobs: [], consent: true });
  await f.studio.request("/runtime/select", { contextId: other.context.id, runtime: selected, consent: true });
  const created = await f.fetcher(f.base + "/api/v1/agent/tasks", { method: "POST", body: JSON.stringify({ kind: "studio_analysis", workspaceKey: `studio-analysis:${scope}`, rootScopeKey: scope, objective: "显式合成模型守卫", request: request(other.context.id), runtimeBinding: careerRuntimeBinding(runtime), consent: true, idempotencyKey: "manual-synthetic-analysis" }) });
  assert.equal(created.status, 201); const next = (await created.json()).task as StudioAnalysisTask;
  const forged = await f.fetcher(f.base + `/api/v1/agent/tasks/${next.id}/start`, { method: "POST", body: JSON.stringify({ expectedRevision: next.revision, sourceFingerprint: next.sourceFingerprint, runtimeBinding: next.runtimeBinding, consent: true, runtime: { ...runtime, modelSettings: { ...runtime.modelSettings, temperature: 1 } } }) });
  assert.equal(forged.status, 422); assert.equal((await forged.json()).error, "studio_task_runtime_mismatch"); assert.equal(calls, 1);
  f.changeDigest();
  await assert.rejects(f.studio.request("/model", request(other.context.id)), /HTTP 409/); assert.equal(calls, 1);
});

test("real layout rewrite/review and architecture ask/review callers plus skill mapping all execute as distinct tasks on one root/adapter", async t => {
  const purposes: string[] = []; let adapters = 0;
  const before = "Implemented a synthetic local fixture with local checks; not deployed.", after = "Implemented a synthetic local fixture with checks; not deployed.";
  const f = await fixture(t, async () => { adapters++; return async prompt => {
    const frozen = JSON.parse(prompt.split("\n").find(line => line.startsWith('{"purpose"'))!); purposes.push(frozen.purpose);
    const values: Record<string, unknown> = {
      layout_rewrite: { candidates: [{ replacements: [{ anchor: "claim:c1", before, after }], explanation: "Synthetic proposal, not personal evidence." }] },
      layout_review: { verdict: "equivalent", checks: REQUIRED_SEMANTIC_CHECKS.map(kind => ({ kind, passed: true, reason: "Synthetic bounded check." })), detail: "Fixture only, not model-quality certification." },
      architecture_question: { id: "q1", text: "请说明故障恢复边界。", evidenceIds: ["source-a"], unknowns: [] },
      architecture_review: { support: "unknown", summary: "尚缺实际恢复证据。", strengths: [], gaps: ["没有独立运行记录。"], followUps: [], evidenceIds: ["source-a"] },
      skill_mapping: { text: "原文技能要求，未知留空。" },
    }; return JSON.stringify(values[frozen.purpose]);
  }; });
  const layoutScope: LayoutScope = { ownerId: f.identity.principal.id, sessionGeneration: 1, documentId: "synthetic-resume", revision: "b".repeat(64), contentHash: "b".repeat(64) };
  const model = createCareerLayoutModelAdapter({ contextId: f.context.id, scope: layoutScope, runtime: selected, getCurrentScope: () => layoutScope, reviewUsesFreshContext: true,
    request: async (body, signal) => await f.studio.request("/model", body, signal) as CareerLayoutModelResponse });
  const signal = new AbortController().signal, input = { scope: layoutScope, texts: [{ anchor: "claim:c1", text: before }] };
  const report: LayoutDiagnosis = { status: "diagnosed", scope: layoutScope, source: "dom-estimate", pages: [], issues: [{ id: "short", kind: "short-last-line", severity: "notice", pageNumber: 1, anchor: "claim:c1", detail: "Synthetic measured short line", metrics: {} }], penalty: 1, finalFileCheck: "not-performed", limitations: [] };
  const candidates = await model.rewrite({ input, current: { id: "base", baseScope: layoutScope, replacements: [] }, report, iteration: 1, maxCandidates: 1 }, signal);
  assert.equal(candidates[0]?.replacements[0]?.after, after);
  assert.equal((await model.verifySemantics({ input, candidate: candidates[0]! }, signal)).verdict, "equivalent");
  const binding = { ownerId: layoutScope.ownerId, sessionGeneration: 1, projectId: "synthetic-resume", revision: layoutScope.revision, contentHash: layoutScope.contentHash }, evidence = [{ id: "source-a", label: "合成自述", excerpt: "本地样例未部署。" }];
  const document = createArchitectureDocument(binding, evidence, "synthetic-graph"), api = createCareerArchitectureAdapters({ contextId: f.context.id, workspaceKey: scope, runtime: selected, request: f.studio.request, getCurrentBinding: () => binding, getCurrentEvidence: () => evidence });
  const context = { requestId: "question-1", binding, graphFingerprint: architectureGraphFingerprint(document), document };
  const question = await api.interview!.ask(context, signal); assert.deepEqual(question.value.evidenceIds, ["source-a"]);
  const review = await api.interview!.review({ ...context, requestId: "review-1", question: question.value, answer: "  合成完整回答😀\r\n不知道生产状态。  " }, signal); assert.equal(review.value.support, "unknown");
  await f.studio.request("/model", { ...request(f.context.id, "skill-map"), purpose: "skill_mapping" });
  assert.deepEqual(purposes, ["layout_rewrite", "layout_review", "architecture_question", "architecture_review", "skill_mapping"]); assert.equal(adapters, 1); assert.equal(f.localCalls(), 0);
  const tasks = await f.tasks(); assert.equal(tasks.length, 5); assert.equal(new Set(tasks.map(task => task.rootTaskId)).size, 1); assert.ok(tasks.every(task => task.rootLedger?.usage.modelCalls === 5));
  assert.ok(!f.wire.some(row => row.path.endsWith("/career-studio/model")));
});
