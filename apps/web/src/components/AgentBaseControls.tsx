import { useEffect, useState } from "react";
import type { AgentRoutingPolicy, UnderstandingCapability } from "@better-me/agent-contracts";
import { useAgentRouting } from "../lib/agent-routing";
import { defaultUnderstandingClient, type UnderstandingClient } from "../services/understanding-client";
import { nativeToolStatus } from "../lib/native-tool-status";
import "./agent-base-controls.css";

export function AgentBaseControls({ legacy, onLegacy, model, disabled, client = defaultUnderstandingClient }: {
  legacy: "current" | "chatgpt"; onLegacy: (kind: "current" | "chatgpt") => void; model: string; disabled?: boolean; client?: UnderstandingClient;
}) {
  const routing = useAgentRouting();
  const [items, setItems] = useState<UnderstandingCapability[]>([]), [draft, setDraft] = useState<AgentRoutingPolicy>();
  const [consent, setConsent] = useState(false), [notice, setNotice] = useState("");
  const policy = routing?.policy;
  const revision = policy?.revision;
  useEffect(() => {
    if (revision === undefined) return;
    const controller = new AbortController();
    const refresh = () => { void client.getCapabilities(controller.signal).then(result => { if (!controller.signal.aborted) setItems(result); }).catch(() => { if (!controller.signal.aborted) setNotice("工具安装/授权状态尚未确认；未自动切换。"); }); };
    refresh(); window.addEventListener("betterme:native-tools-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("betterme:native-tools-changed", refresh); };
  }, [client, revision]);
  useEffect(() => { setDraft(undefined); setConsent(false); }, [policy?.revision]);
  const value = draft ? draft.mode === "auto" ? "auto" : draft.preferred : policy && policy.mode !== "legacy" ? policy.mode === "auto" ? "auto" : policy.preferred : legacy;
  const choose = (value: string) => {
    setNotice(""); setConsent(false);
    if (value === "current" || value === "chatgpt") {
      if (policy && policy.mode !== "legacy") {
        void routing?.update({ ...policy, mode: "legacy" }).then(() => onLegacy(value)).catch(() => undefined);
      } else onLegacy(value);
      setDraft(undefined); return;
    }
    if (!policy) return;
    setDraft({ ...policy, mode: value === "auto" ? "auto" : "manual", preferred: value === "auto" ? policy.preferred : value,
      backups: value === "auto" ? policy.backups : policy.backups.filter(id => id !== value) });
  };
  const name = (id: string) => items.find(item => item.id === id)?.name ?? id;
  const failure = routing?.error;
  return <section className="agent-base-controls" aria-label="统一 Agent 底座设置">
    <label>统一 Agent 来源<select aria-label="统一 Agent 来源" value={value} disabled={routing?.busy || (!policy && disabled)} onChange={event => choose(event.target.value)}>
      <option value="current">当前明确配置模型 · {model || "未配置"}（不自动计费备援）</option><option value="chatgpt">ChatGPT 账号授权 · 不回退 API</option>
      {policy && <option value="auto">自动选择 · 仅本人批准的备选</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}
      {policy && !items.some(item => item.id === policy.preferred) && policy.mode === "manual" && <option value={policy.preferred}>{policy.preferred} · 状态待核对</option>}
    </select></label>
    {policy && <p>伴侣、伴写、成长和项目理解共用底座。切换会停止本账号在途底座请求，下一轮按新选择执行；不会重写旧对话或简历。原生登录优先，工具与资料仍需分别授权。</p>}
    {policy && !draft && <button type="button" onClick={() => { setDraft({ ...policy }); setConsent(false); }}>调整首选与备用顺序</button>}
    {draft && <form onSubmit={event => { event.preventDefault(); if (!consent || !routing) return; void routing.update(draft).then(() => { setDraft(undefined); setNotice("本账号底座配置已保存；没有发送资料或调用模型。"); }).catch(() => undefined); }}>
      <label>运行策略<select value={draft.mode} onChange={event => { setDraft({ ...draft, mode: event.target.value as AgentRoutingPolicy["mode"] }); setConsent(false); }}><option value="manual">手动固定底座</option><option value="auto">自动选择与启动前备援</option><option value="legacy">明确配置模型 / ChatGPT</option></select></label>
      {draft.mode !== "legacy" && <><label>首选底座<select value={draft.preferred} onChange={event => { const preferred = event.target.value; setDraft({ ...draft, preferred, backups: draft.backups.filter(id => id !== preferred) }); setConsent(false); }}>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
        {draft.mode === "auto" && <><p>同一授权链内先检查原生登录，再检查明确批准的 API 通道；安装、协议、账号和隔离失败分别显示。</p><ol aria-label="底座备用顺序">{draft.backups.map((id, index) => <li key={id}><span>{name(id)}</span><button type="button" aria-label={`上移 ${name(id)}`} disabled={index === 0} onClick={() => { const backups = [...draft.backups]; [backups[index - 1], backups[index]] = [backups[index]!, backups[index - 1]!]; setDraft({ ...draft, backups }); setConsent(false); }}>上移</button><button type="button" aria-label={`移除 ${name(id)}`} onClick={() => { setDraft({ ...draft, backups: draft.backups.filter(value => value !== id) }); setConsent(false); }}>移除</button></li>)}</ol>
          <label>加入备用底座<select value="" onChange={event => { if (event.target.value) { setDraft({ ...draft, backups: [...draft.backups, event.target.value] }); setConsent(false); } }}><option value="">请选择</option>{items.filter(item => item.id !== draft.preferred && !draft.backups.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
          <label className="agent-base-consent"><input type="checkbox" checked={draft.allowApiBackups} onChange={event => { setDraft({ ...draft, allowApiBackups: event.target.checked }); setConsent(false); }} />允许自动链使用上述工具已独立授权的 API Key 额度（可能付费；不包含当前配置模型或其他 API）</label></>}
        <p>已发送后的超时、损坏输出、权限变化或结果不明会停止，不自动重放或升级权限。手动选择 API 工具表示本轮明确使用其已授权额度。</p></>}
      <label className="agent-base-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />确认仅对本 BetterMe 账号保存此选择；同意在每轮资料授权后向所选链内实际底座发送该轮内容。</label>
      <div><button type="submit" disabled={!consent || routing?.busy}>保存底座选择</button><button type="button" disabled={routing?.busy} onClick={() => setDraft(undefined)}>取消调整</button></div>
    </form>}
    {failure && <p role="alert">{failure}</p>}
    {notice && <p role="status">{notice}</p>}
    {routing && <button type="button" disabled={routing.busy} onClick={() => void routing.refresh()}>刷新底座状态</button>}
    {routing?.trace && <details open className="agent-base-trace"><summary>最近一轮底座 · {routing.trace.runtimeId ? name(routing.trace.runtimeId) : "尚未选中"} · {routing.trace.state === "completed" ? "已完成" : routing.trace.state === "running" ? "运行中" : "已停止"}</summary><ol>{routing.trace.attempts.map((attempt, index) => <li key={index}><strong>{name(attempt.runtimeId)}</strong><span>{attempt.reason}</span><small>{attempt.code}</small></li>)}</ol></details>}
  </section>;
}
