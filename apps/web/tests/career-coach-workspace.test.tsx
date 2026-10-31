import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LlmConfig } from "@better-me/core";
import type { ResumeEditContext } from "@better-me/agent-contracts";
import type { CoachGeneration, CoachGenerate, CoachPayload, CoachRequest, CoachState } from "../src/lib/career-coach/types";
import { createMemoryCoachRepository, type CoachRepository } from "../src/lib/career-coach/storage";
import { addCoachRecord, adoptCoachPlan, contextFingerprint, createCoachRecord, createCoachState } from "../src/lib/career-coach/state";

registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "https://career-coach-ui-fixture.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom) })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw new Error("UI fixtures must not issue external requests"); };
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { CareerCoachWorkspace } = await import("../src/components/CareerCoachWorkspace");
const fixtureKey = "synthetic-coach-ui";
const config: LlmConfig = { provider: "ollama", baseUrl: "https://synthetic-model.invalid/v1", model: "fixture-only", apiKey: "" };
const resume: ResumeEditContext = { locale: "zh", profile: { skills: ["TypeScript"], headline: {
  text: "负责内部工具的前端维护。", targetRef: { kind: "profile_headline", locale: "zh" },
} }, experiences: [] };
const job = { title: "合成岗位", company: "合成企业", description: "合成 JD：需要可靠的 TypeScript 工程实践。" };
const model = { provider: "fixture", name: "synthetic-model", generatedAt: "2026-10-29T08:00:00.000Z" };
function payload(mode: CoachRequest["mode"]): CoachPayload {
  if (mode === "analysis") return { kind: "analysis", summary: "合成方向分析结果", directions: [{ title: "全栈协作", reason: "基于用户提供的目标", evidence: ["目标说明"], tradeoffs: ["优先验证基础"] }],
    strengths: ["已有前端背景"], gaps: [{ skill: "接口设计", status: "unknown", reason: "资料尚未提供证据" }],
    questions: [{ question: "你希望先练习哪项能力？", why: "便于调整任务", options: ["接口设计", "质量验证"] }], nextActions: ["选择实践方向"] };
  if (mode === "plan") return { kind: "plan", title: "两周可验证练习", goal: "形成可复查产物", durationWeeks: 2, weeklyHours: 2,
    phases: [{ title: "实践阶段", startWeek: 1, endWeek: 2, objective: "完成实现与说明", tasks: [
      { id: "task-1", title: "实现表单校验", week: 1, minutes: 60, deliverable: "一段实现和测试", acceptanceCriteria: ["正常与失败路径可复现"], resourceQueries: ["TypeScript 官方文档"] },
      { id: "task-2", title: "解释方案取舍", week: 2, minutes: 45, deliverable: "设计说明", acceptanceCriteria: ["写清约束"], resourceQueries: [] },
    ] }], risks: ["控制范围"], reviewCadence: "每周自查" };
  if (mode === "resume") return { kind: "resume", summary: "仅润色已有原文", proposals: [{ targetRef: resume.profile.headline!.targetRef,
    originalText: resume.profile.headline!.text, proposedText: "承担内部工具的前端维护工作。", rationale: "使表达更直接" }] };
  if (mode === "review") return { kind: "review", summary: "证据复盘结果", evidenceAssessment: "needs_revision", strengths: ["有实际说明"],
    improvements: ["补充失败场景"], nextActions: ["增加一项异常测试"], checkQuestions: ["结果能否复现？"] };
  return { kind: "interview", complete: false, question: { text: "如何避免表单重复提交？", focus: "状态与异常", evaluationCriteria: ["解释状态变化"] }, nextActions: [] };
}
function generated(mode: CoachRequest["mode"]): CoachGeneration { return { payload: payload(mode), model }; }
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await nextTurn(); await nextTurn(); await nextTurn(); });
}
function body() { return dom.document.getElementById("fixture")!; }
function buttons(pattern: RegExp) { return Array.from(body().querySelectorAll("button")).filter(node => pattern.test(node.textContent?.trim() ?? node.getAttribute("aria-label") ?? "")); }
function button(pattern: RegExp) { const found = buttons(pattern)[0]; assert.ok(found, `Missing button ${pattern}; UI: ${body().textContent}`); return found; }
async function click(pattern: RegExp) { await flush(() => button(pattern).click()); }
function action(id: string, fallback: RegExp) {
  return body().querySelector<HTMLButtonElement>(`[data-testid="${id}"]`) ?? button(fallback);
}
async function invoke(id: string, fallback: RegExp) { await flush(() => action(id, fallback).click()); }
function labelledField(pattern: RegExp): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const fields = Array.from(body().querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"));
  const found = fields.find(field => pattern.test([field.getAttribute("aria-label"), field.getAttribute("placeholder"),
    field.closest("label")?.textContent, ...Array.from(body().querySelectorAll("label")).filter(label => label.htmlFor && label.htmlFor === field.id).map(label => label.textContent)].filter(Boolean).join(" ")));
  assert.ok(found, `Missing field ${pattern}; UI: ${body().textContent}`); return found;
}
async function fill(pattern: RegExp, value: string) {
  const field = labelledField(pattern);
  await flush(() => {
    const prototype = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : field.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new dom.Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function share(pattern: RegExp) {
  const field = labelledField(pattern); assert.equal(field.type, "checkbox"); await flush(() => field.click());
}
async function seed(repository: CoachRepository, transform: (state: CoachState) => CoachState) {
  const state = transform(createCoachState(fixtureKey));
  await repository.save({ ...state, revision: 1 }, 0);
}
function withPlan(state: CoachState, adopted = false) {
  const record = createCoachRecord(generated("plan"), { mode: "plan", settings: state.settings, input: "合成方案" });
  const next = addCoachRecord(state, record);
  return adopted ? adoptCoachPlan(next, record.id, "2026-10-01") : next;
}
async function configuredRepository(transform: (state: CoachState) => CoachState = state => state) {
  const repository = createMemoryCoachRepository();
  await seed(repository, state => transform({ ...state, settings: { ...state.settings, goal: "强化可验证的全栈协作能力", durationWeeks: 2, weeklyHours: 2, interviewRounds: 2 } }));
  return repository;
}
type Props = React.ComponentProps<typeof CareerCoachWorkspace>;
async function mount(overrides: Partial<Props> = {}) {
  const repository = overrides.repository ?? createMemoryCoachRepository();
  const props: Props = { workspaceKey: fixtureKey, job, resumeEditContext: resume, llmConfig: config, onOpenConfig: () => {},
    generate: async request => generated(request.mode), repository, ...overrides };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(body());
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(CareerCoachWorkspace, props))));
  return { repository, props };
}
test.afterEach(async () => { if (root) await flush(() => root?.unmount()); root = undefined; });
test.after(() => { assert.equal(externalRequests, 0, "the UI suite must never access external services"); });

