import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
  },
});
const dom = new Window({ url: "http://training-kit-panel-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { activatePrincipal } = await import("../src/lib/identity.ts");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { defaultLearningClient } = await import("../src/services/learning-client.ts");
const { TrainingKitPanel } = await import("../src/components/TrainingKitPanel.tsx");
const { SavedTrainingEvidence } = await import("../src/components/StudioExercise.tsx");

let root: ReturnType<typeof createRoot> | undefined;
const ownerId = "11111111-1111-4111-8111-111111111111";

test("career review distinguishes open work and preserves its exact answer and follow-up origin", async () => {
  const original = "  Explain the delay.\n  ";
  const data = {
    kind: "studio", attempts: [{
      round: "practice", at: new Date().toISOString(), usedPreview: false, answer: { parts: { part1: original } },
      question: { instruction: "请用英文回复", brief: "客户追问", notes: [], fields: [{ control: "write", key: "part1", label: "更新进度" }] },
      feedback: { met: true, detail: "回答已收录", evidence: [{ key: "part1", status: "recorded", detail: "已保存原文", nextStep: "给出下一次更新时间" }] },
    }],
    followFrom: { kitId: ownerId, version: "a".repeat(64), round: "practice", key: "part1", questionVersion: "b".repeat(64),
      kitTitle: "前次练习", questionLabel: "说清故障情况", answer: original, usedPreview: true, status: "recorded", detail: "原文已保存", nextStep: "换一个读者" },
  };
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(SavedTrainingEvidence, { text: JSON.stringify(data) }))));
  assert.match(host.querySelector(".training-observations")!.textContent!, /已记录表达/);
  assert.doesNotMatch(host.querySelector(".training-observations")!.textContent!, /符合本项规则/);
  assert.equal(host.querySelector(".training-origin pre")!.textContent, original);
});

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

function button(label: string) {
  return [...dom.document.querySelectorAll("button")].find(node => node.textContent?.includes(label));
}

afterEach(async () => {
  if (root) await flush(() => root!.unmount());
  root = undefined;
  activatePrincipal(undefined);
  dom.document.body.replaceChildren();
});

after(() => {
  css.deregister();
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("TrainingKitPanel explains audited Ollama versions, locks spent plan after failed build, and clarifies waiting-stage preview scope", async t => {
  activatePrincipal({ id: ownerId, username: "training-ui", displayName: "Training UI" });
  t.mock.method(defaultLearningClient.training, "list", async () => []);

  let planCalls = 0;
  let buildCalls = 0;
  t.mock.method(defaultLearningClient.training, "plan", async () => {
    planCalls++;
    if (planCalls === 1) throw new Error("training_local_diagnosis_failed");
    if (planCalls === 2) {
      return {
        id: "22222222-2222-4222-8222-222222222222",
        goal: "把英文工作邮件写简短",
        evidence: "缩短时总漏请求和截止日。",
        origin: "local" as const,
        model: "gemma4:e2b-it-qat",
        modelCalls: 1,
        advice: {
          route: "rewrite" as const,
          observation: "需要在精简时保留请求和日期。",
          nextStep: "通过两道题目强化核对。",
        },
      };
    }
    return {
      id: "33333333-3333-4333-8333-333333333333",
      goal: "学会估算并行任务交付时间",
      evidence: "并行任务常被直接相加。",
      origin: "example" as const,
      modelCalls: 0,
      advice: {
        route: "dependency" as const,
        observation: "示例假设",
        nextStep: "先试着推演一次。",
      },
    };
  });

  t.mock.method(defaultLearningClient.training, "build", async () => {
    buildCalls++;
    if (buildCalls === 1) throw new Error("training_program_rejected");
    return {
      id: "44444444-4444-4444-8444-444444444444",
      ownerId,
      title: "交付推演台",
      goal: "学会估算并行任务交付时间",
      focus: "并行任务常被直接相加。",
      kind: "dependency" as const,
      version: "abcdef1234567890",
      origin: "example" as const,
      modelCalls: 0,
      verifiedCases: 6,
      saved: false,
      revision: 1,
      stage: "waiting" as const,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      attempts: [],
      screen: {
        brief: "并行任务推演",
        instruction: "请估算项目天数。",
        notes: ["A · 设计：4 天"],
        fields: [
          { control: "range" as const, key: "delay", label: "延迟几天", min: 0, max: 10, initial: 2 },
          { control: "number" as const, key: "prediction", label: "预测天数", min: 1, max: 150, initial: 6 },
        ],
      },
    };
  });

  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel))));

  const goalInput = dom.document.querySelector("input") as HTMLInputElement;
  const evidenceArea = dom.document.querySelector("textarea") as HTMLTextAreaElement;
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(goalInput, "把英文工作邮件写简短");
    goalInput.dispatchEvent(new dom.Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(evidenceArea, "缩短时总漏请求和截止日。");
    evidenceArea.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });

  await flush(() => button("同意并分析难点")!.click());
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /0\.40\.15 \/ 0\.40\.16/);

  await flush(() => button("同意并分析难点")!.click());
  const buildBtn = button("认可方向，构建试用版");
  assert.ok(buildBtn);
  await flush(() => buildBtn.click());
  assert.equal(buildCalls, 1);
  assert.equal(button("认可方向，构建试用版")!.disabled, true);
  assert.match(dom.document.body.textContent!, /本次构建建议已用完/);

  await flush(() => button("调整目标或判断依据")!.click());
  await flush(() => button("项目排期推演")!.click());
  await flush(() => button("试用示例工具")!.click());
  assert.match(dom.document.body.textContent!, /试算反馈仅演练首轮题目/);
});

