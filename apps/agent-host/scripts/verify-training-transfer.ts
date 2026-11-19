/** Opt-in acceptance with synthetic practice records and an installed local model. */
import assert from "node:assert/strict";
import type { TrainingTransferInput } from "@better-me/agent-contracts";
import { localTrainingAuthor } from "../src/growth/training-model.js";

const [flag, model] = process.argv.slice(2);
if (flag !== "--synthetic-local" || !model) throw Error("Use --synthetic-local <installed-local-model>");

const practice = {
  questionVersion: "a".repeat(64), brief: "写给项目同事", usedPreview: false,
  material: ["测试迁移已经完成。生产上线日期取决于客户批准，尚未确认。"],
};
const retest = {
  questionVersion: "b".repeat(64), brief: "写给编辑", usedPreview: false,
  material: ["文章已经校对完毕。只有作者签字后才能刊登，目前没有签字，也没有确定刊登日期。"],
};
const firstQuestion = "用英语向同事准确汇报项目状态。";
const newQuestion = "用英语向编辑汇报校对和刊登进展。";
const goal = "练习用英语向相关方清晰汇报工作进度，区分已确定的事实和有待确认的事项。";
const corrected = "Proofreading is complete. Publication depends on the author's sign-off; we cannot confirm a date yet.";
const repeat = "Proofreading is complete. The article will definitely be published tomorrow.";

function history(answer: string, usedPreview: boolean, includeRewrite = true): TrainingTransferInput {
  const writing = { control: "write", status: "recorded", detail: "已保存本人原答。", key: "part1" } as const;
  const evidence: TrainingTransferInput["evidence"] = [
    { ...writing, id: "practice.part1", phase: "practice", question: firstQuestion, answer: "The test migration is complete. Production will definitely go live on Friday.", usedPreview: false },
  ];
  if (includeRewrite) evidence.push({ ...writing, id: "rewrite.part1", phase: "rewrite", question: firstQuestion, usedPreview: true,
    rewriteTiming: "before-retest", answer: "The test migration is complete. A production date depends on client approval." });
  evidence.push({ ...writing, id: "retest.part1", phase: "retest", question: newQuestion, answer, usedPreview });
  return { goal, practice, retest: { ...retest, usedPreview, independence: usedPreview ? "assisted" : "independent",
    aids: { preview: usedPreview, practiceReference: false } }, evidence };
}

