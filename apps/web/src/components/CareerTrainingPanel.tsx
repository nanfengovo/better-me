import { useState } from "react";
import { careerJobSnapshotVersion, careerTrainingRequirements, type CareerTrainingJob, type CoachTrainingTarget, type TrainingView } from "@better-me/agent-contracts";
import { resolveCareerTrainingTarget, type CoachState, type CoachTask } from "../lib/career-coach/types";
import { useUiPreferences } from "../lib/ui-preferences";
import type { DrawerJobContext } from "./JdMatchDrawer";
import { TrainingKitPanel } from "./TrainingKitPanel";

type Plan = NonNullable<CoachState["activePlan"]>;
export type TrainingRequirementSelection = { quote: string; snapshotVersion: string; itemId?: string };
interface Props {
  state: CoachState;
  job: DrawerJobContext | null;
  confirmedGoal?: string;
  selectedTaskId?: string;
  onSelectTask: (id: string) => void;
  requested?: TrainingRequirementSelection;
  onUseRequirement: (quote: string) => void;
  disabled: boolean;
  onBind: (target: CoachTrainingTarget) => Promise<void>;
  onReview: (kit: TrainingView, signal: AbortSignal) => Promise<void>;
}

function selectableJob(job: DrawerJobContext | null): CareerTrainingJob | undefined {
  if (!job?.description.trim() || job.description.length > 30_000) return undefined;
  return { id: job.id, title: job.title, company: job.company, description: job.description, sourcePlatform: job.sourcePlatform, sourceUrl: job.sourceUrl };
}

