import { randomUUID } from "node:crypto";
import { z } from "zod";
import { containsLocalOnlyExcerpt, disclosureViolations, privacyDigest, privacySourceSnapshotHash, redactDisclosureText, textDigest } from "./content-guard.js";
import { parseLocalJson } from "./json-repair.js";
import { CloudRuntimeBindingSchema, LocalRuntimeBindingSchema, PrivacyBudgetSchema, PrivacyError, PrivacyPolicySchema, PrivacySourceSchema } from "./types.js";
import type { CloudDisclosureEnvelope, CloudDisclosureReply, CloudPrivacyAdapter, CloudRuntimeBinding, DisclosureApproval, DisclosureDraft, LocalPrivacyAdapter, LocalRuntimeBinding, PrivacyAccess, PrivacyAuditEvent, PrivacyLifecycle, PrivacyPolicy, PrivacySource, PrivacyTaskBinding } from "./types.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const summarySchema = z.object({ fields: z.array(z.object({ name: z.string(), text: z.string(), sourceIds: z.array(opaque).min(1).max(100) }).strict()).min(1).max(20) }).strict();
const replySchema = z.object({ text: z.string().max(128_000), sourceIds: z.array(opaque).max(100), unknowns: z.array(z.string().max(2000)).max(100) }).strict();
const copy = <T>(value: T): T => structuredClone(value);

export function privacyRuntimeFingerprint(binding: LocalRuntimeBinding | CloudRuntimeBinding): string {
  return privacyDigest(binding.location === "local" ? LocalRuntimeBindingSchema.parse(binding) : CloudRuntimeBindingSchema.parse(binding));
}

type StoredDraft = { draft: DisclosureDraft; context: PrivacyTaskBinding; localOnlyCanaries: PrivacySource[]; policy: PrivacyPolicy };
type StoredApproval = { approval: DisclosureApproval; draftId: string; context: PrivacyTaskBinding; revoked: boolean };
type ActiveCall = { sessionId: string; controller: AbortController };

/** A bounded disclosure vault, NOT a second task engine. The Host must supply
 * authoritative atomic lifecycle/budget gates and call invalidateSession on
 * logout/revocation. Restart deliberately loses all previews/consents. */