test("career coach exposes five modes with resume/JD sharing off and no automatic model request", async () => {
  const requests: CoachRequest[] = [];
  await mount({ generate: async request => { requests.push(request); return generated(request.mode); } });
  for (const name of ["规划分析", "修改建议", "学习方案", "学习监督", "模拟面试"]) assert.ok(button(new RegExp(name)));
  assert.equal((labelledField(/简历.*(共享|字段)|共享.*简历/) as HTMLInputElement).checked, false);
  assert.equal((labelledField(/共享当前目标岗位/) as HTMLInputElement).checked, false);
  assert.equal(requests.length, 0);
  assert.ok(body().textContent?.includes("备份"));
});

test("analysis sends only expressly selected context and records real model provenance", async () => {
  const requests: CoachRequest[] = [];
  const repository = await configuredRepository();
  await mount({ repository, generate: async request => { requests.push(structuredClone(request)); return generated(request.mode); } });
  await invoke("coach-generate", /生成.*分析|开始.*分析|分析.*方向/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.context?.resume, undefined);
  assert.equal(requests[0]?.context?.job, undefined);
  assert.ok(body().textContent?.includes("合成方向分析结果"));
  assert.ok(body().textContent?.includes("资料尚未提供证据"), "unknown evidence must remain visible");
  await share(/简历.*(共享|字段)|共享.*简历/);
  await share(/共享当前目标岗位/);
  await invoke("coach-generate", /生成.*分析|开始.*分析|重新.*分析|分析.*方向/);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.context?.resume, resume);
  assert.equal(requests[1]?.context?.job?.description, job.description);
  const saved = await repository.load(fixtureKey);
  assert.equal(saved?.records.length, 2);
  assert.equal(saved?.records[1]?.model.name, "synthetic-model");
  assert.equal(saved?.records[1]?.basis.resumeShared, true);
  assert.equal(saved?.records[1]?.basis.jobShared, true);
});

