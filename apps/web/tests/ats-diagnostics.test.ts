import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_ATS_SAMPLE, diagnoseAtsResume } from "../src/lib/ats-diagnostics.ts";

test("diagnoseAtsResume returns empty state cleanly when input is blank", () => {
  const report = diagnoseAtsResume({ resumeText: "   " });
  assert.equal(report.overallScore, 0);
  assert.equal(report.dimensions.length, 0);
  assert.equal(report.findings.length, 0);
});

test("diagnoseAtsResume evaluates bilingual demo resume against JD with matched and missing keywords", () => {
  const report = diagnoseAtsResume(DEMO_ATS_SAMPLE.zh);
  assert.ok(report.overallScore >= 70 && report.overallScore <= 100);
  assert.equal(report.dimensions.length, 6);
  assert.ok(report.matchedKeywords.includes("TypeScript"));
  assert.ok(report.matchedKeywords.includes("PostgreSQL"));
  assert.ok(report.missingKeywords.includes("Kubernetes"));
  assert.ok(report.quantifiedBulletCount >= 4);
  // Demo intentionally contains one weak Chinese opener ("负责日常...") to demonstrate writing feedback
  assert.ok(report.findings.some((f) => f.id === "writing-weak-openers"));
});

test("diagnoseAtsResume catches mixed date formats, AI clichés, first-person pronouns, and embedded base64 images", () => {
  const messy = `
Alex Demo | alex@example.com
![avatar](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)

Experience
Company A (2023-05 - Present)
- Responsible for leveraging cutting-edge synergy on my backend service.
Company B (Jan 2021 - 2023.04)
- Worked on building I pipelines with no numbers at all.
`;
  const report = diagnoseAtsResume({ resumeText: messy });
  assert.ok(report.findings.some((f) => f.id === "parse-image" && f.severity === "critical"));
  assert.ok(report.findings.some((f) => f.id === "dates-mixed"));
  assert.ok(report.findings.some((f) => f.id === "writing-weak-openers"));
  assert.ok(report.findings.some((f) => f.id === "writing-buzzwords"));
  assert.ok(report.findings.some((f) => f.id === "writing-first-person"));
  assert.ok(report.dateFormatsFound.length >= 2);
});