test("a goal alone opens an authored studio, collects the learner's own actions and explicitly continues one observed step", async t => {
  activatePrincipal({ id: ownerId, username: "studio-ui", displayName: "Studio UI" });
  const client = defaultLearningClient.training;
  const id = "55555555-5555-4555-8555-555555555555", version = "c".repeat(64);
  const goal = "预测巡演舞台换景时的交接顺序";
  const screen = {
    brief: "换景排练", instruction: "根据当天的舞监清单做交接。", notes: ["遮幕先于换景"],
    fields: [
      { control: "order" as const, key: "part1" as const, label: "安排交接", options: ["换景", "遮幕"] },
      { control: "quantity" as const, key: "part2" as const, label: "推算净时长" },
      { control: "code" as const, key: "part3" as const, label: "写出时长换算函数" },
      { control: "write" as const, key: "part4" as const, label: "说明理由" },
    ],
  };
  let kit: import("@better-me/agent-contracts").TrainingView = {
    id, ownerId, title: "舞台交接推演", goal, focus: "初次尝试", kind: "studio", version, origin: "local",
    model: "local-test", modelCalls: 2, verifiedCases: 6, saved: false, revision: 0, stage: "practice", attempts: [], screen,
  };
  const feedback = { met: false, detail: "已核对顺序、时长与函数，记录了理由。", evidence: [
    { key: "part1" as const, status: "met" as const, detail: "先遮幕再换景", nextStep: "增加灯光岗位再安排" },
    { key: "part2" as const, status: "missed" as const, detail: "少算了等待时间", nextStep: "单独推演等待时间" },
    { key: "part3" as const, status: "met" as const, detail: "换算用例通过", nextStep: "添加另一组检查" },
    { key: "part4" as const, status: "recorded" as const, detail: "已记下你的解释", nextStep: "从舞监的角度重新表述" },
  ] };
  const plans: import("@better-me/agent-contracts").TrainingStart[] = [];
  t.mock.method(client, "list", async () => []);
  t.mock.method(client, "plan", async (input: import("@better-me/agent-contracts").TrainingStart) => {
    plans.push(input);
    return { id, goal, evidence: input.evidence, origin: "local", modelCalls: 1,
      advice: { route: "studio", observation: "先尝试一次交接", nextStep: "根据清单作答" } };
  });
  t.mock.method(client, "build", async () => kit);
  const commands: import("@better-me/agent-contracts").TrainingCommand[] = [];
  t.mock.method(client, "command", async (_id: string, command: import("@better-me/agent-contracts").TrainingCommand) => {
    commands.push(command);
    if (command.action === "submit") {
      kit = { ...kit, revision: 1, stage: "waiting", dueAt: new Date(Date.now() + 86400000).toISOString(), attempts: [{
        round: "practice", at: new Date().toISOString(), question: screen, questionVersion: version,
        usedPreview: false, answer: command.answer, feedback,
      }] };
      return { kit, feedback };
    }
    assert.equal(command.action, "keep");
    kit = { ...kit, revision: 2, saved: true };
    return { kit };
  });
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel))));
  async function fill(selector: string, value: string) {
    const element = dom.document.querySelector(selector)!;
    const proto = element.tagName === "INPUT" ? dom.HTMLInputElement.prototype : dom.HTMLTextAreaElement.prototype;
    await flush(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
  }
  await fill("input", goal);
  assert.equal(button("同意并分析难点")!.disabled, false);
  assert.equal(dom.document.querySelector(".training-demos")?.hasAttribute("open"), false);
  await flush(() => button("同意并分析难点")!.click());
  assert.equal(plans[0]?.goal, goal);
  assert.equal(plans[0]?.evidence, "");
  await flush(() => button("认可方向，构建试用版")!.click());
  await fill('input[type="number"]', "6");
  const source = " input => input * 2 ";
  await fill("textarea.training-code", source);
  await fill("textarea:not(.training-code)", "先让舞台清空");
  await flush(() => button("提交本次作答")!.click());
  assert.equal(commands.length, 0, "default order is never submitted on the learner's behalf");
  await flush(() => dom.document.querySelector<HTMLButtonElement>('button[aria-label="上移 遮幕"]')!.click());
  await flush(() => button("提交本次作答")!.click());
  assert.deepEqual(commands[0], { action: "submit", revision: 0, round: "practice", answer: {
    parts: { part1: JSON.stringify(["遮幕", "换景"]), part2: "6", part3: source, part4: "先让舞台清空" }, codeKey: "part3" } });
  assert.match(dom.document.querySelector('[aria-label="逐项反馈"]')!.textContent!, /已记录表达/);
  assert.match(dom.document.body.textContent!, /遮幕 → 换景/);
  assert.equal(button("按这条建议继续练"), undefined, "the original attempt is kept before starting another one");
  await flush(() => button("保留此版本")!.click());
  const next = [...dom.document.querySelectorAll('[aria-label="逐项反馈"] li')].find(node => node.textContent.includes("单独推演等待时间"))!;
  await flush(() => next.querySelector("button")!.click());
  assert.equal(plans.length, 1, "choosing the recommendation only prepares a new request");
  const original = dom.document.querySelector(".training-origin")!;
  assert.match(original.textContent, /推算净时长/);
  assert.equal(original.querySelector("pre")!.textContent, "6");
  assert.match(original.textContent, /少算了等待时间/);
  assert.match(original.textContent, /单独推演等待时间/);
  assert.doesNotMatch(original.textContent, /先让舞台清空/);
  const carried = "我尤其想练两段换景间的等待";
  await fill("textarea", carried);
  await flush(() => button("同意并分析难点")!.click());
  assert.deepEqual(plans[1]?.followFrom, { kitId: id, version, round: "practice", key: "part2" });
  assert.equal(plans[1]?.evidence, carried);
  await flush(() => button("调整目标或判断依据")!.click());
  await flush(() => button("移除作答引用")!.click());
  assert.equal(dom.document.querySelector("textarea")!.value, carried);
  assert.equal(dom.document.querySelector(".training-origin"), null);
});

