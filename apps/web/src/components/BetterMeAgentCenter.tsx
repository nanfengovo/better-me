import { useEffect, useRef, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { ChatGptAgentControls } from "./ChatGptAgentControls";
import { defaultChatGptClient, type ChatGptClient } from "../services/chatgpt-client";
import type { AgentOrigin, AgentTask } from "../lib/betterme-agent/storage";
import "./betterme-agent-center.css";
import { AgentSurface, useAgentSidebar } from "./AgentSidebar";
import { agentStorageIssue } from "../lib/betterme-agent/storage-issue";
import { AgentBackupControls } from "./AgentBackupControls";
import { openProjectSource } from "../lib/agent-navigation";

const origins: Record<AgentOrigin, string> = { writing: "简历伴写", companion: "Agent 伴侣", growth: "职业成长", understanding: "项目理解" };
const statuses: Record<AgentTask["status"], string> = { running: "运行中", waiting: "等待你参与", completed: "已完成", failed: "本轮失败 · 可回到来源重试", cancelled: "已停止", interrupted: "页面重载 · 待手动恢复" };
export function AgentContinuityButton({ compact = false }: { compact?: boolean } = {}) {
  const { agent, snapshot } = useBetterMeAgent();
  const sidebar = useAgentSidebar();
  if (!agent || !snapshot) return null;
  const running = snapshot.data.tasks.filter(task => task.status === "running").length;
  const label = `BetterMe Agent${running ? ` · ${running} 项运行中` : " · 记忆与进度"}`;
  return <button type="button" className="betterme-agent-entry" aria-label={label} title={compact ? label : undefined} onClick={() => sidebar ? sidebar.show("memory") : agent.setCenterOpen(true)}>{compact ? running ? `${running} 项运行中` : "记忆与进度" : label}</button>;
}
export function AgentMemoryConsent({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const { snapshot } = useBetterMeAgent();
  if (!snapshot) return null;
  const count = snapshot.data.memories.filter(memory => memory.valid && memory.shared).length;
  const available = count || snapshot.data.goal || snapshot.data.tracking && snapshot.data.events.length;
  return <label className="betterme-agent-consent"><input type="checkbox" checked={checked} disabled={!available} onChange={event => onChange(event.target.checked)} />本轮使用已共享共识与成长上下文（{count} 个项目）<span>包含统一目标和已开启跟踪的近期事件；项目背景不作个人贡献依据，发送前重新核对授权。</span></label>;
}
export function AgentModelControls({ config, disabled, client = defaultChatGptClient }: { config: LlmConfig; disabled?: boolean; client?: ChatGptClient }) {
  const { agent, snapshot } = useBetterMeAgent();
  if (!agent || !snapshot) return null;
  return <div className="betterme-agent-model"><label>统一 Agent 来源<select aria-label="统一 Agent 来源" value={snapshot.data.selection.kind} disabled={disabled || !snapshot.ready || Boolean(snapshot.error)} onChange={event => agent.setSelection({ kind: event.target.value === "chatgpt" ? "chatgpt" : "current", profileId: "", model: "" })}>
    <option value="current">当前明确配置模型 · {config.model || "未配置"}</option><option value="chatgpt">ChatGPT 账号授权 · 不回退 API</option></select></label>
    {snapshot.data.selection.kind === "chatgpt" && <ChatGptAgentControls value={snapshot.data.selection} onChange={choice => agent.setSelection({ kind: "chatgpt", ...choice })} onReady={agent.setChatGptReady} client={client} disabled={disabled} />}
  </div>;
}
export function BetterMeAgentCenter({ onNavigate }: { onNavigate: (origin: AgentOrigin) => void }) {
  const { agent, snapshot } = useBetterMeAgent();
  const sidebar = useAgentSidebar();
  const shown = sidebar ? sidebar.open && sidebar.tab === "memory" : snapshot?.centerOpen;
  const [tab, setTab] = useState<"tasks" | "memory" | "history" | "growth">("tasks");
  const [query, setQuery] = useState(""), [limit, setLimit] = useState(30), [tick, setTick] = useState(Date.now());
  const [goalDraft, setGoalDraft] = useState("");
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const goalEdited = useRef(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sidebar || !snapshot?.centerOpen) return;
    const trigger = document.activeElement;
    close.current?.focus();
    return () => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, [snapshot?.centerOpen, sidebar]);
  useEffect(() => { if (!goalEdited.current) setGoalDraft(snapshot?.data.goal ?? ""); }, [snapshot?.data.goal]);
  useEffect(() => { if (!shown) return; setTick(Date.now()); const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, [shown]);
  if (!agent || !snapshot || !sidebar && !snapshot.centerOpen) return null;
  const perform = (action: () => void | Promise<void>) => { setError(""); try { void Promise.resolve(action()).catch(failure => setError(agentStorageIssue(failure).message)); } catch (failure) { setError(agentStorageIssue(failure).message); } };
  const issue = snapshot.storageIssue ?? (snapshot.error ? agentStorageIssue(new Error(snapshot.error)) : undefined);
  const recover = async () => { setError(""); setRecovering(true); try { await agent.recoverStorage(); } catch { /* The kernel publishes a classified storage issue. */ } finally { setRecovering(false); } };
  const navigate = (origin: AgentOrigin, targetKey?: string) => { agent.setCenterOpen(false); if (origin !== "growth") sidebar?.show("conversation", origin === "companion" ? "companion" : "writing"); onNavigate(origin); if (targetKey) openProjectSource(targetKey); };
  const messages = snapshot.data.messages.filter(message => !query || message.text.toLowerCase().includes(query.toLowerCase()));
  const exportRecords = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "betterme-agent-history.json"; link.click(); URL.revokeObjectURL(url);
  };
  return <AgentSurface name="memory"><aside className="betterme-agent-center no-print" role={sidebar ? undefined : "dialog"} aria-label="BetterMe Agent 记忆与进度" onKeyDown={event => { if (!sidebar && event.key === "Escape") agent.setCenterOpen(false); }}>
    <header><div><small>BETTERME / 同一位职业伙伴</small><h2>记忆、对话与进行中的事</h2></div><button ref={close} type="button" aria-label="收起统一 Agent 面板" onClick={() => agent.setCenterOpen(false)}>收起</button></header>
    <p className="betterme-agent-save" role="status">{!snapshot.ready ? "正在读取本地记录…" : snapshot.saving ? "正在保存 Agent 记录…" : snapshot.error ? "Agent 记录未同步 · 本页内容保留" : snapshot.data.ownerId ? "Agent 记录保存在当前账号的本机 Agent Host" : "Agent 记录保存在当前浏览器"}</p>
    {(issue || error) && <section className="agent-storage-alert" role="alert"><strong>{issue?.title ?? "本次操作未完成"}</strong><p>{issue?.message ?? error}</p><div className="agent-storage-actions">
      {issue?.retryable && <button type="button" disabled={recovering || snapshot.saving} onClick={() => void recover()}>{recovering ? "正在恢复…" : "重连并重试保存"}</button>}
      <button type="button" onClick={exportRecords}>下载本页记录</button>
      <details><summary>其他恢复方式</summary><p>重新读取会用已保存记录替换本页 Agent 状态，并停止本页请求。请先下载备份；不会重发模型请求。</p><button type="button" disabled={recovering || snapshot.saving} onClick={() => { if (window.confirm("已下载需要保留的本页记录？重新读取会停止本页请求，并载入已保存记录；不会自动重发。")) perform(() => agent.reload()); }}>重新读取已保存记录</button></details>
    </div></section>}
    <nav aria-label="统一 Agent 视图">{([['tasks', '任务'], ['memory', '共识记忆'], ['history', '对话历史'], ['growth', '持续成长']] as const).map(([id, label]) => <button type="button" key={id} data-agent-guide={id === "tasks" ? "agent-tasks" : undefined} aria-pressed={tab === id} onClick={() => { setTab(id); setLimit(30); }}>{label}</button>)}</nav>
    <div className="betterme-agent-center-body">
      <AgentBackupControls onExport={exportRecords} />
      {tab === "tasks" && <><p>收起、切换页面不停止任务。关闭/刷新应用后，本机请求需手动核对恢复；不会自动重发计费。</p>{!snapshot.data.tasks.length && <p>还没有发起任务。可以从简历伴写、伴侣或职业成长开始。</p>}{[...snapshot.data.tasks].reverse().map(task => <article key={task.id}><strong>{task.label}</strong><small>{origins[task.origin]} · {task.destination}</small><p role="status">{statuses[task.status]}{task.status === "running" && ` · 已等待 ${Math.max(0, Math.floor((tick - Date.parse(task.at)) / 1000))} 秒`}</p><p>{task.detail}</p>{task.status === "running" && tick - Date.parse(task.updatedAt) > 30000 && <p>暂未收到新进度，尚不能据此认定失败。可以回到来源查看或停止。</p>}<div><button type="button" onClick={() => navigate(task.origin, task.remote?.targetKey)}>回到来源</button>{task.status === "running" && !task.remote && <button type="button" onClick={() => perform(() => agent.stop(task.id))}>停止本轮</button>}</div></article>)}</>}
      {tab === "memory" && <><p>只收录你确认的项目共同理解。跨入口共享需另行开启，每次使用仍会核对源会话和授权；不自动记成个人功劳。</p>{!snapshot.data.memories.length && <p>请先在简历伴写里完成“先对齐项目理解”。</p>}{snapshot.data.memories.map(memory => <article key={memory.id}><strong>{memory.label} · 版本 {memory.revision}</strong><details className="agent-memory-summary"><summary>查看已确认的项目理解</summary><p>{memory.summary}</p></details><p>{memory.valid ? "共同理解已确认 · 不是个人贡献证明" : memory.reason || "需要重新确认"}</p><label><input type="checkbox" checked={memory.shared} disabled={!memory.valid || Boolean(snapshot.error)} onChange={event => perform(() => agent.shareMemory(memory.id, event.target.checked))} />允许伴写、伴侣和职业成长在我逐次授权后复用</label><button type="button" onClick={() => navigate("understanding", memory.targetKey)}>{memory.valid ? "继续认领贡献与旁批" : "回到原文重新核对"}</button></article>)}</>}
      {tab === "history" && <><label>搜索全部文本历史<input value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} /></label><p>共 {messages.length} 条；历史不会因发送窗口只取近期内容而删除。图片不存入这里；其他入口的历史不会自动发送给模型。</p>{messages.slice(-limit).map(message => <article key={message.id}><small>{origins[message.origin]} · {message.role === "user" ? "你" : message.role === "assistant" ? "Agent" : "事件"} · {new Date(message.at).toLocaleString()}</small><p className="betterme-agent-history-text">{message.text}</p></article>)}{messages.length > limit && <button type="button" onClick={() => setLimit(value => value + 30)}>显示更早 30 条</button>}</>}
      {tab === "growth" && <><label>统一成长目标<textarea rows={3} value={goalDraft} maxLength={4000} onChange={event => { goalEdited.current = true; setGoalDraft(event.target.value); }} /></label><button type="button" disabled={!snapshot.ready || Boolean(snapshot.error)} onClick={() => perform(() => agent.setGoal(goalDraft))}>确认目标（不替换已有计划）</button><label><input type="checkbox" checked={snapshot.data.tracking} disabled={!snapshot.ready || Boolean(snapshot.error)} onChange={event => perform(() => agent.setTracking(event.target.checked))} />跟踪此后在 BetterMe 中确认的成长事件</label><p>只跟踪项目共识、你采用的表达、学习方案和提交；不监视其他应用或业务目录，不自动请求模型、不认证能力。</p>{[...snapshot.data.events].reverse().map(event => <article key={event.id}><small>{new Date(event.at).toLocaleString()} · {origins[event.origin]}</small><p>{event.label}</p><p>{event.kind === "consensus" ? "下一步：补充本人动作与可核对结果，再用于经历表达。" : event.kind === "evidence" ? "下一步：按原验收条件复盘证据，决定是否调整计划；提交不等于掌握。" : event.kind === "plan-adopted" ? "下一步：按方案提交可读证据；仍由你自查成果。" : "这是一项真实操作记录，不是模型能力认证。"}</p></article>)}<button type="button" onClick={() => navigate("growth")}>结合已授权共识进行规划</button></>}
    </div><footer><button type="button" onClick={exportRecords}>下载 Agent 记录</button><span>模型、授权或额度失败时停止 · 不自动切换付费 API</span></footer>
  </aside></AgentSurface>;
}
