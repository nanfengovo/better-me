import { z } from "zod";
import { hashCommitteeText } from "./contracts.js";
import {
  IntelligenceAuthorizationSchema, IntelligenceBindingSchema, IntelligenceHashSchema, IntelligenceIdSchema, IntelligenceSourceSchema,
  IntelligenceInputError, assertSources, assertUniqueIds, intelligenceHash, intelligenceIsCurrent, type IntelligenceAccessOptions,
} from "./snapshots.js";

export const ResumeOutcomeVersionSchema = z.object({
  resumeId: IntelligenceIdSchema, versionId: IntelligenceIdSchema, contentHash: IntelligenceHashSchema,
  claims: z.array(z.object({ id: IntelligenceIdSchema, text: z.string().min(1).max(8000), hash: IntelligenceHashSchema }).strict()).max(200),
}).strict();
export const OutcomeEventSchema = z.object({
  id: IntelligenceIdSchema, hash: IntelligenceHashSchema, applicationId: IntelligenceIdSchema,
  resumeVersionId: IntelligenceIdSchema, resumeContentHash: IntelligenceHashSchema, sourceId: IntelligenceIdSchema,
  kind: z.enum(["submitted", "viewed", "interview_invited", "interview_completed", "rejected", "offer", "withdrawn", "no_response", "unknown"]),
  happenedAt: z.string().datetime(), origin: z.enum(["self_report", "platform_receipt"]),
  receiptVerification: z.enum(["unverified", "host_verified"]), platformReceiptId: IntelligenceIdSchema.nullable(),
}).strict().superRefine((event, context) => {
  if (event.origin === "self_report" && (event.receiptVerification !== "unverified" || event.platformReceiptId !== null)) context.addIssue({ code: "custom", message: "A self-report is not independent platform verification." });
  if (event.origin === "platform_receipt" && event.receiptVerification === "host_verified" && !event.platformReceiptId) context.addIssue({ code: "custom", message: "Host-verified platform evidence needs its platform receipt reference." });
});
export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;
export const InterviewFeedbackNoteSchema = z.object({
  id: IntelligenceIdSchema, sourceId: IntelligenceIdSchema, kind: z.enum(["note", "audio_transcript"]),
  resumeVersionId: IntelligenceIdSchema, resumeContentHash: IntelligenceHashSchema, applicationId: IntelligenceIdSchema.nullable(),
  happenedAt: z.string().datetime(), text: z.string().min(1).max(64000), transcriptHash: IntelligenceHashSchema,
  verification: z.enum(["unverified_transcript", "user_reviewed"]),
  originalAudioSourceId: IntelligenceIdSchema.nullable(), originalAudioSha256: IntelligenceHashSchema.nullable(),
  originalAudioDurationMs: z.number().int().positive().max(86_400_000).nullable(), timestampCorrectionMs: z.number().int().min(-3_600_000).max(3_600_000),
  segments: z.array(z.object({ id: IntelligenceIdSchema, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
    text: z.string().min(1).max(8000), hash: IntelligenceHashSchema }).strict()).min(1).max(500),
  claimLinks: z.array(z.object({ segmentId: IntelligenceIdSchema, claimId: IntelligenceIdSchema, claimHash: IntelligenceHashSchema,
    confirmedByUser: z.boolean(), kind: z.enum(["questioned", "clarify", "positive"]), topic: z.enum(["contribution", "metrics", "architecture", "clarity"]),
  }).strict()).max(500),
}).strict().superRefine((note, context) => {
  if (note.kind === "audio_transcript" && (!note.originalAudioSourceId || !note.originalAudioSha256)) context.addIssue({ code: "custom", message: "An audio transcript must retain original audio SHA and source, even when STT is not verified." });
  if (note.kind === "note" && (note.originalAudioSourceId !== null || note.originalAudioSha256 !== null || note.originalAudioDurationMs !== null)) context.addIssue({ code: "custom", message: "A text note cannot invent an audio source." });
  if (note.segments.some(segment => segment.endMs < segment.startMs || !note.text.includes(segment.text))) context.addIssue({ code: "custom", message: "Segments must retain exact source text and ordered time bounds." });
});
export type InterviewFeedbackNote = z.infer<typeof InterviewFeedbackNoteSchema>;
export const OutcomeFeedbackSnapshotSchema = z.object({
  schemaVersion: z.literal(1), binding: IntelligenceBindingSchema,
  authorization: IntelligenceAuthorizationSchema.extend({ purpose: z.literal("outcome_feedback") }).strict(),
  asOf: z.string().datetime(), sources: z.array(IntelligenceSourceSchema).max(2000), resumes: z.array(ResumeOutcomeVersionSchema).max(200),
  events: z.array(OutcomeEventSchema).max(5000), notes: z.array(InterviewFeedbackNoteSchema).max(200), fingerprint: IntelligenceHashSchema,
}).strict();
export type OutcomeFeedbackSnapshot = z.infer<typeof OutcomeFeedbackSnapshotSchema>;
export const PERSONAL_RULE_TEXT = {
  clarify_contribution: "涉及本人贡献的表述，先确认实现、设计、非本人和不确定的边界，再组织叙事。",
  require_numeric_evidence: "量化表述必须保留来源、测试条件和自报或独立测评的区别；缺失时保留未知。",
  explain_architecture_constraints: "描述架构决策时同时列出约束、备选方案、失败边界和可定位的证据，不把设计写成已上线。",
  improve_claim_clarity: "优先使每条表述的责任、行动和已知结果易于追问；压缩或排序不得新增经历和成果。",
} as const;
export const PersonalRuleCodeSchema = z.enum(["clarify_contribution", "require_numeric_evidence", "explain_architecture_constraints", "improve_claim_clarity"]);
export type PersonalRuleCode = z.infer<typeof PersonalRuleCodeSchema>;
const topicRule: Record<InterviewFeedbackNote["claimLinks"][number]["topic"], PersonalRuleCode> = {
  contribution: "clarify_contribution", metrics: "require_numeric_evidence", architecture: "explain_architecture_constraints", clarity: "improve_claim_clarity",
};
export type EvolutionPatch = { schemaVersion: 1; id: string; snapshotFingerprint: string; resumeVersionId: string; resumeContentHash: string;
  claimId: string; claimHash: string; status: "pending_review"; operation: "request_clarification"; question: string; suggestedRuleCode: PersonalRuleCode;
  source: { noteId: string; sourceId: string; transcriptHash: string; segmentId: string; segmentHash: string; originalStartMs: number; originalEndMs: number;
    correctedStartMs: number | null; correctedEndMs: number | null; originalAudioSha256: string | null; transcriptionVerification: InterviewFeedbackNote["verification"] } };
