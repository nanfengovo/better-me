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

let root: ReturnType<typeof createRoot> | undefined;
const ownerId = "11111111-1111-4111-8111-111111111111";

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
