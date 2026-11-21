import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineTool, normalizeSourceUrl, SourceDefinitionSchema, ToolError, type ToolHandlerContext } from "@better-me/opportunities";
import {
  createCareerWebSearchProvider, discoverOfficialJobs, discoverWorkableJobs, discoverSmartRecruitersJobs, discoverWorkdayJobs, discoverEightfoldJobs, withEmployerGroupEvidence,
  interleaveEmployers, rankOfficialJob, DiscoverOfficialJobsInputSchema, OfficialJobDiscoveryResultSchema,
  createWebJobDiscoveryState, expandWebJobDiscovery, canExpandWebDiscovery,
  type CareerWebSearchProvider, type OfficialJobDiscoveryCandidate, type DiscoverOfficialJobsInput, type WebJobDiscoveryState, type OfficialJobDiscoveryResult, type SourcePage, type SourceTransport,
} from "@better-me/source-adapters";
import { emptyDelta, OFFICIAL_DISCOVERY_SOURCE_ID, projectSourcePage, sourceProjectionSelection, workableDiscoveryIdentity } from "./projection.js";
import { type JobRepository, RepositoryError } from "./repository.js";
import { ImportReceiptSchema } from "./repository-schema.js";

const evidenceTtlMs = 60 * 60_000;
const maxRemembered = 800;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// This source preserves per-posting links. Saving a job grants no recurring fetch access.
const officialDetailSource = SourceDefinitionSchema.parse({
  sourceId: OFFICIAL_DISCOVERY_SOURCE_ID, name: "按岗位发现的企业招聘原文", adapterId: "official-job-detail", adapterVersion: "1",
  capabilities: [], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "disabled", remoteFilters: [],
  endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "企业招聘原文 · 按岗位发现", usage: "unknown", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 1, maxPages: 1, requestsPerMinute: 1 },
});

type Evidence = { actorScope: string; expiresAt: number; observedAt: string; job: OfficialJobDiscoveryCandidate };
function evidencePage({ job, observedAt }: Evidence): SourcePage {
  if (job.verification !== "official-detail" || !job.company || !job.description || !job.verificationEvidence) throw new ToolError("invalid-input");
  const sourceRecordId = job.detailEvidenceUrl === "https://jobs.workable.com/api/v1/jobs/" + job.jobId ? workableDiscoveryIdentity(job.jobId) : undefined;
  const quote = (field: string, value: string) => ({ field, quote: value.slice(0, 20_000), sourceUrl: job.detailEvidenceUrl ?? job.url });
  return {
    observedAt, coverage: { complete: false, partial: true, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [],
    records: [{
      title: job.title, companyName: job.company, url: job.url, ...(sourceRecordId ? { sourceRecordId } : {}), entityType: "job-posting", description: job.description,
      locations: job.location ? [{ raw: job.location }] : [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [],
      availability: job.availability, ...(job.availability === "open" ? { availabilityBasis: "detail-explicit" as const } : {}), completeness: "detail",
      evidence: [quote("title", job.title), quote("companyName", job.company), quote("description", job.description),
        ...(job.location ? [quote("locations", job.location)] : []), ...(job.travelEvidence ? [quote("description", job.travelEvidence)] : [])],
      warnings: [],
    }],
  };
}

// A single stalled detail must not erase successful reads from the same employer or provider.
export const discoverAcrossSources: typeof discoverOfficialJobs = async (input, execution) => {
  const { context } = execution;
  async function run(discover: typeof discoverOfficialJobs, label: string) {
    const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(45_000)]);
    const bounded = (transport: SourceTransport): SourceTransport => ({
      async request(request) {
        deadline.throwIfAborted();
        const signal = AbortSignal.any([request.context.signal, deadline, AbortSignal.timeout(9000)]);
        return transport.request({ ...request, context: { ...request.context, signal,
          throwIfCancelled() { request.context.throwIfCancelled(); signal.throwIfAborted(); } } });
      },
    });
    try {
      return await discover(input, { ...execution, transport: bounded(execution.transport),
        ...(execution.detailTransport ? { detailTransport: bounded(execution.detailTransport) } : {}) });
    } catch {
      context.throwIfCancelled();
      return { status: "provider-unavailable" as const, candidates: [], queries: [], warnings: [label + " 未完成本次读取。"] };
    }
  }
  const results = await Promise.all([run(discoverWorkableJobs, "Workable"), run(discoverOfficialJobs, "网页搜索"),
    run(discoverSmartRecruitersJobs, "SmartRecruiters"), run(discoverWorkdayJobs, "Workday"), run(discoverEightfoldJobs, "Eightfold")]);
  const ordered = results.flatMap(item => item.candidates).map(withEmployerGroupEvidence)
    .sort((a, b) => rankOfficialJob(b, input) - rankOfficialJob(a, input) || a.url.localeCompare(b.url));
  const jobs: OfficialJobDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const job of ordered) {
    const url = normalizeSourceUrl(job.url);
    const identity = job.verification === "official-detail" && job.company && job.jobId
      ? JSON.stringify([job.company.toLowerCase(), job.jobId, job.title.toLowerCase()]) : url;
    if (seen.has(url) || seen.has(identity)) continue;
    seen.add(url); seen.add(identity); jobs.push(job);
  }
  const verified = jobs.filter(job => job.verification === "official-detail");
  const byEmployer = interleaveEmployers(verified, job => job.employerGroup?.name ?? job.company!);
  const leads = interleaveEmployers(jobs.filter(job => job.verification === "unverified-lead"), job => job.company ?? new URL(job.url).hostname);
  return OfficialJobDiscoveryResultSchema.parse({
    observedAt: context.observedAt, status: results.every(item => item.status === "provider-unavailable") ? "provider-unavailable" : "partial",
    queries: [...new Set(results.flatMap(item => item.queries))].slice(0, 48), candidates: [...byEmployer, ...leads.slice(0, 8)].slice(0, 36),
    warnings: [...new Set(results.flatMap(item => item.warnings))].slice(0, 20),
  });
};

