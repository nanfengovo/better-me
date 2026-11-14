import { z } from "zod";
import hash from "hash.js";
import { LearningHash, LearningId } from "./learning-path.js";

export const TRANSLATION_LIMITS = Object.freeze({
  jobs: 24,
  calls: 32,
  activeMs: 600_000,
  inputBytes: 64_000,
  outputBytes: 32_000,
  artifactBytes: 8 * 1024 * 1024,
  libraryBytes: 128 * 1024 * 1024,
  pages: 10,
});
export const TranslationModelSchema = z
  .object({ name: z.string().min(1).max(200), digest: LearningHash })
  .strict();
export const PDF_CLOUD_BACKEND = "pdf2zh-deepseek-v1" as const;
export const PDF_CLOUD_ORIGIN = "https://api.deepseek.com" as const;
export const PDF_CLOUD_LIMIT = 12;
export const PdfCloudModelName = z.enum(["deepseek-v4-pro", "deepseek-flash"]);
export function pdfCloudModel(name: z.infer<typeof PdfCloudModelName>) {
  // A fingerprint of the requested provider route, NOT a remote weight digest.
  return { name, digest: hash.sha256().update(JSON.stringify([PDF_CLOUD_BACKEND, PDF_CLOUD_ORIGIN, "/chat/completions", name])).digest("hex") };
}
const cloudGrant = z.object({
  recipientOrigin: z.literal(PDF_CLOUD_ORIGIN), model: PdfCloudModelName, materialHash: LearningHash,
  scope: z.literal("document_text_and_glossary"), maxCalls:z.number().int().min(1).max(PDF_CLOUD_LIMIT),
}).strict();
export const TranslationBackendSchema = z
  .object({
    id: LearningId,
    engine: z.string().min(1).max(120),
    ready: z.boolean(),
    reason: z.string().max(300).optional(),
    simulation: z.boolean(),
    location: z.enum(["local","cloud"]),
    recipientOrigin: z.literal(PDF_CLOUD_ORIGIN).optional(),
    models: z.array(TranslationModelSchema).max(20),
  })
  .strict().refine(b => b.location === "cloud" ? b.id === PDF_CLOUD_BACKEND && b.recipientOrigin === PDF_CLOUD_ORIGIN
    : b.id !== PDF_CLOUD_BACKEND && b.recipientOrigin === undefined, "translation_recipient_mismatch");
export type TranslationBackend = z.infer<typeof TranslationBackendSchema>;
export const TranslationCreateSchema = z
  .object({
    requestId: LearningId,
    consent: z.literal(true),
    materialId: LearningId,
    materialHash: LearningHash,
    materialRevision: z.number().int().positive(),
    backendId: LearningId,
    model: TranslationModelSchema,
    cloudGrant: cloudGrant.optional(),
    sourceLanguage: z.literal("zh"),
    targetLanguage: z.literal("en"),
    bilingual: z.boolean(),
    glossary: z
      .array(
        z
          .object({
            source: z.string().trim().min(1).max(100),
            target: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(32),
  })
  .strict().refine(r => r.backendId === PDF_CLOUD_BACKEND
    ? !!r.cloudGrant && r.cloudGrant.model === r.model.name && r.cloudGrant.materialHash === r.materialHash &&
      r.model.digest === pdfCloudModel(r.cloudGrant.model).digest : r.cloudGrant === undefined, "translation_cloud_grant_required");
export type TranslationCreate = z.infer<typeof TranslationCreateSchema>;
export const TranslationCheckIds = [
  "pages",
  "numbers_units",
  "negations",
  "formulas",
  "reading_order",
  "overflow",
] as const;
export const TranslationChecksSchema = z
  .object({
    pages: z.enum(["pass", "fail", "not_applicable"]),
    numbers_units: z.enum(["pass", "fail", "not_applicable"]),
    negations: z.enum(["pass", "fail", "not_applicable"]),
    formulas: z.enum(["pass", "fail", "not_applicable"]),
    reading_order: z.enum(["pass", "fail", "not_applicable"]),
    overflow: z.enum(["pass", "fail", "not_applicable"]),
  })
  .strict();
export const TranslationReviewSchema = z
  .object({
    requestId: LearningId,
    consent: z.literal(true),
    decision: z.enum(["accept", "reject"]),
    checks: TranslationChecksSchema,
    terminology: z.enum(["pass","fail","not_applicable"]).optional(), // legacy/local reviews have six checks
    renderedPagesReviewed: z.literal(true),
    extractedTextReviewed: z.literal(true),
    notes: z.string().trim().min(1).max(4000),
  })
  .strict();
export const TranslationArtifactSchema = z
  .object({
    kind: z.enum(["mono", "dual"]),
    hash: LearningHash,
    bytes: z.number().int().positive().max(TRANSLATION_LIMITS.artifactBytes),
    pages: z
      .number()
      .int()
      .min(1)
      .max(TRANSLATION_LIMITS.pages * 2),
    emptyTextPages: z.array(z.number().int().min(1).max(20)).max(20),
  })
  .strict();
export type TranslationArtifact = z.infer<typeof TranslationArtifactSchema>;
export const TranslationJobSchema = z
  .object({
    id: z.string().regex(/^lt_[a-f0-9]{32}$/),
    ownerId: LearningId,
    request: TranslationCreateSchema,
    backend: TranslationBackendSchema,
    materialName: z.string().min(1).max(180),
    sourcePages: z.number().int().min(1).max(10),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    state: z.enum([
      "queued",
      "running",
      "review_required",
      "accepted",
      "rejected",
      "failed",
      "cancelled",
      "interrupted",
      "source_revoked",
    ]),
    stage: z.enum([
      "prepared",
      "parsing",
      "translating",
      "typesetting",
      "checking",
      "finished",
      "stopped",
    ]),
    progress: z.number().int().min(0).max(100).nullable(),
    usage: z
      .object({
        modelCalls: z.number().int().min(0).max(32),
        inputBytes: z.number().int().nonnegative(),
        outputBytes: z.number().int().nonnegative(),
      })
      .strict(),
    artifacts: z.array(TranslationArtifactSchema).max(2),
    issue: z.string().max(100).optional(),
    review: TranslationReviewSchema.extend({
      reviewedAt: z.string().datetime(),
    }).optional(),
  })
  .strict();
export type TranslationJob = z.infer<typeof TranslationJobSchema>;
