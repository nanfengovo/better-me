import { z } from "zod";
import { AtlasDatasetSchema, CompensationKindSchema, CompensationPeriodSchema, CompensationSchema, CurrencyCodeSchema, EntityIdSchema, EvidenceRefSchema, HttpUrlSchema, JdSnapshotSchema, RevisionSchema, SourceObservationSchema, TimestampSchema, type AtlasDataset, type Compensation, type EvidenceRef } from "./schema.js";

const note = z.string().trim().min(1).max(500).refine(value => !/[\p{Cc}\p{Cs}]/u.test(value), "Use plain review notes.");
export const CompensationReviewFieldSchema = z.enum(["min", "max", "currency", "period", "tax", "kind", "monthsPerYear", "hoursPerYear", "daysPerYear", "weeksPerYear"]);
export type CompensationReviewField = z.infer<typeof CompensationReviewFieldSchema>;
export const CompensationReviewSupportSchema = z.object({
  field: CompensationReviewFieldSchema,
  reference: EvidenceRefSchema.extend({ quote: z.string().min(1).max(4000).refine(value => value === value.trim(), "Quote the exact trimmed source passage.") }),
  snapshotId: EntityIdSchema.optional(),
}).strict();
export type CompensationReviewSupport = z.infer<typeof CompensationReviewSupportSchema>;
/** This is a reading of retained disclosure, never a person certifying employer facts. */
export const CompensationReviewProposalSchema = z.object({
  basis: z.literal("manual-evidence-review"),
  min: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  max: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  currency: CurrencyCodeSchema.optional(), period: CompensationPeriodSchema,
  tax: z.enum(["gross", "net", "unknown"]), kind: CompensationKindSchema,
  monthsPerYear: z.number().finite().positive().max(36).optional(),
  hoursPerYear: z.number().finite().positive().max(8784).optional(),
  daysPerYear: z.number().finite().positive().max(366).optional(),
  weeksPerYear: z.number().finite().positive().max(53).optional(),
  supports: z.array(CompensationReviewSupportSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) context.addIssue({ code: "custom", path: ["max"], message: "Salary bounds must be ordered." });
  for (const field of CompensationReviewFieldSchema.options) {
    const present = value[field] !== undefined && value[field] !== "unknown";
    const supports = value.supports.filter(support => support.field === field);
    if (present && !supports.length || !present && supports.length) context.addIssue({ code: "custom", path: ["supports"], message: `Only an actual ${field} value may have mandatory field evidence.` });
  }
  if (value.monthsPerYear !== undefined && value.period !== "month" || value.hoursPerYear !== undefined && value.period !== "hour" || value.daysPerYear !== undefined && value.period !== "day" || value.weeksPerYear !== undefined && value.period !== "week") {
    context.addIssue({ code: "custom", message: "Annualization must match the disclosed salary period." });
  }
});
export type CompensationReviewProposal = z.infer<typeof CompensationReviewProposalSchema>;
const command = { jobId: EntityIdSchema, compensationId: EntityIdSchema, expectedRevision: RevisionSchema, proposal: CompensationReviewProposalSchema, reason: note };
export const PreviewCompensationReviewInputSchema = z.object(command).strict();
export type PreviewCompensationReviewInput = z.infer<typeof PreviewCompensationReviewInputSchema>;
export const ConfirmCompensationReviewInputSchema = z.object({ ...command, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export type ConfirmCompensationReviewInput = z.infer<typeof ConfirmCompensationReviewInputSchema>;
export const RevokeCompensationReviewInputSchema = z.object({ jobId: EntityIdSchema, compensationId: EntityIdSchema, decisionId: EntityIdSchema, expectedRevision: RevisionSchema, reason: note, reviewed: z.literal(true) }).strict();
export type RevokeCompensationReviewInput = z.infer<typeof RevokeCompensationReviewInputSchema>;
export const ReadCompensationReviewInputSchema = z.object({ jobId: EntityIdSchema, compensationId: EntityIdSchema, expectedRevision: RevisionSchema }).strict();
export type ReadCompensationReviewInput = z.infer<typeof ReadCompensationReviewInputSchema>;
const metadata = { id: EntityIdSchema, jobId: EntityIdSchema, listingId: EntityIdSchema, compensationId: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/), at: TimestampSchema, revision: RevisionSchema, reason: note };
const reviewListing = z.object({ id: EntityIdSchema, sourceId: EntityIdSchema, sourceRecordId: z.string().min(1).max(1000).optional(), canonicalUrl: HttpUrlSchema.optional(), applicationUrl: HttpUrlSchema.optional() }).strict();
/** Only source identity and materials actually referenced by this decision; not a dataset copy. */
export const CompensationReviewSourceBindingSchema = z.object({ listing: reviewListing, observations: z.array(SourceObservationSchema).min(1).max(230), snapshots: z.array(JdSnapshotSchema).max(230) }).strict().superRefine((value, context) => {
  if (new Set(value.observations.map(entry => entry.id)).size !== value.observations.length || new Set(value.snapshots.map(entry => entry.id)).size !== value.snapshots.length) context.addIssue({ code: "custom", message: "Review materials cannot duplicate IDs." });
  if (value.observations.some(entry => entry.listingId !== value.listing.id || entry.snapshotId && !value.snapshots.some(snapshot => snapshot.id === entry.snapshotId && snapshot.observationId === entry.id))
    || value.snapshots.some(entry => entry.listingId !== value.listing.id || !value.observations.some(observation => observation.id === entry.observationId))) context.addIssue({ code: "custom", message: "Review materials must preserve their listing and observation identity." });
  if (value.observations.some(entry => entry.snapshotId && entry.contentHash && value.snapshots.find(snapshot => snapshot.id === entry.snapshotId)?.contentHash !== entry.contentHash)) context.addIssue({ code: "custom", message: "An observation and its bound JD snapshot must retain the same content hash." });
});
export type CompensationReviewSourceBinding = z.infer<typeof CompensationReviewSourceBindingSchema>;
export const CompensationReviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...metadata, kind: z.literal("confirm"), sourceCompensation: CompensationSchema, sourceBinding: CompensationReviewSourceBindingSchema, proposal: CompensationReviewProposalSchema }).strict(),
  z.object({ ...metadata, kind: z.literal("revoke"), targetDecisionId: EntityIdSchema, sourceCompensation: CompensationSchema, sourceBinding: CompensationReviewSourceBindingSchema }).strict(),
  z.object({ id: EntityIdSchema, kind: z.literal("invalidate"), actorScope: metadata.actorScope, at: TimestampSchema, revision: RevisionSchema, reason: z.literal("source-changed"), targetDecisionIds: z.array(EntityIdSchema).min(1).max(200_000).refine(ids => new Set(ids).size === ids.length, "Invalidation targets must be unique.") }).strict(),
]);
export type CompensationReviewDecision = z.infer<typeof CompensationReviewDecisionSchema>;
export type CompensationReviewConfirmation = Extract<CompensationReviewDecision, { kind: "confirm" }>;
export const CompensationReviewPreviewSchema = z.object({ expectedRevision: RevisionSchema, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/), jobId: EntityIdSchema, compensationId: EntityIdSchema, listingId: EntityIdSchema, sourceCompensation: CompensationSchema, current: CompensationSchema, proposed: CompensationSchema, activeDecisionId: EntityIdSchema.optional(), warnings: z.array(z.string().min(1).max(3000)).max(20) }).strict();
export type CompensationReviewPreview = z.infer<typeof CompensationReviewPreviewSchema>;
export const CompensationReviewReceiptSchema = z.object({ ok: z.literal(true), revision: RevisionSchema, jobId: EntityIdSchema, compensationId: EntityIdSchema, decisionId: EntityIdSchema, activeDecisionId: EntityIdSchema.optional(), compensation: CompensationSchema }).strict();
export type CompensationReviewReceipt = z.infer<typeof CompensationReviewReceiptSchema>;
export const CompensationReviewReadResultSchema = z.object({ schemaVersion: z.literal(1), revision: RevisionSchema, jobId: EntityIdSchema, compensationId: EntityIdSchema, listingId: EntityIdSchema, sourceCompensation: CompensationSchema, current: CompensationSchema, activeDecisionId: EntityIdSchema.optional(), history: z.array(CompensationReviewDecisionSchema).max(200_000) }).strict();
export type CompensationReviewReadResult = z.infer<typeof CompensationReviewReadResultSchema>;

