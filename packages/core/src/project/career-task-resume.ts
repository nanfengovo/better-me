import { z } from "zod";
import type { RecoveryDocument } from "../schema/document.js";
import type { FactBase } from "../schema/fact.js";
import { CareerTaskJobSchema, type CareerTaskResumeReceipt, type ResumeView } from "../schema/resume.js";
import { projectResume, rebaseTextStyles, resolveResumeFactBase, snapshotResumeFacts } from "./resume-projection.js";

const id = z.string().min(1).max(300).refine(v => v.trim().length > 0), hash = z.string().regex(/^[0-9a-f]{64}$/), locale = z.enum(["zh", "en"]);
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile_headline"), locale }).strict(),
  z.object({ kind: z.literal("claim_text"), experienceId: id, claimId: id, locale }).strict(),
]);
const patch = z.object({ targetRef: target, originalText: z.string().min(1).max(12000), proposedText: z.string().min(1).max(12000),
  evidenceIds: z.array(id).min(1).max(100) }).strict();
const commandSchema = z.object({ taskId: id, sourceResumeId: id, sourceFingerprint: hash, approvalHash: hash.optional(),
  name: z.string().trim().min(1).max(500), job: CareerTaskJobSchema, patches: z.array(patch).min(1).max(100),
  approvedPatchIds: z.array(id).min(1).max(100).optional() }).strict();
export type CareerTaskResumePatch = z.infer<typeof patch>;
export type CareerTaskResumeCommand = z.infer<typeof commandSchema>;
type Failure = "invalid_command" | "source_missing" | "source_changed" | "target_changed" | "target_outside_view" | "duplicate_target" | "task_conflict";
export class CareerTaskResumeError extends Error {
  constructor(public readonly code: Failure) { super(code); this.name = "CareerTaskResumeError"; }
}
function fail(code: Failure): never { throw new CareerTaskResumeError(code); }

/** Canonical JSON: property insertion order must not invalidate an approved, reloaded document. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
async function digest(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function sourceView(document: RecoveryDocument, sourceResumeId: string): ResumeView {
  const matches = document.resumeViews.filter(v => v.id === sourceResumeId);
  return matches.length === 1 ? matches[0]! : fail("source_missing");
}
function viewFingerprint(documentId: string | undefined, base: FactBase, view: ResumeView): Promise<string> {
  const { isolatedFactBase: _isolated, careerTaskReceipt: _history, updatedAt: _at, ...settings } = view;
  const { profile, experiences } = resolveResumeFactBase(base, view);
  return digest({ version: 1, documentId: documentId ?? null, settings, profile, experiences });
}
/** Compute locally, never transmit the original document as a substitute for this revision. */
export async function careerTaskSourceFingerprint(document: RecoveryDocument, sourceResumeId: string): Promise<string> {
  const source = sourceView(document, sourceResumeId);
  return viewFingerprint(document.documentId, document.factBase, source);
}

function commandParts(input: CareerTaskResumeCommand) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) fail("invalid_command");
  const { approvalHash: supplied, approvedPatchIds, ...command } = parsed.data;
  if (approvedPatchIds && (approvedPatchIds.length !== command.patches.length || new Set(approvedPatchIds).size !== approvedPatchIds.length)) fail("invalid_command");
  // Preserve compatibility with pre-selection-metadata receipts. The host draft hash binds
  // the patch IDs; this hash independently binds each selected target, text and evidence.
  return { supplied, approvedPatchIds, command, hash: digest({ version: 1, ...command }) };
}
export async function careerTaskCommandFingerprint(input: CareerTaskResumeCommand): Promise<string> {
  return commandParts(input).hash;
}

