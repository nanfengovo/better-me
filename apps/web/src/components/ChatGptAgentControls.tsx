import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatGptModel, ChatGptState } from "@better-me/agent-contracts";
import { defaultChatGptClient, type ChatGptChoice, type ChatGptClient } from "../services/chatgpt-client";
import "./chatgpt-agent-controls.css";

export function ChatGptAgentControls({ value, onChange, onReady, disabled = false, client = defaultChatGptClient }: {
  value: ChatGptChoice; onChange: (value: ChatGptChoice) => void; onReady: (ready: boolean) => void; disabled?: boolean; client?: ChatGptClient;
}) {
  const uid = useId();
  const [state, setState] = useState<ChatGptState>();
  const [models, setModels] = useState<ChatGptModel[]>([]);
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [modelError, setModelError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [refreshModels, setRefreshModels] = useState(0);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [welcome, setWelcome] = useState(false);
  const alive = useRef(true), lock = useRef(false), ownedAttempt = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onChange, onReady, value }); callbacks.current = { onChange, onReady, value };
  const profile = state?.profiles.find(item => item.id === value.profileId);
  const waiting = state?.attempt && ["waiting", "exchanging"].includes(state.attempt.phase);
  const blocked = Boolean(profile?.issue && ["auth", "limit", "eligibility", "permission"].includes(profile.issue.kind));
  const ready = profile?.state === "connected" && !blocked && !loadingModels && !modelError && !error && !waiting && !operation && models.some(item => item.slug === value.model);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await client.state(signal);
    if (signal?.aborted || !alive.current) return;
    setState(next); setError("");
    if (next.attempt && next.attempt.id === ownedAttempt.current && next.attempt.phase === "completed") {
      callbacks.current.onChange({ profileId: next.attempt.profileId, model: "" });
      ownedAttempt.current = undefined; setAuthorizationUrl("");
      const key = "betterme.chatgpt-plan-welcome.v1";
      try { if (!localStorage.getItem(key)) setWelcome(true); } catch { setWelcome(true); }
    }
  }, [client]);
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "无法读取授权状态。"); });
    const update = () => { void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("ChatGPT 状态暂未确认，请刷新；不会更换提供方。"); }); };
    window.addEventListener("betterme:chatgpt-state", update);
    return () => { alive.current = false; controller.abort(); window.removeEventListener("betterme:chatgpt-state", update); };
  }, [refresh]);
  // A hidden/closed entry is not a revoked account. Selection and fresh account state
  // invalidate readiness; unmounting this view must not disable sibling entry points.
  useEffect(() => { callbacks.current.onReady(ready); }, [ready]);
  useEffect(() => {
    const controller = new AbortController(); setModels([]); setModelError("");
    if (profile?.state !== "connected") { setLoadingModels(false); return () => controller.abort(); }
    setLoadingModels(true);
    void client.models(value.profileId, controller.signal).then(next => { if (!controller.signal.aborted) setModels(next); })
      .catch(error => { if (!controller.signal.aborted) setModelError(error instanceof Error ? error.message : "模型目录暂不可读。"); })
      .finally(() => { if (!controller.signal.aborted) setLoadingModels(false); });
    return () => controller.abort();
  }, [client, profile?.state, value.profileId, refreshModels]);
  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("授权结果暂未确认，请保留此页并刷新状态。"); }); }, 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [waiting, refresh]);
  async function perform(name: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setOperation(name); setError("");
    try { await action(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "操作尚未完成，请刷新状态。"); }
    finally { lock.current = false; if (alive.current) setOperation(""); }
  }
  function signIn(profileId?: string) {
    if (disabled || lock.current || state?.authorizationUnavailableReason) return;
    // Reserve a separate window during the user's gesture; never navigate the editor.
    const popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
    void perform("sign-in", async () => {
      try {
        const result = await client.signIn(profileId);
        const url = new URL(result.authorizationUrl);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") throw new Error("授权地址未通过官方来源校验，未打开。");
        ownedAttempt.current = result.attemptId;
        if (alive.current) setAuthorizationUrl(url.href);
        if (popup) popup.location.href = url.href;
        await refresh();
      } catch (error) { popup?.close(); throw error; }
    });
  }
  const busy = disabled || Boolean(operation);
  return <section className="chatgpt-agent-controls" aria-label="ChatGPT 账号 Agent">
    <header><strong>ChatGPT 账号授权</strong><span role="status">{operation === "sign-in" ? "正在准备官方授权…" : waiting ? state?.attempt?.phase === "exchanging" ? "正在校验授权返回…" : "等待你在官方页面登录授权" : profile?.state === "connected" ? "账号已连接 · 使用 ChatGPT 套餐" : profile?.state === "plan-disabled" ? "已登录 · 尚未授权套餐使用" : profile?.state === "reauth-required" ? "授权已过期 · 需要重新登录" : !value.profileId && state?.profiles.length ? "请选择账号与模型" : "尚未连接可用账号"}</span></header>
    <p>仅用于本轮授权的 BetterMe 任务。不会导入 ChatGPT 网页聊天，也不会自动切换付费 API。</p>
    <div className="chatgpt-agent-fields"><label htmlFor={`${uid}-profile`}>ChatGPT 账号</label><select id={`${uid}-profile`} disabled={busy || Boolean(waiting)} value={value.profileId} onChange={event => { setModels([]); onChange({ profileId: event.target.value, model: "" }); }}>
      <option value="">请选择账号</option>{state?.profiles.map(item => <option key={item.id} value={item.id}>{item.label}{item.state !== "connected" ? " · 需授权" : ""}</option>)}
    </select><label htmlFor={`${uid}-model`}>本次使用的 GPT 模型</label><select id={`${uid}-model`} value={value.model} disabled={busy || loadingModels || profile?.state !== "connected"} onChange={event => onChange({ ...value, model: event.target.value })}>
      <option value="">{loadingModels ? "正在读取账号可用模型…" : "请选择模型（不自动代选）"}</option>{models.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
    </select></div>
    {profile?.state === "connected" && !loadingModels && !modelError && !models.length && <p role="status">该账号当前没有可展示的模型，请核对资格或刷新目录。</p>}
    {value.model && !loadingModels && !models.some(model => model.slug === value.model) && <p role="alert">原先选择的模型尚未在本次目录中确认，不能发送；请刷新并重新选择。</p>}
    {state?.authorizationUnavailableReason && <p role="alert">{state.authorizationUnavailableReason}</p>}
    <div className="chatgpt-agent-actions"><button type="button" data-oai-siwc-button disabled={busy || Boolean(waiting) || !state || Boolean(state.authorizationUnavailableReason)} onClick={() => signIn()}>Continue with ChatGPT</button>
      {value.profileId && <button type="button" disabled={busy || Boolean(waiting) || Boolean(state?.authorizationUnavailableReason)} onClick={() => signIn(value.profileId)}>重新授权所选账号</button>}
      <button type="button" disabled={busy} onClick={() => void perform("refresh", async () => { await refresh(); setRefreshModels(count => count + 1); })}>刷新授权与模型</button>
      {waiting && <button type="button" disabled={busy} onClick={() => void perform("cancel", async () => { await client.cancelSignIn(state!.attempt!.id); setAuthorizationUrl(""); await refresh(); })}>取消本次授权</button>}
      {profile && profile.state !== "signed-out" && <button type="button" disabled={busy || Boolean(waiting)} onClick={() => void perform("sign-out", async () => {
        const result = await client.signOut(profile.id); if (!alive.current) return; setState(result.state); setModels([]); onChange({ profileId: profile.id, model: "" });
        if (!result.remoteRevoked) setError("本机已退出，但未确认远端撤销。请在 ChatGPT 设置中断开 BetterMe；没有继续使用旧凭据。");
      })}>断开所选账号</button>}
    </div>
    {authorizationUrl && waiting && <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">重新打开本次官方授权页面</a>}
    {state?.attempt?.issue && <p role="alert">{state.attempt.issue.message}</p>}
    {profile?.issue && <div role="alert"><p>{profile.issue.message}</p>{profile.issue.requestId && <small>请求编号：{profile.issue.requestId}</small>}
      {profile.issue.kind === "limit" && <button type="button" disabled={busy} onClick={() => void perform("retry", async () => { await client.retry(profile.id); await refresh(); setRefreshModels(count => count + 1); })}>我已检查用量，允许下次手动重试</button>}</div>}
    {(error || modelError) && <p role="alert">{error || modelError}</p>}
    <div className="chatgpt-agent-usage"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">管理 ChatGPT 用量与授权 ↗</a><small>剩余额度与恢复时间未由服务提供，不显示估算百分比。{profile?.lastCompletedAt ? "该账号已有一次完整请求成功；不保证下一次的额度。" : "连接和模型列表不代表已完成模型调用。"}</small></div>
    {welcome && <div role="dialog" aria-label="ChatGPT 套餐使用已启用" className="chatgpt-agent-welcome"><strong>你正在使用 ChatGPT 套餐</strong><p>符合条件的请求使用你的套餐或可用额度，可在 ChatGPT 设置中管理；只有你明确发送时才处理当前材料。</p><button type="button" onClick={() => { setWelcome(false); try { localStorage.setItem("betterme.chatgpt-plan-welcome.v1", "seen"); } catch { /* Dismissal works even if browser persistence is unavailable. */ } }}>知道了</button></div>}
  </section>;
}
