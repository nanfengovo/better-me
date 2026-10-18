import { z } from "zod";
import { EntityIdSchema, RevisionSchema, TimestampSchema } from "@better-me/opportunities";
import { PlatformSearchProviderSchema, type PlatformSearchProvider, type PlatformSearchJobPlatform } from "./platform-search.js";

export const REVIEWED_PLATFORM_NAMES: Readonly<Record<PlatformSearchProvider, PlatformSearchJobPlatform>> = {
  "51job": "51JOB", boss: "BOSS直聘", liepin: "猎聘", linkedin: "LinkedIn",
};

// Keep these exact hosts and single-job patterns aligned with the browser reader's
// allowedJobUrl/detailIdentity rules. A share wrapper or search page is not a job.
const hosts: Readonly<Record<PlatformSearchProvider, readonly string[]>> = {
  "51job": ["51job.com", "www.51job.com", "jobs.51job.com", "m.51job.com", "msearch.51job.com", "we.51job.com", "q.51job.com"],
  boss: ["zhipin.com", "www.zhipin.com", "m.zhipin.com"],
  liepin: ["liepin.com", "www.liepin.com", "m.liepin.com"],
  linkedin: ["linkedin.com", "www.linkedin.com", "cn.linkedin.com", "m.linkedin.com", "uk.linkedin.com", "de.linkedin.com", "fr.linkedin.com", "au.linkedin.com", "ca.linkedin.com", "sg.linkedin.com", "hk.linkedin.com", "jp.linkedin.com", "in.linkedin.com", "nl.linkedin.com", "tw.linkedin.com", "ae.linkedin.com", "nz.linkedin.com", "ie.linkedin.com", "lnkd.in"],
};
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value), "Expected plain visible text.");
const urlText = text(4096);
const visibleText = z.string().trim().min(1).max(10_000)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value.replace(/[\n\r\t]/gu, "")), "Expected a visible card excerpt.");
const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();

function officialUrl(input: string, provider: PlatformSearchProvider): URL | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts[provider].includes(url.hostname)) return;
    url.hash = "";
    return url;
  } catch { return; }
}

/** The platform plus its actual single-job ID is stable across tracking URLs and title slugs. */
export function reviewedCardIdentity(input: string, provider: PlatformSearchProvider): { id: string; url: string } | undefined {
  const url = officialUrl(input, provider);
  if (!url) return;
  const patterns: Record<PlatformSearchProvider, RegExp[]> = {
    boss: [/^\/job_detail\/([a-z\d_-]+)\.html\/?$/i, /^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i],
    liepin: [/^\/job\/(\d+)\.shtml\/?$/i],
    "51job": [/^\/jobs\/(?:[^/]+\/)*(\d+)\.html\/?$/i, ...(url.hostname === "jobs.51job.com" ? [/^\/(?!jobs\/)[^/]+\/(\d+)\.html\/?$/i] : [])],
    linkedin: [/^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/i],
  };
  for (const pattern of patterns[provider]) {
    const id = url.pathname.match(pattern)?.[1];
    if (id) return { id, url: url.toString() };
  }
}

export function reviewedCardsSearchPage(input: string, provider: PlatformSearchProvider): string | undefined {
  const url = officialUrl(input, provider);
  const patterns: Record<PlatformSearchProvider, RegExp> = {
    "51job": /^\/pc\/search\/?$/i,
    boss: /^(?:\/web\/geek\/jobs?\/?|\/c\d{9}\/)$/i,
    liepin: /^(?:\/zhaopin\/?|\/city-[a-z]+\/)$/i,
    linkedin: /^\/jobs\/search\/?$/i,
  };
  return url && patterns[provider].test(url.pathname) ? url.toString() : undefined;
}

export const ReviewedSearchCardSchema = z.object({
  platform: z.enum(["51JOB", "BOSS直聘", "猎聘", "LinkedIn"]),
  url: urlText,
  title: text(500),
  company: text(500),
  locationText: text(1000).optional(),
  salaryText: text(1000).optional(),
  publicationText: text(1000).optional(),
  cardText: visibleText,
  evidence: z.object({
    pageUrl: urlText,
    cardSelector: text(300),
    fields: z.array(z.object({
      field: z.enum(["url", "title", "company", "locationText", "salaryText", "publicationText"]),
      selector: text(300), text: text(4096),
    }).strict()).min(3).max(6),
  }).strict(),
}).strict();
export type ReviewedSearchCard = z.infer<typeof ReviewedSearchCardSchema>;

