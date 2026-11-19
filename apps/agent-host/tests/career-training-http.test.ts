import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { careerJobSnapshotVersion, careerTrainingRequirements, TrainingPlan, TrainingView } from "@better-me/agent-contracts";
import { CoachStateSchema, DEFAULT_COACH_SETTINGS, type CoachPlan, type CoachState } from "@better-me/agent-contracts/career-coach";
import { createAgentServer } from "../src/server.js";
import { TrainingKits } from "../src/growth/training-kits.js";
import { concurrencyExample } from "../src/growth/training-concurrency.js";
import type { TrainingAuthor } from "../src/growth/training-model.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("closing a training recommendation request signals the running command", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "betterme-training-disconnect-"));
  const token = "synthetic-training-disconnect";
  const started = Promise.withResolvers<AbortSignal | undefined>();
  const finished = Promise.withResolvers<boolean>();
  t.mock.method(TrainingKits.prototype, "command", async (_id: string, _command: unknown, access: Parameters<TrainingKits["command"]>[2]) => {
    const signal: AbortSignal | undefined = access.signal;
    started.resolve(signal);
    if (signal && !signal.aborted) await once(signal, "abort", { signal: AbortSignal.timeout(5000) });
    finished.resolve(signal?.aborted ?? false);
    return {};
  });
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(dir, "identity"), runsDirectory: path.join(dir, "runs"),
    understandingDirectory: path.join(dir, "understanding"), checkpointer: new MemorySaver() as never });
  const stop = new AbortController();
  try {
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const account = await registerTestIdentity(origin, token, "transfer-disconnect");
    const pending = fetch(`${origin}/api/v1/agent/growth/learning/training/${randomUUID()}/commands`, {
      method: "POST", headers: { ...account.headers, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "recommend-transfer", revision: 5, consent: true, requestId: randomUUID() }), signal: stop.signal,
    });
    assert.ok(await started.promise);
    const interrupted = assert.rejects(pending, { name: "AbortError" });
    stop.abort();
    await interrupted;
    assert.equal(await finished.promise, true);
  } finally {
    stop.abort();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});

