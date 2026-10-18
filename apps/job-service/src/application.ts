import { z } from "zod";
import {
  AtlasDatasetSchema, CanonicalJobSchema, CompanySchema, SourceDefinitionSchema, SourceListingSchema, SourceObservationSchema, JdSnapshotSchema,
  EntityIdSchema, createJobQueryService, createJobsSearchTool, createToolRegistry, defineTool, normalizeSearchText, ToolError,
  type QueryOptions, type SourceDefinition, type ToolHandlerContext, type ToolDefinition,
} from "@better-me/opportunities";
import {
  SourceScopeSchema, SourcePageSchema, SourceAdapterMetadataSchema, SourceRegistryError, SourceTransportError,
  createSourceRegistry, createControlledSourceTransport, greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter,
  discoverSourceCandidates, inspectSourceCandidate, proposeSourceRegistration,
  DiscoverSourceCandidatesInputSchema, SourceDiscoveryPageSchema, InspectSourceCandidateInputSchema, SourceCandidateInspectionSchema,
  ProposeSourceRegistrationInputSchema, SourceRegistrationProposalSchema,
  type SourceAdapter, type SourceScope, type SourceJobRecord, type SourceTransport,
} from "@better-me/source-adapters";
import { RepositoryError, type JobRepository } from "./repository.js";
import { DiscoveryLeadSchema, ImportReceiptSchema, SyncRunSchema, type PublicRunSummary } from "./repository-schema.js";
import { projectSourcePage } from "./projection.js";

