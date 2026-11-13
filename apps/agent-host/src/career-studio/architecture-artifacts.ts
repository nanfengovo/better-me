import { z } from "zod";
import type { UnderstandingGrant } from "@better-me/agent-contracts";
import type { CommitteeSnapshot } from "@better-me/core/career-intelligence";
import type { EvidenceBroker } from "../understanding/evidence-broker.js";
import { StudioIdSchema, type StudioAccess, type StudioContext, type StudioOperation } from "./contracts.js";
import { StudioArtifactStore, StudioError, studioHash, type StudioRecord } from "./storage.js";
import type { CommitteeReview } from "../kernel/studio-committee.js";

// A deliberately narrow, dependency-free wire schema. The UI additionally
// validates simulation semantics. Nothing in a drawing grants filesystem access.
const id = z.string().min(1).max(160);
const ids = z.array(id).max(200);
const binding = z.object({ ownerId: z.string().min(1).max(240), sessionGeneration: z.number().int().nonnegative(),
  projectId: id, revision: z.string().min(1).max(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const evidence = z.object({ id, label: z.string().max(240), excerpt: z.string().max(12_000), path: z.string().max(1000).optional(),
  startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict();
const state = z.enum(["failed", "at-risk", "contained", "unknown", "unaffected"]);
const question = z.object({ id, text: z.string().min(1).max(6000), evidenceIds: ids, unknowns: z.array(z.string().max(2000)).max(30) }).strict();
const review = z.object({ support: z.enum(["supported", "partial", "contradicted", "unknown"]), summary: z.string().max(6000),
  strengths: z.array(z.string().max(2000)).max(30), gaps: z.array(z.string().max(2000)).max(30), followUps: z.array(z.string().max(2000)).max(30), evidenceIds: ids }).strict();
const documentSchema = z.object({ schemaVersion: z.literal(1), id, binding, title: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(), graphRevision: z.number().int().nonnegative(),
  nodes: z.array(z.object({ id, label: z.string().trim().min(1).max(80), kind: z.enum(["client", "service", "store", "queue", "external"]),
    x: z.number().finite().min(0).max(1020), y: z.number().finite().min(0).max(676), notes: z.string().max(4000), evidenceIds: ids,
    guards: z.object({ diskFull: z.enum(["yes", "no", "unknown"]), sessionEpoch: z.enum(["yes", "no", "unknown"]), idempotency: z.enum(["yes", "no", "unknown"]) }).strict() }).strict()).max(80),
  edges: z.array(z.object({ id, from: id, to: id, label: z.string().max(160), kind: z.enum(["request", "read", "write", "event"]),
    failurePolicy: z.enum(["propagate", "isolate", "unknown"]), sessionPolicy: z.enum(["validate", "forward", "unknown"]), evidenceIds: ids }).strict()).max(160),
  annotations: z.array(z.object({ id, x: z.number().finite().min(0).max(980), y: z.number().finite().min(0).max(704), text: z.string().max(2000) }).strict()).max(80),
  evidence: z.array(evidence).max(200),
  faults: z.array(z.object({ id, simulated: z.literal(true), binding, graphFingerprint: z.string().min(1).max(1_000_000), graphRevision: z.number().int().nonnegative(),
    fault: z.object({ kind: z.enum(["disk-full", "session-switch", "network-timeout", "duplicate-event"]), targetNodeId: id }).strict(),
    outcomes: z.array(z.object({ nodeId: id, state, detail: z.string().max(4000), evidenceIds: ids }).strict()).max(80),
    propagation: z.array(z.object({ edgeId: id, from: id, to: id, state }).strict()).max(10_000), steps: z.number().int().min(0).max(10_000),
    truncated: z.boolean(), assumptions: z.array(z.string().max(2000)).max(20) }).strict()).max(80),
  turns: z.array(z.object({ id, graphRevision: z.number().int().nonnegative(), graphFingerprint: z.string().min(1).max(1_000_000), faultRunId: id.optional(),
    question, answer: z.string().max(12_000).optional(), draftAnswer: z.string().max(12_000).optional(), review: review.optional(), createdAt: z.string().datetime() }).strict()).max(80),
}).strict().superRefine((value, issue) => {
  const fail = (message: string) => issue.addIssue({ code: "custom", message });
  for (const key of ["nodes", "edges", "annotations", "evidence", "faults", "turns"] as const) {
    if (new Set(value[key].map(item => item.id)).size !== value[key].length) fail(`Duplicate ${key} ID.`);
  }
  const allowed = new Set(value.evidence.map(item => item.id)), nodes = new Set(value.nodes.map(item => item.id));
  const checkIds = (references: string[]) => { if (references.some(reference => !allowed.has(reference))) fail("Evidence reference is outside the selected inventory."); };
  for (const item of value.evidence) if (item.endLine !== undefined && item.endLine < (item.startLine ?? 1)) fail("Invalid evidence line range.");
  for (const node of value.nodes) checkIds(node.evidenceIds);
  for (const edge of value.edges) { if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail("Unknown edge endpoint."); checkIds(edge.evidenceIds); }
  for (const fault of value.faults) {
    if (studioHash(fault.binding) !== studioHash(value.binding) || fault.graphRevision > value.graphRevision) fail("Fault binding/version mismatch.");
    for (const outcome of fault.outcomes) checkIds(outcome.evidenceIds);
  }
  for (const turn of value.turns) {
    if (turn.graphRevision > value.graphRevision || turn.faultRunId && !value.faults.some(fault => fault.id === turn.faultRunId)) fail("Interview version mismatch.");
    checkIds(turn.question.evidenceIds); if (turn.review) { checkIds(turn.review.evidenceIds); if (!turn.review.evidenceIds.length && turn.review.support !== "unknown") fail("A review without evidence must remain unknown."); }
  }
});
export type ArchitectureDocument = z.infer<typeof documentSchema>;
const validatedDocument = (raw: unknown): ArchitectureDocument => { documentSchema.parse(raw); return structuredClone(raw) as ArchitectureDocument; };
export type StudioArchitectureEvidence = z.infer<typeof evidence>;
type SourceRead = { grant: UnderstandingGrant; request: { operation: "read"; path: string; startLine: number; endLine: number }; hash: string };
type EvidenceAuthority = { contextId: string; sourceFingerprint: string; operationId: string; evidence: StudioArchitectureEvidence[]; receiptId: string };
type ArtifactValue = { schemaVersion: 1; ownerId: string; workspaceKey: string; resumeId: string; sourceFingerprint: string; contextId: string; value: ArchitectureDocument };
type Dependencies = { store: StudioArtifactStore; broker: EvidenceBroker; getContext(id: string, access: StudioAccess): Promise<StudioContext>;
  reviewCommittee?(contextId: string, operationId: string, access: StudioAccess): Promise<CommitteeReview> };

export const studioArchitectureKey = (context: Pick<StudioContext, "ownerId" | "workspaceKey" | "resumeId" | "sourceFingerprint">) => studioHash([context.ownerId, context.workspaceKey, context.resumeId, context.sourceFingerprint]);
const sameEvidence = (left: StudioArchitectureEvidence, right: StudioArchitectureEvidence) => left.id === right.id && left.label === right.label && left.excerpt === right.excerpt
  && left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;
const selfEvidence = (context: StudioContext): StudioArchitectureEvidence[] => context.claims.map(claim => ({ id: claim.id, label: "本人选择的原句（自述，非独立源码证据）", excerpt: claim.text }));
const selectedInventory = (context: StudioContext, code: StudioArchitectureEvidence[]) => {
  const selected = z.array(evidence).max(200).parse([...selfEvidence(context), ...code]);
  if (new Set(selected.map(item => item.id)).size !== selected.length) throw new StudioError("studio_architecture_duplicate_evidence", 400);
  return selected;
};
const assertMetadata = (value: ArtifactValue, context: StudioContext) => {
  if (value.schemaVersion !== 1 || value.ownerId !== context.ownerId || value.workspaceKey !== context.workspaceKey || value.resumeId !== context.resumeId
    || value.sourceFingerprint !== context.sourceFingerprint) throw new StudioError("studio_architecture_scope_mismatch", 403);
};
const assertDocumentScope = (document: ArchitectureDocument, context: StudioContext) => {
  if (document.binding.ownerId !== context.ownerId || document.binding.projectId !== context.resumeId || document.binding.contentHash !== context.sourceFingerprint
    || document.binding.revision !== context.sourceFingerprint) throw new StudioError("studio_architecture_binding_mismatch", 403);
};

/** Read the exact already-saved graph in this interaction, not its historical
 * draft and not a renewed source authorization. Publication may select labels
 * from this value; private evidence remains only a local disclosure guard. */
export function readCurrentStudioArchitecture(store: StudioArtifactStore, context: StudioContext) {
  const record = store.get<ArtifactValue>("architecture", studioArchitectureKey(context));
  if (!record) return;
  assertMetadata(record.value, context);
  if (record.value.contextId !== context.id) return;
  const document = validatedDocument(record.value.value); assertDocumentScope(document, context);
  return { record, document };
}

/** Rereads ONLY the completed committee's persisted exact readset. Never creates
 * a new Broker grant, lists directories, accepts replacement paths or expands a
 * line range. Import consent authorizes reuse in the private whiteboard only. */
async function readCommitteeEvidence(deps: Dependencies, context: StudioContext, operationId: string, access: StudioAccess): Promise<StudioArchitectureEvidence[]> {
  if (operationId.startsWith("ct_")) {
    if (!deps.reviewCommittee) throw new StudioError("studio_committee_task_reader_required", 503);
    const current = await deps.reviewCommittee(context.id, operationId, access), result: StudioArchitectureEvidence[] = [];
    for (const { source, evidence: item } of current.reads) {
      const original = current.snapshot.evidence.find(entry => entry.provenance === "source" && entry.label === source.request.path
        && entry.sourceHash === source.hash && entry.startLine === item.startLine && entry.endLine === item.endLine);
      if (!original || original.excerpt !== item.excerpt || !current.snapshot.authorization.evidenceIds.includes(original.id)) throw new StudioError("studio_source_changed_new_review_required");
      const code = evidence.parse({ id: `code-${studioHash([source.grant.path, source.request, source.hash]).slice(0, 48)}`,
        label: `代码节选（内容核对，非作者或生产证明） · ${source.request.path}`, excerpt: item.excerpt,
        path: source.request.path, startLine: item.startLine, endLine: item.endLine });
      if (!result.some(previous => previous.id === code.id)) result.push(code);
    }
    await deps.getContext(context.id, access); return result;
  }
  const operation = deps.store.get<StudioOperation>("operation", operationId)?.value;
  const snapshot = deps.store.get<CommitteeSnapshot>("committee-snapshot", operationId)?.value;
  const readset = deps.store.get<{ contextId: string; sources: SourceRead[] }>("committee-readset", operationId)?.value;
  if (!operation || operation.contextId !== context.id || operation.kind !== "committee" || operation.status !== "completed"
    || (operation.output as { status?: string } | undefined)?.status !== "completed"
    || !snapshot || snapshot.binding.ownerId !== context.ownerId || snapshot.binding.workspaceId !== context.workspaceKey || snapshot.binding.resumeId !== context.resumeId
    || snapshot.binding.resumeRevision !== context.sourceFingerprint || snapshot.authorization.grantId !== operationId || snapshot.authorization.purpose !== "resume_stress_test"
    || !Number.isFinite(Date.parse(snapshot.authorization.expiresAt)) || Date.parse(snapshot.authorization.expiresAt) <= Date.now()
    || !readset || readset.contextId !== context.id || readset.sources.length > 32) {
    throw new StudioError("studio_architecture_completed_readset_required", 403);
  }
  const result: StudioArchitectureEvidence[] = [];
  for (const source of readset.sources) {
    await deps.getContext(context.id, access);
    const reread = await deps.broker.execute(source.grant, source.request, AbortSignal.timeout(3000));
    const item = reread.evidence[0];
    const original = snapshot.evidence.find(entry => entry.provenance === "source" && entry.label === source.request.path && entry.sourceHash === source.hash
      && entry.startLine === source.request.startLine && entry.endLine === source.request.endLine);
    if (reread.truncated || reread.evidence.length !== 1 || !item || item.hash !== source.hash || !original || item.excerpt !== original.excerpt
      || item.startLine !== original.startLine || item.endLine !== original.endLine || !snapshot.authorization.evidenceIds.includes(original.id)) {
      throw new StudioError("studio_source_changed_new_review_required");
    }
    const code = evidence.parse({ id: `code-${studioHash([source.grant.path, source.request, source.hash]).slice(0, 48)}`,
      label: `代码节选（内容核对，非作者或生产证明） · ${source.request.path}`, excerpt: item.excerpt,
      path: source.request.path, startLine: item.startLine, endLine: item.endLine });
    if (!result.some(previous => previous.id === code.id)) result.push(code);
  }
  await deps.getContext(context.id, access);
  return result;
}

async function inventory(deps: Dependencies, context: StudioContext, access: StudioAccess): Promise<StudioArchitectureEvidence[]> {
  const authority = deps.store.get<EvidenceAuthority>("architecture-evidence", context.id)?.value;
  if (!authority) return selectedInventory(context, []);
  if (authority.contextId !== context.id || authority.sourceFingerprint !== context.sourceFingerprint) throw new StudioError("studio_architecture_evidence_scope_mismatch", 403);
  const fresh = await readCommitteeEvidence(deps, context, authority.operationId, access);
  if (studioHash(fresh) !== studioHash(authority.evidence)) throw new StudioError("studio_architecture_evidence_changed");
  return selectedInventory(context, fresh);
}

export async function importStudioArchitectureEvidence(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = z.object({ contextId: StudioIdSchema, operationId: StudioIdSchema, consent: z.literal(true) }).strict().parse(raw);
  const context = await deps.getContext(input.contextId, access);
  const selected = await readCommitteeEvidence(deps, context, input.operationId, access);
  const currentInventory = selectedInventory(context, selected);
  const receiptId = studioHash([context.id, input.operationId, selected]);
  await deps.getContext(context.id, access);
  const previous = deps.store.get<EvidenceAuthority>("architecture-evidence", context.id);
  const value: EvidenceAuthority = { contextId: context.id, sourceFingerprint: context.sourceFingerprint, operationId: input.operationId, evidence: selected, receiptId };
  if (!previous || studioHash(previous.value) !== studioHash(value)) deps.store.put("architecture-evidence", context.id, previous?.revision ?? 0, value);
  return { contextId: context.id, ownerId: context.ownerId, workspaceKey: context.workspaceKey, resumeId: context.resumeId, sourceFingerprint: context.sourceFingerprint,
    receiptId, evidence: currentInventory, limitations: ["只重读本次已完成抗压测试明确授权的相同行段，未扫描新文件。", "代码内容及哈希核对不证明个人作者身份、生产部署或防护行为；自述仍是自述。"] };
}

const loadInput = z.object({ contextId: StudioIdSchema, kind: z.literal("architecture"), id: StudioIdSchema }).strict();
function logicalRecord(record: StudioRecord<ArtifactValue>, context: StudioContext, value: ArchitectureDocument, mode: "current" | "graph-draft") {
  const responseValue = { ...record.value, contextId: context.id, ...(mode === "graph-draft" ? { historicalContextId: record.value.contextId } : {}), mode, value };
  return { id: context.resumeId, revision: record.revision, updatedAt: record.updatedAt, hash: studioHash(responseValue), value: responseValue };
}

export async function loadStudioArchitectureArtifact(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = loadInput.parse(raw), context = await deps.getContext(input.contextId, access);
  if (input.id !== context.resumeId) throw new StudioError("studio_architecture_project_mismatch", 403);
  const record = deps.store.get<ArtifactValue>("architecture", studioArchitectureKey(context));
  if (!record) return { record: null };
  assertMetadata(record.value, context);
  const document = validatedDocument(record.value.value); assertDocumentScope(document, context);
  const authorityRevision = deps.store.kindRevision("architecture-evidence");
  const fresh = await inventory(deps, context, access);
  const retained = new Set(document.evidence.filter(old => fresh.some(current => sameEvidence(old, current))).map(item => item.id));
  const exactInventory = document.evidence.length === fresh.length && document.evidence.every(old => fresh.some(current => sameEvidence(old, current)));
  const mode = record.value.contextId === context.id && exactInventory ? "current" : "graph-draft";
  const safe = mode === "current" ? document : validatedDocument({ ...document, evidence: fresh,
    nodes: document.nodes.map(node => ({ ...node, evidenceIds: node.evidenceIds.filter(id => retained.has(id)) })),
    edges: document.edges.map(edge => ({ ...edge, evidenceIds: edge.evidenceIds.filter(id => retained.has(id)) })), faults: [], turns: [] });
  await deps.getContext(context.id, access);
  if (deps.store.kindRevision("architecture-evidence") !== authorityRevision) throw new StudioError("studio_architecture_evidence_changed");
  return { record: logicalRecord(record, context, safe, mode) };
}

export async function saveStudioArchitectureArtifact(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = loadInput.extend({ expectedRevision: z.number().int().nonnegative(), value: z.unknown() }).strict().parse(raw);
  const context = await deps.getContext(input.contextId, access);
  if (input.id !== context.resumeId) throw new StudioError("studio_architecture_project_mismatch", 403);
  if (Buffer.byteLength(JSON.stringify(input.value) ?? "") > 256_000) throw new StudioError("studio_artifact_too_large", 413);
  const document = validatedDocument(input.value); assertDocumentScope(document, context);
  const authorityRevision = deps.store.kindRevision("architecture-evidence");
  const fresh = await inventory(deps, context, access);
  if (document.evidence.some(item => !fresh.some(allowed => sameEvidence(item, allowed)))) throw new StudioError("studio_architecture_evidence_not_authorized", 403);
  const key = studioArchitectureKey(context), previous = deps.store.get<ArtifactValue>("architecture", key);
  if ((previous?.revision ?? 0) !== input.expectedRevision) throw new StudioError("studio_revision_conflict");
  if (previous) assertMetadata(previous.value, context);
  await deps.getContext(context.id, access);
  if (deps.store.kindRevision("architecture-evidence") !== authorityRevision) throw new StudioError("studio_architecture_evidence_changed");
  const contextRevision = deps.store.kindRevision("context");
  // No await between the final authorization check, immutable old-version copy
  // and CAS. Failure to retain history prevents overwrite. A losing CAS may
  // leave only an identical history copy; it never destroys the old record.
  if (previous) {
    const historyId = studioHash([key, previous.revision, previous.hash]);
    const historical = deps.store.get<{ record: StudioRecord<ArtifactValue> }>("architecture-history", historyId);
    if (historical && studioHash(historical.value.record) !== studioHash(previous)) throw new StudioError("studio_architecture_history_mismatch", 503);
    if (!historical) deps.store.put("architecture-history", historyId, 0, { record: previous });
  }
  const saved = deps.store.put<ArtifactValue>("architecture", key, input.expectedRevision, { schemaVersion: 1, ownerId: context.ownerId,
    workspaceKey: context.workspaceKey, resumeId: context.resumeId, sourceFingerprint: context.sourceFingerprint, contextId: context.id, value: document },
  [{ kind: "architecture-evidence", revision: authorityRevision }, { kind: "context", revision: contextRevision }]);
  return { record: logicalRecord(saved, context, document, "current") };
}
