import { z } from "zod";
import { HttpUrlSchema, SourceDefinitionSchema, TimestampSchema } from "@better-me/opportunities";
import { JsonFieldMappingSchema } from "./mapping-contracts.js";

const FormatSchema = z.enum(["json", "csv", "markdown", "unknown"]);
export type SourceSampleFormat = z.infer<typeof FormatSchema>;
export const SourceCandidateSchema = z.object({
  candidateId: z.string().min(1).max(240),
  provider: z.enum(["github-repositories", "seed-links"]),
  homeUrl: HttpUrlSchema,
  discoveredAt: TimestampSchema,
  status: z.literal("needs-review"),
  repository: z.object({
    fullName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(240),
    defaultBranch: z.string().min(1).max(240).optional(),
    description: z.string().max(3000).optional(),
    pushedAtRaw: z.string().max(100).optional(),
    licenseSpdx: z.string().max(100).optional(),
  }).strict().optional(),
  entryHints: z.array(z.object({ url: HttpUrlSchema, format: FormatSchema }).strict()).max(30),
  evidenceUrls: z.array(HttpUrlSchema).max(40),
  warnings: z.array(z.string().min(1).max(2000)).max(30),
}).strict();
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
export const DiscoverSourceCandidatesInputSchema = z.object({
  provider: z.enum(["github-repositories", "seed-links"]),
  query: z.string().trim().min(1).max(500).optional(),
  seedUrls: z.array(HttpUrlSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  cursor: z.string().regex(/^[1-9]\d{0,3}$/).refine((value) => Number(value) <= 1000, "Repository search is limited to 1000 pages.").optional(),
}).strict().superRefine((value, context) => {
  if (value.provider === "github-repositories" && (!value.query || value.seedUrls)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Repository search requires a query and no seed URLs." });
  if (value.provider === "seed-links" && (!value.seedUrls || value.query || value.cursor)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Seed discovery requires URLs and does not perform a search." });
});
export type DiscoverSourceCandidatesInput = z.input<typeof DiscoverSourceCandidatesInputSchema>;
export const SourceDiscoveryPageSchema = z.object({
  candidates: z.array(SourceCandidateSchema).max(20), observedAt: TimestampSchema,
  totalAvailable: z.number().int().nonnegative().optional(), nextCursor: z.string().regex(/^[1-9]\d{0,3}$/).optional(), partial: z.boolean(), warnings: z.array(z.string().max(2000)).max(30),
}).strict();
export type SourceDiscoveryPage = z.infer<typeof SourceDiscoveryPageSchema>;
const FieldShapeSchema = z.object({ path: z.string().min(1).max(500), types: z.array(z.enum(["string", "number", "boolean", "null", "array", "object"])).max(6), present: z.number().int().nonnegative().max(100) }).strict();
export const SourceSampleInspectionSchema = z.object({
  url: HttpUrlSchema, format: FormatSchema, sampledRecords: z.number().int().nonnegative().max(100), totalRecords: z.number().int().nonnegative().optional(), truncated: z.boolean(),
  recordsPath: z.string().max(500).optional(), fields: z.array(FieldShapeSchema).max(100), mappingProposal: JsonFieldMappingSchema.optional(),
  coverage: z.object({ identity: z.boolean(), title: z.boolean(), url: z.boolean(), description: z.boolean(), locations: z.boolean(), salary: z.boolean(), recordTime: z.boolean() }).strict(),
  warnings: z.array(z.string().min(1).max(2000)).max(30),
}).strict();
export type SourceSampleInspection = z.infer<typeof SourceSampleInspectionSchema>;
export const InspectSourceCandidateInputSchema = z.object({ candidate: SourceCandidateSchema, sampleUrls: z.array(HttpUrlSchema).min(1).max(3).optional(), maxRecords: z.number().int().min(1).max(100).default(30) }).strict();
export type InspectSourceCandidateInput = z.input<typeof InspectSourceCandidateInputSchema>;
export const SourceCandidateInspectionSchema = z.object({
  candidateId: z.string().min(1).max(240), inspectedAt: TimestampSchema, samples: z.array(SourceSampleInspectionSchema).max(3),
  discoveredEntries: z.array(z.object({ url: HttpUrlSchema, format: FormatSchema }).strict()).max(30), partial: z.boolean(), warnings: z.array(z.string().max(2000)).max(30),
}).strict();
export type SourceCandidateInspection = z.infer<typeof SourceCandidateInspectionSchema>;

export const ProposeSourceRegistrationInputSchema = z.object({ candidate: SourceCandidateSchema, sample: SourceSampleInspectionSchema, name: z.string().trim().min(1).max(240), maxRecords: z.number().int().min(1).max(10_000).default(500) }).strict();
export type ProposeSourceRegistrationInput = z.input<typeof ProposeSourceRegistrationInputSchema>;
export const SourceRegistrationProposalSchema = z.object({ schemaVersion: z.literal(1), candidateId: z.string().min(1).max(240), source: SourceDefinitionSchema, reviewRequired: z.array(z.string().min(1).max(2000)).min(1).max(30) }).strict();
export type SourceRegistrationProposal = z.infer<typeof SourceRegistrationProposalSchema>;
