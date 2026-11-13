import { z } from "zod";
import {
  IntelligenceAuthorizationSchema, IntelligenceBindingSchema, IntelligenceHashSchema, IntelligenceIdSchema,
  IntelligenceSalarySchema, IntelligenceSourceSchema, IntelligenceInputError, ageDays, assertSources,
  assertUniqueIds, intelligenceHash, intelligenceIsCurrent, type IntelligenceAccessOptions, type IntelligenceSource,
} from "./snapshots.js";

export const JobForensicsObservationSchema = z.object({
  id: IntelligenceIdSchema, revision: IntelligenceIdSchema, platform: IntelligenceIdSchema, platformJobId: IntelligenceIdSchema,
  sourceId: IntelligenceIdSchema, title: z.string().min(1).max(1000), companyId: IntelligenceIdSchema.nullable(),
  roleKey: IntelligenceIdSchema.nullable(), locationKey: IntelligenceIdSchema.nullable(), departmentKey: IntelligenceIdSchema.nullable(),
  availability: z.enum(["active", "closed", "unknown"]), observedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(), firstSeenAt: z.string().datetime().nullable(), lastSeenAt: z.string().datetime().nullable(),
  refreshTimes: z.array(z.string().datetime()).max(1000), salary: IntelligenceSalarySchema,
  declaredSkillIds: z.array(IntelligenceIdSchema).max(200),
}).strict();
export type JobForensicsObservation = z.infer<typeof JobForensicsObservationSchema>;
export const PublicTechnicalObservationSchema = z.object({
  id: IntelligenceIdSchema, companyId: IntelligenceIdSchema, departmentKey: IntelligenceIdSchema.nullable(),
  sourceId: IntelligenceIdSchema, observedAt: z.string().datetime(), skillIds: z.array(IntelligenceIdSchema).max(200),
  scope: z.enum(["company", "department", "team"]), activity: z.enum(["observed", "not_observed", "unknown"]),
}).strict();
export const JobForensicsRulesSchema = z.object({
  version: IntelligenceIdSchema, longLivedDays: z.number().finite().positive().max(3650),
  refreshWindowDays: z.number().finite().positive().max(3650), frequentRefreshCount: z.number().int().min(2).max(1000),
  wideSalaryRatio: z.number().finite().min(1).max(100), maxSourceAgeDays: z.number().finite().positive().max(3650),
}).strict();
export const JobForensicsSnapshotSchema = z.object({
  schemaVersion: z.literal(1), binding: IntelligenceBindingSchema,
  authorization: IntelligenceAuthorizationSchema.extend({ purpose: z.literal("job_forensics") }).strict(),
  asOf: z.string().datetime(), sources: z.array(IntelligenceSourceSchema).max(2000),
  observations: z.array(JobForensicsObservationSchema).max(2000), publicTechnicalObservations: z.array(PublicTechnicalObservationSchema).max(2000),
  rules: JobForensicsRulesSchema, fingerprint: IntelligenceHashSchema,
}).strict();
export type JobForensicsSnapshot = z.infer<typeof JobForensicsSnapshotSchema>;
export type JobForensicsSignalCode = "long_observed_listing" | "frequent_refresh" | "wide_salary_range" | "salary_conflict"
  | "availability_conflict" | "public_stack_not_corroborated" | "observation_stale" | "observation_time_conflict";
export type JobForensicsSignal = { code: JobForensicsSignalCode; strength: "low" | "medium"; observationIds: string[];
  sourceRefs: IntelligenceSource[]; summary: string; uncertainty: string[] };
export const ForensicsMergeProposalSchema = z.object({
  schemaVersion: z.literal(1), id: IntelligenceIdSchema, snapshotFingerprint: IntelligenceHashSchema,
  memberObservationIds: z.array(IntelligenceIdSchema).min(2).max(2000),
  matchingKeys: z.object({ companyId: IntelligenceIdSchema, roleKey: IntelligenceIdSchema, locationKey: IntelligenceIdSchema }).strict(),
  status: z.literal("pending_review"),
}).strict();
export type ForensicsMergeProposal = z.infer<typeof ForensicsMergeProposalSchema>;
export type JobForensicsReport = { schemaVersion: 1; snapshotFingerprint: string; status: "completed" | "stale";
  signals: JobForensicsSignal[]; mergeProposals: ForensicsMergeProposal[]; unknowns: string[]; limitations: string[] };

