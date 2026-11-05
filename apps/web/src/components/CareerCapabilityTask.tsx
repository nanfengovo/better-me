import { useEffect, useMemo, useRef, useState } from "react";
import { JobComparisonInput, EvidenceReviewInput, syntheticJobComparison, syntheticEvidenceReview, type CapabilitySnapshot } from "@better-me/agent-contracts";
import { createCapabilityClient } from "../services/capability-client";
import { EvidenceItemHandoff } from "./EvidenceItemHandoff";
import { ResumeProposalAdoption } from "./ResumeProposalAdoption";
import "./career-capability-task.css";

const labels: Record<string, string> = { assessing: "核对输入与已有能力", acquiring: "本地模型生成工具", qualifying: "独立资格验证",
  executing: "执行固定版本", verifying: "核对结果与保存", completed: "私人报告已保存", partial: "产物保留 · 尚未完成保存",
  cancelled: "已撤权停止", interrupted: "执行中断 · 先核对回执", failed: "本轮失败 · 未保存报告" };
export function CareerCapabilityTask({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>();
  const [round, setRound] = useState(1), [draft, setDraft] = useState(JSON.stringify(syntheticJobComparison(), null, 2));
  const [intent, setIntent] = useState<"comparison" | "evidence">("comparison");
  const [evidenceDraft, setEvidenceDraft] = useState(JSON.stringify(syntheticEvidenceReview().evidence, null, 2));
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const client = useMemo(() => createCapabilityClient(), []);
  const operation = useRef<{ input: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      try { const data = await client.load(); client.assert(); if (active) { setSnapshot(data); setError(""); } }
      catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "无法核对已保存回执"); }
    };
    void load(); const timer = setInterval(() => void load(), 1800);
    return () => { active = false; clearInterval(timer); };
  }, [open, client]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); client.assert(); const data = await client.load(); client.assert(); setSnapshot(data); return true; }
    catch (failure) { try { client.assert(); setError(failure instanceof Error ? failure.message : "本轮操作未完成"); } catch { /* old account cannot update this view */ } return false; }
    finally { try { client.assert(); setBusy(false); } catch { /* old identity is locked */ } }
  };
  const start = () => perform(async () => {
    if (!consent || !snapshot) return;
    const input = JobComparisonInput.parse(JSON.parse(draft));
    const evidence = intent === "evidence" ? EvidenceReviewInput.parse(JSON.parse(evidenceDraft)) : undefined;
    const serialized = JSON.stringify({ input, intent, evidence });
    if (operation.current?.input !== serialized) operation.current = { input: serialized, key: crypto.randomUUID() };
    // Preserve the logical key across uncertain submissions; a retry queries or
    // receives the same accepted task, never a second business effect.
    if (evidence) await client.startEvidenceReview(input, evidence, snapshot.catalogRevision, operation.current.key);
    else await client.start(input, snapshot.catalogRevision, operation.current.key);
    setConsent(false);
  });
  return <section className="career-capability-task" aria-label="岗位要求变化任务">
    <button type="button" aria-expanded={open} className="capability-disclosure" onClick={() => setOpen(value => !value)}>职业任务 · 工具生成与复用 {open ? "−" : "+"}</button>
    {open && <>
      <div className="capability-actions" aria-label="业务任务">{([['comparison', '岗位要求变化'], ['evidence', '项目证据核对']] as const).map(([value, label]) => <button type="button" key={value} disabled={busy} aria-pressed={intent === value} onClick={() => {
        setIntent(value); setRound(1); setConsent(false); setDraft(JSON.stringify(value === "evidence" ? syntheticEvidenceReview().input : syntheticJobComparison(), null, 2));
        setEvidenceDraft(JSON.stringify(syntheticEvidenceReview().evidence, null, 2));
      }}>{label}</button>)}</div>
      <p>{intent === "evidence" ? "复用岗位转换工具，按你本次提供的关联生成证据待核对清单。项目背景不等于个人贡献，不自动写入简历。" : "比较两批结构化岗位导出，保留来源并保存私人报告。"}不读取简历、已有 Agent 对话或共享岗位库。</p>
      <div className="capability-actions">{[1, 2].map(value => <button type="button" key={value} disabled={busy} aria-pressed={round === value} onClick={() => {
        setRound(value); setDraft(JSON.stringify(intent === "evidence" ? syntheticEvidenceReview(value).input : syntheticJobComparison(value), null, 2));
        setEvidenceDraft(JSON.stringify(syntheticEvidenceReview(value).evidence, null, 2)); setConsent(false);
      }}>{value === 1 ? "首次合成输入" : "第二批新输入"}</button>)}</div>
      <details><summary>查看或修改本次两批岗位 JSON</summary><textarea aria-label="两批岗位 JSON" rows={9} value={draft} onChange={event => { setDraft(event.target.value); setConsent(false); }} /></details>
      {intent === "evidence" && <details><summary>查看或修改本次项目线索与明确关联</summary><textarea aria-label="本次项目线索 JSON" rows={9} value={evidenceDraft} onChange={event => { setEvidenceDraft(event.target.value); setConsent(false); }} /></details>}
      <label className="capability-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        仅授权本次{intent === "evidence" ? "岗位和项目线索的转换、待核对清单" : "输入的转换、比较"}及私人报告保存；缺少工具时允许本机 Ollama 最多 3 次生成，不安装工具、不出网或改写职业资产。</label>
      <div className="capability-actions"><button type="button" className="studio-button" disabled={!consent || busy || !snapshot} onClick={() => void start()}>{busy ? "正在提交…" : intent === "evidence" ? "生成待核对清单并保存" : "开始比较并保存报告"}</button><span>gemma4:e2b-it-qat · 本地权重 · 每任务限时 9 分钟</span></div>
      {error && <p role="alert">{error}</p>}
      {snapshot?.storageError && <p role="alert">私人存储暂不可用；未签发新的保存回执，已有报告不变。恢复存储后可仅重试保存。</p>}
      {!snapshot && <p role="status">正在核对当前账号的任务与报告…</p>}
      {snapshot?.workspace && <ResumeProposalAdoption workspace={snapshot.workspace} client={client} busy={busy} perform={perform} />}
      {snapshot && [...snapshot.tasks].reverse().map(task => <article key={task.id} className="capability-result">
        <h3>{task.intent === "prepare-evidence-review" ? "证据核对 · " : "岗位变化 · "}{labels[task.stage] ?? task.stage}</h3><p role="status">{task.events.at(-1)?.detail ?? "任务已接受"}</p>
        <p>{task.builderCalls ? `本轮构建 ${task.builderCalls} 次` : "本轮构建 0 次"}{task.selected && ` · 工具 v${task.selected.version} · ${task.selected.codeHash.slice(0, 12)}`}</p>
        {!['completed', 'failed', 'cancelled', 'interrupted', 'partial'].includes(task.stage) && <button type="button" disabled={busy} onClick={() => void perform(() => client.revoke(task.id))}>撤销本任务授权并停止</button>}
        {task.error && <p>{task.error}</p>}
        {task.reviewReason && <p>{task.reviewReason}</p>}
        {(task.output || task.evidenceReport) && !task.receipt && ['partial', 'interrupted', 'cancelled', 'failed'].includes(task.stage) && <button type="button" disabled={busy} onClick={() => void perform(() => client.retrySave(task.id))}>重新授权，仅重试保存（不重新生成工具）</button>}
        {task.output && <><p>输入 {task.output.rowsBefore} / {task.output.rowsAfter} 行 · {task.output.unmatched.length} 行待核对</p>
          {task.output.changes.map(change => <div key={change.identity}><strong>{change.title}</strong><p>新增要求原文：{change.added.join("；") || "无"}</p><p>移除要求原文：{change.removed.join("；") || "无"}</p><small>来源 {change.identity} · before[{change.beforeRef}] → after[{change.afterRef}]</small></div>)}
          <p>{task.output.limitations.join(" ")}</p></>}
        {task.evidenceReport && <><p>核对 {task.evidenceReport.rowsReviewed} 条岗位 · {task.evidenceReport.items.length} 条要求；全部仍待核实</p>
          {task.evidenceReport.items.map((item, itemIndex) => <div key={`${item.requirement.rowIndex}:${item.requirement.requirementIndex}`}><strong>{item.title} · {item.requirement.text}</strong>
            <p>{item.status === "needs_evidence" ? "待补材料（不代表你不会）" : "已有本人提供的线索 · 真实性、相关性和个人贡献待核对"}</p>
            <p>{item.question}</p>{item.evidenceIds.map(id => { const note = task.evidence?.notes.find(note => note.id === id); return note && <details key={id}><summary>{note.project} · {note.source}</summary><blockquote>{note.excerpt}</blockquote></details>; })}
            <small>来源 {item.requirement.sourceNamespace} / {item.requirement.jobId} · after[{item.requirement.rowIndex}].requirements[{item.requirement.requirementIndex}]</small>
            {task.receipt && <EvidenceItemHandoff task={task} itemIndex={itemIndex} workspace={snapshot.workspace} busy={busy}
              review={command => perform(() => client.reviewEvidence(command))} propose={command => perform(() => client.proposeEvidence(command))}
              revoke={() => perform(() => client.revoke(task.id))} />}</div>)}
          {Boolean(task.evidenceReport.unresolvedLinks.length) && <p>{task.evidenceReport.unresolvedLinks.length} 条关联与本次快照不符，未用于认领；请在完整记录中核对。</p>}
          <p>{task.evidenceReport.limitations.join(" ")}</p></>}
        {task.receipt && <p className="capability-receipt">已保存回执 {task.receipt.id} · 报告版本 {task.receipt.revision}</p>}
        <details><summary>来源、独立验证与本次完整记录</summary><pre>{JSON.stringify(task, null, 2)}</pre></details>
      </article>)}
      {Boolean(snapshot?.versions.length) && <details><summary>已验证能力版本与停用</summary>{snapshot?.versions.map(version => <div key={version.version}><p>v{version.version} · {version.state} · {version.codeHash.slice(0, 16)}</p><button type="button" disabled={busy || version.state === "disabled"} onClick={() => void perform(() => client.disable(version.version, snapshot.catalogRevision))}>停用此版本（保留历史报告）</button>{version.state === "disabled" && <button type="button" disabled={busy} onClick={() => void perform(() => client.revalidate(version.version, snapshot.catalogRevision))}>重新验证并恢复此版本（不改历史）</button>}</div>)}</details>}
    </>}
  </section>;
}
