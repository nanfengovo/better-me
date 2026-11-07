import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AtlasDatasetObjectSchema, defineTool, deriveEntityId, JobLocationSchema, TimestampSchema, ToolError,
  type JobLocation, type ToolHandlerContext,
} from "@better-me/opportunities";
import {
  ReadOwnedDetailLocationsInputSchema, OwnedDetailLocationsCaptureSchema,
  PreviewOwnedDetailLocationsInputSchema, ImportOwnedDetailLocationsInputSchema, DetailLocationsPreviewSchema,
  type ReadOwnedDetailLocationsInput, type PreviewOwnedDetailLocationsInput, type ImportOwnedDetailLocationsInput,
  type OwnedDetailLocationsCapture, type SourceRegistry, type SourceTransport,
} from "@better-me/source-adapters";
import { emptyDelta } from "./projection.js";
import { RepositoryError, type JobRepository } from "./repository.js";
import { ImportReceiptSchema } from "./repository-schema.js";

const VERSION = 1;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  return value;
}
const json = (value: unknown) => JSON.stringify(stable(value));
const digest = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const WARNINGS = [
  "本机按原来源协议读取当前岗位的原编号和原链接；不认证企业归属、在招状态或办公关系。",
  "仅补充本人核对的来源地点；本次不替换JD、标题、公司、薪资、工作方式或其他来源贡献，也不把读取时间作为发布时间。",
  "街道和邮编仍是未经独立核实的来源披露，不生成坐标或已确认办公室；远程披露仅保留为远程资格范围。",
  "保存将替换此来源的旧地点贡献，依赖旧地点的行政或办公确认可能失效，需要重新核对。",
];
function checkedPreview(value: unknown): PreviewOwnedDetailLocationsInput {
  const parsed = PreviewOwnedDetailLocationsInputSchema.safeParse(value);
  if (!parsed.success) throw new ToolError("invalid-input");
  return parsed.data;
}
const previewInput = (input: PreviewOwnedDetailLocationsInput) => checkedPreview({ jobId: input.jobId, listingId: input.listingId,
  expectedRevision: input.expectedRevision, capture: input.capture });
const fingerprint = (input: PreviewOwnedDetailLocationsInput) => digest({ version: VERSION, input: previewInput(input) });
function writeOptions(input: ImportOwnedDetailLocationsInput, context: ToolHandlerContext) {
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, expectedRevision: input.expectedRevision,
    idempotencyKey: `owned-detail-locations:${digest(context.idempotencyKey)}`, requestFingerprint: digest({ version: VERSION, input }) };
}

