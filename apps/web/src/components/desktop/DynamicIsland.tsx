import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useReducedMotion, useUiPreferences, type UiTranslator } from "../../lib/ui-preferences";
import { useSystemStatus } from "../../lib/use-system-status";
import { formatTokens, type Health, type ModelUsage, type StatusItem } from "../../services/system-status-client";
import "./dynamic-island.css";

export const OPEN_STATUS_EVENT = "betterme:open-system-status";
const healthLabel: Record<Health, [string, string]> = {
  ok: ["运行正常", "Healthy"],
  warn: ["部分需关注", "Attention"],
  down: ["服务离线", "Offline"],
  unknown: ["待检测", "Standby"],
};
const kindLabel: Record<NonNullable<ModelUsage["kind"]>, [string, string]> = {
  model: ["直连", "API"],
  chatgpt: ["账号", "Plan"],
  native: ["CLI", "CLI"],
};

function statusLabel(item: StatusItem, t: UiTranslator) {
  const labels: Record<string, [string, string]> = { host: ["Agent 服务", "Agent service"], proxy: ["网络代理", "Network proxy"], runtimes: ["本机 CLI", "Local CLI"], models: ["模型通道", "Model channel"] };
  const entry = labels[item.id];
  return entry ? t(...entry) : item.id === "vork" ? t(item.label, item.label.replace("渲染 · ", "Renderer · ")) : item.label;
}
function statusBadge(item: StatusItem, t: UiTranslator) {
  const labels: Record<string, string> = { 在线: "Online", 离线: "Offline", 直连: "Direct", 未检测: "Unchecked", 可连接: "Reachable", 不可达: "Unreachable", 未知: "Unknown", 可用: "Available", 需配置: "Setup needed", 异常: "Error", 未安装: "Not installed", 待登录: "Sign in", 就绪: "Ready", 待调用: "No calls", 正常: "Healthy" };
  const badge = item.badge ?? item.detail;
  const failures = badge.match(/^(\d+) 失败$/);
  return t(badge, labels[badge] ?? (failures ? `${failures[1]} failed` : healthLabel[item.health][1]));
}
function Dot({ health }: { health: Health }) {
  return <span className="os-island-dot" data-health={health} aria-hidden="true" />;
}

