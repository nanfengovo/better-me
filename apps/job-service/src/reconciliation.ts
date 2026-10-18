import { createHash } from "node:crypto";
import {
  defineTool, explainMergeCandidate, findMergeCandidates, projectReconciliation, ToolError,
  ListMergeCandidatesInputSchema, MergeCandidatesPageSchema, PreviewMergeReviewInputSchema, MergeReviewPreviewSchema,
  ConfirmMergeReviewInputSchema, RejectMergeReviewInputSchema, RevokeMergeReviewInputSchema,
  PreviewRevokeMergeReviewInputSchema, RevokeMergeReviewPreviewSchema,
  ListMergeDecisionsInputSchema, MergeDecisionsPageSchema, ReconciliationReceiptSchema,
  type PreviewMergeReviewInput, type PreviewRevokeMergeReviewInput, type MergeReviewPreview, type ToolHandlerContext, type MergeDecision,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

type State = Awaited<ReturnType<JobRepository["readReconciliationState"]>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const warnings = ["候选只根据已收录的公开岗位字段生成，有限扫描不代表全部重复；没有候选不代表岗位唯一。", "相同名称、标题或申请链接都不会自动归并，企业身份与是否同一招聘需求仍需本人核对。"];
function canonicalId(state: Pick<State, "aliases">, jobId: string) {
  const id = state.aliases.find(alias => alias.jobId === jobId)?.canonicalJobId;
  if (!id) throw new ToolError("invalid-input");
  return id;
}
function side(state: Pick<State, "dataset" | "aliases">, requestedJobId: string) {
  const canonicalJobId = canonicalId(state, requestedJobId);
  const job = state.dataset.jobs.find(value => value.id === canonicalJobId);
  const company = state.dataset.companies.find(value => value.id === job?.companyId);
  if (!job || !company) throw new ToolError("invalid-input");
  const listings = state.dataset.listings.filter(value => job.listingIds.includes(value.id));
  return { requestedJobId, canonicalJobId, job, company, listings,
    sources: state.dataset.sources.filter(value => listings.some(listing => listing.sourceId === value.sourceId)),
    locations: state.dataset.locations.filter(value => job.locationIds.includes(value.id)),
    compensations: state.dataset.compensations.filter(value => job.compensationIds.includes(value.id)) };
}
async function previewRevoke(repository: JobRepository, value: PreviewRevokeMergeReviewInput, context: ToolHandlerContext) {
  context.throwIfCancelled(); const input = PreviewRevokeMergeReviewInputSchema.parse(value);
  const state = await repository.readReconciliationState();
  if (input.expectedRevision !== state.dataset.revision) throw new ToolError("stale-version");
  const decision = state.decisions.find(entry => entry.id === input.decisionId);
  if (!decision || decision.kind === "revoke" || state.decisions.some(entry => entry.kind === "revoke" && entry.targetDecisionId === decision.id)) throw new ToolError("invalid-input");
  if (decision.actorScope !== context.actorScope) throw new ToolError("not-authorized");
  const referenced = decision.kind === "merge" ? [decision.targetJobId, decision.sourceJobId] : [decision.leftJobId, decision.rightJobId];
  const currentGroups = new Set(referenced.map(id => canonicalId(state, id)));
  const origins = new Set(state.aliases.filter(alias => currentGroups.has(alias.canonicalJobId)).map(alias => alias.jobId));
  const simulated: MergeDecision = { id: "reconciliation-preview-revocation", kind: "revoke", targetDecisionId: decision.id, reason: input.reason,
    actorScope: context.actorScope, at: decision.at, revision: state.dataset.revision + 1 };
  const projected = projectReconciliation(state.originDataset, [...state.decisions, simulated]);
  const afterGroups = new Set(projected.aliases.filter(alias => origins.has(alias.jobId)).map(alias => alias.canonicalJobId));
  if (currentGroups.size > 1000 || afterGroups.size > 1000) throw new ToolError("budget-exceeded");
  const before = [...currentGroups].sort().map(id => side(state, id));
  const after = [...afterGroups].sort().map(id => side(projected, id));
  context.throwIfCancelled();
  return RevokeMergeReviewPreviewSchema.parse({ snapshotRevision: state.dataset.revision, expectedRevision: state.dataset.revision, input, decision, before, after,
    counts: { beforeJobs: before.length, afterJobs: after.length }, previewFingerprint: hash({ input, decision, before, after }),
    warnings: ["展示此决议当前影响的全部岗位组；撤销合并可能拆组，仍有其他有效合并时也可能继续保持一组。", "撤销拒绝只恢复候选资格，不改变岗位内容；候选仍受当前证据及有限扫描范围约束。", "撤销后数组预演来源组合与摘要字段；实际提交后的岗位版本、索引版本及更新时间由仓库生成。", "来源条目、原文观察、地点和薪资分项均保留，撤销不会删除证据。"] });
}
async function preview(repository: JobRepository, value: PreviewMergeReviewInput, context: ToolHandlerContext): Promise<MergeReviewPreview> {
  context.throwIfCancelled();
  const input = PreviewMergeReviewInputSchema.parse(value);
  const state = await repository.readReconciliationState();
  if (input.expectedRevision !== state.dataset.revision) throw new ToolError("stale-version");
  const target = side(state, input.targetJobId), source = side(state, input.sourceJobId);
  if (target.canonicalJobId === source.canonicalJobId) throw new ToolError("invalid-input");
  const candidate = await explainMergeCandidate(state.dataset, { leftJobId: target.canonicalJobId, rightJobId: source.canonicalJobId });
  context.throwIfCancelled();
  return MergeReviewPreviewSchema.parse({ snapshotRevision: state.dataset.revision, expectedRevision: state.dataset.revision,
    input, target, source, candidate, previewFingerprint: hash({ input, target, source, candidate }),
    warnings: [...warnings, "目标岗位保留标量摘要方向；来源条目、地点、薪资分项及原文证据保留，差异不会被默认为事实一致。",
      ...(candidate.strong ? [] : ["此候选没有已存的强关联证据，仅凭弱信号不能确认同岗；人工合并必须说明核对理由。"]),
      ...(candidate.requiresCompanyConfirmation ? ["两个企业实体不同或身份尚未核实；合并前必须明确确认实际雇主为同一主体。"] : [])] });
}
function writeOptions(context: ToolHandlerContext, input: { expectedRevision: number }, command: unknown) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision: input.expectedRevision,
    requestFingerprint: hash(command), throwIfCancelled: () => {
      // Check the logical deadline as well as the timer-driven signal before the synchronous commit.
      try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); }
    } };
}
function revokedIds(decisions: readonly MergeDecision[]) { return new Set(decisions.filter(value => value.kind === "revoke").map(value => value.targetDecisionId)); }
function previewInput(input: { targetJobId: string; sourceJobId: string; expectedRevision: number; reason: string; companyIdentityConfirmed: boolean }) {
  return { targetJobId: input.targetJobId, sourceJobId: input.sourceJobId, expectedRevision: input.expectedRevision, reason: input.reason, companyIdentityConfirmed: input.companyIdentityConfirmed };
}