/** Source configuration and execution code stay host-owned. Network reads and reviewed writes are separate tools. */
export function createOwnedDetailLocationsTools(options: { repository: JobRepository; sources: SourceRegistry; transport: SourceTransport; now?: () => string }) {
  const { repository, sources, transport } = options;
  const now = options.now ?? (() => new Date().toISOString());
  // Transient read proofs are intentionally not persisted as credentials. A restart
  // requires another read for uncommitted captures; durable committed receipts remain recoverable.
  const proofKey = randomBytes(32);
  const readSessionId = randomBytes(16).toString("hex");
  let lastReadSequence = 0;
  const sign = (capture: Omit<OwnedDetailLocationsCapture, "proof">) => createHmac("sha256", proofKey).update(json(capture)).digest("hex");
  function authentic(capture: OwnedDetailLocationsCapture) {
    const { proof, ...value } = capture;
    return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(sign(value), "hex"));
  }
  async function target(input: ReadOwnedDetailLocationsInput, context: ToolHandlerContext, expectedSourceFingerprint?: string) {
    context.throwIfCancelled();
    const before = await repository.readProjectionSnapshot();
    context.throwIfCancelled();
    if (before.revision !== input.expectedRevision) throw new ToolError("stale-version");
    const listing = before.listings.find(entry => entry.id === input.listingId);
    const source = before.sources.find(entry => entry.sourceId === listing?.sourceId);
    const job = before.jobs.find(entry => entry.id === listing?.canonicalJobId && entry.listingIds.includes(input.listingId));
    if (!listing || !source || !job || !listing.locationIds || !listing.sourceRecordId || !listing.canonicalUrl) throw new ToolError("invalid-input");
    if (expectedSourceFingerprint && digest(source) !== expectedSourceFingerprint) throw new ToolError("source-changed");
    const [requested, owner] = await Promise.all([
      repository.resolveJobId(input.jobId, { atRevision: before.revision }),
      repository.resolveJobId(job.id, { atRevision: before.revision }),
    ]);
    context.throwIfCancelled();
    if (!requested || !owner || requested.canonicalJobId !== owner.canonicalJobId || requested.canonicalJobId !== input.jobId) throw new ToolError("invalid-input");
    if (requested.snapshotRevision !== before.revision || owner.snapshotRevision !== before.revision) throw new ToolError("stale-version");
    if (source.entityType !== "job-posting" || !sources.resolve(source, "list-jobs", "local-service").adapter.readDetail) throw new ToolError("unsupported-capability");
    if (source.secretRef) throw new ToolError("needs-auth");
    return { before, listing, source, job };
  }
  async function prepare(raw: PreviewOwnedDetailLocationsInput, context: ToolHandlerContext) {
    const input = previewInput(raw), { capture } = input;
    context.throwIfCancelled();
    if (!authentic(capture)) throw new ToolError("source-changed");
    const time = TimestampSchema.safeParse(now());
    if (!time.success || Date.parse(capture.observedAt) > Date.parse(time.data) + 300_000) throw new ToolError("invalid-input");
    const { before, listing, source, job } = await target(input, context, capture.sourceFingerprint);
    if (source.sourceId !== capture.sourceId || digest(source) !== capture.sourceFingerprint) throw new ToolError("source-changed");
    if (listing.sourceRecordId !== capture.sourceRecordId || listing.canonicalUrl !== capture.url) throw new ToolError("invalid-input");
    const times = [listing.recordLastSeenAt, ...before.observations.filter(entry => entry.listingId === listing.id)
      .flatMap(entry => [entry.fetchedAt, entry.detailFetchedAt])].filter((value): value is string => Boolean(value));
    if (times.some(value => Date.parse(value) > Date.parse(capture.observedAt))) throw new ToolError("stale-version");
    // Wall-clock timestamps can be equal for distinct parallel reads. An older
    // unsaved read cannot replace a later adopted read from this host session.
    for (const observation of before.observations.filter(entry => entry.listingId === listing.id && entry.rawText)) {
      let value: unknown;
      try { value = JSON.parse(observation.rawText!); } catch { continue; }
      const previous = OwnedDetailLocationsCaptureSchema.safeParse(value);
      if (previous.success && previous.data.readSessionId === capture.readSessionId && previous.data.readSequence > capture.readSequence
        && authentic(previous.data)) throw new ToolError("stale-version");
    }
    const record = capture.record;
    // An absent location is not proof that the original address ceased to apply.
    if (!record.locations.length || record.locations.length > 20) throw new ToolError("invalid-input");
    const evidence = record.evidence.filter(entry => entry.field === "locations" || entry.field.startsWith("locations."));
    if (!evidence.length || evidence.length > 200) throw new ToolError("source-changed");
    const observationId = await deriveEntityId("observation", [listing.id, "owned-detail-locations", digest(capture)]);
    const locations: JobLocation[] = [];
    for (const address of record.locations) {
      const kind = record.workMode === "remote" ? "remote-region" : "office";
      const id = await deriveEntityId("location", [listing.id, "owned-detail-locations", digest({ ...address, kind })]);
      const location = JobLocationSchema.parse({ ...address, id, kind,
        precision: address.city ? "city" : address.region ? "region" : address.countryCode ? "country" : "unknown",
        verification: "unverified", evidence: evidence.map(({ sourceUrl, selector, quote }) => ({ observationId, sourceUrl,
          observedAt: capture.observedAt, ...(selector ? { selector } : {}), ...(quote ? { quote } : {}) })) });
      if (!locations.some(entry => entry.id === id)) locations.push(location);
    }
    const previousLocationIds = [...listing.locationIds!];
    const otherContributions = new Set(before.listings.filter(entry => entry.id !== listing.id && job.listingIds.includes(entry.id)).flatMap(entry => entry.locationIds ?? []));
    const locationIds = unique([...job.locationIds.filter(id => !previousLocationIds.includes(id) || otherContributions.has(id)), ...locations.map(entry => entry.id)]);
    if (before.compensations.some(entry => job.compensationIds.includes(entry.id) && entry.locationIds?.some(id => !locationIds.includes(id)))) throw new ToolError("source-changed");
    const delta = emptyDelta(before.revision);
    if (!before.observations.some(entry => entry.id === observationId)) {
      delta.locations.push(...locations);
      const changed = json(job.locationIds) !== json(locationIds);
      delta.jobs.push({ ...job, locationIds, ...(changed ? { revision: job.revision + 1,
        updatedAt: Date.parse(job.updatedAt) > Date.parse(capture.observedAt) ? job.updatedAt : capture.observedAt } : {}) });
      delta.listings.push({ ...listing, locationIds: locations.map(entry => entry.id), observationIds: unique([...listing.observationIds, observationId]) });
      const rawText = json(capture);
      delta.observations.push({ id: observationId, listingId: listing.id, fetchedAt: capture.observedAt, detailFetchedAt: capture.observedAt,
        result: "partial", availability: "unknown", completeness: "excerpt", rawText,
        contentHash: createHash("sha256").update(rawText).digest("hex"), warnings: [...WARNINGS] });
    } else {
      const sameLocations = listing.locationIds!.length === locations.length && listing.locationIds!.every(id => locations.some(location => location.id === id));
      if (!sameLocations || locations.some(location => !job.locationIds.includes(location.id))) throw new ToolError("stale-version");
      delta.jobs.push(job); delta.listings.push(listing);
    }
    context.throwIfCancelled();
    const preview = DetailLocationsPreviewSchema.parse({ jobId: input.jobId, listingId: listing.id, sourceId: source.sourceId,
      expectedRevision: before.revision, previewFingerprint: fingerprint(input), newLocations: locations, previousLocationIds, warnings: WARNINGS });
    return { delta: AtlasDatasetObjectSchema.parse(delta), preview };
  }
  async function receipt(input: ImportOwnedDetailLocationsInput, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const result = await repository.findImportReceipt(writeOptions(input, context));
    context.throwIfCancelled();
    return result;
  }
  return [
    defineTool({ name: "jobs.read-owned-detail-locations", version: VERSION, effect: "external-read",
      description: "按当前规范岗位和原listing精确读取原官网来源同岗详情；不扫描整源、不接收任意URL、不写索引或生成坐标。",
      inputSchema: ReadOwnedDetailLocationsInputSchema, outputSchema: OwnedDetailLocationsCaptureSchema,
      execute: async (input, context) => {
        const parsed = ReadOwnedDetailLocationsInputSchema.safeParse(input);
        if (!parsed.success) throw new ToolError("invalid-input");
        const { listing, source } = await target(parsed.data, context);
        const time = TimestampSchema.safeParse(now());
        if (!time.success) throw new ToolError("invalid-context");
        const readSequence = ++lastReadSequence;
        if (!Number.isSafeInteger(readSequence)) throw new ToolError("invalid-context");
        const record = await sources.readDetail({ source, sourceRecordId: listing.sourceRecordId!, url: listing.canonicalUrl!,
          context: { ...context, observedAt: time.data }, transport });
        context.throwIfCancelled();
        // Network time cannot authorize a stale revision or a changed source/listing/alias.
        const current = await target(parsed.data, context, digest(source));
        if (digest(current.source) !== digest(source) || current.listing.sourceRecordId !== listing.sourceRecordId || current.listing.canonicalUrl !== listing.canonicalUrl) throw new ToolError("source-changed");
        const capture = { schemaVersion: 1 as const, jobId: input.jobId, listingId: listing.id, sourceId: source.sourceId,
          sourceFingerprint: digest(source), sourceRecordId: listing.sourceRecordId!, url: listing.canonicalUrl!, observedAt: time.data, record };
        const orderedCapture = { ...capture, readSessionId, readSequence };
        return OwnedDetailLocationsCaptureSchema.parse({ ...orderedCapture, proof: sign(orderedCapture) });
      } }),
    defineTool({ name: "jobs.preview-owned-detail-locations", version: VERSION, effect: "read-index",
      description: "预览本宿主刚读取的原官网同岗位地点；校验来源/岗位/证据签名，仅补地点，不联网或写入。",
      inputSchema: PreviewOwnedDetailLocationsInputSchema, outputSchema: DetailLocationsPreviewSchema,
      execute: async (input, context) => (await prepare(input, context)).preview }),
    defineTool({ name: "jobs.import-owned-detail-locations", version: VERSION, effect: "local-write",
      description: "本人明确核对后只保存原官网同岗位地点，保留其他事实、其他来源和耐久幂等回执。",
      inputSchema: ImportOwnedDetailLocationsInputSchema, outputSchema: ImportReceiptSchema, recoverInterrupted: receipt,
      execute: async (input, context) => {
        context.throwIfCancelled();
        const parsed = ImportOwnedDetailLocationsInputSchema.safeParse(input);
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
