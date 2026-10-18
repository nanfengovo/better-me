import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import {
  createDefaultResumeView,
  createDemoFactBase,
  projectResume,
  type JdMatchReport,
  type LlmConfig,
  type ProjectedResume,
} from "@better-me/core";

// Mount the real React modal and AI client. Every request is intercepted, and
// only a reserved .invalid fixture URL can reach this in-process fetch mock.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://127.0.0.1:5199" });
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { JdMatchModal } = await import("../src/components/JdMatchModal.tsx");
const originalFetch = globalThis.fetch;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, "clipboard");
const config: LlmConfig = {
  provider: "openai-compatible", baseUrl: "https://ai-fixture.invalid/v1",
  apiKey: "fixture-secret-only", model: "fixture-model", temperature: 0.3,
};
const jdText = "岗位职责：开发设备告警接口，维护输入校验与自动化回归。任职要求：熟悉 C#、接口设计和测试。";
const originalClaim = "为设备告警接口编写输入校验，并补充自动化回归测试。";
const demoBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
const demoResume = projectResume(demoBase, createDefaultResumeView(demoBase));
// Deliberately keep the default display name and sample IDs. The substantive
// evidence, rather than a cosmetic name or ID, must determine readiness.
const personalResume: ProjectedResume = {
  locale: "zh", templateId: "zh-classic",
  profile: { displayName: "你的名字", links: [], targetRoles: [], traits: [] },
  experiences: [{
    id: "exp-sample-1", type: "work", org: "合成案例设备研发部", title: "软件工程师",
    start: "2025-01", end: null, techStack: ["C#"],
    claims: [{ id: "claim-sample-1", kind: "action", text: originalClaim, tags: [] }],
  }],
};
const emptyResume: ProjectedResume = { ...personalResume, experiences: [] };
const validSuggestion = {
  claimId: "claim-sample-1", currentText: originalClaim,
  suggestedText: "为设备告警接口补充输入校验与自动化回归测试，覆盖异常输入处理。",
  reason: "合成候选表达；异常输入覆盖范围仍需本人核对。",
};
const report = (summary = "合成材料参考结果", extra: Partial<JdMatchReport> = {}): JdMatchReport => ({
  matchScore: 73, scoreSummary: summary, matchingStrengths: ["当前材料提及接口校验和自动化回归。"],
  missingGaps: ["当前材料未提供其他岗位条件的依据，需本人确认。"],
  tailoredSuggestions: [validSuggestion], unverifiedSuggestionCount: 0,
  interviewDefenseTips: ["请说明测试覆盖的异常输入类型。"], ...extra,
});
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
  status: 200, headers: { "content-type": "application/json" },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Request = { url: string; init: RequestInit | undefined };
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void | Promise<void> = () => undefined) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
async function click(label: string) {
  const target = button(label);
  assert.equal(target.disabled, false, `disabled button: ${label}`);
  await flush(() => target.click());
}
function jdField() {
  const field = dom.document.getElementById("jd-text");
  assert.ok(field instanceof dom.HTMLTextAreaElement, "missing JD editor");
  return field;
}
async function editJd(text: string) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(jdField(), text);
    jdField().dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
const text = () => dom.document.body.textContent ?? "";
const readinessText = () => dom.document.querySelector('[role="status"][aria-label="简历分析准备状态"]')?.textContent ?? "";

async function mount(
  initialResume: ProjectedResume = demoResume,
  policy: (request: Request, index: number) => Response | Promise<Response> = () => response(report()),
) {
  const calls: Request[] = [];
  const saved: { text: string; provenance: unknown }[] = [];
  const copied: string[] = [];
  const callbacks = { imported: 0, edited: 0, closed: 0 };
  let currentResume = initialResume;
  dom.localStorage.clear();
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { async writeText(value: string) { copied.push(value); } } });
  globalThis.fetch = async (url, init) => {
    const request = { url: String(url), init };
    assert.equal(request.url, "https://ai-fixture.invalid/v1/chat/completions", "fixture must never access a real AI service or job website");
    assert.equal(init?.method, "POST");
    calls.push(request);
    return policy(request, calls.length - 1);
  };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")! as unknown as Element);
  const render = async (nextResume = currentResume, isOpen = true) => {
    currentResume = nextResume;
    await flush(() => root!.render(createElement(JdMatchModal, {
      isOpen, resume: currentResume, llmConfig: config, initialText: jdText,
      onClose() { callbacks.closed += 1; }, onOpenConfig() {}, onOpenNetworkSettings() {},
      onImportResume() { callbacks.imported += 1; }, onEditResume() { callbacks.edited += 1; },
      onSaveOpportunity(draft) { saved.push(draft); },
    })));
  };
  await render();
  return { calls, saved, copied, callbacks, render };
}

