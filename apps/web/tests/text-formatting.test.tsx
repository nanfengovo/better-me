import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSelection, rebaseTextStyles } from "../src/lib/text-formatting";

test("selection styles preserve adjacent runs and can clear a middle range", () => {
  const first = formatSelection("abcdefghij", [], 0, 10, { bold: true });
  const marked = formatSelection("abcdefghij", first, 3, 6, { highlight: true });
  assert.deepEqual(marked, [{ start: 0, end: 3, bold: true }, { start: 3, end: 6, bold: true, highlight: true }, { start: 6, end: 10, bold: true }]);
  assert.deepEqual(formatSelection("abcdefghij", marked, 4, 5, "clear"), [{ start: 0, end: 3, bold: true }, { start: 3, end: 4, bold: true, highlight: true }, { start: 5, end: 6, bold: true, highlight: true }, { start: 6, end: 10, bold: true }]);
});
test("toggling off one attribute retains the other selected formatting", () => {
  assert.deepEqual(formatSelection("hello", [{ start: 0, end: 5, bold: true, highlight: true }], 0, 5, { bold: false }), [{ start: 0, end: 5, highlight: true }]);
});
test("typing before a marked word shifts ranges without styling new characters", () => {
  assert.deepEqual(rebaseTextStyles("hello world", "hello new world", [{ start: 6, end: 11, bold: true }]), [{ start: 10, end: 15, bold: true }]);
});
test("replacing part of styled text keeps only surviving original text", () => {
  assert.deepEqual(rebaseTextStyles("abcdef", "abXYef", [{ start: 0, end: 6, highlight: true }]), [{ start: 0, end: 2, highlight: true }, { start: 4, end: 6, highlight: true }]);
});
