import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { quoteWritingText, resolveWritingQuote, writingTextRange } from "../src/lib/writing-anchor";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInitialDocument } from "@better-me/storage";
import { projectResume } from "@better-me/core";
import { RESUME_TEMPLATES, ResumeTemplate } from "../src/components/ResumeTemplate";

test("selection reanchors after edits outside the quote, not changes to the quote", () => {
  const text = "背景：负责接口开发，参与系统维护。";
  const quote = quoteWritingText(text, 3, 9)!;
  assert.equal(quote.exact, "负责接口开发");
  assert.equal(resolveWritingQuote(`新增背景。${text}`, quote)?.start, 8);
  assert.equal(resolveWritingQuote(text.replace("接口开发", "设备调试"), quote), undefined);
  assert.equal(quoteWritingText(text, 3, 3), undefined);
});
test("ambiguous duplicate text is never anchored by a stale numeric position", () => {
  const quote = { exact: "维护系统", prefix: "", suffix: "", start: 0, end: 4 };
  assert.equal(resolveWritingQuote("维护系统；维护系统", quote), undefined);
  assert.equal(resolveWritingQuote("甲：维护系统。乙：维护系统！", { ...quote, prefix: "乙：", suffix: "！" })?.start, 9);
});
test("DOM quote range spans formatting nodes without changing printable content", () => {
  const dom = new Window();
  const element = dom.document.createElement("p");
  element.innerHTML = "背景：<strong>负责接口</strong><em>开发</em>，参与维护。";
  const range = writingTextRange(element as unknown as HTMLElement, 3, 9)!;
  assert.equal(range.toString(), "负责接口开发");
  assert.equal(element.innerHTML, "背景：<strong>负责接口</strong><em>开发</em>，参与维护。");
  dom.happyDOM.abort();
});
test("every installed template preserves exact long and formatted quote anchors in both languages", () => {
  const doc = createInitialDocument();
  const claim = doc.factBase.experiences[0]!.claims[0]!;
  claim.text = { zh: "背景。负责接口开发，参与系统维护。".repeat(90), en: "Context. Responsible for API development and system maintenance. ".repeat(90) };
  const view = doc.resumeViews[0]!;
  view.textStyles = { [`claim:${claim.id}:zh`]: [{ start: 3, end: 9, bold: true }] };
  const dom = new Window(), host = dom.document.createElement("div");
  for (const locale of ["zh", "en"] as const) for (const template of RESUME_TEMPLATES) {
    const resume = projectResume(doc.factBase, { ...view, locale, templateId: template.id });
    host.innerHTML = renderToStaticMarkup(createElement(ResumeTemplate, { resume, templateId: template.id }));
    const matches = [...host.querySelectorAll<HTMLElement>("[data-preview-anchor]")].filter(el => el.dataset.previewAnchor === `claim:${claim.id}`);
    assert.equal(matches.length, 1, `${template.id}/${locale}: one stable anchor`);
    assert.equal(matches[0]!.textContent, claim.text[locale], `${template.id}/${locale}: exact source`);
    const range = writingTextRange(matches[0] as unknown as HTMLElement, 3, 9)!;
    assert.equal(range.toString(), claim.text[locale]!.slice(3, 9));
    assert.equal(host.querySelector(".writing-note, .writing-overlay"), null);
  }
  dom.happyDOM.abort();
});
