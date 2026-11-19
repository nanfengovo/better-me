import { useId, useState } from "react";
import type { TrainingCommand, TrainingWritingReview } from "@better-me/agent-contracts";
import { useUiPreferences } from "../lib/ui-preferences";

export type WritingCommand = Extract<TrainingCommand, { action: "review-writing" | "save-rewrite" }>;

export function WritingReviewRecord({ original, review }: { original: string; review: TrainingWritingReview }) {
  const { t } = useUiPreferences();
  return <div className="training-writing-record">
    <p><strong>{t("本机模型点评", "Local model feedback")}</strong> · <small title={review.modelDigest}>{review.model}</small></p>
    <blockquote>{review.quote}</blockquote>
    <p>{review.comment}</p>
    <p><strong>{t("试着改一处", "Try one revision")}</strong> · {review.revisionPrompt}</p>
    <dl className="training-writing-versions">
      <div><dt>{t("提交的原答", "Submitted answer")}</dt><dd>{original}</dd></div>
      {review.rewrite && <div><dt>{t("点评后本人改写", "Your revision after feedback")}</dt><dd>{review.rewrite.answer}</dd></div>}
    </dl>
  </div>;
}

export function StudioWritingReview({ original, review, goal, model, material, question, target, disabled, historical, onCommand, onContinue }: {
  original: string; review?: TrainingWritingReview; goal: string; model: string; material: string[]; question: string;
  target: Pick<WritingCommand, "revision" | "round" | "key" | "questionVersion">;
  disabled: boolean; historical: boolean; onCommand: (command: WritingCommand) => void; onContinue: () => void;
}) {
  const { t } = useUiPreferences();
  const [draft, setDraft] = useState(original);
  const draftId = useId();
  if (!review) return historical ? null : <details className="training-writing-consent">
    <summary>{t("点评这项作答", "Review this answer")}</summary>
    <p>{t("同意后，以下内容将交给本机模型点评一次。", "With your consent, the local model will review the following once.")} <strong>{model}</strong></p>
    <dl className="training-writing-input">
      <dt>{t("目标", "Goal")}</dt><dd>{goal}</dd>
      <dt>{t("本题材料", "Question material")}</dt><dd>{material.join("\n")}</dd>
      <dt>{t("问题", "Question")}</dt><dd>{question}</dd>
      <dt>{t("提交的原答", "Submitted answer")}</dt><dd>{original}</dd>
    </dl>
    <button type="button" disabled={disabled} onClick={() => onCommand({
      action: "review-writing", ...target, consent: true, requestId: crypto.randomUUID(),
    })}>{t("同意用本机模型点评", "Allow one local model review")}</button>
  </details>;
  return <div className="training-writing">
    <WritingReviewRecord original={original} review={review} />
    {review.rewrite ? !historical && <button type="button" disabled={disabled} onClick={onContinue}>
      {t("用这次改写继续练", "Practice from this revision")}
    </button> : !historical && <>
      <label htmlFor={draftId}>{t("我的改写", "My revision")}</label>
      <textarea id={draftId} value={draft} rows={3} maxLength={400} disabled={disabled} onChange={event => setDraft(event.target.value)} />
      <button type="button" disabled={disabled || !draft.trim() || draft === original || draft.length > 400}
        onClick={() => onCommand({ action: "save-rewrite", ...target, answer: draft })}>{t("保存我的改写", "Save my revision")}</button>
    </>}
  </div>;
}
