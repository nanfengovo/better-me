import {
  trainingTransferInput, type TrainingAction, type TrainingTransferAdvice, type TrainingTransferEvidence, type TrainingTransferInput, type TrainingView,
} from "@better-me/agent-contracts";
import { useUiPreferences } from "../lib/ui-preferences";
export const trainingActionLabels: Record<TrainingAction, [string, string]> = {
  order: ["调整顺序", "Arrange a sequence"],
  quantity: ["计算或预测数值", "Calculate or predict a number"],
  code: ["编写并运行函数", "Write and run a function"],
  write: ["用自己的话作答", "Respond in your own words"],
};

const phaseLabels: Record<TrainingTransferEvidence["phase"], [string, string]> = {
  practice: ["首答", "First attempt"],
  rewrite: ["本人改写", "Your revision"],
  retest: ["换情境复测", "Transfer retest"],
};

const directions: Record<TrainingTransferAdvice["direction"], [string, string]> = {
  extend: ["挑战新条件", "Try a new constraint"],
  reinforce: ["巩固薄弱处", "Reinforce a weak point"],
  verify: ["再做一次独立验证", "Check independently again"],
};

type Retest = Pick<TrainingTransferInput["retest"], "independence" | "aids" | "change">;
type Translate = (zh: string, en: string) => string;
export function retestLabel({ independence, aids }: Retest, t: Translate) {
  if (independence === "untracked") return t("独立性未记录", "Assistance not tracked");
  if (independence === "independent") return t("独立复测", "Independent retest");
  if (aids?.practiceReference && aids.preview) return t("已参考首练并试算", "Used the first attempt and preview feedback");
  if (aids?.practiceReference) return t("已参考首练", "Consulted the first attempt");
  return t("提交前看过试算反馈", "Used preview feedback before submitting");
}

export function RetestConditions({ retest }: { retest: Retest }) {
  const { t } = useUiPreferences();
  const change = retest.change;
  return <div className="training-transfer-source">
    <strong>{t("两轮条件对照", "Conditions across the two rounds")}</strong>
    {change ? <dl>
      <dt>{t("首练条件", "First condition")}</dt><dd>{change.before}</dd>
      <dt>{t("复测条件", "Retest condition")}</dt><dd>{change.after}</dd>
      <dt>{t("本次核对", "What this checks")}</dt><dd>{change.criterion}</dd>
    </dl> : <p>{t("这两轮没有可核对的条件变化记录，需换题再验证。", "A change in the tested condition was not recorded. Use a new exercise to verify transfer.")}</p>}
    <small>{t("作答时的帮助", "Assistance during the retest")} · {retestLabel(retest, t)}</small>
  </div>;
}

function evidenceLabel(item: TrainingTransferEvidence, retest: Retest, t: Translate) {
  if (item.phase === "retest") return retestLabel(retest, t);
  if (item.phase === "rewrite") {
    if (item.rewriteTiming === "after-retest") return t("复测后改写", "Revised after the retest");
    if (item.rewriteTiming === "before-retest") return t("复测前改写", "Revised before the retest");
    return t("改写与复测的先后未记录", "Revision timing unconfirmed");
  }
  return item.usedPreview ? t("提交前看过试算反馈", "Used preview feedback before submitting")
    : t("提交前未试算", "Submitted without preview feedback");
}

function SourceItem({ item, retest }: { item: TrainingTransferEvidence; retest: Retest }) {
  const { t } = useUiPreferences();
  return <div className="training-transfer-source">
    <strong>{item.question}</strong>
    <small>{evidenceLabel(item, retest, t)} · {item.status === "recorded" ? t("已记录表达", "Response recorded")
      : item.status === "met" ? t("符合本项规则", "Rule met") : t("未满足本项规则", "Rule missed")}</small>
    <blockquote>{item.answer}</blockquote>
    {item.reviewedQuote && <p>{t("首答中曾点评的原句", "Previously reviewed passage")} · {item.reviewedQuote}</p>}
    <p>{item.detail}</p>
  </div>;
}

function TransferEvidence({ input }: { input: TrainingTransferInput }) {
  const { t } = useUiPreferences();
  return <details className="training-transfer-input">
    <summary>{t("查看本次判断依据", "See the evidence for this decision")}</summary>
    <p>{t("练习目标", "Practice goal")} · {input.goal}</p>
    {input.overallGoal && <p>{t("长期目标", "Overall goal")} · {input.overallGoal}</p>}
    {(["practice", "rewrite", "retest"] as const).map(phase => {
      const round = phase === "retest" ? input.retest : input.practice;
      const entries = input.evidence.filter(item => item.phase === phase);
      return <section key={phase}>
        <h4>{t(...phaseLabels[phase])}</h4>
        {phase !== "rewrite" && <><p>{round.brief} · <span title={round.questionVersion}>v{round.questionVersion.slice(0, 8)}</span></p>
          {round.material.map((material, i) => <p className="training-transfer-material" key={i}>{material}</p>)}</>}
        {entries.map(item => <SourceItem key={item.id} item={item} retest={input.retest} />)}
        {!entries.length && phase === "rewrite" && <p>{t("本轮未提交首答改写。", "No revision of the first attempt was submitted.")}</p>}
      </section>;
    })}
  </details>;
}

