import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, RefreshCw, ShieldCheck } from "lucide-react";
import { siDiscord, siGithub, siGitlab, siGoogle, siQq, siWechat } from "simple-icons";
import { SOCIAL_PROVIDERS, LoginMethodsSchema, SocialLoginCatalogSchema, type LoginMethods, type SocialChannel, type SocialLoginCatalog, type SocialProviderId } from "@better-me/agent-contracts";
import { captureIdentity, captureIdentityTransition, identityRequest } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";

const icons: Record<SocialProviderId, { path: string }> = {
  wechat: siWechat, qq: siQq, github: siGithub, google: siGoogle, gitlab: siGitlab, discord: siDiscord,
  microsoft: { path: "M1 1h10v10H1zM13 1h10v10H13zM1 13h10v10H1zM13 13h10v10H13z" },
};
const stateLabels: Record<SocialChannel["state"], [string, string]> = { available: ["", ""], not_configured: ["待开通", "Not configured"], disabled: ["已停用", "Disabled"],
  unsafe_binding: ["待完善配置", "Setup incomplete"], unsupported_context: ["请切换浏览器", "Switch browser"], unavailable: ["服务离线", "Service offline"] };

/** Social credentials and account management stay at the IdP; BetterMe consumes capability metadata only. */
export function CasdoorAccess({ link = false }: { link?: boolean }) {
  const { t } = useUiPreferences();
  const [catalog, setCatalog] = useState<SocialLoginCatalog>();
  const [methods, setMethods] = useState<LoginMethods>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<string>("");
  const generation = useRef({ value: 0 }).current;
  const starting = useRef(false);
  const load = useCallback(async (fresh = false) => {
    const current = ++generation.value;
    const assert = link ? captureIdentity() : captureIdentityTransition();
    setLoading(true);
    try {
      const [providers, account] = await Promise.all([identityRequest(fresh ? "providers?refresh=1" : "providers"), link ? identityRequest("account") : undefined]);
      assert();
      if (current !== generation.value) return;
      setCatalog(SocialLoginCatalogSchema.parse(providers));
      if (account) setMethods(LoginMethodsSchema.parse(account));
      setError("");
    } catch {
      if (current === generation.value) { setCatalog(undefined); setError("暂时无法读取登录方式，请重试；本机账号和已有资料不受影响。"); }
    } finally { if (current === generation.value) setLoading(false); }
  }, [generation, link]);
  useEffect(() => { void load(); return () => { generation.value++; }; }, [generation, load]);

  async function start(provider?: SocialProviderId, intent: "login" | "link" | "manage" = link ? "link" : "login", form?: HTMLFormElement) {
    if (starting.current || !catalog || (provider ? catalog.channels.find(channel => channel.id === provider)?.state !== "available" : !catalog.unifiedLoginAvailable)) return;
    starting.current = true;
    const current = generation.value, assert = intent === "login" ? captureIdentityTransition() : captureIdentity();
    const password = form ? new FormData(form).get("localPassword") : undefined;
    setBusy(true); setError(""); setSelected(intent === "manage" ? "账号中心" : catalog.channels.find(channel => channel.id === provider)?.label ?? "统一账号");
    try {
      const pending: Promise<void>[] = [];
      window.dispatchEvent(new CustomEvent("betterme:before-sign-out", { detail: pending }));
      await Promise.all(pending); assert();
      const result = await identityRequest("oidc/start", { intent, ...(provider ? { provider } : {}), ...(intent === "link" ? { password } : {}) });
      assert();
      if (current !== generation.value) return;
      const url = typeof result.url === "string" ? new URL(result.url) : undefined;
      if (!url || !["https:", "http:"].includes(url.protocol) || url.origin !== catalog.authorizeOrigin) throw new Error("登录地址未通过核对，未离开 BetterMe。");
      form?.reset(); window.location.assign(url.href);
    } catch (failure) {
      starting.current = false;
      if (current === generation.value) { setError(failure instanceof Error ? failure.message : "登录未完成，请重试。资料未移动，账号未切换。"); setBusy(false); }
    } finally { form?.reset(); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const id = catalog?.channels.find(channel => channel.id === submitter?.value)?.id;
    void start(id, "link", event.currentTarget);
  }
  const available = catalog?.service === "ready" ? catalog.channels.filter(channel => channel.state === "available") : [];
  const hasOnlineLogin = available.length > 0 || catalog?.service === "ready" && catalog.unifiedLoginAvailable;
  const visibleChannels = link ? available : catalog?.channels.filter(channel => SOCIAL_PROVIDERS.some(provider => provider.id === channel.id && provider.primary) || channel.state === "available") ?? [];
  const channels = visibleChannels.length > 0 && <div className="social-login-grid" role="group" aria-label={link ? t("可关联的第三方登录", "Available external sign-in methods to link") : t("第三方账号登录", "External account sign-in")}>
    {visibleChannels.map(channel => <button key={channel.id} type={link ? "submit" : "button"} name="provider" value={channel.id}
      className={`social-login-button social-login-${channel.id}`} disabled={loading || busy || catalog?.service !== "ready" || channel.state !== "available"}
      title={channel.message} aria-label={link ? t(`关联 ${channel.label}`, `Link ${channel.label}`) : t(`使用 ${channel.label} 登录`, `Sign in with ${channel.label}`)} onClick={link ? undefined : () => void start(channel.id)}>
      <span className="social-login-icon" aria-hidden="true">{["wechat", "qq", "google"].includes(channel.id) ? <img src={`${import.meta.env?.BASE_URL ?? "/"}images/social/${channel.id}.svg`} alt="" /> : <svg viewBox="0 0 24 24" focusable="false">{channel.id === "microsoft" ? <><path fill="#f25022" d="M1 1h10v10H1z" /><path fill="#7fba00" d="M13 1h10v10H13z" /><path fill="#00a4ef" d="M1 13h10v10H1z" /><path fill="#ffb900" d="M13 13h10v10H13z" /></> : <path d={icons[channel.id].path} />}</svg>}</span>
      <span>{link ? t(`关联 ${channel.label}`, `Link ${channel.label}`) : channel.label}</span>
      {stateLabels[channel.state][0] && <small>{t(stateLabels[channel.state][0], stateLabels[channel.state][1])}</small>}
      {channel.state === "available" && <ArrowUpRight size={14} className="social-login-arrow" aria-hidden="true" />}
    </button>)}
  </div>;
  const status = <>
    {loading ? <p className="social-login-status" role="status">{t("正在核对登录方式…", "Checking sign-in methods…")}</p> : catalog && <p className="social-login-status">{hasOnlineLogin ? catalog.message : catalog.service === "offline"
      ? t("在线登录暂时不可用，请使用本机账号；已有资料保持不变。", "Online sign-in is temporarily unavailable. Use your local account; existing data is unchanged.")
      : t("当前环境未开通第三方登录，可使用本机账号。", "External sign-in is not configured here. Use your local account.")}</p>}
    {error && <p className="identity-alert" role="alert">{error}</p>}
    {busy && <p className="social-login-status" role="status">{t(`正在保护记录并连接${selected}…`, `Saving records and connecting to ${selected}…`)}</p>}
    <button type="button" className="social-login-refresh" disabled={loading || busy} onClick={() => void load(true)}><RefreshCw size={13} aria-hidden="true" />{t("重新检查登录方式", "Recheck sign-in methods")}</button>
  </>;
  const linkForm = <form className="social-link-form" onSubmit={submit}>
    <p>{t("核对本机密码后关联。原简历、Agent 记忆和历史保留，不按昵称、邮箱或手机号自动合并账号。", "Verify your local password to link. Resumes, Agent memory, and history remain intact; accounts are never auto-merged by name, email, or phone.")}</p>
    <label>{t("当前本机账号密码", "Current local account password")}<input name="localPassword" type="password" autoComplete="current-password" minLength={12} maxLength={128} required disabled={busy} /></label>
    {channels}
    {catalog?.unifiedLoginAvailable && <button type="submit" className="studio-button subtle" disabled={busy}>{t("关联统一账号", "Link unified account")}</button>}
  </form>;
  if (link) return <details className="social-account"><summary><ShieldCheck size={15} aria-hidden="true" />{t("登录方式与账号关联", "Sign-in & linked accounts")}</summary>
    {methods && <dl className="social-login-methods"><div><dt>{t("本机密码", "Local password")}</dt><dd>{methods.localPassword ? t("已设置", "Configured") : t("未设置", "Not set")}</dd></div>
      <div><dt>{t("统一账号", "Unified account")}</dt><dd>{methods.unifiedLinked ? t("已关联", "Linked") : t("未关联", "Not linked")}</dd></div></dl>}
    {methods?.unifiedLinked && <><button type="button" className="studio-button subtle" disabled={busy || !catalog?.unifiedLoginAvailable} onClick={() => void start(undefined, "manage")}>{t("管理已绑定的第三方账号", "Manage linked external accounts")}<ArrowUpRight size={14} aria-hidden="true" /></button>
      <p className="social-login-status">{t("需重新验证已关联的统一身份，再进入账号中心添加或解除平台绑定。不会更换 BetterMe 账号。", "Re-verify your linked unified identity to add or remove platform bindings in Account Center without switching your BetterMe account.")}</p></>}
    {methods?.localPassword && (methods.unifiedLinked ? <details><summary>{t("关联另一个统一身份", "Link another unified identity")}</summary>{linkForm}</details> : linkForm)}
    {methods && !methods.localPassword && !methods.unifiedLinked && <p>{t("此账号没有可用的本机密码，也未关联当前登录平台。请联系管理员核对原身份，不要创建新账号代替。", "This account has no local password and is not linked to the identity platform. Contact an administrator instead of creating a duplicate account.")}</p>}
    {status}
  </details>;
  return <section className="social-login" aria-label={t("快捷登录", "Quick sign-in")}>
    {visibleChannels.length > 0 && <h2>{t("使用已有账号登录", "Sign in with an existing account")}</h2>}
    {channels}
    {catalog?.unifiedLoginAvailable && <details className="social-login-other"><summary>{t("其他登录方式", "Other sign-in options")}</summary>
      <button type="button" className="studio-button subtle" disabled={busy} onClick={() => void start()}>{t("统一账号登录 / 注册", "Unified sign-in / sign-up")}<ArrowUpRight size={14} aria-hidden="true" /></button>
    </details>}
    {status}
  </section>;
}