/** Authentication, versioning and explicit review are shared by HTTP and future Agent executors. */
export function createReconciliationTools(repository: JobRepository) {
  return [
    defineTool({ name: "jobs.list-merge-candidates", version: 1, effect: "read-index", description: "有限扫描已收录岗位的跨源同岗候选，显示信号与冲突，不自动认定企业或合并。", inputSchema: ListMergeCandidatesInputSchema, outputSchema: MergeCandidatesPageSchema,
      execute: async (input, context) => {
        context.throwIfCancelled(); const state = await repository.readReconciliationState();
        const canonicalJobId = input.jobId ? canonicalId(state, input.jobId) : undefined;
        const revoked = revokedIds(state.decisions);
        const rejected = new Set(state.decisions.filter((value): value is Extract<MergeDecision, { kind: "reject" }> => value.kind === "reject" && !revoked.has(value.id)).map(value => JSON.stringify([value.leftJobId, value.rightJobId].sort())));
        const scanned = await findMergeCandidates(state.dataset, { limit: 1000 });
        const eligible = scanned.filter(value => !rejected.has(JSON.stringify([value.leftJobId, value.rightJobId].sort())) && (!canonicalJobId || value.leftJobId === canonicalJobId || value.rightJobId === canonicalJobId));
        context.throwIfCancelled();
        return { snapshotRevision: state.dataset.revision, candidates: eligible.slice(0, input.limit), limit: input.limit,
          scannedCandidateLimit: 1000 as const, truncated: eligible.length > input.limit || scanned.length >= 1000, warnings: [...warnings, "truncated仅表示已生成候选的返回截断；内部最多枚举10000对，不能据false判断全库扫描完整。"] };
      } }),
    defineTool({ name: "jobs.preview-merge", version: 1, effect: "read-index", description: "同一索引版本内预览两岗位与摘要保留方向，绑定理由与企业确认，不写入。", inputSchema: PreviewMergeReviewInputSchema, outputSchema: MergeReviewPreviewSchema,
      execute: (input, context) => preview(repository, input, context) }),
    defineTool({ name: "jobs.merge", version: 1, effect: "local-write", description: "显式核对预览后追加可撤销合并决议，保留所有来源和证据。", inputSchema: ConfirmMergeReviewInputSchema, outputSchema: ReconciliationReceiptSchema,
      recoverInterrupted: (input, context) => repository.findReconciliationReceipt("jobs.merge", { targetJobId: input.targetJobId, sourceJobId: input.sourceJobId, reason: input.reason, companyIdentityConfirmed: input.companyIdentityConfirmed }, writeOptions(context, input, input)),
      execute: async (input, context) => {
        const options = writeOptions(context, input, input);
        const command = { targetJobId: input.targetJobId, sourceJobId: input.sourceJobId, reason: input.reason, companyIdentityConfirmed: input.companyIdentityConfirmed };
        const saved = await repository.findReconciliationReceipt("jobs.merge", command, options); if (saved) return saved;
        const expected = await preview(repository, previewInput(input), context);
        if (input.previewFingerprint !== expected.previewFingerprint) throw new ToolError("stale-version");
        context.throwIfCancelled(); return repository.mergeJobs(command, options);
      } }),
    defineTool({ name: "jobs.reject-merge", version: 1, effect: "local-write", description: "核对相同预览后记录拒绝此对候选，可从历史显式撤销；不改变岗位来源。", inputSchema: RejectMergeReviewInputSchema, outputSchema: ReconciliationReceiptSchema,
      recoverInterrupted: (input, context) => repository.findReconciliationReceipt("jobs.reject-merge", { leftJobId: input.targetJobId, rightJobId: input.sourceJobId, reason: input.reason }, writeOptions(context, input, input)),
      execute: async (input, context) => {
        const options = writeOptions(context, input, input);
        const command = { leftJobId: input.targetJobId, rightJobId: input.sourceJobId, reason: input.reason };
        const saved = await repository.findReconciliationReceipt("jobs.reject-merge", command, options); if (saved) return saved;
        const expected = await preview(repository, previewInput(input), context);
        if (input.previewFingerprint !== expected.previewFingerprint) throw new ToolError("stale-version");
        context.throwIfCancelled(); return repository.rejectMerge(command, options);
      } }),
    defineTool({ name: "jobs.list-merge-decisions", version: 1, effect: "read-index", description: "按同一快照有界读取归并、拒绝及撤销历史，标记当前有效状态。", inputSchema: ListMergeDecisionsInputSchema, outputSchema: MergeDecisionsPageSchema,
      execute: async (input, context) => {
        context.throwIfCancelled(); const state = await repository.readReconciliationState();
        const canonicalJobId = input.jobId ? canonicalId(state, input.jobId) : undefined;
        const relatedIds = new Set(canonicalJobId ? state.aliases.filter(alias => alias.canonicalJobId === canonicalJobId).map(alias => alias.jobId) : []);
        const related = new Set(state.decisions.filter(value => value.kind === "merge" ? !canonicalJobId || relatedIds.has(value.targetJobId) || relatedIds.has(value.sourceJobId) : value.kind === "reject" ? !canonicalJobId || relatedIds.has(value.leftJobId) || relatedIds.has(value.rightJobId) : false).map(value => value.id));
        const all = state.decisions.filter(value => !canonicalJobId || related.has(value.id) || value.kind === "revoke" && related.has(value.targetDecisionId)).sort((a, b) => b.revision - a.revision);
        const revoked = revokedIds(state.decisions); context.throwIfCancelled();
        return { snapshotRevision: state.dataset.revision, items: all.slice(0, input.limit).map(decision => ({ decision, status: decision.kind === "revoke" ? "revocation" as const : revoked.has(decision.id) ? "revoked" as const : "active" as const })),
          totalAvailable: all.length, limit: input.limit, truncated: all.length > input.limit, warnings: ["历史为追加决议；撤销恢复分开后的来源贡献，不会删除原始观察或JD。", "拒绝只针对当时这对岗位；来源变化或后续归并可能产生新的待核对候选。"] };
      } }),
    defineTool({ name: "jobs.revoke-merge", version: 1, effect: "local-write", description: "明确核对后撤销本人有效合并或拒绝决议，保留不可变历史与幂等回执。", inputSchema: RevokeMergeReviewInputSchema, outputSchema: ReconciliationReceiptSchema,
      recoverInterrupted: (input, context) => repository.findReconciliationReceipt("jobs.revoke-merge", { decisionId: input.decisionId, reason: input.reason }, writeOptions(context, input, input)),
      execute: async (input, context) => {
        const options = writeOptions(context, input, input);
        const command = { decisionId: input.decisionId, reason: input.reason };
        const saved = await repository.findReconciliationReceipt("jobs.revoke-merge", command, options); if (saved) return saved;
        const expected = await previewRevoke(repository, { decisionId: input.decisionId, expectedRevision: input.expectedRevision, reason: input.reason }, context);
        if (input.previewFingerprint !== expected.previewFingerprint) throw new ToolError("stale-version");
        context.throwIfCancelled(); return repository.revokeMerge(command, options);
      } }),
    defineTool({ name: "jobs.preview-revoke-merge", version: 1, effect: "read-index", description: "同版本预览撤销决议对当前岗位组的实际组合影响，不写索引。", inputSchema: PreviewRevokeMergeReviewInputSchema, outputSchema: RevokeMergeReviewPreviewSchema,
      execute: (input, context) => previewRevoke(repository, input, context) }),
  ] as const;
}
