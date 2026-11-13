import { z } from "zod";
import hash from "hash.js";

/** Read-only candidate wire contract, not a factual certification or adoption command. */
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const citation = z.object({
  evidenceId: identifier,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  original: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict(),
}).strict();
export const ResumeCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: identifier,
  groups: z.array(z.object({ groupId: identifier, bullets: z.array(z.object({
    id: identifier, text: z.string().min(1), citations: z.array(citation),
  }).strict()).min(1) }).strict()).min(1),
  questions: z.array(z.string().min(1)),
}).strict();
// v3 keeps the source-bound v2 wire shape, with an explicitly versioned
// whole-document editorial policy. Historical v2 prompts remain reproducible.
// v4 keeps that wire and adds an explicit Host source-attribution conflict gate.
// v5 also checks the presence of explicitly ongoing work, never inferred dates.
export const ResumeCandidateResponseContractSchema = z.enum(["resume_candidate_v1", "resume_candidate_v2", "resume_candidate_v3", "resume_candidate_v4", "resume_candidate_v5"]);
export const ResumeCandidateSourceBindingSchema = z.object({ messageId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const sourceDigest = (text: string) => hash.sha256().update(text).digest("hex");
/** Full source stays in its original message. Extra source metadata remains data,
 * while only these validated handles authorize candidate citations. */
export const ResumeCandidateSourceSchema = z.object({ caseId: identifier, candidate: z.object({
  groups: z.array(z.object({ id: identifier }).passthrough()).min(1),
  evidence: z.array(z.object({ id: identifier, groupId: identifier, text: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()).min(1),
}).passthrough() }).passthrough().superRefine((value, ctx) => {
  const { groups, evidence } = value.candidate;
  if (new Set(groups.map(g => g.id)).size !== groups.length || new Set(evidence.map(e => e.id)).size !== evidence.length)
    ctx.addIssue({ code: "custom", message: "candidate source identities must be unique" });
  if (evidence.some(e => sourceDigest(e.text) !== e.sha256)) ctx.addIssue({ code: "custom", message: "candidate evidence hash changed" });
  if (!evidence.some(e => groups.some(g => g.id === e.groupId))) ctx.addIssue({ code: "custom", message: "no citable group evidence" });
});
export type ResumeCandidateSource = z.infer<typeof ResumeCandidateSourceSchema>;
type SourceTask = { responseContract?: string; candidateSource?: z.infer<typeof ResumeCandidateSourceBindingSchema>;
  conversation: { messages: { id: string; role: string; content: string }[] } };
/** Explicit immutable source grant, never inferred from markers in user text. */
export function resumeCandidateSource(task: SourceTask): ResumeCandidateSource | undefined {
  if (!["resume_candidate_v2", "resume_candidate_v3", "resume_candidate_v4", "resume_candidate_v5"].includes(task.responseContract ?? "")) {
    if (task.candidateSource) throw Error("candidate_source_contract_required");
    return undefined;
  }
  const binding = task.candidateSource;
  if (!binding) throw Error("candidate_source_binding_required");
  const messages = task.conversation.messages.filter(m => m.id === binding.messageId);
  if (messages.length !== 1 || messages[0]!.role !== "user" || sourceDigest(messages[0]!.content) !== binding.sha256) throw Error("candidate_source_binding_changed");
  return ResumeCandidateSourceSchema.parse(JSON.parse(messages[0]!.content).material);
}
export function validateResumeCandidateBinding(task: SourceTask, ctx: z.RefinementCtx) {
  try { resumeCandidateSource(task); } catch { ctx.addIssue({ code: "custom", message: "candidate source binding or evidence is invalid" }); }
}
export const ResumeBoundCandidateSchema = z.object({ schemaVersion: z.literal(2), caseId: identifier,
  bullets: z.array(z.object({ id: identifier, text: z.string().min(1), evidenceIds: z.array(identifier).min(1) }).strict()).min(1),
  questions: z.array(z.string().min(1)),
}).strict();

const attributionWording = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
/** Narrow provenance conflict, NOT semantic fact approval: the complete proposed
 * wording occurs in an uncited source unit, but in none of its cited units.
 * Non-delivery academic/training sources remain visible, never borrowed as work.
 * No tokens/qualifiers are removed; only sentence-final punctuation is ignored.
 * Absence of this conflict does not establish support, completeness or quality. */
export function reviewResumeCandidateAttribution(rawSource: unknown, rawCandidate: unknown) {
  const source = ResumeCandidateSourceSchema.parse(rawSource);
  resumeCandidateBoundSchema(source).parse(rawCandidate);
  const candidate = ResumeBoundCandidateSchema.parse(rawCandidate);
  return candidate.bullets.flatMap(bullet => {
    const wording = attributionWording(bullet.text).replace(/[.!?。！？]+$/u, "").trim();
    const cited = source.candidate.evidence.filter(e => bullet.evidenceIds.includes(e.id));
    if (!wording || cited.some(e => attributionWording(e.text).includes(wording))) return [];
    const matchingSources = source.candidate.evidence.filter(e => !bullet.evidenceIds.includes(e.id) && attributionWording(e.text).includes(wording));
    return matchingSources.length ? [{ claimId: bullet.id, text: bullet.text, citedEvidenceIds: [...bullet.evidenceIds],
      citedGroupId: cited[0]!.groupId, matchingSources, policyVersion: "resume-source-attribution-v1" as const }] : [];
  });
}

const workKinds = new Set(["employment", "internship", "freelance"]);
const sourceMonth = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const sourceDate = `(?:[12]\\d{3}(?:[-/.](?:0?[1-9]|1[0-2]))?|${sourceMonth} [12]\\d{3}|[12]\\d{3}年(?:0?[1-9]|1[0-2])月)`;
const ongoingPeriod = new RegExp(`^(?:(?:present|current|至今)|since ${sourceDate}|${sourceDate}\\s*[-–—]\\s*(?:present|current|至今))$`, "u");
/** Original strings remain authoritative. Explicit 'Until Now' in unresolved
 * original fields proves only the ongoing marker, not the date order or month.
 * Closed/unknown periods are deliberately unassessed rather than guessed recent. */
export function resumeCandidateWorkInventory(rawSource: unknown) {
  const source = ResumeCandidateSourceSchema.parse(rawSource);
  const work = source.candidate.groups.filter(g => typeof g.kind === "string" && workKinds.has(g.kind));
  const groups = work.map(g => ({ id: g.id, title: g.title, organization: g.organization, originalPeriod: g.originalPeriod, kind: g.kind,
    evidenceIds: source.candidate.evidence.filter(e => e.groupId === g.id).map(e => e.id) }));
  const ongoing = (period: unknown) => typeof period === "string" && (ongoingPeriod.test(attributionWording(period))
    || /^until now \/ .+ \(original fields; chronology unresolved\)$/u.test(attributionWording(period)));
  const requiredGroups = groups.filter(g => ongoing(g.originalPeriod) && g.evidenceIds.length > 0);
  const unassessedGroups = groups.filter(g => !requiredGroups.some(r => r.id === g.id)).map(g => ({ ...g,
    reason: g.evidenceIds.length ? "period_not_assessed_as_ongoing" : "no_citable_source_unit" }));
  return { policyVersion: "resume-current-work-v1" as const, requiredGroups, unassessedGroups };
}
/** Structural career-presence guard, not support/quality certification. Only
 * explicitly ongoing work with source handles is required; old work and projects
 * remain deliberate selections. A question cannot erase an existing source role.
 * Neither the candidate nor this function invents dates, facts or source links. */
export function reviewResumeCandidateWorkCoverage(rawSource: unknown, rawCandidate: unknown) {
  const source = ResumeCandidateSourceSchema.parse(rawSource);
  const candidate = resumeCandidateBoundSchema(source).parse(rawCandidate), inventory = resumeCandidateWorkInventory(source);
  const selectedGroupIds = [...new Set(candidate.bullets.map(b => source.candidate.evidence.find(e => e.id === b.evidenceIds[0])!.groupId))];
  return { ...inventory, selectedGroupIds, missingCurrentGroups: inventory.requiredGroups.filter(g => !selectedGroupIds.includes(g.id)), overallQualityPassed: null };
}
/** Host-selected grammar exposes only actual, same-group evidence IDs. No generic
 * caller schema or model-generated source coordinates are accepted. */
export function resumeCandidateBoundSchema(rawSource: unknown) {
  const source = ResumeCandidateSourceSchema.parse(rawSource);
  const choices = source.candidate.groups.flatMap(group => {
    const ids = source.candidate.evidence.filter(e => e.groupId === group.id).map(e => e.id);
    return ids.length ? [z.object({ id: identifier, text: z.string().min(1), evidenceIds: z.array(z.enum(ids as [string, ...string[]])).min(1) }).strict()] : [];
  });
  const [first, second, ...rest] = choices;
  if (!first) throw Error("no_citable_group_evidence");
  const bullet = second ? z.union([first, second, ...rest]) : first;
  return z.object({ schemaVersion: z.literal(2), caseId: z.literal(source.caseId), bullets: z.array(bullet).min(1), questions: z.array(z.string().min(1)) }).strict()
    .superRefine((value, ctx) => {
      const typed = ResumeBoundCandidateSchema.parse(value);
      if (new Set(typed.bullets.map(b => b.id)).size !== typed.bullets.length || typed.bullets.some(b => new Set(b.evidenceIds).size !== b.evidenceIds.length))
        ctx.addIssue({ code: "custom", message: "candidate bullet/citation identity duplicated" });
    });
}
/** Resolves the exact whole-unit handles selected by a v2 candidate. This is the
 * specified projection, not repair of legacy IDs, offsets, quotes or wording. */
export function materializeResumeCandidate(rawSource: unknown, rawCandidate: unknown): z.infer<typeof ResumeCandidateSchema> {
  const source = ResumeCandidateSourceSchema.parse(rawSource);
  resumeCandidateBoundSchema(source).parse(rawCandidate);
  const candidate = ResumeBoundCandidateSchema.parse(rawCandidate), groups: z.infer<typeof ResumeCandidateSchema>["groups"] = [];
  for (const bullet of candidate.bullets) {
    const evidence = bullet.evidenceIds.map(id => source.candidate.evidence.find(e => e.id === id)!);
    const groupId = evidence[0]!.groupId;
    let group = groups.find(g => g.groupId === groupId);
    if (!group) { group = { groupId, bullets: [] }; groups.push(group); }
    group.bullets.push({ id: bullet.id, text: bullet.text, citations: evidence.map(e => ({ evidenceId: e.id, sourceSha256: e.sha256,
      original: { start: 0, end: e.text.length, quote: e.text } })) });
  }
  return ResumeCandidateSchema.parse({ schemaVersion: 1, caseId: candidate.caseId, groups, questions: candidate.questions });
}
