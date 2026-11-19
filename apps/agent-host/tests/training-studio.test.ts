import test from "node:test";
import assert from "node:assert/strict";
import { StudioDesign, TrainingStart, TrainingAnswer, TrainingFeedback, TrainingScreen, type StudioStep } from "@better-me/agent-contracts";
import {
  studioScreen, studioFeedback, studioSource, validateStudio, studioFixtures, studioAuthoredCases,
} from "../src/growth/training-studio.js";
import { executeTransform } from "../src/capabilities/sandbox.js";

const signal = new AbortController().signal;
const design = StudioDesign.parse({
  kind: "studio", title: "制作声音档案",
  scenes: [
    {
      brief: "整理田野录音", situation: "访谈及同期声可以独立录制，剪辑须等待两份录音。", steps: [
        { mode: "order", prompt: "排出可行的制作顺序", constraints: [
          { before: "采访", after: "剪辑" }, { before: "收音", after: "剪辑" },
        ], followUp: "找出哪个步骤必须等待两份材料。", extend: "写出另一个同样可行的录制顺序。" },
        { mode: "quantity", prompt: "计算留给访谈的分钟数", operation: "difference", values: [48, 16, 12],
          followUp: "先从总时长里扣去开场，再扣片尾。", extend: "如果片尾缩短两分钟，重新估算可用时长。" },
        { mode: "write", prompt: "说明你的采访顺序", followUp: "从你的理由里选一项假设，说明如何核实。", extend: "换一位受访者，再写一次理由。" },
      ],
    },
    { brief: "策划片段", situation: "要合并两段素材，计算所需录制时间。", steps: [
      { mode: "quantity", prompt: "预测总时长", operation: "sum", values: [13, 21],
        followUp: "把两段时长分别列出。", extend: "增加一段七分钟的素材后再估算。" },
    ] },
  ],
});
const parts = { part1: JSON.stringify(["收音", "采访", "剪辑"]), part2: "20", part3: "主持人需要听到两个声源。" };

test("a goal can start a local diagnosis with no evidence or predefined example", () => {
  const request = { requestId: "4d58e93f-4aa1-4c18-ac0a-9c2309699f94", goal: "学着整理录音素材",
    consent: true, engine: { type: "local", model: "test" } };
  assert.equal(TrainingStart.parse(request).evidence, "");
  assert.equal(TrainingStart.parse({ ...request, evidence: "   " }).evidence, "");
  assert.equal(TrainingStart.safeParse({ ...request, engine: { type: "example", example: "studio" } }).success, false);
  assert.equal(TrainingStart.safeParse({ ...request, engine: { type: "example", example: "canvas" } }).success, true);
});

test("studio renders generated material and actionable evidence only for the checked constraint", async () => {
  validateStudio(design);
  const screen = TrainingScreen.parse(studioScreen(design, 0));
  assert.deepEqual(screen.fields.map(s => s.control), ["order", "quantity", "write"]);
  assert.match(screen.notes.join("\n"), /48，16，12/);
  assert.match(screen.notes.join("\n"), /采访 → 剪辑/);
  const check = async (p: Record<string, string>) =>
    TrainingFeedback.parse(await studioFeedback(design, 0, studioSource, p, signal));
  const good = await check(parts);
  assert.deepEqual(good.evidence?.map(e => e.status), ["met", "met", "recorded"]);
  assert.match(good.evidence![0]!.nextStep, /另一个/);
  assert.match(good.evidence![2]!.detail, /原文/);
  assert.equal(good.met, true);

  const wrongOrder = await check({ ...parts, part1: JSON.stringify(["剪辑", "采访", "收音"]) });
  assert.equal(wrongOrder.met, false);
  assert.match(wrongOrder.evidence![0]!.detail, /剪辑/);
  assert.match(wrongOrder.cues![0]!, /等待两份/);
  const wrongQuantity = await check({ ...parts, part2: "23" });
  assert.deepEqual(wrongQuantity.evidence!.map(e => e.status), ["met", "missed", "recorded"]);
  assert.match(wrongQuantity.evidence![1]!.detail, /23.+20/);
  assert.match(wrongQuantity.cues![0]!, /扣去开场/);
});

