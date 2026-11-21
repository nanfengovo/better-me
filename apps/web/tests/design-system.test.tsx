import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://design-system-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; },
  cancelAnimationFrame: () => {},
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { Button, CommandPalette, EmptyState, FilterBar, HoldButton, PageHeader, SegmentedControl, SelectMenu, SplitButton, StatusPill, reorderList } = await import("../src/design-system/index.ts");

let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await nextTurn();
    await nextTurn();
  });
}

async function mount(children: React.ReactNode) {
  dom.document.body.innerHTML = '<main id="ds-fixture"></main>';
  root = createRoot(dom.document.getElementById("ds-fixture")!);
  await flush(() => root!.render(children));
}

afterEach(async () => {
  await flush(() => root?.unmount());
  root = undefined;
});

after(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  dom.close();
});

test("Button renders semantic variant, size, icon-only attributes and triggers click", async () => {
  let clicks = 0;
  await mount(
    h(Button, { variant: "tinted", size: "sm", iconOnly: true, "aria-label": "操作", onClick: () => { clicks += 1; } }, "★"),
  );
  const btn = dom.document.querySelector<HTMLButtonElement>("button.bm-btn")!;
  assert.equal(btn.getAttribute("type"), "button");
  assert.equal(btn.dataset.variant, "tinted");
  assert.equal(btn.dataset.size, "sm");
  assert.equal(btn.dataset.iconOnly, "true");
  await flush(() => btn.click());
  assert.equal(clicks, 1);
});

test("SegmentedControl reflects active aria-pressed state and fires onChange", async () => {
  let selected: "zh" | "en" = "zh";
  await mount(
    h(SegmentedControl<"zh" | "en">, {
      value: selected,
      ariaLabel: "语言",
      options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }],
      onChange: (next) => { selected = next; },
    }),
  );
  const buttons = [...dom.document.querySelectorAll<HTMLButtonElement>(".bm-segmented-item")];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0]!.getAttribute("aria-pressed"), "true");
  assert.equal(buttons[1]!.getAttribute("aria-pressed"), "false");
  await flush(() => buttons[1]!.click());
  assert.equal(selected, "en");
});

