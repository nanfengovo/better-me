import { z } from "zod";
import { CommitteeSnapshotSchema, hashCommitteeText, type CommitteeReport } from "@better-me/core/career-intelligence";
import type { UnderstandingGrant } from "@better-me/agent-contracts";
import type { EvidenceBroker } from "../understanding/evidence-broker.js";
import type { PrivacySource } from "../privacy/types.js";
import { containsGitEvidenceSecret } from "../evidence-harvester/git-source.js";
import { StudioLocalRuntimeSchema, type StudioAccess, type StudioContext, type StudioOperation } from "./contracts.js";
import { StudioError, studioHash, type StudioArtifactStore } from "./storage.js";
import type { CommitteeTasks } from "./committee-tasks.js";
import type { CommitteeReview } from "../kernel/studio-committee.js";
import { CareerTaskError } from "../tasks/evidence.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const PrivacySourceSelectionSchema = z.object({ operationId: id, evidenceId: id }).strict();
export const PrivacySourceConfigureSchema = z.object({ contextId: id, expectedRevision: z.number().int().nonnegative(),
  selections: z.array(PrivacySourceSelectionSchema).max(8), privateTerms: z.array(z.string().trim().min(2).max(200)).max(50),
  embeddingRuntime: StudioLocalRuntimeSchema.optional(), embeddingConsent: z.literal(true).optional(),
  maxSearchCalls: z.number().int().min(1).max(8).default(4), consent: z.literal(true),
}).strict().refine(value => !value.embeddingRuntime || value.embeddingConsent === true, "Embedding requires separate explicit consent.");
export type PrivacySourceSelection = z.infer<typeof PrivacySourceSelectionSchema>;
export type StudioPrivacySourcePolicy = { schemaVersion: 1; ownerId: string; contextId: string; session: string; sourceFingerprint: string;
  selections: PrivacySourceSelection[]; privateTerms: string[]; embeddingRuntime?: z.infer<typeof StudioLocalRuntimeSchema>; maxSearchCalls: number;
  consent: { sourceReuse: true; embedding: boolean; at: string } };
export const PRIVACY_SOURCE_POLICY_KIND = "privacy-source-policy";
type OriginalRead = { grant: UnderstandingGrant; request: { operation: "read"; path: string; startLine: number; endLine: number }; hash: string };
export type PrivacySourceCatalogItem = PrivacySourceSelection & { sourceId: string; path: string; startLine: number; endLine: number; sourceHash: string; excerptHash: string; classification: "local_only" };
type Dependencies = { store: StudioArtifactStore; ownerId: string; broker?: Pick<EvidenceBroker, "execute">; committeeTasks?: CommitteeTasks;
  getContext(contextId: string, access: StudioAccess): Promise<StudioContext> };
const sourceId = (selection: PrivacySourceSelection) => `local-${studioHash(selection).slice(0, 48)}`;

/** No new grant, path, line range or classification is accepted from HTTP.
 * Choices refer only to a completed committee's original immutable selection.
 * Kernel tasks own current authority and charge source reuse to the original root;
 * legacy readsets remain readable, never copied into task authority.
 * Source bodies are returned only to local consumers, never the catalog/API.
 */
