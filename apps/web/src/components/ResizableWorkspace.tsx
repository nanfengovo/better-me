import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { clampWorkspaceSplit, DEFAULT_EDITOR_PERCENT, getWorkspaceSplitBounds, parseWorkspaceSplit, SPLIT_HANDLE_WIDTH, WORKSPACE_SPLIT_KEY, workspaceSplitFromPointer } from "../lib/workspace-split";

type Props = { children: [ReactNode, ReactNode] };

export function ResizableWorkspace({ children: [editor, preview] }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const [preferredPercent, setPreferredPercent] = useState(() => {
    try { return parseWorkspaceSplit(localStorage.getItem(WORKSPACE_SPLIT_KEY)); }
    catch { return DEFAULT_EDITOR_PERCENT; }
  });
  const [availableWidth, setAvailableWidth] = useState(1000);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; percent: number } | null>(null);
  const percent = clampWorkspaceSplit(preferredPercent, availableWidth);
  const bounds = getWorkspaceSplitBounds(availableWidth);

  function remember(next: number) {
    try { localStorage.setItem(WORKSPACE_SPLIT_KEY, String(next)); }
    catch { /* A layout preference must not interfere with saving the resume. */ }
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const styles = getComputedStyle(container);
      setAvailableWidth(Math.max(1, container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - SPLIT_HANDLE_WIDTH));
      if (!window.matchMedia("(min-width: 941px)").matches && dragRef.current) {
        const { pointerId, percent: current } = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        remember(current);
        if (separatorRef.current?.hasPointerCapture(pointerId)) separatorRef.current.releasePointerCapture(pointerId);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, []);

  function pointerPercent(event: PointerEvent<HTMLDivElement>) {
    const container = containerRef.current!;
    const styles = getComputedStyle(container);
    const contentLeft = container.getBoundingClientRect().left + parseFloat(styles.paddingLeft);
    const width = container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - SPLIT_HANDLE_WIDTH;
    return workspaceSplitFromPointer(event.clientX, contentLeft, width);
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !window.matchMedia("(min-width: 941px)").matches) return;
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

  return <main ref={containerRef} className={`studio-main${dragging ? " is-resizing" : ""}`} style={{ "--studio-editor-share": `${percent}fr`, "--studio-preview-share": `${100 - percent}fr` } as CSSProperties}>
    {editor}
    <div ref={separatorRef} className="studio-splitter no-print" role="separator" tabIndex={0} aria-label="调整编辑区与预览区宽度" aria-orientation="vertical" aria-controls="resume-editor-panel resume-preview-panel" aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(percent)} aria-valuetext={`编辑区 ${Math.round(percent)}%，预览区 ${Math.round(100 - percent)}%`} title="左右拖动调整宽度；双击恢复默认。方向键微调，Enter 重置。" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onDoubleClick={reset} onKeyDown={handleKey}>
      <span className="studio-splitter-line"><GripVertical size={14} aria-hidden="true" /></span>
      <span className="studio-splitter-value" aria-hidden="true">{Math.round(percent)} / {Math.round(100 - percent)}</span>
    </div>
    {preview}
  </main>;
}