function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)])) : value; }
export function sameCompensationReviewValue(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }

type Binding = { jobId: string; listingId: string; compensationId: string; sourceCompensation: Compensation; proposal: CompensationReviewProposal };
/** All supporting text is already retained in this listing; this function performs no network calls. */
export function validateCompensationReviewProposal(base: AtlasDataset, binding: Binding): Compensation {
  if (!currentOwner(base, binding) || !sameCompensationReviewValue(base.compensations.find(value => value.id === binding.compensationId), binding.sourceCompensation)) throw new Error("invalid-compensation-review-source");
  validateDisclosure(base, binding);
  return applyCompensationReviewConfirmation(binding.sourceCompensation, binding);
}

export function captureCompensationReviewSourceBinding(base: AtlasDataset, binding: { listingId: string; sourceCompensation: Compensation; proposal?: CompensationReviewProposal; jobId?: string; compensationId?: string }): CompensationReviewSourceBinding {
  if (binding.proposal) validateDisclosure(base, { ...binding, compensationId: binding.compensationId ?? binding.sourceCompensation.id, jobId: binding.jobId ?? "capture", proposal: binding.proposal });
  const listing = base.listings.find(value => value.id === binding.listingId);
  if (!listing || !binding.sourceCompensation.evidence.length || binding.sourceCompensation.evidence.some(entry => base.observations.find(value => value.id === entry.observationId)?.listingId !== listing.id)) throw new Error("invalid-compensation-review-source");
  const observationIds = new Set([...binding.sourceCompensation.evidence.map(value => value.observationId), ...(binding.proposal?.supports.map(value => value.reference.observationId) ?? [])]);
  const observations = base.observations.filter(value => observationIds.has(value.id));
  const snapshotIds = new Set([...(binding.proposal?.supports.flatMap(value => value.snapshotId ? [value.snapshotId] : []) ?? []), ...observations.flatMap(value => value.snapshotId ? [value.snapshotId] : [])]);
  return CompensationReviewSourceBindingSchema.parse({ listing: listingIdentity(listing), observations, snapshots: base.snapshots.filter(value => snapshotIds.has(value.id)) });
}

