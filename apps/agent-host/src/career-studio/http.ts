import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ReplayStepResultSchema } from "@better-me/core/career-intelligence";
import { CareerStudio, type StudioPublicationRecord } from "./service.js";
import { StudioError, studioHash } from "./storage.js";
import { StudioLocalRuntimeSchema, type StudioAccess, type StudioContext, type StudioLocalRuntime } from "./contracts.js";
import { createReplayFeedback } from "./replay-feedback.js";
import { createPrivacyHttp } from "./privacy-http.js";
import { createMcpTwinHttp } from "./mcp-twin-http.js";
import { createMcpClientHttp, type ConfiguredCareerMcpServer } from "./mcp-client-http.js";
import { createOllamaPrivacyAdapter, type CloudPrivacyAdapter } from "../privacy/index.js";
import type { TwinAccess, TwinAuthStamp, StoredCapsule, CandidateCapsuleStore, TwinWorkspaceAdapter } from "../candidate-twin/index.js";
import type { CareerMcpWorkspaceAdapter } from "../career-mcp/index.js";
import { PersonalMicroFactReviewSchema, HarvesterPolicySchema, HarvesterRuntimeSchema } from "../evidence-harvester/types.js";
import { EvidenceAccessError } from "../understanding/evidence-broker.js";
import { createFinalExportHttp, type CareerFinalExportRenderer } from "./final-export-http.js";
import { createStudioPrivacySources } from "./privacy-sources.js";
import { createPrivacyLocalHttp } from "./privacy-local-http.js";
import type { EvidenceBroker } from "../understanding/evidence-broker.js";
import type { LocalOllamaClient } from "../privacy/local-ollama.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const contextInput = z.object({ contextId: id }).strict();
/** Thin HTTP composition only: owning modules enforce their own scopes and
 * write gates. All configuration/executables/cloud credentials are trusted
 * Host options, never request fields or model output. */
