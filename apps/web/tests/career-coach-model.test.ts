import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import type { ChatCompletionResult, LlmConfig } from "@better-me/core";
import type { ResumeEditContext } from "@better-me/agent-contracts";
import { createCoachGenerator, generateCoach, type CoachTransport } from "../src/lib/career-coach/model";
import { coachOutputSchema } from "../src/lib/career-coach/output-schema";
import {
  DEFAULT_COACH_SETTINGS,
  type CoachAnalysis,
  type CoachInterview,
  type CoachInterviewFeedback,
  type CoachPlan,
  type CoachRequest,
  type CoachResume,
  type CoachReview,
} from "../src/lib/career-coach/types";

afterEach(() => mock.restoreAll());

const config: LlmConfig = {
  provider: "openai-compatible", baseUrl: "https://example.invalid/v1", apiKey: "synthetic-model-key", model: "test-coach", temperature: 0.3,
};
const resume: ResumeEditContext = {
  locale: "zh",
  profile: { headline: { targetRef: { kind: "profile_headline", locale: "zh" }, text: "有 React 项目经验" }, skills: ["React"] },
  experiences: [{ id: "exp-1", type: "work", organization: "合成公司", title: "前端开发", claims: [{
    targetRef: { kind: "claim_text", experienceId: "exp-1", claimId: "claim-1", locale: "zh" },
    kind: "action", text: "实现订单列表筛选", tags: ["React"],
  }] }],
};
const analysis: CoachAnalysis = {
  kind: "analysis", summary: "基于本轮材料评估，不代表录用结论。",
  directions: [{ title: "前端开发", reason: "本轮陈述包含 React 经验。", evidence: ["用户陈述的 React 经验"], tradeoffs: ["需要确认期望工作强度。"] }],
  strengths: ["已有界面开发经历。"], gaps: [{ skill: "服务端经验", status: "unknown", reason: "本轮未提供相关依据，不代表不会。" }],
  questions: [{ question: "希望更深耕哪一侧？", why: "用于调整路线。", options: ["前端", "全栈"] }], nextActions: ["核对方向和可用时间。"],
};
const feedback: CoachInterviewFeedback = {
  summary: "回答给出了基本实现思路。", strengths: ["提到了状态划分。"], improvements: ["补充错误处理。"],
  rubric: [{ criterion: "表达清晰度", score: 2, comment: "仅按本次回答文本参考评分。" }],
};
const firstQuestion: CoachInterview = {
  kind: "interview", complete: false,
  question: { text: "请描述你如何实现订单筛选？", focus: "实现思路", evaluationCriteria: ["区分状态与交互。"] }, nextActions: ["请回答本题。"],
};
const review: CoachReview = {
  kind: "review", summary: "提交内容有筛选思路，仍需本人验证。", evidenceAssessment: "ready_for_self_check",
  strengths: ["说明了边界条件。"], improvements: ["增加空结果用例。"], nextActions: ["运行本人测试。"], checkQuestions: ["是否验证空结果？"],
};
const resumeReply: CoachResume = {
  kind: "resume", summary: "候选表达需要本人核对。", proposals: [{
    targetRef: { kind: "claim_text", experienceId: "exp-1", claimId: "claim-1", locale: "zh" },
    originalText: "实现订单列表筛选", proposedText: "为订单列表实现筛选功能", rationale: "明确动作与对象，不增加经历。",
  }],
};

function plan(weeks = 2, hours = 2): CoachPlan {
  return {
    kind: "plan", title: "可检验的 React 练习", goal: "交付筛选页面与测试", durationWeeks: weeks, weeklyHours: hours,
    phases: [{ title: "实现与验证", startWeek: 1, endWeek: weeks, objective: "形成可审阅产物", tasks: Array.from({ length: weeks }, (_, index) => ({
      id: `model-${index + 1}`, title: `第${index + 1}周练习`, week: index + 1, minutes: 60,
      deliverable: "页面代码及测试记录", acceptanceCriteria: ["提交输入输出示例"], resourceQueries: ["React 筛选状态管理"],
    })) }], risks: ["任务超时时缩小实现范围。"], reviewCadence: "每周按产物复盘。",
  };
}