export function DynamicIsland() {
  const { t, locale } = useUiPreferences();
  const reduceMotion = useReducedMotion();
  const status = useSystemStatus();
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initialized = useRef(false);
  const lastIssues = useRef("");
  const panelId = useId();
  const active = status.usage?.active[0];
  const totalTokens = status.totals.input + status.totals.output;
  const inputShare = totalTokens > 0 ? Math.round((status.totals.input / totalTokens) * 100) : 0;
  const usageAvailable = Boolean(status.usage);
  const usageMessages: Record<string, [string, string]> = {
    loading: ["正在读取用量…", "Loading usage…"], unauthorized: ["登录已失效，请重新登录", "Session expired. Sign in again."],
    unavailable: ["服务不可达，用量未知", "Service unavailable; usage unknown"], error: ["读取失败，请重试（不是零用量）", "Failed to load. Retry; this is not zero usage."],
    stale: ["刷新失败，下方为上次读取的数据", "Refresh failed; showing previously loaded data"], unknown: ["用量尚未读取", "Usage has not been read"],
  };
  const usageMessage = usageMessages[status.usageState];

  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => { if (!islandRef.current?.contains(document.activeElement)) setOpen(false); }, 210); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    const toggle = () => setOpen(value => !value);
    window.addEventListener(OPEN_STATUS_EVENT, toggle);
    return () => window.removeEventListener(OPEN_STATUS_EVENT, toggle);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".os-status-dots")) return;
      if (!islandRef.current?.contains(target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if ((event.target as HTMLElement | null)?.closest?.("dialog[open]")) return;
      event.preventDefault(); setAlert(null); setOpen(false);
      if (islandRef.current?.contains(document.activeElement)) islandRef.current.querySelector<HTMLButtonElement>(".os-island-pill")?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onEscape); };
  }, [open]);
  useEffect(() => {
    if (status.loading) return;
    const signature = status.issues.map(item => item.id).join("|");
    if (!initialized.current) {
      initialized.current = true;
      lastIssues.current = signature;
      return;
    }
    const previous = lastIssues.current ? lastIssues.current.split("|") : [];
    const added = status.issues.find(item => !previous.includes(item.id));
    lastIssues.current = signature;
    if (!added) return;
    setAlert(`${statusLabel(added, t)} · ${statusBadge(added, t)}`);
  }, [status.issues, status.loading, t]);
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 4_000);
    return () => clearTimeout(timer);
  }, [alert]);

  const state = open ? "expanded" : alert ? "alert" : active ? "active" : "idle";
  const [zhState, enState] = healthLabel[status.overall];
  const summaryText = status.loading
    ? t("检查中", "Checking")
    : status.issues.length
      ? t(`${status.issues.length} 项异常`, `${status.issues.length} issue${status.issues.length > 1 ? "s" : ""}`)
      : t(zhState, enState);
  const serviceRows = status.groups.flatMap(group => group.items);
  const sinceTime = status.usage?.since
    ? new Date(status.usage.since).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

  return <div className="os-island-anchor">
    <div
      ref={islandRef}
      className="os-island"
      data-state={state}
      data-health={status.overall}
      data-reduce-motion={Boolean(reduceMotion)}
      onPointerEnter={event => { if (event.pointerType === "mouse") show(); }}
      onPointerLeave={event => { if (event.pointerType === "mouse") hideSoon(); }}
      onFocus={() => clearTimeout(closeTimer.current)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideSoon(); }}
    >
      <button
        type="button"
        className="os-island-pill"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t(
          `系统状态：${summaryText}，今日 ${usageAvailable ? formatTokens(totalTokens) : "—"} tokens`,
          `System status: ${summaryText}, ${usageAvailable ? formatTokens(totalTokens) : "—"} tokens today`,
        )}
        onClick={() => { clearTimeout(closeTimer.current); setOpen(true); }}
      >
        <Dot health={alert ? "down" : active ? "ok" : status.overall} />
        {state === "alert" ? (
          <span className="os-island-text">{alert}</span>
        ) : state === "active" && active ? (
          <>
            <span className="os-island-text">{active.label}</span>
            <span className="os-island-wave" aria-hidden="true"><i /><i /><i /><i /></span>
          </>
        ) : (
          <>
            <span className="os-island-text">{open && active ? `${t("运行中", "Running")} · ${active.label}` : summaryText}</span>
            <span className="os-island-trailing">
              <span className="os-island-chip">{usageAvailable ? formatTokens(totalTokens) : "—"}<small>tok</small></span>
              <ChevronDown size={12} className="os-island-chevron" aria-hidden="true" />
            </span>
          </>
        )}
      </button>

      <div id={panelId} className="os-island-panel" role="region" aria-label={t("系统状态与模型用量", "System status and model usage")} inert={!open}>
        <div className="os-island-panel-inner">
          <section className="os-island-section" aria-label={t("服务与引擎", "Services and engines")}>
            <header className="os-island-section-head">
              <h3>{t("服务与引擎", "Services & Engines")}</h3>
              <span>{status.issues.length ? t(`${status.issues.length} 项需关注`, `${status.issues.length} warning`) : status.overall === "ok" ? t("链路就绪", "Ready") : t("部分状态未知", "Some status unknown")}</span>
            </header>
            <ul className="os-island-surface os-island-list">
              {serviceRows.length ? serviceRows.map(item => (
                <li key={item.id} className="os-island-row">
                  <Dot health={item.health} />
                  <span className="os-island-name">{statusLabel(item, t)}</span>
                  {item.meta && <span className="os-island-sub">{t(item.meta, item.meta === "自动" ? "Auto" : item.meta.replace(" 次", " calls"))}</span>}
                  <span className="os-island-badge" data-health={item.health}>{statusBadge(item, t)}</span>
                </li>
              )) : (
                <li className="os-island-row">
                  <Dot health="unknown" />
                  <span className="os-island-name">{t("正在读取服务状态", "Checking services")}</span>
                </li>
              )}
            </ul>
          </section>

          <section className="os-island-section" aria-label={t("今日模型用量", "Today's model usage")}>
            <header className="os-island-section-head">
              <h3>{t("今日已上报 Token", "Reported tokens today")}</h3>
              <span>{sinceTime ? t(`${sinceTime} 起`, `Since ${sinceTime}`) : `${status.totals.calls} ${t("次调用", "calls")}`}</span>
            </header>
            <div className="os-island-surface os-island-usage-card">
              {status.usage?.receivedAt && <p className="os-island-empty">{t("最近读取：", "Last read: ")}{new Date(status.usage.receivedAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US")}</p>}
              {usageMessage && <p role="status">{t(...usageMessage)} <button type="button" disabled={status.refreshing} onClick={() => void status.retry()}>{t("重试", "Retry")}</button></p>}
              <p className="os-island-empty">{t("仅包含服务已上报的 token，未计量调用不包含在总数中；重启服务后重新计量。", "Only reported tokens are included; unmetered calls are excluded. Counters restart with the service.")}</p>
              <div className="os-island-meter-summary">
                <div className="os-island-meter-total">
                  <strong>{usageAvailable ? formatTokens(totalTokens) : "—"}</strong>
                  <span>tokens</span>
                </div>
                <div className="os-island-meter-legend" hidden={!usageAvailable}>
                  <span data-tone="in"><i />{t("输入", "In")} {formatTokens(status.totals.input)}</span>
                  <span data-tone="out"><i />{t("输出", "Out")} {formatTokens(status.totals.output)}</span>
                  <span>{status.totals.calls} {t("次", "calls")}</span>
                </div>
              </div>
              <div className="os-island-ratio" aria-hidden="true">
                {totalTokens > 0 && (
                  <>
                    <span className="os-island-ratio-in" style={{ width: `${inputShare}%` }} />
                    <span className="os-island-ratio-out" style={{ width: `${100 - inputShare}%` }} />
                  </>
                )}
              </div>
              {status.usage?.models.length ? (
                <ul className="os-island-models">
                  {status.usage.models.map(model => {
                    const modelTotal = model.inputTokens + model.outputTokens;
                    const share = model.metered && totalTokens > 0 ? (modelTotal / totalTokens) * 100 : 0;
                    const kind = model.kind ? kindLabel[model.kind] : undefined;
                    return (
                      <li key={model.label} className="os-island-model">
                        <div className="os-island-model-top">
                          <div className="os-island-model-title">
                            <strong title={model.label}>{model.label}</strong>
                            {kind && <span className="os-island-kind">{t(kind[0], kind[1])}</span>}
                            {model.failures > 0 && <span className="os-island-badge" data-health="down">{model.failures} {t("失败", "err")}</span>}
                          </div>
                          <div className="os-island-model-nums">
                            {model.metered ? (
                              <>
                                <span>{formatTokens(model.inputTokens)} / {formatTokens(model.outputTokens)}</span>
                                <strong>{formatTokens(modelTotal)}</strong>
                              </>
                            ) : (
                              <span className="os-island-unmetered">{t("未上报 token", "Unmetered")}</span>
                            )}
                            <small>{model.calls}{t("次", "×")}</small>
                          </div>
                        </div>
                        {share > 0 && (
                          <div className="os-island-model-bar" aria-hidden="true">
                            <span style={{ width: `${share}%` }} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="os-island-empty">
                  {status.usage ? t("今日暂无模型调用记录", "No model calls recorded today") : t("尚无可显示的用量数据", "No usage data available")}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>;
}

export function StatusDots() {
  const { t } = useUiPreferences();
  const status = useSystemStatus();
  const summary = status.groups.map(group => {
    const [zh, en] = healthLabel[groupHealth(group.items.map(item => item.health))];
    return `${t(group.label, { proxy: "Proxy", engines: "Engines", models: "Models" }[group.id])}: ${t(zh, en)}`;
  }).join(" · ");
  return <button
    type="button"
    className="os-status-dots"
    aria-label={t(`服务状态：${summary}`, `Service status: ${summary}`)}
    title={summary}
    onClick={() => window.dispatchEvent(new window.Event(OPEN_STATUS_EVENT))}
  >
    {status.groups.map(group => <Dot key={group.id} health={groupHealth(group.items.map(item => item.health))} />)}
  </button>;
}

function groupHealth(values: Health[]): Health {
  if (values.includes("down")) return "down";
  if (values.includes("warn")) return "warn";
  if (!values.length || values.includes("unknown")) return "unknown";
  if (values.includes("ok")) return "ok";
  return "unknown";
}
