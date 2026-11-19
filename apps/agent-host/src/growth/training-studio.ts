import type {
  StudioDesign, StudioEvidence, StudioScene, StudioStep, TrainingFeedback, TrainingScreen,
} from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { learningFail } from "./learning-store.js";

import { codeDetail, codeMaterials, runLearnerCode, validateCodeCases, type CodeCaseResult } from "./training-studio-code.js";

const keys = ["part1", "part2", "part3", "part4"] as const;
type Order = Extract<StudioStep, { mode: "order" }>;
type Quantity = Extract<StudioStep, { mode: "quantity" }>;
const operationLabels = {
  sum: "求和",
  difference: "用第一项依次减去其余各项",
  minimum: "求最小值",
  maximum: "求最大值",
};

function labels(step: Order) {
  return [...new Set(step.constraints.flatMap(c => [c.before, c.after]))].sort();
}

// Topological sorting verifies that the stated material is consistent. During
// practice any ordering satisfying the visible constraints is accepted.
function validSequence(step: Order) {
  const pending = new Set(labels(step));
  const result: string[] = [];
  while (pending.size) {
    const next = [...pending].find(label =>
      step.constraints.every(c => c.after !== label || !pending.has(c.before)));
    if (next === undefined) learningFail("training_design_invalid", 422);
    result.push(next);
    pending.delete(next);
  }
  return result;
}
function normalized(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
function taskIdentity(step: StudioStep) {
  if (step.mode === "order") return ["order", step.constraints
    .map(c => JSON.stringify([normalized(c.before), normalized(c.after)])).sort()];
  if (step.mode === "quantity") {
    const values = [...step.values];
    return [step.operation, step.operation === "difference"
      ? [values[0], ...values.slice(1).sort((a, b) => a - b)] : values.sort((a, b) => a - b)];
  }
  if (step.mode === "code") return ["code", step.cases.map(c => JSON.stringify([c.input, c.expected])).sort()];
  return ["write"];
}
export function validateStudio(d: StudioDesign) {
  for (const scene of d.scenes) {
    if (scene.steps.filter(s => s.mode === "code").length > 1) learningFail("training_design_invalid", 422);
    if (new Set(scene.steps.map(s => normalized(s.prompt))).size !== scene.steps.length)
      learningFail("training_design_invalid", 422);
    for (const step of scene.steps) {
      if (normalized(step.followUp) === normalized(step.extend))
        learningFail("training_design_invalid", 422);
      if (step.mode === "code") validateCodeCases(step);
      if (step.mode !== "order") continue;
      const items = labels(step);
      if (items.length > 6 || JSON.stringify(items).length > 400 || new Set(items.map(normalized)).size !== items.length ||
          items.some(label => Array.from(label).some(ch => ch.charCodeAt(0) < 32)) ||
          new Set(step.constraints.map(c => JSON.stringify(c))).size !== step.constraints.length)
        learningFail("training_design_invalid", 422);
      validSequence(step);
    }
  }
  const [a, b] = d.scenes as [StudioScene, StudioScene];
  const initialCode = a.steps.find(s => s.mode === "code");
  const transferCode = b.steps.find(s => s.mode === "code");
  if (initialCode && transferCode) {
    const cases = [...initialCode.cases, ...transferCode.cases];
    if ((initialCode.cases.length < 2 || transferCode.cases.length < 2) && !cases.every(c => typeof c.input === "boolean"))
      learningFail("training_design_invalid", 422);
  }
  if (initialCode || transferCode) {
    if (!initialCode || !transferCode ||
        !transferCode.cases.some(test => !initialCode.cases.some(old => old.input === test.input)))
      learningFail("training_retest_repeated", 422);
  }
  const checks = (s: StudioScene) =>
    s.steps.filter(step => step.mode !== "write").map(step => JSON.stringify(taskIdentity(step))).sort();
  const first = checks(a), second = checks(b);
  if (normalized(a.situation) === normalized(b.situation) ||
      (first.length > 0 && JSON.stringify(first) === JSON.stringify(second)))
    learningFail("training_retest_repeated", 422);
}

export function studioScreen(d: StudioDesign, index: number): TrainingScreen {
  const s = d.scenes[index]!;
  const notes = [s.situation];
  const fields = s.steps.map((step, i): TrainingScreen["fields"][number] => {
    const key = keys[i]!, label = step.prompt;
    if (step.mode === "order") {
      notes.push(`第 ${i + 1} 项 · 先后条件（左项先于右项）：${step.constraints.map(c => `${c.before} → ${c.after}`).join("；")}`);
      return { control: "order", key, label, options: labels(step) };
    }
    if (step.mode === "quantity") {
      notes.push(`第 ${i + 1} 项 · 数据：${step.values.join("，")}。规则：${operationLabels[step.operation]}。`);
      return { control: "quantity", key, label };
    }
    if (step.mode === "code") {
      notes.push(...codeMaterials(step, i + 1));
      return { control: "code", key, label };
    }
    return { control: "write", key, label };
  });
  const guides: string[] = [];
  if (s.steps.some(step => step.mode === "order" || step.mode === "quantity"))
    guides.push("顺序和数值按材料中列出的条件核对。");
  if (s.steps.some(step => step.mode === "code"))
    guides.push("提交的函数将用题面给出的用例运行。");
  if (s.steps.some(step => step.mode === "write"))
    guides.push("文字作答会保留原文，供你继续练习和复盘。");
  return { brief: s.brief, instruction: guides.join(""), fields, notes };
}

type CheckInput =
  | { mode: "order"; constraints: Order["constraints"]; sequence: string[] }
  | { mode: "quantity"; operation: Quantity["operation"]; values: number[]; response: number }
  | { mode: "code"; results: CodeCaseResult[] }
  | { mode: "write"; value: string };

// A small trusted interpreter runs the authored composition under the existing
// QuickJS limits. It receives only the material and the learner's responses.
export const studioSource = `input => input.reduce((mask, step, i) => {
  let accepted;
  if (step.mode === "order") {
    const needed = new Set(step.constraints.flatMap(c => [c.before, c.after]));
    const present = new Set(step.sequence);
    accepted = present.size === needed.size && present.size === step.sequence.length &&
      step.sequence.every(item => needed.has(item)) &&
      step.constraints.every(c => step.sequence.indexOf(c.before) < step.sequence.indexOf(c.after));
  } else if (step.mode === "quantity") {
    const v = step.values;
    const n = step.operation === "sum" ? v.reduce((a,b) => a + b, 0) :
      step.operation === "difference" ? v.reduce((a,b) => a - b) :
      step.operation === "minimum" ? Math.min(...v) : Math.max(...v);
    accepted = n === step.response;
  } else if (step.mode === "code") {
    accepted = step.results.length > 0 && step.results.every(c => !c.issue && c.actual === c.expected);
  } else {
    accepted = step.value.trim().length > 0;
  }
  return mask + (accepted ? 2 ** i : 0);
}, 0)`;

function quantity(step: Pick<Quantity, "values" | "operation">) {
  const [first, ...rest] = step.values;
  switch (step.operation) {
    case "difference": return first! - rest.reduce((a, b) => a + b, 0);
    case "sum": return step.values.reduce((a, b) => a + b, 0);
    case "minimum": return Math.min(...step.values);
    case "maximum": return Math.max(...step.values);
  }
}
function parseAnswer(step: StudioStep, value: string | undefined): CheckInput {
  if (!value?.trim()) learningFail("training_answer_incomplete", 422);
  if (step.mode === "code") return { mode: "code", results: [] };
  if (value.length > 400) learningFail("training_answer_incomplete", 422);
  if (step.mode === "write") return { mode: "write", value };
  if (step.mode === "quantity") {
    if (!/^[+-]?\d{1,9}$/.test(value.trim())) learningFail("training_answer_incomplete", 422);
    return { mode: "quantity", operation: step.operation, values: step.values, response: Number(value) };
  }
  let sequence: unknown;
  try { sequence = JSON.parse(value); } catch { learningFail("training_answer_incomplete", 422); }
  const items = labels(step);
  if (!Array.isArray(sequence) || sequence.length !== items.length ||
      !sequence.every((item: unknown) => typeof item === "string" && items.includes(item)) ||
      new Set(sequence).size !== items.length)
    learningFail("training_answer_incomplete", 422);
  return { mode: "order", constraints: step.constraints, sequence };
}
function brokenConstraint(input: Extract<CheckInput, { mode: "order" }>) {
  const index = new Map(input.sequence.map((label, i) => [label, i]));
  return input.constraints.find(c => index.get(c.before)! >= index.get(c.after)!);
}
function evaluate(input: CheckInput) {
  if (input.mode === "code") return input.results.length > 0 && input.results.every(c => !c.issue && c.actual === c.expected);
  if (input.mode === "order") return brokenConstraint(input) === undefined;
  if (input.mode === "quantity") return input.response === quantity(input);
  return input.value.trim().length > 0;
}
function mask(input: CheckInput[]) {
  return input.reduce((n, step, i) => evaluate(step) ? n | (1 << i) : n, 0);
}
function detail(input: CheckInput) {
  if (input.mode === "code") return codeDetail(input.results);
  if (input.mode === "write") return "已保存你的原文，可在复盘中讨论观点和理由。";
  if (input.mode === "order") {
    const missed = brokenConstraint(input);
    return missed ? `你的顺序把「${missed.after}」放在了「${missed.before}」前面，和材料中的先后条件相冲突。`
      : `你的顺序满足材料给出的全部 ${input.constraints.length} 条先后条件。`;
  }
  const expected = quantity(input);
  return `你填写 ${input.response}。按所给数据${operationLabels[input.operation]}，得到 ${expected}。`;
}
export function studioFixtures() {
  const constraints = [{ before: "A", after: "C" }, { before: "B", after: "C" }];
  const fixtures: { id: string; input: CheckInput[]; expected: number }[] = [
    { id: "code-return-type", input: [{ mode: "code", results: [
      { input: "2", expected: 2, actual: "2" },
    ] }], expected: 0 },
    { id: "code-cases-match", input: [{ mode: "code", results: [
      { input: 0, expected: false, actual: false }, { input: 3, expected: true, actual: true },
    ] }], expected: 1 },
    { id: "partial-order-alternate", input: [{ mode: "order", constraints, sequence: ["B", "A", "C"] }], expected: 1 },
    { id: "precedence-missed", input: [{ mode: "order", constraints, sequence: ["A", "C", "B"] }], expected: 0 },
    { id: "mixed-actions", input: [
      { mode: "quantity", operation: "difference", values: [3, 7, -2], response: -2 },
      { mode: "quantity", operation: "sum", values: [3, 7, -2], response: 3 },
      { mode: "write", value: "一种解释" },
    ], expected: 5 },
    { id: "extremes", input: [
      { mode: "quantity", operation: "minimum", values: [-3, 5], response: -3 },
      { mode: "quantity", operation: "maximum", values: [-3, 5], response: 5 },
      { mode: "write", value: " " },
    ], expected: 3 },
  ];
  return fixtures;
}
export function studioAuthoredCases(d: StudioDesign) {
  return d.scenes.map(scene => {
    const input: CheckInput[] = scene.steps.map(step => step.mode === "code"
      ? { mode: "code", results: step.cases.map(c => ({ ...c, actual: c.expected })) }
      : parseAnswer(step,
      step.mode === "order" ? JSON.stringify(validSequence(step)) :
      step.mode === "quantity" ? String(quantity(step)) : "演练原答"));
    return { input, expected: mask(input) };
  });
}
export async function studioFeedback(d: StudioDesign, index: number, source: string,
  parts: Record<string, string>, signal: AbortSignal, codeKey?: string): Promise<TrainingFeedback> {
  const steps = d.scenes[index]!.steps;
  const codeIndex = steps.findIndex(step => step.mode === "code");
  if (keys[codeIndex] !== codeKey) learningFail("training_wrong_answer_type", 422);
  if (Object.keys(parts).some(k => !keys.slice(0, steps.length).some(key => key === k)))
    learningFail("training_wrong_answer_type", 422);
  const input = steps.map((step, i) => parseAnswer(step, parts[keys[i]!]));
  const codeStep = steps[codeIndex];
  if (codeStep?.mode === "code") {
    const results = await runLearnerCode(codeStep, parts[keys[codeIndex]!]!, signal);
    input[codeIndex] = { mode: "code", results };
  }
  if (await executeTransform(source, input, signal) !== mask(input))
    learningFail("training_runtime_mismatch", 422);
  const evidence: StudioEvidence[] = input.map((item, i) => {
    const status = item.mode === "write" ? "recorded" : evaluate(item) ? "met" : "missed";
    const step = steps[i]!;
    return { key: keys[i]!, status, detail: detail(item), nextStep: status === "met" ? step.extend : step.followUp };
  });
  const checks = evidence.filter(e => e.status !== "recorded");
  const misses = checks.filter(e => e.status === "missed");
  const next = misses[0] ?? evidence.find(e => e.status === "recorded") ?? evidence[0]!;
  const summary: string[] = [];
  if (checks.length) summary.push(`按题面条件核对，${checks.length - misses.length}/${checks.length} 项符合。`);
  if (evidence.length > checks.length) summary.push(`${evidence.length - checks.length} 项开放作答已记录，供复盘。`);
  return { met: misses.length === 0, detail: summary.join(""), evidence, cues: [next.nextStep] };
}
