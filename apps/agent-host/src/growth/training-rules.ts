import { isDeepStrictEqual } from "node:util";
import {
  TrainingDesign,
  type TrainingAnswer,
  type TrainingFeedback,
  type TrainingKind,
  type TrainingExampleKind,
  type TrainingView,
} from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { learningFail } from "./learning-store.js";
import {
  canvasAuthoredCases,
  canvasCases,
  canvasFeedback,
  canvasScreen,
  canvasSource,
  validateCanvas,
} from "./training-canvas.js";
import {
  concurrencyAuthoredCases, concurrencyContract, concurrencyExample, concurrencyFeedback,
  concurrencyFixtures, concurrencyScreen, concurrencySource, validateConcurrency,
} from "./training-concurrency.js";

import {
  studioAuthoredCases, studioFeedback, studioFixtures, studioScreen, validateStudio,
} from "./training-studio.js";

type Graph = Extract<TrainingDesign, { kind: "dependency" }>["scenes"][number];
type Words = Extract<TrainingDesign, { kind: "rewrite" }>["scenes"][number];
const tokens = (text: string): string[] =>
  text.toLowerCase().match(/[a-z]+(?:'[a-z]+)*/g) ?? [];
const finishDays = (g: Graph, delay: number) => {
  const finish = new Map<string, number>();
  for (const task of g.tasks)
    finish.set(
      task.id,
      task.days +
        (task.id === g.change ? delay : 0) +
        Math.max(0, ...task.after.map((k) => finish.get(k)!)),
    );
  return Math.max(...finish.values());
};
export const programContract = {
  rewrite:
    "Input {text:string}. Return ONE integer: number of English words matched by /[a-z]+(?:'[a-z]+)*/gi, including repetitions. Empty text returns 0.",
  dependency:
    "One object: tasks is a topologically sorted array of {id:string,days:number,after:string[]}; changedTaskId is a string id, NEVER a number; extraDays is the nonnegative integer to add. Duration of t is t.days + (t.id === changedTaskId ? extraDays : 0). Finish = duration plus MAX predecessor finish (roots start at 0). Return MAX finish over ALL tasks as one integer. There is no date parsing or rounding.",
  concurrency: concurrencyContract,
};
// Interaction instructions are part of the host's control contract, not prose
// a generator can change into a different task (e.g. an essay in a number box).
export const interactionCopy = {
  rewrite: {
    instruction:
      "把下面的邮件改短。保留请求和截止日期；用你自己的英文写给收件人。",
    answerLabel: "你的英文邮件",
  },
  dependency: {
    instruction:
      "先看任务和前置关系，再调整一项任务的延期天数。预测延期后，从项目开始到全部完成共需几天。",
    answerLabel: "你预测延期后整个项目共需多少天？",
  },
};

export function validateDesign(raw: unknown, kind: TrainingKind) {
  const parsed = TrainingDesign.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== kind)
    learningFail("training_design_invalid", 422);
  const d = parsed.data;
  if (d.kind === "studio") {
    validateStudio(d);
  } else if (d.kind === "rewrite") {
    const originals = d.scenes.map((s) => tokens(s.passage).join(" "));
    const requested = d.scenes.map((s) =>
      s.anchors
        .map((w) => w.toLowerCase())
        .sort()
        .join(" "),
    );
    if (originals[0] === originals[1] || requested[0] === requested[1])
      learningFail("training_retest_repeated", 422);
    for (const s of d.scenes) {
      const words = tokens(s.passage),
        anchors = s.anchors.map((a) => a.toLowerCase());
      if (
        words.length <= s.maxWords ||
        new Set(anchors).size !== anchors.length ||
        !anchors.every(
          (a) =>
            words.includes(a) &&
            !["the", "a", "an", "of", "and", "by", "to", "is"].includes(a),
        )
      )
        learningFail("training_design_invalid", 422);
    }
  } else if (d.kind === "canvas") {
    validateCanvas(d);
  } else if (d.kind === "concurrency") {
    validateConcurrency(d);
    d.title = "乐观并发与数据一致性";
  } else {
    const shapes = d.scenes.map((s) => {
      const ids = s.tasks.map((t) => t.id),
        seen = new Set<string>();
      for (const t of s.tasks) {
        if (
          seen.has(t.id) ||
          new Set(t.after).size !== t.after.length ||
          t.after.some((k) => !seen.has(k))
        )
          learningFail("training_graph_invalid", 422);
        seen.add(t.id);
      }
      if (
        !seen.has(s.change) ||
        !s.tasks.some((t) => t.after.length) ||
        !s.tasks.some((t, i) => i > 0 && !t.after.includes(ids[i - 1]!))
      )
        learningFail("training_graph_invalid", 422);
      return JSON.stringify([
        s.tasks.map((t) => [t.days, t.after.map((k) => ids.indexOf(k))]),
        ids.indexOf(s.change),
      ]);
    });
    if (shapes[0] === shapes[1]) learningFail("training_retest_repeated", 422);
  }
  return d;
}

export const examples: Record<TrainingExampleKind, TrainingDesign> = {
  concurrency: concurrencyExample,
  canvas: {
    kind: "canvas",
    title: "一分钟工作汇报台",
    cards: [
      {
        when: "after_met",
        text: "再读一次：听众能否直接说出你要他们做的下一件事？",
      },
    ],
    scenes: [
      {
        brief: "向同事汇报延期",
        situation: "周会还剩一分钟。交付可能迟两天，但你已经有一个补救方案。",
        steps: [
          {
            mode: "choose",
            prompt: "你准备如何开场？",
            options: ["先说影响", "先说处理方案", "先说背景"],
          },
          { mode: "write", prompt: "写下你在会上会说的前两句话。" },
          { mode: "rate", prompt: "你觉得下一步行动有多清楚？（1–5 自评）" },
        ],
      },
      {
        brief: "向负责人汇报新发现",
        situation:
          "测试里发现了一个可节省半天的做法，但需要负责人决定是否采用。",
        steps: [
          { mode: "write", prompt: "用两句话描述你的建议和所需决定。" },
          {
            mode: "choose",
            prompt: "你希望负责人接下来做什么？",
            options: ["批准试用", "补充证据", "安排讨论"],
          },
        ],
      },
    ],
  },
  rewrite: {
    kind: "rewrite",
    title: "把英文邮件写短",
    instruction: "用一句英文提出请求。保留必要信息，不照抄原稿。",
    answerLabel: "你的英文邮件",
    cards: [
      {
        when: "after_missed",
        text: "先写对方要做什么，再写什么时候要。哪些客套话可以删？",
      },
      { when: "after_met", text: "请再读一次：收件人知道下一步该做什么吗？" },
    ],
    scenes: [
      {
        brief: "向同事索取报告，明确截止日。",
        passage:
          "I am writing to ask if you could please send the report to me by Friday so that I can review it before the team meeting.",
        maxWords: 12,
        anchors: ["report", "Friday"],
      },
      {
        brief: "换个场景：请同事在会议前确认预算。",
        passage:
          "I wanted to reach out to see whether you would be able to confirm the budget by Monday because we need it for our planning meeting.",
        maxWords: 14,
        anchors: ["budget", "Monday"],
      },
    ],
  },
  dependency: {
    kind: "dependency",
    title: "交付推演台",
    instruction: "先预测，再推演。独立任务可并行，所有前置任务完成后才能开始。",
    answerLabel: "你预测整个项目共需多少天？",
    cards: [
      { when: "before", text: "先找哪几项可以同时开始。" },
      {
        when: "after_missed",
        text: "不要直接相加工期。在汇合点，哪条路径最后才到？",
      },
    ],
    scenes: [
      {
        brief: "设计与采购可并行，最后要同时就绪才能验收。",
        tasks: [
          { id: "A", label: "设计", days: 4, after: [] },
          { id: "B", label: "采购", days: 2, after: [] },
          { id: "C", label: "验收", days: 2, after: ["A", "B"] },
        ],
        change: "B",
      },
      {
        brief: "新项目：开发、文案与联调的依赖关系变了。",
        tasks: [
          { id: "X", label: "准备", days: 2, after: [] },
          { id: "Y", label: "开发", days: 4, after: ["X"] },
          { id: "Z", label: "文案", days: 3, after: ["X"] },
          { id: "Q", label: "联调", days: 1, after: ["Y", "Z"] },
        ],
        change: "Z",
      },
    ],
  },
};
export const exampleSource = {
  canvas: canvasSource,
  concurrency: concurrencySource,
  rewrite: "input => (input.text.match(/[a-z]+(?:'[a-z]+)*/gi) || []).length",
  dependency:
    "input => { const end = Object.create(null); for (const t of input.tasks) end[t.id] = t.days + (t.id === input.changedTaskId ? input.extraDays : 0) + Math.max(0,...t.after.map(id=>end[id])); return Math.max(...Object.values(end)); }",
};
const graphInput = (s: Graph, delay: number) => ({
  tasks: s.tasks.map(({ id, days, after }) => ({ id, days, after })),
  changedTaskId: s.change,
  extraDays: delay,
});
export function fixtures(kind: TrainingKind) {
  if (kind === "studio") return studioFixtures();
  if (kind === "canvas") return canvasCases();
  if (kind === "concurrency") return concurrencyFixtures();
  if (kind === "rewrite")
    return [
      "Send the report.",
      "",
      "We'll re-check 42 items; we'll reply.",
      "OK! 3/10… next?",
    ].map((text, i) => ({
      id: "words-" + i,
      input: { text },
      expected: tokens(text).length,
    }));
  const graph = (
    examples.dependency as Extract<TrainingDesign, { kind: "dependency" }>
  ).scenes;
  const extra: Graph = {
    brief: "Independent tail",
    tasks: [
      { id: "a", label: "a", days: 2, after: [] },
      { id: "b", label: "b", days: 8, after: [] },
      { id: "c", label: "c", days: 1, after: ["a"] },
    ],
    change: "a",
  };
  return [
    [graph[0]!, 0],
    [graph[0]!, 5],
    [graph[1]!, 2],
    [extra, 1],
    [extra, 9],
  ].map((pair, i) => {
    const [g, n] = pair as [Graph, number];
    return {
      id: "graph-" + i,
      input: graphInput(g, n),
      expected: finishDays(g, n),
    };
  });
}
export class TrainingProgramMismatch extends Error {}
function authoredCases(design: TrainingDesign) {
  switch (design.kind) {
    case "studio": return studioAuthoredCases(design);
    case "canvas": return canvasAuthoredCases(design);
    case "concurrency": return concurrencyAuthoredCases(design);
    case "rewrite": return design.scenes.map(s => ({
      input: { text: s.passage }, expected: tokens(s.passage).length,
    }));
    case "dependency": return design.scenes.map(s => ({
      input: graphInput(s, 3), expected: finishDays(s, 3),
    }));
  }
}
export async function qualify(
  source: string,
  design: TrainingDesign,
  signal: AbortSignal,
) {
  const cases = [
    ...fixtures(design.kind),
    ...authoredCases(design),
  ];
  for (const [index, c] of cases.entries()) {
    let result: unknown;
    try {
      result = await executeTransform(source, c.input, signal);
    } catch {
      signal.throwIfAborted();
      result = "execution error";
    }
    if (!isDeepStrictEqual(result, c.expected))
      throw new TrainingProgramMismatch(
        index < 2
          ? `Public example ${index + 1}: expected number ${c.expected}, got ${typeof result === "number" && Number.isFinite(result) ? result : result === null ? "null" : typeof result}. Check variable types and function result.`
          : "An independent case did not match. Verify the full contract; hidden inputs and answers are not disclosed.",
      );
  }
  return cases.length;
}
export function makeScreen(
  d: TrainingDesign,
  index: number,
): TrainingView["screen"] {
  if (d.kind === "studio") return studioScreen(d, index);
  if (d.kind === "canvas") return canvasScreen(d, index);
  if (d.kind === "concurrency") return concurrencyScreen(d, index);
  const before = d.cards.filter((c) => c.when === "before").map((c) => c.text);
  if (d.kind === "rewrite") {
    const s = d.scenes[index]!;
    return {
      instruction: interactionCopy.rewrite.instruction,
      brief: s.brief,
      notes: [
        s.passage,
        `最多 ${s.maxWords} 个英文词；保留：${s.anchors.join("、")}。`,
        ...before,
      ],
      fields: [
        {
          control: "text",
          key: "answer",
          label: interactionCopy.rewrite.answerLabel,
        },
      ],
    };
  }
  const s = d.scenes[index]!;
  return {
    instruction: interactionCopy.dependency.instruction,
    brief: s.brief,
    notes: [
      ...s.tasks.map(
        (t) =>
          `${t.id} · ${t.label}：${t.days} 天 · 前置：${t.after.join("、") || "无"}`,
      ),
      ...before,
    ],
    fields: [
      {
        control: "range",
        key: "delay",
        label: `将 ${s.change} 延迟几天？`,
        min: 0,
        max: 10,
        initial: 2,
      },
      {
        control: "number",
        key: "prediction",
        label: interactionCopy.dependency.answerLabel,
        min: 1,
        max: 150,
        initial: 1,
      },
    ],
  };
}
export async function runAnswer(
  d: TrainingDesign,
  index: number,
  source: string,
  a: TrainingAnswer,
  signal: AbortSignal,
): Promise<TrainingFeedback> {
  if (d.kind === "studio" && "parts" in a)
    return studioFeedback(d, index, source, a.parts, signal, "codeKey" in a ? a.codeKey : undefined);
  if ("codeKey" in a) learningFail("training_wrong_answer_type", 422);
  if (d.kind === "canvas" && "parts" in a)
    return canvasFeedback(d, index, source, a.parts, signal);
  if (d.kind === "concurrency" && "parts" in a)
    return concurrencyFeedback(d, index, source, a.parts, signal);
  if (d.kind === "rewrite" && "answer" in a) {
    const s: Words = d.scenes[index]!,
      words: readonly string[] = tokens(a.answer);
    const actual = await executeTransform(source, { text: a.answer }, signal);
    if (actual !== words.length) learningFail("training_runtime_mismatch", 422);
    const missing = s.anchors.filter((w) => !words.includes(w.toLowerCase()));
    const met =
      words.length > 0 && words.length <= s.maxWords && !missing.length;
    return {
      met,
      cues: d.cards
        .filter((c) => c.when === (met ? "after_met" : "after_missed"))
        .map((c) => c.text),
      detail: `${words.length}/${s.maxWords} 词；${missing.length ? "未找到指定词：" + missing.join("、") : "指定词均出现"}。只核对词数和指定词，不评判语义或语法。`,
    };
  }
  if (d.kind === "dependency" && "delay" in a) {
    const s = d.scenes[index]!,
      expected = finishDays(s, a.delay),
      actual = await executeTransform(source, graphInput(s, a.delay), signal);
    if (actual !== expected) learningFail("training_runtime_mismatch", 422);
    const met = actual === a.prediction;
    return {
      met,
      cues: d.cards
        .filter((c) => c.when === (met ? "after_met" : "after_missed"))
        .map((c) => c.text),
      detail: `原排期 ${finishDays(s, 0)} 天；${s.change} 延迟 ${a.delay} 天后为 ${actual} 天。你的预测：${a.prediction} 天。`,
    };
  }
  return learningFail("training_wrong_answer_type", 422);
}