test("double clicks start one request and switching mode ignores its late response", async () => {
  const repository = await configuredRepository();
  let count = 0;
  let signal: AbortSignal | undefined;
  let resolve: ((value: CoachGeneration) => void) | undefined;
  const generate: CoachGenerate = async (_request, _config, abortSignal) => {
    count++; signal = abortSignal;
    return new Promise<CoachGeneration>(done => { resolve = done; });
  };
  await mount({ repository, generate });
  await flush(() => {
    const start = action("coach-generate", /生成.*分析|开始.*分析|分析.*方向/);
    start.click(); start.click();
  });
  assert.equal(count, 1);
  await click(/学习方案/);
  assert.equal(signal?.aborted, true);
  await flush(() => resolve?.(generated("analysis")));
  assert.equal((await repository.load(fixtureKey))?.records.length, 0, "a cancelled result cannot mutate records");
  assert.ok(!body().textContent?.includes("合成方向分析结果"));
});

test("revoking resume sharing aborts pending generation and blocks late saved proposals", async () => {
  const repository = await configuredRepository();
  let resolve: ((value: CoachGeneration) => void) | undefined;
  let signal: AbortSignal | undefined;
  await mount({ repository, generate: async (_request, _config, abortSignal) => {
    signal = abortSignal; return new Promise<CoachGeneration>(done => { resolve = done; });
  } });
  await share(/简历.*(共享|字段)|共享.*简历/);
  await click(/修改建议/);
  await invoke("coach-generate", /生成.*建议|生成.*修改|开始.*修改/);
  await share(/简历.*(共享|字段)|共享.*简历/);
  assert.equal(signal?.aborted, true);
  await flush(() => resolve?.(generated("resume")));
  assert.equal((await repository.load(fixtureKey))?.records.length, 0);
});

test("a generated learning plan remains a preview until explicit adoption", async () => {
  const repository = await configuredRepository(state => withPlan(state));
  await mount({ repository });
  await click(/学习方案/);
  assert.ok(body().textContent?.includes("两周可验证练习"));
  assert.equal((await repository.load(fixtureKey))?.activePlan, undefined);
  await invoke("coach-adopt-plan", /采纳.*方案|采纳.*计划|开始跟踪/);
  const saved = await repository.load(fixtureKey);
  assert.equal(saved?.activePlan?.plan.title, "两周可验证练习");
  assert.equal(saved?.activePlan?.progress["task-1"]?.status, "todo");
  await click(/学习监督/);
  assert.ok(body().textContent?.includes("实现表单校验"));
  assert.match(body().textContent ?? "", /自评|自我.*完成|本人.*完成/);
});

test("review failure preserves a saved evidence submission and does not claim verification", async () => {
  const repository = await configuredRepository(state => withPlan(state, true));
  const requests: CoachRequest[] = [];
  await mount({ repository, generate: async request => { requests.push(request); throw new Error("合成模型暂时不可用，请重试"); } });
  await click(/学习监督/);
  await fill(/证据|实际.*产出|完成情况/, "我完成了输入校验和失败路径测试，结果已记录在本地说明中。");
  await fill(/本次投入分钟/, "42");
  await invoke("coach-save-evidence", /保存学习提交/);
  let saved = await repository.load(fixtureKey);
  assert.equal(saved?.submissions.length, 1);
  assert.equal(saved?.submissions[0]?.minutes, 42);
  assert.ok(saved?.submissions[0]?.evidence.includes("失败路径测试"));
  assert.equal(requests.length, 0, "saving evidence must not silently invoke a model");
  await invoke("coach-review-evidence", /请求.*反馈|生成.*反馈|获取.*反馈|请求.*复盘/);
  saved = await repository.load(fixtureKey);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.submission?.evidence.includes("失败路径测试"));
  assert.equal(saved?.submissions.length, 1);
  assert.equal(saved?.submissions[0]?.feedbackRecordId, undefined);
  assert.ok(body().textContent?.includes("合成模型暂时不可用"));
  assert.match(body().textContent ?? "", /自评|不.*认证|不代表.*认证/);
});

