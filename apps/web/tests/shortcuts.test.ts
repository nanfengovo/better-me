import assert from "node:assert/strict";
import test from "node:test";
import {
  eventToShortcutSpec,
  findShortcutConflict,
  formatShortcut,
  getDefaultShortcuts,
  matchesShortcut,
  parseShortcut,
} from "../src/lib/shortcuts.ts";
import { UndoStack } from "../src/lib/useDocumentUndo.ts";

test("parseShortcut and formatShortcut handle Mac and Windows/Linux conventions", () => {
  const parsed = parseShortcut("mod+shift+z");
  assert.deepEqual(parsed, { mod: true, ctrl: false, meta: false, alt: false, shift: true, key: "z" });
  assert.equal(formatShortcut("mod+shift+z", true), "⇧ ⌘ Z");
  assert.equal(formatShortcut("mod+shift+z", false), "Ctrl + Shift + Z");
  assert.equal(formatShortcut("mod+,", true), "⌘ ,");
  assert.equal(formatShortcut("alt+1", true), "⌥ 1");
});

test("matchesShortcut uses physical key code so Option/Alt characters still match on macOS", () => {
  const macAlt1 = { key: "¡", code: "Digit1", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false };
  assert.equal(matchesShortcut(macAlt1, "alt+1", true), true);

  const macUndo = { key: "z", code: "KeyZ", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false };
  assert.equal(matchesShortcut(macUndo, "mod+z", true), true);
  assert.equal(matchesShortcut(macUndo, "mod+shift+z", true), false);

  const winUndo = { key: "z", code: "KeyZ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(matchesShortcut(winUndo, "mod+z", false), true);
  assert.equal(matchesShortcut(winUndo, "mod+z", true), false);
});

test("eventToShortcutSpec rejects bare keys and modifier-only events", () => {
  assert.equal(eventToShortcutSpec({ key: "a", code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, true), null);
  assert.equal(eventToShortcutSpec({ key: "Meta", code: "MetaLeft", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, true), null);
  assert.equal(eventToShortcutSpec({ key: "k", code: "KeyK", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, true), "mod+k");
  assert.equal(eventToShortcutSpec({ key: "s", code: "KeyS", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, false), "mod+shift+s");
});

test("findShortcutConflict detects duplicate bindings across different actions", () => {
  const defaults = getDefaultShortcuts();
  assert.equal(findShortcutConflict(defaults, "findJobs", "mod+s"), "save");
  assert.equal(findShortcutConflict(defaults, "save", "mod+s"), null);
  assert.equal(findShortcutConflict(defaults, "findJobs", "mod+p"), null);
});

test("UndoStack coalesces rapid edits, supports undo/redo, and clears future on new edit", () => {
  const stack = new UndoStack<{ text: string }>(3, 400);
  stack.record({ text: "v0" }, 1000);
  // Rapid edit within 400ms coalesces into same undo point
  stack.record({ text: "v1" }, 1150);
  assert.equal(stack.canUndo, true);
  assert.equal(stack.canRedo, false);

  const undone = stack.undo({ text: "v2" });
  assert.deepEqual(undone, { text: "v0" });
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, true);

  const redone = stack.redo({ text: "v0" });
  assert.deepEqual(redone, { text: "v2" });

  // New discrete edits respect maxSize and drop redo history
  stack.record({ text: "v2" }, 2000);
  stack.record({ text: "v3" }, 3000);
  stack.record({ text: "v4" }, 4000);
  assert.deepEqual(stack.undo({ text: "v5" }), { text: "v4" });
  stack.record({ text: "v4" }, 5000);
  assert.equal(stack.canRedo, false);
});
