/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { SelectMenu } from "../design-system";
import { ArrowDownUp, ChevronDown } from "lucide-react";
import { buildReplacementSelectionPrompt, completeReplacementClarification, hasReplacementChoices, parseReplacementSelection, suggestResumeReplacement,
  type CareerTaskResumeCommand, type FactBase, type LlmConfig, type ProjectedResume, type ReplacementMaterial, type ResumeView } from "@better-me/core";
import { careerJobSnapshotVersion } from "@better-me/agent-contracts";
import type { DrawerJobContext } from "./JdMatchDrawer";
import { materialKey, readReplacementJobs, replacementMaterials } from "../lib/resume-replacement-materials";
import { privateStorageEvent } from "../lib/identity";
import { OPPORTUNITY_STORAGE_KEY } from "../lib/opportunities";
import { useUiPreferences } from "../lib/ui-preferences";
import { useAgentTaskRuntime } from "../lib/agent-task-runtime";
import { defaultFreeChatTaskClient } from "../services/free-chat-task-client";
import { downloadResumeMarkdown } from "../lib/resume-markdown-download";
import "./resume-replacement.css";

type Save = (command: CareerTaskResumeCommand, assertSelection: () => void) => Promise<void>;
export type EditionReadbackNotice = {
  phase: "saving" | "checking" | "unknown" | "absent" | "changed" | "confirmed";
  message: string; editionId: string;
  verifiedFile?: { projected: ProjectedResume; name: string };
};
type Props = {
  facts: FactBase; view: ResumeView; projected: ProjectedResume; fingerprint?: string;
  workspaceKey: string; initialJob?: DrawerJobContext; config: LlmConfig; onSave: Save;
  readback?: EditionReadbackNotice; onCheckReadback?: () => void;
};
const isEdition = (view: ResumeView) => view.careerTaskReceipt?.taskId.startsWith("replace-one-");
const sourceRef = ({ experienceId, claimId, text }: ReplacementMaterial) => ({ experienceId, claimId, text });

export function ResumeReplacementEditor(props: Props) {
  const { view, projected, initialJob } = props;
  const { t } = useUiPreferences();
  const [open, setOpen] = useState(Boolean(initialJob) || Boolean(view.targetJdId && !isEdition(view)));
  const notice = props.readback;
  const reviewingSavedEdition = notice?.editionId === view.id;
  const waiting = notice?.phase === "checking" || notice?.phase === "unknown";
  return <section className="rr-editor no-print" aria-label={t("岗位选材", "Job-specific selection")}>
    {notice && <div className="rr-saved" role={notice.phase === "unknown" ? "alert" : "status"}>
      <span>{notice.message}</span>
      {notice.phase === "unknown" && <button type="button" onClick={props.onCheckReadback}>{t("重新核对保存记录", "Check saved record")}</button>}
      {notice.verifiedFile && !reviewingSavedEdition && <button type="button" onClick={() => downloadResumeMarkdown(notice.verifiedFile!.projected, notice.verifiedFile!.name)}>{t("导出已核对岗位版 MD", "Download verified edition (MD)")}</button>}
    </div>}
    {isEdition(view) && (!reviewingSavedEdition || notice?.phase === "confirmed") && <div className="rr-saved"><span>{t("已保存岗位版", "Saved job edition")} · {view.careerTaskReceipt!.job.title}</span>
      <button type="button" onClick={() => downloadResumeMarkdown(projected, view.name)}>{t("导出岗位版 MD", "Download edition (MD)")}</button></div>}
    <button type="button" className="rr-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
      <ArrowDownUp size={16}/><strong>{t("针对岗位替换一条经历", "Improve one bullet for a job")}</strong><ChevronDown size={14}/>
    </button>
    {open && !waiting && <ReplacementSetup {...props} />}
  </section>;
}