function listingIdentity(listing: { id: string; sourceId: string; sourceRecordId?: string; canonicalUrl?: string; applicationUrl?: string }) {
  return { id: listing.id, sourceId: listing.sourceId, ...(listing.sourceRecordId ? { sourceRecordId: listing.sourceRecordId } : {}), ...(listing.canonicalUrl ? { canonicalUrl: listing.canonicalUrl } : {}), ...(listing.applicationUrl ? { applicationUrl: listing.applicationUrl } : {}) };
}

function historicalDataset(decision: CompensationReviewConfirmation): AtlasDataset {
  const { sourceBinding } = decision;
  if (sourceBinding.listing.id !== decision.listingId) throw new Error("invalid-compensation-review-binding");
  return { schemaVersion: 1, revision: decision.revision, sources: [], companies: [], jobs: [], locations: [], compensations: [decision.sourceCompensation],
    listings: [{ ...sourceBinding.listing, observationIds: sourceBinding.observations.map(value => value.id), firstDiscoveredAt: decision.at }], observations: sourceBinding.observations, snapshots: sourceBinding.snapshots };
}

function sameCurrentDisclosure(base: AtlasDataset, decision: CompensationReviewConfirmation): boolean {
  const currentListing = base.listings.find(value => value.id === decision.listingId);
  if (!currentListing || !sameCompensationReviewValue(listingIdentity(currentListing), decision.sourceBinding.listing)) return false;
  // Observation/snapshot records are append-only. Missing or replaced evidence invalidates its review.
  return decision.sourceBinding.observations.every(entry => sameCompensationReviewValue(base.observations.find(value => value.id === entry.id), entry))
    && decision.sourceBinding.snapshots.every(entry => sameCompensationReviewValue(base.snapshots.find(value => value.id === entry.id), entry));
}

