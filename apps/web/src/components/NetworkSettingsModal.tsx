import { useUiPreferences } from "../lib/ui-preferences";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Globe2, Loader2, Network, RefreshCw, ShieldCheck, X } from "lucide-react";
import {
  DEFAULT_NETWORK_SETTINGS,
  detectNetworkProxies,
  getNetworkSettings,
  saveNetworkSettings,
  testNetworkConnection,
  validateNetworkSettings,
  type NetworkDetectionResult,
  type NetworkRoute,
  type NetworkSettings,
  type NetworkTestResult,
  type NetworkTestTarget,
} from "../lib/network-settings";
import "./network-settings.css";

type Props = { isOpen: boolean; onClose: () => void };





function RouteSummary({ route }: { route: NetworkRoute }) {
  const { t } = useUiPreferences();

  return <span className="network-route-summary">
    <span>{route.proxyUrl ? t("通过代理", "Via proxy") : t("直接连接", "Direct connection")} · {route.source}</span>
    {route.proxyUrl && <code>{route.proxyUrl}</code>}
  </span>;
}

function errorMessage(error: unknown, t: (chinese: string, english: string) => string) {
  return error instanceof Error ? error.message : t("请求失败，请稍后重试。", "Request failed. Please try again later.");
}

export function NetworkSettingsModal({ isOpen, onClose }: Props) {
  const { t } = useUiPreferences();
  const uiTextRef = useRef(t);
  uiTextRef.current = t;

const MODES: { value: NetworkSettings["mode"]; title: string; description: string }[] = [
  { value: "auto", title: t("自动检测", "Detect automatically"), description: t("优先使用环境变量或系统代理；没有配置时直连。", "Use an environment or system proxy when configured; otherwise connect directly.") },
  { value: "direct", title: t("直接连接", "Direct connection"), description: t("常规岗位请求不使用显式代理；系统 TUN／VPN 仍可能影响连接。", "Regular job requests use no explicit proxy; a system TUN/VPN may still affect connections.") },
  { value: "manual", title: t("手动代理", "Manual proxy"), description: t("指定代理软件的 HTTP 或 Mixed 地址和端口。", "Enter your proxy application's HTTP or Mixed address and port.") },
];
const TARGETS: { value: NetworkTestTarget; label: string }[] = [
  { value: "51job", label: t("51job · 国内招聘", "51job · China jobs") },
  { value: "boss", label: t("BOSS直聘 · 国内招聘", "BOSS Zhipin · China jobs") },
  { value: "liepin", label: t("猎聘 · 国内招聘", "Liepin · China jobs") },
  { value: "linkedin", label: t("LinkedIn · 海外招聘", "LinkedIn · International jobs") },
  { value: "greenhouse", label: t("Greenhouse · 公司招聘源", "Greenhouse · Company careers") },
  { value: "lever", label: t("Lever · 公司招聘源", "Lever · Company careers") },
  { value: "tencent", label: t("腾讯 · 公司招聘源", "Tencent · Company careers") },
];


  const titleId = useId();
  const descriptionId = useId();
  const proxyHelpId = useId();
  const domesticProxyHelpId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef(0);
  const loadRef = useRef<AbortController | null>(null);
  const detectionRef = useRef<AbortController | null>(null);
  const testRef = useRef<AbortController | null>(null);
  const saveRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<NetworkSettings>({ ...DEFAULT_NETWORK_SETTINGS });
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<NetworkDetectionResult | null>(null);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [target, setTarget] = useState<NetworkTestTarget>("51job");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const session = ++sessionRef.current;
    const dialog = dialogRef.current;
    loadRef.current?.abort();
    detectionRef.current?.abort();
    testRef.current?.abort();
    saveRef.current?.abort();
    if (!isOpen) {
      dialog?.close();
      return;
    }
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    closeRef.current?.focus();
    setDraft({ ...DEFAULT_NETWORK_SETTINGS });
    setLoaded(false);
    setLoading(true);
    setLoadError(null);
    setDetection(null);
    setDetectionError(null);
    setDetecting(true);
    setTestResult(null);
    setTestError(null);
    setTesting(false);
    setSaving(false);
    setSaveError(null);
    const load = new AbortController();
    const detect = new AbortController();
    loadRef.current = load;
    detectionRef.current = detect;
    void getNetworkSettings(load.signal).then((settings) => {
      if (sessionRef.current !== session || load.signal.aborted) return;
      setDraft(settings);
      setLoaded(true);
    }).catch((error: unknown) => {
      if (sessionRef.current === session && !load.signal.aborted) setLoadError(errorMessage(error, uiTextRef.current));
    }).finally(() => {
      if (sessionRef.current === session && !load.signal.aborted) setLoading(false);
    });
    void detectNetworkProxies(detect.signal).then((result) => {
      if (sessionRef.current === session && !detect.signal.aborted) setDetection(result);
    }).catch((error: unknown) => {
      if (sessionRef.current === session && !detect.signal.aborted) setDetectionError(errorMessage(error, uiTextRef.current));
    }).finally(() => {
      if (sessionRef.current === session && !detect.signal.aborted) setDetecting(false);
    });
    return () => {
      sessionRef.current += 1;
      load.abort();
      detect.abort();
      detectionRef.current?.abort();
      testRef.current?.abort();
      saveRef.current?.abort();
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);

  const updateDraft = (changes: Partial<NetworkSettings>) => {
    testRef.current?.abort();
    setTesting(false);
    setDraft((current) => ({ ...current, ...changes }));
    setTestResult(null);
    setTestError(null);
    setSaveError(null);
  };

  const handleDetect = async () => {
    const session = sessionRef.current;
    detectionRef.current?.abort();
    const controller = new AbortController();
    detectionRef.current = controller;
    setDetecting(true);
    setDetection(null);
    setDetectionError(null);
    try {
      const result = await detectNetworkProxies(controller.signal);
      if (sessionRef.current === session && !controller.signal.aborted) setDetection(result);
    } catch (error) {
      if (sessionRef.current === session && !controller.signal.aborted) setDetectionError(errorMessage(error, uiTextRef.current));
    } finally {
      if (sessionRef.current === session && !controller.signal.aborted) setDetecting(false);
    }
  };

  const handleReload = async () => {
    const session = sessionRef.current;
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const settings = await getNetworkSettings(controller.signal);
      if (sessionRef.current !== session || controller.signal.aborted) return;
      setDraft(settings);
      setLoaded(true);
    } catch (error) {
      if (sessionRef.current === session && !controller.signal.aborted) setLoadError(errorMessage(error, uiTextRef.current));
    } finally {
      if (sessionRef.current === session && !controller.signal.aborted) setLoading(false);
    }
  };

  const handleTest = async () => {
    const session = sessionRef.current;
    testRef.current?.abort();
    const controller = new AbortController();
    testRef.current = controller;
    setTestResult(null);
    setTestError(null);
    setTesting(true);
    try {
      const result = await testNetworkConnection(validateNetworkSettings(draft), target, controller.signal);
      if (sessionRef.current === session && !controller.signal.aborted) setTestResult(result);
    } catch (error) {
      if (sessionRef.current === session && !controller.signal.aborted) setTestError(errorMessage(error, uiTextRef.current));
    } finally {
      if (sessionRef.current === session && !controller.signal.aborted) setTesting(false);
    }
  };

  const handleSave = async () => {
    const session = sessionRef.current;
    const controller = new AbortController();
    saveRef.current = controller;
    setSaving(true);
    setSaveError(null);
    try {
      await saveNetworkSettings(validateNetworkSettings(draft), controller.signal);
      if (sessionRef.current === session && !controller.signal.aborted) onClose();
    } catch (error) {
      if (sessionRef.current === session && !controller.signal.aborted) setSaveError(errorMessage(error, uiTextRef.current));
    } finally {
      if (sessionRef.current === session && !controller.signal.aborted) setSaving(false);
    }
  };

  const editingDisabled = loading || !loaded || saving;
  return <dialog ref={dialogRef} className="network-settings-dialog no-print" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
    }}>
    <header className="network-settings-header">
      <span className="network-settings-icon"><Network size={21} aria-hidden="true" /></span>
      <div><h2 id={titleId}>{t("网络与代理", "Network & proxy")}</h2><p id={descriptionId}>{t("为国内与海外岗位来源选择合适的连接方式", "Choose connections for domestic and international job sources")}</p></div>
      <button ref={closeRef} type="button" className="network-close-button" aria-label={t("关闭网络与代理设置", "Close network and proxy settings")} disabled={saving} onClick={onClose}><X size={20} /></button>
    </header>
    <div className="network-settings-body">
      <div className="network-scope-note"><ShieldCheck size={17} aria-hidden="true" /><p>{t("适用于", "Applies to")}<strong>{t("岗位链接提取与公司招聘源", "job link extraction and company career sources")}</strong>{t("。AI 模型列表、生成／截图识别请求，以及“打开原岗位”等外部链接，跟随浏览器和系统代理／TUN；这里选择“直接连接”也不会改变 AI 的连接方式。", ". AI model lists, generation, screenshot recognition and external job links use the browser and system proxy/TUN. Selecting Direct connection here does not change AI connections.")}</p></div>
      {loading && <p className="network-status" role="status"><Loader2 size={16} className="network-spinner" aria-hidden="true" />{t("正在读取已保存的网络设置…", "Loading saved network settings…")}</p>}
      {loadError && <div className="network-result is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{t("暂时无法读取原有网络设置", "Could not load existing network settings")}</strong><p>{loadError}</p><p>{t("请通过正在运行的 BetterMe 本地服务打开页面。纯静态托管页面无法读取你电脑上的代理；远程服务也不能替你检测本机。", "Open this page through the running BetterMe local server. Static hosting cannot read this computer's proxy settings, and a remote server cannot detect them for you.")}</p><p>{loaded ? t("当前使用新的默认配置草稿。原有配置尚未覆盖，只有点击“保存设置”才会尝试写入。", "You are editing a new default draft. Existing settings are kept until you click Save settings.") : t("如果原有配置已损坏，可以点击“重新配置”建立默认草稿；仅在你明确保存后才会覆盖原有配置。", "If existing settings are damaged, choose Reconfigure to create a default draft. They are replaced only when you save.")}</p><div className="network-recovery-actions"><button type="button" className="network-button" onClick={() => void handleReload()} disabled={loading || saving}>{t("重新读取设置", "Reload settings")}</button><button type="button" className="network-button" disabled={loading || saving || loaded} onClick={() => { setDraft({ ...DEFAULT_NETWORK_SETTINGS }); setLoaded(true); setTestResult(null); setTestError(null); setSaveError(null); }}>{loaded ? t("已建立默认草稿", "Default draft created") : t("重新配置", "Reconfigure")}</button></div></div></div>}
      <fieldset className="network-mode-fieldset" disabled={editingDisabled}>
        <legend>{t("连接方式", "Connection mode")}</legend>
        <div className="network-mode-options">{MODES.map((mode) => <label key={mode.value} className={`network-mode-option${draft.mode === mode.value ? " is-selected" : ""}`}>
          <input type="radio" name="network-proxy-mode" value={mode.value} checked={draft.mode === mode.value} onChange={() => updateDraft({ mode: mode.value })} />
          <span><span className="network-mode-title">{mode.title}{mode.value === "auto" && <small>{t("推荐", "Recommended")}</small>}</span><span className="network-mode-description">{mode.description}</span></span>
        </label>)}</div>
      </fieldset>
      {draft.mode === "manual" && <label className="network-field"><span>{t("代理地址", "Proxy URL")}</span><input type="url" inputMode="url" autoComplete="off" spellCheck={false} aria-describedby={proxyHelpId} value={draft.proxyUrl} placeholder="http://127.0.0.1:7890" disabled={editingDisabled} onChange={(event) => updateDraft({ proxyUrl: event.target.value })} /><small id={proxyHelpId}>{t("填写代理软件的 HTTP 或 Mixed 端口，支持 http://、https://。暂不支持 SOCKS、PAC 或带用户名密码的代理地址。", "Use an HTTP or Mixed proxy port with http:// or https://. SOCKS, PAC and URLs containing credentials are not supported.")}</small></label>}
      <section className="network-domestic-proxy" aria-label={t("国内招聘平台独立代理", "Separate proxy for China job platforms")}>
        <label className="network-field"><span>{t("国内招聘平台独立代理", "Separate proxy for China job platforms")} <small>{t("可选", "Optional")}</small></span><input type="url" inputMode="url" autoComplete="off" spellCheck={false} aria-describedby={domesticProxyHelpId} value={draft.domesticProxyUrl ?? ""} placeholder="http://127.0.0.1:17891" disabled={editingDisabled} onChange={(event) => updateDraft({ domesticProxyUrl: event.target.value })} /><small id={domesticProxyHelpId}>{t("仅用于 51job、BOSS直聘、猎聘及其子域名；其他岗位来源继续使用上方连接方式。留空时三家平台也使用上方设置。", "Applies only to 51job, BOSS Zhipin, Liepin and their subdomains. Other sources use the connection above. Leave blank to use that connection for all sources.")}</small></label>
        <p>{t("可以保留 GPT 和系统的现有连接，为这三家平台单独填写另一条 HTTP／Mixed 代理路线。本应用不会修改系统代理，也不会自动启动代理服务；请先确认填写的地址正在运行。", "Keep your existing GPT and system connections and use another HTTP/Mixed proxy for these platforms. BetterMe does not change system proxies or start proxy services; ensure the address is running.")}</p>
        <p>{t("独立地址优先于上方常规连接方式及“不走代理的地址”规则。配置后仍不能保证站点允许访问，也不会自动处理登录或验证码。", "This address takes precedence over the regular connection and bypass rules. Access is still controlled by each site; login and verification are not automated.")}</p>
      </section>
      <section className="network-detection" aria-label={t("本机代理检测", "Local proxy detection")}>
        <div className="network-section-heading"><div><h3>{t("本机代理检测", "Local proxy detection")}</h3><p>{t("读取本地服务所在电脑的系统和环境变量配置，并检查常见本地端口。", "Read system and environment settings on the local server's computer and check common local ports.")}</p></div><button type="button" className="network-button" disabled={detecting || saving} onClick={() => void handleDetect()}><RefreshCw size={14} className={detecting ? "network-spinner" : ""} aria-hidden="true" />{detecting ? t("正在检测…", "Detecting…") : t("重新检测", "Detect again")}</button></div>
        {detecting && !detection && <p className="network-status" role="status">{t("正在检查本机代理配置与端口…", "Checking local proxy settings and ports…")}</p>}
        {detectionError && <p className="network-inline-error" role="alert">{detectionError}</p>}
        {detection && <>
          {detection.candidates.length > 0 ? <ul className="network-candidates">{detection.candidates.map((candidate, index) => <li key={`${candidate.url}:${candidate.source}:${index}`}>
            <div><code>{candidate.url}</code><span>{candidate.source} · {candidate.reachable ? t("端口有响应", "Port responded") : t("端口未响应", "No port response")}</span></div>
            <button type="button" className="network-button" disabled={editingDisabled} onClick={() => updateDraft({ mode: "manual", proxyUrl: candidate.url })}>{t("使用此代理", "Use this proxy")}</button>
          </li>)}</ul> : <p className="network-empty">{t("未发现本机代理配置或常见代理端口。可以直接连接，或在代理软件中查看 HTTP／Mixed 端口后手动填写。", "No local proxy settings or common ports were found. Connect directly or find the HTTP/Mixed port in your proxy application and enter it manually.")}</p>}
          <p className="network-detection-note">{t("端口有响应仅代表存在监听服务。请使用下方连通性测试确认它能否代理请求；“使用此代理”只填入草稿，保存后才生效。", "A port response only confirms a listening service. Test connectivity below to check proxy support. Use this proxy updates the draft; save to apply it.")}</p>
          {draft.mode === "auto" && <p className="network-auto-route"><span>{t("常规自动路线当前选择", "Current automatic route")}</span><RouteSummary route={detection.autoRoute} /></p>}
          {detection.warnings.length > 0 && <ul className="network-warnings">{detection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        </>}
      </section>
      <label className="network-field"><span>{t("不走代理的地址", "Proxy bypass addresses")} <small>{t("可选", "Optional")}</small></span><input type="text" value={draft.bypass} disabled={editingDisabled} onChange={(event) => updateDraft({ bypass: event.target.value })} placeholder="localhost,127.0.0.1,::1,.example.com" autoComplete="off" spellCheck={false} /><small>{t("用逗号分隔主机名、IP 或域名后缀；常规路线中的这些目标直接连接，国内独立代理配置优先。", "Separate hostnames, IPs or domain suffixes with commas. These destinations bypass the regular proxy; the separate China platform proxy takes precedence.")}</small></label>
      <section className="network-connectivity" aria-label={t("网络连通性测试", "Network connectivity test")}>
        <div className="network-section-heading"><div><h3><Globe2 size={16} aria-hidden="true" />{t("连通性测试", "Connectivity test")}</h3><p>{t("使用当前草稿连接公开站点；测试不会保存设置。", "Connect to a public site using this draft; testing does not save settings.")}</p></div></div>
        <div className="network-test-controls"><label className="network-field"><span className="network-sr-only">{t("测试站点", "Test site")}</span><select value={target} disabled={editingDisabled || testing} onChange={(event) => { testRef.current?.abort(); setTesting(false); setTestResult(null); setTestError(null); setTarget(event.target.value as NetworkTestTarget); }}>{TARGETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button type="button" className="network-button" disabled={editingDisabled || testing} onClick={() => void handleTest()}>{testing ? <Loader2 className="network-spinner" size={15} aria-hidden="true" /> : <Globe2 size={15} aria-hidden="true" />}{testing ? t("正在测试…", "Testing…") : t("测试当前配置", "Test this configuration")}</button></div>
        {testError && <p className="network-inline-error" role="alert">{testError}</p>}
        {testResult && <div className={`network-result ${testResult.ok ? "is-success" : "is-warning"}`} role="status">{testResult.ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}<div><strong>{testResult.ok ? t("已收到站点正常响应", "Site responded successfully") : testResult.status ? t("已连接，但站点返回限制或错误", "Connected, but the site returned a restriction or error") : t("连接未成功", "Connection unsuccessful")}</strong><p>{testResult.message}</p><RouteSummary route={testResult.route} /><p className="network-test-meta">{testResult.status !== undefined ? `HTTP ${testResult.status} · ` : ""}{testResult.elapsedMs} ms · {TARGETS.find((item) => item.value === target)?.label}</p></div></div>}
        <p className="network-test-boundary">{t("连通不等于能提取岗位正文。登录、验证码、403 或动态页面限制仍可能阻止提取，可打开原岗位后粘贴正文或使用截图识别。", "Connectivity does not guarantee job text extraction. Login, verification, 403 responses or dynamic pages may still block reading. Open the original job and paste the text or use a screenshot.")}</p>
      </section>
      {saveError && <p className="network-inline-error" role="alert">{t("保存失败：", "Save failed:")}{saveError} {t("当前填写内容已保留，可以修改后重试。", "Your draft is kept. Edit it and try again.")}</p>}
    </div>
    <footer className="network-settings-footer"><p>{t("保存到本机服务，后续岗位请求生效。取消会放弃本次修改。", "Saved to the local server for future job requests. Cancel discards this draft.")}</p><div><button type="button" className="network-button" onClick={onClose} disabled={saving}>{t("取消", "Cancel")}</button><button type="button" className="network-button is-primary" disabled={editingDisabled} onClick={() => void handleSave()}>{saving ? <Loader2 size={15} className="network-spinner" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{saving ? t("正在保存…", "Saving…") : t("保存设置", "Save settings")}</button></div></footer>
  </dialog>;
}
