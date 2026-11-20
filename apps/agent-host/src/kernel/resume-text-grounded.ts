import { z } from "zod";
import type { CareerTask, CareerTaskDecision, CareerTaskEvidence } from "@better-me/agent-contracts";
import { CareerTaskError, digest, splitSentences } from "../tasks/evidence.js";

type DraftDecision = Extract<CareerTaskDecision, { kind: "draft" }>;
type Patch = DraftDecision["patches"][number];
type Field = CareerTask["resume"]["fields"][number];
type EditChoice = { id: string; fieldId: string; supplement: string; patch: Patch };
const reject = (code: string): never => { throw new CareerTaskError(code, 422); };
const description = z.string().trim().min(1).max(2000);

export function fieldPlanSchema(fieldIds: string[]) {
  return z.object({
    kind: z.literal("field_plan"),
    selections: z.array(z.object({ fieldId: z.enum(fieldIds), include: z.boolean(), reason: description }).strict()).max(300),
    questions: z.array(z.object({ fieldId: z.enum(fieldIds), question: description }).strict()).max(5),
  }).strict();
}
export function groundedEditsSchema(ids: string[]) {
  return z.object({
    kind: z.literal("grounded_edits"),
    selectedIds: (ids.length ? z.array(z.enum(ids)) : z.array(z.string()).max(0)).max(100),
  }).strict();
}

export function originalFieldEvidence(task: CareerTask, field: Field) {
  const source = task.evidence.find(item => item.kind === "resume" && item.sourceId === `resume:${field.id}`
    && item.excerpt === field.originalText && item.hash === digest(field.originalText));
  return source ?? reject("original_resume_evidence_required");
}

export function fieldAnswers(task: CareerTask, fieldId: string): CareerTaskEvidence[] {
  if (!task.writingConfirmation || !task.writingPlan) return [];
  return task.writingPlan.questions.filter(q => q.fieldId === fieldId).flatMap(q => {
    const answer = task.writingConfirmation!.answers.find(a => a.questionId === q.id);
    const sourceId = `answer:${digest([fieldId, q.id])}`;
    const item = answer && task.evidence.find(e => e.kind === "user_statement" && e.sourceId === sourceId
      && e.excerpt === answer.text && e.hash === digest(answer.text));
    return item ? [item] : [];
  });
}

// A complete, same-field user confirmation can add a factual sentence. Preserve
// qualifiers and subject together, including any uncertainty in that sentence.
function usableSupplement(text: string): boolean {
  const trimmed = text.trim();
  return splitSentences(trimmed).length === 1 && !/[?？]\s*$/.test(trimmed)
    && !/^(?:未知|不清楚|不确定|无|没有(?:补充|其他)|暂无|暂不|保持原文|保留原文|同上|unknown|none|n\/a|keep (?:the )?original|no (?:change|details))(?:[。.!！\s、，,]|$)/iu.test(trimmed)
    && !/^(?:请|帮我|改成|写成|希望|只保留|不改|please\b|write\b|make me\b)/iu.test(trimmed);
}

export function groundedEditChoices(task: CareerTask): EditChoice[] {
  const choices: EditChoice[] = [];
  for (const fieldId of task.writingConfirmation?.selectedFieldIds ?? []) {
    const field = task.resume.fields.find(item => item.id === fieldId);
    if (!field) reject("writing_field_unknown");
    const original = originalFieldEvidence(task, field!);
    for (const answer of fieldAnswers(task, fieldId)) {
      const supplement = answer.excerpt.trim();
      if (!usableSupplement(supplement) || field!.originalText.includes(supplement)) continue;
      if (choices.some(choice => choice.fieldId === fieldId && choice.supplement === supplement)) continue;
      const proposedText = field!.originalText + (field!.originalText.endsWith("\n") ? "" : "\n") + supplement;
      const sentences = splitSentences(field!.originalText).map(text => ({ text, evidenceIds: [original.id] }));
      sentences.push({ text: supplement, evidenceIds: [original.id, answer.id] });
      if (proposedText.length > 12000 || sentences.length > 80) continue;
      const patch: Patch = {
        fieldId, targetRef: field!.targetRef, originalText: field!.originalText, proposedText,
        evidenceIds: [original.id, answer.id], sentences,
        rationale: "保留原有内容，追加本字段经本人明确确认的完整补充。请审核原句和补充后再保存。",
      };
      choices.push({ id: `E${choices.length + 1}`, fieldId, supplement, patch });
    }
  }
  return choices;
}

export function materializeGroundedEdits(task: CareerTask, choices: EditChoice[], raw: unknown): DraftDecision {
  const parsed = groundedEditsSchema(choices.map(choice => choice.id)).safeParse(raw);
  if (!parsed.success) return reject("invalid_writing_edit_selection");
  // Repeating the identical catalog handle is idempotent. Different choices
  // for the same field remain conflicting and cannot create two edits.
  const ids = [...new Set(parsed.data.selectedIds)];
  const selected = new Map<string, EditChoice>();
  for (const id of ids) {
    const choice = choices.find(item => item.id === id)!;
    if (selected.has(choice.fieldId)) reject("duplicate_patch_target");
    selected.set(choice.fieldId, choice);
  }
  const unknowns: string[] = [];
  for (const fieldId of task.writingConfirmation!.selectedFieldIds) {
    const options = choices.filter(item => item.fieldId === fieldId);
    if (!selected.has(fieldId) && options.length === 1) selected.set(fieldId, options[0]!);
    if (!selected.has(fieldId)) unknowns.push(options.length
      ? `字段「${fieldId}」有多项本人补充待选择，本轮保留原文。`
      : `字段「${fieldId}」缺少可独立引用的本人确认单句，本轮保留原文。`);
    else if (options.length > 1) unknowns.push(`字段「${fieldId}」其余确认补充仍保存在本任务，需另行逐句审核。`);
  }
  return { kind: "draft", patches: Array.from(selected.values(), choice => choice.patch), unknowns };
}

// Earlier configured clients may still emit a full patch. Only accept novel
// text which is itself one complete same-field confirmed statement, or the
// deterministic original-plus-confirmation option. Never trust a free rewrite.
export function isVerbatimConfirmedEdit(task: CareerTask, patch: Patch): boolean {
  const before = splitSentences(patch.originalText), after = splitSentences(patch.proposedText);
  let i = 0, endBefore = before.length, endAfter = after.length;
  while (i < endBefore && i < endAfter && before[i] === after[i]) i++;
  while (endBefore > i && endAfter > i && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--; endAfter--;
  }
  if (endAfter - i !== 1) return false;
  const changed = after[i]!;
  if (endBefore - i !== 1) {
    return groundedEditChoices(task).some(choice => choice.fieldId === patch.fieldId && choice.patch.proposedText === patch.proposedText
      && choice.patch.evidenceIds.every(id => patch.evidenceIds.includes(id)));
  }
  let offset = 0;
  for (const part of before.slice(0, i)) offset = patch.originalText.indexOf(part, offset) + part.length;
  const start = patch.originalText.indexOf(before[i]!, offset);
  if (start < 0 || patch.proposedText !== patch.originalText.slice(0, start) + changed
    + patch.originalText.slice(start + before[i]!.length)) return false;
  return fieldAnswers(task, patch.fieldId).some(answer => usableSupplement(answer.excerpt)
    && changed === answer.excerpt.trim() && patch.evidenceIds.includes(answer.id)
    && (patch.sentences?.[i]?.evidenceIds ?? patch.evidenceIds).includes(answer.id));
}
