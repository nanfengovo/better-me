import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReplacementSelectionPrompt, completeReplacementClarification, hasReplacementChoices,
  parseReplacementSelection, suggestResumeReplacement,
} from "../dist/index.js";

const material = (claimId, text, visible = true, experienceId = "售后组") => ({
  claimId, experienceId, label: experienceId, text, visible,
});
const jd = "岗位职责\n梳理退款工单的处理流程。\n任职要求\n复核退款清单。";
const duty = material("daily", "负责日常售后工作。");
const delivery = material("check", "归类退款工单的缺失材料，整理提交前检查清单，供交接时使用。", false, "运营实习");
const describe = (...materials) => ({ jobDescription: jd, materials });
const choose = (input, targetIndex, sourceIndex, overrides = {}) => JSON.stringify({
  kind: "select", targetIndex, sourceIndex, requirement: "梳理退款工单的处理流程。",
  targetQuote: input.materials[targetIndex].text, sourceQuote: input.materials[sourceIndex].text, ...overrides,
});

test("picks one actual JD quote and the full contributed source, retaining ownership and bounds", () => {
  const c = suggestResumeReplacement(describe(duty, delivery, material("irrelevant", "编写仓储温度传感器读数测试。", false)));
  assert.equal(c.kind, "replace");
  assert.equal(c.source, delivery);
  assert.equal(c.target, duty);
  assert.ok(jd.includes(c.requirement));
  assert.equal(c.proposedText, delivery.text);
});

test("does not promote negative claims, a skill list, plans, duplicate text or another visible group", () => {
  for (const source of [
    material("no", "从未参与退款工单整理。", false),
    material("skills", "熟悉退款工单、退款清单、退款流程。", false),
    material("future", "计划使用退款工单整理数据。", false),
    material("dupe", duty.text, false),
    { ...delivery, visible: true },
  ]) assert.equal(suggestResumeReplacement(describe(duty, source)).kind, "keep", source.text);
  assert.equal(suggestResumeReplacement(describe({ ...delivery, visible: true })).kind, "keep");
});

test("can promote a later bullet in the same experience; never demotes it", () => {
  const later = { ...delivery, experienceId: duty.experienceId, visible: true };
  assert.equal(suggestResumeReplacement(describe(duty, later)).source, later);
  assert.equal(suggestResumeReplacement(describe(later, duty)).kind, "keep");
});

test("edits only a whole generic sentence without requiring the user to restate an existing action", () => {
  const mixed = material("mixed", "负责相关工作。编写退款清单核对说明。");
  const proposal = suggestResumeReplacement(describe(mixed));
  assert.equal(proposal.kind, "replace");
  assert.equal(proposal.target, proposal.source);
  assert.equal(proposal.proposedText, "编写退款清单核对说明。");
});

test("one question about an ambiguous team achievement; unknown, team-only or negated answers end the run", () => {
  const team = material("team", "团队编写了一份退款清单。", false);
  const ask = suggestResumeReplacement(describe(duty, team));
  assert.equal(ask.kind, "ask");
  assert.equal((ask.question.match(/[？?]/g) ?? []).length, 1);
  for (const text of ["", "记不清", "没有参与退款清单编写。", "团队编写了整份退款清单。"])
    assert.equal(completeReplacementClarification(ask, text).kind, "keep", text);
  const answer = "我整理了退款资料，清单是同事编写的。";
  const proposal = completeReplacementClarification(ask, answer);
  assert.equal(proposal.kind, "replace");
  assert.equal(proposal.proposedText, answer);
});

test("one visible vague but relevant bullet can be clarified in place", () => {
  const source = material("weak", "参与退款工单处理流程。");
  const ask = suggestResumeReplacement(describe(source));
  assert.equal(ask.kind, "ask");
  assert.equal(ask.source, ask.target);
});

test("preserves a qualified concrete claim and the only visible material about another requirement", () => {
  const scoped = material("scoped", "在课程练习中编写退款清单校验，尚未上线。", false);
  assert.equal(suggestResumeReplacement(describe(duty, scoped)).proposedText, scoped.text);
  const input = { jobDescription: jd + "\n梳理收款对账。", materials: [material("other", "参与收款对账。"), delivery] };
  const recommendation = suggestResumeReplacement(input);
  assert.ok(recommendation.kind === "keep" || recommendation.target === recommendation.source);
});

test("model selection can rank equivalent concepts but cannot overwrite a quote, scope or personal contribution", () => {
  const semantic = material("semantic", "逐一核对顾客提交的退货凭证，制作返款资料检查表。", false);
  const input = describe(duty, semantic);
  assert.ok(buildReplacementSelectionPrompt(input).includes(semantic.text));
  assert.equal(parseReplacementSelection(input, choose(input, 0, 1)).proposedText, semantic.text);
  for (const override of [{ requirement: "模糊改写岗位要求。" }, { sourceQuote: "新编 50% 收益。" }, { targetQuote: "旧版本的文字。" },
    { proposedText: "主导上线" }, { targetIndex: 1 }, { sourceIndex: 101 }]) {
    assert.throws(() => parseReplacementSelection(input, choose(input, 0, 1, override)));
  }
  const team = describe(duty, material("team", "团队整理退款资料并编写清单。", false));
  assert.equal(parseReplacementSelection(team, choose(team, 0, 1)).kind, "ask");
  assert.equal(parseReplacementSelection(input, '{"kind":"keep"}').kind, "keep");
  assert.throws(() => suggestResumeReplacement(describe(duty, duty)));
});