test("SelectMenu supports grouped options, selection, and Escape dismissal", async () => {
  let value = "a";
  await mount(
    h(SelectMenu, {
      value,
      ariaLabel: "模板",
      groups: [
        { label: "官方", options: [{ value: "a", label: "经典正式" }] },
        { label: "社区", options: [{ value: "b", label: "现代极简" }] },
      ],
      onChange: (next) => { value = next; },
    }),
  );
  const trigger = dom.document.querySelector<HTMLButtonElement>(".bm-select-trigger")!;
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.match(trigger.textContent ?? "", /经典正式/);

  await flush(() => trigger.click());
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(dom.document.querySelectorAll('[role="group"]').length, 2);
  const options = [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  assert.equal(options.length, 2);
  await flush(() => options[1]!.click());
  assert.equal(value, "b");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  // Re-open and dismiss with Escape
  await flush(() => trigger.click());
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  await flush(() => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("SplitButton separates primary action from dropdown menu items", async () => {
  let primaryCalls = 0;
  let docxCalls = 0;
  await mount(
    h(SplitButton, {
      variant: "primary",
      size: "sm",
      primaryLabel: "导出",
      onPrimaryClick: () => { primaryCalls += 1; },
      menuLabel: "更多格式",
      menuHeading: "其他格式",
      items: [
        { id: "docx", label: "下载 DOCX", badge: ".docx", onSelect: () => { docxCalls += 1; } },
        { kind: "divider", id: "div" },
        { id: "disabled", label: "不可用", disabled: true, onSelect: () => {} },
      ],
    }),
  );

  const primary = dom.document.querySelector<HTMLButtonElement>(".bm-split-primary")!;
  const toggle = dom.document.querySelector<HTMLButtonElement>(".bm-split-toggle")!;
  await flush(() => primary.click());
  assert.equal(primaryCalls, 1);
  assert.equal(docxCalls, 0);

  await flush(() => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const menuItems = [...dom.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  assert.equal(menuItems.length, 2);
  assert.equal(menuItems[1]!.disabled, true);
  await flush(() => menuItems[0]!.click());
  assert.equal(docxCalls, 1);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("StatusPill renders semantic tone and indicator dot", async () => {
  await mount(h(StatusPill, { tone: "warn" }, "10 项待检查"));
  const pill = dom.document.querySelector<HTMLButtonElement>(".bm-status-pill")!;
  assert.equal(pill.dataset.tone, "warn");
  assert.ok(pill.querySelector(".bm-status-pill-dot"));
  assert.match(pill.textContent ?? "", /10 项待检查/);
});

test("reorderList moves items cleanly without mutating the source array", () => {
  const source = ["a", "b", "c", "d"];
  assert.deepEqual(reorderList(source, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderList(source, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderList(source, 1, 1), ["a", "b", "c", "d"]);
  assert.deepEqual(reorderList(source, -1, 2), ["a", "b", "c", "d"]);
  assert.deepEqual(source, ["a", "b", "c", "d"]);
});

test("CommandPalette filters items, runs active command on Enter, and closes on Escape", async () => {
  let ran = "";
  let closed = 0;
  await mount(
    h(CommandPalette, {
      open: true,
      onClose: () => { closed += 1; },
      placeholder: "搜索命令…",
      emptyLabel: "无匹配",
      ariaLabel: "命令面板",
      items: [
        { id: "save", group: "常用操作", label: "立即保存", keywords: "save", shortcutTokens: ["⌘", "S"], onSelect: () => { ran = "save"; } },
        { id: "ats", group: "版式快切", label: "切换极简 ATS", keywords: "ats plain", onSelect: () => { ran = "ats"; } },
      ],
    }),
  );

  const input = dom.document.querySelector<HTMLInputElement>(".bm-cmd-search input")!;
  assert.ok(input);
  assert.equal(dom.document.querySelectorAll('[role="option"]').length, 2);

  // Navigate to second item and press Enter
  await flush(() => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await flush(() => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(ran, "ats");
  assert.equal(closed, 1);

  // Escape closes
  await flush(() => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(closed, 2);
});

test("HoldButton cancels on early release and confirms only after holding for holdMs", async () => {
  let confirmed = 0;
  await mount(
    h(HoldButton, {
      holdMs: 60,
      holdingLabel: "继续按住…",
      onConfirm: () => { confirmed += 1; },
    }, "长按删除"),
  );

  const btn = dom.document.querySelector<HTMLButtonElement>(".bm-hold-btn")!;
  // Early release must cancel safely
  await flush(() => {
    btn.dispatchEvent(new dom.PointerEvent("pointerdown", { button: 0, bubbles: true }));
    btn.dispatchEvent(new dom.PointerEvent("pointerup", { button: 0, bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(confirmed, 0);

  // Holding past holdMs invokes onConfirm
  await flush(() => {
    btn.dispatchEvent(new dom.PointerEvent("pointerdown", { button: 0, bubbles: true }));
  });
  assert.equal(btn.dataset.holding, "true");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(confirmed, 1);
  assert.equal(btn.dataset.holding, undefined);
});

test("PageHeader, FilterBar, and EmptyState render semantic calm-craft skeleton hooks", async () => {
  let query = "React";
  await mount(
    h("div", null,
      h(PageHeader, {
        eyebrow: "WORKSPACE",
        title: "机会空间",
        description: "集中管理目标岗位与跟进计划",
        meta: h(StatusPill, { tone: "neutral" }, "3 个岗位"),
        actions: h(Button, { variant: "primary", size: "sm" }, "收藏岗位"),
      }),
      h(FilterBar, {
        ariaLabel: "筛选机会",
        search: {
          value: query,
          onChange: (next) => { query = next; },
          placeholder: "搜索公司或岗位",
          clearLabel: "清除搜索",
        },
        controls: h("select", { "aria-label": "阶段" }, h("option", { value: "all" }, "全部")),
      }),
      h(EmptyState, {
        compact: true,
        align: "start",
        title: "暂无岗位",
        description: "先收藏一个真实岗位",
        actions: h(Button, { variant: "secondary", size: "xs" }, "添加"),
      }),
    ),
  );

  assert.equal(dom.document.querySelector(".bm-page-header-title")?.textContent, "机会空间");
  assert.equal(dom.document.querySelector(".bm-page-header-eyebrow")?.textContent, "WORKSPACE");
  const clearBtn = dom.document.querySelector<HTMLButtonElement>(".bm-filter-search-clear")!;
  assert.ok(clearBtn);
  await flush(() => clearBtn.click());
  assert.equal(query, "");
  const empty = dom.document.querySelector<HTMLElement>(".bm-empty-state")!;
  assert.equal(empty.dataset.compact, "true");
  assert.equal(empty.dataset.align, "start");
  assert.equal(empty.querySelector(".bm-empty-title")?.textContent, "暂无岗位");
});
