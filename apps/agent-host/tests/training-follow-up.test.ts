import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type {
  StudioDesign, TrainingCareerContext, TrainingCareerRef, TrainingFollowRef, TrainingFollowSource,
  TrainingPlan, TrainingView,
} from "@better-me/agent-contracts";
import { LearningStore } from "../src/growth/learning-store.js";
import { TrainingKits } from "../src/growth/training-kits.js";
import type { TrainingAuthor } from "../src/growth/training-model.js";

const goal = "为换景清单写一个时长换算函数";
const access = { session: "fixture-owner-session", valid: async () => true };
const source = "  minutes => {\n  return minutes * 2;\n}  ";
const otherAnswer = "这段独立说明属于另一项作答";
const answer = { codeKey: "part1", parts: { part1: source, part2: otherAnswer } };
const design: StudioDesign = {
  kind: "studio", title: "排练时长",
  scenes: [
    { brief: "双场排练", situation: "需要计算两场相同排练的总时长。", steps: [
      { mode: "code", prompt: "把单场排练时长换算为双场总时长",
        cases: [{ input: 3, expected: 6 }, { input: 8, expected: 16 }],
        followUp: "先手算三分钟的例子", extend: "再为半场排练写一次换算" },
      { mode: "write", prompt: "说明采用的假设", followUp: "检查有哪些例外", extend: "列出两个适用场景" },
    ] },
    { brief: "搭台移交", situation: "取消其中两分钟的空档，提交新的换算。", steps: [
      { mode: "code", prompt: "扣除交接空档", cases: [{ input: 4, expected: 2 }, { input: 7, expected: 5 }],
        followUp: "画出四分钟移交的时间线", extend: "重算九分钟的安排" },
    ] },
  ],
};
const request = (followFrom?: TrainingFollowRef, careerTarget?: TrainingCareerRef) => ({
  requestId: randomUUID(), consent: true, goal, evidence: "", engine: { type: "local", model: "synthetic-studio" },
  followFrom, careerTarget,
});
const build = (planId: string) => ({ planId, requestId: randomUUID(), consent: true });
const ref = (parent: TrainingView): TrainingFollowRef => ({
  kitId: parent.id, version: parent.version, round: "practice", key: "part1",
});
const unavailable = /training_(follow_source_changed|kit_not_found)/;
function scenarioTarget(): TrainingCareerContext {
  return {
    workspaceKey: "synthetic-workspace", targetId: randomUUID(), competency: goal, goal, goalId: "goal",
    planId: "plan", planTitle: "排练计划", taskId: "task", taskTitle: "换算时长", criterion: "用函数转换时长",
    requirement: { title: "合成岗位", company: "合成单位", snapshotVersion: "e".repeat(64), itemId: "time", quote: "安排排练" },
  };
}
async function setup(t: TestContext, overrides: Partial<TrainingAuthor> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "betterme-follow-up-test-"));
  const opened: { kits: TrainingKits; store: LearningStore }[] = [];
  t.after(async () => {
    for (const { kits, store } of opened) { kits.close(); await store.close(); }
    await rm(dir, { recursive: true, force: true });
  });
  const diagnoses: (TrainingFollowSource | undefined)[] = [], designs: TrainingPlan[] = [];
  const target = scenarioTarget();
  const gates: {
    diagnose?: () => Promise<void>; design?: () => Promise<void>;
  } = {};
  const author: TrainingAuthor = {
    pin: async () => "a".repeat(64),
    diagnose: async (_model, _pin, _goal, _notes, _signal, _career, selection) => {
      diagnoses.push(selection);
      if (selection) await gates.diagnose?.();
      return { route: "studio", observation: "尝试一次转换", nextStep: "练习换算" };
    },
    design: async plan => {
      designs.push(plan);
      if (plan.followFrom) await gates.design?.();
      return { ...design, title: plan.followFrom ? "继续练习换算" : design.title };
    },
    program: async () => { throw Error("Unexpected separate model computation"); },
    ...overrides,
  };
  function open(owner: string) {
    const store = new LearningStore(owner, path.join(dir, owner));
    const kits = new TrainingKits(store, author, Date.now, async ({ targetId, workspaceKey }) =>
      target.targetId === targetId && target.workspaceKey === workspaceKey ? target : undefined);
    const entry = { kits, store }; opened.push(entry);
    return entry;
  }
  const owner = randomUUID(), home = open(owner);
  async function newParent(careerTarget?: TrainingCareerRef) {
    const plan = await home.kits.plan(request(undefined, careerTarget), access);
    return home.kits.build(build(plan.id), access);
  }
  async function savedParent(careerTarget?: TrainingCareerRef) {
    const parent = await newParent(careerTarget);
    const peek = await home.kits.command(parent.id, { action: "explore", revision: parent.revision, round: "practice", answer }, access);
    const done = await home.kits.command(parent.id, { action: "submit", revision: peek.kit!.revision, round: "practice", answer }, access);
    return (await home.kits.command(parent.id, { action: "keep", revision: done.kit!.revision }, access)).kit!;
  }
  return { owner, home, open, target, gates, diagnoses, designs, savedParent, newParent };
}

