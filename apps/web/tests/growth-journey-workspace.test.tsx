import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { Window } from "happy-dom";
import { GROWTH_PRACTICE_RUNTIME, GrowthJourneySchema, growthPracticeCheckpointHash, growthPracticeRequestHash,
  growthPracticeResultHash, growthPracticeVerificationHash, type GrowthJourneyCommand } from "@better-me/agent-contracts";
import { activatePrincipal, capturePrivateStorage } from "../src/lib/identity";
import type { GrowthJourneyClient } from "../src/services/growth-journey-client";

registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
} });

const dom = new Window({ url: "https://synthetic-growth.invalid/?workspace=agent" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLSelectElement: dom.HTMLSelectElement, Element: dom.Element,
  Node: dom.Node, Event: dom.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { GrowthJourneyWorkspace } = await import("../src/components/GrowthJourneyWorkspace");
let root: ReturnType<typeof createRoot> | undefined;
const owner = { id: "11111111-1111-4111-8111-111111111111", username: "synthetic-growth", displayName: "合成成长用户" };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceText = "工具结果写入检查点以后，恢复只读取已有结果，不应再次调用工具。";
const submittedCode = "  export const lookup = noteId => noteId  \n";
const submittedAnswer = "恢复时应先读取已经保存的检查点。";
const submittedExplanation = "  恢复只读取已经保存的结果。  ";
const source = { id: "checkpoint-note-v1" as const, version: "source-v1", title: "检查点与恢复（合成教材）",
  text: sourceText, hash: sha(sourceText), locator: "合成教材 · 第 1 节 · 保存断点",
  provenance: "authored_synthetic" as const };
const goal = { id: "goal-1", revision: 1 as const, title: "  建立可恢复的 Agent 小项目  ", targetWeeks: 12, weeklyHours: 3,
  successCriteria: "完成合成 lookup、恢复与固定验收。" };
const time = "2026-11-13T00:00:00.000Z";
function journey(stage: "choose_source" | "practice" | "checkpoint_saved" | "verification_failed" | "ready_for_acceptance" | "completed", revision: number, taskId = "practice-task-1") {
  const request = { sourceId: "checkpoint-note-v1" as const, sourceText, sourceHash: source.hash, sourceCode: submittedCode,
    answer: submittedAnswer, explanation: submittedExplanation };
  const checkpoint = stage === "checkpoint_saved" || stage === "verification_failed" || stage === "ready_for_acceptance" || stage === "completed"
    ? { stepId: "lookup-note-v1" as const, lookupCalls: 1 as const, noteId: "checkpoint-note-v1" as const, result: source.text, resultHash: sha(source.text), savedAt: time } : undefined;
  const verified = stage === "ready_for_acceptance" || stage === "completed", checked = verified || stage === "verification_failed";
  const verification = checked ? { verifierVersion: "growth-practice-quickjs-v1" as const, sourceHash: source.hash,
    sourceCodeHash: sha(submittedCode), checkpointHash: growthPracticeCheckpointHash(checkpoint!),
    resultHash: growthPracticeResultHash({ kind: "finish", answer: request.answer, explanation: request.explanation,
      citedSourceId: checkpoint!.noteId, citedResultHash: checkpoint!.resultHash }),
    passed: verified ? 4 : 3, total: 4 as const, verifiedAt: time,
    checks: (["correct-reference", "unknown-explicit", "forbidden-tool-rejected", "resume-uses-checkpoint"] as const).map(id => ({ id, passed: verified || id !== "resume-uses-checkpoint" })) } : undefined;
  const verificationHash = verification ? growthPracticeVerificationHash(verification) : undefined;
  const task = stage === "choose_source" || stage === "practice" && revision < 3 ? undefined : {
    kind: "growth_practice" as const, id: taskId, ownerId: owner.id, workspaceKey: "growth:journey-1",
    objective: "完成只读 lookup 并验证检查点恢复", revision: verified || stage === "verification_failed" ? 3 : stage === "checkpoint_saved" ? 2 : 1,
    status: verified ? "completed" : stage === "verification_failed" ? "failed" : stage === "checkpoint_saved" ? "awaiting_review" : "ready",
    createdAt: time, updatedAt: time, rootScopeKey: "growth:journey-1", rootTaskId: taskId,
    request, sourceFingerprint: growthPracticeRequestHash(request), runtimeBinding: GROWTH_PRACTICE_RUNTIME,
    budget: { maxModelCalls: 1, maxToolCalls: 32, maxActiveMs: 600_000 }, usage: { modelCalls: 0, toolCalls: checked ? 6 : checkpoint ? 2 : 0, activeMs: 10 }, events: [],
    practice: { phase: verified ? "verified" : stage === "verification_failed" ? "failed" : checkpoint ? "lookup_saved" : "ready", checkpoint,
      verification, verificationHash },
  };
  return GrowthJourneySchema.parse({ id: "journey-1", ownerId: owner.id, revision, mode: "synthetic" as const, createdAt: time, updatedAt: time,
    goal, stage, source: stage === "choose_source" ? undefined : source, taskIds: task ? [task.id] : [], task,
    reportHash: verified ? verificationHash : undefined,
    project: stage === "completed" ? { id: "project-1", revision: 1 as const, taskId, sourceCodeHash: sha(submittedCode),
      reportHash: verificationHash, acceptedAt: time, attribution: "guided_example" as const, scope: "synthetic_practice" as const,
      mastery: "pending_retest" as const } : undefined,
    events: [] });
}
async function settle(action: () => unknown = () => {}) {
  await React.act(async () => { action(); await tick(); await tick(); await tick(); });
}
async function mount(client: GrowthJourneyClient) {
  const host = dom.document.createElement("main"); dom.document.body.append(host); root = createRoot(host as unknown as Element);
  await settle(() => root!.render(React.createElement(GrowthJourneyWorkspace, { client })));
}
async function unmount() { await settle(() => root?.unmount()); root = undefined; dom.document.body.replaceChildren(); }
function body() { return dom.document.body.textContent ?? ""; }
function button(id: string) { const found = dom.document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`); assert.ok(found, `missing ${id}: ${body()}`); return found; }
function textButton(label: string) { const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); assert.ok(found, `missing ${label}: ${body()}`); return found; }
async function click(id: string) { await settle(() => button(id).click()); }
async function fill(name: string, value: string) {
  const field = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`); assert.ok(field, `missing ${name}`);
  await settle(() => { const proto = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : field.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field.dispatchEvent(new dom.Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
}

beforeEach(() => activatePrincipal(owner));
afterEach(async () => { await unmount(); activatePrincipal(undefined); dom.localStorage.clear(); });
after(() => dom.happyDOM.abort());

test("a synthetic growth journey reaches a verified project and reopening is read-only without repeating lookup", async () => {
  let current = journey("choose_source", 1); const calls: string[] = []; const writes: unknown[] = [];
  const client: GrowthJourneyClient = {
    sources: async () => { calls.push("sources"); return [source]; },
    list: async () => { calls.push("list"); return current.stage === "choose_source" && current.revision === 1 && writes.length === 0 ? [] : [current]; },
    get: async id => { calls.push("get"); assert.equal(id, current.id); return current; },
    create: async input => { calls.push("create"); writes.push(input); assert.equal(input.goal.title, goal.title); return current; },
    command: async (id, command) => {
      calls.push(`command:${command.kind}`); writes.push(command); assert.equal(id, current.id);
      if (command.kind === "select_source") current = journey("practice", 2);
      else if (command.kind === "submit_practice") { assert.equal(command.sourceCode, submittedCode); assert.equal(command.answer, submittedAnswer); assert.equal(command.explanation, submittedExplanation); current = journey("practice", 3); }
      else if (command.kind === "step_practice") current = current.stage === "checkpoint_saved" ? journey("ready_for_acceptance", 5) : journey("checkpoint_saved", 4);
      else current = journey("completed", 6);
      return current;
    },
  };

  await mount(client); assert.match(body(), /第一条成长闭环/); assert.doesNotMatch(body(), /lookup 调用 1 次/);
  await fill("growth-goal", goal.title); await click("growth-create");
  await click("growth-source"); assert.match(body(), /合成教材 · 第 1 节 · 保存断点/);
  await click("growth-example");
  await fill("growth-source-code", submittedCode);
  await fill("growth-explanation", submittedExplanation);
  await click("growth-submit"); assert.doesNotMatch(body(), /lookup 调用 1 次/);
  await click("growth-step"); assert.match(body(), /lookup 调用 1 次/); assert.match(body(), /现在可以关闭/);
  await click("growth-step"); assert.match(body(), /固定验收 4\/4/); assert.match(body(), /待本人验收/);
  await click("growth-accept"); assert.match(body(), /项目已验收/); assert.match(body(), /待隔时复测/);
  assert.equal(calls.filter(call => call === "command:step_practice").length, 2);
  const writesBeforeReopen = writes.length;

  await unmount(); await mount(client);
  assert.equal(writes.length, writesBeforeReopen, "reopening must not issue a command");
  assert.deepEqual(calls.slice(-3), ["sources", "list", "get"]);
  assert.match(body(), /已恢复记录，未重新执行/); assert.match(body(), /lookup 调用 1 次/); assert.match(body(), /项目已验收/);
});

test("a failed verification keeps its receipt and starts a new attempt only after an explicit resubmission", async () => {
  let current = journey("verification_failed", 4); const commands: string[] = [];
  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = {
    sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { throw new Error("must not replace the goal"); },
    command: async (_id, command) => { commands.push(command.kind); assert.equal(command.kind, "submit_practice"); current = journey("practice", 5, "practice-task-2"); return current; },
  };
  await mount(client);
  assert.match(body(), /固定验收未通过/); assert.match(body(), /lookup 调用 1 次/); assert.equal(commands.length, 0);
  await click("growth-example"); await click("growth-submit");
  assert.deepEqual(commands, ["submit_practice"]); assert.match(body(), /practice-task-2/); assert.doesNotMatch(body(), /固定验收未通过/);
});

test("an oversized practice draft is rejected visibly without replacing the last saved text or dispatching", async () => {
  const current = journey("practice", 2); let writes = 0; capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { writes++; throw new Error("unexpected create"); }, command: async () => { writes++; throw new Error("unexpected command"); } };
  await mount(client); await fill("growth-source-code", "保留这段已保存的合成代码");
  await fill("growth-source-code", "x".repeat(16001));
  assert.match(body(), /代码最多 16000 个字符/); assert.equal(dom.document.querySelector<HTMLTextAreaElement>('[name="growth-source-code"]')?.value, "保留这段已保存的合成代码");
  assert.equal(writes, 0);
});

test("an invalid numeric goal bound is rejected without replacing the saved value", async () => {
  let writes = 0;
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [], get: async () => { throw new Error("unexpected get"); },
    create: async () => { writes++; return journey("choose_source", 1); }, command: async () => { writes++; throw new Error("unexpected command"); } };
  await mount(client); await fill("growth-weekly-hours", "0");
  assert.match(body(), /每周投入请输入 1–40 的整数/);
  assert.equal(dom.document.querySelector<HTMLInputElement>('[name="growth-weekly-hours"]')?.value, "3"); assert.equal(writes, 0);
});

test("an unknown command survives reopening and is resent only after explicit confirmation with the exact request id", async () => {
  let current = journey("checkpoint_saved", 4); let firstCommand: GrowthJourneyCommand | undefined; const commandCalls: GrowthJourneyCommand[] = [];
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { throw new Error("unexpected create"); },
    command: async (_id, command) => {
      commandCalls.push(structuredClone(command));
      if (!firstCommand) {
        firstCommand = structuredClone(command);
        const task = current.task!;
        current = GrowthJourneySchema.parse({ ...current, stage: "outcome_unknown", pendingCommand: command,
          task: { ...task, status: "interrupted", practice: { ...task.practice, phase: "outcome_unknown" } } });
        throw new Error("synthetic receipt lost");
      }
      assert.deepEqual(command, firstCommand);
      current = journey("ready_for_acceptance", 5);
      return current;
    } };

  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  await mount(client); await click("growth-step");
  assert.equal(commandCalls.length, 1); assert.match(body(), /不会自动重复执行/);
  await unmount(); await mount(client);
  assert.equal(commandCalls.length, 1); assert.match(body(), /核对后继续未确认操作/);
  await click("growth-read-existing"); assert.equal(commandCalls.length, 1);
  await click("growth-resume-pending");
  assert.equal(commandCalls.length, 2); assert.deepEqual(commandCalls[1], commandCalls[0]); assert.match(body(), /固定验收 4\/4/);
});

test("a synchronous double click dispatches a growth command only once", async () => {
  const current = journey("practice", 3); let writes = 0; let finish!: (value: typeof current) => void;
  const deferred = new Promise<typeof current>(resolve => { finish = resolve; });
  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { throw new Error("unexpected create"); }, command: async () => { writes++; return deferred; } };
  await mount(client);
  await React.act(async () => { const run = button("growth-step"); run.click(); run.click(); await tick(); });
  assert.equal(writes, 1); await settle(() => finish(journey("checkpoint_saved", 4)));
});

