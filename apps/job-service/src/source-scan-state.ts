import { createHash } from "node:crypto";
import { z } from "zod";
import { EntityIdSchema, TimestampSchema, type SourceDefinition } from "@better-me/opportunities";
import { SourceScopeSchema } from "@better-me/source-adapters";

/** Private durable checkpoints. Cursors never enter public datasets or progress responses. */
export const SourceScanCheckpointSchema = z.object({
  id: EntityIdSchema, scanId: EntityIdSchema, version: z.number().int().positive(), sourceId: EntityIdSchema,
  actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), runId: EntityIdSchema, generation: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  scope: SourceScopeSchema, adapterId: EntityIdSchema, adapterVersion: z.string().min(1).max(80),
  state: z.enum(["ready", "retry-page", "exhausted", "truncated", "invalidated"]), cursor: z.string().min(1).max(2000).optional(),
  attemptedRecords: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), hadErrors: z.boolean(), at: TimestampSchema,
  invalidatedReason: z.enum(["source-config-changed", "new-scan", "source-changed"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && !value.cursor || ["exhausted", "truncated"].includes(value.state) && value.cursor) context.addIssue({ code: "custom", message: "Checkpoint state and cursor disagree." });
  if ((value.state === "invalidated") !== Boolean(value.invalidatedReason)) context.addIssue({ code: "custom", message: "Invalidation needs a permanent reason." });
  if (value.scopeFingerprint !== sourceScanFingerprint(value.scope)) context.addIssue({ code: "custom", message: "Checkpoint scope identity is invalid." });
});
export type SourceScanCheckpoint = z.infer<typeof SourceScanCheckpointSchema>;
export function sourceScanFingerprint(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export function sourceConfigurationFingerprint(source: SourceDefinition): string { return sourceScanFingerprint(source); }
