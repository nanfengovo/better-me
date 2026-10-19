import { createHash } from "node:crypto";
import {
  AtlasDatasetObjectSchema, defineTool, deriveEntityId, JobLocationSchema, TimestampSchema, ToolError,
  type JobLocation, type ToolHandlerContext,
} from "@better-me/opportunities";
import {
  PreviewDetailLocationsInputSchema, ImportDetailLocationsInputSchema, DetailLocationsPreviewSchema,
  reviewedCardIdentity, type PreviewDetailLocationsInput, type ImportDetailLocationsInput,
} from "@better-me/source-adapters";
import { emptyDelta } from "./projection.js";
import { reviewedCardsSource } from "./reviewed-cards.js";
import { RepositoryError, type JobRepository } from "./repository.js";
import { ImportReceiptSchema } from "./repository-schema.js";

const VERSION = 1;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
const json = (value: unknown) => JSON.stringify(stable(value));
const digest = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const WARNINGS = [
  "仅补充本人核对的同平台同岗位详情地点；不认证浏览器来源、雇主关联或在招状态。",
  "本次不替换 JD 正文、岗位名称、薪资、公司或其他来源事实，也不将读取时间作为发布时间。",
  "来源地点仍待核实，不生成坐标；街道和邮编不等于已确认办公室。保存后可继续核对办公地址。",
  "本来源的旧地点贡献将被替换；依赖旧来源地点的行政或办公确认可能失效，需要重新核对。",
];
function checkedInput(value: unknown): PreviewDetailLocationsInput {
  const parsed = PreviewDetailLocationsInputSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("invalid-input");
  return parsed.data;
}
const previewInput = (input: PreviewDetailLocationsInput) => checkedInput({ jobId: input.jobId, listingId: input.listingId,
  expectedRevision: input.expectedRevision, capture: input.capture });
const fingerprint = (input: PreviewDetailLocationsInput) => digest({ version: VERSION, input: previewInput(input) });
function writeOptions(input: ImportDetailLocationsInput, context: ToolHandlerContext) {
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, expectedRevision: input.expectedRevision,
    idempotencyKey: `detail-locations:${digest(context.idempotencyKey)}`, requestFingerprint: digest({ version: VERSION, input }) };
}

