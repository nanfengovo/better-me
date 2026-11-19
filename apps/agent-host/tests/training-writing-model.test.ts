import assert from "node:assert/strict";
import test from "node:test";
import { mockLocalGeneration } from "./fixtures/training-ollama.js";
import { StudioDesign, type TrainingPlan } from "@better-me/agent-contracts";
import { localTrainingAuthor } from "../src/growth/training-model.js";
import { meteredTrainingAuthor } from "../src/tasks/metered-adapters.js";
import { ModelUsageMeter } from "../src/tasks/usage-meter.js";

const model = "fixture-local", pin = "a".repeat(64);

test("local writing coach only cites learner text, rejects bad model choices and meters each explicit review", async t => {
  const input = {
    goal: "写进度", material: ["日期尚未确认。"], question: "给对方说明最新状态。",
    answer: "Dates are pending.\n   We  promise Friday!  ",
  };
  const replies = [
    { sentenceId: 2, feedback: "日期仍未确认，承诺上线会误导读者。", nextEdit: "说明这个日期还依赖哪个决定。" },
    { sentenceId: 3, feedback: "无效引用", nextEdit: "再试一次。" },
    { sentenceId: 2, feedback: " ", nextEdit: "再试一次。" },
  ];
  mockLocalGeneration(t, model, pin, payload => {
    assert.deepEqual(JSON.parse(payload.messages[1]!.content), {
      goal: input.goal, material: input.material, question: input.question,
      learnerSentences: [{ sentenceId: 1, text: "Dates are pending." }, { sentenceId: 2, text: "We  promise Friday!" }],
    });
    return replies.shift();
  });
  const meter = new ModelUsageMeter();
  const { reviewWriting } = meteredTrainingAuthor(meter, localTrainingAuthor);
  assert(reviewWriting);
  const review = () => reviewWriting(model, pin, input, new AbortController().signal);
  const result = await review();
  assert.equal(result.quote, "We  promise Friday!");
  assert(input.answer.includes(result.quote));
  await assert.rejects(review());
  await assert.rejects(review());
  assert.equal(meter.snapshot().models[0]?.calls, 3);
  assert.equal(meter.snapshot().models[0]?.failures, 2);
  assert.equal(meteredTrainingAuthor(meter, { ...localTrainingAuthor, reviewWriting: undefined }).reviewWriting, undefined);
});

test("pure writing tasks retain complete short coaching actions in both rounds and reject truncated fragments", async t => {
  const plan: TrainingPlan = {
    id: "009337d1-584a-4494-80ab-e7d10fbc1c91", goal: "Write an update.", evidence: "", origin: "local", model, modelCalls: 1,
    advice: { route: "studio", observation: "Try explaining progress.", nextStep: "Draft an email.", practiceActions: ["write"] },
  };
  const longFirstSentence = "Compare every deadline with the outstanding conditions listed in the manager's notes before making a commitment about the planned delivery date.";
  assert(longFirstSentence.length > 140);
  const follow = "Check whether the deadline depends on approval.";
  const extend = "Now write for the approving manager.";
  let rawFollow = longFirstSentence + " " + follow;
  mockLocalGeneration(t, model, pin, () => {
    const scene = { headingWords: ["Update"], setting: "Work is underway.", facts: [{ statement: "Approval is pending.", context: "A signed copy is required." }], deliverable: "Write an update.",
      first: { mode: "write", fieldWords: ["Draft"], followUp: rawFollow, extend }, extra: [] };
    return { title: "Update Practice", practice: scene, transfer: scene };
  });
  const design = () => localTrainingAuthor.design(plan, pin, "studio", new AbortController().signal, true);
  const result = StudioDesign.parse(await design());
  for (const scene of result.scenes) {
    assert.equal(scene.steps[0]!.followUp, follow);
    assert.equal(scene.steps[0]!.extend, extend);
    assert.equal(scene.situation, "Work is underway.\nApproval is pending. A signed copy is required.\nWrite an update.");
  }
  rawFollow = longFirstSentence.slice(0, 140);
  await assert.rejects(design(), /training_design_invalid/);
});

test("pure writing material preserves abbreviations, parentheses and all facts needed by the requested work", async t => {
  const plan: TrainingPlan = {
    id: "009337d1-584a-4494-80ab-e7d10fbc1c91", goal: "Explain the reasons for two pending decisions.", evidence: "",
    origin: "local", model, modelCalls: 1, advice: { route: "studio", observation: "Compare both decisions.",
      nextStep: "Explain both conditions.", practiceActions: ["write"] },
  };
  const setting = "The layouts are ready. Two decisions remain.";
  const known = "The client received the drafts, e.g. the mobile layout and the new banner.";
  const palette = "The color palette (Option A vs. Option B) is awaiting compliance review. The contrast must meet the accessibility requirements.";
  const wording = "The link wording needs the mobile team's approval. It must fit on a narrow screen.";
  const deliverable = "Write an update. Give one business reason for each pending decision.";
  const knownContext = "The client acknowledged the delivery.";
  const paletteContext = "The compliance team checks contrast, e.g. for text on small buttons.";
  const wordingContext = "The header holds at most 16 characters.";
  let facts = [{ statement: known, context: knownContext }, { statement: palette, context: paletteContext }, { statement: wording, context: wordingContext }];
  mockLocalGeneration(t, model, pin, () => {
    const scene = { headingWords: ["Review"], setting, facts, deliverable, first: { mode: "write", fieldWords: ["Memo"],
      followUp: "Check the palette (A vs. B) and its approval condition.", extend: "Explain the mobile space limit." }, extra: [] };
    return { title: "Design decisions", practice: scene, transfer: scene };
  });
  const design = () => localTrainingAuthor.design(plan, pin, "studio", new AbortController().signal, true);
  for (const scene of StudioDesign.parse(await design()).scenes) {
    assert.equal(scene.situation, [setting, known + " " + knownContext, palette + " " + paletteContext, wording + " " + wordingContext, deliverable].join("\n"));
    assert.equal(scene.steps[0]!.followUp, "Check the palette (A vs. B) and its approval condition.");
  }
  facts = [{ statement: "The palette choice (Option A vs.", context: paletteContext }, { statement: wording, context: wordingContext }];
  await assert.rejects(design(), /training_design_invalid/);
  facts = [{ statement: known, context: "This item has a necessary condition. ".repeat(30).trim() }];
  await assert.rejects(design(), /training_design_invalid/);
  facts = [{ statement: known, context: "" }];
  await assert.rejects(design());
});
