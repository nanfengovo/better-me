import { PersonalStatementSchema, type FactBase } from "@better-me/core";
import type { CareerTask } from "@better-me/agent-contracts";

/** Called only after the independent fact-review confirmation. Adding a
 * statement never edits experience claims or any saved resume view. */
export function approveCareerTaskStatement(base: FactBase, task: CareerTask, proposalId: string, now = new Date().toISOString(), supersedes?: string): FactBase {
  const proposal = task.facts.find(item => item.id === proposalId && item.status === "proposed");
  if (!proposal) throw new Error("个人事实提案已变化，请重新审阅。");
  const evidence = proposal.evidenceIds.map(id => {
    const source = task.evidence.find(item => item.id === id);
    if (!source) throw new Error("来源记录缺失，未写入长期事实。");
    return { id: source.id, hash: source.hash, excerpt: source.excerpt, label: source.label, kind: source.kind };
  });
  if (!evidence.some(item => item.kind === "user_statement" && item.excerpt.includes(proposal.text.trim()))) throw new Error("此提案没有对应的本人陈述原话，未作为个人事实写入。");
  if (supersedes && !base.personalStatements?.some(item => item.id === supersedes)) throw new Error("待修正的旧陈述不存在。");
  const entry = PersonalStatementSchema.parse({ id: `career-fact:${task.id}:${proposal.id}`, text: proposal.text,
    kind: "user_statement", taskId: task.id, evidence, approvedAt: now, ...(supersedes ? { supersedes } : {}),
  });
  const existing = base.personalStatements?.find(item => item.id === entry.id);
  if (existing) {
    if (existing.text !== entry.text || JSON.stringify(existing.evidence) !== JSON.stringify(entry.evidence) || existing.supersedes !== entry.supersedes) throw new Error("同一提案已经保存了不同内容，未覆盖。");
    return base;
  }
  return { ...base, updatedAt: now, personalStatements: [...base.personalStatements ?? [], entry] };
}
