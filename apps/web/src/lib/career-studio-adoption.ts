import { projectResume, type ProjectedResume } from "@better-me/core";
import { DocumentSchema, type BetterMeDocument } from "@better-me/storage";
import { applyResumeProposal, createResumeAgentContext } from "./resume-agent-context";
import { applyCareerLayoutCandidate, buildCareerLayoutInput, careerLayoutSourceFingerprint } from "./career-studio-layout";
import { type LayoutCandidate, type LayoutScope } from "./layout-compiler";

export async function careerStudioDigest(value: unknown): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
}

/** Build a proposal only. The caller must use the existing owner-aware
 * reviewed-version write+readback command, not a direct storage assignment. */
export function buildCareerLayoutDocument(document: BetterMeDocument, base: ProjectedResume, scope: LayoutScope, candidate: LayoutCandidate): BetterMeDocument {
  const view = document.resumeViews.find(v => v.id === document.activeResumeId);
  if (!view || view.id !== scope.documentId || careerLayoutSourceFingerprint(projectResume(document.factBase, view)) !== careerLayoutSourceFingerprint(base)) throw new Error("排版原稿已变化，不能采用旧候选。");
  const expected = applyCareerLayoutCandidate(base, buildCareerLayoutInput(base, scope), candidate), context = createResumeAgentContext(document.factBase, view);
  let next = document;
  for (const replacement of candidate.replacements) {
    const target = replacement.anchor === "profile:headline" ? context.profile.headline : context.experiences.flatMap(e => e.claims).find(c => `claim:${c.targetRef.kind === "claim_text" ? c.targetRef.claimId : ""}` === replacement.anchor);
    if (!target || target.text !== replacement.before) throw new Error("排版句子定位或原文不匹配，未应用。");
    const result = applyResumeProposal(next, { targetRef: target.targetRef, originalText: replacement.before, proposedText: replacement.after });
    if (!result.ok) throw new Error("排版候选与当前简历有冲突，未应用。"); next = result.document;
  }
  const updatedAt = new Date().toISOString();
  next = { ...next, resumeViews: next.resumeViews.map(v => v.id === view.id ? { ...v, layout: expected.layout, textStyles: expected.textStyles, updatedAt } : v) };
  const parsed = DocumentSchema.parse(next) as BetterMeDocument;
  const actual = projectResume(parsed.factBase, parsed.resumeViews.find(v => v.id === parsed.activeResumeId)!);
  // Compare every projected field except layout's now-explicit default values.
  if (JSON.stringify({ ...actual, layout: expected.layout }) !== JSON.stringify(expected)) throw new Error("业务投影与已复测候选不一致，不能记录采用成功。");
  return parsed;
}
