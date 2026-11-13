import { FactBaseSchema } from "../../packages/core/src/schema/fact.js";
import { ResumeViewSchema } from "../../packages/core/src/schema/resume.js";
import { qualityHash, ResumeQualityCaseSchema, type ResumeQualityFactRun, type ResumeQualityCase } from "../../packages/core/src/career-intelligence/resume-quality.js";

/** Authored regression only. Never counted as a real Gold case. */
export async function syntheticQualityFixture() {
  const text = "For checkout latency, implemented Redis caching for request serving, enabling stable responses.";
  const job = "Backend: Redis caching.\nCloud: Kubernetes.";
  const provenance = { url: "https://example.invalid/synthetic", revision: "synthetic-v1", license: "repository-authored synthetic fixture", licenseUrl: "https://example.invalid/synthetic-license",
    retrievedAt: "2026-11-12T00:00:00.000Z", originalSha256: await qualityHash(text), anonymization: "No real person, employer or job." };
  const test: ResumeQualityCase = ResumeQualityCaseSchema.parse({ schemaVersion: 1, id: "synthetic-caching", dataKind: "synthetic_protocol", role: "Synthetic backend",
    job: { text: job, sha256: await qualityHash(job), provenance },
    evidence: [{ id: "source-1", text, sha256: await qualityHash(text), provenance,
      star: { situation: ["checkout latency"], task: ["request serving"], action: ["implemented Redis caching"], result: ["enabling stable responses"] } }],
    requirements: [{ id: "cache", original: { start: 0, end: 23, quote: job.slice(0, 23) }, weight: 2, anchorGroups: [["Redis"], ["caching"]], evidenceIds: ["source-1"] },
      { id: "cloud", original: { start: 24, end: job.length, quote: job.slice(24) }, weight: 1, anchorGroups: [["Kubernetes"]], evidenceIds: [] }],
    entityLexicon: ["Redis", "Kubernetes", "Kafka"], approvedParaphrases: [] });
  const now = "2026-11-12T00:00:00.000Z";
  const factBase = FactBaseSchema.parse({ schemaVersion: 1, updatedAt: now, profile: { displayName: { zh: "Synthetic candidate", en: "Synthetic candidate" } },
    experiences: [{ id: "work-1", type: "work", org: { zh: "SyntheticOrg" }, title: { zh: "Engineer" }, start: "2020-01", end: "2024-01",
      claims: [{ id: "claim-1", kind: "action", text: { zh: text, en: text } }] }] });
  const view = ResumeViewSchema.parse({ id: "quality-fixture", name: "Synthetic only", locale: "en", templateId: "zh-classic", updatedAt: now, layout: { pageMargin: 16 } });
  const run: ResumeQualityFactRun = { schemaVersion: 1, caseId: test.id, caseSha256: await qualityHash(JSON.stringify(test)),
    origin: { kind: "human_baseline", label: "Authored synthetic regression, not a model" },
    model: { provider: "synthetic", id: "extractive-fixture", revision: "v1", runtimeId: "synthetic-only" }, protocolVersion: "quality-v1",
    budget: { maxModelCalls: 0, maxToolCalls: 0, maxActiveMs: 0 }, observed: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, factBase, view, locale: "en",
    citations: [{ claimId: "claim-1", evidenceId: "source-1", sourceSha256: test.evidence[0]!.sha256, original: { start: 0, end: text.length, quote: text } }] };
  return { test, run, text };
}
