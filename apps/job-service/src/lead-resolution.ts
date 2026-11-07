import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AtlasDatasetObjectSchema, defineTool, deriveEntityId, EntityIdSchema, HttpUrlSchema,
  normalizeSearchText, normalizeSourceUrl, RevisionSchema, TimestampSchema, ToolError,
  type SourceDefinition, type ToolHandlerContext,
} from "@better-me/opportunities";
import {
  LeadQueryInputSchema, LeadQueryResultSchema, LeadReadInputSchema, LeadReadResultSchema,
  OriginalLeadReadInputSchema, OriginalLeadCaptureSchema, OriginalLeadPreviewInputSchema,
  OriginalLeadPreviewSchema, OriginalLeadImportInputSchema,
  type DiscoveryLead, type LeadQueryItem, type OriginalLeadCapture, type OriginalLeadPreviewInput,
  type OriginalLeadImportInput, type OriginalLeadReadInput, type SourceRegistry, type SourceTransport,
} from "@better-me/source-adapters";
import { projectSourcePage } from "./projection.js";
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
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const CursorSchema = z.object({ version: z.literal(1), revision: RevisionSchema, query: hash, after: EntityIdSchema }).strict();
// A separate observation retains the discovery association without replacing the JD's content hash.
const AssociationSchema = z.object({
  kind: z.literal("discovery-lead-original"), schemaVersion: z.literal(1), leadId: EntityIdSchema, leadDigest: hash,
  discoverySourceId: EntityIdSchema, discoverySourceFingerprint: hash, originalSourceId: EntityIdSchema,
  originalSourceFingerprint: hash, sourceRecordId: z.string().trim().min(1).max(1000), url: HttpUrlSchema,
  observedAt: TimestampSchema, readSessionId: z.string().regex(/^[a-f0-9]{32}$/),
  readSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), recordDigest: hash, associationProof: hash,
}).strict();
type Association = z.infer<typeof AssociationSchema>;
type State = Awaited<ReturnType<JobRepository["readLeadSnapshot"]>>;
function association(rawText: string | undefined): Association | undefined {
  if (!rawText || !rawText.includes('"discovery-lead-original"')) return;
  try { const parsed = AssociationSchema.safeParse(JSON.parse(rawText)); return parsed.success ? parsed.data : undefined; } catch { return; }
}
const WARNINGS = [
  "此岗位来自另行读取的原招聘来源；发现线索仍保留，不会被改写为完整岗位。",
  "读取与保存不认证企业控股、在招状态或办公关系；读取时间不作为岗位发布时间。",
  "仅保留原页披露的地点。国家、城市或街道文字不生成坐标，不作为已确认办公室；远程范围不作为办公点。",
];
function previewInput(raw: OriginalLeadPreviewInput): OriginalLeadPreviewInput {
  const parsed = OriginalLeadPreviewInputSchema.safeParse({ capture: raw.capture, expectedRevision: raw.expectedRevision });
  if (!parsed.success) throw new ToolError("invalid-input");
  return parsed.data;
}
const fingerprint = (input: OriginalLeadPreviewInput) => digest({ version: VERSION, input: previewInput(input) });
function writeOptions(input: OriginalLeadImportInput, context: ToolHandlerContext) {
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, expectedRevision: input.expectedRevision,
    idempotencyKey: `lead-original:${digest(context.idempotencyKey)}`, requestFingerprint: digest({ version: VERSION, input }) };
}