export function createStudioPrivacySources(options: Dependencies) {
  if (options.store.ownerId !== options.ownerId) throw new StudioError("privacy_source_owner_mismatch", 403);
  async function current(contextId: string, access: StudioAccess, signal?: AbortSignal) {
    signal?.throwIfAborted(); const context = await options.getContext(contextId, access);
    if (context.ownerId !== options.ownerId || context.session !== access.session) throw new StudioError("privacy_source_authority_changed", 403);
    signal?.throwIfAborted(); return context;
  }
  function original(context: StudioContext, choice: PrivacySourceSelection) {
    const operation = options.store.get<StudioOperation>("operation", choice.operationId)?.value;
    const snapshot = CommitteeSnapshotSchema.safeParse(options.store.get("committee-snapshot", choice.operationId)?.value);
    const readset = options.store.get<{ contextId: string; sources: OriginalRead[] }>("committee-readset", choice.operationId)?.value;
    const report = operation?.output as CommitteeReport | undefined;
    if (operation?.contextId !== context.id || operation.kind !== "committee" || operation.status !== "completed" || report?.status !== "completed"
      || !snapshot.success || snapshot.data.binding.ownerId !== context.ownerId || snapshot.data.binding.sessionGeneration !== context.session
      || snapshot.data.binding.workspaceId !== context.workspaceKey || snapshot.data.binding.resumeId !== context.resumeId || snapshot.data.binding.resumeRevision !== context.sourceFingerprint
      || snapshot.data.authorization.grantId !== choice.operationId
      || report.snapshotFingerprint !== snapshot.data.fingerprint || readset?.contextId !== context.id || Date.parse(snapshot.data.authorization.expiresAt) <= Date.now()) throw new StudioError("privacy_source_committee_not_current");
    const evidence = snapshot.data.evidence.find(item => item.id === choice.evidenceId && item.provenance === "source" && snapshot.data.authorization.evidenceIds.includes(item.id));
    if (!evidence) throw new StudioError("privacy_source_not_originally_authorized", 403);
    const reads = readset.sources.filter(read => read.hash === evidence.sourceHash && read.request.operation === "read" && read.request.path === evidence.label
      && read.request.startLine === evidence.startLine && read.request.endLine === evidence.endLine);
    if (reads.length !== 1 || !reads[0] || reads[0].grant.revokedAt || evidence.endLine - evidence.startLine >= 80) throw new StudioError("privacy_source_original_range_missing", 403);
    return { evidence, read: reads[0] };
  }
  async function read(context: StudioContext, choice: PrivacySourceSelection, access: StudioAccess, signal?: AbortSignal,
    reviews = new Map<string, Promise<CommitteeReview>>()): Promise<PrivacySource> {
    if (choice.operationId.startsWith("ct_")) {
      if (!options.committeeTasks) throw new StudioError("privacy_source_task_authority_unavailable", 503);
      await current(context.id, access, signal);
      let pending = reviews.get(choice.operationId);
      if (!pending) {
        pending = options.committeeTasks.review(choice.operationId, access).catch(error => {
          if (error instanceof CareerTaskError) throw new StudioError(error.code, error.status);
          throw error;
        });
        reviews.set(choice.operationId, pending);
      }
      const { task, snapshot, reads } = await pending;
      if (task.ownerId !== context.ownerId || task.request.contextId !== context.id) throw new StudioError("privacy_source_committee_not_current", 403);
      const evidence = snapshot.evidence.find(item => item.id === choice.evidenceId && item.provenance === "source" && snapshot.authorization.evidenceIds.includes(item.id));
      if (!evidence) throw new StudioError("privacy_source_not_originally_authorized", 403);
      const matches = reads.filter(({ source, evidence: item }) => source.hash === evidence.sourceHash && item.hash === evidence.sourceHash
        && source.request.path === evidence.label && item.path.replaceAll("\\", "/") === evidence.label.replaceAll("\\", "/")
        && source.request.startLine === evidence.startLine && source.request.endLine === evidence.endLine
        && item.startLine === evidence.startLine && item.endLine === evidence.endLine);
      if (matches.length !== 1 || !matches[0] || await hashCommitteeText(matches[0].evidence.excerpt) !== evidence.excerptHash) throw new StudioError("privacy_source_changed_new_committee_required");
      await current(context.id, access, signal);
      return { id: sourceId(choice), revision: evidence.sourceHash, classification: "local_only", kind: "source", text: matches[0].evidence.excerpt };
    }
    if (!options.broker) throw new StudioError("privacy_source_broker_unavailable", 503);
    const { evidence, read } = original(context, choice);
    await current(context.id, access, signal);
    const result = await options.broker.execute(read.grant, read.request, signal), item = result.evidence[0];
    if (result.truncated || result.evidence.length !== 1 || !item || item.hash !== read.hash || item.path.replaceAll("\\", "/") !== read.request.path.replaceAll("\\", "/")
      || item.startLine !== evidence.startLine || item.endLine !== evidence.endLine || await hashCommitteeText(item.excerpt) !== evidence.excerptHash) throw new StudioError("privacy_source_changed_new_committee_required");
    await current(context.id, access, signal);
    return { id: sourceId(choice), revision: evidence.sourceHash, classification: "local_only", kind: "source", text: item.excerpt };
  }
  async function catalog(contextId: string, access: StudioAccess) {
    const context = await current(contextId, access), sources: PrivacySourceCatalogItem[] = [];
    for (const task of await options.committeeTasks?.list(contextId, access) ?? []) {
      if (task.request.contextId !== context.id || task.status !== "completed") continue;
      let description: Awaited<ReturnType<CommitteeTasks["describe"]>>;
      try { description = await options.committeeTasks!.describe(task.id, access); }
      catch (error) {
        if (error instanceof CareerTaskError) {
          if (error.status === 403 || error.status === 409) continue;
          throw new StudioError(error.code, error.status);
        }
        throw error;
      }
      if (description.task.ownerId !== context.ownerId || description.task.request.contextId !== context.id) continue;
      for (const evidence of description.snapshot.evidence) {
        if (evidence.provenance !== "source" || !description.snapshot.authorization.evidenceIds.includes(evidence.id)) continue;
        const choice = { operationId: task.id, evidenceId: evidence.id };
        sources.push({ ...choice, sourceId: sourceId(choice), path: evidence.label, startLine: evidence.startLine, endLine: evidence.endLine,
          sourceHash: evidence.sourceHash, excerptHash: evidence.excerptHash, classification: "local_only" });
      }
    }
    for (const record of options.store.list<StudioOperation>("operation", 100)) {
      if (record.value.contextId !== context.id || record.value.kind !== "committee" || record.value.status !== "completed") continue;
      const snapshot = CommitteeSnapshotSchema.safeParse(options.store.get("committee-snapshot", record.id)?.value);
      if (!snapshot.success) continue;
      for (const evidence of snapshot.data.evidence.filter(item => item.provenance === "source")) {
        const choice = { operationId: record.id, evidenceId: evidence.id };
        try { original(context, choice); } catch { continue; }
        sources.push({ ...choice, sourceId: sourceId(choice), path: evidence.label, startLine: evidence.startLine, endLine: evidence.endLine,
          sourceHash: evidence.sourceHash, excerptHash: evidence.excerptHash, classification: "local_only" });
        if (sources.length >= 80) break;
      }
      if (sources.length >= 80) break;
    }
    const saved = options.store.get<StudioPrivacySourcePolicy>(PRIVACY_SOURCE_POLICY_KIND, context.id);
    const valid = saved?.value.session === context.session && saved.value.sourceFingerprint === context.sourceFingerprint;
    await current(context.id, access);
    return { contextId, revision: valid ? saved!.revision : 0, sources, selected: valid ? saved!.value.selections : [], privateTermCount: valid ? saved!.value.privateTerms.length : 0,
      ...(valid && saved!.value.embeddingRuntime ? { embeddingRuntime: saved!.value.embeddingRuntime } : {}), maxSearchCalls: valid ? saved!.value.maxSearchCalls : 4,
      brokerAvailable: !!options.broker || !!options.committeeTasks, limitations: ["目录仅为已完成委员会的原授权范围，不证明文件仍未变化；选择及每次使用由原任务重新读取计量，不代表作者或业绩认证。", "源码始终仅本地，不会进入摘要生成或云端正文；私有名称必须显式填写，不自动推断。", "Embedding 必须另外选择已安装的本地模型；不会下载、兜底或将生成 token 冒充向量。"] };
  }
  async function configure(raw: unknown, access: StudioAccess, signal?: AbortSignal) {
    const input = PrivacySourceConfigureSchema.parse(raw), context = await current(input.contextId, access, signal);
    if (input.privateTerms.some(term => containsGitEvidenceSecret(term))) throw new StudioError("privacy_source_sensitive_rule_rejected", 400);
    if (context.claims.length + input.selections.length > 200) throw new StudioError("privacy_source_combined_count_budget", 413);
    if (new Set(input.selections.map(item => studioHash(item))).size !== input.selections.length) throw new StudioError("privacy_source_duplicate_selection", 400);
    const previous = options.store.get<StudioPrivacySourcePolicy>(PRIVACY_SOURCE_POLICY_KIND, context.id);
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new StudioError("privacy_source_policy_revision_changed");
    const reviews = new Map<string, Promise<CommitteeReview>>();
    for (const choice of input.selections) await read(context, choice, access, signal, reviews);
    await current(context.id, access, signal);
    const policy: StudioPrivacySourcePolicy = { schemaVersion: 1, ownerId: options.ownerId, contextId: context.id, session: context.session, sourceFingerprint: context.sourceFingerprint,
      selections: input.selections, privateTerms: [...new Set(input.privateTerms)], maxSearchCalls: input.maxSearchCalls,
      consent: { sourceReuse: true, embedding: input.embeddingConsent === true, at: new Date().toISOString() },
      ...(input.embeddingRuntime ? { embeddingRuntime: input.embeddingRuntime } : {}) };
    options.store.put(PRIVACY_SOURCE_POLICY_KIND, context.id, input.expectedRevision, policy);
    return catalog(context.id, access);
  }
  async function resolve(contextId: string, access: StudioAccess, signal?: AbortSignal) {
    const context = await current(contextId, access, signal), selected = options.store.get<StudioPrivacySourcePolicy>(PRIVACY_SOURCE_POLICY_KIND, contextId);
    if (selected && (selected.value.ownerId !== context.ownerId || selected.value.session !== context.session || selected.value.sourceFingerprint !== context.sourceFingerprint)) throw new StudioError("privacy_source_policy_authority_changed", 403);
    if (selected && selected.value.consent?.sourceReuse !== true) throw new StudioError("privacy_source_policy_requires_fresh_consent", 403);
    const localSources: PrivacySource[] = [];
    const reviews = new Map<string, Promise<CommitteeReview>>();
    for (const choice of selected?.value.selections ?? []) localSources.push(await read(context, choice, access, signal, reviews));
    if (localSources.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) > 96_000) throw new StudioError("privacy_local_source_budget", 413);
    await current(contextId, access, signal);
    if (options.store.get(PRIVACY_SOURCE_POLICY_KIND, contextId)?.revision !== selected?.revision) throw new StudioError("privacy_source_policy_revision_changed");
    return { context, revision: selected?.revision ?? 0, policy: selected?.value, policyHash: studioHash(selected?.value ?? { contextId }), localSources };
  }
  return { catalog, configure, resolve };
}
export type StudioPrivacySources = ReturnType<typeof createStudioPrivacySources>;
