import { z } from "zod";
import { EntityIdSchema, HttpUrlSchema, RevisionSchema, TimestampSchema } from "@better-me/opportunities";
import { SourceJobRecordSchema } from "./contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const target = { jobId: EntityIdSchema, listingId: EntityIdSchema, expectedRevision: RevisionSchema };
/** Exact existing listing only. The host, never a caller-supplied URL, selects its source endpoint. */
export const ReadOwnedDetailLocationsInputSchema = z.object(target).strict();
export type ReadOwnedDetailLocationsInput = z.infer<typeof ReadOwnedDetailLocationsInputSchema>;
/** The proof authenticates a transient host read, not the employer or the office coordinates. */
export const OwnedDetailLocationsCaptureSchema = z.object({
  schemaVersion: z.literal(1), jobId: EntityIdSchema, listingId: EntityIdSchema, sourceId: EntityIdSchema,
  sourceFingerprint: hash, sourceRecordId: z.string().min(1).max(1000), url: HttpUrlSchema,
  observedAt: TimestampSchema, readSessionId: z.string().regex(/^[a-f0-9]{32}$/),
  readSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), record: SourceJobRecordSchema, proof: hash,
}).strict().superRefine((value, context) => {
  if (value.record.entityType !== "job-posting" || value.record.sourceRecordId !== value.sourceRecordId || value.record.url !== value.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["record"], message: "A capture must contain the exact requested listing record and URL." });
  }
});
export type OwnedDetailLocationsCapture = z.infer<typeof OwnedDetailLocationsCaptureSchema>;
export const PreviewOwnedDetailLocationsInputSchema = z.object({ ...target, capture: OwnedDetailLocationsCaptureSchema }).strict()
  .superRefine((value, context) => {
    if (value.jobId !== value.capture.jobId || value.listingId !== value.capture.listingId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["capture"], message: "The read capture belongs to another job or listing." });
    }
  });
export type PreviewOwnedDetailLocationsInput = z.infer<typeof PreviewOwnedDetailLocationsInputSchema>;
export const ImportOwnedDetailLocationsInputSchema = z.object({ ...target, capture: OwnedDetailLocationsCaptureSchema,
  previewFingerprint: hash, reviewed: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.jobId !== value.capture.jobId || value.listingId !== value.capture.listingId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capture"], message: "The read capture belongs to another job or listing." });
  }
});
export type ImportOwnedDetailLocationsInput = z.infer<typeof ImportOwnedDetailLocationsInputSchema>;
