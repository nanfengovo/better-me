/** Explicit, local-only acceptance; NEVER opens a real BetterMe owner directory. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LearningStore } from "../src/growth/learning-store.js";
import { TrainingKits } from "../src/growth/training-kits.js";
import {
  localTrainingAuthor,
  type TrainingAuthor,
} from "../src/growth/training-model.js";
import {
  TrainingDesign,
  careerJobSnapshotVersion,
  type TrainingView,
  type TrainingAnswer,
  type TrainingCareerContext,
  type StudioDesign,
  type StudioStep,
} from "@better-me/agent-contracts";
import { validateDesign } from "../src/growth/training-rules.js";

const [flag, model, only] = process.argv.slice(2);
if (
  flag !== "--synthetic-local" ||
  !model ||
  (only && !["studio", "code", "open", "rewrite", "dependency", "canvas", "concurrency"].includes(only))
)
  throw Error(
    "Use --synthetic-local <installed-local-model> [studio|code|open|rewrite|dependency|canvas|concurrency]",
  );
const directory = await mkdtemp(path.join(tmpdir(), "betterme-training-qa-"));
const root = path.join(directory, "owner"),
  owner = randomUUID(),
  access = { session: "isolated", valid: async () => true };
let time = Date.now(),
  calls = 0;
let currentDesign: StudioDesign | undefined;
const author: TrainingAuthor = {
  pin: localTrainingAuthor.pin,
  async diagnose(...args) {
    calls++;
    return localTrainingAuthor.diagnose(...args);
  },
  async design(...args) {
    calls++;
    try {
      const d = await localTrainingAuthor.design(...args);
      try {
        const checked = validateDesign(d, args[2]);
        assert.equal(checked.kind, "studio");
        currentDesign = checked;
      } catch {
        const schema = TrainingDesign.safeParse(d);
        console.error(
          JSON.stringify({
            syntheticOnly: true,
            invalidDesign: d,
            issues: schema.success
              ? []
              : schema.error.issues.map((i) => [i.path, i.code]),
          }),
        );
      }
      return d;
    } catch (e) {
      console.error(
        "Synthetic design transport:",
        e instanceof Error ? e.message : "failed",
        e instanceof Error && "referenceDiagnostic" in e ? JSON.stringify(e.referenceDiagnostic)
          : e instanceof Error && e.cause ? JSON.stringify(e.cause) : "",
      );
      throw e;
    }
  },
  async program() {
    throw Error("Generic practice should qualify its declared operations without a separate model program.");
  },
};
const syntheticJob = { id: "synthetic-jd", title: ".NET 后端工程师", company: "合成公司", description: "任职要求：\n熟悉 EF Core 乐观并发和数据一致性" };
const syntheticCareer: TrainingCareerContext = {
  workspaceKey: "isolated-workspace", targetId: randomUUID(), goalId: "goal-example", goal: "提升后端并发能力",
  planId: "plan-example", planTitle: "合成学习方案", taskId: "task-example", taskTitle: "处理乐观并发冲突",
  competency: "EF Core 并发令牌冲突后重新读取并判断库存扣减",
  criterion: "正确决定旧版本保存结果、重新核验后是否扣减及最终余量",
  requirement: { jobId: syntheticJob.id, title: syntheticJob.title, company: syntheticJob.company,
    snapshotVersion: careerJobSnapshotVersion(syntheticJob), itemId: "req-1", quote: "熟悉 EF Core 乐观并发和数据一致性" },
};
const store = new LearningStore(owner, root),
  kits = new TrainingKits(store, author, () => time, async ref =>
    ref.workspaceKey === syntheticCareer.workspaceKey && ref.targetId === syntheticCareer.targetId ? syntheticCareer : undefined);
function response(step: StudioStep, missed: boolean, promptCase: string): string {
  if (step.mode === "code") return missed ? "value => value + 1" : "value => Math.abs(value)";
  if (step.mode === "write") return promptCase === "open" ? "We have a first draft ready. We are still waiting for the updated schedule, and I will share it at noon." : "我先注明观测依据，再解释仍需确认的地方。";
  if (step.mode === "quantity") {
    const values = step.values;
    const expected = step.operation === "sum" ? values.reduce((a, b) => a + b)
      : step.operation === "difference" ? values.reduce((a, b) => a - b)
        : step.operation === "minimum" ? Math.min(...values) : Math.max(...values);
    return String(expected + Number(missed));
  }
  const remaining = new Set(step.constraints.flatMap(c => [c.before, c.after]));
  const order: string[] = [];
  while (remaining.size) {
    const next = [...remaining].find(item => step.constraints.every(c => c.after !== item || !remaining.has(c.before)));
    assert.notEqual(next, undefined);
    order.push(next!);
    remaining.delete(next!);
  }
  return JSON.stringify(missed ? order.reverse() : order);
}
try {
  for (const kind of ["studio", "code", "open", "rewrite", "dependency", "canvas", "concurrency"] as const) {
    if (only && only !== kind) continue;
    const start = calls;
    let chosenActions: readonly string[] | undefined;
    try {
      const [goal, evidence] =
        kind === "studio"
          ? ["我想练习从海洋观测日志里重建事件顺序，并算出浮标两次测量的盐度差。", ""]
          : kind === "open"
            ? ["练习自己用英语给同事写一段工作进展，说清已经知道的消息和仍待确认的地方，再解释措辞。我希望保留原稿供复盘。", ""]
          : kind === "code"
            ? ["我想亲自编写并运行 JavaScript 纯函数，输入一个摄氏整数温度，输出它离零度的距离（绝对值），在正数、负数和零上测试。隔天换一批输入，但函数合同相同。", ""]
          : kind === "canvas"
          ? [
              "我想能向没有技术背景的人解释一个概念。",
              "上周给同事讲缓存时一直抛术语，听的人还是不知道它的用处。我想反复练习举生活里的例子。",
            ]
          : kind === "rewrite"
            ? [
                "我想把英文工作邮件写简短。",
                "为了客气写了好多句；缩短后常忘记请求的内容和截止日期。",
              ]
            : kind === "concurrency" ? [
                syntheticCareer.competency,
                "两个请求以同一并发令牌读取库存，第一次更新成功后，我不确定第二次 SaveChanges 怎么处理，需练习库存不足和余量足够的决定。",
              ] : [
                "我想学会估算并行项目的交付时间。",
                "我会算单项工期，可是两个任务一起做时，我把每个延期都加到了最终交付日。",
              ];
      const plan = await kits.plan(
        {
          requestId: randomUUID(),
          engine: { type: "local", model },
          consent: true,
          goal,
          evidence,
          ...(kind === "concurrency" ? { careerTarget: { workspaceKey: syntheticCareer.workspaceKey, targetId: syntheticCareer.targetId } } : {}),
        },
        access,
      );
      chosenActions = plan.advice.practiceActions;
      assert.equal(plan.advice.route, "studio");
      const kit = await kits.build(
        { requestId: randomUUID(), planId: plan.id, consent: true },
        access,
      );
      assert.equal(kit.origin, "local");
      assert.equal(kit.kind, "studio");
      assert.equal(kit.modelCalls, calls - start);
      assert.ok(currentDesign);
      const design = currentDesign;
      const answer = (view: TrainingView, missed = false): TrainingAnswer => {
        const scene = design.scenes[view.stage === "retest" ? 1 : 0]!;
        const parts = Object.fromEntries(scene.steps.map((step, index) =>
          ["part" + (index + 1), response(step, missed, kind)]));
        const codeIndex = scene.steps.findIndex(step => step.mode === "code");
        if (codeIndex < 0) return { parts };
        const codeKey = (["part1", "part2", "part3", "part4"] as const)[codeIndex]!;
        return { parts, codeKey };
      };
      let revision = kit.revision;
      let missedNext: string | undefined;
      if (kind === "open") {
        assert.ok(design.scenes.every(scene => scene.steps.every(s => s.mode === "write")),
          "An open workplace writing goal should retain the learner's writing.");
        for (const scene of design.scenes) {
          assert.ok(scene.situation.split("\n").every(line => /[.!?]["'’”)]*$/u.test(line)),
            "English setting, facts and instructions must each end in a complete sentence.");
          for (const instruction of scene.steps.flatMap(step => [step.followUp, step.extend])) {
            assert.match(instruction, /[.!?]["'’”)]*$/u, "A writing follow-up must reach the end of its sentence.");
            assert.ok(instruction.length <= 140);
          }
        }
      }
      if (kind === "studio" || kind === "code") {
        if (kind === "studio") {
          assert.ok(design.scenes.every(scene => scene.steps.some(s => s.mode === "order") &&
            scene.steps.some(s => s.mode === "quantity" && s.operation === "difference")),
            "The requested sequencing and change in readings should be present in both situations");
        }
        if (kind === "code") {
          assert.ok(design.scenes.every(s => s.steps.some(step => step.mode === "code")),
            "A request to write runnable code must actually use the source editor in both rounds");
          for (const scene of design.scenes) {
            const code = scene.steps.find(step => step.mode === "code")!;
            assert.ok(code.cases.every(c => typeof c.input === "number" && c.expected === Math.abs(c.input)),
              "The frozen cases must follow the requested absolute-value contract.");
          }
        }
        assert.ok(design.scenes.every(s => s.steps.some(step => step.mode !== "write")),
          "Both rounds should check a measurable action for this particular goal");
        const exploration = await kits.command(kit.id, { action: "explore", round: "practice",
          revision, answer: answer(kit, true) }, access);
        assert.equal(exploration.feedback?.met, false);
        missedNext = exploration.feedback?.evidence?.find(item => item.status === "missed")?.nextStep;
        assert.ok(missedNext);
        revision = exploration.kit!.revision;
      }
      const first = await kits.command(
        kit.id,
        {
          action: "submit",
          round: "practice",
          revision,
          answer: answer(kit),
        },
        access,
      );
      assert.equal(first.kit?.stage, "waiting");
      assert.equal(first.feedback?.met, true);
      const metNext = first.feedback?.evidence?.find(item => item.status === "met")?.nextStep;
      if (kind === "studio" || kind === "code") {
        assert.ok(metNext);
        assert.notEqual(missedNext, metNext);
      }
      await kits.command(
        kit.id,
        { action: "keep", revision: first.kit!.revision },
        access,
      );
      time += 86400001;
      const next = await kits.get(kit.id, access);
      assert.equal(next.stage, "retest");
      assert.notDeepEqual(next.screen, kit.screen);
      const result = await kits.command(
        kit.id,
        {
          action: "submit",
          round: "retest",
          revision: next.revision,
          answer: answer(next),
        },
        access,
      );
      assert.equal(result.kit?.stage, "complete");
      assert.equal(result.kit?.attempts[1]?.feedback.met, true);
      assert.equal(result.kit?.attempts[1]?.usedPreview, false);
      if (kind === "open") assert.ok(result.kit?.attempts.every(a => a.feedback.evidence?.every(e => e.status === "recorded")));
      if (kind === "concurrency") assert.equal(result.kit?.career?.requirement.quote, syntheticCareer.requirement.quote);
      assert.equal(calls - start, kit.modelCalls);
      console.log(
        JSON.stringify({
          goalCase: kind,
          chosenActions,
          kind: kit.kind,
          goal: plan.goal,
          observation: plan.advice.observation,
          firstScreen: kit.screen,
          transferScreen: next.screen,
          attempts: result.kit!.attempts.map(a => ({
            round: a.round, questionVersion: a.questionVersion, usedPreview: a.usedPreview,
            answer: a.answer, feedback: a.feedback,
          })),
          firstControls: kit.screen.fields.map(f => f.control),
          transferControls: next.screen.fields.map(f => f.control),
          ...(missedNext ? { missedNext, metNext } : {}),
          model,
          title: kit.title,
          version: kit.version,
          checks: kit.verifiedCases,
          modelCalls: calls - start,
          stage: "complete",
          distinctScreens: true,
          localOnly: true,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          kind,
          model,
          modelCalls: calls - start,
          chosenActions,
          generatedSteps: currentDesign?.scenes.map(scene => scene.steps.map(step =>
            step.mode === "code" ? { mode: step.mode, cases: step.cases } : step.mode)),
          error: error instanceof Error ? error.message : "failed",
        }),
      );
      process.exitCode = 1;
    }
  }
} finally {
  kits.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