export async function createJobForensicsSnapshot(input: Omit<JobForensicsSnapshot, "schemaVersion" | "fingerprint">): Promise<JobForensicsSnapshot> {
  const unsigned = { ...input, schemaVersion: 1 as const };
  return validateJobForensicsSnapshot({ ...unsigned, fingerprint: await intelligenceHash(unsigned) });
}
export async function validateJobForensicsSnapshot(input: unknown): Promise<JobForensicsSnapshot> {
  const snapshot = JobForensicsSnapshotSchema.parse(input);
  if (JSON.stringify(snapshot).length > 4_000_000) throw new IntelligenceInputError("snapshot_size_exceeded");
  const { fingerprint, ...unsigned } = snapshot;
  if (fingerprint !== await intelligenceHash(unsigned)) throw new IntelligenceInputError("snapshot_fingerprint_changed");
  assertUniqueIds(snapshot.sources.map(item => item.id), "duplicate_source_id");
  assertUniqueIds(snapshot.observations.map(item => item.id), "duplicate_observation_id");
  assertUniqueIds(snapshot.publicTechnicalObservations.map(item => item.id), "duplicate_public_observation_id");
  assertUniqueIds(snapshot.authorization.sourceIds, "duplicate_granted_source_id");
  assertSources(snapshot.authorization.sourceIds, snapshot.sources, snapshot.authorization.sourceIds);
  assertSources([...snapshot.observations.map(item => item.sourceId), ...snapshot.publicTechnicalObservations.map(item => item.sourceId)], snapshot.sources, snapshot.authorization.sourceIds);
  if (snapshot.rules.version !== snapshot.binding.rulesVersion) throw new IntelligenceInputError("rules_version_mismatch");
  for (const observation of snapshot.observations) if (observation.salary.status === "comparable") {
    assertSources([observation.salary.sourceId], snapshot.sources, snapshot.authorization.sourceIds);
    if (observation.salary.sourceId !== observation.sourceId) throw new IntelligenceInputError("salary_source_not_bound_to_observation");
  }
  return snapshot;
}
function groupingKey(observation: JobForensicsObservation): string | undefined {
  return observation.companyId && observation.roleKey && observation.locationKey
    ? JSON.stringify([observation.companyId, observation.roleKey, observation.locationKey]) : undefined;
}

