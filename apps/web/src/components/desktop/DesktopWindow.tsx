import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Minus, Plus, X } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";

export function DesktopWindow({ title, children, hidden = false, inactive = false, settings = false, onHide, actions }: {
  title: string; children: ReactNode; hidden?: boolean; inactive?: boolean; settings?: boolean; onHide: () => void; actions?: ReactNode;
}) {
  const { t } = useUiPreferences();
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const node = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  useEffect(() => {
    const reset = () => { drag.current = null; setPosition({ x: 0, y: 0 }); };
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || maximized || window.matchMedia("(max-width: 940px)").matches || (event.target as HTMLElement).closest("button, a, input, select")) return;
    const rect = node.current!.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y, minX: position.x - rect.left + 8, maxX: position.x + window.innerWidth - rect.right - 8, minY: position.y - rect.top + 38, maxY: position.y + window.innerHeight - rect.bottom - 12 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (d) setPosition({ x: Math.max(d.minX, Math.min(d.maxX, d.left + event.clientX - d.x)), y: Math.max(d.minY, Math.min(d.maxY, d.top + event.clientY - d.y)) });
  }
  function toggleMaximized() {
    if (window.matchMedia("(max-width: 940px)").matches) return;
    setPosition({ x: 0, y: 0 }); setMaximized(value => !value);
  }
  return <section ref={node} className={`os-window ${settings ? "os-settings-window" : "os-business-window"}${maximized ? " is-maximized" : ""}`} aria-label={title} data-hidden={hidden} inert={hidden || inactive} style={{ "--window-x": `${position.x}px`, "--window-y": `${position.y}px` } as CSSProperties}>
    <header className="os-window-toolbar no-print" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button")) toggleMaximized(); }}>
      <div className="os-traffic" aria-label={t("窗口操作", "Window controls")}>
        <button type="button" aria-label={t(`关闭${title}窗口`, `Close ${title} window`)} title={t("关闭视图，保留草稿与任务", "Close view, keep drafts and tasks")} onClick={onHide}><X size={10} /></button>
        <button type="button" aria-label={t(`最小化${title}`, `Minimize ${title}`)} onClick={onHide}><Minus size={10} /></button>
        <button type="button" aria-label={t(maximized ? "还原窗口大小" : "最大化窗口", maximized ? "Restore window size" : "Maximize window")} aria-pressed={maximized} onClick={toggleMaximized}><Plus size={10} /></button>
      </div>
      <strong>{title}</strong><div className="os-window-actions">{actions}</div>
    </header>
    <div className="os-window-content">{children}</div>
  </section>;
}
