import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashCommitteeText, createCareerSimulationSnapshot, simulateCareerInvestment,
  CareerInvestmentPlanSchema, createJobForensicsSnapshot, analyzeJobForensics, type CommitteeSnapshot, type CommitteeReport,
  type IntelligenceBinding } from "@better-me/core/career-intelligence";
import { careerRuntimeBinding, studioAnalysisRuntime, studioCommitteeOperation, type StudioAnalysisTask, type StudioCommitteeTask, type UnderstandingGrant } from "@better-me/agent-contracts";
import { EvidenceBroker } from "../understanding/evidence-broker.js";
import { createLocalOllamaClient, type LocalOllamaClient } from "../privacy/local-ollama.js";
import { containsGitEvidenceSecret } from "../evidence-harvester/git-source.js";
import { EvidenceHarvester } from "../evidence-harvester/service.js";
import { SqliteHarvesterLedger } from "../evidence-harvester/sqlite-ledger.js";
import type { HarvesterWorkspaceAdapter, MicroFactEntry } from "../evidence-harvester/types.js";
import { StudioArtifactStore, StudioError, studioHash } from "./storage.js";
import { convertStudioJobObservations } from "./job-observations.js";
import { StudioContextInputSchema, StudioLocalRuntimeSchema,
  StudioAnalysisRequestSchema, StudioPublicationReviewSchema, StudioIdSchema,
  type StudioAccess, type StudioContext, type StudioOperation, type StudioLocalRuntime } from "./contracts.js";
import { collectPublicDisclosure } from "./public-sources.js";
import { compileEvidenceBadge, renderEvidenceBadge, createSkillJobLinks } from "./evidence-badge.js";
import { readBadgeMetricEvidence, collectBadgeMetrics, type BadgeMetricSelection } from "./badge-metrics.js";
import { resolveVerifiedAtlasJobs, VerifiedAtlasJobSchema, type VerifiedJobResolver, type VerifiedAtlasJob } from "./verified-jobs.js";
import type { TwinVerifiedFact } from "../candidate-twin/types.js";
import { importStudioArchitectureEvidence, loadStudioArchitectureArtifact, saveStudioArchitectureArtifact } from "./architecture-artifacts.js";
import { studioArchitecturePublicationCatalog, studioArchitecturePublicationPreview, studioArchitecturePublicationConfirm } from "./architecture-publication.js";
import type { CommitteeTasks } from "./committee-tasks.js";

const now = () => new Date().toISOString();
const RULES = "career-studio-v1";
const selection = z.object({ contextId: StudioIdSchema, operationId: StudioIdSchema }).strict();
const simulationRequest = StudioAnalysisRequestSchema.extend({ plan: CareerInvestmentPlanSchema }).strict();
const forensicsRequest = z.object({ contextId: StudioIdSchema, idempotencyKey: StudioIdSchema, consent: z.literal(true),
  publicObservations: z.array(z.object({ sourceId: StudioIdSchema, companyKey: StudioIdSchema,
    scope: z.enum(["company", "department", "team"]), departmentKey: StudioIdSchema.nullable(),
    skillIds: z.array(StudioIdSchema).max(100) }).strict()).max(50) }).strict();
