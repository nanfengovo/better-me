import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { TwinDiagram } from "../candidate-twin/types.js";
import { disclosureViolations, redactDisclosureText } from "../privacy/content-guard.js";
import { StudioArchitecturePublicationCatalogSchema, StudioArchitecturePublicationPreviewSchema, StudioArchitecturePublicationConfirmSchema,
  type StudioAccess, type StudioContext } from "./contracts.js";
import { readCurrentStudioArchitecture, type ArchitectureDocument } from "./architecture-artifacts.js";
import type { StudioPublicationRecord } from "./service.js";
import { StudioArtifactStore, StudioError, studioHash, type StudioRecord } from "./storage.js";

type Dependencies = { store: StudioArtifactStore; getContext(id: string, access: StudioAccess): Promise<StudioContext> };
type Selection = z.infer<typeof StudioArchitecturePublicationPreviewSchema>;
type PublicContent = { design: string; diagram: TwinDiagram; limitations: string };
type HeldPreview = { schemaVersion: 1; id: string; ownerId: string; contextId: string; session: string; sourceFingerprint: string;
  source: Selection["source"]; publicationId: string; publicationHash: string; selectionHash: string;
  fields: Selection["fields"]; nodeIds: string[]; edgeIds: string[]; publicContent: PublicContent;
  redactions: { category: string; count: number }[]; expiresAt: string };
type DiagramPublication = StudioPublicationRecord & { diagramReview: { previewId: string; previewHash: string; selectionHash: string;
  source: Selection["source"]; basePublicationId: string; basePublicationHash: string; idempotencyKey: string; scope: "explicit_saved_design_not_implementation" } };