export const EvolutionPatchSchema = z.object({ schemaVersion: z.literal(1), id: IntelligenceIdSchema, snapshotFingerprint: IntelligenceHashSchema,
  resumeVersionId: IntelligenceIdSchema, resumeContentHash: IntelligenceHashSchema, claimId: IntelligenceIdSchema, claimHash: IntelligenceHashSchema,
  status: z.literal("pending_review"), operation: z.literal("request_clarification"), question: z.string().min(1).max(4000), suggestedRuleCode: PersonalRuleCodeSchema,
  source: z.object({ noteId: IntelligenceIdSchema, sourceId: IntelligenceIdSchema, transcriptHash: IntelligenceHashSchema,
    segmentId: IntelligenceIdSchema, segmentHash: IntelligenceHashSchema, originalStartMs: z.number().int().nonnegative(), originalEndMs: z.number().int().nonnegative(),
    correctedStartMs: z.number().int().nonnegative().nullable(), correctedEndMs: z.number().int().nonnegative().nullable(), originalAudioSha256: IntelligenceHashSchema.nullable(),
    transcriptionVerification: z.enum(["unverified_transcript", "user_reviewed"]),
  }).strict(),
}).strict();
export type OutcomeFeedbackReport = { schemaVersion: 1; binding: OutcomeFeedbackSnapshot["binding"]; snapshotFingerprint: string; status: "completed" | "stale";
  versions: Array<{ versionId: string; contentHash: string; observedSubmissions: number; observedInvitationApplications: number; observedOfferApplications: number;
    unknownOutcomeApplications: number; invitationFractionAmongObservedSubmissions: number | null;
    origins: { selfReportedEvents: number; unverifiedPlatformEvents: number; hostVerifiedPlatformEvents: number } }>;
  evolutionPatches: EvolutionPatch[]; unknowns: string[]; limitations: string[] };