test("interview saves the actual answer before feedback and retries without duplicate turns", async () => {
  const repository = await configuredRepository();
  const requests: CoachRequest[] = [];
  let failNextAnswer = true;
  await mount({ repository, generate: async request => {
    requests.push(structuredClone(request));
    const count = request.interview?.turns.length ?? 0;
    if (count === 1 && failNextAnswer) { failNextAnswer = false; throw new Error("合成反馈失败，回答已保留"); }
    if (count === 0) return generated("interview");
    return { model, payload: { kind: "interview", complete: count >= 2,
      ...(count < 2 ? { question: { text: "如果服务端返回错误，你会怎样处理？", focus: "错误处理", evaluationCriteria: ["解释恢复路径"] } } : { summary: "两轮实际回答的合成总结" }),
      feedback: { summary: "基于实际回答的反馈", strengths: ["有明确顺序"], improvements: ["补充异常路径"], rubric: [{ criterion: "表达", score: 2, comment: "练习参考，不是能力认证" }] }, nextActions: ["继续练习错误处理"] } };
  } });
  await click(/模拟面试/);
  await invoke("coach-interview-start", /开始.*面试|开始.*模拟/);
  assert.ok(body().textContent?.includes("如何避免表单重复提交？"));
  await fill(/你的回答|本轮回答|回答内容|面试回答/, "我会使用提交中状态禁用重复操作，并在结束后释放状态。");
  await invoke("coach-interview-answer", /提交.*回答|提交.*答案|回答.*反馈/);
  let saved = await repository.load(fixtureKey);
  assert.equal(saved?.interview?.turns.length, 1);
  assert.equal(saved?.interview?.turns[0]?.answer, "我会使用提交中状态禁用重复操作，并在结束后释放状态。");
  assert.ok(body().textContent?.includes("合成反馈失败"));
  await invoke("coach-interview-retry", /重试本轮生成/);
  saved = await repository.load(fixtureKey);
  assert.equal(saved?.interview?.turns.length, 1, "retry must not append the submitted answer a second time");
  assert.deepEqual(requests.map(request => request.interview?.turns.length), [0, 1, 1]);
  assert.ok(body().textContent?.includes("如果服务端返回错误，你会怎样处理？"));
  await fill(/你的回答|本轮回答|回答内容|面试回答/, "我会保留输入并显示可操作错误，确保用户可以安全重试。");
  await invoke("coach-interview-answer", /提交.*回答|提交.*答案|回答.*反馈/);
  saved = await repository.load(fixtureKey);
  assert.equal(saved?.interview?.turns.length, 2);
  assert.equal(saved?.interview?.status, "completed");
  assert.ok(body().textContent?.includes("两轮实际回答的合成总结"));
});

test("re-generating the previous interview feedback preserves answers and cannot discard a draft answer", async () => {
  const repository = await configuredRepository(state => ({ ...state, interview: {
    id: "synthetic-interview-retry", status: "active", totalRounds: 2, contextFingerprint: contextFingerprint({}),
    turns: [{ question: "请说明状态机", answer: "合成回答：采用联合类型和允许表。" }],
    question: { text: "下一道合成问题", focus: "异常处理", evaluationCriteria: ["说明错误边界"] },
  } }));
  let calls = 0;
  await mount({ repository, generate: async request => {
    calls++;
    assert.equal(request.interview?.turns.length, 1);
    return { model, payload: { kind: "interview", complete: false, question: { text: "重新生成的下一题", focus: "幂等", evaluationCriteria: ["说明重复行为"] },
      feedback: { summary: "重新评估原回答", strengths: ["原回答提到了联合类型"], improvements: [], rubric: [{ criterion: "类型建模", score: 3, comment: "原回答给出了联合类型和允许表，但未列举运行时输入校验。" }] }, nextActions: [] } };
  } });
  await click(/模拟面试/);
  await fill(/你的面试回答|自己的经历/, "尚未提交的回答草稿");
  assert.equal(button(/重新生成上一题反馈与本题/).disabled, true);
  await fill(/你的面试回答|自己的经历/, "");
  await click(/重新生成上一题反馈与本题/);
  const saved = await repository.load(fixtureKey);
  assert.equal(calls, 1);
  assert.equal(saved?.interview?.turns.length, 1);
  assert.equal(saved?.interview?.turns[0]?.answer, "合成回答：采用联合类型和允许表。");
  assert.equal(saved?.interview?.turns[0]?.feedback?.summary, "重新评估原回答");
  assert.equal(saved?.interview?.question?.text, "重新生成的下一题");
});

