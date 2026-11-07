import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { LoginShowcase } from "./LoginShowcase";
import { LoginPreferences } from "./LoginPreferences";
import { activatePrincipal, currentPrincipal, identityRequest, invalidateIdentity, type BetterMePrincipal } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";
import "./identity.css";
import { CasdoorAccess } from "./CasdoorAccess";

/** Identity is fixed for an App lifetime. A switch starts a fresh JS realm, not a reused cache. */
export function IdentityGate({ children }: { children: ReactNode }) {
  const { t } = useUiPreferences();
  const [user, setUser] = useState<BetterMePrincipal>();
  const [ready, setReady] = useState(false), [expired, setExpired] = useState(false), [error, setError] = useState("");
  const [register, setRegister] = useState(false), [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    let active = true;
    void identityRequest("session").then(result => {
      if (!active) return;
      if (result.principal) { activatePrincipal(result.principal); setUser(result.principal); }
      setReady(true);
    }).catch(() => { if (active) { setError("无法连接本机账号服务。请确认最新版 Agent Host 已启动；已有资料未改动。"); setReady(true); } });
    const invalid = () => {
      setRegister(false); setExpired(true);
      setError("身份已过期或在另一窗口切换。本页已锁定，草稿保留。重新登录后恢复，不会自动重发任务。");
    };
    window.addEventListener("betterme:identity-expired", invalid);
    return () => { active = false; window.removeEventListener("betterme:identity-expired", invalid); };
  }, []);
  useEffect(() => {
    if (!user || expired) return;
    let active = true, checking = false;
    const check = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const result = await identityRequest("session");
        if (active && result.principal?.id !== user.id) {
          invalidateIdentity();
          window.dispatchEvent(new Event("betterme:identity-expired"));
        }
      } catch { /* A temporary offline host does not discard the mounted draft. Private calls still fail closed. */ }
      finally { checking = false; }
    };
    const focus = () => { void check(); };
    const timer = window.setInterval(focus, 30_000);
    window.addEventListener("focus", focus);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [user, expired]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    setBusy(true); setError("");
    try {
      const result = await identityRequest(register ? "register" : "sign-in", { username: data.get("username"), password: data.get("password"),
        ...(register ? { displayName: data.get("displayName") } : {}) });
      if (!result.principal) throw new Error("未收到有效身份，未打开任何私人资料。");
      form.reset(); setRegister(false);
      if (user) { window.location.reload(); return; }
      activatePrincipal(result.principal); setUser(result.principal); setExpired(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "登录未完成，请重试。"); }
    finally { setBusy(false); }
  }
  const locked = !ready || !user || expired;
  return <>
    {user && <div hidden={locked} inert={locked}>{children}</div>}
    {locked && <main className="identity-screen"><div className="login-layout"><LoginShowcase /><div className="login-form-panel"><LoginPreferences /><section className="identity-card" aria-labelledby="identity-title">
      <span className="identity-mark"><LockKeyhole size={19} /></span>
      <h1 id="identity-title">{!ready ? t("正在连接工作空间…", "Connecting to your workspace…") : expired ? t("重新连接你的工作空间", "Reconnect your workspace") : register ? t("开启你的下一步", "Begin your next chapter") : t("欢迎回来", "Welcome back")}</h1>
      <p className="login-intro">{register ? t("创建独立账号，从一份好简历开始。", "Create your account. Start with a great resume.") : t("登录 BetterMe，继续你的职业旅程。", "Sign in to BetterMe. Continue your career journey.")}</p>
      {!ready && <div className="login-loading" role="status"><LoaderCircle size={20} className="login-spinner" /> 正在核对登录状态</div>}
      {ready && <CasdoorAccess />}
      {ready && <div className="identity-divider"><span>{t("本机账号登录", "Local account sign-in")}</span></div>}
      {ready && <form onSubmit={event => void submit(event)} aria-busy={busy}>
        {register && <label className="login-new-field">{t("显示名称", "Display name")}<input name="displayName" autoComplete="nickname" maxLength={60} required disabled={busy} placeholder="如何称呼你" /></label>}
        <label>{t("账号", "Username")}<input name="username" autoComplete="username" inputMode="text" pattern="[A-Za-z0-9_.\-]{3,48}" minLength={3} maxLength={48} required disabled={busy} placeholder={t("输入你的账号", "Enter your username")} title="3–48 位字母、数字、点、横线或下划线" /></label>
        <div className="login-password-field"><label htmlFor="identity-password">{t("密码", "Password")}</label><div className="login-password-input"><input id="identity-password" name="password" type={showPassword ? "text" : "password"} autoComplete={register ? "new-password" : "current-password"} minLength={12} maxLength={128} required disabled={busy} placeholder={t("至少 12 个字符", "At least 12 characters")} /><button type="button" className="login-password-toggle" disabled={busy} aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div>
        {error && <p className="identity-alert" role="alert">{error}</p>}
        <button type="submit" className="studio-button primary" disabled={busy}>{busy && <LoaderCircle size={17} className="login-spinner" />}<span>{busy ? t("正在核对…", "Verifying…") : register ? t("创建并进入独立空间", "Create & enter workspace") : t("登录", "Sign in")}</span>{!busy && <ArrowRight size={17} aria-hidden="true" />}</button>
        {!user && <button type="button" className="studio-button subtle login-mode-switch" disabled={busy} onClick={() => { setRegister(value => !value); setShowPassword(false); setError(""); }}>{register ? t("已有账号，去登录", "Already have an account? Sign in") : t("首次使用？创建本机账号", "First time here? Create a local account")}</button>}
      </form>}
      <details><summary><ShieldCheck size={15} />{t("旧资料与保存设置", "Existing data & save settings")}</summary><p>{t("旧简历、岗位、对话和模型授权保持原位，未自动认领到任何新账号。新账号从独立空间开始；自动保存偏好不会被重置。旧资料的归属迁移需单独核对，不会通过创建账号静默完成。", "Legacy resumes, jobs, chats, and model credentials remain in place and are never silently claimed by a new account. New accounts start in an isolated space without resetting autosave preferences.")}</p><p>{t("本机账号不是操作系统沙箱。共享电脑请使用不同系统账号或浏览器配置；不防御有本机文件权限、开发者工具或恶意扩展的人。暂无密码找回，请妥善保存密码。", "Local accounts are not OS sandboxes. On shared computers, use separate OS user accounts or browser profiles. Keep your password safe as password recovery is not available.")}</p></details>
    </section><footer className="login-panel-footer"><span>{t("你的经历，值得更好的表达。", "Your experience deserves a better story.")}</span><span>BetterMe © {new Date().getFullYear()}</span></footer></div></div></main>}
  </>;
}

