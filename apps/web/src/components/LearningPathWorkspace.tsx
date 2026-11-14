import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookOpen, Check, FilePlus2, Pause, Volume2 } from "lucide-react";
import { z } from "zod";
import {
  GROWTH_PRACTICE_STARTER_SOURCE,
  LearningCommandSchema,
  LearningPathSchema,
  type LearningPath,
  type LearningMaterial,
  type LearningCitation,
  type LearningCommandInput,
} from "@better-me/agent-contracts";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { useWorkspaceRecovery } from "../lib/use-workspace-recovery";
import {
  defaultLearningClient,
  type LearningClient,
} from "../services/learning-client";
import { LearningOriginalPage } from "./LearningOriginalPage";
import { LearningTranslationPanel } from "./LearningTranslationPanel";
import { useAgentSpeech } from "./AgentSpeechControl";
import { useReducedMotion } from "../lib/ui-preferences";
import "./learning-path-workspace.css";

const Draft = z
  .object({
    answer: z.string().max(12000),
    explanation: z.string().max(12000),
    code: z.string().max(16000),
    decision: z.enum(["reuse_receipt", "reconcile_unknown", "retry_now"]),
    attribution: z.enum(["self_reported", "guided_example"]),
    runInstructions: z.string().max(4000),
    sample: z.string().max(4000),
    limitations: z.string().max(4000),
    personalWork: z.string().max(4000),
    toolWork: z.string().max(4000),
  })
  .strict();
const Operation = z
  .object({
    id: z.string(),
    kind: z.enum(["create", "command", "revoke"]),
    target: z.string(),
    input: z.string().max(100000),
  })
  .strict();
const Recovery = z
  .object({
    title: z.string().max(1000),
    weeklyHours: z.number().int().min(1).max(40),
    active: z.string().optional(),
    selection: z
      .object({
        materialId: z.string(),
        page: z.number().int(),
        blockId: z.string().optional(),
      })
      .strict()
      .optional(),
    drafts: z.record(Draft),
    operation: Operation.optional(),
    importOperation: z
      .object({ fingerprint: z.string(), id: z.string() })
      .strict()
      .optional(),
  })
  .strict();
const emptyDraft = (): z.infer<typeof Draft> => ({
  answer: "",
  explanation: "",
  code: "",
  decision: "reuse_receipt",
  attribution: "self_reported",
  runInstructions: "",
  sample: "",
  limitations: "",
  personalWork: "",
  toolWork: "",
});
const keys = new WeakMap<AbortSignal, number>();
let sequence = 0;
function identitySnapshot() {
  const lease = captureIdentityLease();
  return lease.ownerId && !lease.signal.aborted ? lease.signal : null;
}
function subscribeIdentity(notify: () => void) {
  const { signal } = captureIdentityLease();
  let live = true;
  const changed = () => {
    notify();
    queueMicrotask(() => {
      if (live) notify();
    });
  };
  signal.addEventListener("abort", changed);
  return () => {
    live = false;
    signal.removeEventListener("abort", changed);
  };
}
const statusLabels: Record<LearningPath["stage"], string> = {
  choose_source: "待选资料",
  practice: "练习中",
  checkpoint_saved: "断点已保存",
  pending_retest: "待隔时复测",
  retest_due: "复测已到期",
  review: "待周复盘",
  project: "待项目验收",
  completed: "学习项目已验收",
  outcome_unknown: "结果待核对",
  source_revoked: "资料已撤权",
};
const errors: Record<string, string> = {
  learning_retest_not_due: "复测尚未到期，没有提前生成新尝试。",
  learning_revision_conflict: "另一窗口已更新记录，请重新读取后再决定。",
  learning_material_revoked: "资料使用权限已撤回，已停止展示和朗读正文。",
  learning_passage_requires_review: "本页需要识别或校对，暂不能作为可靠引用。",
  learning_pdf_resource_limit:
    "PDF 解析超过资源或时间限制，已停止。请使用较小的分册。",
  learning_pdf_unreadable: "无法可靠读取这个 PDF；请检查是否损坏或加密。",
  learning_source_frozen:
    "练习已开始，出处已冻结。新资料请建立新目标，不会改写旧练习。",
  learning_pending_command: "上次动作回执尚未确认，请先核对。",
  learning_budget_exhausted: "当前根任务额度已用尽，不能通过新尝试重置额度。",
  learning_idempotency_conflict: "原操作编号绑定的内容不同，没有发送替换动作。",
};
function describe(error: unknown) {
  const message =
    error instanceof Error ? error.message : "没有收到可核对的回执";
  return errors[message] ?? message;
}
const shortHash = (hash: string) => hash.slice(0, 12);
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function LearningPathWorkspace({
  client = defaultLearningClient,
  cloudConfig,
}: {
  client?: LearningClient;
  cloudConfig?: import("@better-me/core").LlmConfig;
}) {
  const generation = useSyncExternalStore(
    subscribeIdentity,
    identitySnapshot,
    () => null,
  );
  if (!generation)
    return (
      <section className="learning-workspace">
        <h2>把读过的资料，变成可验证的进步</h2>
        <p>
          请先登录
          BetterMe。资料和练习只属于当前账号，不会读取旧简历或求职记录。
        </p>
      </section>
    );
  if (!keys.has(generation)) keys.set(generation, ++sequence);
  return <LearningSession key={keys.get(generation)} client={client} cloudConfig={cloudConfig} />;
}