test("continuation needs a retained original, an actual submitted step, and its exact owner, goal, career and version", async t => {
  const h = await setup(t), kits = h.home.kits;
  const unsaved = await h.newParent();
  const attempt = await kits.command(unsaved.id, { action: "submit", revision: 0, round: "practice", answer }, access);
  await assert.rejects(kits.plan(request(ref(attempt.kit!)), access), unavailable);
  const unattempted = await h.newParent();
  await kits.command(unattempted.id, { action: "keep", revision: 0 }, access);
  await assert.rejects(kits.plan(request(ref(unattempted)), access), unavailable);
  const parent = await h.savedParent(), selected = ref(parent), before = h.diagnoses.length;
  for (const mismatch of [
    { ...selected, version: "f".repeat(64) },
    { ...selected, key: "part4" as const },
    { ...selected, round: "retest" as const },
  ]) await assert.rejects(kits.plan(request(mismatch), access), unavailable);
  await assert.rejects(kits.plan({ ...request(selected), goal: "编排另一项任务" }, access), unavailable);
  await assert.rejects(kits.plan(request(selected, { workspaceKey: h.target.workspaceKey, targetId: h.target.targetId }), access), unavailable);
  const otherOwner = h.open(randomUUID());
  await assert.rejects(otherOwner.kits.plan(request(selected), { ...access, session: "second-owner" }), unavailable);
  assert.equal(h.diagnoses.length, before, "invalid references are refused before the author sees any answer");
});

test("child freezes only the selected original with its hint and question version, surviving parent deletion and restart", async t => {
  const h = await setup(t), kits = h.home.kits;
  const careerTarget = { workspaceKey: h.target.workspaceKey, targetId: h.target.targetId };
  const parent = await h.savedParent(careerTarget), selected = ref(parent), attempt = parent.attempts[0]!;
  const evidence = attempt.feedback.evidence![0]!;
  assert.equal(evidence.status, "met");
  assert.equal(attempt.usedPreview, true);
  const expected: TrainingFollowSource = {
    ...selected, kitTitle: parent.title, questionLabel: attempt.question!.fields[0]!.label,
    questionVersion: attempt.questionVersion!, answer: source, usedPreview: true, status: evidence.status,
    detail: evidence.detail, nextStep: evidence.nextStep,
  };
  await assert.rejects(kits.plan(request(selected), access), unavailable);
  const plan = await kits.plan({ ...request(selected, careerTarget), evidence: "请改变输入范围" }, access);
  assert.deepEqual(plan.followFrom, expected);
  assert.deepEqual(h.diagnoses.at(-1), expected);
  assert.ok(!JSON.stringify(plan.followFrom).includes(otherAnswer));
  const child = await kits.build(build(plan.id), access);
  assert.deepEqual(child.followFrom, expected);
  assert.deepEqual(h.designs.at(-1)?.followFrom, expected);
  await kits.command(child.id, { action: "keep", revision: child.revision }, access);
  await kits.command(parent.id, { action: "discard", revision: parent.revision }, access);
  kits.close(); await h.home.store.close();
  const restored = h.open(h.owner);
  await assert.rejects(restored.kits.get(parent.id, access), /not_found/);
  assert.deepEqual((await restored.kits.list(access)).map(item => item.id), [child.id]);
  const reopened = await restored.kits.get(child.id, access);
  assert.equal(reopened.version, child.version);
  assert.deepEqual(reopened.followFrom, expected);
  assert.deepEqual(reopened.career, h.target);
  assert.equal(h.diagnoses.length, 2); assert.equal(h.designs.length, 2);
});

test("deleting a selected source before design prevents another model call", async t => {
  const h = await setup(t), kits = h.home.kits, parent = await h.savedParent();
  const plan = await kits.plan(request(ref(parent)), access);
  const calls = h.designs.length;
  await kits.command(parent.id, { action: "discard", revision: parent.revision }, access);
  await assert.rejects(kits.build(build(plan.id), access), unavailable);
  assert.equal(h.designs.length, calls);
});

for (const phase of ["diagnose", "design"] as const) {
  test("deleting a selected source during " + phase + " rejects its late result", { timeout: 20000 }, async t => {
    const h = await setup(t), kits = h.home.kits, parent = await h.savedParent();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    h.gates[phase] = async () => { entered.resolve(); await release.promise; };
    const input = request(ref(parent));
    const inFlight = phase === "design" ? kits.build(build((await kits.plan(input, access)).id), access) : kits.plan(input, access);
    const check = assert.rejects(inFlight, unavailable);
    await entered.promise;
    try { await kits.command(parent.id, { action: "discard", revision: parent.revision }, access); }
    finally { release.resolve(); }
    await check;
    assert.deepEqual(await kits.list(access), []);
  });
}

