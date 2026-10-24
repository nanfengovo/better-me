import { z } from "zod";
import { buildPlatformSearchRequest, PlatformSearchInputSchema, PlatformSearchProviderSchema, type PlatformSearchInput, type PlatformSearchProvider } from "./platform-search.js";
import {
  ReviewedCardsCaptureSchema, ReviewedSearchCardSchema, reviewedCardIdentity, REVIEWED_PLATFORM_NAMES,
  reviewedCardsSearchPage,
  type ReviewedCardsCapture,
} from "./reviewed-cards.js";
import { TimestampSchema } from "@better-me/opportunities";

const pageUrl = z.string().url().max(4096);
const sessionId = z.string().regex(/^[a-z\d_-]{16,200}$/i);
const warning = z.string().min(1).max(2_000);
const pageStatus = z.enum(["ready", "empty", "login_required", "verification_required", "unknown_layout", "oversized", "unsupported_page"]);
export const PlatformSearchBatchCardSchema = ReviewedSearchCardSchema.extend({ company: z.string().trim().max(500).optional() }).strict();
export type PlatformSearchBatchCard = z.infer<typeof PlatformSearchBatchCardSchema>;

/** One explicit page read from an already-open official platform search page. */
export const PlatformSearchBatchPageSchema = z.object({
  provider: PlatformSearchProviderSchema,
  pageUrl,
  capturedAt: TimestampSchema,
  pageIndex: z.number().int().min(0).max(10_000),
  status: pageStatus,
  cards: z.array(PlatformSearchBatchCardSchema).max(50),
  partial: z.boolean(),
  warnings: z.array(warning).max(100),
}).strict().superRefine((page, context) => {
  if (!reviewedCardsSearchPage(page.pageUrl, page.provider)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pageUrl"], message: "Expected this provider's official search page." });
  const hasCards = page.cards.length > 0;
  if (page.status === "ready" && !hasCards) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cards"], message: "A ready page must contain at least one card." });
  if (page.status !== "ready" && hasCards) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cards"], message: "A non-ready page cannot contain job cards." });
  if (!hasCards) return;
  const seen = new Set<string>();
  page.cards.forEach((card, index) => {
    const addIssue = (field: string, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, field], message });
    if (card.platform !== REVIEWED_PLATFORM_NAMES[page.provider]) addIssue("platform", "Every card must match the page provider.");
    const identity = reviewedCardIdentity(card.url, page.provider);
    if (!identity) addIssue("url", "Expected an allowed official single-job URL.");
    else if (seen.has(identity.id)) addIssue("url", "A job may only occur once on a page.");
    else seen.add(identity.id);
    if (reviewedCardsSearchPage(card.evidence.pageUrl, page.provider) !== reviewedCardsSearchPage(page.pageUrl, page.provider)) addIssue("evidence", "Card evidence must refer to this exact search page.");
    const names = new Set<string>();
    for (const field of card.evidence.fields) {
      if (names.has(field.field)) addIssue("evidence", "Field evidence must be unique.");
      names.add(field.field);
      const value = card[field.field];
      if (value === undefined || value === "" || value.replace(/\s+/gu, " ").trim() !== field.text.replace(/\s+/gu, " ").trim()) addIssue("evidence", "Field evidence must reproduce its visible value.");
    }
    for (const name of ["url", "title", "company", "locationText", "salaryText", "publicationText"] as const) {
      const value = card[name];
      if (value !== undefined && value !== "" && !names.has(name)) addIssue("evidence", "Every supplied field requires matching card evidence.");
      if (name !== "url" && value !== undefined && !card.cardText.replace(/\s+/gu, " ").includes(value.replace(/\s+/gu, " "))) addIssue(name, "A field must occur in the supplied visible card excerpt.");
    }
    if (card.publicationText && /更新|活跃|在线|上线|回复|刷新|updated?|active|replied|viewed|promoted/i.test(card.publicationText)) addIssue("publicationText", "Activity or update labels are not publication evidence.");
  });
});
export type PlatformSearchBatchPage = z.infer<typeof PlatformSearchBatchPageSchema>;

