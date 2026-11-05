import { randomUUID } from "node:crypto";
import type { CapabilityTask, EvidenceSource, EvidenceReviewCommand, EvidenceProposalCommand,
  PersonalEvidenceReview, EvidenceChangeProposal, WorkspaceEvidenceSnapshot } from "@better-me/agent-contracts";
import { IdentityError } from "../identity/service.js";
import { hash } from "../capabilities/verification.js";

export const emptyEvidenceWorkspace = (): WorkspaceEvidenceSnapshot => ({ revision: 0, reviews: [], proposals: [] });

export function evidenceProposalEligibility(state: WorkspaceEvidenceSnapshot, proposal: EvidenceChangeProposal, task: CapabilityTask | undefined): NonNullable<EvidenceChangeProposal["eligibility"]> {
  if (task?.grant.revoked) return "source_revoked";
  if (!task || task.reviewReason || task.stage !== "completed" || task.receipt?.id !== proposal.source.reportReceiptId
    || task.outputHash !== proposal.source.reportHash) return "source_invalidated";
  const latest = [...state.reviews].reverse().find(item => item.source.taskId === proposal.source.taskId && item.source.itemIndex === proposal.source.itemIndex);
  return latest?.id === proposal.reviewId ? "current" : "review_superseded";
}

function prior<T extends PersonalEvidenceReview | EvidenceChangeProposal>(state: WorkspaceEvidenceSnapshot, command: { idempotencyKey: string },
  commandHash: string, records: T[]): T | undefined {
  const existing = [...state.reviews, ...state.proposals].find(item => item.receipt.key === command.idempotencyKey);
  if (!existing) return;
  if (existing.receipt.commandHash !== commandHash || !records.some(item => item.id === existing.id))
    throw new IdentityError(409, "workspace_idempotency_conflict");
  return existing as T;
}
function revision(state: WorkspaceEvidenceSnapshot, expected: number) {
  if (state.revision !== expected) throw new IdentityError(409, "workspace_revision_conflict");
}
function receipt(state: WorkspaceEvidenceSnapshot, key: string, commandHash: string) {
  return { id: randomUUID(), key, commandHash, revision: ++state.revision, at: new Date().toISOString() };
}

/** Workspace owns append-only personal reviews and proposals, not the tool or model. */
export function recordPersonalReview(state: WorkspaceEvidenceSnapshot, command: EvidenceReviewCommand, task: CapabilityTask): PersonalEvidenceReview {
  const commandHash = hash({ kind: "personal-evidence-review", command: { ...command, expectedRevision: undefined } });
  const saved = prior(state, command, commandHash, state.reviews); if (saved) return saved;
  revision(state, command.expectedRevision);
  const item = task.evidenceReport?.items[command.itemIndex];
  if (!item || task.receipt?.id !== command.reportReceiptId || task.outputHash !== command.reportHash)
    throw new IdentityError(409, "evidence_report_binding_changed");
  if ((command.decision.kind === "implementation" || command.decision.kind === "design")
    && /^(?:不是我做的|不确定|不知道|不便披露|暂不认领)(?:[\s/／、，。；]|$)/.test(command.decision.action))
    throw new IdentityError(400, "personal_action_required");
  const source: EvidenceSource = { taskId: task.id, reportReceiptId: task.receipt.id, reportHash: task.outputHash!, inputHash: task.inputHash,
    codeHash: task.selected!.codeHash, recipeHash: task.composition!.recipeHash, verificationId: task.taskVerification!.id,
    itemIndex: command.itemIndex, title: item.title, requirement: structuredClone(item.requirement),
    notes: structuredClone(task.evidence!.notes.filter(note => item.evidenceIds.includes(note.id))) };
  const previous = [...state.reviews].reverse().find(item => item.source.taskId === task.id && item.source.itemIndex === command.itemIndex);
  const review: PersonalEvidenceReview = { id: randomUUID(), source, decision: command.decision,
    ...(previous ? { supersedes: previous.id } : {}), receipt: receipt(state, command.idempotencyKey, commandHash) };
  state.reviews.push(review); return review;
}

export function proposePersonalEvidence(state: WorkspaceEvidenceSnapshot, command: EvidenceProposalCommand): EvidenceChangeProposal {
  const commandHash = hash({ kind: "evidence-change-proposal", command: { ...command, expectedRevision: undefined } });
  const saved = prior(state, command, commandHash, state.proposals); if (saved) return saved;
  revision(state, command.expectedRevision);
  const review = state.reviews.find(item => item.id === command.reviewId);
  if (!review) throw new IdentityError(404, "personal_review_not_found");
  const latest = [...state.reviews].reverse().find(item => item.source.taskId === review.source.taskId && item.source.itemIndex === review.source.itemIndex);
  if (latest?.id !== review.id) throw new IdentityError(409, "personal_review_superseded");
  if (review.decision.kind !== "implementation" && review.decision.kind !== "design") throw new IdentityError(409, "personal_contribution_not_claimed");
  // A different operation key cannot manufacture duplicate proposals for one review.
  const existing = state.proposals.find(item => item.reviewId === review.id);
  if (existing) throw new IdentityError(409, "proposal_already_exists");
  const proposal: EvidenceChangeProposal = { id: randomUUID(), reviewId: review.id, source: structuredClone(review.source),
    candidate: structuredClone(review.decision), status: "pending_business_review",
    limitations: ["本人确认的自述，不是系统或外部真实性认证。", "项目来源仅供追溯，不证明个人贡献。",
      review.decision.kind === "design" ? "仅声明设计方案，未声明实现或上线。" : "实现、使用阶段和效果均以本人明确自述为限。",
      "尚未采用到Fact或简历；正式采用须另走业务校验、授权及版本规则。"],
    receipt: receipt(state, command.idempotencyKey, commandHash) };
  state.proposals.push(proposal); return proposal;
}