export const OutcomeFeedbackReportSchema = z.object({ schemaVersion: z.literal(1), binding: IntelligenceBindingSchema,
  snapshotFingerprint: IntelligenceHashSchema, status: z.enum(["completed", "stale"]),
  versions: z.array(z.object({ versionId: IntelligenceIdSchema, contentHash: IntelligenceHashSchema,
    observedSubmissions: z.number().int().nonnegative(), observedInvitationApplications: z.number().int().nonnegative(), observedOfferApplications: z.number().int().nonnegative(),
    unknownOutcomeApplications: z.number().int().nonnegative(), invitationFractionAmongObservedSubmissions: z.number().min(0).max(1).nullable(),
    origins: z.object({ selfReportedEvents: z.number().int().nonnegative(), unverifiedPlatformEvents: z.number().int().nonnegative(), hostVerifiedPlatformEvents: z.number().int().nonnegative() }).strict(),
  }).strict()).max(200), evolutionPatches: z.array(EvolutionPatchSchema).max(2000), unknowns: z.array(z.string().max(4000)).max(10000), limitations: z.array(z.string().max(4000)).max(100),
}).strict();

export const OutcomeFeedbackSnapshotInputSchema = OutcomeFeedbackSnapshotSchema.omit({ schemaVersion: true, fingerprint: true, events: true, notes: true, resumes: true }).extend({
  resumes: z.array(ResumeOutcomeVersionSchema.omit({ claims: true }).extend({ claims: z.array(ResumeOutcomeVersionSchema.shape.claims.element.omit({ hash: true })).max(200) })).max(200),
  events: z.array(OutcomeEventSchema.innerType().omit({ hash: true })).max(5000),
  notes: z.array(InterviewFeedbackNoteSchema.innerType().omit({ transcriptHash: true, segments: true }).extend({
    segments: z.array(InterviewFeedbackNoteSchema.innerType().shape.segments.element.omit({ hash: true })).min(1).max(500),
  })).max(200),
}).strict();
export type OutcomeFeedbackSnapshotInput = Omit<OutcomeFeedbackSnapshot, "schemaVersion" | "fingerprint" | "events" | "notes" | "resumes"> & {
  resumes: Array<Omit<OutcomeFeedbackSnapshot["resumes"][number], "claims"> & { claims: Array<Omit<OutcomeFeedbackSnapshot["resumes"][number]["claims"][number], "hash">> }>;
  events: Array<Omit<OutcomeEvent, "hash">>;
  notes: Array<Omit<InterviewFeedbackNote, "transcriptHash" | "segments"> & { segments: Array<Omit<InterviewFeedbackNote["segments"][number], "hash">> }>;
};
export async function createOutcomeFeedbackSnapshot(input: OutcomeFeedbackSnapshotInput): Promise<OutcomeFeedbackSnapshot> {
  const resumes = await Promise.all(input.resumes.map(async resume => ({ ...resume, claims: await Promise.all(resume.claims.map(async claim => ({ ...claim, hash: await hashCommitteeText(claim.text) }))) })));
  const events = await Promise.all(input.events.map(async event => ({ ...event, hash: await intelligenceHash(event) })));
  const notes = await Promise.all(input.notes.map(async note => ({ ...note, transcriptHash: await hashCommitteeText(note.text),
    segments: await Promise.all(note.segments.map(async segment => ({ ...segment, hash: await hashCommitteeText(segment.text) }))) })));
  const unsigned = { ...input, resumes, events, notes, schemaVersion: 1 as const };
  return validateOutcomeFeedbackSnapshot({ ...unsigned, fingerprint: await intelligenceHash(unsigned) });
}
export async function validateOutcomeFeedbackSnapshot(input: unknown): Promise<OutcomeFeedbackSnapshot> {
  const snapshot = OutcomeFeedbackSnapshotSchema.parse(input);
  if (JSON.stringify(snapshot).length > 4_000_000) throw new IntelligenceInputError("snapshot_size_exceeded");
  const { fingerprint, ...unsigned } = snapshot;
  if (fingerprint !== await intelligenceHash(unsigned)) throw new IntelligenceInputError("snapshot_fingerprint_changed");
  assertUniqueIds(snapshot.sources.map(item => item.id), "duplicate_source_id");
  assertUniqueIds(snapshot.resumes.map(item => item.versionId), "duplicate_resume_version");
  assertUniqueIds(snapshot.notes.map(item => item.id), "duplicate_note_id");
  assertSources(snapshot.authorization.sourceIds, snapshot.sources, snapshot.authorization.sourceIds);
  const version = (id: string, hash: string) => {
    const resume = snapshot.resumes.find(item => item.versionId === id && item.contentHash === hash);
    if (!resume) throw new IntelligenceInputError("feedback_resume_version_mismatch");
    return resume;
  };
  const eventHashes = new Map<string, string>();
  for (const event of snapshot.events) {
    const { hash, ...payload } = event;
    if (hash !== await intelligenceHash(payload)) throw new IntelligenceInputError("outcome_event_hash_changed");
    const previous = eventHashes.get(event.id);
    if (previous && previous !== hash) throw new IntelligenceInputError("outcome_event_id_reused");
    eventHashes.set(event.id, hash);
    assertSources([event.sourceId], snapshot.sources, snapshot.authorization.sourceIds);
    version(event.resumeVersionId, event.resumeContentHash);
  }
  for (const resume of snapshot.resumes) {
    assertUniqueIds(resume.claims.map(claim => claim.id), "duplicate_claim_id");
    for (const claim of resume.claims) if (claim.hash !== await hashCommitteeText(claim.text)) throw new IntelligenceInputError("feedback_claim_hash_changed");
  }
  for (const note of snapshot.notes) {
    const resume = version(note.resumeVersionId, note.resumeContentHash);
    assertSources([note.sourceId, ...(note.originalAudioSourceId ? [note.originalAudioSourceId] : [])], snapshot.sources, snapshot.authorization.sourceIds);
    if (note.transcriptHash !== await hashCommitteeText(note.text)) throw new IntelligenceInputError("transcript_hash_changed");
    if (note.originalAudioSourceId && snapshot.sources.find(item => item.id === note.originalAudioSourceId)!.hash !== note.originalAudioSha256) throw new IntelligenceInputError("original_audio_hash_mismatch");
    assertUniqueIds(note.segments.map(segment => segment.id), "duplicate_segment_id");
    for (const segment of note.segments) if (segment.hash !== await hashCommitteeText(segment.text)) throw new IntelligenceInputError("segment_hash_changed");
    for (const link of note.claimLinks) {
      if (!note.segments.some(segment => segment.id === link.segmentId) || !resume.claims.some(claim => claim.id === link.claimId && claim.hash === link.claimHash)) throw new IntelligenceInputError("feedback_claim_mapping_mismatch");
    }
  }
  return snapshot;
}

