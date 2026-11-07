import { z } from "zod";
import {
  AtlasDatasetSchema, CompanySchema, CountryCodeSchema, DomainSchema, EntityIdSchema, HttpUrlSchema, JdSnapshotSchema,
  RevisionSchema, SourceObservationSchema, TimestampSchema,
  type AtlasDataset, type Company, type EvidenceRef, type SourceListing,
} from "./schema.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Use plain review text.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_COMPANY_CONTROL_DOCUMENT_BYTES = 262_144;
export const MAX_COMPANY_CONTROL_TOTAL_BYTES = 1_048_576;
export const CompanyControlReviewDocumentSchema = z.object({
  sourceUrl: HttpUrlSchema.refine(value => DomainSchema.safeParse(new URL(value).hostname).success, "Use a source URL with a hostname supported by the source registry."), retrievedAt: TimestampSchema,
  rawText: z.string().min(1).max(MAX_COMPANY_CONTROL_DOCUMENT_BYTES).refine(value => value.trim().length > 0 && !value.includes(String.fromCharCode(0)) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "Retain nonempty valid Unicode source text."),
}).strict();
export type CompanyControlReviewDocument = z.infer<typeof CompanyControlReviewDocumentSchema>;
export const CompanyControlReviewMaterialSchema = CompanyControlReviewDocumentSchema.extend({ contentHash: hash }).strict();
export type CompanyControlReviewMaterial = z.infer<typeof CompanyControlReviewMaterialSchema>;
export const CompanyControlReviewFieldSchema = z.enum([
  "legalEntityName", "parentCompanyName", "status", "controlMode", "controllerName", "controllerKind", "controllerControl", "controllerJurisdiction",
]);
export type CompanyControlReviewField = z.infer<typeof CompanyControlReviewFieldSchema>;
/** Exact citation presence is checked. Its meaning and the corporate relationship are reviewed by the user. */
export const CompanyControlReviewSupportSchema = z.object({
  field: CompanyControlReviewFieldSchema, documentIndex: z.number().int().min(0).max(9),
  quote: z.string().min(1).max(20_000).refine(value => value === value.trim(), "Quote the exact trimmed passage."),
  controllerIndex: z.number().int().min(0).max(19).optional(),
}).strict();
export type CompanyControlReviewSupport = z.infer<typeof CompanyControlReviewSupportSchema>;
export const CompanyControlReviewProposalSchema = z.object({
  basis: z.literal("manual-evidence-review"),
  documents: z.array(CompanyControlReviewDocumentSchema).min(1).max(10),
  legalEntityName: text(500), parentCompanyName: text(500).optional(),
  status: z.enum(["resolved", "unknown", "conflicting"]), controlMode: z.enum(["single", "joint", "dispersed", "unknown"]),
  controllers: z.array(z.object({ name: text(500), kind: z.enum(["state", "private"]), jurisdictionCode: CountryCodeSchema.optional() }).strict()).max(20),
  supports: z.array(CompanyControlReviewSupportSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const sizes = value.documents.map(document => new TextEncoder().encode(document.rawText).byteLength);
  if (sizes.some(size => size > MAX_COMPANY_CONTROL_DOCUMENT_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > MAX_COMPANY_CONTROL_TOTAL_BYTES) issue("Company evidence exceeds its byte budget.");
  if (new Set(value.documents.map(document => JSON.stringify(document))).size !== value.documents.length) issue("Do not duplicate an imported document.");
  if (new Set(value.controllers.map(controller => controller.name)).size !== value.controllers.length) issue("Controllers must be individually identified.");
  if (value.status !== "resolved" && (value.controlMode !== "unknown" || value.controllers.length)
    || value.status === "resolved" && (value.controlMode === "unknown"
      || value.controlMode === "single" && value.controllers.length !== 1
      || value.controlMode === "joint" && value.controllers.length < 2
      || value.controlMode === "dispersed" && value.controllers.length !== 0)) issue("Keep unknown/conflicting, single, joint, and no-actual-controller disclosures distinct.");
  const required = new Set(["legalEntityName", "status", "controlMode", ...(value.parentCompanyName ? ["parentCompanyName"] : [])]);
  const seen = new Set<string>();
  for (const support of value.supports) {
    const perController = support.field.startsWith("controller");
    const index = support.controllerIndex;
    if (perController !== (index !== undefined) || index !== undefined && index >= value.controllers.length) issue("Controller citations require their own existing controller index.");
    if (!value.documents[support.documentIndex]?.rawText.includes(support.quote)) issue("Every citation must be present verbatim in its imported document.");
    const key = `${support.field}:${index ?? "company"}`;
    if (support.field === "parentCompanyName" && !value.parentCompanyName || support.field === "controllerJurisdiction" && (index === undefined || !value.controllers[index]?.jurisdictionCode)) issue("Do not cite a field whose value is absent.");
    seen.add(key);
  }
  for (const field of required) if (!seen.has(`${field}:company`)) issue(`Missing field citation: ${field}.`);
  value.controllers.forEach((controller, index) => {
    for (const field of ["controllerName", "controllerKind", "controllerControl", ...(controller.jurisdictionCode ? ["controllerJurisdiction"] : [])]) {
      if (!seen.has(`${field}:${index}`)) issue(`Missing ${field} citation for controller ${index}.`);
    }
  });
});
export type CompanyControlReviewProposal = z.infer<typeof CompanyControlReviewProposalSchema>;
const command = { jobId: EntityIdSchema, companyId: EntityIdSchema, expectedRevision: RevisionSchema, proposal: CompanyControlReviewProposalSchema, reason: text(500) };
export const ReadCompanyControlReviewInputSchema = z.object({ jobId: EntityIdSchema, companyId: EntityIdSchema, expectedRevision: RevisionSchema }).strict();
export type ReadCompanyControlReviewInput = z.infer<typeof ReadCompanyControlReviewInputSchema>;
export const PreviewCompanyControlReviewInputSchema = z.object(command).strict();
export type PreviewCompanyControlReviewInput = z.infer<typeof PreviewCompanyControlReviewInputSchema>;
export const ConfirmCompanyControlReviewInputSchema = z.object({ ...command, previewFingerprint: hash, reviewed: z.literal(true) }).strict();
export type ConfirmCompanyControlReviewInput = z.infer<typeof ConfirmCompanyControlReviewInputSchema>;
export const RevokeCompanyControlReviewInputSchema = z.object({ jobId: EntityIdSchema, companyId: EntityIdSchema, decisionId: EntityIdSchema, expectedRevision: RevisionSchema, reason: text(500), reviewed: z.literal(true) }).strict();
export type RevokeCompanyControlReviewInput = z.infer<typeof RevokeCompanyControlReviewInputSchema>;
const listingIdentitySchema = z.object({ id: EntityIdSchema, sourceId: EntityIdSchema, sourceRecordId: z.string().min(1).max(1000).optional(), canonicalUrl: HttpUrlSchema.optional(), applicationUrl: HttpUrlSchema.optional() }).strict();
export const CompanyControlReviewSourceBindingSchema = z.object({
  job: z.object({ id: EntityIdSchema, companyId: EntityIdSchema }).strict(),
  listings: z.array(listingIdentitySchema).max(10_000), observations: z.array(SourceObservationSchema).max(10_000), snapshots: z.array(JdSnapshotSchema).max(10_000),
}).strict().superRefine((value, context) => {
  if ([value.listings, value.observations, value.snapshots].some(entries => new Set(entries.map(entry => entry.id)).size !== entries.length)
    || value.observations.some(observation => !value.listings.some(listing => listing.id === observation.listingId)
      || observation.snapshotId && !value.snapshots.some(snapshot => snapshot.id === observation.snapshotId && snapshot.observationId === observation.id && snapshot.listingId === observation.listingId && (!observation.contentHash || snapshot.contentHash === observation.contentHash)))
    || value.snapshots.some(snapshot => !value.observations.some(observation => observation.id === snapshot.observationId && observation.listingId === snapshot.listingId))) {
    context.addIssue({ code: "custom", message: "Keep the original company evidence reference closure intact." });
  }
});
export type CompanyControlReviewSourceBinding = z.infer<typeof CompanyControlReviewSourceBindingSchema>;
const sourceCompany = CompanySchema.refine(value => !value.controlReview, "Keep the source company before review projection.");
const affected = z.array(EntityIdSchema).min(1).max(100_000).refine(ids => new Set(ids).size === ids.length, "Affected jobs must be unique.");
const metadata = { id: EntityIdSchema.max(160), jobId: EntityIdSchema, companyId: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), at: TimestampSchema, revision: RevisionSchema, reason: text(500), affectedJobIds: affected };
export const CompanyControlReviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...metadata, kind: z.literal("confirm"), sourceCompany, sourceBinding: CompanyControlReviewSourceBindingSchema, proposal: CompanyControlReviewProposalSchema, materials: z.array(CompanyControlReviewMaterialSchema).min(1).max(10) }).strict(),
  z.object({ ...metadata, kind: z.literal("revoke"), targetDecisionId: EntityIdSchema, sourceCompany, sourceBinding: CompanyControlReviewSourceBindingSchema }).strict(),
  z.object({ id: EntityIdSchema, kind: z.literal("invalidate"), actorScope: metadata.actorScope, at: TimestampSchema, revision: RevisionSchema, reason: z.literal("source-changed"), targetDecisionIds: z.array(EntityIdSchema).min(1).max(200_000).refine(ids => new Set(ids).size === ids.length, "Invalidation targets must be unique.") }).strict(),
]);
export type CompanyControlReviewDecision = z.infer<typeof CompanyControlReviewDecisionSchema>;
export type CompanyControlReviewConfirmation = Extract<CompanyControlReviewDecision, { kind: "confirm" }>;
export const CompanyControlReviewReadResultSchema = z.object({ schemaVersion: z.literal(1), revision: RevisionSchema, jobId: EntityIdSchema, companyId: EntityIdSchema, sourceCompany, current: CompanySchema, affectedJobIds: affected, activeDecisionId: EntityIdSchema.optional(), history: z.array(CompanyControlReviewDecisionSchema).max(200_000) }).strict();
export type CompanyControlReviewReadResult = z.infer<typeof CompanyControlReviewReadResultSchema>;
export const CompanyControlReviewPreviewSchema = z.object({ expectedRevision: RevisionSchema, previewFingerprint: hash, jobId: EntityIdSchema, companyId: EntityIdSchema, sourceCompany, current: CompanySchema, proposed: CompanySchema, affectedJobIds: affected, activeDecisionId: EntityIdSchema.optional(), warnings: z.array(text(3000)).max(20) }).strict();
export type CompanyControlReviewPreview = z.infer<typeof CompanyControlReviewPreviewSchema>;
export const CompanyControlReviewReceiptSchema = z.object({ ok: z.literal(true), revision: RevisionSchema, jobId: EntityIdSchema, companyId: EntityIdSchema, decisionId: EntityIdSchema, activeDecisionId: EntityIdSchema.optional(), company: CompanySchema, affectedJobIds: affected }).strict();
export type CompanyControlReviewReceipt = z.infer<typeof CompanyControlReviewReceiptSchema>;

