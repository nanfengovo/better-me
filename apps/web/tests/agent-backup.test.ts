import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentBackup, parseAgentBackup } from "../src/lib/betterme-agent/backup";
import { createMemoryAgentRepository, emptyAgentState } from "../src/lib/betterme-agent/storage";
import { BetterMeAgent } from "../src/lib/betterme-agent/kernel";
import { fixtureSession } from "./fixtures/project-understanding";

function backup() {
  const state = emptyAgentState("isolated-old");
  state.goal = "不能替换当前目标"; state.tracking = true; state.selection = { kind: "chatgpt", profileId: "old-account", model: "old-model" };
  state.tasks.push({ id: "t1", origin: "companion", label: "旧任务", destination: "旧模型", at: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", status: "running", memoryIds: ["m1"], remote: { sessionId: "host-session", turnCount: 2 } });
  state.memories.push({ id: "m1", workspaceKey: "isolated-old", projectKey: "project", targetKey: "field", sessionId: "host-session", label: "项目共识", revision: 2, summary: "项目背景不是个人贡献", summaryHash: "hash", sourceText: "原文", at: "2026-11-01T00:00:00Z", valid: true, shared: true });
  state.messages.push({ id: "msg", origin: "companion", role: "assistant", text: "旧的项目理解", at: "2026-11-01T00:00:00Z", taskId: "t1", memoryIds: ["m1"], resumeShared: true });
  return state;
}
test("backup validation rejects oversized, malformed, duplicate and executable unknown fields", () => {
  assert.throws(() => parseAgentBackup("{"), /有效/);
  assert.throws(() => parseAgentBackup("x".repeat(8 * 1024 * 1024 + 1)), /8 MB/);
  const duplicated = backup(); duplicated.messages.push(duplicated.messages[0]!);
  assert.throws(() => parseAgentBackup(JSON.stringify(duplicated)), /重复/);
  assert.throws(() => parseAgentBackup(JSON.stringify({ ...backup(), apiKey: "not-a-real-key" })), /结构/);
});
test("restore appends archives only; does not restore grants, destinations, tasks or sharing", () => {
  const current = emptyAgentState("current"); current.goal = "当前目标";
  const saved = structuredClone(current);
  const { state, added } = mergeAgentBackup(current, backup());
  assert.deepEqual(current, saved); assert.equal(added, 3); assert.equal(state.goal, current.goal); assert.equal(state.tracking, false);
  assert.deepEqual(state.selection, current.selection); assert.equal(state.workspaceKey, "current");
  assert.equal(state.tasks[0]?.status, "interrupted"); assert.equal(state.tasks[0]?.remote, undefined);
  assert.equal(state.memories[0]?.valid, false); assert.equal(state.memories[0]?.shared, false);
  assert.match(state.memories[0]?.sessionId ?? "", /^backup:/); assert.equal(state.messages[0]?.archived, true);
  assert.equal(state.messages[0]?.taskId, state.tasks[0]?.id); assert.deepEqual(state.messages[0]?.memoryIds, [state.memories[0]?.id]);
});
test("repeated import deduplicates and changed same-id backup fails atomically", () => {
  const once = mergeAgentBackup(emptyAgentState("current"), backup()).state;
  assert.equal(mergeAgentBackup(once, backup()).added, 0);
  const changed = backup(); changed.messages[0]!.text = "同标识的另一版本";
  const before = structuredClone(once);
  assert.throws(() => mergeAgentBackup(once, changed), /冲突/); assert.deepEqual(once, before);
});
test("import is persisted and never offered as implicit model chat history", async () => {
  const repo = createMemoryAgentRepository(); let reads = 0;
  const agent = new BetterMeAgent("current", repo, async () => { reads++; return fixtureSession(); }); await agent.ready;
  assert.equal(await agent.importBackup(JSON.stringify(backup())), 3);
  assert.deepEqual(agent.reusableCompanionHistory(true, true), []); assert.equal(reads, 0);
  const loaded = await repo.load("current"); assert.equal(loaded?.messages.length, 1);
  const restored = new BetterMeAgent("current", repo, async () => fixtureSession()); await restored.ready;
  assert.equal(restored.getSnapshot().data.messages[0]?.text, "旧的项目理解");
  assert.equal(await restored.importBackup(JSON.stringify(backup())), 0);
});
test("restoring during a live task is rejected without aborting or changing it", async () => {
  const agent = new BetterMeAgent("current", createMemoryAgentRepository(), async () => fixtureSession()); await agent.ready;
  let resolve!: (value: string) => void, start!: () => void, signal!: AbortSignal;
  const started = new Promise<void>(done => { start = done; });
  const run = agent.run({ origin: "companion", label: "当前任务", input: "当前输入", destination: "隔离模型" }, async current => { signal = current; start(); return new Promise<string>(done => { resolve = done; }); }, value => value);
  await started; await assert.rejects(agent.importBackup(JSON.stringify(backup())), /任务完成/);
  assert.equal(signal.aborted, false); assert.equal(agent.getSnapshot().data.memories.length, 0);
  resolve("真实回执"); await run;
});
