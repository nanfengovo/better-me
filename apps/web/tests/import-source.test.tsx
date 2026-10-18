/** @jsxRuntime automatic */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoFactBase, createDefaultResumeView, projectResume, projectedResumeToMarkdown } from "@better-me/core";
import { exportDocumentJson, parseDocumentJson, getDocumentFieldChanges } from "@better-me/storage";
import { ImportSourceReview } from "../src/components/ImportSourceReview.js";

test("import evidence survives backup restoration without becoming public resume content", () => {
  const base = createDemoFactBase();
  const original = structuredClone(base);
  base.importSource = { fileName: "sample.pdf", importedAt: "2026-10-17T02:00:00.000Z", rawText: "完整原文\nSOURCE_ONLY <script>alert(1)</script>\n未知日期项目", ocrText: "OCR_ONLY 待核实模型转录", unparsedLines: ["未知日期项目"] };
  const view = createDefaultResumeView(base);
  const doc = { factBase: base, resumeViews: [view], activeResumeId: view.id };
  const restored = parseDocumentJson(exportDocumentJson(doc));
  assert.deepEqual(restored.factBase.importSource, base.importSource);
  assert.doesNotMatch(projectedResumeToMarkdown(projectResume(restored.factBase, view)), /SOURCE_ONLY|OCR_ONLY|未知日期项目/);
  const markup = renderToStaticMarkup(<ImportSourceReview source={restored.factBase.importSource} />);
  assert.match(markup, /1 段待核对/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /不进入对外简历/);
  assert.match(markup, /视觉模型转录（未核实，请对照原图）/);
  assert.match(markup, /OCR_ONLY/);
  const changes = getDocumentFieldChanges({ ...doc, factBase: original }, restored);
  assert.ok(changes.some((change) => change.label === "导入原文" && change.after === base.importSource!.rawText));
  assert.ok(changes.some((change) => change.label === "导入待补录原文"));
  assert.ok(changes.some((change) => change.label === "导入视觉转录（未核实）" && change.after === base.importSource!.ocrText));
});

test("legacy documents without import evidence remain valid and render no evidence panel", () => {
  const base = createDemoFactBase();
  const view = createDefaultResumeView(base);
  const restored = parseDocumentJson(exportDocumentJson({ factBase: base, resumeViews: [view], activeResumeId: view.id }));
  assert.equal(restored.factBase.importSource, undefined);
  assert.equal(renderToStaticMarkup(<ImportSourceReview />), "");
});