function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, stable(item)])) : value; }
export function sameCompanyControlReviewValue(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
export function isCompanyControlReviewEntityId(value: string): boolean { return /^company-control-review-(?:source|listing|observation):/.test(value); }
function materialId(kind: "source" | "listing" | "observation", id: string, index: number): string { return `company-control-review-${kind}:${id}:${index}`; }
function listingIdentity(listing: Pick<SourceListing, "id" | "sourceId" | "sourceRecordId" | "canonicalUrl" | "applicationUrl">) {
  return { id: listing.id, sourceId: listing.sourceId, ...(listing.sourceRecordId ? { sourceRecordId: listing.sourceRecordId } : {}), ...(listing.canonicalUrl ? { canonicalUrl: listing.canonicalUrl } : {}), ...(listing.applicationUrl ? { applicationUrl: listing.applicationUrl } : {}) };
}
function companyEvidence(company: Company): EvidenceRef[] {
  return [...(company.legalEntity?.evidence ?? []), ...company.ultimateControllers.evidence,
    ...company.manualOverrides.flatMap(override => override.field === "legalEntity" || override.field === "ultimateControllers" ? override.value.evidence : [])];
}
function requireSource(base: AtlasDataset, binding: { jobId: string; companyId: string; sourceCompany: Company }) {
  if (!base.jobs.some(job => job.id === binding.jobId && job.companyId === binding.companyId)
    || binding.sourceCompany.id !== binding.companyId || binding.sourceCompany.controlReview
    || !sameCompanyControlReviewValue(base.companies.find(company => company.id === binding.companyId), binding.sourceCompany)) throw new Error("invalid-company-control-review-source");
}
export function captureCompanyControlReviewSourceBinding(base: AtlasDataset, binding: { jobId: string; companyId: string; sourceCompany: Company }): CompanyControlReviewSourceBinding {
  requireSource(base, binding);
  const refs = companyEvidence(binding.sourceCompany);
  const ids = new Set(refs.map(ref => ref.observationId));
  const observations = base.observations.filter(observation => ids.has(observation.id));
  if (observations.length !== ids.size || observations.some(observation => isCompanyControlReviewEntityId(observation.id))) throw new Error("invalid-company-control-review-source-evidence");
  const snapshotIds = new Set(observations.flatMap(observation => observation.snapshotId ? [observation.snapshotId] : []));
  const listingIds = new Set(observations.map(observation => observation.listingId));
  return CompanyControlReviewSourceBindingSchema.parse({ job: { id: binding.jobId, companyId: binding.companyId }, listings: base.listings.filter(listing => listingIds.has(listing.id)).map(listingIdentity), observations, snapshots: base.snapshots.filter(snapshot => snapshotIds.has(snapshot.id)) });
}
function references(decision: Pick<CompanyControlReviewConfirmation, "id" | "proposal">, fields: readonly CompanyControlReviewField[]): EvidenceRef[] {
  const refs = decision.proposal.supports.filter(support => fields.includes(support.field)).map(support => {
    const document = decision.proposal.documents[support.documentIndex]!;
    return { observationId: materialId("observation", decision.id, support.documentIndex), sourceUrl: document.sourceUrl,
      quote: support.quote, observedAt: document.retrievedAt };
  });
  return refs.filter((ref, index) => !refs.slice(0, index).some(previous => sameCompanyControlReviewValue(previous, ref)));
}
/** Replace effective values only. The complete source company and old manual overrides remain in history. */
export function applyCompanyControlReviewConfirmation(source: Company, input: Pick<CompanyControlReviewConfirmation, "id" | "companyId" | "at" | "revision" | "sourceCompany" | "proposal">): Company {
  const original = CompanySchema.parse(source); const proposal = CompanyControlReviewProposalSchema.parse(input.proposal);
  if (original.controlReview || original.id !== input.companyId || !compatibleCompany(original, input.sourceCompany)) throw new Error("invalid-company-control-review-source");
  const legalEvidence = references(input, ["legalEntityName"]);
  const controlEvidence = references(input, ["status", "controlMode", "controllerName", "controllerKind", "controllerControl", "controllerJurisdiction"]);
  return CompanySchema.parse({ ...original,
    legalEntity: { value: proposal.legalEntityName, method: "manual", verification: "verified", evidence: legalEvidence, revision: input.revision },
    ultimateControllers: { value: proposal.controllers, method: "manual", verification: proposal.status === "resolved" ? "verified" : proposal.status, evidence: controlEvidence, revision: input.revision },
    controlReview: { decisionId: input.id, method: "manual-evidence-review", at: input.at, status: proposal.status, controlMode: proposal.controlMode, ...(proposal.parentCompanyName ? { parentCompanyName: proposal.parentCompanyName } : {}) },
  });
}
export function validateCompanyControlReviewProposal(base: AtlasDataset, binding: { jobId: string; companyId: string; sourceCompany: Company; proposal: CompanyControlReviewProposal }): Company {
  requireSource(base, binding); captureCompanyControlReviewSourceBinding(base, binding);
  const proposal = CompanyControlReviewProposalSchema.parse(binding.proposal);
  return applyCompanyControlReviewConfirmation(binding.sourceCompany, { ...binding, proposal, id: "company-control-review-preview", at: [...proposal.documents].sort((left, right) => Date.parse(right.retrievedAt) - Date.parse(left.retrievedAt))[0]!.retrievedAt, revision: base.revision });
}
type TimeOptions = { now?: Date | string | number };
function timestamp(options?: TimeOptions): number { const value = options?.now ?? Date.now(); const millis = value instanceof Date ? value.getTime() : new Date(value).getTime(); if (!Number.isFinite(millis)) throw new Error("invalid-company-control-review-time"); return millis; }
async function sha256(rawText: string): Promise<string> { return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawText)))].map(value => value.toString(16).padStart(2, "0")).join(""); }
export async function buildCompanyControlReviewMaterials(input: CompanyControlReviewProposal, options?: TimeOptions): Promise<CompanyControlReviewMaterial[]> {
  const proposal = CompanyControlReviewProposalSchema.parse(input); const now = timestamp(options);
  return Promise.all(proposal.documents.map(async document => {
    if (Date.parse(document.retrievedAt) > now) throw new Error("future-company-control-review-document");
    return { ...document, contentHash: await sha256(document.rawText) };
  }));
}
/** An alias addition is not a new employer. Changed identity/control/evidence is never silently inherited. */
function compatibleCompany(current: Company, previous: Company): boolean {
  if (current.controlReview || previous.controlReview) return false;
  const { names: currentNames, domains: currentDomains, ...currentCore } = current;
  const { names: previousNames, domains: previousDomains, ...previousCore } = previous;
  return previousNames.every(name => currentNames.includes(name)) && previousDomains.every(domain => currentDomains.includes(domain)) && sameCompanyControlReviewValue(currentCore, previousCore);
}
function validateArchivedSource(decision: Extract<CompanyControlReviewDecision, { kind: "confirm" | "revoke" }>): void {
  const binding = decision.sourceBinding;
  if (decision.sourceCompany.id !== decision.companyId || binding.job.id !== decision.jobId || binding.job.companyId !== decision.companyId
    || !decision.affectedJobIds.includes(decision.jobId)
    || companyEvidence(decision.sourceCompany).some(ref => !binding.observations.some(observation => observation.id === ref.observationId))
    || binding.listings.some(listing => isCompanyControlReviewEntityId(listing.id) || isCompanyControlReviewEntityId(listing.sourceId))
    || binding.observations.some(observation => isCompanyControlReviewEntityId(observation.id))) throw new Error("invalid-company-control-review-binding");
}
function currentBinding(base: AtlasDataset, decision: CompanyControlReviewConfirmation): boolean {
  const company = base.companies.find(value => value.id === decision.companyId);
  return !!company && compatibleCompany(company, decision.sourceCompany)
    && base.jobs.some(job => job.id === decision.jobId && job.companyId === decision.companyId)
    && decision.sourceBinding.listings.every(listing => { const current = base.listings.find(value => value.id === listing.id); return current && sameCompanyControlReviewValue(listingIdentity(current), listing); })
    && decision.sourceBinding.observations.every(observation => sameCompanyControlReviewValue(base.observations.find(value => value.id === observation.id), observation))
    && decision.sourceBinding.snapshots.every(snapshot => sameCompanyControlReviewValue(base.snapshots.find(value => value.id === snapshot.id), snapshot));
}
function validateMaterials(decision: CompanyControlReviewConfirmation) {
  if (decision.materials.length !== decision.proposal.documents.length || decision.materials.some((material, index) => {
    const { contentHash: _contentHash, ...document } = material;
    return !sameCompanyControlReviewValue(document, decision.proposal.documents[index]) || Date.parse(document.retrievedAt) > Date.parse(decision.at);
  })) throw new Error("invalid-company-control-review-material");
}
function replay(base: AtlasDataset, input: readonly CompanyControlReviewDecision[]) {
  const decisions = input.map(value => CompanyControlReviewDecisionSchema.parse(value));
  const seen = new Map<string, CompanyControlReviewDecision>(); const disabled = new Set<string>(); const revoked = new Set<string>(); let revision = -1; let at = -Infinity;
  for (const decision of decisions) {
    if (seen.has(decision.id) || decision.revision <= revision || decision.revision > base.revision || Date.parse(decision.at) < at) throw new Error("invalid-company-control-review-decision");
    revision = decision.revision; at = Date.parse(decision.at);
    if (decision.kind === "confirm") {
      validateArchivedSource(decision); validateMaterials(decision); applyCompanyControlReviewConfirmation(decision.sourceCompany, decision);
    } else if (decision.kind === "revoke") {
      const target = seen.get(decision.targetDecisionId);
      if (!target || target.kind !== "confirm" || target.companyId !== decision.companyId || target.actorScope !== decision.actorScope || revoked.has(target.id)) throw new Error("invalid-company-control-review-revocation");
      validateArchivedSource(decision); disabled.add(target.id); revoked.add(target.id);
    } else {
      for (const id of decision.targetDecisionIds) {
        if (seen.get(id)?.kind !== "confirm" || disabled.has(id)) throw new Error("invalid-company-control-review-invalidation");
        disabled.add(id);
      }
    }
    seen.set(decision.id, decision);
  }
  return { decisions, live: decisions.filter((decision): decision is CompanyControlReviewConfirmation => decision.kind === "confirm" && !disabled.has(decision.id)) };
}
export function getInvalidatedCompanyControlReviewIds(base: AtlasDataset, input: readonly CompanyControlReviewDecision[]): string[] { return replay(base, input).live.filter(decision => !currentBinding(base, decision)).map(decision => decision.id); }
export function activeCompanyControlReviewDecision(base: AtlasDataset, input: readonly CompanyControlReviewDecision[], companyId: string): CompanyControlReviewConfirmation | undefined {
  return replay(base, input).live.filter(decision => decision.companyId === companyId && currentBinding(base, decision)).at(-1);
}
function appendMaterials(base: AtlasDataset, decisions: readonly CompanyControlReviewDecision[]): AtlasDataset {
  const result = structuredClone(base);
  for (const decision of decisions) if (decision.kind === "confirm") decision.materials.forEach((material, index) => {
    if (!decision.proposal.supports.some(support => support.documentIndex === index)) return;
    const sourceId = materialId("source", decision.id, index); const listingId = materialId("listing", decision.id, index); const observationId = materialId("observation", decision.id, index);
    const url = new URL(material.sourceUrl);
    result.sources.push({ sourceId, name: "本人导入的企业公开材料", adapterId: "company-control-review-material", adapterVersion: "1", capabilities: [], runtime: ["local-service"], entityType: "company-directory", enabled: false, status: "disabled", entryUrl: material.sourceUrl, remoteFilters: [], endpointPolicy: { allowedHosts: [url.hostname], allowedPathPrefixes: ["/"], requireHttps: url.protocol === "https:", allowRedirects: false, maxRedirects: 0 }, attribution: { label: "本人核对材料，非发布机构认证", usage: "unknown", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 1, maxPages: 1, requestsPerMinute: 1 } });
    result.listings.push({ id: listingId, sourceId, sourceRecordId: `${decision.id}:${index}`, canonicalUrl: material.sourceUrl, observationIds: [observationId], firstDiscoveredAt: material.retrievedAt });
    result.observations.push({ id: observationId, listingId, fetchedAt: material.retrievedAt, contentHash: material.contentHash, result: "read", availability: "unknown", completeness: "excerpt", rawText: material.rawText, warnings: ["手工导入的企业材料；未自动验证发布机构身份、内容含义或岗位可用性。"] });
  });
  return result;
}
/** Reject forged reserved records; only exact reproducible material projections may be removed. */
export function stripCompanyControlReviewProjection(input: AtlasDataset, decisions: readonly CompanyControlReviewDecision[] = []): AtlasDataset {
  const base = AtlasDatasetSchema.parse(input); const parsed = replay(base, decisions).decisions;
  const empty: AtlasDataset = { schemaVersion: 1, revision: base.revision, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
  const expected = appendMaterials(empty, parsed);
  const validateReserved = <T>(entries: T[], records: T[], key: (value: T) => string) => entries.forEach(entry => {
    if (isCompanyControlReviewEntityId(key(entry)) && !records.some(record => key(record) === key(entry) && sameCompanyControlReviewValue(record, entry))) throw new Error("forged-company-control-review-projection");
  });
  validateReserved(base.sources, expected.sources, value => value.sourceId); validateReserved(base.listings, expected.listings, value => value.id); validateReserved(base.observations, expected.observations, value => value.id);
  if (base.snapshots.some(snapshot => isCompanyControlReviewEntityId(snapshot.id) || isCompanyControlReviewEntityId(snapshot.listingId))
    || base.jobs.some(job => job.listingIds.some(isCompanyControlReviewEntityId))) throw new Error("invalid-company-control-review-job-material");
  const companies = base.companies.map(company => {
    if (!company.controlReview) return company;
    const decision = parsed.find((entry): entry is CompanyControlReviewConfirmation => entry.kind === "confirm" && entry.id === company.controlReview!.decisionId && entry.companyId === company.id);
    if (!decision) throw new Error("orphan-company-control-review-marker");
    const { controlReview: _controlReview, legalEntity: _legalEntity, ultimateControllers: _ultimateControllers, ...retained } = company;
    const source = { ...retained, ...(decision.sourceCompany.legalEntity ? { legalEntity: decision.sourceCompany.legalEntity } : {}), ultimateControllers: decision.sourceCompany.ultimateControllers };
    if (!sameCompanyControlReviewValue(company, applyCompanyControlReviewConfirmation(source, decision))) throw new Error("changed-company-control-review-projection");
    return source;
  });
  return AtlasDatasetSchema.parse({ ...base, companies, sources: base.sources.filter(source => !isCompanyControlReviewEntityId(source.sourceId)), listings: base.listings.filter(listing => !isCompanyControlReviewEntityId(listing.id)), observations: base.observations.filter(observation => !isCompanyControlReviewEntityId(observation.id)) });
}
/** This pure projection never joins companies by names, domains, parent names, or brand impressions. */
export function projectCompanyControlReviews(input: AtlasDataset, decisions: readonly CompanyControlReviewDecision[]): AtlasDataset {
  const base = stripCompanyControlReviewProjection(input, decisions); const replayed = replay(base, decisions);
  const active = new Map<string, CompanyControlReviewConfirmation>();
  for (const decision of replayed.live) if (currentBinding(base, decision)) active.set(decision.companyId, decision);
  const projected = appendMaterials(base, [...active.values()]);
  projected.companies = projected.companies.map(company => active.has(company.id) ? applyCompanyControlReviewConfirmation(company, active.get(company.id)!) : company);
  return AtlasDatasetSchema.parse(projected);
}
/** Call at trust boundaries before confirming or restoring; synchronous projection does not rehash raw documents. */
export async function validateCompanyControlReviewHistory(base: AtlasDataset, input: readonly CompanyControlReviewDecision[], options?: TimeOptions): Promise<void> {
  const now = timestamp(options); const { decisions } = replay(base, input);
  for (const decision of decisions) {
    if (Date.parse(decision.at) > now) throw new Error("future-company-control-review-decision");
    if (decision.kind === "confirm") {
      const materials = await buildCompanyControlReviewMaterials(decision.proposal, { now: Math.min(now, Date.parse(decision.at)) });
      if (!sameCompanyControlReviewValue(materials, decision.materials)) throw new Error("invalid-company-control-review-hash");
    }
  }
  projectCompanyControlReviews(base, decisions);
}
