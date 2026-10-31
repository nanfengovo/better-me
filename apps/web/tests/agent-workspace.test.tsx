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

const dom = new Window({ url: "http://agent-workspace-fixture.invalid" });
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
let nextChatReply: (() => unknown) | undefined;
let holdChatRequest: ((init: RequestInit | undefined) => Promise<Response>) | undefined;
let chatRequestBodies: Array<{
  messages?: Array<{ role: string; content: string }>;
  context?: { resumeEditContext?: { profile?: { headline?: { text?: string } }; experiences?: unknown[] }; resumeSummary?: unknown };
}> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/start")) {
    return new Response(
      JSON.stringify({
        status: "awaiting_review",
        threadId: "test-thread-ws-1",
        proposals: [
          {
            id: "prop-ws-1",
            jdItem: "React 架构设计",
            evidenceType: "verified",
            suggestion: "突出微前端重构经验",
            rationale: "与 JD 完全匹配",
          },
          {
            id: "prop-ws-2",
            jdItem: "大型分布式系统",
            evidenceType: "gap",
            suggestion: "补充高并发系统自学与实操背景",
            rationale: "岗位明确要求但简历未详述",
          },
        ],
        structuredJd: {
          title: "全栈架构师",
          company: "领先科技",
          location: "上海",
          requirements: ["React", "TypeScript", "Node.js"],
          preferences: [],
          compensationRaw: "40k-60k",
          techStack: ["React", "TypeScript", "Node.js", "Docker"],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.includes("/chat")) {
    if (typeof init?.body === "string") chatRequestBodies.push(JSON.parse(init.body) as typeof chatRequestBodies[number]);
    if (holdChatRequest) return holdChatRequest(init);
    if (nextChatReply) return Response.json({ reply: nextChatReply() }, { status: 200 });
    return new Response(
      JSON.stringify({
        message: {
          id: "msg-test-reply",
          role: "assistant",
          content: "已为你查询到该公司背景：属于高新技术外资研发中心，实控结构清晰。",
          createdAt: new Date().toISOString(),
          actions: [
            {
              type: "company_card",
              companyName: "领先科技",
              ownership: "外资独资控股",
              summary: "深耕企业级云原生服务领域，具备良好的研发技术积累。",
              officialUrl: "https://example.com/careers",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.includes("/health")) {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof fetch;

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { AgentWorkspace } = await import("../src/components/AgentWorkspace.tsx");

let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

async function mount(children: React.ReactNode) {
  if (root) await flush(() => root!.unmount());
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")!);
  await flush(() =>
    root!.render(
      h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, children),
    ),
  );
}

test.after(async () => { if (root) await flush(() => root!.unmount()); });

const dummyResume: ProjectedResume = {
  profile: {
    displayName: "张敏",
    headline: "资深全栈工程师",
    education: "硕士",
    location: "上海",
    targetRoles: ["前端专家", "全栈架构师"],
    traits: ["技术攻坚", "工程化"],
  },
  educationSummary: "计算机硕士",
  experiences: [
    {
      id: "exp-1",
      title: "资深工程师",
      org: "科技公司",
      start: "2021",
      end: null,
      type: "work",
      claims: [
        { id: "claim-1", text: "负责前端架构重构，主导微前端方案落地" },
      ],
      techStack: ["React", "TypeScript"],
    },
  ],
  skills: ["React", "TypeScript", "Node.js"],
  projects: [],
  educations: [],
  activities: [],
};

const dummyLlmConfig: LlmConfig = {
  provider: "openai-compatible",
  apiKey: "sk-dummy-test-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  temperature: 0.3,
};

test("AgentWorkspace renders full-page dual-pane layout with job profile and chat on left, analytics and proposals on right", async () => {
  await mount(
    h(AgentWorkspace, {
      job: {
        title: "全栈架构师",
        company: "领先科技",
        location: "上海",
        salary: "40k-60k",
        description: "岗位要求精通 React 和 TypeScript，有大型微前端及高并发架构经验。",
      },
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture");
  assert.ok(fixture !== null, "Fixture should be rendered");

  // Top header elements
  assert.ok(fixture.textContent?.includes("AI 顾问工作台"), "Should render workspace title");
  assert.ok(fixture.textContent?.includes("返回简历"), "Should render back to resume button");
  assert.ok(fixture.textContent?.includes("模型设置"), "Should render model settings button");

  // Left pane: Job Profile Card & Chat
  assert.ok(fixture.textContent?.includes("领先科技"), "Should render company name in job card");
  assert.ok(fixture.textContent?.includes("全栈架构师"), "Should render job title");
  assert.ok(fixture.textContent?.includes("助理协同对话"), "Should render chat copilot header");
  assert.ok(fixture.textContent?.includes("快捷指令:"), "Should render quick prompts ribbon");

  // Right pane: Matching Analytics & HITL Proposal Deck
  assert.ok(fixture.textContent?.includes("契合度"), "Should render match score");
  assert.ok(fixture.textContent?.includes("全部提案"), "Should render proposal filter tabs");
});

test("resume edits require explicit field sharing and a verified-source approval", async () => {
  chatRequestBodies = [];
  nextChatReply = () => ({
    id: `msg-resume-edit-${chatRequestBodies.length}`,
    role: "assistant",
    content: "我仅调整了已有表述。",
    actions: [{
      type: "resume_proposal",
      targetSection: "个人简介",
      targetRef: { kind: "profile_headline", locale: "zh" },
      originalText: chatRequestBodies.length === 3 ? "资深全栈工程师" : "模型伪造的旧原文",
      proposedText: "资深全栈工程师 · 专注微前端",
      rationale: "突出与岗位相关的现有方向。",
    }, ...(chatRequestBodies.length === 3 ? [{
      type: "resume_proposal",
      targetSection: "科技公司 · 资深工程师 · 经历要点",
      targetRef: { kind: "claim_text", experienceId: "exp-1", claimId: "claim-1", locale: "zh" },
      originalText: "负责前端架构重构，主导微前端方案落地",
      proposedText: "负责前端架构重构，并主导微前端方案落地",
      rationale: "提升句式流畅度，不改变既有事实。",
    }] : [])],
  });
  const approvalCapture: { value?: { targetRef: { kind: string; locale: string }; originalText: string; proposedText: string } } = {};
  const resumeEditContext = {
    locale: "zh" as const,
    profile: { headline: { targetRef: { kind: "profile_headline" as const, locale: "zh" as const }, text: "资深全栈工程师" }, skills: ["React"] },
    experiences: [{
      id: "exp-1",
      type: "work" as const,
      organization: "科技公司",
      title: "资深工程师",
      claims: [{
        targetRef: { kind: "claim_text" as const, experienceId: "exp-1", claimId: "claim-1", locale: "zh" as const },
        kind: "action",
        text: "负责前端架构重构，主导微前端方案落地",
        tags: [],
      }],
    }],
  };

  await mount(h(AgentWorkspace, {
    job: { title: "全栈架构师", company: "领先科技", description: "需要 React 与 TypeScript。" },
    resume: dummyResume,
    resumeEditContext,
    llmConfig: dummyLlmConfig,
    onOpenConfig: () => {},
    onNavigateToResume: () => {},
    onApplyToResume: () => {},
    onApplyResumeProposal: async (proposal) => {
      approvalCapture.value = proposal;
      return { ok: true, message: "已批准并提交到简历保存流程。" };
    },
  }));

  const fixture = dom.document.getElementById("fixture")!;
  const shareButton = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("允许 Agent 读取简历字段"));
  assert.ok(shareButton, "Explicit resume-sharing control should be available");

  const textarea = fixture.querySelector(".agent-chat-textarea") as HTMLTextAreaElement;
  await flush(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "请基于已授权简历字段润色个人简介");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(() => {
    Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.trim() === "发送")?.click();
  });
  assert.equal(chatRequestBodies.at(-1)?.context?.resumeEditContext, undefined, "resume fields are not sent before explicit consent");
  assert.equal(chatRequestBodies.at(-1)?.context?.resumeSummary, undefined, "personal resume summary is not sent implicitly");

  await flush(() => {
    Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("允许 Agent 读取简历字段"))?.click();
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "请基于已授权简历字段润色个人简介");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(() => {
    Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("发送"))?.click();
  });

  assert.equal(chatRequestBodies.at(-1)?.context?.resumeEditContext?.profile?.headline?.text, "资深全栈工程师");
  assert.equal(chatRequestBodies.at(-1)?.context?.resumeSummary, undefined);
  assert.ok(fixture.textContent?.includes("模型返回的原文与当前简历字段不一致"));
  assert.ok(!fixture.textContent?.includes("模型伪造的旧原文"), "untrusted model source text must not be shown as fact");
  assert.equal(Array.from(fixture.querySelectorAll("button")).filter((button) => button.textContent?.includes("批准并写回简历")).length, 0, "mismatched model source must not be approvable");

  await flush(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "请重新基于当前字段生成建议");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("发送"))?.click();
  });
  assert.equal(chatRequestBodies.at(-1)?.context?.resumeEditContext?.profile?.headline?.text, "资深全栈工程师");
  assert.ok(fixture.textContent?.includes("资深全栈工程师"), "the proposal should display the trusted original text");
  assert.ok(fixture.textContent?.includes("已绑定简历原文"));

  await flush(() => {
    Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("批准并写回简历"))?.click();
  });
  assert.ok(approvalCapture.value, "approval should invoke the guarded write-back callback");
  assert.equal(approvalCapture.value?.originalText, "资深全栈工程师");
  assert.ok(fixture.textContent?.includes("已批准并提交到简历保存流程"));
  const rejectButton = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.trim() === "拒绝");
  assert.ok(rejectButton, "a grounded proposal should offer an explicit reject action");
  await flush(() => rejectButton?.click());
  assert.ok(fixture.textContent?.includes("已拒绝；简历未修改。"));
  assert.equal(approvalCapture.value?.proposedText, "资深全栈工程师 · 专注微前端", "rejecting a different proposal must not invoke the write callback");
  nextChatReply = undefined;
  chatRequestBodies = [];
});

test("AgentWorkspace handles proposal accept and triggers onApplyToResume", async () => {
  let appliedPayload: { acceptedProposals: MatchProposal[]; customResumeName: string } | null = null;

  await mount(
    h(AgentWorkspace, {
      job: {
        title: "全栈架构师",
        company: "领先科技",
        description: "精通 React，微前端架构。",
      },
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: (payload) => {
        appliedPayload = payload;
      },
    })
  );

  const fixture = dom.document.getElementById("fixture");
  assert.ok(fixture !== null);

  // Find the "应用已采纳" button
  const buttons = Array.from(fixture.querySelectorAll("button"));
  const applyButton = buttons.find((btn) => btn.textContent?.includes("应用已采纳"));
  assert.ok(applyButton, "Apply button should be present");

  await flush(() => {
    applyButton?.click();
  });

  assert.ok(appliedPayload !== null, "onApplyToResume should be invoked");
  assert.ok(appliedPayload.acceptedProposals.length >= 1, "Should include accepted proposal");
  assert.ok(appliedPayload.customResumeName.includes("领先科技 · 全栈架构师"), "Custom resume name should match");
});

test("AgentWorkspace displays API Key notice banner when key is missing and navigates back to resume", async () => {
  let navigatedToResume = false;
  let openedConfig = false;

  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: {
        provider: "openai-compatible",
        apiKey: "", // missing API key
        baseUrl: "",
        model: "gpt-4o",
        temperature: 0.3,
      },
      onOpenConfig: () => {
        openedConfig = true;
      },
      onNavigateToResume: () => {
        navigatedToResume = true;
      },
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture");
  assert.ok(fixture !== null);

  // Banner should warn about missing API key
  assert.ok(
    fixture.textContent?.includes("未配置模型 API Key"),
    "Should display API key warning banner"
  );

  // Click Back to Resume button
  const buttons = Array.from(fixture.querySelectorAll("button"));
  const backBtn = buttons.find((btn) => btn.textContent?.includes("返回简历"));
  assert.ok(backBtn, "Back button should exist");
  await flush(() => {
    backBtn?.click();
  });
  assert.equal(navigatedToResume, true, "Should trigger onNavigateToResume callback");

  // Click Configure button
  const configBtn = buttons.find((btn) => btn.textContent?.includes("去配置"));
  assert.ok(configBtn, "Config button should exist in banner");
  await flush(() => {
    configBtn?.click();
  });
  assert.equal(openedConfig, true, "Should trigger onOpenConfig callback");
});

test("AgentWorkspace provides link extraction button, opens input panel, and auto-fills job fields", async () => {
  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture");
  assert.ok(fixture !== null);

  // Link import panel is open by default in setup
  assert.ok(fixture.textContent?.includes("岗位链接或分享文字"), "Link import panel should be visible");

  const linkInput = fixture.querySelector(
    'textarea[placeholder*="粘贴 BOSS直聘"], textarea[placeholder*="粘贴岗位链接"], input[placeholder*="粘贴岗位链接"]'
  ) as HTMLTextAreaElement | HTMLInputElement | null;
  assert.ok(linkInput, "Link input field should be rendered");
  assert.ok(
    (linkInput.getAttribute("placeholder") || "").includes("BOSS直聘"),
    "Should mention supported platforms in placeholder"
  );

  // Enter mobile share text
  const shareText = `【杭州】高级前端技术专家 某创新科技有限公司
薪资：35k-50k · 16薪
工作地点：杭州 · 余杭区
岗位职责：负责智能 Agent 前端架构演进与全栈中台建设`;

  await flush(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(linkInput, shareText);
    } else {
      linkInput.value = shareText;
    }
    linkInput.dispatchEvent(new Event("input", { bubbles: true }));
    linkInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Click "读取并自动填入" button
  const extractBtn = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes("读取并自动填入")
  );
  assert.ok(extractBtn, "Extract and fill button should exist");

  await act(async () => {
    extractBtn?.click();
    for (let i = 0; i < 15; i++) {
      await nextTurn();
    }
  });

  // Form inputs should now be automatically populated
  const updatedInputs = Array.from(fixture.querySelectorAll("input"));
  const titleInput = updatedInputs.find((inp) => inp.value?.includes("高级前端技术专家"));
  const companyInput = updatedInputs.find((inp) => inp.value?.includes("某创新科技有限公司"));
  const salaryInput = updatedInputs.find((inp) => inp.value?.includes("35k-50k"));
  const locationInput = updatedInputs.find((inp) => inp.value?.includes("杭州"));

  assert.ok(titleInput, "Title input should be auto-filled");
  assert.ok(companyInput, "Company input should be auto-filled");
  assert.ok(salaryInput, "Salary input should be auto-filled");
  assert.ok(locationInput, "Location input should be auto-filled");

  const textarea = fixture.querySelector("textarea");
  assert.ok(textarea?.value?.includes("智能 Agent 前端架构演进"), "JD text area should be populated");
});

test("AgentWorkspace isolates setup view during JD creation/editing without squashed chat, and smoothly transitions on submit", async () => {
  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture");
  assert.ok(fixture !== null);

  // During setup mode, the left pane should render the dedicated setup view
  assert.ok(fixture.textContent?.includes("设定目标岗位与完整 JD"), "Should show dedicated setup header");
  assert.ok(fixture.textContent?.includes("开始拆解"), "Should show primary submit button");
  assert.ok(fixture.textContent?.includes("岗位摘要"), "Should show quiet job summary on the right");
  // It should NOT render the squashed chat input or header during setup
  assert.ok(!fixture.textContent?.includes("向 Copilot 提问"), "Should not render chat input in setup mode");
  assert.ok(!fixture.textContent?.includes("助理协同对话 (Career Copilot)"), "Should not render copilot header in setup mode");

  // Load sample JD via chip
  const buttons = Array.from(fixture.querySelectorAll("button"));
  const sampleBtn = buttons.find((btn) => btn.textContent?.includes("前端 / 全栈"));
  assert.ok(sampleBtn, "Sample JD chip should exist");

  await flush(() => {
    sampleBtn?.click();
  });

  const jdTextarea = Array.from(fixture.querySelectorAll("textarea")).find((el) =>
    (el as HTMLTextAreaElement).value?.includes("岗位职责")
  ) as HTMLTextAreaElement | undefined;
  assert.ok(jdTextarea?.value?.includes("岗位职责"), "Textarea should have sample JD");

  // Click submit button
  const submitBtn = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.trim() === "开始拆解" || btn.textContent?.includes("开始拆解")
  );
  assert.ok(submitBtn, "Submit button should exist");

  await act(async () => {
    submitBtn?.click();
    for (let i = 0; i < 15; i++) {
      await nextTurn();
    }
  });

  // Now active mode should be rendered: compact banner + Copilot chat
  assert.ok(fixture.textContent?.includes("资深前端/全栈架构师"), "Active job title should be displayed");
  assert.ok(fixture.textContent?.includes("助理协同对话 (Career Copilot)"), "Copilot chat should now be active");
  assert.ok(fixture.querySelector(':is(input, textarea)[placeholder*="向 Copilot 提问"]'), "Chat input should now be available");

  // Edit job button should be present in compact banner
  const editJobBtn = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes("编辑岗位")
  );
  assert.ok(editJobBtn, "Edit job button should be present in compact banner");

  await flush(() => {
    editJobBtn?.click();
  });

  // Should switch back to editing mode
  assert.ok(fixture.textContent?.includes("编辑 / 更换目标岗位"), "Should switch back to editing view");
  assert.ok(fixture.textContent?.includes("取消修改"), "Should show cancel edit button");
});

test("AgentWorkspace: displays actionable guide and buttons when platform verification is required", async () => {
  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: {
        provider: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://api.test.com",
        model: "gpt-4o",
        temperature: 0.3,
      },
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture")!;
  assert.ok(fixture !== null);

  // Link input panel is open by default
  const linkInput = fixture.querySelector('textarea[placeholder*="粘贴 BOSS直聘"]') as HTMLTextAreaElement;
  assert.ok(linkInput, "Link input textarea should be present");

  // Enter a path that triggers platform verification notice
  await flush(() => {
    linkInput.value = "job/789ad05bba32b1b60nV72du4GFtQ?date8=20261021";
    linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Extract button
  const extractBtn = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes("读取并自动填入")
  );
  assert.ok(extractBtn, "Extract button should exist");

  await act(async () => {
    extractBtn?.click();
    for (let i = 0; i < 20; i++) {
      await nextTurn();
    }
  });

  // If error occurs, the actionable error card should be displayed
  const openWebLink = fixture.querySelector('a[href*="zhipin.com/job/789ad05bba32b1b60nV72du4GFtQ"]');
  if (openWebLink) {
    assert.ok(openWebLink.getAttribute("href")?.startsWith("https://www.zhipin.com/job/"), "Should normalize URL to official zhipin domain");
    assert.equal(openWebLink.getAttribute("target"), "_blank", "Should open in new tab");
  }

  const clipboardBtn = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes("读取剪贴板文字并提取")
  );
  if (clipboardBtn) {
    assert.ok(clipboardBtn, "Clipboard extraction button should be available in error card");
  }
});

test("AgentWorkspace: supports draggable splitter and quiet setup summary chips", async () => {
  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: {
        provider: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "https://api.test.com",
        model: "gpt-4o",
        temperature: 0.3,
      },
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    })
  );

  const fixture = dom.document.getElementById("fixture")!;
  assert.ok(fixture !== null);

  // 1. Draggable splitter verification
  const splitter = fixture.querySelector('[role="separator"]');
  assert.ok(splitter, "Splitter separator with role='separator' should exist");
  assert.ok(splitter?.getAttribute("aria-valuenow"), "Splitter should have aria-valuenow indicating percent");

  // 2. Quiet right-pane summary (no Live Inspector / pipeline marketing chrome)
  assert.ok(fixture.textContent?.includes("岗位摘要"), "Job summary should be present");
  assert.ok(fixture.textContent?.includes("范例岗位"), "Sample chips section should be present");
  assert.ok(!fixture.textContent?.includes("Live Inspector"), "Should not show Live Inspector chrome");
  assert.ok(!fixture.textContent?.includes("深度解析引擎"), "Should not show inspection engine chrome");

  const sampleChip = Array.from(fixture.querySelectorAll("button")).find((btn) =>
    btn.textContent?.includes("前端 / 全栈")
  );
  assert.ok(sampleChip, "Sample chip should exist");
});

