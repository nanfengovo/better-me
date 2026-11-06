import { useUiPreferences } from "../lib/ui-preferences";
import { cloneElement, useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { GripVertical } from "lucide-react";
import { clampWorkspaceSplit, DEFAULT_EDITOR_PERCENT, getWorkspaceSplitBounds, parseWorkspaceSplit, SPLIT_HANDLE_WIDTH, WORKSPACE_SPLIT_KEY, workspaceSplitFromPointer } from "../lib/workspace-split";
import "./writing-workspace.css";
import { SHOW_RESUME_EDITOR_EVENT } from "../lib/agent-navigation";

type Props = { children: [ReactElement<HTMLAttributes<HTMLElement>>, ReactElement<HTMLAttributes<HTMLElement>>] };

export function ResizableWorkspace({ children: [editor, preview] }: Props) {
  const { t } = useUiPreferences();

  const containerRef = useRef<HTMLElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const [preferredPercent, setPreferredPercent] = useState(() => {
    try { return parseWorkspaceSplit(localStorage.getItem(WORKSPACE_SPLIT_KEY)); }
    catch { return DEFAULT_EDITOR_PERCENT; }
  });
  const [availableWidth, setAvailableWidth] = useState(1000);
  const [compactViewport, setCompactViewport] = useState(() => window.innerWidth <= 940);
  const [view, setView] = useState<"editor" | "preview">("editor");
  const viewId = useId();
  // Minimum usable content widths, excluding the splitter: editor 360 + preview 420.
  const split = availableWidth >= 780 && !compactViewport;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; percent: number } | null>(null);
  const percent = clampWorkspaceSplit(preferredPercent, availableWidth);
  const bounds = getWorkspaceSplitBounds(availableWidth);

  function remember(next: number) {
    try { localStorage.setItem(WORKSPACE_SPLIT_KEY, String(next)); }
    catch { /* A layout preference must not interfere with saving the resume. */ }
  }

  useEffect(() => {
    const reveal = () => setView("editor");
    window.addEventListener(SHOW_RESUME_EDITOR_EVENT, reveal);
    return () => window.removeEventListener(SHOW_RESUME_EDITOR_EVENT, reveal);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setCompactViewport(window.innerWidth <= 940);
      const styles = getComputedStyle(container);
      setAvailableWidth(Math.max(1, container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - SPLIT_HANDLE_WIDTH));
      if (container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) < 800 && dragRef.current) {
        const { pointerId, percent: current } = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        remember(current);
        if (separatorRef.current?.hasPointerCapture(pointerId)) separatorRef.current.releasePointerCapture(pointerId);
      }
    };
    let frame: number | null = null;
    // Layout writes must run outside the ResizeObserver delivery cycle.
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; measure(); });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      observer.disconnect(); window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  function pointerPercent(event: PointerEvent<HTMLDivElement>) {
    const container = containerRef.current!;
    const styles = getComputedStyle(container);
    const contentLeft = container.getBoundingClientRect().left + parseFloat(styles.paddingLeft);
    const width = container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - SPLIT_HANDLE_WIDTH;
    return workspaceSplitFromPointer(event.clientX, contentLeft, width);
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !split) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, percent };
    setDragging(true);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const next = pointerPercent(event);
    dragRef.current.percent = next;
    setPreferredPercent(next);
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const next = dragRef.current.percent;
    dragRef.current = null;
    setDragging(false);
    remember(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function reset() {
    setPreferredPercent(DEFAULT_EDITOR_PERCENT);
    remember(DEFAULT_EDITOR_PERCENT);
  }
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") next = percent - step;
    else if (event.key === "ArrowRight") next = percent + step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    else if (event.key === "Enter") { event.preventDefault(); reset(); return; }
    else return;
    event.preventDefault();
    next = clampWorkspaceSplit(next, availableWidth);
    setPreferredPercent(next);
    remember(next);
  }

  return <main ref={containerRef} className={`studio-main${dragging ? " is-resizing" : ""}`} data-workspace-layout={split ? "split" : "single"} style={{ "--studio-editor-share": `${percent}fr`, "--studio-preview-share": `${100 - percent}fr` } as CSSProperties}>
    <div className="workspace-view-tabs no-print" role="tablist" aria-label={t("简历工作视图", "Resume workspace view")} hidden={split} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "editor" : event.key === "End" ? "preview" : view === "editor" ? "preview" : "editor";
      setView(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
    }}>{(["editor", "preview"] as const).map(item => <button key={item} id={`${viewId}-${item}`} data-view={item} type="button" role="tab" aria-selected={view === item} aria-controls={`resume-${item}-panel`} tabIndex={view === item ? 0 : -1} onClick={() => setView(item)}>{item === "editor" ? t("编辑简历", "Edit resume") : t("预览简历", "Preview resume")}</button>)}</div>
    {cloneElement(editor, { hidden: !split && view !== "editor", role: split ? editor.props.role : "tabpanel", "aria-labelledby": split ? editor.props["aria-labelledby"] : `${viewId}-editor` })}
    <div ref={separatorRef} hidden={!split} className="studio-splitter no-print" role="separator" tabIndex={split ? 0 : -1} aria-label={t("调整编辑区与预览区宽度", "Resize editor and preview")} aria-orientation="vertical" aria-controls="resume-editor-panel resume-preview-panel" aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(percent)} aria-valuetext={t(`编辑区 ${Math.round(percent)}%，预览区 ${Math.round(100 - percent)}%`, `Editor ${Math.round(percent)}%, preview ${Math.round(100 - percent)}%`)} title={t("左右拖动调整宽度；双击恢复默认。方向键微调，Enter 重置。", "Drag left or right to resize; double-click to reset. Use arrow keys for small adjustments and Enter to reset.")} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={reset} onKeyDown={handleKey}>
      <span className="studio-splitter-line"><GripVertical size={14} aria-hidden="true" /></span>
      <span className="studio-splitter-value" aria-hidden="true">{Math.round(percent)} / {Math.round(100 - percent)}</span>
    </div>
    {cloneElement(preview, { hidden: !split && view !== "preview", role: split ? preview.props.role : "tabpanel", "aria-labelledby": split ? preview.props["aria-labelledby"] : `${viewId}-preview` })}
  </main>;
}
