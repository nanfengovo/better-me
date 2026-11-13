import { z } from "zod";
import { FactBaseSchema } from "../schema/fact.js";
import { ResumeViewSchema } from "../schema/resume.js";
import { projectResume, type ProjectedResume } from "../project/resume-projection.js";
import { committeeNumericTokens } from "./claims.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) }).strict();
const provenance = z.object({ url: z.string().url(), revision: z.string().min(1), license: z.string().min(1), licenseUrl: z.string().url(),
  retrievedAt: z.string().datetime(), originalSha256: hash, anonymization: z.string().min(1) }).strict();
const signals = z.object({ situation: z.array(z.string().min(1)), task: z.array(z.string().min(1)), action: z.array(z.string().min(1)), result: z.array(z.string().min(1)) }).strict();
export const ResumeQualityCaseSchema = z.object({
  schemaVersion: z.literal(1), id, dataKind: z.enum(["real_anonymized", "synthetic_protocol"]), role: z.string().min(1),
  job: z.object({ text: z.string().min(1), sha256: hash, provenance }).strict(),
  evidence: z.array(z.object({ id, text: z.string().min(1), sha256: hash, provenance, star: signals }).strict()).min(1),
  requirements: z.array(z.object({ id, original: span, weight: z.number().positive(),
    support: z.enum(["supported", "partial", "not_evidenced"]).optional(),
    // Independently frozen source-reviewed alternatives; never populated by the candidate model.
    anchorGroups: z.array(z.array(z.string().min(1)).min(1)).min(1), evidenceIds: z.array(id) }).strict()).min(1),
  entityLexicon: z.array(z.string().min(1)),
  approvedParaphrases: z.array(z.object({ text: z.string().min(1), evidenceIds: z.array(id).min(1), reviewer: z.string().min(1) }).strict()),
}).strict();
/** Read-only benchmark projection. Original date strings never become invented FactBase months. */
export const ResumeQualitySourceCandidateSchema = z.object({
  displayName: z.string().min(1),
  groups: z.array(z.object({ id, title: z.string().min(1), organization: z.string().min(1), originalPeriod: z.string().min(1),
    kind: z.string().min(1), claims: z.array(z.object({ id, text: z.string().min(1) }).strict()).min(1) }).strict()).min(1),
}).strict();
const runRecord = z.object({
  schemaVersion: z.literal(1), caseId: id, caseSha256: hash,
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("kernel_task"), taskId: z.string().regex(/^ct_[a-f0-9]{32}$/), rootTaskId: z.string().regex(/^ct_[a-f0-9]{32}$/),
      rawOutputSha256: hash, taskRecordSha256: hash,
      execution: z.enum(["model", "scripted_fixture"]).optional(), freezeManifestSha256: hash.optional(), inputMaterialSha256: hash.optional() }).strict(),
    z.object({ kind: z.literal("human_baseline"), label: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("extractive_baseline"), label: z.string().min(1) }).strict(),
  ]),
  model: z.object({ provider: z.string().min(1), id: z.string().min(1), revision: z.string().min(1), runtimeId: z.string().min(1) }).strict(),
  protocolVersion: z.string().min(1), budget: z.object({ maxModelCalls: z.number().int().nonnegative(), maxToolCalls: z.number().int().nonnegative(), maxActiveMs: z.number().int().nonnegative() }).strict(),
  observed: z.object({ modelCalls: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), activeMs: z.number().nonnegative() }).strict(),
  view: ResumeViewSchema, locale: z.enum(["zh", "en"]),
  citations: z.array(z.object({ claimId: z.string().min(1), evidenceId: id, sourceSha256: hash, original: span }).strict()),
}).strict();
export const ResumeQualityFactRunSchema = runRecord.extend({ factBase: FactBaseSchema }).strict();
export type ResumeQualityFactRun = z.infer<typeof ResumeQualityFactRunSchema>;
export const ResumeQualityRunSchema = z.union([ResumeQualityFactRunSchema,
  runRecord.extend({ sourceCandidate: ResumeQualitySourceCandidateSchema }).strict()]);