const emptyInput = z.object({}).strict();
const usableScope = SourceScopeSchema.superRefine((scope, context) => {
  for (const [field, terms] of Object.entries(scope)) for (const term of terms) {
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
function locallyMatches(record: SourceJobRecord, scope: SourceScope): boolean {
  const includes = (haystack: string, values: string[]) => !values.length || values.some((term) => normalizeSearchText(haystack).includes(normalizeSearchText(term)));
  return includes(`${record.title} ${record.description ?? ""}`, scope.roles) && includes(record.companyName ?? "", scope.companyNames)
    && includes([...record.locations.map((location) => [location.raw, location.countryCode, location.region, location.city].filter(Boolean).join(" ")), ...record.remoteEligibleRegions].join(" "), scope.regions);
}
export type JobApplicationOptions = {
  repository: JobRepository;
  adapters?: readonly SourceAdapter[];
  transport?: SourceTransport;
  now?: () => string;
  resolveQueryOptions?: (context: ToolHandlerContext) => QueryOptions | Promise<QueryOptions>;
};

/** One application service backs HTTP and future Agent tools. Private opportunity data stays outside. */
export function createJobApplication(options: JobApplicationOptions) {
  const repository = options.repository;
  const now = options.now ?? (() => new Date().toISOString());
  const sources = createSourceRegistry(options.adapters ?? [greenhouseAdapter, leverAdapter, ashbyAdapter, mappedJsonAdapter, githubJsonAdapter]);
  const transport = options.transport ?? createControlledSourceTransport();
  const query = createJobQueryService(repository);
  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  const stopSignal = new AbortController();
  let stopping = false;
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
  const searchTool = createJobsSearchTool(query, async (_query, context) => ({ now: now(), ...(options.resolveQueryOptions ? await options.resolveQueryOptions(context) : {}) }));
  const definitions: ToolDefinition<any, any>[] = [
    defineTool({ ...searchTool, execute: (input, context) => guarded(async () => searchTool.execute(input, context)) }),
    defineTool({ name: "sources.list", version: 1, description: "列出来源配置和已安装适配器的实际能力。", effect: "read-index", inputSchema: emptyInput,
      outputSchema: z.object({ sources: z.array(SourceDefinitionSchema), adapters: z.array(SourceAdapterMetadataSchema) }).strict(),
      execute: () => guarded(async () => ({ sources: (await repository.readSnapshot()).sources, adapters: sources.describe() })),
    }),
    defineTool({ name: "sources.register", version: 1, description: "保存显式来源配置；来源JSON不能导入执行代码或实际密钥。", effect: "local-write",
      inputSchema: z.object({ source: SourceDefinitionSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(), outputSchema: ImportReceiptSchema,
      execute: (input, context) => guarded(async () => {
        context.throwIfCancelled();
        // Disabled candidates can be staged; enabling requires an installed matching adapter.
        if (input.source.enabled) sources.resolve(input.source, "list-jobs", "local-service");
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
    defineTool({ name: "sources.sync", version: 1, description: "在关注范围内手动刷新索引，保留来源观察、部分失败和持久任务回执，不关闭缺席旧岗位。", effect: "local-write", inputSchema: scopeInput,
      outputSchema: z.object({ run: SyncRunSchema, localFilters: SourceScopeSchema, warnings: z.array(z.string()), sourceError: z.object({ code: z.string(), retryAfterSeconds: z.number().nonnegative().optional() }).strict().optional() }).strict(),
      execute: (input, context) => guarded(async () => {
        const sameKey = key(context);
        const requestFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const existing = await repository.findRunByRequest({ actorScope: context.actorScope, idempotencyKey: sameKey, requestFingerprint });
        if (existing) return { run: existing, localFilters: input.scope, warnings: ["This request already has a persistent run. Read its state; a new refresh requires a new key."] };
        const source = await getSource(input.sourceId);
        sources.resolve(source, "list-jobs", "local-service");
        if (source.secretRef) throw new ToolError("needs-auth");
        const maxRecords = Math.min(input.maxRecords ?? source.refreshPolicy.maxRecords, source.refreshPolicy.maxRecords);
        const maxPages = Math.min(input.maxPages ?? source.refreshPolicy.maxPages, source.refreshPolicy.maxPages);
        const run = await repository.startRun({ sourceId: source.sourceId, scope: { keywords: input.scope.roles, regions: input.scope.regions, companies: input.scope.companyNames, maxRecords, maxPages }, actorScope: context.actorScope, idempotencyKey: sameKey, requestFingerprint });
        if (run.status !== "running") return { run, localFilters: input.scope, warnings: ["This idempotent request already has a terminal run; use a new key for a new refresh."] };
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        context.signal.addEventListener("abort", forwardAbort, { once: true });
        if (context.signal.aborted) controller.abort();
        running.set(run.runId, controller);
        const syncContext: ToolHandlerContext = { ...context, signal: controller.signal, throwIfCancelled: () => { context.throwIfCancelled(); if (controller.signal.aborted) throw new ToolError("cancelled"); } };
        const summary: PublicRunSummary = { added: 0, changed: 0, unchanged: 0, records: 0, pages: 0, leads: 0, partial: false };
        const warnings: string[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
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
            const snapshot = await repository.readSnapshot();
            const projection = await projectSourcePage(snapshot, source, { ...page, records: page.records.filter((record) => locallyMatches(record, input.scope)) }, run.runId);
            // Observations may not restore a stale enabled/endpoint/usage configuration.
            projection.delta.sources = [];
            syncContext.throwIfCancelled();
            const receipt = await repository.importSnapshot(projection.delta, { actorScope: context.actorScope, idempotencyKey: `${run.runId}.page-${pageNumber}`, expectedRevision: snapshot.revision, runId: run.runId });
            summary.added! += receipt.counts.newJobs; summary.changed! += receipt.counts.updatedJobs; summary.unchanged! += receipt.counts.unchangedJobs;
            if (projection.leads.length) {
              syncContext.throwIfCancelled();
              await repository.saveDiscoveryLeads(projection.leads, { actorScope: context.actorScope, idempotencyKey: `${run.runId}.leads-${pageNumber}`, runId: run.runId });
              summary.leads! += projection.leads.length;
            }
            if (!page.nextCursor) { summary.partial ||= !page.coverage.complete; break; }
            if (cursors.has(page.nextCursor)) { summary.partial = true; warnings.push("repeated-source-cursor"); break; }
            cursors.add(page.nextCursor); cursor = page.nextCursor;
            if (pageNumber + 1 === maxPages) { summary.partial = true; warnings.push("page-limit"); }
          }
          syncContext.throwIfCancelled();
          const finished = await repository.finishRun(run.runId, { actorScope: context.actorScope, status: summary.partial ? "partial" : "completed", summary });
          return { run: finished, localFilters: input.scope, warnings: [...new Set(warnings)].slice(0, 100) };
        } catch (error) {
          const failure = mappedError(error);
          const current = await repository.getRun(run.runId);
          if (!current) throw failure;
          if (["cancelled", "superseded"].includes(current.status)) return { run: current, localFilters: input.scope, warnings: [failure.code], sourceError: { code: failure.code } };
          const finished = controller.signal.aborted
            ? await repository.cancelRun(run.runId, { actorScope: context.actorScope })
            : await repository.finishRun(run.runId, { actorScope: context.actorScope, status: summary.pages ? "partial" : "failed", summary: { ...summary, partial: Boolean(summary.pages), errorCode: failure.code } });
          return { run: finished, localFilters: input.scope, warnings: [...new Set([...warnings, failure.code])].slice(0, 100), sourceError: { code: failure.code, ...(error instanceof SourceTransportError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } };
        } finally {
          context.signal.removeEventListener("abort", forwardAbort);
          if (running.get(run.runId) === controller) running.delete(run.runId);
        }
      }),
    }),
    defineTool({ name: "sources.discover", version: 1, description: "按已启用的发现端点策略搜索来源候选；候选不自动启用或变成岗位。", effect: "external-read",
      inputSchema: z.object({ sourceId: EntityIdSchema, request: DiscoverSourceCandidatesInputSchema }).strict(), outputSchema: SourceDiscoveryPageSchema,
      execute: (input, context) => guarded(async () => discoverSourceCandidates(input.request, await discoveryExecution(input.sourceId, context))),
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
    defineTool({ name: "jobs.read-detail", version: 1, description: "返回岗位全部来源、观察和不可变JD快照，保留多源差异。", effect: "read-index", inputSchema: z.object({ jobId: EntityIdSchema }).strict(),
      outputSchema: z.object({ job: CanonicalJobSchema, company: CompanySchema, listings: z.array(SourceListingSchema), observations: z.array(SourceObservationSchema), snapshots: z.array(JdSnapshotSchema), sources: z.array(SourceDefinitionSchema) }).strict(),
      execute: (input) => guarded(async () => {
        const snapshot = await repository.readSnapshot();
        const job = snapshot.jobs.find((job) => job.id === input.jobId); if (!job) throw new ToolError("invalid-input");
        const listings = snapshot.listings.filter((listing) => job.listingIds.includes(listing.id));
        return { job, company: snapshot.companies.find((company) => company.id === job.companyId)!, listings, observations: snapshot.observations.filter((observation) => job.listingIds.includes(observation.listingId)), snapshots: snapshot.snapshots.filter((item) => job.listingIds.includes(item.listingId)), sources: snapshot.sources.filter((source) => listings.some((listing) => listing.sourceId === source.sourceId)) };
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
