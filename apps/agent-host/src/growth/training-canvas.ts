import type {
  TrainingDesign,
  TrainingFeedback,
  TrainingView,
} from "@better-me/agent-contracts";
import { executeTransform } from "../capabilities/sandbox.js";
import { learningFail } from "./learning-store.js";

type Canvas = Extract<TrainingDesign, { kind: "canvas" }>;
type Scene = Canvas["scenes"][number];
const keys = ["part1", "part2", "part3", "part4"] as const;
const scale = ["1", "2", "3", "4", "5"];
const options = (s: Scene["steps"][number]) =>
  s.mode === "choose" ? s.options : s.mode === "rate" ? scale : [];

// A declarative app can collect a rehearsal, a personal decision and/or a
// self-rating in any order. It checks participation, NOT correctness of prose.
export function validateCanvas(d: Canvas) {
  if (d.scenes[0]!.situation.trim() === d.scenes[1]!.situation.trim())
    learningFail("training_retest_repeated", 422);
  for (const s of d.scenes) {
    if (
      !s.steps.some((x) => x.mode === "write") ||
      new Set(s.steps.map((x) => x.prompt)).size !== s.steps.length ||
      s.steps.some(
        (x) =>
          x.mode === "choose" && new Set(x.options).size !== x.options.length,
      )
    )
      learningFail("training_design_invalid", 422);
  }
}
export function canvasScreen(d: Canvas, i: number): TrainingView["screen"] {
  const s = d.scenes[i]!;
  return {
    brief: s.brief,
    instruction:
      "按下列步骤演练。反馈只核对是否完成填写，不判断专业对错；自评只代表你自己的判断。",
    notes: [
      s.situation,
      ...d.cards.filter((x) => x.when === "before").map((x) => x.text),
    ],
    fields: s.steps.map((v, j) =>
      v.mode === "write"
        ? { control: "write", key: keys[j]!, label: v.prompt }
        : {
            control: v.mode,
            key: keys[j]!,
            label: v.prompt,
            options: options(v),
          },
    ),
  };
}
const input = (s: Scene, answers: Record<string, string>) => ({
  parts: s.steps.map((x, j) => ({
    mode: x.mode,
    value: answers[keys[j]!] ?? "",
    options: options(x),
  })),
});
type Input = ReturnType<typeof input>;
const filled = (p: Input["parts"][number]) =>
  p.mode === "write" ? p.value.trim().length > 0 : p.options.includes(p.value);
const count = (x: Input) => x.parts.filter(filled).length;
export const canvasSource =
  'x => x.parts.reduce((n,p) => n + Number(p.mode === "write" ? p.value.trim() !== "" : p.options.includes(p.value)), 0)';
export function canvasCases() {
  return [
    { parts: [] },
    { parts: [{ mode: "write", value: " ", options: [] }] },
    {
      parts: [
        { mode: "write", value: "有一个想法", options: [] },
        { mode: "choose", value: "a", options: ["b", "a"] },
      ],
    },
    {
      parts: [
        { mode: "choose", value: "other", options: ["a", "b"] },
        { mode: "rate", value: "6", options: scale },
        { mode: "rate", value: "3", options: scale },
      ],
    },
  ].map((v, i) => ({
    id: "canvas-" + i,
    input: v,
    expected: count(v as Input),
  }));
}
export function canvasAuthoredCases(d: Canvas) {
  return d.scenes.map((s) => {
    const a = Object.fromEntries(
      s.steps.map((x, i) => [
        keys[i]!,
        x.mode === "write" ? "示范回答" : options(x)[0]!,
      ]),
    );
    const v = input(s, a);
    return { input: v, expected: count(v) };
  });
}
export async function canvasFeedback(
  d: Canvas,
  index: number,
  source: string,
  parts: Record<string, string>,
  signal: AbortSignal,
): Promise<TrainingFeedback> {
  const s = d.scenes[index]!;
  if (
    Object.keys(parts).some(
      (k) => !keys.slice(0, s.steps.length).some((key) => key === k),
    )
  )
    learningFail("training_wrong_answer_type", 422);
  const v = input(s, parts),
    n = count(v);
  if ((await executeTransform(source, v, signal)) !== n)
    learningFail("training_runtime_mismatch", 422);
  const met = n === s.steps.length,
    missing = v.parts.flatMap((x, i) => (filled(x) ? [] : [i + 1]));
  return {
    met,
    detail: `完成 ${n}/${s.steps.length} 项。${missing.length ? "尚未有效填写：第 " + missing.join("、") + " 项。" : ""}仅核对参与情况，不评分专业能力或自评高低。`,
    cues: d.cards
      .filter((c) => c.when === (met ? "after_met" : "after_missed"))
      .map((c) => c.text),
  };
}
