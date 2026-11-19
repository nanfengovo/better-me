import type { TrainingDesign, TrainingFeedback, TrainingScreen } from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { learningFail } from "./learning-store.js";

type Concurrency = Extract<TrainingDesign, { kind: "concurrency" }>;
type Scene = Concurrency["scenes"][number];
const conflictOptions = ["并发冲突，重新读取", "旧版本保存成功", "自动合并两次写入"];
const decisionOptions = ["重新核对后提交", "余量不足，拒绝第二次扣减", "直接重试旧版本"];

// Model-authored code computes the remaining quantity. The host independently
// owns the concurrency assumptions, business condition and reference answer.
export const concurrencyContract = "Input {initial, first, second}: all integers, initial >= first and initial >= second. First deduction commits. Re-read the remaining quantity before the second deduction. Apply the second only if the remainder is sufficient. Return the final remaining quantity as one integer.";
export const concurrencySource = "input => { const remaining = input.initial - input.first; return input.second <= remaining ? remaining - input.second : remaining; }";
export const concurrencyExample: Concurrency = {
  kind: "concurrency",
  title: "乐观并发与库存扣减",
  cards: [
    { when: "after_missed", text: "核对并发令牌后，始终基于重新读取的余量判断第二次操作。" },
    { when: "after_met", text: "换一组输入，看看业务校验结果是否会改变。" },
  ],
  scenes: [
    { resource: "库存商品", initial: 10, first: 6, second: 5 },
    { resource: "生产工件", initial: 17, first: 4, second: 6 },
  ],
};

function enough(s: Scene) {
  return s.initial - s.first >= s.second;
}
function expected(s: Scene) {
  const remaining = s.initial - s.first;
  return enough(s) ? remaining - s.second : remaining;
}
function input(s: Scene) {
  return { initial: s.initial, first: s.first, second: s.second };
}
export function validateConcurrency(d: Concurrency) {
  for (const s of d.scenes) {
    if (s.first > s.initial || s.second > s.initial)
      learningFail("training_design_invalid", 422);
  }
  if (enough(d.scenes[0]!) === enough(d.scenes[1]!) || expected(d.scenes[0]!) === expected(d.scenes[1]!))
    learningFail("training_retest_repeated", 422);
}
export function concurrencyFixtures() {
  return [
    { id: "commit-both", input: {initial: 14, first: 3, second: 6}, expected: 5 },
    { id: "reject-second", input: {initial: 10, first: 6, second: 5}, expected: 4 },
    { id: "exact-remaining", input: {initial: 19, first: 7, second: 12}, expected: 0 },
    { id: "first-exhausts", input: {initial: 2, first: 2, second: 1}, expected: 0 },
    { id: "one-short", input: {initial: 23, first: 13, second: 11}, expected: 10 },
  ];
}
export function concurrencyAuthoredCases(d: Concurrency) {
  return d.scenes.map(s => ({ input: input(s), expected: expected(s) }));
}
export function concurrencyScreen(d: Concurrency, index: number): TrainingScreen {
  const s = d.scenes[index]!;
  return {
    brief: `${s.resource} · 两个并发请求`,
    instruction: "这是配置了并发令牌的 EF Core 乐观并发模拟。先判断旧版本保存结果，再预测重新读取并校验后的业务决定和最终余量。",
    notes: [
      `A 和 B 读取同一行和同一个并发令牌，初始余量 ${s.initial}。`,
      `A 扣减 ${s.first} 后成功提交，令牌已更新。B 仍使用原令牌，打算扣减 ${s.second}。`,
      "假设每次扣减必须完整满足，余量不可为负，且无其他写入。",
    ],
    fields: [
      { control: "choose", key: "part1", label: "B 第一次 SaveChanges 的结果？", options: conflictOptions },
      { control: "choose", key: "part2", label: "处理冲突后 B 应怎样决定？", options: decisionOptions },
      { control: "number", key: "part3", label: "最终余量是多少？", min: 0, max: s.initial, initial: 0 },
    ],
  };
}
export async function concurrencyFeedback(d: Concurrency, index: number, source: string,
  parts: Record<string, string>, signal: AbortSignal): Promise<TrainingFeedback> {
  const s = d.scenes[index]!;
  if (!conflictOptions.includes(parts.part1 ?? "") || !decisionOptions.includes(parts.part2 ?? "")
    || !/^\d{1,3}$/.test(parts.part3 ?? "") || Number(parts.part3) > s.initial)
    learningFail("training_answer_incomplete", 422);
  const reference = expected(s);
  const actual = await executeTransform(source, input(s), signal);
  if (actual !== reference) learningFail("training_runtime_mismatch", 422);
  const decision = enough(s) ? decisionOptions[0]! : decisionOptions[1]!;
  const met = parts.part1 === conflictOptions[0] && parts.part2 === decision && Number(parts.part3) === reference;
  return {
    met,
    detail: `旧令牌触发并发冲突。重新读取后余量为 ${s.initial - s.first}，${decision}，最终余量 ${reference}。独立核对了本模拟中的决定与计算。`,
    cues: d.cards.filter(c => c.when === (met ? "after_met" : "after_missed")).map(c => c.text),
  };
}
