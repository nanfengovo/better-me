import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { z } from "zod";
import {
  OutcomeFeedbackReportSchema, OutcomeFeedbackSnapshotInputSchema, OutcomeFeedbackSnapshotSchema,
  PersonalRuleSidecarSchema, RuleEvolutionProposalSchema, ReplayCheckpointSchema,
  validateReplayCheckpoint, validatePersonalRuleSidecar, hashCommitteeText, PERSONAL_RULE_TEXT,
  type EvolutionPatch, type OutcomeFeedbackReport, type PersonalRuleSidecar, type ReplayCheckpoint, type RuleEvolutionProposal,
} from "@better-me/core/career-intelligence";
import "./CareerReplayFeedbackPanel.css";

export interface CareerReplayFeedbackPanelProps {
  contextId: string;
  runtime: { model: string; modelDigest: string };
  request(route: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}
const id = z.string().min(1).max(240), hash = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.object({ workspaceKey: id, resumeId: id, versionId: id, contentHash: hash,
  versionBinding: z.enum(["trusted_workspace_version", "content_addressed_context"]), claims: z.array(z.object({ id, text: z.string().optional(), hash })).max(200),
});
type Identity = z.infer<typeof IdentitySchema>;
const EnvelopeSchema = z.object({ ownerId: id, headId: id, checkpoints: z.array(ReplayCheckpointSchema).min(1).max(4000) }).passthrough();
type RunView = { runId: string; headId: string; checkpoints: ReplayCheckpoint[] };
const eventKinds = { unknown: "结果未知", submitted: "已提交（自述）", viewed: "已读（自述）", interview_invited: "获面试邀请", interview_completed: "已完成面试", rejected: "明确拒绝", offer: "收到Offer", withdrawn: "本人撤回", no_response: "暂未收到回复（仍未知）" } as const;
const statusLabels: Record<string, string> = { completed: "已完成本次分析", partial: "部分完成", stale: "输入或授权已过期", cancelled: "已取消", budget_exhausted: "达到执行预算", storage_conflict: "存储版本冲突", failed: "未完成" };
const uid = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}`;
const shortHash = (value: string) => `${value.slice(0, 12)}…`;
const formatTime = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const timeValue = (value: string): number => {
  const parts = value.split(":").map(part => Number(part.replace(",", ".")));
  if (parts.some(part => !Number.isFinite(part) || part < 0) || parts.slice(1).some(part => part >= 60)) throw new Error("分钟/秒必须小于60，请核对转写时间段。");
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
};

/** Local text parsing only. Untimed notes get 0/0 and are explicitly labeled as untimed, not fabricated interview minutes. */
export function parseFeedbackTranscript(text: string): { segments: Array<{ id: string; startMs: number; endMs: number; text: string }>; timed: boolean } {
  if (!text.trim() || text.length > 64000 || text.includes(String.fromCharCode(0))) throw new Error("复盘文本为空、过大或含不可读取字符（上限64,000字）。");
  const lines = text.split(/\r?\n/), segments: Array<{ id: string; startMs: number; endMs: number; text: string }> = [];
  const range = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*(?:-->|[-–—])\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*(.*)$/;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = line.match(range); if (!match) continue;
    const startMs = timeValue(match[1]!), endMs = timeValue(match[2]!);
    if (endMs < startMs || endMs > 86_400_000 || segments.length >= 500) throw new Error("时间段须按起止顺序排列，最长24小时，最多500段。");
    let segmentText = match[3]!.trim();
    if (!segmentText) {
      const cueLines: string[] = [];
      while (index + 1 < lines.length && lines[index + 1]!.trim() && !range.test(lines[index + 1]!)) { index++; cueLines.push(lines[index]!); }
      segmentText = cueLines.join(text.includes("\r\n") ? "\r\n" : "\n").trim();
    }
    if (!segmentText) throw new Error("时间段后缺少可引用的转写文本。");
    segments.push({ id: `segment-${segments.length + 1}`, startMs, endMs, text: segmentText });
  }
  if (segments.length) return { segments, timed: true };
  if (text.length > 8000) throw new Error("未分段笔记上限8,000字；较长文本请按 [18:00-18:30] 内容 分段。");
  return { segments: [{ id: "segment-1", startMs: 0, endMs: 0, text }], timed: false };
}

export default function CareerReplayFeedbackPanel(props: CareerReplayFeedbackPanelProps) {
  return <ReplayFeedbackSession key={`${props.contextId}:${props.runtime.modelDigest}`} {...props} />;
}
export { CareerReplayFeedbackPanel };

function ReplayFeedbackSession({ contextId, runtime, request }: CareerReplayFeedbackPanelProps) {
  const [identity, setIdentity] = useState<Identity>();
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined), alive = useRef(true);
  const [assumptions, setAssumptions] = useState(""), [resumeStep, setResumeStep] = useState(true), [jobStep, setJobStep] = useState(false), [replayConsent, setReplayConsent] = useState(false);
  const [run, setRun] = useState<RunView>(), [runId, setRunId] = useState(""), [checkpointId, setCheckpointId] = useState(""), [runStatus, setRunStatus] = useState("");
  const [parentRunId, setParentRunId] = useState(""), [parentIntact, setParentIntact] = useState(false);
  const createKey = useRef(uid("replay")), createInputKey = useRef(""), reviewedRuleVersion = useRef("");
  const [applicationId, setApplicationId] = useState(""), [eventKind, setEventKind] = useState<keyof typeof eventKinds>("unknown"), [origin, setOrigin] = useState<"self_report" | "platform_receipt">("self_report"), [receiptId, setReceiptId] = useState("");
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [events, setEvents] = useState<Array<{ id: string; applicationId: string; kind: keyof typeof eventKinds; happenedAt: string; origin: "self_report" | "platform_receipt"; receiptId: string | null }>>([]);
  const [note, setNote] = useState(""), [noteReviewed, setNoteReviewed] = useState(false), [audioSha, setAudioSha] = useState(""), [correction, setCorrection] = useState("0"), [importName, setImportName] = useState("");
  const [claimId, setClaimId] = useState(""), [topic, setTopic] = useState<"contribution" | "metrics" | "architecture" | "clarity">("contribution"), [linkConfirmed, setLinkConfirmed] = useState(false), [feedbackConsent, setFeedbackConsent] = useState(false);
  const [feedbackId, setFeedbackId] = useState(""), [report, setReport] = useState<OutcomeFeedbackReport>(), [patchIds, setPatchIds] = useState<string[]>([]);
  const pendingFeedback = useRef<{ idempotencyKey: string; payload: unknown } | undefined>(undefined);
  const [target, setTarget] = useState<"guideline" | "skill">("guideline"), [initialRules, setInitialRules] = useState("");
  const [proposal, setProposal] = useState<RuleEvolutionProposal>(), [rule, setRule] = useState<PersonalRuleSidecar>(), [preview, setPreview] = useState(""), [applyConfirmed, setApplyConfirmed] = useState(false), [exportConfirmed, setExportConfirmed] = useState(false);
  const applyDecision = useRef(uid("apply")), revertDecision = useRef(uid("revert"));
  const selectedCheckpoint = run?.checkpoints.find(checkpoint => checkpoint.id === checkpointId) ?? run?.checkpoints.at(-1);
  const selectedPatchCount = patchIds.length;

  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);

  async function action(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(label); setError(""); setNotice("");
    try { await work(active.signal); }
    catch (cause) { if (alive.current && !active.signal.aborted) setError(cause instanceof Error ? cause.message : "本次操作未获确认；请先对账，不要自动重复写入。"); }
    finally { if (controller.current === active) controller.current = undefined; if (alive.current) setBusy(""); }
  }
  function requireActive(signal: AbortSignal) { if (!alive.current || signal.aborted) throw new Error("本次等待已结束，迟到结果不显示。"); }
  async function call(route: string, body: unknown, signal: AbortSignal) { const result = await request(route, body, signal); requireActive(signal); return result; }
  async function loadIdentity(signal: AbortSignal) {
    const next = IdentitySchema.parse(await call("/feedback/identity", { contextId }, signal));
    if (!next.claims.length) throw new Error("当前内容快照没有可映射条目，请先选择简历条目。");
    setIdentity(next); setClaimId(current => next.claims.some(claim => claim.id === current) ? current : next.claims[0]!.id); return next;
  }
  async function loadRun(idToLoad: string, signal: AbortSignal): Promise<RunView> {
    const envelope = EnvelopeSchema.parse(await call("/replay/get", { contextId, runId: idToLoad }, signal));
    const checkpoints = await Promise.all(envelope.checkpoints.map(checkpoint => validateReplayCheckpoint(checkpoint)));
    if (checkpoints.some(checkpoint => checkpoint.runId !== idToLoad) || !checkpoints.some(checkpoint => checkpoint.id === envelope.headId)) throw new Error("分支/检查点绑定不一致，未展示。");
    requireActive(signal); const next = { runId: idToLoad, headId: envelope.headId, checkpoints };
    setRun(next); setRunId(idToLoad); setCheckpointId(envelope.headId); return next;
  }
  function feedbackChanged() { pendingFeedback.current = undefined; setFeedbackId(""); setReport(undefined); setPatchIds([]); setProposal(undefined); setPreview(""); setApplyConfirmed(false); setExportConfirmed(false); }
  async function startReplay() {
    await action("执行有界回放", async signal => {
      const version = identity ?? await loadIdentity(signal);
      const steps = [ ...(resumeStep ? [{ id: "resume-review", kind: "analysis", operation: "resume-review", input: { focus: "事实与个人贡献边界" } }] : []),
        ...(jobStep ? [{ id: "job-gap-review", kind: "analysis", operation: "job-gap-review", input: { focus: "岗位证据差异，不预测Offer" } }] : []) ];
      if (!steps.length) throw new Error("至少选择一个分析步骤。");
      const inputKey = JSON.stringify({ steps, assumptions, runtime, reviewedRuleVersion: reviewedRuleVersion.current });
      if (createInputKey.current && createInputKey.current !== inputKey) createKey.current = uid("replay");
      createInputKey.current = inputKey;
      const expectedRunId = `replay-${(await hashCommitteeText(JSON.stringify([version.workspaceKey, createKey.current]))).slice(0, 32)}`;
      setRunId(expectedRunId);
      const output = z.object({ runId: id, result: z.object({ status: z.string(), checkpoint: ReplayCheckpointSchema }).passthrough().optional(), repeated: z.boolean().optional() }).passthrough()
        .parse(await call("/replay/create", { contextId, consent: true, idempotencyKey: createKey.current, runtime, steps, assumptions }, signal));
      if (output.runId !== expectedRunId) throw new Error("回放请求标识不匹配，请对账存储版本。");
      setRunStatus(output.result?.status ?? "partial"); await loadRun(output.runId, signal); setReplayConsent(false);
      setNotice(output.repeated ? "已找回本次分支；没有自动重跑。需要继续时请单独确认。" : `回放：${statusLabels[output.result?.status ?? "partial"] ?? "状态未知"}。`);
    });
  }
  async function continueReplay() {
    if (!run) return;
    await action("从当前分支继续", async signal => {
      const output = z.object({ runId: id, result: z.object({ status: z.string() }).passthrough() }).parse(await call("/replay/continue", { contextId, consent: true, runId: run.runId, checkpointId: run.headId, runtime }, signal));
      setRunStatus(output.result.status); await loadRun(run.runId, signal); setReplayConsent(false); setNotice(`续跑：${statusLabels[output.result.status] ?? "状态未知"}；此前完成的分析不重跑。`);
    });
  }
  async function forkReplay() {
    if (!run || !selectedCheckpoint) return;
    const original = run;
    await action("从所选检查点分叉", async signal => {
      const output = z.object({ runId: id, result: z.object({ status: z.string() }).passthrough().optional() }).passthrough().parse(await call("/replay/fork", { contextId, consent: true,
        parentCheckpointId: selectedCheckpoint.id, idempotencyKey: uid("fork"), runtime, assumptions }, signal));
      const parent = EnvelopeSchema.parse(await call("/replay/get", { contextId, runId: original.runId }, signal));
      if (!original.checkpoints.every(checkpoint => parent.checkpoints.some(saved => saved.id === checkpoint.id && saved.hash === checkpoint.hash))) throw new Error("原分支历史核对不通过，未声称分叉成功。");
      setParentRunId(original.runId); setParentIntact(true); setRunStatus(output.result?.status ?? "partial"); await loadRun(output.runId, signal); setReplayConsent(false);
      setNotice("已核对原分支检查点未被覆盖；新分支使用新的本次授权。继承产物仍标记原输入版本。");
    });
  }
  function addEvent() {
    try {
      if (!applicationId.trim()) throw new Error("请填写投递记录标识，以区分不同岗位/申请。");
      const happenedAt = new Date(`${eventDate}Z`).toISOString();
      setEvents(current => [...current, { id: uid("event"), applicationId: applicationId.trim(), kind: eventKind, happenedAt, origin, receiptId: origin === "platform_receipt" ? receiptId.trim() || null : null }]);
      feedbackChanged(); setNotice("已加入本地草稿；尚未保存或核验平台结果。"); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "请核对时间。"); }
  }
  async function importText(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    await action("读取所选复盘文件", async signal => {
      if (!/\.(txt|md|srt|vtt)$/i.test(file.name) || file.size > 256000) throw new Error("请选择小于256KB的txt/md/srt/vtt转写文本；这里不提供音频转写服务。");
      const text = await file.text(); parseFeedbackTranscript(text); requireActive(signal); setNote(text); setImportName(file.name); feedbackChanged(); setNoteReviewed(false);
    });
    event.target.value = "";
  }
  async function importAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    await action("计算所选原录音SHA", async signal => {
      if (!file.type.startsWith("audio/") || file.size > 32000000) throw new Error("仅对小于32MB的所选录音计算本地SHA；不会上传或自动转写。");
      const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest("SHA-256", bytes); requireActive(signal);
      setAudioSha([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")); feedbackChanged(); setNotice("已计算原录音SHA；录音内容未上传，转写准确性仍需人工核对。");
    }); event.target.value = "";
  }
  async function saveFeedback() {
    await action("保存并分析已选反馈", async signal => {
      const version = identity ?? await loadIdentity(signal);
      if (!pendingFeedback.current) {
        const at = new Date().toISOString(), sourceId = uid("feedback-source"), noteSourceId = uid("note-source"), audioSourceId = uid("audio-source");
        const mappedClaim = version.claims.find(claim => claim.id === claimId);
        if (!events.length && !note.trim()) throw new Error("请先添加一个投递观察或复盘笔记。");
        if (note.trim() && (!linkConfirmed || !mappedClaim)) throw new Error("请明确核对这段反馈对应的简历条目；未确认的映射不会作为修改理由。");
        const parsed = note.trim() ? parseFeedbackTranscript(note) : undefined;
        const offset = Math.round(Number(correction) * 1000); if (!Number.isFinite(offset) || Math.abs(offset) > 3600000) throw new Error("时间修正须在正负3600秒内。");
        const payload = {
          asOf: at, sources: [{ id: sourceId, hash: await hashCommitteeText(JSON.stringify(events)), capturedAt: at },
            ...(parsed ? [{ id: noteSourceId, hash: await hashCommitteeText(note), capturedAt: at }] : []), ...(audioSha ? [{ id: audioSourceId, hash: audioSha, capturedAt: at }] : [])],
          events: events.map(event => ({ id: event.id, applicationId: event.applicationId, resumeVersionId: version.versionId, resumeContentHash: version.contentHash, sourceId,
            kind: event.kind, happenedAt: event.happenedAt, origin: event.origin, receiptVerification: "unverified", platformReceiptId: event.receiptId })),
          notes: parsed && mappedClaim ? [{ id: uid("note"), sourceId: noteSourceId, kind: audioSha ? "audio_transcript" : "note", resumeVersionId: version.versionId, resumeContentHash: version.contentHash,
            applicationId: applicationId.trim() || null, happenedAt: at, text: note, verification: noteReviewed ? "user_reviewed" : "unverified_transcript", originalAudioSourceId: audioSha ? audioSourceId : null,
            originalAudioSha256: audioSha || null, originalAudioDurationMs: null, timestampCorrectionMs: offset, segments: parsed.segments,
            claimLinks: parsed.segments.map(segment => ({ segmentId: segment.id, claimId: mappedClaim.id, claimHash: mappedClaim.hash, confirmedByUser: true, kind: "questioned", topic })) }] : [],
        };
        const checked = OutcomeFeedbackSnapshotInputSchema.pick({ asOf: true, sources: true, events: true, notes: true }).parse(payload);
        pendingFeedback.current = { idempotencyKey: uid("feedback"), payload: checked };
      }
      const saved = z.object({ id, snapshot: OutcomeFeedbackSnapshotSchema }).passthrough().parse(await call("/feedback/save", { contextId, consent: true, ...pendingFeedback.current }, signal));
      if (saved.snapshot.resumes[0]?.versionId !== version.versionId || saved.snapshot.resumes[0]?.contentHash !== version.contentHash) throw new Error("保存的反馈版本与当前选定内容不一致。");
      setFeedbackId(saved.id);
      const analyzed = z.object({ report: OutcomeFeedbackReportSchema }).passthrough().parse(await call("/feedback/analyze", { contextId, feedbackId: saved.id, consent: true }, signal));
      if (analyzed.report.snapshotFingerprint !== saved.snapshot.fingerprint || analyzed.report.status !== "completed") throw new Error("反馈授权/输入已过期，未采用分析结果。");
      if (analyzed.report.evolutionPatches.some(patch => !version.claims.some(claim => claim.id === patch.claimId && claim.hash === patch.claimHash))) throw new Error("反馈条目哈希不匹配，未提供采用操作。");
      setReport(analyzed.report); setPatchIds([]); setFeedbackConsent(false); setNotice("已保存并核对内容版本。统计是观察结果，不能证明某版简历造成了邀约或拒绝。");
    });
  }
  async function proposeRules() {
    if (!identity || !feedbackId || !report) return;
    await action("预览个人规则补丁", async signal => {
      const sidecarId = `career-${target}-${(await hashCommitteeText(identity.workspaceKey)).slice(0, 16)}`;
      const result = z.object({ proposal: RuleEvolutionProposalSchema, sidecar: PersonalRuleSidecarSchema, preview: z.string() }).passthrough().parse(await call("/rules/propose", { contextId, consent: true,
        feedbackId, ruleSidecarId: sidecarId, target, initialContent: initialRules, patchIds }, signal));
      const checked = await validatePersonalRuleSidecar(result.sidecar);
      const expectedPreview = [checked.current.content, ...result.proposal.ruleCodes.map(code => PERSONAL_RULE_TEXT[code])].filter(Boolean).join("\n");
      if (result.proposal.snapshotFingerprint !== report.snapshotFingerprint || result.proposal.baseHash !== checked.current.hash || result.preview !== expectedPreview) throw new Error("规则提案版本/预览不一致，未允许采用。");
      requireActive(signal); setProposal(result.proposal); setRule(checked); setPreview(result.preview); setApplyConfirmed(false); setExportConfirmed(false); applyDecision.current = uid("apply");
    });
  }
  async function applyRules() {
    if (!proposal || !rule) return;
    await action("确认应用运行时规则", async signal => {
      const result = z.object({ sidecar: PersonalRuleSidecarSchema, runtimeOnly: z.literal(true) }).passthrough().parse(await call("/rules/apply", { contextId, consent: true, confirmed: true,
        proposalId: proposal.id, decisionId: applyDecision.current, expectedRevision: proposal.baseRevision }, signal));
      const next = await validatePersonalRuleSidecar(result.sidecar);
      if (next.id !== rule.id || !next.history.some(entry => entry.decisionId === applyDecision.current && entry.operation === "apply")) throw new Error("采用回执与本次决策不一致。");
      requireActive(signal); setRule(next); setApplyConfirmed(false); setPreview(next.current.content); revertDecision.current = uid("revert");
      const activeRules = z.object({ runtimeOnly: z.literal(true), rules: z.array(z.object({ id, sidecar: PersonalRuleSidecarSchema })) }).parse(await call("/rules/runtime", { contextId }, signal));
      if (!activeRules.rules.some(item => item.id === next.id && item.sidecar.current.hash === next.current.hash)) throw new Error("规则已保存，但运行时读回未确认；请对账，不要重复写入。");
      reviewedRuleVersion.current = `${next.id}:${next.current.revision}:${next.current.hash}`; setReplayConsent(false);
      setNotice(`已确认个人运行时侧写v${next.current.revision}；未修改全局Skill、真实简历或.agent-memory。下次分析须重新确认，并创建绑定新规则版本的独立请求；不会自动重跑旧分支。`);
    });
  }
  async function revertRules() {
    const lastApply = [...(rule?.history ?? [])].reverse().find(entry => entry.operation === "apply"); if (!rule || !lastApply) return;
    await action("确认回退个人规则", async signal => {
      const result = z.object({ sidecar: PersonalRuleSidecarSchema, runtimeOnly: z.literal(true) }).passthrough().parse(await call("/rules/revert", { contextId, consent: true, confirmed: true,
        ruleSidecarId: rule.id, targetDecisionId: lastApply.decisionId, decisionId: revertDecision.current, expectedRevision: rule.current.revision }, signal));
      const next = await validatePersonalRuleSidecar(result.sidecar);
      if (next.id !== rule.id || !next.history.some(entry => entry.operation === "revert" && entry.decisionId === revertDecision.current && entry.targetDecisionId === lastApply.decisionId)) throw new Error("回退回执与本次规则决策不一致。");
      requireActive(signal); setRule(next); setPreview(next.current.content); setApplyConfirmed(false); setExportConfirmed(false);
      reviewedRuleVersion.current = `${next.id}:${next.current.revision}:${next.current.hash}`; setReplayConsent(false);
      setNotice(`已追加回退版本v${next.current.revision}，原规则及采用历史仍保留。`);
    });
  }
  async function exportRules() {
    if (!rule) return;
    if (preview !== rule.current.content) { setError("当前预览是尚未采用的提案，不是已保存的规则版本。请先明确采用并读回，再导出该版本。"); return; }
    await action("核对并导出规则文件", async signal => {
      const result = z.object({ filename: z.enum(["betterme-career-SKILL.patch.md", "betterme-resume-guidelines.patch.md"]), content: z.string().max(64000), sha256: hash,
        revision: z.number().int(), installed: z.literal(false) }).passthrough().parse(await call("/rules/export", { contextId, consent: true, confirmed: true, ruleSidecarId: rule.id, expectedRevision: rule.current.revision }, signal));
      if (result.sha256 !== rule.current.hash || result.revision !== rule.current.revision || await hashCommitteeText(result.content) !== result.sha256) throw new Error("导出内容哈希与已预览版本不一致。");
      requireActive(signal); const url = URL.createObjectURL(new Blob([result.content], { type: "text/markdown;charset=utf-8" })), anchor = document.createElement("a");
      anchor.href = url; anchor.download = result.filename; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setExportConfirmed(false); setNotice("已交给浏览器下载；没有安装或覆盖任何全局Skill。");
    });
  }

  return <section className="crfp" aria-label="回放与求职反馈工作台" aria-busy={!!busy}>
    <header className="crfp-heading"><div><span className="crfp-eyebrow">CAREER MEMORY · 可复算，不自动写回</span><h2>把执行与反馈，变成可审阅的历史</h2></div><span className="crfp-chip">私有 · 本次授权</span></header>
    <p className="crfp-muted">工作区仍是事实权威。这里保存分析检查点和个人规则侧写，不自动投递、不改简历、不训练强化学习策略。</p>
    <div className="crfp-toolbar"><button type="button" disabled={!!busy} onClick={() => void action("核对当前内容版本", async signal => { await loadIdentity(signal); setNotice("已核对本次选定的内容快照；不是业务版本或真实性回执。"); })}>载入当前版本</button>
      {identity && <span>内容版本 <code title={identity.contentHash}>{shortHash(identity.contentHash)}</code> · {identity.versionBinding === "content_addressed_context" ? "内容快照引用" : "工作区版本引用"}</span>}
      {busy && <><span role="status">{busy}…</span><button type="button" onClick={() => { controller.current?.abort(); controller.current = undefined; setBusy(""); setNotice("已停止等待；服务端是否完成可能未知。请加载分支或用同一请求对账，不要新建重复任务。"); }}>停止等待</button></>}
    </div>
    {error && <p className="crfp-error" role="alert">{error}</p>}{notice && <p className="crfp-notice" role="status">{notice}</p>}
    <div className="crfp-grid">
      <section className="crfp-card" aria-label="执行回放"><h3>01 / 执行时间线</h3>
        <fieldset disabled={!!busy}><legend>选择有界分析步骤</legend><label className="crfp-check"><input type="checkbox" checked={resumeStep} onChange={event => { setResumeStep(event.target.checked); setReplayConsent(false); }} />简历核对：事实与贡献边界</label><label className="crfp-check"><input type="checkbox" checked={jobStep} onChange={event => { setJobStep(event.target.checked); setReplayConsent(false); }} />岗位差异分析：只核对证据缺口</label>
          <label>本次假设 / 分叉后的修正<textarea value={assumptions} maxLength={8000} onChange={event => { setAssumptions(event.target.value); setReplayConsent(false); }} placeholder="例如：这项贡献仅设计，尚未上线。" rows={3} /></label>
          <label className="crfp-check"><input type="checkbox" checked={replayConsent} onChange={event => setReplayConsent(event.target.checked)} />仅授权本次本地分析或续跑；不允许业务外部写入</label>
          <div className="crfp-actions"><button type="button" className="crfp-primary" disabled={!replayConsent || (!resumeStep && !jobStep)} onClick={() => void startReplay()}>执行选定分析</button><button type="button" disabled={!run || !replayConsent} onClick={() => void continueReplay()}>从当前分支续跑</button></div>
          <label>已存分支ID<input value={runId} onChange={event => setRunId(event.target.value)} placeholder="可粘贴已保存的replay-/fork-标识" /></label><button type="button" disabled={!runId.trim()} onClick={() => void action("读取持久检查点", async signal => { await loadRun(runId.trim(), signal); setNotice("已从存储读回检查点；未执行任何步骤。"); })}>加载分支对账</button>
        </fieldset>
        {run && <><div className="crfp-subhead"><strong>{statusLabels[runStatus] ?? "已加载分支"}</strong><code title={run.runId}>{run.runId.slice(0, 24)}…</code></div>
          <ol className="crfp-timeline" aria-label="持久检查点时间线">{run.checkpoints.map(checkpoint => {
            const observation = checkpoint.observations.at(-1);
            return <li key={checkpoint.id}><label className="crfp-check"><input type="radio" name="replay-checkpoint" value={checkpoint.id} checked={selectedCheckpoint?.id === checkpoint.id} onChange={() => setCheckpointId(checkpoint.id)} /><span><strong>检查点 {checkpoint.sequence}</strong> · {observation ? `${observation.stepId} / ${observation.phase}` : "分支起点"}<small>{checkpoint.analysisOutputs.length}项分析 · {checkpoint.effectHistory.length}条只读动作历史</small></span></label></li>;
          })}</ol>
          <button type="button" disabled={!!busy || !replayConsent || !selectedCheckpoint} onClick={() => void forkReplay()}>从所选检查点分叉</button>
          {parentIntact && <p className="crfp-notice">已复核父分支原检查点未变。<button type="button" disabled={!!busy} onClick={() => void action("读取原分支", async signal => { await loadRun(parentRunId, signal); setRunStatus(""); })}>查看原分支</button></p>}
          <div className="crfp-output">{selectedCheckpoint?.analysisOutputs.map(output => <article key={output.stepId}><strong>{output.stepId}{output.inherited ? " · 继承的分析产物" : ""}</strong><p>{output.summary}</p><small>原输入 {shortHash(output.inputFingerprint)}{output.inputFingerprint !== selectedCheckpoint.inputFingerprint ? " · 非当前假设的重新认证" : ""}</small></article>)}</div>
          <p className="crfp-muted">只展示公开动作、观察和产物，不展示模型私有思维。旧成功/未知外部动作绝不会自动重放。</p>
        </>}
      </section>
      <section className="crfp-card" aria-label="投递与面试反馈"><h3>02 / 真实战场的观察</h3>
        <fieldset disabled={!!busy}><legend>投递事件（不等于平台核验）</legend><label>投递记录标识<input value={applicationId} maxLength={240} onChange={event => { setApplicationId(event.target.value); feedbackChanged(); }} placeholder="例如：目标岗位卡编号 / 公司与日期" /></label>
          <div className="crfp-fields"><label>观察到的结果<select value={eventKind} onChange={event => setEventKind(event.target.value as keyof typeof eventKinds)}>{Object.entries(eventKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>观察时间（UTC）<input type="datetime-local" value={eventDate} onChange={event => setEventDate(event.target.value)} /></label></div>
          <label>记录来源<select value={origin} onChange={event => setOrigin(event.target.value as typeof origin)}><option value="self_report">本人记录</option><option value="platform_receipt">平台记录/截图的本人导入（未核验）</option></select></label>
          {origin === "platform_receipt" && <label>所选回执编号（可留空，仍未核验）<input value={receiptId} onChange={event => setReceiptId(event.target.value)} maxLength={240} /></label>}
          <button type="button" onClick={addEvent}>加入事件草稿</button>
          <ul className="crfp-events">{events.map(event => <li key={event.id}><span>{event.applicationId} · {eventKinds[event.kind]}<small>{event.origin === "self_report" ? "本人自述" : "平台导入，未经独立核验"}</small></span><button type="button" aria-label={`移除${event.applicationId}事件`} onClick={() => { setEvents(current => current.filter(item => item.id !== event.id)); feedbackChanged(); }}>移除</button></li>)}</ul>
          <label>复盘笔记 / 已转写文本<textarea rows={5} value={note} maxLength={64000} onChange={event => { setNote(event.target.value); setNoteReviewed(false); feedbackChanged(); }} placeholder={'可直接粘贴笔记，或分段：\n[18:00-18:30] 面试官请我解释并发恢复的责任边界。'} /></label>
          <label className="crfp-file">导入已转写文本<input type="file" accept=".txt,.md,.srt,.vtt,text/plain" onChange={event => void importText(event)} /></label>{importName && <small>{importName} · 尚不代表转写准确</small>}
          <label className="crfp-file">可选：选择原录音，仅计算SHA<input type="file" accept="audio/*" onChange={event => void importAudio(event)} /></label>{audioSha && <small>原录音SHA：{shortHash(audioSha)} · 未上传或自动转写</small>}
          <div className="crfp-fields"><label>时间修正（秒，可为负）<input inputMode="decimal" value={correction} onChange={event => { setCorrection(event.target.value); feedbackChanged(); }} /></label><label>反馈焦点<select value={topic} onChange={event => { setTopic(event.target.value as typeof topic); feedbackChanged(); }}><option value="contribution">个人贡献边界</option><option value="metrics">量化与条件</option><option value="architecture">架构与失败边界</option><option value="clarity">叙事清晰度</option></select></label></div>
          <label>映射到选定简历条目<select value={claimId} onChange={event => { setClaimId(event.target.value); setLinkConfirmed(false); feedbackChanged(); }}><option value="">请先载入当前版本</option>{identity?.claims.map(claim => <option key={claim.id} value={claim.id}>{claim.text?.slice(0, 52) || claim.id}</option>)}</select></label>
          <label className="crfp-check"><input type="checkbox" checked={linkConfirmed} onChange={event => { setLinkConfirmed(event.target.checked); feedbackChanged(); }} />我确认笔记/各时间段确实对应这一条目；追问不是造假的证明</label>
          <label className="crfp-check"><input type="checkbox" checked={noteReviewed} onChange={event => { setNoteReviewed(event.target.checked); feedbackChanged(); }} />我已人工核对转写文本（不代表独立音频认证）</label>
          <label className="crfp-check"><input type="checkbox" checked={feedbackConsent} onChange={event => setFeedbackConsent(event.target.checked)} />授权保存本次所选事件与笔记，生成待审建议；不改正式事实</label>
          <button type="button" className="crfp-primary" disabled={!feedbackConsent || (!events.length && !note.trim())} onClick={() => void saveFeedback()}>保存并分析反馈</button>
        </fieldset>
        {report && <div className="crfp-feedback-report"><h4>观察统计，不是因果结论</h4>{report.versions.map(version => <p key={version.versionId}>已记录提交 {version.observedSubmissions} · 邀约 {version.observedInvitationApplications} · 结果未知 {version.unknownOutcomeApplications}<small>本人记录 {version.origins.selfReportedEvents} · 平台导入未核验 {version.origins.unverifiedPlatformEvents} · 可信适配器核验 {version.origins.hostVerifiedPlatformEvents}</small><small>未回复维持未知；不同岗位/时点的版本不能直接作优劣因果比较。</small></p>)}
          <h4>选择本次要审查的建议</h4>{report.evolutionPatches.length === 0 && <p className="crfp-muted">暂无已确认条目映射的修改建议；不会凭空生成。</p>}
          {report.evolutionPatches.map((patch: EvolutionPatch) => <label className="crfp-patch" key={patch.id}><input type="checkbox" checked={patchIds.includes(patch.id)} onChange={event => { setPatchIds(current => event.target.checked ? [...current, patch.id] : current.filter(value => value !== patch.id)); setProposal(undefined); setApplyConfirmed(false); }} /><span>{patch.question}<small>{patch.source.originalStartMs === 0 && patch.source.originalEndMs === 0 ? "未标注时间" : `${formatTime(patch.source.originalStartMs)}–${formatTime(patch.source.originalEndMs)}`} · {patch.source.transcriptionVerification === "user_reviewed" ? "本人核对文本" : "转写未核验"} · 引用 {shortHash(patch.source.segmentHash)}</small></span></label>)}
        </div>}
      </section>
    </div>
    <section className="crfp-card crfp-rules" aria-label="个人规则审核"><div><h3>03 / 审查个人规则，不自动演化事实</h3><p className="crfp-muted">补丁只追加边界与证据核对规则，不新增经历、指标或成果。采用、回退与导出分别确认。</p></div>
      <fieldset disabled={!!busy}><legend>形成待审核补丁</legend><label>规则目标<select value={target} onChange={event => { setTarget(event.target.value as typeof target); setProposal(undefined); setRule(undefined); setPreview(""); }}><option value="guideline">私有简历Guidelines侧写</option><option value="skill">私有Career Skill侧写（不安装全局Skill）</option></select></label><label>已有规则的副本（可选，不读取或覆盖原文件）<textarea rows={2} value={initialRules} onChange={event => { setInitialRules(event.target.value); setProposal(undefined); }} maxLength={64000} /></label>
        <button type="button" disabled={!report || selectedPatchCount === 0} onClick={() => void proposeRules()}>预览{selectedPatchCount || "所选"}条规则建议</button></fieldset>
      {rule && <><div className="crfp-subhead"><strong>{rule.target === "skill" ? "Career Skill" : "Resume Guidelines"} · 私有侧写v{rule.current.revision}</strong><code>{shortHash(rule.current.hash)}</code></div><textarea className="crfp-preview" aria-label="个人规则补丁预览" readOnly value={preview || rule.current.content} rows={5} />
        <label className="crfp-check"><input type="checkbox" checked={applyConfirmed} onChange={event => setApplyConfirmed(event.target.checked)} disabled={!!busy} />我已核对预览与当前版本，确认本次采用或回退仅修改私有运行时规则</label>
        <div className="crfp-actions"><button type="button" className="crfp-primary" disabled={!!busy || !proposal || !applyConfirmed || rule.current.revision !== proposal.baseRevision} onClick={() => void applyRules()}>确认采用规则补丁</button><button type="button" disabled={!!busy || !applyConfirmed || rule.history.at(-1)?.operation !== "apply"} onClick={() => void revertRules()}>确认回退最近采用</button></div>
        {preview !== rule.current.content && <p className="crfp-muted">这是待审核提案；明确采用并读回后，才能导出该已保存版本。</p>}
        <label className="crfp-check"><input type="checkbox" checked={exportConfirmed} onChange={event => setExportConfirmed(event.target.checked)} disabled={!!busy || preview !== rule.current.content} />我已检查将导出的当前规则文本；仅下载文件，不安装全局Skill</label><button type="button" disabled={!!busy || !exportConfirmed || preview !== rule.current.content} onClick={() => void exportRules()}>确认导出规则文件</button>
      </>}
    </section>
  </section>;
}