test("reviewing suggested practice actions is optional, reversible and only sends an edit with build consent", async t => {
  activatePrincipal({ id: ownerId, username: "studio-actions", displayName: "Studio actions" });
  const client = defaultLearningClient.training;
  const plans: string[] = [], builds: (string[] | undefined)[] = [];
  t.mock.method(client, "list", async () => []);
  t.mock.method(client, "plan", async (input: import("@better-me/agent-contracts").TrainingStart) => {
    const id = crypto.randomUUID(); plans.push(id);
    return { id, goal: input.goal, evidence: "", origin: "local", modelCalls: 1, advice: {
      route: "studio", observation: "先试着分析车次变更", nextStep: "安排一次换乘", practiceActions: ["order", "write"],
    } };
  });
  t.mock.method(client, "build", async (id: string, _request: string, _signal?: AbortSignal, actions?: string[]) => {
    assert.equal(id, plans.at(-1));
    builds.push(actions);
    throw Error("training_design_invalid");
  });
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel))));
  const goal = dom.document.querySelector("input")!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(goal, "处理多线路换乘");
    goal.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await flush(() => button("同意并分析难点")!.click());
  let picker = dom.document.querySelector(".training-action-picker")!;
  assert.equal(picker.hasAttribute("open"), false);
  await flush(() => picker.querySelector("summary")!.click());
  assert.match(picker.textContent, /Agent 建议 · 调整顺序 → 用自己的话作答/);
  async function select(slot: number, value: string) {
    const field = picker.querySelectorAll("select")[slot]!;
    await flush(() => { field.value = value; field.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  }
  await select(0, "code");
  assert.equal(plans.length, 1);
  assert.equal(builds.length, 0);
  await flush(() => button("恢复 Agent 建议")!.click());
  await flush(() => button("认可方向，构建试用版")!.click());
  assert.deepEqual(builds, [undefined]);
  await flush(() => button("调整目标或判断依据")!.click());
  await flush(() => button("同意并分析难点")!.click());
  picker = dom.document.querySelector(".training-action-picker")!;
  await flush(() => picker.querySelector("summary")!.click());
  await select(0, "code");
  await select(1, "quantity");
  assert.equal(plans.length, 2);
  assert.equal(builds.length, 1);
  await flush(() => button("认可方向，构建试用版")!.click());
  assert.deepEqual(builds, [undefined, ["code", "quantity"]]);
  assert.equal(plans.length, 2);
});

