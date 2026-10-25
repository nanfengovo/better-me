import { z } from "zod";
import { EntityIdSchema, HttpUrlSchema, JobLocationSchema, RevisionSchema } from "./schema.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const jobIds = z.array(EntityIdSchema).max(50).refine(values => new Set(values).size === values.length, "Duplicate job IDs.");
/** Explicit current-result scope. No URLs, provider configuration or private address inputs. */
export const PlanAddressEnrichmentInputSchema = z.object({ jobIds, expectedRevision: RevisionSchema }).strict();
export type PlanAddressEnrichmentInput = z.infer<typeof PlanAddressEnrichmentInputSchema>;

const currentOffice = JobLocationSchema.refine(location => location.kind === "office" && !!location.coordinates
  && (location.precision === "address" || location.precision === "manual") && location.evidence.length > 0,
"An available office needs an evidenced address-level office point.");
const sourceStreet = JobLocationSchema.refine(location => location.kind === "office" && !!location.streetAddress
  && location.evidence.length > 0 && !location.officeResolution && !location.userResolution,
"A source street must be the original office disclosure, never a local overlay.");
export const AddressEnrichmentStreetTargetSchema = z.object({
  listingId: EntityIdSchema, sourceId: EntityIdSchema, locationId: EntityIdSchema,
  sourceUrl: HttpUrlSchema, sourceLocation: sourceStreet,
}).strict().refine(value => value.locationId === value.sourceLocation.id, "Location identity must agree.");
export type AddressEnrichmentStreetTarget = z.infer<typeof AddressEnrichmentStreetTargetSchema>;
export const AddressEnrichmentPlatformTargetSchema = z.object({
  listingId: EntityIdSchema, sourceId: EntityIdSchema, provider: z.enum(["51job", "boss", "liepin", "linkedin", "seek", "indeed", "gradconnection"]),
  url: HttpUrlSchema, label: text(240),
}).strict();
export type AddressEnrichmentPlatformTarget = z.infer<typeof AddressEnrichmentPlatformTargetSchema>;
export const AddressEnrichmentOfficialTargetSchema = z.object({
  listingId: EntityIdSchema, sourceId: EntityIdSchema, adapterId: EntityIdSchema,
  url: HttpUrlSchema, label: text(240),
}).strict();
export type AddressEnrichmentOfficialTarget = z.infer<typeof AddressEnrichmentOfficialTargetSchema>;
export const AddressEnrichmentStatusSchema = z.enum(["office-ready", "source-street", "platform-detail", "official-source", "company-discovery", "remote-only"]);
export type AddressEnrichmentStatus = z.infer<typeof AddressEnrichmentStatusSchema>;
export const AddressEnrichmentPlanItemSchema = z.object({
  jobId: EntityIdSchema, title: text(1000), companyId: EntityIdSchema, companyName: text(500),
  status: AddressEnrichmentStatusSchema,
  currentOffice: z.array(currentOffice).max(20),
  /** Existing non-remote location identities that still lack a usable office point. */
  pendingLocationIds: z.array(EntityIdSchema).max(1000).refine(values => new Set(values).size === values.length, "Duplicate pending location IDs."),
  sourceStreetTargets: z.array(AddressEnrichmentStreetTargetSchema).max(20),
  exactPlatformTargets: z.array(AddressEnrichmentPlatformTargetSchema).max(20),
  ownedOfficialTargets: z.array(AddressEnrichmentOfficialTargetSchema).max(20),
  companyLookup: z.object({ companyName: text(500), association: z.literal("unverified"), strength: z.literal("weak") }).strict(),
  truncated: z.boolean(), warnings: z.array(text(3000)).max(20),
}).strict().superRefine((value, context) => {
  const expected = value.status === "remote-only" ? "remote-only" : value.currentOffice.length && !value.pendingLocationIds.length ? "office-ready"
    : value.sourceStreetTargets.length ? "source-street" : value.exactPlatformTargets.length ? "platform-detail"
      : value.ownedOfficialTargets.length ? "official-source" : "company-discovery";
  if (value.status !== expected || value.companyLookup.companyName !== value.companyName
    || value.status === "remote-only" && (value.currentOffice.length || value.pendingLocationIds.length || value.sourceStreetTargets.length || value.exactPlatformTargets.length || value.ownedOfficialTargets.length)) {
    context.addIssue({ code: "custom", message: "Plan status and scope must agree with its available evidence." });
  }
  for (const targets of [value.exactPlatformTargets, value.ownedOfficialTargets]) {
    if (new Set(targets.map(target => target.listingId)).size !== targets.length) context.addIssue({ code: "custom", message: "Duplicate listing target." });
  }
  if (new Set(value.currentOffice.map(location => location.id)).size !== value.currentOffice.length
    || new Set(value.sourceStreetTargets.map(target => JSON.stringify([target.listingId, target.locationId]))).size !== value.sourceStreetTargets.length) {
    context.addIssue({ code: "custom", message: "Duplicate office or source street target." });
  }
  const ready = new Set(value.currentOffice.map(location => location.id)), pending = new Set(value.pendingLocationIds);
  if (value.pendingLocationIds.some(id => ready.has(id)) || value.sourceStreetTargets.some(target => !pending.has(target.locationId))) {
    context.addIssue({ code: "custom", message: "Pending locations must exclude ready offices and include every source street action." });
  }
});
export type AddressEnrichmentPlanItem = z.infer<typeof AddressEnrichmentPlanItemSchema>;
export const AddressEnrichmentPlanSchema = z.object({
  schemaVersion: z.literal(1), snapshotRevision: RevisionSchema,
  requestedJobs: z.number().int().min(0).max(50), processedJobs: z.number().int().min(0).max(50),
  truncated: z.boolean(), items: z.array(AddressEnrichmentPlanItemSchema).max(50), warnings: z.array(text(3000)).max(20),
}).strict().superRefine((value, context) => {
  if (value.requestedJobs !== value.processedJobs || value.processedJobs !== value.items.length
    || new Set(value.items.map(item => item.jobId)).size !== value.items.length
    || value.truncated !== value.items.some(item => item.truncated)) context.addIssue({ code: "custom", message: "Plan counts, identities and truncation must agree." });
});
export type AddressEnrichmentPlan = z.infer<typeof AddressEnrichmentPlanSchema>;
