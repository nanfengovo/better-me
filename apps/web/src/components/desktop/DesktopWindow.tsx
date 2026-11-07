import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import "./window-resize.css";

const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = typeof edges[number];
const edgeNames = { n: "上边缘", s: "下边缘", e: "右边缘", w: "左边缘", ne: "右上角", nw: "左上角", se: "右下角", sw: "左下角" };


type WindowLayout = { maximized: boolean; position: { x: number; y: number }; size: { width: number; height: number } | null };
const defaultLayout: WindowLayout = { maximized: false, position: { x: 0, y: 0 }, size: null };

export function DesktopWindow({ title, children, hidden = false, inactive = false, settings = false, onHide, actions, layoutKey = "window" }: {
  title: string; children: ReactNode; hidden?: boolean; inactive?: boolean; settings?: boolean; onHide: () => void; actions?: ReactNode; layoutKey?: string;
}) {
  const { t } = useUiPreferences();
  const [layouts, setLayouts] = useState<Record<string, WindowLayout>>({});
  const { maximized, position, size } = layouts[layoutKey] ?? defaultLayout;
  function updateLayout<K extends keyof WindowLayout>(key: K, value: WindowLayout[K]) {
    setLayouts(previous => ({ ...previous, [layoutKey]: { ...(previous[layoutKey] ?? defaultLayout), [key]: value } }));
  }
  function setPosition(value: WindowLayout["position"]) { updateLayout("position", value); }
  function setSize(value: WindowLayout["size"]) { updateLayout("size", value); }
  const [dragging, setDragging] = useState(false);
  const interactiveTarget = "button, a, input, select, textarea, [role=button], [contenteditable=true]";
  const [resizing, setResizing] = useState(false);
  const resize = useRef<{ edge: Edge; pointerId: number; x: number; y: number; rect: DOMRect; position: { x: number; y: number } } | null>(null);
  function endDrag() { drag.current = null; resize.current = null; setDragging(false); setResizing(false); }
  function applyResize(edge: Edge, dx: number, dy: number, rect: DOMRect, origin: { x: number; y: number }) {
    const rightLimit = window.innerWidth - 8;
    const bottomLimit = Math.max(298, window.innerHeight - 92);
    const minWidth = Math.min(420, rightLimit - 8);
    const minHeight = Math.min(300, bottomLimit - 38);
    let { left, right, top, bottom } = rect;
    if (edge.includes("w")) left = Math.max(8, Math.min(right - minWidth, left + dx));
    if (edge.includes("e")) right = Math.min(rightLimit, Math.max(left + minWidth, right + dx));
    if (edge.includes("n")) top = Math.max(38, Math.min(bottom - minHeight, top + dy));
    if (edge.includes("s")) bottom = Math.min(bottomLimit, Math.max(top + minHeight, bottom + dy));
    setSize({ width: right - left, height: bottom - top });
    setPosition({ x: origin.x + left - rect.left, y: origin.y + top - rect.top });
  }
  function startResize(event: PointerEvent<HTMLButtonElement>, edge: Edge) {
    if (event.button !== 0 || maximized) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    endDrag();
    resize.current = { edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: node.current!.getBoundingClientRect(), position };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const r = resize.current;
    if (r && r.pointerId === event.pointerId) applyResize(r.edge, event.clientX - r.x, event.clientY - r.y, r.rect, r.position);
  }
  const node = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  useEffect(() => {
    const reset = () => {
      endDrag(); setLayouts({});
    };
    window.addEventListener("resize", reset);
    window.addEventListener("blur", endDrag);
    return () => { window.removeEventListener("resize", reset); window.removeEventListener("blur", endDrag); };
  }, []);
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || maximized || (event.target as HTMLElement).closest(interactiveTarget)) return;
    event.preventDefault();
    setDragging(true);
    const rect = node.current!.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y, minX: position.x - rect.left + 8, maxX: position.x + window.innerWidth - rect.right - 8, minY: position.y - rect.top + 38, maxY: position.y + window.innerHeight - rect.bottom - 12 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (d) setPosition({ x: Math.max(d.minX, Math.min(d.maxX, d.left + event.clientX - d.x)), y: Math.max(d.minY, Math.min(d.maxY, d.top + event.clientY - d.y)) });
  }
  function toggleMaximized() {
    endDrag(); updateLayout("maximized", !maximized);
  }
  return <section ref={node} className={`os-window ${settings ? "os-settings-window" : "os-business-window"}${maximized ? " is-maximized" : ""}`} aria-label={title} data-inactive={inactive} data-dragging={dragging} data-resizing={resizing} data-sized={Boolean(size)} data-hidden={hidden} inert={hidden || inactive} style={{ "--window-x": `${position.x}px`, "--window-y": `${position.y}px`, "--window-width": size ? `${size.width}px` : undefined, "--window-height": size ? `${size.height}px` : undefined } as CSSProperties}>
    <header className="os-window-toolbar no-print" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={event => { if (!(event.target as HTMLElement).closest(interactiveTarget)) toggleMaximized(); }}>
      <div className="os-traffic" aria-label={t("窗口操作", "Window controls")}>
        <button type="button" aria-label={t(`关闭${title}窗口`, `Close ${title} window`)} title={t("关闭视图，保留草稿与任务", "Close view, keep drafts and tasks")} onClick={onHide}><X size={10} /></button>
        <button type="button" aria-label={t(`最小化${title}`, `Minimize ${title}`)} onClick={onHide}><Minus size={10} /></button>
        <button type="button" aria-label={t(maximized ? "还原窗口大小" : "最大化窗口", maximized ? "Restore window size" : "Maximize window")} aria-pressed={maximized} onClick={toggleMaximized}>{maximized ? <Minimize2 size={9} /> : <Maximize2 size={9} />}</button>
      </div>
      <strong>{title}</strong><div className="os-window-actions">{actions}</div>
    </header>
    <div className="os-window-content">{children}</div>
    {!maximized && edges.map(edge => <button key={edge} type="button" className={`os-resize-handle os-resize-${edge} no-print`} aria-label={t(`拖动${edgeNames[edge]}调整窗口大小`, `Resize window from ${edge}`)} title={t("拖动缩放；聚焦后用方向键微调，Shift 加速", "Drag to resize; use arrow keys, Shift for larger steps")} onPointerDown={event => startResize(event, edge)} onPointerMove={moveResize} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      applyResize(edge, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, node.current!.getBoundingClientRect(), position);
    }} />)}
  </section>;
}
