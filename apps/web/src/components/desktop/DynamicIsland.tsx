import { useEffect, useId, useRef, useState } from "react";
import { useSystemStatus } from "../../lib/use-system-status";
import { formatTokens, type Health } from "../../services/system-status-client";
import "./dynamic-island.css";

export const OPEN_STATUS_EVENT = "betterme:open-system-status";
const healthText: Record<Health, string> = { ok: "正常", warn: "部分异常", down: "离线", unknown: "未知" };

function Dot({ health }: { health: Health }) {
  return <span className="os-island-dot" data-health={health} aria-hidden="true" />;
}

export function DynamicIsland() {
  const status = useSystemStatus();
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastIssues = useRef("");
  const panelId = useId();
  const active = status.usage?.active[0];
  const totalTokens = status.totals.input + status.totals.output;

  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 220); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    const openFromDots = () => setOpen(value => !value);
    window.addEventListener(OPEN_STATUS_EVENT, openFromDots);
    return () => window.removeEventListener(OPEN_STATUS_EVENT, openFromDots);
  }, []);
  useEffect(() => {
    const signature = status.issues.map(item => item.id).join("|");
    const added = status.issues.find(item => !lastIssues.current.split("|").includes(item.id));
    lastIssues.current = signature;
    if (!added) return;
    setAlert(`${added.label} ${added.detail}`);
    const timer = setTimeout(() => setAlert(null), 4_000);
    return () => clearTimeout(timer);
  }, [status.issues]);

  const state = open ? "expanded" : alert ? "alert" : active ? "active" : "idle";

  return <div className="os-island-anchor">
    <div className="os-island" data-state={state} data-health={status.overall}
      onPointerEnter={event => { if (event.pointerType === "mouse") show(); }}
      onPointerLeave={event => { if (event.pointerType === "mouse") hideSoon(); }}
      onFocus={show}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideSoon(); }}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
      <button type="button" className="os-island-pill" aria-expanded={open} aria-controls={panelId}
        aria-label={`系统状态：${healthText[status.overall]}，今日 ${formatTokens(totalTokens)} tokens`}
        onClick={() => setOpen(value => !value)}>
        <Dot health={alert ? "down" : status.overall} />
        {state === "alert" ? <span className="os-island-text">{alert}</span>
          : state === "active" && active ? <><span className="os-island-text">{active.label}</span><span className="os-island-wave" aria-hidden="true"><i /><i /><i /></span></>
          : <><span className="os-island-text">{status.loading ? "检查中" : status.issues.length ? `${status.issues.length} 项异常` : healthText[status.overall]}</span>
            <span className="os-island-meta">{formatTokens(totalTokens)} tok</span></>}
      </button>
      <div id={panelId} className="os-island-panel" role="region" aria-label="系统状态与模型用量" inert={!open}>
        <div className="os-island-panel-inner">
          <section aria-label="服务状态">
            {status.groups.map(group => <div key={group.id} className="os-island-group">
              <h3>{group.label}</h3>
              <ul>{group.items.length ? group.items.map(item => <li key={item.id}>
                <Dot health={item.health} /><span className="os-island-name">{item.label}</span><span className="os-island-detail">{item.detail}</span>
              </li>) : <li><Dot health="unknown" /><span className="os-island-name">检查中</span></li>}</ul>
            </div>)}
          </section>
          <section aria-label="今日模型用量" className="os-island-usage">
            <h3>今日用量<span>{formatTokens(status.totals.input)} 入 · {formatTokens(status.totals.output)} 出 · {status.totals.calls} 次</span></h3>
            {status.usage?.models.length ? <table>
              <thead><tr><th scope="col">模型</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col">调用</th></tr></thead>
              <tbody>{status.usage.models.map(model => <tr key={model.label}>
                <th scope="row">{model.label}</th>
                {model.metered ? <><td>{formatTokens(model.inputTokens)}</td><td>{formatTokens(model.outputTokens)}</td></>
                  : <td colSpan={2} className="os-island-unmetered">未上报 token</td>}
                <td>{model.calls}</td>
              </tr>)}</tbody>
            </table> : <p className="os-island-empty">{status.usage ? "今日还没有模型调用" : "登录后显示用量"}</p>}
            {status.usage && <p className="os-island-foot">自 {new Date(status.usage.since).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 起统计 · 服务重启后重新计算</p>}
          </section>
        </div>
      </div>
    </div>
  </div>;
}

export function StatusDots() {
  const status = useSystemStatus();
  const summary = status.groups.map(group => `${group.label}${healthText[groupHealth(group.items.map(item => item.health))]}`).join("，");
  return <button type="button" className="os-status-dots" aria-label={`服务状态：${summary}`} title={summary}
    onClick={() => window.dispatchEvent(new Event(OPEN_STATUS_EVENT))}>
    {status.groups.map(group => <Dot key={group.id} health={groupHealth(group.items.map(item => item.health))} />)}
  </button>;
}

function groupHealth(values: Health[]): Health {
  if (values.includes("down")) return "down";
  if (values.includes("warn")) return "warn";
  if (values.includes("ok")) return "ok";
  return "unknown";
}
