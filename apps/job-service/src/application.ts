import { z } from "zod";
import { fileURLToPath } from "node:url";
import {
  AtlasDatasetSchema, CanonicalJobSchema, CompanySchema, JobLocationSchema, CompensationSchema, RevisionSchema, SourceDefinitionSchema, SourceListingSchema, SourceObservationSchema, JdSnapshotSchema,
  EntityIdSchema, queryJobs, createJobsSearchTool, createToolRegistry, defineTool, normalizeSearchText, ToolError,
  type QueryOptions, type SourceDefinition, type ToolHandlerContext, type ToolDefinition,
} from "@better-me/opportunities";
import {
  SourceScopeSchema, SourcePageSchema, SourceAdapterMetadataSchema, SourceRegistryError, SourceTransportError,
  createSourceRegistry, createControlledSourceTransport, greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter, smartRecruitersAdapter, discoveryPolicyAdapter, jobPostingJsonLdAdapter,
  discoverSourceCandidates, inspectSourceCandidate, proposeSourceRegistration,
  DiscoverSourceCandidatesInputSchema, SourceDiscoveryPageSchema, InspectSourceCandidateInputSchema, SourceCandidateInspectionSchema,
  ProposeSourceRegistrationInputSchema, SourceRegistrationProposalSchema,
  discoverCompanyCareers, DiscoverCompanyCareersRequestSchema, CompanyCareerDiscoveryResultSchema, CompanyCareerDiscoveryCapabilitiesSchema,
  createLocalGazetteerProvider, createGeocodingTool, type GeocodingProvider, type MapReferenceProvider,
  locallyMatchesSourceScope as locallyMatches, countSourceScopeMatches,
  type SourceAdapter, type SourceTransport, type CareerWebSearchProvider,
  ReadSourceScanProgressInputSchema, SourceScanProgressResultSchema, ContinueSourceScanInputSchema, SourceSyncResultSchema,
  type SourceScope, type SourceSyncRun, type SourceSyncResult, type ContinueSourceScanInput,
} from "@better-me/source-adapters";
import { sourceConfigurationFingerprint } from "./source-scan-state.js";
import { RepositoryError, type JobRepository } from "./repository.js";
import { DiscoveryLeadSchema, ImportReceiptSchema, SyncRunSchema, type PublicRunSummary } from "./repository-schema.js";
import { projectSourcePage } from "./projection.js";
import { createReviewedCardsTools } from "./reviewed-cards.js";
import { createReviewedDetailLocationsTools } from "./reviewed-detail-locations.js";
import { createOwnedDetailLocationsTools } from "./owned-detail-locations.js";
import { createLocationConfirmationTools } from "./location-confirmation.js";
import { createReconciliationTools } from "./reconciliation.js";
import { createLocationMapReferencesTool } from "./location-map-references.js";
import { createOfficeAddressTools, type OfficeAddressProvider } from "./office-address.js";
import { createAddressEnrichmentTool } from "./address-enrichment.js";
import { createCompensationReviewTools } from "./compensation-review.js";
import { createCompanyControlReviewTools } from "./company-control-review.js";
import { createFxTools, type FxReferenceProvider } from "./fx.js";

