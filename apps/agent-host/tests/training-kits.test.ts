import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TrainingKind, TrainingAdvice } from "@better-me/agent-contracts";
import { LearningStore } from "../src/growth/learning-store.js";
import { TrainingKits } from "../src/growth/training-kits.js";
import {
  examples,
  exampleSource,
  makeScreen,
  validateDesign,
} from "../src/growth/training-rules.js";
import type { TrainingAuthor } from "../src/growth/training-model.js";
import { localTrainingAuthor } from "../src/growth/training-model.js";
const a = { session: "owner-session", valid: async () => true };
const local = (n: string) => ({
  requestId: randomUUID(),
  consent: true,
  goal: "合成目标: " + n,
  evidence: "一次未掌握的原创练习",
  engine: { type: "local", model: "fixture-local" },
});
const build = (planId: string) => ({
  requestId: randomUUID(),
  planId,
  consent: true,
});
function harness(kind: TrainingKind, overrides: Partial<TrainingAuthor> = {}) {
  const counts = { plan: 0, design: 0, code: 0 };
  const author: TrainingAuthor = {
    pin: async () => "a".repeat(64),
    diagnose: async () => {
      counts.plan++;
      return {
        route: kind,
        observation: "待核对的具体困难",
        nextStep: "练习再验证",
      };
    },
    design: async () => {
      counts.design++;
      return { ...examples[kind], title: "Different generated title" };
    },
    program: async () => {
      counts.code++;
      return exampleSource[kind];
    },
    ...overrides,
  };
  return { author, counts };
}
async function setup(
  kind: TrainingKind,
  overrides: Partial<TrainingAuthor> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "betterme-training-test-")),
    owner = randomUUID(),
    store = new LearningStore(owner, path.join(dir, "owner"));
  const { author, counts } = harness(kind, overrides);
  let now = Date.now();
  const kits = new TrainingKits(store, author, () => now);
  return {
    dir,
    owner,
    kits,
    counts,
    author,
    clock: () => now,
    advance: () => {
      now += 86400001;
    },
    close: async () => {
      kits.close();
      await store.close();
    },
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}
for (const kind of ["rewrite", "dependency"] as const)
  test(
    kind +
      ": real sandbox, distinct generated UI, opt-in retention, restart and transfer without inference",
    async () => {
      const h = await setup(kind);
      let restored: LearningStore | undefined;
      try {
        const p = await h.kits.plan(local(kind), a),
          req = build(p.id),
          k = await h.kits.build(req, a);
        assert.equal(k.title, "Different generated title");
        assert.equal(k.origin, "local");
        assert.equal(k.modelCalls, 3);
        assert.ok(k.verifiedCases >= 6);
        assert.deepEqual(
          k.screen.fields.map((f) => f.control),
          kind === "rewrite" ? ["text"] : ["range", "number"],
        );
        assert.deepEqual(await h.kits.list(a), []);
        await assert.rejects(h.kits.build(build(p.id), a), /already_used/);
        await assert.rejects(
          h.kits.get(k.id, { ...a, session: "different-session" }),
          /not_found/,
        );
        const answer =
          kind === "rewrite"
            ? { answer: "Please send the report by Friday." }
            : { delay: 5, prediction: 9 };
        const preview = await h.kits.command(
          k.id,
          { action: "explore", round: "practice", revision: 0, answer },
          a,
        );
        assert.equal(preview.feedback?.met, true);
        await assert.rejects(
          h.kits.command(
            k.id,
            { action: "submit", round: "practice", revision: 0, answer },
            a,
          ),
          /revision_conflict/,
        );
        const first = await h.kits.command(
          k.id,
          { action: "submit", round: "practice", revision: 1, answer },
          a,
        );
        assert.equal(first.kit?.stage, "waiting");
        assert.equal(first.kit?.attempts[0]?.usedPreview, true);
        await assert.rejects(
          h.kits.command(
            k.id,
            { action: "submit", round: "practice", revision: 2, answer },
            a,
          ),
          /round_closed/,
        );
        await h.kits.command(k.id, { action: "keep", revision: 2 }, a);
        await h.close();
        restored = new LearningStore(h.owner, path.join(h.dir, "owner"));
        const again = new TrainingKits(restored, h.author, h.clock);
        assert.equal((await again.list(a))[0]?.version, k.version);
        assert.equal((await again.get(k.id, a)).stage, "waiting");
        h.advance();
        const second = await again.get(k.id, a);
        assert.equal(second.stage, "retest");
        assert.notDeepEqual(second.screen.notes, k.screen.notes);
        await assert.rejects(
          again.command(
            k.id,
            {
              action: "submit",
              round: "practice",
              revision: second.revision,
              answer,
            },
            a,
          ),
          /round_changed/,
        );
        const last = await again.command(
          k.id,
          {
            action: "submit",
            round: "retest",
            revision: second.revision,
            answer,
          },
          a,
        );
        assert.deepEqual(
          last.kit?.attempts.map((v) => v.usedPreview),
          [true, false],
        );
        assert.equal(last.kit?.stage, "complete");
        assert.deepEqual(last.kit?.attempts[0], first.kit?.attempts[0]);
        await again.command(
          k.id,
          { action: "discard", revision: last.kit!.revision },
          a,
        );
        await assert.rejects(again.get(k.id, a), /not_found/);
        assert.deepEqual(await again.list(a), []);
        assert.deepEqual(h.counts, { plan: 1, design: 1, code: 1 });
      } finally {
        await restored?.close();
        await h.close();
        await h.clean();
      }
    },
  );
