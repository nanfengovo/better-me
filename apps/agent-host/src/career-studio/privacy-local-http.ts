import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createLocalOllamaClient, createOllamaPrivacyAdapter, PrivacyPipeline, PrivacyError, privacyDigest, privacySourceSnapshotHash, privacyRuntimeFingerprint } from "../privacy/index.js";
import type { LocalOllamaClient, PrivacyAccess, PrivacyLifecycle, PrivacyTaskBinding } from "../privacy/index.js";
import type { StudioAccess, StudioLocalRuntime } from "./contracts.js";
import { StudioError, studioHash, type StudioArtifactStore } from "./storage.js";
import { PRIVACY_SOURCE_POLICY_KIND, PrivacySourceConfigureSchema, type StudioPrivacySources } from "./privacy-sources.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const searchSchema = z.object({ contextId: id, operationId: id, expectedRevision: z.number().int().positive(), query: z.string().trim().min(1).max(2000), topK: z.number().int().min(1).max(8).default(5), consent: z.literal(true) }).strict();
type SearchOperation = { id: string; phase: "running" | "completed" | "stopped" | "cancelled"; inputHash: string; queryHash: string; sourceSnapshotHash: string;
  scopeRevision: number; scopeHash: string; runtimeFingerprint: string; claimed: boolean; createdAt: string; stoppedCode?: string;
  results?: { sourceId: string; similarity: number }[]; audit: { stage: string; code: string; at: string }[] };
type SearchLedger = { contextId: string; ownerId: string; session: string; scopeRevision: number; usedCalls: number; operations: SearchOperation[] };
const SEARCH_KIND = "privacy-local-search";
const localBudget = { revision: 1, maxLocalCalls: 1, maxCloudCalls: 1 as const, maxInputBytes: 128_000, maxOutputBytes: 256_000, maxActiveMs: 60_000 };

/** A bounded local vector search, not a vector database or cloud tool. Vectors,
 * query bodies and private excerpts are never persisted in the search ledger.
 * A single aggregate CAS consumes one authorized call before /api/embed. */