const captureShape = {
  provider: PlatformSearchProviderSchema,
  pageUrl: urlText,
  capturedAt: TimestampSchema,
  cards: z.array(ReviewedSearchCardSchema).min(1).max(50),
};
type CaptureShape = z.infer<z.ZodObject<typeof captureShape>>;
function validateCapture(capture: CaptureShape, context: z.RefinementCtx): void {
  const pageUrl = reviewedCardsSearchPage(capture.pageUrl, capture.provider);
  if (!pageUrl) context.addIssue({ code: z.ZodIssueCode.custom, path: ["pageUrl"], message: "Expected this provider's official search page." });
  const identities = new Set<string>();
  capture.cards.forEach((card, index) => {
    const issue = (field: string, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ["cards", index, field], message });
    if (card.platform !== REVIEWED_PLATFORM_NAMES[capture.provider]) issue("platform", "Provider and card platform must agree.");
    const identity = reviewedCardIdentity(card.url, capture.provider);
    if (!identity) issue("url", "Expected an allowed official single-job URL.");
    else if (identities.has(identity.id)) issue("url", "A job may only occur once per review.");
    else identities.add(identity.id);
    if (!pageUrl || reviewedCardsSearchPage(card.evidence.pageUrl, capture.provider) !== pageUrl) issue("evidence", "Card evidence must refer to the supplied search page.");
    const names = new Set<string>();
    for (const field of card.evidence.fields) {
      if (names.has(field.field)) issue("evidence", "Field evidence must be unique.");
      names.add(field.field);
      const value = card[field.field];
      if (value === undefined || normalized(field.text) !== normalized(value)) issue("evidence", "Field evidence must reproduce its visible value.");
    }
    for (const name of ["url", "title", "company", "locationText", "salaryText", "publicationText"] as const) {
      const value = card[name];
      if (value !== undefined && !names.has(name)) issue("evidence", "Every supplied field requires matching card evidence.");
      if (name !== "url" && value !== undefined && !normalized(card.cardText).includes(normalized(value))) issue(name, "A field must occur in the supplied visible card excerpt.");
    }
    if (card.publicationText && /更新|活跃|在线|上线|回复|刷新|updated?|active|replied|viewed|promoted/i.test(card.publicationText)) issue("publicationText", "Activity or update labels are not publication evidence.");
  });
}

/** User-supplied evidence reviewed by the user; this schema does not certify browser capture or a vacancy. */
export const ReviewedCardsCaptureSchema = z.object(captureShape).strict().superRefine(validateCapture);
export type ReviewedCardsCapture = z.infer<typeof ReviewedCardsCaptureSchema>;
export const PreviewReviewedCardsInputSchema = z.object({ ...captureShape, expectedRevision: RevisionSchema }).strict().superRefine(validateCapture);
export type PreviewReviewedCardsInput = z.infer<typeof PreviewReviewedCardsInputSchema>;
export const ImportReviewedCardsInputSchema = z.object({
  ...captureShape, expectedRevision: RevisionSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true),
}).strict().superRefine(validateCapture);
export type ImportReviewedCardsInput = z.infer<typeof ImportReviewedCardsInputSchema>;

export const ReviewedCardsPreviewSchema = z.object({
  expectedRevision: RevisionSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceId: EntityIdSchema,
  completeness: z.literal("excerpt"), availability: z.literal("unknown"),
  cards: z.array(z.object({
    jobId: EntityIdSchema, listingId: EntityIdSchema, url: urlText, title: text(500), company: text(500),
    locationText: text(1000).optional(), salaryText: text(1000).optional(), publicationText: text(1000).optional(),
    existing: z.boolean(),
  }).strict()).min(1).max(50),
  warnings: z.array(text(2000)).min(1).max(20),
}).strict();
export type ReviewedCardsPreview = z.infer<typeof ReviewedCardsPreviewSchema>;
