import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { isOfficialDeepSeek, type LlmConfig } from "@better-me/core";
import {
  TranslationCreateSchema,
  TranslationReviewSchema,
  TranslationCheckIds,
  PDF_CLOUD_ORIGIN, PDF_CLOUD_LIMIT, PdfCloudModelName,
  type LearningMaterial,
  type TranslationBackend,
  type TranslationJob,
} from "@better-me/agent-contracts";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import type { LearningClient } from "../services/learning-client";
import {
  LearningOriginalPage,
  LearningPdfPreview,
} from "./LearningOriginalPage";

const Pending = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("create"), input: TranslationCreateSchema })
    .strict(),
  z.object({ kind: z.literal("cancel"), id: z.string() }).strict(),
  z.object({ kind: z.literal("cloud-create"), id: z.string() }).strict(),
  z
    .object({
      kind: z.literal("review"),
      id: z.string(),
      input: TranslationReviewSchema,
    })
    .strict(),
]);
const CheckDraft = z.enum(["", "pass", "fail", "not_applicable"]);
const ReviewDraft = z
  .object({
    notes: z.string().max(4000),
    terminology: CheckDraft.optional(),
    checks: z
      .object({
        pages: CheckDraft,
        numbers_units: CheckDraft,
        negations: CheckDraft,
        formulas: CheckDraft,
        reading_order: CheckDraft,
        overflow: CheckDraft,
      })
      .strict(),
  })
  .strict();
const Recovery = z
  .object({
    active: z.string().optional(),
    model: z.string(),
    bilingual: z.boolean(),
    glossary: z.string().max(8000),
    reviews: z.record(ReviewDraft),
    pending: Pending.optional(),
  })
  .strict();
const recoveryKey = "learning-translation:v1";
const emptyReview = (): z.infer<typeof ReviewDraft> => ({
  notes: "",
  checks: {
    pages: "",
    numbers_units: "",
    negations: "",
    formulas: "",
    reading_order: "",
    overflow: "",
  },
});
const labels: Record<TranslationJob["state"], string> = {
  queued: "已保存，待处理",
  running: "转换中",
  review_required: "译稿待审阅",
  accepted: "本人已审阅接受",
  rejected: "审阅未接受",
  failed: "转换失败",
  cancelled: "已停止",
  interrupted: "Host 中断，未重跑",
  source_revoked: "原件已撤权",
};
const stages: Record<TranslationJob["stage"], string> = {
  prepared: "准备",
  parsing: "解析",
  translating: "翻译段落",
  typesetting: "排版",
  checking: "核对文件",
  finished: "文件已生成，质量待审阅",
  stopped: "已停止",
};
const checks = {
  pages: "页数与漏页",
  numbers_units: "数字与单位",
  negations: "否定词与条件",
  formulas: "公式与符号",
  reading_order: "多栏与阅读顺序",
  overflow: "英文溢出与遮挡",
};
const issues: Record<string, string> = {
  translation_backend_unavailable: "翻译引擎尚未就绪，没有发出模型请求。",
  translation_text_pdf_required:
    "试点仅接受 10 页以内、每页文字可靠的 PDF。扫描页或多栏校对另行处理。",
  translation_already_running: "当前账号已有转换作业，请先读取其进度或停止。",
  translation_quality_not_accepted:
    "模拟件、漏页、空白文字层或有失败项的译稿不能被接受。",
  translation_terminology_review_required: "请单独核对专有名词；使用了术语表的作业不能跳过此项。",
  translation_model_budget_exhausted:
    "本作业授权的模型请求数已用尽，保留原账单，不追加额度或自动续跑。",
  translation_host_interrupted:
    "Host 中断后只恢复记录，没有重发请求。需要重新转换时请另行确认一个新作业。",
  translation_engine_failed:
    "引擎没有交付可核对的结果。没有自动切换后端或重试。",
  translation_cancelled:
    "本次转换已停止，已发生的请求仍计入用量。没有继续转换或自动重跑。",
  translation_cloud_request_failed: "云端未返回完整可用的译文，已停止。已预留的请求不退回，不自动重发。",
  translation_cloud_sensitive_text: "待发送文本含疑似凭据或私有路径，本次传输已拒绝。",
  translation_cloud_credential_required: "未收到本作业授权的 DeepSeek 凭据，未开始转换。",
  translation_time_limit:
    "本作业已到 10 分钟上限，保留已发生的用量，不自动续跑。",
  translation_installation_unverified:
    "本机引擎版本或资源未验证；需要独立的 Python 3.10–3.13、固定版本引擎与预备资源。",
  translation_python_or_packages_unavailable:
    "指定 Python 或固定版本 PDF2zh / BabelDOC 不可用。",
  translation_windows_isolation_unreviewed:
    "Windows 原生转换进程的隔离与清理尚未验收；可读取历史，不启动引擎。",
  learning_material_revoked: "原件已撤权，已停止转换并禁止读取派生译稿。",
};
function describe(error: unknown) {
  const message = error instanceof Error ? error.message : "译稿请求未确认";
  return issues[message] ?? message;
}