function currentOwner(base: AtlasDataset, binding: Pick<Binding, "jobId" | "listingId" | "compensationId">): boolean {
  const owners = base.jobs.filter(job => job.compensationIds.includes(binding.compensationId));
  const listing = base.listings.find(value => value.id === binding.listingId);
  const contributing = base.listings.filter(value => value.compensationIds?.includes(binding.compensationId));
  return owners.length === 1 && owners[0]!.id === binding.jobId && owners[0]!.listingIds.includes(binding.listingId)
    && !!listing && (!listing.canonicalJobId || listing.canonicalJobId === binding.jobId)
    && (contributing.length ? contributing.length === 1 && contributing[0]!.id === binding.listingId : true);
}

function validateDisclosure(base: AtlasDataset, binding: Binding): void {
  const source = CompensationSchema.parse(binding.sourceCompensation);
  const proposal = CompensationReviewProposalSchema.parse(binding.proposal);
  const listing = base.listings.find(value => value.id === binding.listingId);
  if (source.id !== binding.compensationId || !listing || !source.evidence.length || source.evidence.some(reference => base.observations.find(value => value.id === reference.observationId)?.listingId !== listing.id)) throw new Error("invalid-compensation-review-source");
  for (const support of proposal.supports) {
    const { reference, snapshotId } = support;
    const observation = base.observations.find(value => value.id === reference.observationId);
    const snapshot = snapshotId ? base.snapshots.find(value => value.id === snapshotId) : undefined;
    if (!observation || observation.listingId !== listing.id || !listing.observationIds.includes(observation.id)
      || observation.result === "failed" || observation.result === "needs-human" || ![observation.fetchedAt, observation.detailFetchedAt].includes(reference.observedAt)
      || snapshotId && (!snapshot || snapshot.listingId !== listing.id || snapshot.observationId !== observation.id)
      || !(snapshotId ? snapshot?.text : observation.rawText)?.includes(reference.quote)) throw new Error("invalid-compensation-review-evidence");
    const urls = [listing.canonicalUrl, listing.applicationUrl, snapshot?.sourceUrl, ...source.evidence.filter(value => value.observationId === observation.id).map(value => value.sourceUrl)];
    if (!urls.includes(reference.sourceUrl)) throw new Error("invalid-compensation-review-evidence-url");
    if (!supportsValue(support.field, proposal, reference.quote)) throw new Error(`unsupported-compensation-review-field:${support.field}`);
  }
}

/** Keep the raw disclosure and source references; manual interpretation remains unverified. */
export function applyCompensationReviewConfirmation(source: Compensation, decision: Pick<CompensationReviewConfirmation, "compensationId" | "sourceCompensation" | "proposal">): Compensation {
  const original = CompensationSchema.parse(source);
  const proposal = CompensationReviewProposalSchema.parse(decision.proposal);
  if (source.id !== decision.compensationId || !sameCompensationReviewValue(source, decision.sourceCompensation)) throw new Error("invalid-compensation-review-source");
  for (const support of proposal.supports) if (!supportsValue(support.field, proposal, support.reference.quote)) throw new Error(`unsupported-compensation-review-field:${support.field}`);
  const { basis: _basis, supports, ...fields } = proposal;
  const evidence: EvidenceRef[] = structuredClone(original.evidence);
  for (const support of supports) if (!evidence.some(value => sameCompensationReviewValue(value, support.reference))) evidence.push(structuredClone(support.reference));
  // Absent annualization/amount fields are unknown after review, never inherited from an unsafe parser.
  return CompensationSchema.parse({ id: original.id, ...(original.locationIds ? { locationIds: original.locationIds } : {}), raw: original.raw, ...fields, verification: "unverified", evidence });
}

