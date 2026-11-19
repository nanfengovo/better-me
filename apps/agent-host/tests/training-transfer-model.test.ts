import assert from "node:assert/strict";
import test from "node:test";
import { type TrainingPlan, type TrainingTransferInput } from "@better-me/agent-contracts";
import { localTrainingAuthor } from "../src/growth/training-model.js";
import { meteredTrainingAuthor } from "../src/tasks/metered-adapters.js";
import { ModelUsageMeter } from "../src/tasks/usage-meter.js";
import { mockLocalGeneration } from "./fixtures/training-ollama.js";

const model = "transfer-fixture", pin = "a".repeat(64);
const practice = { brief: "阶段汇报", material: ["尚未取得批准。"], questionVersion: "1".repeat(64), usedPreview: false };
const retest = { ...practice, brief: "核对发布日期", questionVersion: "2".repeat(64), independence: "independent" as const,
  aids: { preview: false, practiceReference: false } };
const input: TrainingTransferInput = { goal: "汇报实际进度", practice, retest, evidence: [
  { id: "practice.part1", phase: "practice", key: "part1", control: "write", question: "情况如何？", answer: "周五肯定完成。", usedPreview: false, status: "recorded", detail: "已记录" },
  { id: "retest.part1", phase: "retest", key: "part1", control: "write", question: "发布日期确定了吗？", answer: "需要批准后才能确定发布日期。", usedPreview: false, status: "recorded", detail: "已记录" },
] };
const signal = new AbortController().signal;
const reply = {
  start: { spanId: "practice.part1.1", reason: "尚未批准时给出了肯定的日期。" }, revision: null,
  transfer: { spanId: "retest.part1.1", reason: "说明了批准是确定日期的必要条件。", taskRequirement: "批准是前提", learnerDid: "交代了前提",
    hasConcreteMismatch: false, appliedTarget: true },
  reinforceTask: "用一句话区分预计完成时间和已经确认的时间。",
  extendTask: "根据两份相互冲突的进度报告，用一句话说明还要核对什么。",
  verifyTask: "独立写一份采购汇报，说明哪些合同仍待供应商签字。", action: "write",
};

test("transfer advice binds actual citations, rejects invented references and guards the interpretation of assistance", async t => {
  let response = structuredClone(reply);
  let expectedInput = input;
  mockLocalGeneration(t, model, pin, payload => {
    const wire = JSON.parse(payload.messages[1]!.content);
    assert.deepEqual(wire.retest.aids, expectedInput.retest.aids);
    assert.equal(wire.retest.independence, expectedInput.retest.independence);
    assert.equal(wire.practice.responses[0].answerSpans[0].text, input.evidence[0]!.answer);
    assert.equal(wire.practice.responses[0].answer, undefined);
    assert.equal(payload.messages[1]!.content.split(input.evidence[0]!.answer).length, 2);
    assert.equal(wire.revisionsToPractice, undefined);
    return response;
  });
  const meter = new ModelUsageMeter();
  const { recommendTransfer } = meteredTrainingAuthor(meter, localTrainingAuthor);
  assert(recommendTransfer);
  const recommend = (history: TrainingTransferInput) => {
    expectedInput = history;
    return recommendTransfer(model, pin, history, signal);
  };
  const decision = await recommend(input);
  assert.equal(decision.direction, "extend");
  assert.equal(decision.nextGoal, reply.extendTask);
  assert.deepEqual(decision.reasons.map(item => item.evidenceId), ["practice.part1", "retest.part1"]);
  assert.match(decision.reasons[0]!.reason, /周五肯定完成/);
  const assisted = await recommend({ ...input, retest: { ...retest, usedPreview: true, independence: "assisted",
    aids: { preview: false, practiceReference: true } } });
  assert.equal(assisted.direction, "verify");
  assert.match(assisted.reasons.at(-1)!.reason, /复测参考过首轮作答记录/);
  const untracked = await recommend({ ...input, retest: { ...retest, independence: "untracked", aids: undefined } });
  assert.equal(untracked.direction, "verify");
  assert.match(untracked.reasons.at(-1)!.reason, /旧记录未跟踪/);
  response.transfer.hasConcreteMismatch = true;
  assert.equal((await recommend(input)).direction, "reinforce");
  response.transfer.spanId = "practice.part1.1";
  await assert.rejects(recommend(input));
  response = structuredClone(reply);
  const missed: TrainingTransferInput = { ...input, evidence: [input.evidence[0]!, { ...input.evidence[1]!, status: "missed", control: "code" }] };
  assert.equal((await recommend(missed)).direction, "verify", "a new task with missed public checks cannot be used to justify extending");
  assert.equal(meter.snapshot().models[0]!.calls, 6);
  assert.equal(meter.snapshot().models[0]!.failures, 1);
  assert.equal(meteredTrainingAuthor(meter, { ...localTrainingAuthor, recommendTransfer: undefined }).recommendTransfer, undefined);
});