test("a read and mutation started in the same turn cannot race and overwrite the newer view", async () => {
  const current = journey("practice", 3); let reads = 0, writes = 0; let finishRead!: (value: typeof current) => void;
  const deferredRead = new Promise<typeof current>(resolve => { finishRead = resolve; });
  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current],
    get: async () => ++reads === 1 ? current : deferredRead, create: async () => { throw new Error("unexpected create"); },
    command: async () => { writes++; return journey("checkpoint_saved", 4); } };
  await mount(client);
  await React.act(async () => { textButton("重新读取记录").click(); button("growth-step").click(); await tick(); });
  assert.equal(writes, 0); await settle(() => finishRead(current)); assert.equal(reads, 2);
});

test("attempt history preserves source, original answers, checks and per-attempt usage without claiming mastery", async () => {
  const failed = journey("verification_failed", 4, "practice-task-old").task!;
  const completed = journey("completed", 6, "practice-task-new");
  const current = GrowthJourneySchema.parse({ ...completed, attempts: [failed, completed.task!],
    attemptAttributions: { [failed.id]: "self_reported", [completed.task!.id]: "guided_example" } });
  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { throw new Error("unexpected create"); }, command: async () => { throw new Error("unexpected command"); } };
  await mount(client);
  assert.match(body(), /尝试历史（2）/); assert.match(body(), /本人自述（未认证独立完成）/); assert.match(body(), /教学辅助样例/);
  assert.match(body(), /原答与解释未经语义评分/); assert.match(body(), /导出练习与验收记录/);
});