function replay(base: AtlasDataset, input: readonly CompensationReviewDecision[]) {
  const decisions = input.map(value => CompensationReviewDecisionSchema.parse(value));
  const seen = new Map<string, CompensationReviewDecision>(); const disabled = new Set<string>(); const revoked = new Set<string>(); let previous = -1;
  for (const decision of decisions) {
    if (seen.has(decision.id) || decision.revision <= previous || decision.revision > base.revision) throw new Error("invalid-compensation-review-decision");
    previous = decision.revision;
    if (decision.kind === "confirm") {
      validateDisclosure(historicalDataset(decision), decision);
      applyCompensationReviewConfirmation(decision.sourceCompensation, decision);
    } else if (decision.kind === "revoke") {
      const target = seen.get(decision.targetDecisionId);
      if (!target || target.kind !== "confirm" || target.compensationId !== decision.compensationId || target.jobId !== decision.jobId || target.listingId !== decision.listingId || target.actorScope !== decision.actorScope || revoked.has(target.id) || decision.sourceCompensation.id !== decision.compensationId) throw new Error("invalid-compensation-review-revocation");
      revoked.add(target.id);
      if (decision.sourceBinding.listing.id !== decision.listingId || decision.sourceCompensation.evidence.some(reference => !decision.sourceBinding.observations.some(observation => observation.id === reference.observationId && observation.listingId === decision.listingId))) throw new Error("invalid-compensation-review-revoke-source");
      disabled.add(target.id);
    } else {
      for (const id of decision.targetDecisionIds) {
        if (seen.get(id)?.kind !== "confirm" || disabled.has(id)) throw new Error("invalid-compensation-review-invalidation");
        disabled.add(id);
      }
    }
    seen.set(decision.id, decision);
  }
  const live = decisions.filter((value): value is CompensationReviewConfirmation => value.kind === "confirm" && !disabled.has(value.id));
  return { decisions, live };
}

/** Call at each source import before persisting it. Store an invalidation even if A later returns unchanged. */
export function getInvalidatedCompensationReviewIds(base: AtlasDataset, input: readonly CompensationReviewDecision[]): string[] {
  return replay(base, input).live.filter(decision => !currentOwner(base, decision) || !sameCurrentDisclosure(base, decision) || !sameCompensationReviewValue(base.compensations.find(value => value.id === decision.compensationId), decision.sourceCompensation)).map(value => value.id);
}

export function activeCompensationReviewDecision(base: AtlasDataset, input: readonly CompensationReviewDecision[], compensationId: string): CompensationReviewConfirmation | undefined {
  return replay(base, input).live.filter(decision => decision.compensationId === compensationId && currentOwner(base, decision) && sameCurrentDisclosure(base, decision)
    && sameCompensationReviewValue(base.compensations.find(value => value.id === compensationId), decision.sourceCompensation)).at(-1);
}

/** Deterministic pure projection for transactions and backup verification; no FX or guesses are supplied. */
export function projectCompensationReviews(base: AtlasDataset, input: readonly CompensationReviewDecision[]): AtlasDataset {
  const active = new Map<string, CompensationReviewConfirmation>();
  for (const decision of replay(base, input).live) active.set(decision.compensationId, decision);
  return AtlasDatasetSchema.parse({ ...base, compensations: base.compensations.map(source => {
    const decision = active.get(source.id);
    return decision && currentOwner(base, decision) && sameCurrentDisclosure(base, decision) && sameCompensationReviewValue(source, decision.sourceCompensation) ? applyCompensationReviewConfirmation(source, decision) : source;
  }) });
}

