import { createHash } from "node:crypto";
import {
  defineTool, SourceDefinitionSchema, TimestampSchema, ToolError,
  type SourceDefinition, type ToolHandlerContext,
} from "@better-me/opportunities";
import {
  ImportReviewedCardsInputSchema, PreviewReviewedCardsInputSchema, ReviewedCardsPreviewSchema,
  REVIEWED_PLATFORM_NAMES, reviewedCardIdentity,
  type PreviewReviewedCardsInput, type ReviewedCardsCapture, type ReviewedCardsPreview,
} from "@better-me/source-adapters";
import type { SourceJobRecord, SourcePage } from "@better-me/source-adapters";
import { projectSourcePage } from "./projection.js";
import { type JobRepository, RepositoryError } from "./repository.js";
import { ImportReceiptSchema } from "./repository-schema.js";

const VERSION = 1;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const WARNINGS = [
  "人工核对的搜索卡片仅作为摘要入索引，不代表完整 JD、核实在招或全站覆盖。",
  "位置、薪资和发布时间保留来源原文；未提供的字段保持未知，未生成地图坐标或企业控股结论。",
  "此工具接受用户提供并核对的证据，不认证其来自受管浏览器；来源链接保留供再次核对。",
];
const entryUrls = {
  "51job": "https://we.51job.com/pc/search", boss: "https://www.zhipin.com/web/geek/job",
  liepin: "https://www.liepin.com/zhaopin/", linkedin: "https://www.linkedin.com/jobs/search",
  seek: "https://www.seek.com.au/jobs", indeed: "https://www.indeed.com/jobs",
  gradconnection: "https://au.gradconnection.com/jobs/",
} as const;

/** A metadata-only reserved source: no sync adapter or network permission is installed by import. */
export function reviewedCardsSource(provider: ReviewedCardsCapture["provider"]): SourceDefinition {
  const platform = REVIEWED_PLATFORM_NAMES[provider];
  return SourceDefinitionSchema.parse({
    sourceId: `reviewed-platform-${provider}`, name: `${platform} · 人工核对卡片`,
    adapterId: "reviewed-browser-cards", adapterVersion: String(VERSION), capabilities: [],
    runtime: ["browser-companion"], entityType: "job-posting", enabled: false, status: "disabled",
    entryUrl: entryUrls[provider], remoteFilters: [],
    endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: platform, homepageUrl: entryUrls[provider], usage: "metadata", requiresAttribution: true,
      notes: "用户明确核对的搜索卡片摘要；不是平台授权接口，不认证浏览器采集、完整职位描述或在招状态。" },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 50, maxPages: 1, requestsPerMinute: 1 },
  });
}

/** No geocoding, salary inference, country inference or relative-time conversion occurs here. */
export function reviewedCardsPage(capture: ReviewedCardsCapture): SourcePage {
  const records: SourceJobRecord[] = capture.cards.map((card) => {
    const identity = reviewedCardIdentity(card.url, capture.provider);
    if (!identity) throw new ToolError("invalid-input");
    const mapping = { url: "url", title: "title", company: "companyName", locationText: "locations", salaryText: "compensations", publicationText: "sourcePublishedRaw" };
    return {
      entityType: "job-posting", sourceRecordId: identity.id, url: identity.url,
      title: card.title, companyName: card.company, description: card.cardText,
      locations: card.locationText ? [{ raw: card.locationText }] : [],
      compensations: card.salaryText ? [{ raw: card.salaryText, period: "unknown", tax: "unknown", kind: "unknown" }] : [],
      workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [],
      availability: "unknown", completeness: "excerpt",
      evidence: [
        ...card.evidence.fields.map((field) => ({ field: mapping[field.field], selector: field.selector, quote: field.text, sourceUrl: capture.pageUrl })),
        { field: "description", selector: card.evidence.cardSelector, quote: card.cardText, sourceUrl: capture.pageUrl },
      ],
      ...(card.publicationText ? { sourcePublishedRaw: card.publicationText,
        ...(TimestampSchema.safeParse(card.publicationText).success ? { sourcePublishedAt: card.publicationText } : {}) } : {}),
      warnings: [...WARNINGS],
    };
  });
  return { records, observedAt: capture.capturedAt,
    coverage: { complete: false, partial: true, fetchedRecords: records.length, appliedFilters: [], ignoredFilters: [] },
    warnings: [...WARNINGS],
  };
}

const previewInput = (input: PreviewReviewedCardsInput) => PreviewReviewedCardsInputSchema.parse({
  provider: input.provider, pageUrl: input.pageUrl, capturedAt: input.capturedAt, cards: input.cards, expectedRevision: input.expectedRevision,
});
export const reviewedCardsPreviewFingerprint = (input: PreviewReviewedCardsInput) => digest({ version: VERSION, input: previewInput(input) });