/** Outcome analysis is observational. Interview questions do not prove a statement is false or causally explain an invitation. */
export async function analyzeOutcomeFeedback(input: unknown, options: IntelligenceAccessOptions<OutcomeFeedbackSnapshot>): Promise<OutcomeFeedbackReport> {
  const snapshot = await validateOutcomeFeedbackSnapshot(input);
  const limitations = ["Version statistics are observational and confounded by job selection, timing, employer and reporting; they are not causal effects, offer probabilities or completed RL training.",
    "No response is unknown, not rejection. A user-supplied platform receipt is unverified unless a trusted Host adapter independently verifies it.",
    "Transcript hashes bind text versions, not transcription accuracy; audio SHA preserves the original recording reference without claiming STT verification.",
    "An interviewer question is a review cue, not proof that the candidate exaggerated. Evolution patches ask for clarification and never add experience, metrics or achievements.",
    "The Host binds resume content hashes to actual immutable versions and owns all business writes, audio/STT adapters and personal-rule adoption."];
  if (!await intelligenceIsCurrent(snapshot, options)) return { schemaVersion: 1, binding: snapshot.binding, snapshotFingerprint: snapshot.fingerprint, status: "stale", versions: [], evolutionPatches: [], unknowns: ["authorization_or_input_changed"], limitations };
  const unknowns: string[] = [], events = [...new Map(snapshot.events.map(event => [event.id, event])).values()].filter(event => {
    const valid = Date.parse(event.happenedAt) <= Date.parse(snapshot.asOf);
    if (!valid) unknowns.push(`future_outcome_event:${event.id}`); return valid;
  });
  const versions = snapshot.resumes.map(resume => {
    const selected = events.filter(event => event.resumeVersionId === resume.versionId), submissions = new Set(selected.filter(event => event.kind === "submitted").map(event => event.applicationId));
    const invitations = new Set(selected.filter(event => event.kind === "interview_invited").map(event => event.applicationId));
    const offers = new Set(selected.filter(event => event.kind === "offer").map(event => event.applicationId));
    const apps = new Set(selected.map(event => event.applicationId));
    const unknown = [...apps].filter(id => !selected.some(event => event.applicationId === id && ["interview_invited", "interview_completed", "rejected", "offer", "withdrawn"].includes(event.kind)));
    return { versionId: resume.versionId, contentHash: resume.contentHash, observedSubmissions: submissions.size,
      observedInvitationApplications: invitations.size, observedOfferApplications: offers.size, unknownOutcomeApplications: unknown.length,
      invitationFractionAmongObservedSubmissions: submissions.size ? [...invitations].filter(id => submissions.has(id)).length / submissions.size : null,
      origins: { selfReportedEvents: selected.filter(event => event.origin === "self_report").length,
        unverifiedPlatformEvents: selected.filter(event => event.origin === "platform_receipt" && event.receiptVerification === "unverified").length,
        hostVerifiedPlatformEvents: selected.filter(event => event.origin === "platform_receipt" && event.receiptVerification === "host_verified").length } };
  });
  const evolutionPatches: EvolutionPatch[] = [];
  for (const note of snapshot.notes) {
    if (Date.parse(note.happenedAt) > Date.parse(snapshot.asOf)) { unknowns.push(`future_feedback_note:${note.id}`); continue; }
    for (const link of note.claimLinks) {
      if (!link.confirmedByUser) { unknowns.push(`unconfirmed_claim_mapping:${note.id}:${link.segmentId}:${link.claimId}`); continue; }
      if (link.kind === "positive") continue;
      const segment = note.segments.find(item => item.id === link.segmentId)!;
      const start = segment.startMs + note.timestampCorrectionMs, end = segment.endMs + note.timestampCorrectionMs;
      const validTime = start >= 0 && end >= start && (note.originalAudioDurationMs === null || end <= note.originalAudioDurationMs);
      if (!validTime) unknowns.push(`feedback_time_mapping_unknown:${note.id}:${segment.id}`);
      const id = `evolution-${(await intelligenceHash([note.id, segment.id, link.claimId, link.topic])).slice(0, 24)}`;
      if (evolutionPatches.some(patch => patch.id === id)) continue;
      evolutionPatches.push({ schemaVersion: 1, id, snapshotFingerprint: snapshot.fingerprint, resumeVersionId: note.resumeVersionId, resumeContentHash: note.resumeContentHash,
        claimId: link.claimId, claimHash: link.claimHash, status: "pending_review", operation: "request_clarification",
        question: `请核对该条目的${({ contribution: "个人贡献边界", metrics: "数字来源和测试条件", architecture: "架构约束与失败边界", clarity: "叙事顺序与证据衔接" })[link.topic]}；保留已知事实，缺失信息先提问。`,
        suggestedRuleCode: topicRule[link.topic], source: { noteId: note.id, sourceId: note.sourceId, transcriptHash: note.transcriptHash, segmentId: segment.id, segmentHash: segment.hash,
          originalStartMs: segment.startMs, originalEndMs: segment.endMs, correctedStartMs: validTime ? start : null, correctedEndMs: validTime ? end : null,
          originalAudioSha256: note.originalAudioSha256, transcriptionVerification: note.verification } });
    }
  }
  if (!await intelligenceIsCurrent(snapshot, options)) return { schemaVersion: 1, binding: snapshot.binding, snapshotFingerprint: snapshot.fingerprint, status: "stale", versions: [], evolutionPatches: [], unknowns: ["authorization_or_input_changed"], limitations };
  return { schemaVersion: 1, binding: snapshot.binding, snapshotFingerprint: snapshot.fingerprint, status: "completed", versions, evolutionPatches, unknowns, limitations };
}