/** Observations are not a verdict about company motives, recruiting intent or the actual day-to-day role. */
export async function analyzeJobForensics(input: unknown, options: IntelligenceAccessOptions<JobForensicsSnapshot>): Promise<JobForensicsReport> {
  const snapshot = await validateJobForensicsSnapshot(input);
  const limitations = ["Signals describe the selected timestamped observations, not proof of a ghost job, HR KPI behavior or fraudulent intent.",
    "Public repository/blog absence cannot establish what a team works on; company-level material is not department-level proof.",
    "Salary, availability, work hours and legal compliance remain unknown unless the selected sources actually disclose them.",
    "Merge proposals do not mutate opportunity records. The original observations and their source hashes remain separately recoverable."];
  if (!await intelligenceIsCurrent(snapshot, options)) return { schemaVersion: 1, snapshotFingerprint: snapshot.fingerprint, status: "stale", signals: [], mergeProposals: [], unknowns: ["authorization_or_input_changed"], limitations };
  const signals: JobForensicsSignal[] = [], unknowns: string[] = [], groups = new Map<string, JobForensicsObservation[]>();
  const source = (id: string) => snapshot.sources.find(item => item.id === id)!;
  const fresh = (id: string, time: string) => {
    const sourceAge = ageDays(source(id).capturedAt, snapshot.asOf), observedAge = ageDays(time, snapshot.asOf);
    return sourceAge !== undefined && observedAge !== undefined && sourceAge <= snapshot.rules.maxSourceAgeDays && observedAge <= snapshot.rules.maxSourceAgeDays;
  };
  const add = (code: JobForensicsSignalCode, members: JobForensicsObservation[], summary: string, uncertainty: string[], extraSources: string[] = [], strength: "low" | "medium" = "low") => {
    const refs = [...new Set([...members.map(member => member.sourceId), ...extraSources])].map(id => source(id));
    signals.push({ code, strength, observationIds: members.map(member => member.id), sourceRefs: refs, summary, uncertainty });
  };
  for (const observation of snapshot.observations) {
    const key = groupingKey(observation);
    if (key) groups.set(key, [...(groups.get(key) ?? []), observation]);
    else unknowns.push(`unresolved_job_binding:${observation.id}`);
    if (!fresh(observation.sourceId, observation.observedAt)) add("observation_stale", [observation], "The observation or its source is stale or future-dated at this frozen analysis time.", ["A stale/read-failed observation does not establish that a job is closed."]);
    const times = [observation.publishedAt, observation.firstSeenAt, observation.lastSeenAt, ...observation.refreshTimes].filter((value): value is string => value !== null);
    const chronologyConflict = times.some(time => Date.parse(time) > Date.parse(observation.observedAt))
      || (observation.firstSeenAt !== null && observation.lastSeenAt !== null && Date.parse(observation.firstSeenAt) > Date.parse(observation.lastSeenAt));
    if (chronologyConflict) add("observation_time_conflict", [observation], "The selected observation contains conflicting/future history timestamps.", ["History-derived duration and refresh signals are withheld for this observation."]);
    if (!chronologyConflict && observation.firstSeenAt && observation.lastSeenAt) {
      const duration = ageDays(observation.firstSeenAt, observation.lastSeenAt);
      if (duration !== undefined && duration >= snapshot.rules.longLivedDays) add("long_observed_listing", [observation], `The listing was observed across ${Math.floor(duration)} days.`, ["Continuous hiring, reposting and collection-only intent are alternative explanations; no motive is determined."]);
    } else if (!observation.firstSeenAt || !observation.lastSeenAt) unknowns.push(`listing_duration_unknown:${observation.id}`);
    const refreshes = [...new Set(observation.refreshTimes)].filter(time => {
      const age = ageDays(time, snapshot.asOf); return age !== undefined && age <= snapshot.rules.refreshWindowDays;
    });
    if (!chronologyConflict && refreshes.length >= snapshot.rules.frequentRefreshCount) add("frequent_refresh", [observation], `${refreshes.length} distinct refresh observations fall inside the frozen refresh window.`, ["Platform automation, editing and genuine recruiting are not distinguished by this signal."]);
    if (observation.salary.status === "comparable") {
      if (observation.salary.min > 0 && observation.salary.max / observation.salary.min >= snapshot.rules.wideSalaryRatio)
        add("wide_salary_range", [observation], "The disclosed comparable base-salary range exceeds the configured width ratio.", ["Different levels, locations, bonuses or transcription errors may explain a wide range."]);
    } else unknowns.push(`salary_unknown:${observation.id}`);
    if (observation.availability === "unknown") unknowns.push(`availability_unknown:${observation.id}`);
    const publicObservations = snapshot.publicTechnicalObservations.filter(item => item.companyId === observation.companyId && item.activity === "observed"
      && fresh(item.sourceId, item.observedAt) && (!item.departmentKey || item.departmentKey === observation.departmentKey));
    if (!publicObservations.length) unknowns.push(`public_technical_evidence_unknown:${observation.id}`);
    else {
      const unseen = observation.declaredSkillIds.filter(skill => !publicObservations.some(item => item.skillIds.includes(skill)));
      if (unseen.length) add("public_stack_not_corroborated", [observation], `Selected public observations do not corroborate declared skill IDs: ${unseen.join(", ")}.`,
        ["Non-corroboration is not contradiction or proof that the actual job is CRUD work.", ...(publicObservations.some(item => item.scope === "company") ? ["Some evidence is company-wide and cannot establish this department's stack."] : [])], publicObservations.map(item => item.sourceId));
    }
  }
  const mergeProposals: ForensicsMergeProposal[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const first = members[0]!;
    const memberObservationIds = members.map(item => item.id).sort();
    mergeProposals.push({ schemaVersion: 1, id: `merge-${(await intelligenceHash(memberObservationIds)).slice(0, 24)}`, snapshotFingerprint: snapshot.fingerprint,
      memberObservationIds, matchingKeys: { companyId: first.companyId!, roleKey: first.roleKey!, locationKey: first.locationKey! }, status: "pending_review" });
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const a = members[left]!, b = members[right]!;
      if (a.availability !== "unknown" && b.availability !== "unknown" && a.availability !== b.availability)
        add("availability_conflict", [a, b], "Selected sources disagree about availability.", ["Different capture times or platform lag may explain the disagreement; current availability is unresolved."], [], "medium");
      const x = a.salary, y = b.salary;
      if (x.status === "comparable" && y.status === "comparable" && x.currency === y.currency && (x.max < y.min || y.max < x.min))
        add("salary_conflict", [a, b], "Comparable same-currency annual gross base-salary intervals do not overlap.", ["Conflict is retained; neither platform is silently selected as the truth."], [], "medium");
      else if (x.status === "comparable" && y.status === "comparable" && x.currency !== y.currency) unknowns.push(`salary_currency_incomparable:${a.id}:${b.id}`);
    }
  }
  if (!await intelligenceIsCurrent(snapshot, options)) return { schemaVersion: 1, snapshotFingerprint: snapshot.fingerprint, status: "stale", signals: [], mergeProposals: [], unknowns: ["authorization_or_input_changed"], limitations };
  return { schemaVersion: 1, snapshotFingerprint: snapshot.fingerprint, status: "completed", signals, mergeProposals, unknowns: [...new Set(unknowns)], limitations };
}

