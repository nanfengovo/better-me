import { createCommitteeSnapshot, type CommitteeSnapshot } from "@better-me/core/career-intelligence";
import type { StudioCommitteeTask, UnderstandingGrant, UnderstandingEvidence } from "@better-me/agent-contracts";
import type { StudioContext } from "@better-me/agent-contracts/career-studio";
import type { EvidenceBroker } from "../understanding/evidence-broker.js";
import { CareerTaskError, digest } from "../tasks/evidence.js";
import { containsGitEvidenceSecret } from "../evidence-harvester/git-source.js";

export type CommitteeSourceRead = { grant: UnderstandingGrant; request: { operation: "read"; path: string; startLine: number; endLine: number }; hash: string };
export type CommitteeTaskState = { snapshot: CommitteeSnapshot; sources: CommitteeSourceRead[];
  completed: Array<{ key: string; output: string }> };
export type CommitteeReview = { task: StudioCommitteeTask; snapshot: CommitteeSnapshot;
  reads: Array<{ source: CommitteeSourceRead; evidence: UnderstandingEvidence }> };
type ReserveTool = (detail: string) => Promise<void>;

/** Selection is frozen by the Host's current context, not by a browser snapshot.
 * Grant resolution and each source read use the same root's durable reservation. */
export async function prepareCommitteeTask(task: StudioCommitteeTask, context: StudioContext, broker: EvidenceBroker, signal: AbortSignal, reserve: ReserveTool): Promise<CommitteeTaskState> {
  const input = task.request, selected = input.claimIds.map(id => {
    const claim = context.claims.find(item => item.id === id);
    if (!claim) throw new CareerTaskError("studio_claim_not_selected", 400);
    return claim;
  });
  if (new Set(input.claimIds).size !== input.claimIds.length) throw new CareerTaskError("studio_duplicate_claim_selection", 400);
  const job = input.jobId ? context.jobs.find(item => item.id === input.jobId) : undefined;
  if (input.jobId && !job) throw new CareerTaskError("studio_job_not_selected", 400);
  const evidence: Parameters<typeof createCommitteeSnapshot>[0]["evidence"] = [], sources: CommitteeSourceRead[] = [];
  for (const [index, statement] of input.statements.entries()) {
    if (containsGitEvidenceSecret(statement.text)) throw new CareerTaskError("studio_sensitive_statement", 400);
    const id = `statement-${index + 1}`;
    evidence.push({ id, sourceId: id, sourceHash: digest(statement.text), label: statement.label, provenance: statement.kind,
      excerpt: statement.text, startLine: 1, endLine: statement.text.split(/\r?\n/).length });
  }
  for (const source of input.code) {
    await reserve("Resolve the explicitly selected committee source grant.");
    const grant = await broker.grant(source.root);
    for (const file of source.files) {
      if (file.endLine < file.startLine || file.endLine - file.startLine >= 80) throw new CareerTaskError("studio_source_range_budget", 400);
      await reserve("Read the complete explicitly selected committee source range.");
      const request = { operation: "read" as const, ...file }, result = await broker.execute(grant, request, signal);
      if (result.truncated || result.evidence.length !== 1) throw new CareerTaskError("studio_source_truncated", 400);
      const item = result.evidence[0]!, id = `source-${evidence.length + 1}`;
      sources.push({ grant, request, hash: item.hash });
      evidence.push({ id, sourceId: id, sourceHash: item.hash, label: file.path, provenance: "source", excerpt: item.excerpt, startLine: item.startLine, endLine: item.endLine });
    }
  }
  if (evidence.length > 40 || evidence.reduce((total, item) => total + item.excerpt.length, 0) > 100_000) throw new CareerTaskError("studio_evidence_budget", 413);
  const snapshot = await createCommitteeSnapshot({
    binding: { ownerId: task.ownerId, workspaceId: context.workspaceKey, sessionGeneration: context.session, resumeId: context.resumeId,
      resumeRevision: context.sourceFingerprint, factRevision: context.sourceFingerprint, jdSnapshotIds: job ? [job.id] : [], rulesVersion: "career-studio-v1" },
    authorization: { grantId: task.id, evidenceIds: evidence.map(item => item.id), purpose: "resume_stress_test", expiresAt: context.expiresAt },
    claims: selected.map(({ id, text, contribution, confirmedByUser, confirmedNumericTokens }) => ({ id, text,
      contribution: confirmedByUser || contribution === "not_mine" ? contribution : "unknown", confirmedNumericTokens: confirmedByUser ? confirmedNumericTokens : [] })),
    evidence, jobText: job?.description ?? "",
  });
  if (containsGitEvidenceSecret(JSON.stringify(snapshot))) throw new CareerTaskError("studio_sensitive_model_input", 400);
  return { snapshot, sources, completed: [] };
}

export async function revalidateCommitteeSources(sources: CommitteeSourceRead[], broker: EvidenceBroker, signal: AbortSignal, reserve: ReserveTool) {
  const reads: CommitteeReview["reads"] = [];
  for (const source of sources) {
    await reserve("Revalidate the exact committee source version before using its frozen evidence.");
    const current = await broker.execute(source.grant, source.request, signal);
    if (current.truncated || current.evidence.length !== 1 || current.evidence[0]?.hash !== source.hash) throw new CareerTaskError("studio_source_changed");
    reads.push({ source, evidence: current.evidence[0]! });
  }
  return reads;
}