test("a reviewed passage pins only its original answer candidate and survives sentence boundaries", async t => {
  const answer = "Budget confirmed. We promise Friday. Approval is pending.";
  const reviewedQuote = "promise Friday. Approval";
  const history: TrainingTransferInput = { ...input, evidence: [
    { ...input.evidence[0]!, answer, reviewedQuote },
    { ...input.evidence[0]!, id: "practice.part2", key: "part2", question: "Who approves the result?", answer: "The editor." },
    { ...input.evidence[0]!, phase: "rewrite", id: "rewrite.part1", answer: "The budget is set. Timing depends on approval.", usedPreview: true },
    input.evidence[1]!,
  ] };
  let selected = "practice.part1.2";
  mockLocalGeneration(t, model, pin, payload => {
    const wire = JSON.parse(payload.messages[1]!.content);
    const source = wire.practice.responses[0];
    assert.equal(source.reviewedSpanId, "practice.part1.2");
    assert.equal(source.reviewedQuote, undefined);
    assert.equal(source.answerSpans.map((s: {text: string}) => s.text).join(""), answer);
    assert.equal(source.answerSpans[1].text, reviewedQuote);
    assert.equal(wire.retest.responses[0].reviewedSpanId, undefined);
    return { ...reply, start: { ...reply.start, spanId: selected },
      revision: { spanId: "rewrite.part1.2", reason: "说明了审批条件。" } };
  });
  const recommend = () => localTrainingAuthor.recommendTransfer!(model, pin, history, signal);
  assert.match((await recommend()).reasons[0]!.reason, /promise Friday\. Approval/);
  selected = "practice.part1.1";
  await assert.rejects(recommend());
  selected = "practice.part2.1";
  assert.equal((await recommend()).reasons[0]!.evidenceId, "practice.part2");
});

test("the generated child targets the accepted exercise without resending prior submissions", async t => {
  const source = { kitId: "11111111-1111-4111-8111-111111111111", kitTitle: "前一练", version: pin, evidenceVersion: pin,
    practiceVersion: practice.questionVersion, retestVersion: retest.questionVersion, nextGoal: reply.extendTask,
    actions: ["write"] as ["write"], direction: "extend" as const, reasons: [{ evidenceId: "practice.part1", reason: "首答曾写过「" + input.evidence[0]!.answer + "」。" }],
    citations: input.evidence, retestIndependence: retest.independence, retestAids: retest.aids };
  const plan: TrainingPlan = { id: "22222222-2222-4222-8222-222222222222", goal: input.goal, evidence: "", transferFrom: source, origin: "local",
    model, modelCalls: 0, advice: { route: "studio", observation: source.reasons[0]!.reason, nextStep: source.nextGoal, practiceActions: source.actions } };
  mockLocalGeneration(t, model, pin, payload => {
    const wire = JSON.parse(payload.messages[1]!.content);
    assert.equal(wire.goal, source.nextGoal);
    assert.equal(wire.overallGoal, input.goal);
    assert.equal(wire.practiceDirection, "extend");
    assert.deepEqual(wire.practiceActions, ["write"]);
    assert.equal(wire.observation, undefined);
    assert.ok(!payload.messages[1]!.content.includes(input.evidence[0]!.answer));
    assert.ok(!payload.messages[1]!.content.includes(input.evidence[1]!.answer));
    const scene = { headingWords: ["交接"], setting: "需要值班交接。", facts: [{ statement: "一份工单仍待签收。", context: "交接流程要求两人签字。" }], deliverable: "写一份交接记录。",
      first: { mode: "write", fieldWords: ["交接记录"], followUp: "确认这份工单是否已经签收。", extend: "再向负责人解释签收条件。" }, extra: [] };
    return { title: "交接记录", practice: scene, transfer: scene };
  });
  await localTrainingAuthor.design(plan, pin, "studio", signal, true);
});
