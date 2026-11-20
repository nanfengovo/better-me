import type { ReactNode } from "react";
import { RetestConditions, TransferReport, TransferOrigin, trainingActionLabels, retestLabel } from "./TrainingTransferPanel";
import { WritingReviewRecord } from "./StudioWritingReview";
import { ArrowDown, ArrowUp } from "lucide-react";
import { TrainingAction, TrainingAttempt, TrainingFollowSource, TrainingTransferSource, TrainingTransferDecision, trainingTransferInput, type StudioEvidence, type TrainingPlan, type TrainingScreen, type TrainingWritingReview } from "@better-me/agent-contracts";
import { z } from "zod";
import { useUiPreferences } from "../lib/ui-preferences";

type OrderField = Extract<TrainingScreen["fields"][number], {control: "order"}>;

const savedObservation = z.object({
  kind: z.literal("studio"),
  goal: z.string().optional(),
  transferDecision: TrainingTransferDecision.optional(),
  transferFrom: TrainingTransferSource.optional(),
  followFrom: TrainingFollowSource.optional(),
  attempts: z.array(TrainingAttempt).min(1).max(2),
});

export function SavedTrainingEvidence({ text }: { text: string }) {
  const { t } = useUiPreferences();
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Historical evidence may be plain text. */ }
  const parsed = savedObservation.safeParse(value);
  if (!parsed.success) return <pre className="coach-code coach-history-scroll">{text}</pre>;
  const { transferFrom, transferDecision, goal, attempts } = parsed.data;
  const input = goal && trainingTransferInput(goal, attempts, transferFrom?.nextGoal);
  return <div className="training-studio-results">
    {transferFrom && <TransferOrigin source={transferFrom} />}
    {input && (transferDecision ? <TransferReport decision={transferDecision} evidence={input.evidence} retest={input.retest} /> : <RetestConditions retest={input.retest} />)}
    {parsed.data.followFrom && <StudioOrigin source={parsed.data.followFrom} />}
    {parsed.data.attempts.map(attempt => <section key={attempt.round}>
      <strong>{attempt.round === "practice" ? t("首练", "Practice") : t("换情境复测", "Transfer practice")}
        {" · "}{attempt.round === "retest" ? retestLabel({independence: attempt.usedPreview ? "assisted" : attempt.aids ? "independent" : "untracked", aids: attempt.aids}, t) : attempt.usedPreview ? t("使用过提示", "Used feedback") : t("独立作答", "Answered independently")}</strong>
      {attempt.question && attempt.feedback.evidence && <StudioResults screen={attempt.question} evidence={attempt.feedback.evidence} attempt={attempt}
        renderWriting={(entry, review) => {
          const original = "parts" in attempt.answer ? attempt.answer.parts[entry.key] : undefined;
          return review && original !== undefined ? <WritingReviewRecord review={review} original={original} /> : null;
        }} />}
    </section>)}
    <details><summary>{t("完整原答与题目版本", "Original answers and question versions")}</summary>
      <pre className="coach-code coach-history-scroll">{text}</pre></details>
  </div>;
}

function selectedOrder(value: string | undefined, field: OrderField): string[] | undefined {
  if (!value) return;
  try {
    const items: unknown = JSON.parse(value);
    if (Array.isArray(items) && items.length === field.options.length &&
        new Set(items).size === items.length && items.every(item => field.options.includes(item))) return items;
  } catch { /* Unrecognized historical answers can still be shown as originally entered. */ }
}

export function readableStudioAnswer(field: TrainingScreen["fields"][number] | undefined, value: string) {
  return field?.control === "order" ? selectedOrder(value, field)?.join(" → ") ?? value : value;
}

export function StudioOrderField({ field, value, onChange, disabled }: {
  field: OrderField; value: string | undefined; onChange: (value: string) => void; disabled: boolean;
}) {
  const { t } = useUiPreferences();
  const selected = selectedOrder(value, field), items = selected ?? field.options;
  function move(index: number, delta: number) {
    const next = [...items], target = index + delta;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(JSON.stringify(next));
  }
  return <fieldset className="training-order" disabled={disabled}>
    <legend>{field.label}</legend>
    <ol>{items.map((item, index) => <li key={item}>
      <span>{item}</span>
      <button type="button" aria-label={t("上移", "Move up") + " " + item}
        disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} aria-hidden="true" /></button>
      <button type="button" aria-label={t("下移", "Move down") + " " + item}
        disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} aria-hidden="true" /></button>
    </li>)}</ol>
    {!selected && <button type="button" onClick={() => onChange(JSON.stringify(items))}>
      {t("采用当前顺序", "Use this order")}
    </button>}
  </fieldset>;
}

