import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { useSystemStatus } from "../../lib/use-system-status";
import { formatTokens, type Health, type ModelUsage } from "../../services/system-status-client";
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

function Dot({ health }: { health: Health }) {
  return <span className="os-island-dot" data-health={health} aria-hidden="true" />;
}

export function DynamicIsland() {
  const { t, locale, reduceMotion } = useUiPreferences();
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
  const maxModelTokens = Math.max(1, ...(status.usage?.models ?? []).map(m => m.inputTokens + m.outputTokens));

  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 210); };

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
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
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
    setAlert(`${added.label} · ${added.badge ?? added.detail}`);
    const timer = setTimeout(() => setAlert(null), 4_000);
    return () => clearTimeout(timer);
  }, [status.issues, status.loading]);

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
      onFocus={show}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideSoon(); }}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setAlert(null); setOpen(false); } }}
    >
      <button
        type="button"
        className="os-island-pill"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t(
          `系统状态：${summaryText}，今日 ${formatTokens(totalTokens)} tokens`,
          `System status: ${summaryText}, ${formatTokens(totalTokens)} tokens today`,
        )}
        onClick={() => setOpen(value => !value)}
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
              <span className="os-island-chip">{formatTokens(totalTokens)}<small>tok</small></span>
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
              <span>{status.issues.length ? t(`${status.issues.length} 项需关注`, `${status.issues.length} warning`) : t("链路就绪", "Ready")}</span>
            </header>
            <ul className="os-island-surface os-island-list">
              {serviceRows.length ? serviceRows.map(item => (
                <li key={item.id} className="os-island-row">
                  <Dot health={item.health} />
                  <span className="os-island-name">{item.label}</span>
                  {item.meta && <span className="os-island-sub">{item.meta}</span>}
                  <span className="os-island-badge" data-health={item.health}>{item.badge ?? item.detail}</span>
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
              <h3>{t("今日 Token 消耗", "Today's Tokens")}</h3>
              <span>{sinceTime ? t(`${sinceTime} 起`, `Since ${sinceTime}`) : `${status.totals.calls} ${t("次调用", "calls")}`}</span>
            </header>
            <div className="os-island-surface os-island-usage-card">
              <div className="os-island-meter-summary">
                <div className="os-island-meter-total">
                  <strong>{formatTokens(totalTokens)}</strong>
                  <span>tokens</span>
                </div>
                <div className="os-island-meter-legend">
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
                    const share = model.metered && modelTotal > 0 ? Math.max(6, Math.round((modelTotal / maxModelTokens) * 100)) : 0;
                    const kind = model.kind ? kindLabel[model.kind] : undefined;
                    return (
                      <li key={model.label} className="os-island-model">
                        <div className="os-island-model-top">
                          <div className="os-island-model-title">
                            <strong>{model.label}</strong>
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
                  {status.usage ? t("今日暂无模型调用记录", "No model calls recorded today") : t("登录后显示各模型消耗明细", "Sign in to view per-model token usage")}
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
    return `${group.label}：${t(zh, en)}`;
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
  if (values.includes("ok")) return "ok";
  return "unknown";
}