const limitation = "这是用户明确选择的已保存白板设计，不证明代码实现、个人署名、部署、防护行为或生产效果；未公开源码、私有路径、内部证据标识、备注或面试问答。原有事实审阅的范围不因图示扩大。";
const sourceOf = (context: StudioContext, record: StudioRecord) => ({ id: context.resumeId, revision: record.revision, hash: record.hash });
function publication(deps: Dependencies, context: StudioContext, id: string, expectedHash?: string) {
  const record = deps.store.get<StudioPublicationRecord>("publication-review", id), value = record?.value;
  const claim = value && context.claims.find(item => item.id === value.claimId);
  if (!record || !value || value.contextId !== context.id || value.id !== record.id || value.fact.id !== record.id
    || expectedHash !== undefined && record.hash !== expectedHash || !claim?.confirmedByUser || claim.text !== value.fact.statement
    || claim.contribution !== value.review.kind || value.fact.status !== "verified" || value.fact.disclosure !== "publishable"
    || value.fact.verificationReceiptHash !== value.receiptHash) throw new StudioError("studio_architecture_publication_ineligible");
  return record;
}
function exactSource(deps: Dependencies, context: StudioContext, selected: Selection["source"]) {
  const saved = readCurrentStudioArchitecture(deps.store, context);
  if (!saved || selected.id !== context.resumeId || selected.revision !== saved.record.revision || selected.hash !== saved.record.hash) throw new StudioError("studio_architecture_publication_source_changed");
  return saved;
}
function writeGuards(deps: Dependencies, context: StudioContext) {
  const guards = ["context", "architecture", "publication-review"].map(kind => ({ kind, revision: deps.store.kindRevision(kind) }));
  // Capture the context kind before rereading it. A concurrent revoke before
  // this check is rejected here; one after it fails the SQLite write guard.
  const current = deps.store.get<StudioContext>("context", context.id);
  if (!current || current.hash !== studioHash(context)) throw new StudioError("studio_context_stale");
  return guards;
}
function publicSelection(document: ArchitectureDocument, input: Selection) {
  const nodes = input.nodeIds.map(id => document.nodes.find(node => node.id === id));
  const edges = input.edgeIds.map(id => document.edges.find(edge => edge.id === id));
  if (nodes.some(node => !node) || edges.some(edge => !edge || !input.nodeIds.includes(edge.from) || !input.nodeIds.includes(edge.to))) throw new StudioError("studio_architecture_publication_selection_invalid", 400);
  const counts = new Map<string, number>(), knownPrivate = document.evidence.flatMap(item => [item.id, ...(item.path ? [item.path] : [])]);
  // Even short known source lines must not be copied into a selected label.
  // This conservative local guard may reject an innocently matching label;
  // it never treats a lack of matches as proof of complete declassification.
  const sourceLines = document.evidence.filter(item => item.path || item.id.startsWith("code-")).flatMap(item => item.excerpt.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean));
  const sanitize = (text: string) => {
    const normalized = text.toLowerCase().replace(/\s+/g, " ");
    if (disclosureViolations(text).length || sourceLines.some(line => normalized.includes(line)) || knownPrivate.some(value => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_:-])${escaped}($|[^\\p{L}\\p{N}_:-])`, "iu").test(text);
    })) throw new StudioError("studio_architecture_publication_private_content", 400);
    const sanitized = redactDisclosureText(text, input.privateTerms);
    for (const entry of sanitized.redactions) counts.set(entry.category, (counts.get(entry.category) ?? 0) + entry.count);
    return sanitized.text;
  };
  const aliases = new Map(input.nodeIds.map((id, index) => [id, `node-${index + 1}`]));
  const diagram: TwinDiagram = { nodes: nodes.map(node => ({ id: aliases.get(node!.id)!, label: sanitize(node!.label) })),
    edges: edges.map(edge => ({ from: aliases.get(edge!.from)!, to: aliases.get(edge!.to)!, label: input.fields.includes("edge.label") ? sanitize(edge!.label) : "" })) };
  const title = input.fields.includes("title") ? sanitize(document.title) : "";
  const publicContent: PublicContent = { design: title ? `用户自述的白板设计：${title}。仅展示明确选择的节点与连线，不是代码实现声明。` : "用户自述的白板设计。仅展示明确选择的节点与连线，不是代码实现声明。", diagram, limitations: limitation };
  return { publicContent, redactions: [...counts].map(([category, count]) => ({ category, count })) };
}

export async function studioArchitecturePublicationCatalog(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = StudioArchitecturePublicationCatalogSchema.parse(raw), context = await deps.getContext(input.contextId, access);
  const saved = readCurrentStudioArchitecture(deps.store, context);
  const publications = deps.store.list<StudioPublicationRecord>("publication-review", 1000).filter(record => {
    try { publication(deps, context, record.id); return true; } catch (error) { if (error instanceof StudioError && error.code === "studio_architecture_publication_ineligible") return false; throw error; }
  }).map(record => ({ id: record.id, hash: record.hash, statement: record.value.fact.statement }));
  await deps.getContext(context.id, access);
  if (saved && readCurrentStudioArchitecture(deps.store, context)?.record.hash !== saved.record.hash) throw new StudioError("studio_architecture_publication_source_changed");
  return { source: saved ? { ...sourceOf(context, saved.record), title: saved.document.title,
    nodes: saved.document.nodes.map(({ id, label }) => ({ id, label })), edges: saved.document.edges.map(({ id, from, to, label }) => ({ id, from, to, label })) } : null,
  publications, limitations: ["只选择当前会话已保存的白板版本；历史图须在当前会话明确恢复并保存。", "目录和预览是账号私有材料；确认不会发布胶囊、签发令牌或写入 Fact。", limitation] };
}

export async function studioArchitecturePublicationPreview(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = StudioArchitecturePublicationPreviewSchema.parse(raw), context = await deps.getContext(input.contextId, access);
  const saved = exactSource(deps, context, input.source); publication(deps, context, input.publicationId, input.expectedPublicationHash);
  const selected = publicSelection(saved.document, input);
  const value: HeldPreview = { schemaVersion: 1, id: randomUUID(), ownerId: context.ownerId, contextId: context.id, session: context.session,
    sourceFingerprint: context.sourceFingerprint, source: input.source, publicationId: input.publicationId, publicationHash: input.expectedPublicationHash,
    selectionHash: studioHash(input), fields: input.fields, nodeIds: input.nodeIds, edgeIds: input.edgeIds, ...selected, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const current = await deps.getContext(context.id, access), guards = writeGuards(deps, current);
  exactSource(deps, current, input.source); publication(deps, current, input.publicationId, input.expectedPublicationHash);
  if (Date.parse(value.expiresAt) <= Date.now()) throw new StudioError("studio_architecture_publication_preview_stale");
  const held = deps.store.put("architecture-publication-preview", value.id, 0, value, guards);
  return { previewId: value.id, previewHash: held.hash, expiresAt: value.expiresAt, source: value.source, publicContent: value.publicContent, redactions: value.redactions };
}

export async function studioArchitecturePublicationConfirm(deps: Dependencies, raw: unknown, access: StudioAccess) {
  const input = StudioArchitecturePublicationConfirmSchema.parse(raw), context = await deps.getContext(input.contextId, access);
  const held = deps.store.get<HeldPreview>("architecture-publication-preview", input.previewId), value = held?.value;
  if (!held || !value || held.hash !== input.expectedPreviewHash || value.schemaVersion !== 1 || value.ownerId !== context.ownerId || value.contextId !== context.id
    || value.session !== context.session || value.sourceFingerprint !== context.sourceFingerprint || Date.parse(value.expiresAt) <= Date.now()) throw new StudioError("studio_architecture_publication_preview_stale");
  const current = await deps.getContext(context.id, access), guards = writeGuards(deps, current);
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new StudioError("studio_architecture_publication_preview_stale");
  exactSource(deps, current, value.source);
  const base = publication(deps, current, value.publicationId, value.publicationHash), id = studioHash(["architecture-publication", context.id, input.idempotencyKey]);
  const previous = deps.store.get<DiagramPublication>("publication-review", id);
  if (previous) {
    if (previous.value.diagramReview?.previewId !== value.id || previous.value.diagramReview.previewHash !== held.hash) throw new StudioError("studio_idempotency_conflict");
    return { publication: { id: previous.id, hash: previous.hash, revision: previous.revision, fact: previous.value.fact }, adopted: false, published: false };
  }
  // The existing receipt still has its narrow excerpt/self-statement meaning.
  // A new design receipt freezes explicit disclosure, never proves execution.
  const receiptHash = studioHash({ scope: "explicit_saved_design_not_implementation", baseReceipt: base.value.receiptHash, previewHash: held.hash });
  const record: DiagramPublication = { ...base.value, id, receiptHash, createdAt: new Date().toISOString(),
    fact: { ...base.value.fact, id, revision: studioHash([base.value.fact.revision, value.publicContent]), design: value.publicContent.design,
      diagram: value.publicContent.diagram, limitations: `${base.value.fact.limitations ?? ""}${base.value.fact.limitations ? "\n" : ""}${value.publicContent.limitations}`,
      evidence: [], verificationReceiptHash: receiptHash },
    diagramReview: { previewId: value.id, previewHash: held.hash, selectionHash: value.selectionHash, source: value.source,
      basePublicationId: base.id, basePublicationHash: base.hash, idempotencyKey: input.idempotencyKey, scope: "explicit_saved_design_not_implementation" } };
  const stored = deps.store.put("publication-review", id, 0, record, guards);
  return { publication: { id: stored.id, hash: stored.hash, revision: stored.revision, fact: stored.value.fact }, adopted: false, published: false };
}
