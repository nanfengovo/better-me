import assert from "node:assert/strict";
import test from "node:test";
import { BetterMeAgent } from "../src/lib/betterme-agent/kernel";
import { createMemoryAgentRepository, emptyAgentState } from "../src/lib/betterme-agent/storage";
import { fixtureSession, fixtureUnderstanding } from "./fixtures/project-understanding";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const descriptor = { origin: "companion" as const, label: "隔离对话", input: "讨论合成项目", destination: "隔离模型" };
const confirmed = () => fixtureSession({ phase: "confirmed", revision: 2, summaryHash: "synthetic-hash", understanding: fixtureUnderstanding,
  confirmation: { revision: 2, summaryHash: "synthetic-hash", confirmedAt: "2026-11-01T02:00:00.000Z" } });
async function setup() {
  const repository = createMemoryAgentRepository(); let session = confirmed(); let reads = 0;
  const agent = new BetterMeAgent("isolated-document", repository, async () => { reads++; return structuredClone(session); }); await agent.ready;
  agent.reconcileSources([{ key: "synthetic-field", text: session.sourceText }]); agent.observeUnderstanding(session, "synthetic-field"); await agent.flush();
  return { agent, repository, setSession(value: typeof session) { session = value; }, reads: () => reads, memoryId: `project:${session.id}` };
}

