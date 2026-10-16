import type { FactBase, FactClaim } from "../schema/fact.js";

export type ClaimIssue = {
  claimId: string;
  experienceId: string;
  code:
    | "metric_unconfirmed"
    | "metric_missing_baseline"
    | "hollow_phrase"
    | "missing_locale_en";
  message: string;
};

const HOLLOW_PATTERNS: RegExp[] = [
  /负责相关工作/,
  /参与了?项目/,
  /熟悉常用/,
  /良好的沟通/,
  /提升了?效率(?!.*\d)/,
  /responsible for various/i,
  /helped (with|to)/i,
];

export function scanClaim(
  claim: FactClaim,
  experienceId: string,
): ClaimIssue[] {
  const issues: ClaimIssue[] = [];

  if (claim.metric) {
    if (!claim.metric.confirmed) {
      issues.push({
        claimId: claim.id,
        experienceId,
        code: "metric_unconfirmed",
        message: "量化数字未确认，禁止直接写入对外简历。",
      });
    }
    if (!claim.metric.baseline?.trim() && !claim.metric.causal?.trim()) {
      issues.push({
        claimId: claim.id,
        experienceId,
        code: "metric_missing_baseline",
        message: "量化缺少基线或因果链（STAR 不完整）。",
      });
    }
  }

  const textBlob = `${claim.text.zh} ${claim.text.en ?? ""}`;
  for (const re of HOLLOW_PATTERNS) {
    if (re.test(textBlob)) {
      issues.push({
        claimId: claim.id,
        experienceId,
        code: "hollow_phrase",
        message: `疑似空洞表述：匹配 /${re.source}/`,
      });
      break;
    }
  }

  return issues;
}

export function scanFactBase(base: FactBase): ClaimIssue[] {
  return base.experiences.flatMap((exp) =>
    exp.claims.flatMap((c) => scanClaim(c, exp.id)),
  );
}