const GroupSchema = z.object({ id: IntelligenceIdSchema, memberObservationIds: z.array(IntelligenceIdSchema).min(1).max(2000) }).strict();
const HistorySchema = z.object({ decisionId: IntelligenceIdSchema, operation: z.enum(["merge", "restore"]), payloadHash: IntelligenceHashSchema,
  before: z.array(GroupSchema).min(1).max(2000), after: z.array(GroupSchema).min(1).max(2000), targetDecisionId: IntelligenceIdSchema.optional(),
}).strict();
export const ForensicsReconciliationStateSchema = z.object({ schemaVersion: z.literal(1), snapshotFingerprint: IntelligenceHashSchema,
  revision: z.number().int().nonnegative(), observationIds: z.array(IntelligenceIdSchema).max(2000),
  groups: z.array(GroupSchema).max(2000), history: z.array(HistorySchema).max(2000),
}).strict();
export type ForensicsReconciliationState = z.infer<typeof ForensicsReconciliationStateSchema>;
function parseGrouping(input: unknown): ForensicsReconciliationState {
  const state = ForensicsReconciliationStateSchema.parse(input);
  assertUniqueIds(state.observationIds, "duplicate_observation_id");
  assertUniqueIds(state.groups.map(group => group.id), "duplicate_group_id");
  assertUniqueIds(state.history.map(entry => entry.decisionId), "duplicate_decision_id");
  const members = state.groups.flatMap(group => group.memberObservationIds);
  assertUniqueIds(members, "observation_in_multiple_groups");
  if (members.length !== state.observationIds.length || members.some(id => !state.observationIds.includes(id))) throw new IntelligenceInputError("grouping_drops_original_observation");
  if (state.revision !== state.history.length) throw new IntelligenceInputError("grouping_revision_mismatch");
  return state;
}
export async function createForensicsReconciliationState(input: unknown): Promise<ForensicsReconciliationState> {
  const snapshot = await validateJobForensicsSnapshot(input);
  const groups = await Promise.all(snapshot.observations.map(async item => ({ id: `observation-${(await intelligenceHash(item.id)).slice(0, 24)}`, memberObservationIds: [item.id] })));
  return { schemaVersion: 1, snapshotFingerprint: snapshot.fingerprint, revision: 0,
    observationIds: snapshot.observations.map(item => item.id), groups, history: [] };
}
const ConfirmationSchema = z.object({ expectedRevision: z.number().int().nonnegative(), decisionId: IntelligenceIdSchema, confirmed: z.literal(true) }).strict();