test("task lifetime and complete history survive view unsubscribe and remount", async () => {
  const { agent, repository } = await setup(); const response = deferred<string>(), started = deferred<void>();
  const unsubscribe = agent.subscribe(() => {});
  const request = agent.run(descriptor, async () => { started.resolve(); return response.promise; }, value => value);
  await started.promise; unsubscribe(); agent.setCenterOpen(false);
  assert.equal(agent.getSnapshot().data.tasks.at(-1)?.status, "running");
  response.resolve("合成回复"); assert.equal(await request, "合成回复");
  const restored = new BetterMeAgent("isolated-document", repository, async () => confirmed()); await restored.ready;
  assert.equal(restored.getSnapshot().data.tasks.at(-1)?.status, "completed");
  assert.deepEqual(restored.getSnapshot().data.messages.filter(message => message.origin === "companion").map(message => message.text), ["讨论合成项目", "合成回复"]);
});
test("local practice shares unified task lifetime without claiming to wait for a model", async () => {
  const { agent, reads } = await setup(), started = deferred<void>(), result = deferred<string>();
  const pending = agent.run({ ...descriptor, origin: "growth", execution: "local", shareMemories: false, destination: "浏览器隔离沙盒" }, async (_signal, context) => {
    assert.equal(context.text, ""); started.resolve(); return result.promise;
  }, value => value);
  await started.promise;
  assert.match(agent.getSnapshot().data.tasks.at(-1)?.detail ?? "", /隔离练习.*不调用模型/);
  assert.equal(reads(), 0); agent.setCenterOpen(false);
  result.resolve("11/11 实际测试通过；不是能力认证。"); await pending;
  assert.equal(agent.getSnapshot().data.tasks.at(-1)?.status, "completed");
});
test("confirmed project background requires both sharing and per-request permission; does not become personal claims", async () => {
  const { agent, memoryId, reads } = await setup();
  assert.equal(agent.getSnapshot().data.memories[0]?.shared, false);
  let context = "";
  await agent.run({ ...descriptor, shareMemories: true }, async (_signal, provided) => { context = provided.text; return "未共享"; }, value => value);
  assert.equal(context, ""); assert.equal(reads(), 0);
  agent.shareMemory(memoryId, true);
  await agent.run(descriptor, async (_signal, provided) => { context = provided.text; return "未逐次授权"; }, value => value); assert.equal(context, "");
  await agent.run({ ...descriptor, shareMemories: true }, async (_signal, provided) => { context = provided.text; return "使用项目背景"; }, value => value);
  assert.match(context, /仅术语与系统背景，不是个人贡献/); assert.match(context, /不负责车辆控制/);
  assert.doesNotMatch(context, /"claims"|"grants"|"excerpt"/); assert.equal(reads(), 2);
});
test("revoking memory stops an uncooperative in-flight provider and rejects its late answer", async () => {
  const { agent, memoryId } = await setup(); agent.shareMemory(memoryId, true);
  const response = deferred<string>(), started = deferred<void>();
  const request = agent.run({ ...descriptor, shareMemories: true }, async () => { started.resolve(); return response.promise; }, value => value);
  await started.promise; agent.shareMemory(memoryId, false);
  await assert.rejects(request, /授权已变化/); response.resolve("不应采用的迟到答复");
  await agent.flush(); assert.equal(agent.getSnapshot().data.tasks.at(-1)?.status, "cancelled");
  assert.equal(agent.getSnapshot().data.messages.some(message => message.text.includes("不应采用")), false);
  assert.equal(agent.reusableCompanionHistory(true).some(message => message.text === descriptor.input), false);
});
test("remote grant/consensus invalidation is checked before sending and again before adopting", async () => {
  const first = await setup(); first.agent.shareMemory(first.memoryId, true);
  first.setSession(fixtureSession({ revision: 3, phase: "idle" })); let calls = 0;
  await assert.rejects(first.agent.run({ ...descriptor, shareMemories: true }, async () => { calls++; return "not-called"; }, value => value), /共识或资料授权已变化/);
  assert.equal(calls, 0);
  const second = await setup(); second.agent.shareMemory(second.memoryId, true);
  const response = deferred<string>(), started = deferred<void>();
  const task = second.agent.run({ ...descriptor, shareMemories: true }, async () => { started.resolve(); return response.promise; }, value => value);
  await started.promise; second.setSession(fixtureSession({ revision: 3, phase: "idle" })); response.resolve("远端撤销后的答复");
  await assert.rejects(task, /共识或资料授权已变化/);
  assert.equal(second.agent.getSnapshot().data.messages.some(message => message.text === "远端撤销后的答复"), false);
});
test("source changes invalidate consent and polling old confirmed sessions cannot resurrect it", async () => {
  const { agent, memoryId } = await setup(); agent.shareMemory(memoryId, true);
  agent.reconcileSources([{ key: "synthetic-field", text: "已修改原文" }]);
  agent.observeUnderstanding(confirmed(), "synthetic-field");
  assert.equal(agent.getSnapshot().data.memories[0]?.valid, false);
  assert.equal(agent.getSnapshot().data.memories[0]?.shared, false);
});
test("persistence conflicts block model calls and never overwrite the winning history", async () => {
  const repository = createMemoryAgentRepository();
  const first = new BetterMeAgent("same-key", repository, async () => confirmed()), second = new BetterMeAgent("same-key", repository, async () => confirmed());
  await Promise.all([first.ready, second.ready]);
  first.record({ id: "first", origin: "companion", role: "user", text: "对方窗口内容" }); await first.flush(); let calls = 0;
  await assert.rejects(second.run(descriptor, async () => { calls++; return "no"; }, value => value), /另一窗口/);
  assert.equal(calls, 0); assert.equal((await repository.load("same-key"))?.messages[0]?.text, "对方窗口内容");
  await second.reload(); assert.equal(second.getSnapshot().data.messages[0]?.text, "对方窗口内容");
});
test("reload never silently retries billing; local tasks become interrupted", async () => {
  const repository = createMemoryAgentRepository(), state = emptyAgentState("reload-fixture"); state.revision = 1;
  state.tasks.push({ id: "pending", origin: "growth", label: "待恢复规划", destination: "选择的模型", status: "running", at: "2026-11-01T01:00:00Z", updatedAt: "2026-11-01T01:00:00Z", memoryIds: [] });
  await repository.save(state, 0); let reads = 0;
  const agent = new BetterMeAgent("reload-fixture", repository, async () => { reads++; return confirmed(); }); await agent.flush();
  assert.equal(agent.getSnapshot().data.tasks[0]?.status, "interrupted"); assert.equal(reads, 0);
});
test("history is durable beyond the model window; tracking is prospective and opt-in", async () => {
  const { agent, repository } = await setup();
  for (let index = 0; index < 65; index++) agent.record({ id: `history-${index}`, origin: "companion", role: index % 2 ? "assistant" : "user", text: `合成历史${index}` });
  agent.track({ id: "before", kind: "evidence", label: "未授权追踪", origin: "growth" }); assert.equal(agent.getSnapshot().data.events.length, 0);
  agent.setTracking(true);
  agent.track({ id: "after", kind: "evidence", label: "本人提交证据，不代表掌握", origin: "growth" });
  agent.track({ id: "after", kind: "evidence", label: "重复事件", origin: "growth" });
  agent.setTracking(false); agent.track({ id: "disabled", kind: "evidence", label: "停止之后", origin: "growth" });
  await agent.flush(); assert.equal(agent.getSnapshot().data.events.length, 1);
  assert.equal(agent.reusableCompanionHistory().length, 24);
  assert.equal((await repository.load(agent.workspaceKey))?.messages.filter(message => message.origin === "companion").length, 65);
});
test("namespace isolation, explicit model changes, cancellation and duplicate-run guards", async () => {
  const { agent, repository } = await setup(); const response = deferred<string>(), started = deferred<void>();
  const task = agent.run({ ...descriptor, id: "selected-task" }, async () => { started.resolve(); return response.promise; }, value => value);
  await started.promise; agent.setSelection({ kind: "chatgpt", profileId: "isolated-account", model: "synthetic-gpt" });
  await assert.rejects(task, /停止或授权已变化/); response.resolve("不回退其他提供方");
  await assert.rejects(agent.run({ ...descriptor, id: "selected-task" }, async () => "duplicate", value => value), /同一任务/);
  const other = new BetterMeAgent("different-document", repository, async () => confirmed()); await other.ready;
  assert.equal(other.getSnapshot().data.messages.length, 0); assert.equal(other.getSnapshot().data.memories.length, 0);
});
test("quoted project sources bind the whole field; deletion cannot be resurrected by stale polling", async () => {
  const repository = createMemoryAgentRepository(), session = confirmed();
  const agent = new BetterMeAgent("quote-fixture", repository, async () => session); await agent.ready;
  agent.reconcileSources([{ key: "quoted-field", text: `前文。${session.sourceText}后文。` }], true);
  agent.observeUnderstanding(session, "quoted-field"); agent.shareMemory(`project:${session.id}`, true);
  await agent.run({ ...descriptor, shareMemories: true }, async (_signal, context) => { assert.match(context.text, /任务回执/); return "quote works"; }, text => text);
  agent.reconcileSources([], true); agent.observeUnderstanding({ ...session, updatedAt: "2026-11-01T05:00:00Z" }, "quoted-field");
  assert.equal(agent.getSnapshot().data.memories[0]?.valid, false);
  assert.equal(agent.getSnapshot().data.memories[0]?.shared, false);
});
test("changing the shared goal rejects late results and excludes derived dialogue from later requests", async () => {
  const { agent } = await setup(); agent.setGoal("旧目标");
  await agent.run({ ...descriptor, shareMemories: true }, async (_signal, context) => { assert.match(context.text, /旧目标/); return "基于旧目标"; }, text => text);
  const response = deferred<string>(), started = deferred<void>();
  const pending = agent.run({ ...descriptor, shareMemories: true }, async () => { started.resolve(); return response.promise; }, text => text);
  await started.promise; agent.setGoal("新目标"); response.resolve("旧目标迟到结果");
  await assert.rejects(pending, /共享目标或授权已变化/);
  assert.equal(agent.reusableCompanionHistory(true).length, 0);
  assert.equal(agent.getSnapshot().data.messages.some(message => message.text === "基于旧目标"), true, "archived history remains visible");
});
test("an unavailable Agent store fails before any model call without deleting data", async () => {
  const agent = new BetterMeAgent("quota-fixture", { load: async () => undefined, save: async () => { throw new Error("隔离磁盘写入失败"); } }, async () => confirmed());
  await agent.ready; let calls = 0;
  await assert.rejects(agent.run(descriptor, async () => { calls++; return "no"; }, text => text), /写入失败/);
  assert.equal(calls, 0); assert.equal(agent.getSnapshot().data.messages[0]?.text, descriptor.input);
  assert.equal(agent.getSnapshot().data.tasks.at(-1)?.status, "failed");
});
test("a three-minute response timeout preserves input and requires an explicit retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { agent } = await setup(), started = deferred<void>(); let calls = 0;
  const pending = agent.run(descriptor, async () => { calls++; started.resolve(); return new Promise<string>(() => {}); }, text => text);
  await started.promise;
  const rejection = assert.rejects(pending, /等待超时.*未自动补发/);
  t.mock.timers.tick(180001); await rejection; await agent.flush();
  assert.equal(calls, 1); assert.equal(agent.getSnapshot().data.tasks.at(-1)?.status, "failed");
  assert.equal(agent.getSnapshot().data.messages.at(-1)?.text, descriptor.input);
});
test("resume-derived conversation remains archived but cannot be resent after resume sharing is off", async () => {
  const { agent } = await setup();
  await agent.run({ ...descriptor, resumeShared: true }, async () => "基于本轮授权摘要的回复", text => text);
  assert.equal(agent.reusableCompanionHistory().length, 0);
  assert.equal(agent.reusableCompanionHistory(false, true).length, 2);
  assert.equal(agent.getSnapshot().data.messages.filter(message => message.origin === "companion").length, 2);
});
