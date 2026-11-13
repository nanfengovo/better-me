import { z } from "zod";
import { PersonalStatementSchema, type FactBase } from "@better-me/core";
import { careerStudioDigest } from "./career-studio-adoption";

export const CareerEvidenceReviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["implementation", "design"]), action: z.string().min(1).max(2500), role: z.string().max(300), deployment: z.string().max(600) }).strict(),
  z.object({ kind: z.literal("not-mine"), note: z.string().max(2500) }).strict(), z.object({ kind: z.literal("unknown"), note: z.string().max(2500) }).strict(),
]);
export const CareerEvidenceEntrySchema = z.object({ id: z.string(), subscriptionId: z.string(), repositoryId: z.string(), commit: z.string(), generation: z.number().int(),
  status: z.enum(["capturing", "analyzing", "awaiting_review", "dismissed", "failed", "interrupted", "reviewed", "proposing", "proposal_created"]),
  personalContribution: z.literal("unknown"), title: z.string().optional(), summary: z.string().optional(), contributionQuestion: z.string().optional(),
  citations: z.array(z.object({ evidenceId: z.string(), path: z.string(), version: z.enum(["before", "after"]), sourceHash: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: z.string() }).strict()).max(8),
  review: CareerEvidenceReviewSchema.optional(), proposalReceipt: z.object({ id: z.string(), proposalId: z.string(), status: z.literal("pending_business_review") }).strict().optional(),
  errorCode: z.string().optional(), limitations: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type CareerEvidenceEntry = z.infer<typeof CareerEvidenceEntrySchema>;

/** An exact, explicitly approved personal statement. Generated prose and Git
 * author metadata are never promoted to a verified career Fact. */
export async function buildCareerEvidenceStatement(base: FactBase, raw: unknown, expectedReviewHash: string): Promise<{ factBase: FactBase; statementId: string; statementHash: string }> {
  const entry = CareerEvidenceEntrySchema.parse(raw), review = entry.review;
  if (entry.status !== "proposal_created" || !entry.proposalReceipt || !review || !["implementation", "design"].includes(review.kind)
    || await careerStudioDigest(review) !== expectedReviewHash || !entry.citations.length || !("action" in review)) throw new Error("待审本人陈述或来源回执已变化，不能写入长期资料。");
  const approvedAt = new Date().toISOString(), statement = PersonalStatementSchema.parse({ id: `git-fact:${entry.id}`, text: review.action, kind: "user_statement", taskId: `git-inbox:${entry.id}`,
    evidence: [{ id: `self:${entry.id}`, hash: await careerStudioDigest(review.action), excerpt: review.action, label: `本人明确自述；${review.kind === "implementation" ? "实现" : "仅设计"}；角色：${review.role}；部署：${review.deployment}`, kind: "user_statement" },
      ...entry.citations.map(c => ({ id: c.evidenceId, hash: c.sourceHash, excerpt: c.quote, label: `${c.path} ${c.version} L${c.startLine}-${c.endLine}；commit ${entry.commit}`, kind: "source" as const }))], approvedAt });
  const existing = base.personalStatements?.find(s => s.id === statement.id);
  if (existing && (existing.text !== statement.text || JSON.stringify(existing.evidence) !== JSON.stringify(statement.evidence))) throw new Error("这张卡片已经保存了不同版本，不能覆盖。");
  return { factBase: existing ? base : { ...base, updatedAt: approvedAt, personalStatements: [...base.personalStatements ?? [], statement] }, statementId: statement.id, statementHash: await careerStudioDigest({ text: statement.text, evidence: statement.evidence }) };
}