function normalized(quote: string): string { return quote.normalize("NFKC").replace(/[‐‑‒–—−~～至到]/g, "-").toLowerCase(); }
function supportsValue(field: CompensationReviewField, proposal: CompensationReviewProposal, quote: string): boolean {
  const text = normalized(quote);
  if (/待定|未明确|尚未确定|未披露|仅供参考|例如|示例|\b(?:unspecified|undisclosed|hypothetical|example)\b/.test(text)) return false;
  if (field === "min" || field === "max") {
    if (proposal.kind === "base" && /奖金|股票|股权|总包|总薪酬|\b(?:bonus|equity|stock|ote)\b|\btotal\s+(?:compensation|salary|pay)\b/.test(text)) return false;
    if (proposal.tax === "gross" && /税后|\bnet\b|after tax/.test(text) || proposal.tax === "net" && /税前|\bgross\b|before tax/.test(text)) return false;
    if (proposal.period !== "unknown" && periodsIn(text).size && !supportsValue("period", proposal, quote)) return false;
    if (proposal.currency && /\b(?:cny|rmb|usd|eur|gbp|hkd|sgd|jpy)\b|人民币|[¥￥€£]|美元|欧元|港元|日元|新加坡元|元/.test(text) && !supportsValue("currency", proposal, quote)) return false;
    const bounds = disclosedBounds(text);
    return bounds !== undefined && bounds[field] === proposal[field];
  }
  if (field === "currency") {
    const matches = new Set<string>();
    for (const [currency, pattern] of [["CNY", /\b(?:cny|rmb)\b|人民币|[¥￥]|元/], ["USD", /\busd\b|us\$|美元/], ["EUR", /\beur\b|€|欧元/], ["GBP", /\bgbp\b|£|英镑/], ["HKD", /\bhkd\b|hk\$|港币|港元/], ["SGD", /\bsgd\b|s\$|新加坡元|新币/], ["JPY", /\bjpy\b|日元/]] as const) if (pattern.test(text)) matches.add(currency);
    // 元 occurs inside other Chinese currency names; those specific forms do not mean CNY.
    if (/(美元|欧元|港元|日元|新加坡元)/.test(text) && !/\b(?:cny|rmb)\b|人民币|[¥￥]/.test(text)) matches.delete("CNY");
    if (proposal.currency && new RegExp(`\\b${proposal.currency.toLowerCase()}\\b`).test(text)) matches.add(proposal.currency);
    return matches.size === 1 && matches.has(proposal.currency!);
  }
  if (field === "period") {
    const periods = periodsIn(text);
    return periods.size === 1 && periods.has(proposal.period);
  }
  if (field === "tax") {
    if (/(?:非|不|并非|不是|not\s+)\s*(?:税前|税后|gross|net)|税前或税后|gross\s+or\s+net/.test(text)) return false;
    const gross = /税前|\bgross\b|before tax|pre-tax/.test(text); const net = /税后|\bnet\b|after tax|post-tax/.test(text);
    return gross !== net && (proposal.tax === "gross" ? gross : proposal.tax === "net" && net);
  }
  if (field === "kind") {
    if (/(?:非|不|并非|不是|not\s+)(?:固定|基本|底薪|base|fixed)|(?:含|包括|including|includes).{0,16}(?:奖金|股票|股权|bonus|equity)/.test(text)) return false;
    const kinds = new Set<string>();
    for (const [kind, pattern] of [["base", /基本(?:工资|薪资)|固定(?:工资|薪资|月薪|年薪)|底薪|\bbase\s+(?:salary|pay|wage)\b|\bfixed\s+(?:salary|pay|cash|wage)\b/], ["bonus", /奖金|\bbonus\b/], ["equity", /股票|股权|\bequity\b|\bstock\b/], ["total", /总包|综合薪酬|总薪酬|\btotal\s+(?:compensation|salary|pay)\b/]] as const) if (pattern.test(text)) kinds.add(kind);
    return kinds.size === 1 && kinds.has(proposal.kind);
  }
  const units = { monthsPerYear: ["月", "months"], hoursPerYear: ["小时", "hours"], daysPerYear: ["天", "days"], weeksPerYear: ["周", "weeks"] } as const;
  const value = proposal[field];
  if (value === undefined || /最高|最多|至多|可达|有望|预计|可能|视.{0,8}(?:绩效|业绩)|(?:不|未)(?:保证|保障)|\b(?:up to|maximum|potential|discretionary|estimated|not guaranteed|bonus)\b|奖金|年终奖/.test(text)) return false;
  const [zh, en] = units[field];
  const literal = String(value).replace(".", "\\.");
  const chinese = field === "monthsPerYear"
    ? new RegExp(`(?:每年|全年|年度)(?:保证|保障|固定|明确)(?:发放|支付|发薪|计薪|工作)?\\s*${literal}\\s*(?:个)?月(?:工资|薪资|固定工资)?|(?:保证|保障|固定)(?:发放|支付)?\\s*${literal}\\s*薪`)
    : new RegExp(`(?:每年|全年|年度)(?:保证|保障|固定|明确)(?:支付|计薪|工作)?\\s*${literal}\\s*(?:个)?${zh}`);
  const english = new RegExp(`\\b(?:guaranteed|fixed)\\s+${literal}\\s+${en}\\s+(?:of\\s+(?:base\\s+)?(?:salary|pay)\\s+)?(?:per year|annually)\\b`);
  return chinese.test(text) || english.test(text);
}