function LearningSession({ client,cloudConfig }: { client: LearningClient;cloudConfig?:import("@better-me/core").LlmConfig }) {
  const reducedMotion = useReducedMotion();
  const [scope] = useState(() => ({
    lease: captureIdentityLease(),
    store: capturePrivateStorage(),
  }));
  const recovery = useWorkspaceRecovery("learning-path:v1", Recovery, () => ({
    title: "",
    weeklyHours: 3,
    drafts: {},
  }));
  const [record, setRecord] = useState<LearningPath>(),
    [paths, setPaths] = useState<LearningPath[]>([]),
    [materials, setMaterials] = useState<LearningMaterial[]>([]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [file, setFile] = useState<File>(),
    [importConsent, setImportConsent] = useState(false),
    [revokeConfirm, setRevokeConfirm] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showMaterial, setShowMaterial] = useState(false);
  const practiceRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false),
    lock = useRef(false),
    current = useRef(record);
  current.current = record;
  const alive = () => mounted.current && !scope.lease.signal.aborted;
  const speech = useAgentSpeech(
    `learning:${scope.lease.ownerId}`,
    !scope.lease.signal.aborted,
  );
  const selection = recovery.value.selection;
  const material = materials.find(
    (item) => item.id === selection?.materialId && !item.revoked,
  );
  const page = material?.pages.find((item) => item.number === selection?.page);
  const block = page?.blocks.find((item) => item.id === selection?.blockId);
  const citation: LearningCitation | undefined =
    material && page && block
      ? {
          materialId: material.id,
          materialHash: material.hash,
          materialRevision: material.revision,
          page: page.number,
          blockId: block.id,
          textHash: block.hash,
        }
      : undefined;
  const attempt = record?.attempts.at(-1),
    task = attempt?.task;
  const draftKey = record ? `${record.id}:${attempt?.id ?? "project"}` : "new";
  const draft = recovery.value.drafts[draftKey] ?? emptyDraft();
  function change(field: keyof z.infer<typeof Draft>, value: string) {
    const maximum =
      field === "code"
        ? 16000
        : ["answer", "explanation"].includes(field)
          ? 12000
          : 4000;
    if (value.length > maximum) {
      setError(`内容超过 ${maximum} 字符，未覆盖原草稿。可先下载草稿备份。`);
      return;
    }
    recovery.set((old) => ({
      ...old,
      drafts: {
        ...old.drafts,
        [draftKey]: Draft.parse({
          ...(old.drafts[draftKey] ?? emptyDraft()),
          [field]: value,
        }),
      },
    }));
  }
  function accept(next: LearningPath) {
    if (!alive()) return;
    if (next.attempts.length > (current.current?.attempts.length ?? 0))
      setShowMaterial(false);
    setRecord(next);
    setPaths((old) => [next, ...old.filter((item) => item.id !== next.id)]);
    recovery.field("active", next.id);
    if (next.citation && !next.sourceRevoked)
      recovery.field("selection", {
        materialId: next.citation.materialId,
        page: next.citation.page,
        blockId: next.citation.blockId,
      });
    if (next.sourceRevoked) speech.stop();
  }
  async function refresh(id = current.current?.id) {
    const [library, history, next] = await Promise.all([
      client.materials(scope.lease.signal),
      client.paths(scope.lease.signal),
      id ? client.get(id, scope.lease.signal) : undefined,
    ]);
    if (!alive()) return;
    setMaterials(library);
    setPaths(history);
    if (next) accept(next);
    if (
      selection &&
      library.find((item) => item.id === selection.materialId)?.revoked
    ) {
      speech.stop();
      setShowOriginal(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh(recovery.value.active)
      .then(() => {
        if (alive()) {
          setLoaded(true);
          if (recovery.value.active)
            setNotice("已恢复上次记录，只读取、不执行，也不会自动朗读。");
        }
      })
      .catch((failure) => {
        if (alive()) {
          setLoaded(true);
          setError(describe(failure));
        }
      });
    return () => {
      mounted.current = false;
    };
    // Restore is intentionally GET-only; no operation is replayed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scope]);
  useEffect(() => {
    if (!material) return;
    let live = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      void client
        .material(material.id, scope.lease.signal)
        .then((next) => {
          if (!live || !alive() || !next.revoked) return;
          speech.stop();
          setShowOriginal(false);
          setMaterials((old) =>
            old.map((item) => (item.id === next.id ? next : item)),
          );
          void refresh().catch(() => {});
        })
        .catch(() => {
          if (live) speech.stop();
        });
    };
    const timer = setInterval(check, 3000);
    window.addEventListener("focus", check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
    // Read permission only. No model, parser or practice execution on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material?.id, client, scope]);
  async function guarded(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      if (alive()) setError(`${describe(failure)} 没有自动重试。`);
    } finally {
      lock.current = false;
      if (alive()) setBusy(false);
    }
  }
  function persist(operation: z.infer<typeof Operation>) {
    recovery.field("operation", operation);
    const raw = scope.store.getItem("betterme.recovery.v1:learning-path:v1");
    const stored = z
      .object({ version: z.literal(1), value: Recovery })
      .parse(JSON.parse(raw ?? "null")).value.operation;
    if (JSON.stringify(stored) !== JSON.stringify(operation))
      throw new Error("操作编号未能保存，尚未发送；请下载草稿备份。");
  }
  async function dispatch(operation: z.infer<typeof Operation>) {
    persist(operation);
    if (operation.kind === "create")
      accept(
        await client.create(
          {
            ...JSON.parse(operation.input),
            requestId: operation.id,
            consent: true,
          },
          scope.lease.signal,
        ),
      );
    else if (operation.kind === "command")
      accept(
        await client.command(
          operation.target,
          LearningCommandSchema.parse(JSON.parse(operation.input)),
          scope.lease.signal,
        ),
      );
    else {
      speech.stop();
      setShowOriginal(false);
      const revoked = await client.revoke(
        operation.target,
        operation.id,
        scope.lease.signal,
      );
      if (alive())
        setMaterials((old) =>
          old.map((item) => (item.id === revoked.id ? revoked : item)),
        );
      await refresh();
      setRevokeConfirm(false);
    }
    if (alive()) recovery.field("operation", undefined);
  }
  function send(input: LearningCommandInput) {
    if (!record || record.pendingCommand || recovery.value.operation) return;
    void guarded(async () => {
      const id = crypto.randomUUID();
      await dispatch({
        id,
        kind: "command",
        target: record.id,
        input: JSON.stringify({
          ...input,
          requestId: id,
          expectedRevision: record.revision,
          consent: true,
        }),
      });
      if (alive())
        setNotice(
          input.kind === "step_attempt" &&
            current.current?.stage !== "outcome_unknown"
            ? "动作已保存回执；重新打开不会重新执行。"
            : "已保存，本次操作没有修改简历或求职数据。",
        );
    });
  }
  async function importFile() {
    if (!file || !importConsent) return;
    await guarded(async () => {
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
      )
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const fingerprint = `${file.name}:${hash}`,
        operation =
          recovery.value.importOperation?.fingerprint === fingerprint
            ? recovery.value.importOperation
            : { fingerprint, id: crypto.randomUUID() };
      recovery.field("importOperation", operation);
      const raw = scope.store.getItem("betterme.recovery.v1:learning-path:v1");
      if (
        JSON.parse(raw ?? "null")?.value?.importOperation?.id !== operation.id
      )
        throw new Error("导入编号未能保存，因此未发送文件。");
      const imported = await client.importMaterial(
        file,
        operation.id,
        scope.lease.signal,
      );
      if (!alive()) return;
      setMaterials((old) => [
        imported,
        ...old.filter((item) => item.id !== imported.id),
      ]);
      recovery.field("selection", { materialId: imported.id, page: 1 });
      recovery.field("importOperation", undefined);
      setFile(undefined);
      setImportConsent(false);
      setNotice(
        imported.revoked
          ? "这个不可变版本已经撤权，重复导入不会重新授权。请保留旧回执。"
          : "资料已保存在本账号隔离区。没有朗读，没有发送给模型，也没有运行练习。",
      );
    });
  }
  async function example() {
    if (
      !attempt ||
      !record ||
      attempt.submittedAt ||
      attempt.questionId !== "receipt-present-v1"
    )
      return;
    await guarded(async () => {
      if (!attempt.hints.length) {
        const id = crypto.randomUUID();
        await dispatch({
          id,
          kind: "command",
          target: record.id,
          input: JSON.stringify({
            kind: "reveal_hint",
            attemptId: attempt.id,
            draftAnswer: draft.answer,
            requestId: id,
            expectedRevision: record.revision,
            consent: true,
          }),
        });
      }
      if (alive())
        recovery.set((old) => ({
          ...old,
          drafts: {
            ...old.drafts,
            [draftKey]: {
              ...(old.drafts[draftKey] ?? emptyDraft()),
              code: GROWTH_PRACTICE_STARTER_SOURCE,
              attribution: "guided_example",
            },
          },
        }));
    });
  }
  function choose(materialId: string, number: number, blockId?: string) {
    speech.stop();
    setShowMaterial(true);
    setRevokeConfirm(false);
    recovery.field("selection", { materialId, page: number, blockId });
  }
  function read(id: string, text: string, selected?: LearningCitation) {
    if (!selected && record?.sourceRevoked) return;
    const access = selected ?? record?.citation;
    if (!access) return;
    speech.readText(id, text, async () => {
      try {
        await client.passage(access, scope.lease.signal);
        return alive();
      } catch {
        return false;
      }
    });
  }
  const playing =
    speech.state.key?.startsWith(`${speech.scope}\0`) &&
    speech.state.phase !== "idle";
  const blocked =
    busy ||
    !!recovery.value.operation ||
    !!record?.pendingCommand ||
    !!recovery.error ||
    !!record?.sourceRevoked;
  const pending = recovery.value.operation;
  const currentPlan = record?.plans.at(-1),
    review = record?.reviews.at(-1);
  function exportRecord() {
    if (!record) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "betterme.learning-receipt.v1",
              path: LearningPathSchema.parse(record),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `betterme-learning-${record.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="learning-workspace" aria-label="资料与隔时复测">
      <header className="learning-heading">
        <div>
          <span className="learning-eyebrow">
            <BookOpen size={15} />
            一次有出处的进步
          </span>
          <h2>{record?.title ?? "把读过的资料，变成可验证的进步"}</h2>
          <p>
            一份资料，一次练习，再用不同情境验证。学习记录独立保存，不写入简历或求职数据。
          </p>
        </div>
        {record && (
          <span className="learning-badge">{statusLabels[record.stage]}</span>
        )}
      </header>
      {record && (
        <div className="learning-next" aria-label="今天的下一步">
          <div>
            <span>上次停在 · {statusLabels[record.stage]}</span>
            <h3>{record.next.title}</h3>
            <p>{record.next.reason}</p>
          </div>
          <div className="learning-next-action">
            <span className="learning-time">
              {record.next.minutes
                ? `约 ${record.next.minutes} 分钟`
                : "按自己的节奏"}
            </span>
            {attempt && !record.sourceRevoked && (
              <button
                onClick={() =>
                  practiceRef.current?.scrollIntoView({
                    block: "start",
                    behavior: reducedMotion ? "instant" : "smooth",
                  })
                }
              >
                {["practice", "checkpoint_saved"].includes(record.stage)
                  ? "前往当前练习"
                  : "查看原答与检查"}
              </button>
            )}
          </div>
        </div>
      )}
      {!loaded && <p role="status">正在读取本账号的资料与练习…</p>}
      {notice && (
        <p role="status" className="learning-notice">
          {notice}
        </p>
      )}
      {(error || recovery.error) && (
        <div role="alert" className="learning-error">
          {error || recovery.error}
          <button onClick={recovery.download}>下载本页草稿备份</button>
        </div>
      )}
      {pending && (
        <div className="learning-warning" role="alert">
          <h3>上次动作的回执还需核对</h3>
          <p>先读取已有结果；只有你明确确认后才能继续。重开页面不会重发。</p>
          <details><summary>技术与审计详情</summary><p>原操作编号：{pending.id}</p></details>
          <div className="learning-actions">
            <button
              disabled={busy}
              onClick={() => void guarded(() => refresh())}
            >
              只读取已有结果
            </button>
            <button
              disabled={busy || !!recovery.error}
              onClick={() => void guarded(() => dispatch(pending))}
            >
              使用原编号核对并继续
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void guarded(async () => {
                  const latest = pending.target.startsWith("lp_")
                    ? await client.get(pending.target)
                    : undefined;
                  if (latest?.pendingCommand)
                    throw new Error("Host 仍有未确认动作，不能结束核对。");
                  await refresh();
                  recovery.field("operation", undefined);
                  setNotice(
                    "Host 未留下待核对动作；本机编号已归档，不会重新派送。",
                  );
                })
              }
            >
              重新读取后结束本机核对
            </button>
          </div>
        </div>
      )}
      {record?.pendingCommand && !pending && (
        <div className="learning-warning">
          <h3>有一个结果尚未确认的操作</h3>
          <p>仅核对原操作，不创建新动作或自动重试。</p>
          <details><summary>技术与审计详情</summary><p>{record.pendingCommand.kind} · {record.pendingCommand.requestId}</p></details>
          <button
            disabled={busy || !!recovery.error}
            onClick={() => {
              const command = record.pendingCommand!;
              void guarded(() =>
                dispatch({
                  id: command.requestId,
                  kind: "command",
                  target: record.id,
                  input: JSON.stringify(command),
                }),
              );
            }}
          >
            明确核对并继续
          </button>
        </div>
      )}
      {loaded && !record && (
        <form
          className="learning-card learning-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked || !recovery.value.title.trim()) return;
            void guarded(() =>
              dispatch({
                id: crypto.randomUUID(),
                kind: "create",
                target: "",
                input: JSON.stringify({
                  title: recovery.value.title,
                  weeklyHours: recovery.value.weeklyHours,
                }),
              }),
            );
          }}
        >
          <div>
            <h3>先定一个小目标</h3>
            <p>本轮聚焦一个技能：实现可恢复的小 Agent。</p>
          </div>
          <label>
            目标名称
            <textarea
              name="learning-goal"
              rows={2}
              value={recovery.value.title}
              placeholder="例如：做出能复用回执、识别未知结果的小 Agent"
              onChange={(event) => {
                if (event.target.value.length <= 1000)
                  recovery.field("title", event.target.value);
                else setError("目标最多 1000 字符，未覆盖原草稿。");
              }}
            />
          </label>
          <label>
            每周投入（小时）
            <input
              name="learning-hours"
              type="number"
              min={1}
              max={40}
              value={recovery.value.weeklyHours}
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 40)
                  recovery.field("weeklyHours", n);
              }}
            />
          </label>
          <button
            className="learning-primary"
            disabled={blocked || !recovery.value.title.trim()}
          >
            保存目标，不执行练习
          </button>
        </form>
      )}
      {loaded && (
        <details
          className="learning-library learning-card"
          open={!record?.citation}
        >
          <summary>
            <span>资料库</span>
            <span>
              {materials.filter((item) => !item.revoked).length} 份可用 ·
              版本独立
            </span>
          </summary>
          <div className="learning-import">
            <label className="learning-file">
              <FilePlus2 size={18} />
              选择 PDF / UTF-8 文本
              <input
                type="file"
                accept=".pdf,.txt"
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.files?.[0];
                  if (next && (!next.size || next.size > 8 * 1024 * 1024)) {
                    setError("请选择不超过 8 MiB 的非空文件。");
                    return;
                  }
                  setFile(next);
                  setImportConsent(false);
                }}
              />
            </label>
            {file && (
              <span>
                {file.name} · {Math.ceil(file.size / 1024)} KiB
              </span>
            )}
            <label className="learning-consent">
              <input
                type="checkbox"
                checked={importConsent}
                onChange={(event) => setImportConsent(event.target.checked)}
              />
              只授权导入当前账号隔离区，不等于朗读或模型授权
            </label>
            <button
              disabled={busy || !file || !importConsent || !!recovery.error}
              onClick={() => void importFile()}
            >
              导入选定资料
            </button>
          </div>
          {materials.length === 0 && (
            <p className="learning-muted">
              尚未导入资料。不会自动扫描你的文件。
            </p>
          )}
          <div className="learning-versions">
            {materials.map((item) => (
              <button
                key={item.id}
                className={
                  selection?.materialId === item.id ? "is-selected" : ""
                }
                disabled={busy || item.revoked}
                onClick={() => choose(item.id, 1)}
              >
                <strong>{item.name}</strong>
                <span>
                  {item.revoked ? "已撤权" : `${item.pages.length} 页`} ·{" "}
                  {shortHash(item.hash)} · {date(item.importedAt)}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}
      {loaded && <LearningTranslationPanel material={material} client={client} cloudConfig={cloudConfig} />}
      {material && (
        <details
          className="learning-card learning-material"
          open={!record?.attempts.length || showMaterial}
          onToggle={(event) => {
            if (record?.attempts.length)
              setShowMaterial(event.currentTarget.open);
          }}
        >
          <summary>
            浏览资料 · {material.name} · {shortHash(material.hash)}
          </summary>
          <div className="learning-section-heading">
            <div>
              <h3>{material.name}</h3>
              <p className="learning-muted">
                版本 {shortHash(material.hash)} · 原件与选段均校验哈希 ·
                未授权模型访问
              </p>
            </div>
            <button
              disabled={busy}
              onClick={() => setRevokeConfirm((value) => !value)}
            >
              撤回资料使用权限
            </button>
          </div>
          {revokeConfirm && (
            <div className="learning-warning">
              <p>
                撤回后，本版本正文不再提供给检索、朗读或练习；旧尝试和出处标识保留。重复导入相同版本不会恢复授权。
              </p>
              <div className="learning-actions">
                <button
                  disabled={busy || !!recovery.value.operation}
                  onClick={() =>
                    void guarded(() =>
                      dispatch({
                        id: crypto.randomUUID(),
                        kind: "revoke",
                        target: material.id,
                        input: "{}",
                      }),
                    )
                  }
                >
                  确认撤回这个版本
                </button>
                <button disabled={busy} onClick={() => setRevokeConfirm(false)}>
                  保留权限
                </button>
              </div>
            </div>
          )}
          <nav className="learning-pages" aria-label="资料页码">
            {material.pages.map((item) => (
              <button
                key={item.number}
                disabled={busy}
                aria-current={page?.number === item.number ? "page" : undefined}
                onClick={() => choose(material.id, item.number)}
              >
                第 {item.number} 页
                <span>
                  {item.status === "text"
                    ? "可引用"
                    : item.status === "needs_review"
                      ? "需校对"
                      : "需要识别"}
                </span>
              </button>
            ))}
          </nav>
          {page && (
            <>
              {page.status !== "text" && (
                <p className="learning-warning">
                  {page.issue} 本页不能直接用于练习或朗读；没有启用外部
                  OCR，也不将空白标成成功。
                </p>
              )}
              <div
                className="learning-material-grid"
                data-empty={page.blocks.length === 0}
              >
                <div
                  className="learning-blocks"
                  aria-label={`第 ${page.number} 页的段落`}
                >
                  {page.blocks.length === 0 && (
                    <p>本页没有可靠的文字层，请回看原页。</p>
                  )}
                  {page.blocks.map((item) => (
                    <button
                      key={item.id}
                      disabled={busy}
                      aria-pressed={block?.id === item.id}
                      onClick={() => choose(material.id, page.number, item.id)}
                    >
                      <span>{item.id}</span>
                      <span>{item.text}</span>
                      {block?.id === item.id && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <div className="learning-selection">
                  {block ? (
                    <>
                      <span className="learning-eyebrow">
                        已选第 {page.number} 页 · {block.id}
                      </span>
                      <blockquote>{block.text}</blockquote>
                      <div className="learning-actions">
                        <button
                          disabled={page.status !== "text"}
                          onClick={() =>
                            read(`passage:${block.hash}`, block.text, citation)
                          }
                        >
                          <Volume2 size={15} />
                          点播选段
                        </button>
                        <button
                          onClick={() => setShowOriginal((value) => !value)}
                        >
                          {showOriginal ? "收起原页" : "查看原页与定位"}
                        </button>
                      </div>
                      {record && !record.attempts.length && (
                        <button
                          className="learning-primary"
                          disabled={
                            blocked || page.status !== "text" || !citation
                          }
                          onClick={() =>
                            citation &&
                            send({ kind: "select_passage", citation })
                          }
                        >
                          明确将这段用于本地练习
                        </button>
                      )}
                      <p className="learning-muted">
                        练习只取得这个片段；不会读取整库，也不会调用文本模型。
                      </p>
                    </>
                  ) : (
                    <>
                      <h4>
                        {page.blocks.length
                          ? "选一段，建立你的出处"
                          : "本页需要识别"}
                      </h4>
                      <p>
                        {page.blocks.length
                          ? "点击左侧原文，先核对原页，再单独决定是否用于练习。"
                          : "没有可靠的文字层，请先核对原页。本轮不会自动运行 OCR 或向外部发送原件。"}
                      </p>
                      <button
                        onClick={() => setShowOriginal((value) => !value)}
                      >
                        {showOriginal ? "收起原页" : "查看原页"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {showOriginal && (
                <LearningOriginalPage
                  key={`${material.id}:${page.number}:${block?.id}`}
                  material={material}
                  page={page}
                  blockId={block?.id}
                  client={client}
                />
              )}
            </>
          )}
        </details>
      )}
      {record?.citation && (
        <div className="learning-citation">
          <span>
            练习出处 · 第 {record.citation.page} 页 / {record.citation.blockId}{" "}
            · {shortHash(record.citation.materialHash)} · 段落{" "}
            {shortHash(record.citation.textHash)}
          </span>
          <button
            disabled={busy || record.sourceRevoked}
            onClick={() => {
              const selected = record.citation!;
              choose(selected.materialId, selected.page, selected.blockId);
              setShowMaterial(true);
              setShowOriginal(true);
            }}
          >
            回到这次练习的原处
          </button>
          {record.attempts.length > 0 && (
            <span>出处已冻结，同名新版本不会替换它。</span>
          )}
        </div>
      )}
      {record &&
        !record.sourceRevoked &&
        record.citation &&
        record.attempts.length === 0 && (
          <button
            className="learning-primary"
            disabled={blocked}
            onClick={() =>
              send({ kind: "start_attempt", questionId: "receipt-present-v1" })
            }
          >
            开始首次练习
          </button>
        )}
      {record &&
        (record.stage === "retest_due" ||
          (record.stage === "review" &&
            currentPlan?.nextStep === "supplement" &&
            review?.status === "accepted" &&
            review.evidenceAttemptIds.at(-1) === attempt?.id)) && (
          <button
            className="learning-primary"
            disabled={blocked}
            onClick={() =>
              send({
                kind: "start_attempt",
                questionId: record.attempts.some(
                  (item) => item.questionId === "receipt-missing-v1",
                )
                  ? "receipt-transfer-v1"
                  : "receipt-missing-v1",
              })
            }
          >
            {record.attempts.length < 2
              ? "开始到期换题复测"
              : "按采纳的计划建立补练"}
          </button>
        )}
      {record?.stage === "pending_retest" && record.dueAt && (
        <div className="learning-card">
          <h3>这次检查结束了，下次用不同情境再试</h3>
          <p>
            复测开放时间：{date(record.dueAt)}
            。到期后重新读取即可看到新题，不会自动创建或执行。
          </p>
          <p className="learning-muted">
            目前仅有本次程序用例结果，不代表解释已被评判，或已保持掌握七天。
          </p>
        </div>
      )}
      {attempt && !record?.sourceRevoked && (
        <div ref={practiceRef} className="learning-card learning-practice">
          <div className="learning-section-heading">
            <h3>
              {record!.attempts.length === 1 ? "首次练习" : "换题复测"} · 尝试{" "}
              {record!.attempts.length}
            </h3>
            <button
              onClick={() => read(`question:${attempt.id}`, attempt.prompt)}
            >
              <Volume2 size={15} />
              点播这道题
            </button>
          </div>
          <p className="learning-prompt">{attempt.prompt}</p>
          {!attempt.submittedAt ? (
            <>
              <div className="learning-actions">
                <button
                  disabled={blocked || !!attempt.hints.length}
                  onClick={() =>
                    send({
                      kind: "reveal_hint",
                      attemptId: attempt.id,
                      draftAnswer: draft.answer,
                    })
                  }
                >
                  保存当前原答，再看提示
                </button>
                {attempt.questionId === "receipt-present-v1" && (
                  <button disabled={blocked} onClick={() => void example()}>
                    载入辅助代码（记录提示）
                  </button>
                )}
              </div>
              {attempt.hints.map((hint) => (
                <aside className="learning-warning" key={hint.at}>
                  <p>{hint.content}</p>
                  <details>
                    <summary>查看提示前原答</summary>
                    <pre>{hint.draftAnswer || "当时尚未作答"}</pre>
                  </details>
                </aside>
              ))}
              <label>
                我的原答
                <textarea
                  name="learning-answer"
                  rows={3}
                  value={draft.answer}
                  onChange={(event) => change("answer", event.target.value)}
                />
              </label>
              <label>
                我的决定
                <select
                  name="learning-decision"
                  value={draft.decision}
                  onChange={(event) => change("decision", event.target.value)}
                >
                  <option value="reuse_receipt">复用已保存的成功回执</option>
                  <option value="reconcile_unknown">
                    结果未知，先用原操作编号对账
                  </option>
                  <option value="retry_now">没有回执，立即重试</option>
                </select>
              </label>
              <label>
                为什么这样做
                <textarea
                  name="learning-explanation"
                  rows={3}
                  value={draft.explanation}
                  onChange={(event) =>
                    change("explanation", event.target.value)
                  }
                />
              </label>
              <label>
                可运行的 decide(input) 代码
                <textarea
                  name="learning-code"
                  className="learning-code"
                  rows={10}
                  spellCheck={false}
                  value={draft.code}
                  onChange={(event) => change("code", event.target.value)}
                />
              </label>
              <label>
                内容归属
                <select
                  value={draft.attribution}
                  onChange={(event) =>
                    change("attribution", event.target.value)
                  }
                >
                  <option value="self_reported">
                    本人自述（不是独立完成认证）
                  </option>
                  <option value="guided_example">教学辅助样例</option>
                </select>
              </label>
              <button
                className="learning-primary"
                disabled={
                  blocked ||
                  !draft.answer.trim() ||
                  !draft.explanation.trim() ||
                  !draft.code.trim()
                }
                onClick={() =>
                  send({
                    kind: "submit_answer",
                    attemptId: attempt.id,
                    answer: draft.answer,
                    explanation: draft.explanation,
                    sourceCode: draft.code,
                    decision: draft.decision,
                    attribution: draft.attribution,
                  })
                }
              >
                冻结原答与代码，尚不执行
              </button>
            </>
          ) : (
            <>
              <p>原答已冻结，归属和提示记录不能靠修改下拉框抹去。</p>
              <blockquote>{attempt.answer}</blockquote>
              <p className="learning-muted">
                {attempt.independent
                  ? "本题首次出现、未记录提示，本人自述完成；不是独立完成认证。"
                  : "使用辅助或已见过本题，不标记为独立完成。"}{" "}
                解释原文保存，不自动做语义评分。
              </p>
            </>
          )}
          {task && (
            <div className="learning-checkpoint">
              <h4>
                {task.practice.phase === "lookup_saved"
                  ? "断点已保存，可以安全关闭"
                  : task.practice.phase === "verified"
                    ? "指定代码用例通过"
                    : task.practice.phase === "failed"
                      ? "指定代码用例未通过"
                      : task.practice.phase === "outcome_unknown"
                        ? "结果未知，不能自动重试"
                        : "等待本人执行"}
              </h4>
              <p>
                本次 lookup {task.practice.checkpoint?.lookupCalls ?? 0} 次 ·
                工具／沙箱 {task.usage.toolCalls} · 模型 {task.usage.modelCalls}
              </p>
              {task.practice.checkpoint && (
                <p className="learning-muted">
                  原结果哈希 {shortHash(task.practice.checkpoint.resultHash)}
                  ；继续检查复用此断点，不重复查询。
                </p>
              )}
              {["ready", "lookup_saved"].includes(task.practice.phase) && (
                <button
                  className="learning-primary"
                  disabled={blocked || task.status === "budget_exhausted"}
                  onClick={() =>
                    send({
                      kind: "step_attempt",
                      attemptId: attempt.id,
                      expectedTaskRevision: task.revision,
                    })
                  }
                >
                  {task.practice.phase === "ready"
                    ? "运行第一步并保存断点"
                    : "手动继续固定检查"}
                </button>
              )}
              {task.status === "budget_exhausted" && (
                <p className="learning-warning">
                  根任务额度已耗尽，停止执行，不通过新目标自动加额。
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {record && record.attempts.length > 0 && (
        <details
          className="learning-card learning-history"
          open={record.stage === "review" || record.stage === "project"}
        >
          <summary>原答与验证历史 · {record.attempts.length} 次尝试</summary>
          <p className="learning-muted">
            通过和失败均保留。固定用例检查代码行为，不给解释正文打分，不代表永久掌握。
          </p>
          {record.attempts.map((item, index) => (
            <article key={item.id}>
              <h4>
                尝试 {index + 1} ·{" "}
                {item.questionId === "receipt-present-v1"
                  ? "已有回执"
                  : item.questionId === "receipt-missing-v1"
                    ? "回执丢失"
                    : "迁移到新操作"}
              </h4>
              <p>
                {item.decisionPassed === undefined
                  ? "尚未提交"
                  : item.decisionPassed
                    ? "情境选项正确"
                    : "情境选项未通过"}{" "}
                · {item.hints.length ? "记录过提示" : "未记录提示"} ·{" "}
                {item.task?.practice.verification
                  ? `代码 ${item.task.practice.verification.passed}/${item.task.practice.verification.total}`
                  : record.sourceRevoked
                    ? "正文与任务内容已隐藏"
                    : "代码尚未验收"}
              </p>
              <details>
                <summary>题目、原答、解释与运行回执</summary>
                <p>{item.prompt}</p>
                <blockquote>{item.answer ?? "尚未作答"}</blockquote>
                <p>{item.explanation}</p>
                {item.hints.map((hint) => (
                  <p key={hint.at}>
                    提示前原答：{hint.draftAnswer || "未填写"} · {date(hint.at)}
                  </p>
                ))}
                {item.task && (
                  <>
                    <pre>{item.task.request.sourceCode}</pre>
                    <p>
                      验证器{" "}
                      {item.task.practice.verification?.verifierVersion ??
                        "尚未运行"}{" "}
                      · lookup {item.task.practice.checkpoint?.lookupCalls ?? 0}
                    </p>
                    <ul>
                      {item.task.practice.verification?.checks.map((check) => (
                        <li key={check.id}>
                          {check.passed ? "通过" : "失败"} · {check.id}
                        </li>
                      ))}
                    </ul>
                    {item.task.practice.verification?.observations && (
                      <details>
                        <summary>实际行为观测（输入哈希与输出决定）</summary>
                        <pre>
                          {JSON.stringify(
                            item.task.practice.verification.observations,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    )}
                  </>
                )}
                <code>{item.id}</code>
              </details>
            </article>
          ))}
        </details>
      )}
      {record?.stage === "review" && (
        <div className="learning-card">
          <h3>对照每次尝试，决定下一步</h3>
          <p>
            建议会引用已保存的原答和实际代码回执。只有你接受，才会创建新版计划。
          </p>
          {review?.status !== "proposed" && (
            <button
              disabled={blocked}
              onClick={() => send({ kind: "propose_review" })}
            >
              生成有据周复盘建议（本地规则）
            </button>
          )}
          {review && (
            <div className="learning-review">
              <p>
                {record.attempts.reduce(
                  (text, item, index) =>
                    text.replaceAll(item.id, `尝试 ${index + 1}`),
                  review.reason,
                )}
              </p>
              <dl>
                <div>
                  <dt>当前计划</dt>
                  <dd>每周 {review.previousHours} 小时</dd>
                </div>
                <div>
                  <dt>建议改为</dt>
                  <dd>
                    每周 {review.proposedHours} 小时 ·{" "}
                    {review.nextStep === "project"
                      ? "进入项目"
                      : "补练未知结果"}
                  </dd>
                </div>
              </dl>
              <p className="learning-muted">
                依据{" "}
                {review.evidenceAttemptIds
                  .map(
                    (id) =>
                      `尝试 ${record.attempts.findIndex((item) => item.id === id) + 1}`,
                  )
                  .join(" / ")}{" "}
                ·{" "}
                {review.status === "proposed"
                  ? "待本人决定"
                  : review.status === "accepted"
                    ? "已采纳，计划已生成新版本"
                    : "已拒绝，原计划未改"}
              </p>
              {review.status === "proposed" && (
                <div className="learning-actions">
                  <button
                    className="learning-primary"
                    disabled={blocked}
                    onClick={() =>
                      send({
                        kind: "decide_review",
                        reviewId: review.id,
                        decision: "accept",
                      })
                    }
                  >
                    采纳为新版计划
                  </button>
                  <button
                    disabled={blocked}
                    onClick={() =>
                      send({
                        kind: "decide_review",
                        reviewId: review.id,
                        decision: "reject",
                      })
                    }
                  >
                    拒绝建议，保留历史
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {record?.stage === "project" && task?.practice.verificationHash && (
        <div className="learning-card learning-practice">
          <h3>本人验收一份学习项目</h3>
          <p>
            代码和原答已保存在本次尝试中。请补全可复核说明，不会自动写成工作经历。
          </p>
          {(
            [
              ["runInstructions", "运行说明"],
              ["sample", "输入与输出样例"],
              ["limitations", "已知限制与未验证部分"],
              ["personalWork", "本人完成了什么"],
              ["toolWork", "工具或示例完成了什么"],
            ] as const
          ).map(([field, label]) => (
            <label key={field}>
              {label}
              <textarea
                rows={3}
                value={draft[field]}
                onChange={(event) => change(field, event.target.value)}
              />
            </label>
          ))}
          <button
            className="learning-primary"
            disabled={
              blocked ||
              ![
                draft.runInstructions,
                draft.sample,
                draft.limitations,
                draft.personalWork,
                draft.toolWork,
              ].every((value) => value.trim())
            }
            onClick={() =>
              send({
                kind: "accept_project",
                attemptId: attempt!.id,
                reportHash: task.practice.verificationHash!,
                runInstructions: draft.runInstructions,
                sample: draft.sample,
                limitations: draft.limitations,
                personalWork: draft.personalWork,
                toolWork: draft.toolWork,
              })
            }
          >
            本人确认验收，仅保存为学习项目
          </button>
        </div>
      )}
      {record?.project && (
        <div className="learning-card learning-completed">
          <h3>有一份可复核的学习项目了</h3>
          <p>
            已保存代码、样例、运行说明、限制和贡献边界。能力状态仍是“已观察、非认证”，不等于生产部署或职业经历。
          </p>
          <details>
            <summary>查看本人验收说明</summary>
            {(
              [
                ["runInstructions", "运行说明"],
                ["sample", "样例"],
                ["limitations", "限制"],
                ["personalWork", "本人贡献"],
                ["toolWork", "工具贡献"],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <h4>{label}</h4>
                <p>{record.project![field]}</p>
              </div>
            ))}
          </details>
        </div>
      )}
      {record && (
        <footer className="learning-footer">
          <span>
            计划 v{currentPlan?.revision} · 每周 {currentPlan?.weeklyHours} 小时
            · 累计查询 {record.usage.lookupCalls} 次 · 模型{" "}
            {record.usage.modelCalls} 次
          </span>
          <div className="learning-actions">
            <button
              disabled={busy}
              onClick={() => void guarded(() => refresh())}
            >
              只读刷新
            </button>
            <button onClick={exportRecord}>导出学习回执</button>
            <button
              disabled={busy || !!pending}
              onClick={() => {
                speech.stop();
                recovery.field("active", undefined);
                setRecord(undefined);
                setShowOriginal(false);
              }}
            >
              返回目标列表
            </button>
          </div>
        </footer>
      )}
      {loaded && !record && paths.length > 0 && (
        <div className="learning-card">
          <h3>继续本账号的目标</h3>
          <div className="learning-versions">
            {paths.map((item) => (
              <button
                disabled={busy}
                key={item.id}
                onClick={() =>
                  void guarded(async () => {
                    accept(await client.get(item.id));
                    setNotice("已读取记录，未执行任何练习。");
                  })
                }
              >
                <strong>{item.title}</strong>
                <span>
                  {statusLabels[item.stage]} · {date(item.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <details className="learning-boundaries">
        <summary>本轮能力与外部引擎边界</summary>
        <p>
          资料提取、朗读和练习留在本机。导入不会授予模型访问权。PDF 中译英由你为单份原件选择本机或云端，云端另需一次对外发送许可；没有可用引擎就不启动。OXR 尚未接入。DeepTutor
          教学方法已用于目标、练习、复测设计，尚未接入其共享账号服务。
        </p>
        <p>
          Windows 声音库与真实试听需要 Windows 实机验收，CI
          成功不等于可听见。按键口述、实时通话和云端音色未开启。
        </p>
      </details>
      {playing && (
        <div className="learning-speech" role="status">
          <span>
            <Volume2 size={16} />
            {speech.state.phase === "starting"
              ? "正在核对并准备朗读…"
              : "正在本机朗读"}
          </span>
          <button onClick={speech.stop}>
            <Pause size={15} />
            停止朗读
          </button>
        </div>
      )}
      {speech.state.key?.startsWith(`${speech.scope}\0`) &&
        speech.state.issue && (
          <p className="learning-warning" role="status">
            {speech.state.issue === "access_revoked"
              ? "资料权限无法核对，朗读已停止。"
              : speech.state.issue === "voice_missing"
                ? "本机缺少就绪的对应语言音色。文字仍可阅读，未切换云端。"
                : "本机朗读暂不可用，文字和草稿仍保留，未切换云端。"}
          </p>
        )}
      {busy && (
        <p role="status" className="learning-muted">
          正在等待持久化回执…
        </p>
      )}
    </section>
  );
}
