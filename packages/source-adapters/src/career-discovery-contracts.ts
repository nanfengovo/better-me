import { z } from "zod";
import { EntityIdSchema, HttpUrlSchema, TimestampSchema } from "@better-me/opportunities";
import { SourceCandidateSchema, SourceRegistrationProposalSchema } from "./discovery-contracts.js";

export const DiscoverCompanyCareersInputSchema = z.object({
  companyName: z.string().trim().min(1).max(240),
  companyWebsite: HttpUrlSchema.optional(),
  seedUrls: z.array(HttpUrlSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  maxPages: z.number().int().min(1).max(10).default(3),
}).strict();
export type DiscoverCompanyCareersInput = z.input<typeof DiscoverCompanyCareersInputSchema>;

/** Website reads require a registered endpoint policy; name-only lookup uses the host policy. */
export const DiscoverCompanyCareersRequestSchema = z.object({
  sourceId: EntityIdSchema.optional(),
  request: DiscoverCompanyCareersInputSchema,
}).strict().superRefine((value, context) => {
  if ((value.request.companyWebsite || value.request.seedUrls?.length) && !value.sourceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "An explicit website or seed requires a registered discovery policy." });
  }
});
export const CareerWebSearchProviderIdSchema = z.enum(["duckduckgo-html", "searxng", "host-installed"]);
export const CareerWebSearchProviderMetadataSchema = z.object({
  providerId: CareerWebSearchProviderIdSchema,
  label: z.string().trim().min(1).max(160),
}).strict();
export type CareerWebSearchProviderMetadata = z.infer<typeof CareerWebSearchProviderMetadataSchema>;
export const CompanyCareerDiscoveryCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  webSearch: z.discriminatedUnion("configured", [
    z.object({ configured: z.literal(false) }).strict(),
    CareerWebSearchProviderMetadataSchema.extend({ configured: z.literal(true) }).strict(),
  ]),
}).strict();
export type CompanyCareerDiscoveryCapabilities = z.infer<typeof CompanyCareerDiscoveryCapabilitiesSchema>;

export const CareerEntryKindSchema = z.enum(["greenhouse", "lever", "ashby", "tencent", "smartrecruiters", "html"]);
export type CareerEntryKind = z.infer<typeof CareerEntryKindSchema>;
export const CareerDiscoveryEvidenceSchema = z.object({
  kind: z.enum(["provided-website", "provided-seed", "html-link", "search-result"]),
  sourceUrl: HttpUrlSchema,
  targetUrl: HttpUrlSchema,
  quote: z.string().min(1).max(1000).optional(),
}).strict();
export type CareerDiscoveryEvidence = z.infer<typeof CareerDiscoveryEvidenceSchema>;
export const CareerSourceCandidateSchema = z.object({
  candidate: SourceCandidateSchema,
  entryKind: CareerEntryKindSchema,
  matchedBy: z.enum(["company-website", "seed-link", "career-link", "search-result"]),
  companyAssociation: z.literal("unverified"),
  evidence: z.array(CareerDiscoveryEvidenceSchema).min(1).max(30),
}).strict();
export type CareerSourceCandidate = z.infer<typeof CareerSourceCandidateSchema>;
export const CompanyCareerDiscoveryResultSchema = z.object({
  status: z.enum(["matched-existing", "requires-company-website", "needs-review", "no-candidates"]),
  companyName: z.string().min(1).max(240),
  observedAt: TimestampSchema,
  matchedSources: z.array(z.object({
    sourceId: EntityIdSchema,
    name: z.string().min(1).max(240),
    matchedBy: z.enum(["company-name", "company-alias", "source-name", "company-website", "entry-url"]),
    enabled: z.boolean(),
    status: z.enum(["active", "needs-review", "disabled", "unavailable"]),
    entryUrl: HttpUrlSchema.optional(),
  }).strict()).max(50),
  candidates: z.array(CareerSourceCandidateSchema).max(20),
  proposals: z.array(SourceRegistrationProposalSchema).max(20),
  visitedUrls: z.array(HttpUrlSchema).max(10),
  search: CareerWebSearchProviderMetadataSchema.extend({
    query: z.string().min(1).max(500),
    resultCount: z.number().int().min(0).max(20),
  }).strict().optional(),
  partial: z.boolean(),
  warnings: z.array(z.string().min(1).max(2000)).max(30),
}).strict();
export type CompanyCareerDiscoveryResult = z.infer<typeof CompanyCareerDiscoveryResultSchema>;

/** Untrusted provider data is validated before it can become a review candidate. */
export const CareerWebSearchResultSchema = z.object({
  results: z.array(z.object({
    url: HttpUrlSchema,
    title: z.string().max(500).optional(),
    snippet: z.string().max(1000).optional(),
    evidenceUrl: HttpUrlSchema.optional(),
  }).strict()).max(20),
  partial: z.boolean(),
}).strict();
export type CareerWebSearchResult = z.infer<typeof CareerWebSearchResultSchema>;