const contextRequest = z.object({ contextId: StudioIdSchema }).strict();
const metricFile = z.object({ path: z.string().min(1).max(2000), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()
  .refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < 200, "Select an exact range of at most 200 lines.");
const metricSources = z.object({ root: z.string().min(1).max(2000), transition: z.object({ file: metricFile, format: z.literal("json") }).strict().optional(),
  coverage: z.object({ report: metricFile, manifest: metricFile.optional(), sources: z.array(metricFile).min(1).max(8), format: z.enum(["lcov", "cobertura"]) }).strict().optional(),
}).strict().refine(value => Boolean(value.transition || value.coverage), "Select at least one explicit metric artifact.");
export type StudioPublicationRecord = { id: string; contextId: string; operationId: string; claimId: string; claimHash: string;
  receiptHash: string; fact: TwinVerifiedFact; review: z.infer<typeof StudioPublicationReviewSchema>["review"]; createdAt: string };
type StudioSourceRead = { grant: UnderstandingGrant; request: { operation: "read"; path: string; startLine: number; endLine: number }; hash: string };

/** One owner-private application facade, not a scheduler or a replacement Fact
 * database. Browser-supplied resume/job data is an explicitly selected snapshot,
 * not independently verified business data. All mutating adoption stays in the
 * owning Workspace write gate; analyses and source excerpts stay private here. */
export class CareerStudio {
  readonly store: StudioArtifactStore;
  readonly harvester: EvidenceHarvester;
  private ledger: SqliteHarvesterLedger;
  private controllers = new Map<string, AbortController>();
  private closedSessions = new Set<string>();
  private selectedHarvestRuntime?: StudioLocalRuntime;
  private closed = false;
  private readonly hostGeneration = randomUUID();
  private clients = new Map<string, LocalOllamaClient>();
  get committeeTasks() { return this.options.committeeTasks; }
  constructor(private options: { ownerId: string; directory: string; broker: EvidenceBroker; vorkBinary?: string; resolveVorkBinary?: () => Promise<string | undefined>;
    localClient?: (runtime: StudioLocalRuntime) => LocalOllamaClient; resolveVerifiedJob?: VerifiedJobResolver; committeeTasks?: CommitteeTasks }) {
    this.store = new StudioArtifactStore(options.ownerId, options.directory);
    // A persisted consent belongs to the old interaction, never a new process.
    for (const record of this.store.list<StudioContext>("context", 1000)) if (!record.value.revoked) this.store.put("context", record.id, record.revision, { ...record.value, revoked: true });
    for (const record of this.store.list<StudioOperation>("operation", 1000)) if (record.value.status === "running") this.store.put("operation", record.id, record.revision, { ...record.value, status: "interrupted", errorCode: "host_restarted_no_replay", updatedAt: now() });
    this.ledger = new SqliteHarvesterLedger(options.ownerId, path.join(options.directory, "git-inbox"));
    const workspace: HarvesterWorkspaceAdapter = {
      findReceipt: async key => this.store.get<{ receipt: { id: string; proposalId: string; status: "pending_business_review" } }>("pending-evidence", studioHash(key))?.value.receipt,
      propose: async (input, signal) => {
        signal.throwIfAborted(); const id = studioHash(input.idempotencyKey), previous = this.store.get<{ receipt: { id: string; proposalId: string; status: "pending_business_review" } }>("pending-evidence", id);
        if (previous) return previous.value.receipt;
        const receipt = { id: randomUUID(), proposalId: `git-${input.entry.id}`, status: "pending_business_review" as const };
        // Only an inbox proposal. UI must separately commit a PersonalStatement
        // through the existing Workspace command and attach its actual receipt.
        this.store.put("pending-evidence", id, 0, { receipt, entry: input.entry, review: input.review, createdAt: now() }); return receipt;
      },
    };
    const harvestClient = () => { if (!this.selectedHarvestRuntime) throw new StudioError("explicit_local_runtime_required", 422); return this.local(this.selectedHarvestRuntime); };
    this.harvester = new EvidenceHarvester({ ledger: this.ledger, workspace, model: {
      binding: async () => { const b = await harvestClient().binding(); return { id: b.id, location: b.location, endpointFingerprint: b.endpointFingerprint, model: b.model, modelDigest: b.modelDigest }; },
      complete: input => harvestClient().complete(input),
    } });
  }
  async assertAccess(access: StudioAccess) {
    if (this.closed || !access.session || this.closedSessions.has(access.session) || !await access.valid()
      || this.closed || this.closedSessions.has(access.session)) throw new StudioError("studio_interaction_invalid", 403);
  }
  async createContext(raw: unknown, access: StudioAccess) {
    await this.assertAccess(access); const input = StudioContextInputSchema.parse(raw);
    if (new Set(input.claims.map(c => c.id)).size !== input.claims.length || new Set(input.jobs.map(j => j.id)).size !== input.jobs.length) throw new StudioError("duplicate_studio_input", 400);
    if (Buffer.byteLength(JSON.stringify(input)) > 1_000_000 || containsGitEvidenceSecret(JSON.stringify(input))) throw new StudioError("studio_sensitive_or_large_input", 400);
    const authority = await resolveVerifiedAtlasJobs(input.jobs.map(job => job.id), { resolve: this.options.resolveVerifiedJob,
      isCurrent: async () => { try { await this.assertAccess(access); return true; } catch { return false; } } });
    await this.assertAccess(access);
    const { consent: _consent, ...selected } = input; void _consent;
    // Coordinates and verification/persistence flags received through HTTP are
    // not office authority. Preserve other explicitly selected job content, but
    // keep independently resolved Atlas provenance in a separate sidecar.
    const jobs = selected.jobs.map(job => { const { coordinates: _coordinates, ...content } = job; void _coordinates; return content; });
    const context: StudioContext = { ...selected, jobs, id: randomUUID(), ownerId: this.options.ownerId, session: access.session,
      createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revoked: false, hostGeneration: this.hostGeneration };
    this.store.put("context", context.id, 0, context);
    this.store.put("atlas-job-authority", context.id, 0, { contextId: context.id, ownerId: this.options.ownerId, session: access.session,
      sourceFingerprint: context.sourceFingerprint, ...authority });
    return { context, revision: 1, claimHashes: Object.fromEntries(await Promise.all(context.claims.map(async c => [c.id, await hashCommitteeText(c.text)]))),
      limitations: ["这是本次明确选择的内容快照，不是业务库版本回执或独立真实性认证。", "修改原稿、切号、退出或授权过期后须创建新快照。", ...authority.limitations] };
  }
  async getContext(id: string, access: StudioAccess): Promise<StudioContext> {
    await this.assertAccess(access); StudioIdSchema.parse(id);
    const context = this.store.get<StudioContext>("context", id)?.value;
    if (!context || context.ownerId !== this.options.ownerId || context.session !== access.session || context.revoked || context.hostGeneration !== this.hostGeneration || Date.parse(context.expiresAt) <= Date.now()) throw new StudioError("studio_context_stale", 409);
    return context;
  }
  private async current(id: string, access: StudioAccess, signal?: AbortSignal) { if (signal?.aborted) return false; try { await this.getContext(id, access); return !signal?.aborted; } catch { return false; } }
  async revokeContext(raw: unknown, access: StudioAccess) {
    const { contextId } = contextRequest.parse(raw); await this.getContext(contextId, access);
    const record = this.store.get<StudioContext>("context", contextId)!; this.store.put("context", contextId, record.revision, { ...record.value, revoked: true });
    for (const record of this.store.list<StudioOperation>("operation", 1000)) if (record.value.contextId === contextId && record.value.status === "running") this.controllers.get(record.id)?.abort();
    return { revoked: true };
  }
  local(raw: StudioLocalRuntime): LocalOllamaClient {
    const runtime = StudioLocalRuntimeSchema.parse(raw), key = studioHash(runtime); let client = this.clients.get(key);
    if (!client) { if (this.clients.size >= 8) this.clients.clear(); client = this.options.localClient?.(runtime) ?? createLocalOllamaClient({ model: runtime.model, expectedDigest: runtime.modelDigest }); this.clients.set(key, client); }
    return client;
  }
  async runtimes(access: StudioAccess) {
    await this.assertAccess(access);
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 256_000) throw new StudioError("local_models_unavailable", 503);
    const text = await response.text(); if (Buffer.byteLength(text) > 256_000) throw new StudioError("local_models_unavailable", 503);
    const tags = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), remote_host: z.unknown().optional(), remote_model: z.unknown().optional() }).passthrough()).max(1000) }).parse(JSON.parse(text));
    await this.assertAccess(access); return { runtimes: tags.models.filter(m => !m.remote_host && !m.remote_model && !/cloud/i.test(m.name)).map(m => ({ model: m.name, modelDigest: m.digest })), location: "local", noCloudFallback: true };
  }
  private binding(context: StudioContext): IntelligenceBinding { return { ownerId: this.options.ownerId, workspaceId: context.workspaceKey, sessionGeneration: context.session, factRevision: context.sourceFingerprint, rulesVersion: RULES }; }
  private async begin(kind: string, contextId: string, idempotencyKey: string, input: unknown, access: StudioAccess,
    execute: (context: StudioContext, signal: AbortSignal, operationId: string) => Promise<unknown>, timeoutMs = 360_000): Promise<StudioOperation> {
    const context = await this.getContext(contextId, access), id = studioHash([contextId, kind, idempotencyKey]), inputHash = studioHash(input);
    const existing = this.store.get<StudioOperation>("operation", id);
    if (existing) { if (existing.value.inputHash !== inputHash) throw new StudioError("studio_idempotency_conflict"); return existing.value; }
    if (this.controllers.size >= 3) throw new StudioError("studio_operation_busy", 429);
    const operation: StudioOperation = { id, contextId, kind, inputHash, status: "running", startedAt: now(), updatedAt: now() };
    this.store.put("operation", id, 0, operation);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]); this.controllers.set(id, controller);
    // Deliberately one in-flight bounded invocation. No persisted auto-resume,
    // retry queue or side-effect replay is created on restart.
    void (async () => {
      try {
        const output = await execute(context, signal, id);
        if (!await this.current(contextId, access, signal)) throw new StudioError("studio_result_stale");
        const record = this.store.get<StudioOperation>("operation", id)!;
        if (record.value.status !== "running") return;
        const status = output && typeof output === "object" && "status" in output && !["completed", "available", "passed"].includes(String(output.status)) ? "partial" : "completed";
        this.store.put("operation", id, record.revision, { ...record.value, status, output, updatedAt: now() });
      } catch (error) {
        if (!this.closed) { const record = this.store.get<StudioOperation>("operation", id); if (record?.value.status === "running") this.store.put("operation", id, record.revision, { ...record.value, status: signal.aborted ? "cancelled" : "failed", errorCode: signal.aborted ? "studio_cancelled_or_timed_out" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "studio_analysis_failed", updatedAt: now() }); }
      } finally { this.controllers.delete(id); }
    })();
    return operation;
  }
  async operation(raw: unknown, access: StudioAccess) {
    const { contextId, operationId } = selection.parse(raw); await this.getContext(contextId, access);
    if (operationId.startsWith("ct_")) {
      if (!this.options.committeeTasks) throw new StudioError("studio_committee_task_reader_required", 503);
      const task = await this.options.committeeTasks.get(operationId, access);
      if (task.request.contextId !== contextId || task.ownerId !== this.options.ownerId) throw new StudioError("studio_operation_not_found", 404);
      await this.getContext(contextId, access); return studioCommitteeOperation(task);
    }
    const record = this.store.get<StudioOperation>("operation", operationId);
    if (!record || record.value.contextId !== contextId) throw new StudioError("studio_operation_not_found", 404); return record.value;
  }
  async cancel(raw: unknown, access: StudioAccess) {
    const operation = await this.operation(raw, access);
    if (operation.id.startsWith("ct_")) throw new StudioError("studio_committee_controls_moved_to_agent_tasks", 410);
    this.controllers.get(operation.id)?.abort();
    const record = this.store.get<StudioOperation>("operation", operation.id)!;
    if (record.value.status === "running") this.store.put("operation", record.id, record.revision, { ...record.value, status: "cancelled", updatedAt: now() });
    return this.operation(raw, access);
  }
  async history(raw: unknown, access: StudioAccess) {
    const { contextId } = contextRequest.parse(raw); await this.getContext(contextId, access);
    const tasks = await this.options.committeeTasks?.list(contextId, access) ?? [];
    await this.getContext(contextId, access);
    return { operations: [...this.store.list<StudioOperation>("operation", 1000).map(r => r.value).filter(o => o.contextId === contextId), ...tasks.map(studioCommitteeOperation)] };
  }
  async committee(raw: unknown, access: StudioAccess) {
    void raw; await this.assertAccess(access);
    throw new StudioError("studio_committee_moved_to_agent_tasks", 410);
  }
  async simulation(raw: unknown, access: StudioAccess) {
    const input = simulationRequest.parse(raw);
    return this.begin("simulation", input.contextId, input.idempotencyKey, input, access, async context => {
      if (!context.jobs.length) throw new StudioError("studio_job_cohort_empty", 400);
      const observed = convertStudioJobObservations(context.jobs);
      const sources = [...context.claims.map(c => ({ id: `fact-${c.id}`, hash: studioHash(c), capturedAt: context.createdAt })), ...observed.sources];
      const snapshot = await createCareerSimulationSnapshot({ binding: this.binding(context), authorization: { grantId: context.id, sourceIds: sources.map(s => s.id), expiresAt: context.expiresAt, purpose: "career_simulation" },
        cohort: { id: context.id, revision: context.sourceFingerprint, asOf: now(), jobs: observed.simulationJobs },
        facts: context.claims.map(c => ({ id: c.id, revision: context.sourceFingerprint, text: c.text, skillIds: c.skillIds, support: c.confirmedByUser ? "supported" as const : "unknown" as const,
          contribution: c.contribution, provenance: "user_statement" as const, sourceIds: [`fact-${c.id}`], confirmedByUser: c.confirmedByUser })), sources,
        rules: { version: RULES, maxObservationAgeDays: 30, unlockCoverageThreshold: 80, selfReportedWeight: 0.5 } });
      return simulateCareerInvestment(snapshot, input.plan, { isCurrent: () => this.current(context.id, access) });
    }, 30_000);
  }
  async publicSource(raw: unknown, access: StudioAccess) {
    const input = z.object({ contextId: StudioIdSchema, url: z.string().url(), purpose: z.enum(["job_forensics", "public_technical_evidence"]), consent: z.literal(true) }).strict().parse(raw);
    await this.getContext(input.contextId, access);
    const disclosure = await collectPublicDisclosure({ url: input.url, purpose: input.purpose, consent: true }, { ownerId: this.options.ownerId, valid: () => this.current(input.contextId, access) }, AbortSignal.timeout(10_000));
    if (!this.store.get("public-source", disclosure.id)) this.store.put("public-source", disclosure.id, 0, { contextId: input.contextId, disclosure });
    return disclosure;
  }
  async forensics(raw: unknown, access: StudioAccess) {
    const input = forensicsRequest.parse(raw);
    return this.begin("forensics", input.contextId, input.idempotencyKey, input, access, async context => {
      const observed = convertStudioJobObservations(context.jobs), sources = observed.sources;
      const technical = input.publicObservations.map((o, index) => {
        const record = this.store.get<{ contextId: string; disclosure: Awaited<ReturnType<typeof collectPublicDisclosure>> }>("public-source", o.sourceId);
        if (!record || record.value.contextId !== context.id) throw new StudioError("studio_public_source_not_authorized", 403);
        const d = record.value.disclosure; sources.push({ id: o.sourceId, hash: d.sourceHash, capturedAt: d.capturedAt, url: d.sourceUrl });
        return { id: `technical-${index + 1}`, sourceId: o.sourceId, companyId: o.companyKey, departmentKey: o.departmentKey, observedAt: d.capturedAt, skillIds: o.skillIds, scope: o.scope, activity: "observed" as const };
      });
      const snapshot = await createJobForensicsSnapshot({ binding: this.binding(context), authorization: { grantId: context.id, sourceIds: [...new Set(sources.map(s => s.id))], expiresAt: context.expiresAt, purpose: "job_forensics" }, asOf: now(), sources: [...new Map(sources.map(s => [s.id, s])).values()],
        observations: observed.forensicsObservations, publicTechnicalObservations: technical,
        rules: { version: RULES, longLivedDays: 90, refreshWindowDays: 30, frequentRefreshCount: 5, wideSalaryRatio: 2.5, maxSourceAgeDays: 30 } });
      this.store.put("forensics-snapshot", studioHash(input), 0, snapshot);
      return analyzeJobForensics(snapshot, { isCurrent: () => this.current(context.id, access) });
    }, 30_000);
  }
  async model(raw: unknown, access: StudioAccess) {
    void raw; await this.assertAccess(access); throw new StudioError("studio_model_moved_to_agent_tasks", 410);
  }
  /** Metadata authority only. Every generation and repair belongs to the kernel. */
  async validateAnalysis(task: StudioAnalysisTask | StudioCommitteeTask, access: StudioAccess) {
    const context = await this.getContext(task.request.contextId, access);
    if (task.ownerId !== this.options.ownerId || task.rootScopeKey !== context.workspaceKey
      || task.workspaceKey !== `${task.kind === "studio_committee" ? "studio-committee" : "studio-analysis"}:${context.workspaceKey}`) throw new StudioError("studio_task_scope_mismatch", 403);
    if (studioHash(task.runtimeBinding) !== studioHash(careerRuntimeBinding(studioAnalysisRuntime(task.request.runtime.model)))) throw new StudioError("studio_task_runtime_mismatch", 422);
    const selected = this.store.get<{ runtime: StudioLocalRuntime; session: string }>("context-runtime", context.id)?.value;
    if (!selected || selected.session !== access.session || studioHash(selected.runtime) !== studioHash(task.request.runtime)) throw new StudioError("explicit_local_runtime_required", 422);
    // binding() performs local metadata GETs only, never complete() or routing.
    const binding = await this.local(task.request.runtime).binding();
    if (binding.location !== "local" || binding.model !== task.request.runtime.model || binding.modelDigest !== task.request.runtime.modelDigest) throw new StudioError("local_runtime_changed", 409);
    await this.getContext(context.id, access);
    return context;
  }
  async selectHarvester(raw: unknown, access: StudioAccess) {
    await this.assertAccess(access); const runtime = StudioLocalRuntimeSchema.parse(raw), state = await this.harvester.snapshot(access);
    if (this.selectedHarvestRuntime && studioHash(this.selectedHarvestRuntime) !== studioHash(runtime) && state.subscriptions.some(s => s.status === "active")) throw new StudioError("revoke_harvester_before_runtime_change");
    const binding = await this.local(runtime).binding(); await this.assertAccess(access); this.selectedHarvestRuntime = runtime;
    return { runtime: { id: binding.id, location: binding.location, endpointFingerprint: binding.endpointFingerprint, model: binding.model, modelDigest: binding.modelDigest } };
  }
  async inbox(access: StudioAccess) { const snapshot = await this.harvester.snapshot(access); return { subscriptions: snapshot.subscriptions, entries: snapshot.entries, proposals: this.store.list("pending-evidence").map(r => r.value) }; }
  async markEvidenceAdopted(raw: unknown, access: StudioAccess) {
    const input = z.object({ proposalId: StudioIdSchema, statementId: StudioIdSchema, statementHash: z.string().regex(/^[a-f0-9]{64}$/), expectedProposalHash: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict().parse(raw);
    await this.assertAccess(access);
    const record = this.store.list<{ receipt: { proposalId: string }; entry: MicroFactEntry }>("pending-evidence", 1000).find(r => r.value.receipt.proposalId === input.proposalId);
    if (!record || record.hash !== input.expectedProposalHash) throw new StudioError("studio_evidence_proposal_changed");
    // A client receipt is labeled self-reported until a trusted business readback
    // verifies it; it never changes the source or creates a verified Fact.
    const id = studioHash(input.proposalId); if (!this.store.get("workspace-handoff", id)) this.store.put("workspace-handoff", id, 0, { ...input, status: "client_reported_pending_readback", at: now() });
    return { status: "client_reported_pending_readback", adopted: false };
  }
  async publicationReview(raw: unknown, access: StudioAccess) {
    const input = StudioPublicationReviewSchema.parse(raw), context = await this.getContext(input.contextId, access);
    const operation = await this.operation({ contextId: input.contextId, operationId: input.operationId }, access);
    const current = input.operationId.startsWith("ct_") ? await this.reviewCommittee(context.id, input.operationId, access) : undefined;
    const report = current?.task.result ?? operation.output as CommitteeReport | undefined, snapshot = current?.snapshot ?? this.store.get<CommitteeSnapshot>("committee-snapshot", input.operationId)?.value;
    const claim = context.claims.find(c => c.id === input.claimId), sidecar = report?.claims.find(c => c.claimId === input.claimId);
    if (operation.kind !== "committee" || operation.status !== "completed" || report?.status !== "completed" || !snapshot || !claim || !sidecar
      || sidecar.support !== "supported" || !sidecar.citations.length || sidecar.claimHash !== input.expectedClaimHash || input.expectedClaimHash !== await hashCommitteeText(claim.text)
      || !claim.confirmedByUser || ["unknown", "not_mine"].includes(sidecar.contribution) || input.review.kind !== sidecar.contribution) throw new StudioError("studio_publication_evidence_ineligible");
    await this.revalidateSources(context.id, operation.id, access);
    const summaries = sidecar.citations.map(c => { const source = snapshot.evidence.find(e => e.id === c.evidenceId); if (!source) throw new StudioError("studio_publication_source_missing");
      // Raw private source is deliberately not copied into publication records.
      return { id: c.evidenceId, revision: c.sourceHash, summary: `${source.provenance}：${source.label}；已核对授权片段与引用版本，原文未公开。` }; });
    const id = studioHash([input.contextId, input.claimId, input.idempotencyKey]), previous = this.store.get<StudioPublicationRecord>("publication-review", id);
    if (previous) { if (previous.value.claimHash !== input.expectedClaimHash || studioHash(previous.value.review) !== studioHash(input.review)) throw new StudioError("studio_idempotency_conflict"); return previous.value; }
    const receiptHash = studioHash({ scope: "selected_excerpt_and_explicit_self_statement", reportHash: studioHash(report), snapshot: snapshot.fingerprint, claimHash: sidecar.claimHash, review: input.review });
    const record: StudioPublicationRecord = { id, contextId: context.id, operationId: operation.id, claimId: claim.id, claimHash: sidecar.claimHash, receiptHash,
      fact: { id, revision: sidecar.claimHash, status: "verified", disclosure: "publishable", statement: claim.text, contribution: `${input.review.kind}（本人自述，非独立作者认证）：${input.review.action}；角色：${input.review.role}；部署：${input.review.deployment}`,
        limitations: "仅核对本次授权资料的引用版本与证据支持；个人归属由本人明确自述，不证明生产规模、独立真实性或公司认可。缺失内容保持未知。", evidence: summaries, verificationReceiptHash: receiptHash }, review: input.review, createdAt: now() };
    await this.revalidateSources(context.id, operation.id, access); this.store.put("publication-review", id, 0, record); return record;
  }
  private async revalidateSources(contextId: string, operationId: string, access: StudioAccess) {
    await this.getContext(contextId, access);
    if (operationId.startsWith("ct_")) { await this.reviewCommittee(contextId, operationId, access); return; }
    const readset = this.store.get<{ contextId: string; sources: StudioSourceRead[] }>("committee-readset", operationId)?.value;
    if (!readset || readset.contextId !== contextId) throw new StudioError("studio_source_authority_missing");
    for (const source of readset.sources) {
      const result = await this.options.broker.execute(source.grant, source.request, AbortSignal.timeout(3000));
      if (result.truncated || result.evidence.length !== 1 || result.evidence[0]?.hash !== source.hash) throw new StudioError("studio_source_changed_new_review_required");
    }
    await this.getContext(contextId, access);
  }
  private async reviewCommittee(contextId: string, operationId: string, access: StudioAccess) {
    if (!this.options.committeeTasks) throw new StudioError("studio_committee_task_reader_required", 503);
    const review = await this.options.committeeTasks.review(operationId, access);
    if (review.task.ownerId !== this.options.ownerId || review.task.request.contextId !== contextId) throw new StudioError("studio_operation_not_found", 404);
    await this.getContext(contextId, access); return review;
  }
  private architectureDependencies() { return { store: this.store, broker: this.options.broker,
    getContext: (id: string, access: StudioAccess) => this.getContext(id, access),
    reviewCommittee: (contextId: string, operationId: string, access: StudioAccess) => this.reviewCommittee(contextId, operationId, access) }; }
  async publicationList(access: StudioAccess) { await this.assertAccess(access); return { revision: this.publicationRevision(), facts: this.store.list<StudioPublicationRecord>("publication-review", 1000).map(r => r.value.fact) }; }
  publicationRevision() { return this.store.kindRevision("publication-review"); }
  async badge(raw: unknown, access: StudioAccess) {
    const input = z.object({ contextId: StudioIdSchema, publicationId: z.string().regex(/^[a-f0-9]{64}$/), render: z.boolean(), consent: z.literal(true), idempotencyKey: StudioIdSchema, metricSources: metricSources.optional() }).strict().parse(raw);
    return this.begin("badge", input.contextId, input.idempotencyKey, input, access, async (context, signal) => {
      const publication = this.store.get<StudioPublicationRecord>("publication-review", input.publicationId)?.value;
      if (!publication || publication.contextId !== context.id) throw new StudioError("studio_badge_receipt_missing");
      await this.revalidateSources(context.id, publication.operationId, access);
      const claim = context.claims.find(c => c.id === publication.claimId)!;
      const selected: BadgeMetricSelection = { targetHash: publication.claimHash }, isCurrent = () => this.current(context.id, access, signal);
      if (input.metricSources) {
        const grant = await this.options.broker.grant(input.metricSources.root);
        const read = (file: z.infer<typeof metricFile>) => readBadgeMetricEvidence({ broker: this.options.broker, grant, selection: file, isCurrent, signal });
        if (input.metricSources.transition) selected.transition = { evidence: await read(input.metricSources.transition.file), format: input.metricSources.transition.format };
        if (input.metricSources.coverage) {
          const selection = input.metricSources.coverage;
          selected.coverage = { report: await read(selection.report), format: selection.format, sources: await Promise.all(selection.sources.map(read)),
            ...(selection.manifest ? { manifest: await read(selection.manifest) } : {}) };
        }
      }
      const measurement = await collectBadgeMetrics(selected, { isCurrent, signal });
      if (["stale", "cancelled"].includes(measurement.status)) throw new StudioError("studio_badge_measurement_stale");
      const badge = compileEvidenceBadge({ schemaVersion: 1, artifactId: publication.id, sourceHash: publication.claimHash,
        receipt: { id: publication.id, targetHash: publication.claimHash, status: "passed", verifierVersion: RULES, checks: ["授权资料版本与精确引用核对", "本人贡献自述已明确审阅；不是独立作者认证"], at: publication.createdAt },
        metrics: measurement.metrics, metricReceipts: measurement.metricReceipts, skillIds: claim.skillIds, personalContribution: publication.review.kind });
      const authority = this.store.get<{ contextId: string; ownerId: string; session: string; sourceFingerprint: string; jobs: VerifiedAtlasJob[]; limitations: string[] }>("atlas-job-authority", context.id)?.value;
      const trusted = authority?.contextId === context.id && authority.ownerId === this.options.ownerId && authority.session === access.session
        && authority.sourceFingerprint === context.sourceFingerprint ? z.array(VerifiedAtlasJobSchema).max(50).parse(authority.jobs) : [];
      const links = createSkillJobLinks(badge, context.jobs.map(j => { const record = trusted.find(record => record.jobId === j.id);
        return { id: j.id, skillIds: j.skillIds, sourceHash: record?.sourceHash ?? studioHash(j), persisted: Boolean(record), indexed: Boolean(record),
          ...(record ? { coordinates: { longitude: record.coordinates.longitude, latitude: record.coordinates.latitude, verified: true, precision: "office" as const } } : {}) }; }));
      let rendered: Awaited<ReturnType<typeof renderEvidenceBadge>> | undefined;
      if (input.render) { const configuredBinary = this.options.resolveVorkBinary ? await this.options.resolveVorkBinary() : this.options.vorkBinary;
        if (!configuredBinary) throw new StudioError("badge_renderer_unavailable", 503); const binary = await fs.realpath(configuredBinary).catch(() => "");
        rendered = await renderEvidenceBadge(badge, { binaryPath: binary, ownerId: this.options.ownerId, signal, isCurrent: () => this.current(context.id, access, signal), timeoutMs: 300_000 }); }
      await this.revalidateSources(context.id, publication.operationId, access);
      const finalMeasurement = await collectBadgeMetrics(selected, { isCurrent, signal });
      if (["stale", "cancelled"].includes(finalMeasurement.status) || studioHash(finalMeasurement.metrics) !== studioHash(measurement.metrics)
        || studioHash(finalMeasurement.metricReceipts) !== studioHash(measurement.metricReceipts)) throw new StudioError("studio_badge_measurement_stale");
      return { badge, links, measurement, ...(rendered ? { rendered } : {}), limitations: [
        measurement.metricReceipts.length ? "几何参数仅编码本次明确选择且哈希核对过的静态声明/报告行命中，不证明运行时复杂度或测试真实执行。" : "尚未提供可核对指标采集回执，演进天数、声明条目数及覆盖率均保持未知，使用中性材质。",
        ...measurement.limitations, ...(authority?.limitations ?? ["没有受信岗位服务读回，所有办公室连线保持未知。"]), ...badge.limitations] };
    });
  }
  async loadArtifact(raw: unknown, access: StudioAccess) {
    return loadStudioArchitectureArtifact(this.architectureDependencies(), raw, access);
  }
  async saveArtifact(raw: unknown, access: StudioAccess) {
    return saveStudioArchitectureArtifact(this.architectureDependencies(), raw, access);
  }
  async architectureEvidence(raw: unknown, access: StudioAccess) {
    return importStudioArchitectureEvidence(this.architectureDependencies(), raw, access);
  }
  async architecturePublicationCatalog(raw: unknown, access: StudioAccess) {
    return studioArchitecturePublicationCatalog({ store: this.store, getContext: (id, token) => this.getContext(id, token) }, raw, access);
  }
  async architecturePublicationPreview(raw: unknown, access: StudioAccess) {
    return studioArchitecturePublicationPreview({ store: this.store, getContext: (id, token) => this.getContext(id, token) }, raw, access);
  }
  async architecturePublicationConfirm(raw: unknown, access: StudioAccess) {
    return studioArchitecturePublicationConfirm({ store: this.store, getContext: (id, token) => this.getContext(id, token) }, raw, access);
  }
  async invalidateSession(session: string) {
    this.closedSessions.add(session); for (const r of this.store.list<StudioContext>("context", 1000)) if (r.value.session === session && !r.value.revoked) this.store.put("context", r.id, r.revision, { ...r.value, revoked: true });
    for (const [id, controller] of this.controllers) if (this.store.get<StudioOperation>("operation", id)?.value.contextId && this.store.get<StudioContext>("context", this.store.get<StudioOperation>("operation", id)!.value.contextId)?.value.session === session) controller.abort();
    await this.harvester.invalidateSession(session);
  }
  close() { if (this.closed) return; this.closed = true; for (const c of this.controllers.values()) c.abort(); this.controllers.clear(); this.harvester.close(); this.ledger.close(); this.store.close(); }
}