const RuleVersionSchema = z.object({ revision: z.number().int().nonnegative(), content: z.string().max(64000), hash: IntelligenceHashSchema }).strict();
const RuleHistorySchema = z.object({ decisionId: IntelligenceIdSchema, operation: z.enum(["apply", "revert"]), payloadHash: IntelligenceHashSchema,
  authorityId: IntelligenceIdSchema, before: RuleVersionSchema, after: RuleVersionSchema, targetDecisionId: IntelligenceIdSchema.optional(),
}).strict();
export const PersonalRuleSidecarSchema = z.object({ schemaVersion: z.literal(1), id: IntelligenceIdSchema, binding: IntelligenceBindingSchema,
  target: z.enum(["guideline", "skill"]), current: RuleVersionSchema, history: z.array(RuleHistorySchema).max(500),
}).strict();
export type PersonalRuleSidecar = z.infer<typeof PersonalRuleSidecarSchema>;
export const RuleEvolutionProposalSchema = z.object({ schemaVersion: z.literal(1), id: IntelligenceIdSchema,
  snapshotFingerprint: IntelligenceHashSchema, targetSidecarId: IntelligenceIdSchema, target: z.enum(["guideline", "skill"]),
  baseRevision: z.number().int().nonnegative(), baseHash: IntelligenceHashSchema, ruleCodes: z.array(PersonalRuleCodeSchema).min(1).max(4),
  evolutionPatchIds: z.array(IntelligenceIdSchema).min(1).max(200), status: z.literal("pending_review"),
}).strict();
export type RuleEvolutionProposal = z.infer<typeof RuleEvolutionProposalSchema>;
export const PersonalRuleAuthoritySchema = z.object({ id: IntelligenceIdSchema, binding: IntelligenceBindingSchema,
  purpose: z.literal("personal_rule_update"), targetSidecarId: IntelligenceIdSchema, inputHash: IntelligenceHashSchema,
  expectedRevision: z.number().int().nonnegative(), expiresAt: z.string().datetime() }).strict();
