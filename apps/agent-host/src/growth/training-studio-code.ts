import type { StudioScalar, StudioStep } from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { learningFail } from "./learning-store.js";

export type CodeStep = Extract<StudioStep, { mode: "code" }>;
export type CodeCaseResult = CodeStep["cases"][number] & {
  actual: StudioScalar | null;
  issue?: string;
};

export function validateCodeCases(step: CodeStep) {
  if (new Set(step.cases.map(c => c.input)).size !== step.cases.length)
    learningFail("training_design_invalid", 422);
}

export function codeMaterials(step: CodeStep, part: number) {
  return [
    `第 ${part} 项 · 请提交接收一个输入的 JavaScript 函数表达式，给定用例如下。`,
    ...step.cases.map(c => JSON.stringify(c.input) + " → " + JSON.stringify(c.expected)),
  ];
}

function render(value: StudioScalar | null) {
  const quoted = JSON.stringify(value);
  return quoted.length > 45 ? quoted.slice(0, 44) + "…" : quoted;
}

export function codeDetail(results: CodeCaseResult[]) {
  const passed = results.filter(c => !c.issue && c.actual === c.expected).length;
  const firstMiss = results.find(c => c.issue || c.actual !== c.expected);
  const report = `给定用例 ${results.length} 组，${passed} 组通过。`;
  return firstMiss ? report + `输入 ${render(firstMiss.input)} 时，期望 ${render(firstMiss.expected)}，` +
    (firstMiss.issue ?? `实际返回 ${render(firstMiss.actual)}`) + "。" : report;
}

export async function runLearnerCode(step: CodeStep, source: string, signal: AbortSignal) {
  if (!source.trim() || source.length > 1600) learningFail("training_answer_incomplete", 422);
  // Each invocation gets a fresh guest. A slow answer has one budget across
  // the whole set, and owner/session cancellation always discards the attempt.
  const timeout = AbortSignal.timeout(5000);
  const runSignal = AbortSignal.any([timeout, signal]);
  const results: CodeCaseResult[] = [];
  for (const c of step.cases) {
    signal.throwIfAborted();
    try {
      const output = await executeTransform(source, c.input, runSignal);
      const scalar = typeof output === "boolean" ||
        (typeof output === "number" && Number.isFinite(output)) ||
        (typeof output === "string" && output.length <= 60);
      results.push(scalar ? { ...c, actual: output } : { ...c, actual: null, issue: "返回值超出本题支持的标量范围" });
    } catch (error) {
      signal.throwIfAborted();
      let issue: string;
      if (timeout.aborted) issue = "本次运行时间已用完";
      else if (error instanceof Error && ["sandbox_deadline", "sandbox_memory_limit", "sandbox_output_limit"].includes(error.message))
        issue = "函数运行超过沙箱限制";
      else if (error instanceof Error && ["sandbox_execution_failed", "sandbox_non_json_output"].includes(error.message))
        issue = "函数未能执行并返回可读取的值";
      else throw error;
      results.push({ ...c, actual: null, issue });
      // No further execution after a runtime error. Mark the remaining cases
      // unrun so that the receipt cannot count unobserved outputs as passes.
      for (const pending of step.cases.slice(results.length)) {
        results.push({ ...pending, actual: null, issue: "本次未执行" });
      }
      break;
    }
  }
  return results;
}
