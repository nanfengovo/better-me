import { useEffect, useRef, useState } from "react";
import { BookOpen, Boxes, ChevronRight, FlaskConical } from "lucide-react";
import { trainingRewriteSourceDetail, trainingWritingMaterial } from "@better-me/agent-contracts";
import type {
  TrainingAnswer,
  TrainingAction,
  TrainingAttempt,
  TrainingCommand,
  TrainingExampleKind,
  StudioEvidence,
  TrainingFeedback,
  TrainingScreen,
  TrainingCareerContext,
  TrainingPlan,
  TrainingStart,
  TrainingSummary,
  TrainingView,
  TrainingWritingReview,
} from "@better-me/agent-contracts";
import { captureIdentityLease, currentPrincipal } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";
import { defaultLearningClient } from "../services/learning-client";
import { readableStudioAnswer, StudioActionPicker, StudioOrderField, StudioOrigin, StudioResults } from "./StudioExercise";
import { StudioWritingReview, type WritingCommand } from "./StudioWritingReview";
import { retestLabel, TrainingTransferPanel, TransferOrigin } from "./TrainingTransferPanel";
import "./training-kit.css";

const starters = {
  concurrency: {
    goal: "处理乐观并发更新后的业务冲突",
    evidence: "两个请求读取同一版库存，第一次提交后不知道第二次应如何重新校验并决定。",
  },
  canvas: {
    goal: "一分钟讲清工作进展",
    evidence: "开会总是先铺很多背景，别人不知道我希望他们做什么。",
  },
  rewrite: {
    goal: "把英文工作邮件写简短",
    evidence: "为了客气常常写一大段，压缩后又会漏掉请求或截止日期。",
  },
  dependency: {
    goal: "学会估算并行任务的交付日期",
    evidence: "单项工期能估算，但一项任务延期后，我说不准整个项目会不会推迟。",
  },
};
const problems: Record<string, [string, string]> = {
  training_retest_repeated: ["复测题与首题过于相似。请调整练习描述，重新分析并生成换情境题。", "The retest repeats the first exercise. Adjust the description and generate a new pair."],
  training_interview_source_changed: ["练习与原面试问题或验收标准不匹配。请从面试复盘重新打开。", "The exercise and the interview criterion do not match. Reopen it from interview feedback."],
  training_career_target_changed: [
    "目标、计划或岗位关联已变化，或尚未保存。请回到当前任务核对后再开始。",
    "The target, plan or job link changed or has not been saved. Review the current task first.",
  ],
  training_follow_source_changed: [
    "引用的原答或任务已变更。请重新打开已保留的练习，选择要继续的那一步。",
    "The source attempt or its task changed. Reopen the saved exercise and choose the step to continue.",
  ],
  training_writing_unavailable: ["请在已保留的本机练习中选择一项已提交的开放作答。", "Choose a submitted written response in a saved local exercise."],
  training_writing_already_reviewed: ["这项已有点评，请重新打开练习查看。", "Reopen the exercise to see the existing review."],
  training_writing_review_failed: ["这次未取得可用点评。确认本机模型可用后，可以手动重试。", "No usable review was received. Check the local model before trying again."],
  training_writing_quote_invalid: ["模型引用与原答不符。可以重新授权点评。", "The model's quote did not match your answer. You can request another review."],
  training_writing_model_changed: ["这份练习使用的本机模型版本已变化，请恢复原版本后重试。", "Restore the original local model version to review this exercise."],
  training_rewrite_exists: ["这项已有本人改写，请重新打开练习查看。", "Reopen the exercise to see the saved revision."],
  training_rewrite_unchanged: ["请先修改原答，再保存这次改写。", "Edit the original answer before saving your revision."],
  training_writing_review_required: ["请先完成这项作答的点评。", "Request a review of this answer first."],
  training_practice_reference_required: ["查看首练前请先确认本轮记录为使用参考。", "Confirm that this retest used a reference before opening your first attempt."],
  training_transfer_actions_changed: ["推荐的练法已变化，请重新打开父练习核对。", "The recommended actions changed. Reopen the source exercise to review them."],
  training_transfer_unavailable: ["这份练习还没有两轮完整的已保存作答。", "Two complete saved rounds are needed."],
  training_transfer_failed: ["本次判断未完成，请检查本机模型后重试。", "The review did not finish. Check your local model before trying again."],
  training_transfer_invalid: ["本次建议未能用作答记录说明理由，可以再请求一次。", "The suggestion could not be grounded in these answers. You can request another review."],
  training_transfer_source_changed: ["推荐依据已变化，请重新打开父练习，查看最新作答和建议。", "The evidence changed. Reopen the source exercise for the latest answers and recommendation."],
  training_transfer_already_recommended: ["这组作答已有建议，请重新打开练习查看。", "These answers already have a recommendation. Reopen the saved exercise to see it."],
  training_transfer_model_changed: ["本机模型版本已变化。请恢复此练习使用的模型版本后再试。", "Restore the model version used by this exercise before trying again."],
  training_answer_incomplete: ["请完成题目中的每一项再提交。", "Complete each step before submitting."],
  training_local_diagnosis_failed: [
    "无法完成本机模型分析。请确认本机 Ollama 正在运行（当前仅放行已审计版本 0.40.15 / 0.40.16）且已安装对应模型标签；没有转用云端。",
    "Local model analysis failed. Check that local Ollama (audited 0.40.15 / 0.40.16 only) is running and the model tag is installed. No cloud fallback.",
  ],
  training_design_invalid: [
    "模型生成的两道题没有通过结构或换题检查，没有创建应用。可调整目标后明确重试。",
    "The generated exercises failed validation. No app was created.",
  ],
  training_program_rejected: [
    "没有取得通过独立检查的程序；未创建应用，也不会自动重新生成。",
    "No independently verified program was obtained. No app was created or automatically regenerated.",
  ],
  training_runtime_mismatch: [
    "沙箱计算与独立答案不符；本次未计入学习记录。",
    "Sandbox result disagrees with the reference. No attempt was recorded.",
  ],
  training_plan_expired: [
    "临时建议已过期，请重新分析。",
    "This temporary plan expired. Request a new analysis.",
  ],
  training_plan_already_used: [
    "这个建议已执行过，不会自动重复生成。请查看当前版本或重新分析。",
    "This plan was already used. No generation was replayed.",
  ],
  training_revision_conflict: [
    "这个版本已在另一窗口更新，请重新打开已保留版本。",
    "This version changed in another window. Reopen it from your library.",
  ],
  training_round_changed: [
    "换题复测现已开放。请先查看新题，再提交；旧答案没有计入复测。",
    "The retest has opened. Load the new question before submitting; the old answer was not recorded.",
  ],
  training_kit_not_found: [
    "这个试用版本已结束或不可访问。",
    "This preview ended or is unavailable.",
  ],
};
function initialValues(kit: TrainingView): Record<string, string> {
  // Restore only the answer to the displayed scenario; never seed a fresh retest.
  const round =
    kit.stage === "waiting"
      ? "practice"
      : kit.stage === "complete"
        ? "retest"
        : undefined;
  const prior = round && kit.attempts.find((v) => v.round === round)?.answer;
  if (prior) {
    if ("parts" in prior) return { ...prior.parts };
    if ("answer" in prior) return { answer: prior.answer };
    return { delay: String(prior.delay), prediction: String(prior.prediction) };
  }
  return Object.fromEntries(
    kit.screen.fields.map((f) => [
      f.key,
      f.key === "part3" && kit.kind === "concurrency" ? "" : "initial" in f ? String(f.initial) : "",
    ]),
  );
}
function describeAnswer(a: TrainingAnswer, screen?: TrainingScreen) {
  if ("parts" in a) return Object.entries(a.parts).map(([key, value]) =>
    readableStudioAnswer(screen?.fields.find(field => field.key === key), value)).join(" · ");
  return "answer" in a ? a.answer : `+${a.delay} → ${a.prediction}`;
}
type InterviewPractice = { followUpId: string; criterion: string; evidence: string; savedKit?: { id: string; version: string } };

