import { useEffect, useRef, useState } from "react";
import { BookOpen, Boxes, ChevronRight, FlaskConical } from "lucide-react";
import type {
  TrainingAnswer,
  TrainingCommand,
  TrainingKind,
  TrainingPlan,
  TrainingSummary,
  TrainingView,
} from "@better-me/agent-contracts";
import { captureIdentityLease, currentPrincipal } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";
import { defaultLearningClient } from "../services/learning-client";
import "./training-kit.css";

const starters = {
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
      "initial" in f ? String(f.initial) : "",
    ]),
  );
}
function describeAnswer(a: TrainingAnswer) {
  if ("parts" in a) return Object.values(a.parts).join(" · ");
  return "answer" in a ? a.answer : `+${a.delay} → ${a.prediction}`;
}
export function TrainingKitPanel({
  confirmedGoal,
}: { confirmedGoal?: string } = {}) {
  return (
    <Workshop
      key={currentPrincipal()?.id ?? "guest"}
      owner={currentPrincipal()?.id}
      confirmedGoal={confirmedGoal}
    />
  );
}
function Workshop({
  owner,
  confirmedGoal,
}: {
  owner?: string;
  confirmedGoal?: string;
}) {
  const { t, locale } = useUiPreferences(),
    client = defaultLearningClient.training;
  const [goal, setGoal] = useState(""),
    [evidence, setEvidence] = useState(""),
    [model, setModel] = useState("gemma4:e2b-it-qat");
  const [plan, setPlan] = useState<TrainingPlan>(),
    [kit, setKit] = useState<TrainingView>(),
    [shelf, setShelf] = useState<TrainingSummary[]>([]);
  const [values, setValues] = useState<Record<string, string>>({}),
    [feedback, setFeedback] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(""),
    [discard, setDiscard] = useState(false),
    [planUsed, setPlanUsed] = useState(false);
  const current = useRef<AbortController | null>(null);
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
  async function perform(
    label: string,
    work: (s: AbortSignal) => Promise<() => void>,
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
      if (!ac.signal.aborted) apply();
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
    setKit(k);
    setPlan(undefined);
    setValues(initialValues(k));
    setFeedback("");
    setDiscard(false);
  }
  function clear() {
    setPlan(undefined);
    setPlanUsed(false);
    setKit(undefined);
    setDiscard(false);
    setValues({});
    setFeedback("");
    setError("");
  }
  async function analyze(example?: TrainingKind) {
    const g = example ? starters[example].goal : goal.trim(),
      e = example ? starters[example].evidence : evidence.trim();
    await perform(t("分析中…", "Analyzing…"), async (signal) => {
      const v = await client.plan(
        {
          requestId: crypto.randomUUID(),
          goal: g,
          evidence: e,
          consent: true,
          engine: example
            ? { type: "example", example }
            : { type: "local", model: model.trim() },
        },
        signal,
      );
      return () => {
        clear();
        setGoal(g);
        setEvidence(e);
        setPlan(v);
      };
    });
  }
  async function act(action: TrainingCommand["action"]) {
    if (!kit) return;
    let command: TrainingCommand;
    if (action === "explore" || action === "submit") {
      const answer: TrainingAnswer =
        kit.kind === "canvas"
          ? { parts: values }
          : kit.kind === "rewrite"
            ? { answer: (values.answer ?? "").trim() }
            : {
                delay: Number(values.delay),
                prediction: Number(values.prediction),
              };
      if (
        "parts" in answer
          ? !Object.values(answer.parts).some((s) => s.trim())
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
        setKit(r.kit);
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
            },
            ...prior.filter((s) => s.id !== k.id),
          ]);
        }
        if (r.feedback)
          setFeedback(
            [r.feedback.detail, ...(r.feedback.cues ?? [])].join(" "),
          );
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
                "为这个难点造一个练习",
                "Build a practice tool for one sticking point",
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
          {!kit && !plan && (
            <div className="training-form">
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
                {t("想提升什么？", "What do you want to improve?")}
                <input
                  maxLength={600}
                  value={goal}
                  placeholder={t(
                    "例如：把英文工作邮件写简短",
                    "e.g. Write shorter English emails",
                  )}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </label>
              <label>
                {t(
                  "哪一次尝试让你觉得卡住了？",
                  "Describe one attempt that felt difficult.",
                )}
                <textarea
                  rows={2}
                  maxLength={800}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder={t(
                    "用一两句描述，不需要上传简历或文件。",
                    "One or two sentences; no résumé or file needed.",
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
                {t(
                  "只将以上两项交给这个本机模型，分析一次；不联网、不打开麦克风、不读取职业资料。",
                  "Only your goal and example go to this local model for one analysis. No cloud, microphone or career records.",
                )}
              </p>
              <button
                className="training-primary"
                disabled={
                  !!busy || !goal.trim() || !evidence.trim() || !model.trim()
                }
                onClick={() => void analyze()}
              >
                {t("同意并分析难点", "Analyze with the local model")}
                <ChevronRight size={15} />
              </button>
              <div className="training-examples">
                <small>
                  <FlaskConical size={14} />
                  {t("只体验，不调用模型", "Examples · no model calls")}
                </small>
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
            </div>
          )}
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
                            );
                            return () => open(k);
                          } catch (failure) {
                            if (
                              failure instanceof Error &&
                              [
                                "training_design_invalid",
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
                {kit.modelCalls} {t("次模型调用", "model calls")} · v
                {kit.version.slice(0, 8)}
              </p>
              <h3>
                {kit.stage === "retest" || kit.stage === "complete"
                  ? t("换题复测", "Transfer exercise")
                  : t("首次练习", "First exercise")}{" "}
                · {kit.screen.brief}
              </h3>
              <p>{kit.screen.instruction}</p>
              <ul className="training-data">
                {kit.screen.notes.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <div className="training-form">
                {kit.screen.fields.map((f) => (
                  <label key={f.key}>
                    {f.label}
                    {f.control === "text" || f.control === "write" ? (
                      <textarea
                        maxLength={f.control === "write" ? 400 : 1600}
                        rows={3}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues({ ...values, [f.key]: e.target.value })
                        }
                      />
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
                <button disabled={!!busy} onClick={() => void act("explore")}>
                  {t(
                    "试算反馈（记录使用提示）",
                    "Preview feedback (marks assistance)",
                  )}
                </button>
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
              {feedback && (
                <p role="status" className="training-result">
                  {feedback}
                </p>
              )}
              {kit.attempts.length > 0 && (
                <details>
                  <summary>
                    {t("原答与练习记录", "Original attempts")} ·{" "}
                    {kit.attempts.length}
                  </summary>
                  {kit.attempts.map((a) => (
                    <p key={a.round}>
                      {a.round === "practice"
                        ? t("初练", "Practice")
                        : t("换题", "Retest")}{" "}
                      ·{" "}
                      {a.usedPreview
                        ? t("看过反馈", "Used feedback")
                        : t("未先看反馈", "No preview")}{" "}
                      ·{" "}
                      {kit.kind === "canvas"
                        ? a.feedback.met
                          ? t("完成填写", "Filled in")
                          : t("部分填写", "Partially filled in")
                        : a.feedback.met
                          ? t("本题规则满足", "Met exercise rules")
                          : t("本题规则未满足", "Rules not met")}
                      <br />
                      {describeAnswer(a.answer)}
                      <br />
                      {a.feedback.detail}
                    </p>
                  ))}
                </details>
              )}
              {kit.stage === "waiting" && (
                <p>
                  {t(
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
                        "将移除此版本和本版作答，不影响其他工具。",
                        "Removes this version and its answers only.",
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
          {!kit && !plan && shelf.length > 0 && (
            <div className="training-library">
              <h3>
                <BookOpen size={16} />
                {t("我保留的训练工具", "My training tools")}
              </h3>
              {shelf.map((k) => (
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
                  {k.title} · v{k.version.slice(0, 8)}
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