test("a submitted open response has explicit scoped review, one learner rewrite, and separately consented follow-up", async t => {
  activatePrincipal({ id: ownerId, username: "open-writing", displayName: "Open writing" });
  const client = defaultLearningClient.training;
  const version = "c".repeat(64), questionVersion = "d".repeat(64), modelDigest = "e".repeat(64);
  const original = "  我们需要调整。\n", revised = "  我建议周三延后发布，周二先核实数据。\n";
  const peerAnswer = "另一项的私有草稿";
  const screen = { brief: "项目延期", instruction: "私有指令", notes: ["确认发布时间", "未选条目的提示"], fields: [
    { control: "write" as const, key: "part1" as const, label: "向负责人说明" },
    { control: "write" as const, key: "part2" as const, label: "提交另一种做法" },
  ] };
  const attempt: import("@better-me/agent-contracts").TrainingAttempt = {
    round: "practice", at: new Date().toISOString(), answer: { parts: {part1: original, part2: peerAnswer} },
    feedback: { met: true, detail: "已收录作答", evidence: screen.fields.map(f => ({
      key: f.key, status: "recorded", detail: "原文已收录", nextStep: "换一个场景",
    })) }, usedPreview: false, question: screen, questionVersion,
  };
  let kit: import("@better-me/agent-contracts").TrainingView = {
    id: ownerId, ownerId, version, title: "练习交接", goal: "简明解释项目变更", kind: "studio", origin: "local",
    model: "local-test", modelDigest, modelCalls: 2, verifiedCases: 4, focus: "写清楚判断", saved: true, revision: 2,
    stage: "waiting", dueAt: new Date(Date.now() + 86400000).toISOString(), screen, questionVersion, attempts: [attempt],
  };
  const review = { key: "part1" as const, questionVersion, quote: "需要调整", comment: "读者还缺少变更时间。",
    revisionPrompt: "写明时间和下一步行动。", model: "local-test", modelDigest, createdAt: attempt.at };
  const commands: import("@better-me/agent-contracts").TrainingCommand[] = [];
  const plans: import("@better-me/agent-contracts").TrainingStart[] = [];
  let failSave = true;
  t.mock.method(client, "list", async () => [kit]);
  t.mock.method(client, "get", async () => kit);
  t.mock.method(client, "command", async (_id: string, cmd: import("@better-me/agent-contracts").TrainingCommand) => {
    commands.push(cmd);
    if (cmd.action === "review-writing") kit = { ...kit, revision: 3, attempts: [{...attempt, writingReviews: [review]}] };
    else if (cmd.action === "save-rewrite") {
      if (failSave) { failSave = false; throw new Error("fetch failed"); }
      kit = { ...kit, revision: 4, attempts: [{ ...attempt, writingReviews: [{ ...review, rewrite: { answer: cmd.answer, at: attempt.at } }] }] };
    } else assert.fail("unexpected workshop command");
    return { kit };
  });
  t.mock.method(client, "plan", async (input: import("@better-me/agent-contracts").TrainingStart) => {
    plans.push(input);
    return { id: ownerId, goal: kit.goal, origin: "local", modelCalls: 1, evidence: "", advice: { observation: "下一步", nextStep: "继续练", route: "studio" } };
  });
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel))));
  await flush(() => button(kit.title)!.click());
  const consents = host.querySelectorAll(".training-writing-consent");
  assert.equal(consents.length, 2, "one consent per submitted open response, with no duplicate in history");
  await flush(() => consents[0]!.querySelector("summary")!.click());
  assert.equal(commands.length, 0);
  const shared = [...consents[0]!.querySelectorAll("dd")].map(x => x.textContent);
  assert.deepEqual(shared, [kit.goal, "项目延期\n确认发布时间", "向负责人说明", original]);
  assert.doesNotMatch(consents[0]!.textContent, /私有|未选条目的提示/);
  await flush(() => consents[0]!.querySelector("button")!.click());
  const request = commands[0];
  assert.ok(request?.action === "review-writing");
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request, {action: "review-writing", revision: 2, round: "practice", key: "part1", questionVersion, consent: true, requestId: request.requestId});
  assert.equal(host.querySelector(".training-writing blockquote")!.textContent, review.quote);
  assert.equal(host.querySelector(".training-writing-versions dd")!.textContent, original);
  assert.equal(button("保存我的改写")!.disabled, true);
  const draft = host.querySelector(".training-writing textarea")!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(draft, revised);
    draft.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await flush(() => button("保存我的改写")!.click());
  assert.equal(host.querySelector<HTMLTextAreaElement>(".training-writing textarea")!.value, revised);
  await flush(() => button("保存我的改写")!.click());
  assert.deepEqual(commands.at(-1), { action: "save-rewrite", revision: 3, round: "practice", key: "part1", questionVersion, answer: revised });
  assert.equal(button("保存我的改写"), undefined);
  await flush(() => button("返回工坊")!.click());
  await flush(() => button(kit.title)!.click());
  assert.equal(commands.length, 3, "opening the saved response replays neither review nor revision");
  assert.deepEqual([...host.querySelectorAll(".training-writing-versions dd")].map(el => el.textContent), [original, revised]);
  assert.ok(button("用提交的原答继续练"), "the original source remains available and is clearly labelled");
  await flush(() => button("用这次改写继续练")!.click());
  assert.equal(plans.length, 0);
  assert.match(host.querySelector(".training-origin")!.textContent, /参考模型点评后改写/);
  assert.match(host.querySelector(".training-origin")!.textContent, /写明时间和下一步行动/);
  assert.equal(host.querySelector(".training-origin pre")!.textContent, revised);
  await flush(() => button("同意并分析难点")!.click());
  assert.deepEqual(plans[0]?.followFrom, {kitId: ownerId, version, round: "practice", key: "part1", useRewrite: true});
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(SavedTrainingEvidence, {text: JSON.stringify({kind: "studio", attempts: kit.attempts})}))));
  assert.deepEqual([...host.querySelectorAll(".training-writing-versions dd")].map(el => el.textContent), [original, revised]);
  assert.equal(host.querySelector("button, textarea"), null, "frozen career evidence is read-only");
});

