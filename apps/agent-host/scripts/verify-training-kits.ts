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
  type TrainingView,
  type TrainingAnswer,
} from "@better-me/agent-contracts";
import { fixtures, validateDesign } from "../src/growth/training-rules.js";
import { executeTransform } from "../src/capabilities/sandbox.js";

const [flag, model, only] = process.argv.slice(2);
if (
  flag !== "--synthetic-local" ||
  !model ||
  (only && !["rewrite", "dependency", "canvas"].includes(only))
)
  throw Error(
    "Use --synthetic-local <installed-local-model> [rewrite|dependency|canvas]",
  );
const directory = await mkdtemp(path.join(tmpdir(), "betterme-training-qa-"));
const root = path.join(directory, "owner"),
  owner = randomUUID(),
  access = { session: "isolated", valid: async () => true };
let time = Date.now(),
  calls = 0;
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
        validateDesign(d, args[2]);
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
      );
      throw e;
    }
  },
  async program(...args) {
    calls++;
    const code = await localTrainingAuthor.program(...args);
    for (const c of fixtures(args[2])) {
      let out: unknown;
      try {
        out = await executeTransform(code, c.input, args[3]);
      } catch {
        out = "execution error";
      }
      if (out !== c.expected) {
        console.error(
          JSON.stringify({
            syntheticOnly: true,
            candidate: code,
            failedCase: c.id,
            expected: c.expected,
            actual: out,
          }),
        );
        break;
      }
    }
    return code;
  },
};
const store = new LearningStore(owner, root),
  kits = new TrainingKits(store, author, () => time);
try {
  for (const kind of ["rewrite", "dependency", "canvas"] as const) {
    if (only && only !== kind) continue;
    const start = calls;
    try {
      const [goal, evidence] =
        kind === "canvas"
          ? [
              "我想能向没有技术背景的人解释一个概念。",
              "上周给同事讲缓存时一直抛术语，听的人还是不知道它的用处。我想反复练习举生活里的例子。",
            ]
          : kind === "rewrite"
            ? [
                "我想把英文工作邮件写简短。",
                "为了客气写了好多句；缩短后常忘记请求的内容和截止日期。",
              ]
            : [
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
        },
        access,
      );
      assert.equal(plan.advice.route, kind);
      const kit = await kits.build(
        { requestId: randomUUID(), planId: plan.id, consent: true },
        access,
      );
      assert.equal(kit.origin, "local");
      assert.equal(kit.kind, kind);
      assert.equal(kit.modelCalls, calls - start);
      const answer = (v: TrainingView): TrainingAnswer =>
        kind === "canvas"
          ? {
              parts: Object.fromEntries(
                v.screen.fields.map((f) => [
                  f.key,
                  "options" in f ? f.options[0] : "就像把常用的书放在手边。",
                ]),
              ),
            }
          : kind === "rewrite"
            ? { answer: "Please confirm by Friday." }
            : { delay: 2, prediction: 5 };
      const first = await kits.command(
        kit.id,
        {
          action: "submit",
          round: "practice",
          revision: kit.revision,
          answer: answer(kit),
        },
        access,
      );
      assert.equal(first.kit?.stage, "waiting");
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
      assert.equal(calls - start, kit.modelCalls);
      console.log(
        JSON.stringify({
          kind,
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