export function createReviewedCardsTools(options: { repository: JobRepository; now?: () => string }) {
  const repository = options.repository;
  const now = options.now ?? (() => new Date().toISOString());
  function assertCaptureTime(capture: ReviewedCardsCapture) {
    const current = TimestampSchema.safeParse(now());
    if (!current.success || Date.parse(capture.capturedAt) > Date.parse(current.data) + 5 * 60_000) throw new ToolError("invalid-input");
  }
  async function prepare(input: PreviewReviewedCardsInput, context: ToolHandlerContext) {
    context.throwIfCancelled();
    assertCaptureTime(input);
    const before = await repository.readProjectionSnapshot();
    context.throwIfCancelled();
    if (before.revision !== input.expectedRevision) throw new ToolError("stale-version");
    const source = reviewedCardsSource(input.provider);
    const existingSource = before.sources.find((entry) => entry.sourceId === source.sourceId);
    if (existingSource && digest(existingSource) !== digest(source)) throw new ToolError("source-changed");
    for (const card of input.cards) {
      const identity = reviewedCardIdentity(card.url, input.provider)!;
      const existing = before.listings.find((entry) => entry.sourceId === source.sourceId && entry.sourceRecordId === identity.id);
      if (existing?.recordLastSeenAt && Date.parse(existing.recordLastSeenAt) > Date.parse(input.capturedAt)) throw new ToolError("stale-version");
    }
    const fingerprint = reviewedCardsPreviewFingerprint(input);
    // A captured page is independent of the selected subset and its review order.
    // projectSourcePage adds each listing identity and record signature to its
    // observation ID, so changed card content still appends its own evidence.
    const captureFingerprint = digest({ version: VERSION, provider: input.provider, pageUrl: input.pageUrl, capturedAt: input.capturedAt });
    const projection = await projectSourcePage(before, source, reviewedCardsPage(input), `reviewed-cards:${captureFingerprint}`, { mode: "user-reviewed-browser" });
    context.throwIfCancelled();
    // A location label may describe an area or remote eligibility; it is not office evidence.
    for (const location of projection.delta.locations) location.kind = "unknown";
    const cards: ReviewedCardsPreview["cards"] = input.cards.map((card) => {
      const identity = reviewedCardIdentity(card.url, input.provider)!;
      const listing = projection.delta.listings.find((entry) => entry.sourceRecordId === identity.id)
        ?? before.listings.find((entry) => entry.sourceId === source.sourceId && entry.sourceRecordId === identity.id);
      if (!listing?.canonicalJobId) throw new ToolError("invalid-output");
      return { jobId: listing.canonicalJobId, listingId: listing.id, url: identity.url, title: card.title, company: card.company,
        ...(card.locationText ? { locationText: card.locationText } : {}), ...(card.salaryText ? { salaryText: card.salaryText } : {}),
        ...(card.publicationText ? { publicationText: card.publicationText } : {}), existing: before.listings.some((entry) => entry.id === listing.id) };
    });
    const preview = ReviewedCardsPreviewSchema.parse({ expectedRevision: before.revision, previewFingerprint: fingerprint, sourceId: source.sourceId,
      completeness: "excerpt", availability: "unknown", cards, warnings: WARNINGS });
    return { projection, preview };
  }
  return [
    defineTool({ name: "jobs.preview-reviewed-cards", version: VERSION, effect: "read-index",
      description: "预览用户提供并核对的四平台搜索卡片摘要及稳定岗位身份，不联网、不写索引、不认证采集来源。",
      inputSchema: PreviewReviewedCardsInputSchema, outputSchema: ReviewedCardsPreviewSchema,
      execute: async (input, context) => (await prepare(input, context)).preview,
    }),
    defineTool({ name: "jobs.import-reviewed-cards", version: VERSION, effect: "local-write",
      description: "明确核对后将四平台卡片摘要写入统一岗位索引；要求预览指纹、索引版本及持久幂等键，保留未知字段。",
      inputSchema: ImportReviewedCardsInputSchema, outputSchema: ImportReceiptSchema,
      execute: async (input, context) => {
        context.throwIfCancelled();
        if (!context.idempotencyKey) throw new ToolError("invalid-context");
        const checkedInput = previewInput(input);
        if (reviewedCardsPreviewFingerprint(checkedInput) !== input.previewFingerprint) throw new ToolError("stale-version");
        const idempotencyKey = `reviewed-cards:${digest(context.idempotencyKey)}`;
        const requestFingerprint = digest({ version: VERSION, input });
        const importOptions = { actorScope: context.actorScope, idempotencyKey, requestFingerprint, expectedRevision: input.expectedRevision };
        const cached = await repository.findImportReceipt(importOptions);
        context.throwIfCancelled();
        if (cached) return cached;
        const { projection } = await prepare(checkedInput, context);
        context.throwIfCancelled();
        try { return await repository.importSnapshot(projection.delta, importOptions); }
        catch (error) {
          // A concurrent retry can commit after our receipt lookup but before CAS.
          // Recover only this exact request; never recompute against a newer revision.
          if (!(error instanceof RepositoryError) || error.code !== "stale-version") throw error;
          context.throwIfCancelled();
          const committed = await repository.findImportReceipt(importOptions);
          if (!committed) throw error;
          return committed;
        }
      },
    }),
  ] as const;
}
