import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CloudRuntimeBindingSchema, LocalRuntimeBindingSchema, PrivacyBudgetSchema, PrivacyError, PrivacyPipeline, PrivacyPolicySchema, PrivacySourceSchema, privacyDigest, privacyRuntimeFingerprint, privacySourceSnapshotHash } from "../privacy/index.js";
import type { CloudDisclosureReply, CloudPrivacyAdapter, CloudRuntimeBinding, DisclosureApproval, DisclosureDraft, LocalPrivacyAdapter, LocalRuntimeBinding, PrivacyAccess, PrivacyAuditEvent, PrivacyBudget, PrivacyLifecycle, PrivacyPolicy, PrivacySource, PrivacyTaskBinding } from "../privacy/index.js";
import type { StudioArtifactStore } from "./storage.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PRIVACY_OPERATION_KIND = "career-privacy-operation";
export type PrivacyStudioContext = { taskRevision: number; sources: PrivacySource[]; policy: PrivacyPolicy; budget: PrivacyBudget };
export type StoredPrivacyOperation = {
  id: string; contextId: string; requestedFields: string[]; createdAt: string;
  binding: PrivacyTaskBinding; localClaims: string[]; localCalls: number;
  runtime: { local: LocalRuntimeBinding; cloud?: CloudRuntimeBinding };
  phase: "preparing" | "prepared" | "approved" | "dispatching" | "completed" | "stopped" | "revoked";
  draft?: DisclosureDraft; approval?: DisclosureApproval; result?: CloudDisclosureReply;
  dispatchClaim?: { operationId: string; draftHash: string; approvalHash: string; recipientFingerprint: string; at: string; status: "unknown" | "completed" };
  audit: PrivacyAuditEvent[]; stoppedCode?: string;
};
export class PrivacyHttpError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); this.name = "PrivacyHttpError"; } }
const prepareSchema = z.object({ contextId: opaque, expectedTaskRevision: z.number().int().nonnegative(), requestedFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(20) }).strict();
const approveSchema = z.object({ operationId: opaque, expectedDraftHash: hash, approvedFields: z.array(z.string()).min(1).max(20), expectedRecipientFingerprint: hash, consent: z.literal(true) }).strict();
const dispatchSchema = z.object({ operationId: opaque, approvalId: opaque, expectedDraftHash: hash, expectedRecipientFingerprint: hash }).strict();

/** Persistent owner-private adapter around the existing PrivacyPipeline. Only
 * derived operation artifacts live here. Workspace sources, identity, provider
 * selection and credentials remain injected authorities; no queue or Fact DB.
 * A dispatch claim is persisted as UNKNOWN before crossing the wire and is
 * never released on failure/restart. Preview/consent vaults are intentionally
 * process-local: after restart, a new preview + authorization is required. */
