import { z } from "zod";
import { HttpUrlSchema, SourceDefinitionSchema, TimestampSchema } from "@better-me/opportunities";

const term = z.string().trim().min(1).max(120).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value));
const criteriaFields = {
  role: z.union([term, z.literal("")]),
  skills: z.array(term).max(12),
  secondarySkills: z.array(term).max(16).optional(),
  region: term.optional(),
  preferLowTravel: z.boolean().optional(),
  preferForeignEmployer: z.boolean().optional(),
};
const hasCriteria = (input: { role: string; skills: string[] }) => Boolean(input.role || input.skills.length);
export const OfficialJobCriteriaSchema = z.object(criteriaFields).strict().refine(hasCriteria, "Provide a target role or at least one primary skill.");
export const DiscoverOfficialJobsInputSchema = z.object({ ...criteriaFields, continueDiscovery: z.uuid().optional() }).strict().refine(hasCriteria, "Provide a target role or at least one primary skill.");
export type DiscoverOfficialJobsInput = z.infer<typeof DiscoverOfficialJobsInputSchema>;
export const OfficialJobDiscoveryCandidateSchema = z.object({
  candidateId: z.string().min(1).max(100).optional(),
  url: HttpUrlSchema, title: z.string().min(1).max(1000), company: z.string().min(1).max(500).optional(),
  companyWebsite: HttpUrlSchema.refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname.includes(".")
      && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && !/(?:^|\.)(?:localhost|local|internal|lan|invalid|test)$/.test(url.hostname)
      && !url.hostname.endsWith(".home.arpa");
  }).optional(),
  location: z.string().max(5000).optional(), jobId: z.string().max(1000).optional(),
  description: z.string().max(60_000).optional(), verification: z.enum(["official-detail", "unverified-lead"]),
  verificationEvidence: z.string().max(2000).optional(), detailEvidenceUrl: HttpUrlSchema.optional(), matchedSkills: z.array(term).max(28),
  relatedSkills: z.array(term).max(8).optional(),
  travel: z.enum(["unknown", "not-required", "low-frequency", "required", "mentioned"]), travelEvidence: z.string().max(1000).optional(),
  employerNature: z.enum(["foreign-disclosed", "unknown"]).optional(), employerNatureEvidence: z.string().max(1000).optional(),
  employerGroup: z.object({ name: term, headquarters: term, evidenceUrl: HttpUrlSchema, evidenceKind: z.literal("public-entity").optional() }).strict().optional(),
  discoveryEvidenceUrl: HttpUrlSchema.optional(),
  discoveryRound: z.number().int().positive().optional(),
  sourceProposal: SourceDefinitionSchema.refine(s => !s.enabled && s.status === "needs-review" && s.capabilities.includes("list-jobs")).optional(),
  availability: z.enum(["unknown", "open"]), sourceId: z.string().max(300).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.verification === "unverified-lead" && (value.candidateId || value.sourceProposal))
    ctx.addIssue({ code: "custom", message: "Unverified search leads cannot be imported or proposed as job sources." });
  if (value.employerNature === "foreign-disclosed" && !value.employerNatureEvidence?.trim())
    ctx.addIssue({ code: "custom", message: "Employer identity disclosure requires a source excerpt." });
  if (value.travel !== "unknown" && !value.travelEvidence?.trim())
    ctx.addIssue({ code: "custom", message: "Travel labels require a source excerpt." });
  if (value.verification === "official-detail" && (!value.company || !value.description || !value.verificationEvidence))
    ctx.addIssue({ code: "custom", message: "An official detail requires employer, job text and source evidence." });
});
export type OfficialJobDiscoveryCandidate = z.infer<typeof OfficialJobDiscoveryCandidateSchema>;
export const OfficialDiscoveryProgressSchema = z.object({
  sessionId: z.uuid(), round: z.number().int().nonnegative(), checkedPages: z.number().int().nonnegative(),
  newCompanies: z.number().int().nonnegative(), pendingPages: z.number().int().nonnegative(), canContinue: z.boolean(),
}).strict();
export const OfficialJobDiscoveryResultSchema = z.object({
  observedAt: TimestampSchema,
  status: z.enum(["complete", "partial", "provider-unavailable"]),
  queries: z.array(z.string().max(500)).max(48),
  candidates: z.array(OfficialJobDiscoveryCandidateSchema).max(36),
  warnings: z.array(z.string().max(1000)).max(20),
  discovery: OfficialDiscoveryProgressSchema.optional(),
}).strict();
export type OfficialJobDiscoveryResult = z.infer<typeof OfficialJobDiscoveryResultSchema>;