test("resume proposals require present consent and explicit per-proposal approval", async () => {
  const repository = await configuredRepository();
  const approved: Array<Parameters<NonNullable<Props["onApplyResumeProposal"]>>[0]> = [];
  await mount({ repository, onApplyResumeProposal: async proposal => { approved.push(proposal); return { ok: true, message: "合成写回回执已确认" }; } });
  await click(/修改建议/);
  await share(/简历.*(共享|字段)|共享.*简历/);
  await invoke("coach-generate", /生成.*建议|生成.*修改|开始.*修改/);
  assert.equal(approved.length, 0, "model output must not write the resume by itself");
  assert.ok(body().textContent?.includes(resume.profile.headline!.text));
  assert.ok(body().textContent?.includes("承担内部工具的前端维护工作。"));
  await share(/简历.*(共享|字段)|共享.*简历/);
  const revoked = buttons(/核对并应用此条/);
  assert.ok(revoked.length === 0 || revoked.every(item => item.disabled), "revoked consent must prevent approving an old record");
  await share(/简历.*(共享|字段)|共享.*简历/);
  await click(/核对并应用此条/);
  assert.equal(approved.length, 1);
  const first = approved[0]!;
  assert.deepEqual({ targetRef: first.targetRef, originalText: first.originalText, proposedText: first.proposedText },
    { targetRef: resume.profile.headline!.targetRef, originalText: resume.profile.headline!.text, proposedText: "承担内部工具的前端维护工作。" });
  assert.ok(body().textContent?.includes("合成写回回执已确认"));
});

test("resume proposal whose original text does not match the shared field cannot be applied", async () => {
  const repository = await configuredRepository();
  let writes = 0;
  await mount({ repository, generate: async request => {
    const result = generated(request.mode);
    if (result.payload.kind === "resume") result.payload.proposals[0]!.originalText = "模型返回了错误原文";
    return result;
  }, onApplyResumeProposal: async () => { writes++; return { ok: true }; } });
  await click(/修改建议/);
  await share(/简历.*(共享|字段)|共享.*简历/);
  await invoke("coach-generate", /生成.*建议|生成.*修改|开始.*修改/);
  await click(/核对并应用此条/);
  assert.equal(writes, 0);
  assert.ok(body().textContent?.includes("本次授权或简历原文已变化"));
});

test("unmount aborts a pending model request without saving its eventual result", async () => {
  const repository = await configuredRepository();
  let resolve: ((value: CoachGeneration) => void) | undefined;
  let signal: AbortSignal | undefined;
  await mount({ repository, generate: async (_request, _config, abortSignal) => {
    signal = abortSignal; return new Promise<CoachGeneration>(done => { resolve = done; });
  } });
  await invoke("coach-generate", /生成.*分析|开始.*分析|分析.*方向/);
  await flush(() => root?.unmount()); root = undefined;
  assert.equal(signal?.aborted, true);
  await flush(() => resolve?.(generated("analysis")));
  assert.equal((await repository.load(fixtureKey))?.records.length, 0);
});

test("a local save failure remains visible while the generated result is retained in this page", async () => {
  const initial = createCoachState(fixtureKey);
  initial.settings.goal = "完成一个可核验的小练习";
  const repository: CoachRepository = {
    async load() { return initial; },
    async save() { throw new Error("合成存储空间不足：内容未保存，请下载备份"); },
    async clear() { throw new Error("未允许清除测试记录"); },
  };
  await mount({ repository });
  await invoke("coach-generate", /生成.*分析|开始.*分析|分析.*方向/);
  assert.ok(body().textContent?.includes("合成方向分析结果"));
  assert.ok(body().textContent?.includes("内容未保存"));
  assert.ok(button(/下载.*备份|导出.*备份/));
});