test("a learner can choose the actual actions for both exercises without a second diagnosis", async t => {
  let route: "studio" | "simple" | "clarify" = "studio", diagnosisCalls = 0, changeTransferAction = false;
  const consumed: { plan: TrainingPlan; confirmed?: boolean }[] = [];
  const writing = design.scenes[0]!.steps[1]!;
  const h = await setup(t, {
    diagnose: async () => {
      diagnosisCalls++;
      return { route, practiceActions: ["write"], codeSignature: { input: "boolean", output: "boolean" },
        observation: "先说明你的换算理由", nextStep: "试着写下这个办法" };
    },
    design: async (plan, _pin, _kind, _signal, confirmed) => {
      consumed.push({ plan, confirmed });
      const scenes = design.scenes.map((scene, index) => {
        const steps = confirmed ? [scene.steps[0]!, writing] : [writing];
        if (index === 1 && changeTransferAction) steps.reverse();
        return { ...scene, steps };
      });
      return { ...design, scenes };
    },
  });
  const kits = h.home.kits, initial = await kits.plan(request(), access);
  await assert.rejects(kits.build({ ...build(initial.id), actions: ["code", "code"] }, access));
  assert.equal(consumed.length, 0);
  const generated = await kits.build({ ...build(initial.id), actions: ["code", "write"] }, access);
  assert.equal(diagnosisCalls, 1);
  assert.equal(consumed.length, 1);
  assert.deepEqual(consumed[0]?.plan.advice.practiceActions, ["code", "write"]);
  assert.equal(consumed[0]?.plan.advice.codeSignature, undefined, "a newly requested code exercise can choose suitable scalar types");
  assert.equal(consumed[0]?.confirmed, true);
  assert.deepEqual(initial.advice.practiceActions, ["write"], "reviewing the candidate never mutates the original diagnosis");
  assert.deepEqual(generated.screen.fields.map(field => field.control), ["code", "write"]);

  const defaultPlan = await kits.plan(request(), access);
  await kits.build(build(defaultPlan.id), access);
  assert.deepEqual(consumed.at(-1)?.plan.advice.practiceActions, ["write"]);
  assert.equal(consumed.at(-1)?.confirmed, false);

  changeTransferAction = true;
  const ignored = await kits.plan(request(), access);
  await assert.rejects(kits.build({ ...build(ignored.id), actions: ["code", "write"] }, access), /training_design_invalid/);

  const demo = await kits.plan({ ...request(), engine: { type: "example", example: "rewrite" } }, access);
  await assert.rejects(kits.build({ ...build(demo.id), actions: ["write"] }, access), /training_actions_unavailable/);
  for (route of ["simple", "clarify"] as const) {
    const plain = await kits.plan(request(), access);
    await assert.rejects(kits.build({ ...build(plain.id), actions: ["code"] }, access), /training_no_app_needed/);
  }
  assert.equal(consumed.length, 3);
});

test("an interview practice retains its original criterion and issue across reopen and cannot continue under another issue", async t => {
  const h = await setup(t);
  const kits = h.home.kits;
  const interviewRef = "c".repeat(64);
  const plan = await kits.plan({ ...request(), interviewRef }, access);
  assert.equal(plan.interviewRef, interviewRef);
  const trial = await kits.build(build(plan.id), access);
  const first = await kits.command(trial.id, { action: "submit", revision: trial.revision, round: "practice", answer }, access);
  const saved = (await kits.command(trial.id, { action: "keep", revision: first.kit!.revision }, access)).kit!;
  kits.close();
  await h.home.store.close();
  const resumed = h.open(h.owner).kits;
  assert.equal((await resumed.list(access))[0]?.interviewRef, interviewRef);
  const reopened = await resumed.get(saved.id, access);
  assert.equal(reopened.goal, goal);
  assert.equal(reopened.interviewRef, interviewRef);
  assert.equal(reopened.version, saved.version);
  assert.ok(reopened.dueAt);
  for (const other of [undefined, "d".repeat(64)]) {
    await assert.rejects(resumed.plan({ ...request(ref(saved)), interviewRef: other }, access), unavailable);
  }
  assert.equal((await resumed.plan({ ...request(ref(saved)), interviewRef }, access)).interviewRef, interviewRef);
  await assert.rejects(resumed.plan({ ...request(), interviewRef, engine: { type: "example", example: "canvas" } }, access), /training_interview_source_changed/);
});