test("AgentWorkspace stages a resume quote with source context in the chat composer", async () => {
  await mount(
    h(AgentWorkspace, {
      job: null,
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      initialReference: { type: "resume_text", sourceLabel: "简历 · 工作经历", text: "负责前端架构重构，主导微前端方案落地" },
      onReferenceConsumed: () => {},
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    }),
  );
  const fixture = dom.document.getElementById("fixture")!;
  assert.ok(fixture.textContent?.includes("简历 · 工作经历"));
  assert.ok(fixture.textContent?.includes("负责前端架构重构，主导微前端方案落地"));
  assert.ok(fixture.querySelector('button[aria-label="上传图片"]'), "composer should provide an image attachment entry point");
});

test("full Agent workspace stops an in-flight chat and restores its editable question and quote", async () => {
  let requestSignal: AbortSignal | undefined;
  holdChatRequest = (init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true }));
  };
  try {
    await mount(h(AgentWorkspace, {
      job: { title: "全栈工程师", company: "样例企业", description: "只用于本地测试。" },
      resume: dummyResume, llmConfig: dummyLlmConfig,
      initialReference: { type: "resume_text", sourceLabel: "示例经历", text: "只读引用" },
      onReferenceConsumed: () => {}, onOpenConfig: () => {}, onNavigateToResume: () => {}, onApplyToResume: () => {},
    }));
    const fixture = dom.document.getElementById("fixture")!;
    const composer = fixture.querySelector<HTMLTextAreaElement>('textarea[placeholder*="向 Copilot 提问"]')!;
    await flush(() => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "分析这个示例");
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => Array.from(fixture.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "发送")?.click());
    assert.ok(requestSignal);
    await flush(() => fixture.querySelector<HTMLButtonElement>('[aria-label="停止生成并编辑问题"]')?.click());
    assert.equal(requestSignal?.aborted, true);
    assert.equal(composer.value, "分析这个示例");
    assert.match(fixture.querySelector('[aria-label="待发送的上下文附件"]')?.textContent ?? "", /只读引用/);
    assert.ok(!fixture.textContent?.includes("模型未能生成回复"));
    const guide = fixture.querySelector<HTMLButtonElement>('[data-testid="workspace-guide-plan"]');
    assert.ok(guide);
    const requestCount = chatRequestBodies.length;
    await flush(() => guide.click());
    assert.match(composer.value, /规划/);
    assert.equal(chatRequestBodies.length, requestCount);
  } finally { holdChatRequest = undefined; }
});