/** Returns an atomic local document change; a persisted business receipt is not acknowledged until read-back. */
export async function createCareerTaskResume(document: RecoveryDocument, input: CareerTaskResumeCommand, now = new Date().toISOString()): Promise<{
  document: RecoveryDocument; receipt: CareerTaskResumeReceipt; reused: boolean; editionState: "as_saved" | "edited_since_save";
}> {
  if (!z.string().datetime().safeParse(now).success) fail("invalid_command");
  const { supplied, approvedPatchIds, command, hash: fingerprint } = commandParts(input);
  const contentHash = await fingerprint;
  const approvalHash = supplied ?? contentHash;
  const previous = document.resumeViews.filter(view => view.careerTaskReceipt?.taskId === command.taskId);
  if (previous.length) {
    const view = previous[0]!, receipt = view.careerTaskReceipt!;
    if (previous.length !== 1 || !view.isolatedFactBase || receipt.resumeId !== view.id || receipt.approvalHash !== approvalHash || receipt.contentHash !== contentHash
      || (receipt.approvedPatchIds && JSON.stringify(receipt.approvedPatchIds) !== JSON.stringify(approvedPatchIds))) fail("task_conflict");
    const matches = await viewFingerprint(document.documentId, document.factBase, view) === receipt.snapshotHash;
    return { document, receipt: structuredClone(receipt), reused: true, editionState: matches ? "as_saved" : "edited_since_save" };
  }
  const live = sourceView(document, command.sourceResumeId);
  const { isolatedFactBase: _old, careerTaskReceipt: _origin, ...liveSettings } = live;
  // Take the exact copy before yielding to SHA-256; no later edit can enter
  // the frozen edition between fingerprinting and copying a live object.
  const frozen = snapshotResumeFacts(resolveResumeFactBase(document.factBase, live), now);
  const styleAndSelection = structuredClone(liveSettings);
  const source: ResumeView = { ...styleAndSelection, isolatedFactBase: frozen };
  if (await viewFingerprint(document.documentId, frozen, source) !== command.sourceFingerprint) fail("source_changed");
  const displayed = projectResume(frozen, source);
  const textStyles = source.textStyles;
  const seen = new Set<string>();
  for (const p of command.patches) {
    const ref = p.targetRef, key = canonical(ref);
    if (seen.has(key)) fail("duplicate_target");
    seen.add(key);
    if (!p.proposedText.trim() || p.proposedText === p.originalText) fail("invalid_command");
    const actual = ref.kind === "profile_headline" ? frozen.profile.headline : (() => {
      const experiences = frozen.experiences.filter(e => e.id === ref.experienceId);
      const claims = experiences.length === 1 ? experiences[0]!.claims.filter(c => c.id === ref.claimId) : [];
      if (claims.length !== 1) fail("target_changed");
      return claims[0]!.text;
    })();
    const visible = ref.kind === "profile_headline" ? displayed.profile.headline :
      displayed.experiences.find(e => e.id === ref.experienceId)?.claims.find(c => c.id === ref.claimId)?.text;
    if (!actual || visible === undefined || ref.locale !== (source.locale === "en" && actual.en?.trim() ? "en" : "zh")) fail("target_outside_view");
    if (actual[ref.locale] !== p.originalText || visible !== p.originalText) fail("target_changed");
    actual[ref.locale] = p.proposedText;
    const field = ref.kind === "profile_headline" ? `profile:headline:${ref.locale}` : `claim:${ref.claimId}:${ref.locale}`;
    if (textStyles?.[field]) {
      const ranges = rebaseTextStyles(p.originalText, p.proposedText, textStyles[field]);
      if (ranges.length) textStyles[field] = ranges;
      else delete textStyles[field];
    }
  }
  const resumeId = `career-${command.taskId.length <= 160 ? command.taskId : await digest(command.taskId)}`;
  if (document.resumeViews.some(v => v.id === resumeId)) fail("task_conflict");
  const view: ResumeView = { ...styleAndSelection, id: resumeId, name: command.name, targetJdId: command.job.id,
    ...(textStyles && { textStyles }), isolatedFactBase: frozen, updatedAt: now };
  const snapshotHash = await viewFingerprint(document.documentId, document.factBase, view);
  const receipt: CareerTaskResumeReceipt = { id: `resume-receipt:${command.taskId}`, taskId: command.taskId, resumeId, sourceResumeId: source.id,
    sourceFingerprint: command.sourceFingerprint, approvalHash, contentHash, snapshotHash, ...(approvedPatchIds && { approvedPatchIds }), job: command.job, savedAt: now };
  view.careerTaskReceipt = receipt;
  return { document: { ...document, activeResumeId: resumeId, resumeViews: [...document.resumeViews, view] }, receipt: structuredClone(receipt), reused: false, editionState: "as_saved" };
}