export type ResumeQualityCase = z.infer<typeof ResumeQualityCaseSchema>;
export type ResumeQualityRun = z.infer<typeof ResumeQualityRunSchema>;
export const RESUME_QUALITY_JUDGE = "resume-quality-v2";
export async function qualityHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, "0")).join("");
}
const exactSpan = (text: string, value: z.infer<typeof span>) => value.end <= text.length && value.end > value.start && text.slice(value.start, value.end) === value.quote;
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`duplicate_${label}`); }
export async function validateResumeQualityCase(raw: unknown): Promise<ResumeQualityCase> {
  const value = ResumeQualityCaseSchema.parse(raw);
  unique(value.evidence.map(e => e.id), "evidence"); unique(value.requirements.map(r => r.id), "requirement");
  if (await qualityHash(value.job.text) !== value.job.sha256) throw new Error("job_hash_changed");
  for (const evidence of value.evidence) {
    if (await qualityHash(evidence.text) !== evidence.sha256) throw new Error("evidence_hash_changed");
    for (const terms of Object.values(evidence.star)) if (terms.some(term => !evidence.text.includes(term))) throw new Error("star_signal_not_in_source");
  }
  for (const requirement of value.requirements) {
    if (!exactSpan(value.job.text, requirement.original)) throw new Error("jd_original_span_changed");
    unique(requirement.evidenceIds, "requirement_evidence");
    if (requirement.evidenceIds.some(ref => !value.evidence.some(e => e.id === ref))) throw new Error("unknown_requirement_evidence");
    if (requirement.support === "not_evidenced" && requirement.evidenceIds.length) throw new Error("unsupported_requirement_has_evidence");
    if ((requirement.support === "supported" || requirement.support === "partial") && !requirement.evidenceIds.length) throw new Error("supported_requirement_missing_evidence");
  }
  for (const approved of value.approvedParaphrases) if (approved.evidenceIds.some(ref => !value.evidence.some(e => e.id === ref))) throw new Error("unknown_paraphrase_evidence");
  return value;
}
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
function contains(text: string, term: string) {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // C#/Go/.NET must not match fragments of a different identifier.
  return new RegExp(`${/^[a-z0-9]/i.test(term) ? "(?<![a-z0-9_])" : ""}${escaped}${/[a-z0-9]$/i.test(term) ? "(?![a-z0-9_])" : ""}`, "u").test(normalize(text));
}
const ordinary = new Set("I We The A An This That These Those Built Build Implemented Implement Develop Developed Designed Design Improved Improve Reduced Reduce Increased Increase Delivered Deliver Maintained Maintain Created Create Automated Automated Led Lead Worked Work Used Use Using Responsible Supported Support Enabled Enable Prevented Prevent Collaborated Collaborate Contributed Contribute Assisted Assist Optimized Optimize Migrated Migrate Refactored Refactor Fixed Fix For With From To In On At By As And Or Of Our My It Its Service System Project Team Application".toLowerCase().split(" "));
function entities(text: string, lexicon: string[]) {
  const names = text.match(/\b(?:[A-Z][A-Za-z0-9.+#_-]*|[a-z]+[A-Z][A-Za-z0-9.+#_-]*)\b/g) ?? [];
  return [...new Set([...lexicon.filter(term => contains(text, term)), ...names.filter(term => !ordinary.has(normalize(term)))])];
}
const percent = (numerator: number, denominator: number) => denominator ? Number((100 * numerator / denominator).toFixed(2)) : null;

function projectSourceCandidate(run: Extract<ResumeQualityRun, { sourceCandidate: unknown }>): ProjectedResume {
  unique(run.sourceCandidate.groups.map(g => g.id), "candidate_group");
  return { locale: run.locale, templateId: run.view.templateId, layout: run.view.layout,
    profile: { displayName: run.sourceCandidate.displayName, links: [], targetRoles: [], traits: [] },
    experiences: run.sourceCandidate.groups.map(group => ({ id: group.id,
      type: group.kind === "education" ? "education" : ["employment", "internship", "freelance"].includes(group.kind) ? "work" : "other",
      org: group.organization, title: group.title, start: group.originalPeriod,
      // Empty is intentional: null means Present in the production renderer.
      end: "", techStack: [], claims: group.claims.map(claim => ({ ...claim, kind: "action", tags: [] })) })) };
}

/** Independent deterministic screening. Unknown entailment is never awarded a perfect factual score. */
export async function judgeResumeQuality(rawCase: unknown, rawRun: unknown) {
  const test = await validateResumeQualityCase(rawCase), run = ResumeQualityRunSchema.parse(rawRun);
  if (run.caseId !== test.id || run.caseSha256 !== await qualityHash(JSON.stringify(test))) throw new Error("case_binding_changed");
  if (run.locale !== run.view.locale) throw new Error("candidate_locale_changed");
  const resume = "sourceCandidate" in run ? projectSourceCandidate(run) : projectResume(run.factBase, run.view);
  const claims = resume.experiences.flatMap(e => e.claims);
  unique(claims.map(c => c.id), "candidate_claim");
  if (run.citations.some(c => !claims.some(claim => claim.id === c.claimId))) throw new Error("unknown_candidate_claim");
  const assessed = claims.map(claim => {
    const citations = run.citations.filter(c => c.claimId === claim.id);
    const valid = citations.filter(c => {
      const source = test.evidence.find(e => e.id === c.evidenceId);
      return source && c.sourceSha256 === source.sha256 && exactSpan(source.text, c.original);
    });
    const grounded = valid.map(c => c.original.quote).join("\n");
    const unsupportedNumbers = committeeNumericTokens(claim.text).filter(token => !committeeNumericTokens(grounded).includes(token));
    const unsupportedEntities = entities(claim.text, test.entityLexicon).filter(term => !contains(grounded, term));
    const approved = test.approvedParaphrases.some(p => p.text === claim.text && p.evidenceIds.every(ref => valid.some(c => c.evidenceId === ref)));
    // A substring can delete "not", qualifications or an attribution boundary.
    // Automatic factual credit is limited to a complete independent source unit;
    // shortening/paraphrase needs the benchmark's separate human approval.
    const extractive = claim.text.trim().length > 0 && valid.some(c => {
      const source = test.evidence.find(e => e.id === c.evidenceId)!;
      return c.original.quote === source.text && claim.text.trim() === source.text.trim();
    });
    const requiresSemanticReview = !extractive && !approved;
    const compliant = valid.length > 0 && valid.length === citations.length && !unsupportedNumbers.length && !unsupportedEntities.length && !requiresSemanticReview;
    const star = Object.fromEntries((["situation", "task", "action", "result"] as const).map(dimension => [dimension,
      test.evidence.filter(e => valid.some(c => c.evidenceId === e.id)).some(e => e.star[dimension].some(signal => contains(claim.text, signal) && contains(grounded, signal)))]));
    return { claimId: claim.id, text: claim.text, citedEvidenceIds: [...new Set(valid.map(c => c.evidenceId))], validCitations: valid.length,
      invalidCitations: citations.length - valid.length, unsupportedNumbers, unsupportedEntities, requiresSemanticReview, compliant, star };
  });
  const requirements = test.requirements.map(r => {
    const matched = assessed.filter(c => c.compliant && c.citedEvidenceIds.some(ref => r.evidenceIds.includes(ref))
      && r.anchorGroups.every(group => group.some(anchor => contains(c.text, anchor)))).map(c => c.claimId);
    const support = r.support ?? "supported";
    return { id: r.id, original: r.original.quote, weight: r.weight, support,
      claimIds: support === "supported" ? matched : [], partialClaimIds: support === "partial" ? matched : [] };
  });
  const weights = requirements.reduce((sum, r) => sum + r.weight, 0);
  return { schemaVersion: 1 as const, judgeVersion: RESUME_QUALITY_JUDGE, caseId: test.id, dataKind: test.dataKind,
    caseSha256: run.caseSha256, runSha256: await qualityHash(JSON.stringify(run)), origin: run.origin, model: run.model,
    protocolVersion: run.protocolVersion, budget: run.budget, observed: run.observed, resume,
    coverage: { percent: percent(requirements.filter(r => r.claimIds.length).reduce((sum, r) => sum + r.weight, 0), weights), requirements },
    antiHallucination: { percent: percent(assessed.filter(c => c.compliant).length, assessed.length), claims: assessed },
    star: { percent: percent(assessed.reduce((sum, c) => sum + Object.values(c.star).filter(Boolean).length, 0), 4 * assessed.length), dimensionsPerBullet: 4 },
    limitations: ["Coverage uses independently authored anchors and cited source eligibility, not keyword overlap alone or semantic entailment proof.",
      "Novel names/numbers are screened against exact cited text. Unknown paraphrases require independent review and receive no factual pass; the lexical screen is not a complete noun/entailment detector.",
      "STAR measures independently labelled literal structural signals; an absent source result stays absent, never invented for a score.",
      "Public source facts are author self-reports, not independently verified employment or performance.",
      "A4 layout must come from an actual production-template PDF, not a character count or DOM-height estimate."] };
}
