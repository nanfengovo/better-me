import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  GROWTH_PRACTICE_STARTER_SOURCE,
  GrowthJourneySchema,
  type GrowthJourney,
  type GrowthJourneyCommand,
  type GrowthJourneySummary,
  type GrowthSource,
} from "@better-me/agent-contracts";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { useRecoveryField, useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import { defaultGrowthJourneyClient, type GrowthJourneyClient } from "../services/growth-journey-client";
import "./growth-journey-workspace.css";
import { useUiPreferences } from "../lib/ui-preferences";

const activePointer = "growth-journey.active.v1";
const draftStorageKey = "betterme.recovery.v1:growth-journey:draft";
const OperationSchema = z.object({
  fingerprint: z.string().min(1).max(50_000),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/),
}).strict();
const DraftSchema = z.object({
  goal: z.string().max(1000), targetWeeks: z.number().int().min(1).max(52), weeklyHours: z.number().int().min(1).max(40),
  sourceCode: z.string().max(16000), answer: z.string().max(12000), explanation: z.string().max(12000),
  attribution: z.enum(["guided_example", "self_reported"]),
  createKey: OperationSchema.optional(), pending: OperationSchema.optional(),
}).strict();
const DraftEnvelopeSchema = z.object({ version: z.literal(1), value: DraftSchema }).strict();
type DraftOperation = z.infer<typeof OperationSchema>;
const initialDraft = (): z.infer<typeof DraftSchema> => ({ goal: "", targetWeeks: 12, weeklyHours: 3, sourceCode: "", answer: "", explanation: "", attribution: "self_reported" });
const stages = [
  { id: "goal", label: "设目标" }, { id: "source", label: "选资料" }, { id: "practice", label: "做练习" }, { id: "project", label: "项目验收" },
] as const;
const stageIndex: Record<GrowthJourney["stage"], number> = { choose_source: 1, practice: 2, checkpoint_saved: 2, verification_failed: 2, outcome_unknown: 2, ready_for_acceptance: 3, completed: 4 };
const checkLabels: Record<string, string> = { "correct-reference": "引用正确的合成资料", "unknown-explicit": "未知资料明确返回找不到", "forbidden-tool-rejected": "未授权工具被拒绝", "resume-uses-checkpoint": "恢复后复用检查点" };
type GrowthCommandInput<T = GrowthJourneyCommand> = T extends GrowthJourneyCommand ? Omit<T, "expectedRevision" | "requestId" | "consent"> : never;
const identityKeys = new WeakMap<AbortSignal, number>(); let identitySequence = 0;
function identitySnapshot() { const lease = captureIdentityLease(); return lease.signal.aborted || !lease.ownerId ? null : lease.signal; }
function subscribeIdentity(notify: () => void) {
  const { signal } = captureIdentityLease(); let live = true;
  const changed = () => { notify(); queueMicrotask(() => { if (live) notify(); }); };
  signal.addEventListener("abort", changed); return () => { live = false; signal.removeEventListener("abort", changed); };
}
function message(error: unknown) { return error instanceof Error ? error.message : ""; }

export function GrowthJourneyWorkspace({ client = defaultGrowthJourneyClient }: { client?: GrowthJourneyClient }) {
  const { t } = useUiPreferences();
  const generation = useSyncExternalStore(subscribeIdentity, identitySnapshot, () => null);
  if (!generation) return <section className="growth-journey" aria-label={t("个人成长闭环", "Personal learning journey")}><h2>{t("演示练习 · 非掌握证明", "Demo exercise · Not proof of mastery")}</h2><p>{t("请先登录当前 BetterMe 账号；不会读取或认领旧的简历、岗位和求职记录。", "Sign in to your BetterMe account. Existing resumes, jobs and career records will not be read or claimed.")}</p></section>;
  if (!identityKeys.has(generation)) identityKeys.set(generation, ++identitySequence);
  return <GrowthJourneySession key={identityKeys.get(generation)} client={client} />;
}