test("ordinary grammatical negatives, plans and hypothetical ideas cannot serve as experience", () => {
  for (const text of ["我没编写退款清单。", "没有编写退款清单。", "计划编写退款清单。", "如果能用退款工单，我可以开发一套分类程序。"]) {
    const input = describe(duty, material("unqualified", text, false));
    assert.equal(suggestResumeReplacement(input).kind, "keep", text);
    assert.throws(() => parseReplacementSelection(input, choose(input, 0, 1)));
  }
  for (const text of ["负责日常退款开发和维护工作。", "参与退款清单的开发与维护。"]) {
    assert.equal(suggestResumeReplacement(describe(duty, material("duty", text, false))).kind, "ask", text);
  }
});

test("team-only relevance requires clarification, answers keep coursework scope and unrelated answers are declined", () => {
  const mixed = material("team", "课程练习中团队编写了退款清单，我收集了参会名单。", false);
  const ask = suggestResumeReplacement(describe(duty, mixed));
  assert.equal(ask.kind, "ask");
  assert.equal(completeReplacementClarification(ask, "我开发了风力发电监控模块。").kind, "keep");
  const c = completeReplacementClarification(ask, "我整理了退款凭证。");
  assert.equal(c.kind, "replace");
  assert.ok(c.proposedText.includes(mixed.text));
  assert.ok(c.proposedText.includes("我整理了退款凭证。"));
});

test("three indexes resolve exact texts in the provided snapshot, including model replies without copied quotes", () => {
  const input = describe(duty, delivery);
  const reqs = JSON.parse(buildReplacementSelectionPrompt(input).split("\n").at(-1)).requirements;
  const [requirement] = reqs;
  assert.equal(requirement.index, 0);
  const choice = { kind: "select", targetIndex: 0, sourceIndex: 1, requirementIndex: 0 };
  const output = parseReplacementSelection(input, JSON.stringify(choice));
  assert.equal(output.requirement, requirement.text);
  assert.equal(output.proposedText, delivery.text);
  for (const invalid of [{ requirementIndex: 8 }, { sourceIndex: 6 }, { targetIndex: 1 }, { requirementIndex: -1 }, { sourceIndex: "1" }, { extra: "fabricated" }]) {
    assert.throws(() => parseReplacementSelection(input, JSON.stringify({ ...choice, ...invalid })));
  }
});

test("model is offered bounded executable pairs even when JD and material use different vocabulary", () => {
  const target = material("target", "参与退款工单处理。");
  const translated = material("source", "逐一核对顾客提交的退货凭证，制作返款资料检查表。", false);
  const input = { jobDescription: "处理退款工单。", materials: [target, translated] };
  assert.ok(hasReplacementChoices(input));
  const wire = JSON.parse(buildReplacementSelectionPrompt(input).split("\n").at(-1));
  const option = wire.options.find(option => option.source === 1);
  assert.equal(option.target, 0);
  assert.equal(wire.materials.length, input.materials.length);
  assert.ok(wire.options.length <= input.materials.length);
  const out = parseReplacementSelection(input, JSON.stringify({ kind: "select", optionIndex: option.optionIndex, requirementIndex: 0 }));
  assert.equal(out.kind, "replace");
  assert.equal(out.proposedText, translated.text);
  for (const invalid of [{ optionIndex: 400 }, { requirementIndex: -1 }, { requirementIndex: 5 }])
    assert.throws(() => parseReplacementSelection(input, JSON.stringify({ kind: "select", optionIndex: 0, requirementIndex: 0, ...invalid })));
});

test("no legal choices can skip inference, and every serialized option is executable exactly as displayed", () => {
  assert.equal(hasReplacementChoices(describe({ ...delivery, visible: true })), false);
  assert.equal(hasReplacementChoices({ jobDescription: "", materials: [duty, delivery] }), false);
  const input = describe(duty, delivery, material("other", "参与复核退款清单。"),
    material("inventory", "熟悉退款、退款、清单、工单。", false));
  const wire = JSON.parse(buildReplacementSelectionPrompt(input).split("\n").at(-1));
  for (const option of wire.options) {
    assert.ok(input.materials[option.target].visible);
    const reqs = option.onlyRequirementIndex == null ? wire.requirements.map(r => r.index) : [option.onlyRequirementIndex];
    for (const requirementIndex of reqs) {
      const output = parseReplacementSelection(input, JSON.stringify({ kind: "select", optionIndex: option.optionIndex, requirementIndex }));
      assert.ok(output.kind === "replace" || output.kind === "ask");
      assert.equal(output.target, input.materials[option.target]);
      assert.equal(output.source, input.materials[option.source]);
    }
  }
});