export function createOfficialJobDiscoveryTools(options: {
  repository: JobRepository; now: () => string; transport: SourceTransport; detailTransport: SourceTransport; searchProvider?: CareerWebSearchProvider;
}, discover = discoverAcrossSources) {
  const { repository, now } = options;
  const provider = options.searchProvider ?? createCareerWebSearchProvider({ provider: "duckduckgo-html" });
  const remembered = new Map<string, Evidence>();
  const sessions = new Map<string, { actorScope: string; criteria: DiscoverOfficialJobsInput; expiresAt: number; state: WebJobDiscoveryState; busy: boolean }>();

  // Receipts survive restarts but unsaved discoveries are bounded and short-lived.
  function prune(time: number) {
    for (const [key, entry] of remembered) if (entry.expiresAt <= time) remembered.delete(key);
    for (const [id, session] of sessions) if (!session.busy && session.expiresAt <= time) sessions.delete(id);
  }

  function importCommand(candidateId: string, context: ToolHandlerContext) {
    context.throwIfCancelled();
    if (!context.idempotencyKey) throw new ToolError("invalid-context");
    return { actorScope: context.actorScope, idempotencyKey: "official-job:" + digest(context.idempotencyKey), requestFingerprint: digest(candidateId) };
  }
  async function save(candidateId: string, context: ToolHandlerContext) {
    const command = importCommand(candidateId, context);
    const prior = await repository.findImportReceipt(command);
    if (prior) return prior;
    prune(Date.parse(now()));
    const evidence = remembered.get(candidateId);
    if (!evidence || evidence.actorScope !== context.actorScope) throw new ToolError("stale-version");
    const page = evidencePage(evidence);
    const selection = await sourceProjectionSelection(officialDetailSource, page);
    const url = normalizeSourceUrl(evidence.job.url);
    // Another import or source sync may commit while this one computes the projection.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await repository.readProjectionSnapshot(selection, url);
      context.throwIfCancelled();
      const existingSource = before.sources.find(item => item.sourceId === officialDetailSource.sourceId);
      if (existingSource && !isDeepStrictEqual(existingSource, officialDetailSource)) throw new ToolError("source-changed");
      const owners = new Set(before.listings.filter(item => item.canonicalUrl === url).map(item => item.canonicalJobId));
      if (owners.size > 1) throw new ToolError("source-changed");
      const existing = before.jobs.find(job => owners.has(job.id));
      let delta;
      if (existing) {
        delta = emptyDelta(before.revision);
        delta.jobs.push(existing);
      } else {
        const projection = await projectSourcePage(before, officialDetailSource, page, "official-job:" + digest(url + evidence.observedAt));
        delta = projection.delta;
        for (const location of delta.locations) location.kind = "unknown";
      }
      context.throwIfCancelled();
      try { return await repository.importSnapshot(delta, { ...command, projectedRevision: before.revision }); }
      catch (error) { if (!(error instanceof RepositoryError) || error.code !== "stale-version" || attempt === 2) throw error; }
    }
    throw new ToolError("stale-version");
  }

  return [
    defineTool({
      name: "jobs.discover-official", version: 1, effect: "external-read",
      description: "按职位、技能和地区跨公司查找招聘原文，继续发现未登记的官网和招聘目录；保存前只展示候选和证据。",
      inputSchema: DiscoverOfficialJobsInputSchema, outputSchema: OfficialJobDiscoveryResultSchema,
      execute: async (input, context) => {
        const { continueDiscovery, ...criteria } = input;
        const time = Date.parse(now());
        prune(time);
        const execution = {
          searchProvider: provider, transport: options.transport, detailTransport: options.detailTransport,
          context: { ...context, observedAt: now() }, registeredSources: await repository.readSourceDefinitions(),
        };
        let result: OfficialJobDiscoveryResult;
        if (continueDiscovery) {
          const session = sessions.get(continueDiscovery);
          if (!session || session.actorScope !== context.actorScope || session.expiresAt <= time || !isDeepStrictEqual(criteria, session.criteria)) throw new ToolError("stale-version");
          if (session.busy || !canExpandWebDiscovery(session.state)) throw new ToolError("invalid-context");
          session.busy = true;
          try {
            const state = structuredClone(session.state);
            const previousCompanies = state.knownCompanies.size;
            result = await expandWebJobDiscovery(criteria, state, execution);
            context.throwIfCancelled();
            result.discovery = { sessionId: continueDiscovery, round: state.round, checkedPages: state.visited.size,
              pendingPages: state.queued.length, newCompanies: state.knownCompanies.size - previousCompanies, canContinue: canExpandWebDiscovery(state) };
            result = OfficialJobDiscoveryResultSchema.parse(result);
            session.state = state;
            session.expiresAt = Date.parse(now()) + evidenceTtlMs;
          } finally { session.busy = false; }
        } else {
          result = OfficialJobDiscoveryResultSchema.parse(await discover(criteria, execution));
          context.throwIfCancelled();
          const sessionId = randomUUID();
          const state = createWebJobDiscoveryState(criteria, result);
          if (sessions.size >= 12) {
            const oldest = [...sessions].find(([, session]) => !session.busy);
            if (oldest) sessions.delete(oldest[0]);
          }
          if (sessions.size < 12) {
            sessions.set(sessionId, { actorScope: context.actorScope, criteria, expiresAt: Date.parse(now()) + evidenceTtlMs, state, busy: false });
            result.discovery = { sessionId, round: 0, checkedPages: state.visited.size, pendingPages: state.queued.length,
              newCompanies: state.knownCompanies.size, canContinue: canExpandWebDiscovery(state) };
          }
        }
        context.throwIfCancelled();
        prune(Date.parse(now()));
        for (const job of result.candidates) {
          delete job.candidateId;
          if (job.verification !== "official-detail") continue;
          if (remembered.size >= maxRemembered) remembered.delete(remembered.keys().next().value!);
          job.candidateId = randomUUID();
          remembered.set(job.candidateId, { actorScope: context.actorScope, observedAt: result.observedAt, expiresAt: Date.parse(now()) + evidenceTtlMs, job: structuredClone(job) });
        }
        return result;
      },
    }),
    defineTool({
      name: "jobs.import-discovered-official", version: 1, effect: "local-write",
      description: "将选中的已读取企业职位原文加入本机岗位索引，同一原文链接复用已有岗位。",
      inputSchema: z.object({ candidateId: z.uuid() }).strict(), outputSchema: ImportReceiptSchema,
      execute: ({ candidateId }, context) => save(candidateId, context),
      recoverInterrupted: ({ candidateId }, context) => repository.findImportReceipt(importCommand(candidateId, context)),
    }),
  ] as const;
}