const emptyInput = z.object({}).strict();
// Name-only discovery has no permission to follow arbitrary URLs. This host policy is
// transient: it is never registered as a source or included in the public dataset.
const nameOnlyDiscoverySource = SourceDefinitionSchema.parse({
  sourceId: "host-company-career-discovery", name: "Host company career discovery", adapterId: "host-company-career-discovery", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Host company career discovery", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 3, requestsPerMinute: 30 },
});
const usableScope = SourceScopeSchema.superRefine((scope, context) => {
  for (const [field, terms] of Object.entries(scope)) for (const term of terms ?? []) {
    if (!normalizeSearchText(term).trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "A scope term must contain searchable characters." });
  }
});
const scopeInput = z.object({
  sourceId: EntityIdSchema,
  scope: usableScope.default({ roles: [], regions: [], companyNames: [] }),
  maxRecords: z.number().int().min(1).max(100_000).optional(), maxPages: z.number().int().min(1).max(1000).optional(),
}).strict();
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function key(context: ToolHandlerContext): string {
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return context.idempotencyKey;
}
function mappedError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof RepositoryError) return new ToolError(error.code === "rate-limited" ? "rate-limited" : error.code === "idempotency-conflict" ? "idempotency-conflict" : ["conflict", "stale-version"].includes(error.code) ? "stale-version" : error.code === "cancelled" ? "cancelled" : error.code === "not-authorized" ? "not-authorized" : "invalid-input");
  if (error instanceof SourceRegistryError) return new ToolError(error.code === "invalid-output" ? "source-changed" : error.code === "invalid-source" ? "invalid-input" : "unsupported-capability");
  if (error instanceof SourceTransportError) return new ToolError(error.code === "rate-limited" ? "rate-limited" : error.code === "cancelled" ? "cancelled" : error.code === "timeout" ? "timeout" : error.status === 401 || error.status === 403 ? "needs-auth" : "source-changed");
  return new ToolError("internal-error");
}
export type JobApplicationOptions = {
  repository: JobRepository;
  adapters?: readonly SourceAdapter[];
  transport?: SourceTransport;
  now?: () => string;
  resolveQueryOptions?: (context: ToolHandlerContext) => QueryOptions | Promise<QueryOptions>;
  /** Host-only dependency; tool requests cannot select a provider, file or endpoint. */
  geocodingProvider?: GeocodingProvider;
  officeAddressProvider?: OfficeAddressProvider;
  /** Offline only, host-installed city display references. Never supplied by query arguments. */
  mapReferenceProvider?: MapReferenceProvider;
  /** Host-only web search; requests cannot install providers or select their endpoints. */
  careerWebSearchProvider?: CareerWebSearchProvider;
  /** Optional fixed public reference source; reading it never imports or activates it. */
  fxReferenceProvider?: FxReferenceProvider;
};

