import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TrainingExampleKind, TrainingAdvice } from "@better-me/agent-contracts";
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
function harness(kind: TrainingExampleKind, overrides: Partial<TrainingAuthor> = {}) {
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
  kind: TrainingExampleKind,
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

test("goal alone reaches the local studio author and preserves per-action feedback across a different transfer", async (t) => {
  const requests: { format: { properties: Record<string, { enum?: string[] }> }; messages: { content: string }[] }[] = [];
  const model = "fixture-local", digest = "b".repeat(64);
  const goal = "从车票时间线重建换乘顺序并解释依据";
  const practice = {
    brief: "合成车票", situation: "两张车票显示先到北站，再到南站。",
    steps: [
      { mode: "order", constraints: [{ before: "北站", after: "南站" }], prompt: "排出经过的站点", followUp: "找出首段终点", extend: "中间加站会如何改变顺序？" },
      { mode: "write", prompt: "用一句话指出依据", followUp: "哪张票提供了依据？", extend: "换一个人解释是什么顺序" },
    ],
  };
  const transfer = {
    brief: "改签后的票", situation: "车票改签后，去河口前要在山城换乘。",
    steps: [{ ...practice.steps[0], constraints: [{ before: "山城", after: "河口" }] }],
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/version")) return Response.json({ version: "0.40.16" });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: model, model, digest, size: 10 }] });
    if (url.endsWith("/api/show")) return Response.json({ details: { format: "gguf" },
      model_info: { "general.architecture": "synthetic", "general.parameter_count": 1 } });
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const reply = body.format.properties.route ? { route: "studio", needsCode: false, needsOrder: true, needsQuantity: false, needsWriting: true, codeSignature: { input: "integer", output: "integer" }, observation: "先用两张票观察", nextStep: "重建一次换乘记录" }
      : { title: "重建换乘", orderMode: "sequence",
        practice: { brief: practice.brief, situation: practice.situation, first: { mode: "order", firstEvents: [{ name: "北站", observation: "首段到达" }],
          between: [], lastEvents: [{ name: "南站", observation: "次段到达" }], additionalEvent: "西站增停" }, second: practice.steps[1], extra: [] },
        transfer: { brief: transfer.brief, situation: transfer.situation, first: { mode: "order", firstEvents: [{ name: "山城", observation: "改签中转" }],
          between: [], lastEvents: [{ name: "河口", observation: "终点下车" }], additionalEvent: "列车临停" }, second: practice.steps[1], extra: [] },
      };
    return Response.json({ done: true, done_reason: "stop", model: model + ":local",
      message: { role: "assistant", content: JSON.stringify(reply) } });
  });
  const dir = await mkdtemp(path.join(tmpdir(), "betterme-studio-wire-"));
  const id = randomUUID(), root = path.join(dir, "owner");
  let now = Date.now(), store = new LearningStore(id, root), kits = new TrainingKits(store, localTrainingAuthor, () => now);
  try {
    const plan = await kits.plan({ requestId: randomUUID(), engine: { type: "local", model }, goal, consent: true }, a);
    assert.equal(plan.evidence, "");
    assert.equal(plan.advice.route, "studio");
    assert.deepEqual(requests[0]!.format.properties.route!.enum, ["studio", "simple", "clarify"]);
    const kit = await kits.build(build(plan.id), a);
    assert.equal(JSON.parse(requests[1]!.messages[1]!.content).goal, goal);
    assert.deepEqual(kit.screen.fields.map(f => f.control), ["order", "write"]);
    const submit = async (first: boolean, revision: number) => kits.command(kit.id, {
      action: first ? "explore" : "submit", revision, round: "practice",
      answer: { parts: { part1: JSON.stringify(first ? ["南站 · 次段到达", "北站 · 首段到达"] : ["北站 · 首段到达", "南站 · 次段到达"]), part2: "依据两段车票" } },
    }, a);
    const missed = await submit(true, kit.revision);
    const fixed = await submit(false, missed.kit!.revision);
    assert.deepEqual(missed.feedback?.evidence?.map(e => e.status), ["missed", "recorded"]);
    assert.match(missed.feedback!.evidence![0]!.nextStep, /北站.*南站/);
    assert.equal(missed.feedback!.evidence![1]!.nextStep, "哪张票提供了依据？");
    assert.match(fixed.feedback!.evidence![0]!.nextStep, /西站增停/);
    const kept = await kits.command(kit.id, { action: "keep", revision: fixed.kit!.revision }, a);
    kits.close();
    await store.close();
    now += 86_400_001;
    store = new LearningStore(id, root);
    kits = new TrainingKits(store, localTrainingAuthor, () => now);
    const next = await kits.get(kit.id, a);
    assert.equal(next.stage, "retest");
    assert.notEqual(next.questionVersion, kit.questionVersion);
    assert.deepEqual(next.attempts, [], "the independent retest withholds the earlier answer and feedback");
    const finished = await kits.command(kit.id, { action: "submit", round: "retest", revision: next.revision,
      answer: { parts: { part1: JSON.stringify(["山城 · 改签中转", "河口 · 终点下车"]), part2: "改签记录中的换乘地点" } } }, a);
    assert.equal(finished.kit!.stage, "complete");
    assert.deepEqual(finished.kit!.attempts[0], kept.kit!.attempts[0]);
    assert.deepEqual(finished.kit!.attempts.map(attempt => attempt.usedPreview), [true, false]);
    assert.equal(requests.length, 2);
    const follow = await kits.plan({ requestId: randomUUID(), engine: { type: "local", model }, goal,
      followFrom: { kitId: kit.id, version: kit.version, round: "practice", key: "part1" }, consent: true }, a);
    await kits.build(build(follow.id), a);
    for (const request of requests.slice(2)) {
      const material = JSON.parse(request.messages[1]!.content);
      assert.deepEqual(material.previousAction, {
        questionLabel: kit.screen.fields[0]!.label, answer: JSON.stringify(["北站 · 首段到达", "南站 · 次段到达"]),
        usedPreview: true, status: "met", detail: fixed.feedback!.evidence![0]!.detail,
        nextStep: fixed.feedback!.evidence![0]!.nextStep,
      });
      assert.ok(!request.messages[1]!.content.includes(kit.id));
    }
    assert.equal(requests.length, 4);
  } finally {
    kits.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated code exercises freeze typed cases only after the private reference runs successfully", async (t) => {
  const model = "fixture-local", pin = "c".repeat(64);
  const first = (x: number) => ({ mode: "code", followUp: "用负数尝试", extend: "增加零作为边界", inputs: [x, x + 1] });
  const reply = {
    title: "计算平方", codeContract: { task: "给一个整数返回它的平方",
      referenceSource: "return value * value;", workedExample: { input: -2, expected: 4 } },
    practice: { sourceLabel: "坐标距离", first: first(-2), extra: [] },
    transfer: { sourceLabel: "另一组坐标", first: first(3), extra: [] },
  };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/version")) return Response.json({ version: "0.40.16" });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: model, model, digest: pin, size: 10 }] });
    if (url.endsWith("/api/show")) return Response.json({ details: { format: "gguf" },
      model_info: { "general.architecture": "synthetic", "general.parameter_count": 1 } });
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    return Response.json({ done: true, done_reason: "stop", model: model + ":local",
      message: { role: "assistant", content: JSON.stringify(reply) } });
  });
  const design = (signature: NonNullable<TrainingAdvice["codeSignature"]> = { input: "integer", output: "integer" }) => localTrainingAuthor.design({
    id: randomUUID(), goal: "按指定单参合同亲自写函数", evidence: "", modelCalls: 1, origin: "local", model,
    advice: { route: "studio", practiceActions: ["code"], codeSignature: signature,
      observation: "先观察函数输出", nextStep: "试写函数" },
  }, pin, "studio", new AbortController().signal);
  const frozen = validateDesign(await design(), "studio");
  assert.equal(frozen.kind, "studio");
  assert.ok(!JSON.stringify(frozen).includes("return value"));
  const step = frozen.scenes[0]!.steps[0]!;
  assert.equal(step.mode, "code");
  assert.deepEqual(step.cases[0], { input: -2, expected: 4 });
  const transfer = frozen.scenes[1]!.steps[0]!;
  assert.equal(transfer.mode, "code");
  assert.equal(transfer.prompt, step.prompt);
  assert.deepEqual(transfer.cases, [{ input: 3, expected: 9 }, { input: 4, expected: 16 }]);
  reply.codeContract.workedExample.expected = 9;
  await assert.rejects(design(), /reference_mismatch/);
  Object.assign(reply.codeContract.workedExample, { expected: "4" });
  await assert.rejects(design(), /number/);

  Object.assign(reply.codeContract, { task: "返回布尔值的反值", referenceSource: "v => !v",
    workedExample: { input: true, expected: false } });
  Object.assign(reply.practice.first, { inputs: [true] });
  Object.assign(reply.transfer.first, { inputs: [true] });
  const binary = validateDesign(await design({ input: "boolean", output: "boolean" }), "studio");
  assert.equal(binary.kind, "studio");
  const a = binary.scenes[0]!.steps[0]!, b = binary.scenes[1]!.steps[0]!;
  assert(a.mode === "code" && b.mode === "code");
  assert.deepEqual(a.cases, [{ input: true, expected: false }]);
  assert.deepEqual(b.cases, [{ input: false, expected: true }]);
});