test("an exhausted practice stays readable without offering a new attempt or execution", async () => {
  const saved = journey("checkpoint_saved", 4);
  const current = GrowthJourneySchema.parse({ ...saved, stage: "verification_failed", task: { ...saved.task!,
    status: "budget_exhausted", error: "tool_call_budget", practice: { ...saved.task!.practice, phase: "failed", error: "tool_call_budget" } } });
  let writes = 0;
  capturePrivateStorage().setItem("growth-journey.active.v1", current.id);
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [current], get: async () => current,
    create: async () => { writes++; throw new Error("must not create a new root"); },
    command: async () => { writes++; throw new Error("must not dispatch"); } };
  await mount(client);
  assert.match(body(), /已达固定额度上限/); assert.match(body(), /不建立新尝试、不新开根任务/);
  assert.match(body(), /lookup 调用 1 次/); assert.ok(textButton("导出练习与验收记录"));
  assert.equal(dom.document.querySelector('[data-testid="growth-example"]'), null);
  assert.equal(dom.document.querySelector('[data-testid="growth-submit"]'), null);
  assert.equal(dom.document.querySelector('[data-testid="growth-step"]'), null);
  assert.equal(dom.document.querySelector('[data-testid="growth-accept"]'), null);
  assert.equal(writes, 0);
});