test("working on a past written step preserves an in-progress retest and rejects a late review on account switch", async t => {
  const person = {id: ownerId, username: "writing-retake", displayName: "Writing retake"};
  const client = defaultLearningClient.training;
  activatePrincipal(person);
  const questionVersion = "d".repeat(64), firstQuestion = {brief: "初次材料", instruction: "初次练习", notes: [],
    fields: [{key: "part1" as const, control: "write" as const, label: "解释初次判断"}] };
  const attempt: import("@better-me/agent-contracts").TrainingAttempt = {
    round: "practice", at: new Date().toISOString(), answer: {parts: {part1: "原账号的回答"}},
    feedback: {met: true, detail: "已收录", evidence: [{key: "part1", status: "recorded", detail: "已收录", nextStep: "说明依据"}]},
    usedPreview: false, questionVersion, question: firstQuestion,
  };
  const kit: import("@better-me/agent-contracts").TrainingView = {
    id: ownerId, ownerId, version: "a".repeat(64), title: "已保留的两轮练习", goal: "说清判断", kind: "studio", origin: "local",
    model: "review-local", modelDigest: "b".repeat(64), modelCalls: 2, verifiedCases: 3, focus: "给出依据", saved: true,
    revision: 2, stage: "retest", questionVersion: "e".repeat(64), attempts: [attempt],
    screen: {...firstQuestion, brief: "复测材料", fields: [{...firstQuestion.fields[0]!, label: "复测题目"}]},
  };
  let list = [kit];
  t.mock.method(client, "list", async () => list);
  t.mock.method(client, "get", async () => kit);
  let requests = 0;
  let complete!: () => void;
  let lastSignal!: AbortSignal;
  t.mock.method(client, "command", async (_: string, cmd: import("@better-me/agent-contracts").TrainingCommand, signal: AbortSignal) => {
    if (cmd.action === "view-practice") return {kit: {...kit, retestAids: { preview: false, practiceReference: true }}};
    assert.equal(cmd.action, "review-writing");
    requests++;
    lastSignal = signal;
    await new Promise<void>(resolve => {complete = resolve;});
    return {kit: {...kit, revision: 3, attempts: [{...attempt, writingReviews: [{
      key: "part1", questionVersion, comment: "原账号的点评", quote: "回答", revisionPrompt: "给出一个依据",
      model: kit.model, modelDigest: kit.modelDigest, createdAt: attempt.at,
    }]}]}};
  });
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  const render = () => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel)));
  await flush(render);
  await flush(() => button(kit.title)!.click());
  const draft = () => host.querySelector<HTMLTextAreaElement>(".training-form textarea")!;
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), "尚未提交的复测判断");
    draft().dispatchEvent(new dom.Event("input", {bubbles: true}));
  });
  assert.equal(button("同意用本机模型点评"), undefined);
  assert.doesNotMatch(host.textContent, /原账号的回答/);
  await flush(() => button("查看首练作答（记录使用参考）")!.click());
  await flush(() => button("同意用本机模型点评")!.click());
  assert.equal(requests, 1);
  assert.ok(button("同意用本机模型点评")!.disabled);
  await flush(complete);
  assert.equal(draft().value, "尚未提交的复测判断");
  await flush(() => button("返回工坊")!.click());
  await flush(() => button(kit.title)!.click());
  assert.equal(button("同意用本机模型点评"), undefined);
  assert.doesNotMatch(host.textContent, /原账号的回答/);
  await flush(() => button("查看首练作答（记录使用参考）")!.click());
  await flush(() => button("同意用本机模型点评")!.click());
  const nextUser = {...person, id: "22222222-2222-4222-8222-222222222222", username: "second"};
  list = [];
  await flush(() => { activatePrincipal(nextUser); render(); });
  assert.ok(lastSignal.aborted);
  await flush(complete);
  assert.equal(requests, 2, "a new owner never replays pending model work");
  assert.doesNotMatch(host.textContent, /原账号的回答|原账号的点评|已保留的两轮练习|尚未提交的复测判断/);
});

