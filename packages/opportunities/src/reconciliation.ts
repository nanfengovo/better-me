import { z } from "zod";
import { AtlasDatasetSchema, EntityIdSchema, EvidenceRefSchema, HttpUrlSchema, TimestampSchema, type AtlasDataset, type CanonicalJob } from "./schema.js";
import { deriveEntityId, normalizeSourceUrl } from "./identity.js";

export const OfficialRequisitionLinkSchema = z.object({
  listingId: EntityIdSchema, namespace: HttpUrlSchema, value: z.string().trim().min(1).max(500),
  verification: z.literal("verified"), evidence: z.array(EvidenceRefSchema).min(1).max(100),
}).strict();
export type OfficialRequisitionLink = z.infer<typeof OfficialRequisitionLinkSchema>;
export const MergeSignalSchema = z.object({
  kind: z.enum(["same-application-url", "same-official-requisition", "same-company-id", "same-employer-name", "same-title", "same-verified-legal-entity"]),
  strength: z.enum(["strong", "weak"]), value: z.string().min(1).max(4096),
  listingIds: z.array(EntityIdSchema).max(2000), evidence: z.array(EvidenceRefSchema).max(200),
}).strict();
export type MergeSignal = z.infer<typeof MergeSignalSchema>;
export const MergeConflictSchema = z.object({
  field: z.enum(["companyId", "title", "description", "selectedSnapshotId", "status", "workMode", "employmentType", "roleFamily", "seniority", "locationIds", "compensationIds", "remoteEligibleRegions"]),
  variants: z.array(z.object({ jobId: EntityIdSchema, listingIds: z.array(EntityIdSchema).max(1000), preview: z.string().max(1000) }).strict()).min(2).max(1000),
}).strict();
export type MergeConflict = z.infer<typeof MergeConflictSchema>;
export const MergeCandidateSchema = z.object({
  schemaVersion: z.literal(1), id: EntityIdSchema, leftJobId: EntityIdSchema, rightJobId: EntityIdSchema,
  snapshotRevision: z.number().int().nonnegative(), strong: z.boolean(), requiresCompanyConfirmation: z.boolean(),
  signals: z.array(MergeSignalSchema).max(100), conflicts: z.array(MergeConflictSchema).max(12),
}).strict();
export type MergeCandidate = z.infer<typeof MergeCandidateSchema>;
const metadata = {
  id: EntityIdSchema, actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  at: TimestampSchema, revision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000),
};
export const MergeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...metadata, kind: z.literal("merge"), targetJobId: EntityIdSchema, sourceJobId: EntityIdSchema,
    companyIdentityConfirmed: z.boolean(), candidate: MergeCandidateSchema }).strict(),
  z.object({ ...metadata, kind: z.literal("reject"), leftJobId: EntityIdSchema, rightJobId: EntityIdSchema, candidate: MergeCandidateSchema }).strict(),
  z.object({ ...metadata, kind: z.literal("revoke"), targetDecisionId: EntityIdSchema }).strict(),
]);
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
export const ConfirmMergeInputSchema = z.object({
  targetJobId: EntityIdSchema, sourceJobId: EntityIdSchema, reason: z.string().trim().min(1).max(2000),
  companyIdentityConfirmed: z.boolean().default(false), requisitionLinks: z.array(OfficialRequisitionLinkSchema).max(100).default([]),
}).strict();
export type ConfirmMergeInput = z.input<typeof ConfirmMergeInputSchema>;
export const RejectMergeInputSchema = z.object({ leftJobId: EntityIdSchema, rightJobId: EntityIdSchema, reason: z.string().trim().min(1).max(2000) }).strict();
export const RevokeMergeInputSchema = z.object({ decisionId: EntityIdSchema, reason: z.string().trim().min(1).max(2000) }).strict();
export const JobAliasEventSchema = z.object({
  jobId: EntityIdSchema, canonicalJobId: EntityIdSchema, revision: z.number().int().nonnegative(), decisionId: EntityIdSchema.optional(), at: TimestampSchema,
}).strict();
export type JobAliasEvent = z.infer<typeof JobAliasEventSchema>;
export const ReconciliationReceiptSchema = z.object({
  ok: z.literal(true), revision: z.number().int().nonnegative(), decision: MergeDecisionSchema,
  aliases: z.array(z.object({ jobId: EntityIdSchema, canonicalJobId: EntityIdSchema }).strict()).max(100_000),
}).strict();
export type ReconciliationReceipt = z.infer<typeof ReconciliationReceiptSchema>;

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const unique = (values: readonly string[]) => [...new Set(values)];
const name = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
/** A shared homepage, careers index, search or generic apply form is not a job identity. */
export function jobSpecificApplicationUrl(value: string): string | undefined {
  const normalized = normalizeSourceUrl(value);
  const url = new URL(normalized);
  const generic = new Set(["", "careers", "career", "jobs", "job", "search", "apply", "application", "index", "index.html", "opportunities", "positions", "join", "join-us"]);
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  const jobQuery = [...url.searchParams].some(([key, value]) => /^(?:job_?id|gh_jid|requisition_?id|req_?id|position_?id|posting_?id)$/i.test(key) && value.trim());
  const route = url.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const specificPath = (parts: string[]) => parts.some((part, index) => /^(?:jobs?|positions?|postings?|requisitions?|openings?|apply)$/.test(part) && parts.slice(index + 1).some((next) => !generic.has(next)))
    || /(?:\d{3,}|[0-9a-f]{8}-[0-9a-f-]{20,})/i.test(parts.at(-1) ?? "");
  if (!jobQuery && !specificPath(segments) && !specificPath(route)) return undefined;
  return normalized;
}
export function collectMergeConflicts(jobs: readonly CanonicalJob[]): MergeConflict[] {
  const fields = ["companyId", "title", "description", "selectedSnapshotId", "status", "workMode", "employmentType", "roleFamily", "seniority", "locationIds", "compensationIds", "remoteEligibleRegions"] as const;
  return fields.flatMap((field) => {
    const value = (job: CanonicalJob): string => {
      if (field === "title") return job.title.value;
      if (field === "roleFamily" || field === "seniority") return job[field]?.value ?? "";
      const raw = job[field]; return Array.isArray(raw) ? JSON.stringify(raw) : raw ?? "";
    };
    return new Set(jobs.map(value)).size <= 1 ? [] : [{ field, variants: jobs.map((job) => ({ jobId: job.id, listingIds: [...job.listingIds], preview: value(job).slice(0, 1000) })) }];
  });
}
/** Pure proposal only: strong evidence never silently commits a merge. */
export async function explainMergeCandidate(datasetInput: AtlasDataset, input: {
  leftJobId: string; rightJobId: string; requisitionLinks?: readonly OfficialRequisitionLink[];
}): Promise<MergeCandidate> {
  const dataset = AtlasDatasetSchema.parse(datasetInput);
  const left = dataset.jobs.find((job) => job.id === input.leftJobId);
  const right = dataset.jobs.find((job) => job.id === input.rightJobId);
  if (!left || !right || left.id === right.id) throw new TypeError("Merge candidates require two distinct existing jobs.");
  const ids = [left.id, right.id].sort(compare);
  const listings = dataset.listings.filter((listing) => left.listingIds.includes(listing.id) || right.listingIds.includes(listing.id));
  const signals: MergeSignal[] = [];
  const add = (kind: MergeSignal["kind"], value: string, listingIds: string[] = [], evidence: MergeSignal["evidence"] = []) => signals.push({ kind, strength: kind === "same-application-url" || kind === "same-official-requisition" ? "strong" : "weak", value, listingIds: unique(listingIds), evidence });
  for (const a of listings.filter((listing) => left.listingIds.includes(listing.id))) for (const b of listings.filter((listing) => right.listingIds.includes(listing.id))) {
    if (a.sourceId === b.sourceId) continue;
    const aUrl = a.applicationUrl ? jobSpecificApplicationUrl(a.applicationUrl) : undefined;
    const bUrl = b.applicationUrl ? jobSpecificApplicationUrl(b.applicationUrl) : undefined;
    if (aUrl && aUrl === bUrl && !signals.some((signal) => signal.kind === "same-application-url" && signal.value === aUrl)) add("same-application-url", aUrl, [a.id, b.id]);
  }
  const links = (input.requisitionLinks ?? []).map((link) => OfficialRequisitionLinkSchema.parse(link));
  for (const link of links) {
    if (!dataset.listings.some((listing) => listing.id === link.listingId) || link.evidence.some((evidence) => !dataset.observations.some((observation) => observation.id === evidence.observationId && observation.listingId === link.listingId))) throw new TypeError("Requisition evidence must refer to its existing source observation.");
  }
  for (const a of links.filter((link) => left.listingIds.includes(link.listingId))) for (const b of links.filter((link) => right.listingIds.includes(link.listingId))) {
    const aListing = listings.find((listing) => listing.id === a.listingId)!; const bListing = listings.find((listing) => listing.id === b.listingId)!;
    if (aListing.sourceId !== bListing.sourceId && normalizeSourceUrl(a.namespace) === normalizeSourceUrl(b.namespace) && a.value === b.value) add("same-official-requisition", `${normalizeSourceUrl(a.namespace)} :: ${a.value}`, [a.listingId, b.listingId], [...a.evidence, ...b.evidence].slice(0, 200));
  }
  const leftCompany = dataset.companies.find((company) => company.id === left.companyId)!;
  const rightCompany = dataset.companies.find((company) => company.id === right.companyId)!;
  if (left.companyId === right.companyId) add("same-company-id", left.companyId);
  else if (leftCompany.names.some((a) => rightCompany.names.some((b) => name(a) === name(b)))) add("same-employer-name", leftCompany.names[0]!);
  const legalIdentity = leftCompany.legalEntity?.verification === "verified" && rightCompany.legalEntity?.verification === "verified" && name(leftCompany.legalEntity.value) === name(rightCompany.legalEntity.value);
  if (legalIdentity) add("same-verified-legal-entity", leftCompany.legalEntity!.value, [], [...leftCompany.legalEntity!.evidence, ...rightCompany.legalEntity!.evidence].slice(0, 200));
  if (name(left.title.value) === name(right.title.value)) add("same-title", left.title.value);
  return MergeCandidateSchema.parse({ schemaVersion: 1, id: await deriveEntityId("merge-candidate", ids), leftJobId: ids[0], rightJobId: ids[1], snapshotRevision: dataset.revision,
    strong: signals.some((signal) => signal.strength === "strong"), requiresCompanyConfirmation: left.companyId !== right.companyId && !legalIdentity, signals, conflicts: collectMergeConflicts([left, right]) });
}