function ReplacementSetup(props: Props) {
  const { view, facts, projected, initialJob } = props;
  const { t } = useUiPreferences();
  const [library, setLibrary] = useState(readReplacementJobs);
  useEffect(() => {
    const refresh = () => setLibrary(readReplacementJobs());
    const change = (event: StorageEvent) => {
      const item = privateStorageEvent(event);
      if (item && (item.key === null || item.key === OPPORTUNITY_STORAGE_KEY)) refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", change);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("storage", change); };
  }, []);
  const [choice, setChoice] = useState(initialJob ? "@current" : view.targetJdId ? "job:" + view.targetJdId : "");
  const [title, setTitle] = useState("");
  const [jd, setJd] = useState("");
  const [pastedJob, setPastedJob] = useState<DrawerJobContext>();
  const job = choice === "@paste" ? pastedJob : choice === "@current" ? initialJob : library.jobs.find(j => "job:" + j.id === choice);
  const [extra, setExtra] = useState<string[]>([]);
  const all = useMemo(() => replacementMaterials(facts, view, projected), [facts, view, projected]);
  const hidden = all.filter(row => !row.visible);
  const permitted = useMemo(() => all.filter(row => row.visible || extra.includes(materialKey(row))), [all, extra]);
  const scope = job && careerJobSnapshotVersion(job);
  function assertJob() {
    if (job && choice.startsWith("job:")) {
      const live = readReplacementJobs().jobs.find(x => x.id === job.id);
      if (!live || careerJobSnapshotVersion(live) !== scope) throw new Error(t("岗位要求已变化，请重新比较。", "Job details changed. Review the comparison again."));
    }
  }
  return <div className="rr-body">
    <div className="rr-job-field">
      <span className="rr-field-label">{t("目标岗位", "Target job")}</span>
      <SelectMenu
        appearance="control"
        fullWidth
        ariaLabel={t("目标岗位", "Target job")}
        value={choice}
        options={[
          { value: "", label: t("选择目标岗位", "Choose a target job") },
          ...(initialJob ? [{ value: "@current", label: `${initialJob.title} · ${initialJob.company}` }] : []),
          ...library.jobs.map(j => ({ value: "job:" + j.id, label: `${j.title} · ${j.company}` })),
          { value: "@paste", label: t("粘贴岗位要求…", "Paste a job description…") },
        ]}
        onChange={next => { setChoice(next); setExtra([]); }}
      />
    </div>
    {library.error && <small role="alert">{library.error}</small>}
    {choice === "@paste" && <div className="rr-fields"><label>{t("岗位名称", "Job title")}<input maxLength={240} value={title} onChange={e => { setTitle(e.target.value); setPastedJob(undefined); setExtra([]); }}/></label>
      <label>{t("岗位要求原文", "Original job requirements")}<textarea rows={3} maxLength={16000} value={jd} onChange={e => { setJd(e.target.value); setPastedJob(undefined); setExtra([]); }}/></label>
      <button type="button" disabled={!title.trim() || !jd.trim() || !!pastedJob} onClick={() => setPastedJob({title:title.trim(), company:"", description:jd.trim()})}>{t("使用这个岗位", "Use this job")}</button></div>}
    {job && <>
      {hidden.length > 0 && <details className="rr-materials"><summary>{t(`加入本版未展示的材料（已选 ${extra.length}）`, `Include other material (${extra.length} selected)`)}</summary>
        {hidden.map(row => <label key={materialKey(row)}><input type="checkbox" checked={extra.includes(materialKey(row))} onChange={e => {
          const key = materialKey(row); const checked = e.target.checked; setExtra(prev => checked ? [...prev,key] : prev.filter(x => x !== key));
        }}/><span><small>{row.label}</small>{row.text}</span></label>)}</details>}
      {props.fingerprint ? <ReplacementReview key={JSON.stringify([scope,props.fingerprint,extra])} job={job} materials={permitted}
        view={view} fingerprint={props.fingerprint} workspaceKey={props.workspaceKey} config={props.config} onSave={props.onSave} assertJob={assertJob} /> : <small role="status">{t("正在核对原稿…", "Checking the source edition…")}</small>}
    </>}
  </div>;
}

type ReviewProps = Pick<Props,"view"|"workspaceKey"|"onSave"|"config"> & {
  job: DrawerJobContext; materials: ReplacementMaterial[]; fingerprint: string; assertJob: () => void;
};
function ReplacementReview({job, materials, view, workspaceKey, fingerprint, config, onSave, assertJob}: ReviewProps) {
  const { t } = useUiPreferences();
  const runtime = useAgentTaskRuntime(config);
  const input = useMemo(() => ({jobDescription:job.description, materials, locale:view.locale}), [job.description, materials, view.locale]);
  const { local, canReview } = useMemo(() => {
    try { return { local:suggestResumeReplacement(input), canReview:hasReplacementChoices(input) }; }
    catch (err) { return {local:{kind:"keep" as const, reason:err instanceof Error ? err.message : "无法核对这些材料。"}, canReview:false}; }
  }, [input]);
  const [review, setReview] = useState<typeof local>();
  const [answered, setAnswered] = useState(false);
  const [answer, setAnswer] = useState("");
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState<"save" | "model">();
  const [error, setError] = useState("");
  const [usedModel, setUsedModel] = useState(false);
  const [invalidReply, setInvalidReply] = useState(false);
  const [operation] = useState(() => "replace-one-" + crypto.randomUUID());
  const lock = useRef(false);
  const session = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); session.current = controller;
    return () => controller.abort();
  }, []);
  const decision = review ?? local;
  async function modelReview() {
    if (lock.current || answered) return;
    lock.current = true; setBusy("model"); setError("");
    const signal = session.current!.signal;
    try {
      assertJob(); runtime.assertSelected();
      const prompt = buildReplacementSelectionPrompt(input);
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["resume_replacement_v1", workspaceKey, fingerprint, careerJobSnapshotVersion(job), prompt])));
      const id = "replacement-" + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
      signal.throwIfAborted(); runtime.assertSelected(); assertJob();
      const reply = await defaultFreeChatTaskClient.send({responseContract:"resume_replacement_v1",workspaceKey:"replace:" + view.id, rootScopeKey:workspaceKey,
        messages:[{id,role:"user",content:prompt}],runtime:runtime.runtime, preferredRuntimeId:runtime.preferredRuntimeId,signal});
      signal.throwIfAborted(); runtime.assertSelected(); assertJob();
      try { setReview(parseReplacementSelection(input, reply.content)); }
      catch { setInvalidReply(true); throw new Error(t("模型回复无法对应本次选项，已保留本机初选。", "The model reply did not match an available option. The local selection is still shown.")); }
      setAnswer(""); setUsedModel(true);
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : t("模型选材未完成。", "Model review did not complete."));
    } finally { lock.current = false; if (!signal.aborted) setBusy(undefined); }
  }
  async function save() {
    if (lock.current || decision.kind !== "replace") return;
    lock.current = true; setBusy("save"); setError("");
    try {
      const signal = session.current!.signal;
      const assertSelection = () => { signal.throwIfAborted(); assertJob(); };
      assertSelection();
      await onSave({taskId:operation, sourceResumeId:view.id, sourceFingerprint:fingerprint,
        name:[job.company,job.title].filter(Boolean).join(" · ").slice(0,500),
        job:{id:job.id,title:job.title,company:job.company,fingerprint:careerJobSnapshotVersion(job)},
        patches:[], replacement:{ remove:sourceRef(decision.target), use:sourceRef(decision.source), proposedText:decision.proposedText }}, assertSelection);
    } catch (err) { setError(err instanceof Error ? err.message : t("保存未完成，请检查版本记录。", "Save could not be confirmed. Check version history.")); }
    finally { lock.current = false; setBusy(undefined); }
  }
  if (kept) return <div className="rr-actions"><small role="status">{t("已保留当前版本。", "Current edition retained.")}</small>
    <button type="button" onClick={() => setKept(false)}>{t("重新查看", "View again")}</button></div>;
  return <div className="rr-review" aria-busy={!!busy}>
    <p className="rr-origin">{usedModel ? t("模型选材", "Model selection") : t("本机初选", "Local selection")}</p>
    {decision.kind !== "keep" && <p className="rr-quote"><small>{t("岗位原句", "Job requirement")}</small>{decision.requirement}</p>}
    <p>{decision.reason}</p>
    {decision.kind !== "keep" && <div className="rr-compare">
      <div><small>{t("替换前", "Before")} · {decision.target.label}</small><p>{decision.target.text}</p></div>
      <div><small>{decision.kind === "ask" ? t("备选原文", "Candidate source") : t("采用后", "After")} · {decision.source.label}</small>
        <p>{decision.kind === "ask" ? decision.source.text : decision.proposedText}</p></div>
    </div>}
    {decision.kind === "replace" && <details><summary>{t("核对采用依据与位置", "Review source and placement")}</summary>
      <p>{decision.source.label} · {decision.source.text}</p>{answered && <p>{t("本人补充", "Your clarification")} · {answer}</p>}
      {decision.source.experienceId !== decision.target.experienceId && <p>{t("新句列在来源经历下。本版移出原句，原任职的名称和日期保留。", "The new bullet stays under its own experience. The original job title and dates remain after removing the old bullet.")}</p>}</details>}
    {decision.kind === "ask" && <div className="rr-fields"><label>{decision.question}<textarea rows={2} maxLength={2000} value={answer} disabled={!!busy} onChange={e => setAnswer(e.target.value)}/></label>
      <button type="button" disabled={!!busy || !answer.trim()} onClick={() => {
        setReview(completeReplacementClarification(decision,answer)); setAnswered(true); setError("");
      }}>{t("用这句补充看对比", "Review with this clarification")}</button></div>}
    <div className="rr-actions">
      {decision.kind === "replace" && <button className="rr-primary" type="button" disabled={!!busy} onClick={() => void save()}>{busy === "save" ? t("正在保存…", "Saving…") : t("采用并保存岗位版", "Accept and save job edition")}</button>}
      {decision.kind !== "keep" && <button type="button" disabled={!!busy} onClick={() => setKept(true)}>{t("保留原文", "Keep original")}</button>}
    </div>
    {canReview && !usedModel && !invalidReply && !answered && <details><summary>{t("用所选模型复核", "Review with selected model")}</summary>
      <p>{t(`将岗位要求和以上范围内的 ${materials.length} 条经历发送至 ${runtime.label}。`, `Send the job requirements and ${materials.length} selected bullets to ${runtime.label}.`)}</p>
      <button type="button" disabled={!!busy} onClick={() => void modelReview()}>{busy === "model" ? t("正在选材…", "Reviewing…") : t("发送并复核选材", "Send for model review")}</button></details>}
    {error && <p className="rr-error" role="alert">{error}</p>}
  </div>;
}