/** Location-only evidence uses the original public repository, leaving selected JD snapshots untouched. */
export function createReviewedDetailLocationsTools(options: { repository: JobRepository; now?: () => string }) {
  const { repository } = options;
  const now = options.now ?? (() => new Date().toISOString());
  async function prepare(raw: PreviewDetailLocationsInput, context: ToolHandlerContext) {
    const input = previewInput(raw), { capture } = input;
    context.throwIfCancelled();
    const currentTime = TimestampSchema.safeParse(now());
    if (!currentTime.success || Date.parse(capture.capturedAt) > Date.parse(currentTime.data) + 300_000) throw new ToolError("invalid-input");
    const before = await repository.readProjectionSnapshot();
    context.throwIfCancelled();
    if (before.revision !== input.expectedRevision) throw new ToolError("stale-version");
    const source = reviewedCardsSource(capture.provider);
    const storedSource = before.sources.find(entry => entry.sourceId === source.sourceId);
    if (!storedSource || digest(storedSource) !== digest(source)) throw new ToolError("source-changed");
    const identity = reviewedCardIdentity(capture.url, capture.provider);
    const listing = before.listings.find(entry => entry.id === input.listingId);
    const canonicalIdentity = listing?.canonicalUrl && reviewedCardIdentity(listing.canonicalUrl, capture.provider);
    if (!identity || !listing || listing.sourceId !== source.sourceId || listing.sourceRecordId !== identity.id
      || !canonicalIdentity || canonicalIdentity.id !== identity.id || !listing.canonicalJobId || !listing.locationIds) throw new ToolError("invalid-input");
    const job = before.jobs.find(entry => entry.id === listing.canonicalJobId && entry.listingIds.includes(listing.id));
    if (!job) throw new ToolError("invalid-input");
    const [requested, owner] = await Promise.all([
      repository.resolveJobId(input.jobId, { atRevision: before.revision }),
      repository.resolveJobId(job.id, { atRevision: before.revision }),
    ]);
    context.throwIfCancelled();
    if (!requested || !owner || requested.canonicalJobId !== owner.canonicalJobId || requested.canonicalJobId !== input.jobId) throw new ToolError("invalid-input");
    if (requested.snapshotRevision !== before.revision || owner.snapshotRevision !== before.revision) throw new ToolError("stale-version");
    if (listing.recordLastSeenAt && Date.parse(listing.recordLastSeenAt) > Date.parse(capture.capturedAt)) throw new ToolError("stale-version");
    const observationId = await deriveEntityId("observation", [listing.id, "reviewed-detail-locations", digest(capture)]);
    const locations: JobLocation[] = [];
    for (const { evidence, ...address } of capture.locations) {
      const kind = capture.workMode === "remote" ? "remote-region" : "office";
      const id = await deriveEntityId("location", [listing.id, "reviewed-detail-locations", digest({ ...address, kind })]);
      const location = JobLocationSchema.parse({ ...address, id, kind,
        precision: address.city ? "city" : address.region ? "region" : address.countryCode ? "country" : "unknown",
        verification: "unverified", evidence: [{ observationId, sourceUrl: capture.url, observedAt: capture.capturedAt, ...evidence }] });
      const existing = locations.find(entry => entry.id === id);
      if (existing) existing.evidence.push(...location.evidence.filter(entry => !existing.evidence.some(prior => digest(prior) === digest(entry))));
      else locations.push(location);
    }
    const previousLocationIds = [...listing.locationIds];
    const otherContributions = new Set(before.listings.filter(entry => entry.id !== listing.id && job.listingIds.includes(entry.id)).flatMap(entry => entry.locationIds ?? []));
    const locationIds = unique([...job.locationIds.filter(id => !previousLocationIds.includes(id) || otherContributions.has(id)), ...locations.map(entry => entry.id)]);
    if (before.compensations.some(entry => job.compensationIds.includes(entry.id) && entry.locationIds?.some(id => !locationIds.includes(id)))) throw new ToolError("source-changed");
    const delta = emptyDelta(before.revision);
    // The same capture is immutable and independent of a new preview or another idempotency key.
    // Replaying it cannot replace a later address or attach another observation.
    if (!before.observations.some(entry => entry.id === observationId)) {
      delta.locations.push(...locations);
      const changed = json(job.locationIds) !== json(locationIds);
      delta.jobs.push({ ...job, locationIds, ...(changed ? { revision: job.revision + 1,
        updatedAt: Date.parse(job.updatedAt) > Date.parse(capture.capturedAt) ? job.updatedAt : capture.capturedAt } : {}) });
      delta.listings.push({ ...listing, locationIds: locations.map(entry => entry.id), recordLastSeenAt: capture.capturedAt,
        observationIds: unique([...listing.observationIds, observationId]) });
      const rawText = json(capture);
      delta.observations.push({ id: observationId, listingId: listing.id, fetchedAt: capture.capturedAt, detailFetchedAt: capture.capturedAt,
        result: "partial", availability: "unknown", completeness: "excerpt", rawText,
        contentHash: createHash("sha256").update(rawText).digest("hex"), warnings: [...WARNINGS] });
    } else {
      const sameLocations = listing.locationIds.length === locations.length && listing.locationIds.every(id => locations.some(location => location.id === id));
      if (!sameLocations || locations.some(location => !job.locationIds.includes(location.id))) throw new ToolError("stale-version");
      // Keep a no-op receipt bound to the same existing canonical job. A historical
      // capture whose current contribution differs can never pretend to reapply it.
      delta.jobs.push(job); delta.listings.push(listing);
    }
    const preview = DetailLocationsPreviewSchema.parse({ jobId: input.jobId, listingId: listing.id, sourceId: source.sourceId,
      expectedRevision: before.revision, previewFingerprint: fingerprint(input), newLocations: locations, previousLocationIds, warnings: WARNINGS });
    return { delta: AtlasDatasetObjectSchema.parse(delta), preview };
  }
  async function receipt(input: ImportDetailLocationsInput, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const result = await repository.findImportReceipt(writeOptions(input, context));
    context.throwIfCancelled();
    return result;
  }
  return [
    defineTool({ name: "jobs.preview-detail-locations", version: VERSION, effect: "read-index",
      description: "预览已入库四平台同岗位详情地址的受审补充；不联网、不创建岗位、不替换JD或推测坐标。",
      inputSchema: PreviewDetailLocationsInputSchema, outputSchema: DetailLocationsPreviewSchema,
      execute: async (input, context) => (await prepare(input, context)).preview }),
    defineTool({ name: "jobs.import-detail-locations", version: VERSION, effect: "local-write",
      description: "本人明确核对后将同平台同岗位详情地点写回原公共索引，保留其他事实和耐久回执。",
      inputSchema: ImportDetailLocationsInputSchema, outputSchema: ImportReceiptSchema,
      recoverInterrupted: receipt,
      execute: async (input, context) => {
        context.throwIfCancelled();
        const parsed = ImportDetailLocationsInputSchema.safeParse(input);
        if (!parsed.success) throw new ToolError("invalid-input");
        if (fingerprint(input) !== input.previewFingerprint) throw new ToolError("stale-version");
        const cached = await receipt(input, context); if (cached) return cached;
        const { delta } = await prepare(input, context);
        context.throwIfCancelled();
        try { return await repository.importSnapshot(delta, writeOptions(input, context)); }
        catch (error) {
          if (!(error instanceof RepositoryError) || error.code !== "stale-version") throw error;
          const committed = await receipt(input, context); if (!committed) throw error;
          return committed;
        }
      } }),
  ] as const;
}