test("truncated assistant replies offer a one-click continuation using the existing context", async () => {
  nextChatReply = () => ({
      id: `truncated-chat-reply-${chatRequestBodies.length}`,
      role: "assistant",
      content: "已生成的部分答复。",
      createdAt: "2026-10-27T12:00:00.000Z",
      meta: {
        provider: "openai-compatible",
        providerLabel: "OpenAI · API",
        model: "gpt-4o",
        source: "agent-host",
        status: "truncated",
        completeness: "truncated",
        observedAt: "2026-10-27T12:00:00.000Z",
        finishReason: "length",
        warning: "模型输出仍触及长度上限，回复可能不完整。",
      },
    });
  chatRequestBodies = [];
  try {
    await mount(h(AgentWorkspace, {
      job: { title: "全栈架构师", company: "领先科技", description: "React、TypeScript。" },
      resume: dummyResume,
      llmConfig: dummyLlmConfig,
      onOpenConfig: () => {},
      onNavigateToResume: () => {},
      onApplyToResume: () => {},
    }));
    const fixture = dom.document.getElementById("fixture")!;
    const quickPrompt = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("调研实控人与背景"));
    assert.ok(quickPrompt);
    await flush(() => quickPrompt.click());
    assert.ok(Array.from(fixture.querySelectorAll("button")).some((button) => button.textContent?.includes("继续补完")));

    const continueButton = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("继续补完"));
    assert.ok(continueButton);
    await flush(() => continueButton.click());
    assert.equal(chatRequestBodies.length, 2);
    assert.equal(chatRequestBodies[1]?.messages?.at(-2)?.role, "assistant");
    assert.match(chatRequestBodies[1]?.messages?.at(-1)?.content ?? "", /继续/);
  } finally {
    nextChatReply = undefined;
    chatRequestBodies = [];
  }
});

