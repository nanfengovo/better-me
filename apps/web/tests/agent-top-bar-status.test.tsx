import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { source: "export {};", format: "module", shortCircuit: true }
      : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://agent-top-bar-status-fixture.invalid" });
(globalThis as any).window = dom;
(globalThis as any).document = dom.document;

const React = await import("react");
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { AgentTopBarStatus } = await import("../src/components/AgentTopBarStatus.tsx");

test("AgentTopBarStatus renders unconfigured state when config is missing key", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);

  let openedConfig = false;
  let navigated = false;

  await act(async () => {
    root.render(
      h(AgentTopBarStatus, {
        config: {
          provider: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          model: "deepseek-chat",
          temperature: 0.3,
        },
        active: false,
        onNavigateToAgent: () => {
          navigated = true;
        },
        onOpenAiConfig: () => {
          openedConfig = true;
        },
      }),
    );
  });

  const text = container.textContent || "";
  assert.ok(text.includes("AI Agent 助手"), "Should include title");
  assert.ok(text.includes("待配置 Key"), "Should display unconfigured label");
  assert.ok(container.querySelector(".dot-unconfigured"), "Should render amber dot");

  // Clicking unconfigured button should directly open AI Config
  const btn = container.querySelector(".agent-top-bar-main-btn") as any;
  assert.ok(btn, "Main button exists");
  btn.click();
  assert.equal(openedConfig, true, "Should trigger onOpenAiConfig when unconfigured");
  assert.equal(navigated, false, "Should not navigate to workspace when unconfigured");

  root.unmount();
});

test("AgentTopBarStatus renders ready state when config is valid and opens dropdown", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: "deepseek-chat" }],
    }),
  } as any);

  try {
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    let navigated = false;
    let openedConfig = false;

    await act(async () => {
      root.render(
        h(AgentTopBarStatus, {
          config: {
            provider: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "sk-test-valid-key",
            model: "deepseek-chat",
            temperature: 0.3,
          },
          active: false,
          onNavigateToAgent: () => {
            navigated = true;
          },
          onOpenAiConfig: () => {
            openedConfig = true;
          },
        }),
      );
    });

    // Wait for async probe to settle
    await new Promise((r) => setTimeout(r, 80));

    const text = container.textContent || "";
    assert.ok(text.includes("DeepSeek"), "Should show model name tag");

    // Clicking main button navigates to Agent
    const mainBtn = container.querySelector(".agent-top-bar-main-btn") as any;
    mainBtn.click();
    assert.equal(navigated, true, "Should navigate to agent workspace when configured");

    // Toggle dropdown
    const toggleBtn = container.querySelector(".agent-top-bar-toggle-btn") as any;
    assert.ok(toggleBtn, "Toggle button exists");
    await act(async () => {
      toggleBtn.click();
    });

    const dropdown = container.querySelector(".agent-status-dropdown");
    assert.ok(dropdown, "Dropdown menu should be visible");
    assert.ok(dropdown.textContent?.includes("AI 顾问状态看板"), "Dropdown contains header");
    assert.ok(dropdown.textContent?.includes("deepseek-chat"), "Dropdown contains model info");

    root.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});