export function createPrivacyHttp<OwnerAccess>(options: {
  ownerId: string;
  store: StudioArtifactStore;
  translateAccess(access: OwnerAccess): PrivacyAccess | Promise<PrivacyAccess>;
  getContext(contextId: string, access: OwnerAccess): Promise<PrivacyStudioContext>;
  selectedLocal(contextId: string, access: OwnerAccess, context: PrivacyStudioContext): Promise<LocalPrivacyAdapter>;
  configuredCloud?: CloudPrivacyAdapter;
  readBody(request: IncomingMessage): Promise<unknown>;
  sendJson(response: ServerResponse, status: number, data: unknown): void;
}) {
  if (options.store.ownerId !== options.ownerId || !opaque.safeParse(options.ownerId).success) throw new PrivacyHttpError("privacy_store_owner_mismatch", 403);
  const scope = new AsyncLocalStorage<OwnerAccess>(), runtimes = new Map<string, PrivacyPipeline>();
  let closed = false;
  const prefix = "/api/v1/agent/career-studio/privacy";
  async function access(ownerAccess: OwnerAccess): Promise<PrivacyAccess> {
    if (closed) throw new PrivacyHttpError("privacy_http_closed", 503);
    let resolved: PrivacyAccess;
    try { resolved = await options.translateAccess(ownerAccess); } catch { throw new PrivacyHttpError("privacy_authorization_unavailable", 403); }
    if (resolved.ownerId !== options.ownerId || !await resolved.valid()) throw new PrivacyHttpError("privacy_owner_authorization_changed", 403);
    return resolved;
  }
  function stored(id: string): StoredPrivacyOperation {
    if (!opaque.safeParse(id).success) throw new PrivacyHttpError("invalid_privacy_operation", 400);
    try {
      const record = options.store.get<StoredPrivacyOperation>(PRIVACY_OPERATION_KIND, id);
      if (!record || record.value.binding.ownerId !== options.ownerId) throw new PrivacyHttpError("privacy_operation_not_found", 404);
      return structuredClone(record.value);
    } catch (error) { if (error instanceof PrivacyHttpError) throw error; throw new PrivacyHttpError("privacy_storage_unavailable", 503); }
  }
  function mutate(id: string, change: (operation: StoredPrivacyOperation) => void): StoredPrivacyOperation {
    try {
      const record = options.store.get<StoredPrivacyOperation>(PRIVACY_OPERATION_KIND, id);
      if (!record || record.value.binding.ownerId !== options.ownerId) throw new PrivacyHttpError("privacy_operation_not_found", 404);
      const value = structuredClone(record.value); change(value);
      return options.store.put(PRIVACY_OPERATION_KIND, id, record.revision, value).value;
    } catch (error) { if (error instanceof PrivacyHttpError) throw error; throw new PrivacyHttpError("privacy_storage_cas_or_unavailable", 503); }
  }
  async function context(contextId: string, ownerAccess: OwnerAccess) {
    const authorized = await access(ownerAccess);
    let value: PrivacyStudioContext;
    try {
      const raw = await options.getContext(contextId, ownerAccess);
      value = { taskRevision: z.number().int().nonnegative().parse(raw.taskRevision), sources: z.array(PrivacySourceSchema).min(1).max(200).parse(raw.sources), policy: PrivacyPolicySchema.parse(raw.policy), budget: PrivacyBudgetSchema.parse(raw.budget) };
    } catch { throw new PrivacyHttpError("privacy_context_unavailable", 409); }
    let local: LocalPrivacyAdapter, localBinding: LocalRuntimeBinding, cloudBinding: CloudRuntimeBinding | undefined;
    try {
      local = await options.selectedLocal(contextId, ownerAccess, value);
      localBinding = LocalRuntimeBindingSchema.parse(await local.binding());
    } catch { throw new PrivacyHttpError("privacy_selected_local_unavailable", 503); }
    if (options.configuredCloud) try { cloudBinding = CloudRuntimeBindingSchema.parse(await options.configuredCloud.binding()); } catch { throw new PrivacyHttpError("privacy_configured_cloud_unavailable", 503); }
    if (!await authorized.valid()) throw new PrivacyHttpError("privacy_owner_authorization_changed", 403);
    const binding: PrivacyTaskBinding = { ownerId: authorized.ownerId, sessionId: authorized.sessionId, sessionGeneration: authorized.sessionGeneration, authorizationGeneration: authorized.authorizationGeneration, taskRevision: value.taskRevision, sourceSnapshotHash: privacySourceSnapshotHash(value.sources), policyVersion: value.policy.version, localRuntimeFingerprint: privacyRuntimeFingerprint(localBinding), cloudRuntimeFingerprint: cloudBinding ? privacyRuntimeFingerprint(cloudBinding) : "0".repeat(64), budget: value.budget, status: "active" };
    return { access: authorized, context: value, local, localBinding, cloudBinding, binding };
  }
  function runtime(id: string, create = false): PrivacyPipeline {
    const existing = runtimes.get(id); if (existing) return existing;
    if (!create) throw new PrivacyHttpError(stored(id).dispatchClaim ? "privacy_dispatch_outcome_unknown_no_replay" : "privacy_restart_requires_fresh_preview", 409);
    const lifecycle: PrivacyLifecycle = {
      current: async taskId => {
        if (taskId !== id) throw new PrivacyHttpError("privacy_operation_binding_mismatch");
        const operation = stored(id);
        if (operation.binding.status !== "active") return operation.binding;
        const ownerAccess = scope.getStore();
        if (ownerAccess === undefined) throw new PrivacyHttpError("privacy_host_access_scope_missing", 403);
        return (await context(operation.contextId, ownerAccess)).binding;
      },
      reserveLocal: async claim => {
        let accepted = false;
        mutate(id, operation => {
          const key = `${claim.operationId}:${claim.stage}`;
          if (operation.binding.status !== "active" || claim.taskId !== id || claim.operationId !== id || privacyDigest(operation.binding.budget) !== privacyDigest(claim.budget) || operation.localClaims.includes(key) || operation.localCalls >= operation.binding.budget.maxLocalCalls) return;
          operation.localClaims.push(key); operation.localCalls++; accepted = true;
        });
        return accepted;
      },
      reserveDispatch: async claim => {
        let accepted = false;
        mutate(id, operation => {
          if (operation.binding.status !== "active" || claim.taskId !== id || claim.operationId !== id || operation.dispatchClaim || operation.phase !== "approved" || operation.draft?.hash !== claim.draftHash || operation.approval?.hash !== claim.approvalHash || operation.binding.cloudRuntimeFingerprint !== claim.recipientFingerprint || privacyDigest(operation.binding.budget) !== privacyDigest(claim.budget)) return;
          operation.dispatchClaim = { operationId: id, draftHash: claim.draftHash, approvalHash: claim.approvalHash, recipientFingerprint: claim.recipientFingerprint, at: new Date().toISOString(), status: "unknown" };
          operation.phase = "dispatching"; accepted = true;
        });
        return accepted;
      },
      audit: async event => { mutate(id, operation => { if (operation.audit.length >= 200) throw new PrivacyHttpError("privacy_audit_capacity"); operation.audit.push(structuredClone(event)); }); },
    };
    const pipeline = new PrivacyPipeline(lifecycle); runtimes.set(id, pipeline); return pipeline;
  }
  const stopped = (id: string, error: unknown) => {
    const code = error instanceof PrivacyError || error instanceof PrivacyHttpError ? error.code : "privacy_operation_failed";
    try { mutate(id, operation => { operation.stoppedCode = code; if (operation.phase !== "revoked" && operation.phase !== "completed") operation.phase = "stopped"; }); } catch { /* Fail closed; do not overwrite an unknown dispatch claim. */ }
  };
  async function prepare(raw: unknown, ownerAccess: OwnerAccess) {
    for (const [id, pipeline] of runtimes) if (Date.parse(stored(id).createdAt) + 600_000 < Date.now()) { pipeline.close(); runtimes.delete(id); }
    if (runtimes.size >= 100) throw new PrivacyHttpError("privacy_active_preview_capacity", 429);
    const input = prepareSchema.parse(raw), resolved = await context(input.contextId, ownerAccess);
    if (resolved.context.taskRevision !== input.expectedTaskRevision) throw new PrivacyHttpError("privacy_task_revision_changed");
    const id = randomUUID(), operation: StoredPrivacyOperation = { id, contextId: input.contextId, requestedFields: input.requestedFields, createdAt: new Date().toISOString(), binding: resolved.binding, localClaims: [], localCalls: 0, runtime: { local: resolved.localBinding, ...(resolved.cloudBinding ? { cloud: resolved.cloudBinding } : {}) }, phase: "preparing", audit: [] };
    try { options.store.put(PRIVACY_OPERATION_KIND, id, 0, operation); } catch { throw new PrivacyHttpError("privacy_storage_unavailable", 503); }
    try {
      const draft = await scope.run(ownerAccess, () => runtime(id, true).prepare({ taskId: id, operationId: id, access: resolved.access, sources: resolved.context.sources, policy: resolved.context.policy, requestedFields: input.requestedFields, local: resolved.local }));
      const latest = await context(input.contextId, ownerAccess);
      if (privacyDigest(latest.binding) !== privacyDigest(operation.binding)) throw new PrivacyHttpError("privacy_binding_changed");
      mutate(id, value => { if (value.binding.status !== "active") throw new PrivacyHttpError("privacy_operation_revoked"); value.draft = draft; value.phase = "prepared"; });
      return { operationId: id, draft, runtime: operation.runtime, recipientFingerprint: operation.binding.cloudRuntimeFingerprint, localRuntimeFingerprint: operation.binding.localRuntimeFingerprint, budget: operation.binding.budget, cloudAvailable: !!options.configuredCloud };
    } catch (error) { stopped(id, error); runtimes.get(id)?.close(); runtimes.delete(id); throw error; }
  }
  async function approve(raw: unknown, ownerAccess: OwnerAccess) {
    const input = approveSchema.parse(raw), authorized = await access(ownerAccess), operation = stored(input.operationId);
    if (!options.configuredCloud) throw new PrivacyHttpError("privacy_cloud_not_configured", 503);
    if (operation.binding.status !== "active" || operation.phase !== "prepared" || operation.dispatchClaim) throw new PrivacyHttpError("privacy_operation_not_approvable");
    const recipient = CloudRuntimeBindingSchema.parse(await options.configuredCloud.binding());
    if (privacyRuntimeFingerprint(recipient) !== input.expectedRecipientFingerprint) throw new PrivacyHttpError("privacy_recipient_consent_mismatch");
    try {
      const approval = await scope.run(ownerAccess, () => runtime(input.operationId).approve({ draftId: operation.draft!.id, expectedDraftHash: input.expectedDraftHash, approvedFields: input.approvedFields, recipient, access: authorized, consent: input.consent }));
      mutate(input.operationId, value => { if (value.binding.status !== "active") throw new PrivacyHttpError("privacy_operation_revoked"); value.approval = approval; value.phase = "approved"; });
      return { operationId: input.operationId, approval };
    } catch (error) { stopped(input.operationId, error); runtimes.get(input.operationId)?.close(); runtimes.delete(input.operationId); throw error; }
  }
  async function dispatch(raw: unknown, ownerAccess: OwnerAccess) {
    const input = dispatchSchema.parse(raw), authorized = await access(ownerAccess), operation = stored(input.operationId);
    if (!options.configuredCloud) throw new PrivacyHttpError("privacy_cloud_not_configured", 503);
    if (operation.dispatchClaim) throw new PrivacyHttpError("privacy_dispatch_already_claimed_no_replay");
    if (operation.phase !== "approved" || operation.approval?.id !== input.approvalId || operation.approval.recipientFingerprint !== input.expectedRecipientFingerprint) throw new PrivacyHttpError("privacy_dispatch_consent_mismatch");
    try {
      const result = await scope.run(ownerAccess, () => runtime(input.operationId).dispatch({ approvalId: input.approvalId, expectedDraftHash: input.expectedDraftHash, access: authorized, cloud: options.configuredCloud! }));
      const latest = await context(operation.contextId, ownerAccess);
      if (privacyDigest(latest.binding) !== privacyDigest(operation.binding)) throw new PrivacyHttpError("privacy_binding_changed");
      mutate(input.operationId, value => { if (value.binding.status !== "active" || !value.dispatchClaim) throw new PrivacyHttpError("privacy_operation_revoked"); value.result = result; value.phase = "completed"; value.dispatchClaim.status = "completed"; });
      runtimes.get(input.operationId)?.close(); runtimes.delete(input.operationId);
      return { operationId: input.operationId, result, adopted: false as const };
    } catch (error) { stopped(input.operationId, error); runtimes.get(input.operationId)?.close(); runtimes.delete(input.operationId); throw error; }
  }
  async function read(operationId: string, ownerAccess: OwnerAccess) {
    await access(ownerAccess); const operation = stored(operationId);
    return { operation, continuation: operation.dispatchClaim?.status === "completed" ? "completed_no_replay" : runtimes.has(operationId) ? "available" : operation.dispatchClaim?.status === "unknown" ? "unknown_dispatch_no_replay" : "fresh_preview_required", cloudAvailable: !!options.configuredCloud };
  }
  async function metadata(raw: unknown, ownerAccess: OwnerAccess) {
    const input = z.object({ contextId: opaque }).strict().parse(raw), resolved = await context(input.contextId, ownerAccess);
    return { taskRevision: resolved.binding.taskRevision, sourceSnapshotHash: resolved.binding.sourceSnapshotHash, allowedFields: resolved.context.policy.allowedFields, budget: resolved.binding.budget, runtime: { local: resolved.localBinding, ...(resolved.cloudBinding ? { cloud: resolved.cloudBinding } : {}) }, localRuntimeFingerprint: resolved.binding.localRuntimeFingerprint, recipientFingerprint: resolved.binding.cloudRuntimeFingerprint, cloudAvailable: !!options.configuredCloud, localOnlySourceCount: resolved.context.sources.filter(source => source.classification === "local_only").length };
  }
  async function revoke(operationId: string, ownerAccess: OwnerAccess) {
    await access(ownerAccess); const operation = stored(operationId);
    runtimes.get(operationId)?.invalidateSession(operation.binding.sessionId);
    mutate(operationId, value => { value.binding.status = "revoked"; value.phase = "revoked"; });
    runtimes.get(operationId)?.close(); runtimes.delete(operationId);
    return { operationId, revoked: true as const, sentDataCannotBeRecalled: !!operation.dispatchClaim };
  }
  return {
    prefix, prepare, approve, dispatch, read, revoke, metadata,
    async handleOwner(request: IncomingMessage, response: ServerResponse, pathname: string, ownerAccess: OwnerAccess): Promise<boolean> {
      if (!pathname.startsWith(`${prefix}/`)) return false;
      response.setHeader("cache-control", "no-store");
      try {
        if (request.method !== "POST") throw new PrivacyHttpError("privacy_method_not_allowed", 405);
        const data = await options.readBody(request);
        if (Buffer.byteLength(JSON.stringify(data) ?? "") > 256_000) throw new PrivacyHttpError("privacy_input_limit", 413);
        const route = pathname.slice(prefix.length + 1);
        const result = route === "context" ? await metadata(data, ownerAccess) : route === "prepare" ? await prepare(data, ownerAccess) : route === "approve" ? await approve(data, ownerAccess) : route === "dispatch" ? await dispatch(data, ownerAccess) : route === "read" ? await read(z.object({ operationId: opaque }).strict().parse(data).operationId, ownerAccess) : route === "revoke" ? await revoke(z.object({ operationId: opaque }).strict().parse(data).operationId, ownerAccess) : undefined;
        if (result === undefined) throw new PrivacyHttpError("privacy_route_not_found", 404);
        options.sendJson(response, 200, result);
      } catch (error) {
        const code = error instanceof PrivacyHttpError || error instanceof PrivacyError ? error.code : error instanceof z.ZodError ? "invalid_privacy_input" : "privacy_operation_failed";
        options.sendJson(response, error instanceof PrivacyHttpError ? error.status : error instanceof z.ZodError ? 400 : 409, { error: code });
      }
      return true;
    },
    invalidateSession(sessionId: string): void {
      for (const [id, pipeline] of runtimes) { pipeline.invalidateSession(sessionId); const operation = stored(id); if (operation.binding.sessionId === sessionId) mutate(id, value => { value.binding.status = "revoked"; value.phase = "revoked"; }); }
    },
    close(): void { closed = true; for (const pipeline of runtimes.values()) pipeline.close(); runtimes.clear(); },
  };
}