/** Only updates a read-model grouping sidecar; never a business merge or source deletion. */
export async function applyForensicsMerge(input: unknown, proposalInput: unknown, confirmationInput: unknown): Promise<ForensicsReconciliationState> {
  const state = parseGrouping(input), proposal = ForensicsMergeProposalSchema.parse(proposalInput), confirmation = ConfirmationSchema.parse(confirmationInput);
  assertUniqueIds(proposal.memberObservationIds, "duplicate_merge_member");
  if (proposal.snapshotFingerprint !== state.snapshotFingerprint) throw new IntelligenceInputError("stale_merge_proposal");
  const payloadHash = await intelligenceHash({ operation: "merge", proposal });
  const existing = state.history.find(entry => entry.decisionId === confirmation.decisionId);
  if (existing) { if (existing.payloadHash === payloadHash) return state; throw new IntelligenceInputError("decision_id_reused"); }
  if (state.revision !== confirmation.expectedRevision) throw new IntelligenceInputError("grouping_revision_conflict");
  if (proposal.memberObservationIds.some(id => !state.observationIds.includes(id))) throw new IntelligenceInputError("unknown_merge_member");
  const before = state.groups.filter(group => group.memberObservationIds.some(id => proposal.memberObservationIds.includes(id)));
  if (before.some(group => group.memberObservationIds.some(id => !proposal.memberObservationIds.includes(id)))) throw new IntelligenceInputError("merge_would_partially_overwrite_group");
  const after = [{ id: proposal.id, memberObservationIds: [...proposal.memberObservationIds] }];
  return parseGrouping({ ...state, revision: state.revision + 1, groups: [...state.groups.filter(group => !before.some(item => item.id === group.id)), ...after],
    history: [...state.history, { decisionId: confirmation.decisionId, operation: "merge", payloadHash, before, after }] });
}
export async function restoreForensicsGrouping(input: unknown, targetDecisionId: string, confirmationInput: unknown): Promise<ForensicsReconciliationState> {
  const state = parseGrouping(input), confirmation = ConfirmationSchema.parse(confirmationInput);
  const payloadHash = await intelligenceHash({ operation: "restore", targetDecisionId });
  const existing = state.history.find(entry => entry.decisionId === confirmation.decisionId);
  if (existing) { if (existing.payloadHash === payloadHash) return state; throw new IntelligenceInputError("decision_id_reused"); }
  if (state.revision !== confirmation.expectedRevision) throw new IntelligenceInputError("grouping_revision_conflict");
  const target = state.history.find(entry => entry.decisionId === targetDecisionId && entry.operation === "merge");
  if (!target) throw new IntelligenceInputError("unknown_merge_decision");
  for (const group of target.after) {
    const current = state.groups.find(item => item.id === group.id);
    if (!current || JSON.stringify(current.memberObservationIds.slice().sort()) !== JSON.stringify(group.memberObservationIds.slice().sort())) throw new IntelligenceInputError("later_grouping_changes_require_review");
  }
  return parseGrouping({ ...state, revision: state.revision + 1, groups: [...state.groups.filter(group => !target.after.some(item => item.id === group.id)), ...target.before],
    history: [...state.history, { decisionId: confirmation.decisionId, operation: "restore", targetDecisionId, payloadHash, before: target.after, after: target.before }] });
}
