import assert from "node:assert/strict";
import test from "node:test";
import { translationPrompt, validateTranslationCompletion } from "../src/growth/pdf2zh-completion.js";

const messages = [{ role: "user" as const, content: `Translate into English.\nContext title: 工具回执与断点恢复\n## Here is the input:\n\n${JSON.stringify([
  { id: 0, input: "已有回执:先读取,再继续", layout_label: "title" },
  { id: 1, input: "总步骤 {v1}已保存步骤 {v2}后续验证步骤。", layout_label: "plain text" },
])}` }];
const valid = JSON.stringify([{ id: 0, output: "Existing receipt: read first, then continue" },
  { id: 1, output: "Total steps {v1}saved steps {v2}subsequent verification steps." }]);

test("native single-string transport preserves readable converter instructions instead of JSON-escaping them", () => {
  const prompt = translationPrompt(messages);
  assert.ok(prompt.includes(messages[0]!.content));
  assert.ok(!prompt.includes('\\nContext title:'));
  assert.match(prompt, /contextual hints/i);
});

test("real fixture's missing second formula placeholder, duplicate ids, moved markers and altered structure fail closed", () => {
  assert.equal(validateTranslationCompletion(messages, valid), valid);
  const missing = JSON.stringify([{ id: 0, output: "Tool Receipt and Breakpoint Recovery" },
    { id: 1, output: "Total steps {v1} have been saved, subsequent verification steps." }]);
  for (const invalid of [missing, valid.replace("{v2}", "{v1}"), valid.replace('"id":1', '"id":0'),
    valid.replace('"id":1', '"id":2'), valid.replace('"output":', '"input":'), "```json\n" + valid + "\n```",
    JSON.stringify([{ id: 0, output: "Existing receipt {v2}" }, { id: 1, output: "Total steps {v1}saved steps" }])]) {
    assert.throws(() => validateTranslationCompletion(messages, invalid), /^Error: translation_completion_structure$/);
  }
});

test("single text health checks remain supported and empty replies are refused", () => {
  const health = [{ role: "user" as const, content: "Translate Hello into English." }];
  assert.equal(validateTranslationCompletion(health, "Hello"), "Hello");
  assert.throws(() => validateTranslationCompletion(health, "  "));
});