export function TrainingKitPanel({
  confirmedGoal,
  career,
  interview,
  historical = false,
  onReview,
}: { confirmedGoal?: string; career?: TrainingCareerContext; interview?: InterviewPractice; historical?: boolean; onReview?: (kit: TrainingView, signal: AbortSignal) => Promise<void> } = {}) {
  return (
    <Workshop
      key={JSON.stringify([currentPrincipal()?.id ?? "guest", career, interview?.followUpId, interview?.criterion, interview?.savedKit, historical])}
      owner={currentPrincipal()?.id}
      confirmedGoal={confirmedGoal}
      career={career}
      interview={interview}
      historical={historical}
      onReview={onReview}
    />
  );
}
function Workshop({
  owner,
  confirmedGoal,
  career,
  interview,
  historical,
  onReview,
}: {
  owner?: string;
  confirmedGoal?: string;
  career?: TrainingCareerContext;
  interview?: InterviewPractice;
  historical: boolean;
  onReview?: (kit: TrainingView, signal: AbortSignal) => Promise<void>;
}) {
  const { t, locale } = useUiPreferences(),
    client = defaultLearningClient.training;
  const [goal, setGoal] = useState(interview?.criterion ?? career?.competency ?? ""),
    [evidence, setEvidence] = useState(interview?.evidence.slice(0, 800) ?? ""),
    [model, setModel] = useState("gemma4:e2b-it-qat");
  const [plan, setPlan] = useState<TrainingPlan>(),
    [kit, setKit] = useState<TrainingView>(),
    [shelf, setShelf] = useState<TrainingSummary[]>([]);
  const [values, setValues] = useState<Record<string, string>>({}),
    [feedback, setFeedback] = useState<TrainingFeedback>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(""),
    [discard, setDiscard] = useState(false),
    [planUsed, setPlanUsed] = useState(false);
  const [editedActions, setEditedActions] = useState<TrainingAction[]>();
  const [historyOpened, setHistoryOpened] = useState(false);
  const [continuation, setContinuation] = useState<{
    ref: NonNullable<TrainingStart["followFrom"]>; source: NonNullable<TrainingPlan["followFrom"]>; career?: TrainingCareerContext; interviewRef?: string;
  }>();
  const target = career ?? continuation?.career;
  const interviewRef = interview?.followUpId ?? continuation?.interviewRef;
  function removeContinuation() {
    setContinuation(undefined);
  }
  const notesInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (continuation && !kit && !plan) notesInput.current?.focus();
  }, [continuation, kit, plan]);
  const current = useRef<AbortController | null>(null);
  const scopeMatches = (item: { career?: TrainingCareerContext; interviewRef?: string; goal?: string }) =>
    (!interview || (item.interviewRef === interview.followUpId && (item.goal === undefined || item.goal === interview.criterion))) &&
    (!career || (item.career?.workspaceKey === career.workspaceKey &&
      item.career.targetId === career.targetId && item.career.planId === career.planId &&
      item.career.taskId === career.taskId && item.career.requirement.snapshotVersion === career.requirement.snapshotVersion));
  useEffect(() => {
    if (!owner) return;
    const ac = new AbortController();
    void client
      .list(ac.signal)
      .then((x) => {
        if (!ac.signal.aborted) setShelf(x);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError("training_shelf_unavailable");
      });
    return () => {
      ac.abort();
      current.current?.abort();
    };
  }, [client, owner]);
  const linkedId = interview?.savedKit?.id, linkedVersion = interview?.savedKit?.version;
  const criterion = interview?.criterion;
  const [openingLinkedKit, setOpeningLinkedKit] = useState(!!linkedId);
  useEffect(() => {
    if (!owner || !linkedId) return;
    const ac = new AbortController();
    void client.get(linkedId, ac.signal).then(saved => {
      if (ac.signal.aborted) return;
      if (saved.ownerId !== owner || !saved.saved || saved.id !== linkedId || saved.version !== linkedVersion ||
          saved.interviewRef !== interviewRef || saved.goal !== criterion) throw new Error("training_interview_source_changed");
      setKit(saved);
      setValues(initialValues(saved));
    }).catch(e => {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "training_kit_not_found");
    }).finally(() => { if (!ac.signal.aborted) setOpeningLinkedKit(false); });
    return () => ac.abort();
  }, [owner, client, interviewRef, criterion, linkedId, linkedVersion]);
  async function perform(
    label: string,
    work: (s: AbortSignal) => Promise<() => void | Promise<void>>,
  ) {
    if (!owner || current.current) return;
    const ac = new AbortController(),
      lease = captureIdentityLease();
    current.current = ac;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const apply = await work(AbortSignal.any([ac.signal, lease.signal]));
      lease.assert();
      if (!ac.signal.aborted) await apply();
    } catch (e) {
      if (!ac.signal.aborted && !lease.signal.aborted)
        setError(e instanceof Error ? e.message : "training_request_failed");
    } finally {
      if (current.current === ac) {
        current.current = null;
        if (!ac.signal.aborted) setBusy("");
      }
    }
  }
  function open(k: TrainingView) {
    if (k.ownerId !== owner || !scopeMatches(k)) {
      setError(interview ? "training_interview_source_changed" : "training_career_target_changed");
      return;
    }
    removeContinuation();
    setHistoryOpened(false);
    setKit(k);
    setPlan(undefined);
    setValues(initialValues(k));
    setFeedback(undefined);
    setDiscard(false);
  }
  function clear() {
    setEditedActions(undefined);
    setPlan(undefined);
    setPlanUsed(false);
    setKit(undefined);
    setDiscard(false);
    setValues({});
    setFeedback(undefined);
    setError("");
  }
  async function analyze(example?: TrainingExampleKind) {
    if (historical) return;
    const g = target?.competency ?? (example ? starters[example].goal : goal.trim()),
      e = example ? starters[example].evidence : evidence.trim();
    await perform(t("分析中…", "Analyzing…"), async (signal) => {
      const v = await client.plan(
        {
          requestId: crypto.randomUUID(),
          goal: g,
          evidence: e,
          ...(interviewRef ? { interviewRef } : {}),
          ...(continuation && !example ? { followFrom: continuation.ref } : {}),
          ...(target ? { careerTarget: { workspaceKey: target.workspaceKey, targetId: target.targetId } } : {}),
          consent: true,
          engine: example
            ? { type: "example", example }
            : { type: "local", model: model.trim() },
        },
        signal,
      );
      if (interview && !scopeMatches(v)) throw new Error("training_interview_source_changed");
      return () => {
        clear();
        setGoal(g);
        setEvidence(e);
        setPlan(v);
      };
    });
  }
  async function act(action: "explore" | "submit" | "keep" | "discard" | "view-practice") {
    if (!kit) return;
    let command: TrainingCommand;
    if (action === "explore" || action === "submit") {
      const codeField = kit.screen.fields.find(field => field.control === "code");
      const answer: TrainingAnswer =
        kit.kind === "canvas" || kit.kind === "concurrency" || kit.kind === "studio"
          ? { parts: values, ...(codeField ? { codeKey: codeField.key } : {}) }
          : kit.kind === "rewrite"
            ? { answer: (values.answer ?? "").trim() }
            : {
                delay: Number(values.delay),
                prediction: Number(values.prediction),
              };
      if (kit.kind === "studio" && "parts" in answer && kit.screen.fields.some(field => {
        const value = answer.parts[field.key]?.trim();
        return !value || (field.control === "quantity" && !/^[+-]?\d{1,9}$/.test(value));
      })) {
        setError("training_answer_incomplete");
        return;
      }
      if (
        "parts" in answer
          ? kit.kind === "concurrency"
            ? !answer.parts.part1 || !answer.parts.part2 || !/^\d{1,3}$/.test(answer.parts.part3 ?? "")
            : !Object.values(answer.parts).some((s) => s.trim())
          : "answer" in answer
            ? !answer.answer
            : !values.prediction ||
              !Number.isInteger(answer.prediction) ||
              answer.prediction < 1 ||
              answer.prediction > 150
      ) {
        setError(
          t(
            "请先填写你的作答或有效的天数。",
            "Enter your answer or a valid forecast first.",
          ),
        );
        return;
      }
      command = {
        action,
        revision: kit.revision,
        round:
          kit.stage === "complete" || kit.stage === "retest"
            ? "retest"
            : "practice",
        answer,
      };
    } else command = { action, revision: kit.revision };
    await perform(t("正在核对…", "Checking…"), async (signal) => {
      const r = await client.command(kit.id, command, signal);
      return () => {
        setDiscard(false);
        if (!r.kit) {
          setShelf((prior) => prior.filter((s) => s.id !== kit.id));
          clear();
          setNotice(
            t("此版本已移出，不再可运行。", "This version can no longer run."),
          );
          return;
        }
        if (r.kit.id !== kit.id || r.kit.ownerId !== owner || r.kit.version !== kit.version || !scopeMatches(r.kit)) throw new Error("training_revision_conflict");
        setKit(r.kit);
        if (action === "view-practice") setHistoryOpened(true);
        if (r.kit.saved) {
          const k = r.kit;
          setShelf((prior) => [
            {
              id: k.id,
              ownerId: k.ownerId,
              version: k.version,
              title: k.title,
              stage: k.stage,
              origin: k.origin,
              career: k.career,
              interviewRef: k.interviewRef,
            },
            ...prior.filter((s) => s.id !== k.id),
          ]);
        }
        if (r.feedback) {
          const recordedStudio = action === "submit" && kit.kind === "studio";
          setFeedback(recordedStudio ? undefined : r.feedback);
          if (recordedStudio) setValues(initialValues(r.kit));
        }
        if (action === "keep")
          setNotice(
            t(
              "已保留这个版本；重开不会重新生成。",
              "Version kept. Reopening does not call the model.",
            ),
          );
      };
    });
  }
  const unknown = t(
    "请求未完成。检查本机 Host，或重新打开已保留版本；不会自动重试。",
    "Request incomplete. Check the Host or reopen your saved version; nothing is retried automatically.",
  );
  const plainError = problems[error]
    ? t(...problems[error])
    : error === "training_shelf_unavailable"
      ? t("暂未读到本账号工具架。", "Could not read your library.")
      : error.startsWith("training_") || error.includes("fetch")
        ? unknown
        : error;
  const matchingShelf = shelf.filter(scopeMatches);
  const association = kit?.career ?? plan?.career ?? target;
  const sourceAttempt = kit?.followFrom ?? plan?.followFrom;
  const latestAttempt = kit?.attempts.at(-1);
  const studioRecorded = kit?.kind === "studio" && (kit.stage === "waiting" || kit.stage === "complete");
  const studioReport = kit?.kind === "studio" ? feedback ?? (studioRecorded ? latestAttempt?.feedback : undefined) : undefined;
  const referenceLocked = kit?.kind === "studio" && kit.stage === "retest" && !kit.retestAids?.practiceReference;
  async function reviewCommand(command: WritingCommand | Extract<TrainingCommand, {action: "recommend-transfer"}>) {
    if (!kit?.saved) return;
    const label = command.action === "recommend-transfer" ? t("正在对照两轮作答…", "Comparing both rounds…")
      : command.action === "review-writing" ? t("本机模型正在点评…", "Reviewing locally…") : t("正在保存改写…", "Saving revision…");
    await perform(label, async signal => {
      const { kit: updated } = await client.command(kit.id, command, signal);
      if (!updated || updated.ownerId !== owner || updated.id !== kit.id || updated.version !== kit.version || !scopeMatches(updated))
        throw new Error("training_revision_conflict");
      return () => {
        setKit(updated);
        if (kit.stage !== updated.stage) {
          setValues(initialValues(updated));
          setFeedback(undefined);
        }
      };
    });
  }
  async function startRecommended() {
    if (!kit?.model || !kit.transferDecision || historical) return;
    const { id, version, model: sourceModel, career: sourceCareer, transferDecision } = kit;
    const transferFrom = { kitId: id, version, evidenceVersion: transferDecision.evidenceVersion };
    await perform(t("正在生成推荐的练习…", "Creating the recommended exercise…"), async signal => {
      const nextPlan = await client.plan({
        goal: kit.goal, evidence: "", consent: true, requestId: crypto.randomUUID(), transferFrom,
        engine: { type: "local", model: sourceModel },
        ...(kit.interviewRef ? { interviewRef: kit.interviewRef } : {}),
        ...(sourceCareer ? { careerTarget: { workspaceKey: sourceCareer.workspaceKey, targetId: sourceCareer.targetId } } : {}),
      }, signal);
      if (signal.aborted) throw signal.reason;
      const matches = (source: TrainingPlan["transferFrom"]) => source?.kitId === id && source.version === version
        && source.evidenceVersion === transferFrom.evidenceVersion;
      if (!matches(nextPlan.transferFrom) || !scopeMatches(nextPlan)) throw new Error("training_transfer_source_changed");
      const child = await client.build(nextPlan.id, crypto.randomUUID(), signal);
      if (!matches(child.transferFrom)) throw new Error("training_transfer_source_changed");
      return () => open(child);
    });
  }
  function writingStep(entry: StudioEvidence, attempt: TrainingAttempt, review?: TrainingWritingReview) {
    if (!kit?.saved || kit.kind !== "studio" || kit.origin !== "local" || !kit.model || !kit.modelDigest || !attempt.questionVersion ||
        !attempt.question || !("parts" in attempt.answer) || entry.status !== "recorded") return null;
    const question = attempt.question, field = question.fields.find(item => item.key === entry.key);
    const original = attempt.answer.parts[entry.key];
    if (field?.control !== "write" || original === undefined) return null;
    return <StudioWritingReview key={[kit.id, kit.version, attempt.round, attempt.questionVersion, entry.key].join("/")}
      original={original} review={review} goal={kit.goal} model={kit.model}
      question={field.label} material={trainingWritingMaterial(question)}
      target={{revision: kit.revision, round: attempt.round, key: entry.key, questionVersion: attempt.questionVersion}}
      disabled={!!busy} historical={historical} onCommand={command => void reviewCommand(command)} onContinue={() => continueStep(entry, attempt, true)} />;
  }
  function continueStep(entry: StudioEvidence, attempt: TrainingAttempt, useRewrite = false) {
    if (!kit?.saved || !attempt.question || !("parts" in attempt.answer)) return;
    const question = attempt.question;
    const field = question.fields.find(item => item.key === entry.key);
    const answer = attempt.answer.parts[entry.key];
    if (!field || answer === undefined || !attempt.questionVersion) return;
    const review = useRewrite && attempt.writingReviews?.find(item => item.key === entry.key && item.questionVersion === attempt.questionVersion);
    if (useRewrite && (!review || !review.rewrite || field.control !== "write")) return;
    const ref = { kitId: kit.id, version: kit.version, round: attempt.round, key: entry.key, ...(useRewrite ? { useRewrite: true as const } : {}) };
    clear();
    setGoal(kit.goal);
    setEvidence("");
    if (kit.model) setModel(kit.model);
    setContinuation({ ref, career: kit.career, interviewRef: kit.interviewRef, source: {
      ...ref, kitTitle: kit.title, questionLabel: field.label, questionVersion: attempt.questionVersion,
      answer: review && review.rewrite ? review.rewrite.answer : readableStudioAnswer(field, answer), usedPreview: useRewrite || attempt.usedPreview,
      status: entry.status, detail: review ? trainingRewriteSourceDetail : entry.detail, nextStep: review ? review.revisionPrompt : entry.nextStep,
    } });
  }
  const next = kit?.stage === "waiting"
    ? t("已记录首练，到期后换题。", "First attempt recorded; a new exercise opens when due.")
    : kit?.stage === "retest"
      ? latestAttempt?.usedPreview || !latestAttempt?.feedback.met
        ? t("上次使用了反馈或规则未满足，今天用新情境验证独立决策。", "Try a new situation independently after the first attempt needed feedback or missed a rule.")
        : t("上次规则满足，今天用新情境核对能否迁移。", "Check transfer in a different situation after meeting the first exercise rules.")
      : kit?.stage === "complete"
        ? kit.kind === "canvas" ? t("回看两次填写与本人解释，选择下一项练习或可验收项目。", "Review both responses and choose another practice or a verifiable project.")
          : latestAttempt?.feedback.met && !latestAttempt.usedPreview
            ? t("新题规则满足且未先看反馈，可以用记录复盘并规划可验证项目。", "New exercise met the rules without preview. Review the record and plan a verifiable project.")
            : t("根据新题的实际结果安排补练，再做一次独立验证。", "Use the retest result to plan remediation and another independent check.")
        : undefined;
  return (
    <section
      className="training-kit"
      aria-label={t("按需训练工坊", "Personal training workshop")}
    >
      <header>
        <div>
          <small>
            <Boxes size={15} />
            {t("学习提升 · 训练工坊", "Learning · Workshop")}
          </small>
          <h2>
            {kit?.title ??
              t(
                "设计我的练习",
                "Design my practice",
              )}
          </h2>
        </div>
        {kit && (
          <span className="training-tag">
            {kit.saved ? t("已保留", "Saved") : t("临时试用", "Preview")}
          </span>
        )}
      </header>
      {!owner ? (
        <p>
          {t(
            "请先登录 BetterMe，训练工具只属于当前账号。",
            "Sign in to use your private training workshop.",
          )}
        </p>
      ) : (
        <>
          {kit?.interviewRef && <p>{t("面试复盘的验收标准", "Interview success criterion")} · {kit.goal}</p>}
          {association && (
            <div className="training-result">
              <p><strong>{association.planTitle} · {association.taskTitle}</strong></p>
              <small>{t("已确认目标", "Confirmed goal")} · {association.goal}</small>
              <p>{t("岗位原句", "Job requirement")} · {association.requirement.title} {association.requirement.company}</p>
              <blockquote>{association.requirement.quote}</blockquote>
              <small>{t("能力目标", "Competency target")} · {association.competency}</small>
              <small>{t("任务验收条件", "Task acceptance criterion")} · {association.criterion}</small>
              <small title={association.requirement.snapshotVersion}>JD v{association.requirement.snapshotVersion.slice(0, 10)} · {association.requirement.itemId}</small>
            </div>
          )}
          {openingLinkedKit && <p role="status">{t("正在读取关联的练习…", "Opening the linked exercise…")}</p>}
          {!openingLinkedKit && !kit && !plan && !historical && (
            <div className="training-form">
              {continuation && <div>
                <StudioOrigin source={continuation.source} />
                <p>{continuation.ref.useRewrite ? t("将把上面选中的改写和对应建议交给所选本机模型。下方可以补充自己的说明。", "The selected revision and its advice will go to the chosen local model. You can add context below.") : t("将把这一步的原答与核对结果交给所选本机模型。下方可以补充自己的说明。", "Your answer to this step and its check result will go to the selected local model. You can add context below.")}</p>
                <button type="button" disabled={!!busy} onClick={removeContinuation}>{t("移除作答引用", "Remove attempt reference")}</button>
              </div>}
              {confirmedGoal && confirmedGoal.length <= 600 && !goal && (
                <button
                  disabled={!!busy}
                  onClick={() => setGoal(confirmedGoal)}
                >
                  {t(
                    "带入我已确认的学习目标（仅填入）",
                    "Use my confirmed learning goal (fill only)",
                  )}
                </button>
              )}
              <label>
                {interview ? t("面试复盘的验收标准", "Interview success criterion") : t("想提升什么？", "What do you want to improve?")}
                <input
                  maxLength={600}
                  value={goal}
                  readOnly={!!target || !!continuation || !!interview}
                  placeholder={t(
                    "描述你希望能独立完成的一件事",
                    "Describe something you want to do independently",
                  )}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </label>
              <label>
                {continuation ? t("补充说明（选填）", "Additional context (optional)") : t(
                  "哪一次尝试让你觉得卡住了？（选填）",
                  "What happened the last time you tried? (Optional)",
                )}
                <textarea
                  ref={notesInput}
                  rows={2}
                  maxLength={800}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder={t(
                    "可以贴一段原答，或直接从目标开始。",
                    "Add a previous attempt, or start with just your goal.",
                  )}
                />
              </label>
              <label>
                {t("本机 Ollama 模型", "Local Ollama model")}
                <input
                  value={model}
                  maxLength={96}
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
              <p>
                {continuation ? (target ? t("本次分析将使用选中作答、补充说明和以上已确认的岗位任务。", "This analysis uses the selected attempt, your notes and the confirmed career task above.") : t("本次分析只使用这项目标、选中作答与补充说明。", "This analysis uses only this goal, the selected attempt and your notes.")) : target ? t("将选中的岗位原句、能力目标、任务和验收条件及以上难点交给本机模型。", "Share the selected requirement, competency target, task criterion and your difficulty with the local model.") : t(
                  "只将以上两项交给这个本机模型，分析一次；不联网、不打开麦克风、不读取职业资料。",
                  "Only your goal and example go to this local model for one analysis. No cloud, microphone or career records.",
                )}
              </p>
              <button
                className="training-primary"
                disabled={
                  !!busy || !goal.trim() || !model.trim()
                }
                onClick={() => void analyze()}
              >
                {t("同意并分析难点", "Analyze with the local model")}
                <ChevronRight size={15} />
              </button>
              {!continuation && !interview && <details className="training-demos">
                <summary>
                  <FlaskConical size={14} />
                  {t("只体验，不调用模型", "Examples · no model calls")}
                </summary>
                <div className="training-examples">
                <button disabled={!!busy} onClick={() => void analyze("concurrency")}>
                  {t("并发冲突与库存扣减", "Concurrency and inventory")}
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => void analyze("rewrite")}
                >
                  {t("英文邮件改写", "English email rewrite")}
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => void analyze("dependency")}
                >
                  {t("项目排期推演", "Project scheduling")}
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => void analyze("canvas")}
                >
                  {t("一分钟汇报", "One-minute briefing")}
                </button>
                </div>
              </details>}
            </div>
          )}
          {sourceAttempt && !referenceLocked && <StudioOrigin source={sourceAttempt} />}
          {kit?.transferFrom && !referenceLocked && <TransferOrigin source={kit.transferFrom} />}
          {plan && (
            <div className="training-form">
              <span className="training-tag">
                {plan.origin === "example"
                  ? t(
                      "内置示例 · 非模型判断",
                      "Built-in example · not model analysis",
                    )
                  : t("模型假设 · 请核对", "Model hypothesis · review first")}
              </span>
              <h3>{plan.advice.observation}</h3>
              <p>{plan.advice.nextStep}</p>
              {plan.origin === "local" && plan.advice.route === "studio" && <StudioActionPicker
                proposed={plan.advice.practiceActions} edited={editedActions} onEdit={setEditedActions} disabled={!!busy || planUsed} />}
              {plan.advice.route === "simple" ||
              plan.advice.route === "clarify" ? (
                <p>
                  {t(
                    "这一步不新建应用。可以先尝试上面的建议，或补充具体例子。",
                    "No app yet. Try this advice or clarify your goal.",
                  )}
                </p>
              ) : (
                <>
                  <p>
                    {plan.origin === "example"
                      ? t(
                          "用原创样例和内置逻辑演示同一沙箱流程。",
                          "Use built-in examples in the same sandbox.",
                        )
                      : plan.advice.route === "studio"
                        ? t("确认后由本机模型设计首次练习与换情境复测，沙箱会先核对可执行的步骤。",
                            "Confirm to design practice and transfer activities locally and check their executable steps in the sandbox.")
                      : plan.advice.route === "canvas"
                        ? t(
                            "确认后再调用本机模型一次，按你的难点组合情境、书写、选择或自评。只检查参与情况，不替你评判专业对错。",
                            "One more local call designs a rehearsal with writing, choices or self-ratings. Completion is not a proficiency score.",
                          )
                        : t(
                            "确认后最多再调用该本机模型 3 次，生成两道题、编写逻辑并限次修复。仅试用，不安装。",
                            "Up to 3 more local calls design two exercises, write and optionally repair the logic. Preview only.",
                          )}
                  </p>
                  <button
                    className="training-primary"
                    disabled={!!busy || planUsed}
                    onClick={() =>
                      void perform(
                        t(
                          "编排题目并在沙箱校验…",
                          "Designing and testing in the sandbox…",
                        ),
                        async (signal) => {
                          try {
                            const k = await client.build(
                              plan.id,
                              crypto.randomUUID(),
                              signal,
                              editedActions,
                            );
                            return () => open(k);
                          } catch (failure) {
                            if (
                              failure instanceof Error &&
                              [
                                "training_design_invalid",
                                "training_retest_repeated",
                                "training_program_rejected",
                                "training_plan_already_used",
                                "training_plan_expired",
                                "training_no_app_needed",
                              ].includes(failure.message)
                            ) {
                              setPlanUsed(true);
                            }
                            throw failure;
                          }
                        },
                      )
                    }
                  >
                    {plan.origin === "example"
                      ? t("试用示例工具", "Try example tool")
                      : t("认可方向，构建试用版", "Build this practice tool")}
                  </button>
                  {planUsed && (
                    <small>
                      {t(
                        "本次构建建议已用完；请点下方「调整目标或判断依据」重新分析，不会自动重试。",
                        "This plan attempt is spent. Choose Revise goal or evidence below to analyze again; nothing retries automatically.",
                      )}
                    </small>
                  )}
                </>
              )}
              <button disabled={!!busy} onClick={clear}>
                {t("调整目标或判断依据", "Revise goal or evidence")}
              </button>
            </div>
          )}
          {kit && (
            <>
              <p className="training-meta">
                {kit.origin === "example"
                  ? t(
                      "内置示例（非 AI 生成）",
                      "Built-in example (not AI-generated)",
                    )
                  : kit.model}{" "}
                · {kit.verifiedCases} {t("项沙箱校验", "sandbox checks")} ·{" "}
                {kit.modelCalls} {t("次分析与构建调用", "model calls for analysis and build")} · v
                {kit.version.slice(0, 8)}
                {kit.questionVersion && <span title={kit.questionVersion}> · {t("题目", "Question")} v{kit.questionVersion.slice(0, 8)}</span>}
              </p>
              <TrainingTransferPanel kit={kit} historical={historical} disabled={!!busy}
                onRecommend={() => void reviewCommand({ action: "recommend-transfer", revision: kit.revision, requestId: crypto.randomUUID(), consent: true })}
                onAdopt={() => void startRecommended()} />
              <h3>
                {kit.stage === "retest" || kit.stage === "complete"
                  ? t("换题复测", "Transfer exercise")
                  : t("首次练习", "First exercise")}{" "}
                · {kit.screen.brief}
              </h3>
              {association && next && kit.kind !== "studio" && <p className="training-result">{next}</p>}
              {kit.kind === "studio" && kit.stage === "retest" && <p>{t("先按新材料作答。提交前查看首练或使用试算，会在这次复测中记录为使用过帮助。", "Answer from the new material. Opening the first attempt or previewing feedback before submitting is recorded as assistance.")}</p>}
              <p>{kit.screen.instruction}</p>
              <ul className="training-data">
                {kit.screen.notes.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <div className="training-form">
                {kit.screen.fields.map((f) => f.control === "order" ? (
                  <StudioOrderField key={f.key} field={f} value={values[f.key]} disabled={!!busy || studioRecorded}
                    onChange={value => setValues(prior => ({ ...prior, [f.key]: value }))} />
                ) : (
                  <label key={f.key}>
                    {f.label}
                    {f.control === "text" || f.control === "write" || f.control === "code" ? (
                      <textarea
                        readOnly={studioRecorded || !!busy}
                        maxLength={f.control === "write" ? 400 : 1600}
                        spellCheck={f.control === "code" ? false : undefined}
                        className={f.control === "code" ? "training-code" : undefined}
                        rows={f.control === "code" ? 6 : 3}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues({ ...values, [f.key]: e.target.value })
                        }
                      />
                    ) : f.control === "quantity" ? (
                      <input type="number" step={1} value={values[f.key] ?? ""} readOnly={studioRecorded || !!busy}
                        onChange={e => setValues({ ...values, [f.key]: e.target.value })} />
                    ) : "options" in f ? (
                      <select
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues({ ...values, [f.key]: e.target.value })
                        }
                      >
                        <option value="">
                          {t("请选择", "Select an option")}
                        </option>
                        {f.options.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type={f.control}
                          min={f.min}
                          max={f.max}
                          step={1}
                          value={values[f.key] ?? String(f.initial)}
                          onChange={(e) =>
                            setValues({ ...values, [f.key]: e.target.value })
                          }
                        />
                        {f.control === "range" && (
                          <output>
                            {values[f.key]} {t("天", "days")}
                          </output>
                        )}
                      </>
                    )}
                  </label>
                ))}
              </div>
              <div className="training-actions">
                {!studioRecorded && <button disabled={!!busy} onClick={() => void act("explore")}>
                  {t(
                    "试算反馈（记录使用提示）",
                    "Preview feedback (marks assistance)",
                  )}
                </button>}
                {(kit.stage === "practice" || kit.stage === "retest") && (
                  <button
                    className="training-primary"
                    disabled={!!busy}
                    onClick={() => void act("submit")}
                  >
                    {t("提交本次作答", "Submit this attempt")}
                  </button>
                )}
              </div>
              {feedback && !studioReport && (
                <p role="status" className="training-result">
                  {[feedback.detail, ...(feedback.cues ?? [])].join(" ")}
                </p>
              )}
              {studioReport?.evidence && <section className="training-studio-results" aria-label={t("逐项反馈", "Feedback by step")}>
                <h3>{t("逐项反馈", "Feedback by step")}</h3>
                <p role="status">{studioReport.detail}</p>
                <StudioResults evidence={studioReport.evidence} screen={kit.screen} attempt={studioRecorded && !feedback ? latestAttempt : undefined}
                  renderWriting={studioRecorded && latestAttempt && !feedback ? (entry, review) => writingStep(entry, latestAttempt, review) : undefined}
                  onContinue={kit.saved && studioRecorded && latestAttempt?.questionVersion && !historical && !busy
                    ? entry => continueStep(entry, latestAttempt) : undefined} />
              </section>}
              {referenceLocked && <button type="button" disabled={!!busy} onClick={() => void act("view-practice")}>
                {t("查看首练作答（记录使用参考）", "See first attempt (records assistance)")}
              </button>}
              {!referenceLocked && kit.attempts.length > 0 && (
                <details open={historyOpened || undefined}>
                  <summary>
                    {t("原答与练习记录", "Original attempts")} ·{" "}
                    {kit.attempts.length}
                  </summary>
                  {kit.attempts.map((a) => (
                    <div key={a.round}>
                    <p>
                      {a.round === "practice"
                        ? t("初练", "Practice")
                        : t("换题", "Retest")}{" "}
                      ·{" "}
                      {a.round === "retest" && kit.kind === "studio"
                        ? retestLabel({independence: a.usedPreview ? "assisted" : a.aids ? "independent" : "untracked", aids: a.aids}, t)
                        : a.usedPreview ? t("看过反馈", "Used feedback")
                        : t("未先看反馈", "No preview")}{" "}
                      ·{" "}
                      {kit.kind === "studio" ? t("已记录本轮作答", "Attempt recorded") : kit.kind === "canvas"
                        ? a.feedback.met
                          ? t("完成填写", "Filled in")
                          : t("部分填写", "Partially filled in")
                        : a.feedback.met
                          ? t("本题规则满足", "Met exercise rules")
                          : t("本题规则未满足", "Rules not met")}
                      <br />
                      {describeAnswer(a.answer, a.question)}
                      <br />
                      {a.feedback.detail}
                    </p>
                    {a.question && a.feedback.evidence && <StudioResults evidence={a.feedback.evidence} screen={a.question} attempt={a}
                      renderWriting={!studioRecorded || a.round !== latestAttempt?.round || feedback ? (entry, review) => writingStep(entry, a, review) : undefined}
                      onContinue={kit.saved && a.questionVersion && !historical && !busy && (!studioRecorded || a.round !== latestAttempt?.round)
                        ? entry => continueStep(entry, a) : undefined} />}
                    {a.question && <details>
                      <summary title={a.questionVersion}>{t("当时的题目", "Question snapshot")} · v{a.questionVersion?.slice(0, 10)}</summary>
                      <p>{a.question.brief} · {a.question.instruction}</p>
                      <ul>{a.question.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
                      <ul>{a.question.fields.map(field => <li key={field.key}>{field.label}{"options" in field ? " · " + field.options.join(" / ") : ""}</li>)}</ul>
                    </details>}
                    </div>
                  ))}
                </details>
              )}
              {onReview && kit.saved && (interview || (career && kit.attempts.length > 0)) && (
                <button disabled={!!busy} onClick={() => void perform(t("核对练习记录…", "Checking exercise record…"), async signal => {
                  const saved = await client.get(kit.id, signal);
                  if (!saved.saved || !scopeMatches(saved) || saved.version !== kit.version)
                    throw new Error(interview ? "training_interview_source_changed" : "training_career_target_changed");
                  if (saved.revision !== kit.revision) throw new Error("training_revision_conflict");
                  return () => onReview(saved, signal);
                })}>{interview ? (kit.attempts.length ? t("将练习记录带回面试复盘", "Return these attempts to interview feedback") : t("将此练习关联到面试复盘", "Link this exercise to interview feedback")) : kit.transferDecision ? t("保存复测和推荐依据用于本任务复盘", "Save the retest and recommendation for task review")
                  : kit.attempts.some(attempt => attempt.writingReviews?.length)
                  ? t("保存原答和点评记录用于本任务复盘", "Save answers and writing feedback for task review")
                  : t("保存这些原答用于本任务复盘", "Save these attempts for task review")}</button>
              )}
              {kit.stage === "waiting" && (
                <p>
                  {kit.kind === "studio" && kit.origin === "local" && t("到期后从这里或已保留的工坊打开新题，提交后可以请 Agent 对照两轮作答。", "When due, open the new exercise here or from your library. After you submit it, ask the Agent to compare both rounds.")}{" "}
                  {kit.kind !== "studio" && t(
                    "当前仍在等待换题解锁；上方试算反馈仅演练首轮题目。",
                    "Waiting for the retest to unlock; preview feedback applies to the first exercise only.",
                  )}{" "}
                  {t("换题复测开放于", "New exercise opens at")}{" "}
                  {new Date(kit.dueAt!).toLocaleString(
                    locale === "zh" ? "zh-CN" : "en-US",
                  )}{" "}
                  ·{" "}
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void perform(t("读取中…", "Reading…"), async (s) => {
                        const k = await client.get(kit.id, s);
                        return () => open(k);
                      })
                    }
                  >
                    {t("查看是否到期", "Check availability")}
                  </button>
                </p>
              )}
              {!kit.saved && (
                <p>
                  {t(
                    "试用最长两小时，离开前请保留。保留后仅本账号保存这个工具及本版作答，明天可换题；不会写入简历。",
                    "Preview lasts up to two hours. Keep it before leaving to save this tool and its answers in your account for tomorrow’s retest, separate from your résumé.",
                  )}
                </p>
              )}
              <div className="training-actions">
                {!kit.saved && (
                  <button disabled={!!busy} onClick={() => void act("keep")}>
                    {t("保留此版本", "Keep this version")}
                  </button>
                )}
                {kit.saved && (
                  <button disabled={!!busy} onClick={clear}>
                    {t("返回工坊", "Back to workshop")}
                  </button>
                )}
                {!discard ? (
                  <button disabled={!!busy} onClick={() => setDiscard(true)}>
                    {t("舍弃此版本", "Discard version")}
                  </button>
                ) : (
                  <>
                    <span>
                      {t(
                        "将移除此版本和本版作答。本人另存到职业计划中的复盘提交可从计划查看。",
                        "Removes this version and its answers. Any review submissions you saved separately remain in the plan.",
                      )}
                    </span>
                    <button
                      disabled={!!busy}
                      onClick={() => void act("discard")}
                    >
                      {t("确认停用此版本", "Confirm removal")}
                    </button>
                    <button onClick={() => setDiscard(false)}>
                      {t("取消", "Cancel")}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {!kit && !plan && historical && matchingShelf.length === 0 && <p>{t("此目标暂无已保留的练习版本。", "No saved exercises for this target.")}</p>}
          {!openingLinkedKit && !kit && !plan && matchingShelf.length > 0 && (
            <div className="training-library">
              <h3>
                <BookOpen size={16} />
                {t("我保留的训练工具", "My training tools")}
              </h3>
              {matchingShelf.map((k) => (
                <button
                  key={k.id}
                  disabled={!!busy}
                  onClick={() =>
                    void perform(t("读取版本…", "Opening…"), async (s) => {
                      const item = await client.get(k.id, s);
                      return () => open(item);
                    })
                  }
                >
                  {k.title} · v{k.version.slice(0, 8)}{k.career ? ` · ${k.career.taskTitle}` : ""}
                  {k.stage === "retest"
                    ? " · " + t("复测到期", "Retest due")
                    : ""}
                </button>
              ))}
            </div>
          )}
          {busy && (
            <p role="status">
              {busy}{" "}
              {!kit && (
                <button
                  onClick={() => {
                    current.current?.abort();
                    current.current = null;
                    setBusy("");
                    setPlan(undefined);
                    setNotice(
                      t(
                        "已停止等待，不会自动重试。",
                        "Stopped. No automatic retry.",
                      ),
                    );
                  }}
                >
                  {t("停止", "Stop")}
                </button>
              )}
            </p>
          )}
          {error && (
            <p className="training-error" role="alert">
              {plainError}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