test("an owner-selected JD requirement survives sandbox practice, plan replacement, restart and independent retest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-career-training-"));
  const token = "synthetic-career-training";
  const workspaceKey = "synthetic-resume";
  const at = new Date().toISOString();
  const job = { id: "job-fixture", title: ".NET 后端工程师", company: "合成企业",
    description: "任职要求：\n具备 EF Core 并发更新及数据一致性处理经验\n熟悉接口开发" };
  const requirement = careerTrainingRequirements(job)[0]!;
  assert.equal(requirement.originalQuote, "具备 EF Core 并发更新及数据一致性处理经验");
  const competency = "处理并发令牌冲突与库存扣减";
  const plan: CoachPlan = {
    kind: "plan", title: "第一版学习方案", goal: "提升后端数据一致性能力", weeklyHours: 2, durationWeeks: 1, risks: [],
    reviewCadence: "隔天复测", phases: [{ title: "并发更新", startWeek: 1, endWeek: 1, objective: competency,
      tasks: [{ id: "task-1", title: "并发冲突练习", week: 1, minutes: 30, deliverable: "两次模拟作答",
        acceptanceCriteria: ["重新读取并根据实际余量决定是否扣减"], resourceQueries: [] }] }],
  };
  const goal = { id: "goal-1", recordId: "analysis-1", confirmedAt: at, goal: plan.goal, summary: "本人确认聚焦后端", fingerprint: "goal-fixture", contextFingerprint: "context-fixture" };
  const model = { provider: "example", name: "fixture", generatedAt: at };
  const basis = { resumeShared: false, jobShared: true, contextFingerprint: goal.contextFingerprint, goalFingerprint: goal.fingerprint, goalId: goal.id };
  const target = { id: randomUUID(), goalId: goal.id, planId: "plan-1", taskId: "task-1", job, itemId: requirement.id,
    quote: requirement.originalQuote, competency, criterionIndex: 0, createdAt: at };
  const invalid = { ...target, id: randomUUID(), quote: "不存在的岗位原句" };
  const initial: CoachState = CoachStateSchema.parse({
    schemaVersion: 1, workspaceKey, revision: 1, updatedAt: at, settings: { ...DEFAULT_COACH_SETTINGS, goal: goal.goal },
    records: [
      { id: goal.recordId, createdAt: at, mode: "analysis", input: goal.goal, model, basis,
        payload: { kind: "analysis", summary: goal.summary, directions: [{ title: "后端", reason: "本人目标", evidence: [], tradeoffs: [] }], strengths: [], gaps: [{ skill: competency, status: "needs_practice", reason: "本人选择练习" }], questions: [], nextActions: [] } },
      { id: target.planId, createdAt: at, mode: "plan", input: goal.goal, model, basis, payload: plan },
    ],
    goalConfirmations: [goal], activePlan: { id: target.planId, plan, startDate: "2026-11-19", progress: {} }, submissions: [],
    trainingTargets: [target, invalid],
  });
  let now = Date.now();
  const calls = { diagnose: 0, design: 0, program: 0 };
  const author: TrainingAuthor = {
    pin: async () => "a".repeat(64),
    diagnose: async (_model, _pin, requested, _difficulty, _signal, career) => {
      calls.diagnose++;
      assert.equal(requested, competency);
      assert.equal(career?.requirement.quote, target.quote);
      assert.equal(career?.criterion, plan.phases[0]!.tasks[0]!.acceptanceCriteria[0]);
      assert.equal(career?.requirement.snapshotVersion, careerJobSnapshotVersion(job));
      return { route: "concurrency", observation: "需练习旧版本重新校验", nextStep: "先预测，再复测" };
    },
    design: async (draft, _pin, kind) => {
      calls.design++;
      assert.equal(kind, "concurrency");
      assert.equal(draft.career?.targetId, target.id);
      return { ...concurrencyExample, title: "合成并发训练工作台" };
    },
    program: async () => {
      calls.program++;
      return "input => input.first + input.second <= input.initial ? input.initial - input.first - input.second : input.initial - input.first";
    },
  };
  const opts = {
    host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never,
    learningClock: () => now, learningTrainingAuthor: author,
  };
  let host = createAgentServer(opts);
  async function origin() {
    await once(host, "listening");
    const address = host.address();
    assert.ok(address && typeof address !== "string");
    return "http://127.0.0.1:" + address.port;
  }
  async function stop() {
    if (host.listening) await new Promise<void>(resolve => host.close(() => resolve()));
  }
  try {
    let base = await origin();
    const account = await registerTestIdentity(base, token, "career-training-owner");
    const other = await registerTestIdentity(base, token, "career-training-other");
    const request = (headers: Record<string, string>, route: string, body?: object) =>
      fetch(base + "/api/v1/agent/" + route, { method: body ? "POST" : "GET",
        headers: { ...headers, Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    const call = (route: string, body?: object, headers = account.headers) => request(headers, "growth/learning/training" + route, body);
    async function save(state: CoachState) {
      const res = await request(account.headers, "records/growth?key=" + workspaceKey, { expectedRevision: state.revision - 1, value: state });
      assert.equal(res.status, 200, await res.clone().text());
    }
    async function getKit(id: string) {
      const res = await call("/" + id);
      assert.equal(res.status, 200, await res.clone().text());
      return TrainingView.parse((await res.json()).kit);
    }
    const input = (targetId = target.id, requestedGoal = competency) => ({ requestId: randomUUID(), goal: requestedGoal, evidence: "合成难点", consent: true,
      careerTarget: { workspaceKey, targetId }, engine: { type: "local", model: "fixture-local" } });
    const buildInput = (planId: string) => ({ planId, requestId: randomUUID(), consent: true });
    await save(initial);
    assert.equal((await call("/plan", input(), other.headers)).status, 409);
    assert.equal((await call("/plan", input(invalid.id))).status, 409);
    assert.equal((await call("/plan", input(target.id, "其他目标"))).status, 409);
    assert.equal(calls.diagnose, 0);
    const response = await call("/plan", input());
    assert.equal(response.status, 201, await response.clone().text());
    const draft = TrainingPlan.parse((await response.json()).plan);
    const built = await call("/build", buildInput(draft.id));
    assert.equal(built.status, 201, await built.clone().text());
    const kit = TrainingView.parse((await built.json()).kit);
    assert.equal(kit.career?.planId, target.planId);
    assert.equal(kit.modelCalls, 3);
    assert.equal(kit.verifiedCases, 7);
    const firstAnswer = { parts: { part1: "并发冲突，重新读取", part2: "余量不足，拒绝第二次扣减", part3: "4" } };
    const attempt = (action: "explore" | "submit", revision: number, round: "practice" | "retest", answer: object) =>
      call("/" + kit.id + "/commands", { action, revision, round, answer });
    assert.equal((await attempt("explore", kit.revision, "practice", firstAnswer)).status, 200);
    const afterFirst = await attempt("submit", kit.revision + 1, "practice", firstAnswer);
    assert.equal(afterFirst.status, 200, await afterFirst.clone().text());
    const first = TrainingView.parse((await afterFirst.json()).kit);
    assert.equal(first.attempts[0]?.usedPreview, true);
    assert.equal(first.attempts[0]?.feedback.met, true);
    assert.equal(first.attempts[0]?.questionVersion, kit.questionVersion);
    assert.equal(first.stage, "waiting");
    assert.equal((await call("/" + kit.id + "/commands", { action: "keep", revision: first.revision })).status, 200);
    const secondDraft = TrainingPlan.parse((await (await call("/plan", input())).json()).plan);
    const replacement = { ...plan, title: "同名任务的新计划" };
    await save(CoachStateSchema.parse({ ...initial, revision: 2,
      records: [...initial.records, { id: "plan-2", createdAt: at, mode: "plan", input: goal.goal, model, basis, payload: replacement }],
      activePlan: { ...initial.activePlan, id: "plan-2", plan: replacement }, planHistory: [initial.activePlan] }));
    assert.equal((await call("/build", buildInput(secondDraft.id))).status, 409);
    assert.deepEqual(calls, { diagnose: 2, design: 1, program: 1 });
    await stop();
    host = createAgentServer(opts);
    base = await origin();
    const login = await request({}, "identity/sign-in", { username: account.principal.username, password: "synthetic-only-password-2026" });
    assert.equal(login.status, 200, await login.clone().text());
    account.headers.Cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal((await getKit(kit.id)).stage, "waiting");
    now += 24 * 60 * 60 * 1000 + 1;
    const transfer = await getKit(kit.id);
    assert.equal(transfer.stage, "retest");
    assert.notEqual(transfer.questionVersion, kit.questionVersion);
    assert.deepEqual(transfer.attempts, first.attempts);
    assert.equal((await attempt("submit", transfer.revision, "practice", firstAnswer)).status, 409);
    const secondAnswer = { parts: { part1: "并发冲突，重新读取", part2: "重新核对后提交", part3: "7" } };
    const submitted = await attempt("submit", transfer.revision, "retest", secondAnswer);
    assert.equal(submitted.status, 200, await submitted.clone().text());
    const completed = await getKit(kit.id);
    assert.equal(completed.stage, "complete");
    assert.equal(completed.attempts[1]?.feedback.met, true);
    assert.equal(completed.attempts[1]?.usedPreview, false);
    assert.deepEqual(completed.attempts[0], first.attempts[0]);
    assert.equal(completed.career?.planId, "plan-1");
    assert.equal(completed.career?.requirement.quote, requirement.originalQuote);
    const list = await (await call("")).json();
    assert.equal(list.kits[0].career.planId, "plan-1");
    assert.deepEqual(calls, { diagnose: 2, design: 1, program: 1 });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
