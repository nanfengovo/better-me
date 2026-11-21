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
const { Button, SegmentedControl, SelectMenu, SplitButton, StatusPill, reorderList } = await import("../src/design-system/index.ts");

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
