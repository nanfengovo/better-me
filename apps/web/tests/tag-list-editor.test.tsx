import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://tag-list-editor-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { TagListEditor } = await import("../src/components/TagListEditor.tsx");

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

test("TagListEditor renders existing tags and deletes a tag", async () => {
  let updatedTags: string[] = ["React", "TypeScript", "Node.js"];
  await mount(
    h(TagListEditor, {
      tags: updatedTags,
      onChange: (next) => {
        updatedTags = next;
      },
      addLabel: "+ 标签",
    }),
  );

  const tags = dom.document.body.textContent;
  assert.ok(tags?.includes("React"), "should contain React");
  assert.ok(tags?.includes("TypeScript"), "should contain TypeScript");
  assert.ok(tags?.includes("Node.js"), "should contain Node.js");

  // Click delete on TypeScript
  const deleteBtn = dom.document.querySelector('button[aria-label="删除标签 TypeScript"]') as HTMLButtonElement;
  assert.ok(deleteBtn, "delete button should exist");
  await flush(() => deleteBtn.click());

  assert.deepEqual(updatedTags, ["React", "Node.js"]);
});

function typeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }));
}

test("TagListEditor opens inline input and adds a new tag on Enter", async () => {
  let tags: string[] = ["Python"];
  await mount(
    h(TagListEditor, {
      tags,
      onChange: (next) => {
        tags = next;
      },
      addLabel: "+ 标签",
    }),
  );

  const addBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.includes("标签"));
  assert.ok(addBtn, "add button should exist");
  await flush(() => addBtn.click());

  const input = dom.document.querySelector('input[aria-label="新标签名称"]') as HTMLInputElement;
  assert.ok(input, "inline input should be displayed");

  // Simulate typing "Go" and pressing Enter
  await flush(() => {
    typeInput(input, "Go");
  });
  await flush(() => {
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.deepEqual(tags, ["Python", "Go"]);
});

test("TagListEditor supports comma-separated multiple tags", async () => {
  let tags: string[] = [];
  await mount(
    h(TagListEditor, {
      tags,
      onChange: (next) => {
        tags = next;
      },
      addLabel: "+ 标签",
    }),
  );

  const addBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.includes("标签"));
  assert.ok(addBtn, "add button should exist");
  await flush(() => addBtn.click());

  const input = dom.document.querySelector('input[aria-label="新标签名称"]') as HTMLInputElement;
  await flush(() => {
    typeInput(input, "Docker, K8s, Redis");
  });
  await flush(() => {
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.deepEqual(tags, ["Docker", "K8s", "Redis"]);
});

test("TagListEditor supports inline editing an existing tag", async () => {
  let tags: string[] = ["Typscript"];
  await mount(
    h(TagListEditor, {
      tags,
      onChange: (next) => {
        tags = next;
      },
      addLabel: "+ 标签",
    }),
  );

  const tagSpan = [...dom.document.querySelectorAll("span")].find((s) => s.textContent === "Typscript");
  assert.ok(tagSpan, "tag span should exist");
  await flush(() => tagSpan.click());

  const editInput = dom.document.querySelector('input[aria-label="编辑标签 Typscript"]') as HTMLInputElement;
  assert.ok(editInput, "edit input should be present");

  await flush(() => {
    typeInput(editInput, "TypeScript");
  });
  await flush(() => {
    editInput.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.deepEqual(tags, ["TypeScript"]);
});