type PersonalRuleAuthority = z.infer<typeof PersonalRuleAuthoritySchema>;
export async function createPersonalRuleSidecar(input: { id: string; binding: PersonalRuleSidecar["binding"]; target: PersonalRuleSidecar["target"]; content: string }): Promise<PersonalRuleSidecar> {
  return validatePersonalRuleSidecar({ schemaVersion: 1, id: input.id, binding: input.binding, target: input.target,
    current: { revision: 0, content: input.content, hash: await hashCommitteeText(input.content) }, history: [] });
}
export async function validatePersonalRuleSidecar(input: unknown): Promise<PersonalRuleSidecar> {
  const state = PersonalRuleSidecarSchema.parse(input);
  if (JSON.stringify(state).length > 4_000_000) throw new IntelligenceInputError("rule_sidecar_size_exceeded");
  if (state.current.revision !== state.history.length) throw new IntelligenceInputError("rule_history_revision_mismatch");
  assertUniqueIds(state.history.map(entry => entry.decisionId), "duplicate_rule_decision_id");
  for (const version of [state.current, ...state.history.flatMap(entry => [entry.before, entry.after])]) if (version.hash !== await hashCommitteeText(version.content)) throw new IntelligenceInputError("rule_content_hash_changed");
  for (let index = 0; index < state.history.length; index++) {
    const entry = state.history[index]!;
    if (entry.before.revision !== index || entry.after.revision !== index + 1 || (index > 0 && entry.before.hash !== state.history[index - 1]!.after.hash)) throw new IntelligenceInputError("rule_history_not_append_only");
  }
  if (state.history.length && state.current.hash !== state.history.at(-1)!.after.hash) throw new IntelligenceInputError("rule_current_history_mismatch");
  return state;
}
export async function proposeRuleEvolution(report: OutcomeFeedbackReport, sidecarInput: unknown, patchIds: readonly string[]): Promise<RuleEvolutionProposal> {
  const state = await validatePersonalRuleSidecar(sidecarInput);
  if (report.status !== "completed") throw new IntelligenceInputError("feedback_report_incomplete");
  if (state.binding.ownerId !== report.binding.ownerId || state.binding.workspaceId !== report.binding.workspaceId) throw new IntelligenceInputError("feedback_rule_owner_mismatch");
  const patches = patchIds.map(id => report.evolutionPatches.find(patch => patch.id === id));
  if (!patches.length || patches.some(patch => !patch)) throw new IntelligenceInputError("unknown_evolution_patch");
  const ids = [...new Set(patchIds)], ruleCodes = [...new Set(patches.map(patch => patch!.suggestedRuleCode))];
  return RuleEvolutionProposalSchema.parse({ schemaVersion: 1, id: `rules-${(await intelligenceHash([state.id, state.current.hash, ids])).slice(0, 24)}`,
    snapshotFingerprint: report.snapshotFingerprint, targetSidecarId: state.id, target: state.target, baseRevision: state.current.revision, baseHash: state.current.hash,
    ruleCodes, evolutionPatchIds: ids, status: "pending_review" });
}
const RuleConfirmationSchema = z.object({ decisionId: IntelligenceIdSchema, expectedRevision: z.number().int().nonnegative(), confirmed: z.literal(true), authority: PersonalRuleAuthoritySchema }).strict();
type RuleWriteOptions = { isCurrent: (state: PersonalRuleSidecar, authority: PersonalRuleAuthority) => boolean | Promise<boolean>; now?: () => number };
async function authorizeRuleWrite(state: PersonalRuleSidecar, confirmation: z.infer<typeof RuleConfirmationSchema>, options: RuleWriteOptions): Promise<void> {
  const authority = confirmation.authority;
  if (state.binding.ownerId !== authority.binding.ownerId || state.binding.workspaceId !== authority.binding.workspaceId || authority.targetSidecarId !== state.id
    || Date.parse(authority.expiresAt) <= (options.now ?? Date.now)() || !await options.isCurrent(state, authority)) throw new IntelligenceInputError("rule_write_authority_stale");
}
/** An explicit controlled sidecar effect. A replay analysis step must not invoke it as an automatic graph write. */
export async function applyRuleEvolution(stateInput: unknown, proposalInput: unknown, confirmationInput: unknown, options: RuleWriteOptions): Promise<PersonalRuleSidecar> {
  const state = await validatePersonalRuleSidecar(stateInput), proposal = RuleEvolutionProposalSchema.parse(proposalInput), confirmation = RuleConfirmationSchema.parse(confirmationInput);
  const payloadHash = await intelligenceHash({ operation: "apply", proposal });
  if (confirmation.authority.inputHash !== payloadHash || confirmation.authority.expectedRevision !== confirmation.expectedRevision) throw new IntelligenceInputError("rule_write_action_mismatch");
  await authorizeRuleWrite(state, confirmation, options);
  if (proposal.targetSidecarId !== state.id || proposal.target !== state.target) throw new IntelligenceInputError("rule_patch_target_mismatch");
  assertUniqueIds(proposal.ruleCodes, "duplicate_rule_code");
  const existing = state.history.find(entry => entry.decisionId === confirmation.decisionId);
  if (existing) { if (existing.payloadHash === payloadHash) return state; throw new IntelligenceInputError("rule_decision_id_reused"); }
  if (state.current.revision !== confirmation.expectedRevision || state.current.revision !== proposal.baseRevision || state.current.hash !== proposal.baseHash) throw new IntelligenceInputError("rule_revision_conflict");
  const content = [state.current.content, ...proposal.ruleCodes.map(code => PERSONAL_RULE_TEXT[code])].filter(Boolean).join("\n");
  const after = { revision: state.current.revision + 1, content, hash: await hashCommitteeText(content) };
  await authorizeRuleWrite(state, confirmation, options);
  return validatePersonalRuleSidecar({ ...state, binding: confirmation.authority.binding, current: after,
    history: [...state.history, { decisionId: confirmation.decisionId, operation: "apply", payloadHash, authorityId: confirmation.authority.id, before: state.current, after }] });
}
export async function revertRuleEvolution(stateInput: unknown, targetDecisionId: string, confirmationInput: unknown, options: RuleWriteOptions): Promise<PersonalRuleSidecar> {
  const state = await validatePersonalRuleSidecar(stateInput), confirmation = RuleConfirmationSchema.parse(confirmationInput);
  const payloadHash = await intelligenceHash({ operation: "revert", targetDecisionId });
  if (confirmation.authority.inputHash !== payloadHash || confirmation.authority.expectedRevision !== confirmation.expectedRevision) throw new IntelligenceInputError("rule_write_action_mismatch");
  await authorizeRuleWrite(state, confirmation, options);
  const existing = state.history.find(entry => entry.decisionId === confirmation.decisionId);
  if (existing) { if (existing.payloadHash === payloadHash) return state; throw new IntelligenceInputError("rule_decision_id_reused"); }
  if (state.current.revision !== confirmation.expectedRevision) throw new IntelligenceInputError("rule_revision_conflict");
  const target = state.history.find(entry => entry.decisionId === targetDecisionId && entry.operation === "apply");
  if (!target) throw new IntelligenceInputError("unknown_rule_apply_decision");
  if (state.current.hash !== target.after.hash) throw new IntelligenceInputError("later_rule_changes_require_review");
  const after = { revision: state.current.revision + 1, content: target.before.content, hash: target.before.hash };
  await authorizeRuleWrite(state, confirmation, options);
  return validatePersonalRuleSidecar({ ...state, binding: confirmation.authority.binding, current: after,
    history: [...state.history, { decisionId: confirmation.decisionId, operation: "revert", payloadHash, authorityId: confirmation.authority.id, targetDecisionId, before: state.current, after }] });
}