test("an uncertain create reuses its owner-persisted idempotency key after reopening", async () => {
  const created = journey("choose_source", 1); const keys: string[] = [];
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [], get: async () => { throw new Error("unexpected get"); },
    create: async input => { keys.push(input.idempotencyKey); if (keys.length === 1) throw new Error("synthetic receipt lost"); return created; },
    command: async () => { throw new Error("unexpected command"); } };
  await mount(client); await fill("growth-goal", goal.title); await click("growth-create"); assert.equal(keys.length, 1);
  await unmount(); await mount(client); assert.match(body(), /没有确认目标是否创建|创建合成目标/);
  await click("growth-create"); assert.equal(keys.length, 2); assert.equal(keys[1], keys[0]); assert.match(body(), /选择一份资料/);
});

test("a failed synchronous operation-journal write blocks the POST and keeps the draft available", async () => {
  let writes = 0;
  const client: GrowthJourneyClient = { sources: async () => [source], list: async () => [], get: async () => { throw new Error("unexpected get"); },
    create: async () => { writes++; return journey("choose_source", 1); }, command: async () => { writes++; throw new Error("unexpected command"); } };
  await mount(client); await fill("growth-goal", goal.title);
  const original = dom.localStorage.setItem;
  Object.defineProperty(dom.localStorage, "setItem", { configurable: true, value: () => { throw new Error("synthetic quota"); } });
  try {
    await click("growth-create"); assert.equal(writes, 0); assert.match(body(), /操作编号未能安全保存/); assert.match(body(), /下载本页草稿/);
  } finally {
    Object.defineProperty(dom.localStorage, "setItem", { configurable: true, value: original });
  }
  await fill("growth-goal", `${goal.title}。`);
});