/** A manually advanced search session. It is a capture ledger, never a market-completeness claim. */
export const PlatformSearchBatchSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId,
  input: PlatformSearchInputSchema,
  pages: z.array(PlatformSearchBatchPageSchema).min(1).max(100),
  warnings: z.array(warning).max(100),
}).strict().superRefine((batch, context) => {
  const first = batch.pages[0];
  if (first && first.provider !== batch.input.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", 0, "provider"], message: "The first page provider must match the search input." });
  for (let index = 1; index < batch.pages.length; index++) {
    const previous = batch.pages[index - 1]!;
    const current = batch.pages[index]!;
    if (current.provider !== batch.input.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", index, "provider"], message: "Every page provider must match the search input." });
    if (current.pageIndex <= previous.pageIndex) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", index, "pageIndex"], message: "Pages must be appended in strictly increasing order." });
    if (searchScope(current.pageUrl) === undefined || searchScope(current.pageUrl) !== searchScope(first?.pageUrl ?? "")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", index, "pageUrl"], message: "All pages must keep the original search scope apart from pagination parameters." });
  }
  if (first && !matchesRequestedSearchScope(first.pageUrl, batch.input)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pages", 0, "pageUrl"], message: "The first page must preserve the requested platform search parameters." });
});
export type PlatformSearchBatch = z.infer<typeof PlatformSearchBatchSchema>;

export const PlatformSearchBatchPageInputSchema = PlatformSearchBatchPageSchema;
export type PlatformSearchBatchPageInput = PlatformSearchBatchPage;

export type PlatformSearchBatchErrorCode = "invalid-batch" | "scope-changed" | "page-order" | "duplicate-page" | "unsupported-page";
const messages: Record<PlatformSearchBatchErrorCode, string> = {
  "invalid-batch": "平台搜索批次无效。",
  "scope-changed": "当前页面不属于原搜索条件；请结束会话后重新搜索。",
  "page-order": "新的页面序号必须大于已读取页面。",
  "duplicate-page": "此搜索结果页已经加入批次，无需重复追加。",
  "unsupported-page": "只有成功读取的岗位列表页或明确空结果页可以加入批次。",
};
export class PlatformSearchBatchError extends Error {
  constructor(readonly code: PlatformSearchBatchErrorCode) { super(messages[code]); this.name = "PlatformSearchBatchError"; }
}

function parsePage(pageInput: PlatformSearchBatchPageInput): PlatformSearchBatchPage {
  const parsed = PlatformSearchBatchPageSchema.safeParse(pageInput);
  if (!parsed.success) throw new PlatformSearchBatchError("invalid-batch");
  return parsed.data;
}

function parseBatch(batchInput: PlatformSearchBatch): PlatformSearchBatch {
  const parsed = PlatformSearchBatchSchema.safeParse(batchInput);
  if (!parsed.success) throw new PlatformSearchBatchError("invalid-batch");
  return parsed.data;
}

const paginationParameters = new Set(["page", "pageno", "page_no", "pagenum", "page_num", "currentpage", "current_page", "start", "offset", "pn"]);
function searchScope(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) if (paginationParameters.has(key.toLowerCase())) parsed.searchParams.delete(key);
    return JSON.stringify({ origin: parsed.origin, pathname: parsed.pathname, query: [...parsed.searchParams.entries()].sort() });
  } catch { return undefined; }
}

function matchesRequestedSearchScope(url: string, input: PlatformSearchInput): boolean {
  try {
    const expected = new URL(buildPlatformSearchRequest(input).url), actual = new URL(url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;
    for (const [key, value] of expected.searchParams) {
      if (paginationParameters.has(key.toLowerCase())) continue;
      const values = actual.searchParams.getAll(key);
      if (value === "" && values.length === 0) continue;
      if (values.length !== 1 || values[0] !== value) return false;
    }
    return true;
  } catch { return false; }
}

/** Creates a batch from one explicit page read. Gate/error pages are retained as diagnostics but cannot be started as a batch. */
export function createPlatformSearchBatch(input: PlatformSearchInput, sessionIdInput: string, pageInput: PlatformSearchBatchPageInput): PlatformSearchBatch {
  const parsedInput = PlatformSearchInputSchema.safeParse(input);
  if (!parsedInput.success) throw new PlatformSearchBatchError("invalid-batch");
  const page = parsePage(pageInput);
  if (page.provider !== parsedInput.data.provider) throw new PlatformSearchBatchError("scope-changed");
  if (page.status !== "ready" && page.status !== "empty") throw new PlatformSearchBatchError("unsupported-page");
  const parsedSession = sessionId.safeParse(sessionIdInput);
  if (!parsedSession.success) throw new PlatformSearchBatchError("invalid-batch");
  return PlatformSearchBatchSchema.parse({ schemaVersion: 1, sessionId: parsedSession.data, input: parsedInput.data, pages: [page], warnings: [
    "这是用户手动读取页面的部分批次；未自动翻页，也不代表平台全量覆盖。",
    ...page.warnings,
  ] });
}

/** Appends a later manually read page without silently changing the original query. */
export function appendPlatformSearchBatch(batchInput: PlatformSearchBatch, pageInput: PlatformSearchBatchPageInput): PlatformSearchBatch {
  const batch = parseBatch(batchInput), page = parsePage(pageInput);
  const last = batch.pages.at(-1)!;
  if (page.provider !== batch.input.provider || searchScope(page.pageUrl) === undefined || searchScope(page.pageUrl) !== searchScope(batch.pages[0]!.pageUrl)) throw new PlatformSearchBatchError("scope-changed");
  const normalizedPageUrl = (value: string) => { const parsed = new URL(value); parsed.hash = ""; return parsed.toString(); };
  if (batch.pages.some(existing => normalizedPageUrl(existing.pageUrl) === normalizedPageUrl(page.pageUrl))) throw new PlatformSearchBatchError("duplicate-page");
  if (page.pageIndex <= last.pageIndex) throw new PlatformSearchBatchError("page-order");
  if (page.status !== "ready" && page.status !== "empty") throw new PlatformSearchBatchError("unsupported-page");
  return PlatformSearchBatchSchema.parse({ ...batch, pages: [...batch.pages, page], warnings: [...new Set([...batch.warnings, ...page.warnings])] });
}

/** Returns the first evidenced card for each stable platform job identity. */
export function flattenPlatformSearchBatch(batchInput: PlatformSearchBatch): PlatformSearchBatchCard[] {
  const batch = parseBatch(batchInput);
  const cards: PlatformSearchBatchCard[] = [], ids = new Set<string>();
  for (const page of batch.pages) for (const card of page.cards) {
    const identity = reviewedCardIdentity(card.url, batch.input.provider);
    if (!identity || ids.has(identity.id)) continue;
    ids.add(identity.id); cards.push(card);
  }
  return cards;
}

/** Converts each ready page into the legacy reviewed-cards input for incremental confirmation. */
export function readyPlatformSearchPageCaptures(batchInput: PlatformSearchBatch): ReviewedCardsCapture[] {
  const batch = parseBatch(batchInput);
  return batch.pages.filter(page => page.status === "ready" && page.cards.length > 0).flatMap(page => {
    const cards = page.cards.filter((card): card is PlatformSearchBatchCard & { company: string } => Boolean(card.company?.trim()));
    if (!cards.length) return [];
    return [ReviewedCardsCaptureSchema.parse({
      provider: page.provider, pageUrl: page.pageUrl, capturedAt: page.capturedAt, cards,
    })];
  });
}

export type { PlatformSearchInput, PlatformSearchProvider };