export function IdentityMenu() {
  const { t } = useUiPreferences();
  const user = currentPrincipal();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!user) return null;
  async function signOut() {
    setBusy(true); setError("");
    try {
      // Flush accepted local writes only. No model execution or official resume save is triggered.
      const pending: Promise<void>[] = [];
      window.dispatchEvent(new CustomEvent("betterme:before-sign-out", { detail: pending }));
      await Promise.all(pending);
      await identityRequest("sign-out", {});
      invalidateIdentity();
      window.location.reload();
    } catch { setError(t("记录尚未安全保存或退出未确认。请先备份并处理错误，未切换账号。", "Records are not yet safely saved or sign-out was not confirmed. Back up and resolve errors first; account was not switched.")); setBusy(false); }
  }
  const accountType = user.username === `oidc-${user.id}` ? t("第三方账号", "External account") : t("本机账号", "Local account");
  return <div className="identity-menu"><div className="identity-menu-profile"><span className="identity-menu-avatar" aria-hidden="true">{Array.from(user.displayName.trim())[0] ?? t("你", "Y")}</span><div className="identity-menu-copy"><strong>{user.displayName}</strong><small>@{user.username}</small><span className="identity-menu-status"><ShieldCheck size={12} aria-hidden="true" />{accountType} · {t("资料已隔离保护", "Data isolated and protected")}</span></div></div>
  <CasdoorAccess link />
    <button type="button" className="studio-button subtle" disabled={busy} onClick={() => void signOut()}><LogOut size={15} />{busy ? t("保护记录…", "Saving records…") : t("退出并切换账号", "Sign out & switch")}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
