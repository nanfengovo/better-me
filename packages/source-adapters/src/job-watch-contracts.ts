import { z } from "zod";
import { TimestampSchema } from "@better-me/opportunities";
import { OfficialJobCriteriaSchema, OfficialJobDiscoveryCandidateSchema } from "./official-job-discovery-contracts.js";

export const JobWatchHandleSchema = z.object({ watchId: z.uuid(), watchKey: z.uuid() }).strict();
export type JobWatchHandle = z.infer<typeof JobWatchHandleSchema>;
export const JobWatchConfigSchema = z.object({
  criteria: OfficialJobCriteriaSchema,
  intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
}).strict();
export type JobWatchConfig = z.infer<typeof JobWatchConfigSchema>;
export const JobWatchStartSchema = JobWatchHandleSchema.extend({ config: JobWatchConfigSchema }).strict();
export const JobWatchEnableSchema = JobWatchHandleSchema.extend({ enabled: z.boolean() }).strict();
export const JobWatchReadSchema = JobWatchHandleSchema.extend({
  offset: z.number().int().min(0).max(1_000_000).optional(),
  view: z.enum(["matches", "related"]).optional(),
}).strict();
export const JobWatchAckSchema = JobWatchHandleSchema.extend({
  hitIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(50),
}).strict();
export const JobWatchReceiptSchema = z.object({ saved: z.literal(true) }).strict();

export const JobWatchMatchSchema = z.object({
  tier: z.enum(["priority", "confirm", "related"]),
  skillEvidence: z.array(z.object({ skill: z.string().max(120), quote: z.string().min(1).max(500) }).strict()).max(12),
  foreignConfirmed: z.boolean(),
  secondaryMatches: z.array(z.string().max(120)).max(16).default([]),
}).strict();
export type JobWatchMatch = z.infer<typeof JobWatchMatchSchema>;
export const JobWatchHitSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  job: OfficialJobDiscoveryCandidateSchema,
  match: JobWatchMatchSchema,
  firstSeenAt: TimestampSchema,
  lastObservedAt: TimestampSchema,
  unread: z.boolean(),
}).strict();
export type JobWatchHit = z.infer<typeof JobWatchHitSchema>;
const nonnegative = z.number().int().nonnegative();
export const JobWatchStatusSchema = z.object({
  watchId: z.uuid(),
  config: JobWatchConfigSchema,
  phase: z.enum(["scheduled", "searching", "paused", "retry"]),
  nextRunAt: TimestampSchema.optional(),
  lastRunAt: TimestampSchema.optional(),
  rounds: nonnegative,
  pages: nonnegative,
  pendingPages: nonnegative,
  companies: nonnegative,
  total: nonnegative,
  priority: nonnegative,
  confirm: nonnegative,
  unread: nonnegative,
  latestAlertAt: TimestampSchema.optional(),
  warnings: z.array(z.string().max(1000)).max(20),
  hits: z.array(JobWatchHitSchema).max(30).optional(),
}).strict();
export type JobWatchStatus = z.infer<typeof JobWatchStatusSchema>;
