import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { AgentTaskSchema, agentTaskSourceFingerprint, careerRuntimeBinding, type AgentTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { ChatGptPlanService } from "../src/chatgpt/service.js";
import { chatGptProviderFixture } from "./fixtures/chatgpt-provider.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("authenticated ChatGPT tasks share the real owner kernel/root across chat, refinement and project, with repair charged and complete output retained", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-chatgpt-kernel-http-"));
  const provider = await chatGptProviderFixture();
  let wireCalls = 0, fallbackCalls = 0;
  const partial = "完整但未完成\r\n🚧".repeat(5000) + "PARTIAL-END";
  const overflow = "完整超长输出\r\n🚧".repeat(18000) + "OVERFLOW-END";
  const account = new ChatGptPlanService({ directory: path.join(directory, "oauth"), fetch: async (url, init) => {
    if (String(url).endsWith("/responses")) {
      wireCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "fixture-gpt"); assert.equal(body.store, false); assert.equal(body.stream, true);
      const prompt: string = body.input[0].content;
      provider.settings.incomplete = prompt.includes("synthetic-incomplete-task");
      if (provider.settings.incomplete) provider.settings.responseText = partial;
      else if (prompt.includes("synthetic-overflow-task")) provider.settings.responseText = overflow;
      else if (body.instructions.includes("experience editor")) provider.settings.responseText = JSON.stringify({ questions: ["请补充本人动作及可核对结果。"], rationale: "仅自述，不补写上线指标。", evidenceQuotes: [] });
      else if (body.instructions.includes("project understanding")) provider.settings.responseText = JSON.stringify({ kind: "reply", message: "先核对项目边界。", readyForConfirmation: false,
        understanding: { summary: "虚构编排项目，个人贡献未确认。", terms: [], boundaries: ["不证明本人贡献"], claims: [], unknowns: ["职责待确认"] },
        question: { id: "scope", text: "此处是否只负责编排？", why: "先建立共同术语。", options: [{ id: "yes", label: "只编排" }], allowMultiple: false } });
      else provider.settings.responseText = wireCalls === 1 ? "完整无效输出，等待内核计账修复。RAW-END" : JSON.stringify({ kind: "reply", content: "合成完整回答，不写入简历。" });
    }
    return provider.fetch(url, init);
  } });
  const login = await provider.login(account), profileId = login.state.profiles[0]!.id;
  const runtime = { kind: "chatgpt" as const, profileId, model: "fixture-gpt" }, runtimeBinding = careerRuntimeBinding(runtime);
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "synthetic-account-kernel-token", allowedOrigins: [], runtimeDefinitions: [], identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never, chatGptService: account,
    careerTaskReasoner: async () => { fallbackCalls++; throw Error("Account task must not borrow an API/native reasoner"); } });
  try {
    await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    const alice = await registerTestIdentity(base, "synthetic-account-kernel-token", "synthetic-account-alice");
    const request = (suffix: string, body?: unknown, owner = alice.headers) => fetch(`${base}/api/v1/agent/tasks${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { ...owner, Authorization: "Bearer synthetic-account-kernel-token", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = async (response: Response) => { const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return AgentTaskSchema.parse(value.task); };
    const run = (task: AgentTask) => ({ expectedRevision: task.revision, sourceFingerprint: agentTaskSourceFingerprint(task), runtimeBinding, runtime, consent: true });
    const poll = async (id: string) => { for (let i = 0; i < 250; i++) { const task = await parsed(await request(`/${id}`)); if (task.status !== "running") return task; await delay(5); } throw Error("Synthetic account kernel did not settle"); };
    const text = "完整自述，不确认本人负责上线。\r\n🚧".repeat(1000) + "SOURCE-END";
    const create = { kind: "free_chat", workspaceKey: "synthetic-account-chat", rootScopeKey: "synthetic-account-scope", objective: "核对职业方向", conversation: { messages: [{ id: "u1", role: "user", content: text }] }, runtimeBinding, consent: true, idempotencyKey: "synthetic-account-chat-first", budget: { maxModelCalls: 4, maxToolCalls: 12, maxActiveMs: 60000 } };
    let chat = await parsed(await request("", create)); assert.equal(chat.usage.modelCalls, 0);
    assert.equal((await request(`/${chat.id}/start`, run(chat))).status, 202); chat = await poll(chat.id);
    assert.equal(chat.status, "awaiting_answer"); assert.equal(chat.usage.modelCalls, 2); assert.equal(wireCalls, 2);
    const sends = provider.calls.filter(call => call.url.endsWith("/responses"));
    const initialPrompt: string = JSON.parse(String(sends[0]!.init?.body)).input[0].content;
    assert.equal(JSON.parse(initialPrompt.split("\n\n").at(-1)!).conversation.messages[0].content, text);
    assert.match(JSON.parse(String(sends[1]!.init?.body)).input[0].content, /RAW-END/);
    let refine = await parsed(await request("", { kind: "experience_refine", workspaceKey: "synthetic-account-writing", rootScopeKey: create.rootScopeKey, objective: "只润色获准原文", refinement: { source: { targetRef: { kind: "profile_headline", locale: "zh" }, text: "参与接口测试。", label: "合成原文" } }, conversation: { messages: [{ id: "s1", role: "user", content: "本人动作和结果尚待补充。" }] }, runtimeBinding, consent: true, supplementConfirmed: true, idempotencyKey: "synthetic-account-writing-first" }));
    assert.equal(refine.parentTaskId, chat.id); assert.equal((await request(`/${refine.id}/start`, run(refine))).status, 202); refine = await poll(refine.id);
    assert.equal(refine.status, "awaiting_answer"); assert.equal(refine.usage.modelCalls, 1); assert.equal(refine.rootLedger?.usage.modelCalls, 3);
    let project = await parsed(await request("", { kind: "project_understanding", workspaceKey: "synthetic-account-project", rootScopeKey: create.rootScopeKey, objective: "先核对项目含义", project: { projectKey: "synthetic-field", label: "合成编排项目", sourceText: "项目只编排任务，不直接控制设备。" }, runtimeBinding, consent: true, idempotencyKey: "synthetic-account-project-first" }));
    assert.equal((await request(`/${project.id}/start`, { ...run(project), projectTurn: { expectedRevision: project.revision, idempotencyKey: "synthetic-account-project-turn", answer: "先核对术语。", selectedOptionIds: [], consentToSend: true } })).status, 202); project = await poll(project.id);
    assert.equal(project.kind, "project_understanding"); assert.equal(project.status, "awaiting_answer"); assert.equal(project.rootTaskId, chat.id); assert.equal(project.rootLedger?.usage.modelCalls, 4); assert.equal(wireCalls, 4);
    const exhausted = await request(`/${chat.id}/answer`, { ...run(chat), message: { id: "u2", role: "user", content: "不得借新视图领新预算。" } }); assert.ok(exhausted.status >= 400); assert.equal(wireCalls, 4);
    await parsed(await request(`/${chat.id}`)); await (await request(`/${chat.id}/events?after=0`)).json(); assert.equal(wireCalls, 4);

    const bob = await registerTestIdentity(base, "synthetic-account-kernel-token", "synthetic-account-bob");
    assert.equal((await request(`/${chat.id}`, undefined, bob.headers)).status, 404);
    const foreign = await parsed(await request("", { ...create, rootScopeKey: "bob-isolated", idempotencyKey: "synthetic-bob-task" }, bob.headers));
    assert.equal((await request(`/${foreign.id}/start`, run(foreign), bob.headers)).status, 401); assert.equal(wireCalls, 4);

    let interrupted = await parsed(await request("", { ...create, rootScopeKey: "synthetic-partial-root", objective: "synthetic-incomplete-task", idempotencyKey: "synthetic-partial-task" }));
    assert.equal((await request(`/${interrupted.id}/start`, run(interrupted))).status, 202); interrupted = await poll(interrupted.id);
    assert.equal(interrupted.status, "paused"); assert.equal(interrupted.usage.modelCalls, 1); assert.equal(wireCalls, 5);
    assert.ok("partialOutput" in interrupted); assert.equal(interrupted.partialOutput?.text, partial); assert.equal(interrupted.partialOutput?.finishReason, "incomplete");

    let big = await parsed(await request("", { ...create, rootScopeKey: "synthetic-big-root", objective: "synthetic-overflow-task", idempotencyKey: "synthetic-overflow-task" }));
    assert.equal((await request(`/${big.id}/start`, run(big))).status, 202); big = await poll(big.id);
    assert.equal(big.status, "budget_exhausted"); assert.equal(big.usage.modelCalls, 1); assert.equal(wireCalls, 6); assert.ok("outputArtifacts" in big);
    const artifact = big.outputArtifacts![0]!; assert.equal(await (await request(`/${big.id}/outputs/${artifact.id}`)).text(), overflow);
    assert.equal((await request(`/${big.id}/outputs/${artifact.id}`, undefined, bob.headers)).status, 404);
    const stored = await readFile(path.join(directory, "accounts", "owners", alice.principal.id, "career-tasks-v1", `${chat.id}.json`), "utf8");
    assert.match(stored, /RAW-END/); assert.doesNotMatch(stored, /FICTIONAL_ACCESS|FICTIONAL_REFRESH|idToken|oaiapp_fixture/);
    await provider.login(account, profileId);
    const staleGrant = await request(`/${interrupted.id}/resume`, run(interrupted));
    assert.equal(staleGrant.status, 409); assert.equal((await staleGrant.json()).error, "runtime_authorization_changed_new_task_required");
    assert.equal((await parsed(await request(`/${interrupted.id}`))).usage.modelCalls, 1);
    assert.equal(fallbackCalls, 0); assert.equal(wireCalls, 6);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); account.dispose(); await rm(directory, { recursive: true, force: true }); }
});
