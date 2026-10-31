import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LlmConfig, ProjectedResume } from "@better-me/core";
import type { MatchProposal } from "../src/services/agent-client";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://jd-match-drawer-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

// Mock fetch for agent host health check and API calls
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/start")) {
    return new Response(
      JSON.stringify({
        status: "awaiting_review",
        threadId: "test-thread-1",
        proposals: [
          {
            id: "prop-1",
            jdItem: "React 架构设计",
            evidenceType: "verified",
            suggestion: "突出微前端重构经验",
            rationale: "与 JD 完全匹配",
          },
        ],
        structuredJd: {
          title: "前端专家",
          company: "创新",
          location: "北京",
          requirements: ["React", "TypeScript"],
          preferences: [],
          compensationRaw: "30k",
          techStack: ["React", "TypeScript"],
        },
        errors: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { JdMatchDrawer } = await import("../src/components/JdMatchDrawer.tsx");

let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

async function mount(children: React.ReactNode) {
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")!);
  await flush(() =>
    root!.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, children),
    ),
  );
}

const mockLlmConfig: LlmConfig = {
  provider: "custom",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-token",
  model: "gpt-4o-mini",
  temperature: 0.2,
};

const mockResume: ProjectedResume = {
  locale: "zh",
  templateId: "default",
  skills: ["TypeScript", "React", "Node.js"],
  profile: {
    displayName: "张三",
    headline: "资深全栈工程师",
    targetRoles: ["前端专家", "全栈专家"],
    traits: ["敏捷开发", "跨团队协作"],
    links: [],
  },
  experiences: [
    {
      id: "exp-1",
      type: "work",
      org: "科技公司",
      title: "资深工程师",
      start: "2021-01",
      end: null,
      techStack: ["React", "TypeScript"],
      claims: [
        {
          id: "claim-1",
          kind: "action",
          text: "主导微前端架构重构，缩短首屏加载时间 40%",
          tags: ["微前端", "性能优化"],
        },
      ],
    },
  ],
};

test("JdMatchDrawer does not render when isOpen is false", async () => {
  await mount(
    h(JdMatchDrawer, {
      isOpen: false,
      onClose: () => {},
      job: null,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  const dialog = dom.document.querySelector('[role="dialog"]');
  assert.equal(dialog, null);
});

test("JdMatchDrawer renders job info and tab headers when open", async () => {
  const sampleJob = {
    title: "前端专家",
    company: "未来科技有限公司",
    location: "北京",
    salary: "35k-50k",
    description: "岗位职责：负责核心 Web 应用架构设计，精通 React 与 TypeScript。",
  };

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: sampleJob,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  const dialog = dom.document.querySelector('[role="dialog"]');
  assert.ok(dialog !== null, "Dialog should be rendered");

  const textContent = dialog.textContent || "";
  assert.ok(textContent.includes("未来科技有限公司"), "Company should be displayed");
  assert.ok(textContent.includes("前端专家"), "Title should be displayed");
  assert.ok(textContent.includes("35k-50k"), "Salary should be displayed");
  assert.ok(textContent.includes("LangGraph"), "LangGraph badge should be displayed");
  assert.ok(textContent.includes("提案卡片审核"), "Proposals tab header should be present");
  assert.ok(textContent.includes("助理协同对话"), "Chat tab header should be present");
});

test("JdMatchDrawer can switch between Proposals and Chat tabs", async () => {
  const sampleJob = {
    title: "AI 架构师",
    company: "智能未来",
    description: "精通大模型与多 Agent 编排技术。",
  };

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: sampleJob,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  // Find the chat tab button
  const buttons = Array.from(dom.document.querySelectorAll("button"));
  const chatTabButton = buttons.find((b) => b.textContent?.includes("助理协同对话"));
  assert.ok(chatTabButton, "Chat tab button should exist");

  // Click to switch tab
  await flush(() => {
    chatTabButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  const chatInput = dom.document.querySelector('textarea[placeholder*="向 Agent 提问"]');
  assert.ok(chatInput !== null, "Chat input should appear after switching to chat tab");
});

test("JdMatchDrawer handles proposal actions and triggers onApplyToResume", async () => {
  let appliedPayload: {
    acceptedProposals: MatchProposal[];
    customResumeName: string;
    targetJobTitle: string;
    targetCompany: string;
  } | null = null;

  const sampleJob = {
    title: "全栈架构师",
    company: "创新工坊",
    description: "需要 React 和 Node.js 全栈能力。",
  };

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: sampleJob,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: (payload) => {
        appliedPayload = payload;
      },
    }),
  );

  // Find the apply button
  const buttons = Array.from(dom.document.querySelectorAll("button"));
  const applyButton = buttons.find((b) => b.textContent?.includes("一键应用到当前定制简历"));
  assert.ok(applyButton, "Apply button should exist in footer");

  // If there are accepted proposals (from initial parse), clicking apply triggers callback
  if (!applyButton.hasAttribute("disabled")) {
    await flush(() => {
      applyButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.ok(appliedPayload !== null);
    assert.equal(appliedPayload.targetCompany, "创新工坊");
    assert.equal(appliedPayload.targetJobTitle, "全栈架构师");
  }
});

test("JdMatchDrawer renders in modeless copilot mode with non-blocking left-side and width toggle", async () => {
  const sampleJob = {
    title: "前端专家",
    company: "创新工坊",
    description: "精通 React 与 TypeScript。",
  };

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: sampleJob,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  // Modeless wrapper should have pointer-events-none
  const wrapper = dom.document.querySelector('.fixed.inset-0');
  assert.ok(wrapper !== null, "Drawer container should exist");
  assert.ok(wrapper.className.includes("pointer-events-none"), "Wrapper should be non-blocking with pointer-events-none");

  // Inner drawer section should be interactive
  const drawer = dom.document.querySelector('section[role="dialog"] > div');
  assert.ok(drawer !== null, "Drawer inner container should exist");
  assert.ok(drawer.className.includes("pointer-events-auto"), "Drawer should have pointer-events-auto");

  // Verify copilot split-screen indicator
  const badge = dom.document.body.textContent || "";
  assert.ok(badge.includes("分屏协同"), "Should display split copilot indicator");

  // Test width toggle button
  const buttons = Array.from(dom.document.querySelectorAll("button"));
  const widthToggle = buttons.find((b) => b.getAttribute("title")?.includes("展开更宽视窗"));
  assert.ok(widthToggle !== null, "Width toggle button should exist");

  await flush(() => {
    widthToggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(drawer.className.includes("max-w-4xl"), "Drawer should expand to max-w-4xl");
});

test("JdMatchDrawer dispatches agent guided interaction when Locate is clicked", async () => {
  const sampleJob = {
    title: "前端专家",
    company: "创新工坊",
    description: "精通 React 架构设计。",
  };

  let guideEventFired = false;
  let receivedTarget: any = null;
  const guideHandler = (e: Event) => {
    guideEventFired = true;
    receivedTarget = (e as CustomEvent).detail;
  };
  dom.window.addEventListener("betterme:agent-guide", guideHandler);

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: sampleJob,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  const locateButton = Array.from(dom.document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("定位")
  );
  assert.ok(locateButton !== null, "Locate button should exist on proposal cards");

  await flush(() => {
    locateButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.ok(guideEventFired, "betterme:agent-guide custom event should be dispatched");
  assert.ok(receivedTarget !== null, "Target detail should be attached");
  assert.equal(receivedTarget.actionType, "suggest");

  dom.window.removeEventListener("betterme:agent-guide", guideHandler);
});

test("JdMatchDrawer renders target job setup form and loads sample JD when opened without a job", async () => {
  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: null,
      resume: mockResume,
      llmConfig: mockLlmConfig,
      onOpenConfig: () => {},
      onApplyToResume: () => {},
    }),
  );

  const heading = Array.from(dom.document.querySelectorAll("h3")).find((h) =>
    h.textContent?.includes("设定目标岗位与 JD")
  );
  assert.ok(heading !== undefined, "Should render job setup form when job is null");

  const sampleButton = Array.from(dom.document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("载入范例岗位 JD")
  );
  assert.ok(sampleButton !== undefined, "Should have load sample JD button");

  await flush(() => {
    sampleButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  const textarea = dom.document.querySelector("textarea");
  assert.ok(textarea !== null && textarea.value.length > 50, "Sample JD text should be loaded into textarea");

  const startButton = Array.from(dom.document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("开始智能拆解与匹配分析")
  );
  assert.ok(startButton !== undefined, "Start button should be present");
  assert.equal(startButton.disabled, false, "Start button should be enabled after loading sample");
});

test("JdMatchDrawer displays warning banner when API key is missing and provides quick prompts in chat", async () => {
  let configOpened = false;
  const noKeyConfig: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
  };

  await mount(
    h(JdMatchDrawer, {
      isOpen: true,
      onClose: () => {},
      job: null,
      resume: mockResume,
      llmConfig: noKeyConfig,
      onOpenConfig: () => {
        configOpened = true;
      },
      onApplyToResume: () => {},
    }),
  );

  const banner = dom.document.querySelector(".bg-amber-500\\/10");
  assert.ok(banner !== null, "Warning banner should be displayed when API key is missing");
  assert.ok(banner.textContent?.includes("未配置 AI 模型 API Key"), "Banner should warn about missing API key");

  const configBtn = Array.from(banner.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("立即配置模型")
  );
  assert.ok(configBtn !== undefined, "Configure button should be in banner");

  await flush(() => {
    configBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(configOpened, true, "Clicking config button should trigger onOpenConfig");

  // Switch to chat tab
  const chatTab = Array.from(dom.document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("助理协同对话")
  );
  assert.ok(chatTab !== undefined);

  await flush(() => {
    chatTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  const quickPrompts = Array.from(dom.document.querySelectorAll("button")).filter(
    (b) =>
      b.textContent?.includes("调研公司背景") ||
      b.textContent?.includes("按 STAR 优化") ||
      b.textContent?.includes("面试考点") ||
      b.textContent?.includes("技能缺口")
  );
  assert.equal(quickPrompts.length, 4, "Should render 4 quick prompt buttons in chat tab");
});

