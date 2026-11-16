import type { InventorySession } from "@better-me/agent-contracts";
import type { PersonalStatement } from "@better-me/core";
import { writingTargetKey, type WritingSource } from "./resume-copilot";

/** Join by the confirmed answer and stable field identity, never by title, wording or list position. */
export function inventoryRefinements(session: InventorySession | undefined, visible: WritingSource[]) {
  const result = new Map<string, { disposition:"feature"|"compress"; fields: WritingSource[]; statements: PersonalStatement[] }>();
  if (session?.phase !== "confirmed" || !session.receipt) return result;
  const { source, receipt } = session;
  const groups = new Map(source.groups.map(g => [g.id, g]));
  const selected = new Set(receipt.selected);
  const answers = new Map(session.answers.filter(a => selected.has(a.id)).map(a => [a.id, a]));
  const choices = new Map(receipt.strategy.map(s => [s.groupId,s.disposition]));
  const fields = new Map<string, WritingSource[]>(), counts = new Map<string, number>();
  for (const f of visible) {
    if (f.targetRef.kind !== "claim_text" || f.quote || !f.text.trim()) continue;
    const key = writingTargetKey(f.targetRef), id = f.targetRef.experienceId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!fields.has(id)) fields.set(id, []);
    fields.get(id)!.push(f);
  }
  for (const statement of receipt.statements) {
    const b = statement.inventoryBinding, group = b && groups.get(b.groupId);
    const disposition = group && choices.get(group.id);
    if (!b?.experienceId || !group || group.experienceId !== b.experienceId || (disposition !== "feature" && disposition !== "compress")
      || statement.taskId !== session.id || b.documentId !== source.documentId || b.resumeId !== source.resumeId
      || b.fingerprint !== source.fingerprint || !statement.evidence.some(e => {
        const a = answers.get(e.id);
        return a?.target === group.id && a.text === statement.text && e.kind === "user_statement" && e.excerpt === a.text;
      })) continue;
    if (!result.has(group.id)) {
      const candidates = (fields.get(b.experienceId) ?? []).filter(f => counts.get(writingTargetKey(f.targetRef)) === 1);
      if (!candidates.length) continue;
      result.set(group.id, { disposition, fields: candidates, statements: [] });
    }
    result.get(group.id)!.statements.push(statement);
  }
  return result;
}
