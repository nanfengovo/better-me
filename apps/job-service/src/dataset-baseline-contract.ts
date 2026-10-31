import { z } from "zod";
import { DatasetCursorSchema, DatasetUpsertsSchema } from "./dataset-sync-contract.js";

/** Baseline transport is independent of query cursors and the revision delta protocol. */
export const BASELINE_PROTOCOL = "better-me/atlas-baseline-v1" as const;
export const BASELINE_MAX_ENTITIES = 256;
export const BASELINE_MAX_BYTES = 512 * 1024;
// A single immutable JD may exceed a normal page; never truncate it silently.
export const BASELINE_MAX_ROW_BYTES = 16 * 1024 * 1024;
export const BaselinePageCursorSchema = z.object({ session: z.string().regex(/^[a-f0-9]{32}$/), sequence: z.number().int().nonnegative() }).strict();
export const BaselineRequestSchema = z.object({ page: BaselinePageCursorSchema.optional() }).strict();
export const BaselineCloseSchema = z.object({ session: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
const count = z.number().int().nonnegative();
export const BaselineResponseSchema = z.discriminatedUnion("kind", [
  z.object({ protocol: z.literal(BASELINE_PROTOCOL), kind: z.literal("page"), cursor: DatasetCursorSchema,
    session: z.string().regex(/^[a-f0-9]{32}$/), sequence: count, next: BaselinePageCursorSchema.optional(),
    totalJobs: count, loadedJobs: count, checkpoint: z.boolean(), complete: z.boolean(), rows: DatasetUpsertsSchema,
  }).strict(),
  z.object({ protocol: z.literal(BASELINE_PROTOCOL), kind: z.literal("expired") }).strict(),
]);
export type BaselineRequest = z.infer<typeof BaselineRequestSchema>;
export type BaselinePage = Extract<z.infer<typeof BaselineResponseSchema>, { kind: "page" }>;
export type BaselineResponse = z.infer<typeof BaselineResponseSchema>;
export type BaselineProgress = { loadedJobs: number; totalJobs: number; pages: number; complete: boolean };