test("studio rejects invalid material, impossible orders and nominal transfer repeats", () => {
  const withStep = (step: StudioStep) => {
    const d = structuredClone(design);
    d.scenes[0]!.steps = [step];
    return d;
  };
  const order = design.scenes[0]!.steps[0]!;
  assert.equal(order.mode, "order");
  if (order.mode !== "order") throw new Error("fixture");
  const cycle = withStep({ ...order, constraints: [{ before: "A", after: "B" }, { before: "B", after: "A" }] });
  assert.throws(() => validateStudio(cycle), /training_design_invalid/);
  const ambiguous = withStep({ ...order, constraints: [{ before: "Ａ", after: "a" }] });
  assert.throws(() => validateStudio(ambiguous), /training_design_invalid/);
  const repeated = structuredClone(design);
  repeated.scenes[1] = { ...structuredClone(repeated.scenes[0]!), brief: "Changed title", situation: "Different story." };
  assert.throws(() => validateStudio(repeated), /training_retest_repeated/);
  const repeatedCondition = structuredClone(design);
  repeatedCondition.scenes[1]!.situation = design.scenes[0]!.situation;
  assert.throws(() => validateStudio(repeatedCondition), /training_retest_repeated/);
});

test("studio accepts open-response participation without certifying the authored content", async () => {
  const writing = design.scenes[0]!.steps[2]!;
  const open = structuredClone(design);
  open.scenes.forEach(s => { s.steps = [writing]; });
  validateStudio(open);
  const result = await studioFeedback(open, 0, studioSource, { part1: "我会改变计划" }, signal);
  assert.equal(result.evidence![0]!.status, "recorded");
  assert.match(result.detail, /开放作答已记录/);
  assert.doesNotMatch(result.detail, /符合/);
});

test("studio preserves input integrity and independently detects a disagreeing guest", async () => {
  for (const values of [
    { ...parts, part1: '["采访","剪辑"]' },
    { ...parts, part1: '["采访","剪辑","剪辑"]' },
    { ...parts, part1: '["采访","收音","替换"]' },
    { ...parts, part1: '{}' }, { ...parts, part2: " " }, { ...parts, part2: "1e3" }, { ...parts, part3: " " },
    { ...parts, part4: "额外的字段" },
  ]) {
    await assert.rejects(studioFeedback(design, 0, studioSource, values, signal), /training_answer_incomplete|training_wrong_answer_type/);
  }
  await assert.rejects(studioFeedback(design, 0, "input => 0", parts, signal), /training_runtime_mismatch/);
  for (const c of [...studioFixtures(), ...studioAuthoredCases(design)]) {
    assert.equal(await executeTransform(studioSource, c.input, signal), c.expected);
  }
});

const codeDesign = StudioDesign.parse({
  kind: "studio", title: "将按键节奏转成节拍提示",
  scenes: [
    { brief: "最小节拍器", situation: "每三拍响一次，其余拍保持静音。", steps: [
      { mode: "code", prompt: "传入正整数拍号，返回此拍需要发声的布尔值。", followUp: "试算连续六拍拍号的余数。",
        extend: "让第二种乐器从第二拍起，每四拍响一次。", cases: [{ input: 1, expected: false }, { input: 3, expected: true }] },
      { mode: "write", prompt: "说明边界情况", followUp: "怎样验证第一拍？", extend: "把你的说明改成一个测试。" },
    ] },
    { brief: "换节拍器", situation: "每四拍响一次，其余拍继续静音。", steps: [
      { mode: "code", prompt: "对新的拍号返回是否发声。", followUp: "列出前八拍拍号中的重拍。", extend: "改成从零开始计拍。",
        cases: [{ input: 4, expected: true }, { input: 6, expected: false }, { input: 8, expected: true }] },
    ] },
  ],
});