function saveFile(value: Blob, filename: string) {
  const url = URL.createObjectURL(value),
    link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mounted under the existing account-generation keyed learning session. No
 * execution grant, preview, or download is restored from the local journal. */
export function LearningTranslationPanel({
  material,
  client,
  cloudConfig,
}: {
  material?: LearningMaterial;
  client: LearningClient;
  cloudConfig?: LlmConfig;
}) {
  const [scope] = useState(() => ({
    lease: captureIdentityLease(),
    store: capturePrivateStorage(),
  }));
  const recovery = useWorkspaceRecovery(recoveryKey, Recovery, () => ({
    model: "",
    bilingual: true,
    glossary: "",
    reviews: {},
  }));
  const [backend, setBackend] = useState<TranslationBackend>(),
    [jobs, setJobs] = useState<TranslationJob[]>([]);
  const [channel,setChannel]=useState<"local"|"cloud">("local"),[cloudModel,setCloudModel]=useState(""),
    [jobKey,setJobKey]=useState(""),[cloudLimit,setCloudLimit]=useState(PDF_CLOUD_LIMIT),[share,setShare]=useState(false),[absentRequest,setAbsentRequest]=useState("");
  const cloud=channel==="cloud";
  const savedKey=cloud&&cloudConfig?.provider==="openai-compatible"&&isOfficialDeepSeek(cloudConfig)&&cloudConfig.apiKey?.trim();
  const candidateKey=cloud ? savedKey || jobKey.trim() : "";
  const cloudKey=/^[!-~]{4,512}$/.test(candidateKey)?candidateKey:undefined;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false),
    [rendered, setRendered] = useState(false),
    [extracted, setExtracted] = useState(false);
  const [preview, setPreview] = useState<"mono" | "dual">(),
    [pageNumber, setPageNumber] = useState(1);
  const mounted = useRef(false),
    lock = useRef(false);
  const alive = useCallback(
    () => mounted.current && !scope.lease.signal.aborted,
    [scope],
  );
  const read = useCallback(async () => {
    const value = await client.translations(scope.lease.signal);
    if (alive())
      setJobs((old) =>
        JSON.stringify(old) === JSON.stringify(value) ? old : value,
      );
    return value;
  }, [client, scope, alive]);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, scope.lease.signal]);
    void Promise.all([
      client.translationBackend(signal,channel),
      client.translations(signal),
    ])
      .then(([backend, jobs]) => {
        if (alive()&&!signal.aborted) {
          setBackend(backend.location===channel?backend:undefined);
          setJobs(jobs);
        }
      })
      .catch((error) => {
        if (alive() && !signal.aborted) setError(describe(error));
      });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void read().catch((error) => {
          if (alive()) setError(describe(error));
        });
    }, 2500);
    return () => {
      mounted.current = false;
      abort.abort();
      clearInterval(timer);
    };
  }, [client, scope, read, alive,channel]);
  // Switching a source or result resets ephemeral authorizations/review checks.
  const job = jobs.find((item) => item.id === recovery.value.active) ?? jobs[0];
  useEffect(() => {
    setRendered(false);
    setExtracted(false);
    setPreview(undefined);
    setPageNumber(1);
  }, [job?.id, job?.state]);
  const active = jobs.some((item) =>
    ["queued", "running"].includes(item.state),
  );
  const suitable =
    material?.mediaType === "application/pdf" &&
    !material.revoked &&
    material.pages.length <= 10 &&
    material.pages.every((page) => page.status === "text");
  const model = backend?.models.find(
    (item) => item.name === (cloud?cloudModel:recovery.value.model),
  );
  useEffect(() => {
    setConsent(false);
    setShare(false);
  }, [
    material?.id,
    material?.hash,
    material?.revision,
    material?.revoked,
    backend?.id,
    backend?.ready,
    model?.digest,
    channel,cloudKey,cloudLimit,recovery.value.bilingual,recovery.value.glossary,
  ]);
  const pending = recovery.value.pending;
  const pendingCloudId = pending?.kind === "cloud-create" ? pending.id :
    pending?.kind === "create" && pending.input.cloudGrant ? pending.input.requestId : undefined;
  const review = (job && recovery.value.reviews[job.id]) ?? emptyReview();
  const canReview =
    job?.state === "review_required" &&
    Object.values(review.checks).every(Boolean) &&
    (job.backend.location !== "cloud" || !!review.terminology) &&
    !!review.notes.trim() &&
    rendered &&
    extracted;
  const canAccept =
    canReview &&
    !job?.backend.simulation &&
    review.checks.pages === "pass" &&
    review.checks.overflow === "pass" &&
    !Object.values(review.checks).includes("fail") &&
    (job?.backend.location !== "cloud" || (review.terminology !== "fail" &&
      (!job.request.glossary.length || review.terminology === "pass"))) &&
    job?.artifacts.every(
      (item) =>
        item.emptyTextPages.length === 0 &&
        item.pages === job.sourcePages * (item.kind === "dual" ? 2 : 1),
    );
  async function guarded(action: () => Promise<void>) {
    if (lock.current || !alive()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      if (alive()) setError(describe(error));
    } finally {
      lock.current = false;
      if (alive()) setBusy(false);
    }
  }
  function journal(operation: z.infer<typeof Pending>) {
    scope.lease.assert();
    recovery.set((old) => ({ ...old, pending: operation }));
    const saved = JSON.parse(
      scope.store.getItem(`betterme.recovery.v1:${recoveryKey}`) ?? "null",
    );
    if (JSON.stringify(saved?.value?.pending) !== JSON.stringify(operation))
      throw new Error(
        "原操作编号未能保存，没有发送翻译请求。请先下载本机备份。",
      );
  }
  function adopt(value: TranslationJob) {
    if (!alive()) return;
    setJobs((old) => [value, ...old.filter((item) => item.id !== value.id)]);
    recovery.set((old) => ({ ...old, active: value.id, pending: undefined }));
  }
  async function dispatch(operation: z.infer<typeof Pending>, retry = false) {
    // The one-job grant is consumed by the attempt, even when its response is
    // lost. A read-only reconciliation must not authorize another new job.
    setConsent(false);
    setShare(false);
    if(operation.kind==="cloud-create")throw Error("已发送的云授权不能重用，只能核对原编号。");
    if(operation.kind==="create" && operation.input.cloudGrant && (retry || !share || !cloudKey))
      throw Error("云端作业必须当次确认，不会使用已保存的同意重发。");
    if(operation.kind==="create" && operation.input.cloudGrant)setJobKey("");
    if (!retry) journal(operation.kind==="create" && operation.input.cloudGrant ?
      {kind:"cloud-create",id:operation.input.requestId} : operation);
    scope.lease.assert();
    if (operation.kind === "create")
      adopt(
        await client.createTranslation(operation.input, scope.lease.signal,operation.input.cloudGrant?cloudKey:undefined),
      );
    else if (operation.kind === "cancel")
      adopt(await client.cancelTranslation(operation.id, scope.lease.signal));
    else
      adopt(
        await client.reviewTranslation(
          operation.id,
          operation.input,
          scope.lease.signal,
        ),
      );
  }
  async function reconcile() {
    if (!pending) return;
    setAbsentRequest("");
    if(pendingCloudId){
      try{adopt(await client.translationByRequest(pendingCloudId,scope.lease.signal));}
      catch(e){if(!(e instanceof Error)||e.message!=="translation_not_found")throw e;
        setAbsentRequest(pendingCloudId);setNotice("未查到原作业，没有重发。可清除本地待核对记录，再重新选择并授权。");}
      return;
    }
    const value =
      pending.kind === "create"
        ? await client.translationByRequest(
            pending.input.requestId,
            scope.lease.signal,
          )
        : await client.translation(pending.id, scope.lease.signal);
    if (
      (pending.kind === "review" &&
        value.review?.requestId !== pending.input.requestId) ||
      (pending.kind === "cancel" && ["queued", "running"].includes(value.state))
    ) {
      await read();
      setNotice(
        "只读核对尚未确认上次动作；可以明确使用原动作核对，不会自动重发。",
      );
      return;
    }
    adopt(value);
    setNotice("已只读核对原回执，没有重发模型请求。");
  }
  async function create() {
    if (!material || !backend?.ready || backend.location!==channel || !model || !consent || !suitable || (cloud&&(!cloudKey||!share))) return;
    const glossary = recovery.value.glossary
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const offset = line.indexOf("=");
        if (offset <= 0)
          throw new Error("术语表每行使用 中文 = English，只应用于本作业。");
        return {
          source: line.slice(0, offset).trim(),
          target: line.slice(offset + 1).trim(),
        };
      });
    if (
      glossary.length > 32 ||
      glossary.some(
        (item) =>
          !item.source ||
          !item.target ||
          item.source.length > 100 ||
          item.target.length > 120,
      )
    )
      throw new Error(
        "术语表最多 32 行；每行需填写中文和英文，分别不超过 100 / 120 字。没有发送请求。",
      );
    const input = TranslationCreateSchema.parse({
      requestId: crypto.randomUUID(),
      consent: true,
      materialId: material.id,
      materialHash: material.hash,
      materialRevision: material.revision,
      backendId: backend.id,
      model,
      ...(cloud?{cloudGrant:{recipientOrigin:PDF_CLOUD_ORIGIN,model:PdfCloudModelName.parse(model.name),materialHash:material.hash,
        scope:"document_text_and_glossary",maxCalls:cloudLimit}}:{}),
      sourceLanguage: "zh",
      targetLanguage: "en",
      bilingual: recovery.value.bilingual,
      glossary,
    });
    await dispatch({ kind: "create", input });
  }
  async function decide(decision: "accept" | "reject") {
    if (!job || !canReview) return;
    await dispatch({
      kind: "review",
      id: job.id,
      input: TranslationReviewSchema.parse({
        requestId: crypto.randomUUID(),
        consent: true,
        decision,
        checks: review.checks,
        ...(job.backend.location === "cloud" ? {terminology:review.terminology} : {}),
        notes: review.notes,
        renderedPagesReviewed: rendered,
        extractedTextReviewed: extracted,
      }),
    });
  }
  function changeReview(next: Partial<z.infer<typeof ReviewDraft>>) {
    if (job)
      recovery.set((old) => ({
        ...old,
        reviews: { ...old.reviews, [job.id]: { ...review, ...next } },
      }));
  }
  const readPreview = useCallback(
    (signal: AbortSignal) => {
      if (!job || !preview) return Promise.reject(new Error("尚未选定译稿"));
      return client.translationBytes(job, preview, signal);
    },
    [client, job, preview],
  );
  const artifact = job?.artifacts.find((item) => item.kind === preview);
  const sourcePage =
    material && job && material.id === job.request.materialId
      ? material.pages.find(
          (item) =>
            item.number ===
            (preview === "dual" ? Math.ceil(pageNumber / 2) : pageNumber),
        )
      : undefined;
  return (
    <details className="learning-card translation-panel">
      <summary>
        <span>PDF 中译英 · 独立试点</span>
        <span>{active ? "后台转换中" : `${jobs.length} 份作业记录`}</span>
      </summary>
      <div className="translation-body">
        <p>
          只转换本人选定的文字 PDF，原件与练习出处不变。译稿不进入 FactBase
          或简历。
        </p>
        {backend?.simulation && (
          <div className="learning-warning">
            当前为模拟作业验证，不产生真实英文译稿，也不能通过译文验收。
          </div>
        )}
        {error && (
          <p role="alert" className="learning-warning">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {recovery.error && (
          <div className="learning-warning">
            <p>{recovery.error}</p>
            <button onClick={recovery.download}>下载翻译草稿备份</button>
          </div>
        )}
        {pending && (
          <div className="learning-warning">
            <h4>上次动作尚待核对</h4>
            <p>
              重开只读取，不会自动重发。原编号：
              {pending.kind === "create" ? pending.input.requestId : pending.id}
            </p>
            <div className="learning-actions">
              <button disabled={busy} onClick={() => void guarded(reconcile)}>
                只读核对上次翻译动作
              </button>
              {pendingCloudId ? (absentRequest===pendingCloudId && <button disabled={busy} onClick={()=>{
                recovery.set(old=>({...old,pending:undefined}));setAbsentRequest("");setConsent(false);setShare(false);
              }}>只清除未找到的本地记录，不发送</button>) : <button
                disabled={busy || !!recovery.error}
                onClick={() => void guarded(() => dispatch(pending, true))}
              >
                明确使用原动作核对
              </button>}
            </div>
          </div>
        )}
        <div className="translation-setup">
          <div>
            <h4>准备本次转换</h4>
            <p>
              {material
                ? `${material.name} · ${material.hash.slice(0, 12)} · ${material.pages.length} 页`
                : "先在资料库选择一份 PDF。不会扫描其他文件。"}
            </p>
          </div>
          {!suitable && material && (
            <p className="learning-muted">
              仅支持 10 页以内、每页文字可靠的
              PDF；扫描/多栏待校对页不送入翻译。
            </p>
          )}
          <label>翻译通道
            <select aria-label="翻译通道" value={channel} disabled={busy||!!pending} onChange={e=>{const next=e.target.value==="cloud"?"cloud":"local";
              setBackend(undefined);setConsent(false);setShare(false);setCloudModel("");setJobKey("");setChannel(next);}}>
              <option value="local">本机 · 不外发</option><option value="cloud">云端 · DeepSeek</option>
            </select>
          </label>
          <p
            className={!backend?.ready ? "learning-warning" : "learning-muted"}
          >
            {backend?.ready
              ? backend.engine
              : describe(new Error(backend?.reason ?? "正在只读检查本机引擎…"))}
          </p>
          <label>
            {cloud?"本次云端模型":"本次本机模型"}
            <select
              aria-label={cloud?"本次云端模型":"本次本机模型"}
              value={cloud?cloudModel:recovery.value.model}
              onChange={(event) => {
                if(cloud)setCloudModel(event.target.value);else recovery.field("model", event.target.value);
                setConsent(false);setShare(false);
              }}
              disabled={busy || !!pending}
            >
              <option value="">请选择，不沿用聊天的默认模型</option>
              {backend?.models.map((item) => (
                <option value={item.name} key={item.digest + item.name}>
                  {item.name}{!cloud && " · "+item.digest.slice(0,8)}
                </option>
              ))}
            </select>
          </label>
          {cloud&&<div className="learning-warning"><strong>接收方：DeepSeek · {PDF_CLOUD_ORIGIN}</strong>
            <p>本机解析和排版；发送所选原件的待译文字、标题等上下文和本作业术语，可能覆盖全部正文。不上传 PDF、图片或其他资料。供应商按账号计费。</p>
            {savedKey ? <p>使用当前账号已配置的官方 DeepSeek 密钥，不改变聊天模型。</p> :
              <label>仅本作业的 DeepSeek API 密钥（不保存）
                <input aria-label="仅本作业的 DeepSeek API 密钥" type="password" autoComplete="off" spellCheck={false} maxLength={512}
                  value={jobKey} disabled={busy||!!pending} onChange={e=>{setJobKey(e.target.value);setConsent(false);setShare(false);}} />
              </label>}
            <label>本作业最多请求数 <input type="number" min="1" max={PDF_CLOUD_LIMIT} value={cloudLimit||""} disabled={busy||!!pending}
              onChange={e=>{setCloudLimit(Number(e.target.value));setShare(false);setConsent(false);}}/></label>
            <label className="learning-consent"><input type="checkbox" checked={share} disabled={busy||!!pending||!cloudKey||!model||!suitable||!backend?.ready||
              !Number.isInteger(cloudLimit)||cloudLimit<1||cloudLimit>PDF_CLOUD_LIMIT} onChange={e=>{setShare(e.target.checked);setConsent(false);}}/>
              允许将上述文本和术语发给所选 DeepSeek 模型，仅限此份 PDF 的这个版本及本次请求上限</label></div>}
          <div className="learning-actions">
            <span>中文 → 英文</span>
            <label className="learning-consent">
              <input
                type="checkbox"
                checked={recovery.value.bilingual}
                onChange={(event) => {
                  recovery.field("bilingual", event.target.checked);
                  setConsent(false);
                }}
                disabled={busy || !!pending}
              />
              同时生成逐页双语对照
            </label>
          </div>
          <label>
            本作业术语表（可留空）
            <textarea
              rows={3}
              maxLength={8000}
              value={recovery.value.glossary}
              placeholder={"回执 = receipt\n断点 = checkpoint"}
              disabled={busy || !!pending}
              onChange={(event) => {
                recovery.field("glossary", event.target.value);
                setConsent(false);
              }}
            />
          </label>
          <label className="learning-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              disabled={
                busy || !!pending || !backend?.ready || !suitable || !model || (cloud&&(!share||!cloudKey))
              }
            />
            {cloud?`启动这一次云端作业，最多 ${cloudLimit} 次请求 / 10 分钟；不自动重发或切换模型`:
              "仅授权本原件版本与术语表用于所选本机后端的这一次后台作业；上限 32 次模型请求 / 10 分钟，不切换云端、不自动重跑"}
          </label>
          <div className="learning-actions">
            <button
              className="learning-primary"
              disabled={
                busy ||
                !!pending ||
                !!recovery.error ||
                active ||
                !backend?.ready ||
                !suitable ||
                !model ||
                (cloud&&(!share||!cloudKey)) ||
                !consent
              }
              onClick={() => void guarded(create)}
            >
              开始本次中译英
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void guarded(async () => {
                  setConsent(false);setShare(false);
                  const value = await client.translationBackend(
                    scope.lease.signal,channel,
                  );
                  if (alive()) setBackend(value.location===channel?value:undefined);
                  await read();
                })
              }
            >
              只读刷新引擎与记录
            </button>
          </div>
        </div>
        {jobs.length > 0 && (
          <>
            <label>
              转换作业
              <select
                value={job?.id ?? ""}
                onChange={(event) =>
                  recovery.field("active", event.target.value)
                }
              >
                {jobs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.materialName} · {labels[item.state]} ·{" "}
                    {item.request.requestId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {job && (
              <section className="translation-result" aria-label="译稿作业详情">
                <div className="learning-section-heading">
                  <div>
                    <h4>{labels[job.state]}</h4>
                    <p>
                      {stages[job.stage]}
                      {job.progress === null
                        ? " · 无可报告进度"
                        : ` · ${job.progress}%`}{" "}
                      · 模型请求 {job.usage.modelCalls}/{job.request.cloudGrant?.maxCalls??32}
                    </p>
                  </div>
                  {["queued", "running"].includes(job.state) && (
                    <button
                      disabled={busy || !!pending || !!recovery.error}
                      onClick={() =>
                        void guarded(() =>
                          dispatch({ kind: "cancel", id: job.id }),
                        )
                      }
                    >
                      停止本次转换
                    </button>
                  )}
                </div>
                {job.issue && (
                  <p className="learning-warning">
                    {issues[job.issue] ?? job.issue}
                  </p>
                )}
                <p className="learning-muted">
                  原件 {job.request.materialHash.slice(0, 12)} ·{" "}
                  {job.backend.engine} · {job.backend.recipientOrigin??"本机"} · {job.request.model.name} · 输入{" "}
                  {job.usage.inputBytes} / 输出 {job.usage.outputBytes} 字节
                </p>
                {job.artifacts.length > 0 && (
                  <>
                    <p>
                      文件已生成不代表翻译正确。请对照原页与译页，再看提取文本；逐项检查后明确接受或拒绝。
                    </p>
                    <div className="learning-actions">
                      {job.artifacts.map((item) => (
                        <div key={item.kind} className="translation-artifact">
                          <span>
                            {job.backend.simulation
                              ? "模拟 PDF（不是英文译稿）"
                              : item.kind === "mono"
                                ? "英文单语候选"
                                : "逐页双语候选"}{" "}
                            · {item.pages} 页
                          </span>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setPageNumber(1);
                              setPreview(item.kind);
                            }}
                          >
                            查看{item.kind === "mono" ? "单语" : "双语"}候选
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void guarded(async () => {
                                const bytes = await client.translationBytes(
                                  job,
                                  item.kind,
                                  scope.lease.signal,
                                );
                                scope.lease.assert();
                                saveFile(
                                  new Blob([bytes as Uint8Array<ArrayBuffer>], {
                                    type: "application/pdf",
                                  }),
                                  `${job.backend.simulation ? "simulation-not-translated" : `translation-${item.kind}`}-${job.state === "accepted" ? "reviewed" : "draft"}.pdf`,
                                );
                              })
                            }
                          >
                            下载{job.backend.simulation ? "模拟件" : "候选 PDF"}
                          </button>
                          {item.emptyTextPages.length > 0 && (
                            <span className="learning-warning">
                              无文字层页：{item.emptyTextPages.join("、")}
                            </span>
                          )}
                          {item.pages !==
                            job.sourcePages *
                              (item.kind === "dual" ? 2 : 1) && (
                            <span className="learning-warning">
                              页数与原件不符：预期{" "}
                              {job.sourcePages * (item.kind === "dual" ? 2 : 1)}{" "}
                              页，实际 {item.pages} 页，不能接受为译稿。
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {preview && artifact && (
                  <div className="translation-preview">
                    <label>
                      候选页码
                      <select
                        value={pageNumber}
                        onChange={(event) =>
                          setPageNumber(Number(event.target.value))
                        }
                      >
                        {Array.from({ length: artifact.pages }, (_, index) => (
                          <option key={index + 1} value={index + 1}>
                            第 {index + 1} 页
                          </option>
                        ))}
                      </select>
                    </label>
                    <button onClick={() => setPreview(undefined)}>
                      收起候选预览
                    </button>
                    <div className="translation-compare">
                      {!sourcePage && (
                        <p className="learning-muted">
                          在资料库选择本作业的原件，再左右对照。当前仅显示候选，不替换原件。
                        </p>
                      )}
                      {sourcePage && material && (
                        <LearningOriginalPage
                          material={material}
                          page={sourcePage}
                          client={client}
                        />
                      )}
                      <LearningPdfPreview
                        readBytes={readPreview}
                        number={pageNumber}
                        caption={`${job.backend.simulation ? "模拟件，不是译文" : "待审阅候选"} · 第 ${pageNumber} 页`}
                        showText
                      />
                    </div>
                  </div>
                )}
                {job.state === "review_required" && (
                  <div className="translation-review">
                    <h4>本人质量审阅</h4>
                    <div className="translation-checks">
                      {TranslationCheckIds.map((id) => (
                        <label key={id}>
                          {checks[id]}
                          <select
                            value={review.checks[id]}
                            onChange={(event) =>
                              changeReview({
                                checks: {
                                  ...review.checks,
                                  [id]: event.target.value as z.infer<
                                    typeof CheckDraft
                                  >,
                                },
                              })
                            }
                          >
                            <option value="">尚未检查</option>
                            <option value="pass">本次检查通过</option>
                            <option value="fail">发现问题</option>
                            <option value="not_applicable">本原件不涉及</option>
                          </select>
                        </label>
                      ))}
                      {job.backend.location==="cloud" && <label>专有名词与本作业术语表
                        <select value={review.terminology??""} onChange={e=>changeReview({terminology:CheckDraft.parse(e.target.value)})}>
                          <option value="">尚未检查</option><option value="pass">专有名词、缩写与术语一致</option>
                          <option value="fail">发现术语错译或不一致</option>
                          {!job.request.glossary.length && <option value="not_applicable">原件不涉及专有词</option>}
                        </select>
                      </label>}
                    </div>
                    <label>
                      发现、限制及不适用原因
                      <textarea
                        rows={3}
                        maxLength={4000}
                        value={review.notes}
                        onChange={(event) =>
                          changeReview({ notes: event.target.value })
                        }
                      />
                    </label>
                    <label className="learning-consent">
                      <input
                        type="checkbox"
                        checked={rendered}
                        onChange={(event) => setRendered(event.target.checked)}
                      />
                      已逐页对照原页和候选页面的实际渲染
                    </label>
                    <label className="learning-consent">
                      <input
                        type="checkbox"
                        checked={extracted}
                        onChange={(event) => setExtracted(event.target.checked)}
                      />
                      已检查可提取文本，不仅凭文件生成或截图判断
                    </label>
                    <div className="learning-actions">
                      <button
                        disabled={
                          busy || !!pending || !!recovery.error || !canAccept
                        }
                        onClick={() => void guarded(() => decide("accept"))}
                      >
                        接受这份候选译稿
                      </button>
                      <button
                        disabled={
                          busy || !!pending || !!recovery.error || !canReview
                        }
                        onClick={() => void guarded(() => decide("reject"))}
                      >
                        记录问题，不接受
                      </button>
                    </div>
                  </div>
                )}
                {job.review && (
                  <p>
                    本人{job.review.decision === "accept" ? "接受" : "未接受"} ·{" "}
                    {job.review.notes}（不是独立翻译质量认证）
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    saveFile(
                      new Blob([JSON.stringify(job, null, 2)], {
                        type: "application/json",
                      }),
                      "betterme-translation-receipt.json",
                    )
                  }
                >
                  导出当前作业回执
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </details>
  );
}