const cases = [
  { name: "独立迁移", input: history(corrected, false), direction: "extend", grounding: /签字|签署|作者|sign.off|approval|author/iu },
  { name: "独立复测再次作出无依据承诺", input: history(repeat, false), direction: "reinforce", grounding: /明天|明日|tomorrow|definitely|一定|肯定/iu },
  { name: "同一正确答复使用过提示", input: history(corrected, true), direction: "verify", grounding: /提示|协助|帮助|反馈|参考|引导|受助|hint|feedback/iu },
  { name: "未改写，直接独立复测", input: history(repeat, false, false), direction: "reinforce", grounding: /明天|明日|tomorrow|definitely|一定|肯定/iu },
];
const signal = AbortSignal.timeout(400_000);
const pin = await localTrainingAuthor.pin(model, signal);
assert(localTrainingAuthor.recommendTransfer);
const results = [];
for (const { name, input, direction, grounding } of cases) {
  const result = await localTrainingAuthor.recommendTransfer(model, pin, input, signal);
  assert.equal(result.direction, direction, JSON.stringify({ name, result }));
  assert.deepEqual(result.reasons.map(item => item.evidenceId), input.evidence.map(item => item.id));
  assert.match(result.reasons[0]!.reason, /Friday|周五|星期五|上线|投产|production/iu);
  if (input.evidence.some(item => item.phase === "rewrite"))
    assert.match(result.reasons[1]!.reason, /批准|审批|认可|同意|approval/iu);
  assert.match(result.reasons.at(-1)!.reason, grounding, JSON.stringify({ name, result }));
  assert(result.nextGoal.length >= 12);
  if (input.retest.usedPreview) assert.match(result.nextGoal, /独立|无提示|不(?:参考|使用|看).*提示|没有提示|without|independen/iu);
  assert.deepEqual(result.actions, ["write"]);
  results.push({ name, input, result });
}
assert.notEqual(results[0]!.result.nextGoal, results[1]!.result.nextGoal);
const codeInput: TrainingTransferInput = {
  goal: "练习写 JavaScript 函数，把总秒数转换为分:秒，并处理秒数显示的边界。",
  practice: { ...practice, brief: "播放器时间码", material: ["65 秒显示为 1:05。"] },
  retest: { ...retest, usedPreview: false, independence: "independent", aids: { preview: false, practiceReference: false },
    brief: "转录时间码", material: ["123 秒显示为 2:03。"] },
  evidence: [
    { id: "practice.part1", phase: "practice", key: "part1", control: "code", status: "missed", usedPreview: false,
      question: "将播放器秒数转换为时间码。", answer: "s => Math.floor(s / 60) + ':' + (s % 60)", detail: "公开用例：65 秒期望 1:05，函数实际返回 1:5。" },
    { id: "retest.part1", phase: "retest", key: "part1", control: "code", status: "missed", usedPreview: false,
      question: "给转录片段生成时间码。", answer: "t => [Math.floor(t / 60), t % 60].join(':')", detail: "公开用例：123 秒期望 2:03，函数实际返回 2:3。" },
  ],
};
const codeResult = await localTrainingAuthor.recommendTransfer(model, pin, codeInput, signal);
assert.equal(codeResult.direction, "reinforce", JSON.stringify(codeResult));
assert.deepEqual(codeResult.actions, ["code"]);
assert.match(codeResult.reasons.at(-1)!.reason, /2:0?3|两位|补零|补齐|前导零|格式化/iu);
results.push({ name: "公开用例中独立复现秒数补零问题", input: codeInput, result: codeResult });
// Reproduce the Q3/Q4 cross-client exercise. The budget sentence was also
// reworded, but the writing coach had explicitly selected the launch promise.
const reviewedInput: TrainingTransferInput = {
  goal: "练习自己用英语给同事写一段工作进展，说清已经知道的消息和仍待确认的地方，再解释措辞。我希望保留原稿供复盘。",
  practice: { questionVersion: practice.questionVersion, usedPreview: false, brief: "Progress Report Review",
    material: ["You are preparing an email to your colleague, Sarah, summarizing your progress on the Q3 marketing campaign.\nConfirmed Information: The budget allocation for social media ads has been finalized at $5,000.\nUnconfirmed Information: The final creative assets for the email newsletter are still pending approval from the design team, and the exact launch date is tentative, currently set for the third week of October.\nWrite a professional email to Sarah that clearly outlines the confirmed budget and the pending creative assets and launch date, and then provide a brief explanation of the tone you used."] },
  retest: { questionVersion: retest.questionVersion, usedPreview: false, independence: "independent", aids: { preview: false, practiceReference: false },
    brief: "Revised Progress Summary", material: ["You are now updating your progress report for the Q4 product launch.\nConfirmed Information: The digital advertising budget is now $7,500.\nUnconfirmed Information: The final product feature list is subject to change based on user feedback, and the launch date is tentatively set for the first week of November.\nWrite a revised progress update email to your colleague, Mark, incorporating these new details, and explain the tone you used."] },
  evidence: [
    { id: "practice.part1", phase: "practice", key: "part1", control: "write", status: "recorded", usedPreview: false, question: "Email Draft",
      answer: "The social media budget is $5,000. The newsletter will definitely launch in the third week of October.",
      detail: "已保存你的原文，可在复盘中讨论观点和理由。", reviewedQuote: "The newsletter will definitely launch in the third week of October." },
    { id: "rewrite.part1", phase: "rewrite", key: "part1", control: "write", status: "recorded", usedPreview: true, question: "Email Draft",
      answer: "Our social media budget is set at $5,000. We are targeting the third week of October for the newsletter, pending final design approval.",
      detail: "请根据材料中关于发布日是暂定的信息，修改你写的第二句话，使其准确反映这个信息。", rewriteTiming: "before-retest" },
    { id: "retest.part1", phase: "retest", key: "part1", control: "write", status: "recorded", usedPreview: false, question: "Email Draft",
      answer: "Hi Mark, our Q4 digital advertising budget is confirmed at $7,500. The feature list may change following user feedback. We are targeting the first week of November for launch, pending feedback. I used 'confirmed' for the budget and 'targeting' for the tentative date.",
      detail: "已保存你的原文，可在复盘中讨论观点和理由。" },
  ],
};
const reviewed = await localTrainingAuthor.recommendTransfer(model, pin, reviewedInput, signal);
assert.equal(reviewed.direction, "extend", JSON.stringify(reviewed));
assert.match(reviewed.reasons[0]!.reason, /will definitely launch/iu);
assert.doesNotMatch(reviewed.reasons[0]!.reason, /The social media budget is/iu);
assert.match(reviewed.reasons[1]!.reason, /待定|暂定|尚未|不确定|审批|批准|targeting|approval/iu);
assert.doesNotMatch(reviewed.reasons[1]!.reason, /复测|retest/iu);
results.push({ name: "预算和日期均有改写，以首轮真实点评的发布日期为依据", input: reviewedInput, result: reviewed });
console.log(JSON.stringify({ localOnly: true, syntheticOnly: true, model, modelDigest: pin, modelCalls: results.length, results }, null, 2));