afterEach(async () => {
  await flush(() => { root?.unmount(); root = undefined; });
  globalThis.fetch = originalFetch;
  dom.localStorage.clear();
  if (clipboardDescriptor) Object.defineProperty(dom.navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(dom.navigator, "clipboard");
});
after(async () => {
  css.deregister();
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("演示简历明确提示示例并禁用分析，点击不会发送 AI 请求", async () => {
  const { calls } = await mount();
  assert.match(readinessText(), /示例/);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  await flush(() => button("开始智能匹配与诊断").click());
  assert.equal(calls.length, 0);
  assert.doesNotMatch(text(), /AI 文本参考评分/);
});

test("缺少经历的空简历不能分析，也不触发网络请求", async () => {
  const { calls } = await mount(emptyResume);
  assert.match(readinessText(), /经历|依据|补充/);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  await flush(() => button("开始智能匹配与诊断").click());
  assert.equal(calls.length, 0);
});

test("准备状态的两个入口调用导入和填写回调，保持零 AI 请求", async () => {
  const { calls, callbacks } = await mount();
  await click("导入我的简历");
  assert.equal(callbacks.imported, 1);
  assert.equal(callbacks.edited, 0);
  await click("填写真实经历");
  assert.equal(callbacks.edited, 1);
  assert.equal(calls.length, 0);
});

test("示例阻挡个人分析期间仍能编辑和收藏 JD，切换简历不丢岗位正文", async () => {
  const { calls, saved, render } = await mount();
  const edited = `${jdText}\n补充要求：维护设备接口文档。`;
  assert.equal(jdField().disabled, false);
  await editJd(edited);
  assert.equal(jdField().value, edited);
  await click("收藏到机会库");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.text, edited);
  assert.equal(calls.length, 0);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  await render(personalResume);
  assert.equal(jdField().value, edited);
  assert.equal(button("开始智能匹配与诊断").disabled, false);
});

test("一段本人材料和一个要点即可分析，默认姓名与 sample IDs 不会被误拦", async () => {
  const { calls } = await mount(personalResume);
  assert.equal(readinessText(), "");
  assert.match(text(), /依据当前简历内容/);
  assert.equal(button("开始智能匹配与诊断").disabled, false);
  await click("开始智能匹配与诊断");
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.model, config.model);
  assert.match(body.messages[1].content, /你的名字/);
  assert.match(body.messages[1].content, /exp-sample-1/);
  assert.match(body.messages[1].content, /claim-sample-1/);
  assert.ok(body.messages[1].content.includes(originalClaim));
  assert.match(text(), /合成材料参考结果/);
  assert.match(text(), /AI 文本参考评分/);
  assert.match(text(), /73\s*\/\s*100/);
  assert.doesNotMatch(text(), /73\s*%/);
  assert.match(text(), /不是能力认证或录用概率/);
});

test("返回示例简历立即清除旧报告与复制入口，不再显示个人匹配结论", async () => {
  const { calls, render } = await mount(personalResume);
  await click("开始智能匹配与诊断");
  assert.match(text(), /合成材料参考结果/);
  assert.ok([...dom.document.querySelectorAll("button")].some(item => item.textContent?.trim() === "复制诊断结果"));
  await render(demoResume);
  assert.match(readinessText(), /示例/);
  assert.doesNotMatch(text(), /合成材料参考结果|AI 文本参考评分/);
  assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent?.trim() === "复制诊断结果"), false);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  assert.equal(calls.length, 1);
});

test("切回示例期间到达的旧响应不能重新显示报告", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(personalResume, () => old.promise);
  await click("开始智能匹配与诊断");
  await render(demoResume);
  await flush(() => old.resolve(response(report("示例期间迟到结果"))));
  assert.equal(calls.length, 1);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  assert.match(readinessText(), /示例/);
  assert.doesNotMatch(text(), /示例期间迟到结果|AI 文本参考评分/);
});

test("切换简历后迟到的旧响应不能覆盖新材料的报告", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(personalResume, (_request, index) => index === 0 ? old.promise : response(report("当前合成材料结果")));
  await click("开始智能匹配与诊断");
  assert.equal(calls.length, 1);
  await render(demoResume);
  assert.equal(button("开始智能匹配与诊断").disabled, true);
  assert.doesNotMatch(text(), /AI 文本参考评分/);
  await render(structuredClone(personalResume));
  await click("开始智能匹配与诊断");
  assert.equal(calls.length, 2);
  assert.match(text(), /当前合成材料结果/);
  await flush(() => old.resolve(response(report("迟到旧材料结果"))));
  assert.match(text(), /当前合成材料结果/);
  assert.doesNotMatch(text(), /迟到旧材料结果/);
});

test("引用未知或原句不符的改写被排除，界面和复制报告都保留待核实边界与来源 ID", async () => {
  const { calls, copied } = await mount(personalResume, () => response(report("引用过滤合成结果", {
    unverifiedSuggestionCount: 999,
    tailoredSuggestions: [
      validSuggestion,
      { ...validSuggestion, claimId: "unknown-fixture-claim", suggestedText: "未知来源改写不能出现" },
      { ...validSuggestion, currentText: "模型概括了原句而非逐字引用。", suggestedText: "错误原句改写不能出现" },
    ],
  })));
  await click("开始智能匹配与诊断");
  assert.equal(calls.length, 1);
  assert.match(text(), /原文已定位，改写待核实/);
  assert.match(text(), /已排除\s*2\s*条/);
  assert.match(text(), /claim-sample-1/);
  assert.ok(text().includes(validSuggestion.suggestedText));
  assert.doesNotMatch(text(), /未知来源改写不能出现|错误原句改写不能出现|绝不造假|999/);
  await click("复制诊断结果");
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /AI 文本参考评分：73\s*\/\s*100/);
  assert.match(copied[0]!, /不是能力认证或录用概率/);
  assert.match(copied[0]!, /原文已定位，改写待核实/);
  assert.match(copied[0]!, /引用要点：claim-sample-1/);
  assert.match(copied[0]!, /逐项核实后再使用/);
  assert.match(copied[0]!, /已排除\s*2\s*条/);
  assert.ok(copied[0]!.includes(originalClaim));
  assert.doesNotMatch(copied[0]!, /未知来源改写不能出现|错误原句改写不能出现|绝不造假|73\s*%|999/);
});