function GrowthJourneySession({ client }: { client: GrowthJourneyClient }) {
  const { t } = useUiPreferences();
  const checkLabel = (id: string) => t(checkLabels[id] ?? id, ({ "correct-reference": "References the correct synthetic material", "unknown-explicit": "Explicitly reports missing material", "forbidden-tool-rejected": "Rejects unauthorized tools", "resume-uses-checkpoint": "Reuses the checkpoint on resume" } as Record<string, string>)[id] ?? id);
  const phaseLabel = (phase: string) => phase === "ready" ? t("准备执行", "Ready to run") : phase === "lookup_saved" ? t("断点已保存", "Checkpoint saved") : phase === "verified" ? t("固定验收已通过", "Fixed checks passed") : phase === "failed" ? t("固定验收未通过", "Fixed checks failed") : t("需要核对", "Reconciliation needed");
  const stageLabel = (stage: GrowthJourney["stage"]) => ({ choose_source: t("选择资料", "Select material"), practice: t("练习中", "Practice"), checkpoint_saved: t("断点已保存", "Checkpoint saved"), verification_failed: t("验收未通过", "Checks failed"), outcome_unknown: t("结果待核对", "Result unconfirmed"), ready_for_acceptance: t("待本人验收", "Awaiting acceptance"), completed: t("已验收", "Accepted") })[stage];
  const [scope] = useState(() => ({ lease: captureIdentityLease(), store: capturePrivateStorage() }));
  const recovery = useWorkspaceRecovery("growth-journey:draft", DraftSchema, initialDraft);
  const [goal, setGoal] = useRecoveryField(recovery, "goal");
  const [targetWeeks, setTargetWeeks] = useRecoveryField(recovery, "targetWeeks");
  const [weeklyHours, setWeeklyHours] = useRecoveryField(recovery, "weeklyHours");
  const [sourceCode, setSourceCode] = useRecoveryField(recovery, "sourceCode");
  const [answer, setAnswer] = useRecoveryField(recovery, "answer");
  const [explanation, setExplanation] = useRecoveryField(recovery, "explanation");
  const [attribution, setAttribution] = useRecoveryField(recovery, "attribution");
  const [createKey, setCreateKey] = useRecoveryField(recovery, "createKey");
  const [pendingOperation, setPendingOperation] = useRecoveryField(recovery, "pending");
  const mounted = useRef(false), requestNumber = useRef(0), commandLock = useRef(false);
  const [sources, setSources] = useState<GrowthSource[]>([]), [journeys, setJourneys] = useState<GrowthJourneySummary[]>([]);
  const [journey, setJourney] = useState<GrowthJourney>(), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [draftError, setDraftError] = useState(""), [restored, setRestored] = useState(false);
  const alive = () => mounted.current && !scope.lease.signal.aborted;
  function remember(id?: string) { try { if (id) scope.store.setItem(activePointer, id); else scope.store.removeItem(activePointer); } catch { /* Host remains authoritative. */ } }
  function accept(next: GrowthJourney, note = "") {
    if (!alive()) return; setJourney(next); remember(next.id); setError(""); if (note) setNotice(note);
    setJourneys(old => [{ id: next.id, ownerId: next.ownerId, revision: next.revision, goal: next.goal, stage: next.stage, updatedAt: next.updatedAt }, ...old.filter(item => item.id !== next.id)]);
  }
  function operationFor(previous: DraftOperation | undefined, fingerprint: string): DraftOperation {
    return previous?.fingerprint === fingerprint ? previous : { fingerprint, id: crypto.randomUUID() };
  }
  function persistOperation(field: "createKey" | "pending", operation: DraftOperation, save: (value: DraftOperation | undefined) => void) {
    save(operation);
    try {
      const raw = scope.store.getItem(draftStorageKey);
      const stored = DraftEnvelopeSchema.parse(JSON.parse(raw ?? "null")).value[field];
      if (stored?.id !== operation.id || stored.fingerprint !== operation.fingerprint) throw new Error("operation journal mismatch");
      return true;
    } catch {
      setError(t("本次操作编号未能安全保存，因此没有发送。请先下载本页草稿，再检查本地存储。", "The operation ID could not be safely saved, so nothing was sent. Download your draft before checking local storage."));
      return false;
    }
  }
  async function load(id: string, restoration = false) {
    if (commandLock.current) return;
    commandLock.current = true; const number = ++requestNumber.current; setBusy("read"); setError("");
    try { const next = await client.get(id, scope.lease.signal); if (alive() && number === requestNumber.current) { accept(next); setRestored(restoration); if (restoration) setNotice(t("已恢复记录，未重新执行。", "Records restored without re-execution.")); } }
    catch (failure) { if (alive() && number === requestNumber.current) { setError(`${t("无法读取这条成长记录。", "Could not read this learning record. ")}${message(failure)}`); if (restoration) remember(); } }
    finally { commandLock.current = false; if (alive() && number === requestNumber.current) setBusy(""); }
  }
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void Promise.all([client.sources(controller.signal), client.list(controller.signal)]).then(async ([catalog, history]) => {
      if (!alive() || controller.signal.aborted) return; setSources(catalog); setJourneys(history); setLoaded(true);
      const id = scope.store.getItem(activePointer); if (id) await load(id, true);
    }).catch(failure => { if (alive() && !controller.signal.aborted) { setLoaded(true); setError(`${t("无法读取合成成长目录。", "Could not read the synthetic learning catalog. ")}${message(failure)}`); } });
    return () => { mounted.current = false; controller.abort(); };
    // Opening and restoring are deliberately GET-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scope]);
  async function createJourney() {
    if (busy || commandLock.current || !goal.trim()) return;
    commandLock.current = true; const fingerprint = `create:${JSON.stringify([goal, targetWeeks, weeklyHours])}`; setBusy("create"); setError(""); setNotice("");
    try {
      const operation = operationFor(createKey, fingerprint);
      if (!persistOperation("createKey", operation, setCreateKey)) return;
      const next = await client.create({ mode: "synthetic", goal: { title: goal, targetWeeks, weeklyHours }, idempotencyKey: operation.id, consent: true }, scope.lease.signal);
      if (!alive()) return; setCreateKey(undefined); accept(next, t("合成目标已创建；尚未运行任何练习工具。", "Synthetic goal created; no practice tools have run.")); }
    catch (failure) { if (alive()) setError(`${t("没有确认目标是否创建。请先重新读取目录，再决定是否重试；未自动重发。", "Goal creation is unconfirmed. Reload the catalog before deciding whether to retry; nothing was automatically resent. ")}${message(failure)}`); }
    finally { commandLock.current = false; if (alive()) setBusy(""); }
  }
  async function send(command: GrowthCommandInput) {
    if (!journey || busy || journey.pendingCommand || commandLock.current) return;
    commandLock.current = true; const fingerprint = JSON.stringify([journey.id, journey.revision, command]); setBusy(command.kind); setError(""); setNotice("");
    try {
      const operation = operationFor(pendingOperation, fingerprint);
      if (!persistOperation("pending", operation, setPendingOperation)) return;
      const wireCommand = { ...command, expectedRevision: journey.revision, requestId: operation.id, consent: true } as GrowthJourneyCommand;
      const next = await client.command(journey.id, wireCommand, scope.lease.signal);
      if (!alive()) return; setPendingOperation(undefined); accept(next, command.kind === "step_practice" && next.stage === "checkpoint_saved" ? t("断点已保存。现在可以关闭窗口；重新打开只读取记录，不重复 lookup。", "Checkpoint saved. You can close this window; reopening only reads the record and does not repeat lookup.") : ""); }
    catch (failure) { if (alive()) setError(`${t("本次动作结果未确认。只可重新读取，不会自动重复执行。", "This action's result is unconfirmed. Read it again; it will not automatically rerun. ")}${message(failure)}`); }
    finally { commandLock.current = false; if (alive()) setBusy(""); }
  }
  async function resumePendingCommand() {
    if (!journey?.pendingCommand || busy || commandLock.current) return;
    commandLock.current = true; const command = journey.pendingCommand; setBusy("reconcile"); setError(""); setNotice("");
    try {
      const operation = { fingerprint: `server:${JSON.stringify([journey.id, command])}`, id: command.requestId };
      if (!persistOperation("pending", operation, setPendingOperation)) return;
      const next = await client.command(journey.id, command, scope.lease.signal);
      if (!alive()) return; setPendingOperation(undefined); accept(next, t("已使用原操作编号核对回执；没有创建新动作。", "Receipt reconciled using the original operation ID; no new action was created."));
    } catch (failure) { if (alive()) setError(`${t("使用原操作编号核对后仍未确认。未自动再次发送。", "Still unconfirmed after reconciling the original operation ID. Nothing was automatically resent. ")}${message(failure)}`); }
    finally { commandLock.current = false; if (alive()) setBusy(""); }
  }
  function loadExample() {
    setSourceCode(GROWTH_PRACTICE_STARTER_SOURCE); setAnswer("恢复时应先读取已经保存的检查点。");
    setExplanation("检查点保存了 lookup 的结果与哈希，因此恢复不需要再次调用工具。"); setAttribution("guided_example"); setDraftError(""); setNotice(t("已载入教学辅助样例；它不是独立掌握或生产经验。", "Guided example loaded; this is not independent mastery or production experience."));
  }
  function loadPreviousAttempt() {
    if (!task) return;
    setSourceCode(task.request.sourceCode); setAnswer(task.request.answer); setExplanation(task.request.explanation);
    setAttribution(journey?.attemptAttributions?.[task.id] ?? "self_reported"); setDraftError("");
    setNotice(t("已按原文载入上次尝试供明确修改；旧回执仍保留。", "The previous attempt was loaded verbatim for explicit revision; old receipts are preserved."));
  }
  function downloadJourney() {
    if (!journey) return;
    const payload = { format: "betterme.synthetic-growth-receipt.v1", exportedAt: new Date().toISOString(), journey: GrowthJourneySchema.parse(journey) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `betterme-growth-${journey.id}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function updateDraftText(value: string, maximum: number, label: string, set: (next: string) => void) {
    if (value.length > maximum) { setDraftError(t(`${label}最多 ${maximum} 个字符；超出内容没有覆盖已保存草稿。`, `${label}: maximum ${maximum} characters. The saved draft was not overwritten.`)); return; }
    setDraftError(""); set(value);
  }
  function updateDraftNumber(raw: string, minimum: number, maximum: number, label: string, set: (next: number) => void) {
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < minimum || value > maximum) {
      setDraftError(t(`${label}请输入 ${minimum}–${maximum} 的整数；无效值没有覆盖已保存草稿。`, `${label}: enter an integer from ${minimum} to ${maximum}. The saved draft was not overwritten.`)); return;
    }
    setDraftError(""); set(value);
  }
  const progress = journey ? stageIndex[journey.stage] : 0, task = journey?.task, verification = task?.practice.verification;
  const attempts = journey?.attempts?.length ? journey.attempts : task ? [task] : [];
  const budgetExhausted = task?.status === "budget_exhausted";
  const needsPractice = !budgetExhausted && (journey?.stage === "verification_failed" || journey?.stage === "practice" && !task);
  return <section className="growth-journey" aria-label={t("个人成长闭环", "Personal learning journey")}>
    <header className="growth-heading"><div><small>{t("独立练习", "Independent practice")}</small><h2>{t("资料与练习", "Materials & exercises")}</h2><p>{t("设定目标，选择资料，完成练习与验收。", "Set a goal, choose material, then complete practice and review.")}</p></div><span className="growth-mode">{t("合成数据", "Synthetic data")}</span></header>
    <ol className="growth-steps" aria-label={t("成长闭环进度", "Learning progress")}>{stages.map((step, index) => <li key={step.id} aria-current={index === progress ? "step" : undefined} data-state={index < progress ? "done" : index === progress ? "current" : "next"}><span>{index + 1}</span>{t(step.label, { goal: "Set goal", source: "Select material", practice: "Practice", project: "Review project" }[step.id])}</li>)}</ol>
    {restored && <p className="growth-restored" role="status">{t("已恢复记录，未重新执行。所有推进仍需你明确点击。", "Records restored without re-execution. Every next action still requires your explicit confirmation.")}</p>}
    {recovery.error && <p className="growth-warning" role="alert">{recovery.error}<button type="button" onClick={recovery.download}>{t("下载本页草稿", "Download draft")}</button></p>}
    {draftError && <p className="growth-warning" role="alert">{draftError}<button type="button" onClick={recovery.download}>{t("下载本页草稿", "Download draft")}</button></p>}
    {!loaded && <p role="status">{t("正在读取本账号的合成成长记录…", "Loading this account's synthetic learning records…")}</p>}
    {loaded && !journey && <div className="growth-card growth-goal"><h3>{t("1 · 设一个可验收目标", "1 · Set a verifiable goal")}</h3><label>{t("目标名称", "Goal name")}<textarea name="growth-goal" rows={2} value={goal} onChange={event => updateDraftText(event.target.value, 1000, t("目标", "Goal"), setGoal)} placeholder={t("例如：建立可恢复的 Agent 小项目", "For example: build a small resumable agent")} /></label><div className="growth-bounds"><label>{t("目标周期（周）", "Duration (weeks)")}<input name="growth-target-weeks" type="number" min={1} max={52} value={targetWeeks} onChange={event => updateDraftNumber(event.target.value, 1, 52, t("目标周期", "Duration"), setTargetWeeks)} /></label><label>{t("每周投入（小时）", "Weekly commitment (hours)")}<input name="growth-weekly-hours" type="number" min={1} max={40} value={weeklyHours} onChange={event => updateDraftNumber(event.target.value, 1, 40, t("每周投入", "Weekly commitment"), setWeeklyHours)} /></label></div><button data-testid="growth-create" className="growth-primary" type="button" disabled={!!busy || !goal.trim()} onClick={() => void createJourney()}>{t("创建合成目标", "Create synthetic goal")}</button><p className="growth-hint">{t("创建只保存目标，不调用模型或工具。", "Creating only saves the goal; no models or tools are called.")}</p>
      {journeys.length > 0 && <details><summary>{t(`打开本账号的其他合成记录（${journeys.length}）`, `Open other synthetic records (${journeys.length})`)}</summary>{journeys.map(item => <button type="button" key={item.id} disabled={!!busy} onClick={() => void load(item.id)}>{item.goal.title} · {stageLabel(item.stage)}</button>)}</details>}
    </div>}
    {journey && <><div className="growth-goal-summary"><div><small>{t("当前目标", "Current goal")}</small><strong>{journey.goal.title}</strong></div><span>{t(`${journey.goal.targetWeeks} 周 · 每周 ${journey.goal.weeklyHours} 小时`, `${journey.goal.targetWeeks} weeks · ${journey.goal.weeklyHours} hours per week`)}</span></div>
      {journey.stage === "choose_source" && <div className="growth-card"><h3>{t("2 · 选择一份资料", "2 · Select material")}</h3><p>{t("首片只提供 BetterMe 自带的合成教材，不会扫描资料库或真实文件。", "This exercise only uses BetterMe's synthetic material. Your library and real files are not scanned.")}</p><div className="growth-source-list">{sources.map((item, index) => <article key={item.version}><small>{item.provenance === "authored_synthetic" ? t("BetterMe 合成资料", "BetterMe synthetic material") : item.provenance}</small><h4>{item.title}</h4><p>{item.text}</p><code>{item.locator}</code><button data-testid={index === 0 ? "growth-source" : undefined} type="button" disabled={!!busy || !!journey.pendingCommand} onClick={() => void send({ kind: "select_source", sourceVersion: item.version })}>{t("选择这份合成资料", "Select this synthetic material")}</button></article>)}</div></div>}
      {journey.source && <details className="growth-citation" open><summary>{t("当前资料与出处", "Current material and source")}</summary><p>{journey.source.text}</p><code>{journey.source.locator} · {journey.source.version}</code></details>}
      {needsPractice && <div className="growth-card">
        <div className="growth-card-heading"><div><h3>3 · {journey.stage === "verification_failed" ? t("修正后建立新尝试", "Revise and start a new attempt") : t("提交练习", "Submit practice")}</h3><p>{journey.stage === "verification_failed" ? t("固定验收未通过。失败回执和旧代码原样保留；只有再次明确保存，才建立一个新尝试。", "Fixed checks failed. Previous code and receipts are preserved; only an explicit save creates a new attempt.") : t("代码、原答和解释按原文保存；载入样例会标记为教学辅助。", "Code, answers and explanations are saved verbatim. Loading an example marks it as guided work.")}</p></div><div>{journey.stage === "verification_failed" && <button data-testid="growth-load-previous" type="button" onClick={loadPreviousAttempt}>{t("载入上次代码用于修改", "Load previous code for revision")}</button>}<button data-testid="growth-example" type="button" onClick={loadExample}>{t("载入辅助样例", "Load guided example")}</button></div></div>
        <label>{t("合成练习代码", "Synthetic exercise code")}<textarea name="growth-source-code" rows={10} spellCheck={false} value={sourceCode} onChange={event => updateDraftText(event.target.value, 16000, t("代码", "Code"), setSourceCode)} /></label>
        <label>{t("我的原答", "My original answer")}<textarea name="growth-answer" rows={3} value={answer} onChange={event => updateDraftText(event.target.value, 12000, t("原答", "Answer"), setAnswer)} /></label>
        <label>{t("为什么恢复不会重复执行", "Why resuming does not repeat execution")}<textarea name="growth-explanation" rows={4} value={explanation} onChange={event => updateDraftText(event.target.value, 12000, t("解释", "Explanation"), setExplanation)} /></label>
        <label>{t("内容归属", "Attribution")}<select name="growth-attribution" value={attribution} onChange={event => setAttribution(event.target.value as typeof attribution)}><option value="self_reported">{t("本人自述（不是独立完成认证）", "Self-reported (not certified independent work)")}</option><option value="guided_example">{t("教学辅助样例", "Guided example")}</option></select></label>
        <button data-testid="growth-submit" className="growth-primary" type="button" disabled={!!busy || !!journey.pendingCommand || !sourceCode || !answer.trim() || !explanation.trim()} onClick={() => void send({ kind: "submit_practice", sourceCode, answer, explanation, attribution })}>{journey.stage === "verification_failed" ? t("保存为新尝试（尚不执行）", "Save as new attempt (do not run yet)") : t("保存练习（尚不执行）", "Save practice (do not run yet)")}</button>
      </div>}
      {task && <div className="growth-card growth-practice"><h3>{t("3 · 固定练习与断点", "3 · Fixed practice and checkpoint")}</h3><p><strong>{phaseLabel(task.practice.phase)}</strong></p><details><summary>{t("技术与审计详情", "Technical and audit details")}</summary><p>{t("任务版本", "Task revision")} {task.revision} · <code>{task.id}</code></p></details><p className="growth-hint">{t(`任务计量：工具／沙箱步骤 ${task.usage.toolCalls} · 模型 ${task.usage.modelCalls}。原答与解释按原文留存，四项程序检查不会对它们做语义评分。`, `Usage: tool/sandbox steps ${task.usage.toolCalls} · model calls ${task.usage.modelCalls}. Answers and explanations remain verbatim; the four programmatic checks do not score their meaning.`)}</p><details><summary>{t("查看代码、原答与解释", "View code, original answer and explanation")}</summary><pre>{task.request.sourceCode}</pre><blockquote>{task.request.answer}</blockquote><p>{task.request.explanation}</p></details>
        {task.practice.checkpoint && <div className="growth-checkpoint"><strong>{t(`lookup 调用 ${task.practice.checkpoint.lookupCalls} 次`, `lookup calls: ${task.practice.checkpoint.lookupCalls}`)}</strong><span>{task.practice.checkpoint.noteId}</span><p>{task.practice.checkpoint.result}</p><details><summary>{t("断点审计详情", "Checkpoint audit details")}</summary><code>{task.practice.checkpoint.resultHash}</code></details></div>}
        {journey.stage === "practice" && task.practice.phase === "ready" && <button data-testid="growth-step" className="growth-primary" type="button" disabled={!!busy || !!journey.pendingCommand} onClick={() => void send({ kind: "step_practice", taskId: task.id, expectedTaskRevision: task.revision })}>{t("运行第一步并保存断点", "Run first step and save checkpoint")}</button>}
        {journey.stage === "checkpoint_saved" && <><p className="growth-safe-close">{t("断点已经持久化。现在关闭再打开，只会 GET 这条记录；不会再次执行 lookup。", "The checkpoint is persisted. Reopening only reads this record; it does not run lookup again.")}</p><button data-testid="growth-step" className="growth-primary" type="button" disabled={!!busy || !!journey.pendingCommand} onClick={() => void send({ kind: "step_practice", taskId: task.id, expectedTaskRevision: task.revision })}>{t("继续固定验收", "Continue fixed checks")}</button></>}
      </div>}
      {budgetExhausted && <div className="growth-warning" role="alert"><strong>{t("本次尝试已达固定额度上限", "This attempt has reached its fixed budget")}</strong><p>{t("已停在原任务并保留用量与回执；不建立新尝试、不新开根任务，也不自动加额。", "Stopped on the original task with usage and receipts preserved. No new attempt, root task or automatic budget increase.")}</p></div>}
      {(journey.stage === "ready_for_acceptance" || journey.stage === "completed") && verification && <div className="growth-card"><h3>{t("4 · 项目验收", "4 · Review project")}</h3><p>{t(`固定验收 ${verification.passed}/${verification.total}。`, `Fixed checks ${verification.passed}/${verification.total}. `)}{journey.stage === "ready_for_acceptance" ? t("结果待本人验收。", "Awaiting your acceptance. ") : t("本人已接受这份限定范围的回执。", "You accepted this limited-scope receipt. ")}{t("这是本次合成练习回执，不是生产经验或永久掌握证明。", "This synthetic exercise receipt is not proof of production experience or lasting mastery.")}</p><ul className="growth-checks">{verification.checks.map(check => <li key={check.id} data-passed={check.passed}><span>{check.passed ? t("通过", "Passed") : t("失败", "Failed")}</span>{checkLabel(check.id)}</li>)}</ul><details><summary>{t("验收报告审计详情", "Review report audit details")}</summary><code>{task?.practice.verificationHash}</code></details>{journey.stage === "ready_for_acceptance" && task && journey.reportHash && <button data-testid="growth-accept" className="growth-primary" type="button" disabled={!!busy || !!journey.pendingCommand || verification.passed !== verification.total} onClick={() => void send({ kind: "accept_project", taskId: task.id, reportHash: journey.reportHash! })}>{t("确认验收这个合成项目", "Accept this synthetic project")}</button>}</div>}
      {journey.project && <div className="growth-complete" role="status"><small>{t("练习已验收", "Practice accepted")}</small><h3>{journey.goal.title}</h3><p>{t("已通过固定检查。结果保留在练习记录中，不写入简历。", "Fixed checks passed. The result stays in practice history and is not written to the resume.")}</p><code>{journey.project.reportHash}</code></div>}
      {attempts.length > 0 && <details className="growth-card growth-practice"><summary>{t(`尝试历史（${attempts.length}）`, `Attempt history (${attempts.length})`)}</summary><p className="growth-hint">{t("每次尝试保留原代码、原答、解释、固定检查和用量。原答与解释未经语义评分，4/4 也不代表永久掌握。", "Every attempt keeps its original code, answers, explanations, fixed checks and usage. Answers and explanations are not semantically scored; 4/4 does not establish lasting mastery.")}</p>{attempts.map((attempt, index) => {
        const attemptAttribution = journey.attemptAttributions?.[attempt.id] ?? (journey.project?.taskId === attempt.id ? journey.project.attribution : undefined);
        return <article key={attempt.id}><h4>{t(`尝试 ${index + 1}`, `Attempt ${index + 1}`)} · <code>{attempt.id}</code></h4><p>{attemptAttribution === "guided_example" ? t("教学辅助样例", "Guided example") : attemptAttribution === "self_reported" ? t("本人自述（未认证独立完成）", "Self-reported (independent work not certified)") : t("归属未记录", "Attribution not recorded")} · {phaseLabel(attempt.practice.phase)} · {t(`工具／沙箱步骤 ${attempt.usage.toolCalls} · 模型 ${attempt.usage.modelCalls}`, `Tool/sandbox steps ${attempt.usage.toolCalls} · model calls ${attempt.usage.modelCalls}`)}</p><p>{t(`本次尝试 lookup ${attempt.practice.checkpoint?.lookupCalls ?? 0} 次 · 固定检查`, `This attempt: ${attempt.practice.checkpoint?.lookupCalls ?? 0} lookup calls · fixed checks`)} {attempt.practice.verification ? `${attempt.practice.verification.passed}/${attempt.practice.verification.total}` : t("未运行", "Not run")}</p><details><summary>{t("查看本次原文与回执", "View original content and receipt")}</summary><p>{t("资料", "Material")} <code>{attempt.request.sourceId} · {attempt.request.sourceHash}</code></p><pre>{attempt.request.sourceCode}</pre><blockquote>{attempt.request.answer}</blockquote><p>{attempt.request.explanation}</p>{attempt.practice.verification && <ul className="growth-checks">{attempt.practice.verification.checks.map(check => <li key={check.id} data-passed={check.passed}><span>{check.passed ? t("通过", "Passed") : t("失败", "Failed")}</span>{checkLabel(check.id)}</li>)}</ul>}<code>{attempt.practice.verificationHash ?? attempt.practice.checkpoint?.resultHash}</code></details></article>;
      })}</details>}
      {journey.pendingCommand && <div className="growth-warning" role="alert"><strong>{t("有一个已保存但回执未确认的动作", "A saved action has an unconfirmed receipt")}</strong><p>{t("页面打开时不会自动重发，也不允许发起新动作。", "Opening this page does not resend the action. New actions are blocked.")}</p><details><summary>{t("技术与审计详情", "Technical and audit details")}</summary><p>{journey.pendingCommand.kind} · {t("原操作编号", "Original operation ID")} <code>{journey.pendingCommand.requestId}</code></p></details><button data-testid="growth-read-existing" type="button" disabled={!!busy} onClick={() => void load(journey.id)}>{t("读取已有结果", "Read existing result")}</button><button data-testid="growth-resume-pending" type="button" disabled={!!busy} onClick={() => void resumePendingCommand()}>{t("核对后继续未确认操作", "Reconcile and continue unconfirmed action")}</button></div>}
      {["verification_failed", "outcome_unknown"].includes(journey.stage) && <div className="growth-warning"><strong>{t("结果尚未通过或无法确认。", "Checks have not passed or the result is unknown.")}</strong><p>{t("保留原任务、断点和用量；先重新读取，不自动重跑。", "The original task, checkpoint and usage are retained. Reload first; no automatic rerun.")}</p></div>}
      <div className="growth-actions"><button type="button" disabled={!!busy} onClick={() => void load(journey.id)}>{t("重新读取记录", "Reload records")}</button><button type="button" onClick={downloadJourney}>{t("导出练习与验收记录", "Export exercise and review records")}</button><button type="button" disabled={!!busy} onClick={() => { remember(); setJourney(undefined); setRestored(false); setNotice(""); setError(""); }}>{t("返回合成记录列表", "Back to synthetic records")}</button></div>
    </>}
    {busy && <p role="status">{busy === "read" ? t("正在读取，不执行练习…", "Reading only; no exercise is running…") : t("正在等待持久化回执…", "Waiting for a persisted receipt…")}</p>}{notice && <p className="growth-notice" role="status">{notice}</p>}{error && <p className="growth-error" role="alert">{error}</p>}
  </section>;
}
