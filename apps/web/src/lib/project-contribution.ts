import { z } from "zod";

export const ContributionDraftSchema = z.object({
  stage: z.enum(["", "implementation", "design", "not-mine", "unknown"]).default(""),
  answer: z.string().max(2500).default(""), role: z.string().max(300).default(""),
  deployment: z.string().max(600).default(""), customerPrivate: z.string().max(600).default(""),
  publicContext: z.string().max(600).default(""), disclose: z.boolean().default(false),
});
export type ContributionDraft = z.infer<typeof ContributionDraftSchema>;
export const emptyContributionDraft = (): ContributionDraft => ContributionDraftSchema.parse({});

/** An allowlist, not serialization of the form. Private client names NEVER leave this draft. */
export function contributionSupplement(draft: ContributionDraft): string | undefined {
  if (!["implementation", "design"].includes(draft.stage) || !draft.answer.trim()) return;
  if (/^(?:不是我做的|不确定|不知道|不便披露|暂不认领)(?:[\s/／、，。；]|$)/.test(draft.answer.trim())) return;
  return [
    draft.stage === "design" ? "个人贡献口径：设计方案，未声明已实现或上线。" : "个人贡献口径：本人实际实现，是否上线另行说明。",
    `本人确认的动作：${draft.answer.trim()}`,
    draft.role.trim() && `本人确认的职责：${draft.role.trim()}`,
    draft.deployment.trim() && `本人确认的使用阶段：${draft.deployment.trim()}`,
    draft.disclose && draft.publicContext.trim() && `允许用于简历的客户或现场描述：${draft.publicContext.trim()}`,
  ].filter(Boolean).join("\n");
}
