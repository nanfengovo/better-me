import { z } from "zod";
import {
  AvailabilitySchema, CompletenessSchema, CountryCodeSchema, CurrencyCodeSchema,
  EntityIdSchema, HttpUrlSchema, SourceCapabilitySchema, TimestampSchema,
  type SourceCapability, type SourceDefinition, type ToolHandlerContext,
} from "@better-me/opportunities";

export const SourceFilterSchema = z.enum(["roles", "regions", "companyNames"]);
export type SourceFilter = z.infer<typeof SourceFilterSchema>;
const scopeValues = () => z.array(z.string().trim().min(1).max(300)).max(100);
/** Requested interests are separate from filters an upstream source actually supports. */
export const SourceScopeSchema = z.object({
  roles: scopeValues(),
  regions: scopeValues(),
  companyNames: scopeValues(),
}).strict();
export type SourceScope = z.infer<typeof SourceScopeSchema>;

export const SourceFieldEvidenceSchema = z.object({
  field: z.string().min(1).max(240),
  selector: z.string().min(1).max(1000).optional(),
  quote: z.string().min(1).max(20_000).optional(),
  sourceUrl: HttpUrlSchema,
}).strict().refine((evidence) => Boolean(evidence.selector || evidence.quote), "Field evidence requires a selector or quote.");
export type SourceFieldEvidence = z.infer<typeof SourceFieldEvidenceSchema>;

/** Sources supply original place text; geocoding belongs to a separately evidenced service. */
export const SourceRecordLocationSchema = z.object({
  raw: z.string().min(1).max(5000),
  countryCode: CountryCodeSchema.optional(),
  region: z.string().min(1).max(500).optional(),
  city: z.string().min(1).max(500).optional(),
}).strict();
export type SourceRecordLocation = z.infer<typeof SourceRecordLocationSchema>;

export const SourceRecordCompensationSchema = z.object({
  raw: z.string().min(1).max(5000),
  currency: CurrencyCodeSchema.optional(),
  period: z.enum(["hour", "day", "week", "month", "year", "unknown"]),
  min: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  max: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  tax: z.enum(["gross", "net", "unknown"]),
  kind: z.enum(["base", "bonus", "equity", "total", "unknown"]),
  monthsPerYear: z.number().finite().positive().max(36).optional(),
  hoursPerYear: z.number().finite().positive().max(8784).optional(),
  daysPerYear: z.number().finite().positive().max(366).optional(),
  weeksPerYear: z.number().finite().positive().max(53).optional(),
}).strict().refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, "Salary bounds must be ordered.");
export type SourceRecordCompensation = z.infer<typeof SourceRecordCompensationSchema>;

export const SourceRecordEntityTypeSchema = z.enum(["job-posting", "recruitment-campaign", "discovery-lead"]);
export type SourceRecordEntityType = z.infer<typeof SourceRecordEntityTypeSchema>;
/** An unverified external record, not yet a canonical job or a personal career fact. */
export const SourceJobRecordSchema = z.object({
  entityType: SourceRecordEntityTypeSchema,
  sourceRecordId: z.string().min(1).max(1000).optional(),
  url: HttpUrlSchema.optional(),
  applicationUrl: HttpUrlSchema.optional(),
  title: z.string().trim().min(1).max(1000),
  companyName: z.string().trim().min(1).max(500).optional(),
  description: z.string().min(1).max(2_000_000).optional(),
  locations: z.array(SourceRecordLocationSchema).max(1000),
  compensations: z.array(SourceRecordCompensationSchema).max(100),
  workMode: z.enum(["on-site", "hybrid", "remote", "unknown"]),
  employmentType: z.enum(["social", "campus", "internship", "unknown"]),
  remoteEligibleRegions: z.array(z.string().min(1).max(240)).max(500),
  availability: AvailabilitySchema,
  availabilityBasis: z.enum(["source-explicit", "detail-explicit"]).optional(),
  completeness: CompletenessSchema,
  evidence: z.array(SourceFieldEvidenceSchema).max(500),
  sourcePublishedRaw: z.string().max(1000).optional(),
  sourcePublishedAt: TimestampSchema.optional(),
  sourceUpdatedRaw: z.string().max(1000).optional(),
  sourceUpdatedAt: TimestampSchema.optional(),
  warnings: z.array(z.string().min(1).max(2000)).max(100),
}).strict().superRefine((record, context) => {
  if (!record.url && !record.sourceRecordId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRecordId"], message: "A source record requires a stable ID or original URL." });
  if (record.availability !== "unknown" && !record.availabilityBasis) context.addIssue({ code: z.ZodIssueCode.custom, path: ["availabilityBasis"], message: "Availability needs an explicit source basis." });
  if (record.entityType !== "job-posting" && record.completeness !== "lead") context.addIssue({ code: z.ZodIssueCode.custom, path: ["completeness"], message: "Campaigns and discovery leads are not detailed job postings." });
  if (record.completeness === "detail" && !record.description) context.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "A detail record requires readable source text." });
});
export type SourceJobRecord = z.infer<typeof SourceJobRecordSchema>;