export async function findMergeCandidates(dataset: AtlasDataset, options: { limit?: number; requisitionLinks?: readonly OfficialRequisitionLink[] } = {}): Promise<MergeCandidate[]> {
  const parsed = AtlasDatasetSchema.parse(dataset); const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Candidate limit must be 1-1000.");
  const pairs = new Set<string>(); const groups = new Map<string, Set<string>>();
  const add = (key: string, jobId: string) => { const group = groups.get(key) ?? new Set<string>(); group.add(jobId); groups.set(key, group); };
  for (const job of parsed.jobs) {
    const company = parsed.companies.find((company) => company.id === job.companyId)!;
    for (const companyName of company.names) add(`weak:${JSON.stringify([name(companyName), name(job.title.value)])}`, job.id);
    for (const listing of parsed.listings.filter((listing) => job.listingIds.includes(listing.id))) {
      if (listing.applicationUrl) { const url = jobSpecificApplicationUrl(listing.applicationUrl); if (url) add(`url:${url}`, job.id); }
    }
  }
  for (const input of options.requisitionLinks ?? []) {
    const link = OfficialRequisitionLinkSchema.parse(input); const job = parsed.jobs.find((job) => job.listingIds.includes(link.listingId));
    if (job) add(`req:${JSON.stringify([normalizeSourceUrl(link.namespace), link.value])}`, job.id);
  }
  for (const group of groups.values()) {
    const ids = [...group].sort(compare);
    for (let a = 0; a < ids.length && pairs.size < limit * 10; a++) for (let b = a + 1; b < ids.length && pairs.size < limit * 10; b++) pairs.add(JSON.stringify([ids[a], ids[b]]));
  }
  const candidates: MergeCandidate[] = [];
  for (const pair of pairs) {
    const [leftJobId, rightJobId] = JSON.parse(pair) as [string, string];
    const candidate = await explainMergeCandidate(parsed, { leftJobId, rightJobId, requisitionLinks: options.requisitionLinks });
    if (candidate.signals.some((signal) => signal.kind !== "same-title")) candidates.push(candidate);
  }
  return candidates.sort((a, b) => Number(b.strong) - Number(a.strong) || compare(a.id, b.id)).slice(0, limit);
}