test("completed retest shows a goal-bound evidence trail, remembers the decision, and builds the recommended child only on adoption", async t => {
  const { trainingTransferInput } = await import("@better-me/agent-contracts");
  type Kit = import("@better-me/agent-contracts").TrainingView;
  const client = defaultLearningClient.training;
  const model = "synthetic-review", modelDigest = "d".repeat(64), evidenceVersion = "e".repeat(64);
  const question = (brief: string, label: string) => ({
    brief, instruction: "用自己的话说明", notes: [brief + "已记录"], fields: [{key: "part1" as const, control: "write" as const, label}],
  });
  const attempt = (round: "practice" | "retest", answer: string): Kit["attempts"][number] => ({
    round, at: round === "practice" ? "2026-03-15T08:00:00Z" : "2026-03-16T08:00:00Z",
    questionVersion: (round === "practice" ? "b" : "c").repeat(64),
    question: round === "practice" ? question("首次题面", "第一次的约束") : question("新环境", "复测的约束"),
    answer: { parts: {part1: answer} }, usedPreview: false,
    feedback: {met: true, detail: "已收录", evidence: [{key: "part1", status: "recorded", detail: "已收录原答", nextStep: "指出边界"}]},
  });
  const first = attempt("practice", "我会承诺立刻完成。");
  const retest = {...attempt("retest", "另一个项目还须核对授权。"), aids: { preview: false, practiceReference: false }};
  const rewrite = "我会先核实团队排期。";
  first.writingReviews = [{ key: "part1", questionVersion: first.questionVersion!, createdAt: first.at, model, modelDigest,
    quote: "立刻完成", comment: "需要确认排期。", revisionPrompt: "说明时间安排的条件。",
    rewrite: {answer: rewrite, at: "2026-03-15T09:00:00Z"} }];
  let kit: Kit = { id: ownerId, ownerId, version: "a".repeat(64), title: "项目更新", goal: "表达承诺的前提", kind: "studio",
    origin: "local", model, modelDigest, modelCalls: 2, verifiedCases: 2, focus: "承诺", saved: true, revision: 6,
    stage: "complete", attempts: [first, retest], screen: retest.question!, questionVersion: retest.questionVersion };
  const decision: NonNullable<Kit["transferDecision"]> = { model, modelDigest, evidenceVersion, createdAt: retest.at,
    actions: ["write"], direction: "extend", nextGoal: "给两个读者说明不同的承诺前提。",
    reasons: [{evidenceId: "practice.part1", reason: "原答直接承诺。"}, {evidenceId: "rewrite.part1", reason: "改写中引用了团队排期。"},
      {evidenceId: "retest.part1", reason: "换情境后主动提到授权。"}] };
  const source: NonNullable<Kit["transferFrom"]> = {kitId: kit.id, kitTitle: kit.title, version: kit.version, evidenceVersion,
    direction: decision.direction, actions: decision.actions, nextGoal: decision.nextGoal, reasons: decision.reasons,
    citations: trainingTransferInput(kit.goal, kit.attempts)!.evidence,
    practiceVersion: first.questionVersion!, retestVersion: retest.questionVersion!, retestIndependence: "independent", retestAids: retest.aids};
  const calls: string[] = [];
  activatePrincipal({id: ownerId, username: "transfer", displayName: "Transfer"});
  t.mock.method(client, "list", async () => [kit]);
  t.mock.method(client, "get", async () => kit);
  t.mock.method(client, "command", async (_id: string, cmd: import("@better-me/agent-contracts").TrainingCommand) => {
    assert.equal(cmd.action, "recommend-transfer");
    assert.deepEqual(cmd, {action: "recommend-transfer", revision: 6, consent: true, requestId: cmd.requestId});
    calls.push(cmd.action);
    kit = {...kit, revision: 7, transferDecision: decision};
    return {kit};
  });
  t.mock.method(client, "plan", async (req: import("@better-me/agent-contracts").TrainingStart) => {
    calls.push("plan");
    assert.deepEqual(req.transferFrom, {kitId: kit.id, version: kit.version, evidenceVersion});
    assert.equal(req.goal, kit.goal);
    assert.equal(req.followFrom, undefined);
    return {id: ownerId, goal: kit.goal, evidence: "", model, origin: "local", modelCalls: 0,
      transferFrom: source, advice: {route: "studio", observation: decision.nextGoal, nextStep: "开始验证", practiceActions: ["write"]}};
  });
  t.mock.method(client, "build", async () => {
    calls.push("build");
    return {...kit, id: "22222222-2222-4222-8222-222222222222", title: "给不同读者的任务",
      transferFrom: source, transferDecision: undefined, stage: "practice", saved: false, attempts: []};
  });
  const host = dom.document.createElement("main");
  dom.document.body.append(host);
  root = createRoot(host as unknown as Element);
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingKitPanel))));
  await flush(() => button(kit.title)!.click());
  const observation = host.querySelector(".training-transfer-input")!;
  assert.match(observation.textContent, /首答.*我会承诺立刻完成/);
  assert.match(observation.textContent, /复测前改写.*我会先核实团队排期/);
  assert.match(observation.textContent, /换情境复测.*独立复测.*另一个项目还须核对授权/);
  assert.deepEqual(calls, []);
  await flush(() => button("请 Agent 建议下一步")!.click());
  assert.deepEqual(calls, ["recommend-transfer"]);
  await flush(() => button("返回工坊")!.click());
  await flush(() => button(kit.title)!.click());
  assert.equal(button("请 Agent 建议下一步"), undefined);
  assert.equal(host.querySelectorAll(".training-transfer-reasons li").length, 3);
  assert.deepEqual(calls, ["recommend-transfer"]);
  await flush(() => button("按建议开始下一练")!.click());
  assert.deepEqual(calls, ["recommend-transfer","plan","build"]);
  assert.match(host.textContent, /给不同读者的任务/);
  assert.match(host.querySelector(".training-origin")!.textContent, /本次练习的推荐依据.*复测前改写/);
  assert.equal(host.querySelector(".training-origin blockquote")!.textContent, "我会承诺立刻完成。");
  await flush(() => root!.render(h(UiPreferencesProvider, null, h(SavedTrainingEvidence, {
    text: JSON.stringify({ kind: "studio", goal: kit.goal, attempts: kit.attempts, transferDecision: decision }),
  }))));
  assert.match(host.textContent, /为什么这样练.*复测前改写/);
  assert.equal(button("按建议开始下一练"), undefined);
  assert.equal(button("请 Agent 建议下一步"), undefined);

  const { TrainingTransferPanel } = await import("../src/components/TrainingTransferPanel");
  async function checkRetest(attempts: Kit["attempts"]) {
    await flush(() => root!.render(h(UiPreferencesProvider, null, h(TrainingTransferPanel, {
      kit: {...kit, transferDecision: undefined, attempts}, historical: false, disabled: false,
      onRecommend() { assert.fail("recommendation requires a click"); }, onAdopt() { assert.fail("adoption requires a click"); },
    }))));
    return host.querySelector(".training-transfer-input")!.textContent;
  }
  const noRewrite = {...first, writingReviews: undefined};
  const historicalInput = await checkRetest([noRewrite, {...retest, aids: undefined}]);
  assert.match(historicalInput, /本轮未提交首答改写/);
  assert.match(historicalInput, /独立性未记录/);
  assert.doesNotMatch(historicalInput, /独立复测/);
  const later = {...first, writingReviews: [{...first.writingReviews![0]!, rewrite: {answer: rewrite, at: "2026-03-16T12:00:00Z"}}]};
  const assistedInput = await checkRetest([later, {...retest, usedPreview: true, aids: {preview: false, practiceReference: true}}]);
  assert.match(assistedInput, /复测后改写/);
  assert.match(assistedInput, /已参考首练/);
  assert.doesNotMatch(assistedInput, /独立复测/);
});
