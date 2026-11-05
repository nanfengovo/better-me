import { useEffect, useRef, useState } from "react";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import type { NativeLoginState, UnderstandingClient } from "../services/understanding-client";
import { nativeToolStatus } from "../lib/native-tool-status";
import "./native-tool-connections.css";

export function NativeToolConnections({ items, client, onChange }: {
  items: UnderstandingCapability[]; client: UnderstandingClient; onChange: () => void;
}) {
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
        if (next.state !== "pending") { setAuthCode(""); setNotice(next.state === "complete" ? "本账号的原生登录已保存；尚未发送资料或调用模型。" : "本次登录未完成，未复用电脑上的共享登录。可以重新发起。"); onChange(); return; }
      } catch { if (!controller.signal.aborted) { setLogin(undefined); setNotice("登录状态暂时无法确认。未自动重试登录或改用 API Key，请刷新工具状态。"); } return; }
      timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, onChange, pending, login?.runtimeId]);
  async function perform(task: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    const signal = lifetime.current.signal; working.current = true; setBusy(true); setNotice("");
    try { await task(signal); if (!signal.aborted) onChange(); }
    catch (error) { if (!signal.aborted) setNotice(error instanceof Error ? error.message : "本账号工具授权未完成，未改变模型或已有资料。"); }
    finally { working.current = false; if (!signal.aborted) setBusy(false); }
  }
  function openForm(id?: string) { setKey(""); setModel(""); setEndpoint(""); setConsent(false); setForm(id); }
  return <div className="native-tool-connections" aria-label="本账号工具授权">
    <p>授权只属于当前 BetterMe 账号。不会读取、复制或退出电脑上已有的 CLI 登录；工具登录与本轮资料授权分开。</p>
    <ul>{items.map(item => {
      const connectable = item.available && item.authMethods?.length && !["sandbox_unavailable", "protocol_incompatible", "adapter_missing", "managed_policy_unavailable", "runtime_terminated"].includes(item.code ?? "");
      return <li key={item.id} data-state={item.code ?? "legacy"}>
        <div className="native-tool-heading"><strong>{item.name}</strong><span>{nativeToolStatus(item)}</span></div>
        {item.reason && <p>{item.reason}</p>}{item.model && <small>独立模型：{item.model}</small>}
        {(connectable || item.authorized || item.supported) && <div className="native-tool-actions">
          {connectable && item.authMethods?.includes("browser") && client.startNativeLogin && <button type="button" disabled={busy || pending} onClick={() => void perform(async signal => {
            openForm(); setAuthCode(""); const next = await client.startNativeLogin!(signal, "claude-code"); if (!signal.aborted) setLogin(next);
          })}>为本账号登录 Claude 订阅</button>}
          {connectable && item.authMethods?.includes("device") && client.startNativeLogin && <button type="button" disabled={busy || pending} onClick={() => void perform(async signal => {
            openForm(); const next = await client.startNativeLogin!(signal); if (!signal.aborted) setLogin(next);
          })}>为本账号登录 Codex</button>}
          {connectable && item.authMethods?.includes("api-key") && client.authorizeNative && <button type="button" disabled={busy} onClick={() => openForm(form === item.id ? undefined : item.id)}>独立 API 授权</button>}
          {(item.authorized || item.supported) && client.disconnectNative && <button type="button" disabled={busy} onClick={() => void perform(async signal => {
            await client.disconnectNative!(item.id, signal); if (!signal.aborted) setNotice(`已撤销本账号的 ${item.name} 授权，相关任务已停止；其他登录和记录不变。`);
          })}>撤销本账号授权</button>}
        </div>}
        {form === item.id && <form className="native-tool-form" onSubmit={event => {
          event.preventDefault(); if (!consent || !client.authorizeNative) return;
          const input = { mode: "api-key" as const, apiKey: key, model, ...(endpoint ? { endpoint } : {}), consent: true as const };
          setKey("");
          void perform(async signal => { await client.authorizeNative!(item.id, input, signal); if (!signal.aborted) { openForm(); setNotice("仅本账号的工具凭据已保存；还没有调用模型，连接与计费权限仍待真实运行验证。"); } });
        }}>
          <p>这是工具的独立 API 通道，可能产生费用。不会使用或替换上方模型配置，也不会自动创建 Key。</p>
          <label>API Key<input type="password" value={key} autoComplete="new-password" required minLength={8} disabled={busy} onChange={event => setKey(event.target.value)} /></label>
          <label>模型<input value={model} required maxLength={120} disabled={busy} placeholder="填写本工具实际支持的模型" onChange={event => setModel(event.target.value)} /></label>
          <label>API 基础地址（可选）<input type="url" value={endpoint} disabled={busy} placeholder={item.id === "claude-code" ? "https://api.anthropic.com" : item.id === "gemini-cli" ? "https://generativelanguage.googleapis.com" : "https://api.openai.com/v1"} onChange={event => setEndpoint(event.target.value)} /></label>
          <label className="native-tool-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认此凭据属于当前账号，并同意仅在本机私有目录保存；实际调用可能消耗配额或产生费用。</label>
          <div className="native-tool-actions"><button type="submit" disabled={busy || !consent || !key.trim() || !model.trim()}>保存本账号授权</button><button type="button" disabled={busy} onClick={() => openForm()}>取消</button></div>
        </form>}
      </li>;
    })}</ul>
    {login?.state === "pending" && <section className="native-tool-device" aria-label={login.runtimeId === "claude-code" ? "Claude 本账号原生登录" : "Codex 本账号设备登录"}>
      <strong>请在官方页面核对并登录你的 {login.runtimeId === "claude-code" ? "Claude 订阅" : "Codex"}账号</strong>
      {login.verificationUrl && (login.userCode || login.acceptsCode) ? <><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{login.acceptsCode ? "打开 Claude 官方订阅授权页" : "打开 OpenAI 官方设备授权页"}</a>{login.userCode && <p>本次设备码：<code>{login.userCode}</code></p>}<small>仅用于本次独立登录，不进入聊天或长期记录；不会新建 Console API Key。请核对官方页面上的账号，完成后这里会更新。</small>{login.acceptsCode && client.submitNativeCode && <form onSubmit={event => { event.preventDefault(); const code = authCode.trim(); setAuthCode(""); void perform(async signal => { await client.submitNativeCode!(code, signal); }); }}><label>官方页面返回的一次性授权码<input type="password" autoComplete="off" value={authCode} onChange={event => setAuthCode(event.target.value)} placeholder="完整 code#state" /></label><button type="submit" disabled={busy || !authCode.trim()}>提交本次授权码</button></form>}</> : <p>正在等待 CLI 提供官方授权地址；不会打开或接管现有浏览器页面。</p>}
      {client.cancelNativeLogin && <button type="button" disabled={busy} onClick={() => void perform(async signal => { await client.cancelNativeLogin!(signal, login.runtimeId); if (!signal.aborted) { setAuthCode(""); setLogin(undefined); setNotice("已取消本次设备登录；此前独立授权和电脑上的共享登录保持不变。"); } })}>取消本次登录</button>}
    </section>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