/** Reversible edges operate on stable origin IDs; every scalar summary has an explicit origin. */
export function projectReconciliation(baseInput: AtlasDataset, decisionsInput: readonly MergeDecision[]) {
  const base = AtlasDatasetSchema.parse(baseInput); const decisions = decisionsInput.map((decision) => MergeDecisionSchema.parse(decision));
  const revoked = new Set(decisions.filter((decision) => decision.kind === "revoke").map((decision) => decision.targetDecisionId));
  const merges = decisions.filter((decision): decision is Extract<MergeDecision, { kind: "merge" }> => decision.kind === "merge" && !revoked.has(decision.id)).sort((a, b) => a.revision - b.revision);
  const parent = new Map(base.jobs.map((job) => [job.id, job.id]));
  const root = (id: string): string => { const p = parent.get(id); if (!p) throw new TypeError("Merge refers to a missing origin job."); if (p === id) return id; const r = root(p); parent.set(id, r); return r; };
  for (const merge of merges) { const target = root(merge.targetJobId); const source = root(merge.sourceJobId); if (target !== source) parent.set(source, target); }
  const grouped = new Map<string, CanonicalJob[]>();
  for (const job of base.jobs) { const id = root(job.id); const group = grouped.get(id) ?? []; group.push(job); grouped.set(id, group); }
  const aliases: Array<{ jobId: string; canonicalJobId: string }> = [];
  const conflicts: Array<{ canonicalJobId: string; summaryJobId: string; conflicts: MergeConflict[]; decisionIds: string[] }> = [];
  const jobs: CanonicalJob[] = [];
  for (const group of grouped.values()) {
    const ids = new Set(group.map((job) => job.id)); const relevant = merges.filter((merge) => ids.has(merge.targetJobId) && ids.has(merge.sourceJobId));
    const summaryId = relevant.at(-1)?.targetJobId ?? group[0]!.id;
    const summary = group.find((job) => job.id === summaryId)!;
    const ordered = [summary, ...group.filter((job) => job.id !== summaryId).sort((a, b) => compare(a.id, b.id))];
    jobs.push({ ...summary, listingIds: unique(ordered.flatMap((job) => job.listingIds)), locationIds: unique(ordered.flatMap((job) => job.locationIds)), compensationIds: unique(ordered.flatMap((job) => job.compensationIds)), remoteEligibleRegions: unique(ordered.flatMap((job) => job.remoteEligibleRegions)) });
    for (const job of group) aliases.push({ jobId: job.id, canonicalJobId: summaryId });
    if (group.length > 1) conflicts.push({ canonicalJobId: summaryId, summaryJobId: summaryId, conflicts: collectMergeConflicts(group), decisionIds: relevant.map((decision) => decision.id) });
  }
  const owner = new Map(aliases.map((alias) => [alias.jobId, alias.canonicalJobId]));
  const dataset = AtlasDatasetSchema.parse({ ...base, jobs: jobs.sort((a, b) => compare(a.id, b.id)), listings: base.listings.map((listing) => ({ ...listing, ...(listing.canonicalJobId ? { canonicalJobId: owner.get(listing.canonicalJobId)! } : {}) })) });
  return { dataset, aliases: aliases.sort((a, b) => compare(a.jobId, b.jobId)), conflicts };
}