export function createPrivacyLocalHttp(options: {
  ownerId: string; store: StudioArtifactStore; sources: StudioPrivacySources;
  translateAccess(access: StudioAccess): PrivacyAccess | Promise<PrivacyAccess>;
  selectedRuntime(contextId: string, access: StudioAccess): Promise<StudioLocalRuntime>;
  localEmbeddingClient?(runtime: StudioLocalRuntime, embeddingRuntime: StudioLocalRuntime): LocalOllamaClient;
  readBody(request: IncomingMessage): Promise<unknown>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}) {
  const prefix = "/api/v1/agent/career-studio/privacy/local", active = new Map<string, { contextId: string; session: string; controller: AbortController; pipeline: PrivacyPipeline }>();
  let closed = false;
  async function auth(access: StudioAccess) {
    if (closed) throw new StudioError("privacy_local_closed", 503);
    const stamp = await options.translateAccess(access);
    if (stamp.ownerId !== options.ownerId || !await stamp.valid()) throw new StudioError("privacy_local_authority_changed", 403);
    return stamp;
  }
  async function selected(contextId: string, access: StudioAccess, signal?: AbortSignal) {
    await auth(access); const resolved = await options.sources.resolve(contextId, access, signal), runtime = await options.selectedRuntime(contextId, access);
    if (!resolved.policy?.embeddingRuntime || resolved.policy.consent.embedding !== true) throw new StudioError("privacy_local_embedding_not_selected", 422);
    if (!resolved.localSources.length) throw new StudioError("privacy_local_no_selected_source", 422);
    const embedding = resolved.policy.embeddingRuntime;
    const client = options.localEmbeddingClient?.(runtime, embedding) ?? createLocalOllamaClient({ model: runtime.model, expectedDigest: runtime.modelDigest, embeddingModel: embedding.model, expectedEmbeddingDigest: embedding.modelDigest });
    const adapter = createOllamaPrivacyAdapter(client, { budget: { maxInputBytes: localBudget.maxInputBytes, maxOutputBytes: localBudget.maxOutputBytes, maxActiveMs: localBudget.maxActiveMs } });
    const binding = await adapter.binding();
    if (binding.model !== runtime.model || binding.modelDigest !== runtime.modelDigest || binding.embeddingModel !== embedding.model || binding.embeddingDigest !== embedding.modelDigest || !adapter.embed) throw new StudioError("privacy_local_embedding_binding_mismatch", 422);
    await auth(access); signal?.throwIfAborted(); return { ...resolved, runtime, adapter, binding };
  }
  function mutate(contextId: string, change: (value: SearchLedger) => void) {
    const record = options.store.get<SearchLedger>(SEARCH_KIND, contextId);
    if (!record || record.value.ownerId !== options.ownerId) throw new StudioError("privacy_local_search_missing", 404);
    const value = structuredClone(record.value); change(value); return options.store.put(SEARCH_KIND, contextId, record.revision, value).value;
  }
  function result(contextId: string, operationId: string) {
    const ledger = options.store.get<SearchLedger>(SEARCH_KIND, contextId)?.value, operation = ledger?.operations.find(item => item.id === operationId);
    if (!ledger || ledger.ownerId !== options.ownerId || !operation) throw new StudioError("privacy_local_search_missing", 404);
    return { operation, usedCalls: ledger.usedCalls, trust: "local_similarity_not_fact_verification", adopted: false as const, limitations: ["仅所选原授权片段的本地向量相似度，不是事实支持、个人归属或录用概率。", "查询、向量与源码不会写入搜索历史或云端出口。未知或中断不会自动重试。"] };
  }
  async function stopContext(contextId: string, code = "privacy_local_scope_changed") {
    for (const [key, call] of active) if (call.contextId === contextId) { call.controller.abort(); call.pipeline.close(); active.delete(key); }
    const previous = options.store.get<SearchLedger>(SEARCH_KIND, contextId);
    if (previous?.value.operations.some(item => item.phase === "running")) mutate(contextId, value => { for (const operation of value.operations) if (operation.phase === "running") { operation.phase = "cancelled"; operation.stoppedCode = code; } });
  }
  async function configure(raw: unknown, access: StudioAccess, signal?: AbortSignal) {
    const input = PrivacySourceConfigureSchema.parse(raw); await auth(access);
    if (input.embeddingRuntime) {
      const runtime = await options.selectedRuntime(input.contextId, access), embedding = input.embeddingRuntime;
      const client = options.localEmbeddingClient?.(runtime, embedding) ?? createLocalOllamaClient({ model: runtime.model, expectedDigest: runtime.modelDigest, embeddingModel: embedding.model, expectedEmbeddingDigest: embedding.modelDigest });
      const binding = await client.binding();
      if (binding.model !== runtime.model || binding.modelDigest !== runtime.modelDigest || binding.embeddingModel !== embedding.model || binding.embeddingDigest !== embedding.modelDigest || !client.embed) throw new StudioError("privacy_local_embedding_binding_mismatch", 422);
    }
    const configured = await options.sources.configure(input, access, signal); await stopContext(input.contextId); return configured;
  }
  async function search(raw: unknown, access: StudioAccess, requestSignal?: AbortSignal) {
    const input = searchSchema.parse(raw), stamp = await auth(access);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(localBudget.maxActiveMs), ...(requestSignal ? [requestSignal] : [])]);
    const resolved = await selected(input.contextId, access, signal);
    if (resolved.revision !== input.expectedRevision) throw new StudioError("privacy_source_policy_revision_changed");
    if (active.size >= 2 || active.has(`${input.contextId}:${input.operationId}`)) throw new StudioError("privacy_local_search_capacity", 429);
    const sourceSnapshotHash = privacySourceSnapshotHash(resolved.localSources), runtimeFingerprint = privacyRuntimeFingerprint(resolved.binding);
    const inputHash = studioHash(input), ledger = options.store.get<SearchLedger>(SEARCH_KIND, input.contextId), existing = ledger?.value.operations.find(item => item.id === input.operationId);
    if (existing) {
      if (existing.inputHash !== inputHash || existing.scopeRevision !== resolved.revision) throw new StudioError("privacy_local_idempotency_conflict");
      if (existing.phase === "running" && !active.has(`${input.contextId}:${input.operationId}`)) throw new StudioError("privacy_local_restart_no_replay");
      return result(input.contextId, input.operationId);
    }
    const value: SearchLedger = ledger ? structuredClone(ledger.value) : { contextId: input.contextId, ownerId: options.ownerId, session: access.session, scopeRevision: resolved.revision, usedCalls: 0, operations: [] };
    if (value.session !== access.session || value.operations.length >= 32) throw new StudioError("privacy_local_search_scope_or_history_capacity", 429);
    if (value.scopeRevision !== resolved.revision) { value.scopeRevision = resolved.revision; value.usedCalls = 0; }
    if (value.usedCalls >= resolved.policy!.maxSearchCalls) throw new StudioError("privacy_local_search_budget_exhausted", 429);
    const operation: SearchOperation = { id: input.operationId, phase: "running", inputHash, queryHash: studioHash(input.query), sourceSnapshotHash, scopeRevision: resolved.revision, scopeHash: resolved.policyHash,
      runtimeFingerprint, claimed: false, createdAt: new Date().toISOString(), audit: [] };
    value.operations.push(operation);
    options.store.put(SEARCH_KIND, input.contextId, ledger?.revision ?? 0, value, [{ kind: PRIVACY_SOURCE_POLICY_KIND, revision: options.store.kindRevision(PRIVACY_SOURCE_POLICY_KIND) }]);
    const expected: PrivacyTaskBinding = { ownerId: stamp.ownerId, sessionId: stamp.sessionId, sessionGeneration: stamp.sessionGeneration, authorizationGeneration: stamp.authorizationGeneration,
      taskRevision: resolved.revision, sourceSnapshotHash, policyVersion: `local-search-${resolved.policyHash.slice(0, 24)}`, localRuntimeFingerprint: runtimeFingerprint, cloudRuntimeFingerprint: "0".repeat(64), budget: localBudget, status: "active" };
    const lifecycle: PrivacyLifecycle = {
      current: async () => {
        if (closed || signal.aborted) throw new StudioError("privacy_local_cancelled");
        const latest = await selected(input.contextId, access, signal);
        if (latest.revision !== resolved.revision || latest.policyHash !== resolved.policyHash || privacySourceSnapshotHash(latest.localSources) !== sourceSnapshotHash
          || privacyRuntimeFingerprint(latest.binding) !== runtimeFingerprint || privacyDigest(latest.runtime) !== privacyDigest(resolved.runtime)) throw new StudioError("privacy_local_scope_changed");
        const current = result(input.contextId, input.operationId).operation;
        return { ...expected, status: current.phase === "running" ? "active" : "revoked" };
      },
      reserveLocal: async claim => {
        if (claim.stage !== "local_embedding" || signal.aborted) return false;
        let accepted = false;
        mutate(input.contextId, next => { const op = next.operations.find(item => item.id === input.operationId)!;
          if (op.phase !== "running" || op.claimed || op.scopeHash !== resolved.policyHash || next.usedCalls >= resolved.policy!.maxSearchCalls) return;
          op.claimed = true; next.usedCalls++; accepted = true; }); return accepted;
      },
      reserveDispatch: async () => false,
      audit: async event => { mutate(input.contextId, next => { const op = next.operations.find(item => item.id === input.operationId)!; if (op.audit.length < 10) op.audit.push({ stage: event.stage, code: event.code, at: event.at }); }); },
    };
    const pipeline = new PrivacyPipeline(lifecycle), activeKey = `${input.contextId}:${input.operationId}`;
    active.set(activeKey, { contextId: input.contextId, session: access.session, controller, pipeline });
    try {
      const results = await pipeline.searchLocal({ taskId: input.contextId, operationId: input.operationId, access: stamp, sources: resolved.localSources, query: input.query, topK: input.topK, local: resolved.adapter, signal });
      await lifecycle.current(input.contextId); if (!await stamp.valid() || signal.aborted) throw new StudioError("privacy_local_cancelled");
      mutate(input.contextId, next => { const op = next.operations.find(item => item.id === input.operationId)!; if (op.phase !== "running") throw new StudioError("privacy_local_cancelled"); op.phase = "completed"; op.results = results; });
      return result(input.contextId, input.operationId);
    } catch (error) {
      const code = error instanceof PrivacyError || error instanceof StudioError ? error.code : "privacy_local_search_failed";
      try { mutate(input.contextId, next => { const op = next.operations.find(item => item.id === input.operationId)!; if (op.phase === "running") { op.phase = signal.aborted ? "cancelled" : "stopped"; op.stoppedCode = code; } }); } catch { /* No late output after failed persistence. */ }
      throw new StudioError(code);
    } finally { pipeline.close(); active.delete(activeKey); }
  }
  return { prefix, configure, search,
    async handleOwner(request: IncomingMessage, response: ServerResponse, pathname: string, access: StudioAccess) {
      if (!pathname.startsWith(`${prefix}/`)) return false;
      const controller = new AbortController(), abort = () => controller.abort();
      request.once("aborted", abort); response.once("close", abort); response.setHeader("cache-control", "no-store");
      try {
        if (request.method !== "POST") throw new StudioError("privacy_local_method_denied", 405);
        await auth(access); const body = await options.readBody(request);
        if (Buffer.byteLength(JSON.stringify(body) ?? "") > 32_000) throw new StudioError("privacy_local_input_budget", 413);
        const route = pathname.slice(prefix.length + 1); let output: unknown;
        if (route === "catalog") output = await options.sources.catalog(z.object({ contextId: id }).strict().parse(body).contextId, access);
        else if (route === "configure") output = await configure(body, access, controller.signal);
        else if (route === "search") output = await search(body, access, controller.signal);
        else if (route === "read" || route === "cancel") {
          const input = z.object({ contextId: id, operationId: id }).strict().parse(body); await options.sources.resolve(input.contextId, access, controller.signal);
          if (route === "cancel") {
            const call = active.get(`${input.contextId}:${input.operationId}`); if (call?.contextId === input.contextId && call.session === access.session) { call.controller.abort(); call.pipeline.close(); }
            mutate(input.contextId, next => { const op = next.operations.find(item => item.id === input.operationId); if (!op) throw new StudioError("privacy_local_search_missing", 404); if (op.phase === "running") { op.phase = "cancelled"; op.stoppedCode = "privacy_local_user_cancelled"; } });
          }
          output = result(input.contextId, input.operationId);
        } else throw new StudioError("privacy_local_route_not_found", 404);
        await auth(access); if (!controller.signal.aborted) options.sendJson(response, 200, output);
      } catch (error) { if (!controller.signal.aborted) options.sendJson(response, error instanceof StudioError ? error.status : error instanceof z.ZodError ? 400 : 409, { error: error instanceof StudioError || error instanceof PrivacyError ? error.code : error instanceof z.ZodError ? "invalid_privacy_local_input" : "privacy_local_failed" }); }
      finally { request.removeListener("aborted", abort); response.removeListener("close", abort); }
      return true;
    },
    invalidateSession(session: string) { for (const call of active.values()) if (call.session === session) { call.controller.abort(); call.pipeline.close(); } },
    close() { closed = true; for (const call of active.values()) { call.controller.abort(); call.pipeline.close(); } active.clear(); },
    stopContext,
  };
}