export class PrivacyPipeline {
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly approvals = new Map<string, StoredApproval>();
  private readonly active = new Set<ActiveCall>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly lifecycle: PrivacyLifecycle, options: { now?: () => number; draftTtlMs?: number; maxDrafts?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.draftTtlMs ?? 300_000;
    this.maxDrafts = options.maxDrafts ?? 100;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 900_000 || !Number.isSafeInteger(this.maxDrafts) || this.maxDrafts < 1 || this.maxDrafts > 2000) throw new PrivacyError("invalid_vault_limits");
  }
  private readonly ttl: number;
  private readonly maxDrafts: number;

  private async current(taskId: string, access: PrivacyAccess): Promise<PrivacyTaskBinding> {
    if (this.closed) throw new PrivacyError("privacy_pipeline_closed");
    if (!opaque.safeParse(taskId).success || !opaque.safeParse(access.ownerId).success || !opaque.safeParse(access.sessionId).success || !Number.isSafeInteger(access.sessionGeneration) || !Number.isSafeInteger(access.authorizationGeneration)) throw new PrivacyError("invalid_privacy_context");
    let valid: boolean, state: PrivacyTaskBinding;
    try { valid = await access.valid(); state = copy(await this.lifecycle.current(taskId)); } catch { throw new PrivacyError("authorization_unavailable"); }
    if (!valid || state.status !== "active" || state.ownerId !== access.ownerId || state.sessionId !== access.sessionId || state.sessionGeneration !== access.sessionGeneration || state.authorizationGeneration !== access.authorizationGeneration) throw new PrivacyError("authorization_changed");
    if (!PrivacyBudgetSchema.safeParse(state.budget).success || !Number.isSafeInteger(state.taskRevision) || !/^[a-f0-9]{64}$/.test(state.sourceSnapshotHash) || !/^[a-f0-9]{64}$/.test(state.localRuntimeFingerprint) || !/^[a-f0-9]{64}$/.test(state.cloudRuntimeFingerprint)) throw new PrivacyError("invalid_lifecycle_binding");
    return state;
  }
  private async unchanged(taskId: string, access: PrivacyAccess, expected: PrivacyTaskBinding): Promise<void> {
    const state = await this.current(taskId, access);
    if (privacyDigest(state) !== privacyDigest(expected)) throw new PrivacyError("privacy_binding_changed");
  }
  private async audit(event: Omit<PrivacyAuditEvent, "at">): Promise<void> {
    try { await this.lifecycle.audit({ ...event, at: new Date(this.now()).toISOString() }); } catch { throw new PrivacyError("privacy_audit_unavailable"); }
  }
  private async reserveLocal(input: Parameters<PrivacyLifecycle["reserveLocal"]>[0]): Promise<void> {
    let reserved: boolean;
    try { reserved = await this.lifecycle.reserveLocal(input); } catch { throw new PrivacyError("local_budget_gate_unavailable"); }
    if (!reserved) throw new PrivacyError("local_budget_exhausted");
  }
  private async reserveDispatch(input: Parameters<PrivacyLifecycle["reserveDispatch"]>[0]): Promise<void> {
    let reserved: boolean;
    try { reserved = await this.lifecycle.reserveDispatch(input); } catch { throw new PrivacyError("cloud_dispatch_gate_unavailable"); }
    if (!reserved) throw new PrivacyError("cloud_dispatch_already_claimed_or_budget_exhausted");
  }
  private prune(): void {
    for (const [id, stored] of this.drafts) if (Date.parse(stored.draft.expiresAt) <= this.now()) this.drafts.delete(id);
    for (const [id, stored] of this.approvals) if (!this.drafts.has(stored.draftId) || Date.parse(stored.approval.expiresAt) <= this.now()) this.approvals.delete(id);
  }
  private async bounded<T>(access: PrivacyAccess, deadline: number, signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new PrivacyError("privacy_cancelled");
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new PrivacyError("privacy_deadline_exceeded");
    const controller = new AbortController(), call: ActiveCall = { sessionId: access.sessionId, controller };
    this.active.add(call);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(new PrivacyError("privacy_cancelled"));
      controller.signal.addEventListener("abort", listener, { once: true });
      timeout = setTimeout(() => { controller.abort(); }, remaining);
    });
    if (signal?.aborted) controller.abort();
    try {
      const result = await Promise.race([execute(controller.signal), interrupted]);
      if (controller.signal.aborted || signal?.aborted) throw new PrivacyError("privacy_cancelled");
      if (this.now() >= deadline) throw new PrivacyError("privacy_deadline_exceeded");
      return result;
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      // Adapter exception text can contain prompt, credentials or remote body.
      throw new PrivacyError(controller.signal.aborted ? "privacy_cancelled" : "privacy_adapter_failed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (listener) controller.signal.removeEventListener("abort", listener);
      signal?.removeEventListener("abort", abort);
      this.active.delete(call);
    }
  }
  private async localBinding(adapter: LocalPrivacyAdapter, expected: PrivacyTaskBinding): Promise<void> {
    let parsed: LocalRuntimeBinding;
    try { parsed = LocalRuntimeBindingSchema.parse(await adapter.binding()); } catch { throw new PrivacyError("local_runtime_unavailable"); }
    if (privacyRuntimeFingerprint(parsed) !== expected.localRuntimeFingerprint) throw new PrivacyError("local_runtime_changed");
  }

  async prepare(input: { taskId: string; operationId: string; access: PrivacyAccess; sources: readonly PrivacySource[]; policy: PrivacyPolicy; requestedFields: readonly string[]; local: LocalPrivacyAdapter; signal?: AbortSignal }): Promise<DisclosureDraft> {
    this.prune();
    if (!opaque.safeParse(input.operationId).success || this.drafts.size >= this.maxDrafts) throw new PrivacyError("privacy_vault_limit");
    let sources: PrivacySource[], policy: PrivacyPolicy;
    try { sources = z.array(PrivacySourceSchema).min(1).max(200).parse(input.sources); policy = PrivacyPolicySchema.parse(input.policy); } catch { throw new PrivacyError("invalid_privacy_input"); }
    const requestedFields = [...input.requestedFields];
    if (!requestedFields.length || new Set(requestedFields).size !== requestedFields.length || requestedFields.some(field => !policy.allowedFields.includes(field)) || new Set(sources.map(source => source.id)).size !== sources.length) throw new PrivacyError("invalid_disclosure_fields");
    const context = await this.current(input.taskId, input.access);
    if (context.sourceSnapshotHash !== privacySourceSnapshotHash(sources) || context.policyVersion !== policy.version) throw new PrivacyError("privacy_binding_changed");
    const bytes = sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0);
    if (bytes > context.budget.maxInputBytes) throw new PrivacyError("local_input_limit");
    const deadline = this.now() + context.budget.maxActiveMs;
    await this.bounded(input.access, deadline, input.signal, () => this.localBinding(input.local, context));
    await this.reserveLocal({ taskId: input.taskId, operationId: input.operationId, stage: "local_scan", budget: context.budget });
    await this.unchanged(input.taskId, input.access, context);
    const inspection = await this.bounded(input.access, deadline, input.signal, signal => input.local.inspect(copy(sources), signal));
    if (!inspection || !Array.isArray(inspection.inspectedSourceIds) || inspection.inspectedSourceIds.length !== sources.length || new Set(inspection.inspectedSourceIds).size !== sources.length || inspection.inspectedSourceIds.some(id => !sources.some(source => source.id === id))) throw new PrivacyError("incomplete_local_inspection");
    // Findings are intentionally never fed into summary input or a cloud envelope.
    await this.audit({ taskId: input.taskId, operationId: input.operationId, stage: "local_scan", code: "local_scan_complete", sourceSnapshotHash: context.sourceSnapshotHash, bytes });
    const eligible = sources.filter(source => source.classification !== "local_only");
    if (!eligible.length) throw new PrivacyError("no_disclosable_sources");
    await this.unchanged(input.taskId, input.access, context);
    await this.bounded(input.access, deadline, input.signal, () => this.localBinding(input.local, context));
    await this.reserveLocal({ taskId: input.taskId, operationId: input.operationId, stage: "local_summary", budget: context.budget });
    await this.unchanged(input.taskId, input.access, context);
    const raw = await this.bounded(input.access, deadline, input.signal, signal => input.local.summarize({ sources: copy(eligible), requestedFields: copy(requestedFields) }, signal));
    const parsed = parseLocalJson(raw, { maxBytes: Math.min(256_000, context.budget.maxOutputBytes), maxRepairs: 2 });
    const result = summarySchema.safeParse(parsed.value);
    if (!result.success || result.data.fields.length !== requestedFields.length || new Set(result.data.fields.map(field => field.name)).size !== requestedFields.length || result.data.fields.some(field => !requestedFields.includes(field.name))) throw new PrivacyError("invalid_local_summary");
    const redactions = new Map<string, number>();
    const fields = requestedFields.map(name => {
      const field = result.data.fields.find(value => value.name === name)!;
      if (!field.text.trim() || field.text.length > policy.maxFieldCharacters || new Set(field.sourceIds).size !== field.sourceIds.length || field.sourceIds.some(id => !eligible.some(source => source.id === id))) throw new PrivacyError("invalid_summary_evidence");
      if (disclosureViolations(field.text).length || containsLocalOnlyExcerpt(field.text, sources)) throw new PrivacyError("unsafe_local_summary");
      const redacted = redactDisclosureText(field.text, policy.privateTerms);
      for (const entry of redacted.redactions) redactions.set(entry.category, (redactions.get(entry.category) ?? 0) + entry.count);
      if (disclosureViolations(redacted.text).length) throw new PrivacyError("unsafe_local_summary");
      return { name, text: redacted.text, sourceIds: field.sourceIds };
    });
    const cited = new Set(fields.flatMap(field => field.sourceIds));
    const body = {
      id: randomUUID(), taskId: input.taskId, operationId: input.operationId, version: 1 as const,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + this.ttl).toISOString(),
      policyVersion: policy.version, sourceSnapshotHash: context.sourceSnapshotHash, requestedFields, fields,
      sources: eligible.filter(source => cited.has(source.id)).map(source => ({ id: source.id, revision: source.revision, hash: textDigest(source.text) })),
      redactions: [...redactions].map(([category, count]) => ({ category, count })), repairs: parsed.repairs,
    };
    const draft: DisclosureDraft = { ...body, hash: privacyDigest(body) };
    if (Buffer.byteLength(JSON.stringify(draft)) > context.budget.maxOutputBytes) throw new PrivacyError("disclosure_output_limit");
    await this.unchanged(input.taskId, input.access, context);
    await this.bounded(input.access, deadline, input.signal, () => this.localBinding(input.local, context));
    await this.audit({ taskId: input.taskId, operationId: input.operationId, stage: "disclosure_prepared", code: "awaiting_exact_disclosure_consent", draftHash: draft.hash });
    await this.unchanged(input.taskId, input.access, context);
    this.drafts.set(draft.id, { draft: copy(draft), context, localOnlyCanaries: sources.filter(source => source.classification === "local_only"), policy });
    return copy(draft);
  }

  async approve(input: { draftId: string; expectedDraftHash: string; approvedFields: readonly string[]; recipient: CloudRuntimeBinding; access: PrivacyAccess; consent: true }): Promise<DisclosureApproval> {
    this.prune();
    const stored = this.drafts.get(input.draftId);
    if (!stored) throw new PrivacyError("disclosure_not_found_or_expired");
    if (input.consent !== true) throw new PrivacyError("explicit_disclosure_consent_required");
    await this.unchanged(stored.draft.taskId, input.access, stored.context);
    if (input.expectedDraftHash !== stored.draft.hash || privacyDigest([...input.approvedFields]) !== privacyDigest(stored.draft.requestedFields)) throw new PrivacyError("disclosure_consent_mismatch");
    let recipientFingerprint: string;
    try { recipientFingerprint = privacyRuntimeFingerprint(CloudRuntimeBindingSchema.parse(input.recipient)); } catch { throw new PrivacyError("invalid_cloud_recipient"); }
    if (recipientFingerprint !== stored.context.cloudRuntimeFingerprint) throw new PrivacyError("cloud_recipient_changed");
    if ([...this.approvals.values()].some(value => value.draftId === stored.draft.id)) throw new PrivacyError("disclosure_already_approved");
    const body = { id: randomUUID(), draftId: stored.draft.id, draftHash: stored.draft.hash, recipientFingerprint, approvedFields: [...input.approvedFields], budgetHash: privacyDigest(stored.context.budget), expiresAt: stored.draft.expiresAt };
    const approval = { ...body, hash: privacyDigest(body) };
    await this.audit({ taskId: stored.draft.taskId, operationId: stored.draft.operationId, stage: "disclosure_approved", code: "exact_disclosure_approved", draftHash: stored.draft.hash, recipientFingerprint });
    await this.unchanged(stored.draft.taskId, input.access, stored.context);
    this.approvals.set(approval.id, { approval: copy(approval), draftId: stored.draft.id, context: stored.context, revoked: false });
    return copy(approval);
  }

  async dispatch(input: { approvalId: string; expectedDraftHash: string; access: PrivacyAccess; cloud: CloudPrivacyAdapter; signal?: AbortSignal }): Promise<CloudDisclosureReply> {
    this.prune();
    const approved = this.approvals.get(input.approvalId), stored = approved && this.drafts.get(approved.draftId);
    if (!approved || !stored || approved.revoked) throw new PrivacyError("disclosure_not_approved");
    const { draft, context } = stored;
    const check = async (): Promise<CloudRuntimeBinding> => {
      if (approved.revoked || !this.approvals.has(input.approvalId) || Date.parse(approved.approval.expiresAt) <= this.now()) throw new PrivacyError("disclosure_revoked_or_expired");
      await this.unchanged(draft.taskId, input.access, context);
      if (input.expectedDraftHash !== draft.hash || approved.approval.draftHash !== draft.hash || approved.approval.budgetHash !== privacyDigest(context.budget)) throw new PrivacyError("disclosure_consent_mismatch");
      const { hash: _hash, ...body } = draft;
      if (privacyDigest(body) !== draft.hash) throw new PrivacyError("disclosure_hash_mismatch");
      let binding: CloudRuntimeBinding;
      try { binding = CloudRuntimeBindingSchema.parse(await this.bounded(input.access, deadline, input.signal, () => input.cloud.binding())); } catch (error) { if (error instanceof PrivacyError) throw error; throw new PrivacyError("cloud_runtime_unavailable"); }
      if (privacyRuntimeFingerprint(binding) !== approved.approval.recipientFingerprint || approved.approval.recipientFingerprint !== context.cloudRuntimeFingerprint) throw new PrivacyError("cloud_recipient_changed");
      for (const field of draft.fields) {
        if (!approved.approval.approvedFields.includes(field.name) || disclosureViolations(field.text).length || containsLocalOnlyExcerpt(field.text, stored.localOnlyCanaries) || redactDisclosureText(field.text, stored.policy.privateTerms).text !== field.text) throw new PrivacyError("unsafe_disclosure_egress");
      }
      return binding;
    };
    const deadline = Math.min(Date.parse(approved.approval.expiresAt), this.now() + context.budget.maxActiveMs);
    const binding = await check();
    if (input.signal?.aborted) throw new PrivacyError("privacy_cancelled");
    await this.reserveDispatch({ taskId: draft.taskId, operationId: draft.operationId, draftHash: draft.hash, approvalHash: approved.approval.hash, recipientFingerprint: approved.approval.recipientFingerprint, budget: context.budget });
    // Claim is intentionally not released after cancellation, timeout, or an
    // unknown response. A retry must be a new task/operation and new consent.
    await this.audit({ taskId: draft.taskId, operationId: draft.operationId, stage: "cloud_dispatch", code: "cloud_dispatch_claimed", draftHash: draft.hash, recipientFingerprint: approved.approval.recipientFingerprint });
    await check();
    const envelope: CloudDisclosureEnvelope = { protocol: "betterme.disclosure.v1", taskId: draft.taskId, operationId: draft.operationId, model: binding.model, summary: Object.fromEntries(draft.fields.map(field => [field.name, field.text])), sources: copy(draft.sources) };
    if (Buffer.byteLength(JSON.stringify(envelope)) > context.budget.maxInputBytes) throw new PrivacyError("cloud_input_limit");
    const raw = await this.bounded(input.access, deadline, input.signal, signal => input.cloud.dispatch(copy(envelope), signal));
    await check(); // No result adoption after revocation, session switch or drift.
    let parsed: CloudDisclosureReply;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > context.budget.maxOutputBytes) throw new Error();
      parsed = replySchema.parse(raw);
    } catch { throw new PrivacyError("invalid_cloud_result"); }
    if (parsed.sourceIds.some(id => !draft.sources.some(source => source.id === id)) || disclosureViolations(parsed.text).length || containsLocalOnlyExcerpt(JSON.stringify(parsed), stored.localOnlyCanaries)) throw new PrivacyError("unsafe_cloud_result");
    for (const text of [parsed.text, ...parsed.unknowns]) if (redactDisclosureText(text, stored.policy.privateTerms).text !== text || disclosureViolations(text).length) throw new PrivacyError("unsafe_cloud_result");
    await this.audit({ taskId: draft.taskId, operationId: draft.operationId, stage: "cloud_result", code: "cloud_result_ready_not_adopted", draftHash: draft.hash, recipientFingerprint: approved.approval.recipientFingerprint, bytes: Buffer.byteLength(parsed.text) });
    await check();
    return copy(parsed);
  }

  async searchLocal(input: { taskId: string; operationId: string; access: PrivacyAccess; sources: readonly PrivacySource[]; query: string; local: LocalPrivacyAdapter; topK?: number; signal?: AbortSignal }): Promise<{ sourceId: string; similarity: number }[]> {
    let sources: PrivacySource[];
    try { sources = z.array(PrivacySourceSchema).min(1).max(200).parse(input.sources); } catch { throw new PrivacyError("invalid_privacy_input"); }
    const context = await this.current(input.taskId, input.access), topK = input.topK ?? 5;
    if (!opaque.safeParse(input.operationId).success || !Number.isSafeInteger(topK) || topK < 1 || topK > 50 || typeof input.query !== "string" || !input.query.trim() || privacySourceSnapshotHash(sources) !== context.sourceSnapshotHash) throw new PrivacyError("invalid_local_search");
    if (!input.local.embed) throw new PrivacyError("local_embedding_unavailable");
    const texts = [input.query, ...sources.map(source => source.text)];
    if (texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > context.budget.maxInputBytes) throw new PrivacyError("local_input_limit");
    const deadline = this.now() + context.budget.maxActiveMs;
    await this.bounded(input.access, deadline, input.signal, () => this.localBinding(input.local, context));
    await this.reserveLocal({ taskId: input.taskId, operationId: input.operationId, stage: "local_embedding", budget: context.budget });
    await this.unchanged(input.taskId, input.access, context);
    const embed = input.local.embed.bind(input.local);
    const vectors = await this.bounded(input.access, deadline, input.signal, signal => embed(copy(texts), signal));
    await this.unchanged(input.taskId, input.access, context);
    await this.bounded(input.access, deadline, input.signal, () => this.localBinding(input.local, context));
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || dimensions > 8192 || vectors.length !== texts.length || vectors.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)) || !Number.isFinite(Math.hypot(...vector)) || Math.hypot(...vector) === 0)) throw new PrivacyError("invalid_local_embeddings");
    const query = vectors[0]!, norm = Math.hypot(...query);
    const ranked = sources.map((source, index) => { const vector = vectors[index + 1]!; return { sourceId: source.id, similarity: Math.max(-1, Math.min(1, query.reduce((sum, value, i) => sum + value * vector[i]!, 0) / (norm * Math.hypot(...vector)))) }; }).sort((a, b) => b.similarity - a.similarity).slice(0, topK);
    await this.audit({ taskId: input.taskId, operationId: input.operationId, stage: "local_embedding", code: "local_search_complete", sourceSnapshotHash: context.sourceSnapshotHash });
    await this.unchanged(input.taskId, input.access, context);
    return ranked;
  }

  async revokeApproval(approvalId: string, access: PrivacyAccess): Promise<void> {
    const stored = this.approvals.get(approvalId), draft = stored && this.drafts.get(stored.draftId);
    if (!stored || !draft) throw new PrivacyError("disclosure_not_found_or_expired");
    const current = await this.current(draft.draft.taskId, access);
    if (current.ownerId !== stored.context.ownerId) throw new PrivacyError("authorization_changed");
    stored.revoked = true;
    this.invalidateSession(stored.context.sessionId);
    await this.audit({ taskId: draft.draft.taskId, operationId: draft.draft.operationId, stage: "revoked", code: "disclosure_consent_revoked", draftHash: draft.draft.hash });
  }

  /** Host must invoke on owner/session logout or authorization generation bump. */
  invalidateSession(sessionId: string): void {
    for (const stored of this.approvals.values()) if (stored.context.sessionId === sessionId) stored.revoked = true;
    for (const call of this.active) if (call.sessionId === sessionId) call.controller.abort();
  }
  close(): void {
    this.closed = true;
    for (const call of this.active) call.controller.abort();
    this.approvals.clear(); this.drafts.clear();
  }
}