function periodsIn(text: string): Set<string> {
  const periods = new Set<string>();
  for (const [period, pattern] of [["hour", /时薪|小时(?:工资|薪资)|(?:元|usd|cny|eur)\s*\/\s*(?:小时|时)|\b(?:hourly|per hour)\b|\/\s*(?:hour|hr)\b/], ["day", /日薪|每天(?:工资|薪资)|(?:元|usd|cny|eur)\s*\/\s*天|\b(?:daily|per day)\b|\/\s*day\b/], ["week", /周薪|每周(?:工资|薪资)|(?:元|usd|cny|eur)\s*\/\s*周|\b(?:weekly|per week)\b|\/\s*week\b/], ["month", /月薪|月工资|每月(?:工资|薪资)|(?:元|usd|cny|eur)\s*\/\s*月|\b(?:monthly|per month)\b|\/\s*(?:month|mo)\b/], ["year", /年薪|年度(?:固定|基本)?(?:工资|薪资)|(?:元|usd|cny|eur)\s*\/\s*年|\b(?:annual|annually|yearly|per year)\b|\/\s*(?:year|yr)\b/]] as const) if (pattern.test(text)) periods.add(period);
  return periods;
}

/** Intentionally small grammar. Anything ambiguous remains unreviewable rather than guessed. */
function disclosedBounds(text: string): { min?: number; max?: number } | undefined {
  if (!/薪|工资|底薪|\b(?:salary|pay|wage)\b/.test(text) || /面议|negotiable|\bote\b/.test(text)) return undefined;
  const number = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*([kw千万]?)";
  const ranges = [...text.matchAll(new RegExp(`${number}\\s*-\\s*${number}`, "g"))];
  const parse = (digits: string, unit: string) => Number(digits.replaceAll(",", "")) * (unit === "万" || unit === "w" ? 10000 : unit === "千" || unit === "k" ? 1000 : 1);
  if (ranges.length === 1) {
    const match = ranges[0]!; const min = parse(match[1]!, match[2] || match[4]!); const max = parse(match[3]!, match[4] || match[2]!);
    return min <= max ? { min, max } : undefined;
  }
  if (ranges.length) return undefined;
  const amount = new RegExp(`(?:薪资|工资|底薪|月薪|年薪|日薪|时薪|周薪|salary|pay|wage)(?:\\s*(?:为|是|of|:|：|gross|net|base|fixed|cny|rmb|usd|eur|gbp|人民币|美元|[¥￥$€£]))*\\s*${number}`, "g");
  const matches = [...text.matchAll(amount)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!; const value = parse(match[1]!, match[2]!);
  if (/至少|不低于|\bat least\b|\bfrom\b/.test(text)) return { min: value };
  if (/最高|最多|不高于|\bup to\b|\bmaximum\b/.test(text)) return { max: value };
  return { min: value, max: value };
}
