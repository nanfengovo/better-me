import { z } from "zod";

export class HarvesterError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HarvesterError"; }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const id = z.string().min(1).max(200);
export const RepositoryPreviewSchema = z.object({ root: z.string().min(1).max(2000), repositoryId: digest, head: oid,
  objectFormat: z.enum(["sha1", "sha256"]), metadataIdentity: digest }).strict();
export const HarvesterRuntimeSchema = z.object({ id, location: z.literal("local"), endpointFingerprint: digest, model: id, modelDigest: digest }).strict();
export type HarvesterRuntime = z.infer<typeof HarvesterRuntimeSchema>;
export const HarvesterPolicySchema = z.object({ expiresAt: z.number().int().positive(),
  maxCommitsPerDay: z.number().int().min(1).max(100), maxModelCallsPerDay: z.number().int().min(1).max(100),
  maxInputBytes: z.number().int().min(1024).max(128_000), maxOutputBytes: z.number().int().min(256).max(32_000),
  maxActiveMs: z.number().int().min(100).max(180_000) }).strict();
export type HarvesterPolicy = z.infer<typeof HarvesterPolicySchema>;
export const RepositorySubscriptionSchema = z.object({ id, repository: RepositoryPreviewSchema,
  session: id, generation: z.number().int().positive(), runtime: HarvesterRuntimeSchema, policy: HarvesterPolicySchema,
  status: z.enum(["active", "paused", "revoked", "needs_authorization"]), cursor: oid,
  usage: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), commits: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative() }).strict(),
  createdAt: z.string().datetime(), errorCode: id.optional() }).strict();
export type RepositorySubscription = z.infer<typeof RepositorySubscriptionSchema>;

export const MicroFactModelOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_proposal"), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("proposal"), title: z.string().trim().min(1).max(160), summary: z.string().trim().min(1).max(2000),
    contributionQuestion: z.string().trim().min(1).max(500),
    citationIds: z.array(id).min(1).max(8) }).strict(),
]);
export type MicroFactModelOutput = z.infer<typeof MicroFactModelOutputSchema>;
export const MicroFactCitationSchema = z.object({ evidenceId: digest, path: z.string().min(1).max(2000), version: z.enum(["before", "after"]),
  sourceHash: digest, startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: z.string().min(1).max(4000) }).strict();
export const PersonalMicroFactReviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["implementation", "design"]), action: z.string().trim().min(1).max(2500), role: z.string().trim().max(300), deployment: z.string().trim().max(600) }).strict(),
  z.object({ kind: z.literal("not-mine"), note: z.string().trim().max(2500) }).strict(),
  z.object({ kind: z.literal("unknown"), note: z.string().trim().max(2500) }).strict(),
]);
export type PersonalMicroFactReview = z.infer<typeof PersonalMicroFactReviewSchema>;
export const MicroFactEntrySchema = z.object({ id, subscriptionId: id, repositoryId: digest, commit: oid,
  generation: z.number().int().positive(), status: z.enum(["capturing", "analyzing", "awaiting_review", "dismissed", "failed", "interrupted", "reviewed", "proposing", "proposal_created"]),
  title: z.string().max(160).optional(), summary: z.string().max(2000).optional(), contributionQuestion: z.string().max(500).optional(),
  personalContribution: z.literal("unknown"), citations: z.array(MicroFactCitationSchema).max(8),
  review: PersonalMicroFactReviewSchema.optional(),
  proposalReceipt: z.object({ id, proposalId: id, status: z.literal("pending_business_review") }).strict().optional(),
  errorCode: id.optional(), limitations: z.array(z.string().max(2000)).max(20), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export type MicroFactEntry = z.infer<typeof MicroFactEntrySchema>;
export const HarvesterStateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), ownerId: id,
  subscriptions: z.array(RepositorySubscriptionSchema).max(100), entries: z.array(MicroFactEntrySchema).max(5000),
  operations: z.record(z.object({ hash: digest, targetId: id }).strict()) }).strict();
export type HarvesterState = z.infer<typeof HarvesterStateSchema>;

/** Storage contains only acquisition subscriptions and candidate artifacts, not
 * career facts, resume documents, credentials, or a second general task queue. */
export interface HarvesterLedger {
  readonly ownerId: string;
  read(): HarvesterState;
  transact<T>(mutate: (state: HarvesterState) => T): T;
}
export type HarvesterAccess = { session: string; valid(): Promise<boolean> };
export type HarvesterProposalReceipt = NonNullable<MicroFactEntry["proposalReceipt"]>;
export interface HarvesterWorkspaceAdapter {
  findReceipt(idempotencyKey: string): Promise<HarvesterProposalReceipt | undefined>;
  propose(input: { entry: Readonly<MicroFactEntry>; review: PersonalMicroFactReview; idempotencyKey: string; consent: true }, signal: AbortSignal): Promise<HarvesterProposalReceipt>;
}