/** Tools consume durable lead identities; neither callers nor discovery sources grant new endpoint access. */
export function createLeadResolutionTools(options: { repository: JobRepository; sources: SourceRegistry; transport: SourceTransport; now?: () => string }) {
  const { repository, sources, transport } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const proofKey = randomBytes(32), readSessionId = randomBytes(16).toString("hex");
  let lastReadSequence = 0;
  const sign = (value: unknown) => createHmac("sha256", proofKey).update(json(value)).digest("hex");
  const sameProof = (proof: string, value: unknown) => timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(sign(value), "hex"));
  function view(state: State) {
    const resolved = new Map<string, LeadQueryItem["resolvedJobs"]>();
    const listings = new Map(state.dataset.listings.map(value => [value.id, value]));
    const jobs = new Map(state.dataset.jobs.map(value => [value.id, value]));
    const leads = new Map(state.leads.map(value => [value.id, value]));
    for (const observation of state.dataset.observations) {
      const held = association(observation.rawText);
      if (!held || leads.get(held.leadId)?.sourceId !== held.discoverySourceId) continue;
      const listing = listings.get(observation.listingId);
      const job = listing?.canonicalJobId ? jobs.get(listing.canonicalJobId) : undefined;
      if (!listing || !job || !listing.observationIds.includes(observation.id) || listing.sourceId !== held.originalSourceId || listing.sourceRecordId !== held.sourceRecordId
        || listing.canonicalUrl !== normalizeSourceUrl(held.url) || !job.listingIds.includes(listing.id)) continue;
      const resolvedJobs = resolved.get(held.leadId) ?? [];
      if (!resolvedJobs.some(value => value.jobId === job.id && value.sourceId === listing.sourceId && value.url === held.url)) {
        resolvedJobs.push({ jobId: job.id, title: job.title.value, sourceId: listing.sourceId, url: held.url });
      }
      resolved.set(held.leadId, resolvedJobs);
    }
    const sourceMap = new Map(state.dataset.sources.map(value => [value.sourceId, value]));
    const matchingSources = new Map<string, SourceDefinition[]>();
    return (lead: DiscoveryLead): LeadQueryItem => {
      const source = sourceMap.get(lead.sourceId);
      if (!source) throw new ToolError("source-changed");
      const url = lead.record.url;
      if (url && !matchingSources.has(url)) matchingSources.set(url,
        state.dataset.sources.filter(source => sources.matchesOriginalUrl(source, url)).slice(0, 1000));
      return { lead, leadDigest: digest(lead), source, resolvedJobs: resolved.get(lead.id) ?? [],
        eligibleOriginalSources: url ? matchingSources.get(url)! : [] };
    };
  }
  async function target(input: OriginalLeadReadInput, context: ToolHandlerContext,
    capture?: Pick<OriginalLeadCapture, "discoverySourceId" | "discoverySourceFingerprint" | "originalSourceFingerprint" | "url">) {
    context.throwIfCancelled();
    const state = await repository.readLeadSnapshot();
    context.throwIfCancelled();
    if (state.dataset.revision !== input.expectedRevision) throw new ToolError("stale-version");
    const lead = state.leads.find(value => value.id === input.leadId);
    if (!lead || !lead.record.url) throw new ToolError("invalid-input");
    if (digest(lead) !== input.leadDigest) throw new ToolError("source-changed");
    const discoverySource = state.dataset.sources.find(value => value.sourceId === lead.sourceId);
    const source = state.dataset.sources.find(value => value.sourceId === input.originalSourceId);
    if (!discoverySource || !source) throw new ToolError("source-changed");
    if (capture && (capture.discoverySourceId !== discoverySource.sourceId || capture.discoverySourceFingerprint !== digest(discoverySource)
      || capture.originalSourceFingerprint !== digest(source) || capture.url !== lead.record.url)) throw new ToolError("source-changed");
    if (!discoverySource.enabled || discoverySource.status !== "active") throw new ToolError("unsupported-capability");
    if (source.entityType !== "job-posting" || !sources.resolve(source, "list-jobs", "local-service").adapter.readOriginal) throw new ToolError("unsupported-capability");
    if (source.secretRef) throw new ToolError("needs-auth");
    if (!sources.matchesOriginalUrl(source, lead.record.url)) throw new ToolError("unsupported-capability");
    return { state, lead, source, discoverySource, url: lead.record.url };
  }
  async function prepare(raw: OriginalLeadPreviewInput, context: ToolHandlerContext) {
    const input = previewInput(raw), { capture } = input;
    context.throwIfCancelled();
    const { proof, ...unsigned } = capture;
    if (!sameProof(proof, unsigned)) throw new ToolError("source-changed");
    const currentTime = TimestampSchema.safeParse(now());
    if (!currentTime.success || Date.parse(capture.observedAt) > Date.parse(currentTime.data) + 300_000) throw new ToolError("invalid-input");
    const held = await target({ leadId: capture.leadId, leadDigest: capture.leadDigest,
      originalSourceId: capture.originalSourceId, expectedRevision: input.expectedRevision }, context, capture);
    const projected = await projectSourcePage(held.state.projection, held.source, {
      observedAt: capture.observedAt, records: [capture.record], warnings: [],
      coverage: { fetchedRecords: 1, partial: false, complete: true, appliedFilters: [], ignoredFilters: [] },
    }, `lead-original:${digest(capture)}`);
    const delta = projected.delta, job = delta.jobs[0], listing = delta.listings[0];
    if (!job || !listing || projected.leads.length || delta.jobs.length !== 1 || delta.listings.length !== 1) throw new ToolError("source-changed");
    const priorListing = held.state.projection.listings.find(value => value.id === listing.id);
    const times = [priorListing?.recordLastSeenAt, ...held.state.projection.observations.filter(value => value.listingId === listing.id)
      .flatMap(value => [value.fetchedAt, value.detailFetchedAt])].filter((value): value is string => Boolean(value));
    if (times.some(value => Date.parse(value) > Date.parse(capture.observedAt))) throw new ToolError("stale-version");
    for (const observation of held.state.projection.observations.filter(value => value.listingId === listing.id)) {
      const previous = association(observation.rawText);
      if (!previous || previous.readSessionId !== capture.readSessionId || previous.readSequence <= capture.readSequence) continue;
      const { associationProof, ...body } = previous;
      if (sameProof(associationProof, body)) throw new ToolError("stale-version");
    }
    const body: Omit<Association, "associationProof"> = {
      kind: "discovery-lead-original", schemaVersion: 1, leadId: held.lead.id, leadDigest: capture.leadDigest,
      discoverySourceId: held.discoverySource.sourceId, discoverySourceFingerprint: capture.discoverySourceFingerprint,
      originalSourceId: held.source.sourceId, originalSourceFingerprint: capture.originalSourceFingerprint,
      sourceRecordId: capture.record.sourceRecordId!, url: capture.url, observedAt: capture.observedAt,
      readSessionId: capture.readSessionId, readSequence: capture.readSequence, recordDigest: digest(capture.record),
    };
    const rawText = json({ ...body, associationProof: sign(body) });
    const observationId = await deriveEntityId("observation", [listing.id, "discovery-lead-original", digest(body)]);
    listing.discoverySourceIds = unique([...(listing.discoverySourceIds ?? []), held.discoverySource.sourceId]);
    listing.discoveredViaUrls = unique([...(listing.discoveredViaUrls ?? []), held.discoverySource.entryUrl, held.url]
      .filter((url): url is string => Boolean(url)));
    listing.observationIds = unique([...listing.observationIds, observationId]);
    delta.observations.push({ id: observationId, listingId: listing.id, fetchedAt: capture.observedAt,
      detailFetchedAt: capture.observedAt, result: "partial", availability: "unknown", completeness: "lead",
      rawText, contentHash: createHash("sha256").update(rawText).digest("hex"), warnings: WARNINGS });
    const canonicalJobId = held.state.dataset.listings.find(value => value.id === listing.id)?.canonicalJobId ?? job.id;
    const preview = OriginalLeadPreviewSchema.parse({ leadId: held.lead.id, originalSourceId: held.source.sourceId, canonicalJobId,
      expectedRevision: input.expectedRevision, previewFingerprint: fingerprint(input), job, listings: delta.listings,
      locations: job.locationIds.map(id => delta.locations.find(value => value.id === id) ?? held.state.projection.locations.find(value => value.id === id))
        .filter(value => value !== undefined), warnings: unique([...WARNINGS,
          ...(canonicalJobId !== job.id ? ["此原来源岗位已归并；下方为本次原来源字段，保存将按既有归并关系更新规范岗位，最终以保存后统一索引为准。"] : []),
          ...capture.record.warnings]).slice(0, 100) });
    context.throwIfCancelled();
    return { delta: AtlasDatasetObjectSchema.parse(delta), preview };
  }
  async function receipt(input: OriginalLeadImportInput, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const result = await repository.findImportReceipt(writeOptions(input, context));
    context.throwIfCancelled();
    return result;
  }
  return [
    defineTool({ name: "leads.query", version: VERSION, effect: "read-index", description: "分页检索已保存发现线索与其原岗位接续；不读取外站或写入岗位。",
      inputSchema: LeadQueryInputSchema, outputSchema: LeadQueryResultSchema, execute: async (raw, context) => {
        const input = LeadQueryInputSchema.parse(raw);
        context.throwIfCancelled(); const state = await repository.readLeadSnapshot(); context.throwIfCancelled();
        const { cursor, ...query } = input, queryHash = digest(query);
        const tokens = normalizeSearchText(input.search ?? "").split(/\s+/).filter(Boolean);
        const leads = state.leads.filter(lead => {
          if (input.sourceId && lead.sourceId !== input.sourceId || input.entityType && lead.record.entityType !== input.entityType) return false;
          if (!tokens.length) return true;
          const text = normalizeSearchText([lead.record.title, lead.record.companyName, lead.record.description,
            lead.record.url, ...lead.record.locations.map(location => location.raw)].filter(Boolean).join(" "));
          return tokens.every(token => text.includes(token));
        });
        let start = 0;
        if (cursor) {
          let parsed: z.infer<typeof CursorSchema>;
          try {
            if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
            const bytes = Buffer.from(cursor, "base64url");
            if (bytes.toString("base64url") !== cursor) throw new Error();
            parsed = CursorSchema.parse(JSON.parse(bytes.toString("utf8")));
          } catch { throw new ToolError("invalid-input"); }
          if (parsed.revision !== state.dataset.revision) throw new ToolError("stale-version");
          if (parsed.query !== queryHash) throw new ToolError("invalid-input");
          const previous = leads.findIndex(lead => lead.id === parsed.after);
          if (previous < 0) throw new ToolError("invalid-input");
          start = previous + 1;
        }
        const page = leads.slice(start, start + input.limit);
        const toItem = view(state);
        return { snapshotRevision: state.dataset.revision, items: page.map(toItem), totalLeads: leads.length,
          ...(start + page.length < leads.length ? { nextCursor: Buffer.from(json({ version: VERSION,
            revision: state.dataset.revision, query: queryHash, after: page.at(-1)!.id })).toString("base64url") } : {}) };
      } }),
    defineTool({ name: "leads.read", version: VERSION, effect: "read-index", description: "重新打开持久发现线索、发现链及当前规范岗位；不读取原站。",
      inputSchema: LeadReadInputSchema, outputSchema: LeadReadResultSchema, execute: async (input, context) => {
        context.throwIfCancelled(); const state = await repository.readLeadSnapshot(); context.throwIfCancelled();
        if (input.expectedRevision !== undefined && state.dataset.revision !== input.expectedRevision) throw new ToolError("stale-version");
        const lead = state.leads.find(value => value.id === input.leadId);
        if (!lead) throw new ToolError("invalid-input");
        return { snapshotRevision: state.dataset.revision, ...view(state)(lead) };
      } }),
    defineTool({ name: "leads.read-original", version: VERSION, effect: "external-read", description: "按已保存线索链接和独立启用的原来源读取唯一岗位；不扫描整源、不采用线索编号、不写入索引。",
      inputSchema: OriginalLeadReadInputSchema, outputSchema: OriginalLeadCaptureSchema, execute: async (input, context) => {
        const held = await target(input, context), observedAt = TimestampSchema.parse(now());
        const readSequence = ++lastReadSequence;
        const record = await sources.readOriginal({ source: held.source, url: held.url, context: { ...context, observedAt }, transport });
        context.throwIfCancelled(); await target(input, context, { ...input, discoverySourceId: held.discoverySource.sourceId,
          discoverySourceFingerprint: digest(held.discoverySource), originalSourceFingerprint: digest(held.source), url: held.url });
        const capture = { schemaVersion: 1 as const, leadId: held.lead.id, leadDigest: input.leadDigest,
          discoverySourceId: held.discoverySource.sourceId, discoverySourceFingerprint: digest(held.discoverySource),
          originalSourceId: held.source.sourceId, originalSourceFingerprint: digest(held.source), url: held.url,
          observedAt, record, readSessionId, readSequence };
        const parsed = OriginalLeadCaptureSchema.safeParse({ ...capture, proof: sign(capture) });
        if (!parsed.success) throw new ToolError("source-changed");
        return parsed.data;
      } }),
    defineTool({ name: "leads.preview-original", version: VERSION, effect: "read-index", description: "核对宿主原页读取和发现链，预览原来源拥有的规范岗位；不写入。",
      inputSchema: OriginalLeadPreviewInputSchema, outputSchema: OriginalLeadPreviewSchema,
      execute: async (input, context) => (await prepare(input, context)).preview }),
    defineTool({ name: "leads.import-original", version: VERSION, effect: "local-write", description: "明确确认原页预览后保存规范岗位与发现链；原幂等请求可恢复已提交回执。",
      inputSchema: OriginalLeadImportInputSchema, outputSchema: ImportReceiptSchema,
      recoverInterrupted: (input, context) => receipt(input, context), execute: async (input, context) => {
        const parsed = OriginalLeadImportInputSchema.safeParse(input);
        if (!parsed.success) throw new ToolError("invalid-input");
        const cached = await receipt(parsed.data, context); if (cached) return cached;
        const prepared = await prepare(parsed.data, context);
        if (prepared.preview.previewFingerprint !== parsed.data.previewFingerprint) throw new ToolError("source-changed");
        context.throwIfCancelled();
        try { return await repository.importSnapshot(prepared.delta, writeOptions(parsed.data, context)); }
        catch (error) {
          if (error instanceof RepositoryError && error.code === "stale-version") { const recovered = await receipt(parsed.data, context); if (recovered) return recovered; }
          throw error;
        }
      } }),
  ];
}