test("missing model configuration opens settings rather than starting a request", async () => {
  const repository = await configuredRepository();
  let opened = 0;
  const beforeRequests = externalRequests;
  await mount({ repository, llmConfig: { provider: "openai-compatible", baseUrl: "https://synthetic-model.invalid/v1", model: "fixture-only", apiKey: "" },
    onOpenConfig: () => { opened++; }, generate: undefined });
  const start = body().querySelector<HTMLButtonElement>('[data-testid="coach-generate"]') ?? buttons(/生成.*分析|开始.*分析|分析.*方向/)[0];
  if (start) await flush(() => start.click());
  assert.equal(externalRequests, beforeRequests);
  assert.match(body().textContent ?? "", /模型配置.*API Key/);
  await click(/^模型配置$/);
  assert.equal(opened, 1);
});

test("a successful first resume proposal permits the second proposal in the same reviewed batch", async () => {
  const repository = await configuredRepository();
  const context: ResumeEditContext = { ...structuredClone(resume), experiences: [{ id: "exp-1", type: "work", organization: "合成企业", title: "工程师", claims: [{
    targetRef: { kind: "claim_text", experienceId: "exp-1", claimId: "claim-1", locale: "zh" },
    text: "维护内部页面的表单校验。", kind: "action", tags: [],
  }] }] };
  const changes = [
    { targetRef: context.profile.headline!.targetRef, originalText: context.profile.headline!.text, proposedText: "承担内部工具的前端维护工作。", rationale: "明确已有职责" },
    { targetRef: context.experiences[0]!.claims[0]!.targetRef, originalText: "维护内部页面的表单校验。", proposedText: "负责内部页面表单校验的维护。", rationale: "调整已有表述" },
  ];
  const approved: string[] = [];
  const { props } = await mount({ repository });
  function Harness() {
    const [current, setCurrent] = React.useState(context);
    return h(CareerCoachWorkspace, { ...props, resumeEditContext: current,
      generate: async () => ({ model, payload: { kind: "resume", summary: "两条各自绑定原文的建议", proposals: changes } }),
      onApplyResumeProposal: async proposal => {
        const next = structuredClone(current);
        if (proposal.targetRef.kind === "profile_headline") {
          assert.equal(next.profile.headline!.text, proposal.originalText);
          next.profile.headline!.text = proposal.proposedText;
        } else {
          const target = next.experiences[0]!.claims[0]!;
          assert.equal(target.text, proposal.originalText);
          target.text = proposal.proposedText;
        }
        approved.push(proposal.proposedText); setCurrent(next);
        return { ok: true, message: "合成宿主已保存并重绘上下文" };
      },
    });
  }
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(Harness))));
  await click(/修改建议/);
  await share(/共享当前简历字段/);
  await click(/生成修改建议/);
  assert.equal(buttons(/核对并应用此条/).length, 2);
  await click(/核对并应用此条/);
  assert.equal(approved.length, 1);
  await click(/核对并应用此条/);
  assert.deepEqual(approved, changes.map(proposal => proposal.proposedText));
  assert.equal(buttons(/核对并应用此条/).length, 0);
  assert.ok(!body().textContent?.includes("本次授权或简历原文已变化"));
});

test("an unrelated external context edit invalidates an otherwise matching resume proposal", async () => {
  const repository = await configuredRepository();
  let writes = 0;
  const { props } = await mount({ repository, onApplyResumeProposal: async () => { writes++; return { ok: true }; } });
  await click(/修改建议/);
  await share(/共享当前简历字段/);
  await click(/生成修改建议/);
  const changedContext = structuredClone(resume);
  changedContext.profile.skills.push("外部窗口刚刚修改的技能");
  assert.equal(changedContext.profile.headline!.text, resume.profile.headline!.text, "the target source itself is unchanged");
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } },
    h(CareerCoachWorkspace, { ...props, resumeEditContext: changedContext }))));
  await click(/核对并应用此条/);
  assert.equal(writes, 0);
  assert.ok(body().textContent?.includes("本次授权或简历原文已变化"));
});