/** One application service backs HTTP and future Agent tools. Private opportunity data stays outside. */
export function createJobApplication(options: JobApplicationOptions) {
  const repository = options.repository;
  const now = options.now ?? (() => new Date().toISOString());
  const sources = createSourceRegistry(options.adapters ?? [greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter, tencentAdapter, smartRecruitersAdapter, discoveryPolicyAdapter, jobPostingJsonLdAdapter]);
  const transport = options.transport ?? createControlledSourceTransport();
  const query = { search: async (input: Parameters<typeof queryJobs>[1], hostOptions: QueryOptions = {}) => {
    const captured = await repository.readFxQuerySnapshot();
    // Caller-provided anchors and colors are independent, while conversion always follows
    // the repository selection captured atomically with these exact public job rows.
    return queryJobs(captured.dataset, input, { ...hostOptions, fx: captured.context.activeSnapshot?.fx, now: captured.context.asOf });
  } };
  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  const stopSignal = new AbortController();
  let stopping = false;
  let pageMutation: Promise<void> = Promise.resolve();
  function serializePageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const task = pageMutation.then(operation);
    // A failed page must not prevent another source from committing its page.
    pageMutation = task.then(() => undefined, () => undefined);
    return task;
  }
  async function getSource(id: string): Promise<SourceDefinition> {
    const source = (await repository.readSnapshot()).sources.find((source) => source.sourceId === id);
    if (!source) throw new ToolError("invalid-input");
    return source;
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    if (stopping) throw new ToolError("cancelled");
    const task = (async () => clean(await operation()))();
    pending.add(task);
    try { return await task; } catch (error) { throw mappedError(error); }
    finally { pending.delete(task); }
  }
  async function assertSourceConfiguration(source: SourceDefinition) {
    if (JSON.stringify(await getSource(source.sourceId)) !== JSON.stringify(source)) throw new ToolError("stale-version");
  }
  async function discoveryExecution(sourceId: string, context: ToolHandlerContext) {
    const source = await getSource(sourceId);
    if (!source.enabled || source.status !== "active" || !source.capabilities.includes("discover-sources") || !source.runtime.includes("local-service")) throw new ToolError("unsupported-capability");
    if (source.secretRef) throw new ToolError("needs-auth");
    return { source, context: { ...context, observedAt: now() }, transport };
  }
  // The checked-in dataset stays on the server. The provider loads its trusted
  // manifest and country shards lazily, only after a requested city/office query.
  const localGazetteer = createLocalGazetteerProvider({
    manifestPath: fileURLToPath(new URL("../../../config/geography/gazetteer/manifest.json", import.meta.url)),
  });
  const geocodingTool = createGeocodingTool(options.geocodingProvider ?? localGazetteer);
  const mapReferenceTool = createLocationMapReferencesTool(repository, options.mapReferenceProvider ?? localGazetteer);
  const addressEnrichmentTool = createAddressEnrichmentTool(repository, { canReadOfficialSource: source => {
    try { sources.resolve(source, "list-jobs", "local-service"); return true; } catch { return false; }
  }, canReadOfficialDetailSource: source => {
    try { return typeof sources.resolve(source, "list-jobs", "local-service").adapter.readDetail === "function"; } catch { return false; }
  } });
  const searchTool = createJobsSearchTool(query, async (input, context) => ({ now: now(),
    ...(options.resolveQueryOptions ? await options.resolveQueryOptions(context) : {}),
    ...(input.mapCityReferences ? { mapReferences: await mapReferenceTool.execute({ expectedRevision: (await repository.readSnapshot()).revision, limit: 1000 }, context) } : {}),
  }));

  const scopeOfRun = (run: SourceSyncRun): SourceScope => ({ roles: run.scope.keywords ?? [], regions: run.scope.regions ?? [], companyNames: run.scope.companies ?? [], ...(run.scope.countryCodes ? { countryCodes: run.scope.countryCodes } : {}) });
  async function syncResult(run: SourceSyncRun, localFilters: SourceScope, warnings: string[], sourceError?: { code: string; retryAfterSeconds?: number }): Promise<SourceSyncResult> {
    const progress = run.scanId ? (await repository.readScanProgress({ sourceId: run.sourceId, runId: run.runId, actorScope: run.actorScope })).progress : undefined;
    return { run, localFilters, warnings, ...(sourceError ? { sourceError } : {}), ...(progress?.runId === run.runId ? { scanProgress: progress } : {}) };
  }
  async function recoverSync(input: unknown, context: ToolHandlerContext, continuation: boolean) {
    const requestFingerprint = createHash("sha256").update(JSON.stringify(continuation ? { tool: "sources.continue-sync", input } : input)).digest("hex");
    const existing = await repository.findRunByRequest({ actorScope: context.actorScope, idempotencyKey: key(context), requestFingerprint });
    return existing ? syncResult(existing, scopeOfRun(existing), ["Recovered the original durable run without new source requests."]) : undefined;
  }
  async function executeSync(input: z.infer<typeof scopeInput>, context: ToolHandlerContext, continuation?: ContinueSourceScanInput): Promise<SourceSyncResult> {
        const sameKey = key(context);
        const requestFingerprint = createHash("sha256").update(JSON.stringify(continuation ? { tool: "sources.continue-sync", input: continuation } : input)).digest("hex");
        const existing = await repository.findRunByRequest({ actorScope: context.actorScope, idempotencyKey: sameKey, requestFingerprint });
        if (existing) return syncResult(existing, scopeOfRun(existing), ["This request already has a persistent run. Read its state; a new refresh requires a new key."]);
        if (continuation) {
          const retained = await repository.readScanCheckpoint(continuation.fromRunId, context.actorScope);
          if (retained.sourceId !== continuation.sourceId || retained.runId !== continuation.fromRunId || retained.version !== continuation.expectedProgressVersion) throw new ToolError("stale-version");
          input = { sourceId: continuation.sourceId, scope: retained.scope, ...(continuation.maxRecords === undefined ? {} : { maxRecords: continuation.maxRecords }), ...(continuation.maxPages === undefined ? {} : { maxPages: continuation.maxPages }) };
        }
        const source = await getSource(input.sourceId);
        sources.resolve(source, "list-jobs", "local-service");
        if (source.secretRef) throw new ToolError("needs-auth");
        const maxRecords = Math.min(input.maxRecords ?? source.refreshPolicy.maxRecords, source.refreshPolicy.maxRecords);
        const maxPages = Math.min(input.maxPages ?? source.refreshPolicy.maxPages, source.refreshPolicy.maxPages);
        const run = await repository.startRun({ sourceId: source.sourceId, scope: { keywords: input.scope.roles, regions: input.scope.regions, companies: input.scope.companyNames,
          ...(input.scope.countryCodes ? { countryCodes: input.scope.countryCodes } : {}), maxRecords, maxPages }, actorScope: context.actorScope, idempotencyKey: sameKey, requestFingerprint,
          scan: { sourceFingerprint: sourceConfigurationFingerprint(source), scope: input.scope, ...(continuation ? { continue: continuation } : {}) } });
        if (run.status !== "running") return syncResult(run, input.scope, ["This idempotent request already has a terminal run; use a new key for a new refresh."]);
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        context.signal.addEventListener("abort", forwardAbort, { once: true });
        if (context.signal.aborted) controller.abort();
        running.set(run.runId, controller);
        const syncContext: ToolHandlerContext = { ...context, signal: controller.signal, throwIfCancelled: () => { context.throwIfCancelled(); if (controller.signal.aborted) throw new ToolError("cancelled"); } };
        const summary: PublicRunSummary = { added: 0, changed: 0, unchanged: 0, records: 0, pages: 0, leads: 0, partial: false };
        const warnings: string[] = [];
        let checkpoint = await repository.readScanCheckpoint(run.runId, context.actorScope);
        summary.partial = checkpoint.hadErrors;
        const cursors = new Set<string>();
        let cursor = checkpoint.cursor;
        if (cursor) cursors.add(cursor);
        try {
          for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
            syncContext.throwIfCancelled();
            await repository.assertRunCurrent(run.runId, context.actorScope);
            await assertSourceConfiguration(source);
            const remaining = maxRecords - summary.records!;
            if (remaining <= 0) { summary.partial = true; warnings.push("record-limit"); break; }
            const page = await sources.list({ source: { ...source, refreshPolicy: { ...source.refreshPolicy, maxRecords: remaining } }, scope: input.scope, ...(cursor ? { cursor } : {}), context: { ...syncContext, observedAt: now() }, transport });
            syncContext.throwIfCancelled();
            await repository.assertRunCurrent(run.runId, context.actorScope);
            await assertSourceConfiguration(source);
            summary.pages!++; summary.records! += page.coverage.fetchedRecords;
            summary.partial ||= page.coverage.partial;
            warnings.push(...page.warnings);
            const unresolvedScope = countSourceScopeMatches(page.records, input.scope).unknown;
            if (unresolvedScope) summary.needsHuman = (summary.needsHuman ?? 0) + unresolvedScope;
            const matchedPage = { ...page, records: page.records.filter((record) => locallyMatches(record, input.scope)) };
            // Network reads remain concurrent. Only each local read/project/write
            // sequence is serialized, so independent sources use the latest base.
            const leads = await serializePageMutation(async () => {
              syncContext.throwIfCancelled();
              let snapshot = await repository.readProjectionSnapshot();
              for (let attempt = 0; ; attempt++) {
                syncContext.throwIfCancelled();
                await repository.assertRunCurrent(run.runId, context.actorScope);
                await assertSourceConfiguration(source);
                // Refresh source origins rather than a merged canonical summary.
                const projection = await projectSourcePage(snapshot, source, matchedPage, run.runId);
                // Observations cannot restore an old endpoint/policy configuration.
                projection.delta.sources = [];
                syncContext.throwIfCancelled();
                await repository.assertRunCurrent(run.runId, context.actorScope);
                await assertSourceConfiguration(source);
                let receipt;
                try {
                  const committed = await repository.commitScanPage({ delta: projection.delta, leads: projection.leads, page, expectedProgressVersion: checkpoint.version, summary }, { actorScope: context.actorScope, idempotencyKey: `${run.runId}.page-${pageNumber}`, expectedRevision: snapshot.revision, runId: run.runId, throwIfCancelled: syncContext.throwIfCancelled });
                  receipt = committed.receipt;
                  checkpoint = await repository.readScanCheckpoint(run.runId, context.actorScope);
                } catch (error) {
                  if (!(error instanceof RepositoryError) || error.code !== "stale-version") throw error;
                  syncContext.throwIfCancelled();
                  await repository.assertRunCurrent(run.runId, context.actorScope);
                  await assertSourceConfiguration(source);
                  const latest = await repository.readProjectionSnapshot();
                  // An external registration/import can advance the index while
                  // this page is projected. Retry only a real CAS race, never a
                  // replaced source/run or an unchanged-version semantic failure.
                  if (attempt >= 2 || latest.revision <= snapshot.revision) throw error;
                  snapshot = latest;
                  continue;
                }
                summary.added! += receipt.counts.newJobs; summary.changed! += receipt.counts.updatedJobs; summary.unchanged! += receipt.counts.unchangedJobs;
                return projection.leads.length;
              }
            });
            summary.leads! += leads;
            if (!page.nextCursor) { summary.partial ||= !page.coverage.complete; break; }
            if (cursors.has(page.nextCursor)) { summary.partial = true; warnings.push("repeated-source-cursor"); await repository.markScanFailure(run.runId, context.actorScope, true); break; }
            cursors.add(page.nextCursor); cursor = page.nextCursor;
            if (pageNumber + 1 === maxPages) { summary.partial = true; warnings.push("page-limit"); }
          }
          syncContext.throwIfCancelled();
          const finished = await repository.finishRun(run.runId, { actorScope: context.actorScope, status: summary.partial ? "partial" : "completed", summary });
          return syncResult(finished, input.scope, [...new Set(warnings)].slice(0, 100));
        } catch (error) {
          const failure = mappedError(error);
          const current = await repository.getRun(run.runId);
          if (!current) throw failure;
          if (["cancelled", "superseded"].includes(current.status)) return syncResult(current, input.scope, [failure.code], { code: failure.code });
          await repository.markScanFailure(run.runId, context.actorScope, failure.code === "source-changed");
          const finished = controller.signal.aborted
            ? await repository.cancelRun(run.runId, { actorScope: context.actorScope })
            : await repository.finishRun(run.runId, { actorScope: context.actorScope, status: summary.pages ? "partial" : "failed", summary: { ...summary, partial: Boolean(summary.pages), errorCode: failure.code } });
          return syncResult(finished, input.scope, [...new Set([...warnings, failure.code])].slice(0, 100), { code: failure.code, ...(error instanceof SourceTransportError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
        } finally {
          context.signal.removeEventListener("abort", forwardAbort);
          if (running.get(run.runId) === controller) running.delete(run.runId);
        }

  }
  const definitions: ToolDefinition<any, any>[] = [
    ...createCompanyControlReviewTools(repository).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createFxTools(repository, options.fxReferenceProvider).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createCompensationReviewTools(repository).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    defineTool({ ...addressEnrichmentTool, execute: (input, context) => guarded(async () => addressEnrichmentTool.execute(input, context)) }),
    ...createReconciliationTools(repository).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createLocationConfirmationTools(repository).map(definition => ({ ...definition, execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createOfficeAddressTools(repository, options.officeAddressProvider).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createReviewedCardsTools({ repository, now }).map(definition => ({ ...definition, execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createReviewedDetailLocationsTools({ repository, now }).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    ...createOwnedDetailLocationsTools({ repository, sources, transport, now }).map(definition => ({ ...definition,
      ...(definition.recoverInterrupted ? { recoverInterrupted: async (input: any, context: ToolHandlerContext) => (await guarded(async () => ({ receipt: await definition.recoverInterrupted!(input, context) }))).receipt } : {}),
      execute: (input: any, context: ToolHandlerContext) => guarded(async () => definition.execute(input, context)) })),
    defineTool({ ...searchTool, execute: (input, context) => guarded(async () => searchTool.execute(input, context)) }),
    defineTool({ ...mapReferenceTool, execute: (input, context) => guarded(async () => mapReferenceTool.execute(input, context)) }),
    defineTool({ ...geocodingTool, execute: (input, context) => guarded(async () => {
      context.throwIfCancelled();
      const result = await geocodingTool.execute(input, context);
      context.throwIfCancelled();
      return result;
    }) }),
    defineTool({ name: "sources.list", version: 1, description: "列出来源配置和已安装适配器的实际能力。", effect: "read-index", inputSchema: emptyInput,
      outputSchema: z.object({ sources: z.array(SourceDefinitionSchema), adapters: z.array(SourceAdapterMetadataSchema) }).strict(),
      execute: () => guarded(async () => ({ sources: (await repository.readSnapshot()).sources, adapters: sources.describe() })),
    }),
    defineTool({ name: "sources.register", version: 1, description: "保存显式来源配置；来源JSON不能导入执行代码或实际密钥。", effect: "local-write",
      inputSchema: z.object({ source: SourceDefinitionSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(), outputSchema: ImportReceiptSchema,
      execute: (input, context) => guarded(async () => {
        context.throwIfCancelled();
        // Disabled candidates can be staged; enabling requires an installed matching adapter.
        if (input.source.enabled) {
          // Preserve existing collectors, which may also authorize the host's discovery tools.
          // A pure access policy must advertise only discovery and have an installed adapter.
          const capability = input.source.capabilities.includes("list-jobs") ? "list-jobs"
            : input.source.capabilities.length === 1 && input.source.capabilities[0] === "discover-sources" ? "discover-sources" : undefined;
          if (!capability) throw new ToolError("unsupported-capability");
          sources.resolve(input.source, capability, "local-service");
        }
        return repository.registerSource(input.source, { actorScope: context.actorScope, idempotencyKey: key(context), expectedRevision: input.expectedRevision });
      }),
    }),
    defineTool({ name: "sources.preview", version: 1, description: "按受控端点读取一页来源，显示上游覆盖与本地关注过滤；不写岗位索引。", effect: "external-read", inputSchema: scopeInput.omit({ maxPages: true }),
      outputSchema: z.object({ page: SourcePageSchema, localMatchedRecords: z.number().int().nonnegative(), localFilters: SourceScopeSchema }).strict(),
      execute: (input, context) => guarded(async () => {
        const storedSource = await getSource(input.sourceId);
        sources.resolve(storedSource, "list-jobs", "local-service");
        const source = { ...storedSource, refreshPolicy: { ...storedSource.refreshPolicy, maxRecords: Math.min(input.maxRecords ?? storedSource.refreshPolicy.maxRecords, storedSource.refreshPolicy.maxRecords) } };
        if (source.secretRef) throw new ToolError("needs-auth");
        const page = await sources.list({ source, scope: input.scope, context: { ...context, observedAt: now() }, transport });
        return { page, localMatchedRecords: page.records.filter((record) => locallyMatches(record, input.scope)).length, localFilters: input.scope };
      }),
    }),
    defineTool({ name: "sources.sync", version: 1, description: "在关注范围内从头手动刷新索引，保留来源观察、部分失败和持久任务回执。", effect: "local-write", inputSchema: scopeInput,
      outputSchema: SourceSyncResultSchema,
      recoverInterrupted: (input, context) => guarded(() => recoverSync(input, context, false)),
      execute: (input, context) => guarded(() => executeSync(input, context)),
    }),
    defineTool({ name: "sources.read-scan-progress", version: 1, description: "只读当前身份的来源扫描进度与保存的关注条件，不联网、不暴露上游游标。", effect: "read-index",
      inputSchema: ReadSourceScanProgressInputSchema, outputSchema: SourceScanProgressResultSchema,
      execute: (input, context) => guarded(() => repository.readScanProgress({ ...input, actorScope: context.actorScope })),
    }),
    defineTool({ name: "sources.continue-sync", version: 1, description: "显式继续上一批已提交的来源扫描，继承原条件并遵守本批预算及原来源间隔，不接受新条件或外部游标。", effect: "local-write",
      inputSchema: ContinueSourceScanInputSchema, outputSchema: SourceSyncResultSchema,
      recoverInterrupted: (input, context) => guarded(() => recoverSync(input, context, true)),
      execute: (input, context) => guarded(() => executeSync({ sourceId: input.sourceId, scope: { roles: [], regions: [], companyNames: [] } }, context, input)),
    }),
    defineTool({ name: "sources.discover", version: 1, description: "按已启用的发现端点策略搜索来源候选；候选不自动启用或变成岗位。", effect: "external-read",
      inputSchema: z.object({ sourceId: EntityIdSchema, request: DiscoverSourceCandidatesInputSchema }).strict(), outputSchema: SourceDiscoveryPageSchema,
      execute: (input, context) => guarded(async () => discoverSourceCandidates(input.request, await discoveryExecution(input.sourceId, context))),
    }),
    defineTool({ name: "companies.discovery-capabilities", version: 1, description: "只读查看宿主是否配置企业招聘搜索能力，不联网检测、不返回服务端点或凭据。", effect: "read-index",
      inputSchema: emptyInput, outputSchema: CompanyCareerDiscoveryCapabilitiesSchema,
      execute: (_input, context) => guarded(async () => {
        context.throwIfCancelled();
        const provider = options.careerWebSearchProvider;
        return { schemaVersion: 1 as const, webSearch: provider ? { configured: true as const,
          providerId: provider.metadata?.providerId ?? "host-installed", label: provider.metadata?.label ?? "Host-installed career search" } : { configured: false as const } };
      }),
    }),
    defineTool({ name: "companies.discover-careers", version: 1, description: "匹配已登记企业招聘来源，或使用宿主搜索及允许的官网范围发现招聘入口，返回带证据的待审提案。", effect: "external-read",
      inputSchema: DiscoverCompanyCareersRequestSchema, outputSchema: CompanyCareerDiscoveryResultSchema,
      execute: (input, context) => guarded(async () => discoverCompanyCareers(input.request, {
        ...(input.sourceId ? await discoveryExecution(input.sourceId, context) : { source: nameOnlyDiscoverySource, context: { ...context, observedAt: now() }, transport }),
        registeredSources: (await repository.readSnapshot()).sources, ...(options.careerWebSearchProvider ? { searchProvider: options.careerWebSearchProvider } : {}),
      })),
    }),
    defineTool({ name: "sources.inspect", version: 1, description: "有限检查候选结构、字段覆盖和许可元数据，不执行陌生仓库代码。", effect: "external-read",
      inputSchema: z.object({ sourceId: EntityIdSchema, request: InspectSourceCandidateInputSchema }).strict(), outputSchema: SourceCandidateInspectionSchema,
      execute: (input, context) => guarded(async () => inspectSourceCandidate(input.request, await discoveryExecution(input.sourceId, context))),
    }),
    defineTool({ name: "sources.propose", version: 1, description: "生成禁用且待审核的来源配置提案，必须另行明确注册和启用。", effect: "read-index",
      inputSchema: ProposeSourceRegistrationInputSchema, outputSchema: SourceRegistrationProposalSchema, execute: (input) => guarded(async () => proposeSourceRegistration(input)),
    }),
    defineTool({ name: "jobs.import-public", version: 1, description: "只导入公共白名单快照；私人绑定与投递材料应留在浏览器。", effect: "local-write", inputSchema: z.object({ dataset: AtlasDatasetSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(), outputSchema: ImportReceiptSchema,
      execute: (input, context) => guarded(async () => { context.throwIfCancelled(); return repository.importSnapshot(input.dataset, { expectedRevision: input.expectedRevision, actorScope: context.actorScope, idempotencyKey: key(context) }); }),
    }),
    defineTool({ name: "jobs.export-public", version: 1, description: "导出公共岗位快照，不包含浏览器简历、投递记录或服务凭据。", effect: "read-index", inputSchema: emptyInput, outputSchema: AtlasDatasetSchema, execute: () => guarded(() => repository.readSnapshot()) }),
    defineTool({ name: "jobs.read-detail", version: 1, description: "返回同一索引版本中的岗位、结构化地点、薪资分项、全部来源、观察和不可变JD快照，保留多源差异。", effect: "read-index", inputSchema: z.object({ jobId: EntityIdSchema }).strict(),
      outputSchema: z.object({ snapshotRevision: RevisionSchema, job: CanonicalJobSchema, company: CompanySchema, locations: z.array(JobLocationSchema), compensations: z.array(CompensationSchema), listings: z.array(SourceListingSchema), observations: z.array(SourceObservationSchema), snapshots: z.array(JdSnapshotSchema), sources: z.array(SourceDefinitionSchema) }).strict(),
      execute: (input) => guarded(async () => {
        const snapshot = await repository.readSnapshot();
        // Resolve against the captured snapshot so a concurrent merge/revoke cannot mix IDs and rows.
        const resolved = await repository.resolveJobId(input.jobId, { atRevision: snapshot.revision });
        const job = snapshot.jobs.find((job) => job.id === resolved?.canonicalJobId); if (!job) throw new ToolError("invalid-input");
        const locationIds = new Set(job.locationIds), compensationIds = new Set(job.compensationIds);
        const listings = snapshot.listings.filter((listing) => job.listingIds.includes(listing.id));
        return { snapshotRevision: snapshot.revision, job, company: snapshot.companies.find((company) => company.id === job.companyId)!, locations: snapshot.locations.filter((location) => locationIds.has(location.id)), compensations: snapshot.compensations.filter((compensation) => compensationIds.has(compensation.id)), listings, observations: snapshot.observations.filter((observation) => job.listingIds.includes(observation.listingId)), snapshots: snapshot.snapshots.filter((item) => job.listingIds.includes(item.listingId)), sources: snapshot.sources.filter((source) => listings.some((listing) => listing.sourceId === source.sourceId)) };
      }),
    }),
    defineTool({ name: "runs.list", version: 1, description: "查看持久手动刷新任务和明确的完成/部分/失败状态。", effect: "read-index", inputSchema: emptyInput, outputSchema: z.array(SyncRunSchema), execute: () => guarded(() => repository.listRuns()) }),
    defineTool({ name: "runs.read", version: 1, description: "查看指定刷新任务。", effect: "read-index", inputSchema: z.object({ runId: EntityIdSchema }).strict(), outputSchema: SyncRunSchema, execute: (input) => guarded(async () => { const run = await repository.getRun(input.runId); if (!run) throw new ToolError("invalid-input"); return run; }) }),
    defineTool({ name: "runs.cancel", version: 1, description: "取消自己发起的指定任务，阻止该代迟到写入。", effect: "local-write", inputSchema: z.object({ runId: EntityIdSchema }).strict(), outputSchema: SyncRunSchema, execute: (input, context) => guarded(async () => { const result = await repository.cancelRun(input.runId, { actorScope: context.actorScope }); running.get(input.runId)?.abort(); return result; }) }),
    defineTool({ name: "leads.list", version: 1, description: "列出发现线索与招聘批次，不能把它们计为完整岗位。", effect: "read-index", inputSchema: emptyInput, outputSchema: z.array(DiscoveryLeadSchema), execute: () => guarded(() => repository.listDiscoveryLeads()) }),
  ];
  const registry = createToolRegistry(definitions.map((definition) => ({ ...definition, execute: (input: unknown, context: ToolHandlerContext) => {
    const signal = AbortSignal.any([context.signal, stopSignal.signal]);
    return definition.execute(input, { ...context, signal, throwIfCancelled: () => { context.throwIfCancelled(); if (signal.aborted) throw new ToolError("cancelled"); } });
  } })));
  return { registry, query, sources, shutdown: async () => {
    stopping = true;
    stopSignal.abort();
    for (const controller of running.values()) controller.abort();
    while (pending.size) await Promise.allSettled([...pending]);
  } };
}
import { createHash } from "node:crypto";