test("model can choose a simple exercise or clarification; model dispatch is not replayed", async () => {
  let n = 0;
  const h = await setup("rewrite", {
    diagnose: async () =>
      ({
        route: ++n === 1 ? "simple" : "clarify",
        observation: "Not enough basis",
        nextStep: "Try one small check",
      }) satisfies TrainingAdvice,
  });
  try {
    const input = local("x");
    const p = await h.kits.plan(input, a);
    assert.equal(p.advice.route, "simple");
    await assert.rejects(h.kits.build(build(p.id), a), /no_app_needed/);
    await assert.rejects(h.kits.plan(input, a), /request_already_used/);
    const q = await h.kits.plan(local("y"), a);
    assert.equal(q.advice.route, "clarify");
    assert.equal(n, 2);
    await assert.rejects(h.kits.plan({ ...local("x"), consent: false }, a));
    assert.equal(n, 2);
  } finally {
    await h.close();
    await h.clean();
  }
});
test("qualified code cannot grade unseen inputs itself; a mismatched result leaves no attempt", async () => {
  const h = await setup("rewrite", {
    program: async () => `i=>i.text==='foo'?700:(${exampleSource.rewrite})(i)`,
  });
  try {
    const p = await h.kits.plan(local("x"), a),
      k = await h.kits.build(build(p.id), a);
    await assert.rejects(
      h.kits.command(
        k.id,
        {
          action: "submit",
          round: "practice",
          revision: 0,
          answer: { answer: "foo" },
        },
        a,
      ),
      /runtime_mismatch/,
    );
    assert.deepEqual((await h.kits.get(k.id, a)).attempts, []);
  } finally {
    await h.close();
    await h.clean();
  }
});
test("host denies arbitrary capabilities, graph errors, repeated scenarios and unqualified code", async () => {
  assert.throws(() =>
    validateDesign(
      { ...examples.dependency, permissions: ["microphone"] },
      "dependency",
    ),
  );
  assert.throws(
    () =>
      validateDesign(
        {
          ...examples.rewrite,
          scenes: [examples.rewrite.scenes[0], examples.rewrite.scenes[0]],
        },
        "rewrite",
      ),
    /retest_repeated/,
  );
  const bad = structuredClone(examples.dependency);
  assert.ok(bad.kind === "dependency");
  bad.scenes[0]!.tasks[0]!.after = ["C"];
  assert.throws(() => validateDesign(bad, "dependency"), /graph_invalid/);
  let n = 0;
  const h = await setup("dependency", {
    program: async () => {
      n++;
      return "i => fetch('https://example.invalid')";
    },
  });
  try {
    const p = await h.kits.plan(local("x"), a);
    await assert.rejects(h.kits.build(build(p.id), a), /program_rejected/);
    assert.equal(n, 2);
    assert.deepEqual(await h.kits.list(a), []);
  } finally {
    await h.close();
    await h.clean();
  }
});
test("logout cancels an in-flight generation and discards any late response, no fallback", async () => {
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>((r) => {
    started = r;
  });
  const h = await setup("rewrite", {
    diagnose: async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      return { route: "rewrite", observation: "unused", nextStep: "unused" };
    },
  });
  try {
    const inFlight = h.kits.plan(local("x"), a);
    await wait;
    h.kits.invalidate(a.session);
    release();
    await assert.rejects(inFlight);
    assert.deepEqual(await h.kits.list(a), []);
  } finally {
    await h.close();
    await h.clean();
  }
});
test("training local wire rejects unknown newer daemon before any goal or source is posted", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return Response.json({ version: "0.40.17" });
  });
  await assert.rejects(
    localTrainingAuthor.pin(
      "fixture:local-weight",
      new AbortController().signal,
    ),
  );
  assert.deepEqual(calls, ["http://127.0.0.1:11434/api/version"]);
});
test("open-topic canvas composes different controls per scene; self-report is not a proficiency score", async () => {
  const h = await setup("canvas", {
    program: async () => {
      throw new Error("no generated code required");
    },
  });
  try {
    const p = await h.kits.plan(local("一分钟汇报"), a),
      k = await h.kits.build(build(p.id), a);
    assert.equal(k.modelCalls, 2);
    assert.equal(k.verifiedCases, 6);
    assert.deepEqual(
      k.screen.fields.map((f) => f.control),
      ["choose", "write", "rate"],
    );
    const partial = await h.kits.command(
      k.id,
      {
        action: "explore",
        revision: 0,
        round: "practice",
        answer: {
          parts: { part1: "无效值", part2: "我的建议是先试一天", part3: "0" },
        },
      },
      a,
    );
    assert.equal(partial.feedback?.met, false);
    assert.match(partial.feedback!.detail, /1\/3/);
    await assert.rejects(
      h.kits.command(
        k.id,
        {
          action: "submit",
          revision: 1,
          round: "practice",
          answer: { parts: { part4: "unexpected" } },
        },
        a,
      ),
      /wrong_answer_type/,
    );
    const first = await h.kits.command(
      k.id,
      {
        action: "submit",
        revision: 1,
        round: "practice",
        answer: { parts: { part1: "先说影响", part2: "先试一天", part3: "1" } },
      },
      a,
    );
    assert.equal(first.feedback?.met, true);
    assert.match(first.feedback!.detail, /不评分专业能力/);
    await h.kits.command(k.id, { action: "keep", revision: 2 }, a);
    h.advance();
    const other = await h.kits.get(k.id, a);
    assert.deepEqual(
      other.screen.fields.map((f) => f.control),
      ["write", "choose"],
    );
    assert.deepEqual(h.counts, { plan: 1, design: 1, code: 0 });
  } finally {
    await h.close();
    await h.clean();
  }
});
test("host fixes control instructions and rejects meaningless anchors, identical transfer targets and duplicate options", () => {
  const s = structuredClone(examples.dependency);
  assert.ok(s.kind === "dependency");
  s.answerLabel = "说明选择这个结构的原因";
  s.instruction = "选择依赖结构";
  const screen = makeScreen(s, 0);
  assert.match(screen.fields[1]!.label, /多少天/);
  assert.doesNotMatch(screen.instruction, /选择依赖结构/);
  const w = structuredClone(examples.rewrite);
  assert.ok(w.kind === "rewrite");
  w.scenes[0]!.anchors = ["the", "Friday"];
  assert.throws(() => validateDesign(w, "rewrite"), /design_invalid/);
  const c = structuredClone(examples.canvas);
  assert.ok(c.kind === "canvas");
  const step = c.scenes[0]!.steps[0]!;
  assert.ok(step.mode === "choose");
  step.options = ["同一项", "同一项"];
  assert.throws(() => validateDesign(c, "canvas"), /design_invalid/);
});
test("unconfirmed model transport outcomes do not spend the repair attempt or retry inference", async () => {
  let calls = 0;
  const h = await setup("rewrite", {
    program: async () => {
      calls++;
      throw Error("lost reply");
    },
  });
  try {
    const p = await h.kits.plan(local("x"), a);
    await assert.rejects(h.kits.build(build(p.id), a), /program_rejected/);
    assert.equal(calls, 1);
    await assert.rejects(h.kits.build(build(p.id), a), /already_used/);
    assert.equal(calls, 1);
  } finally {
    await h.close();
    await h.clean();
  }
});
