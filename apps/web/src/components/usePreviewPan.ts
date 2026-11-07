import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";

export function usePreviewPan(canvasRef: RefObject<HTMLDivElement | null>, onManual: () => void) {
  const [handMode, setHandMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const spaceRef = useRef(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const suppressClick = useRef(false);

  function endDrag() {
    const pointer = drag.current;
    drag.current = null;
    if (pointer && canvasRef.current?.hasPointerCapture?.(pointer.pointerId)) canvasRef.current.releasePointerCapture(pointer.pointerId);
    setDragging(false);
  }

  useEffect(() => {
    const reset = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
      const pointer = drag.current;
      drag.current = null;
      if (pointer && canvasRef.current?.hasPointerCapture?.(pointer.pointerId)) canvasRef.current.releasePointerCapture(pointer.pointerId);
      setDragging(false);
    };
    const keydown = (event: KeyboardEvent) => {
      const canvas = canvasRef.current;
      const target = event.target as HTMLElement | null;
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || target?.closest('input,textarea,select,button,a,[contenteditable="true"],[role="textbox"]')) return;
      if (event.code === "Space" && canvas && (canvas.contains(document.activeElement) || canvas.matches(":hover"))) {
        event.preventDefault();
        spaceRef.current = true;
        setSpaceHeld(true);
      }
      if (event.key === "Escape") reset();
    };
    const keyup = (event: KeyboardEvent) => { if (event.code === "Space") { spaceRef.current = false; setSpaceHeld(false); } };
    const visibility = () => { if (document.hidden) reset(); };
    document.addEventListener("keydown", keydown);
    document.addEventListener("keyup", keyup);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("keyup", keyup);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", reset);
    };
  }, [canvasRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (drag.current || (!handMode && !spaceRef.current && event.button !== 1) || ![0, 1].includes(event.button)) return;
    const canvas = event.currentTarget;
    // Leave the native scrollbar draggable even in hand mode.
    const rect = canvas.getBoundingClientRect();
    if (event.clientX - rect.left >= canvas.clientWidth + canvas.clientLeft || event.clientY - rect.top >= canvas.clientHeight + canvas.clientTop) return;
    event.preventDefault();
    onManual();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    suppressClick.current = true;
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
    event.currentTarget.scrollTop = start.top + start.y - event.clientY;
  };
  return {
    handMode, setHandMode, active: handMode || spaceHeld, dragging,
    handlers: {
      onPointerDown, onPointerMove,
      onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
      onAuxClickCapture: (event: React.MouseEvent<HTMLDivElement>) => { if (event.button === 1 && suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } },
      onDragStart: (event: React.DragEvent<HTMLDivElement>) => { if (drag.current || handMode || spaceRef.current) event.preventDefault(); },
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } },
    },
  };
}