export function TransferReport({ decision, evidence, retest }: { decision: TrainingTransferAdvice; evidence: TrainingTransferEvidence[]; retest: Retest }) {
  const { t } = useUiPreferences();
  return <div className="training-transfer-report">
      <RetestConditions retest={retest} />
      <p className="training-transfer-goal">{decision.nextGoal}</p>
      <p>{t(...directions[decision.direction])} · {decision.actions.map(action => t(...trainingActionLabels[action])).join(" → ")}</p>
      <h4>{t("为什么这样练", "Why this exercise")}</h4>
      <ul className="training-transfer-reasons">{decision.reasons.map(({ evidenceId, reason, answerQuote }) => {
        const item = evidence.find(entry => entry.id === evidenceId);
        return item && <li key={evidenceId}><strong>{t(...phaseLabels[item.phase])}</strong> · {evidenceLabel(item, retest, t)}
          <p>{reason}</p>
          {answerQuote && item.phase === "retest" && <><small>{t("本人作答原句", "Passage from your response")}</small><blockquote>{answerQuote}</blockquote></>}
          <details><summary>{t("核对这条作答", "Check this response")}</summary><SourceItem item={item} retest={retest} /></details>
        </li>;
      })}</ul>
  </div>;
}

export function TrainingTransferPanel({ kit, historical, disabled, onRecommend, onAdopt }: {
  kit: TrainingView; historical: boolean; disabled: boolean; onRecommend: () => void; onAdopt: () => void;
}) {
  const { t } = useUiPreferences();
  if (kit.kind !== "studio" || kit.origin !== "local" || !kit.saved || kit.stage !== "complete") return null;
  const input = trainingTransferInput(kit.goal, kit.attempts, kit.transferFrom?.nextGoal);
  if (!input) return <p>{t("这份记录缺少可对照的原题或作答，可以从工坊开始一份新练习。", "This record lacks a comparable question or answer. You can start a new exercise in the workshop.")}</p>;
  const decision = kit.transferDecision;
  const currentAdvice = !decision || decision.direction !== "extend" || !!input.retest.change;
  if (historical && !decision) return null;
  return <section className="training-transfer" aria-label={t("复测后的下一步", "After your retest")}>
    <h3>{t("复测后的下一步", "After your retest")}</h3>
    {decision ? <TransferReport decision={decision} evidence={input.evidence} retest={input.retest} /> : <p>{input.retest.independence !== "independent"
      ? retestLabel(input.retest, t) + " · " + t("可以请 Agent 对照两轮作答，安排独立验证。", "Ask the Agent to compare both rounds and plan an independent check.")
      : t("把首答、已提交的改写和这次复测放在一起，请 Agent 找出下一项值得练的能力。", "Ask the Agent to compare your first attempt, any revision and this retest to suggest the next skill to practice.")}</p>}
    {!decision && <RetestConditions retest={input.retest} />}
    <TransferEvidence input={input} />
    {!historical && currentAdvice && (decision ? <>
      <small>{t("开始后，本机模型会按这项目标和练法生成新题。", "Starting creates a new exercise with the recommended goal and activity using your local model.")} {decision.model}</small>
      <button className="training-primary" type="button" disabled={disabled} onClick={onAdopt}>{t("按建议开始下一练", "Start the recommended exercise")}</button>
    </> : <>
      <small>{t("同意后由本机模型根据上述记录判断一次。", "With your consent the local model will review these records once.")} {kit.model}</small>
      <button className="training-primary" type="button" disabled={disabled} onClick={onRecommend}>{t("请 Agent 建议下一步", "Ask the Agent for the next step")}</button>
    </>)}
  </section>;
}

export function TransferOrigin({ source }: { source: NonNullable<TrainingView["transferFrom"]> }) {
  const { t } = useUiPreferences();
  return <details className="training-origin">
    <summary>{t("本次练习的推荐依据", "Why this practice was recommended")} · {source.kitTitle}</summary>
    <TransferReport decision={source} evidence={source.citations} retest={{independence: source.retestIndependence, aids: source.retestAids, change: source.retestChange}} />
  </details>;
}
