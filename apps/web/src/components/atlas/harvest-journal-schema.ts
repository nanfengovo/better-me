import { z } from "zod";
import { EntityIdSchema, TimestampSchema } from "@better-me/opportunities";
import { ImportReviewedCardsInputSchema, ReviewedCardsCaptureSchema, ReviewedSearchCardSchema, reviewedCardsSearchPage } from "@better-me/source-adapters/browser-contracts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const visible = (max: number) => z.string().min(1).max(max);
const url = z.string().url().max(8_000).refine(value => {
  const parsed = new URL(value);
  return !parsed.username && !parsed.password && [...parsed.searchParams.keys()].every(key => !/^(?:access_?token|refresh_?token|token|authorization|cookie|session(?:id)?|password|secret|api_?key)$/i.test(key));
});
export const JournalProviderSchema = z.enum(["liepin", "51job", "boss", "linkedin", "seek", "indeed", "gradconnection"]);
const platform = z.enum(["猎聘", "51JOB", "BOSS直聘", "LinkedIn", "Seek", "Indeed", "GradConnection"]);
const platforms = { liepin: "猎聘", "51job": "51JOB", boss: "BOSS直聘", linkedin: "LinkedIn", seek: "Seek", indeed: "Indeed", gradconnection: "GradConnection" };
export const JournalScopeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
export const JournalRunInputSchema = z.object({
  keyword: visible(500), region: z.string().max(1000).optional(),
  chinaSelection: z.object({ provinceCode: visible(20).optional(), cityCode: visible(20).optional(), districtCode: visible(20).optional() }).strict().optional(),
  depth: z.enum(["quick", "standard", "deep"]), maxPages: z.number().int().min(1).max(1000).optional(),
  view: z.object({ mode: z.enum(["global", "domestic"]), country: z.string().max(100), region: z.string().max(1000), regionText: z.string().max(1000) }).strict(),
}).strict();
export const JournalRunSchema = z.object({
  schemaVersion: z.literal(1), id, scope: JournalScopeSchema, input: JournalRunInputSchema,
  state: z.enum(["running", "completed", "needs-attention", "cancelled", "superseded"]),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  queryTerms: z.array(visible(500)).min(1).max(100).optional(),
  providers: z.array(JournalProviderSchema).min(1).max(7).optional(),
}).strict().refine(run => (run.queryTerms === undefined) === (run.providers === undefined)
  && (!run.queryTerms || new Set(run.queryTerms).size === run.queryTerms.length)
  && (!run.providers || new Set(run.providers).size === run.providers.length));

const batchShape = {
  id, provider: JournalProviderSchema, platform, pageUrl: url, capturedAt: TimestampSchema,
  cards: z.array(ReviewedSearchCardSchema).min(1).max(50),
};
export const JournalCapturedBatchSchema = z.object(batchShape).strict().refine(batch => batch.platform === platforms[batch.provider]
  && ReviewedCardsCaptureSchema.safeParse({ provider: batch.provider, pageUrl: batch.pageUrl, capturedAt: batch.capturedAt, cards: batch.cards }).success
  && batch.cards.every(card => url.safeParse(card.url).success && url.safeParse(card.evidence.pageUrl).success));
export const JournalCommandSchema = z.object({ input: ImportReviewedCardsInputSchema, idempotencyKey: id }).strict();
export const JournalReceiptSchema = z.object({
  ok: z.literal(true), revision: count, jobIds: z.array(EntityIdSchema).max(1000), snapshotIds: z.array(EntityIdSchema).max(1000),
  counts: z.object({ newJobs: count, updatedJobs: count, unchangedJobs: count, newListings: count, newObservations: count, newSnapshots: count }).strict(),
}).strict();
export const JournalBatchSchema = z.object({ ...batchShape, command: JournalCommandSchema.optional(), receipt: JournalReceiptSchema.optional() }).strict();

// Provider receipts preserve the validated live-search view, including partial
// coverage, even when a raw card cannot pass the narrower import evidence rules.
const liveCard = z.object({
  url, platform, title: visible(500), company: visible(500), locationText: z.string().max(1000).optional(),
  salaryText: z.string().max(1000).optional(), publicationText: z.string().max(1000).optional(), cardText: z.string().max(20_000),
  evidence: z.object({ pageUrl: url, cardSelector: visible(1000), fields: z.array(z.object({
    field: z.enum(["url", "title", "company", "locationText", "salaryText", "publicationText"]), selector: visible(1000), text: visible(8000),
  }).strict()).max(30) }).strict(),
}).strict();
const providerResult = z.object({
  provider: JournalProviderSchema, platform, pageUrl: url,
  status: z.enum(["ready", "empty", "login_required", "verification_required", "unknown_layout", "oversized", "unsupported_page", "error"]),
  cards: z.array(liveCard).max(3000), rawCardCount: count, warnings: z.array(z.string().max(2000)).max(100), error: z.string().max(2000).optional(),
  coverage: z.object({ pagesVisited: count, scrollSteps: count, scrollLimit: count, pageLimit: count.min(1), cardLimit: count.min(1),
    stopReason: z.enum(["exhausted", "page_limit", "scroll_limit", "card_limit", "no_progress", "gate", "error", "cancelled"]), partial: z.boolean(),
  }).strict(),
}).strict().refine(result => result.platform === platforms[result.provider]
  && !!reviewedCardsSearchPage(result.pageUrl, result.provider)
  && result.cards.every(card => card.platform === result.platform)
  && (result.status === "ready") === (result.cards.length > 0) && result.rawCardCount >= result.cards.length
  && result.coverage.pagesVisited <= result.coverage.pageLimit && result.coverage.scrollSteps <= result.coverage.scrollLimit
  && result.coverage.partial === (result.coverage.stopReason !== "exhausted"));
export const JournalProviderCheckpointSchema = z.object({ term: visible(500), capturedAt: TimestampSchema, result: providerResult }).strict();

export const JournalRunRowSchema = z.object({ id, scope: JournalScopeSchema, bytes: count, record: JournalRunSchema }).strict()
  .refine(row => row.id === row.record.id && row.scope === row.record.scope);
export const JournalBatchRowSchema = z.object({ id: visible(1000), runId: id, bytes: count, data: JournalBatchSchema }).strict();
export const JournalProviderRowSchema = z.object({ id: visible(2000), runId: id, bytes: count, data: JournalProviderCheckpointSchema }).strict();