export function createCareerStudioHttp(options: {
  studio: CareerStudio; ownerId: string; baseURL: string; allowedOrigins: string[];
  readBody(request: IncomingMessage): Promise<unknown>;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
  mcpServers?: readonly ConfiguredCareerMcpServer[];
  getMcpServers?: () => Promise<readonly ConfiguredCareerMcpServer[]>;
  assertConfiguration?: () => Promise<void>;
  cloud?: CloudPrivacyAdapter;
  finalExportRenderer?: CareerFinalExportRenderer;
  privacyBroker?: Pick<EvidenceBroker, "execute">;
  localEmbeddingClient?(runtime: StudioLocalRuntime, embeddingRuntime: StudioLocalRuntime): LocalOllamaClient;
}) {
  const { studio } = options, sessions = new Map<string, StudioAccess>();
  let closed = false;
  const finalExport = createFinalExportHttp({ studio, renderer: options.finalExportRenderer, readBody: options.readBody, sendJson: options.sendJson });
  const translateAccess = async (access: StudioAccess): Promise<TwinAccess> => {
    await studio.assertAccess(access); if (closed) throw new StudioError("studio_closed", 503); sessions.set(access.session, access);
    return { ownerId: options.ownerId, sessionId: access.session, sessionGeneration: 1, authorizationGeneration: 1,
      valid: async () => !closed && sessions.has(access.session) && await access.valid() };
  };
  const identityValid = async (stamp: TwinAuthStamp) => !closed && stamp.ownerId === options.ownerId && stamp.sessionGeneration === 1
    && stamp.authorizationGeneration === 1 && Boolean(await sessions.get(stamp.sessionId)?.valid());
  const selectedRuntime = async (contextId: string, access: StudioAccess) => {
    await studio.getContext(contextId, access);
    const saved = studio.store.get<{ runtime: StudioLocalRuntime; session: string }>("context-runtime", contextId);
    if (!saved || saved.value.session !== access.session) throw new StudioError("explicit_local_runtime_required", 422);
    return saved.value.runtime;
  };
  const requirePinnedRuntime = async (body: unknown, access: StudioAccess) => {
    const input = z.object({ contextId: id, runtime: StudioLocalRuntimeSchema }).passthrough().parse(body);
    if (studioHash(await selectedRuntime(input.contextId, access)) !== studioHash(input.runtime)) throw new StudioError("studio_runtime_mismatch_new_context_required", 422);
  };
  const replay = createReplayFeedback({ store: studio.store, ownerId: options.ownerId, getContext: (contextId, access) => studio.getContext(contextId, access),
    localModel: async request => {
      const contract = { type: "object", additionalProperties: false, required: ["kind", "summary", "artifact"], properties: {
        kind: { const: "analysis" }, summary: { type: "string", maxLength: 8000 }, artifact: { type: "object", additionalProperties: false,
          required: ["type", "data"], properties: { type: { const: "evidence_summary" }, data: { type: "object", additionalProperties: false, required: ["observations", "unknowns"], properties: {
            observations: { type: "array", maxItems: 40, items: { type: "string", maxLength: 4000 } }, unknowns: { type: "array", maxItems: 40, items: { type: "string", maxLength: 2000 } } } } } } } };
      const client = studio.local(request.runtime);
      const text = await client.complete({ prompt: `执行一个有界的只读职业资料分析步骤。仅根据以下冻结内容与显式假设，保留unknown。不得调用工具、伪造事实或输出内部思维链；只输出可公开的结果摘要、证据观察和限制。\n${JSON.stringify({ operation: request.step.operation, input: request.input, claims: request.context.claims, jobs: request.context.jobs, previousAnalysis: request.analysisOutputs, reviewedRuntimeRules: request.reviewedRuntimeRules })}`,
        jsonSchema: contract, signal: request.signal, budget: { maxInputBytes: 180_000, maxOutputBytes: 32_000, maxActiveMs: 90_000 } });
      return ReplayStepResultSchema.parse(JSON.parse(text));
    } });
  const privacySources = createStudioPrivacySources({ ownerId: options.ownerId, store: studio.store, broker: options.privacyBroker, committeeTasks: studio.committeeTasks, getContext: (contextId, access) => studio.getContext(contextId, access) });
  const privacyLocal = createPrivacyLocalHttp({ ownerId: options.ownerId, store: studio.store, sources: privacySources, translateAccess, selectedRuntime,
    ...(options.localEmbeddingClient ? { localEmbeddingClient: options.localEmbeddingClient } : {}), readBody: options.readBody, sendJson: options.sendJson });
  const privacy = createPrivacyHttp<StudioAccess>({ ownerId: options.ownerId, store: studio.store, translateAccess,
    getContext: async (contextId, access) => {
      const selected = await privacySources.resolve(contextId, access), { context } = selected;
      // User/business identifiers may themselves contain a private name. Only
      // context-bound opaque aliases can enter draft/cloud source metadata.
      return { taskRevision: selected.revision + 1, sources: [...context.claims.map(c => ({ id: `fact-${studioHash([context.id, c.id]).slice(0, 48)}`, revision: context.sourceFingerprint, classification: "summary_allowed" as const, kind: "fact" as const, text: c.text })), ...selected.localSources],
        policy: { version: `career-summary-${selected.policyHash.slice(0, 24)}`, allowedFields: ["evidence_summary", "limitations"], privateTerms: selected.policy?.privateTerms ?? [], maxFieldCharacters: 4000 },
        budget: { revision: 1, maxLocalCalls: 4, maxCloudCalls: 1, maxInputBytes: 128_000, maxOutputBytes: 32_000, maxActiveMs: 180_000 } };
    }, selectedLocal: async (contextId, access) => createOllamaPrivacyAdapter(studio.local(await selectedRuntime(contextId, access)), { budget: { maxInputBytes: 150_000, maxOutputBytes: 32_000, maxActiveMs: 90_000 } }),
    ...(options.cloud ? { configuredCloud: options.cloud } : {}), readBody: options.readBody, sendJson: options.sendJson });
  const publications = () => studio.store.list<StudioPublicationRecord>("publication-review", 1000);
  const workspace: TwinWorkspaceAdapter = {
    currentRevision: async owner => { if (owner !== options.ownerId) throw new StudioError("studio_owner_mismatch", 403); return studio.publicationRevision(); },
    snapshot: async input => { if (input.ownerId !== options.ownerId || input.expectedRevision !== studio.publicationRevision()) throw new StudioError("studio_publication_revision_changed");
      const facts = input.factIds.map(factId => { const fact = publications().find(p => p.id === factId)?.value.fact; if (!fact) throw new StudioError("studio_publication_not_found", 404); return fact; });
      return { ownerId: options.ownerId, revision: input.expectedRevision, facts }; },
    publicationEligible: async input => input.ownerId === options.ownerId && input.expectedRevision === studio.publicationRevision()
      && publications().some(p => p.id === input.fact.id && p.value.receiptHash === input.fact.verificationReceiptHash && studioHash(p.value.fact) === studioHash(input.fact)),
  };
  const capsuleStore: CandidateCapsuleStore = {
    publish: async input => { if (!await identityValid(input.auth) || input.expectedWorkspaceRevision !== studio.publicationRevision()) return false;
      if (studio.store.get("candidate-capsule", input.capsule.id)) return false;
      studio.store.put("candidate-capsule", input.capsule.id, 0, { ownerId: options.ownerId, capsule: input.capsule }, [{ kind: "publication-review", revision: input.expectedWorkspaceRevision }]); return true; },
    read: async capsuleId => studio.store.get<StoredCapsule>("candidate-capsule", capsuleId)?.value,
    revoke: async input => { if (!await identityValid(input.auth)) return false; const previous = studio.store.get<StoredCapsule>("candidate-capsule", input.capsuleId);
      if (!previous || previous.value.capsule.hash !== input.expectedHash) return false;
      studio.store.put("candidate-capsule", input.capsuleId, previous.revision, { ...previous.value, revokedAt: input.at }); return true; },
  };
  const mcpWorkspace: CareerMcpWorkspaceAdapter = {
    listFacts: async input => { if (input.ownerId !== options.ownerId || input.expectedRevision !== studio.publicationRevision()) throw new StudioError("studio_publication_revision_changed");
      const all = publications().map(p => p.value.fact).sort((a, b) => a.id.localeCompare(b.id)), offset = input.cursor ? all.findIndex(f => f.id === input.cursor) + 1 : 0;
      // Publication review checks selected excerpt support/version, not
      // independent authorship. Preserve the explicit personal self-statement
      // and its limits instead of exporting a broader verified certification.
      const slice = all.slice(offset, offset + input.limit); return { revision: input.expectedRevision, facts: slice.map(f => ({ id: f.id, text: f.statement, status: "self_reported" as const, evidenceIds: f.evidence?.map(e => e.id) ?? [],
        ...(f.contribution !== undefined ? { contribution: f.contribution } : {}), ...(f.limitations !== undefined ? { limitations: f.limitations } : {}) })), ...(offset + slice.length < all.length && slice.length ? { nextCursor: slice.at(-1)!.id } : {}) }; },
    proposeEvidence: async input => {
      if (input.expectedRevision !== studio.publicationRevision() || !await input.auth.valid()) throw new StudioError("studio_publication_revision_changed");
      const access = sessions.get(input.auth.sessionId); if (!access) throw new StudioError("studio_interaction_invalid", 403);
      const entry = await studio.harvester.propose(input.reviewId, true, access, input.signal);
      if (!entry.proposalReceipt) throw new StudioError("mcp_pending_proposal_receipt_unknown");
      return { proposalId: entry.proposalReceipt.proposalId, receiptId: entry.proposalReceipt.id, revision: input.expectedRevision, status: "pending_business_review" };
    },
    matchTargetJd: async input => {
      if (input.ownerId !== options.ownerId || input.expectedRevision !== studio.publicationRevision()) throw new StudioError("studio_publication_revision_changed");
      const context = studio.store.list<StudioContext>("context", 1000).map(r => r.value).find(c => c.ownerId === options.ownerId && !c.revoked && Date.parse(c.expiresAt) > Date.now() && c.sourceFingerprint === input.resumeVersionId);
      const job = context?.jobs.find(j => j.id === input.targetJobId);
      if (context && job?.skillIds.length) {
        const reviewed = publications().filter(p => p.value.contextId === context.id), skills = new Set(reviewed.flatMap(p => context.claims.find(c => c.id === p.value.claimId)?.skillIds ?? []));
        const overlap = [...new Set(job.skillIds)].filter(skill => skills.has(skill)), gaps = [...new Set(job.skillIds)].filter(skill => !skills.has(skill));
        return { revision: input.expectedRevision, status: "available", relevanceScore: overlap.length / new Set(job.skillIds).size,
          evidence: overlap.map(skill => `显式技能交集：${skill}`), gaps, limitations: ["仅对已审阅个人陈述与冻结JD的显式技能编号取交集；不是完整硬门槛分析或录用概率。", "个人归属为本人自述；岗位在招、薪资和公司认可不由此证明。"] };
      }
      return { revision: studio.publicationRevision(), status: "unknown", evidence: [], gaps: [job ? "仅有冻结岗位自述快照；未批准足够的匹配证据。" : "未授权该简历或目标岗位版本。"], limitations: ["相关度不是录用概率；本工具不会申请职位或采用简历补丁。"] };
    },
    reserve: async input => { if (closed || input.ownerId !== options.ownerId) return false;
      const day = new Date().toISOString().slice(0, 10), record = studio.store.get<{ count: number }>("mcp-output-budget", day), count = record?.value.count ?? 0;
      if (count >= 1000) return false; studio.store.put("mcp-output-budget", day, record?.revision ?? 0, { count: count + 1 }); return true; },
  };
  const twin = createMcpTwinHttp<StudioAccess>({ ownerId: options.ownerId, workspace, mcpWorkspace, capsuleStore, identityValid, translateAccess,
    mayDelegate: async stamp => identityValid(stamp),
    baseURL: options.baseURL, allowedOrigins: options.allowedOrigins, readBody: options.readBody, sendJson: options.sendJson });
  const mcpClient = createMcpClientHttp<StudioAccess>({ ownerId: options.ownerId, store: studio.store, translateAccess,
    getServerConfigurations: async access => { await studio.assertAccess(access); return [...(options.getMcpServers ? await options.getMcpServers() : options.mcpServers ?? [])]; }, readBody: options.readBody, sendJson: options.sendJson });
  const methods: Record<string, (body: unknown, access: StudioAccess) => Promise<unknown>> = {
    "/context/create": (b, a) => studio.createContext(b, a), "/context/revoke": async (b, a) => { const result = await studio.revokeContext(b, a); await privacyLocal.stopContext(contextInput.parse(b).contextId); return result; },
    "/operation/read": (b, a) => studio.operation(b, a), "/operation/cancel": (b, a) => studio.cancel(b, a), "/operation/list": (b, a) => studio.history(b, a),
    "/simulation/start": (b, a) => studio.simulation(b, a),
    "/forensics/start": (b, a) => studio.forensics(b, a), "/sources/read": (b, a) => studio.publicSource(b, a),
    "/model": (b, a) => studio.model(b, a), "/badge/start": (b, a) => studio.badge(b, a),
    "/artifact/load": (b, a) => studio.loadArtifact(b, a), "/artifact/save": (b, a) => studio.saveArtifact(b, a),
    "/architecture/evidence": (b, a) => studio.architectureEvidence(b, a),
    "/architecture/publication/catalog": (b, a) => studio.architecturePublicationCatalog(b, a),
    "/architecture/publication/preview": (b, a) => studio.architecturePublicationPreview(b, a),
    "/architecture/publication/confirm": (b, a) => studio.architecturePublicationConfirm(b, a),
    "/publication/review": (b, a) => studio.publicationReview(b, a), "/publication/list": (_b, a) => studio.publicationList(a),
    "/capsules/list": async (_b, a) => { await studio.assertAccess(a); return { capsules: studio.store.list<StoredCapsule>("candidate-capsule", 1000).map(r => r.value) }; },
    "/harvest/select-runtime": (b, a) => studio.selectHarvester(b, a), "/harvest/inbox": (_b, a) => studio.inbox(a),
    "/harvest/preview": (b, a) => studio.harvester.preview(z.object({ root: z.string().min(1).max(2000) }).strict().parse(b).root, a),
    "/harvest/subscribe": (b, a) => studio.harvester.subscribe(z.object({ previewId: id, runtime: HarvesterRuntimeSchema, policy: HarvesterPolicySchema, consent: z.literal(true), idempotencyKey: id }).strict().parse(b), a),
    "/harvest/poll": (b, a) => studio.harvester.poll(z.object({ subscriptionId: id }).strict().parse(b).subscriptionId, a),
    "/harvest/watch": async (b, a) => { const i = z.object({ subscriptionId: id, intervalMs: z.number().int().min(60_000).max(3_600_000), consent: z.literal(true) }).strict().parse(b); await studio.harvester.installWatcher(i.subscriptionId, i.intervalMs, true, a); return { installed: true, type: "process_local_opt_in_timer_not_git_hook", requiresReauthorizationAfterRestart: true }; },
    "/harvest/revoke": (b, a) => studio.harvester.revoke(z.object({ subscriptionId: id }).strict().parse(b).subscriptionId, a),
    "/harvest/review": (b, a) => { const i = z.object({ entryId: id, review: PersonalMicroFactReviewSchema }).strict().parse(b); return studio.harvester.review(i.entryId, i.review, a); },
    "/harvest/propose": (b, a) => { const i = z.object({ entryId: id, consent: z.literal(true) }).strict().parse(b); return studio.harvester.propose(i.entryId, true, a, AbortSignal.timeout(15_000)); },
    "/harvest/reconcile": (b, a) => studio.harvester.reconcile(z.object({ entryId: id }).strict().parse(b).entryId, a),
    "/harvest/handoff": (b, a) => studio.markEvidenceAdopted(b, a),
    "/replay/create": replay.replayCreate, "/replay/continue": replay.replayContinue, "/replay/fork": replay.replayFork,
    "/replay/get": (b, a) => { const i = z.object({ runId: id, contextId: id }).strict().parse(b); return replay.replayGet(i.runId, i.contextId, a); },
    "/feedback/identity": (b, a) => replay.feedbackIdentity(contextInput.parse(b).contextId, a),
    "/feedback/save": replay.feedbackSave, "/feedback/analyze": replay.feedbackAnalyze,
    "/rules/propose": replay.rulePropose, "/rules/apply": replay.ruleApply, "/rules/revert": replay.ruleRevert, "/rules/export": replay.ruleExport,
    "/rules/runtime": (b, a) => replay.runtimeRules(contextInput.parse(b).contextId, a),
    "/runtime/select": async (b, a) => { const i = z.object({ contextId: id, runtime: StudioLocalRuntimeSchema, consent: z.literal(true) }).strict().parse(b); await studio.getContext(i.contextId, a);
      await studio.local(i.runtime).binding(); await studio.getContext(i.contextId, a); const old = studio.store.get("context-runtime", i.contextId);
      if (old && studioHash(old.value) !== studioHash({ runtime: i.runtime, session: a.session })) throw new StudioError("context_runtime_change_requires_new_context");
      if (!old) studio.store.put("context-runtime", i.contextId, 0, { runtime: i.runtime, session: a.session }); return { selected: true, runtime: i.runtime }; },
  };
  return {
    studio, twin, privacy, mcpClient, replay,
    handlePublic: twin.handlePublic,
    async handleOwner(req: IncomingMessage, res: ServerResponse, pathname: string, access: StudioAccess) {
      const prefix = "/api/v1/agent/career-studio"; if (!pathname.startsWith(`${prefix}/`)) return false;
      try {
        await options.assertConfiguration?.();
        await translateAccess(access);
        if (pathname === `${prefix}/model`) { options.sendJson(res, 410, { error: "studio_model_moved_to_agent_tasks" }); return true; }
        if (pathname === `${prefix}/committee/start`) { options.sendJson(res, 410, { error: "studio_committee_moved_to_agent_tasks" }); return true; }
        if (await finalExport(req, res, pathname, access) || await twin.handleOwner(req, res, pathname, access) || await privacyLocal.handleOwner(req, res, pathname, access) || await privacy.handleOwner(req, res, pathname, access) || await mcpClient.handleOwner(req, res, pathname, access)) return true;
        if (req.method === "GET" && pathname === `${prefix}/runtimes`) { options.sendJson(res, 200, await studio.runtimes(access)); return true; }
        if (req.method !== "POST") throw new StudioError("studio_method_denied", 405);
        const method = methods[pathname.slice(prefix.length)]; if (!method) throw new StudioError("studio_route_not_found", 404);
        const body = await options.readBody(req); if (Buffer.byteLength(JSON.stringify(body) ?? "") > 1_200_000) throw new StudioError("studio_input_too_large", 413);
        const requiresRuntime = ["/simulation/start", "/replay/create", "/replay/continue", "/replay/fork"].includes(pathname.slice(prefix.length));
        if (requiresRuntime) await requirePinnedRuntime(body, access);
        const output = await method(body, access); await studio.assertAccess(access); await options.assertConfiguration?.();
        if (requiresRuntime) await requirePinnedRuntime(body, access);
        options.sendJson(res, 200, output);
      } catch (error) {
        const code = error instanceof StudioError || error instanceof EvidenceAccessError ? error.code : error instanceof z.ZodError ? "invalid_studio_input" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "studio_request_failed";
        options.sendJson(res, error instanceof StudioError ? error.status : error instanceof z.ZodError ? 400 : 409, { error: code });
      }
      return true;
    },
    async invalidateSession(session: string) { sessions.delete(session); twin.invalidateSession(session); privacy.invalidateSession(session); privacyLocal.invalidateSession(session); await mcpClient.invalidateSession(session); await studio.invalidateSession(session); },
    async close() { if (closed) return; closed = true; sessions.clear(); twin.close(); privacy.close(); privacyLocal.close(); await mcpClient.close(); studio.close(); },
  };
}
