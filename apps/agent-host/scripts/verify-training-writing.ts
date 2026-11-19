/** Explicit synthetic acceptance. Does not read a BetterMe profile or start any service. */
import assert from "node:assert/strict";
import { localTrainingAuthor } from "../src/growth/training-model.js";

const [flag, model] = process.argv.slice(2);
if (flag !== "--synthetic-local" || !model) throw Error("Use --synthetic-local <installed-local-model>");
const exercises = [
  {
    topic: "英文进展沟通",
    goal: "用英语说明技术进展，区分已知与待确认的事项。",
    material: ["测试环境已完成数据迁移。生产上线日期未确认，必须先获得客户批准。"],
    question: "写给同事的英文进展，说明已知状态和仍未确定的地方。",
    answer: "The test migration is complete. Production will go live on Friday.",
    expectedQuote: "Production will go live on Friday.",
    relevant: /未.{0,4}(确认|确定|批准)|待.{0,3}(确认|批准)|客户批准|approval|unconfirmed/i,
  },
  {
    topic: "软件设计取舍",
    goal: "解释引入一种设计模式的理由，并给出判断依据。",
    material: ["现有两种折扣计算方式，过去半年只改过一次。尚不清楚以后是否频繁新增规则。"],
    question: "是否要用策略模式拆分这两种折扣规则？解释你的选择和成立的条件。",
    answer: "现在有两种折扣算法。我会把它们都拆成策略类，因为只要用了策略模式就一定更容易维护。",
    expectedQuote: "我会把它们都拆成策略类，因为只要用了策略模式就一定更容易维护。",
    relevant: /半年|一次|频繁|频率|频次/,
  },
  {
    topic: "英语主谓一致",
    goal: "练习英语一般现在时的主谓一致。",
    material: ["Mia 是一名编辑。她每天早晨审阅报告。"],
    question: "用英语介绍 Mia 的日常工作，注意主语和谓语的形式。",
    answer: "Mia is an editor. She review the reports every morning.",
    expectedQuote: "She review the reports every morning.",
    relevant: /三单|第三人称单数|主谓一致|subject.verb agreement|third.person singular/iu,
    replacementSentence: /she\s+reviews\s+(?:the\s+)?reports/iu,
  },
];
const signal = AbortSignal.timeout(240000);
const pin = await localTrainingAuthor.pin(model, signal);
assert(localTrainingAuthor.reviewWriting);
const reports = [];
for (const { topic, expectedQuote, relevant, replacementSentence, ...input } of exercises) {
  const feedback = await localTrainingAuthor.reviewWriting(model, pin, input, signal);
  assert.equal(feedback.quote, expectedQuote, `Review should cite the issue in the learner's own words: ${JSON.stringify(feedback)}`);
  assert.ok(feedback.comment.length > 0 && feedback.comment.length <= 400);
  assert.ok(feedback.revisionPrompt.length > 0 && feedback.revisionPrompt.length <= 140);
  assert.match(feedback.comment, relevant);
  if (replacementSentence) assert.doesNotMatch(feedback.comment + " " + feedback.revisionPrompt, replacementSentence);
  reports.push({ topic, ...input, feedback });
}
console.log(JSON.stringify({ syntheticOnly: true, localOnly: true, model, modelDigest: pin, modelCalls: reports.length, reports }, null, 2));