export function CareerTrainingPanel(props: Props) {
  const { t } = useUiPreferences();
  const { state, requested, onUseRequirement, disabled, selectedTaskId, onSelectTask } = props;
  const [historyId, setHistoryId] = useState("");
  const [historyTaskId, setHistoryTaskId] = useState("");
  const job = selectableJob(props.job);
  const version = job && careerJobSnapshotVersion(job);
  const requirements = job ? careerTrainingRequirements(job) : [];
  const [chosen, setChosen] = useState<{ request: TrainingRequirementSelection; id: string }>();
  const candidates = requested && requested.snapshotVersion === version
    ? requirements.filter(item => item.originalQuote === requested.quote && (!requested.itemId || item.id === requested.itemId)) : [];
  const ambiguous = candidates.length > 1;
  const requestedItem = ambiguous
    ? candidates.find(item => chosen?.request === requested && item.id === chosen?.id) : candidates[0];
  const active = state.activePlan;
  const history = (state.planHistory ?? []).filter((plan, index, all) => plan.id !== active?.id && all.findIndex(p => p.id === plan.id) === index);
  const plan = history.find(p => p.id === historyId) ?? active;
  const historical = !!plan && plan.id !== active?.id;
  const tasks = plan?.plan.phases.flatMap(p => p.tasks) ?? [];
  const task = tasks.find(p => p.id === (historical ? historyTaskId : selectedTaskId)) ?? tasks[0];
  return <>
    {requested && <div className="coach-feedback">
      {ambiguous && <label>{t("这段原句出现了多次，请选择对应行", "This quote appears more than once. Choose the source line.")}
        <select value={requestedItem?.id ?? ""} onChange={event => setChosen({ request: requested, id: event.target.value })}>
          <option value="">{t("请选择", "Choose a line")}</option>
          {candidates.map(item => <option key={item.id} value={item.id}>{t(`原文第 ${item.sourceSpan?.line} 行`, `Source line ${item.sourceSpan?.line}`)} · {item.originalQuote}</option>)}
        </select>
      </label>}
      {requestedItem ? <>
        <p>{t("从岗位匹配选中的要求", "Requirement selected from job match")}</p>
        <blockquote>{requestedItem.originalQuote}</blockquote>
        <button type="button" disabled={disabled} onClick={() => onUseRequirement(requestedItem.originalQuote)}>
          {t("带入学习重点", "Use as plan focus")}
        </button>
      </> : !ambiguous && <p>{t("岗位正文已变化，请重新选择原句。", "The job description changed. Select a requirement again.")}</p>}
    </div>}
    {ambiguous && !requestedItem ? null : plan && task ? <section className="coach-result coach-training" aria-label={t("计划任务与训练", "Plan task and training")}>
      <div className="coach-section-heading"><h3>{t("计划任务与训练", "Plan task and training")}</h3></div>
      {history.length > 0 && <label>
        {t("计划版本", "Plan version")}
        <select value={historical ? plan.id : ""} onChange={e => { setHistoryId(e.target.value); setHistoryTaskId(""); }}>
          {active && <option value="">{t("当前", "Current")} · {active.plan.title}</option>}
          {history.map(p => <option key={p.id} value={p.id}>{t("历史", "History")} · {p.plan.title} · {p.startDate} · {p.id.slice(0, 8)}</option>)}
        </select>
      </label>}
      <label>
        {t("选择训练任务", "Choose a task for practice")}
        <select value={task.id} onChange={e => historical ? setHistoryTaskId(e.target.value) : onSelectTask(e.target.value)}>
          {tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <TaskTraining key={JSON.stringify([plan.id, task.id, requested?.itemId, requested?.quote, requested?.snapshotVersion, requestedItem?.id, version])} {...props}
        plan={plan} task={task} jobSnapshot={job} historical={historical} preferredItemId={requestedItem?.id}
        requireSelection={!!requested && !requestedItem}/>
    </section> : requestedItem ? <p className="coach-note">{t("先确认成长目标并采纳学习方案，再把这条要求关联到具体任务。", "Confirm your growth goal and adopt a plan, then link this requirement to a task.")}</p> : <TrainingKitPanel confirmedGoal={props.confirmedGoal}/>}
  </>;
}

function TaskTraining({ state, plan, task, jobSnapshot, historical, preferredItemId, requireSelection, disabled, onBind, onReview }: Props & {
  plan: Plan;
  task: CoachTask;
  jobSnapshot?: CareerTrainingJob;
  historical: boolean;
  preferredItemId?: string;
  requireSelection: boolean;
}) {
  const { t } = useUiPreferences();
  const targets = (state.trainingTargets ?? []).filter(item => item.planId === plan.id && item.taskId === task.id);
  const goalId = state.records.find(record => record.id === plan.id)?.basis.goalId;
  const canBind = !historical && !!goalId && !!state.goalConfirmations?.some(goal => goal.id === goalId) && !!jobSnapshot;
  const requirements = jobSnapshot ? careerTrainingRequirements(jobSnapshot) : [];
  const preferred = requirements.find(item => item.id === preferredItemId);
  const [choice, setChoice] = useState(() => preferred
    ? targets.find(item => item.itemId === preferred.id && item.quote === preferred.originalQuote && jobSnapshot && careerJobSnapshotVersion(item.job) === careerJobSnapshotVersion(jobSnapshot))?.id ?? "new"
    : requireSelection ? "new" : targets.at(-1)?.id ?? "new");
  const [itemId, setItemId] = useState(preferred?.id ?? (requireSelection ? "" : requirements[0]?.id ?? ""));
  const [competency, setCompetency] = useState(task.title);
  const [criterionIndex, setCriterionIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const target = targets.find(item => item.id === choice);
  const career = target && resolveCareerTrainingTarget(state, { workspaceKey: state.workspaceKey, targetId: target.id }, false);
  const item = requirements.find(requirement => requirement.id === itemId);
  async function bind() {
    if (!goalId || !jobSnapshot || !item || saving || !competency.trim()) return;
    setSaving(true);
    setError("");
    const target: CoachTrainingTarget = {
      id: crypto.randomUUID(), goalId, planId: plan.id, taskId: task.id,
      job: jobSnapshot, itemId: item.id, quote: item.originalQuote, competency: competency.trim(),
      ...(item.sourceSpan && item.parserVersion ? { quoteSource: { parserVersion: item.parserVersion, sourceSpan: item.sourceSpan } } : {}),
      criterionIndex, createdAt: new Date().toISOString(),
    };
    try {
      await onBind(target);
      setChoice(target.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("关联保存失败", "Could not save the association"));
    } finally { setSaving(false); }
  }
  return <>
    {targets.length > 0 && <label>
      {t("已关联的能力目标", "Linked competency target")}
      <select value={choice} disabled={saving} onChange={e => setChoice(e.target.value)}>
        {targets.map(target => <option key={target.id} value={target.id}>{target.competency} · {target.quote}</option>)}
        {!historical && <option value="new">{t("关联另一条要求", "Link another requirement")}</option>}
      </select>
    </label>}
    {choice === "new" && !historical && canBind && requirements.length > 0 && <div className="coach-compose">
      <label>{t("岗位原句", "Job requirement")}
        <select value={itemId} disabled={saving || disabled} onChange={e => setItemId(e.target.value)}>
          {requireSelection && <option value="">{t("请选择当前岗位原句", "Choose a requirement from this job")}</option>}
          {requirements.map(value => <option key={value.id} value={value.id}>{t(`原文第 ${value.sourceSpan?.line} 行`, `Source line ${value.sourceSpan?.line}`)} · {value.originalQuote}</option>)}
        </select>
      </label>
      {item && <blockquote>{item.originalQuote}</blockquote>}
      <label>{t("这次要验证的能力", "Competency to practice")}
        <textarea rows={2} maxLength={600} value={competency} disabled={saving || disabled} onChange={e => setCompetency(e.target.value)}/>
      </label>
      <label>{t("对应任务验收条件", "Task acceptance criterion")}
        <select value={criterionIndex} disabled={saving || disabled} onChange={e => setCriterionIndex(Number(e.target.value))}>
          {task.acceptanceCriteria.map((value, index) => <option key={index} value={index}>{value}</option>)}
        </select>
      </label>
      <button className="coach-primary" type="button" disabled={!item || !competency.trim() || disabled || saving} onClick={() => void bind()}>
        {saving ? t("保存关联…", "Saving link…") : t("确认能力目标并打开工坊", "Confirm target and open workshop")}
      </button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {career && target && <details className="coach-training-source">
      <summary>{t("查看关联岗位原文", "View linked job description")}</summary>
      <p>{[target.job.company, target.job.title, target.job.sourcePlatform].filter(Boolean).join(" · ")}</p>
      {target.job.sourceUrl && <p className="coach-muted">{target.job.sourceUrl}</p>}
      <p className="coach-prewrap">{target.job.description}</p>
    </details>}
    {career && !saving && !disabled && <TrainingKitPanel career={career} historical={historical} onReview={onReview}/>}
    {target && !career && <p role="alert">{t("原目标或任务记录无法核对，请从原计划查看。", "The original target or task cannot be reconciled.")}</p>}
    {!target && historical && <p>{t("此任务暂无训练关联。", "No training linked to this task.")}</p>}
    {!target && !historical && (!canBind || requirements.length === 0) && <>
      <p>{t("采纳带目标确认的学习方案，并选择含原文的岗位后即可关联任务。", "Adopt a confirmed plan and select a job description to link practice.")}</p>
      <TrainingKitPanel confirmedGoal={propsFallbackGoal(state, plan)}/>
    </>}
  </>;
}
function propsFallbackGoal(state: CoachState, plan: Plan) {
  const id = state.records.find(record => record.id === plan.id)?.basis.goalId;
  return state.goalConfirmations?.find(goal => goal.id === id)?.goal;
}
