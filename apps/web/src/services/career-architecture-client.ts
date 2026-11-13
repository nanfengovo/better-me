import { z } from "zod";
import type { StudioLocalRuntime } from "@better-me/agent-contracts/career-studio";
import { architectureDocumentFingerprint, createArchitectureDocument, rebindArchitectureGraphDraft, sameArchitectureBinding, validateArchitectureDocument,
  type ArchitectureBinding, type ArchitectureDocument, type ArchitectureEvidence, type ArchitectureEvidenceImport,
  type ArchitectureInterviewerAdapter, type ArchitectureStorageAdapter } from "../lib/architecture-lab";
import { careerStudioDigest } from "../lib/career-studio-adoption";
import type { StudioRequest } from "./career-studio-client";

const questionSchema = z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(6000), evidenceIds: z.array(z.string()).max(100), unknowns: z.array(z.string().max(2000)).max(30) }).strict();
const reviewSchema = z.object({ support: z.enum(["supported", "partial", "contradicted", "unknown"]), summary: z.string().min(1).max(6000), strengths: z.array(z.string().max(2000)).max(30), gaps: z.array(z.string().max(2000)).max(30), followUps: z.array(z.string().max(2000)).max(30), evidenceIds: z.array(z.string()).max(100) }).strict();
const strings = { type: "array", maxItems: 30, items: { type: "string", maxLength: 2000 } };
const questionContract = { type: "object", additionalProperties: false, required: ["id", "text", "evidenceIds", "unknowns"], properties: { id: { type: "string", maxLength: 160 }, text: { type: "string", maxLength: 6000 }, evidenceIds: strings, unknowns: strings } };
const reviewContract = { type: "object", additionalProperties: false, required: ["support", "summary", "strengths", "gaps", "followUps", "evidenceIds"], properties: { support: { type: "string", enum: ["supported", "partial", "contradicted", "unknown"] }, summary: { type: "string", maxLength: 6000 }, strengths: strings, gaps: strings, followUps: strings, evidenceIds: strings } };
const evidenceIdContract = (document: ArchitectureDocument) => {
  const ids = document.evidence.map(item => item.id);
  return { type: "array", maxItems: Math.min(100, ids.length), uniqueItems: true,
    items: { type: "string", ...(ids.length ? { enum: ids } : {}) },
    description: "Only copy exact authorized evidence IDs. Never use a label, path, quote or node ID. Return [] when evidence is unknown." };
};
const responseSchema = z.object({ output: z.unknown(), contextId: z.string(), inputHash: z.string(), runtime: z.object({ model: z.string(), modelDigest: z.string() }).passthrough(), adopted: z.literal(false) }).strict();
const metadataSchema = z.object({ schemaVersion: z.literal(1), contextId: z.string(), ownerId: z.string(), workspaceKey: z.string(), resumeId: z.string(),
  sourceFingerprint: z.string(), mode: z.enum(["current", "graph-draft"]), historicalContextId: z.string().optional(), value: z.unknown() }).strict();
