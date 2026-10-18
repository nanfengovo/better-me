import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFactBase } from "@better-me/core";
import { parseResumeImportJson } from "../src/lib/resume-import-json.js";

test("a review download can be reopened with complete source and pending text intact", () => {
  const factBase = createDemoFactBase();
  factBase.importSource = {
    fileName: "anonymous.pdf", importedAt: "2026-01-01T00:00:00.000Z",
    rawText: "完整匿名正文\n缺日期项目", ocrText: "匿名图片转录", unparsedLines: ["缺日期项目"],
  };
  const review = JSON.stringify({ factBase, unparsedLines: ["缺日期项目"], warnings: ["请逐项核对"] });
  const reopened = parseResumeImportJson(review, "review.json");
  assert.deepEqual(reopened.factBase, factBase);
  assert.deepEqual(reopened.warnings, ["请逐项核对"]);
});

test("legacy review diagnostics remain review evidence without pretending to contain the missing complete source", () => {
  const factBase = createDemoFactBase();
  const reopened = parseResumeImportJson(JSON.stringify({ factBase, unparsedLines: ["匿名未解析原文", "匿名未解析原文"], warnings: ["旧警告"] }), "legacy-review.json", "2026-01-02T00:00:00.000Z");
  assert.deepEqual(reopened.factBase.importSource, {
    fileName: "legacy-review.json", importedAt: "2026-01-02T00:00:00.000Z", rawText: "", unparsedLines: ["匿名未解析原文", "匿名未解析原文"],
  });
  assert.ok(reopened.warnings.some((warning) => warning.includes("未包含完整提取原文")));
  assert.equal(reopened.warnings[0], "旧警告");
});

test("standalone facts and full backups remain compatible, while malformed review metadata is rejected", () => {
  const factBase = createDemoFactBase();
  assert.deepEqual(parseResumeImportJson(JSON.stringify(factBase), "facts.json").factBase, factBase);
  assert.deepEqual(parseResumeImportJson(JSON.stringify({ factBase, resumeViews: [] }), "backup.json").factBase, factBase);
  for (const field of [{ unparsedLines: "lost array" }, { unparsedLines: [1] }, { warnings: [false] }, { rawText: 1 }, { ocrText: {} }]) {
    assert.throws(() => parseResumeImportJson(JSON.stringify({ factBase, ...field }), "invalid.json"), /必须是字符串/);
  }
});