test("code composition runs learner source only on explicit answers and compares exact JSON values", async () => {
  validateStudio(codeDesign);
  const screen = TrainingScreen.parse(studioScreen(codeDesign, 0));
  assert.equal(screen.fields[0]!.control, "code");
  assert.match(screen.notes.join("\n"), /1 → false/);
  assert.match(screen.notes.join("\n"), /3 → true/);
  const run = (source: string, controller = new AbortController()) =>
    studioFeedback(codeDesign, 0, studioSource, { part1: source, part2: "第一拍静音" }, controller.signal, "part1");
  for (const source of ["n => n % 3 === 0", "function beat(n) { return Number.isInteger(n / 3); }"]) {
    const result = TrainingFeedback.parse(await run(source));
    assert.deepEqual(result.evidence!.map(e => e.status), ["met", "recorded"]);
    assert.match(result.evidence![0]!.detail, /2 组通过/);
  }
  const wrong = await run("n => String(n % 3 === 0)");
  assert.equal(wrong.evidence![0]!.status, "missed");
  assert.match(wrong.evidence![0]!.detail, /期望 false，实际返回 "false"/);
  const syntaxError = await run("x => {");
  assert.equal(syntaxError.met, false);
  assert.match(syntaxError.evidence![0]!.detail, /函数未能执行/);
  const controller = new AbortController();
  const cancelled = run("input => input", controller);
  controller.abort(new Error("practice cancelled"));
  await assert.rejects(cancelled, /practice cancelled/);
});

test("code answer length and source attribution stay scoped to the frozen code screen", async () => {
  const rawSource = "  n => n % 3 === 0\n" + " ".repeat(450);
  const a = TrainingAnswer.parse({ parts: { part1: rawSource, part2: "回答" }, codeKey: "part1" });
  assert("parts" in a && "codeKey" in a);
  assert.equal(a.parts.part1, rawSource);
  assert(!TrainingAnswer.safeParse({ parts: { part1: "x".repeat(500) } }).success);
  assert(!TrainingAnswer.safeParse({ parts: { part1: "n => n", part2: "较".repeat(401) }, codeKey: "part1" }).success);
  assert(!TrainingAnswer.safeParse({ parts: { part1: "n".repeat(1601) }, codeKey: "part1" }).success);
  await assert.rejects(studioFeedback(codeDesign, 0, studioSource, a.parts, signal, "part2"), /training_wrong_answer_type/);
  await assert.rejects(studioFeedback(design, 0, studioSource, parts, signal, "part1"), /training_wrong_answer_type/);
});

test("code cases freeze deterministic single-input contracts and require a new transfer input", () => {
  const duplicate = structuredClone(codeDesign);
  const first = duplicate.scenes[0]!.steps[0]!;
  assert(first.mode === "code");
  first.cases = [{ input: 0, expected: true }, { input: 0, expected: false }];
  assert.throws(() => validateStudio(duplicate), /training_design_invalid/);

  const stale = structuredClone(codeDesign);
  const initial = stale.scenes[0]!.steps[0]!, transfer = stale.scenes[1]!.steps[0]!;
  assert(initial.mode === "code" && transfer.mode === "code");
  transfer.cases = [...initial.cases].reverse();
  assert.throws(() => validateStudio(stale), /training_retest_repeated/);
  assert(!StudioDesign.safeParse({ ...codeDesign, scenes: [
    { ...stale.scenes[0], steps: [{ ...initial, cases: [{ input: {}, expected: 2 }, { input: true, expected: 4 }] }] },
    stale.scenes[1],
  ] }).success);
});

test("a Boolean-only domain keeps one real input for transfer and reports the actual single case", async () => {
  const binary = structuredClone(codeDesign);
  const first = binary.scenes[0]!.steps[0]!, next = binary.scenes[1]!.steps[0]!;
  assert(first.mode === "code" && next.mode === "code");
  binary.scenes[0]!.steps = [first];
  binary.scenes[1]!.steps = [next];
  first.cases = [{ input: false, expected: true }];
  next.cases = [{ input: true, expected: false }];
  assert(StudioDesign.safeParse(binary).success);
  validateStudio(binary);
  for (const index of [0, 1]) {
    const reply = await studioFeedback(binary, index, studioSource,
      { part1: "value => !value" }, signal, "part1");
    assert.equal(reply.met, true);
    assert.match(reply.evidence![0]!.detail, /1 组，1 组通过/);
  }
  next.cases = [{ input: false, expected: true }];
  assert.throws(() => validateStudio(binary), /training_retest_repeated/);
  next.cases = [{ input: 7, expected: false }, { input: 8, expected: true }];
  assert.throws(() => validateStudio(binary), /training_design_invalid/);
  first.cases = [{ input: 1, expected: true }];
  assert.equal(StudioDesign.safeParse(binary).success, false);
});