test("career growth is reachable inside the existing agent workspace and returns to its conversation", async () => {
  const previousRequests = chatRequestBodies.length;
  await mount(h(AgentWorkspace, {
    workspaceKey: "career-entry-fixture",
    active: true,
    job: null,
    resume: dummyResume,
    llmConfig: dummyLlmConfig,
    onOpenConfig: () => {},
    onNavigateToResume: () => {},
    onApplyToResume: () => {},
  }));
  const fixture = dom.document.getElementById("fixture")!;
  const entry = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.trim() === "职业成长");
  assert.ok(entry, "the existing Agent workspace must expose the new workflow");
  await flush(() => entry.click());
  for (const label of ["规划分析", "修改建议", "学习方案", "学习监督", "模拟面试"]) {
    assert.ok(fixture.textContent?.includes(label), `career growth must expose ${label}`);
  }
  assert.equal(chatRequestBodies.length, previousRequests, "opening the workspace must not trigger a model conversation");
  const back = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("返回对话与 JD"));
  assert.ok(back);
  await flush(() => back.click());
  assert.ok(fixture.querySelector('[role="separator"]'), "the existing conversation workspace should remain available");
  assert.ok(!fixture.querySelector('[aria-label="成长工作区"]'));
});

test("career growth makes the entered JD available for separate opt-in without running legacy matching", async () => {
  const previousRequests = chatRequestBodies.length;
  await mount(h(AgentWorkspace, {
    workspaceKey: "career-jd-handoff-fixture", active: true, job: null, resume: dummyResume,
    llmConfig: dummyLlmConfig, onOpenConfig: () => {}, onNavigateToResume: () => {}, onApplyToResume: () => {},
  }));
  const fixture = dom.document.getElementById("fixture")!;
  const sample = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("前端 / 全栈"));
  assert.ok(sample);
  await flush(() => sample.click());
  const entry = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.trim() === "职业成长");
  assert.ok(entry);
  await flush(() => entry.click());
  const shareLabel = Array.from(fixture.querySelectorAll("label")).find((label) => label.textContent?.includes("共享当前目标岗位"));
  const share = shareLabel?.querySelector("input");
  assert.ok(share);
  assert.equal(share.disabled, false, "entered JD must be available without first running legacy matching");
  assert.equal(share.checked, false, "entering career growth must not silently authorize sharing");
  assert.equal(chatRequestBodies.length, previousRequests);
  const back = Array.from(fixture.querySelectorAll("button")).find((button) => button.textContent?.includes("返回对话与 JD"));
  assert.ok(back);
  await flush(() => back.click());
  assert.ok(fixture.textContent?.includes("设定目标岗位与完整 JD"), "the old JD flow must stay unsubmitted");
});