export function StudioResults({ evidence, screen, attempt, onContinue, renderWriting }: {
  evidence: StudioEvidence[]; screen: TrainingScreen; attempt?: TrainingAttempt; onContinue?: (entry: StudioEvidence) => void;
  renderWriting?: (entry: StudioEvidence, review?: TrainingWritingReview) => ReactNode;
}) {
  const { t } = useUiPreferences();
  return <ol className="training-observations">
    {evidence.map(entry => {
      const field = screen.fields.find(item => item.key === entry.key);
      const review = attempt?.writingReviews?.find(item => item.key === entry.key && item.questionVersion === attempt.questionVersion);
      const nextLabel = review ? t("用提交的原答继续练", "Practice from the original answer") : t("按这条建议继续练", "Practice this next step");
      return <li key={entry.key}>
        <strong>{field?.label}</strong>
        <span>{entry.status === "recorded" ? t("已记录表达", "Response recorded")
          : entry.status === "missed" ? t("需要再练", "Needs practice") : t("符合本项规则", "Rule met")}</span>
        {(!review || !renderWriting) && <><p>{entry.detail}</p><p>{entry.nextStep}</p></>}
        {renderWriting?.(entry, review)}
        {onContinue && <button type="button" aria-label={nextLabel + " · " + (review ? field?.label : entry.nextStep)} onClick={() => onContinue(entry)}>
          {nextLabel}
        </button>}
      </li>;
    })}
  </ol>;
}

export function StudioOrigin({ source }: { source: NonNullable<TrainingPlan["followFrom"]> }) {
  const { t } = useUiPreferences();
  return <details className="training-origin">
    <summary>{source.useRewrite ? t("沿用的本人改写", "Your revised answer") : t("沿用的原答", "Original attempt")} · {source.kitTitle}</summary>
    <p>{source.questionLabel} · {source.round === "practice" ? t("首练", "Practice") : t("复测", "Retest")}
      {" · "}{source.useRewrite ? t("参考模型点评后改写", "Revised with model feedback") : source.usedPreview ? t("使用过提示", "Used feedback") : t("独立作答", "Answered independently")}
      {" · "}<span title={source.questionVersion}>v{source.questionVersion.slice(0, 10)}</span></p>
    <pre>{source.answer}</pre>
    <p>{source.detail}</p>
    <p>{source.nextStep}</p>
  </details>;
}

export function StudioActionPicker({ proposed, edited, onEdit, disabled }: {
  proposed?: TrainingAction[]; edited?: TrainingAction[]; onEdit: (actions?: TrainingAction[]) => void; disabled: boolean;
}) {
  const { t } = useUiPreferences();
  const selected = edited ?? proposed ?? [];
  function setActions(next: TrainingAction[]) {
    onEdit(next.length && next.join() !== proposed?.join() ? next : undefined);
  }
  const label = (action: TrainingAction) => t(...trainingActionLabels[action]);
  return <details className="training-action-picker">
    <summary>{t("调整练习方式", "Adjust how to practice")}{edited && " · " + edited.map(label).join(" → ")}</summary>
    <p>{t("Agent 建议", "Agent suggestion")} · {proposed?.length ? proposed.map(label).join(" → ") : t("根据目标安排", "Choose based on the goal")}</p>
    <div>
      <label>{t("先怎么练", "First action")}
        <select value={selected[0] ?? ""} disabled={disabled} onChange={e => {
          const first = TrainingAction.parse(e.target.value), second = selected[1];
          setActions(second ? [first, second === first ? selected[0]! : second] : [first]);
        }}>
          {!selected.length && <option value="" disabled>{t("选择一种方式", "Choose an action")}</option>}
          {TrainingAction.options.map(action => <option key={action} value={action}>{label(action)}</option>)}
        </select>
      </label>
      <label>{t("接着怎么练（选填）", "Next action (optional)")}
        <select value={selected[1] ?? ""} disabled={disabled || !selected[0]} onChange={e => {
          if (selected[0]) setActions(e.target.value ? [selected[0], TrainingAction.parse(e.target.value)] : [selected[0]]);
        }}>
          <option value="">{t("只练第一项", "Just the first action")}</option>
          {TrainingAction.options.filter(action => action !== selected[0]).map(action =>
            <option key={action} value={action}>{label(action)}</option>)}
        </select>
      </label>
    </div>
    {edited && <button type="button" disabled={disabled} onClick={() => onEdit(undefined)}>
      {t("恢复 Agent 建议", "Restore Agent suggestion")}
    </button>}
  </details>;
}