function request(mode: CoachRequest["mode"], extra: Partial<CoachRequest> = {}): CoachRequest {
  return { mode, settings: { ...DEFAULT_COACH_SETTINGS, goal: "找到适合的方向", durationWeeks: 2, weeklyHours: 2 }, input: "请基于本轮资料提供建议。", ...extra };
}

function generator(payload: unknown, finishReason = "stop") {
  return createCoachGenerator(async () => ({ content: JSON.stringify(payload), finishReason }));
}

function interviewRequest(answered: number, total = 2): CoachRequest {
  return request("interview", { interview: {
    totalRounds: total,
    turns: Array.from({ length: answered }, (_, index) => ({ question: `问题${index + 1}`, answer: `回答${index + 1}` })),
  } });
}

test("analysis returns strict typed content and the actual configured model metadata", async () => {
  const result = await generator(analysis)(request("analysis"), config);
  assert.deepEqual(result.payload, analysis);
  assert.equal(result.model.provider, config.provider);
  assert.equal(result.model.name, config.model);
  assert.ok(Number.isFinite(Date.parse(result.model.generatedAt)));
});

test("local Ollama receives a strict per-operation output schema, not only a prose example", async () => {
  let options: Parameters<CoachTransport>[2];
  const generate = createCoachGenerator(async (_config, _messages, supplied) => {
    options = supplied;
    return { content: JSON.stringify(plan()), finishReason: "stop" };
  });
  await generate(request("plan"), { ...config, provider: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "gemma4:e2b-it-qat" });
  assert.equal(options?.responseFormat?.type, "json_schema");
  const schema = JSON.stringify(options?.responseFormat);
  assert.match(schema, /"risks":\{"type":"array","items":\{"type":"string"/);
  assert.match(schema, /"additionalProperties":false/);
  options = undefined;
  await generate(request("plan"), { ...config, provider: "ollama", model: "gemma4:31b-cloud" });
  assert.equal(options?.responseFormat, undefined, "Ollama cloud does not advertise schema support");
});

test("decoder contracts constrain the actual budget and exact interview phase while application validation remains mandatory", async () => {
  const planSchema = coachOutputSchema(request("plan"));
  const properties = planSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.durationWeeks?.const, 2);
  assert.equal(properties.weeklyHours?.const, 2);
  const first = coachOutputSchema(interviewRequest(0));
  const middle = coachOutputSchema(interviewRequest(1));
  const last = coachOutputSchema(interviewRequest(2));
  assert.deepEqual(first.required, ["kind", "complete", "question", "nextActions"]);
  assert.deepEqual(middle.required, ["kind", "complete", "question", "feedback", "nextActions"]);
  assert.deepEqual(last.required, ["kind", "complete", "summary", "feedback", "nextActions"]);
  const overbudget = plan(); overbudget.phases[0]!.tasks.push({ ...overbudget.phases[0]!.tasks[0]!, id: "extra", minutes: 120 });
  await assert.rejects(generator(overbudget)(request("plan"), { ...config, provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "gemma4:e2b-it-qat" }), /超过每周时间预算/);
});

test("prompts contain safety boundaries and only explicitly supplied allow-listed context", async () => {
  const calls: string[] = [];
  const generate = createCoachGenerator(async (_config, messages) => {
    calls.push(JSON.stringify(messages));
    return { content: JSON.stringify(analysis) };
  });
  await generate(request("analysis"), config);
  assert.match(calls[0]!, /未知不等于不会/);
  assert.match(calls[0]!, /没有联网查询或工具执行/);
  assert.match(calls[0]!, /不是能力认证/);
  assert.match(calls[0]!, /不自动修改简历/);
  assert.doesNotMatch(calls[0]!, /synthetic-model-key|合成公司|claim-1/);

  const explicit = JSON.parse(JSON.stringify(resume));
  explicit.profile.email = "unshared-contact@example.invalid";
  explicit.profile.phone = "unshared-phone";
  explicit.privateFacts = "unshared-private-facts";
  await generate(request("analysis", { context: { resume: explicit, job: { title: "显式岗位", description: "显式JD" } } }), config);
  assert.match(calls[1]!, /合成公司|显式JD/);
  assert.doesNotMatch(calls[1]!, /unshared-contact|unshared-phone|unshared-private-facts|synthetic-model-key/);
});

test("unrelated plan, task, submission and interview data are not sent during analysis", async () => {
  let sent = "";
  const generate = createCoachGenerator(async (_config, messages) => {
    sent = JSON.stringify(messages);
    return { content: JSON.stringify(analysis), finishReason: "stop" };
  });
  await generate(request("analysis", {
    task: plan().phases[0]!.tasks[0], submission: { evidence: "UNRELATED_SUBMISSION", minutes: 20 },
    interview: { totalRounds: 2, turns: [{ question: "UNRELATED_QUESTION", answer: "UNRELATED_ANSWER" }] },
  }), config);
  assert.doesNotMatch(sent, /UNRELATED_SUBMISSION|UNRELATED_QUESTION|UNRELATED_ANSWER/);
});

test("analysis and plan receive an explicitly supplied adopted plan without silently replacing it", async () => {
  const adoptedPlan = plan();
  adoptedPlan.title = "用户已采纳的计划";
  for (const mode of ["analysis", "plan"] as const) {
    let sent = "";
    const generate = createCoachGenerator(async (_config, messages) => {
      sent = JSON.stringify(messages);
      return { content: JSON.stringify(mode === "analysis" ? analysis : plan()), finishReason: "stop" };
    });
    await generate(request(mode, { plan: adoptedPlan }), config);
    assert.match(sent, /adoptedPlan/);
    assert.match(sent, /用户已采纳的计划/);
    assert.match(sent, /不宣称已替换/);
  }
  assert.equal(adoptedPlan.title, "用户已采纳的计划");
});

test("caller context is detached before an asynchronous model response", async () => {
  const supplied = structuredClone(resume);
  let release: ((value: ChatCompletionResult) => void) | undefined;
  const generate = createCoachGenerator(async () => new Promise((resolve) => { release = resolve; }));
  const pending = generate(request("resume", { context: { resume: supplied } }), config);
  supplied.experiences[0]!.claims[0]!.text = "changed after request";
  release!({ content: JSON.stringify(resumeReply), finishReason: "stop" });
  const result = await pending;
  assert.equal(result.payload.kind, "resume");
});

test("resume returns only proposals bound to the exact authorized target and original text", async () => {
  const before = JSON.stringify(resume);
  const result = await generator(resumeReply)(request("resume", { context: { resume } }), config);
  assert.deepEqual(result.payload, resumeReply);
  assert.equal(JSON.stringify(resume), before, "generation must never write the resume context");

  const headline: CoachResume = { ...resumeReply, proposals: [{ targetRef: { kind: "profile_headline", locale: "zh" }, originalText: "有 React 项目经验", proposedText: "具备 React 项目经验", rationale: "简洁表达" }] };
  assert.equal((await generator(headline)(request("resume", { context: { resume } }), config)).payload.kind, "resume");
});

test("resume source comparison preserves exact whitespace and supports long authorized originals", async () => {
  const supplied = structuredClone(resume);
  const source = `  ${"合成原文".repeat(1100)}\n`;
  supplied.experiences[0]!.claims[0]!.text = source;
  const payload = structuredClone(resumeReply);
  payload.proposals[0]!.originalText = source;
  const result = await generator(payload)(request("resume", { context: { resume: supplied } }), config);
  assert.equal(result.payload.kind, "resume");
  if (result.payload.kind === "resume") assert.equal(result.payload.proposals[0]!.originalText, source);
});

test("resume needs explicit nonempty context and rejects ambiguous source targets before calling the model", async () => {
  let called = 0;
  const generate = createCoachGenerator(async () => { called += 1; return { content: JSON.stringify(resumeReply) }; });
  await assert.rejects(generate(request("resume"), config), /显式共享/);
  await assert.rejects(generate(request("resume", { context: { resume: { locale: "zh", profile: { skills: [] }, experiences: [] } } }), config), /显式共享/);
  const duplicated = structuredClone(resume);
  duplicated.experiences[0]!.claims.push(structuredClone(duplicated.experiences[0]!.claims[0]!));
  await assert.rejects(generate(request("resume", { context: { resume: duplicated } }), config), /重复/);
  assert.equal(called, 0);
});

test("one forged, mismatched or duplicated resume target rejects the entire proposal batch", async () => {
  const changedTarget = structuredClone(resumeReply);
  const target = changedTarget.proposals[0]!.targetRef;
  assert.equal(target.kind, "claim_text");
  if (target.kind === "claim_text") target.claimId = "not-shared";
  const wrongOriginal = structuredClone(resumeReply);
  wrongOriginal.proposals[0]!.originalText = "模型改写的原文";
  const duplicate = structuredClone(resumeReply);
  duplicate.proposals.push(structuredClone(duplicate.proposals[0]!));
  for (const invalid of [changedTarget, wrongOriginal, duplicate]) {
    await assert.rejects(generator(invalid)(request("resume", { context: { resume } }), config), /拒绝整批提案/);
  }

  const extraTargetField = JSON.parse(JSON.stringify(resumeReply));
  extraTargetField.proposals[0].targetRef.tool = "arbitrary_tool";
  await assert.rejects(generator(extraTargetField)(request("resume", { context: { resume } }), config), /目标字段不符合/);
});

test("plan retains user duration and hours and normalizes task IDs deterministically", async () => {
  const original = plan();
  const result = await generator(original)(request("plan"), config);
  assert.equal(result.payload.kind, "plan");
  if (result.payload.kind !== "plan") return;
  assert.equal(result.payload.durationWeeks, 2);
  assert.equal(result.payload.weeklyHours, 2);
  assert.deepEqual(result.payload.phases.flatMap((phase) => phase.tasks.map((task) => task.id)), ["task-1", "task-2"]);
  assert.equal(original.phases[0]!.tasks[0]!.id, "model-1");
});

test("plan rejects changed settings, weekly overbudget, uncovered weeks and invalid phase ranges", async () => {
  const changedWeeks = plan(); changedWeeks.durationWeeks = 3;
  const changedHours = plan(); changedHours.weeklyHours = 3;
  const overbudget = plan(); overbudget.phases[0]!.tasks[0]!.minutes = 121;
  const missingWeek = plan(); missingWeek.phases[0]!.tasks[1]!.week = 1;
  const badPhase = plan(); badPhase.phases[0]!.endWeek = 3;
  const outsidePhase = plan(); outsidePhase.phases[0]!.tasks[1]!.week = 3;
  const duplicateIds = plan(); duplicateIds.phases[0]!.tasks[1]!.id = duplicateIds.phases[0]!.tasks[0]!.id;
  for (const invalid of [changedWeeks, changedHours, overbudget, missingWeek, badPhase, outsidePhase, duplicateIds]) {
    await assert.rejects(generator(invalid)(request("plan"), config), /拒绝采用/);
  }
});

test("plan sums every task in a week against the user budget", async () => {
  const payload = plan();
  payload.phases[0]!.tasks.push({ ...payload.phases[0]!.tasks[0]!, id: "additional", minutes: 61 });
  await assert.rejects(generator(payload)(request("plan"), config), /第1周超过/);
});

test("plan enforces a total ceiling of 64 tasks across phases", async () => {
  const payload = plan(6, 40);
  payload.phases = Array.from({ length: 6 }, (_, index) => ({
    title: `阶段${index + 1}`, startWeek: index + 1, endWeek: index + 1, objective: "合成目标",
    tasks: Array.from({ length: 11 }, (_, taskIndex) => ({
      ...plan().phases[0]!.tasks[0]!, id: `task-${index}-${taskIndex}`, week: index + 1, minutes: 15,
    })),
  }));
  const input = request("plan", { settings: { ...DEFAULT_COACH_SETTINGS, durationWeeks: 6, weeklyHours: 40 } });
  await assert.rejects(generator(payload)(input, config), /超过64项/);
});

test("review requires a selected task and readable submitted evidence", async () => {
  const selectedPlan = plan();
  const selectedTask = selectedPlan.phases[0]!.tasks[0]!;
  const input = request("review", { plan: selectedPlan, task: selectedTask, submission: { evidence: "实现状态过滤，并附输入输出示例。", minutes: 45 } });
  assert.deepEqual((await generator(review)(input, config)).payload, review);
  await assert.rejects(generator(review)(request("review", { submission: input.submission }), config), /选择一个学习任务/);
  await assert.rejects(generator(review)(request("review", { task: selectedTask }), config), /提交可阅读/);
  await assert.rejects(generator(review)(request("review", { task: selectedTask, submission: { evidence: "   ", minutes: 30 } }), config), /输入不完整/);
  await assert.rejects(generator(review)({ ...input, task: { ...selectedTask, title: "旧任务" } }, config), /与当前计划不一致/);
});

test("interview starts with one question and no score, then supplies feedback plus the next question", async () => {
  assert.deepEqual((await generator(firstQuestion)(interviewRequest(0), config)).payload, firstQuestion);
  const next = { ...firstQuestion, feedback };
  assert.deepEqual((await generator(next)(interviewRequest(1), config)).payload, next);
  const final: CoachInterview = { kind: "interview", complete: true, feedback, summary: "两轮已结束，仅是回答文本反馈。", nextActions: ["按反馈补充案例。"] };
  assert.deepEqual((await generator(final)(interviewRequest(2), config)).payload, final);
});

test("interview does not publish the copied scoring placeholder observed in a real small-model reply", async () => {
  const copied = { ...firstQuestion, feedback: { ...feedback, rubric: [{ criterion: "幂等性处理", score: 0, comment: "0至4分的文本依据与局限" }] } };
  await assert.rejects(generator(copied)(interviewRequest(1), config), /评分占位/);
});

test("interview prompt describes grading without a numeric example and excludes prior model feedback", async () => {
  let prompt = "";
  const generate = createCoachGenerator(async (_config, messages) => {
    prompt = JSON.stringify(messages);
    return { content: JSON.stringify({ ...firstQuestion, feedback }), finishReason: "stop" };
  });
  const supplied = interviewRequest(1);
  supplied.interview!.turns[0]!.feedback = { ...feedback, summary: "PREVIOUS_MODEL_OPINION" };
  await generate(supplied, config);
  assert.doesNotMatch(prompt, /0至4分的文本依据与局限|PREVIOUS_MODEL_OPINION/);
  assert.match(prompt, /不能把示例或占位/);
});

test("interview rejects premature scoring, missing feedback, wrong completion and extra final questions", async () => {
  await assert.rejects(generator({ ...firstQuestion, feedback })(interviewRequest(0), config), /尚未收到回答/);
  await assert.rejects(generator(firstQuestion)(interviewRequest(1), config), /未反馈/);
  await assert.rejects(generator({ kind: "interview", complete: true, feedback, summary: "提前结束", nextActions: [] })(interviewRequest(1), config), /轮次不正确/);
  await assert.rejects(generator({ ...firstQuestion, feedback, complete: true, summary: "已结束" })(interviewRequest(2), config), /不再追问/);
  await assert.rejects(generator({ kind: "interview", complete: true, feedback, nextActions: [] })(interviewRequest(2), config), /不再追问/);
  const blank = interviewRequest(1); blank.interview!.turns[0]!.answer = "  ";
  await assert.rejects(generator(firstQuestion)(blank, config), /先回答当前面试问题/);
  await assert.rejects(generator(firstQuestion)(interviewRequest(3), config), /超过本次设定轮次/);
});

test("JSON fences are accepted but malformed, extra fields, wrong operations and truncated outputs are not", async () => {
  const fenced = createCoachGenerator(async () => ({ content: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\``, finishReason: "stop" }));
  assert.deepEqual((await fenced(request("analysis"), config)).payload, analysis);
  for (const content of ["", "null", "{\"kind\":\"analysis\"", `说明\n${JSON.stringify(analysis)}`]) {
    await assert.rejects(createCoachGenerator(async () => ({ content }))(request("analysis"), config), /未生成|未采用/);
  }
  await assert.rejects(generator({ ...analysis, toolCommand: "untrusted" })(request("analysis"), config), /结构不符合/);
  await assert.rejects(generator(review)(request("analysis"), config), /另一种操作/);
  for (const reason of ["length", "max_tokens", "content_filter", "error", "tool_calls"]) {
    await assert.rejects(generator(analysis, reason)(request("analysis"), config), /截断、过滤或未正常结束/);
  }
});

test("missing model configuration is actionable and Ollama accepts an empty API key", async () => {
  let calls = 0;
  const transport: CoachTransport = async () => { calls += 1; return { content: JSON.stringify(analysis), finishReason: "stop" }; };
  const generate = createCoachGenerator(transport);
  for (const invalid of [{ ...config, apiKey: "" }, { ...config, model: " " }, { ...config, baseUrl: "" }, { ...config, baseUrl: "ftp://example.invalid" }]) {
    await assert.rejects(generate(request("analysis"), invalid), /打开现有模型配置/);
  }
  assert.equal(calls, 0);
  await generate(request("analysis"), { ...config, provider: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" });
  assert.equal(calls, 1);
});

test("pre-cancelled and in-flight requests reject promptly even if an injected transport ignores cancellation", async () => {
  let calls = 0;
  let receivedSignal: AbortSignal | undefined;
  let release: ((result: ChatCompletionResult) => void) | undefined;
  const generate = createCoachGenerator(async (_config, _messages, options) => {
    calls += 1; receivedSignal = options?.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(generate(request("analysis"), config, cancelled.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = generate(request("analysis"), config, controller.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await rejection;
  release!({ content: JSON.stringify(analysis), finishReason: "stop" });
});

test("a late cancellation cannot publish a valid model result", async () => {
  const controller = new AbortController();
  const generate = createCoachGenerator(async () => {
    controller.abort();
    return { content: JSON.stringify(analysis), finishReason: "stop" };
  });
  await assert.rejects(generate(request("analysis"), config, controller.signal), { name: "AbortError" });
});

test("the production transport uses the existing model endpoint and forwards cancellation to fetch", async () => {
  let fetchSignal: AbortSignal | null | undefined;
  let endpoint = "";
  mock.method(globalThis, "fetch", async (input, init) => {
    endpoint = String(input); fetchSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      fetchSignal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = generateCoach(request("analysis"), config, controller.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  assert.equal(endpoint, "https://example.invalid/v1/chat/completions");
  assert.ok(fetchSignal);
  controller.abort();
  assert.equal(fetchSignal.aborted, true, "external signal must reach the existing core request's fetch controller");
  await rejection;
});

test("provider errors are not converted into a fabricated success payload", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "synthetic provider failure" } }, { status: 503 }));
  await assert.rejects(generateCoach(request("analysis"), config), /503/);
});
