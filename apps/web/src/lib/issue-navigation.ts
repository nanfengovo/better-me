import { scanClaim, type ClaimIssue, type FactBase } from "@better-me/core";
import { getIssueGuidance, type IssueField } from "./issue-guidance";

export type IssueNavigationRequest = {
  issue: ClaimIssue;
  field: IssueField | "value" | "unit";
  requestId: number;
};

/** Resolve both IDs against the current draft; navigation must never modify a fact. */
export function createIssueNavigation(
  factBase: FactBase,
  issue: ClaimIssue,
  requestId: number,
): IssueNavigationRequest | undefined {
  const experience = factBase.experiences.find((item) => item.id === issue.experienceId);
  const claim = experience?.claims.find((item) => item.id === issue.claimId);
  if (!claim) return;
  let field: IssueNavigationRequest["field"] = getIssueGuidance(issue.code).field;
  if (issue.code === "hollow_phrase") {
    const matchesChinese = scanClaim({ ...claim, text: { zh: claim.text.zh } }, issue.experienceId)
      .some((item) => item.code === "hollow_phrase");
    if (!matchesChinese && claim.text.en?.trim()) field = "text-en";
  }
  // A disabled confirmation control cannot be focused or used before these exist.
  if (issue.code === "metric_unconfirmed" && claim.metric) {
    if (!Number.isFinite(claim.metric.value)) field = "value";
    else if (!claim.metric.unit.trim()) field = "unit";
  }
  return { issue, field, requestId };
}