export const SourceStopReasonSchema = z.enum(["page-limit", "record-limit", "budget", "rate-limit", "needs-human", "source-error"]);
export type SourceStopReason = z.infer<typeof SourceStopReasonSchema>;
const filters = () => z.array(SourceFilterSchema).max(3).refine((values) => new Set(values).size === values.length, "Filter keys must be unique.");
export const SourcePageSchema = z.object({
  records: z.array(SourceJobRecordSchema).max(100_000),
  observedAt: TimestampSchema,
  nextCursor: z.string().min(1).max(2000).optional(),
  coverage: z.object({
    complete: z.boolean(),
    partial: z.boolean(),
    fetchedRecords: z.number().int().nonnegative().max(1_000_000),
    totalAvailable: z.number().int().nonnegative().max(1_000_000_000).optional(),
    appliedFilters: filters(),
    ignoredFilters: filters(),
  }).strict(),
  stopReason: SourceStopReasonSchema.optional(),
  warnings: z.array(z.string().min(1).max(2000)).max(100),
}).strict().superRefine((page, context) => {
  if (page.coverage.complete && (page.coverage.partial || page.nextCursor || page.stopReason)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage", "complete"], message: "Complete enumeration cannot also be partial, stopped, or have another cursor." });
  if (page.stopReason && !page.coverage.partial) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage", "partial"], message: "A stopped enumeration must report partial coverage." });
  if (!page.coverage.complete && !page.coverage.partial && !page.nextCursor) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage"], message: "Incomplete coverage requires a continuation cursor or a partial result." });
  if (page.coverage.fetchedRecords < page.records.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage", "fetchedRecords"], message: "Fetched record count cannot be below returned records." });
  if (page.coverage.appliedFilters.some((filter) => page.coverage.ignoredFilters.includes(filter))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverage", "ignoredFilters"], message: "A filter cannot be both applied and ignored." });
});
export type SourcePage = z.infer<typeof SourcePageSchema>;

export type SourceAdapterContext = ToolHandlerContext & { readonly observedAt: string };
export type SourceTransportResponse = {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
};
export type SourceTransport = {
  /** GET-only; trusted implementation enforces endpoint, DNS, redirect and response budgets. */
  request(input: {
    url: string;
    source: SourceDefinition;
    context: SourceAdapterContext;
    headers?: Readonly<Record<string, string>>;
  }): Promise<SourceTransportResponse>;
};
export type SourceAdapterRequest = {
  source: SourceDefinition;
  scope: SourceScope;
  cursor?: string;
  context: SourceAdapterContext;
  transport: SourceTransport;
};
export const SourceAdapterMetadataSchema = z.object({
  adapterId: EntityIdSchema,
  version: z.string().min(1).max(80),
  capabilities: z.array(SourceCapabilitySchema).max(6).refine((values) => new Set(values).size === values.length, "Capabilities must be unique."),
  remoteFilters: filters(),
  entityTypes: z.array(SourceRecordEntityTypeSchema).min(1).max(3).refine((values) => new Set(values).size === values.length, "Entity types must be unique."),
}).strict();
export type SourceAdapterMetadata = z.infer<typeof SourceAdapterMetadataSchema>;
export type SourceAdapter = SourceAdapterMetadata & {
  readonly list: (request: SourceAdapterRequest) => Promise<SourcePage>;
};

export const SOURCE_REGISTRY_ERROR_CODES = ["invalid-source", "adapter-not-found", "unsupported-version", "unsupported-capability", "source-disabled", "invalid-output", "duplicate-adapter"] as const;
export type SourceRegistryErrorCode = typeof SOURCE_REGISTRY_ERROR_CODES[number];
const messages: Record<SourceRegistryErrorCode, string> = {
  "invalid-source": "来源配置或读取范围无效。", "adapter-not-found": "没有注册此来源适配器。",
  "unsupported-version": "当前未注册所需适配器版本。", "unsupported-capability": "来源或适配器不支持所请求的能力。",
  "source-disabled": "来源尚未启用或仍待审核。", "invalid-output": "来源返回内容不符合适配器契约。",
  "duplicate-adapter": "适配器编号与版本已经注册。",
};
/** Fixed public messages intentionally exclude source bodies, URLs and credentials. */
export class SourceRegistryError extends Error {
  constructor(readonly code: SourceRegistryErrorCode) { super(messages[code]); this.name = "SourceRegistryError"; }
}

export type SourceAdapterResolution = {
  adapter: SourceAdapter;
  capabilities: SourceCapability[];
  remoteFilters: SourceFilter[];
};
