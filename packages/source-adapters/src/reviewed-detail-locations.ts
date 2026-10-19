import { z } from "zod";
import { EntityIdSchema, JobLocationSchema, RevisionSchema } from "@better-me/opportunities";
import { PlatformDetailLocationsSchema } from "./platform-detail-locations.js";

const command = {
  jobId: EntityIdSchema, listingId: EntityIdSchema, expectedRevision: RevisionSchema,
  capture: PlatformDetailLocationsSchema.refine(capture => capture.locations.length > 0, "No address disclosure is not evidence that a previous location was removed."),
};
/** Address evidence supplements one existing platform listing; it never imports a JD or a new job. */
export const PreviewDetailLocationsInputSchema = z.object(command).strict();
export type PreviewDetailLocationsInput = z.infer<typeof PreviewDetailLocationsInputSchema>;
export const ImportDetailLocationsInputSchema = z.object({ ...command,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true),
}).strict();
export type ImportDetailLocationsInput = z.infer<typeof ImportDetailLocationsInputSchema>;
const sourceLocation = JobLocationSchema.refine(location => (location.kind === "office" || location.kind === "remote-region")
  && location.verification === "unverified" && location.evidence.length > 0 && !location.coordinates && !location.originalCoordinates
  && !location.officeResolution && !location.userResolution && !location.provider && !location.resolvedAt
  && location.precision === (location.city ? "city" : location.region ? "region" : location.countryCode ? "country" : "unknown"),
"A detail disclosure is unverified source text, never an address point or a local decision.");
export const DetailLocationsPreviewSchema = z.object({
  jobId: EntityIdSchema, listingId: EntityIdSchema, sourceId: EntityIdSchema,
  expectedRevision: RevisionSchema, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  newLocations: z.array(sourceLocation).min(1).max(20), previousLocationIds: z.array(EntityIdSchema).max(1000),
  warnings: z.array(z.string().min(1).max(2000)).min(1).max(20),
}).strict();
export type DetailLocationsPreview = z.infer<typeof DetailLocationsPreviewSchema>;
