import { useEffect, useId, useState } from "react";
import { useUiPreferences } from "../lib/ui-preferences";
import type { AgentRoutingPolicy, UnderstandingCapability } from "@better-me/agent-contracts";
import { useAgentRouting } from "../lib/agent-routing";
import { defaultUnderstandingClient, type UnderstandingClient } from "../services/understanding-client";
import { nativeToolStatus } from "../lib/native-tool-status";
import "./agent-base-controls.css";

export function AgentBaseControls({ legacy, onLegacy, model, disabled, client = defaultUnderstandingClient }: {
  legacy: "current" | "chatgpt"; onLegacy: (kind: "current" | "chatgpt") => void; model: string; disabled?: boolean; client?: UnderstandingClient;
}) {
  const routing = useAgentRouting();
  const {t}=useUiPreferences(), helpId=useId();
  const [items, setItems] = useState<UnderstandingCapability[]>([]), [draft, setDraft] = useState<AgentRoutingPolicy>();
  const [consent, setConsent] = useState(false), [notice, setNotice] = useState("");
  const policy = routing?.policy;
  const revision = policy?.revision;
  useEffect(() => {
    if (revision === undefined) return;
    const controller = new AbortController();
    const refresh = () => { void client.getCapabilities(controller.signal).then(result => { if (!controller.signal.aborted) setItems(result); }).catch(() => { if (!controller.signal.aborted) setNotice(t("工具安装/授权状态尚未确认；未自动切换。", "Tool installation and authorization could not be verified; no automatic switch occurred.")); }); };
    refresh(); window.addEventListener("betterme:native-tools-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("betterme:native-tools-changed", refresh); };
  }, [client, revision, t]);
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
  return <section className="agent-base-controls" aria-label={t("统一 Agent 底座设置", "Unified Agent source settings")}>
    <label>{t("统一 Agent 来源", "Agent source")}<select aria-label={t("统一 Agent 来源", "Agent source")} aria-describedby={helpId} value={value} disabled={routing?.busy || (!policy && disabled)} onChange={event => choose(event.target.value)}>
      <option value="current">{t(`当前明确配置模型 · ${model || "未配置"}（不自动计费备援）`, `Configured API model · ${model || "not set"} (no automatic paid fallback)`)}</option><option value="chatgpt">{t("ChatGPT 账号授权 · 不回退 API", "ChatGPT account authorization · no API fallback")}</option>
      {policy && <option value="auto">{t("自动选择 · 仅本人批准的备选", "Automatic selection · approved backups only")}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}
      {policy && !items.some(item => item.id === policy.preferred) && policy.mode === "manual" && <option value={policy.preferred}>{policy.preferred} · {t("状态待核对", "Status unverified")}</option>}
    </select></label>
    <p id={helpId}>{t(`要使用已保存的 API 连接，选「当前明确配置模型 · ${model || "未配置"}」。切换来源可能中断正在运行的请求，不会给已绑定的工作区换模型。`,`To use your saved API connection, select the configured model (${model || "not set"}). Switching may interrupt active requests and cannot rebind an existing workspace.`)}</p>
    {policy && !draft && <button type="button" onClick={() => { setDraft({ ...policy }); setConsent(false); }}>{t("调整首选与备用顺序", "Configure preferred and backup order")}</button>}
    {draft && <form onSubmit={event => { event.preventDefault(); if (!consent || !routing) return; void routing.update(draft).then(() => { setDraft(undefined); setNotice(t("本账号底座配置已保存；没有发送资料或调用模型。", "Source configuration saved for this account; no materials were sent or models called.")); }).catch(() => undefined); }}>
      <label>{t("运行策略", "Routing mode")}<select value={draft.mode} onChange={event => { setDraft({ ...draft, mode: event.target.value as AgentRoutingPolicy["mode"] }); setConsent(false); }}><option value="manual">{t("手动固定底座", "Pinned manual source")}</option><option value="auto">{t("自动选择与启动前备援", "Automatic selection with pre-launch backup")}</option><option value="legacy">{t("明确配置模型 / ChatGPT", "Configured API model / ChatGPT")}</option></select></label>
      {draft.mode !== "legacy" && <><label>{t("首选底座", "Preferred source")}<select value={draft.preferred} onChange={event => { const preferred = event.target.value; setDraft({ ...draft, preferred, backups: draft.backups.filter(id => id !== preferred) }); setConsent(false); }}>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
        {draft.mode === "auto" && <><p>{t("同一授权链内先检查原生登录，再检查明确批准的 API 通道；安装、协议、账号和隔离失败分别显示。", "Checks native login before explicitly approved API backups; installation, protocol, account and sandbox failures are shown separately.")}</p><ol aria-label={t("底座备用顺序", "Backup source order")}>{draft.backups.map((id, index) => <li key={id}><span>{name(id)}</span><button type="button" aria-label={t(`上移 ${name(id)}`, `Move ${name(id)} up`)} disabled={index === 0} onClick={() => { const backups = [...draft.backups]; [backups[index - 1], backups[index]] = [backups[index]!, backups[index - 1]!]; setDraft({ ...draft, backups }); setConsent(false); }}>{t("上移", "Move up")}</button><button type="button" aria-label={t(`移除 ${name(id)}`, `Remove ${name(id)}`)} onClick={() => { setDraft({ ...draft, backups: draft.backups.filter(value => value !== id) }); setConsent(false); }}>{t("移除", "Remove")}</button></li>)}</ol>
          <label>{t("加入备用底座", "Add backup source")}<select value="" onChange={event => { if (event.target.value) { setDraft({ ...draft, backups: [...draft.backups, event.target.value] }); setConsent(false); } }}><option value="">{t("请选择", "Select")}</option>{items.filter(item => item.id !== draft.preferred && !draft.backups.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
          <label className="agent-base-consent"><input type="checkbox" checked={draft.allowApiBackups} onChange={event => { setDraft({ ...draft, allowApiBackups: event.target.checked }); setConsent(false); }} />{t("允许自动链使用上述工具已独立授权的 API Key 额度（可能付费；不包含当前配置模型或其他 API）", "Allow automatic fallback to use separately authorized API key quota for those tools (charges may apply; excludes your configured API model)")}</label></>}
        <p>{t("已发送后的超时、损坏输出、权限变化或结果不明会停止，不自动重放或升级权限。手动选择 API 工具表示本轮明确使用其已授权额度。", "Timeouts, corrupted output, permission changes or ambiguous results after dispatch halt without automatic replay or privilege escalation.")}</p></>}
      <label className="agent-base-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{t("确认仅对本 BetterMe 账号保存此选择；同意在每轮资料授权后向所选链内实际底座发送该轮内容。", "Save this choice only for this BetterMe account and send each turn only after per-turn material consent.")}</label>
      <div><button type="submit" disabled={!consent || routing?.busy}>{t("保存底座选择", "Save source settings")}</button><button type="button" disabled={routing?.busy} onClick={() => setDraft(undefined)}>{t("取消调整", "Cancel")}</button></div>
    </form>}
    {failure && <p role="alert">{failure}</p>}
    {notice && <p role="status">{notice}</p>}
    {routing && <button type="button" disabled={routing.busy} onClick={() => void routing.refresh()}>{t("刷新底座状态", "Refresh source status")}</button>}
    {routing?.trace && <details open className="agent-base-trace"><summary>{t("最近一轮底座", "Latest source")} · {routing.trace.runtimeId ? name(routing.trace.runtimeId) : t("尚未选中", "Not selected")} · {routing.trace.state === "completed" ? t("已完成", "Completed") : routing.trace.state === "running" ? t("运行中", "Running") : t("已停止", "Stopped")}</summary><ol>{routing.trace.attempts.map((attempt, index) => <li key={index}><strong>{name(attempt.runtimeId)}</strong><span>{attempt.reason}</span><small>{attempt.code}</small></li>)}</ol></details>}
  </section>;
}
