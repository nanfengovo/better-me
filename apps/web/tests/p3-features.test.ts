import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultResumeView, createDemoFactBase } from "@better-me/core";
import {
  buildSkillEvidenceGraph,
  toggleClaimInResumeView,
  toggleExperienceInResumeView,
} from "../src/lib/skill-evidence-graph.ts";
import { applyInlineWritingAction, BULLET_SCAFFOLDS } from "../src/lib/inline-writing-actions.ts";
import { exportInteractivePortfolioHtml } from "../src/lib/interactive-portfolio-export.ts";

test("buildSkillEvidenceGraph links skills to experiences/claims and toggles inclusion cleanly", () => {
  const factBase = createDemoFactBase();
  const view = createDefaultResumeView(factBase);
  const graph = buildSkillEvidenceGraph(factBase, view, "zh");

  assert.ok(graph.skills.length > 0);
  assert.ok(graph.totalClaims > 0);
  assert.equal(graph.includedClaims, graph.totalClaims);

  const firstExp = factBase.experiences[0]!;
  const firstClaim = firstExp.claims[0]!;

  // Toggle single claim off
  const withoutClaim = toggleClaimInResumeView(factBase, view, firstExp.id, firstClaim.id);
  const afterClaimOff = buildSkillEvidenceGraph(factBase, withoutClaim, "zh");
  assert.equal(afterClaimOff.includedClaims, graph.totalClaims - 1);

  // Toggle claim back on restores full count
  const restoredClaim = toggleClaimInResumeView(factBase, withoutClaim, firstExp.id, firstClaim.id);
  const afterClaimOn = buildSkillEvidenceGraph(factBase, restoredClaim, "zh");
  assert.equal(afterClaimOn.includedClaims, graph.totalClaims);

  // Toggle whole experience off
  const withoutExp = toggleExperienceInResumeView(factBase, view, firstExp.id);
  const afterExpOff = buildSkillEvidenceGraph(factBase, withoutExp, "zh");
  assert.equal(afterExpOff.includedClaims, graph.totalClaims - firstExp.claims.length);
});

test("applyInlineWritingAction sharpens weak verbs and adds [X] placeholders without fabricating numbers", () => {
  const zhText = "负责订单系统性能优化";
  const sharpenedZh = applyInlineWritingAction(zhText, 0, zhText.length, "sharpen_verb", "zh");
  assert.equal(sharpenedZh.changed, true);
  assert.equal(sharpenedZh.nextText, "主导实现订单系统性能优化");

  const withMetric = applyInlineWritingAction(sharpenedZh.nextText, 0, sharpenedZh.nextText.length, "metric_placeholder", "zh");
  assert.equal(withMetric.changed, true);
  assert.ok(withMetric.nextText.includes("[基线X]"));
  assert.ok(withMetric.nextText.includes("[结果Y]"));
  assert.equal(/\d/.test(withMetric.nextText), false);

  const enText = "Responsible for API caching";
  const sharpenedEn = applyInlineWritingAction(enText, 0, enText.length, "sharpen_verb", "en");
  assert.equal(sharpenedEn.nextText, "Owned and delivered API caching");

  // All scaffolds must stay zero-fabrication (no concrete digits)
  for (const scaffold of BULLET_SCAFFOLDS) {
    assert.equal(/\d/.test(scaffold.zhTemplate), false);
    assert.equal(/\d/.test(scaffold.enTemplate), false);
  }
});

test("exportInteractivePortfolioHtml builds self-contained dual-mode HTML, redacts contact PII, and withholds unverified metrics", () => {
  const factBase = createDemoFactBase();
  factBase.profile.email = "secret.user@example.invalid";
  factBase.profile.phone = "13911112222";
  factBase.experiences[0]!.claims[0]!.metric = { value: 777, unit: "%", confirmed: false };
  const view = createDefaultResumeView(factBase);

  const html = exportInteractivePortfolioHtml({ factBase, view, locale: "zh" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('id="btn-explorer"'));
  assert.ok(html.includes('id="btn-classic"'));
  assert.ok(html.includes('id="btn-motion"'));
  assert.equal(html.includes("secret.user@example.invalid"), false);
  assert.equal(html.includes("13911112222"), false);
  assert.equal(html.includes("777%"), false);
  // Zero external CDN script or font links
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/fonts\.googleapis\.com/i.test(html), false);
});
