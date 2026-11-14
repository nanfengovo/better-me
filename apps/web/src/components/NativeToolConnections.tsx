import { useEffect, useRef, useState } from "react";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import type { NativeLoginState, UnderstandingClient } from "../services/understanding-client";
import { nativeToolStatus } from "../lib/native-tool-status";
import { useUiPreferences } from "../lib/ui-preferences";
import "./native-tool-connections.css";

export function NativeToolConnections({ items, client, onChange }: {
  items: UnderstandingCapability[]; client: UnderstandingClient; onChange: () => void;
}) {
  const { t } = useUiPreferences();
  const [form, setForm] = useState<string>(), [key, setKey] = useState(""), [model, setModel] = useState(""), [endpoint, setEndpoint] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [login, setLogin] = useState<NativeLoginState>();
  const [authCode, setAuthCode] = useState("");
  const lifetime = useRef(new AbortController());
  const working = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const pending = login?.state === "pending";
  useEffect(() => {
    if (!pending || !client.getNativeLogin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.getNativeLogin!(controller.signal, login?.runtimeId);
        if (controller.signal.aborted) return;
        setLogin(next);
        if (next.state !== "pending") { setAuthCode(""); setNotice(next.state === "complete" ? t("本账号的原生登录已保存；尚未发送资料或调用模型。", "Native sign-in saved for this account; no material was sent and no model was called.") : t("本次登录未完成，未复用电脑上的共享登录。可以重新发起。", "Sign-in did not finish and the shared sign-in on this computer was not reused. You can start again.")); onChange(); return; }
      } catch { if (!controller.signal.aborted) { setLogin(undefined); setNotice(t("登录状态暂时无法确认。未自动重试登录或改用 API Key，请刷新工具状态。", "Sign-in status cannot be confirmed right now. Nothing was retried and no API key was substituted; refresh the tool status.")); } return; }
      timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, onChange, pending, login?.runtimeId, t]);
  async function perform(task: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    const signal = lifetime.current.signal; working.current = true; setBusy(true); setNotice("");
    try { await task(signal); if (!signal.aborted) onChange(); }
    catch (error) { if (!signal.aborted) setNotice(error instanceof Error ? error.message : t("本账号工具授权未完成，未改变模型或已有资料。", "Tool authorization for this account did not finish; the model and existing material are unchanged.")); }
    finally { working.current = false; if (!signal.aborted) setBusy(false); }
  }
  function openForm(id?: string) { setKey(""); setModel(""); setEndpoint(""); setConsent(false); setForm(id); }
  return <div className="native-tool-connections" aria-label={t("本账号工具授权", "Tool authorization for this account")}>
    <p>{t("授权只属于当前 BetterMe 账号。不会读取、复制或退出电脑上已有的 CLI 登录；工具登录与本轮资料授权分开。", "Authorization belongs only to the current BetterMe account. Existing CLI sign-ins on this computer are never read, copied or signed out; tool sign-in is separate from per-run material authorization.")}</p>
    <ul>{items.map(item => {
      const connectable = item.available && item.authMethods?.length && !["sandbox_unavailable", "protocol_incompatible", "adapter_missing", "managed_policy_unavailable", "runtime_terminated"].includes(item.code ?? "");
      return <li key={item.id} data-state={item.code ?? "legacy"}>
        <div className="native-tool-heading"><strong>{item.name}</strong><span>{nativeToolStatus(item, t)}</span></div>
        {item.reason && <p>{item.reason}</p>}{item.model && <small>{t("独立模型：", "Dedicated model: ")}{item.model}</small>}
        {(connectable || item.authorized || item.supported) && <div className="native-tool-actions">
          {connectable && item.authMethods?.includes("browser") && client.startNativeLogin && <button type="button" disabled={busy || pending} onClick={() => void perform(async signal => {
            openForm(); setAuthCode(""); const next = await client.startNativeLogin!(signal, "claude-code"); if (!signal.aborted) setLogin(next);
          })}>{t("为本账号登录 Claude 订阅", "Sign in to Claude subscription for this account")}</button>}
          {connectable && item.authMethods?.includes("device") && client.startNativeLogin && <button type="button" disabled={busy || pending} onClick={() => void perform(async signal => {
            openForm(); const next = await client.startNativeLogin!(signal); if (!signal.aborted) setLogin(next);
          })}>{t("为本账号登录 Codex", "Sign in to Codex for this account")}</button>}
          {connectable && item.authMethods?.includes("api-key") && client.authorizeNative && <button type="button" disabled={busy} onClick={() => openForm(form === item.id ? undefined : item.id)}>{t("独立 API 授权", "Separate API authorization")}</button>}
          {(item.authorized || item.supported) && client.disconnectNative && <button type="button" disabled={busy} onClick={() => void perform(async signal => {
            await client.disconnectNative!(item.id, signal); if (!signal.aborted) setNotice(t(`已撤销本账号的 ${item.name} 授权，相关任务已停止；其他登录和记录不变。`, `Revoked ${item.name} authorization for this account and stopped related tasks; other sign-ins and records are unchanged.`));
          })}>{t("撤销本账号授权", "Revoke authorization for this account")}</button>}
        </div>}
        {form === item.id && <form className="native-tool-form" onSubmit={event => {
          event.preventDefault(); if (!consent || !client.authorizeNative) return;
          const input = { mode: "api-key" as const, apiKey: key, model, ...(endpoint ? { endpoint } : {}), consent: true as const };
          setKey("");
          void perform(async signal => { await client.authorizeNative!(item.id, input, signal); if (!signal.aborted) { openForm(); setNotice(t("仅本账号的工具凭据已保存；还没有调用模型，连接与计费权限仍待真实运行验证。", "Tool credentials saved for this account only; no model was called yet, and connectivity and billing access are still unverified.")); } });
        }}>
          <p>{t("这是工具的独立 API 通道，可能产生费用。不会使用或替换上方模型配置，也不会自动创建 Key。", "This is the tool's own API channel and may incur charges. It does not use or replace the model settings above, and no key is created automatically.")}</p>
          <label>API Key<input type="password" value={key} autoComplete="new-password" required minLength={8} disabled={busy} onChange={event => setKey(event.target.value)} /></label>
          <label>{t("模型", "Model")}<input value={model} required maxLength={120} disabled={busy} placeholder={t("填写本工具实际支持的模型", "Enter a model this tool actually supports")} onChange={event => setModel(event.target.value)} /></label>
          <label>{t("API 基础地址（可选）", "API base URL (optional)")}<input type="url" value={endpoint} disabled={busy} placeholder={item.id === "claude-code" ? "https://api.anthropic.com" : item.id === "gemini-cli" ? "https://generativelanguage.googleapis.com" : "https://api.openai.com/v1"} onChange={event => setEndpoint(event.target.value)} /></label>
          <label className="native-tool-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />{t("我确认此凭据属于当前账号，并同意仅在本机私有目录保存；实际调用可能消耗配额或产生费用。", "I confirm this credential belongs to the current account and agree to store it only in a private folder on this computer; actual calls may use quota or incur charges.")}</label>
          <div className="native-tool-actions"><button type="submit" disabled={busy || !consent || !key.trim() || !model.trim()}>{t("保存本账号授权", "Save authorization for this account")}</button><button type="button" disabled={busy} onClick={() => openForm()}>{t("取消", "Cancel")}</button></div>
        </form>}
      </li>;
    })}</ul>
    {login?.state === "pending" && <section className="native-tool-device" aria-label={login.runtimeId === "claude-code" ? t("Claude 本账号原生登录", "Native Claude sign-in for this account") : t("Codex 本账号设备登录", "Codex device sign-in for this account")}>
      <strong>{t(`请在官方页面核对并登录你的 ${login.runtimeId === "claude-code" ? "Claude 订阅" : "Codex"}账号`, `Verify and sign in to your ${login.runtimeId === "claude-code" ? "Claude subscription" : "Codex"} account on the official page`)}</strong>
      {login.verificationUrl && (login.userCode || login.acceptsCode) ? <><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{login.acceptsCode ? t("打开 Claude 官方订阅授权页", "Open the official Claude subscription page") : t("打开 OpenAI 官方设备授权页", "Open the official OpenAI device page")}</a>{login.userCode && <p>{t("本次设备码：", "Device code for this sign-in: ")}<code>{login.userCode}</code></p>}<small>{t("仅用于本次独立登录，不进入聊天或长期记录；不会新建 Console API Key。请核对官方页面上的账号，完成后这里会更新。", "Used only for this separate sign-in; it never enters chat or long-term records, and no Console API key is created. Check the account on the official page; this updates when you finish.")}</small>{login.acceptsCode && client.submitNativeCode && <form onSubmit={event => { event.preventDefault(); const code = authCode.trim(); setAuthCode(""); void perform(async signal => { await client.submitNativeCode!(code, signal); }); }}><label>{t("官方页面返回的一次性授权码", "One-time code returned by the official page")}<input type="password" autoComplete="off" value={authCode} onChange={event => setAuthCode(event.target.value)} placeholder={t("完整 code#state", "Full code#state")} /></label><button type="submit" disabled={busy || !authCode.trim()}>{t("提交本次授权码", "Submit this code")}</button></form>}</> : <p>{t("正在等待 CLI 提供官方授权地址；不会打开或接管现有浏览器页面。", "Waiting for the CLI to provide the official authorization URL; no existing browser page is opened or taken over.")}</p>}
      {client.cancelNativeLogin && <button type="button" disabled={busy} onClick={() => void perform(async signal => { await client.cancelNativeLogin!(signal, login.runtimeId); if (!signal.aborted) { setAuthCode(""); setLogin(undefined); setNotice(t("已取消本次设备登录；此前独立授权和电脑上的共享登录保持不变。", "Device sign-in cancelled; earlier separate authorizations and the shared sign-in on this computer are unchanged.")); } })}>{t("取消本次登录", "Cancel this sign-in")}</button>}
    </section>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