const recordSchema = z.object({ id: z.string(), revision: z.number().int().positive().safe(), value: metadataSchema });
const evidenceSchema = z.object({ id: z.string().min(1).max(160), label: z.string().max(240), excerpt: z.string().max(12_000), path: z.string().max(1000).optional(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict();
const sameEvidence = (left: ArchitectureEvidence, right: ArchitectureEvidence) => left.id === right.id && left.label === right.label && left.excerpt === right.excerpt
  && left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;

export function createCareerArchitectureAdapters(options: { contextId: string; workspaceKey: string; runtime?: StudioLocalRuntime; request: StudioRequest;
  getCurrentBinding(): ArchitectureBinding; getCurrentEvidence(): readonly ArchitectureEvidence[]; getCurrentRuntime?(): StudioLocalRuntime | undefined }) {
  const check = (binding: ArchitectureBinding, signal: AbortSignal) => { signal.throwIfAborted(); if (!sameArchitectureBinding(binding, options.getCurrentBinding())) throw new Error("架构授权、资料或账号已变化。"); };
  const inventory = (binding: ArchitectureBinding) => {
    const fresh = options.getCurrentEvidence().map(item => ({ ...item }));
    if (validateArchitectureDocument(createArchitectureDocument(binding, fresh)).length) throw new Error("当前授权引用库存无效。");
    return fresh;
  };
  const assertMetadata = (record: z.infer<typeof recordSchema>, binding: ArchitectureBinding) => {
    const meta = record.value;
    if (record.id !== binding.projectId || meta.contextId !== options.contextId || meta.ownerId !== binding.ownerId || meta.workspaceKey !== options.workspaceKey
      || meta.resumeId !== binding.projectId || meta.sourceFingerprint !== binding.contentHash || binding.revision !== binding.contentHash) throw new Error("存储架构文档的owner、工作区、原稿或当前授权不匹配。");
  };
  const assertAuthorized = (document: ArchitectureDocument, binding: ArchitectureBinding) => {
    const allowed = inventory(binding);
    if (validateArchitectureDocument(document).length || !sameArchitectureBinding(document.binding, binding)
      || document.evidence.some(item => !allowed.some(current => sameEvidence(item, current)))) throw new Error("架构文档或引用不属于当前授权，未保存。");
  };
  const runtime = options.runtime;
  const checkRuntime = () => {
    const current = options.getCurrentRuntime ? options.getCurrentRuntime() : runtime;
    if (!runtime || !current || current.model !== runtime.model || current.modelDigest !== runtime.modelDigest) throw new Error("面试官模型已变化，晚结果未采用。");
  };
  const interview: ArchitectureInterviewerAdapter | undefined = runtime ? {
    label: `本地 ${runtime.model}（有界追问，不执行故障）`, location: "local",
    ask: async (input, signal) => {
      check(input.binding, signal); checkRuntime(); assertAuthorized(input.document, input.binding);
      const payload = { contract: { ...questionContract, properties: { ...questionContract.properties, evidenceIds: evidenceIdContract(input.document) } }, data: input }, result = responseSchema.parse(await options.request("/model", { contextId: options.contextId, idempotencyKey: input.requestId, consent: true, runtime, purpose: "architecture_question", payload }, signal));
      const hash = await careerStudioDigest(payload); check(input.binding, signal); checkRuntime();
      if (result.contextId !== options.contextId || result.inputHash !== hash || result.runtime.model !== runtime.model || result.runtime.modelDigest !== runtime.modelDigest) throw new Error("架构模型回执不匹配。");
      return { requestId: input.requestId, binding: input.binding, graphFingerprint: input.graphFingerprint, value: questionSchema.parse(result.output) };
    },
    review: async (input, signal) => {
      check(input.binding, signal); checkRuntime(); assertAuthorized(input.document, input.binding);
      const payload = { contract: { ...reviewContract, properties: { ...reviewContract.properties, evidenceIds: evidenceIdContract(input.document) } }, data: input }, result = responseSchema.parse(await options.request("/model", { contextId: options.contextId, idempotencyKey: input.requestId, consent: true, runtime, purpose: "architecture_review", payload }, signal));
      const hash = await careerStudioDigest(payload); check(input.binding, signal); checkRuntime();
      if (result.contextId !== options.contextId || result.inputHash !== hash || result.runtime.model !== runtime.model || result.runtime.modelDigest !== runtime.modelDigest) throw new Error("架构模型回执不匹配。");
      return { requestId: input.requestId, binding: input.binding, graphFingerprint: input.graphFingerprint, value: reviewSchema.parse(result.output) };
    },
  } : undefined;
  const storage: ArchitectureStorageAdapter = {
    load: async (binding, signal) => {
      check(binding, signal);
      const result = z.object({ record: recordSchema.nullable() }).strict().parse(await options.request("/artifact/load", { contextId: options.contextId, kind: "architecture", id: binding.projectId }, signal));
      check(binding, signal); if (!result.record) return null; assertMetadata(result.record, binding);
      const document = result.record.value.value as ArchitectureDocument;
      if (validateArchitectureDocument(document).length) throw new Error("存储架构文档结构或引用无效。");
      const fresh = inventory(binding);
      const exact = document.evidence.length === fresh.length && document.evidence.every(item => fresh.some(allowed => sameEvidence(item, allowed)));
      const graphOnly = result.record.value.mode === "graph-draft" || !sameArchitectureBinding(document.binding, binding) || !exact;
      const current = graphOnly ? rebindArchitectureGraphDraft(document, binding, fresh) : document;
      check(binding, signal); assertAuthorized(current, binding);
      return { document: current, storageVersion: String(result.record.revision), restoredGraphOnly: graphOnly };
    },
    save: async (input, signal) => {
      check(input.binding, signal); assertAuthorized(input.document, input.binding);
      if (architectureDocumentFingerprint(input.document) !== input.fingerprint) throw new Error("架构保存载荷不匹配。");
      const expected = input.expectedVersion === null ? 0 : Number(input.expectedVersion);
      if (!Number.isSafeInteger(expected) || expected < 0 || input.expectedVersion !== null && String(expected) !== input.expectedVersion) throw new Error("架构存储CAS版本无效。");
      const result = z.object({ record: recordSchema }).strict().parse(await options.request("/artifact/save", { contextId: options.contextId, kind: "architecture", id: input.binding.projectId, expectedRevision: expected, value: input.document }, signal));
      check(input.binding, signal); assertMetadata(result.record, input.binding);
      const saved = result.record.value.value as ArchitectureDocument;
      assertAuthorized(saved, input.binding);
      if (result.record.value.mode !== "current" || result.record.revision !== expected + 1 || architectureDocumentFingerprint(saved) !== input.fingerprint) throw new Error("架构存储回读不匹配，禁止重试写入。");
      return { status: "saved", binding: input.binding, documentId: saved.id, documentRevision: saved.revision, fingerprint: input.fingerprint, storageVersion: String(result.record.revision) };
    },
  };
  const importEvidence = async (binding: ArchitectureBinding, operationId: string, signal: AbortSignal): Promise<ArchitectureEvidenceImport> => {
    check(binding, signal);
    const result = z.object({ contextId: z.string(), ownerId: z.string(), workspaceKey: z.string(), resumeId: z.string(), sourceFingerprint: z.string(),
      receiptId: z.string().regex(/^[a-f0-9]{64}$/), evidence: z.array(evidenceSchema).max(200), limitations: z.array(z.string().max(2000)).max(20) }).strict()
      .parse(await options.request("/architecture/evidence", { contextId: options.contextId, operationId, consent: true }, signal));
    check(binding, signal);
    if (result.contextId !== options.contextId || result.ownerId !== binding.ownerId || result.workspaceKey !== options.workspaceKey || result.resumeId !== binding.projectId
      || result.sourceFingerprint !== binding.contentHash || validateArchitectureDocument(createArchitectureDocument(binding, result.evidence)).length) throw new Error("源码引用回执不属于当前授权。");
    return { receiptId: result.receiptId, evidence: result.evidence, limitations: result.limitations };
  };
  return { interview, storage, importEvidence };
}
